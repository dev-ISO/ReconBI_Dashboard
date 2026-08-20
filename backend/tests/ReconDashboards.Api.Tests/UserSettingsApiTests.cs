using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// GET/PUT api/rcd/v1/user-settings over the real demo host (real JWT auth,
/// real policy slots, real routing).
///
/// The contract under test: a first-time caller gets the versioned empty
/// document as a 200; PUT replaces the whole document; and — the property that
/// makes this store safe to hold personal measures — one signed-in user CANNOT
/// see or overwrite another's, because the route carries no id and the body has
/// no user field, so the caller's token is the only thing that selects a row.
/// </summary>
public sealed class UserSettingsApiTests : IClassFixture<DemoApiFactory>
{
    private const string UserSettings = "/api/rcd/v1/user-settings";

    private readonly DemoApiFactory _factory;

    public UserSettingsApiTests(DemoApiFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task FirstTimeCaller_GetsTheEmptyDocument_NotA404()
    {
        // carol has never saved anything in this fixture.
        var response = await _factory.AsUser("carol").GetAsync(UserSettings);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await ReadJsonAsync(response);
        Assert.Equal(1, body["settings"]!["version"]!.GetValue<int>());
        Assert.Null(body["updatedAtUtc"]?.GetValue<string?>());
    }

    [Fact]
    public async Task PutThenGet_RoundTripsTheWholeDocument_AndStampsUpdatedAt()
    {
        var alice = _factory.AsUser("alice");

        var saved = await PutAsync(alice, new
        {
            version = 1,
            fieldList = new { grouping = "type", expanded = new[] { "#measures/Finance" } },
            measures = new[] { new { id = "m1", name = "My Total" } },
        });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.NotNull((await ReadJsonAsync(saved))["updatedAtUtc"]?.GetValue<string>());

        var fetched = await ReadJsonAsync(await alice.GetAsync(UserSettings));
        Assert.Equal("type", fetched["settings"]!["fieldList"]!["grouping"]!.GetValue<string>());
        Assert.Equal("My Total", fetched["settings"]!["measures"]![0]!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task OneUsersDocument_IsInvisibleAndImmutableToAnother()
    {
        var alice = _factory.AsUser("alice");
        var bob = _factory.AsUser("bob");

        Assert.Equal(HttpStatusCode.OK,
            (await PutAsync(alice, new { version = 1, mine = "alice" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK,
            (await PutAsync(bob, new { version = 1, mine = "bob" })).StatusCode);

        // Each identity reads exactly its own row. There is no request shape
        // that could ask for the other one: no id segment, no id field.
        var asAlice = await ReadJsonAsync(await alice.GetAsync(UserSettings));
        var asBob = await ReadJsonAsync(await bob.GetAsync(UserSettings));

        Assert.Equal("alice", asAlice["settings"]!["mine"]!.GetValue<string>());
        Assert.Equal("bob", asBob["settings"]!["mine"]!.GetValue<string>());

        // carol is an ADMIN in the demo host (CanManageShared). Admin standing
        // unlocks other people's SHARED content elsewhere; personal settings
        // are never shared, so it must buy nothing here.
        var asCarol = await ReadJsonAsync(await _factory.AsUser("carol").GetAsync(UserSettings));
        Assert.Null(asCarol["settings"]!["mine"]);
    }

    [Fact]
    public async Task Anonymous_IsRejectedByThePolicySlot()
    {
        // The View slot is host-configured; the demo host requires a signed-in
        // caller, so an unauthenticated request never reaches the controller.
        var response = await _factory.CreateClient().GetAsync(UserSettings);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task NonObjectAndMalformedBodies_AreRejected_NotIgnored()
    {
        var alice = _factory.AsUser("alice");

        // Envelope missing.
        var bare = await alice.PutAsJsonAsync(UserSettings, new { version = 1 });
        Assert.Equal(HttpStatusCode.BadRequest, bare.StatusCode);
        Assert.Equal("rcd.user_settings.invalid",
            (await ReadJsonAsync(bare))["errorCode"]!.GetValue<string>());

        // Settings present but not an object.
        var arraySettings = await alice.PutAsJsonAsync(UserSettings, new { settings = new[] { 1, 2 } });
        Assert.Equal(HttpStatusCode.BadRequest, arraySettings.StatusCode);

        // Unknown envelope field — a typo must fail loudly, not save nothing.
        var typo = await alice.PutAsJsonAsync(
            UserSettings, new { settings = new { version = 1 }, settingsJson = "{}" });
        Assert.Equal(HttpStatusCode.BadRequest, typo.StatusCode);
    }

    [Fact]
    public async Task OverTheByteCap_Is422_WithTheLimitErrorCode()
    {
        var alice = _factory.AsUser("alice");
        var oversized = new string('x', 200_000);

        var response = await PutAsync(alice, new { version = 1, pad = oversized });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("rcd.limit.user_settings_size",
            (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task UnknownSections_SurviveARoundTrip()
    {
        // A section this build has never heard of must come back byte-identical:
        // that is what lets a later wave add one without a server deploy.
        var bob = _factory.AsUser("bob");
        var body = new JsonObject
        {
            ["version"] = 1,
            ["someFutureWave"] = new JsonObject { ["nested"] = new JsonArray(1, 2, 3) },
        };

        await PutRawAsync(bob, new JsonObject { ["settings"] = body }.ToJsonString());
        var fetched = await ReadJsonAsync(await bob.GetAsync(UserSettings));

        Assert.Equal(3, fetched["settings"]!["someFutureWave"]!["nested"]![2]!.GetValue<int>());
    }

    private static Task<HttpResponseMessage> PutAsync(HttpClient client, object settings) =>
        client.PutAsJsonAsync(UserSettings, new { settings });

    private static Task<HttpResponseMessage> PutRawAsync(HttpClient client, string json) =>
        client.PutAsync(UserSettings, new StringContent(json, Encoding.UTF8, "application/json"));

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return JsonNode.Parse(body) ?? throw new InvalidOperationException("Response body was empty.");
    }
}
