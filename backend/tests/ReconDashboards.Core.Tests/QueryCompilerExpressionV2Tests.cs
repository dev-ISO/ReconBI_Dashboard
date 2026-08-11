using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Golden-SQL tests for grammar v2: IF/SWITCH/DIVIDE, scalar functions,
/// comparisons and boolean operators, nested measure references (transitive
/// inlining + filter composition), cycle/depth rejection, PERCENTOFTOTAL's
/// window stage, and its documented composition guards. Exact-statement
/// assertions double as the security proof for the new grammar surface.
/// </summary>
public class QueryCompilerExpressionV2Tests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static Measure ExpressionMeasure(string name, string expression) =>
        new(Guid.NewGuid(), name, "public.orders", Aggregation.Sum, Column: null,
            FormatHint: null, Filters: null, Expression: expression);

    private static ModelDefinition ModelWith(params Measure[] extraMeasures)
    {
        var model = TestFixtures.BuildValidDemoModel();
        var orderCount = TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count);
        return model with { Measures = [.. model.Measures, orderCount, .. extraMeasures] };
    }

    private static ChartQuerySpec SpecFor(
        Measure measure,
        IReadOnlyList<DimensionSpec>? dimensions = null,
        TopNSpec? topN = null,
        MeasureCalcSpec? calc = null,
        IReadOnlyList<HavingSpec>? having = null) =>
        new(1, dimensions ?? [], [new MeasureSpec(measure.Id, null, null, null, null, calc)], [], [], topN, null, null, having);

    private static CompiledQuery Compile(ChartQuerySpec spec, ModelDefinition model)
    {
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

    private static QueryCompilationException AssertPrepareThrows(ChartQuerySpec spec, ModelDefinition model) =>
        Assert.Throws<QueryCompilationException>(
            () => Compiler.Prepare(spec, model, TestFixtures.BuildDemoSchema(), new RcdLimits()));

    // ---------- conditional emission ----------

    [Fact]
    public void IfEmitsCaseWhenWithElse()
    {
        var measure = ExpressionMeasure("Flag", "IF(SUM(public.orders.order_total) > 100, 1, 0)");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT CASE WHEN (SUM("t0"."order_total") > 100) THEN 1 ELSE 0 END AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void IfWithoutElseEmitsNullBlankSemantics()
    {
        var measure = ExpressionMeasure("Maybe", "IF(count(*) > 0, count(*))");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT CASE WHEN (COUNT(*) > 0) THEN COUNT(*) END AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void SwitchEmitsSimpleCase()
    {
        var measure = ExpressionMeasure("Bucketed", "SWITCH(count(*), 1, 10, 2, 20, 0)");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT CASE COUNT(*) WHEN 1 THEN 10 WHEN 2 THEN 20 ELSE 0 END AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void BooleanOperatorsEmitParenthesizedAndOrNot()
    {
        var measure = ExpressionMeasure(
            "Guarded", "IF(SUM(public.orders.order_total) > 100 AND NOT count(*) = 0 OR [Order Count] >= 5, 1, 0)");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT CASE WHEN (((SUM("t0"."order_total") > 100) AND (NOT (COUNT(*) = 0))) OR (COUNT(*) >= 5)) THEN 1 ELSE 0 END AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    // ---------- DIVIDE ----------

    [Fact]
    public void DivideWithoutAlternateEmitsNullifGuard()
    {
        var measure = ExpressionMeasure("AOV", "DIVIDE([Total Order Value], [Order Count])");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT (CAST(SUM("t0"."order_total") AS decimal) / NULLIF(COUNT(*), 0)) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void DivideWithAlternateEmitsCaseOnZeroOrNullDenominator()
    {
        var measure = ExpressionMeasure("AOV Safe", "DIVIDE([Total Order Value], [Order Count], 0)");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT CASE WHEN COUNT(*) IS NULL OR COUNT(*) = 0 THEN 0 ELSE (CAST(SUM("t0"."order_total") AS decimal) / COUNT(*)) END AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    // ---------- scalar functions ----------

    [Fact]
    public void ScalarFunctionsEmitAnsiShapes()
    {
        var measure = ExpressionMeasure(
            "Mix", "ROUND(AVG(public.orders.order_total), 2) + COALESCE(MIN(public.orders.order_total), 0, BLANK())");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT (ROUND(CAST(AVG("t0"."order_total") AS numeric), 2) + COALESCE(MIN("t0"."order_total"), 0, NULL)) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void PowerSqrtAbsFloorCeilingExpLnEmit()
    {
        var measure = ExpressionMeasure(
            "Math",
            "POWER(ABS(SUM(public.orders.order_total)), 2) / SQRT([Order Count]) + FLOOR(CEILING(EXP(LN([Order Count]))))");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT ((CAST(POWER(ABS(SUM("t0"."order_total")), 2) AS decimal) / NULLIF(SQRT(COUNT(*)), 0)) + FLOOR(CEILING(EXP(LN(COUNT(*)))))) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    // ---------- nested measure references ----------

    [Fact]
    public void NestedReferencesInlineWithFilterComposition()
    {
        var paid = TestFixtures.BuildMeasure(
            "Paid Total", "public.orders", Aggregation.Sum, "order_total",
            filters:
            [
                new FilterSpec("public.orders", "status", FilterOperator.Eq,
                    [System.Text.Json.JsonSerializer.SerializeToElement("paid")]),
            ]);
        var inner = new Measure(
            Guid.NewGuid(), "Inner", "public.orders", Aggregation.Sum, Column: null, FormatHint: null,
            Filters: [TestFixtures.BuildMeasureFilter("public.orders", "order_total")],
            Expression: "[Paid Total] * 2");
        var outer = ExpressionMeasure("Outer", "[Inner] + 1");
        var demo = TestFixtures.BuildValidDemoModel();
        var model = demo with { Measures = [.. demo.Measures, paid, inner, outer] };

        var compiled = Compile(SpecFor(outer), model);

        // The inlined aggregate carries BOTH the referenced measure's filter
        // (status = 'paid') and the intermediate expression measure's filter
        // (order_total IS NOT NULL) — the documented AND composition rule.
        AssertSql("""
SELECT ((SUM("t0"."order_total") FILTER (WHERE "t0"."status" = @p0 AND "t0"."order_total" IS NOT NULL) * 2) + 1) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p1
""", compiled);
    }

    [Fact]
    public void CrossTableNestedReferencePullsItsTableIntoTheJoinPlan()
    {
        var creditSum = TestFixtures.BuildMeasure("Credit", "public.customers", Aggregation.Sum, "credit_limit");
        var inner = ExpressionMeasure("Inner Ratio", "[Total Order Value] / [Credit]");
        var outer = ExpressionMeasure("Outer", "[Inner Ratio] * 100");
        var demo = TestFixtures.BuildValidDemoModel();
        var model = demo with { Measures = [.. demo.Measures, creditSum, inner, outer] };

        var compiled = Compile(SpecFor(outer), model);

        AssertSql("""
SELECT ((CAST(SUM("t0"."order_total") AS decimal) / NULLIF(SUM("t1"."credit_limit"), 0)) * 100) AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void ReferenceCycleIsRejectedWithQryMeasureCycle()
    {
        var a = ExpressionMeasure("A", "[B] + count(*)");
        var b = ExpressionMeasure("B", "[A] * 2");
        var ex = AssertPrepareThrows(SpecFor(a), ModelWith(a, b));

        Assert.Equal("QRY_MEASURE_CYCLE", ex.Code);
        Assert.Contains("cycle", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ReferenceChainDeeperThanEightIsRejected()
    {
        var chain = new List<Measure> { ExpressionMeasure("E0", "count(*) + 0") };
        for (var i = 1; i <= 9; i++)
        {
            chain.Add(ExpressionMeasure($"E{i}", $"[E{i - 1}] + 1"));
        }

        var ex = AssertPrepareThrows(SpecFor(chain[^1]), ModelWith([.. chain]));

        Assert.Equal("QRY_MEASURE_CYCLE", ex.Code);
        Assert.Contains("deep", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ReferenceChainOfExactlyEightCompiles()
    {
        var chain = new List<Measure> { ExpressionMeasure("E0", "count(*) + 0") };
        for (var i = 1; i <= 8; i++)
        {
            chain.Add(ExpressionMeasure($"E{i}", $"[E{i - 1}] + 1"));
        }

        var compiled = Compile(SpecFor(chain[^1]), ModelWith([.. chain]));
        Assert.Contains("COUNT(*)", compiled.Sql, StringComparison.Ordinal);
    }

    // ---------- PERCENTOFTOTAL ----------

    [Fact]
    public void PercentOfTotalEmitsWindowStageOverTheGroupedBase()
    {
        var share = ExpressionMeasure("Region Share", "PERCENTOFTOTAL([Total Order Value])");
        var compiled = Compile(
            SpecFor(share, dimensions: [new DimensionSpec("public.customers", "region", null)]),
            ModelWith(share));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
)
SELECT "dim0",
       (CAST("meas0" AS decimal) / NULLIF(SUM("meas0") OVER (), 0)) AS "meas0"
FROM "__rcd_base"
ORDER BY "dim0" ASC NULLS LAST
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void PercentOfTotalWithZeroDimensionsCompilesToTheTrivialShare()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL(SUM(public.orders.order_total))");
        var compiled = Compile(SpecFor(share), ModelWith(share));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
)
SELECT (CAST("meas0" AS decimal) / NULLIF(SUM("meas0") OVER (), 0)) AS "meas0"
FROM "__rcd_base"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void PercentOfTotalColumnPlanDefaultsToPercentHint()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total Order Value])");
        var compiled = Compile(SpecFor(share), ModelWith(share));

        var plan = Assert.Single(compiled.Columns);
        Assert.Equal(NormalizedType.Decimal, plan.Type);
        Assert.Equal("percent", plan.FormatHint);
        Assert.Null(plan.FormatString);
    }

    [Fact]
    public void PercentOfTotalCombinedWithCalcIsRejected()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total Order Value])");
        var spec = SpecFor(
            share,
            dimensions: [new DimensionSpec("public.orders", "order_date", DateBucket.Month)],
            calc: new MeasureCalcSpec(MeasureCalcKind.RunningTotal, null));

        var ex = AssertPrepareThrows(spec, ModelWith(share));
        Assert.Equal("QRY_PCT_TOTAL_UNSUPPORTED", ex.Code);
    }

    [Fact]
    public void HavingOnAPercentOfTotalMeasureIsRejected()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total Order Value])");
        var spec = SpecFor(
            share,
            dimensions: [new DimensionSpec("public.customers", "region", null)],
            having: [new HavingSpec(0, HavingOperator.Gt, [0.5])]);

        var ex = AssertPrepareThrows(spec, ModelWith(share));
        Assert.Equal("QRY_PCT_TOTAL_UNSUPPORTED", ex.Code);
        Assert.Contains("HAVING", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TopNRankedByAPercentOfTotalMeasureIsRejected()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total Order Value])");
        var model = ModelWith(share);
        var spec = SpecFor(
            share,
            dimensions: [new DimensionSpec("public.customers", "region", null)],
            topN: new TopNSpec(3, 0, IncludeOthers: false));

        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, model, TestFixtures.BuildDemoSchema(), limits);
        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions()));
        Assert.Equal("QRY_PCT_TOTAL_UNSUPPORTED", ex.Code);
    }

    [Fact]
    public void TopNRankedByAnotherMeasureAppliesPercentOfTotalOverTheTopRows()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total Order Value])");
        var model = ModelWith(share);
        var spec = new ChartQuerySpec(
            1,
            [new DimensionSpec("public.customers", "region", null)],
            [
                new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null),
                new MeasureSpec(share.Id, null, null, null, null),
            ],
            [], [], new TopNSpec(2, 0, IncludeOthers: false), null);

        var compiled = Compile(spec, model);

        // The flat ranked+limited query becomes the window base; the share is
        // computed over exactly the displayed rows.
        Assert.Contains("\"__rcd_base\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains(
            "(CAST(\"meas1\" AS decimal) / NULLIF(SUM(\"meas1\") OVER (), 0)) AS \"meas1\"",
            compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void ReferenceToAPercentOfTotalMeasureIsRejected()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total Order Value])");
        var wrapper = ExpressionMeasure("Wrapper", "[Share] * 100");
        var ex = AssertPrepareThrows(SpecFor(wrapper), ModelWith(share, wrapper));

        Assert.Equal("QRY_BAD_MEASURE", ex.Code);
        Assert.Contains("PERCENTOFTOTAL", ex.Message, StringComparison.Ordinal);
    }

    // ---------- metadata threading ----------

    [Fact]
    public void FormatStringThreadsIntoTheColumnPlan()
    {
        var measure = TestFixtures.BuildMeasure("Styled", "public.orders", Aggregation.Sum, "order_total")
            with
        { FormatHint = "currency", FormatString = "$#,##0.00;($#,##0.00)" };
        var demo = TestFixtures.BuildValidDemoModel();
        var model = demo with { Measures = [.. demo.Measures, measure] };

        var compiled = Compile(SpecFor(measure), model);

        var plan = Assert.Single(compiled.Columns);
        Assert.Equal("currency", plan.FormatHint);
        Assert.Equal("$#,##0.00;($#,##0.00)", plan.FormatString);
    }

    // ---------- hostile input through the compile path ----------

    [Theory]
    [InlineData("IF(1 = 1, pg_sleep(10), 0)")]
    [InlineData("COALESCE(count(*), (SELECT 1))")]
    [InlineData("IF(count(*) > 0, 1, 0); DROP TABLE orders")]
    [InlineData("[Total Order Value] || 'x'")]
    [InlineData("count(*) > 0")]
    public void HostileGrammarV2ExpressionsAreQryBadMeasure(string expression)
    {
        var bad = ExpressionMeasure("Bad", expression);
        var ex = AssertPrepareThrows(SpecFor(bad), ModelWith(bad));
        Assert.Equal("QRY_BAD_MEASURE", ex.Code);
    }
}
