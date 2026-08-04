import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, RefreshCw, X } from 'lucide-react';
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
      <div
        className={
          compact ? '[&_label]:gap-1.5 [&_label]:py-0.5 [&_label]:text-xs' : ''
        }
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
        {/* The dropdown's popover must escape the tile — no scroll container
            around it (overflow-y would clip the absolutely-positioned panel). */}
        <div
          className={
            spec.variant === 'dropdown' ? 'min-h-0 flex-1' : 'min-h-0 flex-1 overflow-y-auto'
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
        className={`flex w-full items-center justify-between gap-1.5 rounded-md border bg-rcd-bg text-rcd-text transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
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
    <div className="flex flex-wrap content-start items-start gap-1.5 p-0.5">
      {state.values.slice(0, BUTTONS_CAP).map((value) => {
        const isActive = selected.includes(value);
        return (
          <button
            key={`${typeof value}:${String(value)}`}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(value)}
            title={String(value)}
            className={`max-w-full truncate rounded-full border transition-colors ${
              compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
            } ${
              isActive
                ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_15%,transparent)] font-medium text-rcd-accent'
                : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
            }`}
          >
            {String(value)}
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

  const labelClasses = compact
    ? 'flex flex-col gap-0.5 text-[11px] text-rcd-text-2'
    : 'flex flex-col gap-1 text-xs text-rcd-text-2';
  const inputClasses = compact ? 'h-7 text-xs' : '';

  return (
    <div className={compact ? 'flex flex-col gap-1 p-0.5' : 'flex flex-col gap-2 p-0.5'}>
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
