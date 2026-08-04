using System.Collections.Concurrent;
using ReconDashboards.Core.Options;

namespace ReconDashboards.Core.Abstractions;

public sealed record DataSourceInfo(string Name, string? Description, string Provider);

public sealed record RegisteredDataSource(
    string Name,
    string ProviderName,
    DataSourceOptions Options,
    ISchemaIntrospector Introspector,
    IQueryExecutor? Executor = null,
    ISqlDialect? Dialect = null);

/// <summary>Runtime lookup of registered data sources (introspectors created lazily, once per source).</summary>
public interface IDataSourceRegistry
{
    IReadOnlyList<DataSourceInfo> List();

    bool TryGet(string name, out RegisteredDataSource source);
}

public sealed class DataSourceRegistry(ReconDashboardsOptions options, IServiceProvider services) : IDataSourceRegistry
{
    private readonly ConcurrentDictionary<string, RegisteredDataSource> _resolved = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<DataSourceInfo> List() =>
        options.DataSources
            .Select(d => new DataSourceInfo(d.Name, d.Options.Description, d.ProviderName))
            .ToArray();

    public bool TryGet(string name, out RegisteredDataSource source)
    {
        if (_resolved.TryGetValue(name, out var cached))
        {
            source = cached;
            return true;
        }

        var registration = options.DataSources.FirstOrDefault(
            d => string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase));
        if (registration is null)
        {
            source = null!;
            return false;
        }

        source = _resolved.GetOrAdd(
            registration.Name,
            _ => new RegisteredDataSource(
                registration.Name,
                registration.ProviderName,
                registration.Options,
                registration.IntrospectorFactory(services),
                registration.ExecutorFactory?.Invoke(services),
                registration.Dialect));
        return true;
    }
}
