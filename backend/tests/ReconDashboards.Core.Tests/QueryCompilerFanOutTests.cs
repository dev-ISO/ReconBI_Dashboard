using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// QRY_FANOUT warnings: joining a MANY-side child table multiplies the rows of
/// every table outside that child's subtree, so aggregates over those tables may
/// be over-counted. The standard star case (fact base joining ONE-side dimension
/// tables) must never warn.
/// </summary>
public class QueryCompilerFanOutTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec> dimensions,
        IReadOnlyList<MeasureSpec> measures) =>
        new(1, dimensions, measures, [], [], null, null);

    private static CompiledQuery Compile(ChartQuerySpec spec, ModelDefinition? model = null)
    {
        var limits = new RcdLimits();
        model ??= TestFixtures.BuildValidDemoModel();
        var prepared = Compiler.Prepare(spec, model, TestFixtures.BuildDemoSchema(), limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    /// <summary>Demo model extended with inspections (many) -> orders (many) -> customers (one).</summary>
    private static ModelDefinition BuildChainModel() => TestFixtures.BuildModel(
        tables:
        [
            TestFixtures.BuildModelTable("public", "customers"),
            TestFixtures.BuildModelTable("public", "orders"),
            TestFixtures.BuildModelTable("public", "inspections"),
        ],
        relationships:
        [
            TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
            TestFixtures.BuildRelationship("public.inspections", "order_id", "public.orders", "id"),
        ]);

    [Fact]
    public void StarSchemaSumOnFactBaseProducesNoWarnings()
    {
        // Base = orders (many side of the edge); customers joins on as the ONE
        // side -> orders rows are never multiplied.
        var compiled = Compile(Spec(
            dimensions: [new DimensionSpec("public.customers", "region", null)],
            measures: [new MeasureSpec(null, "public.orders", "order_total", Aggregation.Sum, null)]));

        Assert.Empty(compiled.Warnings);
    }

    [Fact]
    public void MeasureOnOneSideWithManySideJoinedWarnsFanOut()
    {
        // Base = customers (the measure's table); grouping by orders.status
        // joins orders, the MANY side -> each customer row repeats per order.
        var compiled = Compile(Spec(
            dimensions: [new DimensionSpec("public.orders", "status", null)],
            measures: [new MeasureSpec(null, "public.customers", "credit_limit", Aggregation.Sum, null)]));

        var warning = Assert.Single(compiled.Warnings);
        Assert.Equal("QRY_FANOUT", warning.Code);
        Assert.Equal(
            "Measure 'Sum of credit_limit' may be over-counted: joining 'public.orders' multiplies rows of "
            + "'public.customers' (relationship public.orders->public.customers).",
            warning.Message);
    }

    [Fact]
    public void MeasureOnTheJoinedManySideItselfDoesNotWarn()
    {
        // Count over orders lives in the fanned-out subtree and is not
        // over-counted; only the customers measure warns.
        var compiled = Compile(Spec(
            dimensions: [new DimensionSpec("public.orders", "status", null)],
            measures:
            [
                new MeasureSpec(null, "public.customers", "credit_limit", Aggregation.Sum, null),
                new MeasureSpec(null, "public.orders", null, Aggregation.Count, null),
            ]));

        var warning = Assert.Single(compiled.Warnings);
        Assert.Equal("QRY_FANOUT", warning.Code);
        Assert.Contains("'Sum of credit_limit'", warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EachManySideStepOnTheChainWarnsOnceForAnUpstreamMeasure()
    {
        // customers <- orders <- inspections: both joins are many-side children,
        // and each independently multiplies customers rows.
        var compiled = Compile(
            Spec(
                dimensions: [new DimensionSpec("public.inspections", "result", null)],
                measures: [new MeasureSpec(null, "public.customers", "credit_limit", Aggregation.Sum, null)]),
            BuildChainModel());

        Assert.Equal(2, compiled.Warnings.Count);
        Assert.All(compiled.Warnings, w => Assert.Equal("QRY_FANOUT", w.Code));
        Assert.Contains(compiled.Warnings, w => w.Message.Contains("joining 'public.orders'", StringComparison.Ordinal));
        Assert.Contains(compiled.Warnings, w => w.Message.Contains("joining 'public.inspections'", StringComparison.Ordinal));
    }

    [Fact]
    public void OneToOneRelationshipDoesNotWarn()
    {
        // A one-to-one edge never multiplies rows even when entered from the
        // relationship's FromTable side.
        var model = TestFixtures.BuildModel(
            tables:
            [
                TestFixtures.BuildModelTable("public", "customers"),
                TestFixtures.BuildModelTable("public", "orders"),
            ],
            relationships:
            [
                TestFixtures.BuildRelationship(
                    "public.orders", "customer_id", "public.customers", "id", Cardinality.OneToOne),
            ]);

        var compiled = Compile(
            Spec(
                dimensions: [new DimensionSpec("public.orders", "status", null)],
                measures: [new MeasureSpec(null, "public.customers", "credit_limit", Aggregation.Sum, null)]),
            model);

        Assert.Empty(compiled.Warnings);
    }
}
