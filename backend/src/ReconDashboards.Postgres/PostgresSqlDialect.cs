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
    /// </summary>
    public string CalendarTableSql(string startPlaceholder, string endPlaceholder) =>
        $"""
         SELECT d::date AS "date_key", EXTRACT(YEAR FROM d)::int AS "year", EXTRACT(QUARTER FROM d)::int AS "quarter", EXTRACT(MONTH FROM d)::int AS "month", TO_CHAR(d, 'Mon') AS "month_name", EXTRACT(WEEK FROM d)::int AS "week", EXTRACT(DAY FROM d)::int AS "day", TO_CHAR(d, 'Dy') AS "day_name"
         FROM generate_series({startPlaceholder}::timestamp, {endPlaceholder}::timestamp, interval '1 day') AS d
         """;

    public string NullsLastSuffix => " NULLS LAST";

    public bool SupportsSelectAliasInOrderBy => true;

    public string LimitClause(string parameterPlaceholder) => $"LIMIT {parameterPlaceholder}";
}
