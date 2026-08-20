using System.Security.Claims;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Caching;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Services;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// PER-MEASURE ERROR ISOLATION, end to end through ChartQueryService.
///
/// The owner's rule: "malformed measures should degrade individually and never
/// affect all tiles." So one broken measure must cost exactly one series, and
/// nothing else — not the other series, not the tile, not the email.
///
/// The counterweight is just as important and is tested here too: isolation is
/// NARROW. A broken dimension, a broken filter, a bad sort or an overlay the
/// merge rejects all still fail the whole query, and a query whose measures ALL
/// fail returns the original error rather than a silent blank chart.
/// </summary>
public sealed class ChartQueryServiceMeasureIsolationTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly ReconDashboardsDbContext _db;
    private readonly ReconDashboardsOptions _options;
    private readonly FakeCurrentUserProvider _currentUser = new();
    private readonly CountingRowFilterContributor _rowFilters = new();
    private readonly ChartQueryService _service;
    private readonly int _modelId;
    private readonly ModelDefinition _definition;

    public ChartQueryServiceMeasureIsolationTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new ReconDashboardsDbContext(
            new DbContextOptionsBuilder<ReconDashboardsDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();

        _options = new ReconDashboardsOptions();
        _options.RegisterDataSource(new DataSourceRegistration(
            TestFixtures.DemoConnectionName,
            "test",
            new DataSourceOptions(),
            _ => new FixedSchemaIntrospector(TestFixtures.BuildDemoSchema()),
            _ => new EchoExecutor(),
            new PostgresSqlDialect()));

        _definition = TestFixtures.BuildValidDemoModel();
        var record = new DataModelRecord
        {
            Name = "Demo model",
            DataSourceName = TestFixtures.DemoConnectionName,
            DefinitionJson = ModelJson.Serialize(_definition),
            OwnerUserId = _currentUser.UserId,
            IsShared = true,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow,
        };
        _db.DataModels.Add(record);
        _db.SaveChanges();
        _modelId = record.Id;

        var registry = new DataSourceRegistry(_options, new NullServiceProvider());
        var schemaCache = new MemorySchemaCache(registry);
        var validator = new SemanticModelValidator();
        var models = new DataModelService(
            _db, _currentUser, registry, schemaCache, validator, _options, TimeProvider.System);

        _service = new ChartQueryService(
            models, registry, schemaCache, validator, [_rowFilters], _currentUser, _options, _db,
            TimeProvider.System, NullLogger<ChartQueryService>.Instance);
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    // ------------------------------------------------------------------ helpers

    private static readonly ClaimsPrincipal Principal = new(new ClaimsIdentity());

    private static MeasureSpec Good(Aggregation aggregation = Aggregation.Sum, string? alias = null) =>
        new(null, "public.orders", "order_total", aggregation, alias);

    /// <summary>A reference to a measure that does not exist: QRY_UNKNOWN_MEASURE at measures[i].</summary>
    private static MeasureSpec Broken(string? alias = null) =>
        new(Guid.NewGuid(), null, null, null, alias);

    private ChartQuerySpec Spec(
        IReadOnlyList<MeasureSpec> measures,
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<FilterSpec>? filters = null,
        IReadOnlyList<SortSpec>? sort = null,
        IReadOnlyList<Measure>? definitions = null) =>
        new(_modelId,
            dimensions ?? [new DimensionSpec("public.customers", "region", null)],
            measures, filters ?? [], sort ?? [], null, null, null, null, definitions);

    private Task<ServiceResult<QueryOutcome>> RunAsync(ChartQuerySpec spec) =>
        _service.RunAsync(spec, Principal, CancellationToken.None);

    // -------------------------------------------------------- the isolation rule

    [Fact]
    public async Task OneBrokenMeasureOfThreeStillRendersTheOtherTwo()
    {
        var result = await RunAsync(Spec([Good(), Broken("Margin %"), Good(Aggregation.Count)]));

        Assert.True(result.Succeeded, result.Error?.Message);
        var compiled = result.Value!.Compiled;

        // Every position survives — this is the whole design.
        Assert.Equal(["dim0", "meas0", "meas1", "meas2"], compiled.Columns.Select(c => c.Name));
        Assert.Contains("CAST(NULL AS decimal) AS \"meas1\"", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("SUM(", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("COUNT(", compiled.Sql, StringComparison.Ordinal);

        // ...and the client is told exactly which one is blank and why.
        var failure = Assert.Single(compiled.FailedMeasures);
        Assert.Equal(1, failure.Index);
        Assert.Equal("Margin %", failure.Label);
        Assert.Equal("rcd.query.unknown_measure", failure.Code);
        Assert.Contains("no measure with id", failure.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task TwoBrokenMeasuresOfThreeAreBothReportedAndTheThirdStillRuns()
    {
        var result = await RunAsync(Spec([Broken("A"), Good(), Broken("B")]));

        Assert.True(result.Succeeded, result.Error?.Message);
        var compiled = result.Value!.Compiled;

        Assert.Equal([0, 2], compiled.FailedMeasures.Select(f => f.Index).Order());
        Assert.Equal(["A", "B"], compiled.FailedMeasures.Select(f => f.Label).Order());
        Assert.Equal(["dim0", "meas0", "meas1", "meas2"], compiled.Columns.Select(c => c.Name));
    }

    [Fact]
    public async Task AHealthyQueryReportsNoMeasureFailuresAtAll()
    {
        var result = await RunAsync(Spec([Good(), Good(Aggregation.Avg)]));

        Assert.True(result.Succeeded, result.Error?.Message);
        Assert.Empty(result.Value!.Compiled.FailedMeasures);
        Assert.Null(result.Value.Compiled.MeasureFailures);
    }

    // ------------------------------------------------- isolation stays NARROW

    [Fact]
    public async Task WhenEveryMeasureFailsTheOriginalErrorIsReturned()
    {
        // A blank chart with no error is worse than an error.
        var result = await RunAsync(Spec([Broken(), Broken()]));

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.query.unknown_measure", result.Error!.Code);
        // The FIRST failure is the one reported, path intact for the builder.
        var issue = Assert.Single(result.Error.Validation!.Errors);
        Assert.Equal("measures[0]", issue.Path);
    }

    [Fact]
    public async Task TheOnlyMeasureFailingIsNotIsolatedEither()
    {
        var result = await RunAsync(Spec([Broken()]));

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.query.unknown_measure", result.Error!.Code);
    }

    [Fact]
    public async Task ABrokenDimensionStillFailsTheWholeQueryEvenWithHealthyMeasures()
    {
        var result = await RunAsync(Spec(
            [Good(), Good(Aggregation.Count)],
            dimensions: [new DimensionSpec("public.customers", "no_such_column", null)]));

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.query.unknown_column", result.Error!.Code);
        Assert.Equal("dimensions[0]", Assert.Single(result.Error.Validation!.Errors).Path);
    }

    [Fact]
    public async Task ABrokenFilterStillFailsTheWholeQuery()
    {
        var result = await RunAsync(Spec(
            [Good()],
            filters: [new FilterSpec("public.customers", "no_such_column", FilterOperator.Eq, [])]));

        Assert.False(result.Succeeded);
        Assert.Equal("filters[0]", Assert.Single(result.Error!.Validation!.Errors).Path);
    }

    [Fact]
    public async Task ABrokenSortStillFailsTheWholeQuery()
    {
        var result = await RunAsync(Spec(
            [Good(), Broken()],
            sort: [new SortSpec(new SortTarget(SortTargetKind.Measure, 9), SortDirection.Asc)]));

        // The tombstone rescues measures[1]; the sort's out-of-range index is
        // not a measure's fault and is not isolatable.
        Assert.False(result.Succeeded);
        Assert.Equal("rcd.query.bad_sort", result.Error!.Code);
    }

    [Fact]
    public async Task AnOverlayTheMergeRejectsFailsTheWholeQuery()
    {
        // MeasureOverlay's duplicate-name rule protects EVERY model expression
        // that says [name]; it is a whole-query gate, not one series' problem.
        var collision = new Measure(
            Guid.NewGuid(), _definition.Measures[0].Name, "public.orders", Aggregation.Sum, "order_total");

        var result = await RunAsync(Spec(
            [new MeasureSpec(collision.Id, null, null, null, null), Good()],
            definitions: [collision]));

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.query.duplicate_measure_name", result.Error!.Code);
    }

    // --------------------------------------------------------------- the bounds

    [Fact]
    public async Task TheRetryIsBoundedAndDoesNotRepeatWorkPerBrokenMeasure()
    {
        _rowFilters.Reset();

        // Four measures, three broken, so four compilation passes. Resolution
        // fails BEFORE the join plan exists, so the three losing passes never
        // reach the row-filter collection at all: the host's contributor is
        // consulted exactly once per table of the plan that is finally emitted.
        // An unbounded retry would not merely blow this number — it would never
        // return.
        var result = await RunAsync(Spec([Broken(), Broken(), Good(), Broken()]));

        Assert.True(result.Succeeded, result.Error?.Message);
        Assert.Equal(3, result.Value!.Compiled.FailedMeasures.Count);
        Assert.Equal(["public.customers", "public.orders"], _rowFilters.Calls.Order());
    }

    [Fact]
    public async Task RowFiltersAreCollectedAgainstThePlanThatIsActuallyEmitted()
    {
        _rowFilters.Reset();

        // The surviving measure lives on public.orders and the dimension on
        // public.customers, so BOTH must be consulted — the fail-closed
        // contract is about the plan that is emitted, and a tombstone changes
        // that plan. A stale collection would be an unfiltered read.
        var result = await RunAsync(Spec([Broken(), Good()]));

        Assert.True(result.Succeeded, result.Error?.Message);
        Assert.Contains("public.orders", _rowFilters.Calls);
        Assert.Contains("public.customers", _rowFilters.Calls);
    }

    // ------------------------------------------------------------- path parsing

    [Theory]
    [InlineData("measures[0]", 0)]
    [InlineData("measures[12]", 12)]
    [InlineData("measures[3].column", 3)]
    [InlineData("measures[1].expression", 1)]
    public void AMeasurePathYieldsItsWireIndex(string path, int expected) =>
        Assert.Equal(expected, ChartQueryService.MeasureIndexOf(path));

    [Theory]
    [InlineData(null)]
    [InlineData("dimensions[0]")]
    [InlineData("filters[2]")]
    [InlineData("sort[0]")]
    [InlineData("limit")]
    [InlineData("query.table")]
    [InlineData("measures[]")]
    [InlineData("measures[-1]")]
    [InlineData("measures[x]")]
    [InlineData("measure[0]")]
    public void AnythingElseIsNotIsolatable(string? path) =>
        Assert.Null(ChartQueryService.MeasureIndexOf(path));

    // ------------------------------------------------------------------- fakes

    /// <summary>Returns one row shaped like the compiled column plan.</summary>
    private sealed class EchoExecutor : IQueryExecutor
    {
        public Task<ExecutedQuery> ExecuteAsync(
            CompiledQuery query, ExecutionOptions options, CancellationToken cancellationToken) =>
            Task.FromResult(new ExecutedQuery(
                [[.. query.Columns.Select(c => c.Role == ResultColumnRole.Dimension ? (object?)"West" : 1m)]],
                Truncated: false,
                ElapsedMs: 1));
    }

    /// <summary>Allows everything, and records every table it was consulted for.</summary>
    private sealed class CountingRowFilterContributor : IRowFilterContributor
    {
        public List<string> Calls { get; } = [];

        public void Reset() => Calls.Clear();

        public Task<RowFilterDecision> GetFiltersAsync(RowFilterContext context, CancellationToken cancellationToken)
        {
            Calls.Add($"{context.Schema}.{context.Table}");
            return Task.FromResult(RowFilterDecision.Allow);
        }
    }
}
