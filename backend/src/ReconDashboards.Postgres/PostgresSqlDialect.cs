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

    public string NullsLastSuffix => " NULLS LAST";

    public bool SupportsSelectAliasInOrderBy => true;

    public string LimitClause(string parameterPlaceholder) => $"LIMIT {parameterPlaceholder}";
}
