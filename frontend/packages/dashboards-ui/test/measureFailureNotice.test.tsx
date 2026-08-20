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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * PRELOAD THE LAZY CHART CHUNK.
 *
 * ChartTile renders its renderer behind Suspense, whose fallback is an ANIMATED
 * skeleton. Under full-suite load that chunk resolves slowly, the skeleton keeps
 * mutating, and no amount of "wait for the DOM to stop changing" can ever be
 * true — the markup legitimately never stops. Importing the module here puts it
 * in the module cache, so Suspense resolves immediately and the tile reaches a
 * genuinely static state. The notice under test renders OUTSIDE that boundary
 * and never depended on the chunk at all; only the waiting did.
 */
beforeAll(async () => {
  await import('../src/chart/ChartRenderer');
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

/** Resolves once the query response has actually been handed to the runtime. */
let queryDelivered: Promise<void>;

const fetcherFor = (result: QueryResult): RcdFetcher => {
  let markDelivered: () => void = () => {};
  queryDelivered = new Promise<void>((resolve) => {
    markDelivered = resolve;
  });
  return (<T,>(path: string): Promise<T> => {
    if (path.endsWith('/query')) {
      markDelivered();
      return Promise.resolve(result as T);
    }
    if (path.endsWith('/meta')) return Promise.resolve({ canManageShared: false } as T);
    if (path.endsWith('/user-settings')) return Promise.resolve({ settings: {} } as T);
    return Promise.resolve({} as T);
  }) as RcdFetcher;
};

/**
 * Renders, then waits for the query to land and the DOM to STOP CHANGING.
 *
 * The previous version awaited a fixed three microtasks and hoped, which failed
 * 2-5 of these 7 tests at random: how many ticks the query cache needs before
 * the tile re-renders is not a constant, and the chart renderer is a lazy chunk
 * whose Suspense fallback is the SAME skeleton as the pre-query one — so
 * "the skeleton is gone" is not a usable signal either. Quiescence is: once two
 * consecutive flushes leave the markup identical, everything that was going to
 * render has rendered, including the no-failure cases where the assertion is
 * that nothing appeared.
 */
const mount = async (fetcher: RcdFetcher, children: ReactNode) => {
  await act(async () => {
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={fetcher}>
        {children}
      </DashboardsProvider>,
    );
  });
  await act(async () => {
    await queryDelivered;
  });

  // With the chunk preloaded the tile really does reach a static DOM, so two
  // consecutive identical samples after a small floor of flushes is sound.
  let previous: string | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = host.innerHTML;
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (attempt >= 3 && stable >= 2) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Tile never settled: the markup kept changing for 200 flushes.');
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
