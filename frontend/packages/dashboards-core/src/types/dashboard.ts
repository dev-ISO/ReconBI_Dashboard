// Dashboard layout document (rcd_dashboards.LayoutJson) + API envelopes.
import type { ChartSpec } from './chart';
import type { FilterClause } from './query';

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

export interface SlicerTileSpec {
  table: string;
  column: string;
  label: string;
  variant: SlicerVariant;
  /** Hide the clear (x) affordance when explicitly false. */
  showClear?: boolean;
  /** Chart tile ids this slicer filters; null/absent = all charts. */
  targets?: string[] | null;
}

export interface DashboardTile {
  id: string;
  layout: TileLayout;
  /** Tile discriminator; absent = 'chart' (legacy docs). */
  kind?: 'chart' | 'slicer';
  /** Present iff this is a chart tile (kind absent or 'chart'). */
  chart?: ChartSpec;
  /** Present iff this is a slicer tile (kind 'slicer'). */
  slicer?: SlicerTileSpec;
}

/** Legacy (pre-tile) slicer definition; migrated into slicer tiles on open. */
export interface SlicerDef {
  id: string;
  table: string;
  column: string;
  label: string;
}

export interface DashboardLayoutDoc {
  version: 1;
  tiles: DashboardTile[];
  /** Legacy top-bar slicers; kept for old docs, emptied by the open migration. */
  slicers: SlicerDef[];
  /** View-mode auto-refresh interval in seconds; null/absent = off. */
  refreshSeconds?: number | null;
}

export const isSlicerTile = (
  tile: DashboardTile,
): tile is DashboardTile & { kind: 'slicer'; slicer: SlicerTileSpec } =>
  tile.kind === 'slicer' && tile.slicer !== undefined;

export const isChartTile = (tile: DashboardTile): tile is DashboardTile & { chart: ChartSpec } =>
  tile.kind !== 'slicer' && tile.chart !== undefined;

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
