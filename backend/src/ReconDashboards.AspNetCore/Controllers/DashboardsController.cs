using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

[Route("dashboards")]
public sealed class DashboardsController(DashboardService dashboards) : RcdControllerBase
{
    [HttpGet]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IReadOnlyList<DashboardSummaryResponse>> List(CancellationToken ct) =>
        (await dashboards.ListVisibleAsync(ct))
            .Select(d => new DashboardSummaryResponse(
                d.Id, d.Name, d.Description, d.ModelId, d.IsShared, d.OwnerIsMe, d.UpdatedAtUtc))
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
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Update(int id, [FromBody] SaveDashboardRequest request, CancellationToken ct)
    {
        var result = await dashboards.UpdateAsync(id, ToSaveRequest(request), ct);
        return result.Succeeded ? Ok(ToResponse(result.Value!)) : FromError(result.Error!);
    }

    [HttpDelete("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var result = await dashboards.DeleteAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    /// <summary>Copies a visible (e.g. shared) dashboard as a new caller-owned one.</summary>
    [HttpPost("{id:int}/duplicate")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Duplicate(int id, CancellationToken ct)
    {
        var result = await dashboards.DuplicateAsync(id, ct);
        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id }, ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    private static DashboardSaveRequest ToSaveRequest(SaveDashboardRequest request) =>
        new(request.Name, request.Description, request.ModelId,
            request.Layout.GetRawText(), request.IsShared, request.ExpectedUpdatedAtUtc);

    private static DashboardResponse ToResponse(DashboardDetail detail) =>
        new(detail.Id, detail.Name, detail.Description, detail.ModelId, detail.IsShared,
            detail.OwnerIsMe, detail.CreatedAtUtc, detail.UpdatedAtUtc, detail.Layout);
}
