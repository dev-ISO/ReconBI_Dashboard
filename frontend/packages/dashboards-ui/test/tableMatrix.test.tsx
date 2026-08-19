// @vitest-environment jsdom
/**
 * ITEM 1 — the matrix table as the grid actually renders it.
 *
 * tableTree.test.ts pins the folding maths; this pins the wiring: when does
 * the matrix engage at all, what does a collapsed table show, does a chevron
 * (and the header's expand-all) actually reveal the leaves, and do the
 * non-additive measures render an honest em-dash instead of a wrong number.
 *
 * Note the stale-result guard: a result fetched BEFORE the matrix toggle
 * carries too few dimension columns, and folding over it would group by the
 * wrong field — the table must fall back to plain rows until the refetch
 * lands.
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CellValue,
  ChartSpec,
  MeasureRef,
  QueryColumn,
  QueryResult,
} from '@recon/dashboards-core';
import { TableChart } from '../src/chart/TableChart';

const dimColumn = (name: string, label: string): QueryColumn => ({
  name,
  label,
  role: 'dimension',
  type: 'text',
  source: null,
  dateBucket: null,
  formatHint: null,
});

const measureColumn = (name: string, label: string): QueryColumn => ({
  name,
  label,
  role: 'measure',
  type: 'decimal',
  source: null,
  dateBucket: null,
  formatHint: null,
});

const COLUMNS: QueryColumn[] = [
  dimColumn('dim0', 'Region'),
  dimColumn('dim1', 'City'),
  measureColumn('meas0', 'Total'),
  measureColumn('meas1', 'Average'),
];

const ROWS: CellValue[][] = [
  ['North', 'Oslo', 10, 5],
  ['North', 'Bergen', 20, 7],
  ['South', 'Rome', 5, 9],
];

const RESULT: QueryResult = {
  columns: COLUMNS,
  rows: ROWS,
  meta: { rowCount: 3, truncated: false, elapsedMs: 1, warnings: [], sql: null },
};

const MEASURES: MeasureRef[] = [
  { table: 'public.orders', column: 'total', aggregation: 'sum' },
  { table: 'public.orders', column: 'price', aggregation: 'avg' }, // non-additive
];

const specOf = (format: ChartSpec['format'] = {}): ChartSpec => ({
  id: 'c1',
  type: 'table',
  title: 'T',
  query: {
    axis: { table: 'public.orders', column: 'region' },
    drillLevels: [{ table: 'public.orders', column: 'city' }],
    measures: MEASURES,
    filters: [],
  },
  format,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (spec: ChartSpec, result: QueryResult = RESULT): void => {
  act(() => {
    root.render(<TableChart spec={spec} result={result} />);
  });
};

const bodyRows = (): HTMLTableRowElement[] =>
  Array.from(host.querySelectorAll<HTMLTableRowElement>('tbody tr'));

const rowText = (): string[] => bodyRows().map((tr) => tr.textContent ?? '');

/** The per-node expand/collapse buttons, in render order. */
const nodeToggles = (): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('tbody button[aria-expanded]'));

const click = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('TableChart matrix rendering', () => {
  it('starts fully COLLAPSED: one row per top-level group, nothing else', () => {
    render(specOf());
    expect(bodyRows()).toHaveLength(2);
    expect(rowText()[0]).toContain('North');
    expect(rowText()[1]).toContain('South');
    expect(rowText().join(' ')).not.toContain('Oslo');
  });

  it('rolls additive measures up and blanks the non-additive one', () => {
    render(specOf());
    // sum(10, 20) for North; the avg column cannot be folded client-side.
    expect(rowText()[0]).toContain('30');
    expect(rowText()[0]).toContain('—');
    expect(rowText()[1]).toContain('5');
  });

  it('reveals a group’s leaf rows when its chevron is clicked, and hides them again', () => {
    render(specOf());
    const toggles = nodeToggles();
    expect(toggles).toHaveLength(2);
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false');

    click(toggles[0]!);
    expect(bodyRows()).toHaveLength(4); // North + 2 leaves + South
    expect(rowText().join(' ')).toContain('Oslo');
    expect(rowText().join(' ')).toContain('Bergen');
    expect(nodeToggles()[0]!.getAttribute('aria-expanded')).toBe('true');

    click(nodeToggles()[0]!);
    expect(bodyRows()).toHaveLength(2);
  });

  it('toggles the whole hierarchy from the first header cell', () => {
    render(specOf());
    const expandAll = host.querySelector<HTMLButtonElement>(
      'thead button[aria-label="Expand all rows"]',
    );
    expect(expandAll).not.toBeNull();

    click(expandAll!);
    expect(bodyRows()).toHaveLength(5); // 2 groups + 3 leaves
    const collapseAll = host.querySelector<HTMLButtonElement>(
      'thead button[aria-label="Collapse all rows"]',
    );
    expect(collapseAll).not.toBeNull();

    click(collapseAll!);
    expect(bodyRows()).toHaveLength(2);
  });

  it('renders plain rows when the row hierarchy is switched OFF', () => {
    render(specOf({ table: { matrix: false } }));
    expect(bodyRows()).toHaveLength(3);
    expect(nodeToggles()).toHaveLength(0);
    expect(rowText().join(' ')).toContain('Oslo');
  });

  it('falls back to plain rows on a STALE result missing the hierarchy column', () => {
    const stale: QueryResult = {
      ...RESULT,
      columns: [COLUMNS[0]!, COLUMNS[2]!, COLUMNS[3]!],
      rows: [
        ['North', 30, 6],
        ['South', 5, 9],
      ],
    };
    render(specOf(), stale);
    expect(nodeToggles()).toHaveLength(0);
    expect(bodyRows()).toHaveLength(2);
  });

  it('hides the rows-per-page picker while the matrix is on', () => {
    const paged: ChartSpec['format'] = { table: { pageSizeOptions: [10, 25] } };
    render(specOf(paged));
    expect(host.querySelector('[aria-label="Rows per page"]')).toBeNull();

    // Same options, matrix off -> the picker is back (it needs a layout
    // consumer, so this render supplies one).
    act(() => {
      root.render(
        <TableChart
          spec={specOf({ table: { pageSizeOptions: [10, 25], matrix: false } })}
          result={RESULT}
          onTableLayoutChange={() => {}}
        />,
      );
    });
    expect(host.querySelector('[aria-label="Rows per page"]')).not.toBeNull();
  });
});
