import { useMemo, useState } from 'react';
import { Plus, Sparkles, Trash2, X } from 'lucide-react';
import {
  blankVsRestGrouping,
  groupingProblems,
  MAX_VALUE_GROUPS,
  normalizeGrouping,
  type FilterValue,
  type ValueGroup,
  type ValueGrouping,
} from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdInput } from '../primitives';
import { DistinctValueList } from './DistinctValueList';

export interface ValueGroupingEditorProps {
  modelId: number;
  /** The dimension's table + column — the picker reads real values from it. */
  table: string;
  column: string;
  /** The field's display label, for the heading and the empty-state copy. */
  label: string;
  initial: ValueGrouping | null;
  /**
   * Present = the editor offers "Make this a reusable field", which hands the
   * finished rule to the derived-field authoring path instead of writing it
   * onto the chip. Absent (a host with no field authoring) simply hides it.
   */
  onPromote?: (grouping: ValueGrouping) => void;
  /** null clears the grouping and puts the raw values back on the axis. */
  onApply: (grouping: ValueGrouping | null) => void;
  onClose: () => void;
}

/** A group while it is being edited (React needs a stable key per row). */
interface DraftGroup extends ValueGroup {
  key: string;
}

let seq = 0;
const nextKey = (): string => `g${++seq}`;

const toDraft = (grouping: ValueGrouping | null): DraftGroup[] =>
  (grouping?.groups ?? []).map((group) => ({ ...group, key: nextKey() }));

const valueKey = (value: FilterValue): string => `${typeof value}:${String(value)}`;

/**
 * THE VALUE-GROUPING EDITOR — "show these values as one bar".
 *
 * It exists because of one report: a column holds either a keyword or a date,
 * and the chart draws a bar per distinct date. What the author wants is two
 * bars. Nothing in the product could say that, and the workaround — a new
 * column in the warehouse, or a calculated measure that cannot be a dimension
 * — is not a workaround at all.
 *
 * TWO THINGS THIS DELIBERATELY IS NOT:
 *
 *  1. It is not a formula. The rule is rows of {name, values} plus a blank
 *     bucket and an everything-else name, and the values come from the SAME
 *     server-backed picker the `in` filter uses — so the author selects values
 *     that exist rather than typing them from memory, which is how you get a
 *     rule that silently matches nothing.
 *
 *  2. It is not a field. Applying writes onto the chip and creates NO entry in
 *     the field list, because the standing complaint next to this one is
 *     field-list pollution: most of the time the author wants the bars fixed,
 *     not a new field to manage forever. When they DO want it again elsewhere,
 *     "Make this a reusable field" promotes the same rule into a named derived
 *     field — the upgrade, offered at the moment they discover they need it.
 *
 * The one-click start is the reported case exactly: blank -> "No", everything
 * else -> "Yes", ready to rename.
 */
export function ValueGroupingEditor({
  modelId,
  table,
  column,
  label,
  initial,
  onPromote,
  onApply,
  onClose,
}: ValueGroupingEditorProps) {
  const [groups, setGroups] = useState<DraftGroup[]>(() => toDraft(initial));
  const [otherLabel, setOtherLabel] = useState(initial?.otherLabel ?? '');
  /** Which row's value picker is open (only one at a time — it is a fetch). */
  const [pickerKey, setPickerKey] = useState<string | null>(null);

  const draft = useMemo<ValueGrouping>(
    () => ({
      groups: groups.map(({ key: _key, ...group }) => group),
      ...(otherLabel.trim() !== '' ? { otherLabel: otherLabel.trim() } : {}),
    }),
    [groups, otherLabel],
  );
  const problems = groups.length === 0 ? [] : groupingProblems(draft);
  const normalized = normalizeGrouping(draft);

  const patch = (key: string, next: Partial<ValueGroup>): void =>
    setGroups((current) =>
      current.map((group) => (group.key === key ? { ...group, ...next } : group)),
    );

  const addGroup = (seed?: Partial<ValueGroup>): void => {
    const key = nextKey();
    setGroups((current) => [...current, { key, label: '', ...seed }]);
    setPickerKey(seed?.matchBlank === true ? null : key);
  };

  const removeGroup = (key: string): void => {
    setGroups((current) => current.filter((group) => group.key !== key));
    setPickerKey((open) => (open === key ? null : open));
  };

  const toggleValue = (key: string, value: FilterValue): void =>
    setGroups((current) =>
      current.map((group) => {
        if (group.key !== key) return group;
        const values = group.values ?? [];
        const has = values.some((existing) => valueKey(existing) === valueKey(value));
        const next = has
          ? values.filter((existing) => valueKey(existing) !== valueKey(value))
          : [...values, value];
        return { ...group, values: next };
      }),
    );

  /** The reported case, in one click: blanks are "No", everything else "Yes". */
  const startFromBlankSplit = (): void => {
    const seeded = blankVsRestGrouping('No', 'Yes');
    setGroups(toDraft(seeded));
    setOtherLabel(seeded.otherLabel ?? 'Yes');
    setPickerKey(null);
  };

  const blankTaken = groups.some((group) => group.matchBlank === true);
  const canApply = groups.length === 0 || (problems.length === 0 && normalized !== null);

  return (
    <RcdDialog
      title={`Group values — ${label}`}
      open
      wide
      onClose={onClose}
      footer={
        <>
          {initial !== null && (
            <RcdButton
              onClick={() => {
                onApply(null);
                onClose();
              }}
            >
              Remove grouping
            </RcdButton>
          )}
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton
            variant="primary"
            disabled={!canApply}
            title={problems.length > 0 ? problems.join('; ') : undefined}
            onClick={() => {
              onApply(normalized);
              onClose();
            }}
          >
            Apply
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-rcd-muted">
          One bar per group instead of one bar per value. This changes THIS chart only and adds
          nothing to the field list
          {onPromote === undefined ? '.' : ' — see the bottom of this dialog if you want it everywhere.'}
        </p>

        {groups.length === 0 ? (
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-rcd-border p-3">
            <p className="text-sm text-rcd-text">
              {label} currently draws one bar for every distinct value.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <RcdButton variant="primary" onClick={startFromBlankSplit}>
                <Sparkles size={13} /> Blank vs. everything else
              </RcdButton>
              <RcdButton onClick={() => addGroup()}>
                <Plus size={13} /> Start from a group of values
              </RcdButton>
            </div>
            <p className="text-[11px] text-rcd-muted">
              “Blank vs. everything else” gives you two bars — No and Yes — which you can rename.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {groups.map((group, index) => {
              const values = group.values ?? [];
              const picking = pickerKey === group.key;
              return (
                <li
                  key={group.key}
                  className="flex flex-col gap-2 rounded-md border border-rcd-border bg-rcd-bg p-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="w-4 shrink-0 text-center text-[10px] font-semibold tabular-nums text-rcd-muted"
                    >
                      {index + 1}
                    </span>
                    <RcdInput
                      value={group.label}
                      onChange={(event) => patch(group.key, { label: event.target.value })}
                      placeholder="Group name, e.g. Yes"
                      aria-label={`Name for group ${index + 1}`}
                      className="min-w-0 flex-1"
                    />
                    <button
                      type="button"
                      aria-label={`Remove group ${index + 1}`}
                      title="Remove this group"
                      onClick={() => removeGroup(group.key)}
                      className="shrink-0 rounded p-1 text-rcd-muted hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  <label className="flex items-center gap-2 pl-6 text-xs text-rcd-text-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--rcd-accent)]"
                      checked={group.matchBlank === true}
                      disabled={blankTaken && group.matchBlank !== true}
                      onChange={(event) =>
                        patch(group.key, { matchBlank: event.target.checked || undefined })
                      }
                    />
                    Include rows with no value (blank)
                  </label>

                  <div className="flex flex-wrap items-center gap-1 pl-6">
                    {values.map((value) => (
                      <span
                        key={valueKey(value)}
                        className="flex max-w-[14rem] items-center gap-1 rounded border border-rcd-border px-1.5 py-0.5 text-[11px] text-rcd-text"
                      >
                        <span className="truncate" title={String(value)}>
                          {String(value)}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${String(value)} from ${group.label || `group ${index + 1}`}`}
                          onClick={() => toggleValue(group.key, value)}
                          className="shrink-0 rounded-sm text-rcd-muted hover:text-rcd-text"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => setPickerKey(picking ? null : group.key)}
                      aria-expanded={picking}
                      className="rounded border border-dashed border-rcd-border px-1.5 py-0.5 text-[11px] text-rcd-muted hover:text-rcd-text"
                    >
                      {picking ? 'Done choosing' : values.length === 0 ? 'Choose values…' : '+ more'}
                    </button>
                  </div>

                  {picking && (
                    <div className="pl-6">
                      {/* The SAME server-backed picker the `in` filter uses:
                          the author selects values that actually exist, which
                          is the difference between a rule that groups rows and
                          a rule that silently matches nothing. */}
                      <DistinctValueList
                        modelId={modelId}
                        table={table}
                        column={column}
                        selected={values}
                        onToggle={(value) => toggleValue(group.key, value)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {groups.length > 0 && (
          <>
            <div className="flex items-center gap-2">
              <RcdButton
                disabled={groups.length >= MAX_VALUE_GROUPS}
                title={
                  groups.length >= MAX_VALUE_GROUPS
                    ? `A grouping holds at most ${MAX_VALUE_GROUPS} groups.`
                    : undefined
                }
                onClick={() => addGroup()}
              >
                <Plus size={13} /> Add group
              </RcdButton>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-rcd-text-2">Everything else</span>
              <RcdInput
                value={otherLabel}
                onChange={(event) => setOtherLabel(event.target.value)}
                placeholder="Other"
                aria-label="Name for everything else"
                className="w-full"
              />
              <span className="text-[11px] text-rcd-muted">
                Every row that matches no group above lands in this one bar.
              </span>
            </label>
          </>
        )}

        {problems.length > 0 && (
          <p role="alert" className="text-xs text-[var(--rcd-status-critical)]">
            {problems.join('; ')}.
          </p>
        )}

        {onPromote !== undefined && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-rcd-border bg-rcd-bg px-2.5 py-2">
            <p className="min-w-0 text-[11px] leading-snug text-rcd-muted">
              Want this on other charts too? Turn the rule into a named field that lives beside{' '}
              {label} in the field list — in the model, on this dashboard, or privately.
            </p>
            <RcdButton
              disabled={normalized === null || problems.length > 0}
              title={
                normalized === null
                  ? 'Build a rule with at least one group first.'
                  : problems.length > 0
                    ? problems.join('; ')
                    : undefined
              }
              onClick={() => {
                if (normalized !== null) onPromote(normalized);
              }}
            >
              Make this a reusable field…
            </RcdButton>
          </div>
        )}
      </div>
    </RcdDialog>
  );
}
