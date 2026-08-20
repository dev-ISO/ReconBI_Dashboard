using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// The portability seam. The compiler builds statements from ANSI scaffolding
/// (SELECT/FROM/LEFT JOIN/WHERE/GROUP BY/ORDER BY) and delegates every
/// engine-divergent fragment here. Core contains no provider references; a new
/// database engine is a new implementation of this plus an introspector and an
/// executor.
/// </summary>
public interface ISqlDialect
{
    /// <summary>"@p0" for the given bag name.</summary>
    string ParameterPlaceholder(string name);

    string QuoteIdentifier(string identifier);

    string DateTrunc(DateBucket bucket, string expression);

    /// <summary>
    /// SUM(x) / COUNT(*) / COUNT(DISTINCT x) / AVG / MIN / MAX / sample
    /// stddev / sample variance / median. Null argument only for Count. The
    /// whole aggregate shape is owned here — Median may render as an
    /// ordered-set aggregate (e.g. PERCENTILE_CONT(0.5) WITHIN GROUP (...)).
    /// </summary>
    string Aggregate(Aggregation aggregation, string? argumentExpression);

    /// <summary>Per-measure filtered aggregation, e.g. "agg FILTER (WHERE pred)".</summary>
    string AggregateFilter(string aggregateExpression, string predicate);

    /// <summary>Set membership; the dialect owns parameter binding (array vs expanded list).</summary>
    string InPredicate(
        string expression,
        bool negated,
        IReadOnlyList<object?> values,
        NormalizedType elementType,
        ParameterBag parameters);

    /// <summary>Case-insensitive LIKE with backslash escaping (pattern is pre-escaped by the compiler).</summary>
    string CaseInsensitiveLike(string expression, string parameterPlaceholder);

    /// <summary>CAST(expr AS date) or equivalent; joins timestamp columns onto virtual date tables.</summary>
    string CastToDate(string expression);

    /// <summary>
    /// CAST(expr AS text) or equivalent. Used where a derived field or a value
    /// grouping must compare or return a column of ANY type as a label — the
    /// owner's case is a column holding either a keyword or a date, whose
    /// "is it blank" test and "everything else" arm must both be well-typed
    /// against text branches. The default suits Postgres/ANSI engines.
    /// </summary>
    string CastToText(string expression) => $"CAST({expression} AS text)";

    /// <summary>
    /// The SELECT body of a virtual calendar CTE — one row per day from start
    /// to end inclusive, emitting exactly the columns of
    /// <see cref="Modeling.DateTableSchema.Build"/> in order. Both range
    /// placeholders are bound as date parameters by the compiler.
    /// <paramref name="fiscalYearStartMonth"/> is a compiler-validated integer
    /// in [1, 12] and <paramref name="weekStartsMonday"/> a plain flag; they
    /// may be inlined only as constants / fixed SQL fragments — never as
    /// client text. Name/label columns must be deterministic regardless of
    /// server locale (e.g. Postgres non-TM TO_CHAR templates are always
    /// English), and year_month must sort lexicographically = chronologically.
    /// </summary>
    string CalendarTableSql(string startPlaceholder, string endPlaceholder, int fiscalYearStartMonth, bool weekStartsMonday);

    /// <summary>
    /// A set-returning expression producing every bucket start from
    /// <paramref name="startExpression"/> to <paramref name="endExpression"/>
    /// inclusive, stepping by one <paramref name="bucket"/> (e.g. Postgres
    /// "generate_series(start, end, interval '1 month')"). Both bound
    /// expressions are date_trunc outputs, never client input. Used to densify
    /// date axes for window calcs so LAG-by-rows equals LAG-by-bucket.
    /// </summary>
    string BucketSeries(DateBucket bucket, string startExpression, string endExpression);

    /// <summary>" NULLS LAST" or an equivalent wrapping for engines without it.</summary>
    string NullsLastSuffix { get; }

    bool SupportsSelectAliasInOrderBy { get; }

    /// <summary>"LIMIT @p" / "FETCH FIRST @p ROWS ONLY" etc.</summary>
    string LimitClause(string parameterPlaceholder);

    /// <summary>
    /// "OFFSET @p" or the engine's equivalent. Emitted (after the limit clause)
    /// only when the spec carries a positive offset; the value is always bound
    /// as a parameter. Default suits Postgres/ANSI engines.
    /// </summary>
    string OffsetClause(string parameterPlaceholder) => $"OFFSET {parameterPlaceholder}";
}
