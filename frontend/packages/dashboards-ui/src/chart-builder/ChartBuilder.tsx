import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Sigma } from 'lucide-react';
import {
  isRunnable,
  stableStringify,
  toWireSpec,
  type Catalog,
  type ChartFormat,
  type ChartSpec,
  type FilterClause,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { shapeChartData } from '../chart/chartData';
import { ChartTile } from '../chart/ChartTile';
import { FormatPanel } from '../chart/FormatPanel';
import { useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdInput } from '../primitives';
import { ChartTypePicker } from './ChartTypePicker';
import { FieldList } from './FieldList';
import { FilterEditor } from './FilterEditor';
import { Wells } from './Wells';
import {
  applyDrop,
  columnLabelOf,
  columnTypeOf,
  defaultWellFor,
  measureLabel,
  normalizeQueryForType,
  type FieldDragData,
  type WellId,
} from './wellConfig';

export interface ChartBuilderProps {
  modelId: number;
  model: ModelDefinition;
  initial: ChartSpec;
  onSave: (spec: ChartSpec) => void;
  onCancel: () => void;
  /** Column metadata for the model's data source; FieldList falls back to measures when null. */
  catalog?: Catalog | null;
}

/** Target of the FilterEditor dialog: an existing clause (index) or a new one. */
interface FilterEditorTarget {
  index: number | null;
  table: string;
  column: string;
}

type BuilderTab = 'fields' | 'format';

/** Field list | tabs (title + type + wells / format panel) | live preview. */
export function ChartBuilder({ modelId, model, initial, onSave, onCancel, catalog }: ChartBuilderProps) {
  const runtime = useRuntime();
  const [draft, setDraft] = useState<ChartSpec>(() => structuredClone(initial));
  const [tab, setTab] = useState<BuilderTab>('fields');
  const [activeDrag, setActiveDrag] = useState<FieldDragData | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [filterTarget, setFilterTarget] = useState<FilterEditorTarget | null>(null);
  const lastDragEndAt = useRef(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const dirty = useMemo(
    () => stableStringify(draft) !== stableStringify(initial),
    [draft, initial],
  );

  const addToWell = (well: WellId, data: FieldDragData) => {
    if (well === 'filters') {
      if (data.kind === 'column') {
        setFilterTarget({ index: null, table: data.table, column: data.column });
      }
      return;
    }
    setDraft((current) => ({
      ...current,
      query: applyDrop(current.type, current.query, well, data),
    }));
  };

  const handleDragStart = (event: DragStartEvent) =>
    setActiveDrag((event.active.data.current as FieldDragData | undefined) ?? null);

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    lastDragEndAt.current = Date.now();
    const data = event.active.data.current as FieldDragData | undefined;
    const wellId = (event.over?.data.current as { wellId?: WellId } | undefined)?.wellId;
    if (data && wellId) addToWell(wellId, data);
  };

  const handleDragCancel = () => {
    setActiveDrag(null);
    lastDragEndAt.current = Date.now();
  };

  const handleClickAdd = (data: FieldDragData) => {
    // Ignore the synthetic click that follows a completed drag.
    if (Date.now() - lastDragEndAt.current < 250) return;
    addToWell(defaultWellFor(draft.type, draft.query, data), data);
  };

  const handleCancel = () => {
    if (dirty) setConfirmCancel(true);
    else onCancel();
  };

  const applyFilter = (clause: FilterClause) => {
    const target = filterTarget;
    setFilterTarget(null);
    if (!target) return;
    setDraft((current) => ({
      ...current,
      query: {
        ...current.query,
        filters:
          target.index === null
            ? [...current.query.filters, clause]
            : current.query.filters.map((existing, i) => (i === target.index ? clause : existing)),
      },
    }));
  };

  const editingClause =
    filterTarget !== null && filterTarget.index !== null
      ? (draft.query.filters[filterTarget.index] ?? null)
      : null;

  // Series keys for the Format panel, derived without fetching: legend charts
  // read the preview's cached result (unknown → []); otherwise measure labels.
  const previewCacheKey = useMemo(
    () =>
      draft.query.legend && isRunnable(draft)
        ? runtime.queries.keyFor(toWireSpec(draft, modelId))
        : null,
    [runtime, draft, modelId],
  );
  const previewEntry = useQueryCacheState((state) =>
    previewCacheKey ? state.entries[previewCacheKey] : undefined,
  );
  const seriesKeys = useMemo<string[]>(() => {
    if (draft.query.legend) {
      return previewEntry?.status === 'ok' && previewEntry.data
        ? shapeChartData(previewEntry.data, draft).series.map((series) => series.key)
        : [];
    }
    return draft.query.measures.map((measure) => measureLabel(model, measure));
  }, [draft, previewEntry, model]);

  return (
    <div className="flex h-[34rem] flex-col gap-3">
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.1fr)] gap-3">
          <div className="min-h-0 overflow-y-auto rounded-md border border-rcd-border bg-rcd-surface">
            <FieldList
              model={model}
              catalog={catalog ?? null}
              onAdd={handleClickAdd}
              onAddFilter={(data) =>
                setFilterTarget({ index: null, table: data.table, column: data.column })
              }
            />
          </div>

          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex shrink-0 gap-1 border-b border-rcd-border" role="tablist" aria-label="Chart settings">
              {(['fields', 'format'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors ${
                    tab === id
                      ? 'border-rcd-accent text-rcd-text'
                      : 'border-transparent text-rcd-muted hover:text-rcd-text'
                  }`}
                >
                  {id === 'fields' ? 'Fields' : 'Format'}
                </button>
              ))}
            </div>

            {tab === 'fields' ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
                    Title
                  </span>
                  <RcdInput
                    value={draft.title}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, title: event.target.value }))
                    }
                    placeholder="Chart title"
                  />
                </label>

                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
                    Chart type
                  </span>
                  <ChartTypePicker
                    value={draft.type}
                    onChange={(type) =>
                      setDraft((current) => ({
                        ...current,
                        type,
                        query: normalizeQueryForType(type, current.query),
                      }))
                    }
                  />
                </div>

                <Wells
                  chartType={draft.type}
                  query={draft.query}
                  model={model}
                  catalog={catalog ?? null}
                  onChange={(query) => setDraft((current) => ({ ...current, query }))}
                  onEditFilter={(index) => {
                    const clause = draft.query.filters[index];
                    if (clause) {
                      setFilterTarget({ index, table: clause.table, column: clause.column });
                    }
                  }}
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <FormatPanel
                  spec={draft}
                  seriesKeys={seriesKeys}
                  onChange={(format: ChartFormat) =>
                    setDraft((current) => ({ ...current, format }))
                  }
                />
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
              Preview
            </span>
            <div className="min-h-0 flex-1 rounded-md border border-rcd-border bg-rcd-surface p-2">
              <ChartTile spec={draft} modelId={modelId} debounceMs={300} />
            </div>
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDrag && (
            <div className="flex w-max items-center gap-1.5 rounded-md border border-rcd-accent bg-rcd-surface px-2 py-1 text-xs font-medium text-rcd-text shadow-md">
              {activeDrag.kind === 'measure' && <Sigma size={12} className="text-rcd-muted" />}
              {activeDrag.kind === 'measure' ? activeDrag.name : activeDrag.column}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <div className="flex items-center justify-end gap-2 border-t border-rcd-border pt-3">
        <RcdButton onClick={handleCancel}>Cancel</RcdButton>
        <RcdButton
          variant="primary"
          disabled={!isRunnable(draft)}
          title={isRunnable(draft) ? undefined : 'Add at least one measure to the Values well'}
          onClick={() => onSave(draft)}
        >
          Save chart
        </RcdButton>
      </div>

      {filterTarget && (
        <FilterEditor
          key={`${filterTarget.table}.${filterTarget.column}.${filterTarget.index ?? 'new'}`}
          modelId={modelId}
          table={filterTarget.table}
          column={filterTarget.column}
          columnType={columnTypeOf(catalog ?? null, filterTarget.table, filterTarget.column)}
          label={columnLabelOf(model, filterTarget.table, filterTarget.column)}
          initial={editingClause}
          onApply={applyFilter}
          onCancel={() => setFilterTarget(null)}
        />
      )}

      <ConfirmDialog
        title="Discard chart changes"
        message="This chart has unsaved changes. Discard them?"
        confirmLabel="Discard"
        danger
        open={confirmCancel}
        onConfirm={() => {
          setConfirmCancel(false);
          onCancel();
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
