using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Options;

namespace ReconDashboards.AspNetCore.Controllers;

[RcdPolicySlot(RcdPolicySlot.View)]
public sealed class MetaController(
    ReconDashboardsOptions options,
    Core.Abstractions.ICurrentUserProvider currentUser) : RcdControllerBase
{
    /// <summary>
    /// Library version + effective limits so clients can cap their UX up
    /// front, plus the caller's manage-shared standing — the subscriptions
    /// manager shows its Mine/All admin scope switch from this, instead of
    /// probing scope=all and eating a 403 — and the caller's own user id,
    /// which is the ONLY way the frontend learns who it is (the store
    /// deliberately never receives an identity).
    /// </summary>
    [HttpGet("meta")]
    public MetaResponse Get()
    {
        var version = typeof(MetaController).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? typeof(MetaController).Assembly.GetName().Version?.ToString()
            ?? "unknown";

        // The identity seam THROWS for an unauthenticated caller (that is its
        // documented contract). Everything else on this endpoint is anonymous-
        // safe, so degrade to null instead of turning meta into a 500: an
        // absent id is exactly the pre-0.14.1 wire and clients treat it as
        // "unknown caller".
        string? userId = null;
        try
        {
            userId = currentUser.GetUserId();
        }
        catch (Exception)
        {
            // Unauthenticated — leave userId null.
        }

        var limits = options.Limits;
        return new MetaResponse(
            version,
            limits.MaxRows,
            limits.MaxJoins,
            limits.MaxDimensions,
            limits.MaxMeasures,
            limits.MaxFilters,
            limits.MaxDistinctValues,
            limits.MaxModelDefinitionBytes,
            limits.MaxDashboardLayoutBytes,
            currentUser.CanManageShared,
            userId);
    }
}
