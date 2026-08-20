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
public sealed class DashboardsController(
    DashboardService dashboards,
    DashboardOpService dashboardOps) : RcdControllerBase
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

    /// <summary>
    /// Metadata-only write: { name?, description?, modelId?, isShared? } — absent
    /// fields keep their stored value; description/modelId accept null as a clear.
    /// Never reads or writes the layout and takes no expectedUpdatedAtUtc (metadata
    /// is not the doc). Bound as a raw JsonElement because record binding cannot
    /// tell an absent field from an explicit null, and this endpoint's whole
    /// contract IS that distinction.
    /// </summary>
    [HttpPatch("{id:int}/meta")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> PatchMeta(int id, [FromBody] JsonElement body, CancellationToken ct)
    {
        if (ToMetaPatch(body) is not { } patch)
        {
            return FromError(new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.dashboard.invalid_meta",
                "PATCH meta takes a JSON object with optional fields: name (string), description (string or null), modelId (number or null), isShared (boolean)."));
        }

        var result = await dashboards.PatchMetaAsync(id, patch, ct);
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

    // ---------------- collaborative editing (COLLAB-DESIGN wave 1) ----------------
    // View slot like Update: the service enforces the real per-dashboard rights
    // (a grantee with edit permission may lack the host's Author capability).

    /// <summary>
    /// Applies ONE element-scoped edit op inside a row-locked transaction,
    /// classified with the differ's rules and gated on the caller's share
    /// flags; the committed op is broadcast to collaborators by the host's
    /// IRcdDashboardOpNotifier bridge.
    /// </summary>
    [HttpPost("{id:int}/ops")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> ApplyOp(int id, [FromBody] DashboardOpRequest request, CancellationToken ct)
    {
        // A body without "payload" binds as JsonValueKind.Undefined, where
        // GetRawText() throws — map it to the empty string so the service
        // answers with its clean op_invalid instead of a 500.
        var payloadJson = request.Payload.ValueKind is JsonValueKind.Undefined
            ? ""
            : request.Payload.GetRawText();
        var result = await dashboardOps.ApplyAsync(
            id,
            new DashboardOpSubmission(
                request.OpId, request.TargetKind, request.TargetId,
                payloadJson, request.BaseUpdatedAtUtc),
            ct);
        return result.Succeeded
            ? Ok(new DashboardOpResponse(result.Value!.OpId, result.Value.Class, result.Value.UpdatedAtUtc))
            : FromError(result.Error!);
    }

    /// <summary>Acquire or heartbeat a soft tile lock (30 s TTL). 409 rcd.dashboard.tile_locked names the current holder.</summary>
    [HttpPost("{id:int}/tiles/{tileId}/lock")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> AcquireTileLock(int id, string tileId, CancellationToken ct)
    {
        var result = await dashboardOps.AcquireTileLockAsync(id, tileId, ct);
        return result.Succeeded
            ? Ok(ToLockResponse(result.Value!))
            : FromError(result.Error!);
    }

    /// <summary>Release the caller's soft tile lock. Idempotent — releasing an expired/stolen lock still 204s.</summary>
    [HttpDelete("{id:int}/tiles/{tileId}/lock")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> ReleaseTileLock(int id, string tileId, CancellationToken ct)
    {
        var result = await dashboardOps.ReleaseTileLockAsync(id, tileId, ct);
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

    /// <summary>
    /// Strict shape-check + absent-vs-null preservation for PATCH meta (null =
    /// the body is not a usable patch). Unknown fields are rejected, not
    /// ignored — the same strictness doctrine as op payloads: a typo'd field
    /// must fail loudly instead of silently changing nothing.
    /// </summary>
    private static DashboardMetaPatch? ToMetaPatch(JsonElement body)
    {
        if (body.ValueKind is not JsonValueKind.Object)
        {
            return null;
        }

        string? name = null;
        var descriptionSet = false;
        string? description = null;
        var modelIdSet = false;
        int? modelId = null;
        bool? isShared = null;

        foreach (var property in body.EnumerateObject())
        {
            switch (property.Name)
            {
                case "name" when property.Value.ValueKind is JsonValueKind.String:
                    name = property.Value.GetString();
                    break;
                case "description" when property.Value.ValueKind is JsonValueKind.String or JsonValueKind.Null:
                    descriptionSet = true;
                    description = property.Value.ValueKind is JsonValueKind.Null
                        ? null
                        : property.Value.GetString();
                    break;
                case "modelId" when property.Value.ValueKind is JsonValueKind.Null:
                    modelIdSet = true;
                    modelId = null;
                    break;
                case "modelId" when property.Value.ValueKind is JsonValueKind.Number
                    && property.Value.TryGetInt32(out var parsedModelId):
                    modelIdSet = true;
                    modelId = parsedModelId;
                    break;
                case "isShared" when property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                    isShared = property.Value.GetBoolean();
                    break;
                default:
                    return null;
            }
        }

        return new DashboardMetaPatch(name, descriptionSet, description, modelIdSet, modelId, isShared);
    }

    private static DashboardResponse ToResponse(DashboardDetail detail) =>
        new(detail.Id, detail.Name, detail.Description, detail.ModelId, detail.IsShared,
            detail.OwnerIsMe, detail.CreatedAtUtc, detail.UpdatedAtUtc,
            detail.IsSystem, detail.OwnerDisplayName, detail.OwnerUserId,
            ToAccessResponse(detail.MyAccess), detail.ShareCount, detail.Layout);

    private static DashboardAccessResponse ToAccessResponse(DashboardAccess access) =>
        new(access.IsOwner, access.CanEdit, access.CanEditLayout, access.CanManagePages,
            access.CanEditCharts, access.CanMoveTiles, access.CanDeleteContent,
            access.ViaShare, access.ViaPublish);

    private static DashboardTileLockResponse ToLockResponse(DashboardTileLockInfo info) =>
        new(info.TileId, info.HolderUserId, info.HolderDisplayName, info.AcquiredAtUtc, info.ExpiresAtUtc);

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
