import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, RefreshCw } from 'lucide-react';
import {
  isRunnable,
  toWireSpec,
  type ChartSpec,
  type FilterClause,
  type QueryResult,
} from '@recon/dashboards-core';
import { useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton } from '../primitives';
// Type-only import: erased at compile time, so the lazy chunk split survives.
import type { ChartDatumClickInfo } from './ChartRenderer';

const ChartRenderer = lazy(() => import('./ChartRenderer'));

export interface ChartTileProps {
  spec: ChartSpec;
  modelId: number;
  /** Dashboard-level filters (slicers + cross-filter) merged into the chart's own. */
  filters?: FilterClause[];
  /** Debounce before running (builder preview); 0 for tiles. */
  debounceMs?: number;
  /** Cross-filter click pass-through (see ChartRendererProps.onDatumClick). */
  onDatumClick?: (info: ChartDatumClickInfo) => void;
  /** Set while this tile is the active cross-filter SOURCE (dims non-matches). */
  activeCategory?: { label: string } | null;
}

const EMPTY_FILTERS: FilterClause[] = [];

/**
 * Runs a chart spec through the shared query cache and renders exactly one of:
 * configure hint / skeleton / error+retry / empty / the chart.
 *
 * The fetch effect is keyed on the CACHE KEY STRING, not object identities —
 * fresh-but-equal spec/filters arrays must never re-trigger requests (an
 * identity-keyed effect here once produced an abort/retry loop that drained
 * the server's rate-limit bucket).
 */
export function ChartTile({
  spec,
  modelId,
  filters = EMPTY_FILTERS,
  debounceMs = 0,
  onDatumClick,
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
  }, [runtime, cacheKey, debounceMs, retryToken]);

  if (!runnable) {
    return (
      <State icon={<BarChart3 size={22} className="text-rcd-muted" />}>
        Add a measure to get started.
      </State>
    );
  }

  if (!entry || entry.status === 'loading') {
    return <div className="rcd-skeleton h-full w-full rounded-md" aria-label="Loading chart" />;
  }

  if (entry.status === 'error') {
    return (
      <State icon={<AlertTriangle size={22} className="text-[var(--rcd-status-warn)]" />}>
        <span className="max-w-full break-words">{entry.error}</span>
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

  return (
    <div className="h-full w-full min-w-0 overflow-hidden">
      <Suspense fallback={<div className="rcd-skeleton h-full w-full rounded-md" />}>
        <ChartRenderer
          spec={spec}
          result={result}
          onDatumClick={onDatumClick}
          activeCategory={activeCategory}
        />
      </Suspense>
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
