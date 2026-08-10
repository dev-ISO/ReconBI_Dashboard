import { useMemo, useState } from 'react';
import { CalendarDays, Link2, Plus, Trash2, X } from 'lucide-react';
import {
  dateTableKey,
  isTemporalType,
  tableKey,
  type DateTableDef,
  type Relationship,
  type WeekStartDay,
} from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect } from '../primitives';

/** Letters/digits/underscores, not starting with a digit. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MONTHS: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Engine defaults when the fields are absent (see DateTableDef docs). */
const DEFAULT_FISCAL_START = 1;
const DEFAULT_WEEK_START: WeekStartDay = 'monday';

const rangeSummary = (def: DateTableDef): string => {
  const start = def.rangeStart ?? null;
  const end = def.rangeEnd ?? null;
  if (!start && !end) return 'Automatic range';
  if (start && end) return `${start} → ${end}`;
  return start ? `From ${start}` : `Until ${end ?? ''}`;
};

/** Second summary line — only rendered when something differs from defaults. */
const calendarSummary = (def: DateTableDef): string | null => {
  const parts: string[] = [];
  const fiscal = def.fiscalYearStartMonth ?? DEFAULT_FISCAL_START;
  if (fiscal !== DEFAULT_FISCAL_START) parts.push(`FY starts ${MONTHS[fiscal - 1]}`);
  const week = def.weekStartDay ?? DEFAULT_WEEK_START;
  if (week !== DEFAULT_WEEK_START) parts.push('Weeks start Sunday');
  return parts.length > 0 ? parts.join(' · ') : null;
};

interface DateTableDialogProps {
  /** null = creating a new date table. */
  initial: DateTableDef | null;
  existingNames: string[];
  onClose: () => void;
  onSave: (def: DateTableDef) => void;
}

function DateTableDialog({ initial, existingNames, onClose, onSave }: DateTableDialogProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [rangeStart, setRangeStart] = useState(initial?.rangeStart ?? '');
  const [rangeEnd, setRangeEnd] = useState(initial?.rangeEnd ?? '');
  const [fiscalStart, setFiscalStart] = useState(
    initial?.fiscalYearStartMonth ?? DEFAULT_FISCAL_START,
  );
  const [weekStart, setWeekStart] = useState<WeekStartDay>(
    initial?.weekStartDay ?? DEFAULT_WEEK_START,
  );

  const trimmed = name.trim();
  // A rename must not collide with ANOTHER table; keeping its own name is fine.
  const nameTaken = existingNames.some(
    (n) => n.toLowerCase() !== (initial?.name ?? '').toLowerCase() &&
      n.toLowerCase() === trimmed.toLowerCase(),
  );
  const nameInvalid = trimmed !== '' && !NAME_PATTERN.test(trimmed);
  const rangeInvalid = rangeStart !== '' && rangeEnd !== '' && rangeStart > rangeEnd;
  const canSave = trimmed !== '' && !nameTaken && !nameInvalid && !rangeInvalid;
  const renaming = initial !== null && trimmed !== initial.name;

  return (
    <RcdDialog
      title={initial ? `Edit date table "${initial.name}"` : 'Add date table'}
      open
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton
            variant="primary"
            disabled={!canSave}
            onClick={() =>
              onSave({
                name: trimmed,
                rangeStart: rangeStart === '' ? null : rangeStart,
                rangeEnd: rangeEnd === '' ? null : rangeEnd,
                // Omit the engine defaults so untouched tables stay byte-identical.
                fiscalYearStartMonth: fiscalStart === DEFAULT_FISCAL_START ? null : fiscalStart,
                weekStartDay: weekStart === DEFAULT_WEEK_START ? null : weekStart,
              })
            }
          >
            {initial ? 'Save' : 'Add'}
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
            placeholder="e.g. Calendar"
            className="w-full"
          />
          {nameInvalid && (
            <span className="text-xs text-[var(--rcd-status-critical)]">
              Use letters, digits, and underscores only (must not start with a digit).
            </span>
          )}
          {nameTaken && (
            <span className="text-xs text-[var(--rcd-status-critical)]">
              A date table with this name already exists.
            </span>
          )}
          {renaming && !nameInvalid && !nameTaken && (
            <span className="text-xs text-rcd-muted">
              Renaming re-points every link to this calendar. Charts that reference{' '}
              <code className="font-mono">{dateTableKey(initial.name)}</code> by name need
              updating.
            </span>
          )}
        </label>

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Start date (optional)</span>
            <RcdInput
              type="date"
              value={rangeStart}
              onChange={(event) => setRangeStart(event.target.value)}
              className="w-full"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">End date (optional)</span>
            <RcdInput
              type="date"
              value={rangeEnd}
              onChange={(event) => setRangeEnd(event.target.value)}
              className="w-full"
            />
          </label>
        </div>
        {rangeInvalid && (
          <span className="text-xs text-[var(--rcd-status-critical)]">
            The start date must be on or before the end date.
          </span>
        )}

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Fiscal year starts</span>
            <RcdSelect
              value={String(fiscalStart)}
              onChange={(event) => setFiscalStart(Number(event.target.value))}
              className="w-full"
            >
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </RcdSelect>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-rcd-text-2">Week starts</span>
            <RcdSelect
              value={weekStart}
              onChange={(event) => setWeekStart(event.target.value as WeekStartDay)}
              className="w-full"
            >
              <option value="monday">Monday</option>
              <option value="sunday">Sunday</option>
            </RcdSelect>
          </label>
        </div>
        <span className="text-xs text-rcd-muted">
          The fiscal year is labelled by the year it ENDS in; January means the fiscal columns
          match the calendar ones. The week setting shapes{' '}
          <code className="font-mono">day_of_week</code> and{' '}
          <code className="font-mono">week_start</code> —{' '}
          <code className="font-mono">is_weekend</code> is always Saturday/Sunday.
        </span>

        <span className="text-xs text-rcd-muted">
          Leave the range empty to let the engine pick sensible defaults. The calendar exposes 25
          columns, including sortable <code className="font-mono">year_month</code>, full{' '}
          <code className="font-mono">month_name_full</code>/
          <code className="font-mono">day_name_full</code>,{' '}
          <code className="font-mono">fiscal_year</code>/
          <code className="font-mono">fiscal_quarter</code>/
          <code className="font-mono">fiscal_month</code>,{' '}
          <code className="font-mono">iso_year</code>/<code className="font-mono">iso_week</code>,{' '}
          <code className="font-mono">week_start</code>, and{' '}
          <code className="font-mono">is_weekend</code>.
        </span>
      </div>
    </RcdDialog>
  );
}

interface LinkDraft {
  table: string;
  column: string;
}

/**
 * Right-rail section: engine-generated calendar tables plus the relationships
 * linking model date columns to them. Date tables do not appear on the canvas,
 * so each row lists its links inline with a "Link a date column…" flow.
 */
export function DateTablesPanel() {
  const models = useRuntime().models;
  const definition = useModelState((s) => s.current?.definition ?? null);
  const catalog = useModelState((s) => s.catalog);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DateTableDef | null>(null);
  const [deleting, setDeleting] = useState<DateTableDef | null>(null);
  /** Link pending removal (destructive → confirmed, like every other delete). */
  const [unlinking, setUnlinking] = useState<Relationship | null>(null);
  /** Date-table name whose inline link flow is open, with its draft. */
  const [linking, setLinking] = useState<{ dateTable: string; draft: LinkDraft } | null>(null);

  const dateTables = definition?.dateTables ?? [];

  const relationshipsByDateTable = useMemo(() => {
    const map = new Map<string, Relationship[]>();
    for (const def of dateTables) map.set(def.name, []);
    for (const r of definition?.relationships ?? []) {
      for (const def of dateTables) {
        if (r.toTable === dateTableKey(def.name)) map.get(def.name)?.push(r);
      }
    }
    return map;
  }, [definition, dateTables]);

  if (!definition) return null;

  const temporalColumns = (table: string): string[] => {
    const catalogTable = catalog?.tables.find((t) => t.key === table) ?? null;
    return (catalogTable?.columns ?? []).filter((c) => isTemporalType(c.type)).map((c) => c.name);
  };

  const linkExists = (dateTable: string, fromTable: string, fromColumn: string): boolean =>
    (relationshipsByDateTable.get(dateTable) ?? []).some(
      (r) => r.fromTable === fromTable && r.fromColumn === fromColumn,
    );

  const startLinking = (dateTable: string) => {
    const firstTable = definition.tables[0];
    setLinking({
      dateTable,
      draft: { table: firstTable ? tableKey(firstTable.schema, firstTable.name) : '', column: '' },
    });
  };

  const commitLink = () => {
    if (!linking || linking.draft.table === '' || linking.draft.column === '') return;
    if (!linkExists(linking.dateTable, linking.draft.table, linking.draft.column)) {
      models.addRelationship({
        fromTable: linking.draft.table,
        fromColumn: linking.draft.column,
        toTable: dateTableKey(linking.dateTable),
        toColumn: 'date_key',
        cardinality: 'manyToOne',
        source: 'manual',
      });
    }
    setLinking(null);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 p-3 pb-2">
        <h3 className="text-sm font-semibold text-rcd-text">Date tables</h3>
        <RcdButton onClick={() => setAdding(true)}>
          <Plus size={14} /> Add date table
        </RcdButton>
      </div>

      {dateTables.length === 0 ? (
        <p className="px-3 py-2 text-sm text-rcd-muted">
          No date tables yet. A date table gives charts a shared 25-column calendar (year,
          quarter, month, ISO week, fiscal periods…) to slice any linked date column by.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-3">
          {dateTables.map((def) => {
            const links = relationshipsByDateTable.get(def.name) ?? [];
            const isLinkingThis = linking?.dateTable === def.name;
            const columnOptions = isLinkingThis ? temporalColumns(linking.draft.table) : [];
            const calendar = calendarSummary(def);
            return (
              <li
                key={def.name}
                className="flex flex-col gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <CalendarDays size={14} className="shrink-0 text-rcd-accent" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setEditing(def)}
                    title="Edit name, range, and calendar settings"
                  >
                    <span className="block truncate text-sm text-rcd-text">{def.name}</span>
                    <span className="block truncate text-xs text-rcd-muted">
                      {rangeSummary(def)}
                    </span>
                    {calendar && (
                      <span className="block truncate text-xs text-rcd-muted">{calendar}</span>
                    )}
                  </button>
                  <RcdIconButton
                    aria-label={`Delete date table ${def.name}`}
                    onClick={() => setDeleting(def)}
                  >
                    <Trash2 size={13} />
                  </RcdIconButton>
                </div>

                {links.length > 0 && (
                  <ul className="flex flex-col gap-0.5">
                    {links.map((r) => (
                      <li key={r.id} className="flex items-center gap-1.5 pl-1 text-xs">
                        <Link2 size={11} className="shrink-0 text-rcd-text-2" />
                        <span className="min-w-0 flex-1 truncate text-rcd-text-2">
                          {r.fromTable}.{r.fromColumn} → date_key
                        </span>
                        <RcdIconButton
                          aria-label={`Remove link ${r.fromTable}.${r.fromColumn}`}
                          className="p-0.5"
                          onClick={() => setUnlinking(r)}
                        >
                          <X size={12} />
                        </RcdIconButton>
                      </li>
                    ))}
                  </ul>
                )}

                {isLinkingThis ? (
                  <div className="flex flex-col gap-1.5">
                    <RcdSelect
                      value={linking.draft.table}
                      onChange={(event) =>
                        setLinking({
                          dateTable: def.name,
                          draft: { table: event.target.value, column: '' },
                        })
                      }
                      aria-label="Table to link"
                      className="w-full"
                    >
                      {definition.tables.length === 0 && (
                        <option value="">No tables in the model</option>
                      )}
                      {definition.tables.map((t) => {
                        const key = tableKey(t.schema, t.name);
                        return (
                          <option key={key} value={key}>
                            {t.friendlyName ?? key}
                          </option>
                        );
                      })}
                    </RcdSelect>
                    <RcdSelect
                      value={linking.draft.column}
                      onChange={(event) =>
                        setLinking({
                          dateTable: def.name,
                          draft: { ...linking.draft, column: event.target.value },
                        })
                      }
                      aria-label="Date column to link"
                      className="w-full"
                    >
                      <option value="" disabled>
                        Select a date column…
                      </option>
                      {columnOptions.map((columnName) => (
                        <option key={columnName} value={columnName}>
                          {columnName}
                        </option>
                      ))}
                    </RcdSelect>
                    {columnOptions.length === 0 && linking.draft.table !== '' && (
                      <span className="text-xs text-rcd-muted">
                        No date or timestamp columns on this table.
                      </span>
                    )}
                    <div className="flex justify-end gap-1.5">
                      <RcdButton variant="ghost" onClick={() => setLinking(null)}>
                        Cancel
                      </RcdButton>
                      <RcdButton
                        variant="primary"
                        disabled={
                          linking.draft.table === '' ||
                          linking.draft.column === '' ||
                          linkExists(def.name, linking.draft.table, linking.draft.column)
                        }
                        title={
                          linkExists(def.name, linking.draft.table, linking.draft.column)
                            ? 'This column is already linked'
                            : undefined
                        }
                        onClick={commitLink}
                      >
                        Link
                      </RcdButton>
                    </div>
                  </div>
                ) : (
                  <RcdButton
                    variant="ghost"
                    className="self-start"
                    disabled={definition.tables.length === 0}
                    title={
                      definition.tables.length === 0
                        ? 'Add a table to the model first'
                        : undefined
                    }
                    onClick={() => startLinking(def.name)}
                  >
                    <Link2 size={13} /> Link a date column…
                  </RcdButton>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <DateTableDialog
          initial={null}
          existingNames={dateTables.map((d) => d.name)}
          onClose={() => setAdding(false)}
          onSave={(def) => {
            models.addDateTable(def);
            setAdding(false);
          }}
        />
      )}

      {editing && (
        <DateTableDialog
          key={editing.name}
          initial={editing}
          existingNames={dateTables.map((d) => d.name)}
          onClose={() => setEditing(null)}
          onSave={(def) => {
            // The store's rename path re-points relationships at the new key.
            models.updateDateTable(editing.name, def);
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        title="Remove link"
        message={
          unlinking
            ? `Stop slicing ${unlinking.fromTable}.${unlinking.fromColumn} by this calendar?`
            : ''
        }
        confirmLabel="Remove"
        danger
        open={unlinking !== null}
        onCancel={() => setUnlinking(null)}
        onConfirm={() => {
          if (unlinking) models.removeRelationship(unlinking.id);
          setUnlinking(null);
        }}
      />

      <ConfirmDialog
        title="Delete date table"
        message={
          deleting
            ? `Delete the date table "${deleting.name}"? Its ${
                (relationshipsByDateTable.get(deleting.name) ?? []).length
              } link(s) to model date columns are removed too.`
            : ''
        }
        confirmLabel="Delete"
        danger
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) models.removeDateTable(deleting.name);
          setDeleting(null);
        }}
      />
    </div>
  );
}
