using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Querying.Compilation;

/// <summary>Node of a parsed calculated-measure expression.</summary>
public abstract record MeasureExprNode;

/// <summary>Validated numeric literal (digits with an optional fraction); safe to emit verbatim.</summary>
public sealed record NumberLiteralNode(string Literal) : MeasureExprNode;

public sealed record UnaryMinusNode(MeasureExprNode Operand) : MeasureExprNode;

/// <summary>Operator is one of + - * /.</summary>
public sealed record BinaryNode(char Operator, MeasureExprNode Left, MeasureExprNode Right) : MeasureExprNode;

/// <summary>
/// SUM(schema.table.column)-style call. TableKey/Column are null only for
/// COUNT(*). Identifiers are raw text here; they are resolved against the
/// catalog before any SQL is emitted.
/// </summary>
public sealed record AggregateCallNode(Aggregation Aggregation, string? TableKey, string? Column) : MeasureExprNode;

/// <summary>[Measure Name] reference to another (non-expression) model measure.</summary>
public sealed record MeasureRefNode(string Name) : MeasureExprNode;

/// <summary>Parse failure with a zero-based character position.</summary>
public sealed class MeasureExpressionParseException(string reason, int position)
    : Exception($"Invalid expression at position {position}: {reason}.")
{
    public string Reason { get; } = reason;

    public int Position { get; } = position;
}

/// <summary>
/// Recursive-descent parser for the calculated-measure grammar:
///
///   expr    := term (('+' | '-') term)*
///   term    := unary (('*' | '/') unary)*
///   unary   := '-' unary | primary
///   primary := number | '(' expr ')' | '[' measure name ']' | agg '(' arg ')'
///   agg     := sum | avg | min | max | count | countDistinct
///            | stdDev | variance | median                       (case-insensitive)
///   arg     := '*' (count only) | ident '.' ident '.' ident    (schema.table.column)
///
/// Whitespace-insensitive. This is the SECURITY chokepoint for expressions:
/// nothing outside this grammar parses, every identifier must later resolve
/// against the catalog/model, and no input substring is ever copied into SQL —
/// only validated numeric literals and dialect-rendered fragments are emitted.
/// </summary>
public static class MeasureExpressionParser
{
    private const int MaxLength = 2_000;
    private const int MaxDepth = 32;

    /// <summary>Parses or throws <see cref="MeasureExpressionParseException"/>. The result always contains at least one aggregate call or measure reference.</summary>
    public static MeasureExprNode Parse(string expression)
    {
        ArgumentNullException.ThrowIfNull(expression);
        if (expression.Length > MaxLength)
        {
            throw new MeasureExpressionParseException($"expression is longer than {MaxLength} characters", 0);
        }

        var parser = new Parser(expression);
        var root = parser.ParseExpression(0);
        parser.SkipWhitespace();
        if (!parser.AtEnd)
        {
            throw parser.Error("unexpected trailing input");
        }

        if (!Flatten(root).Any(n => n is AggregateCallNode or MeasureRefNode))
        {
            throw new MeasureExpressionParseException(
                "expression must contain at least one aggregate call or [measure] reference", 0);
        }

        return root;
    }

    /// <summary>Depth-first enumeration of every node in the tree, root first.</summary>
    public static IEnumerable<MeasureExprNode> Flatten(MeasureExprNode node)
    {
        yield return node;
        switch (node)
        {
            case UnaryMinusNode unary:
                foreach (var child in Flatten(unary.Operand))
                {
                    yield return child;
                }

                break;
            case BinaryNode binary:
                foreach (var child in Flatten(binary.Left))
                {
                    yield return child;
                }

                foreach (var child in Flatten(binary.Right))
                {
                    yield return child;
                }

                break;
        }
    }

    /// <summary>
    /// Resolves a [reference] against the model's measures: an exact-case match
    /// wins; otherwise a unique case-insensitive match. Ambiguous is true when
    /// several measures share the name (MDL010 territory).
    /// </summary>
    public static (Measure? Match, bool Ambiguous) ResolveMeasureRef(ModelDefinition model, string name)
    {
        var exact = model.Measures.Where(m => string.Equals(m.Name, name, StringComparison.Ordinal)).ToArray();
        if (exact.Length > 0)
        {
            return (exact[0], exact.Length > 1);
        }

        var loose = model.Measures.Where(m => string.Equals(m.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray();
        return loose.Length switch
        {
            0 => (null, false),
            1 => (loose[0], false),
            _ => (null, true),
        };
    }

    private sealed class Parser(string text)
    {
        private int _position;

        public bool AtEnd => _position >= text.Length;

        public MeasureExpressionParseException Error(string reason) => new(reason, _position);

        public void SkipWhitespace()
        {
            while (!AtEnd && char.IsWhiteSpace(text[_position]))
            {
                _position++;
            }
        }

        public MeasureExprNode ParseExpression(int depth)
        {
            Guard(depth);
            var node = ParseTerm(depth + 1);
            while (true)
            {
                SkipWhitespace();
                if (TryConsume('+'))
                {
                    node = new BinaryNode('+', node, ParseTerm(depth + 1));
                }
                else if (TryConsume('-'))
                {
                    node = new BinaryNode('-', node, ParseTerm(depth + 1));
                }
                else
                {
                    return node;
                }
            }
        }

        private MeasureExprNode ParseTerm(int depth)
        {
            Guard(depth);
            var node = ParseUnary(depth + 1);
            while (true)
            {
                SkipWhitespace();
                if (TryConsume('*'))
                {
                    node = new BinaryNode('*', node, ParseUnary(depth + 1));
                }
                else if (TryConsume('/'))
                {
                    node = new BinaryNode('/', node, ParseUnary(depth + 1));
                }
                else
                {
                    return node;
                }
            }
        }

        private MeasureExprNode ParseUnary(int depth)
        {
            Guard(depth);
            SkipWhitespace();
            return TryConsume('-')
                ? new UnaryMinusNode(ParseUnary(depth + 1))
                : ParsePrimary(depth + 1);
        }

        private MeasureExprNode ParsePrimary(int depth)
        {
            Guard(depth);
            SkipWhitespace();
            if (AtEnd)
            {
                throw Error("expected a number, aggregate call, [measure] reference, or '('");
            }

            var c = text[_position];
            if (c == '(')
            {
                _position++;
                var inner = ParseExpression(depth + 1);
                SkipWhitespace();
                Expect(')');
                return inner;
            }

            if (c == '[')
            {
                return ParseMeasureRef();
            }

            if (char.IsAsciiDigit(c))
            {
                return ParseNumber();
            }

            if (IsIdentStart(c))
            {
                return ParseAggregateCall();
            }

            throw Error($"unexpected character '{c}'");
        }

        private MeasureExprNode ParseNumber()
        {
            var start = _position;
            while (!AtEnd && char.IsAsciiDigit(text[_position]))
            {
                _position++;
            }

            if (!AtEnd && text[_position] == '.')
            {
                _position++;
                if (AtEnd || !char.IsAsciiDigit(text[_position]))
                {
                    throw Error("expected digits after the decimal point");
                }

                while (!AtEnd && char.IsAsciiDigit(text[_position]))
                {
                    _position++;
                }
            }

            return new NumberLiteralNode(text[start.._position]);
        }

        private MeasureExprNode ParseMeasureRef()
        {
            var start = _position;
            _position++; // '['
            var close = text.IndexOf(']', _position);
            if (close < 0)
            {
                _position = start;
                throw Error("unterminated [measure] reference");
            }

            var name = text[_position..close].Trim();
            if (name.Length == 0)
            {
                throw Error("empty [measure] reference");
            }

            _position = close + 1;
            return new MeasureRefNode(name);
        }

        private MeasureExprNode ParseAggregateCall()
        {
            var namePosition = _position;
            var name = ParseIdentifier();
            Aggregation aggregation;
            if (string.Equals(name, "sum", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.Sum;
            }
            else if (string.Equals(name, "avg", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.Avg;
            }
            else if (string.Equals(name, "min", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.Min;
            }
            else if (string.Equals(name, "max", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.Max;
            }
            else if (string.Equals(name, "count", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.Count;
            }
            else if (string.Equals(name, "countdistinct", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.CountDistinct;
            }
            else if (string.Equals(name, "stddev", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.StdDev;
            }
            else if (string.Equals(name, "variance", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.Variance;
            }
            else if (string.Equals(name, "median", StringComparison.OrdinalIgnoreCase))
            {
                aggregation = Aggregation.Median;
            }
            else
            {
                _position = namePosition;
                throw Error($"unknown function '{name}' (expected sum, avg, min, max, count, countDistinct, stdDev, variance, or median)");
            }

            SkipWhitespace();
            Expect('(');
            SkipWhitespace();

            if (TryConsume('*'))
            {
                if (aggregation != Aggregation.Count)
                {
                    throw Error("only count may take '*' as its argument");
                }

                SkipWhitespace();
                Expect(')');
                return new AggregateCallNode(aggregation, TableKey: null, Column: null);
            }

            var schema = ParseIdentifier();
            SkipWhitespace();
            Expect('.');
            SkipWhitespace();
            var table = ParseIdentifier();
            SkipWhitespace();
            Expect('.');
            SkipWhitespace();
            var column = ParseIdentifier();
            SkipWhitespace();
            Expect(')');
            return new AggregateCallNode(aggregation, $"{schema}.{table}", column);
        }

        private string ParseIdentifier()
        {
            SkipWhitespace();
            if (AtEnd || !IsIdentStart(text[_position]))
            {
                throw Error("expected an identifier");
            }

            var start = _position;
            while (!AtEnd && (char.IsAsciiLetterOrDigit(text[_position]) || text[_position] == '_'))
            {
                _position++;
            }

            return text[start.._position];
        }

        private static bool IsIdentStart(char c) => char.IsAsciiLetter(c) || c == '_';

        private bool TryConsume(char c)
        {
            if (!AtEnd && text[_position] == c)
            {
                _position++;
                return true;
            }

            return false;
        }

        private void Expect(char c)
        {
            if (!TryConsume(c))
            {
                throw Error($"expected '{c}'");
            }
        }

        private void Guard(int depth)
        {
            if (depth > MaxDepth)
            {
                throw Error($"expression is nested deeper than {MaxDepth} levels");
            }
        }
    }
}
