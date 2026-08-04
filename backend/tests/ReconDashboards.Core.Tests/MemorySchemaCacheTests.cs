using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

public class MemorySchemaCacheTests
{
    private sealed class FakeDataSourceRegistry : IDataSourceRegistry
    {
        private readonly Dictionary<string, RegisteredDataSource> _sources = new(StringComparer.OrdinalIgnoreCase);

        public void Add(RegisteredDataSource source) => _sources[source.Name] = source;

        public IReadOnlyList<DataSourceInfo> List() =>
            _sources.Values.Select(s => new DataSourceInfo(s.Name, s.Options.Description, s.ProviderName)).ToArray();

        public bool TryGet(string name, out RegisteredDataSource source) =>
            _sources.TryGetValue(name, out source!);
    }

    private sealed class CountingSchemaIntrospector(DatabaseSchema schema) : ISchemaIntrospector
    {
        private int _callCount;

        public int CallCount => Volatile.Read(ref _callCount);

        public int FailuresBeforeSuccess { get; set; }

        public async Task<DatabaseSchema> IntrospectAsync(CancellationToken cancellationToken)
        {
            var call = Interlocked.Increment(ref _callCount);
            await Task.Delay(50, cancellationToken);
            if (call <= FailuresBeforeSuccess)
            {
                throw new IOException("Simulated introspection failure.");
            }

            return schema;
        }
    }

    private static (MemorySchemaCache Cache, CountingSchemaIntrospector Introspector) CreateCache(
        TimeSpan? timeToLive = null,
        int failuresBeforeSuccess = 0)
    {
        var introspector = new CountingSchemaIntrospector(TestFixtures.BuildRawDemoSchemaWithSecretsTable())
        {
            FailuresBeforeSuccess = failuresBeforeSuccess,
        };

        var options = new DataSourceOptions();
        if (timeToLive is { } ttl)
        {
            options.SchemaCacheTtl = ttl;
        }

        var registry = new FakeDataSourceRegistry();
        registry.Add(new RegisteredDataSource(TestFixtures.DemoConnectionName, "test", options, introspector));
        return (new MemorySchemaCache(registry), introspector);
    }

    [Fact]
    public async Task TenConcurrentColdReadsIntrospectExactlyOnce()
    {
        var (cache, introspector) = CreateCache();

        var tasks = Enumerable.Range(0, 10)
            .Select(_ => cache.GetAsync(TestFixtures.DemoConnectionName, CancellationToken.None))
            .ToArray();
        var snapshots = await Task.WhenAll(tasks);

        Assert.Equal(1, introspector.CallCount);
        Assert.All(snapshots, s => Assert.Same(snapshots[0], s));
    }

    [Fact]
    public async Task ExpiredTimeToLiveTriggersReloadOnNextRead()
    {
        var (cache, introspector) = CreateCache(timeToLive: TimeSpan.FromMilliseconds(50));

        await cache.GetAsync(TestFixtures.DemoConnectionName, CancellationToken.None);
        Assert.Equal(1, introspector.CallCount);

        await Task.Delay(150);
        await cache.GetAsync(TestFixtures.DemoConnectionName, CancellationToken.None);

        Assert.Equal(2, introspector.CallCount);
    }

    [Fact]
    public async Task RefreshForcesReloadEvenWhenSnapshotIsFresh()
    {
        var (cache, introspector) = CreateCache();

        await cache.GetAsync(TestFixtures.DemoConnectionName, CancellationToken.None);
        Assert.Equal(1, introspector.CallCount);

        var refreshed = await cache.RefreshAsync(TestFixtures.DemoConnectionName, CancellationToken.None);

        Assert.Equal(2, introspector.CallCount);
        Assert.NotNull(refreshed);
    }

    [Fact]
    public async Task UnknownDataSourceNameThrowsUnknownDataSourceException()
    {
        var (cache, _) = CreateCache();

        var exception = await Assert.ThrowsAsync<UnknownDataSourceException>(
            () => cache.GetAsync("no-such-source", CancellationToken.None));

        Assert.Equal("no-such-source", exception.ConnectionName);
    }

    [Fact]
    public async Task IntrospectorFailurePropagatesAndIsNotCached()
    {
        var (cache, introspector) = CreateCache(failuresBeforeSuccess: 1);

        await Assert.ThrowsAsync<IOException>(
            () => cache.GetAsync(TestFixtures.DemoConnectionName, CancellationToken.None));
        Assert.Equal(1, introspector.CallCount);

        var snapshot = await cache.GetAsync(TestFixtures.DemoConnectionName, CancellationToken.None);

        Assert.Equal(2, introspector.CallCount);
        Assert.NotNull(snapshot);
    }

    [Fact]
    public async Task ReturnedSnapshotIsAllowlistFilteredAndCarriesVersionHash()
    {
        var (cache, _) = CreateCache();

        var snapshot = await cache.GetAsync(TestFixtures.DemoConnectionName, CancellationToken.None);

        Assert.Null(snapshot.FindTable("audit.secrets"));
        Assert.NotNull(snapshot.FindTable("public.customers"));
        Assert.NotNull(snapshot.FindTable("public.orders"));
        Assert.False(string.IsNullOrEmpty(snapshot.VersionHash));
        var expectedHash = SchemaHasher.ComputeVersionHash(snapshot.Tables, snapshot.ForeignKeys);
        Assert.Equal(expectedHash, snapshot.VersionHash);
    }
}
