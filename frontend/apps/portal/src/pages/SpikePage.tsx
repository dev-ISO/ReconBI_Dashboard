import { useState } from 'react';
import {
  DashboardGrid,
  ModelCanvas,
  type DashboardGridItem,
  type CanvasNode,
  type CanvasEdge,
} from '@recon/dashboards-ui';

/**
 * React 19 compatibility spike (Phase 0 gate): react-grid-layout drag/resize
 * and an @xyflow/react canvas must both work under StrictMode with zero
 * console errors. If RGL fails here, DashboardGrid's internals swap to
 * gridstack — nothing else changes.
 */
const initialItems: DashboardGridItem[] = [
  { id: 'tile-a', x: 0, y: 0, w: 8, h: 6, minW: 4, minH: 4 },
  { id: 'tile-b', x: 8, y: 0, w: 8, h: 6, minW: 4, minH: 4 },
];

const spikeNodes: CanvasNode[] = [
  { id: 'orders', position: { x: 0, y: 0 }, data: { label: 'orders' } },
  { id: 'customers', position: { x: 260, y: 120 }, data: { label: 'customers' } },
];

const spikeEdges: CanvasEdge[] = [
  { id: 'orders-customers', source: 'orders', target: 'customers', label: '* — 1' },
];

export function SpikePage() {
  const [items, setItems] = useState(initialItems);

  return (
    <div className="rcd-root flex h-full flex-col gap-4 p-6">
      <section>
        <h2 className="mb-2 text-lg font-semibold">Grid spike (drag/resize the tiles)</h2>
        <div className="rounded-lg border border-rcd-border bg-rcd-surface">
          <DashboardGrid
            items={items}
            editable
            onLayoutChange={setItems}
            renderItem={(id) => (
              <div className="flex h-full flex-col rounded-md border border-rcd-border bg-rcd-bg p-3">
                <span className="text-sm font-medium">{id}</span>
                <code className="mt-2 text-xs text-rcd-muted">
                  {JSON.stringify(items.find((t) => t.id === id))}
                </code>
              </div>
            )}
          />
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <h2 className="mb-2 text-lg font-semibold">Canvas spike</h2>
        <div className="min-h-64 flex-1 overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface">
          <ModelCanvas nodes={spikeNodes} edges={spikeEdges} />
        </div>
      </section>
    </div>
  );
}
