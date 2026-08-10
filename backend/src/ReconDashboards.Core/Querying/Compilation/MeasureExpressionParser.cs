using System.Globalization;
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

/// <summary>
/// Boolean-producing comparison. Operator is one of the normalized whitelist
/// "=", "&lt;&gt;", "&gt;", "&gt;=", "&lt;", "&lt;=" ("!=" normalizes to "&lt;&gt;" at parse time).
/// </summary>
public sealed record ComparisonNode(string Operator, MeasureExprNode Left, MeasureExprNode Right) : MeasureExprNode;

/// <summary>Boolean AND (IsAnd) / OR over two boolean operands.</summary>
public sealed record BooleanBinaryNode(bool IsAnd, MeasureExprNode Left, MeasureExprNode Right) : MeasureExprNode;

/// <summary>Boolean negation of a boolean operand.</summary>
public sealed record NotNode(MeasureExprNode Operand) : MeasureExprNode;

/// <summary>IF(condition, then [, else]) — omitted else is NULL (BLANK semantics).</summary>
public sealed record IfNode(MeasureExprNode Condition, MeasureExprNode Then, MeasureExprNode? Else) : MeasureExprNode;

/// <summary>One value/result pair of a SWITCH.</summary>
public sealed record SwitchCaseNode(MeasureExprNode Value, MeasureExprNode Result);

/// <summary>SWITCH(subject, v1, r1 [, v2, r2 ...] [, default]) — DAX-style simple CASE.</summary>
public sealed record SwitchNode(MeasureExprNode Subject, IReadOnlyList<SwitchCaseNode> Cases, MeasureExprNode? Default) : MeasureExprNode;

/// <summary>DIVIDE(numerator, denominator [, alternate]) — alternate (or NULL) on zero/null denominator.</summary>
public sealed record DivideNode(MeasureExprNode Numerator, MeasureExprNode Denominator, MeasureExprNode? Alternate) : MeasureExprNode;

/// <summary>Whitelisted scalar functions with plain numeric arguments.</summary>
public enum ScalarFunction
{
    Abs,
    Ceiling,
    Floor,
    Sqrt,
    Exp,
    Ln,
    Power,
    Coalesce,
}

public sealed record ScalarCallNode(ScalarFunction Function, IReadOnlyList<MeasureExprNode> Arguments) : MeasureExprNode;

/// <summary>ROUND(x, digits). Digits is a parse-validated integer in [-12, 12], safe to emit verbatim.</summary>
public sealed record RoundNode(MeasureExprNode Argument, int Digits) : MeasureExprNode;

/// <summary>BLANK() — the NULL literal.</summary>
public sealed record BlankNode : MeasureExprNode;

/// <summary>
/// PERCENTOFTOTAL(inner): percent of the grand total of inner across the
/// current result set. Only legal as the OUTERMOST node of a measure
/// expression; the compiler strips it and applies a post-aggregation window.
/// </summary>
public sealed record PercentOfTotalNode(MeasureExprNode Inner) : MeasureExprNode;

/// <summary>[Measure Name] reference to another model measure (plain or expression-based).</summary>
public sealed record MeasureRefNode(string Name) : MeasureExprNode;

/// <summary>Parse failure with a zero-based character position.</summary>
public sealed class MeasureExpressionParseException(string reason, int position)
    : Exception($"Invalid expression at position {position}: {reason}.")
{
    public string Reason { get; } = reason;

    public int Position { get; } = position;
}

/// <summary>
/// Recursive-descent parser for the calculated-measure grammar (v2):
///
///   measure   := 'PERCENTOFTOTAL' '(' numeric ')' | numeric     (a measure must produce a number)
///   numeric   := condition checked to be non-boolean in-parse
///   condition := andCond (('OR' | '||') andCond)*
///   andCond   := notCond (('AND' | '&amp;&amp;') notCond)*
///   notCond   := ('NOT' | '!') notCond | compare
///   compare   := additive (cmpOp additive)?                     (no chaining)
///   cmpOp     := '=' | '&lt;&gt;' | '!=' | '&gt;=' | '&lt;=' | '&gt;' | '&lt;'      ('!=' normalizes to '&lt;&gt;')
///   additive  := term (('+' | '-') term)*
///   term      := unary (('*' | '/') unary)*
///   unary     := '-' unary | primary
///   primary   := number | '(' condition ')' | '[' measure name ']' | call
///   call      := agg '(' aggArg ')'
///              | IF '(' condition ',' numeric [',' numeric] ')'
///              | SWITCH '(' numeric ',' numeric ',' numeric (',' numeric ',' numeric)* [',' numeric] ')'
///              | DIVIDE '(' numeric ',' numeric [',' numeric] ')'
///              | ABS | CEILING | FLOOR | SQRT | EXP | LN   -- each '(' numeric ')'
///              | POWER '(' numeric ',' numeric ')'
///              | ROUND '(' numeric ',' intLiteral ')'            (intLiteral in [-12, 12])
///              | COALESCE '(' numeric (',' numeric)+ ')'
///              | BLANK '(' ')'
///   agg       := sum | avg | min | max | count | countDistinct
///              | stdDev | variance | median                     (case-insensitive)
///   aggArg    := '*' (count only) | ident '.' ident '.' ident   (schema.table.column)
///
/// Booleans exist only where a condition is expected (an IF condition and the
/// operands of AND/OR/NOT). A bare boolean is never a valid measure, function
/// argument, or arithmetic/comparison operand — those are precise positioned
/// parse errors (surfaced as MDL012 at validation, QRY_BAD_MEASURE at compile).
/// PERCENTOFTOTAL may only wrap the entire expression. Whitespace-insensitive;
/// keywords and function names are case-insensitive.
///
/// This is the SECURITY chokepoint for expressions: nothing outside this
/// grammar parses, every identifier must later resolve against the
/// catalog/model, operators are re-emitted from a normalized whitelist, ROUND
/// digits are range-checked integers, and no input substring is ever copied
/// into SQL — only validated numeric literals and dialect-rendered fragments
/// are emitted.
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
        var root = parser.ParseMeasure();
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
        foreach (var child in Children(node))
        {
            foreach (var descendant in Flatten(child))
            {
                yield return descendant;
            }
        }
    }

    private static IEnumerable<MeasureExprNode> Children(MeasureExprNode node) => node switch
    {
        UnaryMinusNode unary => [unary.Operand],
        BinaryNode binary => [binary.Left, binary.Right],
        ComparisonNode comparison => [comparison.Left, comparison.Right],
        BooleanBinaryNode boolean => [boolean.Left, boolean.Right],
        NotNode not => [not.Operand],
        IfNode conditional => conditional.Else is null
            ? [conditional.Condition, conditional.Then]
            : [conditional.Condition, conditional.Then, conditional.Else],
        SwitchNode sw => EnumerateSwitchChildren(sw),
        DivideNode divide => divide.Alternate is null
            ? [divide.Numerator, divide.Denominator]
            : [divide.Numerator, divide.Denominator, divide.Alternate],
        ScalarCallNode scalar => scalar.Arguments,
        RoundNode round => [round.Argument],
        PercentOfTotalNode pct => [pct.Inner],
        _ => [],
    };

    private static IEnumerable<MeasureExprNode> EnumerateSwitchChildren(SwitchNode sw)
    {
        yield return sw.Subject;
        foreach (var switchCase in sw.Cases)
        {
            yield return switchCase.Value;
            yield return switchCase.Result;
        }

        if (sw.Default is not null)
        {
            yield return sw.Default;
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
        /// <summary>Comparison tokens, longest first so the tokenizer never mis-splits.</summary>
        private static readonly string[] ComparisonOperators = ["<>", "!=", "<=", ">=", "=", "<", ">"];

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

        /// <summary>Top level: an optional outermost PERCENTOFTOTAL wrapper around a numeric expression.</summary>
        public MeasureExprNode ParseMeasure()
        {
            SkipWhitespace();
            if (TryConsumeWord("percentoftotal"))
            {
                SkipWhitespace();
                Expect('(');
                var inner = ParseNumeric(1, "PERCENTOFTOTAL expects a number as its argument, not a condition");
                SkipWhitespace();
                Expect(')');
                return new PercentOfTotalNode(inner);
            }

            var start = _position;
            var root = ParseCondition(0);
            if (IsBoolean(root))
            {
                throw ErrorAt(start, "a measure must produce a number; wrap the condition in IF(condition, then, else)");
            }

            return root;
        }

        // ---------- boolean layer ----------

        private MeasureExprNode ParseCondition(int depth)
        {
            Guard(depth);
            var node = ParseAndCondition(depth);
            while (true)
            {
                SkipWhitespace();
                var opPosition = _position;
                if (TryConsumeToken("||") || TryConsumeWord("or"))
                {
                    RequireBoolean(node, opPosition, "OR combines two conditions; the left side is not a condition");
                    var right = ParseAndCondition(depth);
                    RequireBoolean(right, opPosition, "OR combines two conditions; the right side is not a condition");
                    node = new BooleanBinaryNode(IsAnd: false, node, right);
                }
                else
                {
                    return node;
                }
            }
        }

        private MeasureExprNode ParseAndCondition(int depth)
        {
            Guard(depth);
            var node = ParseNotCondition(depth);
            while (true)
            {
                SkipWhitespace();
                var opPosition = _position;
                if (TryConsumeToken("&&") || TryConsumeWord("and"))
                {
                    RequireBoolean(node, opPosition, "AND combines two conditions; the left side is not a condition");
                    var right = ParseNotCondition(depth);
                    RequireBoolean(right, opPosition, "AND combines two conditions; the right side is not a condition");
                    node = new BooleanBinaryNode(IsAnd: true, node, right);
                }
                else
                {
                    return node;
                }
            }
        }

        private MeasureExprNode ParseNotCondition(int depth)
        {
            Guard(depth);
            SkipWhitespace();
            var position = _position;
            if (TryConsumeWord("not") || TryConsumeBang())
            {
                var operand = ParseNotCondition(depth + 1);
                RequireBoolean(operand, position, "NOT needs a condition (a comparison or an AND/OR combination)");
                return new NotNode(operand);
            }

            return ParseComparison(depth);
        }

        private MeasureExprNode ParseComparison(int depth)
        {
            Guard(depth);
            var left = ParseAdditive(depth);
            SkipWhitespace();
            var opPosition = _position;
            var op = TryConsumeComparisonOperator();
            if (op is null)
            {
                return left;
            }

            RequireNumeric(left, opPosition, $"the left side of '{op}' must be a number, not a condition");
            var right = ParseAdditive(depth);
            RequireNumeric(right, opPosition, $"the right side of '{op}' must be a number, not a condition");

            SkipWhitespace();
            var chainPosition = _position;
            if (PeekComparisonOperator() is { } chained)
            {
                throw ErrorAt(chainPosition, $"comparisons cannot be chained ('{op}' then '{chained}'); combine them with AND");
            }

            return new ComparisonNode(op, left, right);
        }

        // ---------- numeric layer ----------

        private MeasureExprNode ParseAdditive(int depth)
        {
            Guard(depth);
            var node = ParseTerm(depth);
            while (true)
            {
                SkipWhitespace();
                var opPosition = _position;
                char? op = TryConsume('+') ? '+' : TryConsume('-') ? '-' : null;
                if (op is null)
                {
                    return node;
                }

                RequireNumeric(node, opPosition, $"'{op}' needs numbers on both sides, not conditions");
                var right = ParseTerm(depth);
                RequireNumeric(right, opPosition, $"'{op}' needs numbers on both sides, not conditions");
                node = new BinaryNode(op.Value, node, right);
            }
        }

        private MeasureExprNode ParseTerm(int depth)
        {
            Guard(depth);
            var node = ParseUnary(depth);
            while (true)
            {
                SkipWhitespace();
                var opPosition = _position;
                char? op = TryConsume('*') ? '*' : TryConsume('/') ? '/' : null;
                if (op is null)
                {
                    return node;
                }

                RequireNumeric(node, opPosition, $"'{op}' needs numbers on both sides, not conditions");
                var right = ParseUnary(depth);
                RequireNumeric(right, opPosition, $"'{op}' needs numbers on both sides, not conditions");
                node = new BinaryNode(op.Value, node, right);
            }
        }

        private MeasureExprNode ParseUnary(int depth)
        {
            Guard(depth);
            SkipWhitespace();
            var position = _position;
            if (TryConsume('-'))
            {
                var operand = ParseUnary(depth + 1);
                RequireNumeric(operand, position, "unary '-' needs a number, not a condition");
                return new UnaryMinusNode(operand);
            }

            return ParsePrimary(depth);
        }

        private MeasureExprNode ParsePrimary(int depth)
        {
            Guard(depth);
            SkipWhitespace();
            if (AtEnd)
            {
                throw Error("expected a number, function call, [measure] reference, or '('");
            }

            var c = text[_position];
            if (c == '(')
            {
                _position++;
                // Parenthesized groups are type-transparent: a condition stays
                // a condition, a number stays a number.
                var inner = ParseCondition(depth + 1);
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
                return ParseCall(depth);
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

        // ---------- calls ----------

        private MeasureExprNode ParseCall(int depth)
        {
            var namePosition = _position;
            var name = ParseIdentifier();

            if (TryMapAggregation(name) is { } aggregation)
            {
                return ParseAggregateArguments(aggregation);
            }

            switch (name.ToLowerInvariant())
            {
                case "if":
                    return ParseIf(depth);
                case "switch":
                    return ParseSwitch(depth);
                case "divide":
                    return ParseDivide(depth);
                case "abs":
                    return ParseScalar(ScalarFunction.Abs, depth, argumentCount: 1);
                case "ceiling":
                    return ParseScalar(ScalarFunction.Ceiling, depth, argumentCount: 1);
                case "floor":
                    return ParseScalar(ScalarFunction.Floor, depth, argumentCount: 1);
                case "sqrt":
                    return ParseScalar(ScalarFunction.Sqrt, depth, argumentCount: 1);
                case "exp":
                    return ParseScalar(ScalarFunction.Exp, depth, argumentCount: 1);
                case "ln":
                    return ParseScalar(ScalarFunction.Ln, depth, argumentCount: 1);
                case "power":
                    return ParseScalar(ScalarFunction.Power, depth, argumentCount: 2);
                case "round":
                    return ParseRound(depth);
                case "coalesce":
                    return ParseCoalesce(depth);
                case "blank":
                    SkipWhitespace();
                    Expect('(');
                    SkipWhitespace();
                    Expect(')');
                    return new BlankNode();
                case "percentoftotal":
                    throw ErrorAt(namePosition, "PERCENTOFTOTAL may only wrap the entire measure expression");
                default:
                    throw ErrorAt(
                        namePosition,
                        $"unknown function '{name}' (expected an aggregate like sum/avg/min/max/count/countDistinct/stdDev/variance/median, or IF, SWITCH, DIVIDE, COALESCE, ABS, ROUND, CEILING, FLOOR, SQRT, POWER, EXP, LN, BLANK)");
            }
        }

        private static Aggregation? TryMapAggregation(string name) => name.ToLowerInvariant() switch
        {
            "sum" => Aggregation.Sum,
            "avg" => Aggregation.Avg,
            "min" => Aggregation.Min,
            "max" => Aggregation.Max,
            "count" => Aggregation.Count,
            "countdistinct" => Aggregation.CountDistinct,
            "stddev" => Aggregation.StdDev,
            "variance" => Aggregation.Variance,
            "median" => Aggregation.Median,
            _ => null,
        };

        private MeasureExprNode ParseAggregateArguments(Aggregation aggregation)
        {
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

        private MeasureExprNode ParseIf(int depth)
        {
            SkipWhitespace();
            Expect('(');
            SkipWhitespace();
            var conditionPosition = _position;
            var condition = ParseCondition(depth + 1);
            RequireBoolean(condition, conditionPosition, "IF needs a condition (e.g. [Measure] > 0) as its first argument");
            SkipWhitespace();
            Expect(',');
            var thenExpr = ParseNumeric(depth + 1, "IF branches must be numbers, not conditions");
            SkipWhitespace();
            MeasureExprNode? elseExpr = null;
            if (TryConsume(','))
            {
                elseExpr = ParseNumeric(depth + 1, "IF branches must be numbers, not conditions");
                SkipWhitespace();
            }

            Expect(')');
            return new IfNode(condition, thenExpr, elseExpr);
        }

        private MeasureExprNode ParseSwitch(int depth)
        {
            SkipWhitespace();
            Expect('(');
            var subject = ParseNumeric(depth + 1, "SWITCH arguments must be numbers, not conditions");
            var args = new List<MeasureExprNode>();
            SkipWhitespace();
            while (TryConsume(','))
            {
                args.Add(ParseNumeric(depth + 1, "SWITCH arguments must be numbers, not conditions"));
                SkipWhitespace();
            }

            if (args.Count < 2)
            {
                throw Error("SWITCH needs at least one value/result pair after the subject");
            }

            Expect(')');

            var cases = new List<SwitchCaseNode>(args.Count / 2);
            for (var i = 0; i + 1 < args.Count; i += 2)
            {
                cases.Add(new SwitchCaseNode(args[i], args[i + 1]));
            }

            var @default = args.Count % 2 == 1 ? args[^1] : null;
            return new SwitchNode(subject, cases, @default);
        }

        private MeasureExprNode ParseDivide(int depth)
        {
            SkipWhitespace();
            Expect('(');
            var numerator = ParseNumeric(depth + 1, "DIVIDE arguments must be numbers, not conditions");
            SkipWhitespace();
            Expect(',');
            var denominator = ParseNumeric(depth + 1, "DIVIDE arguments must be numbers, not conditions");
            SkipWhitespace();
            MeasureExprNode? alternate = null;
            if (TryConsume(','))
            {
                alternate = ParseNumeric(depth + 1, "DIVIDE arguments must be numbers, not conditions");
                SkipWhitespace();
            }

            Expect(')');
            return new DivideNode(numerator, denominator, alternate);
        }

        private MeasureExprNode ParseScalar(ScalarFunction function, int depth, int argumentCount)
        {
            SkipWhitespace();
            Expect('(');
            var arguments = new List<MeasureExprNode>(argumentCount)
            {
                ParseNumeric(depth + 1, $"{function.ToString().ToUpperInvariant()} arguments must be numbers, not conditions"),
            };
            for (var i = 1; i < argumentCount; i++)
            {
                SkipWhitespace();
                Expect(',');
                arguments.Add(ParseNumeric(depth + 1, $"{function.ToString().ToUpperInvariant()} arguments must be numbers, not conditions"));
            }

            SkipWhitespace();
            Expect(')');
            return new ScalarCallNode(function, arguments);
        }

        private MeasureExprNode ParseRound(int depth)
        {
            SkipWhitespace();
            Expect('(');
            var argument = ParseNumeric(depth + 1, "ROUND's first argument must be a number, not a condition");
            SkipWhitespace();
            Expect(',');
            SkipWhitespace();

            var digitsPosition = _position;
            var negative = TryConsume('-');
            if (AtEnd || !char.IsAsciiDigit(text[_position]))
            {
                throw ErrorAt(digitsPosition, "ROUND digits must be an integer literal");
            }

            var start = _position;
            while (!AtEnd && char.IsAsciiDigit(text[_position]))
            {
                _position++;
            }

            if (!AtEnd && text[_position] == '.')
            {
                throw ErrorAt(digitsPosition, "ROUND digits must be a whole number");
            }

            if (_position - start > 2)
            {
                throw ErrorAt(digitsPosition, "ROUND digits must be between -12 and 12");
            }

            var digits = int.Parse(text[start.._position], CultureInfo.InvariantCulture);
            if (negative)
            {
                digits = -digits;
            }

            if (digits is < -12 or > 12)
            {
                throw ErrorAt(digitsPosition, "ROUND digits must be between -12 and 12");
            }

            SkipWhitespace();
            Expect(')');
            return new RoundNode(argument, digits);
        }

        private MeasureExprNode ParseCoalesce(int depth)
        {
            SkipWhitespace();
            Expect('(');
            var arguments = new List<MeasureExprNode>
            {
                ParseNumeric(depth + 1, "COALESCE arguments must be numbers, not conditions"),
            };
            SkipWhitespace();
            while (TryConsume(','))
            {
                arguments.Add(ParseNumeric(depth + 1, "COALESCE arguments must be numbers, not conditions"));
                SkipWhitespace();
            }

            if (arguments.Count < 2)
            {
                throw Error("COALESCE needs at least two arguments");
            }

            Expect(')');
            return new ScalarCallNode(ScalarFunction.Coalesce, arguments);
        }

        /// <summary>Parses a full sub-expression and requires it to be numeric.</summary>
        private MeasureExprNode ParseNumeric(int depth, string boolMessage)
        {
            SkipWhitespace();
            var start = _position;
            var node = ParseCondition(depth);
            RequireNumeric(node, start, boolMessage);
            return node;
        }

        // ---------- lexing helpers ----------

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

        private static bool IsBoolean(MeasureExprNode node) => node is ComparisonNode or BooleanBinaryNode or NotNode;

        private MeasureExpressionParseException ErrorAt(int position, string reason) => new(reason, position);

        private void RequireBoolean(MeasureExprNode node, int position, string message)
        {
            if (!IsBoolean(node))
            {
                throw ErrorAt(position, message);
            }
        }

        private void RequireNumeric(MeasureExprNode node, int position, string message)
        {
            if (IsBoolean(node))
            {
                throw ErrorAt(position, message);
            }
        }

        private bool TryConsume(char c)
        {
            if (!AtEnd && text[_position] == c)
            {
                _position++;
                return true;
            }

            return false;
        }

        /// <summary>Consumes the exact token (no word-boundary rule; used for '||' and '&amp;&amp;').</summary>
        private bool TryConsumeToken(string token)
        {
            if (_position + token.Length > text.Length)
            {
                return false;
            }

            if (string.CompareOrdinal(text, _position, token, 0, token.Length) != 0)
            {
                return false;
            }

            _position += token.Length;
            return true;
        }

        /// <summary>Case-insensitive keyword with a word boundary (so 'order' never matches 'or').</summary>
        private bool TryConsumeWord(string word)
        {
            if (_position + word.Length > text.Length)
            {
                return false;
            }

            if (string.Compare(text, _position, word, 0, word.Length, StringComparison.OrdinalIgnoreCase) != 0)
            {
                return false;
            }

            var end = _position + word.Length;
            if (end < text.Length && (char.IsAsciiLetterOrDigit(text[end]) || text[end] == '_'))
            {
                return false;
            }

            _position = end;
            return true;
        }

        /// <summary>'!' as boolean NOT — but never the '!' of a '!=' comparison.</summary>
        private bool TryConsumeBang()
        {
            if (!AtEnd && text[_position] == '!'
                && (_position + 1 >= text.Length || text[_position + 1] != '='))
            {
                _position++;
                return true;
            }

            return false;
        }

        private string? TryConsumeComparisonOperator()
        {
            foreach (var op in ComparisonOperators)
            {
                if (TryConsumeToken(op))
                {
                    return op == "!=" ? "<>" : op;
                }
            }

            return null;
        }

        private string? PeekComparisonOperator()
        {
            foreach (var op in ComparisonOperators)
            {
                if (_position + op.Length <= text.Length
                    && string.CompareOrdinal(text, _position, op, 0, op.Length) == 0)
                {
                    return op == "!=" ? "<>" : op;
                }
            }

            return null;
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
