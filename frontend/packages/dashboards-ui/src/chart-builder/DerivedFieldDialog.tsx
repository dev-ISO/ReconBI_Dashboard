import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  newId,
  tableKey,
  type Catalog,
  type DerivedField,
  type ModelDefinition,
  type ModelTable,
  type ValidationOutcome,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';
import { VALIDATE_DEBOUNCE_MS } from '../model-editor/MeasureDialog';

type ValidationIssue = ValidationOutcome['issues'][number];

export interface DerivedFieldDraft {
  name: string;
  table: string;
  expression: string;
  dataType: 'text';
  description: string | null;
  displayFolder: string | null;
}

/**
 * The issues a candidate derived field OWNS, by wire path. Exactly the rule
 * MeasureDialog applies to `measures[i]`, against the sibling array — so one
 * broken field elsewhere in the model never blocks saving the one being
 * edited (the flaw wave 3 removed for measures, not re-introduced here).
 */
export const issuesForDerivedFieldIndex = (
  issues: readonly ValidationIssue[],
  index: number,
): ValidationIssue[] => {
  if (index < 0) return [];
  const path = `derivedFields[${index}]`;
  const prefix = `${path}.`;
  return issues.filter(
    (issue) => issue.path === path || (issue.path != null && issue.path.startsWith(prefix)),
  );
};

/**
 * A name collision on a derived field is FATAL, not cosmetic, and in a
 * sharper way than for measures: the name IS the column token a dimension
 * carries, so two fields answering to one name on one table means a chart's
 * axis silently resolves to whichever the engine reaches first.
 *
 * Scoped per TABLE, because that is the address: `orders.Status` and
 * `tickets.Status` are different columns and always were.
 */
export const duplicateDerivedNameOf = (
  siblings: readonly DerivedField[],
  table: string,
  name: string,
  selfId: string,
): DerivedField | null => {
  const needle = name.trim().toLowerCase();
  if (needle === '') return null;
  return (
    siblings.find(
      (field) =>
        field.id !== selfId &&
        field.table === table &&
        field.name.trim().toLowerCase() === needle,
    ) ?? null
  );
};

/** A derived field must not shadow a REAL column of the same table. */
export const shadowedColumnOf = (
  catalog: Catalog | null,
  table: string,
  name: string,
): string | null => {
  const needle = name.trim().toLowerCase();
  if (needle === '') return null;
  const found = catalog?.tables
    .find((t) => t.key === table)
    ?.columns.find((c) => c.name.toLowerCase() === needle);
  return found?.name ?? null;
};

export interface DerivedFieldDialogProps {
  /** null = creating. */
  initial: DerivedField | null;
  /** The model this field is authored against (its tables). */
  definition: ModelDefinition;
  /** Data source for the validation round-trip; null = no round-trip. */
  dataSourceName: string | null;
  catalog: Catalog | null;
  /** EVERY derived field this candidate lives alongside, across all scopes. */
  siblings: readonly DerivedField[];
  /** Existing display folders, for the datalist. */
  folders: string[];
  title?: string;
  note?: ReactNode;
  readOnly?: boolean;
  /** Prefilled table/expression when promoting a chart-local grouping. */
  seed?: { table: string; expression: string; name?: string } | null;
  onClose: () => void;
  onSave: (draft: DerivedFieldDraft) => void;
}

/**
 * Authoring for a NAMED derived field. Structurally the measure dialog with
 * one mode instead of two — same live debounced round-trip against
 * /models/validate, same monotonic sequence guard, same per-candidate issue
 * filtering, same read-only fieldset — because the thing being authored is the
 * same KIND of thing and a second dialect of the same dialog would be a
 * gratuitous difference for the user and a divergence risk for us.
 *
 * ONE DELIBERATE SOFTENING. A transport or deserialization failure is a
 * WARNING here, not a blocking issue: this wave adds `derivedFields` to the
 * model document, and a host still running an older engine answers a validate
 * round-trip with a hard parse failure (ModelJson refuses unknown members). A
 * blocking treatment would make the feature unusable against exactly the
 * server that most needs the client-side rules to hold the line — and the
 * engine remains the final word either way.
 */
export function DerivedFieldDialog({
  initial,
  definition,
  dataSourceName,
  catalog,
  siblings,
  folders,
  title,
  note,
  readOnly = false,
  seed = null,
  onClose,
  onSave,
}: DerivedFieldDialogProps) {
  const runtime = useRuntime();
  const tables = definition.tables;
  const firstTable = tables[0];

  const [name, setName] = useState(initial?.name ?? seed?.name ?? '');
  const [table, setTable] = useState(
    initial?.table ??
      seed?.table ??
      (firstTable ? tableKey(firstTable.schema, firstTable.name) : ''),
  );
  const [expression, setExpression] = useState(initial?.expression ?? seed?.expression ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [displayFolder, setDisplayFolder] = useState(initial?.displayFolder ?? '');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const [validating, setValidating] = useState(false);

  const validationSeq = useRef(0);
  const candidateId = useRef(initial?.id ?? newId());

  const buildDraft = (): DerivedFieldDraft => {
    const folder = displayFolder.trim();
    const text = description.trim();
    return {
      name: name.trim(),
      table,
      expression: expression.trim(),
      dataType: 'text',
      description: text === '' ? null : text,
      displayFolder: folder === '' ? null : folder,
    };
  };

  const spliceCandidate = (
    draft: DerivedFieldDraft,
  ): { fields: DerivedField[]; index: number } => {
    const candidate: DerivedField = { ...draft, id: candidateId.current };
    const present = siblings.some((f) => f.id === candidate.id);
    const fields = present
      ? siblings.map((f) => (f.id === candidate.id ? candidate : f))
      : [...siblings, candidate];
    return { fields, index: fields.findIndex((f) => f.id === candidate.id) };
  };

  const validateDraft = async (draft: DerivedFieldDraft): Promise<ValidationIssue[]> => {
    if (dataSourceName === null) return [];
    const { fields, index } = spliceCandidate(draft);
    try {
      const outcome = await runtime.api.validateModel(dataSourceName, {
        ...definition,
        derivedFields: fields,
      });
      return issuesForDerivedFieldIndex(outcome.issues, index);
    } catch (error) {
      return [
        {
          code: 'checkUnavailable',
          severity: 'warning',
          message: `The formula could not be checked against the server (${
            error instanceof Error ? error.message : String(error)
          }). It will still be validated when the chart runs.`,
          path: null,
        },
      ];
    }
  };

  const expressionText = expression.trim();
  useEffect(() => {
    if (readOnly || expressionText === '' || table === '') {
      validationSeq.current++;
      setValidating(false);
      return;
    }
    const timer = window.setTimeout(() => {
      const seq = ++validationSeq.current;
      setValidating(true);
      void validateDraft(buildDraft()).then((found) => {
        if (seq !== validationSeq.current) return;
        setValidating(false);
        setIssues(found);
      });
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // Only the inputs the server actually judges retrigger a check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expressionText, table, name, readOnly]);

  const duplicate = duplicateDerivedNameOf(siblings, table, name, candidateId.current);
  const shadowed = shadowedColumnOf(catalog, table, name);
  const blocking = issues.filter((issue) => issue.severity !== 'warning');

  const tableOptions = useMemo(
    () =>
      tables.map((t: ModelTable) => ({
        key: tableKey(t.schema, t.name),
        label: t.friendlyName ?? tableKey(t.schema, t.name),
      })),
    [tables],
  );

  const canSave =
    !readOnly &&
    name.trim().length > 0 &&
    table !== '' &&
    expressionText.length > 0 &&
    duplicate === null &&
    shadowed === null &&
    !checking &&
    blocking.length === 0;

  const handleApply = async () => {
    const draft = buildDraft();
    const seq = ++validationSeq.current;
    setChecking(true);
    const found = await validateDraft(draft);
    setChecking(false);
    if (seq !== validationSeq.current) return;
    setValidating(false);
    setIssues(found);
    if (found.some((issue) => issue.severity !== 'warning')) return;
    onSave(draft);
  };

  const folderListId = 'rcd-derived-folders';

  return (
    <RcdDialog
      title={title ?? (initial ? 'Edit field' : 'New field')}
      open
      wide
      onClose={onClose}
      footer={
        readOnly ? (
          <RcdButton onClick={onClose}>Close</RcdButton>
        ) : (
          <>
            <RcdButton onClick={onClose}>Cancel</RcdButton>
            <RcdButton variant="primary" disabled={!canSave} onClick={() => void handleApply()}>
              {checking ? 'Checking…' : initial ? 'Save' : 'Add'}
            </RcdButton>
          </>
        )
      }
    >
      <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
        <div className="flex flex-col gap-4">
          {note && <div className="text-xs text-rcd-muted">{note}</div>}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Name</span>
            <RcdInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Uploaded to EDMS?"
              className="w-full"
            />
            <span className="text-xs text-rcd-muted">
              This is what the field is called in the field list — and how charts address it, so
              renaming it later updates the chart you are editing but not other people&apos;s.
            </span>
            {duplicate !== null && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                Another field on this table is already called “{duplicate.name}”. Two fields with
                one name on one table cannot be told apart.
              </span>
            )}
            {shadowed !== null && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                This table already has a real column called “{shadowed}”. Pick another name so the
                two never compete for the same address.
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Table</span>
            <RcdSelect
              value={table}
              onChange={(event) => {
                setTable(event.target.value);
                setIssues([]);
              }}
              className="w-full"
            >
              {tableOptions.length === 0 && <option value="">No tables in the model</option>}
              {tableOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </RcdSelect>
            <span className="text-xs text-rcd-muted">
              The field becomes a column of this table, and its formula may only use this
              table&apos;s columns.
            </span>
          </label>

          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-rcd-text-2">Formula</span>
              {validating && <span className="text-xs text-rcd-muted">Checking…</span>}
            </div>
            <textarea
              value={expression}
              onChange={(event) => {
                setExpression(event.target.value);
                setIssues([]);
              }}
              rows={6}
              spellCheck={false}
              placeholder={`IF(ISBLANK(${table || 'schema.table'}.column), "No", "Yes")`}
              className="w-full resize-y rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 font-mono text-sm leading-relaxed text-rcd-text outline-none focus:border-rcd-accent"
            />
            {issues.length > 0 && (
              <ul className="flex flex-col gap-1" data-testid="rcd-derived-issues">
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
            <p className="text-[11px] leading-snug text-rcd-muted">
              A formula that produces TEXT, one row at a time — a label to group by, not a number.
              It may use this table&apos;s columns, text in double quotes, ISBLANK(…) and IF(…).
            </p>
          </div>

          <hr className="border-rcd-border" />

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Description (optional)</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="What this field means, and when to use it."
              className="w-full resize-y rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 text-sm text-rcd-text outline-none focus:border-rcd-accent"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Display folder (optional)</span>
            <RcdInput
              value={displayFolder}
              onChange={(event) => setDisplayFolder(event.target.value)}
              placeholder="e.g. Safety"
              list={folderListId}
              className="w-full"
            />
            <datalist id={folderListId}>
              {folders.map((folder) => (
                <option key={folder} value={folder} />
              ))}
            </datalist>
            <span className="text-xs text-rcd-muted">
              Files the field under a category in the field list, like a measure&apos;s folder.
            </span>
          </label>
        </div>
      </fieldset>
    </RcdDialog>
  );
}
