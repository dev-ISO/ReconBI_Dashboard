namespace ReconDashboards.Core.Options;

/// <summary>Engine-wide caps. Host-overridable; the engine clamps rather than trusts.</summary>
public sealed class RcdLimits
{
    public int MaxRows { get; set; } = 10_000;
    public int MaxJoins { get; set; } = 8;
    public int MaxDimensions { get; set; } = 8;
    public int MaxMeasures { get; set; } = 16;
    public int MaxFilters { get; set; } = 32;
    public int MaxInValues { get; set; } = 1_000;
    public int MaxDistinctValues { get; set; } = 1_000;

    /// <summary>Maximum size of a persisted semantic-model definition, bytes.</summary>
    public int MaxModelDefinitionBytes { get; set; } = 256 * 1024;

    /// <summary>Maximum size of a persisted dashboard layout, bytes.</summary>
    public int MaxDashboardLayoutBytes { get; set; } = 512 * 1024;

    public int MaxDashboardsPerUser { get; set; } = 100;
    public int MaxModelsPerUser { get; set; } = 100;

    public int QueriesPerMinutePerUser { get; set; } = 60;
}
