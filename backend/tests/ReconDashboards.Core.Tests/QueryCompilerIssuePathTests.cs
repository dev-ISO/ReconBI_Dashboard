using System.Text.Json;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Postgres;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Field-level attribution of compilation failures. The deep resolution
/// helpers know WHAT is wrong; only the wire loops know WHICH dimension /
/// measure / filter asked for it, so the path is stamped there. The builder
/// maps these paths back to the well that owns them (pathToWell), which is why
/// the grammar — "measures[1]", "filters[0]", "sort[0]", "limit" — is a
/// contract and not a debugging aid.
/// </summary>
public class QueryCompilerIssuePathTests
{
    private static readonly QueryCompiler Compiler = new(new PostgresSqlDialect());

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static MeasureSpec SumOrderTotal() => new(null, "public.orders", "order_total", Aggregation.Sum, null);

    private static ChartQuerySpec Spec(
        IReadOnlyList<DimensionSpec>? dimensions = null,
        IReadOnlyList<MeasureSpec>? measures = null,
        IReadOnlyList<FilterSpec>? filters = null,
        IReadOnlyList<SortSpec>? sort = null,
        TopNSpec? topN = null) =>
        new(1, dimensions ?? [], measures ?? [SumOrderTotal()], filters ?? [], sort ?? [], topN, null);

    private static QueryCompilationException Failure(ChartQuerySpec spec)
    {
        var limits = new RcdLimits();
        var model = TestFixtures.BuildValidDemoModel();
        var schema = TestFixtures.BuildDemoSchema();
        return Assert.Throws<QueryCompilationException>(() =>
        {
            var prepared = Compiler.Prepare(spec, model, schema, limits);
            Compiler.Emit(prepared, spec, new Dictionary<string, IReadOnlyList<RowFilter>>(), limits, new DataSourceOptions());
        });
    }

    [Fact]
    public void An_unresolvable_dimension_names_its_wire_index()
    {
        var failure = Failure(Spec(dimensions: [new DimensionSpec("public.customers", "no_such_column", null)]));

        Assert.Equal("dimensions[0]", failure.Path);
    }

    [Fact]
    public void An_unresolvable_measure_names_its_wire_index()
    {
        var failure = Failure(Spec(measures:
        [
            SumOrderTotal(),
            new MeasureSpec(null, "public.orders", "no_such_column", Aggregation.Sum, null),
        ]));

        Assert.Equal("measures[1]", failure.Path);
    }

    [Fact]
    public void An_aggregation_the_column_type_cannot_support_names_its_measure()
    {
        var failure = Failure(Spec(measures:
        [
            new MeasureSpec(null, "public.customers", "name", Aggregation.Sum, null),
        ]));

        Assert.Equal("measures[0]", failure.Path);
    }

    [Fact]
    public void A_bad_filter_names_its_wire_index()
    {
        var failure = Failure(Spec(filters:
        [
            new FilterSpec("public.customers", "region", FilterOperator.Eq, [Json("north")]),
            new FilterSpec("public.customers", "no_such_column", FilterOperator.Eq, [Json("x")]),
        ]));

        Assert.Equal("filters[1]", failure.Path);
    }

    [Fact]
    public void A_sort_pointing_at_a_measure_that_does_not_exist_names_the_sort()
    {
        var failure = Failure(Spec(sort: [new SortSpec(new SortTarget(SortTargetKind.Measure, 9), SortDirection.Desc)]));

        Assert.Equal("QRY_BAD_SORT", failure.Code);
        Assert.Equal("sort[0]", failure.Path);
    }

    [Fact]
    public void A_top_n_that_cannot_apply_names_the_limit()
    {
        var failure = Failure(Spec(
            dimensions: [new DimensionSpec("public.customers", "region", null), new DimensionSpec("public.customers", "name", null)],
            topN: new TopNSpec(5, 0, IncludeOthers: false)));

        Assert.Equal("QRY_BAD_TOPN", failure.Code);
        Assert.Equal("limit", failure.Path);
    }

    /// <summary>
    /// A fault that belongs to the request as a whole carries NO path — the
    /// builder shows it in the summary rather than badging an innocent well.
    /// </summary>
    [Fact]
    public void A_whole_query_fault_carries_no_path()
    {
        var failure = Failure(Spec(measures: []));

        Assert.Equal("QRY_NO_MEASURES", failure.Code);
        Assert.Null(failure.Path);
    }
}
