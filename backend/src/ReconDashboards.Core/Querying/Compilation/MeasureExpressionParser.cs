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

/// <summary>
/// A BARE column leaf (schema.table.column) — the row-level counterpart of
/// <see cref="AggregateCallNode"/>. Legal ONLY in
/// <see cref="ExpressionContext.Dimension"/>: inside a measure the SELECT list
/// is already grouped, so a bare column is a "not in GROUP BY" SQL error, not a
/// style choice. Identifiers are raw text here and are resolved against the
/// catalog — and against the derived field's OWN table — before any SQL.
/// </summary>
public sealed record ColumnRefNode(string TableKey, string Column) : MeasureExprNode;

/// <summary>
/// A text literal. *** THE VALUE IS NEVER EMITTED. *** It is bound through
/// <see cref="ParameterBag"/> exactly as a filter value is, because this is the
/// first and only category of author text the renderer can output at all —
/// everything else in an expression is a validated digit, a whitelisted
/// operator, or a resolved catalog identifier. Legal only in
/// <see cref="ExpressionContext.Dimension"/>.
/// </summary>
public sealed record StringLiteralNode(string Value) : MeasureExprNode;

/// <summary>x IS NULL / x IS NOT NULL. Row-level only.</summary>
public sealed record IsNullNode(MeasureExprNode Operand, bool Negated) : MeasureExprNode;

/// <summary>
/// ISBLANK(x) — NULL or the empty string, which is exactly the "(Blank)" bucket
/// a category axis shows. Row-level only.
/// </summary>
public sealed record IsBlankNode(MeasureExprNode Operand) : MeasureExprNode;

/// <summary>
/// Which grammar a text is parsed against.
///
/// <para><see cref="Measure"/> — the historical grammar, UNCHANGED: aggregate
/// calls and [references] are required, the result must be a number, and there
/// is no way to name a bare column or write a literal string.</para>
///
/// <para><see cref="Dimension"/> — the ROW-LEVEL grammar of a derived field:
/// bare column leaves, string literals, ISBLANK/IS NULL and TEXT results are
/// legal; aggregates and [references] are ERRORS (they would make the
/// expression a measure, and a measure cannot be a category).</para>
/// </summary>
public enum ExpressionContext
{
    Measure,
    Dimension,
}

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
/// <para>*** ROW-LEVEL GRAMMAR (<see cref="ExpressionContext.Dimension"/>) ***
/// A derived FIELD is parsed against the same grammar plus, gated STRICTLY on
/// the context flag:
/// <code>
///   field     := condition checked to produce TEXT
///   primary   += string | column
///   compare   += additive 'IS' ['NOT'] 'NULL'
///   call      += ISBLANK '(' value ')'
///   column    := ident '.' ident '.' ident        (schema.table.column)
///   string    := '"' chars '"' | '\'' chars '\''  (doubled delimiter escapes)
/// </code>
/// and MINUS aggregates and [references], which are positioned errors there.
/// The two directions are exact complements: a bare column in a measure is an
/// error, an aggregate in a dimension is an error.</para>
///
/// <para>TYPES are a three-way lattice — number | bool | text — plus the top
/// element <c>any</c>, which ONLY a leaf whose type the catalog owns (a column
/// ref) or a NULL (BLANK()) can have; it unifies with either number or text.
/// Arithmetic requires number, AND/OR/NOT/IF-conditions require bool,
/// comparisons require two operands of the SAME side of the lattice, a measure
/// must produce number, and a derived field must produce text.</para>
///
/// This is the SECURITY chokepoint for expressions: nothing outside this
/// grammar parses, every identifier must later resolve against the
/// catalog/model, operators are re-emitted from a normalized whitelist, ROUND
/// digits are range-checked integers, and no input substring is ever copied
/// into SQL — only validated numeric literals, dialect-rendered fragments, and
/// string literals BOUND AS PARAMETERS are emitted.
/// </summary>
public static class MeasureExpressionParser
{
    private const int MaxLength = 2_000;
    private const int MaxDepth = 32;

    /// <summary>Longest single string literal, characters.</summary>
    private const int MaxStringLiteralLength = 256;

    /// <summary>
    /// COMPLEXITY CAP for a row-level expression, in AST nodes. Unlike a measure
    /// expression — which the database evaluates once per GROUP — a derived
    /// field is evaluated FOR EVERY ROW, inside GROUP BY, with no index to help
    /// it. The length and depth caps bound the text; this bounds the work.
    /// </summary>
    private const int MaxRowLevelNodes = 120;

    /// <summary>Parses or throws <see cref="MeasureExpressionParseException"/>. The result always contains at least one aggregate call or measure reference.</summary>
    public static MeasureExprNode Parse(string expression) => Parse(expression, ExpressionContext.Measure);

    /// <summary>
    /// Parses <paramref name="expression"/> against the grammar of
    /// <paramref name="context"/>, or throws
    /// <see cref="MeasureExpressionParseException"/> with a zero-based position.
    /// A measure tree always holds at least one aggregate call or [reference]
    /// and never a row-level leaf; a dimension tree always holds at least one
    /// column ref and never an aggregate or [reference].
    /// </summary>
    public static MeasureExprNode Parse(string expression, ExpressionContext context)
    {
        ArgumentNullException.ThrowIfNull(expression);
        if (expression.Length > MaxLength)
        {
            throw new MeasureExpressionParseException($"expression is longer than {MaxLength} characters", 0);
        }

        var parser = new Parser(expression, context);
        var root = context == ExpressionContext.Dimension ? parser.ParseField() : parser.ParseMeasure();
        parser.SkipWhitespace();
        if (!parser.AtEnd)
        {
            throw parser.Error("unexpected trailing input");
        }

        // Belt and braces behind the context gates above: the shape of the tree
        // is asserted independently of the path that built it, so a future
        // production that forgets its gate fails here instead of emitting SQL.
        if (context == ExpressionContext.Dimension)
        {
            var nodes = 0;
            var columns = 0;
            foreach (var node in Flatten(root))
            {
                nodes++;
                switch (node)
                {
                    case AggregateCallNode:
                        throw new MeasureExpressionParseException(
                            "a derived field is computed row by row and cannot contain an aggregate; put the aggregate in a measure instead", 0);
                    case MeasureRefNode:
                        throw new MeasureExpressionParseException(
                            "a derived field cannot reference a [measure]; measures are aggregates and a derived field is computed row by row", 0);
                    case PercentOfTotalNode:
                        throw new MeasureExpressionParseException(
                            "PERCENTOFTOTAL is a measure calculation and has no meaning in a derived field", 0);
                    case ColumnRefNode:
                        columns++;
                        break;
                }
            }

            if (columns == 0)
            {
                throw new MeasureExpressionParseException(
                    "a derived field must reference at least one column of its table", 0);
            }

            if (nodes > MaxRowLevelNodes)
            {
                throw new MeasureExpressionParseException(
                    $"a derived field may use at most {MaxRowLevelNodes} operations; this one uses {nodes}", 0);
            }

            return root;
        }

        var hasAggregate = false;
        foreach (var node in Flatten(root))
        {
            switch (node)
            {
                case AggregateCallNode or MeasureRefNode:
                    hasAggregate = true;
                    break;
                case ColumnRefNode or StringLiteralNode or IsNullNode or IsBlankNode:
                    throw new MeasureExpressionParseException(
                        "row-level values (a bare column, a text literal, ISBLANK, IS NULL) belong in a derived field, not a measure", 0);
            }
        }

        if (!hasAggregate)
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
        IsNullNode isNull => [isNull.Operand],
        IsBlankNode isBlank => [isBlank.Operand],
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

    /// <summary>
    /// The three-way result lattice plus its top element.
    /// <see cref="Any"/> belongs to leaves whose real type only the CATALOG
    /// knows (a column ref) and to NULL (BLANK()): it unifies with
    /// <see cref="Number"/> or <see cref="Text"/> and never with
    /// <see cref="Bool"/>, so "aggregates only in measures, row-level only in
    /// dimensions" stays decidable at parse time without a schema.
    /// </summary>
    private enum ValueType
    {
        Number,
        Bool,
        Text,
        Any,
    }

    private sealed class Parser(string text, ExpressionContext context)
    {
        /// <summary>Comparison tokens, longest first so the tokenizer never mis-splits.</summary>
        private static readonly string[] ComparisonOperators = ["<>", "!=", "<=", ">=", "=", "<", ">"];

        private int _position;

        private bool RowLevel => context == ExpressionContext.Dimension;

        /// <summary>
        /// The noun a type-discipline message uses. In a measure a non-condition
        /// is always a number, so every historical message is byte-identical;
        /// in a derived field it may be text as well.
        /// </summary>
        private string ValueNoun => RowLevel ? "values" : "numbers";

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

        /// <summary>
        /// Top level of a DERIVED FIELD: any row-level expression whose result
        /// is a category label. A condition is not a label (wrap it in IF); a
        /// number is not a label either — that is a measure.
        /// </summary>
        public MeasureExprNode ParseField()
        {
            SkipWhitespace();
            var start = _position;
            var root = ParseCondition(0);
            return TypeOf(root) switch
            {
                ValueType.Text or ValueType.Any => root,
                ValueType.Bool => throw ErrorAt(
                    start,
                    "a derived field must produce a label; wrap the condition in IF(condition, \"Yes\", \"No\")"),
                _ => throw ErrorAt(
                    start,
                    "a derived field must produce a label, not a number; name the buckets with IF(condition, \"...\", \"...\") or make it a measure"),
            };
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

            // Row-level only: "x IS NULL" / "x IS NOT NULL". Gated on the
            // context so the measure tokenizer is byte-identical to before.
            if (RowLevel && TryConsumeWord("is"))
            {
                SkipWhitespace();
                var negated = TryConsumeWord("not");
                SkipWhitespace();
                if (!TryConsumeWord("null"))
                {
                    throw Error("expected NULL after IS (write 'x IS NULL' or 'x IS NOT NULL')");
                }

                RequireValue(left, opPosition, "IS NULL tests a value, not a condition");
                return new IsNullNode(left, negated);
            }

            var op = TryConsumeComparisonOperator();
            if (op is null)
            {
                return left;
            }

            RequireValue(left, opPosition, $"the left side of '{op}' must be a {ValueNoun[..^1]}, not a condition");
            var right = ParseAdditive(depth);
            RequireValue(right, opPosition, $"the right side of '{op}' must be a {ValueNoun[..^1]}, not a condition");
            if (Unify(TypeOf(left), TypeOf(right)) is null)
            {
                throw ErrorAt(opPosition, $"'{op}' cannot compare a number with text");
            }

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
                throw Error(RowLevel
                    ? "expected a column, text literal, number, function call, or '('"
                    : "expected a number, function call, [measure] reference, or '('");
            }

            var c = text[_position];
            if (RowLevel && (c == '"' || c == '\''))
            {
                return ParseStringLiteral();
            }

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
                if (RowLevel)
                {
                    throw Error(
                        "a derived field cannot reference a [measure]; measures are aggregates and a derived field is computed row by row");
                }

                return ParseMeasureRef();
            }

            if (char.IsAsciiDigit(c))
            {
                return ParseNumber();
            }

            if (IsIdentStart(c))
            {
                return ParseCallOrColumn(depth);
            }

            throw Error($"unexpected character '{c}'");
        }

        /// <summary>
        /// A quoted text literal, with the delimiter doubled to escape itself
        /// ("a ""b""" / 'a ''b'''). The VALUE is kept as data on the node and is
        /// bound as a parameter at emission — it is never concatenated into SQL,
        /// so no escaping decision here can become an injection.
        /// </summary>
        private MeasureExprNode ParseStringLiteral()
        {
            var quote = text[_position];
            var start = _position;
            _position++;

            var value = new System.Text.StringBuilder();
            while (true)
            {
                if (AtEnd)
                {
                    throw ErrorAt(start, "unterminated text literal");
                }

                var c = text[_position];
                if (c == quote)
                {
                    if (_position + 1 < text.Length && text[_position + 1] == quote)
                    {
                        value.Append(quote);
                        _position += 2;
                        continue;
                    }

                    _position++;
                    break;
                }

                if (c is '\n' or '\r')
                {
                    throw ErrorAt(start, "a text literal may not span lines");
                }

                value.Append(c);
                _position++;
            }

            if (value.Length > MaxStringLiteralLength)
            {
                throw ErrorAt(start, $"a text literal may be at most {MaxStringLiteralLength} characters");
            }

            return new StringLiteralNode(value.ToString());
        }

        /// <summary>
        /// An identifier starts either a function call or — row-level only — a
        /// bare schema.table.column leaf. The '.' after the first identifier is
        /// what tells them apart, so no keyword is reserved and 'sum' still
        /// means the aggregate everywhere it did before.
        /// </summary>
        private MeasureExprNode ParseCallOrColumn(int depth)
        {
            var namePosition = _position;
            var name = ParseIdentifier();
            SkipWhitespace();

            if (RowLevel && !AtEnd && text[_position] == '.')
            {
                _position++;
                SkipWhitespace();
                var table = ParseIdentifier();
                SkipWhitespace();
                Expect('.');
                SkipWhitespace();
                var column = ParseIdentifier();
                return new ColumnRefNode($"{name}.{table}", column);
            }

            return ParseCall(name, namePosition, depth);
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

        private MeasureExprNode ParseCall(string name, int namePosition, int depth)
        {
            if (TryMapAggregation(name) is { } aggregation)
            {
                if (RowLevel)
                {
                    throw ErrorAt(
                        namePosition,
                        $"a derived field is computed row by row and cannot use the aggregate '{name}'; put the aggregate in a measure instead");
                }

                return ParseAggregateArguments(aggregation);
            }

            switch (name.ToLowerInvariant())
            {
                case "isblank":
                    if (!RowLevel)
                    {
                        throw ErrorAt(namePosition, "ISBLANK tests a row-level value and is only available in a derived field");
                    }

                    return ParseIsBlank(depth);
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
                        RowLevel
                            ? $"unknown function '{name}' (expected IF, SWITCH, ISBLANK, COALESCE, BLANK, or a schema.table.column reference)"
                            : $"unknown function '{name}' (expected an aggregate like sum/avg/min/max/count/countDistinct/stdDev/variance/median, or IF, SWITCH, DIVIDE, COALESCE, ABS, ROUND, CEILING, FLOOR, SQRT, POWER, EXP, LN, BLANK)");
            }
        }

        /// <summary>ISBLANK(x) — NULL or empty, the "(Blank)" bucket of a category axis.</summary>
        private MeasureExprNode ParseIsBlank(int depth)
        {
            SkipWhitespace();
            Expect('(');
            var argument = ParseValue(depth + 1, "ISBLANK tests a value, not a condition");
            SkipWhitespace();
            Expect(')');
            return new IsBlankNode(argument);
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
            var branchPosition = _position;
            var thenExpr = ParseValue(depth + 1, $"IF branches must be {ValueNoun}, not conditions");
            SkipWhitespace();
            MeasureExprNode? elseExpr = null;
            if (TryConsume(','))
            {
                elseExpr = ParseValue(depth + 1, $"IF branches must be {ValueNoun}, not conditions");
                SkipWhitespace();
                if (Unify(TypeOf(thenExpr), TypeOf(elseExpr)) is null)
                {
                    throw ErrorAt(branchPosition, "IF branches must both be numbers or both be text");
                }
            }

            Expect(')');
            return new IfNode(condition, thenExpr, elseExpr);
        }

        private MeasureExprNode ParseSwitch(int depth)
        {
            SkipWhitespace();
            Expect('(');
            var subject = ParseValue(depth + 1, $"SWITCH arguments must be {ValueNoun}, not conditions");
            var args = new List<MeasureExprNode>();
            SkipWhitespace();
            while (TryConsume(','))
            {
                args.Add(ParseValue(depth + 1, $"SWITCH arguments must be {ValueNoun}, not conditions"));
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
                ParseValue(depth + 1, $"COALESCE arguments must be {ValueNoun}, not conditions"),
            };
            SkipWhitespace();
            while (TryConsume(','))
            {
                arguments.Add(ParseValue(depth + 1, $"COALESCE arguments must be {ValueNoun}, not conditions"));
                SkipWhitespace();
            }

            if (arguments.Count < 2)
            {
                throw Error("COALESCE needs at least two arguments");
            }

            Expect(')');
            return new ScalarCallNode(ScalarFunction.Coalesce, arguments);
        }

        /// <summary>Parses a full sub-expression and requires it to be numeric (never a condition, never text).</summary>
        private MeasureExprNode ParseNumeric(int depth, string boolMessage)
        {
            SkipWhitespace();
            var start = _position;
            var node = ParseCondition(depth);
            RequireNumeric(node, start, boolMessage);
            return node;
        }

        /// <summary>
        /// Parses a full sub-expression and requires it to be a VALUE — a
        /// number or, row-level, text — but never a condition. In a measure
        /// this is exactly <see cref="ParseNumeric"/> (text cannot be spelled
        /// there at all), which is why every historical message and position
        /// is unchanged.
        /// </summary>
        private MeasureExprNode ParseValue(int depth, string boolMessage)
        {
            SkipWhitespace();
            var start = _position;
            var node = ParseCondition(depth);
            RequireValue(node, start, boolMessage);
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

        private static bool IsBoolean(MeasureExprNode node) => TypeOf(node) == ValueType.Bool;

        /// <summary>
        /// The lattice type of a subtree, structurally — the parser has no
        /// catalog, so a column ref (and a NULL) is <see cref="ValueType.Any"/>
        /// and unifies with whatever it meets. Branching forms take the
        /// unification of their result arms; an unresolvable pair was already
        /// rejected where it was parsed, so falling back to
        /// <see cref="ValueType.Any"/> here is unreachable, not lenient.
        /// </summary>
        private static ValueType TypeOf(MeasureExprNode node) => node switch
        {
            ComparisonNode or BooleanBinaryNode or NotNode or IsNullNode or IsBlankNode => ValueType.Bool,
            StringLiteralNode => ValueType.Text,
            ColumnRefNode or BlankNode => ValueType.Any,
            IfNode conditional => Unify(
                TypeOf(conditional.Then),
                conditional.Else is null ? ValueType.Any : TypeOf(conditional.Else)) ?? ValueType.Any,
            SwitchNode sw => sw.Cases
                .Select(c => TypeOf(c.Result))
                .Append(sw.Default is null ? ValueType.Any : TypeOf(sw.Default))
                .Aggregate((ValueType?)ValueType.Any, (a, b) => a is null ? null : Unify(a.Value, b)) ?? ValueType.Any,
            ScalarCallNode { Function: ScalarFunction.Coalesce } coalesce => coalesce.Arguments
                .Select(TypeOf)
                .Aggregate((ValueType?)ValueType.Any, (a, b) => a is null ? null : Unify(a.Value, b)) ?? ValueType.Any,
            _ => ValueType.Number,
        };

        /// <summary>
        /// The lattice join. <see cref="ValueType.Any"/> is the top element and
        /// absorbs into whatever it meets; number and text never unify, and
        /// bool unifies with nothing but itself. Null means "these cannot be
        /// the same value".
        /// </summary>
        private static ValueType? Unify(ValueType left, ValueType right)
        {
            if (left == ValueType.Any)
            {
                return right;
            }

            if (right == ValueType.Any)
            {
                return left;
            }

            return left == right ? left : null;
        }

        private MeasureExpressionParseException ErrorAt(int position, string reason) => new(reason, position);

        private void RequireBoolean(MeasureExprNode node, int position, string message)
        {
            if (!IsBoolean(node))
            {
                throw ErrorAt(position, message);
            }
        }

        /// <summary>Rejects a condition where a value is expected; text is allowed.</summary>
        private void RequireValue(MeasureExprNode node, int position, string message)
        {
            if (IsBoolean(node))
            {
                throw ErrorAt(position, message);
            }
        }

        /// <summary>Rejects a condition (with the caller's message) and text (with the lattice's).</summary>
        private void RequireNumeric(MeasureExprNode node, int position, string message)
        {
            switch (TypeOf(node))
            {
                case ValueType.Bool:
                    throw ErrorAt(position, message);
                case ValueType.Text:
                    throw ErrorAt(position, "text cannot be used where a number is required");
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
