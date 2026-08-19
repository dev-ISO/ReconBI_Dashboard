using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// The 0.14 email-content surface over the real demo host: the wire "content"
/// object on save/list, its validation rules, and the two preview endpoints —
/// including the guarantee a preview is worth having, that it renders under the
/// SUBSCRIPTION OWNER's identity and changes nothing at all.
/// Carol is the demo Admin (CanManageShared); alice and bob are not.
/// </summary>
public sealed class SubscriptionContentApiTests : IClassFixture<DemoApiFactory>
{
    private const string Models = "/api/rcd/v1/models";
    private const string Dashboards = "/api/rcd/v1/dashboards";
    private const string Subscriptions = "/api/rcd/v1/subscriptions";

    private readonly DemoApiFactory _factory;

    public SubscriptionContentApiTests(DemoApiFactory factory)
    {
        _factory = factory;
        _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        _factory.Emails.ReleaseSends();
    }

    /// <summary>The exact object the shipped client always sends (never null, never absent).</summary>
    private static object DefaultContent() => new
    {
        body = "charts",
        excludedTileIds = Array.Empty<string>(),
        imageWidth = 600,
        maxTableRows = 50,
    };

    // ------------------------------------------------------------ round-trip

    [Fact]
    public async Task ContentIsPersistedAndMirroredBackOnCreateUpdateAndList()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var created = await ReadJsonAsync(await alice.PostAsJsonAsync(Subscriptions, SaveBody(board.Id, new
        {
            body = "both",
            excludedTileIds = new[] { "t2" },
            imageWidth = 900,
            maxTableRows = 200,
        })));

        var id = created["id"]!.GetValue<int>();
        AssertContent(created["content"]!, "both", ["t2"], 900, 200);

        // The list row carries it too — the manager's editor opens from there.
        var listed = (await ReadJsonAsync(await alice.GetAsync($"{Subscriptions}?dashboardId={board.Id}")))
            .AsArray().Single(s => s!["id"]!.GetValue<int>() == id)!;
        AssertContent(listed["content"]!, "both", ["t2"], 900, 200);

        // An update replaces it wholesale.
        var updated = await ReadJsonAsync(
            await alice.PutAsJsonAsync($"{Subscriptions}/{id}", SaveBody(board.Id, DefaultContent())));
        AssertContent(updated["content"]!, "charts", [], 600, 50);
    }

    [Fact]
    public async Task ALegacySubscriptionReportsNullContentUntilItIsSavedAgain()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        // A pre-0.14 client omits "content" entirely: the row stays legacy.
        var response = await alice.PostAsJsonAsync(Subscriptions, SaveBody(board.Id, content: null));
        var raw = await response.Content.ReadAsStringAsync();
        var created = JsonNode.Parse(raw)!;
        var id = created["id"]!.GetValue<int>();
        // The key is PRESENT and null — the client distinguishes "legacy row"
        // from "field this server does not know about".
        Assert.Null(created["content"]);
        Assert.Contains("\"content\":null", raw, StringComparison.Ordinal);

        // ...and an old client's later update must not wipe a config the new
        // UI set in between — absent content PRESERVES what is stored.
        await alice.PutAsJsonAsync($"{Subscriptions}/{id}", SaveBody(board.Id, DefaultContent()));
        var afterLegacyUpdate = await ReadJsonAsync(
            await alice.PutAsJsonAsync($"{Subscriptions}/{id}", SaveBody(board.Id, content: null)));
        AssertContent(afterLegacyUpdate["content"]!, "charts", [], 600, 50);
    }

    [Fact]
    public async Task MissingSubFieldsTakeTheDocumentedDefaults()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var created = await ReadJsonAsync(
            await alice.PostAsJsonAsync(Subscriptions, SaveBody(board.Id, new { body = "tables" })));

        AssertContent(created["content"]!, "tables", [], 600, 50);
    }

    // ------------------------------------------------------------ validation

    public static TheoryData<object, string> BadContent() => new()
    {
        { new { body = "charts", imageWidth = 640 }, "imageWidth" },
        { new { body = "charts", imageWidth = 0 }, "imageWidth" },
        { new { body = "tables", maxTableRows = 4 }, "maxTableRows" },
        { new { body = "tables", maxTableRows = 501 }, "maxTableRows" },
        { new { body = "tables", excludedTileIds = new[] { new string('x', 101) } }, "excludedTileIds" },
    };

    [Theory]
    [MemberData(nameof(BadContent))]
    public async Task InvalidContentIsRejectedWithAStableErrorCode(object content, string expectedMention)
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var response = await alice.PostAsJsonAsync(Subscriptions, SaveBody(board.Id, content));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await ReadJsonAsync(response);
        Assert.Equal("rcd.subscription.bad_content", body["errorCode"]!.GetValue<string>());
        Assert.Contains(expectedMention, body["detail"]!.GetValue<string>(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task TooManyExcludedTileIdsIsRejected()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var response = await alice.PostAsJsonAsync(Subscriptions, SaveBody(board.Id, new
        {
            body = "charts",
            excludedTileIds = Enumerable.Range(0, 201).Select(i => $"t{i}").ToArray(),
        }));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            "rcd.subscription.bad_content",
            (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task AnUnknownBodyModeIsRejectedBeforeItReachesStorage()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var response = await alice.PostAsJsonAsync(
            Subscriptions, SaveBody(board.Id, new { body = "pdf" }));

        // The enum converter rejects it at the model-binding boundary.
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("tables")]
    [InlineData("charts")]
    [InlineData("both")]
    public async Task EveryValidBodyModeAndImageWidthIsAccepted(string body)
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        foreach (var width in new[] { 480, 600, 900 })
        {
            var response = await alice.PostAsJsonAsync(Subscriptions, SaveBody(board.Id, new
            {
                body,
                excludedTileIds = Array.Empty<string>(),
                imageWidth = width,
                maxTableRows = 50,
            }));
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        }

        foreach (var rows in new[] { 5, 500 })
        {
            var response = await alice.PostAsJsonAsync(Subscriptions, SaveBody(board.Id, new
            {
                body,
                excludedTileIds = Array.Empty<string>(),
                imageWidth = 600,
                maxTableRows = rows,
            }));
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        }
    }

    // ------------------------------------------------------- preview (saved)

    [Fact]
    public async Task PreviewOfASavedSubscriptionRendersTheEmailWithoutSendingIt()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);
        var id = await CreateSubscriptionAsync(alice, board.Id, DefaultContent());

        var before = _factory.Emails.Sent.Count;
        var response = await alice.PostAsJsonAsync($"{Subscriptions}/{id}/preview", new { });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await ReadJsonAsync(response);
        Assert.Equal(board.Subject, body["subject"]!.GetValue<string>());
        var html = body["html"]!.GetValue<string>();
        Assert.Contains("Sales by region", html, StringComparison.Ordinal);
        // Charts mode in a browser iframe: data: URIs, never cid.
        Assert.Contains("data:image/png;base64,", html, StringComparison.Ordinal);
        Assert.DoesNotContain("cid:", html, StringComparison.Ordinal);
        // "iVBORw0KGgo" is base64 for the PNG magic number: the REAL SkiaSharp
        // painter ran here (no fake renderer in this host) and produced a valid
        // image, font fallback and all.
        Assert.Contains("data:image/png;base64,iVBORw0KGgo", html, StringComparison.Ordinal);

        // Nothing was sent, and no dispatch row was written.
        Assert.Equal(before, _factory.Emails.Sent.Count);
        Assert.Empty((await ReadJsonAsync(await alice.GetAsync($"{Subscriptions}/{id}/dispatches"))).AsArray());
    }

    [Fact]
    public async Task PreviewCanOverrideTheSavedConfigWithoutPersistingTheOverride()
    {
        // This is what the edit form does: preview the DRAFT the user is
        // looking at, not the row on disk — and leave the row on disk alone.
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);
        var id = await CreateSubscriptionAsync(alice, board.Id, DefaultContent());

        var overridden = await ReadJsonAsync(await alice.PostAsJsonAsync(
            $"{Subscriptions}/{id}/preview",
            new { content = new { body = "tables", excludedTileIds = Array.Empty<string>(), imageWidth = 600, maxTableRows = 50 } }));
        var html = overridden["html"]!.GetValue<string>();
        Assert.DoesNotContain("data:image/png", html, StringComparison.Ordinal);
        Assert.Contains("<table", html, StringComparison.Ordinal);

        // The stored config is untouched, and a plain {} preview proves it.
        var stored = (await ReadJsonAsync(await alice.GetAsync($"{Subscriptions}?dashboardId={board.Id}")))
            .AsArray().Single(s => s!["id"]!.GetValue<int>() == id)!;
        Assert.Equal("charts", stored["content"]!["body"]!.GetValue<string>());
        Assert.Contains(
            "data:image/png",
            (await ReadJsonAsync(await alice.PostAsJsonAsync($"{Subscriptions}/{id}/preview", new { })))["html"]!.GetValue<string>(),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task PreviewIsOwnerOrAdminOnly()
    {
        var carol = _factory.AsUser("carol"); // admin
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");
        var board = await CreateChartDashboardAsync(carol, isShared: true);
        var id = await CreateSubscriptionAsync(bob, board.Id, DefaultContent());

        // Another non-admin: the subscription is invisible to them, exactly as
        // it is for enabled/send-now/dispatches (a 404, not a 403 — the
        // existence of someone else's subscription is not their business).
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await alice.PostAsJsonAsync($"{Subscriptions}/{id}/preview", new { })).StatusCode);

        // The owner, and an admin acting on someone else's row, both get 200.
        Assert.Equal(
            HttpStatusCode.OK, (await bob.PostAsJsonAsync($"{Subscriptions}/{id}/preview", new { })).StatusCode);
        Assert.Equal(
            HttpStatusCode.OK, (await carol.PostAsJsonAsync($"{Subscriptions}/{id}/preview", new { })).StatusCode);
    }

    [Fact]
    public async Task AnAdminPreviewRendersUnderTheOWNERSRowFiltersNotTheAdmins()
    {
        // An admin preview that quietly showed the admin's own data would be a
        // lie about what the owner receives.
        var carol = _factory.AsUser("carol");
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);
        var id = await CreateSubscriptionAsync(alice, board.Id, new
        {
            body = "tables",
            excludedTileIds = Array.Empty<string>(),
            imageWidth = 600,
            maxTableRows = 50,
        });

        _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Deny;
        try
        {
            // The contributor denies EVERY identity; the render is attempted as
            // the owner and fails closed, and the tile says so instead of
            // silently showing rows the owner cannot see.
            var html = (await ReadJsonAsync(
                await carol.PostAsJsonAsync($"{Subscriptions}/{id}/preview", new { })))["html"]!.GetValue<string>();
            Assert.DoesNotContain("<table", html, StringComparison.Ordinal);
            Assert.Contains("#b91c1c", html, StringComparison.Ordinal); // the red error note
        }
        finally
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        }
    }

    [Fact]
    public async Task PreviewValidatesTheOverrideLikeASave()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);
        var id = await CreateSubscriptionAsync(alice, board.Id, DefaultContent());

        var response = await alice.PostAsJsonAsync(
            $"{Subscriptions}/{id}/preview", new { content = new { body = "charts", imageWidth = 1200 } });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            "rcd.subscription.bad_content",
            (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task PreviewOfAMissingSubscriptionIs404AndAnonymousIs401()
    {
        var alice = _factory.AsUser("alice");
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await alice.PostAsJsonAsync($"{Subscriptions}/999999/preview", new { })).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await _factory.CreateClient().PostAsJsonAsync($"{Subscriptions}/1/preview", new { })).StatusCode);
    }

    // ------------------------------------------------------- preview (draft)

    [Fact]
    public async Task DraftPreviewRendersAnUnsavedConfigForTheCallerWithoutCreatingAnything()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var before = (await ReadJsonAsync(await alice.GetAsync($"{Subscriptions}?dashboardId={board.Id}"))).AsArray().Count;
        var response = await alice.PostAsJsonAsync(
            $"{Dashboards}/{board.Id}/subscriptions/preview",
            new { format = "html", content = DefaultContent() });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await ReadJsonAsync(response);
        Assert.Equal(board.Subject, body["subject"]!.GetValue<string>());
        Assert.Contains("data:image/png;base64,", body["html"]!.GetValue<string>(), StringComparison.Ordinal);

        // No subscription was created by previewing one.
        var after = (await ReadJsonAsync(await alice.GetAsync($"{Subscriptions}?dashboardId={board.Id}"))).AsArray().Count;
        Assert.Equal(before, after);
    }

    [Fact]
    public async Task DraftPreviewHonorsDashboardAccessExactlyLikeSubscriptionSaveDoes()
    {
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");
        var carol = _factory.AsUser("carol"); // only an admin may publish
        var privateDashboard = await CreateChartDashboardAsync(alice, isShared: false);
        var sharedDashboard = await CreateChartDashboardAsync(carol, isShared: true);
        var draft = new { format = "html", content = DefaultContent() };

        // A dashboard bob cannot read is a dashboard bob cannot preview.
        var denied = await bob.PostAsJsonAsync($"{Dashboards}/{privateDashboard.Id}/subscriptions/preview", draft);
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
        Assert.Equal("rcd.dashboard.not_found", (await ReadJsonAsync(denied))["errorCode"]!.GetValue<string>());
        // Saving a subscription against it is refused the same way.
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await bob.PostAsJsonAsync(Subscriptions, SaveBody(privateDashboard.Id, DefaultContent()))).StatusCode);

        Assert.Equal(
            HttpStatusCode.OK,
            (await bob.PostAsJsonAsync($"{Dashboards}/{sharedDashboard.Id}/subscriptions/preview", draft)).StatusCode);
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await alice.PostAsJsonAsync($"{Dashboards}/999999/subscriptions/preview", draft)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await _factory.CreateClient().PostAsJsonAsync(
                $"{Dashboards}/{sharedDashboard.Id}/subscriptions/preview", draft)).StatusCode);
    }

    [Fact]
    public async Task ADraftPreviewOfADashboardWithoutAModelSaysSoInsteadOfFailing()
    {
        var alice = _factory.AsUser("alice");
        var modelless = (await ReadJsonAsync(await alice.PostAsJsonAsync(Dashboards, new
        {
            name = UniqueName("Modelless"),
            description = (string?)null,
            modelId = (int?)null,
            layout = new { tiles = Array.Empty<object>() },
            isShared = false,
        })))["id"]!.GetValue<int>();

        var response = await alice.PostAsJsonAsync(
            $"{Dashboards}/{modelless}/subscriptions/preview",
            new { format = "html", content = DefaultContent() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            "rcd.subscription.preview_unavailable",
            (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task DraftPreviewValidatesContentAndAcceptsTheCsvFormatTheClientAlwaysSends()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var bad = await alice.PostAsJsonAsync(
            $"{Dashboards}/{board.Id}/subscriptions/preview",
            new { format = "html", content = new { body = "tables", maxTableRows = 1 } });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("rcd.subscription.bad_content", (await ReadJsonAsync(bad))["errorCode"]!.GetValue<string>());

        // format=csv previews the same HTML body (the attachment is not part of
        // a preview); the client always sends the field, so it must be honored.
        var csv = await alice.PostAsJsonAsync(
            $"{Dashboards}/{board.Id}/subscriptions/preview",
            new { format = "csv", content = DefaultContent() });
        Assert.Equal(HttpStatusCode.OK, csv.StatusCode);
        Assert.Contains("data:image/png", (await ReadJsonAsync(csv))["html"]!.GetValue<string>(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ExcludedTilesAreAbsentFromThePreviewBody()
    {
        var alice = _factory.AsUser("alice");
        var board = await CreateChartDashboardAsync(alice);

        var body = await ReadJsonAsync(await alice.PostAsJsonAsync(
            $"{Dashboards}/{board.Id}/subscriptions/preview",
            new
            {
                format = "html",
                content = new
                {
                    body = "charts",
                    excludedTileIds = new[] { "t2" },
                    imageWidth = 600,
                    maxTableRows = 50,
                },
            }));

        var html = body["html"]!.GetValue<string>();
        Assert.Contains("Sales by region", html, StringComparison.Ordinal);
        Assert.DoesNotContain("Revenue KPI", html, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------- helpers

    private static void AssertContent(
        JsonNode content, string body, string[] excluded, int imageWidth, int maxTableRows)
    {
        Assert.Equal(body, content["body"]!.GetValue<string>());
        Assert.Equal(excluded, content["excludedTileIds"]!.AsArray().Select(v => v!.GetValue<string>()));
        Assert.Equal(imageWidth, content["imageWidth"]!.GetValue<int>());
        Assert.Equal(maxTableRows, content["maxTableRows"]!.GetValue<int>());
    }

    private static string UniqueName(string prefix) => $"{prefix} {Guid.NewGuid():N}";

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response) =>
        JsonNode.Parse(await response.Content.ReadAsStringAsync())
        ?? throw new InvalidOperationException("Response body was empty.");

    private static object SaveBody(int dashboardId, object? content) => new
    {
        dashboardId,
        name = UniqueName("Content"),
        scheduleKind = "interval",
        intervalMinutes = 30,
        timeOfDayLocal = (string?)null,
        dayOfWeek = (int?)null,
        recipients = "ops@example.com",
        format = "html",
        // enabled=false keeps the demo host's 1-minute scheduler from racing
        // these tests with its own dispatches.
        enabled = false,
        content,
    };

    private async Task<int> CreateSubscriptionAsync(HttpClient client, int dashboardId, object? content)
    {
        var response = await client.PostAsJsonAsync(Subscriptions, SaveBody(dashboardId, content));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    /// <summary>
    /// A dashboard with two real chart tiles: a column chart (t1) and a KPI
    /// (t2). Publishing (isShared) requires CanManageShared, so only the admin
    /// client may pass true. Names are unique — the API rejects duplicates.
    /// </summary>
    private async Task<Board> CreateChartDashboardAsync(HttpClient client, bool isShared = false)
    {
        var modelId = await CreateModelAsync(client, isShared);
        var name = UniqueName("Preview Dashboard");
        var response = await client.PostAsJsonAsync(Dashboards, new
        {
            name,
            description = (string?)null,
            modelId,
            layout = JsonNode.Parse("""
                {
                  "version": 1, "tiles": [], "slicers": [],
                  "pages": [{ "id": "p1", "name": "Main", "tiles": [
                    { "id": "t1", "kind": "chart", "chart": { "id": "c1", "type": "column",
                      "title": "Sales by region", "query": {
                        "axis": { "table": "public.customers", "column": "region" },
                        "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
                        "filters": [] },
                      "format": { "theme": "ocean", "showLegend": true } } },
                    { "id": "t2", "kind": "chart", "chart": { "id": "c2", "type": "kpi",
                      "title": "Revenue KPI", "query": {
                        "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
                        "filters": [] } } }
                  ]}]
                }
                """),
            isShared,
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return new Board((await ReadJsonAsync(response))["id"]!.GetValue<int>(), name);
    }

    /// <summary>A created dashboard: its id, and the name its snapshot subject will carry.</summary>
    private sealed record Board(int Id, string Name)
    {
        public string Subject => $"{Name} — dashboard snapshot";
    }

    private async Task<int> CreateModelAsync(HttpClient client, bool isShared)
    {
        var response = await client.PostAsJsonAsync(Models, new
        {
            name = UniqueName("Content Model"),
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
}
