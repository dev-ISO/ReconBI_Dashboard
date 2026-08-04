using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Querying.Compilation;

public enum ResultColumnRole
{
    Dimension,
    Measure,
}

/// <summary>Shape metadata for one output column ("dim0", "meas1", ...).</summary>
public sealed record ResultColumnPlan(
    string Name,
    string Label,
    ResultColumnRole Role,
    NormalizedType Type,
    string? Source,
    DateBucket? DateBucket,
    string? FormatHint);

public sealed record EngineWarning(string Code, string Message);

public sealed record CompiledQuery(
    string Sql,
    IReadOnlyList<QueryParameter> Parameters,
    IReadOnlyList<ResultColumnPlan> Columns,
    IReadOnlyList<EngineWarning> Warnings);

/// <summary>
/// Compilation failure with a stable code (QRY_DISCONNECTED,
/// QRY_AMBIGUOUS_PATH, QRY_UNKNOWN_TABLE, QRY_UNKNOWN_COLUMN, QRY_BAD_FILTER,
/// QRY_BAD_VALUE, QRY_BAD_BUCKET, QRY_NO_MEASURES, QRY_TOO_MANY_JOINS, ...).
/// Messages are user-facing; they never contain SQL.
/// </summary>
public sealed class QueryCompilationException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>Raised when a row-filter contributor denies access or fails (fail closed).</summary>
public sealed class RowFilterDeniedException(string table)
    : Exception($"Access to '{table}' was denied by the host's row-level scoping.")
{
    public string Table { get; } = table;
}
