import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import {
  stableStringify,
  type CellValue,
  type FilterClause,
  type FilterValue,
} from '@recon/dashboards-core';
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
  /**
   * Bulk write of the whole selection. Present = the Select all / Clear
   * footer actions render (the dropdown variants and the checklist tile all
   * pass it — the variants are feature-identical by construction).
   */
  onSetValues?: (values: FilterValue[]) => void;
  /**
   * CASCADE: clauses the distinct-value fetch is scoped by (empty = the full
   * column). MUST be referentially stable across renders — it is both an
   * effect dependency and part of the shared distinct cache key.
   */
  filters?: FilterClause[];
  /**
   * True when `filters` came from an enabled cascade. Only then does "selected
   * but missing from the response" mean UNAVAILABLE (dimmed row) rather than
   * "filtered out by the search box".
   */
  cascade?: boolean;
  /**
   * Rows to assume before the slot is measured, and the row budget in
   * `autoHeight` hosts. Popovers pass a taller value so they open usefully.
   */
  fallbackRows?: number;
  /**
   * The host sizes itself to THIS panel (the dropdown popovers) rather than
   * handing it a height. Measuring the slot there is a feedback loop — it
   * reports back the frame height the panel itself just set, and whatever the
   * first (loading-state) measurement happened to be becomes a fixed point,
   * stranding the list one or more rows short. In this mode the row budget is
   * `fallbackRows` outright and the slot is never measured; the host's own
   * max-height still clamps the frame (`max-h-full`).
   */
  autoHeight?: boolean;
  /** Popovers focus the search box on open; the in-tile checklist does not. */
  autoFocusSearch?: boolean;
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
 * height, and the dropdown popovers size to their content). Sizing the frame
 * from this makes the next measurement report the frame's own height, which
 * resolves to the same row count: it converges instead of collapsing to a
 * single row.
 */
const FALLBACK_ROWS = 4;

const keyOf = (value: FilterValue): string => `${typeof value}:${String(value)}`;

const NO_FILTERS: FilterClause[] = [];
const NO_KEYS: ReadonlySet<string> = new Set<string>();

/* ------------------------------------------------- multi-select summaries */

/** Longest first-label the "X +N more" summary renders before ellipsizing. */
export const SUMMARY_MAX_CHARS = 22;
/** Values spelled out in a title attribute before it collapses to a count. */
const TITLE_MAX_VALUES = 24;

export interface SelectionSummary {
  /** First selected value, truncated for display ('' when nothing is selected). */
  first: string;
  /** Additional selected values beyond the first (0 = single/no selection). */
  moreCount: number;
  /** Flat one-line form — 'Gulf Coast +2 more' / the empty-state text. */
  text: string;
  /** Every selected value, for a title attribute. */
  title: string;
}

/** Truncate by CODE POINT, never by UTF-16 unit: slicing a string mid-surrogate
 *  (an emoji or any astral character landing on the boundary) leaves a lone
 *  surrogate that renders as a replacement glyph. */
const ellipsize = (text: string, max: number): string => {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
};

/**
 * Power BI-style multi-select summary: the FIRST selected value plus
 * "+N more", never a bare "N selected" (which hides what is actually filtered).
 * Callers that can render two elements should use `first` + `moreCount` so the
 * count survives CSS truncation of a long first label; `text` is the flat
 * fallback and `title` always spells the selection out.
 */
export function summarizeSelection(
  selected: readonly FilterValue[],
  emptyText = 'All',
): SelectionSummary {
  if (selected.length === 0) return { first: '', moreCount: 0, text: emptyText, title: emptyText };
  const labels = selected.map((value) => String(value));
  const first = ellipsize(labels[0]!, SUMMARY_MAX_CHARS);
  const moreCount = labels.length - 1;
  const title =
    labels.length <= TITLE_MAX_VALUES
      ? labels.join(', ')
      : `${labels.slice(0, TITLE_MAX_VALUES).join(', ')}, … and ${labels.length - TITLE_MAX_VALUES} more`;
  return {
    first,
    moreCount,
    text: moreCount > 0 ? `${first} +${moreCount} more` : first,
    title,
  };
}

/**
 * The searchable distinct-value checklist shared by EVERY value-listing slicer
 * variant: the `checklist` tile body, the `dropdown` popover, and the portaled
 * `dropdownMulti` popover all render this exact component, so search, Select
 * all / Clear, the scroll fades, the "+N more" chip, cascade filtering and the
 * selected-but-unavailable treatment can never drift apart between them.
 *
 * Layout doctrine: the host never scrolls; this panel owns the only scroll
 * container and sizes it to a whole number of rows, so the bottom edge always
 * lands on a row boundary. Overflow is advertised by edge gradients plus a
 * "+N more" chip.
 */
export function SlicerChecklistPanel({
  modelId,
  table,
  column,
  label,
  compact,
  selected,
  onToggle,
  onSetValues,
  filters = NO_FILTERS,
  cascade = false,
  fallbackRows = FALLBACK_ROWS,
  autoHeight = false,
  autoFocusSearch = false,
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

  // The cascade clause set travels by VALUE into the fetch effect and the
  // shared distinct cache key; hashing it keeps the effect from re-running on
  // an equal-but-new array.
  const filtersKey = useMemo(() => stableStringify(filters), [filters]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    runtime.queries
      .distinct(
        {
          modelId,
          table,
          column,
          search: debounced.trim() || null,
          // The cache dedupes by the WHOLE spec (stableStringify), so the
          // clause set is already part of the key — two cascade states of the
          // same column never share an entry.
          filters: [...filtersRef.current],
        },
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
  }, [runtime, modelId, table, column, debounced, filtersKey, retryToken]);

  // Available height for the list = whatever the search box and footer leave.
  // The slot is flex-1/min-h-0, so its height comes from the host, never from
  // the (absolutely sized) frame inside it — no measurement feedback loop.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || autoHeight) return;
    const read = () => setSlotHeight(slot.clientHeight);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [autoHeight]);

  const fetched = useMemo<FilterValue[]>(
    () => state.values.filter((value): value is FilterValue => value !== null),
    [state.values],
  );

  // Selected values stay listed even when the current response omits them —
  // a search that hides them, or (under cascade) another filter that trimmed
  // them away. A user's filter is NEVER silently dropped.
  const listed = useMemo<FilterValue[]>(() => {
    const fetchedKeys = new Set(fetched.map(keyOf));
    const pinned = selected.filter((value) => !fetchedKeys.has(keyOf(value)));
    return [...pinned, ...fetched];
  }, [fetched, selected]);

  const selectedKeys = useMemo(() => new Set(selected.map(keyOf)), [selected]);

  /**
   * Selected values the CASCADE has trimmed away — dimmed, but still checked
   * and still uncheckable. Only meaningful with an empty search (otherwise the
   * search explains the absence) and a complete response (`hasMore` means the
   * server capped the list, so absence proves nothing — same doctrine as the
   * calendar's `partial` availability).
   */
  const unavailableKeys = useMemo<ReadonlySet<string>>(() => {
    if (!cascade || state.status !== 'ok' || state.hasMore || debounced.trim() !== '') return NO_KEYS;
    const fetchedKeys = new Set(fetched.map(keyOf));
    const missing = selected.map(keyOf).filter((key) => !fetchedKeys.has(key));
    return missing.length > 0 ? new Set(missing) : NO_KEYS;
  }, [cascade, state.status, state.hasMore, debounced, fetched, selected]);

  const rowHeight = compact ? ROW_HEIGHT.compact : ROW_HEIGHT.normal;
  const scroll = useScrollAffordance(scrollRef, `${listed.length}:${slotHeight}`);

  const fitRows =
    !autoHeight && slotHeight > 0
      ? Math.max(1, Math.floor((slotHeight - FRAME_BORDERS) / rowHeight))
      : Math.max(1, fallbackRows);
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

  /** Union of the current selection and every value the response listed. */
  const selectAllListed = () => {
    if (!onSetValues) return;
    const union = [...selected];
    const have = new Set(selected.map(keyOf));
    for (const value of fetched) {
      if (!have.has(keyOf(value))) {
        have.add(keyOf(value));
        union.push(value);
      }
    }
    onSetValues(union);
  };

  const summary = summarizeSelection(selected);
  const showActions = onSetValues !== undefined;
  const showFooter = showActions || state.hasMore || selected.length > 0;

  return (
    <div className={`flex h-full min-h-0 flex-col ${compact ? 'gap-1' : 'gap-1.5'}`}>
      <div className="relative max-w-[24rem] shrink-0">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-rcd-muted" />
        <RcdInput
          autoFocus={autoFocusSearch}
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
              <p className="p-3 text-xs text-rcd-muted">
                {cascade && debounced.trim() === ''
                  ? 'No values remain under the other filters.'
                  : 'No values match.'}
              </p>
            ) : (
              // No padding on the track: rows tile exactly, so the snapped
              // viewport height always ends flush with a row boundary.
              <div className={state.status === 'loading' ? 'opacity-60' : ''}>
                {listed.map((value) => {
                  const key = keyOf(value);
                  const unavailable = unavailableKeys.has(key);
                  return (
                    <label
                      key={key}
                      style={{ height: rowHeight }}
                      title={
                        unavailable
                          ? `${String(value)} — selected, but no rows match it under the other filters`
                          : String(value)
                      }
                      className={`flex cursor-pointer items-center px-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
                        compact ? 'gap-1.5 text-xs' : 'gap-2 text-sm'
                      } ${unavailable ? 'italic text-rcd-muted opacity-60' : 'text-rcd-text'}`}
                    >
                      <input
                        type="checkbox"
                        className="shrink-0 accent-[var(--rcd-accent)]"
                        checked={selectedKeys.has(key)}
                        onChange={() => onToggle(value)}
                      />
                      <span className="min-w-0 truncate">{String(value)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <ScrollFades state={scroll} moreCount={rowsPastFold} />
        </div>
      </div>

      {showFooter && (
        <div className="flex max-w-[24rem] shrink-0 flex-col gap-0.5">
          {state.hasMore && (
            <p className="min-w-0 truncate text-[10px] text-rcd-muted">
              More values exist — refine your search.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            {showActions ? (
              <div className="flex shrink-0 items-center gap-1">
                <RcdButton
                  variant="ghost"
                  className="!px-1.5 !py-0.5 !text-[11px]"
                  disabled={state.status !== 'ok' || fetched.length === 0}
                  title={
                    state.hasMore
                      ? 'Selects the values listed here (more exist — refine your search)'
                      : 'Select every listed value'
                  }
                  onClick={selectAllListed}
                >
                  Select all
                </RcdButton>
                <RcdButton
                  variant="ghost"
                  className="!px-1.5 !py-0.5 !text-[11px]"
                  disabled={selected.length === 0}
                  title="Clear the selection"
                  onClick={() => onSetValues?.([])}
                >
                  Clear
                </RcdButton>
              </div>
            ) : (
              <span />
            )}
            {selected.length > 0 && (
              // Same "first +N more" wording the dropdown trigger uses; the
              // count is its own node so a long first label truncates around it.
              <p
                className="flex min-w-0 items-baseline gap-1 text-[10px] text-rcd-muted"
                title={summary.title}
              >
                <span className="min-w-0 truncate">{summary.first}</span>
                {summary.moreCount > 0 && (
                  <span className="shrink-0">+{summary.moreCount} more</span>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
