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

    /// NULL or the empty string — the exact complement pair for a value grouping's
    /// blank bucket, which groups both. Without these, clicking that bar drills
    /// with IsNull and silently under-matches by the empty-string rows: the bar
    /// says 3, the drill shows 2. FilterClause has no disjunction, so this has to
    /// be one operator rather than an OR of two.
    IsBlank,
    NotBlank,
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

/// <summary>
/// One bucket of a chart-local VALUE GROUPING. Rows whose column value is in
/// <see cref="Values"/> — or, when <see cref="MatchBlank"/> is set, whose value
/// is NULL or empty — are labelled <see cref="Label"/>. Buckets are tested in
/// order, first match wins. Every label AND every match value is BOUND as a
/// parameter; none of them reaches SQL as text.
/// </summary>
public sealed record GroupingBucket(
    string Label,
    IReadOnlyList<JsonElement>? Values = null,
    bool MatchBlank = false,
    IReadOnlyList<GroupingMatchRule>? Rules = null,
    GroupingRuleMode RuleMode = GroupingRuleMode.Any)
{
    public IReadOnlyList<JsonElement> MatchValues => Values ?? [];

    public IReadOnlyList<GroupingMatchRule> MatchRules => Rules ?? [];
}

/// <summary>
/// How a bucket's <see cref="GroupingBucket.Rules"/> combine with each other.
/// Any (default) is Excel's "or" — a row joins the bucket if ANY rule matches.
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<GroupingRuleMode>))]
public enum GroupingRuleMode
{
    Any,
    All,
}

/// <summary>
/// The Excel-autofilter vocabulary a grouping bucket can match by. Text
/// operators are CASE-INSENSITIVE, matching what the same words mean in a
/// spreadsheet; the ordered ones convert their operand against the column's own
/// type, so a date column compares as a date rather than as text.
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<GroupingMatchOperator>))]
public enum GroupingMatchOperator
{
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Equals,
    NotEquals,
    IsBlank,
    NotBlank,
    GreaterThan,
    GreaterOrEqual,
    LessThan,
    LessOrEqual,
}

/// <summary>
/// One Excel-style match rule. THE POINT OF RULES: a bucket built from listed
/// values only ever contains the values that existed when the author picked
/// them, so every new value that arrives has to be added by hand. A rule is
/// evaluated in SQL against the live data, so a value that appears tomorrow
/// joins its group with no edit.
///
/// <para><see cref="Value"/> is required by every operator except IsBlank and
/// NotBlank, and is BOUND as a parameter like every other grouping operand.</para>
/// </summary>
public sealed record GroupingMatchRule(
    GroupingMatchOperator Operator,
    JsonElement? Value = null);

/// <summary>
/// A chart-local mapping from raw column values to category labels — the
/// no-formula path onto the same CASE seam a derived field uses. It is
/// deliberately NOT a field: it creates nothing in the field list, because it
/// belongs to one chart.
///
/// <para><see cref="OtherLabel"/> names the "everything else" bucket. When it
/// is null every unmatched value keeps its own text.</para>
/// </summary>
public sealed record GroupingRule(
    IReadOnlyList<GroupingBucket> Groups,
    string? OtherLabel = null);

/// <summary>
/// Table refs are canonical "schema.table" keys; columns are catalog names —
/// or the name (or id) of a <see cref="Modeling.DerivedField"/> on that table,
/// which resolves to a VIRTUAL column and is otherwise an ordinary dimension.
/// <see cref="Grouping"/> folds the column's values into named buckets.
/// </summary>
public sealed record DimensionSpec(
    string Table,
    string Column,
    DateBucket? DateBucket,
    GroupingRule? Grouping = null);

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
/// Definitions (wire "definitions") carries measure DEFINITIONS that are not
/// in the stored model — dashboard-scoped and personal-scoped measures. They
/// are OVERLAID onto the model definition by
/// <see cref="Querying.MeasureOverlay.Merge"/> BEFORE the compiler prepares
/// the query, so they resolve, join-plan and ROW-FILTER exactly like model
/// measures. Measure REFERENCES stay <c>{ measureId }</c> — nothing about the
/// existing measure wire changes.
/// DerivedFields (wire "derivedFields") is the same channel for DERIVED FIELD
/// definitions that are not in the stored model, merged by the same overlay at
/// the same moment and under the same caps. A dimension or filter referencing
/// one stays an ordinary <c>{ table, column }</c>.
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
    IReadOnlyList<HavingSpec>? Having = null,
    IReadOnlyList<Measure>? Definitions = null,
    IReadOnlyList<DerivedField>? DerivedFields = null);

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

/// <summary>
/// Feeds slicer dropdowns and the value pickers of the filter / grouping
/// editors. Filters may span tables (cascading slicers). DerivedFields carries
/// non-model derived definitions so a dropdown can list the DISTINCT VALUES OF
/// A DERIVED COLUMN — the grouping editor picks from real values, and a header
/// filter on a derived column needs the same list.
/// </summary>
public sealed record DistinctValuesSpec(
    int ModelId,
    string Table,
    string Column,
    string? Search,
    IReadOnlyList<FilterSpec> Filters,
    int? Limit,
    IReadOnlyList<DerivedField>? DerivedFields = null);
