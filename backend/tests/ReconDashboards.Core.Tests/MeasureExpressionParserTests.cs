using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Grammar-level tests for the calculated-measure parser: shape/precedence of
/// the AST, whitespace insensitivity, and — the security bar — that anything
/// outside the grammar (SQL fragments, comments, strings, stray identifiers)
/// is a hard parse error, never partially accepted.
/// </summary>
public class MeasureExpressionParserTests
{
    private static MeasureExpressionParseException AssertParseError(string expression) =>
        Assert.Throws<MeasureExpressionParseException>(() => MeasureExpressionParser.Parse(expression));

    // ---------- shape ----------

    [Fact]
    public void ParsesAggregateCallWithQualifiedColumn()
    {
        var node = MeasureExpressionParser.Parse("SUM(public.orders.order_total)");

        var call = Assert.IsType<AggregateCallNode>(node);
        Assert.Equal(Aggregation.Sum, call.Aggregation);
        Assert.Equal("public.orders", call.TableKey);
        Assert.Equal("order_total", call.Column);
    }

    [Fact]
    public void FunctionNamesAreCaseInsensitive()
    {
        Assert.Equal(
            Aggregation.CountDistinct,
            Assert.IsType<AggregateCallNode>(MeasureExpressionParser.Parse("countDISTINCT(public.orders.id)")).Aggregation);
        Assert.Equal(
            Aggregation.Avg,
            Assert.IsType<AggregateCallNode>(MeasureExpressionParser.Parse("Avg(public.orders.order_total)")).Aggregation);
    }

    [Fact]
    public void CountStarHasNoTableOrColumn()
    {
        var call = Assert.IsType<AggregateCallNode>(MeasureExpressionParser.Parse("count(*)"));
        Assert.Equal(Aggregation.Count, call.Aggregation);
        Assert.Null(call.TableKey);
        Assert.Null(call.Column);
    }

    [Fact]
    public void MeasureReferenceIsTrimmedInsideBrackets()
    {
        var node = MeasureExpressionParser.Parse("[ Total Order Value ] / count(*)");

        var binary = Assert.IsType<BinaryNode>(node);
        Assert.Equal('/', binary.Operator);
        Assert.Equal("Total Order Value", Assert.IsType<MeasureRefNode>(binary.Left).Name);
    }

    [Fact]
    public void MultiplicationBindsTighterThanAddition()
    {
        // count(*) + 2 * 3 => (+ count(*) (* 2 3))
        var root = Assert.IsType<BinaryNode>(MeasureExpressionParser.Parse("count(*) + 2 * 3"));
        Assert.Equal('+', root.Operator);
        Assert.IsType<AggregateCallNode>(root.Left);
        var product = Assert.IsType<BinaryNode>(root.Right);
        Assert.Equal('*', product.Operator);
        Assert.Equal("2", Assert.IsType<NumberLiteralNode>(product.Left).Literal);
        Assert.Equal("3", Assert.IsType<NumberLiteralNode>(product.Right).Literal);
    }

    [Fact]
    public void SubtractionIsLeftAssociative()
    {
        // count(*) - 1 - 2 => (- (- count(*) 1) 2)
        var root = Assert.IsType<BinaryNode>(MeasureExpressionParser.Parse("count(*) - 1 - 2"));
        Assert.Equal('-', root.Operator);
        Assert.Equal("2", Assert.IsType<NumberLiteralNode>(root.Right).Literal);
        var inner = Assert.IsType<BinaryNode>(root.Left);
        Assert.Equal('-', inner.Operator);
        Assert.IsType<AggregateCallNode>(inner.Left);
    }

    [Fact]
    public void ParenthesesOverridePrecedenceAndUnaryMinusParses()
    {
        // -(count(*) + 1) * 2 => (* (- (+ count(*) 1)) 2)
        var root = Assert.IsType<BinaryNode>(MeasureExpressionParser.Parse("-(count(*) + 1) * 2"));
        Assert.Equal('*', root.Operator);
        var negated = Assert.IsType<UnaryMinusNode>(root.Left);
        var sum = Assert.IsType<BinaryNode>(negated.Operand);
        Assert.Equal('+', sum.Operator);
    }

    [Fact]
    public void WhitespaceIsInsensitiveIncludingAroundDots()
    {
        var compact = MeasureExpressionParser.Parse("sum(public.orders.order_total)/count(*)");
        var spaced = MeasureExpressionParser.Parse("  sum ( public . orders . order_total )  /  count ( * )  ");

        Assert.Equal(compact, spaced); // records: structural equality
    }

    [Fact]
    public void DecimalLiteralsParse()
    {
        var root = Assert.IsType<BinaryNode>(MeasureExpressionParser.Parse("count(*) * 0.25"));
        Assert.Equal("0.25", Assert.IsType<NumberLiteralNode>(root.Right).Literal);
    }

    // ---------- rejection: grammar violations and hostile input ----------

    [Theory]
    [InlineData("1; DROP TABLE orders")]
    [InlineData("count(*); DROP TABLE orders; --")]
    [InlineData("count(*) -- comment")]
    [InlineData("count(*) UNION SELECT password FROM users")]
    [InlineData("'text'")]
    [InlineData("sum(public.orders.order_total) OR 1=1")]
    [InlineData("pg_sleep(10)")]
    [InlineData("sum(public.orders.order_total || '')")]
    [InlineData("sum((SELECT 1))")]
    [InlineData("count(*)\"")]
    public void SqlFragmentsAndUnknownSyntaxAreParseErrors(string hostile) =>
        AssertParseError(hostile);

    [Fact]
    public void ParseErrorsReportThePosition()
    {
        var ex = AssertParseError("count(*) ; 1");
        Assert.Equal(9, ex.Position);
        Assert.Contains("position 9", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("count(*) +")]
    [InlineData("(count(*)")]
    [InlineData("sum(public.orders)")]
    [InlineData("sum(order_total)")]
    [InlineData("sum(a.b.c.d)")]
    [InlineData("sum(*)")]
    [InlineData("countDistinct(*)")]
    [InlineData("[Unterminated / count(*)")]
    [InlineData("[] + count(*)")]
    [InlineData("1.")]
    [InlineData(".5 * count(*)")]
    public void IncompleteOrMalformedExpressionsAreParseErrors(string malformed) =>
        AssertParseError(malformed);

    [Fact]
    public void PureLiteralExpressionIsRejected()
    {
        // Without an aggregate the SELECT would stop being an aggregate query.
        var ex = AssertParseError("1 + 2 * 3");
        Assert.Contains("at least one aggregate", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UnknownFunctionNameIsRejectedAtItsPosition()
    {
        var ex = AssertParseError("median(public.orders.order_total)");
        Assert.Equal(0, ex.Position);
        Assert.Contains("median", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExcessiveNestingIsRejected()
    {
        var expression = new string('(', 40) + "count(*)" + new string(')', 40);
        var ex = AssertParseError(expression);
        Assert.Contains("nested", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void OverlongExpressionIsRejected()
    {
        var expression = "count(*) + " + string.Join(" + ", Enumerable.Repeat("1", 1_000));
        var ex = AssertParseError(expression);
        Assert.Contains("longer than", ex.Message, StringComparison.Ordinal);
    }
}
