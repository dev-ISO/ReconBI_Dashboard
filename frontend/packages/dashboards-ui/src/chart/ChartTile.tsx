import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { AlertTriangle, BarChart3, RefreshCw, Sigma } from 'lucide-react';
import {
  chartMeasureDefinitions,
  isRunnable,
  toWireSpec,
  type CellValue,
  type ChartPointEvent,
  type ChartQuerySpec,
  type ChartSpec,
  type FilterClause,
  type Measure,
  type MeasureFailure,
  type QueryResult,
} from '@recon/dashboards-core';
import { useDashboardState, useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton } from '../primitives';
import { ChartLoadingSkeleton, TileUpdatingBar } from '../dashboard/ChartLoadingSkeleton';
import { queryErrorTextFor } from './queryErrorText';
// Type-only import: erased at compile time, so the lazy chunk split survives.
import type { ChartDatumClickInfo, ChartRendererProps } from './ChartRenderer';

/** Payload of a legend cross-filter selection (agreed renderer contract). */
export interface ChartLegendSelectEvent {
  /** RAW (pre-format) legend cell value of the clicked item; null = blank. */
  raw: CellValue;
  /** Formatted legend label of the clicked item. */
  label: string;
}

/** Column sort state the interactive table renders/reports. */
export interface ChartTableSort {
  /** Result column NAME. */
  column: string;
  direction: 'asc' | 'desc';
}

/** Persistable table layout tweak reported by the renderer (drag/resize). */
export interface ChartTableLayoutPatch {
  /** Only the column(s) a resize touched, px — consumers must DEEP-merge
   *  this map over the stored one (a shallow spread drops other columns). */
  columnWidths?: Record<string, number>;
  columnOrder?: string[];
  /** Viewer's rows-per-page pick from the pager (0 = "All"/unpaged). */
  pageSize?: number;
}

/**
 * One Excel-style per-column header filter on the interactive table (agreed
 * renderer contract; keyed by result column NAME). 'values' keeps rows whose
 * cell is one of the checked values; 'condition' applies one comparison.
 */
export type TableColumnFilter = { column: string } & (
  | { kind: 'values'; values: CellValue[] }
  | {
      kind: 'condition';
      operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'contains' | 'startsWith';
      values: (string | number)[];
    }
);

/** Wire HAVING entries (post-aggregation measure conditions). */
export type ChartHavingClause = NonNullable<ChartQuerySpec['having']>[number];

/**
 * Point/legend/table handlers the renderer exposes (agreed contract; typed
 * here so this file compiles against it regardless of when the renderer props
 * land — once ChartRendererProps carries them the intersection below is a
 * no-op). The existing onDatumClick cross-filter callback keeps firing
 * alongside.
 */
interface RendererPointHandlers {
  onPointClick?: (e: ChartPointEvent) => void;
  onPointContextMenu?: (e: ChartPointEvent) => void;
  /** Legend click in legendMode 'crossFilter'; null = clear the selection. */
  onLegendSelect?: (e: ChartLegendSelectEvent | null) => void;
  /** Active legend selection passed back for persistent emphasis. */
  selectedLegendLabel?: string | null;
  /** Hover cross-highlight source hook; null = pointer left the datum. */
  onPointHover?: (e: ChartPointEvent | null) => void;
  /** Set while ANOTHER tile hovers a matching category (dims non-matches). */
  highlightCategory?: { label: string } | null;
  /**
   * Echo of THIS chart's own cross-filter source state (format.selectionHighlight):
   * the clicked category and/or legend value stay marked while the page-wide
   * filter is live. Null = this chart is not the source.
   */
  selection?: { category?: string | null; legendValue?: string | null } | null;
  /**
   * Date-axis drag selection (format.zoom.dragAction === 'crossFilter'): the
   * RAW endpoints of the dragged range, for the consumer to turn into a
   * page-wide cross-filter.
   */
  onAxisRangeSelect?: (range: { fromRaw: unknown; toRaw: unknown }) => void;
  /* ----- interactive table (format.table) ----- */
  tableSort?: ChartTableSort | null;
  onTableSortChange?: (sort: ChartTableSort | null) => void;
  /** 0-based page (server-side offset pagination). */
  tablePage?: number;
  /** Known page count; null while unknown (› disabled on a short page). */
  tablePageCount?: number | null;
  onTablePageChange?: (page: number) => void;
  /** Total row count over the full filtered result; null = unknown. */
  tableTotalRows?: number | null;
  /** Totals row aligned to measure columns (dates ride as ISO strings); null = none. */
  totalsRow?: (CellValue | null)[] | null;
  /** Column drag/resize report (persist or keep transient — caller's call). */
  onTableLayoutChange?: (patch: ChartTableLayoutPatch) => void;
  /** Active per-column header filters + change hook (format.table.filterable). */
  tableFilters?: TableColumnFilter[];
  onTableFilterChange?: (filters: TableColumnFilter[]) => void;
  /** Distinct values for a column's filter menu (Excel semantics upstream). */
  onRequestColumnValues?: (column: string) => Promise<CellValue[]>;
}

const ChartRenderer = lazy(() => import('./ChartRenderer')) as ComponentType<
  ChartRendererProps & RendererPointHandlers
>;

export interface ChartTileProps {
  spec: ChartSpec;
  modelId: number;
  /** Dashboard-level filters (slicers + cross-filter) merged into the chart's own. */
  filters?: FilterClause[];
  /**
   * Row offset merged into the wire spec (applied after sort, before limit) —
   * server-side table pagination. Part of the cache key like everything else.
   */
  offset?: number | null;
  /**
   * Post-aggregation measure conditions merged into the wire spec (SQL
   * HAVING) — table measure-column filters. Cache-keyed like offset.
   */
  having?: ChartHavingClause[] | null;
  /** Debounce before running (builder preview); 0 for tiles. */
  debounceMs?: number;
  /**
   * Opaque refresh token: a CHANGE forces a refetch of the current cache key
   * (the dashboard deletes the entry, then bumps this). String-keyed like the
   * cache key itself — never an object identity.
   */
  refreshKey?: string;
  /** Cross-filter click pass-through (see ChartRendererProps.onDatumClick). */
  onDatumClick?: (info: ChartDatumClickInfo) => void;
  /** Point-level click pass-through (drill-down; fires alongside onDatumClick). */
  onPointClick?: (e: ChartPointEvent) => void;
  /** Point-level right-click pass-through (drillthrough/export menu). */
  onPointContextMenu?: (e: ChartPointEvent) => void;
  /** Legend cross-filter pass-through (legendMode 'crossFilter'; null = clear). */
  onLegendSelect?: (e: ChartLegendSelectEvent | null) => void;
  /** Active legend selection (persistent emphasis on the source chart). */
  selectedLegendLabel?: string | null;
  /** Set while this tile is the active cross-filter SOURCE (dims non-matches). */
  activeCategory?: { label: string } | null;
  /** Hover cross-highlight pass-through (source side; null = unhover). */
  onPointHover?: (e: ChartPointEvent | null) => void;
  /** Set while ANOTHER tile's hover matches this chart's category dimension. */
  highlightCategory?: { label: string } | null;
  /** This tile's own cross-filter source selection (renderer marks/dims it). */
  selection?: { category?: string | null; legendValue?: string | null } | null;
  /** Date-axis drag range (format.zoom.dragAction 'crossFilter') pass-through. */
  onAxisRangeSelect?: (range: { fromRaw: unknown; toRaw: unknown }) => void;
  /** Interactive-table sort state + change hook (format.table charts). */
  tableSort?: ChartTableSort | null;
  onTableSortChange?: (sort: ChartTableSort | null) => void;
  /** Interactive-table 0-based page + known page count (null = unknown). */
  tablePage?: number;
  tablePageCount?: number | null;
  onTablePageChange?: (page: number) => void;
  /**
   * Total row count over the full filtered result (the dashboard tile's lazy
   * companion count query); null = unknown -> the pager degrades to "Page X".
   */
  tableTotalRows?: number | null;
  /** Totals row aligned to measure columns (companion no-dimension query;
   *  CellValue so date totals survive to the cell formatter). */
  totalsRow?: (CellValue | null)[] | null;
  /** Column width/order drag report (persist or transient — caller's call). */
  onTableLayoutChange?: (patch: ChartTableLayoutPatch) => void;
  /** Per-column header filter state + change hook (interactive tables). */
  tableFilters?: TableColumnFilter[];
  onTableFilterChange?: (filters: TableColumnFilter[]) => void;
  /** Distinct values for a column's filter dropdown (caller applies Excel
   *  minus-own-filter semantics). */
  onRequestColumnValues?: (column: string) => Promise<CellValue[]>;
  /**
   * Ref-style report of the freshest rendered QueryResult (assignment only —
   * mirrors reportEffective). The dashboard tile uses it to map table sort
   * column names onto wire dimension/measure indices and to derive page count.
   */
  onResult?: (result: QueryResult) => void;
  /**
   * Offered next to the per-measure failure notice (D3). Absent = the notice
   * still names the broken measure, it just has no shortcut — a viewer with no
   * authoring rights, or a surface with nowhere to open an editor.
   */
  onEditMeasure?: (failure: MeasureFailure) => void;
}

const EMPTY_FILTERS: FilterClause[] = [];

/**
 * Runs a chart spec through the shared query cache and renders exactly one of:
 * configure hint / type-aware skeleton (first load) / previous chart dimmed
 * under an updating bar (refetch) / error+retry / empty / the chart.
 *
 * The fetch effect is keyed on the CACHE KEY STRING (+ the refreshKey token
 * string), not object identities — fresh-but-equal spec/filters arrays must
 * never re-trigger requests (an identity-keyed effect here once produced an
 * abort/retry loop that drained the server's rate-limit bucket).
 */
export function ChartTile({
  spec,
  modelId,
  filters = EMPTY_FILTERS,
  offset = null,
  having = null,
  debounceMs = 0,
  refreshKey,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  onLegendSelect,
  selectedLegendLabel = null,
  activeCategory = null,
  onPointHover,
  highlightCategory = null,
  selection = null,
  onAxisRangeSelect,
  tableSort = null,
  onTableSortChange,
  tablePage = 0,
  tablePageCount = null,
  onTablePageChange,
  tableTotalRows = null,
  totalsRow = null,
  onTableLayoutChange,
  tableFilters,
  onTableFilterChange,
  onRequestColumnValues,
  onResult,
  onEditMeasure,
}: ChartTileProps) {
  const runtime = useRuntime();
  const runnable = isRunnable(spec);
  // Scoped (dashboard/personal) measure definitions are part of the query, so
  // they are subscribed to — editing a dashboard measure must change the cache
  // key and refetch, exactly like editing a filter would.
  const docMeasures = useDashboardState((state) => state.current?.layout.measures ?? null);
  const personalMeasures = useDashboardState((state) => state.personalMeasures);
  const wireSpec = useMemo(() => {
    if (!runnable) return null;
    const scoped: Measure[] = [...(docMeasures ?? []), ...personalMeasures];
    const base = toWireSpec(spec, modelId, filters, chartMeasureDefinitions(scoped, spec));
    // Offset and having ride the wire spec directly (ChartQuery carries
    // neither); both participate in the cache key like every other spec field.
    const withOffset = offset != null && offset > 0 ? { ...base, offset } : base;
    return having != null && having.length > 0 ? { ...withOffset, having } : withOffset;
  }, [spec, modelId, filters, offset, having, runnable, docMeasures, personalMeasures]);
  const cacheKey = wireSpec ? runtime.queries.keyFor(wireSpec) : null;
  const entry = useQueryCacheState((state) => (cacheKey ? state.entries[cacheKey] : undefined));
  const [retryToken, setRetryToken] = useState(0);
  const wireSpecRef = useRef(wireSpec);
  wireSpecRef.current = wireSpec;

  /**
   * Last successfully rendered result + the spec it belongs to. While a fetch
   * is in flight for a NEW cache key (filter change, drill, refresh) the old
   * chart stays visible — dimmed, with the updating bar — instead of blanking
   * to a skeleton. Spec and result are kept as a pair so the stale render is
   * always internally consistent.
   */
  const lastGoodRef = useRef<{ spec: ChartSpec; result: QueryResult } | null>(null);
  if (entry?.status === 'ok' && entry.data) {
    lastGoodRef.current = { spec, result: entry.data };
    // Assignment-only report (like wireSpecRef): the dashboard tile reads the
    // freshest result without extra renders or effect churn.
    onResult?.(entry.data);
  }

  /* ---- table pagination mechanics (format.table.pageSize charts only) ---- */

  const pageSize = spec.type === 'table' ? (spec.format.table?.pageSize ?? null) : null;
  const pagingActive = pageSize != null && pageSize > 0 && onTablePageChange !== undefined;
  const okRowCount = entry?.status === 'ok' && entry.data ? entry.data.rows.length : null;

  /**
   * Known page count. The caller's tablePageCount (companion count query) is
   * authoritative when present; otherwise a SHORT page (fewer rows than
   * pageSize) marks the last page — › disables — and a full page keeps it
   * unknown (null). Passes through unchanged when paging is off.
   */
  const derivedPageCount = pagingActive
    ? (tablePageCount ??
      (okRowCount !== null && okRowCount < pageSize ? tablePage + 1 : null))
    : tablePageCount;

  // Paging past the end (exactly-full last page + ›) lands on an empty page;
  // step back automatically so the user is never stranded on "No data".
  useEffect(() => {
    if (!pagingActive || okRowCount !== 0 || tablePage <= 0) return;
    onTablePageChange?.(tablePage - 1);
  }, [pagingActive, okRowCount, tablePage, onTablePageChange]);

  useEffect(() => {
    if (!cacheKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const current = wireSpecRef.current;
      if (!current) return;
      runtime.queries.run(current, controller.signal).catch(() => {
        // surfaced via the cache entry
      });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [runtime, cacheKey, debounceMs, retryToken, refreshKey]);

  if (!runnable) {
    return (
      <State icon={<BarChart3 size={22} className="text-rcd-muted" />}>
        {/* A table runs on Rows alone (measure-less passthrough list), so it
            asks for a row field instead of a measure. */}
        {spec.type === 'table' ? 'Add a row field to get started.' : 'Add a measure to get started.'}
      </State>
    );
  }

  const renderChart = (
    chartSpec: ChartSpec,
    result: QueryResult,
    updating: boolean,
  ) => (
    <div className="relative flex h-full w-full min-w-0 flex-col overflow-hidden">
      {updating && <TileUpdatingBar />}
      <MeasureFailureNotice
        failures={measureFailuresOf(result)}
        onEditMeasure={onEditMeasure}
      />
      <div
        className={`min-h-0 w-full flex-1 transition-opacity duration-150 ${
          updating ? 'opacity-60' : 'opacity-100'
        }`}
      >
        <Suspense fallback={<ChartLoadingSkeleton type={chartSpec.type} />}>
          <ChartRenderer
            spec={chartSpec}
            result={result}
            onDatumClick={onDatumClick}
            onPointClick={onPointClick}
            onPointContextMenu={onPointContextMenu}
            onLegendSelect={onLegendSelect}
            selectedLegendLabel={selectedLegendLabel}
            activeCategory={activeCategory}
            onPointHover={onPointHover}
            highlightCategory={highlightCategory}
            selection={selection}
            onAxisRangeSelect={onAxisRangeSelect}
            tableSort={tableSort}
            onTableSortChange={onTableSortChange}
            tablePage={tablePage}
            tablePageCount={derivedPageCount}
            onTablePageChange={onTablePageChange}
            tableTotalRows={tableTotalRows}
            totalsRow={totalsRow}
            onTableLayoutChange={onTableLayoutChange}
            tableFilters={tableFilters}
            onTableFilterChange={onTableFilterChange}
            onRequestColumnValues={onRequestColumnValues}
          />
        </Suspense>
      </div>
    </div>
  );

  if (!entry || entry.status === 'loading') {
    const stale = lastGoodRef.current;
    // Refetch with a previous result on hand: keep it rendered (dimmed) under
    // the updating bar — no blank-out, no layout shift.
    if (stale) return renderChart(stale.spec, stale.result, true);
    return <ChartLoadingSkeleton type={spec.type} />;
  }

  if (entry.status === 'error') {
    // Field-level server issue when the response carried one: its message is
    // the most precise thing we have, and the wire path names the exact field
    // (dimensions[1].column, measures[0].aggregation, …). Otherwise the
    // actionable text keyed on the server's rcd.query.* error code (falling
    // back to the raw message — server messages are contract-specified).
    const issue = entry.issues?.[0];
    const friendly = issue
      ? { message: issue.message, hint: issue.path ? `At ${issue.path}` : undefined }
      : queryErrorTextFor(entry.errorCode, entry.error ?? 'The chart query failed.');
    return (
      <State icon={<AlertTriangle size={20} className="text-rcd-muted" />}>
        <span className="max-w-full break-words text-xs text-rcd-text-2">{friendly.message}</span>
        {friendly.hint && (
          <span className="max-w-full break-words text-[11px] text-rcd-muted">{friendly.hint}</span>
        )}
        <RcdButton onClick={() => setRetryToken((t) => t + 1)}>
          <RefreshCw size={14} /> Retry
        </RcdButton>
      </State>
    );
  }

  const result: QueryResult = entry.data!;
  if (result.rows.length === 0) {
    // A table whose OWN column filters emptied it still renders (headers +
    // filter menus stay reachable so the user can clear the filter); every
    // other empty result shows the friendly empty state.
    const tableFiltersActive =
      spec.type === 'table' &&
      ((tableFilters?.length ?? 0) > 0 || (having?.length ?? 0) > 0);
    if (!tableFiltersActive) {
      const empty = (
        <State icon={<BarChart3 size={22} className="text-rcd-muted" />}>
          No data for this selection.
        </State>
      );
      // A broken measure can leave a result with no rows at all. The empty
      // state alone would then be a lie by omission — "no data" reads as "the
      // filters matched nothing", not "the formula did not compile".
      const failures = measureFailuresOf(result);
      if (failures.length === 0) return empty;
      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <MeasureFailureNotice failures={failures} onEditMeasure={onEditMeasure} />
          <div className="min-h-0 flex-1">{empty}</div>
        </div>
      );
    }
  }

  return renderChart(spec, result, false);
}

/** Per-measure compile failures the server contained; [] when there are none. */
const measureFailuresOf = (result: QueryResult): MeasureFailure[] =>
  result.meta.measureFailures ?? [];

/**
 * D3 — THE BLANK SERIES GETS A NAME.
 *
 * When the engine cannot compile one measure it substitutes a tombstone: every
 * other series renders, and the broken one comes back empty. Without this the
 * user sees a chart that is quietly missing a line and has no way to learn
 * which one, or why. The notice is non-modal and sits ABOVE the chart — the
 * data that DID come back is still the point of the tile, so it is never
 * covered or replaced.
 */
function MeasureFailureNotice({
  failures,
  onEditMeasure,
}: {
  failures: MeasureFailure[];
  onEditMeasure?: (failure: MeasureFailure) => void;
}) {
  if (failures.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Measure errors"
      data-testid="rcd-measure-failures"
      className="mb-1 flex shrink-0 flex-col gap-0.5 rounded-md border border-[color-mix(in_srgb,var(--rcd-status-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--rcd-status-warn)_10%,transparent)] px-2 py-1"
    >
      {failures.map((failure) => (
        <div key={failure.index} className="flex items-start gap-1.5 text-[11px] leading-snug">
          <Sigma
            size={11}
            aria-hidden
            className="mt-[2px] shrink-0 text-[var(--rcd-status-warn)]"
          />
          <span className="min-w-0 flex-1 break-words text-rcd-text-2">
            <span className="font-medium text-rcd-text">{failure.label}</span> could not be
            calculated, so it is empty here. {failure.message}
          </span>
          {onEditMeasure && (
            <button
              type="button"
              onClick={() => onEditMeasure(failure)}
              className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium text-rcd-accent hover:bg-black/5 dark:hover:bg-white/10"
            >
              Edit measure
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function State({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-rcd-text-2">
      {icon}
      {children}
    </div>
  );
}
