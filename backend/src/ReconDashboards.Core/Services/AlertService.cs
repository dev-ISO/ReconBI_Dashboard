using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Services;

public sealed record AlertSaveRequest(
    string Name,
    int? DashboardId,
    string SpecJson,
    AlertOperator Operator,
    decimal Threshold,
    string Recipients,
    int EveryMinutes,
    int CooldownMinutes,
    bool Enabled = true);

public sealed record AlertDetail(
    int Id,
    string Name,
    int? DashboardId,
    JsonElement Spec,
    AlertOperator Operator,
    decimal Threshold,
    string Recipients,
    int EveryMinutes,
    int CooldownMinutes,
    bool Enabled,
    bool OwnerIsMe,
    DateTime? LastEvaluatedUtc,
    DateTime? LastFiredUtc,
    decimal? LastValue,
    DateTime CreatedUtc,
    string OwnerUserId,
    string? OwnerDisplayName);

public sealed record AlertTestResult(decimal? Value, bool WouldFire);

public sealed record AlertFiring(
    int AlertId,
    string Name,
    int? DashboardId,
    DateTime FiredAtUtc,
    decimal? Value,
    AlertOperator Operator,
    decimal Threshold);

/// <summary>
/// Data-alert CRUD + on-demand evaluation. The stored spec must be a
/// single-value chart query (0 dimensions, exactly 1 measure), validated at
/// create/update against the model the OWNER can see. Mutations are
/// owner-or-admin; the test endpoint evaluates under the OWNER's row-filter
/// identity (same impersonation path the scheduler uses) without touching
/// state.
/// </summary>
public sealed class AlertService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    DataModelService models,
    IServiceProvider scopeServices,
    TimeProvider timeProvider,
    IUserDirectory userDirectory)
{
    /// <summary>Minimum evaluation cadence in minutes.</summary>
    public const int MinEveryMinutes = 5;

    private static readonly JsonSerializerOptions SpecJsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// scope=mine (default): the caller's alerts. scope=all: every alert,
    /// admin-only (CanManageShared), with owner display names via
    /// IUserDirectory — the same shape SubscriptionService.ListAsync has.
    /// </summary>
    public async Task<ServiceResult<IReadOnlyList<AlertDetail>>> ListAsync(
        bool allScope, int? dashboardId, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        if (allScope && !currentUser.CanManageShared)
        {
            return ServiceResult<IReadOnlyList<AlertDetail>>.Fail(
                ServiceErrorKind.Forbidden, "rcd.alert.admin_required",
                "Viewing all users' alerts requires manage-shared rights.");
        }

        var query = db.Alerts.AsNoTracking();
        if (!allScope)
        {
            query = query.Where(a => a.OwnerUserId == userId);
        }

        if (dashboardId is { } id)
        {
            query = query.Where(a => a.DashboardId == id);
        }

        var records = await query.OrderBy(a => a.Name).ToListAsync(ct);
        var owners = allScope
            ? await userDirectory.ResolveAsync(records.Select(r => r.OwnerUserId).Distinct(), ct)
            : null;
        return ServiceResult<IReadOnlyList<AlertDetail>>.Ok(records
            .Select(r => Materialize(
                r, userId,
                owners is not null && owners.TryGetValue(r.OwnerUserId, out var info) ? info.DisplayName : null))
            .ToArray());
    }

    /// <summary>Kept for the per-dashboard alert list (mine-only, never fails).</summary>
    public async Task<IReadOnlyList<AlertDetail>> ListMineAsync(int? dashboardId, CancellationToken ct)
    {
        var result = await ListAsync(allScope: false, dashboardId, ct);
        return result.Value!;
    }

    /// <summary>One-click pause/resume, owner-or-admin — same contract as subscriptions.</summary>
    public async Task<ServiceResult<AlertDetail>> SetEnabledAsync(int id, bool enabled, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Alerts.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<AlertDetail>(id);
        }

        record.Enabled = enabled;
        await db.SaveChangesAsync(ct);
        return ServiceResult<AlertDetail>.Ok(Materialize(record, userId));
    }

    public async Task<ServiceResult<AlertDetail>> CreateAsync(AlertSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        var validation = await ValidateAsync(request, ct);
        if (validation is not null)
        {
            return ServiceResult<AlertDetail>.Fail(validation);
        }

        var record = new AlertRecord
        {
            OwnerUserId = userId,
            CreatedUtc = timeProvider.GetUtcNow().UtcDateTime,
        };
        Apply(record, request);

        db.Alerts.Add(record);
        await db.SaveChangesAsync(ct);
        return ServiceResult<AlertDetail>.Ok(Materialize(record, userId));
    }

    public async Task<ServiceResult<AlertDetail>> UpdateAsync(int id, AlertSaveRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Alerts.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<AlertDetail>(id);
        }

        var validation = await ValidateAsync(request, ct);
        if (validation is not null)
        {
            return ServiceResult<AlertDetail>.Fail(validation);
        }

        Apply(record, request);
        await db.SaveChangesAsync(ct);
        return ServiceResult<AlertDetail>.Ok(Materialize(record, userId));
    }

    public async Task<ServiceResult<bool>> DeleteAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Alerts.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<bool>(id);
        }

        db.Alerts.Remove(record);
        await db.SaveChangesAsync(ct);
        return ServiceResult<bool>.Ok(true);
    }

    /// <summary>
    /// Evaluates the alert right now under the OWNER's identity and reports
    /// the value and whether the condition holds (cooldown ignored — the point
    /// is to preview the comparison). Never mutates alert state.
    /// </summary>
    public async Task<ServiceResult<AlertTestResult>> TestAsync(int id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var record = await db.Alerts.AsNoTracking().FirstOrDefaultAsync(a => a.Id == id, ct);
        if (record is null || (record.OwnerUserId != userId && !currentUser.CanManageShared))
        {
            return NotFound<AlertTestResult>(id);
        }

        var (value, error) = await SchedulingEvaluator.EvaluateAlertValueAsync(scopeServices, record, ct);
        if (error is not null)
        {
            return ServiceResult<AlertTestResult>.Fail(
                ServiceErrorKind.BadRequest, "rcd.alert.evaluation_failed", error);
        }

        var wouldFire = value is { } evaluated
            && ScheduleDue.ConditionMet(record.Operator, evaluated, record.Threshold);
        return ServiceResult<AlertTestResult>.Ok(new AlertTestResult(value, wouldFire));
    }

    /// <summary>
    /// Firings from the last 24 hours the caller may see: their own alerts,
    /// plus alerts attached to dashboards visible to them (owner or shared).
    /// Feeds the frontend's in-app notification poll.
    /// </summary>
    public async Task<IReadOnlyList<AlertFiring>> RecentFiringsAsync(int? dashboardId, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var cutoff = timeProvider.GetUtcNow().UtcDateTime.AddHours(-24);

        var query = db.Alerts.AsNoTracking()
            .Where(a => a.LastFiredUtc != null && a.LastFiredUtc >= cutoff)
            .Where(a => a.OwnerUserId == userId
                || (a.DashboardId != null && db.Dashboards.Any(d =>
                    d.Id == a.DashboardId && !d.IsDeleted && (d.OwnerUserId == userId || d.IsShared))));

        if (dashboardId is { } id)
        {
            query = query.Where(a => a.DashboardId == id);
        }

        var records = await query.OrderByDescending(a => a.LastFiredUtc).ToListAsync(ct);
        return records
            .Select(a => new AlertFiring(
                a.Id, a.Name, a.DashboardId, a.LastFiredUtc!.Value, a.LastValue, a.Operator, a.Threshold))
            .ToArray();
    }

    private static void Apply(AlertRecord record, AlertSaveRequest request)
    {
        record.Name = request.Name.Trim();
        record.DashboardId = request.DashboardId;
        record.SpecJson = request.SpecJson;
        record.Operator = request.Operator;
        record.Threshold = request.Threshold;
        record.Recipients = request.Recipients.Trim();
        record.EveryMinutes = request.EveryMinutes;
        record.CooldownMinutes = request.CooldownMinutes;
        record.Enabled = request.Enabled;
    }

    private async Task<ServiceError?> ValidateAsync(AlertSaveRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            return new ServiceError(ServiceErrorKind.BadRequest, "rcd.alert.name_required", "Alert name is required.");
        }

        if (!Enum.IsDefined(request.Operator))
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.alert.bad_operator",
                "Operator must be one of gt, gte, lt, lte, eq.");
        }

        if (request.EveryMinutes < MinEveryMinutes)
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.alert.bad_cadence",
                $"Alerts evaluate at most every {MinEveryMinutes} minutes.");
        }

        if (request.CooldownMinutes < 0)
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.alert.bad_cadence", "Cooldown minutes cannot be negative.");
        }

        if (SchedulingEvaluator.SplitRecipients(request.Recipients).Count == 0)
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.alert.recipients_required",
                "At least one recipient email address is required (semicolon-separated).");
        }

        ChartQuerySpec? spec;
        try
        {
            spec = JsonSerializer.Deserialize<ChartQuerySpec>(request.SpecJson, SpecJsonOptions);
        }
        catch (JsonException ex)
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.alert.bad_spec", $"Alert query is not valid JSON: {ex.Message}");
        }

        if (spec is null)
        {
            return new ServiceError(ServiceErrorKind.BadRequest, "rcd.alert.bad_spec", "Alert query is required.");
        }

        if (spec.Dimensions is not { Count: 0 } || spec.Measures is not { Count: 1 })
        {
            return new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.alert.bad_spec",
                "An alert query must produce a single value: no dimensions and exactly one measure.");
        }

        // The model must exist and be visible to the caller (the alert owner).
        var model = await models.GetAsync(spec.ModelId, ct);
        if (!model.Succeeded)
        {
            return model.Error;
        }

        if (request.DashboardId is { } dashboardId)
        {
            var userId = currentUser.GetUserId();
            var visible = await db.Dashboards.AnyAsync(
                d => d.Id == dashboardId && !d.IsDeleted && (d.OwnerUserId == userId || d.IsShared), ct);
            if (!visible)
            {
                return new ServiceError(
                    ServiceErrorKind.NotFound, "rcd.dashboard.not_found",
                    $"Dashboard {dashboardId} does not exist or is not visible to you.");
            }
        }

        return null;
    }

    private static AlertDetail Materialize(AlertRecord record, string userId, string? ownerDisplayName = null)
    {
        using var doc = JsonDocument.Parse(record.SpecJson);
        return new AlertDetail(
            record.Id, record.Name, record.DashboardId, doc.RootElement.Clone(), record.Operator,
            record.Threshold, record.Recipients, record.EveryMinutes, record.CooldownMinutes,
            record.Enabled, record.OwnerUserId == userId, record.LastEvaluatedUtc, record.LastFiredUtc,
            record.LastValue, record.CreatedUtc, record.OwnerUserId, ownerDisplayName);
    }

    private static ServiceResult<T> NotFound<T>(int id) =>
        ServiceResult<T>.Fail(
            ServiceErrorKind.NotFound, "rcd.alert.not_found",
            $"Alert {id} does not exist or is not visible to you.");
}
