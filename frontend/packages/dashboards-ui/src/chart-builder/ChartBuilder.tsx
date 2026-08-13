import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { AlertTriangle, Sigma, Variable, XCircle } from 'lucide-react';
import {
  isRunnable,
  stableStringify,
  toWireSpec,
  validateChartSpec,
  type Catalog,
  type ChartFormat,
  type ChartIssue,
  type ChartSpec,
  type FilterClause,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { shapeChartData } from '../chart/chartData';
import { ChartTile, type ChartTableLayoutPatch } from '../chart/ChartTile';
import { FormatPanel } from '../chart/FormatPanel';
import { useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdInput } from '../primitives';
import { PaneDivider, useBuilderPanes } from './builderLayout';
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
  type BuilderParameter,
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
  /**
   * Dashboard field parameters, draggable into the axis/values wells as
   * bindings (query.paramBindings). Absent = the Parameters section is hidden
   * (the standalone builder never provides them; the dashboard side wires it).
   */
  parameters?: BuilderParameter[];
  /** Tab shown when the builder opens (a dashboard-side "Format chart" flow passes 'format'). */
  initialTab?: 'fields' | 'format';
}

/** Target of the FilterEditor dialog: an existing clause (index) or a new one. */
interface FilterEditorTarget {
  index: number | null;
  table: string;
  column: string;
}

type BuilderTab = 'fields' | 'format';

/** Field list | tabs (title + type + wells / format panel) | live preview. */
export function ChartBuilder({
  modelId,
  model,
  initial,
  onSave,
  onCancel,
  catalog,
  parameters,
  initialTab = 'fields',
}: ChartBuilderProps) {
  const runtime = useRuntime();
  const [draft, setDraft] = useState<ChartSpec>(() => structuredClone(initial));
  const [tab, setTab] = useState<BuilderTab>(initialTab);
  const [activeDrag, setActiveDrag] = useState<FieldDragData | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [filterTarget, setFilterTarget] = useState<FilterEditorTarget | null>(null);
  const lastDragEndAt = useRef(0);

  // Manual pane sizing (drag the hairline dividers); fluid grid until touched.
  const gridRef = useRef<HTMLDivElement>(null);
  const fieldsPaneRef = useRef<HTMLDivElement>(null);
  const middlePaneRef = useRef<HTMLDivElement>(null);
  const paneRefs = useMemo(
    () => ({ fields: fieldsPaneRef, middle: middlePaneRef }),
    [],
  );
  const panes = useBuilderPanes(gridRef, paneRefs);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const dirty = useMemo(
    () => stableStringify(draft) !== stableStringify(initial),
    [draft, initial],
  );

  // Client-side spec validation (mirrors the server's QueryCompiler rules).
  // Errors block Save; warnings only advise. Memoized on the draft/model/
  // catalog identities — the validator is pure.
  const issues = useMemo<ChartIssue[]>(
    () => validateChartSpec(draft, model, catalog ?? null),
    [draft, model, catalog],
  );
  const validationErrors = useMemo(
    () => issues.filter((issue) => issue.severity === 'error'),
    [issues],
  );

  const addToWell = (well: WellId, data: FieldDragData, slot?: number) => {
    if (well === 'filters') {
      if (data.kind === 'column') {
        setFilterTarget({ index: null, table: data.table, column: data.column });
      }
      return;
    }
    setDraft((current) => ({
      ...current,
      query: applyDrop(current.type, current.query, well, data, slot),
    }));
  };

  const handleDragStart = (event: DragStartEvent) =>
    setActiveDrag((event.active.data.current as FieldDragData | undefined) ?? null);

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    lastDragEndAt.current = Date.now();
    const data = event.active.data.current as FieldDragData | undefined;
    const over = event.over?.data.current as { wellId?: WellId; slot?: number } | undefined;
    if (data && over?.wellId) addToWell(over.wellId, data, over.slot);
  };

  const handleDragCancel = () => {
    setActiveDrag(null);
    lastDragEndAt.current = Date.now();
  };

  const handleClickAdd = (data: FieldDragData) => {
    // Ignore the synthetic click that follows a completed drag.
    if (Date.now() - lastDragEndAt.current < 250) return;
    const target = defaultWellFor(draft.type, draft.query, data);
    addToWell(target.well, data, target.slot);
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

  /**
   * Preview-table drags (column resize / header reorder / pager page-size
   * pick) persist straight into the WORKING SPEC's format.table, exactly like
   * the dashboard tile does in edit mode — so table layout is editable from
   * the builder itself. TableChart emits only the touched column in
   * columnWidths, hence the deep merge.
   */
  const handlePreviewTableLayout = useCallback((patch: ChartTableLayoutPatch) => {
    setDraft((current) => {
      if (current.type !== 'table') return current;
      const table = { ...current.format.table };
      if (patch.columnWidths) {
        table.columnWidths = { ...current.format.table?.columnWidths, ...patch.columnWidths };
      }
      if (patch.columnOrder) table.columnOrder = patch.columnOrder;
      // pageSize rides the same layout channel (renderer contract).
      if (patch.pageSize !== undefined) table.pageSize = patch.pageSize;
      return { ...current, format: { ...current.format, table } };
    });
  }, []);

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
    // h-full: the hosting dialog (fillHeight + resizable) provides a definite
    // height, so the whole builder reflows with it; min-h keeps a usable
    // floor when it does not (standalone hosts).
    <div className="flex h-full min-h-[26rem] flex-col gap-3">
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {/* Fluid columns by default: field list and the wells column narrow
            within their minmax ranges; the preview takes every remaining
            pixel, so resizing the dialog genuinely grows the chart on both
            axes. Dragging a hairline divider pins that pane's width (persisted
            in localStorage; double-click resets to fluid) — the divider
            columns replace the old gap so the rhythm is unchanged. */}
        <div
          ref={gridRef}
          className="grid min-h-0 flex-1"
          style={{ gridTemplateColumns: panes.gridTemplateColumns }}
        >
          <div
            ref={fieldsPaneRef}
            className="min-h-0 overflow-y-auto rounded-md border border-rcd-border bg-rcd-surface"
          >
            <FieldList
              model={model}
              catalog={catalog ?? null}
              parameters={parameters}
              onAdd={handleClickAdd}
              onAddFilter={(data) =>
                setFilterTarget({ index: null, table: data.table, column: data.column })
              }
            />
          </div>

          <PaneDivider pane="fields" panes={panes} label="Resize field list" />

          <div ref={middlePaneRef} className="flex min-h-0 flex-col gap-3">
            <div
              className="flex w-fit shrink-0 items-center gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/10"
              role="tablist"
              aria-label="Chart settings"
            >
              {(['fields', 'format'] as const).map((id) => (
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
                  {id === 'fields' ? 'Fields' : 'Format'}
                </button>
              ))}
            </div>

            {tab === 'fields' ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium uppercase tracking-wide text-rcd-muted">
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
                  <span className="text-xs font-medium uppercase tracking-wide text-rcd-muted">
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
                  parameters={parameters}
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

          <PaneDivider pane="middle" panes={panes} label="Resize settings column" />

          <div className="flex min-h-0 flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-rcd-muted">
              Preview
            </span>
            {issues.length > 0 && (
              <div
                role="status"
                aria-label="Chart validation issues"
                className="flex max-h-28 shrink-0 flex-col gap-1 overflow-y-auto rounded-md border border-rcd-border bg-rcd-surface px-2 py-1.5"
              >
                {issues.map((issue, index) => (
                  <p
                    key={index}
                    className={`flex items-start gap-1.5 text-xs ${
                      issue.severity === 'error'
                        ? 'text-[var(--rcd-status-critical)]'
                        : 'text-[var(--rcd-status-warn)]'
                    }`}
                  >
                    {issue.severity === 'error' ? (
                      <XCircle size={13} aria-label="Error" className="mt-[1px] shrink-0" />
                    ) : (
                      <AlertTriangle size={13} aria-label="Warning" className="mt-[1px] shrink-0" />
                    )}
                    <span className="min-w-0 break-words">{issue.message}</span>
                  </p>
                ))}
              </div>
            )}
            <div className="min-h-[10rem] flex-1 rounded-md border border-rcd-border bg-rcd-surface p-2">
              <ChartTile
                spec={draft}
                modelId={modelId}
                debounceMs={300}
                onTableLayoutChange={
                  draft.type === 'table' ? handlePreviewTableLayout : undefined
                }
              />
            </div>
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDrag && (
            <div className="flex w-max items-center gap-1.5 rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1 text-xs font-medium text-rcd-text shadow-[var(--rcd-shadow-2)] ring-1 ring-[color-mix(in_srgb,var(--rcd-accent)_40%,transparent)]">
              {activeDrag.kind === 'measure' && <Sigma size={12} className="text-rcd-muted" />}
              {activeDrag.kind === 'parameter' && (
                <Variable size={12} className="text-rcd-accent" />
              )}
              {activeDrag.kind === 'column' ? activeDrag.column : activeDrag.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <div className="flex items-center justify-end gap-2 border-t border-rcd-border pt-3">
        <RcdButton onClick={handleCancel}>Cancel</RcdButton>
        <RcdButton
          variant="primary"
          disabled={!isRunnable(draft) || validationErrors.length > 0}
          title={
            validationErrors.length > 0
              ? validationErrors.map((issue) => issue.message).join('\n')
              : isRunnable(draft)
                ? undefined
                : 'Add at least one field to a values well'
          }
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
