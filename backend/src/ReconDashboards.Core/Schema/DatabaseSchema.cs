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

/// <summary>
/// A catalog column, or — when <see cref="DerivedExpression"/> is set — a
/// VIRTUAL one the compiler injected from a model
/// <see cref="Modeling.DerivedField"/>. A derived column has no physical
/// counterpart, so it must NEVER be quoted as an identifier: every emission
/// site resolves it to its expression SQL instead (QueryCompiler.ColumnExpression).
/// The two derived members are compile-scoped — schema SNAPSHOTS never carry
/// them, so the schema hash, the introspector and the schema-browser DTOs are
/// untouched.
/// </summary>
public sealed record ColumnSchema(
    string Name,
    int Ordinal,
    string RawType,
    NormalizedType Type,
    bool IsNullable,
    string? Comment,
    string? DerivedExpression = null,
    string? DerivedId = null)
{
    /// <summary>True for an injected virtual column; false for every catalog column.</summary>
    public bool IsDerived => DerivedExpression is not null;
}

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

    /// <summary>
    /// PHYSICAL columns win. Injected derived columns are appended after them
    /// and their names are rejected at injection time when they collide, but
    /// this ordering is the second lock: a derived field must never be able to
    /// SHADOW a real column, because a row-level security filter that names
    /// that column resolves through here and would silently start filtering an
    /// expression instead of the column the host meant.
    /// </summary>
    public ColumnSchema? FindColumn(string name) =>
        Columns.FirstOrDefault(c => !c.IsDerived && string.Equals(c.Name, name, StringComparison.Ordinal))
        ?? Columns.FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.Ordinal));

    /// <summary>
    /// A derived column by its field id — the stable alternative to its name,
    /// so a dimension keeps resolving after the field is renamed.
    /// </summary>
    public ColumnSchema? FindDerivedColumnById(string id) =>
        Columns.FirstOrDefault(c => c.IsDerived && string.Equals(c.DerivedId, id, StringComparison.Ordinal));

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
