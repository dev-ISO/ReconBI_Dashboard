import { useDraggable } from '@dnd-kit/core';
import {
  Braces,
  CalendarDays,
  Hash,
  KeyRound,
  Sigma,
  ToggleLeft,
  Type,
} from 'lucide-react';
import {
  isQueryableType,
  tableKey,
  type Catalog,
  type ColumnType,
  type ModelDefinition,
  type ModelTable,
} from '@recon/dashboards-core';
import type { FieldDragData } from './wellConfig';

export interface FieldListProps {
  model: ModelDefinition;
  /** Column metadata for the model's data source; measure-only fallback when null. */
  catalog: Catalog | null;
  /** Click-to-add: the builder routes the entry to the most sensible well. */
  onAdd: (data: FieldDragData) => void;
}

const typeIcon = (type: ColumnType) => {
  switch (type) {
    case 'integer':
    case 'decimal':
      return <Hash size={13} />;
    case 'date':
    case 'timestamp':
      return <CalendarDays size={13} />;
    case 'boolean':
      return <ToggleLeft size={13} />;
    case 'uuid':
      return <KeyRound size={13} />;
    case 'json':
      return <Braces size={13} />;
    default:
      return <Type size={13} />;
  }
};

/** Model-scoped field pane: one section per model table plus a Measures section. */
export function FieldList({ model, catalog, onAdd }: FieldListProps) {
  const tables = model.tables.filter((table) => !table.hidden);

  return (
    <div className="flex flex-col pb-2" data-testid="rcd-field-list">
      {catalog === null && (
        <p className="px-3 pt-3 text-xs text-rcd-muted">
          Column catalog unavailable — drag measures below, or reopen the model to load columns.
        </p>
      )}
      {catalog !== null &&
        tables.map((table) => (
          <TableSection key={tableKey(table.schema, table.name)} table={table} catalog={catalog} onAdd={onAdd} />
        ))}

      <SectionHeader icon={<Sigma size={12} />} label="Measures" />
      {model.measures.length === 0 ? (
        <p className="px-3 py-1 text-xs text-rcd-muted">No measures defined in this model.</p>
      ) : (
        model.measures.map((measure) => (
          <FieldEntry
            key={measure.id}
            id={`measure:${measure.id}`}
            data={{ kind: 'measure', measureId: measure.id, name: measure.name }}
            label={measure.name}
            icon={<Sigma size={13} />}
            onAdd={onAdd}
          />
        ))
      )}
    </div>
  );
}

function TableSection({
  table,
  catalog,
  onAdd,
}: {
  table: ModelTable;
  catalog: Catalog;
  onAdd: (data: FieldDragData) => void;
}) {
  const key = tableKey(table.schema, table.name);
  const catalogTable = catalog.tables.find((t) => t.key === key);
  const overrides = new Map((table.columns ?? []).map((c) => [c.name, c]));

  const columns = (catalogTable?.columns ?? []).filter(
    (column) => isQueryableType(column.type) && !overrides.get(column.name)?.hidden,
  );

  return (
    <>
      <SectionHeader label={table.friendlyName ?? table.name} />
      {catalogTable === undefined ? (
        <p className="px-3 py-1 text-xs text-rcd-muted">Table not found in the catalog.</p>
      ) : columns.length === 0 ? (
        <p className="px-3 py-1 text-xs text-rcd-muted">No queryable columns.</p>
      ) : (
        columns.map((column) => (
          <FieldEntry
            key={column.name}
            id={`column:${key}:${column.name}`}
            data={{ kind: 'column', table: key, column: column.name, type: column.type }}
            label={overrides.get(column.name)?.friendlyName ?? column.name}
            icon={typeIcon(column.type)}
            onAdd={onAdd}
          />
        ))
      )}
    </>
  );
}

function SectionHeader({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
      {icon}
      <span className="truncate" title={label}>
        {label}
      </span>
    </div>
  );
}

function FieldEntry({
  id,
  data,
  label,
  icon,
  onAdd,
}: {
  id: string;
  data: FieldDragData;
  label: string;
  icon: React.ReactNode;
  onAdd: (data: FieldDragData) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data });

  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onAdd(data)}
      title="Drag into a well, or click to add"
      className={`mx-1 flex cursor-grab items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10 ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <span className="shrink-0 text-rcd-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
