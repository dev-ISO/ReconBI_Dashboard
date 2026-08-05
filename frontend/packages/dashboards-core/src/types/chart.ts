// GUI-side chart configuration. Strictly serializable; fetched data NEVER
// lives inside a spec. The query portion maps 1:1 onto the wire ChartQuerySpec
// via toWireSpec.
import type {
  CellValue,
  ChartQuerySpec,
  DimensionRef,
  FilterClause,
  FilterValue,
  MeasureRef,
  SortSpec,
} from './query';

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

/** Predefined chart color themes (8 categorical slots each; see util/palette THEMES). */
export type ChartThemeName = 'default' | 'ocean' | 'sunset' | 'forest' | 'berry' | 'mono';

/** Tile container customization; undefined fields keep the standard look. */
export interface ContainerStyle {
  /** No header bar; the tile is frameless (edit mode shows a hover drag strip). */
  hideHeader?: boolean;
  /** Hex background; null/undefined = theme surface. */
  background?: string | null;
  borderColor?: string | null;
  /** Border width px (default 1 when a color is set). */
  borderWidth?: number;
  /** Corner radius px (default 8). */
  borderRadius?: number;
  shadow?: 'none' | 'sm' | 'md' | 'lg';
  /**
   * Rich title rendered INSIDE the tile body above the chart (sanitized HTML —
   * util/richText allowlist). Independent of the header-bar title.
   */
  innerTitleHtml?: string | null;
}

/** Numeric axis label formatting. */
export interface AxisValueFormat {
  kind?: 'auto' | 'number' | 'currency' | 'percent' | 'compact';
  /** Fraction digits (compact/number/currency/percent). */
  decimals?: number;
}

/** Date axis label presets for bucketed dimensions. */
export type DateFormatPreset =
  | 'auto'
  | 'monthShort' // Jan
  | 'monthLong' // January
  | 'monthNum' // 1..12
  | 'monthYear' // Jan 2026
  | 'dayShort' // Mon
  | 'dayLong' // Monday
  | 'dayOfMonth' // 1..31
  | 'quarter' // Q1 2026
  | 'year' // 2026
  | 'isoDate'; // 2026-08-04

export interface SeriesLineStyle {
  dash?: 'solid' | 'dashed' | 'dotted';
  /** Stroke width px (default 2). */
  width?: number;
}

export interface TooltipStyle {
  enabled?: boolean;
  background?: string | null;
  textColor?: string | null;
  /** Colored per-series accent bar in the tooltip rows (default true). */
  accentBorder?: boolean;
  /** Append share-of-total percent (pie/donut/stacked). */
  showPercent?: boolean;
}

/** Horizontal/vertical guide drawn over cartesian charts. */
export interface ReferenceLineSpec {
  id: string;
  /** 'constant' uses `value`; the rest are computed from the plotted series. */
  kind: 'constant' | 'average' | 'median' | 'min' | 'max';
  value?: number;
  /** Series display-name key computed kinds read (default: first measure). */
  measureKey?: string;
  label?: string;
  color?: string;
  dash?: 'solid' | 'dashed' | 'dotted';
  width?: number;
  showLabel?: boolean;
}

/** Fitted overlay computed client-side from the plotted points. */
export interface TrendlineSpec {
  id: string;
  kind: 'linear' | 'movingAverage';
  /** Bucket window for movingAverage (default 3). */
  window?: number;
  /** Series display-name key (default: every visible series). */
  seriesKey?: string;
  color?: string;
  dash?: 'solid' | 'dashed' | 'dotted';
  width?: number;
}

export type ConditionalOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'between';

export interface ConditionalRule {
  op: ConditionalOp;
  value: number;
  /** Upper bound for 'between'. */
  value2?: number;
  color: string;
}

/** Value-driven styling; rules evaluate in order, first match wins. */
export interface ConditionalFormatSpec {
  id: string;
  /** Series display-name key the rules evaluate. */
  measureKey: string;
  /**
   * cellBackground/cellText: table cells. dataBar: proportional bar behind the
   * table cell. barFill: recolors single-series column/bar categories.
   * kpi: colors the KPI value text.
   */
  style: 'cellBackground' | 'cellText' | 'dataBar' | 'barFill' | 'kpi';
  rules: ConditionalRule[];
  /** Bar color for 'dataBar' (rules may still recolor matching cells). */
  dataBarColor?: string;
}

/** Small-multiples grid options (the split dimension lives on ChartQuery). */
export interface SmallMultiplesFormat {
  /** Panels per row; 'auto' fits to tile aspect (default). */
  columns?: number | 'auto';
  /** Cap on rendered panels, extra values dropped with a note (default 12). */
  maxPanels?: number;
  /** One shared y-domain across panels (default true). */
  sharedY?: boolean;
  showPanelTitles?: boolean;
}

/**
 * Transient per-tile drill position — NEVER persisted in the layout doc.
 * level 0 = the chart's own axis; path holds the clicked values that led here.
 */
export interface DrillState {
  level: number;
  path: { value: FilterValue; label: string }[];
}

/** Payload for point-level click / context-menu callbacks from the renderer. */
export interface ChartPointEvent {
  axisValue: CellValue;
  axisLabel: string;
  legendValue?: CellValue;
  legendLabel?: string;
  smallMultipleValue?: CellValue;
  /** Series display-name key and value of the struck point, when known. */
  measureKey?: string;
  value?: number | null;
  clientX: number;
  clientY: number;
}

export interface ChartFormat {
  /** Predefined palette; per-series colorOverrides still win. */
  theme?: ChartThemeName;
  container?: ContainerStyle;
  /** Numeric axis formats (value axis; x for horizontal bars/scatter-x). */
  xAxisFormat?: AxisValueFormat;
  yAxisFormat?: AxisValueFormat;
  /** Date label preset for bucketed date dimensions on the axis. */
  dateFormat?: DateFormatPreset;
  /** Per-series line style, keyed like colorOverrides (line/area charts). */
  lineStyles?: Record<string, SeriesLineStyle>;
  tooltip?: TooltipStyle;
  /** Legend items toggle series visibility on click (default true). */
  legendInteractive?: boolean;
  /**
   * What a legend click does (when legendInteractive): 'toggle' hides the
   * clicked series (default); 'isolate' shows ONLY it, second click restores;
   * 'crossFilter' spotlights that group across the entire page — the renderer
   * emits the clicked legend group and the tile cross-filters the dashboard by
   * its legend dimension (falls back to 'isolate' when there is no legend
   * dimension, e.g. measure-series legends).
   */
  legendMode?: 'toggle' | 'isolate' | 'crossFilter';
  /**
   * Sanitized rich-HTML axis titles (util/richText allowlist), rendered as
   * HTML overlays; when set they take precedence over the plain
   * xAxisLabel/yAxisLabel + axisTitleStyle pair.
   */
  xAxisLabelHtml?: string | null;
  yAxisLabelHtml?: string | null;
  /** Per-tile live refresh in seconds (overrides dashboard refresh; null = off). */
  refreshSeconds?: number | null;
  /** Guide lines drawn over cartesian charts (constant/average/median/min/max). */
  referenceLines?: ReferenceLineSpec[];
  /** Linear / moving-average overlays (line, area, column, scatter). */
  trendlines?: TrendlineSpec[];
  /** Value-driven cell/bar/KPI styling rules. */
  conditionalFormats?: ConditionalFormatSpec[];
  /** Grid options when query.smallMultiples is set. */
  smallMultiples?: SmallMultiplesFormat;
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
  /**
   * Drill hierarchy BELOW the axis (axis is level 0). Runtime drill position
   * is transient DrillState; the tile derives the effective axis + path
   * filters before building the wire spec.
   */
  drillLevels?: DimensionRef[];
  /** Series split (legend). */
  legend?: DimensionRef | null;
  /** Panel-per-value split (column/bar/line/area); rendered as a grid. */
  smallMultiples?: DimensionRef | null;
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
  // Order matters downstream: [axis, legend?, smallMultiples?].
  const dimensions: DimensionRef[] = [];
  if (chart.query.axis) dimensions.push(chart.query.axis);
  if (chart.query.legend) dimensions.push(chart.query.legend);
  if (chart.query.smallMultiples) dimensions.push(chart.query.smallMultiples);

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
