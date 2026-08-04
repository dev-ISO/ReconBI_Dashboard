import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartSpec } from '../types/chart';
import {
  emptyLayout,
  isSlicerTile,
  mergedSlicerFilters,
  type CrossFilter,
  type DashboardDetail,
  type DashboardLayoutDoc,
  type DashboardSummary,
  type DashboardTile,
  type SlicerTileSpec,
  type SlicerValues,
  type SlicerVariant,
} from '../types/dashboard';
import type { FilterClause } from '../types/query';
import { stableStringify } from '../util/hash';
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
  /** Transient click-to-highlight filter; NOT persisted with the layout. */
  crossFilter: CrossFilter | null;
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
  crossFilter: null,
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
      crossFilter: null,
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
      crossFilter: null,
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
    // Defensive: a removed slicer tile must not keep filtering charts.
    if (tileId in this.state.slicerValues) {
      const { [tileId]: _removed, ...rest } = this.state.slicerValues;
      this.set({ slicerValues: rest });
    }
    // Same for a removed cross-filter source chart.
    if (this.state.crossFilter?.sourceTileId === tileId) {
      this.set({ crossFilter: null });
    }
  }

  duplicateTile(tileId: string): void {
    this.mutateLayout((layout) => {
      const source = layout.tiles.find((t) => t.id === tileId);
      if (!source) return layout;
      // Free placement (no auto-compaction): drop the copy below ALL content
      // so it can never overlap an existing tile.
      const maxY = layout.tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const copy: DashboardTile = {
        id: newId(),
        layout: { ...source.layout, x: source.layout.x, y: maxY },
        ...(source.kind ? { kind: source.kind } : {}),
        ...(source.chart
          ? {
              chart: structuredClone({
                ...source.chart,
                id: newId(),
                title: `${source.chart.title} (copy)`,
              }),
            }
          : {}),
        ...(source.slicer
          ? { slicer: structuredClone({ ...source.slicer, label: `${source.slicer.label} (copy)` }) }
          : {}),
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

  /** Adds a slicer TILE (grid citizen like charts); variant defaults to checklist. */
  addSlicer(def: { table: string; column: string; label: string; variant?: SlicerVariant }): void {
    this.mutateLayout((layout) => {
      const maxY = layout.tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'slicer',
        layout: { x: 0, y: maxY, w: 6, h: 5, minW: 3, minH: 3 },
        slicer: {
          table: def.table,
          column: def.column,
          label: def.label,
          variant: def.variant ?? 'checklist',
        },
      };
      return { ...layout, tiles: [...layout.tiles, tile] };
    });
  }

  /** Patches a slicer tile's spec (variant, label, targets, showClear). */
  updateSlicer(tileId: string, patch: Partial<SlicerTileSpec>): void {
    this.mutateLayout((layout) => ({
      ...layout,
      tiles: layout.tiles.map((t) =>
        t.id === tileId && t.slicer ? { ...t, slicer: { ...t.slicer, ...patch } } : t,
      ),
    }));
  }

  /** Removes a slicer tile and its selection. */
  removeSlicer(tileId: string): void {
    this.removeTile(tileId);
  }

  setSlicerValue(slicerId: string, clause: FilterClause | null): void {
    this.set({ slicerValues: { ...this.state.slicerValues, [slicerId]: clause } });
  }

  /**
   * Activates the click-to-highlight cross-filter emitted by a chart tile.
   * Clicking the SAME datum on the same source again (same source tile +
   * structurally identical clause, compared via stableStringify) toggles it
   * off; any other click replaces the active filter (one at a time, v1).
   */
  setCrossFilter(
    sourceTileId: string,
    clause: FilterClause,
    label: string,
    categoryLabel: string,
  ): void {
    const active = this.state.crossFilter;
    if (
      active &&
      active.sourceTileId === sourceTileId &&
      stableStringify(active.clause) === stableStringify(clause)
    ) {
      this.set({ crossFilter: null });
      return;
    }
    this.set({ crossFilter: { sourceTileId, clause, label, categoryLabel } });
  }

  clearCrossFilter(): void {
    if (this.state.crossFilter !== null) this.set({ crossFilter: null });
  }

  /** Filters every tile query must include (all slicer selections). */
  activeFilters(): FilterClause[] {
    return mergedSlicerFilters(this.state.slicerValues);
  }

  /**
   * Filters a specific chart tile must include: the union of selections from
   * slicer tiles whose targets are null/absent (all charts) or include tileId,
   * plus the active cross-filter when this tile is not its source. The source
   * chart never filters itself, and slicer targeting does NOT constrain
   * cross-filters — a datum click highlights every other chart regardless of
   * any slicer's "applies to" list.
   */
  filtersForTile(tileId: string): FilterClause[] {
    const layout = this.state.current?.layout;
    if (!layout) return [];
    const clauses: FilterClause[] = [];
    for (const tile of layout.tiles) {
      if (!isSlicerTile(tile)) continue;
      const targets = tile.slicer.targets;
      if (targets != null && !targets.includes(tileId)) continue;
      const clause = this.state.slicerValues[tile.id];
      if (clause != null) clauses.push(clause);
    }
    const cross = this.state.crossFilter;
    if (cross && cross.sourceTileId !== tileId) clauses.push(cross.clause);
    return clauses;
  }

  /** View-mode auto-refresh interval (persisted with the layout on save). */
  setRefreshSeconds(seconds: number | null): void {
    this.mutateLayout((layout) => ({ ...layout, refreshSeconds: seconds }));
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
  layout: migrateSlicers(detail.layout?.tiles ? detail.layout : emptyLayout()),
});

/**
 * Migrates legacy top-bar slicers (layout.slicers[]) into checklist slicer
 * TILES appended below all content (free canvas, no pushing — they can never
 * overlap), then empties slicers[]. Idempotent: migrated docs re-open clean.
 * The migration is in-memory only until the user saves.
 */
const migrateSlicers = (layout: DashboardLayoutDoc): DashboardLayoutDoc => {
  const legacy = layout.slicers ?? [];
  if (legacy.length === 0) return layout.slicers ? layout : { ...layout, slicers: [] };
  const maxY = layout.tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
  const migrated: DashboardTile[] = legacy.map((def, index) => ({
    id: def.id,
    kind: 'slicer',
    layout: {
      x: (index % 4) * 6,
      y: maxY + Math.floor(index / 4) * 4,
      w: 6,
      h: 4,
      minW: 3,
      minH: 3,
    },
    slicer: { table: def.table, column: def.column, label: def.label, variant: 'checklist' },
  }));
  return { ...layout, tiles: [...layout.tiles, ...migrated], slicers: [] };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
