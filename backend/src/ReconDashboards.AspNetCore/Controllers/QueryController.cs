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
