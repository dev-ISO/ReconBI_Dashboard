using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Column FriendlyName overrides in result-column LABELS. Dimensions have
/// resolved through the overrides since the beginning; these tests pin the two
/// paths that used to emit raw column names: inline measures ("Sum of
/// order_total" -&gt; "Sum of Order Total ($)") and EmitUnderlying's row-level
/// export ("See records" drill-through + CSV). In both, ONLY the label
/// changes — SQL identifiers and wire column NAMES stay raw.
/// </summary>
public class QueryCompilerFriendlyLabelTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    /// <summary>Demo model with FriendlyName overrides on two orders columns.</summary>
    private static ModelDefinition ModelWithOverrides() => TestFixtures.BuildModel(
        tables:
        [
            TestFixtures.BuildModelTable("public", "customers"),
            TestFixtures.BuildModelTable("public", "orders", columns:
            [
                new ModelColumn("order_total", FriendlyName: "Order Total ($)"),
                new ModelColumn("status", FriendlyName: "Order Status"),
            ]),
        ],
        relationships:
        [
            TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
        ]);

    private static MeasureSpec SumOrderTotal(string? alias = null, MeasureCalcSpec? calc = null) =>
        new(null, "public.orders", "order_total", Aggregation.Sum, alias, calc);

    private static ChartQuerySpec Spec(params MeasureSpec[] measures) =>
        new(1, [new DimensionSpec("public.customers", "region", null)], measures, [], [], null, null);

    private static CompiledQuery Compile(ChartQuerySpec spec, ModelDefinition model)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, model, TestFixtures.BuildDemoSchema(), limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    [Fact]
    public void InlineMeasureLabelResolvesFriendlyName()
    {
        var compiled = Compile(Spec(SumOrderTotal()), ModelWithOverrides());

        Assert.Equal("Sum of Order Total ($)", compiled.Columns[1].Label);
        // The wire NAME stays positional/raw — only the label reads friendly.
        Assert.Equal("meas0", compiled.Columns[1].Name);
    }

    [Fact]
    public void InlineMeasureLabelKeepsRawNameWithoutAnOverride()
    {
        var compiled = Compile(Spec(SumOrderTotal()), TestFixtures.BuildValidDemoModel());

        Assert.Equal("Sum of order_total", compiled.Columns[1].Label);
    }

    [Fact]
    public void ExplicitAliasStillWinsOverFriendlyName()
    {
        var compiled = Compile(Spec(SumOrderTotal(alias: "My Total")), ModelWithOverrides());

        Assert.Equal("My Total", compiled.Columns[1].Label);
    }

    [Fact]
    public void CalcSuffixComposesWithTheFriendlyLabel()
    {
        var compiled = Compile(
            Spec(SumOrderTotal(calc: new MeasureCalcSpec(MeasureCalcKind.RunningTotal))),
            ModelWithOverrides());

        Assert.Equal("Sum of Order Total ($) (running total)", compiled.Columns[1].Label);
    }

    [Fact]
    public void UnderlyingColumnsLabelThroughOverridesNamesStayRaw()
    {
        var model = ModelWithOverrides();
        var spec = new ChartQuerySpec(1, [], [SumOrderTotal()], [], [], null, null);
        var prepared = Compiler.PrepareUnderlying(spec, model, TestFixtures.BuildDemoSchema(), new RcdLimits());
        var compiled = Compiler.EmitUnderlying(prepared, NoRowFilters, maxRows: 100);

        var byName = compiled.Columns.ToDictionary(c => c.Name, c => c.Label);
        Assert.Equal("Order Total ($)", byName["order_total"]);
        Assert.Equal("Order Status", byName["status"]);
        // Columns without an override keep their raw name as the label.
        Assert.Equal("order_date", byName["order_date"]);
        // Every wire NAME stays the raw identifier (the SQL selects raw columns).
        Assert.All(compiled.Columns, c => Assert.Contains(c.Name, prepared.Table.Columns.Select(t => t.Name)));
    }

    [Fact]
    public void UnderlyingWithoutOverridesIsUnchanged()
    {
        var spec = new ChartQuerySpec(1, [], [SumOrderTotal()], [], [], null, null);
        var prepared = Compiler.PrepareUnderlying(
            spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), new RcdLimits());
        var compiled = Compiler.EmitUnderlying(prepared, NoRowFilters, maxRows: 100);

        Assert.All(compiled.Columns, c => Assert.Equal(c.Name, c.Label));
    }
}
