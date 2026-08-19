/**
 * ITEM 1 — matrix (row hierarchy) shaping for the table chart.
 *
 * tableTree is pure data: it folds the leading hierarchy dimension columns of a
 * QueryResult into group nodes with CLIENT-SIDE rolled-up measure values, then
 * flattens the tree against an expanded-keys set. The roll-up rules are the
 * same ones the grand-total companion query applies server-side (ITEM 2), so
 * a parent row and the Total row can never disagree:
 *   sum/count -> SUM, min -> MIN, max -> MAX, temporal -> MIN/MAX per
 *   TableOptions.dateAggregation, everything non-additive -> blank.
 */
import { describe, expect, it } from 'vitest';
import type { CellValue, ChartSpec, MeasureRef, QueryColumn } from '@recon/dashboards-core';
import {
  buildTableTree,
  collectGroupKeys,
  flattenTableTree,
  measureFoldKinds,
  type FoldKind,
  type TableNode,
} from '../src/chart/tableTree';

const dimColumn = (name: string, label: string): QueryColumn => ({
  name,
  label,
  role: 'dimension',
  type: 'text',
  source: null,
  dateBucket: null,
  formatHint: null,
});

const measureColumn = (
  name: string,
  label: string,
  type: QueryColumn['type'] = 'decimal',
): QueryColumn => ({
  name,
  label,
  role: 'measure',
  type,
  source: null,
  dateBucket: null,
  formatHint: null,
});

const specWith = (measures: MeasureRef[]): ChartSpec => ({
  id: 'c1',
  type: 'table',
  title: 'T',
  query: {
    axis: { table: 'public.orders', column: 'region' },
    drillLevels: [{ table: 'public.orders', column: 'city' }],
    measures,
    filters: [],
  },
  format: {},
});

/** region | city | total(sum) | n(count) | low(min) | high(max) */
const COLUMNS: QueryColumn[] = [
  dimColumn('dim0', 'Region'),
  dimColumn('dim1', 'City'),
  measureColumn('meas0', 'Total'),
  measureColumn('meas1', 'N', 'integer'),
  measureColumn('meas2', 'Low'),
  measureColumn('meas3', 'High'),
];

const ROWS: CellValue[][] = [
  ['North', 'Oslo', 10, 2, 3, 30],
  ['North', 'Bergen', 20, 5, 1, 40],
  ['South', 'Rome', 5, 1, 8, 9],
];

const KINDS: FoldKind[] = ['sum', 'sum', 'min', 'max'];

/** Node lookup by label, for readable assertions. */
const byLabel = (nodes: readonly TableNode[], label: string): TableNode => {
  const found = nodes.find((n) => n.label === label);
  if (!found) throw new Error(`no node labelled ${label}`);
  return found;
};

describe('measureFoldKinds', () => {
  it('maps each inline aggregation onto its roll-up rule', () => {
    const measures: MeasureRef[] = [
      { table: 't', column: 'a', aggregation: 'sum' },
      { table: 't', aggregation: 'count' },
      { table: 't', column: 'c', aggregation: 'min' },
      { table: 't', column: 'd', aggregation: 'max' },
      { table: 't', column: 'e', aggregation: 'avg' },
      { table: 't', column: 'f', aggregation: 'countDistinct' },
    ];
    const columns = measures.map((_, i) => measureColumn(`meas${i}`, `M${i}`));
    expect(measureFoldKinds(specWith(measures), columns, undefined)).toEqual([
      'sum',
      'sum',
      'min',
      'max',
      'blank',
      'blank',
    ]);
  });

  it('blanks model measures and quick calcs — their formula is server-side', () => {
    const measures: MeasureRef[] = [
      { measureId: 'm-total' },
      { table: 't', column: 'a', aggregation: 'sum', calc: { kind: 'runningTotal' } },
    ];
    const columns = measures.map((_, i) => measureColumn(`meas${i}`, `M${i}`));
    expect(measureFoldKinds(specWith(measures), columns, undefined)).toEqual(['blank', 'blank']);
  });

  it('blanks a measure column with no matching wire measure', () => {
    expect(measureFoldKinds(specWith([]), [measureColumn('meas0', 'M0')], undefined)).toEqual([
      'blank',
    ]);
  });

  it('rolls temporal columns up per dateAggregation, earliest by default', () => {
    const measures: MeasureRef[] = [
      { table: 't', column: 'started', aggregation: 'min' },
      { table: 't', column: 'ended', aggregation: 'max' },
    ];
    const columns = [
      measureColumn('meas0', 'Started', 'date'),
      measureColumn('meas1', 'Ended', 'timestamp'),
    ];
    expect(measureFoldKinds(specWith(measures), columns, undefined)).toEqual(['min', 'min']);
    expect(
      measureFoldKinds(specWith(measures), columns, { meas0: 'latest', meas1: 'earliest' }),
    ).toEqual(['max', 'min']);
    expect(measureFoldKinds(specWith(measures), columns, { meas1: 'latest' })).toEqual([
      'min',
      'max',
    ]);
  });
});

describe('buildTableTree', () => {
  it('folds one hierarchy level and aggregates per kind', () => {
    const roots = buildTableTree(ROWS, COLUMNS, 2, KINDS);
    expect(roots.map((n) => n.label)).toEqual(['North', 'South']);

    const north = byLabel(roots, 'North');
    expect(north.depth).toBe(0);
    expect(north.leafCount).toBe(2);
    expect(north.children).toHaveLength(0);
    expect(north.leafRows).toHaveLength(2);
    // dim cell carries its own value, deeper dim cells stay null.
    expect(north.row[0]).toBe('North');
    expect(north.row[1]).toBeNull();
    expect(north.row[2]).toBe(30); // sum 10 + 20
    expect(north.row[3]).toBe(7); //  count sums too: 2 + 5
    expect(north.row[4]).toBe(1); //  min of 3, 1
    expect(north.row[5]).toBe(40); // max of 30, 40
  });

  it('leaves non-additive measures null so the cell renders an em-dash', () => {
    const roots = buildTableTree(ROWS, COLUMNS, 2, ['blank', 'blank', 'blank', 'blank']);
    expect(byLabel(roots, 'North').row.slice(2)).toEqual([null, null, null, null]);
  });

  it('folds NON-CONTIGUOUS groups into one node (Map-based, order-independent)', () => {
    const scrambled: CellValue[][] = [
      ['North', 'Oslo', 10, 2, 3, 30],
      ['South', 'Rome', 5, 1, 8, 9],
      ['North', 'Bergen', 20, 5, 1, 40],
    ];
    const roots = buildTableTree(scrambled, COLUMNS, 2, KINDS);
    expect(roots).toHaveLength(2);
    expect(byLabel(roots, 'North').leafCount).toBe(2);
    expect(byLabel(roots, 'North').row[2]).toBe(30);
  });

  it('rolls a DEEP hierarchy up through every descendant', () => {
    const columns = [
      dimColumn('dim0', 'Region'),
      dimColumn('dim1', 'City'),
      dimColumn('dim2', 'Store'),
      measureColumn('meas0', 'Total'),
      measureColumn('meas1', 'Low'),
    ];
    const rows: CellValue[][] = [
      ['North', 'Oslo', 'A', 10, 4],
      ['North', 'Oslo', 'B', 15, 2],
      ['North', 'Bergen', 'C', 20, 9],
      ['South', 'Rome', 'D', 5, 1],
    ];
    const roots = buildTableTree(rows, columns, 3, ['sum', 'min']);
    const north = byLabel(roots, 'North');
    expect(north.leafCount).toBe(3);
    expect(north.children.map((c) => c.label)).toEqual(['Oslo', 'Bergen']);
    expect(north.row[3]).toBe(45); // 10 + 15 + 20 across BOTH cities
    expect(north.row[4]).toBe(2); //  min across both cities

    const oslo = byLabel(north.children, 'Oslo');
    expect(oslo.depth).toBe(1);
    expect(oslo.row[1]).toBe('Oslo');
    expect(oslo.row[0]).toBeNull(); // the parent's column is blank on a child
    expect(oslo.row[3]).toBe(25);
    expect(oslo.leafRows).toHaveLength(2);
  });

  it('folds temporal cells as ISO strings — earliest is a MIN, latest a MAX', () => {
    const columns = [
      dimColumn('dim0', 'Region'),
      dimColumn('dim1', 'City'),
      measureColumn('meas0', 'First', 'date'),
      measureColumn('meas1', 'Last', 'date'),
    ];
    const rows: CellValue[][] = [
      ['North', 'Oslo', '2026-03-04', '2026-03-04'],
      ['North', 'Bergen', '2026-01-31', '2026-01-31'],
      ['North', 'Tromso', '2026-12-01', '2026-12-01'],
    ];
    const roots = buildTableTree(rows, columns, 2, ['min', 'max']);
    expect(roots[0]!.row[2]).toBe('2026-01-31');
    expect(roots[0]!.row[3]).toBe('2026-12-01');
  });

  it('ignores null cells in the fold instead of poisoning the aggregate', () => {
    const rows: CellValue[][] = [
      ['North', 'Oslo', null, null, null, null],
      ['North', 'Bergen', 20, 5, 1, 40],
    ];
    const roots = buildTableTree(rows, COLUMNS, 2, KINDS);
    expect(roots[0]!.row.slice(2)).toEqual([20, 5, 1, 40]);
  });

  it('folds an all-null measure to null (blank), never to zero', () => {
    const rows: CellValue[][] = [
      ['North', 'Oslo', null, null, null, null],
      ['North', 'Bergen', null, null, null, null],
    ];
    expect(buildTableTree(rows, COLUMNS, 2, KINDS)[0]!.row.slice(2)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('keys sibling paths unambiguously across types and nulls', () => {
    const rows: CellValue[][] = [
      [1, 'a', 1, 1, 1, 1],
      ['1', 'b', 2, 1, 2, 2],
      [null, 'c', 4, 1, 4, 4],
    ];
    const roots = buildTableTree(rows, COLUMNS, 2, KINDS);
    expect(roots).toHaveLength(3);
    expect(new Set(roots.map((n) => n.key)).size).toBe(3);
  });

  it('returns nothing when there is no hierarchy to group', () => {
    expect(buildTableTree(ROWS, COLUMNS, 1, KINDS)).toEqual([]);
    expect(buildTableTree(ROWS, COLUMNS, 0, KINDS)).toEqual([]);
    // Result shallower than the spec claims (stale result mid-toggle).
    expect(buildTableTree(ROWS, COLUMNS, 3, KINDS)).toEqual([]);
  });
});

describe('flattenTableTree', () => {
  const roots = buildTableTree(ROWS, COLUMNS, 2, KINDS);

  it('shows only the group rows while everything is COLLAPSED (the default)', () => {
    const visible = flattenTableTree(roots, new Set());
    expect(visible).toHaveLength(2);
    expect(visible.every((r) => r.kind === 'group')).toBe(true);
    expect(visible.map((r) => (r.kind === 'group' ? r.expanded : null))).toEqual([false, false]);
  });

  it('reveals a node’s leaf rows when its key is expanded', () => {
    const north = byLabel(roots, 'North');
    const visible = flattenTableTree(roots, new Set([north.key]));
    expect(visible.map((r) => r.kind)).toEqual(['group', 'leaf', 'leaf', 'group']);
    expect(visible[1]!.depth).toBe(1);
    expect(visible[1]!.row).toEqual(ROWS[0]);
    // Leaf keys are unique and stable within one result.
    expect(new Set(visible.map((r) => r.key)).size).toBe(4);
  });

  it('hides everything under a collapsed node, however deep', () => {
    const columns = [
      dimColumn('dim0', 'Region'),
      dimColumn('dim1', 'City'),
      dimColumn('dim2', 'Store'),
      measureColumn('meas0', 'Total'),
    ];
    const rows: CellValue[][] = [
      ['North', 'Oslo', 'A', 10],
      ['North', 'Oslo', 'B', 15],
    ];
    const deep = buildTableTree(rows, columns, 3, ['sum']);
    const north = deep[0]!;
    const oslo = north.children[0]!;

    expect(flattenTableTree(deep, new Set())).toHaveLength(1);
    // Expanding only the parent shows the child GROUP, not its leaves.
    const oneLevel = flattenTableTree(deep, new Set([north.key]));
    expect(oneLevel.map((r) => r.kind)).toEqual(['group', 'group']);
    // A child key alone reveals nothing — its parent is still closed.
    expect(flattenTableTree(deep, new Set([oslo.key]))).toHaveLength(1);

    const all = flattenTableTree(deep, new Set(collectGroupKeys(deep)));
    expect(all.map((r) => r.kind)).toEqual(['group', 'group', 'leaf', 'leaf']);
    expect(all[2]!.depth).toBe(2);
  });

  it('collectGroupKeys returns every group key (the expand-all set)', () => {
    const columns = [
      dimColumn('dim0', 'Region'),
      dimColumn('dim1', 'City'),
      dimColumn('dim2', 'Store'),
      measureColumn('meas0', 'Total'),
    ];
    const rows: CellValue[][] = [
      ['North', 'Oslo', 'A', 10],
      ['North', 'Bergen', 'B', 15],
      ['South', 'Rome', 'C', 5],
    ];
    const deep = buildTableTree(rows, columns, 3, ['sum']);
    // 2 regions + 3 cities.
    expect(collectGroupKeys(deep)).toHaveLength(5);
    expect(new Set(collectGroupKeys(deep)).size).toBe(5);
  });
});
