using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Modeling;

/// <summary>
/// Validates a model definition against a live catalog snapshot. Runs on save
/// (store rejects on errors) and again at query time, so schema drift degrades
/// to a clear error — never to bad SQL.
///
/// Codes: MDL001 table existence/duplicates · MDL002 column/endpoint existence ·
/// MDL003 join type compatibility · MDL004 one active relationship per pair ·
/// MDL005 no self-relationships · MDL006 duplicate relationship (warning) ·
/// MDL007 active-graph cycle · MDL008 aggregation/type compatibility ·
/// MDL009 many-side cardinality unproven (warning) · MDL010 name collisions
/// (warning) · MDL011 unusable endpoint type.
/// </summary>
public sealed class SemanticModelValidator
{
    public ValidationResult Validate(ModelDefinition definition, DatabaseSchema schema)
    {
        var result = new ValidationResult();

        var catalogTables = ValidateTables(definition, schema, result);
        ValidateRelationships(definition, catalogTables, result);
        ValidateMeasures(definition, catalogTables, result);
        ValidateNameCollisions(definition, result);

        return result;
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

            if (!AreJoinCompatible(fromColumn.Type, toColumn.Type))
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
        if (definition.FindTable(tableKey) is null)
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

            if (measure.Column is null)
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
            Aggregation.Sum or Aggregation.Avg => type is NormalizedType.Integer or NormalizedType.Decimal,
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
