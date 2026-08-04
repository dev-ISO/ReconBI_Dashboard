using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Core.Modeling;

public enum Aggregation
{
    Sum,
    Avg,
    Min,
    Max,
    Count,
    CountDistinct,
}

public enum Cardinality
{
    ManyToOne,
    OneToOne,
}

public enum RelationshipSource
{
    Fk,
    Manual,
}

/// <summary>GUI canvas position — a first-class part of the persisted model.</summary>
public sealed record CanvasPosition(double X, double Y);

/// <summary>
/// Column OVERRIDE. Existence and types are always re-resolved against the
/// introspected catalog; entries exist only where the user customized something.
/// </summary>
public sealed record ModelColumn(
    string Name,
    string? FriendlyName = null,
    Aggregation? DefaultAggregation = null,
    string? FormatHint = null,
    bool Hidden = false);

public sealed record ModelTable(
    string Schema,
    string Name,
    string? FriendlyName = null,
    bool Hidden = false,
    CanvasPosition? Position = null,
    IReadOnlyList<ModelColumn>? Columns = null)
{
    public string Key => $"{Schema}.{Name}";

    public IReadOnlyList<ModelColumn> ColumnOverrides => Columns ?? [];
}

/// <summary>
/// Single-column relationship. "From" is always the many side (either side for
/// one-to-one). Composite keys are a v2 schema change.
/// </summary>
public sealed record Relationship(
    Guid Id,
    string FromTable,
    string FromColumn,
    string ToTable,
    string ToColumn,
    Cardinality Cardinality,
    bool IsActive = true,
    RelationshipSource Source = RelationshipSource.Manual);

/// <summary>Column is null only for Count (COUNT(*)).</summary>
public sealed record Measure(
    Guid Id,
    string Name,
    string Table,
    Aggregation Aggregation,
    string? Column = null,
    string? FormatHint = null,
    IReadOnlyList<FilterSpec>? Filters = null)
{
    public IReadOnlyList<FilterSpec> MeasureFilters => Filters ?? [];
}

/// <summary>
/// The versioned JSON document users build in the GUI (persisted as
/// rcd_data_models.DefinitionJson). Name and data source name live on the
/// database row — this document holds only the model structure.
/// </summary>
public sealed record ModelDefinition(
    int Version,
    IReadOnlyList<ModelTable> Tables,
    IReadOnlyList<Relationship> Relationships,
    IReadOnlyList<Measure> Measures)
{
    public const int CurrentVersion = 1;

    public ModelTable? FindTable(string key) =>
        Tables.FirstOrDefault(t => string.Equals(t.Key, key, StringComparison.Ordinal));
}

/// <summary>A materialized model: database row identity plus its parsed definition.</summary>
public sealed record SemanticModel(
    int Id,
    string Name,
    string? Description,
    string DataSourceName,
    string OwnerUserId,
    bool IsShared,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    ModelDefinition Definition);
