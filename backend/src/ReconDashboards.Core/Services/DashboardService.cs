using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Services;

public sealed record DashboardSummary(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime UpdatedAtUtc);

public sealed record DashboardDetail(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    JsonElement Layout);

public sealed record DashboardSaveRequest(
    string Name,
    string? Description,
    int? ModelId,
    string LayoutJson,
    bool IsShared = false,
    DateTime? ExpectedUpdatedAtUtc = null);

/// <summary>
/// Dashboard CRUD: per-user + shared, soft delete, size caps. Layout JSON is
/// validated structurally here (well-formed, capped, object root); the per-tile
/// chart specs inside it get full validation at query time.
/// </summary>
public sealed class DashboardService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    ReconDashboardsOptions options,
    TimeProvider timeProvider)
{
    public async Task<IReadOnlyList<DashboardSummary>> ListVisibleAsync(CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        return await db.Dashboards.AsNoTracking()
            .Where(d => !d.IsDeleted && (d.OwnerUserId == userId || d.IsShared))
            .OrderBy(d => d.Name)
            .Select(d => new DashboardSummary(
                d.Id, d.Name, d.Description, d.ModelId, d.IsShared,
                d.OwnerUserId == userId, d.UpdatedAtUtc))
            .ToListAsync(ct);
    }

    public async Task<ServiceResult<DashboardDetail>> GetAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);

        if (record is null || (record.OwnerUserId != userId && !record.IsShared))
        {
            return NotFound<DashboardDetail>(id);
        }

        return ServiceResult<DashboardDetail>.Ok(Materialize(record, userId));
    }

    public async Task<ServiceResult<DashboardDetail>> CreateAsync(DashboardSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        var layoutError = ValidateRequest(request);
        if (layoutError is not null)
        {
            return ServiceResult<DashboardDetail>.Fail(layoutError);
        }

        if (request.IsShared && !currentUser.CanManageShared)
        {
            return SharingForbidden();
        }

        var ownedCount = await db.Dashboards.CountAsync(
            d => d.OwnerUserId == userId && !d.IsDeleted, ct);
        if (ownedCount >= options.Limits.MaxDashboardsPerUser)
        {
            return ServiceResult<DashboardDetail>.Fail(
                ServiceErrorKind.LimitExceeded, "rcd.limit.dashboards",
                $"You already have {ownedCount} dashboards (limit {options.Limits.MaxDashboardsPerUser}).");
        }

        if (await NameTakenAsync(userId, request.Name, excludeId: null, ct))
        {
            return NameConflict(request.Name);
        }

        var now = timeProvider.GetUtcNow().UtcDateTime;
        var record = new DashboardRecord
        {
            Name = request.Name.Trim(),
            Description = request.Description,
            ModelId = request.ModelId,
            LayoutJson = request.LayoutJson,
            OwnerUserId = userId,
            IsShared = request.IsShared,
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
        };

        db.Dashboards.Add(record);
        await db.SaveChangesAsync(ct);

        return ServiceResult<DashboardDetail>.Ok(Materialize(record, userId));
    }

    public async Task<ServiceResult<DashboardDetail>> UpdateAsync(int id, DashboardSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);

        if (record is null || (record.OwnerUserId != userId && !record.IsShared))
        {
            return NotFound<DashboardDetail>(id);
        }

        if (record.OwnerUserId != userId && !currentUser.CanManageShared)
        {
            return ServiceResult<DashboardDetail>.Fail(
                ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
                "Only the owner (or an administrator) can edit this dashboard.");
        }

        if (request.IsShared != record.IsShared && !currentUser.CanManageShared)
        {
            return SharingForbidden();
        }

        if (request.ExpectedUpdatedAtUtc is { } expected
            && Math.Abs((record.UpdatedAtUtc - expected).TotalMilliseconds) > 1)
        {
            return ServiceResult<DashboardDetail>.Fail(
                ServiceErrorKind.Conflict, "rcd.dashboard.stale",
                "The dashboard was changed by someone else since you loaded it. Reload and re-apply your edits.");
        }

        var layoutError = ValidateRequest(request);
        if (layoutError is not null)
        {
            return ServiceResult<DashboardDetail>.Fail(layoutError);
        }

        if (await NameTakenAsync(record.OwnerUserId, request.Name, excludeId: id, ct))
        {
            return NameConflict(request.Name);
        }

        record.Name = request.Name.Trim();
        record.Description = request.Description;
        record.ModelId = request.ModelId;
        record.LayoutJson = request.LayoutJson;
        record.IsShared = request.IsShared;
        record.UpdatedAtUtc = timeProvider.GetUtcNow().UtcDateTime;

        await db.SaveChangesAsync(ct);

        return ServiceResult<DashboardDetail>.Ok(Materialize(record, userId));
    }

    public async Task<ServiceResult<bool>> DeleteAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);

        if (record is null || (record.OwnerUserId != userId && !record.IsShared))
        {
            return NotFound<bool>(id);
        }

        if (record.OwnerUserId != userId && !currentUser.CanManageShared)
        {
            return ServiceResult<bool>.Fail(
                ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
                "Only the owner (or an administrator) can delete this dashboard.");
        }

        record.IsDeleted = true;
        record.UpdatedAtUtc = timeProvider.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);
        return ServiceResult<bool>.Ok(true);
    }

    /// <summary>Copies a visible dashboard (e.g. a shared one) as a new caller-owned draft.</summary>
    public async Task<ServiceResult<DashboardDetail>> DuplicateAsync(int id, CancellationToken ct)
    {
        var source = await GetAsync(id, ct);
        if (!source.Succeeded)
        {
            return source;
        }

        var detail = source.Value!;
        var baseName = $"{detail.Name} (copy)";
        var userId = currentUser.GetUserId();
        var name = baseName;
        var suffix = 2;
        while (await NameTakenAsync(userId, name, excludeId: null, ct))
        {
            name = $"{baseName} {suffix++}";
        }

        var record = await db.Dashboards.AsNoTracking().FirstAsync(d => d.Id == id, ct);
        return await CreateAsync(
            new DashboardSaveRequest(name, detail.Description, detail.ModelId, record.LayoutJson),
            ct);
    }

    private ServiceError? ValidateRequest(DashboardSaveRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            return new ServiceError(ServiceErrorKind.BadRequest, "rcd.dashboard.name_required", "Dashboard name is required.");
        }

        if (Encoding.UTF8.GetByteCount(request.LayoutJson) > options.Limits.MaxDashboardLayoutBytes)
        {
            return new ServiceError(
                ServiceErrorKind.LimitExceeded, "rcd.limit.layout_size",
                $"Dashboard layout exceeds {options.Limits.MaxDashboardLayoutBytes / 1024} KB.");
        }

        try
        {
            using var doc = JsonDocument.Parse(request.LayoutJson, new JsonDocumentOptions { MaxDepth = 32 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return new ServiceError(
                    ServiceErrorKind.BadRequest, "rcd.dashboard.invalid_layout",
                    "Dashboard layout must be a JSON object.");
            }
        }
        catch (JsonException ex)
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.dashboard.invalid_layout",
                $"Dashboard layout is not valid JSON: {ex.Message}");
        }

        return null;
    }

    private async Task<bool> NameTakenAsync(string ownerUserId, string name, int? excludeId, CancellationToken ct)
    {
        var trimmed = name.Trim();
        return await db.Dashboards.AnyAsync(
            d => d.OwnerUserId == ownerUserId
                && !d.IsDeleted
                && d.Name == trimmed
                && (excludeId == null || d.Id != excludeId),
            ct);
    }

    private static ServiceResult<T> NotFound<T>(int id) =>
        ServiceResult<T>.Fail(
            ServiceErrorKind.NotFound, "rcd.dashboard.not_found",
            $"Dashboard {id} does not exist or is not visible to you.");

    private static ServiceResult<DashboardDetail> SharingForbidden() =>
        ServiceResult<DashboardDetail>.Fail(
            ServiceErrorKind.Forbidden, "rcd.dashboard.share_forbidden",
            "Sharing or unsharing dashboards requires administrator rights.");

    private static ServiceResult<DashboardDetail> NameConflict(string name) =>
        ServiceResult<DashboardDetail>.Fail(
            ServiceErrorKind.Conflict, "rcd.dashboard.name_conflict",
            $"You already have a dashboard named '{name.Trim()}'.");

    private static DashboardDetail Materialize(DashboardRecord record, string userId)
    {
        using var doc = JsonDocument.Parse(record.LayoutJson);
        return new DashboardDetail(
            record.Id, record.Name, record.Description, record.ModelId, record.IsShared,
            record.OwnerUserId == userId, record.CreatedAtUtc, record.UpdatedAtUtc,
            doc.RootElement.Clone());
    }
}
