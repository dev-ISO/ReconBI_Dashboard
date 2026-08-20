// Wire mirror of POST /query and /query/values.
import type { Aggregation, Measure } from './model';
import type { ColumnType } from './schema';

export type DateBucket = 'year' | 'quarter' | 'month' | 'week' | 'day';

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'notIn'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains'
  | 'startsWith'
  | 'isNull'
  | 'notNull';

export interface DimensionRef {
  table: string;
  column: string;
  dateBucket?: DateBucket | null;
}

/**
 * Time-intelligence transform applied AFTER aggregation via SQL window
 * functions over the grouped result. 'runningTotal' works on any ordered
 * axis; the rest require the FIRST dimension to be date-bucketed.
 */
export type MeasureCalcKind =
  | 'runningTotal'
  | 'ytd'
  | 'priorPeriod' // value `offset` buckets back
  | 'periodChange' // value minus prior
  | 'periodChangePct'; // change as fraction of prior

export interface MeasureCalc {
  kind: MeasureCalcKind;
  /** Buckets back for prior/change kinds (default 1; e.g. 12 = YoY on months). */
  offset?: number | null;
}

/** Either a model measure reference or an inline aggregation — never both. */
export interface MeasureRef {
  measureId?: string | null;
  table?: string | null;
  column?: string | null;
  aggregation?: Aggregation | null;
  alias?: string | null;
  calc?: MeasureCalc | null;
}

export type FilterValue = string | number | boolean;

export interface FilterClause {
  table: string;
  column: string;
  operator: FilterOperator;
  values: FilterValue[];
}

export interface SortSpec {
  target: { kind: 'dimension' | 'measure'; index: number };
  direction: 'asc' | 'desc';
}

export interface ChartQuerySpec {
  modelId: number;
  dimensions: DimensionRef[];
  measures: MeasureRef[];
  filters: FilterClause[];
  sort: SortSpec[];
  topN?: { n: number; byMeasureIndex: number; includeOthers: boolean } | null;
  limit?: number | null;
  /** Row offset (applied after sort, before limit) — table pagination. */
  offset?: number | null;
  /**
   * Post-aggregation conditions (SQL HAVING) on measure values, ANDed.
   * measureIndex targets spec.measures; 'between' takes two values; 'in' /
   * 'notIn' take a 1..1000 value list ('in' keeps groups whose aggregate
   * equals a listed value — NULL never matches; 'notIn' is its exact
   * complement and KEEPS NULL aggregates, which is what lets a value
   * checklist with "(Blanks)" checked compile to the negated form).
   */
  having?: {
    measureIndex: number;
    operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'in' | 'notIn';
    values: number[];
  }[];
  /**
   * Measure DEFINITIONS this query carries because they are not in the stored
   * model — dashboard-scoped measures (layout doc `measures`) and personal
   * ones. The server OVERLAYS them onto the model definition BEFORE compiling
   * (MeasureOverlay.Merge), so they join-plan and row-filter exactly like
   * model measures; references in `measures` stay `{ measureId }`.
   *
   * The overlay is rejected outright when a definition's id or NAME collides
   * with a model measure (rcd.query.duplicate_measure_id /
   * rcd.query.duplicate_measure_name) — a name collision would make every
   * model expression that says [ThatName] ambiguous.
   *
   * Absent when the chart cites only model measures, so specs that predate
   * dashboard measures serialize byte-identically (and keep their cache key).
   */
  definitions?: Measure[] | null;
}

export interface QueryColumn {
  name: string;
  label: string;
  role: 'dimension' | 'measure';
  type: ColumnType;
  source: string | null;
  dateBucket: DateBucket | null;
  formatHint: string | null;
  /**
   * Model measure's Excel-style pattern (Measure.formatString) threaded
   * through the engine; wins over formatHint in formatCellValue. Optional so
   * pre-existing literals/mocks keep compiling.
   */
  formatString?: string | null;
}

export type CellValue = string | number | boolean | null;

/**
 * ONE measure the engine could not compile and CONTAINED rather than failed
 * on: its result column is kept (a tombstone selecting NULL under the original
 * alias) so every other series, every positional sort target and every
 * column-keyed format map still points where it did, and only THAT series
 * renders empty.
 *
 * The client's job is to say so out loud — a blank series with no explanation
 * is the outcome this exists to avoid — and to offer a way to fix the measure.
 *
 * `index` is the position in the request's `measures[]`, which is also what the
 * result column name ("meas{index}") and the wire issue path ("measures[i]")
 * address. Absent on older servers.
 */
export interface MeasureFailure {
  index: number;
  /** The measure's display label, as the result plan would have labeled it. */
  label: string;
  code: string;
  message: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: CellValue[][];
  meta: {
    rowCount: number;
    truncated: boolean;
    elapsedMs: number;
    warnings: { code: string; message: string }[];
    sql: string | null;
    /**
     * Per-measure compile failures the engine contained (see MeasureFailure).
     * OPTIONAL: a server that predates per-measure isolation omits it, and a
     * successful query omits it too — treat absent and empty identically.
     */
    measureFailures?: MeasureFailure[] | null;
  };
}

export interface DistinctValuesSpec {
  modelId: number;
  table: string;
  column: string;
  search?: string | null;
  filters: FilterClause[];
  limit?: number | null;
}

export interface DistinctValuesResult {
  values: CellValue[];
  hasMore: boolean;
}
