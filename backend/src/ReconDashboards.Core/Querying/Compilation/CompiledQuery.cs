using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Querying.Compilation;

public enum ResultColumnRole
{
    Dimension,
    Measure,
}

/// <summary>
/// Shape metadata for one output column ("dim0", "meas1", ...). FormatHint is
/// the legacy loose hint ("currency"/"percent"/"$"); FormatString is a model
/// measure's Excel-style pattern and wins in the renderer when both are set.
/// </summary>
public sealed record ResultColumnPlan(
    string Name,
    string Label,
    ResultColumnRole Role,
    NormalizedType Type,
    string? Source,
    DateBucket? DateBucket,
    string? FormatHint,
    string? FormatString = null);

public sealed record EngineWarning(string Code, string Message);

public sealed record CompiledQuery(
    string Sql,
    IReadOnlyList<QueryParameter> Parameters,
    IReadOnlyList<ResultColumnPlan> Columns,
    IReadOnlyList<EngineWarning> Warnings,
    /// <summary>
    /// Requested row cap of the statement. The SQL asks for RowLimit + 1 (the
    /// truncation probe); the query service trims the probe row back off and
    /// reports Truncated. Null when the statement has its own probe accounting
    /// (distinct, underlying).
    /// </summary>
    int? RowLimit = null,
    /// <summary>
    /// True when the final select carries a trailing constant boolean column
    /// ("__rcd_truncated") that is NOT part of <see cref="Columns"/>: an
    /// in-statement truncation probe used where the row-count probe cannot
    /// work (Top-N + window calcs, whose base must hold EXACTLY n rows). The
    /// query service folds it into Truncated and strips the cell off every row.
    /// </summary>
    bool HasTruncationProbe = false);

/// <summary>
/// Compilation failure with a stable code (QRY_DISCONNECTED,
/// QRY_AMBIGUOUS_PATH, QRY_UNKNOWN_TABLE, QRY_UNKNOWN_COLUMN, QRY_BAD_FILTER,
/// QRY_BAD_VALUE, QRY_BAD_BUCKET, QRY_NO_MEASURES, QRY_TOO_MANY_JOINS, ...).
/// Messages are user-facing; they never contain SQL.
///
/// <paramref name="path"/> names the offending part of the WIRE spec in the
/// same JSON-pointer-ish grammar the model editor's
/// <see cref="Modeling.ValidationIssue.Path"/> uses — "measures[0].column",
/// "dimensions[1].dateBucket", "filters[3]", "sort[0]", "limit",
/// "query.table" — so the chart builder can badge the well that owns the
/// mistake instead of showing a bare sentence. Indexes are WIRE indexes (the
/// order the client sent), never model indexes. Null where a fault belongs to
/// the query as a whole.
/// </summary>
public sealed class QueryCompilationException(string code, string message, string? path = null)
    : Exception(message)
{
    public string Code { get; } = code;

    public string? Path { get; } = path;
}

/// <summary>Raised when a row-filter contributor denies access or fails (fail closed).</summary>
public sealed class RowFilterDeniedException(string table)
    : Exception($"Access to '{table}' was denied by the host's row-level scoping.")
{
    public string Table { get; } = table;
}
