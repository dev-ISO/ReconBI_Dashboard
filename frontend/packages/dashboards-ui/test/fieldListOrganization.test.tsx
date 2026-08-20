// @vitest-environment jsdom
/**
 * THE FIELD LIST, ORGANIZED — grouping modes, persisted preferences, hidden
 * groups, and the exception that keeps hiding safe.
 *
 * Two scout findings drive this file. First: "Expansion state is EPHEMERAL:
 * lazy useState seeded once, reset on every builder open. No per-user
 * persistence exists." Second, on hiding: a user who tidies a group away and
 * then opens a chart built on it must not be left hunting for a field their
 * own chart references. Both are tested through the REAL settings store
 * against a fake server, because the interesting behaviour is what survives an
 * unmount — and what happens when the server does not answer.
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UserSettingsStore,
  type Catalog,
  type DashboardsApi,
  type Measure,
  type ModelDefinition,
  type RcdUserSettings,
  type RcdUserSettingsDoc,
} from '@recon/dashboards-core';
import { FieldList } from '../src/chart-builder/FieldList';
import { useFieldListPrefs } from '../src/chart-builder/fieldListPrefs';
import { buildScopedMeasures, type MeasureScopeRights } from '../src/chart-builder/measureScopes';

/* ------------------------------------------------------------- fixtures */

const CATALOG: Catalog = {
  connection: 'warehouse',
  versionHash: 'v1',
  fetchedAtUtc: '2026-01-01T00:00:00Z',
  tables: [
    {
      schema: 'public',
      name: 'systems',
      key: 'public.systems',
      kind: 'view',
      rowEstimate: null,
      comment: null,
      primaryKey: [],
      uniqueConstraints: [],
      columns: [
        { name: 'system_number', ordinal: 1, rawType: 'text', type: 'text', isNullable: false, comment: null },
        { name: 'device_count', ordinal: 2, rawType: 'int4', type: 'integer', isNullable: true, comment: null },
      ],
    },
    {
      schema: 'public',
      name: 'devices',
      key: 'public.devices',
      kind: 'view',
      rowEstimate: null,
      comment: null,
      primaryKey: [],
      uniqueConstraints: [],
      columns: [
        { name: 'tag', ordinal: 1, rawType: 'text', type: 'text', isNullable: false, comment: null },
        { name: 'installed_on', ordinal: 2, rawType: 'date', type: 'date', isNullable: true, comment: null },
      ],
    },
  ],
  foreignKeys: [],
} as unknown as Catalog;

const MEASURE: Measure = {
  id: 'm1',
  name: 'Revenue',
  table: 'public.systems',
  aggregation: 'sum',
  column: 'device_count',
};

const MODEL: ModelDefinition = {
  version: 1,
  tables: [
    {
      schema: 'public',
      name: 'systems',
      friendlyName: 'Systems',
      columns: [
        { name: 'system_number', displayFolders: ['Register'] },
        { name: 'device_count', displayFolders: ['Register', 'Mitigation'] },
      ],
    },
    { schema: 'public', name: 'devices', friendlyName: 'Devices' },
  ],
  relationships: [],
  measures: [MEASURE],
};

const WRITABLE: MeasureScopeRights = { available: true, canWrite: true, reason: null };

/** Fake server holding one document; every PUT is recorded. */
const fakeApi = (stored: RcdUserSettingsDoc = { version: 1 }) => {
  let doc = stored;
  const puts: RcdUserSettingsDoc[] = [];
  let getError: unknown = null;
  const api = {
    getUserSettings: async (): Promise<RcdUserSettings> => {
      if (getError) throw getError;
      return { settings: doc, updatedAtUtc: null };
    },
    putUserSettings: async (settings: RcdUserSettingsDoc): Promise<RcdUserSettings> => {
      puts.push(structuredClone(settings));
      doc = settings;
      return { settings, updatedAtUtc: '2026-08-20T09:00:00Z' };
    },
  } as unknown as DashboardsApi;
  return {
    api,
    puts,
    document: () => doc,
    failGetWith: (error: unknown) => {
      getError = error;
    },
  };
};

/* --------------------------------------------------------------- harness */

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

/** Binds FieldList to a real settings store, exactly as ChartBuilder does. */
function Harness({
  settings,
  model = MODEL,
  inUse,
  managed = false,
  parameters,
}: {
  settings: UserSettingsStore | null;
  model?: ModelDefinition;
  inUse?: ReadonlySet<string>;
  managed?: boolean;
  parameters?: { id: string; name: string; kind: 'dimension' | 'measure' }[];
}) {
  const prefs = useFieldListPrefs(settings);
  return (
    <DndContext>
      <FieldList
        model={model}
        catalog={CATALOG}
        onAdd={() => {}}
        prefs={prefs}
        inUse={inUse}
        parameters={parameters}
        measures={
          managed
            ? {
                scoped: buildScopedMeasures([MEASURE], [], []),
                rights: { system: WRITABLE, dashboard: WRITABLE, personal: WRITABLE },
                handlers: {
                  onEdit: vi.fn(),
                  onDuplicate: vi.fn(),
                  onDelete: vi.fn(),
                  onTransfer: vi.fn(),
                },
                onCreate: vi.fn(),
                onManage: vi.fn(),
              }
            : undefined
        }
      />
    </DndContext>
  );
}

const render = (element: React.ReactElement) => {
  act(() => root.render(element));
};

/** Lets the store's hydrate() promise settle. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const button = (predicate: (text: string) => boolean): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => predicate(b.textContent ?? ''));
  if (!found) throw new Error('no matching button');
  return found;
};

const byLabel = (label: string): HTMLButtonElement => {
  const found = host.querySelector(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No button labelled "${label}"`);
  return found as HTMLButtonElement;
};

const headings = (): string[] =>
  [...host.querySelectorAll('button[aria-expanded]')].map((b) => (b.textContent ?? '').trim());

/* ----------------------------------------------------------------- tests */

describe('grouping modes', () => {
  it('offers all three modes and starts on Table', async () => {
    const { api } = fakeApi();
    render(<Harness settings={new UserSettingsStore(api, { debounceMs: 0 })} />);
    await settle();

    const picker = host.querySelector('[aria-label="Group fields by"]')!;
    expect([...picker.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Table',
      'Category',
      'Type',
    ]);
    expect(picker.querySelector('[aria-pressed="true"]')!.textContent).toBe('Table');
    expect(headings()).toContain('Systems');
    expect(headings()).toContain('Devices');
  });

  it('switching to Category rearranges without dropping a single field', async () => {
    const { api } = fakeApi();
    render(<Harness settings={new UserSettingsStore(api, { debounceMs: 0 })} />);
    await settle();
    const before = host.textContent ?? '';

    act(() => button((t) => t === 'Category').click());

    expect(headings()).toContain('Mitigation');
    expect(headings()).toContain('Register');
    expect(headings()).not.toContain('Systems');
    // Every field name still on screen — the arrangement changed, not the offer.
    for (const field of ['system_number', 'device_count', 'tag', 'installed_on']) {
      expect(before).toContain(field);
      expect(host.textContent).toContain(field);
    }
  });

  it('switching to Type groups by what a field is', async () => {
    const { api } = fakeApi();
    render(<Harness settings={new UserSettingsStore(api, { debounceMs: 0 })} />);
    await settle();

    act(() => button((t) => t === 'Type').click());

    expect(headings()).toContain('Text');
    expect(headings()).toContain('Number');
    expect(headings()).toContain('Date');
    expect(headings()).toContain('Yes/No');
  });
});

describe('persisted preferences', () => {
  it('remembers the grouping mode across a full unmount — the modal closing', async () => {
    const server = fakeApi();
    const store = new UserSettingsStore(server.api, { debounceMs: 0 });
    render(<Harness settings={store} />);
    await settle();

    act(() => button((t) => t === 'Type').click());
    await settle();
    expect(server.puts.at(-1)!.fieldList).toMatchObject({ grouping: 'type' });

    // The builder modal closes and reopens: a brand-new store, a brand-new
    // component tree, reading the same server document.
    act(() => root.unmount());
    root = createRoot(host);
    render(<Harness settings={new UserSettingsStore(server.api, { debounceMs: 0 })} />);
    await settle();

    expect(
      host.querySelector('[aria-label="Group fields by"] [aria-pressed="true"]')!.textContent,
    ).toBe('Type');
  });

  it('remembers a COLLAPSED group across a reopen — the thing that used to reset every time', async () => {
    const server = fakeApi();
    render(<Harness settings={new UserSettingsStore(server.api, { debounceMs: 0 })} />);
    await settle();
    expect(host.textContent).toContain('installed_on');

    act(() => button((t) => t.startsWith('Devices')).click());
    await settle();
    expect(host.textContent).not.toContain('installed_on');
    // Keyed by the TABLE KEY — stable across sessions, and unaffected by a
    // friendlyName edit.
    expect(server.puts.at(-1)!.fieldList).toMatchObject({ collapsed: ['public.devices'] });

    act(() => root.unmount());
    root = createRoot(host);
    render(<Harness settings={new UserSettingsStore(server.api, { debounceMs: 0 })} />);
    await settle();

    expect(host.textContent).not.toContain('installed_on');
  });

  it('a settings outage degrades to in-memory behaviour and never blocks the list', async () => {
    const server = fakeApi();
    server.failGetWith(new Error('settings unavailable'));
    const store = new UserSettingsStore(server.api, { debounceMs: 0 });
    render(<Harness settings={store} />);
    await settle();

    // The list rendered anyway.
    expect(headings()).toContain('Systems');
    // …and still responds to the user, exactly as it did before this wave.
    act(() => button((t) => t === 'Category').click());
    expect(headings()).toContain('Register');
    // Nothing was written on top of a document this client could not read.
    expect(server.puts).toHaveLength(0);
  });

  it('works with no settings store at all (standalone builder)', async () => {
    render(<Harness settings={null} />);
    act(() => button((t) => t === 'Type').click());
    expect(headings()).toContain('Number');
  });
});

describe('hiding a group', () => {
  it('hides a group from the picker and offers it back', async () => {
    const server = fakeApi();
    render(<Harness settings={new UserSettingsStore(server.api, { debounceMs: 0 })} />);
    await settle();

    act(() => byLabel('Hide Devices').click());
    await settle();

    expect(headings()).not.toContain('Devices');
    expect(host.textContent).not.toContain('installed_on');
    expect(server.puts.at(-1)!.fieldList).toMatchObject({ hidden: ['public.devices'] });

    // The way back is a persistent affordance, not a toast: hiding outlives
    // the session, so its reversal has to as well.
    act(() => button((t) => t.includes('Show hidden (1)')).click());
    act(() => byLabel('Show Devices').click());
    await settle();

    expect(headings()).toContain('Devices');
    expect(server.puts.at(-1)!.fieldList).toMatchObject({ hidden: [] });
  });

  it('counts only what is hidden IN THE CURRENT MODE', async () => {
    const server = fakeApi({ version: 1, fieldList: { grouping: 'table', hidden: ['#type/text'] } });
    render(<Harness settings={new UserSettingsStore(server.api, { debounceMs: 0 })} />);
    await settle();

    // A type group hidden in Type mode is not "hidden" from Table mode — it
    // does not exist there.
    expect(host.textContent).not.toContain('Show hidden');
    act(() => button((t) => t === 'Type').click());
    expect(host.textContent).toContain('Show hidden (1)');
  });

  it('A HIDDEN GROUP STILL SHOWS A FIELD THE CHART USES, with a note', async () => {
    const server = fakeApi({ version: 1, fieldList: { grouping: 'table', hidden: ['public.devices'] } });
    render(
      <Harness
        settings={new UserSettingsStore(server.api, { debounceMs: 0 })}
        inUse={new Set(['column:public.devices:tag'])}
      />,
    );
    await settle();

    // The group is back on screen — but only for the field in use.
    expect(headings()).toContain('Devices');
    expect(host.textContent).toContain('tag');
    expect(host.textContent).not.toContain('installed_on');
    expect(host.textContent).toContain('Hidden — showing 1 field this chart uses.');
  });

  it('the exception is scoped: an unused hidden group stays hidden', async () => {
    const server = fakeApi({ version: 1, fieldList: { grouping: 'table', hidden: ['public.devices'] } });
    render(
      <Harness
        settings={new UserSettingsStore(server.api, { debounceMs: 0 })}
        inUse={new Set(['column:public.systems:system_number'])}
      />,
    );
    await settle();
    expect(headings()).not.toContain('Devices');
  });

  it('a hidden PARAMETERS section keeps a parameter the chart is bound to', async () => {
    const server = fakeApi({ version: 1, fieldList: { grouping: 'table', hidden: ['#parameters'] } });
    const parameters = [
      { id: 'p1', name: 'Chosen axis', kind: 'dimension' as const },
      { id: 'p2', name: 'Unused', kind: 'measure' as const },
    ];
    render(
      <Harness
        settings={new UserSettingsStore(server.api, { debounceMs: 0 })}
        parameters={parameters}
        inUse={new Set(['parameter:p1'])}
      />,
    );
    await settle();

    // Losing sight of it would leave the binding chip in the wells with
    // nothing in the list to explain it.
    expect(host.textContent).toContain('Chosen axis');
    expect(host.textContent).not.toContain('Unused');
  });

  it('a hidden MEASURE SCOPE keeps a measure the chart references', async () => {
    const server = fakeApi({
      version: 1,
      fieldList: { grouping: 'table', hidden: ['#measures/system'] },
    });
    render(
      <Harness
        settings={new UserSettingsStore(server.api, { debounceMs: 0 })}
        managed
        inUse={new Set(['measure:m1'])}
      />,
    );
    await settle();

    expect(host.textContent).toContain('Revenue');
    expect(host.textContent).toContain('Hidden — showing 1 field this chart uses.');
  });
});
