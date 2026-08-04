using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.Core.Options;

/// <summary>
/// One data source registration: name + options + a provider-supplied
/// introspector factory. Provider packages (e.g. ReconDashboards.Postgres) add
/// these via extension methods on <see cref="ReconDashboardsOptions"/> so the
/// ASP.NET layer stays free of provider references.
/// </summary>
public sealed record DataSourceRegistration(
    string Name,
    string ProviderName,
    DataSourceOptions Options,
    Func<IServiceProvider, ISchemaIntrospector> IntrospectorFactory);

public sealed class ReconDashboardsOptions
{
    /// <summary>Routes are mounted at "{RoutePrefix}/v1/...".</summary>
    public string RoutePrefix { get; set; } = "api/rcd";

    /// <summary>
    /// Authorization policy names the host maps onto its own role/capability
    /// system. Null slots add no extra metadata — the host's fallback policy
    /// (typically RequireAuthenticatedUser) still applies.
    /// </summary>
    public string? ViewPolicy { get; set; }

    /// <summary>Create/edit own models and dashboards; browse catalogs.</summary>
    public string? AuthorPolicy { get; set; }

    /// <summary>Share/unshare, edit shared resources owned by others, view audit.</summary>
    public string? AdminPolicy { get; set; }

    public RcdLimits Limits { get; } = new();

    /// <summary>Write one rcd_query_audit row per executed query.</summary>
    public bool EnableQueryAudit { get; set; }

    /// <summary>
    /// In Development only: echo generated SQL in query responses' debug field.
    /// Never honored outside Development.
    /// </summary>
    public bool IncludeSqlInResponse { get; set; }

    /// <summary>
    /// Configures the library-owned storage context (rcd_ tables). The host
    /// decides provider and connection, e.g. o => o.UseNpgsql(conn,
    /// n => n.MigrationsAssembly("ReconDashboards.Postgres")).
    /// </summary>
    public Action<DbContextOptionsBuilder>? ConfigureStorage { get; set; }

    private readonly List<DataSourceRegistration> _dataSources = [];

    public IReadOnlyList<DataSourceRegistration> DataSources => _dataSources;

    /// <summary>Called by provider packages' extension methods; not by hosts directly.</summary>
    public void RegisterDataSource(DataSourceRegistration registration)
    {
        ArgumentNullException.ThrowIfNull(registration);
        if (string.IsNullOrWhiteSpace(registration.Name))
        {
            throw new ArgumentException("Data source name must be non-empty.", nameof(registration));
        }

        if (_dataSources.Any(d => string.Equals(d.Name, registration.Name, StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException($"Data source '{registration.Name}' is already registered.");
        }

        _dataSources.Add(registration);
    }
}
