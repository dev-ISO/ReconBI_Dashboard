import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { X } from 'lucide-react';

/** One relationship a column participates in (drives the color markers). */
export interface TableNodeColumnRel {
  relationshipId: string;
  /** The relationship's stable hue (same as its edge). */
  color: string;
  isActive: boolean;
  /** True while the relationship's edge is selected on the canvas. */
  selected: boolean;
  /** "schema.table.column" on the other side (tooltip). */
  otherEndpoint: string;
}

export interface TableNodeColumn {
  name: string;
  /** Non-queryable columns render dimmed and get no connection handles. */
  queryable: boolean;
  /** Relationships through this column; empty/undefined = neutral rendering. */
  relationships?: TableNodeColumnRel[];
}

export interface TableNodeData extends Record<string, unknown> {
  /** Canonical "schema.table" key (also the node id). */
  tableKey: string;
  title: string;
  schema: string;
  columns: TableNodeColumn[];
  /** Columns hidden by the display cap. */
  moreCount: number;
  /** False while the catalog is still loading. */
  catalogLoaded: boolean;
  /** True when the catalog loaded but no longer contains this table. */
  missing: boolean;
  onRemove: (key: string) => void;
}

export type TableNodeType = Node<TableNodeData, 'rcdTable'>;

/**
 * Canvas node for one model table: header (name + schema + remove) and column
 * rows. Each queryable column exposes source + target handles on BOTH sides
 * (ids `${column}::l-src` / `::r-src` / `::l-tgt` / `::r-tgt`) so ModelCanvas
 * can attach every edge to the side facing the other node — lines never wrap
 * behind nodes. Each side's pair overlaps visually as a single dot.
 *
 * Columns used by exactly one relationship render a leading color bar + tinted
 * name in that relationship's hue; columns shared by several relationships
 * stay neutral and show one color dot per relationship instead. A selected
 * edge additionally tints its two endpoint rows.
 */
export function TableNode({ data, selected }: NodeProps<TableNodeType>) {
  return (
    <div
      className={
        selected
          ? 'w-52 overflow-hidden rounded-lg border border-rcd-accent bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-2)] ring-1 ring-rcd-accent'
          : 'w-52 overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-1)] transition-shadow'
      }
    >
      <div className="flex items-center gap-2 border-b border-rcd-border bg-black/[0.02] px-2.5 py-1.5 dark:bg-white/[0.03]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{data.title}</div>
          <div className="truncate text-[10px] text-rcd-muted">{data.schema}</div>
        </div>
        <button
          type="button"
          className="nodrag shrink-0 rounded-sm p-0.5 text-rcd-muted transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
          onClick={() => data.onRemove(data.tableKey)}
          aria-label={`Remove ${data.title} from model`}
        >
          <X size={12} />
        </button>
      </div>

      <div className="py-1">
        {!data.catalogLoaded && (
          <div className="px-2.5 py-1 text-[10px] text-rcd-muted">Loading columns…</div>
        )}
        {data.catalogLoaded && data.missing && (
          <div className="px-2.5 py-1 text-[10px] text-[var(--rcd-status-warn)]">
            Missing from catalog
          </div>
        )}
        {data.columns.map((column) => {
          const rels = column.relationships ?? [];
          const single = rels.length === 1 ? rels[0]! : null;
          const selectedRel = rels.find((rel) => rel.selected) ?? null;
          return (
            <div
              key={column.name}
              className="relative flex items-center gap-1 px-2.5 py-0.5"
              style={
                selectedRel
                  ? { backgroundColor: `color-mix(in srgb, ${selectedRel.color} 14%, transparent)` }
                  : undefined
              }
            >
              {column.queryable && (
                <>
                  {/* Targets first so the source handle sits on top and starts drags;
                      drops still land on targets via React Flow's closest-handle logic. */}
                  <Handle type="target" position={Position.Left} id={`${column.name}::l-tgt`} />
                  <Handle type="source" position={Position.Left} id={`${column.name}::l-src`} />
                  <Handle type="target" position={Position.Right} id={`${column.name}::r-tgt`} />
                  <Handle type="source" position={Position.Right} id={`${column.name}::r-src`} />
                </>
              )}
              {single && (
                <span
                  aria-hidden
                  className="h-2.5 w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: single.color, opacity: single.isActive ? 1 : 0.45 }}
                />
              )}
              <span
                className={
                  column.queryable
                    ? 'min-w-0 flex-1 truncate text-[11px] leading-4 text-rcd-text-2'
                    : 'min-w-0 flex-1 truncate text-[11px] leading-4 text-rcd-muted opacity-60'
                }
                style={
                  single ? { color: single.color, opacity: single.isActive ? undefined : 0.65 } : undefined
                }
                title={single ? `Related to ${single.otherEndpoint}` : undefined}
              >
                {column.name}
              </span>
              {rels.length > 1 && (
                <span className="flex shrink-0 items-center gap-0.5 pl-1">
                  {rels.map((rel) => (
                    <span
                      key={rel.relationshipId}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: rel.color, opacity: rel.isActive ? 1 : 0.4 }}
                      title={`${rel.isActive ? 'Related' : 'Inactive relationship'} to ${rel.otherEndpoint}`}
                    />
                  ))}
                </span>
              )}
            </div>
          );
        })}
        {data.moreCount > 0 && (
          <div className="px-2.5 py-0.5 text-[10px] text-rcd-muted">+{data.moreCount} more</div>
        )}
      </div>
    </div>
  );
}
