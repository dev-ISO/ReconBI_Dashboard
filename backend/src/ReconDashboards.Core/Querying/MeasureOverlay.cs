using System.Text;
using System.Text.Json;
using ReconDashboards.Core.Json;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Core.Querying;

/// <summary>
/// Merges the measure definitions a query CARRIES (ChartQuerySpec.Definitions —
/// dashboard-scoped and personal-scoped measures, which by construction are not
/// in the stored model) into the ModelDefinition the compiler is about to
/// prepare against.
///
/// *** WHY THE MERGE HAPPENS HERE AND NOT INSIDE THE COMPILER ***
/// This is the single security-load-bearing decision of the definitions wire.
/// A measure that is part of ModelDefinition.Measures when
/// <see cref="QueryCompiler.Prepare"/> runs flows through the whole chain that
/// makes a query safe:
///
///   Prepare → CollectInvolvedTables (walks measure.Table, measure.Filters AND
///   expression.AggregateTableKeys + nested [references]) → the `involved` set
///   → JoinPathResolver.Resolve → PreparedQuery.Plan.Tables →
///   ChartQueryService.CollectRowFiltersAsync (FAIL CLOSED — a contributor
///   throw or Deny aborts the query) → AppendRowFilterPredicates.
///
/// Row filters attach ONLY to tables that made it into the join plan
/// (AppendRowFilterPredicates skips any table absent from plan.AliasByTable).
/// So the ONLY thing that makes an overlay expression's tables row-filtered is
/// that the overlay was part of the definition when the plan was built.
/// Special-casing caller-supplied definitions later — e.g. resolving them
/// inside QueryCompiler.ResolveMeasure — would compile and produce correct
/// numbers while SILENTLY dropping the row-level security of any table only
/// the expression names. Two named tests pin this:
/// ExecutionSafetyTests.OverlayExpressionTable_StillReceivesItsRowFilters and
/// QueryCompilerExpressionMeasureTests.OverlayMeasureTablesReachTheJoinPlanExactlyLikeModelMeasures.
///
/// Everything the merge does NOT need is deliberately absent: model.FindTable
/// still gates which tables an expression may name (and the model's tables were
/// themselves filtered by SchemaFilter), the parser's closed grammar still
/// gates the expression text, and emission still uses resolved catalog names
/// only. The overlay adds no new trust.
/// </summary>
public static class MeasureOverlay
{
    /// <summary>
    /// The overlaid definition, or <paramref name="model"/> unchanged when the
    /// spec carried nothing. Throws <see cref="QueryCompilationException"/>
    /// (which every ChartQueryService entry point already translates into a
    /// 400 with an rcd.query.* code) when the overlay breaks a rule.
    /// </summary>
    public static ModelDefinition Merge(
        ModelDefinition model, IReadOnlyList<Measure>? definitions, RcdLimits limits) =>
        Merge(model, definitions, derivedFields: null, limits);

    /// <summary>
    /// The overlaid definition carrying BOTH caller-supplied channels: measure
    /// definitions and DERIVED FIELD definitions.
    ///
    /// <para>Derived fields ride the SAME mechanism for the same reason: they
    /// are merged into the ModelDefinition BEFORE
    /// <see cref="QueryCompiler.Prepare"/>, so the compiler injects them into
    /// the resolved schema, resolves them, and plans joins with them exactly as
    /// it does model-held ones. There is no second overlay path to keep in
    /// sync — and no path on which a caller-supplied definition could be
    /// resolved after the join plan (and therefore after row-filter collection)
    /// was built.</para>
    ///
    /// <para>A derived field is same-table by construction (enforced in the
    /// compiler), so unlike a measure expression it can never widen the join
    /// plan at all: the table it reads is the one the dimension naming it
    /// already put there.</para>
    /// </summary>
    public static ModelDefinition Merge(
        ModelDefinition model,
        IReadOnlyList<Measure>? definitions,
        IReadOnlyList<DerivedField>? derivedFields,
        RcdLimits limits)
    {
        var merged = MergeMeasures(model, definitions, limits);
        return MergeDerivedFields(merged, derivedFields, limits);
    }

    private static ModelDefinition MergeMeasures(
        ModelDefinition model, IReadOnlyList<Measure>? definitions, RcdLimits limits)
    {
        if (definitions is null || definitions.Count == 0)
        {
            return model;
        }

        if (definitions.Count > limits.MaxQueryMeasureDefinitions)
        {
            throw new QueryCompilationException(
                "QRY_TOO_MANY_DEFINITIONS",
                $"A query may carry at most {limits.MaxQueryMeasureDefinitions} measure definitions; this one carries {definitions.Count}.");
        }

        var bytes = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(definitions, ModelJson.Options));
        if (bytes > limits.MaxQueryMeasureDefinitionBytes)
        {
            throw new QueryCompilationException(
                "QRY_DEFINITIONS_TOO_LARGE",
                $"The query's measure definitions are {bytes} bytes; the limit is {limits.MaxQueryMeasureDefinitionBytes}.");
        }

        // Ids first: QueryCompiler.ResolveMeasure takes the FIRST id match, so
        // a colliding GUID would let an overlay SHADOW a model measure — every
        // chart in the model that cites that id would silently change meaning.
        var ids = new HashSet<Guid>(model.Measures.Select(m => m.Id));

        // Names second, case-insensitively: MeasureExpressionParser
        // .ResolveMeasureRef prefers an exact-case match and falls back to a
        // unique case-insensitive one, reporting Ambiguous when either is
        // multi-valued. An overlay name that collides therefore does not merely
        // shadow — it breaks EVERY model expression that says [ThatName], with
        // a QRY_BAD_MEASURE that names a measure the author never touched.
        var names = new HashSet<string>(model.Measures.Select(m => m.Name), StringComparer.OrdinalIgnoreCase);

        foreach (var measure in definitions)
        {
            if (measure is null)
            {
                throw new QueryCompilationException(
                    "QRY_BAD_DEFINITION", "A measure definition on the query is null.");
            }

            if (measure.Id == Guid.Empty)
            {
                throw new QueryCompilationException(
                    "QRY_BAD_DEFINITION", $"Measure definition '{measure.Name}' has no id.");
            }

            if (string.IsNullOrWhiteSpace(measure.Name))
            {
                throw new QueryCompilationException(
                    "QRY_BAD_DEFINITION", $"Measure definition {measure.Id} has no name.");
            }

            if (!ids.Add(measure.Id))
            {
                throw new QueryCompilationException(
                    "QRY_DUPLICATE_MEASURE_ID",
                    $"Measure definition {measure.Id} ('{measure.Name}') collides with a measure the model already defines.");
            }

            if (!names.Add(measure.Name))
            {
                throw new QueryCompilationException(
                    "QRY_DUPLICATE_MEASURE_NAME",
                    $"Measure definition '{measure.Name}' collides with a measure name the model already defines; expression [references] to that name would become ambiguous.");
            }
        }

        // ModelDefinition is a record — `with` is a shallow copy, and nothing
        // downstream mutates Measures.
        return model with { Measures = [.. model.Measures, .. definitions] };
    }

    /// <summary>
    /// The derived-field half of the overlay, under the same duplicate-id /
    /// duplicate-name / count / byte discipline as measures.
    ///
    /// NAME UNIQUENESS IS PER TABLE, not global: a derived field IS a column of
    /// its table, so "Uploaded?" on two different tables is as legitimate as two
    /// tables both having an "id". What must never happen is two fields
    /// competing for one column name on one table — the compiler would inject
    /// both and <c>FindColumn</c> would pick whichever came first.
    /// </summary>
    private static ModelDefinition MergeDerivedFields(
        ModelDefinition model, IReadOnlyList<DerivedField>? derivedFields, RcdLimits limits)
    {
        if (derivedFields is null || derivedFields.Count == 0)
        {
            return model;
        }

        if (derivedFields.Count > limits.MaxQueryDerivedFieldDefinitions)
        {
            throw new QueryCompilationException(
                "QRY_TOO_MANY_DERIVED_FIELDS",
                $"A query may carry at most {limits.MaxQueryDerivedFieldDefinitions} derived-field definitions; this one carries {derivedFields.Count}.");
        }

        var bytes = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(derivedFields, ModelJson.Options));
        if (bytes > limits.MaxQueryDerivedFieldBytes)
        {
            throw new QueryCompilationException(
                "QRY_DERIVED_FIELDS_TOO_LARGE",
                $"The query's derived-field definitions are {bytes} bytes; the limit is {limits.MaxQueryDerivedFieldBytes}.");
        }

        var ids = new HashSet<Guid>(model.DerivedFieldDefs.Select(f => f.Id));
        var names = new HashSet<(string Table, string Name)>(
            model.DerivedFieldDefs.Select(f => (f.Table, f.Name)),
            TableColumnComparer.Instance);

        foreach (var field in derivedFields)
        {
            if (field is null)
            {
                throw new QueryCompilationException(
                    "QRY_BAD_DERIVED", "A derived-field definition on the query is null.");
            }

            if (field.Id == Guid.Empty)
            {
                throw new QueryCompilationException(
                    "QRY_BAD_DERIVED", $"Derived-field definition '{field.Name}' has no id.");
            }

            if (string.IsNullOrWhiteSpace(field.Name))
            {
                throw new QueryCompilationException(
                    "QRY_BAD_DERIVED", $"Derived-field definition {field.Id} has no name.");
            }

            if (string.IsNullOrWhiteSpace(field.Table))
            {
                throw new QueryCompilationException(
                    "QRY_BAD_DERIVED", $"Derived-field definition '{field.Name}' has no table.");
            }

            if (!ids.Add(field.Id))
            {
                throw new QueryCompilationException(
                    "QRY_DUPLICATE_DERIVED_ID",
                    $"Derived-field definition {field.Id} ('{field.Name}') collides with a derived field the model already defines.");
            }

            if (!names.Add((field.Table, field.Name)))
            {
                throw new QueryCompilationException(
                    "QRY_DUPLICATE_DERIVED_NAME",
                    $"Derived-field definition '{field.Name}' collides with another derived field of the same name on '{field.Table}'; one of them would silently shadow the other.");
            }
        }

        return model with { DerivedFields = [.. model.DerivedFieldDefs, .. derivedFields] };
    }

    /// <summary>Table names are case-sensitive catalog keys; column names compare loosely, like the compiler's injection guard.</summary>
    private sealed class TableColumnComparer : IEqualityComparer<(string Table, string Name)>
    {
        public static readonly TableColumnComparer Instance = new();

        public bool Equals((string Table, string Name) x, (string Table, string Name) y) =>
            string.Equals(x.Table, y.Table, StringComparison.Ordinal)
            && string.Equals(x.Name, y.Name, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode((string Table, string Name) obj) =>
            HashCode.Combine(obj.Table, obj.Name.ToLowerInvariant());
    }

    /// <summary>
    /// The derived fields a set of {table, column} references needs — the
    /// scheduling/alert twin of <see cref="CollectReferenced"/>. A reference
    /// matches by NAME or by ID, mirroring how the compiler resolves one.
    /// Ids/names <paramref name="available"/> does not hold are silently
    /// skipped: those are model fields, which the server already has.
    /// </summary>
    public static IReadOnlyList<DerivedField> CollectReferencedFields(
        IReadOnlyList<DerivedField> available, IEnumerable<(string Table, string Column)> references)
    {
        if (available.Count == 0)
        {
            return [];
        }

        var taken = new HashSet<Guid>();
        foreach (var (table, column) in references)
        {
            foreach (var field in available)
            {
                if (string.Equals(field.Table, table, StringComparison.Ordinal)
                    && (string.Equals(field.Name, column, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(field.Id.ToString(), column, StringComparison.OrdinalIgnoreCase)))
                {
                    taken.Add(field.Id);
                }
            }
        }

        return taken.Count == 0 ? [] : [.. available.Where(f => taken.Contains(f.Id))];
    }

    /// <summary>
    /// The TRANSITIVE closure of the definitions a set of measure references
    /// needs: the referenced measures themselves plus, for calculated ones,
    /// every measure their expression names in [brackets] — because
    /// MeasureExpressionParser resolves those BY NAME against the merged
    /// definition, so a dependency that does not travel resolves to nothing.
    ///
    /// <paramref name="available"/> is the scope's whole measure set (a
    /// dashboard doc's measures, say); ids/names it does not hold are silently
    /// skipped — they are model measures, which the server already has.
    /// Returns them in <paramref name="available"/> order so the output is
    /// stable (and therefore so is a query cache key built from it).
    /// </summary>
    public static IReadOnlyList<Measure> CollectReferenced(
        IReadOnlyList<Measure> available, IEnumerable<Guid> measureIds)
    {
        if (available.Count == 0)
        {
            return [];
        }

        var byId = new Dictionary<Guid, Measure>();
        var byName = new Dictionary<string, Measure>(StringComparer.OrdinalIgnoreCase);
        foreach (var measure in available)
        {
            byId.TryAdd(measure.Id, measure);
            byName.TryAdd(measure.Name, measure);
        }

        var taken = new HashSet<Guid>();
        var queue = new Queue<Measure>();
        foreach (var id in measureIds)
        {
            if (byId.TryGetValue(id, out var measure) && taken.Add(measure.Id))
            {
                queue.Enqueue(measure);
            }
        }

        while (queue.Count > 0)
        {
            var measure = queue.Dequeue();
            if (measure.Expression is not { } expression)
            {
                continue;
            }

            foreach (var name in ExpressionReferenceNames(expression))
            {
                if (byName.TryGetValue(name, out var referenced) && taken.Add(referenced.Id))
                {
                    queue.Enqueue(referenced);
                }
            }
        }

        return taken.Count == 0 ? [] : [.. available.Where(m => taken.Contains(m.Id))];
    }

    /// <summary>
    /// The [bracketed] names in an expression. Deliberately a raw scan rather
    /// than a parse: this runs on text that may not parse at all yet, and
    /// over-collecting a name that is not a measure costs nothing (the lookup
    /// simply misses), while under-collecting would drop a real dependency.
    /// </summary>
    public static IEnumerable<string> ExpressionReferenceNames(string expression)
    {
        var start = -1;
        for (var i = 0; i < expression.Length; i++)
        {
            var c = expression[i];
            if (c == '[')
            {
                start = i + 1;
            }
            else if (c == ']' && start >= 0)
            {
                var name = expression[start..i].Trim();
                if (name.Length > 0)
                {
                    yield return name;
                }

                start = -1;
            }
        }
    }
}
