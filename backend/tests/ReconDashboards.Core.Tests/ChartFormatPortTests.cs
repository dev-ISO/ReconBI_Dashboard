using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Rendering;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The C# ports that make a server-rendered email chart say what the screen
/// says: palette.ts, format.ts, ordering.ts, and dataLabels.ts. The cases below
/// mirror the frontend's own vitest suites (util/format.test.ts,
/// util/ordering.test.ts, util/dataLabels.test.ts) case for case, plus the
/// Excel-pattern cases only the backend exercises. When either side changes,
/// BOTH suites must move together — that lockstep is the feature.
/// </summary>
public class ChartFormatPortTests
{
    private static ResultColumnPlan Column(
        NormalizedType type = NormalizedType.Decimal,
        DateBucket? bucket = null,
        string? formatHint = null,
        string? formatString = null,
        ResultColumnRole role = ResultColumnRole.Measure) =>
        new("dim0", "Value", role, type, "public.orders.order_total", bucket, formatHint, formatString);

    // ------------------------------------------------------------- palette

    [Fact]
    public void DefaultThemeIsThePrintViewsEightLightCategoricalTokens()
    {
        // DashboardPrintView LIGHT_TOKENS --rcd-cat-1..8, in order.
        Assert.Equal(
            ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
            ChartPalette.DefaultTheme);
        Assert.Equal("#2a78d6", ChartPalette.SeriesColor(0));
        Assert.Equal("#e34948", ChartPalette.SeriesColor(7));
    }

    [Fact]
    public void SeriesColorWrapsAtEightSlotsAndNeverThrowsOnNegativeIndexes()
    {
        Assert.Equal(ChartPalette.SeriesColor(0), ChartPalette.SeriesColor(8));
        Assert.Equal(ChartPalette.SeriesColor(1), ChartPalette.SeriesColor(9));
        // Defensive: a caller-side sign slip must still land on a real hue.
        Assert.Equal(ChartPalette.SeriesColor(7), ChartPalette.SeriesColor(-1));
    }

    [Fact]
    public void NamedThemesCarryTheFrontendsLiteralHex()
    {
        Assert.Equal("#1868ae", ChartPalette.SeriesColor(0, theme: "ocean"));
        Assert.Equal("#f2542d", ChartPalette.SeriesColor(0, theme: "sunset"));
        Assert.Equal("#2d6a4f", ChartPalette.SeriesColor(0, theme: "forest"));
        Assert.Equal("#7b2cbf", ChartPalette.SeriesColor(0, theme: "berry"));
        Assert.Equal("#1f2937", ChartPalette.SeriesColor(0, theme: "mono"));
        Assert.All(ChartPalette.Themes.Values, palette => Assert.Equal(8, palette.Count));
        // An unknown theme name falls back to the default palette, never throws.
        Assert.Equal(ChartPalette.SeriesColor(2), ChartPalette.SeriesColor(2, theme: "no-such-theme"));
    }

    [Fact]
    public void ColorOverridesWinPerSeriesOverBothTheThemeAndTheSlot()
    {
        var overrides = new Dictionary<string, string> { ["West"] = "#123456" };
        Assert.Equal("#123456", ChartPalette.SeriesColor(3, "West", overrides, "ocean"));
        // A different series key is untouched, and a blank override is ignored.
        Assert.Equal(ChartPalette.SeriesColor(3, theme: "ocean"), ChartPalette.SeriesColor(3, "East", overrides, "ocean"));
        Assert.Equal(
            ChartPalette.SeriesColor(0),
            ChartPalette.SeriesColor(0, "West", new Dictionary<string, string> { ["West"] = "  " }));
    }

    // ------------------------------------------------------------- ordering
    // Ported one-for-one from util/ordering.test.ts.

    [Fact]
    public void ReconcileOrderReturnsTheItemsUnchangedWithoutAnOrder()
    {
        string[] items = ["A", "B", "C"];
        Assert.Same(items, ChartOrdering.ReconcileOrderBy(null, items, s => s));
        Assert.Same(items, ChartOrdering.ReconcileOrderBy([], items, s => s));
    }

    [Fact]
    public void ReconcileOrderPutsListedNamesFirstThenAppendsTheRest()
    {
        Assert.Equal(["C", "A", "B"], ChartOrdering.ReconcileOrderBy(["C", "A"], ["A", "B", "C"], s => s));
        Assert.Equal(["D", "A", "B", "C"], ChartOrdering.ReconcileOrderBy(["D"], ["A", "B", "C", "D"], s => s));
    }

    [Fact]
    public void ReconcileOrderDropsStaleNamesAndLeavesAnEntirelyStaleOrderAlone()
    {
        Assert.Equal(["B", "A"], ChartOrdering.ReconcileOrderBy(["Gone", "B", "AlsoGone"], ["A", "B"], s => s));
        string[] items = ["A", "B"];
        Assert.Same(items, ChartOrdering.ReconcileOrderBy(["X", "Y"], items, s => s));
    }

    [Fact]
    public void ReconcileOrderIsStableForDuplicateItemNamesAndIgnoresDuplicateOrderEntries()
    {
        // Coarse date formats can collapse two buckets onto one label; both
        // rows must survive a reorder, adjacent, in engine order.
        Assert.Equal(
            ["Jan", "Jan", "Feb", "Mar"],
            ChartOrdering.ReconcileOrderBy(["Jan", "Feb"], ["Feb", "Jan", "Jan", "Mar"], s => s));
        Assert.Equal(["B", "A"], ChartOrdering.ReconcileOrderBy(["B", "A", "B"], ["A", "B"], s => s));
    }

    [Fact]
    public void ReconcileOrderByReordersObjectsWithoutMutatingTheInput()
    {
        var rows = new[] { (Label: "A", Value: 1), (Label: "B", Value: 2), (Label: "C", Value: 3) };
        var ordered = ChartOrdering.ReconcileOrderBy(["B", "C", "A"], rows, r => r.Label);

        Assert.Equal(["B", "C", "A"], ordered.Select(r => r.Label));
        Assert.Equal([2, 3, 1], ordered.Select(r => r.Value));
        Assert.Equal(["A", "B", "C"], rows.Select(r => r.Label));
    }

    // ----------------------------------------------------------- data labels
    // Ported one-for-one from util/dataLabels.test.ts.

    [Theory]
    [InlineData("value", "1,234")]
    [InlineData(null, "1,234")]
    public void DataLabelValueModeReturnsTheFormattedStringUntouched(string? content, string expected) =>
        Assert.Equal(expected, ChartDataLabels.Compose("1,234", 1234, 5000, content));

    [Fact]
    public void DataLabelPercentAndBothComposeTheTooltipStyleShare()
    {
        Assert.Equal("25.0%", ChartDataLabels.Compose("1,250", 1250, 5000, "percent"));
        Assert.Equal("1,250 (25.0%)", ChartDataLabels.Compose("1,250", 1250, 5000, "both"));
        // Negative values keep their sign against a positive (signed) total.
        Assert.Equal("-25.0%", ChartDataLabels.Compose("-1,250", -1250, 5000, "percent"));
    }

    [Fact]
    public void DataLabelFallsBackToThePlainValueWhenNoHonestShareExists()
    {
        Assert.Equal("10", ChartDataLabels.Compose("10", 10, 0, "percent"));
        Assert.Equal("10", ChartDataLabels.Compose("10", 10, -40, "both"));
        Assert.Equal("10", ChartDataLabels.Compose("10", 10, double.NaN, "percent"));
        Assert.Equal("∞", ChartDataLabels.Compose("∞", double.PositiveInfinity, 100, "percent"));
        // An unknown content mode degrades to the value, never to an exception.
        Assert.Equal("10", ChartDataLabels.Compose("10", 10, 100, "someFutureMode"));
    }

    // -------------------------------------------------------- number patterns

    [Theory]
    [InlineData(1234.5, "#,##0", "1,235")]
    [InlineData(1234.5, "#,##0.00", "1,234.50")]
    [InlineData(1234.5, "0", "1235")]
    [InlineData(0.2567, "0.0%", "25.7%")]
    [InlineData(1234567, "#,##0,", "1,235")]
    [InlineData(1234567890, "0.0,,", "1234.6")]
    [InlineData(1234.5, "$#,##0.00", "$1,234.50")]
    [InlineData(1234.5, "#,##0 \"units\"", "1,235 units")]
    public void FormatNumberPatternRendersExcelStylePatterns(double value, string pattern, string expected) =>
        Assert.Equal(expected, ChartValueFormats.FormatNumberPattern(value, pattern));

    [Fact]
    public void NegativeAndZeroSectionsCarryTheirOwnSignTreatment()
    {
        // The negative section renders UNSIGNED digits: its literals supply the sign.
        Assert.Equal("(1,234)", ChartValueFormats.FormatNumberPattern(-1234, "#,##0;(#,##0)"));
        Assert.Equal("1,234", ChartValueFormats.FormatNumberPattern(1234, "#,##0;(#,##0)"));
        // A literal-only zero section is the Excel "-" idiom.
        Assert.Equal("-", ChartValueFormats.FormatNumberPattern(0, "#,##0;(#,##0);\"-\""));
        // Without a negative section the default minus sign carries through.
        Assert.Equal("-1,234", ChartValueFormats.FormatNumberPattern(-1234, "#,##0"));
    }

    [Fact]
    public void ABadPatternOrNonFiniteValueFallsBackToTheDefaultNumberFormat()
    {
        Assert.Equal("1,234.5", ChartValueFormats.FormatNumberPattern(1234.5, ""));
        Assert.Equal("1,234.5", ChartValueFormats.FormatNumberPattern(1234.5, "   "));
        // A default section with no digit placeholder would swallow the value.
        Assert.Equal("1,234.5", ChartValueFormats.FormatNumberPattern(1234.5, "garbage"));
        // Unbalanced quote -> unparseable section.
        Assert.Equal("1,234.5", ChartValueFormats.FormatNumberPattern(1234.5, "#,##0 \"open"));
        Assert.Equal(double.NaN.ToString(), ChartValueFormats.FormatNumberPattern(double.NaN, "#,##0"));
    }

    [Fact]
    public void DefaultNumberMatchesTheIntlDefaultOfGroupingAndAtMostTwoFractionDigits()
    {
        Assert.Equal("1,234.5", ChartValueFormats.DefaultNumber(1234.5));
        Assert.Equal("1,234.57", ChartValueFormats.DefaultNumber(1234.5678));
        Assert.Equal("1,000,000", ChartValueFormats.DefaultNumber(1_000_000));
        Assert.Equal("0", ChartValueFormats.DefaultNumber(0));
    }

    // ------------------------------------------------- measure-value precedence

    [Fact]
    public void MeasureValuePrecedenceIsChartOverrideThenFormatStringThenHint()
    {
        var column = Column(formatHint: "$", formatString: "#,##0.0");

        // 1) The chart's valueFormat override beats everything.
        Assert.Equal("$1,235", ChartValueFormats.FormatMeasureValue(1234.5, column, "$#,##0"));
        // 2) Then the measure's FormatString.
        Assert.Equal("1,234.5", ChartValueFormats.FormatMeasureValue(1234.5, column, valueFormat: null));
        // 3) Then a pattern-shaped hint.
        Assert.Equal(
            "1,234.50",
            ChartValueFormats.FormatMeasureValue(1234.5, Column(formatHint: "#,##0.00"), null));
        // 4) Then the legacy loose hints.
        Assert.Equal("$1,235", ChartValueFormats.FormatMeasureValue(1234.5, Column(formatHint: "$"), null));
        Assert.Equal("$1,235", ChartValueFormats.FormatMeasureValue(1234.5, Column(formatHint: "currency"), null));
        Assert.Equal("25.7%", ChartValueFormats.FormatMeasureValue(0.2567, Column(formatHint: "percent"), null));
        // 5) Finally the default thousands format — including a null column.
        Assert.Equal("1,234.5", ChartValueFormats.FormatMeasureValue(1234.5, null, null));
    }

    // --------------------------------------------------------- date patterns
    // Ported from util/format.test.ts: date-only strings and NAIVE timestamps
    // are calendar parts, so their rendered parts are the LITERAL parts.

    [Theory]
    [InlineData("yyyy-MM-dd", "2026-08-04")]
    [InlineData("d", "4")]
    [InlineData("M", "8")]
    [InlineData("yyyy", "2026")]
    [InlineData("yy", "26")]
    [InlineData("MMM yyyy", "Aug 2026")]
    [InlineData("MMMM", "August")]
    [InlineData("EEE", "Tue")]
    [InlineData("EEEE", "Tuesday")]
    [InlineData("\"Q\"Qq yyyy", "Q3 2026")]
    public void FormatDatePatternRendersTheMaskTokens(string mask, string expected) =>
        // 2026-08-04 is a Tuesday, as a calendar date.
        Assert.Equal(expected, ChartValueFormats.FormatDatePattern(new DateTime(2026, 8, 4, 13, 45, 0), mask));

    [Fact]
    public void FormatDatePatternKeepsTheNaiveTimeOfDayAndNeverThrows()
    {
        var date = new DateTime(2026, 8, 4, 13, 45, 0);
        Assert.Equal("13:45", ChartValueFormats.FormatDatePattern(date, "HH:mm"));
        // MM = month, mm = minutes — the tokenizer must not confuse them.
        Assert.Equal("08:45", ChartValueFormats.FormatDatePattern(date, "MM:mm"));
        // An unterminated quote takes the rest as a literal instead of throwing.
        Assert.Equal("unterminated", ChartValueFormats.FormatDatePattern(date, "\"unterminated"));
    }

    [Theory]
    [InlineData("2026-08-04")]
    [InlineData("2026-08-04T13:45:00")]
    [InlineData("2026-08-04 13:45:00")]
    public void NaiveIsoStringsParseToTheirLiteralCalendarParts(string value)
    {
        var parsed = Assert.IsType<DateTime>(ChartValueFormats.ParseDateValue(value));
        Assert.Equal((2026, 8, 4), (parsed.Year, parsed.Month, parsed.Day));
    }

    [Fact]
    public void DateOnlyAndDateTimeCellsParseFromTheirOwnParts()
    {
        Assert.Equal(new DateTime(2026, 8, 4), ChartValueFormats.ParseDateValue(new DateOnly(2026, 8, 4)));
        Assert.Equal(
            new DateTime(2026, 8, 4, 13, 45, 0),
            ChartValueFormats.ParseDateValue(new DateTime(2026, 8, 4, 13, 45, 0)));
        Assert.Null(ChartValueFormats.ParseDateValue("not a date"));
        Assert.Null(ChartValueFormats.ParseDateValue(null));
    }

    // ---------------------------------------------------------- cell labels

    [Fact]
    public void FormatCellValueRendersBlanksBooleansAndBucketedDates()
    {
        var text = Column(NormalizedType.Text, role: ResultColumnRole.Dimension);
        Assert.Equal("(Blank)", ChartValueFormats.FormatCellValue(null, text));
        Assert.Equal("Yes", ChartValueFormats.FormatCellValue(true, Column(NormalizedType.Boolean)));
        Assert.Equal("No", ChartValueFormats.FormatCellValue(false, Column(NormalizedType.Boolean)));

        // Bucket-aware calendar parts — January must never render as December.
        Assert.Equal(
            "2026",
            ChartValueFormats.FormatCellValue("2026-01-01", Column(NormalizedType.Date, DateBucket.Year)));
        Assert.Equal(
            "Q4 2026",
            ChartValueFormats.FormatCellValue("2026-10-01", Column(NormalizedType.Date, DateBucket.Quarter)));
        Assert.Equal(
            "Jan 2026",
            ChartValueFormats.FormatCellValue("2026-01-01", Column(NormalizedType.Date, DateBucket.Month)));
        Assert.Equal(
            "Aug 4, 2026",
            ChartValueFormats.FormatCellValue("2026-08-04", Column(NormalizedType.Date, DateBucket.Day)));
    }

    [Fact]
    public void CategoryLabelsHonorTheChartsDatePresetWithACustomMaskWinning()
    {
        var column = Column(NormalizedType.Date, DateBucket.Day, role: ResultColumnRole.Dimension);

        Assert.Equal("2026-08-04", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "isoDate", null));
        Assert.Equal("4", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "dayOfMonth", null));
        Assert.Equal("8", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "monthNum", null));
        Assert.Equal("2026", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "year", null));
        Assert.Equal("Q3 2026", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "quarter", null));
        Assert.Equal("Tuesday", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "dayLong", null));

        // The custom mask outranks the preset.
        Assert.Equal("2026-08-04", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "year", "yyyy-MM-dd"));
        // 'auto' / unset falls through to the bucket-aware cell label.
        Assert.Equal("Aug 4, 2026", ChartValueFormats.FormatCategoryLabel("2026-08-04", column, "auto", null));
        Assert.Equal("(Blank)", ChartValueFormats.FormatCategoryLabel(null, column, "isoDate", null));
    }

    [Fact]
    public void ANonBucketedColumnIgnoresTheDatePresetEntirely()
    {
        var text = Column(NormalizedType.Text, bucket: null, role: ResultColumnRole.Dimension);
        Assert.Equal("West", ChartValueFormats.FormatCategoryLabel("West", text, "isoDate", "yyyy"));
    }

    // ------------------------------------------------------- axis tick formats
    // Ported from util/format.ts formatAxisValue (AxisValueFormat), which the
    // browser applies to axis TICKS only.

    [Theory]
    [InlineData(1200, "1.2K")]
    [InlineData(1000, "1K")]
    [InlineData(999, "999")]
    [InlineData(0, "0")]
    [InlineData(-2500, "-2.5K")]
    [InlineData(1_500_000, "1.5M")]
    [InlineData(1_234_567_890, "1.2B")]
    [InlineData(2_500_000_000_000, "2.5T")]
    public void CompactTicksReadLikeIntlCompactNotation(double value, string expected) =>
        Assert.Equal(expected, ChartAxisFormats.FormatAxisValue(value, new AxisValueFormatDoc("compact")));

    [Fact]
    public void CompactRoundingNeverProducesAThousandOfItsOwnUnit()
    {
        // 999,950 rounds to 1000.0K at one decimal — which must step up to 1M.
        Assert.Equal("1M", ChartAxisFormats.FormatAxisValue(999_950, new AxisValueFormatDoc("compact")));
        Assert.Equal("999.9K", ChartAxisFormats.FormatAxisValue(999_940, new AxisValueFormatDoc("compact", 1)));
    }

    [Theory]
    [InlineData("number", null, 1234.56, "1,235")]
    [InlineData("number", 2, 1234.5, "1,234.50")]
    [InlineData("currency", null, 1234.5, "$1,235")]
    [InlineData("currency", 2, 1234.5, "$1,234.50")]
    [InlineData("percent", null, 0.2567, "25.7%")]
    [InlineData("percent", 0, 0.2567, "26%")]
    [InlineData("compact", 0, 1200, "1K")]
    public void EachAxisFormatKindRendersItsIntlEquivalent(
        string kind, int? decimals, double value, string expected) =>
        Assert.Equal(expected, ChartAxisFormats.FormatAxisValue(value, new AxisValueFormatDoc(kind, decimals)));

    [Fact]
    public void CustomAxisTicksUseTheirExcelPatternAndDegradeWithoutOne()
    {
        Assert.Equal(
            "$1,235", ChartAxisFormats.FormatAxisValue(1234.5, new AxisValueFormatDoc("custom", Pattern: "$#,##0")));
        // Kind switched but no pattern typed yet: the default number formatting.
        Assert.Equal("1,234.5", ChartAxisFormats.FormatAxisValue(1234.5, new AxisValueFormatDoc("custom")));
    }

    [Fact]
    public void AnUnsetOrAutoAxisFormatIsInertSoTheEngineKeepsItsOwnTicks()
    {
        Assert.False(ChartAxisFormats.IsActive(null));
        Assert.False(ChartAxisFormats.IsActive(new AxisValueFormatDoc()));
        Assert.False(ChartAxisFormats.IsActive(new AxisValueFormatDoc("auto")));
        Assert.True(ChartAxisFormats.IsActive(new AxisValueFormatDoc("compact")));
        Assert.Equal("1,234.5", ChartAxisFormats.FormatAxisValue(1234.5, null));
    }

    // ---------------------------------------------------------- chart analytics
    // Ported from chart/analytics.ts (referenceLineValue, linearFitValues,
    // movingAverageValues).

    [Theory]
    [InlineData("average", 20d)]
    [InlineData("median", 20d)]
    [InlineData("min", 10d)]
    [InlineData("max", 30d)]
    public void ReferenceStatisticsReadTheWholePlottedSeries(string kind, double expected) =>
        Assert.Equal(expected, ChartAnalytics.ReferenceValue(kind, null, [10d, null, 20d, 30d]));

    [Fact]
    public void AnEvenMedianAveragesTheMiddlePairAndAConstantIgnoresTheData()
    {
        Assert.Equal(15, ChartAnalytics.ReferenceValue("median", null, [10d, 20d, 30d, 0d]));
        Assert.Equal(42, ChartAnalytics.ReferenceValue("constant", 42, [10d, 20d]));
        // Nothing to state honestly: no value, or no numbers at all.
        Assert.Null(ChartAnalytics.ReferenceValue("constant", null, [10d]));
        Assert.Null(ChartAnalytics.ReferenceValue("average", null, [null, null]));
        Assert.Null(ChartAnalytics.ReferenceValue("someFutureKind", null, [10d]));
    }

    [Fact]
    public void ALinearFitSpansEveryIndexEvenWhereTheDataHasHoles()
    {
        Assert.Equal([10d, 20d, 30d], ChartAnalytics.LinearFit([10d, null, 30d]));
        // Fewer than two points cannot define a line — all null, never a guess.
        Assert.All(ChartAnalytics.LinearFit([null, 5d, null]), v => Assert.Null(v));
    }

    [Fact]
    public void AMovingAverageIsTrailingAndPartialWindowsStayBlank()
    {
        Assert.Equal([null, null, 20d, 30d], ChartAnalytics.MovingAverage([10d, 20d, 30d, 40d], 3));
        // A null inside the window blanks that index rather than under-counting.
        Assert.Equal([null, null, null, null], ChartAnalytics.MovingAverage([10d, null, 30d, 40d], 3));
    }
}
