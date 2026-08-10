using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Date tables v2: the extended calendar column set, fiscal/week-start
/// settings (golden SQL for the non-default variants — settings are inlined
/// only as vetted constants while range ends stay parameters), schema
/// synthesis, and MDL015 validation of the new settings.
/// </summary>
public class DateTableV2Tests
{
    private static readonly QueryCompiler Compiler = new(
        new PostgresSqlDialect(),
        new FixedClock(new DateTimeOffset(2026, 6, 15, 12, 0, 0, TimeSpan.Zero)));

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    /// <summary>fiscalYearStartMonth 7, Sunday weeks.</summary>
    private const string FiscalJulySundayBody = """
SELECT d::date AS "date_key",
       EXTRACT(YEAR FROM d)::int AS "year",
       EXTRACT(QUARTER FROM d)::int AS "quarter",
       EXTRACT(MONTH FROM d)::int AS "month",
       TO_CHAR(d, 'Mon') AS "month_name",
       EXTRACT(WEEK FROM d)::int AS "week",
       EXTRACT(DAY FROM d)::int AS "day",
       TO_CHAR(d, 'Dy') AS "day_name",
       TO_CHAR(d, 'FMMonth') AS "month_name_full",
       TO_CHAR(d, 'FMDay') AS "day_name_full",
       (EXTRACT(DOW FROM d)::int + 1) AS "day_of_week",
       EXTRACT(DOY FROM d)::int AS "day_of_year",
       EXTRACT(ISOYEAR FROM d)::int AS "iso_year",
       EXTRACT(WEEK FROM d)::int AS "iso_week",
       (EXTRACT(ISODOW FROM d)::int >= 6) AS "is_weekend",
       TO_CHAR(d, 'YYYY-MM') AS "year_month",
       TO_CHAR(d, 'Mon YYYY') AS "month_year_label",
       TO_CHAR(d, '"Q"Q') AS "quarter_label",
       TO_CHAR(d, 'YYYY-"Q"Q') AS "year_quarter",
       date_trunc('month', d)::date AS "month_start",
       (date_trunc('week', d + interval '1 day')::date - 1) AS "week_start",
       EXTRACT(DAY FROM (date_trunc('month', d) + interval '1 month - 1 day'))::int AS "days_in_month",
       (EXTRACT(YEAR FROM d)::int + CASE WHEN EXTRACT(MONTH FROM d)::int >= 7 THEN 1 ELSE 0 END) AS "fiscal_year",
       ((((EXTRACT(MONTH FROM d)::int - 7 + 12) % 12) / 3) + 1) AS "fiscal_quarter",
       (((EXTRACT(MONTH FROM d)::int - 7 + 12) % 12) + 1) AS "fiscal_month"
FROM generate_series(@p0::timestamp, @p1::timestamp, interval '1 day') AS d
""";

    private static readonly DateTableDef FiscalDates = new(
        "dates", new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31),
        FiscalYearStartMonth: 7, WeekStartDay: WeekStartDay.Sunday);

    private static ModelDefinition OrdersDateModel(DateTableDef dateTable) => TestFixtures.BuildModel(
        tables: [TestFixtures.BuildModelTable("public", "orders")],
        relationships:
        [
            TestFixtures.BuildRelationship("public.orders", "order_date", dateTable.Key, "date_key"),
        ]) with
    { DateTables = [dateTable] };

    private static ChartQuerySpec Spec(params DimensionSpec[] dimensions) =>
        new(1, dimensions,
            [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null)],
            [], [], null, null);

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

    // ---------- schema synthesis ----------

    [Fact]
    public void SynthesizedSchemaExposesTheFullV2ColumnSetInOrder()
    {
        var table = DateTableSchema.Build(new DateTableDef("dates"));

        string[] expected =
        [
            "date_key", "year", "quarter", "month", "month_name", "week", "day", "day_name",
            "month_name_full", "day_name_full", "day_of_week", "day_of_year", "iso_year", "iso_week",
            "is_weekend", "year_month", "month_year_label", "quarter_label", "year_quarter",
            "month_start", "week_start", "days_in_month", "fiscal_year", "fiscal_quarter", "fiscal_month",
        ];
        Assert.Equal(expected, table.Columns.Select(c => c.Name).ToArray());
        Assert.Equal(NormalizedType.Boolean, table.FindColumn("is_weekend")!.Type);
        Assert.Equal(NormalizedType.Date, table.FindColumn("week_start")!.Type);
        Assert.Equal(NormalizedType.Text, table.FindColumn("year_month")!.Type);
        Assert.Equal(NormalizedType.Integer, table.FindColumn("fiscal_month")!.Type);
    }

    // ---------- emission ----------

    [Fact]
    public void FiscalAndSundaySettingsShapeTheCalendarCteWithParameterizedRange()
    {
        var compiled = Compile(
            Spec(new DimensionSpec("#date.dates", "fiscal_year", null), new DimensionSpec("#date.dates", "fiscal_month", null)),
            OrdersDateModel(FiscalDates));

        AssertSql($"""
WITH "dt_dates" AS (
{FiscalJulySundayBody}
)
SELECT "t1"."fiscal_year" AS "dim0",
       "t1"."fiscal_month" AS "dim1",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "dt_dates" AS "t1" ON "t0"."order_date" = "t1"."date_key"
GROUP BY "t1"."fiscal_year", "t1"."fiscal_month"
ORDER BY "t1"."fiscal_year" ASC NULLS LAST, "t1"."fiscal_month" ASC NULLS LAST
LIMIT @p2
""", compiled);

        // Range ends remain parameters even though fiscal/week settings inline.
        Assert.Equal(3, compiled.Parameters.Count);
        Assert.Equal(new DateOnly(2026, 1, 1), compiled.Parameters[0].Value);
        Assert.Equal(new DateOnly(2026, 12, 31), compiled.Parameters[1].Value);
    }

    [Fact]
    public void NewLabelColumnsResolveAsDimensions()
    {
        var compiled = Compile(
            Spec(new DimensionSpec("#date.dates", "year_month", null)),
            OrdersDateModel(new DateTableDef("dates", new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31))));

        Assert.Contains("\"t1\".\"year_month\" AS \"dim0\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal("#date.dates.year_month", compiled.Columns[0].Source);
        Assert.Equal(NormalizedType.Text, compiled.Columns[0].Type);
    }

    [Fact]
    public void InvalidFiscalStartMonthIsRejectedAtCompileTime()
    {
        var ex = Assert.Throws<QueryCompilationException>(() => Compile(
            Spec(new DimensionSpec("#date.dates", "fiscal_year", null)),
            OrdersDateModel(new DateTableDef("dates", FiscalYearStartMonth: 0))));
        Assert.Equal("QRY_BAD_DATE_TABLE", ex.Code);
    }

    // ---------- validation (MDL015-adjacent) ----------

    private static ValidationResult Validate(DateTableDef dateTable)
    {
        var model = OrdersDateModel(dateTable);
        return new SemanticModelValidator().Validate(model, TestFixtures.BuildDemoSchema());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(13)]
    [InlineData(-1)]
    public void FiscalStartMonthOutsideOneToTwelveIsMdl015(int month)
    {
        var result = Validate(new DateTableDef("dates", FiscalYearStartMonth: month));

        // The invalid date table never joins the resolved set, so the
        // relationship endpoint also fails — assert the MDL015 is present.
        Assert.Contains(result.Errors, e => e.Code == "MDL015" && e.Message.Contains("fiscalYearStartMonth", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(12)]
    public void ValidFiscalStartMonthsPass(int month)
    {
        var result = Validate(new DateTableDef("dates", FiscalYearStartMonth: month, WeekStartDay: WeekStartDay.Sunday));

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void UndefinedWeekStartDayEnumValueIsMdl015()
    {
        var result = Validate(new DateTableDef("dates", WeekStartDay: (WeekStartDay)42));

        Assert.Contains(result.Errors, e => e.Code == "MDL015" && e.Message.Contains("weekStartDay", StringComparison.Ordinal));
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
