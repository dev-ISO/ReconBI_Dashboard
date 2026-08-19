using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

// Update/delete/shares/leave/activity sit in the VIEW policy slot: the service
// enforces the real per-dashboard rights (a grantee with edit permission may
// lack the host's Author capability). Create/duplicate stay Author.
[Route("dashboards")]
public sealed class DashboardsController(DashboardService dashboards) : RcdControllerBase
{
    [HttpGet]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IReadOnlyList<DashboardSummaryResponse>> List(CancellationToken ct) =>
        (await dashboards.ListVisibleAsync(ct))
            .Select(d => new DashboardSummaryResponse(
                d.Id, d.Name, d.Description, d.ModelId, d.IsShared, d.OwnerIsMe, d.UpdatedAtUtc,
                d.IsSystem, d.OwnerDisplayName, ToAccessResponse(d.MyAccess), d.ShareCount))
            .ToArray();

    [HttpGet("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Get(int id, CancellationToken ct)
    {
        var result = await dashboards.GetAsync(id, ct);
        return result.Succeeded ? Ok(ToResponse(result.Value!)) : FromError(result.Error!);
    }

    [HttpPost]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Create([FromBody] SaveDashboardRequest request, CancellationToken ct)
    {
        var result = await dashboards.CreateAsync(ToSaveRequest(request), ct);
        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id }, ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpPut("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Update(int id, [FromBody] SaveDashboardRequest request, CancellationToken ct)
    {
        var result = await dashboards.UpdateAsync(id, ToSaveRequest(request), ct);
        return result.Succeeded ? Ok(ToResponse(result.Value!)) : FromError(result.Error!);
    }

    /// <summary>Owner/admin: soft delete. Grantee: removes only their share row.</summary>
    [HttpDelete("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var result = await dashboards.DeleteAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    /// <summary>Copies a visible (shared/published/built-in) dashboard as a new caller-owned one.</summary>
    [HttpPost("{id:int}/duplicate")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Duplicate(int id, CancellationToken ct)
    {
        var result = await dashboards.DuplicateAsync(id, ct);
        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id }, ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpGet("{id:int}/shares")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> GetShares(int id, CancellationToken ct)
    {
        var result = await dashboards.GetSharesAsync(id, ct);
        return result.Succeeded
            ? Ok(new DashboardSharesResponse(result.Value!.Select(ToShareResponse).ToArray()))
            : FromError(result.Error!);
    }

    /// <summary>Replaces the full grant set (bulk apply from the Share dialog).</summary>
    [HttpPut("{id:int}/shares")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> SaveShares(
        int id, [FromBody] SaveDashboardSharesRequest request, CancellationToken ct)
    {
        var grants = (request.Shares ?? [])
            .Select(s => new DashboardShareGrant(
                s.UserId, s.CanEditLayout, s.CanManagePages, s.CanEditCharts,
                s.CanMoveTiles, s.CanDeleteContent))
            .ToArray();
        var result = await dashboards.ReplaceSharesAsync(id, grants, ct);
        return result.Succeeded
            ? Ok(new DashboardSharesResponse(result.Value!.Select(ToShareResponse).ToArray()))
            : FromError(result.Error!);
    }

    /// <summary>Removes the caller's own share row ("remove from my list").</summary>
    [HttpPost("{id:int}/leave")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Leave(int id, CancellationToken ct)
    {
        var result = await dashboards.LeaveAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    [HttpGet("{id:int}/activity")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Activity(
        int id, [FromQuery] int? limit, [FromQuery] long? beforeId, CancellationToken ct)
    {
        var result = await dashboards.ListActivityAsync(id, limit, beforeId, ct);
        return result.Succeeded
            ? Ok(new DashboardActivityResponse(result.Value!.Select(ToActivityResponse).ToArray()))
            : FromError(result.Error!);
    }

    private static DashboardSaveRequest ToSaveRequest(SaveDashboardRequest request) =>
        new(request.Name, request.Description, request.ModelId,
            request.Layout.GetRawText(), request.IsShared, request.ExpectedUpdatedAtUtc);

    private static DashboardResponse ToResponse(DashboardDetail detail) =>
        new(detail.Id, detail.Name, detail.Description, detail.ModelId, detail.IsShared,
            detail.OwnerIsMe, detail.CreatedAtUtc, detail.UpdatedAtUtc,
            detail.IsSystem, detail.OwnerDisplayName, ToAccessResponse(detail.MyAccess),
            detail.ShareCount, detail.Layout);

    private static DashboardAccessResponse ToAccessResponse(DashboardAccess access) =>
        new(access.IsOwner, access.CanEdit, access.CanEditLayout, access.CanManagePages,
            access.CanEditCharts, access.CanMoveTiles, access.CanDeleteContent,
            access.ViaShare, access.ViaPublish);

    private static DashboardShareResponse ToShareResponse(DashboardShareInfo share) =>
        new(share.UserId, share.DisplayName, share.CanEditLayout, share.CanManagePages,
            share.CanEditCharts, share.CanMoveTiles, share.CanDeleteContent,
            share.GrantedByUserId, share.GrantedByDisplayName, share.CreatedAtUtc, share.UpdatedAtUtc);

    /// <summary>
    /// The stored DetailJson was serialized camelCase by the service, so it is
    /// re-emitted as-is; a corrupt row falls back to null rather than failing
    /// the whole page.
    /// </summary>
    private static ActivityEntryResponse ToActivityResponse(DashboardActivityEntry entry)
    {
        JsonElement? detail = null;
        if (entry.DetailJson is { Length: > 0 } json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                detail = doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                detail = null;
            }
        }

        return new ActivityEntryResponse(
            entry.Id, entry.UserId, entry.DisplayName, entry.Action, detail, entry.AtUtc);
    }
}
