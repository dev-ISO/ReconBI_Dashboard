/**
 * Matrix (row-hierarchy) wire emission — ITEM 1 of the consumer-fixes wave.
 *
 * The contract under test is narrow and load-bearing:
 *  - `toWireSpec` emits dimensions [axis, drill1..drillN, legend?] for a TABLE
 *    whose matrix is active, and for nothing else. Every cartesian family keeps
 *    the historical [axis, legend?, smallMultiples?] order, which
 *    LayoutSnapshotParser and the email renderer index into positionally.
 *  - Matrix PREPENDS one ascending sort per hierarchy dimension so parent
 *    groups arrive contiguous and stable; the user's own sort follows and
 *    orders the leaves inside their parent.
 *  - `isMatrixChart` is the single predicate every consumer (validation,
 *    DashboardChartTile, TableChart, FormatPanel) shares.
 */
import { describe, expect, it } from 'vitest';
import type { DimensionRef, SortSpec } from './query';
import type { Measure } from './model';
import { stableStringify } from '../util/hash';
import { isMatrixChart, toWireSpec, type ChartSpec, type ChartType } from './chart';

const dim = (column: string): DimensionRef => ({ table: 'public.orders', column });

const REGION = dim('region');
const CITY = dim('city');
const STORE = dim('store');
const STATUS = dim('status');
const CHANNEL = dim('channel');

const MEASURE_SORT: SortSpec = { target: { kind: 'measure', index: 0 }, direction: 'desc' };

const specOf = (type: ChartType, query: Partial<ChartSpec['query']> = {}): ChartSpec => ({
  id: 'c1',
  type,
  title: 'T',
  query: {
    axis: REGION,
    measures: [{ table: 'public.orders', column: 'total', aggregation: 'sum' }],
    filters: [],
    ...query,
  },
  format: {},
});

/** Just the dimension columns, in wire order — the whole positional contract. */
const dimColumns = (spec: ChartSpec): string[] =>
  toWireSpec(spec, 1).dimensions.map((d) => d.column);

describe('isMatrixChart', () => {
  it('is on by default for a table with extra Rows fields', () => {
    expect(isMatrixChart(specOf('table', { drillLevels: [CITY] }))).toBe(true);
  });

  it('is off without drill levels, without an axis, or when explicitly disabled', () => {
    expect(isMatrixChart(specOf('table'))).toBe(false);
    expect(isMatrixChart(specOf('table', { drillLevels: [] }))).toBe(false);
    expect(isMatrixChart(specOf('table', { axis: null, drillLevels: [CITY] }))).toBe(false);

    const off = specOf('table', { drillLevels: [CITY] });
    off.format = { table: { matrix: false } };
    expect(isMatrixChart(off)).toBe(false);
  });

  it('never turns on for a non-table chart, whatever the format says', () => {
    for (const type of ['column', 'bar', 'line', 'area', 'pie', 'scatter', 'kpi'] as ChartType[]) {
      const spec = specOf(type, { drillLevels: [CITY] });
      spec.format = { table: { matrix: true } };
      expect(isMatrixChart(spec)).toBe(false);
    }
  });
});

describe('toWireSpec dimension order', () => {
  it('splices the row hierarchy between axis and legend for a matrix table', () => {
    const spec = specOf('table', { drillLevels: [CITY, STORE], legend: STATUS });
    expect(dimColumns(spec)).toEqual(['region', 'city', 'store', 'status']);
  });

  it('emits the hierarchy without a legend too', () => {
    expect(dimColumns(specOf('table', { drillLevels: [CITY, STORE] }))).toEqual([
      'region',
      'city',
      'store',
    ]);
  });

  it('drops drill levels again when matrix is switched off (legacy drill table)', () => {
    const spec = specOf('table', { drillLevels: [CITY, STORE], legend: STATUS });
    spec.format = { table: { matrix: false } };
    expect(dimColumns(spec)).toEqual(['region', 'status']);
  });

  it('leaves EVERY cartesian family on [axis, legend?, smallMultiples?]', () => {
    // The email renderer + LayoutSnapshotParser index these positionally; a
    // drill level sneaking in would silently re-map every series.
    for (const type of ['column', 'bar', 'stackedBar', 'line', 'area', 'combo'] as ChartType[]) {
      const spec = specOf(type, {
        drillLevels: [CITY, STORE],
        legend: STATUS,
        smallMultiples: CHANNEL,
      });
      expect(dimColumns(spec)).toEqual(['region', 'status', 'channel']);
    }
  });

  it('leaves pie/scatter/kpi untouched as well', () => {
    for (const type of ['pie', 'donut', 'scatter', 'kpi', 'gantt'] as ChartType[]) {
      const spec = specOf(type, { drillLevels: [CITY], legend: STATUS });
      expect(dimColumns(spec)).toEqual(['region', 'status']);
    }
  });
});

describe('toWireSpec matrix sort', () => {
  it('prepends one ascending sort per hierarchy dimension, user sort last', () => {
    const spec = specOf('table', { drillLevels: [CITY, STORE], sort: [MEASURE_SORT] });
    expect(toWireSpec(spec, 1).sort).toEqual([
      { target: { kind: 'dimension', index: 0 }, direction: 'asc' },
      { target: { kind: 'dimension', index: 1 }, direction: 'asc' },
      { target: { kind: 'dimension', index: 2 }, direction: 'asc' },
      MEASURE_SORT,
    ]);
  });

  it('prepends the hierarchy sorts even with no user sort at all', () => {
    const spec = specOf('table', { drillLevels: [CITY] });
    expect(toWireSpec(spec, 1).sort).toEqual([
      { target: { kind: 'dimension', index: 0 }, direction: 'asc' },
      { target: { kind: 'dimension', index: 1 }, direction: 'asc' },
    ]);
  });

  it('never touches the sort of a non-matrix chart', () => {
    expect(toWireSpec(specOf('column', { sort: [MEASURE_SORT] }), 1).sort).toEqual([MEASURE_SORT]);
    expect(toWireSpec(specOf('column'), 1).sort).toEqual([]);

    const off = specOf('table', { drillLevels: [CITY], sort: [MEASURE_SORT] });
    off.format = { table: { matrix: false } };
    expect(toWireSpec(off, 1).sort).toEqual([MEASURE_SORT]);
  });

  it('passes measures, filters and limit through unchanged', () => {
    const spec = specOf('table', { drillLevels: [CITY], limit: 25 });
    const wire = toWireSpec(spec, 7, [
      { table: 'public.orders', column: 'status', operator: 'eq', values: ['open'] },
    ]);
    expect(wire.modelId).toBe(7);
    expect(wire.measures).toEqual(spec.query.measures);
    expect(wire.filters).toHaveLength(1);
    expect(wire.limit).toBe(25);
  });
});

describe('toWireSpec measure definitions', () => {
  const DEFINITION: Measure = {
    id: 'm1',
    name: 'Dashboard Revenue',
    table: 'public.orders',
    aggregation: 'sum',
    column: 'total',
  };

  it('forwards definitions when the chart carries scoped measures', () => {
    const wire = toWireSpec(specOf('column'), 1, [], [DEFINITION]);
    expect(wire.definitions).toEqual([DEFINITION]);
  });

  it('omits the key entirely when there are none, so cache identity is unchanged', () => {
    // stableStringify(spec) IS the query cache key, so an always-present
    // `definitions: []` would silently invalidate every existing cache entry.
    const spec = specOf('column');
    expect('definitions' in toWireSpec(spec, 1)).toBe(false);
    expect('definitions' in toWireSpec(spec, 1, [], [])).toBe(false);
    expect('definitions' in toWireSpec(spec, 1, [], null)).toBe(false);
    expect(stableStringify(toWireSpec(spec, 1, [], []))).toBe(stableStringify(toWireSpec(spec, 1)));
  });

  it('changes the cache key when a definition changes', () => {
    const spec = specOf('column');
    const edited: Measure = { ...DEFINITION, column: 'quantity' };
    expect(stableStringify(toWireSpec(spec, 1, [], [DEFINITION]))).not.toBe(
      stableStringify(toWireSpec(spec, 1, [], [edited])),
    );
  });
});
