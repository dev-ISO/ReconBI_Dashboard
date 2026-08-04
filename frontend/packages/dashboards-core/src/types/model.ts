// Wire mirror of the versioned semantic-model definition (rcd_data_models).
import type { FilterClause } from './query';

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
}

export interface ModelDefinition {
  version: 1;
  tables: ModelTable[];
  relationships: Relationship[];
  measures: Measure[];
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

export const emptyDefinition = (): ModelDefinition => ({
  version: 1,
  tables: [],
  relationships: [],
  measures: [],
});
