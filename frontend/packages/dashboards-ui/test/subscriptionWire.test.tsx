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
import type { DashboardSubscription, RcdFetcher, RcdRequestInit } from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import { SubscriptionsDialog, draftToWire, lastSentText } from '../src/dashboard/SubscriptionsDialog';

/**
 * Reference payload = SchedulingApiTests.SubscriptionBody (backend) with this
 * wave's wire renames (timeOfDayUtc->timeOfDayLocal, dayOfWeekUtc->dayOfWeek).
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

/** Records every request; GET /subscriptions serves `list`, POST echoes a row. */
const makeFetcher = (list: DashboardSubscription[]): { calls: RecordedCall[]; fetcher: RcdFetcher } => {
  const calls: RecordedCall[] = [];
  const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
    calls.push({ path, init });
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

describe('SubscriptionsDialog save path (wire shape)', () => {
  it('POSTs the exact flat body the backend contract accepts', async () => {
    const { calls, fetcher } = makeFetcher([]);
    await mountDialog(fetcher);

    act(() => buttonByText('New subscription').click());

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
    };

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
    });
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
