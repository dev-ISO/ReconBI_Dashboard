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

export interface DashboardTile {
  id: string;
  layout: TileLayout;
  chart: ChartSpec;
}

export interface SlicerDef {
  id: string;
  table: string;
  column: string;
  label: string;
}

export interface DashboardLayoutDoc {
  version: 1;
  tiles: DashboardTile[];
  slicers: SlicerDef[];
}

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

/** Slicer selections (null = no selection) keyed by slicer id. */
export type SlicerValues = Record<string, FilterClause | null>;

export const mergedSlicerFilters = (values: SlicerValues): FilterClause[] =>
  Object.values(values).filter((clause): clause is FilterClause => clause !== null);
