import type {
  CellValue,
  ConditionalFormatSpec,
  ConditionalRule,
  ReferenceLineSpec,
  TrendlineSpec,
} from '@recon/dashboards-core';
import type { ChartSeries } from './chartData';

/**
 * Client-side chart analytics: reference-line statistics, trendline fitting,
 * conditional-format rule evaluation and the shared small-multiples value
 * domain. Pure data helpers (no recharts, no React) so ChartRenderer can reuse
 * them across chart types and small-multiple panels.
 */

/** Numeric values of one series across the shaped rows (null = missing). */
export const seriesValues = (
  rows: Record<string, CellValue>[],
  key: string,
): (number | null)[] =>
  rows.map((row) => (typeof row[key] === 'number' ? (row[key] as number) : null));

/**
 * Resolves a reference line to its value-axis position. Computed kinds
 * (average/median/min/max) read the FULL plotted dataset of the target series
 * — legend-toggle visibility is deliberately ignored, so a guide the user
 * anchored on never shifts while they explore series (and always matches what
 * the query returned). Null = nothing to draw (no data, or 'constant' with no
 * value).
 */
export function referenceLineValue(
  spec: ReferenceLineSpec,
  values: (number | null)[],
): number | null {
  if (spec.kind === 'constant') return typeof spec.value === 'number' ? spec.value : null;
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  switch (spec.kind) {
    case 'average':
      return nums.reduce((sum, v) => sum + v, 0) / nums.length;
    case 'median': {
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      // Even count: mean of the middle pair.
      return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
  }
}

/**
 * Least-squares linear fit with x = category index. Nulls are skipped when
 * fitting but every index gets a fitted value, so the overlay spans the whole
 * axis. All-null when fewer than two points exist (nothing to fit).
 */
export function linearFitValues(values: (number | null)[]): (number | null)[] {
  const points: [number, number][] = [];
  values.forEach((v, i) => {
    if (v !== null) points.push([i, v]);
  });
  if (points.length < 2) return values.map(() => null);
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const n = points.length;
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return values.map(() => null);
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return values.map((_, i) => intercept + slope * i);
}

/**
 * TRAILING moving average (window ends at each index). Centered windows look
 * smoother but need future points and shift the tail off the data; trailing
 * matches what most BI tools ship. Indexes without a full window of numeric
 * values yield null, so the overlay starts once the window fills.
 */
export function movingAverageValues(
  values: (number | null)[],
  window: number,
): (number | null)[] {
  const size = Math.max(1, Math.floor(window));
  return values.map((_, i) => {
    if (i < size - 1) return null;
    let sum = 0;
    for (let j = i - size + 1; j <= i; j++) {
      const v = values[j];
      if (v == null) return null; // partial windows stay blank
      sum += v;
    }
    return sum / size;
  });
}

/** One renderable trendline overlay: the injected dataKey + its source series. */
export interface TrendlineOverlay {
  dataKey: string;
  spec: TrendlineSpec;
  source: ChartSeries;
}

/**
 * Injects trendline values into COPIES of the shaped rows under synthetic
 * `__trend:` keys (never a real column name, so no collisions) and describes
 * one overlay <Line> per (trendline x target series). `seriesKey` (a styleKey
 * / display-name key) narrows to one series; undefined targets every series in
 * `targetSeries` — callers pass the currently VISIBLE series so a legend
 * toggle hides a series' trendline with it.
 */
export function buildTrendlines(
  specs: TrendlineSpec[],
  targetSeries: ChartSeries[],
  rows: Record<string, CellValue>[],
): { rows: Record<string, CellValue>[]; overlays: TrendlineOverlay[] } {
  const augmented = rows.map((row) => ({ ...row }));
  const overlays: TrendlineOverlay[] = [];
  for (const spec of specs) {
    const targets = spec.seriesKey
      ? targetSeries.filter((s) => s.styleKey === spec.seriesKey)
      : targetSeries;
    for (const series of targets) {
      const values = seriesValues(rows, series.key);
      const fitted =
        spec.kind === 'linear'
          ? linearFitValues(values)
          : movingAverageValues(values, spec.window ?? 3);
      if (!fitted.some((v) => v !== null)) continue;
      const dataKey = `__trend:${spec.id}:${series.key}`;
      fitted.forEach((v, i) => {
        augmented[i]![dataKey] = v;
      });
      overlays.push({ dataKey, spec, source: series });
    }
  }
  return { rows: augmented, overlays };
}

/**
 * Least-squares y-on-x fit for scatter points, returned as the two segment
 * endpoints at the observed x extent (two points draw the whole line). Null
 * when degenerate: fewer than two points, or zero x-variance (a vertical
 * stack has no defined slope).
 */
export function linearFitSegment(
  points: { x: number; y: number }[],
): [{ x: number; y: number }, { x: number; y: number }] | null {
  if (points.length < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const { x, y } of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const n = points.length;
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  return [
    { x: minX, y: intercept + slope * minX },
    { x: maxX, y: intercept + slope * maxX },
  ];
}

/** First matching rule's color; 'between' is inclusive on both bounds. */
export function matchRuleColor(rules: ConditionalRule[], value: number): string | undefined {
  for (const rule of rules) {
    const hit =
      rule.op === 'gt'
        ? value > rule.value
        : rule.op === 'gte'
          ? value >= rule.value
          : rule.op === 'lt'
            ? value < rule.value
            : rule.op === 'lte'
              ? value <= rule.value
              : rule.op === 'eq'
                ? value === rule.value
                : value >= rule.value && value <= (rule.value2 ?? rule.value);
    if (hit) return rule.color;
  }
  return undefined;
}

/**
 * Color from the first spec of `style` for `measureKey` whose rules match.
 * Specs evaluate in array order, like their rules — first match wins.
 * Non-numeric cells never match.
 */
export function conditionalColor(
  specs: ConditionalFormatSpec[] | undefined,
  style: ConditionalFormatSpec['style'],
  measureKey: string,
  value: CellValue,
): string | undefined {
  if (!specs || typeof value !== 'number') return undefined;
  for (const spec of specs) {
    if (spec.style !== style || spec.measureKey !== measureKey) continue;
    const color = matchRuleColor(spec.rules, value);
    if (color) return color;
  }
  return undefined;
}

/**
 * Shared small-multiples value domain over every panel's shaped rows, from the
 * listed series keys only (callers pass the VISIBLE keys so legend toggles
 * re-scale exactly like a single chart). Stacked charts bound by the per-row
 * positive and negative sums; plain charts by individual values. Zero is
 * always included so panels keep the bar/area baseline. Undefined when no
 * numeric values exist.
 */
export function sharedValueDomain(
  panelRows: Record<string, CellValue>[][],
  seriesKeys: string[],
  stacked: boolean,
): [number, number] | undefined {
  let min = 0;
  let max = 0;
  let sawValue = false;
  for (const rows of panelRows) {
    for (const row of rows) {
      let posSum = 0;
      let negSum = 0;
      for (const key of seriesKeys) {
        const v = row[key];
        if (typeof v !== 'number') continue;
        sawValue = true;
        if (stacked) {
          if (v >= 0) posSum += v;
          else negSum += v;
        } else {
          if (v > max) max = v;
          if (v < min) min = v;
        }
      }
      if (stacked) {
        if (posSum > max) max = posSum;
        if (negSum < min) min = negSum;
      }
    }
  }
  return sawValue ? [min, max] : undefined;
}
