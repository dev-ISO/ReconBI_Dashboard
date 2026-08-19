using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// Subscriptions + alerts API over the real demo host: auth matrix (anonymous
/// vs viewer vs owner vs admin), dashboard-visibility enforcement on create,
/// alert spec validation, the test-evaluation endpoint, and recent-firings
/// visibility.
/// </summary>
public sealed class SchedulingApiTests : IClassFixture<DemoApiFactory>
{
    private const string Models = "/api/rcd/v1/models";
    private const string Dashboards = "/api/rcd/v1/dashboards";
    private const string Subscriptions = "/api/rcd/v1/subscriptions";
    private const string Alerts = "/api/rcd/v1/alerts";

    private readonly DemoApiFactory _factory;

    public SchedulingApiTests(DemoApiFactory factory)
    {
        _factory = factory;
        _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
    }

    // ---------- anonymous ----------

    [Fact]
    public async Task Anonymous_AllSchedulingEndpoints_Return401()
    {
        var client = _factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Subscriptions)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(Subscriptions, new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Alerts)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync($"{Alerts}/recent-firings")).StatusCode);
    }

    // ---------- subscriptions ----------

    [Fact]
    public async Task ViewerCanSubscribeToSharedDashboard_AndOnlySeesOwnSubscriptions()
    {
        var carol = _factory.AsUser("carol");
        var bob = _factory.AsUser("bob");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);

        var created = await bob.PostAsJsonAsync(Subscriptions, SubscriptionBody(dashboardId));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var body = await ReadJsonAsync(created);
        Assert.Equal("interval", body["scheduleKind"]!.GetValue<string>());
        Assert.Equal(30, body["intervalMinutes"]!.GetValue<int>());
        Assert.True(body["ownerIsMe"]!.GetValue<bool>());
        var id = body["id"]!.GetValue<int>();

        var mine = (await ReadJsonAsync(await bob.GetAsync($"{Subscriptions}?dashboardId={dashboardId}"))).AsArray();
        Assert.Contains(mine, s => s!["id"]!.GetValue<int>() == id);

        // Carol's list does NOT include bob's subscription (list is "mine").
        var carols = (await ReadJsonAsync(await carol.GetAsync(Subscriptions))).AsArray();
        Assert.DoesNotContain(carols, s => s!["id"]!.GetValue<int>() == id);
    }

    [Fact]
    public async Task ViewerCannotSubscribeToDashboardTheyCannotRead()
    {
        var carol = _factory.AsUser("carol");
        var bob = _factory.AsUser("bob");
        var privateDashboard = await CreateDashboardAsync(carol, isShared: false);

        var created = await bob.PostAsJsonAsync(Subscriptions, SubscriptionBody(privateDashboard));

        Assert.Equal(HttpStatusCode.NotFound, created.StatusCode);
        Assert.Equal("rcd.dashboard.not_found", (await ReadJsonAsync(created))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task SubscriptionMutations_OwnerOrAdminOnly()
    {
        var carol = _factory.AsUser("carol");
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);

        var id = (await ReadJsonAsync(await bob.PostAsJsonAsync(Subscriptions, SubscriptionBody(dashboardId))))["id"]!.GetValue<int>();

        var update = SubscriptionBody(dashboardId, name: "Renamed", scheduleKind: "daily", timeOfDayLocal: "09:30");

        // Another non-admin user: invisible (404).
        Assert.Equal(HttpStatusCode.NotFound, (await alice.PutAsJsonAsync($"{Subscriptions}/{id}", update)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await alice.DeleteAsync($"{Subscriptions}/{id}")).StatusCode);

        // Admin may edit and delete.
        var adminUpdate = await carol.PutAsJsonAsync($"{Subscriptions}/{id}", update);
        Assert.Equal(HttpStatusCode.OK, adminUpdate.StatusCode);
        var updated = await ReadJsonAsync(adminUpdate);
        Assert.Equal("daily", updated["scheduleKind"]!.GetValue<string>());
        Assert.Equal("09:30", updated["timeOfDayLocal"]!.GetValue<string>());
        Assert.False(updated["ownerIsMe"]!.GetValue<bool>()); // still bob's

        // Owner deletes.
        Assert.Equal(HttpStatusCode.NoContent, (await bob.DeleteAsync($"{Subscriptions}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bob.DeleteAsync($"{Subscriptions}/{id}")).StatusCode);
    }

    [Theory]
    [InlineData("interval", 1, null, null)] // below the 5-minute floor
    [InlineData("interval", null, null, null)] // interval without minutes
    [InlineData("daily", null, null, null)] // daily without a time
    [InlineData("daily", null, "25:00", null)] // unparseable time
    [InlineData("weekly", null, "09:00", null)] // weekly without a day
    [InlineData("weekly", null, "09:00", 9)] // day out of range
    public async Task InvalidSchedules_Return400(
        string kind, int? intervalMinutes, string? timeOfDayLocal, int? dayOfWeek)
    {
        var carol = _factory.AsUser("carol");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);

        var response = await carol.PostAsJsonAsync(Subscriptions, new
        {
            dashboardId,
            name = UniqueName("Bad schedule"),
            scheduleKind = kind,
            intervalMinutes,
            timeOfDayLocal,
            dayOfWeek,
            recipients = "ops@example.com",
            format = "html",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("rcd.subscription.bad_schedule", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task SubscriptionWithoutRecipients_Returns400()
    {
        var carol = _factory.AsUser("carol");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);

        var response = await carol.PostAsJsonAsync(
            Subscriptions, SubscriptionBody(dashboardId, recipients: " ; "));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("rcd.subscription.recipients_required", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    // ---------- alerts ----------

    [Fact]
    public async Task AlertSpecMustBeSingleValue()
    {
        var carol = _factory.AsUser("carol");
        var modelId = await CreateModelAsync(carol, isShared: true);

        // A dimension makes it multi-row: rejected.
        var withDimension = await carol.PostAsJsonAsync(Alerts, AlertBody(modelId, spec: new
        {
            modelId,
            dimensions = new object[] { new { table = "public.customers", column = "region" } },
            measures = new object[] { new { table = "public.orders", column = "order_total", aggregation = "sum" } },
            filters = Array.Empty<object>(),
            sort = Array.Empty<object>(),
        }));
        Assert.Equal(HttpStatusCode.BadRequest, withDimension.StatusCode);
        Assert.Equal("rcd.alert.bad_spec", (await ReadJsonAsync(withDimension))["errorCode"]!.GetValue<string>());

        // Two measures: rejected.
        var twoMeasures = await carol.PostAsJsonAsync(Alerts, AlertBody(modelId, spec: new
        {
            modelId,
            dimensions = Array.Empty<object>(),
            measures = new object[]
            {
                new { table = "public.orders", column = "order_total", aggregation = "sum" },
                new { table = "public.orders", aggregation = "count" },
            },
            filters = Array.Empty<object>(),
            sort = Array.Empty<object>(),
        }));
        Assert.Equal(HttpStatusCode.BadRequest, twoMeasures.StatusCode);

        // Single measure, no dimensions: accepted.
        var valid = await carol.PostAsJsonAsync(Alerts, AlertBody(modelId));
        Assert.Equal(HttpStatusCode.Created, valid.StatusCode);
        var body = await ReadJsonAsync(valid);
        Assert.Equal("gt", body["operator"]!.GetValue<string>());
        Assert.Equal(300, body["threshold"]!.GetValue<decimal>());
    }

    [Fact]
    public async Task AlertCadenceBelowFiveMinutes_Returns400()
    {
        var carol = _factory.AsUser("carol");
        var modelId = await CreateModelAsync(carol, isShared: true);

        var response = await carol.PostAsJsonAsync(Alerts, AlertBody(modelId, everyMinutes: 1));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("rcd.alert.bad_cadence", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task AlertOnModelInvisibleToCaller_Returns404()
    {
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");
        var privateModel = await CreateModelAsync(alice, isShared: false);

        var response = await bob.PostAsJsonAsync(Alerts, AlertBody(privateModel));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("rcd.model.not_found", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task AlertTestEvaluatesUnderOwnerAndReportsWouldFire()
    {
        var carol = _factory.AsUser("carol");
        var modelId = await CreateModelAsync(carol, isShared: true);
        var id = (await ReadJsonAsync(await carol.PostAsJsonAsync(Alerts, AlertBody(modelId))))["id"]!.GetValue<int>();

        try
        {
            _factory.Executor.Rows = [[312]];
            var firing = await ReadJsonAsync(await carol.PostAsync($"{Alerts}/{id}/test", null));
            Assert.Equal(312, firing["value"]!.GetValue<decimal>());
            Assert.True(firing["wouldFire"]!.GetValue<bool>()); // 312 > 300

            _factory.Executor.Rows = [[250]];
            var calm = await ReadJsonAsync(await carol.PostAsync($"{Alerts}/{id}/test", null));
            Assert.Equal(250, calm["value"]!.GetValue<decimal>());
            Assert.False(calm["wouldFire"]!.GetValue<bool>());

            // Another user cannot probe someone else's alert.
            var bob = _factory.AsUser("bob");
            Assert.Equal(HttpStatusCode.NotFound, (await bob.PostAsync($"{Alerts}/{id}/test", null)).StatusCode);
        }
        finally
        {
            _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        }
    }

    [Fact]
    public async Task AlertMutations_OwnerOrAdminOnly()
    {
        var carol = _factory.AsUser("carol");
        var alice = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(carol, isShared: true);

        var id = (await ReadJsonAsync(await alice.PostAsJsonAsync(Alerts, AlertBody(modelId))))["id"]!.GetValue<int>();
        var bob = _factory.AsUser("bob");

        Assert.Equal(HttpStatusCode.NotFound,
            (await bob.PutAsJsonAsync($"{Alerts}/{id}", AlertBody(modelId, name: "Hijack"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bob.DeleteAsync($"{Alerts}/{id}")).StatusCode);

        // Admin can edit; owner can delete.
        Assert.Equal(HttpStatusCode.OK,
            (await carol.PutAsJsonAsync($"{Alerts}/{id}", AlertBody(modelId, name: "Tuned"))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await alice.DeleteAsync($"{Alerts}/{id}")).StatusCode);
    }

    [Fact]
    public async Task RecentFirings_VisibleForDashboardsTheCallerCanView()
    {
        var carol = _factory.AsUser("carol");
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");

        var sharedModel = await CreateModelAsync(carol, isShared: true);
        var sharedDashboard = await CreateDashboardAsync(carol, isShared: true);
        var privateDashboard = await CreateDashboardAsync(alice, isShared: false);

        var sharedAlertId = (await ReadJsonAsync(await carol.PostAsJsonAsync(
            Alerts, AlertBody(sharedModel, dashboardId: sharedDashboard, name: UniqueName("Shared firing"))))) ["id"]!.GetValue<int>();
        var privateAlertId = (await ReadJsonAsync(await alice.PostAsJsonAsync(
            Alerts, AlertBody(sharedModel, dashboardId: privateDashboard, name: UniqueName("Private firing"))))) ["id"]!.GetValue<int>();

        // Mark both as fired just now, directly in storage.
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
            var now = DateTime.UtcNow;
            foreach (var alert in await db.Alerts
                         .Where(a => a.Id == sharedAlertId || a.Id == privateAlertId).ToListAsync())
            {
                alert.LastFiredUtc = now;
                alert.LastValue = 999m;
            }

            await db.SaveChangesAsync();
        }

        // Bob sees the shared-dashboard firing but not alice's private one.
        var bobSees = (await ReadJsonAsync(await bob.GetAsync($"{Alerts}/recent-firings"))).AsArray();
        Assert.Contains(bobSees, f => f!["alertId"]!.GetValue<int>() == sharedAlertId);
        Assert.DoesNotContain(bobSees, f => f!["alertId"]!.GetValue<int>() == privateAlertId);

        // Filtered by dashboard id.
        var filtered = (await ReadJsonAsync(await bob.GetAsync($"{Alerts}/recent-firings?dashboardId={sharedDashboard}"))).AsArray();
        Assert.All(filtered, f => Assert.Equal(sharedDashboard, f!["dashboardId"]!.GetValue<int>()));
        Assert.Contains(filtered, f => f!["alertId"]!.GetValue<int>() == sharedAlertId);

        // Alice sees her own alert's firing even though the dashboard is private.
        var aliceSees = (await ReadJsonAsync(await alice.GetAsync($"{Alerts}/recent-firings"))).AsArray();
        Assert.Contains(aliceSees, f => f!["alertId"]!.GetValue<int>() == privateAlertId);
    }

    // ---------- helpers ----------

    private static string UniqueName(string prefix) => $"{prefix} {Guid.NewGuid():N}";

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return JsonNode.Parse(body) ?? throw new InvalidOperationException("Response body was empty.");
    }

    private async Task<int> CreateModelAsync(HttpClient client, bool isShared)
    {
        var response = await client.PostAsJsonAsync(Models, new
        {
            name = UniqueName("Scheduling Model"),
            description = (string?)null,
            dataSourceName = "demo",
            definition = new
            {
                version = 1,
                tables = new object[]
                {
                    new { schema = "public", name = "customers" },
                    new { schema = "public", name = "orders" },
                },
                relationships = new object[]
                {
                    new
                    {
                        id = Guid.NewGuid(),
                        fromTable = "public.orders",
                        fromColumn = "customer_id",
                        toTable = "public.customers",
                        toColumn = "id",
                        cardinality = "manyToOne",
                        isActive = true,
                        source = "fk",
                    },
                },
                measures = Array.Empty<object>(),
            },
            isShared,
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    private async Task<int> CreateDashboardAsync(HttpClient client, bool isShared)
    {
        var response = await client.PostAsJsonAsync(Dashboards, new
        {
            name = UniqueName("Scheduling Dashboard"),
            description = (string?)null,
            modelId = (int?)null,
            layout = new { tiles = Array.Empty<object>() },
            isShared,
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    private static object SubscriptionBody(
        int dashboardId,
        string? name = null,
        string scheduleKind = "interval",
        string? timeOfDayLocal = null,
        string recipients = "ops@example.com") => new
        {
            dashboardId,
            name = name ?? UniqueName("Snapshot"),
            scheduleKind,
            intervalMinutes = scheduleKind == "interval" ? 30 : (int?)null,
            timeOfDayLocal,
            dayOfWeek = (int?)null,
            recipients,
            format = "html",
            enabled = true,
        };

    private static object AlertBody(
        int modelId,
        object? spec = null,
        int? dashboardId = null,
        string? name = null,
        int everyMinutes = 10) => new
        {
            name = name ?? UniqueName("Alert"),
            dashboardId,
            spec = spec ?? new
            {
                modelId,
                dimensions = Array.Empty<object>(),
                measures = new object[] { new { table = "public.orders", column = "order_total", aggregation = "sum" } },
                filters = Array.Empty<object>(),
                sort = Array.Empty<object>(),
            },
            @operator = "gt",
            threshold = 300,
            recipients = "ops@example.com",
            everyMinutes,
            cooldownMinutes = 30,
            enabled = true,
        };
}
