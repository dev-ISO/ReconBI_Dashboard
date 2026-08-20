/**
 * THE RUNTIME WIRING for model-scoped personal measures — the glue between the
 * settings document and the dashboard store's working copy.
 *
 * What it has to get right: seed the model actually in play, re-seed when the
 * open dashboard's model changes, migrate the pre-keying flat array exactly
 * once, and never let a settings outage stop a dashboard from opening.
 */
import { describe, expect, it } from 'vitest';
import type { RcdFetcher } from '../api/fetcher';
import type { Measure } from '../types/model';
import { createDashboardsRuntime } from './createRuntime';

const measure = (id: string, name: string): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  column: 'total',
});

const ON_FIVE = measure('a', 'Mine on 5');
const ON_NINE = measure('b', 'Mine on 9');

const emptyLayoutDoc = () => ({ version: 1, tiles: [] });

/**
 * Fake server: one settings document plus dashboards whose model id the test
 * chooses. The document it holds is the assertion surface.
 */
const harness = (options: {
  settings?: unknown;
  dashboards: Record<number, number | null>;
  failSettings?: boolean;
}) => {
  let stored: Record<string, unknown> = {
    version: 1,
    ...(options.settings !== undefined ? { measures: options.settings } : {}),
  };

  const fetcher: RcdFetcher = (async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path.endsWith('/user-settings')) {
      if (options.failSettings) throw new Error('settings unavailable');
      if (init?.method === 'PUT') {
        stored = (init.body as { settings: Record<string, unknown> }).settings;
        return { settings: stored, updatedAtUtc: 'stamp' };
      }
      return { settings: stored, updatedAtUtc: null };
    }
    const dashboard = /\/dashboards\/(\d+)$/.exec(path);
    if (dashboard) {
      const id = Number(dashboard[1]);
      return {
        id,
        name: `Dash ${id}`,
        description: null,
        modelId: options.dashboards[id] ?? null,
        isShared: false,
        ownerIsMe: true,
        createdAtUtc: '2026-01-01T00:00:00Z',
        updatedAtUtc: 'stamp',
        layout: emptyLayoutDoc(),
      };
    }
    throw new Error(`unexpected path ${path}`);
  }) as RcdFetcher;

  const runtime = createDashboardsRuntime('/api', fetcher, {
    userSettingsOptions: { debounceMs: 0 },
  });
  return { runtime, document: () => stored };
};

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('personal measures follow the open dashboard’s model', () => {
  it('seeds only the model in play, and re-seeds when the model changes', async () => {
    const { runtime } = harness({
      settings: { '5': [ON_FIVE], '9': [ON_NINE] },
      dashboards: { 1: 5, 2: 9 },
    });
    await runtime.userSettings.hydrate();

    await runtime.dashboards.open(1);
    await settle();
    expect(runtime.dashboards.store.getState().personalMeasures).toEqual([ON_FIVE]);

    await runtime.dashboards.open(2);
    await settle();
    // THE BUG THIS FIXES: model 9's dashboard used to be offered model 5's
    // measures, against tables it may not even have.
    expect(runtime.dashboards.store.getState().personalMeasures).toEqual([ON_NINE]);
  });

  it('offers nothing on a model the user has no personal measures for', async () => {
    const { runtime } = harness({ settings: { '5': [ON_FIVE] }, dashboards: { 3: 42 } });
    await runtime.userSettings.hydrate();

    await runtime.dashboards.open(3);
    await settle();

    expect(runtime.dashboards.store.getState().personalMeasures).toEqual([]);
  });

  it('migrates the legacy FLAT array to the first model it is seen against', async () => {
    const { runtime, document } = harness({ settings: [ON_FIVE], dashboards: { 1: 5, 2: 9 } });
    await runtime.userSettings.hydrate();

    await runtime.dashboards.open(1);
    await settle();
    await runtime.userSettings.flush();

    expect(runtime.dashboards.store.getState().personalMeasures).toEqual([ON_FIVE]);
    expect((document() as { measures: unknown }).measures).toEqual({ '5': [ON_FIVE] });

    // …and it is a ONE-TIME migration: the next model does not inherit them.
    await runtime.dashboards.open(2);
    await settle();
    expect(runtime.dashboards.store.getState().personalMeasures).toEqual([]);
  });

  it('a write files under the active model and leaves other models alone', async () => {
    const { runtime, document } = harness({
      settings: { '9': [ON_NINE] },
      dashboards: { 1: 5 },
    });
    await runtime.userSettings.hydrate();
    await runtime.dashboards.open(1);
    await settle();

    runtime.dashboards.setPersonalMeasures([ON_FIVE]);
    await runtime.userSettings.flush();

    expect((document() as { measures: Record<string, unknown> }).measures).toEqual({
      '9': [ON_NINE],
      '5': [ON_FIVE],
    });
  });

  it('a settings outage leaves personal measures empty and the dashboard usable', async () => {
    const { runtime } = harness({ dashboards: { 1: 5 }, failSettings: true });

    await runtime.dashboards.open(1);
    await settle();

    expect(runtime.dashboards.store.getState().current).not.toBeNull();
    expect(runtime.dashboards.store.getState().personalMeasures).toEqual([]);
    expect(runtime.userSettings.store.getState().error).toBe('settings unavailable');
  });

  it('seeds correctly when the dashboard opens BEFORE hydration lands', async () => {
    const { runtime } = harness({ settings: { '5': [ON_FIVE] }, dashboards: { 1: 5 } });

    // No await on hydrate first: the runtime kicks one off itself.
    await runtime.dashboards.open(1);
    await settle();

    expect(runtime.dashboards.store.getState().personalMeasures).toEqual([ON_FIVE]);
  });
});
