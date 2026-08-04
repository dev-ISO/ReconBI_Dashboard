import { useDraggable } from '@dnd-kit/core';
import {
  Braces,
  CalendarDays,
  Filter,
  Hash,
  KeyRound,
  Sigma,
  ToggleLeft,
  Type,
} from 'lucide-react';
import {
  DATE_TABLE_COLUMNS,
  dateTableKey,
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
  /** Funnel affordance on column rows: adds the column as a chart filter. */
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
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

/** Model-scoped field pane: one section per model table and date table plus a Measures section. */
export function FieldList({ model, catalog, onAdd, onAddFilter }: FieldListProps) {
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
          <TableSection
            key={tableKey(table.schema, table.name)}
            table={table}
            catalog={catalog}
            onAdd={onAdd}
            onAddFilter={onAddFilter}
          />
        ))}

      {(model.dateTables ?? []).map((dateTable) => (
        <DateTableSection
          key={dateTableKey(dateTable.name)}
          name={dateTable.name}
          onAdd={onAdd}
          onAddFilter={onAddFilter}
        />
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
            badge={measure.expression ? <FxBadge /> : undefined}
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
  onAddFilter,
}: {
  table: ModelTable;
  catalog: Catalog;
  onAdd: (data: FieldDragData) => void;
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
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
        columns.map((column) => {
          const data = {
            kind: 'column',
            table: key,
            column: column.name,
            type: column.type,
          } as const;
          return (
            <FieldEntry
              key={column.name}
              id={`column:${key}:${column.name}`}
              data={data}
              label={overrides.get(column.name)?.friendlyName ?? column.name}
              icon={typeIcon(column.type)}
              onAdd={onAdd}
              onFilter={onAddFilter ? () => onAddFilter(data) : undefined}
            />
          );
        })
      )}
    </>
  );
}

/**
 * Engine date table: the 8 fixed columns rendered as normal column entries.
 * Needs no catalog — the schema is fixed — so it renders even when the
 * catalog failed to load. Drag payloads address the table by its
 * '#date.{name}' key.
 */
function DateTableSection({
  name,
  onAdd,
  onAddFilter,
}: {
  name: string;
  onAdd: (data: FieldDragData) => void;
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
}) {
  const key = dateTableKey(name);

  return (
    <>
      <SectionHeader icon={<CalendarDays size={12} />} label={name} />
      {DATE_TABLE_COLUMNS.map((column) => {
        const data = {
          kind: 'column',
          table: key,
          column: column.name,
          type: column.type,
        } as const;
        return (
          <FieldEntry
            key={column.name}
            id={`column:${key}:${column.name}`}
            data={data}
            label={column.name}
            icon={typeIcon(column.type)}
            onAdd={onAdd}
            onFilter={onAddFilter ? () => onAddFilter(data) : undefined}
          />
        );
      })}
    </>
  );
}

/** Cosmetic suffix marking a calculated (expression-backed) measure. */
function FxBadge() {
  return (
    <span
      title="Calculated measure"
      className="ml-auto shrink-0 rounded bg-black/10 px-1 text-[10px] font-medium italic leading-4 text-rcd-muted dark:bg-white/10"
    >
      fx
    </span>
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
  badge,
  onAdd,
  onFilter,
}: {
  id: string;
  data: FieldDragData;
  label: string;
  icon: React.ReactNode;
  /** Cosmetic suffix (e.g. the "fx" marker); never part of the drag payload. */
  badge?: React.ReactNode;
  onAdd: (data: FieldDragData) => void;
  /** When present, shows the funnel button that adds the field as a filter. */
  onFilter?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data });

  return (
    <div
      className={`group mx-1 flex items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10 ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <button
        type="button"
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        onClick={() => onAdd(data)}
        title="Drag into a well, or click to add"
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-2 py-1 text-left text-sm text-rcd-text"
      >
        <span className="shrink-0 text-rcd-muted">{icon}</span>
        <span className="truncate">{label}</span>
        {badge}
      </button>
      {onFilter && (
        <button
          type="button"
          aria-label={`Filter by ${label}`}
          title={`Filter by ${label}`}
          onClick={onFilter}
          className="mr-1 shrink-0 rounded p-1 text-rcd-muted opacity-0 hover:bg-black/10 hover:text-rcd-text focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10"
        >
          <Filter size={12} />
        </button>
      )}
    </div>
  );
}
