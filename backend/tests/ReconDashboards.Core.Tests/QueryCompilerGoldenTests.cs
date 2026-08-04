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
/// Golden-SQL tests: exact statement text and parameter lists produced by the
/// QueryCompiler with the Postgres dialect over the demo catalog
/// (orders many-to-one customers). The dialect is pure, so no database is needed.
/// </summary>
public class QueryCompilerGoldenTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static MeasureSpec SumOrderTotal() => new(null, "public.orders", "order_total", Aggregation.Sum, null);

    private static MeasureSpec CountOrders() => new(null, "public.orders", null, Aggregation.Count, null);

    private static DimensionSpec CustomerRegion() => new("public.customers", "region", null);

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<MeasureSpec>? measures = null,
        IReadOnlyList<FilterSpec>? filters = null,
        IReadOnlyList<SortSpec>? sort = null,
        int? limit = null) =>
        new(1, dimensions ?? [], measures ?? [SumOrderTotal()], filters ?? [], sort ?? [], null, limit);

    private static CompiledQuery Compile(
        ChartQuerySpec spec,
        ModelDefinition? model = null,
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>>? rowFilters = null,
        RcdLimits? limits = null,
        DataSourceOptions? sourceOptions = null)
    {
        model ??= TestFixtures.BuildValidDemoModel();
        limits ??= new RcdLimits();
        var prepared = Compiler.Prepare(spec, model, TestFixtures.BuildDemoSchema(), limits);
        return Compiler.Emit(prepared, spec, rowFilters ?? NoRowFilters, limits, sourceOptions ?? new DataSourceOptions());
    }

    /// <summary>Ordinal comparison with a full-text diff dump (xunit truncates long strings).</summary>
    private static void AssertSql(string expected, CompiledQuery compiled)
    {
        expected = expected.ReplaceLineEndings("\n");
        if (!string.Equals(expected, compiled.Sql, StringComparison.Ordinal))
        {
            Assert.Fail($"SQL mismatch.\n--- expected ---\n{expected}\n--- actual ---\n{compiled.Sql}\n--- end ---");
        }
    }

    private static void AssertParam(
        QueryParameter parameter, string name, object? value, NormalizedType type, bool isArray = false)
    {
        Assert.Equal(name, parameter.Name);
        Assert.Equal(value, parameter.Value);
        Assert.Equal(type, parameter.Type);
        Assert.Equal(isArray, parameter.IsArray);
    }

    private static void AssertCompilationError(string code, ChartQuerySpec spec, RcdLimits? limits = null)
    {
        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Prepare(spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), limits ?? new RcdLimits()));
        Assert.Equal(code, ex.Code);
    }

    // ---------- shape ----------

    [Fact]
    public void GroupedSumOverJoinProducesCanonicalSelect()
    {
        // Base table is the first measure's table (orders); customers joins on.
        var compiled = Compile(Spec(dimensions: [CustomerRegion()]));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p0
""", compiled);

        var limitParam = Assert.Single(compiled.Parameters);
        AssertParam(limitParam, "p0", 5001L, NormalizedType.Integer); // min(10000, 5000) + 1
    }

    [Fact]
    public void KpiWithoutDimensionsHasNoGroupByOrOrderBy()
    {
        var compiled = Compile(Spec(measures: [CountOrders()]));

        AssertSql("""
SELECT COUNT(*) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p0
""", compiled);

        Assert.DoesNotContain("GROUP BY", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("ORDER BY", compiled.Sql, StringComparison.Ordinal);
        var limitParam = Assert.Single(compiled.Parameters);
        AssertParam(limitParam, "p0", 5001L, NormalizedType.Integer);
    }

    [Fact]
    public void MonthBucketWrapsDateTruncInSelectGroupByAndOrderBy()
    {
        var compiled = Compile(Spec(
            dimensions: [new DimensionSpec("public.orders", "order_date", DateBucket.Month)]));

        AssertSql("""
SELECT date_trunc('month', "t0"."order_date") AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
GROUP BY date_trunc('month', "t0"."order_date")
ORDER BY date_trunc('month', "t0"."order_date") ASC NULLS LAST
LIMIT @p0
""", compiled);
    }

    // ---------- filters ----------

    [Fact]
    public void EqFilterIsParameterized()
    {
        var compiled = Compile(Spec(
            measures: [CountOrders()],
            filters: [new FilterSpec("public.orders", "status", FilterOperator.Eq, [Json("open")])]));

        AssertSql("""
SELECT COUNT(*) AS "meas0"
FROM "public"."orders" AS "t0"
WHERE "t0"."status" = @p0
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", "open", NormalizedType.Text);
        AssertParam(compiled.Parameters[1], "p1", 5001L, NormalizedType.Integer);
    }

    [Fact]
    public void InFilterBindsOneArrayParameter()
    {
        var compiled = Compile(Spec(
            measures: [CountOrders()],
            filters: [new FilterSpec("public.orders", "status", FilterOperator.In, [Json("open"), Json("closed")])]));

        AssertSql("""
SELECT COUNT(*) AS "meas0"
FROM "public"."orders" AS "t0"
WHERE "t0"."status" = ANY(@p0)
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        var arrayParam = compiled.Parameters[0];
        Assert.Equal("p0", arrayParam.Name);
        Assert.True(arrayParam.IsArray);
        Assert.Equal(NormalizedType.Text, arrayParam.Type);
        var values = Assert.IsAssignableFrom<IReadOnlyList<object?>>(arrayParam.Value);
        Assert.Equal(new object?[] { "open", "closed" }, values);
        AssertParam(compiled.Parameters[1], "p1", 5001L, NormalizedType.Integer);
    }

    [Fact]
    public void BetweenFilterBindsLowerAndUpperBounds()
    {
        var compiled = Compile(Spec(
            measures: [CountOrders()],
            filters: [new FilterSpec("public.orders", "order_total", FilterOperator.Between, [Json(10), Json(100)])]));

        AssertSql("""
SELECT COUNT(*) AS "meas0"
FROM "public"."orders" AS "t0"
WHERE ("t0"."order_total" >= @p0 AND "t0"."order_total" <= @p1)
LIMIT @p2
""", compiled);

        Assert.Equal(3, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", 10m, NormalizedType.Decimal);
        AssertParam(compiled.Parameters[1], "p1", 100m, NormalizedType.Decimal);
        AssertParam(compiled.Parameters[2], "p2", 5001L, NormalizedType.Integer);
    }

    [Fact]
    public void ContainsFilterEscapesLikeWildcardsInsideTheParameter()
    {
        // "50%_off" contains both LIKE wildcards; they must be escaped in the
        // bound pattern, never interpreted.
        var compiled = Compile(Spec(
            measures: [CountOrders()],
            filters: [new FilterSpec("public.orders", "status", FilterOperator.Contains, [Json("50%_off")])]));

        AssertSql("""
SELECT COUNT(*) AS "meas0"
FROM "public"."orders" AS "t0"
WHERE "t0"."status" ILIKE @p0 ESCAPE '\'
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", "%50\\%\\_off%", NormalizedType.Text);
        AssertParam(compiled.Parameters[1], "p1", 5001L, NormalizedType.Integer);
    }

    [Fact]
    public void IsNullFilterBindsNoParameter()
    {
        var compiled = Compile(Spec(
            measures: [CountOrders()],
            filters: [new FilterSpec("public.orders", "customer_id", FilterOperator.IsNull, [])]));

        AssertSql("""
SELECT COUNT(*) AS "meas0"
FROM "public"."orders" AS "t0"
WHERE "t0"."customer_id" IS NULL
LIMIT @p0
""", compiled);

        var limitParam = Assert.Single(compiled.Parameters);
        AssertParam(limitParam, "p0", 5001L, NormalizedType.Integer);
    }

    [Fact]
    public void MeasureFilterWrapsAggregateInFilterWhere()
    {
        var measure = TestFixtures.BuildMeasure(
            "Paid Total", "public.orders", Aggregation.Sum, "order_total",
            filters: [new FilterSpec("public.orders", "status", FilterOperator.Eq, [Json("paid")])]);
        var model = TestFixtures.BuildValidDemoModel() with { Measures = [measure] };

        var compiled = Compile(
            Spec(measures: [new MeasureSpec(measure.Id, null, null, null, null)]),
            model);

        AssertSql("""
SELECT SUM("t0"."order_total") FILTER (WHERE "t0"."status" = @p0) AS "meas0"
FROM "public"."orders" AS "t0"
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", "paid", NormalizedType.Text);
        AssertParam(compiled.Parameters[1], "p1", 5001L, NormalizedType.Integer);
    }

    [Fact]
    public void RowFilterOnJoinedTableIsAndedIntoWhereWithItsAlias()
    {
        var rowFilters = new Dictionary<string, IReadOnlyList<RowFilter>>
        {
            ["public.customers"] = [new RowFilter("region", RowFilterOperator.Equals, ["West"])],
        };

        var compiled = Compile(Spec(dimensions: [CustomerRegion()]), rowFilters: rowFilters);

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
WHERE "t1"."region" = @p0
GROUP BY "t1"."region"
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", "West", NormalizedType.Text);
        AssertParam(compiled.Parameters[1], "p1", 5001L, NormalizedType.Integer);
    }

    // ---------- ordering and limits ----------

    [Fact]
    public void ExplicitMeasureSortAddsDimensionTieBreaker()
    {
        var compiled = Compile(Spec(
            dimensions: [CustomerRegion()],
            sort: [new SortSpec(new SortTarget(SortTargetKind.Measure, 0), SortDirection.Desc)]));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
ORDER BY "meas0" DESC NULLS LAST, "t1"."region" ASC NULLS LAST
LIMIT @p0
""", compiled);
    }

    [Fact]
    public void RequestedLimitIsClampedToTheSmallerOfEngineAndSourceCaps()
    {
        var limits = new RcdLimits { MaxRows = 100 };
        var sourceOptions = new DataSourceOptions { MaxRows = 50 };

        var compiled = Compile(
            Spec(measures: [CountOrders()], limit: 9999),
            limits: limits,
            sourceOptions: sourceOptions);

        var limitParam = Assert.Single(compiled.Parameters);
        AssertParam(limitParam, "p0", 51L, NormalizedType.Integer); // min(100, 50) + 1
    }

    // ---------- rejection ----------

    [Fact]
    public void ZeroMeasuresIsRejected() =>
        AssertCompilationError("QRY_NO_MEASURES", Spec(measures: []));

    [Fact]
    public void UnknownColumnIsRejected() =>
        AssertCompilationError(
            "QRY_UNKNOWN_COLUMN",
            Spec(dimensions: [new DimensionSpec("public.customers", "nope", null)]));

    [Fact]
    public void DateBucketOnTextColumnIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_BUCKET",
            Spec(dimensions: [new DimensionSpec("public.orders", "status", DateBucket.Month)]));

    [Fact]
    public void ContainsOnIntegerColumnIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_FILTER",
            Spec(filters: [new FilterSpec("public.orders", "customer_id", FilterOperator.Contains, [Json("x")])]));

    [Fact]
    public void BetweenWithOneValueIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_FILTER",
            Spec(filters: [new FilterSpec("public.orders", "order_total", FilterOperator.Between, [Json(10)])]));

    [Fact]
    public void SumOverTextColumnIsRejected() =>
        AssertCompilationError(
            "QRY_BAD_MEASURE",
            Spec(measures: [new MeasureSpec(null, "public.orders", "status", Aggregation.Sum, null)]));

    [Fact]
    public void TooManyInValuesIsRejected() =>
        AssertCompilationError(
            "QRY_TOO_MANY_VALUES",
            Spec(filters: [new FilterSpec("public.orders", "status", FilterOperator.In, [Json("a"), Json("b"), Json("c")])]),
            new RcdLimits { MaxInValues = 2 });

    // ---------- distinct values ----------

    [Fact]
    public void DistinctValuesQueryEmitsSelectDistinctWithSearchPattern()
    {
        var spec = new DistinctValuesSpec(1, "public.customers", "region", "we", [], 25);

        var prepared = Compiler.PrepareDistinct(
            spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), new RcdLimits());
        var compiled = Compiler.EmitDistinct(prepared, NoRowFilters);

        AssertSql("""
SELECT DISTINCT "t0"."region" AS "value"
FROM "public"."customers" AS "t0"
WHERE "t0"."region" ILIKE @p0 ESCAPE '\'
ORDER BY "t0"."region" ASC NULLS LAST
LIMIT @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        AssertParam(compiled.Parameters[0], "p0", "%we%", NormalizedType.Text);
        AssertParam(compiled.Parameters[1], "p1", 26L, NormalizedType.Integer); // limit 25 + 1 overflow probe
    }
}
