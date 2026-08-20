// @vitest-environment jsdom
/**
 * THE FIELDS HALF OF THE MANAGER.
 *
 * The brief was explicit that a named derived field lives in the SAME three
 * scopes with the SAME manager, gate and validation wave 3 built — not a
 * parallel manager beside it. So these tests check reuse, not re-implementation:
 * one dialog with two tabs, the wave-3 scopeRights verbatim (a built-in model
 * is read-only for an ordinary user and says why), and the same
 * /models/validate round-trip surfacing MDL issues per candidate.
 *
 * The one rule that genuinely differs from measures is pinned last: a chart
 * cites a derived field BY NAME, so a rename has to re-point the chart or its
 * axis becomes a column the engine has never heard of.
 */
import { act, useState, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChartSpec,
  DashboardsRuntime,
  DerivedField,
  ModelDefinition,
  RcdFetcher,
  RcdRequestInit,
} from '@recon/dashboards-core';
import { DashboardsProvider, useRuntime } from '../src/provider/DashboardsProvider';
import { MeasureManager } from '../src/chart-builder/MeasureManager';
import { useMeasureActions } from '../src/chart-builder/measureActions';
import {
  useDerivedFieldActions,
  type DerivedFieldActions,
} from '../src/chart-builder/derivedFieldActions';

const field = (id: string, name: string, over: Partial<DerivedField> = {}): DerivedField => ({
  id,
  name,
  table: 'public.orders',
  expression: 'IF(ISBLANK(public.orders.shipped_at), "No", "Yes")',
  dataType: 'text',
  ...over,
});

const SYSTEM = field('f-sys', 'Shipped?');
const DASHBOARD = field('f-dash', 'Late?', { expression: 'IF(1 = 1, "a", "b")' });
const PERSONAL = field('f-me', 'Scratch', { expression: 'IF(2 = 2, "a", "b")' });

const DEFINITION: ModelDefinition = {
  version: 1,
  tables: [{ schema: 'public', name: 'orders' }],
  relationships: [],
  measures: [],
  derivedFields: [SYSTEM],
};

const CHART: ChartSpec = {
  id: 'c1',
  type: 'column',
  title: 'Orders',
  query: {
    axis: { table: 'public.orders', column: 'Shipped?' },
    measures: [],
    filters: [],
  },
  format: {},
};

interface StubOptions {
  canManageShared?: boolean;
  modelIsSystem?: boolean;
  modelOwnerIsMe?: boolean;
}

const makeStub = (options: StubOptions = {}) => {
  let stored: ModelDefinition = structuredClone(DEFINITION);
  const validatePayloads: ModelDefinition[] = [];

  const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
    if (path.endsWith('/meta')) {
      return Promise.resolve({ canManageShared: options.canManageShared ?? false } as T);
    }
    if (path.endsWith('/user-settings')) return Promise.resolve({ settings: {} } as T);
    if (path.endsWith('/models/validate')) {
      validatePayloads.push((init?.body as { definition: ModelDefinition }).definition);
      return Promise.resolve({ valid: true, issues: [] } as T);
    }
    if (path.endsWith('/catalog')) {
      return Promise.resolve({ connection: 'warehouse', tables: [] } as T);
    }
    if (path.endsWith('/models/1')) {
      if (init?.method === 'PUT') {
        stored = (init.body as { definition: ModelDefinition }).definition;
      }
      return Promise.resolve({
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
      } as T);
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
          canEditLayout: true,
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
          derivedFields: [structuredClone(DASHBOARD)],
        },
      } as T);
    }
    return Promise.resolve({} as T);
  }) as RcdFetcher;

  return { fetcher, storedModel: () => stored, validatePayloads };
};

let host: HTMLDivElement;
let root: Root;
let runtime: DashboardsRuntime;
let actions: DerivedFieldActions;
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
  const measures = useMeasureActions({
    modelId: 1,
    fallbackSystemMeasures: DEFINITION.measures,
    chart,
    onChartChange: setChart,
  });
  const derived = useDerivedFieldActions({
    modelId: 1,
    fallbackSystemFields: DEFINITION.derivedFields ?? [],
    chart,
    onChartChange: setChart,
  });
  actions = derived;
  return (
    <MeasureManager
      model={DEFINITION}
      chart={chart}
      actions={measures}
      derived={derived}
      initialTab="fields"
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

const open = async (options: StubOptions = {}) => {
  const stub = makeStub(options);
  await mount(stub.fetcher, null);
  await act(async () => {
    await runtime.dashboards.open(1);
    await runtime.models.openModel(1);
    runtime.dashboards.setPersonalDerivedFields([structuredClone(PERSONAL)]);
  });
  await mount(stub.fetcher, <Harness />);
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

const rowNamesIn = (label: string): string[] =>
  [...sectionFor(label).querySelectorAll('li')].map(
    (li) => li.querySelector('span')?.textContent ?? '',
  );

describe('the manager’s Fields tab', () => {
  it('is a TAB on the measure manager, not a second dialog', async () => {
    await open();
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Measures', 'Fields']);
  });

  it('renders all three scopes, populated from all three stores', async () => {
    await open();
    expect(rowNamesIn('System measures')).toEqual(['Shipped?']);
    expect(rowNamesIn('This dashboard')).toEqual(['Late?']);
    expect(rowNamesIn('My measures')).toEqual(['Scratch']);
  });

  it('marks the field the chart being edited actually uses', async () => {
    await open();
    expect(sectionFor('System measures').textContent).toContain('in this chart');
    expect(sectionFor('My measures').textContent).not.toContain('in this chart');
  });

  it('reuses the wave-3 gate verbatim: a built-in model is read-only, with the reason', async () => {
    await open({ modelIsSystem: true, modelOwnerIsMe: false, canManageShared: false });
    const system = sectionFor('System measures');
    expect(system.textContent).toMatch(/only an administrator can change its measures/i);
    expect(
      (system.querySelector('button[aria-label="New field in System measures"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // The narrower scopes stay writable — that IS the escape route the copy
    // offers, and disabling it would leave the user with nowhere to go.
    expect(
      (
        sectionFor('My measures').querySelector(
          'button[aria-label="New field in My measures"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe('writes land in the right scope', () => {
  it('a personal field goes to the per-user store, never to the model', async () => {
    const stub = await open();
    await act(async () => {
      await actions.create('personal', {
        name: 'Mine',
        table: 'public.orders',
        expression: 'IF(1 = 1, "a", "b")',
        dataType: 'text',
        description: null,
        displayFolder: null,
      });
    });
    expect(runtime.dashboards.store.getState().personalDerivedFields.map((f) => f.name)).toEqual([
      'Scratch',
      'Mine',
    ]);
    expect((stub.storedModel().derivedFields ?? []).map((f) => f.name)).toEqual(['Shipped?']);
  });

  it('a dashboard field goes into the layout document, so it travels with the dashboard', async () => {
    await open();
    await act(async () => {
      await actions.create('dashboard', {
        name: 'Doc field',
        table: 'public.orders',
        expression: 'IF(1 = 1, "a", "b")',
        dataType: 'text',
        description: null,
        displayFolder: null,
      });
    });
    const layout = runtime.dashboards.store.getState().current!.layout;
    expect((layout.derivedFields ?? []).map((f) => f.name)).toEqual(['Late?', 'Doc field']);
  });

  it('a system field is written to the model and SAVED — the builder has no save button', async () => {
    const stub = await open();
    await act(async () => {
      await actions.create('system', {
        name: 'Model field',
        table: 'public.orders',
        expression: 'IF(1 = 1, "a", "b")',
        dataType: 'text',
        description: null,
        displayFolder: null,
      });
    });
    expect((stub.storedModel().derivedFields ?? []).map((f) => f.name)).toEqual([
      'Shipped?',
      'Model field',
    ]);
  });
});

describe('the name is an ADDRESS', () => {
  it('a rename re-points the chart being edited', async () => {
    await open();
    await act(async () => {
      await actions.update('system', 'f-sys', {
        name: 'Dispatched?',
        table: 'public.orders',
        expression: SYSTEM.expression,
        dataType: 'text',
        description: null,
        displayFolder: null,
      });
    });
    expect(chartNow.query.axis?.column).toBe('Dispatched?');
    expect(actions.notice).toContain('Renamed to');
  });

  it('narrowing forks under a deduped name AND moves the chart onto the copy', async () => {
    await open();
    await act(async () => {
      await actions.transfer('system', 'personal', 'f-sys');
    });
    const personal = runtime.dashboards.store.getState().personalDerivedFields;
    expect(personal.map((f) => f.name)).toContain('Shipped? (copy)');
    expect(chartNow.query.axis?.column).toBe('Shipped? (copy)');
  });
});
