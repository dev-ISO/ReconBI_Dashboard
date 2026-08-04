using System.Security.Claims;

namespace ReconDashboards.Core.Abstractions;

public enum RowFilterOperator
{
    Equals,
    In,
    IsNull,
}

/// <summary>A mandatory predicate expressed in spec vocabulary — never SQL. Values are always parameterized.</summary>
public sealed record RowFilter(string ColumnName, RowFilterOperator Operator, IReadOnlyList<object?> Values);

public sealed record RowFilterContext(
    string DataSourceName,
    string Schema,
    string Table,
    ClaimsPrincipal User,
    string UserId);

public sealed record RowFilterDecision(bool Deny, IReadOnlyList<RowFilter> Filters)
{
    public static readonly RowFilterDecision Allow = new(false, []);
    public static RowFilterDecision DenyAccess() => new(true, []);
    public static RowFilterDecision Filter(params RowFilter[] filters) => new(false, filters);
}

/// <summary>
/// Host hook for row-level scoping (e.g. PSV's SystemScope). Consulted for
/// EVERY physical table referenced by a compiled query, including join targets.
/// FAIL CLOSED: a thrown exception or a Deny decision aborts the query — there
/// is no code path that executes unfiltered when a contributor is registered.
/// </summary>
public interface IRowFilterContributor
{
    Task<RowFilterDecision> GetFiltersAsync(RowFilterContext context, CancellationToken cancellationToken);
}
