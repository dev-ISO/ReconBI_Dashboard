// Well definitions per chart type plus the drop/click inference shared by
// FieldList, Wells, and ChartBuilder. Only 'column' is fully wired for the
// slice; every other chart type reuses the same well shape so the builder UI
// stays stable when new types light up.
import {
  isNumericType,
  isTemporalType,
  type Aggregation,
  type ChartQuery,
  type ChartType,
  type ColumnType,
  type DimensionRef,
  type MeasureRef,
} from '@recon/dashboards-core';

export type WellId = 'axis' | 'legend' | 'values';

export interface WellDef {
  id: WellId;
  label: string;
  /** 'one' wells hold a single chip (drop replaces); 'many' wells append. */
  capacity: 'one' | 'many';
  hint: string;
}

const DEFAULT_WELLS: readonly WellDef[] = [
  { id: 'axis', label: 'Axis', capacity: 'one', hint: 'Drop a column' },
  { id: 'legend', label: 'Legend', capacity: 'one', hint: 'Drop a column to split series' },
  { id: 'values', label: 'Values', capacity: 'many', hint: 'Drop measures or columns' },
];

export const WELL_CONFIG: Record<ChartType, readonly WellDef[]> = {
  column: DEFAULT_WELLS,
  bar: DEFAULT_WELLS,
  stackedColumn: DEFAULT_WELLS,
  stackedBar: DEFAULT_WELLS,
  line: DEFAULT_WELLS,
  area: DEFAULT_WELLS,
  pie: DEFAULT_WELLS,
  donut: DEFAULT_WELLS,
  scatter: DEFAULT_WELLS,
  kpi: DEFAULT_WELLS,
  table: DEFAULT_WELLS,
};

export const wellsFor = (type: ChartType): readonly WellDef[] => WELL_CONFIG[type];

/** Dimensions (columns) can land anywhere: the values well converts them to countDistinct. */
export const acceptsDimension = (well: WellId): boolean =>
  well === 'axis' || well === 'legend' || well === 'values';

/** Measures only ever land in the values well. */
export const acceptsMeasure = (well: WellId): boolean => well === 'values';

/** Drag payload carried by every field-list entry (dnd-kit `data`). */
export type FieldDragData =
  | { kind: 'column'; table: string; column: string; type: ColumnType }
  | { kind: 'measure'; measureId: string; name: string };

export const canAccept = (well: WellId, data: FieldDragData): boolean =>
  data.kind === 'column' ? acceptsDimension(well) : acceptsMeasure(well);

const toDimension = (data: Extract<FieldDragData, { kind: 'column' }>): DimensionRef => ({
  table: data.table,
  column: data.column,
  dateBucket: isTemporalType(data.type) ? 'month' : null,
});

const toValueMeasure = (data: FieldDragData): MeasureRef =>
  data.kind === 'measure'
    ? { measureId: data.measureId }
    : {
        table: data.table,
        column: data.column,
        aggregation: isNumericType(data.type) ? 'sum' : 'countDistinct',
      };

const sameMeasure = (a: MeasureRef, b: MeasureRef): boolean => {
  const aId = a.measureId ?? null;
  const bId = b.measureId ?? null;
  if (aId !== null || bId !== null) return aId === bId;
  return a.table === b.table && a.column === b.column && a.aggregation === b.aggregation;
};

/** Applies a validated drop to the query; invalid combinations are a no-op. */
export const applyDrop = (query: ChartQuery, well: WellId, data: FieldDragData): ChartQuery => {
  if (!canAccept(well, data)) return query;

  if (well === 'values') {
    const ref = toValueMeasure(data);
    if (query.measures.some((existing) => sameMeasure(existing, ref))) return query;
    return { ...query, measures: [...query.measures, ref] };
  }

  if (data.kind !== 'column') return query;
  const ref = toDimension(data);
  return well === 'axis' ? { ...query, axis: ref } : { ...query, legend: ref };
};

/** Click-to-add routing: measures/numeric → values; temporal → axis; else axis-then-legend. */
export const defaultWellFor = (query: ChartQuery, data: FieldDragData): WellId => {
  if (data.kind === 'measure' || isNumericType(data.type)) return 'values';
  if (isTemporalType(data.type)) return 'axis';
  return query.axis ? 'legend' : 'axis';
};

/** Aggregations offered for an inline value chip; null type (no catalog) offers everything. */
export const aggregationOptionsFor = (type: ColumnType | null): readonly Aggregation[] =>
  type === null || isNumericType(type)
    ? (['sum', 'avg', 'min', 'max', 'count', 'countDistinct'] as const)
    : (['count', 'countDistinct'] as const);
