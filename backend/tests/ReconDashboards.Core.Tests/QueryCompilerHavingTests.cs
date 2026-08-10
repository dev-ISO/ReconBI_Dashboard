using System.Text.Json;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Golden-SQL tests for post-aggregation HAVING: conditions attach to the
/// GROUP BY stage by repeating the targeted measure's aggregate expression
/// (never the select alias), values bind as decimal parameters, and the clause
/// composes with Top-N (base grouped stage, before ranking), window calcs
/// (pre-calc base aggregate) and the 0-dimension KPI shape (no GROUP BY,
/// HAVING on the global aggregate).
/// </summary>
public class QueryCompilerHavingTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static MeasureSpec SumOrderTotal(MeasureCalcSpec? calc = null) =>
        new(null, "public.orders", "order_total", Aggregation.Sum, null, calc);

    private static MeasureSpec CountOrders() => new(null, "public.orders", null, Aggregation.Count, null);

    private static DimensionSpec CustomerRegion() => new("public.customers", "region", null);

    private static HavingSpec Having(HavingOperator op, params double[] values) => new(0, op, values);

    private static ChartQuerySpec Spec(
        IReadOnlyList<HavingSpec>? having,
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<MeasureSpec>? measures = null,
        TopNSpec? topN = null) =>
        new(1, dimensions ?? [CustomerRegion()], measures ?? [SumOrderTotal()], [], [], topN, null, null, having);

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

    private static void AssertParam(
        QueryParameter parameter, string name, object? value, NormalizedType type)
    {
        Assert.Equal(name, parameter.Name);
        Assert.Equal(value, parameter.Value);
        Assert.Equal(type, parameter.Type);
        Assert.False(parameter.IsArray);
    }

    private static void AssertCompilationError(string code, ChartQuerySpec spec)
    {
        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Prepare(spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), new RcdLimits()));
        Assert.Equal(code, ex.Code);
    }

    // ---------- basic emission ----------

    [Fact]
    public void GroupedHavingGtRepeatsTheAggregateExpressionNotTheAlias()
    {
        var compiled = Compile(Spec([Having(HavingOperator.Gt, 100)]));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING SUM("t0"."order_total") > @p0
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", 100m, NormalizedType.Decimal);
        AssertParam(compiled.Parameters[1], "p1", 5001L, NormalizedType.Integer);
        Assert.Empty(compiled.Warnings);
    }

    [Theory]
    [InlineData(HavingOperator.Gte, ">=")]
    [InlineData(HavingOperator.Lt, "<")]
    [InlineData(HavingOperator.Lte, "<=")]
    [InlineData(HavingOperator.Eq, "=")]
    [InlineData(HavingOperator.Neq, "<>")]
    public void EachSingleValueOperatorEmitsItsComparison(HavingOperator op, string symbol)
    {
        var compiled = Compile(Spec([Having(op, 42.5)]));

        Assert.Contains(
            $"\nHAVING SUM(\"t0\".\"order_total\") {symbol} @p0\n",
            compiled.Sql, StringComparison.Ordinal);
        AssertParam(compiled.Parameters[0], "p0", 42.5m, NormalizedType.Decimal);
    }

    [Fact]
    public void BetweenBindsInclusiveLowerAndUpperBounds()
    {
        var compiled = Compile(Spec([Having(HavingOperator.Between, 10, 100)]));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING (SUM("t0"."order_total") >= @p0 AND SUM("t0"."order_total") <= @p1)
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p2
""", compiled);

        Assert.Equal(3, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", 10m, NormalizedType.Decimal);
        AssertParam(compiled.Parameters[1], "p1", 100m, NormalizedType.Decimal);
    }

    [Fact]
    public void MultipleConditionsAreAnded()
    {
        var compiled = Compile(Spec(
            having:
            [
                new HavingSpec(0, HavingOperator.Gt, [100]),
                new HavingSpec(1, HavingOperator.Gte, [5]),
            ],
            measures: [SumOrderTotal(), CountOrders()]));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0",
       COUNT(*) AS "meas1"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING SUM("t0"."order_total") > @p0
   AND COUNT(*) >= @p1
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p2
""", compiled);

        AssertParam(compiled.Parameters[0], "p0", 100m, NormalizedType.Decimal);
        AssertParam(compiled.Parameters[1], "p1", 5m, NormalizedType.Decimal);
    }

    // ---------- 0-dimension (KPI / alert) shape ----------

    [Fact]
    public void KpiWithoutDimensionsEmitsHavingOnTheGlobalAggregateWithoutGroupBy()
    {
        var compiled = Compile(Spec([Having(HavingOperator.Gt, 1000)], dimensions: []));

        AssertSql("""
SELECT SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
HAVING SUM("t0"."order_total") > @p0
LIMIT @p1
""", compiled);

        Assert.DoesNotContain("GROUP BY", compiled.Sql, StringComparison.Ordinal);
        AssertParam(compiled.Parameters[0], "p0", 1000m, NormalizedType.Decimal);
    }

    // ---------- composition: measure filters, expression measures ----------

    [Fact]
    public void MeasureFilterAggregateIsRepeatedVerbatimReusingItsPlaceholder()
    {
        var measure = TestFixtures.BuildMeasure(
            "Paid Total", "public.orders", Aggregation.Sum, "order_total",
            filters: [new FilterSpec("public.orders", "status", FilterOperator.Eq, [Json("paid")])]);
        var model = TestFixtures.BuildValidDemoModel() with { Measures = [measure] };

        var compiled = Compile(
            Spec([Having(HavingOperator.Gt, 100)],
                dimensions: [],
                measures: [new MeasureSpec(measure.Id, null, null, null, null)]),
            model);

        AssertSql("""
SELECT SUM("t0"."order_total") FILTER (WHERE "t0"."status" = @p0) AS "meas0"
FROM "public"."orders" AS "t0"
HAVING SUM("t0"."order_total") FILTER (WHERE "t0"."status" = @p0) > @p1
LIMIT @p2
""", compiled);

        // The FILTER placeholder is reused, not re-bound: 3 parameters total.
        Assert.Equal(3, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", "paid", NormalizedType.Text);
        AssertParam(compiled.Parameters[1], "p1", 100m, NormalizedType.Decimal);
    }

    [Fact]
    public void ExpressionMeasureHavingRepeatsTheWholeExpression()
    {
        var ratio = new Measure(
            Guid.NewGuid(), "Avg Order Value", "public.orders", Aggregation.Sum, null,
            FormatHint: null, Filters: null, Expression: "SUM(public.orders.order_total) / COUNT(*)");
        var model = TestFixtures.BuildValidDemoModel() with { Measures = [ratio] };

        var compiled = Compile(
            Spec([Having(HavingOperator.Gte, 25)],
                measures: [new MeasureSpec(ratio.Id, null, null, null, null)]),
            model);

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       (SUM("t0"."order_total") / NULLIF(COUNT(*), 0)) AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING (SUM("t0"."order_total") / NULLIF(COUNT(*), 0)) >= @p0
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p1
""", compiled);
    }

    // ---------- composition: Top-N ----------

    [Fact]
    public void TopNWithoutOthersAppliesHavingBeforeRanking()
    {
        var compiled = Compile(Spec(
            [Having(HavingOperator.Gt, 100)],
            topN: new TopNSpec(5, 0, IncludeOthers: false)));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING SUM("t0"."order_total") > @p0
ORDER BY "meas0" DESC NULLS LAST, "t1"."region" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", 100m, NormalizedType.Decimal);
        AssertParam(compiled.Parameters[1], "p1", 6L, NormalizedType.Integer); // N + 1
    }

    [Fact]
    public void TopNWithOthersAppliesHavingInsideTheBaseCteBeforeRowNumber()
    {
        var compiled = Compile(Spec(
            [Having(HavingOperator.Gt, 100)],
            topN: new TopNSpec(5, 0, IncludeOthers: true)));

        AssertSql("""
WITH "base" AS (
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING SUM("t0"."order_total") > @p0
),
"ranked" AS (
SELECT *, ROW_NUMBER() OVER (ORDER BY "meas0" DESC NULLS LAST, "dim0" ASC NULLS LAST) AS "rn"
FROM "base"
)
SELECT CASE WHEN "rn" <= @p1 THEN "dim0" END AS "dim0",
       ("rn" <= @p1) AS "is_topn",
       SUM("meas0") AS "meas0"
FROM "ranked"
GROUP BY 1, 2
ORDER BY "is_topn" DESC, "meas0" DESC NULLS LAST
LIMIT @p2
""", compiled);

        Assert.Equal(3, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", 100m, NormalizedType.Decimal);
        AssertParam(compiled.Parameters[1], "p1", 5L, NormalizedType.Integer);
    }

    // ---------- composition: window calcs ----------

    [Fact]
    public void CalcMeasureHavingAppliesToThePreCalcBaseAggregate()
    {
        // HAVING lives in the __rcd_base CTE: it filters on the RAW aggregate,
        // never on the window result (window functions can't appear in HAVING).
        var compiled = Compile(Spec(
            [Having(HavingOperator.Gt, 100)],
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))]));

        AssertSql("""
WITH "__rcd_base" AS (
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING SUM("t0"."order_total") > @p0
)
SELECT "dim0",
       SUM("meas0") OVER (ORDER BY "dim0" ASC NULLS LAST ROWS UNBOUNDED PRECEDING) AS "meas0"
FROM "__rcd_base"
ORDER BY "dim0" ASC NULLS LAST
LIMIT @p1
""", compiled);

        AssertParam(compiled.Parameters[0], "p0", 100m, NormalizedType.Decimal);
    }

    // ---------- membership (in / notIn) ----------

    [Fact]
    public void InBindsTheValueListAsOneDecimalArrayParameter()
    {
        var compiled = Compile(Spec([Having(HavingOperator.In, 5, 10, 17.5)]));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
HAVING SUM("t0"."order_total") = ANY(@p0)
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        var list = compiled.Parameters[0];
        Assert.Equal("p0", list.Name);
        Assert.True(list.IsArray);
        Assert.Equal(NormalizedType.Decimal, list.Type);
        Assert.Equal(new object?[] { 5m, 10m, 17.5m }, list.Value);
    }

    [Fact]
    public void NotInIsTheExactComplementAndKeepsNullAggregates()
    {
        var compiled = Compile(Spec([Having(HavingOperator.NotIn, 5, 10)]));

        Assert.Contains(
            "\nHAVING (SUM(\"t0\".\"order_total\") <> ALL(@p0) OR SUM(\"t0\".\"order_total\") IS NULL)\n",
            compiled.Sql, StringComparison.Ordinal);
        var list = compiled.Parameters[0];
        Assert.True(list.IsArray);
        Assert.Equal(new object?[] { 5m, 10m }, list.Value);
    }

    [Fact]
    public void InWithASingleValueStillUsesTheMembershipShape()
    {
        var compiled = Compile(Spec([Having(HavingOperator.In, 42)]));

        Assert.Contains(
            "\nHAVING SUM(\"t0\".\"order_total\") = ANY(@p0)\n",
            compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void WireNamesInAndNotInDeserializeOntoTheEnum()
    {
        const string json = """
            {"modelId":1,"dimensions":[],"measures":[],"filters":[],"sort":[],
             "having":[{"measureIndex":0,"operator":"in","values":[1,2]},
                       {"measureIndex":0,"operator":"notIn","values":[3]}]}
            """;
        var spec = JsonSerializer.Deserialize<ChartQuerySpec>(
            json, new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.NotNull(spec?.Having);
        Assert.Equal(HavingOperator.In, spec!.Having![0].Operator);
        Assert.Equal([1d, 2d], spec.Having[0].Values);
        Assert.Equal(HavingOperator.NotIn, spec.Having[1].Operator);
        Assert.Equal([3d], spec.Having[1].Values);
    }

    // ---------- validation ----------

    [Theory]
    [InlineData(-1)]
    [InlineData(1)]
    public void MeasureIndexOutOfRangeIsRejected(int index) =>
        AssertCompilationError(
            "QRY_BAD_HAVING",
            Spec([new HavingSpec(index, HavingOperator.Gt, [1])]));

    [Fact]
    public void UnknownOperatorIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_HAVING",
            Spec([new HavingSpec(0, (HavingOperator)99, [1])]));

    [Fact]
    public void BetweenWithOneValueIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_HAVING",
            Spec([Having(HavingOperator.Between, 10)]));

    [Fact]
    public void SingleValueOperatorWithTwoValuesIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_HAVING",
            Spec([Having(HavingOperator.Gt, 1, 2)]));

    [Fact]
    public void EmptyValuesAreRejected() =>
        AssertCompilationError(
            "QRY_BAD_HAVING",
            Spec([new HavingSpec(0, HavingOperator.Eq, [])]));

    [Theory]
    [InlineData(HavingOperator.In)]
    [InlineData(HavingOperator.NotIn)]
    public void EmptyMembershipListsAreRejected(HavingOperator op) =>
        AssertCompilationError(
            "QRY_BAD_HAVING",
            Spec([new HavingSpec(0, op, [])]));

    [Fact]
    public void MembershipListsPastMaxInValuesAreRejected() =>
        AssertCompilationError(
            "QRY_TOO_MANY_VALUES",
            Spec([new HavingSpec(
                0, HavingOperator.In,
                [.. Enumerable.Range(0, new RcdLimits().MaxInValues + 1).Select(i => (double)i)])]));

    [Fact]
    public void MembershipListsUpToMaxInValuesCompile()
    {
        var values = Enumerable.Range(0, new RcdLimits().MaxInValues).Select(i => (double)i).ToArray();
        var compiled = Compile(Spec([new HavingSpec(0, HavingOperator.In, values)]));
        Assert.Contains("= ANY(", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void NonFiniteMembershipValuesAreRejected() =>
        AssertCompilationError(
            "QRY_BAD_HAVING_VALUE",
            Spec([new HavingSpec(0, HavingOperator.In, [1, double.NaN])]));

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    [InlineData(1e300)] // finite but outside decimal range
    public void NonFiniteOrUnrepresentableValuesAreRejected(double value) =>
        AssertCompilationError(
            "QRY_BAD_HAVING_VALUE",
            Spec([Having(HavingOperator.Gt, value)]));

    [Fact]
    public void NullHavingCompilesExactlyLikeBefore()
    {
        var withNull = Compile(Spec(having: null));
        var withEmpty = Compile(Spec(having: []));

        Assert.DoesNotContain("HAVING", withNull.Sql, StringComparison.Ordinal);
        Assert.Equal(withNull.Sql, withEmpty.Sql);
    }
}
