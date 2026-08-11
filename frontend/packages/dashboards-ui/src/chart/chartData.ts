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
  /**
   * DEFAULT display name of the measure behind this series (measure mode: the
   * series itself; legend pivot: the pivoted measure; combo: the measure
   * half). Secondary-axis assignment (format.secondaryAxisKeys) matches on it
   * so listing a measure moves ALL its combo series to y2 at once.
   */
  measureLabel?: string;
}

export interface ShapedChartData {
  /** One object per axis value: { axisLabel, rawAxis, [seriesKey]: number }. */
  data: Record<string, CellValue>[];
  series: ChartSeries[];
  axisKey: string;
  /** True when series came from a legend dimension (vs one per measure). */
  hasLegend: boolean;
  /**
   * True when the axis is a date-BUCKETED dimension — the axis kind the
   * zoom.dragAction 'crossFilter' range-select is allowed to emit for (raw
   * bucket cells are exact filterable date values there).
   */
  axisIsDate: boolean;
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
    ? formatDateLabel(value, column, spec.format.dateFormat, spec.format.dateFormatPattern)
    : formatCellValue(value, column);

/**
 * format.trimEmptyEdges: drops LEADING and TRAILING categories where every
 * plotted series value is null (e.g. the 12-month warm-up of a period-change
 * calc). Interior all-null categories stay — a mid-series gap is data, an
 * empty edge is noise. Runs at shape time, so axis ticks, tooltips, zoom and
 * brush indices all address the same trimmed rows. All-empty data returns
 * unchanged (trimming everything would blank the axis too).
 */
const trimEmptyEdgeRows = (
  data: Record<string, CellValue>[],
  seriesKeys: string[],
): Record<string, CellValue>[] => {
  const isEmpty = (row: Record<string, CellValue>): boolean =>
    seriesKeys.every((key) => row[key] == null);
  let first = 0;
  while (first < data.length && isEmpty(data[first]!)) first++;
  if (first === data.length) return data;
  let last = data.length - 1;
  while (last > first && isEmpty(data[last]!)) last--;
  return first === 0 && last === data.length - 1 ? data : data.slice(first, last + 1);
};

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
  const axisIsDate = Boolean(axisColumn && axisColumn.dateBucket !== null);

  // format.excludeBlankDates (default TRUE): rows with a null DATE-BUCKETED
  // axis cell are dropped before shaping — a "(Blank)" bucket on a time axis
  // is missing data that skews the series (same doctrine as densification's
  // null-axis drop in the calc paths). Explicit false keeps the blank
  // category; non-date axes are never touched.
  const sourceRows =
    axisIsDate && axisIndex >= 0 && spec.format.excludeBlankDates !== false
      ? result.rows.filter((row) => (row[axisIndex] ?? null) !== null)
      : result.rows;

  if (!hasLegend) {
    const series: ChartSeries[] = measureColumns.map((column, i) => ({
      key: column.name,
      label: displayLabel(column.label, spec),
      color: seriesColor(i, column.label, spec.format.colorOverrides, spec.format.theme),
      styleKey: column.label,
      measureLabel: column.label,
    }));

    const data = sourceRows.map((row) => {
      const item: Record<string, CellValue> = {
        [AXIS_KEY]: axisColumn ? categoryLabel(row[axisIndex] ?? null, axisColumn, spec) : '',
        [RAW_AXIS_KEY]: axisColumn ? (row[axisIndex] ?? null) : null,
      };
      for (const column of measureColumns) {
        item[column.name] = toNumber(row[result.columns.indexOf(column)] ?? null);
      }
      return item;
    });

    return {
      data: spec.format.trimEmptyEdges
        ? trimEmptyEdgeRows(
            data,
            series.map((s) => s.key),
          )
        : data,
      series,
      axisKey: AXIS_KEY,
      hasLegend: false,
      axisIsDate,
    };
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

  for (const row of sourceRows) {
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
            measureLabel: measure.label,
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
        measureLabel: pivotMeasures[0]?.label,
      }));

  const pivoted = [...byAxis.values()];
  return {
    data: spec.format.trimEmptyEdges
      ? trimEmptyEdgeRows(
          pivoted,
          series.map((s) => s.key),
        )
      : pivoted,
    series,
    axisKey: AXIS_KEY,
    hasLegend: true,
    axisIsDate,
  };
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

// ---------------------------------------------------------------------------
// Gantt shaping
// ---------------------------------------------------------------------------

export interface GanttTask {
  /** RAW (pre-format) task-dimension cell — click-to-filter identity. */
  raw: CellValue;
  /** Formatted task label (the category-axis text). */
  label: string;
  /** Bar span in epoch ms (start <= end; reversed inputs are swapped). */
  startMs: number;
  endMs: number;
  /** FORMATTED group value; null when the query has no group dimension. */
  group: string | null;
  /** RAW group cell (legend cross-filter identity). */
  groupRaw: CellValue;
  /** Normalized completion 0..1 (accepts 0-1 or 0-100 input); null = none. */
  progress: number | null;
}

export interface GanttGroup {
  label: string;
  raw: CellValue;
  /** Theme-palette slot color (colorOverrides keyed by group label win). */
  color: string;
}

export interface ShapedGanttData {
  /** Valid tasks, default-sorted by start when the spec carries no sort. */
  tasks: GanttTask[];
  /** Distinct groups in first-appearance order; empty without a group dim. */
  groups: GanttGroup[];
  /** measures[0] / measures[1] / measures[2] wire columns (null = missing). */
  startColumn: QueryColumn | null;
  endColumn: QueryColumn | null;
  progressColumn: QueryColumn | null;
  /** Rows dropped because start or end was null/unparseable. */
  skipped: number;
}

/** Epoch ms from a wire cell: ISO strings parse, numbers pass through. */
const toEpochMs = (value: CellValue): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/** Progress cell → 0..1 (values above 1 are read as 0-100 percent). */
const toProgressFraction = (value: CellValue): number | null => {
  const n = toNumber(value);
  if (n === null) return null;
  const fraction = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, fraction));
};

/**
 * Shapes a gantt result. Wire contract (toWireSpec): dimensions arrive
 * [axis = task, legend? = group]; measures [start, end, progress?] — start/end
 * are Min/Max over date columns and arrive as ISO strings (numeric columns are
 * accepted as epoch ms). Rows whose start OR end is null/unparseable are
 * skipped and counted; reversed spans are swapped rather than dropped. When
 * the spec has no explicit sort the tasks order by start ascending — the
 * conventional gantt reading order — otherwise engine row order is kept.
 */
export function shapeGanttData(result: QueryResult, spec: ChartSpec): ShapedGanttData {
  const dimensionColumns = result.columns.filter((c) => c.role === 'dimension');
  const measureColumns = result.columns.filter((c) => c.role === 'measure');
  const taskColumn = dimensionColumns[0] ?? null;
  const groupColumn = spec.query.legend ? (dimensionColumns[1] ?? null) : null;
  const startColumn = measureColumns[0] ?? null;
  const endColumn = measureColumns[1] ?? null;
  const progressColumn = measureColumns[2] ?? null;
  if (!startColumn || !endColumn) {
    return { tasks: [], groups: [], startColumn, endColumn, progressColumn, skipped: 0 };
  }

  const taskIndex = taskColumn ? result.columns.indexOf(taskColumn) : -1;
  const groupIndex = groupColumn ? result.columns.indexOf(groupColumn) : -1;
  const startIndex = result.columns.indexOf(startColumn);
  const endIndex = result.columns.indexOf(endColumn);
  const progressIndex = progressColumn ? result.columns.indexOf(progressColumn) : -1;

  const tasks: GanttTask[] = [];
  const groups: GanttGroup[] = [];
  let skipped = 0;
  for (const row of result.rows) {
    const start = toEpochMs(row[startIndex] ?? null);
    const end = toEpochMs(row[endIndex] ?? null);
    if (start === null || end === null) {
      skipped++;
      continue;
    }
    const groupRaw = groupColumn ? (row[groupIndex] ?? null) : null;
    const group = groupColumn ? formatCellValue(groupRaw, groupColumn) : null;
    if (group !== null && !groups.some((g) => g.label === group)) {
      groups.push({
        label: group,
        raw: groupRaw,
        color: seriesColor(groups.length, group, spec.format.colorOverrides, spec.format.theme),
      });
    }
    tasks.push({
      raw: taskColumn ? (row[taskIndex] ?? null) : null,
      label: taskColumn
        ? formatCellValue(row[taskIndex] ?? null, taskColumn)
        : startColumn.label,
      startMs: Math.min(start, end),
      endMs: Math.max(start, end),
      group,
      groupRaw,
      progress: progressIndex >= 0 ? toProgressFraction(row[progressIndex] ?? null) : null,
    });
  }

  if (!spec.query.sort?.length) tasks.sort((a, b) => a.startMs - b.startMs);
  return { tasks, groups, startColumn, endColumn, progressColumn, skipped };
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
