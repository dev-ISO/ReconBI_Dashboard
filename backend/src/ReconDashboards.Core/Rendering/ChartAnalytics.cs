namespace ReconDashboards.Core.Rendering;

/// <summary>
/// C# port of the frontend's chart analytics (chart/analytics.ts): the
/// reference-line statistics and the trendline fits behind the two overlays the
/// email now draws. Pure arithmetic over one series' plotted values — nulls are
/// gaps, never zeros.
/// </summary>
public static class ChartAnalytics
{
    /// <summary>
    /// The value axis position of a reference line. Computed kinds read the FULL
    /// plotted dataset (the frontend ignores legend visibility for the same
    /// reason: a guide the author anchored must not move while the reader
    /// explores). Null = nothing to draw.
    /// </summary>
    public static double? ReferenceValue(string? kind, double? constant, IReadOnlyList<double?> values)
    {
        if (kind is null or "constant")
        {
            return constant is { } c && double.IsFinite(c) ? c : null;
        }

        var numbers = values.Where(v => v is { } n && double.IsFinite(n)).Select(v => v!.Value).ToList();
        if (numbers.Count == 0)
        {
            return null;
        }

        switch (kind)
        {
            case "average":
                return numbers.Average();
            case "median":
                var sorted = numbers.Order().ToList();
                var mid = sorted.Count / 2;
                return sorted.Count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            case "min":
                return numbers.Min();
            case "max":
                return numbers.Max();
            default:
                return null;
        }
    }

    /// <summary>
    /// Least-squares fit with x = category index. Nulls are skipped when fitting
    /// but EVERY index gets a fitted value, so the overlay spans the whole axis.
    /// All-null below two points (nothing to fit) or with zero x-variance.
    /// </summary>
    public static double?[] LinearFit(IReadOnlyList<double?> values)
    {
        double sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        var n = 0;
        for (var i = 0; i < values.Count; i++)
        {
            if (values[i] is not { } y || !double.IsFinite(y))
            {
                continue;
            }

            sumX += i;
            sumY += y;
            sumXY += i * y;
            sumXX += (double)i * i;
            n++;
        }

        var denominator = (n * sumXX) - (sumX * sumX);
        if (n < 2 || Math.Abs(denominator) < 1e-12)
        {
            return new double?[values.Count];
        }

        var slope = ((n * sumXY) - (sumX * sumY)) / denominator;
        var intercept = (sumY - (slope * sumX)) / n;
        return [.. Enumerable.Range(0, values.Count).Select(i => (double?)(intercept + (slope * i)))];
    }

    /// <summary>
    /// TRAILING moving average (the window ENDS at each index, like most BI
    /// tools). Indexes without a full window of numbers stay null, so the
    /// overlay starts once the window fills.
    /// </summary>
    public static double?[] MovingAverage(IReadOnlyList<double?> values, int window)
    {
        var size = Math.Max(1, window);
        var result = new double?[values.Count];
        for (var i = 0; i < values.Count; i++)
        {
            if (i < size - 1)
            {
                continue;
            }

            var sum = 0d;
            var complete = true;
            for (var j = i - size + 1; j <= i; j++)
            {
                if (values[j] is not { } v || !double.IsFinite(v))
                {
                    complete = false; // partial windows stay blank
                    break;
                }

                sum += v;
            }

            if (complete)
            {
                result[i] = sum / size;
            }
        }

        return result;
    }
}
