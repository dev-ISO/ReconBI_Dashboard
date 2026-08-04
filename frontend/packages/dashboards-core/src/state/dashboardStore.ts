import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartSpec } from '../types/chart';
import {
  emptyLayout,
  mergedSlicerFilters,
  type DashboardDetail,
  type DashboardLayoutDoc,
  type DashboardSummary,
  type DashboardTile,
  type SlicerValues,
} from '../types/dashboard';
import type { FilterClause } from '../types/query';
import { newId } from '../util/ids';
import type { AsyncStatus } from './modelStore';

export interface OpenDashboard {
  id: number;
  name: string;
  description: string | null;
  modelId: number | null;
  isShared: boolean;
  ownerIsMe: boolean;
  expectedUpdatedAtUtc: string;
  layout: DashboardLayoutDoc;
}

export interface DashboardStoreState {
  list: DashboardSummary[];
  listStatus: AsyncStatus;
  current: OpenDashboard | null;
  mode: 'view' | 'edit';
  dirty: boolean;
  /** structuredClone snapshot taken on enterEdit; discardEdits restores it. */
  draftBackup: OpenDashboard | null;
  selectedTileId: string | null;
  slicerValues: SlicerValues;
  saveStatus: AsyncStatus;
  error: string | null;
}

const initialState: DashboardStoreState = {
  list: [],
  listStatus: 'idle',
  current: null,
  mode: 'view',
  dirty: false,
  draftBackup: null,
  selectedTileId: null,
  slicerValues: {},
  saveStatus: 'idle',
  error: null,
};

export class DashboardStore {
  readonly store: StoreApi<DashboardStoreState>;

  constructor(private readonly api: DashboardsApi) {
    this.store = createStore<DashboardStoreState>(() => ({ ...initialState }));
  }

  private set(patch: Partial<DashboardStoreState>): void {
    this.store.setState(patch);
  }

  private get state(): DashboardStoreState {
    return this.store.getState();
  }

  private mutateLayout(mutate: (layout: DashboardLayoutDoc) => DashboardLayoutDoc): void {
    const current = this.state.current;
    if (!current) return;
    this.set({ current: { ...current, layout: mutate(current.layout) }, dirty: true });
  }

  async loadList(): Promise<void> {
    this.set({ listStatus: 'loading' });
    try {
      const list = await this.api.listDashboards();
      this.set({ list, listStatus: 'ok' });
    } catch (error) {
      this.set({ listStatus: 'error', error: messageOf(error) });
    }
  }

  async open(id: number): Promise<void> {
    const detail = await this.api.getDashboard(id);
    this.set({
      current: toOpen(detail),
      mode: 'view',
      dirty: false,
      draftBackup: null,
      selectedTileId: null,
      slicerValues: {},
      saveStatus: 'idle',
      error: null,
    });
  }

  async create(name: string, modelId: number | null): Promise<number | null> {
    this.set({ saveStatus: 'loading', error: null });
    try {
      const detail = await this.api.createDashboard({ name, modelId, layout: emptyLayout() });
      this.set({ current: toOpen(detail), mode: 'edit', dirty: false, saveStatus: 'ok' });
      void this.loadList();
      return detail.id;
    } catch (error) {
      this.set({ saveStatus: 'error', error: messageOf(error) });
      return null;
    }
  }

  close(): void {
    this.set({ ...initialState, list: this.state.list, listStatus: this.state.listStatus });
  }

  enterEdit(): void {
    const current = this.state.current;
    if (!current) return;
    this.set({ mode: 'edit', draftBackup: structuredClone(current) });
  }

  discardEdits(): void {
    const backup = this.state.draftBackup;
    this.set({
      mode: 'view',
      dirty: false,
      draftBackup: null,
      selectedTileId: null,
      ...(backup ? { current: backup } : {}),
    });
  }

  async save(): Promise<boolean> {
    const current = this.state.current;
    if (!current) return false;

    this.set({ saveStatus: 'loading', error: null });
    try {
      const saved = await this.api.updateDashboard(current.id, {
        name: current.name,
        description: current.description,
        modelId: current.modelId,
        layout: current.layout,
        isShared: current.isShared,
        expectedUpdatedAtUtc: current.expectedUpdatedAtUtc,
      });
      this.set({
        current: toOpen(saved),
        mode: 'view',
        dirty: false,
        draftBackup: null,
        saveStatus: 'ok',
      });
      void this.loadList();
      return true;
    } catch (error) {
      this.set({ saveStatus: 'error', error: messageOf(error) });
      return false;
    }
  }

  addTile(chart: ChartSpec): void {
    this.mutateLayout((layout) => {
      const maxY = layout.tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        layout: { x: 0, y: maxY, w: 12, h: 8, minW: 4, minH: 4 },
        chart,
      };
      return { ...layout, tiles: [...layout.tiles, tile] };
    });
  }

  updateChart(tileId: string, chart: ChartSpec): void {
    this.mutateLayout((layout) => ({
      ...layout,
      tiles: layout.tiles.map((t) => (t.id === tileId ? { ...t, chart } : t)),
    }));
  }

  removeTile(tileId: string): void {
    this.mutateLayout((layout) => ({
      ...layout,
      tiles: layout.tiles.filter((t) => t.id !== tileId),
    }));
    if (this.state.selectedTileId === tileId) {
      this.set({ selectedTileId: null });
    }
  }

  duplicateTile(tileId: string): void {
    this.mutateLayout((layout) => {
      const source = layout.tiles.find((t) => t.id === tileId);
      if (!source) return layout;
      const copy: DashboardTile = {
        id: newId(),
        layout: { ...source.layout, y: source.layout.y + source.layout.h },
        chart: structuredClone({ ...source.chart, id: newId(), title: `${source.chart.title} (copy)` }),
      };
      return { ...layout, tiles: [...layout.tiles, copy] };
    });
  }

  /** Grid callback: items carry tile ids + new geometry. */
  applyLayout(items: { id: string; x: number; y: number; w: number; h: number }[]): void {
    const byId = new Map(items.map((i) => [i.id, i]));
    this.mutateLayout((layout) => ({
      ...layout,
      tiles: layout.tiles.map((tile) => {
        const next = byId.get(tile.id);
        if (!next) return tile;
        const changed =
          next.x !== tile.layout.x ||
          next.y !== tile.layout.y ||
          next.w !== tile.layout.w ||
          next.h !== tile.layout.h;
        return changed
          ? { ...tile, layout: { ...tile.layout, x: next.x, y: next.y, w: next.w, h: next.h } }
          : tile;
      }),
    }));
  }

  selectTile(tileId: string | null): void {
    this.set({ selectedTileId: tileId });
  }

  addSlicer(def: { table: string; column: string; label: string }): void {
    this.mutateLayout((layout) => ({
      ...layout,
      slicers: [...layout.slicers, { ...def, id: newId() }],
    }));
  }

  removeSlicer(slicerId: string): void {
    this.mutateLayout((layout) => ({
      ...layout,
      slicers: layout.slicers.filter((s) => s.id !== slicerId),
    }));
    const { [slicerId]: _removed, ...rest } = this.state.slicerValues;
    this.set({ slicerValues: rest });
  }

  setSlicerValue(slicerId: string, clause: FilterClause | null): void {
    this.set({ slicerValues: { ...this.state.slicerValues, [slicerId]: clause } });
  }

  /** Filters every tile query must include (slicer selections). */
  activeFilters(): FilterClause[] {
    return mergedSlicerFilters(this.state.slicerValues);
  }
}

const toOpen = (detail: DashboardDetail): OpenDashboard => ({
  id: detail.id,
  name: detail.name,
  description: detail.description,
  modelId: detail.modelId,
  isShared: detail.isShared,
  ownerIsMe: detail.ownerIsMe,
  expectedUpdatedAtUtc: detail.updatedAtUtc,
  layout: detail.layout?.tiles ? detail.layout : emptyLayout(),
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
