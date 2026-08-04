using System.Text;
using System.Text.Json;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Querying.Compilation;

public sealed record ResolvedDimension(DimensionSpec Spec, TableSchema Table, ColumnSchema Column, string Label, string? FormatHint);

public sealed record ResolvedMeasure(string Label, TableSchema Table, Aggregation Aggregation, ColumnSchema? Column, IReadOnlyList<ResolvedFilter> Filters, string? FormatHint);

public sealed record ResolvedFilter(TableSchema Table, ColumnSchema Column, FilterOperator Operator, IReadOnlyList<JsonElement> Values);

/// <summary>Output of the resolution phase; row filters are collected against Plan.Tables before Emit.</summary>
public sealed record PreparedQuery(
    IReadOnlyList<ResolvedDimension> Dimensions,
    IReadOnlyList<ResolvedMeasure> Measures,
    IReadOnlyList<ResolvedFilter> Filters,
    JoinPlan Plan,
    DatabaseSchema Schema);

public sealed record PreparedDistinctQuery(
    TableSchema Table,
    ColumnSchema Column,
    string? Search,
    IReadOnlyList<ResolvedFilter> Filters,
    int Limit,
    JoinPlan Plan,
    DatabaseSchema Schema);

/// <summary>
/// Spec + model + catalog snapshot -> parameterized single-statement SELECT.
/// Every identifier in the output is resolved from the snapshot then
/// dialect-quoted; every value is a parameter. No client string ever reaches
/// SQL text.
/// </summary>
public sealed class QueryCompiler(ISqlDialect dialect)
{
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
        }

        foreach (var f in filters)
        {
            involved.Add(f.Table.Key);
        }

        var baseTable = measures[0].Table.Key;
        var active = model.Relationships.Where(r => r.IsActive).ToArray();
        var plan = JoinPathResolver.Resolve(baseTable, involved, active, limits.MaxJoins);

        return new PreparedQuery(dimensions, measures, filters, plan, schema);
    }

    public PreparedDistinctQuery PrepareDistinct(
        DistinctValuesSpec spec, ModelDefinition model, DatabaseSchema schema, RcdLimits limits)
    {
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

        return new PreparedDistinctQuery(table, column, spec.Search, filters, limit, plan, schema);
    }

    // ---------- Phase 2: emission ----------

    public CompiledQuery Emit(
        PreparedQuery prepared,
        ChartQuerySpec spec,
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> rowFiltersByTable,
        RcdLimits limits,
        DataSourceOptions sourceOptions)
    {
        var bag = new ParameterBag();
        var plan = prepared.Plan;

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

        var orderParts = BuildOrderBy(spec, prepared, dimensionExprs);

        var effectiveLimit = EffectiveLimit(spec.Limit, limits, sourceOptions);
        var limitPlaceholder = dialect.ParameterPlaceholder(bag.Add((long)(effectiveLimit + 1), NormalizedType.Integer));

        var sql = new StringBuilder();
        sql.Append("SELECT ").Append(string.Join(",\n       ", selectItems));
        sql.Append('\n').Append("FROM ").Append(FromClause(plan, prepared.Schema));
        AppendJoins(sql, plan, prepared.Schema);

        if (whereParts.Count > 0)
        {
            sql.Append('\n').Append("WHERE ").Append(string.Join("\n  AND ", whereParts));
        }

        if (prepared.Dimensions.Count > 0)
        {
            sql.Append('\n').Append("GROUP BY ").Append(string.Join(", ", dimensionExprs));
        }

        if (orderParts.Count > 0)
        {
            sql.Append('\n').Append("ORDER BY ").Append(string.Join(", ", orderParts));
        }

        sql.Append('\n').Append(dialect.LimitClause(limitPlaceholder));

        return new CompiledQuery(sql.ToString(), bag.Parameters, BuildColumnPlans(prepared), Warnings: []);
    }

    public CompiledQuery EmitDistinct(
        PreparedDistinctQuery prepared,
        IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> rowFiltersByTable)
    {
        var bag = new ParameterBag();
        var plan = prepared.Plan;
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

        return new CompiledQuery(sql.ToString(), bag.Parameters, columns, Warnings: []);
    }

    // ---------- resolution helpers ----------

    private static (TableSchema Table, ColumnSchema Column) ResolveColumn(
        string tableKey, string columnName, ModelDefinition model, DatabaseSchema schema)
    {
        if (model.FindTable(tableKey) is null)
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

    private string FromClause(JoinPlan plan, DatabaseSchema schema)
    {
        var baseTable = schema.FindTable(plan.BaseTable)!;
        return $"{QualifiedTable(baseTable)} AS {dialect.QuoteIdentifier("t0")}";
    }

    private void AppendJoins(StringBuilder sql, JoinPlan plan, DatabaseSchema schema)
    {
        foreach (var step in plan.Steps)
        {
            var child = schema.FindTable(step.TableKey)!;
            var childAlias = plan.AliasByTable[step.TableKey];
            var fromSide = QualifiedColumn(plan.AliasByTable[step.Via.FromTable], step.Via.FromColumn);
            var toSide = QualifiedColumn(plan.AliasByTable[step.Via.ToTable], step.Via.ToColumn);

            sql.Append('\n')
                .Append("LEFT JOIN ").Append(QualifiedTable(child))
                .Append(" AS ").Append(dialect.QuoteIdentifier(childAlias))
                .Append(" ON ").Append(fromSide).Append(" = ").Append(toSide);
        }
    }

    private string DimensionExpression(ResolvedDimension dimension, JoinPlan plan)
    {
        var expr = QualifiedColumn(plan.AliasByTable[dimension.Table.Key], dimension.Column.Name);
        return dimension.Spec.DateBucket is { } bucket ? dialect.DateTrunc(bucket, expr) : expr;
    }

    private string MeasureExpression(ResolvedMeasure measure, JoinPlan plan, ParameterBag bag)
    {
        var argument = measure.Column is null
            ? null
            : QualifiedColumn(plan.AliasByTable[measure.Table.Key], measure.Column.Name);
        var aggregate = dialect.Aggregate(measure.Aggregation, argument);

        if (measure.Filters.Count == 0)
        {
            return aggregate;
        }

        var predicate = string.Join(" AND ", measure.Filters.Select(f => BuildPredicate(f, plan, bag)));
        return dialect.AggregateFilter(aggregate, predicate);
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

    private static IReadOnlyList<ResultColumnPlan> BuildColumnPlans(PreparedQuery prepared)
    {
        var columns = new List<ResultColumnPlan>();
        for (var i = 0; i < prepared.Dimensions.Count; i++)
        {
            var d = prepared.Dimensions[i];
            columns.Add(new ResultColumnPlan(
                $"dim{i}", d.Label, ResultColumnRole.Dimension, d.Column.Type,
                $"{d.Table.Key}.{d.Column.Name}", d.Spec.DateBucket, d.FormatHint));
        }

        for (var i = 0; i < prepared.Measures.Count; i++)
        {
            var m = prepared.Measures[i];
            var type = m.Aggregation is Aggregation.Count or Aggregation.CountDistinct
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
