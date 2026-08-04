using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
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
        services.AddScoped<DataModelService>();
        services.AddScoped<DashboardService>();

        mvc.AddApplicationPart(typeof(AddReconDashboardsExtensions).Assembly);

        services.Configure<MvcOptions>(mvcOptions =>
        {
            mvcOptions.Conventions.Add(new RcdRoutePrefixConvention(options.RoutePrefix));
            mvcOptions.Conventions.Add(new RcdAuthorizeConvention(options));
        });

        return mvc;
    }
}
