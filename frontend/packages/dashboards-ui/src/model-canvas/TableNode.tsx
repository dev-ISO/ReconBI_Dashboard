import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { X } from 'lucide-react';

export interface TableNodeColumn {
  name: string;
  /** Non-queryable columns render dimmed and get no connection handles. */
  queryable: boolean;
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
 */
export function TableNode({ data, selected }: NodeProps<TableNodeType>) {
  return (
    <div
      className={
        selected
          ? 'w-52 overflow-hidden rounded-lg border border-rcd-accent bg-rcd-surface text-rcd-text shadow-md'
          : 'w-52 overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface text-rcd-text shadow-sm'
      }
    >
      <div className="flex items-center gap-2 border-b border-rcd-border px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{data.title}</div>
          <div className="truncate text-[10px] text-rcd-muted">{data.schema}</div>
        </div>
        <button
          type="button"
          className="nodrag shrink-0 rounded p-0.5 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
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
        {data.columns.map((column) => (
          <div key={column.name} className="relative flex items-center px-2.5 py-0.5">
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
            <span
              className={
                column.queryable
                  ? 'truncate text-[11px] leading-4 text-rcd-text-2'
                  : 'truncate text-[11px] leading-4 text-rcd-muted opacity-60'
              }
            >
              {column.name}
            </span>
          </div>
        ))}
        {data.moreCount > 0 && (
          <div className="px-2.5 py-0.5 text-[10px] text-rcd-muted">+{data.moreCount} more</div>
        )}
      </div>
    </div>
  );
}
