// Dashboard layout document (rcd_dashboards.LayoutJson) + API envelopes.
import type { ChartSpec } from './chart';
import type {
  ChartQuerySpec,
  DimensionRef,
  FilterClause,
  FilterOperator,
  FilterValue,
  MeasureRef,
} from './query';

export interface TileLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

/** How a slicer tile renders its value picker. */
export type SlicerVariant =
  | 'checklist'
  | 'dropdown'
  | 'dropdownMulti'
  | 'buttons'
  | 'dateRange'
  /** Rolling/relative date presets (Last 30 days, YTD, …) over a date column. */
  | 'relativeDate'
  /** Drives a dashboard field parameter's selection instead of filtering. */
  | 'fieldParam';

/** Visual tweaks for a slicer tile; absent fields keep the standard look. */
export interface SlicerTileStyle {
  /** No header bar; the label renders as a small caption inside the body. */
  hideHeader?: boolean;
  /** Tighter paddings + smaller text (dense dashboards). */
  compact?: boolean;
  /** buttons variant: control size (default 'md'). */
  buttonSize?: 'sm' | 'md' | 'lg';
  /** buttons variant: stretch buttons to share the full tile width. */
  buttonFill?: boolean;
  /** buttons variant: horizontal placement of the button group (default left). */
  buttonAlign?: 'left' | 'center' | 'right';
  /** buttons variant: vertical placement inside the tile (default top). */
  buttonVerticalAlign?: 'top' | 'middle' | 'bottom';
  /** buttons variant: fixed column count; null/absent = natural wrap. */
  buttonColumns?: number | null;
}

/** dateRange-variant behavior (absent fields keep the native pickers). */
export interface DateRangeOptions {
  /**
   * 'native' = the browser date inputs (current look); 'calendar' = the
   * custom popover calendar with data-availability marks.
   */
  picker?: 'native' | 'calendar';
  /**
   * Month the calendar opens on when nothing is selected: 'dataStart' /
   * 'dataEnd' derive from the column's actual min/max; 'yyyy-MM' pins one.
   */
  initialMonth?: 'dataStart' | 'dataEnd' | string | null;
  /**
   * Mark days/months that actually contain data in the calendar picker
   * (distinct-values query on the column; default true for 'calendar').
   */
  showAvailability?: boolean;
}

/**
 * Look/placement of the active cross-filter indicator. Absent = the default
 * pill. Dashboard-level (layout doc `filterIndicator`).
 */
export interface FilterIndicatorStyle {
  /**
   * Where the indicator docks (default 'top-center'). The five classic slots
   * float over the tile area; 'header' renders compact chips inline in the
   * dashboard toolbar row; 'footer' is a slim in-flow bar at the bottom edge.
   */
  placement?:
    | 'top-center'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right'
    | 'header'
    | 'footer';
  /**
   * 'pill' = compact floating chip (old look, restyled); 'banner' = full-width
   * accent bar listing every active filter; 'stack' = one chip per filter,
   * stacked at the docked corner.
   */
  variant?: 'pill' | 'banner' | 'stack';
  size?: 'sm' | 'md' | 'lg';
  /** Fixed hexes; null/absent = theme accent styling. */
  background?: string | null;
  textColor?: string | null;
  accentColor?: string | null;
  /** Badge each tile the filter actually applies to (default true). */
  badgeTiles?: boolean;
}

export interface SlicerTileSpec {
  /** Source column ('' for the fieldParam variant — it has no column). */
  table: string;
  column: string;
  label: string;
  variant: SlicerVariant;
  /** Hide the clear (x) affordance when explicitly false. */
  showClear?: boolean;
  /** Chart tile ids this slicer filters; null/absent = all charts. */
  targets?: string[] | null;
  /** Visual mode tweaks (frameless / compact); absent = standard look. */
  style?: SlicerTileStyle;
  /** fieldParam variant: id of the DashboardParameter this slicer drives. */
  parameterId?: string | null;
  /** dateRange variant behavior; absent = native inputs. */
  dateRange?: DateRangeOptions;
  /**
   * relativeDate variant: persisted preset id (e.g. 'last30d', 'ytd',
   * 'lastN:6:month') applied when the dashboard opens with no runtime
   * selection yet. Runtime preset choices live in SlicerValues (bookmarks
   * capture them there); edit-mode choices also write here so they reload.
   */
  preset?: string | null;
}

/** Static rich-text tile content. `html` is ALWAYS a sanitized subset — every
 *  store write runs it through sanitizeRichHtml (util/richText). */
export interface TextTileSpec {
  html: string;
  /** Whole-tile text alignment; absent = left. */
  align?: 'left' | 'center' | 'right';
  /** Fixed-palette hex persisted verbatim; null/absent = transparent. */
  background?: string | null;
}

/** Static image tile content. */
export interface ImageTileSpec {
  /** data: URL (encoded upload, capped by the UI) or https URL. */
  src: string;
  alt?: string;
  fit: 'contain' | 'cover' | 'fill';
  /** Fixed-palette hex persisted verbatim; null/absent = transparent. */
  background?: string | null;
}

export interface DashboardTile {
  id: string;
  layout: TileLayout;
  /** Tile discriminator; absent = 'chart' (legacy docs). */
  kind?: 'chart' | 'slicer' | 'text' | 'image';
  /** Present iff this is a chart tile (kind absent or 'chart'). */
  chart?: ChartSpec;
  /** Present iff this is a slicer tile (kind 'slicer'). */
  slicer?: SlicerTileSpec;
  /** Present iff this is a rich-text tile (kind 'text'). */
  text?: TextTileSpec;
  /** Present iff this is an image tile (kind 'image'). */
  image?: ImageTileSpec;
}

/** Legacy (pre-tile) slicer definition; migrated into slicer tiles on open. */
export interface SlicerDef {
  id: string;
  table: string;
  column: string;
  label: string;
}

/* --------------------------------------------------------------- filter cards
 * Power BI-style Filters-pane cards. Persisted in the layout doc (unlike
 * slicer selections / cross-filters, which are runtime state).
 */

/** Where a filter card applies. */
export type FilterScope = 'visual' | 'page' | 'allPages';

/** One advanced-mode condition row (single-value operators only). */
export interface FilterCardCondition {
  operator: FilterOperator;
  /** Absent/null while the row is being filled in (row compiles to nothing). */
  value?: FilterValue | null;
}

export interface FilterCard {
  id: string;
  scope: FilterScope;
  /** Chart tile the card targets; meaningful iff scope is 'visual'. */
  targetTileId?: string | null;
  /** Page the card targets; meaningful iff scope is 'page'. */
  pageId?: string | null;
  table: string;
  column: string;
  /** Catalog ColumnType captured when the card was created; null = unknown. */
  columnType?: string | null;
  mode: 'basic' | 'advanced';
  /** Basic mode: checked values (compiled to one 'in' clause). */
  basicValues?: FilterValue[] | null;
  /** Advanced mode: up to three condition rows. */
  conditions?: FilterCardCondition[] | null;
  /** How advanced conditions combine; absent = 'and'. */
  conditionJoin?: 'and' | 'or';
  /** Disabled cards stay on the pane but stop filtering. */
  disabled?: boolean;
}

/** A condition contributes only when its operator needs no value or has one. */
export const isCompleteFilterCondition = (condition: FilterCardCondition): boolean =>
  condition.operator === 'isNull' ||
  condition.operator === 'notNull' ||
  (condition.value !== null && condition.value !== undefined);

const completeConditions = (card: FilterCard): FilterCardCondition[] =>
  (card.conditions ?? []).filter(isCompleteFilterCondition);

/**
 * True when an 'or' card cannot be expressed on the wire: the query engine has
 * no OR — the only representable disjunction is all-'eq', which collapses to
 * one 'in' clause. Such cards compile to NO clauses and the pane shows a
 * warning badge (engine OR support is a future backend task).
 */
export const filterCardHasUnsupportedOr = (card: FilterCard): boolean => {
  if (card.mode !== 'advanced' || (card.conditionJoin ?? 'and') !== 'or') return false;
  const complete = completeConditions(card);
  return complete.length > 1 && !complete.every((c) => c.operator === 'eq');
};

/**
 * Compiles a card to wire FilterClauses (ANDed by the engine with everything
 * else). Basic -> one 'in' clause; advanced 'and' -> one clause per complete
 * condition; advanced 'or' -> one 'in' clause when every condition is 'eq',
 * otherwise [] (see filterCardHasUnsupportedOr). Ignores `disabled` — callers
 * that honor enablement (filtersForTile) check it before compiling.
 */
export const filterCardClauses = (card: FilterCard): FilterClause[] => {
  const { table, column } = card;
  if (card.mode === 'basic') {
    const values = card.basicValues ?? [];
    return values.length === 0 ? [] : [{ table, column, operator: 'in', values }];
  }
  const complete = completeConditions(card);
  if (complete.length === 0) return [];
  if ((card.conditionJoin ?? 'and') === 'or' && complete.length > 1) {
    if (!complete.every((c) => c.operator === 'eq')) return [];
    const values = complete
      .map((c) => c.value)
      .filter((v): v is FilterValue => v !== null && v !== undefined);
    return [{ table, column, operator: 'in', values }];
  }
  return complete.map((c) => ({
    table,
    column,
    operator: c.operator,
    values:
      c.operator === 'isNull' || c.operator === 'notNull' || c.value == null ? [] : [c.value],
  }));
};

/** True when the card is enabled AND currently contributes at least one clause. */
export const filterCardIsActive = (card: FilterCard): boolean =>
  !card.disabled && filterCardClauses(card).length > 0;

/** One field a drillthrough-enabled page requires from the source point. */
export interface DrillthroughField {
  table: string;
  column: string;
}

/**
 * Per-page drillthrough config (persisted). A page with `enabled` and at least
 * one field is offered as a "Drill through" target from point context menus on
 * OTHER pages whose chart query carries EVERY listed field as a dimension.
 */
export interface PageDrillthrough {
  enabled: boolean;
  fields: DrillthroughField[];
}

/**
 * Per-PAGE single-column phone layout (viewports narrower than 640px). Lives
 * on the page — each page stacks its own tiles, and tile ids are page-scoped
 * anyway. Absent = derive order from the grid (top-left → bottom-right) with
 * default heights and nothing hidden.
 */
export interface PageMobileLayout {
  /** Tile ids in stack order; ids missing here append in grid order. */
  order: string[];
  /** Per-tile pixel height overrides; absent tiles use kind-based defaults. */
  heights?: Record<string, number>;
  /** Tile ids skipped entirely on phones. */
  hidden?: string[];
}

/** One tab of a multi-page dashboard; tiles live per page (ids stay unique across pages). */
export interface DashboardPage {
  id: string;
  name: string;
  /** Optional tab accent (fixed palette hex, persisted verbatim); null/absent = none. */
  color?: string | null;
  tiles: DashboardTile[];
  /** Drillthrough target config; absent/null = page is not a drillthrough target. */
  drillthrough?: PageDrillthrough | null;
  /** Phone (narrow-container) layout for this page; absent = grid-derived. */
  mobileLayout?: PageMobileLayout | null;
}

/* ----------------------------------------------------------- field parameters
 * Power BI-style field parameters: a named, persisted list of dimension or
 * measure options. Charts opt in via query.paramBindings; a 'fieldParam'
 * slicer drives the transient selection (parameterSelections in the store).
 */

export interface DashboardParameterOption {
  label: string;
  /** Present iff the parameter's kind is 'dimension'. */
  dimension?: DimensionRef;
  /** Present iff the parameter's kind is 'measure'. */
  measure?: MeasureRef;
}

export interface DashboardParameter {
  id: string;
  name: string;
  kind: 'dimension' | 'measure';
  options: DashboardParameterOption[];
  /** Option selected when the dashboard opens (default 0). */
  defaultIndex?: number;
}

/* ------------------------------------------------------------------ bookmarks
 * Saved filter/page contexts (Power BI-style). Persisted in the layout doc;
 * the CAPTURED state mirrors the runtime shapes (slicer selections + view-mode
 * filter-card overrides) verbatim — both are already strictly serializable.
 */

/** Snapshot a bookmark restores: active page + full runtime filter context. */
export interface BookmarkState {
  pageId: string;
  /** Slicer selections keyed by slicer tile id (SlicerValues snapshot). */
  slicers: SlicerValues;
  /**
   * View-mode personal filter-card tweaks keyed by card id — structurally the
   * store's FilterCardOverride (enable/disable + basic selections).
   */
  filterOverrides: Record<string, { disabled?: boolean; basicValues?: FilterValue[] | null }>;
}

export interface DashboardBookmark {
  id: string;
  name: string;
  state: BookmarkState;
}

export interface DashboardLayoutDoc {
  version: 1;
  /**
   * Legacy single-page tile list. When `pages` is present and non-empty it is
   * the source of truth and this array is IGNORED — save keeps writing
   * `tiles: []` so pre-pages readers still parse the doc (they see it empty).
   */
  tiles: DashboardTile[];
  /** Legacy top-bar slicers; kept for old docs, emptied by the open migration. */
  slicers: SlicerDef[];
  /** View-mode auto-refresh interval in seconds; null/absent = off. */
  refreshSeconds?: number | null;
  /**
   * Cross-filter indicator look/placement (v1-compatible evolution; absent =
   * default pill).
   */
  filterIndicator?: FilterIndicatorStyle | null;
  /**
   * Multi-page dashboards (v1-compatible evolution; the wire version stays 1).
   * Absent on legacy docs — the open migration wraps `tiles` into a single
   * "Page 1". Save always writes pages.
   */
  pages?: DashboardPage[] | null;
  /**
   * Filters-pane cards (v1-compatible evolution; the wire version stays 1).
   * Absent on older docs = no cards; readers treat null/absent as empty.
   */
  filterCards?: FilterCard[] | null;
  /**
   * Saved bookmarks (v1-compatible evolution; the wire version stays 1).
   * Absent on older docs = none; readers treat null/absent as empty.
   */
  bookmarks?: DashboardBookmark[] | null;
  /**
   * Field parameters (v1-compatible evolution; the wire version stays 1).
   * Absent on older docs = none; readers treat null/absent as empty.
   */
  parameters?: DashboardParameter[] | null;
  /**
   * How far active cross-filters reach (v1-compatible evolution; absent =
   * 'page'). 'page' clears them on page switch (historic behavior);
   * 'dashboard' keeps them active across pages — every page's tiles honor
   * them and the indicator shows them everywhere, while the SOURCE tile's
   * click emphasis naturally only renders on its own page.
   */
  crossFilterScope?: CrossFilterScope | null;
  /**
   * Default view-mode sizing (v1-compatible evolution; absent = 'actual').
   * 'fitPage' scales the page's grid DOWN (never up past 1:1) so its full
   * height fits the box the host gives the dashboard — no vertical scrolling.
   * Viewers can override per session from the toolbar's View control; that
   * override is transient and never written here. Edit mode always renders
   * 1:1 (drag math), and the phone stack ignores fit entirely.
   */
  defaultViewFit?: ViewFitMode | null;
}

/** Reach of active cross-filters (layout doc `crossFilterScope`). */
export type CrossFilterScope = 'page' | 'dashboard';

/** View-mode page sizing (layout doc `defaultViewFit` + the toolbar control). */
export type ViewFitMode = 'actual' | 'fitPage';

export const isSlicerTile = (
  tile: DashboardTile,
): tile is DashboardTile & { kind: 'slicer'; slicer: SlicerTileSpec } =>
  tile.kind === 'slicer' && tile.slicer !== undefined;

export const isChartTile = (tile: DashboardTile): tile is DashboardTile & { chart: ChartSpec } =>
  (tile.kind === undefined || tile.kind === 'chart') && tile.chart !== undefined;

export const isTextTile = (
  tile: DashboardTile,
): tile is DashboardTile & { kind: 'text'; text: TextTileSpec } =>
  tile.kind === 'text' && tile.text !== undefined;

export const isImageTile = (
  tile: DashboardTile,
): tile is DashboardTile & { kind: 'image'; image: ImageTileSpec } =>
  tile.kind === 'image' && tile.image !== undefined;

export interface DashboardSummary {
  id: number;
  name: string;
  description: string | null;
  modelId: number | null;
  isShared: boolean;
  ownerIsMe: boolean;
  updatedAtUtc: string;
}

export interface DashboardDetail {
  id: number;
  name: string;
  description: string | null;
  modelId: number | null;
  isShared: boolean;
  ownerIsMe: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
  layout: DashboardLayoutDoc;
}

export const emptyLayout = (): DashboardLayoutDoc => ({ version: 1, tiles: [], slicers: [] });

/**
 * One accumulated cross-filter value (Ctrl/Cmd-click multi-select): the RAW
 * cell plus its formatted display label. `raw` null = the blank category
 * (compiles to isNull, and only ever alone — the clause vocabulary cannot
 * OR blanks with values).
 */
export interface CrossFilterValue {
  raw: FilterValue | null;
  label: string;
}

/**
 * Transient cross-filter raised by clicking a datum on a chart tile
 * (Power BI-style highlight). Runtime state only — it is NEVER serialized
 * into the layout document and resets whenever a dashboard opens/closes.
 * The store holds an ARRAY of these, AT MOST ONE PER (table, column): a new
 * click on an already-filtered field replaces/merges into that field's
 * entry (never stacks a duplicate clause).
 */
export interface CrossFilter {
  /** Chart tile the (last) click came from; that tile never filters itself. */
  sourceTileId: string;
  /**
   * Clause every OTHER chart tile must include: 'eq' for one value, 'in' for
   * an accumulated set, 'isNull' for the blank category, 'between' for a
   * date-bucket range.
   */
  clause: FilterClause;
  /** Human chip text, e.g. "region: West" or "region: West, Gulf Coast". */
  label: string;
  /**
   * Formatted display value(s) — the source chart's emphasis key while the
   * filter holds a SINGLE value: dimming for 'axis' clicks, persistent legend
   * emphasis for 'legend' selections. Multi-value sets join labels with ', '
   * (and date spans render 'Jul 2025 – Sep 2025').
   */
  categoryLabel: string;
  /**
   * What was clicked on the source chart: 'axis' = a datum/category (default,
   * absent on legacy state), 'legend' = a legend item (legendMode
   * 'crossFilter'). The source tile renders emphasis differently per kind —
   * the page-wide filtering path is identical.
   */
  kind?: 'axis' | 'legend';
  /**
   * The accumulated discrete values behind an eq/in/isNull clause (Ctrl-click
   * toggling and the chip "Edit value…" popover mutate this set). Absent for
   * date-range ('between') filters and for legacy single-clause state.
   */
  values?: CrossFilterValue[];
  /**
   * Display labels of a date-range filter's endpoint buckets, kept so a
   * Ctrl-click span extension can label the merged range from its true edges
   * ('Jul 2025 – Sep 2025'). Absent for discrete filters.
   */
  rangeLabels?: { start: string; end: string };
}

/**
 * Transient drillthrough context raised by invoking "Drill through" from a
 * point context menu. Runtime state only — NEVER serialized into the layout
 * document; it resets whenever a dashboard opens/closes. Its filters apply to
 * every chart tile on the TARGET page (same merge path as slicers).
 */
export interface DrillthroughState {
  /** Page the drillthrough was invoked from ("← Back" returns here). */
  sourcePageId: string;
  /** Page the drillthrough landed on; all of its charts receive `filters`. */
  targetPageId: string;
  /** One eq clause per drillthrough field, built from the clicked point. */
  filters: FilterClause[];
  /** Human chip text, e.g. "Gulf Coast". */
  label: string;
}

/**
 * Rich runtime slicer selection (relative-date slicers): the compiled clause
 * plus the preset id that produced it, so bookmarks capture the PRESET and
 * reapplying recomputes fresh dates instead of restoring stale ones.
 */
export interface SlicerPresetSelection {
  clause: FilterClause | null;
  /** Relative-date preset id ('last30d', 'ytd', 'lastN:<n>:<unit>', …). */
  presetId: string;
}

/**
 * One slicer's runtime value: a bare clause (every classic variant), a
 * preset-carrying selection (relative-date), or null (cleared). Bare clauses
 * stay the common shape so pre-existing bookmarks keep working.
 */
export type SlicerValue = FilterClause | SlicerPresetSelection | null;

/** Slicer selections (null = no selection) keyed by slicer tile id. */
export type SlicerValues = Record<string, SlicerValue>;

/** The wire clause behind a slicer value (either shape), null when cleared. */
export const slicerClauseOf = (value: SlicerValue | undefined): FilterClause | null => {
  if (value == null) return null;
  return 'presetId' in value ? value.clause : value;
};

/** The relative-date preset id riding a slicer value, if any. */
export const slicerPresetOf = (value: SlicerValue | undefined): string | null =>
  value != null && 'presetId' in value ? value.presetId : null;

export const mergedSlicerFilters = (values: SlicerValues): FilterClause[] =>
  Object.values(values)
    .map(slicerClauseOf)
    .filter((clause): clause is FilterClause => clause !== null);

/* ------------------------------------------------------ subscriptions/alerts
 * Wire mirrors of api/rcd/v1/subscriptions and api/rcd/v1/alerts (email
 * subscriptions + threshold alerts; the backend evaluates them server-side).
 */

export interface SubscriptionSchedule {
  kind: 'interval' | 'daily' | 'weekly';
  /** kind 'interval': minutes between sends. */
  everyMinutes?: number | null;
  /** kind 'daily'/'weekly': send time "HH:mm" (UTC). */
  timeUtc?: string | null;
  /** kind 'weekly': 0 (Sunday) … 6 (Saturday). */
  dayOfWeek?: number | null;
}

export interface DashboardSubscription {
  id: number;
  dashboardId: number;
  name: string;
  schedule: SubscriptionSchedule;
  recipients: string[];
  format: 'html' | 'csv';
  enabled: boolean;
}

/** Create/update body (id is server-assigned). */
export type SaveSubscriptionBody = Omit<DashboardSubscription, 'id'>;

export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export interface DashboardAlert {
  id: number;
  dashboardId?: number | null;
  name: string;
  /** 0-dimension, 1-measure query producing the scalar the alert watches. */
  spec: ChartQuerySpec;
  operator: AlertOperator;
  threshold: number;
  recipients: string[];
  /** Evaluation cadence in minutes. */
  everyMinutes: number;
  /** Minimum minutes between consecutive firings. */
  cooldownMinutes: number;
  enabled: boolean;
}

/** Create/update body (id is server-assigned). */
export type SaveAlertBody = Omit<DashboardAlert, 'id'>;

/** POST alerts/{id}/test → the current value and whether it would fire. */
export interface AlertTestResult {
  value: number | null;
  wouldFire: boolean;
}

/** One row of GET alerts/recent-firings. */
export interface AlertFiring {
  alertId: number;
  alertName: string;
  dashboardId?: number | null;
  firedAtUtc: string;
  value: number | null;
  threshold: number;
}
