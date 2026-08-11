import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi } from '../api/DashboardsApi';
import { RcdApiError } from '../api/fetcher';
import type { Catalog, CatalogTable, ConnectionInfo, RelationshipSuggestion } from '../types/schema';
import {
  dateTableKey,
  emptyDefinition,
  tableKey,
  type Cardinality,
  type DateTableDef,
  type Measure,
  type ModelDefinition,
  type ModelDetail,
  type ModelSummary,
  type Relationship,
} from '../types/model';
import { newId } from '../util/ids';

export type AsyncStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface EditableModel {
  /** null until first save. */
  id: number | null;
  name: string;
  description: string | null;
  dataSourceName: string;
  isShared: boolean;
  expectedUpdatedAtUtc: string | null;
  ownerIsMe: boolean;
  /** Built-in (seeded) content — read-only for everyone; copy to edit. */
  isSystem: boolean;
  definition: ModelDefinition;
}

export interface ModelStoreState {
  connections: ConnectionInfo[];
  connectionsStatus: AsyncStatus;
  catalog: Catalog | null;
  catalogStatus: AsyncStatus;
  models: ModelSummary[];
  modelsStatus: AsyncStatus;
  current: EditableModel | null;
  dirty: boolean;
  saveStatus: AsyncStatus;
  error: string | null;
}

export interface NewRelationshipInput {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality?: Cardinality;
  source?: 'fk' | 'manual';
}

const initialState: ModelStoreState = {
  connections: [],
  connectionsStatus: 'idle',
  catalog: null,
  catalogStatus: 'idle',
  models: [],
  modelsStatus: 'idle',
  current: null,
  dirty: false,
  saveStatus: 'idle',
  error: null,
};

/** Vanilla store + actions; UI subscribes via zustand's useStore. */
export class ModelStore {
  readonly store: StoreApi<ModelStoreState>;

  constructor(private readonly api: DashboardsApi) {
    this.store = createStore<ModelStoreState>(() => ({ ...initialState }));
  }

  private set(patch: Partial<ModelStoreState>): void {
    this.store.setState(patch);
  }

  private get state(): ModelStoreState {
    return this.store.getState();
  }

  /** All mutations to the open model flow through here (marks dirty). */
  private mutateDefinition(mutate: (definition: ModelDefinition) => ModelDefinition): void {
    const current = this.state.current;
    if (!current) return;
    this.set({
      current: { ...current, definition: mutate(current.definition) },
      dirty: true,
    });
  }

  async loadConnections(): Promise<void> {
    this.set({ connectionsStatus: 'loading' });
    try {
      const connections = await this.api.listConnections();
      this.set({ connections, connectionsStatus: 'ok' });
    } catch (error) {
      this.set({ connectionsStatus: 'error', error: messageOf(error) });
    }
  }

  async loadCatalog(connection: string): Promise<void> {
    this.set({ catalogStatus: 'loading' });
    try {
      const catalog = await this.api.getCatalog(connection);
      this.set({ catalog, catalogStatus: 'ok' });
    } catch (error) {
      this.set({ catalogStatus: 'error', error: messageOf(error) });
    }
  }

  async loadModels(): Promise<void> {
    this.set({ modelsStatus: 'loading' });
    try {
      const models = await this.api.listModels();
      this.set({ models, modelsStatus: 'ok' });
    } catch (error) {
      this.set({ modelsStatus: 'error', error: messageOf(error) });
    }
  }

  async openModel(id: number): Promise<void> {
    const detail = await this.api.getModel(id);
    this.set({ current: toEditable(detail), dirty: false, saveStatus: 'idle', error: null });
    if (this.state.catalog?.connection !== detail.dataSourceName) {
      await this.loadCatalog(detail.dataSourceName);
    }
  }

  newModel(dataSourceName: string): void {
    this.set({
      current: {
        id: null,
        name: 'New model',
        description: null,
        dataSourceName,
        isShared: false,
        expectedUpdatedAtUtc: null,
        ownerIsMe: true,
        isSystem: false,
        definition: emptyDefinition(),
      },
      dirty: true,
      saveStatus: 'idle',
      error: null,
    });
    if (this.state.catalog?.connection !== dataSourceName) {
      void this.loadCatalog(dataSourceName);
    }
  }

  closeModel(): void {
    this.set({ current: null, dirty: false, saveStatus: 'idle', error: null });
  }

  setName(name: string): void {
    const current = this.state.current;
    if (!current) return;
    this.set({ current: { ...current, name }, dirty: true });
  }

  addTable(table: CatalogTable, position?: { x: number; y: number }): void {
    this.mutateDefinition((definition) => {
      const key = tableKey(table.schema, table.name);
      if (definition.tables.some((t) => tableKey(t.schema, t.name) === key)) return definition;
      return {
        ...definition,
        tables: [
          ...definition.tables,
          { schema: table.schema, name: table.name, position: position ?? { x: 80, y: 80 } },
        ],
      };
    });
  }

  removeTable(key: string): void {
    this.mutateDefinition((definition) => ({
      ...definition,
      tables: definition.tables.filter((t) => tableKey(t.schema, t.name) !== key),
      relationships: definition.relationships.filter(
        (r) => r.fromTable !== key && r.toTable !== key,
      ),
      measures: definition.measures.filter((m) => m.table !== key),
    }));
  }

  setTablePosition(key: string, position: { x: number; y: number }): void {
    this.mutateDefinition((definition) => ({
      ...definition,
      tables: definition.tables.map((t) =>
        tableKey(t.schema, t.name) === key ? { ...t, position } : t,
      ),
    }));
  }

  addRelationship(input: NewRelationshipInput): Relationship {
    const relationship: Relationship = {
      id: newId(),
      fromTable: input.fromTable,
      fromColumn: input.fromColumn,
      toTable: input.toTable,
      toColumn: input.toColumn,
      cardinality: input.cardinality ?? 'manyToOne',
      isActive: true,
      source: input.source ?? 'manual',
    };
    this.mutateDefinition((definition) => ({
      ...definition,
      relationships: [...definition.relationships, relationship],
    }));
    return relationship;
  }

  acceptSuggestion(suggestion: RelationshipSuggestion): void {
    this.addRelationship({
      fromTable: suggestion.fromTable,
      fromColumn: suggestion.fromColumn,
      toTable: suggestion.toTable,
      toColumn: suggestion.toColumn,
      source: 'fk',
    });
  }

  updateRelationship(id: string, patch: Partial<Omit<Relationship, 'id'>>): void {
    this.mutateDefinition((definition) => ({
      ...definition,
      relationships: definition.relationships.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  }

  /**
   * Swaps a relationship's endpoints (table + column together). The wire
   * format has no one-to-many value — 'from' is ALWAYS the many side — so the
   * UI expresses one-to-many as a many-to-one with swapped endpoints. Pure
   * local mutation; cannot introduce duplicates because the add path already
   * dedupes both orientations of an endpoint pair.
   */
  swapRelationshipDirection(id: string): void {
    this.mutateDefinition((definition) => ({
      ...definition,
      relationships: definition.relationships.map((r) =>
        r.id === id
          ? {
              ...r,
              fromTable: r.toTable,
              fromColumn: r.toColumn,
              toTable: r.fromTable,
              toColumn: r.fromColumn,
            }
          : r,
      ),
    }));
  }

  removeRelationship(id: string): void {
    this.mutateDefinition((definition) => ({
      ...definition,
      relationships: definition.relationships.filter((r) => r.id !== id),
    }));
  }

  addMeasure(measure: Omit<Measure, 'id'>): Measure {
    const withId: Measure = { ...measure, id: newId() };
    this.mutateDefinition((definition) => ({
      ...definition,
      measures: [...definition.measures, withId],
    }));
    return withId;
  }

  updateMeasure(id: string, patch: Partial<Omit<Measure, 'id'>>): void {
    this.mutateDefinition((definition) => ({
      ...definition,
      measures: definition.measures.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  }

  /**
   * Copies a measure (expression, filters, and metadata included) under a
   * deduped "… (copy)" name. Pure local mutation; returns the new measure, or
   * null when the id is unknown.
   */
  duplicateMeasure(id: string): Measure | null {
    const definition = this.state.current?.definition;
    const source = definition?.measures.find((m) => m.id === id);
    if (!definition || !source) return null;

    const taken = new Set(definition.measures.map((m) => m.name.toLowerCase()));
    let name = `${source.name} (copy)`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${source.name} (copy ${n})`;

    const copy: Measure = { ...source, id: newId(), name };
    this.mutateDefinition((current) => ({
      ...current,
      measures: [...current.measures, copy],
    }));
    return copy;
  }

  removeMeasure(id: string): void {
    this.mutateDefinition((definition) => ({
      ...definition,
      measures: definition.measures.filter((m) => m.id !== id),
    }));
  }

  addDateTable(def: DateTableDef): void {
    this.mutateDefinition((definition) => {
      const existing = definition.dateTables ?? [];
      if (existing.some((d) => d.name === def.name)) return definition;
      return { ...definition, dateTables: [...existing, def] };
    });
  }

  updateDateTable(name: string, patch: Partial<DateTableDef>): void {
    this.mutateDefinition((definition) => {
      const existing = definition.dateTables ?? [];
      if (!existing.some((d) => d.name === name)) return definition;
      const nextName = patch.name ?? name;
      // A rename re-points relationships at the new canonical key.
      const oldKey = dateTableKey(name);
      const newKey = dateTableKey(nextName);
      return {
        ...definition,
        dateTables: existing.map((d) => (d.name === name ? { ...d, ...patch } : d)),
        relationships:
          oldKey === newKey
            ? definition.relationships
            : definition.relationships.map((r) =>
                r.toTable === oldKey ? { ...r, toTable: newKey } : r,
              ),
      };
    });
  }

  removeDateTable(name: string): void {
    const key = dateTableKey(name);
    this.mutateDefinition((definition) => ({
      ...definition,
      dateTables: (definition.dateTables ?? []).filter((d) => d.name !== name),
      relationships: definition.relationships.filter(
        (r) => r.fromTable !== key && r.toTable !== key,
      ),
    }));
  }

  async save(): Promise<boolean> {
    const current = this.state.current;
    if (!current) return false;

    this.set({ saveStatus: 'loading', error: null });
    try {
      const body = {
        name: current.name,
        description: current.description,
        dataSourceName: current.dataSourceName,
        definition: current.definition,
        isShared: current.isShared,
        expectedUpdatedAtUtc: current.expectedUpdatedAtUtc,
      };
      const saved =
        current.id === null
          ? await this.api.createModel(body)
          : await this.api.updateModel(current.id, body);
      this.set({ current: toEditable(saved), dirty: false, saveStatus: 'ok' });
      void this.loadModels();
      return true;
    } catch (error) {
      this.set({ saveStatus: 'error', error: messageOf(error) });
      return false;
    }
  }
}

const toEditable = (detail: ModelDetail): EditableModel => ({
  id: detail.id,
  name: detail.name,
  description: detail.description,
  dataSourceName: detail.dataSourceName,
  isShared: detail.isShared,
  expectedUpdatedAtUtc: detail.updatedAtUtc,
  ownerIsMe: detail.ownerIsMe,
  isSystem: detail.isSystem ?? false,
  definition: detail.definition,
});

const messageOf = (error: unknown): string => {
  if (error instanceof RcdApiError) {
    const issueText = error.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join(' ');
    return issueText ? `${error.message} ${issueText}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
};
