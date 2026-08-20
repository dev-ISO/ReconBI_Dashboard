using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Rendering;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// A SMOKE test, deliberately not a pixel test: the layout record is where
/// behavior is asserted (ChartLayoutEngineTests). What cannot be proved there is
/// that every primitive the engine emits actually survives the Skia call it maps
/// to — a dash effect, per-corner radii, a stroked arc, a cubic path. Those are
/// runtime APIs, so "it compiles" says nothing; a chart that throws here would
/// downgrade a real tile to its table at 6 a.m.
/// </summary>
public class SkiaChartImageRendererTests
{
    private static readonly SkiaChartImageRenderer Renderer = new();

    private static ResultColumnPlan Dimension(string label = "Region") =>
        new("dim0", label, ResultColumnRole.Dimension, NormalizedType.Text,
            "public.customers.region", null, null);

    private static ResultColumnPlan DateDimension() =>
        new("dim0", "Month", ResultColumnRole.Dimension, NormalizedType.Date,
            "public.orders.order_date", DateBucket.Month, null);

    private static ResultColumnPlan Measure(string label = "Total") =>
        new("meas0", label, ResultColumnRole.Measure, NormalizedType.Decimal,
            "public.orders.order_total", null, null);

    private static RenderedTile Tile(
        string chartType, IReadOnlyList<ResultColumnPlan> columns,
        IReadOnlyList<object?[]> rows, ChartFormatDoc? format = null) =>
        new(
            new SnapshotTile(
                "t1", "Sales", chartType, new ChartQuerySpec(1, [], [], [], [], null, null), format),
            columns, rows, Error: null);

    private static void AssertDraws(RenderedTile tile)
    {
        var png = Renderer.RenderPng(ChartLayoutEngine.Build(tile, 600));
        Assert.True(png.Length > 100, "the painter produced no image");
        // PNG magic — proof it is an encoded image, not an empty buffer.
        Assert.Equal([0x89, 0x50, 0x4E, 0x47], png[..4]);
    }

    [Fact]
    public void RoundedBarsAndStackSeparatorsPaint()
    {
        AssertDraws(Tile("column", [Dimension(), Measure()], [["West", 10d], ["East", -20d]]));
        AssertDraws(Tile("bar", [Dimension(), Measure()], [["West", 10d], ["East", 20d]]));
        AssertDraws(Tile(
            "stackedColumn", [Dimension(), Measure("Total"), Measure("Target")],
            [["West", 10d, 5d], ["East", 20d, 15d]]));
    }

    [Fact]
    public void CurvedAndDashedLinesPaint()
    {
        var format = new ChartFormatDoc(
            LineStyles: new Dictionary<string, SeriesLineStyleDoc> { ["Total"] = new("dashed", 3) },
            ReferenceLines: [new ReferenceLineDoc(Kind: "average", Color: "#eb6834", Dash: "dashed")],
            Trendlines: [new TrendlineDoc(Kind: "movingAverage", Window: 3, Color: "#8b5cf6", Dash: "dotted")]);
        object?[][] rows =
        [
            ["2026-01-01", 10d], ["2026-02-01", 20d], ["2026-03-01", 15d],
            ["2026-04-01", null], ["2026-05-01", 40d], ["2026-06-01", 35d],
        ];

        AssertDraws(Tile("line", [DateDimension(), Measure()], rows, format));
        AssertDraws(Tile("area", [DateDimension(), Measure()], rows, format));
    }

    [Fact]
    public void GappedStrokedSlicesAndTheDonutTotalPaint()
    {
        object?[][] rows = [["West", 50d], ["Nothing", 0d], ["East", 30d], ["North", 20d]];
        AssertDraws(Tile("pie", [Dimension(), Measure()], rows));
        AssertDraws(Tile("donut", [Dimension(), Measure()], rows, new ChartFormatDoc(ValueFormat: "#,0")));
    }

    [Fact]
    public void TheGanttSubsetPaintsIncludingItsTodayMarker()
    {
        var today = DateTime.UtcNow.Date;
        AssertDraws(Tile(
            "gantt", [Dimension("Task"), Measure("Start"), Measure("Finish")],
            [["Now", today.AddDays(-10), today.AddDays(10)], ["Next", today, today.AddDays(20)]],
            new ChartFormatDoc(Gantt: new GanttOptionsDoc(
                BarSize: 14, CornerRadius: 4, ShowToday: true, TodayColor: "#dc2626",
                RowBanding: true, SingleColor: true, Color: "#2a78d6"))));
    }

    [Fact]
    public void RotatedAndThinnedAxisLabelsPaint()
    {
        foreach (var count in new[] { 24, 40, 80 })
        {
            AssertDraws(Tile(
                "column", [Dimension(), Measure()],
                [.. Enumerable.Range(0, count).Select(
                    i => new object?[] { $"Very Long Category Label Number {i}", (double)i })]));
        }
    }
}
