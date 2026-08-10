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

/// <summary>
/// Time-intelligence transform applied AFTER aggregation via SQL window
/// functions over the grouped result. RunningTotal works on any ordered axis;
/// the other kinds require the FIRST dimension to be date-bucketed.
/// Wire names: "runningTotal", "ytd", "priorPeriod", "periodChange",
/// "periodChangePct".
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<MeasureCalcKind>))]
public enum MeasureCalcKind
{
    RunningTotal,
    Ytd,
    PriorPeriod,
    PeriodChange,
    PeriodChangePct,
}

/// <summary>Offset = buckets back for the prior/change kinds (default 1; e.g. 12 = YoY on a month axis).</summary>
public sealed record MeasureCalcSpec(MeasureCalcKind Kind, int? Offset = null);

/// <summary>Either a model measure reference (MeasureId) or an inline aggregation — never both.</summary>
public sealed record MeasureSpec(
    Guid? MeasureId,
    string? Table,
    string? Column,
    Aggregation? Aggregation,
    string? Alias,
    MeasureCalcSpec? Calc = null);

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

/// <summary>
/// Wire names: "gt", "gte", "lt", "lte", "eq", "neq", "between", "in",
/// "notIn".
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<HavingOperator>))]
public enum HavingOperator
{
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
    Neq,
    Between,
    In,
    NotIn,
}

/// <summary>
/// Post-aggregation condition (SQL HAVING) on the measure at
/// <see cref="MeasureIndex"/> (into <see cref="ChartQuerySpec.Measures"/>).
/// Conditions are ANDed. Between takes exactly two values (inclusive bounds);
/// In/NotIn take one to <see cref="Options.RcdLimits.MaxInValues"/> values
/// (QRY_BAD_HAVING on an empty list, QRY_TOO_MANY_VALUES past the cap);
/// every other operator takes exactly one. In keeps exactly the groups whose
/// aggregate equals a listed value (a NULL aggregate never matches); NotIn is
/// its exact complement and therefore KEEPS groups with a NULL aggregate —
/// the pair backs Excel-style value checklists where "(Blanks)" rides the
/// negated form. The condition targets the RAW aggregated value of the
/// measure — for a measure with a window <see cref="MeasureCalcSpec"/> the
/// HAVING applies to the pre-calc base aggregate (window functions cannot
/// appear in HAVING); for a calculated (expression) measure the whole
/// expression is repeated in the HAVING clause.
/// </summary>
public sealed record HavingSpec(int MeasureIndex, HavingOperator Operator, IReadOnlyList<double> Values);

/// <summary>
/// Offset (wire "offset") skips rows of the FINAL select — after ORDER BY,
/// before LIMIT — for server-side table pagination. Negative values clamp to 0;
/// values above 1,000,000 are rejected (QRY_BAD_OFFSET). Offset without an
/// explicit sort is allowed: the engine's default deterministic ordering still
/// applies when dimensions exist, and any residual nondeterminism (e.g. a
/// no-dimension query) is on the caller.
/// Having (wire "having") filters grouped rows post-aggregation; with zero
/// dimensions it applies to the single global aggregate row (alert-style
/// specs). Only the aggregate pipeline honors it — row-level ("underlying")
/// exports ignore it.
/// </summary>
public sealed record ChartQuerySpec(
    int ModelId,
    IReadOnlyList<DimensionSpec> Dimensions,
    IReadOnlyList<MeasureSpec> Measures,
    IReadOnlyList<FilterSpec> Filters,
    IReadOnlyList<SortSpec> Sort,
    TopNSpec? TopN,
    int? Limit,
    int? Offset = null,
    IReadOnlyList<HavingSpec>? Having = null);

/// <summary>
/// CSV export mode: "summarized" runs the normal aggregate pipeline (including
/// calcs); "underlying" exports row-level data from the first measure's table.
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<ExportMode>))]
public enum ExportMode
{
    Summarized,
    Underlying,
}

/// <summary>Feeds slicer dropdowns. Filters may span tables (cascading slicers).</summary>
public sealed record DistinctValuesSpec(
    int ModelId,
    string Table,
    string Column,
    string? Search,
    IReadOnlyList<FilterSpec> Filters,
    int? Limit);
