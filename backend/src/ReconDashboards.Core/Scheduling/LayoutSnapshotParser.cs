using System.Text.Json;
using System.Text.Json.Serialization;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// Which dimension WELLS the chart spec filled. The wire dimension list is the
/// COMPACTED [axis?, legend?, smallMultiples?] (toWireSpec skips absent wells),
/// so on a legend-only chart ordinal 0 IS the legend — pinning dimension 0 as
/// "the axis" mistakes it for the category axis (chartData.ts dimensionOrdinals
/// documents the same regression).
/// </summary>
public sealed record DimensionWells(bool HasAxis, bool HasLegend, bool HasSmallMultiples)
{
    /// <summary>Fallback for tiles built without well information: pure ordinals.</summary>
    public static readonly DimensionWells Positional = new(true, true, true);

    /// <summary>Result ordinal of each well among the compacted dimensions (-1 = unset).</summary>
    public (int Axis, int Legend, int SmallMultiples) Ordinals()
    {
        var next = 0;
        var axis = HasAxis ? next++ : -1;
        var legend = HasLegend ? next++ : -1;
        var smallMultiples = HasSmallMultiples ? next : -1;
        return (axis, legend, smallMultiples);
    }
}

/// <summary>Grid geometry of the tile (columns/rows), which drives the image's aspect ratio.</summary>
public sealed record TileGridSize(int Width, int Height);

/// <summary>One runnable chart tile extracted from a dashboard layout doc.</summary>
public sealed record SnapshotTile(
    string TileId, string Title, string ChartType, ChartQuerySpec Spec, ChartFormatDoc? Format = null,
    DimensionWells? Wells = null, TileGridSize? GridSize = null);

/// <summary>Numeric axis TICK formatting (chart.ts AxisValueFormat).</summary>
public sealed record AxisValueFormatDoc(string? Kind = null, int? Decimals = null, string? Pattern = null);

/// <summary>Category-axis label fitting (chart.ts AxisLabelFit).</summary>
public sealed record AxisLabelFitDoc(string? Mode = null, int? WrapLines = null);

/// <summary>Per-series line dash/width (chart.ts SeriesLineStyle).</summary>
public sealed record SeriesLineStyleDoc(string? Dash = null, double? Width = null);

/// <summary>Font overrides for one piece of chart text (chart.ts TextStyle).</summary>
public sealed record ChartTextStyleDoc(
    double? FontSize = null, bool? Bold = null, bool? Italic = null, string? Color = null);

/// <summary>Tile container chrome (chart.ts ContainerStyle); the email tile wrapper honors it.</summary>
public sealed record ContainerStyleDoc(
    bool? HideHeader = null, string? Background = null, string? BorderColor = null,
    double? BorderWidth = null, double? BorderRadius = null, string? Shadow = null,
    string? InnerTitleHtml = null);

/// <summary>Value-axis guide (chart.ts ReferenceLineSpec); 'secondary' guides are skipped.</summary>
public sealed record ReferenceLineDoc(
    string? Kind = null, double? Value = null, string? MeasureKey = null, string? Label = null,
    string? Color = null, string? Dash = null, double? Width = null, bool? ShowLabel = null,
    bool? Secondary = null);

/// <summary>Fitted overlay (chart.ts TrendlineSpec).</summary>
public sealed record TrendlineDoc(
    string? Kind = null, int? Window = null, string? SeriesKey = null,
    string? Color = null, string? Dash = null, double? Width = null);

/// <summary>The gantt options the server renderer reproduces (a chart.ts GanttOptions subset).</summary>
public sealed record GanttOptionsDoc(
    double? BarSize = null, double? CornerRadius = null, bool? ShowToday = null,
    string? TodayColor = null, bool? RowBanding = null, bool? SingleColor = null, string? Color = null);

/// <summary>
/// The chart.format fields the server-side chart renderer consumes.
/// Persisted in LayoutJson by the GUI; parsed tolerantly — a wrong-typed field
/// degrades to null/unset, never fails the tile. dateFormat/dateFormatPattern
/// ride along because date-axis tick text is shaped by them (chart.ts:410-414).
/// STILL EXCLUDED (not parsed, not drawn): conditionalFormats, the secondary
/// right axis (y2*/secondaryAxisKeys), axis scales, table options, and the
/// interaction-only blocks (tooltip, zoom, legendInteractive, selection).
/// </summary>
public sealed record ChartFormatDoc(
    string? Theme = null,
    IReadOnlyDictionary<string, string>? ColorOverrides = null,
    bool? ShowLegend = null,
    string? LegendPosition = null,
    bool? ShowDataLabels = null,
    string? DataLabelContent = null,
    string? ValueFormat = null,
    string? XAxisLabel = null,
    string? YAxisLabel = null,
    IReadOnlyDictionary<string, string>? SeriesLabels = null,
    IReadOnlyList<string>? CategoryOrder = null,
    IReadOnlyList<string>? SeriesOrder = null,
    bool? GridX = null,
    bool? GridY = null,
    string? DateFormat = null,
    string? DateFormatPattern = null,
    bool? ColorByCategory = null,
    AxisLabelFitDoc? XLabelFit = null,
    AxisValueFormatDoc? XAxisFormat = null,
    AxisValueFormatDoc? YAxisFormat = null,
    string? XAxisLabelHtml = null,
    string? YAxisLabelHtml = null,
    IReadOnlyList<ReferenceLineDoc>? ReferenceLines = null,
    IReadOnlyList<TrendlineDoc>? Trendlines = null,
    IReadOnlyDictionary<string, SeriesLineStyleDoc>? LineStyles = null,
    bool? TrimEmptyEdges = null,
    bool? ExcludeBlankDates = null,
    ChartTextStyleDoc? TitleStyle = null,
    ChartTextStyleDoc? AxisTitleStyle = null,
    ChartTextStyleDoc? LegendStyle = null,
    ChartTextStyleDoc? KpiValueStyle = null,
    ContainerStyleDoc? Container = null,
    GanttOptionsDoc? Gantt = null);

/// <summary>One dashboard page with its runnable chart tiles, in document order.</summary>
public sealed record SnapshotPage(string Name, IReadOnlyList<SnapshotTile> Tiles);

/// <summary>
/// Minimal, tolerant reader of the persisted dashboard layout document — just
/// enough of pages/tiles/chart specs to rebuild each chart tile's wire
/// ChartQuerySpec the way the GUI's toWireSpec does: dimensions are
/// [axis, legend?, smallMultiples?], filters are the chart's own filters plus
/// the applicable enabled Filters-pane cards. Transient runtime state (slicer
/// selections, cross-filters, drill positions, drillthrough, bookmarks,
/// parameter bindings) is intentionally NOT reproduced — a snapshot is the
/// dashboard at rest. Unknown fields are ignored, malformed tiles are skipped.
/// </summary>
public static class LayoutSnapshotParser
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public static IReadOnlyList<SnapshotPage> Parse(string layoutJson, int modelId)
    {
        LayoutDoc? doc;
        try
        {
            doc = JsonSerializer.Deserialize<LayoutDoc>(layoutJson, Options);
        }
        catch (JsonException)
        {
            return [];
        }

        if (doc is null)
        {
            return [];
        }

        var cards = doc.FilterCards ?? [];
        var pages = doc.Pages is { Count: > 0 }
            ? doc.Pages
            : [new PageDoc(null, "Page 1", doc.Tiles)];

        var result = new List<SnapshotPage>();
        foreach (var page in pages)
        {
            var tiles = new List<SnapshotTile>();
            foreach (var tile in page.Tiles ?? [])
            {
                if (BuildTile(tile, page, cards, modelId) is { } snapshot)
                {
                    tiles.Add(snapshot);
                }
            }

            result.Add(new SnapshotPage(page.Name ?? "Page", tiles));
        }

        return result;
    }

    private static SnapshotTile? BuildTile(TileDoc tile, PageDoc page, List<FilterCardDoc> cards, int modelId)
    {
        if (tile.Kind is not (null or "chart") || tile.Chart?.Query is not { } query)
        {
            return null;
        }

        var measures = query.Measures ?? [];
        // Same bar as the GUI's isRunnable, INCLUDING its table exception: a
        // table with Rows and no Values is a passthrough column list the
        // engine compiles fine (SELECT DISTINCT-shaped), and AppendTable is
        // result-column driven, so it renders in email exactly as on screen.
        // Kept in lockstep with isRunnable — diverging silently DROPS a tile
        // from every scheduled send with no error anywhere.
        var isTable = string.Equals(tile.Chart.Type, "table", StringComparison.Ordinal);
        if (measures.Count == 0 && !(isTable && query.Axis is not null))
        {
            return null;
        }

        // Order matters downstream: [axis, legend?, smallMultiples?].
        var dimensions = new List<DimensionSpec>();
        if (query.Axis is { } axis)
        {
            dimensions.Add(axis);
        }

        if (query.Legend is { } legend)
        {
            dimensions.Add(legend);
        }

        if (query.SmallMultiples is { } smallMultiples)
        {
            dimensions.Add(smallMultiples);
        }

        var filters = new List<FilterSpec>(query.Filters ?? []);
        foreach (var card in cards)
        {
            if (CardApplies(card, page, tile))
            {
                filters.AddRange(CardClauses(card));
            }
        }

        var spec = new ChartQuerySpec(
            modelId, dimensions, measures, filters, query.Sort ?? [], TopN: null, query.Limit);

        return new SnapshotTile(
            tile.Id ?? "", tile.Chart.Title ?? "Chart", tile.Chart.Type ?? "column", spec,
            ReadFormat(tile.Chart.Format),
            new DimensionWells(
                query.Axis is not null, query.Legend is not null, query.SmallMultiples is not null),
            tile.Layout is { W: > 0, H: > 0 } layout ? new TileGridSize(layout.W.Value, layout.H.Value) : null);
    }

    /// <summary>
    /// Extracts the consumed chart.format fields by hand: the GUI persists many
    /// more fields with evolving shapes, and one stray type must degrade to
    /// "unset" instead of failing the tile (or, worse, the whole document —
    /// which a typed DTO mismatch inside Deserialize would).
    /// </summary>
    private static ChartFormatDoc? ReadFormat(JsonElement? format)
    {
        if (format is not { ValueKind: JsonValueKind.Object } doc)
        {
            return null;
        }

        return new ChartFormatDoc(
            Theme: ReadString(doc, "theme"),
            ColorOverrides: ReadStringMap(doc, "colorOverrides"),
            ShowLegend: ReadBool(doc, "showLegend"),
            LegendPosition: ReadString(doc, "legendPosition"),
            ShowDataLabels: ReadBool(doc, "showDataLabels"),
            DataLabelContent: ReadString(doc, "dataLabelContent"),
            ValueFormat: ReadString(doc, "valueFormat"),
            XAxisLabel: ReadString(doc, "xAxisLabel"),
            YAxisLabel: ReadString(doc, "yAxisLabel"),
            SeriesLabels: ReadStringMap(doc, "seriesLabels"),
            CategoryOrder: ReadStringList(doc, "categoryOrder"),
            SeriesOrder: ReadStringList(doc, "seriesOrder"),
            GridX: ReadBool(doc, "gridX"),
            GridY: ReadBool(doc, "gridY"),
            DateFormat: ReadString(doc, "dateFormat"),
            DateFormatPattern: ReadString(doc, "dateFormatPattern"),
            ColorByCategory: ReadBool(doc, "colorByCategory"),
            XLabelFit: ReadObject(doc, "xLabelFit", o => new AxisLabelFitDoc(
                ReadString(o, "mode"), ReadInt(o, "wrapLines"))),
            XAxisFormat: ReadAxisValueFormat(doc, "xAxisFormat"),
            YAxisFormat: ReadAxisValueFormat(doc, "yAxisFormat"),
            XAxisLabelHtml: ReadString(doc, "xAxisLabelHtml"),
            YAxisLabelHtml: ReadString(doc, "yAxisLabelHtml"),
            ReferenceLines: ReadObjectList(doc, "referenceLines", o => new ReferenceLineDoc(
                ReadString(o, "kind"), ReadDouble(o, "value"), ReadString(o, "measureKey"),
                ReadString(o, "label"), ReadString(o, "color"), ReadString(o, "dash"),
                ReadDouble(o, "width"), ReadBool(o, "showLabel"), ReadBool(o, "secondary"))),
            Trendlines: ReadObjectList(doc, "trendlines", o => new TrendlineDoc(
                ReadString(o, "kind"), ReadInt(o, "window"), ReadString(o, "seriesKey"),
                ReadString(o, "color"), ReadString(o, "dash"), ReadDouble(o, "width"))),
            LineStyles: ReadObjectMap(doc, "lineStyles", o => new SeriesLineStyleDoc(
                ReadString(o, "dash"), ReadDouble(o, "width"))),
            TrimEmptyEdges: ReadBool(doc, "trimEmptyEdges"),
            ExcludeBlankDates: ReadBool(doc, "excludeBlankDates"),
            TitleStyle: ReadTextStyle(doc, "titleStyle"),
            AxisTitleStyle: ReadTextStyle(doc, "axisTitleStyle"),
            LegendStyle: ReadTextStyle(doc, "legendStyle"),
            KpiValueStyle: ReadTextStyle(doc, "kpiValueStyle"),
            Container: ReadObject(doc, "container", o => new ContainerStyleDoc(
                ReadBool(o, "hideHeader"), ReadString(o, "background"), ReadString(o, "borderColor"),
                ReadDouble(o, "borderWidth"), ReadDouble(o, "borderRadius"), ReadString(o, "shadow"),
                ReadString(o, "innerTitleHtml"))),
            Gantt: ReadObject(doc, "gantt", o => new GanttOptionsDoc(
                ReadDouble(o, "barSize"), ReadDouble(o, "cornerRadius"), ReadBool(o, "showToday"),
                ReadString(o, "todayColor"), ReadBool(o, "rowBanding"), ReadBool(o, "singleColor"),
                ReadString(o, "color"))));
    }

    private static AxisValueFormatDoc? ReadAxisValueFormat(JsonElement doc, string name) =>
        ReadObject(doc, name, o => new AxisValueFormatDoc(
            ReadString(o, "kind"), ReadInt(o, "decimals"), ReadString(o, "pattern")));

    private static ChartTextStyleDoc? ReadTextStyle(JsonElement doc, string name) =>
        ReadObject(doc, name, o => new ChartTextStyleDoc(
            ReadDouble(o, "fontSize"), ReadBool(o, "bold"), ReadBool(o, "italic"), ReadString(o, "color")));

    private static string? ReadString(JsonElement doc, string name) =>
        doc.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool? ReadBool(JsonElement doc, string name) =>
        doc.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : null;

    private static double? ReadDouble(JsonElement doc, string name) =>
        doc.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.Number
            && value.TryGetDouble(out var number) && double.IsFinite(number)
            ? number
            : null;

    private static int? ReadInt(JsonElement doc, string name) =>
        ReadDouble(doc, name) is { } number ? (int)Math.Round(number) : null;

    /// <summary>A nested object read through <paramref name="build"/>; a non-object is unset.</summary>
    private static T? ReadObject<T>(JsonElement doc, string name, Func<JsonElement, T> build)
        where T : class =>
        doc.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.Object
            ? build(value)
            : null;

    /// <summary>An array of nested objects; non-object entries are skipped, not fatal.</summary>
    private static IReadOnlyList<T>? ReadObjectList<T>(
        JsonElement doc, string name, Func<JsonElement, T> build)
    {
        if (!doc.TryGetProperty(name, out var value) || value.ValueKind is not JsonValueKind.Array)
        {
            return null;
        }

        return value.EnumerateArray()
            .Where(item => item.ValueKind is JsonValueKind.Object)
            .Select(build)
            .ToArray();
    }

    /// <summary>A map of nested objects (lineStyles); non-object values are skipped.</summary>
    private static IReadOnlyDictionary<string, T>? ReadObjectMap<T>(
        JsonElement doc, string name, Func<JsonElement, T> build)
    {
        if (!doc.TryGetProperty(name, out var value) || value.ValueKind is not JsonValueKind.Object)
        {
            return null;
        }

        var map = new Dictionary<string, T>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (property.Value.ValueKind is JsonValueKind.Object)
            {
                map[property.Name] = build(property.Value);
            }
        }

        return map;
    }

    private static IReadOnlyList<string>? ReadStringList(JsonElement doc, string name)
    {
        if (!doc.TryGetProperty(name, out var value) || value.ValueKind is not JsonValueKind.Array)
        {
            return null;
        }

        return value.EnumerateArray()
            .Where(item => item.ValueKind is JsonValueKind.String)
            .Select(item => item.GetString()!)
            .ToArray();
    }

    private static IReadOnlyDictionary<string, string>? ReadStringMap(JsonElement doc, string name)
    {
        if (!doc.TryGetProperty(name, out var value) || value.ValueKind is not JsonValueKind.Object)
        {
            return null;
        }

        var map = new Dictionary<string, string>();
        foreach (var property in value.EnumerateObject())
        {
            if (property.Value.ValueKind is JsonValueKind.String)
            {
                map[property.Name] = property.Value.GetString()!;
            }
        }

        return map;
    }

    /// <summary>Mirrors the GUI's filtersForTile card scoping (minus view-mode overrides).</summary>
    private static bool CardApplies(FilterCardDoc card, PageDoc page, TileDoc tile)
    {
        if (card.Disabled == true)
        {
            return false;
        }

        return card.Scope switch
        {
            "allPages" => true,
            "page" => card.PageId is not null && card.PageId == page.Id,
            "visual" => card.TargetTileId is not null && card.TargetTileId == tile.Id,
            _ => false,
        };
    }

    /// <summary>Mirrors the GUI's filterCardClauses compilation.</summary>
    private static IEnumerable<FilterSpec> CardClauses(FilterCardDoc card)
    {
        if (card.Table is null || card.Column is null)
        {
            yield break;
        }

        if (card.Mode == "basic")
        {
            var values = card.BasicValues ?? [];
            if (values.Count > 0)
            {
                yield return new FilterSpec(card.Table, card.Column, FilterOperator.In, values);
            }

            yield break;
        }

        var complete = (card.Conditions ?? [])
            .Where(c => c.Operator is FilterOperator.IsNull or FilterOperator.NotNull
                || c.Value is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) })
            .ToArray();
        if (complete.Length == 0)
        {
            yield break;
        }

        if ((card.ConditionJoin ?? "and") == "or" && complete.Length > 1)
        {
            // The engine has no OR; only all-'eq' collapses to one IN clause.
            if (complete.All(c => c.Operator == FilterOperator.Eq))
            {
                yield return new FilterSpec(
                    card.Table, card.Column, FilterOperator.In,
                    complete.Select(c => c.Value!.Value).ToArray());
            }

            yield break;
        }

        foreach (var condition in complete)
        {
            if (condition.Operator is not { } op)
            {
                continue;
            }

            IReadOnlyList<JsonElement> values =
                op is FilterOperator.IsNull or FilterOperator.NotNull || condition.Value is null
                    ? []
                    : [condition.Value.Value];
            yield return new FilterSpec(card.Table, card.Column, op, values);
        }
    }

    // ------------------------- minimal layout-doc DTOs -------------------------

    private sealed record ChartQueryDoc(
        DimensionSpec? Axis,
        DimensionSpec? Legend,
        DimensionSpec? SmallMultiples,
        List<MeasureSpec>? Measures,
        List<FilterSpec>? Filters,
        List<SortSpec>? Sort,
        int? Limit);

    private sealed record ChartDoc(string? Type, string? Title, ChartQueryDoc? Query, JsonElement? Format);

    /// <summary>Grid placement; only the SIZE is consumed (image aspect ratio).</summary>
    private sealed record TileLayoutDoc(int? X, int? Y, int? W, int? H);

    private sealed record TileDoc(string? Id, string? Kind, ChartDoc? Chart, TileLayoutDoc? Layout);

    private sealed record PageDoc(string? Id, string? Name, List<TileDoc>? Tiles);

    private sealed record FilterCardConditionDoc(FilterOperator? Operator, JsonElement? Value);

    private sealed record FilterCardDoc(
        string? Scope,
        string? TargetTileId,
        string? PageId,
        string? Table,
        string? Column,
        string? Mode,
        List<JsonElement>? BasicValues,
        List<FilterCardConditionDoc>? Conditions,
        string? ConditionJoin,
        bool? Disabled);

    private sealed record LayoutDoc(
        List<TileDoc>? Tiles,
        List<PageDoc>? Pages,
        List<FilterCardDoc>? FilterCards);
}
