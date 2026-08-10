using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Grammar v2 parser tests: comparisons and boolean operators (word and symbol
/// forms), IF/SWITCH/DIVIDE, scalar functions, BLANK(), PERCENTOFTOTAL
/// placement, and the type discipline (booleans only where a condition is
/// expected). Negative cases double as the security bar for the new surface.
/// </summary>
public class MeasureExpressionParserV2Tests
{
    private static MeasureExpressionParseException AssertParseError(string expression) =>
        Assert.Throws<MeasureExpressionParseException>(() => MeasureExpressionParser.Parse(expression));

    // ---------- comparisons and boolean operators ----------

    [Fact]
    public void ComparisonInsideIfParsesToComparisonNode()
    {
        var root = Assert.IsType<IfNode>(MeasureExpressionParser.Parse("IF(count(*) > 0, 1, 0)"));

        var comparison = Assert.IsType<ComparisonNode>(root.Condition);
        Assert.Equal(">", comparison.Operator);
        Assert.IsType<AggregateCallNode>(comparison.Left);
        Assert.Equal("0", Assert.IsType<NumberLiteralNode>(comparison.Right).Literal);
        Assert.Equal("1", Assert.IsType<NumberLiteralNode>(root.Then).Literal);
        Assert.Equal("0", Assert.IsType<NumberLiteralNode>(root.Else!).Literal);
    }

    [Theory]
    [InlineData("=", "=")]
    [InlineData("<>", "<>")]
    [InlineData("!=", "<>")] // courtesy synonym, normalized at parse time
    [InlineData(">", ">")]
    [InlineData(">=", ">=")]
    [InlineData("<", "<")]
    [InlineData("<=", "<=")]
    public void AllComparisonOperatorsParseAndNormalize(string op, string normalized)
    {
        var root = Assert.IsType<IfNode>(MeasureExpressionParser.Parse($"IF(count(*) {op} 5, 1)"));
        Assert.Equal(normalized, Assert.IsType<ComparisonNode>(root.Condition).Operator);
    }

    [Fact]
    public void WordAndSymbolBooleanOperatorsProduceTheSameTree()
    {
        var words = MeasureExpressionParser.Parse("IF([A] > 0 AND NOT [B] < 1 OR [C] = 2, 1, 0)");
        var symbols = MeasureExpressionParser.Parse("IF([A] > 0 && !([B] < 1) || [C] = 2, 1, 0)");

        Assert.Equal(words, symbols); // records: structural equality (no lists involved)
    }

    [Fact]
    public void AndBindsTighterThanOr()
    {
        var root = Assert.IsType<IfNode>(MeasureExpressionParser.Parse("IF([A] > 0 OR [B] > 0 AND [C] > 0, 1)"));

        var or = Assert.IsType<BooleanBinaryNode>(root.Condition);
        Assert.False(or.IsAnd);
        Assert.IsType<ComparisonNode>(or.Left);
        var and = Assert.IsType<BooleanBinaryNode>(or.Right);
        Assert.True(and.IsAnd);
    }

    [Fact]
    public void KeywordMatchingRespectsWordBoundaries()
    {
        // 'order_total' contains 'or'; 'android_score' starts with 'and'.
        var node = MeasureExpressionParser.Parse("sum(public.orders.order_total) + sum(public.orders.android_score)");
        Assert.IsType<BinaryNode>(node);
    }

    [Fact]
    public void ComparisonBindsLooserThanArithmetic()
    {
        var root = Assert.IsType<IfNode>(MeasureExpressionParser.Parse("IF(count(*) + 1 > 2 * 3, 1)"));
        var comparison = Assert.IsType<ComparisonNode>(root.Condition);
        Assert.IsType<BinaryNode>(comparison.Left);  // count(*) + 1
        Assert.IsType<BinaryNode>(comparison.Right); // 2 * 3
    }

    // ---------- IF / SWITCH / DIVIDE ----------

    [Fact]
    public void IfWithoutElseHasNullElse()
    {
        var root = Assert.IsType<IfNode>(MeasureExpressionParser.Parse("IF(count(*) > 0, count(*))"));
        Assert.Null(root.Else);
    }

    [Fact]
    public void SwitchParsesPairsAndDefault()
    {
        var root = Assert.IsType<SwitchNode>(MeasureExpressionParser.Parse("SWITCH(count(*), 1, 10, 2, 20, 99)"));

        Assert.IsType<AggregateCallNode>(root.Subject);
        Assert.Equal(2, root.Cases.Count);
        Assert.Equal("1", Assert.IsType<NumberLiteralNode>(root.Cases[0].Value).Literal);
        Assert.Equal("10", Assert.IsType<NumberLiteralNode>(root.Cases[0].Result).Literal);
        Assert.Equal("99", Assert.IsType<NumberLiteralNode>(root.Default!).Literal);
    }

    [Fact]
    public void SwitchWithoutDefaultHasNullDefault()
    {
        var root = Assert.IsType<SwitchNode>(MeasureExpressionParser.Parse("SWITCH(count(*), 1, 10)"));
        Assert.Single(root.Cases);
        Assert.Null(root.Default);
    }

    [Fact]
    public void SwitchNeedsAtLeastOnePair()
    {
        var ex = AssertParseError("SWITCH(count(*), 1)");
        Assert.Contains("value/result pair", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DivideParsesTwoAndThreeArgumentForms()
    {
        var bare = Assert.IsType<DivideNode>(MeasureExpressionParser.Parse("DIVIDE([A], [B])"));
        Assert.Null(bare.Alternate);

        var withAlternate = Assert.IsType<DivideNode>(MeasureExpressionParser.Parse("DIVIDE([A], [B], 0)"));
        Assert.Equal("0", Assert.IsType<NumberLiteralNode>(withAlternate.Alternate!).Literal);
    }

    // ---------- scalar functions ----------

    [Theory]
    [InlineData("ABS([A])", ScalarFunction.Abs)]
    [InlineData("ceiling([A])", ScalarFunction.Ceiling)]
    [InlineData("Floor([A])", ScalarFunction.Floor)]
    [InlineData("SQRT([A])", ScalarFunction.Sqrt)]
    [InlineData("exp([A])", ScalarFunction.Exp)]
    [InlineData("LN([A])", ScalarFunction.Ln)]
    public void UnaryScalarFunctionsParse(string expression, ScalarFunction expected)
    {
        var call = Assert.IsType<ScalarCallNode>(MeasureExpressionParser.Parse(expression));
        Assert.Equal(expected, call.Function);
        Assert.Single(call.Arguments);
    }

    [Fact]
    public void PowerTakesExactlyTwoArguments()
    {
        var call = Assert.IsType<ScalarCallNode>(MeasureExpressionParser.Parse("POWER([A], 2)"));
        Assert.Equal(ScalarFunction.Power, call.Function);
        Assert.Equal(2, call.Arguments.Count);

        AssertParseError("POWER([A])");
    }

    [Fact]
    public void CoalesceTakesTwoOrMoreArguments()
    {
        var call = Assert.IsType<ScalarCallNode>(MeasureExpressionParser.Parse("COALESCE([A], 0, BLANK())"));
        Assert.Equal(ScalarFunction.Coalesce, call.Function);
        Assert.Equal(3, call.Arguments.Count);
        Assert.IsType<BlankNode>(call.Arguments[2]);

        var ex = AssertParseError("COALESCE([A])");
        Assert.Contains("at least two", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("ROUND([A], 2)", 2)]
    [InlineData("ROUND([A], -2)", -2)]
    [InlineData("ROUND([A], 0)", 0)]
    [InlineData("ROUND([A], 12)", 12)]
    public void RoundDigitsParseAsValidatedIntegers(string expression, int digits)
    {
        var round = Assert.IsType<RoundNode>(MeasureExpressionParser.Parse(expression));
        Assert.Equal(digits, round.Digits);
    }

    [Theory]
    [InlineData("ROUND([A], 13)")]
    [InlineData("ROUND([A], -13)")]
    [InlineData("ROUND([A], 100)")]
    [InlineData("ROUND([A], 1.5)")]
    [InlineData("ROUND([A], count(*))")] // digits must be a literal, never an expression
    [InlineData("ROUND([A])")]
    public void InvalidRoundDigitsAreParseErrors(string expression) => AssertParseError(expression);

    [Fact]
    public void SignedLiteralsParseViaUnaryMinus()
    {
        var root = Assert.IsType<BinaryNode>(MeasureExpressionParser.Parse("count(*) + -1.5"));
        var negated = Assert.IsType<UnaryMinusNode>(root.Right);
        Assert.Equal("1.5", Assert.IsType<NumberLiteralNode>(negated.Operand).Literal);
    }

    // ---------- PERCENTOFTOTAL placement ----------

    [Fact]
    public void PercentOfTotalParsesAtTheRoot()
    {
        var root = Assert.IsType<PercentOfTotalNode>(
            MeasureExpressionParser.Parse("PERCENTOFTOTAL(SUM(public.orders.order_total))"));
        Assert.IsType<AggregateCallNode>(root.Inner);
    }

    [Fact]
    public void PercentOfTotalAcceptsAFullExpressionArgument()
    {
        var root = Assert.IsType<PercentOfTotalNode>(
            MeasureExpressionParser.Parse("percentOfTotal([Total Order Value] / [Order Count])"));
        Assert.IsType<BinaryNode>(root.Inner);
    }

    [Fact]
    public void EmbeddedPercentOfTotalIsRejectedAtItsPosition()
    {
        var ex = AssertParseError("1 + PERCENTOFTOTAL(count(*))");
        Assert.Equal(4, ex.Position);
        Assert.Contains("only wrap the entire", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TrailingArithmeticAfterPercentOfTotalIsRejected()
    {
        var ex = AssertParseError("PERCENTOFTOTAL(count(*)) + 1");
        Assert.Contains("trailing", ex.Message, StringComparison.Ordinal);
    }

    // ---------- type discipline ----------

    [Fact]
    public void BareBooleanMeasureIsRejected()
    {
        var ex = AssertParseError("count(*) > 0");
        Assert.Equal(0, ex.Position);
        Assert.Contains("must produce a number", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void BooleanInArithmeticIsRejectedAtTheOperator()
    {
        var ex = AssertParseError("(count(*) > 0) + 1");
        Assert.Equal(15, ex.Position); // the '+'
        Assert.Contains("numbers on both sides", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NumberAsAndOperandIsRejected()
    {
        var ex = AssertParseError("IF(count(*) AND 1 > 0, 1)");
        Assert.Contains("AND combines two conditions", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NotOnANumberIsRejected()
    {
        var ex = AssertParseError("IF(NOT count(*), 1)");
        Assert.Contains("NOT needs a condition", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ChainedComparisonsAreRejected()
    {
        var ex = AssertParseError("IF(count(*) > 1 > 2, 1)");
        Assert.Contains("chained", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void BooleanAsIfBranchIsRejected()
    {
        var ex = AssertParseError("IF(count(*) > 0, [A] > 1, 0)");
        Assert.Contains("branches must be numbers", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void BooleanAsFunctionArgumentIsRejected()
    {
        var ex = AssertParseError("ABS(count(*) > 1)");
        Assert.Contains("must be numbers", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NonBooleanIfConditionIsRejected()
    {
        var ex = AssertParseError("IF(count(*), 1, 0)");
        Assert.Contains("needs a condition", ex.Message, StringComparison.Ordinal);
    }

    // ---------- hostile input through the new surface ----------

    [Theory]
    [InlineData("IF(1 = 1, pg_sleep(10), 0)")]          // unknown function
    [InlineData("COALESCE(count(*), (SELECT 1))")]       // subquery -> unknown function 'SELECT'
    [InlineData("IF(count(*) > 0, 1, 0); DROP TABLE x")] // trailing statement
    [InlineData("[M] || 'x'")]                           // string concat: OR over non-booleans
    [InlineData("IF(count(*) > 0 OR 1 = 1 --, 1, 0)")]
    [InlineData("SWITCH(count(*), 1, 'admin')")]
    [InlineData("DIVIDE(count(*), 0, 'fallback')")]
    [InlineData("BLANK") ]                               // bare word, no call
    [InlineData("IF(TRUE, 1, 0)")]                       // no boolean literals in the grammar
    public void HostileOrOutOfGrammarInputIsRejected(string hostile) => AssertParseError(hostile);

    [Fact]
    public void DeepNestingThroughFunctionArgumentsIsBounded()
    {
        var expression = string.Concat(Enumerable.Repeat("ABS(", 40)) + "count(*)" + new string(')', 40);
        var ex = AssertParseError(expression);
        Assert.Contains("nested", ex.Message, StringComparison.Ordinal);
    }
}
