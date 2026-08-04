// GUI-side chart configuration. Strictly serializable; fetched data NEVER
// lives inside a spec. The query portion maps 1:1 onto the wire ChartQuerySpec
// via toWireSpec.
import type { ChartQuerySpec, DimensionRef, FilterClause, MeasureRef, SortSpec } from './query';

export type ChartType =
  | 'column'
  | 'bar'
  | 'stackedColumn'
  | 'stackedBar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'kpi'
  | 'table';

export interface ChartFormat {
  /** Per-series hex overrides keyed by series name; default palette otherwise. */
  colorOverrides?: Record<string, string>;
  showLegend?: boolean;
  legendPosition?: 'top' | 'right' | 'bottom';
  showDataLabels?: boolean;
  /** e.g. "#,0" | "0.0%" | "$#,0" — applied to measure values. */
  valueFormat?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
}

export interface ChartQuery {
  /** Category axis (or rows for table). */
  axis?: DimensionRef | null;
  /** Series split (legend). */
  legend?: DimensionRef | null;
  measures: MeasureRef[];
  filters: FilterClause[];
  sort?: SortSpec[];
  limit?: number | null;
}

export interface ChartSpec {
  id: string;
  type: ChartType;
  title: string;
  query: ChartQuery;
  format: ChartFormat;
}

export const emptyChart = (id: string): ChartSpec => ({
  id,
  type: 'column',
  title: 'New chart',
  query: { measures: [], filters: [] },
  format: {},
});

/** Dashboard slicer + per-chart filters are merged by the caller into extraFilters. */
export const toWireSpec = (
  chart: ChartSpec,
  modelId: number,
  extraFilters: FilterClause[] = [],
): ChartQuerySpec => {
  const dimensions: DimensionRef[] = [];
  if (chart.query.axis) dimensions.push(chart.query.axis);
  if (chart.query.legend) dimensions.push(chart.query.legend);

  return {
    modelId,
    dimensions,
    measures: chart.query.measures,
    filters: [...chart.query.filters, ...extraFilters],
    sort: chart.query.sort ?? [],
    limit: chart.query.limit ?? null,
  };
};

/** A chart is runnable once it has at least one measure. */
export const isRunnable = (chart: ChartSpec): boolean => chart.query.measures.length > 0;
