using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Persistence;

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
    DateTime CreatedUtc);

/// <summary>
/// Subscription CRUD. Creating requires READ access to the target dashboard
/// (owner or shared) — View-policy users cannot subscribe to dashboards they
/// cannot open. Mutations are owner-or-admin, matching how dashboard edit
/// rights are checked (CanManageShared).
/// </summary>
public sealed class SubscriptionService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    TimeProvider timeProvider)
{
    /// <summary>Minimum minutes between interval runs.</summary>
    public const int MinIntervalMinutes = 5;

    public async Task<IReadOnlyList<SubscriptionDetail>> ListMineAsync(int? dashboardId, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var query = db.Subscriptions.AsNoTracking().Where(s => s.OwnerUserId == userId);
        if (dashboardId is { } id)
        {
            query = query.Where(s => s.DashboardId == id);
        }

        var records = await query.OrderBy(s => s.Name).ToListAsync(ct);
        return records.Select(r => Materialize(r, userId)).ToArray();
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
        return ServiceResult<SubscriptionDetail>.Ok(Materialize(record, userId));
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
        return ServiceResult<SubscriptionDetail>.Ok(Materialize(record, userId));
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

    private static SubscriptionDetail Materialize(SubscriptionRecord record, string userId) =>
        new(record.Id, record.DashboardId, record.Name, record.ScheduleKind, record.IntervalMinutes,
            record.TimeOfDayMinutesUtc, record.DayOfWeekUtc, record.Recipients, record.Format,
            record.Enabled, record.OwnerUserId == userId, record.LastRunUtc, record.CreatedUtc);

    private static ServiceResult<T> NotFound<T>(int id) =>
        ServiceResult<T>.Fail(
            ServiceErrorKind.NotFound, "rcd.subscription.not_found",
            $"Subscription {id} does not exist or is not visible to you.");

    private static ServiceResult<SubscriptionDetail> DashboardNotFound(int dashboardId) =>
        ServiceResult<SubscriptionDetail>.Fail(
            ServiceErrorKind.NotFound, "rcd.dashboard.not_found",
            $"Dashboard {dashboardId} does not exist or is not visible to you.");
}
