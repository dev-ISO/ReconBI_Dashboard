using System.Text.Json;
using System.Text.Json.Nodes;

namespace ReconDashboards.Core.Services;

/// <summary>
/// Pure JSON surgery for collaborative-edit ops (COLLAB-DESIGN wave 1): given
/// the stored layout doc and one op, produce the new doc — no I/O, no
/// authorization (the caller diffs the result with DashboardLayoutDiffer and
/// gates on the summary, so classification can never diverge from the differ).
///
/// THE OP VOCABULARY — a deliberately SMALL, CLOSED set mirroring the store's
/// mutation seams, one JSON schema each. payload.kind selects; targetKind /
/// targetId must match the kind's row:
///
///   kind             targetKind targetId       payload fields
///   ---------------- ---------- -------------- --------------------------------
///   tileUpsert       tile       tile id        tile: object (tile.id == targetId);
///                                              pageId: string (required only when
///                                              ADDING to a paged doc; ignored on
///                                              replace — cross-page moves are
///                                              tileRemove + tileUpsert)
///   tileRemove       tile       tile id        —              (missing tile: no-op)
///   tileGeometry     tile       tile id        layout: object (the tile's grid box)
///   pageAdd          page       page id        page: object (page.id == targetId);
///                                              index: int (clamped; append when
///                                              absent). Existing id ⇒ replace, so
///                                              a replayed add stays idempotent.
///   pageRename       page       page id        name: string
///   pageColor        page       page id        color: any JSON (property absent ⇒
///                                              REMOVE the page's color)
///   pageSet          page       page id        patch: object holding ONLY
///                                              mobileLayout and/or drillthrough.
///                                              Shallow patch: a patch key PRESENT
///                                              with a non-null value SETS it; a key
///                                              PRESENT with JSON null REMOVES it
///                                              from the page; a key ABSENT leaves
///                                              the page's value untouched. Any
///                                              other key ⇒ op_invalid (whole-page
///                                              writes must not ride this op — they
///                                              would stomp concurrent tile edits).
///   pageRemove       page       page id        —              (missing page: no-op)
///   pageReorder      doc        null           pageIds: string[] — surviving pages
///                                              follow this order; pages the list
///                                              does not know (concurrent adds)
///                                              keep relative order at the end, so
///                                              a stale reorder never drops a page
///   docElementUpsert doc        element id     field: "filterCards" | "bookmarks"
///                                              | "parameters"; element: object
///                                              (element.id == targetId)
///   docElementRemove doc        element id     field: as above (missing: no-op)
///   docSettingSet    doc        null           key: string (NOT "pages"/"tiles" —
///                                              structure must go through the
///                                              dedicated ops so permission classes
///                                              and per-element merge hold);
///                                              value: any JSON (property absent ⇒
///                                              REMOVE the key)
///
/// Name/description/modelId/isShared are DB columns, not layout keys, so they
/// are unreachable by construction — "non-layout fields are not ops".
///
/// PAYLOADS ARE STRICT: a payload carrying any top-level property its kind
/// does not declare is rejected (op_invalid), never ignored. Receivers
/// re-apply PayloadJson verbatim, so a field the server silently skipped
/// could still be interpreted by a client — strictness keeps the server's
/// application and every receiver's application provably the same op, and
/// turns typos (pageid vs pageId) into loud errors instead of silent no-ops.
/// Content INSIDE the declared objects (tile/page/element bodies) stays
/// opaque, exactly like the stored doc itself.
///
/// Doc-shape rules mirror the differ exactly: a doc is PAGED when pages is a
/// non-empty array; otherwise tile ops work the legacy top-level tiles[] and
/// page-structure ops are refused (op_target_missing) — legacy docs migrate to
/// pages through a full save, never through ops.
///
/// Removal kinds are IDEMPOTENT (already-gone target ⇒ unchanged doc): under
/// per-tile last-writer-wins a duplicate/replayed remove is normal traffic,
/// not an error. Kinds that need their target (geometry, rename, …) answer a
/// vanished target with rcd.dashboard.op_target_missing (409) — the client's
/// reconnect doctrine is refetch, so a conflict answer must push it there.
/// </summary>
internal static class DashboardOpApplier
{
    internal const string TargetTile = "tile";
    internal const string TargetPage = "page";
    internal const string TargetDoc = "doc";

    /// <summary>Doc-level arrays whose elements are id-keyed (the differ's "settings" that merge per element).</summary>
    private static readonly string[] ElementFields = ["filterCards", "bookmarks", "parameters"];

    /// <summary>Structural keys docSettingSet must never write (dedicated ops own them).</summary>
    private static readonly string[] StructuralKeys = ["pages", "tiles"];

    /// <summary>The page-level scalar properties pageSet may patch (and nothing else).</summary>
    private static readonly string[] PageSetPatchKeys = ["mobileLayout", "drillthrough"];

    /// <summary>
    /// Per-kind ALLOWED top-level payload properties (strict — see the class
    /// remarks): the kind's required target row plus every optional field.
    /// </summary>
    private static readonly Dictionary<string, string[]> AllowedPayloadFields = new(StringComparer.Ordinal)
    {
        ["tileUpsert"] = ["kind", "tile", "pageId"],
        ["tileRemove"] = ["kind"],
        ["tileGeometry"] = ["kind", "layout"],
        ["pageAdd"] = ["kind", "page", "index"],
        ["pageRename"] = ["kind", "name"],
        ["pageColor"] = ["kind", "color"],
        ["pageSet"] = ["kind", "patch"],
        ["pageRemove"] = ["kind"],
        ["pageReorder"] = ["kind", "pageIds"],
        ["docElementUpsert"] = ["kind", "field", "element"],
        ["docElementRemove"] = ["kind", "field"],
        ["docSettingSet"] = ["kind", "key", "value"],
    };

    internal sealed record OpApplication(string? NewLayoutJson, ServiceError? Error)
    {
        public bool Succeeded => Error is null;

        public static OpApplication Ok(string newLayoutJson) => new(newLayoutJson, null);

        public static OpApplication Fail(ServiceError error) => new(null, error);
    }

    internal static OpApplication Apply(string layoutJson, string targetKind, string? targetId, string payloadJson)
    {
        JsonObject payload;
        try
        {
            // Same depth cap as save validation: an op payload is a fragment of
            // a valid layout, so it can never legitimately need more.
            var parsed = JsonNode.Parse(payloadJson, documentOptions: new JsonDocumentOptions { MaxDepth = 32 });
            if (parsed is not JsonObject parsedObject)
            {
                return Invalid("Op payload must be a JSON object.");
            }

            payload = parsedObject;
        }
        catch (JsonException ex)
        {
            return Invalid($"Op payload is not valid JSON: {ex.Message}");
        }

        if (payload["kind"] is not JsonValue kindValue || kindValue.GetValueKind() != JsonValueKind.String)
        {
            return Invalid("Op payload needs a string 'kind'.");
        }

        var kind = kindValue.GetValue<string>();
        var expectedTarget = kind switch
        {
            "tileUpsert" or "tileRemove" or "tileGeometry" => (Kind: TargetTile, NeedsId: true),
            "pageAdd" or "pageRename" or "pageColor" or "pageSet" or "pageRemove" => (Kind: TargetPage, NeedsId: true),
            "docElementUpsert" or "docElementRemove" => (Kind: TargetDoc, NeedsId: true),
            "pageReorder" or "docSettingSet" => (Kind: TargetDoc, NeedsId: false),
            _ => default,
        };

        if (expectedTarget == default)
        {
            return Invalid($"Unknown op kind '{kind}'.");
        }

        // Strict payload shape: unknown extra fields are ERRORS, not noise —
        // receivers re-apply this payload verbatim, so a field the server
        // skipped could still act on a client (see class remarks).
        var allowed = AllowedPayloadFields[kind];
        foreach (var property in payload)
        {
            if (!allowed.Contains(property.Key, StringComparer.Ordinal))
            {
                return Invalid(
                    $"Op kind '{kind}' does not accept a '{property.Key}' field "
                    + $"(allowed: {string.Join(", ", allowed)}).");
            }
        }

        if (!string.Equals(targetKind, expectedTarget.Kind, StringComparison.Ordinal))
        {
            return Invalid($"Op kind '{kind}' requires targetKind '{expectedTarget.Kind}', got '{targetKind}'.");
        }

        if (expectedTarget.NeedsId ? string.IsNullOrEmpty(targetId) : targetId is not null)
        {
            return Invalid(expectedTarget.NeedsId
                ? $"Op kind '{kind}' requires a targetId."
                : $"Op kind '{kind}' takes no targetId.");
        }

        JsonObject root;
        try
        {
            // Differ's depth cap: the stored doc passed save validation, but a
            // pre-library row could hold anything — answer with a conflict that
            // sends the client to refetch/full-save rather than a 500.
            if (JsonNode.Parse(layoutJson, documentOptions: new JsonDocumentOptions { MaxDepth = 64 })
                is not JsonObject parsedRoot)
            {
                return TargetMissing("The stored layout is not an object; save the dashboard in full to repair it.");
            }

            root = parsedRoot;
        }
        catch (JsonException)
        {
            return TargetMissing("The stored layout could not be parsed; save the dashboard in full to repair it.");
        }

        var result = kind switch
        {
            "tileUpsert" => ApplyTileUpsert(root, targetId!, payload),
            "tileRemove" => ApplyTileRemove(root, targetId!),
            "tileGeometry" => ApplyTileGeometry(root, targetId!, payload),
            "pageAdd" => ApplyPageAdd(root, targetId!, payload),
            "pageRename" => ApplyPageRename(root, targetId!, payload),
            "pageColor" => ApplyPageColor(root, targetId!, payload),
            "pageSet" => ApplyPageSet(root, targetId!, payload),
            "pageRemove" => ApplyPageRemove(root, targetId!),
            "pageReorder" => ApplyPageReorder(root, payload),
            "docElementUpsert" => ApplyDocElementUpsert(root, targetId!, payload),
            "docElementRemove" => ApplyDocElementRemove(root, targetId!, payload),
            "docSettingSet" => ApplyDocSettingSet(root, payload),
            _ => Invalid($"Unknown op kind '{kind}'."), // unreachable; kind validated above
        };

        return result ?? OpApplication.Ok(root.ToJsonString());
    }

    // ------------------------------- tile ops -------------------------------

    private static OpApplication? ApplyTileUpsert(JsonObject root, string targetId, JsonObject payload)
    {
        if (payload["tile"] is not JsonObject tile)
        {
            return Invalid("tileUpsert needs a 'tile' object.");
        }

        if (!string.Equals(GetString(tile, "id"), targetId, StringComparison.Ordinal))
        {
            return Invalid("tileUpsert: tile.id must equal targetId.");
        }

        if (FindTile(root, targetId) is { } found)
        {
            // Replace IN PLACE (array position kept) — position is meaningless
            // to rendering but keeping it minimizes diff noise for reviewers.
            found.Tiles[found.Index] = tile.DeepClone();
            return null;
        }

        // ADD. Paged docs need to know which page receives the tile.
        if (PagesOf(root) is { } pages)
        {
            var pageId = GetString(payload, "pageId");
            if (string.IsNullOrEmpty(pageId))
            {
                return Invalid("tileUpsert adding a new tile to a paged layout needs 'pageId'.");
            }

            if (FindPage(pages, pageId) is not { } page)
            {
                return TargetMissing($"Page '{pageId}' no longer exists.");
            }

            if (GetOrCreateTiles(page.Page) is not { } pageTiles)
            {
                return TargetMissing($"Page '{pageId}' has a non-array tiles property.");
            }

            pageTiles.Add(tile.DeepClone());
            return null;
        }

        // Legacy doc: the top-level tiles[] IS the single implicit page.
        if (GetOrCreateTiles(root) is not { } rootTiles)
        {
            return TargetMissing("The layout has a non-array tiles property.");
        }

        rootTiles.Add(tile.DeepClone());
        return null;
    }

    private static OpApplication? ApplyTileRemove(JsonObject root, string targetId)
    {
        if (FindTile(root, targetId) is { } found)
        {
            found.Tiles.RemoveAt(found.Index);
        }

        // Already gone (concurrent remove / replay): idempotent no-op.
        return null;
    }

    private static OpApplication? ApplyTileGeometry(JsonObject root, string targetId, JsonObject payload)
    {
        if (payload["layout"] is not JsonObject layout)
        {
            return Invalid("tileGeometry needs a 'layout' object.");
        }

        if (FindTile(root, targetId) is not { } found)
        {
            return TargetMissing($"Tile '{targetId}' no longer exists.");
        }

        ((JsonObject)found.Tiles[found.Index]!)["layout"] = layout.DeepClone();
        return null;
    }

    // ------------------------------- page ops -------------------------------

    private static OpApplication? ApplyPageAdd(JsonObject root, string targetId, JsonObject payload)
    {
        if (payload["page"] is not JsonObject page)
        {
            return Invalid("pageAdd needs a 'page' object.");
        }

        if (!string.Equals(GetString(page, "id"), targetId, StringComparison.Ordinal))
        {
            return Invalid("pageAdd: page.id must equal targetId.");
        }

        // pageAdd tolerates an EMPTY pages array (unlike the other page ops,
        // which need an existing page anyway) — but not a legacy doc, where
        // creating pages[] would orphan the top-level tiles.
        if (root["pages"] is not JsonArray pages)
        {
            return root.ContainsKey("pages")
                ? TargetMissing("The layout's pages property is not an array.")
                : TargetMissing("This layout has no pages yet (legacy format); open and save it to migrate before page ops.");
        }

        var clone = page.DeepClone();
        if (FindPage(pages, targetId) is { } existing)
        {
            // Replayed add: upsert so retries stay idempotent. The differ still
            // classifies whatever actually changed, so gating stays honest.
            pages[existing.Index] = clone;
            return null;
        }

        var index = payload["index"] is JsonValue indexValue
            && indexValue.GetValueKind() == JsonValueKind.Number
            && indexValue.TryGetValue<int>(out var parsed)
                ? Math.Clamp(parsed, 0, pages.Count)
                : pages.Count;
        pages.Insert(index, clone);
        return null;
    }

    private static OpApplication? ApplyPageRename(JsonObject root, string targetId, JsonObject payload)
    {
        if (payload["name"] is not JsonValue nameValue || nameValue.GetValueKind() != JsonValueKind.String)
        {
            return Invalid("pageRename needs a string 'name'.");
        }

        if (FindPageInDoc(root, targetId) is not { } page)
        {
            return TargetMissing($"Page '{targetId}' no longer exists.");
        }

        page["name"] = nameValue.GetValue<string>();
        return null;
    }

    private static OpApplication? ApplyPageColor(JsonObject root, string targetId, JsonObject payload)
    {
        if (FindPageInDoc(root, targetId) is not { } page)
        {
            return TargetMissing($"Page '{targetId}' no longer exists.");
        }

        if (payload.TryGetPropertyValue("color", out var color))
        {
            page["color"] = color?.DeepClone();
        }
        else
        {
            page.Remove("color");
        }

        return null;
    }

    /// <summary>
    /// Shallow patch of the page's mobileLayout/drillthrough scalars. The
    /// three-state contract, precisely: a patch key PRESENT with a non-null
    /// value SETS the page property; PRESENT with JSON null REMOVES it (the
    /// canonical "no value" shape is an absent key, which is also what the
    /// differ compares against); ABSENT leaves the page property untouched.
    /// Exists because pageAdd's whole-page replace would stomp concurrent
    /// tile edits inside the page — this op touches nothing but the two keys.
    /// </summary>
    private static OpApplication? ApplyPageSet(JsonObject root, string targetId, JsonObject payload)
    {
        if (payload["patch"] is not JsonObject patch)
        {
            return Invalid("pageSet needs a 'patch' object.");
        }

        foreach (var property in patch)
        {
            if (!PageSetPatchKeys.Contains(property.Key, StringComparer.Ordinal))
            {
                return Invalid(
                    $"pageSet patch only accepts: {string.Join(", ", PageSetPatchKeys)} "
                    + "(whole-page writes must go through pageAdd/tile ops).");
            }
        }

        if (FindPageInDoc(root, targetId) is not { } page)
        {
            return TargetMissing($"Page '{targetId}' no longer exists.");
        }

        foreach (var (key, value) in patch)
        {
            if (value is null)
            {
                page.Remove(key); // JSON null clears back to the absent-key shape
            }
            else
            {
                page[key] = value.DeepClone();
            }
        }

        return null;
    }

    private static OpApplication? ApplyPageRemove(JsonObject root, string targetId)
    {
        if (root["pages"] is JsonArray pages && FindPage(pages, targetId) is { } found)
        {
            pages.RemoveAt(found.Index);
        }

        // Already gone (or legacy doc): idempotent no-op.
        return null;
    }

    private static OpApplication? ApplyPageReorder(JsonObject root, JsonObject payload)
    {
        if (payload["pageIds"] is not JsonArray idsNode)
        {
            return Invalid("pageReorder needs a 'pageIds' array.");
        }

        var order = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var entry in idsNode)
        {
            if (entry is not JsonValue value || value.GetValueKind() != JsonValueKind.String)
            {
                return Invalid("pageReorder: pageIds must contain only strings.");
            }

            order.TryAdd(value.GetValue<string>(), order.Count);
        }

        if (root["pages"] is not JsonArray pages)
        {
            return TargetMissing("This layout has no pages to reorder.");
        }

        // Resilient reorder: listed pages take the listed order; pages the op
        // does not know about (added concurrently) keep their relative order
        // AFTER the listed ones — a stale reorder can shuffle but never drop.
        var current = pages.ToList();
        pages.Clear(); // detach so the nodes can be re-added in the new order
        foreach (var node in current
                     .Select((node, index) => (node, index))
                     .OrderBy(entry => OrderOf(entry.node))
                     .ThenBy(entry => entry.index)
                     .Select(entry => entry.node))
        {
            pages.Add(node);
        }

        return null;

        int OrderOf(JsonNode? node) =>
            node is JsonObject page
            && GetString(page, "id") is { } id
            && order.TryGetValue(id, out var position)
                ? position
                : int.MaxValue;
    }

    // -------------------------------- doc ops --------------------------------

    private static OpApplication? ApplyDocElementUpsert(JsonObject root, string targetId, JsonObject payload)
    {
        if (ResolveElementField(payload) is not { } field)
        {
            return Invalid($"docElementUpsert needs 'field' set to one of: {string.Join(", ", ElementFields)}.");
        }

        if (payload["element"] is not JsonObject element)
        {
            return Invalid("docElementUpsert needs an 'element' object.");
        }

        if (!string.Equals(GetString(element, "id"), targetId, StringComparison.Ordinal))
        {
            return Invalid("docElementUpsert: element.id must equal targetId.");
        }

        JsonArray array;
        if (root[field] is JsonArray existing)
        {
            array = existing;
        }
        else if (!root.ContainsKey(field))
        {
            array = [];
            root[field] = array;
        }
        else
        {
            return TargetMissing($"The layout's {field} property is not an array.");
        }

        var clone = element.DeepClone();
        for (var i = 0; i < array.Count; i++)
        {
            if (array[i] is JsonObject item && string.Equals(GetString(item, "id"), targetId, StringComparison.Ordinal))
            {
                array[i] = clone;
                return null;
            }
        }

        array.Add(clone);
        return null;
    }

    private static OpApplication? ApplyDocElementRemove(JsonObject root, string targetId, JsonObject payload)
    {
        if (ResolveElementField(payload) is not { } field)
        {
            return Invalid($"docElementRemove needs 'field' set to one of: {string.Join(", ", ElementFields)}.");
        }

        if (root[field] is JsonArray array)
        {
            for (var i = 0; i < array.Count; i++)
            {
                if (array[i] is JsonObject item && string.Equals(GetString(item, "id"), targetId, StringComparison.Ordinal))
                {
                    array.RemoveAt(i);
                    break;
                }
            }
        }

        // Absent field / element: idempotent no-op.
        return null;
    }

    private static OpApplication? ApplyDocSettingSet(JsonObject root, JsonObject payload)
    {
        if (payload["key"] is not JsonValue keyValue
            || keyValue.GetValueKind() != JsonValueKind.String
            || keyValue.GetValue<string>() is not { Length: > 0 } key)
        {
            return Invalid("docSettingSet needs a non-empty string 'key'.");
        }

        if (StructuralKeys.Contains(key, StringComparer.Ordinal))
        {
            return Invalid($"docSettingSet must not write '{key}' — page/tile structure has dedicated ops.");
        }

        if (payload.TryGetPropertyValue("value", out var value))
        {
            root[key] = value?.DeepClone();
        }
        else
        {
            root.Remove(key);
        }

        return null;
    }

    // ------------------------------- doc helpers -------------------------------

    /// <summary>Paged exactly like the differ: pages is a non-empty array. Null = legacy doc.</summary>
    private static JsonArray? PagesOf(JsonObject root) =>
        root["pages"] is JsonArray pages && pages.Count > 0 ? pages : null;

    private static (JsonArray Tiles, int Index)? FindTile(JsonObject root, string tileId)
    {
        if (PagesOf(root) is { } pages)
        {
            foreach (var pageNode in pages)
            {
                if (pageNode is JsonObject page
                    && page["tiles"] is JsonArray tiles
                    && IndexOfId(tiles, tileId) is { } index)
                {
                    return (tiles, index);
                }
            }

            return null;
        }

        return root["tiles"] is JsonArray rootTiles && IndexOfId(rootTiles, tileId) is { } rootIndex
            ? (rootTiles, rootIndex)
            : null;
    }

    private static (JsonObject Page, int Index)? FindPage(JsonArray pages, string pageId)
    {
        for (var i = 0; i < pages.Count; i++)
        {
            if (pages[i] is JsonObject page && string.Equals(GetString(page, "id"), pageId, StringComparison.Ordinal))
            {
                return (page, i);
            }
        }

        return null;
    }

    private static JsonObject? FindPageInDoc(JsonObject root, string pageId) =>
        root["pages"] is JsonArray pages ? FindPage(pages, pageId)?.Page : null;

    private static int? IndexOfId(JsonArray tiles, string id)
    {
        for (var i = 0; i < tiles.Count; i++)
        {
            if (tiles[i] is JsonObject tile && string.Equals(GetString(tile, "id"), id, StringComparison.Ordinal))
            {
                return i;
            }
        }

        return null;
    }

    /// <summary>The container's tiles array, created when absent; null when present but not an array.</summary>
    private static JsonArray? GetOrCreateTiles(JsonObject container)
    {
        if (container["tiles"] is JsonArray tiles)
        {
            return tiles;
        }

        if (container.ContainsKey("tiles"))
        {
            return null;
        }

        var created = new JsonArray();
        container["tiles"] = created;
        return created;
    }

    private static string? ResolveElementField(JsonObject payload) =>
        GetString(payload, "field") is { } field && ElementFields.Contains(field, StringComparer.Ordinal)
            ? field
            : null;

    private static string? GetString(JsonObject obj, string name) =>
        obj[name] is JsonValue value && value.GetValueKind() == JsonValueKind.String
            ? value.GetValue<string>()
            : null;

    private static OpApplication Invalid(string message) =>
        OpApplication.Fail(new ServiceError(
            ServiceErrorKind.BadRequest, "rcd.dashboard.op_invalid", message));

    private static OpApplication TargetMissing(string message) =>
        OpApplication.Fail(new ServiceError(
            ServiceErrorKind.Conflict, "rcd.dashboard.op_target_missing", message));
}
