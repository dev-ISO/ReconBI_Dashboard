// COLLAB-DESIGN wave 2 — presence roster, remote cursors (TTL), tile-lock
// visibility (echo guard + expiry), shared-slicer values (reentry guard) and
// the outbound cursor throttle. Wave-1 op semantics live in collab.test.ts;
// this file only covers the ephemeral channels layered on top. Every apply*
// action here is host-fed VIEW-MODE-SAFE state: the assertions repeatedly pin
// that mode stays 'view' and dirty stays false — ephemera must never look
// like document edits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { DashboardDetail, DashboardLayoutDoc, DashboardTile } from '../types/dashboard';
import type {
  DashboardRemoteCursorEvent,
  DashboardTileLockEvent,
} from '../types/ops';
import { DashboardStore, type DashboardCollabSenders } from './dashboardStore';

/** A shared slicer tile (the wave-2 broadcast subject) + a personal one. */
const slicerTile = (tileId: string, shared: boolean): DashboardTile => ({
  id: tileId,
  kind: 'slicer',
  layout: { x: 0, y: 0, w: 6, h: 5 },
  slicer: {
    table: 'public.orders',
    column: 'region',
    label: 'Region',
    variant: 'checklist',
    ...(shared ? { shared: true } : {}),
  },
});

const layoutWith = (tiles: DashboardTile[]): DashboardLayoutDoc => ({
  version: 1,
  tiles: [],
  slicers: [],
  pages: [{ id: 'p1', name: 'Page 1', tiles }],
});

/** shareCount 1 = collaborative (live audience); 0 = solo. */
const detailFor = (over: Partial<DashboardDetail> = {}): DashboardDetail => ({
  id: 1,
  name: 'Dash 1',
  description: null,
  modelId: 1,
  isShared: false,
  ownerIsMe: true,
  createdAtUtc: '2026-01-01T00:00:00Z',
  updatedAtUtc: 'stamp-1',
  layout: layoutWith([slicerTile('s-shared', true), slicerTile('s-personal', false)]),
  shareCount: 1,
  ...over,
});

const apiStub = (detail: DashboardDetail): DashboardsApi => {
  return {
    getDashboard: vi.fn(async (id: number) => structuredClone({ ...detail, id })),
    listDashboards: vi.fn(async () => []),
    acquireTileLock: vi.fn(async () => undefined),
    releaseTileLock: vi.fn(async () => undefined),
  } as unknown as DashboardsApi;
};

const openStore = async (
  detail: DashboardDetail = detailFor(),
  senders: DashboardCollabSenders = {},
): Promise<DashboardStore> => {
  const store = new DashboardStore(apiStub(detail), senders);
  await store.open(detail.id);
  return store;
};

const cursorEvent = (
  over: Partial<DashboardRemoteCursorEvent> = {},
): DashboardRemoteCursorEvent => ({
  dashboardId: 1,
  userId: 7,
  userName: 'Kath',
  pageId: 'p1',
  xFrac: 0.25,
  yFrac: 0.5,
  at: '2026-08-19T12:00:00Z',
  ...over,
});

const lockEvent = (over: Partial<DashboardTileLockEvent> = {}): DashboardTileLockEvent => ({
  dashboardId: 1,
  tileId: 't1',
  holderUserId: 7,
  holderName: 'Kath',
  expiresAtUtc: new Date(Date.now() + 30_000).toISOString(),
  released: false,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ============================================================== presence */

describe('applyEditorsChanged', () => {
  it('sets the roster, deduped by user id, without touching mode/dirty', async () => {
    const store = await openStore();
    store.applyEditorsChanged({
      dashboardId: 1,
      editors: [
        { userId: 7, userName: 'Kath' },
        { userId: 7, userName: 'Kath (tab 2)' }, // same person, second socket
        { userId: 9, userName: 'Tim' },
      ],
    });
    const state = store.store.getState();
    expect(state.collabEditors).toEqual([
      { userId: 7, userName: 'Kath' },
      { userId: 9, userName: 'Tim' },
    ]);
    expect(state.mode).toBe('view');
    expect(state.dirty).toBe(false);
  });

  it('ignores events for another dashboard and skips no-op frames', async () => {
    const store = await openStore();
    store.applyEditorsChanged({ dashboardId: 2, editors: [{ userId: 7, userName: 'Kath' }] });
    expect(store.store.getState().collabEditors).toEqual([]);

    store.applyEditorsChanged({ dashboardId: 1, editors: [{ userId: 7, userName: 'Kath' }] });
    const first = store.store.getState().collabEditors;
    store.applyEditorsChanged({ dashboardId: 1, editors: [{ userId: 7, userName: 'Kath' }] });
    // Identical roster → the exact same array reference (no re-render churn).
    expect(store.store.getState().collabEditors).toBe(first);
  });
});

/* =============================================================== cursors */

describe('applyRemoteCursor', () => {
  it('keeps one cursor per user (all received users — the HOST filters own echo)', async () => {
    const store = await openStore();
    store.applyRemoteCursor(cursorEvent({ userId: 7, xFrac: 0.25 }));
    store.applyRemoteCursor(cursorEvent({ userId: 9, userName: 'Tim', xFrac: 0.75 }));
    store.applyRemoteCursor(cursorEvent({ userId: 7, xFrac: 0.3 })); // newer frame replaces

    const cursors = store.store.getState().remoteCursors;
    expect(Object.keys(cursors)).toHaveLength(2);
    expect(cursors[7]!.xFrac).toBe(0.3);
    expect(cursors[9]!.userName).toBe('Tim');
    expect(store.store.getState().dirty).toBe(false);
  });

  it('clamps fractions and drops malformed / foreign-dashboard frames', async () => {
    const store = await openStore();
    store.applyRemoteCursor(cursorEvent({ xFrac: 1.4, yFrac: -0.2 }));
    const cursor = store.store.getState().remoteCursors[7]!;
    expect(cursor.xFrac).toBe(1);
    expect(cursor.yFrac).toBe(0);

    store.applyRemoteCursor(cursorEvent({ userId: 9, xFrac: Number.NaN }));
    store.applyRemoteCursor(cursorEvent({ userId: 11, dashboardId: 2 }));
    expect(Object.keys(store.store.getState().remoteCursors)).toHaveLength(1);
  });

  it('ages a cursor out ~6s after its LAST frame (re-frames refresh the TTL)', async () => {
    const store = await openStore();
    store.applyRemoteCursor(cursorEvent({ userId: 7 }));
    store.applyRemoteCursor(cursorEvent({ userId: 9, userName: 'Tim' }));

    // 4s in: both alive; user 7 sends a fresh frame (TTL restarts for them).
    await vi.advanceTimersByTimeAsync(4_000);
    store.applyRemoteCursor(cursorEvent({ userId: 7, xFrac: 0.9 }));

    // 6s+ after user 9's only frame: 9 swept, 7 still fresh.
    await vi.advanceTimersByTimeAsync(2_500);
    let cursors = store.store.getState().remoteCursors;
    expect(cursors[9]).toBeUndefined();
    expect(cursors[7]).toBeDefined();

    // 6s+ after user 7's last frame: gone too (and the sweep disarms itself —
    // asserted indirectly: state stays a stable empty object afterwards).
    await vi.advanceTimersByTimeAsync(4_000);
    cursors = store.store.getState().remoteCursors;
    expect(Object.keys(cursors)).toHaveLength(0);
  });
});

/* ============================================================ tile locks */

describe('applyTileLock', () => {
  it('stores a foreign lock and clears it on the released event', async () => {
    const store = await openStore();
    store.applyTileLock(lockEvent());
    expect(store.store.getState().tileLocks['t1']).toMatchObject({
      holderUserId: 7,
      holderName: 'Kath',
    });
    expect(store.store.getState().dirty).toBe(false);

    store.applyTileLock(lockEvent({ released: true }));
    expect(store.store.getState().tileLocks['t1']).toBeUndefined();
  });

  it('ages a lock out at expiresAtUtc (heartbeat extensions never broadcast)', async () => {
    const store = await openStore();
    store.applyTileLock(lockEvent({ expiresAtUtc: new Date(Date.now() + 3_000).toISOString() }));
    expect(store.store.getState().tileLocks['t1']).toBeDefined();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(store.store.getState().tileLocks['t1']).toBeUndefined();
  });

  it('ignores foreign-dashboard events', async () => {
    const store = await openStore();
    store.applyTileLock(lockEvent({ dashboardId: 2 }));
    expect(Object.keys(store.store.getState().tileLocks)).toHaveLength(0);
  });

  it('never stores a lock THIS client holds (own-echo guard, both orders)', async () => {
    const store = await openStore();
    store.enterEdit();
    expect(store.store.getState().liveMode).toBe(true);

    // Order 1: our acquire resolves first (heartbeat running) → echo dropped.
    await store.acquireTileLock('t1');
    store.applyTileLock(lockEvent({ tileId: 't1' }));
    expect(store.store.getState().tileLocks['t1']).toBeUndefined();

    // Order 2: the broadcast echo BEATS the acquire response → the acquire
    // clears the raced-in entry ("Editing: you" must never render).
    store.applyTileLock(lockEvent({ tileId: 't2' }));
    expect(store.store.getState().tileLocks['t2']).toBeDefined();
    await store.acquireTileLock('t2');
    expect(store.store.getState().tileLocks['t2']).toBeUndefined();

    store.releaseTileLock('t1');
    store.releaseTileLock('t2');
  });
});

/* ======================================================== shared slicers */

describe('shared slicer values', () => {
  it('applyRemoteSlicerValue sets the value WITHOUT rebroadcast (reentry guard)', async () => {
    const onSendSlicerValue = vi.fn();
    const store = await openStore(detailFor(), { onSendSlicerValue });

    store.applyRemoteSlicerValue({
      dashboardId: 1,
      tileId: 's-shared',
      userId: 7,
      valueJson: JSON.stringify({
        table: 'public.orders',
        column: 'region',
        operator: 'in',
        values: ['West'],
      }),
    });

    const state = store.store.getState();
    expect(state.slicerValues['s-shared']).toMatchObject({ operator: 'in', values: ['West'] });
    expect(state.dirty).toBe(false);
    expect(onSendSlicerValue).not.toHaveBeenCalled();
  });

  it('drops malformed JSON, unknown tiles and foreign dashboards', async () => {
    const store = await openStore();
    store.applyRemoteSlicerValue({ dashboardId: 1, tileId: 's-shared', userId: 7, valueJson: '{nope' });
    store.applyRemoteSlicerValue({ dashboardId: 1, tileId: 'gone', userId: 7, valueJson: 'null' });
    store.applyRemoteSlicerValue({ dashboardId: 2, tileId: 's-shared', userId: 7, valueJson: 'null' });
    expect(Object.keys(store.store.getState().slicerValues)).toHaveLength(0);
  });

  it('a remote null CLEARS the local selection', async () => {
    const store = await openStore();
    store.setSlicerValue('s-shared', {
      table: 'public.orders',
      column: 'region',
      operator: 'in',
      values: ['West'],
    });
    store.applyRemoteSlicerValue({ dashboardId: 1, tileId: 's-shared', userId: 7, valueJson: 'null' });
    expect(store.store.getState().slicerValues['s-shared']).toBeNull();
  });

  it('setSlicerValue on a SHARED slicer broadcasts — in view mode too (viewers participate)', async () => {
    const onSendSlicerValue = vi.fn();
    const store = await openStore(detailFor(), { onSendSlicerValue });
    expect(store.store.getState().mode).toBe('view');

    const clause = {
      table: 'public.orders',
      column: 'region',
      operator: 'in' as const,
      values: ['West'],
    };
    store.setSlicerValue('s-shared', clause);

    expect(onSendSlicerValue).toHaveBeenCalledTimes(1);
    expect(onSendSlicerValue).toHaveBeenCalledWith({
      tileId: 's-shared',
      valueJson: JSON.stringify(clause),
    });

    // Clearing travels as JSON null so receivers clear too.
    store.setSlicerValue('s-shared', null);
    expect(onSendSlicerValue).toHaveBeenLastCalledWith({ tileId: 's-shared', valueJson: 'null' });
  });

  it('never broadcasts: unshared slicers, broadcast:false writes, solo dashboards, missing sender', async () => {
    const onSendSlicerValue = vi.fn();
    const shared = await openStore(detailFor(), { onSendSlicerValue });

    // Not marked shared → personal, exactly as before wave 2.
    shared.setSlicerValue('s-personal', null);
    // The silent escape hatch (default-preset seeding / preset recompute).
    shared.setSlicerValue('s-shared', null, { broadcast: false });
    expect(onSendSlicerValue).not.toHaveBeenCalled();

    // Solo dashboard (no grants): no live audience → nothing to share with.
    const solo = await openStore(detailFor({ shareCount: 0 }), { onSendSlicerValue });
    solo.setSlicerValue('s-shared', null);
    expect(onSendSlicerValue).not.toHaveBeenCalled();

    // No host sender: silently disabled, never a crash.
    const senderless = await openStore();
    expect(() => senderless.setSlicerValue('s-shared', null)).not.toThrow();
  });
});

/* ======================================================= cursor throttle */

describe('sendCursorThrottled', () => {
  it('sends the leading frame, coalesces the burst, delivers the trailing frame', async () => {
    const onSendCursor = vi.fn();
    const store = await openStore(detailFor(), { onSendCursor });

    store.sendCursorThrottled('p1', 0.1, 0.1);
    store.sendCursorThrottled('p1', 0.2, 0.2);
    store.sendCursorThrottled('p1', 0.3, 0.3);
    // Leading frame went immediately; the burst coalesced behind the window.
    expect(onSendCursor).toHaveBeenCalledTimes(1);
    expect(onSendCursor).toHaveBeenCalledWith({ pageId: 'p1', xFrac: 0.1, yFrac: 0.1 });

    // Window edge: the NEWEST pending frame lands (0.2 was superseded).
    await vi.advanceTimersByTimeAsync(100);
    expect(onSendCursor).toHaveBeenCalledTimes(2);
    expect(onSendCursor).toHaveBeenLastCalledWith({ pageId: 'p1', xFrac: 0.3, yFrac: 0.3 });

    // Long quiet: no further sends (the trailing send re-armed one window,
    // which expires empty).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onSendCursor).toHaveBeenCalledTimes(2);
  });

  it('caps a continuous stream at ~1 send per window and clamps fractions', async () => {
    const onSendCursor = vi.fn();
    const store = await openStore(detailFor(), { onSendCursor });

    // 500 ms of pointermove at ~60 Hz.
    for (let step = 0; step < 30; step += 1) {
      store.sendCursorThrottled('p1', step / 30, 2);
      await vi.advanceTimersByTimeAsync(16);
    }
    await vi.advanceTimersByTimeAsync(100);
    // ~480 ms of frames through 100 ms windows: leading + ~5 trailing sends.
    expect(onSendCursor.mock.calls.length).toBeLessThanOrEqual(7);
    expect(onSendCursor.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const [frame] of onSendCursor.mock.calls) {
      expect((frame as { yFrac: number }).yFrac).toBe(1); // clamped
    }
  });

  it('cancelCursorSend (pointerleave) drops the pending trailing frame', async () => {
    const onSendCursor = vi.fn();
    const store = await openStore(detailFor(), { onSendCursor });

    store.sendCursorThrottled('p1', 0.1, 0.1);
    store.sendCursorThrottled('p1', 0.9, 0.9); // pending trailing frame
    store.cancelCursorSend();
    await vi.advanceTimersByTimeAsync(500);
    // Only the leading frame ever went — no stale post-leave position.
    expect(onSendCursor).toHaveBeenCalledTimes(1);
  });

  it('no-ops without the host prop and on solo dashboards', async () => {
    const senderless = await openStore();
    expect(() => senderless.sendCursorThrottled('p1', 0.5, 0.5)).not.toThrow();

    const onSendCursor = vi.fn();
    const solo = await openStore(detailFor({ shareCount: 0 }), { onSendCursor });
    solo.sendCursorThrottled('p1', 0.5, 0.5);
    await vi.advanceTimersByTimeAsync(500);
    expect(onSendCursor).not.toHaveBeenCalled();
  });
});

/* ================================================================ resets */

describe('session resets', () => {
  it('open() drops the previous dashboard\'s ephemera', async () => {
    const store = await openStore();
    store.applyEditorsChanged({ dashboardId: 1, editors: [{ userId: 7, userName: 'Kath' }] });
    store.applyRemoteCursor(cursorEvent());
    store.applyTileLock(lockEvent());

    await store.open(2);
    const state = store.store.getState();
    expect(state.collabEditors).toEqual([]);
    expect(state.remoteCursors).toEqual({});
    expect(state.tileLocks).toEqual({});
  });

  it('enterEdit KEEPS presence/cursors (mode switches are not session ends)', async () => {
    const store = await openStore();
    store.applyEditorsChanged({ dashboardId: 1, editors: [{ userId: 7, userName: 'Kath' }] });
    store.applyRemoteCursor(cursorEvent());

    store.enterEdit();
    const state = store.store.getState();
    expect(state.collabEditors).toHaveLength(1);
    expect(Object.keys(state.remoteCursors)).toHaveLength(1);
  });
});
