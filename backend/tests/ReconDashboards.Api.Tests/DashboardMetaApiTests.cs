using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// PATCH dashboards/{id}/meta (collab fix wave, C5): metadata-only writes over
/// the real demo host. The contract under test: absent fields keep their
/// stored value, explicit null clears description/modelId, the layout is
/// NEVER touched, no expectedUpdatedAtUtc is required — and the auth matrix
/// mirrors the whole-doc update exactly (owner/admin for name/description/
/// modelId; CanManageShared for isShared; grantee metadata immutable).
/// </summary>
public sealed class DashboardMetaApiTests : IClassFixture<DemoApiFactory>
{
    private const string Dashboards = "/api/rcd/v1/dashboards";

    private const string PagedLayout = """
        {"pages":[{"id":"p1","name":"Main","tiles":[
          {"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"title":"Orders","type":"column"}}]}]}
        """;

    private readonly DemoApiFactory _factory;

    public DashboardMetaApiTests(DemoApiFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task OwnerRename_NeedsNoStamp_AndNeverTouchesTheLayout()
    {
        var alice = _factory.AsUser("alice");
        var id = await CreateDashboardAsync(alice);

        var response = await PatchMetaAsync(alice, id, new { name = "Renamed board" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await ReadJsonAsync(response);
        Assert.Equal("Renamed board", body["name"]!.GetValue<string>());

        // The layout survived byte-for-byte semantics: same page, same tile.
        var fetched = await ReadJsonAsync(await alice.GetAsync($"{Dashboards}/{id}"));
        Assert.Equal("Renamed board", fetched["name"]!.GetValue<string>());
        var tiles = fetched["layout"]!["pages"]![0]!["tiles"]!.AsArray();
        Assert.Single(tiles);
        Assert.Equal("Orders", tiles[0]!["chart"]!["title"]!.GetValue<string>());
    }

    [Fact]
    public async Task AbsentFieldsKeepStoredValues_ExplicitNullClearsDescription()
    {
        var alice = _factory.AsUser("alice");
        var id = await CreateDashboardAsync(alice, description: "keep or clear");

        // name-only patch: description untouched.
        await PatchMetaAsync(alice, id, new { name = "First rename" });
        var afterRename = await ReadJsonAsync(await alice.GetAsync($"{Dashboards}/{id}"));
        Assert.Equal("keep or clear", afterRename["description"]!.GetValue<string>());

        // explicit null clears it (absent-vs-null is the endpoint's contract).
        var cleared = await PatchMetaAsync(alice, id, new { description = (string?)null });
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        var afterClear = await ReadJsonAsync(await alice.GetAsync($"{Dashboards}/{id}"));
        Assert.Null(afterClear["description"]?.GetValue<string?>());
        Assert.Equal("First rename", afterClear["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task GranteeMetadata_IsImmutable_EvenWithEveryEditFlag()
    {
        var alice = _factory.AsUser("alice");
        var id = await CreateDashboardAsync(alice);
        await ShareAsync(alice, id, "bob",
            canEditLayout: true, canManagePages: true, canEditCharts: true,
            canMoveTiles: true, canDeleteContent: true);

        var bob = _factory.AsUser("bob");
        var response = await PatchMetaAsync(bob, id, new { name = "Bob was here" });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("rcd.dashboard.share_forbidden_fields",
            (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task PublishFlip_RequiresManageShared_AdminSucceedsOwnerDoesNot()
    {
        var alice = _factory.AsUser("alice");
        var id = await CreateDashboardAsync(alice);

        // The non-admin OWNER may rename but not publish (same rule as the PUT).
        var ownerFlip = await PatchMetaAsync(alice, id, new { isShared = true });
        Assert.Equal(HttpStatusCode.Forbidden, ownerFlip.StatusCode);
        Assert.Equal("rcd.dashboard.share_forbidden",
            (await ReadJsonAsync(ownerFlip))["errorCode"]!.GetValue<string>());

        // The admin may — once the row is VISIBLE to them (admins never see
        // other users' private dashboards; visibility rules match the PUT).
        await ShareAsync(alice, id, "carol");
        var carol = _factory.AsUser("carol");
        var adminFlip = await PatchMetaAsync(carol, id, new { isShared = true });
        Assert.Equal(HttpStatusCode.OK, adminFlip.StatusCode);
        Assert.True((await ReadJsonAsync(adminFlip))["isShared"]!.GetValue<bool>());
    }

    [Fact]
    public async Task NameConflict_AnswersConflict_AndChangesNothing()
    {
        var alice = _factory.AsUser("alice");
        await CreateDashboardAsync(alice, name: "Taken name");
        var id = await CreateDashboardAsync(alice, name: "Original name");

        var response = await PatchMetaAsync(alice, id, new { name = "Taken name" });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("rcd.dashboard.name_conflict",
            (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
        var fetched = await ReadJsonAsync(await alice.GetAsync($"{Dashboards}/{id}"));
        Assert.Equal("Original name", fetched["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task UnknownOrMistypedFields_AreRejected_NotIgnored()
    {
        var alice = _factory.AsUser("alice");
        var id = await CreateDashboardAsync(alice);

        // Strictness doctrine (same as op payloads): a typo'd field fails
        // loudly instead of silently changing nothing — and a layout smuggled
        // into the body can never ride along.
        var unknownField = await PatchMetaAsync(alice, id, new { layout = new { tiles = Array.Empty<object>() } });
        Assert.Equal(HttpStatusCode.BadRequest, unknownField.StatusCode);
        Assert.Equal("rcd.dashboard.invalid_meta",
            (await ReadJsonAsync(unknownField))["errorCode"]!.GetValue<string>());

        var mistyped = await PatchMetaAsync(alice, id, new { isShared = "yes" });
        Assert.Equal(HttpStatusCode.BadRequest, mistyped.StatusCode);
    }

    [Fact]
    public async Task PublishOnlyViewer_CannotPatchMeta()
    {
        var carol = _factory.AsUser("carol");
        var id = await CreateDashboardAsync(carol, isShared: true);

        var bob = _factory.AsUser("bob");
        var response = await PatchMetaAsync(bob, id, new { name = "Bob was here" });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    private static Task<HttpResponseMessage> PatchMetaAsync(HttpClient client, int id, object body) =>
        client.PatchAsJsonAsync($"{Dashboards}/{id}/meta", body);

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return JsonNode.Parse(body) ?? throw new InvalidOperationException("Response body was empty.");
    }

    private static async Task<int> CreateDashboardAsync(
        HttpClient client, bool isShared = false, string? name = null, string? description = null)
    {
        var response = await client.PostAsJsonAsync(Dashboards, new
        {
            name = name ?? $"Meta Board {Guid.NewGuid():N}",
            description,
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
