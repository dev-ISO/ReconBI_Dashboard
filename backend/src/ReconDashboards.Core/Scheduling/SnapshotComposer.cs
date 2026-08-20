using System.Net;
using System.Text;
using Microsoft.Extensions.Logging;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Querying.Compilation;
using ReconDashboards.Core.Rendering;

namespace ReconDashboards.Core.Scheduling;

/// <summary>How the composed snapshot will be consumed — the ONLY thing the two paths differ on.</summary>
public enum SnapshotMode
{
    /// <summary>Chart PNGs become cid inline attachments (tile-{page}-{tile}@rcd).</summary>
    EmailDelivery = 0,

    /// <summary>
    /// The IDENTICAL PNGs inline as data: URIs in the HTML (fine in a browser
    /// iframe, dead in mail clients); InlineImages stays empty, Csv is skipped.
    /// </summary>
    Preview = 1,
}

/// <summary>The composed email: subject + body, the optional CSV text, and any cid images.</summary>
public sealed record ComposedSnapshot(
    string Subject,
    string Html,
    string? Csv,
    IReadOnlyList<RcdEmailAttachment> InlineImages);

/// <summary>
/// The ONE render path behind subscription emails (EMAIL-CONTENT-DESIGN):
/// parse the layout → impersonate the subscription owner → run every tile →
/// render per the content config. SubscriptionDispatcher and the preview
/// endpoints both call it, so a preview can never drift from what ships.
/// Scoped like the dispatcher's per-dispatch dependencies; the injected
/// provider must be the scope the DbContext/query pipeline lives in.
/// </summary>
public sealed class SnapshotComposer(
    IServiceProvider services,
    TimeProvider timeProvider,
    ReconDashboardsOptions options,
    IChartImageRenderer imageRenderer,
    ILogger<SnapshotComposer> logger)
{
    private readonly TimeZoneInfo _stampZone = ResolveZoneOrUtc(options.ScheduleTimeZoneId);

    private static TimeZoneInfo ResolveZoneOrUtc(string zoneId)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(zoneId);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            // Same fallback the evaluator/dispatcher apply — stamps read UTC.
            return TimeZoneInfo.Utc;
        }
    }

    /// <summary>
    /// Composes the snapshot email for a dashboard under the OWNER's
    /// impersonated identity (row filters, model visibility, audit — exactly
    /// like dispatch). <paramref name="content"/> null = legacy behavior:
    /// tables only, the historical 50-row cap, byte-identical output.
    /// </summary>
    public async Task<ComposedSnapshot> ComposeAsync(
        DashboardRecord dashboard,
        int modelId,
        string ownerUserId,
        SubscriptionFormat format,
        SubscriptionContentConfig? content,
        SnapshotMode mode,
        CancellationToken ct)
    {
        var pages = LayoutSnapshotParser.Parse(dashboard.LayoutJson, modelId);

        // excludedTileIds drop tiles from the email ENTIRELY — body, CSV, and
        // the query work behind them.
        if (content is { ExcludedTileIds.Count: > 0 })
        {
            var excluded = content.ExcludedTileIds.ToHashSet(StringComparer.Ordinal);
            pages = pages
                .Select(p => new SnapshotPage(
                    p.Name, p.Tiles.Where(t => !excluded.Contains(t.TileId)).ToArray()))
                .ToArray();
        }

        var queryService = ImpersonatedQuery.Create(services, ownerUserId);
        var principal = ImpersonatedQuery.PrincipalFor(ownerUserId);
        var nowUtc = timeProvider.GetUtcNow().UtcDateTime;

        var rendered = new List<RenderedPage>();
        foreach (var page in pages)
        {
            var tiles = new List<RenderedTile>();
            foreach (var tile in page.Tiles)
            {
                var outcome = await queryService.RunAsync(tile.Spec, principal, ct);
                tiles.Add(outcome.Succeeded
                    ? new RenderedTile(tile, outcome.Value!.Compiled.Columns, outcome.Value.Rows, Error: null)
                    : new RenderedTile(tile, [], [], outcome.Error!.Message));
            }

            rendered.Add(new RenderedPage(page.Name, tiles));
        }

        var subject = $"{dashboard.Name} — dashboard snapshot";
        var maxTableRows = content?.MaxTableRows ?? SnapshotRenderer.HtmlRowsPerTile;

        string html;
        var inlineImages = new List<RcdEmailAttachment>();
        if (content is null || content.Body == SubscriptionContentBody.Tables)
        {
            html = SnapshotRenderer.RenderHtml(
                dashboard.Name, nowUtc, rendered, _stampZone, options.ScheduleTimeZoneLabel, maxTableRows);
        }
        else
        {
            var imageWidth = content.ImageWidth;
            var includeTables = content.Body == SubscriptionContentBody.Both;
            html = SnapshotRenderer.RenderHtml(
                dashboard.Name, nowUtc, rendered, _stampZone, options.ScheduleTimeZoneLabel,
                (builder, tile, pageIndex, tileIndex) => AppendContentTileBody(
                    builder, tile, pageIndex, tileIndex, imageWidth, maxTableRows,
                    includeTables, mode, inlineImages));
        }

        // CSV stays additive exactly as before, in every body mode; a preview
        // never attaches anything, so the work is skipped there.
        var csv = format == SubscriptionFormat.Csv && mode == SnapshotMode.EmailDelivery
            ? SnapshotRenderer.RenderCsv(
                dashboard.Name, nowUtc, rendered, _stampZone, options.ScheduleTimeZoneLabel)
            : null;

        return new ComposedSnapshot(subject, html, csv, inlineImages);
    }

    /// <summary>
    /// Per-tile body for charts/both modes. The tile rules are pinned
    /// (EMAIL-CONTENT-DESIGN): errors keep the red note; kpi BY TYPE and the
    /// shape-triggered KPI branch keep the HTML KPI block; table tiles keep
    /// the HTML table; the ten visual families become a PNG (+ table in
    /// 'both'); anything unrecognized degrades to the table.
    /// </summary>
    private void AppendContentTileBody(
        StringBuilder html, RenderedTile tile, int pageIndex, int tileIndex,
        int imageWidth, int maxTableRows, bool includeTables, SnapshotMode mode,
        List<RcdEmailAttachment> inlineImages)
    {
        if (tile.Error is not null)
        {
            SnapshotRenderer.AppendErrorNote(html, tile.Error);
            return;
        }

        var type = tile.Tile.ChartType;
        if (type == "kpi" || SnapshotRenderer.HasKpiShape(tile))
        {
            SnapshotRenderer.AppendKpiBlock(html, tile);
            return;
        }

        if (type == "table" || !ChartLayoutEngine.IsVisual(type))
        {
            SnapshotRenderer.AppendTable(html, tile, maxTableRows);
            return;
        }

        byte[] png;
        try
        {
            png = imageRenderer.RenderPng(ChartLayoutEngine.Build(tile, imageWidth));
        }
        catch (Exception ex)
        {
            // A drawing failure downgrades ONE tile to its table — the 6 a.m.
            // email still ships with all its data.
            logger.LogError(
                ex, "Chart image render failed for tile {TileId} ({ChartType}); falling back to its table",
                tile.Tile.TileId, type);
            SnapshotRenderer.AppendTable(html, tile, maxTableRows);
            return;
        }

        string src;
        if (mode == SnapshotMode.Preview)
        {
            src = "data:image/png;base64," + Convert.ToBase64String(png);
        }
        else
        {
            var contentId = $"tile-{pageIndex}-{tileIndex}@rcd";
            inlineImages.Add(new RcdEmailAttachment(
                $"tile-{pageIndex}-{tileIndex}.png", "image/png",
                Bytes: png, ContentId: contentId, Inline: true));
            src = "cid:" + contentId;
        }

        html.Append("<img src=\"").Append(src)
            .Append("\" width=\"").Append(imageWidth)
            .Append("\" alt=\"").Append(WebUtility.HtmlEncode(tile.Tile.Title))
            .Append("\" style=\"width:100%;max-width:").Append(imageWidth)
            .Append("px;height:auto;display:block\">");

        // A panel grid cannot be read at this width, so the panels are combined
        // into one chart — and the reader is TOLD, rather than shown a chart
        // that silently collapsed rows on top of each other.
        if (ChartLayoutEngine.DescribeSmallMultiples(tile) is { } note)
        {
            html.Append("<div style=\"font-size:11px;color:#6b7280;margin-top:4px;\">Small multiples (")
                .Append(note.PanelCount).Append(" panels by ")
                .Append(WebUtility.HtmlEncode(note.Dimension))
                .Append(") are combined in this email.</div>");
        }

        if (includeTables && !SnapshotRenderer.HasKpiShape(tile))
        {
            html.Append("<div style=\"height:8px;\"></div>");
            SnapshotRenderer.AppendTable(html, tile, maxTableRows);
        }
    }
}
