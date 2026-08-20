// COLLAB-DESIGN wave 1 — live-mode op emission, remote application with the
// dirty-hold doctrine, locally-scoped undo, soft locks, resync. Draft-mode
// (solo dashboard) behavior is asserted UNCHANGED throughout — the existing
// dashboardStore suite is the authority there and this file only guards the
// gate between the two worlds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardsApi, SaveDashboardBody, SendDashboardOpBody } from '../api/DashboardsApi';
import { RcdApiError } from '../api/fetcher';
import type { ChartSpec } from '../types/chart';
import type {
  DashboardDetail,
  DashboardLayoutDoc,
  DashboardTile,
} from '../types/dashboard';
import type { Measure } from '../types/model';
import type { DashboardOpEvent, DashboardOpPayload } from '../types/ops';
import { OP_TARGET_MISSING_ERROR, TILE_LOCKED_ERROR } from '../types/ops';
import { applyOpToDoc, diffLayoutDocs, invertLocalOp } from './collabOps';
import { DashboardStore } from './dashboardStore';

const chartFor = (id = 'chart-1', title = 'Orders'): ChartSpec => ({
  id,
  type: 'column',
  title,
  query: { measures: [{ measureId: 'm1' }], filters: [] },
  format: {},
});

const chartTile = (tileId: string, title = 'Orders'): DashboardTile => ({
  id: tileId,
  layout: { x: 0, y: 0, w: 12, h: 8 },
  chart: chartFor(`c-${tileId}`, title),
});

const layoutWith = (over: Partial<DashboardLayoutDoc> = {}): DashboardLayoutDoc => ({
  version: 1,
  tiles: [],
  slicers: [],
  pages: [{ id: 'p1', name: 'Page 1', tiles: [] }],
  ...over,
});

/** shareCount 1 makes the (owner-held) dashboard COLLABORATIVE → live mode. */
const detailFor = (id: number, over: Partial<DashboardDetail> = {}): DashboardDetail => ({
  id,
  name: `Dash ${id}`,
  description: null,
  modelId: 1,
  isShared: false,
  ownerIsMe: true,
  createdAtUtc: '2026-01-01T00:00:00Z',
  updatedAtUtc: 'stamp-1',
  layout: layoutWith(),
  shareCount: 1,
  ...over,
});

interface ApiStub {
  api: DashboardsApi;
  getDashboard: ReturnType<typeof vi.fn>;
  updateDashboard: ReturnType<typeof vi.fn>;
  patchDashboardMeta: ReturnType<typeof vi.fn>;
  sendOp: ReturnType<typeof vi.fn>;
  acquireTileLock: ReturnType<typeof vi.fn>;
  releaseTileLock: ReturnType<typeof vi.fn>;
}

const apiStub = (detail: DashboardDetail): ApiStub => {
  let opSeq = 0;
  const getDashboard = vi.fn(async (id: number) => structuredClone({ ...detail, id }));
  const updateDashboard = vi.fn(async (id: number, body: SaveDashboardBody) =>
    structuredClone({ ...detail, id, layout: body.layout, updatedAtUtc: 'put-stamp' }),
  );
  const patchDashboardMeta = vi.fn(async (id: number, body: Record<string, unknown>) =>
    structuredClone({ ...detail, id, ...body, updatedAtUtc: 'meta-stamp' }),
  );
  // The RECONCILED response shape (backend DashboardOpResponse) — proves the
  // tolerant stamp reader consumes `updatedAtUtc`.
  const sendOp = vi.fn(async (_id: number, body: SendDashboardOpBody) => ({
    opId: body.opId,
    class: 'layout',
    updatedAtUtc: `op-stamp-${++opSeq}`,
  }));
  // The 200 body of a real acquire — holderUserId is how the store learns its
  // OWN opaque holder id (steal detection tells echo from thief by it).
  const acquireTileLock = vi.fn(async (_id: number, tileId: string) => ({
    tileId,
    holderUserId: '7',
    holderDisplayName: 'Me',
    acquiredAtUtc: '2026-01-01T00:00:00Z',
    expiresAtUtc: '2026-01-01T00:00:30Z',
  }));
  const releaseTileLock = vi.fn(async () => undefined);
  const listDashboards = vi.fn(async () => []);
  return {
    api: {
      getDashboard,
      updateDashboard,
      patchDashboardMeta,
      sendOp,
      acquireTileLock,
      releaseTileLock,
      listDashboards,
    } as unknown as DashboardsApi,
    getDashboard,
    updateDashboard,
    patchDashboardMeta,
    sendOp,
    acquireTileLock,
    releaseTileLock,
  };
};

const openStore = async (
  detail: DashboardDetail,
): Promise<{ store: DashboardStore } & ApiStub> => {
  const stub = apiStub(detail);
  const store = new DashboardStore(stub.api);
  await store.open(detail.id);
  return { store, ...stub };
};

/** Open + enterEdit on a collaborative dashboard (live mode). */
const openLive = async (over: Partial<DashboardDetail> = {}) => {
  const opened = await openStore(detailFor(1, over));
  opened.store.enterEdit();
  expect(opened.store.store.getState().liveMode).toBe(true);
  return opened;
};

const sentBodies = (sendOp: ReturnType<typeof vi.fn>): SendDashboardOpBody[] =>
  sendOp.mock.calls.map((call) => call[1] as SendDashboardOpBody);

/** Outbound payloads travel as JSON OBJECTS on the reconciled wire. */
const sentPayloads = (sendOp: ReturnType<typeof vi.fn>): DashboardOpPayload[] =>
  sentBodies(sendOp).map((body) => body.payload);

/** Drains coalescing windows + the send chain. */
const settle = async (ms = 1000): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

const remoteOp = (
  targetKind: string,
  targetId: string | null,
  payload: DashboardOpPayload,
  over: Partial<DashboardOpEvent> = {},
): DashboardOpEvent => ({
  dashboardId: 1,
  opId: `remote-${Math.random().toString(36).slice(2)}`,
  actorUserId: 42,
  class: 'layout',
  targetKind,
  targetId,
  payloadJson: JSON.stringify(payload),
  resultUpdatedAtUtc: 'remote-stamp-1',
  ...over,
});

const firstPageTiles = (store: DashboardStore): DashboardTile[] =>
  store.store.getState().current!.layout.pages![0]!.tiles;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ================================================================ gating */

describe('live-mode gating', () => {
  it('solo dashboards stay in draft mode: no ops, Save PUTs the doc', async () => {
    const { store, sendOp, updateDashboard } = await openStore(detailFor(1, { shareCount: 0 }));
    store.enterEdit();
    expect(store.store.getState().liveMode).toBe(false);

    store.addTextTile();
    await settle();
    expect(sendOp).not.toHaveBeenCalled();
    expect(store.store.getState().dirty).toBe(true);

    await store.save();
    expect(updateDashboard).toHaveBeenCalledTimes(1);
    const body = updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    expect(body.expectedUpdatedAtUtc).toBe('stamp-1'); // the stamp always travels
  });

  it('a shared dashboard enters live mode: ops persist, Done exits without a PUT', async () => {
    const { store, sendOp, updateDashboard } = await openLive();

    store.addTextTile();
    await settle();
    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(store.store.getState().dirty).toBe(false); // op persisted = saved

    const done = await store.save();
    expect(done).toBe(true);
    expect(updateDashboard).not.toHaveBeenCalled();
    const state = store.store.getState();
    expect(state.mode).toBe('view');
    expect(state.liveMode).toBe(false);
  });

  it('an edit-capable grantee is live even when shareCount is hidden from them', async () => {
    const { store } = await openStore(
      detailFor(1, {
        ownerIsMe: false,
        shareCount: 0,
        myAccess: {
          isOwner: false,
          canEdit: true,
          canEditLayout: true,
          canManagePages: false,
          canEditCharts: true,
          viaShare: true,
          viaPublish: false,
        },
      }),
    );
    store.enterEdit();
    expect(store.store.getState().liveMode).toBe(true);
  });

  it('live enterEdit takes no draft backup and discardEdits is inert', async () => {
    const { store } = await openLive();
    expect(store.store.getState().draftBackup).toBeNull();
    store.addTextTile();
    store.discardEdits();
    expect(store.store.getState().mode).toBe('edit'); // guard held
    expect(firstPageTiles(store)).toHaveLength(1);
  });
});

/* ===================================================== emission per seam */

describe('op emission per seam (live mode)', () => {
  it('addTile → tileUpsert with the RECONCILED op request shape (object payload, no class)', async () => {
    const { store, sendOp } = await openLive();
    store.addTile(chartFor());
    await settle();

    expect(sendOp).toHaveBeenCalledTimes(1);
    const [dashboardId, body] = sendOp.mock.calls[0]! as [number, SendDashboardOpBody];
    expect(dashboardId).toBe(1);
    expect(body.targetKind).toBe('tile');
    expect(body.baseUpdatedAtUtc).toBe('stamp-1');
    expect(body.opId).toBeTruthy();
    expect(body.opId.length).toBeLessThanOrEqual(128);
    // No class on the wire — the SERVER classifies (grantee gate integrity).
    expect('class' in body).toBe(false);
    expect('payloadJson' in body).toBe(false); // payload is a JSON OBJECT
    expect(body.payload).toMatchObject({ kind: 'tileUpsert', pageId: 'p1' });
    expect(body.targetId).toBe((body.payload as { tile: DashboardTile }).tile.id);
    // The sender adopts the committed stamp (response `updatedAtUtc`) as its
    // new baseline via the tolerant reader.
    expect(store.store.getState().current!.expectedUpdatedAtUtc).toBe('op-stamp-1');
  });

  it('removeTile + its orphaned visual card = two ops, ONE undo entry', async () => {
    const tile = chartTile('t1');
    const card = {
      id: 'fc1',
      scope: 'visual' as const,
      targetTileId: 't1',
      table: 't',
      column: 'c',
      mode: 'basic' as const,
      basicValues: ['x'],
    };
    const { store, sendOp } = await openLive({
      layout: layoutWith({
        pages: [{ id: 'p1', name: 'Page 1', tiles: [tile] }],
        filterCards: [card],
      }),
    });

    store.removeTile('t1');
    await settle();

    const payloads = sentPayloads(sendOp);
    expect(payloads).toHaveLength(2);
    // Strict wire shape: tileRemove carries NO fields beyond kind.
    expect(payloads[0]).toEqual({ kind: 'tileRemove' });
    expect(sentBodies(sendOp)[0]!.targetId).toBe('t1');
    expect(payloads[1]).toMatchObject({ kind: 'docElementRemove', field: 'filterCards' });

    // ONE undo entry restores both.
    store.undo();
    await settle();
    expect(firstPageTiles(store)).toHaveLength(1);
    expect(store.store.getState().current!.layout.filterCards).toHaveLength(1);
  });

  it('applyLayout → tileGeometry (strict: layout only, no pageId)', async () => {
    const { store, sendOp } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    store.applyLayout([{ id: 't1', x: 4, y: 2, w: 6, h: 4 }]);
    await settle();

    const body = sentBodies(sendOp)[0]!;
    expect(body.targetId).toBe('t1');
    expect(Object.keys(body.payload).sort()).toEqual(['kind', 'layout']);
    expect(body.payload).toMatchObject({
      kind: 'tileGeometry',
      layout: { x: 4, y: 2, w: 6, h: 4 },
    });
  });

  it('page seams: add / rename / color / reorder / mobile-layout / remove', async () => {
    const { store, sendOp } = await openLive();
    store.addPage('Second');
    await settle();
    const pageId = store.store.getState().current!.layout.pages![1]!.id;
    store.renamePage(pageId, 'Renamed');
    await settle();
    store.setPageColor(pageId, '#ff0000');
    await settle();
    store.movePage(pageId, 'left');
    await settle();
    store.setPageMobileLayout(pageId, { order: [] });
    await settle();
    store.removePage(pageId);
    await settle();

    const payloads = sentPayloads(sendOp);
    expect(payloads.map((p) => p.kind)).toEqual([
      'pageAdd',
      'pageRename',
      'pageColor',
      'pageReorder',
      'pageSet',
      'pageRemove',
    ]);
    // pageReorder is DOC-level on the reconciled wire: targetKind doc,
    // targetId null, ONE op carrying the full page-id order.
    const reorderBody = sentBodies(sendOp)[3]!;
    expect(reorderBody.targetKind).toBe('doc');
    expect(reorderBody.targetId).toBeNull();
    expect(payloads[3]).toEqual({ kind: 'pageReorder', pageIds: [pageId, 'p1'] });
    expect(payloads[4]).toMatchObject({ kind: 'pageSet', patch: { mobileLayout: { order: [] } } });
    // Page-targeted ops carry their page id.
    expect(sentBodies(sendOp)[1]!.targetId).toBe(pageId);
  });

  it('doc seams: scalar set + element upsert', async () => {
    const { store, sendOp } = await openLive();
    store.setRefreshSeconds(60);
    await settle();
    const cardId = store.addFilterCard({
      scope: 'allPages',
      table: 't',
      column: 'c',
      mode: 'basic',
      basicValues: ['x'],
    });
    await settle(1000);

    const payloads = sentPayloads(sendOp);
    // docSettingSet: ONE scalar per op, targetKind doc, targetId null.
    expect(payloads[0]).toEqual({ kind: 'docSettingSet', key: 'refreshSeconds', value: 60 });
    expect(sentBodies(sendOp)[0]!.targetId).toBeNull();
    expect(payloads[1]).toMatchObject({
      kind: 'docElementUpsert',
      field: 'filterCards',
      element: { id: cardId },
    });
    expect(sentBodies(sendOp)[1]!.targetId).toBe(cardId);
  });

  it('bookmark edits in live EDIT mode ride the op pipeline (no PUT)', async () => {
    const { store, sendOp, updateDashboard } = await openLive();
    store.addBookmark('Live mark');
    await settle();

    expect(updateDashboard).not.toHaveBeenCalled();
    expect(sentPayloads(sendOp)[0]).toMatchObject({
      kind: 'docElementUpsert',
      field: 'bookmarks',
    });
  });

  it('classification stays with the differ rules internally (diffLayoutDocs)', async () => {
    // The wire carries no class (the server classifies), but the internal
    // bookkeeping still records the differ's classes for history/Wave-2.
    const before = layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [] }] });
    const after = layoutWith({
      pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }],
      refreshSeconds: 60,
    });
    const ops = diffLayoutDocs(before, after);
    expect(ops.map((op) => [op.payload.kind, op.class])).toEqual([
      ['tileUpsert', 'charts'],
      ['docSettingSet', 'layout'],
    ]);
  });
});

/* ====================================================== coalescing windows */

describe('coalescing windows throttle emission', () => {
  it('updateChart bursts within 800ms fold into ONE op carrying the latest spec', async () => {
    const { store, sendOp } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    store.updateChart('t1', chartFor('c-t1', 'Rev A'));
    await vi.advanceTimersByTimeAsync(300);
    store.updateChart('t1', chartFor('c-t1', 'Rev B'));
    await settle();

    expect(sendOp).toHaveBeenCalledTimes(1);
    const payload = sentPayloads(sendOp)[0]!;
    expect(payload).toMatchObject({ kind: 'tileUpsert' });
    expect((payload as { tile: DashboardTile }).tile.chart!.title).toBe('Rev B');
    // …and ONE history entry (burst coalescing), restoring the pre-burst spec.
    store.undo();
    await settle();
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Orders');
  });

  it('a pause past the window yields separate ops', async () => {
    const { store, sendOp } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    store.updateChart('t1', chartFor('c-t1', 'Rev A'));
    await settle(900);
    store.updateChart('t1', chartFor('c-t1', 'Rev B'));
    await settle(900);
    expect(sendOp).toHaveBeenCalledTimes(2);
  });

  it('drag storms (applyLayout, 400ms) fold into one geometry op', async () => {
    const { store, sendOp } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    for (let step = 1; step <= 5; step += 1) {
      store.applyLayout([{ id: 't1', x: step, y: 0, w: 12, h: 8 }]);
      await vi.advanceTimersByTimeAsync(50);
    }
    await settle();
    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(sentPayloads(sendOp)[0]).toMatchObject({
      kind: 'tileGeometry',
      layout: { x: 5 },
    });
  });

  it('updateTextTile gained its missing coalesce tag (typing burst = one op)', async () => {
    const textTile: DashboardTile = {
      id: 'x1',
      kind: 'text',
      layout: { x: 0, y: 0, w: 8, h: 4 },
      text: { html: '<p>a</p>' },
    };
    const { store, sendOp } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [textTile] }] }),
    });
    store.updateTextTile('x1', { title: 'N' });
    await vi.advanceTimersByTimeAsync(100);
    store.updateTextTile('x1', { title: 'Na' });
    await vi.advanceTimersByTimeAsync(100);
    store.updateTextTile('x1', { title: 'Nam' });
    await settle();
    expect(sendOp).toHaveBeenCalledTimes(1);
  });
});

/* ========================================================== applyRemoteOp */

describe('applyRemoteOp', () => {
  it('clean apply: doc updates, baseline advances, no dirty, no history', async () => {
    const { store } = await openLive();
    store.applyRemoteOp(
      remoteOp('tile', 't9', { kind: 'tileUpsert', pageId: 'p1', tile: chartTile('t9') }),
    );

    const state = store.store.getState();
    expect(firstPageTiles(store).map((t) => t.id)).toEqual(['t9']);
    expect(state.current!.expectedUpdatedAtUtc).toBe('remote-stamp-1');
    expect(state.dirty).toBe(false);
    expect(state.canUndo).toBe(false);
  });

  it('drops the echo of an own op by opId (payload never re-applied)', async () => {
    const { store, sendOp } = await openLive();
    store.addTextTile();
    await settle();
    const ownOpId = sentBodies(sendOp)[0]!.opId;

    store.applyRemoteOp(
      remoteOp('tile', 'bogus', { kind: 'tileRemove' }, {
        opId: ownOpId,
        resultUpdatedAtUtc: 'echo-stamp',
      }),
    );
    expect(firstPageTiles(store)).toHaveLength(1); // remove not applied
    expect(store.store.getState().current!.expectedUpdatedAtUtc).toBe('echo-stamp');
  });

  it('dirty-hold: a remote op on a locally-pending element is HELD, then superseded by the flush (which resyncs)', async () => {
    const { store, getDashboard } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    getDashboard.mockClear();
    store.updateChart('t1', chartFor('c-t1', 'Mine')); // pending (800ms window)

    store.applyRemoteOp(
      remoteOp('tile', 't1', {
        kind: 'tileUpsert',
        pageId: 'p1',
        tile: chartTile('t1', 'Theirs'),
      }),
    );

    let state = store.store.getState();
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Mine'); // element untouched
    expect(state.current!.expectedUpdatedAtUtc).toBe('remote-stamp-1'); // baseline advanced
    expect(Object.keys(state.heldRemoteOps)).toEqual(['tile:t1']); // surfaced

    // Post-flush the server holds our committed write — the supersede-resync
    // must land on THAT truth, not on the pre-edit doc.
    getDashboard.mockResolvedValueOnce(
      detailFor(1, {
        updatedAtUtc: 'fresh-stamp',
        layout: layoutWith({
          pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1', 'Mine')] }],
        }),
      }),
    );

    await settle(); // flush our op → our write is newest, hold superseded
    state = store.store.getState();
    expect(state.heldRemoteOps).toEqual({});
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Mine');
    // The superseded hold was a DROPPED remote change: the quiet point after
    // the drain refetched server truth and cleared the divergence flag.
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(state.collabDiverged).toBe(false);
  });

  it('a lock-held tile holds remote ops; Cancel (release) lands them', async () => {
    const { store } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    await store.acquireTileLock('t1'); // chart builder opened

    store.applyRemoteOp(
      remoteOp('tile', 't1', {
        kind: 'tileUpsert',
        pageId: 'p1',
        tile: chartTile('t1', 'Theirs'),
      }),
    );
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Orders'); // held

    store.releaseTileLock('t1'); // builder cancelled — no local write
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Theirs'); // deferred, not lost
    expect(store.store.getState().heldRemoteOps).toEqual({});
  });

  it('quiesce (print preview) DROPS remote ops; the resume edge refetches instead of replaying', async () => {
    const { store, getDashboard } = await openLive();
    getDashboard.mockClear();
    store.setCollabQuiesce('printPreview', true);
    store.applyRemoteOp(
      remoteOp('tile', 't9', { kind: 'tileUpsert', pageId: 'p1', tile: chartTile('t9') }),
    );
    expect(firstPageTiles(store)).toHaveLength(0);
    // Dropped, not queued — the missed change comes back via the resync only.
    getDashboard.mockResolvedValueOnce(
      detailFor(1, {
        updatedAtUtc: 'after-print',
        layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t9')] }] }),
      }),
    );

    store.setCollabQuiesce('printPreview', false);
    await settle();
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(firstPageTiles(store).map((t) => t.id)).toEqual(['t9']);
    expect(store.store.getState().current!.expectedUpdatedAtUtc).toBe('after-print');
  });

  it('a remote pageRemove reconciles the active page', async () => {
    const { store } = await openLive({
      layout: layoutWith({
        pages: [
          { id: 'p1', name: 'Page 1', tiles: [] },
          { id: 'p2', name: 'Page 2', tiles: [] },
        ],
      }),
    });
    store.setActivePage('p2');
    store.applyRemoteOp(remoteOp('page', 'p2', { kind: 'pageRemove' }, { class: 'pages' }));
    expect(store.store.getState().activePageId).toBe('p1');
  });
});

/* ================================================== locally-scoped undo */

describe('locally-scoped undo/redo in live mode', () => {
  it('undo reverts ONLY the local change (as an emitted inverse op); a collaborator tile survives', async () => {
    const { store, sendOp } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    store.updateChart('t1', chartFor('c-t1', 'Mine'));
    await settle();
    // Collaborator adds their own tile meanwhile.
    store.applyRemoteOp(
      remoteOp('tile', 't2', { kind: 'tileUpsert', pageId: 'p1', tile: chartTile('t2', 'Theirs') }),
    );

    sendOp.mockClear();
    store.undo();
    await settle();

    const tiles = firstPageTiles(store);
    expect(tiles.find((t) => t.id === 't1')!.chart!.title).toBe('Orders'); // mine reverted
    expect(tiles.find((t) => t.id === 't2')!.chart!.title).toBe('Theirs'); // theirs untouched
    // The revert was EMITTED (it must sync), targeting only my element.
    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(sentPayloads(sendOp)[0]).toMatchObject({ kind: 'tileUpsert' });
    expect(sentBodies(sendOp)[0]!.targetId).toBe('t1');

    store.redo();
    await settle();
    expect(firstPageTiles(store).find((t) => t.id === 't1')!.chart!.title).toBe('Mine');
  });

  it("a remote write to an element PURGES my older history for it (their work can't be Ctrl+Z'd away)", async () => {
    const { store } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    store.updateChart('t1', chartFor('c-t1', 'Mine'));
    await settle();
    expect(store.store.getState().canUndo).toBe(true);

    store.applyRemoteOp(
      remoteOp('tile', 't1', { kind: 'tileUpsert', pageId: 'p1', tile: chartTile('t1', 'Theirs') }),
    );

    expect(store.store.getState().canUndo).toBe(false);
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Theirs');
  });

  it('draft mode keeps snapshot undo untouched (no emission)', async () => {
    const { store, sendOp } = await openStore(detailFor(1, { shareCount: 0 }));
    store.enterEdit();
    store.addTextTile();
    store.undo();
    await settle();
    expect(sendOp).not.toHaveBeenCalled();
    expect(firstPageTiles(store)).toHaveLength(0);
    expect(store.store.getState().canRedo).toBe(true);
  });
});

/* ============================================================ failure path */

describe('op-POST failure: retry once, then degrade to draft semantics', () => {
  it('one failure retries transparently (same opId) and stays live', async () => {
    const { store, sendOp } = await openLive();
    sendOp.mockRejectedValueOnce(new RcdApiError('503 oops', 503));
    store.addTextTile();
    await settle();

    expect(sendOp).toHaveBeenCalledTimes(2);
    expect(sentBodies(sendOp)[0]!.opId).toBe(sentBodies(sendOp)[1]!.opId);
    const state = store.store.getState();
    expect(state.liveMode).toBe(true);
    expect(state.dirty).toBe(false);
  });

  it('two failures degrade: saveStatus error, emission held, dirty draft', async () => {
    const { store, sendOp } = await openLive();
    const boom = new RcdApiError('503 oops', 503);
    sendOp.mockRejectedValueOnce(boom).mockRejectedValueOnce(boom);
    store.addTextTile();
    await settle();

    const state = store.store.getState();
    expect(state.liveMode).toBe(false);
    expect(state.saveStatus).toBe('error');
    expect(state.error).toContain('Live sync failed');
    expect(state.dirty).toBe(true); // the doc still carries the change

    sendOp.mockClear();
    store.addTextTile(); // further edits emit nothing (draft semantics)
    await settle();
    expect(sendOp).not.toHaveBeenCalled();
    expect(firstPageTiles(store)).toHaveLength(2);
  });

  it('409 op_target_missing drops the op, resyncs, and STAYS LIVE (no degrade, no retry)', async () => {
    const { store, sendOp, getDashboard } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    getDashboard.mockClear();
    sendOp.mockRejectedValueOnce(new RcdApiError('409', 409, OP_TARGET_MISSING_ERROR));

    store.updateChart('t1', chartFor('c-t1', 'Doomed'));
    await settle();

    // Deterministic 4xx: exactly ONE attempt, then the resync doctrine.
    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(getDashboard).toHaveBeenCalledTimes(1);
    const state = store.store.getState();
    expect(state.liveMode).toBe(true);
    expect(state.saveStatus).not.toBe('error');
    // The refetch restored the server truth for the vanished-target op.
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Orders');
  });
});

/* ================================================================= locks */

describe('soft tile locks', () => {
  it('409 refuses with a message and raises the toolbar notice', async () => {
    const { store, acquireTileLock } = await openLive();
    acquireTileLock.mockRejectedValueOnce(new RcdApiError('409', 409, TILE_LOCKED_ERROR));

    const result = await store.acquireTileLock('t1');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('someone else');
    expect(store.store.getState().lockNotice).toContain('someone else');
    store.clearLockNotice();
    expect(store.store.getState().lockNotice).toBeNull();
  });

  it('acquire starts the 10s heartbeat; release stops it and DELETEs the claim', async () => {
    const { store, acquireTileLock, releaseTileLock } = await openLive();
    await store.acquireTileLock('t1');
    expect(acquireTileLock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(acquireTileLock).toHaveBeenCalledTimes(2); // heartbeat = re-acquire

    store.releaseTileLock('t1');
    expect(releaseTileLock).toHaveBeenCalledWith(1, 't1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acquireTileLock).toHaveBeenCalledTimes(2); // heartbeat stopped
  });

  it('C2: releaseTileLock during an IN-FLIGHT acquire cancels it — wire DELETE, no heartbeat', async () => {
    const { store, acquireTileLock, releaseTileLock } = await openLive();
    let resolveAcquire!: (value: unknown) => void;
    acquireTileLock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAcquire = resolve;
        }),
    );

    const flight = store.acquireTileLock('t1');
    store.releaseTileLock('t1'); // drag already ended — the claim is unwanted
    expect(releaseTileLock).not.toHaveBeenCalled(); // nothing to release YET

    resolveAcquire({ tileId: 't1', holderUserId: '7' });
    expect((await flight).ok).toBe(true);
    expect(releaseTileLock).toHaveBeenCalledWith(1, 't1'); // late claim released

    await vi.advanceTimersByTimeAsync(60_000);
    expect(acquireTileLock).toHaveBeenCalledTimes(1); // heartbeat never installed
  });

  it('C12: a lock event for a tile WE heartbeat with a foreign holder is a STEAL', async () => {
    const { store, acquireTileLock } = await openLive();
    await store.acquireTileLock('t1'); // stub answers holderUserId '7' — our id

    // Our own acquire's broadcast echo: dropped (would badge "Editing: you").
    store.applyTileLock({
      dashboardId: 1,
      tileId: 't1',
      holderUserId: 7,
      holderName: 'Me',
      expiresAtUtc: '2099-01-01T00:00:00Z',
      released: false,
    });
    expect(store.store.getState().tileLocks).toEqual({});

    // A DIFFERENT holder on our heartbeated tile: drop our claim immediately
    // (no waiting for the next heartbeat 409) and render the thief's chip.
    store.applyTileLock({
      dashboardId: 1,
      tileId: 't1',
      holderUserId: 99,
      holderName: 'Eve',
      expiresAtUtc: '2099-01-01T00:00:00Z',
      released: false,
    });
    const state = store.store.getState();
    expect(state.tileLocks['t1']!.holderName).toBe('Eve');
    expect(state.lockNotice).toContain('expired');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(acquireTileLock).toHaveBeenCalledTimes(1); // our heartbeat is dead
  });

  it('lock-service failures never block editing; solo sessions skip lock traffic', async () => {
    const { store, acquireTileLock } = await openLive();
    acquireTileLock.mockRejectedValueOnce(new RcdApiError('500 down', 500));
    expect((await store.acquireTileLock('t1')).ok).toBe(true);

    const solo = await openStore(detailFor(2, { shareCount: 0 }));
    solo.store.enterEdit();
    expect((await solo.store.acquireTileLock('t1')).ok).toBe(true);
    expect(solo.acquireTileLock).not.toHaveBeenCalled();
  });
});

/* ================================================================ resync */

describe('resyncFromServer (reconnect = refetch)', () => {
  it('live: fresh server doc wins EXCEPT elements in the local dirty set', async () => {
    const { store, getDashboard } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    store.updateChart('t1', chartFor('c-t1', 'Mine — unsent')); // pending, unsent

    // The server meanwhile has someone else's t1 AND a new t2.
    getDashboard.mockResolvedValueOnce(
      detailFor(1, {
        updatedAtUtc: 'fresh-stamp',
        layout: layoutWith({
          pages: [
            { id: 'p1', name: 'Page 1', tiles: [chartTile('t1', 'Theirs'), chartTile('t2', 'New')] },
          ],
        }),
      }),
    );
    await store.resyncFromServer();

    const tiles = firstPageTiles(store);
    expect(tiles.find((t) => t.id === 't2')!.chart!.title).toBe('New'); // adopted
    expect(tiles.find((t) => t.id === 't1')!.chart!.title).toBe('Mine — unsent'); // dirty set wins
    expect(store.store.getState().current!.expectedUpdatedAtUtc).toBe('fresh-stamp');
  });

  it('never clobbers a dirty solo draft (the save-time 409 stays the conflict channel)', async () => {
    const { store, getDashboard } = await openStore(detailFor(1, { shareCount: 0 }));
    store.enterEdit();
    store.addTextTile();
    getDashboard.mockClear();

    await store.resyncFromServer();
    expect(getDashboard).not.toHaveBeenCalled();
    expect(firstPageTiles(store)).toHaveLength(1);
  });

  it('view mode refreshes in place', async () => {
    const { store, getDashboard } = await openStore(detailFor(1));
    getDashboard.mockResolvedValueOnce(detailFor(1, { updatedAtUtc: 'fresh-stamp' }));
    await store.resyncFromServer();
    expect(store.store.getState().current!.expectedUpdatedAtUtc).toBe('fresh-stamp');
  });
});

/* =============================================== bookmarks fix-regardless */

describe('view-mode bookmarks on a COLLABORATIVE dashboard become ops', () => {
  it('addBookmark sends a docElementUpsert op instead of the whole-doc PUT', async () => {
    const { store, sendOp, updateDashboard } = await openStore(detailFor(1)); // view mode
    const id = store.addBookmark('Shared view');
    expect(id).not.toBeNull();
    await settle();

    expect(updateDashboard).not.toHaveBeenCalled();
    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(sentPayloads(sendOp)[0]).toMatchObject({
      kind: 'docElementUpsert',
      field: 'bookmarks',
    });
    const state = store.store.getState();
    expect(state.dirty).toBe(false);
    expect(state.current!.expectedUpdatedAtUtc).toBe('op-stamp-1');
  });

  it('a failed op send reverts the bookmark mutation and surfaces the error', async () => {
    const { store, sendOp } = await openStore(detailFor(1));
    const boom = new RcdApiError('503 oops', 503);
    sendOp.mockRejectedValueOnce(boom).mockRejectedValueOnce(boom);

    store.addBookmark('Doomed');
    await settle();

    const state = store.store.getState();
    expect(state.current!.layout.bookmarks ?? []).toHaveLength(0);
    expect(state.dirty).toBe(false);
    expect(state.saveStatus).toBe('error');
  });

  it('solo dashboards keep the historic whole-doc save', async () => {
    const { store, sendOp, updateDashboard } = await openStore(detailFor(1, { shareCount: 0 }));
    store.addBookmark('Solo mark');
    await settle();
    expect(sendOp).not.toHaveBeenCalled();
    expect(updateDashboard).toHaveBeenCalledTimes(1);
  });
});

/* ============================================ C1 — per-op rejections stay live */

describe('per-op 4xx rejections (tile_locked / permission_denied)', () => {
  it('tile_locked drops THAT op, raises the notice, resyncs — and STAYS LIVE', async () => {
    const { store, sendOp, getDashboard } = await openLive({
      layout: layoutWith({ pages: [{ id: 'p1', name: 'Page 1', tiles: [chartTile('t1')] }] }),
    });
    getDashboard.mockClear();
    sendOp.mockRejectedValueOnce(new RcdApiError('409', 409, TILE_LOCKED_ERROR));
    // The holder is already known via the wave-2 lock chip → named in the toast.
    store.applyTileLock({
      dashboardId: 1,
      tileId: 't1',
      holderUserId: 99,
      holderName: 'Eve',
      expiresAtUtc: '2099-01-01T00:00:00Z',
      released: false,
    });

    store.updateChart('t1', chartFor('c-t1', 'Blocked'));
    await settle();

    expect(sendOp).toHaveBeenCalledTimes(1); // deterministic 4xx: no retry
    const state = store.store.getState();
    expect(state.liveMode).toBe(true); // NEVER degrades on an op-scoped verdict
    expect(state.saveStatus).not.toBe('error');
    expect(state.lockNotice).toContain('Eve');
    // The optimistic local apply was reverted by the quiet-point resync.
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(firstPageTiles(store)[0]!.chart!.title).toBe('Orders');
    expect(state.collabDiverged).toBe(false); // cleared once the resync landed
  });

  it('permission_denied is per-op too: later ops still flush, session stays live', async () => {
    const { store, sendOp } = await openLive();
    sendOp.mockRejectedValueOnce(new RcdApiError('403', 403, 'rcd.dashboard.permission_denied'));

    store.addTextTile(); // rejected per-op
    await settle();
    store.addTextTile(); // must still go out
    await settle();

    expect(sendOp).toHaveBeenCalledTimes(2);
    const state = store.store.getState();
    expect(state.liveMode).toBe(true);
    expect(state.lockNotice).toContain('blocked');
  });
});

/* ================================================= C3 — navigation flushes */

describe('open-switch / close flush the pending buffer first', () => {
  it('open() drains the previous live session before clearing it', async () => {
    const { store, sendOp } = await openLive();
    store.addTextTile(); // buffered, timer not yet fired
    expect(sendOp).not.toHaveBeenCalled();

    await store.open(2); // dashboard switch

    expect(sendOp).toHaveBeenCalledTimes(1);
    const [dashboardId, body] = sendOp.mock.calls[0]! as [number, SendDashboardOpBody];
    expect(dashboardId).toBe(1); // flushed against the OLD dashboard
    expect(body.payload).toMatchObject({ kind: 'tileUpsert' });
    expect(store.store.getState().current!.id).toBe(2);
  });

  it('close() drains the live buffer before wiping the session', async () => {
    const { store, sendOp } = await openLive();
    store.addTextTile();
    expect(sendOp).not.toHaveBeenCalled();

    await store.close();

    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(store.store.getState().current).toBeNull();
  });

  it('flushPendingOps drains on demand; keepalive rides through to sendOp', async () => {
    const { store, sendOp } = await openLive();
    store.addTextTile();
    await store.flushPendingOps({ keepalive: true });
    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(sendOp.mock.calls[0]![2]).toEqual({ keepalive: true });
    expect(store.hasUnsentOps()).toBe(false);
  });
});

/* ============================================ C5 — metadata writes never PUT */

describe('rename / publish / live model-link ride the metadata PATCH', () => {
  it('renameDashboard in a LIVE session never PUTs a layout', async () => {
    const { store, updateDashboard, patchDashboardMeta } = await openLive();
    const ok = await store.renameDashboard(1, 'Renamed');
    expect(ok).toBe(true);
    expect(updateDashboard).not.toHaveBeenCalled();
    expect(patchDashboardMeta).toHaveBeenCalledWith(1, { name: 'Renamed' });
    const state = store.store.getState();
    expect(state.current!.name).toBe('Renamed');
    expect(state.current!.expectedUpdatedAtUtc).toBe('meta-stamp');
  });

  it('renameDashboard on a NON-open row PATCHes without ever fetching the doc', async () => {
    const { store, getDashboard, updateDashboard, patchDashboardMeta } = await openStore(detailFor(1));
    getDashboard.mockClear();
    await store.renameDashboard(5, 'Other', 'desc');
    expect(getDashboard).not.toHaveBeenCalled();
    expect(updateDashboard).not.toHaveBeenCalled();
    expect(patchDashboardMeta).toHaveBeenCalledWith(5, { name: 'Other', description: 'desc' });
  });

  it('setPublish never PUTs a layout in any mode', async () => {
    const { store, updateDashboard, patchDashboardMeta } = await openLive();
    const ok = await store.setPublish(true);
    expect(ok).toBe(true);
    expect(updateDashboard).not.toHaveBeenCalled();
    expect(patchDashboardMeta).toHaveBeenCalledWith(1, { isShared: true });
    expect(store.store.getState().current!.isShared).toBe(true);
  });

  it('setModelId in a LIVE session PATCHes (modelId is a row column, never an op)', async () => {
    const { store, sendOp, updateDashboard, patchDashboardMeta } = await openLive();
    store.setModelId(9);
    await settle();
    expect(updateDashboard).not.toHaveBeenCalled();
    expect(sendOp).not.toHaveBeenCalled();
    expect(patchDashboardMeta).toHaveBeenCalledWith(1, { modelId: 9 });
    expect(store.store.getState().current!.modelId).toBe(9);
  });

  it('setModelId in a DRAFT session stays a dirty draft change (Save carries it)', async () => {
    const { store, patchDashboardMeta } = await openStore(detailFor(1, { shareCount: 0 }));
    store.enterEdit();
    store.setModelId(9);
    expect(patchDashboardMeta).not.toHaveBeenCalled();
    expect(store.store.getState().dirty).toBe(true);
  });
});

/* ================================================== C6 — op gating matrix */

describe('applyRemoteOp mode gating (view / live / degraded / draft)', () => {
  const upsert = () =>
    remoteOp('tile', 't9', { kind: 'tileUpsert', pageId: 'p1', tile: chartTile('t9') });

  it('VIEW mode applies (a viewer screen stays current)', async () => {
    const { store } = await openStore(detailFor(1));
    store.applyRemoteOp(upsert());
    expect(firstPageTiles(store).map((t) => t.id)).toEqual(['t9']);
  });

  it('a DEGRADED session ignores ops entirely — the draft is not silently mutated', async () => {
    const { store, sendOp } = await openLive();
    const boom = new RcdApiError('503 oops', 503);
    sendOp.mockRejectedValueOnce(boom).mockRejectedValueOnce(boom);
    store.addTextTile();
    await settle();
    expect(store.store.getState().liveMode).toBe(false); // degraded

    const stampBefore = store.store.getState().current!.expectedUpdatedAtUtc;
    store.applyRemoteOp(upsert());
    expect(firstPageTiles(store).some((t) => t.id === 't9')).toBe(false);
    expect(store.store.getState().current!.expectedUpdatedAtUtc).toBe(stampBefore);
  });

  it('a solo DRAFT edit session ignores ops', async () => {
    const { store } = await openStore(detailFor(1, { shareCount: 0 }));
    store.enterEdit();
    store.applyRemoteOp(upsert());
    expect(firstPageTiles(store)).toHaveLength(0);
  });
});

/* ============================================ L1/L2 — live-visibility controls */

describe('quiesce + cursor toggle (Live menu)', () => {
  it('pause gates ALL FOUR ephemeral channels and remote ops; unpause resyncs', async () => {
    const { store, getDashboard } = await openLive();
    getDashboard.mockClear();
    store.setLiveUpdatesPaused(true);
    expect(store.store.getState().collabPaused).toBe(true);
    expect(store.store.getState().collabQuiesced).toBe(true);

    store.applyRemoteOp(
      remoteOp('tile', 't9', { kind: 'tileUpsert', pageId: 'p1', tile: chartTile('t9') }),
    );
    store.applyEditorsChanged({ dashboardId: 1, editors: [{ userId: 2, userName: 'Bob' }] });
    store.applyRemoteCursor({
      dashboardId: 1,
      userId: 2,
      userName: 'Bob',
      pageId: 'p1',
      xFrac: 0.5,
      yFrac: 0.5,
      at: 'now',
    });
    store.applyTileLock({
      dashboardId: 1,
      tileId: 't1',
      holderUserId: 2,
      holderName: 'Bob',
      expiresAtUtc: '2099-01-01T00:00:00Z',
      released: false,
    });
    store.applyRemoteSlicerValue({ dashboardId: 1, tileId: 's1', userId: 2, valueJson: 'null' });

    const state = store.store.getState();
    expect(firstPageTiles(store)).toHaveLength(0);
    expect(state.collabEditors).toEqual([]);
    expect(state.remoteCursors).toEqual({});
    expect(state.tileLocks).toEqual({});
    expect(state.slicerValues).toEqual({});

    store.setLiveUpdatesPaused(false);
    await settle();
    expect(getDashboard).toHaveBeenCalledTimes(1); // ALWAYS resync on unpause
    expect(store.store.getState().collabQuiesced).toBe(false);
  });

  it('quiesce silences OUR outbound cursor stream too', async () => {
    const stub = apiStub(detailFor(1));
    const onSendCursor = vi.fn();
    const store = new DashboardStore(stub.api, { onSendCursor });
    await store.open(1);

    store.sendCursorThrottled('p1', 0.5, 0.5);
    expect(onSendCursor).toHaveBeenCalledTimes(1);

    store.setCollabQuiesce('printPreview', true);
    store.sendCursorThrottled('p1', 0.6, 0.6);
    await settle();
    expect(onSendCursor).toHaveBeenCalledTimes(1);
  });

  it('cursor toggle OFF stops sending AND rendering; ON restores both', async () => {
    const stub = apiStub(detailFor(1));
    const onSendCursor = vi.fn();
    const store = new DashboardStore(stub.api, { onSendCursor });
    await store.open(1);

    store.setShowLiveCursors(false);
    expect(store.store.getState().collabShowCursors).toBe(false);

    store.sendCursorThrottled('p1', 0.5, 0.5);
    await settle();
    expect(onSendCursor).not.toHaveBeenCalled();

    store.applyRemoteCursor({
      dashboardId: 1,
      userId: 2,
      userName: 'Bob',
      pageId: 'p1',
      xFrac: 0.5,
      yFrac: 0.5,
      at: 'now',
    });
    expect(store.store.getState().remoteCursors).toEqual({});

    store.setShowLiveCursors(true);
    store.sendCursorThrottled('p1', 0.7, 0.7);
    expect(onSendCursor).toHaveBeenCalledTimes(1);
  });
});

/**
 * Dashboard-scoped measures ride the id-keyed doc-element vocabulary.
 *
 * *** WITHOUT 'measures' IN DocElementField / DOC_ELEMENT_FIELDS /
 * DashboardOpApplier.ElementFields, diffLayoutDocs EMITS NOTHING FOR A MEASURE
 * EDIT — live mode has no whole-doc save, so the edit is silently LOST. ***
 * Per-element LWW, undo/redo and inversion then come free, exactly as they do
 * for filter cards, because Measure already has the `id` DocElement requires.
 */
describe('dashboard measures in the op vocabulary', () => {
  const measure = (id: string, name: string, column = 'total'): Measure => ({
    id,
    name,
    table: 'public.orders',
    aggregation: 'sum',
    column,
  });

  it('emits a docElementUpsert when a measure is added', () => {
    const before = layoutWith();
    const after = layoutWith({ measures: [measure('m1', 'Revenue')] });

    const ops = diffLayoutDocs(before, after);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.payload).toEqual({
      kind: 'docElementUpsert',
      field: 'measures',
      element: measure('m1', 'Revenue'),
    });
    expect(ops[0]!.targetId).toBe('m1');
    // Same class as a filter-card edit: layout, never charts.
    expect(ops[0]!.class).toBe('layout');
  });

  it('emits one op PER measure, so concurrent edits merge instead of stomping', () => {
    const before = layoutWith({
      measures: [measure('m1', 'Revenue'), measure('m2', 'Cost', 'cost')],
    });
    const after = layoutWith({
      measures: [measure('m1', 'Revenue', 'quantity'), measure('m2', 'Cost', 'cost')],
    });

    const ops = diffLayoutDocs(before, after);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.targetId).toBe('m1');
  });

  it('emits a docElementRemove when a measure is deleted', () => {
    const before = layoutWith({ measures: [measure('m1', 'Revenue')] });
    const after = layoutWith({ measures: [] });

    const ops = diffLayoutDocs(before, after);

    expect(ops[0]!.payload).toEqual({ kind: 'docElementRemove', field: 'measures' });
    expect(ops[0]!.targetId).toBe('m1');
  });

  it('applies and inverts round-trip (undo/redo comes free)', () => {
    const before = layoutWith({ measures: [measure('m1', 'Revenue')] });
    const after = layoutWith({ measures: [measure('m1', 'Revenue', 'quantity')] });

    const op = diffLayoutDocs(before, after)[0]!;
    const applied = applyOpToDoc(before, op.targetId, op.payload);
    expect(applied!.measures).toEqual(after.measures);

    const inverse = invertLocalOp(before, op)!;
    expect(applyOpToDoc(applied!, inverse.targetId, inverse.payload)!.measures).toEqual(
      before.measures,
    );
  });
});
