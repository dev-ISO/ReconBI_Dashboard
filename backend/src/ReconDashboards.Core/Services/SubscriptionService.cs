using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Services;

// The *Utc member names below are HISTORICAL (they mirror the entity/storage
// columns): TimeOfDayMinutesUtc is minutes past LOCAL midnight and DayOfWeekUtc
// the LOCAL weekday in the host's ReconDashboardsOptions.ScheduleTimeZoneId
// zone. The wire layer already speaks timeOfDayLocal/dayOfWeek.
public sealed record SubscriptionSaveRequest(
    int DashboardId,
    string Name,
    SubscriptionScheduleKind ScheduleKind,
    int? IntervalMinutes,
    int? TimeOfDayMinutesUtc,
    int? DayOfWeekUtc,
    string Recipients,
    SubscriptionFormat Format,
    bool Enabled = true);

/// <summary>Latest-dispatch roll-up for the list rows' "Last delivery" badge.</summary>
public sealed record DispatchSummary(
    long DispatchId,
    DispatchStatus Status,
    DispatchTrigger Trigger,
    DateTime StartedUtc,
    DateTime? FinishedUtc,
    string? Error,
    int SentCount,
    int FailedCount,
    int OptedOutCount,
    int PendingCount);

public sealed record SubscriptionDetail(
    int Id,
    int DashboardId,
    string Name,
    SubscriptionScheduleKind ScheduleKind,
    int? IntervalMinutes,
    int? TimeOfDayMinutesUtc,
    int? DayOfWeekUtc,
    string Recipients,
    SubscriptionFormat Format,
    bool Enabled,
    bool OwnerIsMe,
    DateTime? LastRunUtc,
    DateTime CreatedUtc,
    string OwnerUserId,
    string? OwnerDisplayName,
    DispatchSummary? LastDispatch);

public sealed record DispatchRecipientDetail(
    long Id,
    string Email,
    DispatchRecipientStatus Status,
    int Attempts,
    string? Error,
    DateTime? SentUtc,
    DateTime? OpenedUtc,
    int OpenCount);

public sealed record DispatchDetail(
    long Id,
    int SubscriptionId,
    string SubscriptionName,
    int DashboardId,
    DispatchTrigger Trigger,
    string? RequestedBy,
    DateTime StartedUtc,
    DateTime? FinishedUtc,
    DispatchStatus Status,
    string? Error,
    IReadOnlyList<DispatchRecipientDetail> Recipients);

public sealed record OptOutDetail(string Email, DateTime OptedOutUtc);

/// <summary>
/// Everything the anonymous unsubscribe confirm page needs. SubscriptionName
/// is null when the subscription was deleted after the email went out — the
/// page still offers the GLOBAL opt-out (that is exactly the recipient the
/// global table exists for).
/// </summary>
public sealed record UnsubscribeContext(
    int SubscriptionId,
    string Email,
    string? SubscriptionName,
    bool AlreadyOptedOut,
    bool AlreadyGlobal);

/// <summary>
/// Subscription CRUD. Creating requires READ access to the target dashboard
/// (owner or shared) — View-policy users cannot subscribe to dashboards they
/// cannot open. Mutations are owner-or-admin, matching how dashboard edit
/// rights are checked (CanManageShared).
/// </summary>
public sealed class SubscriptionService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    TimeProvider timeProvider,
    ReconDashboardsOptions options,
    SubscriptionDispatcher dispatcher,
    IUserDirectory userDirectory)
{
    /// <summary>Minimum minutes between interval runs.</summary>
    public const int MinIntervalMinutes = 5;

    /// <summary>Dispatch-history page size ceiling; the UI asks for 20.</summary>
    public const int MaxDispatchHistory = 100;

    /// <summary>
    /// scope=mine (default): the caller's subscriptions. scope=all: every
    /// subscription, admin-only (CanManageShared), with owner display names
    /// resolved through IUserDirectory. Both scopes decorate each row with a
    /// latest-dispatch summary so list rows can show the "Last delivery"
    /// badge without N+1 calls.
    /// </summary>
    public async Task<ServiceResult<IReadOnlyList<SubscriptionDetail>>> ListAsync(
        bool allScope, int? dashboardId, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        if (allScope && !currentUser.CanManageShared)
        {
            return ServiceResult<IReadOnlyList<SubscriptionDetail>>.Fail(
                ServiceErrorKind.Forbidden, "rcd.subscription.admin_required",
                "Viewing all users' subscriptions requires manage-shared rights.");
        }

        var query = db.Subscriptions.AsNoTracking();
        if (!allScope)
        {
            query = query.Where(s => s.OwnerUserId == userId);
        }

        if (dashboardId is { } id)
        {
            query = query.Where(s => s.DashboardId == id);
        }

        var records = await query.OrderBy(s => s.Name).ToListAsync(ct);
        var summaries = await LoadLastDispatchSummariesAsync(records.Select(r => r.Id).ToArray(), ct);
        var owners = allScope
            ? await userDirectory.ResolveAsync(records.Select(r => r.OwnerUserId).Distinct(), ct)
            : null;

        return ServiceResult<IReadOnlyList<SubscriptionDetail>>.Ok(records
            .Select(r => Materialize(
                r, userId,
                owners is not null && owners.TryGetValue(r.OwnerUserId, out var info) ? info.DisplayName : null,
                summaries.GetValueOrDefault(r.Id)))
            .ToArray());
    }

    /// <summary>Kept for the per-dashboard Subscribe… dialog (mine-only, never fails).</summary>
    public async Task<IReadOnlyList<SubscriptionDetail>> ListMineAsync(int? dashboardId, CancellationToken ct)
    {
        var result = await ListAsync(allScope: false, dashboardId, ct);
        return result.Value!;
    }

    /// <summary>
    /// Latest dispatch per subscription plus its per-status recipient counts.
    /// Grouped queries only — translates on both Npgsql and the SQLite the
    /// host test suites run on.
    /// </summary>
    private async Task<Dictionary<int, DispatchSummary>> LoadLastDispatchSummariesAsync(
        int[] subscriptionIds, CancellationToken ct)
    {
        var result = new Dictionary<int, DispatchSummary>();
        if (subscriptionIds.Length == 0)
        {
            return result;
        }

        var latestStarts = await db.SubscriptionDispatches.AsNoTracking()
            .Where(d => subscriptionIds.Contains(d.SubscriptionId))
            .GroupBy(d => d.SubscriptionId)
            .Select(g => new { SubscriptionId = g.Key, StartedUtc = g.Max(d => d.StartedUtc) })
            .ToListAsync(ct);
        if (latestStarts.Count == 0)
        {
            return result;
        }

        var startTimes = latestStarts.Select(l => l.StartedUtc).Distinct().ToArray();
        var candidates = await db.SubscriptionDispatches.AsNoTracking()
            .Where(d => subscriptionIds.Contains(d.SubscriptionId) && startTimes.Contains(d.StartedUtc))
            .ToListAsync(ct);
        var latest = latestStarts
            .Select(l => candidates
                .Where(d => d.SubscriptionId == l.SubscriptionId && d.StartedUtc == l.StartedUtc)
                .OrderByDescending(d => d.Id) // same-instant tie: newest row wins
                .First())
            .ToArray();

        var dispatchIds = latest.Select(d => d.Id).ToArray();
        // Recipient rows are few per dispatch; counting in memory keeps one
        // simple query AND lets the summary surface the first recipient error
        // (the "Failed — SMTP timeout" badge) without another round trip.
        var recipientRows = await db.SubscriptionDispatchRecipients.AsNoTracking()
            .Where(r => dispatchIds.Contains(r.DispatchId))
            .OrderBy(r => r.Id)
            .Select(r => new { r.DispatchId, r.Status, r.Error })
            .ToListAsync(ct);

        foreach (var dispatch in latest)
        {
            var rows = recipientRows.Where(r => r.DispatchId == dispatch.Id).ToArray();
            result[dispatch.SubscriptionId] = new DispatchSummary(
                dispatch.Id, dispatch.Status, dispatch.Trigger, dispatch.StartedUtc, dispatch.FinishedUtc,
                dispatch.Error ?? rows.FirstOrDefault(r => r.Error != null)?.Error,
                rows.Count(r => r.Status == DispatchRecipientStatus.Sent),
                rows.Count(r => r.Status == DispatchRecipientStatus.Failed),
                rows.Count(r => r.Status == DispatchRecipientStatus.OptedOut),
                rows.Count(r => r.Status == DispatchRecipientStatus.Pending));
        }

        return result;
    }

    public async Task<ServiceResult<SubscriptionDetail>> CreateAsync(SubscriptionSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        if (Validate(request) is { } error)
        {
            return ServiceResult<SubscriptionDetail>.Fail(error);
        }

        if (!await DashboardVisibleToAsync(request.DashboardId, userId, ct))
        {
            return DashboardNotFound(request.DashboardId);
        }

        var record = new SubscriptionRecord
        {
            DashboardId = request.DashboardId,
            OwnerUserId = userId,
            CreatedUtc = timeProvider.GetUtcNow().UtcDateTime,
        };
        Apply(record, request);

        db.Subscriptions.Add(record);
        await db.SaveChangesAsync(ct);
        return ServiceResult<SubscriptionDetail>.Ok(Materialize(record, userId, null, null));
    }

    public async Task<ServiceResult<SubscriptionDetail>> UpdateAsync(
        int id, SubscriptionSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Subscriptions.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<SubscriptionDetail>(id);
        }

        if (Validate(request) is { } error)
        {
            return ServiceResult<SubscriptionDetail>.Fail(error);
        }

        // The dashboard must be readable by the subscription's OWNER (not the
        // editing admin) — the snapshot renders under the owner's identity.
        if (!await DashboardVisibleToAsync(request.DashboardId, record.OwnerUserId, ct))
        {
            return DashboardNotFound(request.DashboardId);
        }

        record.DashboardId = request.DashboardId;
        Apply(record, request);
        await db.SaveChangesAsync(ct);
        return ServiceResult<SubscriptionDetail>.Ok(Materialize(record, userId, null, null));
    }

    public async Task<ServiceResult<bool>> DeleteAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Subscriptions.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<bool>(id);
        }

        db.Subscriptions.Remove(record);
        await db.SaveChangesAsync(ct);
        return ServiceResult<bool>.Ok(true);
    }

    /// <summary>One-click pause/resume, owner-or-admin (mirrors SystemNotification SetEnabled).</summary>
    public async Task<ServiceResult<SubscriptionDetail>> SetEnabledAsync(int id, bool enabled, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Subscriptions.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<SubscriptionDetail>(id);
        }

        record.Enabled = enabled;
        await db.SaveChangesAsync(ct);
        return ServiceResult<SubscriptionDetail>.Ok(Materialize(record, userId, null, null));
    }

    /// <summary>
    /// Kicks off a manual dispatch through the SAME pipeline as scheduled
    /// sends. Owner-or-admin; the dispatcher enforces the one-concurrent-
    /// manual-send-per-subscription guard (429).
    /// </summary>
    public async Task<ServiceResult<long>> SendNowAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Subscriptions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<long>(id);
        }

        return await dispatcher.StartManualAsync(id, userId, ct);
    }

    /// <summary>Dispatch history (newest first) with per-recipient rows; owner-or-admin.</summary>
    public async Task<ServiceResult<IReadOnlyList<DispatchDetail>>> ListDispatchesAsync(
        int id, int limit, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Subscriptions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<IReadOnlyList<DispatchDetail>>(id);
        }

        var take = Math.Clamp(limit, 1, MaxDispatchHistory);
        var dispatches = await db.SubscriptionDispatches.AsNoTracking()
            .Where(d => d.SubscriptionId == id)
            .OrderByDescending(d => d.StartedUtc)
            .ThenByDescending(d => d.Id)
            .Take(take)
            .ToListAsync(ct);
        var dispatchIds = dispatches.Select(d => d.Id).ToArray();
        var recipients = await db.SubscriptionDispatchRecipients.AsNoTracking()
            .Where(r => dispatchIds.Contains(r.DispatchId))
            .OrderBy(r => r.Id)
            .ToListAsync(ct);

        return ServiceResult<IReadOnlyList<DispatchDetail>>.Ok(dispatches
            .Select(d => new DispatchDetail(
                d.Id, d.SubscriptionId, d.SubscriptionName, d.DashboardId, d.Trigger, d.RequestedBy,
                d.StartedUtc, d.FinishedUtc, d.Status, d.Error,
                recipients
                    .Where(r => r.DispatchId == d.Id)
                    .Select(r => new DispatchRecipientDetail(
                        r.Id, r.Email, r.Status, r.Attempts, r.Error, r.SentUtc, r.OpenedUtc, r.OpenCount))
                    .ToArray()))
            .ToArray());
    }

    // -------------------------------------------------------------- opt-outs

    /// <summary>Per-subscription opt-outs; owner-or-admin.</summary>
    public async Task<ServiceResult<IReadOnlyList<OptOutDetail>>> ListOptOutsAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Subscriptions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<IReadOnlyList<OptOutDetail>>(id);
        }

        var rows = await db.SubscriptionOptOuts.AsNoTracking()
            .Where(o => o.SubscriptionId == id)
            .OrderBy(o => o.Email)
            .ToListAsync(ct);
        return ServiceResult<IReadOnlyList<OptOutDetail>>.Ok(
            rows.Select(o => new OptOutDetail(o.Email, o.OptedOutUtc)).ToArray());
    }

    /// <summary>Clears one per-subscription opt-out (re-invite someone); idempotent; owner-or-admin.</summary>
    public async Task<ServiceResult<bool>> ClearOptOutAsync(int id, string email, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Subscriptions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<bool>(id);
        }

        var normalized = email.Trim().ToLowerInvariant();
        var row = await db.SubscriptionOptOuts
            .FirstOrDefaultAsync(o => o.SubscriptionId == id && o.Email == normalized, ct);
        if (row is not null)
        {
            db.SubscriptionOptOuts.Remove(row);
            await db.SaveChangesAsync(ct);
        }

        return ServiceResult<bool>.Ok(true);
    }

    /// <summary>Global suppressions; admin-only (they silence a person everywhere).</summary>
    public async Task<ServiceResult<IReadOnlyList<OptOutDetail>>> ListGlobalOptOutsAsync(CancellationToken ct)
    {
        if (!currentUser.CanManageShared)
        {
            return AdminRequired<IReadOnlyList<OptOutDetail>>();
        }

        var rows = await db.GlobalOptOuts.AsNoTracking().OrderBy(o => o.Email).ToListAsync(ct);
        return ServiceResult<IReadOnlyList<OptOutDetail>>.Ok(
            rows.Select(o => new OptOutDetail(o.Email, o.OptedOutUtc)).ToArray());
    }

    /// <summary>Clears one global suppression; idempotent; admin-only.</summary>
    public async Task<ServiceResult<bool>> ClearGlobalOptOutAsync(string email, CancellationToken ct)
    {
        if (!currentUser.CanManageShared)
        {
            return AdminRequired<bool>();
        }

        var normalized = email.Trim().ToLowerInvariant();
        var row = await db.GlobalOptOuts.FirstOrDefaultAsync(o => o.Email == normalized, ct);
        if (row is not null)
        {
            db.GlobalOptOuts.Remove(row);
            await db.SaveChangesAsync(ct);
        }

        return ServiceResult<bool>.Ok(true);
    }

    // -------------------------------- anonymous token flows (no identity!)

    /// <summary>
    /// Validates an unsubscribe token and describes what the confirm page
    /// should offer. Returns null for a missing secret or an invalid/foreign
    /// token — the endpoint renders the same "link no longer valid" page for
    /// every failure mode, so nothing about the secret can be probed.
    /// NEVER touches ICurrentUserProvider: this path is anonymous by design.
    /// </summary>
    public async Task<UnsubscribeContext?> ReadUnsubscribeTokenAsync(string? token, CancellationToken ct)
    {
        var secret = options.UnsubscribeSecret;
        if (string.IsNullOrWhiteSpace(secret)
            || !RcdSignedTokens.TryReadUnsubscribeToken(secret, token, out var subscriptionId, out var email))
        {
            return null;
        }

        var normalized = email.Trim().ToLowerInvariant();
        var subscriptionName = await db.Subscriptions.AsNoTracking()
            .Where(s => s.Id == subscriptionId)
            .Select(s => s.Name)
            .FirstOrDefaultAsync(ct);
        var alreadyOptedOut = await db.SubscriptionOptOuts
            .AnyAsync(o => o.SubscriptionId == subscriptionId && o.Email == normalized, ct);
        var alreadyGlobal = await db.GlobalOptOuts.AnyAsync(o => o.Email == normalized, ct);
        return new UnsubscribeContext(subscriptionId, email, subscriptionName, alreadyOptedOut, alreadyGlobal);
    }

    /// <summary>
    /// Records the opt-out a confirm-page POST chose: this subscription only,
    /// or ALL dashboard subscription emails (global). Idempotent. Returns
    /// false only for an invalid token. Emails are stored lower-cased so
    /// dispatch-time matching is case-insensitive.
    /// </summary>
    public async Task<bool> RecordUnsubscribeAsync(string? token, bool global, CancellationToken ct)
    {
        var secret = options.UnsubscribeSecret;
        if (string.IsNullOrWhiteSpace(secret)
            || !RcdSignedTokens.TryReadUnsubscribeToken(secret, token, out var subscriptionId, out var email))
        {
            return false;
        }

        var normalized = email.Trim().ToLowerInvariant();
        var nowUtc = timeProvider.GetUtcNow().UtcDateTime;
        if (global)
        {
            if (!await db.GlobalOptOuts.AnyAsync(o => o.Email == normalized, ct))
            {
                db.GlobalOptOuts.Add(new GlobalOptOutRecord { Email = normalized, OptedOutUtc = nowUtc });
                await db.SaveChangesAsync(ct);
            }
        }
        else if (!await db.SubscriptionOptOuts
                     .AnyAsync(o => o.SubscriptionId == subscriptionId && o.Email == normalized, ct))
        {
            db.SubscriptionOptOuts.Add(new SubscriptionOptOutRecord
            {
                SubscriptionId = subscriptionId,
                Email = normalized,
                OptedOutUtc = nowUtc,
            });
            await db.SaveChangesAsync(ct);
        }

        return true;
    }

    /// <summary>
    /// Open-pixel hit: stamps first-open and bumps the counter. Silently does
    /// nothing for invalid tokens or pruned rows — the endpoint always serves
    /// the GIF so mail clients never render a broken image.
    /// </summary>
    public async Task RecordOpenAsync(string? token, CancellationToken ct)
    {
        var secret = options.UnsubscribeSecret;
        if (string.IsNullOrWhiteSpace(secret)
            || !RcdSignedTokens.TryReadOpenToken(secret, token, out var recipientId))
        {
            return;
        }

        var row = await db.SubscriptionDispatchRecipients
            .FirstOrDefaultAsync(r => r.Id == recipientId, ct);
        if (row is null)
        {
            return;
        }

        row.OpenedUtc ??= timeProvider.GetUtcNow().UtcDateTime;
        row.OpenCount++;
        await db.SaveChangesAsync(ct);
    }

    private static void Apply(SubscriptionRecord record, SubscriptionSaveRequest request)
    {
        record.Name = request.Name.Trim();
        record.ScheduleKind = request.ScheduleKind;
        record.IntervalMinutes = request.ScheduleKind == SubscriptionScheduleKind.Interval
            ? request.IntervalMinutes
            : null;
        record.TimeOfDayMinutesUtc = request.ScheduleKind != SubscriptionScheduleKind.Interval
            ? request.TimeOfDayMinutesUtc
            : null;
        record.DayOfWeekUtc = request.ScheduleKind == SubscriptionScheduleKind.Weekly
            ? request.DayOfWeekUtc
            : null;
        record.Recipients = request.Recipients.Trim();
        record.Format = request.Format;
        record.Enabled = request.Enabled;
    }

    private static ServiceError? Validate(SubscriptionSaveRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.subscription.name_required", "Subscription name is required.");
        }

        if (!Enum.IsDefined(request.ScheduleKind))
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.subscription.bad_schedule", "Unknown schedule kind.");
        }

        if (!Enum.IsDefined(request.Format))
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.subscription.bad_format", "Format must be 'html' or 'csv'.");
        }

        switch (request.ScheduleKind)
        {
            case SubscriptionScheduleKind.Interval
                when request.IntervalMinutes is not { } interval || interval < MinIntervalMinutes:
                return new ServiceError(
                    ServiceErrorKind.BadRequest, "rcd.subscription.bad_schedule",
                    $"Interval schedules need intervalMinutes of at least {MinIntervalMinutes}.");
            case SubscriptionScheduleKind.Daily or SubscriptionScheduleKind.Weekly
                when request.TimeOfDayMinutesUtc is not { } minutes || minutes is < 0 or > 1439:
                return new ServiceError(
                    ServiceErrorKind.BadRequest, "rcd.subscription.bad_schedule",
                    "Daily and weekly schedules need a time of day (00:00..23:59).");
            case SubscriptionScheduleKind.Weekly
                when request.DayOfWeekUtc is not { } day || day is < 0 or > 6:
                return new ServiceError(
                    ServiceErrorKind.BadRequest, "rcd.subscription.bad_schedule",
                    "Weekly schedules need dayOfWeek between 0 (Sunday) and 6 (Saturday).");
        }

        if (Scheduling.SchedulingEvaluator.SplitRecipients(request.Recipients).Count == 0)
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.subscription.recipients_required",
                "At least one recipient email address is required (semicolon-separated).");
        }

        return null;
    }

    private async Task<bool> DashboardVisibleToAsync(int dashboardId, string userId, CancellationToken ct) =>
        await db.Dashboards.AnyAsync(
            d => d.Id == dashboardId && !d.IsDeleted && (d.OwnerUserId == userId || d.IsShared), ct);

    private static SubscriptionDetail Materialize(
        SubscriptionRecord record, string userId, string? ownerDisplayName, DispatchSummary? lastDispatch) =>
        new(record.Id, record.DashboardId, record.Name, record.ScheduleKind, record.IntervalMinutes,
            record.TimeOfDayMinutesUtc, record.DayOfWeekUtc, record.Recipients, record.Format,
            record.Enabled, record.OwnerUserId == userId, record.LastRunUtc, record.CreatedUtc,
            record.OwnerUserId, ownerDisplayName, lastDispatch);

    private static ServiceResult<T> AdminRequired<T>() =>
        ServiceResult<T>.Fail(
            ServiceErrorKind.Forbidden, "rcd.subscription.admin_required",
            "Global opt-outs affect every subscription; managing them requires manage-shared rights.");

    private static ServiceResult<T> NotFound<T>(int id) =>
        ServiceResult<T>.Fail(
            ServiceErrorKind.NotFound, "rcd.subscription.not_found",
            $"Subscription {id} does not exist or is not visible to you.");

    private static ServiceResult<SubscriptionDetail> DashboardNotFound(int dashboardId) =>
        ServiceResult<SubscriptionDetail>.Fail(
            ServiceErrorKind.NotFound, "rcd.dashboard.not_found",
            $"Dashboard {dashboardId} does not exist or is not visible to you.");
}
