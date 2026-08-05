import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { AlertTriangle, BarChart3, RefreshCw } from 'lucide-react';
import {
  isRunnable,
  toWireSpec,
  type CellValue,
  type ChartPointEvent,
  type ChartSpec,
  type FilterClause,
  type QueryResult,
} from '@recon/dashboards-core';
import { useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton } from '../primitives';
import { ChartLoadingSkeleton, TileUpdatingBar } from '../dashboard/ChartLoadingSkeleton';
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
  columnWidths?: Record<string, number>;
  columnOrder?: string[];
}

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
  /* ----- interactive table (format.table) ----- */
  tableSort?: ChartTableSort | null;
  onTableSortChange?: (sort: ChartTableSort | null) => void;
  /** 0-based page (server-side offset pagination). */
  tablePage?: number;
  /** Known page count; null while unknown (› disabled on a short page). */
  tablePageCount?: number | null;
  onTablePageChange?: (page: number) => void;
  /** Totals row aligned to measure columns; null = none. */
  totalsRow?: (number | null)[] | null;
  /** Column drag/resize report (persist or keep transient — caller's call). */
  onTableLayoutChange?: (patch: ChartTableLayoutPatch) => void;
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
  /** Interactive-table sort state + change hook (format.table charts). */
  tableSort?: ChartTableSort | null;
  onTableSortChange?: (sort: ChartTableSort | null) => void;
  /** Interactive-table 0-based page + known page count (null = unknown). */
  tablePage?: number;
  tablePageCount?: number | null;
  onTablePageChange?: (page: number) => void;
  /** Totals row aligned to measure columns (companion no-dimension query). */
  totalsRow?: (number | null)[] | null;
  /** Column width/order drag report (persist or transient — caller's call). */
  onTableLayoutChange?: (patch: ChartTableLayoutPatch) => void;
  /**
   * Ref-style report of the freshest rendered QueryResult (assignment only —
   * mirrors reportEffective). The dashboard tile uses it to map table sort
   * column names onto wire dimension/measure indices and to derive page count.
   */
  onResult?: (result: QueryResult) => void;
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
  tableSort = null,
  onTableSortChange,
  tablePage = 0,
  tablePageCount = null,
  onTablePageChange,
  totalsRow = null,
  onTableLayoutChange,
  onResult,
}: ChartTileProps) {
  const runtime = useRuntime();
  const runnable = isRunnable(spec);
  const wireSpec = useMemo(() => {
    if (!runnable) return null;
    const base = toWireSpec(spec, modelId, filters);
    // Offset rides the wire spec directly (ChartQuery has no offset field);
    // it participates in the cache key like every other spec field.
    return offset != null && offset > 0 ? { ...base, offset } : base;
  }, [spec, modelId, filters, offset, runnable]);
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
   * Known page count: a SHORT page (fewer rows than pageSize) marks the last
   * page — › disables; a full page keeps it unknown (null). The caller's
   * tablePageCount passes through when paging is off.
   */
  const derivedPageCount =
    pagingActive && okRowCount !== null
      ? okRowCount < pageSize
        ? tablePage + 1
        : null
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
        Add a measure to get started.
      </State>
    );
  }

  const renderChart = (
    chartSpec: ChartSpec,
    result: QueryResult,
    updating: boolean,
  ) => (
    <div className="relative h-full w-full min-w-0 overflow-hidden">
      {updating && <TileUpdatingBar />}
      <div
        className={`h-full w-full transition-opacity duration-150 ${
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
            tableSort={tableSort}
            onTableSortChange={onTableSortChange}
            tablePage={tablePage}
            tablePageCount={derivedPageCount}
            onTablePageChange={onTablePageChange}
            totalsRow={totalsRow}
            onTableLayoutChange={onTableLayoutChange}
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
    return (
      <State icon={<AlertTriangle size={20} className="text-rcd-muted" />}>
        <span className="max-w-full break-words text-xs text-rcd-text-2">{entry.error}</span>
        <RcdButton onClick={() => setRetryToken((t) => t + 1)}>
          <RefreshCw size={14} /> Retry
        </RcdButton>
      </State>
    );
  }

  const result: QueryResult = entry.data!;
  if (result.rows.length === 0) {
    return <State icon={<BarChart3 size={22} className="text-rcd-muted" />}>No data for this selection.</State>;
  }

  return renderChart(spec, result, false);
}

function State({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-rcd-text-2">
      {icon}
      {children}
    </div>
  );
}
