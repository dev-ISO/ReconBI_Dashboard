using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

public class DashboardLayoutDifferTests
{
    private const string BaseDoc = """
        {
          "pages": [
            {
              "id": "p1", "name": "Overview", "color": "#ff0000",
              "tiles": [
                { "id": "t1", "kind": "chart", "layout": { "x": 0, "y": 0, "w": 4, "h": 3 },
                  "chart": { "id": "c1", "type": "column", "title": "Orders by Region",
                             "query": { "measures": [{ "name": "Total" }] }, "format": { "palette": "a" } } },
                { "id": "t2", "kind": "slicer", "layout": { "x": 4, "y": 0, "w": 2, "h": 1 },
                  "slicer": { "table": "public.orders", "column": "status" } }
              ]
            },
            { "id": "p2", "name": "Detail", "tiles": [] }
          ],
          "refreshSeconds": 60,
          "filterCards": [{ "id": "f1", "scope": "allPages" }]
        }
        """;

    private static LayoutChangeSummary Diff(string oldDoc, string newDoc) =>
        DashboardLayoutDiffer.Diff(oldDoc, newDoc);

    private static void AssertFlags(
        LayoutChangeSummary summary, bool layout = false, bool pages = false, bool charts = false)
    {
        Assert.Equal(layout, summary.LayoutChanged);
        Assert.Equal(pages, summary.PagesChanged);
        Assert.Equal(charts, summary.ChartsChanged);
    }

    [Fact]
    public void IdenticalDocs_ReportNoChange()
    {
        var summary = Diff(BaseDoc, BaseDoc);

        AssertFlags(summary);
        Assert.False(summary.HasAnyChange);
        Assert.False(summary.SettingsChanged);
    }

    [Fact]
    public void SemanticallyEqualDocs_WithDifferentFormatting_ReportNoChange()
    {
        var reordered = BaseDoc.Replace("\"id\": \"p2\", \"name\": \"Detail\"", "\"name\": \"Detail\", \"id\": \"p2\"");
        Assert.False(Diff(BaseDoc, reordered).HasAnyChange);
    }

    [Fact]
    public void EmptyPageAdded_IsPagesOnly()
    {
        var newDoc = BaseDoc.Replace(
            """{ "id": "p2", "name": "Detail", "tiles": [] }""",
            """{ "id": "p2", "name": "Detail", "tiles": [] }, { "id": "p3", "name": "Costs", "tiles": [] }""");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, pages: true);
        Assert.Equal(["Costs"], summary.PagesAdded);
        Assert.Equal(0, summary.TilesAdded);
    }

    [Fact]
    public void PageAddedWithTiles_AlsoRaisesChartsAndCountsTiles()
    {
        var newDoc = BaseDoc.Replace(
            """{ "id": "p2", "name": "Detail", "tiles": [] }""",
            """{ "id": "p2", "name": "Detail", "tiles": [] }, { "id": "p3", "name": "Costs", "tiles": [{ "id": "t9", "kind": "chart" }] }""");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, pages: true, charts: true);
        Assert.Equal(1, summary.TilesAdded);
    }

    [Fact]
    public void PageRemoved_IsPagesOnly_AndNamesIt()
    {
        var newDoc = """
            {
              "pages": [
                {
                  "id": "p1", "name": "Overview", "color": "#ff0000",
                  "tiles": [
                    { "id": "t1", "kind": "chart", "layout": { "x": 0, "y": 0, "w": 4, "h": 3 },
                      "chart": { "id": "c1", "type": "column", "title": "Orders by Region",
                                 "query": { "measures": [{ "name": "Total" }] }, "format": { "palette": "a" } } },
                    { "id": "t2", "kind": "slicer", "layout": { "x": 4, "y": 0, "w": 2, "h": 1 },
                      "slicer": { "table": "public.orders", "column": "status" } }
                  ]
                }
              ],
              "refreshSeconds": 60,
              "filterCards": [{ "id": "f1", "scope": "allPages" }]
            }
            """;

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, pages: true);
        Assert.Equal(["Detail"], summary.PagesRemoved);
    }

    [Fact]
    public void PageRenamed_IsPagesOnly_WithFromTo()
    {
        var newDoc = BaseDoc.Replace("\"name\": \"Detail\"", "\"name\": \"Deep Dive\"");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, pages: true);
        var rename = Assert.Single(summary.PagesRenamed);
        Assert.Equal("Detail", rename.From);
        Assert.Equal("Deep Dive", rename.To);
    }

    [Fact]
    public void PageReordered_IsPagesOnly()
    {
        // Swap p1/p2 by rebuilding the pages array in reverse order.
        var newDoc = """
            {
              "pages": [
                { "id": "p2", "name": "Detail", "tiles": [] },
                {
                  "id": "p1", "name": "Overview", "color": "#ff0000",
                  "tiles": [
                    { "id": "t1", "kind": "chart", "layout": { "x": 0, "y": 0, "w": 4, "h": 3 },
                      "chart": { "id": "c1", "type": "column", "title": "Orders by Region",
                                 "query": { "measures": [{ "name": "Total" }] }, "format": { "palette": "a" } } },
                    { "id": "t2", "kind": "slicer", "layout": { "x": 4, "y": 0, "w": 2, "h": 1 },
                      "slicer": { "table": "public.orders", "column": "status" } }
                  ]
                }
              ],
              "refreshSeconds": 60,
              "filterCards": [{ "id": "f1", "scope": "allPages" }]
            }
            """;

        AssertFlags(Diff(BaseDoc, newDoc), pages: true);
    }

    [Fact]
    public void PageColorChanged_IsPagesOnly()
    {
        var newDoc = BaseDoc.Replace("#ff0000", "#00ff00");
        AssertFlags(Diff(BaseDoc, newDoc), pages: true);
    }

    [Fact]
    public void TileMoved_IsLayoutOnly()
    {
        var newDoc = BaseDoc.Replace("""{ "x": 0, "y": 0, "w": 4, "h": 3 }""", """{ "x": 2, "y": 1, "w": 4, "h": 3 }""");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, layout: true);
        Assert.Empty(summary.ChartsModified);
    }

    [Fact]
    public void ChartEdited_IsChartsOnly_AndNamesTheChart()
    {
        var newDoc = BaseDoc.Replace("\"type\": \"column\"", "\"type\": \"line\"");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, charts: true);
        Assert.Equal(["Orders by Region"], summary.ChartsModified);
    }

    [Fact]
    public void TileAdded_IsChartsOnly()
    {
        var newDoc = BaseDoc.Replace(
            """{ "id": "p2", "name": "Detail", "tiles": [] }""",
            """{ "id": "p2", "name": "Detail", "tiles": [{ "id": "t3", "kind": "chart" }] }""");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, charts: true);
        Assert.Equal(1, summary.TilesAdded);
        Assert.Equal(0, summary.TilesRemoved);
    }

    [Fact]
    public void TileRemoved_IsChartsOnly()
    {
        var newDoc = """
            {
              "pages": [
                {
                  "id": "p1", "name": "Overview", "color": "#ff0000",
                  "tiles": [
                    { "id": "t1", "kind": "chart", "layout": { "x": 0, "y": 0, "w": 4, "h": 3 },
                      "chart": { "id": "c1", "type": "column", "title": "Orders by Region",
                                 "query": { "measures": [{ "name": "Total" }] }, "format": { "palette": "a" } } }
                  ]
                },
                { "id": "p2", "name": "Detail", "tiles": [] }
              ],
              "refreshSeconds": 60,
              "filterCards": [{ "id": "f1", "scope": "allPages" }]
            }
            """;

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, charts: true);
        Assert.Equal(1, summary.TilesRemoved);
    }

    [Fact]
    public void SlicerTileEdited_IsLayoutOnly()
    {
        var newDoc = BaseDoc.Replace("\"column\": \"status\"", "\"column\": \"order_date\"");
        AssertFlags(Diff(BaseDoc, newDoc), layout: true);
    }

    [Fact]
    public void TileKindChanged_IsChartsClass()
    {
        var newDoc = BaseDoc.Replace("\"id\": \"t2\", \"kind\": \"slicer\"", "\"id\": \"t2\", \"kind\": \"text\"");

        var summary = Diff(BaseDoc, newDoc);

        Assert.True(summary.ChartsChanged);
        Assert.False(summary.PagesChanged);
    }

    [Fact]
    public void DocSettingsOnlyChange_IsLayoutWithSettingsFlag()
    {
        var newDoc = BaseDoc.Replace("\"refreshSeconds\": 60", "\"refreshSeconds\": 30");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, layout: true);
        Assert.True(summary.SettingsChanged);
    }

    [Fact]
    public void FilterCardsChange_IsLayoutWithSettingsFlag()
    {
        var newDoc = BaseDoc.Replace("\"scope\": \"allPages\"", "\"scope\": \"page\"");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, layout: true);
        Assert.True(summary.SettingsChanged);
    }

    // ------------------------------ legacy docs ------------------------------

    private const string LegacyDoc = """
        {
          "tiles": [
            { "id": "t1", "kind": "chart", "layout": { "x": 0, "y": 0, "w": 4, "h": 3 },
              "chart": { "title": "KPIs", "type": "kpi" } }
          ],
          "slicers": [{ "table": "public.orders", "column": "status" }]
        }
        """;

    [Fact]
    public void LegacyDocs_Identical_ReportNoChange()
    {
        Assert.False(Diff(LegacyDoc, LegacyDoc).HasAnyChange);
    }

    [Fact]
    public void LegacyTileMoved_IsLayoutOnly()
    {
        var newDoc = LegacyDoc.Replace("\"x\": 0", "\"x\": 6");
        AssertFlags(Diff(LegacyDoc, newDoc), layout: true);
    }

    [Fact]
    public void LegacyTileAdded_IsChartsOnly()
    {
        var newDoc = LegacyDoc.Replace(
            """"
            "chart": { "title": "KPIs", "type": "kpi" } }
            """",
            """"
            "chart": { "title": "KPIs", "type": "kpi" } }, { "id": "t2", "kind": "chart" }
            """");

        var summary = Diff(LegacyDoc, newDoc);

        AssertFlags(summary, charts: true);
        Assert.Equal(1, summary.TilesAdded);
    }

    [Fact]
    public void LegacyTopLevelSlicersChanged_IsLayoutOnly()
    {
        var newDoc = LegacyDoc.Replace("\"column\": \"status\"", "\"column\": \"region\"");

        var summary = Diff(LegacyDoc, newDoc);

        AssertFlags(summary, layout: true);
    }

    [Fact]
    public void LegacyDocMigratedToPages_ReadsAsPageRestructure()
    {
        var paged = """{ "pages": [{ "id": "p1", "name": "Page 1", "tiles": [] }] }""";
        var summary = Diff(LegacyDoc, paged);

        // The implicit page departs, a real page arrives: pages class raised.
        Assert.True(summary.PagesChanged);
    }

    // ------------------------------ fail closed ------------------------------

    [Theory]
    [InlineData("{ not json", "{}")]
    [InlineData("{}", "{ not json")]
    [InlineData("", "{}")]
    [InlineData("[1,2]", "{}")]
    [InlineData("{}", "\"scalar\"")]
    public void UnparseableOrNonObjectDocs_RaiseAllFlags(string oldDoc, string newDoc)
    {
        var summary = Diff(oldDoc, newDoc);

        AssertFlags(summary, layout: true, pages: true, charts: true);
    }

    [Fact]
    public void NullInputs_RaiseAllFlags()
    {
        AssertFlags(Diff(null!, null!), layout: true, pages: true, charts: true);
    }

    [Fact]
    public void UnrecognizedTileLevelChange_RaisesAllFlags()
    {
        // A property the differ does not know changes inside a tile.
        var oldDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1", "future": 1 }] }] }""";
        var newDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1", "future": 2 }] }] }""";

        AssertFlags(Diff(oldDoc, newDoc), layout: true, pages: true, charts: true);
    }

    [Fact]
    public void UnrecognizedPageLevelChange_RaisesAllFlags()
    {
        var oldDoc = """{ "pages": [{ "id": "p1", "tiles": [], "future": 1 }] }""";
        var newDoc = """{ "pages": [{ "id": "p1", "tiles": [], "future": 2 }] }""";

        AssertFlags(Diff(oldDoc, newDoc), layout: true, pages: true, charts: true);
    }

    [Fact]
    public void DuplicateTileIds_RaiseAllFlags()
    {
        var oldDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1" }, { "id": "t1" }] }] }""";
        var newDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1" }] }] }""";

        AssertFlags(Diff(oldDoc, newDoc), layout: true, pages: true, charts: true);
    }

    [Fact]
    public void UnknownDocLevelKeyChange_IsSettingsClass()
    {
        var oldDoc = """{ "pages": [{ "id": "p1", "tiles": [] }], "futureSetting": 1 }""";
        var newDoc = """{ "pages": [{ "id": "p1", "tiles": [] }], "futureSetting": 2 }""";

        var summary = Diff(oldDoc, newDoc);

        AssertFlags(summary, layout: true);
        Assert.True(summary.SettingsChanged);
    }
}
