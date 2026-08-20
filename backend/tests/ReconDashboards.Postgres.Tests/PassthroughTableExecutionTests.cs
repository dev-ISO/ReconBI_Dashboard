using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// MEASURE-LESS ("passthrough") queries against the real container — the shape
/// a table chart with Rows and no Values compiles to (0.14.1). The golden
/// tests pin the SQL text; this proves the statement is one Postgres actually
/// accepts and that it behaves as SELECT DISTINCT, including across a join and
/// alongside inline Min-of-TEXT columns (the passthrough idiom the library's
/// own seeded dashboards use).
/// </summary>
[Collection("postgres")]
public sealed class PassthroughTableExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly ModelDefinition Model = new(
        ModelDefinition.CurrentVersion,
        Tables: [new ModelTable("public", "customers"), new ModelTable("public", "orders")],
        Relationships:
        [
            new Relationship(
                Guid.NewGuid(), "public.orders", "customer_id", "public.customers", "id",
                Cardinality.ManyToOne, IsActive: true, RelationshipSource.Fk),
        ],
        Measures: []);

    private IQueryExecutor Executor()
    {
        var connectionString = new NpgsqlConnectionStringBuilder(fixture.DataSource.ConnectionString)
        {
            Password = "postgres",
        }.ConnectionString;

        var options = new ReconDashboardsOptions();
        options.AddPostgresDataSource("passthrough-demo", o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
        });
        var registry = new DataSourceRegistry(options, new NullServices());
        Assert.True(registry.TryGet("passthrough-demo", out var source));
        return source.Executor!;
    }

    private sealed class NullServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private CompiledQuery Compile(
        IReadOnlyList<DimensionSpec> dimensions, IReadOnlyList<MeasureSpec>? measures = null)
    {
        var spec = new ChartQuerySpec(
            ModelId: 1,
            Dimensions: dimensions,
            Measures: measures ?? [],
            Filters: [],
            Sort: [],
            TopN: null,
            Limit: null);
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, Model, fixture.RawSchema, limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    private static readonly ExecutionOptions Options = new(MaxRows: 500, TimeoutSeconds: 30);

    [Fact]
    public async Task MeasurelessQueryReturnsTheDistinctDimensionRows()
    {
        var compiled = Compile([new DimensionSpec("public.customers", "region", null)]);
        Assert.All(compiled.Columns, column => Assert.Equal(ResultColumnRole.Dimension, column.Role));

        var result = await Executor().ExecuteAsync(compiled, Options, CancellationToken.None);

        // Four seeded regions, one row each — GROUP BY deduplicated 50 customers.
        Assert.Equal(4, result.Rows.Count);
        Assert.Equal(
            ["East", "North", "South", "West"],
            result.Rows.Select(r => (string)r[0]!).Order().ToArray());
    }

    [Fact]
    public async Task MeasurelessQueryJoinsFromItsFirstDimensionsTable()
    {
        // Base table = dimensions[0] (orders) since there is no measure to
        // anchor on; customers still joins in for the second column.
        var compiled = Compile([
            new DimensionSpec("public.orders", "status", null),
            new DimensionSpec("public.customers", "region", null),
        ]);
        Assert.Contains("FROM \"public\".\"orders\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN \"public\".\"customers\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(2, compiled.Columns.Count);

        var result = await Executor().ExecuteAsync(compiled, Options, CancellationToken.None);

        // 3 statuses x 4 regions, deduplicated.
        Assert.Equal(12, result.Rows.Count);
    }

    [Fact]
    public async Task PassthroughTableCarriesMinOfTextAsAFlatColumn()
    {
        // The seeded-dashboard idiom: one key in Rows plus attributes as
        // inline Min measures — one flat column per attribute, no roll-up.
        var compiled = Compile(
            [new DimensionSpec("public.customers", "name", null)],
            [new MeasureSpec(null, "public.customers", "region", Aggregation.Min, null)]);
        Assert.Equal(ResultColumnRole.Dimension, compiled.Columns[0].Role);
        Assert.Equal(ResultColumnRole.Measure, compiled.Columns[1].Role);

        var result = await Executor().ExecuteAsync(compiled, Options, CancellationToken.None);

        Assert.Equal(50, result.Rows.Count);
        Assert.All(result.Rows, row => Assert.IsType<string>(row[1]));
    }
}
