using System.Globalization;
using System.Text.Json;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Http;

// Wire DTOs for subscriptions and alerts. Enum values use the camelCase
// converters attached to the enum types ("interval"/"daily"/"weekly",
// "html"/"csv", "gt".."eq"), so the wire format is stable regardless of the
// host's MVC JSON configuration. Times of day travel as "HH:mm" UTC strings.

public sealed record SaveSubscriptionRequest(
    int DashboardId,
    string Name,
    SubscriptionScheduleKind ScheduleKind,
    int? IntervalMinutes,
    string? TimeOfDayUtc,
    int? DayOfWeekUtc,
    string Recipients,
    SubscriptionFormat Format,
    bool Enabled = true);

public sealed record SubscriptionResponse(
    int Id,
    int DashboardId,
    string Name,
    SubscriptionScheduleKind ScheduleKind,
    int? IntervalMinutes,
    string? TimeOfDayUtc,
    int? DayOfWeekUtc,
    string Recipients,
    SubscriptionFormat Format,
    bool Enabled,
    bool OwnerIsMe,
    DateTime? LastRunUtc,
    DateTime CreatedUtc);

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
    DateTime CreatedUtc);

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
    /// <summary>"HH:mm" (UTC) -> minutes past midnight; null/blank -> null; invalid -> -1 (rejected downstream).</summary>
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
            ParseTimeOfDay(request.TimeOfDayUtc), request.DayOfWeekUtc, request.Recipients ?? "",
            request.Format, request.Enabled);

    public static SubscriptionResponse ToResponse(SubscriptionDetail detail) =>
        new(detail.Id, detail.DashboardId, detail.Name, detail.ScheduleKind, detail.IntervalMinutes,
            FormatTimeOfDay(detail.TimeOfDayMinutesUtc), detail.DayOfWeekUtc, detail.Recipients,
            detail.Format, detail.Enabled, detail.OwnerIsMe, detail.LastRunUtc, detail.CreatedUtc);

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
            detail.CreatedUtc);

    public static AlertFiringResponse ToResponse(AlertFiring firing) =>
        new(firing.AlertId, firing.Name, firing.DashboardId, firing.FiredAtUtc, firing.Value,
            firing.Operator, firing.Threshold);
}
