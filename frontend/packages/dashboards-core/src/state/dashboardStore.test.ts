import { describe, expect, it, vi } from 'vitest';
import type { DashboardsApi, SaveDashboardBody } from '../api/DashboardsApi';
import { RcdApiError } from '../api/fetcher';
import type { ChartSpec } from '../types/chart';
import type { DashboardDetail, DashboardLayoutDoc } from '../types/dashboard';
import { cloneChartForCopy, DashboardStore } from './dashboardStore';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const layoutWith = (over: Partial<DashboardLayoutDoc> = {}): DashboardLayoutDoc => ({
  version: 1,
  tiles: [],
  slicers: [],
  pages: [{ id: 'p1', name: 'Page 1', tiles: [] }],
  ...over,
});

const detailFor = (
  id: number,
  over: Partial<DashboardDetail> = {},
): DashboardDetail => ({
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

const chartFor = (title = 'Orders'): ChartSpec => ({
  id: 'chart-1',
  type: 'column',
  title,
  query: { measures: [{ measureId: 'm1' }], filters: [] },
  format: {},
});

interface ApiStub {
  api: DashboardsApi;
  getDashboard: ReturnType<typeof vi.fn>;
  updateDashboard: ReturnType<typeof vi.fn>;
  patchDashboardMeta: ReturnType<typeof vi.fn>;
}

const apiStub = (detail: DashboardDetail): ApiStub => {
  const getDashboard = vi.fn(async (id: number) => structuredClone({ ...detail, id }));
  const updateDashboard = vi.fn(async (id: number, body: SaveDashboardBody) =>
    structuredClone({
      ...detail,
      id,
      name: body.name,
      layout: body.layout,
      isShared: body.isShared ?? detail.isShared,
      updatedAtUtc: 'stamp-2',
    }),
  );
  const patchDashboardMeta = vi.fn(async (id: number, body: Record<string, unknown>) =>
    structuredClone({ ...detail, id, ...body, updatedAtUtc: 'stamp-2' }),
  );
  const listDashboards = vi.fn(async () => []);
  return {
    api: {
      getDashboard,
      updateDashboard,
      patchDashboardMeta,
      listDashboards,
    } as unknown as DashboardsApi,
    getDashboard,
    updateDashboard,
    patchDashboardMeta,
  };
};

const openStore = async (detail = detailFor(1)): Promise<{ store: DashboardStore } & ApiStub> => {
  const stub = apiStub(detail);
  const store = new DashboardStore(stub.api);
  await store.open(detail.id);
  return { store, ...stub };
};

describe('finding 7: view-mode bookmark edits auto-persist', () => {
  it('addBookmark in view mode saves immediately', async () => {
    const { store, updateDashboard } = await openStore();

    const id = store.addBookmark('Morning view');
    expect(id).not.toBeNull();
    await flush();

    expect(updateDashboard).toHaveBeenCalledTimes(1);
    const body = updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    expect(body.layout.bookmarks).toMatchObject([{ name: 'Morning view' }]);
    const state = store.store.getState();
    expect(state.dirty).toBe(false);
    expect(state.current!.expectedUpdatedAtUtc).toBe('stamp-2');
  });

  it('reverts the doc mutation and surfaces the error when the save fails', async () => {
    const { store, updateDashboard } = await openStore();
    updateDashboard.mockRejectedValueOnce(new RcdApiError('503 oops', 503));

    store.addBookmark('Doomed');
    expect(store.store.getState().current!.layout.bookmarks).toHaveLength(1);
    await flush();

    const state = store.store.getState();
    expect(state.current!.layout.bookmarks ?? []).toHaveLength(0);
    expect(state.dirty).toBe(false);
    expect(state.saveStatus).toBe('error');
    expect(state.error).toBe('503 oops');
  });

  it('delete/rename/update in view mode also save immediately', async () => {
    const bookmark = {
      id: 'b1',
      name: 'Old',
      state: { pageId: 'p1', slicers: {}, filterOverrides: {} },
    };
    const { store, updateDashboard } = await openStore(
      detailFor(1, { layout: layoutWith({ bookmarks: [bookmark] }) }),
    );

    store.renameBookmark('b1', 'New');
    await flush();
    store.updateBookmark('b1');
    await flush();
    store.deleteBookmark('b1');
    await flush();

    expect(updateDashboard).toHaveBeenCalledTimes(3);
    expect(store.store.getState().dirty).toBe(false);
  });

  it('edit mode keeps bookmark edits in the draft (no save)', async () => {
    const { store, updateDashboard } = await openStore();
    store.enterEdit();

    store.addBookmark('Draft mark');
    await flush();

    expect(updateDashboard).not.toHaveBeenCalled();
    const state = store.store.getState();
    expect(state.dirty).toBe(true);
    expect(state.current!.layout.bookmarks).toHaveLength(1);
  });
});

describe('finding 8: discardEdits keeps the live concurrency stamp', () => {
  it('restores the draft backup but keeps expectedUpdatedAtUtc/isShared from setPublish', async () => {
    const { store } = await openStore();
    store.enterEdit();
    store.addTextTile(); // dirty the draft

    const published = await store.setPublish(true);
    expect(published).toBe(true);

    store.discardEdits();

    const state = store.store.getState();
    expect(state.mode).toBe('view');
    // Draft content rolled back…
    expect(state.current!.layout.pages![0]!.tiles).toHaveLength(0);
    // …but the advanced server stamp and publish flag survive.
    expect(state.current!.expectedUpdatedAtUtc).toBe('stamp-2');
    expect(state.current!.isShared).toBe(true);
  });
});

describe('finding 10: applyBookmark in edit mode', () => {
  const bookmark = {
    id: 'b1',
    name: 'Filtered',
    state: {
      pageId: 'p1',
      slicers: { s1: { table: 't', column: 'c', operator: 'eq' as const, values: ['x'] } },
      filterOverrides: { f1: { disabled: true } },
    },
  };

  it('installs filterCardOverrides in view mode', async () => {
    const { store } = await openStore(detailFor(1, { layout: layoutWith({ bookmarks: [bookmark] }) }));

    store.applyBookmark('b1');

    const state = store.store.getState();
    expect(state.filterCardOverrides).toEqual({ f1: { disabled: true } });
    expect(state.slicerValues).toMatchObject({ s1: { operator: 'eq' } });
  });

  it('does NOT install filterCardOverrides in edit mode (authored doc stays authoritative)', async () => {
    const { store } = await openStore(detailFor(1, { layout: layoutWith({ bookmarks: [bookmark] }) }));
    store.enterEdit();

    store.applyBookmark('b1');

    const state = store.store.getState();
    expect(state.filterCardOverrides).toEqual({});
    // Slicers and page still apply as usual.
    expect(state.slicerValues).toMatchObject({ s1: { operator: 'eq' } });
    expect(state.lastAppliedBookmarkId).toBe('b1');
  });
});

describe('chart clipboard (copyChart / pasteChartTile)', () => {
  it('copy + paste appends a "(copy)" tile in edit mode only', async () => {
    const { store } = await openStore();

    store.copyChart(chartFor('My chart'), 1);
    store.pasteChartTile(); // view mode: no-op
    expect(store.store.getState().current!.layout.pages![0]!.tiles).toHaveLength(0);

    store.enterEdit();
    store.pasteChartTile();

    const state = store.store.getState();
    const tiles = state.current!.layout.pages![0]!.tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.chart!.title).toBe('My chart (copy)');
    expect(tiles[0]!.chart!.id).not.toBe('chart-1'); // fresh chart id
    expect(state.dirty).toBe(true);
  });

  it('survives close() and is never persisted', async () => {
    const { store } = await openStore();
    store.copyChart(chartFor(), 7);
    store.close();
    expect(store.store.getState().chartClipboard).toMatchObject({ sourceModelId: 7 });
  });
});

describe('copyChartToDashboard', () => {
  it('appends in-store when the target is the open dashboard', async () => {
    const { store, updateDashboard } = await openStore();

    await store.copyChartToDashboard(1, chartFor('Same board'), 1);

    const state = store.store.getState();
    expect(state.current!.layout.pages![0]!.tiles).toHaveLength(1);
    expect(state.dirty).toBe(true);
    expect(updateDashboard).not.toHaveBeenCalled();
  });

  it('round-trips getDashboard → append to first page → updateDashboard for other targets', async () => {
    const { store, getDashboard, updateDashboard } = await openStore();

    await store.copyChartToDashboard(2, chartFor('Travelling chart'), 1);

    expect(getDashboard).toHaveBeenCalledWith(2);
    expect(updateDashboard).toHaveBeenCalledTimes(1);
  });

  it('sends the fetched expectedUpdatedAtUtc and appends to the first page', async () => {
    const { store, updateDashboard } = await openStore();

    await store.copyChartToDashboard(2, chartFor('Travelling chart'), 1);

    const [targetId, body] = updateDashboard.mock.calls[0]! as [number, SaveDashboardBody];
    expect(targetId).toBe(2);
    expect(body.expectedUpdatedAtUtc).toBe('stamp-1');
    const tiles = body.layout.pages![0]!.tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.chart!.title).toBe('Travelling chart');
    expect(tiles[0]!.chart!.id).not.toBe('chart-1');
  });

  it('appends to top-level tiles on a legacy no-pages doc', async () => {
    const legacy = detailFor(2, { layout: { version: 1, tiles: [], slicers: [] } });
    const stub = apiStub(legacy);
    const store = new DashboardStore(stub.api);
    await store.open(1);

    await store.copyChartToDashboard(2, chartFor(), 1);

    const body = stub.updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    expect(body.layout.pages ?? []).toHaveLength(0);
    expect(body.layout.tiles).toHaveLength(1);
  });

  it('retries exactly once on rcd.dashboard.stale', async () => {
    const { store, getDashboard, updateDashboard } = await openStore();
    updateDashboard.mockRejectedValueOnce(new RcdApiError('409 conflict', 409, 'rcd.dashboard.stale'));

    await store.copyChartToDashboard(2, chartFor(), 1);

    expect(getDashboard).toHaveBeenCalledTimes(3); // open + attempt + retry
    expect(updateDashboard).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second stale failure and surfaces the error', async () => {
    const { store, updateDashboard } = await openStore();
    const stale = new RcdApiError('409 conflict', 409, 'rcd.dashboard.stale');
    updateDashboard.mockRejectedValueOnce(stale).mockRejectedValueOnce(stale);

    await expect(store.copyChartToDashboard(2, chartFor(), 1)).rejects.toBe(stale);
    expect(updateDashboard).toHaveBeenCalledTimes(2);
    expect(store.store.getState().error).toContain('changed on the server');
  });

  it('surfaces non-stale errors without retrying', async () => {
    const { store, updateDashboard } = await openStore();
    updateDashboard.mockRejectedValueOnce(new RcdApiError('403 Forbidden', 403, 'rcd.dashboard.permission_denied'));

    await expect(store.copyChartToDashboard(2, chartFor(), 1)).rejects.toBeInstanceOf(RcdApiError);
    expect(updateDashboard).toHaveBeenCalledTimes(1);
    expect(store.store.getState().error).toBe(
      'Your access to this dashboard does not allow that change.',
    );
  });
});

describe('renameDashboard (metadata PATCH since the collab fix wave)', () => {
  it('open dashboard: PATCHes name+description (never a layout) and adopts the fresh stamp', async () => {
    const { store, getDashboard, updateDashboard, patchDashboardMeta } = await openStore();
    getDashboard.mockClear();

    const ok = await store.renameDashboard(1, 'Renamed', 'new desc');

    expect(ok).toBe(true);
    expect(getDashboard).not.toHaveBeenCalled();
    expect(updateDashboard).not.toHaveBeenCalled(); // C5: a rename carries no doc
    expect(patchDashboardMeta).toHaveBeenCalledWith(1, { name: 'Renamed', description: 'new desc' });
    const state = store.store.getState();
    expect(state.current!.name).toBe('Renamed');
    expect(state.current!.expectedUpdatedAtUtc).toBe('stamp-2');
  });

  it('open dashboard: omitting description keeps the existing one (field absent in the PATCH)', async () => {
    const { store, patchDashboardMeta } = await openStore(detailFor(1, { description: 'keep me' }));

    await store.renameDashboard(1, 'Renamed');

    expect(patchDashboardMeta).toHaveBeenCalledWith(1, { name: 'Renamed' });
    expect(store.store.getState().current!.description).toBe('keep me');
  });

  it('non-open row: PATCHes by id without ever fetching (nothing to clobber)', async () => {
    const { store, getDashboard, updateDashboard, patchDashboardMeta } = await openStore();
    getDashboard.mockClear();

    const ok = await store.renameDashboard(2, 'Other renamed');

    expect(ok).toBe(true);
    expect(getDashboard).not.toHaveBeenCalled();
    expect(updateDashboard).not.toHaveBeenCalled();
    expect(patchDashboardMeta).toHaveBeenCalledWith(2, { name: 'Other renamed' });
    // The open dashboard is untouched.
    expect(store.store.getState().current!.name).toBe('Dash 1');
  });

  it('surfaces failures via store error and returns false', async () => {
    const { store, patchDashboardMeta } = await openStore();
    patchDashboardMeta.mockRejectedValueOnce(
      new RcdApiError('409 conflict', 409, 'rcd.dashboard.name_conflict'),
    );

    const ok = await store.renameDashboard(1, 'Taken');

    expect(ok).toBe(false);
    expect(store.store.getState().error).toBeTruthy();
    expect(store.store.getState().current!.name).toBe('Dash 1'); // nothing patched
  });
});

describe('button tiles (0.11.1)', () => {
  it('addButtonTile sanitizes the rich label and applies the default geometry', async () => {
    const { store } = await openStore();
    store.enterEdit();

    store.addButtonTile({
      html: '<p>Go</p><script>alert(1)</script>',
      targetPageId: 'p1',
      radius: 12,
      fullSize: true,
    });

    const tile = store.store.getState().current!.layout.pages![0]!.tiles[0]!;
    expect(tile.kind).toBe('button');
    // Sanitized on write. (This suite runs in node, where sanitizeRichHtml
    // degrades to escaped plain text — assert the invariant that holds in
    // BOTH environments: no live markup survives, the label text does.)
    expect(tile.button!.html).not.toContain('<script');
    expect(tile.button!.html).toContain('Go');
    expect(tile.button!.targetPageId).toBe('p1');
    expect(tile.button!.radius).toBe(12);
    expect(tile.button!.fullSize).toBe(true);
    expect(tile.layout).toMatchObject({ w: 4, h: 2, minW: 2, minH: 1 });
  });

  it('updateButtonTile patches the spec and re-sanitizes html', async () => {
    const { store } = await openStore();
    store.enterEdit();
    store.addButtonTile({ html: '<p>Go</p>', targetPageId: 'p1' });
    const tileId = store.store.getState().current!.layout.pages![0]!.tiles[0]!.id;

    store.updateButtonTile(tileId, { html: '<p>Next</p><iframe src="x"></iframe>', targetPageId: 'p2' });

    const tile = store.store.getState().current!.layout.pages![0]!.tiles[0]!;
    expect(tile.button!.html).not.toContain('<iframe');
    expect(tile.button!.html).toContain('Next');
    expect(tile.button!.targetPageId).toBe('p2');
  });

  it('duplicateTile clones the button spec', async () => {
    const { store } = await openStore();
    store.enterEdit();
    store.addButtonTile({ html: '<p>Go</p>', targetPageId: 'p1', background: '#123456' });
    const tileId = store.store.getState().current!.layout.pages![0]!.tiles[0]!.id;

    store.duplicateTile(tileId);

    const tiles = store.store.getState().current!.layout.pages![0]!.tiles;
    expect(tiles).toHaveLength(2);
    expect(tiles[1]!.kind).toBe('button');
    expect(tiles[1]!.button).toEqual(tiles[0]!.button);
    expect(tiles[1]!.button).not.toBe(tiles[0]!.button); // deep clone, not shared
  });
});

describe('cloneChartForCopy (the shared copy-path clone)', () => {
  /** Frameless seeded-tile pattern: the INNER title carries the visible name. */
  const framelessChart = (): ChartSpec => ({
    ...chartFor('Valve Status'),
    format: {
      container: {
        hideHeader: true,
        innerTitleHtml:
          '<p><b>Valve Status</b> <span style="color:#64748b">&mdash; by area</span></p>',
      },
    },
  });

  it('assigns a fresh chart id and suffixes the title (source untouched)', () => {
    const source = chartFor('Orders');
    const copy = cloneChartForCopy(source, { suffix: true });
    expect(copy.id).not.toBe(source.id);
    expect(copy.title).toBe('Orders (copy)');
    expect(source.title).toBe('Orders');
  });

  it("rewrites the inner title's bold lead-in to the copy's title", () => {
    const copy = cloneChartForCopy(framelessChart(), { suffix: true });
    expect(copy.format.container?.innerTitleHtml).toBe(
      '<p><b>Valve Status (copy)</b> <span style="color:#64748b">&mdash; by area</span></p>',
    );
  });

  it('without a suffix the inner title still normalizes to the (unchanged) title', () => {
    const copy = cloneChartForCopy(framelessChart());
    expect(copy.title).toBe('Valve Status');
    expect(copy.format.container?.innerTitleHtml).toContain('<b>Valve Status</b>');
  });

  it('leaves an inner title without a bold element untouched', () => {
    const source: ChartSpec = {
      ...chartFor('Orders'),
      format: { container: { innerTitleHtml: '<p>plain description</p>' } },
    };
    const copy = cloneChartForCopy(source, { suffix: true });
    expect(copy.format.container?.innerTitleHtml).toBe('<p>plain description</p>');
  });

  /* H1: the rewrite is CONDITIONAL — it fires only while the bold lead-in
   * still reads as the SOURCE chart's title. A customized inner title is the
   * user's newer statement and must survive every copy path untouched. */

  it('preserves a CUSTOMIZED bold lead-in (rewrite only when it matches the source title)', () => {
    const customized: ChartSpec = {
      ...chartFor('Valve Status'),
      format: {
        container: {
          hideHeader: true,
          innerTitleHtml: '<p><b>Executive Overview</b> <span>&mdash; by area</span></p>',
        },
      },
    };
    const copy = cloneChartForCopy(customized, { suffix: true });
    // Title still gains the suffix; the custom inner title rides through.
    expect(copy.title).toBe('Valve Status (copy)');
    expect(copy.format.container?.innerTitleHtml).toBe(
      '<p><b>Executive Overview</b> <span>&mdash; by area</span></p>',
    );
  });

  it('matches the source title through HTML entities in the bold run', () => {
    const source: ChartSpec = {
      ...chartFor('P&L Overview'),
      format: {
        container: { innerTitleHtml: '<p><b>P&amp;L Overview</b> <span>tail</span></p>' },
      },
    };
    const copy = cloneChartForCopy(source, { suffix: true });
    expect(copy.format.container?.innerTitleHtml).toBe(
      '<p><b>P&amp;L Overview (copy)</b> <span>tail</span></p>',
    );
  });

  it('duplicateTile keeps a customized inner title too (store copy path)', async () => {
    const { store } = await openStore();
    store.enterEdit();
    const customized: ChartSpec = {
      ...chartFor('Valve Status'),
      format: {
        container: {
          hideHeader: true,
          innerTitleHtml: '<p><b>Executive Overview</b></p>',
        },
      },
    };
    store.addTile(customized);
    const tileId = store.store.getState().current!.layout.pages![0]!.tiles[0]!.id;

    store.duplicateTile(tileId);

    const tiles = store.store.getState().current!.layout.pages![0]!.tiles;
    expect(tiles).toHaveLength(2);
    expect(tiles[1]!.chart!.title).toBe('Valve Status (copy)');
    expect(tiles[1]!.chart!.format.container?.innerTitleHtml).toBe(
      '<p><b>Executive Overview</b></p>',
    );
  });

  it('same-dashboard "copy to" gains the suffix and the retitled inner title', async () => {
    const { store } = await openStore();
    store.enterEdit();

    await store.copyChartToDashboard(1, framelessChart(), 1);

    const tiles = store.store.getState().current!.layout.pages![0]!.tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.chart!.title).toBe('Valve Status (copy)');
    expect(tiles[0]!.chart!.format.container?.innerTitleHtml).toContain(
      '<b>Valve Status (copy)</b>',
    );
  });
});
