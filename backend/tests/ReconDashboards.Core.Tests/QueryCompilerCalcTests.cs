using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Golden-SQL tests for time-intelligence measure calcs: the grouped query is
/// wrapped in the "__rcd_base" CTE and calc measures become window expressions
/// (axis = first dimension, partition = all other dimensions). Bucket-relative
/// kinds (YTD, prior-period family) densify the date axis first so LAG-by-rows
/// equals LAG-by-bucket even with missing buckets.
/// </summary>
public class QueryCompilerCalcTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static MeasureSpec SumOrderTotal(MeasureCalcSpec? calc = null) =>
        new(null, "public.orders", "order_total", Aggregation.Sum, null, calc);

    private static DimensionSpec MonthOfOrderDate() => new("public.orders", "order_date", DateBucket.Month);

    private static DimensionSpec CustomerRegion() => new("public.customers", "region", null);

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<MeasureSpec>? measures = null,
        IReadOnlyList<SortSpec>? sort = null,
        TopNSpec? topN = null) =>
        new(1, dimensions ?? [], measures ?? [SumOrderTotal()], [], sort ?? [], topN, null);

    private static CompiledQuery Compile(ChartQuerySpec spec, ModelDefinition? model = null)
    {
        model ??= TestFixtures.BuildValidDemoModel();
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, model, TestFixtures.BuildDemoSchema(), limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    private static void AssertSql(string expected, CompiledQuery compiled)
    {
        expected = expected.ReplaceLineEndings("\n");
        if (!string.Equals(expected, compiled.Sql, StringComparison.Ordinal))
        {
            Assert.Fail($"SQL mismatch.\n--- expected ---\n{expected}\n--- actual ---\n{compiled.Sql}\n--- end ---");
        }
    }

    private static void AssertCompilationError(string code, ChartQuerySpec spec)
    {
        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Prepare(spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), new RcdLimits()));
        Assert.Equal(code, ex.Code);
    }

    // ---------- running total (no densification) ----------

    [Fact]
    public void RunningTotalOnTextAxisWrapsBaseCteWithFramedSumWindow()
    {
        var compiled = Compile(Spec(
            dimensions: [CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))]));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
)
SELECT "dim0",
       SUM("meas0") OVER (ORDER BY "dim0" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS "meas0"
FROM "__rcd_base"
ORDER BY "dim0" ASC NULLS LAST
LIMIT @p0
""", compiled);

        var limitParam = Assert.Single(compiled.Parameters);
        Assert.Equal(5001L, limitParam.Value);
        Assert.Empty(compiled.Warnings);

        var measureColumn = compiled.Columns[1];
        Assert.Equal("Sum of order_total (running total)", measureColumn.Label);
        Assert.Equal(NormalizedType.Decimal, measureColumn.Type);
    }

    [Fact]
    public void RunningTotalWithLegendPartitionsByTheOtherDimension()
    {
        var compiled = Compile(Spec(
            dimensions: [MonthOfOrderDate(), CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))]));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT date_trunc('month', "t0"."order_date") AS "dim0",
       "t1"."region" AS "dim1",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY date_trunc('month', "t0"."order_date"), "t1"."region"
)
SELECT "dim0",
       "dim1",
       SUM("meas0") OVER (PARTITION BY "dim1" ORDER BY "dim0" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS "meas0"
FROM "__rcd_base"
ORDER BY "dim0" ASC NULLS LAST, "dim1" ASC NULLS LAST
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void MixedCalcAndPlainMeasuresPassPlainOnesThrough()
    {
        var compiled = Compile(Spec(
            dimensions: [CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal)), SumOrderTotal()]));

        Assert.Contains(
            """
SELECT "dim0",
       SUM("meas0") OVER (ORDER BY "dim0" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS "meas0",
       "meas1"
FROM "__rcd_base"
""".ReplaceLineEndings("\n"),
            compiled.Sql, StringComparison.Ordinal);

        Assert.Equal("Sum of order_total (running total)", compiled.Columns[1].Label);
        Assert.Equal("Sum of order_total", compiled.Columns[2].Label);
    }

    // ---------- YTD (densified, year partition) ----------

    [Fact]
    public void YtdDensifiesTheAxisAndPartitionsByYear()
    {
        var compiled = Compile(Spec(
            dimensions: [MonthOfOrderDate()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.Ytd))]));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT date_trunc('month', "t0"."order_date") AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
GROUP BY date_trunc('month', "t0"."order_date")
),
"__rcd_axis" AS (
SELECT generate_series(MIN("dim0"), MAX("dim0"), interval '1 month') AS "dim0"
FROM "__rcd_base"
)
SELECT "__rcd_axis"."dim0" AS "dim0",
       SUM("__rcd_base"."meas0") OVER (PARTITION BY date_trunc('year', "__rcd_axis"."dim0") ORDER BY "__rcd_axis"."dim0" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS "meas0"
FROM "__rcd_axis"
LEFT JOIN "__rcd_base" ON "__rcd_axis"."dim0" = "__rcd_base"."dim0"
ORDER BY "__rcd_axis"."dim0" ASC NULLS LAST
LIMIT @p0
""", compiled);

        Assert.Equal("Sum of order_total (YTD)", compiled.Columns[1].Label);
    }

    // ---------- prior-period family (densified, LAG) ----------

    [Fact]
    public void PriorPeriodEmitsLagWithParameterizedOffset()
    {
        var compiled = Compile(Spec(
            dimensions: [MonthOfOrderDate()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.PriorPeriod, Offset: 12))]));

        Assert.Contains(
            "LAG(\"__rcd_base\".\"meas0\", CAST(@p0 AS integer)) OVER (ORDER BY \"__rcd_axis\".\"dim0\" ASC NULLS LAST) AS \"meas0\"",
            compiled.Sql, StringComparison.Ordinal);

        Assert.Equal(2, compiled.Parameters.Count);
        Assert.Equal(12L, compiled.Parameters[0].Value);
        Assert.Equal(5001L, compiled.Parameters[1].Value);
        Assert.Equal("Sum of order_total (prior)", compiled.Columns[1].Label);
    }

    [Fact]
    public void PeriodChangeWithLegendDensifiesOverTheDistinctKeyGrid()
    {
        var compiled = Compile(Spec(
            dimensions: [MonthOfOrderDate(), CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.PeriodChange))]));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT date_trunc('month', "t0"."order_date") AS "dim0",
       "t1"."region" AS "dim1",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY date_trunc('month', "t0"."order_date"), "t1"."region"
),
"__rcd_axis" AS (
SELECT generate_series(MIN("dim0"), MAX("dim0"), interval '1 month') AS "dim0"
FROM "__rcd_base"
),
"__rcd_keys" AS (
SELECT DISTINCT "dim1"
FROM "__rcd_base"
),
"__rcd_grid" AS (
SELECT "__rcd_axis"."dim0", "__rcd_keys"."dim1"
FROM "__rcd_axis"
CROSS JOIN "__rcd_keys"
)
SELECT "__rcd_grid"."dim0" AS "dim0",
       "__rcd_grid"."dim1" AS "dim1",
       ("__rcd_base"."meas0" - LAG("__rcd_base"."meas0", CAST(@p0 AS integer)) OVER (PARTITION BY "__rcd_grid"."dim1" ORDER BY "__rcd_grid"."dim0" ASC NULLS LAST)) AS "meas0"
FROM "__rcd_grid"
LEFT JOIN "__rcd_base" ON "__rcd_grid"."dim0" = "__rcd_base"."dim0" AND "__rcd_grid"."dim1" IS NOT DISTINCT FROM "__rcd_base"."dim1"
ORDER BY "__rcd_grid"."dim0" ASC NULLS LAST, "__rcd_grid"."dim1" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        Assert.Equal(1L, compiled.Parameters[0].Value); // default offset
        Assert.Equal("Sum of order_total (change)", compiled.Columns[2].Label);
    }

    [Fact]
    public void PeriodChangePctGuardsDivisionAndMarksColumnAsPercent()
    {
        var compiled = Compile(Spec(
            dimensions: [MonthOfOrderDate()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.PeriodChangePct))]));

        var lag = "LAG(\"__rcd_base\".\"meas0\", CAST(@p0 AS integer)) OVER (ORDER BY \"__rcd_axis\".\"dim0\" ASC NULLS LAST)";
        Assert.Contains(
            $"(CAST((\"__rcd_base\".\"meas0\" - {lag}) AS decimal) / NULLIF({lag}, 0)) AS \"meas0\"",
            compiled.Sql, StringComparison.Ordinal);

        var measureColumn = compiled.Columns[1];
        Assert.Equal("Sum of order_total (% change)", measureColumn.Label);
        Assert.Equal(NormalizedType.Decimal, measureColumn.Type);
        Assert.Equal("percent", measureColumn.FormatHint);
    }

    [Fact]
    public void ThreeDimensionsPartitionByBothNonAxisDimensions()
    {
        var compiled = Compile(Spec(
            dimensions: [MonthOfOrderDate(), CustomerRegion(), new DimensionSpec("public.orders", "status", null)],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.PeriodChange))]));

        Assert.Contains(
            "SELECT DISTINCT \"dim1\", \"dim2\"",
            compiled.Sql, StringComparison.Ordinal);
        Assert.Contains(
            "OVER (PARTITION BY \"__rcd_grid\".\"dim1\", \"__rcd_grid\".\"dim2\" ORDER BY \"__rcd_grid\".\"dim0\" ASC NULLS LAST)",
            compiled.Sql, StringComparison.Ordinal);
        Assert.Contains(
            "\"__rcd_grid\".\"dim1\" IS NOT DISTINCT FROM \"__rcd_base\".\"dim1\" AND \"__rcd_grid\".\"dim2\" IS NOT DISTINCT FROM \"__rcd_base\".\"dim2\"",
            compiled.Sql, StringComparison.Ordinal);
    }

    // ---------- composition with Top-N ----------

    [Fact]
    public void TopNWithoutOthersWrapsTheRankedLimitedQueryAsTheCalcBase()
    {
        var compiled = Compile(Spec(
            dimensions: [CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))],
            topN: new TopNSpec(5, 0, IncludeOthers: false)));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
ORDER BY "meas0" DESC NULLS LAST, "t1"."region" ASC NULLS LAST
LIMIT @p0
)
SELECT "dim0",
       SUM("meas0") OVER (ORDER BY "dim0" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS "meas0"
FROM "__rcd_base"
ORDER BY "dim0" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        Assert.Equal(6L, compiled.Parameters[0].Value); // N + 1 overflow probe
        Assert.Equal(5001L, compiled.Parameters[1].Value);
    }

    [Fact]
    public void TopNWithOthersAppliesTheCalcOverTheFoldedRowsAndKeepsIsTopN()
    {
        var compiled = Compile(Spec(
            dimensions: [CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))],
            topN: new TopNSpec(5, 0, IncludeOthers: true)));

        AssertSql("""
WITH "base" AS (
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
),
"ranked" AS (
SELECT *, ROW_NUMBER() OVER (ORDER BY "meas0" DESC NULLS LAST, "dim0" ASC NULLS LAST) AS "rn"
FROM "base"
),
"__rcd_base" AS (
SELECT CASE WHEN "rn" <= @p0 THEN "dim0" END AS "dim0",
       ("rn" <= @p0) AS "is_topn",
       SUM("meas0") AS "meas0"
FROM "ranked"
GROUP BY 1, 2
)
SELECT "dim0",
       "is_topn",
       SUM("meas0") OVER (ORDER BY "dim0" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS "meas0"
FROM "__rcd_base"
ORDER BY "dim0" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        Assert.Equal(5L, compiled.Parameters[0].Value);
        Assert.Equal(5001L, compiled.Parameters[1].Value);

        Assert.Equal(["dim0", "is_topn", "meas0"], compiled.Columns.Select(c => c.Name).ToArray());
        Assert.Equal("Sum of order_total (running total)", compiled.Columns[2].Label);
        Assert.Empty(compiled.Warnings);
    }

    // ---------- composition with calculated (expression) measures ----------

    [Fact]
    public void CalcOverExpressionMeasureWindowsTheAggregatedExpressionValue()
    {
        var ratio = new Measure(
            Guid.NewGuid(), "Avg Order Value", "public.orders", Aggregation.Sum, Column: null,
            FormatHint: null, Filters: null, Expression: "[Total Order Value] / [Order Count]");
        var model = TestFixtures.BuildValidDemoModel();
        var orderCount = TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count);
        model = model with { Measures = [.. model.Measures, orderCount, ratio] };

        var compiled = Compile(
            Spec(
                dimensions: [CustomerRegion()],
                measures: [new MeasureSpec(ratio.Id, null, null, null, null, new MeasureCalcSpec(MeasureCalcKind.RunningTotal))]),
            model);

        Assert.Contains(
            "(CAST(SUM(\"t0\".\"order_total\") AS decimal) / NULLIF(COUNT(*), 0)) AS \"meas0\"",
            compiled.Sql, StringComparison.Ordinal);
        Assert.Contains(
            "SUM(\"meas0\") OVER (ORDER BY \"dim0\" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS \"meas0\"",
            compiled.Sql, StringComparison.Ordinal);
        Assert.Equal("Avg Order Value (running total)", compiled.Columns[1].Label);
    }

    // ---------- fan-out warnings unchanged ----------

    [Fact]
    public void FanOutWarningsSurviveCalcWrapping()
    {
        // Base is customers (first measure's table); the inspections chain
        // orders<-inspections enters orders from its ONE side… simplest known
        // fan-out: measure on customers, dimension pulls in orders (many side).
        var model = TestFixtures.BuildValidDemoModel();
        var spec = Spec(
            dimensions: [new DimensionSpec("public.orders", "status", null)],
            measures:
            [
                new MeasureSpec(null, "public.customers", "credit_limit", Aggregation.Sum, null,
                    new MeasureCalcSpec(MeasureCalcKind.RunningTotal)),
            ]);

        var compiled = Compile(spec, model);

        var warning = Assert.Single(compiled.Warnings);
        Assert.Equal("QRY_FANOUT", warning.Code);
    }

    // ---------- validation ----------

    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    [InlineData(1001)]
    public void OffsetOutsideOneToThousandIsRejected(int offset) =>
        AssertCompilationError("QRY_CALC_INVALID", Spec(
            dimensions: [MonthOfOrderDate()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.PeriodChange, offset))]));

    [Theory]
    [InlineData(MeasureCalcKind.Ytd)]
    [InlineData(MeasureCalcKind.PriorPeriod)]
    [InlineData(MeasureCalcKind.PeriodChange)]
    [InlineData(MeasureCalcKind.PeriodChangePct)]
    public void BucketRelativeKindsRequireDateBucketedFirstDimension(MeasureCalcKind kind) =>
        AssertCompilationError("QRY_CALC_NEEDS_DATE_AXIS", Spec(
            dimensions: [CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec(kind))]));

    [Fact]
    public void UnbucketedDateColumnDoesNotCountAsADateAxis() =>
        AssertCompilationError("QRY_CALC_NEEDS_DATE_AXIS", Spec(
            dimensions: [new DimensionSpec("public.orders", "order_date", null)],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.Ytd))]));

    [Fact]
    public void DateBucketedSecondDimensionDoesNotSatisfyTheAxisRequirement() =>
        AssertCompilationError("QRY_CALC_NEEDS_DATE_AXIS", Spec(
            dimensions: [CustomerRegion(), MonthOfOrderDate()],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.PeriodChange))]));

    [Fact]
    public void CalcWithZeroDimensionsIsRejected() =>
        AssertCompilationError("QRY_CALC_INVALID", Spec(
            dimensions: [],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))]));

    [Fact]
    public void UnknownCalcKindIsRejected() =>
        AssertCompilationError("QRY_CALC_INVALID", Spec(
            dimensions: [CustomerRegion()],
            measures: [SumOrderTotal(new MeasureCalcSpec((MeasureCalcKind)99))]));
}
