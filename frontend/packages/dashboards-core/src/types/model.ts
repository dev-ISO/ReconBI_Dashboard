// Wire mirror of the versioned semantic-model definition (rcd_data_models).
import type { FilterClause } from './query';
import type { ColumnType } from './schema';

/**
 * Wire names are the backend Aggregation enum through its camelCase converter:
 * StdDev -> 'stdDev' (STDDEV_SAMP), Variance -> 'variance' (VAR_SAMP),
 * Median -> 'median' (PERCENTILE_CONT(0.5)). The statistical three are valid
 * for numeric (integer/decimal) columns only.
 */
export type Aggregation =
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'countDistinct'
  | 'stdDev'
  | 'variance'
  | 'median';

export type Cardinality = 'manyToOne' | 'oneToOne';

export type RelationshipSource = 'fk' | 'manual';

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface ModelColumn {
  name: string;
  friendlyName?: string | null;
  defaultAggregation?: Aggregation | null;
  formatHint?: string | null;
  hidden?: boolean;
}

export interface ModelTable {
  schema: string;
  name: string;
  friendlyName?: string | null;
  hidden?: boolean;
  position?: CanvasPosition | null;
  columns?: ModelColumn[] | null;
}

export interface Relationship {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  isActive: boolean;
  source: RelationshipSource;
}

export interface Measure {
  id: string;
  name: string;
  table: string;
  aggregation: Aggregation;
  column?: string | null;
  formatHint?: string | null;
  filters?: FilterClause[] | null;
  /**
   * When set, this is a calculated measure: `column` must stay null (server
   * MDL014) and `aggregation` is ignored by the engine (send 'sum' to satisfy
   * the wire shape). `table` remains required — it anchors join planning.
   * Expressions may reference other expression measures (cycles are server
   * MDL016) and may be wrapped in PERCENTOFTOTAL(...) at the outermost level.
   */
  expression?: string | null;
  /** Free-text documentation shown in field lists / tooltips. */
  description?: string | null;
  /** Grouping folder for field lists (e.g. 'Finance\\Core'). */
  displayFolder?: string | null;
  /**
   * Excel-style number pattern (e.g. '$#,##0.00;($#,##0.00)') rendered via
   * formatNumberPattern. Wins over formatHint when both are set; threads
   * through query results as QueryColumn.formatString.
   */
  formatString?: string | null;
}

/** Wire mirror of the backend WeekStartDay enum. */
export type WeekStartDay = 'monday' | 'sunday';

/**
 * Engine-generated calendar table ('YYYY-MM-DD' range; null = engine
 * defaults). fiscalYearStartMonth (1-12, default 1 = calendar; server MDL015)
 * shapes the fiscal_* columns — fiscal_year is labeled by the year the fiscal
 * year ENDS in. weekStartDay (default 'monday') shapes day_of_week/week_start;
 * is_weekend is always Sat/Sun.
 */
export interface DateTableDef {
  name: string;
  rangeStart?: string | null;
  rangeEnd?: string | null;
  fiscalYearStartMonth?: number | null;
  weekStartDay?: WeekStartDay | null;
}

export interface ModelDefinition {
  version: 1;
  tables: ModelTable[];
  relationships: Relationship[];
  measures: Measure[];
  dateTables?: DateTableDef[] | null;
}

export interface ModelSummary {
  id: number;
  name: string;
  description: string | null;
  dataSourceName: string;
  isShared: boolean;
  ownerIsMe: boolean;
  updatedAtUtc: string;
  /** Built-in (seeded) read-only content (0.8.0+; absent on older servers). */
  isSystem?: boolean;
}

export interface ModelDetail {
  id: number;
  name: string;
  description: string | null;
  dataSourceName: string;
  isShared: boolean;
  ownerIsMe: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
  definition: ModelDefinition;
  /** Built-in (seeded) read-only content (0.8.0+; absent on older servers). */
  isSystem?: boolean;
}

export const tableKey = (schema: string, name: string): string => `${schema}.${name}`;

/** Canonical relationship/query key for a date table. */
export const dateTableKey = (name: string): string => `#date.${name}`;

/**
 * The fixed columns every engine date table exposes, in display order
 * (mirrors backend DateTableSchema.Build). fiscal_* honor
 * fiscalYearStartMonth (calendar-equal when it is 1); day_of_week/week_start
 * honor weekStartDay; year_month sorts lexicographically = chronologically.
 */
export const DATE_TABLE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: 'date_key', type: 'date' },
  { name: 'year', type: 'integer' },
  { name: 'quarter', type: 'integer' },
  { name: 'month', type: 'integer' },
  { name: 'month_name', type: 'text' },
  { name: 'week', type: 'integer' },
  { name: 'day', type: 'integer' },
  { name: 'day_name', type: 'text' },
  { name: 'month_name_full', type: 'text' },
  { name: 'day_name_full', type: 'text' },
  { name: 'day_of_week', type: 'integer' },
  { name: 'day_of_year', type: 'integer' },
  { name: 'iso_year', type: 'integer' },
  { name: 'iso_week', type: 'integer' },
  { name: 'is_weekend', type: 'boolean' },
  { name: 'year_month', type: 'text' },
  { name: 'month_year_label', type: 'text' },
  { name: 'quarter_label', type: 'text' },
  { name: 'year_quarter', type: 'text' },
  { name: 'month_start', type: 'date' },
  { name: 'week_start', type: 'date' },
  { name: 'days_in_month', type: 'integer' },
  { name: 'fiscal_year', type: 'integer' },
  { name: 'fiscal_quarter', type: 'integer' },
  { name: 'fiscal_month', type: 'integer' },
];

export const emptyDefinition = (): ModelDefinition => ({
  version: 1,
  tables: [],
  relationships: [],
  measures: [],
});
