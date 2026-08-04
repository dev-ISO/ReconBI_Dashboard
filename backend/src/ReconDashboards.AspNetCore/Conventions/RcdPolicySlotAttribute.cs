namespace ReconDashboards.AspNetCore.Conventions;

/// <summary>
/// Which host-configured policy slot guards an endpoint. The library never
/// names host roles; hosts map slots to policies via ReconDashboardsOptions.
/// </summary>
public enum RcdPolicySlot
{
    /// <summary>List/read models and dashboards, run queries.</summary>
    View,

    /// <summary>Create/edit own models and dashboards; browse catalogs.</summary>
    Author,

    /// <summary>Share/unshare, edit others' shared resources, view audit.</summary>
    Admin,
}

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class RcdPolicySlotAttribute(RcdPolicySlot slot) : Attribute
{
    public RcdPolicySlot Slot { get; } = slot;
}
