// Well definitions per chart type plus the drop/click inference shared by
// FieldList, Wells, and ChartBuilder. Every chart type is live; the well
// shapes below encode each type's capacity rules (pie slices by legend, kpi
// is values-only, scatter wants exactly two measures, ...).
import {
  isNumericType,
  isTemporalType,
  tableKey,
  type Aggregation,
  type Catalog,
  type ChartQuery,
  type ChartType,
  type ColumnType,
  type DimensionRef,
  type FilterClause,
  type FilterOperator,
  type MeasureRef,
  type ModelDefinition,
} from '@recon/dashboards-core';

export type WellId = 'axis' | 'legend' | 'smallMultiples' | 'values' | 'filters';

export interface WellDef {
  id: WellId;
  label: string;
  /** 'one' wells hold a single chip (drop replaces); 'many' wells append. */
  capacity: 'one' | 'many';
  /** Max chips for a 'many' well; a drop at capacity replaces the last chip. */
  max?: number;
  hint: string;
}

/**
 * Drill-capable axis: the first chip is the axis (level 0), every further
 * dropped dimension appends to query.drillLevels below it.
 */
const DRILL_AXIS: WellDef = {
  id: 'axis',
  label: 'Axis / drill hierarchy',
  capacity: 'many',
  hint: 'Drop a column — more columns build a drill hierarchy',
};
const LEGEND: WellDef = {
  id: 'legend',
  label: 'Legend',
  capacity: 'one',
  hint: 'Drop a column to split series',
};
const VALUES: WellDef = {
  id: 'values',
  label: 'Values',
  capacity: 'many',
  hint: 'Drop measures or columns',
};

const SMALL_MULTIPLES: WellDef = {
  id: 'smallMultiples',
  label: 'Small multiples',
  capacity: 'one',
  hint: 'Drop a column to split into panels',
};

/** The filters well is universal — rendered under Values for every chart type. */
export const FILTERS_WELL: WellDef = {
  id: 'filters',
  label: 'Filters',
  capacity: 'many',
  hint: 'Drop a column to filter by',
};

/**
 * Unrestricted cartesian wells: a legend dimension AND multiple values may
 * coexist (the renderer supports legend × measures for line/area/scatter).
 * Only the stacked types constrain the combo (legend required, one measure).
 */
const CARTESIAN: readonly WellDef[] = [DRILL_AXIS, LEGEND, VALUES, SMALL_MULTIPLES];

const STACKED: readonly WellDef[] = [
  DRILL_AXIS,
  { ...LEGEND, hint: 'Drop a column to stack by (required)' },
  { ...VALUES, max: 1, hint: 'Drop one measure' },
  SMALL_MULTIPLES,
];

const RADIAL: readonly WellDef[] = [
  { ...LEGEND, hint: 'Drop a column to slice by' },
  { ...VALUES, max: 1, hint: 'Drop one measure' },
];

export const WELL_CONFIG: Record<ChartType, readonly WellDef[]> = {
  column: CARTESIAN,
  bar: CARTESIAN,
  stackedColumn: STACKED,
  stackedBar: STACKED,
  line: CARTESIAN,
  area: CARTESIAN,
  pie: RADIAL,
  donut: RADIAL,
  scatter: [
    { ...VALUES, label: 'X / Y values', max: 2, hint: 'Drop two measures — first is X, second is Y' },
    { ...LEGEND, hint: 'Optional: drop a column to color points' },
  ],
  kpi: [{ ...VALUES, max: 2, hint: 'Drop 1–2 measures' }],
  table: [
    { ...DRILL_AXIS, label: 'Rows', hint: 'Drop a column — more columns build a drill hierarchy' },
    { ...LEGEND, label: 'Columns', hint: 'Optional: drop a column to pivot' },
    VALUES,
  ],
};

export const wellsFor = (type: ChartType): readonly WellDef[] => WELL_CONFIG[type];

const hasWell = (type: ChartType, id: WellId): boolean =>
  wellsFor(type).some((well) => well.id === id);

/**
 * Types whose axis well is the multi-level drill hierarchy — every cartesian
 * type plus the table's "Rows" well (Region → Site → Priority row drilling).
 */
export const supportsDrill = (type: ChartType): boolean =>
  wellsFor(type).some((well) => well.id === 'axis' && well.capacity === 'many');

export const supportsSmallMultiples = (type: ChartType): boolean =>
  hasWell(type, 'smallMultiples');

/** Columns can land in any well; the values well converts them to countDistinct. */
export const acceptsDimension = (_well: WellId): boolean => true;

/** Measures only ever land in the values well (filters are column-based). */
export const acceptsMeasure = (well: WellId): boolean => well === 'values';

/**
 * Dashboard-level field parameter surfaced in the builder's field list. The
 * dashboard side threads these through ChartBuilder; the standalone builder
 * never provides them.
 */
export interface BuilderParameter {
  id: string;
  name: string;
  /** 'dimension' params bind to the axis; 'measure' params to the values well. */
  kind: 'dimension' | 'measure';
}

/** Drag payload carried by every field-list entry (dnd-kit `data`). */
export type FieldDragData =
  | { kind: 'column'; table: string; column: string; type: ColumnType }
  | { kind: 'measure'; measureId: string; name: string }
  | { kind: 'parameter'; parameterId: string; name: string; paramKind: 'dimension' | 'measure' };

export const canAccept = (well: WellId, data: FieldDragData): boolean => {
  if (data.kind === 'parameter') {
    return data.paramKind === 'dimension' ? well === 'axis' : well === 'values';
  }
  return data.kind === 'column' ? acceptsDimension(well) : acceptsMeasure(well);
};

const toDimension = (data: Extract<FieldDragData, { kind: 'column' }>): DimensionRef => ({
  table: data.table,
  column: data.column,
  dateBucket: isTemporalType(data.type) ? 'month' : null,
});

/**
 * Numeric columns that are really identifiers (ids, codes, keys) should not
 * default to Sum — summing ids is never meaningful. Mirrors Power BI's smart
 * default: such fields land in Values as Count instead.
 */
const looksLikeIdentifier = (column: string): boolean =>
  /(^|_)(id|key|code|num|number|no)$/i.test(column) || /^id$/i.test(column);

const toValueMeasure = (data: Exclude<FieldDragData, { kind: 'parameter' }>): MeasureRef =>
  data.kind === 'measure'
    ? { measureId: data.measureId }
    : {
        table: data.table,
        column: data.column,
        aggregation: !isNumericType(data.type)
          ? 'countDistinct'
          : looksLikeIdentifier(data.column)
            ? 'count'
            : 'sum',
      };

const sameMeasure = (a: MeasureRef, b: MeasureRef): boolean => {
  const aId = a.measureId ?? null;
  const bId = b.measureId ?? null;
  if (aId !== null || bId !== null) return aId === bId;
  return a.table === b.table && a.column === b.column && a.aggregation === b.aggregation;
};

/**
 * Applies a validated drop to the query; invalid combinations are a no-op.
 * Filters-well drops are handled by ChartBuilder (they open the editor), so
 * they are a no-op here.
 */
export const applyDrop = (
  type: ChartType,
  query: ChartQuery,
  well: WellId,
  data: FieldDragData,
): ChartQuery => {
  if (well === 'filters' || !canAccept(well, data)) return query;

  if (data.kind === 'parameter') {
    // Parameter chips bind (not replace) — the axis/measures themselves stay
    // in the spec; the dashboard runtime substitutes them at query time.
    if (data.paramKind === 'dimension' && well === 'axis') {
      return { ...query, paramBindings: { ...query.paramBindings, axis: data.parameterId } };
    }
    if (data.paramKind === 'measure' && well === 'values') {
      return { ...query, paramBindings: { ...query.paramBindings, measures: data.parameterId } };
    }
    return query;
  }

  if (well === 'values') {
    const ref = toValueMeasure(data);
    if (query.measures.some((existing) => sameMeasure(existing, ref))) return query;
    const max = wellsFor(type).find((w) => w.id === 'values')?.max ?? Number.POSITIVE_INFINITY;
    const measures =
      query.measures.length >= max
        ? [...query.measures.slice(0, max - 1), ref]
        : [...query.measures, ref];
    return { ...query, measures };
  }

  if (data.kind !== 'column') return query;
  const ref = toDimension(data);

  if (well === 'axis') {
    // Drill-capable types append further dimensions below the axis (level 0);
    // exact duplicates (same column AND bucket) are a no-op. Other types keep
    // the classic replace-on-drop behavior.
    if (supportsDrill(type) && query.axis) {
      const levels = [query.axis, ...(query.drillLevels ?? [])];
      const duplicate = levels.some(
        (level) =>
          level.table === ref.table &&
          level.column === ref.column &&
          (level.dateBucket ?? null) === (ref.dateBucket ?? null),
      );
      if (duplicate) return query;
      return { ...query, drillLevels: [...(query.drillLevels ?? []), ref] };
    }
    return { ...query, axis: ref };
  }

  if (well === 'smallMultiples') return { ...query, smallMultiples: ref };
  return { ...query, legend: ref };
};

/** Clears one param binding; the paramBindings object drops entirely once empty. */
export const clearParamBinding = (query: ChartQuery, key: 'axis' | 'measures'): ChartQuery => {
  const next = { ...query.paramBindings };
  delete next[key];
  const hasAny = next.axis != null || next.measures != null;
  return { ...query, paramBindings: hasAny ? next : undefined };
};

/** Click-to-add routing: measures/numeric → values; temporal → axis; else first free dimension well. */
export const defaultWellFor = (type: ChartType, query: ChartQuery, data: FieldDragData): WellId => {
  if (data.kind === 'parameter') return data.paramKind === 'dimension' ? 'axis' : 'values';
  if (data.kind === 'measure' || isNumericType(data.type)) return 'values';
  if (isTemporalType(data.type) && hasWell(type, 'axis')) return 'axis';
  if (hasWell(type, 'axis') && !query.axis) return 'axis';
  if (hasWell(type, 'legend')) return 'legend';
  if (hasWell(type, 'axis')) return 'axis';
  return 'values';
};

/**
 * Drops query parts the target chart type has no well for, so nothing invisible
 * lingers in the spec. Pie/donut carry a lone axis over to the legend (their
 * slice dimension) before pruning.
 */
export const normalizeQueryForType = (type: ChartType, query: ChartQuery): ChartQuery => {
  let next = query;
  if ((type === 'pie' || type === 'donut') && next.axis && !next.legend) {
    next = { ...next, legend: next.axis, axis: null };
  }
  if (!hasWell(type, 'axis') && next.axis) next = { ...next, axis: null };
  if (!hasWell(type, 'axis') && next.paramBindings?.axis != null) {
    next = clearParamBinding(next, 'axis');
  }
  if (!hasWell(type, 'legend') && next.legend) next = { ...next, legend: null };
  if (!supportsDrill(type) && next.drillLevels?.length) {
    next = { ...next, drillLevels: undefined };
  }
  if (!supportsSmallMultiples(type) && next.smallMultiples) {
    next = { ...next, smallMultiples: null };
  }
  const max = wellsFor(type).find((w) => w.id === 'values')?.max;
  if (max !== undefined && next.measures.length > max) {
    next = { ...next, measures: next.measures.slice(0, max) };
  }
  return next;
};

/** Aggregations offered for an inline value chip; null type (no catalog) offers everything. */
export const aggregationOptionsFor = (type: ColumnType | null): readonly Aggregation[] =>
  type === null || isNumericType(type)
    ? ([
        'sum',
        'avg',
        'min',
        'max',
        'stdDev',
        'variance',
        'median',
        'count',
        'countDistinct',
      ] as const)
    : (['count', 'countDistinct'] as const);

// ---------------------------------------------------------------------------
// Shared column/measure lookups
// ---------------------------------------------------------------------------

export const columnTypeOf = (
  catalog: Catalog | null,
  table: string,
  column: string,
): ColumnType | null =>
  catalog?.tables.find((t) => t.key === table)?.columns.find((c) => c.name === column)?.type ?? null;

export const columnLabelOf = (model: ModelDefinition, table: string, column: string): string => {
  const modelTable = model.tables.find((t) => tableKey(t.schema, t.name) === table);
  return modelTable?.columns?.find((c) => c.name === column)?.friendlyName ?? column;
};

/** Display label for a measure chip / series (alias > model measure name > "agg of column"). */
export const measureLabel = (model: ModelDefinition, measure: MeasureRef): string => {
  if (measure.alias) return measure.alias;
  if (measure.measureId != null) {
    return model.measures.find((m) => m.id === measure.measureId)?.name ?? 'Measure';
  }
  const label = columnLabelOf(model, measure.table ?? '', measure.column ?? '');
  return `${measure.aggregation ?? 'sum'} of ${label}`;
};

// ---------------------------------------------------------------------------
// Filter operators
// ---------------------------------------------------------------------------

const TEXT_OPS: readonly FilterOperator[] = [
  'in',
  'eq',
  'neq',
  'contains',
  'startsWith',
  'isNull',
  'notNull',
];
const NUMERIC_OPS: readonly FilterOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
  'notNull',
];
const TEMPORAL_OPS: readonly FilterOperator[] = ['between', 'gte', 'lte', 'eq', 'isNull', 'notNull'];
const BOOLEAN_OPS: readonly FilterOperator[] = ['eq', 'isNull', 'notNull'];
const UUID_OPS: readonly FilterOperator[] = ['in', 'eq', 'neq', 'isNull', 'notNull'];
const FALLBACK_OPS: readonly FilterOperator[] = [
  'eq',
  'neq',
  'in',
  'contains',
  'startsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
  'notNull',
];

/** Operators offered for a filter on a column of the given type. */
export const operatorsFor = (type: ColumnType | null): readonly FilterOperator[] => {
  if (type === null) return FALLBACK_OPS;
  if (isNumericType(type)) return NUMERIC_OPS;
  if (isTemporalType(type)) return TEMPORAL_OPS;
  if (type === 'boolean') return BOOLEAN_OPS;
  if (type === 'uuid') return UUID_OPS;
  return TEXT_OPS;
};

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: '=',
  neq: '≠',
  in: 'one of',
  notIn: 'not one of',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  contains: 'contains',
  startsWith: 'starts with',
  isNull: 'is null',
  notNull: 'is not null',
};

/** Chip summary: "operator" plus a compact value rendering. */
export const filterSummary = (clause: FilterClause): string => {
  const op = OPERATOR_LABELS[clause.operator];
  switch (clause.operator) {
    case 'isNull':
    case 'notNull':
      return op;
    case 'between':
      return `${op} ${String(clause.values[0] ?? '')} and ${String(clause.values[1] ?? '')}`;
    case 'in':
    case 'notIn':
      return clause.values.length <= 2
        ? `${op} ${clause.values.map(String).join(', ')}`
        : `${op} ${clause.values.length} values`;
    default:
      return `${op} ${String(clause.values[0] ?? '')}`;
  }
};
