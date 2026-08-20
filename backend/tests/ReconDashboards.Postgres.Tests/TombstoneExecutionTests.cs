using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// A tombstone must EXECUTE, not merely compile — and against a real engine,
/// because the failure mode is a type one. Postgres rejects a bare untyped NULL
/// wherever the surrounding expression has to pick an overload:
/// "SELECT SUM(NULL)" is <c>function sum(unknown) is not unique</c>, and a
/// polymorphic window call over one cannot resolve its type either. Both
/// shapes are reachable —
/// the Top-N "Others" fold re-aggregates every measure alias, and the window
/// calc stage lags them — so the tombstone emits CAST(NULL AS decimal) and
/// these tests are what keep that cast honest.
///
/// The other half of every test: the SURVIVING measure's numbers must be the
/// numbers it would have produced on its own. Isolation that silently changes
/// the remaining series would be worse than a failed tile.
/// </summary>
[Collection("postgres")]
public sealed class TombstoneExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly ModelDefinition Model = new(
        ModelDefinition.CurrentVersion,
        Tables: [new ModelTable("public", "orders"), new ModelTable("public", "customers")],
        Relationships:
        [
            new Relationship(
                Guid.NewGuid(), "public.orders", "customer_id", "public.customers", "id",
                Cardinality.ManyToOne, IsActive: true, RelationshipSource.Manual),
        ],
        Measures: []);

    private static MeasureSpec Sum(string? alias = null) =>
        new(null, "public.orders", "order_total", Aggregation.Sum, alias);

    private static MeasureSpec Count(string? alias = null) =>
        new(null, "public.orders", null, Aggregation.Count, alias);

    private async Task<IReadOnlyList<object?[]>> RunAsync(ChartQuerySpec spec, params int[] tombstones)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(
            spec, Model, fixture.RawSchema, limits,
            tombstones.Length == 0 ? null : new HashSet<int>(tombstones));
        var compiled = Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());

        var executed = await new PostgresQueryExecutor(fixture.DataSource).ExecuteAsync(
            compiled, new ExecutionOptions(MaxRows: 1000, TimeoutSeconds: 30), CancellationToken.None);
        var (rows, _) = ChartQueryService.ApplyRowAccounting(compiled, executed.Rows, executed.Truncated);
        return rows;
    }

    private static ChartQuerySpec Spec(
        IReadOnlyList<MeasureSpec> measures,
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<SortSpec>? sort = null,
        TopNSpec? topN = null,
        IReadOnlyList<HavingSpec>? having = null) =>
        new(1,
            dimensions ?? [new DimensionSpec("public.customers", "region", null)],
            measures, [], sort ?? [], topN, null, null, having);

    [Fact]
    public async Task ATombstonedMeasureExecutesAsNullAndLeavesItsNeighboursUntouched()
    {
        var spec = Spec([Sum(), Count(), Sum("Again")]);

        var whole = await RunAsync(spec);
        var isolated = await RunAsync(spec, 1);

        Assert.NotEmpty(whole);
        Assert.Equal(whole.Count, isolated.Count);
        for (var i = 0; i < whole.Count; i++)
        {
            Assert.Equal(whole[i][0], isolated[i][0]); // dim0
            Assert.Equal(whole[i][1], isolated[i][1]); // meas0, byte for byte
            Assert.Null(isolated[i][2]);               // meas1, the tombstone
            Assert.Equal(whole[i][3], isolated[i][3]); // meas2, still at index 3
        }
    }

    [Fact]
    public async Task ATombstoneSurvivesTheTopNOthersFoldWhichReAggregatesEveryMeasureAlias()
    {
        // "SUM(meas1)" over the tombstone is the exact shape that fails on an
        // untyped NULL.
        var spec = Spec(
            [Sum(), Count()],
            topN: new TopNSpec(2, ByMeasureIndex: 0, IncludeOthers: true));

        var rows = await RunAsync(spec, 1);

        Assert.NotEmpty(rows);
        Assert.All(rows, r => Assert.Null(r[3])); // dim0, is_topn, meas0, meas1
        Assert.Contains(rows, r => r[2] is not null);
    }

    [Fact]
    public async Task ATombstoneSurvivesTheWindowCalcStage()
    {
        // LAG / SUM OVER against the tombstone's column: the other shape an
        // untyped NULL breaks. The calc rides the SURVIVING measure; the
        // tombstone simply has to be laggable alongside it.
        var spec = Spec(
            [
                Sum() with { Calc = new MeasureCalcSpec(MeasureCalcKind.RunningTotal) },
                Count(),
            ],
            dimensions: [new DimensionSpec("public.orders", "order_date", DateBucket.Month)]);

        var rows = await RunAsync(spec, 1);

        Assert.NotEmpty(rows);
        Assert.All(rows, r => Assert.Null(r[2]));
        Assert.Contains(rows, r => r[1] is not null);
    }

    [Fact]
    public async Task ATombstoneCanItselfCarryTheCalcAndStillExecutes()
    {
        var spec = Spec(
            [
                Sum(),
                Count() with { Calc = new MeasureCalcSpec(MeasureCalcKind.PriorPeriod, 1) },
            ],
            dimensions: [new DimensionSpec("public.orders", "order_date", DateBucket.Month)]);

        var rows = await RunAsync(spec, 1);

        Assert.NotEmpty(rows);
        Assert.All(rows, r => Assert.Null(r[2]));
    }

    [Fact]
    public async Task SortingByATombstonedMeasureExecutes()
    {
        var spec = Spec(
            [Sum(), Count()],
            sort: [new SortSpec(new SortTarget(SortTargetKind.Measure, 1), SortDirection.Desc)]);

        var rows = await RunAsync(spec, 1);

        Assert.NotEmpty(rows);
        Assert.All(rows, r => Assert.Null(r[2]));
    }

    [Fact]
    public async Task DroppingAHavingOnATombstoneKeepsTheRowsTheOtherSeriesNeeds()
    {
        // The regression this guards: rendering "HAVING CAST(NULL AS decimal) >
        // 0" returns ZERO rows — one broken measure blanking the whole chart.
        var spec = Spec([Sum(), Count()], having: [new HavingSpec(1, HavingOperator.Gt, [0])]);

        var withoutHaving = await RunAsync(Spec([Sum(), Count()]), 1);
        var withHaving = await RunAsync(spec, 1);

        Assert.NotEmpty(withHaving);
        Assert.Equal(withoutHaving.Count, withHaving.Count);
    }
}
