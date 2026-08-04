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
   */
  minRows?: number;
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
    // RGL still grows its own height past the floor as tiles move down.
    <div style={{ minHeight: editable ? minRows * (ROW_HEIGHT + MARGIN) : undefined }}>
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
