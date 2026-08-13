# Wave 20 (0.9.0) — chart performance, validation, field list, copy, bug fixes

Contract for two parallel implementers: **A = dashboards-core + backend**,
**B = dashboards-ui + portal**. B codes against the core APIs specified here;
A implements them exactly. Update this file if implementation forces a change.

## A1. QueryCache: eviction + concurrency scheduler (state/queryCache.ts)

New options threaded from `createDashboardsRuntime(baseUrl, fetcher, options?)`
and a matching optional `queryOptions` prop on `DashboardsProvider`:

```ts
export interface QueryCacheOptions {
  queryTtlMs?: number;      // default 180_000 (was hardcoded 60_000)
  distinctTtlMs?: number;   // default 300_000 (unchanged)
  maxEntries?: number;      // default 300
  maxConcurrent?: number;   // default 6
}
// As implemented (A): the runtime third arg wraps the cache options so future
// non-cache knobs have a home; DashboardsProvider's `queryOptions` prop maps
// onto options.queryOptions. `new QueryCache(api, options?)` takes the cache
// options directly.
export interface DashboardsRuntimeOptions { queryOptions?: QueryCacheOptions; }
export function createDashboardsRuntime(
  baseUrl: string, fetcher: RcdFetcher, options?: DashboardsRuntimeOptions): DashboardsRuntime;
```

- **Scheduler**: `run()` and `distinct()` share one FIFO semaphore capped at
  `maxConcurrent` actual HTTP requests. Cache hits and in-flight joins bypass
  the queue entirely. This is what stops a 36-tile page from bursting the
  server (60/min token bucket, QueueLimit=0 → 429s) and the shared DO cluster.
- **Eviction**: on entry insert, if `entries` exceeds `maxEntries`, delete the
  oldest-`fetchedAt` non-loading entries down to the cap; also drop any entry
  older than 10× TTL opportunistically. `distinctResults` gets the same cap.
- Preserve existing semantics: fresh-'ok' short-circuit, stale-'ok' renders
  while refetching, error entries refetch on next effect run, abort NOT
  forwarded to fetch, `invalidateAll()`, targeted per-key deletes.

## A2. Client-side chart validator (new core module `validation/chartValidation.ts`)

```ts
export interface ChartIssue {
  severity: 'error' | 'warning';
  code: string;               // mirrors server: 'disconnected', 'unknown_column', ...
  message: string;            // actionable, same tone as server messages
  well?: 'axis'|'drill'|'legend'|'smallMultiples'|'values'|'filters'|'sort';
}
export function validateChartSpec(
  spec: ChartSpec, model: ModelDefinition, catalog: Catalog | null): ChartIssue[];
```

Errors (block save): unknown table / column (model⋈catalog by tableKey; skip
column-existence checks while catalog is null), unknown measureId, unknown
date-table ref, non-queryable column type in a well, `dateBucket` on a
non-temporal column, aggregation/type mismatch (mirror the backend's
QueryCompiler/SpecValueConverter rules — READ them, don't guess: e.g. sum/avg
need numeric; count/countDistinct anything), join reachability: BFS over
ACTIVE `model.relationships` from the set of involved tables — disconnected
pairs produce the server's own wording ("… is not connected … add a
relationship between them on the model canvas"), stale sort/having index
targets, authored-count limit overruns (dims>8 incl. axis+legend+SM+drill,
measures>16, filters>32).
Warnings (allow save): ambiguous equal-shortest join paths, chart-type well
completeness (scatter with <2 measures, gantt missing start/end, KPI with a
legend), >MaxRows-risk topN missing on very-high-cardinality axis (skip if
not cheaply knowable). Export the module + types from the core index.

## A3. Chart clipboard + cross-dashboard copy (dashboardStore.ts)

Transient state: `chartClipboard: { chart: ChartSpec; sourceModelId: number | null } | null`.
Methods:
- `copyChart(chart, sourceModelId)` — set clipboard (never persisted).
- `pasteChartTile()` — edit mode only; appends a tile to the active page at
  maxY (duplicateTile's layout/id/title-"(copy)" conventions).
- `copyChartToDashboard(targetId, chart, sourceModelId): Promise<void>` —
  if `targetId === current.id`: in-store append (dirty, honors edit session);
  else server round-trip: `getDashboard` → append tile to the FIRST page
  (legacy doc with no pages: append to top-level tiles) → `updateDashboard`
  with `expectedUpdatedAtUtc`; on `rcd.dashboard.stale` refetch and retry
  ONCE; surface other errors via rcdErrorMessage. Model mismatch handling is
  the UI's concern (dialog warns); the store method just copies.

## A4. UTC-safe date handling (core util/format.ts) — bug findings 2, 3, 4

- Parse ISO date-only strings ("YYYY-MM-DD") and naive timestamps
  ("YYYY-MM-DDTHH:mm:ss", no zone) as CALENDAR PARTS; all presets
  (dateFormat/monthFormat/yearFormat/isoDate/…) format from parts — never
  route a date-only value through local-zone `new Date(iso)` getters.
- `formatDatePattern(date, pattern, opts?: { utc?: boolean })` — utc:true uses
  getUTC* getters. (B applies it to the Gantt axis, which is UTC-gridded.)

## A5. Store bug fixes (dashboardStore.ts) — findings 7, 8, 10

- **7**: bookmark add/rename/delete/update while `mode === 'view'` must
  auto-persist: run the mutation then immediately `save()`; on failure surface
  the store error and revert the doc mutation. (Edit mode unchanged — saved
  with the draft.)
- **8**: `discardEdits` restores the draft backup but KEEPS the live
  `expectedUpdatedAtUtc` and `isShared` (setPublish may have advanced them).
- **10**: `applyBookmark` while `mode === 'edit'` must NOT install
  `filterCardOverrides` (apply slicers/cross-filters as usual; card
  enable/disable applies to the doc instead or is skipped — match enterEdit's
  "edit shows the authored doc" rule).

## A6. Backend fixes — findings 5, 17, 9

- **5** (QueryCompiler): with `hasCalc`, the `__rcd_base` CTE must contain
  EXACTLY n rows (window calcs like PERCENTOFTOTAL/runningTotal must not see
  the +1 probe row); keep a correct truncation signal (probe on the outer
  select or a separate EXISTS). Fix the XML doc. Regression tests: top-5 +
  percentOfTotal sums to 100; truncated flag correct both sides of the edge.
- **17**: `EmitTopN(includeOthers)` must return `RowLimit` so the +1 probe is
  trimmed like the non-Others path.
- **9** (DashboardLayoutDiffer + service): add/remove/edit of **text, image,
  and slicer** tiles classify as `LayoutChanged` (not `ChartsChanged`);
  chart-kind tiles keep `ChartsChanged`. Update differ tests + the permission
  mapping tests; INTEGRATION.md permission table wording if it mentions this.

## A7. Frontend test infrastructure (dashboards-core)

Add **vitest** to dashboards-core (`npm run test`), wired into the root build
script chain. Required suites: queryCache (TTL reuse, LRU eviction, scheduler
cap + FIFO under a mocked api, in-flight dedupe), chartValidation (each error
class + a clean spec), dashboardStore regressions (findings 7/8/10 semantics,
clipboard/paste/copyChartToDashboard with a mocked api incl. the stale retry),
format date parsing (date-only, naive timestamp, utc pattern mode).

## B1. FieldList reorganization (chart-builder/FieldList.tsx)

Rebuild in the SchemaExplorer idiom (data-pane/SchemaExplorer.tsx is the
reference — same chevron/expand rows, same search behavior):
- Search input at top filtering tables AND columns; column-only matches
  auto-expand their table (SchemaExplorer's `nameMatched` logic).
- Collapsible per-table sections (chevron + friendlyName ?? name), collapsed
  state kept in component state (default: all expanded when ≤3 tables, else
  first expanded); type icons per column (reuse ColumnTypeIcon), keep
  friendlyName/hidden overrides, keep isQueryableType filtering.
- Date tables, Measures, Parameters become collapsible sections too; measures
  additionally group into folders by `Measure.displayFolder` (backslash-
  separated path, e.g. "Finance\\Core"; measures without a folder list at the
  section root).
- PRESERVE exactly: dnd payloads/ids, click-to-add + the 250 ms post-drag
  swallow, funnel (add-filter) affordances, the three catalog-missing states.
  Disclosure buttons must not become draggables.

## B2. Builder validation + actionable errors

- Run `validateChartSpec(draft, model, catalog)` (memoized) in ChartBuilder;
  render an issues strip above the preview: errors (red) + warnings (amber),
  each with its message; Save disabled while errors exist, title lists them.
- ChartTile error card: map `entry.errorCode` to actionable text + optional
  hint line (new map covering rcd.query.disconnected / ambiguous_path /
  unknown_table / unknown_column / unknown_measure / bad_measure / bad_bucket /
  bad_column / bad_sort / too_many_* / model_drift / execution_failed /
  denied_by_scope; fall back to entry.error). model_drift text: "The model no
  longer matches the database. Open the model editor to repair it."
- 429 (rate-limited) responses should read "Too many chart queries at once —
  retrying may succeed" rather than raw text, if the errorCode/status is
  distinguishable.

## B3. Copy chart UX

- View-mode chart menu (the `tileMenu` PointContextMenu instance) gains
  "Copy chart to…" — available to EVERYONE who can view, including built-in
  dashboards (that's the point: built-ins are cloneable per chart).
- Edit-mode ChartContextMenu gains "Copy chart to…" and "Copy" (clipboard);
  edit-mode canvas/page gains "Paste chart" (toolbar Add ▾ or context menu)
  enabled when `chartClipboard` non-null.
- New `CopyChartDialog`: lists writable target dashboards from the store list
  (ownerIsMe or myAccess.canEditCharts, non-system, excluding none), marks the
  current dashboard as "(this dashboard)", warns inline when
  `target.modelId !== sourceModelId` ("built on a different model — fields may
  not resolve"), calls `copyChartToDashboard`, success state names the target.
- The copied spec is the AUTHORED tile spec (`tile.chart`), not the drilled/
  filtered effective spec.

## B4. UI bug fixes — findings 1, 4, 6, 11, 12, 13, 14, 15, 16, 18

- **1** (chartData.ts): key `byAxis` (and small-multiple panels) on the RAW
  axis cell value, carrying the formatted label as a display field — colliding
  labels must not merge/overwrite rows.
- **4** (GanttChart): format axis tick labels with `formatDatePattern(...,
  { utc: true })`; remove the toISOString round-trip at ~:546.
- **6** (DashboardChartTile): paging must respect the authored Top-N —
  effective limit `min(pageSize, authoredLimit)`, offset walk bounded by
  authoredLimit, count companion capped at authoredLimit.
- **11** (relativeDate.ts): clamp day-of-month before month arithmetic
  (min(day, daysInMonth(target))).
- **12** (chartData.ts + scatter): derive dimension ordinals from the
  compacted `[axis, legend, smallMultiples].filter(Boolean)` order — a chart
  with legend and no axis must not use the legend as the category axis.
- **13** (ShareDialog): perform the publish flip FIRST, then saveShares; on
  partial failure state exactly what saved and refresh rows.
- **14** (ActivityPanel): page-fetch errors render inline below the kept list;
  Retry re-requests the failed page (passes beforeId); add a request-id /
  cancelled guard so a stale response can't populate after dashboardId change.
- **15** (DashboardView): in edit mode without canEditCharts, fall back to the
  view-mode point/chart menus so See data / export / drill stay reachable.
- **16** (ShareDialog): sequence-guard the directory search; drop the
  duplicate unfiltered fetch after mount.
- **18**: blob downloads — append anchor to document, click, remove, defer
  revokeObjectURL a tick (DashboardView, SeeDataDialog, xlsx.ts is core BUT
  leave it to B via a shared helper in dashboards-ui if touching core is
  avoidable; otherwise coordinate: put `downloadBlob(name, blob)` in
  dashboards-ui/src/util and use it at the three UI call sites; xlsx.ts core
  path may stay as-is this wave).

## B5. Portal tidy

portal/package.json version → 0.9.0 and deps → `^0.9.0` (they were stale at
^0.1.0; workspace resolution masked it).

## Versioning / build

0.9.0 everywhere: both package.jsons + RCD_CORE_VERSION / RCD_UI_VERSION (B for
ui, A for core), backend Directory.Build.props (A). No wire-format changes; no
DB migration this wave. Full builds must pass: backend solution + tests,
`npm run build` (core → ui → portal), core vitest suite.
