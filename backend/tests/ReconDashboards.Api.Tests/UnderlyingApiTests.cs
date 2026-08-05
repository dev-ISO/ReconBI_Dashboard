using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// End-to-end tests for POST /query/underlying through the demo host: auth
/// matrix, fail-closed row-level scoping, spec-filter passthrough, maxRows
/// default/clamps + the meta.truncated flag, zero-measure rejection, and the
/// /query-shaped JSON response (columns/rows/meta). One class, one shared
/// factory — tests run sequentially against it.
/// </summary>
public sealed class UnderlyingApiTests : IClassFixture<DemoApiFactory>
{
    private const string Models = "/api/rcd/v1/models";
    private const string Underlying = "/api/rcd/v1/query/underlying";

    private readonly DemoApiFactory _factory;

    public UnderlyingApiTests(DemoApiFactory factory)
    {
        _factory = factory;
        _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
    }

    // ---------- auth ----------

    [Fact]
    public async Task Underlying_WithoutBearerToken_Returns401()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync(Underlying, UnderlyingBody(1));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Underlying_AgainstAnotherUsersPrivateModel_Returns404()
    {
        var alice = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(alice, UniqueName("Alice Underlying Model"));

        var response = await _factory.AsUser("bob").PostAsJsonAsync(Underlying, UnderlyingBody(modelId));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("rcd.model.not_found", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    // ---------- row-level scoping ----------

    [Fact]
    public async Task Underlying_FailsClosed_WhenRowFilterContributorDenies()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Denied Underlying"));

        try
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Deny;
            var executionsBefore = _factory.Executor.ExecutionCount;

            var response = await client.PostAsJsonAsync(Underlying, UnderlyingBody(modelId));

            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal(
                "rcd.query.denied_by_scope",
                (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
            Assert.Equal(executionsBefore, _factory.Executor.ExecutionCount); // executor never reached
        }
        finally
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        }
    }

    [Fact]
    public async Task Underlying_RowFiltersApply_ForRestrictedUser_Parameterized()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Scoped Underlying"));

        try
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.WestCustomersOnly;

            // A spec filter on customers pulls the table into the join plan,
            // and the row filter MUST ride along (same rule as export underlying).
            var response = await client.PostAsJsonAsync(
                Underlying, UnderlyingBody(modelId, withCustomerFilter: true));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var captured = _factory.Executor.LastQuery;
            Assert.NotNull(captured);
            Assert.DoesNotContain("West", captured.Sql); // value never reaches SQL text
            Assert.Contains(captured.Parameters, p => Equals(p.Value, "West"));
        }
        finally
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        }
    }

    // ---------- compilation shape / spec filters ----------

    [Fact]
    public async Task Underlying_RespectsSpecFilters_AllAnchorColumns_NoAggregation()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Filtered Underlying"));

        var response = await client.PostAsJsonAsync(
            Underlying, UnderlyingBody(modelId, withCustomerFilter: true));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var sql = _factory.Executor.LastQuery!.Sql;

        // All physical columns of the anchor table (public.orders), quoted.
        foreach (var column in new[] { "id", "customer_id", "order_total", "status", "order_date" })
        {
            Assert.Contains($"\"t0\".\"{column}\"", sql, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("GROUP BY", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("SUM(", sql, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN \"public\".\"customers\"", sql, StringComparison.Ordinal); // filter join
        Assert.Contains("ORDER BY \"t0\".\"id\" ASC NULLS LAST", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("North", sql); // filter value parameterized
        Assert.Contains(_factory.Executor.LastQuery!.Parameters, p => Equals(p.Value, "North"));
    }

    // ---------- maxRows default / clamps / truncation ----------

    [Fact]
    public async Task Underlying_MaxRowsDefaultsTo1000()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Default Cap Underlying"));

        var response = await client.PostAsJsonAsync(Underlying, UnderlyingBody(modelId));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1_000, _factory.Executor.LastOptions!.MaxRows);
        Assert.Contains(_factory.Executor.LastQuery!.Parameters, p => Equals(p.Value, 1_001L)); // LIMIT cap+1
    }

    [Theory]
    [InlineData(50_000, 10_000, 10_001L)] // ceiling
    [InlineData(0, 1, 2L)]                // floor
    [InlineData(-5, 1, 2L)]               // floor
    public async Task Underlying_MaxRowsIsClamped(int requested, int expectedCap, long expectedLimitParam)
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Clamp Underlying"));

        var response = await client.PostAsJsonAsync(Underlying, UnderlyingBody(modelId, maxRows: requested));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(expectedCap, _factory.Executor.LastOptions!.MaxRows);
        Assert.Contains(_factory.Executor.LastQuery!.Parameters, p => Equals(p.Value, expectedLimitParam));
    }

    [Fact]
    public async Task Underlying_RespectsRowCap_AndSetsTruncatedFlag()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Truncated Underlying"));

        _factory.Executor.Rows =
        [
            [1, 1, 10.5m, "open", new DateTime(2026, 1, 1)],
            [2, 1, 11.5m, "open", new DateTime(2026, 1, 2)],
            [3, 2, 12.5m, "closed", new DateTime(2026, 1, 3)],
            [4, 2, 13.5m, "open", new DateTime(2026, 1, 4)],
            [5, 3, 14.5m, "open", new DateTime(2026, 1, 5)],
        ];

        try
        {
            var response = await client.PostAsJsonAsync(Underlying, UnderlyingBody(modelId, maxRows: 3));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var json = await ReadJsonAsync(response);

            var rows = json["rows"]!.AsArray();
            Assert.Equal(3, rows.Count);
            Assert.Equal(3, json["meta"]!["rowCount"]!.GetValue<int>());
            Assert.True(json["meta"]!["truncated"]!.GetValue<bool>());
        }
        finally
        {
            _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        }
    }

    // ---------- validation ----------

    [Fact]
    public async Task Underlying_SpecWithZeroMeasures_Returns400()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("No Measures Underlying"));

        var body = new
        {
            spec = new
            {
                modelId,
                dimensions = Array.Empty<object>(),
                measures = Array.Empty<object>(),
                filters = Array.Empty<object>(),
                sort = Array.Empty<object>(),
            },
            maxRows = (int?)null,
        };

        var response = await client.PostAsJsonAsync(Underlying, body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("rcd.query.no_measures", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    // ---------- JSON shape ----------

    [Fact]
    public async Task Underlying_ResponseMatchesQueryResultShape()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Shape Underlying"));

        _factory.Executor.Rows =
        [
            [1, 1, 10.5m, "open", new DateTime(2026, 1, 1)],
            [2, 2, 20.5m, "closed", new DateTime(2026, 1, 2)],
        ];

        try
        {
            var response = await client.PostAsJsonAsync(Underlying, UnderlyingBody(modelId));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var json = await ReadJsonAsync(response);

            // Columns: every physical column of the anchor table, /query DTO shape.
            var columns = json["columns"]!.AsArray();
            var expected = new (string Name, string Type)[]
            {
                ("id", "integer"),
                ("customer_id", "integer"),
                ("order_total", "decimal"),
                ("status", "text"),
                ("order_date", "date"),
            };
            Assert.Equal(expected.Length, columns.Count);
            for (var i = 0; i < expected.Length; i++)
            {
                var column = columns[i]!;
                Assert.Equal(expected[i].Name, column["name"]!.GetValue<string>());
                Assert.Equal(expected[i].Name, column["label"]!.GetValue<string>());
                Assert.Equal("dimension", column["role"]!.GetValue<string>());
                Assert.Equal(expected[i].Type, column["type"]!.GetValue<string>());
                Assert.Equal($"public.orders.{expected[i].Name}", column["source"]!.GetValue<string>());
                Assert.Null(column["dateBucket"]?.GetValue<string>());
                Assert.Null(column["formatHint"]?.GetValue<string>());
            }

            // Rows: array of arrays, one cell per column.
            var rows = json["rows"]!.AsArray();
            Assert.Equal(2, rows.Count);
            Assert.Equal(expected.Length, rows[0]!.AsArray().Count);
            Assert.Equal(1, rows[0]![0]!.GetValue<int>());
            Assert.Equal("open", rows[0]![3]!.GetValue<string>());

            // Meta: rowCount + truncated present (not truncated here).
            Assert.Equal(2, json["meta"]!["rowCount"]!.GetValue<int>());
            Assert.False(json["meta"]!["truncated"]!.GetValue<bool>());
        }
        finally
        {
            _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        }
    }

    // ---------- helpers ----------

    private static string UniqueName(string prefix) => $"{prefix} {Guid.NewGuid():N}";

    private static async Task<JsonNode> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        return JsonNode.Parse(body) ?? throw new InvalidOperationException("Response body was empty.");
    }

    private async Task<int> CreateModelAsync(HttpClient client, string name)
    {
        var body = new
        {
            name,
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
            isShared = false,
        };

        var response = await client.PostAsJsonAsync(Models, body);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await ReadJsonAsync(response))["id"]!.GetValue<int>();
    }

    /// <summary>Sum(orders.order_total) spec — the first measure anchors public.orders.</summary>
    private static object UnderlyingBody(int modelId, int? maxRows = null, bool withCustomerFilter = false) => new
    {
        spec = new
        {
            modelId,
            dimensions = Array.Empty<object>(),
            measures = new object[]
            {
                new
                {
                    table = "public.orders",
                    column = "order_total",
                    aggregation = "sum",
                },
            },
            filters = withCustomerFilter
                ? new object[]
                {
                    new
                    {
                        table = "public.customers",
                        column = "region",
                        @operator = "eq",
                        values = new object[] { "North" },
                    },
                }
                : [],
            sort = Array.Empty<object>(),
        },
        maxRows,
    };
}
