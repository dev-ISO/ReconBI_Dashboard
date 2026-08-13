import { describe, expect, it } from 'vitest';
import type { QueryColumn } from '../types/query';
import { formatCellValue, formatDateLabel, formatDatePattern } from './format';

const dateColumn = (dateBucket: QueryColumn['dateBucket'] = null): QueryColumn => ({
  name: 'dim0',
  label: 'Date',
  role: 'dimension',
  type: 'date',
  source: 'public.orders.order_date',
  dateBucket,
  formatHint: null,
});

/* The assertions below hold in EVERY runner timezone: date-only strings and
 * naive timestamps are calendar parts, so their rendered day/month/year must
 * be the literal parts regardless of the local zone (findings 2/3); local-mode
 * assertions build their Date from local parts. */

describe('date-only string parsing (finding 2)', () => {
  it('formatDateLabel presets render the literal calendar parts', () => {
    expect(formatDateLabel('2026-08-04', dateColumn(), 'isoDate')).toBe('2026-08-04');
    expect(formatDateLabel('2026-08-04', dateColumn(), 'dayOfMonth')).toBe('4');
    expect(formatDateLabel('2026-08-04', dateColumn(), 'monthNum')).toBe('8');
    expect(formatDateLabel('2026-08-04', dateColumn(), 'year')).toBe('2026');
    expect(formatDateLabel('2026-08-04', dateColumn(), 'quarter')).toBe('Q3 2026');
    // 2026-08-04 is a Tuesday — as a calendar date, not as a local instant.
    expect(formatDateLabel('2026-08-04', dateColumn(), 'dayLong')).toBe('Tuesday');
  });

  it('formatCellValue buckets render the literal parts', () => {
    expect(formatCellValue('2026-01-01', dateColumn('year'))).toBe('2026');
    expect(formatCellValue('2026-10-01', dateColumn('quarter'))).toBe('Q4 2026');
    // Month bucket: January must never render as December (west-of-UTC bug).
    expect(formatCellValue('2026-01-01', dateColumn('month'))).toContain('2026');
    expect(formatCellValue('2026-01-01', dateColumn('month'))).not.toContain('Dec');
  });

  it('a custom mask renders the literal parts', () => {
    expect(formatDateLabel('2026-08-04', dateColumn(), 'auto', 'yyyy-MM-dd')).toBe('2026-08-04');
    expect(formatDateLabel('2026-08-04', dateColumn(), 'auto', '"Q"Qq yyyy')).toBe('Q3 2026');
  });
});

describe('naive timestamp parsing (finding 3)', () => {
  it('renders naive timestamps from their parts (no toISOString round-trip)', () => {
    expect(formatDateLabel('2026-08-04T13:45:00', dateColumn(), 'isoDate')).toBe('2026-08-04');
    expect(formatDateLabel('2026-08-04T00:00:00', dateColumn(), 'dayOfMonth')).toBe('4');
    expect(formatDateLabel('2026-12-31T23:59:59', dateColumn(), 'year')).toBe('2026');
  });

  it('keeps the naive time-of-day for HH:mm mask tokens', () => {
    const parsedLabel = formatDateLabel('2026-08-04T13:45:00', dateColumn(), 'auto', 'HH:mm');
    expect(parsedLabel).toBe('13:45');
  });
});

describe('formatDatePattern utc mode (finding 4)', () => {
  const utcDate = new Date(Date.UTC(2026, 7, 4, 13, 45)); // 2026-08-04T13:45Z

  it('utc: true renders through the getUTC* getters', () => {
    expect(formatDatePattern(utcDate, 'yyyy-MM-dd', { utc: true })).toBe('2026-08-04');
    expect(formatDatePattern(utcDate, 'HH:mm', { utc: true })).toBe('13:45');
    expect(formatDatePattern(utcDate, 'EEE', { utc: true })).toBe('Tue');
    expect(formatDatePattern(utcDate, 'MMM yyyy', { utc: true })).toBe('Aug 2026');
    expect(formatDatePattern(utcDate, '"Q"Qq', { utc: true })).toBe('Q3');
    expect(formatDatePattern(utcDate, 'yy', { utc: true })).toBe('26');
  });

  it('default mode keeps local getters (existing behavior)', () => {
    const localDate = new Date(2026, 0, 15, 9, 5); // local parts
    expect(formatDatePattern(localDate, 'yyyy-MM-dd')).toBe('2026-01-15');
    expect(formatDatePattern(localDate, 'HH:mm')).toBe('09:05');
  });

  it('never throws on invalid dates or masks', () => {
    expect(formatDatePattern(new Date(Number.NaN), 'yyyy', { utc: true })).toBe('');
    expect(formatDatePattern(utcDate, '"unterminated', { utc: true })).toBe('unterminated');
  });
});

describe('zoned values keep instant semantics', () => {
  it('a Z-suffixed timestamp still parses as an instant (local rendering)', () => {
    const value = '2026-08-04T00:00:00Z';
    const local = new Date(value);
    expect(formatDateLabel(value, dateColumn(), 'dayOfMonth')).toBe(String(local.getDate()));
    expect(formatDateLabel(value, dateColumn(), 'year')).toBe(String(local.getFullYear()));
  });
});
