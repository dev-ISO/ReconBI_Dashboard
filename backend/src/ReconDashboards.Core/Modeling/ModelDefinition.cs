using System.Text.Json.Serialization;
using ReconDashboards.Core.Json;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Core.Modeling;

/// <summary>
/// Wire names are camelCase via the converter: "sum", "avg", "min", "max",
/// "count", "countDistinct", "stdDev", "variance", "median".
/// </summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<Aggregation>))]
public enum Aggregation
{
    Sum,
    Avg,
    Min,
    Max,
    Count,
    CountDistinct,
    StdDev,
    Variance,
    Median,
}

[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<Cardinality>))]
public enum Cardinality
{
    ManyToOne,
    OneToOne,
}

[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<RelationshipSource>))]
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
///
/// <para><see cref="DisplayFolders"/> is pure UI metadata (like Measure's
/// DisplayFolder): the field list's "Category" grouping. It is a LIST because
/// the relation it models is many-to-many — a host column commonly appears on
/// several of the host's own pages, and a single string could only express one
/// of them. Paths are backslash-separated for nesting ('Safety\Dispersion'),
/// matching Measure.DisplayFolder exactly. The engine never reads it: no
/// query, join, filter or validation rule consults it.</para>
///
/// <para>WIRE COMPATIBILITY: <see cref="ModelJson"/> sets
/// UnmappedMemberHandling.Disallow, so a document written WITH this field is a
/// hard load failure on an engine that predates it. Serialization omits it
/// when null (DefaultIgnoreCondition.WhenWritingNull), so a model that never
/// sets it is byte-identical to one written before the field existed — which
/// is what lets this ship ahead of any host that populates it.</para>
///
/// <para>NO ColumnDisplayFolders CONVENIENCE PROPERTY, unlike
/// <see cref="ModelTable.ColumnOverrides"/> and Measure.MeasureFilters. Those
/// predate this and their computed values are SERIALIZED (System.Text.Json
/// emits get-only properties), so each already costs bytes in every stored
/// document. A folder list mirrored the same way would be written twice per
/// column — inline and again inside columnOverrides — against a 256KB model
/// cap, to serve a field no C# code reads. Callers use
/// <c>DisplayFolders ?? []</c>.</para>
/// </summary>
public sealed record ModelColumn(
    string Name,
    string? FriendlyName = null,
    Aggregation? DefaultAggregation = null,
    string? FormatHint = null,
    bool Hidden = false,
    IReadOnlyList<string>? DisplayFolders = null);

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

/// <summary>
/// Column is null only for Count (COUNT(*)) and for calculated measures. When
/// <see cref="Expression"/> is set the measure is calculated: Aggregation and
/// Column are ignored (Column must stay null — MDL014) and the expression
/// composes aggregate calls / [references] to other measures (plain or
/// expression-based; cycles are MDL016). Table remains the measure's home
/// table (it anchors join planning). Description/DisplayFolder are pure UI
/// metadata; FormatString is an Excel-style number pattern the renderer feeds
/// to its pattern formatter (it wins over FormatHint when both are set).
/// </summary>
public sealed record Measure(
    Guid Id,
    string Name,
    string Table,
    Aggregation Aggregation,
    string? Column = null,
    string? FormatHint = null,
    IReadOnlyList<FilterSpec>? Filters = null,
    string? Expression = null,
    string? Description = null,
    string? DisplayFolder = null,
    string? FormatString = null)
{
    public IReadOnlyList<FilterSpec> MeasureFilters => Filters ?? [];
}

/// <summary>
/// A DERIVED FIELD: a VIRTUAL COLUMN on <see cref="Table"/>, computed row by row
/// from other columns of THAT SAME TABLE.
///
/// <para>*** THE ARCHITECTURAL DECISION. *** A derived field is a column, not a
/// new shape of dimension reference. A chart that groups by one still sends an
/// ordinary <c>{ table, column }</c> — the column name is this field's
/// <see cref="Name"/> (or its <see cref="Id"/>) — so the query wire, the email
/// snapshot parser, drill-down, cross-filter, see-records, drillthrough, header
/// filters, hover matching and every golden statement keep working unchanged,
/// because table and column stay real, populated strings. The compiler injects
/// these into the resolved schema (exactly as it injects date tables) and
/// resolves the column to its expression SQL through the ONE seam
/// <c>DimensionExpression</c> already used by dateBucket.</para>
///
/// <para>*** SAME-TABLE IS A SECURITY PROPERTY, NOT A LIMITATION. *** The
/// expression may only name columns of <see cref="Table"/>. That table is in
/// the join plan already — the dimension/filter that reaches the derived column
/// names it — so it already receives its row filters and the derived field adds
/// NO new bypass surface. An expression naming any other table is rejected with
/// QRY_DERIVED_CROSS_TABLE. Relaxing this would reintroduce exactly the
/// "row filters silently skipped for a table only an expression names" hazard
/// that <see cref="Querying.MeasureOverlay"/> exists to prevent.</para>
///
/// <para><see cref="DataType"/> is "text" — the only kind this engine derives
/// (a derived field produces a category LABEL). Anything else is rejected.
/// Description/DisplayFolder are pure UI metadata, like Measure's.</para>
///
/// <para>WIRE COMPATIBILITY: <see cref="ModelJson"/> sets
/// UnmappedMemberHandling.Disallow, so a model document that CARRIES derived
/// fields is a hard load failure on an engine that predates them. Serialization
/// omits the list when null, so a model without any is byte-identical to one
/// written before the field existed.</para>
/// </summary>
public sealed record DerivedField(
    Guid Id,
    string Name,
    string Table,
    string Expression,
    string? DataType = null,
    string? Description = null,
    string? DisplayFolder = null)
{
    /// <summary>The only supported derived data type.</summary>
    public const string TextDataType = "text";

    /// <summary>True unless the document names a type this engine cannot derive.</summary>
    public bool IsTextTyped =>
        DataType is null || string.Equals(DataType, TextDataType, StringComparison.OrdinalIgnoreCase);
}

/// <summary>Wire names via the converter: "monday", "sunday".</summary>
[JsonConverter(typeof(CamelCaseJsonStringEnumConverter<WeekStartDay>))]
public enum WeekStartDay
{
    Monday,
    Sunday,
}

/// <summary>
/// A model-declared VIRTUAL calendar table (see <see cref="DateTableSchema"/>).
/// Null range bounds default at compile time to 2015-01-01 and Dec 31 of next
/// year; both ends are always bound as parameters. FiscalYearStartMonth (1-12,
/// default 1 = calendar) and WeekStartDay (default monday) shape the generated
/// fiscal_* / day_of_week / week_start columns; both are validated (MDL015)
/// and inlined into the calendar SQL only as vetted constants, never as text.
/// </summary>
public sealed record DateTableDef(
    string Name,
    DateOnly? RangeStart = null,
    DateOnly? RangeEnd = null,
    int? FiscalYearStartMonth = null,
    WeekStartDay? WeekStartDay = null)
{
    public string Key => $"{DateTableSchema.KeyPrefix}{Name}";

    /// <summary>Validated fiscal start month with the calendar default.</summary>
    public int EffectiveFiscalYearStartMonth => FiscalYearStartMonth ?? 1;

    /// <summary>True unless the model explicitly picked Sunday-start weeks.</summary>
    public bool WeekStartsMonday => (WeekStartDay ?? Modeling.WeekStartDay.Monday) == Modeling.WeekStartDay.Monday;
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
    IReadOnlyList<Measure> Measures,
    IReadOnlyList<DateTableDef>? DateTables = null,
    IReadOnlyList<DerivedField>? DerivedFields = null)
{
    public const int CurrentVersion = 1;

    public IReadOnlyList<DateTableDef> DateTableDefs => DateTables ?? [];

    /// <summary>SYSTEM-scoped derived fields. Dashboard/personal ones ride the query wire instead.</summary>
    public IReadOnlyList<DerivedField> DerivedFieldDefs => DerivedFields ?? [];

    public ModelTable? FindTable(string key) =>
        Tables.FirstOrDefault(t => string.Equals(t.Key, key, StringComparison.Ordinal));

    /// <summary>The derived fields attached to one table, in declaration order.</summary>
    public IReadOnlyList<DerivedField> DerivedFieldsOn(string tableKey) =>
        [.. DerivedFieldDefs.Where(f => string.Equals(f.Table, tableKey, StringComparison.Ordinal))];

    public DateTableDef? FindDateTable(string key) =>
        DateTableDefs.FirstOrDefault(d => string.Equals(d.Key, key, StringComparison.Ordinal));

    /// <summary>True when the key names a model table or a declared date table.</summary>
    public bool ContainsTable(string key) => FindTable(key) is not null || FindDateTable(key) is not null;
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
