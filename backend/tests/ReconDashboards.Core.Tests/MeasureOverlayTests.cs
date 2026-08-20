using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying;
using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The rules MeasureOverlay.Merge enforces on caller-supplied measure
/// definitions (dashboard- and personal-scoped measures arriving on the query
/// wire), plus the transitive collection the callers use to decide WHICH
/// definitions to send.
/// </summary>
public class MeasureOverlayTests
{
    private static Measure Plain(string name, Guid? id = null) =>
        new(id ?? Guid.NewGuid(), name, "public.orders", Aggregation.Sum, "order_total");

    private static Measure Calc(string name, string expression, Guid? id = null) =>
        new(id ?? Guid.NewGuid(), name, "public.orders", Aggregation.Sum, Column: null,
            FormatHint: null, Filters: null, Expression: expression);

    private static ModelDefinition ModelWith(params Measure[] measures) =>
        new(ModelDefinition.CurrentVersion, Tables: [new ModelTable("public", "orders")],
            Relationships: [], Measures: measures);

    private static string CodeOf(Action act) =>
        Assert.Throws<QueryCompilationException>(act).Code;

    [Fact]
    public void NoDefinitions_ReturnsTheModelUntouched()
    {
        var model = ModelWith(Plain("Revenue"));

        Assert.Same(model, MeasureOverlay.Merge(model, null, new RcdLimits()));
        Assert.Same(model, MeasureOverlay.Merge(model, [], new RcdLimits()));
    }

    [Fact]
    public void Definitions_AreAppendedAfterTheModelsOwnMeasures()
    {
        var model = ModelWith(Plain("Revenue"));
        var overlay = Plain("Dashboard Revenue");

        var merged = MeasureOverlay.Merge(model, [overlay], new RcdLimits());

        Assert.Equal(2, merged.Measures.Count);
        Assert.Equal("Revenue", merged.Measures[0].Name);
        Assert.Same(overlay, merged.Measures[1]);
        // The stored definition is untouched (record `with`, not mutation).
        Assert.Single(model.Measures);
    }

    [Fact]
    public void CountCap_IsEnforced()
    {
        var limits = new RcdLimits { MaxQueryMeasureDefinitions = 2 };
        var overlay = new[] { Plain("A"), Plain("B"), Plain("C") };

        Assert.Equal(
            "QRY_TOO_MANY_DEFINITIONS",
            CodeOf(() => MeasureOverlay.Merge(ModelWith(), overlay, limits)));
    }

    [Fact]
    public void ByteCap_IsEnforced()
    {
        var limits = new RcdLimits { MaxQueryMeasureDefinitionBytes = 32 };

        Assert.Equal(
            "QRY_DEFINITIONS_TOO_LARGE",
            CodeOf(() => MeasureOverlay.Merge(ModelWith(), [Plain("A measure with a long name")], limits)));
    }

    /// <summary>
    /// QueryCompiler.ResolveMeasure takes the FIRST id match, so a colliding
    /// GUID would silently SHADOW the model's measure for every chart that
    /// cites it.
    /// </summary>
    [Fact]
    public void GuidAlreadyInTheModel_IsRejected()
    {
        var id = Guid.NewGuid();
        var model = ModelWith(Plain("Revenue", id));

        Assert.Equal(
            "QRY_DUPLICATE_MEASURE_ID",
            CodeOf(() => MeasureOverlay.Merge(model, [Plain("Something else", id)], new RcdLimits())));
    }

    [Fact]
    public void GuidDuplicatedWithinTheOverlay_IsRejected()
    {
        var id = Guid.NewGuid();

        Assert.Equal(
            "QRY_DUPLICATE_MEASURE_ID",
            CodeOf(() => MeasureOverlay.Merge(ModelWith(), [Plain("A", id), Plain("B", id)], new RcdLimits())));
    }

    /// <summary>
    /// MeasureExpressionParser.ResolveMeasureRef reports Ambiguous when two
    /// measures share a name, so an overlay name that collides does not merely
    /// shadow — it breaks every UNRELATED model expression saying [ThatName].
    /// </summary>
    [Fact]
    public void NameAlreadyInTheModel_IsRejected()
    {
        var model = ModelWith(Plain("Revenue"));

        Assert.Equal(
            "QRY_DUPLICATE_MEASURE_NAME",
            CodeOf(() => MeasureOverlay.Merge(model, [Plain("Revenue")], new RcdLimits())));
    }

    [Fact]
    public void NameCollisionIsCaseInsensitive_BecauseResolutionFallsBackToCaseInsensitive()
    {
        var model = ModelWith(Plain("Revenue"));

        Assert.Equal(
            "QRY_DUPLICATE_MEASURE_NAME",
            CodeOf(() => MeasureOverlay.Merge(model, [Plain("REVENUE")], new RcdLimits())));
    }

    [Fact]
    public void NameDuplicatedWithinTheOverlay_IsRejected()
    {
        Assert.Equal(
            "QRY_DUPLICATE_MEASURE_NAME",
            CodeOf(() => MeasureOverlay.Merge(ModelWith(), [Plain("Same"), Plain("Same")], new RcdLimits())));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void NamelessDefinition_IsRejected(string name)
    {
        Assert.Equal(
            "QRY_BAD_DEFINITION",
            CodeOf(() => MeasureOverlay.Merge(ModelWith(), [Plain(name)], new RcdLimits())));
    }

    [Fact]
    public void IdlessDefinition_IsRejected()
    {
        Assert.Equal(
            "QRY_BAD_DEFINITION",
            CodeOf(() => MeasureOverlay.Merge(ModelWith(), [Plain("A", Guid.Empty)], new RcdLimits())));
    }

    // ---------- transitive collection ----------

    [Fact]
    public void CollectReferenced_FollowsExpressionReferencesTransitively()
    {
        var leaf = Plain("Leaf");
        var middle = Calc("Middle", "[Leaf] * 2");
        var top = Calc("Top", "[Middle] + 1");
        var unrelated = Plain("Unrelated");

        var collected = MeasureOverlay.CollectReferenced([leaf, middle, top, unrelated], [top.Id]);

        Assert.Equal(["Leaf", "Middle", "Top"], collected.Select(m => m.Name));
    }

    [Fact]
    public void CollectReferenced_SkipsIdsTheScopeDoesNotHold()
    {
        var scoped = Plain("Scoped");

        Assert.Empty(MeasureOverlay.CollectReferenced([scoped], [Guid.NewGuid()]));
        Assert.Empty(MeasureOverlay.CollectReferenced([], [scoped.Id]));
    }

    [Fact]
    public void CollectReferenced_TerminatesOnACycle()
    {
        // The compiler rejects cycles later (QRY_MEASURE_CYCLE); collection must
        // not hang before it gets the chance.
        var a = Calc("A", "[B] + 1");
        var b = Calc("B", "[A] + 1");

        Assert.Equal(2, MeasureOverlay.CollectReferenced([a, b], [a.Id]).Count);
    }

    [Fact]
    public void ExpressionReferenceNames_ReadsBracketedNamesOnly()
    {
        Assert.Equal(
            ["Total Order Value", "Order Count"],
            MeasureOverlay.ExpressionReferenceNames("[Total Order Value] / [Order Count]"));
        Assert.Empty(MeasureOverlay.ExpressionReferenceNames("SUM(public.orders.order_total)"));
        Assert.Empty(MeasureOverlay.ExpressionReferenceNames("[]"));
        Assert.Empty(MeasureOverlay.ExpressionReferenceNames("[unterminated"));
    }
}
