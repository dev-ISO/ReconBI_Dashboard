using System.Text.Json;
using System.Text.Json.Serialization;

namespace ReconDashboards.Core.Services;

public sealed record PageRename(string From, string To);

/// <summary>A chart title change (From == To means only the rich inner title changed).</summary>
public sealed record ChartRename(string From, string To);

/// <summary>
/// What changed between two stored layout docs, as permission classes plus a
/// human-renderable detail. Serialized camelCase into the "saved" activity
/// entry's DetailJson.
/// </summary>
public sealed class LayoutChangeSummary
{
    /// <summary>Doc-level settings, slicer/text/image/button tile add/remove/edits.</summary>
    public bool LayoutChanged { get; set; }

    /// <summary>Page add/remove/rename/reorder/color/mobile layout/drillthrough.</summary>
    public bool PagesChanged { get; set; }

    /// <summary>Chart tile add/remove, chart spec/format changes (title excluded — see ChartsRenamed).</summary>
    public bool ChartsChanged { get; set; }

    /// <summary>
    /// Tile move/resize only (the tile's "layout" subtree). Split out of
    /// LayoutChanged so the "arrange tiles" right (CanMoveTiles) can gate pure
    /// geometry independently of layout-content edits.
    /// </summary>
    public bool GeometryChanged { get; set; }

    public List<string> PagesAdded { get; } = [];
    public List<string> PagesRemoved { get; } = [];
    public List<PageRename> PagesRenamed { get; } = [];
    public int TilesAdded { get; set; }
    public int TilesRemoved { get; set; }
    public List<string> ChartsModified { get; } = [];

    /// <summary>
    /// Chart retitles: chart.title and/or format.container.innerTitleHtml (the
    /// frameless tiles' visible name) changed. Split out of the blanket chart
    /// comparison because renaming a chart is owner/admin-only — grantees with
    /// CanEditCharts may edit queries/format but never retitle.
    /// </summary>
    public List<ChartRename> ChartsRenamed { get; } = [];

    public bool SettingsChanged { get; set; }

    [JsonIgnore]
    public bool HasAnyChange =>
        LayoutChanged || PagesChanged || ChartsChanged || GeometryChanged || ChartsRenamed.Count > 0;

    /// <summary>
    /// True when the diff includes tile or page REMOVALS — the axis the
    /// CanDeleteContent right gates. Computed off the counts (not a stored
    /// flag) so removal detection can never diverge from what the activity
    /// detail reports; the fail-closed path raises it via FailClosed.
    /// </summary>
    [JsonIgnore]
    public bool HasRemovals => TilesRemoved > 0 || PagesRemoved.Count > 0 || FailClosed;

    /// <summary>
    /// Set by the fail-closed paths (unparseable docs, changes no known field
    /// explains). Grantee saves must then hold EVERY grantable right —
    /// including move + delete, which are not implied by the three class
    /// flags. Deliberately NOT the owner-only rename gate: an unexplained
    /// diff (e.g. a future tile field the differ has not learned yet) must
    /// stay saveable by fully-granted collaborators, not become owner-only.
    /// </summary>
    [JsonIgnore]
    public bool FailClosed { get; private set; }

    /// <summary>Fail-closed result: every class raised, no detail (renders "updated the dashboard").</summary>
    public static LayoutChangeSummary AllChanged()
    {
        var summary = new LayoutChangeSummary();
        summary.MarkAllChanged();
        return summary;
    }

    internal void MarkAllChanged()
    {
        LayoutChanged = true;
        PagesChanged = true;
        ChartsChanged = true;
        GeometryChanged = true;
        FailClosed = true;
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
            ClassifyTileAddOrRemove(tile, summary);
            summary.TilesAdded++;
            changed = true;
        }

        foreach (var tile in oldTiles.Where(t => !newByKey.ContainsKey(t.Key)))
        {
            ClassifyTileAddOrRemove(tile, summary);
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

        // Grid position/size: pure geometry — its own class since 0.11.1 so
        // the "arrange tiles" right (CanMoveTiles) gates it independently of
        // layout-content edits.
        if (!ElementsEqual(GetOrNull(oldTile.Element, "layout"), GetOrNull(newTile.Element, "layout")))
        {
            summary.GeometryChanged = true;
            explained = true;
        }

        // A kind switch replaces the tile's content wholesale: charts class
        // when a chart is on either side; a swap between the static kinds
        // (slicer/text/image/button) stays a layout-class edit.
        if (!StringEquals(GetString(oldTile.Element, "kind"), GetString(newTile.Element, "kind")))
        {
            if (IsChartClass(oldTile) || IsChartClass(newTile))
            {
                summary.ChartsChanged = true;
                AddChartModified(summary, newTile, oldTile);
            }
            else
            {
                summary.LayoutChanged = true;
            }

            explained = true;
        }
        else if (!ElementsEqual(GetOrNull(oldTile.Element, "chart"), GetOrNull(newTile.Element, "chart")))
        {
            // The chart subtree differs. The RENAME axis — chart.title plus
            // format.container.innerTitleHtml (the visible name of frameless
            // tiles) — is split from the body comparison: retitles are
            // owner/admin-only while body edits ride CanEditCharts.
            var oldChart = GetOrNull(oldTile.Element, "chart");
            var newChart = GetOrNull(newTile.Element, "chart");
            if (ChartRenameOf(oldChart, newChart) is { } rename)
            {
                if (!summary.ChartsRenamed.Contains(rename))
                {
                    summary.ChartsRenamed.Add(rename);
                }
            }

            if (!ChartBodiesEqual(oldChart, newChart))
            {
                summary.ChartsChanged = true;
                AddChartModified(summary, newTile, oldTile);
            }

            explained = true;
        }

        // Slicer/text/image/button tile edits are layout-class changes.
        foreach (var key in (string[])["slicer", "text", "image", "button"])
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

    /// <summary>
    /// Add/remove of a slicer/text/image/button tile is a LAYOUT-class change
    /// (same class as editing one); anything else — chart tiles, kind-less
    /// legacy tiles, unknown future kinds (fail closed to the stricter flag) —
    /// is a charts-class change. Removals ADDITIONALLY feed TilesRemoved
    /// regardless of kind (the callers count), which is what the delete gate
    /// (CanDeleteContent) reads — deletion is class-flag AND delete-flag.
    /// </summary>
    private static void ClassifyTileAddOrRemove(Tile tile, LayoutChangeSummary summary)
    {
        if (IsChartClass(tile))
        {
            summary.ChartsChanged = true;
        }
        else
        {
            summary.LayoutChanged = true;
        }
    }

    /// <summary>False only for the known static kinds (slicer/text/image/button).</summary>
    private static bool IsChartClass(Tile tile) =>
        GetString(tile.Element, "kind") is not ("slicer" or "text" or "image" or "button");

    /// <summary>
    /// The rename (old title → new title) when the chart's title and/or its
    /// format.container.innerTitleHtml differ; null when neither did, or when
    /// either side is not an object (the body comparison then owns the diff).
    /// From == To signals an inner-title-only retitle.
    /// </summary>
    private static ChartRename? ChartRenameOf(JsonElement? oldChart, JsonElement? newChart)
    {
        if (oldChart is not { ValueKind: JsonValueKind.Object } oldObj
            || newChart is not { ValueKind: JsonValueKind.Object } newObj)
        {
            return null;
        }

        var oldTitle = GetString(oldObj, "title") ?? "";
        var newTitle = GetString(newObj, "title") ?? "";
        var titleChanged = !StringEquals(oldTitle, newTitle);
        var innerTitleChanged = !ElementsEqual(InnerTitleOf(oldObj), InnerTitleOf(newObj));
        return titleChanged || innerTitleChanged ? new ChartRename(oldTitle, newTitle) : null;
    }

    private static JsonElement? InnerTitleOf(JsonElement chart) =>
        GetOrNull(chart, "format") is { ValueKind: JsonValueKind.Object } format
        && GetOrNull(format, "container") is { ValueKind: JsonValueKind.Object } container
            ? GetOrNull(container, "innerTitleHtml")
            : null;

    /// <summary>
    /// Deep-equality of two chart subtrees IGNORING the rename axis (title +
    /// format.container.innerTitleHtml). Non-object shapes (a chart appearing
    /// or vanishing outright) compare with plain deep equality — such a change
    /// is a body change, never a mere rename.
    /// </summary>
    private static bool ChartBodiesEqual(JsonElement? oldChart, JsonElement? newChart)
    {
        if (oldChart is not { ValueKind: JsonValueKind.Object } oldObj
            || newChart is not { ValueKind: JsonValueKind.Object } newObj)
        {
            return ElementsEqual(oldChart, newChart);
        }

        return ObjectsEqualExcept(oldObj, newObj, key => key switch
        {
            "title" => Comparison.Skip,
            "format" => Comparison.Formats,
            _ => Comparison.Deep,
        });
    }

    private enum Comparison
    {
        Deep,
        Skip,
        Formats,
        Containers,
    }

    /// <summary>Key-wise object comparison with per-key handling (the rename-axis carve-out).</summary>
    private static bool ObjectsEqualExcept(
        JsonElement oldObj, JsonElement newObj, Func<string, Comparison> comparisonOf)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in oldObj.EnumerateObject())
        {
            keys.Add(property.Name);
        }

        foreach (var property in newObj.EnumerateObject())
        {
            keys.Add(property.Name);
        }

        foreach (var key in keys)
        {
            var oldValue = GetOrNull(oldObj, key);
            var newValue = GetOrNull(newObj, key);
            switch (comparisonOf(key))
            {
                case Comparison.Skip:
                    continue;
                case Comparison.Formats:
                    if (!NestedEqualExcept(oldValue, newValue, "container", Comparison.Containers))
                    {
                        return false;
                    }

                    continue;
                case Comparison.Containers:
                    if (!NestedEqualExcept(oldValue, newValue, "innerTitleHtml", Comparison.Skip))
                    {
                        return false;
                    }

                    continue;
                default:
                    if (!ElementsEqual(oldValue, newValue))
                    {
                        return false;
                    }

                    continue;
            }
        }

        return true;
    }

    /// <summary>
    /// Compares two values that carve out ONE nested key: object shapes recurse
    /// with the carve-out; anything else falls back to deep equality.
    /// </summary>
    private static bool NestedEqualExcept(
        JsonElement? oldValue, JsonElement? newValue, string carvedKey, Comparison carvedComparison)
    {
        if (oldValue is not { ValueKind: JsonValueKind.Object } oldObj
            || newValue is not { ValueKind: JsonValueKind.Object } newObj)
        {
            return ElementsEqual(oldValue, newValue);
        }

        return ObjectsEqualExcept(oldObj, newObj,
            key => StringEquals(key, carvedKey) ? carvedComparison : Comparison.Deep);
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

        // A page arriving/leaving with tiles adds/removes those tiles too —
        // classified per tile kind exactly like an in-page add/remove.
        foreach (var tile in page.Tiles)
        {
            ClassifyTileAddOrRemove(tile, summary);
        }

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
