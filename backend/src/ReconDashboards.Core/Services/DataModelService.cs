using System.Text;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Services;

public sealed record ModelSummary(
    int Id,
    string Name,
    string? Description,
    string DataSourceName,
    bool IsShared,
    bool OwnerIsMe,
    DateTime UpdatedAtUtc);

public sealed record ModelSaveRequest(
    string Name,
    string? Description,
    string DataSourceName,
    string DefinitionJson,
    bool IsShared = false,
    DateTime? ExpectedUpdatedAtUtc = null);

public sealed record ModelValidationOutcome(bool Valid, ValidationResult Result);

/// <summary>
/// CRUD + validation for semantic models. Every save re-validates the parsed
/// definition against the live (cached) catalog snapshot; a definition that
/// fails validation never reaches the database.
/// </summary>
public sealed class DataModelService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    IDataSourceRegistry registry,
    ISchemaCache schemaCache,
    SemanticModelValidator validator,
    ReconDashboardsOptions options,
    TimeProvider timeProvider)
{
    public async Task<IReadOnlyList<ModelSummary>> ListVisibleAsync(CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        return await db.DataModels.AsNoTracking()
            .Where(m => !m.IsDeleted && (m.OwnerUserId == userId || m.IsShared))
            .OrderBy(m => m.Name)
            .Select(m => new ModelSummary(
                m.Id, m.Name, m.Description, m.DataSourceName, m.IsShared,
                m.OwnerUserId == userId, m.UpdatedAtUtc))
            .ToListAsync(ct);
    }

    public async Task<ServiceResult<SemanticModel>> GetAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.DataModels.AsNoTracking()
            .FirstOrDefaultAsync(m => m.Id == id && !m.IsDeleted, ct);

        if (record is null || (record.OwnerUserId != userId && !record.IsShared))
        {
            return ServiceResult<SemanticModel>.Fail(
                ServiceErrorKind.NotFound, "rcd.model.not_found", $"Model {id} does not exist or is not visible to you.");
        }

        var definition = ModelJson.TryDeserialize(record.DefinitionJson, out var parseError);
        if (definition is null)
        {
            return ServiceResult<SemanticModel>.Fail(
                ServiceErrorKind.Conflict, "rcd.model.corrupt",
                $"Stored model {id} could not be parsed: {parseError}");
        }

        return ServiceResult<SemanticModel>.Ok(Materialize(record, definition));
    }

    public async Task<ServiceResult<SemanticModel>> CreateAsync(ModelSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        var prepared = await PrepareAsync(request, ct);
        if (!prepared.Succeeded)
        {
            return ServiceResult<SemanticModel>.Fail(prepared.Error!);
        }

        if (request.IsShared && !currentUser.CanManageShared)
        {
            return SharingForbidden();
        }

        var ownedCount = await db.DataModels.CountAsync(
            m => m.OwnerUserId == userId && !m.IsDeleted, ct);
        if (ownedCount >= options.Limits.MaxModelsPerUser)
        {
            return ServiceResult<SemanticModel>.Fail(
                ServiceErrorKind.LimitExceeded, "rcd.limit.models",
                $"You already have {ownedCount} models (limit {options.Limits.MaxModelsPerUser}).");
        }

        if (await NameTakenAsync(userId, request.Name, excludeId: null, ct))
        {
            return NameConflict(request.Name);
        }

        var now = timeProvider.GetUtcNow().UtcDateTime;
        var record = new DataModelRecord
        {
            Name = request.Name.Trim(),
            Description = request.Description,
            DataSourceName = request.DataSourceName,
            DefinitionJson = ModelJson.Serialize(prepared.Value!),
            OwnerUserId = userId,
            IsShared = request.IsShared,
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
        };

        db.DataModels.Add(record);
        await db.SaveChangesAsync(ct);

        return ServiceResult<SemanticModel>.Ok(Materialize(record, prepared.Value!));
    }

    public async Task<ServiceResult<SemanticModel>> UpdateAsync(int id, ModelSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.DataModels.FirstOrDefaultAsync(m => m.Id == id && !m.IsDeleted, ct);

        if (record is null || (record.OwnerUserId != userId && !record.IsShared))
        {
            return ServiceResult<SemanticModel>.Fail(
                ServiceErrorKind.NotFound, "rcd.model.not_found", $"Model {id} does not exist or is not visible to you.");
        }

        if (record.OwnerUserId != userId && !currentUser.CanManageShared)
        {
            return ServiceResult<SemanticModel>.Fail(
                ServiceErrorKind.Forbidden, "rcd.model.forbidden",
                "Only the owner (or an administrator) can edit this model.");
        }

        if (request.IsShared != record.IsShared && !currentUser.CanManageShared)
        {
            return SharingForbidden();
        }

        if (request.ExpectedUpdatedAtUtc is { } expected
            && Math.Abs((record.UpdatedAtUtc - expected).TotalMilliseconds) > 1)
        {
            return ServiceResult<SemanticModel>.Fail(
                ServiceErrorKind.Conflict, "rcd.model.stale",
                "The model was changed by someone else since you loaded it. Reload and re-apply your edits.");
        }

        var prepared = await PrepareAsync(request, ct);
        if (!prepared.Succeeded)
        {
            return ServiceResult<SemanticModel>.Fail(prepared.Error!);
        }

        if (await NameTakenAsync(record.OwnerUserId, request.Name, excludeId: id, ct))
        {
            return NameConflict(request.Name);
        }

        record.Name = request.Name.Trim();
        record.Description = request.Description;
        record.DataSourceName = request.DataSourceName;
        record.DefinitionJson = ModelJson.Serialize(prepared.Value!);
        record.IsShared = request.IsShared;
        record.UpdatedAtUtc = timeProvider.GetUtcNow().UtcDateTime;

        await db.SaveChangesAsync(ct);

        return ServiceResult<SemanticModel>.Ok(Materialize(record, prepared.Value!));
    }

    public async Task<ServiceResult<bool>> DeleteAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.DataModels.FirstOrDefaultAsync(m => m.Id == id && !m.IsDeleted, ct);

        if (record is null || (record.OwnerUserId != userId && !record.IsShared))
        {
            return ServiceResult<bool>.Fail(
                ServiceErrorKind.NotFound, "rcd.model.not_found", $"Model {id} does not exist or is not visible to you.");
        }

        if (record.OwnerUserId != userId && !currentUser.CanManageShared)
        {
            return ServiceResult<bool>.Fail(
                ServiceErrorKind.Forbidden, "rcd.model.forbidden",
                "Only the owner (or an administrator) can delete this model.");
        }

        record.IsDeleted = true;
        record.UpdatedAtUtc = timeProvider.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);
        return ServiceResult<bool>.Ok(true);
    }

    /// <summary>Dry-run validation for the GUI; returns findings even when invalid.</summary>
    public async Task<ServiceResult<ModelValidationOutcome>> ValidateAsync(
        string dataSourceName, string definitionJson, CancellationToken ct)
    {
        if (!registry.TryGet(dataSourceName, out var source))
        {
            return ServiceResult<ModelValidationOutcome>.Fail(
                ServiceErrorKind.BadRequest, "rcd.source.unknown",
                $"No data source named '{dataSourceName}' is registered.");
        }

        if (Encoding.UTF8.GetByteCount(definitionJson) > options.Limits.MaxModelDefinitionBytes)
        {
            return ServiceResult<ModelValidationOutcome>.Fail(
                ServiceErrorKind.LimitExceeded, "rcd.limit.model_size",
                $"Model definition exceeds {options.Limits.MaxModelDefinitionBytes / 1024} KB.");
        }

        var definition = ModelJson.TryDeserialize(definitionJson, out var parseError);
        if (definition is null)
        {
            return ServiceResult<ModelValidationOutcome>.Fail(
                ServiceErrorKind.BadRequest, "rcd.model.invalid_json", parseError!);
        }

        var schema = await schemaCache.GetAsync(source.Name, ct);
        var result = validator.Validate(definition, schema);
        return ServiceResult<ModelValidationOutcome>.Ok(new ModelValidationOutcome(result.IsValid, result));
    }

    /// <summary>Shared parse + cap + catalog-validation pipeline for create/update.</summary>
    private async Task<ServiceResult<ModelDefinition>> PrepareAsync(ModelSaveRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            return ServiceResult<ModelDefinition>.Fail(
                ServiceErrorKind.BadRequest, "rcd.model.name_required", "Model name is required.");
        }

        var outcome = await ValidateAsync(request.DataSourceName, request.DefinitionJson, ct);
        if (!outcome.Succeeded)
        {
            return ServiceResult<ModelDefinition>.Fail(outcome.Error!);
        }

        if (!outcome.Value!.Valid)
        {
            return ServiceResult<ModelDefinition>.Fail(new ServiceError(
                ServiceErrorKind.Validation, "rcd.model.invalid",
                "The model definition failed validation against the current database schema.",
                outcome.Value.Result));
        }

        // Round-trip through the parsed form so what we persist is normalized.
        var definition = ModelJson.TryDeserialize(request.DefinitionJson, out _)!;
        return ServiceResult<ModelDefinition>.Ok(definition);
    }

    private async Task<bool> NameTakenAsync(string ownerUserId, string name, int? excludeId, CancellationToken ct)
    {
        var trimmed = name.Trim();
        return await db.DataModels.AnyAsync(
            m => m.OwnerUserId == ownerUserId
                && !m.IsDeleted
                && m.Name == trimmed
                && (excludeId == null || m.Id != excludeId),
            ct);
    }

    private static ServiceResult<SemanticModel> SharingForbidden() =>
        ServiceResult<SemanticModel>.Fail(
            ServiceErrorKind.Forbidden, "rcd.model.share_forbidden",
            "Sharing or unsharing models requires administrator rights.");

    private static ServiceResult<SemanticModel> NameConflict(string name) =>
        ServiceResult<SemanticModel>.Fail(
            ServiceErrorKind.Conflict, "rcd.model.name_conflict",
            $"You already have a model named '{name.Trim()}'.");

    private static SemanticModel Materialize(DataModelRecord record, ModelDefinition definition) =>
        new(record.Id, record.Name, record.Description, record.DataSourceName,
            record.OwnerUserId, record.IsShared, record.CreatedAtUtc, record.UpdatedAtUtc, definition);
}
