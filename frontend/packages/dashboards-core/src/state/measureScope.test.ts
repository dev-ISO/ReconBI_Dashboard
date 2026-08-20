/**
 * Scoped-measure plumbing: what a chart must CARRY on the query wire, and what
 * happens when a chart carrying dashboard measures lands on a dashboard that
 * already has measures of its own.
 *
 * The three collisions the merge has to resolve are the whole reason copy used
 * to be broken:
 *  - identical definition          → reuse, never duplicate
 *  - same id, different definition → mint a new id, re-point the copied chart
 *  - name taken                    → dedupe the name AND rewrite the [refs]
 *                                    of every carried formula that named it
 */
import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '../types/chart';
import type { Measure } from '../types/model';
import {
  chartMeasureDefinitions,
  chartMeasureIds,
  collectMeasureDefinitions,
  expressionReferenceNames,
  mergeMeasureDefinitions,
  nextMeasureCopyName,
} from './measureScope';

const plain = (id: string, name: string, column = 'total'): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  column,
});

const calc = (id: string, name: string, expression: string): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  expression,
});

const chartCiting = (...measureIds: string[]): ChartSpec => ({
  id: 'c1',
  type: 'kpi',
  title: 'T',
  query: { measures: measureIds.map((measureId) => ({ measureId })), filters: [] },
  format: {},
});

let minted = 0;
const mint = () => `new-${++minted}`;

describe('expressionReferenceNames', () => {
  it('reads bracketed names and nothing else', () => {
    expect(expressionReferenceNames('[A] / [B]')).toEqual(['A', 'B']);
    expect(expressionReferenceNames('SUM(public.orders.total)')).toEqual([]);
    expect(expressionReferenceNames('[ Padded ]')).toEqual(['Padded']);
    expect(expressionReferenceNames('[]')).toEqual([]);
    expect(expressionReferenceNames('[unterminated')).toEqual([]);
  });
});

describe('collectMeasureDefinitions', () => {
  const leaf = plain('m1', 'Leaf');
  const middle = calc('m2', 'Middle', '[Leaf] * 2');
  const top = calc('m3', 'Top', '[Middle] + 1');
  const unrelated = plain('m4', 'Unrelated');
  const available = [leaf, middle, top, unrelated];

  it('follows expression references transitively', () => {
    // A copied formula resolves its [refs] BY NAME against the merged
    // definition, so every named dependency has to travel too.
    expect(collectMeasureDefinitions(available, ['m3']).map((m) => m.name)).toEqual([
      'Leaf',
      'Middle',
      'Top',
    ]);
  });

  it('carries only what is referenced', () => {
    expect(collectMeasureDefinitions(available, ['m1']).map((m) => m.id)).toEqual(['m1']);
    expect(collectMeasureDefinitions(available, [])).toEqual([]);
  });

  it('skips ids the scope does not hold (they are model measures)', () => {
    expect(collectMeasureDefinitions(available, ['not-here'])).toEqual([]);
  });

  it('terminates on a reference cycle', () => {
    const a = calc('a', 'A', '[B] + 1');
    const b = calc('b', 'B', '[A] + 1');
    expect(collectMeasureDefinitions([a, b], ['a'])).toHaveLength(2);
  });

  it('keeps the available order, so a cache key built from it is stable', () => {
    expect(collectMeasureDefinitions(available, ['m3', 'm1']).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });
});

describe('chartMeasureDefinitions', () => {
  it('resolves what a chart needs on the wire', () => {
    const leaf = plain('m1', 'Leaf');
    const top = calc('m2', 'Top', '[Leaf] + 1');
    expect(chartMeasureIds(chartCiting('m2'))).toEqual(['m2']);
    expect(chartMeasureDefinitions([leaf, top], chartCiting('m2')).map((m) => m.id)).toEqual([
      'm1',
      'm2',
    ]);
    expect(chartMeasureDefinitions(null, chartCiting('m2'))).toEqual([]);
    expect(chartMeasureDefinitions([leaf, top], chartCiting())).toEqual([]);
  });
});

describe('mergeMeasureDefinitions', () => {
  it('is a no-op when nothing is carried', () => {
    const target = [plain('m1', 'Revenue')];
    const chart = chartCiting('m1');
    const merged = mergeMeasureDefinitions(target, [], chart, mint);
    expect(merged.measures).toEqual(target);
    expect(merged.chart).toBe(chart);
    expect(merged.added).toEqual([]);
  });

  it('adds a definition the target does not have, keeping its id and name', () => {
    const carried = plain('m1', 'Revenue');
    const merged = mergeMeasureDefinitions([], [carried], chartCiting('m1'), mint);

    expect(merged.measures).toEqual([carried]);
    expect(merged.added).toEqual([carried]);
    expect(merged.renamed).toEqual([]);
    // No rewrite needed: the chart's ref still points at the same measure.
    expect(merged.chart!.query.measures[0]!.measureId).toBe('m1');
  });

  it('REUSES an identical definition instead of duplicating it', () => {
    const target = plain('m1', 'Revenue');
    const carried = plain('m1', 'Revenue');
    const merged = mergeMeasureDefinitions([target], [carried], chartCiting('m1'), mint);

    expect(merged.measures).toHaveLength(1);
    expect(merged.added).toEqual([]);
    expect(merged.reused).toEqual([target]);
  });

  it('reuses an identical definition that lives under a DIFFERENT id, re-pointing the chart', () => {
    const target = plain('target-id', 'Revenue');
    const carried = plain('source-id', 'Revenue');
    const merged = mergeMeasureDefinitions([target], [carried], chartCiting('source-id'), mint);

    expect(merged.measures).toHaveLength(1);
    expect(merged.chart!.query.measures[0]!.measureId).toBe('target-id');
  });

  it('mints a new id when the id is taken by a DIFFERENT definition', () => {
    // The target's own charts still depend on its measure — shadowing it would
    // silently change what they compute.
    const target = plain('m1', 'Revenue', 'total');
    const carried = plain('m1', 'Other Revenue', 'quantity');
    const merged = mergeMeasureDefinitions([target], [carried], chartCiting('m1'), mint);

    expect(merged.measures).toHaveLength(2);
    expect(merged.measures[0]).toEqual(target);
    const added = merged.added[0]!;
    expect(added.id).not.toBe('m1');
    expect(added.name).toBe('Other Revenue');
    expect(merged.chart!.query.measures[0]!.measureId).toBe(added.id);
  });

  it('dedupes a colliding NAME and rewrites the carried [refs] that pointed at it', () => {
    // The target already has a DIFFERENT "Revenue". The carried one must be
    // renamed — and the carried formula that says [Revenue] must follow it,
    // or the copied chart quietly starts computing the target's Revenue.
    const target = plain('target-rev', 'Revenue', 'quantity');
    const carriedRevenue = plain('src-rev', 'Revenue', 'total');
    const carriedRatio = calc('src-ratio', 'Ratio', '[Revenue] / 2');

    const merged = mergeMeasureDefinitions(
      [target],
      [carriedRevenue, carriedRatio],
      chartCiting('src-ratio'),
      mint,
    );

    expect(merged.renamed).toEqual([['Revenue', 'Revenue (copy)']]);
    const renamedMeasure = merged.added.find((m) => m.id === 'src-rev')!;
    expect(renamedMeasure.name).toBe('Revenue (copy)');
    const ratio = merged.added.find((m) => m.id === 'src-ratio')!;
    expect(ratio.expression).toBe('[Revenue (copy)] / 2');
    // The target's own Revenue is untouched.
    expect(merged.measures[0]).toEqual(target);
  });

  it('escalates the dedupe suffix rather than colliding again', () => {
    const target = [plain('a', 'Revenue', 'q1'), plain('b', 'Revenue (copy)', 'q2')];
    const merged = mergeMeasureDefinitions(target, [plain('c', 'Revenue', 'q3')], null, mint);
    expect(merged.added[0]!.name).toBe('Revenue (copy 2)');
  });

  it('leaves a [ref] to a MODEL measure alone', () => {
    // Only carried names are rewritten; a model measure is not in play.
    const carried = calc('m1', 'Ratio', '[Total Order Value] / 2');
    const merged = mergeMeasureDefinitions([], [carried], chartCiting('m1'), mint);
    expect(merged.added[0]!.expression).toBe('[Total Order Value] / 2');
  });

  it('never mutates its inputs', () => {
    const target = [plain('m1', 'Revenue', 'total')];
    const frozenTarget = JSON.stringify(target);
    const carried = [plain('m1', 'Revenue', 'quantity')];
    const frozenCarried = JSON.stringify(carried);

    mergeMeasureDefinitions(target, carried, chartCiting('m1'), mint);

    expect(JSON.stringify(target)).toBe(frozenTarget);
    expect(JSON.stringify(carried)).toBe(frozenCarried);
  });
});

/**
 * Every scope's duplicate/copy action spells a copy name the same way, so the
 * rule is exported rather than reimplemented three times. Case-insensitive,
 * matching the server's OrdinalIgnoreCase name grouping.
 */
describe('nextMeasureCopyName', () => {
  it('appends "(copy)" when the name is free', () => {
    expect(nextMeasureCopyName(['Revenue'], 'Revenue')).toBe('Revenue (copy)');
  });

  it('counts up past taken copies', () => {
    expect(nextMeasureCopyName(['Revenue', 'Revenue (copy)'], 'Revenue')).toBe('Revenue (copy 2)');
    expect(
      nextMeasureCopyName(['Revenue', 'Revenue (copy)', 'Revenue (copy 2)'], 'Revenue'),
    ).toBe('Revenue (copy 3)');
  });

  it('compares case-insensitively — the engine does', () => {
    expect(nextMeasureCopyName(['revenue (COPY)'], 'Revenue')).toBe('Revenue (copy 2)');
  });
});
