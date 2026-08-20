using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Rendering;

/// <summary>How the category-axis labels are drawn once they no longer fit upright.</summary>
public enum LabelFitMode
{
    /// <summary>Upright, centered under the tick.</summary>
    Horizontal,

    /// <summary>Rotated -35°, anchored at the tick so the text hangs down-left.</summary>
    Angled,

    /// <summary>Rotated -90°, reading bottom-up.</summary>
    Vertical,

    /// <summary>Even vertical text collides: label a clean SUBSET plus the last bucket.</summary>
    Thin,
}

/// <summary>Resolved mode plus the axis height it needs below the plot.</summary>
public sealed record ResolvedLabelFit(LabelFitMode Mode, double Height, double SlotWidth, int Step)
{
    /// <summary>Whether category <paramref name="index"/> gets a label at all.</summary>
    public bool Labels(int index, int count) =>
        Mode != LabelFitMode.Thin || index % Step == 0 || index == count - 1;
}

/// <summary>
/// C# port of the frontend's category-axis label fitting (chart/axisFit.tsx
/// resolveLabelFit): pick the LEAST rotated mode that still labels every bucket
/// — horizontal → angled (-35°) → vertical (-90°) — and only when even vertical
/// text physically collides fall back to a thinned subset. The server measures
/// with the layout engine's own estimator (0.55 × fontSize per char ≈ 6.05px at
/// 11px) rather than a canvas; the browser's DOM-less fallback is 6.2px/char, so
/// the two agree to within a few percent.
/// </summary>
public static class ChartLabelFit
{
    /// <summary>Minimum clear gap between adjacent horizontal labels.</summary>
    private const double HorizontalGap = 6;

    /// <summary>Slot width below which -35° labels collide.</summary>
    private const double AngleMinSlot = 20;

    private const double LineHeight = 12;

    /// <summary>Vertical labels need one line height per slot.</summary>
    private const double VerticalMinSlot = LineHeight + 1;

    private const double AngleSin = 0.574; // sin 35°

    /// <summary>Angled labels longer than this are ellipsized (caps the reserved height).</summary>
    public const double AngleMaxPixels = 120;

    /// <summary>Vertical labels longer than this are ellipsized.</summary>
    public const double VerticalMaxPixels = 80;

    /// <summary>recharts' stock XAxis height, which upright ticks keep.</summary>
    private const double HorizontalHeight = 30;

    public static ResolvedLabelFit Resolve(
        IReadOnlyList<string> labels, double slotWidth, AxisLabelFitDoc? fit, Func<string, double> measure)
    {
        var maxWidth = labels.Count == 0 ? 0 : labels.Max(measure);
        var requested = fit?.Mode ?? "auto";
        var mode = requested switch
        {
            "horizontal" => LabelFitMode.Horizontal,
            "angled" => LabelFitMode.Angled,
            "vertical" => LabelFitMode.Vertical,
            // 'wrap' needs multi-line tick text the layout record cannot carry
            // yet; angled keeps every bucket labeled, which is what wrap is for.
            "wrap" => LabelFitMode.Angled,
            _ => maxWidth + HorizontalGap <= slotWidth ? LabelFitMode.Horizontal
                : slotWidth >= AngleMinSlot ? LabelFitMode.Angled
                : slotWidth >= VerticalMinSlot ? LabelFitMode.Vertical
                : LabelFitMode.Thin,
        };

        var height = mode switch
        {
            LabelFitMode.Angled => Math.Ceiling(Math.Min(maxWidth, AngleMaxPixels) * AngleSin) + 16,
            LabelFitMode.Vertical => Math.Ceiling(Math.Min(maxWidth, VerticalMaxPixels)) + 14,
            _ => HorizontalHeight,
        };

        // Thinning keeps every Nth bucket: the step is the slots one label needs.
        var step = mode == LabelFitMode.Thin && slotWidth > 0
            ? Math.Max(1, (int)Math.Ceiling((maxWidth + 8) / slotWidth))
            : 1;
        return new ResolvedLabelFit(mode, height, slotWidth, step);
    }

    /// <summary>
    /// Ellipsizes to a pixel budget with the same estimator the fit used — the
    /// browser binary-searches the canvas, which is the same idea at higher
    /// precision.
    /// </summary>
    public static string TruncateToWidth(string text, double maxPixels, double perChar)
    {
        if (perChar <= 0 || text.Length * perChar <= maxPixels)
        {
            return text;
        }

        var chars = (int)Math.Floor(maxPixels / perChar) - 1;
        return chars < 1 ? "…" : text[..Math.Min(text.Length, chars)] + "…";
    }
}
