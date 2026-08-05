using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Offset pagination against the real container: OFFSET binds as a parameter
/// and pages line up exactly with the un-offset ordering.
/// </summary>
[Collection("postgres")]
public sealed class OffsetExecutionTests(PostgresContainerFixture fixture)
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
        options.AddPostgresDataSource("offset-demo", o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
        });
        var registry = new DataSourceRegistry(options, new NullServices());
        Assert.True(registry.TryGet("offset-demo", out var source));
        return source.Executor!;
    }

    private sealed class NullServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private CompiledQuery Compile(int? offset, int? limit = null)
    {
        var spec = new ChartQuerySpec(
            ModelId: 1,
            Dimensions: [new DimensionSpec("public.customers", "region", null)],
            Measures: [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null)],
            Filters: [],
            Sort: [],
            TopN: null,
            Limit: limit,
            Offset: offset);
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, Model, fixture.RawSchema, limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    [Fact]
    public async Task OffsetSkipsRowsOfTheOrderedResult()
    {
        var executor = Executor();
        var options = new ExecutionOptions(MaxRows: 100, TimeoutSeconds: 30);

        var all = await executor.ExecuteAsync(Compile(offset: null), options, CancellationToken.None);
        Assert.True(all.Rows.Count >= 4); // North/South/East/West regions

        var paged = await executor.ExecuteAsync(Compile(offset: 2), options, CancellationToken.None);

        Assert.Equal(all.Rows.Count - 2, paged.Rows.Count);
        Assert.Equal(all.Rows[2][0], paged.Rows[0][0]);
        Assert.Equal(all.Rows[2][1], paged.Rows[0][1]);
        Assert.Equal(all.Rows[^1][0], paged.Rows[^1][0]);
    }

    [Fact]
    public async Task OffsetBeyondResultYieldsEmptyPage()
    {
        var executor = Executor();
        var options = new ExecutionOptions(MaxRows: 100, TimeoutSeconds: 30);

        var page = await executor.ExecuteAsync(Compile(offset: 5000), options, CancellationToken.None);

        Assert.Empty(page.Rows);
        Assert.False(page.Truncated);
    }

    [Fact]
    public async Task OffsetComposesWithLimitForPageWindows()
    {
        var executor = Executor();
        var options = new ExecutionOptions(MaxRows: 100, TimeoutSeconds: 30);

        var all = await executor.ExecuteAsync(Compile(offset: null), options, CancellationToken.None);
        // MaxRows mirrors the page size the way ChartQueryService caps reads.
        var window = await executor.ExecuteAsync(
            Compile(offset: 1, limit: 2), new ExecutionOptions(MaxRows: 2, TimeoutSeconds: 30), CancellationToken.None);

        Assert.Equal(2, window.Rows.Count);
        Assert.Equal(all.Rows[1][0], window.Rows[0][0]);
        Assert.Equal(all.Rows[2][0], window.Rows[1][0]);
    }
}
