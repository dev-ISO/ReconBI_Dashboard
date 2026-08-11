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
  onLayoutChange?: (items: DashboardGridItem[]) => void;
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
}

/**
 * Serializable dashboard grid. Wraps react-grid-layout so the rest of the
 * library (and any fallback grid engine) only ever sees DashboardGridItem[].
 */
export function DashboardGrid({
  items,
  editable = false,
  onLayoutChange,
  renderItem,
  draggableHandle,
  minRows = 24,
  boundaryHeight = null,
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
      <Grid
        className="rcd-dashboard-grid"
        layout={layout}
        cols={24}
        rowHeight={ROW_HEIGHT}
        margin={[MARGIN, MARGIN]}
        compactType={null}
        preventCollision
        isDraggable={editable}
        isResizable={editable}
        draggableHandle={draggableHandle}
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
    </div>
  );
}
