import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FilterX, X } from 'lucide-react';
import type { FilterClause, FilterValue, SlicerDef } from '@recon/dashboards-core';
import { DistinctValueList } from '../chart-builder/DistinctValueList';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton } from '../primitives';

export interface SlicerBarProps {
  /** The dashboard's model — slicer values are distinct values from it. */
  modelId: number;
  /** Shows the remove (x) affordance on each chip. */
  editable: boolean;
}

const NO_SLICERS: SlicerDef[] = [];

/**
 * One row of slicer chips above the dashboard grid (both modes). Each chip
 * opens a searchable checklist popover; selections become 'in' FilterClauses
 * in the store, which DashboardView merges into every tile's query.
 */
export function SlicerBar({ modelId, editable }: SlicerBarProps) {
  const runtime = useRuntime();
  // Defensive ?? — layout docs saved before slicers existed lack the array.
  const slicers = useDashboardState((state) => state.current?.layout.slicers ?? NO_SLICERS);
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const [pendingRemove, setPendingRemove] = useState<SlicerDef | null>(null);

  if (slicers.length === 0) return null;

  const anyActive = slicers.some((slicer) => {
    const clause = slicerValues[slicer.id];
    return clause != null && clause.values.length > 0;
  });

  const clearAll = () => {
    for (const slicer of slicers) {
      if (slicerValues[slicer.id] != null) runtime.dashboards.setSlicerValue(slicer.id, null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rcd-border bg-rcd-surface px-3 py-2">
      {slicers.map((slicer) => (
        <SlicerChip
          key={slicer.id}
          slicer={slicer}
          modelId={modelId}
          clause={slicerValues[slicer.id] ?? null}
          editable={editable}
          onChange={(clause) => runtime.dashboards.setSlicerValue(slicer.id, clause)}
          onRemove={() => setPendingRemove(slicer)}
        />
      ))}

      <div className="min-w-0 flex-1" />

      {anyActive && (
        <button
          type="button"
          onClick={clearAll}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rcd-border px-3 py-1 text-sm text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
        >
          <FilterX size={13} />
          Clear filters
        </button>
      )}

      <ConfirmDialog
        title="Remove slicer"
        message={
          pendingRemove
            ? `Remove the "${pendingRemove.label}" slicer? Its filter no longer applies to any chart.`
            : 'Remove this slicer?'
        }
        confirmLabel="Remove"
        danger
        open={pendingRemove !== null}
        onConfirm={() => {
          if (pendingRemove) runtime.dashboards.removeSlicer(pendingRemove.id);
          setPendingRemove(null);
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

function SlicerChip({
  slicer,
  modelId,
  clause,
  editable,
  onChange,
  onRemove,
}: {
  slicer: SlicerDef;
  modelId: number;
  clause: FilterClause | null;
  editable: boolean;
  onChange: (clause: FilterClause | null) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the popover on outside click / Escape.
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

  const selected = clause?.values ?? [];
  const active = selected.length > 0;

  const toggle = (value: FilterValue) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(
      next.length > 0
        ? { table: slicer.table, column: slicer.column, operator: 'in', values: next }
        : null,
    );
  };

  return (
    <div className="relative" ref={rootRef}>
      <div
        className={`flex items-center overflow-hidden rounded-full border bg-rcd-bg transition-colors ${
          active ? 'border-rcd-accent' : 'border-rcd-border'
        }`}
      >
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
        >
          <span className="max-w-[10rem] truncate font-medium" title={slicer.label}>
            {slicer.label}
          </span>
          {active && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--rcd-accent)_15%,transparent)] px-1.5 text-[11px] font-semibold text-rcd-accent">
              {selected.length}
            </span>
          )}
          <ChevronDown size={13} className="text-rcd-muted" />
        </button>
        {editable && (
          <button
            type="button"
            aria-label={`Remove slicer ${slicer.label}`}
            title="Remove slicer"
            onClick={onRemove}
            className="py-1 pl-0.5 pr-2 text-rcd-muted hover:text-rcd-text"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-md border border-rcd-border bg-rcd-surface p-2 shadow-lg">
          <DistinctValueList
            modelId={modelId}
            table={slicer.table}
            column={slicer.column}
            selected={selected}
            onToggle={toggle}
          />
          {active && (
            <div className="flex justify-end pt-2">
              <RcdButton variant="ghost" onClick={() => onChange(null)}>
                Clear selection
              </RcdButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
