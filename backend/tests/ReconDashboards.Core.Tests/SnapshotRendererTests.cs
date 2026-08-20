using System.Text;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Querying.Spec;
using ReconDashboards.Core.Scheduling;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The snapshot email's HTML shell and CSV document. These are the bytes that
/// land in someone's inbox at 6 a.m., so the rules are strict: self-contained
/// inline CSS (no external assets a mail client would block), every value
/// HTML-encoded, errors reduced to a short note that leaks no SQL, and the
/// "generated" stamp spoken in the reader's plant time — not UTC.
/// </summary>
public class SnapshotRendererTests
{
    private static readonly DateTime GeneratedUtc = new(2026, 8, 18, 12, 0, 0, DateTimeKind.Utc);

    /// <summary>UTC-6 with no DST: a fixed offset keeps the stamp assertions machine-independent.</summary>
    private static readonly TimeZoneInfo PlantZone =
        TimeZoneInfo.CreateCustomTimeZone("RcdTestPlant", TimeSpan.FromHours(-6), "Plant", "Plant");

    private static ResultColumnPlan Dimension(string label = "Region") =>
        new("dim0", label, ResultColumnRole.Dimension, NormalizedType.Text,
            "public.customers.region", null, null);

    private static ResultColumnPlan Measure(string label = "Total", string? formatString = null) =>
        new("meas0", label, ResultColumnRole.Measure, NormalizedType.Decimal,
            "public.orders.order_total", null, null, formatString);

    private static RenderedTile Tile(
        string title, IReadOnlyList<ResultColumnPlan> columns, IReadOnlyList<object?[]> rows,
        string? error = null, string chartType = "table", ChartFormatDoc? format = null) =>
        new(
            new SnapshotTile(
                "t1", title, chartType, new ChartQuerySpec(1, [], [], [], [], null, null), format),
            columns, rows, error);

    private static string Render(params RenderedPage[] pages) =>
        SnapshotRenderer.RenderHtml("Ops Dashboard", GeneratedUtc, pages, PlantZone, "CT");

    // ------------------------------------------------------------------ shell

    [Fact]
    public void TheBodyIsSelfContainedHtmlWithThePlantTimeStamp()
    {
        var html = Render(new RenderedPage("Main", [Tile("Sales", [Dimension(), Measure()], [["West", 10]])]));

        Assert.Contains("Ops Dashboard", html, StringComparison.Ordinal);
        // 12:00 UTC is 06:00 in the plant zone, and the label rides along.
        Assert.Contains("Snapshot generated 2026-08-18 06:00 CT", html, StringComparison.Ordinal);
        // Inline CSS only: a mail client blocks anything it has to fetch.
        Assert.DoesNotContain("<link", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("http://", html, StringComparison.Ordinal);
        Assert.Contains("style=\"", html, StringComparison.Ordinal);
    }

    [Fact]
    public void PageHeadingsAppearOnlyWhenThereIsMoreThanOnePage()
    {
        var tile = Tile("Sales", [Dimension(), Measure()], [["West", 10]]);

        var single = Render(new RenderedPage("Main", [tile]));
        Assert.DoesNotContain(">Main<", single, StringComparison.Ordinal);

        var multi = Render(new RenderedPage("Main", [tile]), new RenderedPage("Detail", [tile]));
        Assert.Contains(">Main<", multi, StringComparison.Ordinal);
        Assert.Contains(">Detail<", multi, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEmptyPageSaysSoInsteadOfRenderingNothing()
    {
        var html = Render(new RenderedPage("Main", []));
        Assert.Contains("No chart tiles on this page.", html, StringComparison.Ordinal);
    }

    [Fact]
    public void TitlesAndCellsAreHtmlEncoded()
    {
        var html = Render(new RenderedPage(
            "Main",
            [Tile("<script>alert(1)</script>", [Dimension(), Measure()], [["A & B <b>", 10]])]));

        Assert.DoesNotContain("<script>alert", html, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;", html, StringComparison.Ordinal);
        Assert.Contains("A &amp; B &lt;b&gt;", html, StringComparison.Ordinal);
    }

    // -------------------------------------------------------------- tile bodies

    [Fact]
    public void AFailedTileRendersAShortRedNoteAndNoTable()
    {
        var html = Render(new RenderedPage(
            "Main", [Tile("Broken", [], [], error: "The column no longer exists.")]));

        Assert.Contains("The column no longer exists.", html, StringComparison.Ordinal);
        Assert.Contains("#b91c1c", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<table", html, StringComparison.Ordinal);
    }

    [Fact]
    public void TheKpiShapeIsZeroDimensionsAndAtMostOneRow()
    {
        var oneRow = Tile("Revenue", [Measure("Revenue")], [[1234]]);
        var noRows = Tile("Revenue", [Measure("Revenue")], []);
        var twoRows = Tile("Revenue", [Measure("Revenue")], [[1], [2]]);
        var dimensioned = Tile("Revenue", [Dimension(), Measure()], [["West", 1]]);

        Assert.True(SnapshotRenderer.HasKpiShape(oneRow));
        Assert.True(SnapshotRenderer.HasKpiShape(noRows));
        Assert.False(SnapshotRenderer.HasKpiShape(twoRows));
        Assert.False(SnapshotRenderer.HasKpiShape(dimensioned));

        var html = Render(new RenderedPage("Main", [oneRow]));
        Assert.Contains("font-size:26px", html, StringComparison.Ordinal); // the big number
        // KPI values read like the tile does: the chart's measure formatting,
        // not the raw invariant cell text.
        Assert.Contains("1,234", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<table", html, StringComparison.Ordinal);
    }

    [Fact]
    public void KpiValuesReadLikeTheTileDoesFormatAndRenamesIncluded()
    {
        var format = new ChartFormatDoc(
            ValueFormat: "#,0",
            SeriesLabels: new Dictionary<string, string> { ["Systems"] = "Systems tracked" });
        var html = Render(new RenderedPage("Main", [Tile(
            "Systems", [Measure("Systems", "0.0000")], [[1234.5m]], format: format)]));

        Assert.Contains("1,235", html, StringComparison.Ordinal); // valueFormat beats the measure pattern
        Assert.DoesNotContain("1234.5000", html, StringComparison.Ordinal);
        Assert.Contains("Systems tracked", html, StringComparison.Ordinal);
    }

    [Fact]
    public void ASecondKpiMeasureIsDemotedToASmallDeltaRow()
    {
        var html = Render(new RenderedPage("Main", [Tile(
            "Revenue", [Measure("Revenue"), Measure("Change")], [[1000m, 25m]])]));

        // The first measure keeps the big number; the second reads as a note
        // under it rather than a second headline.
        Assert.Contains("<div style=\"font-size:26px;font-weight:700;color:#111827;\">1,000</div>", html, StringComparison.Ordinal);
        Assert.Contains("font-size:13px", html, StringComparison.Ordinal);
        Assert.Equal(1, html.Split("font-size:26px").Length - 1);
        Assert.Contains(">25<", html, StringComparison.Ordinal);
        Assert.Contains(">Change<", html, StringComparison.Ordinal);
    }

    [Fact]
    public void ANonNumericKpiKeepsPlainCellText()
    {
        var html = Render(new RenderedPage("Main", [Tile(
            "Last Updated", [Measure("Last Updated")], [[new DateTime(2026, 8, 18)]],
            format: new ChartFormatDoc(ValueFormat: "#,0"))]));
        Assert.Contains("2026-08-18", html, StringComparison.Ordinal);
    }

    [Fact]
    public void KpiValueStyleOverridesTheHeadlineType()
    {
        var html = Render(new RenderedPage("Main", [Tile(
            "Revenue", [Measure("Revenue")], [[10m]],
            format: new ChartFormatDoc(KpiValueStyle: new ChartTextStyleDoc(FontSize: 32, Color: "#7b2cbf")))]));

        Assert.Contains("font-size:32px;color:#7b2cbf;", html, StringComparison.Ordinal);
    }

    // ------------------------------------------------------- tile title + card

    [Fact]
    public void AFramelessTilesRichInnerTitleReplacesThePlainHeading()
    {
        // Every tile on a seeded dashboard hides its header and puts the visible
        // name (plus an explanatory subtitle) in container.innerTitleHtml; the
        // email used to print the bare chart.title and drop all of it.
        var container = new ContainerStyleDoc(
            HideHeader: true,
            InnerTitleHtml: "<p><b>Systems by Business Area</b> <span style=\"color:#64748b\">&mdash; top 15</span></p>");
        var html = Render(new RenderedPage("Main", [Tile(
            "Systems by Business Area", [Dimension(), Measure()], [["West", 10]],
            format: new ChartFormatDoc(Container: container))]));

        Assert.Contains("<b>Systems by Business Area</b>", html, StringComparison.Ordinal);
        Assert.Contains("&mdash; top 15", html, StringComparison.Ordinal);
        Assert.Contains("style=\"color:#64748b\"", html, StringComparison.Ordinal);
        // The wrapping paragraph is unwrapped so the heading keeps its spacing.
        Assert.DoesNotContain("<p>", html, StringComparison.Ordinal);
    }

    [Fact]
    public void AFramedTileKeepsItsTitleAndGainsTheInnerTitleAsASubtitle()
    {
        var html = Render(new RenderedPage("Main", [Tile(
            "Sales", [Dimension(), Measure()], [["West", 10]],
            format: new ChartFormatDoc(Container: new ContainerStyleDoc(
                InnerTitleHtml: "<p>rolling 12 months</p>")))]));

        Assert.Contains(">Sales</div>", html, StringComparison.Ordinal);
        Assert.Contains("rolling 12 months", html, StringComparison.Ordinal);
    }

    [Fact]
    public void AnInnerTitleIsSanitizedBeforeItReachesTheInbox()
    {
        var container = new ContainerStyleDoc(
            HideHeader: true,
            InnerTitleHtml:
                "<p onclick=\"steal()\"><b>Safe</b><script>alert(1)</script>"
                + "<a href=\"http://evil.example\">click</a><img src=x onerror=y>"
                + "<span style=\"background:url(javascript:1);color:#ff0000\">tinted</span></p>");
        var html = Render(new RenderedPage("Main", [Tile(
            "T", [Dimension(), Measure()], [["West", 10]],
            format: new ChartFormatDoc(Container: container))]));

        Assert.Contains("<b>Safe</b>", html, StringComparison.Ordinal);
        Assert.Contains("color:#ff0000", html, StringComparison.Ordinal);
        Assert.Contains("tinted", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("alert(1)", html, StringComparison.Ordinal);
        Assert.DoesNotContain("onclick", html, StringComparison.Ordinal);
        Assert.DoesNotContain("onerror", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<img", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("background:url", html, StringComparison.Ordinal);
        // Anchors are unwrapped to their text: an author-controlled link in
        // someone else's inbox is a phishing surface a caption does not need.
        Assert.DoesNotContain("<a ", html, StringComparison.Ordinal);
        Assert.DoesNotContain("http://", html, StringComparison.Ordinal);
        Assert.Contains("click", html, StringComparison.Ordinal);
    }

    [Fact]
    public void ContainerStylingReachesTheTileCardAndOnlyAcceptsHexColors()
    {
        var styled = Render(new RenderedPage("Main", [Tile(
            "Systems", [Measure()], [[10m]],
            format: new ChartFormatDoc(Container: new ContainerStyleDoc(
                BorderColor: "#2a78d6", BorderWidth: 1, BorderRadius: 12, Shadow: "sm")))]));
        Assert.Contains("border:1px solid #2a78d6;border-radius:12px;", styled, StringComparison.Ordinal);
        Assert.Contains("box-shadow:0 1px 2px", styled, StringComparison.Ordinal);

        // A tile with no container keeps the standard card, byte for byte.
        var plain = Render(new RenderedPage("Main", [Tile("Systems", [Measure()], [[10m]])]));
        Assert.Contains(
            "margin:16px 0;padding:12px 16px;border:1px solid #e5e7eb;border-radius:8px;",
            plain, StringComparison.Ordinal);

        // An injected "color" never becomes CSS.
        var hostile = Render(new RenderedPage("Main", [Tile(
            "Systems", [Measure()], [[10m]],
            format: new ChartFormatDoc(Container: new ContainerStyleDoc(
                Background: "red;position:fixed", BorderColor: "url(x)")))]));
        Assert.DoesNotContain("position:fixed", hostile, StringComparison.Ordinal);
        Assert.DoesNotContain("url(x)", hostile, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryOtherShapeRendersAnHtmlTable()
    {
        var html = Render(new RenderedPage(
            "Main", [Tile("Sales", [Dimension(), Measure()], [["West", 10], ["East", 20]])]));

        Assert.Contains("<table", html, StringComparison.Ordinal);
        Assert.Contains(">Region<", html, StringComparison.Ordinal);
        Assert.Contains(">West<", html, StringComparison.Ordinal);
        Assert.Contains(">20<", html, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------- the row cap

    [Fact]
    public void TheHistoricalFiftyRowCapIsStillTheDefaultAndSaysWhatItHeldBack()
    {
        Assert.Equal(50, SnapshotRenderer.HtmlRowsPerTile);

        var rows = Enumerable.Range(0, 60).Select(i => new object?[] { $"R{i}", i }).ToArray();
        var html = Render(new RenderedPage("Main", [Tile("Sales", [Dimension(), Measure()], rows)]));

        Assert.Contains(">R49<", html, StringComparison.Ordinal);
        Assert.DoesNotContain(">R50<", html, StringComparison.Ordinal);
        Assert.Contains("10 more rows not shown.", html, StringComparison.Ordinal);
    }

    [Fact]
    public void AnExplicitMaxTableRowsReplacesTheCapInBothDirections()
    {
        var rows = Enumerable.Range(0, 60).Select(i => new object?[] { $"R{i}", i }).ToArray();
        var page = new RenderedPage("Main", [Tile("Sales", [Dimension(), Measure()], rows)]);

        var tight = SnapshotRenderer.RenderHtml("Ops", GeneratedUtc, [page], PlantZone, "CT", maxTableRows: 5);
        Assert.Contains(">R4<", tight, StringComparison.Ordinal);
        Assert.DoesNotContain(">R5<", tight, StringComparison.Ordinal);
        Assert.Contains("55 more rows not shown.", tight, StringComparison.Ordinal);

        var wide = SnapshotRenderer.RenderHtml("Ops", GeneratedUtc, [page], PlantZone, "CT", maxTableRows: 500);
        Assert.Contains(">R59<", wide, StringComparison.Ordinal);
        Assert.DoesNotContain("more rows not shown", wide, StringComparison.Ordinal);
    }

    // ------------------------------------------------------- the body delegate

    [Fact]
    public void TheCustomBodyOverloadKeepsTheSameShellAndFeedsPageAndTileIndices()
    {
        var pages = new[]
        {
            new RenderedPage("Main", [Tile("A", [Measure()], [[1]]), Tile("B", [Measure()], [[2]])]),
            new RenderedPage("Detail", [Tile("C", [Measure()], [[3]])]),
        };

        var seen = new List<string>();
        var html = SnapshotRenderer.RenderHtml(
            "Ops Dashboard", GeneratedUtc, pages, PlantZone, "CT",
            (builder, tile, pageIndex, tileIndex) =>
            {
                seen.Add($"{tile.Tile.Title}:{pageIndex}:{tileIndex}");
                builder.Append("<i>custom</i>");
            });

        Assert.Equal(["A:0:0", "B:0:1", "C:1:0"], seen);
        // Same header, page headings, and tile chrome as the default overload.
        Assert.Contains("Snapshot generated 2026-08-18 06:00 CT", html, StringComparison.Ordinal);
        Assert.Contains(">Detail<", html, StringComparison.Ordinal);
        Assert.Equal(3, html.Split("<i>custom</i>").Length - 1);
        Assert.DoesNotContain("<table", html, StringComparison.Ordinal);
    }

    [Fact]
    public void TheDefaultOverloadIsExactlyTheShellPlusTheLegacyTileBody()
    {
        var pages = new[] { new RenderedPage("Main", [Tile("Sales", [Dimension(), Measure()], [["West", 10]])]) };

        var viaDefault = SnapshotRenderer.RenderHtml("Ops", GeneratedUtc, pages, PlantZone, "CT");
        var viaDelegate = SnapshotRenderer.RenderHtml(
            "Ops", GeneratedUtc, pages, PlantZone, "CT",
            (builder, tile, _, _) => SnapshotRenderer.AppendTileBody(builder, tile));

        Assert.Equal(viaDefault, viaDelegate);
    }

    [Fact]
    public void TheExposedTileBodyPartsMatchWhatTheDefaultBodyEmits()
    {
        // SnapshotComposer reuses these three pieces verbatim, so a charts-mode
        // KPI/table/error tile is byte-identical to a tables-mode one.
        var kpi = Tile("Revenue", [Measure("Revenue")], [[1234]]);
        var table = Tile("Sales", [Dimension(), Measure()], [["West", 10]]);

        var whole = new StringBuilder();
        SnapshotRenderer.AppendTileBody(whole, kpi);
        var parts = new StringBuilder();
        SnapshotRenderer.AppendKpiBlock(parts, kpi);
        Assert.Equal(whole.ToString(), parts.ToString());

        whole.Clear();
        parts.Clear();
        SnapshotRenderer.AppendTileBody(whole, table);
        SnapshotRenderer.AppendTable(parts, table, SnapshotRenderer.HtmlRowsPerTile);
        Assert.Equal(whole.ToString(), parts.ToString());

        whole.Clear();
        parts.Clear();
        var broken = Tile("Broken", [], [], error: "boom");
        SnapshotRenderer.AppendTileBody(whole, broken);
        SnapshotRenderer.AppendErrorNote(parts, "boom");
        Assert.Equal(whole.ToString(), parts.ToString());
    }

    // -------------------------------------------------------------------- csv

    [Fact]
    public void TheCsvIsOneDocumentWithACommentHeaderPerTileAndEveryRow()
    {
        var rows = Enumerable.Range(0, 60).Select(i => new object?[] { $"R{i}", i }).ToArray();
        var csv = SnapshotRenderer.RenderCsv(
            "Ops Dashboard", GeneratedUtc,
            [new RenderedPage("Main", [Tile("Sales", [Dimension(), Measure()], rows)])],
            PlantZone, "CT");

        Assert.StartsWith("# Ops Dashboard — snapshot 2026-08-18 06:00 CT", csv, StringComparison.Ordinal);
        Assert.Contains("# Main / Sales", csv, StringComparison.Ordinal);
        Assert.Contains("Region,Total", csv, StringComparison.Ordinal);
        // Unlike the HTML body, the CSV carries EVERYTHING — that is its job.
        Assert.Contains("R59,59", csv, StringComparison.Ordinal);
    }

    [Fact]
    public void CsvFieldsWithSeparatorsQuotesOrNewlinesAreQuotedAndEscaped()
    {
        var csv = SnapshotRenderer.RenderCsv(
            "Ops", GeneratedUtc,
            [new RenderedPage("Main", [Tile(
                "Sales", [Dimension(), Measure()],
                [["West, Central", 10], ["He said \"hi\"", 20], ["two\nlines", 30]])])],
            PlantZone, "CT");

        Assert.Contains("\"West, Central\",10", csv, StringComparison.Ordinal);
        Assert.Contains("\"He said \"\"hi\"\"\",20", csv, StringComparison.Ordinal);
        Assert.Contains("\"two\nlines\",30", csv, StringComparison.Ordinal);
    }

    [Fact]
    public void ACsvTileThatFailedCarriesItsErrorAsAComment()
    {
        var csv = SnapshotRenderer.RenderCsv(
            "Ops", GeneratedUtc,
            [new RenderedPage("Main", [Tile("Broken", [], [], error: "The column no longer exists.")])],
            PlantZone, "CT");

        Assert.Contains("# error: The column no longer exists.", csv, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData(true, "true")]
    [InlineData(false, "false")]
    [InlineData(1234.5678, "1234.5678")]
    [InlineData(1234.56789, "1234.5679")]
    [InlineData("plain", "plain")]
    public void CellTextIsInvariantCultureRegardlessOfTheServerLocale(object? value, string expected) =>
        Assert.Equal(expected, SnapshotRenderer.FormatValue(value));

    [Fact]
    public void DateCellsDropAMidnightTimeComponent()
    {
        Assert.Equal("2026-08-18", SnapshotRenderer.FormatValue(new DateTime(2026, 8, 18)));
        Assert.Equal("2026-08-18 07:30", SnapshotRenderer.FormatValue(new DateTime(2026, 8, 18, 7, 30, 0)));
        Assert.Equal("2026-08-18", SnapshotRenderer.FormatValue(new DateOnly(2026, 8, 18)));
        Assert.Equal(
            "2026-08-18 12:00",
            SnapshotRenderer.FormatValue(new DateTimeOffset(2026, 8, 18, 12, 0, 0, TimeSpan.Zero)));
    }
}
