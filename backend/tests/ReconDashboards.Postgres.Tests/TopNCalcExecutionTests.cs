using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Finding 5 ground truth: flat Top-N composed with window-stage measures.
/// The window base must hold EXACTLY n rows — the historic +1 probe row made
/// PERCENTOFTOTAL shares sum below 1 and polluted running totals — and the
/// truncation signal now rides the trailing "__rcd_truncated" EXISTS column,
/// correct on both sides of the n-groups edge. Seed facts: customers.region
/// has exactly 4 groups (North/South/East/West), every order joins a customer.
/// </summary>
[Collection("postgres")]
public sealed class TopNCalcExecutionTests(PostgresContainerFixture fixture)
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly Measure Total = new(
        Guid.NewGuid(), "Total", "public.orders", Aggregation.Sum, "order_total");

    private static readonly Measure Share = new(
        Guid.NewGuid(), "Share", "public.orders", Aggregation.Sum, Column: null,
        FormatHint: null, Filters: null, Expression: "PERCENTOFTOTAL([Total])");

    private static readonly ModelDefinition Model = new(
        ModelDefinition.CurrentVersion,
        Tables: [new ModelTable("public", "orders"), new ModelTable("public", "customers")],
        Relationships:
        [
            new Relationship(
                Guid.NewGuid(), "public.orders", "customer_id", "public.customers", "id",
                Cardinality.ManyToOne, IsActive: true, RelationshipSource.Manual),
        ],
        Measures: [Total, Share]);

    private CompiledQuery Compile(TopNSpec topN, MeasureSpec secondMeasure)
    {
        var spec = new ChartQuerySpec(
            1,
            [new DimensionSpec("public.customers", "region", null)],
            [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null), secondMeasure],
            [], [], topN, null);
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, Model, fixture.RawSchema, limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    private async Task<(IReadOnlyList<object?[]> Rows, bool Truncated)> RunAsync(CompiledQuery compiled)
    {
        var executor = new PostgresQueryExecutor(fixture.DataSource);
        var executed = await executor.ExecuteAsync(
            compiled, new ExecutionOptions(MaxRows: 1000, TimeoutSeconds: 30), CancellationToken.None);
        return ChartQueryService.ApplyRowAccounting(compiled, executed.Rows, executed.Truncated);
    }

    private static MeasureSpec ShareRef() => new(Share.Id, null, null, null, null);

    [Fact]
    public async Task TopN_PercentOfTotal_SharesSumToOneOverExactlyNRows()
    {
        // 4 region groups, top 2: the probe row must NOT join the grand total.
        var compiled = Compile(new TopNSpec(2, 0, IncludeOthers: false), ShareRef());
        Assert.True(compiled.HasTruncationProbe);

        var (rows, truncated) = await RunAsync(compiled);

        Assert.Equal(2, rows.Count);
        Assert.True(truncated);
        // Probe column stripped: dim0, meas0, meas1 only.
        Assert.All(rows, r => Assert.Equal(3, r.Length));
        Assert.Equal(1m, rows.Sum(r => Convert.ToDecimal(r[2]!)), precision: 10);
    }

    [Fact]
    public async Task TopN_AtTheGroupCountEdge_IsNotTruncated()
    {
        // Exactly 4 groups, top 4: no leftover row, probe must read false.
        var compiled = Compile(new TopNSpec(4, 0, IncludeOthers: false), ShareRef());

        var (rows, truncated) = await RunAsync(compiled);

        Assert.Equal(4, rows.Count);
        Assert.False(truncated);
        Assert.Equal(1m, rows.Sum(r => Convert.ToDecimal(r[2]!)), precision: 10);
    }

    [Fact]
    public async Task TopN_RunningTotal_AccumulatesOnlyTheTopRows()
    {
        var compiled = Compile(
            new TopNSpec(2, 0, IncludeOthers: false),
            new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null,
                new MeasureCalcSpec(MeasureCalcKind.RunningTotal)));

        var (rows, truncated) = await RunAsync(compiled);

        Assert.Equal(2, rows.Count);
        Assert.True(truncated);
        // Output is axis-ordered; the LAST running total must equal the sum of
        // the two displayed raw values — a probe row would inflate it.
        var raws = rows.Select(r => Convert.ToDecimal(r[1]!)).ToArray();
        var running = rows.Select(r => Convert.ToDecimal(r[2]!)).ToArray();
        Assert.Equal(raws.Sum(), running[^1]);
    }
}
