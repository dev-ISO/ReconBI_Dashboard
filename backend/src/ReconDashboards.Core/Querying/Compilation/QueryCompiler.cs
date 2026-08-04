using System.Text;
using System.Text.Json;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Querying.Compilation;

public sealed record ResolvedDimension(DimensionSpec Spec, TableSchema Table, ColumnSchema Column, string Label, string? FormatHint);

/// <summary>
/// A calculated measure's parsed expression with its references resolved:
/// the distinct table keys used by direct aggregate calls, and each [reference]
/// mapped to the (plain) model measure it names.
/// </summary>
public sealed record ResolvedMeasureExpression(
    MeasureExprNode Root,
    IReadOnlyList<string> AggregateTableKeys,
    IReadOnlyDictionary<string, ResolvedMeasure> References);

/// <summary>Expression is non-null for calculated measures; Aggregation/Column are then unused.</summary>
public sealed record ResolvedMeasure(string Label, TableSchema Table, Aggregation Aggregation, ColumnSchema? Column, IReadOnlyList<ResolvedFilter> Filters, string? FormatHint, ResolvedMeasureExpression? Expression = null);

public sealed record ResolvedFilter(TableSchema Table, ColumnSchema Column, FilterOperator Operator, IReadOnlyList<JsonElement> Values);

/// <summary>Output of the resolution phase; row filters are collected against Plan.Tables before Emit.</summary>
public sealed record PreparedQuery(
    IReadOnlyList<ResolvedDimension> Dimensions,
    IReadOnlyList<ResolvedMeasure> Measures,
    IReadOnlyList<ResolvedFilter> Filters,
    JoinPlan Plan,
    DatabaseSchema Schema,
    IReadOnlyList<DateTableDef>? DateTables = null)
{
    /// <summary>Date tables the join plan touches, in emission order.</summary>
    public IReadOnlyList<DateTableDef> CalendarTables => DateTables ?? [];
}

public sealed record PreparedDistinctQuery(
    TableSchema Table,
    ColumnSchema Column,
    string? Search,
    IReadOnlyList<ResolvedFilter> Filters,
    int Limit,
    JoinPlan Plan,
    DatabaseSchema Schema,
    IReadOnlyList<DateTableDef>? DateTables = null)
{
    /// <summary>Date tables the join plan touches, in emission order.</summary>
    public IReadOnlyList<DateTableDef> CalendarTables => DateTables ?? [];
}

/// <summary>
/// Spec + model + catalog snapshot -> parameterized single-statement SELECT.
/// Every identifier in the output is resolved from the snapshot then
/// dialect-quoted; every value is a parameter. No client string ever reaches
/// SQL text. The clock only feeds default date-table ranges (which are always
/// bound as parameters, so statements stay deterministic for a fixed clock).
/// </summary>
public sealed class QueryCompiler(ISqlDialect dialect, TimeProvider? timeProvider = null)
{
    private readonly TimeProvider _clock = timeProvider ?? TimeProvider.System;

    // ---------- Phase 1: resolution ----------

    public PreparedQuery Prepare(ChartQuerySpec spec, ModelDefinition model, DatabaseSchema schema, RcdLimits limits)
    {
        if (spec.Measures.Count == 0)
        {
            throw new QueryCompilationException("QRY_NO_MEASURES", "A chart query needs at least one measure.");
        }

        if (spec.Dimensions.Count > limits.MaxDimensions)
        {
            throw new QueryCompilationException("QRY_TOO_MANY_DIMENSIONS", $"At most {limits.MaxDimensions} dimensions are allowed.");
        }

        if (spec.Measures.Count > limits.MaxMeasures)
        {
            throw new QueryCompilationException("QRY_TOO_MANY_MEASURES", $"At most {limits.MaxMeasures} measures are allowed.");
        }

        if (spec.Filters.Count > limits.MaxFilters)
        {
            throw new QueryCompilationException("QRY_TOO_MANY_FILTERS", $"At most {limits.MaxFilters} filters are allowed.");
        }

        schema = AugmentWithDateTables(model, schema);

        var dimensions = spec.Dimensions.Select(d => ResolveDimension(d, model, schema)).ToArray();
        var measures = spec.Measures.Select(m => ResolveMeasure(m, model, schema)).ToArray();
        var filters = spec.Filters.Select(f => ResolveFilter(f.Table, f.Column, f.Operator, f.Values, model, schema, limits)).ToArray();

        var involved = new HashSet<string>(StringComparer.Ordinal);
        foreach (var d in dimensions)
        {
            involved.Add(d.Table.Key);
        }

        foreach (var m in measures)
        {
            involved.Add(m.Table.Key);
            foreach (var f in m.Filters)
            {
                involved.Add(f.Table.Key);
            }

            if (m.Expression is { } expression)
            {
                involved.UnionWith(expression.AggregateTableKeys);
                foreach (var reference in expression.References.Values)
                {
                    involved.Add(reference.Table.Key);
                    foreach (var f in reference.Filters)
                    {
                        involved.Add(f.Table.Key);
                    }
                }
            }
        }

        foreach (var f in filters)
        {
            involved.Add(f.Table.Key);
        }

        var baseTable = measures[0].Table.Key;
        var active = model.Relationships.Where(r => r.IsActive).ToArray();
        var plan = JoinPathResolver.Resolve(baseTable, involved, active, limits.MaxJoins);

        return new PreparedQuery(dimensions, measures, filters, plan, schema, CollectDateTables(model, plan));
    }

    public PreparedDistinctQuery PrepareDistinct(
        DistinctValuesSpec spec, ModelDefinition model, DatabaseSchema schema, RcdLimits limits)
    {
        schema = AugmentWithDateTables(model, schema);

        var (table, column) = ResolveColumn(spec.Table, spec.Column, model, schema);
        EnsureUsable(column, $"Column '{spec.Table}.{spec.Column}'");

        if (!string.IsNullOrEmpty(spec.Search) && column.Type != NormalizedType.Text)
        {
            throw new QueryCompilationException(
                "QRY_BAD_FILTER", $"Search is only supported on text columns; '{spec.Column}' is {column.Type}.");
        }

        var filters = spec.Filters.Select(f => ResolveFilter(f.Table, f.Column, f.Operator, f.Values, model, schema, limits)).ToArray();

        var involved = new HashSet<string>(StringComparer.Ordinal) { table.Key };
        foreach (var f in filters)
        {
            involved.Add(f.Table.Key);
        }

        var active = model.Relationships.Where(r => r.IsActive).ToArray();
        var plan = JoinPathResolver.Resolve(table.Key, involved, active, limits.MaxJoins);

        var limit = Math.Clamp(spec.Limit ?? 100, 1, limits.MaxDistinctValues);

        return new PreparedDistinctQuery(
            table, column, spec.Search, filters, limit, plan, schema, CollectDateTables(model, plan));
    }

    /// <summary>
    /// Date tables become resolvable exactly like catalog tables by appending
    /// their synthesized schemas to the snapshot. Nothing is introspected; the
    /// "#date." key prefix guarantees no collision with real tables.
    /// </summary>
    private static DatabaseSchema AugmentWithDateTables(ModelDefinition model, DatabaseSchema schema)
    {
        if (model.DateTableDefs.Count == 0)
        {
            return schema;
        }

        var synthesized = model.DateTableDefs
            .Where(d => !string.IsNullOrWhiteSpace(d.Name))
            .Select(DateTableSchema.Build);
        return schema with { Tables = [.. schema.Tables, .. synthesized] };
    }

    /// <summary>The date tables the join plan touches, base table first then join order.</summary>
    private static IReadOnlyList<DateTableDef> CollectDateTables(ModelDefinition model, JoinPlan plan)
    {
        if (model.DateTableDefs.Count == 0)
        {
            return [];
        }

        var result = new List<DateTableDef>();
        if (model.FindDateTable(plan.BaseTable) is { } baseDateTable)
        {
            result.Add(baseDateTable);
        }

        foreach (var step in plan.Steps)
        {
            if (model.FindDateTable(step.TableKey) is { } dateTable)
            {
                result.Add(dateTable);
            }
        }

        return result;
    }

    // ---------- Phase 2: emission ----------

    /// <summary>
    /// Emits the final parameterized statement. When <see cref="ChartQuerySpec.TopN"/>
    /// is set, the ranking measure defines the row order and any explicit
    /// <see cref="ChartQuerySpec.Sort"/> is ignored.
    /// </summary>
    public CompiledQuery Emit(
        PreparedQuery prepared,
        ChartQuerySpec spec,
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> rowFiltersByTable,
        RcdLimits limits,
        DataSourceOptions sourceOptions)
    {
        var bag = new ParameterBag();
        var plan = prepared.Plan;
        var warnings = CollectFanOutWarnings(prepared);
        var calendarCtes = BuildCalendarCtes(prepared.CalendarTables, bag);

        var dimensionExprs = prepared.Dimensions
            .Select(d => DimensionExpression(d, plan))
            .ToArray();

        var selectItems = new List<string>();
        for (var i = 0; i < prepared.Dimensions.Count; i++)
        {
            selectItems.Add($"{dimensionExprs[i]} AS {dialect.QuoteIdentifier($"dim{i}")}");
        }

        var measureExprs = new List<string>();
        for (var i = 0; i < prepared.Measures.Count; i++)
        {
            var expr = MeasureExpression(prepared.Measures[i], plan, bag);
            measureExprs.Add(expr);
            selectItems.Add($"{expr} AS {dialect.QuoteIdentifier($"meas{i}")}");
        }

        var whereParts = new List<string>();
        foreach (var filter in prepared.Filters)
        {
            whereParts.Add(BuildPredicate(filter, plan, bag));
        }

        AppendRowFilterPredicates(rowFiltersByTable, plan, prepared.Schema, bag, whereParts);

        var effectiveLimit = EffectiveLimit(spec.Limit, limits, sourceOptions);

        if (spec.TopN is { } topN)
        {
            return EmitTopN(
                prepared, topN, dimensionExprs, selectItems, measureExprs, whereParts, effectiveLimit, bag, warnings, calendarCtes);
        }

        var orderParts = BuildOrderBy(spec, prepared, dimensionExprs);

        var limitPlaceholder = dialect.ParameterPlaceholder(bag.Add((long)(effectiveLimit + 1), NormalizedType.Integer));

        var sql = BuildAggregateCore(selectItems, plan, prepared.Schema, whereParts, dimensionExprs);

        if (orderParts.Count > 0)
        {
            sql.Append('\n').Append("ORDER BY ").Append(string.Join(", ", orderParts));
        }

        sql.Append('\n').Append(dialect.LimitClause(limitPlaceholder));

        return new CompiledQuery(
            CalendarWithPrefix(calendarCtes) + sql, bag.Parameters, BuildColumnPlans(prepared), warnings);
    }

    /// <summary>
    /// Top-N emission. Without "Others" this is the normal aggregate ordered by
    /// the ranking measure (descending, dimension as tie-breaker) limited to N.
    /// With "Others" the aggregate becomes a CTE, rows are ranked with
    /// ROW_NUMBER(), and an outer GROUP BY folds everything past rank N into a
    /// single NULL-dimension bucket. Additive aggregations (Sum/Count/Min/Max)
    /// re-aggregate for the Others row; Avg/CountDistinct cannot and yield NULL
    /// there (with a QRY_OTHERS_UNSUPPORTED_AGG warning) while top rows keep
    /// their exact values because each ranks as its own single-row group.
    /// </summary>
    private CompiledQuery EmitTopN(
        PreparedQuery prepared,
        TopNSpec topN,
        IReadOnlyList<string> dimensionExprs,
        IReadOnlyList<string> selectItems,
        IReadOnlyList<string> measureExprs,
        IReadOnlyList<string> whereParts,
        int effectiveLimit,
        ParameterBag bag,
        List<EngineWarning> warnings,
        IReadOnlyList<string> calendarCtes)
    {
        if (prepared.Dimensions.Count != 1)
        {
            throw new QueryCompilationException(
                "QRY_BAD_TOPN",
                $"Top N applies to a chart with exactly one dimension; this query has {prepared.Dimensions.Count}.");
        }

        if (topN.ByMeasureIndex < 0 || topN.ByMeasureIndex >= prepared.Measures.Count)
        {
            throw new QueryCompilationException(
                "QRY_BAD_SORT", $"Top N ranks by measure {topN.ByMeasureIndex}, which does not exist.");
        }

        var n = Math.Clamp(topN.N, 1, effectiveLimit);
        var plan = prepared.Plan;
        var rankAlias = dialect.QuoteIdentifier($"meas{topN.ByMeasureIndex}");

        if (!topN.IncludeOthers)
        {
            var rankRef = dialect.SupportsSelectAliasInOrderBy ? rankAlias : measureExprs[topN.ByMeasureIndex];
            var limitPlaceholder = dialect.ParameterPlaceholder(bag.Add((long)(n + 1), NormalizedType.Integer));

            var flat = BuildAggregateCore(selectItems, plan, prepared.Schema, whereParts, dimensionExprs);
            flat.Append('\n').Append("ORDER BY ")
                .Append(rankRef).Append(" DESC").Append(dialect.NullsLastSuffix)
                .Append(", ").Append(dimensionExprs[0]).Append(" ASC").Append(dialect.NullsLastSuffix);
            flat.Append('\n').Append(dialect.LimitClause(limitPlaceholder));

            return new CompiledQuery(
                CalendarWithPrefix(calendarCtes) + flat, bag.Parameters, BuildColumnPlans(prepared), warnings);
        }

        var inner = BuildAggregateCore(selectItems, plan, prepared.Schema, whereParts, dimensionExprs);

        var nPlaceholder = dialect.ParameterPlaceholder(bag.Add((long)n, NormalizedType.Integer));
        var outerLimitPlaceholder = dialect.ParameterPlaceholder(bag.Add((long)(effectiveLimit + 1), NormalizedType.Integer));

        var dimAlias = dialect.QuoteIdentifier("dim0");
        var rnAlias = dialect.QuoteIdentifier("rn");
        var isTopAlias = dialect.QuoteIdentifier("is_topn");

        var outerItems = new List<string>
        {
            $"CASE WHEN {rnAlias} <= {nPlaceholder} THEN {dimAlias} END AS {dimAlias}",
            $"({rnAlias} <= {nPlaceholder}) AS {isTopAlias}",
        };

        for (var i = 0; i < prepared.Measures.Count; i++)
        {
            var measure = prepared.Measures[i];
            var measAlias = dialect.QuoteIdentifier($"meas{i}");
            string expr;
            if (measure.Expression is not null)
            {
                // Calculated measures compose aggregates and are never
                // re-aggregatable: pass top rows through, leave Others NULL.
                expr = dialect.Aggregate(
                    Aggregation.Sum, $"CASE WHEN {rnAlias} <= {nPlaceholder} THEN {measAlias} END");
                warnings.Add(new EngineWarning(
                    "QRY_OTHERS_UNSUPPORTED_AGG",
                    $"Measure '{measure.Label}' is a calculated expression, which cannot be combined into an 'Others' bucket; the Others row has no value for it."));
            }
            else
            {
                switch (measure.Aggregation)
                {
                    case Aggregation.Sum:
                    case Aggregation.Count:
                        expr = dialect.Aggregate(Aggregation.Sum, measAlias);
                        break;
                    case Aggregation.Min:
                        expr = dialect.Aggregate(Aggregation.Min, measAlias);
                        break;
                    case Aggregation.Max:
                        expr = dialect.Aggregate(Aggregation.Max, measAlias);
                        break;
                    default:
                        // Avg / CountDistinct are not re-aggregatable. Top rows are
                        // single-row groups, so SUM passes their exact value through;
                        // the Others row sums only NULLs and stays NULL.
                        expr = dialect.Aggregate(
                            Aggregation.Sum, $"CASE WHEN {rnAlias} <= {nPlaceholder} THEN {measAlias} END");
                        warnings.Add(new EngineWarning(
                            "QRY_OTHERS_UNSUPPORTED_AGG",
                            $"Measure '{measure.Label}' uses {measure.Aggregation}, which cannot be combined into an 'Others' bucket; the Others row has no value for it."));
                        break;
                }
            }

            outerItems.Add($"{expr} AS {measAlias}");
        }

        var sql = new StringBuilder();
        sql.Append("WITH ");
        foreach (var calendarCte in calendarCtes)
        {
            sql.Append(calendarCte).Append(",\n");
        }

        sql.Append(dialect.QuoteIdentifier("base")).Append(" AS (\n");
        sql.Append(inner);
        sql.Append("\n),\n");
        sql.Append(dialect.QuoteIdentifier("ranked")).Append(" AS (\n");
        sql.Append("SELECT *, ROW_NUMBER() OVER (ORDER BY ")
            .Append(rankAlias).Append(" DESC").Append(dialect.NullsLastSuffix)
            .Append(", ").Append(dimAlias).Append(" ASC").Append(dialect.NullsLastSuffix)
            .Append(") AS ").Append(rnAlias);
        sql.Append('\n').Append("FROM ").Append(dialect.QuoteIdentifier("base"));
        sql.Append("\n)\n");
        sql.Append("SELECT ").Append(string.Join(",\n       ", outerItems));
        sql.Append('\n').Append("FROM ").Append(dialect.QuoteIdentifier("ranked"));
        sql.Append('\n').Append("GROUP BY 1, 2");
        sql.Append('\n').Append("ORDER BY ").Append(isTopAlias).Append(" DESC, ")
            .Append(rankAlias).Append(" DESC").Append(dialect.NullsLastSuffix);
        sql.Append('\n').Append(dialect.LimitClause(outerLimitPlaceholder));

        return new CompiledQuery(sql.ToString(), bag.Parameters, BuildColumnPlans(prepared, includeIsTopN: true), warnings);
    }

    public CompiledQuery EmitDistinct(
        PreparedDistinctQuery prepared,
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> rowFiltersByTable)
    {
        var bag = new ParameterBag();
        var plan = prepared.Plan;
        var calendarCtes = BuildCalendarCtes(prepared.CalendarTables, bag);
        var expr = QualifiedColumn(plan.AliasByTable[prepared.Table.Key], prepared.Column.Name);

        var whereParts = new List<string>();
        foreach (var filter in prepared.Filters)
        {
            whereParts.Add(BuildPredicate(filter, plan, bag));
        }

        if (!string.IsNullOrEmpty(prepared.Search))
        {
            var pattern = $"%{EscapeLikePattern(prepared.Search)}%";
            var placeholder = dialect.ParameterPlaceholder(bag.Add(pattern, NormalizedType.Text));
            whereParts.Add(dialect.CaseInsensitiveLike(expr, placeholder));
        }

        AppendRowFilterPredicates(rowFiltersByTable, plan, prepared.Schema, bag, whereParts);

        var limitPlaceholder = dialect.ParameterPlaceholder(bag.Add((long)(prepared.Limit + 1), NormalizedType.Integer));

        var sql = new StringBuilder();
        sql.Append("SELECT DISTINCT ").Append(expr).Append(" AS ").Append(dialect.QuoteIdentifier("value"));
        sql.Append('\n').Append("FROM ").Append(FromClause(plan, prepared.Schema));
        AppendJoins(sql, plan, prepared.Schema);

        if (whereParts.Count > 0)
        {
            sql.Append('\n').Append("WHERE ").Append(string.Join("\n  AND ", whereParts));
        }

        sql.Append('\n').Append("ORDER BY ").Append(expr).Append(" ASC").Append(dialect.NullsLastSuffix);
        sql.Append('\n').Append(dialect.LimitClause(limitPlaceholder));

        var columns = new[]
        {
            new ResultColumnPlan("value", prepared.Column.Name, ResultColumnRole.Dimension,
                prepared.Column.Type, $"{prepared.Table.Key}.{prepared.Column.Name}", null, null),
        };

        return new CompiledQuery(CalendarWithPrefix(calendarCtes) + sql, bag.Parameters, columns, Warnings: []);
    }

    // ---------- date-table emission ----------

    /// <summary>
    /// One rendered CTE per referenced date table ("dt_{name}" AS (SELECT ...)).
    /// Both range ends are ALWAYS parameters — defaults are computed here from
    /// the injected clock, so statement text stays constant.
    /// </summary>
    private List<string> BuildCalendarCtes(IReadOnlyList<DateTableDef> dateTables, ParameterBag bag)
    {
        var ctes = new List<string>(dateTables.Count);
        foreach (var dateTable in dateTables)
        {
            var start = dateTable.RangeStart ?? DateTableSchema.DefaultRangeStart;
            var end = dateTable.RangeEnd ?? DateTableSchema.DefaultRangeEnd(_clock);
            var startPlaceholder = dialect.ParameterPlaceholder(bag.Add(start, NormalizedType.Date));
            var endPlaceholder = dialect.ParameterPlaceholder(bag.Add(end, NormalizedType.Date));
            ctes.Add(
                $"{dialect.QuoteIdentifier(DateTableSchema.CteName(dateTable))} AS (\n{dialect.CalendarTableSql(startPlaceholder, endPlaceholder)}\n)");
        }

        return ctes;
    }

    private static string CalendarWithPrefix(IReadOnlyList<string> calendarCtes) =>
        calendarCtes.Count == 0 ? "" : $"WITH {string.Join(",\n", calendarCtes)}\n";

    // ---------- resolution helpers ----------

    private static (TableSchema Table, ColumnSchema Column) ResolveColumn(
        string tableKey, string columnName, ModelDefinition model, DatabaseSchema schema)
    {
        if (!model.ContainsTable(tableKey))
        {
            throw new QueryCompilationException("QRY_UNKNOWN_TABLE", $"Table '{tableKey}' is not part of the model.");
        }

        var table = schema.FindTable(tableKey)
            ?? throw new QueryCompilationException(
                "QRY_UNKNOWN_TABLE", $"Table '{tableKey}' no longer exists in the data source.");

        var column = table.FindColumn(columnName)
            ?? throw new QueryCompilationException(
                "QRY_UNKNOWN_COLUMN", $"Column '{columnName}' does not exist on '{tableKey}'.");

        return (table, column);
    }

    private static void EnsureUsable(ColumnSchema column, string context)
    {
        if (column.Type is NormalizedType.Other or NormalizedType.Json)
        {
            throw new QueryCompilationException(
                "QRY_BAD_COLUMN", $"{context} has type {column.Type} ({column.RawType}) and cannot be used here.");
        }
    }

    private ResolvedDimension ResolveDimension(DimensionSpec spec, ModelDefinition model, DatabaseSchema schema)
    {
        var (table, column) = ResolveColumn(spec.Table, spec.Column, model, schema);
        EnsureUsable(column, $"Column '{spec.Table}.{spec.Column}'");

        if (spec.DateBucket is not null && column.Type is not (NormalizedType.Date or NormalizedType.Timestamp))
        {
            throw new QueryCompilationException(
                "QRY_BAD_BUCKET",
                $"'{spec.Table}.{spec.Column}' is {column.Type}; date bucketing needs a date or timestamp column.");
        }

        var overrideColumn = model.FindTable(spec.Table)?.ColumnOverrides
            .FirstOrDefault(c => string.Equals(c.Name, spec.Column, StringComparison.Ordinal));
        var label = overrideColumn?.FriendlyName ?? column.Name;
        if (spec.DateBucket is { } bucket)
        {
            label = $"{label} ({bucket})";
        }

        return new ResolvedDimension(spec, table, column, label, overrideColumn?.FormatHint);
    }

    private ResolvedMeasure ResolveMeasure(MeasureSpec spec, ModelDefinition model, DatabaseSchema schema)
    {
        if (spec.MeasureId is { } measureId)
        {
            var measure = model.Measures.FirstOrDefault(m => m.Id == measureId)
                ?? throw new QueryCompilationException(
                    "QRY_UNKNOWN_MEASURE", $"The model has no measure with id {measureId}.");
            if (measure.Expression is not null)
            {
                return ResolveExpressionMeasure(measure, model, schema);
            }

            return ResolveMeasureCore(
                measure.Name, measure.Table, measure.Aggregation, measure.Column,
                measure.MeasureFilters, measure.FormatHint, model, schema);
        }

        if (spec.Table is null || spec.Aggregation is null)
        {
            throw new QueryCompilationException(
                "QRY_BAD_MEASURE", "An inline measure needs a table and an aggregation (or reference a model measure by id).");
        }

        var label = spec.Alias
            ?? (spec.Column is null ? $"{spec.Aggregation}" : $"{spec.Aggregation} of {spec.Column}");
        return ResolveMeasureCore(label, spec.Table, spec.Aggregation.Value, spec.Column, [], null, model, schema);
    }

    /// <summary>
    /// Resolves a calculated measure: parse (QRY_BAD_MEASURE on failure), then
    /// resolve every aggregate call against the catalog and every [reference]
    /// against the model's plain measures. Nothing unresolved survives — that
    /// is the security bar for expressions.
    /// </summary>
    private ResolvedMeasure ResolveExpressionMeasure(Measure measure, ModelDefinition model, DatabaseSchema schema)
    {
        if (measure.Column is not null)
        {
            throw new QueryCompilationException(
                "QRY_BAD_MEASURE", $"Measure '{measure.Name}' is expression-based and may not also set a source column.");
        }

        if (model.FindTable(measure.Table) is null)
        {
            throw new QueryCompilationException("QRY_UNKNOWN_TABLE", $"Table '{measure.Table}' is not part of the model.");
        }

        var table = schema.FindTable(measure.Table)
            ?? throw new QueryCompilationException(
                "QRY_UNKNOWN_TABLE", $"Table '{measure.Table}' no longer exists in the data source.");

        MeasureExprNode root;
        try
        {
            root = MeasureExpressionParser.Parse(measure.Expression!);
        }
        catch (MeasureExpressionParseException ex)
        {
            throw new QueryCompilationException("QRY_BAD_MEASURE", $"Measure '{measure.Name}': {ex.Message}");
        }

        var aggregateTables = new List<string>();
        var references = new Dictionary<string, ResolvedMeasure>(StringComparer.Ordinal);

        foreach (var node in MeasureExpressionParser.Flatten(root))
        {
            switch (node)
            {
                case AggregateCallNode { TableKey: { } tableKey } call:
                    if (model.FindTable(tableKey) is null)
                    {
                        throw new QueryCompilationException(
                            "QRY_UNKNOWN_TABLE",
                            $"Measure '{measure.Name}' expression references table '{tableKey}', which is not part of the model.");
                    }

                    var callTable = schema.FindTable(tableKey)
                        ?? throw new QueryCompilationException(
                            "QRY_UNKNOWN_TABLE", $"Table '{tableKey}' no longer exists in the data source.");
                    var callColumn = callTable.FindColumn(call.Column!)
                        ?? throw new QueryCompilationException(
                            "QRY_UNKNOWN_COLUMN",
                            $"Measure '{measure.Name}' expression references column '{call.Column}', which does not exist on '{tableKey}'.");
                    if (!IsAggregationCompatible(call.Aggregation, callColumn.Type))
                    {
                        throw new QueryCompilationException(
                            "QRY_BAD_MEASURE",
                            $"Measure '{measure.Name}' expression: {call.Aggregation} is not valid for column '{call.Column}' of type {callColumn.Type}.");
                    }

                    if (!aggregateTables.Contains(tableKey))
                    {
                        aggregateTables.Add(tableKey);
                    }

                    break;

                case MeasureRefNode reference when !references.ContainsKey(reference.Name):
                    var (target, ambiguous) = MeasureExpressionParser.ResolveMeasureRef(model, reference.Name);
                    if (ambiguous)
                    {
                        throw new QueryCompilationException(
                            "QRY_BAD_MEASURE",
                            $"Measure '{measure.Name}' expression reference '[{reference.Name}]' matches more than one model measure.");
                    }

                    if (target is null)
                    {
                        throw new QueryCompilationException(
                            "QRY_BAD_MEASURE",
                            $"Measure '{measure.Name}' expression references measure '[{reference.Name}]', which does not exist.");
                    }

                    if (target.Expression is not null)
                    {
                        throw new QueryCompilationException(
                            "QRY_BAD_MEASURE",
                            $"Measure '{measure.Name}' expression references '[{reference.Name}]', which is itself expression-based; expression measures may only reference plain aggregation measures.");
                    }

                    references[reference.Name] = ResolveMeasureCore(
                        target.Name, target.Table, target.Aggregation, target.Column,
                        target.MeasureFilters, target.FormatHint, model, schema);
                    break;
            }
        }

        var resolvedFilters = measure.MeasureFilters
            .Select(f => ResolveFilterUnbounded(f.Table, f.Column, f.Operator, f.Values, model, schema))
            .ToArray();

        return new ResolvedMeasure(
            measure.Name, table, measure.Aggregation, Column: null, resolvedFilters, measure.FormatHint,
            new ResolvedMeasureExpression(root, aggregateTables, references));
    }

    private ResolvedMeasure ResolveMeasureCore(
        string label,
        string tableKey,
        Aggregation aggregation,
        string? columnName,
        IReadOnlyList<FilterSpec> filters,
        string? formatHint,
        ModelDefinition model,
        DatabaseSchema schema)
    {
        if (model.FindTable(tableKey) is null)
        {
            throw new QueryCompilationException("QRY_UNKNOWN_TABLE", $"Table '{tableKey}' is not part of the model.");
        }

        var table = schema.FindTable(tableKey)
            ?? throw new QueryCompilationException(
                "QRY_UNKNOWN_TABLE", $"Table '{tableKey}' no longer exists in the data source.");

        ColumnSchema? column = null;
        if (columnName is not null)
        {
            column = table.FindColumn(columnName)
                ?? throw new QueryCompilationException(
                    "QRY_UNKNOWN_COLUMN", $"Column '{columnName}' does not exist on '{tableKey}'.");
            if (!IsAggregationCompatible(aggregation, column.Type))
            {
                throw new QueryCompilationException(
                    "QRY_BAD_MEASURE", $"{aggregation} is not valid for column '{columnName}' of type {column.Type}.");
            }
        }
        else if (aggregation != Aggregation.Count)
        {
            throw new QueryCompilationException(
                "QRY_BAD_MEASURE", $"Only Count may omit the source column; {aggregation} needs one.");
        }

        var resolvedFilters = filters
            .Select(f => ResolveFilterUnbounded(f.Table, f.Column, f.Operator, f.Values, model, schema))
            .ToArray();

        return new ResolvedMeasure(label, table, aggregation, column, resolvedFilters, formatHint);
    }

    private ResolvedFilter ResolveFilter(
        string tableKey, string columnName, FilterOperator op, IReadOnlyList<JsonElement> values,
        ModelDefinition model, DatabaseSchema schema, RcdLimits limits)
    {
        var filter = ResolveFilterUnbounded(tableKey, columnName, op, values, model, schema);
        if (op is FilterOperator.In or FilterOperator.NotIn && values.Count > limits.MaxInValues)
        {
            throw new QueryCompilationException(
                "QRY_TOO_MANY_VALUES", $"At most {limits.MaxInValues} values are allowed in one IN filter.");
        }

        return filter;
    }

    private ResolvedFilter ResolveFilterUnbounded(
        string tableKey, string columnName, FilterOperator op, IReadOnlyList<JsonElement> values,
        ModelDefinition model, DatabaseSchema schema)
    {
        var (table, column) = ResolveColumn(tableKey, columnName, model, schema);
        EnsureUsable(column, $"Filter column '{tableKey}.{columnName}'");

        var context = $"Filter on '{tableKey}.{columnName}'";
        var arity = op switch
        {
            FilterOperator.IsNull or FilterOperator.NotNull => 0,
            FilterOperator.Between => 2,
            FilterOperator.In or FilterOperator.NotIn => -1, // one or more
            _ => 1,
        };

        var valid = arity switch
        {
            -1 => values.Count >= 1,
            _ => values.Count == arity,
        };
        if (!valid)
        {
            throw new QueryCompilationException(
                "QRY_BAD_FILTER", $"{context}: operator {op} expects {(arity == -1 ? "at least one" : arity.ToString())} value(s), got {values.Count}.");
        }

        if (op is FilterOperator.Contains or FilterOperator.StartsWith && column.Type != NormalizedType.Text)
        {
            throw new QueryCompilationException(
                "QRY_BAD_FILTER", $"{context}: {op} only applies to text columns; '{columnName}' is {column.Type}.");
        }

        return new ResolvedFilter(table, column, op, values);
    }

    private static bool IsAggregationCompatible(Aggregation aggregation, NormalizedType type)
    {
        if (type == NormalizedType.Other)
        {
            return false;
        }

        return aggregation switch
        {
            Aggregation.Sum or Aggregation.Avg => type is NormalizedType.Integer or NormalizedType.Decimal,
            Aggregation.Min or Aggregation.Max => type is NormalizedType.Integer or NormalizedType.Decimal
                or NormalizedType.Date or NormalizedType.Timestamp or NormalizedType.Text,
            Aggregation.Count or Aggregation.CountDistinct => true,
            _ => false,
        };
    }

    // ---------- emission helpers ----------

    private string QualifiedColumn(string alias, string columnName) =>
        $"{dialect.QuoteIdentifier(alias)}.{dialect.QuoteIdentifier(columnName)}";

    private string QualifiedTable(TableSchema table) =>
        $"{dialect.QuoteIdentifier(table.Schema)}.{dialect.QuoteIdentifier(table.Name)}";

    /// <summary>Real tables are schema-qualified; virtual date tables reference their calendar CTE.</summary>
    private string TableSource(TableSchema table) =>
        string.Equals(table.Schema, DateTableSchema.SchemaName, StringComparison.Ordinal)
            ? dialect.QuoteIdentifier("dt_" + table.Name)
            : QualifiedTable(table);

    private string FromClause(JoinPlan plan, DatabaseSchema schema)
    {
        var baseTable = schema.FindTable(plan.BaseTable)!;
        return $"{TableSource(baseTable)} AS {dialect.QuoteIdentifier("t0")}";
    }

    private void AppendJoins(StringBuilder sql, JoinPlan plan, DatabaseSchema schema)
    {
        foreach (var step in plan.Steps)
        {
            var child = schema.FindTable(step.TableKey)!;
            var childAlias = plan.AliasByTable[step.TableKey];
            var fromSide = QualifiedColumn(plan.AliasByTable[step.Via.FromTable], step.Via.FromColumn);
            var toSide = QualifiedColumn(plan.AliasByTable[step.Via.ToTable], step.Via.ToColumn);

            // Timestamp columns join a date table's date_key at day grain.
            if (DateTableSchema.IsDateTableKey(step.Via.ToTable)
                && schema.FindTable(step.Via.FromTable)?.FindColumn(step.Via.FromColumn)?.Type == NormalizedType.Timestamp)
            {
                fromSide = dialect.CastToDate(fromSide);
            }

            sql.Append('\n')
                .Append("LEFT JOIN ").Append(TableSource(child))
                .Append(" AS ").Append(dialect.QuoteIdentifier(childAlias))
                .Append(" ON ").Append(fromSide).Append(" = ").Append(toSide);
        }
    }

    /// <summary>SELECT ... FROM ... JOINs ... WHERE ... GROUP BY — no ORDER BY or LIMIT.</summary>
    private StringBuilder BuildAggregateCore(
        IReadOnlyList<string> selectItems,
        JoinPlan plan,
        DatabaseSchema schema,
        IReadOnlyList<string> whereParts,
        IReadOnlyList<string> groupByExprs)
    {
        var sql = new StringBuilder();
        sql.Append("SELECT ").Append(string.Join(",\n       ", selectItems));
        sql.Append('\n').Append("FROM ").Append(FromClause(plan, schema));
        AppendJoins(sql, plan, schema);

        if (whereParts.Count > 0)
        {
            sql.Append('\n').Append("WHERE ").Append(string.Join("\n  AND ", whereParts));
        }

        if (groupByExprs.Count > 0)
        {
            sql.Append('\n').Append("GROUP BY ").Append(string.Join(", ", groupByExprs));
        }

        return sql;
    }

    /// <summary>
    /// A LEFT JOIN whose child table is the MANY side of its relationship
    /// multiplies the rows of every table outside that child's subtree; any
    /// aggregate over those tables may be over-counted. The standard star case
    /// (base fact joins ONE-side dimension tables) never warns.
    /// </summary>
    private static List<EngineWarning> CollectFanOutWarnings(PreparedQuery prepared)
    {
        var warnings = new List<EngineWarning>();
        if (prepared.Plan.Steps.Count == 0)
        {
            return warnings;
        }

        var parentOf = prepared.Plan.Steps.ToDictionary(
            s => s.TableKey, s => s.ParentTableKey, StringComparer.Ordinal);
        var seen = new HashSet<(int Measure, string Child)>();

        foreach (var step in prepared.Plan.Steps)
        {
            // Fan-out needs a many-to-one edge entered from its ONE side: the
            // joined child is the relationship's FromTable (the many side).
            // One-to-one edges never multiply rows.
            if (step.Via.Cardinality != Cardinality.ManyToOne
                || !string.Equals(step.TableKey, step.Via.FromTable, StringComparison.Ordinal))
            {
                continue;
            }

            for (var i = 0; i < prepared.Measures.Count; i++)
            {
                var measure = prepared.Measures[i];
                if (IsInSubtree(measure.Table.Key, step.TableKey, parentOf) || !seen.Add((i, step.TableKey)))
                {
                    continue;
                }

                warnings.Add(new EngineWarning(
                    "QRY_FANOUT",
                    $"Measure '{measure.Label}' may be over-counted: joining '{step.TableKey}' multiplies rows of '{measure.Table.Key}' (relationship {step.Via.FromTable}->{step.Via.ToTable})."));
            }
        }

        return warnings;
    }

    /// <summary>True when walking the join-plan parent chain from <paramref name="table"/> reaches <paramref name="root"/>.</summary>
    private static bool IsInSubtree(string table, string root, IReadOnlyDictionary<string, string> parentOf)
    {
        var walk = table;
        while (true)
        {
            if (string.Equals(walk, root, StringComparison.Ordinal))
            {
                return true;
            }

            if (!parentOf.TryGetValue(walk, out var parent))
            {
                return false; // reached the base table
            }

            walk = parent;
        }
    }

    private string DimensionExpression(ResolvedDimension dimension, JoinPlan plan)
    {
        var expr = QualifiedColumn(plan.AliasByTable[dimension.Table.Key], dimension.Column.Name);
        return dimension.Spec.DateBucket is { } bucket ? dialect.DateTrunc(bucket, expr) : expr;
    }

    private string MeasureExpression(ResolvedMeasure measure, JoinPlan plan, ParameterBag bag) =>
        measure.Expression is { } expression
            ? ExpressionSql(expression.Root, expression, measure.Filters, plan, bag)
            : AggregateWithFilters(
                dialect.Aggregate(measure.Aggregation, AggregateArgument(measure, plan)),
                measure.Filters, plan, bag);

    private string? AggregateArgument(ResolvedMeasure measure, JoinPlan plan) =>
        measure.Column is null
            ? null
            : QualifiedColumn(plan.AliasByTable[measure.Table.Key], measure.Column.Name);

    private string AggregateWithFilters(
        string aggregate, IReadOnlyList<ResolvedFilter> filters, JoinPlan plan, ParameterBag bag)
    {
        if (filters.Count == 0)
        {
            return aggregate;
        }

        var predicate = string.Join(" AND ", filters.Select(f => BuildPredicate(f, plan, bag)));
        return dialect.AggregateFilter(aggregate, predicate);
    }

    /// <summary>
    /// Renders a calculated measure's AST. Arithmetic is parenthesized per
    /// node, division is NULLIF-guarded, aggregate calls render through the
    /// dialect with plan aliases, and [references] substitute the referenced
    /// measure's aggregate SQL. The expression measure's own filters apply to
    /// every aggregate it renders (combined with a reference's own filters).
    /// </summary>
    private string ExpressionSql(
        MeasureExprNode node,
        ResolvedMeasureExpression expression,
        IReadOnlyList<ResolvedFilter> outerFilters,
        JoinPlan plan,
        ParameterBag bag)
    {
        switch (node)
        {
            case NumberLiteralNode number:
                return number.Literal;

            case UnaryMinusNode unary:
                return $"(-{ExpressionSql(unary.Operand, expression, outerFilters, plan, bag)})";

            case BinaryNode binary:
                var left = ExpressionSql(binary.Left, expression, outerFilters, plan, bag);
                var right = ExpressionSql(binary.Right, expression, outerFilters, plan, bag);
                return binary.Operator == '/'
                    ? $"({left} / NULLIF({right}, 0))"
                    : $"({left} {binary.Operator} {right})";

            case AggregateCallNode call:
                var argument = call.Column is null
                    ? null
                    : QualifiedColumn(plan.AliasByTable[call.TableKey!], call.Column);
                return AggregateWithFilters(dialect.Aggregate(call.Aggregation, argument), outerFilters, plan, bag);

            case MeasureRefNode reference:
                var target = expression.References[reference.Name];
                IReadOnlyList<ResolvedFilter> combined = outerFilters.Count == 0
                    ? target.Filters
                    : [.. target.Filters, .. outerFilters];
                return AggregateWithFilters(
                    dialect.Aggregate(target.Aggregation, AggregateArgument(target, plan)), combined, plan, bag);

            default:
                throw new InvalidOperationException($"Unknown expression node {node.GetType().Name}.");
        }
    }

    private string BuildPredicate(ResolvedFilter filter, JoinPlan plan, ParameterBag bag)
    {
        var expr = QualifiedColumn(plan.AliasByTable[filter.Table.Key], filter.Column.Name);
        var context = $"Filter on '{filter.Table.Key}.{filter.Column.Name}'";

        string Placeholder(int index) =>
            dialect.ParameterPlaceholder(
                bag.Add(SpecValueConverter.Convert(filter.Values[index], filter.Column.Type, context), filter.Column.Type));

        switch (filter.Operator)
        {
            case FilterOperator.Eq:
                return $"{expr} = {Placeholder(0)}";
            case FilterOperator.Neq:
                return $"{expr} <> {Placeholder(0)}";
            case FilterOperator.Gt:
                return $"{expr} > {Placeholder(0)}";
            case FilterOperator.Gte:
                return $"{expr} >= {Placeholder(0)}";
            case FilterOperator.Lt:
                return $"{expr} < {Placeholder(0)}";
            case FilterOperator.Lte:
                return $"{expr} <= {Placeholder(0)}";
            case FilterOperator.Between:
                return $"({expr} >= {Placeholder(0)} AND {expr} <= {Placeholder(1)})";
            case FilterOperator.In:
            case FilterOperator.NotIn:
                var converted = filter.Values
                    .Select(v => (object?)SpecValueConverter.Convert(v, filter.Column.Type, context))
                    .ToArray();
                return dialect.InPredicate(expr, filter.Operator == FilterOperator.NotIn, converted, filter.Column.Type, bag);
            case FilterOperator.Contains:
            case FilterOperator.StartsWith:
                var text = SpecValueConverter.Convert(filter.Values[0], NormalizedType.Text, context) as string ?? "";
                var pattern = filter.Operator == FilterOperator.Contains
                    ? $"%{EscapeLikePattern(text)}%"
                    : $"{EscapeLikePattern(text)}%";
                var patternPlaceholder = dialect.ParameterPlaceholder(bag.Add(pattern, NormalizedType.Text));
                return dialect.CaseInsensitiveLike(expr, patternPlaceholder);
            case FilterOperator.IsNull:
                return $"{expr} IS NULL";
            case FilterOperator.NotNull:
                return $"{expr} IS NOT NULL";
            default:
                throw new QueryCompilationException("QRY_BAD_FILTER", $"{context}: unsupported operator.");
        }
    }

    private void AppendRowFilterPredicates(
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> rowFiltersByTable,
        JoinPlan plan,
        DatabaseSchema schema,
        ParameterBag bag,
        List<string> whereParts)
    {
        foreach (var (tableKey, rowFilters) in rowFiltersByTable.OrderBy(kvp => kvp.Key, StringComparer.Ordinal))
        {
            if (rowFilters.Count == 0 || !plan.AliasByTable.TryGetValue(tableKey, out var alias))
            {
                continue;
            }

            var table = schema.FindTable(tableKey)!;
            foreach (var rowFilter in rowFilters)
            {
                var column = table.FindColumn(rowFilter.ColumnName)
                    ?? throw new QueryCompilationException(
                        "QRY_UNKNOWN_COLUMN",
                        $"Row-level scoping references column '{rowFilter.ColumnName}' which does not exist on '{tableKey}'.");

                var expr = QualifiedColumn(alias, column.Name);
                whereParts.Add(rowFilter.Operator switch
                {
                    RowFilterOperator.Equals =>
                        $"{expr} = {dialect.ParameterPlaceholder(bag.Add(rowFilter.Values[0], column.Type))}",
                    RowFilterOperator.In =>
                        dialect.InPredicate(expr, negated: false, rowFilter.Values, column.Type, bag),
                    RowFilterOperator.IsNull => $"{expr} IS NULL",
                    _ => throw new QueryCompilationException("QRY_BAD_FILTER", "Unsupported row filter operator."),
                });
            }
        }
    }

    private List<string> BuildOrderBy(
        ChartQuerySpec spec, PreparedQuery prepared, IReadOnlyList<string> dimensionExprs)
    {
        var parts = new List<string>();
        var sortedDimensionIndexes = new HashSet<int>();

        foreach (var sort in spec.Sort)
        {
            var direction = sort.Direction == SortDirection.Desc ? "DESC" : "ASC";
            if (sort.Target.Kind == SortTargetKind.Dimension)
            {
                if (sort.Target.Index < 0 || sort.Target.Index >= prepared.Dimensions.Count)
                {
                    throw new QueryCompilationException("QRY_BAD_SORT", $"Sort references dimension {sort.Target.Index}, which does not exist.");
                }

                parts.Add($"{dimensionExprs[sort.Target.Index]} {direction}{dialect.NullsLastSuffix}");
                sortedDimensionIndexes.Add(sort.Target.Index);
            }
            else
            {
                if (sort.Target.Index < 0 || sort.Target.Index >= prepared.Measures.Count)
                {
                    throw new QueryCompilationException("QRY_BAD_SORT", $"Sort references measure {sort.Target.Index}, which does not exist.");
                }

                var measureRef = dialect.SupportsSelectAliasInOrderBy
                    ? dialect.QuoteIdentifier($"meas{sort.Target.Index}")
                    : $"meas{sort.Target.Index}"; // future dialects re-emit the aggregate expression
                parts.Add($"{measureRef} {direction}{dialect.NullsLastSuffix}");
            }
        }

        if (parts.Count == 0 && prepared.Dimensions.Count > 0)
        {
            // Default: time first (natural for series), then remaining dimensions.
            var ordered = Enumerable.Range(0, prepared.Dimensions.Count)
                .OrderByDescending(i => prepared.Dimensions[i].Spec.DateBucket is not null)
                .ThenBy(i => i);
            foreach (var i in ordered)
            {
                parts.Add($"{dimensionExprs[i]} ASC{dialect.NullsLastSuffix}");
                sortedDimensionIndexes.Add(i);
            }
        }
        else if (parts.Count > 0)
        {
            // Deterministic total order: remaining dimensions as tie-breakers.
            for (var i = 0; i < prepared.Dimensions.Count; i++)
            {
                if (!sortedDimensionIndexes.Contains(i))
                {
                    parts.Add($"{dimensionExprs[i]} ASC{dialect.NullsLastSuffix}");
                }
            }
        }

        return parts;
    }

    private static int EffectiveLimit(int? requested, RcdLimits limits, DataSourceOptions sourceOptions)
    {
        var cap = Math.Min(limits.MaxRows, sourceOptions.MaxRows);
        return requested is { } r && r > 0 ? Math.Min(r, cap) : cap;
    }

    private static string EscapeLikePattern(string value) =>
        value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");

    private static IReadOnlyList<ResultColumnPlan> BuildColumnPlans(PreparedQuery prepared, bool includeIsTopN = false)
    {
        var columns = new List<ResultColumnPlan>();
        for (var i = 0; i < prepared.Dimensions.Count; i++)
        {
            var d = prepared.Dimensions[i];
            columns.Add(new ResultColumnPlan(
                $"dim{i}", d.Label, ResultColumnRole.Dimension, d.Column.Type,
                $"{d.Table.Key}.{d.Column.Name}", d.Spec.DateBucket, d.FormatHint));
        }

        if (includeIsTopN)
        {
            columns.Add(new ResultColumnPlan(
                "is_topn", "Is Top N", ResultColumnRole.Dimension, NormalizedType.Boolean,
                Source: null, DateBucket: null, FormatHint: null));
        }

        for (var i = 0; i < prepared.Measures.Count; i++)
        {
            var m = prepared.Measures[i];
            var type = m.Expression is not null
                ? NormalizedType.Decimal // arithmetic (esp. division) promotes
                : m.Aggregation is Aggregation.Count or Aggregation.CountDistinct
                    ? NormalizedType.Integer
                    : m.Aggregation == Aggregation.Avg
                        ? NormalizedType.Decimal
                        : m.Column?.Type ?? NormalizedType.Integer;
            columns.Add(new ResultColumnPlan(
                $"meas{i}", m.Label, ResultColumnRole.Measure, type,
                m.Column is null ? null : $"{m.Table.Key}.{m.Column.Name}", null, m.FormatHint));
        }

        return columns;
    }
}
