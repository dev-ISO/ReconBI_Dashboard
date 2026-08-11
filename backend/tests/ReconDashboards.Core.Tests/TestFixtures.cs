using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

/// <summary>Shared builders for the demo catalog and terse model construction.</summary>
public static class TestFixtures
{
    public const string DemoConnectionName = "demo";

    public static ColumnSchema BuildColumn(string name, int ordinal, NormalizedType type, bool isNullable = false) =>
        new(name, ordinal, RawTypeFor(type), type, isNullable, Comment: null);

    private static string RawTypeFor(NormalizedType type) => type switch
    {
        NormalizedType.Text => "text",
        NormalizedType.Integer => "integer",
        NormalizedType.Decimal => "numeric",
        NormalizedType.Boolean => "boolean",
        NormalizedType.Date => "date",
        NormalizedType.Timestamp => "timestamp",
        NormalizedType.Uuid => "uuid",
        NormalizedType.Json => "jsonb",
        _ => "bytea",
    };

    public static TableSchema BuildCustomersTable() => new(
        "public", "customers", TableKind.Table, RowEstimate: 100, Comment: null,
        Columns:
        [
            BuildColumn("id", 1, NormalizedType.Integer),
            BuildColumn("name", 2, NormalizedType.Text),
            BuildColumn("region", 3, NormalizedType.Text, isNullable: true),
            BuildColumn("credit_limit", 4, NormalizedType.Decimal, isNullable: true),
        ],
        PrimaryKey: ["id"],
        UniqueConstraints: [["name"]]);

    public static TableSchema BuildOrdersTable() => new(
        "public", "orders", TableKind.Table, RowEstimate: 1000, Comment: null,
        Columns:
        [
            BuildColumn("id", 1, NormalizedType.Integer),
            BuildColumn("customer_id", 2, NormalizedType.Integer, isNullable: true),
            BuildColumn("order_total", 3, NormalizedType.Decimal),
            BuildColumn("status", 4, NormalizedType.Text),
            BuildColumn("order_date", 5, NormalizedType.Date),
            BuildColumn("payload", 6, NormalizedType.Json, isNullable: true),
            BuildColumn("blob", 7, NormalizedType.Other, isNullable: true),
        ],
        PrimaryKey: ["id"],
        UniqueConstraints: []);

    public static TableSchema BuildInspectionsTable() => new(
        "public", "inspections", TableKind.Table, RowEstimate: 50, Comment: null,
        Columns:
        [
            BuildColumn("id", 1, NormalizedType.Integer),
            BuildColumn("order_id", 2, NormalizedType.Integer, isNullable: true),
            BuildColumn("result", 3, NormalizedType.Text),
        ],
        PrimaryKey: ["id"],
        UniqueConstraints: []);

    public static TableSchema BuildTable(string schema, string name, params ColumnSchema[] columns) =>
        new(schema, name, TableKind.Table, RowEstimate: null, Comment: null, columns, PrimaryKey: [], UniqueConstraints: []);

    public static ForeignKeySchema BuildOrdersToCustomersForeignKey() =>
        new("fk_orders_customers", "public.orders", ["customer_id"], "public.customers", ["id"]);

    /// <summary>The demo catalog snapshot every validator/service test resolves against.</summary>
    public static DatabaseSchema BuildDemoSchema() => new(
        DemoConnectionName,
        FetchedAtUtc: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
        VersionHash: "fixture-hash",
        Tables: [BuildCustomersTable(), BuildOrdersTable(), BuildInspectionsTable()],
        ForeignKeys: [BuildOrdersToCustomersForeignKey()]);

    /// <summary>Raw (pre-filter) snapshot: the demo tables plus a table outside the allowed schemas.</summary>
    public static DatabaseSchema BuildRawDemoSchemaWithSecretsTable() => BuildDemoSchema() with
    {
        VersionHash = "",
        Tables =
        [
            BuildCustomersTable(),
            BuildOrdersTable(),
            BuildInspectionsTable(),
            BuildTable("audit", "secrets", BuildColumn("id", 1, NormalizedType.Integer)),
        ],
    };

    public static ModelDefinition BuildModel(
        IReadOnlyList<ModelTable>? tables = null,
        IReadOnlyList<Relationship>? relationships = null,
        IReadOnlyList<Measure>? measures = null) =>
        new(ModelDefinition.CurrentVersion, tables ?? [], relationships ?? [], measures ?? []);

    public static ModelTable BuildModelTable(
        string schema,
        string name,
        string? friendlyName = null,
        CanvasPosition? position = null,
        IReadOnlyList<ModelColumn>? columns = null) =>
        new(schema, name, friendlyName, Hidden: false, position, columns);

    public static Relationship BuildRelationship(
        string fromTable,
        string fromColumn,
        string toTable,
        string toColumn,
        Cardinality cardinality = Cardinality.ManyToOne,
        bool isActive = true,
        RelationshipSource source = RelationshipSource.Manual) =>
        new(Guid.NewGuid(), fromTable, fromColumn, toTable, toColumn, cardinality, isActive, source);

    public static Measure BuildMeasure(
        string name,
        string table,
        Aggregation aggregation,
        string? column = null,
        IReadOnlyList<FilterSpec>? filters = null) =>
        new(Guid.NewGuid(), name, table, aggregation, column, FormatHint: null, filters);

    public static FilterSpec BuildMeasureFilter(string table, string column) =>
        new(table, column, FilterOperator.NotNull, Array.Empty<JsonElement>());

    /// <summary>Customers + orders + the FK relationship + one Sum measure; validates cleanly.</summary>
    public static ModelDefinition BuildValidDemoModel() => BuildModel(
        tables:
        [
            BuildModelTable("public", "customers", position: new CanvasPosition(20, 40)),
            BuildModelTable("public", "orders", position: new CanvasPosition(320, 40)),
        ],
        relationships:
        [
            BuildRelationship("public.orders", "customer_id", "public.customers", "id", source: RelationshipSource.Fk),
        ],
        measures:
        [
            BuildMeasure("Total Order Value", "public.orders", Aggregation.Sum, "order_total"),
        ]);
}

public sealed class FakeCurrentUserProvider : ICurrentUserProvider
{
    public string UserId { get; set; } = "user-1";

    public bool CanManageShared { get; set; }

    public string GetUserId() => UserId;
}

public sealed class FixedSchemaIntrospector(DatabaseSchema schema) : ISchemaIntrospector
{
    public Task<DatabaseSchema> IntrospectAsync(CancellationToken cancellationToken) => Task.FromResult(schema);
}

public sealed class NullServiceProvider : IServiceProvider
{
    public object? GetService(Type serviceType) => null;
}

/// <summary>
/// Real service wiring over an open in-memory SQLite connection: real registry,
/// real schema cache, real validator; only identity and the introspector are fakes.
/// </summary>
public sealed class ServiceTestHarness : IDisposable
{
    public SqliteConnection Connection { get; }

    public ReconDashboardsDbContext Db { get; }

    public FakeCurrentUserProvider CurrentUser { get; } = new();

    public ReconDashboardsOptions Options { get; }

    public DataSourceRegistry Registry { get; }

    public MemorySchemaCache SchemaCache { get; }

    public SemanticModelValidator Validator { get; } = new();

    public IUserDirectory UserDirectory { get; set; } = new NullUserDirectory();

    public ServiceTestHarness()
    {
        Connection = new SqliteConnection("DataSource=:memory:");
        Connection.Open();

        var dbOptions = new DbContextOptionsBuilder<ReconDashboardsDbContext>()
            .UseSqlite(Connection)
            .Options;
        Db = new ReconDashboardsDbContext(dbOptions);
        Db.Database.EnsureCreated();

        Options = new ReconDashboardsOptions();
        Options.RegisterDataSource(new DataSourceRegistration(
            TestFixtures.DemoConnectionName,
            "test",
            new DataSourceOptions(),
            _ => new FixedSchemaIntrospector(TestFixtures.BuildDemoSchema())));

        Registry = new DataSourceRegistry(Options, new NullServiceProvider());
        SchemaCache = new MemorySchemaCache(Registry);
    }

    public Services.DataModelService CreateDataModelService() =>
        new(Db, CurrentUser, Registry, SchemaCache, Validator, Options, TimeProvider.System);

    public Services.DashboardService CreateDashboardService() =>
        new(Db, CurrentUser, UserDirectory, Options, TimeProvider.System);

    public void Dispose()
    {
        Db.Dispose();
        Connection.Dispose();
    }
}
