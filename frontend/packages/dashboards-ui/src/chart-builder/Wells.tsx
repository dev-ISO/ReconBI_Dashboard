import { useDroppable } from '@dnd-kit/core';
import { Sigma, X } from 'lucide-react';
import {
  isTemporalType,
  tableKey,
  type Aggregation,
  type Catalog,
  type ChartQuery,
  type ChartType,
  type ColumnType,
  type DateBucket,
  type DimensionRef,
  type MeasureRef,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { RcdSelect } from '../primitives';
import {
  aggregationOptionsFor,
  canAccept,
  wellsFor,
  type FieldDragData,
  type WellDef,
} from './wellConfig';

export interface WellsProps {
  chartType: ChartType;
  query: ChartQuery;
  model: ModelDefinition;
  catalog: Catalog | null;
  onChange: (query: ChartQuery) => void;
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
  count: 'Count',
  countDistinct: 'Distinct count',
};

const columnTypeOf = (catalog: Catalog | null, table: string, column: string): ColumnType | null =>
  catalog?.tables.find((t) => t.key === table)?.columns.find((c) => c.name === column)?.type ?? null;

const columnLabelOf = (model: ModelDefinition, table: string, column: string): string => {
  const modelTable = model.tables.find((t) => tableKey(t.schema, t.name) === table);
  return modelTable?.columns?.find((c) => c.name === column)?.friendlyName ?? column;
};

/** Axis / Legend / Values drop targets with chip editing for the open query. */
export function Wells({ chartType, query, model, catalog, onChange }: WellsProps) {
  const removeMeasure = (index: number) =>
    onChange({ ...query, measures: query.measures.filter((_, i) => i !== index) });

  const setAggregation = (index: number, aggregation: Aggregation) =>
    onChange({
      ...query,
      measures: query.measures.map((m, i) => (i === index ? { ...m, aggregation } : m)),
    });

  const renderWell = (def: WellDef) => {
    if (def.id === 'values') {
      return (
        <Well key={def.id} def={def} empty={query.measures.length === 0}>
          {query.measures.map((measure, index) => (
            <ValueChip
              key={`${measure.measureId ?? `${measure.table ?? ''}.${measure.column ?? ''}.${measure.aggregation ?? ''}`}-${index}`}
              measure={measure}
              model={model}
              catalog={catalog}
              onAggregation={(aggregation) => setAggregation(index, aggregation)}
              onRemove={() => removeMeasure(index)}
            />
          ))}
        </Well>
      );
    }

    const dimension = def.id === 'axis' ? query.axis : query.legend;
    const setDimension = (next: DimensionRef | null) =>
      onChange(def.id === 'axis' ? { ...query, axis: next } : { ...query, legend: next });

    return (
      <Well key={def.id} def={def} empty={!dimension}>
        {dimension && (
          <DimensionChip
            dimension={dimension}
            model={model}
            catalog={catalog}
            showBucket={def.id === 'axis'}
            onBucket={(dateBucket) => setDimension({ ...dimension, dateBucket })}
            onRemove={() => setDimension(null)}
          />
        )}
      </Well>
    );
  };

  return <div className="flex flex-col gap-2.5">{wellsFor(chartType).map(renderWell)}</div>;
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
        ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_12%,transparent)]'
        : validTarget === true
          ? 'border-rcd-accent'
          : 'border-rcd-border';

  return (
    <div>
      <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
        {def.label}
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[2.75rem] flex-col justify-center gap-1 rounded-md border ${
          empty ? 'border-dashed' : ''
        } p-1.5 transition-colors ${borderClass}`}
      >
        {empty ? <span className="px-1 text-xs text-rcd-muted">{def.hint}</span> : children}
      </div>
    </div>
  );
}

function Chip({
  icon,
  label,
  controls,
  onRemove,
}: {
  icon?: React.ReactNode;
  label: string;
  controls?: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-rcd-border bg-rcd-bg px-2 py-1 text-xs text-rcd-text">
      {icon && <span className="shrink-0 text-rcd-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate font-medium" title={label}>
        {label}
      </span>
      {controls}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 text-rcd-muted hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10"
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
  onBucket,
  onRemove,
}: {
  dimension: DimensionRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  showBucket: boolean;
  onBucket: (bucket: DateBucket) => void;
  onRemove: () => void;
}) {
  const type = columnTypeOf(catalog, dimension.table, dimension.column);
  const temporal = type !== null ? isTemporalType(type) : dimension.dateBucket != null;
  const label = columnLabelOf(model, dimension.table, dimension.column);

  return (
    <Chip
      label={label}
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

function ValueChip({
  measure,
  model,
  catalog,
  onAggregation,
  onRemove,
}: {
  measure: MeasureRef;
  model: ModelDefinition;
  catalog: Catalog | null;
  onAggregation: (aggregation: Aggregation) => void;
  onRemove: () => void;
}) {
  if (measure.measureId != null) {
    const name =
      model.measures.find((m) => m.id === measure.measureId)?.name ?? 'Unknown measure';
    return <Chip icon={<Sigma size={12} />} label={name} onRemove={onRemove} />;
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
      }
    />
  );
}
