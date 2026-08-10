import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Pencil, Plus, Search, Sigma, Trash2 } from 'lucide-react';
import {
  isNumericType,
  isQueryableType,
  isTemporalType,
  newId,
  tableKey,
  type Aggregation,
  type Catalog,
  type CatalogColumn,
  type FilterClause,
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
import { ExpressionHelp } from './ExpressionHelp';
import { FormatStringField } from './FormatStringField';
import { MeasureFiltersEditor } from './MeasureFiltersEditor';

const AGGREGATIONS: { value: Aggregation; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'stdDev', label: 'Std. deviation' },
  { value: 'variance', label: 'Variance' },
  { value: 'median', label: 'Median' },
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
    case 'stdDev':
    case 'variance':
    case 'median':
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

/**
 * Server codes for calculated-measure problems: parse/shape (MDL012),
 * unknown or illegal reference (MDL013), aggregation+expression conflict
 * (MDL014), reference cycle / depth (MDL016).
 */
const EXPRESSION_ISSUE_CODES = new Set(['MDL012', 'MDL013', 'MDL014', 'MDL016']);

/** Idle time after the last keystroke before background validation fires. */
const VALIDATE_DEBOUNCE_MS = 600;

interface MeasureDraft {
  name: string;
  table: string;
  aggregation: Aggregation;
  column: string | null;
  expression: string | null;
  description: string | null;
  displayFolder: string | null;
  formatString: string | null;
  filters: FilterClause[] | null;
}

interface MeasureDialogProps {
  /** null = creating a new measure. */
  initial: Measure | null;
  tables: ModelTable[];
  catalog: Catalog | null;
  /** Existing display folders across the model, for the datalist. */
  folders: string[];
  onClose: () => void;
  onSave: (draft: MeasureDraft) => void;
}

function MeasureDialog({
  initial,
  tables,
  catalog,
  folders,
  onClose,
  onSave,
}: MeasureDialogProps) {
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
  const [description, setDescription] = useState(initial?.description ?? '');
  const [displayFolder, setDisplayFolder] = useState(initial?.displayFolder ?? '');
  const [formatString, setFormatString] = useState(initial?.formatString ?? '');
  const [filters, setFilters] = useState<FilterClause[]>(initial?.filters ?? []);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  /** Apply-time gate (blocks Save). */
  const [checking, setChecking] = useState(false);
  /** Background debounced check (informational only). */
  const [validating, setValidating] = useState(false);

  /**
   * Monotonic request counter: a response is only allowed to write state when
   * it belongs to the newest request, so a slow in-flight validation can never
   * clobber a newer result (or the Apply-time one).
   */
  const validationSeq = useRef(0);
  /** Stable id for the candidate measure across every validation round-trip. */
  const candidateId = useRef(initial?.id ?? newId());

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

  const buildDraft = (nextMode: MeasureMode): MeasureDraft => {
    const trimmedFolder = displayFolder.trim();
    const trimmedDescription = description.trim();
    const trimmedFormat = formatString.trim();
    return {
      name: name.trim(),
      table,
      // The engine ignores aggregation for calculated measures, but the wire
      // shape still requires a legal value.
      aggregation: nextMode === 'calculation' ? 'sum' : aggregation,
      column: nextMode === 'calculation' ? null : column === '' ? null : column,
      expression: nextMode === 'calculation' ? expression.trim() : null,
      description: trimmedDescription === '' ? null : trimmedDescription,
      displayFolder: trimmedFolder === '' ? null : trimmedFolder,
      formatString: trimmedFormat === '' ? null : trimmedFormat,
      filters: filters.length > 0 ? filters : null,
    };
  };

  /**
   * POSTs the WORKING definition with this measure applied and returns the
   * expression-related issues. Shared by the debounced background check and
   * the Apply-time gate so both judge the measure identically.
   */
  const validateDraft = async (draft: MeasureDraft): Promise<ValidationIssue[]> => {
    const current = runtime.models.store.getState().current;
    if (!current) return [];
    try {
      const candidate: Measure = { ...draft, id: candidateId.current };
      const measures = initial
        ? current.definition.measures.map((m) => (m.id === initial.id ? candidate : m))
        : [...current.definition.measures, candidate];
      const outcome = await runtime.api.validateModel(current.dataSourceName, {
        ...current.definition,
        measures,
      });
      return outcome.issues.filter((issue) => EXPRESSION_ISSUE_CODES.has(issue.code));
    } catch (error) {
      return [
        {
          code: 'requestFailed',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
          path: null,
        },
      ];
    }
  };

  // Debounced live validation of the expression. Empty expressions and
  // aggregation mode never hit the server.
  const expressionText = expression.trim();
  useEffect(() => {
    if (mode !== 'calculation' || expressionText === '' || table === '') {
      // Nothing to check any more — retire any in-flight response so it can't
      // land issues against an expression that no longer exists.
      validationSeq.current++;
      setValidating(false);
      return;
    }
    const timer = window.setTimeout(() => {
      const seq = ++validationSeq.current;
      setValidating(true);
      void validateDraft(buildDraft('calculation')).then((found) => {
        if (seq !== validationSeq.current) return; // a newer request won
        setValidating(false);
        setIssues(found);
      });
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // Only the inputs the server actually judges retrigger a check.
  }, [mode, expressionText, table, name]);

  const canSave =
    name.trim().length > 0 &&
    table !== '' &&
    !checking &&
    (mode === 'aggregation'
      ? column !== '' || aggregation === 'count'
      : expressionText.length > 0 && issues.length === 0);

  const handleApply = () => {
    if (mode === 'aggregation') {
      onSave(buildDraft('aggregation'));
      return;
    }
    void applyCalculation();
  };

  /** Apply-time gate: re-validate, then commit only when clean. */
  const applyCalculation = async () => {
    const draft = buildDraft('calculation');
    const seq = ++validationSeq.current;
    setChecking(true);
    const found = await validateDraft(draft);
    setChecking(false);
    // Superseded by a newer edit: never commit, and let that check own `issues`.
    if (seq !== validationSeq.current) return;
    setValidating(false);
    if (found.length > 0) {
      setIssues(found);
      return;
    }
    onSave(draft);
  };

  const folderListId = 'rcd-measure-folders';

  return (
    <RcdDialog
      title={initial ? 'Edit measure' : 'Add measure'}
      open
      wide
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
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-rcd-text-2">Expression</span>
              {validating && <span className="text-xs text-rcd-muted">Checking…</span>}
            </div>
            <textarea
              value={expression}
              onChange={(event) => {
                setExpression(event.target.value);
                clearIssues();
              }}
              rows={10}
              spellCheck={false}
              placeholder="DIVIDE(SUM(public.orders.total), COUNT(*))"
              className="w-full resize-y rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 font-mono text-sm leading-relaxed text-rcd-text outline-none focus:border-rcd-accent"
            />
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
            <ExpressionHelp />
          </div>
        )}

        <MeasureFiltersEditor
          initial={initial?.filters ?? []}
          tables={tables}
          catalog={catalog}
          onChange={setFilters}
        />

        <hr className="border-rcd-border" />

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-rcd-text-2">Description (optional)</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            placeholder="What this measure means, and when to use it."
            className="w-full resize-y rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 text-sm text-rcd-text outline-none focus:border-rcd-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-rcd-text-2">Display folder (optional)</span>
          <RcdInput
            value={displayFolder}
            onChange={(event) => setDisplayFolder(event.target.value)}
            placeholder="e.g. Finance"
            list={folderListId}
            className="w-full"
          />
          <datalist id={folderListId}>
            {folders.map((folder) => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
          <span className="text-xs text-rcd-muted">
            Groups the measure in field lists. Use a backslash for nesting, e.g.{' '}
            <code className="font-mono">Finance\Core</code>.
          </span>
        </label>

        <FormatStringField value={formatString} onChange={setFormatString} />
      </div>
    </RcdDialog>
  );
}

/** '' = the implicit "ungrouped" folder, always rendered last. */
const folderOf = (measure: Measure): string => (measure.displayFolder ?? '').trim();

/** Right-hand editor panel: list, search, add, duplicate, edit, delete. */
export function MeasuresPanel() {
  const models = useRuntime().models;
  const definition = useModelState((s) => s.current?.definition ?? null);
  const catalog = useModelState((s) => s.catalog);

  const [editing, setEditing] = useState<Measure | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Measure | null>(null);
  const [search, setSearch] = useState('');

  const measures = definition?.measures ?? [];

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const measure of measures) {
      const folder = folderOf(measure);
      if (folder !== '') set.add(folder);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [measures]);

  /** Folder groups (alphabetical, ungrouped last) over the search hits. */
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = needle === ''
      ? measures
      : measures.filter((m) => m.name.toLowerCase().includes(needle));
    const byFolder = new Map<string, Measure[]>();
    for (const measure of matches) {
      const folder = folderOf(measure);
      const bucket = byFolder.get(folder);
      if (bucket) bucket.push(measure);
      else byFolder.set(folder, [measure]);
    }
    return [...byFolder.entries()]
      .sort(([a], [b]) => {
        if (a === b) return 0;
        if (a === '') return 1; // ungrouped last
        if (b === '') return -1;
        return a.localeCompare(b);
      })
      .map(([folder, items]) => ({ folder, items }));
  }, [measures, search]);

  if (!definition) return null;

  const isCalculated = (measure: Measure): boolean =>
    measure.expression != null && measure.expression !== '';

  const subtitle = (measure: Measure): string => {
    const base = isCalculated(measure)
      ? (measure.expression ?? '')
      : measure.column
        ? `${aggregationLabel(measure.aggregation)} of ${measure.table}.${measure.column}`
        : `${aggregationLabel(measure.aggregation)} of all rows in ${measure.table}`;
    const filterCount = measure.filters?.length ?? 0;
    return filterCount > 0 ? `${base}  ·  ${filterCount} filter(s)` : base;
  };

  const handleSave = (draft: MeasureDraft) => {
    if (editing !== null && editing !== 'new') models.updateMeasure(editing.id, draft);
    else models.addMeasure(draft);
    setEditing(null);
  };

  const matchCount = groups.reduce((total, group) => total + group.items.length, 0);

  const renderRow = (measure: Measure) => (
    <li
      key={measure.id}
      className="flex items-center gap-2 rounded-md border border-rcd-border bg-rcd-bg px-2.5 py-1.5"
      title={measure.description ?? undefined}
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
      <RcdIconButton
        aria-label={`Duplicate ${measure.name}`}
        title="Duplicate"
        onClick={() => models.duplicateMeasure(measure.id)}
      >
        <Copy size={13} />
      </RcdIconButton>
      <RcdIconButton aria-label={`Edit ${measure.name}`} onClick={() => setEditing(measure)}>
        <Pencil size={13} />
      </RcdIconButton>
      <RcdIconButton aria-label={`Delete ${measure.name}`} onClick={() => setDeleting(measure)}>
        <Trash2 size={13} />
      </RcdIconButton>
    </li>
  );

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

      {measures.length === 0 ? (
        <p className="px-3 py-2 text-sm text-rcd-muted">
          No measures yet. Measures are the aggregations charts can plot, like a sum of an amount
          column.
        </p>
      ) : (
        <>
          <div className="relative px-3 pb-2">
            <Search
              size={13}
              className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-rcd-muted"
            />
            <RcdInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search measures…"
              aria-label="Search measures"
              className="w-full pl-7"
            />
          </div>

          {matchCount === 0 ? (
            <p className="px-3 py-2 text-sm text-rcd-muted">
              No measure matches “{search.trim()}”.
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
              {groups.map((group) => (
                <div key={group.folder || ' ungrouped'} className="flex flex-col gap-1">
                  {/* A single implicit group needs no header. */}
                  {(group.folder !== '' || groups.length > 1) && (
                    <span className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
                      {group.folder === '' ? 'Ungrouped' : group.folder}
                    </span>
                  )}
                  <ul className="flex flex-col gap-1">{group.items.map(renderRow)}</ul>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {editing !== null && (
        <MeasureDialog
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          tables={definition.tables}
          catalog={catalog}
          folders={folders}
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
