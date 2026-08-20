import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { AlertTriangle, Filter, Sigma, Variable, XCircle } from 'lucide-react';
import {
  boldRunText,
  chartMeasureDefinitions,
  isRunnable,
  pathToWell,
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
  type Measure,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { shapeChartData, shapePieData } from '../chart/chartData';
import { ChartTile, type ChartTableLayoutPatch } from '../chart/ChartTile';
import { FormatPanel } from '../chart/FormatPanel';
import { useDashboardState, useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdInput } from '../primitives';
import { PaneDivider, useBuilderPanes } from './builderLayout';
import { ChartTypePicker } from './ChartTypePicker';
import { FieldList } from './FieldList';
import { FilterEditor } from './FilterEditor';
import { MeasureManager } from './MeasureManager';
import { useMeasureActions } from './measureActions';
import type { MeasureScope, ScopedMeasure } from './measureScopes';
import { Wells, type ManualOrderInputs } from './Wells';
import {
  applyDrop,
  chipColumnOf,
  columnLabelOf,
  columnTypeOf,
  defaultWellFor,
  filterSummary,
  measureLabel,
  moveChip,
  normalizeQueryForType,
  remapIndexedRefs,
  removeChip,
  supportsDrill,
  supportsSmallMultiples,
  valuesMaxFor,
  wellsFor,
  type BuilderParameter,
  type ChipDragData,
  type ChipDropTarget,
  type ChipOrigin,
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
  /**
   * Set when a CHIP was dragged into the Filters well. A chip becomes a filter
   * only once the editor has collected an operator, so the source chip is not
   * removed on the drop — only when the editor applies. Cancelling leaves the
   * chart exactly as it was.
   */
  source?: ChipOrigin;
}

/** A filter chip dragged out of the Filters well, awaiting confirmation. */
interface FilterMove {
  data: ChipDragData;
  to: ChipDropTarget;
}

/**
 * What the measure manager should be showing when it opens. The builder is a
 * MODAL inside the dashboard, so authoring cannot navigate anywhere — the
 * manager opens over it and the builder (and the half-built chart) survives.
 */
interface MeasureManagerRequest {
  /** Open straight into the editor for this measure. */
  focusMeasureId?: string;
  /** Open straight into the delete confirmation for this measure. */
  deleteMeasureId?: string;
}

/**
 * Wells CONTAIN their chips, so a drag is inside both at once. pointerWithin
 * ranks the droppables the pointer is in by distance to their centers, which
 * puts the small chip ahead of the big well around it — the drop lands at the
 * position the user is pointing at rather than at the end of the list.
 * rectIntersection stays as the fallback for the frames where the pointer is
 * outside every droppable but the dragged rect still overlaps one: that is
 * exactly the (default) behavior field-list drops had before chips became
 * targets, so no existing drag gets harder to land.
 */
const wellCollisionDetection: CollisionDetection = (args) => {
  const pointed = pointerWithin(args);
  return pointed.length > 0 ? pointed : rectIntersection(args);
};

/** The label of the well a chip is being moved into (confirmation copy). */
const wellLabelFor = (type: ChartType, to: ChipDropTarget): string =>
  wellsFor(type).find(
    (well) => well.id === to.well && (to.slot === undefined || well.slot === to.slot),
  )?.label ?? 'another well';

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
  const [filterMove, setFilterMove] = useState<FilterMove | null>(null);
  const [measureManager, setMeasureManager] = useState<MeasureManagerRequest | null>(null);
  const lastDragEndAt = useRef(0);

  /**
   * THE MEASURE OVERLAY, client side. Dashboard-scoped and personal measures
   * are not in the stored model, so the field list would not offer them, the
   * client validator would call every one of them `unknown_measure`, and the
   * well chips would render an id. Merging them into ONE effective definition
   * mirrors exactly what the server does before it compiles (the query's
   * `definitions` overlay is merged into ModelDefinition.Measures), so every
   * consumer downstream needs no idea that scopes exist.
   */
  const measureActions = useMeasureActions({
    modelId,
    fallbackSystemMeasures: model.measures,
    chart: draft,
    onChartChange: setDraft,
  });
  const effectiveModel = useMemo<ModelDefinition>(
    () => ({ ...model, measures: measureActions.effective }),
    [model, measureActions.effective],
  );

  const measureManagement = useMemo(
    () => ({
      scoped: measureActions.scoped,
      rights: measureActions.rights,
      // The "+" opens the manager rather than guessing a scope: choosing
      // WHERE a measure lives is the decision this wave exists to surface,
      // and all three "New" buttons are one glance away there.
      onCreate: () => setMeasureManager({}),
      onManage: () => setMeasureManager({}),
      handlers: {
        onEdit: (entry: ScopedMeasure) =>
          setMeasureManager({ focusMeasureId: entry.measure.id }),
        onDuplicate: (entry: ScopedMeasure) =>
          void measureActions.duplicate(entry.scope, entry.measure.id),
        onDelete: (entry: ScopedMeasure) =>
          // Deletion is confirmed, and the manager owns that confirmation —
          // one dialog, one wording, one place that spells out what a delete
          // costs the chart being edited, whichever surface asked for it.
          setMeasureManager({ deleteMeasureId: entry.measure.id }),
        onTransfer: (entry: ScopedMeasure, to: MeasureScope) =>
          void measureActions.transfer(entry.scope, to, entry.measure.id),
      },
    }),
    [measureActions],
  );

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
    () => validateChartSpec(draft, effectiveModel, catalog ?? null),
    [draft, effectiveModel, catalog],
  );
  const validationErrors = useMemo(
    () => issues.filter((issue) => issue.severity === 'error'),
    [issues],
  );

  /**
   * The single seam every well edit goes through. `remapIndexedRefs` re-points
   * whatever addressed a field BY POSITION — sort targets, and the table
   * layout maps keyed by result column name ("meas0"/"dim1") — because adding,
   * removing or reordering ONE field silently slides every field after it. The
   * drag mechanics of moving a chip are visible; an index that moved one place
   * is not, which is why this wraps the whole surface and not just the move.
   */
  const applyQuery = (next: (current: ChartSpec) => ChartSpec['query'] | null) =>
    setDraft((current) => {
      const query = next(current);
      if (query === null || query === current.query) return current;
      return remapIndexedRefs(current, { ...current, query });
    });

  const addToWell = (well: WellId, data: FieldDragData, slot?: number) => {
    if (well === 'filters') {
      if (data.kind === 'column') {
        setFilterTarget({ index: null, table: data.table, column: data.column });
      }
      return;
    }
    applyQuery((current) => applyDrop(current.type, current.query, well, data, slot));
  };

  /** Commits a chip move (the confirmed path for filters, direct otherwise). */
  const applyChipMove = (data: ChipDragData, to: ChipDropTarget) =>
    applyQuery((current) =>
      moveChip(current.type, current.query, data, to, (table, column) =>
        columnTypeOf(catalog ?? null, table, column),
      ),
    );

  const moveChipTo = (data: ChipDragData, to: ChipDropTarget) => {
    if (to.well === 'filters') {
      // A field becomes a filter only once the editor has an operator, so the
      // chip stays in its well until Apply (see applyFilter).
      if (data.from.well === 'filters') return;
      const column = chipColumnOf(data.ref);
      if (!column) return;
      setFilterTarget({
        index: null,
        table: column.table,
        column: column.column,
        source: data.from,
      });
      return;
    }
    if (data.from.well === 'filters') {
      // Leaving the Filters well drops the operator and values with it — no
      // other well has anywhere to keep them — so ask before spending them.
      setFilterMove({ data, to });
      return;
    }
    applyChipMove(data, to);
  };

  const handleDragStart = (event: DragStartEvent) =>
    setActiveDrag((event.active.data.current as FieldDragData | undefined) ?? null);

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    lastDragEndAt.current = Date.now();
    const data = event.active.data.current as FieldDragData | undefined;
    // Wells and chips speak the same droppable shape; a chip additionally
    // carries the position it occupies, which is where the drop lands.
    const over = event.over?.data.current as
      | { wellId?: WellId; slot?: number; index?: number }
      | undefined;
    if (!data || !over?.wellId) return;
    if (data.kind === 'chip') {
      moveChipTo(data, { well: over.wellId, slot: over.slot, index: over.index });
      return;
    }
    addToWell(over.wellId, data, over.slot);
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
    // A type switch prunes measures past the new capacity and can splice the
    // drill levels into (or out of) the wire dimensions, so it shifts indexes
    // exactly like a chip move does — same seam, same repair.
    setDraft((current) => remapIndexedRefs(current, { ...current, type, query }));
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
    applyQuery((current) => {
      const withClause: ChartSpec['query'] = {
        ...current.query,
        filters:
          target.index === null
            ? [...current.query.filters, clause]
            : current.query.filters.map((existing, i) => (i === target.index ? clause : existing)),
      };
      // The other half of the ->Filters detour: the dragged chip leaves its
      // well now that the clause it became actually exists.
      return target.source
        ? removeChip(current.type, withClause, target.source)
        : withClause;
    });
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
  // Must mirror the preview ChartTile's key EXACTLY, scoped measure
  // definitions included — a key that omits them reads a cache slot nothing
  // ever writes, and the Format/Sort panels silently lose their series lists.
  const docMeasures = useDashboardState((state) => state.current?.layout.measures ?? null);
  const personalMeasures = useDashboardState((state) => state.personalMeasures);
  const previewCacheKey = useMemo(() => {
    if (!isRunnable(draft)) return null;
    const scoped: Measure[] = [...(docMeasures ?? []), ...personalMeasures];
    return runtime.queries.keyFor(
      toWireSpec(draft, modelId, [], chartMeasureDefinitions(scoped, draft)),
    );
  }, [runtime, draft, modelId, docMeasures, personalMeasures]);
  const previewEntry = useQueryCacheState((state) =>
    previewCacheKey ? state.entries[previewCacheKey] : undefined,
  );
  const previewResult =
    previewEntry?.status === 'ok' && previewEntry.data ? previewEntry.data : null;
  /**
   * FIELD-LEVEL faults the SERVER reported for the last preview run, mapped
   * back onto builder wells through the pinned wire-path grammar (the
   * backend's ValidationIssue.Path speaks it; pathToWell resolves the
   * dimension index against THIS draft's wire order). They badge exactly the
   * wells the client mirror badges and join the same summary list, so a
   * compile fault the mirror does not model stops being an opaque error card.
   */
  const serverIssues = useMemo<ChartIssue[]>(() => {
    if (previewEntry?.status !== 'error') return [];
    return (previewEntry.issues ?? []).map((issue): ChartIssue => {
      const well = issue.path !== null ? pathToWell(issue.path, draft) : undefined;
      return {
        severity: issue.severity === 'warning' ? 'warning' : 'error',
        code: issue.code,
        message: issue.message,
        ...(well !== undefined ? { well } : {}),
        ...(issue.path !== null ? { path: issue.path } : {}),
      };
    });
  }, [previewEntry, draft]);
  /** Client mirror + server report: what the wells badge and the list lists. */
  const allIssues = useMemo<ChartIssue[]>(
    () => (serverIssues.length === 0 ? issues : [...issues, ...serverIssues]),
    [issues, serverIssues],
  );
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
    return draft.query.measures.map((measure) => measureLabel(effectiveModel, measure));
  }, [draft, previewShaped, effectiveModel]);

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
        collisionDetection={wellCollisionDetection}
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
              model={effectiveModel}
              catalog={catalog ?? null}
              parameters={parameters}
              onAdd={handleClickAdd}
              onAddFilter={(data) =>
                setFilterTarget({ index: null, table: data.table, column: data.column })
              }
              measures={measureManagement}
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
                  model={effectiveModel}
                  catalog={catalog ?? null}
                  parameters={parameters}
                  ordering={ordering}
                  issues={allIssues}
                  onChange={(query) => applyQuery(() => query)}
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
            {allIssues.length > 0 && (
              <div
                role="status"
                aria-label="Chart validation issues"
                className="flex max-h-28 shrink-0 flex-col gap-1 overflow-y-auto rounded-md border border-rcd-border bg-rcd-surface px-2 py-1.5"
              >
                {allIssues.map((issue, index) => (
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
                // D3: a measure the engine could not compile renders as an
                // empty series. The notice names it and this shortcut opens
                // its editor — in the builder that is one click, because the
                // manager is right here.
                onEditMeasure={(failure) => {
                  const ref = draft.query.measures[failure.index];
                  setMeasureManager(
                    ref?.measureId ? { focusMeasureId: ref.measureId } : {},
                  );
                }}
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
              {activeDrag.kind === 'chip' && activeDrag.ref.kind === 'filter' && (
                <Filter size={12} className="text-rcd-muted" />
              )}
              {activeDrag.kind === 'chip' && activeDrag.ref.kind === 'measure' && (
                <Sigma size={12} className="text-rcd-muted" />
              )}
              {activeDrag.kind === 'column'
                ? columnLabelOf(effectiveModel, activeDrag.table, activeDrag.column)
                : activeDrag.kind === 'chip'
                  ? activeDrag.label
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
                : // A table runs on Rows alone; everything else needs a value.
                  draft.type === 'table'
                  ? 'Add at least one field to the Rows well'
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
          label={columnLabelOf(effectiveModel, filterTarget.table, filterTarget.column)}
          initial={editingClause}
          onApply={applyFilter}
          onCancel={() => setFilterTarget(null)}
        />
      )}

      <ConfirmDialog
        title="Move this filter?"
        message={
          filterMove
            ? `“${filterMove.data.label}” will move to ${wellLabelFor(
                draft.type,
                filterMove.to,
              )}. The filter condition on it (${filterMove.data.ref.kind === 'filter' ? filterSummary(filterMove.data.ref.clause) : ''}) is removed — no other well can hold one.`
            : ''
        }
        confirmLabel="Move field"
        open={filterMove !== null}
        onConfirm={() => {
          const pending = filterMove;
          setFilterMove(null);
          if (pending) applyChipMove(pending.data, pending.to);
        }}
        onCancel={() => setFilterMove(null)}
      />

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

      {measureManager !== null && (
        <MeasureManager
          model={model}
          chart={draft}
          actions={measureActions}
          focusMeasureId={measureManager.focusMeasureId ?? null}
          deleteMeasureId={measureManager.deleteMeasureId ?? null}
          onClose={() => setMeasureManager(null)}
        />
      )}
    </div>
  );
}
