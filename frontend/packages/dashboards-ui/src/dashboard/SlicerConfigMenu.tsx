import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FilterX, Trash2 } from 'lucide-react';
import type { SlicerTileSpec, SlicerVariant } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdInput } from '../primitives';

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

const VARIANTS: { value: SlicerVariant; label: string }[] = [
  { value: 'checklist', label: 'Checklist' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'dropdownMulti', label: 'Dropdown (multi-select)' },
  { value: 'buttons', label: 'Buttons' },
  { value: 'dateRange', label: 'Date range' },
];

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
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [labelDraft, setLabelDraft] = useState(spec.label);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
    // Variants build different clause shapes (in / eq / between) — a stale
    // selection from the old variant must not keep filtering charts.
    runtime.dashboards.setSlicerValue(tileId, null);
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

  /** Flips one visual-mode flag, preserving the other (style patches whole). */
  const toggleStyleFlag = (flag: 'hideHeader' | 'compact') => {
    runtime.dashboards.updateSlicer(tileId, {
      style: { ...style, [flag]: !(style[flag] === true) },
    });
  };

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
        className="fixed z-50 flex w-64 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-lg"
      >
        {editable ? (
          <>
            <SectionLabel>Variant</SectionLabel>
            {VARIANTS.map((variant) => (
              <label
                key={variant.value}
                className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
              >
                <input
                  type="radio"
                  name={`rcd-slicer-variant-${tileId}`}
                  className="accent-[var(--rcd-accent)]"
                  checked={spec.variant === variant.value}
                  onChange={() => setVariant(variant.value)}
                />
                {variant.label}
              </label>
            ))}

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
