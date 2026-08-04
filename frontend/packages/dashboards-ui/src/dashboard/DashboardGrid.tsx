import { useMemo, type ReactNode } from 'react';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';

const Grid = WidthProvider(RGL);

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
}

/**
 * Serializable dashboard grid. Wraps react-grid-layout so the rest of the
 * library (and any fallback grid engine) only ever sees DashboardGridItem[].
 */
export function DashboardGrid({ items, editable = false, onLayoutChange, renderItem }: DashboardGridProps) {
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
    <Grid
      className="rcd-dashboard-grid"
      layout={layout}
      cols={24}
      rowHeight={32}
      margin={[12, 12]}
      isDraggable={editable}
      isResizable={editable}
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
  );
}
