using System.Text.Json;
using System.Text.Json.Serialization;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Core.Scheduling;

/// <summary>One runnable chart tile extracted from a dashboard layout doc.</summary>
public sealed record SnapshotTile(
    string TileId, string Title, string ChartType, ChartQuerySpec Spec, ChartFormatDoc? Format = null);

/// <summary>
/// The chart.format fields the server-side chart renderer consumes (v1).
/// Persisted in LayoutJson by the GUI; parsed tolerantly — a wrong-typed field
/// degrades to null/unset, never fails the tile. dateFormat/dateFormatPattern
/// ride along because date-axis tick text is shaped by them (chart.ts:410-414).
/// EXCLUDED v1 (not parsed, not drawn): referenceLines, trendlines,
/// conditionalFormats.
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
    string? DateFormatPattern = null);

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
        if (measures.Count == 0)
        {
            return null; // not runnable, same bar as the GUI's isRunnable
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
            ReadFormat(tile.Chart.Format));
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
            DateFormatPattern: ReadString(doc, "dateFormatPattern"));
    }

    private static string? ReadString(JsonElement doc, string name) =>
        doc.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool? ReadBool(JsonElement doc, string name) =>
        doc.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : null;

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

    private sealed record TileDoc(string? Id, string? Kind, ChartDoc? Chart);

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
