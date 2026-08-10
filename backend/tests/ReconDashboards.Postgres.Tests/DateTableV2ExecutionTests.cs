using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Date-table v2 columns against the real container. Fixed truths: 2026-01-01
/// is a Thursday (ISO year 2026, week 1); 2026-08-09 is a Sunday in Q3; 2026
/// is not a leap year; the 200 seeded orders span 2026-01-01..2026-03-31.
/// Verifies fiscal arithmetic (start month 7), Sunday/Monday week starts,
/// weekday facts, label columns, and that year_month's lexicographic order is
/// chronological.
/// </summary>
[Collection("postgres")]
public sealed class DateTableV2ExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly ExecutionOptions Options = new(MaxRows: 500, TimeoutSeconds: 30);

    /// <summary>Sunday weeks + July fiscal year; "mondays" keeps engine defaults.</summary>
    private static readonly DateTableDef SundayFiscalJuly = new(
        "dates", new DateOnly(2025, 12, 1), new DateOnly(2026, 12, 31),
        FiscalYearStartMonth: 7, WeekStartDay: WeekStartDay.Sunday);

    private static readonly DateTableDef MondayDefault = new(
        "mondays", new DateOnly(2025, 12, 1), new DateOnly(2026, 12, 31));

    private static readonly ModelDefinition Model = new(
        ModelDefinition.CurrentVersion,
        Tables: [new ModelTable("public", "orders")],
        Relationships:
        [
            new Relationship(
                Guid.NewGuid(), "public.orders", "order_date", SundayFiscalJuly.Key, "date_key",
                Cardinality.ManyToOne, IsActive: true, RelationshipSource.Manual),
        ],
        Measures: [],
        DateTables: [SundayFiscalJuly, MondayDefault]);

    private IQueryExecutor Executor()
    {
        var connectionString = new NpgsqlConnectionStringBuilder(fixture.DataSource.ConnectionString)
        {
            Password = "postgres",
        }.ConnectionString;

        var options = new ReconDashboardsOptions();
        options.AddPostgresDataSource("datev2-demo", o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
        });
        var registry = new DataSourceRegistry(options, new NullServices());
        Assert.True(registry.TryGet("datev2-demo", out var source));
        return source.Executor!;
    }

    private sealed class NullServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private CompiledQuery CompileChart(params DimensionSpec[] dimensions)
    {
        var spec = new ChartQuerySpec(
            1, dimensions,
            [new MeasureSpec(null, "public.orders", null, Aggregation.Count, null)],
            [], [], null, null);
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, Model, fixture.RawSchema, limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    /// <summary>One calendar cell: SELECT DISTINCT column WHERE date_key = the given day.</summary>
    private async Task<object?> CalendarCellAsync(string dateTableKey, string column, string isoDate)
    {
        var spec = new DistinctValuesSpec(
            1, dateTableKey, column, null,
            [
                new FilterSpec(dateTableKey, "date_key", FilterOperator.Eq,
                    [System.Text.Json.JsonSerializer.SerializeToElement(isoDate)]),
            ],
            10);
        var prepared = Compiler.PrepareDistinct(spec, Model, fixture.RawSchema, new RcdLimits());
        var compiled = Compiler.EmitDistinct(prepared, NoRowFilters);
        var result = await Executor().ExecuteAsync(compiled, Options, CancellationToken.None);
        var row = Assert.Single(result.Rows);
        return row[0];
    }

    [Fact]
    public async Task YearMonthSortsLexicographicallyEqualsChronologically()
    {
        var result = await Executor().ExecuteAsync(
            CompileChart(new DimensionSpec(SundayFiscalJuly.Key, "year_month", null)), Options, CancellationToken.None);

        var labels = result.Rows.Select(r => (string)r[0]!).ToArray();
        Assert.Equal(["2026-01", "2026-02", "2026-03"], labels);
        Assert.Equal(labels.OrderBy(l => l, StringComparer.Ordinal).ToArray(), labels);
        Assert.Equal(200L, result.Rows.Sum(r => Convert.ToInt64(r[1]!)));
    }

    [Fact]
    public async Task FiscalColumnsFollowTheJulyStart()
    {
        // Jan..Mar 2026 sit in fiscal year 2026 (it ends 2026-06-30), Q3.
        var byFiscalYear = await Executor().ExecuteAsync(
            CompileChart(new DimensionSpec(SundayFiscalJuly.Key, "fiscal_year", null)), Options, CancellationToken.None);
        var yearRow = Assert.Single(byFiscalYear.Rows);
        Assert.Equal(2026, Convert.ToInt32(yearRow[0]!));
        Assert.Equal(200L, Convert.ToInt64(yearRow[1]!));

        var byFiscalQuarter = await Executor().ExecuteAsync(
            CompileChart(new DimensionSpec(SundayFiscalJuly.Key, "fiscal_quarter", null)), Options, CancellationToken.None);
        var quarterRow = Assert.Single(byFiscalQuarter.Rows);
        Assert.Equal(3, Convert.ToInt32(quarterRow[0]!));

        // Per-day spot checks after the fiscal boundary: August 2026 = FY2027 month 2.
        Assert.Equal(2027, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "fiscal_year", "2026-08-09")));
        Assert.Equal(2, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "fiscal_month", "2026-08-09")));
        Assert.Equal(1, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "fiscal_quarter", "2026-08-09")));

        // The default-calendar table always emits fiscal_* too, equal to calendar values.
        Assert.Equal(2026, Convert.ToInt32(await CalendarCellAsync(MondayDefault.Key, "fiscal_year", "2026-08-09")));
        Assert.Equal(8, Convert.ToInt32(await CalendarCellAsync(MondayDefault.Key, "fiscal_month", "2026-08-09")));
        Assert.Equal(3, Convert.ToInt32(await CalendarCellAsync(MondayDefault.Key, "fiscal_quarter", "2026-08-09")));
    }

    [Fact]
    public async Task WeekdayColumnsRespectTheWeekStart()
    {
        // 2026-08-09 is a Sunday.
        Assert.Equal(1, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "day_of_week", "2026-08-09")));
        Assert.Equal(7, Convert.ToInt32(await CalendarCellAsync(MondayDefault.Key, "day_of_week", "2026-08-09")));

        Assert.Equal(new DateOnly(2026, 8, 9), ToDateOnly(await CalendarCellAsync(SundayFiscalJuly.Key, "week_start", "2026-08-09")));
        Assert.Equal(new DateOnly(2026, 8, 3), ToDateOnly(await CalendarCellAsync(MondayDefault.Key, "week_start", "2026-08-09")));

        // Mid-week day (Wednesday 2026-08-12) anchors to the same weeks.
        Assert.Equal(new DateOnly(2026, 8, 9), ToDateOnly(await CalendarCellAsync(SundayFiscalJuly.Key, "week_start", "2026-08-12")));
        Assert.Equal(new DateOnly(2026, 8, 10), ToDateOnly(await CalendarCellAsync(MondayDefault.Key, "week_start", "2026-08-12")));

        // is_weekend is Sat/Sun regardless of week start.
        Assert.Equal(true, await CalendarCellAsync(SundayFiscalJuly.Key, "is_weekend", "2026-08-09"));
        Assert.Equal(false, await CalendarCellAsync(SundayFiscalJuly.Key, "is_weekend", "2026-08-12"));
    }

    [Fact]
    public async Task LabelAndAnchorColumnsAreDeterministic()
    {
        Assert.Equal("August", await CalendarCellAsync(SundayFiscalJuly.Key, "month_name_full", "2026-08-09"));
        Assert.Equal("Sunday", await CalendarCellAsync(SundayFiscalJuly.Key, "day_name_full", "2026-08-09"));
        Assert.Equal("Aug 2026", await CalendarCellAsync(SundayFiscalJuly.Key, "month_year_label", "2026-08-09"));
        Assert.Equal("Q3", await CalendarCellAsync(SundayFiscalJuly.Key, "quarter_label", "2026-08-09"));
        Assert.Equal("2026-Q3", await CalendarCellAsync(SundayFiscalJuly.Key, "year_quarter", "2026-08-09"));
        Assert.Equal(new DateOnly(2026, 8, 1), ToDateOnly(await CalendarCellAsync(SundayFiscalJuly.Key, "month_start", "2026-08-09")));
        Assert.Equal(28, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "days_in_month", "2026-02-15")));
        Assert.Equal(31, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "days_in_month", "2026-08-09")));
    }

    [Fact]
    public async Task IsoColumnsMatchTheKnownCalendar()
    {
        // 2026-01-01 is a Thursday: ISO year 2026, ISO week 1, day-of-year 1.
        Assert.Equal(2026, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "iso_year", "2026-01-01")));
        Assert.Equal(1, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "iso_week", "2026-01-01")));
        Assert.Equal(1, Convert.ToInt32(await CalendarCellAsync(SundayFiscalJuly.Key, "day_of_year", "2026-01-01")));
    }

    private static DateOnly ToDateOnly(object? value) => value switch
    {
        DateOnly date => date,
        DateTime dateTime => DateOnly.FromDateTime(dateTime),
        string text => DateOnly.Parse(text, System.Globalization.CultureInfo.InvariantCulture),
        _ => throw new InvalidOperationException($"Unexpected date value {value?.GetType().Name}: {value}"),
    };
}
