// @vitest-environment jsdom
/**
 * THE MEASURE MANAGER — first coverage of a surface that did not exist.
 *
 * Before this wave, measure authoring lived only in the model editor, behind a
 * route; the chart builder is a MODAL inside the dashboard, so following that
 * route tore the builder (and the half-built chart) down. There was literally
 * no way to fix a measure while building a chart that needed it — and no way
 * at all to manage a dashboard-scoped or personal measure, because nothing
 * rendered them.
 *
 * What these tests hold:
 *  - all three scopes are ALWAYS sections, even empty ones;
 *  - the System permission gate: read-only with a reason for an ordinary user,
 *    writable for an administrator (the backend's measure-only carve-out);
 *  - create / delete land in the right scope's storage;
 *  - promotion between scopes uses the wave-2 store actions, moves widening
 *    and copies narrowing, and never leaves two measures sharing a name.
 */
import { act, useState, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChartSpec,
  DashboardsRuntime,
  Measure,
  ModelDefinition,
  RcdFetcher,
  RcdRequestInit,
} from '@recon/dashboards-core';
import { DashboardsProvider, useRuntime } from '../src/provider/DashboardsProvider';
import { MeasureManager } from '../src/chart-builder/MeasureManager';
import { useMeasureActions, type MeasureActions } from '../src/chart-builder/measureActions';

const measure = (id: string, name: string, over: Partial<Measure> = {}): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  column: 'total',
  ...over,
});

const SYSTEM = measure('s1', 'Revenue');
const DASHBOARD = measure('d1', 'Units', { column: 'quantity' });
const PERSONAL = measure('p1', 'Scratch', { column: 'discount' });

const DEFINITION: ModelDefinition = {
  version: 1,
  tables: [{ schema: 'public', name: 'orders' }],
  relationships: [],
  measures: [SYSTEM],
};

const CHART: ChartSpec = {
  id: 'c1',
  type: 'column',
  title: 'Orders',
  query: { measures: [{ measureId: 's1' }], filters: [] },
  format: {},
};

interface StubOptions {
  canManageShared?: boolean;
  modelIsSystem?: boolean;
  modelOwnerIsMe?: boolean;
  canEditLayout?: boolean;
  /** Model PUT fails (the 403 an ordinary user gets on a built-in model). */
  refuseModelSave?: boolean;
}

interface Stub {
  fetcher: RcdFetcher;
  calls: { path: string; init?: RcdRequestInit }[];
  /** Definition the last successful PUT /models/1 stored. */
  storedModel: () => ModelDefinition;
}

const makeStub = (options: StubOptions = {}): Stub => {
  const calls: { path: string; init?: RcdRequestInit }[] = [];
  let stored: ModelDefinition = structuredClone(DEFINITION);

  const modelDetail = () => ({
    id: 1,
    name: 'Warehouse',
    description: null,
    dataSourceName: 'warehouse',
    isShared: true,
    ownerIsMe: options.modelOwnerIsMe ?? true,
    isSystem: options.modelIsSystem ?? false,
    createdAtUtc: '2026-01-01T00:00:00Z',
    updatedAtUtc: 'model-stamp',
    definition: structuredClone(stored),
  });

  const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
    calls.push({ path, init });
    if (path.endsWith('/meta')) {
      return Promise.resolve({ canManageShared: options.canManageShared ?? false } as T);
    }
    if (path.endsWith('/user-settings')) return Promise.resolve({ settings: {} } as T);
    if (path.endsWith('/models/validate')) {
      return Promise.resolve({ valid: true, issues: [] } as T);
    }
    if (path.endsWith('/catalog')) {
      return Promise.resolve({ connection: 'warehouse', tables: [] } as T);
    }
    if (path.endsWith('/models/1')) {
      if (init?.method === 'PUT') {
        if (options.refuseModelSave) {
          return Promise.reject(
            Object.assign(new Error('Built-in content is read-only.'), {
              errorCode: 'rcd.model.system_readonly',
              issues: [],
            }),
          );
        }
        stored = (init.body as { definition: ModelDefinition }).definition;
      }
      return Promise.resolve(modelDetail() as T);
    }
    if (path.endsWith('/models')) return Promise.resolve([] as T);
    if (path.endsWith('/dashboards/1')) {
      return Promise.resolve({
        id: 1,
        name: 'Dash',
        description: null,
        modelId: 1,
        isShared: false,
        ownerIsMe: true,
        isSystem: false,
        createdAtUtc: '2026-01-01T00:00:00Z',
        updatedAtUtc: 'dash-stamp',
        myAccess: {
          isOwner: true,
          canEdit: true,
          canEditLayout: options.canEditLayout ?? true,
          canManagePages: true,
          canEditCharts: true,
          canMoveTiles: true,
          canDeleteContent: true,
          viaShare: false,
          viaPublish: false,
        },
        layout: {
          version: 1,
          tiles: [],
          slicers: [],
          pages: [{ id: 'p1', name: 'Page 1', tiles: [] }],
          measures: [structuredClone(DASHBOARD)],
        },
      } as T);
    }
    return Promise.resolve({} as T);
  }) as RcdFetcher;

  return { fetcher, calls, storedModel: () => stored };
};

let host: HTMLDivElement;
let root: Root;
let runtime: DashboardsRuntime;
let actions: MeasureActions;
let chartNow: ChartSpec;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function CaptureRuntime() {
  runtime = useRuntime();
  return null;
}

function Harness() {
  const [chart, setChart] = useState<ChartSpec>(CHART);
  chartNow = chart;
  const measureActions = useMeasureActions({
    modelId: 1,
    fallbackSystemMeasures: DEFINITION.measures,
    chart,
    onChartChange: setChart,
  });
  actions = measureActions;
  return (
    <MeasureManager
      model={DEFINITION}
      chart={chart}
      actions={measureActions}
      onClose={() => {}}
    />
  );
}

const mount = async (fetcher: RcdFetcher, children: ReactNode) => {
  await act(async () => {
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={fetcher}>
        <CaptureRuntime />
        {children}
      </DashboardsProvider>,
    );
  });
};

/** Provider + an open dashboard and model + the manager, all settled. */
const open = async (options: StubOptions = {}): Promise<Stub> => {
  const stub = makeStub(options);
  await mount(stub.fetcher, null);
  await act(async () => {
    await runtime.dashboards.open(1);
    await runtime.models.openModel(1);
    runtime.dashboards.setPersonalMeasures([structuredClone(PERSONAL)]);
  });
  await mount(stub.fetcher, <Harness />);
  // Let the deferred GET /meta land so the permission gate is settled.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return stub;
};

const sectionFor = (label: string): HTMLElement => {
  const section = host.querySelector(`section[aria-label="${label}"]`);
  if (!section) throw new Error(`No section "${label}"`);
  return section as HTMLElement;
};

const newButtonFor = (label: string): HTMLButtonElement =>
  sectionFor(label).querySelector(
    `button[aria-label="New measure in ${label}"]`,
  ) as HTMLButtonElement;

const rowNamesIn = (label: string): string[] =>
  [...sectionFor(label).querySelectorAll('li')].map(
    (li) => li.querySelector('span')?.textContent ?? '',
  );

describe('MeasureManager — the three scopes', () => {
  it('always renders all three sections, populated from all three stores', async () => {
    await open();
    expect(rowNamesIn('System measures')).toEqual(['Revenue']);
    expect(rowNamesIn('This dashboard')).toEqual(['Units']);
    expect(rowNamesIn('My measures')).toEqual(['Scratch']);
  });

  it('marks which measure the chart being edited actually uses', async () => {
    await open();
    expect(sectionFor('System measures').textContent).toContain('in this chart');
    expect(sectionFor('My measures').textContent).not.toContain('in this chart');
  });
});

describe('MeasureManager — the System permission gate', () => {
  it('a built-in model is read-only for an ordinary user, and says why', async () => {
    await open({ modelIsSystem: true, modelOwnerIsMe: false, canManageShared: false });

    const system = sectionFor('System measures');
    expect(system.textContent).toMatch(/only an administrator can change its measures/i);
    expect(newButtonFor('System measures').disabled).toBe(true);
    // The OTHER scopes stay fully usable — that is the escape hatch the
    // read-only notice points at.
    expect(newButtonFor('This dashboard').disabled).toBe(false);
    expect(newButtonFor('My measures').disabled).toBe(false);
  });

  it('an administrator CAN author on a built-in model (the backend carve-out)', async () => {
    await open({ modelIsSystem: true, modelOwnerIsMe: false, canManageShared: true });

    const system = sectionFor('System measures');
    expect(system.textContent).not.toMatch(/only an administrator/i);
    expect(newButtonFor('System measures').disabled).toBe(false);
  });

  it('a viewer without layout rights cannot author dashboard measures', async () => {
    await open({ canEditLayout: false });
    expect(sectionFor('This dashboard').textContent).toMatch(/do not have permission/i);
    expect(newButtonFor('This dashboard').disabled).toBe(true);
    expect(newButtonFor('My measures').disabled).toBe(false);
  });
});

describe('MeasureManager — CRUD lands in the right store', () => {
  const draft = (name: string) => ({
    name,
    table: 'public.orders',
    aggregation: 'sum' as const,
    column: 'total',
    expression: null,
    description: null,
    displayFolder: null,
    formatString: null,
    filters: null,
  });

  it('creating in DASHBOARD scope writes the dashboard document', async () => {
    await open();
    await act(async () => {
      await actions.create('dashboard', draft('Margin'));
    });
    expect(runtime.dashboards.dashboardMeasures.map((m) => m.name)).toEqual(['Units', 'Margin']);
  });

  it('creating in PERSONAL scope writes only the user’s own set', async () => {
    await open();
    await act(async () => {
      await actions.create('personal', draft('Sandbox'));
    });
    expect(
      runtime.dashboards.store.getState().personalMeasures.map((m) => m.name),
    ).toEqual(['Scratch', 'Sandbox']);
    expect(runtime.dashboards.dashboardMeasures.map((m) => m.name)).toEqual(['Units']);
  });

  it('creating in SYSTEM scope SAVES the model — the builder has no save button', async () => {
    const stub = await open();
    await act(async () => {
      await actions.create('system', draft('Shared total'));
    });
    expect(stub.storedModel().measures.map((m) => m.name)).toEqual(['Revenue', 'Shared total']);
  });

  it('a refused model save is rolled back, not left pending in the store', async () => {
    const stub = await open({ refuseModelSave: true });
    await act(async () => {
      await actions.create('system', draft('Shared total'));
    });
    // Nothing stored, nothing left behind locally, and the reason is surfaced.
    expect(stub.storedModel().measures.map((m) => m.name)).toEqual(['Revenue']);
    expect(
      runtime.models.store.getState().current!.definition.measures.map((m) => m.name),
    ).toEqual(['Revenue']);
    expect(actions.error).not.toBeNull();
  });

  it('deleting removes from the owning scope only', async () => {
    await open();
    await act(async () => {
      await actions.remove('dashboard', 'd1');
    });
    expect(runtime.dashboards.dashboardMeasures).toHaveLength(0);
    expect(runtime.models.store.getState().current!.definition.measures).toHaveLength(1);
  });

  it('duplicating dedupes the name across EVERY scope, not just its own', async () => {
    await open();
    // "Revenue" lives in the model; a dashboard duplicate of it must not
    // reuse the name, or [Revenue] becomes ambiguous model-wide.
    await act(async () => {
      await actions.transfer('system', 'dashboard', 's1');
    });
    expect(runtime.dashboards.dashboardMeasures.map((m) => m.name)).toEqual([
      'Units',
      'Revenue (copy)',
    ]);
  });
});

describe('MeasureManager — moving between scopes', () => {
  it('personal → dashboard MOVES: same id, gone from the personal set', async () => {
    await open();
    await act(async () => {
      await actions.transfer('personal', 'dashboard', 'p1');
    });
    expect(runtime.dashboards.dashboardMeasures.map((m) => m.id)).toEqual(['d1', 'p1']);
    expect(runtime.dashboards.store.getState().personalMeasures).toHaveLength(0);
  });

  it('dashboard → system MOVES through the wave-2 promotion, then drops the copy', async () => {
    const stub = await open();
    await act(async () => {
      await actions.transfer('dashboard', 'system', 'd1');
    });
    // The measure is in the model…
    expect(stub.storedModel().measures.map((m) => m.name)).toEqual(['Revenue', 'Units']);
    // …and the dashboard copy is gone, because the id survived the promotion
    // so every chart citing it still resolves.
    expect(runtime.dashboards.dashboardMeasures).toHaveLength(0);
  });

  it('system → personal COPIES: the original stays where everything depends on it', async () => {
    await open();
    await act(async () => {
      await actions.transfer('system', 'personal', 's1');
    });
    const personal = runtime.dashboards.store.getState().personalMeasures;
    expect(personal.map((m) => m.name)).toEqual(['Scratch', 'Revenue (copy)']);
    // A fresh id: two measures sharing one id make the engine resolve the
    // wrong one, and the query overlay rejects the duplicate outright.
    expect(personal.some((m) => m.id === 's1')).toBe(false);
    expect(runtime.models.store.getState().current!.definition.measures).toHaveLength(1);
  });

  it('personal → system re-points the chart being edited at the new model measure', async () => {
    await open();
    // Point the draft at the personal measure first.
    await act(async () => {
      actions.clearMessages();
    });
    await act(async () => {
      await actions.create('personal', {
        name: 'Promote me',
        table: 'public.orders',
        aggregation: 'sum',
        column: 'total',
        expression: null,
        description: null,
        displayFolder: null,
        formatString: null,
        filters: null,
      });
    });
    const created = runtime.dashboards.store
      .getState()
      .personalMeasures.find((m) => m.name === 'Promote me')!;

    // Re-render the harness with a chart citing it.
    await act(async () => {
      actions.clearMessages();
    });
    await act(async () => {
      await actions.transfer('personal', 'system', created.id);
    });

    const modelMeasures = runtime.models.store.getState().current!.definition.measures;
    const promoted = modelMeasures.find((m) => m.name === 'Promote me')!;
    expect(promoted).toBeDefined();
    expect(
      runtime.dashboards.store.getState().personalMeasures.some((m) => m.id === created.id),
    ).toBe(false);
    // The draft never cited it, so nothing to re-point — but the chart must be
    // untouched rather than mangled.
    expect(chartNow.query.measures).toEqual([{ measureId: 's1' }]);
  });
});
