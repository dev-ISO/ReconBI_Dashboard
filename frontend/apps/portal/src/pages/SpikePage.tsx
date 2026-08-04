import { useState } from 'react';
import {
  newId,
  type Catalog,
  type CatalogColumn,
  type ColumnType,
  type ModelDefinition,
  type RelationshipSuggestion,
} from '@recon/dashboards-core';
import { DashboardGrid, ModelCanvas, type DashboardGridItem } from '@recon/dashboards-ui';

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

const col = (name: string, ordinal: number, type: ColumnType, isNullable = false): CatalogColumn => ({
  name,
  ordinal,
  rawType: type,
  type,
  isNullable,
  comment: null,
});

const spikeCatalog: Catalog = {
  connection: 'spike',
  versionHash: 'spike',
  fetchedAtUtc: new Date(0).toISOString(),
  tables: [
    {
      schema: 'public',
      name: 'orders',
      key: 'public.orders',
      kind: 'table',
      rowEstimate: 12800,
      comment: null,
      columns: [
        col('id', 1, 'integer'),
        col('customer_id', 2, 'integer'),
        col('amount', 3, 'decimal'),
        col('placed_at', 4, 'timestamp'),
      ],
      primaryKey: ['id'],
      uniqueConstraints: [],
    },
    {
      schema: 'public',
      name: 'customers',
      key: 'public.customers',
      kind: 'table',
      rowEstimate: 950,
      comment: null,
      columns: [col('id', 1, 'integer'), col('name', 2, 'text'), col('region', 3, 'text', true)],
      primaryKey: ['id'],
      uniqueConstraints: [],
    },
  ],
  foreignKeys: [],
  suggestions: [
    {
      fromTable: 'public.orders',
      fromColumn: 'customer_id',
      toTable: 'public.customers',
      toColumn: 'id',
      constraintName: 'orders_customer_id_fkey',
      compositeUnsupported: false,
    },
  ],
};

const initialDefinition: ModelDefinition = {
  version: 1,
  tables: [
    { schema: 'public', name: 'orders', position: { x: 40, y: 40 } },
    { schema: 'public', name: 'customers', position: { x: 420, y: 120 } },
  ],
  relationships: [],
  measures: [],
};

export function SpikePage() {
  const [items, setItems] = useState(initialItems);
  const [definition, setDefinition] = useState(initialDefinition);

  const acceptSuggestion = (s: RelationshipSuggestion) =>
    setDefinition((d) => ({
      ...d,
      relationships: [
        ...d.relationships,
        {
          id: newId(),
          fromTable: s.fromTable,
          fromColumn: s.fromColumn,
          toTable: s.toTable,
          toColumn: s.toColumn,
          cardinality: 'manyToOne',
          isActive: true,
          source: 'fk',
        },
      ],
    }));

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
        <h2 className="mb-2 text-lg font-semibold">
          Canvas spike (accept the suggestion, drag columns to connect, click an edge to toggle it)
        </h2>
        <div className="min-h-64 flex-1 overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface">
          <ModelCanvas
            definition={definition}
            catalog={spikeCatalog}
            suggestions={spikeCatalog.suggestions}
            onMoveTable={(key, position) =>
              setDefinition((d) => ({
                ...d,
                tables: d.tables.map((t) =>
                  `${t.schema}.${t.name}` === key ? { ...t, position } : t,
                ),
              }))
            }
            onConnect={(input) =>
              setDefinition((d) => ({
                ...d,
                relationships: [
                  ...d.relationships,
                  { id: newId(), ...input, cardinality: 'manyToOne', isActive: true, source: 'manual' },
                ],
              }))
            }
            onEditRelationship={(id) =>
              setDefinition((d) => ({
                ...d,
                relationships: d.relationships.map((r) =>
                  r.id === id ? { ...r, isActive: !r.isActive } : r,
                ),
              }))
            }
            onAcceptSuggestion={acceptSuggestion}
            onRemoveTable={(key) =>
              setDefinition((d) => ({
                ...d,
                tables: d.tables.filter((t) => `${t.schema}.${t.name}` !== key),
                relationships: d.relationships.filter(
                  (r) => r.fromTable !== key && r.toTable !== key,
                ),
              }))
            }
          />
        </div>
      </section>
    </div>
  );
}
