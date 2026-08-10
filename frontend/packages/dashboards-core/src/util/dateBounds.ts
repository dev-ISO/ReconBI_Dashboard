// One source of truth for how a date range's endpoints are rendered on the
// wire. Cross-filter bucket ranges, dateRange slicers and relative-date
// presets all route their INCLUSIVE upper endpoint through here, so a
// timestamp column can never silently lose its last day in one path while
// another path gets it right.
import type { ColumnType } from '../types/schema';

/** 'yyyy-MM-dd', optionally followed by a time part. Group 1 is the day. */
const DATE_SHAPED = /^(\d{4}-\d{2}-\d{2})(?:[T ][0-9:.]+)?$/;

/**
 * Last representable instant of a day for a Postgres `timestamp`, whose
 * resolution is microseconds — the exact predecessor of the next midnight.
 */
const LAST_INSTANT = 'T23:59:59.999999';

/**
 * The 'yyyy-MM-dd' part of a wire endpoint; null when the value is not
 * date-shaped. Read-side counterpart of `inclusiveDateUpperBound`: date
 * inputs, calendars and range labels only ever speak bare days, so an
 * endpoint carrying the timestamp bound has to be narrowed back before it is
 * shown or edited.
 */
export const dateOnlyPartOf = (value: string): string | null => {
  const match = DATE_SHAPED.exec(value);
  return match === null ? null : match[1]!;
};

/**
 * The human-facing form of a wire endpoint. A timestamp column's inclusive
 * upper bound reads as its DAY — "Aug 1 to 2026-08-21", not
 * "… to 2026-08-21T23:59:59.999999" — because that is the day the range
 * actually includes. Deliberately narrow: only the exact bound this module
 * emits is rewritten, so a real timestamp a user filtered on keeps its time.
 */
export const displayDateBound = (value: string): string =>
  value.endsWith(LAST_INSTANT) && DATE_SHAPED.test(value) ? value.slice(0, 10) : value;

/**
 * Renders the INCLUSIVE upper endpoint of a date range at the resolution of
 * the column it will be compared against.
 *
 * `between`/`lte` compile to `col <= b` against the RAW column, so the bound
 * has to match that column's own resolution:
 *  - `date` -> the bare day. The server parses it with DateOnly.Parse, which
 *    REJECTS any time component (a time-bearing string 400s), and whole-day
 *    inclusion is automatic.
 *  - `timestamp` -> the day's last instant. A bare date would compare against
 *    that day's MIDNIGHT and silently drop every row stamped later than
 *    00:00:00 — the range's last day vanishes.
 *
 * Any other, unknown or absent type is treated as `date`: the strictly-parsed
 * form is the one the backend can never reject, so a column type that could
 * not be resolved degrades to the historical behaviour rather than risking a
 * 400 on a real date column.
 *
 * Idempotent — an endpoint that already carries a time is narrowed to its day
 * first, so re-emitting a clause never double-suffixes it and never leaves a
 * time component on a date column. Non-date-shaped input is passed through
 * untouched.
 */
export const inclusiveDateUpperBound = (
  endpoint: string,
  columnType: ColumnType | null | undefined,
): string => {
  const day = dateOnlyPartOf(endpoint);
  if (day === null) return endpoint;
  return columnType === 'timestamp' ? `${day}${LAST_INSTANT}` : day;
};
