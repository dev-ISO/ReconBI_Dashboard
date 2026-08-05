using System.Security.Claims;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// Fixed-identity <see cref="ICurrentUserProvider"/> for background evaluation:
/// the stored owner id, never elevated (CanManageShared is false).
/// </summary>
public sealed class FixedCurrentUserProvider(string userId) : ICurrentUserProvider
{
    public string GetUserId() => userId;

    public bool CanManageShared => false;
}

/// <summary>
/// Builds the query pipeline impersonating a stored owner id. The host's
/// scoped ICurrentUserProvider (usually HTTP-context-bound) is NOT used;
/// instead a fixed provider carries the owner id through the exact same
/// fail-closed CollectRowFiltersAsync path every interactive query uses:
/// contributors receive RowFilterContext.UserId = the owner id and a synthetic
/// principal holding only that NameIdentifier claim. A contributor that needs
/// richer claims will deny or throw, which aborts the query — fail closed, by
/// the engine's existing contract.
/// </summary>
public static class ImpersonatedQuery
{
    /// <summary>Authentication type on the synthetic principal, for host contributors that care.</summary>
    public const string AuthenticationType = "RcdScheduler";

    public static ClaimsPrincipal PrincipalFor(string ownerUserId) =>
        new(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, ownerUserId)], AuthenticationType));

    /// <summary>
    /// A ChartQueryService wired from <paramref name="scopeServices"/> with the
    /// impersonated identity. Model visibility, row filters, and query audit
    /// all evaluate as <paramref name="ownerUserId"/>.
    /// </summary>
    public static ChartQueryService Create(IServiceProvider scopeServices, string ownerUserId)
    {
        var user = new FixedCurrentUserProvider(ownerUserId);
        var db = scopeServices.GetRequiredService<ReconDashboardsDbContext>();
        var options = scopeServices.GetRequiredService<ReconDashboardsOptions>();
        var registry = scopeServices.GetRequiredService<IDataSourceRegistry>();
        var schemaCache = scopeServices.GetRequiredService<ISchemaCache>();
        var validator = scopeServices.GetRequiredService<SemanticModelValidator>();
        var contributors = scopeServices.GetServices<IRowFilterContributor>();
        var clock = scopeServices.GetRequiredService<TimeProvider>();
        var logger = scopeServices.GetRequiredService<ILogger<ChartQueryService>>();

        var models = new DataModelService(db, user, registry, schemaCache, validator, options, clock);
        return new ChartQueryService(
            models, registry, schemaCache, validator, contributors, user, options, db, clock, logger);
    }
}
