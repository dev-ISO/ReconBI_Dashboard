using System.Globalization;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Rendering;

/// <summary>
/// Pure geometry: an executed snapshot tile + its parsed ChartFormatDoc →
/// <see cref="ChartLayout"/> primitives, no drawing dependency
/// (EMAIL-CONTENT-DESIGN). Shaping mirrors the frontend's chartData.ts with
/// the pinned deterministic pivot (spec §13): dimension column 0 is the
/// category axis, column 1 the series split when two or more dimensions
/// exist. A third (small-multiples) dimension is IGNORED in v1 — rows sharing
/// (category, series) collapse last-write-wins; a panel grid inside one email
/// image would be unreadable at 600px anyway. Text widths are estimated at
/// 0.55×fontSize per char (spec §14); the painter draws exactly this layout
/// and never re-measures.
/// </summary>
public static class ChartLayoutEngine
{
    /// <summary>Families delivered as PNG; kpi/table/error tiles keep their HTML blocks.</summary>
    private static readonly HashSet<string> VisualTypes = new(StringComparer.Ordinal)
    {
        "column", "bar", "stackedColumn", "stackedBar", "line", "area", "pie", "donut", "scatter", "gantt",
    };

    public static bool IsVisual(string chartType) => VisualTypes.Contains(chartType);

    private const double TickFontSize = 11;
    private const double TitleFontSize = 12;
    private const double LegendFontSize = 11;
    private const double DataLabelFontSize = 10;
    private const double GanttRowHeight = 28;
    private const int GanttMaxHeight = 900;

    public static ChartLayout Build(RenderedTile tile, int logicalWidth)
    {
        var type = tile.Tile.ChartType;
        return type switch
        {
            "pie" or "donut" => BuildPie(tile, logicalWidth, donut: type == "donut"),
            "scatter" => BuildScatter(tile, logicalWidth),
            "gantt" => BuildGantt(tile, logicalWidth),
            _ => BuildCartesian(tile, logicalWidth, type),
        };
    }

    /// <summary>Default logical size is 5:3 (600×360 at the standard width).</summary>
    private static int DefaultHeight(int width) => (int)Math.Round(width * 3.0 / 5.0);

    private static double Estimate(string text, double fontSize) => text.Length * 0.55 * fontSize;

    private static bool ShowLegend(ChartFormatDoc? format) => format?.ShowLegend != false;

    private static bool LegendRight(ChartFormatDoc? format) => format?.LegendPosition == "right";

    // ------------------------------------------------------------- shaping

    private sealed record Series(
        string StyleKey, string Label, string Color, ResultColumnPlan? Column, double?[] Values);

    private sealed record CartesianData(
        IReadOnlyList<string> Categories,
        IReadOnlyList<Series> Series,
        ResultColumnPlan? AxisColumn,
        ResultColumnPlan? ValueColumn);

    private static string DisplayLabel(string defaultLabel, ChartFormatDoc? format) =>
        format?.SeriesLabels is { } labels && labels.TryGetValue(defaultLabel, out var renamed)
            ? renamed
            : defaultLabel;

    private static double? ToNumber(object? value)
    {
        if (value is null)
        {
            return null;
        }

        if (ChartValueFormats.TryToNumber(value, out var number))
        {
            return number;
        }

        return value is string s
            && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    /// <summary>Type-tagged raw-cell identity so colliding formatted labels never merge categories.</summary>
    private static string RawKeyOf(object? value) =>
        value is null
            ? "\u0000null"
            : value.GetType().Name + "\u0000" + Convert.ToString(value, CultureInfo.InvariantCulture);

    private static CartesianData ShapeCartesian(RenderedTile tile, ChartFormatDoc? format, bool comboCapable)
    {
        var format0 = format;
        var dimIdx = new List<int>();
        var measIdx = new List<int>();
        for (var i = 0; i < tile.Columns.Count; i++)
        {
            (tile.Columns[i].Role == ResultColumnRole.Dimension ? dimIdx : measIdx).Add(i);
        }

        var axisIdx = dimIdx.Count > 0 ? dimIdx[0] : -1;
        var axisColumn = axisIdx >= 0 ? tile.Columns[axisIdx] : null;
        var legendIdx = dimIdx.Count >= 2 ? dimIdx[1] : -1;

        // Blank DATE buckets are dropped by default, matching the frontend's
        // excludeBlankDates=TRUE doctrine (a "(Blank)" time bucket skews the
        // series); the opt-out flag is not among the consumed format fields.
        IEnumerable<object?[]> source = tile.Rows;
        if (axisColumn?.DateBucket is not null)
        {
            source = source.Where(row => axisIdx < row.Length && row[axisIdx] is not null);
        }

        var rows = source.ToList();
        string CategoryLabel(object?[] row) =>
            axisColumn is null
                ? ""
                : ChartValueFormats.FormatCategoryLabel(
                    axisIdx < row.Length ? row[axisIdx] : null, axisColumn,
                    format0?.DateFormat, format0?.DateFormatPattern);

        if (legendIdx == -1)
        {
            // One series per measure column.
            var categories = rows.Select(CategoryLabel).ToList();
            var series = measIdx.Select((columnIndex, i) =>
            {
                var column = tile.Columns[columnIndex];
                return new Series(
                    column.Label,
                    DisplayLabel(column.Label, format),
                    ChartPalette.SeriesColor(i, column.Label, format?.ColorOverrides, format?.Theme),
                    column,
                    rows.Select(row => ToNumber(columnIndex < row.Length ? row[columnIndex] : null)).ToArray());
            }).ToList();

            return ApplyManualOrder(categories, series, axisColumn, format,
                valueColumn: measIdx.Count > 0 ? tile.Columns[measIdx[0]] : null);
        }

        // Legend pivot: one series per legend value over the FIRST measure —
        // except line/area with several measures, which keep them all as
        // (measure × legend value) combos, measure-major (chartData.ts).
        var legendColumn = tile.Columns[legendIdx];
        var comboMode = comboCapable && measIdx.Count > 1;
        var pivotMeasures = comboMode ? measIdx : measIdx.Take(1).ToList();

        var byAxis = new List<(string Label, Dictionary<string, double?> Cells)>();
        var byAxisKey = new Dictionary<string, int>(StringComparer.Ordinal);
        var legendValues = new List<string>();

        foreach (var row in rows)
        {
            var legendLabel = ChartValueFormats.FormatCellValue(
                legendIdx < row.Length ? row[legendIdx] : null, legendColumn);
            if (!legendValues.Contains(legendLabel))
            {
                legendValues.Add(legendLabel);
            }

            var axisKey = axisColumn is null ? "" : RawKeyOf(axisIdx < row.Length ? row[axisIdx] : null);
            if (!byAxisKey.TryGetValue(axisKey, out var itemIndex))
            {
                itemIndex = byAxis.Count;
                byAxisKey.Add(axisKey, itemIndex);
                byAxis.Add((CategoryLabel(row), new Dictionary<string, double?>(StringComparer.Ordinal)));
            }

            foreach (var measureIndex in pivotMeasures)
            {
                // U+001F separates combo keys - it never appears in labels or
                // formatted cells, so combo keys cannot collide (chartData.ts).
                var key = comboMode
                    ? tile.Columns[measureIndex].Label + "\u001f" + legendLabel
                    : legendLabel;
                byAxis[itemIndex].Cells[key] =
                    ToNumber(measureIndex < row.Length ? row[measureIndex] : null);
            }
        }

        var pivotSeries = new List<Series>();
        if (comboMode)
        {
            var comboIndex = 0;
            foreach (var measureIndex in pivotMeasures)
            {
                var measure = tile.Columns[measureIndex];
                foreach (var legendValue in legendValues)
                {
                    var name = $"{measure.Label} — {legendValue}";
                    var cellKey = measure.Label + "\u001f" + legendValue;
                    pivotSeries.Add(new Series(
                        name,
                        DisplayLabel(name, format),
                        ChartPalette.SeriesColor(comboIndex, name, format?.ColorOverrides, format?.Theme),
                        measure,
                        byAxis.Select(item => item.Cells.GetValueOrDefault(cellKey)).ToArray()));
                    comboIndex++;
                }
            }
        }
        else
        {
            var measure = pivotMeasures.Count > 0 ? tile.Columns[pivotMeasures[0]] : null;
            for (var i = 0; i < legendValues.Count; i++)
            {
                var legendValue = legendValues[i];
                pivotSeries.Add(new Series(
                    legendValue,
                    DisplayLabel(legendValue, format),
                    ChartPalette.SeriesColor(i, legendValue, format?.ColorOverrides, format?.Theme),
                    measure,
                    byAxis.Select(item => item.Cells.GetValueOrDefault(legendValue)).ToArray()));
            }
        }

        return ApplyManualOrder(
            byAxis.Select(item => item.Label).ToList(), pivotSeries, axisColumn, format,
            valueColumn: pivotMeasures.Count > 0 ? tile.Columns[pivotMeasures[0]] : null);
    }

    /// <summary>
    /// categoryOrder / seriesOrder at the very END of shaping — after colors
    /// are assigned, so a reorder never re-hues (chartData.ts applyManualOrder).
    /// </summary>
    private static CartesianData ApplyManualOrder(
        IReadOnlyList<string> categories, IReadOnlyList<Series> series,
        ResultColumnPlan? axisColumn, ChartFormatDoc? format, ResultColumnPlan? valueColumn)
    {
        var rowIndices = ChartOrdering.ReconcileOrderBy(
            format?.CategoryOrder, Enumerable.Range(0, categories.Count).ToArray(), i => categories[i]);
        var orderedCategories = rowIndices.Select(i => categories[i]).ToArray();
        var orderedSeries = ChartOrdering.ReconcileOrderBy(format?.SeriesOrder, series, s => s.StyleKey)
            .Select(s => s with { Values = rowIndices.Select(i => s.Values[i]).ToArray() })
            .ToList();
        return new CartesianData(orderedCategories, orderedSeries, axisColumn, valueColumn);
    }

    // -------------------------------------------------------------- builder

    private sealed class LayoutBuilder(int width, int height)
    {
        public int Width { get; } = width;
        public int Height { get; } = height;
        public List<LayoutLine> GridLines { get; } = [];
        public List<LayoutLine> AxisLines { get; } = [];
        public List<LayoutRect> Bars { get; } = [];
        public List<LayoutPolygon> Areas { get; } = [];
        public List<LayoutPolyline> Lines { get; } = [];
        public List<LayoutArc> Arcs { get; } = [];
        public List<LayoutCircle> Dots { get; } = [];
        public List<LayoutRect> Swatches { get; } = [];
        public List<LayoutText> Texts { get; } = [];

        public ChartLayout ToLayout() => new(
            Width, Height, ChartPalette.Background,
            GridLines, AxisLines, Bars, Areas, Lines, Arcs, Dots, Swatches, Texts);
    }

    // --------------------------------------------------------------- legend

    private sealed record LegendItem(string Label, string Color);

    /// <summary>Bottom-legend total height for the given items (0 = no legend).</summary>
    private static double BottomLegendHeight(IReadOnlyList<LegendItem> items, int width)
    {
        if (items.Count == 0)
        {
            return 0;
        }

        var rowCount = 1;
        var x = 0d;
        foreach (var item in items)
        {
            var itemWidth = 10 + 5 + Estimate(item.Label, LegendFontSize) + 14;
            if (x + itemWidth > width - 16 && x > 0)
            {
                rowCount++;
                x = 0;
            }

            x += itemWidth;
        }

        return rowCount * 16 + 6;
    }

    private static void EmitBottomLegend(
        LayoutBuilder b, IReadOnlyList<LegendItem> items, double startX, double topY)
    {
        var x = startX;
        var y = topY;
        foreach (var item in items)
        {
            var itemWidth = 10 + 5 + Estimate(item.Label, LegendFontSize) + 14;
            if (x + itemWidth > b.Width - 16 && x > startX)
            {
                x = startX;
                y += 16;
            }

            b.Swatches.Add(new LayoutRect(x, y + 2, 10, 10, item.Color));
            b.Texts.Add(new LayoutText(x + 15, y + 11, item.Label, LegendFontSize, ChartPalette.Text2));
            x += itemWidth;
        }
    }

    private static double RightLegendWidth(IReadOnlyList<LegendItem> items, int width) =>
        items.Count == 0
            ? 0
            : Math.Min(items.Max(i => Estimate(i.Label, LegendFontSize)) + 26, width * 0.32);

    private static void EmitRightLegend(
        LayoutBuilder b, IReadOnlyList<LegendItem> items, double x, double topY, double maxHeight)
    {
        var capacity = Math.Max(1, (int)(maxHeight / 17));
        var shown = items.Count <= capacity ? items.Count : capacity - 1;
        var y = topY;
        for (var i = 0; i < shown; i++)
        {
            b.Swatches.Add(new LayoutRect(x, y + 2, 10, 10, items[i].Color));
            b.Texts.Add(new LayoutText(x + 15, y + 11, items[i].Label, LegendFontSize, ChartPalette.Text2));
            y += 17;
        }

        if (shown < items.Count)
        {
            b.Texts.Add(new LayoutText(
                x, y + 11, $"+{items.Count - shown} more", LegendFontSize, ChartPalette.Muted));
        }
    }

    // ------------------------------------------------------------ value axis

    private static (double Min, double Max, double Step) NiceScale(double dataMin, double dataMax)
    {
        // Frontend default AxisScaleOptions range is 'zero': the axis anchors
        // at 0 and extends to cover negatives.
        var min = Math.Min(0, dataMin);
        var max = Math.Max(0, dataMax);
        if (max - min < 1e-9)
        {
            max = min + 1;
        }

        var step = NiceStep((max - min) / 4.5); // aims at the pinned 4-6 ticks
        min = Math.Floor(min / step) * step;
        max = Math.Ceiling(max / step) * step;
        return (min, max, step);
    }

    private static double NiceStep(double rough)
    {
        var magnitude = Math.Pow(10, Math.Floor(Math.Log10(rough)));
        var normalized = rough / magnitude;
        var nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
        return nice * magnitude;
    }

    private static List<double> Ticks(double min, double max, double step)
    {
        var count = (int)Math.Round((max - min) / step);
        return Enumerable.Range(0, count + 1).Select(i => min + i * step).ToList();
    }

    private static (double Min, double Max) ValueDomain(CartesianData data, bool stacked)
    {
        var min = 0d;
        var max = 0d;
        if (stacked)
        {
            for (var c = 0; c < data.Categories.Count; c++)
            {
                var positive = 0d;
                var negative = 0d;
                foreach (var series in data.Series)
                {
                    var v = series.Values[c];
                    if (v is > 0)
                    {
                        positive += v.Value;
                    }
                    else if (v is < 0)
                    {
                        negative += v.Value;
                    }
                }

                max = Math.Max(max, positive);
                min = Math.Min(min, negative);
            }
        }
        else
        {
            foreach (var v in data.Series.SelectMany(s => s.Values))
            {
                if (v is { } value && double.IsFinite(value))
                {
                    max = Math.Max(max, value);
                    min = Math.Min(min, value);
                }
            }
        }

        return (min, max);
    }

    // ---------------------------------------------------- cartesian families

    private static ChartLayout BuildCartesian(RenderedTile tile, int width, string type)
    {
        var format = tile.Tile.Format;
        var horizontal = type is "bar" or "stackedBar";
        var stacked = type is "stackedColumn" or "stackedBar";
        var isLine = type == "line";
        var isArea = type == "area";
        var showDataLabels = format?.ShowDataLabels == true && !isLine && !isArea;

        var data = ShapeCartesian(tile, format, comboCapable: isLine || isArea);
        var height = DefaultHeight(width);
        var b = new LayoutBuilder(width, height);

        var (dataMin, dataMax) = ValueDomain(data, stacked);
        var (niceMin, niceMax, step) = NiceScale(dataMin, dataMax);
        var valueTicks = Ticks(niceMin, niceMax, step);
        string FormatValue(double v) =>
            ChartValueFormats.FormatMeasureValue(v, data.ValueColumn, format?.ValueFormat);
        var valueTickLabels = valueTicks.Select(FormatValue).ToList();

        var legendItems = ShowLegend(format) && data.Series.Count > 1
            ? data.Series.Select(s => new LegendItem(s.Label, s.Color)).ToList()
            : [];
        var legendRight = legendItems.Count > 0 && LegendRight(format);
        var legendBottomHeight = legendRight ? 0 : BottomLegendHeight(legendItems, width);
        var legendRightWidth = legendRight ? RightLegendWidth(legendItems, width) : 0;

        // Axis titles come from the format else the column labels (spec §14).
        var categoryTitle = format?.XAxisLabel is { Length: > 0 } xl ? xl : data.AxisColumn?.Label;
        var valueTitle = format?.YAxisLabel is { Length: > 0 } yl ? yl : data.ValueColumn?.Label;
        if (horizontal)
        {
            // Horizontal family: x is the VALUE axis, y the category axis —
            // xAxisLabel/yAxisLabel still name the x/y screen axes.
            (categoryTitle, valueTitle) =
                (format?.YAxisLabel is { Length: > 0 } cyl ? cyl : data.AxisColumn?.Label,
                 format?.XAxisLabel is { Length: > 0 } cxl ? cxl : data.ValueColumn?.Label);
        }

        var top = showDataLabels && !stacked && !horizontal ? 18d : 14d;
        double left, bottom, right = 12 + legendRightWidth;
        var rotateCategoryTicks = false;
        var maxCategoryWidth = data.Categories.Count == 0
            ? 0
            : data.Categories.Max(c => Estimate(c, TickFontSize));

        if (horizontal)
        {
            var rail = Math.Min(maxCategoryWidth + 10, width * 0.35);
            left = rail + (categoryTitle is not null ? 18 : 0);
            bottom = 20 + (valueTitle is not null ? 18 : 0) + legendBottomHeight;
        }
        else
        {
            var maxValueTickWidth = valueTickLabels.Max(l => Estimate(l, TickFontSize));
            left = maxValueTickWidth + 8 + (valueTitle is not null ? 18 : 0);
            var bandEstimate = (width - left - right) / Math.Max(1, data.Categories.Count);
            rotateCategoryTicks = maxCategoryWidth > bandEstimate - 6;
            var tickZone = rotateCategoryTicks
                ? Math.Min(60, maxCategoryWidth * 0.5 + 12) // sin(30°) ≈ 0.5
                : 16;
            bottom = tickZone + 4 + (categoryTitle is not null ? 18 : 0) + legendBottomHeight;
        }

        var plotLeft = left;
        var plotTop = top;
        var plotRight = width - right;
        var plotBottom = height - bottom;
        var plotWidth = Math.Max(1, plotRight - plotLeft);
        var plotHeight = Math.Max(1, plotBottom - plotTop);

        double YOf(double v) => plotBottom - (v - niceMin) / (niceMax - niceMin) * plotHeight;
        double XOf(double v) => plotLeft + (v - niceMin) / (niceMax - niceMin) * plotWidth;

        // Grid per the literal x/y semantics: gridY = horizontal lines from
        // y-axis ticks (default ON), gridX = vertical lines from x-axis ticks.
        var gridY = format?.GridY != false;
        var gridX = format?.GridX == true;
        var categoryCount = data.Categories.Count;
        var band = (horizontal ? plotHeight : plotWidth) / Math.Max(1, categoryCount);

        if (horizontal)
        {
            if (gridY)
            {
                for (var c = 0; c < categoryCount; c++)
                {
                    var y = plotTop + c * band + band / 2;
                    b.GridLines.Add(new LayoutLine(plotLeft, y, plotRight, y, ChartPalette.GridLine));
                }
            }

            if (gridX)
            {
                foreach (var tick in valueTicks)
                {
                    var x = XOf(tick);
                    b.GridLines.Add(new LayoutLine(x, plotTop, x, plotBottom, ChartPalette.GridLine));
                }
            }
        }
        else
        {
            if (gridY)
            {
                foreach (var tick in valueTicks)
                {
                    var y = YOf(tick);
                    b.GridLines.Add(new LayoutLine(plotLeft, y, plotRight, y, ChartPalette.GridLine));
                }
            }

            if (gridX)
            {
                for (var c = 0; c < categoryCount; c++)
                {
                    var x = plotLeft + c * band + band / 2;
                    b.GridLines.Add(new LayoutLine(x, plotTop, x, plotBottom, ChartPalette.GridLine));
                }
            }
        }

        // Axis lines + tick labels.
        b.AxisLines.Add(new LayoutLine(plotLeft, plotBottom, plotRight, plotBottom, ChartPalette.Axis));
        b.AxisLines.Add(new LayoutLine(plotLeft, plotTop, plotLeft, plotBottom, ChartPalette.Axis));

        if (horizontal)
        {
            for (var i = 0; i < valueTicks.Count; i++)
            {
                b.Texts.Add(new LayoutText(
                    XOf(valueTicks[i]), plotBottom + 14, valueTickLabels[i], TickFontSize,
                    ChartPalette.Text2, TextAnchor.Middle));
            }

            var maxChars = Math.Max(3, (int)((plotLeft - 10) / (0.55 * TickFontSize)));
            for (var c = 0; c < categoryCount; c++)
            {
                b.Texts.Add(new LayoutText(
                    plotLeft - 6, plotTop + c * band + band / 2 + 4,
                    Truncate(data.Categories[c], maxChars), TickFontSize,
                    ChartPalette.Text2, TextAnchor.End));
            }
        }
        else
        {
            for (var i = 0; i < valueTicks.Count; i++)
            {
                b.Texts.Add(new LayoutText(
                    plotLeft - 6, YOf(valueTicks[i]) + 4, valueTickLabels[i], TickFontSize,
                    ChartPalette.Text2, TextAnchor.End));
            }

            for (var c = 0; c < categoryCount; c++)
            {
                var x = plotLeft + c * band + band / 2;
                b.Texts.Add(rotateCategoryTicks
                    ? new LayoutText(
                        x, plotBottom + 12, Truncate(data.Categories[c], 24), TickFontSize,
                        ChartPalette.Text2, TextAnchor.End, RotationDegrees: -30)
                    : new LayoutText(
                        x, plotBottom + 14, data.Categories[c], TickFontSize,
                        ChartPalette.Text2, TextAnchor.Middle));
            }
        }

        // Axis titles.
        var titleBaseline = height - legendBottomHeight - 6;
        var bottomTitle = horizontal ? valueTitle : categoryTitle;
        var leftTitle = horizontal ? categoryTitle : valueTitle;
        if (bottomTitle is not null)
        {
            b.Texts.Add(new LayoutText(
                plotLeft + plotWidth / 2, titleBaseline, bottomTitle, TitleFontSize,
                ChartPalette.Text2, TextAnchor.Middle));
        }

        if (leftTitle is not null)
        {
            b.Texts.Add(new LayoutText(
                12, plotTop + plotHeight / 2, leftTitle, TitleFontSize,
                ChartPalette.Text2, TextAnchor.Middle, RotationDegrees: -90));
        }

        // Marks.
        if (isLine || isArea)
        {
            EmitLinesAndAreas(b, data, isArea, horizontalBandCenter: c => plotLeft + c * band + band / 2, YOf);
        }
        else if (stacked)
        {
            EmitStackedBars(b, data, format, horizontal, band, plotLeft, plotTop, YOf, XOf, FormatValue);
        }
        else
        {
            EmitGroupedBars(b, data, format, horizontal, band, plotLeft, plotTop, YOf, XOf, FormatValue, showDataLabels);
        }

        // Legend.
        if (legendRight)
        {
            EmitRightLegend(b, legendItems, plotRight + 8, plotTop, plotHeight);
        }
        else if (legendItems.Count > 0)
        {
            EmitBottomLegend(b, legendItems, plotLeft, height - legendBottomHeight + 4);
        }

        return b.ToLayout();
    }

    private static void EmitLinesAndAreas(
        LayoutBuilder b, CartesianData data, bool area,
        Func<int, double> horizontalBandCenter, Func<double, double> yOf)
    {
        var zeroY = yOf(0);
        foreach (var series in data.Series)
        {
            // Null values break the series into segments (recharts
            // connectNulls default false).
            var segment = new List<LayoutPoint>();
            void Flush()
            {
                if (segment.Count == 0)
                {
                    return;
                }

                if (area)
                {
                    var polygon = new List<LayoutPoint>(segment)
                    {
                        new(segment[^1].X, zeroY),
                        new(segment[0].X, zeroY),
                    };
                    b.Areas.Add(new LayoutPolygon(polygon, series.Color, Opacity: 0.12));
                }

                if (segment.Count > 1)
                {
                    b.Lines.Add(new LayoutPolyline([.. segment], series.Color));
                }

                if (!area)
                {
                    foreach (var point in segment)
                    {
                        b.Dots.Add(new LayoutCircle(point.X, point.Y, 2.5, series.Color));
                    }
                }

                segment = [];
            }

            for (var c = 0; c < data.Categories.Count; c++)
            {
                var v = series.Values[c];
                if (v is { } value && double.IsFinite(value))
                {
                    segment.Add(new LayoutPoint(horizontalBandCenter(c), yOf(value)));
                }
                else
                {
                    Flush();
                }
            }

            Flush();
        }
    }

    private static void EmitGroupedBars(
        LayoutBuilder b, CartesianData data, ChartFormatDoc? format, bool horizontal,
        double band, double plotLeft, double plotTop,
        Func<double, double> yOf, Func<double, double> xOf,
        Func<double, string> formatValue, bool showDataLabels)
    {
        var seriesCount = Math.Max(1, data.Series.Count);
        var group = band * 0.72;
        var barSize = group / seriesCount;
        var zeroY = yOf(0);
        var zeroX = xOf(0);

        for (var s = 0; s < data.Series.Count; s++)
        {
            var series = data.Series[s];
            // Non-stacked share denominator: the series' own SIGNED total.
            var seriesTotal = series.Values.Where(v => v.HasValue).Sum(v => v!.Value);
            for (var c = 0; c < data.Categories.Count; c++)
            {
                if (series.Values[c] is not { } value || !double.IsFinite(value))
                {
                    continue;
                }

                var along = (horizontal ? plotTop : plotLeft) + c * band + (band - group) / 2 + s * barSize;
                if (horizontal)
                {
                    var x = xOf(value);
                    var barX = Math.Min(zeroX, x);
                    var barWidth = Math.Abs(x - zeroX);
                    b.Bars.Add(new LayoutRect(barX, along, barWidth, barSize, series.Color));
                    if (showDataLabels)
                    {
                        var text = ChartDataLabels.Compose(
                            formatValue(value), value, seriesTotal, format?.DataLabelContent);
                        b.Texts.Add(value >= 0
                            ? new LayoutText(barX + barWidth + 4, along + barSize / 2 + 3.5, text,
                                DataLabelFontSize, ChartPalette.Text2)
                            : new LayoutText(barX - 4, along + barSize / 2 + 3.5, text,
                                DataLabelFontSize, ChartPalette.Text2, TextAnchor.End));
                    }
                }
                else
                {
                    var y = yOf(value);
                    var barY = Math.Min(zeroY, y);
                    var barHeight = Math.Abs(y - zeroY);
                    b.Bars.Add(new LayoutRect(along, barY, barSize, barHeight, series.Color));
                    if (showDataLabels)
                    {
                        var text = ChartDataLabels.Compose(
                            formatValue(value), value, seriesTotal, format?.DataLabelContent);
                        b.Texts.Add(value >= 0
                            ? new LayoutText(along + barSize / 2, barY - 4, text,
                                DataLabelFontSize, ChartPalette.Text2, TextAnchor.Middle)
                            : new LayoutText(along + barSize / 2, barY + barHeight + 12, text,
                                DataLabelFontSize, ChartPalette.Text2, TextAnchor.Middle));
                    }
                }
            }
        }
    }

    private static void EmitStackedBars(
        LayoutBuilder b, CartesianData data, ChartFormatDoc? format, bool horizontal,
        double band, double plotLeft, double plotTop,
        Func<double, double> yOf, Func<double, double> xOf, Func<double, string> formatValue)
    {
        var showDataLabels = format?.ShowDataLabels == true;
        var barSize = band * 0.6;
        for (var c = 0; c < data.Categories.Count; c++)
        {
            var positive = 0d;
            var negative = 0d;
            // Stacked share denominator: the category's SIGNED stack total.
            var stackTotal = data.Series
                .Select(s => s.Values[c])
                .Where(v => v.HasValue)
                .Sum(v => v!.Value);
            var along = (horizontal ? plotTop : plotLeft) + c * band + (band - barSize) / 2;

            foreach (var series in data.Series)
            {
                if (series.Values[c] is not { } value || !double.IsFinite(value) || value == 0)
                {
                    continue;
                }

                double from, to;
                if (value > 0)
                {
                    from = positive;
                    positive += value;
                    to = positive;
                }
                else
                {
                    from = negative;
                    negative += value;
                    to = negative;
                }

                if (horizontal)
                {
                    var x1 = xOf(from);
                    var x2 = xOf(to);
                    var rect = new LayoutRect(Math.Min(x1, x2), along, Math.Abs(x2 - x1), barSize, series.Color);
                    b.Bars.Add(rect);
                    if (showDataLabels)
                    {
                        var text = ChartDataLabels.Compose(
                            formatValue(value), value, stackTotal, format?.DataLabelContent);
                        if (rect.Width >= Estimate(text, DataLabelFontSize) + 4)
                        {
                            b.Texts.Add(new LayoutText(
                                rect.X + rect.Width / 2, along + barSize / 2 + 3.5, text,
                                DataLabelFontSize, "#ffffff", TextAnchor.Middle));
                        }
                    }
                }
                else
                {
                    var y1 = yOf(from);
                    var y2 = yOf(to);
                    var rect = new LayoutRect(along, Math.Min(y1, y2), barSize, Math.Abs(y2 - y1), series.Color);
                    b.Bars.Add(rect);
                    if (showDataLabels && rect.Height >= 12)
                    {
                        var text = ChartDataLabels.Compose(
                            formatValue(value), value, stackTotal, format?.DataLabelContent);
                        b.Texts.Add(new LayoutText(
                            along + barSize / 2, rect.Y + rect.Height / 2 + 3.5, text,
                            DataLabelFontSize, "#ffffff", TextAnchor.Middle));
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------- pie/donut

    private static ChartLayout BuildPie(RenderedTile tile, int width, bool donut)
    {
        var format = tile.Tile.Format;
        var height = DefaultHeight(width);
        var b = new LayoutBuilder(width, height);

        var labelColumn = tile.Columns.FirstOrDefault(c => c.Role == ResultColumnRole.Dimension);
        var valueColumn = tile.Columns.FirstOrDefault(c => c.Role == ResultColumnRole.Measure);
        var labelIdx = labelColumn is null ? -1 : tile.Columns.ToList().IndexOf(labelColumn);
        var valueIdx = valueColumn is null ? -1 : tile.Columns.ToList().IndexOf(valueColumn);

        var slices = new List<(string Label, double Value, string Color)>();
        if (valueIdx >= 0)
        {
            foreach (var row in tile.Rows)
            {
                // Non-positive slices carry no drawable share of a pie.
                if (ToNumber(valueIdx < row.Length ? row[valueIdx] : null) is not { } value || value <= 0)
                {
                    continue;
                }

                var label = labelColumn is not null
                    ? ChartValueFormats.FormatCategoryLabel(
                        labelIdx < row.Length ? row[labelIdx] : null, labelColumn,
                        format?.DateFormat, format?.DateFormatPattern)
                    : valueColumn!.Label;
                slices.Add((
                    DisplayLabel(label, format),
                    value,
                    ChartPalette.SeriesColor(slices.Count, label, format?.ColorOverrides, format?.Theme)));
            }
        }

        var ordered = ChartOrdering.ReconcileOrderBy(format?.CategoryOrder, slices, s => s.Label);
        var legendItems = ShowLegend(format) && ordered.Count > 1
            ? ordered.Select(s => new LegendItem(s.Label, s.Color)).ToList()
            : [];
        var legendRight = legendItems.Count > 0 && LegendRight(format);
        var legendBottomHeight = legendRight ? 0 : BottomLegendHeight(legendItems, width);
        var legendRightWidth = legendRight ? RightLegendWidth(legendItems, width) : 0;
        var showDataLabels = format?.ShowDataLabels == true;
        var labelPad = showDataLabels ? 26 : 8;

        var plotWidth = width - 16 - legendRightWidth;
        var plotHeight = height - 16 - legendBottomHeight;
        var maxRadius = Math.Max(10, Math.Min(plotWidth, plotHeight) / 2 - labelPad);
        // recharts Pie defaults: outerRadius 85%, donut innerRadius 55% — the
        // donut hole keeps the same 55:85 proportion of the drawn radius.
        var outer = maxRadius;
        var inner = donut ? maxRadius * (0.55 / 0.85) : 0;
        var cx = 8 + plotWidth / 2;
        var cy = 8 + plotHeight / 2;

        var total = ordered.Sum(s => s.Value);
        var angle = 0d;
        foreach (var slice in ordered)
        {
            var sweep = total > 0 ? slice.Value / total * 360 : 0;
            b.Arcs.Add(new LayoutArc(cx, cy, outer, inner, angle, sweep, slice.Color));
            if (showDataLabels && sweep > 0)
            {
                var mid = (angle + sweep / 2) * Math.PI / 180;
                var sin = Math.Sin(mid);
                var lx = cx + (outer + 10) * sin;
                var ly = cy - (outer + 10) * Math.Cos(mid) + 4;
                var text = ChartDataLabels.Compose(
                    ChartValueFormats.FormatMeasureValue(slice.Value, valueColumn, format?.ValueFormat),
                    slice.Value, total, format?.DataLabelContent);
                var anchor = sin > 0.2 ? TextAnchor.Start : sin < -0.2 ? TextAnchor.End : TextAnchor.Middle;
                b.Texts.Add(new LayoutText(lx, ly, text, DataLabelFontSize, ChartPalette.Text2, anchor));
            }

            angle += sweep;
        }

        if (legendRight)
        {
            EmitRightLegend(b, legendItems, width - 8 - legendRightWidth + 8, 12, height - 24);
        }
        else if (legendItems.Count > 0)
        {
            EmitBottomLegend(b, legendItems, 16, height - legendBottomHeight + 4);
        }

        return b.ToLayout();
    }

    // ---------------------------------------------------------------- scatter

    private static ChartLayout BuildScatter(RenderedTile tile, int width)
    {
        const int SeriesCap = 3; // frontend SCATTER_SERIES_CAP

        var format = tile.Tile.Format;
        var height = DefaultHeight(width);
        var b = new LayoutBuilder(width, height);

        var dimIdx = new List<int>();
        var measIdx = new List<int>();
        for (var i = 0; i < tile.Columns.Count; i++)
        {
            (tile.Columns[i].Role == ResultColumnRole.Dimension ? dimIdx : measIdx).Add(i);
        }

        var xColumn = measIdx.Count > 0 ? tile.Columns[measIdx[0]] : null;
        var yColumn = measIdx.Count > 1 ? tile.Columns[measIdx[1]] : null;
        // Split preference mirrors shapeScatterData: legend dimension first,
        // else the axis dimension (pinned ordinals: dim1 when present, else dim0).
        var splitIdx = dimIdx.Count >= 2 ? dimIdx[1] : dimIdx.Count == 1 ? dimIdx[0] : -1;
        var splitColumn = splitIdx >= 0 ? tile.Columns[splitIdx] : null;

        var bySeries = new List<(string Label, string Color, List<(double X, double Y)> Points)>();
        if (xColumn is not null && yColumn is not null)
        {
            foreach (var row in tile.Rows)
            {
                if (ToNumber(row.ElementAtOrDefault(measIdx[0])) is not { } x
                    || ToNumber(row.ElementAtOrDefault(measIdx[1])) is not { } y)
                {
                    continue;
                }

                var key = splitColumn is not null
                    ? ChartValueFormats.FormatCellValue(row.ElementAtOrDefault(splitIdx), splitColumn)
                    : "All points";
                var index = bySeries.FindIndex(s => s.Label == key);
                if (index == -1)
                {
                    if (bySeries.Count >= SeriesCap)
                    {
                        continue; // beyond the cap: dropped, like the frontend
                    }

                    bySeries.Add((
                        key,
                        ChartPalette.SeriesColor(bySeries.Count, key, format?.ColorOverrides, format?.Theme),
                        []));
                    index = bySeries.Count - 1;
                }

                bySeries[index].Points.Add((x, y));
            }
        }

        var allPoints = bySeries.SelectMany(s => s.Points).ToList();
        var (xMin, xMax, xStep) = NiceScale(
            allPoints.Count == 0 ? 0 : allPoints.Min(p => p.X),
            allPoints.Count == 0 ? 1 : allPoints.Max(p => p.X));
        var (yMin, yMax, yStep) = NiceScale(
            allPoints.Count == 0 ? 0 : allPoints.Min(p => p.Y),
            allPoints.Count == 0 ? 1 : allPoints.Max(p => p.Y));
        var xTicks = Ticks(xMin, xMax, xStep);
        var yTicks = Ticks(yMin, yMax, yStep);
        string FormatX(double v) => ChartValueFormats.FormatMeasureValue(v, xColumn, format?.ValueFormat);
        string FormatY(double v) => ChartValueFormats.FormatMeasureValue(v, yColumn, format?.ValueFormat);

        var legendItems = ShowLegend(format) && bySeries.Count > 1
            ? bySeries.Select(s => new LegendItem(DisplayLabel(s.Label, format), s.Color)).ToList()
            : [];
        var legendRight = legendItems.Count > 0 && LegendRight(format);
        var legendBottomHeight = legendRight ? 0 : BottomLegendHeight(legendItems, width);
        var legendRightWidth = legendRight ? RightLegendWidth(legendItems, width) : 0;

        var xTitle = format?.XAxisLabel is { Length: > 0 } xl ? xl : xColumn?.Label;
        var yTitle = format?.YAxisLabel is { Length: > 0 } yl ? yl : yColumn?.Label;

        var left = yTicks.Select(FormatY).Max(l => Estimate(l, TickFontSize)) + 8
            + (yTitle is not null ? 18 : 0);
        var bottom = 20d + (xTitle is not null ? 18 : 0) + legendBottomHeight;
        var plotLeft = left;
        var plotTop = 14d;
        var plotRight = width - 12 - legendRightWidth;
        var plotBottom = height - bottom;
        var plotWidth = Math.Max(1, plotRight - plotLeft);
        var plotHeight = Math.Max(1, plotBottom - plotTop);

        double XOf(double v) => plotLeft + (v - xMin) / (xMax - xMin) * plotWidth;
        double YOf(double v) => plotBottom - (v - yMin) / (yMax - yMin) * plotHeight;

        if (format?.GridY != false)
        {
            foreach (var tick in yTicks)
            {
                b.GridLines.Add(new LayoutLine(plotLeft, YOf(tick), plotRight, YOf(tick), ChartPalette.GridLine));
            }
        }

        if (format?.GridX == true)
        {
            foreach (var tick in xTicks)
            {
                b.GridLines.Add(new LayoutLine(XOf(tick), plotTop, XOf(tick), plotBottom, ChartPalette.GridLine));
            }
        }

        b.AxisLines.Add(new LayoutLine(plotLeft, plotBottom, plotRight, plotBottom, ChartPalette.Axis));
        b.AxisLines.Add(new LayoutLine(plotLeft, plotTop, plotLeft, plotBottom, ChartPalette.Axis));

        foreach (var tick in xTicks)
        {
            b.Texts.Add(new LayoutText(
                XOf(tick), plotBottom + 14, FormatX(tick), TickFontSize, ChartPalette.Text2, TextAnchor.Middle));
        }

        foreach (var tick in yTicks)
        {
            b.Texts.Add(new LayoutText(
                plotLeft - 6, YOf(tick) + 4, FormatY(tick), TickFontSize, ChartPalette.Text2, TextAnchor.End));
        }

        if (xTitle is not null)
        {
            b.Texts.Add(new LayoutText(
                plotLeft + plotWidth / 2, height - legendBottomHeight - 6, xTitle, TitleFontSize,
                ChartPalette.Text2, TextAnchor.Middle));
        }

        if (yTitle is not null)
        {
            b.Texts.Add(new LayoutText(
                12, plotTop + plotHeight / 2, yTitle, TitleFontSize,
                ChartPalette.Text2, TextAnchor.Middle, RotationDegrees: -90));
        }

        foreach (var series in bySeries)
        {
            foreach (var (x, y) in series.Points)
            {
                b.Dots.Add(new LayoutCircle(XOf(x), YOf(y), 4, series.Color, Opacity: 0.85));
            }
        }

        if (legendRight)
        {
            EmitRightLegend(b, legendItems, plotRight + 8, plotTop, plotHeight);
        }
        else if (legendItems.Count > 0)
        {
            EmitBottomLegend(b, legendItems, plotLeft, height - legendBottomHeight + 4);
        }

        return b.ToLayout();
    }

    // ------------------------------------------------------------------ gantt

    private static double? ToEpochMs(object? value)
    {
        if (ChartValueFormats.TryToNumber(value, out var number))
        {
            return double.IsFinite(number) ? number : null;
        }

        return ChartValueFormats.ParseDateValue(value) is { } date
            ? (date - DateTime.UnixEpoch).TotalMilliseconds
            : null;
    }

    private static ChartLayout BuildGantt(RenderedTile tile, int width)
    {
        var format = tile.Tile.Format;

        var dimIdx = new List<int>();
        var measIdx = new List<int>();
        for (var i = 0; i < tile.Columns.Count; i++)
        {
            (tile.Columns[i].Role == ResultColumnRole.Dimension ? dimIdx : measIdx).Add(i);
        }

        var taskColumn = dimIdx.Count > 0 ? tile.Columns[dimIdx[0]] : null;
        var groupColumn = dimIdx.Count > 1 ? tile.Columns[dimIdx[1]] : null;

        var tasks = new List<(string Label, double Start, double End, string? Group, double? Progress)>();
        var groups = new List<(string Label, string Color)>();
        if (measIdx.Count >= 2)
        {
            foreach (var row in tile.Rows)
            {
                var start = ToEpochMs(row.ElementAtOrDefault(measIdx[0]));
                var end = ToEpochMs(row.ElementAtOrDefault(measIdx[1]));
                if (start is null || end is null)
                {
                    continue; // unparseable span: skipped, like the frontend
                }

                string? group = null;
                if (groupColumn is not null)
                {
                    group = ChartValueFormats.FormatCellValue(
                        row.ElementAtOrDefault(dimIdx[1]), groupColumn);
                    if (!groups.Any(g => g.Label == group))
                    {
                        groups.Add((
                            group,
                            ChartPalette.SeriesColor(groups.Count, group, format?.ColorOverrides, format?.Theme)));
                    }
                }

                double? progress = null;
                if (measIdx.Count >= 3 && ToNumber(row.ElementAtOrDefault(measIdx[2])) is { } p)
                {
                    // 0-1 fraction or 0-100 percent, clamped (GanttOptions doc).
                    progress = Math.Clamp(p > 1 ? p / 100 : p, 0, 1);
                }

                var label = taskColumn is not null
                    ? ChartValueFormats.FormatCellValue(row.ElementAtOrDefault(dimIdx[0]), taskColumn)
                    : tile.Columns[measIdx[0]].Label;
                tasks.Add((label, Math.Min(start.Value, end.Value), Math.Max(start.Value, end.Value), group, progress));
            }
        }

        // Default reading order: start ascending; an explicit query sort wins.
        if (tile.Tile.Spec.Sort.Count == 0)
        {
            tasks = tasks.OrderBy(t => t.Start).ToList();
        }

        var legendItems = ShowLegend(format) && groups.Count > 1
            ? groups.Select(g => new LegendItem(g.Label, g.Color)).ToList()
            : [];
        var legendBottomHeight = BottomLegendHeight(legendItems, width);

        // Auto-grown height: rows*28 + chrome, capped (spec §5).
        var chrome = 8 + 24 + legendBottomHeight;
        var height = (int)Math.Clamp(tasks.Count * GanttRowHeight + chrome, 160, GanttMaxHeight);
        var b = new LayoutBuilder(width, height);

        var maxLabelWidth = tasks.Count == 0 ? 0 : tasks.Max(t => Estimate(t.Label, TickFontSize));
        var rail = Math.Min(maxLabelWidth + 12, width * 0.35);
        var plotLeft = rail;
        var plotTop = 8d;
        var plotRight = width - 12d;
        var plotBottom = height - legendBottomHeight - 24;
        var plotWidth = Math.Max(1, plotRight - plotLeft);

        var minStart = tasks.Count == 0 ? 0 : tasks.Min(t => t.Start);
        var maxEnd = tasks.Count == 0 ? 1 : tasks.Max(t => t.End);
        if (maxEnd - minStart < 1)
        {
            maxEnd = minStart + TimeSpan.FromDays(1).TotalMilliseconds;
        }

        var pad = (maxEnd - minStart) * 0.02;
        minStart -= pad;
        maxEnd += pad;
        double XOf(double ms) => plotLeft + (ms - minStart) / (maxEnd - minStart) * plotWidth;

        // Time ticks: five even instants, formatted by span.
        var spanDays = (maxEnd - minStart) / TimeSpan.FromDays(1).TotalMilliseconds;
        string FormatTick(double ms)
        {
            var date = DateTime.UnixEpoch.AddMilliseconds(ms);
            return spanDays >= 730
                ? date.Year.ToString(CultureInfo.InvariantCulture)
                : spanDays >= 120
                    ? date.ToString("MMM yyyy", CultureInfo.InvariantCulture)
                    : spanDays >= 3
                        ? date.ToString("MMM d", CultureInfo.InvariantCulture)
                        : date.ToString("MMM d HH:mm", CultureInfo.InvariantCulture);
        }

        for (var i = 0; i <= 4; i++)
        {
            var ms = minStart + (maxEnd - minStart) * i / 4;
            var x = XOf(ms);
            b.GridLines.Add(new LayoutLine(x, plotTop, x, plotBottom, ChartPalette.GridLine));
            b.Texts.Add(new LayoutText(
                x, plotBottom + 14, FormatTick(ms), TickFontSize, ChartPalette.Text2,
                i == 0 ? TextAnchor.Start : i == 4 ? TextAnchor.End : TextAnchor.Middle));
        }

        b.AxisLines.Add(new LayoutLine(plotLeft, plotBottom, plotRight, plotBottom, ChartPalette.Axis));

        var visibleRows = (int)Math.Max(
            0, Math.Min(tasks.Count, Math.Floor((plotBottom - plotTop) / GanttRowHeight)));
        var railChars = Math.Max(3, (int)((rail - 10) / (0.55 * TickFontSize)));
        for (var i = 0; i < visibleRows; i++)
        {
            var task = tasks[i];
            var rowTop = plotTop + i * GanttRowHeight;
            var barY = rowTop + GanttRowHeight * 0.25;
            var barHeight = GanttRowHeight * 0.5;
            var x1 = XOf(task.Start);
            var x2 = XOf(task.End);
            var barWidth = Math.Max(2, x2 - x1); // zero-duration milestone: 2px sliver
            var color = task.Group is not null
                ? groups.First(g => g.Label == task.Group).Color
                : ChartPalette.SeriesColor(0, seriesKey: null, format?.ColorOverrides, format?.Theme);

            b.Bars.Add(new LayoutRect(x1, barY, barWidth, barHeight, color));
            if (task.Progress is { } progress and > 0)
            {
                // Theme-neutral completion overlay: the text token at low alpha.
                b.Bars.Add(new LayoutRect(
                    x1, barY, barWidth * progress, barHeight, ChartPalette.Text, Opacity: 0.18));
            }

            b.Texts.Add(new LayoutText(
                rail - 6, rowTop + GanttRowHeight / 2 + 4, Truncate(task.Label, railChars),
                TickFontSize, ChartPalette.Text2, TextAnchor.End));
        }

        if (visibleRows < tasks.Count)
        {
            b.Texts.Add(new LayoutText(
                plotLeft, plotBottom - 4, $"+{tasks.Count - visibleRows} more tasks not shown",
                TickFontSize, ChartPalette.Muted));
        }

        if (legendItems.Count > 0)
        {
            EmitBottomLegend(b, legendItems, plotLeft, height - legendBottomHeight + 4);
        }

        return b.ToLayout();
    }

    private static string Truncate(string text, int maxChars) =>
        text.Length <= maxChars ? text : text[..Math.Max(1, maxChars - 1)] + "…";
}
