using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Validator coverage for calculated measures: MDL012 (parse), MDL013
/// (reference resolution / numeric requirements), MDL014 (expression + column).
/// </summary>
public class SemanticModelValidatorExpressionTests
{
    private static Measure ExpressionMeasure(string name, string expression, string? column = null) =>
        new(Guid.NewGuid(), name, "public.orders", Aggregation.Sum, column,
            FormatHint: null, Filters: null, Expression: expression);

    private static ValidationResult Validate(params Measure[] measures)
    {
        var demo = TestFixtures.BuildValidDemoModel();
        var orderCount = TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count);
        var model = demo with { Measures = [.. demo.Measures, orderCount, .. measures] };
        return new SemanticModelValidator().Validate(model, TestFixtures.BuildDemoSchema());
    }

    private static ValidationIssue AssertSingleError(ValidationResult result, string code)
    {
        var issue = Assert.Single(result.Errors);
        Assert.Equal(code, issue.Code);
        return issue;
    }

    [Fact]
    public void ValidRatioExpressionPasses()
    {
        var result = Validate(ExpressionMeasure("AOV", "[Total Order Value] / [Order Count]"));

        Assert.True(result.IsValid);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void ValidDirectAggregateExpressionPasses()
    {
        var result = Validate(ExpressionMeasure(
            "Utilization", "SUM(public.orders.order_total) / SUM(public.customers.credit_limit)"));

        Assert.True(result.IsValid);
    }

    [Fact]
    public void ParseErrorIsMdl012WithPosition()
    {
        var result = Validate(ExpressionMeasure("Broken", "count(*) +"));

        var issue = AssertSingleError(result, "MDL012");
        Assert.Contains("position", issue.Message, StringComparison.Ordinal);
        Assert.Contains("Broken", issue.Message, StringComparison.Ordinal);
        Assert.EndsWith(".expression", issue.Path!, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("1; DROP TABLE orders")]
    [InlineData("count(*); DELETE FROM orders --")]
    [InlineData("sum(public.orders.order_total) UNION SELECT 1")]
    [InlineData("1 + 2")]
    public void HostileOrAggregateFreeExpressionsAreMdl012(string expression) =>
        AssertSingleError(Validate(ExpressionMeasure("Hostile", expression)), "MDL012");

    [Fact]
    public void UnknownColumnIsMdl013() =>
        AssertSingleError(Validate(ExpressionMeasure("Bad", "sum(public.orders.nope)")), "MDL013");

    [Fact]
    public void NonNumericColumnForAvgIsMdl013()
    {
        var result = Validate(ExpressionMeasure("Bad", "avg(public.orders.status)"));

        var issue = AssertSingleError(result, "MDL013");
        Assert.Contains("Avg is not valid", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TableOutsideTheModelIsMdl013() =>
        // public.inspections exists in the catalog but was never added to the model.
        AssertSingleError(Validate(ExpressionMeasure("Bad", "sum(public.inspections.id)")), "MDL013");

    [Fact]
    public void UnknownMeasureReferenceIsMdl013()
    {
        var result = Validate(ExpressionMeasure("Bad", "[No Such Measure] / count(*)"));

        var issue = AssertSingleError(result, "MDL013");
        Assert.Contains("[No Such Measure]", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ReferenceToAnotherExpressionMeasureIsMdl013()
    {
        var first = ExpressionMeasure("First", "[Order Count] * 2");
        var second = ExpressionMeasure("Second", "[First] / 2");

        var result = Validate(first, second);

        var issue = AssertSingleError(result, "MDL013");
        Assert.Contains("itself expression-based", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SelfReferenceIsRejectedAsNestedExpression()
    {
        var result = Validate(ExpressionMeasure("Loop", "[Loop] + count(*)"));

        var issue = AssertSingleError(result, "MDL013");
        Assert.Contains("itself expression-based", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MeasureRefsAreCaseInsensitiveWhenUnambiguous()
    {
        var result = Validate(ExpressionMeasure("AOV", "[total order value] / [ORDER COUNT]"));

        Assert.True(result.IsValid);
    }

    [Fact]
    public void ExpressionMeasureWithColumnIsMdl014()
    {
        var result = Validate(ExpressionMeasure("Bad", "[Order Count] * 2", column: "order_total"));

        var issue = AssertSingleError(result, "MDL014");
        Assert.EndsWith(".column", issue.Path!, StringComparison.Ordinal);
    }
}
