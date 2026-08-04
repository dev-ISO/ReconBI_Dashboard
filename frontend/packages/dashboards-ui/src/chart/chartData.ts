import {
  formatCellValue,
  seriesColor,
  type CellValue,
  type ChartSpec,
  type QueryColumn,
  type QueryResult,
} from '@recon/dashboards-core';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export interface ShapedChartData {
  /** One object per axis value: { axisLabel, [seriesKey]: number }. */
  data: Record<string, string | number | null>[];
  series: ChartSeries[];
  axisKey: string;
}

const AXIS_KEY = '__axis';

/**
 * Display name for a series: format.seriesLabels override (keyed by the
 * DEFAULT name — the same key colorOverrides uses) or the default itself.
 * Colors and data keys always stay bound to the default name so renaming a
 * series never re-shuffles its color or breaks existing overrides.
 */
const displayLabel = (defaultLabel: string, spec: ChartSpec): string =>
  spec.format.seriesLabels?.[defaultLabel] ?? defaultLabel;

/**
 * Pivots the engine's columnar result into recharts-friendly rows.
 * With a legend dimension: one series per legend value (first measure).
 * Without: one series per measure.
 */
export function shapeChartData(result: QueryResult, spec: ChartSpec): ShapedChartData {
  const dimensionColumns = result.columns.filter((c) => c.role === 'dimension');
  const measureColumns = result.columns.filter((c) => c.role === 'measure');
  const hasLegend = Boolean(spec.query.legend) && dimensionColumns.length >= 2;

  const axisColumn = dimensionColumns[0];
  const axisIndex = axisColumn ? result.columns.indexOf(axisColumn) : -1;

  if (!hasLegend) {
    const series: ChartSeries[] = measureColumns.map((column, i) => ({
      key: column.name,
      label: displayLabel(column.label, spec),
      color: seriesColor(i, column.label, spec.format.colorOverrides),
    }));

    const data = result.rows.map((row) => {
      const item: Record<string, string | number | null> = {
        [AXIS_KEY]: axisColumn ? formatCellValue(row[axisIndex] ?? null, axisColumn) : '',
      };
      for (const column of measureColumns) {
        item[column.name] = toNumber(row[result.columns.indexOf(column)] ?? null);
      }
      return item;
    });

    return { data, series, axisKey: AXIS_KEY };
  }

  // Legend pivot: axis x legend -> value of the FIRST measure.
  const legendColumn = dimensionColumns[1]!;
  const legendIndex = result.columns.indexOf(legendColumn);
  const measureColumn = measureColumns[0];
  const measureIndex = measureColumn ? result.columns.indexOf(measureColumn) : -1;

  const byAxis = new Map<string, Record<string, string | number | null>>();
  const legendValues: string[] = [];

  for (const row of result.rows) {
    const axisLabel = axisColumn ? formatCellValue(row[axisIndex] ?? null, axisColumn) : '';
    const legendLabel = formatCellValue(row[legendIndex] ?? null, legendColumn);
    if (!legendValues.includes(legendLabel)) legendValues.push(legendLabel);

    let item = byAxis.get(axisLabel);
    if (!item) {
      item = { [AXIS_KEY]: axisLabel };
      byAxis.set(axisLabel, item);
    }
    item[legendLabel] = measureIndex >= 0 ? toNumber(row[measureIndex] ?? null) : null;
  }

  const series: ChartSeries[] = legendValues.map((value, i) => ({
    key: value,
    label: displayLabel(value, spec),
    color: seriesColor(i, value, spec.format.colorOverrides),
  }));

  return { data: [...byAxis.values()], series, axisKey: AXIS_KEY };
}

export interface PieSlice {
  label: string;
  value: number;
  color: string;
}

export interface ShapedPieData {
  slices: PieSlice[];
}

/**
 * First dimension = slice label, first measure = slice value. Rows whose
 * measure is null/non-numeric are skipped; colors come from the categorical
 * slots with overrides keyed by slice label.
 */
export function shapePieData(result: QueryResult, spec: ChartSpec): ShapedPieData {
  const labelColumn = result.columns.find((c) => c.role === 'dimension') ?? null;
  const valueColumn = result.columns.find((c) => c.role === 'measure') ?? null;
  if (!valueColumn) return { slices: [] };

  const labelIndex = labelColumn ? result.columns.indexOf(labelColumn) : -1;
  const valueIndex = result.columns.indexOf(valueColumn);

  const slices: PieSlice[] = [];
  for (const row of result.rows) {
    const value = toNumber(row[valueIndex] ?? null);
    if (value === null) continue;
    const label = labelColumn
      ? formatCellValue(row[labelIndex] ?? null, labelColumn)
      : valueColumn.label;
    slices.push({
      label: displayLabel(label, spec),
      value,
      color: seriesColor(slices.length, label, spec.format.colorOverrides),
    });
  }
  return { slices };
}

export interface ScatterPoint {
  x: number;
  y: number;
}

export interface ScatterSeries {
  key: string;
  label: string;
  color: string;
  points: ScatterPoint[];
}

export interface ShapedScatterData {
  series: ScatterSeries[];
  /** First measure (x). Null when the query has fewer than two measures. */
  xColumn: QueryColumn | null;
  /** Second measure (y). Null when the query has fewer than two measures. */
  yColumn: QueryColumn | null;
  /** Distinct split values beyond the cap; their points are dropped entirely. */
  droppedSeries: number;
}

/** A scatter never renders more than this many series; the rest are dropped. */
export const SCATTER_SERIES_CAP = 3;

/**
 * x = first measure, y = second measure. When a dimension is present it splits
 * points into one series per distinct value — first SCATTER_SERIES_CAP distinct
 * values in row order; the remainder are dropped and counted in droppedSeries.
 */
export function shapeScatterData(result: QueryResult, spec: ChartSpec): ShapedScatterData {
  const measureColumns = result.columns.filter((c) => c.role === 'measure');
  const xColumn = measureColumns[0] ?? null;
  const yColumn = measureColumns[1] ?? null;
  if (!xColumn || !yColumn) return { series: [], xColumn, yColumn, droppedSeries: 0 };

  const xIndex = result.columns.indexOf(xColumn);
  const yIndex = result.columns.indexOf(yColumn);
  const splitColumn = result.columns.find((c) => c.role === 'dimension') ?? null;
  const splitIndex = splitColumn ? result.columns.indexOf(splitColumn) : -1;

  const bySeries = new Map<string, ScatterPoint[]>();
  const droppedKeys = new Set<string>();

  for (const row of result.rows) {
    const x = toNumber(row[xIndex] ?? null);
    const y = toNumber(row[yIndex] ?? null);
    if (x === null || y === null) continue;

    const key = splitColumn ? formatCellValue(row[splitIndex] ?? null, splitColumn) : '__all';
    let points = bySeries.get(key);
    if (!points) {
      if (bySeries.size >= SCATTER_SERIES_CAP) {
        droppedKeys.add(key);
        continue;
      }
      points = [];
      bySeries.set(key, points);
    }
    points.push({ x, y });
  }

  const series: ScatterSeries[] = [...bySeries.entries()].map(([key, points], i) => ({
    key,
    label: displayLabel(splitColumn ? key : 'All points', spec),
    color: seriesColor(i, key, spec.format.colorOverrides),
    points,
  }));

  return { series, xColumn, yColumn, droppedSeries: droppedKeys.size };
}

const toNumber = (value: CellValue): number | null => {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};
