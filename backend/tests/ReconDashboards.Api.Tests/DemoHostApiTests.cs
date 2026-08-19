using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// End-to-end tests over the demo host through WebApplicationFactory: real JWT
/// auth, real policies/route conventions/controllers/services, SQLite storage,
/// fixture "demo" data source with a recording fake executor. All tests live in
/// one class so they run sequentially against the shared factory state.
/// </summary>
public sealed class DemoHostApiTests : IClassFixture<DemoApiFactory>
{
    private const string Meta = "/api/rcd/v1/meta";
    private const string Connections = "/api/rcd/v1/connections";
    private const string Models = "/api/rcd/v1/models";
    private const string Dashboards = "/api/rcd/v1/dashboards";
    private const string Query = "/api/rcd/v1/query";

    private readonly DemoApiFactory _factory;

    public DemoHostApiTests(DemoApiFactory factory)
    {
        _factory = factory;
        _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
    }

    // ---------- meta + routing ----------

    [Fact]
    public async Task Meta_WithoutBearerToken_Returns401()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync(Meta);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Meta_AsViewerBob_ReturnsLimitsPayload()
    {
        var client = _factory.AsUser("bob");

        var response = await client.GetAsync(Meta);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await ReadJsonAsync(response);
        Assert.False(string.IsNullOrWhiteSpace(json["version"]!.GetValue<string>()));
        Assert.Equal(10_000, json["maxRows"]!.GetValue<int>());
        Assert.Equal(8, json["maxJoins"]!.GetValue<int>());
        Assert.Equal(8, json["maxDimensions"]!.GetValue<int>());
        Assert.Equal(16, json["maxMeasures"]!.GetValue<int>());
        Assert.Equal(32, json["maxFilters"]!.GetValue<int>());
    }

    [Fact]
    public async Task Endpoints_AreMountedUnderConfiguredRoutePrefix()
    {
        var client = _factory.AsUser("bob");

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(Meta)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(Connections)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/meta")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/v1/meta")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/rcd/meta")).StatusCode);
    }

    // ---------- connections + catalog ----------

    [Fact]
    public async Task Connections_AsViewerBob_ListsDemoWithoutConnectionString()
    {
        var client = _factory.AsUser("bob");

        var response = await client.GetAsync(Connections);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var json = JsonNode.Parse(body)!.AsArray();
        Assert.Single(json);
        Assert.Equal("demo", json[0]!["name"]!.GetValue<string>());
        Assert.Equal("postgres", json[0]!["provider"]!.GetValue<string>());

        // The registered connection string must never appear anywhere in the payload.
        Assert.DoesNotContain("hunter2", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret-host", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("connectionstring", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("password", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Catalog_AsViewerBob_Returns403()
    {
        var client = _factory.AsUser("bob");

        var response = await client.GetAsync($"{Connections}/demo/catalog");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Catalog_AsAuthorAlice_ReturnsTablesAndSuggestions()
    {
        var client = _factory.AsUser("alice");

        var response = await client.GetAsync($"{Connections}/demo/catalog");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await ReadJsonAsync(response);
        Assert.Equal("demo", json["connection"]!.GetValue<string>());

        var tableKeys = json["tables"]!.AsArray().Select(t => t!["key"]!.GetValue<string>()).ToArray();
        Assert.Contains("public.customers", tableKeys);
        Assert.Contains("public.orders", tableKeys);

        var suggestions = json["suggestions"]!.AsArray();
        Assert.Contains(suggestions, s =>
            s!["fromTable"]!.GetValue<string>() == "public.orders"
            && s["fromColumn"]!.GetValue<string>() == "customer_id"
            && s["toTable"]!.GetValue<string>() == "public.customers"
            && s["toColumn"]!.GetValue<string>() == "id");
    }

    [Fact]
    public async Task Catalog_UnknownConnection_Returns404WithErrorCode()
    {
        var client = _factory.AsUser("alice");

        var response = await client.GetAsync($"{Connections}/no-such-source/catalog");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var json = await ReadJsonAsync(response);
        Assert.Equal("rcd.source.unknown", json["errorCode"]!.GetValue<string>());
    }

    // ---------- models ----------

    [Fact]
    public async Task Models_CreateAsAlice_Returns201_ThenDuplicateName_Returns409()
    {
        var client = _factory.AsUser("alice");
        var name = UniqueName("Sales Model");

        var created = await client.PostAsJsonAsync(Models, SaveModelBody(name));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var json = await ReadJsonAsync(created);
        Assert.Equal(name, json["name"]!.GetValue<string>());
        Assert.True(json["ownerIsMe"]!.GetValue<bool>());
        Assert.False(json["isShared"]!.GetValue<bool>());
        Assert.True(json["id"]!.GetValue<int>() > 0);

        var duplicate = await client.PostAsJsonAsync(Models, SaveModelBody(name));
        Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        var problem = await ReadJsonAsync(duplicate);
        Assert.Equal("rcd.model.name_conflict", problem["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task Models_PrivateModel_IsNotVisibleToOtherUsers()
    {
        var alice = _factory.AsUser("alice");
        var carol = _factory.AsUser("carol");
        var name = UniqueName("Private Model");
        await CreateModelAsync(alice, name);

        var carolList = (await ReadJsonAsync(await carol.GetAsync(Models))).AsArray();
        Assert.DoesNotContain(carolList, m => m!["name"]!.GetValue<string>() == name);

        var aliceList = (await ReadJsonAsync(await alice.GetAsync(Models))).AsArray();
        var mine = aliceList.Single(m => m!["name"]!.GetValue<string>() == name)!;
        Assert.True(mine["ownerIsMe"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Models_CreateAsViewerBob_Returns403()
    {
        var client = _factory.AsUser("bob");

        var response = await client.PostAsJsonAsync(Models, SaveModelBody(UniqueName("Bob Model")));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Models_CreateShared_RequiresAdmin()
    {
        var alice = _factory.AsUser("alice");
        var aliceAttempt = await alice.PostAsJsonAsync(
            Models, SaveModelBody(UniqueName("Alice Shared"), isShared: true));
        Assert.Equal(HttpStatusCode.Forbidden, aliceAttempt.StatusCode);
        var problem = await ReadJsonAsync(aliceAttempt);
        Assert.Equal("rcd.model.share_forbidden", problem["errorCode"]!.GetValue<string>());

        var carol = _factory.AsUser("carol");
        var carolAttempt = await carol.PostAsJsonAsync(
            Models, SaveModelBody(UniqueName("Carol Shared"), isShared: true));
        Assert.Equal(HttpStatusCode.Created, carolAttempt.StatusCode);
        var json = await ReadJsonAsync(carolAttempt);
        Assert.True(json["isShared"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Models_UpdateOfSharedModel_EnforcesPolicyAndOwnership()
    {
        var carol = _factory.AsUser("carol");
        var name = UniqueName("Shared Model");
        var id = await CreateModelAsync(carol, name, isShared: true);
        var updateBody = SaveModelBody(name, isShared: true, description: "updated");

        // bob lacks the Author policy: rejected by authorization, not the service.
        var bobAttempt = await _factory.AsUser("bob").PutAsJsonAsync($"{Models}/{id}", updateBody);
        Assert.Equal(HttpStatusCode.Forbidden, bobAttempt.StatusCode);

        // alice passes the policy but is not the owner and not an admin.
        var aliceAttempt = await _factory.AsUser("alice").PutAsJsonAsync($"{Models}/{id}", updateBody);
        Assert.Equal(HttpStatusCode.Forbidden, aliceAttempt.StatusCode);
        var problem = await ReadJsonAsync(aliceAttempt);
        Assert.Equal("rcd.model.forbidden", problem["errorCode"]!.GetValue<string>());

        // the owner can edit.
        var carolAttempt = await carol.PutAsJsonAsync($"{Models}/{id}", updateBody);
        Assert.Equal(HttpStatusCode.OK, carolAttempt.StatusCode);
        var json = await ReadJsonAsync(carolAttempt);
        Assert.Equal("updated", json["description"]!.GetValue<string>());
    }

    [Fact]
    public async Task Models_Validate_ReportsUnknownColumnAsMDL002()
    {
        var client = _factory.AsUser("alice");
        var body = new
        {
            dataSourceName = "demo",
            definition = ModelDefinition(measureColumn: "does_not_exist"),
        };

        var response = await client.PostAsJsonAsync($"{Models}/validate", body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await ReadJsonAsync(response);
        Assert.False(json["valid"]!.GetValue<bool>());
        Assert.Contains(json["issues"]!.AsArray(), i => i!["code"]!.GetValue<string>() == "MDL002");
    }

    // ---------- model duplicate / export / import ----------

    [Fact]
    public async Task Models_Duplicate_OfSharedModel_IsAuthorOnly_AndYieldsAnOwnedUnsharedCopy()
    {
        var carol = _factory.AsUser("carol");
        var name = UniqueName("Company Default");
        var id = await CreateModelAsync(carol, name, isShared: true);

        // Duplicate sits in the Author slot: the viewer is stopped by policy.
        var bobAttempt = await _factory.AsUser("bob").PostAsync($"{Models}/{id}/duplicate", content: null);
        Assert.Equal(HttpStatusCode.Forbidden, bobAttempt.StatusCode);

        var alice = _factory.AsUser("alice");
        var first = await alice.PostAsync($"{Models}/{id}/duplicate", content: null);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var copy = await ReadJsonAsync(first);
        Assert.Equal($"{name} (copy)", copy["name"]!.GetValue<string>());
        Assert.True(copy["ownerIsMe"]!.GetValue<bool>());
        Assert.False(copy["isShared"]!.GetValue<bool>());
        Assert.NotEqual(id, copy["id"]!.GetValue<int>());

        // The definition came across whole.
        var original = await ReadJsonAsync(await carol.GetAsync($"{Models}/{id}"));
        Assert.Equal(original["definition"]!.ToJsonString(), copy["definition"]!.ToJsonString());

        // A second copy walks to "(copy 2)" rather than colliding.
        var second = await alice.PostAsync($"{Models}/{id}/duplicate", content: null);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        Assert.Equal($"{name} (copy 2)", (await ReadJsonAsync(second))["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task Models_Duplicate_OfAnotherUsersPrivateModel_Returns404()
    {
        var id = await CreateModelAsync(_factory.AsUser("alice"), UniqueName("Alice Private"));

        var response = await _factory.AsUser("carol").PostAsync($"{Models}/{id}/duplicate", content: null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("rcd.model.not_found", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task Models_Export_IsViewable_AndReturnsAPortableDocumentAsAnAttachment()
    {
        var carol = _factory.AsUser("carol");
        var name = UniqueName("Exportable Model");
        var id = await CreateModelAsync(carol, name, isShared: true);

        // Export is in the View slot: the viewer can take a copy of a shared model.
        var response = await _factory.AsUser("bob").GetAsync($"{Models}/{id}/export");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var disposition = response.Content.Headers.ContentDisposition;
        Assert.NotNull(disposition);
        Assert.Equal("attachment", disposition.DispositionType);
        Assert.EndsWith(".model.json", disposition.FileName!.Trim('"'));

        var document = await ReadJsonAsync(response);
        Assert.Equal(name, document["name"]!.GetValue<string>());
        Assert.Equal("demo", document["dataSourceName"]!.GetValue<string>());
        Assert.Equal(1, document["definition"]!["version"]!.GetValue<int>());
        Assert.Equal(2, document["definition"]!["tables"]!.AsArray().Count);

        // Installation-specific fields stay out of the portable document.
        var keys = document.AsObject().Select(p => p.Key).ToArray();
        Assert.DoesNotContain("id", keys);
        Assert.DoesNotContain("isShared", keys);
        Assert.DoesNotContain("ownerIsMe", keys);
    }

    [Fact]
    public async Task Models_Export_OfAnotherUsersPrivateModel_Returns404()
    {
        var id = await CreateModelAsync(_factory.AsUser("alice"), UniqueName("Alice Secret"));

        var response = await _factory.AsUser("carol").GetAsync($"{Models}/{id}/export");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("rcd.model.not_found", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task Models_Import_AsViewerBob_Returns403()
    {
        var body = new
        {
            name = UniqueName("Bob Import"),
            description = (string?)null,
            dataSourceName = "demo",
            definition = ModelDefinition(),
        };

        var response = await _factory.AsUser("bob").PostAsJsonAsync($"{Models}/import", body);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Models_ExportThenImport_RoundTripsTheDefinition_AndRejectsADuplicateName()
    {
        var alice = _factory.AsUser("alice");
        var id = await CreateModelAsync(alice, UniqueName("Round Trip"));
        var exported = await ReadJsonAsync(await alice.GetAsync($"{Models}/{id}/export"));
        var definitionJson = exported["definition"]!.ToJsonString();

        var importName = UniqueName("Round Trip Imported");
        exported["name"] = importName;
        var imported = await alice.PostAsJsonAsync($"{Models}/import", exported);
        Assert.Equal(HttpStatusCode.Created, imported.StatusCode);
        var created = await ReadJsonAsync(imported);
        Assert.Equal(importName, created["name"]!.GetValue<string>());
        Assert.True(created["ownerIsMe"]!.GetValue<bool>());
        Assert.False(created["isShared"]!.GetValue<bool>());
        Assert.Equal(definitionJson, created["definition"]!.ToJsonString());

        // Re-exporting the import reproduces the original document byte for byte.
        var reExported = await ReadJsonAsync(await alice.GetAsync($"{Models}/{created["id"]!.GetValue<int>()}/export"));
        Assert.Equal(definitionJson, reExported["definition"]!.ToJsonString());

        // Importing the same document again collides on the name.
        var again = await alice.PostAsJsonAsync($"{Models}/import", exported);
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("rcd.model.name_conflict", (await ReadJsonAsync(again))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task Models_Import_OfADefinitionTheCatalogRejects_Returns422WithIssues()
    {
        var body = new
        {
            name = UniqueName("Broken Import"),
            description = (string?)null,
            dataSourceName = "demo",
            definition = ModelDefinition(measureColumn: "does_not_exist"),
        };

        var response = await _factory.AsUser("alice").PostAsJsonAsync($"{Models}/import", body);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await ReadJsonAsync(response);
        Assert.Equal("rcd.model.invalid", problem["errorCode"]!.GetValue<string>());
        Assert.Contains(problem["issues"]!.AsArray(), i => i!["code"]!.GetValue<string>() == "MDL002");
    }

    [Fact]
    public async Task Models_Import_WithoutADefinition_Returns400()
    {
        var body = new { name = UniqueName("Empty Import"), dataSourceName = "demo" };

        var response = await _factory.AsUser("alice").PostAsJsonAsync($"{Models}/import", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("rcd.model.invalid_json", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    // ---------- query ----------

    [Fact]
    public async Task Query_ReturnsCannedRows_SqlMeta_AndColumnRoles()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Query Model"));

        var response = await client.PostAsJsonAsync(Query, RegionTotalQuery(modelId));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await ReadJsonAsync(response);

        var columns = json["columns"]!.AsArray();
        Assert.Equal(2, columns.Count);
        Assert.Equal("dimension", columns[0]!["role"]!.GetValue<string>());
        Assert.Equal("measure", columns[1]!["role"]!.GetValue<string>());

        var rows = json["rows"]!.AsArray();
        Assert.Equal(2, rows.Count);
        Assert.Equal("West", rows[0]![0]!.GetValue<string>());
        Assert.Equal(10, rows[0]![1]!.GetValue<int>());
        Assert.Equal("East", rows[1]![0]!.GetValue<string>());
        Assert.Equal(20, rows[1]![1]!.GetValue<int>());

        Assert.Equal(2, json["meta"]!["rowCount"]!.GetValue<int>());
        var sql = json["meta"]!["sql"]?.GetValue<string>();
        Assert.False(string.IsNullOrWhiteSpace(sql)); // IncludeSqlInResponse honored in Development
        Assert.Contains("SELECT", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Query_AgainstAnotherUsersPrivateModel_Returns404()
    {
        var alice = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(alice, UniqueName("Alice Only"));

        var response = await _factory.AsUser("bob").PostAsJsonAsync(Query, RegionTotalQuery(modelId));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var json = await ReadJsonAsync(response);
        Assert.Equal("rcd.model.not_found", json["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task Query_UnknownModel_Returns404()
    {
        var client = _factory.AsUser("alice");

        var response = await client.PostAsJsonAsync(Query, RegionTotalQuery(987_654));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Query_FailsClosed_OnContributorThrowOrDeny_WithoutExecuting()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Fail Closed"));

        try
        {
            foreach (var mode in new[]
                     {
                         SwitchableRowFilterContributor.FilterMode.Throw,
                         SwitchableRowFilterContributor.FilterMode.Deny,
                     })
            {
                _factory.RowFilters.Mode = mode;
                var executionsBefore = _factory.Executor.ExecutionCount;

                var response = await client.PostAsJsonAsync(Query, RegionTotalQuery(modelId));

                Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
                var json = await ReadJsonAsync(response);
                Assert.Equal("rcd.query.denied_by_scope", json["errorCode"]!.GetValue<string>());
                Assert.Equal(executionsBefore, _factory.Executor.ExecutionCount); // executor never reached
            }
        }
        finally
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        }

        // Sanity: with Allow restored the same query executes again.
        var allowed = await client.PostAsJsonAsync(Query, RegionTotalQuery(modelId));
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    public async Task Query_RowFilters_AreParameterized_NeverInlined()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Scoped Model"));

        try
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.WestCustomersOnly;

            var response = await client.PostAsJsonAsync(Query, RegionTotalQuery(modelId));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var captured = _factory.Executor.LastQuery;
            Assert.NotNull(captured);
            Assert.Contains("= @", captured.Sql); // predicate is parameterized
            Assert.DoesNotContain("West", captured.Sql); // the value never reaches SQL text
            Assert.Contains(captured.Parameters, p => Equals(p.Value, "West"));
        }
        finally
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        }
    }

    // ---------- dashboards ----------

    [Fact]
    public async Task Dashboards_Shared_VisibleToOthers_AndDuplicableByAuthorsOnly()
    {
        var carol = _factory.AsUser("carol");
        var name = UniqueName("Shared Dashboard");
        var id = await CreateDashboardAsync(carol, name, isShared: true);

        var bob = _factory.AsUser("bob");
        var bobList = (await ReadJsonAsync(await bob.GetAsync(Dashboards))).AsArray();
        var visible = bobList.Single(d => d!["name"]!.GetValue<string>() == name)!;
        Assert.True(visible["isShared"]!.GetValue<bool>());
        Assert.False(visible["ownerIsMe"]!.GetValue<bool>());

        // Duplicate is an Author-slot endpoint: bob is rejected by policy.
        var bobDuplicate = await bob.PostAsync($"{Dashboards}/{id}/duplicate", content: null);
        Assert.Equal(HttpStatusCode.Forbidden, bobDuplicate.StatusCode);

        var aliceDuplicate = await _factory.AsUser("alice").PostAsync($"{Dashboards}/{id}/duplicate", content: null);
        Assert.Equal(HttpStatusCode.Created, aliceDuplicate.StatusCode);
        var copy = await ReadJsonAsync(aliceDuplicate);
        Assert.Equal($"{name} (copy)", copy["name"]!.GetValue<string>());
        Assert.True(copy["ownerIsMe"]!.GetValue<bool>());
        Assert.False(copy["isShared"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Dashboards_UpdateOfShared_EnforcesPolicyAndOwnership()
    {
        var carol = _factory.AsUser("carol");
        var name = UniqueName("Managed Dashboard");
        var id = await CreateDashboardAsync(carol, name, isShared: true);
        var updateBody = SaveDashboardBody(name, isShared: true, description: "updated");

        var bobAttempt = await _factory.AsUser("bob").PutAsJsonAsync($"{Dashboards}/{id}", updateBody);
        Assert.Equal(HttpStatusCode.Forbidden, bobAttempt.StatusCode);

        var aliceAttempt = await _factory.AsUser("alice").PutAsJsonAsync($"{Dashboards}/{id}", updateBody);
        Assert.Equal(HttpStatusCode.Forbidden, aliceAttempt.StatusCode);
        var problem = await ReadJsonAsync(aliceAttempt);
        Assert.Equal("rcd.dashboard.forbidden", problem["errorCode"]!.GetValue<string>());

        // The stamp is required for updates (COLLAB wave 1): the authorized
        // caller without one gets a clear 428 rather than a blind overwrite…
        var carolNoStamp = await carol.PutAsJsonAsync($"{Dashboards}/{id}", updateBody);
        Assert.Equal(HttpStatusCode.PreconditionRequired, carolNoStamp.StatusCode);
        var stampProblem = await ReadJsonAsync(carolNoStamp);
        Assert.Equal("rcd.dashboard.stamp_required", stampProblem["errorCode"]!.GetValue<string>());

        // …a stale stamp conflicts (the previously untested rcd.dashboard.stale)…
        var staleBody = SaveDashboardBody(
            name, isShared: true, description: "updated",
            expectedUpdatedAtUtc: DateTime.UtcNow.AddDays(-1));
        var carolStale = await carol.PutAsJsonAsync($"{Dashboards}/{id}", staleBody);
        Assert.Equal(HttpStatusCode.Conflict, carolStale.StatusCode);
        var staleProblem = await ReadJsonAsync(carolStale);
        Assert.Equal("rcd.dashboard.stale", staleProblem["errorCode"]!.GetValue<string>());

        // …and the current stamp saves.
        var current = await ReadJsonAsync(await carol.GetAsync($"{Dashboards}/{id}"));
        var freshBody = SaveDashboardBody(
            name, isShared: true, description: "updated",
            expectedUpdatedAtUtc: current["updatedAtUtc"]!.GetValue<DateTime>());
        var carolAttempt = await carol.PutAsJsonAsync($"{Dashboards}/{id}", freshBody);
        Assert.Equal(HttpStatusCode.OK, carolAttempt.StatusCode);
    }

    [Fact]
    public async Task Dashboards_DeleteByOwner_Returns204_ThenGetReturns404()
    {
        var client = _factory.AsUser("alice");
        var id = await CreateDashboardAsync(client, UniqueName("Disposable Dashboard"));

        var deleted = await client.DeleteAsync($"{Dashboards}/{id}");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

        var fetched = await client.GetAsync($"{Dashboards}/{id}");
        Assert.Equal(HttpStatusCode.NotFound, fetched.StatusCode);
        var json = await ReadJsonAsync(fetched);
        Assert.Equal("rcd.dashboard.not_found", json["errorCode"]!.GetValue<string>());
    }

    // ---------- helpers ----------

    private static string UniqueName(string prefix) => $"{prefix} {Guid.NewGuid():N}";

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return JsonNode.Parse(body) ?? throw new InvalidOperationException("Response body was empty.");
    }

    private async Task<int> CreateModelAsync(HttpClient client, string name, bool isShared = false)
    {
        var response = await client.PostAsJsonAsync(Models, SaveModelBody(name, isShared));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    private async Task<int> CreateDashboardAsync(HttpClient client, string name, bool isShared = false)
    {
        var response = await client.PostAsJsonAsync(Dashboards, SaveDashboardBody(name, isShared));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    private static object SaveModelBody(string name, bool isShared = false, string? description = null) => new
    {
        name,
        description,
        dataSourceName = "demo",
        definition = ModelDefinition(),
        isShared,
    };

    private static object SaveDashboardBody(
        string name, bool isShared = false, string? description = null,
        DateTime? expectedUpdatedAtUtc = null) => new
    {
        name,
        description,
        modelId = (int?)null,
        layout = new { tiles = Array.Empty<object>() },
        isShared,
        expectedUpdatedAtUtc,
    };

    /// <summary>Customers + orders + the FK relationship + one Sum measure (mirrors the fixture schema).</summary>
    private static object ModelDefinition(string measureColumn = "order_total") => new
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
        measures = new object[]
        {
            new
            {
                id = Guid.NewGuid(),
                name = "Total Order Value",
                table = "public.orders",
                aggregation = "sum",
                column = measureColumn,
            },
        },
    };

    private static object RegionTotalQuery(int modelId) => new
    {
        modelId,
        dimensions = new object[] { new { table = "public.customers", column = "region" } },
        measures = new object[] { new { table = "public.orders", column = "order_total", aggregation = "sum" } },
        filters = Array.Empty<object>(),
        sort = Array.Empty<object>(),
    };
}
