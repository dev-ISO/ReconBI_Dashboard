using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// The 0.11.0 management surface over the real demo host: scope=mine/all
/// authorization, one-click enabled, send-now (202 + dispatch id + the
/// one-concurrent-manual-send 429 guard), dispatch history with per-recipient
/// rows, per-subscription and GLOBAL opt-outs, the anonymous token-secured
/// unsubscribe page (both scopes) and open pixel, and /meta's canManageShared.
/// Carol is the demo Admin (CanManageShared); alice and bob are not.
/// </summary>
public sealed class SubscriptionsManagementApiTests : IClassFixture<DemoApiFactory>
{
    private const string Models = "/api/rcd/v1/models";
    private const string Dashboards = "/api/rcd/v1/dashboards";
    private const string Subscriptions = "/api/rcd/v1/subscriptions";
    private const string Alerts = "/api/rcd/v1/alerts";
    private const string Secret = "api-test-unsubscribe-secret";

    private readonly DemoApiFactory _factory;

    public SubscriptionsManagementApiTests(DemoApiFactory factory)
    {
        _factory = factory;
        _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        _factory.Emails.ReleaseSends();

        // The options POCO is a singleton the services read live — setting the
        // secret here stands in for the host's RCD_UNSUBSCRIBE_SECRET env var.
        var options = _factory.Services.GetRequiredService<ReconDashboardsOptions>();
        options.UnsubscribeSecret = Secret;
        options.PublicBaseUrl = "https://tunnel.example.com";
    }

    // -------------------------------------------------------------- anonymous

    [Fact]
    public async Task Anonymous_ManagementEndpoints_Return401_ButTokenEndpointsDoNot()
    {
        var client = _factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync($"{Subscriptions}?scope=all")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync($"{Subscriptions}/1/enabled", new { enabled = false })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync($"{Subscriptions}/1/send-now", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync($"{Subscriptions}/1/dispatches")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync($"{Subscriptions}/1/optouts")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync($"{Subscriptions}/optouts/global")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.DeleteAsync($"{Subscriptions}/optouts/global/x%40y.z")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync($"{Alerts}/1/enabled", new { enabled = false })).StatusCode);

        // The two token-secured endpoints are anonymous BY DESIGN: a bad token
        // is a 404 page (not 401), and the pixel always serves the GIF.
        var page = await client.GetAsync($"{Subscriptions}/unsubscribe?token=garbage");
        Assert.Equal(HttpStatusCode.NotFound, page.StatusCode);
        Assert.Contains("no longer valid", await page.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        var pixel = await client.GetAsync($"{Subscriptions}/open?token=garbage");
        Assert.Equal(HttpStatusCode.OK, pixel.StatusCode);
        Assert.Equal("image/gif", pixel.Content.Headers.ContentType!.MediaType);
    }

    // ------------------------------------------------------------- scope=all

    [Fact]
    public async Task ScopeAll_IsAdminOnly_AndDecoratesOwners()
    {
        var carol = _factory.AsUser("carol");
        var bob = _factory.AsUser("bob");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);
        var subId = await CreateSubscriptionAsync(bob, dashboardId);

        var forbidden = await bob.GetAsync($"{Subscriptions}?scope=all");
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        Assert.Equal(
            "rcd.subscription.admin_required",
            (await ReadJsonAsync(forbidden))["errorCode"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.GetAsync($"{Alerts}?scope=all")).StatusCode);

        var all = (await ReadJsonAsync(await carol.GetAsync($"{Subscriptions}?scope=all"))).AsArray();
        var row = all.Single(s => s!["id"]!.GetValue<int>() == subId)!;
        Assert.False(row["ownerIsMe"]!.GetValue<bool>());
        Assert.False(string.IsNullOrEmpty(row["ownerUserId"]!.GetValue<string>()));
        // The demo host registers an IUserDirectory, so the display name resolves.
        Assert.False(string.IsNullOrEmpty(row["ownerDisplayName"]!.GetValue<string>()));
    }

    // ------------------------------------------------------------ set-enabled

    [Fact]
    public async Task SetEnabled_IsOneClick_OwnerOrAdminOnly()
    {
        var carol = _factory.AsUser("carol");
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);
        var subId = await CreateSubscriptionAsync(bob, dashboardId);

        // Another non-admin: invisible.
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await alice.PostAsJsonAsync($"{Subscriptions}/{subId}/enabled", new { enabled = true })).StatusCode);

        // Admin resumes it; the response carries the new state.
        var resumed = await carol.PostAsJsonAsync($"{Subscriptions}/{subId}/enabled", new { enabled = true });
        Assert.Equal(HttpStatusCode.OK, resumed.StatusCode);
        Assert.True((await ReadJsonAsync(resumed))["enabled"]!.GetValue<bool>());

        // Owner pauses it again.
        var paused = await bob.PostAsJsonAsync($"{Subscriptions}/{subId}/enabled", new { enabled = false });
        Assert.Equal(HttpStatusCode.OK, paused.StatusCode);
        Assert.False((await ReadJsonAsync(paused))["enabled"]!.GetValue<bool>());
    }

    [Fact]
    public async Task AlertSetEnabled_OwnerOrAdminOnly()
    {
        var carol = _factory.AsUser("carol");
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");
        var modelId = await CreateModelAsync(carol, isShared: true);
        var alertId = (await ReadJsonAsync(await bob.PostAsJsonAsync(Alerts, AlertBody(modelId))))["id"]!.GetValue<int>();

        Assert.Equal(
            HttpStatusCode.NotFound,
            (await alice.PostAsJsonAsync($"{Alerts}/{alertId}/enabled", new { enabled = false })).StatusCode);

        var paused = await carol.PostAsJsonAsync($"{Alerts}/{alertId}/enabled", new { enabled = false });
        Assert.Equal(HttpStatusCode.OK, paused.StatusCode);
        Assert.False((await ReadJsonAsync(paused))["enabled"]!.GetValue<bool>());
    }

    // ---------------------------------------------------------------- send-now

    [Fact]
    public async Task SendNow_DispatchesPerRecipient_RecordsHistory_AndFeedsTheBadge()
    {
        var alice = _factory.AsUser("alice"); // author: owns the model/dashboard she subscribes to
        var modelId = await CreateModelAsync(alice, isShared: false);
        var dashboardId = await CreateDashboardAsync(alice, isShared: false, modelId);
        var recipientA = UniqueEmail("ops");
        var recipientB = UniqueEmail("boss");
        var subId = await CreateSubscriptionAsync(alice, dashboardId, $"{recipientA};{recipientB}");

        var accepted = await alice.PostAsync($"{Subscriptions}/{subId}/send-now", null);
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        var dispatchId = (await ReadJsonAsync(accepted))["dispatchId"]!.GetValue<long>();

        var dispatch = await WaitForClosedDispatchAsync(alice, subId, dispatchId);
        Assert.Equal("sent", dispatch["status"]!.GetValue<string>());
        Assert.Equal("manual", dispatch["trigger"]!.GetValue<string>());
        Assert.False(string.IsNullOrEmpty(dispatch["requestedBy"]!.GetValue<string>()));
        var recipients = dispatch["recipients"]!.AsArray();
        Assert.Equal(2, recipients.Count);
        Assert.All(recipients, r =>
        {
            Assert.Equal("sent", r!["status"]!.GetValue<string>());
            Assert.Equal(1, r["attempts"]!.GetValue<int>());
        });

        // Each recipient got their own personalized email with footer + pixel.
        var mine = _factory.Emails.Sent
            .Where(m => m.Recipients.Any(r => r == recipientA || r == recipientB))
            .ToList();
        Assert.Equal(2, mine.Count);
        Assert.All(mine, m =>
        {
            Assert.Single(m.Recipients);
            Assert.Contains("/subscriptions/unsubscribe?token=", m.HtmlBody, StringComparison.Ordinal);
            Assert.Contains("/subscriptions/open?token=", m.HtmlBody, StringComparison.Ordinal);
        });

        // The list row's Last-delivery badge data is populated.
        var list = (await ReadJsonAsync(await alice.GetAsync(Subscriptions))).AsArray();
        var lastDispatch = list.Single(s => s!["id"]!.GetValue<int>() == subId)!["lastDispatch"]!;
        Assert.Equal("sent", lastDispatch["status"]!.GetValue<string>());
        Assert.Equal(2, lastDispatch["sentCount"]!.GetValue<int>());
    }

    [Fact]
    public async Task SendNow_SecondConcurrentRequestGets429()
    {
        var alice = _factory.AsUser("alice"); // author: owns the model/dashboard she subscribes to
        var modelId = await CreateModelAsync(alice, isShared: false);
        var dashboardId = await CreateDashboardAsync(alice, isShared: false, modelId);
        var subId = await CreateSubscriptionAsync(alice, dashboardId, UniqueEmail("gated"));

        _factory.Emails.HoldSends(); // dam the sink: the dispatch cannot close
        try
        {
            var first = await alice.PostAsync($"{Subscriptions}/{subId}/send-now", null);
            Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);

            var second = await alice.PostAsync($"{Subscriptions}/{subId}/send-now", null);
            Assert.Equal(HttpStatusCode.TooManyRequests, second.StatusCode);
            Assert.Equal(
                "rcd.subscription.send_in_progress",
                (await ReadJsonAsync(second))["errorCode"]!.GetValue<string>());
        }
        finally
        {
            _factory.Emails.ReleaseSends();
        }

        var dispatchId = (await ReadJsonAsync(
            await alice.GetAsync($"{Subscriptions}/{subId}/dispatches?limit=1"))).AsArray()[0]!["id"]!.GetValue<long>();
        var closed = await WaitForClosedDispatchAsync(alice, subId, dispatchId);
        Assert.Equal("sent", closed["status"]!.GetValue<string>());

        // Guard released after close: a fresh send is accepted again.
        var third = await alice.PostAsync($"{Subscriptions}/{subId}/send-now", null);
        Assert.Equal(HttpStatusCode.Accepted, third.StatusCode);
        await WaitForClosedDispatchAsync(alice, subId, (await ReadJsonAsync(third))["dispatchId"]!.GetValue<long>());
    }

    [Fact]
    public async Task Dispatches_And_OptOuts_AreOwnerOrAdminOnly()
    {
        var carol = _factory.AsUser("carol");
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);
        var subId = await CreateSubscriptionAsync(bob, dashboardId);

        Assert.Equal(HttpStatusCode.NotFound, (await alice.GetAsync($"{Subscriptions}/{subId}/dispatches")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await alice.GetAsync($"{Subscriptions}/{subId}/optouts")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await carol.GetAsync($"{Subscriptions}/{subId}/dispatches")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await carol.GetAsync($"{Subscriptions}/{subId}/optouts")).StatusCode);
    }

    // ------------------------------------------------- unsubscribe (both scopes)

    [Fact]
    public async Task UnsubscribeToken_RendersConfirmPage_AndRecordsPerSubscriptionOptOut()
    {
        var bob = _factory.AsUser("bob");
        var carol = _factory.AsUser("carol");
        var modelId = await CreateModelAsync(carol, isShared: true);
        var dashboardId = await CreateDashboardAsync(carol, isShared: true, modelId);
        var email = UniqueEmail("optout");
        var subId = await CreateSubscriptionAsync(bob, dashboardId, email);

        var anonymous = _factory.CreateClient();
        var token = Uri.EscapeDataString(RcdSignedTokens.CreateUnsubscribeToken(Secret, subId, email));

        // GET: the confirm page offers BOTH scopes.
        var page = await anonymous.GetAsync($"{Subscriptions}/unsubscribe?token={token}");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("Unsubscribe from", html, StringComparison.Ordinal);
        Assert.Contains("ALL dashboard emails", html, StringComparison.Ordinal);
        Assert.Contains(email, html, StringComparison.OrdinalIgnoreCase);

        // POST scope=one records the per-subscription opt-out.
        var confirm = await anonymous.PostAsync(
            $"{Subscriptions}/unsubscribe?token={token}",
            new FormUrlEncodedContent([new KeyValuePair<string, string>("scope", "one")]));
        Assert.Equal(HttpStatusCode.OK, confirm.StatusCode);
        Assert.Contains("unsubscribed", await confirm.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        var optOuts = (await ReadJsonAsync(await bob.GetAsync($"{Subscriptions}/{subId}/optouts"))).AsArray();
        Assert.Contains(optOuts, o => o!["email"]!.GetValue<string>() == email.ToLowerInvariant());

        // Opted-out recipients are recorded, never attempted, on the next send.
        var accepted = await bob.PostAsync($"{Subscriptions}/{subId}/send-now", null);
        var dispatchId = (await ReadJsonAsync(accepted))["dispatchId"]!.GetValue<long>();
        var dispatch = await WaitForClosedDispatchAsync(bob, subId, dispatchId);
        Assert.Equal("skipped", dispatch["status"]!.GetValue<string>()); // sole recipient opted out
        var recipient = Assert.Single(dispatch["recipients"]!.AsArray());
        Assert.Equal("optedOut", recipient!["status"]!.GetValue<string>());
        Assert.Equal(0, recipient["attempts"]!.GetValue<int>());
        Assert.DoesNotContain(_factory.Emails.Sent, m => m.Recipients.Contains(email));

        // Owner clears the opt-out (re-invite) — idempotent delete.
        Assert.Equal(
            HttpStatusCode.NoContent,
            (await bob.DeleteAsync($"{Subscriptions}/{subId}/optouts/{Uri.EscapeDataString(email)}")).StatusCode);
        var cleared = (await ReadJsonAsync(await bob.GetAsync($"{Subscriptions}/{subId}/optouts"))).AsArray();
        Assert.DoesNotContain(cleared, o => o!["email"]!.GetValue<string>() == email.ToLowerInvariant());
    }

    [Fact]
    public async Task GlobalUnsubscribe_SuppressesEverySubscription_AndIsAdminManaged()
    {
        var bob = _factory.AsUser("bob");
        var carol = _factory.AsUser("carol");
        var modelId = await CreateModelAsync(carol, isShared: true);
        var dashboardId = await CreateDashboardAsync(carol, isShared: true, modelId);
        var email = UniqueEmail("global");
        var subId = await CreateSubscriptionAsync(bob, dashboardId, email);

        var anonymous = _factory.CreateClient();
        var token = Uri.EscapeDataString(RcdSignedTokens.CreateUnsubscribeToken(Secret, subId, email));
        var confirm = await anonymous.PostAsync(
            $"{Subscriptions}/unsubscribe?token={token}",
            new FormUrlEncodedContent([new KeyValuePair<string, string>("scope", "all")]));
        Assert.Equal(HttpStatusCode.OK, confirm.StatusCode);

        // Global suppression hits a DIFFERENT subscription of a DIFFERENT owner.
        var carolsSub = await CreateSubscriptionAsync(carol, dashboardId, email);
        var accepted = await carol.PostAsync($"{Subscriptions}/{carolsSub}/send-now", null);
        var dispatch = await WaitForClosedDispatchAsync(
            carol, carolsSub, (await ReadJsonAsync(accepted))["dispatchId"]!.GetValue<long>());
        Assert.Equal("optedOut", dispatch["recipients"]!.AsArray()[0]!["status"]!.GetValue<string>());

        // Viewing/clearing global suppressions is admin-only.
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.GetAsync($"{Subscriptions}/optouts/global")).StatusCode);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await bob.DeleteAsync($"{Subscriptions}/optouts/global/{Uri.EscapeDataString(email)}")).StatusCode);

        var globals = (await ReadJsonAsync(await carol.GetAsync($"{Subscriptions}/optouts/global"))).AsArray();
        Assert.Contains(globals, o => o!["email"]!.GetValue<string>() == email.ToLowerInvariant());
        Assert.Equal(
            HttpStatusCode.NoContent,
            (await carol.DeleteAsync($"{Subscriptions}/optouts/global/{Uri.EscapeDataString(email)}")).StatusCode);
        var remaining = (await ReadJsonAsync(await carol.GetAsync($"{Subscriptions}/optouts/global"))).AsArray();
        Assert.DoesNotContain(remaining, o => o!["email"]!.GetValue<string>() == email.ToLowerInvariant());
    }

    [Fact]
    public async Task TamperedUnsubscribeToken_IsA404Page()
    {
        var bob = _factory.AsUser("bob");
        var carol = _factory.AsUser("carol");
        var dashboardId = await CreateDashboardAsync(carol, isShared: true);
        var subId = await CreateSubscriptionAsync(bob, dashboardId);

        var genuine = RcdSignedTokens.CreateUnsubscribeToken(Secret, subId, "a@example.com");
        var forgedPayload = RcdSignedTokens.CreateUnsubscribeToken(Secret, subId + 1, "a@example.com").Split('.')[0];
        var tampered = Uri.EscapeDataString(forgedPayload + "." + genuine.Split('.')[1]);

        var anonymous = _factory.CreateClient();
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await anonymous.GetAsync($"{Subscriptions}/unsubscribe?token={tampered}")).StatusCode);
        var post = await anonymous.PostAsync(
            $"{Subscriptions}/unsubscribe?token={tampered}",
            new FormUrlEncodedContent([new KeyValuePair<string, string>("scope", "one")]));
        Assert.Equal(HttpStatusCode.NotFound, post.StatusCode);

        // Nothing was written.
        var optOuts = (await ReadJsonAsync(await bob.GetAsync($"{Subscriptions}/{subId}/optouts"))).AsArray();
        Assert.Empty(optOuts);
    }

    // -------------------------------------------------------------- open pixel

    [Fact]
    public async Task OpenPixel_StampsFirstOpenAndCountsRepeats()
    {
        var alice = _factory.AsUser("alice"); // author: owns the model/dashboard she subscribes to
        var modelId = await CreateModelAsync(alice, isShared: false);
        var dashboardId = await CreateDashboardAsync(alice, isShared: false, modelId);
        var subId = await CreateSubscriptionAsync(alice, dashboardId, UniqueEmail("pixel"));

        var accepted = await alice.PostAsync($"{Subscriptions}/{subId}/send-now", null);
        var dispatchId = (await ReadJsonAsync(accepted))["dispatchId"]!.GetValue<long>();
        var dispatch = await WaitForClosedDispatchAsync(alice, subId, dispatchId);
        var recipientId = dispatch["recipients"]!.AsArray()[0]!["id"]!.GetValue<long>();

        var token = Uri.EscapeDataString(RcdSignedTokens.CreateOpenToken(Secret, recipientId));
        var anonymous = _factory.CreateClient();

        var first = await anonymous.GetAsync($"{Subscriptions}/open?token={token}");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal("image/gif", first.Content.Headers.ContentType!.MediaType);
        var second = await anonymous.GetAsync($"{Subscriptions}/open?token={token}");
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        var refreshed = (await ReadJsonAsync(
            await alice.GetAsync($"{Subscriptions}/{subId}/dispatches?limit=1"))).AsArray()[0]!;
        var recipient = refreshed["recipients"]!.AsArray()[0]!;
        Assert.False(string.IsNullOrEmpty(recipient["openedUtc"]!.GetValue<string>()));
        Assert.Equal(2, recipient["openCount"]!.GetValue<int>());
    }

    // ------------------------------------------------------------------- meta

    [Fact]
    public async Task Meta_ReportsTheCallersManageSharedStanding()
    {
        var bob = _factory.AsUser("bob");
        var carol = _factory.AsUser("carol");

        Assert.False((await ReadJsonAsync(await bob.GetAsync("/api/rcd/v1/meta")))["canManageShared"]!.GetValue<bool>());
        Assert.True((await ReadJsonAsync(await carol.GetAsync("/api/rcd/v1/meta")))["canManageShared"]!.GetValue<bool>());
    }

    // ---------------------------------------------------------------- helpers

    private static string UniqueName(string prefix) => $"{prefix} {Guid.NewGuid():N}";

    private static string UniqueEmail(string prefix) => $"{prefix}-{Guid.NewGuid():N}@example.com";

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return JsonNode.Parse(body) ?? throw new InvalidOperationException("Response body was empty.");
    }

    /// <summary>Polls the history endpoint until the dispatch closes (send-now bodies run detached).</summary>
    private async Task<JsonNode> WaitForClosedDispatchAsync(HttpClient client, int subscriptionId, long dispatchId)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            var dispatches = (await ReadJsonAsync(
                await client.GetAsync($"{Subscriptions}/{subscriptionId}/dispatches?limit=20"))).AsArray();
            var dispatch = dispatches.FirstOrDefault(d => d!["id"]!.GetValue<long>() == dispatchId);
            if (dispatch is not null && dispatch["status"]!.GetValue<string>() != "running")
            {
                return dispatch;
            }

            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(15), "Timed out waiting for the dispatch to close.");
            await Task.Delay(50);
        }
    }

    private async Task<int> CreateSubscriptionAsync(
        HttpClient client, int dashboardId, string recipients = "ops@example.com")
    {
        // enabled=false keeps the demo host's 1-minute scheduler from racing
        // these tests with its own dispatches; send-now works on paused
        // subscriptions by design ("send it now" is an explicit human act).
        var response = await client.PostAsJsonAsync(Subscriptions, new
        {
            dashboardId,
            name = UniqueName("Managed"),
            scheduleKind = "interval",
            intervalMinutes = 30,
            timeOfDayLocal = (string?)null,
            dayOfWeek = (int?)null,
            recipients,
            format = "html",
            enabled = false,
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    private async Task<int> CreateModelAsync(HttpClient client, bool isShared)
    {
        var response = await client.PostAsJsonAsync(Models, new
        {
            name = UniqueName("Mgmt Model"),
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

    private async Task<int> CreateDashboardAsync(HttpClient client, bool isShared, int? modelId = null)
    {
        var response = await client.PostAsJsonAsync(Dashboards, new
        {
            name = UniqueName("Mgmt Dashboard"),
            description = (string?)null,
            modelId,
            layout = new { tiles = Array.Empty<object>() },
            isShared,
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    private static object AlertBody(int modelId) => new
    {
        dashboardId = (int?)null,
        name = UniqueName("Mgmt Alert"),
        spec = new
        {
            modelId,
            dimensions = Array.Empty<object>(),
            measures = new object[]
            {
                new { table = "public.orders", column = "order_total", aggregation = "sum" },
            },
            filters = Array.Empty<object>(),
            sort = Array.Empty<object>(),
        },
        @operator = "gt",
        threshold = 100,
        recipients = "ops@example.com",
        everyMinutes = 5,
        cooldownMinutes = 60,
        enabled = true,
    };
}
