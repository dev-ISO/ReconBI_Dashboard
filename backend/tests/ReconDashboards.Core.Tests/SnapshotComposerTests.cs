using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Rendering;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The ONE render path behind subscription emails: parse the layout →
/// impersonate the owner → run every tile → compose per the content config.
/// The painter is a FAKE here on purpose — every decision worth testing (which
/// tiles become images, how they are wired to the body, which tables survive,
/// what a preview does differently) is a composition decision, provable without
/// a raster library anywhere near the assertion.
///
/// The legacy contract has its own test: a NULL content config must produce
/// EXACTLY what the pre-content renderer produced, character for character.
/// </summary>
public sealed class SnapshotComposerTests : IDisposable
{
    private static readonly DateTime Now = new(2026, 8, 18, 12, 0, 0, DateTimeKind.Utc);

    private readonly SqliteConnection _connection;
    private readonly ServiceProvider _services;
    private readonly FakeExecutor _executor = new();
    private readonly FakeChartImageRenderer _renderer = new();
    private readonly ReconDashboardsOptions _options;
    private readonly int _modelId;

    public SnapshotComposerTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        _options = new ReconDashboardsOptions();
        _options.RegisterDataSource(new DataSourceRegistration(
            TestFixtures.DemoConnectionName,
            "test",
            new DataSourceOptions(),
            _ => new FixedSchemaIntrospector(TestFixtures.BuildDemoSchema()),
            _ => _executor,
            new PostgresSqlDialect()));

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(_options);
        services.AddSingleton<TimeProvider>(new FixedClock(Now));
        services.AddSingleton<IDataSourceRegistry>(sp => new DataSourceRegistry(_options, sp));
        services.AddSingleton<ISchemaCache, MemorySchemaCache>();
        services.AddSingleton<SemanticModelValidator>();
        services.AddDbContext<ReconDashboardsDbContext>(o => o.UseSqlite(_connection));
        _services = services.BuildServiceProvider();

        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        db.Database.EnsureCreated();

        var model = new DataModelRecord
        {
            DataSourceName = TestFixtures.DemoConnectionName,
            Name = "Demo model",
            DefinitionJson = ModelJson.Serialize(TestFixtures.BuildValidDemoModel()),
            OwnerUserId = "alice",
            IsShared = true,
            CreatedAtUtc = Now.AddDays(-30),
            UpdatedAtUtc = Now.AddDays(-30),
        };
        db.DataModels.Add(model);
        db.SaveChanges();
        _modelId = model.Id;
    }

    public void Dispose()
    {
        _services.Dispose();
        _connection.Dispose();
    }

    // ------------------------------------------------------------------ layouts

    /// <summary>A chart tile of the given family, with the given id/title.</summary>
    private static string ChartTile(string id, string title, string type) => $$"""
        { "id": "{{id}}", "kind": "chart", "chart": { "id": "c-{{id}}", "type": "{{type}}",
          "title": "{{title}}", "query": {
            "axis": { "table": "public.customers", "column": "region" },
            "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
            "filters": [] } } }
        """;

    /// <summary>A measure-only tile: the shape-triggered KPI branch.</summary>
    private static string KpiTile(string id, string title, string type = "kpi") => $$"""
        { "id": "{{id}}", "kind": "chart", "chart": { "id": "c-{{id}}", "type": "{{type}}",
          "title": "{{title}}", "query": {
            "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
            "filters": [] } } }
        """;

    private static string Layout(params string[] tiles) => $$"""
        { "version": 1, "tiles": [], "slicers": [],
          "pages": [{ "id": "p1", "name": "Main", "tiles": [{{string.Join(",", tiles)}}] }] }
        """;

    private DashboardRecord Dashboard(string layoutJson, string ownerUserId = "alice")
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ReconDashboardsDbContext>();
        var dashboard = new DashboardRecord
        {
            Name = "Ops Dashboard",
            ModelId = _modelId,
            LayoutJson = layoutJson,
            OwnerUserId = ownerUserId,
            IsShared = true,
            CreatedAtUtc = Now.AddDays(-30),
            UpdatedAtUtc = Now.AddDays(-30),
        };
        db.Dashboards.Add(dashboard);
        db.SaveChanges();
        return dashboard;
    }

    private async Task<ComposedSnapshot> ComposeAsync(
        DashboardRecord dashboard,
        SubscriptionContentConfig? content,
        SnapshotMode mode = SnapshotMode.EmailDelivery,
        SubscriptionFormat format = SubscriptionFormat.Html)
    {
        using var scope = _services.CreateScope();
        var composer = new SnapshotComposer(
            scope.ServiceProvider,
            _services.GetRequiredService<TimeProvider>(),
            _options,
            _renderer,
            NullLogger<SnapshotComposer>.Instance);
        return await composer.ComposeAsync(
            dashboard, _modelId, "alice", format, content, mode, CancellationToken.None);
    }

    private static SubscriptionContentConfig Content(
        SubscriptionContentBody body,
        IReadOnlyList<string>? excluded = null,
        int imageWidth = SubscriptionContentConfig.DefaultImageWidth,
        int maxTableRows = SubscriptionContentConfig.DefaultMaxTableRows) =>
        new(body, excluded ?? [], imageWidth, maxTableRows);

    // ------------------------------------------------------- the legacy contract

    [Fact]
    public async Task ANullContentConfigProducesExactlyTheLegacyRendererOutput()
    {
        // The upgrade must be invisible to every pre-0.14 subscription: not
        // "equivalent", not "close" — the same string.
        var dashboard = Dashboard(Layout(
            ChartTile("t1", "Sales by region", "column"),
            KpiTile("t2", "Revenue")));

        var composed = await ComposeAsync(dashboard, content: null);

        var expected = SnapshotRenderer.RenderHtml(
            "Ops Dashboard", Now, await RenderPagesAsync(dashboard),
            TimeZoneInfo.FindSystemTimeZoneById(_options.ScheduleTimeZoneId),
            _options.ScheduleTimeZoneLabel);

        Assert.Equal(expected, composed.Html);
        Assert.Equal("Ops Dashboard — dashboard snapshot", composed.Subject);
        Assert.Empty(composed.InlineImages);
        Assert.Equal(0, _renderer.Calls); // the painter is never even asked
    }

    [Fact]
    public async Task AnExplicitTablesConfigIsTheSameBytesAsTheLegacyPath()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales by region", "column")));

        var legacy = await ComposeAsync(dashboard, content: null);
        var explicitTables = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Tables));

        Assert.Equal(legacy.Html, explicitTables.Html);
        Assert.Equal(0, _renderer.Calls);
    }

    // -------------------------------------------------------------- charts mode

    [Fact]
    public async Task ChartsModeEmitsOneCidImagePerVisualTileAndSuppressesItsTable()
    {
        var dashboard = Dashboard(Layout(
            ChartTile("t1", "Sales by region", "column"),
            ChartTile("t2", "Trend", "line")));

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts));

        Assert.Equal(2, _renderer.Calls);
        Assert.Equal(2, composed.InlineImages.Count);
        // cid naming is page/tile positional, exactly as the design pins it.
        Assert.Equal(["tile-0-0@rcd", "tile-0-1@rcd"], composed.InlineImages.Select(i => i.ContentId));
        Assert.All(composed.InlineImages, image =>
        {
            Assert.Equal("image/png", image.ContentType);
            Assert.True(image.Inline);
            Assert.Equal(FakeChartImageRenderer.Png, image.Bytes);
            Assert.Null(image.Content); // binary channel, never the text one
        });
        Assert.Equal(["tile-0-0.png", "tile-0-1.png"], composed.InlineImages.Select(i => i.FileName));

        // The body references each image and drops the tables the chart replaces.
        Assert.Contains("<img src=\"cid:tile-0-0@rcd\"", composed.Html, StringComparison.Ordinal);
        Assert.Contains("<img src=\"cid:tile-0-1@rcd\"", composed.Html, StringComparison.Ordinal);
        Assert.DoesNotContain("<table", composed.Html, StringComparison.Ordinal);
        // Tile titles still frame each image — the shell is unchanged.
        Assert.Contains("Sales by region", composed.Html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheImageTagIsTheFluidEmailSafeShapeWithAnAltTextOfTheTileTitle()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales & Margin <West>", "column")));

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts, imageWidth: 900));

        Assert.Contains(
            "width=\"900\" alt=\"Sales &amp; Margin &lt;West&gt;\" "
            + "style=\"width:100%;max-width:900px;height:auto;display:block\"",
            composed.Html,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(480)]
    [InlineData(600)]
    [InlineData(900)]
    public async Task ImageWidthReachesBothTheGeometryAndTheImgTag(int width)
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales", "column")));

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts, imageWidth: width));

        Assert.Equal(width, _renderer.LastLayout!.Width);
        Assert.Contains($"max-width:{width}px", composed.Html, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------- both mode

    [Fact]
    public async Task BothModePutsTheImageFirstAndThatTilesTableRightUnderIt()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales by region", "column")));

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Both));

        Assert.Single(composed.InlineImages);
        var imageAt = composed.Html.IndexOf("<img src=\"cid:", StringComparison.Ordinal);
        var tableAt = composed.Html.IndexOf("<table", StringComparison.Ordinal);
        Assert.True(imageAt >= 0 && tableAt > imageAt, "The table must follow its image.");
    }

    // -------------------------------------------------------------- tile rules

    [Fact]
    public async Task KpiAndTableTilesKeepTheirHtmlBlocksInEveryBodyMode()
    {
        var dashboard = Dashboard(Layout(
            KpiTile("t1", "Revenue"),                 // kpi BY TYPE
            KpiTile("t2", "Orders", type: "column"),  // ...and by SHAPE (0 dims, 1 row)
            ChartTile("t3", "Detail", "table")));

        foreach (var body in new[] { SubscriptionContentBody.Charts, SubscriptionContentBody.Both })
        {
            _renderer.Reset();
            var composed = await ComposeAsync(dashboard, Content(body));

            Assert.Equal(0, _renderer.Calls);      // nothing here is a chart
            Assert.Empty(composed.InlineImages);
            Assert.DoesNotContain("<img src=\"cid:", composed.Html, StringComparison.Ordinal);
            Assert.Contains("font-size:26px", composed.Html, StringComparison.Ordinal); // KPI numbers
            Assert.Contains("<table", composed.Html, StringComparison.Ordinal);         // the table tile
        }
    }

    [Fact]
    public async Task AFailedTileKeepsItsRedNoteAndNeverBecomesABlankImage()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales", "column")));
        _executor.Fail = true;

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts));

        Assert.Equal(0, _renderer.Calls);
        Assert.Empty(composed.InlineImages);
        Assert.Contains("#b91c1c", composed.Html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APainterFailureDowngradesThatOneTileToItsTableAndShipsTheEmail()
    {
        // A drawing bug must cost one picture, not the whole 6 a.m. send.
        var dashboard = Dashboard(Layout(
            ChartTile("t1", "Sales by region", "column"),
            ChartTile("t2", "Trend", "line")));
        _renderer.ThrowOnCall = 1;

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts));

        Assert.Single(composed.InlineImages);                       // only the second tile drew
        Assert.Equal("tile-0-1@rcd", composed.InlineImages[0].ContentId);
        Assert.Contains("<table", composed.Html, StringComparison.Ordinal); // the first fell back
        Assert.Contains("Sales by region", composed.Html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnknownChartFamilyDegradesToItsTableRatherThanAnEmptyPicture()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Future", "sunburst")));

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts));

        Assert.Equal(0, _renderer.Calls);
        Assert.Contains("<table", composed.Html, StringComparison.Ordinal);
    }

    // ----------------------------------------------------------- excluded tiles

    [Fact]
    public async Task ExcludedTilesLeaveTheEmailEntirelyIncludingTheirQueryWork()
    {
        var dashboard = Dashboard(Layout(
            ChartTile("t1", "Sales by region", "column"),
            ChartTile("t2", "Trend", "line"),
            ChartTile("t3", "Detail", "table")));

        var composed = await ComposeAsync(
            dashboard, Content(SubscriptionContentBody.Charts, excluded: ["t2"]), format: SubscriptionFormat.Csv);

        Assert.DoesNotContain("Trend", composed.Html, StringComparison.Ordinal);
        Assert.Contains("Sales by region", composed.Html, StringComparison.Ordinal);
        // Not merely hidden: the excluded tile is never queried and never
        // reaches the CSV either.
        Assert.Equal(2, _executor.Count);
        Assert.DoesNotContain("Trend", composed.Csv!, StringComparison.Ordinal);
        // The surviving chart keeps a POSITIONAL cid — indices are of the
        // filtered list, so cids stay dense and unique.
        Assert.Equal("tile-0-0@rcd", Assert.Single(composed.InlineImages).ContentId);
    }

    [Fact]
    public async Task ExcludingEveryTileStillProducesAValidIfEmptyEmail()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales", "column")));

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts, excluded: ["t1"]));

        Assert.Equal(0, _executor.Count);
        Assert.Contains("No chart tiles on this page.", composed.Html, StringComparison.Ordinal);
        Assert.Empty(composed.InlineImages);
    }

    [Fact]
    public async Task AnExcludedIdThatNoLongerExistsIsSimplyIgnored()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales", "column")));

        var composed = await ComposeAsync(
            dashboard, Content(SubscriptionContentBody.Charts, excluded: ["deleted-tile"]));

        Assert.Single(composed.InlineImages);
    }

    // ------------------------------------------------------------- max rows

    [Fact]
    public async Task MaxTableRowsReplacesTheHardFiftyRowCap()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Detail", "table")));
        _executor.Rows = [.. Enumerable.Range(0, 120).Select(i => new object?[] { $"R{i}", (decimal)i })];

        var tight = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Tables, maxTableRows: 5));
        Assert.Contains("115 more rows not shown.", tight.Html, StringComparison.Ordinal);

        var wide = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Tables, maxTableRows: 500));
        Assert.DoesNotContain("more rows not shown", wide.Html, StringComparison.Ordinal);

        // It applies to the tables that ride along in 'both' too.
        var both = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Both, maxTableRows: 5));
        Assert.Contains("115 more rows not shown.", both.Html, StringComparison.Ordinal);
    }

    // ----------------------------------------------------------------- preview

    [Fact]
    public async Task PreviewInlinesTheSameImagesAsDataUrisAndAttachesNothing()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales by region", "column")));

        var email = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts));
        _renderer.Reset();
        var preview = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts), SnapshotMode.Preview);

        Assert.Empty(preview.InlineImages);
        Assert.DoesNotContain("cid:", preview.Html, StringComparison.Ordinal);
        Assert.Contains(
            "data:image/png;base64," + Convert.ToBase64String(FakeChartImageRenderer.Png),
            preview.Html,
            StringComparison.Ordinal);
        // Same subject and same surrounding body as the delivered email — a
        // preview that could drift from the send would be worse than none.
        Assert.Equal(email.Subject, preview.Subject);
        Assert.Equal(
            email.Html.Replace("cid:tile-0-0@rcd", "data:image/png;base64," + Convert.ToBase64String(FakeChartImageRenderer.Png), StringComparison.Ordinal),
            preview.Html);
    }

    [Fact]
    public async Task APreviewNeverBuildsTheCsvEvenForACsvSubscription()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales", "column")));

        var email = await ComposeAsync(
            dashboard, Content(SubscriptionContentBody.Charts), format: SubscriptionFormat.Csv);
        var preview = await ComposeAsync(
            dashboard, Content(SubscriptionContentBody.Charts), SnapshotMode.Preview, SubscriptionFormat.Csv);

        Assert.NotNull(email.Csv);
        Assert.Null(preview.Csv);
    }

    // --------------------------------------------------------------------- csv

    [Fact]
    public async Task TheCsvStaysAdditiveAndIdenticalInEveryBodyMode()
    {
        var dashboard = Dashboard(Layout(ChartTile("t1", "Sales by region", "column")));

        var tables = await ComposeAsync(
            dashboard, Content(SubscriptionContentBody.Tables), format: SubscriptionFormat.Csv);
        var charts = await ComposeAsync(
            dashboard, Content(SubscriptionContentBody.Charts), format: SubscriptionFormat.Csv);
        var both = await ComposeAsync(
            dashboard, Content(SubscriptionContentBody.Both), format: SubscriptionFormat.Csv);

        Assert.NotNull(tables.Csv);
        Assert.Equal(tables.Csv, charts.Csv);
        Assert.Equal(tables.Csv, both.Csv);
        Assert.Contains("# Main / Sales by region", tables.Csv, StringComparison.Ordinal);

        // An html-format subscription attaches nothing, in any body mode.
        Assert.Null((await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts))).Csv);
    }

    // ------------------------------------------------------------- multi-page

    [Fact]
    public async Task CidsAreUniqueAcrossPages()
    {
        var dashboard = Dashboard($$"""
            { "version": 1, "tiles": [], "slicers": [],
              "pages": [
                { "id": "p1", "name": "Main", "tiles": [{{ChartTile("t1", "A", "column")}}] },
                { "id": "p2", "name": "Detail", "tiles": [{{ChartTile("t2", "B", "column")}},
                                                          {{ChartTile("t3", "C", "bar")}}] }
              ] }
            """);

        var composed = await ComposeAsync(dashboard, Content(SubscriptionContentBody.Charts));

        Assert.Equal(
            ["tile-0-0@rcd", "tile-1-0@rcd", "tile-1-1@rcd"],
            composed.InlineImages.Select(i => i.ContentId));
        Assert.Equal(3, composed.InlineImages.Select(i => i.ContentId).Distinct().Count());
    }

    // ---------------------------------------------------------------- helpers

    /// <summary>Runs the tiles the way the composer does, for the byte-comparison test.</summary>
    private async Task<IReadOnlyList<RenderedPage>> RenderPagesAsync(DashboardRecord dashboard)
    {
        using var scope = _services.CreateScope();
        var queryService = ImpersonatedQuery.Create(scope.ServiceProvider, "alice");
        var principal = ImpersonatedQuery.PrincipalFor("alice");
        var pages = new List<RenderedPage>();
        foreach (var page in LayoutSnapshotParser.Parse(dashboard.LayoutJson, _modelId))
        {
            var tiles = new List<RenderedTile>();
            foreach (var tile in page.Tiles)
            {
                var outcome = await queryService.RunAsync(tile.Spec, principal, CancellationToken.None);
                tiles.Add(outcome.Succeeded
                    ? new RenderedTile(tile, outcome.Value!.Compiled.Columns, outcome.Value.Rows, null)
                    : new RenderedTile(tile, [], [], outcome.Error!.Message));
            }

            pages.Add(new RenderedPage(page.Name, tiles));
        }

        return pages;
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    /// <summary>
    /// Stands in for SkiaSharp: records what it was asked to draw and returns a
    /// recognizable byte pattern, so the composer's wiring is assertable
    /// exactly.
    /// </summary>
    private sealed class FakeChartImageRenderer : IChartImageRenderer
    {
        public static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4];

        public int Calls { get; private set; }

        public ChartLayout? LastLayout { get; private set; }

        /// <summary>1-based call ordinal that should throw (0 = never).</summary>
        public int ThrowOnCall { get; set; }

        public void Reset()
        {
            Calls = 0;
            LastLayout = null;
            ThrowOnCall = 0;
        }

        public byte[] RenderPng(ChartLayout layout)
        {
            Calls++;
            LastLayout = layout;
            return Calls == ThrowOnCall
                ? throw new InvalidOperationException("Simulated painter failure.")
                : Png;
        }
    }

    private sealed class FakeExecutor : IQueryExecutor
    {
        public IReadOnlyList<object?[]> Rows { get; set; } = [["West", 10m], ["East", 20m]];

        public bool Fail { get; set; }

        public int Count { get; private set; }

        public Task<ExecutedQuery> ExecuteAsync(
            CompiledQuery query, ExecutionOptions options, CancellationToken cancellationToken)
        {
            Count++;
            if (Fail)
            {
                throw new InvalidOperationException("Simulated query failure.");
            }

            // Measure-only tiles (the KPI shape) get a single one-cell row.
            var rows = query.Columns.Any(c => c.Role == ResultColumnRole.Dimension)
                ? Rows
                : [[123m]];
            return Task.FromResult(new ExecutedQuery(rows, Truncated: false, ElapsedMs: 1));
        }
    }
}
