using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Golden-SQL tests for ChartQuerySpec.Offset: parameterized OFFSET after the
/// final LIMIT, only when positive, clamped at zero, rejected past the
/// 1,000,000 ceiling, and composing with Top-N and window calcs (the offset
/// always rides the FINAL select).
/// </summary>
public class QueryCompilerOffsetTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static MeasureSpec SumOrderTotal(MeasureCalcSpec? calc = null) =>
        new(null, "public.orders", "order_total", Aggregation.Sum, null, calc);

    private static DimensionSpec CustomerRegion() => new("public.customers", "region", null);

    private static ChartQuerySpec Spec(
        int? offset,
        int? limit = null,
        TopNSpec? topN = null,
        IReadOnlyList<MeasureSpec>? measures = null,
        IReadOnlyList<DimensionSpec>? dimensions = null) =>
        new(1, dimensions ?? [CustomerRegion()], measures ?? [SumOrderTotal()], [], [], topN, limit, offset);

    private static CompiledQuery Compile(ChartQuerySpec spec)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), limits);
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    private static void AssertSql(string expected, CompiledQuery compiled)
    {
        expected = expected.ReplaceLineEndings("\n");
        if (!string.Equals(expected, compiled.Sql, StringComparison.Ordinal))
        {
            Assert.Fail($"SQL mismatch.\n--- expected ---\n{expected}\n--- actual ---\n{compiled.Sql}\n--- end ---");
        }
    }

    [Fact]
    public void OffsetEmitsParameterizedOffsetAfterLimit()
    {
        var compiled = Compile(Spec(offset: 40, limit: 100));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
ORDER BY "t1"."region" ASC NULLS LAST
LIMIT @p0
OFFSET @p1
""", compiled);

        Assert.Equal(2, compiled.Parameters.Count);
        Assert.Equal(101L, compiled.Parameters[0].Value); // limit + truncation probe
        Assert.Equal("p1", compiled.Parameters[1].Name);
        Assert.Equal(40L, compiled.Parameters[1].Value);
        Assert.Equal(NormalizedType.Integer, compiled.Parameters[1].Type);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    [InlineData(-25)] // negative clamps to 0: no clause, never an error
    public void MissingZeroOrNegativeOffsetEmitsNoOffsetClause(int? offset)
    {
        var compiled = Compile(Spec(offset));

        Assert.DoesNotContain("OFFSET", compiled.Sql, StringComparison.Ordinal);
        var limitParam = Assert.Single(compiled.Parameters);
        Assert.Equal(5001L, limitParam.Value);
    }

    [Fact]
    public void OffsetWithoutExplicitSortIsAllowedAndKeepsDefaultOrdering()
    {
        // Documented behavior: allowed; the engine's default dimension ordering
        // still applies, residual nondeterminism is the caller's concern.
        var compiled = Compile(Spec(offset: 10));

        Assert.Contains("ORDER BY \"t1\".\"region\" ASC NULLS LAST", compiled.Sql, StringComparison.Ordinal);
        Assert.EndsWith("OFFSET @p1", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void OffsetAboveCeilingIsRejected()
    {
        var spec = Spec(offset: 1_000_001);
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(spec, TestFixtures.BuildValidDemoModel(), TestFixtures.BuildDemoSchema(), limits);

        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions()));
        Assert.Equal("QRY_BAD_OFFSET", ex.Code);
    }

    [Fact]
    public void OffsetAtCeilingIsAccepted()
    {
        var compiled = Compile(Spec(offset: 1_000_000));
        Assert.EndsWith("OFFSET @p1", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(1_000_000L, compiled.Parameters[1].Value);
    }

    [Fact]
    public void OffsetComposesWithFlatTopN()
    {
        var compiled = Compile(Spec(offset: 3, topN: new TopNSpec(5, 0, IncludeOthers: false)));

        AssertSql("""
SELECT "t1"."region" AS "dim0",
       SUM("t0"."order_total") AS "meas0"
FROM "public"."orders" AS "t0"
LEFT JOIN "public"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region"
ORDER BY "meas0" DESC NULLS LAST, "t1"."region" ASC NULLS LAST
LIMIT @p0
OFFSET @p1
""", compiled);

        Assert.Equal(6L, compiled.Parameters[0].Value); // n + 1
        Assert.Equal(3L, compiled.Parameters[1].Value);
    }

    [Fact]
    public void OffsetWithTopNOthersAppliesToTheFinalSelectOnly()
    {
        var compiled = Compile(Spec(offset: 2, topN: new TopNSpec(5, 0, IncludeOthers: true)));

        // The inner ranked CTE keeps only its own LIMIT; exactly one OFFSET,
        // on the outer folded select, bound as the last parameter.
        Assert.EndsWith($"OFFSET @{compiled.Parameters[^1].Name}", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(compiled.Sql, "OFFSET"));
        Assert.Equal(2L, compiled.Parameters[^1].Value);
    }

    [Fact]
    public void OffsetWithCalcMeasureAppliesToTheFinalSelect()
    {
        var compiled = Compile(Spec(
            offset: 7,
            measures: [SumOrderTotal(new MeasureCalcSpec(MeasureCalcKind.RunningTotal))]));

        Assert.Contains("__rcd_base", compiled.Sql, StringComparison.Ordinal);
        Assert.EndsWith("OFFSET @p1", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(compiled.Sql, "OFFSET"));
        Assert.Equal(7L, compiled.Parameters[^1].Value);
    }

    [Fact]
    public void OffsetWithKpiShapeStillEmits()
    {
        // No dimensions: nondeterminism is on the caller, but the clause emits.
        var compiled = Compile(Spec(offset: 1, dimensions: []));
        Assert.EndsWith("OFFSET @p1", compiled.Sql, StringComparison.Ordinal);
    }

    private static int CountOccurrences(string text, string token)
    {
        var count = 0;
        var index = 0;
        while ((index = text.IndexOf(token, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += token.Length;
        }

        return count;
    }
}
