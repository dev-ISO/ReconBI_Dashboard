import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/**
 * Manual pane sizing for the chart builder's three-column layout
 * (field list | wells+format | preview).
 *
 * The fluid grid from wave 13 stays the DEFAULT: untouched panes keep their
 * minmax ranges and the preview absorbs every spare pixel. Dragging a divider
 * pins that pane to an explicit width; the preview remains the flexible track.
 * Double-clicking a divider returns its pane to the fluid default.
 *
 * Clamping is delegated to CSS: a pinned pane renders as
 * `minmax(<min>px, <stored>px)`, and grid track sizing only distributes free
 * space above the mins — so a size remembered from a large dialog gracefully
 * compresses in a smaller one instead of overflowing.
 *
 * Persistence: localStorage under one builder-layout key. Pane sizes are a
 * layout preference worth keeping across sessions and belong to the BUILDER,
 * not to a dialog title — the builder is hosted by both the "Add chart" and
 * "Edit chart" titles and shares one layout. (RcdDialog's own geometry follows
 * the same rule from 0.14.1 under its `rcd.dialog.geometry` store, keyed by
 * the geometryKey the builder's dialog passes.)
 */

export type PaneId = 'fields' | 'middle';

const STORAGE_KEY = 'rcd.chartBuilder.panes';

/** Track minimums, mirroring the fluid grid's floors (6.5rem / 13rem / 8rem). */
const PANE_MIN: Record<PaneId, number> = { fields: 104, middle: 208 };
const PREVIEW_MIN = 128;

/** Fluid (untouched) tracks — identical to the pre-divider grid columns. */
const FLUID_TRACK: Record<PaneId, string> = {
  fields: 'minmax(6.5rem, 11.5rem)',
  middle: 'minmax(13rem, 21rem)',
};

/** Divider column width; replaces the old gap-3 (12px) so the rhythm holds. */
const DIVIDER_PX = 12;

/** Arrow-key resize step on a focused divider. */
const KEY_STEP = 16;

interface PaneSizes {
  fields?: number;
  middle?: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

function readStoredSizes(): PaneSizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const sizes: PaneSizes = {};
    for (const pane of ['fields', 'middle'] as const) {
      const value = (parsed as Record<string, unknown>)[pane];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        sizes[pane] = Math.round(value);
      }
    }
    return sizes;
  } catch {
    return {};
  }
}

function writeStoredSizes(sizes: PaneSizes) {
  try {
    if (sizes.fields === undefined && sizes.middle === undefined) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
    }
  } catch {
    // Storage unavailable (private mode / quota) — sizes stay session-only.
  }
}

export interface BuilderPanesApi {
  /** Inline grid-template-columns for the 5-track grid (pane, divider, pane, divider, preview). */
  gridTemplateColumns: string;
  /** Pane whose divider is mid-drag; null otherwise (drives divider emphasis). */
  draggingPane: PaneId | null;
  startDrag: (pane: PaneId) => (event: ReactPointerEvent<HTMLDivElement>) => void;
  moveDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  endDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Double-click: back to the fluid default for that pane. */
  reset: (pane: PaneId) => void;
  /** Keyboard resize on a focused divider (ArrowLeft/ArrowRight). */
  nudge: (pane: PaneId, delta: number) => void;
}

export function useBuilderPanes(
  containerRef: RefObject<HTMLDivElement | null>,
  paneRefs: Record<PaneId, RefObject<HTMLDivElement | null>>,
): BuilderPanesApi {
  const [sizes, setSizes] = useState<PaneSizes>(readStoredSizes);
  const [draggingPane, setDraggingPane] = useState<PaneId | null>(null);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const dragRef = useRef<{
    pane: PaneId;
    startX: number;
    startWidth: number;
    max: number;
    /** Last width applied during this drag — endDrag persists THIS, not the
        rendered state, because pointerup can fire before React flushes the
        final pointermove's setState into sizesRef. */
    width?: number;
  } | null>(null);

  /** Widest a pane may drag to while the other pane and preview keep their mins. */
  const maxWidthFor = useCallback(
    (pane: PaneId): number => {
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
      const otherMin = pane === 'fields' ? PANE_MIN.middle : PANE_MIN.fields;
      return Math.max(
        PANE_MIN[pane],
        containerWidth - 2 * DIVIDER_PX - PREVIEW_MIN - otherMin,
      );
    },
    [containerRef],
  );

  const applySize = useCallback((pane: PaneId, width: number) => {
    setSizes((previous) => (previous[pane] === width ? previous : { ...previous, [pane]: width }));
  }, []);

  const startDrag = useCallback(
    (pane: PaneId) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const paneEl = paneRefs[pane].current;
      if (!paneEl) return;
      dragRef.current = {
        pane,
        startX: event.clientX,
        startWidth: paneEl.getBoundingClientRect().width,
        max: maxWidthFor(pane),
      };
      setDraggingPane(pane);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      // No text selection / cursor flicker anywhere while the divider moves.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    },
    [paneRefs, maxWidthFor],
  );

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const width = clamp(
        Math.round(drag.startWidth + event.clientX - drag.startX),
        PANE_MIN[drag.pane],
        drag.max,
      );
      drag.width = width;
      applySize(drag.pane, width);
    },
    [applySize],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDraggingPane(null);
    // Also reached via pointercancel, where capture may already be gone.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    writeStoredSizes(
      drag.width !== undefined
        ? { ...sizesRef.current, [drag.pane]: drag.width }
        : sizesRef.current,
    );
  }, []);

  // Dialog closed mid-drag: never leave the body styles behind.
  useEffect(
    () => () => {
      if (dragRef.current) {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    },
    [],
  );

  const reset = useCallback((pane: PaneId) => {
    setSizes((previous) => {
      const next = { ...previous };
      delete next[pane];
      writeStoredSizes(next);
      return next;
    });
  }, []);

  const nudge = useCallback(
    (pane: PaneId, delta: number) => {
      const paneEl = paneRefs[pane].current;
      if (!paneEl) return;
      const width = clamp(
        Math.round(paneEl.getBoundingClientRect().width + delta),
        PANE_MIN[pane],
        maxWidthFor(pane),
      );
      setSizes((previous) => {
        const next = { ...previous, [pane]: width };
        writeStoredSizes(next);
        return next;
      });
    },
    [paneRefs, maxWidthFor],
  );

  const track = (pane: PaneId) =>
    sizes[pane] !== undefined
      ? `minmax(${PANE_MIN[pane]}px, ${sizes[pane]}px)`
      : FLUID_TRACK[pane];

  const gridTemplateColumns = [
    track('fields'),
    `${DIVIDER_PX}px`,
    track('middle'),
    `${DIVIDER_PX}px`,
    `minmax(${PREVIEW_MIN}px, 1fr)`,
  ].join(' ');

  return { gridTemplateColumns, draggingPane, startDrag, moveDrag, endDrag, reset, nudge };
}

export interface PaneDividerProps {
  /** Pane to the divider's LEFT — the one whose width the divider adjusts. */
  pane: PaneId;
  panes: BuilderPanesApi;
  label: string;
}

/**
 * Hairline divider occupying its own 12px grid column: subtle 1px line at
 * rest, thicker accent line + col-resize cursor on hover/drag. Double-click
 * restores the pane's fluid default; arrow keys resize when focused.
 */
export function PaneDivider({ pane, panes, label }: PaneDividerProps) {
  const active = panes.draggingPane === pane;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      panes.nudge(pane, event.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP);
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className="group flex min-h-0 cursor-col-resize touch-none items-stretch justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive)]"
      onPointerDown={panes.startDrag(pane)}
      onPointerMove={panes.moveDrag}
      onPointerUp={panes.endDrag}
      onPointerCancel={panes.endDrag}
      onDoubleClick={() => panes.reset(pane)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={`my-1 rounded-full transition-colors ${
          active
            ? 'w-[3px] bg-[var(--rcd-accent-interactive)]'
            : 'w-px bg-rcd-border group-hover:w-[3px] group-hover:bg-[var(--rcd-accent-interactive)]'
        }`}
      />
    </div>
  );
}
