// Wire mirror of the versioned semantic-model definition (rcd_data_models).
import type { FilterClause } from './query';
import type { ColumnType } from './schema';

export type Aggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countDistinct';

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
   */
  expression?: string | null;
}

/** Engine-generated calendar table ('YYYY-MM-DD' range; null = engine defaults). */
export interface DateTableDef {
  name: string;
  rangeStart?: string | null;
  rangeEnd?: string | null;
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
}

export const tableKey = (schema: string, name: string): string => `${schema}.${name}`;

/** Canonical relationship/query key for a date table. */
export const dateTableKey = (name: string): string => `#date.${name}`;

/** The fixed columns every engine date table exposes, in display order. */
export const DATE_TABLE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: 'date_key', type: 'date' },
  { name: 'year', type: 'integer' },
  { name: 'quarter', type: 'integer' },
  { name: 'month', type: 'integer' },
  { name: 'month_name', type: 'text' },
  { name: 'week', type: 'integer' },
  { name: 'day', type: 'integer' },
  { name: 'day_name', type: 'text' },
];

export const emptyDefinition = (): ModelDefinition => ({
  version: 1,
  tables: [],
  relationships: [],
  measures: [],
});
