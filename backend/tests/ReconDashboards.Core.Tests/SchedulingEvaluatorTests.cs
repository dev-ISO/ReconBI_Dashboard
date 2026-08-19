using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Email;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// End-to-end evaluator tests over real DI scopes: SQLite storage, the fixture
/// demo catalog with the Postgres dialect and a fake executor, a recording
/// email sink, and a row-filter contributor proving the OWNER's identity flows
/// through the fail-closed row-filter path.
/// </summary>
public sealed class SchedulingEvaluatorTests : IDisposable
{
    private static readonly DateTime Now = new(2026, 8, 5, 12, 0, 0, DateTimeKind.Utc);

    private readonly SqliteConnection _connection;
    private readonly ServiceProvider _services;
    private readonly FakeExecutor _executor = new();
    private readonly RecordingEmailSink _emails = new();
    private readonly SchedulingEvaluator _evaluator;
    private readonly int _modelId;
    private readonly int _dashboardId;

    public SchedulingEvaluatorTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var options = new ReconDashboardsOptions();
        options.RegisterDataSource(new DataSourceRegistration(
            TestFixtures.DemoConnectionName,
            "test",
            new DataSourceOptions(),
            _ => new FixedSchemaIntrospector(TestFixtures.BuildDemoSchema()),
            _ => _executor,
            new PostgresSqlDialect()));

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(options);
        services.AddSingleton<TimeProvider>(new FixedTimeProvider(Now));
        services.AddSingleton<IDataSourceRegistry>(sp => new DataSourceRegistry(options, sp));
        services.AddSingleton<ISchemaCache, MemorySchemaCache>();
        services.AddSingleton<SemanticModelValidator>();
        services.AddSingleton<IRcdEmailSender>(_emails);
        services.AddSingleton<IRowFilterContributor, TestRowFilterContributor>();
        // The dispatcher resolves the notifier seams per scope; the library's
        // no-op defaults keep these tests focused on delivery semantics.
        services.AddSingleton<IRcdDispatchProgressNotifier, NullRcdDispatchProgressNotifier>();
        services.AddSingleton<IRcdDeliveryFailureNotifier, NullRcdDeliveryFailureNotifier>();
        services.AddDbContext<ReconDashboardsDbContext>(o => o.UseSqlite(_connection));
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
            _modelId = model.Id;

            var dashboard = new DashboardRecord
            {
                Name = "Ops Dashboard",
                ModelId = model.Id,
                LayoutJson = DashboardLayout(),
                OwnerUserId = "alice",
                CreatedAtUtc = Now.AddDays(-30),
                UpdatedAtUtc = Now.AddDays(-30),
            };
            db.Dashboards.Add(dashboard);
            db.SaveChanges();
            _dashboardId = dashboard.Id;
        }

        var dispatcher = new SubscriptionDispatcher(
            _services.GetRequiredService<IServiceScopeFactory>(),
            _services.GetRequiredService<TimeProvider>(),
            options,
            NullLogger<SubscriptionDispatcher>.Instance);
        _evaluator = new SchedulingEvaluator(
            _services.GetRequiredService<IServiceScopeFactory>(),
            _services.GetRequiredService<TimeProvider>(),
            options, // defaults: ScheduleTimeZoneId/Label "UTC" — legacy pure-UTC behavior
            dispatcher,
            NullLogger<SchedulingEvaluator>.Instance);
    }

    public void Dispose()
    {
        _services.Dispose();
        _connection.Dispose();
    }

    private static string DashboardLayout() => """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{ "id": "p1", "name": "Main", "tiles": [
            { "id": "t1", "chart": { "id": "c1", "type": "column", "title": "Sales by region", "query": {
              "axis": { "table": "public.customers", "column": "region" },
              "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
              "filters": [] } } }
          ]}]
        }
        """;

    private string AlertSpecJson() =>
        $$"""{"modelId":{{_modelId}},"dimensions":[],"measures":[{"table":"public.orders","column":"order_total","aggregation":"sum"}],"filters":[],"sort":[]}""";

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

    private int AddAlert(Action<AlertRecord>? mutate = null)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        var record = new AlertRecord
        {
            OwnerUserId = "alice",
            DashboardId = _dashboardId,
            Name = "High sales",
            SpecJson = AlertSpecJson(),
            Operator = AlertOperator.Gt,
            Threshold = 300m,
            Recipients = "ops@example.com",
            EveryMinutes = 5,
            CooldownMinutes = 60,
            Enabled = true,
            CreatedUtc = Now.AddDays(-1),
        };
        mutate?.Invoke(record);
        db.Alerts.Add(record);
        db.SaveChanges();
        return record.Id;
    }

    private T Reload<T>(int id) where T : class
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        return (db.Find(typeof(T), id) as T)!;
    }

    // ------------------------------------------------------------ subscriptions

    [Fact]
    public async Task DueSubscriptionSendsPerRecipientAndRecordsTheDispatch()
    {
        var id = AddSubscription();
        _executor.Rows = [["West", 120m], ["East", 45m]];

        await _evaluator.RunOnceAsync(CancellationToken.None);

        // Per-recipient sends (the 0.11.0 pipeline): ONE message per address,
        // identical rendered body — never the old single multi-recipient email.
        Assert.Equal(2, _emails.Sent.Count);
        Assert.Equal(
            ["boss@example.com", "ops@example.com"],
            _emails.Sent.SelectMany(m => m.Recipients).OrderBy(r => r).ToArray());
        foreach (var message in _emails.Sent)
        {
            Assert.Single(message.Recipients);
            Assert.Equal("Ops Dashboard — dashboard snapshot", message.Subject);
            Assert.Contains("Ops Dashboard", message.HtmlBody, StringComparison.Ordinal);
            Assert.Contains("Sales by region", message.HtmlBody, StringComparison.Ordinal);
            Assert.Contains("West", message.HtmlBody, StringComparison.Ordinal);
            Assert.Empty(message.Attachments);
        }

        Assert.Equal(Now, Reload<SubscriptionRecord>(id).LastRunUtc);

        // The audit truth: one dispatch row, closed 'sent', one recipient row
        // per address with SentUtc stamped and a single attempt.
        using (var scope = _services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
            var dispatch = Assert.Single(db.SubscriptionDispatches.ToList());
            Assert.Equal(id, dispatch.SubscriptionId);
            Assert.Equal("Morning snapshot", dispatch.SubscriptionName);
            Assert.Equal("alice", dispatch.OwnerUserId);
            Assert.Equal(DispatchTrigger.Schedule, dispatch.Trigger);
            Assert.Equal(DispatchStatus.Sent, dispatch.Status);
            Assert.NotNull(dispatch.FinishedUtc);
            Assert.Null(dispatch.Error);

            var recipients = db.SubscriptionDispatchRecipients.OrderBy(r => r.Id).ToList();
            Assert.Equal(2, recipients.Count);
            Assert.All(recipients, r =>
            {
                Assert.Equal(dispatch.Id, r.DispatchId);
                Assert.Equal(DispatchRecipientStatus.Sent, r.Status);
                Assert.Equal(1, r.Attempts);
                Assert.NotNull(r.SentUtc);
                Assert.Null(r.Error);
            });
        }

        // Running again at the same instant: no longer due, nothing new sent.
        await _evaluator.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, _emails.Sent.Count);
    }

    [Fact]
    public async Task CsvSubscriptionAttachesMergedCsv()
    {
        AddSubscription(s =>
        {
            s.Format = SubscriptionFormat.Csv;
            s.Recipients = "ops@example.com";
        });
        _executor.Rows = [["West", 120m]];

        await _evaluator.RunOnceAsync(CancellationToken.None);

        var message = Assert.Single(_emails.Sent);
        var attachment = Assert.Single(message.Attachments);
        Assert.Equal("text/csv", attachment.ContentType);
        Assert.EndsWith(".csv", attachment.FileName, StringComparison.Ordinal);
        Assert.Contains("# Main / Sales by region", attachment.Content, StringComparison.Ordinal);
        Assert.Contains("West,120", attachment.Content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SnapshotQueriesRunUnderTheOwnersRowFilterIdentity()
    {
        // TestRowFilterContributor scopes alice to region = 'West' on
        // public.customers; the tile joins customers, so the compiled SQL must
        // carry the owner's mandatory predicate.
        AddSubscription();

        await _evaluator.RunOnceAsync(CancellationToken.None);

        Assert.NotNull(_executor.LastQuery);
        Assert.Contains("\"region\" = @", _executor.LastQuery!.Sql, StringComparison.Ordinal);
        Assert.Contains(_executor.LastQuery.Parameters, p => Equals(p.Value, "West"));
    }

    [Fact]
    public async Task SubscriptionForDashboardTheOwnerCannotReadIsSkipped()
    {
        var id = AddSubscription(s => s.OwnerUserId = "bob"); // dashboard is alice's, not shared

        await _evaluator.RunOnceAsync(CancellationToken.None);

        Assert.Empty(_emails.Sent);
        Assert.Equal(0, _executor.Count);
        Assert.Equal(Now, Reload<SubscriptionRecord>(id).LastRunUtc); // recorded, not retried every tick

        // The occurrence is history too: a 'skipped' dispatch row with the reason.
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        var dispatch = Assert.Single(db.SubscriptionDispatches.ToList());
        Assert.Equal(DispatchStatus.Skipped, dispatch.Status);
        Assert.Contains("no longer visible", dispatch.Error, StringComparison.Ordinal);
        Assert.Empty(db.SubscriptionDispatchRecipients.ToList());
    }

    [Fact]
    public async Task NotDueSubscriptionIsUntouched()
    {
        var id = AddSubscription(s => s.LastRunUtc = Now.AddMinutes(-10)); // 30-minute interval

        await _evaluator.RunOnceAsync(CancellationToken.None);

        Assert.Empty(_emails.Sent);
        Assert.Equal(Now.AddMinutes(-10), Reload<SubscriptionRecord>(id).LastRunUtc);
    }

    // ------------------------------------------------------------------- alerts

    [Fact]
    public async Task DueAlertFiresWhenConditionMet()
    {
        var id = AddAlert();
        _executor.Rows = [[312m]];

        await _evaluator.RunOnceAsync(CancellationToken.None);

        var message = Assert.Single(_emails.Sent);
        Assert.Equal("Alert High sales: value 312 crossed > 300", message.Subject);
        Assert.Equal(["ops@example.com"], message.Recipients);

        var alert = Reload<AlertRecord>(id);
        Assert.Equal(Now, alert.LastEvaluatedUtc);
        Assert.Equal(Now, alert.LastFiredUtc);
        Assert.Equal(312m, alert.LastValue);
    }

    [Fact]
    public async Task AlertBelowThresholdEvaluatesWithoutFiring()
    {
        var id = AddAlert();
        _executor.Rows = [[250m]];

        await _evaluator.RunOnceAsync(CancellationToken.None);

        Assert.Empty(_emails.Sent);
        var alert = Reload<AlertRecord>(id);
        Assert.Equal(Now, alert.LastEvaluatedUtc);
        Assert.Null(alert.LastFiredUtc);
        Assert.Equal(250m, alert.LastValue);
    }

    [Fact]
    public async Task CooldownSuppressesRefiring()
    {
        var id = AddAlert(a =>
        {
            a.LastEvaluatedUtc = Now.AddMinutes(-10);
            a.LastFiredUtc = Now.AddMinutes(-10); // cooldown 60 not elapsed
        });
        _executor.Rows = [[500m]];

        await _evaluator.RunOnceAsync(CancellationToken.None);

        Assert.Empty(_emails.Sent);
        var alert = Reload<AlertRecord>(id);
        Assert.Equal(Now, alert.LastEvaluatedUtc); // still evaluated
        Assert.Equal(500m, alert.LastValue);
        Assert.Equal(Now.AddMinutes(-10), alert.LastFiredUtc); // unchanged
    }

    [Fact]
    public async Task DisabledAlertIsNeverEvaluated()
    {
        var id = AddAlert(a => a.Enabled = false);
        _executor.Rows = [[500m]];

        await _evaluator.RunOnceAsync(CancellationToken.None);

        Assert.Empty(_emails.Sent);
        Assert.Equal(0, _executor.Count);
        Assert.Null(Reload<AlertRecord>(id).LastEvaluatedUtc);
    }

    [Fact]
    public async Task RowFilterDenialFailsClosedWithoutFiring()
    {
        var id = AddAlert(a => a.OwnerUserId = "denied");
        _executor.Rows = [[500m]];

        await _evaluator.RunOnceAsync(CancellationToken.None);

        Assert.Empty(_emails.Sent);
        Assert.Equal(0, _executor.Count); // denial aborts before execution
        var alert = Reload<AlertRecord>(id);
        Assert.Equal(Now, alert.LastEvaluatedUtc);
        Assert.Null(alert.LastValue);
        Assert.Null(alert.LastFiredUtc);
    }

    [Fact]
    public async Task EmailFailureIsLoggedAndFiringRetriesNextTime()
    {
        var id = AddAlert();
        _executor.Rows = [[500m]];
        _emails.FailNext = true;

        await _evaluator.RunOnceAsync(CancellationToken.None);

        var alert = Reload<AlertRecord>(id);
        Assert.Equal(Now, alert.LastEvaluatedUtc);
        Assert.Null(alert.LastFiredUtc); // not recorded, so the next pass may retry
    }

    // ------------------------------------------------------------------ helpers

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class FakeExecutor : IQueryExecutor
    {
        public IReadOnlyList<object?[]> Rows { get; set; } = [[0m]];

        public CompiledQuery? LastQuery { get; private set; }

        public int Count { get; private set; }

        public Task<ExecutedQuery> ExecuteAsync(
            CompiledQuery query, ExecutionOptions options, CancellationToken cancellationToken)
        {
            LastQuery = query;
            Count++;
            return Task.FromResult(new ExecutedQuery(Rows, Truncated: false, ElapsedMs: 1));
        }
    }

    private sealed class RecordingEmailSink : IRcdEmailSender
    {
        public List<RcdEmailMessage> Sent { get; } = [];

        public bool FailNext { get; set; }

        public Task SendAsync(RcdEmailMessage message, CancellationToken cancellationToken)
        {
            if (FailNext)
            {
                FailNext = false;
                throw new InvalidOperationException("Simulated SMTP outage.");
            }

            Sent.Add(message);
            return Task.CompletedTask;
        }
    }

    /// <summary>Alice is scoped to West customers; "denied" is denied everywhere (fail closed).</summary>
    private sealed class TestRowFilterContributor : IRowFilterContributor
    {
        public Task<RowFilterDecision> GetFiltersAsync(RowFilterContext context, CancellationToken cancellationToken)
        {
            if (context.UserId == "denied")
            {
                return Task.FromResult(RowFilterDecision.DenyAccess());
            }

            if (context is { UserId: "alice", Schema: "public", Table: "customers" })
            {
                return Task.FromResult(RowFilterDecision.Filter(
                    new RowFilter("region", RowFilterOperator.Equals, ["West"])));
            }

            return Task.FromResult(RowFilterDecision.Allow);
        }
    }
}
