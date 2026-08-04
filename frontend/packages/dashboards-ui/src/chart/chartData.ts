import {
  formatCellValue,
  seriesColor,
  type CellValue,
  type ChartSpec,
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
      label: column.label,
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
    label: value,
    color: seriesColor(i, value, spec.format.colorOverrides),
  }));

  return { data: [...byAxis.values()], series, axisKey: AXIS_KEY };
}

const toNumber = (value: CellValue): number | null => {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};
