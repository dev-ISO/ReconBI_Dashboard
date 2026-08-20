using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Modeling;

/// <summary>
/// Validates a model definition against a live catalog snapshot. Runs on save
/// (store rejects on errors) and again at query time, so schema drift degrades
/// to a clear error — never to bad SQL.
///
/// Codes: MDL001 table existence/duplicates (incl. date tables) · MDL002
/// column/endpoint existence · MDL003 join type compatibility (incl. date-table
/// endpoint rules) · MDL004 one active relationship per pair · MDL005 no
/// self-relationships · MDL006 duplicate relationship (warning) · MDL007
/// active-graph cycle · MDL008 aggregation/type compatibility · MDL009
/// many-side cardinality unproven (warning) · MDL010 name collisions (warning) ·
/// MDL011 unusable endpoint type · MDL012 measure expression parse error ·
/// MDL013 measure expression reference invalid (incl. references to
/// PERCENTOFTOTAL measures) · MDL014 expression measure also sets a column ·
/// MDL015 date-table settings invalid (empty range, fiscalYearStartMonth
/// outside 1-12, unknown weekStartDay) · MDL016 measure reference cycle or a
/// reference chain nested more than 8 expression measures deep · MDL017 derived
/// field invalid (missing name/table/expression, unsupported data type, unknown
/// table, expression parse error, a reference to another table — which is
/// refused as a SECURITY rule, not a style rule — an unknown or unusable
/// referenced column, a reference to another derived field, or a name that
/// collides with a real column of the same table).
/// </summary>
public sealed class SemanticModelValidator
{
    /// <summary>Maximum expression-measure reference chain (mirrored by the compiler's QRY_MEASURE_CYCLE guard).</summary>
    public const int MaxMeasureReferenceDepth = 8;

    public ValidationResult Validate(ModelDefinition definition, DatabaseSchema schema)
    {
        var result = new ValidationResult();

        var catalogTables = ValidateTables(definition, schema, result);
        ValidateDateTables(definition, catalogTables, result);
        ValidateRelationships(definition, catalogTables, result);
        ValidateMeasures(definition, catalogTables, result);
        ValidateMeasureReferenceGraph(definition, result);
        ValidateDerivedFields(definition, catalogTables, result);
        ValidateNameCollisions(definition, result);

        return result;
    }

    /// <summary>
    /// MDL017: derived fields. The checks mirror the compiler's exactly — the
    /// compiler is the enforcement, this is the EDITOR's copy so an author sees
    /// the mistake while writing instead of when a chart runs.
    ///
    /// The same-table rule is checked here too, and it is not a style rule: a
    /// derived field that could read another table would be a table the join
    /// plan does not know about, and therefore a table whose row filters would
    /// be silently skipped.
    /// </summary>
    private static void ValidateDerivedFields(
        ModelDefinition definition,
        Dictionary<string, TableSchema> catalogTables,
        ValidationResult result)
    {
        var seen = new HashSet<(string Table, string Name)>();

        for (var i = 0; i < definition.DerivedFieldDefs.Count; i++)
        {
            var field = definition.DerivedFieldDefs[i];
            var path = $"derivedFields[{i}]";

            if (string.IsNullOrWhiteSpace(field.Name))
            {
                result.AddError("MDL017", "A derived field needs a name.", path);
                continue;
            }

            if (!seen.Add((field.Table ?? "", field.Name.ToLowerInvariant())))
            {
                result.AddError(
                    "MDL017",
                    $"'{field.Table}' already has a derived field named '{field.Name}'; one would silently shadow the other.",
                    $"{path}.name");
            }

            if (!field.IsTextTyped)
            {
                result.AddError(
                    "MDL017",
                    $"Derived field '{field.Name}' declares data type '{field.DataType}'; only '{DerivedField.TextDataType}' is supported.",
                    path);
            }

            if (string.IsNullOrWhiteSpace(field.Table) || definition.FindTable(field.Table) is null)
            {
                result.AddError(
                    "MDL017",
                    $"Derived field '{field.Name}' belongs to table '{field.Table}', which is not part of the model.",
                    $"{path}.table");
                continue;
            }

            if (!catalogTables.TryGetValue(field.Table, out var table))
            {
                continue; // Catalog absence already reported as MDL001.
            }

            if (table.FindColumn(field.Name) is not null)
            {
                result.AddError(
                    "MDL017",
                    $"Derived field '{field.Name}' has the same name as a real column of '{field.Table}'; rename it so it cannot shadow that column.",
                    $"{path}.name");
            }

            if (string.IsNullOrWhiteSpace(field.Expression))
            {
                result.AddError("MDL017", $"Derived field '{field.Name}' needs an expression.", $"{path}.expression");
                continue;
            }

            MeasureExprNode root;
            try
            {
                root = MeasureExpressionParser.Parse(field.Expression, ExpressionContext.Dimension);
            }
            catch (MeasureExpressionParseException ex)
            {
                result.AddError("MDL017", $"Derived field '{field.Name}': {ex.Message}", $"{path}.expression");
                continue;
            }

            foreach (var node in MeasureExpressionParser.Flatten(root))
            {
                if (node is not ColumnRefNode reference)
                {
                    continue;
                }

                if (!string.Equals(reference.TableKey, field.Table, StringComparison.Ordinal))
                {
                    result.AddError(
                        "MDL017",
                        $"Derived field '{field.Name}' belongs to '{field.Table}' and may only use that table's columns, but it references '{reference.TableKey}.{reference.Column}'.",
                        $"{path}.expression");
                    continue;
                }

                var target = table.FindColumn(reference.Column);
                if (target is null)
                {
                    result.AddError(
                        "MDL017",
                        $"Derived field '{field.Name}' references column '{reference.Column}', which does not exist on '{field.Table}'.",
                        $"{path}.expression");
                    continue;
                }

                if (IsUnusableEndpointType(target.Type))
                {
                    result.AddError(
                        "MDL017",
                        $"Derived field '{field.Name}' references column '{reference.Column}', whose type {target.Type} cannot be used in an expression.",
                        $"{path}.expression");
                }
            }
        }
    }

    /// <summary>
    /// Date tables are virtual — nothing to check against the catalog — but
    /// their names must be usable and their ranges non-empty. Valid ones join
    /// the resolved-table map so relationship/endpoint checks treat them like
    /// any other table.
    /// </summary>
    private static void ValidateDateTables(
        ModelDefinition definition,
        Dictionary<string, TableSchema> catalogTables,
        ValidationResult result)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (var i = 0; i < definition.DateTableDefs.Count; i++)
        {
            var dateTable = definition.DateTableDefs[i];
            var path = $"dateTables[{i}]";

            if (string.IsNullOrWhiteSpace(dateTable.Name))
            {
                result.AddError("MDL001", "A date table needs a non-empty name.", path);
                continue;
            }

            if (!seen.Add(dateTable.Name))
            {
                result.AddError("MDL001", $"Date table '{dateTable.Name}' appears more than once in the model.", path);
                continue;
            }

            if (dateTable is { RangeStart: { } start, RangeEnd: { } end } && start > end)
            {
                result.AddError(
                    "MDL015",
                    $"Date table '{dateTable.Name}' has an empty range: rangeStart {start:yyyy-MM-dd} is after rangeEnd {end:yyyy-MM-dd}.",
                    path);
                continue;
            }

            if (dateTable.FiscalYearStartMonth is { } fiscalStart && fiscalStart is < 1 or > 12)
            {
                result.AddError(
                    "MDL015",
                    $"Date table '{dateTable.Name}' has an invalid fiscalYearStartMonth {fiscalStart}; it must be between 1 and 12.",
                    path);
                continue;
            }

            if (dateTable.WeekStartDay is { } weekStart && !Enum.IsDefined(weekStart))
            {
                result.AddError(
                    "MDL015",
                    $"Date table '{dateTable.Name}' has an unknown weekStartDay; expected monday or sunday.",
                    path);
                continue;
            }

            catalogTables[dateTable.Key] = DateTableSchema.Build(dateTable);
        }
    }

    private static Dictionary<string, TableSchema> ValidateTables(
        ModelDefinition definition, DatabaseSchema schema, ValidationResult result)
    {
        var resolved = new Dictionary<string, TableSchema>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        for (var i = 0; i < definition.Tables.Count; i++)
        {
            var table = definition.Tables[i];
            var path = $"tables[{i}]";

            if (!seen.Add(table.Key))
            {
                result.AddError("MDL001", $"Table '{table.Key}' appears more than once in the model.", path);
                continue;
            }

            var catalogTable = schema.FindTable(table.Key);
            if (catalogTable is null)
            {
                result.AddError(
                    "MDL001",
                    $"Table '{table.Key}' does not exist in the data source (or is not allowlisted). It may have been dropped or renamed since the model was built.",
                    path);
                continue;
            }

            resolved[table.Key] = catalogTable;

            for (var c = 0; c < table.ColumnOverrides.Count; c++)
            {
                var column = table.ColumnOverrides[c];
                if (catalogTable.FindColumn(column.Name) is null)
                {
                    result.AddError(
                        "MDL002",
                        $"Column '{column.Name}' does not exist on table '{table.Key}'.",
                        $"{path}.columns[{c}]");
                }
            }
        }

        return resolved;
    }

    private static void ValidateRelationships(
        ModelDefinition definition,
        Dictionary<string, TableSchema> catalogTables,
        ValidationResult result)
    {
        var activePairs = new HashSet<string>(StringComparer.Ordinal);
        var endpointSets = new HashSet<string>(StringComparer.Ordinal);
        var unionFind = new UnionFind();
        var cycleReported = false;

        for (var i = 0; i < definition.Relationships.Count; i++)
        {
            var rel = definition.Relationships[i];
            var path = $"relationships[{i}]";

            if (string.Equals(rel.FromTable, rel.ToTable, StringComparison.Ordinal))
            {
                result.AddError("MDL005", $"Self-relationships are not supported ('{rel.FromTable}').", path);
                continue;
            }

            if (DateTableSchema.IsDateTableKey(rel.FromTable))
            {
                result.AddError(
                    "MDL003",
                    $"A date table can only be the \"to\" (one) side of a relationship; '{rel.FromTable}' is on the from side.",
                    path);
                continue;
            }

            var toDateTable = DateTableSchema.IsDateTableKey(rel.ToTable);

            var fromColumn = ResolveEndpoint(rel.FromTable, rel.FromColumn, catalogTables, result, path, definition);
            var toColumn = ResolveEndpoint(rel.ToTable, rel.ToColumn, catalogTables, result, path, definition);
            if (fromColumn is null || toColumn is null)
            {
                continue;
            }

            if (IsUnusableEndpointType(fromColumn.Type))
            {
                result.AddError(
                    "MDL011",
                    $"Column '{rel.FromTable}.{rel.FromColumn}' has type {fromColumn.Type} ({fromColumn.RawType}) and cannot be a relationship endpoint.",
                    path);
                continue;
            }

            if (IsUnusableEndpointType(toColumn.Type))
            {
                result.AddError(
                    "MDL011",
                    $"Column '{rel.ToTable}.{rel.ToColumn}' has type {toColumn.Type} ({toColumn.RawType}) and cannot be a relationship endpoint.",
                    path);
                continue;
            }

            if (toDateTable)
            {
                // Date tables join on date_key from a Date column (equality) or
                // a Timestamp column (the compiler casts the from side to date).
                if (!string.Equals(rel.ToColumn, DateTableSchema.DateKeyColumn, StringComparison.Ordinal))
                {
                    result.AddError(
                        "MDL003",
                        $"Relationships to a date table must join its '{DateTableSchema.DateKeyColumn}' column, not '{rel.ToColumn}'.",
                        path);
                    continue;
                }

                if (fromColumn.Type is not (NormalizedType.Date or NormalizedType.Timestamp))
                {
                    result.AddError(
                        "MDL003",
                        $"'{rel.FromTable}.{rel.FromColumn}' is {fromColumn.Type}; joining a date table needs a date or timestamp column.",
                        path);
                    continue;
                }
            }
            else if (!AreJoinCompatible(fromColumn.Type, toColumn.Type))
            {
                result.AddError(
                    "MDL003",
                    $"Relationship endpoints have incompatible types: '{rel.FromTable}.{rel.FromColumn}' is {fromColumn.Type} but '{rel.ToTable}.{rel.ToColumn}' is {toColumn.Type}.",
                    path);
                continue;
            }

            var endpointKey = EndpointKey(rel);
            if (!endpointSets.Add(endpointKey))
            {
                result.AddWarning(
                    "MDL006",
                    $"Duplicate relationship between '{rel.FromTable}.{rel.FromColumn}' and '{rel.ToTable}.{rel.ToColumn}'.",
                    path);
            }

            if (rel.Cardinality == Cardinality.ManyToOne
                && catalogTables.TryGetValue(rel.ToTable, out var toTable)
                && !toTable.IsColumnUnique(rel.ToColumn))
            {
                result.AddWarning(
                    "MDL009",
                    $"'{rel.ToTable}.{rel.ToColumn}' is declared the \"one\" side but has no primary key or unique constraint — many-to-one is unproven and query results may over-count.",
                    path);
            }

            if (!rel.IsActive)
            {
                continue;
            }

            var pairKey = PairKey(rel.FromTable, rel.ToTable);
            if (!activePairs.Add(pairKey))
            {
                result.AddError(
                    "MDL004",
                    $"More than one ACTIVE relationship between '{rel.FromTable}' and '{rel.ToTable}'. Deactivate all but one.",
                    path);
                continue;
            }

            if (!unionFind.Union(rel.FromTable, rel.ToTable) && !cycleReported)
            {
                cycleReported = true;
                result.AddError(
                    "MDL007",
                    $"Active relationships form a cycle (closing at '{rel.FromTable}' — '{rel.ToTable}'). Cycles make join paths ambiguous; deactivate one relationship in the loop.",
                    path);
            }
        }
    }

    private static ColumnSchema? ResolveEndpoint(
        string tableKey,
        string columnName,
        Dictionary<string, TableSchema> catalogTables,
        ValidationResult result,
        string path,
        ModelDefinition definition)
    {
        if (!definition.ContainsTable(tableKey))
        {
            result.AddError("MDL002", $"Relationship references table '{tableKey}', which is not part of the model.", path);
            return null;
        }

        if (!catalogTables.TryGetValue(tableKey, out var catalogTable))
        {
            // Missing from catalog already reported as MDL001.
            return null;
        }

        var column = catalogTable.FindColumn(columnName);
        if (column is null)
        {
            result.AddError("MDL002", $"Column '{columnName}' does not exist on table '{tableKey}'.", path);
            return null;
        }

        return column;
    }

    private static void ValidateMeasures(
        ModelDefinition definition,
        Dictionary<string, TableSchema> catalogTables,
        ValidationResult result)
    {
        for (var i = 0; i < definition.Measures.Count; i++)
        {
            var measure = definition.Measures[i];
            var path = $"measures[{i}]";

            if (definition.FindTable(measure.Table) is null)
            {
                result.AddError("MDL002", $"Measure '{measure.Name}' references table '{measure.Table}', which is not part of the model.", path);
                continue;
            }

            if (!catalogTables.TryGetValue(measure.Table, out var catalogTable))
            {
                continue; // Catalog absence already reported as MDL001.
            }

            if (measure.Expression is not null)
            {
                if (measure.Column is not null)
                {
                    result.AddError(
                        "MDL014",
                        $"Measure '{measure.Name}' is expression-based and may not also set a source column.",
                        $"{path}.column");
                }

                ValidateMeasureExpression(definition, measure, catalogTables, result, path);
            }
            else if (measure.Column is null)
            {
                if (measure.Aggregation != Aggregation.Count)
                {
                    result.AddError(
                        "MDL008",
                        $"Measure '{measure.Name}' has no source column; only Count may omit the column (COUNT(*)).",
                        path);
                }
            }
            else
            {
                var column = catalogTable.FindColumn(measure.Column);
                if (column is null)
                {
                    result.AddError("MDL002", $"Column '{measure.Column}' does not exist on table '{measure.Table}'.", $"{path}.column");
                }
                else if (!IsAggregationCompatible(measure.Aggregation, column.Type))
                {
                    result.AddError(
                        "MDL008",
                        $"Measure '{measure.Name}': {measure.Aggregation} is not valid for column '{measure.Column}' of type {column.Type}.",
                        $"{path}.aggregation");
                }
            }

            for (var f = 0; f < measure.MeasureFilters.Count; f++)
            {
                var filter = measure.MeasureFilters[f];
                var filterPath = $"{path}.filters[{f}]";
                if (definition.FindTable(filter.Table) is null)
                {
                    result.AddError("MDL002", $"Measure filter references table '{filter.Table}', which is not part of the model.", filterPath);
                }
                else if (catalogTables.TryGetValue(filter.Table, out var filterTable)
                    && filterTable.FindColumn(filter.Column) is null)
                {
                    result.AddError("MDL002", $"Column '{filter.Column}' does not exist on table '{filter.Table}'.", filterPath);
                }
            }
        }
    }

    /// <summary>
    /// MDL012: expression does not parse (grammar v2: arithmetic, comparisons,
    /// AND/OR/NOT in conditions, IF/SWITCH/DIVIDE, scalar functions, BLANK(),
    /// an optional outermost PERCENTOFTOTAL). MDL013: a reference does not
    /// resolve — unknown/non-model table, unknown column, aggregation/type
    /// mismatch, unknown or ambiguous [measure], or a [measure] whose own
    /// expression uses PERCENTOFTOTAL (a post-aggregation window that cannot
    /// be inlined into another expression). References to other expression
    /// measures are allowed; cycles/depth are MDL016 (see
    /// <see cref="ValidateMeasureReferenceGraph"/>).
    /// </summary>
    private static void ValidateMeasureExpression(
        ModelDefinition definition,
        Measure measure,
        Dictionary<string, TableSchema> catalogTables,
        ValidationResult result,
        string path)
    {
        MeasureExprNode root;
        try
        {
            root = MeasureExpressionParser.Parse(measure.Expression!);
        }
        catch (MeasureExpressionParseException ex)
        {
            result.AddError("MDL012", $"Measure '{measure.Name}': {ex.Message}", $"{path}.expression");
            return;
        }

        var expressionPath = $"{path}.expression";
        foreach (var node in MeasureExpressionParser.Flatten(root))
        {
            switch (node)
            {
                case AggregateCallNode { TableKey: { } tableKey } call:
                    if (definition.FindTable(tableKey) is null)
                    {
                        result.AddError(
                            "MDL013",
                            $"Measure '{measure.Name}' expression references table '{tableKey}', which is not part of the model.",
                            expressionPath);
                        break;
                    }

                    if (!catalogTables.TryGetValue(tableKey, out var callTable))
                    {
                        break; // Catalog absence already reported as MDL001.
                    }

                    var callColumn = callTable.FindColumn(call.Column!);
                    if (callColumn is null)
                    {
                        result.AddError(
                            "MDL013",
                            $"Measure '{measure.Name}' expression references column '{call.Column}', which does not exist on '{tableKey}'.",
                            expressionPath);
                    }
                    else if (!IsAggregationCompatible(call.Aggregation, callColumn.Type))
                    {
                        result.AddError(
                            "MDL013",
                            $"Measure '{measure.Name}' expression: {call.Aggregation} is not valid for column '{call.Column}' of type {callColumn.Type}.",
                            expressionPath);
                    }

                    break;

                case MeasureRefNode reference:
                    var (target, ambiguous) = MeasureExpressionParser.ResolveMeasureRef(definition, reference.Name);
                    if (ambiguous)
                    {
                        result.AddError(
                            "MDL013",
                            $"Measure '{measure.Name}' expression reference '[{reference.Name}]' matches more than one measure; rename them so the reference is unambiguous.",
                            expressionPath);
                    }
                    else if (target is null)
                    {
                        result.AddError(
                            "MDL013",
                            $"Measure '{measure.Name}' expression references measure '[{reference.Name}]', which does not exist.",
                            expressionPath);
                    }
                    else if (target.Expression is not null && ExpressionRootIsPercentOfTotal(target))
                    {
                        result.AddError(
                            "MDL013",
                            $"Measure '{measure.Name}' expression references '[{reference.Name}]', which uses PERCENTOFTOTAL; percent-of-total measures cannot be embedded in another expression.",
                            expressionPath);
                    }

                    break;
            }
        }
    }

    /// <summary>True when the measure's expression parses and is wrapped in PERCENTOFTOTAL.</summary>
    private static bool ExpressionRootIsPercentOfTotal(Measure measure)
    {
        try
        {
            return MeasureExpressionParser.Parse(measure.Expression!) is PercentOfTotalNode;
        }
        catch (MeasureExpressionParseException)
        {
            return false; // its own MDL012 covers it
        }
    }

    /// <summary>
    /// MDL016: whole-model reference-graph checks for expression measures.
    /// A cycle ([A] -> [B] -> [A], including self-reference) is reported once
    /// per validation at the measure that closes it; acyclic chains deeper
    /// than <see cref="MaxMeasureReferenceDepth"/> expression measures are
    /// reported at the chain head. Unparseable expressions (MDL012) and
    /// unresolved references (MDL013) are simply absent from the graph.
    /// </summary>
    private static void ValidateMeasureReferenceGraph(ModelDefinition definition, ValidationResult result)
    {
        var expressionTargets = new Dictionary<Guid, IReadOnlyList<Measure>>();
        foreach (var measure in definition.Measures)
        {
            if (measure.Expression is null)
            {
                continue;
            }

            MeasureExprNode root;
            try
            {
                root = MeasureExpressionParser.Parse(measure.Expression);
            }
            catch (MeasureExpressionParseException)
            {
                continue;
            }

            expressionTargets[measure.Id] = MeasureExpressionParser.Flatten(root)
                .OfType<MeasureRefNode>()
                .Select(r => MeasureExpressionParser.ResolveMeasureRef(definition, r.Name))
                .Where(t => t is { Ambiguous: false, Match.Expression: not null })
                .Select(t => t.Match!)
                .DistinctBy(m => m.Id)
                .ToArray();
        }

        var state = new Dictionary<Guid, int>(); // 1 = on stack, 2 = finished
        var chainDepth = new Dictionary<Guid, int>();
        var cycleReported = false;

        int Visit(Measure measure, List<Measure> stack)
        {
            if (state.TryGetValue(measure.Id, out var s))
            {
                if (s == 2)
                {
                    return chainDepth.GetValueOrDefault(measure.Id);
                }

                if (!cycleReported)
                {
                    cycleReported = true;
                    var closingIndex = stack.FindIndex(m => m.Id == measure.Id);
                    var names = stack.Skip(Math.Max(closingIndex, 0))
                        .Select(m => $"'{m.Name}'")
                        .Append($"'{measure.Name}'");
                    var measureIndex = IndexOf(definition, measure.Id);
                    result.AddError(
                        "MDL016",
                        $"Measure references form a cycle: {string.Join(" -> ", names)}. Break the loop so each measure can be inlined.",
                        measureIndex >= 0 ? $"measures[{measureIndex}].expression" : null);
                }

                return 0;
            }

            if (!expressionTargets.TryGetValue(measure.Id, out var targets))
            {
                state[measure.Id] = 2;
                return 0; // plain measure (or one whose expression failed earlier checks)
            }

            state[measure.Id] = 1;
            stack.Add(measure);
            var depth = 0;
            foreach (var target in targets)
            {
                depth = Math.Max(depth, Visit(target, stack) + 1);
            }

            stack.RemoveAt(stack.Count - 1);
            state[measure.Id] = 2;
            chainDepth[measure.Id] = depth;
            return depth;
        }

        for (var i = 0; i < definition.Measures.Count; i++)
        {
            var measure = definition.Measures[i];
            if (!expressionTargets.ContainsKey(measure.Id) || state.ContainsKey(measure.Id))
            {
                continue;
            }

            if (Visit(measure, []) > MaxMeasureReferenceDepth)
            {
                result.AddError(
                    "MDL016",
                    $"Measure '{measure.Name}' references measures more than {MaxMeasureReferenceDepth} levels deep; flatten the chain.",
                    $"measures[{i}].expression");
            }
        }
    }

    private static int IndexOf(ModelDefinition definition, Guid measureId)
    {
        for (var i = 0; i < definition.Measures.Count; i++)
        {
            if (definition.Measures[i].Id == measureId)
            {
                return i;
            }
        }

        return -1;
    }

    private static void ValidateNameCollisions(ModelDefinition definition, ValidationResult result)
    {
        var tableNames = definition.Tables
            .GroupBy(t => t.FriendlyName ?? t.Name, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1);
        foreach (var group in tableNames)
        {
            result.AddWarning("MDL010", $"Multiple tables display as '{group.Key}'; give them distinct friendly names.");
        }

        var measureNames = definition.Measures
            .GroupBy(m => m.Name, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1);
        foreach (var group in measureNames)
        {
            result.AddWarning("MDL010", $"Multiple measures are named '{group.Key}'.");
        }
    }

    private static bool IsUnusableEndpointType(NormalizedType type) =>
        type is NormalizedType.Other or NormalizedType.Json;

    private static bool AreJoinCompatible(NormalizedType a, NormalizedType b) =>
        a == b
        || (a is NormalizedType.Integer or NormalizedType.Decimal
            && b is NormalizedType.Integer or NormalizedType.Decimal);

    private static bool IsAggregationCompatible(Aggregation aggregation, NormalizedType type)
    {
        if (type == NormalizedType.Other)
        {
            return false;
        }

        return aggregation switch
        {
            Aggregation.Sum or Aggregation.Avg
                or Aggregation.StdDev or Aggregation.Variance or Aggregation.Median =>
                type is NormalizedType.Integer or NormalizedType.Decimal,
            Aggregation.Min or Aggregation.Max => type is NormalizedType.Integer or NormalizedType.Decimal
                or NormalizedType.Date or NormalizedType.Timestamp or NormalizedType.Text,
            Aggregation.Count or Aggregation.CountDistinct => true,
            _ => false,
        };
    }

    private static string PairKey(string a, string b) =>
        string.CompareOrdinal(a, b) <= 0 ? $"{a}::{b}" : $"{b}::{a}";

    private static string EndpointKey(Relationship rel)
    {
        var e1 = $"{rel.FromTable}.{rel.FromColumn}";
        var e2 = $"{rel.ToTable}.{rel.ToColumn}";
        return string.CompareOrdinal(e1, e2) <= 0 ? $"{e1}::{e2}" : $"{e2}::{e1}";
    }

    /// <summary>Union-find over table keys; Union returns false when the edge closes a cycle.</summary>
    private sealed class UnionFind
    {
        private readonly Dictionary<string, string> _parent = new(StringComparer.Ordinal);

        public bool Union(string a, string b)
        {
            var rootA = Find(a);
            var rootB = Find(b);
            if (string.Equals(rootA, rootB, StringComparison.Ordinal))
            {
                return false;
            }

            _parent[rootA] = rootB;
            return true;
        }

        private string Find(string node)
        {
            if (!_parent.TryGetValue(node, out var parent))
            {
                _parent[node] = node;
                return node;
            }

            if (string.Equals(parent, node, StringComparison.Ordinal))
            {
                return node;
            }

            var root = Find(parent);
            _parent[node] = root;
            return root;
        }
    }
}
