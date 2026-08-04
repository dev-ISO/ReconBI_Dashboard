using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Golden-SQL tests for calculated (expression) measures over the demo catalog.
/// The exact-statement assertions double as the security proof: emitted SQL
/// contains only dialect-quoted resolved identifiers and validated numeric
/// literals — nothing from the expression string survives verbatim.
/// </summary>
public class QueryCompilerExpressionMeasureTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static Measure ExpressionMeasure(string name, string expression, string? column = null) =>
        new(Guid.NewGuid(), name, "public.orders", Aggregation.Sum, column,
            FormatHint: null, Filters: null, Expression: expression);

    /// <summary>Demo model plus "Order Count" and the given calculated measures.</summary>
    private static ModelDefinition ModelWith(params Measure[] extraMeasures)
    {
        var model = TestFixtures.BuildValidDemoModel();
        var orderCount = TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count);
        return model with { Measures = [.. model.Measures, orderCount, .. extraMeasures] };
    }

    private static ChartQuerySpec SpecFor(Measure measure, IReadOnlyList<DimensionSpec>? dimensions = null, TopNSpec? topN = null) =>
        new(1, dimensions ?? [], [new MeasureSpec(measure.Id, null, null, null, null)], [], [], topN, null);

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

    private static void AssertCompilationError(string code, Measure measure)
    {
        var model = ModelWith(measure);
        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Prepare(SpecFor(measure), model, TestFixtures.BuildDemoSchema(), new RcdLimits()));
        Assert.Equal(code, ex.Code);
    }

    // ---------- emission ----------

    [Fact]
    public void RatioOfMeasureRefsEmitsNullifGuardedDivision()
    {
        var ratio = ExpressionMeasure("Avg Order Value", "[Total Order Value] / [Order Count]");
        var compiled = Compile(SpecFor(ratio), ModelWith(ratio));

        AssertSql("""
SELECT (SUM("t0"."order_total") / NULLIF(COUNT(*), 0)) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);

        var limitParam = Assert.Single(compiled.Parameters);
        Assert.Equal(5001L, limitParam.Value);
    }

    [Fact]
    public void DirectAggregateCallsEmitTheSameShapeAsRefs()
    {
        var ratio = ExpressionMeasure("AOV", "SUM(public.orders.order_total) / COUNT(*)");
        var compiled = Compile(SpecFor(ratio), ModelWith(ratio));

        AssertSql("""
SELECT (SUM("t0"."order_total") / NULLIF(COUNT(*), 0)) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void CrossTableAggregateCallPullsTheOtherTableIntoTheJoinPlan()
    {
        var ratio = ExpressionMeasure(
            "Utilization", "SUM(public.orders.order_total) / SUM(public.customers.credit_limit)");
        var compiled = Compile(SpecFor(ratio), ModelWith(ratio));

        AssertSql("""
SELECT (SUM("t0"."order_total") / NULLIF(SUM("t1"."credit_limit"), 0)) AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void ArithmeticIsParenthesizedPerAstIncludingUnaryMinus()
    {
        var measure = ExpressionMeasure("Odd Math", "-(SUM(public.orders.order_total) + 2) * 3 - 1.5");
        var compiled = Compile(SpecFor(measure), ModelWith(measure));

        AssertSql("""
SELECT (((-(SUM("t0"."order_total") + 2)) * 3) - 1.5) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void MeasureRefSubstitutesTheReferencedMeasuresFilteredAggregate()
    {
        var paid = TestFixtures.BuildMeasure(
            "Paid Total", "public.orders", Aggregation.Sum, "order_total",
            filters:
            [
                new FilterSpec("public.orders", "status", FilterOperator.Eq,
                    [System.Text.Json.JsonSerializer.SerializeToElement("paid")]),
            ]);
        var ratio = ExpressionMeasure("Paid Share", "[Paid Total] / [Total Order Value]");
        var demo = TestFixtures.BuildValidDemoModel();
        var model = demo with { Measures = [.. demo.Measures, paid, ratio] };

        var compiled = Compile(SpecFor(ratio), model);

        AssertSql("""
SELECT (SUM("t0"."order_total") FILTER (WHERE "t0"."status" = @p0) / NULLIF(SUM("t0"."order_total"), 0)) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        Assert.Equal("paid", compiled.Parameters[0].Value);
    }

    [Fact]
    public void GroupedRatioSlotsIntoTheNormalAggregateSelect()
    {
        var ratio = ExpressionMeasure("Avg Order Value", "[Total Order Value] / [Order Count]");
        var compiled = Compile(
            SpecFor(ratio, dimensions: [new DimensionSpec("public.customers", "region", null)]),
            ModelWith(ratio));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       (SUM("t0"."order_total") / NULLIF(COUNT(*), 0)) AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void TopNOthersTreatsExpressionMeasureAsNonAdditive()
    {
        var ratio = ExpressionMeasure("Avg Order Value", "[Total Order Value] / [Order Count]");
        var model = ModelWith(ratio);
        var spec = new ChartQuerySpec(
            1,
            [new DimensionSpec("public.customers", "region", null)],
            [
                new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null),
                new MeasureSpec(ratio.Id, null, null, null, null),
            ],
            [], [], new TopNSpec(2, 0, IncludeOthers: true), null);

        var compiled = Compile(spec, model);

        Assert.Contains(
            "SUM(CASE WHEN \"rn\" <= @p0 THEN \"meas1\" END) AS \"meas1\"",
            compiled.Sql, StringComparison.Ordinal);
        var warning = Assert.Single(compiled.Warnings);
        Assert.Equal("QRY_OTHERS_UNSUPPORTED_AGG", warning.Code);
        Assert.Contains("calculated expression", warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionMeasureColumnPlanIsDecimalWithoutSource()
    {
        var ratio = ExpressionMeasure("Avg Order Value", "[Total Order Value] / [Order Count]");
        var compiled = Compile(SpecFor(ratio), ModelWith(ratio));

        var plan = Assert.Single(compiled.Columns);
        Assert.Equal("meas0", plan.Name);
        Assert.Equal("Avg Order Value", plan.Label);
        Assert.Equal(ResultColumnRole.Measure, plan.Role);
        Assert.Equal(NormalizedType.Decimal, plan.Type);
        Assert.Null(plan.Source);
    }

    // ---------- rejection (security bar) ----------

    [Theory]
    [InlineData("1; DROP TABLE orders")]
    [InlineData("count(*); DELETE FROM orders")]
    [InlineData("sum(public.orders.order_total) UNION SELECT 1")]
    [InlineData("1 + 2")]
    public void UnparsableOrAggregateFreeExpressionsAreRejected(string expression) =>
        AssertCompilationError("QRY_BAD_MEASURE", ExpressionMeasure("Bad", expression));

    [Fact]
    public void NonNumericColumnInSumIsRejected() =>
        AssertCompilationError("QRY_BAD_MEASURE", ExpressionMeasure("Bad", "sum(public.orders.status)"));

    [Fact]
    public void UnknownColumnIsRejected() =>
        AssertCompilationError("QRY_UNKNOWN_COLUMN", ExpressionMeasure("Bad", "sum(public.orders.nope)"));

    [Fact]
    public void TableOutsideTheModelIsRejected() =>
        // public.inspections exists in the catalog but is not part of the model.
        AssertCompilationError("QRY_UNKNOWN_TABLE", ExpressionMeasure("Bad", "sum(public.inspections.id)"));

    [Fact]
    public void UnknownMeasureReferenceIsRejected() =>
        AssertCompilationError("QRY_BAD_MEASURE", ExpressionMeasure("Bad", "[No Such Measure] / count(*)"));

    [Fact]
    public void ReferenceToAnotherExpressionMeasureIsRejected()
    {
        var first = ExpressionMeasure("First", "[Total Order Value] / [Order Count]");
        var second = ExpressionMeasure("Second", "[First] * 2");
        var model = ModelWith(first, second);

        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Prepare(SpecFor(second), model, TestFixtures.BuildDemoSchema(), new RcdLimits()));
        Assert.Equal("QRY_BAD_MEASURE", ex.Code);
        Assert.Contains("itself expression-based", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionMeasureWithColumnSetIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_MEASURE",
            ExpressionMeasure("Bad", "[Total Order Value] / [Order Count]", column: "order_total"));
}
