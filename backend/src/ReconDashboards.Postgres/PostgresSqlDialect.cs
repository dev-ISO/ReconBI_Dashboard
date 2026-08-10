using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Postgres;

public sealed class PostgresSqlDialect : ISqlDialect
{
    public string ParameterPlaceholder(string name) => "@" + name;

    public string QuoteIdentifier(string identifier) =>
        "\"" + identifier.Replace("\"", "\"\"") + "\"";

    public string DateTrunc(DateBucket bucket, string expression)
    {
        var unit = bucket switch
        {
            DateBucket.Year => "year",
            DateBucket.Quarter => "quarter",
            DateBucket.Month => "month",
            DateBucket.Week => "week", // ISO week, Monday start
            DateBucket.Day => "day",
            _ => throw new ArgumentOutOfRangeException(nameof(bucket)),
        };
        return $"date_trunc('{unit}', {expression})";
    }

    public string Aggregate(Aggregation aggregation, string? argumentExpression) => aggregation switch
    {
        Aggregation.Count when argumentExpression is null => "COUNT(*)",
        Aggregation.Count => $"COUNT({argumentExpression})",
        Aggregation.CountDistinct => $"COUNT(DISTINCT {argumentExpression})",
        Aggregation.Sum => $"SUM({argumentExpression})",
        Aggregation.Avg => $"AVG({argumentExpression})",
        Aggregation.Min => $"MIN({argumentExpression})",
        Aggregation.Max => $"MAX({argumentExpression})",
        Aggregation.StdDev => $"STDDEV_SAMP({argumentExpression})",
        Aggregation.Variance => $"VAR_SAMP({argumentExpression})",
        Aggregation.Median => $"PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {argumentExpression})",
        _ => throw new ArgumentOutOfRangeException(nameof(aggregation)),
    };

    public string AggregateFilter(string aggregateExpression, string predicate) =>
        $"{aggregateExpression} FILTER (WHERE {predicate})";

    /// <summary>One array parameter regardless of value count — no parameter explosion.</summary>
    public string InPredicate(
        string expression,
        bool negated,
        IReadOnlyList<object?> values,
        NormalizedType elementType,
        ParameterBag parameters)
    {
        var placeholder = ParameterPlaceholder(parameters.AddArray(values, elementType));
        return negated
            ? $"{expression} <> ALL({placeholder})"
            : $"{expression} = ANY({placeholder})";
    }

    public string CaseInsensitiveLike(string expression, string parameterPlaceholder) =>
        $"{expression} ILIKE {parameterPlaceholder} ESCAPE '\\'";

    public string CastToDate(string expression) => $"CAST({expression} AS date)";

    /// <summary>
    /// generate_series over timestamps (the ::timestamp casts pin overload
    /// resolution and keep the series timezone-free), one row per day.
    /// Determinism: every name/label column uses non-TM TO_CHAR templates,
    /// which Postgres renders in English regardless of lc_time — so labels
    /// (and the lexicographically-sortable year_month) never vary by server
    /// locale. fiscalYearStartMonth is inlined as a validated integer (the
    /// compiler and validator both enforce 1-12); weekStartsMonday only picks
    /// between two fixed SQL fragments. fiscal_year is labeled by the year the
    /// fiscal year ENDS in (start month 7 puts 2026-07-01 in fiscal_year 2027);
    /// with start month 1 all fiscal_* columns equal their calendar twins.
    /// is_weekend is always Saturday/Sunday, independent of the week start.
    /// </summary>
    public string CalendarTableSql(string startPlaceholder, string endPlaceholder, int fiscalYearStartMonth, bool weekStartsMonday)
    {
        if (fiscalYearStartMonth is < 1 or > 12)
        {
            throw new ArgumentOutOfRangeException(nameof(fiscalYearStartMonth));
        }

        // 1 = Monday ... 7 = Sunday (ISO) or 1 = Sunday ... 7 = Saturday.
        var dayOfWeek = weekStartsMonday
            ? "EXTRACT(ISODOW FROM d)::int"
            : "(EXTRACT(DOW FROM d)::int + 1)";

        // Postgres date_trunc('week', ...) is Monday-anchored; the Sunday
        // variant shifts one day in so Sundays anchor their own week.
        var weekStart = weekStartsMonday
            ? "date_trunc('week', d)::date"
            : "(date_trunc('week', d + interval '1 day')::date - 1)";

        string fiscalYear, fiscalQuarter, fiscalMonth;
        if (fiscalYearStartMonth == 1)
        {
            fiscalYear = "EXTRACT(YEAR FROM d)::int";
            fiscalQuarter = "EXTRACT(QUARTER FROM d)::int";
            fiscalMonth = "EXTRACT(MONTH FROM d)::int";
        }
        else
        {
            var start = fiscalYearStartMonth.ToString(System.Globalization.CultureInfo.InvariantCulture);
            fiscalYear = $"(EXTRACT(YEAR FROM d)::int + CASE WHEN EXTRACT(MONTH FROM d)::int >= {start} THEN 1 ELSE 0 END)";
            fiscalQuarter = $"((((EXTRACT(MONTH FROM d)::int - {start} + 12) % 12) / 3) + 1)";
            fiscalMonth = $"(((EXTRACT(MONTH FROM d)::int - {start} + 12) % 12) + 1)";
        }

        return $"""
                SELECT d::date AS "date_key",
                       EXTRACT(YEAR FROM d)::int AS "year",
                       EXTRACT(QUARTER FROM d)::int AS "quarter",
                       EXTRACT(MONTH FROM d)::int AS "month",
                       TO_CHAR(d, 'Mon') AS "month_name",
                       EXTRACT(WEEK FROM d)::int AS "week",
                       EXTRACT(DAY FROM d)::int AS "day",
                       TO_CHAR(d, 'Dy') AS "day_name",
                       TO_CHAR(d, 'FMMonth') AS "month_name_full",
                       TO_CHAR(d, 'FMDay') AS "day_name_full",
                       {dayOfWeek} AS "day_of_week",
                       EXTRACT(DOY FROM d)::int AS "day_of_year",
                       EXTRACT(ISOYEAR FROM d)::int AS "iso_year",
                       EXTRACT(WEEK FROM d)::int AS "iso_week",
                       (EXTRACT(ISODOW FROM d)::int >= 6) AS "is_weekend",
                       TO_CHAR(d, 'YYYY-MM') AS "year_month",
                       TO_CHAR(d, 'Mon YYYY') AS "month_year_label",
                       TO_CHAR(d, '"Q"Q') AS "quarter_label",
                       TO_CHAR(d, 'YYYY-"Q"Q') AS "year_quarter",
                       date_trunc('month', d)::date AS "month_start",
                       {weekStart} AS "week_start",
                       EXTRACT(DAY FROM (date_trunc('month', d) + interval '1 month - 1 day'))::int AS "days_in_month",
                       {fiscalYear} AS "fiscal_year",
                       {fiscalQuarter} AS "fiscal_quarter",
                       {fiscalMonth} AS "fiscal_month"
                FROM generate_series({startPlaceholder}::timestamp, {endPlaceholder}::timestamp, interval '1 day') AS d
                """;
    }

    /// <summary>date_trunc outputs are timestamps, so the series steps timestamps by whole buckets.</summary>
    public string BucketSeries(DateBucket bucket, string startExpression, string endExpression)
    {
        var interval = bucket switch
        {
            DateBucket.Year => "1 year",
            DateBucket.Quarter => "3 months",
            DateBucket.Month => "1 month",
            DateBucket.Week => "7 days",
            DateBucket.Day => "1 day",
            _ => throw new ArgumentOutOfRangeException(nameof(bucket)),
        };
        return $"generate_series({startExpression}, {endExpression}, interval '{interval}')";
    }

    public string NullsLastSuffix => " NULLS LAST";

    public bool SupportsSelectAliasInOrderBy => true;

    public string LimitClause(string parameterPlaceholder) => $"LIMIT {parameterPlaceholder}";

    public string OffsetClause(string parameterPlaceholder) => $"OFFSET {parameterPlaceholder}";
}
