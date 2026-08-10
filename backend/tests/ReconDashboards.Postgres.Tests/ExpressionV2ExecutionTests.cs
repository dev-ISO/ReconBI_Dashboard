using Npgsql;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Grammar v2 semantics against the real container: IF/SWITCH/DIVIDE
/// (including the alternate-on-zero path), scalar functions, nested measure
/// inlining, and PERCENTOFTOTAL values (each share = group / grand total over
/// the displayed rows; shares sum to 1). Seed facts: 200 orders, totals
/// i * 1.25 for i = 1..200 (sum 25125, avg 125.625).
/// </summary>
[Collection("postgres")]
public sealed class ExpressionV2ExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly ExecutionOptions Options = new(MaxRows: 100, TimeoutSeconds: 30);

    private IQueryExecutor Executor()
    {
        var connectionString = new NpgsqlConnectionStringBuilder(fixture.DataSource.ConnectionString)
        {
            Password = "postgres",
        }.ConnectionString;

        var options = new ReconDashboardsOptions();
        options.AddPostgresDataSource("exprv2-demo", o =>
        {
            o.ConnectionString = connectionString;
            o.EnforceReadOnlySession = true;
        });
        var registry = new DataSourceRegistry(options, new NullServices());
        Assert.True(registry.TryGet("exprv2-demo", out var source));
        return source.Executor!;
    }

    private sealed class NullServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private static Measure ExpressionMeasure(string name, string expression) =>
        new(Guid.NewGuid(), name, "public.orders", Aggregation.Sum, Column: null,
            FormatHint: null, Filters: null, Expression: expression);

    private CompiledQuery Compile(Measure measure, IReadOnlyList<Measure>? extraMeasures = null, DimensionSpec? dimension = null)
    {
        var model = new ModelDefinition(
            ModelDefinition.CurrentVersion,
            Tables: [new ModelTable("public", "orders")],
            Relationships: [],
            Measures: [measure, .. extraMeasures ?? []]);
        var spec = new ChartQuerySpec(
            1,
            dimension is null ? [] : [dimension],
            [new MeasureSpec(measure.Id, null, null, null, null)],
            [], [], null, null);
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, model, fixture.RawSchema, limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    private async Task<object?> SingleValueAsync(Measure measure, IReadOnlyList<Measure>? extraMeasures = null)
    {
        var result = await Executor().ExecuteAsync(Compile(measure, extraMeasures), Options, CancellationToken.None);
        var row = Assert.Single(result.Rows);
        return row[^1];
    }

    [Fact]
    public async Task IfConditionEvaluates()
    {
        var value = await SingleValueAsync(ExpressionMeasure("Flag", "IF(count(*) > 100, 1, 0)"));
        Assert.Equal(1m, Convert.ToDecimal(value));
    }

    [Fact]
    public async Task IfWithoutElseYieldsNullWhenFalse()
    {
        var value = await SingleValueAsync(ExpressionMeasure("Maybe", "IF(count(*) > 1000, 1)"));
        Assert.Null(value);
    }

    [Fact]
    public async Task SwitchMatchesItsCase()
    {
        // count(*) - 199 = 1 -> first pair fires.
        var value = await SingleValueAsync(ExpressionMeasure("Switched", "SWITCH(count(*) - 199, 1, 123, 0)"));
        Assert.Equal(123m, Convert.ToDecimal(value));
    }

    [Fact]
    public async Task DivideReturnsTheAlternateOnZeroDenominator()
    {
        var value = await SingleValueAsync(
            ExpressionMeasure("Safe", "DIVIDE(SUM(public.orders.order_total), COUNT(*) - COUNT(*), 42)"));
        Assert.Equal(42m, Convert.ToDecimal(value));
    }

    [Fact]
    public async Task DivideWithoutAlternateIsNullOnZeroDenominator()
    {
        var value = await SingleValueAsync(
            ExpressionMeasure("Bare", "DIVIDE(SUM(public.orders.order_total), COUNT(*) - COUNT(*))"));
        Assert.Null(value);
    }

    [Fact]
    public async Task ScalarFunctionsComputeKnownValues()
    {
        // avg(order_total) = 125.625 -> ROUND(.., 0) = 126; COALESCE skips BLANK().
        var value = await SingleValueAsync(
            ExpressionMeasure("Rounded", "COALESCE(BLANK(), ROUND(AVG(public.orders.order_total), 0))"));
        Assert.Equal(126m, Convert.ToDecimal(value));
    }

    [Fact]
    public async Task NestedMeasureReferencesInlineAndCompute()
    {
        var total = new Measure(Guid.NewGuid(), "Total", "public.orders", Aggregation.Sum, "order_total");
        var inner = ExpressionMeasure("Inner", "[Total] / count(*)");
        var outer = ExpressionMeasure("Outer", "[Inner] * 2");

        var value = await SingleValueAsync(outer, [total, inner]);

        Assert.Equal(251.25m, Convert.ToDecimal(value)); // 2 * avg = 2 * 125.625
    }

    [Fact]
    public async Task PercentOfTotalSharesMatchTheBaselineAndSumToOne()
    {
        var total = new Measure(Guid.NewGuid(), "Total", "public.orders", Aggregation.Sum, "order_total");
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total])");
        var byStatus = new DimensionSpec("public.orders", "status", null);

        var baseline = await Executor().ExecuteAsync(
            Compile(total, [share], byStatus), Options, CancellationToken.None);
        var shares = await Executor().ExecuteAsync(
            Compile(share, [total], byStatus), Options, CancellationToken.None);

        Assert.Equal(3, shares.Rows.Count); // open / closed / cancelled

        var grandTotal = baseline.Rows.Sum(r => Convert.ToDecimal(r[1]!));
        var baselineByStatus = baseline.Rows.ToDictionary(r => (string)r[0]!, r => Convert.ToDecimal(r[1]!));

        decimal sum = 0;
        foreach (var row in shares.Rows)
        {
            var expected = baselineByStatus[(string)row[0]!] / grandTotal;
            var actual = Convert.ToDecimal(row[1]!);
            Assert.Equal(expected, actual, precision: 10);
            sum += actual;
        }

        Assert.Equal(1m, sum, precision: 10);
    }

    [Fact]
    public async Task PercentOfTotalWithoutDimensionsIsOne()
    {
        var total = new Measure(Guid.NewGuid(), "Total", "public.orders", Aggregation.Sum, "order_total");
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total])");

        var value = await SingleValueAsync(share, [total]);

        Assert.Equal(1m, Convert.ToDecimal(value));
    }
}
