// Well definitions per chart type plus the drop/click inference shared by
// FieldList, Wells, and ChartBuilder. Every chart type is live; the well
// shapes below encode each type's capacity rules (pie slices by legend, kpi
// is values-only, scatter wants exactly two measures, ...).
import {
  columnLabelOf,
  isNumericType,
  isTemporalType,
  toWireSpec,
  type Aggregation,
  type Catalog,
  type ChartFormat,
  type ChartQuery,
  type ChartSpec,
  type ChartType,
  type ColumnType,
  type DateBucket,
  type DimensionRef,
  type FilterClause,
  type FilterOperator,
  type MeasureRef,
  type ModelDefinition,
  type SortSpec,
  type TableOptions,
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
   * Aggregation a NON-NUMERIC column drop defaults to, replacing the plain
   * countDistinct fallback — but only for the types the engine allows Min/Max
   * on (text + temporal); booleans/uuids still land as Distinct count.
   *
   * Unlike defaultAggregation this does NOT touch numbers: a table's Values
   * well is a passthrough COLUMN list for text and dates (Min of Client =
   * "the client", one flat column) while remaining a real measure list for
   * numbers, where Sum is still what "Revenue by Region" means.
   */
  nonNumericAggregation?: Aggregation;
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
    // Honest caption: the legend lands as one flat extra dimension column
    // whose values repeat per row — nothing pivots into per-value columns.
    def('legend', 'legend', 'Columns', 'one', 'Optional: one extra grouping column on every row'),
    // NOT required (0.14.1): a table with Rows and no Values is a valid
    // passthrough list — the engine emits SELECT-DISTINCT-shaped SQL for it.
    // Text/date columns dropped here become Min (one flat column carrying the
    // value), which is the shape every seeded table chart uses; numbers keep
    // the normal Sum/Count inference.
    def(
      'values',
      'values',
      'Values',
      'many',
      'Optional: extra columns — numbers aggregate, text and dates come through as Min',
      {
        nonNumericAggregation: 'min',
        placeholder: 'Drag any field here — numbers aggregate, text and dates pass through',
      },
    ),
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
 * Types whose axis well is a MULTI-FIELD row list — today only the table's
 * "Rows". Those rows are a passthrough column list rather than a plotted
 * axis, which is why a temporal field lands there UNBUCKETED (a cartesian
 * axis still groups by month so it has a sane number of categories).
 */
export const hasRowsList = (type: ChartType): boolean =>
  wellsFor(type).some((well) => well.id === 'axis' && well.capacity === 'many');

/**
 * Types that keep query.drillLevels: cartesians (drill sub-area) plus the
 * table, whose multi-field "Rows" well stores rows 2..n in the same array
 * (Region → Site → Priority row drilling). Wire shape is unchanged.
 */
export const supportsDrill = (type: ChartType): boolean =>
  hasDrillSubArea(type) || hasRowsList(type);

/** Total measures the type can hold (slot count, or the values well's max). */
export const valuesMaxFor = (type: ChartType): number => {
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

/** Which well a chip currently lives in, and where in that well's list. */
export interface ChipOrigin {
  well: WellId;
  /**
   * Position inside the well's own list: [axis, ...drillLevels] for a table
   * Rows well, query.drillLevels for 'drill', query.measures for 'values'
   * (the SLOT index in a slot well), query.filters for 'filters'. Wells that
   * hold a single chip always pass 0.
   */
  index: number;
}

/**
 * A chip's CURRENT wire shape — what it is, so a move can work out what it
 * would become somewhere else. Carried on the drag payload because the wells
 * store three different shapes and none of them is self-describing.
 */
export type ChipShape =
  | { kind: 'dimension'; dimension: DimensionRef }
  | { kind: 'measure'; measure: MeasureRef }
  | { kind: 'filter'; clause: FilterClause };

/**
 * A chip being dragged OUT of a well — the payload that makes Rows ⇄ Values ⇄
 * Columns ⇄ Filters a drag instead of a remove-then-hunt-for-the-field-again.
 */
export interface ChipDragData {
  kind: 'chip';
  from: ChipOrigin;
  ref: ChipShape;
  /**
   * Column type resolved from the catalog when the chip renders. Neither a
   * DimensionRef nor a FilterClause carries one, and the target well needs it
   * to pick an aggregation / decide whether a date bucket applies.
   */
  type: ColumnType | null;
  /** The chip's visible text — the drag overlay and confirmations show it. */
  label: string;
}

/** Drag payload carried by every field-list entry (dnd-kit `data`). */
export type FieldDragData =
  | { kind: 'column'; table: string; column: string; type: ColumnType }
  | { kind: 'measure'; measureId: string; name: string }
  | { kind: 'parameter'; parameterId: string; name: string; paramKind: 'dimension' | 'measure' }
  | ChipDragData;

/**
 * The table+column a chip resolves to, or null when it has no dimension form
 * at all: a MODEL measure (measureId, no column of its own), a measure
 * carrying a quick calculation (a window function over the aggregate) and a
 * bare `count()` with no column can never become a row, column or filter.
 */
export const chipColumnOf = (ref: ChipShape): { table: string; column: string } | null => {
  if (ref.kind === 'dimension') {
    return { table: ref.dimension.table, column: ref.dimension.column };
  }
  if (ref.kind === 'filter') return { table: ref.clause.table, column: ref.clause.column };
  const measure = ref.measure;
  if (measure.measureId != null || measure.calc != null) return null;
  if (measure.table == null || measure.column == null) return null;
  return { table: measure.table, column: measure.column };
};

export const canAccept = (well: WellId, data: FieldDragData): boolean => {
  if (data.kind === 'chip') {
    // Any column can be aggregated, so every chip has a measure form; only the
    // shapes that resolve to a real table+column have a dimension form.
    return well === 'values' ? true : chipColumnOf(data.ref) !== null;
  }
  if (data.kind === 'parameter') {
    return data.paramKind === 'dimension' ? well === 'axis' : well === 'values';
  }
  if (well === 'drill') return data.kind === 'column';
  return data.kind === 'column' ? acceptsDimension(well) : acceptsMeasure(well);
};

/**
 * Types the engine accepts Min/Max on beyond numbers — the exact rule
 * QueryCompiler.IsAggregationCompatible applies (see aggregationOptionsFor).
 */
const minMaxLegalFor = (type: ColumnType): boolean => isTemporalType(type) || type === 'text';

/**
 * `defaultBucket` is the grain a TEMPORAL column lands on; non-temporal
 * columns always carry null. Charts group dates by month so an axis has a
 * sane number of categories, but a table's Rows are a passthrough list — a
 * "Latest Week Ending" row must keep its EXACT date, so the table Rows well
 * passes null (see applyDrop).
 */
const toDimension = (
  data: Extract<FieldDragData, { kind: 'column' }>,
  defaultBucket: DateBucket | null = 'month',
): DimensionRef => ({
  table: data.table,
  column: data.column,
  dateBucket: isTemporalType(data.type) ? defaultBucket : null,
});

/**
 * Numeric columns that are really identifiers (ids, codes, keys) should not
 * default to Sum — summing ids is never meaningful. Mirrors Power BI's smart
 * default: such fields land in Values as Count instead.
 */
const looksLikeIdentifier = (column: string): boolean =>
  /(^|_)(id|key|code|num|number|no)$/i.test(column) || /^id$/i.test(column);

/**
 * The inline measure a COLUMN becomes in a values well. `type` is nullable so
 * a chip moved out of a Rows/Filters well still converts when the catalog did
 * not load — an unknown type keeps the safe Distinct count, which every column
 * type accepts.
 */
const inlineMeasureFor = (
  table: string,
  column: string,
  type: ColumnType | null,
  /** Well-level default (WellDef.defaultAggregation) — wins for column drops. */
  defaultAggregation?: Aggregation,
  /** Well-level NON-NUMERIC default (WellDef.nonNumericAggregation). */
  nonNumericAggregation?: Aggregation,
): MeasureRef => ({
  table,
  column,
  aggregation:
    defaultAggregation ??
    (type !== null && isNumericType(type)
      ? looksLikeIdentifier(column)
        ? 'count'
        : 'sum'
      : // Text/date columns honor the well's passthrough default (table
        // Values = Min); booleans and uuids cannot take Min/Max at all,
        // so they keep the count fallback.
        type !== null && nonNumericAggregation !== undefined && minMaxLegalFor(type)
        ? nonNumericAggregation
        : 'countDistinct'),
});

const toValueMeasure = (
  data: Exclude<FieldDragData, { kind: 'parameter' | 'chip' }>,
  defaultAggregation?: Aggregation,
  nonNumericAggregation?: Aggregation,
): MeasureRef =>
  data.kind === 'measure'
    ? { measureId: data.measureId }
    : inlineMeasureFor(
        data.table,
        data.column,
        data.type,
        defaultAggregation,
        nonNumericAggregation,
      );

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

/** Splits an ordered [axis, ...drillLevels] list back onto the wire shape. */
const fromAxisLevels = (query: ChartQuery, levels: DimensionRef[]): ChartQuery => ({
  ...query,
  axis: levels[0] ?? null,
  drillLevels: levels.length > 1 ? levels.slice(1) : undefined,
});

/**
 * The values WellDef a drop/move addresses: the slot well for `slot`,
 * otherwise the type's single open-ended values well. Both kinds contribute
 * their drop defaults — slot wells the absolute one (gantt Start = Min), plain
 * wells the non-numeric one (table Values = Min).
 */
const valuesDefFor = (type: ChartType, slot?: number): WellDef | undefined => {
  const valuesWells = wellsFor(type).filter((well) => well.id === 'values');
  return slot !== undefined
    ? valuesWells.find((well) => well.slot === slot)
    : valuesWells.find((well) => well.slot === undefined);
};

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
  // Chips already live in a well — moving one is moveChip's job (it has to
  // vacate the source and re-point everything that addressed the old order).
  if (data.kind === 'chip') return query;

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
    // The TARGET values well: the addressed slot, or (non-slot drops) the
    // type's single open-ended values well.
    const targetDef = valuesDefFor(type, slot);
    const ref = toValueMeasure(
      data,
      targetDef?.defaultAggregation,
      targetDef?.nonNumericAggregation,
    );
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
  // Table Rows are a passthrough list, not an axis: a date row field keeps
  // its exact value instead of collapsing into month buckets (the bucket
  // select on the chip still offers every grain, "Exact date" included).
  const flatRows = well === 'axis' && hasRowsList(type);
  const ref = toDimension(data, flatRows ? null : 'month');

  if (well === 'drill') {
    // "+ Add level" under a cartesian axis: appends to query.drillLevels
    // (exact duplicates of the axis or an existing level are a no-op). With
    // no axis yet, the field becomes the axis itself.
    if (!query.axis) return { ...query, axis: ref };
    if (axisLevels(query).some((level) => sameDimension(level, ref))) return query;
    return { ...query, drillLevels: [...(query.drillLevels ?? []), ref] };
  }

  if (well === 'axis') {
    if (flatRows && query.axis) {
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

// ---------------------------------------------------------------------------
// Moving a chip BETWEEN wells
// ---------------------------------------------------------------------------

/**
 * Where a chip drag was released: a well, plus (slot wells) the measure index
 * it presents and (list wells) the position the chip was dropped on.
 * `index` absent = the end of the list.
 */
export interface ChipDropTarget {
  well: WellId;
  slot?: number;
  index?: number;
}

/** Positional move inside one array (dnd-kit's arrayMove, without the import). */
const movedWithin = <T>(items: readonly T[], from: number, to: number): T[] => {
  const next = [...items];
  const [lifted] = next.splice(from, 1);
  if (lifted === undefined) return next;
  next.splice(Math.min(Math.max(to, 0), next.length), 0, lifted);
  return next;
};

/**
 * The dimension a chip becomes in `well`, or null when it has no dimension
 * form. The date grain follows the SAME rule a fresh drop follows (see
 * toDimension): a table's Rows are a passthrough list that keeps the exact
 * value, every other dimension well groups a date by month — except that an
 * explicit grain the chip already carries is preserved rather than reset.
 */
const chipAsDimension = (
  type: ChartType,
  well: WellId,
  ref: ChipShape,
  columnType: ColumnType | null,
): DimensionRef | null => {
  const column = chipColumnOf(ref);
  if (column === null) return null;
  const current = ref.kind === 'dimension' ? (ref.dimension.dateBucket ?? null) : null;
  // With no catalog an existing bucket is the only evidence the column is a date.
  const temporal = columnType !== null ? isTemporalType(columnType) : current !== null;
  const flatRows = well === 'axis' && hasRowsList(type);
  return {
    table: column.table,
    column: column.column,
    dateBucket: !temporal ? null : flatRows ? current : (current ?? 'month'),
  };
};

/**
 * The measure a chip becomes in a values well. A measure chip rides across
 * UNCHANGED — its aggregation, alias and quick calculation are the user's
 * work, not something a move should re-infer.
 */
const chipAsMeasure = (
  ref: ChipShape,
  columnType: ColumnType | null,
  targetDef: WellDef | undefined,
): MeasureRef | null => {
  if (ref.kind === 'measure') return ref.measure;
  const column = chipColumnOf(ref);
  if (column === null) return null;
  return inlineMeasureFor(
    column.table,
    column.column,
    columnType,
    targetDef?.defaultAggregation,
    targetDef?.nonNumericAggregation,
  );
};

/**
 * The chip a drop would DISPLACE, or null when the target has room. 'many'
 * wells only displace once they are at their max (pie/stacked Values hold one;
 * a table's Rows and Values are unbounded).
 */
const occupantIndexOf = (type: ChartType, query: ChartQuery, to: ChipDropTarget): number => {
  switch (to.well) {
    case 'axis':
      return hasRowsList(type) ? -1 : query.axis ? 0 : -1;
    case 'legend':
      return query.legend ? 0 : -1;
    case 'smallMultiples':
      return query.smallMultiples ? 0 : -1;
    case 'values': {
      if (to.slot !== undefined) return query.measures[to.slot] !== undefined ? to.slot : -1;
      const max = valuesMaxFor(type);
      if (query.measures.length < max) return -1;
      const index = to.index ?? query.measures.length - 1;
      return Math.min(Math.max(index, 0), query.measures.length - 1);
    }
    default:
      return -1; // 'drill' and 'filters' are unbounded lists
  }
};

const occupantOf = (type: ChartType, query: ChartQuery, to: ChipDropTarget): ChipShape | null => {
  const index = occupantIndexOf(type, query, to);
  if (index < 0) return null;
  if (to.well === 'values') {
    const measure = query.measures[index];
    return measure ? { kind: 'measure', measure } : null;
  }
  const dimension =
    to.well === 'axis' ? query.axis : to.well === 'legend' ? query.legend : query.smallMultiples;
  return dimension ? { kind: 'dimension', dimension } : null;
};

/**
 * True when a chip drop on this well would be honored — the well's live
 * not-allowed styling and the drop itself read the SAME predicate, so a well
 * never lights up for a move that would then silently do nothing.
 *
 * A move must never destroy the chip it displaces (that is the reported
 * complaint in reverse), so a one-chip target that is already full is only
 * valid when the two chips can SWAP: the occupant has to convert back into the
 * source well. Filters are the one well a chip cannot be pushed into
 * synchronously — the FilterEditor has to ask for an operator first — so a
 * swap that would need one is refused.
 */
export const canDropChip = (
  type: ChartType,
  query: ChartQuery,
  data: ChipDragData,
  to: ChipDropTarget,
): boolean => {
  if (!canAccept(to.well, data)) return false;
  if (data.from.well === to.well) return true; // a reorder, or a harmless no-op
  if (to.well === 'filters') return true; // the FilterEditor detour vets it
  const displaced = occupantOf(type, query, to);
  if (displaced === null) return true;
  if (data.from.well === 'filters') return false;
  return data.from.well === 'values' || chipColumnOf(displaced) !== null;
};

/** Reorder inside one well (the free win: measure order IS table column order). */
const reorderWithin = (
  type: ChartType,
  query: ChartQuery,
  data: ChipDragData,
  to: ChipDropTarget,
): ChartQuery | null => {
  const from = data.from.index;
  if (data.from.well === 'values') {
    if (to.slot !== undefined) {
      // Slot wells present fixed indexes (scatter X/Y, gantt Start/End), so
      // dragging one onto another SWAPS them; an empty slot has nothing to
      // trade and the measure list never carries holes.
      const target = query.measures[to.slot];
      const source = query.measures[from];
      if (to.slot === from || target === undefined || source === undefined) return null;
      const measures = [...query.measures];
      measures[from] = target;
      measures[to.slot] = source;
      return { ...query, measures };
    }
    const at = to.index ?? query.measures.length - 1;
    if (at === from || from >= query.measures.length) return null;
    return { ...query, measures: movedWithin(query.measures, from, at) };
  }
  if (data.from.well === 'axis' && hasRowsList(type)) {
    const levels = axisLevels(query);
    const at = to.index ?? levels.length - 1;
    if (at === from || from >= levels.length) return null;
    return fromAxisLevels(query, movedWithin(levels, from, at));
  }
  if (data.from.well === 'drill') {
    const levels = query.drillLevels ?? [];
    const at = to.index ?? levels.length - 1;
    if (at === from || from >= levels.length) return null;
    return { ...query, drillLevels: movedWithin(levels, from, at) };
  }
  return null; // one-chip wells and filters have no meaningful order
};

/**
 * Takes the chip out of its source well, closing the gap it leaves. Exported
 * for the OTHER half of the ->Filters detour: the chip only leaves its well
 * once the FilterEditor actually applies a clause, never on the drop itself.
 */
export const removeChip = (type: ChartType, query: ChartQuery, from: ChipOrigin): ChartQuery => {
  switch (from.well) {
    case 'axis':
      return hasRowsList(type)
        ? fromAxisLevels(
            query,
            axisLevels(query).filter((_, index) => index !== from.index),
          )
        : { ...query, axis: null };
    case 'drill': {
      const levels = (query.drillLevels ?? []).filter((_, index) => index !== from.index);
      return { ...query, drillLevels: levels.length > 0 ? levels : undefined };
    }
    case 'legend':
      return { ...query, legend: null };
    case 'smallMultiples':
      return { ...query, smallMultiples: null };
    case 'values':
      return { ...query, measures: query.measures.filter((_, index) => index !== from.index) };
    case 'filters':
      return { ...query, filters: query.filters.filter((_, index) => index !== from.index) };
  }
};

/** Places a converted chip into its target well at the requested position. */
const withChip = (
  type: ChartType,
  query: ChartQuery,
  to: ChipDropTarget,
  ref: DimensionRef | MeasureRef,
): ChartQuery => {
  switch (to.well) {
    case 'axis': {
      if (!hasRowsList(type)) return { ...query, axis: ref as DimensionRef };
      const levels = axisLevels(query);
      const at = Math.min(Math.max(to.index ?? levels.length, 0), levels.length);
      return fromAxisLevels(query, [
        ...levels.slice(0, at),
        ref as DimensionRef,
        ...levels.slice(at),
      ]);
    }
    case 'drill': {
      // A chip move NEVER promotes to the axis the way a field-list drop does:
      // the chip came from a well the user chose to empty, and silently
      // re-filling the axis would undo the drag they just made.
      const levels = query.drillLevels ?? [];
      const at = Math.min(Math.max(to.index ?? levels.length, 0), levels.length);
      return {
        ...query,
        drillLevels: [...levels.slice(0, at), ref as DimensionRef, ...levels.slice(at)],
      };
    }
    case 'legend':
      return { ...query, legend: ref as DimensionRef };
    case 'smallMultiples':
      return { ...query, smallMultiples: ref as DimensionRef };
    case 'values': {
      const measures = [...query.measures];
      if (to.slot !== undefined) {
        if (to.slot < measures.length) measures[to.slot] = ref as MeasureRef;
        else measures.push(ref as MeasureRef);
        return { ...query, measures };
      }
      const at = Math.min(Math.max(to.index ?? measures.length, 0), measures.length);
      measures.splice(at, 0, ref as MeasureRef);
      return { ...query, measures };
    }
    case 'filters':
      return query; // never reached: filters go through the FilterEditor detour
  }
};

const duplicatesExisting = (
  query: ChartQuery,
  well: WellId,
  ref: DimensionRef | MeasureRef,
): boolean =>
  well === 'values'
    ? query.measures.some((existing) => sameMeasure(existing, ref as MeasureRef))
    : [
        ...axisLevels(query),
        ...(query.legend ? [query.legend] : []),
        ...(query.smallMultiples ? [query.smallMultiples] : []),
      ].some((existing) => sameDimension(existing, ref as DimensionRef));

/**
 * Moves a chip from one well to another (or to a new position in its own
 * well). Returns null when the move is refused or would change nothing — the
 * caller leaves the draft untouched.
 *
 * Everything the wells can hold converts both ways EXCEPT a measure with no
 * column of its own (a model measure, or one carrying a quick calculation):
 * those have no dimension form, so they cannot leave the Values well.
 * Filters are asymmetric by nature — a chip becomes a filter only after the
 * FilterEditor collects an operator, which is ChartBuilder's detour, not a
 * move; a filter leaving the well loses its operator and values, which is why
 * ChartBuilder asks first.
 */
export const moveChip = (
  type: ChartType,
  query: ChartQuery,
  data: ChipDragData,
  to: ChipDropTarget,
  /**
   * Catalog lookup for the DISPLACED chip in a swap — the dragged chip carries
   * its own type, but the one it trades places with was never picked up, and
   * without a type a text column swapped into a table's Values would land on
   * Distinct count instead of the passthrough Min.
   */
  resolveType?: (table: string, column: string) => ColumnType | null,
): ChartQuery | null => {
  if (to.well === 'filters') return null; // ChartBuilder opens the editor instead
  if (!canDropChip(type, query, data, to)) return null;
  if (data.from.well === to.well) return reorderWithin(type, query, data, to);

  const incoming =
    to.well === 'values'
      ? chipAsMeasure(data.ref, data.type, valuesDefFor(type, to.slot))
      : chipAsDimension(type, to.well, data.ref, data.type);
  if (incoming === null) return null;

  const displacedIndex = occupantIndexOf(type, query, to);
  const displaced = occupantOf(type, query, to);
  // A slot values well presents ONE fixed measure index, so the displaced chip
  // has to go back to exactly that slot rather than to the end of the list.
  const sourceIsSlotWell =
    data.from.well === 'values' &&
    wellsFor(type).some((well) => well.id === 'values' && well.slot === data.from.index);
  const sourceTarget: ChipDropTarget = {
    well: data.from.well,
    index: data.from.index,
    ...(sourceIsSlotWell ? { slot: data.from.index } : null),
  };
  let returning: DimensionRef | MeasureRef | null = null;
  if (displaced !== null) {
    if (data.from.well === 'filters') return null;
    const column = chipColumnOf(displaced);
    const displacedType =
      column && resolveType ? resolveType(column.table, column.column) : null;
    returning =
      data.from.well === 'values'
        ? chipAsMeasure(displaced, displacedType, valuesDefFor(type, sourceTarget.slot))
        : chipAsDimension(type, data.from.well, displaced, displacedType);
    if (returning === null) return null;
  }

  let next = removeChip(type, query, data.from);
  if (displaced !== null && !(to.well === 'values' && to.slot !== undefined)) {
    // Vacate the target before the duplicate check so the chip being swapped
    // out never counts as a clash with the chip arriving. NOT for a slot well:
    // its measure index is written in place, and splicing it out would slide
    // every LATER slot down one (a gantt End sliding into Start).
    next = removeChip(type, next, { well: to.well, index: displacedIndex });
  }
  if (duplicatesExisting(next, to.well, incoming)) return null;
  next = withChip(type, next, to, incoming);
  if (returning !== null) next = withChip(type, next, sourceTarget, returning);
  return next;
};

// ---------------------------------------------------------------------------
// Re-pointing everything that addresses a field BY INDEX
// ---------------------------------------------------------------------------

/**
 * Identity of a wire measure/dimension, strict then loose. The strict key
 * pins the whole ref so a genuine reorder is tracked exactly; the loose one
 * (table+column) catches the same field after an EDIT that rides along with a
 * move — a Rows date dropped into Columns picks up a month bucket, and its
 * sort rule should follow it rather than be dropped on the floor.
 */
const dimensionKeys = (ref: DimensionRef): [string, string] => [
  `${ref.table}.${ref.column}#${ref.dateBucket ?? ''}`,
  `${ref.table}.${ref.column}`,
];

const measureKeys = (ref: MeasureRef): [string, string] =>
  ref.measureId != null
    ? [`id:${ref.measureId}`, `id:${ref.measureId}`]
    : [
        `col:${ref.table ?? ''}.${ref.column ?? ''}#${ref.aggregation ?? ''}#${ref.alias ?? ''}#${
          ref.calc?.kind ?? ''
        }${ref.calc?.offset ?? ''}`,
        `col:${ref.table ?? ''}.${ref.column ?? ''}`,
      ];

/** old index -> new index; absent = the field is gone from the wire list. */
const indexMap = (
  before: readonly [string, string][],
  after: readonly [string, string][],
): Map<number, number> => {
  const map = new Map<number, number>();
  const taken = new Set<number>();
  const match = (key: string, pick: 0 | 1) =>
    after.findIndex((keys, index) => !taken.has(index) && keys[pick] === key);
  before.forEach((keys, index) => {
    const exact = match(keys[0], 0);
    const found = exact >= 0 ? exact : match(keys[1], 1);
    if (found >= 0) {
      taken.add(found);
      map.set(index, found);
    }
  });
  return map;
};

const remapRecord = <T>(
  record: Record<string, T> | undefined,
  rename: (key: string) => string | null,
): Record<string, T> | undefined => {
  if (!record) return record;
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const renamed = rename(key);
    if (renamed !== key) changed = true;
    if (renamed !== null) next[renamed] = value;
  }
  return changed ? next : record;
};

/**
 * Re-points every persisted structure that addresses a field BY POSITION after
 * a well edit reordered, added or removed one. This is the real hazard in
 * moving chips between wells — the drag mechanics are visible, an index that
 * silently slid one place is not:
 *
 *   query.sort[].target.index      — 'dimension' AND 'measure' targets, against
 *                                    the WIRE order (toWireSpec), which is why
 *                                    both lists are diffed there rather than in
 *                                    builder terms; a rule whose target left the
 *                                    chart is dropped instead of re-pointed at
 *                                    whatever slid into its place.
 *   format.table.{columnWidths, columnOrder, columnAlign, columnVerticalAlign,
 *                 dateAggregation}  — keyed by RESULT COLUMN NAME ("meas0",
 *                                    "dim1"), i.e. by position; a table whose
 *                                    columns were resized and re-ordered would
 *                                    otherwise re-apply that layout to the
 *                                    WRONG columns.
 *   format.categoryOrder           — keyed by the level-0 dimension's VALUES,
 *                                    so it is meaningless once that dimension
 *                                    is replaced.
 *
 * Deliberately NOT remapped: format.seriesLabels / colorOverrides / lineStyles
 * / secondaryAxisKeys / conditionalFormats[].measureKey / seriesOrder. Those
 * are keyed by the composed series LABEL, not by an index, so a reorder cannot
 * disturb them — and a measure that leaves keeps its styling should it come
 * back. query.having is not persisted at all: the dashboard tile derives it
 * per fetch from transient table header filters (translateTableFilters), so
 * there is nothing here to re-point.
 */
export const remapIndexedRefs = (before: ChartSpec, after: ChartSpec): ChartSpec => {
  const beforeWire = toWireSpec(before, 0);
  const afterWire = toWireSpec(after, 0);
  const dimensions = indexMap(
    beforeWire.dimensions.map(dimensionKeys),
    afterWire.dimensions.map(dimensionKeys),
  );
  const measures = indexMap(
    beforeWire.measures.map(measureKeys),
    afterWire.measures.map(measureKeys),
  );

  const unchanged =
    beforeWire.dimensions.length === afterWire.dimensions.length &&
    beforeWire.measures.length === afterWire.measures.length &&
    [...dimensions].every(([from, to]) => from === to) &&
    [...measures].every(([from, to]) => from === to) &&
    dimensions.size === beforeWire.dimensions.length &&
    measures.size === beforeWire.measures.length;
  if (unchanged) return after;

  const renameResultColumn = (name: string): string | null => {
    const measure = /^meas(\d+)$/.exec(name);
    if (measure) {
      const index = measures.get(Number(measure[1]));
      return index === undefined ? null : `meas${index}`;
    }
    const dimension = /^dim(\d+)$/.exec(name);
    if (dimension) {
      const index = dimensions.get(Number(dimension[1]));
      return index === undefined ? null : `dim${index}`;
    }
    return name; // 'is_topn' and anything else the renderer adds
  };

  const sorted = (after.query.sort ?? []).flatMap((rule): SortSpec[] => {
    const index = (rule.target.kind === 'measure' ? measures : dimensions).get(rule.target.index);
    return index === undefined ? [] : [{ ...rule, target: { ...rule.target, index } }];
  });
  const sort = sorted.length > 0 ? sorted : undefined;

  const format: ChartFormat = { ...after.format };
  if (after.format.table) {
    const table: TableOptions = { ...after.format.table };
    // Assign in place only where the key already exists — writing `undefined`
    // onto an absent option would add it to the spec (and to every diff).
    if (table.columnWidths) table.columnWidths = remapRecord(table.columnWidths, renameResultColumn);
    if (table.columnAlign) table.columnAlign = remapRecord(table.columnAlign, renameResultColumn);
    if (table.columnVerticalAlign) {
      table.columnVerticalAlign = remapRecord(table.columnVerticalAlign, renameResultColumn);
    }
    if (table.dateAggregation) {
      table.dateAggregation = remapRecord(table.dateAggregation, renameResultColumn);
    }
    if (table.columnOrder) {
      table.columnOrder = table.columnOrder
        .map(renameResultColumn)
        .filter((name): name is string => name !== null);
    }
    format.table = table;
  }
  const axisChanged =
    (beforeWire.dimensions[0] === undefined) !== (afterWire.dimensions[0] === undefined) ||
    (beforeWire.dimensions[0] !== undefined &&
      afterWire.dimensions[0] !== undefined &&
      dimensionKeys(beforeWire.dimensions[0])[1] !== dimensionKeys(afterWire.dimensions[0])[1]);
  if (axisChanged) delete format.categoryOrder;

  const query = { ...after.query };
  if (sort === undefined) delete query.sort;
  else query.sort = sort;
  return { ...after, query, format };
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
  // Chips are dragged, never click-added — a chip is ALREADY in a well, so the
  // only honest "default" is where it already is (the union stays exhaustive).
  if (data.kind === 'chip') return { well: data.from.well };
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
 * everything. EXACT mirror of the engine's IsAggregationCompatible
 * (QueryCompiler.IsAggregationCompatible / chartValidation's
 * aggregationValidFor): Sum/Avg/StdDev/Variance/Median are numeric-only,
 * Min/Max are legal on numbers, dates/timestamps AND text, and Count/
 * DistinctCount work on anything usable. Text used to be offered only
 * Count/DistinctCount even though Min-of-text compiles fine — which is what
 * made a passthrough table column ("Min of Client", aliased to "Client")
 * unbuildable in the GUI while the seeded dashboards' hand-authored JSON did
 * exactly that. Only boolean/uuid (and the unusable json/other) stay
 * count-only.
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
    : minMaxLegalFor(type)
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
