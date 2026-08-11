using System.Text;
using System.Text.Json;
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
                m.Id, m.Name, m.Description, m.DataSourceName, m.IsShared, m.OwnerIsMe, m.UpdatedAtUtc, m.IsSystem))
            .ToArray();

    [HttpGet("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Get(int id, CancellationToken ct)
    {
        var result = await models.GetAsync(id, ct);
        return result.Succeeded
            ? Ok(ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpPost]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Create([FromBody] SaveModelRequest request, CancellationToken ct)
    {
        var result = await models.CreateAsync(ToSaveRequest(request), ct);
        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id },
                ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpPut("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Update(int id, [FromBody] SaveModelRequest request, CancellationToken ct)
    {
        var result = await models.UpdateAsync(id, ToSaveRequest(request), ct);
        return result.Succeeded
            ? Ok(ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpDelete("{id:int}")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var result = await models.DeleteAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    /// <summary>
    /// Copies a model visible to the caller (typically the shared default) into a
    /// new one they own and can edit. Named "{source} (copy)", de-duplicated.
    /// </summary>
    [HttpPost("{id:int}/duplicate")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Duplicate(int id, CancellationToken ct)
    {
        var result = await models.DuplicateAsync(id, ct);
        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id },
                ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    /// <summary>
    /// The model as a portable JSON document, offered as a download. Readable by
    /// anyone who can see the model; the body round-trips through /models/import.
    /// </summary>
    [HttpGet("{id:int}/export")]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IActionResult> Export(int id, CancellationToken ct)
    {
        var result = await models.ExportAsync(id, ct);
        if (!result.Succeeded)
        {
            return FromError(result.Error!);
        }

        Response.Headers.ContentDisposition =
            $"attachment; filename=\"{SafeFileName(result.Value!.Name)}.model.json\"";
        return Ok(DtoMapping.ToModelExportResponse(result.Value!));
    }

    /// <summary>
    /// Creates a caller-owned model from an exported document. Validation, limits
    /// and name conflicts surface exactly as they do for POST /models.
    /// </summary>
    [HttpPost("import")]
    [RcdPolicySlot(RcdPolicySlot.Author)]
    public async Task<IActionResult> Import([FromBody] ImportModelRequest request, CancellationToken ct)
    {
        if (request.Definition.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            return FromError(new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.model.invalid_json",
                "The imported document has no 'definition' object."));
        }

        var result = await models.ImportAsync(
            new ModelSaveRequest(
                request.Name, request.Description, request.DataSourceName, request.Definition.GetRawText()),
            ct);

        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id },
                ToResponse(result.Value!))
            : FromError(result.Error!);
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

    /// <summary>
    /// Collapses a model name to an ASCII slug safe to embed in a
    /// Content-Disposition header; never empty, never header-breaking.
    /// </summary>
    private static string SafeFileName(string name)
    {
        var builder = new StringBuilder(name.Length);
        foreach (var ch in name)
        {
            if (char.IsAsciiLetterOrDigit(ch))
            {
                builder.Append(ch);
            }
            else if (builder.Length > 0 && builder[^1] != '-')
            {
                builder.Append('-');
            }
        }

        var slug = builder.ToString().Trim('-');
        if (slug.Length > 64)
        {
            slug = slug[..64].TrimEnd('-');
        }

        return slug.Length == 0 ? "model" : slug;
    }

    private ModelResponse ToResponse(Core.Modeling.SemanticModel model) =>
        DtoMapping.ToModelResponse(model, currentUser.GetUserId(), models.IsSystemOwner(model.OwnerUserId));

    private static ModelSaveRequest ToSaveRequest(SaveModelRequest request) =>
        new(request.Name, request.Description, request.DataSourceName,
            request.Definition.GetRawText(), request.IsShared, request.ExpectedUpdatedAtUtc);
}
