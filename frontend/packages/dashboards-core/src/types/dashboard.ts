// Dashboard layout document (rcd_dashboards.LayoutJson) + API envelopes.
import type { ChartSpec, ContainerStyle } from './chart';
import type { DerivedField, Measure } from './model';
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
 * Look/placement of the active cross-filter indicator. Dashboard-level (layout
 * doc `filterIndicator`); the whole key is absent until an author configures
 * something, and every field falls back independently.
 */
export interface FilterIndicatorStyle {
  /**
   * Where the indicator docks. DEFAULT (absent) = 'header': compact chips
   * inline in the dashboard toolbar row, beside the name — the placement that
   * cannot cover a tile, and the reason this field is normally unset.
   *
   * 'footer' is a slim in-flow bar at the bottom edge. The five classic slots
   * ('top-center'/'top-left'/'top-right'/'bottom-left'/'bottom-right') FLOAT
   * OVER the tile area and are opt-in: they are only ever reached by an
   * explicit value here (authored in the Filters & indicator card, or by
   * dragging the chips onto a floating dock). Docs that saved one keep it —
   * changing the default only moved where an ABSENT value lands.
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
   * The look of the FLOATING and footer placements: 'pill' = compact floating
   * chip (old look, restyled); 'banner' = full-width accent bar listing every
   * active filter; 'stack' = one chip per filter, stacked at the docked
   * corner. The default 'header' placement ignores this — the toolbar row has
   * its own compact chip treatment.
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
   * CASCADING slicer (Power BI "filter available values"): the distinct-value
   * fetch behind this slicer is constrained by the dashboard's other active
   * filters, so the list only offers values that still exist under them.
   * Default false — absent keeps the unconstrained (full-column) list.
   *
   * The constraining set is `DashboardStore.cascadeFiltersForSlicer` (other
   * slicers on the same page + active cross-filters, ALWAYS excluding any
   * clause on this slicer's own table.column). Selections are never dropped:
   * a selected value the cascade trims away stays listed, dimmed.
   */
  cascade?: boolean;
  /**
   * relativeDate variant: persisted preset id (e.g. 'last30d', 'ytd',
   * 'lastN:6:month') applied when the dashboard opens with no runtime
   * selection yet. Runtime preset choices live in SlicerValues (bookmarks
   * capture them there); edit-mode choices also write here so they reload.
   */
  preset?: string | null;
  /**
   * SHARED slicer (COLLAB-DESIGN wave 2, owner-configured): in live
   * collaborative sessions a value picked on this slicer broadcasts as an
   * EPHEMERAL session value to everyone viewing the dashboard (never
   * persisted — the doc carries only this flag). Absent/false keeps today's
   * per-user selections. relativeDate `preset` writes stay authored doc
   * defaults and never ride this channel (each client derives the preset's
   * dates locally).
   */
  shared?: boolean;
}

/** Static rich-text tile content. `html` is ALWAYS a sanitized subset — every
 *  store write runs it through sanitizeRichHtml (util/richText). */
export interface TextTileSpec {
  html: string;
  /**
   * Edit-mode frame title (and the phone-editor row label); trimmed-empty or
   * absent falls back to "Text". Never rendered in view mode — text tiles stay
   * frameless there (mirrors ImageTileSpec.alt naming the image tile).
   */
  title?: string;
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

/**
 * Navigation-button tile (0.11.1): view-mode click switches to `targetPageId`
 * via setActivePage (which no-ops on dead ids, so a stale target is inert at
 * runtime; edit mode badges it as broken instead). Layout-class content, like
 * the other static kinds.
 */
export interface ButtonTileSpec {
  /**
   * RICH button label — sanitized subset like TextTileSpec.html (every store
   * write runs sanitizeRichHtml). Text color/size/bold ride the rich spans;
   * note the sanitizer's allowlist drops a literal <button> TAG — irrelevant
   * here, the label is spans/paragraphs inside the tile's own button chrome.
   */
  html: string;
  /** Page this button navigates to (by id — page renames never break it). */
  targetPageId: string;
  /**
   * Custom button fill — any hex, picked in the edit dialog (native picker +
   * hex field + recents) or the config card's fixed swatches; persisted
   * verbatim. null/absent = the default (preset) button look. A custom color
   * always overrides the preset chrome.
   */
  background?: string | null;
  /** Custom label text color (whole-button); rich spans inside the label can
   *  still override per-run. null/absent = theme text color. */
  textColor?: string | null;
  /** Corner radius in px; absent = 8. */
  radius?: number;
  /** True: the button fills the whole tile; false/absent: auto-sized, centered. */
  fullSize?: boolean;
  /**
   * Advanced free-form CSS declarations applied to the BUTTON element itself,
   * sanitized through util/buttonStyle's allowlist (visual properties only —
   * url()/var()/positioning/margins never survive) on EVERY store write and
   * again at render. ''/absent = none.
   */
  customCss?: string;
}

/** One button of a buttonGroup tile — the single-button fields sans tile-level
 *  concerns (fullSize is meaningless inside a flexed group; `align: 'stretch'`
 *  is the group's fill). Rendered by the SAME ButtonVisual as a single tile. */
export interface ButtonGroupButton {
  id: string;
  /** Rich label — same sanitize-on-every-write doctrine as ButtonTileSpec.html. */
  html: string;
  /** Page this button navigates to. */
  targetPageId: string;
  /** Custom fill; null/absent = default button look. */
  background?: string | null;
  /** Custom label text color; null/absent = theme text color. */
  textColor?: string | null;
  /** Corner radius in px; absent = 8. */
  radius?: number;
  /** Advanced CSS override — sanitized like ButtonTileSpec.customCss. */
  customCss?: string;
}

/**
 * Button-group tile: a flex container of navigation buttons with authored
 * packing (the single-button tile spaced buttons by grid geometry alone —
 * "minimum distance" between buttons was a full grid cell). Buttons render
 * identically to single button tiles; the container never scrolls — undersize
 * clips WHOLE buttons (never slices).
 */
export interface ButtonGroupTileSpec {
  buttons: ButtonGroupButton[];
  /** Main axis of the flex container. */
  direction: 'row' | 'column';
  /** Wrap onto additional rows/columns instead of clipping the main axis. */
  wrap: boolean;
  /** Gap between buttons in px (default 8 — tight). */
  gap: number;
  /** Cross-axis alignment ("Align (down)" for a row); 'stretch' fills buttons
   *  across the cross axis. */
  align: 'start' | 'center' | 'end' | 'stretch';
  /**
   * MAIN-axis placement ("Position (across)" for a row) — 0.14.1. Absent =
   * 'left', which is what every pre-0.14.1 group rendered as (justifyContent
   * was never set, so the browser default left-packed every row).
   */
  justify?: 'left' | 'center' | 'right' | 'between';
  /**
   * Container fill behind the buttons; null/absent = transparent. This is the
   * ONE writer for the group's fill — `container.background` means the same
   * thing and is never authored (the tile's config card writes here, and the
   * frame receives this value).
   */
  background?: string | null;
  /**
   * Tile-frame customization (0.14.1, A1) — the same ContainerStyle every
   * chart tile has. ABSENT = the legacy frameless look: no header bar AND no
   * card chrome, exactly what groups rendered before 0.14.1. Opting into the
   * standard container writes { hideHeader: false }. `background` above wins
   * over container.background.
   */
  container?: ContainerStyle | null;
  /** Frame title (header bar, print, phone-editor row); trimmed-empty or
   *  absent falls back to "Button group" (mirrors TextTileSpec.title). */
  title?: string;
  /** Uniform button size — the shared button scale (default 'md'). */
  size?: 'sm' | 'md' | 'lg';
  /** True: buttons share one width (auto-fill grid) instead of hugging their
   *  labels; false/absent = natural widths. */
  equalWidth?: boolean;
  /** Preset chrome for every button of the group, applied BELOW a button's own
   *  `background` (a custom fill always overrides the preset). Absent =
   *  'default', today's outline pill. */
  variant?: 'default' | 'primary' | 'ghost';
}

export interface DashboardTile {
  id: string;
  layout: TileLayout;
  /** Tile discriminator; absent = 'chart' (legacy docs). */
  kind?: 'chart' | 'slicer' | 'text' | 'image' | 'button' | 'buttonGroup';
  /** Present iff this is a chart tile (kind absent or 'chart'). */
  chart?: ChartSpec;
  /** Present iff this is a slicer tile (kind 'slicer'). */
  slicer?: SlicerTileSpec;
  /** Present iff this is a rich-text tile (kind 'text'). */
  text?: TextTileSpec;
  /** Present iff this is an image tile (kind 'image'). */
  image?: ImageTileSpec;
  /** Present iff this is a navigation-button tile (kind 'button'). */
  button?: ButtonTileSpec;
  /** Present iff this is a button-group tile (kind 'buttonGroup'). */
  buttonGroup?: ButtonGroupTileSpec;
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
  condition.operator === 'isBlank' ||
  condition.operator === 'notBlank' ||
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
      c.operator === 'isNull' ||
      c.operator === 'notNull' ||
      c.operator === 'isBlank' ||
      c.operator === 'notBlank' ||
      c.value == null
        ? []
        : [c.value],
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
   * DASHBOARD-SCOPED measures (v1-compatible evolution; the wire version stays
   * 1). Absent on older docs = none; readers treat null/absent as empty.
   *
   * A measure here belongs to THIS dashboard: it travels with duplicate and
   * share for free (the server stores and materializes LayoutJson verbatim),
   * and it is NOT in the semantic model, so every query that cites one must
   * carry its definition on the wire — see `toWireSpec`'s `definitions`
   * argument and `chartMeasureDefinitions`. Copying a chart to another
   * dashboard carries the definitions it references (dashboardStore's
   * copy/clipboard paths); scheduled email and alerts resolve them from this
   * array server-side.
   */
  measures?: Measure[] | null;
  /**
   * DASHBOARD-SCOPED derived fields (v1-compatible evolution; the wire version
   * stays 1). The exact sibling of `measures` above, for the same reasons:
   * they travel with duplicate and share for free, they are NOT in the
   * semantic model, and every query whose dimensions name one must carry its
   * definition on the wire (`toWireSpec`'s definitions bundle,
   * `chartDerivedFieldDefinitions`).
   */
  derivedFields?: DerivedField[] | null;
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

export const isButtonTile = (
  tile: DashboardTile,
): tile is DashboardTile & { kind: 'button'; button: ButtonTileSpec } =>
  tile.kind === 'button' && tile.button !== undefined;

export const isButtonGroupTile = (
  tile: DashboardTile,
): tile is DashboardTile & { kind: 'buttonGroup'; buttonGroup: ButtonGroupTileSpec } =>
  tile.kind === 'buttonGroup' && tile.buttonGroup !== undefined;

/* ------------------------------------------------------- sharing (0.8.0)
 * Real per-user shares + activity log. Every field here is ADDITIVE on the
 * wire — pre-0.8 servers simply omit them, and readers derive sensible
 * defaults via dashboardAccessOf.
 */

/** The caller's computed rights on one dashboard (server-authoritative). */
export interface DashboardAccess {
  isOwner: boolean;
  /** owner || CanManageShared admin || any granted edit flag. */
  canEdit: boolean;
  /** Doc settings, slicer/text/image/button tile adds/edits. */
  canEditLayout: boolean;
  /** Add/remove/rename/reorder/recolor pages (+ mobile layout, drillthrough). */
  canManagePages: boolean;
  /** Add chart tiles, edit chart specs/format (retitling stays owner/admin-only). */
  canEditCharts: boolean;
  /**
   * Move/resize tiles ("arrange tiles", 0.11.1). OPTIONAL on the wire —
   * pre-0.11.1 servers omit it; always read access through dashboardAccessOf,
   * which fills the gap from canEditLayout (the right it was split out of).
   */
  canMoveTiles?: boolean;
  /**
   * Remove tiles/pages on top of the matching class flag (0.11.1). OPTIONAL on
   * the wire — pre-0.11.1 servers omit it; dashboardAccessOf fills the gap
   * from canEditCharts || canManagePages (the classes removal used to ride).
   */
  canDeleteContent?: boolean;
  /** Access comes from a per-user share row. */
  viaShare: boolean;
  /** Access comes from the legacy publish ("Everyone") flag. */
  viaPublish: boolean;
}

/** One per-user grant row (GET dashboards/{id}/shares). */
export interface DashboardShare {
  userId: string;
  displayName: string | null;
  canEditLayout: boolean;
  canManagePages: boolean;
  canEditCharts: boolean;
  /** 0.11.1 — absent on older servers (treat as false). */
  canMoveTiles?: boolean;
  /** 0.11.1 — absent on older servers (treat as false). */
  canDeleteContent?: boolean;
  /** Who granted this row (0.11.1; opaque host id / resolved display name). */
  grantedByUserId?: string;
  grantedByDisplayName?: string | null;
  /** When the grant was first created (0.11.1). */
  createdAtUtc?: string;
  updatedAtUtc: string;
}

/** `saved` activity detail: the DashboardLayoutDiffer summary, camelCased. */
export interface LayoutChangeSummaryJson {
  layoutChanged?: boolean;
  pagesChanged?: boolean;
  chartsChanged?: boolean;
  /** Tile move/resize only (0.11.1 — split out of layoutChanged). */
  geometryChanged?: boolean;
  pagesAdded?: string[];
  pagesRemoved?: string[];
  pagesRenamed?: { from: string; to: string }[];
  tilesAdded?: number;
  tilesRemoved?: number;
  /** Titles of charts whose spec/format changed. */
  chartsModified?: string[];
  /** Chart retitles (0.11.1); from === to means only the inner title changed. */
  chartsRenamed?: { from: string; to: string }[];
  settingsChanged?: boolean;
}

/** shared/unshared/shareChanged activity detail. */
export interface ShareDetailJson {
  targetUserIds?: string[];
}

/** `renamed` activity detail: the dashboard's old and new name. */
export interface RenameDetailJson {
  from?: string;
  to?: string;
}

/** One row of GET dashboards/{id}/activity. */
export interface ActivityEntry {
  id: number;
  userId: string;
  displayName: string | null;
  /** created | saved | renamed | shared | unshared | shareChanged | left | deleted | duplicated */
  action: string;
  detail: LayoutChangeSummaryJson | ShareDetailJson | RenameDetailJson | null;
  atUtc: string;
}

/** One directory entry of GET users (the share-picker's data source). */
export interface RcdUser {
  id: string;
  displayName: string;
  email: string | null;
}

/**
 * The caller's access to a dashboard row, tolerating older servers:
 *  - pre-0.8 servers send no `myAccess` at all — the owner gets full rights,
 *    anyone else view-only (publish visibility is all a pre-shares server
 *    could have granted them);
 *  - pre-0.11.1 servers send `myAccess` WITHOUT canMoveTiles/canDeleteContent —
 *    those normalize to the rights they were split out of (move ⇐ layout,
 *    delete ⇐ charts||pages), so existing grantees keep their pre-split
 *    abilities against a lagging backend instead of silently losing UI.
 * The result ALWAYS carries both 0.11.1 flags — consumers never re-derive.
 */
export const dashboardAccessOf = (row: {
  ownerIsMe: boolean;
  isShared: boolean;
  myAccess?: DashboardAccess;
}): Required<DashboardAccess> => {
  const access =
    row.myAccess ??
    (row.ownerIsMe
      ? {
          isOwner: true,
          canEdit: true,
          canEditLayout: true,
          canManagePages: true,
          canEditCharts: true,
          viaShare: false,
          viaPublish: false,
        }
      : {
          isOwner: false,
          canEdit: false,
          canEditLayout: false,
          canManagePages: false,
          canEditCharts: false,
          viaShare: false,
          viaPublish: row.isShared,
        });
  return {
    ...access,
    canMoveTiles: access.canMoveTiles ?? access.canEditLayout,
    canDeleteContent: access.canDeleteContent ?? (access.canEditCharts || access.canManagePages),
  };
};

export interface DashboardSummary {
  id: number;
  name: string;
  description: string | null;
  modelId: number | null;
  isShared: boolean;
  ownerIsMe: boolean;
  updatedAtUtc: string;
  /** Built-in (seeded) read-only content (0.8.0+; absent on older servers). */
  isSystem?: boolean;
  /** Owner's directory display name (0.8.0+; null when unresolvable). */
  ownerDisplayName?: string | null;
  /** The caller's computed rights (0.8.0+; use dashboardAccessOf when absent). */
  myAccess?: DashboardAccess;
  /** Per-user grant count; 0 unless the caller is owner/admin (0.8.0+). */
  shareCount?: number;
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
  /** Built-in (seeded) read-only content (0.8.0+; absent on older servers). */
  isSystem?: boolean;
  /** Owner's directory display name (0.8.0+; null when unresolvable). */
  ownerDisplayName?: string | null;
  /**
   * Owner's opaque host id (0.14.1+; absent on older servers). ownerIsMe
   * answers "is this mine?" but never yields an id — the share dialog needs
   * the id itself to keep the owner out of its picker (the server refuses an
   * owner grant and fails the entire save).
   */
  ownerUserId?: string;
  /** The caller's computed rights (0.8.0+; use dashboardAccessOf when absent). */
  myAccess?: DashboardAccess;
  /** Per-user grant count; 0 unless the caller is owner/admin (0.8.0+). */
  shareCount?: number;
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
 *
 * The subscription shape is FLAT — scheduleKind plus nullable per-kind fields
 * — exactly mirroring the backend's SaveSubscriptionRequest/
 * SubscriptionResponse records. An earlier nested `schedule` object here
 * never matched the server (System.Text.Json 400'd every save on the
 * recipients array alone), so these types ARE the wire contract; UI
 * ergonomics (draft objects, recipient arrays) live inside the dialogs and
 * map at the fetch boundary.
 */

export type SubscriptionScheduleKind = 'interval' | 'daily' | 'weekly';

/** What each visual tile contributes to the email body. */
export type SubscriptionContentBody = 'tables' | 'charts' | 'both';

/** Logical chart-image width in px (480 Compact / 600 Standard / 900 Wide). */
export type SubscriptionImageWidth = 480 | 600 | 900;

/**
 * Email content composition — wire mirror of the backend's ContentJson
 * (camelCase, exactly this shape). null/absent on a response = legacy
 * behavior (tables only, 50-row cap); saves always send the explicit object.
 */
export interface SubscriptionContentConfig {
  body: SubscriptionContentBody;
  /** Tile ids omitted from the email entirely (≤200 entries server-side). */
  excludedTileIds: string[];
  imageWidth: SubscriptionImageWidth;
  /** Per-tile table row cap, 5..500 (replaces the old hard 50 cap). */
  maxTableRows: number;
}

export interface DashboardSubscription {
  id: number;
  dashboardId: number;
  name: string;
  scheduleKind: SubscriptionScheduleKind;
  /** kind 'interval': minutes between sends; null for other kinds. */
  intervalMinutes: number | null;
  /** kind 'daily'/'weekly': "HH:mm" wall time in the host's schedule zone
   * (DashboardsProvider scheduleTimeZoneId / backend ScheduleTimeZoneId). */
  timeOfDayLocal: string | null;
  /** kind 'weekly': 0 (Sunday) … 6 (Saturday) on the schedule zone's calendar. */
  dayOfWeek: number | null;
  /** ';'-joined email addresses — the backend splits on ';' ONLY (a ','
   * would validate as one address and then fail at SMTP). */
  recipients: string;
  format: 'html' | 'csv';
  enabled: boolean;
  /** Email content composition; null (or absent from a pre-0.14 server) =
   * legacy tables behavior. Saves always emit the explicit object. */
  content?: SubscriptionContentConfig | null;
  /* --- response-only fields (server-assigned) --- */
  ownerIsMe: boolean;
  /** ISO instant of the last send; null = never sent. */
  lastRunUtc: string | null;
  createdUtc: string;
  /** Opaque host user id of the owner. */
  ownerUserId: string;
  /** Owner display name via the host's IUserDirectory; only populated on scope=all listings. */
  ownerDisplayName?: string | null;
  /** Latest dispatch roll-up for the "Last delivery" badge; null = never dispatched. */
  lastDispatch?: SubscriptionDispatchSummary | null;
}

/** Create/update body (id + read-only response fields are server-assigned). */
export type SaveSubscriptionBody = Omit<
  DashboardSubscription,
  | 'id'
  | 'ownerIsMe'
  | 'lastRunUtc'
  | 'createdUtc'
  | 'ownerUserId'
  | 'ownerDisplayName'
  | 'lastDispatch'
>;

/**
 * Body of POST subscriptions/{id}/preview. An empty {} previews the SAVED
 * config; `content` overrides it for this render only (never persisted).
 */
export interface SubscriptionPreviewBody {
  content?: SubscriptionContentConfig | null;
}

/**
 * Body of POST dashboards/{dashboardId}/subscriptions/preview — an UNSAVED
 * draft rendered under the caller's own principal (format defaults to html).
 */
export interface DraftSubscriptionPreviewBody {
  format?: 'html' | 'csv';
  content: SubscriptionContentConfig | null;
}

/** The composed email both preview endpoints return — nothing is sent. */
export interface SubscriptionPreviewResult {
  subject: string;
  html: string;
}

/* --------------------------------------------------- dispatches (delivery)
 * Wire mirrors of subscriptions/{id}/dispatches and the live-progress event
 * the host may forward over its own socket (runtime.dashboards.
 * applyDispatchProgress). Every send — scheduled or send-now — writes one
 * dispatch row plus a row per recipient; open tracking is pixel-based and
 * inherently APPROXIMATE (mail clients proxy/block images), which is why the
 * UI labels it "Opened (approximate)".
 */

export type DispatchTrigger = 'schedule' | 'manual';

export type DispatchStatus = 'running' | 'sent' | 'partial' | 'failed' | 'skipped';

/** 'pending' = in flight or awaiting an in-process retry (max 3 attempts). */
export type DispatchRecipientStatus = 'pending' | 'sent' | 'failed' | 'optedOut';

export interface SubscriptionDispatchSummary {
  dispatchId: number;
  status: DispatchStatus;
  trigger: DispatchTrigger;
  startedUtc: string;
  finishedUtc: string | null;
  /** Occurrence-level error (render failure / skip reason). */
  error: string | null;
  sentCount: number;
  failedCount: number;
  optedOutCount: number;
  pendingCount: number;
}

export interface SubscriptionDispatchRecipient {
  id: number;
  email: string;
  status: DispatchRecipientStatus;
  attempts: number;
  error: string | null;
  sentUtc: string | null;
  /** First open-pixel hit; approximate by nature. */
  openedUtc: string | null;
  openCount: number;
}

export interface SubscriptionDispatch {
  id: number;
  subscriptionId: number;
  /** Name snapshot — survives subscription deletion. */
  subscriptionName: string;
  dashboardId: number;
  trigger: DispatchTrigger;
  /** User id for manual sends; null for scheduled runs. */
  requestedBy: string | null;
  startedUtc: string;
  finishedUtc: string | null;
  status: DispatchStatus;
  error: string | null;
  recipients: SubscriptionDispatchRecipient[];
}

/** One opt-out row (per-subscription or global; emails stored lower-cased). */
export interface SubscriptionOptOut {
  email: string;
  optedOutUtc: string;
}

/* ------------------------------------------------ live dispatch progress
 * The payload contract for the host's realtime bridge. The library never
 * owns a socket: hosts receive IRcdDispatchProgressNotifier calls on the
 * backend, forward ONE event stream to the owner's browser, and call
 * runtime.dashboards.applyDispatchProgress(event) with these shapes. UIs
 * that never receive events fall back to polling the dispatches endpoint.
 */

export interface DispatchProgressStarted {
  kind: 'started';
  dispatchId: number;
  subscriptionId: number;
  subscriptionName: string;
  trigger: DispatchTrigger;
  recipientCount: number;
  startedUtc: string;
}

export interface DispatchProgressRecipient {
  kind: 'recipient';
  dispatchId: number;
  subscriptionId: number;
  email: string;
  status: DispatchRecipientStatus;
  attempts: number;
  error: string | null;
}

export interface DispatchProgressFinished {
  kind: 'finished';
  dispatchId: number;
  subscriptionId: number;
  status: DispatchStatus;
  sentCount: number;
  failedCount: number;
  optedOutCount: number;
  error: string | null;
  finishedUtc: string;
}

export type DispatchProgressEvent =
  | DispatchProgressStarted
  | DispatchProgressRecipient
  | DispatchProgressFinished;

export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export interface DashboardAlert {
  id: number;
  dashboardId?: number | null;
  name: string;
  /** 0-dimension, 1-measure query producing the scalar the alert watches. */
  spec: ChartQuerySpec;
  operator: AlertOperator;
  threshold: number;
  /** ';'-joined email addresses — same wire rule as subscriptions. */
  recipients: string;
  /** Evaluation cadence in minutes. */
  everyMinutes: number;
  /** Minimum minutes between consecutive firings. */
  cooldownMinutes: number;
  enabled: boolean;
  /* --- response-only fields (server-assigned; absent from save bodies) --- */
  ownerIsMe?: boolean;
  lastEvaluatedUtc?: string | null;
  lastFiredUtc?: string | null;
  lastValue?: number | null;
  createdUtc?: string;
  /** Opaque host user id of the owner. */
  ownerUserId?: string;
  /** Owner display name; only populated on scope=all listings. */
  ownerDisplayName?: string | null;
}

/** Create/update body (id + read-only response fields are server-assigned). */
export type SaveAlertBody = Omit<
  DashboardAlert,
  | 'id'
  | 'ownerIsMe'
  | 'lastEvaluatedUtc'
  | 'lastFiredUtc'
  | 'lastValue'
  | 'createdUtc'
  | 'ownerUserId'
  | 'ownerDisplayName'
>;

/** POST alerts/{id}/test → the current value and whether it would fire. */
export interface AlertTestResult {
  value: number | null;
  wouldFire: boolean;
}

/** One row of GET alerts/recent-firings. Field names mirror the backend's
 * AlertFiringResponse exactly — the previous `alertName` never existed on the
 * wire (the toolbar rendered undefined for every firing). */
export interface AlertFiring {
  alertId: number;
  name: string;
  dashboardId?: number | null;
  firedAtUtc: string;
  value: number | null;
  operator: AlertOperator;
  threshold: number;
}
