import { useEffect, useState, type CSSProperties } from 'react';
import { Filter, FilterX, X } from 'lucide-react';
import type { FilterIndicatorStyle } from '@recon/dashboards-core';

/**
 * One transient filter the indicator advertises: a cross-filter raised by a
 * datum/legend click, or a slicer selection on the active page. Both are
 * runtime-only state, both are individually clearable.
 */
export interface ActiveFilterEntry {
  /** Stable key (tile id for slicers, 'crossFilter' for the click filter). */
  id: string;
  kind: 'crossFilter' | 'slicer';
  /** Field/slicer name, e.g. "name" or "Technician". */
  field: string;
  /** Selected value(s), e.g. "Technician A". */
  value: string;
  onClear: () => void;
}

export type FilterIndicatorPlacement = NonNullable<FilterIndicatorStyle['placement']>;
export type FilterIndicatorVariant = NonNullable<FilterIndicatorStyle['variant']>;
export type FilterIndicatorSize = NonNullable<FilterIndicatorStyle['size']>;

export const DEFAULT_FILTER_INDICATOR = {
  placement: 'top-center',
  variant: 'pill',
  size: 'md',
  badgeTiles: true,
} as const;

export const resolveIndicatorStyle = (style: FilterIndicatorStyle | null | undefined) => ({
  placement: style?.placement ?? DEFAULT_FILTER_INDICATOR.placement,
  variant: style?.variant ?? DEFAULT_FILTER_INDICATOR.variant,
  size: style?.size ?? DEFAULT_FILTER_INDICATOR.size,
  background: style?.background ?? null,
  textColor: style?.textColor ?? null,
  accentColor: style?.accentColor ?? null,
  badgeTiles: style?.badgeTiles !== false,
});

/** True when the indicator docks at the BOTTOM of the dashboard. */
export const isBottomPlacement = (placement: FilterIndicatorPlacement): boolean =>
  placement === 'bottom-left' || placement === 'bottom-right';

/* --------------------------------------------------------------- size scale */

interface SizeScale {
  /** Chip height. */
  height: string;
  text: string;
  icon: number;
  padding: string;
  gap: string;
}

const SIZES: Record<FilterIndicatorSize, SizeScale> = {
  sm: { height: 'h-6', text: 'text-[11px]', icon: 11, padding: 'pr-1', gap: 'gap-1' },
  md: { height: 'h-8', text: 'text-xs', icon: 13, padding: 'pr-1.5', gap: 'gap-1.5' },
  lg: { height: 'h-10', text: 'text-sm', icon: 15, padding: 'pr-2', gap: 'gap-2' },
};

/**
 * Absolute docking classes for the floating variants (pill/stack). The parent
 * is the dashboard's relative content row, so the indicator floats over the
 * tiles and never reaches the toolbar row (where the refresh caption lives).
 */
const PLACEMENT_CLASSES: Record<FilterIndicatorPlacement, string> = {
  'top-center': 'left-1/2 top-2 -translate-x-1/2 items-center',
  'top-left': 'left-3 top-2 items-start',
  'top-right': 'right-3 top-2 items-end',
  'bottom-left': 'left-3 bottom-3 items-start',
  'bottom-right': 'right-3 bottom-3 items-end',
};

/* ------------------------------------------------------------- appear anim */

/**
 * Mount transition without a stylesheet keyframe: render at
 * opacity-0/translated, flip a flag on the next frame, let the transition run.
 * Honors the ambient reduced-motion preference by starting already-shown.
 */
function useAppeared(): boolean {
  const [shown, setShown] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return shown;
}

/* ------------------------------------------------------------------- chips */

function ClearButton({
  label,
  size,
  onClick,
  tone = 'muted',
}: {
  label: string;
  size: number;
  onClick: () => void;
  tone?: 'muted' | 'inherit';
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`shrink-0 rounded-md p-1 transition-colors hover:bg-black/10 dark:hover:bg-white/15 ${
        tone === 'muted' ? 'text-rcd-muted hover:text-rcd-text' : 'opacity-70 hover:opacity-100'
      }`}
    >
      <X size={size} />
    </button>
  );
}

/**
 * The indicator's atom: accent leading bar, filter glyph, "field:" caption and
 * the BOLD selected value, then its own dismiss. Deliberately louder than the
 * old ghost pill — border + surface + drop shadow so it reads as chrome, not
 * as a tooltip.
 */
function FilterChip({
  entry,
  size,
  accent,
  background,
  textColor,
}: {
  entry: ActiveFilterEntry;
  size: FilterIndicatorSize;
  accent: string | null;
  background: string | null;
  textColor: string | null;
}) {
  const scale = SIZES[size];
  const style: CSSProperties = {
    ...(background ? { backgroundColor: background } : null),
    ...(textColor ? { color: textColor } : null),
  };
  return (
    <div
      className={`pointer-events-auto flex max-w-full items-stretch overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface shadow-[var(--rcd-shadow-2)] ${scale.height} ${scale.text}`}
      style={style}
    >
      {/* Accent leading bar — the "this dashboard is filtered" signal. */}
      <span
        aria-hidden
        className="w-1 shrink-0 bg-rcd-accent"
        style={accent ? { backgroundColor: accent } : undefined}
      />
      <span className={`flex min-w-0 items-center pl-2 ${scale.padding} ${scale.gap}`}>
        <Filter
          size={scale.icon}
          aria-hidden
          className="shrink-0 text-rcd-accent"
          style={accent ? { color: accent } : undefined}
        />
        <span className="min-w-0 truncate" title={`${entry.field}: ${entry.value}`}>
          <span className="text-rcd-text-2" style={textColor ? { color: textColor } : undefined}>
            {entry.field}:{' '}
          </span>
          <span className="font-semibold text-rcd-text" style={textColor ? { color: textColor } : undefined}>
            {entry.value}
          </span>
        </span>
        <ClearButton
          label={`Clear filter ${entry.field}: ${entry.value}`}
          size={scale.icon}
          onClick={entry.onClear}
          tone={textColor ? 'inherit' : 'muted'}
        />
      </span>
    </div>
  );
}

function ClearAllButton({
  size,
  onClick,
  accent,
}: {
  size: FilterIndicatorSize;
  onClick: () => void;
  accent: string | null;
}) {
  const scale = SIZES[size];
  return (
    <button
      type="button"
      onClick={onClick}
      title="Clear every active filter"
      className={`pointer-events-auto flex shrink-0 items-center gap-1 rounded-md border border-transparent px-2 py-1 font-medium text-rcd-accent transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${scale.text}`}
      style={accent ? { color: accent } : undefined}
    >
      <FilterX size={scale.icon} aria-hidden />
      Clear all
    </button>
  );
}

/* --------------------------------------------------------------- indicator */

export interface FilterIndicatorProps {
  entries: ActiveFilterEntry[];
  style: FilterIndicatorStyle | null | undefined;
  /** Clears every entry at once (banner/stack "Clear all"). */
  onClearAll: () => void;
  /**
   * Drop the absolute docking wrapper and render just the chips — used when
   * the caller already owns a docked chip column (the top-center strip that
   * also carries drillthrough/notice chips), so the two never overlap.
   */
  inline?: boolean;
}

/**
 * Active cross-filter / slicer indicator. Three looks, all driven by the
 * layout doc's `filterIndicator`:
 *
 *  - 'pill'   — one compact floating chip per filter, docked at `placement`
 *               (the historic look, restyled to actually be noticeable);
 *  - 'banner' — a slim full-width bar across the top/bottom of the dashboard
 *               listing EVERY active filter with its own ✕ plus a Clear all;
 *  - 'stack'  — chips stacked vertically at the docked corner.
 *
 * The banner sits in normal document flow (the caller renders it above/below
 * the tile area) so it never covers tiles; pill/stack float over the tile area
 * and are pointer-transparent except on their own controls. Nothing renders
 * without at least one active filter.
 */
export function FilterIndicator({ entries, style, onClearAll, inline = false }: FilterIndicatorProps) {
  const resolved = resolveIndicatorStyle(style);
  const appeared = useAppeared();

  if (entries.length === 0) return null;

  const { variant, placement, size, accentColor, background, textColor } = resolved;
  const scale = SIZES[size];
  const bottom = isBottomPlacement(placement);

  if (variant === 'banner') {
    return (
      <div
        role="status"
        aria-label="Active filters"
        className={`z-20 flex w-full shrink-0 items-center gap-2 overflow-x-auto border-rcd-border bg-rcd-surface px-3 py-1.5 shadow-[var(--rcd-shadow-1)] transition-all duration-200 ease-out ${
          bottom ? 'border-t' : 'border-b'
        } ${appeared ? 'opacity-100' : 'opacity-0'}`}
        style={{
          ...(background ? { backgroundColor: background } : null),
          ...(textColor ? { color: textColor } : null),
          // Accent edge along the whole bar: unmistakable, still slim.
          [bottom ? 'borderBottom' : 'borderTop']: `2px solid ${accentColor ?? 'var(--rcd-accent)'}`,
        }}
      >
        <span
          className={`flex shrink-0 items-center gap-1.5 font-semibold ${scale.text}`}
          style={{ color: textColor ?? accentColor ?? 'var(--rcd-accent)' }}
        >
          <Filter size={scale.icon} aria-hidden />
          Filtered
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {entries.map((entry) => (
            <FilterChip
              key={entry.id}
              entry={entry}
              size={size}
              accent={accentColor}
              background={background}
              textColor={textColor}
            />
          ))}
        </span>
        <ClearAllButton size={size} onClick={onClearAll} accent={accentColor} />
      </div>
    );
  }

  // pill / stack: floating, docked at `placement`. Both list EVERY active
  // filter (each with its own ✕) — 'pill' wraps them into a compact row,
  // 'stack' columns them down the corner.
  return (
    <div
      role="status"
      aria-label="Active filters"
      className={`pointer-events-none flex max-w-full gap-1.5 transition-all duration-200 ease-out ${
        variant === 'stack' ? 'flex-col' : 'flex-row flex-wrap'
      } ${inline ? 'items-center justify-center' : `absolute z-20 max-w-[85%] ${PLACEMENT_CLASSES[placement]}`} ${
        appeared ? 'opacity-100 translate-y-0' : `opacity-0 ${bottom ? 'translate-y-1' : '-translate-y-1'}`
      }`}
    >
      {entries.map((entry) => (
        <FilterChip
          key={entry.id}
          entry={entry}
          size={size}
          accent={accentColor}
          background={background}
          textColor={textColor}
        />
      ))}
      {entries.length > 1 && (
        <span
          className={`pointer-events-auto flex items-center rounded-lg border border-rcd-border bg-rcd-surface shadow-[var(--rcd-shadow-1)] ${scale.height}`}
        >
          <ClearAllButton size={size} onClick={onClearAll} accent={accentColor} />
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- tile badges */

/**
 * Corner badge stamped on every tile an active filter actually applies to
 * (FilterIndicatorStyle.badgeTiles, default on). Absolutely positioned — the
 * caller gives it a `relative` host.
 */
export function TileFilterBadge({
  label,
  accentColor,
  positionClassName = 'right-1.5 top-1.5',
}: {
  /** Tooltip text naming the filter(s) reaching this tile. */
  label: string;
  accentColor?: string | null;
  /** Docking classes; the default top-right corner clears most chart chrome. */
  positionClassName?: string;
}) {
  return (
    <span
      aria-label={`Filtered by ${label}`}
      title={`Filtered by ${label}`}
      className={`pointer-events-auto absolute z-10 flex h-5 w-5 items-center justify-center rounded-full border border-rcd-border bg-rcd-surface text-rcd-accent shadow-[var(--rcd-shadow-1)] ${positionClassName}`}
      style={accentColor ? { color: accentColor } : undefined}
    >
      <Filter size={11} aria-hidden />
    </span>
  );
}
