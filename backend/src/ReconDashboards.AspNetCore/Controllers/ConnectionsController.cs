using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.AspNetCore.Controllers;

[Route("connections")]
public sealed class ConnectionsController(
    IDataSourceRegistry registry,
    ISchemaCache schemaCache,
    ILogger<ConnectionsController> logger) : RcdControllerBase
{
    /// <summary>Registered data sources. Names and descriptions only — never connection strings.</summary>
    [HttpGet]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public IReadOnlyList<ConnectionResponse> List() =>
        registry.List()
            .Select(s => new ConnectionResponse(s.Name, s.Description, s.Provider))
            .ToArray();

    /// <summary>Allowlist-filtered catalog + FK-derived relationship suggestions. Feeds the modeling GUI.</summary>
    [HttpGet("{name}/catalog")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public Task<IActionResult> GetCatalog(string name, CancellationToken ct) => LoadCatalogAsync(name, refresh: false, ct);

    /// <summary>Invalidates the cached snapshot and re-reads the catalog.</summary>
    [HttpPost("{name}/catalog/refresh")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public Task<IActionResult> RefreshCatalog(string name, CancellationToken ct) => LoadCatalogAsync(name, refresh: true, ct);

    private async Task<IActionResult> LoadCatalogAsync(string name, bool refresh, CancellationToken ct)
    {
        if (!registry.TryGet(name, out _))
        {
            return Rcd404("rcd.source.unknown", $"No data source named '{name}' is registered.");
        }

        try
        {
            var schema = refresh
                ? await schemaCache.RefreshAsync(name, ct)
                : await schemaCache.GetAsync(name, ct);
            return Ok(DtoMapping.ToCatalogResponse(schema));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Database details go to logs only; clients get a stable code.
            logger.LogError(ex, "Catalog introspection failed for data source {DataSource}", name);
            var problem = new ProblemDetails
            {
                Title = "rcd.source.unreachable",
                Detail = $"Data source '{name}' could not be introspected. Check server logs for details.",
                Status = StatusCodes.Status502BadGateway,
            };
            problem.Extensions["errorCode"] = "rcd.source.unreachable";
            return new ObjectResult(problem) { StatusCode = StatusCodes.Status502BadGateway };
        }
    }
}
