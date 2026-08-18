import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  PointerSensor,
  closestCenter,
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
  Check,
  ChevronDown,
  ChevronRight,
  Filter,
  GripVertical,
  Sigma,
  TrendingUp,
  Variable,
  X,
} from 'lucide-react';
import {
  isTemporalType,
  reconcileOrder,
  type Aggregation,
  type Catalog,
  type ChartQuery,
  type ChartType,
  type DateBucket,
  type DimensionRef,
  type FilterClause,
  type MeasureCalc,
  type MeasureRef,
  type ModelDefinition,
  type SortSpec,
} from '@recon/dashboards-core';
import { RcdInput, RcdSelect } from '../primitives';
import {
  aggregationOptionsFor,
  canAccept,
  clearParamBinding,
  columnLabelOf,
  columnTypeOf,
  FILTERS_WELL,
  filterSummary,
  hasDrillSubArea,
  measureLabel,
  wellsFor,
  type BuilderParameter,
  type FieldDragData,
  type WellDef,
} from './wellConfig';

export interface WellsProps {
  chartType: ChartType;
  query: ChartQuery;
  model: ModelDefinition;
  catalog: Catalog | null;
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
}

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

const DATE_BUCKETS: { value: DateBucket; label: string }[] = [
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
  ordering,
}: WellsProps) {
  const removeMeasure = (index: number) =>
    onChange({ ...query, measures: query.measures.filter((_, i) => i !== index) });

  const setAggregation = (index: number, aggregation: Aggregation) =>
    onChange({
      ...query,
      measures: query.measures.map((m, i) => (i === index ? { ...m, aggregation } : m)),
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

  const axisBinding = query.paramBindings?.axis ?? null;
  const measuresBinding = query.paramBindings?.measures ?? null;
  const parameterName = (id: string) =>
    parameters?.find((parameter) => parameter.id === id)?.name ?? id;

  const valueChip = (measure: MeasureRef, index: number) => (
    <ValueChip
      key={`${measure.measureId ?? `${measure.table ?? ''}.${measure.column ?? ''}.${measure.aggregation ?? ''}`}-${index}`}
      measure={measure}
      model={model}
      catalog={catalog}
      hasAxis={hasAxis}
      axisBucket={axisBucket}
      onAggregation={(aggregation) => setAggregation(index, aggregation)}
      onCalc={(calc) => setCalc(index, calc)}
      onRemove={() => removeMeasure(index)}
    />
  );

  /** True for the first values well only — the binding chip renders once. */
  const firstValuesKey = wellsFor(chartType).find((w) => w.id === 'values')?.key;

  const renderWell = (def: WellDef) => {
    if (def.id === 'values') {
      // A measure-parameter binding replaces the measure display; removing the
      // binding chip restores the (untouched) measures underneath.
      if (measuresBinding != null) {
        if (def.key !== firstValuesKey) return null;
        return (
          <Well key={def.key} def={def} empty={false}>
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
            footer={
              typeHint !== null ? (
                <p className="pt-1 text-[11px] leading-snug text-[var(--rcd-status-warn)]">
                  {typeHint}
                </p>
              ) : undefined
            }
          >
            {measure !== undefined && valueChip(measure, def.slot)}
          </Well>
        );
      }
      return (
        <Well key={def.key} def={def} empty={query.measures.length === 0}>
          {query.measures.map(valueChip)}
        </Well>
      );
    }

    if (def.id === 'axis') {
      // An axis binding shows INSTEAD of the axis/drill chips (and gates the
      // drill-levels UI); removing it clears only the binding, not the axis.
      if (axisBinding != null) {
        return (
          <Well key={def.key} def={def} empty={false}>
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
          <Well key={def.key} def={def} empty={!query.axis}>
            {query.axis && (
              <OrderedDimensionList
                idPrefix="row"
                levels={[query.axis, ...(query.drillLevels ?? [])]}
                model={model}
                catalog={catalog}
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
          footer={
            hasDrillSubArea(chartType) ? (
              <DrillSection query={query} model={model} catalog={catalog} onChange={onChange} />
            ) : undefined
          }
        >
          {query.axis && (
            <DimensionChip
              dimension={query.axis}
              model={model}
              catalog={catalog}
              showBucket
              onBucket={(dateBucket) => onChange({ ...query, axis: { ...query.axis!, dateBucket } })}
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
      <Well key={def.key} def={def} empty={!dimension}>
        {dimension && (
          <DimensionChip
            dimension={dimension}
            model={model}
            catalog={catalog}
            showBucket={def.id === 'smallMultiples'}
            onBucket={(dateBucket) => setDimension({ ...dimension, dateBucket })}
            onRemove={() => setDimension(null)}
          />
        )}
      </Well>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {wellsFor(chartType).map(renderWell)}

      <Well def={FILTERS_WELL} empty={query.filters.length === 0}>
        {query.filters.map((clause, index) => (
          <FilterChip
            key={`${clause.table}.${clause.column}.${clause.operator}-${index}`}
            clause={clause}
            model={model}
            onEdit={() => onEditFilter(index)}
            onRemove={() => removeFilter(index)}
          />
        ))}
      </Well>

      <SortLimitSection query={query} model={model} ordering={ordering} onChange={onChange} />
    </div>
  );
}

function Well({
  def,
  empty,
  children,
  footer,
}: {
  def: WellDef;
  empty: boolean;
  children: React.ReactNode;
  /** Rendered under the drop box, inside the well group (drill sub-area). */
  footer?: React.ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `well-${def.key}`,
    data: { wellId: def.id, slot: def.slot },
  });

  const dragData = (active?.data.current as FieldDragData | undefined) ?? null;
  const validTarget = dragData ? canAccept(def.id, dragData) : null;

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
        {def.required && empty && (
          <span className="text-[10px] font-medium text-[var(--rcd-status-warn)]">Required</span>
        )}
      </div>
      <div className="pb-1.5 text-[11px] leading-snug text-rcd-muted">{def.caption}</div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[2.75rem] flex-col justify-center gap-1 rounded-lg border ${
          empty ? 'border-dashed' : ''
        } p-1.5 transition-colors ${borderClass}`}
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
  onChange,
}: {
  query: ChartQuery;
  model: ModelDefinition;
  catalog: Catalog | null;
  onChange: (query: ChartQuery) => void;
}) {
  const levels = query.drillLevels ?? [];
  const [open, setOpen] = useState(levels.length > 0);

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
  const validTarget = dragData ? canAccept('drill', dragData) : null;
  const dropClass =
    isOver && validTarget === true
      ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_12%,transparent)]'
      : validTarget === true
        ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_5%,transparent)]'
        : 'border-rcd-border';

  const setLevels = (next: DimensionRef[]) =>
    onChange({ ...query, drillLevels: next.length > 0 ? next : undefined });

  return (
    <div className="mt-1.5 border-l-2 border-rcd-border pl-2">
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
                levels={levels}
                model={model}
                catalog={catalog}
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
 * Numbered, reorderable dimension rows (1, 2, 3, …). A nested DndContext
 * (isolated from the builder's field-drag context) makes the rows sortable
 * via their grip handles.
 */
function OrderedDimensionList({
  idPrefix,
  levels,
  model,
  catalog,
  onLevels,
}: {
  idPrefix: string;
  levels: DimensionRef[];
  model: ModelDefinition;
  catalog: Catalog | null;
  onLevels: (levels: DimensionRef[]) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const setLevel = (index: number, dimension: DimensionRef) =>
    onLevels(levels.map((level, i) => (i === index ? dimension : level)));

  const removeLevel = (index: number) => onLevels(levels.filter((_, i) => i !== index));

  const ids = levels.map((_, index) => `${idPrefix}-${index}`);

  const handleDragEnd = (event: DragEndEvent) => {
    const from = ids.indexOf(String(event.active.id));
    const to = event.over ? ids.indexOf(String(event.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    onLevels(arrayMove(levels, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
              onBucket={(dateBucket) => setLevel(index, { ...level, dateBucket })}
              onRemove={() => removeLevel(index)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableLevelRow({
  id,
  index,
  sortable,
  dimension,
  model,
  catalog,
  onBucket,
  onRemove,
}: {
  id: string;
  index: number;
  sortable: boolean;
  dimension: DimensionRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  onBucket: (bucket: DateBucket) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex min-w-0 max-w-full items-center gap-1 ${isDragging ? 'relative z-10 opacity-80' : ''}`}
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
          onBucket={onBucket}
          onRemove={onRemove}
          leading={
            sortable ? (
              <button
                type="button"
                aria-label={`Reorder level ${index + 1}`}
                title="Drag to reorder"
                {...attributes}
                {...listeners}
                className="-ml-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-rcd-muted hover:text-rcd-text"
              >
                <GripVertical size={11} />
              </button>
            ) : undefined
          }
        />
      </div>
    </div>
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
}: {
  query: ChartQuery;
  model: ModelDefinition;
  ordering?: ManualOrderInputs;
  onChange: (query: ChartQuery) => void;
}) {
  // The first wire dimension is what sorting "by category" orders: the axis,
  // or (pie/donut) the slice dimension.
  const firstDimension = query.axis ?? query.legend ?? null;
  const dimLabel = firstDimension
    ? columnLabelOf(model, firstDimension.table, firstDimension.column)
    : null;
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
        <span className="text-xs font-medium text-rcd-text">Top N</span>
        <div className="flex items-center gap-2">
          <RcdInput
            type="number"
            min={1}
            value={limitText}
            onChange={(event) => applyLimit(event.target.value)}
            placeholder="All rows"
            className="w-24"
            aria-label="Top N row limit"
          />
          <span className="text-[11px] leading-snug text-rcd-muted">
            Keep only the first N rows — pick “Highest … first” above for a true Top N.
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
  leading,
  label,
  controls,
  onRemove,
}: {
  icon?: React.ReactNode;
  /** Rendered before the icon/label (e.g. a sortable drag handle). */
  leading?: React.ReactNode;
  label: string;
  controls?: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1 text-xs font-medium text-rcd-text">
      {leading}
      {icon && <span className="shrink-0 text-rcd-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
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
  onEdit,
  onRemove,
}: {
  clause: FilterClause;
  model: ModelDefinition;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const text = `${columnLabelOf(model, clause.table, clause.column)} · ${filterSummary(clause)}`;

  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1 text-xs text-rcd-text">
      <Filter size={12} className="shrink-0 text-rcd-muted" />
      <button
        type="button"
        onClick={onEdit}
        title={`Edit filter: ${text}`}
        className="min-w-0 flex-1 truncate text-left font-medium hover:text-rcd-accent"
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

function DimensionChip({
  dimension,
  model,
  catalog,
  showBucket,
  leading,
  onBucket,
  onRemove,
}: {
  dimension: DimensionRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  showBucket: boolean;
  leading?: React.ReactNode;
  onBucket: (bucket: DateBucket) => void;
  onRemove: () => void;
}) {
  const type = columnTypeOf(catalog, dimension.table, dimension.column);
  const temporal = type !== null ? isTemporalType(type) : dimension.dateBucket != null;
  const label = columnLabelOf(model, dimension.table, dimension.column);

  return (
    <Chip
      label={label}
      leading={leading}
      onRemove={onRemove}
      controls={
        showBucket && temporal ? (
          <RcdSelect
            aria-label={`Date bucket for ${label}`}
            value={dimension.dateBucket ?? 'month'}
            onChange={(event) => onBucket(event.target.value as DateBucket)}
          >
            {DATE_BUCKETS.map((bucket) => (
              <option key={bucket.value} value={bucket.value}>
                {bucket.label}
              </option>
            ))}
          </RcdSelect>
        ) : undefined
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

function ValueChip({
  measure,
  model,
  catalog,
  hasAxis,
  axisBucket,
  onAggregation,
  onCalc,
  onRemove,
}: {
  measure: MeasureRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  hasAxis: boolean;
  axisBucket: DateBucket | null;
  onAggregation: (aggregation: Aggregation) => void;
  onCalc: (calc: MeasureCalc | null) => void;
  onRemove: () => void;
}) {
  const calcMenu = (
    <CalcMenu measure={measure} hasAxis={hasAxis} axisBucket={axisBucket} onCalc={onCalc} />
  );

  if (measure.measureId != null) {
    const name = measureLabel(model, measure);
    return <Chip icon={<Sigma size={12} />} label={name} controls={calcMenu} onRemove={onRemove} />;
  }

  const table = measure.table ?? '';
  const column = measure.column ?? '';
  const label = columnLabelOf(model, table, column);
  const type = columnTypeOf(catalog, table, column);
  const value = measure.aggregation ?? 'sum';
  const base = aggregationOptionsFor(type);
  const options = base.includes(value) ? base : [value, ...base];

  return (
    <Chip
      label={label}
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
          {calcMenu}
        </>
      }
    />
  );
}
