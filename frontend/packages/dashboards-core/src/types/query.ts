// Wire mirror of POST /query and /query/values.
import type { Aggregation } from './model';
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
}

export interface QueryColumn {
  name: string;
  label: string;
  role: 'dimension' | 'measure';
  type: ColumnType;
  source: string | null;
  dateBucket: DateBucket | null;
  formatHint: string | null;
}

export type CellValue = string | number | boolean | null;

export interface QueryResult {
  columns: QueryColumn[];
  rows: CellValue[][];
  meta: {
    rowCount: number;
    truncated: boolean;
    elapsedMs: number;
    warnings: { code: string; message: string }[];
    sql: string | null;
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
