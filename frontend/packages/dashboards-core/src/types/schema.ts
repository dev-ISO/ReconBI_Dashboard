// Wire mirror of GET /connections/{name}/catalog.

export type ColumnType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'uuid'
  | 'json'
  | 'other';

export type TableKind = 'table' | 'view' | 'materializedView' | 'foreignTable';

export interface CatalogColumn {
  name: string;
  ordinal: number;
  rawType: string;
  type: ColumnType;
  isNullable: boolean;
  comment: string | null;
}

export interface CatalogTable {
  schema: string;
  name: string;
  /** Canonical "schema.table" key used everywhere. */
  key: string;
  kind: TableKind;
  rowEstimate: number | null;
  comment: string | null;
  columns: CatalogColumn[];
  primaryKey: string[];
  uniqueConstraints: string[][];
}

export interface CatalogForeignKey {
  name: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  isComposite: boolean;
}

export interface RelationshipSuggestion {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName: string;
  compositeUnsupported: boolean;
}

export interface Catalog {
  connection: string;
  versionHash: string;
  fetchedAtUtc: string;
  tables: CatalogTable[];
  foreignKeys: CatalogForeignKey[];
  suggestions: RelationshipSuggestion[];
}

export interface ConnectionInfo {
  name: string;
  description: string | null;
  provider: string;
}

/** Column types usable as dimensions/measures/filters (mirror of engine rules). */
export const isQueryableType = (type: ColumnType): boolean => type !== 'other' && type !== 'json';

export const isNumericType = (type: ColumnType): boolean => type === 'integer' || type === 'decimal';

export const isTemporalType = (type: ColumnType): boolean => type === 'date' || type === 'timestamp';
