using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

/// <summary>
/// Data alerts: single-value queries evaluated on a cadence under the owner's
/// row-filter identity. CRUD is owner-or-admin; recent-firings powers the
/// frontend's in-app notification poll.
/// </summary>
[Route("alerts")]
[RcdPolicySlot(RcdPolicySlot.View)]
public sealed class AlertsController(AlertService alerts) : RcdControllerBase
{
    /// <summary>Lists the caller's alerts, optionally for one dashboard.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<AlertResponse>> List([FromQuery] int? dashboardId, CancellationToken ct) =>
        (await alerts.ListMineAsync(dashboardId, ct))
            .Select(SchedulingDtoMapping.ToResponse)
            .ToArray();

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SaveAlertRequest request, CancellationToken ct)
    {
        var result = await alerts.CreateAsync(SchedulingDtoMapping.ToSaveRequest(request), ct);
        return result.Succeeded
            ? StatusCode(StatusCodes.Status201Created, SchedulingDtoMapping.ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] SaveAlertRequest request, CancellationToken ct)
    {
        var result = await alerts.UpdateAsync(id, SchedulingDtoMapping.ToSaveRequest(request), ct);
        return result.Succeeded ? Ok(SchedulingDtoMapping.ToResponse(result.Value!)) : FromError(result.Error!);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var result = await alerts.DeleteAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    /// <summary>Evaluates the alert now (owner identity, no state change): value + wouldFire.</summary>
    [HttpPost("{id:int}/test")]
    public async Task<IActionResult> Test(int id, CancellationToken ct)
    {
        var result = await alerts.TestAsync(id, ct);
        return result.Succeeded
            ? Ok(new AlertTestResponse(result.Value!.Value, result.Value.WouldFire))
            : FromError(result.Error!);
    }

    /// <summary>Firings from the last 24h on alerts the caller may see (own, or on dashboards they can view).</summary>
    [HttpGet("recent-firings")]
    public async Task<IReadOnlyList<AlertFiringResponse>> RecentFirings(
        [FromQuery] int? dashboardId, CancellationToken ct) =>
        (await alerts.RecentFiringsAsync(dashboardId, ct))
            .Select(SchedulingDtoMapping.ToResponse)
            .ToArray();
}
