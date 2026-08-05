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

/**
 * Point/legend handlers the renderer exposes (agreed contract; typed here so
 * this file compiles against it regardless of when the renderer props land —
 * once ChartRendererProps carries them the intersection below is a no-op).
 * The existing onDatumClick cross-filter callback keeps firing alongside.
 */
interface RendererPointHandlers {
  onPointClick?: (e: ChartPointEvent) => void;
  onPointContextMenu?: (e: ChartPointEvent) => void;
  /** Legend click in legendMode 'crossFilter'; null = clear the selection. */
  onLegendSelect?: (e: ChartLegendSelectEvent | null) => void;
  /** Active legend selection passed back for persistent emphasis. */
  selectedLegendLabel?: string | null;
}

const ChartRenderer = lazy(() => import('./ChartRenderer')) as ComponentType<
  ChartRendererProps & RendererPointHandlers
>;

export interface ChartTileProps {
  spec: ChartSpec;
  modelId: number;
  /** Dashboard-level filters (slicers + cross-filter) merged into the chart's own. */
  filters?: FilterClause[];
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
  debounceMs = 0,
  refreshKey,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  onLegendSelect,
  selectedLegendLabel = null,
  activeCategory = null,
}: ChartTileProps) {
  const runtime = useRuntime();
  const runnable = isRunnable(spec);
  const wireSpec = useMemo(
    () => (runnable ? toWireSpec(spec, modelId, filters) : null),
    [spec, modelId, filters, runnable],
  );
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
  }

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
