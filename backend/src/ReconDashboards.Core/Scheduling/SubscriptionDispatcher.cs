using System.Collections.Concurrent;
using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// The per-recipient delivery pipeline behind BOTH triggers: the minute
/// scheduler (<see cref="SchedulingEvaluator"/>) and the send-now endpoint.
/// Every occurrence writes an rcd_subscription_dispatches row plus one
/// rcd_subscription_dispatch_recipients row per address — the audit truth the
/// manager UI reads — and reports progress through the host notifier seams.
///
/// Registered as a SINGLETON (it owns process-lifetime state): the in-memory
/// retry queue, the one-manual-send-per-subscription guard, and the set of
/// dispatch ids this process is actively working. Retries are deliberately
/// in-process only — a restart abandons them, and the next maintenance pass
/// closes the orphaned "running" dispatch as failed, honestly recorded,
/// rather than pretending a durable queue exists.
///
/// Retry cadence mirrors the tracker's ScheduledReportDispatcher, capped for
/// the 1-minute scheduler world: attempts at +0s, +2min, +8min from the first
/// attempt. The queue drains from a lazy background loop (spawned on first
/// enqueue, exits when empty) so manual sends retry even on hosts that never
/// registered AddReconDashboardsScheduling.
/// </summary>
public sealed class SubscriptionDispatcher(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ReconDashboardsOptions options,
    ILogger<SubscriptionDispatcher> logger)
{
    public const int MaxAttemptsPerRecipient = 3;

    /// <summary>Attempt schedule measured from the FIRST attempt: 0s, +2min, +8min.</summary>
    public static readonly TimeSpan SecondAttemptDelay = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan ThirdAttemptDelay = TimeSpan.FromMinutes(8);

    /// <summary>
    /// A "running" dispatch this old that nobody in this process is working on
    /// can only be a leftover from a crash/restart — safely past the retry
    /// window (8min) plus generous send time.
    /// </summary>
    public static readonly TimeSpan AbandonedAfter = TimeSpan.FromMinutes(15);

    /// <summary>Dispatch history retention; pruned by a daily sweep (spec §2).</summary>
    public static readonly TimeSpan RetentionPeriod = TimeSpan.FromDays(90);

    private readonly TimeZoneInfo _scheduleZone =
        ResolveZoneOrUtc(options.ScheduleTimeZoneId, logger);

    // ---- process-lifetime state --------------------------------------------
    private readonly object _gate = new();
    private readonly List<RetryItem> _retryQueue = [];
    private bool _drainLoopRunning;
    private readonly ConcurrentDictionary<long, byte> _openDispatches = new();
    private readonly ConcurrentDictionary<int, byte> _manualSendsInFlight = new();

    /// <summary>
    /// Dispatches whose FIRST attempt pass is still executing. The retry
    /// drain must not close such a dispatch: recipients later in the pass are
    /// Pending without a queue item yet, and a close would mislabel them.
    /// </summary>
    private readonly ConcurrentDictionary<long, byte> _firstPassInFlight = new();
    private DateTime _lastPruneUtc; // default(DateTime) => prune on first maintenance pass

    /// <summary>
    /// Everything a retry needs WITHOUT re-rendering: the fully personalized
    /// message is cached in memory for the (at most ~8 minute) retry window,
    /// so a retried email is byte-identical to the failed attempt.
    /// </summary>
    private sealed record RetryItem(
        long DispatchId,
        int SubscriptionId,
        string OwnerUserId,
        DispatchTrigger Trigger,
        long RecipientRowId,
        string Email,
        RcdEmailMessage Message,
        int AttemptsSoFar,
        DateTime FirstAttemptUtc,
        DateTime DueUtc);

    private static TimeZoneInfo ResolveZoneOrUtc(string zoneId, ILogger logger)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(zoneId);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            // Same fallback the evaluator applies — never kill delivery over a
            // bad zone id; email stamps just read UTC.
            logger.LogError(ex, "ScheduleTimeZoneId '{ZoneId}' is unknown; dispatch stamps fall back to UTC", zoneId);
            return TimeZoneInfo.Utc;
        }
    }

    // ======================================================== scheduled trigger

    /// <summary>
    /// Runs one due scheduled occurrence. LastRunUtc advances as soon as the
    /// dispatch row exists — exactly the pre-dispatch behavior — so a broken
    /// SMTP or model never hammers every minute; the dispatch row records the
    /// failure instead of silence.
    /// </summary>
    public async Task ExecuteScheduledAsync(int subscriptionId, DateTime nowUtc, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<ReconDashboardsDbContext>();

        var subscription = await db.Subscriptions.FirstOrDefaultAsync(s => s.Id == subscriptionId, ct);
        if (subscription is null || !ScheduleDue.IsDue(subscription, nowUtc, _scheduleZone))
        {
            return; // deleted or already handled by a concurrent instance
        }

        subscription.LastRunUtc = nowUtc;
        var dispatch = CreateDispatchRow(db, subscription, DispatchTrigger.Schedule, requestedBy: null, nowUtc);
        await db.SaveChangesAsync(ct);
        _openDispatches.TryAdd(dispatch.Id, 0);

        await RunDispatchBodyAsync(services, db, dispatch, subscription, ct);
    }

    // =========================================================== manual trigger

    /// <summary>
    /// Starts a send-now dispatch: the row is created synchronously (so the
    /// caller gets the dispatch id to watch), the actual rendering/sending
    /// continues on a background task detached from the HTTP request. One
    /// manual send per subscription at a time — the guard holds until the
    /// dispatch CLOSES (including its retry tail), because that is what
    /// "already sending" means to the person clicking the button.
    /// Caller (SubscriptionService) has already authorized owner-or-admin.
    /// </summary>
    public async Task<ServiceResult<long>> StartManualAsync(int subscriptionId, string requestedBy, CancellationToken ct)
    {
        if (!_manualSendsInFlight.TryAdd(subscriptionId, 0))
        {
            return ServiceResult<long>.Fail(
                ServiceErrorKind.TooManyRequests, "rcd.subscription.send_in_progress",
                "A manual send for this subscription is already running. Watch its progress or wait for it to finish.");
        }

        try
        {
            long dispatchId;
            using (var scope = scopeFactory.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
                var subscription = await db.Subscriptions.AsNoTracking()
                    .FirstOrDefaultAsync(s => s.Id == subscriptionId, ct);
                if (subscription is null)
                {
                    _manualSendsInFlight.TryRemove(subscriptionId, out _);
                    return ServiceResult<long>.Fail(
                        ServiceErrorKind.NotFound, "rcd.subscription.not_found",
                        $"Subscription {subscriptionId} does not exist or is not visible to you.");
                }

                var dispatch = CreateDispatchRow(
                    db, subscription, DispatchTrigger.Manual, requestedBy, timeProvider.GetUtcNow().UtcDateTime);
                await db.SaveChangesAsync(ct);
                dispatchId = dispatch.Id;
                _openDispatches.TryAdd(dispatchId, 0);
            }

            // Detached from the request: CancellationToken.None on purpose —
            // closing the browser must not strand a half-sent dispatch.
            _ = Task.Run(() => RunManualBodyAsync(dispatchId, subscriptionId));
            return ServiceResult<long>.Ok(dispatchId);
        }
        catch
        {
            // Never leak the guard on an unexpected failure (db down, etc.).
            _manualSendsInFlight.TryRemove(subscriptionId, out _);
            throw;
        }
    }

    private async Task RunManualBodyAsync(long dispatchId, int subscriptionId)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var services = scope.ServiceProvider;
            var db = services.GetRequiredService<ReconDashboardsDbContext>();
            var dispatch = await db.SubscriptionDispatches.FirstAsync(d => d.Id == dispatchId, CancellationToken.None);
            var subscription = await db.Subscriptions.AsNoTracking()
                .FirstOrDefaultAsync(s => s.Id == subscriptionId, CancellationToken.None);
            if (subscription is null)
            {
                await CloseSkippedAsync(services, db, dispatch, "The subscription was deleted before the send started.", CancellationToken.None);
                return;
            }

            await RunDispatchBodyAsync(services, db, dispatch, subscription, CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Manual dispatch {DispatchId} crashed", dispatchId);
            // Let the abandoned-dispatch sweep close the row honestly; release
            // in-memory claims so the guard cannot leak forever.
            _openDispatches.TryRemove(dispatchId, out _);
            _manualSendsInFlight.TryRemove(subscriptionId, out _);
        }
    }

    // ======================================================= the dispatch body

    private static SubscriptionDispatchRecord CreateDispatchRow(
        ReconDashboardsDbContext db, SubscriptionRecord subscription,
        DispatchTrigger trigger, string? requestedBy, DateTime nowUtc)
    {
        var dispatch = new SubscriptionDispatchRecord
        {
            SubscriptionId = subscription.Id,
            SubscriptionName = Truncate(subscription.Name, 200),
            OwnerUserId = subscription.OwnerUserId,
            DashboardId = subscription.DashboardId,
            Trigger = trigger,
            RequestedBy = requestedBy is null ? null : Truncate(requestedBy, 64),
            StartedUtc = nowUtc,
            Status = DispatchStatus.Running,
        };
        db.SubscriptionDispatches.Add(dispatch);
        return dispatch;
    }

    private async Task RunDispatchBodyAsync(
        IServiceProvider services, ReconDashboardsDbContext db,
        SubscriptionDispatchRecord dispatch, SubscriptionRecord subscription, CancellationToken ct)
    {
        _firstPassInFlight.TryAdd(dispatch.Id, 0);
        try
        {
            await RunFirstPassAsync(services, db, dispatch, subscription, ct);
        }
        finally
        {
            _firstPassInFlight.TryRemove(dispatch.Id, out _);
        }

        // Close AFTER the in-flight flag drops so the retry drain and this
        // path can never both decide (the drain skips flagged dispatches, and
        // CloseDispatchAsync itself is idempotent on non-running rows).
        bool retriesQueued;
        lock (_gate)
        {
            retriesQueued = _retryQueue.Any(i => i.DispatchId == dispatch.Id);
        }

        if (retriesQueued)
        {
            EnsureDrainLoopRunning(); // dispatch stays 'running'; retries close it
        }
        else if (dispatch.Status == DispatchStatus.Running)
        {
            await CloseDispatchAsync(services, db, dispatch, ct);
        }
    }

    private async Task RunFirstPassAsync(
        IServiceProvider services, ReconDashboardsDbContext db,
        SubscriptionDispatchRecord dispatch, SubscriptionRecord subscription, CancellationToken ct)
    {
        // ---- occurrence-level preconditions → 'skipped' with the reason ----
        var dashboard = await db.Dashboards.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == subscription.DashboardId && !d.IsDeleted, ct);
        if (dashboard is null
            || (dashboard.OwnerUserId != subscription.OwnerUserId && !dashboard.IsShared))
        {
            await CloseSkippedAsync(services, db, dispatch,
                "The dashboard was deleted or is no longer visible to the subscription owner.", ct);
            return;
        }

        if (dashboard.ModelId is not { } modelId)
        {
            await CloseSkippedAsync(services, db, dispatch, "The dashboard has no data model.", ct);
            return;
        }

        var recipients = SchedulingEvaluator.SplitRecipients(subscription.Recipients)
            .DistinctBy(r => r.ToLowerInvariant())
            .ToArray();
        if (recipients.Length == 0)
        {
            await CloseSkippedAsync(services, db, dispatch, "The subscription has no recipients.", ct);
            return;
        }

        // ---- opt-outs: global first (spec), then per-subscription ----------
        var lowered = recipients.Select(r => r.ToLowerInvariant()).ToArray();
        var globallyOptedOut = (await db.GlobalOptOuts
                .Where(o => lowered.Contains(o.Email))
                .Select(o => o.Email)
                .ToListAsync(ct))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var subOptedOut = (await db.SubscriptionOptOuts
                .Where(o => o.SubscriptionId == subscription.Id && lowered.Contains(o.Email))
                .Select(o => o.Email)
                .ToListAsync(ct))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var nowUtc = timeProvider.GetUtcNow().UtcDateTime;
        var rows = new List<SubscriptionDispatchRecipientRecord>(recipients.Length);
        foreach (var email in recipients)
        {
            var optedOut = globallyOptedOut.Contains(email) || subOptedOut.Contains(email);
            var row = new SubscriptionDispatchRecipientRecord
            {
                DispatchId = dispatch.Id,
                Email = Truncate(email, 320),
                Status = optedOut ? DispatchRecipientStatus.OptedOut : DispatchRecipientStatus.Pending,
                Attempts = 0,
            };
            rows.Add(row);
            db.SubscriptionDispatchRecipients.Add(row);
        }

        await db.SaveChangesAsync(ct); // recipient row ids exist — pixel tokens can sign them

        var progress = services.GetRequiredService<IRcdDispatchProgressNotifier>();
        await NotifyAsync(
            () => progress.DispatchStartedAsync(
                new RcdDispatchStarted(
                    dispatch.OwnerUserId, dispatch.Id, dispatch.SubscriptionId, dispatch.SubscriptionName,
                    Wire(dispatch.Trigger), rows.Count, dispatch.StartedUtc), ct));
        foreach (var row in rows.Where(r => r.Status == DispatchRecipientStatus.OptedOut))
        {
            await NotifyRecipientAsync(progress, dispatch, row, ct);
        }

        var pending = rows.Where(r => r.Status == DispatchRecipientStatus.Pending).ToArray();
        if (pending.Length == 0)
        {
            await CloseDispatchAsync(services, db, dispatch, ct); // rolls up to 'skipped' (all opted out)
            return;
        }

        // ---- render ONCE under the owner's identity ------------------------
        string subject;
        string baseBody;
        IReadOnlyList<RcdEmailAttachment> attachments;
        try
        {
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
                        ? new RenderedTile(tile, outcome.Value!.Compiled.Columns, outcome.Value.Rows, Error: null)
                        : new RenderedTile(tile, [], [], outcome.Error!.Message));
                }

                rendered.Add(new RenderedPage(page.Name, tiles));
            }

            subject = $"{dashboard.Name} — dashboard snapshot";
            baseBody = SnapshotRenderer.RenderHtml(
                dashboard.Name, nowUtc, rendered, _scheduleZone, options.ScheduleTimeZoneLabel);
            var stampLocal = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, _scheduleZone);
            attachments = subscription.Format == SubscriptionFormat.Csv
                ?
                [
                    new RcdEmailAttachment(
                        $"{SafeFileName(dashboard.Name)}-snapshot-{stampLocal:yyyyMMdd-HHmm}.csv",
                        "text/csv",
                        SnapshotRenderer.RenderCsv(
                            dashboard.Name, nowUtc, rendered, _scheduleZone, options.ScheduleTimeZoneLabel)),
                ]
                : [];
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw; // shutdown: the abandoned sweep will close this honestly
        }
        catch (Exception ex)
        {
            // Occurrence-level failure: nothing was attempted, say so per row.
            logger.LogError(ex, "Dispatch {DispatchId}: snapshot render failed", dispatch.Id);
            foreach (var row in pending)
            {
                row.Status = DispatchRecipientStatus.Failed;
                row.Error = "Not attempted — the dashboard snapshot failed to render.";
            }

            dispatch.Error = Truncate(ex.Message, 1000);
            await db.SaveChangesAsync(ct);
            await CloseDispatchAsync(services, db, dispatch, ct);
            return;
        }

        // ---- first attempt per recipient, sequential -----------------------
        var sender = services.GetRequiredService<IRcdEmailSender>();
        foreach (var row in pending)
        {
            var message = BuildRecipientMessage(subscription.Id, row, subject, baseBody, attachments);
            var firstAttemptUtc = timeProvider.GetUtcNow().UtcDateTime;
            var error = await TrySendAsync(sender, message, ct);
            row.Attempts = 1;
            if (error is null)
            {
                row.Status = DispatchRecipientStatus.Sent;
                row.SentUtc = timeProvider.GetUtcNow().UtcDateTime;
                row.Error = null;
            }
            else
            {
                row.Error = Truncate(error, 1000);
                Enqueue(new RetryItem(
                    dispatch.Id, dispatch.SubscriptionId, dispatch.OwnerUserId, dispatch.Trigger,
                    row.Id, row.Email, message, AttemptsSoFar: 1, firstAttemptUtc,
                    DueUtc: firstAttemptUtc + SecondAttemptDelay));
            }

            await db.SaveChangesAsync(ct);
            await NotifyRecipientAsync(progress, dispatch, row, ct);
        }
        // The caller (RunDispatchBodyAsync) decides between closing now and
        // leaving the dispatch open for the retry queue.
    }

    // ================================================================= retries

    private void Enqueue(RetryItem item)
    {
        lock (_gate)
        {
            _retryQueue.Add(item);
        }
    }

    /// <summary>
    /// Pops and processes every retry whose due time has passed, then closes
    /// any dispatch that ran out of pending work. Public and deterministic
    /// (due math via TimeProvider) so tests drive it directly; the background
    /// drain loop and the scheduler tick are just periodic callers.
    /// </summary>
    public async Task ProcessDueRetriesAsync(CancellationToken ct)
    {
        List<RetryItem> due;
        lock (_gate)
        {
            var nowUtc = timeProvider.GetUtcNow().UtcDateTime;
            due = _retryQueue.Where(i => i.DueUtc <= nowUtc).ToList();
            _retryQueue.RemoveAll(i => i.DueUtc <= nowUtc);
        }

        if (due.Count == 0)
        {
            return;
        }

        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<ReconDashboardsDbContext>();
        var sender = services.GetRequiredService<IRcdEmailSender>();
        var progress = services.GetRequiredService<IRcdDispatchProgressNotifier>();
        var touchedDispatches = new HashSet<long>();

        foreach (var item in due)
        {
            var row = await db.SubscriptionDispatchRecipients
                .FirstOrDefaultAsync(r => r.Id == item.RecipientRowId, ct);
            if (row is null || row.Status != DispatchRecipientStatus.Pending)
            {
                touchedDispatches.Add(item.DispatchId);
                continue; // pruned or already resolved elsewhere
            }

            var error = await TrySendAsync(sender, item.Message, ct);
            var attempts = item.AttemptsSoFar + 1;
            row.Attempts = attempts;
            if (error is null)
            {
                row.Status = DispatchRecipientStatus.Sent;
                row.SentUtc = timeProvider.GetUtcNow().UtcDateTime;
                row.Error = null;
            }
            else if (attempts < MaxAttemptsPerRecipient)
            {
                row.Error = Truncate(error, 1000);
                Enqueue(item with
                {
                    AttemptsSoFar = attempts,
                    DueUtc = item.FirstAttemptUtc + ThirdAttemptDelay,
                });
            }
            else
            {
                row.Status = DispatchRecipientStatus.Failed;
                row.Error = Truncate(error, 1000);
            }

            await db.SaveChangesAsync(ct);

            var dispatch = await db.SubscriptionDispatches.AsNoTracking()
                .FirstOrDefaultAsync(d => d.Id == item.DispatchId, ct);
            if (dispatch is not null)
            {
                await NotifyRecipientAsync(progress, dispatch, row, ct);
            }

            touchedDispatches.Add(item.DispatchId);
        }

        foreach (var dispatchId in touchedDispatches)
        {
            // Never close under a still-running first pass — recipients later
            // in that pass are Pending without queue items yet.
            if (_firstPassInFlight.ContainsKey(dispatchId))
            {
                continue;
            }

            bool stillQueued;
            lock (_gate)
            {
                stillQueued = _retryQueue.Any(i => i.DispatchId == dispatchId);
            }

            if (!stillQueued)
            {
                var dispatch = await db.SubscriptionDispatches
                    .FirstOrDefaultAsync(d => d.Id == dispatchId, ct);
                if (dispatch is not null && dispatch.Status == DispatchStatus.Running)
                {
                    await CloseDispatchAsync(services, db, dispatch, ct);
                }
            }
        }

        EnsureDrainLoopRunning();
    }

    private void EnsureDrainLoopRunning()
    {
        lock (_gate)
        {
            if (_drainLoopRunning || _retryQueue.Count == 0)
            {
                return;
            }

            _drainLoopRunning = true;
        }

        _ = Task.Run(DrainLoopAsync);
    }

    private async Task DrainLoopAsync()
    {
        // TimeProvider-driven delay: in tests with a fake provider the loop
        // sleeps until fake time advances, so it never races the test's own
        // ProcessDueRetriesAsync calls in real time.
        while (true)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(15), timeProvider, CancellationToken.None);
                await ProcessDueRetriesAsync(CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Retry drain pass failed; queue keeps its items");
            }

            lock (_gate)
            {
                if (_retryQueue.Count == 0)
                {
                    _drainLoopRunning = false;
                    return;
                }
            }
        }
    }

    // ============================================================ maintenance

    /// <summary>
    /// Scheduler-tick housekeeping: close crash-orphaned dispatches, then (at
    /// most daily) prune history older than <see cref="RetentionPeriod"/>.
    /// Library-contained — no host worker involvement.
    /// </summary>
    public async Task RunMaintenanceAsync(CancellationToken ct)
    {
        await CloseAbandonedDispatchesAsync(ct);

        var nowUtc = timeProvider.GetUtcNow().UtcDateTime;
        if (nowUtc - _lastPruneUtc < TimeSpan.FromDays(1))
        {
            return;
        }

        _lastPruneUtc = nowUtc;
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        var cutoff = nowUtc - RetentionPeriod;
        // Children first: SQLite hosts may run without FK cascade enforcement,
        // and two targeted deletes are cheap either way.
        var recipientsPruned = await db.SubscriptionDispatchRecipients
            .Where(r => db.SubscriptionDispatches
                .Any(d => d.Id == r.DispatchId && d.StartedUtc < cutoff))
            .ExecuteDeleteAsync(ct);
        var dispatchesPruned = await db.SubscriptionDispatches
            .Where(d => d.StartedUtc < cutoff)
            .ExecuteDeleteAsync(ct);
        if (dispatchesPruned > 0)
        {
            logger.LogInformation(
                "Pruned {Dispatches} dispatch(es) / {Recipients} recipient row(s) older than {Days} days",
                dispatchesPruned, recipientsPruned, RetentionPeriod.TotalDays);
        }
    }

    private async Task CloseAbandonedDispatchesAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<ReconDashboardsDbContext>();
        var cutoff = timeProvider.GetUtcNow().UtcDateTime - AbandonedAfter;

        var stale = await db.SubscriptionDispatches
            .Where(d => d.Status == DispatchStatus.Running && d.StartedUtc < cutoff)
            .ToListAsync(ct);
        foreach (var dispatch in stale.Where(d => !_openDispatches.ContainsKey(d.Id)))
        {
            var pendingRows = await db.SubscriptionDispatchRecipients
                .Where(r => r.DispatchId == dispatch.Id && r.Status == DispatchRecipientStatus.Pending)
                .ToListAsync(ct);
            foreach (var row in pendingRows)
            {
                row.Status = DispatchRecipientStatus.Failed;
                row.Error = "The application restarted while this delivery was in progress; remaining attempts were abandoned.";
            }

            dispatch.Error ??= "The application restarted while this delivery was in progress.";
            await db.SaveChangesAsync(ct);
            logger.LogWarning(
                "Dispatch {DispatchId} (subscription {SubscriptionId}) was abandoned by a restart; closing",
                dispatch.Id, dispatch.SubscriptionId);
            await CloseDispatchAsync(services, db, dispatch, ct);
        }
    }

    // ================================================================= closing

    private async Task CloseSkippedAsync(
        IServiceProvider services, ReconDashboardsDbContext db,
        SubscriptionDispatchRecord dispatch, string reason, CancellationToken ct)
    {
        dispatch.Status = DispatchStatus.Skipped;
        dispatch.Error = Truncate(reason, 1000);
        dispatch.FinishedUtc = timeProvider.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);
        logger.LogWarning(
            "Dispatch {DispatchId} (subscription {SubscriptionId}) skipped: {Reason}",
            dispatch.Id, dispatch.SubscriptionId, reason);
        await NotifyFinishedAsync(services, dispatch, sent: 0, failed: 0, optedOut: 0, ct);
        ReleaseClaims(dispatch);
    }

    /// <summary>
    /// Roll-up per spec: all attempted sent → sent; some → partial; none →
    /// failed; nothing attempted at all (every recipient opted out) →
    /// skipped, honestly labeled. Fires the failure seam on failed/partial.
    /// </summary>
    private async Task CloseDispatchAsync(
        IServiceProvider services, ReconDashboardsDbContext db,
        SubscriptionDispatchRecord dispatch, CancellationToken ct)
    {
        var rows = await db.SubscriptionDispatchRecipients
            .Where(r => r.DispatchId == dispatch.Id)
            .ToListAsync(ct);

        // Defensive: a pending row with no queue item can only mean a logic
        // gap — never leave it dangling under a closed dispatch.
        foreach (var row in rows.Where(r => r.Status == DispatchRecipientStatus.Pending))
        {
            row.Status = DispatchRecipientStatus.Failed;
            row.Error ??= "Delivery was abandoned.";
        }

        var sent = rows.Count(r => r.Status == DispatchRecipientStatus.Sent);
        var failed = rows.Count(r => r.Status == DispatchRecipientStatus.Failed);
        var optedOut = rows.Count(r => r.Status == DispatchRecipientStatus.OptedOut);

        dispatch.Status = (sent, failed) switch
        {
            ( > 0, 0) => DispatchStatus.Sent,
            ( > 0, > 0) => DispatchStatus.Partial,
            (0, > 0) => DispatchStatus.Failed,
            _ => DispatchStatus.Skipped,
        };
        if (dispatch.Status == DispatchStatus.Skipped)
        {
            dispatch.Error ??= "All recipients have opted out of this subscription.";
        }

        dispatch.FinishedUtc = timeProvider.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "Dispatch {DispatchId} (subscription {SubscriptionId}, {Trigger}) closed {Status}: {Sent} sent / {Failed} failed / {OptedOut} opted out",
            dispatch.Id, dispatch.SubscriptionId, Wire(dispatch.Trigger), Wire(dispatch.Status), sent, failed, optedOut);

        await NotifyFinishedAsync(services, dispatch, sent, failed, optedOut, ct);

        if (dispatch.Status is DispatchStatus.Failed or DispatchStatus.Partial)
        {
            var firstError = dispatch.Error
                ?? rows.FirstOrDefault(r => r.Status == DispatchRecipientStatus.Failed && r.Error != null)?.Error;
            var failureNotifier = services.GetRequiredService<IRcdDeliveryFailureNotifier>();
            await NotifyAsync(() => failureNotifier.DispatchFailedAsync(
                new RcdDispatchFailure(
                    dispatch.OwnerUserId, dispatch.Id, dispatch.SubscriptionId, dispatch.SubscriptionName,
                    dispatch.DashboardId, Wire(dispatch.Status), sent, failed, firstError,
                    dispatch.FinishedUtc.Value), ct));
        }

        ReleaseClaims(dispatch);
    }

    private void ReleaseClaims(SubscriptionDispatchRecord dispatch)
    {
        _openDispatches.TryRemove(dispatch.Id, out _);
        if (dispatch.Trigger == DispatchTrigger.Manual)
        {
            _manualSendsInFlight.TryRemove(dispatch.SubscriptionId, out _);
        }
    }

    // ============================================================== email bits

    /// <summary>
    /// Personalizes the shared body per recipient: unsubscribe footer + open
    /// pixel, both HMAC-token links — appended only when BOTH UnsubscribeSecret
    /// and PublicBaseUrl are configured. With either missing the email is the
    /// plain snapshot: no dead links, no half-features (spec §2/§5).
    /// </summary>
    private RcdEmailMessage BuildRecipientMessage(
        int subscriptionId, SubscriptionDispatchRecipientRecord row,
        string subject, string baseBody, IReadOnlyList<RcdEmailAttachment> attachments)
    {
        var secret = options.UnsubscribeSecret;
        var publicBase = options.PublicBaseUrl;
        if (string.IsNullOrWhiteSpace(secret) || string.IsNullOrWhiteSpace(publicBase))
        {
            return new RcdEmailMessage([row.Email], subject, baseBody, attachments);
        }

        var apiBase = $"{publicBase.TrimEnd('/')}/{options.RoutePrefix.Trim('/')}/v1/subscriptions";
        var unsubscribeToken = RcdSignedTokens.CreateUnsubscribeToken(secret, subscriptionId, row.Email);
        var openToken = RcdSignedTokens.CreateOpenToken(secret, row.Id);
        var unsubscribeUrl = $"{apiBase}/unsubscribe?token={Uri.EscapeDataString(unsubscribeToken)}";
        var pixelUrl = $"{apiBase}/open?token={Uri.EscapeDataString(openToken)}";

        var body = baseBody
            + "<div style=\"font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#9ca3af;max-width:760px;margin:8px auto 0;\">"
            + $"This email was sent to {WebUtility.HtmlEncode(row.Email)}. "
            + $"<a href=\"{unsubscribeUrl}\" style=\"color:#6b7280;\">Unsubscribe</a>"
            + "</div>"
            + $"<img src=\"{pixelUrl}\" width=\"1\" height=\"1\" alt=\"\" style=\"display:block;width:1px;height:1px;border:0;\" />";
        return new RcdEmailMessage([row.Email], subject, body, attachments);
    }

    private async Task<string?> TrySendAsync(IRcdEmailSender sender, RcdEmailMessage message, CancellationToken ct)
    {
        try
        {
            await sender.SendAsync(message, ct);
            return null;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return string.IsNullOrWhiteSpace(ex.Message) ? ex.GetType().Name : ex.Message;
        }
    }

    // ============================================================ notify plumb

    private async Task NotifyRecipientAsync(
        IRcdDispatchProgressNotifier progress, SubscriptionDispatchRecord dispatch,
        SubscriptionDispatchRecipientRecord row, CancellationToken ct)
    {
        await NotifyAsync(() => progress.RecipientResultAsync(
            new RcdDispatchRecipientResult(
                dispatch.OwnerUserId, dispatch.Id, dispatch.SubscriptionId,
                row.Email, Wire(row.Status), row.Attempts, row.Error), ct));
    }

    private async Task NotifyFinishedAsync(
        IServiceProvider services, SubscriptionDispatchRecord dispatch,
        int sent, int failed, int optedOut, CancellationToken ct)
    {
        var progress = services.GetRequiredService<IRcdDispatchProgressNotifier>();
        await NotifyAsync(() => progress.DispatchFinishedAsync(
            new RcdDispatchFinished(
                dispatch.OwnerUserId, dispatch.Id, dispatch.SubscriptionId, Wire(dispatch.Status),
                sent, failed, optedOut, dispatch.Error, dispatch.FinishedUtc ?? dispatch.StartedUtc), ct));
    }

    /// <summary>Notifier seams are best-effort by contract: a throwing host bridge is logged, never fatal to a send.</summary>
    private async Task NotifyAsync(Func<Task> notify)
    {
        try
        {
            await notify();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Dispatch notifier threw; delivery state is already recorded");
        }
    }

    // ================================================================= helpers

    /// <summary>Wire casing for enum values ("optedOut", "schedule") — matches the JSON converters.</summary>
    private static string Wire<T>(T value) where T : struct, Enum
    {
        var name = value.ToString();
        return char.ToLowerInvariant(name[0]) + name[1..];
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];

    private static string SafeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var safe = new string(name.Select(c => invalid.Contains(c) || c == ' ' ? '-' : c).ToArray());
        return string.IsNullOrEmpty(safe) ? "dashboard" : safe;
    }
}
