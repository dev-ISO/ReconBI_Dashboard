// Wire mirror of POST /query and /query/values.
import type { Aggregation, DerivedField, Measure } from './model';
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
  | 'notNull'
  /**
   * NULL *or* the empty string — the exact complement pair for a value
   * grouping's blank bucket, which collects both. `isNull` alone under-matches
   * a grouped bar by its empty-string rows; filters have no OR, so this has to
   * be one operator.
   */
  | 'isBlank'
  | 'notBlank';

/**
 * One bucket of a value grouping: a label, the raw values it collects, and
 * whether it also collects BLANK rows (NULL or empty).
 */
export interface ValueGroup {
  label: string;
  values?: FilterValue[];
  matchBlank?: boolean;
  /**
   * EXCEL-STYLE MATCH RULES — the dynamic half of a bucket.
   *
   * `values` is a snapshot: it holds exactly the values that existed when the
   * author picked them, so every value that appears afterwards has to be added
   * by hand. A rule is evaluated in SQL against the live data, so a value that
   * arrives tomorrow joins its group on its own.
   *
   * Rules and values coexist: a bucket can list the awkward exceptions AND
   * carry a rule for the general case. Within a bucket, values, the blank flag
   * and the rule set OR together.
   */
  rules?: ValueGroupRule[];
  /** How this bucket's rules combine. 'any' (default) is Excel's "or". */
  ruleMode?: 'any' | 'all';
}

/** The Excel-autofilter vocabulary a bucket rule can match by. */
export type ValueGroupRuleOperator =
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'equals'
  | 'notEquals'
  | 'isBlank'
  | 'notBlank'
  | 'greaterThan'
  | 'greaterOrEqual'
  | 'lessThan'
  | 'lessOrEqual';

/**
 * One rule. `value` is required by every operator except isBlank/notBlank.
 * Text operators are CASE-INSENSITIVE — "contains Westlake" catches "westlake",
 * which is what the same words mean in a spreadsheet — and LIKE metacharacters
 * in the author's text match literally rather than acting as wildcards.
 */
export interface ValueGroupRule {
  operator: ValueGroupRuleOperator;
  value?: FilterValue | null;
}

/**
 * CHART-LOCAL VALUE GROUPING on one dimension — "show these values as one bar".
 *
 * Deliberately anonymous and deliberately chart-local: it creates NO entry in
 * the field list, because the standing complaint this answers is field-list
 * pollution. Most of the time an author wants the bars fixed, not a new field;
 * when they DO want a reusable one, the editor offers to promote it into a
 * named DerivedField, which is the same mechanism with a name on it.
 *
 * The engine compiles it through the SAME seam dateBucket already uses
 * (DimensionExpression), so the expression reaches SELECT, GROUP BY, ORDER BY
 * and the Top-N tie-break verbatim, and every label and match value is BOUND
 * AS A PARAMETER — never emitted into SQL.
 *
 * Rows matching no group fall into `otherLabel`. When it is null or absent the
 * engine does NOT invent an "Other" caption — it emits the value's own text, so
 * unmatched rows keep their identity instead of collapsing into one anonymous
 * bar. Set it explicitly to collapse them.
 */
export interface ValueGrouping {
  groups: ValueGroup[];
  otherLabel?: string | null;
}

export interface DimensionRef {
  table: string;
  column: string;
  dateBucket?: DateBucket | null;
  /**
   * Collapses this dimension's raw values into labelled buckets (see
   * ValueGrouping). Never set on a derived column, which is already an
   * expression.
   *
   * The ENGINE composes grouping over dateBucket (it layers column -> bucket ->
   * grouping), so the pair is legal on the wire. This CLIENT nonetheless never
   * emits both: grouping raw values and grouping bucketed periods are two
   * different questions, and offering both at once in the chip reads as a bug.
   * The editor therefore clears the grain when a grouping is applied. Treat
   * this as a UI convention, not an engine constraint.
   */
  grouping?: ValueGrouping | null;
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
  /**
   * DERIVED FIELD definitions this query carries because they are not in the
   * stored model — dashboard-scoped and personal ones. The sibling of
   * `definitions`, merged onto the model definition by the SAME overlay before
   * the compiler runs, so a derived column resolves and row-filters exactly
   * like a model-held one; dimensions referencing them stay
   * `{ table, column }`.
   *
   * Absent when the chart cites only model-held derived fields (or none), so
   * specs that predate this wave serialize byte-identically and keep their
   * cache key.
   */
  derivedFields?: DerivedField[] | null;
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
  /**
   * Derived-field definitions this lookup needs — the same overlay
   * ChartQuerySpec.derivedFields carries, because `column` may name a
   * dashboard- or personal-scope derived field the stored model does not hold.
   * Omitted (and therefore byte-identical to a pre-derived-fields request)
   * whenever the column is physical or model-held.
   */
  derivedFields?: DerivedField[] | null;
}

export interface DistinctValuesResult {
  values: CellValue[];
  hasMore: boolean;
}
