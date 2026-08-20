import {
  AreaChart,
  BarChart3,
  BarChartHorizontal,
  ChartBarStacked,
  ChartColumnStacked,
  ChartGantt,
  CircleDot,
  Hash,
  LineChart,
  PieChart,
  ScatterChart,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import type { ChartType } from '@recon/dashboards-core';

/** One entry of the chart-type vocabulary: the picker's tile AND its label. */
export interface ChartTypeOption {
  type: ChartType;
  label: string;
  icon: LucideIcon;
  description: string;
}

/**
 * THE chart-type vocabulary — every ChartType exactly once, in picker order.
 * Lifted out of ChartTypePicker (where it was module-private) so surfaces that
 * only need a human label — the subscription tile checklist, for one — read the
 * same names the builder shows instead of re-hardcoding a second list that can
 * drift. The picker still owns how it RENDERS these; this module owns what they
 * are called.
 */
export const CHART_TYPE_OPTIONS: ChartTypeOption[] = [
  {
    type: 'column',
    label: 'Column',
    icon: BarChart3,
    description: 'Compare values across categories with vertical bars.',
  },
  {
    type: 'stackedColumn',
    label: 'Stacked column',
    icon: ChartColumnStacked,
    description: 'Show how parts add up to a total within each category.',
  },
  {
    type: 'bar',
    label: 'Bar',
    icon: BarChartHorizontal,
    description: 'Horizontal bars — best when category names are long.',
  },
  {
    type: 'stackedBar',
    label: 'Stacked bar',
    icon: ChartBarStacked,
    description: 'Horizontal stacked bars: parts of a total per category.',
  },
  {
    type: 'line',
    label: 'Line',
    icon: LineChart,
    description: 'Show a trend over time or ordered categories.',
  },
  {
    type: 'area',
    label: 'Area',
    icon: AreaChart,
    description: 'A line with the area filled — emphasizes magnitude.',
  },
  {
    type: 'pie',
    label: 'Pie',
    icon: PieChart,
    description: "Each category's share of the whole, as slices.",
  },
  {
    type: 'donut',
    label: 'Donut',
    icon: CircleDot,
    description: 'A pie with a center hole showing the total.',
  },
  {
    type: 'scatter',
    label: 'Scatter',
    icon: ScatterChart,
    description: 'Plot two measures against each other to spot patterns.',
  },
  {
    type: 'gantt',
    label: 'Gantt',
    icon: ChartGantt,
    description: 'Timeline bars from a start date to an end date — one row per task.',
  },
  {
    type: 'kpi',
    label: 'KPI',
    icon: Hash,
    description: 'One big number, with an optional comparison below it.',
  },
  {
    type: 'table',
    label: 'Table',
    icon: Table2,
    description: 'Rows and columns of values, sortable and pageable.',
  },
];

/** ChartType -> display label, derived from CHART_TYPE_OPTIONS (one source). */
export const CHART_TYPE_LABELS: Record<ChartType, string> = Object.fromEntries(
  CHART_TYPE_OPTIONS.map((option) => [option.type, option.label]),
) as Record<ChartType, string>;

/**
 * Label for a type read out of a saved doc. Docs are data, not types: a doc
 * written by a newer library (or hand-edited) can carry a type this build has
 * no name for, so the raw value is shown rather than "undefined".
 */
export const chartTypeLabel = (type: ChartType | string | undefined | null): string =>
  (type != null && CHART_TYPE_LABELS[type as ChartType]) || String(type ?? 'Chart');
