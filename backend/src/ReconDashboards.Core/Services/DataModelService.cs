using System.Text;
using System.Text.Json;
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
    DateTime UpdatedAtUtc,
    bool IsSystem);

public sealed record ModelSaveRequest(
    string Name,
    string? Description,
    string DataSourceName,
    string DefinitionJson,
    bool IsShared = false,
    DateTime? ExpectedUpdatedAtUtc = null);

public sealed record ModelValidationOutcome(bool Valid, ValidationResult Result);

/// <summary>
/// Portable, host-independent form of a model: everything needed to recreate it
/// elsewhere, and nothing tied to this installation (no id, owner, sharing flag
/// or timestamps). Round-trips through <see cref="DataModelService.ImportAsync"/>.
/// </summary>
public sealed record ModelExportDocument(
    string Name,
    string? Description,
    string DataSourceName,
    ModelDefinition Definition);

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
    /// <summary>Mirrors the rcd_data_models.name column width.</summary>
    private const int MaxNameLength = 128;

    public async Task<IReadOnlyList<ModelSummary>> ListVisibleAsync(CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var systemOwner = options.SystemOwnerUserId;
        return await db.DataModels.AsNoTracking()
            .Where(m => !m.IsDeleted && (m.OwnerUserId == userId || m.IsShared))
            .OrderBy(m => m.Name)
            .Select(m => new ModelSummary(
                m.Id, m.Name, m.Description, m.DataSourceName, m.IsShared,
                m.OwnerUserId == userId, m.UpdatedAtUtc,
                systemOwner != null && systemOwner != "" && m.OwnerUserId == systemOwner))
            .ToListAsync(ct);
    }

    /// <summary>True when the model is built-in (seeded) content, read-only through the API.</summary>
    public bool IsSystemOwner(string ownerUserId) =>
        !string.IsNullOrEmpty(options.SystemOwnerUserId)
        && string.Equals(ownerUserId, options.SystemOwnerUserId, StringComparison.Ordinal);

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

        // A system-owned (seeded) model is read-only, with ONE carve-out: a
        // caller who may manage shared content can edit its MEASURES. See
        // SystemMeasureEditRefusal below — everything else about the model
        // stays immutable, and everyone else still gets the flat refusal.
        var systemModel = IsSystemOwner(record.OwnerUserId);
        if (systemModel && !currentUser.CanManageShared)
        {
            return SystemReadOnly<SemanticModel>();
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

        if (systemModel
            && SystemMeasureEditRefusal(record, request, prepared.Value!) is { } refusal)
        {
            return refusal;
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

        if (IsSystemOwner(record.OwnerUserId))
        {
            return SystemReadOnly<bool>();
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

    /// <summary>
    /// Copies a model the caller can see (their own, or a shared one they cannot
    /// edit) into a new model they own outright: same definition, unshared, name
    /// suffixed so it never collides with their existing models. The copy goes
    /// through <see cref="CreateAsync"/>, so catalog validation and the per-user
    /// model cap apply exactly as they would to a hand-authored save.
    /// </summary>
    public async Task<ServiceResult<SemanticModel>> DuplicateAsync(int id, CancellationToken ct)
    {
        var source = await GetAsync(id, ct);
        if (!source.Succeeded)
        {
            return source;
        }

        var detail = source.Value!;
        var name = await NextCopyNameAsync(currentUser.GetUserId(), detail.Name, ct);

        // The stored definition travels verbatim rather than via the parsed form,
        // so a copy is byte-identical to its source before normalization.
        var definitionJson = await db.DataModels.AsNoTracking()
            .Where(m => m.Id == id)
            .Select(m => m.DefinitionJson)
            .FirstAsync(ct);

        return await CreateAsync(
            new ModelSaveRequest(name, detail.Description, detail.DataSourceName, definitionJson), ct);
    }

    /// <summary>
    /// The portable document for a model visible to the caller. Visibility is the
    /// same rule <see cref="GetAsync"/> applies — a shared model exports for
    /// everyone, a private one only for its owner.
    /// </summary>
    public async Task<ServiceResult<ModelExportDocument>> ExportAsync(int id, CancellationToken ct)
    {
        var source = await GetAsync(id, ct);
        if (!source.Succeeded)
        {
            return ServiceResult<ModelExportDocument>.Fail(source.Error!);
        }

        var model = source.Value!;
        return ServiceResult<ModelExportDocument>.Ok(
            new ModelExportDocument(model.Name, model.Description, model.DataSourceName, model.Definition));
    }

    /// <summary>
    /// Creates a caller-owned model from a portable document. Deliberately the
    /// same path as <see cref="CreateAsync"/> — an import is just a save whose
    /// content came from a file — so catalog validation, the size cap, the
    /// per-user cap and the name-conflict error all behave identically. Imports
    /// are never shared: promoting one to a shared default is a separate,
    /// admin-gated edit.
    /// </summary>
    public Task<ServiceResult<SemanticModel>> ImportAsync(ModelSaveRequest request, CancellationToken ct) =>
        CreateAsync(request with { IsShared = false, ExpectedUpdatedAtUtc = null }, ct);

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

    /// <summary>
    /// First free name in the sequence "X (copy)", "X (copy 2)", "X (copy 3)"…
    /// for this owner. The unique index on (OwnerUserId, Name) makes an unsuffixed
    /// copy unusable the moment one already exists.
    /// </summary>
    private async Task<string> NextCopyNameAsync(string ownerUserId, string sourceName, CancellationToken ct)
    {
        var candidate = ComposeCopyName(sourceName, copyNumber: null);
        if (!await NameTakenAsync(ownerUserId, candidate, excludeId: null, ct))
        {
            return candidate;
        }

        // Bounded by the per-user cap: the caller cannot own more models than
        // that, so a free slot always appears first — unless they are already at
        // the limit, in which case CreateAsync reports the limit anyway.
        var ceiling = options.Limits.MaxModelsPerUser + 2;
        for (var copyNumber = 2; copyNumber <= ceiling; copyNumber++)
        {
            candidate = ComposeCopyName(sourceName, copyNumber);
            if (!await NameTakenAsync(ownerUserId, candidate, excludeId: null, ct))
            {
                return candidate;
            }
        }

        return candidate;
    }

    /// <summary>
    /// "X (copy)" / "X (copy N)", trimmed so the suffix survives even when the
    /// source name already fills the column.
    /// </summary>
    private static string ComposeCopyName(string sourceName, int? copyNumber)
    {
        var suffix = copyNumber is null ? " (copy)" : $" (copy {copyNumber})";
        var stem = sourceName.Trim();
        if (stem.Length + suffix.Length > MaxNameLength)
        {
            stem = stem[..(MaxNameLength - suffix.Length)].TrimEnd();
        }

        return stem + suffix;
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

    /// <summary>
    /// *** THE SYSTEM-SCOPE AUTHORING CARVE-OUT ***
    ///
    /// A seeded model is owned by SystemOwnerUserId and refuses every write, so
    /// until now a System-scope measure could only be created by hand-editing
    /// the seed JSON and re-seeding. This opens exactly one door and no other:
    /// a caller with CanManageShared may change the model's MEASURES.
    ///
    /// The check is by construction rather than by enumeration — the incoming
    /// definition and the stored one are normalized through
    /// <see cref="ModelJson"/> with their measures blanked and compared as
    /// text. Anything else that differs (tables, column overrides, hidden
    /// flags, relationships, date tables, the version, and off the definition:
    /// name, description, data source, sharing) fails, and it keeps failing if
    /// someone later adds a field to ModelDefinition — a new field is covered
    /// the day it is added, with no second place to remember.
    ///
    /// Returns null when the edit is allowed; otherwise the refusal:
    ///  - rcd.model.system_measures_only — a non-measure part changed.
    ///  - rcd.model.system_readonly — nothing about the measures changed, so
    ///    this is not the carve-out's business and the model is what it has
    ///    always been: read-only. (This is also what keeps the pinned
    ///    DashboardSharingTests.SystemModel_UpdateAndDeleteReadOnly_ButDuplicateAllowed
    ///    green: it re-saves a system model UNCHANGED as an admin.)
    /// </summary>
    private static ServiceResult<SemanticModel>? SystemMeasureEditRefusal(
        DataModelRecord record, ModelSaveRequest request, ModelDefinition incoming)
    {
        var stored = ModelJson.TryDeserialize(record.DefinitionJson, out _);
        if (stored is null)
        {
            // A corrupt seeded definition cannot be diffed, so nothing can be
            // proven about what the request changes. Fail closed.
            return SystemReadOnly<SemanticModel>();
        }

        var identityUnchanged =
            string.Equals(record.Name, request.Name.Trim(), StringComparison.Ordinal)
            && string.Equals(record.Description, request.Description, StringComparison.Ordinal)
            && string.Equals(record.DataSourceName, request.DataSourceName, StringComparison.Ordinal)
            && record.IsShared == request.IsShared;

        var structureUnchanged = string.Equals(
            ModelJson.Serialize(stored with { Measures = [] }),
            ModelJson.Serialize(incoming with { Measures = [] }),
            StringComparison.Ordinal);

        if (!identityUnchanged || !structureUnchanged)
        {
            return ServiceResult<SemanticModel>.Fail(
                ServiceErrorKind.Forbidden, "rcd.model.system_measures_only",
                "This is a built-in model: only its measures can be edited. Tables, relationships, date tables, its name and its sharing are managed by the application — make a copy to change them.");
        }

        var measuresChanged = !string.Equals(
            JsonSerializer.Serialize(stored.Measures, ModelJson.Options),
            JsonSerializer.Serialize(incoming.Measures, ModelJson.Options),
            StringComparison.Ordinal);

        return measuresChanged ? null : SystemReadOnly<SemanticModel>();
    }

    private static ServiceResult<T> SystemReadOnly<T>() =>
        ServiceResult<T>.Fail(
            ServiceErrorKind.Forbidden, "rcd.model.system_readonly",
            "This is a built-in item managed by the application. Make a copy to edit it.");

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
