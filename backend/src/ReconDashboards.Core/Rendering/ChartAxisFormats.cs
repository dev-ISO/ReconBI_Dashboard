using System.Globalization;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Rendering;

/// <summary>
/// C# port of the frontend's numeric axis TICK formatting (util/format.ts
/// formatAxisValue, wired through ChartRenderer's axisTickFormatter). It applies
/// to axis ticks ONLY — on-mark data labels and the pie/KPI value keep the
/// measure precedence in <see cref="ChartValueFormats"/>. An unset (or 'auto')
/// AxisValueFormat is the plain default number, so an unformatted axis reads
/// exactly as it did before the field was parsed.
/// </summary>
public static class ChartAxisFormats
{
    /// <summary>Intl compact suffixes (en-US 'short' notation).</summary>
    private static readonly (double Threshold, string Suffix)[] CompactUnits =
    [
        (1e12, "T"),
        (1e9, "B"),
        (1e6, "M"),
        (1e3, "K"),
    ];

    /// <summary>
    /// Tick text for <paramref name="value"/> under an AxisValueFormat. The
    /// measure's own pattern is deliberately NOT consulted: the browser's
    /// axisTickFormatter reads the axis format alone.
    /// </summary>
    public static string FormatAxisValue(double value, AxisValueFormatDoc? format)
    {
        if (!double.IsFinite(value))
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        var decimals = format?.Decimals;
        return (format?.Kind ?? "auto") switch
        {
            "custom" => string.IsNullOrWhiteSpace(format?.Pattern)
                ? ChartValueFormats.DefaultNumber(value)
                : ChartValueFormats.FormatNumberPattern(value, format!.Pattern!),
            "currency" => Fixed(value, "$#,0", Math.Min(2, decimals ?? 0), decimals ?? 0),
            "percent" => Fixed(value * 100, "#,0", 0, decimals ?? 1) + "%",
            "compact" => Compact(value, decimals ?? 1),
            "number" => Fixed(value, "#,0", decimals ?? 0, decimals ?? 0),
            _ => ChartValueFormats.DefaultNumber(value),
        };
    }

    /// <summary>Whether the axis carries a real format (an unset/auto one changes nothing).</summary>
    public static bool IsActive(AxisValueFormatDoc? format) =>
        format is not null && format.Kind is not (null or "auto");

    /// <summary>`prefix` + grouped digits with min/max fraction digits, Intl-style.</summary>
    private static string Fixed(double value, string prefix, int minFrac, int maxFrac)
    {
        minFrac = Math.Clamp(minFrac, 0, 20);
        maxFrac = Math.Clamp(Math.Max(maxFrac, minFrac), 0, 20);
        var pattern = maxFrac == 0
            ? prefix
            : prefix + "." + new string('0', minFrac) + new string('#', maxFrac - minFrac);
        return value.ToString(pattern, CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Intl compact notation: 1200 -> "1.2K", 1_500_000 -> "1.5M". Rounding can
    /// push a value over its own unit (999_950 at 1 decimal), so the unit is
    /// re-checked after rounding — "1000K" would read as a bug.
    /// </summary>
    private static string Compact(double value, int decimals)
    {
        var digits = Math.Clamp(decimals, 0, 20);
        var magnitude = Math.Abs(value);
        for (var i = 0; i < CompactUnits.Length; i++)
        {
            var (threshold, suffix) = CompactUnits[i];
            if (magnitude < threshold)
            {
                continue;
            }

            var scaled = Math.Round(value / threshold, digits, MidpointRounding.AwayFromZero);
            if (Math.Abs(scaled) >= 1000 && i > 0)
            {
                // Rounding climbed into the next unit up; "1000K" reads as a bug.
                (threshold, suffix) = CompactUnits[i - 1];
                scaled = Math.Round(value / threshold, digits, MidpointRounding.AwayFromZero);
            }

            return Trimmed(scaled, digits) + suffix;
        }

        var rounded = Math.Round(value, digits, MidpointRounding.AwayFromZero);
        return Math.Abs(rounded) >= 1000
            ? Trimmed(Math.Round(rounded / 1000, digits, MidpointRounding.AwayFromZero), digits) + "K"
            : Trimmed(rounded, digits);
    }

    /// <summary>Grouped digits with trailing zeros dropped (Intl maximumFractionDigits).</summary>
    private static string Trimmed(double value, int digits) =>
        value.ToString(digits == 0 ? "#,0" : "#,0." + new string('#', digits), CultureInfo.InvariantCulture);
}
