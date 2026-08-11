import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FilterX, ListChecks, X } from 'lucide-react';
import type { CellValue, FilterValue } from '@recon/dashboards-core';
import { RcdButton, RcdSpinner } from '../primitives';

export interface FilterChipMenuProps {
  /** Chip text the menu is about, e.g. "region: Gulf Coast". */
  entryLabel: string;
  position: { x: number; y: number };
  /**
   * Edit-value support: present only for discrete cross-filter chips
   * (eq/in/isNull) with a model attached. Date-range chips and slicer chips
   * (which own richer pickers on their tiles) get the clear actions only.
   */
  edit?: {
    /** Currently selected raw values (blanks excluded — see loadValues). */
    current: FilterValue[];
    /**
     * The field's distinct values, via the same distinct-values API slicers
     * use. Non-null values only; capped by the caller.
     */
    loadValues: () => Promise<CellValue[]>;
    /** Writes the checked set back through the store's accumulation path. */
    onApply: (values: FilterValue[]) => void;
  } | null;
  onClearThis: () => void;
  onClearAll: () => void;
  onClose: () => void;
}

/** One raw value's identity key (checkbox bookkeeping). */
const keyOf = (value: FilterValue): string => `${typeof value}:${String(value)}`;

/**
 * Right-click menu for a filter-indicator chip (and banner rows): Edit
 * value…, Clear this filter, Clear all filters. Follows the app's
 * context-menu card pattern — the CALLER portals it to document.body inside
 * an `rcd-root bg-transparent` wrapper; this card clamps itself into the
 * viewport and closes on Escape/outside click.
 *
 * "Edit value…" expands the card in place into a checkbox list of the
 * field's distinct values (same API the slicers use); Apply writes back
 * through the exact store path Ctrl-click accumulation uses.
 */
export function FilterChipMenu({
  entryLabel,
  position,
  edit = null,
  onClearThis,
  onClearAll,
  onClose,
}: FilterChipMenuProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<FilterValue[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set((edit?.current ?? []).map(keyOf)),
  );

  // Clamp into the viewport once measured (same as the other config cards);
  // re-clamps when the edit list expands the card.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 4)),
    });
  }, [position, editing, values]);

  useEffect(() => {
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
  }, [onClose]);

  const startEditing = () => {
    if (!edit) return;
    setEditing(true);
    if (values !== null) return;
    edit
      .loadValues()
      .then((loaded) => {
        setValues(loaded.filter((v): v is FilterValue => v !== null));
        setLoadError(null);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  };

  const toggle = (value: FilterValue) => {
    setChecked((prev) => {
      const next = new Set(prev);
      const key = keyOf(value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apply = () => {
    if (!edit || values === null) return;
    // Preserve the loaded list's order; values checked but no longer listed
    // (stale distinct list) drop out — the visible checkboxes are the truth.
    edit.onApply(values.filter((v) => checked.has(keyOf(v))));
    onClose();
  };

  return (
    <div
      ref={cardRef}
      role="menu"
      aria-label={`Filter ${entryLabel}`}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 flex w-60 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
    >
      <p
        className="truncate border-b border-rcd-border px-3 pb-1 pt-0.5 text-[11px] font-medium text-rcd-muted"
        title={entryLabel}
      >
        {entryLabel}
      </p>

      {!editing ? (
        <>
          {edit && (
            <button
              type="button"
              role="menuitem"
              onClick={startEditing}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
            >
              <ListChecks size={14} />
              Edit value…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClearThis();
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X size={14} />
            Clear this filter
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClearAll();
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
          >
            <FilterX size={14} />
            Clear all filters
          </button>
        </>
      ) : (
        <div className="flex flex-col gap-1 px-2 pb-1 pt-1.5">
          {values === null && loadError === null && (
            <div className="flex justify-center py-3">
              <RcdSpinner label="Loading values…" />
            </div>
          )}
          {loadError !== null && (
            <p className="px-1 py-2 text-xs text-[var(--rcd-status-critical)]">{loadError}</p>
          )}
          {values !== null && (
            <>
              <div className="max-h-56 overflow-y-auto rounded-md border border-rcd-border">
                {values.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-rcd-muted">No values found.</p>
                ) : (
                  values.map((value) => {
                    const key = keyOf(value);
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        <input
                          type="checkbox"
                          className="accent-[var(--rcd-accent)]"
                          checked={checked.has(key)}
                          onChange={() => toggle(value)}
                        />
                        <span className="min-w-0 truncate" title={String(value)}>
                          {String(value)}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              <div className="flex items-center justify-end gap-1.5 pt-1">
                <RcdButton onClick={onClose}>Cancel</RcdButton>
                <RcdButton variant="primary" onClick={apply}>
                  Apply
                </RcdButton>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
