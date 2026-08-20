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

    /// <summary>
    /// Maximum number of caller-supplied measure DEFINITIONS one query may
    /// carry (ChartQuerySpec.Definitions — dashboard/personal-scoped measures
    /// that are not in the stored model). Separate from
    /// <see cref="MaxMeasures"/>, which caps the measures a query SELECTS: a
    /// single selected measure can pull in a whole chain of definitions
    /// through its expression [references].
    /// </summary>
    public int MaxQueryMeasureDefinitions { get; set; } = 64;

    /// <summary>Maximum total size of a query's measure definitions, bytes.</summary>
    public int MaxQueryMeasureDefinitionBytes { get; set; } = 128 * 1024;

    /// <summary>Maximum size of one user's private settings document, bytes.</summary>
    public int MaxUserSettingsBytes { get; set; } = 128 * 1024;

    public int MaxDashboardsPerUser { get; set; } = 100;
    public int MaxModelsPerUser { get; set; } = 100;

    public int QueriesPerMinutePerUser { get; set; } = 60;
}
