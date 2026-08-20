using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The ROW-LEVEL grammar (<see cref="ExpressionContext.Dimension"/>) and — just
/// as important — the exact complementarity of the two contexts: what a derived
/// field may say a measure may not, and the reverse. Every rejection is checked
/// through the SAME parser the compiler and the validator call, because that is
/// the only chokepoint an expression passes.
/// </summary>
public class MeasureExpressionParserDerivedTests
{
    private const string Uploaded = "public.reviews.edms_uploaded";

    private static MeasureExprNode ParseField(string expression) =>
        MeasureExpressionParser.Parse(expression, ExpressionContext.Dimension);

    private static MeasureExpressionParseException FieldError(string expression) =>
        Assert.Throws<MeasureExpressionParseException>(() => ParseField(expression));

    private static MeasureExpressionParseException MeasureError(string expression) =>
        Assert.Throws<MeasureExpressionParseException>(() => MeasureExpressionParser.Parse(expression));

    // ---------- the owner's case ----------

    [Fact]
    public void TheOwnersExpressionParses()
    {
        var root = ParseField($"IF(ISBLANK({Uploaded}), \"No\", \"Yes\")");

        var conditional = Assert.IsType<IfNode>(root);
        var blank = Assert.IsType<IsBlankNode>(conditional.Condition);
        var column = Assert.IsType<ColumnRefNode>(blank.Operand);
        Assert.Equal("public.reviews", column.TableKey);
        Assert.Equal("edms_uploaded", column.Column);
        Assert.Equal("No", Assert.IsType<StringLiteralNode>(conditional.Then).Value);
        Assert.Equal("Yes", Assert.IsType<StringLiteralNode>(conditional.Else).Value);
    }

    [Fact]
    public void IsNotNullFormOfTheOwnersExpressionParses()
    {
        var conditional = Assert.IsType<IfNode>(ParseField($"IF({Uploaded} IS NOT NULL, \"Yes\", \"No\")"));
        var isNull = Assert.IsType<IsNullNode>(conditional.Condition);
        Assert.True(isNull.Negated);
    }

    // ---------- accepted row-level shapes ----------

    [Theory]
    [InlineData("public.reviews.region")]
    [InlineData("IF(public.reviews.region = \"West\", \"West\", \"Other\")")]
    [InlineData("SWITCH(public.reviews.region, \"West\", \"W\", \"East\", \"E\", \"Other\")")]
    [InlineData("COALESCE(public.reviews.region, \"Unknown\")")]
    [InlineData("IF(public.reviews.edms_uploaded IS NULL, \"No\", public.reviews.edms_uploaded)")]
    [InlineData("IF(NOT ISBLANK(public.reviews.edms_uploaded) AND public.reviews.region = \"West\", \"Yes\", \"No\")")]
    [InlineData("IF(public.reviews.region = 'West', 'W', 'Other')")]
    public void RowLevelShapesParse(string expression) => Assert.NotNull(ParseField(expression));

    [Fact]
    public void DoubledDelimiterEscapesItself()
    {
        var conditional = Assert.IsType<IfNode>(
            ParseField("IF(public.reviews.region = \"a\"\"b\", 'it''s', \"x\")"));
        Assert.Equal("a\"b", Assert.IsType<StringLiteralNode>(conditional.Condition is ComparisonNode c
            ? c.Right
            : conditional.Then).Value);
        Assert.Equal("it's", Assert.IsType<StringLiteralNode>(conditional.Then).Value);
    }

    // ---------- the two directions of the context gate ----------

    [Fact]
    public void BareColumnInAMeasureIsRejected()
    {
        // Not a style choice: ExpressionSql renders into the SELECT list of an
        // already-grouped statement, so a bare column is a "not in GROUP BY"
        // SQL error.
        var ex = MeasureError($"{Uploaded}");
        Assert.Contains("unknown function", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void StringLiteralInAMeasureIsRejected()
    {
        var ex = MeasureError("IF(count(*) > 0, \"Yes\", \"No\")");
        Assert.Contains("unexpected character", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void IsBlankInAMeasureIsRejected()
    {
        var ex = MeasureError($"IF(ISBLANK({Uploaded}), 1, 0)");
        Assert.Contains("only available in a derived field", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void IsNullInAMeasureIsRejected()
    {
        var ex = MeasureError("IF(count(*) IS NULL, 1, 0)");
        Assert.Contains("needs a condition", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AggregateInADerivedFieldIsRejectedAtItsPosition()
    {
        var ex = FieldError($"IF(sum(public.reviews.id) > 0, \"Yes\", \"No\")");
        Assert.Equal(3, ex.Position);
        Assert.Contains("cannot use the aggregate 'sum'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MeasureReferenceInADerivedFieldIsRejected()
    {
        var ex = FieldError("IF([Total] > 0, \"Yes\", \"No\")");
        Assert.Contains("cannot reference a [measure]", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void PercentOfTotalInADerivedFieldIsRejected() =>
        Assert.Throws<MeasureExpressionParseException>(
            () => ParseField("PERCENTOFTOTAL(public.reviews.id)"));

    // ---------- result-type discipline ----------

    [Fact]
    public void ADerivedFieldThatProducesAConditionIsRejected()
    {
        var ex = FieldError($"{Uploaded} IS NOT NULL");
        Assert.Equal(0, ex.Position);
        Assert.Contains("must produce a label", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADerivedFieldThatProducesANumberIsRejected()
    {
        var ex = FieldError("public.reviews.id + 1");
        Assert.Contains("not a number", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AConstantDerivedFieldIsRejected()
    {
        // Without a column it is not derived from anything, and it would make
        // every row one bucket.
        var ex = FieldError("\"Yes\"");
        Assert.Contains("at least one column", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MixedTypeIfBranchesAreRejected()
    {
        var ex = FieldError("IF(public.reviews.region = \"West\", \"W\", 1)");
        Assert.Contains("both be numbers or both be text", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ComparingTextWithANumberIsRejected()
    {
        var ex = FieldError("IF(\"West\" = 1, \"a\", \"b\")");
        Assert.Contains("cannot compare a number with text", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TextInArithmeticIsRejected()
    {
        var ex = FieldError("IF(public.reviews.region = \"W\", \"a\" + 1, \"b\")");
        Assert.Contains("where a number is required", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ConditionAsALabelIsRejected()
    {
        var ex = FieldError("IF(ISBLANK(public.reviews.region), public.reviews.id > 1, \"No\")");
        Assert.Contains("IF branches must be values", ex.Message, StringComparison.Ordinal);
    }

    // ---------- bounds ----------

    [Fact]
    public void UnterminatedTextLiteralIsRejected()
    {
        var ex = FieldError("IF(ISBLANK(public.reviews.region), \"No\", \"Yes)");
        Assert.Contains("unterminated text literal", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MultilineTextLiteralIsRejected()
    {
        var ex = FieldError("IF(public.reviews.region = \"We\nst\", \"a\", \"b\")");
        Assert.Contains("may not span lines", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void OverlongTextLiteralIsRejected()
    {
        var ex = FieldError($"IF(public.reviews.region = \"{new string('x', 300)}\", \"a\", \"b\")");
        Assert.Contains("at most 256 characters", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void OverComplexRowLevelExpressionIsRejected()
    {
        // A row-level expression runs once PER ROW inside GROUP BY, so the
        // length and depth caps are not enough on their own.
        var expression = "COALESCE(" + string.Join(", ", Enumerable.Repeat("a.b.c", 130)) + ")";
        var ex = FieldError(expression);
        Assert.Contains("at most 120 operations", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void HostileTextInALiteralStaysDataAndParses()
    {
        // It parses — the literal is DATA. What matters is that emission binds
        // it; QueryCompilerDerivedFieldTests proves the statement carries none
        // of these characters.
        var conditional = Assert.IsType<IfNode>(
            ParseField("IF(ISBLANK(public.reviews.region), \"'); DROP TABLE reviews; --\", \"ok\")"));
        Assert.Equal("'); DROP TABLE reviews; --", Assert.IsType<StringLiteralNode>(conditional.Then).Value);
    }

    // ---------- the measure grammar is untouched ----------

    [Theory]
    [InlineData("sum(public.orders.order_total)")]
    [InlineData("IF(count(*) > 0, 1, 0)")]
    [InlineData("PERCENTOFTOTAL(sum(public.orders.order_total))")]
    [InlineData("DIVIDE([A], [B], 0)")]
    public void MeasureGrammarStillParses(string expression) =>
        Assert.NotNull(MeasureExpressionParser.Parse(expression));
}
