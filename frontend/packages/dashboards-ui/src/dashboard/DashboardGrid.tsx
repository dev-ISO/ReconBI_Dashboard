import { useMemo, type ReactNode } from 'react';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';

const Grid = WidthProvider(RGL);

const ROW_HEIGHT = 32;
const MARGIN = 12;

export interface DashboardGridItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface DashboardGridProps {
  items: DashboardGridItem[];
  editable?: boolean;
  /**
   * Edit-mode canvas whose tiles cannot be moved or resized — an honest-UX
   * lock for grantees without layout rights (the server enforces regardless).
   * Ignored while `editable` is false.
   */
  locked?: boolean;
  onLayoutChange?: (items: DashboardGridItem[]) => void;
  /**
   * A tile's move/resize gesture began/ended (collab wave 1: the view uses
   * these to acquire/release the tile's soft lock for the drag's duration).
   * Resize counts as a drag — both gestures rewrite the tile's geometry.
   */
  onItemDragStart?: (id: string) => void;
  onItemDragStop?: (id: string) => void;
  renderItem: (id: string) => ReactNode;
  /** CSS selector for the per-tile drag handle; the whole tile drags when omitted. */
  draggableHandle?: string;
  /**
   * Minimum canvas height in grid rows (default 24) so edit mode always has
   * empty space to drag tiles into; the canvas still grows past it with content.
   * Superseded by `boundaryHeight` when provided.
   */
  minRows?: number;
  /**
   * Edit-mode page boundary (px): the canvas height that fits the current
   * viewport without scrolling (Power BI's page edge). When set, the canvas'
   * min-height is exactly this — authors get a screen-sized workspace, not an
   * arbitrarily tall one — and a subtle dashed guide line marks the fold.
   * Tiles can still be dragged past it (the canvas grows with content; taller
   * existing dashboards simply show content past the line).
   */
  boundaryHeight?: number | null;
  /**
   * COLLAB wave 2 cursor tap: pointer position over the GRID CONTENT BOX as
   * 0..1 fractions of its layout size. The content box is the tight wrapper
   * around react-grid-layout's root — deliberately NOT the outer canvas: the
   * canvas carries the edit-mode min-height workspace (viewport-dependent, so
   * DIFFERENT per client), while the RGL content box derives purely from the
   * shared document, making fractions comparable across every client and
   * mode. Measured via getBoundingClientRect, so any ancestor zoom/scale
   * cancels out (visual px over visual px). Fires on every pointermove
   * (capture phase — tiles can't swallow it); the consumer throttles.
   */
  onPointerFraction?: (xFrac: number, yFrac: number) => void;
  /** Companion to onPointerFraction: the pointer left the grid content box. */
  onPointerLeaveGrid?: () => void;
  /**
   * COLLAB wave 2 overlay slot (remote cursors): rendered absolutely over the
   * grid content box, INSIDE the same wrapper onPointerFraction measures — so
   * a fraction sent from one client renders over the same spot on every
   * other, and under fit-to-page zoom the overlay inherits the scale exactly
   * like the tiles. Must be pointer-events-none chrome.
   */
  overlay?: ReactNode;
}

/**
 * Serializable dashboard grid. Wraps react-grid-layout so the rest of the
 * library (and any fallback grid engine) only ever sees DashboardGridItem[].
 */
export function DashboardGrid({
  items,
  editable = false,
  locked = false,
  onLayoutChange,
  onItemDragStart,
  onItemDragStop,
  renderItem,
  draggableHandle,
  minRows = 24,
  boundaryHeight = null,
  onPointerFraction,
  onPointerLeaveGrid,
  overlay,
}: DashboardGridProps) {
  const layout: Layout[] = useMemo(
    () =>
      items.map((item) => ({
        i: item.id,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        minW: item.minW,
        minH: item.minH,
      })),
    [items],
  );

  return (
    // Free canvas (Power BI-style): no auto-compaction, collisions blocked, and
    // a min-height floor so there is always empty space to drag tiles into.
    // With a measured page boundary the floor is EXACTLY the viewport-fitting
    // height (screen-sized workspace, not an arbitrarily tall one); RGL still
    // grows its own height past the floor as tiles move down.
    <div
      className={editable ? 'relative' : undefined}
      style={{
        minHeight: editable ? (boundaryHeight ?? minRows * (ROW_HEIGHT + MARGIN)) : undefined,
      }}
    >
      {editable && boundaryHeight != null && (
        // Page-boundary guide (Power BI's page edge): everything above the
        // dashed line fits the current viewport without scrolling. Purely
        // visual — never intercepts pointer events; tiles paint over it.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0"
          style={{ top: boundaryHeight }}
        >
          <div className="border-t border-dashed border-rcd-border" />
          <span className="absolute right-0 top-1 rounded bg-rcd-surface px-1.5 py-0.5 text-[10px] font-medium text-rcd-muted shadow-[var(--rcd-shadow-1)]">
            Page boundary — tiles below this line will scroll for viewers
          </span>
        </div>
      )}
      {/* GRID CONTENT BOX (wave 2): the tight relative wrapper the cursor
          contract measures against and the overlay paints over. Its height is
          the RGL content height — purely document-derived, so identical on
          every client in every mode (the min-height workspace above never
          leaks in). Handlers ride the CAPTURE phase so tiles/charts cannot
          swallow the moves; fractions divide the box's own visual rect, which
          cancels any ancestor fit-to-page zoom. */}
      <div
        className="relative"
        onPointerMoveCapture={
          onPointerFraction === undefined
            ? undefined
            : (event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return;
                onPointerFraction(
                  (event.clientX - rect.left) / rect.width,
                  (event.clientY - rect.top) / rect.height,
                );
              }
        }
        onPointerLeave={onPointerLeaveGrid}
      >
        <Grid
          className="rcd-dashboard-grid"
          layout={layout}
          cols={24}
          rowHeight={ROW_HEIGHT}
          margin={[MARGIN, MARGIN]}
          compactType={null}
          preventCollision
          isDraggable={editable && !locked}
          isResizable={editable && !locked}
          draggableHandle={draggableHandle}
          // Move AND resize both report as drag start/stop — either gesture
          // rewrites the tile's geometry (the soft-lock consumer treats them
          // identically).
          onDragStart={(_layout: Layout[], oldItem: Layout) => onItemDragStart?.(oldItem.i)}
          onDragStop={(_layout: Layout[], oldItem: Layout) => onItemDragStop?.(oldItem.i)}
          onResizeStart={(_layout: Layout[], oldItem: Layout) => onItemDragStart?.(oldItem.i)}
          onResizeStop={(_layout: Layout[], oldItem: Layout) => onItemDragStop?.(oldItem.i)}
          onLayoutChange={(next: Layout[]) =>
            onLayoutChange?.(
              next.map((l) => ({
                id: l.i,
                x: l.x,
                y: l.y,
                w: l.w,
                h: l.h,
                minW: l.minW ?? undefined,
                minH: l.minH ?? undefined,
              })),
            )
          }
        >
          {items.map((item) => (
            <div key={item.id}>{renderItem(item.id)}</div>
          ))}
        </Grid>
        {overlay}
      </div>
    </div>
  );
}
