// @vitest-environment jsdom
/**
 * Wire-shape regression tests for SubscriptionsDialog.
 *
 * The subscriptions API binds a FLAT SaveSubscriptionRequest with recipients
 * as ONE ';'-joined string. An earlier dialog version sent a nested
 * `schedule` object and a recipients ARRAY: System.Text.Json rejected the
 * array outright (every save 400'd with "One or more validation errors
 * occurred.") and the nested fields would have been silently dropped even if
 * it hadn't. The first test drives the REAL dialog against a stubbed fetcher
 * and asserts the POSTed body EXACTLY matches the payload shape the backend's
 * SchedulingApiTests prove acceptable — so this class of frontend/wire drift
 * can never ship silently again. The rest cover the per-kind mapping and the
 * flat READ path (which previously TypeError'd on subscription.schedule).
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DashboardDetail,
  DashboardSubscription,
  RcdFetcher,
  RcdRequestInit,
} from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import {
  SubscriptionsDialog,
  draftFrom,
  draftToWire,
  lastSentText,
} from '../src/dashboard/SubscriptionsDialog';

/**
 * Reference payload = SchedulingApiTests.SubscriptionBody (backend) with this
 * wave's wire renames (timeOfDayUtc->timeOfDayLocal, dayOfWeekUtc->dayOfWeek)
 * plus the email-content wave's `content` object (EMAIL-CONTENT-DESIGN item 7
 * — camelCase, pinned; new subscriptions default to chart images).
 * If the backend contract moves again, move BOTH tests together.
 */
const REFERENCE_DAILY_BODY = {
  dashboardId: 7,
  name: 'Morning snapshot',
  scheduleKind: 'daily',
  intervalMinutes: null,
  timeOfDayLocal: '08:00',
  dayOfWeek: null,
  recipients: 'one@example.com;two@example.com',
  format: 'html',
  enabled: true,
  content: { body: 'charts', excludedTileIds: [], imageWidth: 600, maxTableRows: 50 },
};

interface RecordedCall {
  path: string;
  init?: RcdRequestInit;
}

const flatSubscription = (overrides: Partial<DashboardSubscription> = {}): DashboardSubscription => ({
  id: 41,
  dashboardId: 7,
  name: 'Ops digest',
  scheduleKind: 'daily',
  intervalMinutes: null,
  timeOfDayLocal: '09:30',
  dayOfWeek: null,
  recipients: 'a@example.com;b@example.com',
  format: 'html',
  enabled: true,
  ownerIsMe: true,
  lastRunUtc: null,
  createdUtc: '2026-08-01T00:00:00Z',
  ...overrides,
});

/**
 * Dashboard doc served to the form's tile checklist: two chart tiles and a
 * text tile (which must NEVER appear in the checklist — only chart tiles ship
 * in the email body).
 */
const DASHBOARD_DETAIL = {
  id: 7,
  name: 'Ops board',
  layout: {
    version: 1,
    tiles: [],
    slicers: [],
    pages: [
      {
        id: 'p1',
        name: 'Page 1',
        tiles: [
          {
            id: 't1',
            layout: { x: 0, y: 0, w: 6, h: 4 },
            chart: { id: 'c1', type: 'column', title: 'Sales by month' },
          },
          {
            id: 't2',
            layout: { x: 6, y: 0, w: 6, h: 4 },
            kind: 'chart',
            chart: { id: 'c2', type: 'table', title: 'Raw rows' },
          },
          {
            id: 't3',
            layout: { x: 0, y: 4, w: 12, h: 2 },
            kind: 'text',
            text: { html: '<p>note</p>' },
          },
        ],
      },
    ],
  },
} as unknown as DashboardDetail;

/**
 * Records every request; GET /subscriptions serves `list`, GET /dashboards/7
 * serves the tile-checklist doc, POST echoes a row.
 */
const makeFetcher = (list: DashboardSubscription[]): { calls: RecordedCall[]; fetcher: RcdFetcher } => {
  const calls: RecordedCall[] = [];
  const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
    calls.push({ path, init });
    if (path.includes('/dashboards/')) return Promise.resolve(DASHBOARD_DETAIL as T);
    if (init?.method === 'POST') return Promise.resolve(flatSubscription() as T);
    return Promise.resolve(list as T);
  }) as RcdFetcher;
  return { calls, fetcher };
};

let host: HTMLDivElement;
let root: Root;
let errors: string[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  errors = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mountDialog = async (fetcher: RcdFetcher) => {
  await act(async () => {
    root.render(
      <DashboardsProvider
        baseUrl="/api/rcd/v1"
        fetcher={fetcher}
        scheduleTimeZoneId="America/Chicago"
        scheduleTimeLabel="CT"
      >
        <SubscriptionsDialog
          open
          dashboardId={7}
          onClose={() => {}}
          onError={(message) => errors.push(message)}
        />
      </DashboardsProvider>,
    );
  });
};

const buttonByText = (text: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button containing "${text}"`);
  return button as HTMLButtonElement;
};

/** Controlled-input edit: React 19 needs the native setter + an input event. */
const typeInto = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  act(() => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** Controlled-select edit: native setter + a change event (React's select path). */
const selectValue = (element: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(
    element,
    value,
  );
  act(() => {
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const selectByLabel = (label: string): HTMLSelectElement | null =>
  document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

describe('SubscriptionsDialog save path (wire shape)', () => {
  it('POSTs the exact flat body the backend contract accepts', async () => {
    const { calls, fetcher } = makeFetcher([]);
    await mountDialog(fetcher);

    // async act: opening the form kicks off the tile-checklist dashboard GET.
    await act(async () => buttonByText('New subscription').click());

    typeInto(
      document.querySelector<HTMLInputElement>('input[placeholder="e.g. Monday morning report"]')!,
      'Morning snapshot',
    );
    // Comma+space entry proves recipients are normalized to the ';' join the
    // backend splits on — commas must never reach the wire.
    typeInto(document.querySelector('textarea')!, 'one@example.com, two@example.com');

    await act(async () => buttonByText('Save subscription').click());

    const post = calls.find((call) => call.init?.method === 'POST');
    expect(post, 'expected one POST /subscriptions').toBeDefined();
    expect(post!.path).toBe('/api/rcd/v1/subscriptions');
    // toEqual is not enough: an EXTRA key (like the old nested `schedule`)
    // must fail too, so compare the exact key set and every value.
    expect(post!.init!.body).toEqual(REFERENCE_DAILY_BODY);
    expect(Object.keys(post!.init!.body as object).sort()).toEqual(Object.keys(REFERENCE_DAILY_BODY).sort());
    expect(errors).toEqual([]);
  });

  it('maps weekly and interval drafts to per-kind nullable fields', () => {
    const base = {
      id: null,
      name: ' Weekly digest ',
      everyMinutes: 30,
      timeLocal: '07:00',
      dayOfWeek: 3,
      recipientsText: 'ops@example.com; boss@example.com',
      format: 'csv' as const,
      enabled: false,
      contentBody: 'both' as const,
      imageWidth: 900 as const,
      maxTableRowsText: '120',
      excludedTileIds: ['t2'],
    };
    const contentWire = { body: 'both', excludedTileIds: ['t2'], imageWidth: 900, maxTableRows: 120 };

    expect(draftToWire({ ...base, kind: 'weekly' }, 9)).toEqual({
      dashboardId: 9,
      name: 'Weekly digest',
      scheduleKind: 'weekly',
      intervalMinutes: null,
      timeOfDayLocal: '07:00',
      dayOfWeek: 3,
      recipients: 'ops@example.com;boss@example.com',
      format: 'csv',
      enabled: false,
      content: contentWire,
    });

    expect(draftToWire({ ...base, kind: 'interval' }, 9)).toEqual({
      dashboardId: 9,
      name: 'Weekly digest',
      scheduleKind: 'interval',
      intervalMinutes: 30,
      timeOfDayLocal: null,
      dayOfWeek: null,
      recipients: 'ops@example.com;boss@example.com',
      format: 'csv',
      enabled: false,
      content: contentWire,
    });
  });

  it('unchecking a checklist tile rides the wire as excludedTileIds', async () => {
    const { calls, fetcher } = makeFetcher([]);
    await mountDialog(fetcher);

    await act(async () => buttonByText('New subscription').click());
    typeInto(
      document.querySelector<HTMLInputElement>('input[placeholder="e.g. Monday morning report"]')!,
      'Morning snapshot',
    );
    typeInto(document.querySelector('textarea')!, 'one@example.com, two@example.com');

    // Only the doc's CHART tiles are listed — the text tile never emails.
    act(() => buttonByText('Tiles to include (2/2)').click());
    const rawRows = [...document.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Raw rows'),
    );
    expect(rawRows, 'expected a checklist row for the "Raw rows" chart tile').toBeDefined();
    expect(
      [...document.querySelectorAll('label')].some((label) => label.textContent?.includes('note')),
      'text tiles must not appear in the checklist',
    ).toBe(false);
    act(() => rawRows!.querySelector('input')!.click());
    expect(buttonByText('Tiles to include (1/2)')).toBeDefined();

    await act(async () => buttonByText('Save subscription').click());

    const post = calls.find((call) => call.init?.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.init!.body).toEqual({
      ...REFERENCE_DAILY_BODY,
      content: { ...REFERENCE_DAILY_BODY.content, excludedTileIds: ['t2'] },
    });
    expect(errors).toEqual([]);
  });
});

describe('content config round-trip (draftFrom -> draftToWire)', () => {
  it('round-trips a saved content config unchanged', () => {
    const saved = flatSubscription({
      content: { body: 'both', excludedTileIds: ['t9'], imageWidth: 900, maxTableRows: 120 },
    });
    expect(draftToWire(draftFrom(saved), 7).content).toEqual({
      body: 'both',
      excludedTileIds: ['t9'],
      imageWidth: 900,
      maxTableRows: 120,
    });
  });

  it('maps legacy NULL/absent content to the explicit tables defaults — content is ALWAYS emitted', () => {
    // NULL -> explicit tables config on the next save: semantics unchanged (LOCKED).
    for (const legacy of [flatSubscription({ content: null }), flatSubscription()]) {
      const wire = draftToWire(draftFrom(legacy), 7);
      expect(wire.content).toEqual({
        body: 'tables',
        excludedTileIds: [],
        imageWidth: 600,
        maxTableRows: 50,
      });
    }
  });
});

describe('SubscriptionForm email-content defaults', () => {
  it('defaults new subscriptions to chart images at 600px and reveals per-mode controls', async () => {
    const { fetcher } = makeFetcher([]);
    await mountDialog(fetcher);
    await act(async () => buttonByText('New subscription').click());

    const body = selectByLabel('Email body')!;
    expect(body.value).toBe('charts');
    expect(selectByLabel('Image width')!.value).toBe('600');
    // Tables are off in charts mode, so the row cap is hidden.
    expect(document.querySelector('input[aria-label="Max rows per tile"]')).toBeNull();

    selectValue(body, 'both');
    expect(selectByLabel('Image width')).not.toBeNull();
    const maxRows = document.querySelector<HTMLInputElement>('input[aria-label="Max rows per tile"]')!;
    expect(maxRows.value).toBe('50');

    selectValue(body, 'tables');
    expect(selectByLabel('Image width')).toBeNull();
    expect(document.querySelector('input[aria-label="Max rows per tile"]')).not.toBeNull();
  });

  it('blocks save while max rows is outside 5..500', async () => {
    const { fetcher } = makeFetcher([]);
    await mountDialog(fetcher);
    await act(async () => buttonByText('New subscription').click());

    typeInto(
      document.querySelector<HTMLInputElement>('input[placeholder="e.g. Monday morning report"]')!,
      'Morning snapshot',
    );
    typeInto(document.querySelector('textarea')!, 'one@example.com');
    selectValue(selectByLabel('Email body')!, 'both');
    expect(buttonByText('Save subscription').disabled).toBe(false);

    typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Max rows per tile"]')!, '9999');
    expect(buttonByText('Save subscription').disabled).toBe(true);
    expect(host.textContent).toContain('Max rows per tile must be a whole number between 5 and 500.');

    typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Max rows per tile"]')!, '25');
    expect(buttonByText('Save subscription').disabled).toBe(false);
  });
});

describe('SubscriptionsDialog read path (flat responses)', () => {
  it('renders flat rows with zone-labelled schedule and last-sent line', async () => {
    const { fetcher } = makeFetcher([
      // 12:30Z on 2026-08-18 is 07:30 CDT — the row must show plant time.
      flatSubscription({ lastRunUtc: '2026-08-18T12:30:00Z' }),
      flatSubscription({
        id: 42,
        name: 'Hourly ping',
        scheduleKind: 'interval',
        intervalMinutes: 60,
        timeOfDayLocal: null,
        recipients: 'solo@example.com',
      }),
    ]);
    await mountDialog(fetcher);

    expect(errors).toEqual([]);
    const text = host.textContent ?? '';
    expect(text).toContain('Daily at 09:30 CT');
    expect(text).toContain('2 recipients');
    expect(text).toContain('Last sent 2026-08-18 07:30 CT');
    expect(text).toContain('Every 60 min');
    expect(text).toContain('1 recipient');
    expect(text).toContain('Never sent');
  });

  it('lastSentText falls back to UTC when the zone id is unknown to the browser', () => {
    expect(lastSentText('2026-08-18T12:30:00Z', 'Not/AZone', 'XX')).toBe('Last sent 2026-08-18 12:30 UTC');
    expect(lastSentText(null, 'America/Chicago', 'CT')).toBe('Never sent');
    // Offsetless serializations must still be read as UTC, not browser-local.
    expect(lastSentText('2026-08-18T12:30:00', 'America/Chicago', 'CT')).toBe('Last sent 2026-08-18 07:30 CT');
  });
});
