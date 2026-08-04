using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// Caches allowlist-filtered schema snapshots per data source with single-flight
/// loading. All catalog reads (browsing AND query compilation) go through this.
/// </summary>
public interface ISchemaCache
{
    Task<DatabaseSchema> GetAsync(string connectionName, CancellationToken cancellationToken);

    /// <summary>Invalidates and reloads, returning the fresh snapshot.</summary>
    Task<DatabaseSchema> RefreshAsync(string connectionName, CancellationToken cancellationToken);

    void Invalidate(string connectionName);
}
