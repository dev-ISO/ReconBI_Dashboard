import { useRef, useState } from 'react';
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
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, Filter, GripVertical, Sigma, TrendingUp, Variable, X } from 'lucide-react';
import {
  isTemporalType,
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
} from '@recon/dashboards-core';
import { RcdSelect } from '../primitives';
import {
  aggregationOptionsFor,
  canAccept,
  clearParamBinding,
  columnLabelOf,
  columnTypeOf,
  FILTERS_WELL,
  filterSummary,
  measureLabel,
  supportsDrill,
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

/** Per-type wells (axis/legend/values/small multiples) plus the universal Filters well. */
export function Wells({
  chartType,
  query,
  model,
  catalog,
  parameters,
  onChange,
  onEditFilter,
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

  const renderWell = (def: WellDef) => {
    if (def.id === 'values') {
      // A measure-parameter binding replaces the measure list display; removing
      // the binding chip restores the (untouched) measures underneath.
      if (measuresBinding != null) {
        return (
          <Well key={def.id} def={def} empty={false}>
            <ParamBindingChip
              name={parameterName(measuresBinding)}
              onRemove={() => onChange(clearParamBinding(query, 'measures'))}
            />
          </Well>
        );
      }
      return (
        <Well key={def.id} def={def} empty={query.measures.length === 0}>
          {query.measures.map((measure, index) => (
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
          ))}
        </Well>
      );
    }

    if (def.id === 'axis' && supportsDrill(chartType)) {
      // An axis binding shows INSTEAD of the axis/drill chips (and gates the
      // drill-levels UI); removing it clears only the binding, not the axis.
      if (axisBinding != null) {
        return (
          <Well key={def.id} def={def} empty={false}>
            <ParamBindingChip
              name={parameterName(axisBinding)}
              onRemove={() => onChange(clearParamBinding(query, 'axis'))}
            />
          </Well>
        );
      }
      return (
        <Well key={def.id} def={def} empty={!query.axis}>
          {query.axis && (
            <HierarchyChips query={query} model={model} catalog={catalog} onChange={onChange} />
          )}
        </Well>
      );
    }

    const dimension =
      def.id === 'axis'
        ? query.axis
        : def.id === 'smallMultiples'
          ? query.smallMultiples
          : query.legend;
    const setDimension = (next: DimensionRef | null) =>
      onChange(
        def.id === 'axis'
          ? { ...query, axis: next }
          : def.id === 'smallMultiples'
            ? { ...query, smallMultiples: next }
            : { ...query, legend: next },
      );

    return (
      <Well key={def.id} def={def} empty={!dimension}>
        {dimension && (
          <DimensionChip
            dimension={dimension}
            model={model}
            catalog={catalog}
            showBucket={def.id === 'axis' || def.id === 'smallMultiples'}
            onBucket={(dateBucket) => setDimension({ ...dimension, dateBucket })}
            onRemove={() => setDimension(null)}
          />
        )}
      </Well>
    );
  };

  return (
    <div className="flex flex-col gap-2.5">
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
    </div>
  );
}

function Well({ def, empty, children }: { def: WellDef; empty: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `well-${def.id}`,
    data: { wellId: def.id },
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
      <div className="pb-1.5 text-xs font-medium text-rcd-muted">{def.label}</div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[2.75rem] flex-col justify-center gap-1 rounded-lg border ${
          empty ? 'border-dashed' : ''
        } p-1.5 transition-colors ${borderClass}`}
      >
        {empty ? <span className="px-1 text-xs text-rcd-muted">{def.hint}</span> : children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Axis / drill hierarchy
// ---------------------------------------------------------------------------

/**
 * Ordered hierarchy chips: [axis, ...drillLevels] joined by "▸". A nested
 * DndContext (isolated from the builder's field-drag context) makes the chips
 * sortable via their grip handles; dropping writes axis + drillLevels back so
 * the first chip is always the level-0 axis.
 */
function HierarchyChips({
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
  const levels: DimensionRef[] = [
    ...(query.axis ? [query.axis] : []),
    ...(query.drillLevels ?? []),
  ];

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const setLevels = (next: DimensionRef[]) =>
    onChange({
      ...query,
      axis: next[0] ?? null,
      drillLevels: next.length > 1 ? next.slice(1) : undefined,
    });

  const setLevel = (index: number, dimension: DimensionRef) =>
    setLevels(levels.map((level, i) => (i === index ? dimension : level)));

  const removeLevel = (index: number) => setLevels(levels.filter((_, i) => i !== index));

  const ids = levels.map((_, index) => `level-${index}`);

  const handleDragEnd = (event: DragEndEvent) => {
    const from = ids.indexOf(String(event.active.id));
    const to = event.over ? ids.indexOf(String(event.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    setLevels(arrayMove(levels, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className="flex flex-wrap items-center gap-1">
          {levels.map((level, index) => (
            <SortableLevelChip
              key={`level-${index}`}
              id={`level-${index}`}
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

function SortableLevelChip({
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
      {index > 0 && (
        <span aria-hidden className="text-[10px] text-rcd-muted">
          ▸
        </span>
      )}
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
              aria-label={`Reorder drill level ${index + 1}`}
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
