import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartSpec } from '../types/chart';
import { inclusiveDateUpperBound } from '../util/dateBounds';
import {
  emptyLayout,
  filterCardClauses,
  isSlicerTile,
  slicerClauseOf,
  type CrossFilter,
  type CrossFilterScope,
  type CrossFilterValue,
  type DashboardDetail,
  type DashboardLayoutDoc,
  type DashboardBookmark,
  type DashboardPage,
  type DashboardParameter,
  type DashboardSummary,
  type DashboardTile,
  type DrillthroughState,
  type FilterCard,
  type FilterIndicatorStyle,
  type PageDrillthrough,
  type PageMobileLayout,
  type ImageTileSpec,
  type SlicerTileSpec,
  type SlicerValue,
  type SlicerValues,
  type SlicerVariant,
  type TextTileSpec,
  type ViewFitMode,
} from '../types/dashboard';
import type {
  CellValue,
  DateBucket,
  DimensionRef,
  FilterClause,
  FilterValue,
} from '../types/query';
import type { ColumnType } from '../types/schema';
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
  /**
   * Transient click-to-highlight filters, AT MOST ONE PER (table, column) —
   * applyCrossFilter enforces the invariant (a new click on an already
   * filtered field replaces or merges into that field's entry; Ctrl/Cmd-click
   * adds fields/values). NOT persisted. Reset on page switch under the
   * default 'page' crossFilterScope; kept across pages under 'dashboard'.
   */
  crossFilters: CrossFilter[];
  /**
   * Transient page-wide hover highlight raised by hovering a datum on a chart
   * tile: every OTHER chart on the page whose effective axis/legend dimension
   * matches dims non-matching categories. NEVER persisted; never triggers
   * fetches; cleared on page switch and when the source tile unhovers/unmounts.
   */
  hoverHighlight: HoverHighlight | null;
  /**
   * Transient field-parameter selections (option index) keyed by parameter id.
   * Initialized from each parameter's defaultIndex on open; NEVER persisted.
   */
  parameterSelections: Record<string, number>;
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
  /**
   * View-mode transient override of the doc's default view sizing (null =
   * follow `layout.defaultViewFit`, where absent means FIT TO PAGE). Lives in
   * the store — NOT component state — so the viewer's choice survives page
   * switches and any component remount within the session. NEVER persisted;
   * cleared on open/close. Edit-mode picks write the doc default instead.
   */
  viewFitOverride: ViewFitMode | null;
  saveStatus: AsyncStatus;
  error: string | null;
}

/** The subset of FilterCard a viewer may tweak transiently in view mode. */
export interface FilterCardOverride {
  disabled?: boolean;
  basicValues?: FilterValue[] | null;
}

/** Transient hover cross-highlight payload (see DashboardStoreState.hoverHighlight). */
export interface HoverHighlight {
  /** Dimension of the hovered category on the SOURCE chart (its effective axis/legend). */
  dimension: { table: string; column: string };
  /** RAW (pre-format) hovered cell value. */
  raw: CellValue;
  /** Formatted category label — the key other charts dim against. */
  label: string;
  /** Chart tile the hover came from; that tile never dims itself. */
  sourceTileId: string;
}

/* ================================================== cross-filter clause build
 * Clicking a datum turns ONE raw cell into the clause every other tile adds to
 * its query. For plain dimensions that is an `eq` (or `isNull`). For a DATE
 * BUCKET it must be a RANGE:
 *
 *  - the raw cell is the bucket's START INSTANT, and the engine frequently
 *    serializes it with a zone offset ("2023-09-30T19:00:00-05:00" IS the
 *    October bucket) — feeding that string back as a filter value blows up on
 *    a `date` column ("cannot be interpreted as Date");
 *  - even with a parseable value, `eq bucketStart` matches only rows that fall
 *    exactly on the boundary, not the bucket's other rows.
 *
 * So a bucket click emits DATE-ONLY 'yyyy-MM-dd' bounds covering the whole
 * bucket. Every calendar computation below runs on UTC parts — never
 * `new Date(x).toISOString()`, which drags the value through the browser's
 * local zone and can shift it a full day (exactly the reported bug).
 *
 * The range travels as ONE inclusive `between` clause because CrossFilter
 * carries a single FilterClause; [start, end] with end = nextBucketStart - 1
 * day is the exact same row set as [start, nextBucketStart) for date-grained
 * data.
 */

/** A timezone-free calendar date (month is 1-based). */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'yyyy-MM-dd' — the only date shape cross-filter clauses ever put on the wire. */
export const formatDateOnly = (date: CalendarDate): string =>
  `${String(date.year).padStart(4, '0')}-${pad2(date.month)}-${pad2(date.day)}`;

/** Calendar parts of an epoch instant, read in UTC. */
const utcCalendarOf = (ms: number): CalendarDate | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

/** UTC calendar arithmetic (Date.UTC normalizes overflowing month/day parts). */
const shiftUtc = (date: CalendarDate, months: number, days: number): CalendarDate => {
  // setUTCFullYear (not the Date.UTC year argument) so years 0-99 stay literal.
  const at = new Date(0);
  at.setUTCFullYear(date.year, date.month - 1 + months, date.day + days);
  return utcCalendarOf(at.getTime()) ?? date;
};

/**
 * ISO-8601-ish date/timestamp shapes the engine emits. Groups: y, m, d, HH,
 * mm, ss, zone ('Z' / '±hh:mm' / '±hhmm'; ABSENT for a naive local timestamp).
 */
const ISO_LIKE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Can `date` be the START of a bucket of this grain? */
const isBucketStart = (date: CalendarDate, bucket: DateBucket): boolean => {
  switch (bucket) {
    case 'year':
      return date.month === 1 && date.day === 1;
    case 'quarter':
      return (date.month - 1) % 3 === 0 && date.day === 1;
    case 'month':
      return date.day === 1;
    default:
      // week/day: any calendar date is a legal bucket start.
      return true;
  }
};

/**
 * The calendar date a raw bucket cell denotes, resolved WITHOUT ever touching
 * the browser's local zone:
 *  - naive string ("2023-10-01", "2023-10-01T00:00:00") -> its literal date
 *    (Date.parse would re-interpret it in the local zone);
 *  - zoned string -> the literal date when that is a legal midnight bucket
 *    start (the server rendered the boundary in its own zone), otherwise the
 *    UTC date of the instant (the "2023-09-30T19:00:00-05:00" case, whose
 *    instant is 2023-10-01T00:00Z = the October bucket);
 *  - Date / epoch number -> UTC parts.
 */
export const bucketDateOf = (raw: unknown, bucket: DateBucket): CalendarDate | null => {
  if (raw instanceof Date) return utcCalendarOf(raw.getTime());
  if (typeof raw === 'number') return utcCalendarOf(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  const match = ISO_LIKE.exec(text);
  if (match) {
    const literal: CalendarDate = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
    if (match[7] === undefined) return literal;
    const midnight = (match[4] ?? '00') === '00' && (match[5] ?? '00') === '00' && (match[6] ?? '00') === '00';
    if (midnight && isBucketStart(literal, bucket)) return literal;
    return utcCalendarOf(Date.parse(text)) ?? literal;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : utcCalendarOf(parsed);
};

/** Floors a calendar date onto its bucket's first day. */
const startOfBucket = (date: CalendarDate, bucket: DateBucket): CalendarDate => {
  switch (bucket) {
    case 'year':
      return { year: date.year, month: 1, day: 1 };
    case 'quarter':
      return { year: date.year, month: date.month - ((date.month - 1) % 3), day: 1 };
    case 'month':
      return { year: date.year, month: date.month, day: 1 };
    default:
      // week/day: the engine already truncated to the bucket's first day.
      return date;
  }
};

/** The bucket after `start` (its half-open upper bound). */
const nextBucketStart = (start: CalendarDate, bucket: DateBucket): CalendarDate => {
  switch (bucket) {
    case 'year':
      return shiftUtc(start, 12, 0);
    case 'quarter':
      return shiftUtc(start, 3, 0);
    case 'month':
      return shiftUtc(start, 1, 0);
    case 'week':
      return shiftUtc(start, 0, 7);
    default:
      return shiftUtc(start, 0, 1);
  }
};

/** Inclusive calendar bounds (+ the half-open upper bound) of a raw bucket cell. */
export const dateBucketRange = (
  raw: unknown,
  bucket: DateBucket,
): { start: CalendarDate; end: CalendarDate; next: CalendarDate } | null => {
  const at = bucketDateOf(raw, bucket);
  if (at === null) return null;
  const start = startOfBucket(at, bucket);
  const next = nextBucketStart(start, bucket);
  return { start, end: shiftUtc(next, 0, -1), next };
};

/**
 * Inclusive 'between' clause over date-only (or last-instant) bounds.
 *
 * The engine compiles `between` to `col >= a AND col <= b` against the RAW
 * column (never the truncated expression), so the upper bound has to match
 * the column's own resolution — `inclusiveDateUpperBound` owns that decision
 * for every date path in the app (cross-filters, slicers, presets). For a
 * `date` column `>= '2023-10-01' AND <= '2023-10-31'` is exactly
 * `[Oct 1, Nov 1)`; for a `timestamp` one the bound moves to the day's last
 * instant so the bucket's final day is not dropped.
 */
const betweenClause = (
  dimension: { table: string; column: string },
  start: CalendarDate,
  end: CalendarDate,
  columnType: ColumnType | null | undefined,
): FilterClause => ({
  table: dimension.table,
  column: dimension.column,
  operator: 'between',
  values: [formatDateOnly(start), inclusiveDateUpperBound(formatDateOnly(end), columnType)],
});

/**
 * What the RESULT column says about the clicked dimension. The result column
 * is authoritative: it reports the bucket the engine actually applied and the
 * column's catalog type. Both are optional — callers without a result fall
 * back to the spec's own dateBucket and the strict date form.
 */
export interface CrossFilterClauseOptions {
  columnType?: ColumnType | null;
  dateBucket?: DateBucket | null;
}

/**
 * The cross-filter clause for one clicked category value on `dimension`:
 * null -> isNull, a DATE-BUCKETED dimension -> the bucket's full range,
 * anything else -> eq on the raw value.
 */
export const crossFilterClauseFor = (
  dimension: DimensionRef,
  raw: CellValue | Date,
  options: CrossFilterClauseOptions = {},
): FilterClause => {
  const { table, column } = dimension;
  if (raw === null) return { table, column, operator: 'isNull', values: [] };
  const bucket = options.dateBucket ?? dimension.dateBucket ?? null;
  if (bucket !== null) {
    const range = dateBucketRange(raw, bucket);
    if (range !== null) return betweenClause(dimension, range.start, range.end, options.columnType);
  }
  return { table, column, operator: 'eq', values: [raw as FilterValue] };
};

/**
 * The cross-filter clause for a dragged AXIS RANGE on a date axis
 * (format.zoom.dragAction === 'crossFilter'): the bucket containing `fromRaw`
 * through the bucket containing `toRaw`, inclusive. Returns null when neither
 * endpoint resolves to a date.
 */
export const dateRangeClauseFor = (
  dimension: DimensionRef,
  fromRaw: unknown,
  toRaw: unknown,
  options: CrossFilterClauseOptions = {},
): FilterClause | null => {
  const bucket = options.dateBucket ?? dimension.dateBucket ?? 'day';
  const from = dateBucketRange(fromRaw, bucket);
  const to = dateBucketRange(toRaw, bucket);
  if (from === null && to === null) return null;
  const first = from ?? to!;
  const last = to ?? from!;
  // Tolerate a backwards drag (right-to-left selection).
  const ordered =
    formatDateOnly(first.start) <= formatDateOnly(last.start)
      ? { start: first.start, end: last.end }
      : { start: last.start, end: first.end };
  return betweenClause(dimension, ordered.start, ordered.end, options.columnType);
};

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
  crossFilters: [],
  hoverHighlight: null,
  parameterSelections: {},
  drillthrough: null,
  lastAppliedBookmarkId: null,
  filterCardOverrides: {},
  viewFitOverride: null,
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
      crossFilters: [],
      hoverHighlight: null,
      parameterSelections: defaultParameterSelections(current.layout),
      drillthrough: null,
      lastAppliedBookmarkId: null,
      filterCardOverrides: {},
      viewFitOverride: null,
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
      crossFilters: [],
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
    // Same for filters raised from a removed cross-filter source chart.
    if (this.state.crossFilters.some((f) => f.sourceTileId === tileId)) {
      this.set({ crossFilters: this.state.crossFilters.filter((f) => f.sourceTileId !== tileId) });
    }
    // …and a removed hover-highlight source.
    if (this.state.hoverHighlight?.sourceTileId === tileId) {
      this.set({ hoverHighlight: null });
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

  /** Adds a slicer TILE to the active page; variant defaults to checklist.
   *  The fieldParam variant passes parameterId and empty table/column. */
  addSlicer(def: {
    table?: string;
    column?: string;
    label: string;
    variant?: SlicerVariant;
    parameterId?: string | null;
  }): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'slicer',
        layout: { x: 0, y: maxY, w: 6, h: 5, minW: 3, minH: 3 },
        slicer: {
          table: def.table ?? '',
          column: def.column ?? '',
          label: def.label,
          variant: def.variant ?? 'checklist',
          ...(def.parameterId != null ? { parameterId: def.parameterId } : {}),
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

  setSlicerValue(slicerId: string, value: SlicerValue): void {
    // Any slicer change diverges from the last-applied bookmark's snapshot.
    this.set({
      slicerValues: { ...this.state.slicerValues, [slicerId]: value },
      lastAppliedBookmarkId: null,
    });
  }

  /**
   * Sets/clears the transient hover highlight. Writes only when the payload
   * actually differs (same source + label + dimension is a no-op) so hover
   * jitter never storms the store; a null clears.
   */
  setHoverHighlight(next: HoverHighlight | null): void {
    const current = this.state.hoverHighlight;
    if (current === null && next === null) return;
    if (
      current !== null &&
      next !== null &&
      current.sourceTileId === next.sourceTileId &&
      current.label === next.label &&
      current.dimension.table === next.dimension.table &&
      current.dimension.column === next.dimension.column
    ) {
      return;
    }
    this.set({ hoverHighlight: next });
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
      // Page-scoped cross-filters die with the page switch; dashboard-scoped
      // ones survive (same doctrine as setActivePage).
      ...(this.scopeOf() === 'page' ? { crossFilters: [] } : {}),
    });
  }

  /** Effective cross-filter scope of the open dashboard (default 'page'). */
  private scopeOf(): CrossFilterScope {
    return this.state.current?.layout.crossFilterScope ?? 'page';
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
      crossFilters: this.state.crossFilters.filter((f) => !removedIds.has(f.sourceTileId)),
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
   * Switches the visible page. Under the default 'page' cross-filter scope
   * the transient cross-filters reset (their source charts are no longer on
   * screen); under 'dashboard' scope they survive and keep filtering the new
   * page's tiles. Slicer selections persist per their tiles and re-apply when
   * their page is revisited. Never dirties the draft.
   */
  setActivePage(pageId: string): void {
    if (pageId === this.state.activePageId) return;
    const current = this.state.current;
    if (!current || !pagesOf(current.layout).some((p) => p.id === pageId)) return;
    // Page changes diverge from the last-applied bookmark (it captures pageId).
    this.set({
      activePageId: pageId,
      ...(this.scopeOf() === 'page' ? { crossFilters: [] } : {}),
      hoverHighlight: null,
      selectedTileId: null,
      lastAppliedBookmarkId: null,
    });
  }

  /** Sets or clears a page's phone layout (persisted with the doc). */
  setPageMobileLayout(pageId: string, mobileLayout: PageMobileLayout | null): void {
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page) return;
    if (stableStringify(page.mobileLayout ?? null) === stableStringify(mobileLayout)) return;
    this.mutatePages((pages) =>
      pages.map((p) => {
        if (p.id !== pageId) return p;
        if (mobileLayout !== null) return { ...p, mobileLayout };
        const { mobileLayout: _removed, ...rest } = p;
        return rest;
      }),
    );
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
   * Activates/merges the click-to-highlight cross-filter emitted by a chart
   * tile. Modifier semantics (Power BI-like; the caller maps clicks to
   * `mode`):
   *
   *  - 'replace' (plain click, Shift+click): the clicked point's filter
   *    becomes the ONLY active cross-filter. Clicking the currently sole
   *    active selection again toggles everything off (historic feel).
   *  - 'add' (Ctrl/Cmd+click): a DIFFERENT field gains its own filter
   *    alongside the existing ones (one per table.column, AND-composed); the
   *    SAME field toggles the clicked value in/out of that field's
   *    accumulated set (clause becomes 'in'; removing the last value removes
   *    the filter). Date-bucket fields cannot OR disjoint ranges in an
   *    AND-composed filter list, so a Ctrl-click on a second bucket extends
   *    the field's range to the SPANNING range (min start – max end) and the
   *    label says so ('Jul 2025 – Sep 2025'); Ctrl-clicking the exact active
   *    range toggles it off. Blank (isNull) cannot OR with values either —
   *    Ctrl-clicking blank replaces that field's set with the blank filter
   *    (and vice versa).
   *
   * `kind` records what was clicked on the source ('axis' datum by default;
   * 'legend' for legendMode 'crossFilter' selections) — the filtering path is
   * identical, only the source tile's emphasis rendering differs.
   */
  applyCrossFilter(input: {
    sourceTileId: string;
    clause: FilterClause;
    label: string;
    categoryLabel: string;
    kind?: 'axis' | 'legend';
    mode?: 'replace' | 'add';
  }): void {
    const { mode = 'replace' } = input;
    const filters = this.state.crossFilters;
    const next = buildCrossFilter(input);
    if (mode === 'replace') {
      const sole = filters.length === 1 ? filters[0] : undefined;
      if (
        sole &&
        sole.sourceTileId === input.sourceTileId &&
        stableStringify(sole.clause) === stableStringify(input.clause)
      ) {
        this.set({ crossFilters: [] });
        return;
      }
      this.set({ crossFilters: [next] });
      return;
    }
    const key = crossFilterFieldKey(input.clause);
    const index = filters.findIndex((f) => crossFilterFieldKey(f.clause) === key);
    if (index === -1) {
      this.set({ crossFilters: [...filters, next] });
      return;
    }
    const existing = filters[index]!;
    if (stableStringify(existing.clause) === stableStringify(input.clause)) {
      // Ctrl-click on the field's exact active selection: toggle the field off.
      this.set({ crossFilters: filters.filter((_, i) => i !== index) });
      return;
    }
    const merged = mergeCrossFilters(existing, next);
    this.set({
      crossFilters:
        merged === null
          ? filters.filter((_, i) => i !== index)
          : filters.map((f, i) => (i === index ? merged : f)),
    });
  }

  /**
   * Replaces one field's accumulated value set outright (the indicator chip's
   * "Edit value…" popover). Writes through the same shape Ctrl-click
   * accumulation produces; an empty set removes the field's filter. No-op
   * when the field has no active cross-filter (the popover only edits
   * existing chips).
   */
  setCrossFilterValues(table: string, column: string, values: CrossFilterValue[]): void {
    const filters = this.state.crossFilters;
    const index = filters.findIndex(
      (f) => f.clause.table === table && f.clause.column === column,
    );
    const existing = index === -1 ? undefined : filters[index];
    if (!existing) return;
    if (values.length === 0) {
      this.set({ crossFilters: filters.filter((_, i) => i !== index) });
      return;
    }
    const replacement = crossFilterFromValues(existing, values);
    this.set({
      crossFilters: filters.map((f, i) => (i === index ? replacement : f)),
    });
  }

  /** Clears the one cross-filter on (table, column), leaving the rest active. */
  removeCrossFilter(table: string, column: string): void {
    const filters = this.state.crossFilters;
    const next = filters.filter((f) => !(f.clause.table === table && f.clause.column === column));
    if (next.length !== filters.length) this.set({ crossFilters: next });
  }

  /**
   * Clears the filters a specific source tile raised (optionally only one
   * kind) — the legend-clear path: a chart clearing its own legend selection
   * must never wipe another tile's filters.
   */
  clearCrossFiltersFromSource(sourceTileId: string, kind?: 'axis' | 'legend'): void {
    const filters = this.state.crossFilters;
    const next = filters.filter(
      (f) => !(f.sourceTileId === sourceTileId && (kind === undefined || (f.kind ?? 'axis') === kind)),
    );
    if (next.length !== filters.length) this.set({ crossFilters: next });
  }

  /** Clears every active cross-filter. */
  clearCrossFilters(): void {
    if (this.state.crossFilters.length > 0) this.set({ crossFilters: [] });
  }

  /**
   * Sets the dashboard-wide cross-filter scope (persisted with the layout).
   * Narrowing back to 'page' drops any filters whose source tile does not
   * live on the active page — they only existed because of the wider scope.
   */
  setCrossFilterScope(scope: CrossFilterScope): void {
    const current = this.state.current;
    if (!current || (current.layout.crossFilterScope ?? 'page') === scope) return;
    this.mutateLayout((layout) => ({ ...layout, crossFilterScope: scope }));
    if (scope === 'page') {
      const activeIds = new Set(this.activeTiles().map((t) => t.id));
      const filters = this.state.crossFilters;
      const next = filters.filter((f) => activeIds.has(f.sourceTileId));
      if (next.length !== filters.length) this.set({ crossFilters: next });
    }
  }

  /** Selections of the ACTIVE page's slicer tiles (other pages' slicers do not leak). */
  activeFilters(): FilterClause[] {
    const clauses: FilterClause[] = [];
    for (const tile of this.activeTiles()) {
      if (!isSlicerTile(tile)) continue;
      const clause = slicerClauseOf(this.state.slicerValues[tile.id]);
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
      const clause = slicerClauseOf(this.state.slicerValues[tile.id]);
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
    // Cross-filters: every active one applies except those the tile itself
    // raised. Structurally identical clauses are pushed once — a cross-filter
    // duplicating an active slicer selection on the same column must not
    // stack the same predicate twice.
    const seen = new Set(clauses.map((c) => stableStringify(c)));
    for (const cross of this.state.crossFilters) {
      if (cross.sourceTileId === tileId) continue;
      const key = stableStringify(cross.clause);
      if (seen.has(key)) continue;
      seen.add(key);
      clauses.push(cross.clause);
    }
    return clauses;
  }

  /**
   * Filters that constrain a CASCADING slicer's AVAILABLE VALUES
   * (SlicerTileSpec.cascade) — i.e. what its distinct-values fetch is scoped
   * to. Deliberately NOT the same set as filtersForTile:
   *
   *  - INCLUDED: every OTHER slicer tile on the same page that currently holds
   *    a clause, and every active cross-filter. Slicer "applies to" targeting
   *    is ignored on purpose — it says which CHARTS a slicer filters, not what
   *    the data universe looks like.
   *  - EXCLUDED, always: any clause on this slicer's OWN table.column. A
   *    slicer must never narrow its own option list (that would make
   *    de-selecting a value impossible).
   *  - EXCLUDED, by design: filter-pane cards and drillthrough context. They
   *    are per-chart/per-page report scoping rather than user-driven slicing;
   *    folding them in would make a slicer's list depend on invisible authored
   *    state. (Documented scope choice — widen here if that changes.)
   *
   * Clauses are de-duplicated and sorted by their stable serialization so the
   * array is order-stable: it is hashed straight into the distinct-value cache
   * key (`stableStringify(DistinctValuesSpec)`, which includes `filters`).
   */
  cascadeFiltersForSlicer(tileId: string): FilterClause[] {
    const layout = this.state.current?.layout;
    if (!layout) return [];
    const page = pagesOf(layout).find((p) => p.tiles.some((t) => t.id === tileId));
    if (page === undefined) return [];
    const self = page.tiles.find((t) => t.id === tileId);
    const own = self?.slicer ? { table: self.slicer.table, column: self.slicer.column } : null;
    const isOwnColumn = (clause: FilterClause): boolean =>
      own !== null && clause.table === own.table && clause.column === own.column;

    const seen = new Set<string>();
    const clauses: FilterClause[] = [];
    const push = (clause: FilterClause | null | undefined): void => {
      if (clause == null || isOwnColumn(clause)) return;
      const key = stableStringify(clause);
      if (seen.has(key)) return;
      seen.add(key);
      clauses.push(clause);
    };

    for (const tile of page.tiles) {
      if (tile.id === tileId || !isSlicerTile(tile)) continue;
      push(slicerClauseOf(this.state.slicerValues[tile.id]));
    }
    for (const cross of this.state.crossFilters) {
      if (cross.sourceTileId === tileId) continue;
      push(cross.clause);
    }
    return clauses.sort((a, b) => {
      const ka = stableStringify(a);
      const kb = stableStringify(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
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
      // Drillthrough is an explicit navigation with its own filter context —
      // active cross-filters clear regardless of scope so the target page
      // never double-filters.
      crossFilters: [],
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
            crossFilters: [],
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
      // cross-filter/drillthrough state would pollute it. (Bookmarks capture
      // slicers + filter-card overrides, never cross-filters — unchanged.)
      crossFilters: [],
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

  /**
   * Cross-filter indicator look/placement (persisted with the layout). A patch
   * MERGES onto whatever is there — absent fields keep falling back to the
   * component defaults, so an untouched dashboard never gains a filterIndicator
   * key. `null` resets the dashboard back to those defaults.
   */
  setFilterIndicator(patch: Partial<FilterIndicatorStyle> | null): void {
    const current = this.state.current;
    if (!current) return;
    const next =
      patch === null ? null : { ...(current.layout.filterIndicator ?? {}), ...patch };
    if (stableStringify(current.layout.filterIndicator ?? null) === stableStringify(next)) return;
    this.mutateLayout((layout) => ({ ...layout, filterIndicator: next }));
  }

  /**
   * Doc-level default view sizing (persisted with the layout on save; written
   * from the toolbar's View control in EDIT mode). FIT TO PAGE is the product
   * default, so 'fitPage'/null normalize to null — absent means fit and an
   * untouched dashboard never gains the key. 'actual' persists EXPLICITLY:
   * docs authored to actual size keep rendering 1:1 for viewers. View-mode
   * viewer overrides go through setViewFitOverride, never here.
   */
  setDefaultViewFit(fit: ViewFitMode | null): void {
    const next = fit === 'fitPage' ? null : fit;
    if ((this.state.current?.layout.defaultViewFit ?? null) === next) return;
    this.mutateLayout((layout) => ({ ...layout, defaultViewFit: next }));
  }

  /**
   * View-mode transient view-sizing override (see DashboardStoreState.
   * viewFitOverride). null returns the viewer to the doc default.
   */
  setViewFitOverride(fit: ViewFitMode | null): void {
    if (this.state.viewFitOverride === fit) return;
    this.set({ viewFitOverride: fit });
  }

  /* ------------------------------------------------------- field parameters */

  private mutateParameters(mutate: (parameters: DashboardParameter[]) => DashboardParameter[]): void {
    this.mutateLayout((layout) => ({ ...layout, parameters: mutate(layout.parameters ?? []) }));
  }

  /** Adds a field parameter (id assigned here); returns the new id. */
  addParameter(parameter: Omit<DashboardParameter, 'id'>): string {
    const id = newId();
    this.mutateParameters((parameters) => [...parameters, { ...parameter, id }]);
    // A fresh parameter starts at its default selection.
    this.set({
      parameterSelections: {
        ...this.state.parameterSelections,
        [id]: clampIndex(parameter.defaultIndex ?? 0, parameter.options.length),
      },
    });
    return id;
  }

  /** Patches a field parameter (doc edit — dirties the draft). */
  updateParameter(id: string, patch: Partial<Omit<DashboardParameter, 'id'>>): void {
    this.mutateParameters((parameters) =>
      parameters.map((p) => (p.id === id ? { ...p, ...patch, id } : p)),
    );
    // The option list may have shrunk under the current selection.
    const updated = (this.state.current?.layout.parameters ?? []).find((p) => p.id === id);
    if (updated) {
      const selection = this.state.parameterSelections[id] ?? updated.defaultIndex ?? 0;
      const clamped = clampIndex(selection, updated.options.length);
      if (clamped !== selection) {
        this.set({ parameterSelections: { ...this.state.parameterSelections, [id]: clamped } });
      }
    }
  }

  /** Removes a field parameter and its transient selection. Charts bound to it
   *  fall back to their own axis/measures; fieldParam slicers show a hint. */
  removeParameter(id: string): void {
    this.mutateParameters((parameters) => parameters.filter((p) => p.id !== id));
    if (id in this.state.parameterSelections) {
      const { [id]: _removed, ...rest } = this.state.parameterSelections;
      this.set({ parameterSelections: rest });
    }
  }

  /** Transient selection of a field parameter's option (never persisted). */
  setParameterSelection(id: string, index: number): void {
    const parameter = (this.state.current?.layout.parameters ?? []).find((p) => p.id === id);
    if (!parameter) return;
    const clamped = clampIndex(index, parameter.options.length);
    if (this.state.parameterSelections[id] === clamped) return;
    this.set({ parameterSelections: { ...this.state.parameterSelections, [id]: clamped } });
  }
}

/* ----------------------------------------------------- cross-filter merging
 * One CrossFilter per (table, column) — these helpers own the invariant.
 */

const crossFilterFieldKey = (clause: FilterClause): string =>
  `${clause.table}\u0000${clause.column}`;

/** Two CrossFilterValue raws denote the same cell (null only matches null). */
const sameRaw = (a: FilterValue | null, b: FilterValue | null): boolean =>
  a === null || b === null ? a === b : typeof a === typeof b ? a === b : String(a) === String(b);

/**
 * A fresh CrossFilter from one click. Discrete clauses (eq/isNull) get their
 * value set seeded so later Ctrl-clicks can toggle; 'between' (date bucket)
 * clauses get endpoint labels so span extensions can label the merged range.
 */
const buildCrossFilter = (input: {
  sourceTileId: string;
  clause: FilterClause;
  label: string;
  categoryLabel: string;
  kind?: 'axis' | 'legend';
}): CrossFilter => {
  const { sourceTileId, clause, label, categoryLabel, kind = 'axis' } = input;
  const base: CrossFilter = { sourceTileId, clause, label, categoryLabel, kind };
  if (clause.operator === 'eq') {
    return { ...base, values: [{ raw: clause.values[0] ?? null, label: categoryLabel }] };
  }
  if (clause.operator === 'isNull') {
    return { ...base, values: [{ raw: null, label: categoryLabel }] };
  }
  if (clause.operator === 'between') {
    return { ...base, rangeLabels: { start: categoryLabel, end: categoryLabel } };
  }
  return base;
};

/** The discrete value set behind a filter (null = not a discrete filter). */
const discreteValuesOf = (filter: CrossFilter): CrossFilterValue[] | null => {
  if (filter.values !== undefined) return filter.values;
  const { clause } = filter;
  if (clause.operator === 'eq') {
    return [{ raw: clause.values[0] ?? null, label: filter.categoryLabel }];
  }
  if (clause.operator === 'isNull') return [{ raw: null, label: filter.categoryLabel }];
  if (clause.operator === 'in') {
    return clause.values.map((raw) => ({ raw, label: String(raw) }));
  }
  return null;
};

/**
 * Rebuilds a field's filter from an explicit discrete value set (Ctrl-click
 * toggling and the "Edit value…" popover). The set is never empty here
 * (callers remove the filter instead). A lone blank compiles to isNull; a
 * blank mixed with values is unrepresentable (no OR in the clause
 * vocabulary), so blanks are dropped when values are present.
 */
const crossFilterFromValues = (
  template: CrossFilter,
  values: CrossFilterValue[],
): CrossFilter => {
  const { table, column } = template.clause;
  const nonNull = values.filter((v): v is CrossFilterValue & { raw: FilterValue } => v.raw !== null);
  const kept = nonNull.length > 0 ? nonNull : values.slice(0, 1);
  const categoryLabel = kept.map((v) => v.label).join(', ');
  const clause: FilterClause =
    nonNull.length === 0
      ? { table, column, operator: 'isNull', values: [] }
      : nonNull.length === 1
        ? { table, column, operator: 'eq', values: [nonNull[0]!.raw] }
        : { table, column, operator: 'in', values: nonNull.map((v) => v.raw) };
  return {
    sourceTileId: template.sourceTileId,
    clause,
    label: `${column}: ${categoryLabel}`,
    categoryLabel,
    kind: template.kind ?? 'axis',
    values: kept,
  };
};

/**
 * Ctrl-click merge of an incoming single-click filter into the field's
 * existing one (same table.column, clauses differ — identical clauses toggle
 * off before this runs). Returns null when the merge empties the field.
 *
 *  - discrete + discrete: toggle the clicked value in/out of the set;
 *  - between + between: extend to the SPANNING range (min start, max end) —
 *    OR-of-disjoint-ranges is not expressible in the AND-composed filter
 *    list, so the honest behavior is the labeled span;
 *  - blank vs values / range vs discrete (bucket changed mid-session): the
 *    incoming filter replaces the field's entry.
 */
const mergeCrossFilters = (existing: CrossFilter, incoming: CrossFilter): CrossFilter | null => {
  if (existing.clause.operator === 'between' && incoming.clause.operator === 'between') {
    const exStart = String(existing.clause.values[0] ?? '');
    const exEnd = String(existing.clause.values[1] ?? '');
    const inStart = String(incoming.clause.values[0] ?? '');
    const inEnd = String(incoming.clause.values[1] ?? '');
    // ISO date strings compare correctly as text.
    const exLabels = existing.rangeLabels ?? {
      start: existing.categoryLabel,
      end: existing.categoryLabel,
    };
    const inLabels = incoming.rangeLabels ?? {
      start: incoming.categoryLabel,
      end: incoming.categoryLabel,
    };
    const start = inStart < exStart ? inStart : exStart;
    const end = inEnd > exEnd ? inEnd : exEnd;
    const startLabel = inStart < exStart ? inLabels.start : exLabels.start;
    const endLabel = inEnd > exEnd ? inLabels.end : exLabels.end;
    const categoryLabel = startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
    const { table, column } = incoming.clause;
    return {
      sourceTileId: incoming.sourceTileId,
      clause: { table, column, operator: 'between', values: [start, end] },
      label: `${column}: ${categoryLabel}`,
      categoryLabel,
      kind: incoming.kind ?? existing.kind ?? 'axis',
      rangeLabels: { start: startLabel, end: endLabel },
    };
  }
  const existingValues = discreteValuesOf(existing);
  const incomingValues = discreteValuesOf(incoming);
  const clicked = incomingValues?.[0];
  if (existingValues === null || incomingValues === null || clicked === undefined) {
    // Shape mismatch (range vs discrete) — the new click wins the field.
    return incoming;
  }
  // Blank cannot OR with values: clicking blank over values (or a value over
  // blank) replaces the field's selection.
  if (clicked.raw === null || existingValues.some((v) => v.raw === null)) return incoming;
  const index = existingValues.findIndex((v) => sameRaw(v.raw, clicked.raw));
  const nextValues =
    index === -1
      ? [...existingValues, clicked]
      : existingValues.filter((_, i) => i !== index);
  if (nextValues.length === 0) return null;
  return crossFilterFromValues(incoming, nextValues);
};

/** Clamp an option index into [0, count-1] (0 when the list is empty). */
const clampIndex = (index: number, count: number): number =>
  count <= 0 ? 0 : Math.min(Math.max(Math.trunc(index), 0), count - 1);

/** Default selections: every parameter starts at its defaultIndex (clamped). */
const defaultParameterSelections = (layout: DashboardLayoutDoc): Record<string, number> =>
  Object.fromEntries(
    (layout.parameters ?? []).map((p) => [p.id, clampIndex(p.defaultIndex ?? 0, p.options.length)]),
  );

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
