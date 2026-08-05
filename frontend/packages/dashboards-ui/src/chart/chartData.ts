import {
  formatCellValue,
  formatDateLabel,
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
  /**
   * The series' DEFAULT display name (measure label / legend value) — the key
   * format.colorOverrides, lineStyles and seriesLabels all use. `key` is the
   * recharts dataKey (column NAME in measure mode) and can differ from it.
   */
  styleKey: string;
  /**
   * RAW (pre-format) legend cell backing this series in legend-pivot mode, so
   * point events can carry an exact filterable value. Undefined in measure
   * mode (the series is a measure, not a legend value).
   */
  legendRaw?: CellValue;
  /**
   * FORMATTED legend cell (pre-seriesLabels-override) backing this series.
   * Present only in legend-pivot mode — its presence is what marks a series as
   * carrying a legend identity (crossFilter legend mode needs one). In combo
   * mode this is the legend half of the name; `label` holds the full combo.
   */
  legendLabel?: string;
}

export interface ShapedChartData {
  /** One object per axis value: { axisLabel, rawAxis, [seriesKey]: number }. */
  data: Record<string, CellValue>[];
  series: ChartSeries[];
  axisKey: string;
  /** True when series came from a legend dimension (vs one per measure). */
  hasLegend: boolean;
}

const AXIS_KEY = '__axis';

/**
 * Hidden row field carrying the RAW axis cell (pre-format CellValue) so click
 * handlers can build exact filter clauses; the formatted label under axisKey
 * stays display-only. Never rendered — recharts only reads declared dataKeys.
 */
export const RAW_AXIS_KEY = '__rawAxis';

/**
 * Separator inside combo (measure × legend) dataKeys: `<column name><US><legend
 * label>`. U+001F (unit separator) never appears in wire column names or
 * formatted cells, so combo keys can't collide with plain keys or each other.
 */
const COMBO_KEY_SEP = String.fromCharCode(0x1f);

/** Default display name of a combo series: "<Measure> — <Legend value>". */
const comboName = (measureLabel: string, legendLabel: string): string =>
  `${measureLabel} — ${legendLabel}`;

/**
 * Wire measure-column name behind a series dataKey. Combo keys encode it
 * before the separator; every other key passes through unchanged (measure-mode
 * keys ARE column names; legend labels simply won't match any column).
 */
export const measureNameForKey = (key: string): string => {
  const sep = key.indexOf(COMBO_KEY_SEP);
  return sep === -1 ? key : key.slice(0, sep);
};

/**
 * Display name for a series: format.seriesLabels override (keyed by the
 * DEFAULT name — the same key colorOverrides uses) or the default itself.
 * Colors and data keys always stay bound to the default name so renaming a
 * series never re-shuffles its color or breaks existing overrides.
 */
const displayLabel = (defaultLabel: string, spec: ChartSpec): string =>
  spec.format.seriesLabels?.[defaultLabel] ?? defaultLabel;

/**
 * Category label for an axis (or pie-label) cell. Date-BUCKETED columns honor
 * format.dateFormat via formatDateLabel — which falls back to the bucket-aware
 * formatCellValue default on 'auto'/unset — so shape-time labels are already
 * the final tick text.
 */
const categoryLabel = (value: CellValue, column: QueryColumn, spec: ChartSpec): string =>
  column.dateBucket !== null
    ? formatDateLabel(value, column, spec.format.dateFormat)
    : formatCellValue(value, column);

/**
 * Pivots the engine's columnar result into recharts-friendly rows.
 * With a legend dimension: one series per legend value (first measure) —
 * except line/area with MULTIPLE measures, which get one series per
 * (measure × legend value) combo. Without a legend: one series per measure.
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
      color: seriesColor(i, column.label, spec.format.colorOverrides, spec.format.theme),
      styleKey: column.label,
    }));

    const data = result.rows.map((row) => {
      const item: Record<string, CellValue> = {
        [AXIS_KEY]: axisColumn ? categoryLabel(row[axisIndex] ?? null, axisColumn, spec) : '',
        [RAW_AXIS_KEY]: axisColumn ? (row[axisIndex] ?? null) : null,
      };
      for (const column of measureColumns) {
        item[column.name] = toNumber(row[result.columns.indexOf(column)] ?? null);
      }
      return item;
    });

    return { data, series, axisKey: AXIS_KEY, hasLegend: false };
  }

  // Legend pivot. line/area with SEVERAL measures keep them all: one series
  // per (measure × legend value) combo. Every other chart type — and
  // single-measure line/area — pivots the FIRST measure only, exactly as
  // before (dataKeys, colors and labels byte-identical, so existing dashboards
  // never reshuffle).
  const legendColumn = dimensionColumns[1]!;
  const legendIndex = result.columns.indexOf(legendColumn);
  const comboMode =
    (spec.type === 'line' || spec.type === 'area') && measureColumns.length > 1;
  const pivotMeasures = comboMode ? measureColumns : measureColumns.slice(0, 1);

  const byAxis = new Map<string, Record<string, CellValue>>();
  const legendValues: string[] = [];
  const legendRawByLabel = new Map<string, CellValue>();

  for (const row of result.rows) {
    const axisLabel = axisColumn ? categoryLabel(row[axisIndex] ?? null, axisColumn, spec) : '';
    const legendLabel = formatCellValue(row[legendIndex] ?? null, legendColumn);
    if (!legendValues.includes(legendLabel)) {
      legendValues.push(legendLabel);
      legendRawByLabel.set(legendLabel, row[legendIndex] ?? null);
    }

    let item = byAxis.get(axisLabel);
    if (!item) {
      item = {
        [AXIS_KEY]: axisLabel,
        [RAW_AXIS_KEY]: axisColumn ? (row[axisIndex] ?? null) : null,
      };
      byAxis.set(axisLabel, item);
    }
    if (pivotMeasures.length === 0) {
      item[legendLabel] = null;
    } else {
      for (const measure of pivotMeasures) {
        const key = comboMode ? `${measure.name}${COMBO_KEY_SEP}${legendLabel}` : legendLabel;
        item[key] = toNumber(row[result.columns.indexOf(measure)] ?? null);
      }
    }
  }

  // Combo series are MEASURE-major ("Revenue — East, Revenue — West, Profit —
  // East, …") so the legend groups by measure; the palette index advances per
  // combo. styleKey is the full combo name, so seriesLabels / colorOverrides /
  // lineStyles keyed by "<Measure> — <Legend value>" all resolve.
  const series: ChartSeries[] = comboMode
    ? pivotMeasures.flatMap((measure, mi) =>
        legendValues.map((value, li) => {
          const name = comboName(measure.label, value);
          return {
            key: `${measure.name}${COMBO_KEY_SEP}${value}`,
            label: displayLabel(name, spec),
            color: seriesColor(
              mi * legendValues.length + li,
              name,
              spec.format.colorOverrides,
              spec.format.theme,
            ),
            styleKey: name,
            legendRaw: legendRawByLabel.get(value) ?? null,
            legendLabel: value,
          };
        }),
      )
    : legendValues.map((value, i) => ({
        key: value,
        label: displayLabel(value, spec),
        color: seriesColor(i, value, spec.format.colorOverrides, spec.format.theme),
        styleKey: value,
        legendRaw: legendRawByLabel.get(value) ?? null,
        legendLabel: value,
      }));

  return { data: [...byAxis.values()], series, axisKey: AXIS_KEY, hasLegend: true };
}

export interface PieSlice {
  label: string;
  value: number;
  color: string;
  /** Raw (pre-format) label cell for click-to-filter; null when unlabeled. */
  raw: CellValue;
}

export interface ShapedPieData {
  slices: PieSlice[];
}

/**
 * First dimension = slice label, first measure = slice value. Rows whose
 * measure is null/non-numeric are skipped; colors come from the theme palette
 * (or categorical slots) with overrides keyed by slice label.
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
      ? categoryLabel(row[labelIndex] ?? null, labelColumn, spec)
      : valueColumn.label;
    slices.push({
      label: displayLabel(label, spec),
      value,
      color: seriesColor(slices.length, label, spec.format.colorOverrides, spec.format.theme),
      raw: labelColumn ? (row[labelIndex] ?? null) : null,
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
  /** RAW (pre-format) split-dimension cell; null when there is no split. */
  raw: CellValue;
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
 * The LEGEND dimension is the preferred split when the spec has one (points
 * group into colored legend series even when an axis dimension is also
 * present); otherwise the first dimension splits, as before.
 */
export function shapeScatterData(result: QueryResult, spec: ChartSpec): ShapedScatterData {
  const measureColumns = result.columns.filter((c) => c.role === 'measure');
  const xColumn = measureColumns[0] ?? null;
  const yColumn = measureColumns[1] ?? null;
  if (!xColumn || !yColumn) return { series: [], xColumn, yColumn, droppedSeries: 0 };

  const xIndex = result.columns.indexOf(xColumn);
  const yIndex = result.columns.indexOf(yColumn);
  // Wire dimension order is [axis?, legend?, smallMultiples?] (toWireSpec).
  const dimensionColumns = result.columns.filter((c) => c.role === 'dimension');
  const splitColumn = spec.query.legend
    ? (dimensionColumns[spec.query.axis ? 1 : 0] ?? dimensionColumns[0] ?? null)
    : (dimensionColumns[0] ?? null);
  const splitIndex = splitColumn ? result.columns.indexOf(splitColumn) : -1;

  const bySeries = new Map<string, { points: ScatterPoint[]; raw: CellValue }>();
  const droppedKeys = new Set<string>();

  for (const row of result.rows) {
    const x = toNumber(row[xIndex] ?? null);
    const y = toNumber(row[yIndex] ?? null);
    if (x === null || y === null) continue;

    const key = splitColumn ? formatCellValue(row[splitIndex] ?? null, splitColumn) : '__all';
    let bucket = bySeries.get(key);
    if (!bucket) {
      if (bySeries.size >= SCATTER_SERIES_CAP) {
        droppedKeys.add(key);
        continue;
      }
      bucket = { points: [], raw: splitColumn ? (row[splitIndex] ?? null) : null };
      bySeries.set(key, bucket);
    }
    bucket.points.push({ x, y });
  }

  const series: ScatterSeries[] = [...bySeries.entries()].map(([key, bucket], i) => ({
    key,
    label: displayLabel(splitColumn ? key : 'All points', spec),
    color: seriesColor(i, key, spec.format.colorOverrides, spec.format.theme),
    points: bucket.points,
    raw: bucket.raw,
  }));

  return { series, xColumn, yColumn, droppedSeries: droppedKeys.size };
}

export interface SmallMultiplePanel {
  /** RAW small-multiples dimension cell (panel identity for events/filters). */
  value: CellValue;
  /** Formatted panel caption. */
  title: string;
  /** The wire result minus the SM column, rows filtered to this panel. */
  result: QueryResult;
}

/**
 * Partitions a result on the small-multiples dimension. Per the wire contract
 * dimensions arrive ordered [axis, legend?, smallMultiples?], so the SM column
 * is the dimension column at ordinal (axis?1:0)+(legend?1:0). Returns null
 * when the spec has no SM dimension or the result doesn't carry it (e.g. a
 * stale cache entry) — callers then render the normal single chart. Panel
 * order follows first appearance in row order (the engine's sort).
 */
export function splitSmallMultiples(
  result: QueryResult,
  spec: ChartSpec,
): SmallMultiplePanel[] | null {
  if (!spec.query.smallMultiples) return null;
  const dimensionColumns = result.columns.filter((c) => c.role === 'dimension');
  const smOrdinal = (spec.query.axis ? 1 : 0) + (spec.query.legend ? 1 : 0);
  const smColumn = dimensionColumns[smOrdinal];
  if (!smColumn) return null;
  const smIndex = result.columns.indexOf(smColumn);

  const strippedColumns = result.columns.filter((_, i) => i !== smIndex);
  const panels = new Map<string, SmallMultiplePanel>();
  for (const row of result.rows) {
    const title = formatCellValue(row[smIndex] ?? null, smColumn);
    let panel = panels.get(title);
    if (!panel) {
      panel = {
        value: row[smIndex] ?? null,
        title,
        result: { columns: strippedColumns, rows: [], meta: result.meta },
      };
      panels.set(title, panel);
    }
    panel.result.rows.push(row.filter((_, i) => i !== smIndex));
  }
  return [...panels.values()];
}

const toNumber = (value: CellValue): number | null => {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};
