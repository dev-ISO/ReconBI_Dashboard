using System.Text.Json;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The subscription snapshot parser must rebuild each chart tile's wire spec
/// the way the GUI's toWireSpec does — dimensions ordered
/// [axis, legend?, smallMultiples?], chart filters + applicable Filters-pane
/// cards, no transient state — while ignoring the layout doc's many
/// GUI-only fields.
/// </summary>
public class LayoutSnapshotParserTests
{
    private const int ModelId = 7;

    [Fact]
    public void ChartTileMapsAxisLegendSmallMultiplesInOrder()
    {
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{
            "id": "p1", "name": "Overview",
            "tiles": [{
              "id": "t1", "kind": "chart",
              "layout": { "x": 0, "y": 0, "w": 4, "h": 3 },
              "chart": {
                "id": "c1", "type": "line", "title": "Sales by month",
                "query": {
                  "axis": { "table": "public.orders", "column": "order_date", "dateBucket": "month" },
                  "legend": { "table": "public.customers", "column": "region" },
                  "smallMultiples": { "table": "public.orders", "column": "status" },
                  "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
                  "filters": [{ "table": "public.orders", "column": "status", "operator": "eq", "values": ["open"] }],
                  "sort": [{ "target": { "kind": "measure", "index": 0 }, "direction": "desc" }],
                  "limit": 500
                },
                "format": { "showLegend": true, "theme": "ocean", "colorOverrides": { "West": "#123456" } }
              }
            }]
          }]
        }
        """;

        var pages = LayoutSnapshotParser.Parse(layout, ModelId);

        var page = Assert.Single(pages);
        Assert.Equal("Overview", page.Name);
        var tile = Assert.Single(page.Tiles);
        Assert.Equal("t1", tile.TileId);
        Assert.Equal("Sales by month", tile.Title);
        Assert.Equal("line", tile.ChartType);

        var spec = tile.Spec;
        Assert.Equal(ModelId, spec.ModelId);
        Assert.Equal(3, spec.Dimensions.Count);
        Assert.Equal(("public.orders", "order_date", DateBucket.Month),
            (spec.Dimensions[0].Table, spec.Dimensions[0].Column, spec.Dimensions[0].DateBucket!.Value));
        Assert.Equal("region", spec.Dimensions[1].Column);
        Assert.Equal("status", spec.Dimensions[2].Column);

        var measure = Assert.Single(spec.Measures);
        Assert.Equal(Aggregation.Sum, measure.Aggregation);
        Assert.Equal("order_total", measure.Column);

        var filter = Assert.Single(spec.Filters);
        Assert.Equal(FilterOperator.Eq, filter.Operator);
        Assert.Equal("open", filter.Values[0].GetString());

        var sort = Assert.Single(spec.Sort);
        Assert.Equal(SortTargetKind.Measure, sort.Target.Kind);
        Assert.Equal(SortDirection.Desc, sort.Direction);
        Assert.Equal(500, spec.Limit);
        Assert.Null(spec.TopN);
    }

    [Fact]
    public void NonChartAndMeasurelessTilesAreSkipped()
    {
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{
            "id": "p1", "name": "Page 1",
            "tiles": [
              { "id": "s1", "kind": "slicer", "layout": {}, "slicer": { "table": "t", "column": "c", "label": "L", "variant": "checklist" } },
              { "id": "x1", "kind": "text", "layout": {}, "text": { "html": "<b>hi</b>" } },
              { "id": "t1", "kind": "chart", "layout": {}, "chart": { "id": "c", "type": "kpi", "title": "Empty", "query": { "measures": [], "filters": [] } } },
              { "id": "t2", "chart": { "id": "c2", "type": "kpi", "title": "Count", "query": { "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } }
            ]
          }]
        }
        """;

        var pages = LayoutSnapshotParser.Parse(layout, ModelId);
        var tile = Assert.Single(Assert.Single(pages).Tiles);
        Assert.Equal("t2", tile.TileId); // legacy kind-less chart tile still counts
        Assert.Empty(tile.Spec.Dimensions);
    }

    /// <summary>
    /// The one exception to the measure-less skip, in lockstep with the GUI's
    /// isRunnable (0.14.1): a TABLE with Rows and no Values is a passthrough
    /// column list the engine compiles fine, so it must reach the email —
    /// silently dropping it would lose a tile from every scheduled send with
    /// no error anywhere. A measure-less table with no Rows is still skipped
    /// (empty SELECT list), as is a measure-less chart of any other type.
    /// </summary>
    [Fact]
    public void MeasurelessTableWithRowsIsKept()
    {
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{
            "id": "p1", "name": "Page 1",
            "tiles": [
              { "id": "t1", "kind": "chart", "layout": {}, "chart": { "id": "c1", "type": "table", "title": "Register",
                "query": { "axis": { "table": "public.customers", "column": "region" }, "measures": [], "filters": [] } } },
              { "id": "t2", "kind": "chart", "layout": {}, "chart": { "id": "c2", "type": "table", "title": "Nothing",
                "query": { "measures": [], "filters": [] } } },
              { "id": "t3", "kind": "chart", "layout": {}, "chart": { "id": "c3", "type": "column", "title": "Also nothing",
                "query": { "axis": { "table": "public.customers", "column": "region" }, "measures": [], "filters": [] } } }
            ]
          }]
        }
        """;

        var tile = Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, ModelId)).Tiles);
        Assert.Equal("t1", tile.TileId);
        Assert.Equal("table", tile.ChartType);
        Assert.Empty(tile.Spec.Measures);
        var dimension = Assert.Single(tile.Spec.Dimensions);
        Assert.Equal("region", dimension.Column);
    }

    [Fact]
    public void LegacySinglePageDocsUseRootTiles()
    {
        const string layout = """
        {
          "version": 1, "slicers": [],
          "tiles": [{ "id": "t1", "chart": { "id": "c", "type": "column", "title": "T", "query": { "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } }]
        }
        """;

        var pages = LayoutSnapshotParser.Parse(layout, ModelId);
        var page = Assert.Single(pages);
        Assert.Single(page.Tiles);
    }

    [Fact]
    public void FilterCardsApplyByScope()
    {
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [
            { "id": "p1", "name": "One", "tiles": [
              { "id": "t1", "chart": { "id": "c1", "type": "kpi", "title": "A", "query": { "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } },
              { "id": "t2", "chart": { "id": "c2", "type": "kpi", "title": "B", "query": { "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } }
            ]},
            { "id": "p2", "name": "Two", "tiles": [
              { "id": "t3", "chart": { "id": "c3", "type": "kpi", "title": "C", "query": { "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } }
            ]}
          ],
          "filterCards": [
            { "id": "f1", "scope": "allPages", "table": "public.customers", "column": "region", "mode": "basic", "basicValues": ["West", "East"] },
            { "id": "f2", "scope": "page", "pageId": "p1", "table": "public.orders", "column": "status", "mode": "basic", "basicValues": ["open"] },
            { "id": "f3", "scope": "visual", "targetTileId": "t2", "table": "public.orders", "column": "order_total", "mode": "advanced", "conditions": [{ "operator": "gt", "value": 100 }] },
            { "id": "f4", "scope": "allPages", "table": "public.orders", "column": "status", "mode": "basic", "basicValues": ["closed"], "disabled": true }
          ]
        }
        """;

        var pages = LayoutSnapshotParser.Parse(layout, ModelId);
        var t1 = pages[0].Tiles[0].Spec;
        var t2 = pages[0].Tiles[1].Spec;
        var t3 = pages[1].Tiles[0].Spec;

        // t1: allPages IN + page-scoped; disabled card never applies.
        Assert.Equal(2, t1.Filters.Count);
        Assert.Equal(FilterOperator.In, t1.Filters[0].Operator);
        Assert.Equal(2, t1.Filters[0].Values.Count);
        Assert.Equal("open", t1.Filters[1].Values[0].GetString());

        // t2 additionally gets the visual-scoped advanced gt condition.
        Assert.Equal(3, t2.Filters.Count);
        Assert.Equal(FilterOperator.Gt, t2.Filters[2].Operator);
        Assert.Equal(100, t2.Filters[2].Values[0].GetInt32());

        // t3 (other page): only the allPages card.
        var only = Assert.Single(t3.Filters);
        Assert.Equal("region", only.Column);
    }

    [Fact]
    public void AdvancedOrCollapsesToInOnlyWhenAllEq()
    {
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{ "id": "p1", "name": "One", "tiles": [
            { "id": "t1", "chart": { "id": "c1", "type": "kpi", "title": "A", "query": { "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } }
          ]}],
          "filterCards": [
            { "id": "f1", "scope": "allPages", "table": "public.orders", "column": "status", "mode": "advanced", "conditionJoin": "or",
              "conditions": [{ "operator": "eq", "value": "open" }, { "operator": "eq", "value": "closed" }] },
            { "id": "f2", "scope": "allPages", "table": "public.orders", "column": "order_total", "mode": "advanced", "conditionJoin": "or",
              "conditions": [{ "operator": "gt", "value": 10 }, { "operator": "lt", "value": 5 }] },
            { "id": "f3", "scope": "allPages", "table": "public.orders", "column": "status", "mode": "advanced",
              "conditions": [{ "operator": "notNull" }, { "operator": "neq", "value": "cancelled" }] }
          ]
        }
        """;

        var spec = Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, ModelId), p => p.Tiles.Count == 1).Tiles).Spec;

        // f1 -> one IN; f2 (unsupported OR) -> nothing; f3 (AND) -> two clauses.
        Assert.Equal(3, spec.Filters.Count);
        Assert.Equal(FilterOperator.In, spec.Filters[0].Operator);
        Assert.Equal(FilterOperator.NotNull, spec.Filters[1].Operator);
        Assert.Empty(spec.Filters[1].Values);
        Assert.Equal(FilterOperator.Neq, spec.Filters[2].Operator);
    }

    [Fact]
    public void MalformedJsonYieldsNoPages()
    {
        Assert.Empty(LayoutSnapshotParser.Parse("not json at all {", ModelId));
        Assert.Empty(LayoutSnapshotParser.Parse("null", ModelId));
    }

    [Fact]
    public void ParsedSpecRoundTripsThroughWireJson()
    {
        // The produced spec serializes like any wire spec (camelCase enums).
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{ "id": "p1", "name": "One", "tiles": [
            { "id": "t1", "chart": { "id": "c1", "type": "column", "title": "A", "query": {
              "axis": { "table": "public.customers", "column": "region" },
              "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum", "calc": { "kind": "runningTotal" } }],
              "filters": [] } } }
          ]}]
        }
        """;

        var tile = Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, ModelId)).Tiles);
        Assert.Equal(MeasureCalcKind.RunningTotal, tile.Spec.Measures[0].Calc!.Kind);
        var json = JsonSerializer.Serialize(tile.Spec, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Contains("\"runningTotal\"", json, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------ chart.format
    // The server-side chart renderer draws from chart.format, so the parser has
    // to carry it through. It is read FIELD BY FIELD on purpose: the GUI
    // persists many more keys with evolving shapes, and one stray type must
    // degrade to "unset" rather than fail the tile — or the whole document.

    private static string LayoutWithFormat(string formatJson) => $$"""
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{ "id": "p1", "name": "One", "tiles": [
            { "id": "t1", "kind": "chart", "chart": { "id": "c1", "type": "column", "title": "A",
              "query": { "axis": { "table": "public.customers", "column": "region" },
                         "measures": [{ "table": "public.orders", "column": "order_total", "aggregation": "sum" }],
                         "filters": [] },
              "format": {{formatJson}} } }
          ]}]
        }
        """;

    private static ChartFormatDoc? ParseFormat(string formatJson) =>
        Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(LayoutWithFormat(formatJson), ModelId)).Tiles).Format;

    [Fact]
    public void EveryConsumedFormatFieldSurvivesParsing()
    {
        var format = ParseFormat("""
            {
              "theme": "ocean",
              "colorOverrides": { "West": "#123456", "East": "#654321" },
              "showLegend": false,
              "legendPosition": "right",
              "showDataLabels": true,
              "dataLabelContent": "both",
              "valueFormat": "$#,##0",
              "xAxisLabel": "Territory",
              "yAxisLabel": "Revenue",
              "seriesLabels": { "Total": "Revenue" },
              "categoryOrder": ["East", "West"],
              "seriesOrder": ["Target", "Total"],
              "gridX": true,
              "gridY": false,
              "dateFormat": "monthShort",
              "dateFormatPattern": "yyyy-MM"
            }
            """);

        Assert.NotNull(format);
        Assert.Equal("ocean", format.Theme);
        Assert.Equal("#123456", format.ColorOverrides!["West"]);
        Assert.Equal("#654321", format.ColorOverrides["East"]);
        Assert.False(format.ShowLegend);
        Assert.Equal("right", format.LegendPosition);
        Assert.True(format.ShowDataLabels);
        Assert.Equal("both", format.DataLabelContent);
        Assert.Equal("$#,##0", format.ValueFormat);
        Assert.Equal("Territory", format.XAxisLabel);
        Assert.Equal("Revenue", format.YAxisLabel);
        Assert.Equal("Revenue", format.SeriesLabels!["Total"]);
        Assert.Equal(["East", "West"], format.CategoryOrder);
        Assert.Equal(["Target", "Total"], format.SeriesOrder);
        Assert.True(format.GridX);
        Assert.False(format.GridY);
        Assert.Equal("monthShort", format.DateFormat);
        Assert.Equal("yyyy-MM", format.DateFormatPattern);
    }

    [Fact]
    public void AMissingOrNonObjectFormatIsSimplyUnset()
    {
        Assert.Null(ParseFormat("null"));
        Assert.Null(ParseFormat("\"nonsense\""));
        Assert.Null(ParseFormat("[]"));

        // An empty object parses to an all-unset doc — every renderer default applies.
        var empty = ParseFormat("{}");
        Assert.NotNull(empty);
        Assert.Null(empty.Theme);
        Assert.Null(empty.ShowLegend);
        Assert.Null(empty.CategoryOrder);

        // ...and a tile with no "format" key at all is Format = null.
        const string noFormat = """
            {
              "version": 1, "tiles": [], "slicers": [],
              "pages": [{ "id": "p1", "name": "One", "tiles": [
                { "id": "t1", "chart": { "id": "c1", "type": "column", "title": "A", "query": {
                  "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } }
              ]}]
            }
            """;
        Assert.Null(Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(noFormat, ModelId)).Tiles).Format);
    }

    [Fact]
    public void WrongTypedFormatFieldsDegradeToUnsetInsteadOfFailingTheTile()
    {
        var format = ParseFormat("""
            {
              "theme": 42,
              "showLegend": "yes",
              "gridY": 0,
              "colorOverrides": "not-a-map",
              "categoryOrder": "not-a-list",
              "valueFormat": "$#,##0"
            }
            """);

        Assert.NotNull(format);
        Assert.Null(format.Theme);
        Assert.Null(format.ShowLegend);
        Assert.Null(format.GridY);
        Assert.Null(format.ColorOverrides);
        Assert.Null(format.CategoryOrder);
        // The well-typed neighbours still come through — one bad key is not fatal.
        Assert.Equal("$#,##0", format.ValueFormat);
    }

    [Fact]
    public void NonStringEntriesInsideMapsAndListsAreSkipped()
    {
        var format = ParseFormat("""
            {
              "colorOverrides": { "West": "#123456", "East": 7, "North": null },
              "categoryOrder": ["East", 5, null, "West"]
            }
            """);

        Assert.NotNull(format);
        Assert.Equal(["West"], format.ColorOverrides!.Keys);
        Assert.Equal(["East", "West"], format.CategoryOrder);
    }

    [Fact]
    public void FormatKeysStillExcludedAreCarriedNowhereAndBreakNothing()
    {
        // conditionalFormats, the secondary axis and the interaction blocks are
        // NOT drawn server side; their presence must be inert, not an error.
        var format = ParseFormat("""
            {
              "theme": "forest",
              "conditionalFormats": [{ "when": "gt", "value": 5, "color": "#f00" }],
              "secondaryAxisKeys": ["Target"],
              "y2AxisFormat": { "kind": "compact" },
              "yAxisScale": { "range": "auto", "log": true },
              "zoom": { "brush": true },
              "tooltip": { "accentBorder": true }
            }
            """);

        Assert.NotNull(format);
        Assert.Equal("forest", format.Theme);
    }

    // ------------------------------------------------- the 0.14.1 format fields

    [Fact]
    public void TheChartFidelityFormatFieldsSurviveParsing()
    {
        // Every field below is set by the seeded showcase dashboard whose email
        // the owner reviewed; each one was silently discarded before.
        var format = ParseFormat("""
            {
              "colorByCategory": true,
              "xLabelFit": { "mode": "angled", "wrapLines": 3 },
              "xAxisFormat": { "kind": "compact" },
              "yAxisFormat": { "kind": "custom", "pattern": "#,##0.0", "decimals": 1 },
              "xAxisLabelHtml": "<b>Initial package delivered</b>",
              "yAxisLabelHtml": "<b>Systems</b>",
              "trimEmptyEdges": true,
              "excludeBlankDates": false,
              "lineStyles": { "Systems": { "dash": "solid", "width": 2 } },
              "referenceLines": [{
                "id": "r1", "kind": "average", "measureKey": "Systems", "label": "Monthly average",
                "color": "#eb6834", "dash": "dashed", "width": 2, "showLabel": true
              }],
              "trendlines": [{
                "id": "t1", "kind": "movingAverage", "window": 3, "seriesKey": "Systems",
                "color": "#8b5cf6", "dash": "dotted", "width": 2
              }],
              "titleStyle": { "fontSize": 14, "bold": true, "color": "#111827" },
              "axisTitleStyle": { "italic": true },
              "legendStyle": { "bold": true },
              "kpiValueStyle": { "fontSize": 32 },
              "container": {
                "hideHeader": true, "background": "#ffffff", "borderColor": "#2a78d6",
                "borderWidth": 1, "borderRadius": 12, "shadow": "sm",
                "innerTitleHtml": "<p><b>Systems Tracked</b></p>"
              },
              "gantt": {
                "barSize": 14, "cornerRadius": 4, "showToday": true, "todayColor": "#dc2626",
                "rowBanding": true, "singleColor": true, "color": "#2a78d6", "taskLabels": "axis"
              }
            }
            """);

        Assert.NotNull(format);
        Assert.True(format.ColorByCategory);
        Assert.Equal("angled", format.XLabelFit!.Mode);
        Assert.Equal(3, format.XLabelFit.WrapLines);
        Assert.Equal("compact", format.XAxisFormat!.Kind);
        Assert.Equal("#,##0.0", format.YAxisFormat!.Pattern);
        Assert.Equal(1, format.YAxisFormat.Decimals);
        Assert.Equal("<b>Initial package delivered</b>", format.XAxisLabelHtml);
        Assert.Equal("<b>Systems</b>", format.YAxisLabelHtml);
        Assert.True(format.TrimEmptyEdges);
        Assert.False(format.ExcludeBlankDates);
        Assert.Equal(2, format.LineStyles!["Systems"].Width);

        var reference = Assert.Single(format.ReferenceLines!);
        Assert.Equal("average", reference.Kind);
        Assert.Equal("Systems", reference.MeasureKey);
        Assert.Equal("Monthly average", reference.Label);
        Assert.Equal("#eb6834", reference.Color);
        Assert.Equal("dashed", reference.Dash);
        Assert.True(reference.ShowLabel);

        var trendline = Assert.Single(format.Trendlines!);
        Assert.Equal("movingAverage", trendline.Kind);
        Assert.Equal(3, trendline.Window);
        Assert.Equal("#8b5cf6", trendline.Color);

        Assert.Equal(14, format.TitleStyle!.FontSize);
        Assert.True(format.TitleStyle.Bold);
        Assert.True(format.AxisTitleStyle!.Italic);
        Assert.True(format.LegendStyle!.Bold);
        Assert.Equal(32, format.KpiValueStyle!.FontSize);

        Assert.True(format.Container!.HideHeader);
        Assert.Equal("#2a78d6", format.Container.BorderColor);
        Assert.Equal(12, format.Container.BorderRadius);
        Assert.Equal("sm", format.Container.Shadow);
        Assert.Equal("<p><b>Systems Tracked</b></p>", format.Container.InnerTitleHtml);

        Assert.Equal(14, format.Gantt!.BarSize);
        Assert.Equal(4, format.Gantt.CornerRadius);
        Assert.True(format.Gantt.ShowToday);
        Assert.True(format.Gantt.SingleColor);
        Assert.Equal("#2a78d6", format.Gantt.Color);
    }

    [Fact]
    public void WrongTypedNestedFormatFieldsDegradeToUnsetToo()
    {
        var format = ParseFormat("""
            {
              "colorByCategory": "yes",
              "xLabelFit": "angled",
              "yAxisFormat": [],
              "referenceLines": { "kind": "average" },
              "trendlines": ["linear"],
              "lineStyles": { "Systems": "dashed" },
              "container": 7,
              "theme": "ocean"
            }
            """);

        Assert.NotNull(format);
        Assert.Null(format.ColorByCategory);
        Assert.Null(format.XLabelFit);
        Assert.Null(format.YAxisFormat);
        Assert.Null(format.ReferenceLines);
        Assert.Empty(format.Trendlines!);   // an array of non-objects yields no entries
        Assert.Empty(format.LineStyles!);
        Assert.Null(format.Container);
        Assert.Equal("ocean", format.Theme); // one bad key is never fatal
    }

    // ------------------------------------------------- wells and tile geometry

    [Fact]
    public void TheDimensionWELLSAreRecordedNotJustTheirCompactedOrder()
    {
        // A legend-only chart's single dimension sits at ordinal 0; without the
        // wells the renderer cannot tell it from an axis.
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{ "id": "p1", "name": "One", "tiles": [{
            "id": "t1", "kind": "chart",
            "layout": { "x": 0, "y": 8, "w": 14, "h": 9 },
            "chart": { "id": "c1", "type": "donut", "title": "Mix", "query": {
              "legend": { "table": "public.customers", "column": "region" },
              "measures": [{ "table": "public.orders", "aggregation": "count" }],
              "filters": [] } }
          }]}]
        }
        """;

        var tile = Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, ModelId)).Tiles);

        Assert.NotNull(tile.Wells);
        Assert.False(tile.Wells.HasAxis);
        Assert.True(tile.Wells.HasLegend);
        Assert.False(tile.Wells.HasSmallMultiples);
        Assert.Equal((-1, 0, -1), tile.Wells.Ordinals());
        Assert.Equal(new TileGridSize(14, 9), tile.GridSize);
    }

    [Fact]
    public void AllThreeWellsMapToTheirCompactedOrdinalsInOrder()
    {
        Assert.Equal((0, 1, 2), new DimensionWells(true, true, true).Ordinals());
        Assert.Equal((0, -1, 1), new DimensionWells(true, false, true).Ordinals());
        Assert.Equal((-1, -1, -1), new DimensionWells(false, false, false).Ordinals());
    }

    [Fact]
    public void ATileWithNoLayoutBlockSimplyHasNoGridSize()
    {
        const string layout = """
        {
          "version": 1, "tiles": [], "slicers": [],
          "pages": [{ "id": "p1", "name": "One", "tiles": [
            { "id": "t1", "chart": { "id": "c1", "type": "column", "title": "A", "query": {
              "measures": [{ "table": "public.orders", "aggregation": "count" }], "filters": [] } } }
          ]}]
        }
        """;

        Assert.Null(Assert.Single(Assert.Single(LayoutSnapshotParser.Parse(layout, ModelId)).Tiles).GridSize);
    }
}
