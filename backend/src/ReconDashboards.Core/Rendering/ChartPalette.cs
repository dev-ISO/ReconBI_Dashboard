namespace ReconDashboards.Core.Rendering;

/// <summary>
/// Series color resolution for server-rendered chart PNGs, mirroring the
/// frontend (util/palette.ts seriesColor): explicit per-series override →
/// theme palette hex → fixed categorical slot. The 'default' theme uses the
/// print view's hardcoded light-token values (DashboardPrintView LIGHT_TOKENS)
/// — email is light paper, exactly like print. Hue identities are stable
/// across releases; keep both maps in lockstep with the frontend.
/// </summary>
public static class ChartPalette
{
    public const int CategoricalSlots = 8;

    /// <summary>rcd.css light-theme --rcd-cat-1..8 (DashboardPrintView.tsx LIGHT_TOKENS).</summary>
    public static readonly IReadOnlyList<string> DefaultTheme =
        ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

    /// <summary>CHART_THEMES from frontend palette.ts:20-26 — literal hex, identical in both UI modes.</summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> Themes =
        new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            ["ocean"] = ["#1868ae", "#26a5b8", "#5fc3cd", "#0e4d92", "#5aa9e6", "#2d5f86", "#3caea3", "#6cc48f"],
            ["sunset"] = ["#f2542d", "#f9a03f", "#f5c33c", "#d81159", "#8f2d56", "#fb6f92", "#eda60a", "#c1440e"],
            ["forest"] = ["#2d6a4f", "#74c69d", "#40916c", "#93cfa9", "#27593f", "#7fc59b", "#588157", "#3f5d4b"],
            ["berry"] = ["#7b2cbf", "#c77dff", "#9d4edd", "#c793f2", "#5a189a", "#ff5d8f", "#b5179e", "#53228c"],
            ["mono"] = ["#1f2937", "#4b5563", "#6b7280", "#9ca3af", "#374151", "#aab1bb", "#111827", "#c3c8d0"],
        };

    // Chart chrome, from the same light-token map: text, secondary text,
    // muted, gridlines, axis lines. The PNG background stays white so the
    // image blends into the email body.
    public const string Background = "#ffffff";
    public const string Text = "#0b0b0b";
    public const string Text2 = "#52514e";
    public const string Muted = "#898781";
    public const string GridLine = "#e1e0d9";
    public const string Axis = "#c3c2b7";

    /// <summary>Override (keyed by the series' default display name) → theme hex → default slot.</summary>
    public static string SeriesColor(
        int index,
        string? seriesKey = null,
        IReadOnlyDictionary<string, string>? overrides = null,
        string? theme = null)
    {
        if (seriesKey is not null && overrides is not null
            && overrides.TryGetValue(seriesKey, out var value) && !string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        if (theme is not null && Themes.TryGetValue(theme, out var palette))
        {
            return palette[Modulo(index, palette.Count)];
        }

        return DefaultTheme[Modulo(index, CategoricalSlots)];
    }

    private static int Modulo(int index, int count) => ((index % count) + count) % count;
}
