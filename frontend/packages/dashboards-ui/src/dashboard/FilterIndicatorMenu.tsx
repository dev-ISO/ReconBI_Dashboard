import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import type { FilterIndicatorStyle } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdSelect } from '../primitives';
import { resolveIndicatorStyle } from './FilterIndicator';

/**
 * Fixed-palette accents for the indicator (same doctrine as the tile
 * background swatches: persisted verbatim, null = theme accent).
 */
const ACCENTS: { value: string | null; label: string }[] = [
  { value: null, label: 'Theme accent' },
  { value: '#2563eb', label: 'Blue' },
  { value: '#f97316', label: 'Orange' },
  { value: '#16a34a', label: 'Green' },
  { value: '#a855f7', label: 'Purple' },
  { value: '#dc2626', label: 'Red' },
  { value: '#0f172a', label: 'Slate' },
];

const PLACEMENTS: { value: NonNullable<FilterIndicatorStyle['placement']>; label: string }[] = [
  { value: 'top-center', label: 'Top center' },
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

const VARIANTS: { value: NonNullable<FilterIndicatorStyle['variant']>; label: string }[] = [
  { value: 'pill', label: 'Pill (floating chip)' },
  { value: 'banner', label: 'Banner (full-width bar)' },
  { value: 'stack', label: 'Stack (chip per filter)' },
];

const SIZES: { value: NonNullable<FilterIndicatorStyle['size']>; label: string }[] = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
];

export interface FilterIndicatorMenuProps {
  /** Current doc value (null/absent = component defaults). */
  style: FilterIndicatorStyle | null;
  position: { x: number; y: number };
  onClose: () => void;
}

/**
 * Edit-mode configuration card for the cross-filter indicator (dashboard
 * toolbar, NOT the chart Format panel — this is dashboard chrome, not chart
 * formatting). Writes doc.filterIndicator through the store; every field is a
 * merge patch, so untouched fields keep falling back to the defaults and
 * "Reset to default" removes the key entirely.
 *
 * The caller portals this to document.body (past the transformed grid).
 */
export function FilterIndicatorMenu({ style, position, onClose }: FilterIndicatorMenuProps) {
  const runtime = useRuntime();
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const resolved = resolveIndicatorStyle(style);

  // Clamp into the viewport once measured (same as the tile config cards).
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 4)),
    });
  }, [position]);

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

  const patch = (next: Partial<FilterIndicatorStyle>) =>
    runtime.dashboards.setFilterIndicator(next);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Filter indicator settings"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 flex w-64 flex-col gap-2 rounded-md border border-rcd-border bg-rcd-surface p-3 shadow-[var(--rcd-shadow-2)]"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
        Filter indicator
      </p>
      <p className="text-[11px] leading-4 text-rcd-muted">
        How active cross-filters and slicer selections are announced on this dashboard.
      </p>

      <Field label="Style">
        <RcdSelect
          aria-label="Indicator style"
          value={resolved.variant}
          onChange={(event) =>
            patch({ variant: event.target.value as NonNullable<FilterIndicatorStyle['variant']> })
          }
        >
          {VARIANTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </RcdSelect>
      </Field>

      <Field label={resolved.variant === 'banner' ? 'Edge' : 'Placement'}>
        <RcdSelect
          aria-label="Indicator placement"
          value={resolved.placement}
          onChange={(event) =>
            patch({
              placement: event.target.value as NonNullable<FilterIndicatorStyle['placement']>,
            })
          }
        >
          {PLACEMENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </RcdSelect>
      </Field>
      {resolved.variant === 'banner' && (
        <p className="text-[11px] leading-4 text-rcd-muted">
          A banner docks across the whole width — only the top/bottom half of the placement
          applies.
        </p>
      )}

      <Field label="Size">
        <RcdSelect
          aria-label="Indicator size"
          value={resolved.size}
          onChange={(event) =>
            patch({ size: event.target.value as NonNullable<FilterIndicatorStyle['size']> })
          }
        >
          {SIZES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </RcdSelect>
      </Field>

      <Field label="Accent">
        <RcdSelect
          aria-label="Indicator accent color"
          value={resolved.accentColor ?? ''}
          onChange={(event) => patch({ accentColor: event.target.value || null })}
        >
          {ACCENTS.map((option) => (
            <option key={option.label} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </RcdSelect>
      </Field>

      <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-rcd-text">
        <input
          type="checkbox"
          className="accent-[var(--rcd-accent)]"
          checked={resolved.badgeTiles}
          onChange={(event) => patch({ badgeTiles: event.target.checked })}
        />
        Badge the tiles a filter applies to
      </label>

      <button
        type="button"
        onClick={() => runtime.dashboards.setFilterIndicator(null)}
        className="mt-1 flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-xs text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
      >
        <RotateCcw size={12} />
        Reset to default
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-rcd-text-2">
      {label}
      {children}
    </label>
  );
}
