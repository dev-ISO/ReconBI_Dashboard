using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Validator coverage for grammar v2 and nested measure references: MDL012
/// for the new parse surface, MDL013 for references to PERCENTOFTOTAL
/// measures, MDL016 for cycles and over-deep reference chains.
/// </summary>
public class SemanticModelValidatorExpressionV2Tests
{
    private static Measure ExpressionMeasure(string name, string expression) =>
        new(Guid.NewGuid(), name, "public.orders", Aggregation.Sum, Column: null,
            FormatHint: null, Filters: null, Expression: expression);

    private static ValidationResult Validate(params Measure[] measures)
    {
        var demo = TestFixtures.BuildValidDemoModel();
        var orderCount = TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count);
        var model = demo with { Measures = [.. demo.Measures, orderCount, .. measures] };
        return new SemanticModelValidator().Validate(model, TestFixtures.BuildDemoSchema());
    }

    [Theory]
    [InlineData("IF([Order Count] > 0, [Total Order Value] / [Order Count], 0)")]
    [InlineData("SWITCH([Order Count], 0, 0, 1, 100, 50)")]
    [InlineData("DIVIDE([Total Order Value], [Order Count], 0)")]
    [InlineData("ROUND(AVG(public.orders.order_total), 2) + COALESCE([Order Count], BLANK())")]
    [InlineData("PERCENTOFTOTAL([Total Order Value])")]
    [InlineData("IF(NOT [Order Count] = 0 AND [Total Order Value] >= 10 OR [Order Count] != 1, 1, 0)")]
    public void GrammarV2ExpressionsValidate(string expression)
    {
        var result = Validate(ExpressionMeasure("V2", expression));

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }

    [Theory]
    [InlineData("count(*) > 0")]                 // bare boolean measure
    [InlineData("IF(count(*), 1, 0)")]           // numeric where a condition is required
    [InlineData("1 + PERCENTOFTOTAL(count(*))")] // embedded percent-of-total
    [InlineData("ROUND(count(*), 99)")]          // digits out of range
    public void GrammarV2TypeErrorsAreMdl012(string expression)
    {
        var result = Validate(ExpressionMeasure("Broken", expression));

        var issue = Assert.Single(result.Errors);
        Assert.Equal("MDL012", issue.Code);
        Assert.Contains("position", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TwoMeasureCycleIsASingleMdl016()
    {
        var a = ExpressionMeasure("A", "[B] + count(*)");
        var b = ExpressionMeasure("B", "[A] * 2");

        var result = Validate(a, b);

        var issue = Assert.Single(result.Errors);
        Assert.Equal("MDL016", issue.Code);
        Assert.Contains("'A'", issue.Message, StringComparison.Ordinal);
        Assert.Contains("'B'", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ThreeMeasureCycleIsDetected()
    {
        var a = ExpressionMeasure("A", "[B] + count(*)");
        var b = ExpressionMeasure("B", "[C] + count(*)");
        var c = ExpressionMeasure("C", "[A] + count(*)");

        var result = Validate(a, b, c);

        var issue = Assert.Single(result.Errors);
        Assert.Equal("MDL016", issue.Code);
    }

    [Fact]
    public void ChainOfNineExpressionMeasuresIsMdl016()
    {
        var chain = new List<Measure> { ExpressionMeasure("E0", "count(*) + 0") };
        for (var i = 1; i <= 9; i++)
        {
            chain.Add(ExpressionMeasure($"E{i}", $"[E{i - 1}] + 1"));
        }

        var result = Validate([.. chain]);

        var issue = Assert.Single(result.Errors);
        Assert.Equal("MDL016", issue.Code);
        Assert.Contains("deep", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ChainOfEightExpressionMeasuresPasses()
    {
        var chain = new List<Measure> { ExpressionMeasure("E0", "count(*) + 0") };
        for (var i = 1; i <= 8; i++)
        {
            chain.Add(ExpressionMeasure($"E{i}", $"[E{i - 1}] + 1"));
        }

        var result = Validate([.. chain]);

        Assert.True(result.IsValid);
    }

    [Fact]
    public void ReferenceToAPercentOfTotalMeasureIsMdl013()
    {
        var share = ExpressionMeasure("Share", "PERCENTOFTOTAL([Total Order Value])");
        var wrapper = ExpressionMeasure("Wrapper", "[Share] * 100");

        var result = Validate(share, wrapper);

        var issue = Assert.Single(result.Errors);
        Assert.Equal("MDL013", issue.Code);
        Assert.Contains("PERCENTOFTOTAL", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DiamondReferencesAreNotACycle()
    {
        // D references B and C, which both reference A — a DAG, not a cycle.
        var a = ExpressionMeasure("A", "count(*) * 1");
        var b = ExpressionMeasure("B", "[A] + 1");
        var c = ExpressionMeasure("C", "[A] + 2");
        var d = ExpressionMeasure("D", "[B] + [C]");

        var result = Validate(a, b, c, d);

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }
}
