using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Golden-SQL tests for model-declared virtual date tables: calendar CTE
/// emission with parameterized range, LEFT JOIN on date_key (with timestamp
/// cast), date-table columns as dimensions/filters, and composition with the
/// Top-N CTE and distinct-values paths. The clock is pinned so default ranges
/// are deterministic.
/// </summary>
public class QueryCompilerDateTableTests
{
    /// <summary>Pinned to 2026-06-15 → default range end is 2027-12-31.</summary>
    private static readonly QueryCompiler Compiler = new(
        new PostgresSqlDialect(),
        new FixedClock(new DateTimeOffset(2026, 6, 15, 12, 0, 0, TimeSpan.Zero)));

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private const string CalendarBody = """
SELECT d::date AS "date_key", EXTRACT(YEAR FROM d)::int AS "year", EXTRACT(QUARTER FROM d)::int AS "quarter", EXTRACT(MONTH FROM d)::int AS "month", TO_CHAR(d, 'Mon') AS "month_name", EXTRACT(WEEK FROM d)::int AS "week", EXTRACT(DAY FROM d)::int AS "day", TO_CHAR(d, 'Dy') AS "day_name"
FROM generate_series(@p0::timestamp, @p1::timestamp, interval '1 day') AS d
""";

    private static readonly DateTableDef BoundedDates =
        new("dates", new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31));

    /// <summary>Orders joined onto a date table via order_date (a Date column).</summary>
    private static ModelDefinition OrdersDateModel(DateTableDef dateTable) => TestFixtures.BuildModel(
        tables: [TestFixtures.BuildModelTable("public", "orders")],
        relationships:
        [
            TestFixtures.BuildRelationship("public.orders", "order_date", dateTable.Key, "date_key"),
        ]) with
    { DateTables = [dateTable] };

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec> dimensions,
        IReadOnlyList<FilterSpec>? filters = null,
        TopNSpec? topN = null) =>
        new(1, dimensions,
            [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null)],
            filters ?? [], [], topN, null);

    private static CompiledQuery Compile(ChartQuerySpec spec, ModelDefinition model, DatabaseSchema? schema = null)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, model, schema ?? TestFixtures.BuildDemoSchema(), limits);
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

    private static void AssertDateParam(QueryParameter parameter, string name, DateOnly value)
    {
        Assert.Equal(name, parameter.Name);
        Assert.Equal(value, parameter.Value);
        Assert.Equal(NormalizedType.Date, parameter.Type);
        Assert.False(parameter.IsArray);
    }

    // ---------- emission ----------

    [Fact]
    public void YearMonthRollupEmitsCalendarCteJoinAndGroupBy()
    {
        var compiled = Compile(
            Spec([new DimensionSpec("#date.dates", "year", null), new DimensionSpec("#date.dates", "month", null)]),
            OrdersDateModel(BoundedDates));

        AssertSql($"""
WITH "dt_dates" AS (
{CalendarBody}
)
SELECT "t1"."year" AS "dim0",
       "t1"."month" AS "dim1",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "dt_dates" AS "t1" ON "t0"."order_date" = "t1"."date_key"
GROUP BY "t1"."year", "t1"."month"
ORDER BY "t1"."year" ASC NULLS LAST, "t1"."month" ASC NULLS LAST
LIMIT @p2
""", compiled);

        Assert.Equal(3, compiled.Parameters.Count);
        AssertDateParam(compiled.Parameters[0], "p0", new DateOnly(2026, 1, 1));
        AssertDateParam(compiled.Parameters[1], "p1", new DateOnly(2026, 12, 31));
        Assert.Equal(5001L, compiled.Parameters[2].Value);

        // Column plans resolve against the synthesized date-table schema.
        Assert.Equal("#date.dates.year", compiled.Columns[0].Source);
        Assert.Equal(NormalizedType.Integer, compiled.Columns[0].Type);
        Assert.Equal("#date.dates.month", compiled.Columns[1].Source);
    }

    [Fact]
    public void NullRangeBoundsDefaultFromTheInjectedClock()
    {
        var compiled = Compile(
            Spec([new DimensionSpec("#date.dates", "year", null)]),
            OrdersDateModel(new DateTableDef("dates")));

        AssertDateParam(compiled.Parameters[0], "p0", new DateOnly(2015, 1, 1));
        AssertDateParam(compiled.Parameters[1], "p1", new DateOnly(2027, 12, 31));
    }

    [Fact]
    public void TimestampFromColumnIsCastToDateInTheJoin()
    {
        var demo = TestFixtures.BuildDemoSchema();
        var schema = demo with
        {
            Tables =
            [
                .. demo.Tables,
                TestFixtures.BuildTable(
                    "public", "events",
                    TestFixtures.BuildColumn("id", 1, NormalizedType.Integer),
                    TestFixtures.BuildColumn("created_at", 2, NormalizedType.Timestamp),
                    TestFixtures.BuildColumn("amount", 3, NormalizedType.Decimal)),
            ],
        };

        var model = TestFixtures.BuildModel(
            tables: [TestFixtures.BuildModelTable("public", "events")],
            relationships:
            [
                TestFixtures.BuildRelationship("public.events", "created_at", BoundedDates.Key, "date_key"),
            ]) with
        { DateTables = [BoundedDates] };

        var spec = new ChartQuerySpec(
            1,
            [new DimensionSpec("#date.dates", "month_name", null)],
            [new MeasureSpec(null, "public.events", "amount", Aggregation.Sum, null)],
            [], [], null, null);

        var compiled = Compile(spec, model, schema);

        AssertSql($"""
WITH "dt_dates" AS (
{CalendarBody}
)
SELECT "t1"."month_name" AS "dim0",
       SUM("t0"."amount") AS "meas0"
FROM "public"."events" AS "t0"
LEFT JOIN "dt_dates" AS "t1" ON CAST("t0"."created_at" AS date) = "t1"."date_key"
GROUP BY "t1"."month_name"
ORDER BY "t1"."month_name" ASC NULLS LAST
LIMIT @p2
""", compiled);
    }

    [Fact]
    public void DateTableColumnFilterAndDateKeyBucketCompose()
    {
        var compiled = Compile(
            Spec(
                [new DimensionSpec("#date.dates", "date_key", DateBucket.Month)],
                filters:
                [
                    new FilterSpec("#date.dates", "year", FilterOperator.Eq,
                        [System.Text.Json.JsonSerializer.SerializeToElement(2026)]),
                ]),
            OrdersDateModel(BoundedDates));

        AssertSql($"""
WITH "dt_dates" AS (
{CalendarBody}
)
SELECT date_trunc('month', "t1"."date_key") AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "dt_dates" AS "t1" ON "t0"."order_date" = "t1"."date_key"
WHERE "t1"."year" = @p2
GROUP BY date_trunc('month', "t1"."date_key")
ORDER BY date_trunc('month', "t1"."date_key") ASC NULLS LAST
LIMIT @p3
""", compiled);

        Assert.Equal(2026L, compiled.Parameters[2].Value);
    }

    [Fact]
    public void TopNWithOthersPrependsCalendarCteToTheWithList()
    {
        var compiled = Compile(
            Spec(
                [new DimensionSpec("#date.dates", "month_name", null)],
                topN: new TopNSpec(3, 0, IncludeOthers: true)),
            OrdersDateModel(BoundedDates));

        AssertSql($"""
WITH "dt_dates" AS (
{CalendarBody}
),
"base" AS (
SELECT "t1"."month_name" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "dt_dates" AS "t1" ON "t0"."order_date" = "t1"."date_key"
GROUP BY "t1"."month_name"
),
"ranked" AS (
SELECT *, ROW_NUMBER() OVER (ORDER BY "meas0" DESC NULLS LAST, "dim0" ASC NULLS LAST) AS "rn"
FROM "base"
)
SELECT CASE WHEN "rn" <= @p2 THEN "dim0" END AS "dim0",
       ("rn" <= @p2) AS "is_topn",
       SUM("meas0") AS "meas0"
FROM "ranked"
GROUP BY 1, 2
ORDER BY "is_topn" DESC, "meas0" DESC NULLS LAST
LIMIT @p3
""", compiled);

        Assert.Equal(4, compiled.Parameters.Count);
        AssertDateParam(compiled.Parameters[0], "p0", new DateOnly(2026, 1, 1));
        AssertDateParam(compiled.Parameters[1], "p1", new DateOnly(2026, 12, 31));
        Assert.Equal(3L, compiled.Parameters[2].Value);
        Assert.Equal(5001L, compiled.Parameters[3].Value);
    }

    [Fact]
    public void DistinctValuesOnADateTableColumnSelectsFromTheCte()
    {
        var spec = new DistinctValuesSpec(1, "#date.dates", "month_name", null, [], 25);
        var prepared = Compiler.PrepareDistinct(
            spec, OrdersDateModel(BoundedDates), TestFixtures.BuildDemoSchema(), new RcdLimits());
        var compiled = Compiler.EmitDistinct(prepared, NoRowFilters);

        AssertSql($"""
WITH "dt_dates" AS (
{CalendarBody}
)
SELECT DISTINCT "t0"."month_name" AS "value"
FROM "dt_dates" AS "t0"
ORDER BY "t0"."month_name" ASC NULLS LAST
LIMIT @p2
""", compiled);

        Assert.Equal(3, compiled.Parameters.Count);
        AssertDateParam(compiled.Parameters[0], "p0", new DateOnly(2026, 1, 1));
        AssertDateParam(compiled.Parameters[1], "p1", new DateOnly(2026, 12, 31));
        Assert.Equal(26L, compiled.Parameters[2].Value);
    }

    // ---------- rejection ----------

    [Fact]
    public void UnknownDateTableColumnIsRejected()
    {
        var ex = Assert.Throws<QueryCompilationException>(() => Compile(
            Spec([new DimensionSpec("#date.dates", "fiscal_period", null)]),
            OrdersDateModel(BoundedDates)));
        Assert.Equal("QRY_UNKNOWN_COLUMN", ex.Code);
    }

    [Fact]
    public void UndeclaredDateTableIsRejected()
    {
        var ex = Assert.Throws<QueryCompilationException>(() => Compile(
            Spec([new DimensionSpec("#date.nope", "year", null)]),
            OrdersDateModel(BoundedDates)));
        Assert.Equal("QRY_UNKNOWN_TABLE", ex.Code);
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
