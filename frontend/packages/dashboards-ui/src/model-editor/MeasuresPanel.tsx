import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Sigma, Trash2 } from 'lucide-react';
import {
  isNumericType,
  isQueryableType,
  isTemporalType,
  newId,
  tableKey,
  type Aggregation,
  type Catalog,
  type CatalogColumn,
  type Measure,
  type ModelTable,
  type ValidationOutcome,
} from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import {
  ConfirmDialog,
  RcdButton,
  RcdDialog,
  RcdIconButton,
  RcdInput,
  RcdSelect,
} from '../primitives';

const AGGREGATIONS: { value: Aggregation; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count', label: 'Count' },
  { value: 'countDistinct', label: 'Count distinct' },
];

const aggregationLabel = (aggregation: Aggregation): string =>
  AGGREGATIONS.find((a) => a.value === aggregation)?.label ?? aggregation;

/** Columns a given aggregation can legally target (mirror of engine rules). */
const compatibleColumns = (columns: CatalogColumn[], aggregation: Aggregation): CatalogColumn[] => {
  switch (aggregation) {
    case 'sum':
    case 'avg':
      return columns.filter((c) => isNumericType(c.type));
    case 'min':
    case 'max':
      return columns.filter(
        (c) => isNumericType(c.type) || isTemporalType(c.type) || c.type === 'text',
      );
    case 'count':
    case 'countDistinct':
      return columns.filter((c) => isQueryableType(c.type));
  }
};

type MeasureMode = 'aggregation' | 'calculation';

type ValidationIssue = ValidationOutcome['issues'][number];

/** Server codes for calculated-measure problems (parse / unknown ref / shape). */
const EXPRESSION_ISSUE_CODES = new Set(['MDL012', 'MDL013', 'MDL014']);

interface MeasureDraft {
  name: string;
  table: string;
  aggregation: Aggregation;
  column: string | null;
  expression: string | null;
}

interface MeasureDialogProps {
  /** null = creating a new measure. */
  initial: Measure | null;
  tables: ModelTable[];
  catalog: Catalog | null;
  onClose: () => void;
  onSave: (draft: MeasureDraft) => void;
}

function MeasureDialog({ initial, tables, catalog, onClose, onSave }: MeasureDialogProps) {
  const runtime = useRuntime();

  const firstTable = tables[0];
  const [mode, setMode] = useState<MeasureMode>(
    initial?.expression != null && initial.expression !== '' ? 'calculation' : 'aggregation',
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [table, setTable] = useState(
    initial?.table ?? (firstTable ? tableKey(firstTable.schema, firstTable.name) : ''),
  );
  const [aggregation, setAggregation] = useState<Aggregation>(initial?.aggregation ?? 'sum');
  const [column, setColumn] = useState(initial?.column ?? '');
  const [expression, setExpression] = useState(initial?.expression ?? '');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [checking, setChecking] = useState(false);

  const columnOptions = useMemo(() => {
    const catalogTable = catalog?.tables.find((t) => t.key === table) ?? null;
    return compatibleColumns(catalogTable?.columns ?? [], aggregation);
  }, [catalog, table, aggregation]);

  // Drop a selection that became incompatible after a table/aggregation change.
  useEffect(() => {
    if (column !== '' && !columnOptions.some((c) => c.name === column)) setColumn('');
  }, [column, columnOptions]);

  const clearIssues = () => {
    if (issues.length > 0) setIssues([]);
  };

  const canSave =
    name.trim().length > 0 &&
    table !== '' &&
    !checking &&
    (mode === 'aggregation'
      ? column !== '' || aggregation === 'count'
      : expression.trim().length > 0 && issues.length === 0);

  const handleApply = () => {
    if (mode === 'aggregation') {
      onSave({
        name: name.trim(),
        table,
        aggregation,
        column: column === '' ? null : column,
        expression: null,
      });
      return;
    }
    void applyCalculation();
  };

  /**
   * Validate the WORKING definition (with this measure applied) server-side
   * before committing; MDL012/013/014 issues surface inline and block Apply.
   */
  const applyCalculation = async () => {
    const current = runtime.models.store.getState().current;
    if (!current) return;

    const draft: MeasureDraft = {
      name: name.trim(),
      table,
      // Ignored by the engine for calculated measures but required by the wire shape.
      aggregation: 'sum',
      column: null,
      expression: expression.trim(),
    };

    setChecking(true);
    try {
      const candidate: Measure = { ...draft, id: initial?.id ?? newId() };
      const measures = initial
        ? current.definition.measures.map((m) => (m.id === initial.id ? candidate : m))
        : [...current.definition.measures, candidate];
      const outcome = await runtime.api.validateModel(current.dataSourceName, {
        ...current.definition,
        measures,
      });
      const expressionIssues = outcome.issues.filter((issue) =>
        EXPRESSION_ISSUE_CODES.has(issue.code),
      );
      if (expressionIssues.length > 0) {
        setIssues(expressionIssues);
        return;
      }
      onSave(draft);
    } catch (error) {
      setIssues([
        {
          code: 'requestFailed',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
          path: null,
        },
      ]);
    } finally {
      setChecking(false);
    }
  };

  return (
    <RcdDialog
      title={initial ? 'Edit measure' : 'Add measure'}
      open
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton variant="primary" disabled={!canSave} onClick={handleApply}>
            {checking ? 'Checking…' : initial ? 'Save' : 'Add'}
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-rcd-text-2">Name</span>
          <RcdInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Total revenue"
            className="w-full"
          />
        </label>

        <fieldset className="flex items-center gap-4">
          <legend className="sr-only">Measure type</legend>
          {(
            [
              { value: 'aggregation', label: 'Aggregation' },
              { value: 'calculation', label: 'Calculation' },
            ] as { value: MeasureMode; label: string }[]
          ).map((option) => (
            <label key={option.value} className="flex items-center gap-1.5 text-sm text-rcd-text">
              <input
                type="radio"
                name="rcd-measure-mode"
                className="accent-[var(--rcd-accent)]"
                checked={mode === option.value}
                onChange={() => {
                  setMode(option.value);
                  clearIssues();
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-rcd-text-2">
            {mode === 'calculation' ? 'Home table' : 'Table'}
          </span>
          <RcdSelect
            value={table}
            onChange={(event) => {
              setTable(event.target.value);
              clearIssues();
            }}
            className="w-full"
          >
            {tables.length === 0 && <option value="">No tables in the model</option>}
            {tables.map((t) => {
              const key = tableKey(t.schema, t.name);
              return (
                <option key={key} value={key}>
                  {t.friendlyName ?? key}
                </option>
              );
            })}
          </RcdSelect>
          {mode === 'calculation' && (
            <span className="text-xs text-rcd-muted">
              Anchors join planning — pick the table whose columns dominate the expression.
            </span>
          )}
        </label>

        {mode === 'aggregation' ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-rcd-text-2">Aggregation</span>
              <RcdSelect
                value={aggregation}
                onChange={(event) => setAggregation(event.target.value as Aggregation)}
                className="w-full"
              >
                {AGGREGATIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </RcdSelect>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-rcd-text-2">Column</span>
              <RcdSelect
                value={column}
                onChange={(event) => setColumn(event.target.value)}
                className="w-full"
              >
                {aggregation === 'count' ? (
                  <option value="">(all rows)</option>
                ) : (
                  <option value="" disabled>
                    Select a column…
                  </option>
                )}
                {columnOptions.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </RcdSelect>
              {columnOptions.length === 0 && aggregation !== 'count' && (
                <span className="text-xs text-rcd-muted">
                  No compatible columns on this table for this aggregation.
                </span>
              )}
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Expression</span>
            <textarea
              value={expression}
              onChange={(event) => {
                setExpression(event.target.value);
                clearIssues();
              }}
              rows={4}
              spellCheck={false}
              placeholder="SUM(public.orders.total) / COUNT(*)"
              className="w-full resize-y rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 font-mono text-sm text-rcd-text outline-none focus:border-rcd-accent"
            />
            <span className="text-xs text-rcd-muted">
              Arithmetic (+ − * / parentheses), numbers, SUM / AVG / MIN / MAX / COUNT /
              COUNTDISTINCT over schema.table.column (COUNT(*) allowed), and [Measure Name]
              references to plain measures. Division is guarded automatically. Examples:{' '}
              <code className="font-mono">SUM(public.orders.total) / COUNT(*)</code> ·{' '}
              <code className="font-mono">[Revenue] / [Order Count]</code>
            </span>
            {issues.length > 0 && (
              <ul className="flex flex-col gap-1">
                {issues.map((issue, index) => (
                  <li key={index} className="text-xs text-[var(--rcd-status-critical)]">
                    <span className="font-semibold">{issue.code}</span> {issue.message}
                    {issue.path && <span className="text-rcd-muted"> — {issue.path}</span>}
                  </li>
                ))}
              </ul>
            )}
          </label>
        )}
      </div>
    </RcdDialog>
  );
}

/** Right-hand editor panel: list, add, edit, and delete model measures. */
export function MeasuresPanel() {
  const models = useRuntime().models;
  const definition = useModelState((s) => s.current?.definition ?? null);
  const catalog = useModelState((s) => s.catalog);

  const [editing, setEditing] = useState<Measure | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Measure | null>(null);

  if (!definition) return null;

  const isCalculated = (measure: Measure): boolean =>
    measure.expression != null && measure.expression !== '';

  const subtitle = (measure: Measure): string => {
    if (isCalculated(measure)) return measure.expression ?? '';
    return measure.column
      ? `${aggregationLabel(measure.aggregation)} of ${measure.table}.${measure.column}`
      : `${aggregationLabel(measure.aggregation)} of all rows in ${measure.table}`;
  };

  const handleSave = (draft: MeasureDraft) => {
    if (editing !== null && editing !== 'new') models.updateMeasure(editing.id, draft);
    else models.addMeasure(draft);
    setEditing(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 p-3 pb-2">
        <h3 className="text-sm font-semibold text-rcd-text">Measures</h3>
        <RcdButton
          onClick={() => setEditing('new')}
          disabled={definition.tables.length === 0}
          title={definition.tables.length === 0 ? 'Add a table to the model first' : undefined}
        >
          <Plus size={14} /> Add measure
        </RcdButton>
      </div>

      {definition.measures.length === 0 ? (
        <p className="px-3 py-2 text-sm text-rcd-muted">
          No measures yet. Measures are the aggregations charts can plot, like a sum of an amount
          column.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
          {definition.measures.map((measure) => (
            <li
              key={measure.id}
              className="flex items-center gap-2 rounded-md border border-rcd-border bg-rcd-bg px-2.5 py-1.5"
            >
              <Sigma size={14} className="shrink-0 text-rcd-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-rcd-text">{measure.name}</span>
                  {isCalculated(measure) && (
                    <span
                      className="shrink-0 rounded border border-rcd-border px-1 font-mono text-[10px] font-semibold italic leading-4 text-rcd-accent"
                      title="Calculated measure"
                    >
                      fx
                    </span>
                  )}
                </div>
                <div
                  className={`truncate text-xs text-rcd-muted ${isCalculated(measure) ? 'font-mono' : ''}`}
                  title={subtitle(measure)}
                >
                  {subtitle(measure)}
                </div>
              </div>
              <RcdIconButton aria-label={`Edit ${measure.name}`} onClick={() => setEditing(measure)}>
                <Pencil size={13} />
              </RcdIconButton>
              <RcdIconButton
                aria-label={`Delete ${measure.name}`}
                onClick={() => setDeleting(measure)}
              >
                <Trash2 size={13} />
              </RcdIconButton>
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <MeasureDialog
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          tables={definition.tables}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        title="Delete measure"
        message={deleting ? `Delete the measure "${deleting.name}"?` : ''}
        confirmLabel="Delete"
        danger
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) models.removeMeasure(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
