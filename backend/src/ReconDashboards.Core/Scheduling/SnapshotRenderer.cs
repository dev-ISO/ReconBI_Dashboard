using System.Globalization;
using System.Net;
using System.Text;
using ReconDashboards.Core.Querying.Compilation;

namespace ReconDashboards.Core.Scheduling;

/// <summary>A snapshot tile after execution: result shape + rows, or a safe error note.</summary>
public sealed record RenderedTile(
    SnapshotTile Tile,
    IReadOnlyList<ResultColumnPlan> Columns,
    IReadOnlyList<object?[]> Rows,
    string? Error);

/// <summary>A page's rendered tiles.</summary>
public sealed record RenderedPage(string Name, IReadOnlyList<RenderedTile> Tiles);

/// <summary>
/// Renders executed dashboard snapshots as a self-contained HTML email body
/// (inline CSS only — no external assets) and as one merged CSV document with
/// a section per tile. Errors render as short notes; SQL and database details
/// never appear.
/// </summary>
public static class SnapshotRenderer
{
    /// <summary>Rows shown per tile in the HTML body; the CSV carries everything.</summary>
    public const int HtmlRowsPerTile = 50;

    /// <summary>
    /// "Generated" stamps render in the host-configured schedule zone
    /// (<paramref name="stampZone"/> / <paramref name="stampZoneLabel"/> come
    /// from ReconDashboardsOptions via the evaluator) — the reader schedules
    /// in plant time, so the email must speak plant time too. The default
    /// <paramref name="maxTableRows"/> keeps legacy (NULL content) emails
    /// byte-identical to the pre-content renderer.
    /// </summary>
    public static string RenderHtml(
        string dashboardName, DateTime generatedUtc, IReadOnlyList<RenderedPage> pages,
        TimeZoneInfo stampZone, string stampZoneLabel, int maxTableRows = HtmlRowsPerTile) =>
        RenderHtml(
            dashboardName, generatedUtc, pages, stampZone, stampZoneLabel,
            (html, tile, _, _) => AppendTileBody(html, tile, maxTableRows));

    /// <summary>
    /// Shell + custom tile bodies: SnapshotComposer's charts/both modes swap
    /// in per-tile image/table decisions while header, page structure, and
    /// footer stay THIS one implementation — the preview can never drift from
    /// the delivered shell. The delegate receives (builder, tile, pageIndex,
    /// tileIndex); indices feed the cid naming.
    /// </summary>
    public static string RenderHtml(
        string dashboardName, DateTime generatedUtc, IReadOnlyList<RenderedPage> pages,
        TimeZoneInfo stampZone, string stampZoneLabel,
        Action<StringBuilder, RenderedTile, int, int> appendTileBody)
    {
        var html = new StringBuilder();
        html.Append("<div style=\"font-family:Segoe UI,Arial,sans-serif;color:#1f2937;max-width:760px;margin:0 auto;\">");
        html.Append("<div style=\"padding:16px 0;border-bottom:2px solid #e5e7eb;\">");
        html.Append("<div style=\"font-size:20px;font-weight:600;\">").Append(Encode(dashboardName)).Append("</div>");
        html.Append("<div style=\"font-size:12px;color:#6b7280;margin-top:2px;\">Snapshot generated ")
            .Append(Encode(Stamp(generatedUtc, stampZone, stampZoneLabel))).Append("</div>");
        html.Append("</div>");

        var multiplePages = pages.Count > 1;
        for (var pageIndex = 0; pageIndex < pages.Count; pageIndex++)
        {
            var page = pages[pageIndex];
            if (multiplePages)
            {
                html.Append("<div style=\"font-size:15px;font-weight:600;margin:20px 0 4px;color:#374151;\">")
                    .Append(Encode(page.Name)).Append("</div>");
            }

            if (page.Tiles.Count == 0)
            {
                html.Append("<div style=\"font-size:12px;color:#9ca3af;margin:8px 0;\">No chart tiles on this page.</div>");
                continue;
            }

            for (var tileIndex = 0; tileIndex < page.Tiles.Count; tileIndex++)
            {
                var tile = page.Tiles[tileIndex];
                html.Append("<div style=\"margin:16px 0;padding:12px 16px;border:1px solid #e5e7eb;border-radius:8px;\">");
                html.Append("<div style=\"font-size:13px;font-weight:600;margin-bottom:8px;\">")
                    .Append(Encode(tile.Tile.Title)).Append("</div>");
                appendTileBody(html, tile, pageIndex, tileIndex);
                html.Append("</div>");
            }
        }

        html.Append("<div style=\"font-size:11px;color:#9ca3af;padding:12px 0;border-top:1px solid #e5e7eb;\">")
            .Append("Sent by ReconDashboards. Data reflects your row-level access at send time.")
            .Append("</div>");
        html.Append("</div>");
        return html.ToString();
    }

    /// <summary>The legacy per-tile body: error note, KPI shape, else the table.</summary>
    public static void AppendTileBody(StringBuilder html, RenderedTile tile, int maxTableRows = HtmlRowsPerTile)
    {
        if (tile.Error is not null)
        {
            AppendErrorNote(html, tile.Error);
            return;
        }

        // KPI shape: no dimensions, single row — big numbers, one per measure.
        if (HasKpiShape(tile))
        {
            AppendKpiBlock(html, tile);
            return;
        }

        AppendTable(html, tile, maxTableRows);
    }

    public static void AppendErrorNote(StringBuilder html, string error) =>
        html.Append("<div style=\"font-size:12px;color:#b91c1c;\">").Append(Encode(error)).Append("</div>");

    /// <summary>The shape-triggered KPI branch's condition: 0 dimensions, at most one row.</summary>
    public static bool HasKpiShape(RenderedTile tile) =>
        tile.Columns.Count(c => c.Role == ResultColumnRole.Dimension) == 0 && tile.Rows.Count <= 1;

    public static void AppendKpiBlock(StringBuilder html, RenderedTile tile)
    {
        var row = tile.Rows.Count == 1 ? tile.Rows[0] : null;
        html.Append("<div>");
        for (var i = 0; i < tile.Columns.Count; i++)
        {
            var column = tile.Columns[i];
            html.Append("<div style=\"display:inline-block;margin-right:28px;\">");
            html.Append("<div style=\"font-size:26px;font-weight:700;color:#111827;\">")
                .Append(Encode(FormatValue(row?[i]))).Append("</div>");
            html.Append("<div style=\"font-size:11px;color:#6b7280;\">").Append(Encode(column.Label)).Append("</div>");
            html.Append("</div>");
        }

        html.Append("</div>");
    }

    public static void AppendTable(StringBuilder html, RenderedTile tile, int maxTableRows)
    {
        html.Append("<table style=\"border-collapse:collapse;font-size:12px;width:100%;\">");
        html.Append("<tr>");
        foreach (var column in tile.Columns)
        {
            html.Append("<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid #d1d5db;color:#374151;\">")
                .Append(Encode(column.Label)).Append("</th>");
        }

        html.Append("</tr>");

        foreach (var row in tile.Rows.Take(maxTableRows))
        {
            html.Append("<tr>");
            for (var i = 0; i < tile.Columns.Count; i++)
            {
                var isMeasure = tile.Columns[i].Role == ResultColumnRole.Measure;
                html.Append("<td style=\"padding:3px 8px;border-bottom:1px solid #f3f4f6;")
                    .Append(isMeasure ? "text-align:right;font-variant-numeric:tabular-nums;" : "")
                    .Append("\">")
                    .Append(Encode(FormatValue(i < row.Length ? row[i] : null)))
                    .Append("</td>");
            }

            html.Append("</tr>");
        }

        html.Append("</table>");

        if (tile.Rows.Count > maxTableRows)
        {
            html.Append("<div style=\"font-size:11px;color:#9ca3af;margin-top:4px;\">")
                .Append(tile.Rows.Count - maxTableRows).Append(" more rows not shown.</div>");
        }
    }

    /// <summary>One merged CSV: a comment-style section header per tile, then header + data rows.
    /// The header stamp uses the same schedule-zone rendering as the HTML body.</summary>
    public static string RenderCsv(
        string dashboardName, DateTime generatedUtc, IReadOnlyList<RenderedPage> pages,
        TimeZoneInfo stampZone, string stampZoneLabel)
    {
        var csv = new StringBuilder();
        csv.Append("# ").Append(dashboardName).Append(" — snapshot ")
            .AppendLine(Stamp(generatedUtc, stampZone, stampZoneLabel));

        foreach (var page in pages)
        {
            foreach (var tile in page.Tiles)
            {
                csv.AppendLine();
                csv.Append("# ").Append(page.Name).Append(" / ").AppendLine(tile.Tile.Title);
                if (tile.Error is not null)
                {
                    csv.Append("# error: ").AppendLine(tile.Error);
                    continue;
                }

                csv.AppendLine(string.Join(",", tile.Columns.Select(c => CsvField(c.Label))));
                foreach (var row in tile.Rows)
                {
                    csv.AppendLine(string.Join(",", row.Select(v => CsvField(FormatValue(v)))));
                }
            }
        }

        return csv.ToString();
    }

    /// <summary>"2026-08-18 07:00 CT" — a UTC instant rendered as schedule-zone wall time.</summary>
    private static string Stamp(DateTime generatedUtc, TimeZoneInfo stampZone, string stampZoneLabel) =>
        TimeZoneInfo.ConvertTimeFromUtc(generatedUtc, stampZone)
            .ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + " " + stampZoneLabel;

    private static string Encode(string value) => WebUtility.HtmlEncode(value);

    private static string CsvField(string value) =>
        value.Contains(',') || value.Contains('"') || value.Contains('\n') || value.Contains('\r')
            ? "\"" + value.Replace("\"", "\"\"") + "\""
            : value;

    /// <summary>Invariant-culture cell text; dates drop a midnight time component.</summary>
    public static string FormatValue(object? value) => value switch
    {
        null => "",
        DateTime dt when dt.TimeOfDay == TimeSpan.Zero => dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTime dt => dt.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture),
        DateTimeOffset dto => FormatValue(dto.UtcDateTime),
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        bool b => b ? "true" : "false",
        decimal dec => dec.ToString("0.####", CultureInfo.InvariantCulture),
        double dbl => dbl.ToString("0.####", CultureInfo.InvariantCulture),
        float f => f.ToString("0.####", CultureInfo.InvariantCulture),
        IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture) ?? "",
        _ => value.ToString() ?? "",
    };
}
