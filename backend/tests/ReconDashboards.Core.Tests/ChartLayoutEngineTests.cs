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
        IReadOnlyList<SortSpec>? sort = null,
        DimensionWells? wells = null,
        TileGridSize? gridSize = null) =>
        new(
            new SnapshotTile(
                "t1", "Sales", chartType,
                new ChartQuerySpec(1, [], [], [], sort ?? [], null, null),
                format, wells, gridSize),
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

    /// <summary>Category ticks for a column chart of `count` long labels.</summary>
    private static IReadOnlyList<LayoutText> CategoryTicks(int count, ChartFormatDoc? format = null)
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()],
                [.. Enumerable.Range(0, count).Select(
                    i => new object?[] { $"Very Long Category Label Number {i}", (double)i })],
                format),
            Width);
        // Category ticks are the only texts carrying a label word.
        return [.. layout.Texts.Where(t => t.Text.StartsWith("Very Long", StringComparison.Ordinal))];
    }

    [Fact]
    public void RoomyCategoryTicksStayUprightAndUntruncated()
    {
        var roomy = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.All(
            roomy.Texts.Where(t => t.Text is "West" or "East"),
            t =>
            {
                Assert.Equal(0, t.RotationDegrees);
                Assert.Equal(TextAnchor.Middle, t.Anchor);
            });
    }

    [Fact]
    public void CrowdedCategoryTicksEscalateAngledThenVerticalBeforeThinning()
    {
        // 24 long labels in a 600px plot: ~23px a slot — enough for -35°.
        var angled = CategoryTicks(24);
        Assert.Equal(24, angled.Count); // every bucket still labeled
        Assert.All(angled, t => Assert.Equal(-35, t.RotationDegrees));
        Assert.Contains(angled, t => t.Text.EndsWith('…')); // elided, never overrunning

        // 40 labels: ~14px a slot is too tight to angle, wide enough to stand up.
        var vertical = CategoryTicks(40);
        Assert.Equal(40, vertical.Count);
        Assert.All(vertical, t => Assert.Equal(-90, t.RotationDegrees));

        // 80 labels: even vertical text collides, so a clean SUBSET is drawn —
        // upright, evenly stepped, and always including the last bucket.
        var thinned = CategoryTicks(80);
        Assert.True(thinned.Count < 80);
        Assert.All(thinned, t => Assert.Equal(0, t.RotationDegrees));
        Assert.Contains(thinned, t => t.Text.StartsWith("Very Long Category Label Number 0", StringComparison.Ordinal));
        Assert.Contains(thinned, t => t.Text.Contains("79", StringComparison.Ordinal));
    }

    [Fact]
    public void AnExplicitXLabelFitModeOverridesTheMeasurement()
    {
        // Two short labels would fit upright; 'vertical' forces the rotation.
        var forced = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(XLabelFit: new AxisLabelFitDoc("vertical"))), Width);
        Assert.All(
            forced.Texts.Where(t => t.Text is "West" or "East"),
            t => Assert.Equal(-90, t.RotationDegrees));

        // 'wrap' has no multi-line tick text server side and degrades to angled,
        // which is what wrap is for: keeping every bucket labeled.
        var wrapped = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(XLabelFit: new AxisLabelFitDoc("wrap"))), Width);
        Assert.All(
            wrapped.Texts.Where(t => t.Text is "West" or "East"),
            t => Assert.Equal(-35, t.RotationDegrees));

        // ...and 'angled' — what the real dashboard's column tile asks for —
        // rotates labels that would otherwise have stood upright.
        var angled = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(XLabelFit: new AxisLabelFitDoc("angled"))), Width);
        Assert.All(
            angled.Texts.Where(t => t.Text is "West" or "East"),
            t => Assert.Equal(-35, t.RotationDegrees));
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

    // ------------------------------------------------------ colorByCategory

    [Fact]
    public void ColorByCategoryGivesEveryBarItsOwnPaletteSlot()
    {
        // Without the flag one measure is one series, so one hue.
        var plain = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.All(plain.Bars, bar => Assert.Equal(ChartPalette.SeriesColor(0), bar.Fill));

        var byCategory = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(ColorByCategory: true)), Width);
        Assert.Equal(ChartPalette.SeriesColor(0), byCategory.Bars[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(1), byCategory.Bars[1].Fill);

        // Horizontal bars take the same path.
        var horizontal = ChartLayoutEngine.Build(
            SimpleTile("bar", new ChartFormatDoc(ColorByCategory: true)), Width);
        Assert.Equal(ChartPalette.SeriesColor(1), horizontal.Bars[1].Fill);
    }

    [Fact]
    public void ColorByCategoryLooksOverridesUpByTheCategoryLabelNotTheMeasure()
    {
        // The real dashboard keys its semantic colors by category label —
        // measure-keyed lookup found nothing and painted every bar slot 0.
        var format = new ChartFormatDoc(
            ColorByCategory: true,
            ColorOverrides: new Dictionary<string, string>
            {
                ["West"] = "#16a34a",
                ["Total"] = "#000000", // the MEASURE name must not win here
            });
        var layout = ChartLayoutEngine.Build(SimpleTile("column", format), Width);

        Assert.Equal("#16a34a", layout.Bars[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(1), layout.Bars[1].Fill);
    }

    [Fact]
    public void ColorByCategoryHuesSurviveACategoryOrderReorder()
    {
        var natural = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(ColorByCategory: true)), Width);
        var reordered = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(ColorByCategory: true, CategoryOrder: ["East", "West"])),
            Width);

        // East drew second (slot 1) and keeps that hue after moving to the front.
        Assert.Equal(natural.Bars[1].Fill, reordered.Bars[0].Fill);
        Assert.Equal(natural.Bars[0].Fill, reordered.Bars[1].Fill);
    }

    [Fact]
    public void ColorByCategoryAppliesOnlyToSingleSeriesColumnAndBar()
    {
        // Two measures = two real series: the flag must not hijack their hues.
        var twoSeries = ChartLayoutEngine.Build(
            TwoSeriesTile("column", new ChartFormatDoc(ColorByCategory: true)), Width);
        Assert.Equal(ChartPalette.SeriesColor(0), twoSeries.Bars[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(0), twoSeries.Bars[1].Fill);

        // ...and a line chart has no per-category marks at all.
        var line = ChartLayoutEngine.Build(
            SimpleTile("line", new ChartFormatDoc(ColorByCategory: true)), Width);
        Assert.Equal(ChartPalette.SeriesColor(0), Assert.Single(line.Lines).Stroke);
    }

    // --------------------------------------------------------- dimension wells

    [Fact]
    public void ALegendOnlyChartFindsItsLegendAtOrdinalZero()
    {
        // The wire dimensions are compacted, so a chart with a legend and NO
        // axis has its legend at ordinal 0. Pinning dimension 0 as "the axis"
        // rendered this as one grey bar with no legend.
        var tile = Tile(
            "column", [Dimension("Status"), Measure()],
            [["Open", 10d], ["Closed", 20d]],
            wells: new DimensionWells(HasAxis: false, HasLegend: true, HasSmallMultiples: false));

        var layout = ChartLayoutEngine.Build(tile, Width);

        Assert.Equal(2, layout.Bars.Count);   // one series per legend value
        Assert.Equal(2, layout.Swatches.Count);
        Assert.Contains(layout.Texts, t => t.Text == "Open");
        Assert.Contains(layout.Texts, t => t.Text == "Closed");
        Assert.Equal(ChartPalette.SeriesColor(0), layout.Bars[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(1), layout.Bars[1].Fill);

        // The same rows read POSITIONALLY are one series over two categories.
        var positional = ChartLayoutEngine.Build(
            Tile("column", [Dimension("Status"), Measure()], [["Open", 10d], ["Closed", 20d]]), Width);
        Assert.Empty(positional.Swatches);
    }

    [Fact]
    public void ASingleSurvivingLegendValueStillLegendsItself()
    {
        // A measure series alone needs no legend; a legend-DIMENSION series does
        // — its only label lives there.
        var tile = Tile(
            "column", [Dimension("Status"), Measure()], [["Open", 10d]],
            wells: new DimensionWells(false, true, false));
        Assert.Single(ChartLayoutEngine.Build(tile, Width).Swatches);
    }

    // ----------------------------------------------------------- gridline rules

    [Fact]
    public void GridlineDefaultsFollowTheVALUEAxisWhicheverWayTheBarsRun()
    {
        // Column: value axis is y, so the rules are horizontal.
        var column = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.NotEmpty(column.GridLines);
        Assert.All(column.GridLines, l => Assert.Equal(l.Y1, l.Y2, 6));

        // Horizontal bar: the value axis is x, so the rules stand up and the
        // category rules stay off — the browser's inverted default.
        var bar = ChartLayoutEngine.Build(SimpleTile("bar"), Width);
        Assert.NotEmpty(bar.GridLines);
        Assert.All(bar.GridLines, l => Assert.Equal(l.X1, l.X2, 6));

        // Explicit flags still win in both directions.
        Assert.Empty(ChartLayoutEngine.Build(SimpleTile("bar", new ChartFormatDoc(GridX: false)), Width).GridLines);
        Assert.Contains(
            ChartLayoutEngine.Build(SimpleTile("bar", new ChartFormatDoc(GridY: true)), Width).GridLines,
            l => Math.Abs(l.Y1 - l.Y2) < 0.001);
    }

    // -------------------------------------------------------- axis tick formats

    [Fact]
    public void AxisFormatsShapeTheTicksAndOnlyTheTicks()
    {
        var compact = new ChartFormatDoc(
            YAxisFormat: new AxisValueFormatDoc("compact"), ShowDataLabels: true, ValueFormat: "#,0");
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], [["West", 600d], ["East", 1200d]], compact), Width);

        // Ticks run 0 / 500 / 1,000 / 1,500 — compact says 1K and 1.5K.
        Assert.Contains(layout.Texts, t => t.Text == "1K");
        Assert.Contains(layout.Texts, t => t.Text == "1.5K");
        Assert.DoesNotContain(layout.Texts, t => t.Text == "1,500");
        // The on-mark labels keep the measure's own valueFormat.
        Assert.Contains(layout.Texts, t => t.Text == "1,200");
    }

    [Fact]
    public void AHorizontalBarReadsItsAxisFormatFromTheXAxisWhereItsValuesLive()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("bar", [Dimension(), Measure()], [["West", 600d], ["East", 1200d]],
                new ChartFormatDoc(XAxisFormat: new AxisValueFormatDoc("compact"))), Width);
        Assert.Contains(layout.Texts, t => t.Text == "1.5K");
    }

    [Fact]
    public void AnUnsetAxisFormatKeepsTheMeasureFormattedTicks()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure("Total", "$#,##0")],
                [["West", 1000d], ["East", 4300d]]), Width);
        Assert.Contains(layout.Texts, t => t.Text == "$5,000");
    }

    // ------------------------------------------------------------ rich titles

    [Fact]
    public void RichHtmlAxisTitlesReplaceThePlainOnesAsStrippedText()
    {
        var format = new ChartFormatDoc(
            XAxisLabel: "ignored",
            XAxisLabelHtml: "<b>Initial package delivered</b> <span style=\"color:#64748b\">(month)</span>",
            YAxisLabelHtml: "<b>Systems</b>");
        var layout = ChartLayoutEngine.Build(SimpleTile("column", format), Width);

        Assert.Contains(layout.Texts, t => t.Text == "Initial package delivered (month)");
        Assert.Contains(layout.Texts, t => t.Text == "Systems");
        Assert.DoesNotContain(layout.Texts, t => t.Text == "ignored");
        Assert.DoesNotContain(layout.Texts, t => t.Text.Contains('<', StringComparison.Ordinal));
    }

    // --------------------------------------------------------- donut centre

    [Fact]
    public void ADonutCarriesItsTotalInTheHoleAndAPieNeverDoes()
    {
        var donut = ChartLayoutEngine.Build(
            Tile("donut", [Dimension(), Measure()], [["West", 50d], ["East", 70d]],
                new ChartFormatDoc(ValueFormat: "#,0")), Width);

        Assert.Contains(donut.Texts, t => t.Text == "Total" && t.FontSize == 10);
        var value = Assert.Single(donut.Texts, t => t.Text == "120");
        Assert.True(value.Bold);
        Assert.Equal(TextAnchor.Middle, value.Anchor);
        // Caption above, value below — the browser's stacking.
        Assert.True(value.Y > donut.Texts.Single(t => t.Text == "Total").Y);

        var pie = ChartLayoutEngine.Build(
            Tile("pie", [Dimension(), Measure()], [["West", 50d], ["East", 70d]]), Width);
        Assert.DoesNotContain(pie.Texts, t => t.Text == "Total");
    }

    [Fact]
    public void ADonutHoleTooSmallToReadSkipsTheTotalRatherThanCrammingIt()
    {
        var tiny = ChartLayoutEngine.Build(
            Tile("donut", [Dimension(), Measure()], [["West", 50d], ["East", 70d]]), 100);
        Assert.DoesNotContain(tiny.Texts, t => t.Text == "Total");
    }

    // ------------------------------------------------------------ pie details

    [Fact]
    public void PieSlicesCarryTheGapAndHairlineTheBrowserDraws()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("pie", [Dimension(), Measure()], [["West", 50d], ["East", 50d]]), Width);

        Assert.All(layout.Arcs, arc =>
        {
            Assert.Equal(1.5, arc.PadDegrees, 6);      // paddingAngle
            Assert.Equal("#ffffff", arc.Stroke);       // the surface hairline
        });
        // The RECORDED sweep stays the honest share; the pad is the painter's.
        Assert.Equal(360, layout.Arcs.Sum(a => a.SweepDegrees), 5);
    }

    [Fact]
    public void AZeroValueCategoryKeepsItsLegendEntryEvenWithNoWedge()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("pie", [Dimension(), Measure()], [["West", 50d], ["Nothing", 0d], ["East", 50d]]), Width);

        Assert.Equal(2, layout.Arcs.Count);   // nothing to draw for zero
        Assert.Equal(3, layout.Swatches.Count); // ...but the reader still sees it
        Assert.Contains(layout.Texts, t => t.Text == "Nothing");
        // The remaining slices still divide the whole circle between them.
        Assert.Equal(360, layout.Arcs.Sum(a => a.SweepDegrees), 5);
    }

    // ------------------------------------------------- reference + trendlines

    [Fact]
    public void AnAverageReferenceLineCrossesThePlotWhereTheAverageSits()
    {
        var format = new ChartFormatDoc(
            ReferenceLines: [new ReferenceLineDoc(
                Kind: "average", Label: "Monthly average", Color: "#eb6834", Dash: "dashed", Width: 2)]);
        var layout = ChartLayoutEngine.Build(SimpleTile("column", format), Width);

        var guide = Assert.Single(layout.Guides);
        Assert.Equal(guide.Y1, guide.Y2, 6);              // a horizontal rule
        Assert.Equal("#eb6834", guide.Stroke);
        Assert.Equal(2, guide.StrokeWidth);
        Assert.NotNull(guide.Dash);
        // 15 sits between the 10 bar's top and the 20 bar's top (y grows down).
        Assert.True(guide.Y1 < layout.Bars[0].Y && guide.Y1 > layout.Bars[1].Y);
        Assert.Contains(layout.Texts, t => t.Text == "Monthly average" && t.Color == "#eb6834");
    }

    [Fact]
    public void AnUnlabelledReferenceLineNamesItsKindAndValueAndCanBeSilenced()
    {
        var stated = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(ReferenceLines: [new ReferenceLineDoc(Kind: "max")])),
            Width);
        Assert.Contains(stated.Texts, t => t.Text == "max 20");

        var quiet = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(
                ReferenceLines: [new ReferenceLineDoc(Kind: "max", ShowLabel: false)])),
            Width);
        Assert.Single(quiet.Guides);
        Assert.DoesNotContain(quiet.Texts, t => t.Text.StartsWith("max", StringComparison.Ordinal));
    }

    [Fact]
    public void AConstantReferenceLineOutsideTheDataGrowsTheAxisToStayVisible()
    {
        var layout = ChartLayoutEngine.Build(
            SimpleTile("column", new ChartFormatDoc(
                ReferenceLines: [new ReferenceLineDoc(Kind: "constant", Value: 500)])),
            Width);

        var guide = Assert.Single(layout.Guides);
        // Inside the plot rather than clipped above it, and the bars shrank to
        // make room for the extended domain.
        Assert.True(guide.Y1 > 0);
        Assert.True(layout.Bars.Max(b => b.Height) < 100);
        Assert.Contains(layout.Texts, t => t.Text == "500");
    }

    [Fact]
    public void AHorizontalBarPutsItsReferenceLineOnTheValueAxisToo()
    {
        var layout = ChartLayoutEngine.Build(
            SimpleTile("bar", new ChartFormatDoc(ReferenceLines: [new ReferenceLineDoc(Kind: "average")])),
            Width);
        var guide = Assert.Single(layout.Guides);
        Assert.Equal(guide.X1, guide.X2, 6); // vertical, standing on the x axis
    }

    [Fact]
    public void AMovingAverageTrendlineStartsOnceItsWindowFills()
    {
        var format = new ChartFormatDoc(
            Trendlines: [new TrendlineDoc(
                Kind: "movingAverage", Window: 3, SeriesKey: "Total", Color: "#8b5cf6", Dash: "dotted")]);
        var layout = ChartLayoutEngine.Build(
            Tile("line", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d], ["2026-03-01", 30d], ["2026-04-01", 40d]],
                format),
            Width);

        Assert.Equal(2, layout.Lines.Count); // the series + its overlay
        var overlay = Assert.Single(layout.Lines, l => l.Stroke == "#8b5cf6");
        Assert.Equal(2, overlay.Points.Count); // the first two buckets have no full window
        Assert.NotNull(overlay.Dash);
        Assert.False(overlay.Curve); // a fitted guide is straight, like the browser's
    }

    [Fact]
    public void ALinearTrendlineSpansEveryBucketAndFollowsTheData()
    {
        var layout = ChartLayoutEngine.Build(
            Tile("line", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d], ["2026-03-01", 30d]],
                new ChartFormatDoc(Trendlines: [new TrendlineDoc(Kind: "linear", Color: "#333333")])),
            Width);

        var overlay = Assert.Single(layout.Lines, l => l.Stroke == "#333333");
        Assert.Equal(3, overlay.Points.Count);
        // A perfectly linear series fits itself: the overlay lands on the data.
        var series = Assert.Single(layout.Lines, l => l.Stroke != "#333333");
        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(series.Points[i].Y, overlay.Points[i].Y, 5);
        }
    }

    // ------------------------------------------------------------ line polish

    [Fact]
    public void LineStylesCarryTheirDashAndWidthAndLinesCurveLikeTheBrowser()
    {
        var format = new ChartFormatDoc(
            LineStyles: new Dictionary<string, SeriesLineStyleDoc>
            {
                ["Total"] = new(Dash: "dashed", Width: 3),
            });
        var line = ChartLayoutEngine.Build(
            Tile("line", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d]], format),
            Width);

        var polyline = Assert.Single(line.Lines);
        Assert.Equal(3, polyline.StrokeWidth);
        Assert.Equal([8d, 5d], polyline.Dash!);
        Assert.True(polyline.Curve); // recharts type="monotone"

        // The area's fill follows the same curve over its DATA points only —
        // the two baseline corners always join straight.
        var area = ChartLayoutEngine.Build(
            Tile("area", [DateDimension(), Measure()],
                [["2026-01-01", 10d], ["2026-02-01", 20d], ["2026-03-01", 15d]]),
            Width);
        var polygon = Assert.Single(area.Areas);
        Assert.Equal(5, polygon.Points.Count);
        Assert.Equal(3, polygon.CurvePoints);
    }

    [Fact]
    public void BarsRoundTheirValueEndAndStacksSeparateWithASurfaceHairline()
    {
        var column = ChartLayoutEngine.Build(SimpleTile("column"), Width);
        Assert.All(column.Bars, bar =>
        {
            Assert.Equal(4, bar.CornerRadius);
            Assert.Equal(RectCorners.Top, bar.Corners);
        });

        var negative = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], [["West", -10d]]), Width);
        Assert.Equal(RectCorners.Bottom, Assert.Single(negative.Bars).Corners);

        Assert.All(
            ChartLayoutEngine.Build(SimpleTile("bar"), Width).Bars,
            bar => Assert.Equal(RectCorners.Right, bar.Corners));

        // Stacked: only the OUTERMOST member rounds, and every member carries
        // the 2px surface separator.
        var stacked = ChartLayoutEngine.Build(TwoSeriesTile("stackedColumn"), Width);
        Assert.All(stacked.Bars, bar =>
        {
            Assert.Equal("#ffffff", bar.Stroke);
            Assert.Equal(2, bar.StrokeWidth);
        });
        Assert.Equal(2, stacked.Bars.Count(b => b.Corners == RectCorners.Top));
        Assert.Equal(2, stacked.Bars.Count(b => b.Corners == RectCorners.None));
    }

    // ------------------------------------------------------- shaping options

    [Fact]
    public void TrimEmptyEdgesDropsTheWarmUpAndTailButKeepsInteriorGaps()
    {
        object?[][] rows =
        [
            ["A", null], ["B", 10d], ["C", null], ["D", 20d], ["E", null],
        ];

        var kept = ChartLayoutEngine.Build(Tile("column", [Dimension(), Measure()], rows), Width);
        Assert.Equal(5, kept.Texts.Count(t => t.Text is "A" or "B" or "C" or "D" or "E"));

        var trimmed = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], rows, new ChartFormatDoc(TrimEmptyEdges: true)), Width);
        Assert.Equal(3, trimmed.Texts.Count(t => t.Text is "B" or "C" or "D"));
        Assert.DoesNotContain(trimmed.Texts, t => t.Text is "A" or "E");
        Assert.Equal(2, trimmed.Bars.Count);
    }

    [Fact]
    public void BlankDateBucketsDropByDefaultAndCanBeKeptOnRequest()
    {
        object?[][] rows = [[null, 5d], ["2026-01-01", 10d]];

        var dropped = ChartLayoutEngine.Build(Tile("column", [DateDimension(), Measure()], rows), Width);
        Assert.Single(dropped.Bars);

        var kept = ChartLayoutEngine.Build(
            Tile("column", [DateDimension(), Measure()], rows, new ChartFormatDoc(ExcludeBlankDates: false)),
            Width);
        Assert.Equal(2, kept.Bars.Count);
        Assert.Contains(kept.Texts, t => t.Text == "(Blank)");
    }

    // ------------------------------------------------------------ presentation

    [Fact]
    public void LegendPositionTopSitsAboveThePlotInsteadOfBelowIt()
    {
        var bottom = ChartLayoutEngine.Build(TwoSeriesTile("column"), Width);
        var top = ChartLayoutEngine.Build(
            TwoSeriesTile("column", new ChartFormatDoc(LegendPosition: "top")), Width);

        Assert.Equal(2, top.Swatches.Count);
        Assert.True(top.Swatches[0].Y < bottom.Swatches[0].Y);
        // ...and the plot moved down to make room for it.
        Assert.True(top.Bars.Min(b => b.Y) > bottom.Bars.Min(b => b.Y));
    }

    [Fact]
    public void TextStylesReachTheAxisTitlesAndTheLegend()
    {
        var format = new ChartFormatDoc(
            AxisTitleStyle: new ChartTextStyleDoc(FontSize: 16, Bold: true, Color: "#123456"),
            LegendStyle: new ChartTextStyleDoc(Bold: true));
        var layout = ChartLayoutEngine.Build(TwoSeriesTile("column", format), Width);

        var title = Assert.Single(layout.Texts, t => t.Text == "Region");
        Assert.Equal(16, title.FontSize);
        Assert.True(title.Bold);
        Assert.Equal("#123456", title.Color);

        Assert.True(layout.Texts.Single(t => t.Text == "Target").Bold);
    }

    [Fact]
    public void TheImageBoxFollowsTheTilesOwnProportions()
    {
        // No layout geometry: the historical 5:3 box.
        Assert.Equal(Height, ChartLayoutEngine.Build(SimpleTile("column"), Width).Height);

        // A half-width, 8-row tile is close to square-ish; a full-width strip is
        // squat; a narrow tall tile hits the ceiling instead of a 5:3 lie.
        var normal = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], [["West", 10d]], gridSize: new TileGridSize(12, 8)),
            Width);
        Assert.Equal(291, normal.Height);

        var wide = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], [["West", 10d]], gridSize: new TileGridSize(24, 4)),
            Width);
        Assert.Equal(200, wide.Height); // the floor, not a sliver

        var tall = ChartLayoutEngine.Build(
            Tile("column", [Dimension(), Measure()], [["West", 10d]], gridSize: new TileGridSize(6, 20)),
            Width);
        Assert.Equal(900, tall.Height);
    }

    // ------------------------------------------------------------ gantt subset

    [Fact]
    public void GanttHonorsBarSizeCornerRadiusSingleColorAndRowBanding()
    {
        var format = new ChartFormatDoc(
            Theme: "ocean",
            Gantt: new GanttOptionsDoc(
                BarSize: 14, CornerRadius: 4, RowBanding: true, SingleColor: true, Color: "#2a78d6"));
        var layout = ChartLayoutEngine.Build(
            Tile("gantt", [Dimension("Task"), Dimension("Area"), Measure("Start"), Measure("Finish")],
                [
                    ["Design", "North", "2026-01-01", "2026-02-01"],
                    ["Build", "South", "2026-02-01", "2026-03-01"],
                ],
                format),
            Width);

        var bars = layout.Bars.Where(b => Math.Abs(b.Height - 14) < 0.001).ToList();
        Assert.Equal(2, bars.Count);
        Assert.All(bars, bar =>
        {
            Assert.Equal("#2a78d6", bar.Fill);              // singleColor beats the group hues
            Assert.Equal(4, bar.CornerRadius);
            Assert.Equal(RectCorners.All, bar.Corners);
        });
        // Row banding paints a wash behind every OTHER row...
        Assert.Contains(layout.Bars, b => b.Opacity < 0.1 && b.Height > 20);
        // ...and a single-color gantt drops the group legend its swatches would lie about.
        Assert.Empty(layout.Swatches);
    }

    [Fact]
    public void TheGanttTodayMarkerOnlyAppearsWhileTodayIsInsideTheWindow()
    {
        var today = DateTime.UtcNow.Date;
        var inWindow = ChartLayoutEngine.Build(
            Tile("gantt", [Dimension("Task"), Measure("Start"), Measure("Finish")],
                [["Now", today.AddDays(-10), today.AddDays(10)]],
                new ChartFormatDoc(Gantt: new GanttOptionsDoc(ShowToday: true, TodayColor: "#dc2626"))),
            Width);
        Assert.Equal("#dc2626", Assert.Single(inWindow.Guides).Stroke);

        var past = ChartLayoutEngine.Build(
            Tile("gantt", [Dimension("Task"), Measure("Start"), Measure("Finish")],
                [["Then", new DateTime(2000, 1, 1), new DateTime(2000, 6, 1)]],
                new ChartFormatDoc(Gantt: new GanttOptionsDoc(ShowToday: true))),
            Width);
        Assert.Empty(past.Guides);
    }

    // ------------------------------------------------------- small multiples

    [Fact]
    public void ASmallMultiplesTileReportsWhatWasFoldedTogether()
    {
        var tile = Tile(
            "column",
            [Dimension("Region"), Dimension("Segment"), Dimension("Status"), Measure()],
            [
                ["West", "Retail", "open", 10d],
                ["West", "Retail", "closed", 99d],
                ["East", "Retail", "open", 20d],
            ],
            wells: new DimensionWells(HasAxis: true, HasLegend: true, HasSmallMultiples: true));

        var note = ChartLayoutEngine.DescribeSmallMultiples(tile);
        Assert.NotNull(note);
        Assert.Equal(2, note.PanelCount);
        Assert.Equal("Status", note.Dimension);

        // A chart with no small-multiples well has nothing to disclose.
        Assert.Null(ChartLayoutEngine.DescribeSmallMultiples(
            Tile("column", [Dimension(), Measure()], [["West", 10d]],
                wells: new DimensionWells(true, false, false))));
    }

    // ------------------------------------------- the three reported regressions
    // The format blocks below are VERBATIM from the seeded showcase dashboard
    // (Scripts/db/rcd-showcase-dashboard.json) whose emailed charts the owner
    // reviewed — parsed through the real parser, so a field the parser drops
    // fails the test rather than quietly reverting the tile.

    private static ChartFormatDoc RealFormat(string formatJson)
    {
        var layout = $$"""
            { "version": 1, "tiles": [], "slicers": [],
              "pages": [{ "id": "p1", "name": "Fleet Overview", "tiles": [{
                "id": "t1", "kind": "chart", "layout": { "x": 0, "y": 8, "w": 14, "h": 9 },
                "chart": { "id": "c1", "type": "column", "title": "T", "query": {
                  "axis": { "table": "public.customers", "column": "region" },
                  "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] },
                  "format": {{formatJson}} } }]}] }
            """;
        return Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, 1)).Tiles).Format!;
    }

    [Fact]
    public void SystemsByBusinessAreaKeepsItsPerCategoryColorsAndAngledMonthlyTicks()
    {
        var format = RealFormat("""
            {
              "theme": "default",
              "colorByCategory": true,
              "showDataLabels": true,
              "valueFormat": "#,0",
              "yAxisFormat": { "kind": "compact" },
              "xLabelFit": { "mode": "angled" },
              "gridY": true,
              "tooltip": { "accentBorder": true },
              "container": {
                "hideHeader": true,
                "innerTitleHtml": "<p><b>Systems by Business Area</b> <span style=\"color:#64748b\">&mdash; top 15 by system count</span></p>"
              }
            }
            """);

        var rows = Enumerable.Range(0, 15)
            .Select(i => new object?[] { $"Business Area {i}", (double)(1500 - (i * 90)) })
            .ToArray();
        var layout = ChartLayoutEngine.Build(
            Tile("column", [Dimension("Business area"), Measure("Systems")], rows, format), Width);

        // Fifteen bars, fifteen palette slots (the reported "lost its colors").
        Assert.Equal(15, layout.Bars.Count);
        Assert.Equal(ChartPalette.SeriesColor(0), layout.Bars[0].Fill);
        Assert.Equal(ChartPalette.SeriesColor(1), layout.Bars[1].Fill);
        Assert.Equal(8, layout.Bars.Select(b => b.Fill).Distinct().Count()); // the 8 slots, wrapped

        // Angled category ticks, as the tile asks for.
        Assert.All(
            layout.Texts.Where(t => t.Text.StartsWith("Business Area", StringComparison.Ordinal)),
            t => Assert.Equal(-35, t.RotationDegrees));

        // Compact value ticks, valueFormat data labels.
        Assert.Contains(layout.Texts, t => t.Text == "1.5K");
        Assert.Contains(layout.Texts, t => t.Text == "1,500");
    }

    [Fact]
    public void DevicesByRevalidationStatusKeepsItsFiveSemanticColorsAndUprightGrid()
    {
        var format = RealFormat("""
            {
              "colorByCategory": true,
              "colorOverrides": {
                "Adequate": "#16a34a",
                "Inadequate": "#dc2626",
                "Pressure Drop": "#f59e0b",
                "Not Evaluated": "#64748b",
                "#N/A": "#cbd5e1"
              },
              "showDataLabels": true,
              "valueFormat": "#,0",
              "xAxisFormat": { "kind": "compact" },
              "tooltip": { "accentBorder": true },
              "container": { "hideHeader": true, "innerTitleHtml": "<p><b>Devices by Revalidation Status</b></p>" }
            }
            """);

        object?[][] rows =
        [
            ["Adequate", 4200d], ["Inadequate", 1100d], ["Pressure Drop", 600d],
            ["Not Evaluated", 300d], ["#N/A", 120d],
        ];
        var layout = ChartLayoutEngine.Build(
            Tile("bar", [Dimension("Reval status"), Measure("Devices")], rows, format), Width);

        // Every override is keyed by the CATEGORY label; measure-keyed lookup
        // found none of them and painted all five bars slot 0.
        Assert.Equal(
            ["#16a34a", "#dc2626", "#f59e0b", "#64748b", "#cbd5e1"],
            layout.Bars.Select(b => b.Fill));

        // A horizontal bar's value axis is x, so its gridlines stand up.
        Assert.NotEmpty(layout.GridLines);
        Assert.All(layout.GridLines, l => Assert.Equal(l.X1, l.X2, 6));

        // Compact ticks on the value axis, full numbers on the marks.
        Assert.Contains(layout.Texts, t => t.Text.EndsWith('K'));
        Assert.Contains(layout.Texts, t => t.Text == "4,200");
    }

    [Fact]
    public void PackageDeliveryThroughputStopsPrintingEveryMonthAndDrawsItsGuides()
    {
        var format = RealFormat("""
            {
              "theme": "ocean",
              "dateFormat": "monthYear",
              "valueFormat": "#,0",
              "yAxisFormat": { "kind": "compact" },
              "gridY": true,
              "zoom": { "brush": true, "dragZoom": true, "dragAction": "crossFilter" },
              "lineStyles": { "Systems": { "dash": "solid", "width": 2 } },
              "referenceLines": [{
                "id": "ec8aa2e9", "kind": "average", "measureKey": "Systems",
                "label": "Monthly average", "color": "#eb6834", "dash": "dashed",
                "width": 2, "showLabel": true
              }],
              "trendlines": [{
                "id": "4db23ba5", "kind": "movingAverage", "window": 3,
                "seriesKey": "Systems", "color": "#8b5cf6", "dash": "dotted", "width": 2
              }],
              "xAxisLabelHtml": "<b>Initial package delivered</b> <span style=\"color:#64748b\">(month)</span>",
              "yAxisLabelHtml": "<b>Systems</b>",
              "tooltip": { "accentBorder": true },
              "container": { "hideHeader": true, "innerTitleHtml": "<p><b>Package Delivery Throughput by Month</b></p>" }
            }
            """);

        // Three years of months — the jumble the owner reported.
        var rows = Enumerable.Range(0, 36)
            .Select(i => new object?[]
            {
                new DateTime(2024, 1, 1).AddMonths(i),
                (double)(20 + (i % 7 * 5)),
            })
            .ToArray();
        var layout = ChartLayoutEngine.Build(
            Tile("area", [DateDimension("Delivered"), Measure("Systems")], rows, format), Width);

        // Every month still labeled — but standing up, not overprinting at -30.
        var ticks = layout.Texts.Where(t => t.Text.Contains("202", StringComparison.Ordinal)).ToList();
        Assert.Equal(36, ticks.Count);
        Assert.All(ticks, t => Assert.Equal(-90, t.RotationDegrees));
        Assert.Contains(ticks, t => t.Text == "Jan 2024");

        // The rich axis titles the tile actually sets, as plain text.
        Assert.Contains(layout.Texts, t => t.Text == "Initial package delivered (month)");
        Assert.Contains(layout.Texts, t => t.Text == "Systems" && t.RotationDegrees == -90);

        // The average guide and the 3-month moving average both draw.
        var guide = Assert.Single(layout.Guides);
        Assert.Equal("#eb6834", guide.Stroke);
        Assert.Contains(layout.Texts, t => t.Text == "Monthly average");
        var trend = Assert.Single(layout.Lines, l => l.Stroke == "#8b5cf6");
        Assert.Equal(34, trend.Points.Count); // the first two months have no window
        Assert.NotNull(trend.Dash);

        // The area itself keeps the theme hue and the browser's curve.
        Assert.Equal("#1868ae", Assert.Single(layout.Areas).Fill);
        Assert.True(layout.Lines.Single(l => l.Stroke == "#1868ae").Curve);
    }
}
