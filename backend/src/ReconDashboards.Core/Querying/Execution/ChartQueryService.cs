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

        CompiledQuery compiled;
        try
        {
            var prepared = compiler.Prepare(spec, model.Definition, schema, options.Limits);
            var rowFilters = await CollectRowFiltersAsync(source.Name, prepared.Plan.Tables, schema, principal, ct);
            compiled = compiler.Emit(prepared, spec, rowFilters, options.Limits, source.Options);
        }
        catch (QueryCompilationException ex)
        {
            return ServiceResult<QueryOutcome>.Fail(
                ServiceErrorKind.BadRequest, ToErrorCode(ex.Code), ex.Message);
        }
        catch (RowFilterDeniedException ex)
        {
            return ServiceResult<QueryOutcome>.Fail(
                ServiceErrorKind.Forbidden, "rcd.query.denied_by_scope", ex.Message);
        }

        return await ExecuteAsync(spec, model, source, compiled, ct);
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

        CompiledQuery compiled;
        int rowCap;
        try
        {
            var prepared = compiler.Prepare(spec, model.Definition, schema, options.Limits);
            var rowFilters = await CollectRowFiltersAsync(source.Name, prepared.Plan.Tables, schema, principal, ct);
            compiled = compiler.Emit(prepared, spec, rowFilters, options.Limits, source.Options);
            // The normal query caps still bind; maxRows can only tighten them.
            rowCap = Math.Min(requestedCap, Math.Min(options.Limits.MaxRows, source.Options.MaxRows));
        }
        catch (QueryCompilationException ex)
        {
            return ServiceResult<ExportOutcome>.Fail(
                ServiceErrorKind.BadRequest, ToErrorCode(ex.Code), ex.Message);
        }
        catch (RowFilterDeniedException ex)
        {
            return ServiceResult<ExportOutcome>.Fail(
                ServiceErrorKind.Forbidden, "rcd.query.denied_by_scope", ex.Message);
        }

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
            var prepared = compiler.PrepareUnderlying(spec, model.Definition, schema, options.Limits);
            var rowFilters = await CollectRowFiltersAsync(source.Name, prepared.Plan.Tables, schema, principal, ct);
            compiled = compiler.EmitUnderlying(prepared, rowFilters, rowCap);
        }
        catch (QueryCompilationException ex)
        {
            return ServiceResult<(QueryOutcome, string)>.Fail(
                ServiceErrorKind.BadRequest, ToErrorCode(ex.Code), ex.Message);
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
            var prepared = compiler.PrepareDistinct(spec, model.Definition, schema, options.Limits);
            limit = prepared.Limit;
            var rowFilters = await CollectRowFiltersAsync(source.Name, prepared.Plan.Tables, schema, principal, ct);
            compiled = compiler.EmitDistinct(prepared, rowFilters);
        }
        catch (QueryCompilationException ex)
        {
            return ServiceResult<DistinctValuesResult>.Fail(
                ServiceErrorKind.BadRequest, ToErrorCode(ex.Code), ex.Message);
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
            // The statement asks for RowLimit + 1 (truncation probe); trim the
            // probe row back off so callers never see more rows than requested
            // (pagination pages, TopN) and report the overflow as truncation.
            var rows = executed.Rows;
            var truncated = executed.Truncated;
            if (compiled.RowLimit is int rowLimit && rows.Count > rowLimit)
            {
                rows = [.. rows.Take(rowLimit)];
                truncated = true;
            }

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

    /// <summary>QRY_DISCONNECTED → rcd.query.disconnected etc.</summary>
    private static string ToErrorCode(string compilationCode) =>
        "rcd.query." + compilationCode.Replace("QRY_", "", StringComparison.Ordinal).ToLowerInvariant();
}
