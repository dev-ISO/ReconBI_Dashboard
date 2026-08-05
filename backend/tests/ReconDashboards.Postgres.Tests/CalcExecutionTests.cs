using System.Text.Json;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Ground-truth arithmetic for time-intelligence calcs against the seeded
/// monthly_sales table (region A: 100, 200, — , 400 in 2025 and 150, 260, — ,
/// 480 in 2026 with March missing both years; region B stops after 2025-04).
/// Proves running totals, YTD year-reset with gap carry-through, densified
/// LAG semantics (a missing bucket yields NULL change, never a wrong-row
/// comparison), YoY percent change, and per-partition windows over the
/// densified region grid.
/// </summary>
[Collection("postgres")]
public sealed class CalcExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly ModelDefinition Model = new(
        ModelDefinition.CurrentVersion,
        Tables: [new ModelTable("public", "monthly_sales")],
        Relationships: [],
        Measures: []);

    private static JsonElement Json(string value) => JsonSerializer.SerializeToElement(value);

    private static DimensionSpec MonthAxis() => new("public.monthly_sales", "sale_date", DateBucket.Month);

    private static MeasureSpec SumAmount(MeasureCalcSpec? calc = null) =>
        new(null, "public.monthly_sales", "amount", Aggregation.Sum, null, calc);

    private static FilterSpec RegionA() =>
        new("public.monthly_sales", "region", FilterOperator.Eq, [Json("A")]);

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec> dimensions,
        IReadOnlyList<MeasureSpec> measures,
        IReadOnlyList<FilterSpec>? filters = null) =>
        new(ModelId: 1, dimensions, measures, filters ?? [], Sort: [], TopN: null, Limit: null);

    private async Task<IReadOnlyList<object?[]>> RunAsync(ChartQuerySpec spec)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, Model, fixture.RawSchema, limits);
        var compiled = Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
        var executor = new PostgresQueryExecutor(fixture.DataSource);
        var result = await executor.ExecuteAsync(
            compiled, new ExecutionOptions(MaxRows: 1000, TimeoutSeconds: 30), CancellationToken.None);
        return result.Rows;
    }

    private static DateTime Bucket(int year, int month) => new(year, month, 1);

    /// <summary>The densified month axis for region A data: 2025-01 .. 2026-04 inclusive.</summary>
    private static readonly DateTime[] FullAxis =
        [.. Enumerable.Range(0, 16).Select(i => Bucket(2025, 1).AddMonths(i))];

    // ---------- running total (no densification: only observed buckets) ----------

    [Fact]
    public async Task RunningTotal_AccumulatesOverObservedBucketsOnly()
    {
        var rows = await RunAsync(Spec(
            [MonthAxis()],
            [SumAmount(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))],
            [RegionA()]));

        // No LAG/YTD kind present -> no densification: exactly the 6 seeded buckets.
        Assert.Equal(
            new[]
            {
                Bucket(2025, 1), Bucket(2025, 2), Bucket(2025, 4),
                Bucket(2026, 1), Bucket(2026, 2), Bucket(2026, 4),
            },
            rows.Select(r => Assert.IsType<DateTime>(r[0])).ToArray());
        Assert.Equal(
            new decimal[] { 100, 300, 700, 850, 1110, 1590 },
            rows.Select(r => Assert.IsType<decimal>(r[1])).ToArray());
    }

    // ---------- YTD: resets each year, carries through gaps ----------

    [Fact]
    public async Task Ytd_ResetsAtYearBoundaryAndCarriesThroughGapMonths()
    {
        var rows = await RunAsync(Spec(
            [MonthAxis()],
            [SumAmount(new MeasureCalcSpec(MeasureCalcKind.Ytd))],
            [RegionA()]));

        // Densified: every month between 2025-01 and 2026-04 is present.
        Assert.Equal(FullAxis, rows.Select(r => Assert.IsType<DateTime>(r[0])).ToArray());

        var ytd = rows.Select(r => Assert.IsType<decimal>(r[1])).ToArray();
        // 2025: 100, 300, gap carries 300, 700, then flat 700 to December.
        Assert.Equal(
            new decimal[] { 100, 300, 300, 700, 700, 700, 700, 700, 700, 700, 700, 700 },
            ytd.Take(12).ToArray());
        // 2026 resets: 150, 410, gap carries 410, 890.
        Assert.Equal(new decimal[] { 150, 410, 410, 890 }, ytd.Skip(12).ToArray());
    }

    // ---------- period change: gap buckets yield NULL, never wrong-row LAG ----------

    [Fact]
    public async Task PeriodChange_GapBucketsProduceNullRawAndNullChange()
    {
        var rows = await RunAsync(Spec(
            [MonthAxis()],
            [SumAmount(), SumAmount(new MeasureCalcSpec(MeasureCalcKind.PeriodChange))],
            [RegionA()]));

        Assert.Equal(FullAxis, rows.Select(r => Assert.IsType<DateTime>(r[0])).ToArray());

        var byMonth = rows.ToDictionary(r => (DateTime)r[0]!, r => (Raw: r[1], Change: r[2]));

        Assert.Equal(100m, byMonth[Bucket(2025, 1)].Raw);
        Assert.Null(byMonth[Bucket(2025, 1)].Change); // nothing before the first bucket

        Assert.Equal(100m, byMonth[Bucket(2025, 2)].Change); // 200 - 100

        // The gap month is KEPT with NULL raw and NULL change.
        Assert.Null(byMonth[Bucket(2025, 3)].Raw);
        Assert.Null(byMonth[Bucket(2025, 3)].Change);

        // April's prior bucket is the (empty) March row -> NULL change, NOT
        // 400 - 200 (which row-based LAG without densification would produce).
        Assert.Equal(400m, byMonth[Bucket(2025, 4)].Raw);
        Assert.Null(byMonth[Bucket(2025, 4)].Change);

        Assert.Equal(110m, byMonth[Bucket(2026, 2)].Change); // 260 - 150
    }

    // ---------- YoY (%): offset 12 over the densified axis ----------

    [Fact]
    public async Task YearOverYearPctChange_MatchesHandArithmeticAndGapsAreNull()
    {
        var rows = await RunAsync(Spec(
            [MonthAxis()],
            [SumAmount(new MeasureCalcSpec(MeasureCalcKind.PeriodChangePct, Offset: 12))],
            [RegionA()]));

        var byMonth = rows.ToDictionary(r => (DateTime)r[0]!, r => r[1]);

        Assert.Equal(0.5m, Assert.IsType<decimal>(byMonth[Bucket(2026, 1)])); // (150-100)/100
        Assert.Equal(0.3m, Assert.IsType<decimal>(byMonth[Bucket(2026, 2)])); // (260-200)/200
        Assert.Null(byMonth[Bucket(2026, 3)]); // gap vs gap
        Assert.Equal(0.2m, Assert.IsType<decimal>(byMonth[Bucket(2026, 4)])); // (480-400)/400
        Assert.Null(byMonth[Bucket(2025, 6)]); // no prior year at all
    }

    // ---------- legend dimension: full grid + per-partition windows ----------

    [Fact]
    public async Task PeriodChangeWithLegend_DensifiesTheFullRegionGridAndPartitionsPerRegion()
    {
        var rows = await RunAsync(Spec(
            [MonthAxis(), new DimensionSpec("public.monthly_sales", "region", null)],
            [SumAmount(), SumAmount(new MeasureCalcSpec(MeasureCalcKind.PeriodChange))]));

        // 16 axis buckets x 2 regions: every combination exists after densification.
        Assert.Equal(16 * 2, rows.Count);

        var byKey = rows.ToDictionary(
            r => ((DateTime)r[0]!, (string)r[1]!), r => (Raw: r[2], Change: r[3]));

        // Windows are partitioned per region: B's February change uses B's January.
        Assert.Equal(10m, byKey[(Bucket(2025, 2), "B")].Change); // 60 - 50
        Assert.Equal(100m, byKey[(Bucket(2025, 2), "A")].Change); // 200 - 100

        // B has no 2026 data, but the grid still carries its axis rows.
        Assert.Null(byKey[(Bucket(2026, 4), "B")].Raw);
        Assert.Null(byKey[(Bucket(2026, 4), "B")].Change);

        // B's March gap makes April's change NULL inside B's partition too.
        Assert.Equal(80m, byKey[(Bucket(2025, 4), "B")].Raw);
        Assert.Null(byKey[(Bucket(2025, 4), "B")].Change);
    }

    // ---------- prior period: plain LAG value ----------

    [Fact]
    public async Task PriorPeriod_ReturnsTheValueOffsetBucketsBack()
    {
        var rows = await RunAsync(Spec(
            [MonthAxis()],
            [SumAmount(new MeasureCalcSpec(MeasureCalcKind.PriorPeriod, Offset: 12))],
            [RegionA()]));

        var byMonth = rows.ToDictionary(r => (DateTime)r[0]!, r => r[1]);

        Assert.Null(byMonth[Bucket(2025, 6)]); // within the first year: no prior
        Assert.Equal(100m, byMonth[Bucket(2026, 1)]);
        Assert.Equal(200m, byMonth[Bucket(2026, 2)]);
        Assert.Null(byMonth[Bucket(2026, 3)]); // prior-year March was a gap
        Assert.Equal(400m, byMonth[Bucket(2026, 4)]);
    }
}
