using System.Collections.Concurrent;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Caching;

/// <summary>
/// Per-source snapshot cache with single-flight loading: concurrent cold reads
/// introspect once. Stored snapshots are already allowlist-filtered and hashed;
/// this is the only component that touches raw introspection output.
/// </summary>
public sealed class MemorySchemaCache(IDataSourceRegistry registry) : ISchemaCache
{
    private sealed record Entry(Lazy<Task<DatabaseSchema>> Snapshot, DateTime LoadedAtUtc, TimeSpan Ttl)
    {
        public bool IsFresh => Ttl == Timeout.InfiniteTimeSpan || DateTime.UtcNow - LoadedAtUtc < Ttl;
    }

    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.OrdinalIgnoreCase);

    public async Task<DatabaseSchema> GetAsync(string connectionName, CancellationToken cancellationToken)
    {
        while (true)
        {
            var entry = _entries.GetOrAdd(connectionName, CreateEntry);
            if (entry.IsFresh)
            {
                try
                {
                    return await entry.Snapshot.Value.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch
                {
                    // A failed load must not be cached as a poisoned entry.
                    _entries.TryRemove(new KeyValuePair<string, Entry>(connectionName, entry));
                    throw;
                }
            }

            _entries.TryRemove(new KeyValuePair<string, Entry>(connectionName, entry));
        }
    }

    public async Task<DatabaseSchema> RefreshAsync(string connectionName, CancellationToken cancellationToken)
    {
        Invalidate(connectionName);
        return await GetAsync(connectionName, cancellationToken).ConfigureAwait(false);
    }

    public void Invalidate(string connectionName) => _entries.TryRemove(connectionName, out _);

    private Entry CreateEntry(string connectionName)
    {
        if (!registry.TryGet(connectionName, out var source))
        {
            throw new UnknownDataSourceException(connectionName);
        }

        return new Entry(
            new Lazy<Task<DatabaseSchema>>(
                () => LoadAsync(source),
                LazyThreadSafetyMode.ExecutionAndPublication),
            DateTime.UtcNow,
            source.Options.SchemaCacheTtl);
    }

    private static async Task<DatabaseSchema> LoadAsync(RegisteredDataSource source)
    {
        var raw = await source.Introspector.IntrospectAsync(CancellationToken.None).ConfigureAwait(false);
        var filtered = SchemaFilter.Apply(raw, source.Options);
        var hash = SchemaHasher.ComputeVersionHash(filtered.Tables, filtered.ForeignKeys);
        return filtered with { VersionHash = hash, FetchedAtUtc = DateTime.UtcNow };
    }
}

public sealed class UnknownDataSourceException(string connectionName)
    : InvalidOperationException($"No data source named '{connectionName}' is registered.")
{
    public string ConnectionName { get; } = connectionName;
}
