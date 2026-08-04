import { useMemo, useState } from 'react';
import { CalendarDays, Link2, Plus, Trash2, X } from 'lucide-react';
import {
  dateTableKey,
  isTemporalType,
  tableKey,
  type DateTableDef,
  type Relationship,
} from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect } from '../primitives';

/** Letters/digits/underscores, not starting with a digit. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const rangeSummary = (def: DateTableDef): string => {
  const start = def.rangeStart ?? null;
  const end = def.rangeEnd ?? null;
  if (!start && !end) return 'Automatic range';
  if (start && end) return `${start} → ${end}`;
  return start ? `From ${start}` : `Until ${end ?? ''}`;
};

interface DateTableDialogProps {
  /** null = creating a new date table (name editable); otherwise range edit. */
  initial: DateTableDef | null;
  existingNames: string[];
  onClose: () => void;
  onSave: (def: DateTableDef) => void;
}

function DateTableDialog({ initial, existingNames, onClose, onSave }: DateTableDialogProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [rangeStart, setRangeStart] = useState(initial?.rangeStart ?? '');
  const [rangeEnd, setRangeEnd] = useState(initial?.rangeEnd ?? '');

  const trimmed = name.trim();
  const nameTaken =
    initial === null && existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const nameInvalid = trimmed !== '' && !NAME_PATTERN.test(trimmed);
  const rangeInvalid = rangeStart !== '' && rangeEnd !== '' && rangeStart > rangeEnd;
  const canSave =
    trimmed !== '' && !nameTaken && !nameInvalid && !rangeInvalid;

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
                name: initial?.name ?? trimmed,
                rangeStart: rangeStart === '' ? null : rangeStart,
                rangeEnd: rangeEnd === '' ? null : rangeEnd,
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
            disabled={initial !== null}
            className="w-full disabled:opacity-60"
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
        {rangeInvalid ? (
          <span className="text-xs text-[var(--rcd-status-critical)]">
            The start date must be on or before the end date.
          </span>
        ) : (
          <span className="text-xs text-rcd-muted">
            Leave the range empty to let the engine pick sensible defaults. The table exposes
            date_key, year, quarter, month, month_name, week, day, and day_name.
          </span>
        )}
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
          No date tables yet. A date table gives charts a shared calendar (year, quarter, month…)
          to slice any linked date column by.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-3">
          {dateTables.map((def) => {
            const links = relationshipsByDateTable.get(def.name) ?? [];
            const isLinkingThis = linking?.dateTable === def.name;
            const columnOptions = isLinkingThis ? temporalColumns(linking.draft.table) : [];
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
                    title="Edit date range"
                  >
                    <span className="block truncate text-sm text-rcd-text">{def.name}</span>
                    <span className="block truncate text-xs text-rcd-muted">
                      {rangeSummary(def)}
                    </span>
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
                          onClick={() => models.removeRelationship(r.id)}
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
            models.updateDateTable(def.name, {
              rangeStart: def.rangeStart,
              rangeEnd: def.rangeEnd,
            });
            setEditing(null);
          }}
        />
      )}

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
