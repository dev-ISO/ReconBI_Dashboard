using System.Net.Http.Headers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Schema;
using ReconDashboards.DemoHost.Demo;
using ReconDashboards.Postgres;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// Boots the real demo host (JWT auth, policies, route prefix, controllers,
/// services) while swapping the two external dependencies:
///  - storage: SQLite on a single open in-memory connection instead of Npgsql;
///  - the "demo" data source: fixed in-memory schema + PostgresSqlDialect +
///    a recording fake executor instead of a live Postgres database.
/// The demo host's IRowFilterContributor is replaced with a switchable fake.
/// </summary>
public sealed class DemoApiFactory : WebApplicationFactory<Program>
{
    /// <summary>Never a real secret — used to prove connection strings never leak to clients.</summary>
    public const string SentinelConnectionString = "Host=secret-host;Username=chart_reader;Password=hunter2";

    private readonly SqliteConnection _connection;

    public DemoApiFactory()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
    }

    public RecordingQueryExecutor Executor { get; } = new();

    public SwitchableRowFilterContributor RowFilters { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");

        builder.ConfigureTestServices(services =>
        {
            // 1) Replace the Npgsql-configured storage with shared in-memory SQLite.
            RemoveAll(services, d =>
                d.ServiceType == typeof(DbContextOptions<ReconDashboardsDbContext>)
                || d.ServiceType == typeof(DbContextOptions)
                || d.ServiceType == typeof(IDbContextOptionsConfiguration<ReconDashboardsDbContext>));
            services.AddDbContext<ReconDashboardsDbContext>(o => o.UseSqlite(_connection));

            // 2) Replace the Postgres-backed "demo" data source with the fixture source.
            RemoveAll(services, d => d.ServiceType == typeof(IDataSourceRegistry));
            var dataSourceOptions = new DataSourceOptions
            {
                ConnectionString = SentinelConnectionString,
                Description = "Fixture demo source",
            };
            services.AddSingleton<IDataSourceRegistry>(new FakeDataSourceRegistry(new RegisteredDataSource(
                "demo",
                "postgres",
                dataSourceOptions,
                new FixedSchemaIntrospector(ApiTestFixtures.BuildDemoSchema()),
                Executor,
                new PostgresSqlDialect())));

            // 3) Replace the demo host's row filter contributor with the switchable fake.
            RemoveAll(services, d => d.ServiceType == typeof(IRowFilterContributor));
            services.AddSingleton<IRowFilterContributor>(RowFilters);
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        var host = base.CreateHost(builder);
        using var scope = host.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>().Database.EnsureCreated();
        return host;
    }

    /// <summary>Client authenticated as one of the canned demo users (alice/bob/carol).</summary>
    public HttpClient AsUser(string username)
    {
        var tokenKey = Services.GetRequiredService<IConfiguration>()["TokenKey"]
            ?? throw new InvalidOperationException("TokenKey is not configured in the test host.");
        var user = DemoTokens.FindUser(username)
            ?? throw new ArgumentException($"Unknown demo user '{username}'.", nameof(username));

        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", DemoTokens.Issue(user, tokenKey).Token);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            _connection.Dispose();
        }
    }

    private static void RemoveAll(IServiceCollection services, Func<ServiceDescriptor, bool> predicate)
    {
        foreach (var descriptor in services.Where(predicate).ToList())
        {
            services.Remove(descriptor);
        }
    }
}

/// <summary>Single-source registry serving the fixture data source under its registered name.</summary>
public sealed class FakeDataSourceRegistry(RegisteredDataSource source) : IDataSourceRegistry
{
    public IReadOnlyList<DataSourceInfo> List() =>
        [new DataSourceInfo(source.Name, source.Options.Description, source.ProviderName)];

    public bool TryGet(string name, out RegisteredDataSource resolved)
    {
        if (string.Equals(name, source.Name, StringComparison.OrdinalIgnoreCase))
        {
            resolved = source;
            return true;
        }

        resolved = null!;
        return false;
    }
}

public sealed class FixedSchemaIntrospector(DatabaseSchema schema) : ISchemaIntrospector
{
    public Task<DatabaseSchema> IntrospectAsync(CancellationToken cancellationToken) => Task.FromResult(schema);
}

/// <summary>Returns canned rows and captures the last compiled query for assertions.</summary>
public sealed class RecordingQueryExecutor : IQueryExecutor
{
    public static readonly IReadOnlyList<object?[]> CannedRows =
    [
        ["West", 10],
        ["East", 20],
    ];

    private int _executionCount;

    public int ExecutionCount => Volatile.Read(ref _executionCount);

    public CompiledQuery? LastQuery { get; private set; }

    public ExecutionOptions? LastOptions { get; private set; }

    public Task<ExecutedQuery> ExecuteAsync(
        CompiledQuery query, ExecutionOptions options, CancellationToken cancellationToken)
    {
        LastQuery = query;
        LastOptions = options;
        Interlocked.Increment(ref _executionCount);
        return Task.FromResult(new ExecutedQuery(CannedRows, Truncated: false, ElapsedMs: 3));
    }
}

/// <summary>Row-filter fake: Allow by default, togglable per test. Reset to Allow after use.</summary>
public sealed class SwitchableRowFilterContributor : IRowFilterContributor
{
    public enum FilterMode
    {
        Allow,
        Deny,
        Throw,
        WestCustomersOnly,
    }

    public FilterMode Mode { get; set; } = FilterMode.Allow;

    public Task<RowFilterDecision> GetFiltersAsync(RowFilterContext context, CancellationToken cancellationToken) =>
        Mode switch
        {
            FilterMode.Deny => Task.FromResult(RowFilterDecision.DenyAccess()),
            FilterMode.Throw => throw new InvalidOperationException("Simulated row-filter contributor failure."),
            FilterMode.WestCustomersOnly when context is { Schema: "public", Table: "customers" } =>
                Task.FromResult(RowFilterDecision.Filter(
                    new RowFilter("region", RowFilterOperator.Equals, new object?[] { "West" }))),
            _ => Task.FromResult(RowFilterDecision.Allow),
        };
}

/// <summary>
/// Local copy of the customers/orders fixture (kept independent of the
/// Core.Tests project on purpose — test projects must not reference each other).
/// </summary>
public static class ApiTestFixtures
{
    public static DatabaseSchema BuildDemoSchema() => new(
        "demo",
        FetchedAtUtc: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
        VersionHash: "fixture-hash",
        Tables: [BuildCustomersTable(), BuildOrdersTable()],
        ForeignKeys: [new ForeignKeySchema("fk_orders_customers", "public.orders", ["customer_id"], "public.customers", ["id"])]);

    private static TableSchema BuildCustomersTable() => new(
        "public", "customers", TableKind.Table, RowEstimate: 100, Comment: null,
        Columns:
        [
            Column("id", 1, "integer", NormalizedType.Integer),
            Column("name", 2, "text", NormalizedType.Text),
            Column("region", 3, "text", NormalizedType.Text, isNullable: true),
            Column("credit_limit", 4, "numeric", NormalizedType.Decimal, isNullable: true),
        ],
        PrimaryKey: ["id"],
        UniqueConstraints: [["name"]]);

    private static TableSchema BuildOrdersTable() => new(
        "public", "orders", TableKind.Table, RowEstimate: 1000, Comment: null,
        Columns:
        [
            Column("id", 1, "integer", NormalizedType.Integer),
            Column("customer_id", 2, "integer", NormalizedType.Integer, isNullable: true),
            Column("order_total", 3, "numeric", NormalizedType.Decimal),
            Column("status", 4, "text", NormalizedType.Text),
            Column("order_date", 5, "date", NormalizedType.Date),
        ],
        PrimaryKey: ["id"],
        UniqueConstraints: []);

    private static ColumnSchema Column(
        string name, int ordinal, string rawType, NormalizedType type, bool isNullable = false) =>
        new(name, ordinal, rawType, type, isNullable, Comment: null);
}
