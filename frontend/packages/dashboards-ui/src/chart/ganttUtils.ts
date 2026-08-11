/**
 * Pure helpers for the gantt chart (kept beside GanttChart.tsx so the chart
 * file stays about rendering). Everything here is deterministic and free of
 * recharts/React imports, which also makes it trivially unit-testable.
 */
import type { GanttOptions } from '@recon/dashboards-core';
import type { GanttTask } from './chartData';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
/** Mean month/year lengths — only ever used to pick label units. */
export const MONTH = 30.44 * DAY;
export const YEAR = 365.25 * DAY;

/**
 * Compact on-bar duration text: '45m', '6h', '12d', '3.5mo', '2y'. Unit steps
 * mirror humanizeDurationMs (the tooltip's long form) so a bar never says
 * '12d' while its tooltip says '2 months'.
 */
export const shortDurationText = (ms: number): string => {
  const abs = Math.abs(ms);
  const say = (value: number, unit: string): string => {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${unit}`;
  };
  if (abs < HOUR) return say(abs / MINUTE, 'm');
  if (abs < 2 * DAY) return say(abs / HOUR, 'h');
  if (abs < 60 * DAY) return say(abs / DAY, 'd');
  if (abs < 730 * DAY) return say(abs / MONTH, 'mo');
  return say(abs / YEAR, 'y');
};

/**
 * Relative luminance of an explicit color, or null when it cannot be known at
 * render time. Palette defaults are CSS variables (`var(--rcd-cat-3)`) whose
 * value lives in the stylesheet, so they deliberately return null and callers
 * keep their existing fixed color — auto-contrast only ever kicks in for
 * colors the spec states outright (hex / rgb overrides and themed palettes).
 */
export const colorLuminance = (color: string): number | null => {
  const text = color.trim();
  let r: number;
  let g: number;
  let b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1]!;
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else {
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
    if (!rgb) return null;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }
  if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** Dark ink used on bars too light to carry white text (luminance 0.0092). */
const DARK_INK = '#111827';

/**
 * The bar luminance at which DARK_INK and white reach EQUAL WCAG contrast:
 * solving 1.05 / (L + 0.05) = (L + 0.05) / (0.0092 + 0.05) gives L ≈ 0.199.
 * Above it white is the worse choice — a mid-tone palette slot such as
 * '#c3c8d0' (L ≈ 0.57) carries white at 1.7:1 but DARK_INK at 8.9:1.
 */
const ON_BAR_INK_CROSSOVER = 0.199;

/** Ink for a label drawn ON a bar: white, unless the bar is too light for it. */
export const onBarTextColor = (barColor: string): string => {
  const luminance = colorLuminance(barColor);
  return luminance !== null && luminance > ON_BAR_INK_CROSSOVER ? DARK_INK : '#ffffff';
};

/**
 * Weekend spans [startMs, endMs) inside [min, max], clamped to the domain.
 * Saturday/Sunday are taken in UTC, matching the UTC-aligned tick grid (date
 * cells parse to UTC midnights), so the bands line up with the day ticks.
 * Returns [] past `maxBands` — a year of weekends would be visual noise.
 */
export const weekendBands = (min: number, max: number, maxBands = 80): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  // Walk back to the UTC midnight at/just before `min`, then hop by day.
  let day = Math.floor(min / DAY) * DAY;
  for (; day < max; day += DAY) {
    const dow = new Date(day).getUTCDay();
    if (dow !== 6 && dow !== 0) continue;
    const start = Math.max(day, min);
    const end = Math.min(day + DAY, max);
    if (end <= start) continue;
    const previous = out[out.length - 1];
    // Merge Sat+Sun into one band (fewer nodes, no seam line between them).
    if (previous && previous[1] >= start) previous[1] = end;
    else out.push([start, end]);
    if (out.length > maxBands) return [];
  }
  return out;
};

/**
 * Row order for the gantt. `undefined` sortBy means "leave the incoming
 * order", which is what shapeGanttData already produced (start ascending, or
 * the engine's own order when the query carries an explicit sort).
 */
export const sortGanttTasks = (
  tasks: GanttTask[],
  sortBy: GanttOptions['sortBy'],
  direction: GanttOptions['sortDirection'],
): GanttTask[] => {
  if (!sortBy) return tasks;
  const sign = direction === 'desc' ? -1 : 1;
  const value = (task: GanttTask): number => {
    if (sortBy === 'end') return task.endMs;
    if (sortBy === 'duration') return task.endMs - task.startMs;
    return task.startMs;
  };
  const sorted = [...tasks];
  sorted.sort((a, b) =>
    sortBy === 'name'
      ? sign * a.label.localeCompare(b.label, undefined, { numeric: true })
      : sign * (value(a) - value(b)),
  );
  return sorted;
};
