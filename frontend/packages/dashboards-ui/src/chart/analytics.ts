import type {
  AxisScaleOptions,
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

// ---- axis scale resolution (AxisScaleOptions) ------------------------------

/** 1-2-5 nice step targeting ~5 ticks over `span`. */
const niceStep = (span: number): number => {
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
};

/**
 * 'auto'-range domain: the data extent padded ~5% each side, then snapped
 * outward to a 1-2-5 nice step so ticks read clean. Padding never crosses zero
 * artificially (an all-positive extent keeps a >= 0 floor, mirrored for
 * all-negative), which keeps bar baselines honest when they're near zero.
 */
export function paddedNiceDomain(min: number, max: number): [number, number] {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const pad = (max - min) * 0.05;
  let lo = min - pad;
  let hi = max + pad;
  if (min >= 0 && lo < 0) lo = 0;
  if (max <= 0 && hi > 0) hi = 0;
  const step = niceStep(hi - lo);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

/**
 * Min/max of the plotted values for one value axis. `stacked` bounds by the
 * per-row positive/negative sums (what the bars actually reach; zero — the
 * stack baseline — is always part of a stacked extent). Unlike
 * sharedValueDomain, zero is NOT forced in otherwise: range-mode callers add
 * the baseline themselves. Undefined when no numeric values exist.
 */
export function valueExtent(
  rows: Record<string, CellValue>[],
  keys: string[],
  stacked: boolean,
): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    let pos = 0;
    let neg = 0;
    let rowSaw = false;
    for (const key of keys) {
      const v = row[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      rowSaw = true;
      if (stacked) {
        if (v >= 0) pos += v;
        else neg += v;
      } else {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (stacked && rowSaw) {
      if (pos > max) max = pos;
      if (neg < min) min = neg;
      if (min > 0) min = 0;
      if (max < 0) max = 0;
    }
  }
  return min <= max ? [min, max] : undefined;
}

/** Extent of a plain numeric array (scatter axes). */
export function numberExtent(values: number[]): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? [min, max] : undefined;
}

/** Recharts axis props derived from an AxisScaleOptions + the data extent. */
export interface ResolvedAxisScale {
  /** Recharts `domain` prop; undefined keeps the default [0, 'auto']. */
  domain?: [number | string, number | string];
  /** 'log' only when a log10 scale is safe for the data. */
  scale?: 'log';
  /**
   * Log was requested but the data (or a custom min) crosses <= 0; the axis
   * rendered linear instead and the chart should surface a subtle note.
   */
  logFallback: boolean;
}

/**
 * Resolves AxisScaleOptions against the plotted extent:
 * - 'zero' (default): recharts' stock [0, 'auto'] — today's behavior.
 * - 'auto': paddedNiceDomain over the extent (fixes tiny-range clusters
 *   pinned to a zero-based axis).
 * - 'custom': explicit min/max; a null side stays 'auto' (data-fitted).
 * - log: scale 'log' with an ['auto','auto'] domain (0 can never sit on a log
 *   axis); when any plotted value or the custom min is <= 0 it falls back to
 *   linear and flags logFallback for an in-chart note (no console spam).
 */
export function resolveAxisScale(
  opts: AxisScaleOptions | undefined,
  extent: [number, number] | undefined,
): ResolvedAxisScale {
  if (!opts) return { logFallback: false };
  const range = opts.range ?? 'zero';
  const domain: [number | string, number | string] | undefined =
    range === 'custom'
      ? [opts.min ?? 'auto', opts.max ?? 'auto']
      : range === 'auto'
        ? extent
          ? paddedNiceDomain(extent[0], extent[1])
          : ['auto', 'auto']
        : undefined;
  if (opts.log) {
    const dataPositive = extent !== undefined && extent[0] > 0;
    const minPositive = typeof opts.min !== 'number' || opts.min > 0;
    if (dataPositive && minPositive) {
      return {
        scale: 'log',
        domain: range === 'custom' ? domain : ['auto', 'auto'],
        logFallback: false,
      };
    }
    return { domain, logFallback: true };
  }
  return { domain, logFallback: false };
}

/**
 * Shared small-multiples value domain over every panel's shaped rows, from the
 * listed series keys only (callers pass the VISIBLE keys so legend toggles
 * re-scale exactly like a single chart). Stacked charts bound by the per-row
 * positive and negative sums; plain charts by individual values. Zero is
 * included by default so panels keep the bar/area baseline; `zeroBase: false`
 * (yAxisScale range 'auto'/'custom') fits the raw extent instead — stacked
 * charts still reach the zero stack baseline through their row sums.
 * Undefined when no numeric values exist.
 */
export function sharedValueDomain(
  panelRows: Record<string, CellValue>[][],
  seriesKeys: string[],
  stacked: boolean,
  zeroBase = true,
): [number, number] | undefined {
  let min = zeroBase ? 0 : Number.POSITIVE_INFINITY;
  let max = zeroBase ? 0 : Number.NEGATIVE_INFINITY;
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
