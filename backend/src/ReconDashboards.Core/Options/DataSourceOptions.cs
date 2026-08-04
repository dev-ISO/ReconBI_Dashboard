namespace ReconDashboards.Core.Options;

/// <summary>
/// Server-side configuration for one queryable database connection. Connection
/// strings come from host configuration and are NEVER exposed to clients —
/// clients only ever see the registered name.
/// </summary>
public sealed class DataSourceOptions
{
    public string ConnectionString { get; set; } = "";

    public string? Description { get; set; }

    /// <summary>Schemas whose tables are visible when <see cref="AllowedTables"/> is empty.</summary>
    public List<string> AllowedSchemas { get; } = ["public"];

    /// <summary>
    /// Explicit allowlist of "schema.table" keys. Empty = all tables in
    /// <see cref="AllowedSchemas"/>.
    /// </summary>
    public List<string> AllowedTables { get; } = [];

    /// <summary>Deny always wins. Accepts "schema.table" keys or bare table names.</summary>
    public List<string> DeniedTables { get; } = [];

    /// <summary>Hard cap on rows returned by any chart query against this source.</summary>
    public int MaxRows { get; set; } = 5000;

    public int StatementTimeoutSeconds { get; set; } = 15;

    /// <summary>
    /// Opens sessions read-only (e.g. default_transaction_read_only=on). Leave on;
    /// a dedicated SELECT-only database role is still the recommended first line.
    /// </summary>
    public bool EnforceReadOnlySession { get; set; } = true;

    /// <summary>How long an introspected schema snapshot is served before re-reading the catalog.</summary>
    public TimeSpan SchemaCacheTtl { get; set; } = TimeSpan.FromMinutes(10);
}
