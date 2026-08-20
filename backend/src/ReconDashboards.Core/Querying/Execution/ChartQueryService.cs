using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Querying.Execution;

public sealed record QueryOutcome(
    CompiledQuery Compiled,
    IReadOnlyList<object?[]> Rows,
    bool Truncated,
    int ElapsedMs);

public sealed record DistinctValuesResult(IReadOnlyList<object?> Values, bool HasMore);

/// <summary>A query outcome destined for CSV download; ModelName feeds the filename.</summary>
public sealed record ExportOutcome(
    CompiledQuery Compiled,
    IReadOnlyList<object?[]> Rows,
    bool Truncated,
    string ModelName);

/// <summary>
/// The single chokepoint every chart query flows through: model visibility →
/// drift re-validation → join planning → row-filter collection (FAIL CLOSED) →
/// compilation → read-only execution → optional audit. Controllers cannot
/// reach IQueryExecutor except through here.
/// </summary>
public sealed class ChartQueryService(
    DataModelService models,
    IDataSourceRegistry registry,
    ISchemaCache schemaCache,
    SemanticModelValidator validator,
    IEnumerable<IRowFilterContributor> rowFilterContributors,
    ICurrentUserProvider currentUser,
    ReconDashboardsOptions options,
    ReconDashboardsDbContext db,
    TimeProvider timeProvider,
    ILogger<ChartQueryService> logger)
{
    public async Task<ServiceResult<QueryOutcome>> RunAsync(
        ChartQuerySpec spec, ClaimsPrincipal principal, CancellationToken ct)
    {
        var context = await LoadContextAsync(spec.ModelId, ct);
        if (!context.Succeeded)
        {
            return ServiceResult<QueryOutcome>.Fail(context.Error!);
        }

        var (model, source, schema) = context.Value!;
        var compiler = new QueryCompiler(
            source.Dialect ?? throw new InvalidOperationException($"Data source '{source.Name}' has no SQL dialect."),
            timeProvider);

        var compilation = await CompileWithMeasureIsolationAsync(
            compiler, spec, model, source, schema, principal, ct);
        if (!compilation.Succeeded)
        {
            return ServiceResult<QueryOutcome>.Fail(compilation.Error!);
        }

        return await ExecuteAsync(spec, model, source, compilation.Value!, ct);
    }

    /// <summary>
    /// *** PER-MEASURE ERROR ISOLATION ***
    ///
    /// Compiles the query; when a measure — and ONLY a measure — fails, replaces
    /// that one measure with a TOMBSTONE and compiles again, so the chart still
    /// renders its other series. A malformed formula degrades to one empty
    /// series instead of blanking the tile (and, through SnapshotComposer and
    /// SchedulingEvaluator, instead of blanking every tile of a scheduled
    /// email).
    ///
    /// WHY A TOMBSTONE AND NOT A DROP. Result columns are POSITIONAL: "meas0",
    /// "meas1", …, and sort targets, having indexes, Top-N's ByMeasureIndex and
    /// the table chart's column-keyed format maps are all indexes into that same
    /// sequence. Dropping measure 1 of 3 would renumber measure 2 to "meas1" and
    /// silently re-point every one of those at the wrong series. The tombstone
    /// selects a typed NULL under the SAME alias and keeps its
    /// <see cref="ResultColumnPlan"/> (name, label, role, type), so every index
    /// still means what the caller meant.
    ///
    /// ATTRIBUTION comes from <see cref="QueryCompilationException.Path"/> —
    /// "measures[1]" — which the compiler already stamps at the only place that
    /// knows the wire index. A failure with any other path (a dimension, a
    /// filter, a sort) or with none at all still fails the whole query: those
    /// are not one series' problem.
    ///
    /// BOUNDS. Each pass tombstones exactly one NEW measure, so the loop runs at
    /// most spec.Measures.Count + 1 times (itself capped by RcdLimits.MaxMeasures).
    /// A measure that fails again after being tombstoned, or a pass that would
    /// leave no live measure at all, stops the loop. When EVERY measure would
    /// tombstone, the ORIGINAL failure is returned unchanged: an all-blank chart
    /// with no error is worse than an error.
    ///
    /// COST. Row filters are collected INSIDE the loop, never carried over,
    /// because a tombstone changes the join plan — its tables leave the
    /// `involved` set — and the fail-closed contract in
    /// <see cref="CollectRowFiltersAsync"/> is about the plan that is actually
    /// emitted. Reusing a previous pass's collection would be an unfiltered
    /// read. In practice a measure fails during resolution, before a plan
    /// exists, so the losing passes never reach the contributor at all; the
    /// common case (nothing broken) is one pass, byte-identical to before.
    /// </summary>
    private async Task<ServiceResult<CompiledQuery>> CompileWithMeasureIsolationAsync(
        QueryCompiler compiler,
        ChartQuerySpec spec,
        SemanticModel model,
        RegisteredDataSource source,
        Schema.DatabaseSchema schema,
        ClaimsPrincipal principal,
        CancellationToken ct)
    {
        ModelDefinition effective;
        try
        {
            // Outside the retry: the overlay is a pure function of the spec, so
            // re-merging it on every pass could only produce the same answer.
            effective = MeasureOverlay.Merge(
                model.Definition, spec.Definitions, spec.DerivedFields, options.Limits);
        }
        catch (QueryCompilationException ex)
        {
            return CompilationFailure(ex);
        }

        var tombstoned = new HashSet<int>();
        var failures = new List<MeasureFailure>();
        QueryCompilationException? firstFailure = null;

        for (var pass = 0; pass <= spec.Measures.Count; pass++)
        {
            try
            {
                var prepared = compiler.Prepare(
                    spec, effective, schema, options.Limits,
                    tombstoned.Count == 0 ? null : tombstoned);
                var rowFilters = await CollectRowFiltersAsync(
                    source.Name, prepared.Plan.Tables, schema, principal, ct);
                var compiled = compiler.Emit(prepared, spec, rowFilters, options.Limits, source.Options);

                if (failures.Count > 0)
                {
                    // Labels come from the prepared measures, so a tombstone
                    // reports the name the caller sees on the chart.
                    compiled = compiled with
                    {
                        MeasureFailures = [.. failures.Select(f => f with { Label = prepared.Measures[f.Index].Label })],
                    };
                    logger.LogInformation(
                        "Query on model {ModelId} compiled with {Count} tombstoned measure(s): {Measures}",
                        model.Id, failures.Count, string.Join(", ", failures.Select(f => $"measures[{f.Index}] {f.Code}")));
                }

                return ServiceResult<CompiledQuery>.Ok(compiled);
            }
            catch (QueryCompilationException ex)
            {
                firstFailure ??= ex;

                // Not a measure's fault — a dimension, a filter, a sort, the
                // query as a whole. Report THIS failure, not an earlier
                // isolatable one: it is the thing actually blocking the query.
                if (MeasureIndexOf(ex.Path) is not { } index || index >= spec.Measures.Count)
                {
                    return CompilationFailure(ex);
                }

                // Isolation cannot help — either the tombstone itself failed
                // (impossible in practice, but the loop must not spin) or every
                // measure would now be blank, and an all-blank chart with no
                // error is worse than an error. Report the ORIGINAL failure.
                if (!tombstoned.Add(index) || tombstoned.Count >= spec.Measures.Count)
                {
                    return CompilationFailure(firstFailure);
                }

                // The label is a placeholder: the real one is only knowable
                // once a pass PREPARES successfully, and is filled in there.
                failures.Add(new MeasureFailure(index, $"Measure {index + 1}", ToErrorCode(ex.Code), ex.Message));
            }
            catch (RowFilterDeniedException ex)
            {
                return ServiceResult<CompiledQuery>.Fail(
                    ServiceErrorKind.Forbidden, "rcd.query.denied_by_scope", ex.Message);
            }
        }

        // Unreachable: every pass either returns or adds a tombstone, and the
        // loop bound exceeds the number of measures that can be tombstoned.
        return CompilationFailure(firstFailure!);
    }

    private static ServiceResult<CompiledQuery> CompilationFailure(QueryCompilationException ex) =>
        ServiceResult<CompiledQuery>.Fail(
            ServiceErrorKind.BadRequest, ToErrorCode(ex.Code), ex.Message, ToValidation(ex));

    /// <summary>
    /// The wire measure index in a compilation path, or null when the path does
    /// not name one. Accepts "measures[2]" and its suffixed forms
    /// ("measures[2].column"); everything else — "dimensions[0]", "filters[1]",
    /// "sort[0]", "limit", null — is deliberately not isolatable.
    /// </summary>
    public static int? MeasureIndexOf(string? path)
    {
        const string prefix = "measures[";
        if (path is null || !path.StartsWith(prefix, StringComparison.Ordinal))
        {
            return null;
        }

        var close = path.IndexOf(']', prefix.Length);
        return close > prefix.Length
            && int.TryParse(path[prefix.Length..close], System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var index)
            ? index
            : null;
    }

    /// <summary>Default row cap for exports when the caller does not send one.</summary>
    public const int DefaultExportRows = 10_000;

    /// <summary>Hard ceiling for export row caps regardless of what the caller asks for.</summary>
    public const int MaxExportRows = 100_000;

    /// <summary>Default row cap for the JSON underlying-data endpoint when the caller does not send one.</summary>
    public const int DefaultUnderlyingRows = 1_000;

    /// <summary>Hard ceiling for the JSON underlying-data endpoint regardless of what the caller asks for.</summary>
    public const int MaxUnderlyingRows = 10_000;

    /// <summary>
    /// CSV export twin of <see cref="RunAsync"/>. Summarized mode runs the
    /// normal pipeline (calcs and having included); underlying mode selects the
    /// anchor table's raw rows with the spec's filters — having is ignored
    /// there (post-aggregation has no meaning on row-level output). BOTH modes
    /// collect row filters
    /// over the full join plan through the same fail-closed path as /query.
    /// </summary>
    public async Task<ServiceResult<ExportOutcome>> RunExportAsync(
        ChartQuerySpec spec, ExportMode? mode, int? maxRows, ClaimsPrincipal principal, CancellationToken ct)
    {
        if (mode is null || !Enum.IsDefined(mode.Value))
        {
            return ServiceResult<ExportOutcome>.Fail(
                ServiceErrorKind.BadRequest, "rcd.query.bad_export",
                "Export mode must be 'summarized' or 'underlying'.");
        }

        var requestedCap = Math.Clamp(maxRows ?? DefaultExportRows, 1, MaxExportRows);

        if (mode == ExportMode.Underlying)
        {
            var underlying = await RunUnderlyingCoreAsync(spec, requestedCap, principal, ct);
            if (!underlying.Succeeded)
            {
                return ServiceResult<ExportOutcome>.Fail(underlying.Error!);
            }

            var (outcome, modelName) = underlying.Value!;
            return ServiceResult<ExportOutcome>.Ok(
                new ExportOutcome(outcome.Compiled, outcome.Rows, outcome.Truncated, modelName));
        }

        var context = await LoadContextAsync(spec.ModelId, ct);
        if (!context.Succeeded)
        {
            return ServiceResult<ExportOutcome>.Fail(context.Error!);
        }

        var (model, source, schema) = context.Value!;
        var compiler = new QueryCompiler(
            source.Dialect ?? throw new InvalidOperationException($"Data source '{source.Name}' has no SQL dialect."),
            timeProvider);

        // Summarized export is the /query pipeline with a different row cap, so
        // it inherits per-measure isolation too: one broken measure exports as
        // an empty column instead of failing the download.
        var compilation = await CompileWithMeasureIsolationAsync(
            compiler, spec, model, source, schema, principal, ct);
        if (!compilation.Succeeded)
        {
            return ServiceResult<ExportOutcome>.Fail(compilation.Error!);
        }

        var compiled = compilation.Value!;
        // The normal query caps still bind; maxRows can only tighten them.
        var rowCap = Math.Min(requestedCap, Math.Min(options.Limits.MaxRows, source.Options.MaxRows));

        var executed = await ExecuteAsync(spec, model, source, compiled, ct, distinctLimit: rowCap);
        if (!executed.Succeeded)
        {
            return ServiceResult<ExportOutcome>.Fail(executed.Error!);
        }

        var value = executed.Value!;
        return ServiceResult<ExportOutcome>.Ok(
            new ExportOutcome(value.Compiled, value.Rows, value.Truncated, model.Name));
    }

    /// <summary>
    /// JSON twin of the underlying-data export mode: the anchor table's raw
    /// rows (every physical column, no aggregation) with the spec's filters
    /// applied. maxRows defaults to <see cref="DefaultUnderlyingRows"/> and is
    /// clamped to [1, <see cref="MaxUnderlyingRows"/>]. The spec's `having` is
    /// ignored — same as export underlying, post-aggregation has no meaning on
    /// row-level output.
    /// </summary>
    public async Task<ServiceResult<QueryOutcome>> RunUnderlyingAsync(
        ChartQuerySpec spec, int? maxRows, ClaimsPrincipal principal, CancellationToken ct)
    {
        var rowCap = Math.Clamp(maxRows ?? DefaultUnderlyingRows, 1, MaxUnderlyingRows);
        var result = await RunUnderlyingCoreAsync(spec, rowCap, principal, ct);
        return result.Succeeded
            ? ServiceResult<QueryOutcome>.Ok(result.Value!.Outcome)
            : ServiceResult<QueryOutcome>.Fail(result.Error!);
    }

    /// <summary>
    /// The single underlying-data pipeline both the CSV export mode and the
    /// JSON endpoint share: model visibility + drift check → PrepareUnderlying
    /// (anchor = first measure's table, BFS-joined spec filters) → fail-closed
    /// row-filter collection over the full join plan → EmitUnderlying (all
    /// physical columns, ORDER BY first column, LIMIT rowCap+1 truncation
    /// probe) → read-only, timeout-bounded execution capped at rowCap.
    /// </summary>
    private async Task<ServiceResult<(QueryOutcome Outcome, string ModelName)>> RunUnderlyingCoreAsync(
        ChartQuerySpec spec, int rowCap, ClaimsPrincipal principal, CancellationToken ct)
    {
        var context = await LoadContextAsync(spec.ModelId, ct);
        if (!context.Succeeded)
        {
            return ServiceResult<(QueryOutcome, string)>.Fail(context.Error!);
        }

        var (model, source, schema) = context.Value!;
        var compiler = new QueryCompiler(
            source.Dialect ?? throw new InvalidOperationException($"Data source '{source.Name}' has no SQL dialect."),
            timeProvider);

        CompiledQuery compiled;
        try
        {
            // NO per-measure isolation here, unlike RunAsync and the summarized
            // export. Underlying data has no per-measure result columns to keep
            // aligned — the measures serve only to pick the anchor TABLE whose
            // raw rows are returned — so tombstoning the anchor would leave
            // nothing to select from. A broken measure here is a whole-query
            // failure, and correctly so.
            var effective = MeasureOverlay.Merge(
                model.Definition, spec.Definitions, spec.DerivedFields, options.Limits);
            var prepared = compiler.PrepareUnderlying(spec, effective, schema, options.Limits);
            var rowFilters = await CollectRowFiltersAsync(source.Name, prepared.Plan.Tables, schema, principal, ct);
            compiled = compiler.EmitUnderlying(prepared, rowFilters, rowCap);
        }
        catch (QueryCompilationException ex)
        {
            return ServiceResult<(QueryOutcome, string)>.Fail(
                ServiceErrorKind.BadRequest, ToErrorCode(ex.Code), ex.Message, ToValidation(ex));
        }
        catch (RowFilterDeniedException ex)
        {
            return ServiceResult<(QueryOutcome, string)>.Fail(
                ServiceErrorKind.Forbidden, "rcd.query.denied_by_scope", ex.Message);
        }

        var outcome = await ExecuteAsync(spec, model, source, compiled, ct, distinctLimit: rowCap);
        return outcome.Succeeded
            ? ServiceResult<(QueryOutcome, string)>.Ok((outcome.Value!, model.Name))
            : ServiceResult<(QueryOutcome, string)>.Fail(outcome.Error!);
    }

    public async Task<ServiceResult<DistinctValuesResult>> GetDistinctValuesAsync(
        DistinctValuesSpec spec, ClaimsPrincipal principal, CancellationToken ct)
    {
        var context = await LoadContextAsync(spec.ModelId, ct);
        if (!context.Succeeded)
        {
            return ServiceResult<DistinctValuesResult>.Fail(context.Error!);
        }

        var (model, source, schema) = context.Value!;
        var compiler = new QueryCompiler(
            source.Dialect ?? throw new InvalidOperationException($"Data source '{source.Name}' has no SQL dialect."),
            timeProvider);

        CompiledQuery compiled;
        int limit;
        try
        {
            // MEASURES are still not overlaid here — a distinct-values spec
            // resolves ONE column plus its filters and never touches
            // model.Measures, so there is nothing for a measure overlay to
            // reach, and DistinctValuesSpec carries none.
            //
            // DERIVED FIELDS are, because a distinct-values spec CAN name one:
            // the grouping editor's value picker and a header filter on a
            // derived column both ask for the distinct values of a derived
            // column, and the compiler can only see a non-model definition if
            // the same pre-Prepare merge put it in the effective model.
            var effective = MeasureOverlay.Merge(
                model.Definition, definitions: null, spec.DerivedFields, options.Limits);
            var prepared = compiler.PrepareDistinct(spec, effective, schema, options.Limits);
            limit = prepared.Limit;
            var rowFilters = await CollectRowFiltersAsync(source.Name, prepared.Plan.Tables, schema, principal, ct);
            compiled = compiler.EmitDistinct(prepared, rowFilters);
        }
        catch (QueryCompilationException ex)
        {
            return ServiceResult<DistinctValuesResult>.Fail(
                ServiceErrorKind.BadRequest, ToErrorCode(ex.Code), ex.Message, ToValidation(ex));
        }
        catch (RowFilterDeniedException ex)
        {
            return ServiceResult<DistinctValuesResult>.Fail(
                ServiceErrorKind.Forbidden, "rcd.query.denied_by_scope", ex.Message);
        }

        var outcome = await ExecuteAsync(spec: null, model, source, compiled, ct, distinctLimit: limit);
        if (!outcome.Succeeded)
        {
            return ServiceResult<DistinctValuesResult>.Fail(outcome.Error!);
        }

        var rows = outcome.Value!.Rows;
        var hasMore = rows.Count > limit;
        var values = rows.Take(limit).Select(r => r[0]).ToArray();
        return ServiceResult<DistinctValuesResult>.Ok(new DistinctValuesResult(values, hasMore));
    }

    private async Task<ServiceResult<(SemanticModel Model, RegisteredDataSource Source, Schema.DatabaseSchema Schema)>>
        LoadContextAsync(int modelId, CancellationToken ct)
    {
        var modelResult = await models.GetAsync(modelId, ct);
        if (!modelResult.Succeeded)
        {
            return ServiceResult<(SemanticModel, RegisteredDataSource, Schema.DatabaseSchema)>.Fail(modelResult.Error!);
        }

        var model = modelResult.Value!;
        if (!registry.TryGet(model.DataSourceName, out var source))
        {
            return ServiceResult<(SemanticModel, RegisteredDataSource, Schema.DatabaseSchema)>.Fail(
                ServiceErrorKind.Conflict, "rcd.source.unknown",
                $"The model's data source '{model.DataSourceName}' is no longer registered.");
        }

        var schema = await schemaCache.GetAsync(source.Name, ct);

        var drift = validator.Validate(model.Definition, schema);
        if (!drift.IsValid)
        {
            return ServiceResult<(SemanticModel, RegisteredDataSource, Schema.DatabaseSchema)>.Fail(new ServiceError(
                ServiceErrorKind.Validation, "rcd.query.model_drift",
                "The model no longer matches the database schema. Open the model editor to repair it.",
                drift));
        }

        return ServiceResult<(SemanticModel, RegisteredDataSource, Schema.DatabaseSchema)>.Ok((model, source, schema));
    }

    /// <summary>
    /// Consults every contributor for every table in the join plan (including
    /// bridge tables). A contributor exception or Deny aborts the query —
    /// there is no unfiltered fallback.
    /// </summary>
    private async Task<IReadOnlyDictionary<string, IReadOnlyList<RowFilter>>> CollectRowFiltersAsync(
        string dataSourceName,
        IEnumerable<string> tableKeys,
        Schema.DatabaseSchema schema,
        ClaimsPrincipal principal,
        CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var result = new Dictionary<string, IReadOnlyList<RowFilter>>(StringComparer.Ordinal);

        foreach (var tableKey in tableKeys)
        {
            var table = schema.FindTable(tableKey);
            if (table is null)
            {
                continue;
            }

            List<RowFilter>? filters = null;
            foreach (var contributor in rowFilterContributors)
            {
                RowFilterDecision decision;
                try
                {
                    decision = await contributor.GetFiltersAsync(
                        new RowFilterContext(dataSourceName, table.Schema, table.Name, principal, userId), ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogError(ex,
                        "Row filter contributor {Contributor} failed for table {Table}; denying access (fail closed)",
                        contributor.GetType().Name, tableKey);
                    throw new RowFilterDeniedException(tableKey);
                }

                if (decision.Deny)
                {
                    throw new RowFilterDeniedException(tableKey);
                }

                if (decision.Filters.Count > 0)
                {
                    (filters ??= []).AddRange(decision.Filters);
                }
            }

            if (filters is not null)
            {
                result[tableKey] = filters;
            }
        }

        return result;
    }

    private async Task<ServiceResult<QueryOutcome>> ExecuteAsync(
        ChartQuerySpec? spec,
        SemanticModel model,
        RegisteredDataSource source,
        CompiledQuery compiled,
        CancellationToken ct,
        int? distinctLimit = null)
    {
        var executor = source.Executor
            ?? throw new InvalidOperationException($"Data source '{source.Name}' has no query executor.");

        var maxRows = distinctLimit ?? Math.Min(options.Limits.MaxRows, source.Options.MaxRows);
        var executionOptions = new ExecutionOptions(maxRows, source.Options.StatementTimeoutSeconds);

        try
        {
            var executed = await executor.ExecuteAsync(compiled, executionOptions, ct);
            var (rows, truncated) = ApplyRowAccounting(compiled, executed.Rows, executed.Truncated);

            await AuditAsync(spec, model, source, compiled, rows.Count, executed.ElapsedMs, null, ct);
            return ServiceResult<QueryOutcome>.Ok(
                new QueryOutcome(compiled, rows, truncated, executed.ElapsedMs));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Chart query execution failed for model {ModelId} on {DataSource}", model.Id, source.Name);
            await AuditAsync(spec, model, source, compiled, 0, 0, "rcd.query.execution_failed", ct);
            return ServiceResult<QueryOutcome>.Fail(
                ServiceErrorKind.Upstream, "rcd.query.execution_failed",
                "The query failed to execute. Check server logs for details.");
        }
    }

    /// <summary>
    /// Applies the compiled statement's row accounting to raw executor output:
    /// a trailing "__rcd_truncated" probe COLUMN (<see cref="CompiledQuery.HasTruncationProbe"/>)
    /// is folded into the truncation flag and stripped off every row, then the
    /// RowLimit + 1 probe ROW is trimmed back off so callers never see more
    /// rows than requested (pagination pages, TopN) and the overflow reports
    /// as truncation.
    /// </summary>
    public static (IReadOnlyList<object?[]> Rows, bool Truncated) ApplyRowAccounting(
        CompiledQuery compiled, IReadOnlyList<object?[]> rows, bool truncated)
    {
        if (compiled.HasTruncationProbe && rows.Count > 0)
        {
            // The probe is constant across rows — read it once, strip it everywhere.
            truncated = truncated || rows[0][^1] is true;
            rows = [.. rows.Select(r => r[..^1])];
        }

        if (compiled.RowLimit is int rowLimit && rows.Count > rowLimit)
        {
            rows = [.. rows.Take(rowLimit)];
            truncated = true;
        }

        return (rows, truncated);
    }

    private async Task AuditAsync(
        ChartQuerySpec? spec,
        SemanticModel model,
        RegisteredDataSource source,
        CompiledQuery compiled,
        int rowCount,
        int elapsedMs,
        string? errorCode,
        CancellationToken ct)
    {
        if (!options.EnableQueryAudit)
        {
            return;
        }

        try
        {
            db.QueryAudit.Add(new QueryAuditRecord
            {
                UserId = currentUser.GetUserId(),
                DataSourceName = source.Name,
                ModelId = model.Id,
                SpecJson = spec is null ? "{}" : JsonSerializer.Serialize(spec, ModelJson.Options),
                SqlHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(compiled.Sql))),
                RowCount = rowCount,
                ElapsedMs = elapsedMs,
                Succeeded = errorCode is null,
                ErrorCode = errorCode,
                ExecutedAtUtc = timeProvider.GetUtcNow().UtcDateTime,
            });
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            // Auditing must never break queries.
            logger.LogWarning(ex, "Failed to write query audit row");
        }
    }

    /// <summary>
    /// Lifts a compilation failure's field path into the SAME structured
    /// channel the model editor's MDL checks use (ServiceError.Validation →
    /// ProblemDetails "issues" → RcdApiError.issues), so the chart builder can
    /// badge the well that owns the mistake instead of only printing the
    /// sentence. Null when the compiler did not attribute the fault to a
    /// field — the response is then exactly what it has always been.
    /// </summary>
    private static ValidationResult? ToValidation(QueryCompilationException ex)
    {
        if (ex.Path is null)
        {
            return null;
        }

        var validation = new ValidationResult();
        validation.AddError(ToErrorCode(ex.Code), ex.Message, ex.Path);
        return validation;
    }

    /// <summary>QRY_DISCONNECTED → rcd.query.disconnected etc.</summary>
    private static string ToErrorCode(string compilationCode) =>
        "rcd.query." + compilationCode.Replace("QRY_", "", StringComparison.Ordinal).ToLowerInvariant();
}
