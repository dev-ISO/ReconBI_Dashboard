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
    /// probing scope=all and eating a 403.
    /// </summary>
    [HttpGet("meta")]
    public MetaResponse Get()
    {
        var version = typeof(MetaController).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? typeof(MetaController).Assembly.GetName().Version?.ToString()
            ?? "unknown";

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
            currentUser.CanManageShared);
    }
}
