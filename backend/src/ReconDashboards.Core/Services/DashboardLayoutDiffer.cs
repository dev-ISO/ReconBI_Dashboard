using System.Text.Json;
using System.Text.Json.Serialization;

namespace ReconDashboards.Core.Services;

public sealed record PageRename(string From, string To);

/// <summary>
/// What changed between two stored layout docs, as permission classes plus a
/// human-renderable detail. Serialized camelCase into the "saved" activity
/// entry's DetailJson.
/// </summary>
public sealed class LayoutChangeSummary
{
    /// <summary>Tile move/resize, doc-level settings, slicer/text/image tile edits.</summary>
    public bool LayoutChanged { get; set; }

    /// <summary>Page add/remove/rename/reorder/color/mobile layout/drillthrough.</summary>
    public bool PagesChanged { get; set; }

    /// <summary>Tile add/remove, chart spec/format changes.</summary>
    public bool ChartsChanged { get; set; }

    public List<string> PagesAdded { get; } = [];
    public List<string> PagesRemoved { get; } = [];
    public List<PageRename> PagesRenamed { get; } = [];
    public int TilesAdded { get; set; }
    public int TilesRemoved { get; set; }
    public List<string> ChartsModified { get; } = [];
    public bool SettingsChanged { get; set; }

    [JsonIgnore]
    public bool HasAnyChange => LayoutChanged || PagesChanged || ChartsChanged;

    /// <summary>Fail-closed result: every class raised, no detail (renders "updated the dashboard").</summary>
    public static LayoutChangeSummary AllChanged() =>
        new() { LayoutChanged = true, PagesChanged = true, ChartsChanged = true };

    internal void MarkAllChanged()
    {
        LayoutChanged = true;
        PagesChanged = true;
        ChartsChanged = true;
    }
}

/// <summary>
/// Structural diff of two persisted dashboard layout docs, keyed by page id and
/// tile id (legacy top-level tiles become a single implicit page). The layout
/// JSON is host-opaque, so parsing is lenient — and anything unrecognized
/// (malformed JSON, non-object docs, changes no known field explains) fails
/// CLOSED by raising every class flag, since the flags gate grantee saves.
/// Two consumers: grantee permission enforcement and the "saved" activity log.
/// </summary>
public static class DashboardLayoutDiffer
{
    /// <summary>Doc-level keys that are page/tile structure rather than settings.</summary>
    private static readonly string[] StructuralKeys = ["pages", "tiles"];

    public static LayoutChangeSummary Diff(string? oldLayoutJson, string? newLayoutJson)
    {
        try
        {
            using var oldDoc = JsonDocument.Parse(oldLayoutJson ?? "", new JsonDocumentOptions { MaxDepth = 64 });
            using var newDoc = JsonDocument.Parse(newLayoutJson ?? "", new JsonDocumentOptions { MaxDepth = 64 });
            if (oldDoc.RootElement.ValueKind != JsonValueKind.Object
                || newDoc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return LayoutChangeSummary.AllChanged();
            }

            var summary = new LayoutChangeSummary();
            DiffSettings(oldDoc.RootElement, newDoc.RootElement, summary);
            DiffPages(ExtractPages(oldDoc.RootElement), ExtractPages(newDoc.RootElement), summary);
            return summary;
        }
        catch (Exception)
        {
            // JsonException, depth overruns, anything unexpected: fail closed.
            return LayoutChangeSummary.AllChanged();
        }
    }

    /// <summary>
    /// Every top-level property that is not page/tile structure is a doc-level
    /// setting (refreshSeconds, filterIndicator, filterCards, bookmarks,
    /// parameters, crossFilterScope, defaultViewFit, legacy slicers, future
    /// additions). Any difference is a layout-class change.
    /// </summary>
    private static void DiffSettings(JsonElement oldRoot, JsonElement newRoot, LayoutChangeSummary summary)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in oldRoot.EnumerateObject())
        {
            keys.Add(property.Name);
        }

        foreach (var property in newRoot.EnumerateObject())
        {
            keys.Add(property.Name);
        }

        foreach (var key in keys)
        {
            if (StructuralKeys.Contains(key, StringComparer.Ordinal))
            {
                continue;
            }

            if (!ElementsEqual(GetOrNull(oldRoot, key), GetOrNull(newRoot, key)))
            {
                summary.LayoutChanged = true;
                summary.SettingsChanged = true;
                return;
            }
        }
    }

    private static void DiffPages(List<Page> oldPages, List<Page> newPages, LayoutChangeSummary summary)
    {
        var oldByKey = oldPages.ToDictionary(p => p.Key, StringComparer.Ordinal);
        var newByKey = newPages.ToDictionary(p => p.Key, StringComparer.Ordinal);

        foreach (var page in newPages.Where(p => !oldByKey.ContainsKey(p.Key)))
        {
            summary.PagesChanged = true;
            summary.PagesAdded.Add(page.DisplayName);
            CountTiles(page, summary, added: true);
        }

        foreach (var page in oldPages.Where(p => !newByKey.ContainsKey(p.Key)))
        {
            summary.PagesChanged = true;
            summary.PagesRemoved.Add(page.DisplayName);
            CountTiles(page, summary, added: false);
        }

        // Reorder: the surviving pages' relative order changed.
        var oldOrder = oldPages.Where(p => newByKey.ContainsKey(p.Key)).Select(p => p.Key);
        var newOrder = newPages.Where(p => oldByKey.ContainsKey(p.Key)).Select(p => p.Key);
        if (!oldOrder.SequenceEqual(newOrder, StringComparer.Ordinal))
        {
            summary.PagesChanged = true;
        }

        foreach (var newPage in newPages)
        {
            if (oldByKey.TryGetValue(newPage.Key, out var oldPage))
            {
                DiffPage(oldPage, newPage, summary);
            }
        }
    }

    private static void DiffPage(Page oldPage, Page newPage, LayoutChangeSummary summary)
    {
        if (ElementsEqual(oldPage.Element, newPage.Element))
        {
            return;
        }

        if (oldPage.IsLegacy && newPage.IsLegacy)
        {
            // The implicit legacy page IS the doc root: everything except its
            // tiles is a doc-level setting DiffSettings already classified.
            DiffTiles(oldPage.Tiles, newPage.Tiles, summary);
            return;
        }

        var explained = false;

        if (!StringEquals(oldPage.Name, newPage.Name))
        {
            summary.PagesChanged = true;
            summary.PagesRenamed.Add(new PageRename(oldPage.DisplayName, newPage.DisplayName));
            explained = true;
        }

        foreach (var key in (string[])["color", "drillthrough", "mobileLayout"])
        {
            if (!ElementsEqual(GetOrNull(oldPage.Element, key), GetOrNull(newPage.Element, key)))
            {
                summary.PagesChanged = true;
                explained = true;
            }
        }

        if (DiffTiles(oldPage.Tiles, newPage.Tiles, summary))
        {
            explained = true;
        }

        if (!explained)
        {
            // The page differs in some way no known field accounts for.
            summary.MarkAllChanged();
        }
    }

    /// <summary>Returns true when any tile-level difference was found (and classified).</summary>
    private static bool DiffTiles(List<Tile> oldTiles, List<Tile> newTiles, LayoutChangeSummary summary)
    {
        var changed = false;
        var oldByKey = oldTiles.ToDictionary(t => t.Key, StringComparer.Ordinal);
        var newByKey = newTiles.ToDictionary(t => t.Key, StringComparer.Ordinal);

        foreach (var tile in newTiles.Where(t => !oldByKey.ContainsKey(t.Key)))
        {
            summary.ChartsChanged = true;
            summary.TilesAdded++;
            changed = true;
        }

        foreach (var tile in oldTiles.Where(t => !newByKey.ContainsKey(t.Key)))
        {
            summary.ChartsChanged = true;
            summary.TilesRemoved++;
            changed = true;
        }

        foreach (var newTile in newTiles)
        {
            if (oldByKey.TryGetValue(newTile.Key, out var oldTile) && DiffTile(oldTile, newTile, summary))
            {
                changed = true;
            }
        }

        return changed;
    }

    /// <summary>Returns true when the tile differs (classification included).</summary>
    private static bool DiffTile(Tile oldTile, Tile newTile, LayoutChangeSummary summary)
    {
        if (ElementsEqual(oldTile.Element, newTile.Element))
        {
            return false;
        }

        var explained = false;

        // Grid position/size: pure layout.
        if (!ElementsEqual(GetOrNull(oldTile.Element, "layout"), GetOrNull(newTile.Element, "layout")))
        {
            summary.LayoutChanged = true;
            explained = true;
        }

        // A kind switch replaces the tile's content wholesale: charts class.
        if (!StringEquals(GetString(oldTile.Element, "kind"), GetString(newTile.Element, "kind")))
        {
            summary.ChartsChanged = true;
            AddChartModified(summary, newTile, oldTile);
            explained = true;
        }
        else if (!ElementsEqual(GetOrNull(oldTile.Element, "chart"), GetOrNull(newTile.Element, "chart")))
        {
            summary.ChartsChanged = true;
            AddChartModified(summary, newTile, oldTile);
            explained = true;
        }

        // Slicer/text/image tile edits are layout-class changes.
        foreach (var key in (string[])["slicer", "text", "image"])
        {
            if (!ElementsEqual(GetOrNull(oldTile.Element, key), GetOrNull(newTile.Element, key)))
            {
                summary.LayoutChanged = true;
                explained = true;
            }
        }

        if (!explained)
        {
            summary.MarkAllChanged();
        }

        return true;
    }

    private static void AddChartModified(LayoutChangeSummary summary, Tile newTile, Tile oldTile)
    {
        var title = ChartTitle(newTile) ?? ChartTitle(oldTile) ?? "Chart";
        if (!summary.ChartsModified.Contains(title, StringComparer.Ordinal))
        {
            summary.ChartsModified.Add(title);
        }
    }

    private static string? ChartTitle(Tile tile) =>
        GetOrNull(tile.Element, "chart") is { ValueKind: JsonValueKind.Object } chart
            ? GetString(chart, "title")
            : null;

    private static void CountTiles(Page page, LayoutChangeSummary summary, bool added)
    {
        if (page.Tiles.Count == 0)
        {
            return;
        }

        // A page arriving/leaving with tiles adds/removes those charts too.
        summary.ChartsChanged = true;
        if (added)
        {
            summary.TilesAdded += page.Tiles.Count;
        }
        else
        {
            summary.TilesRemoved += page.Tiles.Count;
        }
    }

    // ----------------------------- doc extraction -----------------------------

    private sealed record Page(string Key, string? Name, JsonElement Element, List<Tile> Tiles, bool IsLegacy = false)
    {
        public string DisplayName => Name ?? Key;
    }

    private sealed record Tile(string Key, JsonElement Element);

    private static List<Page> ExtractPages(JsonElement root)
    {
        if (root.TryGetProperty("pages", out var pages)
            && pages.ValueKind == JsonValueKind.Array
            && pages.GetArrayLength() > 0)
        {
            var result = new List<Page>();
            var index = 0;
            foreach (var element in pages.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.Object)
                {
                    throw new JsonException("Page entries must be objects.");
                }

                var key = GetString(element, "id") is { Length: > 0 } id ? id : $"#page{index}";
                result.Add(new Page(key, GetString(element, "name"), element, ExtractTiles(element)));
                index++;
            }

            return result;
        }

        // Legacy doc: top-level tiles[] act as a single implicit page. Slicers
        // and other legacy top-level state are handled as doc settings.
        var legacyTiles = root.TryGetProperty("tiles", out var tiles) && tiles.ValueKind == JsonValueKind.Array
            ? ExtractTileList(tiles)
            : [];
        return [new Page("__legacy__", "Page 1", root, legacyTiles, IsLegacy: true)];
    }

    private static List<Tile> ExtractTiles(JsonElement page) =>
        page.TryGetProperty("tiles", out var tiles) && tiles.ValueKind == JsonValueKind.Array
            ? ExtractTileList(tiles)
            : [];

    private static List<Tile> ExtractTileList(JsonElement tiles)
    {
        var result = new List<Tile>();
        var index = 0;
        foreach (var element in tiles.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                throw new JsonException("Tile entries must be objects.");
            }

            // Id-less tiles (old docs) key by position: still diffable, and a
            // reorder simply reads as edits to the affected positions.
            var key = GetString(element, "id") is { Length: > 0 } id ? id : $"#tile{index}";
            result.Add(new Tile(key, element));
            index++;
        }

        return result;
    }

    // ------------------------------ json helpers ------------------------------

    private static JsonElement? GetOrNull(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value)
            ? value
            : null;

    private static string? GetString(JsonElement element, string name) =>
        GetOrNull(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static bool ElementsEqual(JsonElement? a, JsonElement? b) => (a, b) switch
    {
        (null, null) => true,
        ({ } left, { } right) => JsonElement.DeepEquals(left, right),
        _ => false,
    };

    private static bool ElementsEqual(JsonElement a, JsonElement b) => JsonElement.DeepEquals(a, b);

    private static bool StringEquals(string? a, string? b) => string.Equals(a, b, StringComparison.Ordinal);
}
