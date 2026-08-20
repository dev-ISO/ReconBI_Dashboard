// @vitest-environment jsdom
/**
 * THE MODEL EDITOR'S HALF OF THE PERMISSION FIX — MeasuresPanel's first test.
 *
 * Scout finding, verbatim: "NO READ-ONLY ENFORCEMENT FOR isSystem MODELS:
 * MeasuresPanel never reads current.isSystem; ModelEditor only disables the
 * name field and swaps Save → 'Make a copy'. Add/Edit/Duplicate/Delete stay
 * live, mutate local state, set dirty — then the save 403s."
 *
 * So a user could spend real effort editing a built-in model's measures and
 * lose all of it at save time. The panel now honours the same gate the chart
 * builder uses, administrator carve-out included, and a locked panel still
 * lets you LOOK at a measure — read-only means read, not blind.
 */
import { act, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardsRuntime, RcdFetcher } from '@recon/dashboards-core';
import { DashboardsProvider, useRuntime } from '../src/provider/DashboardsProvider';
import { MeasuresPanel } from '../src/model-editor/MeasuresPanel';

const DEFINITION = {
  version: 1,
  tables: [{ schema: 'public', name: 'orders' }],
  relationships: [],
  measures: [
    {
      id: 's1',
      name: 'Revenue',
      table: 'public.orders',
      aggregation: 'sum' as const,
      column: 'total',
    },
  ],
};

const makeFetcher = (options: { isSystem: boolean; canManageShared: boolean }): RcdFetcher =>
  (<T,>(path: string): Promise<T> => {
    if (path.endsWith('/meta')) {
      return Promise.resolve({ canManageShared: options.canManageShared } as T);
    }
    if (path.endsWith('/user-settings')) return Promise.resolve({ settings: {} } as T);
    if (path.endsWith('/catalog')) {
      return Promise.resolve({ connection: 'warehouse', tables: [] } as T);
    }
    if (path.endsWith('/models/1')) {
      return Promise.resolve({
        id: 1,
        name: 'Stage tracker',
        description: null,
        dataSourceName: 'warehouse',
        isShared: true,
        ownerIsMe: !options.isSystem,
        isSystem: options.isSystem,
        createdAtUtc: '2026-01-01T00:00:00Z',
        updatedAtUtc: 'stamp',
        definition: structuredClone(DEFINITION),
      } as T);
    }
    return Promise.resolve({} as T);
  }) as RcdFetcher;

let host: HTMLDivElement;
let root: Root;
let runtime: DashboardsRuntime;

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

const openPanel = async (options: { isSystem: boolean; canManageShared: boolean }) => {
  const fetcher = makeFetcher(options);
  await mount(fetcher, null);
  await act(async () => {
    await runtime.models.openModel(1);
  });
  await mount(fetcher, <MeasuresPanel />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const hasButtonLabelled = (label: string): boolean =>
  host.querySelector(`button[aria-label="${label}"]`) !== null;

const hasButtonSaying = (text: string): boolean =>
  [...host.querySelectorAll('button')].some((b) => b.textContent?.includes(text));

describe('MeasuresPanel — the isSystem gate', () => {
  it('a normal model you own is fully editable (nothing regressed)', async () => {
    await openPanel({ isSystem: false, canManageShared: false });

    expect(hasButtonSaying('Add measure')).toBe(true);
    expect(hasButtonLabelled('Edit Revenue')).toBe(true);
    expect(hasButtonLabelled('Duplicate Revenue')).toBe(true);
    expect(hasButtonLabelled('Delete Revenue')).toBe(true);
    expect(host.textContent).not.toMatch(/built-in model/i);
  });

  it('a built-in model shows the reason and hides every write affordance', async () => {
    await openPanel({ isSystem: true, canManageShared: false });

    expect(host.textContent).toMatch(/built-in model/i);
    expect(host.textContent).toMatch(/only an administrator/i);
    expect(hasButtonSaying('Add measure')).toBe(false);
    expect(hasButtonLabelled('Edit Revenue')).toBe(false);
    expect(hasButtonLabelled('Duplicate Revenue')).toBe(false);
    expect(hasButtonLabelled('Delete Revenue')).toBe(false);
    // Read-only means READ: the definition is still inspectable.
    expect(hasButtonLabelled('View Revenue')).toBe(true);
  });

  it('an administrator keeps full authoring on a built-in model (the carve-out)', async () => {
    await openPanel({ isSystem: true, canManageShared: true });

    expect(host.textContent).not.toMatch(/only an administrator/i);
    expect(hasButtonSaying('Add measure')).toBe(true);
    expect(hasButtonLabelled('Edit Revenue')).toBe(true);
    expect(hasButtonLabelled('Delete Revenue')).toBe(true);
  });

  it('the locked panel never dirties the model — no work to lose at save time', async () => {
    await openPanel({ isSystem: true, canManageShared: false });
    act(() => (host.querySelector('button[aria-label="View Revenue"]') as HTMLButtonElement).click());

    expect(document.querySelector('fieldset[disabled]')).not.toBeNull();
    expect(runtime.models.store.getState().dirty).toBe(false);
  });
});
