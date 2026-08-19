using System.Text.Json;
using System.Text.Json.Serialization;
using ReconDashboards.Core.Json;

namespace ReconDashboards.Core.Scheduling;

/// <summary>What the email body carries per tile. Wire names: "tables", "charts", "both".</summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<SubscriptionContentBody>))]
public enum SubscriptionContentBody
{
    /// <summary>Legacy renderer output — also the behavior of a NULL ContentJson.</summary>
    Tables = 0,

    /// <summary>Visual tiles become cid PNG images; their tables are suppressed.</summary>
    Charts = 1,

    /// <summary>Image followed by that tile's table.</summary>
    Both = 2,
}

/// <summary>
/// Per-subscription email content composition — the parsed form of
/// rcd_subscriptions.ContentJson and the wire "content" object (camelCase,
/// EMAIL-CONTENT-DESIGN pinned shape). KPI/table/error tiles keep their HTML
/// blocks in every body mode; CSV stays additive exactly as before.
/// </summary>
public sealed record SubscriptionContentConfig(
    SubscriptionContentBody Body,
    IReadOnlyList<string> ExcludedTileIds,
    int ImageWidth,
    int MaxTableRows)
{
    public const int DefaultImageWidth = 600;
    public const int DefaultMaxTableRows = SnapshotRenderer.HtmlRowsPerTile;
    public const int MinTableRows = 5;
    public const int MaxTableRowsCeiling = 500;
    public const int MaxExcludedTiles = 200;
    public const int MaxTileIdLength = 100;

    /// <summary>Logical image widths the UI offers (Compact / Standard / Wide).</summary>
    public static readonly int[] AllowedImageWidths = [480, DefaultImageWidth, 900];

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Stored/wire JSON; stable camelCase regardless of host MVC configuration.</summary>
    public string ToJson() => JsonSerializer.Serialize(this, JsonOptions);

    /// <summary>
    /// Parses a stored ContentJson value. Null, blank, or malformed JSON all
    /// mean legacy behavior — a corrupt row degrades to tables rather than
    /// failing the send.
    /// </summary>
    public static SubscriptionContentConfig? FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            var parsed = JsonSerializer.Deserialize<SubscriptionContentConfig>(json, JsonOptions);
            return parsed is null
                ? null
                : parsed with { ExcludedTileIds = parsed.ExcludedTileIds ?? [] };
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
