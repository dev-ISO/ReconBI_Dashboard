import { AlertTriangle, ArrowRightLeft, Copy, Eye, Lock, Pencil, Plus, Trash2, Type } from 'lucide-react';
import type { ChartSpec, DerivedField, ModelDefinition } from '@recon/dashboards-core';
import { RcdButton } from '../primitives';
import { fieldKindStyle } from './fieldColors';
import {
  MEASURE_MENU_SEPARATOR,
  MeasureRowMenu,
  type MeasureMenuItem,
} from './MeasureRowMenu';
import {
  derivedTransferVerb,
  derivedUsageCount,
  type ScopedDerivedField,
} from './derivedFieldActions';
import {
  otherScopes,
  scopeBlurb,
  scopeLabel,
  MEASURE_SCOPES,
  type MeasureScope,
  type MeasureScopeRights,
} from './measureScopes';

export interface DerivedFieldMenuHandlers {
  onEdit: (entry: ScopedDerivedField) => void;
  onDuplicate: (entry: ScopedDerivedField) => void;
  onDelete: (entry: ScopedDerivedField) => void;
  onTransfer: (entry: ScopedDerivedField, to: MeasureScope) => void;
}

/**
 * The row menu for one derived field — the measure menu's shape and wording,
 * because the two are the same KIND of object to a user and offering them
 * different verbs would be a distinction with no meaning. Every entry is
 * always PRESENT; a right the caller lacks disables it and puts the reason in
 * the tooltip.
 */
export const buildDerivedFieldMenuItems = (
  entry: ScopedDerivedField,
  rights: Record<MeasureScope, MeasureScopeRights>,
  handlers: DerivedFieldMenuHandlers,
): (MeasureMenuItem | typeof MEASURE_MENU_SEPARATOR)[] => {
  const own = rights[entry.scope];
  const ownReason = own.canWrite ? undefined : (own.reason ?? undefined);

  const items: (MeasureMenuItem | typeof MEASURE_MENU_SEPARATOR)[] = [
    {
      key: 'edit',
      label: own.canWrite ? 'Edit…' : 'View…',
      icon: own.canWrite ? <Pencil size={12} /> : <Eye size={12} />,
      onSelect: () => handlers.onEdit(entry),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      icon: <Copy size={12} />,
      disabled: !own.canWrite,
      title: ownReason,
      onSelect: () => handlers.onDuplicate(entry),
    },
    {
      key: 'delete',
      label: 'Delete…',
      icon: <Trash2 size={12} />,
      danger: true,
      disabled: !own.canWrite,
      title: ownReason,
      onSelect: () => handlers.onDelete(entry),
    },
    MEASURE_MENU_SEPARATOR,
  ];

  for (const target of otherScopes(entry.scope)) {
    const targetRights = rights[target];
    const verb = derivedTransferVerb(entry.scope, target);
    const blocked = !targetRights.canWrite || (verb === 'move' && !own.canWrite);
    items.push({
      key: `to-${target}`,
      label: `${verb === 'move' ? 'Move to' : 'Copy to'} ${scopeLabel(target)}`,
      icon: verb === 'move' ? <ArrowRightLeft size={12} /> : <Copy size={12} />,
      disabled: blocked,
      title: blocked ? (targetRights.reason ?? ownReason) : undefined,
      onSelect: () => handlers.onTransfer(entry, target),
    });
  }

  return items;
};

/**
 * The three scope sections of derived fields inside the manager. Identical in
 * structure to the measure sections beside them — three sections always, an
 * empty one that says so, a read-only one that says why — because the whole
 * point of the manager is that a user can SEE where a thing lives and move it
 * somewhere better.
 */
export function DerivedFieldSections({
  model,
  chart,
  scoped,
  rights,
  busy,
  search,
  handlers,
  onCreate,
}: {
  model: ModelDefinition;
  chart: ChartSpec;
  scoped: readonly ScopedDerivedField[];
  rights: Record<MeasureScope, MeasureScopeRights>;
  busy: boolean;
  /** Trimmed search text ('' = not searching). */
  search: string;
  handlers: DerivedFieldMenuHandlers;
  onCreate: (scope: MeasureScope) => void;
}) {
  const needle = search.trim().toLowerCase();
  const matches = (field: DerivedField): boolean =>
    needle === '' ||
    field.name.toLowerCase().includes(needle) ||
    field.expression.toLowerCase().includes(needle) ||
    (field.displayFolder ?? '').toLowerCase().includes(needle);

  const renderRow = (entry: ScopedDerivedField) => {
    const { field } = entry;
    const uses = derivedUsageCount(chart, field);
    return (
      <li
        key={`${entry.scope}:${field.id}`}
        className="group flex items-center gap-2 rounded-md border border-rcd-border bg-rcd-bg px-2.5 py-1.5"
      >
        <Type size={14} className="shrink-0" style={fieldKindStyle('text')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm text-rcd-text">{field.name}</span>
            <span
              className="shrink-0 rounded border border-rcd-border px-1 text-[10px] leading-4 text-rcd-muted"
              title="A field computed per row on this table"
            >
              {field.table}
            </span>
            {field.displayFolder && (
              <span className="shrink-0 truncate text-[10px] text-rcd-muted">
                {field.displayFolder}
              </span>
            )}
            {uses > 0 && (
              <span
                className="shrink-0 rounded bg-[color-mix(in_srgb,var(--rcd-accent)_15%,transparent)] px-1 text-[10px] leading-4 text-rcd-accent"
                title="Used by the chart you are editing"
              >
                in this chart
              </span>
            )}
          </div>
          <div className="truncate font-mono text-xs text-rcd-muted" title={field.expression}>
            {field.expression}
          </div>
          {entry.duplicateName && (
            <p className="flex items-center gap-1 text-[11px] text-[var(--rcd-status-warn)]">
              <AlertTriangle size={11} aria-hidden className="shrink-0" />
              Another field on {field.table} has this name. A chart naming it cannot tell them
              apart — rename one.
            </p>
          )}
        </div>
        <MeasureRowMenu
          label={`Actions for ${field.name}`}
          items={buildDerivedFieldMenuItems(entry, rights, handlers)}
        />
      </li>
    );
  };

  return (
    <>
      {MEASURE_SCOPES.map((scope) => {
        const right = rights[scope];
        const rows = scoped.filter((entry) => entry.scope === scope && matches(entry.field));
        return (
          <section key={scope} className="flex flex-col gap-1.5" aria-label={scopeLabel(scope)}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-rcd-text">
                  {scopeLabel(scope)}
                  {!right.canWrite && (
                    <Lock size={11} aria-label="Read-only" className="shrink-0 text-rcd-muted" />
                  )}
                </h4>
                <p className="text-[11px] leading-snug text-rcd-muted">{scopeBlurb(scope)}</p>
              </div>
              <RcdButton
                disabled={!right.canWrite || busy || model.tables.length === 0}
                title={right.canWrite ? undefined : (right.reason ?? 'Not available here.')}
                aria-label={`New field in ${scopeLabel(scope)}`}
                onClick={() => onCreate(scope)}
              >
                <Plus size={13} /> New
              </RcdButton>
            </div>

            {!right.canWrite && right.reason !== null && (
              <p
                role="note"
                className="flex items-start gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1 text-[11px] text-rcd-muted"
              >
                <Lock size={11} aria-hidden className="mt-[2px] shrink-0" />
                <span>{right.reason}</span>
              </p>
            )}

            {rows.length === 0 ? (
              <p className="px-0.5 text-xs text-rcd-muted">
                {needle === '' ? 'Nothing here yet.' : `Nothing matches “${search.trim()}”.`}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">{rows.map(renderRow)}</ul>
            )}
          </section>
        );
      })}
    </>
  );
}
