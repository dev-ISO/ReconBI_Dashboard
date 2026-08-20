using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Schema;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// TOMBSTONES — the compiler half of per-measure error isolation.
///
/// The whole point is POSITIONAL STABILITY. Result columns are "meas0",
/// "meas1", … and sort targets, having indexes, Top-N's ByMeasureIndex and the
/// table chart's column-keyed format maps are all indexes into that same
/// sequence. Dropping a broken measure instead of tombstoning it would renumber
/// everything after it and silently re-point formatting and sorting at the
/// wrong series. Every test here is a statement about a position surviving.
/// </summary>
public class QueryCompilerTombstoneTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<RowFilter>> NoRowFilters =
        new Dictionary<string, IReadOnlyList<RowFilter>>();

    private static readonly DatabaseSchema Schema = TestFixtures.BuildDemoSchema();

    private static MeasureSpec Inline(string table, string? column, Aggregation aggregation, string? alias = null) =>
        new(null, table, column, aggregation, alias);

    private static ChartQuerySpec Spec(
        IReadOnlyList<MeasureSpec> measures,
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<SortSpec>? sort = null,
        IReadOnlyList<HavingSpec>? having = null,
        TopNSpec? topN = null) =>
        new(1, dimensions ?? [new DimensionSpec("public.customers", "region", null)],
            measures, [], sort ?? [], topN, null, null, having);

    private static CompiledQuery Compile(
        ChartQuerySpec spec, ModelDefinition? model = null, params int[] tombstones)
    {
        var limits = new RcdLimits();
        var prepared = Compiler.Prepare(
            spec, model ?? TestFixtures.BuildValidDemoModel(), Schema, limits,
            tombstones.Length == 0 ? null : new HashSet<int>(tombstones));
        return Compiler.Emit(prepared, spec, NoRowFilters, limits, new DataSourceOptions());
    }

    /// <summary>Three measures over the demo model; index 1 is the one tests break.</summary>
    private static ChartQuerySpec ThreeMeasureSpec() => Spec(
    [
        Inline("public.orders", "order_total", Aggregation.Sum, "Revenue"),
        Inline("public.orders", "order_total", Aggregation.Avg, "Average order"),
        Inline("public.orders", null, Aggregation.Count, "Orders"),
    ]);

    // ------------------------------------------------------------ the core claim

    [Fact]
    public void TombstoningTheMiddleMeasureLeavesEveryOtherResultColumnIdentical()
    {
        var spec = ThreeMeasureSpec();
        var healthy = Compile(spec);
        var isolated = Compile(spec, null, 1);

        // Same number of columns, same names, same order: nothing renumbered.
        Assert.Equal(
            healthy.Columns.Select(c => c.Name),
            isolated.Columns.Select(c => c.Name));
        Assert.Equal(["dim0", "meas0", "meas1", "meas2"], isolated.Columns.Select(c => c.Name));

        // The survivors keep their label, role and type EXACTLY.
        Assert.Equal(healthy.Columns[0], isolated.Columns[0]); // dim0
        Assert.Equal(healthy.Columns[1], isolated.Columns[1]); // meas0
        Assert.Equal(healthy.Columns[3], isolated.Columns[3]); // meas2

        // The tombstone keeps its position and its label; only its type is
        // normalized to the decimal its NULL is cast to.
        var tombstone = isolated.Columns[2];
        Assert.Equal("meas1", tombstone.Name);
        Assert.Equal("Average order", tombstone.Label);
        Assert.Equal(ResultColumnRole.Measure, tombstone.Role);
        Assert.Equal(NormalizedType.Decimal, tombstone.Type);
        Assert.Null(tombstone.Source);
    }

    [Fact]
    public void TheTombstoneSelectsATypedNullUnderItsOriginalAliasAndNothingElseChanges()
    {
        var isolated = Compile(ThreeMeasureSpec(), null, 1);

        Assert.Contains("CAST(NULL AS decimal) AS \"meas1\"", isolated.Sql, StringComparison.Ordinal);

        // The surviving measures' SQL is untouched...
        Assert.Contains("SUM(\"t0\".\"order_total\") AS \"meas0\"", isolated.Sql, StringComparison.Ordinal);
        Assert.Contains("COUNT(*) AS \"meas2\"", isolated.Sql, StringComparison.Ordinal);
        // ...and the broken one's aggregate is gone entirely.
        Assert.DoesNotContain("AVG(", isolated.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void ASortTargetingASurvivingMeasureStillPointsAtTheSameColumn()
    {
        var spec = ThreeMeasureSpec() with
        {
            Sort = [new SortSpec(new SortTarget(SortTargetKind.Measure, 2), SortDirection.Desc)],
        };

        var healthy = Compile(spec);
        var isolated = Compile(spec, null, 1);

        // The sort names meas2 in both — the whole reason a tombstone exists.
        // Had the broken measure been DROPPED, "meas2" would no longer exist and
        // this sort would either fail or silently rank by the wrong series.
        Assert.Contains("ORDER BY \"meas2\" DESC", healthy.Sql, StringComparison.Ordinal);
        Assert.Contains("ORDER BY \"meas2\" DESC", isolated.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void ASortTargetingTheTombstoneStillCompilesAndOrdersByItsNullColumn()
    {
        var spec = ThreeMeasureSpec() with
        {
            Sort = [new SortSpec(new SortTarget(SortTargetKind.Measure, 1), SortDirection.Desc)],
        };

        var isolated = Compile(spec, null, 1);

        // The index is still valid; the column is simply constant.
        Assert.Contains("ORDER BY \"meas1\" DESC", isolated.Sql, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------- the join plan

    [Fact]
    public void ATombstoneContributesNoTableToTheJoinPlan()
    {
        // measures[1] is the ONLY thing naming public.inspections.
        var model = TestFixtures.BuildValidDemoModel() with
        {
            Tables =
            [
                TestFixtures.BuildModelTable("public", "customers"),
                TestFixtures.BuildModelTable("public", "orders"),
                TestFixtures.BuildModelTable("public", "inspections"),
            ],
            Relationships =
            [
                TestFixtures.BuildRelationship("public.orders", "customer_id", "public.customers", "id"),
                TestFixtures.BuildRelationship("public.inspections", "order_id", "public.orders", "id"),
            ],
        };

        var spec = Spec(
        [
            Inline("public.orders", "order_total", Aggregation.Sum),
            Inline("public.inspections", null, Aggregation.Count),
        ]);

        var limits = new RcdLimits();
        var whole = Compiler.Prepare(spec, model, Schema, limits);
        Assert.Contains("public.inspections", whole.Plan.Tables);

        var isolated = Compiler.Prepare(spec, model, Schema, limits, new HashSet<int> { 1 });

        // A tombstone reads nothing, so its table must not be joined — and
        // therefore must not be handed to the row-filter collection either.
        Assert.DoesNotContain("public.inspections", isolated.Plan.Tables);
        Assert.Equal(2, isolated.Measures.Count);
    }

    [Fact]
    public void TombstoningTheFirstMeasureMovesTheAnchorToTheFirstSurvivor()
    {
        var spec = Spec(
        [
            Inline("public.customers", "credit_limit", Aggregation.Sum),
            Inline("public.orders", "order_total", Aggregation.Sum),
        ]);

        var limits = new RcdLimits();
        Assert.Equal("public.customers", Compiler.Prepare(spec, TestFixtures.BuildValidDemoModel(), Schema, limits).Plan.BaseTable);

        var isolated = Compiler.Prepare(
            spec, TestFixtures.BuildValidDemoModel(), Schema, limits, new HashSet<int> { 0 });

        Assert.Equal("public.orders", isolated.Plan.BaseTable);
    }

    // ------------------------------------------------------------------- HAVING

    [Fact]
    public void AHavingConditionOnATombstonedMeasureIsDroppedRatherThanBlankingTheChart()
    {
        // "HAVING CAST(NULL AS decimal) > 100" is UNKNOWN for every group, so
        // rendering it would return ZERO rows — one broken measure turning into
        // a blank chart, which is exactly what tombstoning exists to prevent.
        var spec = ThreeMeasureSpec() with
        {
            Having =
            [
                new HavingSpec(1, HavingOperator.Gt, [100]),
                new HavingSpec(0, HavingOperator.Gt, [5]),
            ],
        };

        var isolated = Compile(spec, null, 1);

        Assert.DoesNotContain("CAST(NULL AS decimal) >", isolated.Sql, StringComparison.Ordinal);
        // The surviving measure's condition is still enforced.
        Assert.Contains("HAVING SUM(\"t0\".\"order_total\") > @p", isolated.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void AnInvalidHavingOnATombstonedMeasureDoesNotFailTheQuery()
    {
        // Between with one value is normally QRY_BAD_HAVING. Targeting a
        // tombstone, the condition is never rendered, so validating it would
        // fail the whole query over a measure that already failed on its own.
        var spec = ThreeMeasureSpec() with
        {
            Having = [new HavingSpec(1, HavingOperator.Between, [100])],
        };

        Assert.Throws<QueryCompilationException>(() => Compile(spec));

        var isolated = Compile(spec, null, 1);
        Assert.DoesNotContain("HAVING", isolated.Sql, StringComparison.Ordinal);
    }

    // -------------------------------------------------------------------- Top N

    [Fact]
    public void RankingByATombstonedMeasureStillCompilesButWarns()
    {
        var spec = ThreeMeasureSpec() with { TopN = new TopNSpec(5, ByMeasureIndex: 1, IncludeOthers: false) };

        var isolated = Compile(spec, null, 1);

        Assert.Contains(isolated.Warnings, w => w.Code == "QRY_TOPN_MEASURE_UNAVAILABLE");
        Assert.Contains("ORDER BY \"meas1\" DESC", isolated.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void RankingBySurvivingMeasureNeverWarnsAboutTheTombstone()
    {
        var spec = ThreeMeasureSpec() with { TopN = new TopNSpec(5, ByMeasureIndex: 0, IncludeOthers: true) };

        var isolated = Compile(spec, null, 1);

        Assert.DoesNotContain(isolated.Warnings, w => w.Code == "QRY_TOPN_MEASURE_UNAVAILABLE");
        // The Others fold still references every measure position, tombstone included.
        Assert.Contains("AS \"meas1\"", isolated.Sql, StringComparison.Ordinal);
    }

    // -------------------------------------------------------------------- labels

    [Fact]
    public void ATombstoneLabelsItselfFromTheAliasThenTheDefinitionNameThenItsPosition()
    {
        var model = TestFixtures.BuildValidDemoModel();
        var modelMeasure = model.Measures[0];
        var unknownId = Guid.NewGuid();

        var spec = Spec(
        [
            Inline("public.orders", "order_total", Aggregation.Sum),         // survivor, anchors the plan
            new MeasureSpec(unknownId, null, null, null, "My alias"),        // alias wins
            new MeasureSpec(modelMeasure.Id, null, null, null, null),        // the model measure's own name
            new MeasureSpec(unknownId, null, null, null, null),              // nothing known: positional
        ]);

        var isolated = Compile(spec, model, 1, 2, 3);

        Assert.Equal("My alias", isolated.Columns[2].Label);
        Assert.Equal(modelMeasure.Name, isolated.Columns[3].Label);
        Assert.Equal("Measure 4", isolated.Columns[4].Label);
    }

    [Fact]
    public void ATombstonedCalcMeasureKeepsItsLabelSuffixSoTheSeriesKeyIsUnchanged()
    {
        var spec = Spec(
            [
                Inline("public.orders", "order_total", Aggregation.Sum, "Revenue"),
                Inline("public.orders", "order_total", Aggregation.Sum, "Revenue") with
                {
                    Calc = new MeasureCalcSpec(MeasureCalcKind.RunningTotal),
                },
            ],
            dimensions: [new DimensionSpec("public.orders", "order_date", DateBucket.Month)]);

        var healthy = Compile(spec);
        var isolated = Compile(spec, null, 1);

        Assert.Equal("Revenue (running total)", healthy.Columns[2].Label);
        Assert.Equal(healthy.Columns[2].Label, isolated.Columns[2].Label);
    }

    // ------------------------------------------------------------- no tombstones

    [Fact]
    public void WithNoTombstonesTheOutputIsByteIdenticalToTheOldCompiler()
    {
        var spec = ThreeMeasureSpec() with
        {
            Sort = [new SortSpec(new SortTarget(SortTargetKind.Measure, 0), SortDirection.Desc)],
        };

        var limits = new RcdLimits();
        var model = TestFixtures.BuildValidDemoModel();

        var withNull = Compiler.Prepare(spec, model, Schema, limits, null);
        var withEmpty = Compiler.Prepare(spec, model, Schema, limits, new HashSet<int>());

        Assert.Equal(
            Compiler.Emit(withNull, spec, NoRowFilters, limits, new DataSourceOptions()).Sql,
            Compiler.Emit(withEmpty, spec, NoRowFilters, limits, new DataSourceOptions()).Sql);
        Assert.All(withNull.Measures, m => Assert.False(m.Tombstone));
    }

    [Fact]
    public void EveryMeasureTombstonedWithNoDimensionsIsRefusedOutright()
    {
        var spec = Spec([Inline("public.orders", "order_total", Aggregation.Sum)], dimensions: []);

        var ex = Assert.Throws<QueryCompilationException>(
            () => Compiler.Prepare(
                spec, TestFixtures.BuildValidDemoModel(), Schema, new RcdLimits(), new HashSet<int> { 0 }));

        Assert.Equal("QRY_NO_MEASURES", ex.Code);
    }
}
