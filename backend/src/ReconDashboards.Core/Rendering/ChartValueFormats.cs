using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Rendering;

/// <summary>
/// C# port of the frontend's cell/axis text formatting (util/format.ts) so a
/// server-rendered chart says exactly what the screen says. Invariant culture
/// throughout (the frontend runs Intl with the browser locale — en-US on this
/// deployment; invariant matches its digits, grouping, and English month/day
/// names). Pure and defensive: a malformed pattern falls back to the default
/// formatting instead of throwing.
/// </summary>
public static class ChartValueFormats
{
    private const string BlankLabel = "(Blank)";

    /// <summary>
    /// ISO date-only ("2026-08-04") and NAIVE timestamps (no zone suffix)
    /// denote calendar parts, not instants (format.ts NAIVE_ISO).
    /// </summary>
    private static readonly Regex NaiveIso = new(
        @"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$",
        RegexOptions.Compiled);

    // ------------------------------------------------------------ number side

    /// <summary>One piece of a parsed number section: literal, the digit mask, or %.</summary>
    private readonly record struct NumberToken(char Kind, string Text); // 'l' literal / 'n' number / 'p' percent

    private sealed record NumberSection(
        IReadOnlyList<NumberToken> Tokens,
        bool Percent,
        double Scale,
        bool Grouping,
        int MinInt,
        int MinFrac,
        int MaxFrac,
        bool HasNumber);

    /// <summary>Default number format: grouping, at most 2 fraction digits (Intl default twin).</summary>
    public static string DefaultNumber(double value) =>
        double.IsFinite(value) ? value.ToString("#,0.##", CultureInfo.InvariantCulture) : value.ToString(CultureInfo.InvariantCulture);

    private static string DefaultCurrency(double value) =>
        value.ToString("$#,0", CultureInfo.InvariantCulture);

    private static string DefaultPercent(double value) =>
        (value * 100).ToString("#,0.#", CultureInfo.InvariantCulture) + "%";

    /// <summary>Splits `pos;neg;zero` on ';' — separators inside "quoted" literals don't count.</summary>
    private static List<string> SplitPatternSections(string pattern)
    {
        var sections = new List<string>();
        var current = new StringBuilder();
        var inQuote = false;
        foreach (var ch in pattern)
        {
            if (ch == '"')
            {
                inQuote = !inQuote;
                current.Append(ch);
                continue;
            }

            if (ch == ';' && !inQuote)
            {
                sections.Add(current.ToString());
                current.Clear();
                continue;
            }

            current.Append(ch);
        }

        sections.Add(current.ToString());
        return sections;
    }

    /// <summary>
    /// Parses one section into tokens + digit-mask facts. Only the FIRST
    /// contiguous run of `#0.,` is the number; everything else passes through
    /// as literals. Null = unparseable (unbalanced quote).
    /// </summary>
    private static NumberSection? ParseNumberSection(string section)
    {
        var tokens = new List<NumberToken>();
        var percent = false;
        var mask = "";
        var sawNumber = false;
        var i = 0;
        while (i < section.Length)
        {
            var ch = section[i];
            if (ch == '"')
            {
                var close = section.IndexOf('"', i + 1);
                if (close == -1)
                {
                    return null;
                }

                tokens.Add(new NumberToken('l', section[(i + 1)..close]));
                i = close + 1;
                continue;
            }

            if (!sawNumber && ch is '#' or '0' or ',' or '.')
            {
                var j = i;
                while (j < section.Length && section[j] is '#' or '0' or ',' or '.')
                {
                    j++;
                }

                mask = section[i..j];
                tokens.Add(new NumberToken('n', ""));
                sawNumber = true;
                i = j;
                continue;
            }

            if (ch == '%')
            {
                percent = true;
                tokens.Add(new NumberToken('p', ""));
                i++;
                continue;
            }

            tokens.Add(new NumberToken('l', ch.ToString()));
            i++;
        }

        // Trailing commas AFTER the digits scale by a thousand each (0.0,, -> millions).
        var scale = 1d;
        while (mask.EndsWith(','))
        {
            scale *= 1000;
            mask = mask[..^1];
        }

        var dot = mask.IndexOf('.');
        var intMaskRaw = dot == -1 ? mask : mask[..dot];
        var fracMask = dot == -1 ? "" : new string(mask[(dot + 1)..].Where(c => c is '#' or '0').ToArray());
        var grouping = intMaskRaw.Contains(',');
        var intMask = intMaskRaw.Replace(",", "");
        return new NumberSection(
            tokens,
            percent,
            scale,
            grouping,
            MinInt: intMask.Count(c => c == '0'),
            MinFrac: fracMask.Count(c => c == '0'),
            MaxFrac: fracMask.Length,
            HasNumber: sawNumber);
    }

    /// <summary>
    /// Renders one section; `absolute` strips the sign for a present negative
    /// section (it carries its own sign treatment — parens, a "-" literal…).
    /// </summary>
    private static string RenderNumberSection(double value, NumberSection section, bool absolute)
    {
        var v = absolute ? Math.Abs(value) : value;
        if (section.Percent)
        {
            v *= 100;
        }

        v /= section.Scale;
        var digits = "";
        if (section.HasNumber)
        {
            var minInt = Math.Min(Math.Max(section.MinInt, 1), 21);
            var minFrac = Math.Min(section.MinFrac, 20);
            var maxFrac = Math.Min(Math.Max(section.MaxFrac, section.MinFrac), 20);
            var format = new StringBuilder();
            format.Append(section.Grouping ? "#," : "");
            format.Append('0', minInt);
            if (maxFrac > 0)
            {
                format.Append('.');
                format.Append('0', minFrac);
                format.Append('#', maxFrac - minFrac);
            }

            digits = v.ToString(format.ToString(), CultureInfo.InvariantCulture);
        }

        var result = new StringBuilder();
        foreach (var token in section.Tokens)
        {
            result.Append(token.Kind switch
            {
                'l' => token.Text,
                'p' => "%",
                _ => digits,
            });
        }

        return result.ToString();
    }

    /// <summary>
    /// Excel-style number formatting (format.ts formatNumberPattern):
    /// `pos;neg;zero` sections, `0`/`#` placeholders, ',' grouping, '%'
    /// multiplies by 100, `"quoted"` literals, loose literal chars pass
    /// through, trailing commas scale by 1000 each. Never throws.
    /// </summary>
    public static string FormatNumberPattern(double value, string pattern)
    {
        try
        {
            if (!double.IsFinite(value) || string.IsNullOrWhiteSpace(pattern))
            {
                return DefaultNumber(value);
            }

            var sections = SplitPatternSections(pattern).Select(ParseNumberSection).ToList();
            if (sections.Count == 0 || sections.Any(s => s is null))
            {
                return DefaultNumber(value);
            }

            var positive = sections[0]!;
            var negative = sections.Count > 1 ? sections[1] : null;
            var zero = sections.Count > 2 ? sections[2] : null;
            // A default section with no digit placeholder would swallow the
            // value entirely — treat as a bad pattern; NEGATIVE/ZERO sections
            // may stay literal-only (the Excel "-" idiom).
            if (!positive.HasNumber)
            {
                return DefaultNumber(value);
            }

            if (value == 0 && zero is not null)
            {
                return RenderNumberSection(value, zero, absolute: false);
            }

            if (value < 0 && negative is not null)
            {
                return RenderNumberSection(value, negative, absolute: true);
            }

            return RenderNumberSection(value, positive, absolute: false);
        }
        catch
        {
            return DefaultNumber(value);
        }
    }

    /// <summary>
    /// Full pattern (digit placeholders or sections) vs a legacy loose hint
    /// ("$", "%", "currency", "percent")?
    /// </summary>
    private static bool IsNumberPattern(string s) => s.AsSpan().IndexOfAny('#', '0', ';') >= 0;

    /// <summary>
    /// Measure-value text with the chart precedence (spec §12): chart
    /// valueFormat override → measure FormatString → pattern-shaped FormatHint
    /// → legacy $/% hint sniff → default thousands format.
    /// </summary>
    public static string FormatMeasureValue(double value, ResultColumnPlan? column, string? valueFormat)
    {
        var pattern = !string.IsNullOrWhiteSpace(valueFormat) ? valueFormat : column?.FormatString ?? "";
        if (pattern.Length > 0 && IsNumberPattern(pattern))
        {
            return FormatNumberPattern(value, pattern);
        }

        var hint = pattern.Length > 0 ? pattern : column?.FormatHint ?? "";
        if (IsNumberPattern(hint))
        {
            return FormatNumberPattern(value, hint);
        }

        if (hint.Contains('$') || hint == "currency")
        {
            return DefaultCurrency(value);
        }

        if (hint.Contains('%') || hint == "percent")
        {
            return DefaultPercent(value);
        }

        return DefaultNumber(value);
    }

    // -------------------------------------------------------------- date side

    /// <summary>
    /// Parses a date-ish cell into calendar parts. The engine hands DateTime /
    /// DateOnly values whose parts ARE the calendar value; strings follow the
    /// frontend's NAIVE_ISO reading (a zoned suffix falls back to instant
    /// parsing, rendered from its UTC parts — the scheduler world has no
    /// browser-local zone).
    /// </summary>
    public static DateTime? ParseDateValue(object? value) => value switch
    {
        DateTime dt => dt,
        DateTimeOffset dto => dto.UtcDateTime,
        DateOnly d => d.ToDateTime(TimeOnly.MinValue),
        string s => ParseDateString(s),
        _ => null,
    };

    private static DateTime? ParseDateString(string value)
    {
        var match = NaiveIso.Match(value.Trim());
        if (match.Success)
        {
            try
            {
                return new DateTime(
                    int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture),
                    int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture),
                    int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture),
                    match.Groups[4].Success ? int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture) : 0,
                    match.Groups[5].Success ? int.Parse(match.Groups[5].Value, CultureInfo.InvariantCulture) : 0,
                    match.Groups[6].Success ? int.Parse(match.Groups[6].Value, CultureInfo.InvariantCulture) : 0);
            }
            catch (ArgumentOutOfRangeException)
            {
                return null;
            }
        }

        return DateTimeOffset.TryParse(
            value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed.UtcDateTime
            : null;
    }

    /// <summary>
    /// Date-mask tokens, LONGEST FIRST so the tokenizer never mis-splits.
    /// Case matters: MM = month, mm = minutes; Qq = quarter number.
    /// </summary>
    private static readonly (string Token, Func<DateTime, string> Render)[] DateMaskTokens =
    [
        ("yyyy", d => d.Year.ToString(CultureInfo.InvariantCulture)),
        ("MMMM", d => d.ToString("MMMM", CultureInfo.InvariantCulture)),
        ("EEEE", d => d.ToString("dddd", CultureInfo.InvariantCulture)),
        ("MMM", d => d.ToString("MMM", CultureInfo.InvariantCulture)),
        ("EEE", d => d.ToString("ddd", CultureInfo.InvariantCulture)),
        ("yy", d => (d.Year % 100).ToString("00", CultureInfo.InvariantCulture)),
        ("MM", d => d.Month.ToString("00", CultureInfo.InvariantCulture)),
        ("dd", d => d.Day.ToString("00", CultureInfo.InvariantCulture)),
        ("HH", d => d.Hour.ToString("00", CultureInfo.InvariantCulture)),
        ("mm", d => d.Minute.ToString("00", CultureInfo.InvariantCulture)),
        ("Qq", d => (((d.Month - 1) / 3) + 1).ToString(CultureInfo.InvariantCulture)),
        ("M", d => d.Month.ToString(CultureInfo.InvariantCulture)),
        ("d", d => d.Day.ToString(CultureInfo.InvariantCulture)),
    ];

    /// <summary>
    /// Formats a date by mask (format.ts formatDatePattern): yyyy yy MMMM MMM
    /// MM M dd d EEEE EEE Qq HH mm; quoted runs are literals; anything else
    /// passes through. Never throws.
    /// </summary>
    public static string FormatDatePattern(DateTime date, string mask)
    {
        var output = new StringBuilder();
        var i = 0;
        while (i < mask.Length)
        {
            var ch = mask[i];
            if (ch is '"' or '\'')
            {
                var close = mask.IndexOf(ch, i + 1);
                if (close == -1)
                {
                    // Unterminated quote: take the rest as literal.
                    output.Append(mask[(i + 1)..]);
                    break;
                }

                output.Append(mask[(i + 1)..close]);
                i = close + 1;
                continue;
            }

            var matched = false;
            foreach (var (token, render) in DateMaskTokens)
            {
                if (string.CompareOrdinal(mask, i, token, 0, token.Length) == 0)
                {
                    output.Append(render(date));
                    i += token.Length;
                    matched = true;
                    break;
                }
            }

            if (!matched)
            {
                output.Append(ch);
                i++;
            }
        }

        return output.ToString();
    }

    private static string MediumDate(DateTime d) => d.ToString("MMM d, yyyy", CultureInfo.InvariantCulture);

    private static string MonthYear(DateTime d) => d.ToString("MMM yyyy", CultureInfo.InvariantCulture);

    private static string Quarter(DateTime d) => $"Q{((d.Month - 1) / 3) + 1} {d.Year}";

    // --------------------------------------------------------- composed labels

    /// <summary>
    /// Human label for one cell driven by the column's type/bucket/format
    /// metadata (format.ts formatCellValue). Null = "(Blank)"; booleans Yes/No;
    /// numbers follow the pattern/hint precedence; date columns render
    /// bucket-aware calendar parts.
    /// </summary>
    public static string FormatCellValue(object? value, ResultColumnPlan column)
    {
        if (value is null)
        {
            return BlankLabel;
        }

        if (TryToNumber(value, out var number))
        {
            return FormatMeasureValue(number, column, valueFormat: null);
        }

        if (value is bool b)
        {
            return b ? "Yes" : "No";
        }

        if (column.Type is NormalizedType.Date or NormalizedType.Timestamp
            && ParseDateValue(value) is { } date)
        {
            return column.DateBucket switch
            {
                Querying.Spec.DateBucket.Year => date.Year.ToString(CultureInfo.InvariantCulture),
                Querying.Spec.DateBucket.Quarter => Quarter(date),
                Querying.Spec.DateBucket.Month => MonthYear(date),
                _ => MediumDate(date),
            };
        }

        return value switch
        {
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture) ?? "",
            _ => value.ToString() ?? "",
        };
    }

    /// <summary>
    /// Category label for an axis/slice cell (chartData.ts categoryLabel):
    /// date-BUCKETED columns honor the chart's date preset and custom mask
    /// (mask wins); everything else goes through FormatCellValue.
    /// </summary>
    public static string FormatCategoryLabel(
        object? value, ResultColumnPlan column, string? datePreset, string? dateMask)
    {
        if (column.DateBucket is null)
        {
            return FormatCellValue(value, column);
        }

        if (value is null)
        {
            return BlankLabel;
        }

        var parsed = ParseDateValue(value);
        if (parsed is { } date)
        {
            if (!string.IsNullOrEmpty(dateMask))
            {
                var custom = FormatDatePattern(date, dateMask);
                if (custom.Length > 0)
                {
                    return custom;
                }
            }

            if (datePreset is not (null or "auto"))
            {
                return datePreset switch
                {
                    "monthShort" => date.ToString("MMM", CultureInfo.InvariantCulture),
                    "monthLong" => date.ToString("MMMM", CultureInfo.InvariantCulture),
                    "monthNum" => date.Month.ToString(CultureInfo.InvariantCulture),
                    "monthYear" => MonthYear(date),
                    "dayShort" => date.ToString("ddd", CultureInfo.InvariantCulture),
                    "dayLong" => date.ToString("dddd", CultureInfo.InvariantCulture),
                    "dayOfMonth" => date.Day.ToString(CultureInfo.InvariantCulture),
                    "quarter" => Quarter(date),
                    "year" => date.Year.ToString(CultureInfo.InvariantCulture),
                    "isoDate" => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    _ => FormatCellValue(value, column),
                };
            }
        }

        return FormatCellValue(value, column);
    }

    /// <summary>
    /// CLR-numeric cell reading (formatCellValue's typeof === 'number' twin —
    /// numeric STRINGS stay strings here; the layout engine's value reader
    /// parses them separately, like the frontend's toNumber).
    /// </summary>
    public static bool TryToNumber(object? value, out double number)
    {
        switch (value)
        {
            case double d:
                number = d;
                return true;
            case float f:
                number = f;
                return true;
            case decimal dec:
                number = (double)dec;
                return true;
            case int i:
                number = i;
                return true;
            case long l:
                number = l;
                return true;
            case short s:
                number = s;
                return true;
            case byte by:
                number = by;
                return true;
            default:
                number = 0;
                return false;
        }
    }
}
