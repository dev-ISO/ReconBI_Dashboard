import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import type { CellValue, FilterValue } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdInput, RcdSpinner } from '../primitives';
import { ScrollFades, useScrollAffordance } from './ScrollFades';

export interface SlicerChecklistPanelProps {
  modelId: number;
  table: string;
  column: string;
  /** Slicer label (accessible names only). */
  label: string;
  compact: boolean;
  selected: readonly FilterValue[];
  onToggle: (value: FilterValue) => void;
}

interface FetchState {
  status: 'loading' | 'ok' | 'error';
  values: CellValue[];
  hasMore: boolean;
  error: string | null;
}

/** Exact row heights in px — the scroll viewport snaps to a multiple of these
 *  so the list never ends on a half-clipped row (rem would drift with the
 *  host's root font size, hence pixels). */
const ROW_HEIGHT = { normal: 30, compact: 24 } as const;
/** Frame border (1px top + 1px bottom) sits outside the snapped rows. */
const FRAME_BORDERS = 2;
/**
 * Rows to show when the slot has no measured height — either the very first
 * paint, or an auto-height host (the mobile stack gives slicer tiles no fixed
 * height). Sizing the frame from this makes the next measurement report the
 * frame's own height, which resolves to the same row count: it converges
 * instead of collapsing to a single row.
 */
const FALLBACK_ROWS = 4;

const keyOf = (value: FilterValue): string => `${typeof value}:${String(value)}`;

/**
 * The checklist variant's body: a searchable distinct-value list that FILLS
 * the tile instead of the fixed-height box the shared DistinctValueList uses
 * (which clipped mid-row inside short tiles, with no hint more existed).
 *
 * Layout doctrine: the tile body never scrolls; this panel owns the only
 * scroll container and sizes it to a whole number of rows, so the bottom edge
 * always lands on a row boundary. Overflow is advertised by edge gradients
 * plus a "+N more" chip.
 */
export function SlicerChecklistPanel({
  modelId,
  table,
  column,
  label,
  compact,
  selected,
  onToggle,
}: SlicerChecklistPanelProps) {
  const runtime = useRuntime();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<FetchState>({
    status: 'loading',
    values: [],
    hasMore: false,
    error: null,
  });

  const slotRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [slotHeight, setSlotHeight] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    runtime.queries
      .distinct(
        { modelId, table, column, search: debounced.trim() || null, filters: [] },
        controller.signal,
      )
      .then((result) => {
        if (cancelled) return;
        setState({ status: 'ok', values: result.values, hasMore: result.hasMore, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState({
          status: 'error',
          values: [],
          hasMore: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtime, modelId, table, column, debounced, retryToken]);

  // Available height for the list = whatever the search box and footer leave.
  // The slot is flex-1/min-h-0, so its height comes from the tile, never from
  // the (absolutely sized) frame inside it — no measurement feedback loop.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const read = () => setSlotHeight(slot.clientHeight);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);

  // Selected values stay listed even when the current search omits them (same
  // doctrine as DistinctValueList).
  const listed = useMemo<FilterValue[]>(() => {
    const fetched = state.values.filter((value): value is FilterValue => value !== null);
    const fetchedKeys = new Set(fetched.map(keyOf));
    const pinned = selected.filter((value) => !fetchedKeys.has(keyOf(value)));
    return [...pinned, ...fetched];
  }, [state.values, selected]);

  const selectedKeys = useMemo(() => new Set(selected.map(keyOf)), [selected]);

  const rowHeight = compact ? ROW_HEIGHT.compact : ROW_HEIGHT.normal;
  const scroll = useScrollAffordance(scrollRef, `${listed.length}:${slotHeight}`);

  const fitRows =
    slotHeight > 0
      ? Math.max(1, Math.floor((slotHeight - FRAME_BORDERS) / rowHeight))
      : FALLBACK_ROWS;
  const visibleRows = Math.min(listed.length, fitRows);
  /** Snapped frame height; undefined in the non-row states (spinner/message).
   *  max-h-full caps it, so a tile too short for one row fades instead. */
  const frameHeight = listed.length > 0 ? visibleRows * rowHeight + FRAME_BORDERS : undefined;

  // Rows entirely below the fold (what the chip advertises).
  const rowsPastFold =
    scroll.viewportHeight > 0
      ? Math.max(
          0,
          listed.length - Math.round((scroll.scrollTop + scroll.viewportHeight) / rowHeight),
        )
      : 0;

  const showFooter = state.hasMore || selected.length > 0;

  return (
    <div className={`flex h-full min-h-0 flex-col ${compact ? 'gap-1' : 'gap-1.5'}`}>
      <div className="relative max-w-[24rem] shrink-0">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-rcd-muted" />
        <RcdInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search values…"
          aria-label={`Search ${label} values`}
          className={compact ? 'h-7 w-full pl-7 text-xs' : 'w-full pl-7'}
        />
      </div>

      <div ref={slotRef} className="min-h-0 max-w-[24rem] flex-1 overflow-hidden">
        <div
          style={frameHeight === undefined ? undefined : { height: frameHeight }}
          className="relative max-h-full overflow-hidden rounded-md border border-rcd-border"
        >
          <div ref={scrollRef} className="h-full overflow-y-auto">
            {state.status === 'error' ? (
              <div className="flex flex-col items-center gap-2 p-3 text-center">
                <AlertTriangle size={16} className="text-[var(--rcd-status-warn)]" />
                <p className="max-w-full break-words text-xs text-rcd-text-2">{state.error}</p>
                <RcdButton onClick={() => setRetryToken((token) => token + 1)}>
                  <RefreshCw size={13} />
                  Retry
                </RcdButton>
              </div>
            ) : state.status === 'loading' && listed.length === 0 ? (
              <div className="flex h-20 items-center justify-center">
                <RcdSpinner label="Loading values…" />
              </div>
            ) : listed.length === 0 ? (
              <p className="p-3 text-xs text-rcd-muted">No values match.</p>
            ) : (
              // No padding on the track: rows tile exactly, so the snapped
              // viewport height always ends flush with a row boundary.
              <div className={state.status === 'loading' ? 'opacity-60' : ''}>
                {listed.map((value) => (
                  <label
                    key={keyOf(value)}
                    style={{ height: rowHeight }}
                    className={`flex cursor-pointer items-center px-2 text-rcd-text transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
                      compact ? 'gap-1.5 text-xs' : 'gap-2 text-sm'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="shrink-0 accent-[var(--rcd-accent)]"
                      checked={selectedKeys.has(keyOf(value))}
                      onChange={() => onToggle(value)}
                    />
                    <span className="min-w-0 truncate" title={String(value)}>
                      {String(value)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <ScrollFades state={scroll} moreCount={rowsPastFold} />
        </div>
      </div>

      {showFooter && (
        <div className="flex max-w-[24rem] shrink-0 items-center justify-between gap-2">
          {state.hasMore ? (
            <p className="min-w-0 truncate text-[10px] text-rcd-muted">
              More values exist — refine your search.
            </p>
          ) : (
            <span />
          )}
          {selected.length > 0 && (
            <p className="shrink-0 text-[10px] text-rcd-muted">{selected.length} selected</p>
          )}
        </div>
      )}
    </div>
  );
}
