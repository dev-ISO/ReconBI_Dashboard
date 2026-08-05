using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

/// <summary>
/// Dashboard snapshot subscriptions. View-policy users may manage their OWN
/// subscriptions, but only for dashboards they can read — the service enforces
/// dashboard visibility on create/update, and mutations of other users'
/// subscriptions require admin rights (CanManageShared).
/// </summary>
[Route("subscriptions")]
[RcdPolicySlot(RcdPolicySlot.View)]
public sealed class SubscriptionsController(SubscriptionService subscriptions) : RcdControllerBase
{
    /// <summary>Lists the caller's subscriptions, optionally for one dashboard.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<SubscriptionResponse>> List([FromQuery] int? dashboardId, CancellationToken ct) =>
        (await subscriptions.ListMineAsync(dashboardId, ct))
            .Select(SchedulingDtoMapping.ToResponse)
            .ToArray();

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SaveSubscriptionRequest request, CancellationToken ct)
    {
        var result = await subscriptions.CreateAsync(SchedulingDtoMapping.ToSaveRequest(request), ct);
        return result.Succeeded
            ? StatusCode(StatusCodes.Status201Created, SchedulingDtoMapping.ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] SaveSubscriptionRequest request, CancellationToken ct)
    {
        var result = await subscriptions.UpdateAsync(id, SchedulingDtoMapping.ToSaveRequest(request), ct);
        return result.Succeeded ? Ok(SchedulingDtoMapping.ToResponse(result.Value!)) : FromError(result.Error!);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var result = await subscriptions.DeleteAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }
}
