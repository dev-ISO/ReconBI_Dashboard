using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// Collaborative-editing wave 1 over the real demo host: the ops endpoint
/// (classification + permission gating end to end), the soft tile-lock
/// endpoints, and the tile_locked advisory on ops — all through real JWT
/// policies (View slot: a grantee edits without the host's Author role).
/// </summary>
public sealed class DashboardOpsApiTests : IClassFixture<DemoApiFactory>
{
    private const string Dashboards = "/api/rcd/v1/dashboards";

    private const string PagedLayout = """
        {"pages":[{"id":"p1","name":"Main","tiles":[
          {"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"title":"Orders","type":"column"}},
          {"id":"t2","kind":"text","layout":{"x":4,"y":0,"w":2,"h":1},"text":{"content":"hello"}}]}]}
        """;

    private readonly DemoApiFactory _factory;

    public DashboardOpsApiTests(DemoApiFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task OwnerOp_Applies_Responds_AndPersists()
    {
        var carol = _factory.AsUser("carol");
        var id = await CreateDashboardAsync(carol);

        var response = await carol.PostAsJsonAsync($"{Dashboards}/{id}/ops", new
        {
            opId = "op-1",
            targetKind = "tile",
            targetId = "t1",
            payload = new { kind = "tileGeometry", layout = new { x = 6, y = 0, w = 4, h = 3 } },
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await ReadJsonAsync(response);
        Assert.Equal("op-1", body["opId"]!.GetValue<string>());
        Assert.Equal("geometry", body["class"]!.GetValue<string>());
        var resultStamp = body["updatedAtUtc"]!.GetValue<DateTime>();

        // The edit persisted and the receipt's stamp IS the dashboard's stamp.
        var fetched = await ReadJsonAsync(await carol.GetAsync($"{Dashboards}/{id}"));
        Assert.Equal(6, fetched["layout"]!["pages"]![0]!["tiles"]![0]!["layout"]!["x"]!.GetValue<int>());
        Assert.Equal(resultStamp, fetched["updatedAtUtc"]!.GetValue<DateTime>());
    }

    [Fact]
    public async Task GranteeOps_AreGatedPerClass_WithoutNeedingTheAuthorRole()
    {
        var carol = _factory.AsUser("carol");
        var id = await CreateDashboardAsync(carol);
        await ShareAsync(carol, id, "alice", canEditCharts: true);

        var alice = _factory.AsUser("alice");

        // Charts flag covers a chart-body edit…
        var chartEdit = await alice.PostAsJsonAsync($"{Dashboards}/{id}/ops", new
        {
            opId = "op-chart",
            targetKind = "tile",
            targetId = "t1",
            payload = new
            {
                kind = "tileUpsert",
                tile = new
                {
                    id = "t1",
                    kind = "chart",
                    layout = new { x = 0, y = 0, w = 4, h = 3 },
                    chart = new { title = "Orders", type = "line" },
                },
            },
        });
        Assert.Equal(HttpStatusCode.OK, chartEdit.StatusCode);

        // …but not a page rename (pages class).
        var pageRename = await alice.PostAsJsonAsync($"{Dashboards}/{id}/ops", new
        {
            opId = "op-page",
            targetKind = "page",
            targetId = "p1",
            payload = new { kind = "pageRename", name = "Renamed" },
        });
        Assert.Equal(HttpStatusCode.Forbidden, pageRename.StatusCode);
        var problem = await ReadJsonAsync(pageRename);
        Assert.Equal("rcd.dashboard.permission_denied", problem["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task PublishOnlyViewerOpsAndLocks_AreForbidden()
    {
        var carol = _factory.AsUser("carol");
        var id = await CreateDashboardAsync(carol, isShared: true);

        var bob = _factory.AsUser("bob");
        var op = await bob.PostAsJsonAsync($"{Dashboards}/{id}/ops", new
        {
            opId = "op-bob",
            targetKind = "tile",
            targetId = "t1",
            payload = new { kind = "tileRemove" },
        });
        Assert.Equal(HttpStatusCode.Forbidden, op.StatusCode);
        Assert.Equal("rcd.dashboard.forbidden",
            (await ReadJsonAsync(op))["errorCode"]!.GetValue<string>());

        var tileLock = await bob.PostAsync($"{Dashboards}/{id}/tiles/t1/lock", content: null);
        Assert.Equal(HttpStatusCode.Forbidden, tileLock.StatusCode);
    }

    [Fact]
    public async Task TileLockLifecycle_AcquireHeartbeatConflictReleaseReacquire()
    {
        var carol = _factory.AsUser("carol");
        var id = await CreateDashboardAsync(carol);
        await ShareAsync(carol, id, "alice", canEditCharts: true);
        var alice = _factory.AsUser("alice");

        // Acquire.
        var acquired = await carol.PostAsync($"{Dashboards}/{id}/tiles/t1/lock", content: null);
        Assert.Equal(HttpStatusCode.OK, acquired.StatusCode);
        var lockBody = await ReadJsonAsync(acquired);
        Assert.Equal("t1", lockBody["tileId"]!.GetValue<string>());
        Assert.NotNull(lockBody["holderDisplayName"]);
        var firstExpiry = lockBody["expiresAtUtc"]!.GetValue<DateTime>();

        // Heartbeat: same holder re-POSTs, expiry advances (or stays equal on a fast clock).
        var heartbeat = await carol.PostAsync($"{Dashboards}/{id}/tiles/t1/lock", content: null);
        Assert.Equal(HttpStatusCode.OK, heartbeat.StatusCode);
        var beatExpiry = (await ReadJsonAsync(heartbeat))["expiresAtUtc"]!.GetValue<DateTime>();
        Assert.True(beatExpiry >= firstExpiry);

        // A collaborator is told who holds it…
        var contested = await alice.PostAsync($"{Dashboards}/{id}/tiles/t1/lock", content: null);
        Assert.Equal(HttpStatusCode.Conflict, contested.StatusCode);
        var conflict = await ReadJsonAsync(contested);
        Assert.Equal("rcd.dashboard.tile_locked", conflict["errorCode"]!.GetValue<string>());

        // …and their op on the locked tile is rejected with the same code.
        var blockedOp = await alice.PostAsJsonAsync($"{Dashboards}/{id}/ops", new
        {
            opId = "op-blocked",
            targetKind = "tile",
            targetId = "t1",
            payload = new
            {
                kind = "tileUpsert",
                tile = new
                {
                    id = "t1",
                    kind = "chart",
                    layout = new { x = 0, y = 0, w = 4, h = 3 },
                    chart = new { title = "Orders", type = "area" },
                },
            },
        });
        Assert.Equal(HttpStatusCode.Conflict, blockedOp.StatusCode);
        Assert.Equal("rcd.dashboard.tile_locked",
            (await ReadJsonAsync(blockedOp))["errorCode"]!.GetValue<string>());

        // Release frees the tile for the collaborator.
        var released = await carol.DeleteAsync($"{Dashboards}/{id}/tiles/t1/lock");
        Assert.Equal(HttpStatusCode.NoContent, released.StatusCode);

        var reacquired = await alice.PostAsync($"{Dashboards}/{id}/tiles/t1/lock", content: null);
        Assert.Equal(HttpStatusCode.OK, reacquired.StatusCode);

        // Cleanup so other tests see no stale advisory (locks are process-wide).
        Assert.Equal(HttpStatusCode.NoContent,
            (await alice.DeleteAsync($"{Dashboards}/{id}/tiles/t1/lock")).StatusCode);
    }

    [Fact]
    public async Task MalformedOp_Is400WithStableCode()
    {
        var carol = _factory.AsUser("carol");
        var id = await CreateDashboardAsync(carol);

        var response = await carol.PostAsJsonAsync($"{Dashboards}/{id}/ops", new
        {
            opId = "op-bad",
            targetKind = "tile",
            targetId = "t1",
            payload = new { kind = "hologramFlip" },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("rcd.dashboard.op_invalid",
            (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());

        // A body with no payload at all is a clean 400, never a 500.
        var missingPayload = await carol.PostAsJsonAsync($"{Dashboards}/{id}/ops", new
        {
            opId = "op-empty",
            targetKind = "tile",
            targetId = "t1",
        });
        Assert.Equal(HttpStatusCode.BadRequest, missingPayload.StatusCode);
        Assert.Equal("rcd.dashboard.op_invalid",
            (await ReadJsonAsync(missingPayload))["errorCode"]!.GetValue<string>());
    }

    // ---------- helpers ----------

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return JsonNode.Parse(body) ?? throw new InvalidOperationException("Response body was empty.");
    }

    private static async Task<int> CreateDashboardAsync(HttpClient client, bool isShared = false)
    {
        var response = await client.PostAsJsonAsync(Dashboards, new
        {
            name = $"Collab Board {Guid.NewGuid():N}",
            description = (string?)null,
            modelId = (int?)null,
            layout = JsonNode.Parse(PagedLayout),
            isShared,
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    private static async Task ShareAsync(
        HttpClient owner, int id, string userId,
        bool canEditLayout = false, bool canManagePages = false, bool canEditCharts = false,
        bool canMoveTiles = false, bool canDeleteContent = false)
    {
        var response = await owner.PutAsJsonAsync($"{Dashboards}/{id}/shares", new
        {
            shares = new[]
            {
                new { userId, canEditLayout, canManagePages, canEditCharts, canMoveTiles, canDeleteContent },
            },
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
