using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Hosting;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.AspNetCore.Controllers;

[Route("query")]
[EnableRateLimiting(RcdRateLimiting.QueryPolicyName)]
public sealed class QueryController(
    ChartQueryService queryService,
    ReconDashboardsOptions options,
    IHostEnvironment environment) : RcdControllerBase
{
    /// <summary>Compiles and executes a chart query spec against its model's data source.</summary>
    [HttpPost]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Run([FromBody] ChartQuerySpec spec, CancellationToken ct)
    {
        var result = await queryService.RunAsync(spec, User, ct);
        if (!result.Succeeded)
        {
            return FromError(result.Error!);
        }

        var includeSql = options.IncludeSqlInResponse && environment.IsDevelopment();
        return Ok(DtoMapping.ToQueryResponse(result.Value!, includeSql));
    }

    /// <summary>
    /// CSV export of a chart query — same auth policy, rate limiting, model
    /// visibility, and row-level scoping as the query endpoint. "summarized"
    /// streams the aggregated result; "underlying" streams the anchor table's
    /// raw rows with the spec's filters applied. Truncation is signalled via
    /// the X-Rcd-Truncated response header.
    /// </summary>
    [HttpPost("export")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Export([FromBody] ExportRequest request, CancellationToken ct)
    {
        if (request.Spec is null)
        {
            return BadRequest();
        }

        var result = await queryService.RunExportAsync(request.Spec, request.Mode, request.MaxRows, User, ct);
        return result.Succeeded ? new CsvExportResult(result.Value!) : FromError(result.Error!);
    }

    /// <summary>
    /// JSON "underlying data" of a chart query — the anchor table's raw rows
    /// (every physical column, no aggregation) with the spec's filters applied.
    /// Same auth policy, rate limiting, model visibility, fail-closed row-level
    /// scoping, and read-only/timeout execution path as the underlying export
    /// mode; the response reuses the /query result shape (columns/rows/meta,
    /// truncation in meta.truncated). maxRows defaults to 1000 and clamps to
    /// [1, 10000]. The spec's `having` is ignored — it is a post-aggregation
    /// concept with no meaning on row-level output.
    /// </summary>
    [HttpPost("underlying")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Underlying([FromBody] UnderlyingRequest request, CancellationToken ct)
    {
        if (request.Spec is null)
        {
            return BadRequest();
        }

        var result = await queryService.RunUnderlyingAsync(request.Spec, request.MaxRows, User, ct);
        if (!result.Succeeded)
        {
            return FromError(result.Error!);
        }

        var includeSql = options.IncludeSqlInResponse && environment.IsDevelopment();
        return Ok(DtoMapping.ToQueryResponse(result.Value!, includeSql));
    }

    /// <summary>Distinct values for slicer/filter dropdowns (searchable, capped).</summary>
    [HttpPost("values")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> DistinctValues([FromBody] DistinctValuesSpec spec, CancellationToken ct)
    {
        var result = await queryService.GetDistinctValuesAsync(spec, User, ct);
        return result.Succeeded ? Ok(result.Value!) : FromError(result.Error!);
    }
}

public static class RcdRateLimiting
{
    public const string QueryPolicyName = "rcd-query";
}
