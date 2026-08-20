// @vitest-environment jsdom
/**
 * D3 — A BLANK SERIES GETS A NAME.
 *
 * The engine now CONTAINS a measure it cannot compile: it substitutes a
 * tombstone that selects NULL under the original alias, so every other series,
 * every positional sort target and every column-keyed format map still points
 * where it did — and the broken measure simply renders empty. That is the right
 * behavior and a terrible experience on its own: the tile silently loses a
 * line and the user has no way to learn which one, or why.
 *
 * These tests pin the notice: it names the measure, it does not replace the
 * data that DID come back, it offers a shortcut to fix the measure when the
 * surface has one, and it survives the "no rows at all" case — where the plain
 * empty state would otherwise read as "your filters matched nothing".
 */
import { act, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChartSpec,
  MeasureFailure,
  QueryResult,
  RcdFetcher,
} from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import { ChartTile } from '../src/chart/ChartTile';

const SPEC: ChartSpec = {
  id: 'c1',
  type: 'table',
  title: 'Orders',
  query: {
    axis: { table: 'public.orders', column: 'region' },
    measures: [{ measureId: 'ok' }, { measureId: 'broken' }],
    filters: [],
  },
  format: {},
};

const FAILURE: MeasureFailure = {
  index: 1,
  label: 'Margin %',
  code: 'QRY_BAD_MEASURE',
  message: "Expression references column 'nope', which does not exist.",
};

const resultWith = (
  failures: MeasureFailure[] | undefined,
  rows: QueryResult['rows'],
): QueryResult => ({
  columns: [
    { name: 'dim0', label: 'Region', role: 'dimension', type: 'text', source: null, dateBucket: null, formatHint: null },
    { name: 'meas0', label: 'Revenue', role: 'measure', type: 'decimal', source: null, dateBucket: null, formatHint: null },
    { name: 'meas1', label: 'Margin %', role: 'measure', type: 'decimal', source: null, dateBucket: null, formatHint: null },
  ],
  rows,
  meta: {
    rowCount: rows.length,
    truncated: false,
    elapsedMs: 3,
    warnings: [],
    sql: null,
    ...(failures !== undefined ? { measureFailures: failures } : {}),
  },
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

const fetcherFor = (result: QueryResult): RcdFetcher =>
  (<T,>(path: string): Promise<T> => {
    if (path.endsWith('/query')) return Promise.resolve(result as T);
    if (path.endsWith('/meta')) return Promise.resolve({ canManageShared: false } as T);
    if (path.endsWith('/user-settings')) return Promise.resolve({ settings: {} } as T);
    return Promise.resolve({} as T);
  }) as RcdFetcher;

const mount = async (fetcher: RcdFetcher, children: ReactNode) => {
  await act(async () => {
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={fetcher}>
        {children}
      </DashboardsProvider>,
    );
  });
  // Let the query cache resolve and the tile re-render with the result.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const notice = (): HTMLElement | null =>
  host.querySelector('[data-testid="rcd-measure-failures"]');

describe('per-measure failure notice', () => {
  it('names the broken measure and repeats the engine’s reason', async () => {
    await mount(
      fetcherFor(resultWith([FAILURE], [['North', 10, null]])),
      <ChartTile spec={SPEC} modelId={1} />,
    );

    const text = notice()?.textContent ?? '';
    expect(text).toContain('Margin %');
    expect(text).toContain('could not be calculated');
    expect(text).toContain("Expression references column 'nope'");
  });

  it('does NOT replace the chart — the series that worked are still the point', async () => {
    await mount(
      fetcherFor(resultWith([FAILURE], [['North', 10, null]])),
      <ChartTile spec={SPEC} modelId={1} />,
    );
    expect(notice()).not.toBeNull();
    // The renderer chunk is lazy, so its Suspense fallback (or the chart) is
    // present either way — what matters is that we are not on an error state.
    expect(host.textContent).not.toContain('Retry');
  });

  it('offers the fix shortcut, carrying the failure back to the caller', async () => {
    const onEditMeasure = vi.fn();
    await mount(
      fetcherFor(resultWith([FAILURE], [['North', 10, null]])),
      <ChartTile spec={SPEC} modelId={1} onEditMeasure={onEditMeasure} />,
    );

    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Edit measure',
    )!;
    act(() => button.click());
    expect(onEditMeasure).toHaveBeenCalledWith(FAILURE);
  });

  it('a viewer with nowhere to author still gets the explanation, minus the button', async () => {
    await mount(
      fetcherFor(resultWith([FAILURE], [['North', 10, null]])),
      <ChartTile spec={SPEC} modelId={1} />,
    );
    expect(notice()?.textContent).toContain('Margin %');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Edit measure')).toBe(
      false,
    );
  });

  it('shows the notice even when the broken measure left NO rows at all', async () => {
    await mount(
      fetcherFor(resultWith([FAILURE], [])),
      <ChartTile spec={SPEC} modelId={1} />,
    );
    // Without this, "No data for this selection." reads as a filter problem.
    expect(host.textContent).toContain('No data for this selection.');
    expect(notice()?.textContent).toContain('Margin %');
  });

  it('renders nothing at all when the server reports no failures', async () => {
    await mount(
      fetcherFor(resultWith([], [['North', 10, 1]])),
      <ChartTile spec={SPEC} modelId={1} />,
    );
    expect(notice()).toBeNull();
  });

  it('an older server that omits the field is simply a clean result', async () => {
    await mount(
      fetcherFor(resultWith(undefined, [['North', 10, 1]])),
      <ChartTile spec={SPEC} modelId={1} />,
    );
    expect(notice()).toBeNull();
  });
});
