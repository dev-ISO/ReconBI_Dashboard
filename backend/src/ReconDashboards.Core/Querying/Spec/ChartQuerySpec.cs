using System.Text.Json;
using System.Text.Json.Serialization;
using ReconDashboards.Core.Json;
using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Querying.Spec;

[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<DateBucket>))]
public enum DateBucket
{
    Year,
    Quarter,
    Month,
    Week,
    Day,
}

[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<FilterOperator>))]
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

[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<SortDirection>))]
public enum SortDirection
{
    Asc,
    Desc,
}

[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<SortTargetKind>))]
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
