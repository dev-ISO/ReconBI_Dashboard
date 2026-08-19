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
    public void FormatKeysExcludedInV1AreCarriedNowhereAndBreakNothing()
    {
        // referenceLines / trendlines / conditionalFormats are NOT drawn server
        // side yet; their presence must be inert, not an error.
        var format = ParseFormat("""
            {
              "theme": "forest",
              "referenceLines": [{ "value": 100, "label": "Target" }],
              "trendlines": [{ "series": "Total", "kind": "linear" }],
              "conditionalFormats": [{ "when": "gt", "value": 5, "color": "#f00" }]
            }
            """);

        Assert.NotNull(format);
        Assert.Equal("forest", format.Theme);
    }
}
