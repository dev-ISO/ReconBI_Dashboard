// @vitest-environment jsdom
/**
 * Preview-path tests for the email-content wave: the SubscriptionPreviewDialog
 * itself (endpoint + body per request kind, sandboxed iframe, caption, CSV
 * note), the form-footer wiring in SubscriptionsDialog (draft endpoint for NEW
 * subs; saved endpoint with a content OVERRIDE when editing), and the
 * manager's Preview icon button (saved endpoint with {} — the config as
 * saved). The endpoints/bodies asserted here are the EMAIL-CONTENT-DESIGN
 * item 10 pin the backend is built against.
 */
import { act, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DashboardDetail,
  DashboardSubscription,
  RcdFetcher,
  RcdRequestInit,
  SubscriptionContentConfig,
} from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import {
  SubscriptionPreviewDialog,
  type SubscriptionPreviewRequest,
} from '../src/dashboard/SubscriptionPreviewDialog';
import { SubscriptionsDialog } from '../src/dashboard/SubscriptionsDialog';
import { SubscriptionsManager } from '../src/dashboard/SubscriptionsManager';

const PREVIEW_RESULT = { subject: 'Ops digest — 2026-08-19', html: '<p>Email body here</p>' };

const subscription = (overrides: Partial<DashboardSubscription> = {}): DashboardSubscription => ({
  id: 41,
  dashboardId: 7,
  name: 'Ops digest',
  scheduleKind: 'daily',
  intervalMinutes: null,
  timeOfDayLocal: '09:30',
  dayOfWeek: null,
  recipients: 'a@example.com',
  format: 'html',
  enabled: true,
  ownerIsMe: true,
  lastRunUtc: null,
  createdUtc: '2026-08-01T00:00:00Z',
  ...overrides,
});

const DASHBOARD_DETAIL = {
  id: 7,
  name: 'Ops board',
  layout: {
    version: 1,
    tiles: [
      { id: 't1', layout: { x: 0, y: 0, w: 6, h: 4 }, chart: { id: 'c1', type: 'column', title: 'Sales' } },
    ],
    slicers: [],
  },
} as unknown as DashboardDetail;

interface RecordedCall {
  path: string;
  init?: RcdRequestInit;
}

/** Routes every endpoint the three surfaces under test hit. */
const makeFetcher = (
  list: DashboardSubscription[],
  previewError?: Error,
): { calls: RecordedCall[]; fetcher: RcdFetcher } => {
  const calls: RecordedCall[] = [];
  const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
    calls.push({ path, init });
    if (path.endsWith('/preview'))
      return previewError ? Promise.reject(previewError) : Promise.resolve(PREVIEW_RESULT as T);
    if (path === '/api/rcd/v1/meta') return Promise.resolve({ canManageShared: false } as T);
    if (path === '/api/rcd/v1/dashboards') return Promise.resolve([] as T);
    if (path.includes('/dashboards/')) return Promise.resolve(DASHBOARD_DETAIL as T);
    if (path.startsWith('/api/rcd/v1/alerts')) return Promise.resolve([] as T);
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

const mount = async (fetcher: RcdFetcher, children: ReactNode) => {
  await act(async () => {
    root.render(
      <DashboardsProvider
        baseUrl="/api/rcd/v1"
        fetcher={fetcher}
        scheduleTimeZoneId="America/Chicago"
        scheduleTimeLabel="CT"
      >
        {children}
      </DashboardsProvider>,
    );
  });
};

const buttonByText = (text: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button containing "${text}"`);
  return button as HTMLButtonElement;
};

const buttonByAriaLabel = (label: string): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`No button with aria-label "${label}"`);
  return button;
};

const previewPost = (calls: RecordedCall[]): RecordedCall => {
  const call = calls.find((c) => c.path.endsWith('/preview'));
  if (!call) throw new Error('expected a preview POST');
  return call;
};

const TABLES_CONTENT: SubscriptionContentConfig = {
  body: 'tables',
  excludedTileIds: [],
  imageWidth: 600,
  maxTableRows: 50,
};

describe('SubscriptionPreviewDialog', () => {
  it('saved request without override posts {} and renders subject + sandboxed iframe + caption', async () => {
    const { calls, fetcher } = makeFetcher([]);
    const request: SubscriptionPreviewRequest = { kind: 'saved', subscriptionId: 41, format: 'html' };
    await mount(fetcher, <SubscriptionPreviewDialog request={request} onClose={() => {}} />);

    const post = previewPost(calls);
    expect(post.path).toBe('/api/rcd/v1/subscriptions/41/preview');
    expect(post.init?.method).toBe('POST');
    expect(post.init?.body).toEqual({});

    expect(host.textContent).toContain('Subject:');
    expect(host.textContent).toContain(PREVIEW_RESULT.subject);
    const iframe = document.querySelector('iframe')!;
    expect(iframe).not.toBeNull();
    // sandbox="" = every restriction on: no scripts, no navigation, no same-origin.
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.getAttribute('srcdoc')).toBe(PREVIEW_RESULT.html);
    expect(host.textContent).toContain('Approximate preview — email clients may render differently.');
    expect(host.textContent).not.toContain('+ CSV attachment');
  });

  it('saved request WITH a content override posts { content }', async () => {
    const { calls, fetcher } = makeFetcher([]);
    const request: SubscriptionPreviewRequest = {
      kind: 'saved',
      subscriptionId: 41,
      format: 'html',
      content: TABLES_CONTENT,
    };
    await mount(fetcher, <SubscriptionPreviewDialog request={request} onClose={() => {}} />);

    const post = previewPost(calls);
    expect(post.path).toBe('/api/rcd/v1/subscriptions/41/preview');
    expect(post.init?.body).toEqual({ content: TABLES_CONTENT });
  });

  it('draft request posts { format, content } to the dashboard preview endpoint', async () => {
    const { calls, fetcher } = makeFetcher([]);
    const content: SubscriptionContentConfig = {
      body: 'charts',
      excludedTileIds: ['t1'],
      imageWidth: 900,
      maxTableRows: 50,
    };
    const request: SubscriptionPreviewRequest = { kind: 'draft', dashboardId: 7, format: 'csv', content };
    await mount(fetcher, <SubscriptionPreviewDialog request={request} onClose={() => {}} />);

    const post = previewPost(calls);
    expect(post.path).toBe('/api/rcd/v1/dashboards/7/subscriptions/preview');
    expect(post.init?.body).toEqual({ format: 'csv', content });
    // csv format carries the attachment note.
    expect(host.textContent).toContain('+ CSV attachment');
  });

  it('shows the failure inline when the preview endpoint rejects', async () => {
    const { fetcher } = makeFetcher([], new Error('render blew up'));
    const request: SubscriptionPreviewRequest = { kind: 'saved', subscriptionId: 41, format: 'html' };
    await mount(fetcher, <SubscriptionPreviewDialog request={request} onClose={() => {}} />);

    expect(host.textContent).toContain('Could not build the preview: render blew up');
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('SubscriptionsDialog form-footer preview wiring', () => {
  it('NEW subscription previews the current draft through the dashboard draft endpoint', async () => {
    const { calls, fetcher } = makeFetcher([]);
    await mount(
      fetcher,
      <SubscriptionsDialog open dashboardId={7} onClose={() => {}} onError={(m) => errors.push(m)} />,
    );
    await act(async () => buttonByText('New subscription').click());
    await act(async () => buttonByText('Preview').click());

    const post = previewPost(calls);
    expect(post.path).toBe('/api/rcd/v1/dashboards/7/subscriptions/preview');
    expect(post.init?.body).toEqual({
      format: 'html',
      content: { body: 'charts', excludedTileIds: [], imageWidth: 600, maxTableRows: 50 },
    });
    expect(host.textContent).toContain(PREVIEW_RESULT.subject);
    expect(errors).toEqual([]);
  });

  it('EDITING a saved subscription previews via its own endpoint with the draft content as override', async () => {
    // Legacy row (content null) — the draft edits as the explicit tables config.
    const { calls, fetcher } = makeFetcher([subscription({ content: null })]);
    await mount(
      fetcher,
      <SubscriptionsDialog open dashboardId={7} onClose={() => {}} onError={(m) => errors.push(m)} />,
    );
    await act(async () => buttonByAriaLabel('Edit subscription Ops digest').click());
    await act(async () => buttonByText('Preview').click());

    const post = previewPost(calls);
    expect(post.path).toBe('/api/rcd/v1/subscriptions/41/preview');
    expect(post.init?.body).toEqual({ content: TABLES_CONTENT });
    expect(host.textContent).toContain(PREVIEW_RESULT.subject);
    expect(errors).toEqual([]);
  });
});

describe('SubscriptionsManager preview wiring', () => {
  it('the Preview icon button previews the SAVED config ({}) through the saved endpoint', async () => {
    const { calls, fetcher } = makeFetcher([subscription()]);
    await mount(
      fetcher,
      <SubscriptionsManager open onClose={() => {}} onError={(m) => errors.push(m)} />,
    );

    await act(async () => buttonByAriaLabel('Preview Ops digest').click());

    const post = previewPost(calls);
    expect(post.path).toBe('/api/rcd/v1/subscriptions/41/preview');
    expect(post.init?.method).toBe('POST');
    expect(post.init?.body).toEqual({});
    expect(host.textContent).toContain(PREVIEW_RESULT.subject);
    expect(errors).toEqual([]);
  });

  it("the manager editor's Preview button rides the saved endpoint with the draft override", async () => {
    const { calls, fetcher } = makeFetcher([subscription({ content: null })]);
    await mount(
      fetcher,
      <SubscriptionsManager open onClose={() => {}} onError={(m) => errors.push(m)} />,
    );

    await act(async () => buttonByAriaLabel('Edit subscription Ops digest').click());
    await act(async () => buttonByText('Preview').click());

    const post = previewPost(calls);
    expect(post.path).toBe('/api/rcd/v1/subscriptions/41/preview');
    expect(post.init?.body).toEqual({ content: TABLES_CONTENT });
    expect(errors).toEqual([]);
  });
});
