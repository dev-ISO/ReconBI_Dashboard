import { useMemo, useState } from 'react';
import { AlertTriangle, Info, Lock, Plus, Search, Sigma } from 'lucide-react';
import type { ChartSpec, Measure, ModelDefinition } from '@recon/dashboards-core';
import { useModelState } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdInput } from '../primitives';
import { MeasureDialog, type MeasureDraft } from '../model-editor/MeasureDialog';
import { MeasureRowMenu } from './MeasureRowMenu';
import { buildMeasureMenuItems } from './measureMenu';
import type { MeasureActions } from './measureActions';
import { DerivedFieldDialog, type DerivedFieldDraft } from './DerivedFieldDialog';
import { DerivedFieldSections } from './DerivedFieldSections';
import type { DerivedFieldActions, ScopedDerivedField } from './derivedFieldActions';
import { derivedUsageCount } from './derivedFieldActions';
import {
  MEASURE_SCOPES,
  measureUsageCount,
  scopeBlurb,
  scopeLabel,
  type MeasureScope,
  type ScopedMeasure,
} from './measureScopes';

export interface MeasureManagerProps {
  /** The model the builder is editing against (tables for the dialog). */
  model: ModelDefinition;
  /**
   * The chart being edited. Read-only here — it is what makes "in this chart"
   * and the delete warning honest. Every WRITE (including the ref re-pointing
   * a promotion needs) belongs to the action layer below, which the builder
   * shares with the field list's row menus.
   */
  chart: ChartSpec;
  actions: MeasureActions;
  /** Row to open the editor on straight away (the "edit this" shortcuts). */
  focusMeasureId?: string | null;
  /** Open with the delete confirmation up (the field list's Delete). */
  deleteMeasureId?: string | null;
  /**
   * The DERIVED FIELD half of the same manager. Optional so a host that wants
   * measure management alone keeps exactly the wave-3 dialog: with it absent
   * the tab strip does not render and nothing else changes.
   */
  derived?: DerivedFieldActions;
  /** Open on the Fields tab (the field list's "new field" entry points). */
  initialTab?: ManagerTab;
  /** Open straight into the editor for this derived field. */
  focusDerivedFieldId?: string | null;
  /** Open straight into the delete confirmation for this derived field. */
  deleteDerivedFieldId?: string | null;
  /**
   * A rule PROMOTED out of the value-grouping editor: opens the field dialog
   * pre-filled, so "make this reusable" is a name and a scope rather than a
   * formula typed from memory.
   */
  seedDerivedField?: { table: string; expression: string; name?: string } | null;
  onClose: () => void;
}

/** Which half of the manager is showing. */
export type ManagerTab = 'measures' | 'fields';

const isCalculated = (measure: Measure): boolean =>
  measure.expression != null && measure.expression !== '';

const subtitleOf = (measure: Measure): string => {
  const base = isCalculated(measure)
    ? (measure.expression ?? '')
    : measure.column
      ? `${measure.aggregation} of ${measure.table}.${measure.column}`
      : `${measure.aggregation} of all rows in ${measure.table}`;
  const filterCount = measure.filters?.length ?? 0;
  return filterCount > 0 ? `${base}  ·  ${filterCount} filter(s)` : base;
};

/** What the editor dialog is currently doing. */
type EditorTarget =
  | { mode: 'create'; scope: MeasureScope }
  | { mode: 'edit'; entry: ScopedMeasure };

/**
 * THE MEASURE MANAGER — the thing that did not exist.
 *
 * Before this, measure authoring lived in exactly one place: the model editor,
 * behind a route. The chart builder is a MODAL inside the dashboard, so a link
 * to that route tore the builder (and the chart being edited) down — which is
 * why a user with a half-built chart had no way to fix the measure it needed.
 * The manager therefore opens OVER the builder and leaves it standing.
 *
 * The three scopes are always all three sections, even when a section is empty
 * or read-only: the whole point is that a user can see where a measure lives
 * and move it somewhere better, and a section that appears only when populated
 * teaches nobody that the choice exists.
 */
export function MeasureManager({
  model,
  chart,
  actions,
  focusMeasureId = null,
  deleteMeasureId = null,
  derived,
  initialTab = 'measures',
  focusDerivedFieldId = null,
  deleteDerivedFieldId = null,
  seedDerivedField = null,
  onClose,
}: MeasureManagerProps) {
  const dataSourceName = useModelState((s) => s.current?.dataSourceName ?? null);
  const catalog = useModelState((s) => s.catalog);

  const { scoped, effective, rights } = actions;

  const [tab, setTab] = useState<ManagerTab>(
    derived !== undefined && (initialTab === 'fields' || seedDerivedField !== null)
      ? 'fields'
      : 'measures',
  );
  // Busy/error/notice come from whichever half is showing: the two action
  // layers are independent, and a failed measure save must not paint an error
  // over the Fields tab (or the other way round).
  /** True while the FIELDS half is showing (and there is one to show). */
  const showFields = tab === 'fields' && derived !== undefined;
  const active = showFields && derived !== undefined ? derived : actions;
  const { busy, error, notice } = active;
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<EditorTarget | null>(() => {
    const entry = focusMeasureId
      ? (scoped.find((e) => e.measure.id === focusMeasureId) ?? null)
      : null;
    return entry ? { mode: 'edit', entry } : null;
  });
  const [deleting, setDeleting] = useState<ScopedMeasure | null>(
    () =>
      (deleteMeasureId ? scoped.find((e) => e.measure.id === deleteMeasureId) : undefined) ?? null,
  );

  const needle = search.trim().toLowerCase();
  const sections = useMemo(
    () =>
      MEASURE_SCOPES.map((scope) => ({
        scope,
        rows: scoped.filter(
          (entry) =>
            entry.scope === scope &&
            (needle === '' ||
              entry.measure.name.toLowerCase().includes(needle) ||
              (entry.measure.displayFolder ?? '').toLowerCase().includes(needle)),
        ),
      })),
    [scoped, needle],
  );

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const entry of scoped) {
      const folder = (entry.measure.displayFolder ?? '').trim();
      if (folder !== '') set.add(folder);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [scoped]);

  /* ------------------------------------------------------- derived fields */

  type DerivedEditorTarget =
    | { mode: 'create'; scope: MeasureScope; seed?: { table: string; expression: string; name?: string } }
    | { mode: 'edit'; entry: ScopedDerivedField };

  const [derivedEditor, setDerivedEditor] = useState<DerivedEditorTarget | null>(() => {
    if (!derived) return null;
    if (seedDerivedField !== null) {
      // A promoted grouping arrives with nowhere to live yet. Personal is the
      // default because it is the one scope every author can always write, and
      // widening it later is one menu item.
      const scope: MeasureScope = derived.rights.dashboard.canWrite ? 'dashboard' : 'personal';
      return { mode: 'create', scope, seed: seedDerivedField };
    }
    const entry = focusDerivedFieldId
      ? (derived.scoped.find((e) => e.field.id === focusDerivedFieldId) ?? null)
      : null;
    return entry ? { mode: 'edit', entry } : null;
  });
  const [deletingField, setDeletingField] = useState<ScopedDerivedField | null>(
    () =>
      (deleteDerivedFieldId && derived
        ? derived.scoped.find((e) => e.field.id === deleteDerivedFieldId)
        : undefined) ?? null,
  );

  const derivedFolders = useMemo(() => {
    const set = new Set<string>();
    for (const entry of derived?.scoped ?? []) {
      const folder = (entry.field.displayFolder ?? '').trim();
      if (folder !== '') set.add(folder);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [derived]);

  const derivedHandlers = {
    onEdit: (entry: ScopedDerivedField) => setDerivedEditor({ mode: 'edit', entry }),
    onDuplicate: (entry: ScopedDerivedField) =>
      void derived?.duplicate(entry.scope, entry.field.id),
    onDelete: (entry: ScopedDerivedField) => setDeletingField(entry),
    onTransfer: (entry: ScopedDerivedField, to: MeasureScope) =>
      void derived?.transfer(entry.scope, to, entry.field.id),
  };

  const handleDerivedSave = (draft: DerivedFieldDraft) => {
    const target = derivedEditor;
    setDerivedEditor(null);
    if (!target || !derived) return;
    if (target.mode === 'create') void derived.create(target.scope, draft);
    else void derived.update(target.entry.scope, target.entry.field.id, draft);
  };

  const handleSave = (draft: MeasureDraft) => {
    const target = editor;
    setEditor(null);
    if (!target) return;
    if (target.mode === 'create') void actions.create(target.scope, draft);
    else void actions.update(target.entry.scope, target.entry.measure.id, draft);
  };

  const menuHandlers = {
    onEdit: (entry: ScopedMeasure) => setEditor({ mode: 'edit', entry }),
    onDuplicate: (entry: ScopedMeasure) => void actions.duplicate(entry.scope, entry.measure.id),
    onDelete: (entry: ScopedMeasure) => setDeleting(entry),
    onTransfer: (entry: ScopedMeasure, to: MeasureScope) =>
      void actions.transfer(entry.scope, to, entry.measure.id),
  };

  const renderRow = (entry: ScopedMeasure) => {
    const { measure } = entry;
    const uses = measureUsageCount(chart, measure.id);
    return (
      <li
        key={`${entry.scope}:${measure.id}`}
        className="group flex items-center gap-2 rounded-md border border-rcd-border bg-rcd-bg px-2.5 py-1.5"
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
            {measure.displayFolder && (
              <span className="shrink-0 truncate text-[10px] text-rcd-muted">
                {measure.displayFolder}
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
          <div
            className={`truncate text-xs text-rcd-muted ${isCalculated(measure) ? 'font-mono' : ''}`}
            title={subtitleOf(measure)}
          >
            {subtitleOf(measure)}
          </div>
          {(entry.duplicateName || entry.shadowedById) && (
            <p className="flex items-center gap-1 text-[11px] text-[var(--rcd-status-warn)]">
              <AlertTriangle size={11} aria-hidden className="shrink-0" />
              {entry.shadowedById
                ? 'Another measure already uses this id — this one is ignored. Duplicate it and delete this copy.'
                : 'Another measure has this name. Formulas that reference it by name cannot tell them apart.'}
            </p>
          )}
        </div>
        <MeasureRowMenu
          label={`Actions for ${measure.name}`}
          items={buildMeasureMenuItems(entry, rights, menuHandlers)}
        />
      </li>
    );
  };

  return (
    <RcdDialog
      title={derived === undefined ? 'Measures' : 'Measures and fields'}
      open
      wide
      onClose={onClose}
      footer={<RcdButton onClick={onClose}>Done</RcdButton>}
    >
      <div className="flex flex-col gap-3">
        {derived !== undefined && (
          <div
            role="tablist"
            aria-label="What to manage"
            className="flex w-fit items-center gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/10"
          >
            {(['measures', 'fields'] as ManagerTab[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  tab === id
                    ? 'bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-1)]'
                    : 'text-rcd-muted hover:text-rcd-text'
                }`}
              >
                {id === 'measures' ? 'Measures' : 'Fields'}
              </button>
            ))}
          </div>
        )}

        <p className="text-xs text-rcd-muted">
          {tab === 'fields'
            ? 'A field computed per row — a label you can put on an axis, in a legend or in a filter. It lives in one of three places, same as a measure.'
            : 'A measure lives in one of three places. Move one wider to share it, or copy one narrower to experiment without touching what everyone else sees.'}
        </p>

        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-rcd-muted"
          />
          <RcdInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tab === 'fields' ? 'Search fields…' : 'Search measures…'}
            aria-label={tab === 'fields' ? 'Search fields' : 'Search measures'}
            className="w-full pl-7"
          />
        </div>

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-rcd-border bg-rcd-bg px-2 py-1.5 text-xs text-[var(--rcd-status-critical)]"
          >
            {error}
          </p>
        )}
        {error === null && notice !== null && (
          <p
            role="status"
            className="flex items-start gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1.5 text-xs text-rcd-muted"
          >
            <Info size={12} aria-hidden className="mt-[2px] shrink-0" />
            <span>{notice}</span>
          </p>
        )}

        {showFields && derived !== undefined && (
          <DerivedFieldSections
            model={model}
            chart={chart}
            scoped={derived.scoped}
            rights={derived.rights}
            busy={derived.busy}
            search={search}
            handlers={derivedHandlers}
            onCreate={(scope) => setDerivedEditor({ mode: 'create', scope })}
          />
        )}

        {!showFields &&
          sections.map(({ scope, rows }) => {
          const scopeRight = rights[scope];
          return (
            <section key={scope} className="flex flex-col gap-1.5" aria-label={scopeLabel(scope)}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="flex items-center gap-1.5 text-sm font-semibold text-rcd-text">
                    {scopeLabel(scope)}
                    {!scopeRight.canWrite && (
                      <Lock size={11} aria-label="Read-only" className="shrink-0 text-rcd-muted" />
                    )}
                  </h4>
                  <p className="text-[11px] leading-snug text-rcd-muted">{scopeBlurb(scope)}</p>
                </div>
                <RcdButton
                  disabled={!scopeRight.canWrite || busy || model.tables.length === 0}
                  title={
                    scopeRight.canWrite
                      ? undefined
                      : (scopeRight.reason ?? 'Not available here.')
                  }
                  aria-label={`New measure in ${scopeLabel(scope)}`}
                  onClick={() => setEditor({ mode: 'create', scope })}
                >
                  <Plus size={13} /> New
                </RcdButton>
              </div>

              {!scopeRight.canWrite && scopeRight.reason !== null && (
                <p
                  role="note"
                  className="flex items-start gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1 text-[11px] text-rcd-muted"
                >
                  <Lock size={11} aria-hidden className="mt-[2px] shrink-0" />
                  <span>{scopeRight.reason}</span>
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
      </div>

      {editor !== null && (
        <MeasureDialog
          key={editor.mode === 'create' ? `new-${editor.scope}` : editor.entry.measure.id}
          initial={editor.mode === 'create' ? null : editor.entry.measure}
          definition={model}
          dataSourceName={dataSourceName}
          catalog={catalog}
          // Uniqueness and [reference] resolution span every scope, so the
          // candidate is judged against the WHOLE effective set — not just the
          // scope it happens to be filed under.
          siblings={effective}
          folders={folders}
          title={
            editor.mode === 'create'
              ? `New measure — ${scopeLabel(editor.scope)}`
              : `Edit measure — ${scopeLabel(editor.entry.scope)}`
          }
          note={
            editor.mode === 'create'
              ? scopeBlurb(editor.scope)
              : rights[editor.entry.scope].canWrite
                ? scopeBlurb(editor.entry.scope)
                : rights[editor.entry.scope].reason
          }
          readOnly={editor.mode === 'edit' && !rights[editor.entry.scope].canWrite}
          onClose={() => setEditor(null)}
          onSave={handleSave}
        />
      )}

      {derivedEditor !== null && derived !== undefined && (
        <DerivedFieldDialog
          key={
            derivedEditor.mode === 'create'
              ? `new-field-${derivedEditor.scope}`
              : derivedEditor.entry.field.id
          }
          initial={derivedEditor.mode === 'create' ? null : derivedEditor.entry.field}
          definition={model}
          dataSourceName={dataSourceName}
          catalog={catalog}
          // Uniqueness spans every scope: a name is an ADDRESS, and two
          // addresses that collide are not a style problem.
          siblings={derived.scoped.map((entry) => entry.field)}
          folders={derivedFolders}
          seed={derivedEditor.mode === 'create' ? (derivedEditor.seed ?? null) : null}
          title={
            derivedEditor.mode === 'create'
              ? `New field — ${scopeLabel(derivedEditor.scope)}`
              : `Edit field — ${scopeLabel(derivedEditor.entry.scope)}`
          }
          note={
            derivedEditor.mode === 'create'
              ? scopeBlurb(derivedEditor.scope)
              : derived.rights[derivedEditor.entry.scope].canWrite
                ? scopeBlurb(derivedEditor.entry.scope)
                : derived.rights[derivedEditor.entry.scope].reason
          }
          readOnly={
            derivedEditor.mode === 'edit' &&
            !derived.rights[derivedEditor.entry.scope].canWrite
          }
          onClose={() => setDerivedEditor(null)}
          onSave={handleDerivedSave}
        />
      )}

      <ConfirmDialog
        title="Delete field"
        message={
          deletingField
            ? `Delete “${deletingField.field.name}” from ${scopeLabel(deletingField.scope)}?${
                derivedUsageCount(chart, deletingField.field) > 0
                  ? ' The chart you are editing uses it and will stop rendering until you replace it.'
                  : ''
              }`
            : ''
        }
        confirmLabel="Delete"
        danger
        open={deletingField !== null}
        onCancel={() => setDeletingField(null)}
        onConfirm={() => {
          const target = deletingField;
          setDeletingField(null);
          if (target && derived) void derived.remove(target.scope, target.field.id);
        }}
      />

      <ConfirmDialog
        title="Delete measure"
        message={
          deleting
            ? `Delete “${deleting.measure.name}” from ${scopeLabel(deleting.scope)}?${
                measureUsageCount(chart, deleting.measure.id) > 0
                  ? ' The chart you are editing uses it and will stop rendering that series.'
                  : ''
              }`
            : ''
        }
        confirmLabel="Delete"
        danger
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void actions.remove(target.scope, target.measure.id);
        }}
      />
    </RcdDialog>
  );
}
