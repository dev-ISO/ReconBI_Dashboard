using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Services;

/// <summary>
/// What the current caller may do with one dashboard. Computed in exactly one
/// place (<see cref="DashboardService"/>); UIs scope edit affordances off it,
/// while the service re-enforces on every write.
/// </summary>
public sealed record DashboardAccess(
    bool IsOwner,
    bool CanEdit,
    bool CanEditLayout,
    bool CanManagePages,
    bool CanEditCharts,
    bool CanMoveTiles,
    bool CanDeleteContent,
    bool ViaShare,
    bool ViaPublish);

public sealed record DashboardSummary(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime UpdatedAtUtc,
    bool IsSystem,
    string? OwnerDisplayName,
    DashboardAccess MyAccess,
    int ShareCount);

public sealed record DashboardDetail(
    int Id,
    string Name,
    string? Description,
    int? ModelId,
    bool IsShared,
    bool OwnerIsMe,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    bool IsSystem,
    string? OwnerDisplayName,
    DashboardAccess MyAccess,
    int ShareCount,
    JsonElement Layout);

public sealed record DashboardSaveRequest(
    string Name,
    string? Description,
    int? ModelId,
    string LayoutJson,
    bool IsShared = false,
    DateTime? ExpectedUpdatedAtUtc = null);

/// <summary>
/// Metadata-only patch (PATCH dashboards/{id}/meta). Explicit *Set flags carry
/// the absent-vs-null distinction JSON binding loses: an ABSENT field keeps
/// the stored value; Description/ModelId present with null CLEAR it. By
/// construction this never reads or writes LayoutJson and takes no
/// expectedUpdatedAtUtc — metadata is not the doc, so a rename/publish flip
/// can never clobber (or be blocked by) concurrent layout edits.
/// </summary>
public sealed record DashboardMetaPatch(
    string? Name,
    bool DescriptionSet,
    string? Description,
    bool ModelIdSet,
    int? ModelId,
    bool? IsShared);

/// <summary>
/// One named-user grant, decorated with directory display names (the grantee's
/// and the granter's) plus when it was granted — the Share dialog's
/// "granted by X on date" line.
/// </summary>
public sealed record DashboardShareInfo(
    string UserId,
    string? DisplayName,
    bool CanEditLayout,
    bool CanManagePages,
    bool CanEditCharts,
    bool CanMoveTiles,
    bool CanDeleteContent,
    string GrantedByUserId,
    string? GrantedByDisplayName,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc);

/// <summary>
/// One requested grant in a full-set replace. The 0.11.1 flags default false so
/// pre-0.11.1 clients (which never send them) keep binding — their saves grant
/// the new rights explicitly off rather than failing.
/// </summary>
public sealed record DashboardShareGrant(
    string UserId,
    bool CanEditLayout,
    bool CanManagePages,
    bool CanEditCharts,
    bool CanMoveTiles = false,
    bool CanDeleteContent = false);

public sealed record DashboardActivityEntry(
    long Id,
    string UserId,
    string? DisplayName,
    string Action,
    string? DetailJson,
    DateTime AtUtc);

/// <summary>
/// Dashboard CRUD + named-user sharing + per-dashboard activity log. Layout
/// JSON is validated structurally here (well-formed, capped, object root); the
/// per-tile chart specs inside it get full validation at query time.
///
/// Visibility: owner OR published (IsShared) OR a share row. Rows owned by
/// <see cref="ReconDashboardsOptions.SystemOwnerUserId"/> are built-in content:
/// read-only for everyone through the API (duplicate stays available).
/// Grantee saves are gated by <see cref="DashboardLayoutDiffer"/>: each raised
/// change class must be covered by the matching share flag.
/// </summary>
public sealed class DashboardService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    IUserDirectory userDirectory,
    ReconDashboardsOptions options,
    TimeProvider timeProvider)
{
    /// <summary>Activity rows kept per dashboard; older rows are trimmed after each insert.</summary>
    public const int MaxActivityEntriesPerDashboard = 500;

    /// <summary>GET activity default page size.</summary>
    public const int DefaultActivityLimit = 100;

    private static readonly JsonSerializerOptions ActivityJson = DashboardActivityLog.Json;

    public async Task<IReadOnlyList<DashboardSummary>> ListVisibleAsync(CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var isAdmin = currentUser.CanManageShared;

        var myShares = await db.DashboardShares.AsNoTracking()
            .Where(s => s.UserId == userId)
            .ToDictionaryAsync(s => s.DashboardId, ct);

        var records = await db.Dashboards.AsNoTracking()
            .Where(d => !d.IsDeleted
                && (d.OwnerUserId == userId
                    || d.IsShared
                    || db.DashboardShares.Any(s => s.DashboardId == d.Id && s.UserId == userId)))
            .OrderBy(d => d.Name)
            .ToListAsync(ct);

        // shareCount only surfaces to owners/admins; batch one grouped count.
        var countableIds = records
            .Where(d => isAdmin || d.OwnerUserId == userId)
            .Select(d => d.Id)
            .ToArray();
        var shareCounts = countableIds.Length == 0
            ? new Dictionary<int, int>()
            : await db.DashboardShares.AsNoTracking()
                .Where(s => countableIds.Contains(s.DashboardId))
                .GroupBy(s => s.DashboardId)
                .Select(g => new { g.Key, Count = g.Count() })
                .ToDictionaryAsync(g => g.Key, g => g.Count, ct);

        var owners = await userDirectory.ResolveAsync(
            records.Select(d => d.OwnerUserId).Distinct(StringComparer.Ordinal), ct);

        return records
            .Select(d => new DashboardSummary(
                d.Id, d.Name, d.Description, d.ModelId, d.IsShared,
                d.OwnerUserId == userId, d.UpdatedAtUtc,
                IsSystem(d),
                owners.TryGetValue(d.OwnerUserId, out var owner) ? owner.DisplayName : d.OwnerUserId,
                ComputeAccess(d, userId, myShares.GetValueOrDefault(d.Id)),
                shareCounts.GetValueOrDefault(d.Id)))
            .ToList();
    }

    public async Task<ServiceResult<DashboardDetail>> GetAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, share))
        {
            return NotFound<DashboardDetail>(id);
        }

        return ServiceResult<DashboardDetail>.Ok(await MaterializeAsync(record, userId, share, ct));
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

        AddActivity(record.Id, userId, "created", detailJson: null, now);
        await db.SaveChangesAsync(ct);

        return ServiceResult<DashboardDetail>.Ok(await MaterializeAsync(record, userId, share: null, ct));
    }

    public async Task<ServiceResult<DashboardDetail>> UpdateAsync(int id, DashboardSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, share))
        {
            return NotFound<DashboardDetail>(id);
        }

        if (IsSystem(record))
        {
            return SystemReadOnly<DashboardDetail>();
        }

        var isOwner = record.OwnerUserId == userId;
        var fullEditor = isOwner || currentUser.CanManageShared;

        if (!fullEditor && share is null)
        {
            return ServiceResult<DashboardDetail>.Fail(DashboardAccessRules.EditForbiddenError());
        }

        // COLLAB-DESIGN "fixed regardless": an omitted stamp used to mean blind
        // overwrite — the one save shape that can silently discard someone
        // else's work. Updates now REQUIRE the stamp; 428 tells the client this
        // request must be conditional (a clear, dedicated failure rather than a
        // surprise conflict). Creates and duplicates are unaffected (they write
        // fresh rows), and the ops endpoint has its own FOR UPDATE discipline.
        if (request.ExpectedUpdatedAtUtc is not { } expected)
        {
            return ServiceResult<DashboardDetail>.Fail(
                ServiceErrorKind.PreconditionRequired, "rcd.dashboard.stamp_required",
                "Updating a dashboard requires expectedUpdatedAtUtc (the updatedAtUtc you loaded). Reload the dashboard and retry.");
        }

        if (Math.Abs((record.UpdatedAtUtc - expected).TotalMilliseconds) > 1)
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

        var summary = DashboardLayoutDiffer.Diff(record.LayoutJson, request.LayoutJson);
        var now = timeProvider.GetUtcNow().UtcDateTime;

        if (fullEditor)
        {
            if (request.IsShared != record.IsShared && !currentUser.CanManageShared)
            {
                return SharingForbidden();
            }

            if (await NameTakenAsync(record.OwnerUserId, request.Name, excludeId: id, ct))
            {
                return NameConflict(request.Name, ownerIsCaller: isOwner);
            }

            var oldName = record.Name;
            var newName = request.Name.Trim();
            var renamed = !string.Equals(oldName, newName, StringComparison.Ordinal);
            var contentChanged = summary.HasAnyChange
                || record.Description != request.Description
                || record.ModelId != request.ModelId
                || record.IsShared != request.IsShared;

            record.Name = newName;
            record.Description = request.Description;
            record.ModelId = request.ModelId;
            record.LayoutJson = request.LayoutJson;
            record.IsShared = request.IsShared;
            record.UpdatedAtUtc = now;

            if (renamed)
            {
                AddActivity(id, userId, "renamed",
                    JsonSerializer.Serialize(new { from = oldName, to = newName }, ActivityJson), now);
            }

            if (contentChanged)
            {
                AddActivity(id, userId, "saved", JsonSerializer.Serialize(summary, ActivityJson), now);
            }
        }
        else
        {
            // Grantee: metadata is immutable; the layout may change only within
            // the classes their flags cover (differ fails closed on anything odd).
            if (!string.Equals(record.Name, request.Name.Trim(), StringComparison.Ordinal)
                || record.Description != request.Description
                || record.ModelId != request.ModelId
                || record.IsShared != request.IsShared)
            {
                return ServiceResult<DashboardDetail>.Fail(
                    ServiceErrorKind.Forbidden, "rcd.dashboard.share_forbidden_fields",
                    "Shared access does not allow changing this dashboard's name, description, linked model, or publish state.");
            }

            var missing = MissingPermissions(summary, share!);
            if (missing.Count > 0)
            {
                return ServiceResult<DashboardDetail>.Fail(
                    DashboardAccessRules.PermissionDeniedError(missing));
            }

            record.LayoutJson = request.LayoutJson;
            record.UpdatedAtUtc = now;

            if (summary.HasAnyChange)
            {
                AddActivity(id, userId, "saved", JsonSerializer.Serialize(summary, ActivityJson), now);
            }
        }

        await db.SaveChangesAsync(ct);
        await TrimActivityAsync(id, ct);

        return ServiceResult<DashboardDetail>.Ok(await MaterializeAsync(record, userId, share, ct));
    }

    /// <summary>
    /// Metadata-only write (see <see cref="DashboardMetaPatch"/>). Auth mirrors
    /// <see cref="UpdateAsync"/> field for field: name/description/modelId need
    /// owner-or-admin (grantee metadata is immutable — share_forbidden_fields),
    /// flipping IsShared additionally needs CanManageShared. Unlike UpdateAsync
    /// there is NO stamp precondition: this path cannot touch LayoutJson, so
    /// there is no doc to protect — but a real change still bumps UpdatedAtUtc,
    /// keeping the whole-doc stale check honest (a draft PUT racing a rename
    /// 409s instead of silently reverting it).
    /// </summary>
    public async Task<ServiceResult<DashboardDetail>> PatchMetaAsync(
        int id, DashboardMetaPatch patch, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, share))
        {
            return NotFound<DashboardDetail>(id);
        }

        if (IsSystem(record))
        {
            return SystemReadOnly<DashboardDetail>();
        }

        var isOwner = record.OwnerUserId == userId;
        if (!isOwner && !currentUser.CanManageShared)
        {
            return ServiceResult<DashboardDetail>.Fail(
                ServiceErrorKind.Forbidden, "rcd.dashboard.share_forbidden_fields",
                "Shared access does not allow changing this dashboard's name, description, linked model, or publish state.");
        }

        // Validate EVERYTHING before assigning anything — a half-valid body
        // must change nothing.
        string? newName = null;
        if (patch.Name is not null)
        {
            if (string.IsNullOrWhiteSpace(patch.Name))
            {
                return ServiceResult<DashboardDetail>.Fail(
                    ServiceErrorKind.BadRequest, "rcd.dashboard.name_required", "Dashboard name is required.");
            }

            newName = patch.Name.Trim();
            if (newName.Length > MaxNameLength)
            {
                return ServiceResult<DashboardDetail>.Fail(
                    ServiceErrorKind.BadRequest, "rcd.dashboard.name_too_long",
                    $"Dashboard names are limited to {MaxNameLength} characters.");
            }

            if (!string.Equals(record.Name, newName, StringComparison.Ordinal)
                && await NameTakenAsync(record.OwnerUserId, newName, excludeId: id, ct))
            {
                return NameConflict(newName, ownerIsCaller: isOwner);
            }
        }

        if (patch.DescriptionSet && patch.Description is { Length: > MaxDescriptionLength })
        {
            return ServiceResult<DashboardDetail>.Fail(
                ServiceErrorKind.BadRequest, "rcd.dashboard.description_too_long",
                $"Dashboard descriptions are limited to {MaxDescriptionLength} characters.");
        }

        if (patch.IsShared is { } isShared && isShared != record.IsShared && !currentUser.CanManageShared)
        {
            return SharingForbidden();
        }

        var now = timeProvider.GetUtcNow().UtcDateTime;
        var renamed = newName is not null && !string.Equals(record.Name, newName, StringComparison.Ordinal);
        var otherChanged =
            (patch.DescriptionSet && record.Description != patch.Description)
            || (patch.ModelIdSet && record.ModelId != patch.ModelId)
            || (patch.IsShared is { } flag && record.IsShared != flag);

        if (renamed)
        {
            AddActivity(id, userId, "renamed",
                JsonSerializer.Serialize(new { from = record.Name, to = newName }, ActivityJson), now);
            record.Name = newName!;
        }

        if (patch.DescriptionSet)
        {
            record.Description = patch.Description;
        }

        if (patch.ModelIdSet)
        {
            record.ModelId = patch.ModelId;
        }

        if (patch.IsShared is { } nextShared)
        {
            record.IsShared = nextShared;
        }

        if (renamed || otherChanged)
        {
            if (otherChanged)
            {
                AddActivity(id, userId, "saved", detailJson: null, now);
            }

            record.UpdatedAtUtc = now;
            await db.SaveChangesAsync(ct);
            await TrimActivityAsync(id, ct);
        }

        return ServiceResult<DashboardDetail>.Ok(await MaterializeAsync(record, userId, share, ct));
    }

    /// <summary>
    /// Contextual delete: owner/admin soft-delete the dashboard; a grantee only
    /// removes their own share row ("remove from my list"); a publish-only
    /// viewer gets 403. System rows are never deletable through the API.
    /// </summary>
    public async Task<ServiceResult<bool>> DeleteAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, share))
        {
            return NotFound<bool>(id);
        }

        if (IsSystem(record))
        {
            return SystemReadOnly<bool>();
        }

        var now = timeProvider.GetUtcNow().UtcDateTime;

        if (record.OwnerUserId == userId || currentUser.CanManageShared)
        {
            // Share rows are kept: the soft-deleted row is invisible anyway, and
            // an undelete would restore the grants intact.
            record.IsDeleted = true;
            record.UpdatedAtUtc = now;
            AddActivity(id, userId, "deleted", detailJson: null, now);
            await db.SaveChangesAsync(ct);
            await TrimActivityAsync(id, ct);
            return ServiceResult<bool>.Ok(true);
        }

        if (share is not null)
        {
            db.DashboardShares.Remove(share);
            AddActivity(id, userId, "left", detailJson: null, now);
            await db.SaveChangesAsync(ct);
            await TrimActivityAsync(id, ct);
            return ServiceResult<bool>.Ok(true);
        }

        return ServiceResult<bool>.Fail(
            ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
            "Only the owner (or an administrator) can delete this dashboard.");
    }

    /// <summary>Copies a visible dashboard (shared, published or built-in) as a new caller-owned draft.</summary>
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
        var copy = await CreateAsync(
            new DashboardSaveRequest(name, detail.Description, detail.ModelId, record.LayoutJson),
            ct);

        if (copy.Succeeded)
        {
            AddActivity(id, userId, "duplicated", detailJson: null, timeProvider.GetUtcNow().UtcDateTime);
            await db.SaveChangesAsync(ct);
            await TrimActivityAsync(id, ct);
        }

        return copy;
    }

    // ------------------------------- sharing -------------------------------

    /// <summary>The current grant set, owner/admin only.</summary>
    public async Task<ServiceResult<IReadOnlyList<DashboardShareInfo>>> GetSharesAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, share))
        {
            return NotFound<IReadOnlyList<DashboardShareInfo>>(id);
        }

        if (record.OwnerUserId != userId && !currentUser.CanManageShared)
        {
            return ServiceResult<IReadOnlyList<DashboardShareInfo>>.Fail(
                ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
                "Only the owner (or an administrator) can view this dashboard's shares.");
        }

        return ServiceResult<IReadOnlyList<DashboardShareInfo>>.Ok(await LoadShareInfosAsync(id, ct));
    }

    /// <summary>
    /// REPLACES the full grant set (the Share dialog saves in one PUT). Writes
    /// shared/unshared/shareChanged activity for the affected users.
    /// </summary>
    public async Task<ServiceResult<IReadOnlyList<DashboardShareInfo>>> ReplaceSharesAsync(
        int id, IReadOnlyList<DashboardShareGrant> grants, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var callerShare = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, callerShare))
        {
            return NotFound<IReadOnlyList<DashboardShareInfo>>(id);
        }

        if (IsSystem(record))
        {
            return ServiceResult<IReadOnlyList<DashboardShareInfo>>.Fail(SystemReadOnlyError());
        }

        if (record.OwnerUserId != userId && !currentUser.CanManageShared)
        {
            return ServiceResult<IReadOnlyList<DashboardShareInfo>>.Fail(
                ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
                "Only the owner (or an administrator) can change this dashboard's shares.");
        }

        if (ValidateGrantTargets(grants, record.OwnerUserId, userId) is { } targetError)
        {
            return ServiceResult<IReadOnlyList<DashboardShareInfo>>.Fail(targetError);
        }

        var existing = await db.DashboardShares
            .Where(s => s.DashboardId == id)
            .ToDictionaryAsync(s => s.UserId, StringComparer.Ordinal, ct);
        var requested = grants.ToDictionary(g => g.UserId, StringComparer.Ordinal);
        var now = timeProvider.GetUtcNow().UtcDateTime;

        var added = new List<string>();
        var removed = new List<string>();
        var changed = new List<string>();

        foreach (var (targetId, row) in existing)
        {
            if (!requested.ContainsKey(targetId))
            {
                db.DashboardShares.Remove(row);
                removed.Add(targetId);
            }
        }

        foreach (var grant in grants)
        {
            if (existing.TryGetValue(grant.UserId, out var row))
            {
                if (row.CanEditLayout != grant.CanEditLayout
                    || row.CanManagePages != grant.CanManagePages
                    || row.CanEditCharts != grant.CanEditCharts
                    || row.CanMoveTiles != grant.CanMoveTiles
                    || row.CanDeleteContent != grant.CanDeleteContent)
                {
                    row.CanEditLayout = grant.CanEditLayout;
                    row.CanManagePages = grant.CanManagePages;
                    row.CanEditCharts = grant.CanEditCharts;
                    row.CanMoveTiles = grant.CanMoveTiles;
                    row.CanDeleteContent = grant.CanDeleteContent;
                    row.UpdatedAtUtc = now;
                    changed.Add(grant.UserId);
                }
            }
            else
            {
                db.DashboardShares.Add(new DashboardShareRecord
                {
                    DashboardId = id,
                    UserId = grant.UserId,
                    CanEditLayout = grant.CanEditLayout,
                    CanManagePages = grant.CanManagePages,
                    CanEditCharts = grant.CanEditCharts,
                    CanMoveTiles = grant.CanMoveTiles,
                    CanDeleteContent = grant.CanDeleteContent,
                    GrantedByUserId = userId,
                    CreatedAtUtc = now,
                    UpdatedAtUtc = now,
                });
                added.Add(grant.UserId);
            }
        }

        AddShareActivity(id, userId, "shared", added, now);
        AddShareActivity(id, userId, "unshared", removed, now);
        AddShareActivity(id, userId, "shareChanged", changed, now);

        await db.SaveChangesAsync(ct);
        await TrimActivityAsync(id, ct);

        return ServiceResult<IReadOnlyList<DashboardShareInfo>>.Ok(await LoadShareInfosAsync(id, ct));
    }

    /// <summary>Removes the caller's own share row (explicit "remove from my list").</summary>
    public async Task<ServiceResult<bool>> LeaveAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, share))
        {
            return NotFound<bool>(id);
        }

        if (share is null)
        {
            return ServiceResult<bool>.Fail(
                ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
                "This dashboard was not shared with you directly, so there is no share to leave.");
        }

        var now = timeProvider.GetUtcNow().UtcDateTime;
        db.DashboardShares.Remove(share);
        AddActivity(id, userId, "left", detailJson: null, now);
        await db.SaveChangesAsync(ct);
        await TrimActivityAsync(id, ct);
        return ServiceResult<bool>.Ok(true);
    }

    // ------------------------------- activity -------------------------------

    /// <summary>
    /// Newest-first activity page. Visible to the owner, admins, and grantees
    /// holding at least one edit flag — view-only grantees and publish-only
    /// viewers cannot see who did what.
    /// </summary>
    public async Task<ServiceResult<IReadOnlyList<DashboardActivityEntry>>> ListActivityAsync(
        int id, int? limit, long? beforeId, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == id && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(id, userId, ct);

        if (record is null || !IsVisibleTo(record, userId, share))
        {
            return NotFound<IReadOnlyList<DashboardActivityEntry>>(id);
        }

        var hasEditFlag = share is { } s
            && (s.CanEditLayout || s.CanManagePages || s.CanEditCharts || s.CanMoveTiles || s.CanDeleteContent);
        if (record.OwnerUserId != userId && !currentUser.CanManageShared && !hasEditFlag)
        {
            return ServiceResult<IReadOnlyList<DashboardActivityEntry>>.Fail(
                ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
                "Viewing this dashboard's activity requires edit access.");
        }

        var take = Math.Clamp(limit ?? DefaultActivityLimit, 1, MaxActivityEntriesPerDashboard);
        var rows = await db.DashboardActivity.AsNoTracking()
            .Where(a => a.DashboardId == id && (beforeId == null || a.Id < beforeId))
            .OrderByDescending(a => a.Id)
            .Take(take)
            .ToListAsync(ct);

        var users = await userDirectory.ResolveAsync(
            rows.Select(a => a.UserId).Distinct(StringComparer.Ordinal), ct);

        return ServiceResult<IReadOnlyList<DashboardActivityEntry>>.Ok(rows
            .Select(a => new DashboardActivityEntry(
                a.Id, a.UserId,
                users.TryGetValue(a.UserId, out var user) ? user.DisplayName : a.UserId,
                a.Action, a.DetailJson, a.AtUtc))
            .ToList());
    }

    // ------------------------------- internals -------------------------------

    // Authorization primitives live in DashboardAccessRules so the ops path
    // (DashboardOpService) enforces the SAME code — these wrappers just bind
    // the service's identity/options context.

    private bool IsSystem(DashboardRecord record) =>
        DashboardAccessRules.IsSystem(record, options.SystemOwnerUserId);

    private static bool IsVisibleTo(DashboardRecord record, string userId, DashboardShareRecord? share) =>
        DashboardAccessRules.IsVisibleTo(record, userId, share);

    private Task<DashboardShareRecord?> FindShareAsync(int dashboardId, string userId, CancellationToken ct) =>
        db.DashboardShares.FirstOrDefaultAsync(
            s => s.DashboardId == dashboardId && s.UserId == userId, ct);

    private DashboardAccess ComputeAccess(DashboardRecord record, string userId, DashboardShareRecord? share) =>
        DashboardAccessRules.ComputeAccess(
            record, userId, currentUser.CanManageShared, options.SystemOwnerUserId, share);

    private static List<string> MissingPermissions(LayoutChangeSummary summary, DashboardShareRecord share) =>
        DashboardAccessRules.MissingPermissions(summary, share);

    private static ServiceError? ValidateGrantTargets(
        IReadOnlyList<DashboardShareGrant> grants, string ownerUserId, string callerUserId)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var grant in grants)
        {
            if (string.IsNullOrWhiteSpace(grant.UserId))
            {
                return new ServiceError(
                    ServiceErrorKind.BadRequest, "rcd.dashboard.share_target_invalid",
                    "Each share entry needs a non-empty userId.");
            }

            if (string.Equals(grant.UserId, ownerUserId, StringComparison.Ordinal)
                || string.Equals(grant.UserId, callerUserId, StringComparison.Ordinal))
            {
                return new ServiceError(
                    ServiceErrorKind.BadRequest, "rcd.dashboard.share_target_invalid",
                    $"'{grant.UserId}' already has full access — a dashboard cannot be shared with its owner or yourself.");
            }

            if (!seen.Add(grant.UserId))
            {
                return new ServiceError(
                    ServiceErrorKind.BadRequest, "rcd.dashboard.share_target_invalid",
                    $"User '{grant.UserId}' appears more than once in the share list.");
            }
        }

        return null;
    }

    private async Task<IReadOnlyList<DashboardShareInfo>> LoadShareInfosAsync(int dashboardId, CancellationToken ct)
    {
        var rows = await db.DashboardShares.AsNoTracking()
            .Where(s => s.DashboardId == dashboardId)
            .OrderBy(s => s.CreatedAtUtc).ThenBy(s => s.Id)
            .ToListAsync(ct);

        // One directory round-trip resolves grantees AND granters (the Share
        // dialog shows "granted by X on date" per row).
        var users = await userDirectory.ResolveAsync(
            rows.Select(s => s.UserId)
                .Concat(rows.Select(s => s.GrantedByUserId))
                .Where(id => !string.IsNullOrEmpty(id))
                .Distinct(StringComparer.Ordinal),
            ct);

        return rows
            .Select(s => new DashboardShareInfo(
                s.UserId,
                users.TryGetValue(s.UserId, out var user) ? user.DisplayName : s.UserId,
                s.CanEditLayout, s.CanManagePages, s.CanEditCharts,
                s.CanMoveTiles, s.CanDeleteContent,
                s.GrantedByUserId,
                users.TryGetValue(s.GrantedByUserId, out var granter) ? granter.DisplayName : s.GrantedByUserId,
                s.CreatedAtUtc, s.UpdatedAtUtc))
            .ToList();
    }

    private void AddActivity(int dashboardId, string userId, string action, string? detailJson, DateTime atUtc) =>
        DashboardActivityLog.Add(db, dashboardId, userId, action, detailJson, atUtc);

    private void AddShareActivity(int dashboardId, string userId, string action, List<string> targetUserIds, DateTime atUtc)
    {
        if (targetUserIds.Count > 0)
        {
            AddActivity(dashboardId, userId, action,
                JsonSerializer.Serialize(new { targetUserIds }, ActivityJson), atUtc);
        }
    }

    /// <summary>Keeps only the newest <see cref="MaxActivityEntriesPerDashboard"/> rows. Call after SaveChanges.</summary>
    private Task TrimActivityAsync(int dashboardId, CancellationToken ct) =>
        DashboardActivityLog.TrimAsync(db, dashboardId, ct);

    /// <summary>Column caps of rcd_dashboards (Name/Description HasMaxLength) — validated here so an
    /// over-long rename fails as a clean 400 instead of a provider truncation error.</summary>
    internal const int MaxNameLength = 128;
    internal const int MaxDescriptionLength = 512;

    private ServiceError? ValidateRequest(DashboardSaveRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            return new ServiceError(ServiceErrorKind.BadRequest, "rcd.dashboard.name_required", "Dashboard name is required.");
        }

        // Trimmed length — the trimmed value is what gets stored.
        if (request.Name.Trim().Length > MaxNameLength)
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.dashboard.name_too_long",
                $"Dashboard names are limited to {MaxNameLength} characters.");
        }

        if (request.Description is { Length: > MaxDescriptionLength })
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.dashboard.description_too_long",
                $"Dashboard descriptions are limited to {MaxDescriptionLength} characters.");
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
        ServiceResult<T>.Fail(DashboardAccessRules.NotFoundError(id));

    private static ServiceResult<T> SystemReadOnly<T>() => ServiceResult<T>.Fail(SystemReadOnlyError());

    private static ServiceError SystemReadOnlyError() => DashboardAccessRules.SystemReadOnlyError();

    private static ServiceResult<DashboardDetail> SharingForbidden() =>
        ServiceResult<DashboardDetail>.Fail(
            ServiceErrorKind.Forbidden, "rcd.dashboard.share_forbidden",
            "Sharing or unsharing dashboards requires administrator rights.");

    /// <summary>
    /// Names are unique per OWNER, not globally — and an admin can rename a
    /// dashboard they do not own, where "you already have…" would mislead.
    /// The message names whose namespace collided.
    /// </summary>
    private static ServiceResult<DashboardDetail> NameConflict(string name, bool ownerIsCaller = true) =>
        ServiceResult<DashboardDetail>.Fail(
            ServiceErrorKind.Conflict, "rcd.dashboard.name_conflict",
            ownerIsCaller
                ? $"You already have a dashboard named '{name.Trim()}'. Names must be unique per owner."
                : $"This dashboard's owner already has a dashboard named '{name.Trim()}'. Names must be unique per owner.");

    private async Task<DashboardDetail> MaterializeAsync(
        DashboardRecord record, string userId, DashboardShareRecord? share, CancellationToken ct)
    {
        var access = ComputeAccess(record, userId, share);
        var shareCount = record.OwnerUserId == userId || currentUser.CanManageShared
            ? await db.DashboardShares.CountAsync(s => s.DashboardId == record.Id, ct)
            : 0;
        var owners = await userDirectory.ResolveAsync([record.OwnerUserId], ct);

        using var doc = JsonDocument.Parse(record.LayoutJson);
        return new DashboardDetail(
            record.Id, record.Name, record.Description, record.ModelId, record.IsShared,
            record.OwnerUserId == userId, record.CreatedAtUtc, record.UpdatedAtUtc,
            IsSystem(record),
            owners.TryGetValue(record.OwnerUserId, out var owner) ? owner.DisplayName : record.OwnerUserId,
            access, shareCount,
            doc.RootElement.Clone());
    }
}
