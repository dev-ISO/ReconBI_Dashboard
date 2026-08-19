import { describe, expect, it } from 'vitest';
import type { DashboardsApi } from '../api/DashboardsApi';
import type {
  DispatchProgressFinished,
  DispatchProgressRecipient,
  DispatchProgressStarted,
} from '../types/dashboard';
import { DashboardStore } from './dashboardStore';

/**
 * applyDispatchProgress is the ONE store action a host pushes events into
 * (the tracker's SignalR bridge). These tests pin the event contract:
 * started seeds the entry, recipient events upsert by email, finished stamps
 * the roll-up, stale/out-of-order events are dropped, and a finished without
 * its started still paints counts (bridge connected mid-send).
 */

const storeFor = () => new DashboardStore({} as unknown as DashboardsApi);

const started = (over: Partial<DispatchProgressStarted> = {}): DispatchProgressStarted => ({
  kind: 'started',
  dispatchId: 100,
  subscriptionId: 7,
  subscriptionName: 'Morning snapshot',
  trigger: 'manual',
  recipientCount: 2,
  startedUtc: '2026-08-19T12:00:00Z',
  ...over,
});

const recipient = (over: Partial<DispatchProgressRecipient> = {}): DispatchProgressRecipient => ({
  kind: 'recipient',
  dispatchId: 100,
  subscriptionId: 7,
  email: 'ops@example.com',
  status: 'sent',
  attempts: 1,
  error: null,
  ...over,
});

const finished = (over: Partial<DispatchProgressFinished> = {}): DispatchProgressFinished => ({
  kind: 'finished',
  dispatchId: 100,
  subscriptionId: 7,
  status: 'sent',
  sentCount: 2,
  failedCount: 0,
  optedOutCount: 0,
  error: null,
  finishedUtc: '2026-08-19T12:00:05Z',
  ...over,
});

describe('applyDispatchProgress', () => {
  it('builds live progress from the started → recipient → finished sequence', () => {
    const store = storeFor();

    store.applyDispatchProgress(started());
    let entry = store.store.getState().dispatchProgress[7]!;
    expect(entry).toBeDefined();
    expect(entry.status).toBe('running');
    expect(entry.subscriptionName).toBe('Morning snapshot');
    expect(entry.recipientCount).toBe(2);

    store.applyDispatchProgress(recipient({ status: 'pending', attempts: 1, error: 'SMTP timeout' }));
    store.applyDispatchProgress(recipient({ email: 'boss@example.com' }));
    entry = store.store.getState().dispatchProgress[7]!;
    expect(entry.recipients['ops@example.com']).toEqual({
      status: 'pending',
      attempts: 1,
      error: 'SMTP timeout',
    });
    expect(entry.recipients['boss@example.com']!.status).toBe('sent');

    // A retry resolves the pending recipient — same email upserts.
    store.applyDispatchProgress(recipient({ attempts: 2 }));
    expect(store.store.getState().dispatchProgress[7]!.recipients['ops@example.com']).toEqual({
      status: 'sent',
      attempts: 2,
      error: null,
    });

    store.applyDispatchProgress(finished());
    entry = store.store.getState().dispatchProgress[7]!;
    expect(entry.status).toBe('sent');
    expect(entry.sentCount).toBe(2);
    expect(entry.finishedUtc).toBe('2026-08-19T12:00:05Z');
  });

  it('drops recipient/finished events for a dispatch it is not tracking', () => {
    const store = storeFor();
    store.applyDispatchProgress(started());

    // Stale events from an OLDER dispatch of the same subscription: ignored.
    store.applyDispatchProgress(recipient({ dispatchId: 99, status: 'failed' }));
    store.applyDispatchProgress(finished({ dispatchId: 99, status: 'failed' }));

    const entry = store.store.getState().dispatchProgress[7]!;
    expect(entry.dispatchId).toBe(100);
    expect(entry.status).toBe('running');
    expect(Object.keys(entry.recipients)).toHaveLength(0);
  });

  it('paints a finished-only roll-up when the bridge missed the start', () => {
    const store = storeFor();
    store.applyDispatchProgress(finished({ sentCount: 1, failedCount: 2, status: 'partial' }));

    const entry = store.store.getState().dispatchProgress[7]!;
    expect(entry.status).toBe('partial');
    expect(entry.recipientCount).toBe(3); // sent + failed + optedOut
    expect(entry.sentCount).toBe(1);
    expect(entry.failedCount).toBe(2);
  });

  it('a new started replaces the previous dispatch for that subscription', () => {
    const store = storeFor();
    store.applyDispatchProgress(started());
    store.applyDispatchProgress(recipient());
    store.applyDispatchProgress(started({ dispatchId: 101 }));

    const entry = store.store.getState().dispatchProgress[7]!;
    expect(entry.dispatchId).toBe(101);
    expect(Object.keys(entry.recipients)).toHaveLength(0);
  });

  it('clearDispatchProgress drops one subscription or everything', () => {
    const store = storeFor();
    store.applyDispatchProgress(started());
    store.applyDispatchProgress(started({ subscriptionId: 8, dispatchId: 200 }));

    store.clearDispatchProgress(7);
    expect(store.store.getState().dispatchProgress[7]).toBeUndefined();
    expect(store.store.getState().dispatchProgress[8]).toBeDefined();

    store.clearDispatchProgress();
    expect(store.store.getState().dispatchProgress).toEqual({});
  });
});
