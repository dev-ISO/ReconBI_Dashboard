import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FilterX, Trash2 } from 'lucide-react';
import type {
  DateRangeOptions,
  SlicerTileSpec,
  SlicerTileStyle,
  SlicerVariant,
} from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdInput, RcdSelect } from '../primitives';
import { monthOf, todayDateOnly } from './SlicerCalendar';

export interface SlicerConfigMenuProps {
  tileId: string;
  spec: SlicerTileSpec;
  /** Chart tiles selectable as slicer targets. */
  chartTiles: { id: string; title: string }[];
  /** Full config in edit mode; view mode shows only Clear + a read-only summary. */
  editable: boolean;
  /** Enables the Clear selection action. */
  hasSelection: boolean;
  /** Screen coordinates (cursor or kebab); the card clamps itself to the viewport. */
  position: { x: number; y: number };
  onClose: () => void;
}

/** yyyy-MM pin accepted by DateRangeOptions.initialMonth. */
const MONTH_PIN = /^\d{4}-(0[1-9]|1[0-2])$/;

const VARIANTS: { value: SlicerVariant; label: string; hint?: string }[] = [
  { value: 'checklist', label: 'Checklist', hint: 'Searchable list filling the tile' },
  { value: 'dropdown', label: 'Dropdown', hint: 'Panel drops inside the tile' },
  {
    value: 'dropdownMulti',
    label: 'Dropdown (overlay)',
    hint: 'Same list, floating over the dashboard',
  },
  { value: 'buttons', label: 'Buttons' },
  { value: 'dateRange', label: 'Date range' },
  { value: 'relativeDate', label: 'Relative date' },
];

/**
 * Variants that list the column's distinct values. They all emit exactly one
 * `in` clause over the slicer's column, so switching between them is LOSSLESS
 * (the selection carries over) and the cascade toggle applies to all of them.
 * The date variants (between/gte/lte) and fieldParam (no clause) are separate
 * families — crossing families still clears, since the old clause shape means
 * nothing to the new body.
 */
const VALUE_LISTING_VARIANTS: ReadonlySet<SlicerVariant> = new Set<SlicerVariant>([
  'checklist',
  'dropdown',
  'dropdownMulti',
  'buttons',
]);

/** True when a selection made under `from` is still valid under `to`. */
const clauseShapeSurvives = (from: SlicerVariant, to: SlicerVariant): boolean =>
  VALUE_LISTING_VARIANTS.has(from) && VALUE_LISTING_VARIANTS.has(to);

/**
 * Right-click / kebab configuration card for a slicer tile. A fixed-position
 * card (NOT a native context menu) closed by outside click or Escape. The
 * caller portals it to document.body so grid-item transforms cannot skew the
 * fixed coordinates.
 */
export function SlicerConfigMenu({
  tileId,
  spec,
  chartTiles,
  editable,
  hasSelection,
  position,
  onClose,
}: SlicerConfigMenuProps) {
  const runtime = useRuntime();
  // Stable fallback — a fresh [] per snapshot would loop useSyncExternalStore.
  const parameters = useDashboardState((state) => state.current?.layout.parameters) ?? [];
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [labelDraft, setLabelDraft] = useState(spec.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Draft for the pinned "opens on" month (committed on blur/Enter if valid).
  const [monthDraft, setMonthDraft] = useState(() => {
    const configured = spec.dateRange?.initialMonth;
    return typeof configured === 'string' && MONTH_PIN.test(configured)
      ? configured
      : monthOf(todayDateOnly());
  });

  // Clamp to the viewport once the card has a measured size.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 4)),
    });
  }, [position]);

  // Outside click / Escape closes (the remove confirm owns the keyboard then).
  useEffect(() => {
    if (confirmRemove) return;
    const onPointerDown = (event: MouseEvent) => {
      if (cardRef.current && event.target instanceof Node && !cardRef.current.contains(event.target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, confirmRemove]);

  const setVariant = (variant: SlicerVariant) => {
    if (variant === spec.variant) return;
    runtime.dashboards.updateSlicer(tileId, { variant });
    // Variants build different clause shapes (in / eq / between), so a stale
    // selection from another FAMILY must not keep filtering charts. Within the
    // value-listing family the clause is identical ('in' over this column), so
    // the switch is lossless — checklist ⇄ dropdown ⇄ overlay dropdown ⇄
    // buttons all keep what the user had picked.
    if (!clauseShapeSurvives(spec.variant, variant)) {
      runtime.dashboards.setSlicerValue(tileId, null);
    }
  };

  const commitLabel = () => {
    const next = labelDraft.trim();
    if (next !== '' && next !== spec.label) runtime.dashboards.updateSlicer(tileId, { label: next });
    else setLabelDraft(spec.label);
  };

  const allCharts = spec.targets == null;
  const targets = spec.targets ?? [];

  const toggleAllCharts = () => {
    runtime.dashboards.updateSlicer(tileId, {
      targets: allCharts ? chartTiles.map((t) => t.id) : null,
    });
  };

  const toggleTarget = (chartId: string) => {
    const next = targets.includes(chartId)
      ? targets.filter((id) => id !== chartId)
      : [...targets, chartId];
    runtime.dashboards.updateSlicer(tileId, { targets: next });
  };

  const clearSelection = () => {
    runtime.dashboards.setSlicerValue(tileId, null);
    onClose();
  };

  const style = spec.style ?? {};
  const dateRange = spec.dateRange ?? {};

  /**
   * The cascade toggle applies wherever the slicer LISTS values from the
   * column — every value-listing variant, plus the calendar picker (whose
   * availability marks come from the same distinct query).
   */
  const showCascade =
    VALUE_LISTING_VARIANTS.has(spec.variant) ||
    (spec.variant === 'dateRange' && dateRange.picker === 'calendar');

  /** Flips one visual-mode flag, preserving the other (style patches whole). */
  const toggleStyleFlag = (flag: 'hideHeader' | 'compact') => {
    runtime.dashboards.updateSlicer(tileId, {
      style: { ...style, [flag]: !(style[flag] === true) },
    });
  };

  /** Style patches replace the whole block — always spread the current one. */
  const patchStyle = (patch: Partial<SlicerTileStyle>) => {
    runtime.dashboards.updateSlicer(tileId, { style: { ...style, ...patch } });
  };

  /** Same for the dateRange block (picker/initialMonth/showAvailability). */
  const patchDateRange = (patch: Partial<DateRangeOptions>) => {
    runtime.dashboards.updateSlicer(tileId, { dateRange: { ...dateRange, ...patch } });
  };

  const initialMonth = dateRange.initialMonth ?? null;
  const pinnedMonth = typeof initialMonth === 'string' && MONTH_PIN.test(initialMonth)
    ? initialMonth
    : null;
  const initialMonthMode =
    initialMonth === 'dataStart' || initialMonth === 'dataEnd'
      ? initialMonth
      : pinnedMonth !== null
        ? 'pinned'
        : 'current';

  const appliesToSummary = allCharts
    ? 'All charts'
    : targets.length === 0
      ? 'No charts'
      : chartTiles
          .filter((t) => targets.includes(t.id))
          .map((t) => t.title)
          .join(', ') || 'No charts';

  return (
    <>
      <div
        ref={cardRef}
        role="menu"
        aria-label={`Configure slicer ${spec.label}`}
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed z-50 flex w-64 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
      >
        {editable ? (
          <>
            {spec.variant === 'fieldParam' ? (
              // Field-param slicers have no column: instead of variant radios
              // they pick WHICH dashboard parameter the tile drives.
              <>
                <SectionLabel>Parameter</SectionLabel>
                <div className="px-3 pb-1">
                  <RcdSelect
                    aria-label="Field parameter"
                    value={spec.parameterId ?? ''}
                    onChange={(event) =>
                      runtime.dashboards.updateSlicer(tileId, {
                        parameterId: event.target.value || null,
                      })
                    }
                    className="w-full"
                  >
                    <option value="">Choose a parameter…</option>
                    {parameters.map((parameter) => (
                      <option key={parameter.id} value={parameter.id}>
                        {parameter.name}
                      </option>
                    ))}
                  </RcdSelect>
                </div>
              </>
            ) : (
              <>
                <SectionLabel>Variant</SectionLabel>
                {VARIANTS.map((variant) => (
                  <label
                    key={variant.value}
                    className="flex cursor-pointer items-start gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <input
                      type="radio"
                      name={`rcd-slicer-variant-${tileId}`}
                      className="mt-1 accent-[var(--rcd-accent)]"
                      checked={spec.variant === variant.value}
                      onChange={() => setVariant(variant.value)}
                    />
                    <span className="min-w-0 flex-1">
                      {variant.label}
                      {variant.hint && (
                        <span className="block text-[11px] leading-tight text-rcd-muted">
                          {variant.hint}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                <p className="px-3 pb-1 pt-0.5 text-[11px] leading-tight text-rcd-muted">
                  Checklist, dropdown and buttons share one selection — switching
                  between them keeps what you picked.
                </p>
              </>
            )}

            <Divider />
            <SectionLabel>Label</SectionLabel>
            <div className="px-3 pb-1">
              <RcdInput
                value={labelDraft}
                onChange={(event) => setLabelDraft(event.target.value)}
                onBlur={commitLabel}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitLabel();
                }}
                aria-label="Slicer label"
                className="w-full"
              />
            </div>

            <Divider />
            <SectionLabel>Appearance</SectionLabel>
            <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10">
              <input
                type="checkbox"
                className="accent-[var(--rcd-accent)]"
                checked={style.hideHeader === true}
                onChange={() => toggleStyleFlag('hideHeader')}
              />
              Frameless
            </label>
            <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10">
              <input
                type="checkbox"
                className="accent-[var(--rcd-accent)]"
                checked={style.compact === true}
                onChange={() => toggleStyleFlag('compact')}
              />
              Compact
            </label>

            {showCascade && (
              <>
                <Divider />
                <SectionLabel>Available values</SectionLabel>
                <label className="flex cursor-pointer items-start gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--rcd-accent)]"
                    checked={spec.cascade === true}
                    onChange={() =>
                      runtime.dashboards.updateSlicer(tileId, { cascade: !(spec.cascade === true) })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    Filter available values by other filters
                    <span className="block text-[11px] leading-tight text-rcd-muted">
                      {spec.variant === 'dateRange'
                        ? 'Marks only the days that survive the other slicers and cross-filters.'
                        : 'Lists only values that survive the other slicers and cross-filters on this page. Values you already picked stay listed, dimmed.'}
                    </span>
                  </span>
                </label>
              </>
            )}

            {spec.variant === 'buttons' && (
              <>
                <Divider />
                <SectionLabel>Buttons</SectionLabel>
                <MenuRow label="Size">
                  <RcdSelect
                    aria-label="Button size"
                    value={style.buttonSize ?? 'md'}
                    onChange={(event) =>
                      patchStyle({ buttonSize: event.target.value as SlicerTileStyle['buttonSize'] })
                    }
                    className="h-7 w-full text-xs"
                  >
                    <option value="sm">Small</option>
                    <option value="md">Medium</option>
                    <option value="lg">Large</option>
                  </RcdSelect>
                </MenuRow>
                <MenuRow label="Columns">
                  <RcdSelect
                    aria-label="Button columns"
                    value={
                      typeof style.buttonColumns === 'number' && style.buttonColumns >= 1
                        ? String(style.buttonColumns)
                        : 'auto'
                    }
                    onChange={(event) =>
                      patchStyle({
                        buttonColumns:
                          event.target.value === 'auto' ? null : Number(event.target.value),
                      })
                    }
                    className="h-7 w-full text-xs"
                  >
                    <option value="auto">Auto (wrap)</option>
                    {[1, 2, 3, 4, 5, 6].map((count) => (
                      <option key={count} value={String(count)}>
                        {count}
                      </option>
                    ))}
                  </RcdSelect>
                </MenuRow>
                <MenuRow label="Align">
                  <RcdSelect
                    aria-label="Button horizontal alignment"
                    value={style.buttonAlign ?? 'left'}
                    onChange={(event) =>
                      patchStyle({
                        buttonAlign: event.target.value as SlicerTileStyle['buttonAlign'],
                      })
                    }
                    className="h-7 w-full text-xs"
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </RcdSelect>
                </MenuRow>
                <MenuRow label="Vertical">
                  <RcdSelect
                    aria-label="Button vertical alignment"
                    value={style.buttonVerticalAlign ?? 'top'}
                    onChange={(event) =>
                      patchStyle({
                        buttonVerticalAlign: event.target
                          .value as SlicerTileStyle['buttonVerticalAlign'],
                      })
                    }
                    className="h-7 w-full text-xs"
                  >
                    <option value="top">Top</option>
                    <option value="middle">Middle</option>
                    <option value="bottom">Bottom</option>
                  </RcdSelect>
                </MenuRow>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10">
                  <input
                    type="checkbox"
                    className="accent-[var(--rcd-accent)]"
                    checked={style.buttonFill === true}
                    onChange={() => patchStyle({ buttonFill: !(style.buttonFill === true) })}
                  />
                  Stretch to fill width
                </label>
              </>
            )}

            {spec.variant === 'dateRange' && (
              <>
                <Divider />
                <SectionLabel>Date range</SectionLabel>
                <MenuRow label="Picker">
                  <RcdSelect
                    aria-label="Date picker style"
                    value={dateRange.picker ?? 'native'}
                    onChange={(event) =>
                      patchDateRange({ picker: event.target.value as DateRangeOptions['picker'] })
                    }
                    className="h-7 w-full text-xs"
                  >
                    <option value="native">Native inputs</option>
                    <option value="calendar">Calendar</option>
                  </RcdSelect>
                </MenuRow>
                {dateRange.picker === 'calendar' && (
                  <>
                    <MenuRow label="Opens on">
                      <RcdSelect
                        aria-label="Calendar initial month"
                        value={initialMonthMode}
                        onChange={(event) => {
                          const mode = event.target.value;
                          patchDateRange({
                            initialMonth:
                              mode === 'current'
                                ? null
                                : mode === 'pinned'
                                  ? (MONTH_PIN.test(monthDraft)
                                      ? monthDraft
                                      : monthOf(todayDateOnly()))
                                  : (mode as 'dataStart' | 'dataEnd'),
                          });
                        }}
                        className="h-7 w-full text-xs"
                      >
                        <option value="current">Current month</option>
                        <option value="dataStart">First month with data</option>
                        <option value="dataEnd">Last month with data</option>
                        <option value="pinned">Specific month…</option>
                      </RcdSelect>
                    </MenuRow>
                    {initialMonthMode === 'pinned' && (
                      <div className="px-3 pb-1">
                        <RcdInput
                          value={monthDraft}
                          placeholder="YYYY-MM"
                          aria-label="Calendar initial month (YYYY-MM)"
                          onChange={(event) => setMonthDraft(event.target.value)}
                          onBlur={() => {
                            if (MONTH_PIN.test(monthDraft)) patchDateRange({ initialMonth: monthDraft });
                            else setMonthDraft(pinnedMonth ?? monthOf(todayDateOnly()));
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && MONTH_PIN.test(monthDraft)) {
                              patchDateRange({ initialMonth: monthDraft });
                            }
                          }}
                          className="h-7 w-full text-xs"
                        />
                      </div>
                    )}
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10">
                      <input
                        type="checkbox"
                        className="accent-[var(--rcd-accent)]"
                        checked={dateRange.showAvailability !== false}
                        onChange={() =>
                          patchDateRange({ showAvailability: !(dateRange.showAvailability !== false) })
                        }
                      />
                      Mark days with data
                    </label>
                  </>
                )}
              </>
            )}

            {spec.variant !== 'fieldParam' && (
              <>
                <Divider />
                <SectionLabel>Applies to</SectionLabel>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10">
                  <input
                    type="checkbox"
                    className="accent-[var(--rcd-accent)]"
                    checked={allCharts}
                    onChange={toggleAllCharts}
                  />
                  All charts
                </label>
                {!allCharts && (
                  <div className="max-h-40 overflow-y-auto">
                    {chartTiles.length === 0 ? (
                      <p className="px-3 py-1 text-xs text-rcd-muted">No charts on this dashboard.</p>
                    ) : (
                      chartTiles.map((chart) => (
                        <label
                          key={chart.id}
                          className="flex cursor-pointer items-center gap-2 py-1 pl-6 pr-3 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          <input
                            type="checkbox"
                            className="accent-[var(--rcd-accent)]"
                            checked={targets.includes(chart.id)}
                            onChange={() => toggleTarget(chart.id)}
                          />
                          <span className="min-w-0 truncate" title={chart.title}>
                            {chart.title}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <p className="px-3 py-1.5 text-xs text-rcd-muted">
            Applies to: <span className="text-rcd-text-2">{appliesToSummary}</span>
          </p>
        )}

        <Divider />
        <button
          type="button"
          role="menuitem"
          disabled={!hasSelection}
          onClick={clearSelection}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
        >
          <FilterX size={14} />
          Clear selection
        </button>
        {editable && (
          <button
            type="button"
            role="menuitem"
            onClick={() => setConfirmRemove(true)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Trash2 size={14} />
            Remove slicer
          </button>
        )}
      </div>

      <ConfirmDialog
        title="Remove slicer"
        message={`Remove the "${spec.label}" slicer? Its filter no longer applies to any chart.`}
        confirmLabel="Remove"
        danger
        open={confirmRemove}
        onConfirm={() => {
          setConfirmRemove(false);
          runtime.dashboards.removeSlicer(tileId);
          onClose();
        }}
        onCancel={() => {
          setConfirmRemove(false);
          onClose();
        }}
      />
    </>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
      {children}
    </p>
  );
}

function Divider() {
  return <div className="my-1 border-t border-rcd-border" />;
}

/** Label + control row for the compact settings sections (buttons/date range). */
function MenuRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-0.5">
      <span className="w-16 shrink-0 text-sm text-rcd-text">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
