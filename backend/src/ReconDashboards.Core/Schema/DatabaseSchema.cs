namespace ReconDashboards.Core.Schema;

public enum TableKind
{
    Table,
    View,
    MaterializedView,
    ForeignTable,
}

/// <summary>
/// Engine-wide normalization of database column types. Columns mapped to
/// <see cref="Other"/> are visible in the explorer but can never be used as a
/// dimension, measure, filter, or relationship endpoint.
/// </summary>
public enum NormalizedType
{
    Text,
    Integer,
    Decimal,
    Boolean,
    Date,
    Timestamp,
    Uuid,
    Json,
    Other,
}

public sealed record ColumnSchema(
    string Name,
    int Ordinal,
    string RawType,
    NormalizedType Type,
    bool IsNullable,
    string? Comment);

public sealed record TableSchema(
    string Schema,
    string Name,
    TableKind Kind,
    long? RowEstimate,
    string? Comment,
    IReadOnlyList<ColumnSchema> Columns,
    IReadOnlyList<string> PrimaryKey,
    IReadOnlyList<IReadOnlyList<string>> UniqueConstraints)
{
    /// <summary>Canonical key: "schema.table", case-sensitive as stored in the catalog.</summary>
    public string Key => $"{Schema}.{Name}";

    public ColumnSchema? FindColumn(string name) =>
        Columns.FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.Ordinal));

    /// <summary>True when the column alone is the primary key or a single-column unique constraint.</summary>
    public bool IsColumnUnique(string columnName) =>
        (PrimaryKey.Count == 1 && string.Equals(PrimaryKey[0], columnName, StringComparison.Ordinal))
        || UniqueConstraints.Any(u => u.Count == 1 && string.Equals(u[0], columnName, StringComparison.Ordinal));
}

public sealed record ForeignKeySchema(
    string Name,
    string FromTable,
    IReadOnlyList<string> FromColumns,
    string ToTable,
    IReadOnlyList<string> ToColumns)
{
    /// <summary>Composite FKs are surfaced for the GUI but unsupported as v1 relationships.</summary>
    public bool IsComposite => FromColumns.Count > 1;
}

/// <summary>
/// Snapshot of an introspected database, already filtered by the data source's
/// allowlist. The compiler validates every identifier against this snapshot, so
/// allowlisting is enforced in one place for both browsing and querying.
/// </summary>
public sealed record DatabaseSchema(
    string ConnectionName,
    DateTime FetchedAtUtc,
    string VersionHash,
    IReadOnlyList<TableSchema> Tables,
    IReadOnlyList<ForeignKeySchema> ForeignKeys)
{
    public TableSchema? FindTable(string key) =>
        Tables.FirstOrDefault(t => string.Equals(t.Key, key, StringComparison.Ordinal));
}
