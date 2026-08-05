using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace ReconDashboards.Api.Tests;

/// <summary>
/// End-to-end tests for POST /query/export through the demo host: auth matrix,
/// CSV shape/escaping/injection hardening, underlying-mode SQL shape, row-level
/// scoping (fail closed), row caps and the X-Rcd-Truncated header. One class,
/// one shared factory — tests run sequentially against it.
/// </summary>
public sealed class ExportApiTests : IClassFixture<DemoApiFactory>
{
    private const string Models = "/api/rcd/v1/models";
    private const string Export = "/api/rcd/v1/query/export";

    private readonly DemoApiFactory _factory;

    public ExportApiTests(DemoApiFactory factory)
    {
        _factory = factory;
        _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
    }

    // ---------- auth ----------

    [Fact]
    public async Task Export_WithoutBearerToken_Returns401()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync(Export, ExportBody(1, "summarized"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Export_AgainstAnotherUsersPrivateModel_Returns404()
    {
        var alice = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(alice, UniqueName("Alice Export Model"));

        var response = await _factory.AsUser("bob").PostAsJsonAsync(Export, ExportBody(modelId, "summarized"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("rcd.model.not_found", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
    }

    [Fact]
    public async Task Export_FailsClosed_WhenRowFilterContributorDenies()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Denied Export"));

        try
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Deny;
            var executionsBefore = _factory.Executor.ExecutionCount;

            foreach (var mode in new[] { "summarized", "underlying" })
            {
                var response = await client.PostAsJsonAsync(Export, ExportBody(modelId, mode));

                Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
                Assert.Equal(
                    "rcd.query.denied_by_scope",
                    (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
            }

            Assert.Equal(executionsBefore, _factory.Executor.ExecutionCount); // executor never reached
        }
        finally
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        }
    }

    [Fact]
    public async Task Export_RowFilters_ApplyToBothModes_Parameterized()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Scoped Export"));

        try
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.WestCustomersOnly;

            // Summarized: the dimension joins customers, so the scope binds there.
            var summarized = await client.PostAsJsonAsync(Export, ExportBody(modelId, "summarized"));
            Assert.Equal(HttpStatusCode.OK, summarized.StatusCode);
            AssertScopedSql();

            // Underlying: a spec filter on customers pulls the table into the
            // join plan, and the row filter MUST ride along.
            var underlying = await client.PostAsJsonAsync(
                Export, ExportBody(modelId, "underlying", withCustomerFilter: true));
            Assert.Equal(HttpStatusCode.OK, underlying.StatusCode);
            AssertScopedSql();
        }
        finally
        {
            _factory.RowFilters.Mode = SwitchableRowFilterContributor.FilterMode.Allow;
        }

        void AssertScopedSql()
        {
            var captured = _factory.Executor.LastQuery;
            Assert.NotNull(captured);
            Assert.DoesNotContain("West", captured.Sql); // value never reaches SQL text
            Assert.Contains(captured.Parameters, p => Equals(p.Value, "West"));
        }
    }

    // ---------- summarized CSV ----------

    [Fact]
    public async Task SummarizedExport_ReturnsCsvWithHeadersDispositionAndCrlfRows()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Csv Model"));

        var response = await client.PostAsJsonAsync(Export, ExportBody(modelId, "summarized"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/csv", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal("utf-8", response.Content.Headers.ContentType!.CharSet);

        var disposition = response.Content.Headers.ContentDisposition;
        Assert.NotNull(disposition);
        Assert.Equal("attachment", disposition.DispositionType);
        Assert.EndsWith(".csv", disposition.FileName!.Trim('"'), StringComparison.Ordinal);
        Assert.Contains("Csv Model", disposition.FileName, StringComparison.Ordinal);

        Assert.False(response.Headers.Contains("X-Rcd-Truncated"));

        var csv = await response.Content.ReadAsStringAsync();
        Assert.Equal("region,Sum of order_total\r\nWest,10\r\nEast,20\r\n", csv);
    }

    [Fact]
    public async Task SummarizedExport_AppliesRfc4180EscapingAndInjectionHardening()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Hardened Model"));

        _factory.Executor.Rows =
        [
            ["=cmd(),x", 10],           // formula + comma -> hardened then quoted
            ["Va\"lue", -20],           // embedded quote doubled; numeric minus NOT hardened
            ["line\nbreak", 30],        // newline forces quoting
            ["+plus", 40],
            ["@at", 50],
            ["-dash", 60],
        ];

        try
        {
            var response = await client.PostAsJsonAsync(
                Export, ExportBody(modelId, "summarized", measureAlias: "=SUM(A1)"));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var csv = await response.Content.ReadAsStringAsync();

            var expected =
                "region,'=SUM(A1)\r\n" +       // header label hardened too
                "\"'=cmd(),x\",10\r\n" +
                "\"Va\"\"lue\",-20\r\n" +
                "\"line\nbreak\",30\r\n" +
                "'+plus,40\r\n" +
                "'@at,50\r\n" +
                "'-dash,60\r\n";
            Assert.Equal(expected, csv);
        }
        finally
        {
            _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        }
    }

    [Fact]
    public async Task SummarizedExport_FormatsDatesIsoAndNumbersInvariant()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Formats Model"));

        _factory.Executor.Rows =
        [
            [new DateTime(2026, 3, 1), 1234.5m],
            [new DateTime(2026, 4, 1, 13, 45, 10), null],
        ];

        try
        {
            var response = await client.PostAsJsonAsync(
                Export, ExportBody(modelId, "summarized", monthAxis: true));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var csv = await response.Content.ReadAsStringAsync();
            var lines = csv.Split("\r\n");
            Assert.Equal("2026-03-01,1234.5", lines[1]);
            Assert.Equal("2026-04-01T13:45:10,", lines[2]);
        }
        finally
        {
            _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        }
    }

    [Fact]
    public async Task SummarizedExport_RunsCalcPipeline_HeaderCarriesCalcSuffix()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Calc Export"));

        _factory.Executor.Rows =
        [
            [new DateTime(2026, 1, 1), 10],
            [new DateTime(2026, 2, 1), 30],
        ];

        try
        {
            var response = await client.PostAsJsonAsync(
                Export, ExportBody(modelId, "summarized", monthAxis: true, runningTotal: true));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var csv = await response.Content.ReadAsStringAsync();
            Assert.StartsWith(
                "order_date (Month),Sum of order_total (running total)\r\n", csv, StringComparison.Ordinal);

            var captured = _factory.Executor.LastQuery!;
            Assert.Contains("__rcd_base", captured.Sql, StringComparison.Ordinal); // calc stage compiled in
        }
        finally
        {
            _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        }
    }

    // ---------- underlying mode ----------

    [Fact]
    public async Task UnderlyingExport_SelectsAllAnchorColumns_NoAggregation_Deterministic()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Underlying Model"));

        var response = await client.PostAsJsonAsync(
            Export, ExportBody(modelId, "underlying", withCustomerFilter: true));

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

        var csv = await response.Content.ReadAsStringAsync();
        Assert.StartsWith("id,customer_id,order_total,status,order_date\r\n", csv, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UnderlyingExport_RespectsRowCapAndSetsTruncationHeader()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Truncated Model"));

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
            var response = await client.PostAsJsonAsync(Export, ExportBody(modelId, "underlying", maxRows: 3));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(response.Headers.TryGetValues("X-Rcd-Truncated", out var values));
            Assert.Equal("true", Assert.Single(values!));

            Assert.Equal(3, _factory.Executor.LastOptions!.MaxRows);
            Assert.Contains(_factory.Executor.LastQuery!.Parameters, p => Equals(p.Value, 4L)); // LIMIT cap+1

            var csv = await response.Content.ReadAsStringAsync();
            var lines = csv.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
            Assert.Equal(4, lines.Length); // header + 3 rows
            Assert.Equal("1,1,10.5,open,2026-01-01", lines[1]);
        }
        finally
        {
            _factory.Executor.Rows = RecordingQueryExecutor.CannedRows;
        }
    }

    [Fact]
    public async Task UnderlyingExport_MaxRowsIsClampedToTheHardCeiling()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Clamp Model"));

        var response = await client.PostAsJsonAsync(Export, ExportBody(modelId, "underlying", maxRows: 500_000));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(100_000, _factory.Executor.LastOptions!.MaxRows);
        Assert.Contains(_factory.Executor.LastQuery!.Parameters, p => Equals(p.Value, 100_001L));
    }

    // ---------- mode validation ----------

    [Fact]
    public async Task Export_UnknownMode_Returns400()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("Bad Mode Model"));

        var response = await client.PostAsJsonAsync(Export, ExportBody(modelId, "bogus"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Export_MissingMode_Returns400WithErrorCode()
    {
        var client = _factory.AsUser("alice");
        var modelId = await CreateModelAsync(client, UniqueName("No Mode Model"));

        var response = await client.PostAsJsonAsync(Export, new { spec = RegionTotalSpec(modelId) });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("rcd.query.bad_export", (await ReadJsonAsync(response))["errorCode"]!.GetValue<string>());
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

    private static object RegionTotalSpec(
        int modelId,
        string? measureAlias = null,
        bool withCustomerFilter = false,
        bool monthAxis = false,
        bool runningTotal = false) => new
    {
        modelId,
        dimensions = new object[]
        {
            monthAxis
                ? new { table = "public.orders", column = "order_date", dateBucket = (string?)"month" }
                : new { table = "public.customers", column = "region", dateBucket = (string?)null },
        },
        measures = new object[]
        {
            new
            {
                table = "public.orders",
                column = "order_total",
                aggregation = "sum",
                alias = measureAlias,
                calc = runningTotal ? new { kind = "runningTotal" } : null,
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
    };

    private static object ExportBody(
        int modelId,
        string mode,
        int? maxRows = null,
        string? measureAlias = null,
        bool withCustomerFilter = false,
        bool monthAxis = false,
        bool runningTotal = false) => new
    {
        spec = RegionTotalSpec(modelId, measureAlias, withCustomerFilter, monthAxis, runningTotal),
        mode,
        maxRows,
    };
}
