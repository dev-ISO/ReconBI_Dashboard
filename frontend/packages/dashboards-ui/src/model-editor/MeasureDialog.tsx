import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  type ModelDefinition,
  type ModelTable,
  type ValidationOutcome,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';
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

export const aggregationLabel = (aggregation: Aggregation): string =>
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

export type ValidationIssue = ValidationOutcome['issues'][number];

/** Idle time after the last keystroke before background validation fires. */
export const VALIDATE_DEBOUNCE_MS = 600;

export interface MeasureDraft {
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

/**
 * THE FIX (W3/D2). The dialog's live check used to keep every issue whose CODE
 * was expression-shaped and ignore `path` entirely — so one broken calculated
 * measure ANYWHERE in the model disabled Save for every other measure, and the
 * only way out was to fix (or delete) an unrelated formula first. The server
 * has always stamped `measures[i]` (and `measures[i].expression`,
 * `.column`, `.aggregation`, `.filters[f]`) on the issue; this reads it.
 *
 * Matching is EXACT on the index segment: `measures[1].` never matches
 * `measures[10].column`, because the dot is part of the prefix.
 *
 * Path-LESS issues are dropped on purpose. The only measure-relevant one is
 * MDL010 (duplicate names), a model-wide warning with no path that cannot be
 * attributed to a row — `duplicateNameOf` catches that case client-side, and
 * across all three scopes, which the server round-trip cannot do at all.
 */
export const issuesForMeasureIndex = (
  issues: readonly ValidationIssue[],
  index: number,
): ValidationIssue[] => {
  if (index < 0) return [];
  const path = `measures[${index}]`;
  const prefix = `${path}.`;
  return issues.filter(
    (issue) => issue.path === path || (issue.path != null && issue.path.startsWith(prefix)),
  );
};

/** Errors block Save; warnings are shown and do not. */
export const blockingIssues = (issues: readonly ValidationIssue[]): ValidationIssue[] =>
  issues.filter((issue) => issue.severity !== 'warning');

/**
 * The sibling whose name collides with `name`, or null. Case-insensitive, to
 * match the server's OrdinalIgnoreCase grouping (MDL010) and the query
 * overlay's duplicate-name rejection.
 *
 * This is checked CLIENT-side because it is the one rule the round-trip cannot
 * enforce: a dashboard or personal measure is not in the stored model, so a
 * collision between two dashboard measures — or between a personal measure and
 * a model one — is invisible to /models/validate. A collision is fatal rather
 * than cosmetic: `[Name]` references resolve BY NAME, so a duplicate makes
 * every expression citing that name ambiguous, model-wide.
 */
export const duplicateNameOf = (
  siblings: readonly Measure[],
  name: string,
  selfId: string,
): Measure | null => {
  const needle = name.trim().toLowerCase();
  if (needle === '') return null;
  return siblings.find((m) => m.id !== selfId && m.name.trim().toLowerCase() === needle) ?? null;
};

export interface MeasureDialogProps {
  /** null = creating a new measure. */
  initial: Measure | null;
  /** The model this measure is authored against (tables, relationships, …). */
  definition: ModelDefinition;
  /**
   * Data source the validation round-trip runs against. null = no round-trip
   * (a host that never opened the model): the client-side rules still apply
   * and the engine remains the final word, per-measure isolation contains the
   * damage, and the query-time notice names anything that slips through.
   */
  dataSourceName: string | null;
  catalog: Catalog | null;
  /**
   * EVERY measure this candidate lives alongside — the model's own plus, in
   * the chart builder, the dashboard-scoped and personal ones. Two jobs: the
   * uniqueness check above, and the validation splice (a calculated measure
   * that references a dashboard measure by name must be validated with that
   * measure present, or the round-trip reports a phantom MDL013).
   */
  siblings: readonly Measure[];
  /** Existing display folders, for the datalist. */
  folders: string[];
  /** Dialog heading; defaults to Add/Edit measure. */
  title?: string;
  /** Rendered under the heading — the manager names the scope here. */
  note?: ReactNode;
  /** View-only: every control is disabled and the footer offers Close alone. */
  readOnly?: boolean;
  onClose: () => void;
  onSave: (draft: MeasureDraft) => void;
}

export function MeasureDialog({
  initial,
  definition,
  dataSourceName,
  catalog,
  siblings,
  folders,
  title,
  note,
  readOnly = false,
  onClose,
  onSave,
}: MeasureDialogProps) {
  const runtime = useRuntime();
  const tables = definition.tables;

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
   * The measure list the round-trip validates: every sibling, with this
   * candidate substituted (edit) or appended (create). Returned together with
   * the candidate's INDEX, because that index is the only way to tell this
   * measure's issues from every other measure's.
   */
  const spliceCandidate = (draft: MeasureDraft): { measures: Measure[]; index: number } => {
    const candidate: Measure = { ...draft, id: candidateId.current };
    const present = siblings.some((m) => m.id === candidate.id);
    const measures = present
      ? siblings.map((m) => (m.id === candidate.id ? candidate : m))
      : [...siblings, candidate];
    return { measures, index: measures.findIndex((m) => m.id === candidate.id) };
  };

  /**
   * POSTs the WORKING definition with this measure applied and returns the
   * issues THAT MEASURE owns. Shared by the debounced background check and the
   * Apply-time gate so both judge the measure identically.
   */
  const validateDraft = async (draft: MeasureDraft): Promise<ValidationIssue[]> => {
    if (dataSourceName === null) return [];
    const { measures, index } = spliceCandidate(draft);
    try {
      const outcome = await runtime.api.validateModel(dataSourceName, {
        ...definition,
        measures,
      });
      return issuesForMeasureIndex(outcome.issues, index);
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
    if (readOnly || mode !== 'calculation' || expressionText === '' || table === '') {
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
  }, [mode, expressionText, table, name, readOnly]);

  const duplicate = duplicateNameOf(siblings, name, candidateId.current);
  const blocking = blockingIssues(issues);

  const canSave =
    !readOnly &&
    name.trim().length > 0 &&
    table !== '' &&
    duplicate === null &&
    !checking &&
    (mode === 'aggregation'
      ? column !== '' || aggregation === 'count'
      : expressionText.length > 0 && blocking.length === 0);

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
    setIssues(found);
    if (blockingIssues(found).length > 0) return;
    onSave(draft);
  };

  const folderListId = 'rcd-measure-folders';

  return (
    <RcdDialog
      title={title ?? (initial ? 'Edit measure' : 'Add measure')}
      open
      wide
      onClose={onClose}
      footer={
        readOnly ? (
          <RcdButton onClick={onClose}>Close</RcdButton>
        ) : (
          <>
            <RcdButton onClick={onClose}>Cancel</RcdButton>
            <RcdButton variant="primary" disabled={!canSave} onClick={handleApply}>
              {checking ? 'Checking…' : initial ? 'Save' : 'Add'}
            </RcdButton>
          </>
        )
      }
    >
      {/* One disabled fieldset is the whole read-only story: it disables every
          control inside, including the ones nested components own. */}
      <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
        <div className="flex flex-col gap-4">
          {note && <div className="text-xs text-rcd-muted">{note}</div>}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Name</span>
            <RcdInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Total revenue"
              className="w-full"
            />
            {duplicate !== null && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                Another measure is already called “{duplicate.name}”. Names must be unique — a
                formula that says [{duplicate.name}] could not tell them apart.
              </span>
            )}
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
              {tables.map((t: ModelTable) => {
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
                <ul className="flex flex-col gap-1" data-testid="rcd-measure-issues">
                  {issues.map((issue, index) => (
                    <li
                      key={index}
                      className={`text-xs ${
                        issue.severity === 'warning'
                          ? 'text-[var(--rcd-status-warn)]'
                          : 'text-[var(--rcd-status-critical)]'
                      }`}
                    >
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
      </fieldset>
    </RcdDialog>
  );
}
