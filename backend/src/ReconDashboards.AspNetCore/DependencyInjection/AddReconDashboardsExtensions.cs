using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using ReconDashboards.AspNetCore.Controllers;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Rendering;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.DependencyInjection;

public static class AddReconDashboardsExtensions
{
    /// <summary>
    /// Mounts ReconDashboards into a host application. Extension on IMvcBuilder
    /// because it registers this assembly as an MVC application part; hosts
    /// compose it with their existing AddControllers() call:
    ///
    ///   builder.Services.AddControllers().AddReconDashboards(rcd => {
    ///       rcd.ConfigureStorage = o => o.UseNpgsql(conn,
    ///           n => n.MigrationsAssembly("ReconDashboards.Postgres")
    ///                 .MigrationsHistoryTable("__RcdMigrationsHistory"));
    ///       rcd.AddPostgresDataSource("main", ds => { ... });   // Postgres package extension
    ///   });
    ///
    /// The host must also register:
    ///   - ICurrentUserProvider (maps its auth to a stable opaque user id)
    ///   - zero or more IRowFilterContributor (row-level scoping, fail closed)
    /// </summary>
    public static IMvcBuilder AddReconDashboards(this IMvcBuilder mvc, Action<ReconDashboardsOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(configure);

        var options = new ReconDashboardsOptions();
        configure(options);

        if (options.ConfigureStorage is null)
        {
            throw new InvalidOperationException(
                "ReconDashboards: ConfigureStorage must be set (e.g. o => o.UseNpgsql(connectionString)).");
        }

        if (options.DataSources.Count == 0)
        {
            throw new InvalidOperationException(
                "ReconDashboards: register at least one data source (e.g. AddPostgresDataSource from ReconDashboards.Postgres).");
        }

        if (string.IsNullOrWhiteSpace(options.RoutePrefix))
        {
            throw new InvalidOperationException("ReconDashboards: RoutePrefix must be non-empty.");
        }

        var services = mvc.Services;

        services.AddSingleton(options);
        services.AddSingleton(options.Limits);
        services.AddDbContext<ReconDashboardsDbContext>(o => options.ConfigureStorage(o));
        services.AddSingleton<IDataSourceRegistry>(sp => new DataSourceRegistry(options, sp));
        services.AddSingleton<ISchemaCache, MemorySchemaCache>();
        services.AddSingleton<SemanticModelValidator>();
        services.TryAddSingleton(TimeProvider.System);
        // Host-overridable: a later AddScoped/AddSingleton<IUserDirectory> wins.
        services.TryAddSingleton<IUserDirectory, NullUserDirectory>();
        // Same seam pattern for the dispatch notifiers: no-op defaults here,
        // hosts register their SignalR/bell bridges after this call and win.
        services.TryAddSingleton<IRcdDispatchProgressNotifier, NullRcdDispatchProgressNotifier>();
        services.TryAddSingleton<IRcdDeliveryFailureNotifier, NullRcdDeliveryFailureNotifier>();
        // Collaborative-op broadcast seam (COLLAB-DESIGN wave 1): no-op default,
        // the host's SignalR bridge registration wins.
        services.TryAddSingleton<IRcdDashboardOpNotifier, NullRcdDashboardOpNotifier>();
        // Tile-lock visibility seam (wave 2): same doctrine. The lock service
        // resolves it per fire through a DI scope (never captively), so hosts
        // may register their bridge with ANY lifetime.
        services.TryAddSingleton<IRcdDashboardTileLockNotifier, NullRcdDashboardTileLockNotifier>();
        // Soft tile locks are process-local state (single-instance constraint is
        // an accepted design tradeoff) — a plain singleton, not a host seam.
        // (IServiceScopeFactory rides in via the optional ctor parameter and
        // powers the wave-2 lock-change broadcasts.)
        services.AddSingleton<DashboardTileLockService>();
        // The dispatcher lives HERE (not in AddReconDashboardsScheduling):
        // send-now must work on hosts that never enable the background
        // scheduler, and its retry queue/manual guard are process state.
        services.TryAddSingleton<SubscriptionDispatcher>();
        // Chart PNGs for subscription emails (EMAIL-CONTENT-DESIGN). The
        // painter is stateless (typefaces are static+lazy), so a singleton;
        // TryAdd so a host — or a test — can supply its own renderer instead.
        services.TryAddSingleton<IChartImageRenderer, SkiaChartImageRenderer>();
        // The ONE render path behind subscription emails, shared by the
        // dispatcher and both preview endpoints. Scoped like the dispatcher's
        // per-dispatch dependencies: it runs tiles through the query pipeline
        // in the caller's scope.
        services.AddScoped<SnapshotComposer>();
        services.AddScoped<DataModelService>();
        services.AddScoped<DashboardService>();
        services.AddScoped<DashboardOpService>();
        services.AddScoped<ChartQueryService>();
        services.AddScoped<SubscriptionService>();
        services.AddScoped<AlertService>(sp => new AlertService(
            sp.GetRequiredService<ReconDashboardsDbContext>(),
            sp.GetRequiredService<ICurrentUserProvider>(),
            sp.GetRequiredService<DataModelService>(),
            sp,
            sp.GetRequiredService<TimeProvider>(),
            sp.GetRequiredService<IUserDirectory>()));

        // Per-user token bucket for query endpoints. Takes effect when the host
        // pipeline calls UseRateLimiter() (both production hosts already do).
        var queriesPerMinute = Math.Max(1, options.Limits.QueriesPerMinutePerUser);
        services.AddRateLimiter(rateLimiter => rateLimiter.AddPolicy(
            RcdRateLimiting.QueryPolicyName,
            httpContext => RateLimitPartition.GetTokenBucketLimiter(
                httpContext.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
                    ?? httpContext.Connection.RemoteIpAddress?.ToString()
                    ?? "anonymous",
                _ => new TokenBucketRateLimiterOptions
                {
                    TokenLimit = queriesPerMinute,
                    TokensPerPeriod = queriesPerMinute,
                    ReplenishmentPeriod = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                    AutoReplenishment = true,
                })));

        mvc.AddApplicationPart(typeof(AddReconDashboardsExtensions).Assembly);

        services.Configure<MvcOptions>(mvcOptions =>
        {
            mvcOptions.Conventions.Add(new RcdRoutePrefixConvention(options.RoutePrefix));
            mvcOptions.Conventions.Add(new RcdAuthorizeConvention(options));
        });

        return mvc;
    }
}
