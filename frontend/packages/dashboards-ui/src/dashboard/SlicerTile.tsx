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
import { AlertTriangle, ChevronDown, RefreshCw, X } from 'lucide-react';
import {
  dateOnlyPartOf,
  inclusiveDateUpperBound,
  slicerClauseOf,
  slicerPresetOf,
  stableStringify,
  type ColumnType,
  type DashboardParameter,
  type FilterClause,
  type FilterValue,
  type SlicerTileSpec,
  type SlicerTileStyle,
} from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import {
  BUTTON_GAP_CLASSES,
  BUTTON_VALIGN_CLASSES,
  slicerButtonLayout,
  slicerPillClasses,
} from './buttonLayout';
import { useColumnType } from './columnType';
import { RcdButton, RcdIconButton, RcdInput, RcdSelect, RcdSpinner } from '../primitives';
import { SlicerCalendarFields } from './SlicerCalendar';
import { SlicerChecklistPanel, summarizeSelection } from './SlicerChecklistPanel';
import {
  customPresetId,
  parseCustomPreset,
  relativePresetClause,
  relativePresetLabel,
  RELATIVE_DATE_PRESETS,
  RELATIVE_UNITS,
  type RelativeUnit,
} from './relativeDate';
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

/** Shared empty clause set — a fresh [] per render would restart every fetch. */
const NO_FILTERS: FilterClause[] = [];

/** Rows a dropdown popover opens at when its list is long enough to fill them.
 *  7 keeps rows + search + footer inside the popover's max-h-80 (8 rows left
 *  the last row clipped by ~10-24px); overflow scrolls behind the fades. */
const POPOVER_ROWS = 7;

/**
 * Holds a clause array at a stable identity while its CONTENTS are unchanged.
 * The store rebuilds the cascade set on every slicer/cross-filter write, so
 * without this every unrelated selection elsewhere would restart this
 * slicer's distinct fetch (and thrash its list) even though the scope is
 * identical.
 */
function useStableClauses(clauses: FilterClause[]): FilterClause[] {
  const key = stableStringify(clauses);
  const keyRef = useRef(key);
  const valueRef = useRef(clauses);
  if (key !== keyRef.current) {
    keyRef.current = key;
    valueRef.current = clauses;
  }
  return valueRef.current;
}

/**
 * A slicer as a grid tile (draggable/resizable like charts). The body renders
 * by variant; right-click anywhere (or the kebab in edit mode) opens the
 * SlicerConfigMenu. Selections land in the store keyed by TILE id, and
 * DashboardView routes them to targeted charts via filtersForTile.
 */
export function SlicerTile({ tileId, spec, modelId, editable, chartTiles }: SlicerTileProps) {
  const runtime = useRuntime();
  /** Raw runtime value: undefined = untouched, null = cleared, else selection. */
  const value = useDashboardState((state) => state.slicerValues[tileId]);
  const clause = slicerClauseOf(value);
  const activePresetId = slicerPresetOf(value);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  /* -------------------------------------------------------------- cascade */

  /**
   * CASCADING slicer (spec.cascade): the available-value fetch is scoped by
   * the dashboard's other active filters. The clause set comes from the store
   * (cascadeFiltersForSlicer — other slicers on this page + cross-filters,
   * minus anything on this slicer's own column), so no DashboardView prop is
   * needed. Subscribing to the RAW store fields the helper reads gives the
   * memo its revision (they are replaced, never mutated, on every change) —
   * note the selector gotcha: raw fields only, no `?? []` fallback inside.
   */
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const crossFilters = useDashboardState((state) => state.crossFilters);
  const cascadeOn = spec.cascade === true && spec.variant !== 'fieldParam';
  const cascadeFilters = useStableClauses(
    useMemo(
      () => (cascadeOn ? runtime.dashboards.cascadeFiltersForSlicer(tileId) : NO_FILTERS),
      [cascadeOn, runtime, tileId, slicerValues, crossFilters],
    ),
  );

  /** Frameless mode: no header bar; the label becomes an inline body caption. */
  const hideHeader = spec.style?.hideHeader === true;
  /** Compact mode: tighter paddings + smaller text on every variant. */
  const compact = spec.style?.compact === true;

  const setClause = (next: FilterClause | null) => runtime.dashboards.setSlicerValue(tileId, next);

  /**
   * Catalog type of the sliced column. Date clauses need it to render their
   * inclusive upper bound at the column's own resolution; unresolved (null)
   * keeps the bare-date form a `date` column requires.
   */
  const { type: columnType, settled: columnTypeSettled } = useColumnType(
    modelId,
    spec.table,
    spec.column,
  );

  /* --------------------------------------------------- field-param variant */

  const parameters = useDashboardState((state) => state.current?.layout.parameters ?? null);
  const parameterSelections = useDashboardState((state) => state.parameterSelections);
  const parameter =
    spec.variant === 'fieldParam' && spec.parameterId
      ? (parameters ?? []).find((p) => p.id === spec.parameterId) ?? null
      : null;
  const paramDefaultIndex = parameter
    ? Math.min(Math.max(parameter.defaultIndex ?? 0, 0), Math.max(parameter.options.length - 1, 0))
    : 0;
  const paramIndex = parameter
    ? (parameterSelections[parameter.id] ?? paramDefaultIndex)
    : 0;

  /* -------------------------------------------------- relative-date variant */

  /**
   * The persisted default preset (spec.preset) applies once when the dashboard
   * opens with this slicer untouched (value === undefined; an explicit clear
   * stores null and must NOT resurrect the default).
   */
  const untouched = value === undefined;
  useEffect(() => {
    if (spec.variant !== 'relativeDate' || !spec.preset) return;
    // Wait for the column type to settle: this clause is emitted once and is
    // not recomputed until the next refresh tick, so baking an unresolved
    // type into it would leave a timestamp column short its last day.
    if (!columnTypeSettled) return;
    // Untouched default only — an explicit clear stores null and must NOT
    // resurrect it. The lone exception is re-emitting that same default when
    // the catalog resolves after the first paint (guarded to a no-op below).
    if (!untouched && activePresetId !== spec.preset) return;
    const initial = relativePresetClause(spec.preset, spec.table, spec.column, columnType);
    const next = initial === null ? null : { clause: initial, presetId: spec.preset };
    if (!untouched && JSON.stringify(next) === JSON.stringify(value)) return;
    // broadcast: false — applying the AUTHORED default on open is not a user
    // pick (COLLAB wave 2: on a shared slicer, broadcasting it would blast
    // the default over collaborators' current shared value every time anyone
    // merely opens the dashboard). Actual preset PICKS go through
    // pickRelativePreset below and broadcast normally.
    runtime.dashboards.setSlicerValue(tileId, next, { broadcast: false });
  }, [
    runtime,
    tileId,
    spec.variant,
    spec.preset,
    spec.table,
    spec.column,
    untouched,
    activePresetId,
    columnType,
    columnTypeSettled,
    value,
  ]);

  const pickRelativePreset = (presetId: string) => {
    if (presetId === 'all') {
      setClause(null);
    } else {
      runtime.dashboards.setSlicerValue(tileId, {
        clause: relativePresetClause(presetId, spec.table, spec.column, columnType),
        presetId,
      });
    }
    // Edit mode also persists the choice so it survives reload for everyone.
    if (editable && (spec.preset ?? null) !== (presetId === 'all' ? null : presetId)) {
      runtime.dashboards.updateSlicer(tileId, {
        preset: presetId === 'all' ? null : presetId,
      });
    }
  };

  const hasSelection =
    spec.variant === 'fieldParam'
      ? parameter !== null && paramIndex !== paramDefaultIndex
      : clause !== null && clause.values.length > 0;

  const clearSelection = () => {
    if (spec.variant === 'fieldParam') {
      if (parameter) runtime.dashboards.setParameterSelection(parameter.id, paramDefaultIndex);
    } else {
      setClause(null);
    }
  };

  const inSelected = clause?.operator === 'in' ? clause.values : [];
  /** Bulk write of the whole 'in' set (Select all / Clear). */
  const setInValues = (values: FilterValue[]) =>
    setClause(
      values.length > 0
        ? { table: spec.table, column: spec.column, operator: 'in', values }
        : null,
    );
  const toggleInValue = (value: FilterValue) => {
    setInValues(
      inSelected.includes(value)
        ? inSelected.filter((v) => v !== value)
        : [...inSelected, value],
    );
  };

  const body =
    // Field-param slicers drive a parameter selection — no model needed.
    spec.variant === 'fieldParam' ? (
      <FieldParamSlicer
        spec={spec}
        compact={compact}
        parameter={parameter}
        selectedIndex={paramIndex}
        onPick={(index) => {
          if (parameter) runtime.dashboards.setParameterSelection(parameter.id, index);
        }}
      />
    ) : modelId === null ? (
      <div className="flex h-full items-center justify-center p-2 text-center text-sm text-rcd-muted">
        No model attached to this dashboard.
      </div>
    ) : spec.variant === 'checklist' ? (
      // Fills the tile and owns its own (row-snapped) scroll container: a
      // fixed-height list box clipped mid-row inside short tiles. The dropdown
      // variants render this SAME panel inside their popovers, so the three
      // value-listing variants cannot drift apart feature-wise.
      <SlicerChecklistPanel
        modelId={modelId}
        table={spec.table}
        column={spec.column}
        label={spec.label}
        compact={compact}
        selected={inSelected}
        onToggle={toggleInValue}
        onSetValues={setInValues}
        filters={cascadeFilters}
        cascade={cascadeOn}
      />
    ) : spec.variant === 'dropdown' ? (
      <DropdownSlicer
        modelId={modelId}
        spec={spec}
        compact={compact}
        selected={inSelected}
        onToggle={toggleInValue}
        onSetValues={setInValues}
        filters={cascadeFilters}
        cascade={cascadeOn}
      />
    ) : spec.variant === 'dropdownMulti' ? (
      <DropdownMultiSlicer
        modelId={modelId}
        spec={spec}
        compact={compact}
        selected={inSelected}
        onToggle={toggleInValue}
        onSetValues={setInValues}
        filters={cascadeFilters}
        cascade={cascadeOn}
      />
    ) : spec.variant === 'buttons' ? (
      <ButtonsSlicer
        modelId={modelId}
        spec={spec}
        compact={compact}
        selected={inSelected}
        onToggle={toggleInValue}
        filters={cascadeFilters}
        cascade={cascadeOn}
      />
    ) : spec.variant === 'relativeDate' ? (
      <RelativeDateSlicer
        spec={spec}
        compact={compact}
        activePresetId={activePresetId}
        hasClause={clause !== null}
        onPick={pickRelativePreset}
      />
    ) : (
      <DateRangeSlicer
        modelId={modelId}
        columnType={columnType}
        spec={spec}
        compact={compact}
        clause={clause}
        onChange={setClause}
        allowClear={spec.showClear !== false}
        filters={cascadeFilters}
      />
    );

  const showClear = hasSelection && spec.showClear !== false;
  /**
   * Variants that size (and scroll) their own body: wrapping them in an
   * overflow-y-auto would either clip a popover or produce the nested
   * double-scrollbar that half-clipped checklist rows.
   */
  const bodyManagesHeight =
    spec.variant === 'dropdown' ||
    spec.variant === 'dropdownMulti' ||
    spec.variant === 'checklist' ||
    spec.variant === 'buttons' ||
    spec.variant === 'dateRange';

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
            onClick={clearSelection}
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
                onClick={clearSelection}
              >
                <X size={11} />
              </RcdIconButton>
            )}
          </div>
        )}
        {/* The dropdown variants' popovers must escape the tile — no scroll
            container around them (overflow-y would clip the panel; the
            multi-select popover is portaled but keeps the same layout). The
            checklist/buttons bodies stretch to the tile and scroll internally. */}
        <div className={bodyManagesHeight ? 'min-h-0 flex-1' : 'min-h-0 flex-1 overflow-y-auto'}>
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
  onSetValues,
  filters,
  cascade,
}: {
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  selected: FilterValue[];
  onToggle: (value: FilterValue) => void;
  onSetValues: (values: FilterValue[]) => void;
  filters: FilterClause[];
  cascade: boolean;
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
        className={`flex w-full max-w-[18rem] items-center justify-between gap-1.5 rounded-md border bg-rcd-bg text-rcd-text transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10 ${
          compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1.5 text-sm'
        } ${active ? 'border-[var(--rcd-accent-interactive)]' : 'border-rcd-border'}`}
      >
        <span className="min-w-0 truncate">
          {active ? `${selected.length} selected` : 'All values'}
        </span>
        <ChevronDown size={13} className="shrink-0 text-rcd-muted" />
      </button>

      {open && (
        // Same panel the checklist tile and the multi-select popover render —
        // search, Select all/Clear, fades and cascade behave identically here.
        <div className="absolute left-0 top-full z-40 mt-1 flex max-h-80 w-72 max-w-[80vw] flex-col rounded-md border border-rcd-border bg-rcd-surface p-2 shadow-[var(--rcd-shadow-2)]">
          <SlicerChecklistPanel
            modelId={modelId}
            table={spec.table}
            column={spec.column}
            label={spec.label}
            compact={compact}
            selected={selected}
            onToggle={onToggle}
            onSetValues={onSetValues}
            filters={filters}
            cascade={cascade}
            fallbackRows={POPOVER_ROWS}
            autoHeight
            autoFocusSearch
          />
        </div>
      )}
    </div>
  );
}

/**
 * Multi-select dropdown: a summary trigger ("All" / "Gulf Coast" / "Gulf Coast
 * +2 more") opening a PORTALED popover that OVERLAYS the tile and everything
 * around it — anchored to the trigger rect, viewport-clamped. The panel inside
 * is the very same SlicerChecklistPanel the in-tile checklist variant renders,
 * so this variant is a strict superset: identical search, Select all / Clear,
 * scroll fades, "+N more" chip and cascade behavior, plus the overlay. Both
 * variants emit the same 'in' clause, so switching between them is lossless.
 */
function DropdownMultiSlicer({
  modelId,
  spec,
  compact,
  selected,
  onToggle,
  onSetValues,
  filters,
  cascade,
}: {
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  selected: FilterValue[];
  onToggle: (value: FilterValue) => void;
  onSetValues: (values: FilterValue[]) => void;
  filters: FilterClause[];
  cascade: boolean;
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
  const summary = summarizeSelection(selected);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={active ? `${spec.label}: ${summary.title}` : `${spec.label}: all values`}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex w-full max-w-[18rem] items-center justify-between gap-1.5 rounded-md border bg-rcd-bg text-rcd-text transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] dark:hover:bg-white/10 ${
          compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1.5 text-sm'
        } ${active ? 'border-[var(--rcd-accent-interactive)]' : 'border-rcd-border'}`}
      >
        {/* "First value +N more": the count is its own non-shrinking node, so
            a long first label ellipsizes around it instead of hiding it. */}
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="min-w-0 truncate">{active ? summary.first : summary.text}</span>
          {summary.moreCount > 0 && (
            <span className="shrink-0 text-rcd-text-2">+{summary.moreCount} more</span>
          )}
        </span>
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
              compact={compact}
              selected={selected}
              onToggle={onToggle}
              onSetValues={onSetValues}
              filters={filters}
              cascade={cascade}
              onClose={close}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The multi-select panel's positioning shell: fixed-position, anchored under
 * the trigger and clamped to the viewport (flips above when there is no room
 * below), re-measured whenever its own content resizes. Closes on outside
 * click, Escape, scrolling outside the panel, and window resize. The contents
 * are SlicerChecklistPanel — see DropdownMultiSlicer.
 */
function MultiValuePopover({
  anchor,
  modelId,
  spec,
  compact,
  selected,
  onToggle,
  onSetValues,
  filters,
  cascade,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  selected: FilterValue[];
  onToggle: (value: FilterValue) => void;
  onSetValues: (values: FilterValue[]) => void;
  filters: FilterClause[];
  cascade: boolean;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Anchor under the trigger, clamp to the viewport, flip above when the panel
  // would spill past the bottom. A ResizeObserver re-runs it whenever the list
  // grows/shrinks (values landing, a search narrowing the rows); the panel
  // stays hidden until the first measurement lands (no corner flash).
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const place = () => {
      const a = trigger.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      const x = Math.max(8, Math.min(a.left, window.innerWidth - rect.width - 8));
      let y = a.bottom + 4;
      if (y + rect.height > window.innerHeight - 8) {
        const above = a.top - rect.height - 4;
        y = above >= 8 ? above : Math.max(8, window.innerHeight - rect.height - 8);
      }
      setPos((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(card);
    return () => observer.disconnect();
  }, [anchor]);

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

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Select ${spec.label} values`}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? undefined : 'hidden' }}
      className="fixed z-50 flex max-h-80 w-72 max-w-[92vw] flex-col rounded-md border border-rcd-border bg-rcd-surface p-2 shadow-[var(--rcd-shadow-2)]"
    >
      <SlicerChecklistPanel
        modelId={modelId}
        table={spec.table}
        column={spec.column}
        label={spec.label}
        compact={compact}
        selected={selected}
        onToggle={onToggle}
        onSetValues={onSetValues}
        filters={filters}
        cascade={cascade}
        fallbackRows={POPOVER_ROWS}
        autoHeight
        autoFocusSearch
      />
    </div>
  );
}

interface ButtonsFetchState {
  status: 'loading' | 'ok' | 'error';
  values: FilterValue[];
  hasMore: boolean;
  error: string | null;
}

/* ------------------------------------------------------- buttons geometry
 * The size/gap/justify class sets and the two layout helpers moved VERBATIM to
 * dashboard/buttonLayout.ts in 0.14.1 so button TILES render through the same
 * vocabulary (A6). Nothing here changed shape: the local aliases keep every
 * call site below byte-identical, and the two helpers are re-exported because
 * callers (and slicerPills.test.ts) import them from this module.
 */

type ButtonSize = NonNullable<SlicerTileStyle['buttonSize']>;

export { slicerPillClasses, slicerButtonLayout };

/**
 * Value pills honoring the buttons-variant style block: size, fill (stretch to
 * share the width), fixed column grid, and horizontal/vertical placement of
 * the group inside the tile. Multi-select semantics are unchanged (each pill
 * toggles membership of the 'in' clause).
 *
 * The pill SET comes from the same distinct-values endpoint every other
 * variant uses (capped at BUTTONS_CAP), so cascade works here too: the cap'd
 * fetch simply carries the cascade clauses. Selected values the response no
 * longer contains are still rendered (dashed + dimmed) — a filter is never
 * silently invisible.
 */
function ButtonsSlicer({
  modelId,
  spec,
  compact,
  selected,
  onToggle,
  filters,
  cascade,
}: {
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  /** Multi-select: pills toggle membership of an 'in' clause. */
  selected: readonly FilterValue[];
  onToggle: (value: FilterValue) => void;
  filters: FilterClause[];
  cascade: boolean;
}) {
  const runtime = useRuntime();
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<ButtonsFetchState>({
    status: 'loading',
    values: [],
    hasMore: false,
    error: null,
  });

  const filtersKey = stableStringify(filters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    runtime.queries
      .distinct({
        modelId,
        table: spec.table,
        column: spec.column,
        search: null,
        // Cascade clauses ride into the shared distinct cache key.
        filters: [...filtersRef.current],
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
  }, [runtime, modelId, spec.table, spec.column, filtersKey, retryToken]);

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

  // Available pills (capped) plus any SELECTED value the response omitted —
  // pinned first so a filter is never invisible. Under cascade with a complete
  // response those pinned values are genuinely unavailable and render dimmed;
  // without cascade they merely fell past BUTTONS_CAP, so they stay normal.
  const available = state.values.slice(0, BUTTONS_CAP);
  const availableKeys = new Set(available.map(keyOf));
  const pinned = selected.filter((value) => !availableKeys.has(keyOf(value)));
  const listed = [...pinned, ...available];
  const dimPinned = cascade && state.status === 'ok' && !state.hasMore;
  const pinnedKeys = new Set(pinned.map(keyOf));
  const selectedKeys = new Set(selected.map(keyOf));

  if (listed.length === 0) {
    return (
      <p className="p-2 text-xs text-rcd-muted">
        {cascade ? 'No values remain under the other filters.' : 'No values to show.'}
      </p>
    );
  }

  const style = spec.style ?? {};
  const size: ButtonSize = style.buttonSize ?? (compact ? 'sm' : 'md');
  const align = style.buttonAlign ?? 'left';
  const verticalAlign = style.buttonVerticalAlign ?? 'top';
  const fill = style.buttonFill === true;
  const columns =
    typeof style.buttonColumns === 'number' && style.buttonColumns >= 1
      ? Math.min(Math.trunc(style.buttonColumns), 12)
      : null;

  const layout = slicerButtonLayout(size, align, fill, columns);

  return (
    // min-h-full on the inner column (rather than justify on the scroller)
    // keeps middle/bottom alignment reachable when the pills overflow.
    <div className="h-full min-h-0 overflow-y-auto p-0.5">
      <div className={`flex min-h-full flex-col ${BUTTON_VALIGN_CLASSES[verticalAlign]}`}>
        <div
          className={layout.group}
          style={
            layout.gridTemplateColumns !== undefined
              ? { gridTemplateColumns: layout.gridTemplateColumns }
              : undefined
          }
        >
          {listed.map((value) => {
            const key = keyOf(value);
            const isActive = selectedKeys.has(key);
            const unavailable = dimPinned && pinnedKeys.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isActive}
                onClick={() => onToggle(value)}
                title={
                  unavailable
                    ? `${String(value)} — selected, but no rows match it under the other filters`
                    : String(value)
                }
                // Uniform pill geometry (fixed height/radius, consistent gap);
                // the selected state is an accent FILL with inverted text; a
                // selected-but-unavailable value keeps the fill at low opacity
                // behind a dashed border so it still reads as "click to clear".
                className={`${slicerPillClasses(size)} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)] ${
                  layout.item
                } ${unavailable ? 'border-dashed italic opacity-50' : ''} ${
                  isActive
                    ? 'border-rcd-accent bg-rcd-accent font-medium text-white shadow-[var(--rcd-shadow-1)] hover:opacity-90'
                    : 'border-rcd-border bg-rcd-surface text-rcd-text-2 hover:border-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
                }`}
              >
                <span className="min-w-0 truncate">{String(value)}</span>
              </button>
            );
          })}
        </div>
        {state.hasMore && (
          <p
            className={`shrink-0 pt-1 text-[11px] text-rcd-muted ${
              align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left'
            }`}
            title="More values exist — switch this slicer to the checklist or dropdown variant to search them."
          >
            + more values
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Relative-date presets: a dropdown of rolling/period presets plus a custom
 * "Last N <unit>" row. Picking one compiles a fresh `between` clause from the
 * current clock; the preset id rides the runtime slicer value so refresh ticks
 * (and bookmark re-application) recompute dates instead of restoring stale
 * ones. 'All time' clears the filter.
 */
function RelativeDateSlicer({
  spec,
  compact,
  activePresetId,
  hasClause,
  onPick,
}: {
  spec: SlicerTileSpec;
  compact: boolean;
  /** Preset id riding the runtime value; null = none active. */
  activePresetId: string | null;
  hasClause: boolean;
  onPick: (presetId: string) => void;
}) {
  const custom = activePresetId ? parseCustomPreset(activePresetId) : null;
  // "Last N" is a RAW STRING draft, committed on blur/Enter/unit-pick only
  // (FilterEditor pattern). Binding a coerced number per keystroke made the
  // box uneditable — clearing wrote "1" back with the caret after it, so
  // typing 45 yielded 145 — and pushed one undo entry + a full layout clone
  // per character through updateSlicer.
  const [customNDraft, setCustomNDraft] = useState(() => String(custom?.n ?? 30));
  const [customUnit, setCustomUnit] = useState<RelativeUnit>(custom?.unit ?? 'day');

  // Re-sync the drafts whenever the ACTIVE preset's parsed parts change:
  // activePresetId moves under this component (bookmark apply, the persisted
  // default-preset effect), and seed-once state then applied a stale N on the
  // next unit-only change ("Last 90 days" silently became "Last 30"). Keyed
  // on the parsed n/unit so a user mid-typing (draft diverged, preset
  // unchanged) is never clobbered.
  useEffect(() => {
    if (custom === null) return;
    setCustomNDraft(String(custom.n));
    setCustomUnit(custom.unit);
  }, [custom?.n, custom?.unit]);

  // The select shows 'custom' while a lastN preset is active.
  const selectValue = custom !== null ? 'custom' : (activePresetId ?? (hasClause ? 'custom' : 'all'));

  const applyCustom = (n: number, unit: RelativeUnit) => {
    if (n > 0) onPick(customPresetId(n, unit));
  };

  /** Draft -> positive integer; null when it holds nothing usable. */
  const parseDraftN = (draft: string): number | null => {
    const n = Math.trunc(Number(draft));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  /** Blur/Enter commit: apply a usable draft, else restore the active value. */
  const commitCustomN = () => {
    const n = parseDraftN(customNDraft);
    if (n !== null) {
      setCustomNDraft(String(n));
      applyCustom(n, customUnit);
    } else {
      setCustomNDraft(String(custom?.n ?? 30));
    }
  };

  const selectClasses = compact ? 'h-7 w-full text-xs' : 'w-full';

  return (
    <div className={compact ? 'flex max-w-[18rem] flex-col gap-1 p-0.5' : 'flex max-w-[18rem] flex-col gap-2 p-0.5'}>
      <RcdSelect
        aria-label={`${spec.label} preset`}
        value={selectValue}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'custom') applyCustom(parseDraftN(customNDraft) ?? 30, customUnit);
          else onPick(next);
        }}
        className={selectClasses}
        title={activePresetId ? relativePresetLabel(activePresetId) : undefined}
      >
        {RELATIVE_DATE_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </RcdSelect>

      {selectValue === 'custom' && (
        <div className="flex items-center gap-1.5">
          <span className={compact ? 'text-[11px] text-rcd-text-2' : 'text-xs text-rcd-text-2'}>
            Last
          </span>
          <RcdInput
            type="number"
            min={1}
            value={customNDraft}
            onChange={(event) => setCustomNDraft(event.target.value)}
            onBlur={commitCustomN}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitCustomN();
            }}
            aria-label={`${spec.label} custom window size`}
            className={compact ? 'h-7 w-16 text-xs' : 'w-16'}
          />
          <RcdSelect
            value={customUnit}
            onChange={(event) => {
              const unit = event.target.value as RelativeUnit;
              setCustomUnit(unit);
              // Unit picks commit immediately (a select carries no
              // mid-typing state) with the draft N coerced, falling back to
              // the ACTIVE parsed N so a blank draft never applies "Last 1".
              applyCustom(parseDraftN(customNDraft) ?? custom?.n ?? 30, unit);
            }}
            aria-label={`${spec.label} custom window unit`}
            className={compact ? 'h-7 min-w-0 flex-1 text-xs' : 'min-w-0 flex-1'}
          >
            {RELATIVE_UNITS.map((unit) => (
              <option key={unit.value} value={unit.value}>
                {unit.label}
              </option>
            ))}
          </RcdSelect>
        </div>
      )}
    </div>
  );
}

/**
 * Field-parameter slicer body: the parameter's options as single-select pills
 * (≤ 6 options) or a dropdown, driving the transient parameterSelections
 * state. Charts bound to the parameter re-query on selection change (their
 * cache key changes with the substituted axis/measure).
 */
function FieldParamSlicer({
  spec,
  compact,
  parameter,
  selectedIndex,
  onPick,
}: {
  spec: SlicerTileSpec;
  compact: boolean;
  parameter: DashboardParameter | null;
  selectedIndex: number;
  onPick: (index: number) => void;
}) {
  if (parameter === null || parameter.options.length === 0) {
    return (
      <p className="p-2 text-xs text-rcd-muted">
        {spec.parameterId
          ? 'The field parameter behind this slicer no longer exists.'
          : 'No field parameter is configured for this slicer.'}
      </p>
    );
  }

  if (parameter.options.length > 6) {
    return (
      <div className="max-w-[18rem] p-0.5">
        <RcdSelect
          aria-label={`${spec.label} selection`}
          value={String(selectedIndex)}
          onChange={(event) => onPick(Number(event.target.value))}
          className={compact ? 'h-7 w-full text-xs' : 'w-full'}
        >
          {parameter.options.map((option, index) => (
            <option key={index} value={String(index)}>
              {option.label}
            </option>
          ))}
        </RcdSelect>
      </div>
    );
  }

  // Same pill geometry as ButtonsSlicer (slicerPillClasses): the field-param
  // pills used to hard-code their own divergent sizing and ignored
  // style.buttonSize entirely, so mixed slicer tiles looked mismatched.
  const size: ButtonSize = spec.style?.buttonSize ?? (compact ? 'sm' : 'md');
  return (
    <div className={`flex flex-wrap content-start items-center ${BUTTON_GAP_CLASSES[size]} p-0.5`}>
      {parameter.options.map((option, index) => {
        const isActive = index === selectedIndex;
        return (
          <button
            key={index}
            type="button"
            aria-pressed={isActive}
            onClick={() => onPick(index)}
            title={option.label}
            className={`${slicerPillClasses(size)} max-w-full ${
              isActive
                ? 'border-rcd-accent bg-rcd-accent font-medium text-white hover:opacity-90'
                : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
            }`}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Two date endpoints: both = between, one-sided = gte/lte (DATE-ONLY
 * 'YYYY-MM-DD' strings, never local ISO timestamps). The 'native' picker keeps
 * the browser date inputs (default); 'calendar' swaps in the popover calendar
 * with data-availability marks. Both paths clear to null — never to an
 * empty-string range that would filter everything out.
 */
function DateRangeSlicer({
  modelId,
  spec,
  compact,
  clause,
  columnType,
  onChange,
  allowClear,
  filters,
}: {
  modelId: number;
  spec: SlicerTileSpec;
  compact: boolean;
  clause: FilterClause | null;
  /** Catalog type of spec.column; null = unresolved (assume plain `date`). */
  columnType: ColumnType | null;
  onChange: (clause: FilterClause | null) => void;
  /** spec.showClear !== false — gates the inline clear affordance. */
  allowClear: boolean;
  /** Cascade clauses; scope the calendar's data-availability marks. */
  filters: FilterClause[];
}) {
  const [from, to] = useMemo<[string, string]>(() => {
    if (!clause) return ['', ''];
    // An upper endpoint on a timestamp column carries the day's last instant;
    // the date inputs and the calendar speak only bare 'yyyy-MM-dd', so read
    // every endpoint back as its day.
    const dayAt = (index: number): string => {
      const raw = clause.values[index];
      return typeof raw === 'string' ? (dateOnlyPartOf(raw) ?? '') : '';
    };
    if (clause.operator === 'between') return [dayAt(0), dayAt(1)];
    if (clause.operator === 'gte') return [dayAt(0), ''];
    if (clause.operator === 'lte') return ['', dayAt(0)];
    return ['', ''];
  }, [clause]);

  const update = (nextFrom: string, nextTo: string) => {
    const base = { table: spec.table, column: spec.column };
    // Lower bounds stay bare: midnight already includes the whole first day
    // at either resolution. Upper bounds must match the column's resolution.
    const upper = inclusiveDateUpperBound(nextTo, columnType);
    if (nextFrom !== '' && nextTo !== '') {
      onChange({ ...base, operator: 'between', values: [nextFrom, upper] });
    } else if (nextFrom !== '') {
      onChange({ ...base, operator: 'gte', values: [nextFrom] });
    } else if (nextTo !== '') {
      onChange({ ...base, operator: 'lte', values: [upper] });
    } else {
      onChange(null);
    }
  };

  const options = spec.dateRange ?? {};
  const hasRange = from !== '' || to !== '';

  if (options.picker === 'calendar') {
    return (
      <SlicerCalendarFields
        modelId={modelId}
        table={spec.table}
        column={spec.column}
        label={spec.label}
        compact={compact}
        options={options}
        from={from}
        to={to}
        onChange={update}
        showClear={allowClear}
        filters={filters}
      />
    );
  }

  // w-full + max-w: each field caps at 18rem but still shrinks in narrow
  // tiles; flex-wrap puts From/To side by side when the tile is wide enough.
  const labelClasses = compact
    ? 'flex w-full max-w-[18rem] flex-col gap-0.5 text-[11px] text-rcd-text-2'
    : 'flex w-full max-w-[18rem] flex-col gap-1 text-xs text-rcd-text-2';
  const inputClasses = compact ? 'h-7 w-full text-xs' : 'w-full';

  return (
    <div className={compact ? 'flex flex-col gap-1 p-0.5' : 'flex flex-col gap-2 p-0.5'}>
      <div className={compact ? 'flex flex-wrap gap-1' : 'flex flex-wrap gap-2'}>
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
      {allowClear && hasRange && (
        // Explicit "back to all dates": emptying both native inputs is fiddly
        // (and some browsers refuse), so the range gets its own clear.
        <div className="flex">
          <RcdButton
            variant="ghost"
            size="sm"
            className={compact ? '!h-6 !px-1.5 !text-[11px]' : '!px-2'}
            title="Clear the date range (back to all dates)"
            onClick={() => onChange(null)}
          >
            <X size={12} />
            Clear dates
          </RcdButton>
        </div>
      )}
    </div>
  );
}
