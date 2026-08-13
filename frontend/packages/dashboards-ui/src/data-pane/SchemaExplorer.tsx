import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Braces,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Fingerprint,
  Globe,
  Hash,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Table2,
  ToggleLeft,
  Type,
} from 'lucide-react';
import {
  isQueryableType,
  tableKey,
  type CatalogColumn,
  type CatalogTable,
  type ColumnType,
  type TableKind,
} from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdIconButton, RcdInput, RcdSpinner } from '../primitives';

export interface SchemaExplorerProps {
  /** Registered data source name whose catalog to browse. */
  connection: string;
  /** Invoked when the user adds a table to the model. */
  onAddTable?: (table: CatalogTable) => void;
}

function TableKindIcon({ kind }: { kind: TableKind }) {
  switch (kind) {
    case 'table':
      return <Table2 size={13} className="shrink-0 text-rcd-muted" aria-label="Table" />;
    case 'view':
      return <Eye size={13} className="shrink-0 text-rcd-muted" aria-label="View" />;
    case 'materializedView':
      return <Layers size={13} className="shrink-0 text-rcd-muted" aria-label="Materialized view" />;
    case 'foreignTable':
      return <Globe size={13} className="shrink-0 text-rcd-muted" aria-label="Foreign table" />;
  }
}

/** Per-type column glyph, shared with the chart builder's field list. */
export function ColumnTypeIcon({ type }: { type: ColumnType }) {
  switch (type) {
    case 'text':
      return <Type size={12} className="shrink-0 text-rcd-muted" />;
    case 'integer':
    case 'decimal':
      return <Hash size={12} className="shrink-0 text-rcd-muted" />;
    case 'date':
    case 'timestamp':
      return <Calendar size={12} className="shrink-0 text-rcd-muted" />;
    case 'boolean':
      return <ToggleLeft size={12} className="shrink-0 text-rcd-muted" />;
    case 'uuid':
      return <Fingerprint size={12} className="shrink-0 text-rcd-muted" />;
    case 'json':
      return <Braces size={12} className="shrink-0 text-rcd-muted" />;
    case 'other':
      return <Ban size={12} className="shrink-0 text-rcd-muted opacity-40" />;
  }
}

const formatRowEstimate = (estimate: number | null): string | null => {
  if (estimate === null || estimate < 0) return null;
  const compact = (value: number, suffix: string): string => {
    const rounded = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
    return `~${rounded}${suffix} rows`;
  };
  if (estimate >= 1e9) return compact(estimate / 1e9, 'b');
  if (estimate >= 1e6) return compact(estimate / 1e6, 'm');
  if (estimate >= 1e3) return compact(estimate / 1e3, 'k');
  return `~${Math.round(estimate)} rows`;
};

interface ExplorerRow {
  table: CatalogTable;
  /** Columns to show when expanded (filtered while searching). */
  columns: CatalogColumn[];
  /** True when the table itself matched the query (vs. only its columns). */
  nameMatched: boolean;
}

/** Catalog tree: tables > columns with type icons, search, and add-to-model. */
export function SchemaExplorer({ connection, onAddTable }: SchemaExplorerProps) {
  const models = useRuntime().models;
  const catalog = useModelState((s) => s.catalog);
  const catalogStatus = useModelState((s) => s.catalogStatus);
  const storeError = useModelState((s) => s.error);
  const modelTables = useModelState((s) => s.current?.definition.tables ?? null);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());

  // Self-trigger a catalog load when none (or another connection's) is loaded.
  useEffect(() => {
    const state = models.store.getState();
    if (state.catalogStatus === 'loading') return;
    if (state.catalog?.connection !== connection) void models.loadCatalog(connection);
  }, [models, connection]);

  const modelTableKeys = useMemo(
    () => new Set((modelTables ?? []).map((t) => tableKey(t.schema, t.name))),
    [modelTables],
  );

  const q = query.trim().toLowerCase();
  const rows = useMemo<ExplorerRow[]>(() => {
    const tables = catalog?.connection === connection ? catalog.tables : [];
    if (!q) return tables.map((table) => ({ table, columns: table.columns, nameMatched: true }));
    const result: ExplorerRow[] = [];
    for (const table of tables) {
      const nameMatched = table.key.toLowerCase().includes(q);
      if (nameMatched) {
        result.push({ table, columns: table.columns, nameMatched });
        continue;
      }
      const columns = table.columns.filter((c) => c.name.toLowerCase().includes(q));
      if (columns.length > 0) result.push({ table, columns, nameMatched });
    }
    return result;
  }, [catalog, connection, q]);

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const loading =
    catalogStatus === 'loading' ||
    (catalogStatus !== 'error' && catalog?.connection !== connection);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative p-2">
        <Search
          size={13}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-rcd-muted"
        />
        <RcdInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tables and columns…"
          aria-label="Search tables and columns"
          className="w-full pl-7"
        />
      </div>

      {catalogStatus === 'error' ? (
        <div className="flex flex-col items-start gap-2 px-3 py-2">
          <p className="break-words text-sm text-rcd-text-2">
            {storeError ?? 'Failed to load the catalog.'}
          </p>
          <RcdButton onClick={() => void models.loadCatalog(connection)}>
            <RefreshCw size={14} /> Retry
          </RcdButton>
        </div>
      ) : loading ? (
        <div className="px-3 py-2">
          <RcdSpinner label="Loading catalog…" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-3 py-2 text-sm text-rcd-muted">
          {q ? 'No tables or columns match.' : 'No tables in this catalog.'}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {rows.map(({ table, columns, nameMatched }) => {
            const key = table.key;
            const isExpanded = expanded.has(key) || (q !== '' && !nameMatched);
            const inModel = modelTableKeys.has(key);
            const rowsHint = formatRowEstimate(table.rowEstimate);
            return (
              <li key={key}>
                <div
                  className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-black/5 dark:hover:bg-white/10"
                  title={table.comment ?? undefined}
                >
                  <button
                    type="button"
                    onClick={() => toggleExpanded(key)}
                    aria-expanded={isExpanded}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} className="shrink-0 text-rcd-muted" />
                    ) : (
                      <ChevronRight size={12} className="shrink-0 text-rcd-muted" />
                    )}
                    <TableKindIcon kind={table.kind} />
                    <span className="truncate text-[13px] text-rcd-text">
                      <span className="text-rcd-muted">{table.schema}.</span>
                      {table.name}
                    </span>
                    {rowsHint && (
                      <span className="shrink-0 text-[10px] text-rcd-muted">{rowsHint}</span>
                    )}
                  </button>
                  {onAddTable && (
                    <RcdIconButton
                      disabled={inModel}
                      onClick={() => onAddTable(table)}
                      aria-label={inModel ? `${key} is already in the model` : `Add ${key} to the model`}
                      title={inModel ? 'Already in the model' : 'Add to model'}
                    >
                      {inModel ? <Check size={13} /> : <Plus size={13} />}
                    </RcdIconButton>
                  )}
                </div>

                {isExpanded && (
                  <ul className="mb-1 ml-4 border-l border-rcd-border pl-2">
                    {columns.map((column) => {
                      const queryable = isQueryableType(column.type);
                      const isPk = table.primaryKey.includes(column.name);
                      return (
                        <li
                          key={column.name}
                          className="flex items-center gap-1.5 py-0.5 pr-1"
                          title={column.comment ?? column.rawType}
                        >
                          <ColumnTypeIcon type={column.type} />
                          <span
                            className={
                              queryable
                                ? 'truncate text-xs text-rcd-text-2'
                                : 'truncate text-xs text-rcd-muted opacity-60'
                            }
                          >
                            {column.name}
                          </span>
                          {column.isNullable && (
                            <span className="shrink-0 text-[10px] text-rcd-muted" title="Nullable">
                              ?
                            </span>
                          )}
                          {isPk && (
                            <span className="shrink-0 rounded border border-rcd-border px-1 text-[9px] font-semibold text-rcd-accent">
                              PK
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
