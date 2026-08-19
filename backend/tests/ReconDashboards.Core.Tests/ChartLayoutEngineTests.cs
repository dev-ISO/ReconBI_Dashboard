using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Rendering;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The pure geometry layer behind every emailed chart PNG: an executed tile +
/// its ChartFormatDoc in, <see cref="ChartLayout"/> primitives out. Testing the
/// LAYOUT rather than pixels is the whole point of the split — a bar's height,
/// a slice's sweep, and a legend's presence are assertable as data on any
/// machine, with or without fonts.
/// </summary>
public class ChartLayoutEngineTests
{
    private const int Width = 600;
    private const int Height = 360; // the pinned 5:3 default

    // ------------------------------------------------------------- fixtures

    private static ResultColumnPlan Dimension(string label = "Region") =>
        new("dim0", label, ResultColumnRole.Dimension, NormalizedType.Text,
            "public.customers.region", null, null);

    private static ResultColumnPlan DateDimension(string label = "Month", DateBucket bucket = DateBucket.Month) =>
        new("dim0", label, ResultColumnRole.Dimension, NormalizedType.Date,
            "public.orders.order_date", bucket, null);

    private static ResultColumnPlan Measure(string label = "Total", string? formatString = null) =>
        new("meas0", label, ResultColumnRole.Measure, NormalizedType.Decimal,
            "public.orders.order_total", null, null, formatString);

    private static RenderedTile Tile(
        string chartType,
        IReadOnlyList<ResultColumnPlan> columns,
        IReadOnlyList<object?[]> rows,
        ChartFormatDoc? format = null,
        IReadOnlyList<SortSpec>? sort = null) =>
        new(
            new SnapshotTile(
                "t1", "Sales", chartType,
                new ChartQuerySpec(1, [], [], [], sort ?? [], null, null),
                format),
            columns, rows, Error: null);

    /// <summary>One dimension, one measure: West 10 / East 20 — the workhorse shape.</summary>
    private static RenderedTile SimpleTile(string chartType, ChartFormatDoc? format = null) =>
        Tile(chartType, [Dimension(), Measure()], [["West", 10d], ["East", 20d]], format);

    /// <summary>One dimension, TWO measures: two series over two categories.</summary>
    private static RenderedTile TwoSeriesTile(string chartType, ChartFormatDoc? format = null) =>
        Tile(
            chartType,
            [Dimension(), Measure("Total"), Measure("Target")],
            [["West", 10d, 5d], ["East", 20d, 15d]],
            format);

    // ------------------------------------------------------------- families

    [Fact]
    public void OnlyTheTenVisualFamiliesRenderAsImages()
    {
        foreach (var type in new[]
                 {
                     "column", "bar", "stackedColumn", "stackedBar", "line",
                     "area", "pie", "donut", "scatter", "gantt",
                 })
        {
            Assert.True(ChartLayoutEngine.IsVisual(type), type);
        }

        // kpi/table keep their HTML blocks in EVERY body mode; an unknown type
        // degrades to its table rather than to a blank image.
        Assert.False(ChartLayoutEngine.IsVisual("kpi"));
        Assert.False(ChartLayoutEngine.IsVisual("table"));
        Assert.False(ChartLayoutEngine.IsVisual("someFutureFamily"));
    }

    [Theory]
    [InlineData(480, 288)]
    [InlineData(600, 360)]
    [InlineData(900, 540)]
    public void CartesianAndPieFamiliesUseThePinnedFiveByThreeBox(int width, int expectedHeight)
    {
        foreach (var type in new[] { "column", "bar", "stackedColumn", "stackedBar", "line", "area", "pie", "donut", "scatter" })
        {
            var layout = ChartLayoutEngine.Build(SimpleTile(type), width);
            Assert.Equal(width, layout.Width);
            Assert.Equal(expectedHeight, layout.Height);
            Assert.Equal("#ffffff", layout.Background); // blends into the email body
        }
    }

    // ------------------------------------------------------------ column/bar

    [Fact]
    public void ColumnBarsRiseFromZeroInProportionToTheirValues()
    {
        var layout = ChartLayoutEngine.Build(SimpleTile("column"), Width);

        Assert.Equal(2, layout.Bars.Count);
        var west = layout.Bars[0];
        var east = layout.Bars[1];
        Assert.Equal(west.Width, east.Width, 6);          // one series ⇒ equal band share
        Assert.Equal(west.Height * 2, east.Height, 6);    // 10 vs 20 against a zero-anchored axis
        Assert.True(east.X > west.X);                     // categories in row order, left to right
        // Both bars share the baseline: top + height lands on the same y.
        Assert.Equal(west.Y + west.Height, east.Y + east.Height, 6);
        Assert.Equal(ChartPalette.SeriesColor(0), west.Fill);
    }

    [Fact]
    public void HorizontalBarsGrowRightwardAndShareTheCategoryRail()
    {
        var layout = ChartLayoutEngine.Build(SimpleTile("bar"), Width);

        Assert.Equal(2, layout.Bars.Count);
        var west = layout.Bars[0];
        var east = layout.Bars[1];
        Assert.Equal(west.Height, east.Height, 6);        // equal row thickness
        Assert.Equal(west.Width * 2, east.Width, 6);      // 10 vs 20
        Assert.Equal(west.X, east.X, 6);                  // both start at the zero rail
        Assert.True(east.Y > west.Y);                     // rows stack downward in row order
    }

    [Fact]
    public void NegativeValuesHangBelowTheZeroLineInsteadOfInverting()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], [["West", 10d], ["East", -20d]]), Width);

        var up = layout.Bars[0];
        var down = layout.Bars[1];
        // The zero line is the shared edge: the positive bar's bottom is the
        // negative bar's top, and neither has a negative height.
        Assert.Equal(up.Y + up.Height, down.Y, 6);
        Assert.True(up.Height > 0 && down.Height > 0);
    }

    [Fact]
    public void GroupedSeriesSplitTheBandAndNullCellsDrawNoBar()
    {
        var layout = ChartLayoutEngine.Build(TwoSeriesTile("column"), Width);
        Assert.Equal(4, layout.Bars.Count);
        // Two series share one band: each bar is half the single-series width.
        var single = ChartLayoutEngine.Build(SimpleTile("column"), Width).Bars[0];
        Assert.Equal(single.Width / 2, layout.Bars[0].Width, 6);
        // Series get distinct hues from the categorical slots.
        Assert.Equal(ChartPalette.SeriesColor(0), layout.Bars[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(1), layout.Bars[2].Fill);

        var withHole = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure("Total"), Measure("Target")],
                [["West", 10d, null], ["East", 20d, 15d]]), Width);
        Assert.Equal(3, withHole.Bars.Count); // the missing cell is absent, not zero
    }

    // ---------------------------------------------------------------- stacked

    [Fact]
    public void StackedColumnsPileSegmentsThatSumToTheCategoryTotal()
    {
        var layout = ChartLayoutEngine.Build(TwoSeriesTile("stackedColumn"), Width);

        Assert.Equal(4, layout.Bars.Count);
        // Emission is category-major, so bars 0/1 are one stack and 2/3 the next.
        // West stack = 10 + 5; East stack = 20 + 15.
        var westHeight = layout.Bars.Where(b => Math.Abs(b.X - layout.Bars[0].X) < 0.001).Sum(b => b.Height);
        var eastHeight = layout.Bars.Where(b => Math.Abs(b.X - layout.Bars[2].X) < 0.001).Sum(b => b.Height);
        Assert.Equal(westHeight * (35d / 15d), eastHeight, 5);

        // Segments touch: the second segment sits exactly on top of the first.
        var westSegments = layout.Bars
            .Where(b => Math.Abs(b.X - layout.Bars[0].X) < 0.001)
            .OrderByDescending(b => b.Y)
            .ToList();
        Assert.Equal(westSegments[1].Y + westSegments[1].Height, westSegments[0].Y, 5);
    }

    [Fact]
    public void StackedAxisDomainCoversTheStackTotalNotTheLargestSeries()
    {
        // Grouped tops out at 20; stacked must reach 35, so its tallest single
        // segment is SHORTER even though the data is identical.
        var grouped = ChartLayoutEngine.Build(TwoSeriesTile("column"), Width);
        var stacked = ChartLayoutEngine.Build(TwoSeriesTile("stackedColumn"), Width);
        Assert.True(stacked.Bars.Max(b => b.Height) < grouped.Bars.Max(b => b.Height));
    }

    [Fact]
    public void StackedBarsRunHorizontallyFromTheZeroRail()
    {
        var layout = ChartLayoutEngine.Build(TwoSeriesTile("stackedBar"), Width);
        Assert.Equal(4, layout.Bars.Count);
        var westRow = layout.Bars.Where(b => Math.Abs(b.Y - layout.Bars[0].Y) < 0.001).OrderBy(b => b.X).ToList();
        Assert.Equal(2, westRow.Count);
        Assert.Equal(westRow[0].X + westRow[0].Width, westRow[1].X, 5); // segments touch
    }

    // ------------------------------------------------------------- line/area

    [Fact]
    public void LinesDrawOnePolylineWithADotPerPoint()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("line", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d], ["2026-03-01", 15d]]), Width);

        var polyline = Assert.Single(layout.Lines);
        Assert.Equal(3, polyline.Points.Count);
        Assert.Equal(3, layout.Dots.Count);
        Assert.Empty(layout.Bars);
        Assert.Empty(layout.Areas);
        // Higher value ⇒ smaller y (screen coordinates grow downward).
        Assert.True(polyline.Points[1].Y < polyline.Points[0].Y);
        Assert.True(polyline.Points[0].X < polyline.Points[1].X);
    }

    [Fact]
    public void NullValuesBreakALineIntoSegmentsInsteadOfConnectingAcrossTheGap()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("line", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d], ["2026-03-01", null],
                 ["2026-04-01", 40d], ["2026-05-01", 50d]]), Width);

        Assert.Equal(2, layout.Lines.Count);
        Assert.All(layout.Lines, l => Assert.Equal(2, l.Points.Count));
        Assert.Equal(4, layout.Dots.Count); // the gap contributes no dot
    }

    [Fact]
    public void AreasCloseBackToTheZeroBaselineAndSkipTheDots()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("area", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d]]), Width);

        var polygon = Assert.Single(layout.Areas);
        Assert.Equal(4, polygon.Points.Count); // 2 data points + 2 baseline corners
        Assert.Equal(polygon.Points[2].Y, polygon.Points[3].Y, 6); // the shared baseline
        Assert.True(polygon.Opacity < 1); // translucent fill under the stroke
        Assert.Single(layout.Lines);
        Assert.Empty(layout.Dots);
    }

    // -------------------------------------------------------------- pie/donut

    [Fact]
    public void PieSlicesSweepAFullTurnProportionalToTheirShare()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("pie", [Dimension(), Measure()],
                [["West", 50d], ["East", 30d], ["North", 20d]]), Width);

        Assert.Equal(3, layout.Arcs.Count);
        Assert.Equal(360, layout.Arcs.Sum(a => a.SweepDegrees), 5);
        Assert.Equal(180, layout.Arcs[0].SweepDegrees, 5);
        Assert.Equal(108, layout.Arcs[1].SweepDegrees, 5);
        // Slices are laid end to end from 12 o'clock.
        Assert.Equal(0, layout.Arcs[0].StartDegrees);
        Assert.Equal(layout.Arcs[0].SweepDegrees, layout.Arcs[1].StartDegrees, 5);
        Assert.All(layout.Arcs, a => Assert.Equal(0, a.InnerRadius)); // a pie has no hole
    }

    [Fact]
    public void DonutKeepsTheRechartsFiftyFiveOverEightyFiveHole()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("donut", [Dimension(), Measure()], [["West", 50d], ["East", 50d]]), Width);

        var arc = layout.Arcs[0];
        Assert.True(arc.InnerRadius > 0);
        Assert.Equal(arc.OuterRadius * (0.55 / 0.85), arc.InnerRadius, 5);
    }

    [Fact]
    public void NonPositiveSlicesCarryNoDrawableShareAndAreDropped()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("pie", [Dimension(), Measure()],
                [["West", 50d], ["Zero", 0d], ["Negative", -10d], ["East", 50d]]), Width);

        Assert.Equal(2, layout.Arcs.Count);
        Assert.All(layout.Arcs, a => Assert.Equal(180, a.SweepDegrees, 5));
    }

    [Fact]
    public void AnEmptyResultStillProducesADrawableEmptyChart()
    {
        foreach (var type in new[] { "column", "line", "pie", "scatter", "gantt" })
        {
            var layout = ChartLayoutEngine.Build(Tile(type, [Dimension(), Measure()], []), Width);
            Assert.Equal(Width, layout.Width);
            Assert.True(layout.Height > 0);
            Assert.Empty(layout.Bars);
            Assert.Empty(layout.Arcs);
        }
    }

    // --------------------------------------------------------------- scatter

    [Fact]
    public void ScatterPlotsOneDotPerRowAcrossTwoMeasureAxes()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("scatter", [Dimension(), Measure("Spend"), Measure("Revenue")],
                [["West", 1d, 10d], ["West", 2d, 20d], ["East", 3d, 30d]]), Width);

        Assert.Equal(3, layout.Dots.Count);
        Assert.Empty(layout.Bars);
        // Two split values ⇒ two hues.
        Assert.Equal(ChartPalette.SeriesColor(0), layout.Dots[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(1), layout.Dots[2].Fill);
        // x grows rightward with the first measure, y upward with the second.
        Assert.True(layout.Dots[1].CenterX > layout.Dots[0].CenterX);
        Assert.True(layout.Dots[1].CenterY < layout.Dots[0].CenterY);
    }

    [Fact]
    public void ScatterHonorsTheThreeSeriesCapAndSkipsUnplottableRows()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("scatter", [Dimension(), Measure("Spend"), Measure("Revenue")],
                [["A", 1d, 1d], ["B", 2d, 2d], ["C", 3d, 3d], ["D", 4d, 4d], ["E", null, 5d]]), Width);

        // D is beyond the frontend's SCATTER_SERIES_CAP; E has no x value.
        Assert.Equal(3, layout.Dots.Count);
        Assert.Equal(3, layout.Dots.Select(d => d.Fill).Distinct().Count());
    }

    [Fact]
    public void ScatterWithoutTwoMeasuresPlotsNothingRatherThanGuessing()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("scatter", [Dimension(), Measure("Spend")], [["West", 1d]]), Width);
        Assert.Empty(layout.Dots);
    }

    // ----------------------------------------------------------------- gantt

    [Fact]
    public void GanttDrawsOneBarPerTaskSpanOrderedByStart()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("gantt", [Dimension("Task"), Measure("Start"), Measure("Finish")],
                [
                    ["Commission", "2026-03-01", "2026-04-01"],
                    ["Design", "2026-01-01", "2026-02-01"],
                    ["Build", "2026-02-01", "2026-03-01"],
                ]), Width);

        Assert.Equal(3, layout.Bars.Count);
        // Default reading order is start-ascending, so rows descend in time.
        Assert.True(layout.Bars[0].X < layout.Bars[1].X);
        Assert.True(layout.Bars[1].X < layout.Bars[2].X);
        Assert.True(layout.Bars[0].Y < layout.Bars[1].Y);
        Assert.All(layout.Bars, b => Assert.True(b.Width >= 2)); // milestones keep a sliver
    }

    [Fact]
    public void GanttHeightGrowsWithRowsAndStopsAtTheNineHundredPixelCap()
    {
        var few = ChartLayoutEngine.Build(GanttTile(3), Width);
        var many = ChartLayoutEngine.Build(GanttTile(20), Width);
        var flood = ChartLayoutEngine.Build(GanttTile(200), Width);

        Assert.Equal(160, few.Height); // the floor, not the 5:3 box
        Assert.True(many.Height > few.Height);
        Assert.Equal(900, flood.Height);
        // Beyond the visible rows the reader is told what was withheld.
        Assert.Contains(flood.Texts, t => t.Text.Contains("more tasks not shown", StringComparison.Ordinal));
    }

    [Fact]
    public void GanttProgressPaintsACompletionOverlayOverPartOfTheBar()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("gantt", [Dimension("Task"), Measure("Start"), Measure("Finish"), Measure("Progress")],
                [["Design", "2026-01-01", "2026-02-01", 40d]]), Width);

        Assert.Equal(2, layout.Bars.Count); // span + overlay
        var span = layout.Bars[0];
        var overlay = layout.Bars[1];
        Assert.Equal(span.X, overlay.X, 6);
        Assert.Equal(span.Width * 0.4, overlay.Width, 5); // 40 read as a percent
        Assert.True(overlay.Opacity < 1);
    }

    private static RenderedTile GanttTile(int taskCount) =>
        Tile("gantt", [Dimension("Task"), Measure("Start"), Measure("Finish")],
            [.. Enumerable.Range(0, taskCount).Select(i => new object?[]
            {
                $"Task {i}",
                new DateTime(2026, 1, 1).AddDays(i),
                new DateTime(2026, 1, 1).AddDays(i + 5),
            })]);

    // ---------------------------------------------------------------- legend

    [Fact]
    public void ASingleSeriesNeedsNoLegendButSeveralDo()
    {
        Assert.Empty(ChartLayoutEngine.Build(SimpleTile("column"), Width).Swatches);

        var multi = ChartLayoutEngine.Build(TwoSeriesTile("column"), Width);
        Assert.Equal(2, multi.Swatches.Count);
        Assert.Contains(multi.Texts, t => t.Text == "Total");
        Assert.Contains(multi.Texts, t => t.Text == "Target");
    }

    [Fact]
    public void ShowLegendFalseSuppressesItAndLegendPositionRightMovesItBesideThePlot()
    {
        var hidden = ChartLayoutEngine.Build(
            TwoSeriesTile("column", new ChartFormatDoc(ShowLegend: false)), Width);
        Assert.Empty(hidden.Swatches);

        var bottom = ChartLayoutEngine.Build(TwoSeriesTile("column"), Width);
        var right = ChartLayoutEngine.Build(
            TwoSeriesTile("column", new ChartFormatDoc(LegendPosition: "right")), Width);

        // Bottom legend: the two swatches sit side by side on one row.
        Assert.Equal(bottom.Swatches[0].Y, bottom.Swatches[1].Y, 6);
        Assert.True(bottom.Swatches[1].X > bottom.Swatches[0].X);
        // Right legend: stacked in a column past the plot area.
        Assert.Equal(right.Swatches[0].X, right.Swatches[1].X, 6);
        Assert.True(right.Swatches[1].Y > right.Swatches[0].Y);
        // ...which narrows the plot, so the bars get thinner.
        Assert.True(right.Bars.Max(b => b.Width) < bottom.Bars.Max(b => b.Width));
    }

    [Fact]
    public void SeriesLabelsRenameTheLegendWithoutRecoloringTheSeries()
    {
        var format = new ChartFormatDoc(
            SeriesLabels: new Dictionary<string, string> { ["Total"] = "Revenue" });
        var layout = ChartLayoutEngine.Build(TwoSeriesTile("column", format), Width);

        // The LEGEND (11px) carries the rename; the value-axis TITLE (12px)
        // still names the underlying measure column.
        Assert.Contains(layout.Texts, t => t.Text == "Revenue" && t.FontSize == 11);
        Assert.DoesNotContain(layout.Texts, t => t.Text == "Total" && t.FontSize == 11);
        Assert.Single(layout.Texts, t => t.Text == "Total" && t.FontSize == 12);
        Assert.Equal(ChartPalette.SeriesColor(0), layout.Bars[0].Fill);
    }

    // -------------------------------------------------------- axes and grid

    [Fact]
    public void GridlinesFollowTheLiteralGridXGridYSemanticsWithYOnByDefault()
    {
        var normal = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.NotEmpty(normal.GridLines);
        // Default: horizontal value gridlines only.
        Assert.All(normal.GridLines, l => Assert.Equal(l.Y1, l.Y2, 6));

        Assert.Empty(ChartLayoutEngine.Build(SimpleTile("column", new ChartFormatDoc(GridY: false)), Width).GridLines);

        var both = ChartLayoutEngine.Build(SimpleTile("column", new ChartFormatDoc(GridX: true)), Width);
        Assert.Contains(both.GridLines, l => Math.Abs(l.X1 - l.X2) < 0.001); // vertical category lines too
    }

    [Fact]
    public void BothAxisLinesAreAlwaysDrawn()
    {
        var layout = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.Equal(2, layout.AxisLines.Count);
        Assert.Contains(layout.AxisLines, l => Math.Abs(l.Y1 - l.Y2) < 0.001); // baseline
        Assert.Contains(layout.AxisLines, l => Math.Abs(l.X1 - l.X2) < 0.001); // value rail
    }

    [Fact]
    public void AxisTitlesComeFromTheFormatElseTheColumnLabels()
    {
        var fromColumns = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.Contains(fromColumns.Texts, t => t.Text == "Region");
        Assert.Contains(fromColumns.Texts, t => t.Text == "Total");

        var overridden = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(XAxisLabel: "Territory", YAxisLabel: "Revenue")), Width);
        Assert.Contains(overridden.Texts, t => t.Text == "Territory");
        Assert.Contains(overridden.Texts, t => t.Text == "Revenue");
        Assert.DoesNotContain(overridden.Texts, t => t.Text == "Region");
        // The value-axis title is rotated up the left rail.
        Assert.Equal(-90, overridden.Texts.Single(t => t.Text == "Revenue").RotationDegrees);
    }

    [Fact]
    public void TheValueAxisGetsFourToSixNiceTicksFormattedLikeTheScreen()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure("Total", "$#,##0")],
                [["West", 1000d], ["East", 4300d]]), Width);

        // Ticks are the right-anchored texts on the value rail.
        var tickLabels = layout.Texts
            .Where(t => t.Anchor == TextAnchor.End && t.RotationDegrees == 0 && t.Text.StartsWith('$'))
            .Select(t => t.Text)
            .ToList();
        Assert.InRange(tickLabels.Count, 4, 6);
        Assert.Equal("$0", tickLabels[0]);            // the axis anchors at zero
        Assert.Contains("$5,000", tickLabels);        // ...and covers the data with a round top
    }

    [Fact]
    public void CrowdedCategoryTicksRotateThirtyDegreesInsteadOfOverlapping()
    {
        var roomy = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.All(
            roomy.Texts.Where(t => t.Text is "West" or "East"),
            t => Assert.Equal(0, t.RotationDegrees));

        var crowded = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()],
                [.. Enumerable.Range(0, 24).Select(
                    i => new object?[] { $"Very Long Category Label Number {i}", (double)i })]),
            Width);
        Assert.Contains(crowded.Texts, t => t.RotationDegrees == -30);
        // Long labels are elided rather than allowed to run off the canvas.
        Assert.Contains(crowded.Texts, t => t.Text.EndsWith('…'));
    }

    // -------------------------------------------------------- format plumbing

    [Fact]
    public void ColorOverridesAndThemesReachTheDrawnMarks()
    {
        var themed = ChartLayoutEngine.Build(
            TwoSeriesTile("column", new ChartFormatDoc(Theme: "ocean")), Width);
        Assert.Equal("#1868ae", themed.Bars[0].Fill);
        Assert.Equal("#26a5b8", themed.Bars[2].Fill);

        var overridden = ChartLayoutEngine.Build(
            TwoSeriesTile("column", new ChartFormatDoc(
                Theme: "ocean",
                ColorOverrides: new Dictionary<string, string> { ["Total"] = "#abcdef" })),
            Width);
        Assert.Equal("#abcdef", overridden.Bars[0].Fill);
        Assert.Equal("#26a5b8", overridden.Bars[2].Fill); // the other series is untouched
    }

    [Fact]
    public void CategoryOrderReordersTheAxisAndCarriesEachSeriesValueWithIt()
    {
        var natural = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        var reordered = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(CategoryOrder: ["East", "West"])), Width);

        // Same two heights, swapped positions — a reorder must never re-scale.
        Assert.Equal(natural.Bars[1].Height, reordered.Bars[0].Height, 6);
        Assert.Equal(natural.Bars[0].Height, reordered.Bars[1].Height, 6);
        var categoryTicks = reordered.Texts.Where(t => t.Text is "West" or "East").ToList();
        Assert.Equal("East", categoryTicks[0].Text);
    }

    [Fact]
    public void SeriesOrderReordersSeriesWithoutRehuingThem()
    {
        var reordered = ChartLayoutEngine.Build(
            TwoSeriesTile("column", new ChartFormatDoc(SeriesOrder: ["Target", "Total"])), Width);

        // Target now draws first but keeps the hue it had before the reorder.
        Assert.Equal(ChartPalette.SeriesColor(1), reordered.Bars[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(0), reordered.Bars[2].Fill);
    }

    [Fact]
    public void DataLabelsAppearOnBarsOnlyWhenAskedForAndSayWhatTheFormatSays()
    {
        // 12/23 are deliberately NOT round: they can never collide with an
        // axis tick label, so a match proves the on-mark label was drawn.
        RenderedTile Labelled(string type, ChartFormatDoc? format) =>
            Tile(type, [Dimension(), Measure()], [["West", 12d], ["East", 23d]], format);

        var off = ChartLayoutEngine.Build(Labelled("column", null), Width);
        Assert.DoesNotContain(off.Texts, t => t.Text is "12" or "23");

        var on = ChartLayoutEngine.Build(Labelled("column", new ChartFormatDoc(ShowDataLabels: true)), Width);
        Assert.Contains(on.Texts, t => t.Text == "12");
        Assert.Contains(on.Texts, t => t.Text == "23");

        var share = ChartLayoutEngine.Build(
            Labelled("column", new ChartFormatDoc(ShowDataLabels: true, DataLabelContent: "both")), Width);
        Assert.Contains(share.Texts, t => t.Text == "12 (34.3%)"); // 12 of the series' own 35
        Assert.Contains(share.Texts, t => t.Text == "23 (65.7%)");

        // Line and area families never carry on-mark labels.
        Assert.DoesNotContain(
            ChartLayoutEngine.Build(Labelled("line", new ChartFormatDoc(ShowDataLabels: true)), Width).Texts,
            t => t.Text == "12");
    }

    [Fact]
    public void StackedDataLabelsMeasureAgainstTheCategoryStackTotal()
    {
        var layout = ChartLayoutEngine.Build(
            TwoSeriesTile("stackedColumn",
                new ChartFormatDoc(ShowDataLabels: true, DataLabelContent: "percent")), Width);

        // West stack is 10 + 5: the segments read 66.7% and 33.3% of THAT stack.
        Assert.Contains(layout.Texts, t => t.Text == "66.7%");
        Assert.Contains(layout.Texts, t => t.Text == "33.3%");
    }

    [Fact]
    public void ValueFormatOverridesTheMeasurePatternOnTicksAndLabels()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure("Total", "#,##0.00")],
                [["West", 1000d], ["East", 2000d]],
                new ChartFormatDoc(ValueFormat: "$#,##0", ShowDataLabels: true)), Width);

        Assert.Contains(layout.Texts, t => t.Text == "$1,000");
        Assert.DoesNotContain(layout.Texts, t => t.Text == "1,000.00");
    }

    [Fact]
    public void ADateAxisFormatsItsTicksThroughTheChartsDatePreset()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d]],
                new ChartFormatDoc(DateFormat: "monthShort")), Width);

        Assert.Contains(layout.Texts, t => t.Text == "Jan");
        Assert.Contains(layout.Texts, t => t.Text == "Feb");

        // A custom mask outranks the preset.
        var masked = ChartLayoutEngine.Build(
            Tile("column", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d]],
                new ChartFormatDoc(DateFormat: "monthShort", DateFormatPattern: "yyyy-MM")), Width);
        Assert.Contains(masked.Texts, t => t.Text == "2026-01");
    }

    // ------------------------------------------------------------ pivoting

    [Fact]
    public void TwoDimensionsPivotIntoOneSeriesPerLegendValueOverTheFirstMeasure()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column",
                [Dimension("Region"), Dimension("Segment"), Measure()],
                [
                    ["West", "Retail", 10d],
                    ["West", "Trade", 5d],
                    ["East", "Retail", 20d],
                    ["East", "Trade", 15d],
                ]),
            Width);

        // 2 categories × 2 legend values.
        Assert.Equal(4, layout.Bars.Count);
        Assert.Equal(2, layout.Swatches.Count);
        Assert.Contains(layout.Texts, t => t.Text == "Retail");
        Assert.Contains(layout.Texts, t => t.Text == "Trade");
        // The AXIS is dimension 0, so only two category ticks exist.
        Assert.Single(layout.Texts, t => t.Text == "West");
    }

    [Fact]
    public void AThirdSmallMultiplesDimensionCollapsesRatherThanSplittingThePanel()
    {
        // v1 renders one image: rows sharing (category, series) collapse
        // last-write-wins instead of drawing an unreadable panel grid.
        var layout = ChartLayoutEngine.Build(
            Tile("column",
                [Dimension("Region"), Dimension("Segment"), Dimension("Status"), Measure()],
                [
                    ["West", "Retail", "open", 10d],
                    ["West", "Retail", "closed", 99d],
                    ["East", "Retail", "open", 20d],
                ]),
            Width);

        Assert.Equal(2, layout.Bars.Count); // West + East, one series
        Assert.Equal(ChartPalette.SeriesColor(0), layout.Bars[0].Fill);
    }

    [Fact]
    public void LineAndAreaKeepEveryMeasureAsAMeasureByLegendCombo()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("line",
                [Dimension("Region"), Dimension("Segment"), Measure("Total"), Measure("Target")],
                [
                    ["West", "Retail", 10d, 5d],
                    ["East", "Retail", 20d, 15d],
                ]),
            Width);

        // 2 measures × 1 legend value = 2 combo series, measure-major.
        Assert.Equal(2, layout.Lines.Count);
        Assert.Contains(layout.Texts, t => t.Text == "Total — Retail");
        Assert.Contains(layout.Texts, t => t.Text == "Target — Retail");
    }

    [Fact]
    public void CollidingFormattedLabelsNeverMergeTwoDistinctBuckets()
    {
        // Both rows bucket to "Jan 2026" as text but are different raw days:
        // the type-tagged raw key keeps them apart, so no data is silently lost.
        var layout = ChartLayoutEngine.Build(
            Tile("column",
                [DateDimension(), Dimension("Segment"), Measure()],
                [
                    ["2026-01-01", "Retail", 10d],
                    ["2026-01-15", "Retail", 20d],
                ]),
            Width);

        Assert.Equal(2, layout.Bars.Count);
    }

    [Fact]
    public void NumericStringsFromLooselyTypedDriversStillPlot()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], [["West", "10"], ["East", "20"]]), Width);

        Assert.Equal(2, layout.Bars.Count);
        Assert.Equal(layout.Bars[0].Height * 2, layout.Bars[1].Height, 6);
    }
}
