import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Filter,
  GripVertical,
  Layers,
  Pencil,
  Sigma,
  TrendingUp,
  Type,
  Variable,
  X,
} from 'lucide-react';
import {
  derivedFieldOf,
  groupingLabels,
  hasGrouping,
  isTemporalType,
  reconcileOrder,
  type Aggregation,
  type Catalog,
  type ChartIssue,
  type ChartQuery,
  type ChartType,
  type DateBucket,
  type DimensionRef,
  type FilterClause,
  type MeasureCalc,
  type MeasureRef,
  type ModelDefinition,
  type SortSpec,
  type ValueGrouping,
} from '@recon/dashboards-core';
import { ColumnTypeIcon } from '../data-pane/SchemaExplorer';
import { RcdInput, RcdSelect } from '../primitives';
import { fieldKindLabel, fieldKindOfColumnType, fieldKindStyle, type FieldKind } from './fieldColors';
import {
  aggregationOptionsFor,
  canAccept,
  canDropChip,
  chipColumnOf,
  clearParamBinding,
  columnLabelOf,
  columnTypeOf,
  FILTERS_WELL,
  filterSummary,
  hasDrillSubArea,
  measureLabel,
  wellsFor,
  type BuilderParameter,
  type ChipDragData,
  type ChipShape,
  type FieldDragData,
  type WellDef,
  type WellId,
} from './wellConfig';

export interface WellsProps {
  chartType: ChartType;
  query: ChartQuery;
  model: ModelDefinition;
  catalog: Catalog | null;
  /**
   * Opens the value-grouping editor for one dimension. Absent = the "Group
   * values…" affordance is not offered (a host that does not want chart-local
   * grouping, or one with no model id to fetch distinct values against).
   *
   * The chip does not own the editor: the editor is a dialog, and a dialog
   * mounted inside a chip that a re-render can replace loses its state
   * mid-edit. So the chip asks, and the builder holds it open.
   */
  onGroupValues?: (target: GroupingTarget) => void;
  /** Dashboard field parameters; resolves binding chips' display names. */
  parameters?: BuilderParameter[];
  onChange: (query: ChartQuery) => void;
  /** Opens the FilterEditor for an existing clause in query.filters. */
  onEditFilter: (index: number) => void;
  /**
   * Inputs for the Sort section's "Custom order…" drag lists (cartesian +
   * pie families). Absent = the choice is not offered. ChartBuilder derives
   * the lists from the cached preview result — no extra fetch.
   */
  ordering?: ManualOrderInputs;
  /**
   * Well-tagged validation issues to badge: client issues from
   * validateChartSpec plus server RcdApiError.issues mapped through
   * pathToWell. The offending well gets a red ring and a tooltip listing its
   * messages; the flat summary list stays with ChartBuilder.
   */
  issues?: ChartIssue[];
}

/**
 * Which dimension a "Group values…" click means, and how to write the rule
 * back. The setter is a closure over the well the chip lives in, so the editor
 * never has to know whether it is editing an axis, a legend, a small-multiples
 * dimension or the third row of a table.
 */
export interface GroupingTarget {
  dimension: DimensionRef;
  label: string;
  onApply: (grouping: ValueGrouping | null) => void;
}

/**
 * The messages that badge one well. 'drill' issues land on the table's
 * multi-field Rows well (its levels render INSIDE the axis well there);
 * cartesians route them to the DrillSection under the axis instead.
 */
export const issueMessagesFor = (
  def: Pick<WellDef, 'id' | 'capacity'>,
  issues: readonly ChartIssue[] | undefined,
): string[] =>
  (issues ?? [])
    .filter(
      (issue) =>
        issue.well === def.id ||
        (def.id === 'axis' && def.capacity === 'many' && issue.well === 'drill'),
    )
    .map((issue) => issue.message);

/** What the manual-order UI needs to know about the CURRENTLY rendered chart. */
export interface ManualOrderInputs {
  /** Category display labels in the order the chart shows them (categoryOrder keys). */
  categories: string[];
  /** Series styleKeys in render order (the colorOverrides/seriesLabels keys seriesOrder uses). */
  series: string[];
  /** Date axes keep server chronology — the category list is suppressed. */
  axisIsDate: boolean;
  /** Persisted format.categoryOrder / format.seriesOrder. */
  categoryOrder?: string[];
  seriesOrder?: string[];
  /** Writes both arrays back to format (undefined/empty clears a side). */
  onOrderChange: (
    categoryOrder: string[] | undefined,
    seriesOrder: string[] | undefined,
  ) => void;
}

/**
 * Date grains offered on a temporal chip. `null` = "Exact date": no bucketing
 * at all — DimensionRef.dateBucket has always been nullable on the wire, but
 * until 0.14.1 the drop forced 'month' and the select offered no way back, so
 * "Latest Week Ending" in a table's Rows could only ever read as a month.
 * The empty string is its option value (a <select> value is always a string).
 */
const EXACT_DATE = '';

const DATE_BUCKETS: { value: DateBucket | null; label: string }[] = [
  { value: null, label: 'Exact date' },
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
];

const AGG_LABELS: Record<Aggregation, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  stdDev: 'Std. deviation',
  variance: 'Variance',
  median: 'Median',
  count: 'Count',
  countDistinct: 'Distinct count',
};

// ---------------------------------------------------------------------------
// Chip drags (moving a field between wells)
// ---------------------------------------------------------------------------

/**
 * A chip's registration in the BUILDER's drag context — ChartBuilder's
 * DndContext, the same one the field list drags into. That placement is the
 * whole trick: dnd-kit only ever collides a draggable with droppables from the
 * SAME provider, so the table Rows list (which used to run its own nested
 * DndContext purely to be sortable) had to give that up to reach the Values
 * well at all. Reordering did not regress — it moved up into the one context
 * with the grip handle still driving it.
 *
 * Chips in a LIST well register as sortables: dnd-kit gives one id both a
 * draggable and a droppable, which is what lets a chip be dropped ON another
 * chip and land in that exact position rather than at the end of the well.
 * Chips in a one-chip well are plain draggables — their well is the only drop
 * position there is.
 */
interface ChipDrag {
  setNodeRef: (node: HTMLElement | null) => void;
  attributes: ReturnType<typeof useDraggable>['attributes'];
  listeners: ReturnType<typeof useDraggable>['listeners'];
  style?: React.CSSProperties;
  isDragging: boolean;
}

/**
 * Droppable data every drop target speaks: `wellId`/`slot` say WHICH well, and
 * `index` (chips only) says where in it. One shape for wells and chips alike
 * keeps ChartBuilder's drag-end handler from having to tell them apart.
 */
type ChipDropData = ChipDragData & { wellId: WellId; index: number };

function SortableChip({
  id,
  data,
  children,
}: {
  id: string;
  data: ChipDropData;
  children: (drag: ChipDrag) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data,
  });
  return (
    <>
      {children({
        setNodeRef,
        attributes,
        listeners,
        isDragging,
        style: { transform: CSS.Translate.toString(transform), transition },
      })}
    </>
  );
}

function DraggableChip({
  id,
  data,
  children,
}: {
  id: string;
  data: ChipDropData;
  children: (drag: ChipDrag) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data });
  return <>{children({ setNodeRef, attributes, listeners, isDragging })}</>;
}

/**
 * The same drag MINUS the node registration, for a chip whose surrounding row
 * element is the registered node (numbered rows translate as one unit, chip
 * plus its "1."). The chip still carries the body listeners.
 */
const bodyDragOnly = (drag: ChipDrag): ChipDrag => ({
  ...drag,
  setNodeRef: () => {},
  style: undefined,
  // The row already dims and lifts; dimming the chip again would compound it.
  isDragging: false,
});

/**
 * The grip on a chip in a list well. It drives the SAME drag the chip body
 * does — dragging within the well reorders, dragging out moves — so the
 * familiar handle keeps working exactly as it did while quietly gaining the
 * second gesture.
 */
function ChipGrip({ drag, label }: { drag: ChipDrag; label: string }) {
  return (
    <button
      type="button"
      aria-label={`Reorder ${label}`}
      title="Drag to reorder, or into another well"
      {...drag.attributes}
      {...drag.listeners}
      className="-ml-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-rcd-muted hover:text-rcd-text"
    >
      <GripVertical size={11} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Quick calculations (MeasureRef.calc)
// ---------------------------------------------------------------------------

/** "Same period last year" offset in buckets, derived from the axis dateBucket. */
const YOY_OFFSETS: Record<DateBucket, number> = {
  month: 12,
  quarter: 4,
  week: 52,
  day: 365,
  year: 1,
};

interface CalcMenuItem {
  key: string;
  label: string;
  calc: MeasureCalc | null;
  /** ytd + all prior/change kinds need a date-bucketed axis (level 0). */
  requiresDateAxis: boolean;
}

const calcMenuItems = (axisBucket: DateBucket | null): CalcMenuItem[] => {
  const yoy = axisBucket ? YOY_OFFSETS[axisBucket] : 12;
  return [
    { key: 'none', label: 'None', calc: null, requiresDateAxis: false },
    {
      key: 'runningTotal',
      label: 'Running total',
      calc: { kind: 'runningTotal' },
      requiresDateAxis: false,
    },
    { key: 'ytd', label: 'Year-to-date', calc: { kind: 'ytd' }, requiresDateAxis: true },
    {
      key: 'prior1',
      label: 'vs previous period',
      calc: { kind: 'priorPeriod', offset: 1 },
      requiresDateAxis: true,
    },
    {
      key: 'change1',
      label: 'Change vs previous period',
      calc: { kind: 'periodChange', offset: 1 },
      requiresDateAxis: true,
    },
    {
      key: 'changePct1',
      label: '% change vs previous period',
      calc: { kind: 'periodChangePct', offset: 1 },
      requiresDateAxis: true,
    },
    {
      key: 'priorYoy',
      label: 'vs same period last year',
      calc: { kind: 'priorPeriod', offset: yoy },
      requiresDateAxis: true,
    },
    {
      key: 'changeYoy',
      label: 'Change vs same period last year',
      calc: { kind: 'periodChange', offset: yoy },
      requiresDateAxis: true,
    },
    {
      key: 'changePctYoy',
      label: '% change vs same period last year',
      calc: { kind: 'periodChangePct', offset: yoy },
      requiresDateAxis: true,
    },
  ];
};

const sameCalc = (a: MeasureCalc | null, b: MeasureCalc | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'runningTotal' || a.kind === 'ytd') return true;
  return (a.offset ?? 1) === (b.offset ?? 1);
};

/** Short chip-badge text for an active quick calculation. */
const calcBadge = (calc: MeasureCalc): string => {
  const yoy = (calc.offset ?? 1) !== 1;
  switch (calc.kind) {
    case 'runningTotal':
      return 'RT';
    case 'ytd':
      return 'YTD';
    case 'priorPeriod':
      return yoy ? 'PY' : 'PP';
    case 'periodChange':
      return yoy ? 'ΔPY' : 'Δ';
    case 'periodChangePct':
      return yoy ? 'Δ%PY' : 'Δ%';
  }
};

const calcLabel = (calc: MeasureCalc, axisBucket: DateBucket | null): string =>
  calcMenuItems(axisBucket).find((item) => sameCalc(item.calc, calc))?.label ?? 'Quick calculation';

/**
 * Per-type wells, Power BI style: each chart type shows its own labeled slots
 * (X axis / Y axis, Slices / Values, X value / Y value, …) with a helper
 * caption, all writing the same ChartQuery underneath. The universal "Filters
 * on this chart" well and a Sort / Top N section follow.
 */
export function Wells({
  chartType,
  query,
  model,
  catalog,
  parameters,
  onChange,
  onEditFilter,
  onGroupValues,
  ordering,
  issues,
}: WellsProps) {
  const removeMeasure = (index: number) =>
    onChange({ ...query, measures: query.measures.filter((_, i) => i !== index) });

  const setAggregation = (index: number, aggregation: Aggregation) =>
    onChange({
      ...query,
      measures: query.measures.map((m, i) => (i === index ? { ...m, aggregation } : m)),
    });

  /**
   * Inline rename (MeasureRef.alias). Undefined DELETES the key so a cleared
   * box round-trips to exactly the spec the user started from — the composed
   * server label — rather than persisting an empty alias.
   */
  const setAlias = (index: number, alias: string | undefined) =>
    onChange({
      ...query,
      measures: query.measures.map((m, i) => {
        if (i !== index) return m;
        if (alias === undefined) {
          const { alias: _dropped, ...rest } = m;
          return rest;
        }
        return { ...m, alias };
      }),
    });

  const setCalc = (index: number, calc: MeasureCalc | null) =>
    onChange({
      ...query,
      measures: query.measures.map((m, i) =>
        i === index ? { ...m, calc: calc ?? undefined } : m,
      ),
    });

  const removeFilter = (index: number) =>
    onChange({ ...query, filters: query.filters.filter((_, i) => i !== index) });

  const axisBucket = query.axis?.dateBucket ?? null;
  const hasAxis = query.axis != null;

  /**
   * Hands the builder everything the grouping editor needs for ONE dimension:
   * which field it is, what it is called, and how to write the finished rule
   * back into whichever well it came from. Applying a grouping also clears the
   * date grain — they compile to the same expression, and a chip carrying both
   * would be a spec the compiler refuses.
   */
  const groupingTargetFor = (
    dimension: DimensionRef,
    write: (next: DimensionRef) => void,
  ): (() => void) | undefined => {
    if (!onGroupValues) return undefined;
    return () =>
      onGroupValues({
        dimension,
        label: columnLabelOf(model, dimension.table, dimension.column),
        onApply: (grouping) => {
          const next: DimensionRef = { ...dimension };
          if (grouping === null) delete next.grouping;
          else {
            next.grouping = grouping;
            next.dateBucket = null;
          }
          write(next);
        },
      });
  };

  /** The same, for a positional row in a Rows / drill-levels list. */
  const groupingTargetForLevels = (
    levels: DimensionRef[],
    onLevels: (next: DimensionRef[]) => void,
  ) =>
    onGroupValues
      ? (index: number, dimension: DimensionRef) =>
          groupingTargetFor(dimension, (next) =>
            onLevels(levels.map((level, i) => (i === index ? next : level))),
          )?.()
      : undefined;

  const axisBinding = query.paramBindings?.axis ?? null;
  const measuresBinding = query.paramBindings?.measures ?? null;
  const parameterName = (id: string) =>
    parameters?.find((parameter) => parameter.id === id)?.name ?? id;

  /**
   * The payload a chip drag carries. `type` is resolved HERE, while the
   * catalog is in hand: neither a DimensionRef nor a FilterClause records one,
   * and the receiving well needs it to pick an aggregation (a table's Values
   * takes text as Min) or decide whether a date bucket applies.
   */
  const chipData = (well: WellId, index: number, ref: ChipShape, label: string): ChipDropData => {
    const column = chipColumnOf(ref);
    return {
      kind: 'chip',
      from: { well, index },
      ref,
      type: column ? columnTypeOf(catalog, column.table, column.column) : null,
      label,
      wellId: well,
      index,
    };
  };

  /** Mirrors ValueChip's own display label, for the drag payload/overlay. */
  const measureChipLabel = (measure: MeasureRef): string =>
    measure.measureId != null
      ? measureLabel(model, measure)
      : (measure.alias ?? columnLabelOf(model, measure.table ?? '', measure.column ?? ''));

  /**
   * Whether a well would honor this drag — the same predicate the drop itself
   * runs, so a well never lights up for a move that would then do nothing.
   */
  const acceptsInto = (well: WellId, slot?: number) => (data: FieldDragData) =>
    data.kind === 'chip'
      ? canDropChip(chartType, query, data, { well, slot })
      : canAccept(well, data);

  const valueChip = (measure: MeasureRef, index: number, sortable: boolean) => {
    const key = `${measure.measureId ?? `${measure.table ?? ''}.${measure.column ?? ''}.${measure.aggregation ?? ''}`}-${index}`;
    const label = measureChipLabel(measure);
    const data = chipData('values', index, { kind: 'measure', measure }, label);
    const render = (drag: ChipDrag) => (
      <ValueChip
        measure={measure}
        model={model}
        catalog={catalog}
        hasAxis={hasAxis}
        axisBucket={axisBucket}
        drag={drag}
        leading={
          sortable && query.measures.length > 1 ? (
            <ChipGrip drag={drag} label={label} />
          ) : undefined
        }
        onAggregation={(aggregation) => setAggregation(index, aggregation)}
        onAlias={(alias) => setAlias(index, alias)}
        onCalc={(calc) => setCalc(index, calc)}
        onRemove={() => removeMeasure(index)}
      />
    );
    return sortable ? (
      <SortableChip key={key} id={`chip-values-${index}`} data={data}>
        {render}
      </SortableChip>
    ) : (
      <DraggableChip key={key} id={`chip-values-${index}`} data={data}>
        {render}
      </DraggableChip>
    );
  };

  /** True for the first values well only — the binding chip renders once. */
  const firstValuesKey = wellsFor(chartType).find((w) => w.id === 'values')?.key;

  const renderWell = (def: WellDef) => {
    const wellIssues = issueMessagesFor(def, issues);
    if (def.id === 'values') {
      // A measure-parameter binding replaces the measure display; removing the
      // binding chip restores the (untouched) measures underneath.
      if (measuresBinding != null) {
        if (def.key !== firstValuesKey) return null;
        return (
          <Well
            key={def.key}
            def={def}
            empty={false}
            issues={wellIssues}
            accepts={acceptsInto(def.id, def.slot)}
          >
            <ParamBindingChip
              name={parameterName(measuresBinding)}
              onRemove={() => onChange(clearParamBinding(query, 'measures'))}
            />
          </Well>
        );
      }
      if (def.slot !== undefined) {
        // Slot well (scatter X/Y, KPI value/comparison, gantt Start/End):
        // presents exactly one measure index of the same wire measures array.
        const measure = query.measures[def.slot];
        // Type-aware hint (gantt Start/End): a known NON-temporal column in a
        // date-expecting well gets a soft warning instead of a hard block —
        // numeric epochs still work, so the drop stays valid.
        let typeHint: string | null = null;
        if (def.temporalHint && measure && measure.measureId == null) {
          const type = columnTypeOf(catalog, measure.table ?? '', measure.column ?? '');
          if (type !== null && !isTemporalType(type)) {
            typeHint = `${def.label} expects a date column — “${columnLabelOf(
              model,
              measure.table ?? '',
              measure.column ?? '',
            )}” is ${type}.`;
          }
        }
        return (
          <Well
            key={def.key}
            def={def}
            empty={measure === undefined}
            issues={wellIssues}
            accepts={acceptsInto(def.id, def.slot)}
            footer={
              typeHint !== null ? (
                <p className="pt-1 text-[11px] leading-snug text-[var(--rcd-status-warn)]">
                  {typeHint}
                </p>
              ) : undefined
            }
          >
            {/* Slot wells present one FIXED measure index, so their chip is a
                plain draggable — dropping one on another slot swaps them. */}
            {measure !== undefined && valueChip(measure, def.slot, false)}
          </Well>
        );
      }
      return (
        <Well
          key={def.key}
          def={def}
          empty={query.measures.length === 0}
          issues={wellIssues}
          accepts={acceptsInto(def.id)}
        >
          {/* Measure order IS column order in a table, so the open-ended
              Values well is sortable — the same drag that moves a chip to
              another well reorders it here. */}
          <SortableContext
            items={query.measures.map((_, index) => `chip-values-${index}`)}
            strategy={verticalListSortingStrategy}
          >
            {query.measures.map((measure, index) => valueChip(measure, index, true))}
          </SortableContext>
        </Well>
      );
    }

    if (def.id === 'axis') {
      // An axis binding shows INSTEAD of the axis/drill chips (and gates the
      // drill-levels UI); removing it clears only the binding, not the axis.
      if (axisBinding != null) {
        return (
          <Well
            key={def.key}
            def={def}
            empty={false}
            issues={wellIssues}
            accepts={acceptsInto(def.id)}
          >
            <ParamBindingChip
              name={parameterName(axisBinding)}
              onRemove={() => onChange(clearParamBinding(query, 'axis'))}
            />
          </Well>
        );
      }
      if (def.capacity === 'many') {
        // Table "Rows": ordered multi-field list (row 1, 2, 3, …) — stored as
        // [axis, ...drillLevels] on the wire, no drill framing in the UI.
        return (
          <Well
            key={def.key}
            def={def}
            empty={!query.axis}
            issues={wellIssues}
            accepts={acceptsInto(def.id)}
          >
            {query.axis && (
              <OrderedDimensionList
                idPrefix="row"
                well="axis"
                levels={[query.axis, ...(query.drillLevels ?? [])]}
                model={model}
                catalog={catalog}
                chipData={chipData}
                onGroup={groupingTargetForLevels(
                  [query.axis, ...(query.drillLevels ?? [])],
                  (next) =>
                    onChange({
                      ...query,
                      axis: next[0] ?? null,
                      drillLevels: next.length > 1 ? next.slice(1) : undefined,
                    }),
                )}
                onLevels={(next) =>
                  onChange({
                    ...query,
                    axis: next[0] ?? null,
                    drillLevels: next.length > 1 ? next.slice(1) : undefined,
                  })
                }
              />
            )}
          </Well>
        );
      }
      // Cartesian axis: ONE field; extra granularity lives in the explicit
      // "Drill-down levels" sub-area below.
      return (
        <Well
          key={def.key}
          def={def}
          empty={!query.axis}
          issues={wellIssues}
          accepts={acceptsInto(def.id)}
          footer={
            hasDrillSubArea(chartType) ? (
              <DrillSection
                query={query}
                model={model}
                catalog={catalog}
                chipData={chipData}
                accepts={acceptsInto('drill')}
                onGroupValues={onGroupValues}
                onChange={onChange}
                issues={(issues ?? [])
                  .filter((issue) => issue.well === 'drill')
                  .map((issue) => issue.message)}
              />
            ) : undefined
          }
        >
          {query.axis && (
            <SingleDimensionChip
              well="axis"
              dimension={query.axis}
              model={model}
              catalog={catalog}
              chipData={chipData}
              showBucket
              onBucket={(dateBucket) => onChange({ ...query, axis: { ...query.axis!, dateBucket } })}
              onGroup={groupingTargetFor(query.axis, (axis) => onChange({ ...query, axis }))}
              onRemove={() => onChange({ ...query, axis: null })}
            />
          )}
        </Well>
      );
    }

    const dimension = def.id === 'smallMultiples' ? query.smallMultiples : query.legend;
    const setDimension = (next: DimensionRef | null) =>
      onChange(
        def.id === 'smallMultiples' ? { ...query, smallMultiples: next } : { ...query, legend: next },
      );

    return (
      <Well
        key={def.key}
        def={def}
        empty={!dimension}
        issues={wellIssues}
        accepts={acceptsInto(def.id)}
      >
        {dimension && (
          <SingleDimensionChip
            well={def.id}
            dimension={dimension}
            model={model}
            catalog={catalog}
            chipData={chipData}
            showBucket={def.id === 'smallMultiples'}
            onBucket={(dateBucket) => setDimension({ ...dimension, dateBucket })}
            onGroup={groupingTargetFor(dimension, setDimension)}
            onRemove={() => setDimension(null)}
          />
        )}
      </Well>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {wellsFor(chartType).map(renderWell)}

      <Well
        def={FILTERS_WELL}
        empty={query.filters.length === 0}
        issues={issueMessagesFor(FILTERS_WELL, issues)}
        accepts={acceptsInto('filters')}
      >
        {query.filters.map((clause, index) => {
          const label = columnLabelOf(model, clause.table, clause.column);
          return (
            <DraggableChip
              key={`${clause.table}.${clause.column}.${clause.operator}-${index}`}
              id={`chip-filters-${index}`}
              data={chipData('filters', index, { kind: 'filter', clause }, label)}
            >
              {(drag) => (
                <FilterChip
                  clause={clause}
                  model={model}
                  drag={drag}
                  onEdit={() => onEditFilter(index)}
                  onRemove={() => removeFilter(index)}
                />
              )}
            </DraggableChip>
          );
        })}
      </Well>

      <SortLimitSection
        query={query}
        model={model}
        ordering={ordering}
        onChange={onChange}
        issues={(issues ?? [])
          .filter((issue) => issue.well === 'sort')
          .map((issue) => issue.message)}
      />
    </div>
  );
}

function Well({
  def,
  empty,
  children,
  footer,
  accepts,
  issues = [],
}: {
  def: WellDef;
  empty: boolean;
  children: React.ReactNode;
  /** Rendered under the drop box, inside the well group (drill sub-area). */
  footer?: React.ReactNode;
  /**
   * Would a drop here be honored? Chip moves need the query to answer that (a
   * full one-chip well can only take a chip it can SWAP with), so the caller
   * owns the predicate and the not-allowed styling below never lies.
   */
  accepts: (data: FieldDragData) => boolean;
  /** Validation messages badging THIS well: red ring + tooltip + label icon. */
  issues?: string[];
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `well-${def.key}`,
    data: { wellId: def.id, slot: def.slot },
  });

  const dragData = (active?.data.current as FieldDragData | undefined) ?? null;
  const validTarget = dragData ? accepts(dragData) : null;
  const flagged = issues.length > 0;

  const borderClass =
    validTarget === false
      ? 'border-rcd-border opacity-40'
      : isOver && validTarget === true
        ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_12%,transparent)] ring-1 ring-rcd-accent'
        : validTarget === true
          ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_5%,transparent)]'
          : empty
            ? 'border-rcd-border bg-black/[0.02] dark:bg-white/[0.03]'
            : 'border-rcd-border';

  return (
    <div>
      <div className="flex items-baseline gap-1.5 pb-0.5">
        <span className="text-xs font-medium text-rcd-text">{def.label}</span>
        {flagged && (
          <AlertTriangle
            size={11}
            aria-label={`${def.label} has issues`}
            className="shrink-0 self-center text-[var(--rcd-status-critical)]"
          />
        )}
        {def.required && empty && (
          <span className="text-[10px] font-medium text-[var(--rcd-status-warn)]">Required</span>
        )}
      </div>
      <div className="pb-1.5 text-[11px] leading-snug text-rcd-muted">{def.caption}</div>
      <div
        ref={setNodeRef}
        title={flagged ? issues.join('\n') : undefined}
        className={`flex min-h-[2.75rem] flex-col justify-center gap-1 rounded-lg border ${
          empty ? 'border-dashed' : ''
        } p-1.5 transition-colors ${borderClass} ${
          // The offending well wears a red ring while a drag is not restyling
          // it; the tooltip above carries the message list.
          flagged && validTarget === null ? 'ring-1 ring-[var(--rcd-status-critical)]' : ''
        }`}
      >
        {empty ? (
          <span className="px-1 text-xs text-rcd-muted">{def.placeholder}</span>
        ) : (
          children
        )}
      </div>
      {footer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-down levels (cartesian axis sub-area)
// ---------------------------------------------------------------------------

/**
 * Explicit drill UI under the axis well: a collapsible "Drill-down levels"
 * sub-area with numbered chips (1, 2, 3, …) and a "+ Add level" drop target.
 * Writes the SAME query.drillLevels array the old append-to-axis behavior
 * wrote — presentation only. Collapsed, the header row itself accepts drops.
 */
function DrillSection({
  query,
  model,
  catalog,
  chipData,
  accepts,
  onGroupValues,
  onChange,
  issues = [],
}: {
  query: ChartQuery;
  model: ModelDefinition;
  catalog: Catalog | null;
  chipData: (well: WellId, index: number, ref: ChipShape, label: string) => ChipDropData;
  accepts: (data: FieldDragData) => boolean;
  onGroupValues?: (target: GroupingTarget) => void;
  onChange: (query: ChartQuery) => void;
  /** Validation messages badging the drill levels (red ring + tooltip). */
  issues?: string[];
}) {
  const levels = query.drillLevels ?? [];
  const [open, setOpen] = useState(levels.length > 0);
  const flagged = issues.length > 0;

  // Auto-expand when a drop adds the first level while collapsed (never
  // fights a manual collapse — only fires when the count GROWS).
  const prevCount = useRef(levels.length);
  useEffect(() => {
    if (levels.length > prevCount.current) setOpen(true);
    prevCount.current = levels.length;
  }, [levels.length]);

  const { setNodeRef, isOver, active } = useDroppable({
    id: 'well-drill',
    data: { wellId: 'drill' },
  });

  const dragData = (active?.data.current as FieldDragData | undefined) ?? null;
  const validTarget = dragData ? accepts(dragData) : null;
  const dropClass =
    isOver && validTarget === true
      ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_12%,transparent)]'
      : validTarget === true
        ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_5%,transparent)]'
        : 'border-rcd-border';

  const setLevels = (next: DimensionRef[]) =>
    onChange({ ...query, drillLevels: next.length > 0 ? next : undefined });

  return (
    <div
      className={`mt-1.5 border-l-2 pl-2 ${
        flagged ? 'border-[var(--rcd-status-critical)]' : 'border-rcd-border'
      }`}
      title={flagged ? issues.join('\n') : undefined}
    >
      {open ? (
        <>
          <button
            type="button"
            aria-expanded
            onClick={() => setOpen(false)}
            className="flex items-center gap-1 rounded px-0.5 py-0.5 text-[11px] font-medium text-rcd-text-2 hover:text-rcd-text"
          >
            <ChevronDown size={12} className="shrink-0 text-rcd-muted" />
            Drill-down levels
            {flagged && (
              <AlertTriangle
                size={11}
                aria-label="Drill levels have issues"
                className="shrink-0 text-[var(--rcd-status-critical)]"
              />
            )}
            {levels.length > 0 && (
              <span className="rounded bg-black/10 px-1 text-[10px] font-semibold leading-4 text-rcd-text-2 dark:bg-white/10">
                {levels.length}
              </span>
            )}
          </button>
          <p className="pb-1 pl-4 pt-0.5 text-[11px] leading-snug text-rcd-muted">
            Right-click a data point to drill into the next level.
          </p>
          {levels.length > 0 && (
            <div className="pb-1 pl-4">
              <OrderedDimensionList
                idPrefix="drill"
                well="drill"
                levels={levels}
                model={model}
                catalog={catalog}
                chipData={chipData}
                onGroup={
                  onGroupValues
                    ? (index, dimension) =>
                        onGroupValues({
                          dimension,
                          label: columnLabelOf(model, dimension.table, dimension.column),
                          onApply: (grouping) =>
                            setLevels(
                              levels.map((level, i) => {
                                if (i !== index) return level;
                                const next: DimensionRef = { ...level };
                                if (grouping === null) delete next.grouping;
                                else {
                                  next.grouping = grouping;
                                  next.dateBucket = null;
                                }
                                return next;
                              }),
                            ),
                        })
                    : undefined
                }
                onLevels={setLevels}
              />
            </div>
          )}
          <div
            ref={setNodeRef}
            className={`ml-4 flex min-h-[1.9rem] items-center rounded-md border border-dashed px-2 transition-colors ${dropClass}`}
          >
            <span className="text-[11px] text-rcd-muted">+ Add level — drag a field here</span>
          </div>
        </>
      ) : (
        <button
          type="button"
          ref={setNodeRef}
          aria-expanded={false}
          onClick={() => setOpen(true)}
          title="Extra fields become drill levels: right-click a data point to drill down"
          className={`flex w-full items-center gap-1 rounded-md border border-dashed px-1.5 py-1 text-left text-[11px] font-medium text-rcd-text-2 transition-colors hover:text-rcd-text ${
            validTarget === true ? dropClass : 'border-transparent'
          }`}
        >
          <ChevronRight size={12} className="shrink-0 text-rcd-muted" />
          Drill-down levels
          {levels.length > 0 ? (
            <span className="rounded bg-black/10 px-1 text-[10px] font-semibold leading-4 text-rcd-text-2 dark:bg-white/10">
              {levels.length}
            </span>
          ) : (
            <span className="font-normal text-rcd-muted">— optional, click or drop a field</span>
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordered dimension list (table rows + drill levels)
// ---------------------------------------------------------------------------

/**
 * Numbered, reorderable dimension rows (1, 2, 3, …) — a table's "Rows" well
 * and a cartesian axis's drill levels.
 *
 * These rows used to run their OWN nested DndContext so the grips could sort
 * them in isolation from the builder's field-drag context. That isolation was
 * exactly what made "drag a row into Values" impossible: dnd-kit collides a
 * draggable only with droppables registered in the SAME provider, so a row
 * could never see a well. The list now sorts inside the BUILDER's context
 * instead — same grips, same numbering, same behavior — and ChartBuilder's
 * drag-end handler tells a reorder (dropped inside this well) from a move
 * (dropped on another well) by where the drag landed.
 */
function OrderedDimensionList({
  idPrefix,
  well,
  levels,
  model,
  catalog,
  chipData,
  onGroup,
  onLevels,
}: {
  idPrefix: string;
  /** Which well these rows ARE — 'axis' for a table's Rows, 'drill' below an axis. */
  well: WellId;
  levels: DimensionRef[];
  model: ModelDefinition;
  catalog: Catalog | null;
  chipData: (well: WellId, index: number, ref: ChipShape, label: string) => ChipDropData;
  /** Opens the grouping editor for the row at `index`. */
  onGroup?: (index: number, dimension: DimensionRef) => void;
  onLevels: (levels: DimensionRef[]) => void;
}) {
  const setLevel = (index: number, dimension: DimensionRef) =>
    onLevels(levels.map((level, i) => (i === index ? dimension : level)));

  const removeLevel = (index: number) => onLevels(levels.filter((_, i) => i !== index));

  const ids = levels.map((_, index) => `${idPrefix}-${index}`);

  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <div className="flex flex-col gap-1">
        {levels.map((level, index) => (
          <SortableLevelRow
            key={`${idPrefix}-${index}`}
            id={`${idPrefix}-${index}`}
            index={index}
            sortable={levels.length > 1}
            dimension={level}
            model={model}
            catalog={catalog}
            data={chipData(
              well,
              index,
              { kind: 'dimension', dimension: level },
              columnLabelOf(model, level.table, level.column),
            )}
            onBucket={(dateBucket) => setLevel(index, { ...level, dateBucket })}
            onGroup={onGroup ? () => onGroup(index, level) : undefined}
            onRemove={() => removeLevel(index)}
          />
        ))}
      </div>
    </SortableContext>
  );
}

function SortableLevelRow({
  id,
  index,
  sortable,
  dimension,
  model,
  catalog,
  data,
  onBucket,
  onGroup,
  onRemove,
}: {
  id: string;
  index: number;
  sortable: boolean;
  dimension: DimensionRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  data: ChipDropData;
  onBucket: (bucket: DateBucket | null) => void;
  onGroup?: () => void;
  onRemove: () => void;
}) {
  const label = columnLabelOf(model, dimension.table, dimension.column);
  return (
    <SortableChip id={id} data={data}>
      {(drag) => (
        // The ROW (number + chip) is the registered node, so the whole row
        // translates as one unit while the list re-sorts.
        <div
          ref={drag.setNodeRef}
          style={drag.style}
          className={`flex min-w-0 max-w-full items-center gap-1 ${
            drag.isDragging ? 'relative z-10 opacity-80' : ''
          }`}
        >
          <span
            aria-hidden
            className="w-3.5 shrink-0 text-center text-[10px] font-semibold tabular-nums text-rcd-muted"
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <DimensionChip
              dimension={dimension}
              model={model}
              catalog={catalog}
              showBucket
              drag={bodyDragOnly(drag)}
              onBucket={onBucket}
              onGroup={onGroup}
              onRemove={onRemove}
              leading={sortable ? <ChipGrip drag={drag} label={label} /> : undefined}
            />
          </div>
        </div>
      )}
    </SortableChip>
  );
}

// ---------------------------------------------------------------------------
// Sort / Top N
// ---------------------------------------------------------------------------

type SortChoice =
  | 'auto'
  | 'custom'
  | 'customOrder'
  | `dim-asc`
  | `dim-desc`
  | `m${number}-asc`
  | `m${number}-desc`;

const currentSortChoice = (query: ChartQuery): SortChoice => {
  const sort = query.sort ?? [];
  if (sort.length === 0) return 'auto';
  if (sort.length > 1) return 'custom';
  const rule = sort[0]!;
  if (rule.target.kind === 'dimension') {
    return rule.target.index === 0 ? (`dim-${rule.direction}` as SortChoice) : 'custom';
  }
  if (rule.target.index < query.measures.length) {
    return `m${rule.target.index}-${rule.direction}` as SortChoice;
  }
  return 'custom';
};

const sortSpecFor = (choice: SortChoice): SortSpec[] | undefined => {
  if (choice === 'auto' || choice === 'custom' || choice === 'customOrder') return undefined;
  const [target, direction] = choice.split('-') as [string, 'asc' | 'desc'];
  if (target === 'dim') return [{ target: { kind: 'dimension', index: 0 }, direction }];
  return [{ target: { kind: 'measure', index: Number(target.slice(1)) }, direction }];
};

/**
 * Plain-labeled Sort and Top N controls over the EXISTING query.sort /
 * query.limit fields (nothing new on the wire) — previously these were
 * invisible in the builder. "Highest X first" + a row limit = a Top N chart.
 *
 * "Custom order…" (when `ordering` is provided) is DISPLAY ordering, not a
 * sort rule: it writes format.categoryOrder / format.seriesOrder and leaves
 * query.sort untouched — the server order stays the base the manual order
 * reconciles against (listed-first, unlisted-append, stale-drop).
 */
function SortLimitSection({
  query,
  model,
  ordering,
  onChange,
  issues = [],
}: {
  query: ChartQuery;
  model: ModelDefinition;
  ordering?: ManualOrderInputs;
  onChange: (query: ChartQuery) => void;
  /** Sort/limit validation messages, rendered inline under the heading. */
  issues?: string[];
}) {
  // The first wire dimension is what sorting "by category" orders: the axis,
  // or (pie/donut) the slice dimension.
  const firstDimension = query.axis ?? query.legend ?? null;
  const dimLabel = firstDimension
    ? columnLabelOf(model, firstDimension.table, firstDimension.column)
    : null;
  /**
   * A measure-less passthrough table has nothing to rank BY, so the "Highest
   * … first" options are absent (the measure loop below emits none) and the
   * limit stops being a Top N — it is a plain row cap, and says so.
   */
  const measureless = query.measures.length === 0;
  const hasManual =
    (ordering?.categoryOrder?.length ?? 0) > 0 || (ordering?.seriesOrder?.length ?? 0) > 0;
  // Keeps "Custom order…" selected (lists open) before the first drag has
  // persisted anything; persisted arrays keep it selected across reopens.
  const [customOrderOpen, setCustomOrderOpen] = useState(hasManual);
  const choice: SortChoice =
    ordering && (customOrderOpen || hasManual) ? 'customOrder' : currentSortChoice(query);

  const apply = (next: SortChoice) => {
    if (next === 'customOrder') {
      setCustomOrderOpen(true);
      return;
    }
    // Leaving custom order clears the persisted arrays — a select reading
    // "A to Z" over a still-manually-ordered chart would lie.
    if (customOrderOpen || hasManual) {
      setCustomOrderOpen(false);
      ordering?.onOrderChange(undefined, undefined);
    }
    if (next === 'custom') return; // display-only marker for multi-rule specs
    onChange({ ...query, sort: sortSpecFor(next) });
  };

  const limitText = query.limit != null ? String(query.limit) : '';
  const applyLimit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange({ ...query, limit: undefined });
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return;
    onChange({ ...query, limit: Math.max(1, parsed) });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-rcd-border pt-2.5">
      {issues.length > 0 && (
        // Sort/Top-N faults have no drop box to ring, so they read inline
        // above the controls that produce them.
        <div className="flex flex-col gap-0.5">
          {issues.map((message, index) => (
            <p
              key={index}
              className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--rcd-status-critical)]"
            >
              <AlertTriangle size={11} aria-label="Sort issue" className="mt-[2px] shrink-0" />
              <span className="min-w-0 break-words">{message}</span>
            </p>
          ))}
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-rcd-text">Sort</span>
        <RcdSelect value={choice} onChange={(event) => apply(event.target.value as SortChoice)}>
          <option value="auto">Automatic</option>
          {dimLabel !== null && (
            <>
              <option value="dim-asc">{dimLabel} — A to Z / oldest first</option>
              <option value="dim-desc">{dimLabel} — Z to A / newest first</option>
            </>
          )}
          {query.measures.map((measure, index) => {
            const label = measureLabel(model, measure);
            return (
              <optgroup key={`m${index}`} label={label}>
                <option value={`m${index}-desc`}>Highest {label} first</option>
                <option value={`m${index}-asc`}>Lowest {label} first</option>
              </optgroup>
            );
          })}
          {ordering && <option value="customOrder">Custom order…</option>}
          {choice === 'custom' && <option value="custom">Custom (multiple rules)</option>}
        </RcdSelect>
      </label>

      {ordering && choice === 'customOrder' && (
        <ManualOrderEditor ordering={ordering} />
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-rcd-text">
          {measureless ? 'Row limit' : 'Top N'}
        </span>
        <div className="flex items-center gap-2">
          <RcdInput
            type="number"
            min={1}
            value={limitText}
            onChange={(event) => applyLimit(event.target.value)}
            placeholder="All rows"
            className="w-24"
            aria-label={measureless ? 'Row limit' : 'Top N row limit'}
          />
          <span className="text-[11px] leading-snug text-rcd-muted">
            {measureless
              ? 'Keep only the first N rows, in the sort order above.'
              : 'Keep only the first N rows — pick “Highest … first” above for a true Top N.'}
          </span>
        </div>
      </label>
    </div>
  );
}

/**
 * The "Custom order…" body: up to two drag lists (categories / series) whose
 * DISPLAYED order is the persisted array reconciled against the live items —
 * so it always shows exactly what the chart shows — and whose first drag
 * persists the complete list. Categories are suppressed on date axes
 * (chronology beats manual order); the series list only appears when there
 * is more than one series (single-series colorByCategory bars reorder via
 * the category list).
 */
function ManualOrderEditor({ ordering }: { ordering: ManualOrderInputs }) {
  const categoryItems = reconcileOrder(ordering.categoryOrder, ordering.categories);
  const seriesItems = reconcileOrder(ordering.seriesOrder, ordering.series);
  const showCategories = !ordering.axisIsDate && categoryItems.length > 0;
  const showSeries = seriesItems.length > 1;
  const hasManual =
    (ordering.categoryOrder?.length ?? 0) > 0 || (ordering.seriesOrder?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-rcd-border bg-black/[0.02] p-2 dark:bg-white/[0.03]">
      <p className="text-[11px] leading-snug text-rcd-muted">
        Drag to set the display order. Values not listed keep the sorted order
        and append at the end.
      </p>
      {showCategories && (
        <OrderList
          label="Categories"
          items={categoryItems}
          onReorder={(next) => ordering.onOrderChange(next, ordering.seriesOrder)}
        />
      )}
      {ordering.axisIsDate && (
        <p className="text-[11px] leading-snug text-rcd-muted">
          Date axes keep chronological order — only series can be reordered.
        </p>
      )}
      {showSeries && (
        <OrderList
          label="Series / legend"
          items={seriesItems}
          onReorder={(next) => ordering.onOrderChange(ordering.categoryOrder, next)}
        />
      )}
      {!showCategories && !showSeries && !ordering.axisIsDate && (
        <p className="text-[11px] leading-snug text-rcd-muted">
          Waiting for preview data — the current categories appear here.
        </p>
      )}
      {hasManual && (
        <button
          type="button"
          onClick={() => ordering.onOrderChange(undefined, undefined)}
          className="self-start text-[11px] font-medium text-rcd-accent hover:underline"
        >
          Reset order
        </button>
      )}
    </div>
  );
}

/**
 * One reorderable name list. A nested DndContext — REQUIRED, not stylistic:
 * the builder's outer field-drag DndContext (ChartBuilder) would otherwise
 * capture these drags (same isolation doctrine as OrderedDimensionList).
 * Sortable ids are positional (labels can collide under coarse date
 * formats); the drag emits the full reordered label list.
 */
function OrderList({
  label,
  items,
  onReorder,
}: {
  label: string;
  items: string[];
  onReorder: (items: string[]) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = items.map((_, index) => `${label}-${index}`);

  const handleDragEnd = (event: DragEndEvent) => {
    const from = ids.indexOf(String(event.active.id));
    const to = event.over ? ids.indexOf(String(event.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    onReorder(arrayMove(items, from, to));
  };

  return (
    <div>
      <span className="text-[11px] font-medium text-rcd-text-2">{label}</span>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="mt-1 flex flex-col gap-1">
            {items.map((item, index) => (
              <SortableOrderRow key={ids[index]} id={ids[index]!} label={item} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableOrderRow({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex min-w-0 max-w-full items-center gap-1 rounded-md border border-rcd-border bg-rcd-bg px-1.5 py-1 text-xs font-medium text-rcd-text ${
        isDragging ? 'relative z-10 opacity-80' : ''
      }`}
    >
      <button
        type="button"
        aria-label={`Reorder ${label}`}
        title="Drag to reorder"
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab touch-none rounded p-0.5 text-rcd-muted hover:text-rcd-text"
      >
        <GripVertical size={11} />
      </button>
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

function Chip({
  icon,
  iconKind,
  leading,
  label,
  labelContent,
  controls,
  drag,
  onRemove,
}: {
  icon?: React.ReactNode;
  /**
   * Colours the chip glyph by field TYPE — the same token the field list's row
   * used, so a field that was purple in the picker is still purple once it
   * lands in a well. That continuity is the whole reason the colour is worth
   * having: it survives the drag. An accent only; the icon shape and the label
   * still say everything the colour says.
   */
  iconKind?: FieldKind;
  /** Rendered before the icon/label (e.g. a sortable drag handle). */
  leading?: React.ReactNode;
  label: string;
  /**
   * Replaces the label span while keeping `label` as the accessible/tooltip
   * text — the value chip swaps in its inline alias input here.
   */
  labelContent?: React.ReactNode;
  controls?: React.ReactNode;
  /**
   * Makes the chip's LABEL a drag handle so the field can be moved to another
   * well without being deleted and hunted for in the field list again. Only
   * the label carries the listeners — the aggregation select, the bucket
   * select, rename and ✕ stay ordinary controls, and the 4px activation
   * distance means a plain click on the label is still just a click.
   */
  drag?: ChipDrag;
  onRemove: () => void;
}) {
  return (
    <div
      ref={drag?.setNodeRef}
      style={drag?.style}
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1 text-xs font-medium text-rcd-text ${
        drag?.isDragging ? 'relative z-10 opacity-80' : ''
      }`}
    >
      {leading}
      {icon && (
        <span
          className={iconKind ? 'shrink-0' : 'shrink-0 text-rcd-muted'}
          style={iconKind ? fieldKindStyle(iconKind) : undefined}
          title={iconKind ? fieldKindLabel(iconKind) : undefined}
        >
          {icon}
        </span>
      )}
      {labelContent ??
        (drag ? (
          <span
            {...drag.listeners}
            className="min-w-0 flex-1 cursor-grab touch-none truncate"
            title={`${label} — drag onto another well to move it`}
          >
            {label}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate" title={label}>
            {label}
          </span>
        ))}
      {controls}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="shrink-0 rounded-sm p-0.5 text-rcd-muted transition-colors hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * Field-parameter binding chip: "⟨Param: …⟩". Shown instead of the well's
 * normal chips while a binding is active; removing it clears only the binding
 * (the underlying axis/measures are untouched and reappear).
 */
function ParamBindingChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  const label = `⟨Param: ${name}⟩`;
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_8%,transparent)] px-2 py-1 text-xs text-rcd-text">
      <Variable size={12} className="shrink-0 text-rcd-accent" />
      <span className="min-w-0 flex-1 truncate font-medium" title={label}>
        {label}
      </span>
      <button
        type="button"
        aria-label={`Remove parameter binding ${name}`}
        title="Remove the parameter binding (keeps the fields underneath)"
        onClick={onRemove}
        className="shrink-0 rounded-sm p-0.5 text-rcd-muted transition-colors hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function FilterChip({
  clause,
  model,
  drag,
  onEdit,
  onRemove,
}: {
  clause: FilterClause;
  model: ModelDefinition;
  /**
   * The label button doubles as the drag handle (4px activation, so a click
   * still opens the editor). Dragging a filter onto another well moves the
   * FIELD there; the operator and values have no home outside this well, so
   * ChartBuilder confirms before letting them go.
   */
  drag?: ChipDrag;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const text = `${columnLabelOf(model, clause.table, clause.column)} · ${filterSummary(clause)}`;

  return (
    <div
      ref={drag?.setNodeRef}
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1 text-xs text-rcd-text ${
        drag?.isDragging ? 'relative z-10 opacity-80' : ''
      }`}
    >
      <Filter size={12} className="shrink-0 text-rcd-muted" />
      <button
        type="button"
        onClick={onEdit}
        {...drag?.listeners}
        title={`Edit filter: ${text}`}
        className={`min-w-0 flex-1 truncate text-left font-medium hover:text-rcd-accent ${
          drag ? 'cursor-grab touch-none' : ''
        }`}
      >
        {text}
      </button>
      <button
        type="button"
        aria-label={`Remove filter ${text}`}
        onClick={onRemove}
        className="shrink-0 rounded-sm p-0.5 text-rcd-muted transition-colors hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * A dimension chip in a well that holds exactly ONE (a cartesian axis, the
 * legend, small multiples): a plain draggable, because its well is the only
 * position it can occupy. Dropping it on an occupied one-chip well swaps.
 */
function SingleDimensionChip({
  well,
  dimension,
  model,
  catalog,
  chipData,
  showBucket,
  onBucket,
  onGroup,
  onRemove,
}: {
  well: WellId;
  dimension: DimensionRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  chipData: (well: WellId, index: number, ref: ChipShape, label: string) => ChipDropData;
  showBucket: boolean;
  onBucket: (bucket: DateBucket | null) => void;
  onGroup?: () => void;
  onRemove: () => void;
}) {
  const label = columnLabelOf(model, dimension.table, dimension.column);
  return (
    <DraggableChip
      id={`chip-${well}-0`}
      data={chipData(well, 0, { kind: 'dimension', dimension }, label)}
    >
      {(drag) => (
        <DimensionChip
          dimension={dimension}
          model={model}
          catalog={catalog}
          showBucket={showBucket}
          drag={drag}
          onBucket={onBucket}
          onGroup={onGroup}
          onRemove={onRemove}
        />
      )}
    </DraggableChip>
  );
}

function DimensionChip({
  dimension,
  model,
  catalog,
  showBucket,
  leading,
  drag,
  onBucket,
  onGroup,
  onRemove,
}: {
  dimension: DimensionRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  showBucket: boolean;
  leading?: React.ReactNode;
  drag?: ChipDrag;
  onBucket: (bucket: DateBucket | null) => void;
  /** Opens the value-grouping editor; absent = the affordance is not offered. */
  onGroup?: () => void;
  onRemove: () => void;
}) {
  const type = columnTypeOf(catalog, dimension.table, dimension.column);
  const derived = derivedFieldOf(model, dimension.table, dimension.column);
  const grouped = hasGrouping(dimension);
  // With no catalog the chip can only infer "temporal" from an existing
  // bucket; an unbucketed date then hides the select, so keep it visible
  // whenever the column type IS known to be temporal.
  //
  // TWO CHIPS NEVER GET A DATE GRAIN: a DERIVED column (already text — there
  // is no date underneath to truncate) and a GROUPED one (the grain and the
  // grouping rewrite the same expression, so offering both would let the
  // author build a spec the compiler must then reject).
  const temporal =
    derived === null &&
    !grouped &&
    (type !== null ? isTemporalType(type) : dimension.dateBucket != null);
  const label = columnLabelOf(model, dimension.table, dimension.column);
  const groupCount = grouped ? groupingLabels(dimension.grouping!).length : 0;

  return (
    <Chip
      label={label}
      icon={
        derived !== null ? (
          <Type size={12} />
        ) : type !== null ? (
          <ColumnTypeIcon type={type} />
        ) : undefined
      }
      iconKind={derived !== null ? 'text' : type !== null ? fieldKindOfColumnType(type) : undefined}
      leading={leading}
      drag={drag}
      onRemove={onRemove}
      controls={
        <>
          {showBucket && temporal && (
            <RcdSelect
              aria-label={`Date bucket for ${label}`}
              value={dimension.dateBucket ?? EXACT_DATE}
              onChange={(event) =>
                onBucket(
                  event.target.value === EXACT_DATE ? null : (event.target.value as DateBucket),
                )
              }
            >
              {DATE_BUCKETS.map((bucket) => (
                <option key={bucket.value ?? 'exact'} value={bucket.value ?? EXACT_DATE}>
                  {bucket.label}
                </option>
              ))}
            </RcdSelect>
          )}
          {onGroup !== undefined && derived === null && (
            // Beside the date grain, and for the same reason it is there: both
            // answer "what should one bar MEAN?" — a month, or a bucket of
            // values — and that question belongs on the chip, where the field
            // already is.
            <button
              type="button"
              onClick={onGroup}
              aria-label={grouped ? `Edit value grouping for ${label}` : `Group values of ${label}`}
              title={
                grouped
                  ? `${groupCount} groups — click to edit`
                  : 'Group values: show one bar per group instead of one per value'
              }
              className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-4 ${
                grouped
                  ? 'bg-[color-mix(in_srgb,var(--rcd-accent)_15%,transparent)] text-rcd-accent'
                  : 'text-rcd-muted hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10'
              }`}
            >
              <Layers size={11} className="mr-0.5 inline-block align-[-1px]" />
              {grouped ? `${groupCount} groups` : 'Group values…'}
            </button>
          )}
        </>
      }
    />
  );
}

/**
 * Quick-calculation dropdown on a value chip. The trigger doubles as the
 * active-calc badge; the menu disables date-dependent items until the axis
 * (level-0 dimension) is date-bucketed.
 */
function CalcMenu({
  measure,
  hasAxis,
  axisBucket,
  onCalc,
}: {
  measure: MeasureRef;
  hasAxis: boolean;
  axisBucket: DateBucket | null;
  onCalc: (calc: MeasureCalc | null) => void;
}) {
  // Portaled to <body> with a viewport-clamped fixed position: the wells live
  // in a scrollable column inside a transform-positioned (draggable) dialog,
  // which clips absolutely-positioned menus AND re-roots fixed ones.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const active = measure.calc ?? null;
  const items = calcMenuItems(axisBucket);
  const open = menuPos !== null;

  const toggle = () => {
    if (open) {
      setMenuPos(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 240; // w-60
    const estimatedHeight = items.length * 28 + 10;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const top =
      below + estimatedHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - estimatedHeight - 4)
        : below;
    setMenuPos({ top, left });
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Quick calculation"
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          active ? `Quick calculation: ${calcLabel(active, axisBucket)}` : 'Quick calculation'
        }
        onClick={toggle}
        className={`flex shrink-0 items-center rounded p-0.5 ${
          active
            ? 'bg-[color-mix(in_srgb,var(--rcd-accent)_20%,transparent)] px-1 text-rcd-accent ring-1 ring-inset ring-[color-mix(in_srgb,var(--rcd-accent)_40%,transparent)]'
            : 'text-rcd-muted hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10'
        }`}
      >
        {active ? (
          <span className="text-[10px] font-semibold leading-4">{calcBadge(active)}</span>
        ) : (
          <TrendingUp size={12} />
        )}
      </button>
      {menuPos &&
        createPortal(
          // The .rcd-root wrapper re-establishes theme tokens outside the tree.
          <div className="rcd-root bg-transparent">
            <div className="fixed inset-0 z-[70]" aria-hidden onClick={() => setMenuPos(null)} />
            <div
              role="menu"
              aria-label="Quick calculation"
              style={{ top: menuPos.top, left: menuPos.left }}
              className="fixed z-[71] w-60 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
            >
            {items.map((item) => {
              const disabled =
                item.calc === null
                  ? false
                  : item.calc.kind === 'runningTotal'
                    ? !hasAxis
                    : !hasAxis || axisBucket === null;
              const reason =
                item.calc?.kind === 'runningTotal' && !hasAxis
                  ? 'Requires an axis field'
                  : 'Axis must be a date bucket';
              const checked = sameCalc(active, item.calc);
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  disabled={disabled}
                  title={disabled ? reason : undefined}
                  onClick={() => {
                    onCalc(item.calc);
                    setMenuPos(null);
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                    disabled
                      ? 'cursor-default text-rcd-muted opacity-50'
                      : 'text-rcd-text hover:bg-black/5 dark:hover:bg-white/10'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {checked && <Check size={12} className="shrink-0 text-rcd-accent" />}
                </button>
              );
            })}
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * A value chip, with an INLINE RENAME. The rename writes MeasureRef.alias,
 * which the engine has always honored — QueryCompiler composes
 * "{Aggregation} of {Column}" only when alias is absent — but until 0.14.1
 * the only writer was FieldParameterDialog, so a builder user could not turn
 * "Min of Client" into "Client" without hand-editing JSON. That is precisely
 * what makes the library's own seeded passthrough tables read as
 * "Status"/"Description"/"Last Updated", and why they were unbuildable in the
 * GUI. Nothing on the wire changes.
 *
 * Clearing the box removes the alias, so the chip falls back to the composed
 * label (and the server keeps owning the real header text).
 */
function ValueChip({
  measure,
  model,
  catalog,
  hasAxis,
  axisBucket,
  leading,
  drag,
  onAggregation,
  onAlias,
  onCalc,
  onRemove,
}: {
  measure: MeasureRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  hasAxis: boolean;
  axisBucket: DateBucket | null;
  /** Reorder grip (the open-ended Values well only). */
  leading?: React.ReactNode;
  drag?: ChipDrag;
  onAggregation: (aggregation: Aggregation) => void;
  onAlias: (alias: string | undefined) => void;
  onCalc: (calc: MeasureCalc | null) => void;
  onRemove: () => void;
}) {
  /** null = not editing; a string = the in-progress alias. */
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const isModelMeasure = measure.measureId != null;
  const table = measure.table ?? '';
  const column = measure.column ?? '';
  /**
   * What the chip shows: the alias when set, otherwise the model measure's
   * name (model chips) or the bare column label (inline chips — whose
   * aggregation is its own control right beside the label).
   */
  const displayLabel = isModelMeasure
    ? measureLabel(model, measure)
    : (measure.alias ?? columnLabelOf(model, table, column));

  const commitAlias = () => {
    setAliasDraft((draft) => {
      if (draft !== null) {
        const next = draft.trim();
        onAlias(next === '' ? undefined : next);
      }
      return null;
    });
  };

  const renameButton = (
    <button
      type="button"
      aria-label={`Rename ${displayLabel}`}
      title="Rename this column — the header the chart, table and email show"
      onClick={() => setAliasDraft(measure.alias ?? '')}
      className={`shrink-0 rounded-sm p-0.5 transition-colors hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10 ${
        measure.alias ? 'text-rcd-accent' : 'text-rcd-muted'
      }`}
    >
      <Pencil size={11} />
    </button>
  );

  const aliasInput =
    aliasDraft === null ? undefined : (
      <input
        autoFocus
        aria-label={`Name for ${displayLabel}`}
        value={aliasDraft}
        placeholder={displayLabel}
        onChange={(event) => setAliasDraft(event.target.value)}
        onBlur={commitAlias}
        onKeyDown={(event) => {
          // Enter/Escape must not reach the hosting dialog (Escape closes it).
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            commitAlias();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setAliasDraft(null);
          }
        }}
        className="min-w-0 flex-1 rounded-sm border border-rcd-accent bg-rcd-surface px-1 py-0.5 text-xs font-medium text-rcd-text outline-none"
      />
    );

  const calcMenu = (
    <CalcMenu measure={measure} hasAxis={hasAxis} axisBucket={axisBucket} onCalc={onCalc} />
  );

  if (isModelMeasure) {
    return (
      <Chip
        icon={<Sigma size={12} />}
        iconKind="measure"
        label={displayLabel}
        labelContent={aliasInput}
        leading={leading}
        drag={drag}
        controls={
          <>
            {renameButton}
            {calcMenu}
          </>
        }
        onRemove={onRemove}
      />
    );
  }

  const label = displayLabel;
  const type = columnTypeOf(catalog, table, column);
  const value = measure.aggregation ?? 'sum';
  const base = aggregationOptionsFor(type);
  const options = base.includes(value) ? base : [value, ...base];

  return (
    <Chip
      label={label}
      // An INLINE aggregation is still the column you dragged here: it keeps
      // the column's own type colour rather than becoming generic "measure"
      // green, so the field is recognizable in the well it landed in.
      icon={type !== null ? <ColumnTypeIcon type={type} /> : undefined}
      iconKind={type !== null ? fieldKindOfColumnType(type) : undefined}
      labelContent={aliasInput}
      leading={leading}
      drag={drag}
      onRemove={onRemove}
      controls={
        <>
          <RcdSelect
            aria-label={`Aggregation for ${label}`}
            value={value}
            onChange={(event) => onAggregation(event.target.value as Aggregation)}
          >
            {options.map((aggregation) => (
              <option key={aggregation} value={aggregation}>
                {AGG_LABELS[aggregation]}
              </option>
            ))}
          </RcdSelect>
          {renameButton}
          {calcMenu}
        </>
      }
    />
  );
}
