import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartSpec } from '../types/chart';
import {
  emptyLayout,
  filterCardClauses,
  isSlicerTile,
  type CrossFilter,
  type DashboardDetail,
  type DashboardLayoutDoc,
  type DashboardBookmark,
  type DashboardPage,
  type DashboardSummary,
  type DashboardTile,
  type DrillthroughState,
  type FilterCard,
  type PageDrillthrough,
  type ImageTileSpec,
  type SlicerTileSpec,
  type SlicerValues,
  type SlicerVariant,
  type TextTileSpec,
} from '../types/dashboard';
import type { FilterClause, FilterValue } from '../types/query';
import { stableStringify } from '../util/hash';
import { newId } from '../util/ids';
import { sanitizeRichHtml } from '../util/richText';
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
  /** Page whose tiles render and receive ALL tile operations. */
  activePageId: string | null;
  selectedTileId: string | null;
  /**
   * Slicer selections keyed by slicer TILE id. The map stays global (tile ids
   * are unique across pages) so selections persist while switching pages;
   * page scoping happens in filtersForTile, which only consults slicers that
   * live on the target tile's page.
   */
  slicerValues: SlicerValues;
  /** Transient click-to-highlight filter; NOT persisted; reset on page switch. */
  crossFilter: CrossFilter | null;
  /**
   * Transient drillthrough context (set by invoking "Drill through" from a
   * point menu). NEVER persisted; its filters reach every chart tile on the
   * TARGET page via filtersForTile. Survives page switches so revisiting the
   * target page keeps its context until explicitly cleared.
   */
  drillthrough: DrillthroughState | null;
  /**
   * Bookmark whose applied state is still current — shows a check in the
   * Bookmarks menu; cleared by any slicer/filter/page change. Runtime only.
   */
  lastAppliedBookmarkId: string | null;
  /**
   * View-mode personal tweaks to filter cards (enable/disable + basic
   * selections), keyed by card id. NEVER persisted — viewers adjust filters
   * without editing the dashboard (Power BI-like). Cleared on open/close and
   * on enterEdit (edit mode always shows/writes the authored doc state).
   */
  filterCardOverrides: Record<string, FilterCardOverride>;
  saveStatus: AsyncStatus;
  error: string | null;
}

/** The subset of FilterCard a viewer may tweak transiently in view mode. */
export interface FilterCardOverride {
  disabled?: boolean;
  basicValues?: FilterValue[] | null;
}

const initialState: DashboardStoreState = {
  list: [],
  listStatus: 'idle',
  current: null,
  mode: 'view',
  dirty: false,
  draftBackup: null,
  activePageId: null,
  selectedTileId: null,
  slicerValues: {},
  crossFilter: null,
  drillthrough: null,
  lastAppliedBookmarkId: null,
  filterCardOverrides: {},
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

  private mutatePages(mutate: (pages: DashboardPage[]) => DashboardPage[]): void {
    this.mutateLayout((layout) => ({ ...layout, pages: mutate(pagesOf(layout)) }));
  }

  /** Applies a tile-list mutation to the ACTIVE page (all tile ops route here). */
  private mutateActiveTiles(mutate: (tiles: DashboardTile[]) => DashboardTile[]): void {
    const activePageId = this.state.activePageId;
    this.mutatePages((pages) =>
      pages.map((page) => (page.id === activePageId ? { ...page, tiles: mutate(page.tiles) } : page)),
    );
  }

  /** Tiles of the active page ([] before a dashboard is open). */
  private activeTiles(): DashboardTile[] {
    const layout = this.state.current?.layout;
    if (!layout) return [];
    return pagesOf(layout).find((page) => page.id === this.state.activePageId)?.tiles ?? [];
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
    const current = toOpen(detail);
    this.set({
      current,
      mode: 'view',
      dirty: false,
      draftBackup: null,
      activePageId: firstPageId(current.layout),
      selectedTileId: null,
      slicerValues: {},
      crossFilter: null,
      drillthrough: null,
      lastAppliedBookmarkId: null,
      filterCardOverrides: {},
      saveStatus: 'idle',
      error: null,
    });
  }

  async create(name: string, modelId: number | null): Promise<number | null> {
    this.set({ saveStatus: 'loading', error: null });
    try {
      const detail = await this.api.createDashboard({ name, modelId, layout: emptyLayout() });
      const current = toOpen(detail);
      this.set({
        current,
        mode: 'edit',
        dirty: false,
        activePageId: firstPageId(current.layout),
        saveStatus: 'ok',
      });
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
    // View-mode filter tweaks are personal state — edit mode always shows and
    // mutates the authored doc, so overrides reset here.
    this.set({ mode: 'edit', draftBackup: structuredClone(current), filterCardOverrides: {} });
  }

  discardEdits(): void {
    const backup = this.state.draftBackup;
    this.set({
      mode: 'view',
      dirty: false,
      draftBackup: null,
      selectedTileId: null,
      crossFilter: null,
      // The restore may drop pages/bookmarks these transients reference.
      drillthrough: null,
      lastAppliedBookmarkId: null,
      // Pages added during the edit vanish with the restore — fall back to a
      // page that exists in the backup when the active one is among them.
      ...(backup
        ? {
            current: backup,
            activePageId: resolveActivePageId(backup.layout, this.state.activePageId),
          }
        : {}),
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
      const next = toOpen(saved);
      this.set({
        current: next,
        mode: 'view',
        dirty: false,
        draftBackup: null,
        // Page ids survive the round-trip, so the user stays on their page.
        activePageId: resolveActivePageId(next.layout, this.state.activePageId),
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
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        layout: { x: 0, y: maxY, w: 12, h: 8, minW: 4, minH: 4 },
        chart,
      };
      return [...tiles, tile];
    });
  }

  updateChart(tileId: string, chart: ChartSpec): void {
    this.mutateActiveTiles((tiles) => tiles.map((t) => (t.id === tileId ? { ...t, chart } : t)));
  }

  removeTile(tileId: string): void {
    this.mutateActiveTiles((tiles) => tiles.filter((t) => t.id !== tileId));
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
    // Visual-scope filter cards targeting the removed tile go with it.
    const cards = this.state.current?.layout.filterCards ?? [];
    if (cards.some((c) => c.scope === 'visual' && c.targetTileId === tileId)) {
      this.mutateFilterCards((all) =>
        all.filter((c) => !(c.scope === 'visual' && c.targetTileId === tileId)),
      );
    }
  }

  duplicateTile(tileId: string): void {
    this.mutateActiveTiles((tiles) => {
      const source = tiles.find((t) => t.id === tileId);
      if (!source) return tiles;
      // Free placement (no auto-compaction): drop the copy below ALL content
      // so it can never overlap an existing tile.
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
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
        ...(source.text ? { text: structuredClone(source.text) } : {}),
        ...(source.image ? { image: structuredClone(source.image) } : {}),
      };
      return [...tiles, copy];
    });
  }

  /** Grid callback: items carry tile ids + new geometry (active page only). */
  applyLayout(items: { id: string; x: number; y: number; w: number; h: number }[]): void {
    const byId = new Map(items.map((i) => [i.id, i]));
    this.mutateActiveTiles((tiles) =>
      tiles.map((tile) => {
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
    );
  }

  selectTile(tileId: string | null): void {
    this.set({ selectedTileId: tileId });
  }

  /** Adds a slicer TILE to the active page; variant defaults to checklist. */
  addSlicer(def: { table: string; column: string; label: string; variant?: SlicerVariant }): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
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
      return [...tiles, tile];
    });
  }

  /** Patches a slicer tile's spec (variant, label, targets, showClear). */
  updateSlicer(tileId: string, patch: Partial<SlicerTileSpec>): void {
    this.mutateActiveTiles((tiles) =>
      tiles.map((t) => (t.id === tileId && t.slicer ? { ...t, slicer: { ...t.slicer, ...patch } } : t)),
    );
  }

  /** Removes a slicer tile and its selection. */
  removeSlicer(tileId: string): void {
    this.removeTile(tileId);
  }

  setSlicerValue(slicerId: string, clause: FilterClause | null): void {
    // Any slicer change diverges from the last-applied bookmark's snapshot.
    this.set({
      slicerValues: { ...this.state.slicerValues, [slicerId]: clause },
      lastAppliedBookmarkId: null,
    });
  }

  /* -------------------------------------------------------- text/image tiles */

  /** Adds a rich-text tile to the active page (default placeholder content). */
  addTextTile(): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'text',
        layout: { x: 0, y: maxY, w: 8, h: 4, minW: 2, minH: 2 },
        text: { html: sanitizeRichHtml('<p>Text</p>') },
      };
      return [...tiles, tile];
    });
  }

  /** Adds an image tile to the active page (spec built by the add dialog). */
  addImageTile(spec: ImageTileSpec): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'image',
        layout: { x: 0, y: maxY, w: 8, h: 6, minW: 2, minH: 2 },
        image: { ...spec, src: safeImageSrc(spec.src) },
      };
      return [...tiles, tile];
    });
  }

  /** Patches a text tile's spec; html always passes through the sanitizer. */
  updateTextTile(tileId: string, patch: Partial<TextTileSpec>): void {
    const safe = patch.html === undefined ? patch : { ...patch, html: sanitizeRichHtml(patch.html) };
    this.mutateActiveTiles((tiles) =>
      tiles.map((t) => (t.id === tileId && t.text ? { ...t, text: { ...t.text, ...safe } } : t)),
    );
  }

  /** Patches an image tile's spec; src is re-validated (data:image / https only). */
  updateImageTile(tileId: string, patch: Partial<ImageTileSpec>): void {
    const safe = patch.src === undefined ? patch : { ...patch, src: safeImageSrc(patch.src) };
    this.mutateActiveTiles((tiles) =>
      tiles.map((t) => (t.id === tileId && t.image ? { ...t, image: { ...t.image, ...safe } } : t)),
    );
  }

  /* ------------------------------------------------------------------ pages */

  /** Appends an empty page (auto "Page N") and makes it active. */
  addPage(name?: string): void {
    const current = this.state.current;
    if (!current) return;
    const pages = pagesOf(current.layout);
    const page: DashboardPage = {
      id: newId(),
      name: name?.trim() || nextPageName(pages),
      tiles: [],
    };
    this.set({
      current: { ...current, layout: { ...current.layout, pages: [...pages, page] } },
      dirty: true,
      activePageId: page.id,
      selectedTileId: null,
      crossFilter: null,
    });
  }

  renamePage(pageId: string, name: string): void {
    const next = name.trim();
    if (next === '') return;
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page || page.name === next) return;
    this.mutatePages((pages) => pages.map((p) => (p.id === pageId ? { ...p, name: next } : p)));
  }

  /** Sets the tab accent color (fixed palette hex) or clears it with null. */
  setPageColor(pageId: string, color: string | null): void {
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page || (page.color ?? null) === color) return;
    this.mutatePages((pages) => pages.map((p) => (p.id === pageId ? { ...p, color } : p)));
  }

  /**
   * Removes a page and every tile on it. No-op while it is the only page.
   * Removing the active page activates its right neighbor (left when it was
   * last). Slicer selections of the removed page's tiles are dropped; the
   * cross-filter clears when its source lived there.
   */
  removePage(pageId: string): void {
    const current = this.state.current;
    if (!current) return;
    const pages = pagesOf(current.layout);
    if (pages.length <= 1) return;
    const index = pages.findIndex((p) => p.id === pageId);
    const removed = index === -1 ? undefined : pages[index];
    if (!removed) return;
    const nextPages = pages.filter((p) => p.id !== pageId);
    const neighbor = nextPages[Math.min(index, nextPages.length - 1)] ?? nextPages[0];
    const removedIds = new Set(removed.tiles.map((t) => t.id));
    const cross = this.state.crossFilter;
    const selected = this.state.selectedTileId;
    // The removed page's page-scope cards and visual-scope cards targeting its
    // tiles are orphans — drop them (all-pages cards survive, of course).
    const cards = current.layout.filterCards ?? [];
    const nextCards = cards.filter(
      (c) =>
        !(c.scope === 'page' && c.pageId === pageId) &&
        !(c.scope === 'visual' && c.targetTileId != null && removedIds.has(c.targetTileId)),
    );
    this.set({
      current: {
        ...current,
        layout: {
          ...current.layout,
          pages: nextPages,
          ...(nextCards.length !== cards.length ? { filterCards: nextCards } : {}),
        },
      },
      dirty: true,
      activePageId:
        this.state.activePageId === pageId ? (neighbor?.id ?? null) : this.state.activePageId,
      slicerValues: Object.fromEntries(
        Object.entries(this.state.slicerValues).filter(([id]) => !removedIds.has(id)),
      ),
      crossFilter: cross && removedIds.has(cross.sourceTileId) ? null : cross,
      // Drillthrough context tied to the removed page (either end) is orphaned.
      drillthrough:
        this.state.drillthrough &&
        (this.state.drillthrough.sourcePageId === pageId ||
          this.state.drillthrough.targetPageId === pageId)
          ? null
          : this.state.drillthrough,
      selectedTileId: selected !== null && removedIds.has(selected) ? null : selected,
    });
  }

  /**
   * Switches the visible page. The transient cross-filter resets (its source
   * chart is no longer on screen); slicer selections persist per their tiles
   * and re-apply when their page is revisited. Never dirties the draft.
   */
  setActivePage(pageId: string): void {
    if (pageId === this.state.activePageId) return;
    const current = this.state.current;
    if (!current || !pagesOf(current.layout).some((p) => p.id === pageId)) return;
    // Page changes diverge from the last-applied bookmark (it captures pageId).
    this.set({
      activePageId: pageId,
      crossFilter: null,
      selectedTileId: null,
      lastAppliedBookmarkId: null,
    });
  }

  /** Sets or clears a page's drillthrough target config (persisted with the doc). */
  setPageDrillthrough(pageId: string, drillthrough: PageDrillthrough | null): void {
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page) return;
    if (stableStringify(page.drillthrough ?? null) === stableStringify(drillthrough)) return;
    this.mutatePages((pages) =>
      pages.map((p) => {
        if (p.id !== pageId) return p;
        if (drillthrough !== null) return { ...p, drillthrough };
        const { drillthrough: _removed, ...rest } = p;
        return rest;
      }),
    );
  }

  /** Reorders a page one slot left/right (tab drag-free reordering). */
  movePage(pageId: string, direction: 'left' | 'right'): void {
    const current = this.state.current;
    if (!current) return;
    const pages = pagesOf(current.layout);
    const index = pages.findIndex((p) => p.id === pageId);
    if (index === -1) return;
    const target = direction === 'left' ? index - 1 : index + 1;
    if (target < 0 || target >= pages.length) return;
    this.mutatePages((all) => {
      const next = [...all];
      const [page] = next.splice(index, 1);
      if (!page) return all;
      next.splice(target, 0, page);
      return next;
    });
  }

  /* ----------------------------------------------------------- filter cards */

  private mutateFilterCards(mutate: (cards: FilterCard[]) => FilterCard[]): void {
    this.mutateLayout((layout) => ({ ...layout, filterCards: mutate(layout.filterCards ?? []) }));
  }

  /** Card with any view-mode personal overrides applied. */
  private effectiveFilterCard(card: FilterCard): FilterCard {
    const override = this.state.filterCardOverrides[card.id];
    if (!override) return card;
    return {
      ...card,
      ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
      ...(override.basicValues !== undefined ? { basicValues: override.basicValues } : {}),
    };
  }

  /** Adds a Filters-pane card (id assigned here); returns the new id. */
  addFilterCard(card: Omit<FilterCard, 'id'>): string {
    const id = newId();
    this.mutateFilterCards((cards) => [...cards, { ...card, id }]);
    return id;
  }

  /**
   * Patches a card. Edit mode writes the layout doc. View mode routes to the
   * TRANSIENT overrides and honors only `disabled` / `basicValues` — viewers
   * tweak filters without editing the dashboard; anything else is ignored.
   */
  updateFilterCard(id: string, patch: Partial<Omit<FilterCard, 'id'>>): void {
    if (this.state.mode === 'view') {
      if (patch.disabled === undefined && patch.basicValues === undefined) return;
      const override: FilterCardOverride = {
        ...this.state.filterCardOverrides[id],
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
        ...(patch.basicValues !== undefined ? { basicValues: patch.basicValues } : {}),
      };
      // Filter tweaks diverge from the last-applied bookmark's snapshot.
      this.set({
        filterCardOverrides: { ...this.state.filterCardOverrides, [id]: override },
        lastAppliedBookmarkId: null,
      });
      return;
    }
    this.mutateFilterCards((cards) => cards.map((c) => (c.id === id ? { ...c, ...patch, id } : c)));
    this.set({ lastAppliedBookmarkId: null });
  }

  /** Removes a card (and any transient override riding on it). */
  removeFilterCard(id: string): void {
    this.mutateFilterCards((cards) => cards.filter((c) => c.id !== id));
    if (id in this.state.filterCardOverrides) {
      const { [id]: _removed, ...rest } = this.state.filterCardOverrides;
      this.set({ filterCardOverrides: rest });
    }
  }

  /** Flips a card's enabled state (view mode: transient override, not the doc). */
  toggleFilterCard(id: string): void {
    const card = (this.state.current?.layout.filterCards ?? []).find((c) => c.id === id);
    if (!card) return;
    this.updateFilterCard(id, { disabled: !(this.effectiveFilterCard(card).disabled ?? false) });
  }

  /**
   * Cards the Filters pane lists for a page: all-pages cards, the page's own
   * page-scope cards, and visual-scope cards whose target tile lives on the
   * page. View-mode overrides are already applied; doc order is preserved.
   */
  visibleFilterCards(pageId: string | null): FilterCard[] {
    const layout = this.state.current?.layout;
    if (!layout || pageId === null) return [];
    const tileIds = new Set(
      (pagesOf(layout).find((p) => p.id === pageId)?.tiles ?? []).map((t) => t.id),
    );
    return (layout.filterCards ?? [])
      .filter(
        (card) =>
          card.scope === 'allPages' ||
          (card.scope === 'page' && card.pageId === pageId) ||
          (card.scope === 'visual' && card.targetTileId != null && tileIds.has(card.targetTileId)),
      )
      .map((card) => this.effectiveFilterCard(card));
  }

  /* -------------------------------------------------------------- filtering */

  /**
   * Activates the click-to-highlight cross-filter emitted by a chart tile.
   * Clicking the SAME datum on the same source again (same source tile +
   * structurally identical clause, compared via stableStringify) toggles it
   * off; any other click replaces the active filter (one at a time, v1).
   * `kind` records what was clicked on the source ('axis' datum by default;
   * 'legend' for legendMode 'crossFilter' selections) — the filtering path is
   * identical, only the source tile's emphasis rendering differs.
   */
  setCrossFilter(
    sourceTileId: string,
    clause: FilterClause,
    label: string,
    categoryLabel: string,
    kind: 'axis' | 'legend' = 'axis',
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
    this.set({ crossFilter: { sourceTileId, clause, label, categoryLabel, kind } });
  }

  clearCrossFilter(): void {
    if (this.state.crossFilter !== null) this.set({ crossFilter: null });
  }

  /** Selections of the ACTIVE page's slicer tiles (other pages' slicers do not leak). */
  activeFilters(): FilterClause[] {
    const clauses: FilterClause[] = [];
    for (const tile of this.activeTiles()) {
      if (!isSlicerTile(tile)) continue;
      const clause = this.state.slicerValues[tile.id];
      if (clause != null) clauses.push(clause);
    }
    return clauses;
  }

  /**
   * Filters a specific chart tile must include: the union of selections from
   * slicer tiles ON THE SAME PAGE whose targets are null/absent (all charts)
   * or include tileId, plus the active cross-filter when this tile is not its
   * source. Slicers never reach across pages; targets semantics are unchanged
   * within a page. The source chart never filters itself, and slicer targeting
   * does NOT constrain cross-filters — a datum click highlights every other
   * chart on the page regardless of any slicer's "applies to" list.
   *
   * Filter-pane cards additionally contribute (enabled cards only, view-mode
   * overrides applied): all-pages cards always; page-scope cards when their
   * pageId is the page the tile lives on; visual-scope cards when they target
   * exactly this tile.
   */
  filtersForTile(tileId: string): FilterClause[] {
    const layout = this.state.current?.layout;
    if (!layout) return [];
    const page = pagesOf(layout).find((p) => p.tiles.some((t) => t.id === tileId));
    const clauses: FilterClause[] = [];
    for (const tile of page?.tiles ?? []) {
      if (!isSlicerTile(tile)) continue;
      const targets = tile.slicer.targets;
      if (targets != null && !targets.includes(tileId)) continue;
      const clause = this.state.slicerValues[tile.id];
      if (clause != null) clauses.push(clause);
    }
    for (const card of layout.filterCards ?? []) {
      const effective = this.effectiveFilterCard(card);
      if (effective.disabled) continue;
      const applies =
        effective.scope === 'allPages' ||
        (effective.scope === 'page' && page !== undefined && effective.pageId === page.id) ||
        (effective.scope === 'visual' && effective.targetTileId === tileId);
      if (applies) clauses.push(...filterCardClauses(effective));
    }
    // Transient drillthrough context: every chart tile on the TARGET page
    // receives its clauses (same merge path as slicers/cards — nothing new for
    // ChartTile to learn about).
    const drillthrough = this.state.drillthrough;
    if (drillthrough && page !== undefined && page.id === drillthrough.targetPageId) {
      clauses.push(...drillthrough.filters);
    }
    const cross = this.state.crossFilter;
    if (cross && cross.sourceTileId !== tileId) clauses.push(cross.clause);
    return clauses;
  }

  /* ------------------------------------------------------------ drillthrough */

  /**
   * Activates a drillthrough: switches to the target page and stores the
   * transient context (source page for "← Back", eq clauses from the clicked
   * point). Never persisted.
   */
  startDrillthrough(targetPageId: string, filters: FilterClause[], label: string): void {
    const current = this.state.current;
    if (!current || !pagesOf(current.layout).some((p) => p.id === targetPageId)) return;
    const sourcePageId = this.state.activePageId ?? targetPageId;
    if (targetPageId === sourcePageId) return;
    this.set({
      activePageId: targetPageId,
      drillthrough: { sourcePageId, targetPageId, filters: [...filters], label },
      crossFilter: null,
      selectedTileId: null,
      lastAppliedBookmarkId: null,
    });
  }

  /** Clears the drillthrough context, staying on the current page. */
  clearDrillthrough(): void {
    if (this.state.drillthrough !== null) this.set({ drillthrough: null });
  }

  /** "← Back": returns to the page the drillthrough came from and clears it. */
  returnFromDrillthrough(): void {
    const drillthrough = this.state.drillthrough;
    if (!drillthrough) return;
    const current = this.state.current;
    const sourceExists =
      current !== null && pagesOf(current.layout).some((p) => p.id === drillthrough.sourcePageId);
    this.set({
      drillthrough: null,
      ...(sourceExists
        ? {
            activePageId: drillthrough.sourcePageId,
            crossFilter: null,
            selectedTileId: null,
          }
        : {}),
    });
  }

  /* -------------------------------------------------------------- bookmarks */

  /** Current page + runtime filter context, cloned for safe doc storage. */
  private captureBookmarkState(): DashboardBookmark['state'] | null {
    const pageId = this.state.activePageId;
    if (pageId === null) return null;
    return {
      pageId,
      slicers: structuredClone(this.state.slicerValues),
      filterOverrides: structuredClone(this.state.filterCardOverrides),
    };
  }

  private mutateBookmarks(mutate: (bookmarks: DashboardBookmark[]) => DashboardBookmark[]): void {
    this.mutateLayout((layout) => ({ ...layout, bookmarks: mutate(layout.bookmarks ?? []) }));
  }

  /**
   * Adds a bookmark capturing the CURRENT view (active page, slicer
   * selections, view-mode filter-card overrides). Dirties the doc like any
   * other layout edit — Save persists it. Returns the new id (null when no
   * dashboard is open).
   */
  addBookmark(name: string): string | null {
    const trimmed = name.trim();
    const state = this.captureBookmarkState();
    if (trimmed === '' || state === null) return null;
    const id = newId();
    this.mutateBookmarks((bookmarks) => [...bookmarks, { id, name: trimmed, state }]);
    // A freshly captured bookmark IS the current view.
    this.set({ lastAppliedBookmarkId: id });
    return id;
  }

  /** Restores a bookmark's page + filter context (cross-filter resets). */
  applyBookmark(id: string): void {
    const current = this.state.current;
    if (!current) return;
    const bookmark = (current.layout.bookmarks ?? []).find((b) => b.id === id);
    if (!bookmark) return;
    const pageExists = pagesOf(current.layout).some((p) => p.id === bookmark.state.pageId);
    this.set({
      ...(pageExists ? { activePageId: bookmark.state.pageId } : {}),
      slicerValues: structuredClone(bookmark.state.slicers),
      filterCardOverrides: structuredClone(bookmark.state.filterOverrides),
      // A bookmark restores its FULL captured filter context — transient
      // cross-filter/drillthrough state would pollute it.
      crossFilter: null,
      drillthrough: null,
      selectedTileId: null,
      lastAppliedBookmarkId: id,
    });
  }

  /** Overwrites a bookmark's captured state with the current view. */
  updateBookmark(id: string): void {
    const state = this.captureBookmarkState();
    if (state === null) return;
    this.mutateBookmarks((bookmarks) =>
      bookmarks.map((b) => (b.id === id ? { ...b, state } : b)),
    );
    this.set({ lastAppliedBookmarkId: id });
  }

  renameBookmark(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const bookmark = (this.state.current?.layout.bookmarks ?? []).find((b) => b.id === id);
    if (!bookmark || bookmark.name === trimmed) return;
    this.mutateBookmarks((bookmarks) =>
      bookmarks.map((b) => (b.id === id ? { ...b, name: trimmed } : b)),
    );
  }

  deleteBookmark(id: string): void {
    this.mutateBookmarks((bookmarks) => bookmarks.filter((b) => b.id !== id));
    if (this.state.lastAppliedBookmarkId === id) this.set({ lastAppliedBookmarkId: null });
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
  layout: migratePages(migrateSlicers(detail.layout?.tiles ? detail.layout : emptyLayout())),
});

const pagesOf = (layout: DashboardLayoutDoc): DashboardPage[] => layout.pages ?? [];

const firstPageId = (layout: DashboardLayoutDoc): string | null =>
  pagesOf(layout)[0]?.id ?? null;

/** Keeps `preferred` while it still names a page; falls back to the first page. */
const resolveActivePageId = (
  layout: DashboardLayoutDoc,
  preferred: string | null,
): string | null =>
  preferred !== null && pagesOf(layout).some((page) => page.id === preferred)
    ? preferred
    : firstPageId(layout);

/** Smallest "Page N" (counting from pages.length + 1) not already taken. */
const nextPageName = (pages: DashboardPage[]): string => {
  const names = new Set(pages.map((page) => page.name));
  let n = pages.length + 1;
  while (names.has(`Page ${n}`)) n += 1;
  return `Page ${n}`;
};

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

/**
 * Pages migration (runs AFTER migrateSlicers, so migrated slicer tiles land on
 * the page). Docs that already carry non-empty pages keep them as the source
 * of truth; legacy docs get one "Page 1" wrapping their tiles. Either way the
 * top-level tiles array is blanked — pages own the tiles from here on, and
 * save writes `tiles: []` so pre-pages readers still parse the doc. In-memory
 * only until the user saves. Idempotent.
 */
const migratePages = (layout: DashboardLayoutDoc): DashboardLayoutDoc => {
  const pages = layout.pages ?? [];
  if (pages.length > 0) return layout.tiles.length === 0 ? layout : { ...layout, tiles: [] };
  return { ...layout, tiles: [], pages: [{ id: newId(), name: 'Page 1', tiles: layout.tiles }] };
};

/**
 * Image sources the layout doc accepts: an encoded upload (data:image/*) or an
 * https URL. Anything else (javascript:, http:, blob:, …) is dropped to '' —
 * the tile renders its broken-image state instead of a dangerous URL.
 */
const safeImageSrc = (src: string): string => {
  const trimmed = src.trim();
  return /^data:image\//i.test(trimmed) || /^https:\/\//i.test(trimmed) ? trimmed : '';
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
