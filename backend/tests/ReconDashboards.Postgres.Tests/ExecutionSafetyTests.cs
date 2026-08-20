using System.Diagnostics;
using System.Text.Json;
using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Execution-safety tests against the real container: compiled statements run
/// through the SAME wiring production uses — AddPostgresDataSource (which turns
/// EnforceReadOnlySession into default_transaction_read_only=on plus a
/// statement_timeout) resolved through a DataSourceRegistry. Covers parameter
/// binding under hostile input, the read-only session guard, server-side
/// timeouts, row caps, Top-N arithmetic, LIKE escaping, median arithmetic,
/// and row-level scoping.
/// </summary>
[Collection("postgres")]
public sealed class ExecutionSafetyTests
{
    private const string ExecSourceName = "exec-demo";
    private const string TimeoutSourceName = "exec-timeout";

    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    /// <summary>Customers + orders + the FK relationship, mirroring the seeded schema.</summary>
    private static readonly ModelDefinition Model = new(
        ModelDefinition.CurrentVersion,
        Tables: [new ModelTable("public", "customers"), new ModelTable("public", "orders")],
        Relationships:
        [
            new Relationship(
                Guid.NewGuid(), "public.orders", "customer_id", "public.customers", "id",
                Cardinality.ManyToOne, IsActive: true, RelationshipSource.Fk),
        ],
        Measures: []);

    private readonly PostgresContainerFixture _fixture;
    private readonly DataSourceRegistry _registry;

    public ExecutionSafetyTests(PostgresContainerFixture fixture)
    {
        _fixture = fixture;

        // NpgsqlDataSource.ConnectionString strips security-sensitive values, so
        // the password must be restored; the Testcontainers PostgreSqlBuilder
        // default (used by the fixture) is "postgres".
        var connectionString = new NpgsqlConnectionStringBuilder(fixture.DataSource.ConnectionString)
        {
            Password = "postgres",
        }.ConnectionString;

        // The production registration path: EnforceReadOnlySession=true makes
        // BuildDataSource append -c default_transaction_read_only=on and
        // -c statement_timeout=<seconds * 1000> to every pooled session.
        var options = new ReconDashboardsOptions();
        options.AddPostgresDataSource(ExecSourceName, o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
        });
        options.AddPostgresDataSource(TimeoutSourceName, o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
            o.StatementTimeoutSeconds = 1;
        });

        _registry = new DataSourceRegistry(options, new NullServices());
    }

    // ---------- helpers ----------

    private IQueryExecutor Executor(string name = ExecSourceName)
    {
        Assert.True(_registry.TryGet(name, out var source));
        Assert.NotNull(source.Executor);
        return Assert.IsType<PostgresQueryExecutor>(source.Executor);
    }

    private static JsonElement Json(string value) => JsonSerializer.SerializeToElement(value);

    private static DimensionSpec Dim(string table, string column) => new(table, column, null);

    private static MeasureSpec CountOrders() => new(null, "public.orders", null, Aggregation.Count, null);

    private static MeasureSpec SumOrderTotal() => new(null, "public.orders", "order_total", Aggregation.Sum, null);

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec> dimensions,
        IReadOnlyList<MeasureSpec> measures,
        IReadOnlyList<FilterSpec>? filters = null,
        TopNSpec? topN = null) =>
        new(ModelId: 1, dimensions, measures, filters ?? [], Sort: [], topN, Limit: null);

    private CompiledQuery Compile(
        ChartQuerySpec spec, IReadOnlyDictionary<string, IReadOnlyList<RowFilter>>? rowFilters = null)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, Model, _fixture.RawSchema, limits);
        return Compiler.Emit(prepared, spec, rowFilters ?? NoRowFilters, limits, new DataSourceOptions());
    }

    private CompiledQuery CompileDistinct(string? search)
    {
        var limits = new RcdLimits();
        var spec = new DistinctValuesSpec(ModelId: 1, "public.customers", "name", search, Filters: [], Limit: null);
        var prepared = Compiler.PrepareDistinct(spec, Model, _fixture.RawSchema, limits);
        return Compiler.EmitDistinct(prepared, NoRowFilters);
    }

    private Task<ExecutedQuery> ExecuteAsync(CompiledQuery query, int maxRows = 1000) =>
        Executor().ExecuteAsync(query, new ExecutionOptions(maxRows, TimeoutSeconds: 30), CancellationToken.None);

    /// <summary>Ground-truth scalar straight through the fixture's unrestricted data source.</summary>
    private async Task<long> CountAsync(string sql)
    {
        await using var command = _fixture.DataSource.CreateCommand(sql);
        return (long)(await command.ExecuteScalarAsync())!;
    }

    // ---------- 1. injection payloads are bound as data ----------

    [Fact]
    public async Task EqFilterWithDropTablePayload_ReturnsNoRowsAndLeavesTableIntact()
    {
        var spec = Spec(
            [Dim("public.customers", "name")],
            [CountOrders()],
            filters:
            [
                new FilterSpec("public.customers", "name", FilterOperator.Eq,
                    [Json("'; DROP TABLE customers; --")]),
            ]);

        var result = await ExecuteAsync(Compile(spec));

        Assert.Empty(result.Rows);
        Assert.Equal(50, await CountAsync("SELECT count(*) FROM customers"));
    }

    [Fact]
    public async Task ContainsFilterWithDropTablePayload_ReturnsNoRowsAndLeavesTableIntact()
    {
        var spec = Spec(
            [Dim("public.customers", "name")],
            [CountOrders()],
            filters:
            [
                new FilterSpec("public.customers", "name", FilterOperator.Contains,
                    [Json("Robert\"); DROP TABLE orders;--")]),
            ]);

        var result = await ExecuteAsync(Compile(spec));

        Assert.Empty(result.Rows);
        Assert.Equal(200, await CountAsync("SELECT count(*) FROM orders"));
    }

    [Fact]
    public async Task InFilterWithTautologyPayload_ReturnsNoRows()
    {
        var spec = Spec(
            [Dim("public.customers", "name")],
            [CountOrders()],
            filters:
            [
                new FilterSpec("public.customers", "name", FilterOperator.In,
                    [Json("' OR '1'='1")]),
            ]);

        var result = await ExecuteAsync(Compile(spec));

        Assert.Empty(result.Rows);
    }

    // ---------- 2. read-only session ----------

    [Fact]
    public async Task ReadOnlySession_RejectsUpdateThatBypassedTheCompiler()
    {
        // Deliberately hand-built, NOT compiler output: proves the session guard
        // stops writes even if something ever slipped past the compiler.
        var rogue = new CompiledQuery(
            "UPDATE customers SET region = 'X'", Parameters: [], Columns: [], Warnings: []);

        var ex = await Assert.ThrowsAsync<PostgresException>(
            () => Executor().ExecuteAsync(rogue, new ExecutionOptions(10, 30), CancellationToken.None));

        Assert.Equal("25006", ex.SqlState); // read_only_sql_transaction
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM customers WHERE region = 'X'"));
    }

    // ---------- 3. statement timeout ----------

    [Fact]
    public async Task StatementTimeout_CancelsLongQueryServerSide()
    {
        var sleep = new CompiledQuery("SELECT pg_sleep(5)", Parameters: [], Columns: [], Warnings: []);
        var executor = Executor(TimeoutSourceName);

        // Client CommandTimeout is 30s here, so only the server-side
        // statement_timeout=1000 from the option path can be what fires.
        var stopwatch = Stopwatch.StartNew();
        var ex = await Assert.ThrowsAsync<PostgresException>(
            () => executor.ExecuteAsync(sleep, new ExecutionOptions(10, TimeoutSeconds: 30), CancellationToken.None));
        stopwatch.Stop();

        Assert.Equal("57014", ex.SqlState); // query_canceled
        Assert.True(
            stopwatch.ElapsedMilliseconds < 4000,
            $"Statement timeout took {stopwatch.ElapsedMilliseconds} ms; expected ~1s, never the full 5s sleep.");
    }

    // ---------- 4. row cap + truncation ----------

    [Fact]
    public async Task MaxRows_CapsResultAndReportsTruncation()
    {
        // Grouping orders by primary key produces exactly 200 groups.
        var compiled = Compile(Spec([Dim("public.orders", "id")], [SumOrderTotal()]));

        var capped = await ExecuteAsync(compiled, maxRows: 50);
        Assert.Equal(50, capped.Rows.Count);
        Assert.True(capped.Truncated);

        var full = await ExecuteAsync(compiled, maxRows: 500);
        Assert.Equal(200, full.Rows.Count);
        Assert.False(full.Truncated);
    }

    // ---------- 5. Top-N + Others on real data ----------

    [Fact]
    public async Task TopNWithOthers_FoldsRemainderAndPreservesTotals()
    {
        var spec = Spec(
            [Dim("public.customers", "region")],
            [SumOrderTotal()],
            topN: new TopNSpec(N: 2, ByMeasureIndex: 0, IncludeOthers: true));

        var result = await ExecuteAsync(Compile(spec));

        // Ground truth straight from the database (4 regions, no NULLs in seed).
        var expected = new List<(string Region, decimal Total)>();
        await using (var command = _fixture.DataSource.CreateCommand(
            """
            SELECT c.region, SUM(o.order_total)
            FROM orders o
            JOIN customers c ON c.id = o.customer_id
            GROUP BY c.region
            ORDER BY 2 DESC, 1 ASC
            """))
        await using (var reader = await command.ExecuteReaderAsync())
        {
            while (await reader.ReadAsync())
            {
                expected.Add((reader.GetString(0), reader.GetDecimal(1)));
            }
        }

        Assert.Equal(4, expected.Count);
        var grandTotal = expected.Sum(e => e.Total);

        // Columns: dim0, is_topn, meas0. Two named top rows first, ranked by the measure.
        Assert.Equal(3, result.Rows.Count);
        Assert.Equal(expected[0].Region, result.Rows[0][0]);
        Assert.True((bool)result.Rows[0][1]!);
        Assert.Equal(expected[0].Total, Assert.IsType<decimal>(result.Rows[0][2]));
        Assert.Equal(expected[1].Region, result.Rows[1][0]);
        Assert.True((bool)result.Rows[1][1]!);
        Assert.Equal(expected[1].Total, Assert.IsType<decimal>(result.Rows[1][2]));

        // Others: NULL dimension, is_topn=false, sum equals total minus top-2.
        var others = result.Rows[2];
        Assert.Null(others[0]);
        Assert.False((bool)others[1]!);
        Assert.Equal(
            grandTotal - expected[0].Total - expected[1].Total,
            Assert.IsType<decimal>(others[2]));
    }

    // ---------- 6. distinct values + LIKE escaping ----------

    [Fact]
    public async Task DistinctValues_EscapesLikeWildcardsInSearch()
    {
        // "50%" must match literally. If '%' leaked into the pattern unescaped,
        // %50%% would wrongly match "Customer 50" — so zero rows proves escaping.
        var wildcard = await ExecuteAsync(CompileDistinct("50%"));
        Assert.Empty(wildcard.Rows);

        // Lower-case search also proves the ILIKE (case-insensitive) path.
        var normal = await ExecuteAsync(CompileDistinct("customer 5"));
        Assert.Equal(
            ["Customer 5", "Customer 50"],
            normal.Rows.Select(r => Assert.IsType<string>(r[0])).ToArray());
    }

    // ---------- 7. median vs direct PERCENTILE_CONT ----------

    [Fact]
    public async Task MedianMeasure_MatchesDirectPercentileContQuery()
    {
        var spec = Spec(
            [Dim("public.customers", "region")],
            [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Median, null)]);

        var compiled = Compile(spec);
        Assert.Contains("PERCENTILE_CONT(0.5) WITHIN GROUP", compiled.Sql, StringComparison.Ordinal);

        var result = await ExecuteAsync(compiled);

        // Ground truth straight from the database; PERCENTILE_CONT over a
        // numeric column returns double precision, ordered like the compiled
        // query's default dimension sort.
        var expected = new List<(string Region, double Median)>();
        await using (var command = _fixture.DataSource.CreateCommand(
            """
            SELECT c.region, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.order_total)
            FROM orders o
            JOIN customers c ON c.id = o.customer_id
            GROUP BY c.region
            ORDER BY c.region
            """))
        await using (var reader = await command.ExecuteReaderAsync())
        {
            while (await reader.ReadAsync())
            {
                expected.Add((reader.GetString(0), reader.GetDouble(1)));
            }
        }

        Assert.Equal(4, expected.Count);
        Assert.Equal(expected.Count, result.Rows.Count);
        for (var i = 0; i < expected.Count; i++)
        {
            Assert.Equal(expected[i].Region, result.Rows[i][0]);
            Assert.Equal(expected[i].Median, Assert.IsType<double>(result.Rows[i][1]), 6);
        }
    }

    // ---------- 8. row-level scoping ----------

    [Fact]
    public async Task RowFilters_ScopeResultsToTheContributedPredicate()
    {
        var rowFilters = new Dictionary<string, IReadOnlyList<RowFilter>>
        {
            ["public.customers"] = [new RowFilter("region", RowFilterOperator.Equals, ["West"])],
        };
        var spec = Spec([Dim("public.customers", "region")], [CountOrders()]);

        var result = await ExecuteAsync(Compile(spec, rowFilters));

        var expectedOrders = await CountAsync(
            "SELECT count(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.region = 'West'");
        Assert.InRange(expectedOrders, 1, 199); // the filter genuinely restricts

        var row = Assert.Single(result.Rows);
        Assert.Equal("West", row[0]);
        Assert.Equal(expectedOrders, row[1]);
    }

    /// <summary>
    /// *** THE ROW-LEVEL-SECURITY REGRESSION FOR THE MEASURE-DEFINITIONS WIRE.
    /// DO NOT "FIX" THIS BY RELAXING IT — A FAILURE HERE IS AN RLS BYPASS,
    /// NEVER A COSMETIC ONE. ***
    ///
    /// A query carries a caller-supplied measure DEFINITION (a dashboard- or
    /// personal-scoped measure) whose EXPRESSION names public.customers, while
    /// nothing else in the spec does: no dimension, no filter, and the
    /// measure's own home table is public.orders. The host contributes a row
    /// filter for public.customers.
    ///
    /// The overlay must be merged into the ModelDefinition BEFORE
    /// QueryCompiler.Prepare (MeasureOverlay.Merge in ChartQueryService), which
    /// is the ONLY thing that puts public.customers into `involved` →
    /// JoinPathResolver → PreparedQuery.Plan.Tables → the row-filter collection
    /// → AppendRowFilterPredicates. Resolving caller definitions later —
    /// inside ResolveMeasure, say — compiles and returns plausible numbers
    /// while SILENTLY reading customers with no row filter at all.
    ///
    /// So: the predicate must be in the SQL, and the number must be the
    /// restricted one.
    /// </summary>
    [Fact]
    public async Task OverlayExpressionTable_StillReceivesItsRowFilters()
    {
        var overlay = new Measure(
            Guid.NewGuid(), "Overlay Credit", "public.orders", Aggregation.Sum,
            Column: null, FormatHint: null, Filters: null,
            Expression: "SUM(public.customers.credit_limit)");

        // No dimensions, no filters: public.customers is reachable ONLY through
        // the overlay expression.
        var spec = new ChartQuerySpec(
            ModelId: 1, Dimensions: [], Measures: [new MeasureSpec(overlay.Id, null, null, null, null)],
            Filters: [], Sort: [], TopN: null, Limit: null, Offset: null, Having: null,
            Definitions: [overlay]);

        var rowFilters = new Dictionary<string, IReadOnlyList<RowFilter>>
        {
            ["public.customers"] = [new RowFilter("region", RowFilterOperator.Equals, ["West"])],
        };

        var limits = new RcdLimits();
        var effective = MeasureOverlay.Merge(Model, spec.Definitions, limits);
        var prepared = Compiler.Prepare(spec, effective, _fixture.RawSchema, limits);

        // The join plan is what row filters attach to — prove customers is in it.
        Assert.Contains("public.customers", prepared.Plan.Tables);

        var filtered = Compiler.Emit(prepared, spec, rowFilters, limits, new DataSourceOptions());
        var unfiltered = Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());

        // The predicate reached the SQL, bound as a parameter (never inlined).
        Assert.Contains("\"region\"", filtered.Sql, StringComparison.Ordinal);
        Assert.Contains(filtered.Parameters, p => Equals(p.Value, "West"));
        Assert.DoesNotContain("\"region\"", unfiltered.Sql, StringComparison.Ordinal);

        var filteredRow = Assert.Single((await ExecuteAsync(filtered)).Rows);
        var unfilteredRow = Assert.Single((await ExecuteAsync(unfiltered)).Rows);

        await using var command = _fixture.DataSource.CreateCommand("""
            SELECT sum(c.credit_limit)
            FROM orders o
            LEFT JOIN customers c ON o.customer_id = c.id
            WHERE c.region = 'West'
            """);
        var expected = (decimal)(await command.ExecuteScalarAsync())!;

        Assert.Equal(expected, Convert.ToDecimal(filteredRow[0]));
        // And it genuinely restricted: without the filter the number is bigger.
        Assert.True(
            Convert.ToDecimal(unfilteredRow[0]) > expected,
            "The row filter must actually change the result, or this test proves nothing.");
    }

    private sealed class NullServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }
}
