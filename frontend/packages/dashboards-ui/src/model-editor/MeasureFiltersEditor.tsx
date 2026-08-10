import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  isNumericType,
  isQueryableType,
  isTemporalType,
  tableKey,
  type Catalog,
  type ColumnType,
  type FilterClause,
  type FilterOperator,
  type FilterValue,
  type ModelTable,
} from '@recon/dashboards-core';
import { RcdButton, RcdIconButton, RcdInput, RcdSelect } from '../primitives';
import { OPERATOR_LABELS, operatorsFor } from '../chart-builder/wellConfig';

/**
 * Separator for the "table + column" <select> value. U+001F (unit separator)
 * is the project's convention for composite option keys — it cannot occur in
 * a Postgres identifier, so no escaping is needed.
 */
const KEY_SEP = '\u001F';

type ValueMode = 'none' | 'single' | 'pair' | 'list' | 'boolean';

/** Mirrors FilterEditor's mapping so both editors agree on value arity. */
const valueModeFor = (operator: FilterOperator, type: ColumnType | null): ValueMode => {
  if (operator === 'isNull' || operator === 'notNull') return 'none';
  if (operator === 'between') return 'pair';
  if (operator === 'in' || operator === 'notIn') return 'list';
  if (type === 'boolean') return 'boolean';
  return 'single';
};

const inputTypeFor = (type: ColumnType | null): 'number' | 'date' | 'text' => {
  if (type !== null && isNumericType(type)) return 'number';
  if (type !== null && isTemporalType(type)) return 'date';
  return 'text';
};

/** null = empty or unparseable; otherwise the wire value. */
const coerce = (raw: string, type: ColumnType | null): FilterValue | null => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (type !== null && isNumericType(type)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return trimmed; // dates arrive as 'YYYY-MM-DD' from <input type="date">
};

/**
 * Editable row. Values live as TEXT so half-typed input ("1.", "-") survives
 * re-renders; only complete rows are lifted into the measure as clauses.
 */
interface FilterRow {
  key: string;
  table: string;
  column: string;
  operator: FilterOperator;
  text0: string;
  text1: string;
}

const textOf = (values: FilterValue[], index: number): string => {
  const value = values[index];
  return value === undefined ? '' : String(value);
};

const rowFromClause = (clause: FilterClause, key: string): FilterRow => ({
  key,
  table: clause.table,
  column: clause.column,
  operator: clause.operator,
  text0:
    clause.operator === 'in' || clause.operator === 'notIn'
      ? clause.values.map(String).join(', ')
      : textOf(clause.values, 0),
  text1: textOf(clause.values, 1),
});

const clauseFromRow = (row: FilterRow, type: ColumnType | null): FilterClause | null => {
  if (row.table === '' || row.column === '') return null;
  const base = { table: row.table, column: row.column, operator: row.operator };
  switch (valueModeFor(row.operator, type)) {
    case 'none':
      return { ...base, values: [] };
    case 'boolean':
      return { ...base, values: [row.text0 === 'true'] };
    case 'single': {
      const value = coerce(row.text0, type);
      return value === null ? null : { ...base, values: [value] };
    }
    case 'pair': {
      const from = coerce(row.text0, type);
      const to = coerce(row.text1, type);
      return from === null || to === null ? null : { ...base, values: [from, to] };
    }
    case 'list': {
      const values = row.text0
        .split(',')
        .map((part) => coerce(part, type))
        .filter((value): value is FilterValue => value !== null);
      return values.length === 0 ? null : { ...base, values };
    }
  }
};

export interface MeasureFiltersEditorProps {
  initial: FilterClause[];
  tables: ModelTable[];
  catalog: Catalog | null;
  onChange: (filters: FilterClause[]) => void;
}

/**
 * CALCULATE-lite filter editor: a list of FilterClause rows stored on the
 * measure. The wire vocabulary is exactly the one the chart Filters pane
 * produces ({ table, column, operator, values } with the FilterOperator
 * union), and the offered operators come from the shared operatorsFor()
 * table, so nothing here can emit a combination the engine rejects.
 */
export function MeasureFiltersEditor({
  initial,
  tables,
  catalog,
  onChange,
}: MeasureFiltersEditorProps) {
  const nextKey = useRef(0);
  const [rows, setRows] = useState<FilterRow[]>(() =>
    initial.map((clause) => rowFromClause(clause, `f${nextKey.current++}`)),
  );

  /** Queryable columns of every model table, grouped for the picker. */
  const groups = useMemo(
    () =>
      tables.map((table) => {
        const key = tableKey(table.schema, table.name);
        const catalogTable = catalog?.tables.find((t) => t.key === key) ?? null;
        return {
          key,
          label: table.friendlyName ?? key,
          columns: (catalogTable?.columns ?? []).filter((c) => isQueryableType(c.type)),
        };
      }),
    [tables, catalog],
  );

  const typeOf = (table: string, column: string): ColumnType | null =>
    groups.find((g) => g.key === table)?.columns.find((c) => c.name === column)?.type ?? null;

  // Lift complete rows only; the callback rides a ref so a parent re-render
  // never re-fires this effect.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const clauses = rows
      .map((row) => clauseFromRow(row, typeOf(row.table, row.column)))
      .filter((clause): clause is FilterClause => clause !== null);
    onChangeRef.current(clauses);
    // typeOf is derived from groups; rows/groups are the real inputs.
  }, [rows, groups]);

  const patchRow = (key: string, patch: Partial<FilterRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addRow = () => {
    const first = groups.find((g) => g.columns.length > 0);
    const column = first?.columns[0];
    if (!first || !column) return;
    setRows((current) => [
      ...current,
      {
        key: `f${nextKey.current++}`,
        table: first.key,
        column: column.name,
        operator: operatorsFor(column.type)[0] ?? 'eq',
        text0: '',
        text1: '',
      },
    ]);
  };

  const hasColumns = groups.some((g) => g.columns.length > 0);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-rcd-text-2">Filters (optional)</span>

      {rows.map((row) => {
        const type = typeOf(row.table, row.column);
        const operators = operatorsFor(type);
        const mode = valueModeFor(row.operator, type);
        const inputType = inputTypeFor(type);
        return (
          <div key={row.key} className="flex flex-wrap items-center gap-1.5">
            <RcdSelect
              value={`${row.table}${KEY_SEP}${row.column}`}
              aria-label="Filter column"
              className="min-w-0 flex-[2] basis-40"
              onChange={(event) => {
                const [table = '', column = ''] = event.target.value.split(KEY_SEP);
                const nextType = typeOf(table, column);
                const nextOperators = operatorsFor(nextType);
                patchRow(row.key, {
                  table,
                  column,
                  // Keep the operator when the new column still supports it.
                  operator: nextOperators.includes(row.operator)
                    ? row.operator
                    : (nextOperators[0] ?? 'eq'),
                });
              }}
            >
              {groups.map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.columns.map((column) => (
                    <option key={column.name} value={`${group.key}${KEY_SEP}${column.name}`}>
                      {column.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </RcdSelect>

            <RcdSelect
              value={row.operator}
              aria-label="Filter operator"
              className="w-28 shrink-0"
              onChange={(event) =>
                patchRow(row.key, { operator: event.target.value as FilterOperator })
              }
            >
              {(operators.includes(row.operator)
                ? operators
                : [row.operator, ...operators]
              ).map((operator) => (
                <option key={operator} value={operator}>
                  {OPERATOR_LABELS[operator]}
                </option>
              ))}
            </RcdSelect>

            {mode === 'single' && (
              <RcdInput
                type={inputType}
                value={row.text0}
                aria-label="Filter value"
                placeholder="Value"
                className="min-w-0 flex-1 basis-24"
                onChange={(event) => patchRow(row.key, { text0: event.target.value })}
              />
            )}
            {mode === 'list' && (
              <RcdInput
                value={row.text0}
                aria-label="Filter values (comma separated)"
                placeholder="a, b, c"
                className="min-w-0 flex-1 basis-24"
                onChange={(event) => patchRow(row.key, { text0: event.target.value })}
              />
            )}
            {mode === 'pair' && (
              <>
                <RcdInput
                  type={inputType}
                  value={row.text0}
                  aria-label="Filter value from"
                  className="min-w-0 flex-1 basis-20"
                  onChange={(event) => patchRow(row.key, { text0: event.target.value })}
                />
                <span className="text-xs text-rcd-muted">and</span>
                <RcdInput
                  type={inputType}
                  value={row.text1}
                  aria-label="Filter value to"
                  className="min-w-0 flex-1 basis-20"
                  onChange={(event) => patchRow(row.key, { text1: event.target.value })}
                />
              </>
            )}
            {mode === 'boolean' && (
              <RcdSelect
                value={row.text0 === 'false' ? 'false' : 'true'}
                aria-label="Filter value"
                className="min-w-0 flex-1 basis-24"
                onChange={(event) => patchRow(row.key, { text0: event.target.value })}
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </RcdSelect>
            )}
            {mode === 'none' && <span className="flex-1 basis-24 text-xs text-rcd-muted">—</span>}

            <RcdIconButton
              aria-label="Remove filter"
              onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            >
              <X size={13} />
            </RcdIconButton>
          </div>
        );
      })}

      <RcdButton
        variant="ghost"
        className="self-start"
        disabled={!hasColumns}
        title={hasColumns ? undefined : 'No queryable columns in the model'}
        onClick={addRow}
      >
        <Plus size={13} /> Add filter
      </RcdButton>

      <span className="text-xs text-rcd-muted">
        Filters apply to every aggregate in this measure — the engine compiles them into a
        per-measure <code className="font-mono">FILTER (WHERE …)</code>, so other visuals stay
        unaffected. Rows with no value yet are ignored.
      </span>
    </div>
  );
}
