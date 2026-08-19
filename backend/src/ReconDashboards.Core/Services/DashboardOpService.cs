using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Services;

/// <summary>
/// One collaborative edit as submitted to POST /dashboards/{id}/ops.
/// </summary>
/// <param name="OpId">Client-generated unique id, echoed on the response and
/// the broadcast so the author can drop its own echo.</param>
/// <param name="TargetKind">"tile" | "page" | "doc".</param>
/// <param name="TargetId">Targeted element id; null only for doc-scoped kinds
/// (pageReorder, docSettingSet).</param>
/// <param name="PayloadJson">The op body; see <see cref="DashboardOpApplier"/>
/// for the closed kind vocabulary and each kind's schema.</param>
/// <param name="BaseUpdatedAtUtc">The UpdatedAtUtc the client last saw.
/// Accepted for telemetry/debugging but deliberately NOT enforced: ops are
/// per-element last-writer-wins applied under a row lock, so a stale base is
/// normal live-editing traffic, not a conflict — rejecting on it would turn
/// every concurrent session into an error loop. Whole-doc saves keep the
/// strict stamp instead.</param>
public sealed record DashboardOpSubmission(
    string OpId,
    string TargetKind,
    string? TargetId,
    string PayloadJson,
    DateTime? BaseUpdatedAtUtc = null);

/// <summary>
/// The committed op's receipt.
/// </summary>
/// <param name="Class">Dominant permission class the server assigned:
/// "layout" | "pages" | "charts" | "geometry" | "removal" — or "none" when the
/// op changed nothing (replay/idempotent remove; nothing was persisted or
/// broadcast).</param>
/// <param name="UpdatedAtUtc">The dashboard's stamp after the op — the
/// client's new concurrency baseline.</param>
public sealed record DashboardOpResult(
    string OpId,
    string Class,
    DateTime UpdatedAtUtc);

/// <summary>A tile lock as returned by the lock endpoints.</summary>
public sealed record DashboardTileLockInfo(
    string TileId,
    string HolderUserId,
    string? HolderDisplayName,
    DateTime AcquiredAtUtc,
    DateTime ExpiresAtUtc);

/// <summary>
/// The collaborative-editing op endpoint's engine (COLLAB-DESIGN wave 1):
/// applies one element-scoped edit to a dashboard's LayoutJson inside a
/// row-locked transaction, classifies it with the SAME rules as the save path,
/// gates it on the actor's share flags, and broadcasts it through
/// <see cref="IRcdDashboardOpNotifier"/> after commit.
///
/// CLASSIFICATION BY DIFF, NOT BY OP KIND: the op is applied first, then
/// <see cref="DashboardLayoutDiffer"/> diffs old vs new and the summary goes
/// through <see cref="DashboardAccessRules.MissingPermissions"/> — the exact
/// gate grantee saves pass. That construction (rather than a per-kind class
/// table) is what makes "an op cannot bypass the grantee gate" a property
/// instead of a convention: whatever a payload smuggles, the differ sees the
/// real change, fails closed on anything unexplained, and the gate reads the
/// differ.
///
/// CONCURRENCY: the row is loaded via
/// <see cref="ReconDashboardsDbContext.FindDashboardForUpdateAsync"/> —
/// SELECT … FOR UPDATE on Npgsql, plain load on SQLite where the database
/// write lock already serializes (the provider seam is documented there). Two
/// concurrent ops therefore apply strictly one-after-another against the
/// LATEST doc; the whole-doc save TOCTOU cannot occur on this path.
///
/// SOFT LOCKS advise: a tile-scoped op from someone who is NOT the tile's
/// lock holder is rejected with rcd.dashboard.tile_locked, naming the holder.
/// Locks never gate page/doc ops, and an expired lock stops gating by itself.
/// </summary>
public sealed class DashboardOpService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    IUserDirectory userDirectory,
    ReconDashboardsOptions options,
    TimeProvider timeProvider,
    DashboardTileLockService tileLocks,
    IRcdDashboardOpNotifier notifier)
{
    /// <summary>Caps for client-generated identifiers (defensive, mirrors column-cap philosophy).</summary>
    internal const int MaxOpIdLength = 128;
    internal const int MaxTargetIdLength = 256;

    private static readonly string[] TargetKinds =
        [DashboardOpApplier.TargetTile, DashboardOpApplier.TargetPage, DashboardOpApplier.TargetDoc];

    public async Task<ServiceResult<DashboardOpResult>> ApplyAsync(
        int dashboardId, DashboardOpSubmission op, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        if (ValidateSubmission(op) is { } shapeError)
        {
            return ServiceResult<DashboardOpResult>.Fail(shapeError);
        }

        // A payload can never legitimately exceed the whole-doc cap (it is a
        // fragment of a valid doc) — refuse before parsing so an oversized op
        // costs nothing.
        if (Encoding.UTF8.GetByteCount(op.PayloadJson) > options.Limits.MaxDashboardLayoutBytes)
        {
            return ServiceResult<DashboardOpResult>.Fail(
                ServiceErrorKind.LimitExceeded, "rcd.limit.layout_size",
                $"Op payload exceeds {options.Limits.MaxDashboardLayoutBytes / 1024} KB.");
        }

        // Everything from row load to commit runs inside one transaction: the
        // row lock taken by FindDashboardForUpdateAsync must live exactly as
        // long as the read-modify-write it protects.
        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        var record = await db.FindDashboardForUpdateAsync(dashboardId, ct);
        var share = record is null ? null : await FindShareAsync(dashboardId, userId, ct);

        if (record is null || record.IsDeleted || !DashboardAccessRules.IsVisibleTo(record, userId, share))
        {
            return ServiceResult<DashboardOpResult>.Fail(DashboardAccessRules.NotFoundError(dashboardId));
        }

        if (DashboardAccessRules.IsSystem(record, options.SystemOwnerUserId))
        {
            return ServiceResult<DashboardOpResult>.Fail(DashboardAccessRules.SystemReadOnlyError());
        }

        var fullEditor = record.OwnerUserId == userId || currentUser.CanManageShared;
        if (!fullEditor && share is null)
        {
            // Publish-only viewers can look, never op — same rule as the save path.
            return ServiceResult<DashboardOpResult>.Fail(DashboardAccessRules.EditForbiddenError());
        }

        // Soft-lock advisory (wave 1 semantics): the holder edits, everyone
        // else's ops on that tile are held client-side and rejected here if
        // they arrive anyway. Checked before surgery so the rejection is cheap
        // and carries the holder's name.
        if (string.Equals(op.TargetKind, DashboardOpApplier.TargetTile, StringComparison.Ordinal)
            && tileLocks.GetActive(dashboardId, op.TargetId!) is { } tileLock
            && !string.Equals(tileLock.HolderUserId, userId, StringComparison.Ordinal))
        {
            return ServiceResult<DashboardOpResult>.Fail(
                await TileLockedErrorAsync(tileLock, ct));
        }

        var application = DashboardOpApplier.Apply(record.LayoutJson, op.TargetKind, op.TargetId, op.PayloadJson);
        if (!application.Succeeded)
        {
            return ServiceResult<DashboardOpResult>.Fail(application.Error!);
        }

        var newLayoutJson = application.NewLayoutJson!;
        if (Encoding.UTF8.GetByteCount(newLayoutJson) > options.Limits.MaxDashboardLayoutBytes)
        {
            return ServiceResult<DashboardOpResult>.Fail(
                ServiceErrorKind.LimitExceeded, "rcd.limit.layout_size",
                $"Dashboard layout exceeds {options.Limits.MaxDashboardLayoutBytes / 1024} KB.");
        }

        var summary = DashboardLayoutDiffer.Diff(record.LayoutJson, newLayoutJson);
        if (!summary.HasAnyChange)
        {
            // Idempotent replay (duplicate remove, re-sent op): nothing to
            // persist, gate, or broadcast. The current stamp still travels so
            // the client can advance its baseline.
            return ServiceResult<DashboardOpResult>.Ok(
                new DashboardOpResult(op.OpId, "none", record.UpdatedAtUtc));
        }

        if (!fullEditor)
        {
            var missing = DashboardAccessRules.MissingPermissions(summary, share!);
            if (missing.Count > 0)
            {
                return ServiceResult<DashboardOpResult>.Fail(
                    DashboardAccessRules.PermissionDeniedError(missing));
            }
        }

        var now = timeProvider.GetUtcNow().UtcDateTime;
        record.LayoutJson = newLayoutJson;
        record.UpdatedAtUtc = now;

        // Same "saved" activity the save path writes — live editing stays
        // auditable per change; the 500-row trim keeps the volume bounded.
        DashboardActivityLog.Add(
            db, dashboardId, userId, "saved",
            JsonSerializer.Serialize(summary, DashboardActivityLog.Json), now);

        await db.SaveChangesAsync(ct);
        await DashboardActivityLog.TrimAsync(db, dashboardId, ct);
        await transaction.CommitAsync(ct);

        // Broadcast strictly AFTER commit so receivers never apply an op whose
        // write rolled back. Best-effort by contract (implementations catch) —
        // no try/catch here, same doctrine as the dispatch-progress seam.
        var opClass = PrimaryClassOf(summary);
        await notifier.OpAppliedAsync(
            new RcdDashboardOp(
                dashboardId, op.OpId, userId, opClass,
                op.TargetKind, op.TargetId, op.PayloadJson, now),
            ct);

        return ServiceResult<DashboardOpResult>.Ok(new DashboardOpResult(op.OpId, opClass, now));
    }

    // ------------------------------- tile locks -------------------------------

    /// <summary>
    /// Acquire or heartbeat a soft tile lock. Requires edit access of ANY kind
    /// (a lock is a statement of intent to edit — the actual edit is gated per
    /// class when its op arrives). No tile-existence check on purpose: the
    /// chart builder locks tiles it has not persisted yet.
    /// </summary>
    public async Task<ServiceResult<DashboardTileLockInfo>> AcquireTileLockAsync(
        int dashboardId, string tileId, CancellationToken ct)
    {
        var gate = await CheckLockAccessAsync(dashboardId, tileId, ct);
        if (gate is not null)
        {
            return ServiceResult<DashboardTileLockInfo>.Fail(gate);
        }

        var userId = currentUser.GetUserId();
        if (tileLocks.TryAcquire(dashboardId, tileId, userId, out var held))
        {
            return ServiceResult<DashboardTileLockInfo>.Ok(await ToInfoAsync(held, ct));
        }

        return ServiceResult<DashboardTileLockInfo>.Fail(await TileLockedErrorAsync(held, ct));
    }

    /// <summary>Release the caller's soft lock. Idempotent: releasing a lock you no longer hold succeeds.</summary>
    public async Task<ServiceResult<bool>> ReleaseTileLockAsync(
        int dashboardId, string tileId, CancellationToken ct)
    {
        var gate = await CheckLockAccessAsync(dashboardId, tileId, ct);
        if (gate is not null)
        {
            return ServiceResult<bool>.Fail(gate);
        }

        tileLocks.Release(dashboardId, tileId, currentUser.GetUserId());
        return ServiceResult<bool>.Ok(true);
    }

    // ------------------------------- internals -------------------------------

    /// <summary>
    /// Dominant class for the broadcast/receipt. An op can raise several flags
    /// (a chart-tile remove is charts + removal); the wire carries the most
    /// consequential one, ordered by how destructive/scoped the change is.
    /// Authorization never reads this — it read the full summary already.
    /// </summary>
    private static string PrimaryClassOf(LayoutChangeSummary summary) =>
        summary.HasRemovals ? "removal"
        : summary.ChartsChanged || summary.ChartsRenamed.Count > 0 ? "charts"
        : summary.PagesChanged ? "pages"
        : summary.GeometryChanged ? "geometry"
        : "layout";

    private static ServiceError? ValidateSubmission(DashboardOpSubmission op)
    {
        if (string.IsNullOrWhiteSpace(op.OpId) || op.OpId.Length > MaxOpIdLength)
        {
            return OpInvalid($"opId is required (max {MaxOpIdLength} characters).");
        }

        if (!TargetKinds.Contains(op.TargetKind, StringComparer.Ordinal))
        {
            return OpInvalid("targetKind must be 'tile', 'page' or 'doc'.");
        }

        if (op.TargetId is { } targetId && (targetId.Length == 0 || targetId.Length > MaxTargetIdLength))
        {
            return OpInvalid($"targetId must be non-empty (max {MaxTargetIdLength} characters) when present.");
        }

        if (string.IsNullOrWhiteSpace(op.PayloadJson))
        {
            return OpInvalid("payload is required.");
        }

        return null;
    }

    private static ServiceError OpInvalid(string message) =>
        new(ServiceErrorKind.BadRequest, "rcd.dashboard.op_invalid", message);

    private Task<DashboardShareRecord?> FindShareAsync(int dashboardId, string userId, CancellationToken ct) =>
        db.DashboardShares.FirstOrDefaultAsync(
            s => s.DashboardId == dashboardId && s.UserId == userId, ct);

    /// <summary>Shared gate for both lock endpoints: visible + not system + any edit right.</summary>
    private async Task<ServiceError?> CheckLockAccessAsync(int dashboardId, string tileId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(tileId) || tileId.Length > MaxTargetIdLength)
        {
            return OpInvalid($"tileId must be non-empty (max {MaxTargetIdLength} characters).");
        }

        var userId = currentUser.GetUserId();
        var record = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == dashboardId && !d.IsDeleted, ct);
        var share = record is null ? null : await FindShareAsync(dashboardId, userId, ct);

        if (record is null || !DashboardAccessRules.IsVisibleTo(record, userId, share))
        {
            return DashboardAccessRules.NotFoundError(dashboardId);
        }

        if (DashboardAccessRules.IsSystem(record, options.SystemOwnerUserId))
        {
            return DashboardAccessRules.SystemReadOnlyError();
        }

        var access = DashboardAccessRules.ComputeAccess(
            record, userId, currentUser.CanManageShared, options.SystemOwnerUserId, share);
        return access.CanEdit ? null : DashboardAccessRules.EditForbiddenError();
    }

    /// <summary>
    /// The tile_locked conflict, naming the holder so wave-1 clients can show
    /// "being edited by X" without any presence UI. Display name resolution is
    /// best-effort through the directory; the raw id is the fallback.
    /// </summary>
    private async Task<ServiceError> TileLockedErrorAsync(DashboardTileLock tileLock, CancellationToken ct)
    {
        var info = await ToInfoAsync(tileLock, ct);
        return new ServiceError(
            ServiceErrorKind.Conflict, "rcd.dashboard.tile_locked",
            $"Tile '{tileLock.TileId}' is being edited by {info.HolderDisplayName ?? tileLock.HolderUserId} "
            + $"(lock expires {tileLock.ExpiresAtUtc:O}).");
    }

    private async Task<DashboardTileLockInfo> ToInfoAsync(DashboardTileLock tileLock, CancellationToken ct)
    {
        var users = await userDirectory.ResolveAsync([tileLock.HolderUserId], ct);
        return new DashboardTileLockInfo(
            tileLock.TileId,
            tileLock.HolderUserId,
            users.TryGetValue(tileLock.HolderUserId, out var user) ? user.DisplayName : tileLock.HolderUserId,
            tileLock.AcquiredAtUtc,
            tileLock.ExpiresAtUtc);
    }
}
