// Well definitions per chart type plus the drop/click inference shared by
// FieldList, Wells, and ChartBuilder. Every chart type is live; the well
// shapes below encode each type's capacity rules (pie slices by legend, kpi
// is values-only, scatter wants exactly two measures, ...).
import {
  columnLabelOf,
  isNumericType,
  isTemporalType,
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

/**
 * 'drill' is a presentation-only target: the "+ Add level" sub-area under a
 * cartesian X/Y axis well. It writes query.drillLevels — the same array the
 * old append-to-axis behavior wrote — so specs are byte-identical.
 */
export type WellId = 'axis' | 'drill' | 'legend' | 'smallMultiples' | 'values' | 'filters';

export interface WellDef {
  /** Semantic target — decides which ChartQuery part a drop writes. */
  id: WellId;
  /** Unique per chart type; the droppable id + React key ('values-x', …). */
  key: string;
  label: string;
  /** 'one' wells hold a single chip (drop replaces); 'many' wells append. */
  capacity: 'one' | 'many';
  /** Max chips for a 'many' well; a drop at capacity replaces the last chip. */
  max?: number;
  /**
   * For 'values' wells that present exactly ONE measure index (scatter X/Y,
   * KPI value/comparison). The well displays query.measures[slot]; a drop
   * replaces that index (or appends when the list is still shorter).
   */
  slot?: number;
  /** One-line muted helper under the label explaining what to drop. */
  caption: string;
  /** Empty-state text inside the drop box. */
  placeholder: string;
  /** Needed for a meaningful chart — empty required wells get a subtle tag. */
  required?: boolean;
  /**
   * Aggregation a COLUMN drop into this slot well defaults to, overriding the
   * type-based default (gantt Start = Min, End = Max — the engine allows
   * Min/Max on temporal columns and returns ISO strings).
   */
  defaultAggregation?: Aggregation;
  /**
   * The well semantically expects a date/timestamp column; the Wells UI shows
   * a type-aware hint when a non-temporal column lands here.
   */
  temporalHint?: boolean;
}

const PLACEHOLDER = 'Drag a field here, or click + in the field list';
const PLACEHOLDER_MEASURE = 'Drag a number field here, or click + in the field list';

const def = (
  id: WellId,
  key: string,
  label: string,
  capacity: 'one' | 'many',
  caption: string,
  extra?: Partial<WellDef>,
): WellDef => ({
  id,
  key,
  label,
  capacity,
  caption,
  placeholder: id === 'values' ? PLACEHOLDER_MEASURE : PLACEHOLDER,
  ...extra,
});

/** The filters well is universal — rendered under the type wells for every chart. */
export const FILTERS_WELL: WellDef = def(
  'filters',
  'filters',
  'Filters on this chart',
  'many',
  'Only affects this visual — page and dashboard filters stack on top',
);

const SMALL_MULTIPLES = def(
  'smallMultiples',
  'smallMultiples',
  'Small multiples',
  'one',
  'Optional: repeat the chart as one mini-panel per value',
);

/** Vertical cartesians: category along the bottom, values up the side. */
const COLUMNAR = (stacked: boolean): readonly WellDef[] => [
  def('axis', 'axis', 'X axis', 'one', 'Category or date along the bottom', { required: true }),
  def('values', 'values', 'Y axis — values', 'many', 'What to measure — numbers default to Sum', {
    required: true,
    ...(stacked ? { max: 1 } : null),
  }),
  def(
    'legend',
    'legend',
    'Legend',
    'one',
    stacked ? 'Stack by this field — each value is a colored segment' : 'Optional: one line/series per value of this field',
    stacked ? { required: true } : undefined,
  ),
  SMALL_MULTIPLES,
];

/** Horizontal cartesians: category down the side, values along the bottom. */
const BARRED = (stacked: boolean): readonly WellDef[] => [
  def('axis', 'axis', 'Y axis', 'one', 'Category listed down the side', { required: true }),
  def('values', 'values', 'X axis — values', 'many', 'Bar length — numbers default to Sum', {
    required: true,
    ...(stacked ? { max: 1 } : null),
  }),
  def(
    'legend',
    'legend',
    'Legend',
    'one',
    stacked ? 'Stack by this field — each value is a colored segment' : 'Optional: one series per value of this field',
    stacked ? { required: true } : undefined,
  ),
  SMALL_MULTIPLES,
];

const RADIAL: readonly WellDef[] = [
  def('legend', 'legend', 'Slices', 'one', 'One slice per value of this field', { required: true }),
  def('values', 'values', 'Values', 'many', 'Slice size — one measure', {
    max: 1,
    required: true,
  }),
];

export const WELL_CONFIG: Record<ChartType, readonly WellDef[]> = {
  column: COLUMNAR(false),
  stackedColumn: COLUMNAR(true),
  line: COLUMNAR(false),
  area: COLUMNAR(false),
  bar: BARRED(false),
  stackedBar: BARRED(true),
  pie: RADIAL,
  donut: RADIAL,
  scatter: [
    def('values', 'values-x', 'X value', 'one', 'Measure along the horizontal axis', {
      slot: 0,
      required: true,
    }),
    def('values', 'values-y', 'Y value', 'one', 'Measure along the vertical axis', {
      slot: 1,
      required: true,
    }),
    def('legend', 'legend', 'Details / color', 'one', 'Optional: color the points by this field'),
  ],
  gantt: [
    def('axis', 'axis', 'Tasks', 'one', 'One timeline bar per value of this field', {
      required: true,
    }),
    def('values', 'values-start', 'Start date', 'one', 'When each bar begins — dates default to Min', {
      slot: 0,
      required: true,
      defaultAggregation: 'min',
      temporalHint: true,
      placeholder: 'Drag a date field here',
    }),
    def('values', 'values-end', 'End date', 'one', 'When each bar ends — dates default to Max', {
      slot: 1,
      required: true,
      defaultAggregation: 'max',
      temporalHint: true,
      placeholder: 'Drag a date field here',
    }),
    def('legend', 'legend', 'Group / color', 'one', 'Optional: color the bars by this field'),
    def(
      'values',
      'values-progress',
      'Progress',
      'one',
      'Optional: completion as 0–1 or 0–100 — drawn as an inner fill',
      { slot: 2 },
    ),
  ],
  kpi: [
    def('values', 'values-main', 'Value', 'one', 'The big number', { slot: 0, required: true }),
    def(
      'values',
      'values-secondary',
      'Comparison',
      'one',
      'Optional: shown under the value — e.g. a target or prior period',
      { slot: 1 },
    ),
  ],
  table: [
    def('axis', 'axis', 'Rows', 'many', 'Fields that define the rows, in this order', {
      required: true,
    }),
    def('legend', 'legend', 'Columns', 'one', 'Optional: pivot — one column per value'),
    def('values', 'values', 'Values', 'many', 'Measure columns', { required: true }),
  ],
};

export const wellsFor = (type: ChartType): readonly WellDef[] => WELL_CONFIG[type];

const hasWell = (type: ChartType, id: WellId): boolean =>
  wellsFor(type).some((well) => well.id === id);

/**
 * Cartesians get the explicit "Drill-down levels" sub-area under their axis
 * well (axis chip is level 0; the sub-area lists query.drillLevels).
 */
export const hasDrillSubArea = (type: ChartType): boolean =>
  wellsFor(type).some((well) => well.id === 'axis' && well.capacity === 'one');

/**
 * Types that keep query.drillLevels: cartesians (drill sub-area) plus the
 * table, whose multi-field "Rows" well stores rows 2..n in the same array
 * (Region → Site → Priority row drilling). Wire shape is unchanged.
 */
export const supportsDrill = (type: ChartType): boolean =>
  hasDrillSubArea(type) ||
  wellsFor(type).some((well) => well.id === 'axis' && well.capacity === 'many');

/** Total measures the type can hold (slot count, or the values well's max). */
const valuesMaxFor = (type: ChartType): number => {
  const wells = wellsFor(type).filter((well) => well.id === 'values');
  const slots = wells.filter((well) => well.slot !== undefined);
  if (slots.length > 0) return slots.length;
  return wells[0]?.max ?? Number.POSITIVE_INFINITY;
};

export const supportsSmallMultiples = (type: ChartType): boolean =>
  hasWell(type, 'smallMultiples');

/** Columns can land in any well; the values well converts them to countDistinct. */
export const acceptsDimension = (_well: WellId): boolean => true;

/** Measures only ever land in values wells (filters/drill are column-based). */
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
  if (well === 'drill') return data.kind === 'column';
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

const toValueMeasure = (
  data: Exclude<FieldDragData, { kind: 'parameter' }>,
  /** Well-level default (WellDef.defaultAggregation) — wins for column drops. */
  defaultAggregation?: Aggregation,
): MeasureRef =>
  data.kind === 'measure'
    ? { measureId: data.measureId }
    : {
        table: data.table,
        column: data.column,
        aggregation:
          defaultAggregation ??
          (!isNumericType(data.type)
            ? 'countDistinct'
            : looksLikeIdentifier(data.column)
              ? 'count'
              : 'sum'),
      };

const sameMeasure = (a: MeasureRef, b: MeasureRef): boolean => {
  const aId = a.measureId ?? null;
  const bId = b.measureId ?? null;
  if (aId !== null || bId !== null) return aId === bId;
  return a.table === b.table && a.column === b.column && a.aggregation === b.aggregation;
};

const sameDimension = (a: DimensionRef, b: DimensionRef): boolean =>
  a.table === b.table && a.column === b.column && (a.dateBucket ?? null) === (b.dateBucket ?? null);

/** Axis + drill levels as one ordered list (the wire keeps them split). */
const axisLevels = (query: ChartQuery): DimensionRef[] => [
  ...(query.axis ? [query.axis] : []),
  ...(query.drillLevels ?? []),
];

/**
 * Applies a validated drop to the query; invalid combinations are a no-op.
 * Filters-well drops are handled by ChartBuilder (they open the editor), so
 * they are a no-op here. `slot` (from a slot-well droppable) targets one
 * measure index — scatter X/Y and the KPI value/comparison wells.
 */
export const applyDrop = (
  type: ChartType,
  query: ChartQuery,
  well: WellId,
  data: FieldDragData,
  slot?: number,
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
    const slotDef =
      slot !== undefined
        ? wellsFor(type).find((w) => w.id === 'values' && w.slot === slot)
        : undefined;
    const ref = toValueMeasure(data, slotDef?.defaultAggregation);
    if (query.measures.some((existing) => sameMeasure(existing, ref))) return query;
    if (slot !== undefined) {
      // Slot wells replace their own index; a drop past the current list
      // length appends (measure lists never carry holes on the wire).
      const measures = [...query.measures];
      if (slot < measures.length) measures[slot] = ref;
      else measures.push(ref);
      return { ...query, measures };
    }
    const max = valuesMaxFor(type);
    const measures =
      query.measures.length >= max
        ? [...query.measures.slice(0, max - 1), ref]
        : [...query.measures, ref];
    return { ...query, measures };
  }

  if (data.kind !== 'column') return query;
  const ref = toDimension(data);

  if (well === 'drill') {
    // "+ Add level" under a cartesian axis: appends to query.drillLevels
    // (exact duplicates of the axis or an existing level are a no-op). With
    // no axis yet, the field becomes the axis itself.
    if (!query.axis) return { ...query, axis: ref };
    if (axisLevels(query).some((level) => sameDimension(level, ref))) return query;
    return { ...query, drillLevels: [...(query.drillLevels ?? []), ref] };
  }

  if (well === 'axis') {
    const rowsWell = wellsFor(type).find((w) => w.id === 'axis')?.capacity === 'many';
    if (rowsWell && query.axis) {
      // Multi-field rows well (table): drops append the next row field.
      if (axisLevels(query).some((level) => sameDimension(level, ref))) return query;
      return { ...query, drillLevels: [...(query.drillLevels ?? []), ref] };
    }
    // Single-slot axis: replace, but never duplicate an existing drill level.
    if ((query.drillLevels ?? []).some((level) => sameDimension(level, ref))) return query;
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

/** Where a click-to-add lands: a well plus (for slot wells) the measure index. */
export interface DropTarget {
  well: WellId;
  slot?: number;
}

/**
 * Click-to-add routing: measures/numeric → first free values slot; temporal →
 * empty axis; other dimensions fill axis, then legend, then drill/rows.
 */
export const defaultWellFor = (
  type: ChartType,
  query: ChartQuery,
  data: FieldDragData,
): DropTarget => {
  if (data.kind === 'parameter') {
    return { well: data.paramKind === 'dimension' ? 'axis' : 'values' };
  }
  // Gantt routes DATE columns to the Start then End slots first — its axis is
  // categorical (tasks) and the timeline is built from the two date measures.
  if (type === 'gantt' && data.kind === 'column' && isTemporalType(data.type)) {
    const dateSlots = wellsFor(type).filter(
      (well) => well.id === 'values' && well.slot !== undefined && well.temporalHint,
    );
    const free = dateSlots.find((well) => (well.slot ?? 0) >= query.measures.length);
    if (free) return { well: 'values', slot: free.slot };
    if (!query.axis) return { well: 'axis' };
    const last = dateSlots[dateSlots.length - 1];
    if (last) return { well: 'values', slot: last.slot };
  }
  if (data.kind === 'measure' || isNumericType(data.type)) {
    const slots = wellsFor(type).filter((well) => well.id === 'values' && well.slot !== undefined);
    if (slots.length > 0) {
      // First unfilled slot (the list has no holes, so "free" = past the end);
      // when every slot is taken the LAST one is replaced.
      const free = slots.find((well) => (well.slot ?? 0) >= query.measures.length);
      return { well: 'values', slot: (free ?? slots[slots.length - 1]!).slot };
    }
    return { well: 'values' };
  }
  const axisEmpty = hasWell(type, 'axis') && !query.axis;
  if (isTemporalType(data.type) && axisEmpty) return { well: 'axis' };
  if (axisEmpty) return { well: 'axis' };
  if (hasWell(type, 'legend') && !query.legend) return { well: 'legend' };
  if (hasDrillSubArea(type)) return { well: 'drill' };
  if (hasWell(type, 'axis')) return { well: 'axis' };
  if (hasWell(type, 'legend')) return { well: 'legend' };
  return { well: 'values' };
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
  // The reverse carry: arriving at an axis-bearing type from pie/donut/scatter
  // (axis empty, a slice/color dimension set) puts that dimension on the axis
  // — switching pie → column keeps the chart whole instead of dropping to a
  // single unlabeled bar.
  if (hasWell(type, 'axis') && !next.axis && next.legend) {
    next = { ...next, axis: next.legend, legend: null };
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
  const max = valuesMaxFor(type);
  if (Number.isFinite(max) && next.measures.length > max) {
    next = { ...next, measures: next.measures.slice(0, max) };
  }
  return next;
};

/**
 * Aggregations offered for an inline value chip; null type (no catalog) offers
 * everything. Temporal columns include Min/Max — the engine supports them on
 * dates/timestamps (they return ISO strings; the gantt Start/End wells depend
 * on this).
 */
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
    : isTemporalType(type)
      ? (['min', 'max', 'count', 'countDistinct'] as const)
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

// columnLabelOf was PROMOTED to dashboards-core (the dashboard layer needs it
// for cross-filter chip labels); re-exported here so existing
// '../chart-builder/wellConfig' imports keep working unchanged.
export { columnLabelOf };

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
