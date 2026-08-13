import { inclusiveDateUpperBound, type ColumnType, type FilterClause } from '@recon/dashboards-core';

/**
 * Relative-date slicer presets. A preset compiles to a `between` FilterClause
 * with ISO dates computed AT SELECTION TIME from the current clock (inclusive
 * start; end = today except explicitly bounded presets like Last year).
 * 'all' clears the clause entirely. Custom rolling windows use the id form
 * `lastN:<n>:<unit>` (unit: day | week | month | year).
 */
export const RELATIVE_DATE_PRESETS: { id: string; label: string }[] = [
  { id: 'last7d', label: 'Last 7 days' },
  { id: 'last30d', label: 'Last 30 days' },
  { id: 'last90d', label: 'Last 90 days' },
  { id: 'last6m', label: 'Last 6 months' },
  { id: 'last12m', label: 'Last 12 months' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'thisQuarter', label: 'This quarter' },
  { id: 'thisYear', label: 'This year' },
  { id: 'ytd', label: 'YTD' },
  { id: 'lastYear', label: 'Last year' },
  { id: 'all', label: 'All time' },
];

export type RelativeUnit = 'day' | 'week' | 'month' | 'year';

export const RELATIVE_UNITS: { value: RelativeUnit; label: string }[] = [
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
  { value: 'year', label: 'years' },
];

/** Builds the custom rolling-window preset id. */
export const customPresetId = (n: number, unit: RelativeUnit): string => `lastN:${n}:${unit}`;

/** Parses a custom preset id; null when it is not one. */
export const parseCustomPreset = (id: string): { n: number; unit: RelativeUnit } | null => {
  const match = /^lastN:(\d+):(day|week|month|year)$/.exec(id);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 ? { n, unit: match[2] as RelativeUnit } : null;
};

/** Human label for any preset id (built-in or custom). */
export const relativePresetLabel = (id: string): string => {
  const preset = RELATIVE_DATE_PRESETS.find((p) => p.id === id);
  if (preset) return preset.label;
  const custom = parseCustomPreset(id);
  if (custom) {
    const unit = RELATIVE_UNITS.find((u) => u.value === custom.unit)?.label ?? custom.unit;
    return `Last ${custom.n} ${unit}`;
  }
  return id;
};

/** Local-timezone 'YYYY-MM-DD' (toISOString would shift across midnight UTC). */
const isoDate = (d: Date): string => {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

const addDays = (d: Date, days: number): Date => {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
};

/** Days in a month (month is 0-based; day 0 of the NEXT month is its last day). */
const daysInMonth = (year: number, month: number): number =>
  new Date(year, month + 1, 0).getDate();

/**
 * Month arithmetic with the day-of-month CLAMPED to the target month's length.
 * A bare setMonth overflows month-end dates (Mar 31 − 1 month → "Feb 31" →
 * Mar 3), silently shifting rolling windows computed at month ends.
 */
const addMonths = (d: Date, months: number): Date => {
  const total = d.getMonth() + months;
  const year = d.getFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return new Date(year, month, Math.min(d.getDate(), daysInMonth(year, month)));
};

/**
 * The [start, end] date range a preset denotes right now, or null for 'all'
 * (and for unknown ids — an unrecognized preset must never filter to nothing).
 */
export const relativePresetRange = (
  presetId: string,
  now: Date = new Date(),
): { start: string; end: string } | null => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = isoDate(today);
  const custom = parseCustomPreset(presetId);
  if (custom) {
    const start =
      custom.unit === 'day'
        ? addDays(today, -(custom.n - 1))
        : custom.unit === 'week'
          ? addDays(today, -(custom.n * 7 - 1))
          : custom.unit === 'month'
            ? addDays(addMonths(today, -custom.n), 1)
            : // Years route through the same clamped month arithmetic (a bare
              // Date(y-n, m, d) overflows Feb 29 into Mar 1 off leap years).
              addDays(addMonths(today, -custom.n * 12), 1);
    return { start: isoDate(start), end };
  }
  switch (presetId) {
    case 'last7d':
      return { start: isoDate(addDays(today, -6)), end };
    case 'last30d':
      return { start: isoDate(addDays(today, -29)), end };
    case 'last90d':
      return { start: isoDate(addDays(today, -89)), end };
    case 'last6m':
      return { start: isoDate(addDays(addMonths(today, -6), 1)), end };
    case 'last12m':
      return { start: isoDate(addDays(addMonths(today, -12), 1)), end };
    case 'thisMonth':
      return { start: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), end };
    case 'thisQuarter': {
      const quarterMonth = Math.floor(today.getMonth() / 3) * 3;
      return { start: isoDate(new Date(today.getFullYear(), quarterMonth, 1)), end };
    }
    case 'thisYear':
    case 'ytd':
      return { start: isoDate(new Date(today.getFullYear(), 0, 1)), end };
    case 'lastYear':
      return {
        start: isoDate(new Date(today.getFullYear() - 1, 0, 1)),
        end: isoDate(new Date(today.getFullYear() - 1, 11, 31)),
      };
    default:
      return null;
  }
};

/**
 * Compiles a preset to its wire clause against a date column; null for 'all'
 * (clears the filter). Callers re-invoke this on refresh ticks so rolling
 * windows stay anchored to "today".
 *
 * `columnType` is the catalog type of `column` (see `useColumnType`). Every
 * preset's `end` is an INCLUSIVE day, so on a `timestamp` column the bare
 * date would compare against that day's midnight and drop it from the window
 * — "Last 7 days" would really mean the last 6 plus a sliver. Null/unknown
 * keeps the bare date, which is the form a `date` column requires.
 */
export const relativePresetClause = (
  presetId: string,
  table: string,
  column: string,
  columnType?: ColumnType | null,
  now: Date = new Date(),
): FilterClause | null => {
  const range = relativePresetRange(presetId, now);
  if (range === null) return null;
  return {
    table,
    column,
    operator: 'between',
    values: [range.start, inclusiveDateUpperBound(range.end, columnType)],
  };
};
