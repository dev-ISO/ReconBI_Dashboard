using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Core.Abstractions;

public sealed record ExecutionOptions(int MaxRows, int TimeoutSeconds);

public sealed record ExecutedQuery(IReadOnlyList<object?[]> Rows, bool Truncated, int ElapsedMs);

/// <summary>
/// Provider-implemented statement runner. Sessions are read-only with a
/// statement timeout; the executor reads MaxRows + 1 rows to detect truncation
/// and never returns more than MaxRows.
/// </summary>
public interface IQueryExecutor
{
    Task<ExecutedQuery> ExecuteAsync(CompiledQuery query, ExecutionOptions options, CancellationToken cancellationToken);
}
