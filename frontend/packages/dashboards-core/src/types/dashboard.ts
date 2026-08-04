// Dashboard layout document (rcd_dashboards.LayoutJson) + API envelopes.
import type { ChartSpec } from './chart';
import type { FilterClause, FilterOperator, FilterValue } from './query';

export interface TileLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

/** How a slicer tile renders its value picker. */
export type SlicerVariant = 'checklist' | 'dropdown' | 'buttons' | 'dateRange';

/** Visual tweaks for a slicer tile; absent fields keep the standard look. */
export interface SlicerTileStyle {
  /** No header bar; the label renders as a small caption inside the body. */
  hideHeader?: boolean;
  /** Tighter paddings + smaller text (dense dashboards). */
  compact?: boolean;
}

export interface SlicerTileSpec {
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

/** One tab of a multi-page dashboard; tiles live per page (ids stay unique across pages). */
export interface DashboardPage {
  id: string;
  name: string;
  /** Optional tab accent (fixed palette hex, persisted verbatim); null/absent = none. */
  color?: string | null;
  tiles: DashboardTile[];
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
}

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
 * Transient cross-filter raised by clicking a datum on a chart tile
 * (Power BI-style highlight). Runtime state only — it is NEVER serialized
 * into the layout document and resets whenever a dashboard opens/closes.
 */
export interface CrossFilter {
  /** Chart tile the click came from; that tile never filters itself. */
  sourceTileId: string;
  /** Clause every OTHER chart tile must include ('eq' raw value, or 'isNull'). */
  clause: FilterClause;
  /** Human chip text, e.g. "region: West". */
  label: string;
  /** Plain formatted category label — the source chart's dimming key. */
  categoryLabel: string;
}

/** Slicer selections (null = no selection) keyed by slicer tile id. */
export type SlicerValues = Record<string, FilterClause | null>;

export const mergedSlicerFilters = (values: SlicerValues): FilterClause[] =>
  Object.values(values).filter((clause): clause is FilterClause => clause !== null);
