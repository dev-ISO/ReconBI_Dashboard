using System.Globalization;
using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// One evaluation pass over due subscriptions and alerts. The hosted service
/// (AddReconDashboardsScheduling) calls <see cref="RunOnceAsync"/> once per
/// minute; each record is processed in its own DI scope under the OWNER's
/// impersonated identity so row filters apply exactly as if the owner ran the
/// queries interactively. Per-record failures are logged and never propagate.
/// </summary>
public sealed class SchedulingEvaluator(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ILogger<SchedulingEvaluator> logger)
{
    private static readonly JsonSerializerOptions SpecJsonOptions = new(JsonSerializerDefaults.Web);

    public async Task RunOnceAsync(CancellationToken ct)
    {
        var nowUtc = timeProvider.GetUtcNow().UtcDateTime;

        foreach (var id in await CollectDueSubscriptionIdsAsync(nowUtc, ct))
        {
            try
            {
                await ProcessSubscriptionAsync(id, nowUtc, ct);
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
        return candidates.Where(s => ScheduleDue.IsDue(s, nowUtc)).Select(s => s.Id).ToArray();
    }

    private async Task ProcessSubscriptionAsync(int subscriptionId, DateTime nowUtc, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<ReconDashboardsDbContext>();

        var subscription = await db.Subscriptions.FirstOrDefaultAsync(s => s.Id == subscriptionId, ct);
        if (subscription is null || !ScheduleDue.IsDue(subscription, nowUtc))
        {
            return; // deleted or already handled by a concurrent instance
        }

        // The snapshot is only worth sending when the dashboard is still
        // readable by the subscription's owner (owner or shared, not deleted).
        var dashboard = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == subscription.DashboardId && !d.IsDeleted, ct);
        if (dashboard is null
            || (dashboard.OwnerUserId != subscription.OwnerUserId && !dashboard.IsShared))
        {
            logger.LogWarning(
                "Subscription {SubscriptionId}: dashboard {DashboardId} is gone or no longer visible to owner {Owner}; skipping",
                subscription.Id, subscription.DashboardId, subscription.OwnerUserId);
            subscription.LastRunUtc = nowUtc;
            await db.SaveChangesAsync(ct);
            return;
        }

        try
        {
            if (dashboard.ModelId is not { } modelId)
            {
                logger.LogWarning(
                    "Subscription {SubscriptionId}: dashboard {DashboardId} has no model; skipping",
                    subscription.Id, dashboard.Id);
                subscription.LastRunUtc = nowUtc;
                await db.SaveChangesAsync(ct);
                return;
            }

            var pages = LayoutSnapshotParser.Parse(dashboard.LayoutJson, modelId);
            var queryService = ImpersonatedQuery.Create(services, subscription.OwnerUserId);
            var principal = ImpersonatedQuery.PrincipalFor(subscription.OwnerUserId);

            var rendered = new List<RenderedPage>();
            foreach (var page in pages)
            {
                var tiles = new List<RenderedTile>();
                foreach (var tile in page.Tiles)
                {
                    var outcome = await queryService.RunAsync(tile.Spec, principal, ct);
                    tiles.Add(outcome.Succeeded
                        ? new RenderedTile(
                            tile, outcome.Value!.Compiled.Columns, outcome.Value.Rows, Error: null)
                        : new RenderedTile(tile, [], [], outcome.Error!.Message));
                }

                rendered.Add(new RenderedPage(page.Name, tiles));
            }

            var recipients = SplitRecipients(subscription.Recipients);
            if (recipients.Count == 0)
            {
                logger.LogWarning("Subscription {SubscriptionId} has no recipients; skipping send", subscription.Id);
                subscription.LastRunUtc = nowUtc;
                await db.SaveChangesAsync(ct);
                return;
            }

            var subject = $"{dashboard.Name} — dashboard snapshot";
            var body = SnapshotRenderer.RenderHtml(dashboard.Name, nowUtc, rendered);
            IReadOnlyList<RcdEmailAttachment> attachments = subscription.Format == SubscriptionFormat.Csv
                ?
                [
                    new RcdEmailAttachment(
                        $"{SafeFileName(dashboard.Name)}-snapshot-{nowUtc:yyyyMMdd-HHmm}.csv",
                        "text/csv",
                        SnapshotRenderer.RenderCsv(dashboard.Name, nowUtc, rendered)),
                ]
                : [];

            var sender = services.GetRequiredService<IRcdEmailSender>();
            await sender.SendAsync(new RcdEmailMessage(recipients, subject, body, attachments), ct);

            logger.LogInformation(
                "Subscription {SubscriptionId} ({Name}) sent to {RecipientCount} recipient(s)",
                subscription.Id, subscription.Name, recipients.Count);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Failures are recorded as a completed run (LastRunUtc advances in
            // the finally-style update below) so a broken SMTP or model never
            // hammers every minute; the next scheduled occurrence retries.
            logger.LogError(ex, "Subscription {SubscriptionId} snapshot failed", subscription.Id);
        }

        subscription.LastRunUtc = nowUtc;
        await db.SaveChangesAsync(ct);
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
                    await sender.SendAsync(BuildAlertEmail(alert, evaluated, nowUtc, recipients), ct);
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

    private static RcdEmailMessage BuildAlertEmail(
        AlertRecord alert, decimal value, DateTime nowUtc, IReadOnlyList<string> recipients)
    {
        var symbol = ScheduleDue.OperatorSymbol(alert.Operator);
        var valueText = SnapshotRenderer.FormatValue(value);
        var thresholdText = SnapshotRenderer.FormatValue(alert.Threshold);
        var subject = $"Alert {alert.Name}: value {valueText} crossed {symbol} {thresholdText}";

        var body =
            "<div style=\"font-family:Segoe UI,Arial,sans-serif;color:#1f2937;max-width:560px;margin:0 auto;\">" +
            $"<div style=\"padding:16px 0;border-bottom:2px solid #e5e7eb;font-size:18px;font-weight:600;\">{WebUtility.HtmlEncode(alert.Name)}</div>" +
            "<div style=\"margin:16px 0;\">" +
            $"<div style=\"font-size:30px;font-weight:700;color:#b91c1c;\">{WebUtility.HtmlEncode(valueText)}</div>" +
            $"<div style=\"font-size:13px;color:#374151;margin-top:4px;\">crossed the threshold {WebUtility.HtmlEncode(symbol)} {WebUtility.HtmlEncode(thresholdText)}</div>" +
            $"<div style=\"font-size:11px;color:#6b7280;margin-top:8px;\">Evaluated {nowUtc.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)} UTC</div>" +
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

    private static string SafeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var safe = new string(name.Select(c => invalid.Contains(c) || c == ' ' ? '-' : c).ToArray());
        return string.IsNullOrEmpty(safe) ? "dashboard" : safe;
    }
}
