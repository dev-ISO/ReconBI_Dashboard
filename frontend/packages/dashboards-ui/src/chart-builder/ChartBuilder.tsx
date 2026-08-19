import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
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
  boldRunText,
  isRunnable,
  retitleInnerTitleHtml,
  stableStringify,
  toWireSpec,
  validateChartSpec,
  type Catalog,
  type ChartFormat,
  type ChartIssue,
  type ChartSpec,
  type ChartType,
  type FilterClause,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { shapeChartData, shapePieData } from '../chart/chartData';
import { ChartTile, type ChartTableLayoutPatch } from '../chart/ChartTile';
import { FormatPanel } from '../chart/FormatPanel';
import { useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdInput } from '../primitives';
import { PaneDivider, useBuilderPanes } from './builderLayout';
import { ChartTypePicker } from './ChartTypePicker';
import { FieldList } from './FieldList';
import { FilterEditor } from './FilterEditor';
import { Wells, type ManualOrderInputs } from './Wells';
import {
  applyDrop,
  columnLabelOf,
  columnTypeOf,
  defaultWellFor,
  measureLabel,
  normalizeQueryForType,
  supportsDrill,
  supportsSmallMultiples,
  valuesMaxFor,
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
  /**
   * False disables the Title input with a hint (0.11.1): chart renames are
   * OWNER/ADMIN-only server-side (the differ's ChartsRenamed class) — grantees
   * with chart rights edit fields/format but never retitle. A disabled title
   * also means withRetitledInnerTitle never fires (it keys on a title CHANGE),
   * so the rich inner title rides through untouched. Default true.
   */
  canRenameTitle?: boolean;
  /**
   * Receives the builder's GUARDED close entry point (the Cancel button's
   * flow: dirty → "Discard chart changes?" confirm, clean → onCancel). The
   * hosting dialog routes its own onClose (Escape, backdrop click, ✕) through
   * it so no close path can silently discard an edited draft. Cleared to null
   * on unmount so a stale closure can never fire against a gone builder.
   */
  requestCloseRef?: MutableRefObject<(() => void) | null>;
}

/** Target of the FilterEditor dialog: an existing clause (index) or a new one. */
interface FilterEditorTarget {
  index: number | null;
  table: string;
  column: string;
}

type BuilderTab = 'fields' | 'format';

/** Chart families whose display order format.categoryOrder/seriesOrder drive. */
const ORDERABLE_TYPES: ReadonlyArray<ChartType> = [
  'column',
  'bar',
  'stackedColumn',
  'stackedBar',
  'line',
  'area',
  'pie',
  'donut',
];

/**
 * Builder-save retitling: when the user renamed the chart AND the tile
 * carries a rich inner title (frameless tiles display THAT, not chart.title),
 * the inner title's bold lead-in is rewritten to the new name — the same
 * helper every chart-copy path routes through, so rename and copy stay one
 * behavior. A helper miss (no bold element) leaves the HTML untouched.
 *
 * The rewrite fires ONLY when the inner title is genuinely still the mirror
 * of the old chart title, judged two ways (both must hold):
 *  - untouched this session: an explicit Format → Container inner-title edit
 *    is the newer statement of what the tile should say, and auto-retitling
 *    over it made the editor appear broken (Apply visibly took, then Save
 *    snapped the bold text back to the Title field's value);
 *  - its bold lead-in still READS as the pre-rename title (boldRunText ===
 *    initial.title): an inner title customized in an EARLIER session never
 *    tracked the chart title, so a rename must not clobber it either — the
 *    session guard alone cannot see cross-session customization.
 */
const withRetitledInnerTitle = (draft: ChartSpec, initial: ChartSpec): ChartSpec => {
  const innerTitleHtml = draft.format.container?.innerTitleHtml;
  if (draft.title === initial.title || !innerTitleHtml) return draft;
  if (innerTitleHtml !== initial.format.container?.innerTitleHtml) return draft;
  if (boldRunText(innerTitleHtml) !== initial.title.trim()) return draft;
  const retitled = retitleInnerTitleHtml(innerTitleHtml, draft.title);
  if (retitled === null) return draft;
  return {
    ...draft,
    format: {
      ...draft.format,
      container: { ...draft.format.container, innerTitleHtml: retitled },
    },
  };
};

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
  canRenameTitle = true,
  requestCloseRef,
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

  /**
   * Session stash of query parts a chart-type switch PRUNES
   * (normalizeQueryForType): measures past the new type's capacity, drill
   * levels, the small-multiples dimension. Switching back to a type that can
   * hold them restores whatever the query has not refilled since — a column →
   * kpi → column round-trip keeps all its measures instead of silently ending
   * at one. Builder-local by design (dies with the dialog, never persisted);
   * restored parts leave the stash so a later deliberate removal stays
   * removed. Each drop overwrites its slot — the newest loss is the one a
   * switch-back should revive.
   */
  const prunedQueryStash = useRef<{
    measures: ChartSpec['query']['measures'];
    drillLevels: ChartSpec['query']['drillLevels'] | null;
    smallMultiples: ChartSpec['query']['smallMultiples'] | null;
  }>({ measures: [], drillLevels: null, smallMultiples: null });

  const handleTypeChange = (type: ChartType) => {
    const stash = prunedQueryStash.current;
    const previous = draft.query;
    let query = normalizeQueryForType(type, previous);
    // Capture what THIS switch dropped, then restore whatever the NEW type
    // can hold again (the two never overlap: a part just captured was
    // captured precisely because the new type has no room for it).
    if (query.measures.length < previous.measures.length) {
      stash.measures = previous.measures.slice(query.measures.length);
    }
    if ((previous.drillLevels?.length ?? 0) > 0 && !query.drillLevels?.length) {
      stash.drillLevels = previous.drillLevels;
    }
    if (previous.smallMultiples && !query.smallMultiples) {
      stash.smallMultiples = previous.smallMultiples;
    }
    const max = valuesMaxFor(type);
    if (stash.measures.length > 0 && query.measures.length < max) {
      const room = Number.isFinite(max)
        ? max - query.measures.length
        : stash.measures.length;
      const revived = stash.measures.slice(0, room);
      query = { ...query, measures: [...query.measures, ...revived] };
      stash.measures = stash.measures.slice(revived.length);
    }
    if (stash.drillLevels?.length && supportsDrill(type) && !query.drillLevels?.length) {
      query = { ...query, drillLevels: stash.drillLevels };
      stash.drillLevels = null;
    }
    if (stash.smallMultiples && supportsSmallMultiples(type) && !query.smallMultiples) {
      query = { ...query, smallMultiples: stash.smallMultiples };
      stash.smallMultiples = null;
    }
    setDraft((current) => ({ ...current, type, query }));
  };

  const handleCancel = () => {
    if (dirty) setConfirmCancel(true);
    else onCancel();
  };

  // Host-facing guarded close (requestCloseRef contract): the ref always
  // points at the LATEST closure — dirty/onCancel change across renders — via
  // the same latest-ref pattern RcdDialog uses for onClose.
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;
  useEffect(() => {
    if (!requestCloseRef) return;
    requestCloseRef.current = () => handleCancelRef.current();
    return () => {
      requestCloseRef.current = null;
    };
  }, [requestCloseRef]);

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

  // Preview-derived shaping, without fetching: the cache key mirrors the
  // preview ChartTile's own fetch, so reading it never issues a query — an
  // unknown/loading entry just yields empty lists. Feeds the Format panel's
  // series keys (legend charts) and the Sort section's manual-order lists.
  const previewCacheKey = useMemo(
    () => (isRunnable(draft) ? runtime.queries.keyFor(toWireSpec(draft, modelId)) : null),
    [runtime, draft, modelId],
  );
  const previewEntry = useQueryCacheState((state) =>
    previewCacheKey ? state.entries[previewCacheKey] : undefined,
  );
  const previewResult =
    previewEntry?.status === 'ok' && previewEntry.data ? previewEntry.data : null;
  const previewShaped = useMemo(
    () => (previewResult ? shapeChartData(previewResult, draft) : null),
    [previewResult, draft],
  );
  // Series keys for the Format panel: the SHAPED PREVIEW's styleKeys — the
  // exact strings every style map keys on (colorOverrides / seriesLabels /
  // lineStyles / secondaryAxisKeys), the same source the Custom-order list
  // reads. The old composition wrote keys the renderer never read back:
  // measure mode composed the client-side "sum of order_total" (lowercase
  // wire enum) against the server's "Sum of order_total" label, and combo
  // mode passed series.key (name\x1Fvalue) instead of the "<Measure> —
  // <value>" styleKey — raw 0x1F rendered in the Series rows. Client
  // measureLabel remains ONLY as the pre-preview fallback for measure-mode
  // charts (legend/combo keys are unknowable without the result: []).
  const seriesKeys = useMemo<string[]>(() => {
    if (previewShaped) return previewShaped.series.map((series) => series.styleKey);
    if (draft.query.legend) return [];
    return draft.query.measures.map((measure) => measureLabel(model, measure));
  }, [draft, previewShaped, model]);

  // Manual-order inputs for the Wells sort section (orderable families only).
  // Categories/series come from the CURRENT shaped preview — exactly the
  // labels/styleKeys the persisted arrays key on; pie mirrors slice labels.
  const ordering = useMemo<ManualOrderInputs | undefined>(() => {
    if (!ORDERABLE_TYPES.includes(draft.type)) return undefined;
    const isPie = draft.type === 'pie' || draft.type === 'donut';
    const categories = isPie
      ? previewResult
        ? shapePieData(previewResult, draft).slices.map((slice) => slice.label)
        : []
      : (previewShaped?.data.map((row) => String(row[previewShaped.axisKey] ?? '')) ?? []);
    return {
      categories,
      series: isPie ? [] : (previewShaped?.series.map((series) => series.styleKey) ?? []),
      axisIsDate: !isPie && (previewShaped?.axisIsDate ?? false),
      categoryOrder: draft.format.categoryOrder,
      seriesOrder: draft.format.seriesOrder,
      onOrderChange: (categoryOrder, seriesOrder) =>
        setDraft((current) => {
          const format = { ...current.format };
          if (categoryOrder && categoryOrder.length > 0) format.categoryOrder = categoryOrder;
          else delete format.categoryOrder;
          if (seriesOrder && seriesOrder.length > 0) format.seriesOrder = seriesOrder;
          else delete format.seriesOrder;
          return { ...current, format };
        }),
    };
  }, [draft, previewResult, previewShaped]);

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
                    disabled={!canRenameTitle}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, title: event.target.value }))
                    }
                    placeholder="Chart title"
                    className={canRenameTitle ? undefined : 'opacity-60'}
                  />
                  {!canRenameTitle && (
                    // Owner-only rename (0.11.1): the server rejects grantee
                    // retitles outright, so the input locks with the reason.
                    <p className="text-[11px] leading-snug text-rcd-muted">
                      Only the dashboard owner (or an administrator) can rename charts.
                    </p>
                  )}
                  {canRenameTitle &&
                    Boolean(draft.format.container?.hideHeader) &&
                    Boolean(draft.format.container?.innerTitleHtml) && (
                      // Frameless tiles show the INNER title, not this field —
                      // without the hint a rename looks like it did nothing.
                      <p className="text-[11px] leading-snug text-rcd-muted">
                        This tile displays its inner title (Format → Container). Renaming
                        updates the bold lead-in.
                      </p>
                    )}
                </label>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium uppercase tracking-wide text-rcd-muted">
                    Chart type
                  </span>
                  <ChartTypePicker value={draft.type} onChange={handleTypeChange} />
                </div>

                <Wells
                  chartType={draft.type}
                  query={draft.query}
                  model={model}
                  catalog={catalog ?? null}
                  parameters={parameters}
                  ordering={ordering}
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
              {activeDrag.kind === 'column'
                ? columnLabelOf(model, activeDrag.table, activeDrag.column)
                : activeDrag.name}
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
          onClick={() => onSave(withRetitledInnerTitle(draft, initial))}
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
