using System.Text.Json;
using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Querying.Spec;

public enum DateBucket
{
    Year,
    Quarter,
    Month,
    Week,
    Day,
}

public enum FilterOperator
{
    Eq,
    Neq,
    In,
    NotIn,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
    Contains,
    StartsWith,
    IsNull,
    NotNull,
}

public enum SortDirection
{
    Asc,
    Desc,
}

public enum SortTargetKind
{
    Dimension,
    Measure,
}

/// <summary>Table refs are canonical "schema.table" keys; columns are catalog names.</summary>
public sealed record DimensionSpec(string Table, string Column, DateBucket? DateBucket);

/// <summary>Either a model measure reference (MeasureId) or an inline aggregation — never both.</summary>
public sealed record MeasureSpec(
    Guid? MeasureId,
    string? Table,
    string? Column,
    Aggregation? Aggregation,
    string? Alias);

/// <summary>
/// Values arrive as raw JSON and are converted server-side to the referenced
/// column's type, then bound as parameters — they never reach SQL text.
/// </summary>
public sealed record FilterSpec(
    string Table,
    string Column,
    FilterOperator Operator,
    IReadOnlyList<JsonElement> Values);

public sealed record SortTarget(SortTargetKind Kind, int Index);

public sealed record SortSpec(SortTarget Target, SortDirection Direction);

public sealed record TopNSpec(int N, int ByMeasureIndex, bool IncludeOthers);

public sealed record ChartQuerySpec(
    int ModelId,
    IReadOnlyList<DimensionSpec> Dimensions,
    IReadOnlyList<MeasureSpec> Measures,
    IReadOnlyList<FilterSpec> Filters,
    IReadOnlyList<SortSpec> Sort,
    TopNSpec? TopN,
    int? Limit);

/// <summary>Feeds slicer dropdowns. Filters may span tables (cascading slicers).</summary>
public sealed record DistinctValuesSpec(
    int ModelId,
    string Table,
    string Column,
    string? Search,
    IReadOnlyList<FilterSpec> Filters,
    int? Limit);
