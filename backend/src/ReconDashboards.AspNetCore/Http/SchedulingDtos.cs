using System.Globalization;
using System.Text.Json;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Http;

// Wire DTOs for subscriptions and alerts. Enum values use the camelCase
// converters attached to the enum types ("interval"/"daily"/"weekly",
// "html"/"csv", "gt".."eq"), so the wire format is stable regardless of the
// host's MVC JSON configuration. Times of day travel as "HH:mm" strings in
// the HOST'S schedule zone (ReconDashboardsOptions.ScheduleTimeZoneId) —
// hence timeOfDayLocal/dayOfWeek on the wire, even though the storage columns
// keep their historical *Utc names.

/// <summary>
/// Wire "content" object (EMAIL-CONTENT-DESIGN pinned shape). Missing
/// sub-fields take the documented defaults so a partial object from an older
/// client is usable; explicit bad values are still rejected by validation.
/// </summary>
public sealed record SubscriptionContentRequest(
    SubscriptionContentBody Body,
    IReadOnlyList<string>? ExcludedTileIds,
    int? ImageWidth,
    int? MaxTableRows);

public sealed record SaveSubscriptionRequest(
    int DashboardId,
    string Name,
    SubscriptionScheduleKind ScheduleKind,
    int? IntervalMinutes,
    string? TimeOfDayLocal,
    int? DayOfWeek,
    string Recipients,
    SubscriptionFormat Format,
    bool Enabled = true,
    SubscriptionContentRequest? Content = null);

public sealed record DispatchSummaryResponse(
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

public sealed record SubscriptionResponse(
    int Id,
    int DashboardId,
    string Name,
    SubscriptionScheduleKind ScheduleKind,
    int? IntervalMinutes,
    string? TimeOfDayLocal,
    int? DayOfWeek,
    string Recipients,
    SubscriptionFormat Format,
    bool Enabled,
    // Object for configured rows; null mirrors a legacy NULL ContentJson.
    SubscriptionContentConfig? Content,
    bool OwnerIsMe,
    DateTime? LastRunUtc,
    DateTime CreatedUtc,
    string OwnerUserId,
    string? OwnerDisplayName,
    DispatchSummaryResponse? LastDispatch);

/// <summary>POST subscriptions/{id}/preview body: {} previews the saved config, content overrides it.</summary>
public sealed record SubscriptionPreviewRequest(SubscriptionContentRequest? Content = null);

/// <summary>POST dashboards/{id}/subscriptions/preview body (unsaved draft; format defaults to html).</summary>
public sealed record DraftSubscriptionPreviewRequest(
    SubscriptionFormat? Format = null,
    SubscriptionContentRequest? Content = null);

public sealed record SubscriptionPreviewResponse(string Subject, string Html);

public sealed record DispatchRecipientResponse(
    long Id,
    string Email,
    DispatchRecipientStatus Status,
    int Attempts,
    string? Error,
    DateTime? SentUtc,
    DateTime? OpenedUtc,
    int OpenCount);

public sealed record DispatchResponse(
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
    IReadOnlyList<DispatchRecipientResponse> Recipients);

public sealed record OptOutResponse(string Email, DateTime OptedOutUtc);

public sealed record SetEnabledRequest(bool Enabled);

public sealed record SendNowResponse(long DispatchId);

public sealed record SaveAlertRequest(
    string Name,
    int? DashboardId,
    JsonElement Spec,
    AlertOperator Operator,
    decimal Threshold,
    string Recipients,
    int EveryMinutes,
    int CooldownMinutes,
    bool Enabled = true);

public sealed record AlertResponse(
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

public sealed record AlertTestResponse(decimal? Value, bool WouldFire);

public sealed record AlertFiringResponse(
    int AlertId,
    string Name,
    int? DashboardId,
    DateTime FiredAtUtc,
    decimal? Value,
    AlertOperator Operator,
    decimal Threshold);

public static class SchedulingDtoMapping
{
    /// <summary>"HH:mm" (schedule-zone wall time) -> minutes past local midnight; null/blank -> null; invalid -> -1 (rejected downstream).</summary>
    public static int? ParseTimeOfDay(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        return TimeSpan.TryParseExact(text.Trim(), @"hh\:mm", CultureInfo.InvariantCulture, out var time)
            ? (int)time.TotalMinutes
            : -1;
    }

    private static string? FormatTimeOfDay(int? minutes) =>
        minutes is { } m and >= 0 and <= 1439
            ? TimeSpan.FromMinutes(m).ToString(@"hh\:mm", CultureInfo.InvariantCulture)
            : null;

    public static SubscriptionSaveRequest ToSaveRequest(SaveSubscriptionRequest request) =>
        new(request.DashboardId, request.Name ?? "", request.ScheduleKind, request.IntervalMinutes,
            ParseTimeOfDay(request.TimeOfDayLocal), request.DayOfWeek, request.Recipients ?? "",
            request.Format, request.Enabled, ToContentConfig(request.Content));

    /// <summary>Wire content → normalized config; missing sub-fields take the documented defaults.</summary>
    public static SubscriptionContentConfig? ToContentConfig(SubscriptionContentRequest? content) =>
        content is null
            ? null
            : new SubscriptionContentConfig(
                content.Body,
                content.ExcludedTileIds ?? [],
                content.ImageWidth ?? SubscriptionContentConfig.DefaultImageWidth,
                content.MaxTableRows ?? SubscriptionContentConfig.DefaultMaxTableRows);

    public static SubscriptionResponse ToResponse(SubscriptionDetail detail) =>
        new(detail.Id, detail.DashboardId, detail.Name, detail.ScheduleKind, detail.IntervalMinutes,
            FormatTimeOfDay(detail.TimeOfDayMinutesUtc), detail.DayOfWeekUtc, detail.Recipients,
            detail.Format, detail.Enabled, detail.Content, detail.OwnerIsMe, detail.LastRunUtc,
            detail.CreatedUtc, detail.OwnerUserId, detail.OwnerDisplayName, ToResponse(detail.LastDispatch));

    public static DispatchSummaryResponse? ToResponse(DispatchSummary? summary) =>
        summary is null
            ? null
            : new DispatchSummaryResponse(
                summary.DispatchId, summary.Status, summary.Trigger, summary.StartedUtc, summary.FinishedUtc,
                summary.Error, summary.SentCount, summary.FailedCount, summary.OptedOutCount,
                summary.PendingCount);

    public static DispatchResponse ToResponse(DispatchDetail detail) =>
        new(detail.Id, detail.SubscriptionId, detail.SubscriptionName, detail.DashboardId, detail.Trigger,
            detail.RequestedBy, detail.StartedUtc, detail.FinishedUtc, detail.Status, detail.Error,
            detail.Recipients
                .Select(r => new DispatchRecipientResponse(
                    r.Id, r.Email, r.Status, r.Attempts, r.Error, r.SentUtc, r.OpenedUtc, r.OpenCount))
                .ToArray());

    public static OptOutResponse ToResponse(OptOutDetail detail) =>
        new(detail.Email, detail.OptedOutUtc);

    public static AlertSaveRequest ToSaveRequest(SaveAlertRequest request) =>
        new(request.Name ?? "", request.DashboardId,
            request.Spec.ValueKind is JsonValueKind.Undefined ? "" : request.Spec.GetRawText(),
            request.Operator,
            request.Threshold, request.Recipients ?? "", request.EveryMinutes, request.CooldownMinutes,
            request.Enabled);

    public static AlertResponse ToResponse(AlertDetail detail) =>
        new(detail.Id, detail.Name, detail.DashboardId, detail.Spec, detail.Operator, detail.Threshold,
            detail.Recipients, detail.EveryMinutes, detail.CooldownMinutes, detail.Enabled,
            detail.OwnerIsMe, detail.LastEvaluatedUtc, detail.LastFiredUtc, detail.LastValue,
            detail.CreatedUtc, detail.OwnerUserId, detail.OwnerDisplayName);

    public static AlertFiringResponse ToResponse(AlertFiring firing) =>
        new(firing.AlertId, firing.Name, firing.DashboardId, firing.FiredAtUtc, firing.Value,
            firing.Operator, firing.Threshold);
}
