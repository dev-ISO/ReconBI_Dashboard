import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Filter, FilterX, GripVertical, SlidersHorizontal, X } from 'lucide-react';
import type { FilterIndicatorStyle } from '@recon/dashboards-core';

/**
 * One transient filter the indicator advertises: a cross-filter raised by a
 * datum/legend click, or a slicer selection on the active page. Both are
 * runtime-only state, both are individually clearable. The two kinds render
 * DISTINCTLY (filter glyph vs slider glyph + "Slicer" caption) so the same
 * field:value can never look like a doubled filter.
 */
export interface ActiveFilterEntry {
  /** Stable key (slicer tile id, or 'xf:<table>.<column>' for cross-filters). */
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

/**
 * Defaults for a dashboard that never configured the indicator.
 *
 * PLACEMENT DEFAULT = 'header' (the toolbar row). The floating docks cover
 * tiles — doubly so under fit-to-page, where they render as overlays — so they
 * are OPT-IN now: only a doc that explicitly saved a floating placement keeps
 * one. `variant`/`size` still describe the floating and footer looks; the
 * toolbar always renders its own compact chip bar (see HeaderFilterBar).
 */
export const DEFAULT_FILTER_INDICATOR = {
  placement: 'header',
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
  placement === 'bottom-left' || placement === 'bottom-right' || placement === 'footer';

/**
 * True for the in-flow slots the CALLER hosts (toolbar row / bottom bar) —
 * the indicator renders `inline` there instead of docking itself.
 */
export const isFlowPlacement = (placement: FilterIndicatorPlacement): boolean =>
  placement === 'header' || placement === 'footer';

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
 * 'header'/'footer' never float — the caller hosts them in flow (they fall
 * back to top-center if one ever reaches this map).
 */
const PLACEMENT_CLASSES: Partial<Record<FilterIndicatorPlacement, string>> = {
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
 * The indicator's atom: accent leading bar, kind glyph (filter for
 * cross-filters, sliders for slicer selections — the visible distinction that
 * keeps "region: Gulf Coast" from ever reading as the same filter twice),
 * "field:" caption and the BOLD selected value, then its own dismiss.
 * Right-click opens the chip menu (Edit value… / Clear) when the caller wires
 * `onContextMenu`.
 */
function FilterChip({
  entry,
  size,
  accent,
  background,
  textColor,
  onContextMenu,
}: {
  entry: ActiveFilterEntry;
  size: FilterIndicatorSize;
  accent: string | null;
  background: string | null;
  textColor: string | null;
  onContextMenu?: (id: string, position: { x: number; y: number }) => void;
}) {
  const scale = SIZES[size];
  const style: CSSProperties = {
    ...(background ? { backgroundColor: background } : null),
    ...(textColor ? { color: textColor } : null),
  };
  const Icon = entry.kind === 'slicer' ? SlidersHorizontal : Filter;
  const title =
    entry.kind === 'slicer'
      ? `Slicer — ${entry.field}: ${entry.value}`
      : `${entry.field}: ${entry.value}`;
  return (
    <div
      className={`pointer-events-auto flex max-w-full items-stretch overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface shadow-[var(--rcd-shadow-2)] ${scale.height} ${scale.text}`}
      style={style}
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(entry.id, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
      {/* Accent leading bar — the "this dashboard is filtered" signal. */}
      <span
        aria-hidden
        className="w-1 shrink-0 bg-rcd-accent"
        style={accent ? { backgroundColor: accent } : undefined}
      />
      <span className={`flex min-w-0 items-center pl-2 ${scale.padding} ${scale.gap}`}>
        <Icon
          size={scale.icon}
          aria-hidden
          className="shrink-0 text-rcd-accent"
          style={accent ? { color: accent } : undefined}
        />
        <span className="min-w-0 truncate" title={title}>
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

/**
 * The drag affordance: a grip revealed on hover; grabbing it starts the
 * caller's drag-to-dock interaction (snap to one of the seven slots).
 */
function DragGrip({
  size,
  onPointerDown,
}: {
  size: FilterIndicatorSize;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const scale = SIZES[size];
  return (
    <button
      type="button"
      aria-label="Move the filter indicator (drag to a docking slot)"
      title="Drag to move"
      onPointerDown={(event) => {
        event.preventDefault();
        onPointerDown(event);
      }}
      className="pointer-events-auto flex shrink-0 cursor-grab items-center self-center rounded-md p-1 text-rcd-muted opacity-0 transition-opacity hover:bg-black/5 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10"
    >
      <GripVertical size={scale.icon} aria-hidden />
    </button>
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
   * also carries drillthrough/notice chips, or the header/footer flow slots),
   * so the two never overlap.
   */
  inline?: boolean;
  /**
   * Right-click on a chip (id + viewport position) — opens the caller's chip
   * context menu (Edit value… / Clear this filter / Clear all).
   */
  onEntryContextMenu?: (id: string, position: { x: number; y: number }) => void;
  /**
   * Grabbing the hover-revealed grip starts the caller's drag-to-dock
   * interaction. Absent = no grip (print view, plain embeds).
   */
  onGripPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

/**
 * Active cross-filter / slicer indicator for the NON-default placements. The
 * default 'header' placement does not come through here at all — the caller
 * renders HeaderFilterBar inside the toolbar row for that. Three looks, all
 * driven by the layout doc's `filterIndicator`:
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
export function FilterIndicator({
  entries,
  style,
  onClearAll,
  inline = false,
  onEntryContextMenu,
  onGripPointerDown,
}: FilterIndicatorProps) {
  const resolved = resolveIndicatorStyle(style);
  const appeared = useAppeared();

  if (entries.length === 0) return null;

  const { variant, placement, size, accentColor, background, textColor } = resolved;
  const scale = SIZES[size];
  const bottom = isBottomPlacement(placement);

  if (variant === 'banner' && !inline) {
    return (
      <div
        role="status"
        aria-label="Active filters"
        className={`group z-20 flex w-full shrink-0 items-center gap-2 overflow-x-auto border-rcd-border bg-rcd-surface px-3 py-1.5 shadow-[var(--rcd-shadow-1)] transition-all duration-200 ease-out ${
          bottom ? 'border-t' : 'border-b'
        } ${appeared ? 'opacity-100' : 'opacity-0'}`}
        style={{
          ...(background ? { backgroundColor: background } : null),
          ...(textColor ? { color: textColor } : null),
          // Accent edge along the whole bar: unmistakable, still slim.
          [bottom ? 'borderBottom' : 'borderTop']: `2px solid ${accentColor ?? 'var(--rcd-accent)'}`,
        }}
      >
        {onGripPointerDown && <DragGrip size={size} onPointerDown={onGripPointerDown} />}
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
              onContextMenu={onEntryContextMenu}
            />
          ))}
        </span>
        <ClearAllButton size={size} onClick={onClearAll} accent={accentColor} />
      </div>
    );
  }

  // pill / stack: floating, docked at `placement` (or rendered bare in the
  // caller's flow slot when `inline`). Both list EVERY active filter (each
  // with its own ✕) — 'pill' wraps them into a compact row, 'stack' columns
  // them down the corner.
  return (
    <div
      role="status"
      aria-label="Active filters"
      className={`group pointer-events-none flex max-w-full gap-1.5 transition-all duration-200 ease-out ${
        variant === 'stack' && !inline ? 'flex-col' : 'flex-row flex-wrap'
      } ${
        inline
          ? 'items-center justify-center'
          : `absolute z-20 max-w-[85%] ${PLACEMENT_CLASSES[placement] ?? PLACEMENT_CLASSES['top-center']!}`
      } ${
        appeared ? 'opacity-100 translate-y-0' : `opacity-0 ${bottom ? 'translate-y-1' : '-translate-y-1'}`
      }`}
    >
      {onGripPointerDown && <DragGrip size={size} onPointerDown={onGripPointerDown} />}
      {entries.map((entry) => (
        <FilterChip
          key={entry.id}
          entry={entry}
          size={size}
          accent={accentColor}
          background={background}
          textColor={textColor}
          onContextMenu={onEntryContextMenu}
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

/* --------------------------------------------------- toolbar ('header') bar */

/** Accent tint helper — works for both a hex accent and the theme var. */
const tint = (accent: string, percent: number): string =>
  `color-mix(in srgb, ${accent} ${percent}%, transparent)`;

interface HeaderScale {
  height: string;
  text: string;
  icon: number;
  /** Cap on the value text so one long selection can't eat the whole row. */
  valueMax: string;
}

/**
 * Toolbar chip metrics. Deliberately capped well under the 48px toolbar row —
 * the chips must never be able to grow it (a taller toolbar would shrink the
 * fitted area below and re-scale the page).
 */
const HEADER_SIZES: Record<FilterIndicatorSize, HeaderScale> = {
  sm: { height: 'h-6', text: 'text-[11px]', icon: 11, valueMax: 'max-w-[9rem]' },
  md: { height: 'h-7', text: 'text-xs', icon: 12, valueMax: 'max-w-[11rem]' },
  lg: { height: 'h-8', text: 'text-xs', icon: 13, valueMax: 'max-w-[13rem]' },
};

/** Gap between toolbar chips, in px — must match the `gap-1.5` class below. */
const HEADER_GAP = 6;

/**
 * A single toolbar chip: accent-tinted pill, kind glyph (funnel = cross-filter,
 * sliders = slicer), "field:" caption, the bold value, and its own ✕. Lighter
 * than the floating FilterChip on purpose — it sits among toolbar controls, so
 * it reads as chrome rather than as a card dropped on top of the dashboard.
 */
function HeaderChip({
  entry,
  scale,
  accent,
  background,
  textColor,
  onContextMenu,
}: {
  entry: ActiveFilterEntry;
  scale: HeaderScale;
  accent: string;
  background: string | null;
  textColor: string | null;
  onContextMenu?: (id: string, position: { x: number; y: number }) => void;
}) {
  const Icon = entry.kind === 'slicer' ? SlidersHorizontal : Filter;
  const title =
    entry.kind === 'slicer'
      ? `Slicer — ${entry.field}: ${entry.value}`
      : `Cross-filter — ${entry.field}: ${entry.value}`;
  return (
    <span
      title={title}
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(entry.id, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
      className={`flex shrink-0 items-center gap-1 rounded-md border pl-1.5 pr-0.5 transition-colors ${scale.height} ${scale.text}`}
      style={{
        backgroundColor: background ?? tint(accent, 10),
        borderColor: tint(accent, 30),
        ...(textColor ? { color: textColor } : null),
      }}
    >
      <Icon size={scale.icon} aria-hidden className="shrink-0" style={{ color: textColor ?? accent }} />
      <span className="min-w-0 truncate text-rcd-text-2" style={textColor ? { color: textColor } : undefined}>
        {entry.field}:
      </span>
      <span
        className={`min-w-0 truncate font-semibold text-rcd-text ${scale.valueMax}`}
        style={textColor ? { color: textColor } : undefined}
      >
        {entry.value}
      </span>
      <button
        type="button"
        aria-label={`Clear filter ${entry.field}: ${entry.value}`}
        title="Clear this filter"
        onClick={entry.onClear}
        className="ml-0.5 shrink-0 rounded p-0.5 text-rcd-muted transition-colors hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/15"
      >
        <X size={scale.icon} aria-hidden />
      </button>
    </span>
  );
}

/** The "+N filters" overflow chip (also the sole chip when nothing else fits). */
function OverflowChip({
  hidden,
  total,
  scale,
  accent,
  open,
  onToggle,
  buttonRef,
}: {
  hidden: number;
  total: number;
  scale: HeaderScale;
  accent: string;
  open: boolean;
  onToggle: (rect: DOMRect) => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  // "+2" alongside visible chips; "3 filters" when it stands alone.
  const standalone = hidden === total;
  const label = standalone ? `${hidden} filter${hidden === 1 ? '' : 's'}` : `+${hidden}`;
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Show all ${total} active filters`}
      title={`${hidden} more active filter${hidden === 1 ? '' : 's'} — click to list them`}
      onClick={(event) => onToggle(event.currentTarget.getBoundingClientRect())}
      className={`flex shrink-0 items-center gap-0.5 rounded-md border px-1.5 font-medium transition-colors hover:brightness-95 ${scale.height} ${scale.text}`}
      style={{
        backgroundColor: tint(accent, open ? 22 : 14),
        borderColor: tint(accent, 34),
        color: 'var(--rcd-text)',
      }}
    >
      {standalone && <Filter size={scale.icon} aria-hidden style={{ color: accent }} />}
      {label}
      {!standalone && <span className="text-rcd-text-2">filters</span>}
      <ChevronDown size={scale.icon} aria-hidden className="text-rcd-muted" />
    </button>
  );
}

/**
 * The overflow popover: every active filter, full text, each with its own ✕,
 * plus a Clear all. Portaled to the body — the toolbar's flexible middle is
 * `overflow-hidden` (that is what keeps the row from ever wrapping), so an
 * absolutely-positioned card inside it would be clipped.
 */
function OverflowPopover({
  entries,
  anchor,
  accent,
  onClearAll,
  onEntryContextMenu,
  onClose,
  triggerRef,
}: {
  entries: ActiveFilterEntry[];
  anchor: DOMRect;
  accent: string;
  onClearAll: () => void;
  onEntryContextMenu?: (id: string, position: { x: number; y: number }) => void;
  onClose: () => void;
  /**
   * The "+N" chip that owns the open/closed toggle. Clicks on it are NOT
   * "outside": this card is portaled, so the trigger sits outside `cardRef`,
   * and closing on its mousedown would let the very next click re-open the
   * card — the chip could then never be used to dismiss it.
   */
  triggerRef?: { current: HTMLButtonElement | null };
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Drop clear of the toolbar row rather than hugging the chip: a 6px gap
  // would land the card's top edge inside the toolbar's bottom border.
  const [pos, setPos] = useState({ x: anchor.left, y: anchor.bottom + 12 });

  // Clamp into the viewport once measured (same doctrine as the config card).
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(anchor.left, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(anchor.bottom + 12, window.innerHeight - rect.height - 4)),
    });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (cardRef.current === null || cardRef.current.contains(event.target)) return;
      if (triggerRef?.current?.contains(event.target)) return;
      onClose();
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
  }, [onClose, triggerRef]);

  return createPortal(
    // --rcd-* vars are scoped to .rcd-root; every body portal needs this wrapper.
    <div className="rcd-root bg-transparent">
      <div
        ref={cardRef}
        role="dialog"
        aria-label="Active filters"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 flex max-h-[60vh] w-72 flex-col overflow-hidden rounded-md border border-rcd-border bg-rcd-surface shadow-[var(--rcd-shadow-2)]"
      >
        <p className="flex items-center gap-1.5 border-b border-rcd-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
          <Filter size={11} aria-hidden style={{ color: accent }} />
          Active filters ({entries.length})
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {entries.map((entry) => {
            const Icon = entry.kind === 'slicer' ? SlidersHorizontal : Filter;
            return (
              <div
                key={entry.id}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-black/5 dark:hover:bg-white/10"
                onContextMenu={
                  onEntryContextMenu
                    ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onEntryContextMenu(entry.id, { x: event.clientX, y: event.clientY });
                      }
                    : undefined
                }
              >
                <Icon size={12} aria-hidden className="shrink-0" style={{ color: accent }} />
                <span className="min-w-0 flex-1 text-xs leading-snug">
                  <span className="text-rcd-text-2">{entry.field}: </span>
                  <span className="break-words font-semibold text-rcd-text">{entry.value}</span>
                  {entry.kind === 'slicer' && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-rcd-muted">slicer</span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Clear filter ${entry.field}: ${entry.value}`}
                  title="Clear this filter"
                  onClick={entry.onClear}
                  className="shrink-0 rounded p-1 text-rcd-muted transition-colors hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/15"
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            onClose();
            onClearAll();
          }}
          className="flex items-center gap-1.5 border-t border-rcd-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          style={{ color: accent }}
        >
          <FilterX size={12} aria-hidden />
          Clear all
        </button>
      </div>
    </div>,
    document.body,
  );
}

export interface HeaderFilterBarProps {
  entries: ActiveFilterEntry[];
  style: FilterIndicatorStyle | null | undefined;
  onClearAll: () => void;
  onEntryContextMenu?: (id: string, position: { x: number; y: number }) => void;
  /** Grabbing the grip starts the caller's drag-to-dock (toolbar → float). */
  onGripPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

/**
 * THE DEFAULT LOOK: active filters as compact chips living INSIDE the existing
 * dashboard toolbar row, right after the name/Shared cluster. Nothing floats,
 * so nothing can ever cover a tile.
 *
 * The row is single-line and hard-clipped, and it only ever occupies the
 * toolbar's flexible middle (a `flex-1 min-w-0` box whose width comes from the
 * flex line, NOT from its content) — so the chips can neither wrap the toolbar,
 * push the right-hand controls off, nor change the toolbar's height. What does
 * not fit collapses into a "+N filters" chip whose popover lists every filter.
 *
 * Overflow is measured, not guessed: a hidden mirror row renders every chip at
 * natural width, and the largest prefix that fits (reserving the grip, the
 * "+N" chip and Clear all) becomes the visible set.
 */
export function HeaderFilterBar({
  entries,
  style,
  onClearAll,
  onEntryContextMenu,
  onGripPointerDown,
}: HeaderFilterBarProps) {
  const resolved = resolveIndicatorStyle(style);
  const scale = HEADER_SIZES[resolved.size];
  const accent = resolved.accentColor ?? 'var(--rcd-accent)';
  const hostRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  /** How many chips are rendered for real; the rest hide behind "+N". */
  const [visibleCount, setVisibleCount] = useState(entries.length);
  const [popoverAnchor, setPopoverAnchor] = useState<DOMRect | null>(null);
  const appeared = useAppeared();

  const total = entries.length;
  // Re-measure whenever the chip TEXT changes, not just the count.
  const entriesKey = useMemo(
    () => entries.map((entry) => `${entry.id}${entry.field}${entry.value}`).join(''),
    [entries],
  );

  const measure = useCallback(() => {
    const host = hostRef.current;
    const mirror = mirrorRef.current;
    if (!host || !mirror) return;
    const available = host.clientWidth;
    const nodes = Array.from(mirror.children) as HTMLElement[];
    const widthOf = (kind: string) =>
      nodes.find((node) => node.dataset.m === kind)?.getBoundingClientRect().width ?? 0;
    const chipWidths = nodes
      .filter((node) => node.dataset.m === 'chip')
      .map((node) => node.getBoundingClientRect().width);

    // Fixed costs: the lead rule (+ grip), the overflow chip, Clear all.
    const lead = widthOf('lead') + HEADER_GAP;
    const plus = widthOf('plus') + HEADER_GAP;
    const clear = total > 1 ? widthOf('clear') + HEADER_GAP : 0;

    // Largest prefix of chips that fits; sub-pixel slack avoids flapping.
    const prefix: number[] = [0];
    for (const width of chipWidths) {
      prefix.push(prefix[prefix.length - 1]! + width + HEADER_GAP);
    }
    let best = 0;
    for (let k = total; k >= 1; k -= 1) {
      const need = lead + clear + prefix[k]! + (k < total ? plus : 0);
      if (need <= available + 0.5) {
        best = k;
        break;
      }
    }
    setVisibleCount((count) => (count === best ? count : best));
  }, [total]);

  // Measure before paint, and again whenever the row is resized (window /
  // sidebar / a longer dashboard name). The host's width comes from the flex
  // line rather than from its children, so re-measuring cannot feed itself.
  useLayoutEffect(() => {
    measure();
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    return () => observer.disconnect();
  }, [measure, entriesKey]);

  const shown = Math.min(visibleCount, total);
  const hidden = total - shown;

  // A stale popover must not outlive the "+N" chip that opened it: the chip
  // disappears both when the filters are cleared AND when the row widens
  // enough to show every chip for real, and an anchored card with no anchor
  // (nothing to toggle it shut, nothing it belongs to) must not survive that.
  useEffect(() => {
    if (hidden === 0) setPopoverAnchor(null);
  }, [hidden]);

  if (total === 0) return null;

  const chipOf = (entry: ActiveFilterEntry) => (
    <HeaderChip
      entry={entry}
      scale={scale}
      accent={accent}
      background={resolved.background}
      textColor={resolved.textColor}
      onContextMenu={onEntryContextMenu}
    />
  );

  const leadCluster = (
    <>
      <span aria-hidden className="h-5 w-px shrink-0 bg-rcd-border" />
      {onGripPointerDown && <DragGrip size={resolved.size} onPointerDown={onGripPointerDown} />}
    </>
  );

  const clearAll = (
    <button
      type="button"
      onClick={onClearAll}
      title="Clear every active filter"
      className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${scale.height} ${scale.text}`}
      style={{ color: accent }}
    >
      <FilterX size={scale.icon} aria-hidden />
      Clear all
    </button>
  );

  return (
    <div
      ref={hostRef}
      role="status"
      aria-label={`${total} active filter${total === 1 ? '' : 's'}`}
      className={`group relative flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden transition-opacity duration-200 ease-out ${
        appeared ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {leadCluster}
      {entries.slice(0, shown).map((entry) => (
        <span key={entry.id} className="flex min-w-0 shrink-0">
          {chipOf(entry)}
        </span>
      ))}
      {hidden > 0 && (
        <OverflowChip
          buttonRef={overflowRef}
          hidden={hidden}
          total={total}
          scale={scale}
          accent={accent}
          open={popoverAnchor !== null}
          onToggle={(rect) => setPopoverAnchor((open) => (open ? null : rect))}
        />
      )}
      {total > 1 && clearAll}

      {/* Hidden mirror: every chip at natural width, measured but never seen.
          `invisible` (not `hidden`) so it still lays out; absolute so it adds
          nothing to the real row. */}
      <div
        ref={mirrorRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap items-center gap-1.5"
      >
        <span data-m="lead" className="flex items-center gap-1.5">
          {leadCluster}
        </span>
        {entries.map((entry) => (
          <span key={entry.id} data-m="chip" className="flex shrink-0">
            {chipOf(entry)}
          </span>
        ))}
        <span data-m="plus" className="flex shrink-0">
          <OverflowChip
            hidden={total}
            total={total}
            scale={scale}
            accent={accent}
            open={false}
            onToggle={() => {}}
          />
        </span>
        <span data-m="clear" className="flex shrink-0">
          {clearAll}
        </span>
      </div>

      {popoverAnchor && (
        <OverflowPopover
          entries={entries}
          anchor={popoverAnchor}
          accent={accent}
          onClearAll={onClearAll}
          onEntryContextMenu={onEntryContextMenu}
          onClose={() => setPopoverAnchor(null)}
          triggerRef={overflowRef}
        />
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
