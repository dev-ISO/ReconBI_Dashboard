using System.Globalization;

namespace ReconDashboards.Core.Rendering;

/// <summary>
/// On-mark data-label composition, ported from the frontend's
/// util/dataLabels.ts composeDataLabel — the email chart's labels must say
/// exactly what the screen's labels say.
/// </summary>
public static class ChartDataLabels
{
    /// <summary>
    /// `formatted` is the value already rendered through the chart's value
    /// formatter; `value`/`total` are the raw numbers. Denominators are SIGNED
    /// sums, exactly what the axis/stack reads. When the total is not a
    /// positive finite number a share cannot be stated honestly and the label
    /// falls back to the plain value. content: "value" (default) | "percent" |
    /// "both".
    /// </summary>
    public static string Compose(string formatted, double value, double total, string? content)
    {
        var mode = content ?? "value";
        if (mode == "value" || (mode != "percent" && mode != "both"))
        {
            return formatted;
        }

        if (!double.IsFinite(value) || !double.IsFinite(total) || total <= 0)
        {
            return formatted;
        }

        var percent = (value / total * 100).ToString("F1", CultureInfo.InvariantCulture) + "%";
        return mode == "percent" ? percent : $"{formatted} ({percent})";
    }
}
