using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// Provider-implemented catalog reader. Returns the RAW schema; allowlist
/// filtering and version hashing are applied by the schema cache.
/// </summary>
public interface ISchemaIntrospector
{
    Task<DatabaseSchema> IntrospectAsync(CancellationToken cancellationToken);
}
