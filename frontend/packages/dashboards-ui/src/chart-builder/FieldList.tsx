import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Filter,
  Folder,
  Plus,
  Search,
  Sigma,
  Variable,
} from 'lucide-react';
import {
  DATE_TABLE_COLUMNS,
  dateTableKey,
  isQueryableType,
  tableKey,
  type Catalog,
  type Measure,
  type ModelDefinition,
  type ModelTable,
} from '@recon/dashboards-core';
import { ColumnTypeIcon } from '../data-pane/SchemaExplorer';
import { RcdInput } from '../primitives';
import type { BuilderParameter, FieldDragData } from './wellConfig';

export interface FieldListProps {
  model: ModelDefinition;
  /** Column metadata for the model's data source; measure-only fallback when null. */
  catalog: Catalog | null;
  /**
   * Dashboard field parameters (threaded by the dashboard runtime). Absent or
   * empty hides the Parameters section — the standalone builder never gets it.
   */
  parameters?: BuilderParameter[];
  /** Click-to-add: the builder routes the entry to the most sensible well. */
  onAdd: (data: FieldDragData) => void;
  /** Funnel affordance on column rows: adds the column as a chart filter. */
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
}

/** Expansion-state keys for the fixed sections (table sections use their tableKey). */
const MEASURES_KEY = '#measures';
const PARAMETERS_KEY = '#parameters';
const folderKey = (path: string[]): string => `#measures/${path.join('\\')}`;

/** One node of the Measures section's displayFolder tree. */
interface MeasureFolderNode {
  name: string;
  /** Expansion-state key (full path). */
  key: string;
  folders: MeasureFolderNode[];
  measures: Measure[];
}

/** Groups measures into a folder tree by their backslash-separated displayFolder. */
const buildMeasureFolders = (
  measures: Measure[],
): { root: Measure[]; folders: MeasureFolderNode[] } => {
  const root: Measure[] = [];
  const top: MeasureFolderNode[] = [];
  const ensure = (nodes: MeasureFolderNode[], path: string[]): MeasureFolderNode => {
    const name = path[path.length - 1]!;
    let node = nodes.find((n) => n.name === name);
    if (!node) {
      node = { name, key: folderKey(path), folders: [], measures: [] };
      nodes.push(node);
    }
    return node;
  };
  for (const measure of measures) {
    const segments = (measure.displayFolder ?? '')
      .split('\\')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (segments.length === 0) {
      root.push(measure);
      continue;
    }
    let nodes = top;
    let node: MeasureFolderNode | null = null;
    for (let i = 0; i < segments.length; i++) {
      node = ensure(nodes, segments.slice(0, i + 1));
      nodes = node.folders;
    }
    node!.measures.push(measure);
  }
  return { root, folders: top };
};

/** Every folder key in the tree (default-expanded initialization). */
const collectFolderKeys = (nodes: MeasureFolderNode[], into: string[]): string[] => {
  for (const node of nodes) {
    into.push(node.key);
    collectFolderKeys(node.folders, into);
  }
  return into;
};

/**
 * Model-scoped field pane in the SchemaExplorer idiom: a search input over
 * tables AND columns, collapsible per-table sections (chevron rows), and
 * collapsible Date table / Measures / Parameters sections — measures further
 * grouped into displayFolder folders. Drag payloads, click-to-add (with the
 * post-drag swallow upstream), and the funnel affordance are unchanged; the
 * disclosure buttons themselves are never draggable.
 */
export function FieldList({ model, catalog, parameters, onAdd, onAddFilter }: FieldListProps) {
  const tables = model.tables.filter((table) => !table.hidden);
  const dateTables = model.dateTables ?? [];

  const [query, setQuery] = useState('');

  // Expanded sections. Model tables: all expanded when the model is small
  // (≤3 tables), otherwise only the first — the SchemaExplorer default posture
  // adapted to a pane that opens on every builder session. Date tables,
  // Measures (incl. folders) and Parameters start expanded.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    const keys = model.tables.filter((t) => !t.hidden).map((t) => tableKey(t.schema, t.name));
    if (keys.length <= 3) keys.forEach((key) => initial.add(key));
    else if (keys[0] !== undefined) initial.add(keys[0]);
    for (const dateTable of model.dateTables ?? []) initial.add(dateTableKey(dateTable.name));
    initial.add(MEASURES_KEY);
    initial.add(PARAMETERS_KEY);
    collectFolderKeys(buildMeasureFolders(model.measures).folders, []).forEach((key) =>
      initial.add(key),
    );
    return initial;
  });

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const q = query.trim().toLowerCase();
  const matches = (text: string): boolean => text.toLowerCase().includes(q);

  /* ----------------------------------------------------------- measures */

  const measureRows = useMemo(() => {
    const kept =
      q === ''
        ? model.measures
        : model.measures.filter(
            (m) => matches(m.name) || (m.displayFolder != null && matches(m.displayFolder)),
          );
    return buildMeasureFolders(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matches derives from q
  }, [model.measures, q]);

  const measuresVisible = q === '' || measureRows.root.length > 0 || measureRows.folders.length > 0;

  /* --------------------------------------------------------- parameters */

  const visibleParameters =
    parameters === undefined
      ? []
      : q === ''
        ? parameters
        : parameters.filter((p) => matches(p.name));

  const renderMeasure = (measure: Measure) => (
    <FieldEntry
      key={measure.id}
      id={`measure:${measure.id}`}
      data={{ kind: 'measure', measureId: measure.id, name: measure.name }}
      label={measure.name}
      icon={<Sigma size={13} />}
      badge={measure.expression ? <FxBadge /> : undefined}
      onAdd={onAdd}
    />
  );

  const renderFolder = (node: MeasureFolderNode): React.ReactNode => {
    // Column-only search matches force folders open (same rule as tables).
    const isOpen = expanded.has(node.key) || q !== '';
    return (
      <div key={node.key}>
        <button
          type="button"
          onClick={() => toggleExpanded(node.key)}
          aria-expanded={isOpen}
          className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10"
        >
          {isOpen ? (
            <ChevronDown size={11} className="shrink-0 text-rcd-muted" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-rcd-muted" />
          )}
          <Folder size={12} className="shrink-0 text-rcd-muted" />
          <span className="truncate" title={node.name}>
            {node.name}
          </span>
        </button>
        {isOpen && (
          <div className="ml-3 border-l border-rcd-border pl-1">
            {node.folders.map(renderFolder)}
            {node.measures.map(renderMeasure)}
          </div>
        )}
      </div>
    );
  };

  const measuresOpen = expanded.has(MEASURES_KEY) || q !== '';
  const parametersOpen = expanded.has(PARAMETERS_KEY) || q !== '';

  return (
    <div className="flex flex-col pb-2" data-testid="rcd-field-list">
      <div className="relative p-2 pb-1">
        <Search
          size={13}
          className="pointer-events-none absolute left-4 top-1/2 mt-[1px] -translate-y-1/2 text-rcd-muted"
        />
        <RcdInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search fields…"
          aria-label="Search fields"
          className="w-full pl-7"
        />
      </div>

      {catalog === null && (
        <p className="px-3 pt-2 text-xs text-rcd-muted">
          Column catalog unavailable — drag measures below, or reopen the model to load columns.
        </p>
      )}
      {catalog !== null &&
        tables.map((table) => (
          <TableSection
            key={tableKey(table.schema, table.name)}
            table={table}
            catalog={catalog}
            query={q}
            expanded={expanded}
            onToggle={toggleExpanded}
            onAdd={onAdd}
            onAddFilter={onAddFilter}
          />
        ))}

      {dateTables.map((dateTable) => (
        <DateTableSection
          key={dateTableKey(dateTable.name)}
          name={dateTable.name}
          query={q}
          expanded={expanded}
          onToggle={toggleExpanded}
          onAdd={onAdd}
          onAddFilter={onAddFilter}
        />
      ))}

      {measuresVisible && (
        <>
          <SectionHeader
            icon={<Sigma size={12} />}
            label="Measures"
            expanded={measuresOpen}
            onToggle={() => toggleExpanded(MEASURES_KEY)}
          />
          {measuresOpen &&
            (model.measures.length === 0 ? (
              <p className="px-3 py-1 text-xs text-rcd-muted">No measures defined in this model.</p>
            ) : (
              <>
                {measureRows.folders.map(renderFolder)}
                {measureRows.root.map(renderMeasure)}
              </>
            ))}
        </>
      )}

      {parameters !== undefined && parameters.length > 0 && visibleParameters.length > 0 && (
        <>
          <SectionHeader
            icon={<Variable size={12} />}
            label="Parameters"
            expanded={parametersOpen}
            onToggle={() => toggleExpanded(PARAMETERS_KEY)}
          />
          {parametersOpen &&
            visibleParameters.map((parameter) => (
              <FieldEntry
                key={parameter.id}
                id={`parameter:${parameter.id}`}
                data={{
                  kind: 'parameter',
                  parameterId: parameter.id,
                  name: parameter.name,
                  paramKind: parameter.kind,
                }}
                label={parameter.name}
                icon={<Variable size={13} className="text-rcd-accent" />}
                badge={<ParamKindBadge kind={parameter.kind} />}
                onAdd={onAdd}
              />
            ))}
        </>
      )}
    </div>
  );
}

/** Cosmetic suffix marking what a field parameter swaps: axis fields or measures. */
function ParamKindBadge({ kind }: { kind: BuilderParameter['kind'] }) {
  return (
    <span
      title={kind === 'dimension' ? 'Field parameter — binds to the axis' : 'Field parameter — binds to values'}
      className="ml-auto shrink-0 rounded bg-[color-mix(in_srgb,var(--rcd-accent)_15%,transparent)] px-1 text-[10px] font-medium leading-4 text-rcd-accent"
    >
      {kind === 'dimension' ? 'axis' : 'values'}
    </span>
  );
}

function TableSection({
  table,
  catalog,
  query,
  expanded,
  onToggle,
  onAdd,
  onAddFilter,
}: {
  table: ModelTable;
  catalog: Catalog;
  /** Trimmed lowercase search query ('' = not searching). */
  query: string;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onAdd: (data: FieldDragData) => void;
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
}) {
  const key = tableKey(table.schema, table.name);
  const label = table.friendlyName ?? table.name;
  const catalogTable = catalog.tables.find((t) => t.key === key);
  const overrides = new Map((table.columns ?? []).map((c) => [c.name, c]));

  const allColumns = (catalogTable?.columns ?? []).filter(
    (column) => isQueryableType(column.type) && !overrides.get(column.name)?.hidden,
  );

  // SchemaExplorer's search rule: a name-matched table keeps all its columns
  // (and its user-chosen collapse state); otherwise only matching columns
  // survive and the section is forced open; no match at all hides it.
  const nameMatched =
    query === '' || label.toLowerCase().includes(query) || key.toLowerCase().includes(query);
  const columns = nameMatched
    ? allColumns
    : allColumns.filter((column) =>
        (overrides.get(column.name)?.friendlyName ?? column.name).toLowerCase().includes(query),
      );
  if (query !== '' && !nameMatched && columns.length === 0) return null;

  const isExpanded = expanded.has(key) || (query !== '' && !nameMatched);

  return (
    <>
      <SectionHeader label={label} expanded={isExpanded} onToggle={() => onToggle(key)} />
      {isExpanded &&
        (catalogTable === undefined ? (
          <p className="px-3 py-1 text-xs text-rcd-muted">Table not found in the catalog.</p>
        ) : columns.length === 0 ? (
          <p className="px-3 py-1 text-xs text-rcd-muted">
            {query === '' ? 'No queryable columns.' : 'No matching columns.'}
          </p>
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
                icon={<ColumnTypeIcon type={column.type} />}
                onAdd={onAdd}
                onFilter={onAddFilter ? () => onAddFilter(data) : undefined}
              />
            );
          })
        ))}
    </>
  );
}

/**
 * Engine date table: the fixed columns rendered as normal column entries.
 * Needs no catalog — the schema is fixed — so it renders even when the
 * catalog failed to load. Drag payloads address the table by its
 * '#date.{name}' key.
 */
function DateTableSection({
  name,
  query,
  expanded,
  onToggle,
  onAdd,
  onAddFilter,
}: {
  name: string;
  query: string;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onAdd: (data: FieldDragData) => void;
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
}) {
  const key = dateTableKey(name);

  const nameMatched = query === '' || name.toLowerCase().includes(query);
  const columns = nameMatched
    ? DATE_TABLE_COLUMNS
    : DATE_TABLE_COLUMNS.filter((column) => column.name.toLowerCase().includes(query));
  if (query !== '' && !nameMatched && columns.length === 0) return null;

  const isExpanded = expanded.has(key) || (query !== '' && !nameMatched);

  return (
    <>
      <SectionHeader
        icon={<CalendarDays size={12} />}
        label={name}
        expanded={isExpanded}
        onToggle={() => onToggle(key)}
      />
      {isExpanded &&
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
              label={column.name}
              icon={<ColumnTypeIcon type={column.type} />}
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

/**
 * Collapsible section disclosure row (chevron + label). A plain toggle
 * button — deliberately NOT a draggable; only FieldEntry rows carry dnd.
 */
function SectionHeader({
  label,
  icon,
  expanded,
  onToggle,
}: {
  label: string;
  icon?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-1 px-3 pb-1 pt-3 text-left text-xs font-medium uppercase tracking-wide text-rcd-muted hover:text-rcd-text"
    >
      {expanded ? (
        <ChevronDown size={12} className="shrink-0" />
      ) : (
        <ChevronRight size={12} className="shrink-0" />
      )}
      {icon}
      <span className="truncate" title={label}>
        {label}
      </span>
    </button>
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
        {/* The "click +" the well placeholders point at — visual affordance
            only; the whole row is already click-to-add. */}
        <Plus
          size={12}
          aria-hidden
          className={`${badge ? '' : 'ml-auto '}shrink-0 text-rcd-muted opacity-0 group-hover:opacity-100`}
        />
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
