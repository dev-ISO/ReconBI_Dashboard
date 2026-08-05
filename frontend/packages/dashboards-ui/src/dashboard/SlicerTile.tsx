import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, RefreshCw, Search, X } from 'lucide-react';
import type { FilterClause, FilterValue, SlicerTileSpec } from '@recon/dashboards-core';
import { DistinctValueList } from '../chart-builder/DistinctValueList';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdIconButton, RcdInput, RcdSpinner } from '../primitives';
import { SlicerConfigMenu } from './SlicerConfigMenu';
import { TileFrame } from './TileFrame';

export interface SlicerTileProps {
  tileId: string;
  spec: SlicerTileSpec;
  /** null = dashboard has no model attached (slicer cannot fetch values). */
  modelId: number | null;
  editable: boolean;
  /** Chart tiles on the dashboard (config menu's "Applies to" checklist). */
  chartTiles: { id: string; title: string }[];
}

/** Distinct values shown by the buttons variant before the "+ more" hint. */
const BUTTONS_CAP = 12;

/** Stable identity for a filter value across types ('1' vs 1 vs true). */
const keyOf = (value: FilterValue): string => `${typeof value}:${String(value)}`;

/**
 * A slicer as a grid tile (draggable/resizable like charts). The body renders
 * by variant; right-click anywhere (or the kebab in edit mode) opens the
 * SlicerConfigMenu. Selections land in the store keyed by TILE id, and
 * DashboardView routes them to targeted charts via filtersForTile.
 */
export function SlicerTile({ tileId, spec, modelId, editable, chartTiles }: SlicerTileProps) {
  const runtime = useRuntime();
  const clause = useDashboardState((state) => state.slicerValues[tileId] ?? null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  /** Frameless mode: no header bar; the label becomes an inline body caption. */
  const hideHeader = spec.style?.hideHeader === true;
  /** Compact mode: tighter paddings + smaller text on every variant. */
  const compact = spec.style?.compact === true;

  const hasSelection = clause !== null && clause.values.length > 0;
  const setClause = (next: FilterClause | null) => runtime.dashboards.setSlicerValue(tileId, next);

  const inSelected = clause?.operator === 'in' ? clause.values : [];
  const toggleInValue = (value: FilterValue) => {
    const next = inSelected.includes(value)
      ? inSelected.filter((v) => v !== value)
      : [...inSelected, value];
    setClause(
      next.length > 0
        ? { table: spec.table, column: spec.column, operator: 'in', values: next }
        : null,
    );
  };

  const body =
    modelId === null ? (
      <div className="flex h-full items-center justify-center p-2 text-center text-sm text-rcd-muted">
        No model attached to this dashboard.
      </div>
    ) : spec.variant === 'checklist' ? (
      // Compact overrides reach INTO DistinctValueList via arbitrary variants
      // (its rows are labels): tighter rows + smaller text. Literal classes.
      // max-w keeps rows readable on wide tiles (anchored top-left).
      <div
        className={`max-w-[24rem]${
          compact ? ' [&_label]:gap-1.5 [&_label]:py-0.5 [&_label]:text-xs' : ''
        }`}
      >
        <DistinctValueList
          modelId={modelId}
          table={spec.table}
          column={spec.column}
          selected={inSelected}
          onToggle={toggleInValue}
        />
      </div>
    ) : spec.variant === 'dropdown' ? (
      <DropdownSlicer
        modelId={modelId}
        spec={spec}
        compact={compact}
        selected={inSelected}
        onToggle={toggleInValue}
        onClear={() => setClause(null)}
      />
    ) : spec.variant === 'dropdownMulti' ? (
      <DropdownMultiSlicer
        modelId={modelId}
        spec={spec}
        compact={compact}
        selected={inSelected}
        onToggle={toggleInValue}
        onSetValues={(values) =>
          setClause(
            values.length > 0
              ? { table: spec.table, column: spec.column, operator: 'in', values }
              : null,
          )
        }
      />
    ) : spec.variant === 'buttons' ? (
      <ButtonsSlicer
        modelId={modelId}
        spec={spec}
        compact={compact}
        selected={inSelected}
        onToggle={toggleInValue}
      />
    ) : (
      <DateRangeSlicer spec={spec} compact={compact} clause={clause} onChange={setClause} />
    );

  const showClear = hasSelection && spec.showClear !== false;

  return (
    <TileFrame
      title={spec.label}
      editable={editable}
      container={hideHeader ? { hideHeader: true } : null}
      onMenu={(position) => setMenuPos(position)}
      onContextMenu={(event) => {
        // Config card instead of the native browser menu (both modes).
        event.preventDefault();
        event.stopPropagation();
        setMenuPos({ x: event.clientX, y: event.clientY });
      }}
      headerExtra={
        !hideHeader && showClear ? (
          <RcdIconButton
            aria-label={`Clear ${spec.label} selection`}
            title="Clear selection"
            onClick={() => setClause(null)}
          >
            <X size={13} />
          </RcdIconButton>
        ) : null
      }
    >
      <div className="flex h-full flex-col">
        {hideHeader && (
          // Frameless mode: the label shrinks to an inline caption (the clear x
          // moves next to it, since there is no header bar to host it).
          <div className="flex shrink-0 items-center gap-1 pb-1">
            <span
              className={`min-w-0 truncate font-medium text-rcd-text-2 ${
                compact ? 'text-[11px]' : 'text-xs'
              }`}
              title={spec.label}
            >
              {spec.label}
            </span>
            {showClear && (
              <RcdIconButton
                aria-label={`Clear ${spec.label} selection`}
                title="Clear selection"
                className="!p-0.5"
                onClick={() => setClause(null)}
              >
                <X size={11} />
              </RcdIconButton>
            )}
          </div>
        )}
        {/* The dropdown variants' popovers must escape the tile — no scroll
            container around them (overflow-y would clip the panel; the
            multi-select popover is portaled but keeps the same layout). */}
        <div
          className={
            spec.variant === 'dropdown' || spec.variant === 'dropdownMulti'
              ? 'min-h-0 flex-1'
              : 'min-h-0 flex-1 overflow-y-auto'
          }
        >
          {body}
        </div>
      </div>

      {menuPos &&
        // Portal past the transformed grid item: position:fixed inside a
        // transformed ancestor would resolve against the tile, not the viewport.
        createPortal(
          <div className="rcd-root bg-transparent">
            <SlicerConfigMenu
              tileId={tileId}
              spec={spec}
              chartTiles={chartTiles}
              editable={editable}
              hasSelection={hasSelection}
              position={menuPos}
              onClose={() => setMenuPos(null)}
            />
          </div>,
          document.body,
        )}
    </TileFrame>
  );
}

/** Compact "N selected" button opening a checklist popover (the old chip UX). */
function DropdownSlicer({
  modelId,
  spec,
  compact,
  selected,
  onToggle,
  onClear,
}: {
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  selected: FilterValue[];
  onToggle: (value: FilterValue) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Lift this tile above grid siblings while the popover is open (transformed
  // grid items stack by DOM order otherwise and would cover it).
  useEffect(() => {
    if (!open) return;
    const gridItem = rootRef.current?.closest<HTMLElement>('.react-grid-item');
    if (!gridItem) return;
    const previous = gridItem.style.zIndex;
    gridItem.style.zIndex = '30';
    return () => {
      gridItem.style.zIndex = previous;
    };
  }, [open]);

  const active = selected.length > 0;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full max-w-[18rem] items-center justify-between gap-1.5 rounded-md border bg-rcd-bg text-rcd-text transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
          compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1.5 text-sm'
        } ${active ? 'border-rcd-accent' : 'border-rcd-border'}`}
      >
        <span className="min-w-0 truncate">
          {active ? `${selected.length} selected` : 'All values'}
        </span>
        <ChevronDown size={13} className="shrink-0 text-rcd-muted" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 max-w-[80vw] rounded-md border border-rcd-border bg-rcd-surface p-2 shadow-lg">
          <DistinctValueList
            modelId={modelId}
            table={spec.table}
            column={spec.column}
            selected={selected}
            onToggle={onToggle}
          />
          {active && (
            <div className="flex justify-end pt-2">
              <RcdButton variant="ghost" onClick={onClear}>
                Clear selection
              </RcdButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Multi-select dropdown: a summary trigger ("All" / the one value / "3
 * selected") opening a PORTALED popover that extends beyond the tile bounds —
 * anchored to the trigger rect, viewport-clamped, with its own search +
 * checkbox rows + Select all/Clear footer. Produces the same 'in' clause the
 * checklist variant produces.
 */
function DropdownMultiSlicer({
  modelId,
  spec,
  compact,
  selected,
  onToggle,
  onSetValues,
}: {
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  selected: FilterValue[];
  onToggle: (value: FilterValue) => void;
  onSetValues: (values: FilterValue[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close returns focus to the trigger so Escape/outside-click never strands
  // the keyboard user.
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const active = selected.length > 0;
  const summary =
    selected.length === 0
      ? 'All'
      : selected.length === 1
        ? String(selected[0])
        : `${selected.length} selected`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={active ? `${spec.label}: ${summary}` : `${spec.label}: all values`}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex w-full max-w-[18rem] items-center justify-between gap-1.5 rounded-md border bg-rcd-bg text-rcd-text transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
          compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1.5 text-sm'
        } ${active ? 'border-rcd-accent' : 'border-rcd-border'}`}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown size={13} className="shrink-0 text-rcd-muted" />
      </button>

      {open &&
        // Portal past the transformed grid item; the .rcd-root wrapper
        // re-establishes theme tokens for the fixed-position panel.
        createPortal(
          <div className="rcd-root bg-transparent">
            <MultiValuePopover
              anchor={triggerRef}
              modelId={modelId}
              spec={spec}
              selected={selected}
              onToggle={onToggle}
              onSetValues={onSetValues}
              onClose={close}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

interface PopoverFetchState {
  status: 'loading' | 'ok' | 'error';
  values: FilterValue[];
  hasMore: boolean;
  error: string | null;
}

/**
 * The multi-select panel: searchable checkbox list over the column's distinct
 * values (shared query cache, server-side search; selected values stay pinned
 * when the search response omits them) with a Select all / Clear footer.
 * Fixed-position, anchored under the trigger and clamped to the viewport
 * (flips above when there is no room below). Closes on outside click, Escape,
 * scrolling outside the panel, and window resize.
 */
function MultiValuePopover({
  anchor,
  modelId,
  spec,
  selected,
  onToggle,
  onSetValues,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  modelId: number;
  spec: SlicerTileSpec;
  selected: FilterValue[];
  onToggle: (value: FilterValue) => void;
  onSetValues: (values: FilterValue[]) => void;
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<PopoverFetchState>({
    status: 'loading',
    values: [],
    hasMore: false,
    error: null,
  });

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
        {
          modelId,
          table: spec.table,
          column: spec.column,
          search: debounced.trim() || null,
          filters: [],
        },
        controller.signal,
      )
      .then((result) => {
        if (cancelled) return;
        setState({
          status: 'ok',
          values: result.values.filter((value): value is FilterValue => value !== null),
          hasMore: result.hasMore,
          error: null,
        });
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
  }, [runtime, modelId, spec.table, spec.column, debounced, retryToken]);

  // Anchor under the trigger, clamp to the viewport, flip above when the panel
  // would spill past the bottom. Re-measured when the list content changes
  // size; hidden until the first measurement lands (no corner flash).
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const a = trigger.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const x = Math.max(8, Math.min(a.left, window.innerWidth - rect.width - 8));
    let y = a.bottom + 4;
    if (y + rect.height > window.innerHeight - 8) {
      const above = a.top - rect.height - 4;
      y = above >= 8 ? above : Math.max(8, window.innerHeight - rect.height - 8);
    }
    setPos({ x, y });
  }, [anchor, state.status, state.values.length]);

  useEffect(() => {
    const isInside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      ((cardRef.current?.contains(target) ?? false) || (anchor.current?.contains(target) ?? false));
    const onPointerDown = (event: MouseEvent) => {
      if (!isInside(event.target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // The panel is anchored to a fixed point: scrolling anything OUTSIDE it
    // (dashboard canvas, page) would detach it from the trigger — close.
    const onScroll = (event: Event) => {
      if (!isInside(event.target)) onClose();
    };
    const onResize = () => onClose();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  // Selected values stay listed (and un-toggleable) even when the current
  // search response doesn't include them — same doctrine as DistinctValueList.
  const listed = useMemo<FilterValue[]>(() => {
    const fetchedKeys = new Set(state.values.map(keyOf));
    const pinned = selected.filter((value) => !fetchedKeys.has(keyOf(value)));
    return [...pinned, ...state.values];
  }, [state.values, selected]);

  const selectedKeys = useMemo(() => new Set(selected.map(keyOf)), [selected]);

  /** Union of the current selection and every currently listed value. */
  const selectAllListed = () => {
    const union = [...selected];
    const have = new Set(selected.map(keyOf));
    for (const value of state.values) {
      if (!have.has(keyOf(value))) {
        have.add(keyOf(value));
        union.push(value);
      }
    }
    onSetValues(union);
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Select ${spec.label} values`}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? undefined : 'hidden' }}
      className="fixed z-50 flex max-h-80 w-72 max-w-[92vw] flex-col rounded-md border border-rcd-border bg-rcd-surface p-2 shadow-lg"
    >
      <div className="relative shrink-0">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-rcd-muted" />
        <RcdInput
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search values…"
          aria-label={`Search ${spec.column} values`}
          className="w-full pl-7"
        />
      </div>

      <div className="mt-2 min-h-16 flex-1 overflow-y-auto rounded-md border border-rcd-border">
        {state.status === 'error' ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <AlertTriangle size={16} className="text-[var(--rcd-status-warn)]" />
            <p className="max-w-full break-words text-xs text-rcd-text-2">{state.error}</p>
            <RcdButton onClick={() => setRetryToken((t) => t + 1)}>
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
          <div className={`flex flex-col p-1 ${state.status === 'loading' ? 'opacity-60' : ''}`}>
            {listed.map((value) => (
              <label
                key={keyOf(value)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
              >
                <input
                  type="checkbox"
                  className="accent-[var(--rcd-accent)]"
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

      <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-rcd-border pt-2">
        <div className="flex items-center gap-1">
          <RcdButton
            variant="ghost"
            className="!px-2 !py-1 !text-xs"
            disabled={state.status !== 'ok' || state.values.length === 0}
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
            className="!px-2 !py-1 !text-xs"
            disabled={selected.length === 0}
            title="Clear the selection"
            onClick={() => onSetValues([])}
          >
            Clear
          </RcdButton>
        </div>
        <span className="shrink-0 text-[11px] text-rcd-muted">
          {selected.length > 0
            ? `${selected.length} selected`
            : state.hasMore
              ? 'More values exist'
              : 'All values'}
        </span>
      </div>
    </div>
  );
}

interface ButtonsFetchState {
  status: 'loading' | 'ok' | 'error';
  values: FilterValue[];
  hasMore: boolean;
  error: string | null;
}

/** Horizontal wrap of single-select value pills (eq; click again deselects). */
function ButtonsSlicer({
  modelId,
  spec,
  compact,
  selected,
  onToggle,
}: {
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  /** Multi-select: pills toggle membership of an 'in' clause. */
  selected: readonly FilterValue[];
  onToggle: (value: FilterValue) => void;
}) {
  const runtime = useRuntime();
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<ButtonsFetchState>({
    status: 'loading',
    values: [],
    hasMore: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    runtime.queries
      .distinct({
        modelId,
        table: spec.table,
        column: spec.column,
        search: null,
        filters: [],
        limit: BUTTONS_CAP,
      })
      .then((result) => {
        if (cancelled) return;
        setState({
          status: 'ok',
          values: result.values.filter((value): value is FilterValue => value !== null),
          hasMore: result.hasMore || result.values.length > BUTTONS_CAP,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          values: [],
          hasMore: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, modelId, spec.table, spec.column, retryToken]);

  if (state.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-2 text-center">
        <AlertTriangle size={16} className="text-[var(--rcd-status-warn)]" />
        <p className="max-w-full break-words text-xs text-rcd-text-2">{state.error}</p>
        <RcdButton onClick={() => setRetryToken((t) => t + 1)}>
          <RefreshCw size={13} />
          Retry
        </RcdButton>
      </div>
    );
  }

  if (state.status === 'loading' && state.values.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <RcdSpinner label="Loading values…" />
      </div>
    );
  }

  if (state.values.length === 0) {
    return <p className="p-2 text-xs text-rcd-muted">No values to show.</p>;
  }

  return (
    <div className="flex flex-wrap content-start items-center gap-1.5 p-0.5">
      {state.values.slice(0, BUTTONS_CAP).map((value) => {
        const isActive = selected.includes(value);
        return (
          <button
            key={keyOf(value)}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(value)}
            title={String(value)}
            // Uniform pill geometry (fixed height/radius, consistent gap); the
            // selected state is an accent FILL with readable inverted text.
            className={`inline-flex max-w-full items-center truncate rounded-full border transition-colors ${
              compact ? 'h-6 px-2.5 text-xs' : 'h-8 px-3 text-sm'
            } ${
              isActive
                ? 'border-rcd-accent bg-rcd-accent font-medium text-white hover:opacity-90'
                : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
            }`}
          >
            <span className="truncate">{String(value)}</span>
          </button>
        );
      })}
      {state.hasMore && (
        <span
          className="self-center text-[11px] text-rcd-muted"
          title="More values exist — switch this slicer to the checklist or dropdown variant to search them."
        >
          + more
        </span>
      )}
    </div>
  );
}

/** Two date inputs: both = between, one-sided = gte/lte ('YYYY-MM-DD' values). */
function DateRangeSlicer({
  spec,
  compact,
  clause,
  onChange,
}: {
  spec: SlicerTileSpec;
  compact: boolean;
  clause: FilterClause | null;
  onChange: (clause: FilterClause | null) => void;
}) {
  const [from, to] = useMemo<[string, string]>(() => {
    if (!clause) return ['', ''];
    const first = typeof clause.values[0] === 'string' ? clause.values[0] : '';
    const second = typeof clause.values[1] === 'string' ? clause.values[1] : '';
    if (clause.operator === 'between') return [first, second];
    if (clause.operator === 'gte') return [first, ''];
    if (clause.operator === 'lte') return ['', first];
    return ['', ''];
  }, [clause]);

  const update = (nextFrom: string, nextTo: string) => {
    const base = { table: spec.table, column: spec.column };
    if (nextFrom !== '' && nextTo !== '') {
      onChange({ ...base, operator: 'between', values: [nextFrom, nextTo] });
    } else if (nextFrom !== '') {
      onChange({ ...base, operator: 'gte', values: [nextFrom] });
    } else if (nextTo !== '') {
      onChange({ ...base, operator: 'lte', values: [nextTo] });
    } else {
      onChange(null);
    }
  };

  // w-full + max-w: each field caps at 18rem but still shrinks in narrow
  // tiles; flex-wrap puts From/To side by side when the tile is wide enough.
  const labelClasses = compact
    ? 'flex w-full max-w-[18rem] flex-col gap-0.5 text-[11px] text-rcd-text-2'
    : 'flex w-full max-w-[18rem] flex-col gap-1 text-xs text-rcd-text-2';
  const inputClasses = compact ? 'h-7 w-full text-xs' : 'w-full';

  return (
    <div className={compact ? 'flex flex-wrap gap-1 p-0.5' : 'flex flex-wrap gap-2 p-0.5'}>
      <label className={labelClasses}>
        From
        <RcdInput
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => update(event.target.value, to)}
          aria-label={`${spec.label} from date`}
          className={inputClasses}
        />
      </label>
      <label className={labelClasses}>
        To
        <RcdInput
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => update(from, event.target.value)}
          aria-label={`${spec.label} to date`}
          className={inputClasses}
        />
      </label>
    </div>
  );
}
