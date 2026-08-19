// @vitest-environment jsdom
/**
 * ITEM 2 — the grand-total row's DATE round-trip.
 *
 * The totals row is a companion NO-dimension query over the same measures and
 * filters. Two things used to break for date columns:
 *  1. the reducer kept only `typeof value === 'number'`, so an ISO date total
 *     was silently nulled before it could reach formatCellValue;
 *  2. there was no way to say whether a date column should total as the
 *     EARLIEST or the LATEST value.
 * totalsMeasuresFor rewrites temporal INLINE measures to min/max per
 * TableOptions.dateAggregation — the same per-column rule the matrix parent
 * rows fold by (tableTree.measureFoldKinds), so the Total row and the
 * roll-ups can never disagree — and totalsRowFromResult passes every cell
 * through as-is.
 *
 * jsdom because the module under test is a React component module.
 */
import { describe, expect, it } from 'vitest';
import type { CellValue, MeasureRef, QueryColumn, QueryResult } from '@recon/dashboards-core';
import {
  totalsMeasureColumnsOf,
  totalsMeasuresFor,
  totalsRowFromResult,
} from '../src/dashboard/DashboardChartTile';

const column = (
  name: string,
  role: QueryColumn['role'],
  type: QueryColumn['type'],
): QueryColumn => ({
  name,
  label: name,
  role,
  type,
  source: null,
  dateBucket: null,
  formatHint: null,
});

const resultOf = (columns: QueryColumn[], rows: CellValue[][]): QueryResult => ({
  columns,
  rows,
  meta: { rowCount: rows.length, truncated: false, elapsedMs: 1, warnings: [], sql: null },
});

const COLUMNS = [
  column('dim0', 'dimension', 'text'),
  column('meas0', 'measure', 'decimal'),
  column('meas1', 'measure', 'date'),
  column('meas2', 'measure', 'timestamp'),
];

const MEASURES: MeasureRef[] = [
  { table: 'public.orders', column: 'total', aggregation: 'sum' },
  { table: 'public.orders', column: 'shipped_on', aggregation: 'min' },
  { table: 'public.orders', column: 'closed_at', aggregation: 'max' },
];

describe('totalsMeasureColumnsOf', () => {
  it('keeps only measure columns, in result order, tagged temporal', () => {
    expect(totalsMeasureColumnsOf(COLUMNS)).toEqual([
      { name: 'meas0', temporal: false },
      { name: 'meas1', temporal: true },
      { name: 'meas2', temporal: true },
    ]);
  });
});

describe('totalsMeasuresFor', () => {
  const columns = totalsMeasureColumnsOf(COLUMNS);

  it('defaults every temporal measure to EARLIEST (min)', () => {
    expect(totalsMeasuresFor(MEASURES, columns, undefined).map((m) => m.aggregation)).toEqual([
      'sum',
      'min',
      'min',
    ]);
  });

  it('rewrites per column to latest (max) when asked', () => {
    expect(
      totalsMeasuresFor(MEASURES, columns, { meas1: 'latest' }).map((m) => m.aggregation),
    ).toEqual(['sum', 'max', 'min']);
    expect(
      totalsMeasuresFor(MEASURES, columns, { meas1: 'latest', meas2: 'latest' }).map(
        (m) => m.aggregation,
      ),
    ).toEqual(['sum', 'max', 'max']);
  });

  it('never touches a NUMERIC measure, whatever the map says', () => {
    const rewritten = totalsMeasuresFor(MEASURES, columns, { meas0: 'latest' });
    expect(rewritten[0]).toBe(MEASURES[0]); // identity: untouched
    expect(rewritten[0]!.aggregation).toBe('sum');
  });

  it('leaves MODEL measures alone — their aggregation lives server-side', () => {
    const measures: MeasureRef[] = [{ measureId: 'm-first-order' }];
    const meta = [{ name: 'meas0', temporal: true }];
    expect(totalsMeasuresFor(measures, meta, { meas0: 'latest' })).toEqual(measures);
  });

  it('leaves an aggregation already correct as the SAME object (stable memo key)', () => {
    const rewritten = totalsMeasuresFor(MEASURES, columns, undefined);
    expect(rewritten[1]).toBe(MEASURES[1]); // min measure, earliest wanted
    expect(rewritten[2]).not.toBe(MEASURES[2]); // max measure, earliest wanted
    expect(rewritten[2]).toEqual({ ...MEASURES[2], aggregation: 'min' });
  });

  it('passes everything through untouched before the first result lands', () => {
    expect(totalsMeasuresFor(MEASURES, null, { meas1: 'latest' })).toEqual(MEASURES);
  });

  it('maps measures POSITIONALLY onto the measure columns', () => {
    // Only the SECOND wire measure is temporal, so only it is rewritten.
    const meta = [
      { name: 'meas0', temporal: false },
      { name: 'meas1', temporal: true },
      { name: 'meas2', temporal: false },
    ];
    expect(totalsMeasuresFor(MEASURES, meta, { meas1: 'latest' }).map((m) => m.aggregation)).toEqual(
      ['sum', 'max', 'max'],
    );
  });
});

describe('totalsRowFromResult', () => {
  it('carries DATE totals through as ISO strings (the round-trip that was broken)', () => {
    const result = resultOf(COLUMNS.slice(1), [[1234.5, '2026-01-31', '2026-12-01T09:00:00Z']]);
    expect(totalsRowFromResult(result)).toEqual([1234.5, '2026-01-31', '2026-12-01T09:00:00Z']);
  });

  it('aligns to MEASURE columns only, in result order', () => {
    const result = resultOf(COLUMNS, [['North', 10, '2026-01-01', '2026-02-02']]);
    expect(totalsRowFromResult(result)).toEqual([10, '2026-01-01', '2026-02-02']);
  });

  it('keeps booleans and nulls rather than coercing them away', () => {
    const columns = [column('meas0', 'measure', 'boolean'), column('meas1', 'measure', 'decimal')];
    expect(totalsRowFromResult(resultOf(columns, [[false, null]]))).toEqual([false, null]);
  });

  it('returns null when the companion query came back empty', () => {
    expect(totalsRowFromResult(resultOf(COLUMNS, []))).toBeNull();
  });

  it('nulls a genuinely missing cell instead of leaving a hole', () => {
    const result = resultOf(COLUMNS.slice(1), [[10]]);
    expect(totalsRowFromResult(result)).toEqual([10, null, null]);
  });
});
