# Subscription Email Content — Design Contract

Goal: subscription emails deliver **charts as images** instead of (or alongside) the
hard-to-digest HTML tables, with a per-subscription content configuration and an
in-app **preview of exactly what will be sent**.

## Why the current emails are tables

`SnapshotRenderer` never consults the chart type — `SnapshotTile.ChartType` is parsed and then
ignored, so a pie, a line chart and a table all emit the identical `<table>`. The KPI look is
triggered by result *shape* (0 dimensions, ≤1 row), not by `type == "kpi"`.

## Delivery format decision: PNG via cid inline attachments

- **Inline SVG is dead in email.** Microsoft retired inline SVG in Outlook Web and completed the
  rollout for Outlook for Windows (late 2025); classic Outlook for Windows never supported it;
  Gmail strips it. Only Apple Mail/Thunderbird render it. The audience here is corporate
  Outlook/O365 — SVG in the body is a non-starter.
- **`data:` URIs in `<img>`** are stripped by both Gmail and Outlook. Non-starter.
- **Hosted image URLs** would sit behind Cloudflare Access (the tracker's `PublicBaseUrl` is the
  Access-gated tunnel origin) and render as broken images for anyone not logged in — the open
  pixel already documents this limitation. Rejected for chart bodies.
- **cid inline attachments** work in Outlook (both renderers), Gmail, and Apple Mail, need no
  public endpoint, and both tracker transports (Mailtrap send API: `disposition:"inline"` +
  `content_id`; MailKit SMTP: `BodyBuilder.LinkedResources`) support them. **Chosen.**

## Server-side rendering: pure C# geometry + SkiaSharp raster

There is no browser at send time — subscriptions dispatch from a 1-minute background ticker in
the ASP.NET container, and the frontend's `chartImage.ts` rasterizers require the *live mounted
recharts DOM with resolved CSS variables*, so they are unreachable by construction. A headless
browser was rejected (hundreds of MB in the image, a browser inside the request-serving process,
Cloudflare Access in the loop — many new failure modes for a 6 a.m. email).

Chosen pipeline, all in `ReconDashboards.Core`:

1. **`ChartLayoutEngine`** — pure C#: query results + parsed `ChartFormatDoc` → geometry data
   (bars, arcs, polylines, ticks, label boxes, legend rows). Heavily unit-tested as plain data;
   no drawing dependency.
2. **SkiaSharp painter** — thin layer painting geometry to PNG at **2× scale** (`SkiaSharp` +
   `SkiaSharp.NativeAssets.Linux.NoDependencies`). Fonts are loaded by file path
   (Liberation/DejaVu/Arial candidates) with `SKTypeface.Default` fallback — **no fontconfig
   dependency**; the tracker image installs `fonts-liberation`.
3. **Fidelity ports** from the frontend so the email chart matches the screen: theme palettes
   (`CHART_THEMES` + the print view's hardcoded light-token map for the `default` theme),
   Excel-style number/date pattern formatting (`formatNumberPattern`/`formatDatePattern`
   semantics), category/series ordering reconciliation, and data-label composition rules.

`LayoutSnapshotParser` gains a `ChartFormatDoc` so `chart.format` survives parsing (it is already
persisted in `LayoutJson`; the parser's private DTOs simply dropped it — **no migration, no
layout-format change**). Consumed v1: theme, colorOverrides, showLegend, legendPosition,
showDataLabels, dataLabelContent, valueFormat, x/y axis labels, seriesLabels, categoryOrder,
seriesOrder, gridX/gridY. Explicitly deferred: referenceLines, trendlines, conditionalFormats.

Family rules: column/bar/stacked*/line/area/pie/donut/scatter/gantt → PNG. **KPI stays the HTML
KPI block in every mode** (it reads well in email), **table stays an HTML table**, error tiles
keep the red note. The shape-triggered KPI branch is preserved.

## Content configuration

New nullable **`ContentJson`** column on `rcd_subscriptions` (jsonb on Postgres via the
provider-aware column-type hook; `NULL` = legacy behavior, no backfill). Wire shape (camelCase):

```json
{ "body": "tables" | "charts" | "both",
  "excludedTileIds": ["..."],
  "imageWidth": 480 | 600 | 900,
  "maxTableRows": 50 }
```

- `tables` — legacy renderer output (and the default when the column is NULL).
- `charts` — visual tiles become cid PNG images; tables suppressed for those tiles. Side
  benefit: body HTML shrinks well below Gmail's ~102 KB clipping threshold that busy dashboards
  plausibly hit today.
- `both` — image followed by that tile's table.
- CSV format remains additive exactly as before in every mode.
- New subscriptions default to `charts`; editing a legacy subscription writes an explicit
  `tables` config (identical semantics).

Validation lives beside the existing `Format` check in `SubscriptionService.Validate`.

## One render path: `SnapshotComposer`

The dispatcher's render block (parse → impersonate owner → run tiles → render) is extracted into
`SnapshotComposer`, returning `{ Subject, Html, Csv?, InlineImages[] }`. **The dispatcher and the
preview endpoint both call it**, so the preview can never drift from what actually ships. Preview
mode inlines the identical PNGs as `data:` URIs (fine in a browser iframe, just not in email);
delivery mode emits them as cid attachments (`tile-{page}-{tile}@rcd`).

## Preview endpoints

- `POST {prefix}/v1/subscriptions/{id}/preview` — optional `{ content }` override; auth mirrors
  subscription edit access; renders under the **subscription owner's** impersonated principal so
  an admin preview honors the owner's row filters rather than lying.
- `POST {prefix}/v1/dashboards/{dashboardId}/subscriptions/preview` — unsaved draft
  (`{ format?, content? }`), owner = caller, ViewPolicy + dashboard access.

Both return `{ subject, html }`; no state change, no dispatch row, no email. The UI shows the
result in a sandboxed iframe labeled as approximate — an iframe is a real browser and will always
look somewhat better than Outlook.

## Attachment plumbing (binary channel)

`RcdEmailAttachment` gains `Bytes`/`ContentId`/`Inline` alongside the legacy string `Content`
(senders resolve `Bytes ?? UTF8(Content)`). The library's `SmtpEmailSender` and `FileEmailSink`
honor inline semantics; host adapters map them onto their own transports (the tracker adds
`ContentId`/`IsInline` to `MailAttachmentData`, `content_id` + `disposition` on the Mailtrap API
path, and `LinkedResources` on the MailKit SMTP path). Size reality: ~15–40 KB per 600×360 PNG,
+33 % base64 on the API path — hundreds of KB per message worst case, held briefly per failed
recipient by the dispatcher's in-memory retry queue. Acceptable and stated here on purpose.

## Edit surface

`SubscriptionForm` is the single editing component (rendered by both the per-dashboard dialog
and the manager's editor) — the "Email content" section lands there once: body mode select,
image width (Compact 480 / Standard 600 / Wide 900), max table rows, a collapsible per-tile
include checklist (from the loaded dashboard doc; the manager fetches it, and hides the checklist
with a note if it can't), and a Preview button. The manager also gets a Preview action beside
Send now.
