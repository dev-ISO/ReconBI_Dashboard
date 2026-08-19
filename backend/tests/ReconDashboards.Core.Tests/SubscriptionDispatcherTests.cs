using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The per-recipient delivery pipeline end to end: dispatch/recipient audit
/// rows, opt-out suppression (per-subscription and global), the in-process
/// retry queue with its 0s/2min/8min schedule, roll-up statuses, unsubscribe
/// footer + open-pixel embedding, the manual-send guard, the progress and
/// failure notifier seams, abandoned-dispatch closing, and retention. Same
/// SQLite + fake-executor harness as SchedulingEvaluatorTests, plus recording
/// notifiers and a per-recipient scriptable email sink.
/// </summary>
public sealed class SubscriptionDispatcherTests : IDisposable
{
    private static readonly DateTime Now = new(2026, 8, 5, 12, 0, 0, DateTimeKind.Utc);

    // A file-backed database, NOT the usual single ":memory:" connection: the
    // manual-send path runs on a detached background task, and one
    // SqliteConnection instance is not safe under that concurrency. Separate
    // pooled connections over a file are.
    private readonly string _dbPath = Path.Combine(
        Path.GetTempPath(), $"rcd-dispatcher-tests-{Guid.NewGuid():N}.db");

    private readonly ServiceProvider _services;
    private readonly FakeExecutor _executor = new();
    private readonly ScriptedEmailSink _emails = new();
    private readonly RecordingProgressNotifier _progress = new();
    private readonly RecordingFailureNotifier _failures = new();
    private readonly MutableTimeProvider _clock = new(Now);
    private readonly ReconDashboardsOptions _options;
    private readonly SubscriptionDispatcher _dispatcher;
    private readonly int _dashboardId;

    public SubscriptionDispatcherTests()
    {
        _options = new ReconDashboardsOptions();
        _options.RegisterDataSource(new DataSourceRegistration(
            TestFixtures.DemoConnectionName,
            "test",
            new DataSourceOptions(),
            _ => new FixedSchemaIntrospector(TestFixtures.BuildDemoSchema()),
            _ => _executor,
            new PostgresSqlDialect()));

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(_options);
        services.AddSingleton<TimeProvider>(_clock);
        services.AddSingleton<IDataSourceRegistry>(sp => new DataSourceRegistry(_options, sp));
        services.AddSingleton<ISchemaCache, MemorySchemaCache>();
        services.AddSingleton<SemanticModelValidator>();
        services.AddSingleton<IRcdEmailSender>(_emails);
        services.AddSingleton<IRcdDispatchProgressNotifier>(_progress);
        services.AddSingleton<IRcdDeliveryFailureNotifier>(_failures);
        services.AddDbContext<ReconDashboardsDbContext>(o => o.UseSqlite($"DataSource={_dbPath}"));
        _services = services.BuildServiceProvider();

        using (var scope = _services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
            db.Database.EnsureCreated();

            var model = new DataModelRecord
            {
                DataSourceName = TestFixtures.DemoConnectionName,
                Name = "Demo model",
                DefinitionJson = ModelJson.Serialize(TestFixtures.BuildValidDemoModel()),
                OwnerUserId = "alice",
                IsShared = true,
                CreatedAtUtc = Now.AddDays(-30),
                UpdatedAtUtc = Now.AddDays(-30),
            };
            db.DataModels.Add(model);
            db.SaveChanges();

            var dashboard = new DashboardRecord
            {
                Name = "Ops Dashboard",
                ModelId = model.Id,
                LayoutJson = """
                    {
                      "version": 1, "tiles": [], "slicers": [],
                      "pages": [{ "id": "p1", "name": "Main", "tiles": [
                        { "id": "t1", "chart": { "id": "c1", "type": "column", "title": "Sales by region", "query": {
                          "axis": { "table": "public.customers", "column": "region" },
                          "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
                          "filters": [] } } }
                      ]}]
                    }
                    """,
                OwnerUserId = "alice",
                IsShared = true,
                CreatedAtUtc = Now.AddDays(-30),
                UpdatedAtUtc = Now.AddDays(-30),
            };
            db.Dashboards.Add(dashboard);
            db.SaveChanges();
            _dashboardId = dashboard.Id;
        }

        _dispatcher = new SubscriptionDispatcher(
            _services.GetRequiredService<IServiceScopeFactory>(),
            _clock,
            _options,
            NullLogger<SubscriptionDispatcher>.Instance);
    }

    public void Dispose()
    {
        _services.Dispose();
        SqliteConnection.ClearAllPools();
        try
        {
            File.Delete(_dbPath);
        }
        catch (IOException)
        {
            // A stray background task may still hold the file for a moment;
            // temp-dir leftovers are harmless.
        }
    }

    // ------------------------------------------------------------------ helpers

    private int AddSubscription(Action<SubscriptionRecord>? mutate = null)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        var record = new SubscriptionRecord
        {
            DashboardId = _dashboardId,
            OwnerUserId = "alice",
            Name = "Morning snapshot",
            ScheduleKind = SubscriptionScheduleKind.Interval,
            IntervalMinutes = 30,
            Recipients = "ops@example.com; boss@example.com",
            Format = SubscriptionFormat.Html,
            Enabled = true,
            CreatedUtc = Now.AddDays(-1),
        };
        mutate?.Invoke(record);
        db.Subscriptions.Add(record);
        db.SaveChanges();
        return record.Id;
    }

    private void Seed(Action<ReconDashboardsDbContext> action)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        action(db);
        db.SaveChanges();
    }

    private T Query<T>(Func<ReconDashboardsDbContext, T> query)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        return query(db);
    }

    /// <summary>Waits (real time) for a background manual-send body to reach a db-visible state.</summary>
    private async Task WaitUntilAsync(Func<bool> condition)
    {
        var stopwatch = Stopwatch.StartNew();
        while (!condition())
        {
            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(10), "Timed out waiting for the background dispatch.");
            await Task.Delay(25);
        }
    }

    // ------------------------------------------------------------------ optouts

    [Fact]
    public async Task OptedOutRecipientIsRecordedAndNeverAttempted()
    {
        var id = AddSubscription();
        Seed(db => db.SubscriptionOptOuts.Add(new SubscriptionOptOutRecord
        {
            SubscriptionId = id,
            Email = "boss@example.com",
            OptedOutUtc = Now.AddDays(-2),
        }));

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        var message = Assert.Single(_emails.Sent);
        Assert.Equal(["ops@example.com"], message.Recipients);

        var dispatch = Query(db => db.SubscriptionDispatches.Single());
        Assert.Equal(DispatchStatus.Sent, dispatch.Status); // opt-outs never count against the roll-up

        var rows = Query(db => db.SubscriptionDispatchRecipients.OrderBy(r => r.Email).ToList());
        Assert.Equal(2, rows.Count);
        var boss = rows.Single(r => r.Email == "boss@example.com");
        Assert.Equal(DispatchRecipientStatus.OptedOut, boss.Status);
        Assert.Equal(0, boss.Attempts);
        Assert.Null(boss.SentUtc);
        Assert.Equal(
            DispatchRecipientStatus.Sent, rows.Single(r => r.Email == "ops@example.com").Status);

        // The opted-out recipient is announced to the live strip too.
        Assert.Contains(_progress.Recipients, e => e.Email == "boss@example.com" && e.Status == "optedOut");
    }

    [Fact]
    public async Task GlobalOptOutSuppressesTheAddressCaseInsensitively()
    {
        var id = AddSubscription(s => s.Recipients = "Boss@Example.com; ops@example.com");
        Seed(db => db.GlobalOptOuts.Add(new GlobalOptOutRecord
        {
            Email = "boss@example.com", // stored lower-cased by the unsubscribe write
            OptedOutUtc = Now.AddDays(-2),
        }));

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        var message = Assert.Single(_emails.Sent);
        Assert.Equal(["ops@example.com"], message.Recipients);
        Assert.Equal(
            DispatchRecipientStatus.OptedOut,
            Query(db => db.SubscriptionDispatchRecipients.Single(r => r.Email == "Boss@Example.com").Status));
    }

    [Fact]
    public async Task AllRecipientsOptedOutClosesSkippedWithoutRendering()
    {
        var id = AddSubscription();
        Seed(db => db.GlobalOptOuts.AddRange(
            new GlobalOptOutRecord { Email = "ops@example.com", OptedOutUtc = Now },
            new GlobalOptOutRecord { Email = "boss@example.com", OptedOutUtc = Now }));

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        Assert.Empty(_emails.Sent);
        Assert.Equal(0, _executor.Count); // nothing to send ⇒ never rendered
        var dispatch = Query(db => db.SubscriptionDispatches.Single());
        Assert.Equal(DispatchStatus.Skipped, dispatch.Status);
        Assert.Contains("opted out", dispatch.Error, StringComparison.Ordinal);
        Assert.Empty(_failures.Failures); // skipped is not a failure
    }

    // ------------------------------------------------------------------ retries

    [Fact]
    public async Task FailedRecipientRetriesOnTheBackoffScheduleAndSucceeds()
    {
        var id = AddSubscription();
        _emails.FailFor("ops@example.com", times: 1);

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        // boss delivered, ops pending its retry; dispatch stays running.
        Assert.Single(_emails.Sent);
        var pending = Query(db => db.SubscriptionDispatchRecipients.Single(r => r.Email == "ops@example.com"));
        Assert.Equal(DispatchRecipientStatus.Pending, pending.Status);
        Assert.Equal(1, pending.Attempts);
        Assert.Contains("Simulated SMTP outage", pending.Error, StringComparison.Ordinal);
        Assert.Equal(DispatchStatus.Running, Query(db => db.SubscriptionDispatches.Single().Status));

        // Before +2min the retry is not due — nothing happens.
        await _dispatcher.ProcessDueRetriesAsync(CancellationToken.None);
        Assert.Single(_emails.Sent);

        // At +2min the second attempt succeeds and the dispatch closes 'sent'.
        _clock.NowUtc = Now.AddMinutes(2);
        await _dispatcher.ProcessDueRetriesAsync(CancellationToken.None);

        Assert.Equal(2, _emails.Sent.Count);
        var retried = Query(db => db.SubscriptionDispatchRecipients.Single(r => r.Email == "ops@example.com"));
        Assert.Equal(DispatchRecipientStatus.Sent, retried.Status);
        Assert.Equal(2, retried.Attempts);
        Assert.Null(retried.Error);
        Assert.Equal(DispatchStatus.Sent, Query(db => db.SubscriptionDispatches.Single().Status));
        Assert.Empty(_failures.Failures);

        var finished = Assert.Single(_progress.Finished);
        Assert.Equal("sent", finished.Status);
        Assert.Equal(2, finished.SentCount);
    }

    [Fact]
    public async Task RecipientExhaustingThreeAttemptsClosesPartialAndNotifiesFailure()
    {
        var id = AddSubscription();
        _emails.FailFor("ops@example.com", times: 3);

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);
        _clock.NowUtc = Now.AddMinutes(2); // attempt 2 fails
        await _dispatcher.ProcessDueRetriesAsync(CancellationToken.None);
        Assert.Equal(
            DispatchRecipientStatus.Pending,
            Query(db => db.SubscriptionDispatchRecipients.Single(r => r.Email == "ops@example.com").Status));

        _clock.NowUtc = Now.AddMinutes(8); // attempt 3 fails ⇒ terminal
        await _dispatcher.ProcessDueRetriesAsync(CancellationToken.None);

        var failedRow = Query(db => db.SubscriptionDispatchRecipients.Single(r => r.Email == "ops@example.com"));
        Assert.Equal(DispatchRecipientStatus.Failed, failedRow.Status);
        Assert.Equal(3, failedRow.Attempts);

        var dispatch = Query(db => db.SubscriptionDispatches.Single());
        Assert.Equal(DispatchStatus.Partial, dispatch.Status);

        var failure = Assert.Single(_failures.Failures);
        Assert.Equal("alice", failure.OwnerUserId);
        Assert.Equal(id, failure.SubscriptionId);
        Assert.Equal("Morning snapshot", failure.SubscriptionName);
        Assert.Equal("partial", failure.Status);
        Assert.Equal(1, failure.SentCount);
        Assert.Equal(1, failure.FailedCount);
        Assert.Contains("Simulated SMTP outage", failure.FirstError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EveryRecipientFailingClosesFailed()
    {
        var id = AddSubscription(s => s.Recipients = "ops@example.com");
        _emails.FailFor("ops@example.com", times: 3);

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);
        _clock.NowUtc = Now.AddMinutes(2);
        await _dispatcher.ProcessDueRetriesAsync(CancellationToken.None);
        _clock.NowUtc = Now.AddMinutes(8);
        await _dispatcher.ProcessDueRetriesAsync(CancellationToken.None);

        Assert.Equal(DispatchStatus.Failed, Query(db => db.SubscriptionDispatches.Single().Status));
        Assert.Equal("failed", Assert.Single(_failures.Failures).Status);
    }

    [Fact]
    public async Task TileQueryFailureStillDeliversTheSnapshotWithAnErrorNote()
    {
        // Query-pipeline failures (db outage, bad spec, row-filter denial) are
        // BY DESIGN tile-level content — the snapshot still ships, showing a
        // safe error note, and the dispatch closes 'sent'. Occurrence-level
        // 'failed' is reserved for the render itself blowing up (a defensive
        // path: nothing inside RunAsync can escape it by contract).
        var id = AddSubscription(s => s.Recipients = "ops@example.com");
        _executor.ThrowNext = true;

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        var message = Assert.Single(_emails.Sent);
        Assert.Contains("The query failed to execute", message.HtmlBody, StringComparison.Ordinal);
        Assert.Equal(DispatchStatus.Sent, Query(db => db.SubscriptionDispatches.Single().Status));
        Assert.Empty(_failures.Failures);
    }

    // ------------------------------------------------- footer + tracking pixel

    [Fact]
    public async Task WithoutSecretOrBaseUrlEmailsCarryNoFooterOrPixel()
    {
        var id = AddSubscription(s => s.Recipients = "ops@example.com");
        // Only one of the pair set: still no footer — never a broken link.
        _options.UnsubscribeSecret = "secret-without-base-url";
        _options.PublicBaseUrl = null;

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        var message = Assert.Single(_emails.Sent);
        Assert.DoesNotContain("unsubscribe", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("/open?token=", message.HtmlBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ConfiguredEmailsEmbedVerifiableUnsubscribeAndOpenTokens()
    {
        var id = AddSubscription(s => s.Recipients = "ops@example.com");
        _options.UnsubscribeSecret = "a-long-random-secret";
        _options.PublicBaseUrl = "https://valves.example.com/";

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        var body = Assert.Single(_emails.Sent).HtmlBody;
        Assert.Contains("https://valves.example.com/api/rcd/v1/subscriptions/unsubscribe?token=", body, StringComparison.Ordinal);
        Assert.Contains("https://valves.example.com/api/rcd/v1/subscriptions/open?token=", body, StringComparison.Ordinal);

        // Round-trip both embedded tokens against the same secret.
        var unsubscribeToken = Uri.UnescapeDataString(
            Regex.Match(body, "unsubscribe\\?token=([^\"]+)").Groups[1].Value);
        Assert.True(RcdSignedTokens.TryReadUnsubscribeToken(
            "a-long-random-secret", unsubscribeToken, out var subscriptionId, out var email));
        Assert.Equal(id, subscriptionId);
        Assert.Equal("ops@example.com", email);

        var openToken = Uri.UnescapeDataString(Regex.Match(body, "open\\?token=([^\"]+)").Groups[1].Value);
        Assert.True(RcdSignedTokens.TryReadOpenToken("a-long-random-secret", openToken, out var recipientId));
        Assert.Equal(
            recipientId, Query(db => db.SubscriptionDispatchRecipients.Single(r => r.Email == "ops@example.com").Id));
    }

    // ------------------------------------------------------------- manual sends

    [Fact]
    public async Task ManualSendRunsTheSamePipelineAndGuardsConcurrency()
    {
        var id = AddSubscription();
        _emails.FailFor("ops@example.com", times: 1); // keeps the dispatch open past the first pass

        var first = await _dispatcher.StartManualAsync(id, "admin-7", CancellationToken.None);
        Assert.True(first.Succeeded);

        // The guard holds until the dispatch CLOSES (retry pending ⇒ still open).
        var second = await _dispatcher.StartManualAsync(id, "admin-7", CancellationToken.None);
        Assert.False(second.Succeeded);
        Assert.Equal(Services.ServiceErrorKind.TooManyRequests, second.Error!.Kind);
        Assert.Equal("rcd.subscription.send_in_progress", second.Error.Code);

        // Wait for the detached body to finish its first pass, then drain the retry.
        await WaitUntilAsync(() => Query(db =>
            db.SubscriptionDispatchRecipients.Count(r => r.DispatchId == first.Value && r.Attempts >= 1) == 2));
        _clock.NowUtc = Now.AddMinutes(2);
        await _dispatcher.ProcessDueRetriesAsync(CancellationToken.None);

        var dispatch = Query(db => db.SubscriptionDispatches.Single(d => d.Id == first.Value));
        Assert.Equal(DispatchStatus.Sent, dispatch.Status);
        Assert.Equal(DispatchTrigger.Manual, dispatch.Trigger);
        Assert.Equal("admin-7", dispatch.RequestedBy);
        // Manual sends never advance the scheduler's due-math cache.
        Assert.Null(Query(db => db.Subscriptions.Single(s => s.Id == id).LastRunUtc));

        // Closed ⇒ the guard is released.
        var third = await _dispatcher.StartManualAsync(id, "admin-7", CancellationToken.None);
        Assert.True(third.Succeeded);
        await WaitUntilAsync(() => Query(db =>
            db.SubscriptionDispatches.Single(d => d.Id == third.Value).Status != DispatchStatus.Running));
    }

    // ---------------------------------------------------------- progress seam

    [Fact]
    public async Task ProgressNotifierReceivesTheFullEventSequence()
    {
        var id = AddSubscription();

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        var started = Assert.Single(_progress.Started);
        Assert.Equal("alice", started.OwnerUserId);
        Assert.Equal(id, started.SubscriptionId);
        Assert.Equal("Morning snapshot", started.SubscriptionName);
        Assert.Equal("schedule", started.Trigger);
        Assert.Equal(2, started.RecipientCount);

        Assert.Equal(2, _progress.Recipients.Count);
        Assert.All(_progress.Recipients, e =>
        {
            Assert.Equal("alice", e.OwnerUserId);
            Assert.Equal(started.DispatchId, e.DispatchId);
            Assert.Equal("sent", e.Status);
            Assert.Equal(1, e.Attempts);
        });

        var finished = Assert.Single(_progress.Finished);
        Assert.Equal(started.DispatchId, finished.DispatchId);
        Assert.Equal("sent", finished.Status);
        Assert.Equal(2, finished.SentCount);
        Assert.Equal(0, finished.FailedCount);
    }

    [Fact]
    public async Task ThrowingNotifierNeverBreaksDelivery()
    {
        _progress.ThrowOnEverything = true;
        var id = AddSubscription();

        await _dispatcher.ExecuteScheduledAsync(id, Now, CancellationToken.None);

        Assert.Equal(2, _emails.Sent.Count);
        Assert.Equal(DispatchStatus.Sent, Query(db => db.SubscriptionDispatches.Single().Status));
    }

    [Fact]
    public async Task NoOpDefaultsCompleteWithoutSideEffects()
    {
        // The library-registered defaults must be safely callable — hosts that
        // never bridge realtime/bell get exactly nothing, never an exception.
        var progress = new NullRcdDispatchProgressNotifier();
        await progress.DispatchStartedAsync(
            new RcdDispatchStarted("u", 1, 2, "s", "manual", 1, Now), CancellationToken.None);
        await progress.RecipientResultAsync(
            new RcdDispatchRecipientResult("u", 1, 2, "a@b.c", "sent", 1, null), CancellationToken.None);
        await progress.DispatchFinishedAsync(
            new RcdDispatchFinished("u", 1, 2, "sent", 1, 0, 0, null, Now), CancellationToken.None);
        await new NullRcdDeliveryFailureNotifier().DispatchFailedAsync(
            new RcdDispatchFailure("u", 1, 2, "s", 3, "failed", 0, 1, "boom", Now), CancellationToken.None);
    }

    // ------------------------------------------------------------- maintenance

    [Fact]
    public async Task MaintenanceClosesDispatchesAbandonedByARestart()
    {
        var id = AddSubscription();
        long dispatchId = 0;
        Seed(db =>
        {
            var dispatch = new SubscriptionDispatchRecord
            {
                SubscriptionId = id,
                SubscriptionName = "Morning snapshot",
                OwnerUserId = "alice",
                DashboardId = _dashboardId,
                Trigger = DispatchTrigger.Manual,
                StartedUtc = Now.AddMinutes(-20), // older than AbandonedAfter, unknown to this process
                Status = DispatchStatus.Running,
            };
            db.SubscriptionDispatches.Add(dispatch);
            db.SaveChanges();
            dispatchId = dispatch.Id;
            db.SubscriptionDispatchRecipients.Add(new SubscriptionDispatchRecipientRecord
            {
                DispatchId = dispatch.Id,
                Email = "ops@example.com",
                Status = DispatchRecipientStatus.Pending,
                Attempts = 1,
            });
        });

        await _dispatcher.RunMaintenanceAsync(CancellationToken.None);

        var dispatch = Query(db => db.SubscriptionDispatches.Single(d => d.Id == dispatchId));
        Assert.Equal(DispatchStatus.Failed, dispatch.Status);
        Assert.NotNull(dispatch.FinishedUtc);
        var row = Query(db => db.SubscriptionDispatchRecipients.Single(r => r.DispatchId == dispatchId));
        Assert.Equal(DispatchRecipientStatus.Failed, row.Status);
        Assert.Contains("restarted", row.Error, StringComparison.Ordinal);
        Assert.Single(_failures.Failures); // honestly reported to the owner
    }

    [Fact]
    public async Task MaintenancePrunesDispatchHistoryOlderThanNinetyDays()
    {
        var id = AddSubscription();
        Seed(db =>
        {
            var old = new SubscriptionDispatchRecord
            {
                SubscriptionId = id,
                SubscriptionName = "Morning snapshot",
                OwnerUserId = "alice",
                DashboardId = _dashboardId,
                Trigger = DispatchTrigger.Schedule,
                StartedUtc = Now.AddDays(-91),
                FinishedUtc = Now.AddDays(-91),
                Status = DispatchStatus.Sent,
            };
            var recent = new SubscriptionDispatchRecord
            {
                SubscriptionId = id,
                SubscriptionName = "Morning snapshot",
                OwnerUserId = "alice",
                DashboardId = _dashboardId,
                Trigger = DispatchTrigger.Schedule,
                StartedUtc = Now.AddDays(-5),
                FinishedUtc = Now.AddDays(-5),
                Status = DispatchStatus.Sent,
            };
            db.SubscriptionDispatches.AddRange(old, recent);
            db.SaveChanges();
            db.SubscriptionDispatchRecipients.Add(new SubscriptionDispatchRecipientRecord
            {
                DispatchId = old.Id,
                Email = "ops@example.com",
                Status = DispatchRecipientStatus.Sent,
                Attempts = 1,
            });
        });

        await _dispatcher.RunMaintenanceAsync(CancellationToken.None);

        var survivors = Query(db => db.SubscriptionDispatches.ToList());
        var survivor = Assert.Single(survivors);
        Assert.Equal(Now.AddDays(-5), survivor.StartedUtc);
        Assert.Empty(Query(db => db.SubscriptionDispatchRecipients.ToList()));
    }

    // ------------------------------------------------------------------ fakes

    private sealed class MutableTimeProvider(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset NowUtc { get; set; } = start;

        public override DateTimeOffset GetUtcNow() => NowUtc;
    }

    private sealed class FakeExecutor : IQueryExecutor
    {
        public IReadOnlyList<object?[]> Rows { get; set; } = [["West", 120m]];

        public int Count { get; private set; }

        /// <summary>Simulates a charts-database outage: an exception the query pipeline does not translate.</summary>
        public bool ThrowNext { get; set; }

        public Task<ExecutedQuery> ExecuteAsync(
            CompiledQuery query, ExecutionOptions options, CancellationToken cancellationToken)
        {
            if (ThrowNext)
            {
                ThrowNext = false;
                throw new InvalidOperationException("Simulated charts database outage.");
            }

            Count++;
            return Task.FromResult(new ExecutedQuery(Rows, Truncated: false, ElapsedMs: 1));
        }
    }

    /// <summary>Single-recipient sink with scriptable per-address failures ("fail the next N sends to X").</summary>
    private sealed class ScriptedEmailSink : IRcdEmailSender
    {
        private readonly Dictionary<string, int> _failuresLeft = new(StringComparer.OrdinalIgnoreCase);
        private readonly object _gate = new();

        public List<RcdEmailMessage> Sent { get; } = [];

        public void FailFor(string email, int times)
        {
            lock (_gate)
            {
                _failuresLeft[email] = times;
            }
        }

        public Task SendAsync(RcdEmailMessage message, CancellationToken cancellationToken)
        {
            var recipient = Assert.Single(message.Recipients); // the pipeline sends per-recipient, always
            lock (_gate)
            {
                if (_failuresLeft.TryGetValue(recipient, out var left) && left > 0)
                {
                    _failuresLeft[recipient] = left - 1;
                    throw new InvalidOperationException("Simulated SMTP outage.");
                }

                Sent.Add(message);
            }

            return Task.CompletedTask;
        }
    }

    private sealed class RecordingProgressNotifier : IRcdDispatchProgressNotifier
    {
        public List<RcdDispatchStarted> Started { get; } = [];

        public List<RcdDispatchRecipientResult> Recipients { get; } = [];

        public List<RcdDispatchFinished> Finished { get; } = [];

        public bool ThrowOnEverything { get; set; }

        public Task DispatchStartedAsync(RcdDispatchStarted started, CancellationToken ct)
        {
            if (ThrowOnEverything) throw new InvalidOperationException("Simulated bridge outage.");
            Started.Add(started);
            return Task.CompletedTask;
        }

        public Task RecipientResultAsync(RcdDispatchRecipientResult result, CancellationToken ct)
        {
            if (ThrowOnEverything) throw new InvalidOperationException("Simulated bridge outage.");
            Recipients.Add(result);
            return Task.CompletedTask;
        }

        public Task DispatchFinishedAsync(RcdDispatchFinished finished, CancellationToken ct)
        {
            if (ThrowOnEverything) throw new InvalidOperationException("Simulated bridge outage.");
            Finished.Add(finished);
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingFailureNotifier : IRcdDeliveryFailureNotifier
    {
        public List<RcdDispatchFailure> Failures { get; } = [];

        public Task DispatchFailedAsync(RcdDispatchFailure failure, CancellationToken ct)
        {
            Failures.Add(failure);
            return Task.CompletedTask;
        }
    }
}
