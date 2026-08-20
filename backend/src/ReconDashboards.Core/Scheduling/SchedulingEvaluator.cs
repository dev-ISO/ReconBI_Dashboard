using System.Globalization;
using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// One evaluation pass over due subscriptions and alerts. The hosted service
/// (AddReconDashboardsScheduling) calls <see cref="RunOnceAsync"/> once per
/// minute; each record is processed in its own DI scope under the OWNER's
/// impersonated identity so row filters apply exactly as if the owner ran the
/// queries interactively. Per-record failures are logged and never propagate.
/// Daily/weekly due math and email timestamps use the host-configured
/// schedule zone (<see cref="ReconDashboardsOptions.ScheduleTimeZoneId"/>),
/// resolved once here — an unknown id logs an error and falls back to UTC
/// rather than silently killing the scheduler.
/// </summary>
public sealed class SchedulingEvaluator(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ReconDashboardsOptions options,
    SubscriptionDispatcher dispatcher,
    ILogger<SchedulingEvaluator> logger)
{
    private static readonly JsonSerializerOptions SpecJsonOptions = new(JsonSerializerDefaults.Web);

    private readonly TimeZoneInfo _scheduleZone = ResolveScheduleZone(options.ScheduleTimeZoneId, logger);
    private readonly string _scheduleZoneLabel = options.ScheduleTimeZoneLabel;

    private static TimeZoneInfo ResolveScheduleZone(string zoneId, ILogger logger)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(zoneId);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            logger.LogError(
                ex,
                "ScheduleTimeZoneId '{ZoneId}' is not a known time zone; subscription schedules fall back to UTC",
                zoneId);
            return TimeZoneInfo.Utc;
        }
    }

    public async Task RunOnceAsync(CancellationToken ct)
    {
        var nowUtc = timeProvider.GetUtcNow().UtcDateTime;

        foreach (var id in await CollectDueSubscriptionIdsAsync(nowUtc, ct))
        {
            try
            {
                // The full per-recipient pipeline (dispatch rows, opt-outs,
                // retries, notifier seams) lives in SubscriptionDispatcher —
                // identical for scheduled and send-now triggers by design.
                await dispatcher.ExecuteScheduledAsync(id, nowUtc, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Subscription {SubscriptionId} evaluation failed", id);
            }
        }

        foreach (var id in await CollectDueAlertIdsAsync(nowUtc, ct))
        {
            try
            {
                await ProcessAlertAsync(id, nowUtc, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Alert {AlertId} evaluation failed", id);
            }
        }
    }

    // ------------------------------------------------------------ subscriptions

    private async Task<IReadOnlyList<int>> CollectDueSubscriptionIdsAsync(DateTime nowUtc, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        var candidates = await db.Subscriptions.AsNoTracking()
            .Where(s => s.Enabled)
            .ToListAsync(ct);
        return candidates.Where(s => ScheduleDue.IsDue(s, nowUtc, _scheduleZone)).Select(s => s.Id).ToArray();
    }

    // ------------------------------------------------------------------- alerts

    private async Task<IReadOnlyList<int>> CollectDueAlertIdsAsync(DateTime nowUtc, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        var candidates = await db.Alerts.AsNoTracking()
            .Where(a => a.Enabled)
            .ToListAsync(ct);
        return candidates.Where(a => ScheduleDue.IsAlertDue(a, nowUtc)).Select(a => a.Id).ToArray();
    }

    private async Task ProcessAlertAsync(int alertId, DateTime nowUtc, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<ReconDashboardsDbContext>();

        var alert = await db.Alerts.FirstOrDefaultAsync(a => a.Id == alertId, ct);
        if (alert is null || !ScheduleDue.IsAlertDue(alert, nowUtc))
        {
            return;
        }

        var (value, error) = await EvaluateAlertValueAsync(services, alert, ct);

        alert.LastEvaluatedUtc = nowUtc;
        alert.LastValue = value;

        if (error is not null)
        {
            logger.LogWarning("Alert {AlertId} ({Name}) evaluation failed: {Error}", alert.Id, alert.Name, error);
        }
        else if (value is { } evaluated
            && ScheduleDue.ConditionMet(alert.Operator, evaluated, alert.Threshold)
            && ScheduleDue.CooldownElapsed(alert, nowUtc))
        {
            var recipients = SplitRecipients(alert.Recipients);
            if (recipients.Count > 0)
            {
                try
                {
                    var sender = services.GetRequiredService<IRcdEmailSender>();
                    await sender.SendAsync(
                        BuildAlertEmail(alert, evaluated, nowUtc, recipients, _scheduleZone, _scheduleZoneLabel), ct);
                    alert.LastFiredUtc = nowUtc;
                    logger.LogInformation("Alert {AlertId} ({Name}) fired: value {Value}", alert.Id, alert.Name, evaluated);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    // The firing is not recorded, so it retries next evaluation.
                    logger.LogError(ex, "Alert {AlertId} email delivery failed", alert.Id);
                }
            }
            else
            {
                // Condition holds but nobody to tell; still record the firing
                // so recent-firings surfaces it in-app.
                alert.LastFiredUtc = nowUtc;
            }
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Evaluates an alert's single-value spec under the alert owner's identity.
    /// Shared by the scheduler and the API's test endpoint (which passes its
    /// own request-scoped services). Never mutates state.
    /// </summary>
    public static async Task<(decimal? Value, string? Error)> EvaluateAlertValueAsync(
        IServiceProvider scopeServices, AlertRecord alert, CancellationToken ct)
    {
        ChartQuerySpec? spec;
        try
        {
            spec = JsonSerializer.Deserialize<ChartQuerySpec>(alert.SpecJson, SpecJsonOptions);
        }
        catch (JsonException)
        {
            return (null, "The alert's stored query is not valid JSON.");
        }

        if (spec is null || spec.Dimensions is not { Count: 0 } || spec.Measures is not { Count: 1 })
        {
            return (null, "The alert's stored query must have no dimensions and exactly one measure.");
        }

        spec = await WithDashboardDefinitionsAsync(scopeServices, alert, spec, ct);

        var queryService = ImpersonatedQuery.Create(scopeServices, alert.OwnerUserId);
        var principal = ImpersonatedQuery.PrincipalFor(alert.OwnerUserId);

        var outcome = await queryService.RunAsync(spec, principal, ct);
        if (!outcome.Succeeded)
        {
            return (null, outcome.Error!.Message);
        }

        var rows = outcome.Value!.Rows;
        if (rows.Count == 0 || rows[0].Length == 0 || rows[0][0] is null)
        {
            return (null, null); // no data: nothing to compare, alert does not fire
        }

        try
        {
            return (Convert.ToDecimal(rows[0][0], CultureInfo.InvariantCulture), null);
        }
        catch (Exception ex) when (ex is FormatException or InvalidCastException or OverflowException)
        {
            return (null, "The alert query did not produce a numeric value.");
        }
    }

    /// <summary>
    /// Resolves the DASHBOARD-scoped measure definitions an alert's stored spec
    /// needs. AlertRecord DOES carry a dashboard id, so the live path applies
    /// (the same one scheduled email takes): the dashboard's document is read
    /// at evaluation time and the definitions the spec's measure references
    /// need — transitively — are overlaid. An edited formula is therefore
    /// picked up by the next evaluation instead of firing on a stale copy.
    ///
    /// The definitions the spec ALREADY carries (snapshotted client-side at
    /// save time by toWireSpec) are kept as a FALLBACK for anything the doc no
    /// longer holds — an alert built on an unsaved chart, or one citing a
    /// personal measure, which has no dashboard home to resolve from. Live
    /// definitions win by id, and a stored one whose NAME the live set already
    /// uses is dropped rather than merged: MeasureOverlay rejects a duplicate
    /// name outright, and failing the whole alert to preserve a shadowed copy
    /// would be the worse trade.
    /// </summary>
    private static async Task<ChartQuerySpec> WithDashboardDefinitionsAsync(
        IServiceProvider scopeServices, AlertRecord alert, ChartQuerySpec spec, CancellationToken ct)
    {
        if (alert.DashboardId is not { } dashboardId)
        {
            return spec;
        }

        var db = scopeServices.GetRequiredService<ReconDashboardsDbContext>();
        var layoutJson = await db.Dashboards
            .AsNoTracking()
            .Where(d => d.Id == dashboardId && !d.IsDeleted)
            .Select(d => d.LayoutJson)
            .FirstOrDefaultAsync(ct);
        if (layoutJson is null)
        {
            return spec;
        }

        var docMeasures = LayoutSnapshotParser.ParseMeasures(layoutJson);
        if (docMeasures.Count == 0)
        {
            return spec;
        }

        var live = MeasureOverlay.CollectReferenced(
            docMeasures, spec.Measures.Where(m => m.MeasureId is not null).Select(m => m.MeasureId!.Value));
        if (live.Count == 0)
        {
            return spec;
        }

        var ids = new HashSet<Guid>(live.Select(m => m.Id));
        var names = new HashSet<string>(live.Select(m => m.Name), StringComparer.OrdinalIgnoreCase);
        var merged = new List<Measure>(live);
        foreach (var stored in spec.Definitions ?? [])
        {
            if (ids.Add(stored.Id) && names.Add(stored.Name))
            {
                merged.Add(stored);
            }
        }

        return spec with { Definitions = merged };
    }

    private static RcdEmailMessage BuildAlertEmail(
        AlertRecord alert, decimal value, DateTime nowUtc, IReadOnlyList<string> recipients,
        TimeZoneInfo stampZone, string stampZoneLabel)
    {
        var symbol = ScheduleDue.OperatorSymbol(alert.Operator);
        var valueText = SnapshotRenderer.FormatValue(value);
        var thresholdText = SnapshotRenderer.FormatValue(alert.Threshold);
        var subject = $"Alert {alert.Name}: value {valueText} crossed {symbol} {thresholdText}";

        // Same plant-local stamp as snapshot emails (SnapshotRenderer) —
        // recipients should never have to translate a UTC timestamp.
        var stampLocal = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, stampZone);
        var body =
            "<div style=\"font-family:Segoe UI,Arial,sans-serif;color:#1f2937;max-width:560px;margin:0 auto;\">" +
            $"<div style=\"padding:16px 0;border-bottom:2px solid #e5e7eb;font-size:18px;font-weight:600;\">{WebUtility.HtmlEncode(alert.Name)}</div>" +
            "<div style=\"margin:16px 0;\">" +
            $"<div style=\"font-size:30px;font-weight:700;color:#b91c1c;\">{WebUtility.HtmlEncode(valueText)}</div>" +
            $"<div style=\"font-size:13px;color:#374151;margin-top:4px;\">crossed the threshold {WebUtility.HtmlEncode(symbol)} {WebUtility.HtmlEncode(thresholdText)}</div>" +
            $"<div style=\"font-size:11px;color:#6b7280;margin-top:8px;\">Evaluated {stampLocal.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)} {WebUtility.HtmlEncode(stampZoneLabel)}</div>" +
            "</div>" +
            "<div style=\"font-size:11px;color:#9ca3af;padding:12px 0;border-top:1px solid #e5e7eb;\">Sent by ReconDashboards data alerts.</div>" +
            "</div>";

        return new RcdEmailMessage(recipients, subject, body, []);
    }

    // ------------------------------------------------------------------ helpers

    internal static IReadOnlyList<string> SplitRecipients(string recipients) =>
        recipients
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToArray();
}
