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

/**
 * Optional styling for a piece of chart text (title, axis titles, legend).
 * Every field is optional; an undefined field keeps the theme default
 * (fontSize 11-12, color var(--rcd-text-2), regular weight/style).
 */
export interface TextStyle {
  /** Font size in px. */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  /** Hex color (e.g. "#6b7280"); undefined -> theme default var(--rcd-text-2). */
  color?: string;
}

export interface ChartFormat {
  /**
   * Per-series hex overrides keyed by series name; default palette otherwise.
   * When colorByCategory is active (single-series column/bar) the keys are
   * CATEGORY labels instead and take precedence over the palette slot.
   */
  colorOverrides?: Record<string, string>;
  showLegend?: boolean;
  legendPosition?: 'top' | 'right' | 'bottom';
  showDataLabels?: boolean;
  /** e.g. "#,0" | "0.0%" | "$#,0" — applied to measure values. */
  valueFormat?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  /**
   * Styling for the chart title. The tile frame that renders the title applies
   * it (via the UI package's textStyleToCss helper); the KPI label line also
   * respects it.
   */
  titleStyle?: TextStyle;
  /** Styling for the x/y axis title labels (xAxisLabel / yAxisLabel). */
  axisTitleStyle?: TextStyle;
  /** Styling for legend text; the table chart's header row uses it too. */
  legendStyle?: TextStyle;
  /**
   * Display-name overrides keyed by the series' DEFAULT display name (measure
   * label, legend value, or pie slice label — the same keys colorOverrides
   * uses). Renames legend entries, tooltip series names, KPI labels and table
   * measure headers; colors and data keys stay bound to the original name.
   */
  seriesLabels?: Record<string, string>;
  /**
   * Column/bar only, and only when exactly one series renders: color each
   * category (each bar) from the categorical palette by slot index instead of
   * one color per series. colorOverrides keyed by category label win.
   */
  colorByCategory?: boolean;
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
