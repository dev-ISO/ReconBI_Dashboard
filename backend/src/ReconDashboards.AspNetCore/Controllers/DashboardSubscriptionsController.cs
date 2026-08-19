using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

/// <summary>
/// Dashboard-scoped subscription actions. Separate from DashboardsController
/// so the subscription feature area stays in one place; the route prefix
/// convention mounts it at {prefix}/v1/dashboards/{dashboardId}/subscriptions.
/// </summary>
[Route("dashboards/{dashboardId:int}/subscriptions")]
[RcdPolicySlot(RcdPolicySlot.View)]
public sealed class DashboardSubscriptionsController(SubscriptionService subscriptions) : RcdControllerBase
{
    /// <summary>
    /// Renders an UNSAVED subscription draft against this dashboard:
    /// 200 { subject, html }, chart images as data: URIs. The caller is the
    /// owner-to-be, so the render runs under their identity; dashboard access
    /// = the same visibility check subscription save applies. No state
    /// change, no dispatch row, no email.
    /// </summary>
    [HttpPost("preview")]
    public async Task<IActionResult> PreviewDraft(
        int dashboardId, [FromBody] DraftSubscriptionPreviewRequest request, CancellationToken ct)
    {
        var result = await subscriptions.PreviewDraftAsync(
            dashboardId,
            request.Format ?? SubscriptionFormat.Html,
            SchedulingDtoMapping.ToContentConfig(request.Content),
            ct);
        return result.Succeeded
            ? Ok(new SubscriptionPreviewResponse(result.Value!.Subject, result.Value.Html))
            : FromError(result.Error!);
    }
}
