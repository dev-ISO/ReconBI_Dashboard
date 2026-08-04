using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

[Route("models")]
public sealed class ModelsController(
    DataModelService models,
    ICurrentUserProvider currentUser) : RcdControllerBase
{
    [HttpGet]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IReadOnlyList<ModelSummaryResponse>> List(CancellationToken ct) =>
        (await models.ListVisibleAsync(ct))
            .Select(m => new ModelSummaryResponse(
                m.Id, m.Name, m.Description, m.DataSourceName, m.IsShared, m.OwnerIsMe, m.UpdatedAtUtc))
            .ToArray();

    [HttpGet("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Get(int id, CancellationToken ct)
    {
        var result = await models.GetAsync(id, ct);
        return result.Succeeded
            ? Ok(DtoMapping.ToModelResponse(result.Value!, currentUser.GetUserId()))
            : FromError(result.Error!);
    }

    [HttpPost]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Create([FromBody] SaveModelRequest request, CancellationToken ct)
    {
        var result = await models.CreateAsync(ToSaveRequest(request), ct);
        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id },
                DtoMapping.ToModelResponse(result.Value!, currentUser.GetUserId()))
            : FromError(result.Error!);
    }

    [HttpPut("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Update(int id, [FromBody] SaveModelRequest request, CancellationToken ct)
    {
        var result = await models.UpdateAsync(id, ToSaveRequest(request), ct);
        return result.Succeeded
            ? Ok(DtoMapping.ToModelResponse(result.Value!, currentUser.GetUserId()))
            : FromError(result.Error!);
    }

    [HttpDelete("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var result = await models.DeleteAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    /// <summary>Dry-run validation against the live catalog; 200 with findings even when invalid.</summary>
    [HttpPost("validate")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Validate([FromBody] ValidateModelRequest request, CancellationToken ct)
    {
        var result = await models.ValidateAsync(request.DataSourceName, request.Definition.GetRawText(), ct);
        return result.Succeeded
            ? Ok(new ValidateModelResponse(
                result.Value!.Valid,
                result.Value.Result.Issues.Select(DtoMapping.ToIssueDto).ToArray()))
            : FromError(result.Error!);
    }

    private static ModelSaveRequest ToSaveRequest(SaveModelRequest request) =>
        new(request.Name, request.Description, request.DataSourceName,
            request.Definition.GetRawText(), request.IsShared, request.ExpectedUpdatedAtUtc);
}
