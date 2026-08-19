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
        LayoutChangeSummary summary,
        bool layout = false,
        bool pages = false,
        bool charts = false,
        bool geometry = false,
        bool renamed = false)
    {
        Assert.Equal(layout, summary.LayoutChanged);
        Assert.Equal(pages, summary.PagesChanged);
        Assert.Equal(charts, summary.ChartsChanged);
        Assert.Equal(geometry, summary.GeometryChanged);
        Assert.Equal(renamed, summary.ChartsRenamed.Count > 0);
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
    public void TileMoved_IsGeometryOnly()
    {
        // 0.11.1: pure move/resize is its own class (CanMoveTiles), no longer
        // a layout-class change.
        var newDoc = BaseDoc.Replace("""{ "x": 0, "y": 0, "w": 4, "h": 3 }""", """{ "x": 2, "y": 1, "w": 4, "h": 3 }""");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, geometry: true);
        Assert.True(summary.HasAnyChange);
        Assert.Empty(summary.ChartsModified);
    }

    [Fact]
    public void TileMovedAndSlicerEdited_RaisesGeometryAndLayout()
    {
        var newDoc = BaseDoc
            .Replace("""{ "x": 0, "y": 0, "w": 4, "h": 3 }""", """{ "x": 2, "y": 1, "w": 4, "h": 3 }""")
            .Replace("\"column\": \"status\"", "\"column\": \"order_date\"");

        AssertFlags(Diff(BaseDoc, newDoc), layout: true, geometry: true);
    }

    [Fact]
    public void ChartEdited_IsChartsOnly_AndNamesTheChart()
    {
        var newDoc = BaseDoc.Replace("\"type\": \"column\"", "\"type\": \"line\"");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, charts: true);
        Assert.Equal(["Orders by Region"], summary.ChartsModified);
    }

    // ------------------------- chart renames (0.11.1) -------------------------
    // chart.title + format.container.innerTitleHtml are split out of the chart
    // body: retitles are owner/admin-only, body edits ride CanEditCharts.

    [Fact]
    public void ChartTitleChanged_IsRenameOnly_NotChartsClass()
    {
        var newDoc = BaseDoc.Replace("\"title\": \"Orders by Region\"", "\"title\": \"Orders by Area\"");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, renamed: true);
        var rename = Assert.Single(summary.ChartsRenamed);
        Assert.Equal("Orders by Region", rename.From);
        Assert.Equal("Orders by Area", rename.To);
        Assert.True(summary.HasAnyChange);
        Assert.Empty(summary.ChartsModified);
    }

    [Fact]
    public void ChartTitleAndBodyChanged_RaisesRenameAndChartsClass()
    {
        var newDoc = BaseDoc
            .Replace("\"title\": \"Orders by Region\"", "\"title\": \"Orders by Area\"")
            .Replace("\"type\": \"column\"", "\"type\": \"line\"");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, charts: true, renamed: true);
        Assert.Equal(["Orders by Area"], summary.ChartsModified);
    }

    private const string InnerTitleDoc = """
        {
          "pages": [
            {
              "id": "p1", "name": "Overview",
              "tiles": [
                { "id": "t1", "kind": "chart", "layout": { "x": 0, "y": 0, "w": 4, "h": 3 },
                  "chart": { "id": "c1", "type": "column", "title": "Orders",
                             "query": { "measures": [{ "name": "Total" }] },
                             "format": { "palette": "a",
                                         "container": { "hideHeader": true, "innerTitleHtml": "<p><b>Orders</b></p>" } } } }
              ]
            }
          ]
        }
        """;

    [Fact]
    public void InnerTitleOnlyChanged_IsRenameOnly()
    {
        // Frameless tiles display the INNER title as their visible name, so a
        // change to it is a retitle even when chart.title is untouched.
        var newDoc = InnerTitleDoc.Replace("<p><b>Orders</b></p>", "<p><b>Everything</b></p>");

        var summary = Diff(InnerTitleDoc, newDoc);

        AssertFlags(summary, renamed: true);
        var rename = Assert.Single(summary.ChartsRenamed);
        Assert.Equal(rename.From, rename.To); // title unchanged: inner-title-only retitle
    }

    [Fact]
    public void InnerTitleAndOtherFormatChanged_RaisesRenameAndChartsClass()
    {
        var newDoc = InnerTitleDoc
            .Replace("<p><b>Orders</b></p>", "<p><b>Everything</b></p>")
            .Replace("\"palette\": \"a\"", "\"palette\": \"b\"");

        AssertFlags(Diff(InnerTitleDoc, newDoc), charts: true, renamed: true);
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
    public void ChartTileRemoved_IsChartsOnly()
    {
        var newDoc = """
            {
              "pages": [
                {
                  "id": "p1", "name": "Overview", "color": "#ff0000",
                  "tiles": [
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

    // Finding 9: add/remove of slicer/text/image/button tiles is a LAYOUT-class
    // change, same as editing one; only chart-kind tiles gate on canEditCharts.

    [Theory]
    [InlineData("slicer", """{ "id": "t9", "kind": "slicer", "slicer": { "table": "public.orders", "column": "region" } }""")]
    [InlineData("text", """{ "id": "t9", "kind": "text", "text": { "html": "<p>hello</p>" } }""")]
    [InlineData("image", """{ "id": "t9", "kind": "image", "image": { "src": "https://x/y.png", "fit": "contain" } }""")]
    [InlineData("button", """{ "id": "t9", "kind": "button", "button": { "html": "<p>Go</p>", "targetPageId": "p1" } }""")]
    public void StaticTileAdded_IsLayoutOnly(string kind, string tileJson)
    {
        _ = kind;
        var newDoc = BaseDoc.Replace(
            """{ "id": "p2", "name": "Detail", "tiles": [] }""",
            $$"""{ "id": "p2", "name": "Detail", "tiles": [{{tileJson}}] }""");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, layout: true);
        Assert.Equal(1, summary.TilesAdded);
    }

    [Fact]
    public void SlicerTileRemoved_IsLayoutOnly()
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

        AssertFlags(summary, layout: true);
        Assert.Equal(1, summary.TilesRemoved);
    }

    [Fact]
    public void PageAddedWithOnlyStaticTiles_IsPagesAndLayout()
    {
        var newDoc = BaseDoc.Replace(
            """{ "id": "p2", "name": "Detail", "tiles": [] }""",
            """{ "id": "p2", "name": "Detail", "tiles": [] }, { "id": "p3", "name": "Costs", "tiles": [{ "id": "t9", "kind": "text", "text": { "html": "<p>x</p>" } }] }""");

        var summary = Diff(BaseDoc, newDoc);

        AssertFlags(summary, layout: true, pages: true);
        Assert.Equal(1, summary.TilesAdded);
    }

    [Theory]
    [InlineData("text")]
    [InlineData("button")]
    public void TileKindChangedBetweenStaticKinds_IsLayoutClass(string newKind)
    {
        var newDoc = BaseDoc.Replace("\"id\": \"t2\", \"kind\": \"slicer\"", $"\"id\": \"t2\", \"kind\": \"{newKind}\"");

        var summary = Diff(BaseDoc, newDoc);

        Assert.True(summary.LayoutChanged);
        Assert.False(summary.ChartsChanged);
        Assert.False(summary.PagesChanged);
    }

    [Fact]
    public void ButtonTileEdited_IsLayoutOnly()
    {
        const string oldDoc = """
            { "pages": [{ "id": "p1", "tiles": [
              { "id": "t1", "kind": "button", "layout": { "x": 0, "y": 0, "w": 4, "h": 2 },
                "button": { "html": "<p>Go</p>", "targetPageId": "p1", "radius": 8 } }] }] }
            """;
        var newDoc = oldDoc.Replace("\"targetPageId\": \"p1\"", "\"targetPageId\": \"p2\"");

        AssertFlags(Diff(oldDoc, newDoc), layout: true);
    }

    [Fact]
    public void ButtonTileRemoved_IsLayoutOnly_AndCountsRemoval()
    {
        const string oldDoc = """
            { "pages": [{ "id": "p1", "tiles": [
              { "id": "t1", "kind": "button", "button": { "html": "<p>Go</p>", "targetPageId": "p1" } }] }] }
            """;
        const string newDoc = """{ "pages": [{ "id": "p1", "tiles": [] }] }""";

        var summary = Diff(oldDoc, newDoc);

        AssertFlags(summary, layout: true);
        Assert.Equal(1, summary.TilesRemoved);
        Assert.True(summary.HasRemovals);
    }

    [Fact]
    public void TileKindChangedFromChart_IsChartsClass()
    {
        var newDoc = BaseDoc.Replace("\"id\": \"t1\", \"kind\": \"chart\"", "\"id\": \"t1\", \"kind\": \"text\"");

        var summary = Diff(BaseDoc, newDoc);

        Assert.True(summary.ChartsChanged);
        Assert.False(summary.PagesChanged);
    }

    [Fact]
    public void UnknownTileKindAdded_FailsClosedToChartsClass()
    {
        var newDoc = BaseDoc.Replace(
            """{ "id": "p2", "name": "Detail", "tiles": [] }""",
            """{ "id": "p2", "name": "Detail", "tiles": [{ "id": "t9", "kind": "hologram" }] }""");

        Assert.True(Diff(BaseDoc, newDoc).ChartsChanged);
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
    public void LegacyTileMoved_IsGeometryOnly()
    {
        var newDoc = LegacyDoc.Replace("\"x\": 0", "\"x\": 6");
        AssertFlags(Diff(LegacyDoc, newDoc), geometry: true);
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

        // Fail-closed raises every GRANTABLE class (geometry included, plus
        // HasRemovals via FailClosed) — but never the owner-only rename gate.
        AssertFlags(summary, layout: true, pages: true, charts: true, geometry: true);
        Assert.True(summary.HasRemovals);
        Assert.Empty(summary.ChartsRenamed);
    }

    [Fact]
    public void NullInputs_RaiseAllFlags()
    {
        AssertFlags(Diff(null!, null!), layout: true, pages: true, charts: true, geometry: true);
    }

    [Fact]
    public void UnrecognizedTileLevelChange_RaisesAllFlags()
    {
        // A property the differ does not know changes inside a tile.
        var oldDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1", "future": 1 }] }] }""";
        var newDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1", "future": 2 }] }] }""";

        AssertFlags(Diff(oldDoc, newDoc), layout: true, pages: true, charts: true, geometry: true);
    }

    [Fact]
    public void UnrecognizedPageLevelChange_RaisesAllFlags()
    {
        var oldDoc = """{ "pages": [{ "id": "p1", "tiles": [], "future": 1 }] }""";
        var newDoc = """{ "pages": [{ "id": "p1", "tiles": [], "future": 2 }] }""";

        AssertFlags(Diff(oldDoc, newDoc), layout: true, pages: true, charts: true, geometry: true);
    }

    [Fact]
    public void DuplicateTileIds_RaiseAllFlags()
    {
        var oldDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1" }, { "id": "t1" }] }] }""";
        var newDoc = """{ "pages": [{ "id": "p1", "tiles": [{ "id": "t1" }] }] }""";

        AssertFlags(Diff(oldDoc, newDoc), layout: true, pages: true, charts: true, geometry: true);
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
