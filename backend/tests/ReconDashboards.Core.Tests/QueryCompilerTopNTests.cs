using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Golden-SQL tests for top-N ("top N + Others") emission with the Postgres
/// dialect over the demo catalog. When TopN is set the ranking measure defines
/// the order; explicit Sort specs are ignored.
/// </summary>
public class QueryCompilerTopNTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static MeasureSpec SumOrderTotal() => new(null, "public.orders", "order_total", Aggregation.Sum, null);

    private static MeasureSpec AvgOrderTotal() => new(null, "public.orders", "order_total", Aggregation.Avg, null);

    private static DimensionSpec CustomerRegion() => new("public.customers", "region", null);

    private static ChartQuerySpec Spec(
        TopNSpec? topN,
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<MeasureSpec>? measures = null,
        IReadOnlyList<SortSpec>? sort = null,
        int? limit = null) =>
        new(1, dimensions ?? [CustomerRegion()], measures ?? [SumOrderTotal()], [], sort ?? [], topN, limit);

    private static CompiledQuery Compile(ChartQuerySpec spec)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), limits);
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

    private static void AssertParam(QueryParameter parameter, string name, object? value)
    {
        Assert.Equal(name, parameter.Name);
        Assert.Equal(value, parameter.Value);
        Assert.Equal(NormalizedType.Integer, parameter.Type);
        Assert.False(parameter.IsArray);
    }

    // ---------- without Others ----------

    [Fact]
    public void TopNWithoutOthersOrdersByRankingMeasureWithDimensionTieBreaker()
    {
        var compiled = Compile(Spec(new TopNSpec(5, 0, IncludeOthers: false)));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
ORDER BY "meas0" DESC NULLS LAST, "t1"."region" ASC NULLS LAST
LIMIT @p0
""", compiled);

        var limitParam = Assert.Single(compiled.Parameters);
        AssertParam(limitParam, "p0", 6L); // N + 1 overflow probe
        Assert.Empty(compiled.Warnings);

        // No "Others" bucket -> normal column plan, no is_topn column.
        Assert.Equal(["dim0", "meas0"], compiled.Columns.Select(c => c.Name).ToArray());
    }

    [Fact]
    public void ExplicitSortIsIgnoredWhenTopNIsSet()
    {
        var plain = Compile(Spec(new TopNSpec(5, 0, IncludeOthers: false)));
        var withSort = Compile(Spec(
            new TopNSpec(5, 0, IncludeOthers: false),
            sort: [new SortSpec(new SortTarget(SortTargetKind.Dimension, 0), SortDirection.Asc)]));

        Assert.Equal(plain.Sql, withSort.Sql);
    }

    // ---------- with Others ----------

    [Fact]
    public void TopNWithOthersEmitsRankedCteAndFoldsRemainderIntoOthersBucket()
    {
        var compiled = Compile(Spec(new TopNSpec(5, 0, IncludeOthers: true)));

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
)
SELECT CASE WHEN "rn" <= @p0 THEN "dim0" END AS "dim0",
       ("rn" <= @p0) AS "is_topn",
       SUM("meas0") AS "meas0"
FROM "ranked"
GROUP BY 1, 2
ORDER BY "is_topn" DESC, "meas0" DESC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", 5L);
        AssertParam(compiled.Parameters[1], "p1", 5001L); // min(10000, 5000) + 1
        Assert.Empty(compiled.Warnings);

        // Column plans must match SELECT order: dim0, is_topn, meas0.
        Assert.Equal(["dim0", "is_topn", "meas0"], compiled.Columns.Select(c => c.Name).ToArray());
        var isTop = compiled.Columns[1];
        Assert.Equal("Is Top N", isTop.Label);
        Assert.Equal(ResultColumnRole.Dimension, isTop.Role);
        Assert.Equal(NormalizedType.Boolean, isTop.Type);
        Assert.Null(isTop.Source);

        // Finding 17: the LIMIT's +1 probe row (reachable when n equals the
        // effective cap) must be trimmed like the non-Others path.
        Assert.Equal(5000, compiled.RowLimit);
    }

    [Fact]
    public void NonAdditiveMeasureInOthersPassesTopValuesThroughAndLeavesOthersNull()
    {
        // Avg cannot be re-aggregated: top rows are single-row groups so the
        // CASE/SUM passes their exact value through; the Others row stays NULL.
        var compiled = Compile(Spec(
            new TopNSpec(3, 0, IncludeOthers: true),
            measures: [SumOrderTotal(), AvgOrderTotal()]));

        AssertSql("""
WITH "base" AS (
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0",
       AVG("t0"."order_total") AS "meas1"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
),
"ranked" AS (
SELECT *, ROW_NUMBER() OVER (ORDER BY "meas0" DESC NULLS LAST, "dim0" ASC NULLS LAST) AS "rn"
FROM "base"
)
SELECT CASE WHEN "rn" <= @p0 THEN "dim0" END AS "dim0",
       ("rn" <= @p0) AS "is_topn",
       SUM("meas0") AS "meas0",
       SUM(CASE WHEN "rn" <= @p0 THEN "meas1" END) AS "meas1"
FROM "ranked"
GROUP BY 1, 2
ORDER BY "is_topn" DESC, "meas0" DESC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", 3L);
        AssertParam(compiled.Parameters[1], "p1", 5001L);

        var warning = Assert.Single(compiled.Warnings);
        Assert.Equal("QRY_OTHERS_UNSUPPORTED_AGG", warning.Code);
        Assert.Contains("Avg of order_total", warning.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(Aggregation.StdDev, "StdDev")]
    [InlineData(Aggregation.Variance, "Variance")]
    [InlineData(Aggregation.Median, "Median")]
    public void StatisticalMeasuresInOthersPassTopValuesThroughAndWarn(
        Aggregation aggregation, string expectedName)
    {
        // StdDev/Variance/Median are non-additive like Avg: top rows pass
        // through via SUM over single-row groups, the Others row stays NULL.
        var compiled = Compile(Spec(
            new TopNSpec(3, 0, IncludeOthers: true),
            measures:
            [
                SumOrderTotal(),
                new MeasureSpec(null, "public.orders", "order_total", aggregation, null),
            ]));

        Assert.Contains(
            "SUM(CASE WHEN \"rn\" <= @p0 THEN \"meas1\" END) AS \"meas1\"",
            compiled.Sql, StringComparison.Ordinal);

        var warning = Assert.Single(compiled.Warnings);
        Assert.Equal("QRY_OTHERS_UNSUPPORTED_AGG", warning.Code);
        Assert.Contains(expectedName, warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MinAndMaxMeasuresReAggregateInTheOthersBucket()
    {
        var compiled = Compile(Spec(
            new TopNSpec(5, 0, IncludeOthers: true),
            measures:
            [
                SumOrderTotal(),
                new MeasureSpec(null, "public.orders", "order_total", Aggregation.Min, null),
                new MeasureSpec(null, "public.orders", "order_total", Aggregation.Max, null),
            ]));

        Assert.Contains("MIN(\"meas1\") AS \"meas1\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("MAX(\"meas2\") AS \"meas2\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Empty(compiled.Warnings);
    }

    // ---------- validation and clamping ----------

    [Fact]
    public void TopNWithTwoDimensionsIsRejected()
    {
        var spec = Spec(
            new TopNSpec(5, 0, IncludeOthers: true),
            dimensions: [CustomerRegion(), new DimensionSpec("public.orders", "status", null)]);

        var ex = Assert.Throws<QueryCompilationException>(() => Compile(spec));
        Assert.Equal("QRY_BAD_TOPN", ex.Code);
        Assert.Contains("one dimension", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TopNWithoutAnyDimensionIsRejected()
    {
        var spec = Spec(new TopNSpec(5, 0, IncludeOthers: false), dimensions: []);

        var ex = Assert.Throws<QueryCompilationException>(() => Compile(spec));
        Assert.Equal("QRY_BAD_TOPN", ex.Code);
    }

    [Fact]
    public void TopNRankingMeasureOutOfRangeIsRejected()
    {
        var spec = Spec(new TopNSpec(5, 3, IncludeOthers: false));

        var ex = Assert.Throws<QueryCompilationException>(() => Compile(spec));
        Assert.Equal("QRY_BAD_SORT", ex.Code);
    }

    [Fact]
    public void NBelowOneIsClampedToOne()
    {
        var compiled = Compile(Spec(new TopNSpec(0, 0, IncludeOthers: false)));

        var limitParam = Assert.Single(compiled.Parameters);
        AssertParam(limitParam, "p0", 2L); // clamped N (1) + 1
    }

    [Fact]
    public void NAboveTheEffectiveRowCapIsClampedToTheCap()
    {
        var compiled = Compile(Spec(new TopNSpec(999_999, 0, IncludeOthers: false)));

        var limitParam = Assert.Single(compiled.Parameters);
        AssertParam(limitParam, "p0", 5001L); // clamped N (min(10000, 5000)) + 1
    }
}
