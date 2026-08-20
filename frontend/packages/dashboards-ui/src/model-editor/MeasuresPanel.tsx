import { useMemo, useState } from 'react';
import { Copy, Lock, Pencil, Plus, Search, Sigma, Trash2 } from 'lucide-react';
import type { Measure } from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { useCanManageShared } from '../provider/useRcdMeta';
import { scopeRights } from '../chart-builder/measureScopes';
import { ConfirmDialog, RcdButton, RcdIconButton, RcdInput } from '../primitives';
import { buildFolderTree, flattenFolderTree, joinFolderPath } from '../util/folderTree';
import { MeasureDialog, aggregationLabel, type MeasureDraft } from './MeasureDialog';

export type { MeasureDraft } from './MeasureDialog';
export { MeasureDialog } from './MeasureDialog';

/** '' = the implicit "ungrouped" folder, always rendered last. */
const folderOf = (measure: Measure): string => (measure.displayFolder ?? '').trim();

/** Right-hand editor panel: list, search, add, duplicate, edit, delete. */
export function MeasuresPanel() {
  const models = useRuntime().models;
  const current = useModelState((s) => s.current);
  const definition = current?.definition ?? null;
  const catalog = useModelState((s) => s.catalog);
  const canManageShared = useCanManageShared();

  const [editing, setEditing] = useState<Measure | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Measure | null>(null);
  const [search, setSearch] = useState('');

  const measures = definition?.measures ?? [];

  /**
   * THE isSystem GATE. MeasuresPanel used to ignore `current.isSystem`
   * entirely: Add/Edit/Duplicate/Delete stayed live on a built-in model,
   * mutated local state, set dirty — and then the save 403'd
   * (DataModelService.UpdateAsync's system-read-only rule), losing the work.
   * The rows are now visibly read-only WITH THE REASON, except for an
   * administrator, whom the backend's measure-only carve-out does let through.
   */
  const rights = scopeRights('system', {
    model: current ? { isSystem: current.isSystem, ownerIsMe: current.ownerIsMe } : null,
    canManageShared,
    dashboard: null,
  });
  const canWrite = rights.canWrite;

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const measure of measures) {
      const folder = folderOf(measure);
      if (folder !== '') set.add(folder);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [measures]);

  /**
   * THE SAME TREE THE CHART BUILDER DRAWS. This panel used to treat the whole
   * "Stage Tracker\Stage 1\Received" string as one flat header while the
   * builder's field list split it into a nested tree — the same measures,
   * grouped two different ways, in one product. Both now call
   * buildFolderTree: same separator, same alphabetical order, same
   * ungrouped-last rule.
   *
   * The DRAWING still differs, and only in the way this rail forces: it is a
   * w-72 column, so the hierarchy is expressed by INDENT over a flat sequence
   * rather than by nested boxes. flattenFolderTree yields exactly the order
   * the nested renderer draws, so the two surfaces agree on what is grouped
   * with what and on what comes first — which is what "same mental model"
   * actually means to someone reading both.
   */
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches =
      needle === '' ? measures : measures.filter((m) => m.name.toLowerCase().includes(needle));
    const tree = buildFolderTree(matches, folderOf, joinFolderPath);
    const folders = flattenFolderTree(tree.folders)
      .filter((node) => node.items.length > 0)
      .map((node) => ({
        key: node.key,
        label: node.name,
        /** Full path, for the tooltip — the indent shows depth, not lineage. */
        path: joinFolderPath(node.path),
        depth: node.path.length - 1,
        items: node.items,
      }));
    // Ungrouped last, exactly where the field list has always put it.
    return tree.root.length > 0
      ? [...folders, { key: '__ungrouped', label: 'Ungrouped', path: '', depth: 0, items: tree.root }]
      : folders;
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
      {canWrite ? (
        <>
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
        </>
      ) : (
        <RcdIconButton aria-label={`View ${measure.name}`} title="View" onClick={() => setEditing(measure)}>
          <Search size={13} />
        </RcdIconButton>
      )}
    </li>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 p-3 pb-2">
        <h3 className="text-sm font-semibold text-rcd-text">Measures</h3>
        {canWrite && (
          <RcdButton
            onClick={() => setEditing('new')}
            disabled={definition.tables.length === 0}
            title={definition.tables.length === 0 ? 'Add a table to the model first' : undefined}
          >
            <Plus size={14} /> Add measure
          </RcdButton>
        )}
      </div>

      {!canWrite && rights.reason !== null && (
        <p
          role="note"
          className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1.5 text-xs text-rcd-muted"
        >
          <Lock size={12} aria-hidden className="mt-[2px] shrink-0" />
          <span>{rights.reason}</span>
        </p>
      )}

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
                <div
                  key={group.key}
                  className="flex flex-col gap-1"
                  style={group.depth > 0 ? { paddingLeft: `${group.depth * 10}px` } : undefined}
                >
                  {/* A single implicit group needs no header. */}
                  {(group.key !== '__ungrouped' || groups.length > 1) && (
                    <span
                      className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted"
                      title={group.path === '' ? undefined : group.path}
                    >
                      {group.label}
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
          definition={definition}
          dataSourceName={current?.dataSourceName ?? null}
          catalog={catalog}
          siblings={measures}
          folders={folders}
          readOnly={!canWrite}
          note={!canWrite ? rights.reason : undefined}
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
