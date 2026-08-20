/**
 * DERIVED FIELDS ACROSS SCOPES — and the one thing that makes them different
 * from measures: a chart cites a measure by ID, and a derived field by NAME.
 *
 * The name IS the column token in `{ table, column }`. So every operation that
 * can change a name — a copy that dedupes it, a merge onto a dashboard that
 * already has one — has to rewrite the chart with it, or the chart's axis
 * silently becomes a column the engine has never heard of.
 */
import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '../types/chart';
import type { DerivedField } from '../types/model';
import {
  chartDerivedFieldDefinitions,
  chartDimensionRefs,
  mergeDerivedFields,
  nextDerivedFieldCopyName,
  repointDerivedColumn,
} from './derivedFieldScope';

const field = (id: string, name: string, over: Partial<DerivedField> = {}): DerivedField => ({
  id,
  name,
  table: 'public.orders',
  expression: 'IF(ISBLANK(public.orders.shipped_at), "No", "Yes")',
  dataType: 'text',
  ...over,
});

const chartUsing = (column: string): ChartSpec => ({
  id: 'c1',
  type: 'column',
  title: 'Shipped',
  query: {
    axis: { table: 'public.orders', column },
    measures: [{ table: 'public.orders', column: 'total', aggregation: 'sum' }],
    filters: [],
  },
  format: {},
});

describe('chartDerivedFieldDefinitions', () => {
  const SHIPPED = field('f1', 'Shipped?');
  const OTHER = field('f2', 'Late?');

  it('carries only the fields the chart actually names', () => {
    expect(chartDerivedFieldDefinitions([SHIPPED, OTHER], chartUsing('Shipped?'))).toEqual([
      SHIPPED,
    ]);
  });

  it('finds a field addressed by id as well as by name', () => {
    expect(chartDerivedFieldDefinitions([SHIPPED], chartUsing('f1'))).toEqual([SHIPPED]);
  });

  it('covers filters too — a filter may name a derived column', () => {
    const chart = chartUsing('status');
    chart.query.filters = [
      { table: 'public.orders', column: 'Shipped?', operator: 'eq', values: ['Yes'] },
    ];
    expect(chartDerivedFieldDefinitions([SHIPPED, OTHER], chart)).toEqual([SHIPPED]);
  });

  it('carries nothing when the chart names no derived column', () => {
    expect(chartDerivedFieldDefinitions([SHIPPED], chartUsing('status'))).toEqual([]);
    expect(chartDerivedFieldDefinitions(null, chartUsing('Shipped?'))).toEqual([]);
  });

  it('chartDimensionRefs covers every well a dimension can sit in', () => {
    const chart = chartUsing('a');
    chart.query.drillLevels = [{ table: 'public.orders', column: 'b' }];
    chart.query.legend = { table: 'public.orders', column: 'c' };
    chart.query.smallMultiples = { table: 'public.orders', column: 'd' };
    expect(chartDimensionRefs(chart).map((ref) => ref.column)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('repointDerivedColumn', () => {
  it('rewrites every well and every filter that named the old column', () => {
    const chart = chartUsing('Shipped?');
    chart.query.legend = { table: 'public.orders', column: 'Shipped?' };
    chart.query.filters = [
      { table: 'public.orders', column: 'Shipped?', operator: 'eq', values: ['Yes'] },
    ];
    const next = repointDerivedColumn(chart, 'public.orders', 'Shipped?', 'Dispatched?');
    expect(next.query.axis?.column).toBe('Dispatched?');
    expect(next.query.legend?.column).toBe('Dispatched?');
    expect(next.query.filters[0]!.column).toBe('Dispatched?');
  });

  it('leaves a chart that never named it untouched, by identity', () => {
    const chart = chartUsing('status');
    expect(repointDerivedColumn(chart, 'public.orders', 'Shipped?', 'X')).toBe(chart);
  });

  it('never touches the same column name on a DIFFERENT table', () => {
    const chart = chartUsing('Shipped?');
    expect(repointDerivedColumn(chart, 'public.tickets', 'Shipped?', 'X').query.axis?.column).toBe(
      'Shipped?',
    );
  });
});

describe('mergeDerivedFields', () => {
  const SOURCE = field('f1', 'Shipped?');

  it('reuses an identical field already on the target and re-points the chart at ITS name', () => {
    const target = field('other-id', 'Dispatched?');
    const result = mergeDerivedFields([target], [SOURCE], chartUsing('Shipped?'));
    expect(result.added).toEqual([]);
    expect(result.reused).toEqual([target]);
    // The definitions match, so the two dashboards genuinely share the field —
    // the copied chart follows the target's spelling of its name.
    expect(result.chart?.query.axis?.column).toBe('Dispatched?');
  });

  it('dedupes a taken NAME and rewrites the chart onto the copy', () => {
    const target = field('other-id', 'Shipped?', { expression: 'something else' });
    const result = mergeDerivedFields([target], [SOURCE], chartUsing('Shipped?'));
    expect(result.renamed).toEqual([['Shipped?', 'Shipped? (copy)']]);
    expect(result.added[0]!.name).toBe('Shipped? (copy)');
    expect(result.chart?.query.axis?.column).toBe('Shipped? (copy)');
    // The target's own field is never mutated.
    expect(result.fields[0]).toBe(target);
  });

  it('mints a fresh id when the id is taken by a different definition', () => {
    const target = field('f1', 'Elsewhere', { expression: 'different' });
    const result = mergeDerivedFields([target], [SOURCE], null, () => 'minted');
    expect(result.added[0]!.id).toBe('minted');
    expect(result.added[0]!.name).toBe('Shipped?');
  });

  it('carrying nothing is a no-op that still returns the target list', () => {
    const result = mergeDerivedFields([SOURCE], []);
    expect(result.fields).toEqual([SOURCE]);
    expect(result.added).toEqual([]);
  });

  it('spells a copy the same way the measure rule does', () => {
    expect(nextDerivedFieldCopyName(['A'], 'A')).toBe('A (copy)');
    expect(nextDerivedFieldCopyName(['A', 'A (copy)'], 'A')).toBe('A (copy 2)');
  });
});
