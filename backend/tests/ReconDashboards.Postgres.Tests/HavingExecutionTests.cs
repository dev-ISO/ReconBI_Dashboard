using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// HAVING against the real container. Ground truth comes from the same seeded
/// data run WITHOUT having: the filtered result must be exactly the baseline
/// groups whose aggregate satisfies the condition. Seed facts used directly:
/// 200 orders, status counts open=66 / closed=67 / cancelled=67.
/// </summary>
[Collection("postgres")]
public sealed class HavingExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly ExecutionOptions Options = new(MaxRows: 100, TimeoutSeconds: 30);

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
        options.AddPostgresDataSource("having-demo", o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
        });
        var registry = new DataSourceRegistry(options, new NullServices());
        Assert.True(registry.TryGet("having-demo", out var source));
        return source.Executor!;
    }

    private sealed class NullServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private CompiledQuery Compile(
        IReadOnlyList<HavingSpec>? having,
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<MeasureSpec>? measures = null,
        TopNSpec? topN = null)
    {
        var spec = new ChartQuerySpec(
            ModelId: 1,
            Dimensions: dimensions ?? [new DimensionSpec("public.customers", "region", null)],
            Measures: measures ?? [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null)],
            Filters: [],
            Sort: [],
            TopN: topN,
            Limit: null,
            Offset: null,
            Having: having);
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, Model, fixture.RawSchema, limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    [Fact]
    public async Task GtKeepsExactlyTheBaselineGroupsAboveTheThreshold()
    {
        var executor = Executor();

        var all = await executor.ExecuteAsync(Compile(having: null), Options, CancellationToken.None);
        Assert.Equal(4, all.Rows.Count); // North/South/East/West

        // Threshold between the smallest and the rest: sums differ per region.
        var sums = all.Rows.Select(r => Convert.ToDouble(r[1]!)).OrderBy(v => v).ToArray();
        Assert.True(sums[0] < sums[1]); // seed produces distinct region sums
        var threshold = (sums[0] + sums[1]) / 2;

        var filtered = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.Gt, [threshold])]), Options, CancellationToken.None);

        var expected = all.Rows
            .Where(r => Convert.ToDouble(r[1]!) > threshold)
            .Select(r => (string?)r[0])
            .ToHashSet();
        Assert.Equal(3, filtered.Rows.Count);
        Assert.Equal(expected, filtered.Rows.Select(r => (string?)r[0]).ToHashSet());
    }

    [Fact]
    public async Task BetweenBoundsAreInclusive()
    {
        var executor = Executor();

        var all = await executor.ExecuteAsync(Compile(having: null), Options, CancellationToken.None);
        var ordered = all.Rows.OrderBy(r => Convert.ToDouble(r[1]!)).ToArray();

        // Bounds sit EXACTLY on the 2nd and 3rd group sums (order totals are
        // 0.25-multiples, exact in double): both endpoints must be included.
        var lower = Convert.ToDouble(ordered[1][1]!);
        var upper = Convert.ToDouble(ordered[2][1]!);

        var filtered = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.Between, [lower, upper])]), Options, CancellationToken.None);

        Assert.Equal(2, filtered.Rows.Count);
        Assert.Equal(
            new[] { (string?)ordered[1][0], (string?)ordered[2][0] }.ToHashSet(),
            filtered.Rows.Select(r => (string?)r[0]).ToHashSet());
    }

    [Fact]
    public async Task EqAndNeqMatchTheSeededStatusCounts()
    {
        var executor = Executor();
        DimensionSpec[] status = [new("public.orders", "status", null)];
        MeasureSpec[] count = [new(null, "public.orders", null, Aggregation.Count, null)];

        // Seed: 200 orders cycle open/closed/cancelled -> 66/67/67.
        var eq = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.Eq, [67])], status, count), Options, CancellationToken.None);
        Assert.Equal(2, eq.Rows.Count);
        Assert.All(eq.Rows, r => Assert.Equal(67L, Convert.ToInt64(r[1]!)));

        var neq = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.Neq, [67])], status, count), Options, CancellationToken.None);
        var only = Assert.Single(neq.Rows);
        Assert.Equal("open", only[0]?.ToString());
        Assert.Equal(66L, Convert.ToInt64(only[1]!));
    }

    [Fact]
    public async Task ZeroDimensionAlertShapeReturnsTheRowOnlyWhenTheConditionHolds()
    {
        var executor = Executor();
        MeasureSpec[] count = [new(null, "public.orders", null, Aggregation.Count, null)];

        var firing = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.Gt, [100])], dimensions: [], measures: count),
            Options, CancellationToken.None);
        var row = Assert.Single(firing.Rows);
        Assert.Equal(200L, Convert.ToInt64(row[0]!)); // all 200 seeded orders

        var quiet = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.Gt, [300])], dimensions: [], measures: count),
            Options, CancellationToken.None);
        Assert.Empty(quiet.Rows);
    }

    [Fact]
    public async Task InKeepsExactlyTheListedGroupAggregates()
    {
        var executor = Executor();

        var all = await executor.ExecuteAsync(Compile(having: null), Options, CancellationToken.None);
        Assert.Equal(4, all.Rows.Count);

        // Order totals are 0.25-multiples: the sums are exact in double, so
        // membership equality against the decimal parameters is exact too.
        var ordered = all.Rows.OrderBy(r => Convert.ToDouble(r[1]!)).ToArray();
        var picked = new[] { Convert.ToDouble(ordered[0][1]!), Convert.ToDouble(ordered[2][1]!) };

        var filtered = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.In, picked)]), Options, CancellationToken.None);

        Assert.Equal(2, filtered.Rows.Count);
        Assert.Equal(
            new[] { (string?)ordered[0][0], (string?)ordered[2][0] }.ToHashSet(),
            filtered.Rows.Select(r => (string?)r[0]).ToHashSet());
    }

    [Fact]
    public async Task NotInIsTheExactComplementOfIn()
    {
        var executor = Executor();

        var all = await executor.ExecuteAsync(Compile(having: null), Options, CancellationToken.None);
        var ordered = all.Rows.OrderBy(r => Convert.ToDouble(r[1]!)).ToArray();
        var excluded = new[] { Convert.ToDouble(ordered[1][1]!) };

        var filtered = await executor.ExecuteAsync(
            Compile([new HavingSpec(0, HavingOperator.NotIn, excluded)]), Options, CancellationToken.None);

        Assert.Equal(3, filtered.Rows.Count);
        Assert.Equal(
            all.Rows.Select(r => (string?)r[0]).Where(r => !Equals(r, ordered[1][0])).ToHashSet(),
            filtered.Rows.Select(r => (string?)r[0]).ToHashSet());
    }

    [Fact]
    public async Task HavingAppliesBeforeTopNRanking()
    {
        var executor = Executor();

        var all = await executor.ExecuteAsync(Compile(having: null), Options, CancellationToken.None);
        var ordered = all.Rows.OrderByDescending(r => Convert.ToDouble(r[1]!)).ToArray();
        var top = Convert.ToDouble(ordered[0][1]!);
        var second = Convert.ToDouble(ordered[1][1]!);
        var threshold = (top + second) / 2; // only the top group survives

        var filtered = await executor.ExecuteAsync(
            Compile(
                [new HavingSpec(0, HavingOperator.Gt, [threshold])],
                topN: new TopNSpec(2, 0, IncludeOthers: false)),
            Options, CancellationToken.None);

        // N = 2, but HAVING already removed every other group in the base
        // grouped stage — only the top group can be ranked.
        var only = Assert.Single(filtered.Rows);
        Assert.Equal(ordered[0][0], only[0]);
    }
}
