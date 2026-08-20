// @vitest-environment jsdom
/**
 * BUTTONS wave — button-group store behavior: insert/patch round-trips, the
 * sanitize-on-every-write doctrine for rich labels AND advanced CSS (single
 * buttons + every group button), duplicate cloning, and live-mode op emission
 * riding the same mutateActiveTiles seam as every other tile mutation.
 * jsdom because both sanitizers need a DOM (DOMParser / CSSOM).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardsApi, SaveDashboardBody, SendDashboardOpBody } from '../api/DashboardsApi';
import type {
  ButtonGroupTileSpec,
  DashboardDetail,
  DashboardLayoutDoc,
  DashboardTile,
} from '../types/dashboard';
import { isButtonGroupTile } from '../types/dashboard';
import { diffLayoutDocs } from './collabOps';
import { DashboardStore } from './dashboardStore';

const layoutWith = (over: Partial<DashboardLayoutDoc> = {}): DashboardLayoutDoc => ({
  version: 1,
  tiles: [],
  slicers: [],
  pages: [
    { id: 'p1', name: 'Page 1', tiles: [] },
    { id: 'p2', name: 'Page 2', tiles: [] },
  ],
  ...over,
});

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
  ...over,
});

interface ApiStub {
  api: DashboardsApi;
  sendOp: ReturnType<typeof vi.fn>;
}

const apiStub = (detail: DashboardDetail): ApiStub => {
  let opSeq = 0;
  const getDashboard = vi.fn(async (id: number) => structuredClone({ ...detail, id }));
  const updateDashboard = vi.fn(async (id: number, body: SaveDashboardBody) =>
    structuredClone({ ...detail, id, layout: body.layout, updatedAtUtc: 'stamp-2' }),
  );
  const sendOp = vi.fn(async (_id: number, body: SendDashboardOpBody) => ({
    opId: body.opId,
    class: 'layout',
    updatedAtUtc: `op-stamp-${++opSeq}`,
  }));
  const listDashboards = vi.fn(async () => []);
  return {
    api: { getDashboard, updateDashboard, sendOp, listDashboards } as unknown as DashboardsApi,
    sendOp,
  };
};

const openStore = async (detail = detailFor(1)): Promise<{ store: DashboardStore } & ApiStub> => {
  const stub = apiStub(detail);
  const store = new DashboardStore(stub.api);
  await store.open(detail.id);
  return { store, ...stub };
};

const firstPageTiles = (store: DashboardStore): DashboardTile[] =>
  store.store.getState().current!.layout.pages![0]!.tiles;

const groupSpec = (over: Partial<ButtonGroupTileSpec> = {}): ButtonGroupTileSpec => ({
  buttons: [
    { id: 'b1', html: '<p>Overview</p>', targetPageId: 'p1' },
    {
      id: 'b2',
      html: '<p>Detail</p>',
      targetPageId: 'p2',
      background: '#123456',
      textColor: '#ffffff',
      radius: 12,
      customCss: 'background-image: linear-gradient(90deg, #ff0000, #0000ff);',
    },
  ],
  direction: 'row',
  wrap: true,
  gap: 8,
  align: 'center',
  background: null,
  ...over,
});

describe('button-group tiles: insert + round-trip', () => {
  it('addButtonGroupTile lands a kind buttonGroup tile with NO seeded minima and the full spec', async () => {
    const { store } = await openStore();
    store.enterEdit();

    store.addButtonGroupTile(groupSpec());

    const tiles = firstPageTiles(store);
    expect(tiles).toHaveLength(1);
    const tile = tiles[0]!;
    expect(tile.kind).toBe('buttonGroup');
    expect(isButtonGroupTile(tile)).toBe(true);
    // A3: NO minW/minH seeded any more — the grid owns the (content-aware)
    // floor, and a seeded constraint could never be lowered by a later release.
    expect(tile.layout).toEqual({ x: 0, y: 0, w: 8, h: 2 });
    expect(tile.buttonGroup).toMatchObject({
      direction: 'row',
      wrap: true,
      gap: 8,
      align: 'center',
    });
    expect(tile.buttonGroup!.buttons.map((b) => b.id)).toEqual(['b1', 'b2']);
    // The clean spec round-trips verbatim (sanitizers are no-ops on it).
    expect(tile.buttonGroup!.buttons[1]).toMatchObject({
      background: '#123456',
      textColor: '#ffffff',
      radius: 12,
    });
    expect(tile.buttonGroup!.buttons[1]!.customCss).toContain('linear-gradient');
  });

  it('sanitizes EVERY button on write: rich label markup and blocked CSS both', async () => {
    const { store } = await openStore();
    store.enterEdit();

    store.addButtonGroupTile(
      groupSpec({
        buttons: [
          {
            id: 'b1',
            html: '<p>Go <script>alert(1)</script>now</p>',
            targetPageId: 'p1',
            customCss: 'position: absolute; color: red; background: url(https://evil/x);',
          },
        ],
      }),
    );

    const tile = firstPageTiles(store)[0]!;
    const button = tile.buttonGroup!.buttons[0]!;
    expect(button.html).toBe('<p>Go now</p>');
    expect(button.customCss).toBe('color: red;');
  });

  it('sanitizes the container rich inner title on write and on patch (0.14.1/A1)', async () => {
    const { store } = await openStore();
    store.enterEdit();

    store.addButtonGroupTile(
      groupSpec({
        title: 'Navigation',
        container: { hideHeader: false, innerTitleHtml: '<p>Jump <script>alert(1)</script>to</p>' },
      }),
    );
    const tileId = firstPageTiles(store)[0]!.id;
    expect(firstPageTiles(store)[0]!.buttonGroup!.container!.innerTitleHtml).toBe(
      '<p>Jump to</p>',
    );
    // Plain new fields ride the spread untouched.
    expect(firstPageTiles(store)[0]!.buttonGroup!.title).toBe('Navigation');

    store.updateButtonGroupTile(tileId, {
      container: { hideHeader: true, innerTitleHtml: '<p onclick="x()">Patched</p>' },
    });
    const container = firstPageTiles(store)[0]!.buttonGroup!.container!;
    expect(container.hideHeader).toBe(true);
    expect(container.innerTitleHtml).toBe('<p>Patched</p>');
  });

  it('round-trips the 0.14.1 packing/look fields verbatim', async () => {
    const { store } = await openStore();
    store.enterEdit();
    store.addButtonGroupTile(
      groupSpec({ justify: 'between', size: 'lg', variant: 'primary', equalWidth: true }),
    );
    expect(firstPageTiles(store)[0]!.buttonGroup).toMatchObject({
      justify: 'between',
      size: 'lg',
      variant: 'primary',
      equalWidth: true,
    });
  });

  it('updateButtonGroupTile patches settings and re-sanitizes a replaced buttons list', async () => {
    const { store } = await openStore();
    store.enterEdit();
    store.addButtonGroupTile(groupSpec());
    const tileId = firstPageTiles(store)[0]!.id;

    store.updateButtonGroupTile(tileId, { gap: 2, direction: 'column', align: 'stretch' });
    let spec = firstPageTiles(store)[0]!.buttonGroup!;
    expect(spec).toMatchObject({ gap: 2, direction: 'column', align: 'stretch' });
    expect(spec.buttons).toHaveLength(2); // untouched by a settings-only patch

    store.updateButtonGroupTile(tileId, {
      buttons: [
        { id: 'b9', html: '<p>New <b>label</b></p>', targetPageId: 'p2', customCss: 'margin: 4px; opacity: 0.5;' },
      ],
    });
    spec = firstPageTiles(store)[0]!.buttonGroup!;
    expect(spec.buttons).toHaveLength(1);
    expect(spec.buttons[0]!.html).toBe('<p>New <b>label</b></p>');
    expect(spec.buttons[0]!.customCss).toBe('opacity: 0.5;'); // margin blocked
  });

  it('updateButtonTile sanitizes customCss too (B2 covers single buttons)', async () => {
    const { store } = await openStore();
    store.enterEdit();
    store.addButtonTile({ html: '<p>One</p>', targetPageId: 'p2' });
    const tileId = firstPageTiles(store)[0]!.id;

    store.updateButtonTile(tileId, {
      customCss: 'font-weight: 700; position: fixed; background-image: url(https://x);',
    });
    expect(firstPageTiles(store)[0]!.button!.customCss).toBe('font-weight: 700;');
  });

  it('duplicateTile clones the buttonGroup spec under a new tile id', async () => {
    const { store } = await openStore();
    store.enterEdit();
    store.addButtonGroupTile(groupSpec());
    const original = firstPageTiles(store)[0]!;

    store.duplicateTile(original.id);

    const tiles = firstPageTiles(store);
    expect(tiles).toHaveLength(2);
    const copy = tiles[1]!;
    expect(copy.id).not.toBe(original.id);
    expect(copy.kind).toBe('buttonGroup');
    expect(copy.buttonGroup).toEqual(original.buttonGroup);
    expect(copy.buttonGroup).not.toBe(original.buttonGroup); // deep clone
  });
});

describe('button-group tiles: live-mode op emission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('add + update emit tileUpsert ops through the seam-diff decorator (layout class)', async () => {
    // shareCount 1 makes the (owner-held) dashboard COLLABORATIVE → live mode.
    const { store, sendOp } = await openStore(detailFor(1, { shareCount: 1 }));
    store.enterEdit();
    expect(store.store.getState().liveMode).toBe(true);

    const before = structuredClone(store.store.getState().current!.layout);
    store.addButtonGroupTile(groupSpec());
    // The DIFFER classifies buttonGroup content as layout-class (the wire
    // body itself carries no class — the server re-classifies).
    const localOps = diffLayoutDocs(before, store.store.getState().current!.layout);
    expect(localOps).toHaveLength(1);
    expect(localOps[0]).toMatchObject({ class: 'layout', targetKind: 'tile' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendOp).toHaveBeenCalledTimes(1);
    const addBody = sendOp.mock.calls[0]![1] as SendDashboardOpBody;
    expect(addBody.targetKind).toBe('tile');
    expect(addBody.payload).toMatchObject({ kind: 'tileUpsert', pageId: 'p1' });
    const sentTile = (addBody.payload as { tile: DashboardTile }).tile;
    expect(sentTile.kind).toBe('buttonGroup');
    expect(sentTile.buttonGroup!.buttons).toHaveLength(2);

    store.updateButtonGroupTile(sentTile.id, { gap: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendOp).toHaveBeenCalledTimes(2);
    const patchBody = sendOp.mock.calls[1]![1] as SendDashboardOpBody;
    expect(patchBody.targetId).toBe(sentTile.id);
    expect(patchBody.payload).toMatchObject({ kind: 'tileUpsert' });
    expect((patchBody.payload as { tile: DashboardTile }).tile.buttonGroup!.gap).toBe(0);
  });
});
