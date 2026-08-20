import { describe, expect, it, vi } from 'vitest';
import type { DashboardsApi, SaveDashboardBody } from '../api/DashboardsApi';
import { RcdApiError } from '../api/fetcher';
import type { ChartSpec } from '../types/chart';
import type { DashboardDetail, DashboardLayoutDoc } from '../types/dashboard';
import type { Measure } from '../types/model';
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
  getModel: ReturnType<typeof vi.fn>;
  updateModel: ReturnType<typeof vi.fn>;
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
  const getModel = vi.fn(async (id: number) => ({
    id,
    name: 'Demo model',
    description: null,
    dataSourceName: 'demo',
    isShared: true,
    ownerIsMe: true,
    createdAtUtc: '2026-01-01T00:00:00Z',
    updatedAtUtc: 'model-stamp-1',
    definition: { version: 1, tables: [], relationships: [], measures: [] },
  }));
  const updateModel = vi.fn(async (id: number, body: { definition: unknown }) => ({
    id,
    definition: body.definition,
    updatedAtUtc: 'model-stamp-2',
  }));
  return {
    api: {
      getDashboard,
      updateDashboard,
      patchDashboardMeta,
      listDashboards,
      getModel,
      updateModel,
    } as unknown as DashboardsApi,
    getDashboard,
    updateDashboard,
    patchDashboardMeta,
    getModel,
    updateModel,
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

/**
 * BREAKAGE FIX: a chart citing DASHBOARD-scoped measures used to land on the
 * target as QRY_UNKNOWN_MEASURE — the definitions live in the SOURCE document
 * and only `chart` was carried. They now travel, transitively, through the
 * same collision-safe merge the clipboard uses.
 */
describe('copy carries dashboard measure definitions', () => {
  const measure = (id: string, name: string, column = 'total'): Measure => ({
    id,
    name,
    table: 'public.orders',
    aggregation: 'sum',
    column,
  });

  const calcMeasure = (id: string, name: string, expression: string): Measure => ({
    id,
    name,
    table: 'public.orders',
    aggregation: 'sum',
    expression,
  });

  const chartCiting = (measureId: string, title = 'Scoped'): ChartSpec => ({
    id: 'chart-1',
    type: 'column',
    title,
    query: { measures: [{ measureId }], filters: [] },
    format: {},
  });

  const sourceDetail = (measures: Measure[]): DashboardDetail =>
    detailFor(1, { layout: layoutWith({ measures }) });

  it('definitionsForChart resolves the transitive set the wire needs', async () => {
    const leaf = measure('m1', 'Leaf');
    const top = calcMeasure('m2', 'Top', '[Leaf] + 1');
    const { store } = await openStore(sourceDetail([leaf, top]));

    expect(store.definitionsForChart(chartCiting('m2')).map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(store.measureCarryCount(chartCiting('m2'))).toBe(2);
    expect(store.measureCarryCount(chartCiting('unknown'))).toBe(0);
  });

  it('carries the referenced definitions — transitively — onto the target doc', async () => {
    const leaf = measure('m1', 'Leaf');
    const top = calcMeasure('m2', 'Top', '[Leaf] + 1');
    const stub = apiStub(sourceDetail([leaf, top]));
    const store = new DashboardStore(stub.api);
    await store.open(1);
    // The TARGET fetch returns a doc with no measures of its own.
    stub.getDashboard.mockResolvedValueOnce(
      structuredClone({ ...detailFor(2), layout: layoutWith() }),
    );

    await store.copyChartToDashboard(2, chartCiting('m2'), 1);

    const body = stub.updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    expect(body.layout.measures!.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(body.layout.pages![0]!.tiles[0]!.chart!.query.measures[0]!.measureId).toBe('m2');
  });

  it('carries nothing for a chart that only uses model measures', async () => {
    const stub = apiStub(sourceDetail([measure('m1', 'Leaf')]));
    const store = new DashboardStore(stub.api);
    await store.open(1);
    stub.getDashboard.mockResolvedValueOnce(
      structuredClone({ ...detailFor(2), layout: layoutWith() }),
    );

    await store.copyChartToDashboard(2, chartCiting('model-measure'), 1);

    const body = stub.updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    expect(body.layout.measures ?? []).toHaveLength(0);
  });

  it('reuses an identical definition already on the target instead of duplicating it', async () => {
    const shared = measure('m1', 'Leaf');
    const stub = apiStub(sourceDetail([shared]));
    const store = new DashboardStore(stub.api);
    await store.open(1);
    stub.getDashboard.mockResolvedValueOnce(
      structuredClone({ ...detailFor(2), layout: layoutWith({ measures: [shared] }) }),
    );

    await store.copyChartToDashboard(2, chartCiting('m1'), 1);

    const body = stub.updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    expect(body.layout.measures).toHaveLength(1);
    expect(body.layout.pages![0]!.tiles[0]!.chart!.query.measures[0]!.measureId).toBe('m1');
  });

  it('mints a new id on an id collision and re-points the copied chart', async () => {
    const carried = measure('m1', 'Source Leaf', 'total');
    const targetsOwn = measure('m1', 'Target Leaf', 'quantity');
    const stub = apiStub(sourceDetail([carried]));
    const store = new DashboardStore(stub.api);
    await store.open(1);
    stub.getDashboard.mockResolvedValueOnce(
      structuredClone({ ...detailFor(2), layout: layoutWith({ measures: [targetsOwn] }) }),
    );

    await store.copyChartToDashboard(2, chartCiting('m1'), 1);

    const body = stub.updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    expect(body.layout.measures).toHaveLength(2);
    // The target's own measure is untouched — its charts still depend on it.
    expect(body.layout.measures![0]).toEqual(targetsOwn);
    const minted = body.layout.measures![1]!;
    expect(minted.id).not.toBe('m1');
    expect(body.layout.pages![0]!.tiles[0]!.chart!.query.measures[0]!.measureId).toBe(minted.id);
  });

  it('dedupes a colliding NAME and rewrites the carried formula that referenced it', async () => {
    const carriedLeaf = measure('src-leaf', 'Leaf', 'total');
    const carriedTop = calcMeasure('src-top', 'Top', '[Leaf] + 1');
    const targetsLeaf = measure('tgt-leaf', 'Leaf', 'quantity');
    const stub = apiStub(sourceDetail([carriedLeaf, carriedTop]));
    const store = new DashboardStore(stub.api);
    await store.open(1);
    stub.getDashboard.mockResolvedValueOnce(
      structuredClone({ ...detailFor(2), layout: layoutWith({ measures: [targetsLeaf] }) }),
    );

    await store.copyChartToDashboard(2, chartCiting('src-top'), 1);

    const body = stub.updateDashboard.mock.calls[0]![1] as SaveDashboardBody;
    const names = body.layout.measures!.map((m) => m.name);
    expect(names).toEqual(['Leaf', 'Leaf (copy)', 'Top']);
    // The copied formula follows the rename — otherwise it would silently
    // start computing the TARGET's "Leaf".
    expect(body.layout.measures!.find((m) => m.name === 'Top')!.expression).toBe(
      '[Leaf (copy)] + 1',
    );
  });

  it('the cross-dashboard CLIPBOARD carries definitions too', async () => {
    const leaf = measure('m1', 'Leaf');
    const top = calcMeasure('m2', 'Top', '[Leaf] + 1');
    const { store } = await openStore(sourceDetail([leaf, top]));

    store.copyChart(chartCiting('m2'), 1);
    const clipboard = store.store.getState().chartClipboard!;
    expect(clipboard.definitions.map((m) => m.id)).toEqual(['m1', 'm2']);

    // Paste onto a DIFFERENT dashboard whose own "Leaf" means something else.
    const targetsLeaf = measure('m1', 'Leaf', 'quantity');
    const targetStub = apiStub(detailFor(2, { layout: layoutWith({ measures: [targetsLeaf] }) }));
    const target = new DashboardStore(targetStub.api);
    await target.open(2);
    target.store.setState({ chartClipboard: clipboard });

    target.enterEdit();
    target.pasteChartTile();

    const measures = target.store.getState().current!.layout.measures!;
    expect(measures.map((m) => m.name)).toEqual(['Leaf', 'Leaf (copy)', 'Top']);
    const tile = target.store.getState().current!.layout.pages![0]!.tiles[0]!;
    const pastedId = tile.chart!.query.measures[0]!.measureId;
    expect(measures.find((m) => m.id === pastedId)!.name).toBe('Top');
  });
});

/**
 * THE PROMOTION RULE: a chart saved into a dashboard may not reference a
 * PERSONAL measure — nobody else could resolve it, the background context a
 * scheduled send runs in could not, and an alert would depend on a private
 * document forever.
 */
describe('personal measure promotion', () => {
  const personal: Measure = {
    id: 'p1',
    name: 'My Revenue',
    table: 'public.orders',
    aggregation: 'sum',
    column: 'total',
  };

  const chartCitingPersonal = (): ChartSpec => ({
    id: 'chart-1',
    type: 'column',
    title: 'Personal',
    query: { measures: [{ measureId: 'p1' }], filters: [] },
    format: {},
  });

  it('addTile promotes a cited personal measure into the dashboard scope', async () => {
    const { store } = await openStore();
    store.setPersonalMeasures([personal]);
    store.enterEdit();

    store.addTile(chartCitingPersonal());

    const layout = store.store.getState().current!.layout;
    expect(layout.measures!.map((m) => m.id)).toEqual(['p1']);
    // COPIES: the personal original stays, so the scratchpad keeps working.
    expect(store.store.getState().personalMeasures).toEqual([personal]);
    // Same id and name, so the chart itself needs no rewrite.
    expect(layout.pages![0]!.tiles[0]!.chart!.query.measures[0]!.measureId).toBe('p1');
  });

  it('promotion and the tile are ONE undo step', async () => {
    const { store } = await openStore();
    store.setPersonalMeasures([personal]);
    store.enterEdit();

    store.addTile(chartCitingPersonal());
    store.undo();

    const layout = store.store.getState().current!.layout;
    expect(layout.pages![0]!.tiles).toHaveLength(0);
    expect(layout.measures ?? []).toHaveLength(0);
  });

  it('does nothing when the chart cites no personal measure', async () => {
    const { store } = await openStore();
    store.setPersonalMeasures([personal]);
    store.enterEdit();

    store.addTile(chartFor('Model measures only'));

    expect(store.store.getState().current!.layout.measures ?? []).toHaveLength(0);
  });

  it('personal measures survive close(): they belong to the user, not the dashboard', async () => {
    const { store } = await openStore();
    store.setPersonalMeasures([personal]);
    store.close();
    expect(store.store.getState().personalMeasures).toEqual([personal]);
  });

  /**
   * A personal measure names one MODEL's tables, so the persister has to know
   * which model it belongs to. Without this the settings document held one
   * undifferentiated pile that followed the user onto models where those
   * tables do not exist.
   */
  it('persists a personal measure under the OPEN DASHBOARD’S MODEL', async () => {
    const persist = vi.fn();
    const stub = apiStub(detailFor(1, { modelId: 7 }));
    const store = new DashboardStore(stub.api, { onPersistPersonalMeasures: persist });
    await store.open(1);

    store.setPersonalMeasures([personal]);

    expect(persist).toHaveBeenCalledWith([personal], 7);
  });

  it('files them under the "no model" bucket when the dashboard has not picked one', async () => {
    const persist = vi.fn();
    const stub = apiStub(detailFor(1, { modelId: null }));
    const store = new DashboardStore(stub.api, { onPersistPersonalMeasures: persist });
    await store.open(1);

    store.setPersonalMeasures([personal]);

    expect(persist).toHaveBeenCalledWith([personal], null);
  });

  it('promoteMeasureToModel appends the measure — and its dependencies — to the model', async () => {
    const leaf: Measure = {
      id: 'd1',
      name: 'Leaf',
      table: 'public.orders',
      aggregation: 'sum',
      column: 'total',
    };
    const top: Measure = {
      id: 'd2',
      name: 'Top',
      table: 'public.orders',
      aggregation: 'sum',
      expression: '[Leaf] + 1',
    };
    const stub = apiStub(detailFor(1, { layout: layoutWith({ measures: [leaf, top] }) }));
    const store = new DashboardStore(stub.api);
    await store.open(1);

    const promoted = await store.promoteMeasureToModel('d2');

    expect(promoted!.name).toBe('Top');
    const [modelId, body] = stub.updateModel.mock.calls[0]! as [number, { definition: { measures: Measure[] } }];
    expect(modelId).toBe(1);
    // A calculated measure is worthless in the model without what it names.
    expect(body.definition.measures.map((m) => m.name)).toEqual(['Leaf', 'Top']);
    // The dashboard copy stays: other dashboard formulas still name it.
    expect(store.store.getState().current!.layout.measures).toHaveLength(2);
  });

  it('promoteMeasureToModel surfaces a server refusal (a system model is read-only)', async () => {
    const dashboardMeasure: Measure = {
      id: 'd1',
      name: 'Leaf',
      table: 'public.orders',
      aggregation: 'sum',
      column: 'total',
    };
    const stub = apiStub(detailFor(1, { layout: layoutWith({ measures: [dashboardMeasure] }) }));
    const store = new DashboardStore(stub.api);
    await store.open(1);
    stub.updateModel.mockRejectedValueOnce(
      new RcdApiError('403 Forbidden', 403, 'rcd.model.system_readonly'),
    );

    await expect(store.promoteMeasureToModel('d1')).rejects.toBeInstanceOf(RcdApiError);
    expect(store.store.getState().error).not.toBeNull();
  });
});

/**
 * W3 — dashboard-scope measure CRUD. The promotion actions could ADD a measure
 * to a dashboard; nothing could edit or remove one, so the manager had no way
 * to be a manager. These go through the ordinary doc seam, which is what buys
 * them history, dirty-tracking and (in a live session) per-element ops.
 */
describe('dashboard-scope measure CRUD', () => {
  const seed = (): Measure => ({
    id: 'd1',
    name: 'Revenue',
    table: 'public.orders',
    aggregation: 'sum',
    column: 'total',
  });

  const openWithMeasure = async () => {
    const detail = detailFor(1, { layout: layoutWith({ measures: [seed()] }) });
    return openStore(detail);
  };

  it('addDashboardMeasure appends with a fresh id and dirties the dashboard', async () => {
    const { store } = await openStore();
    store.enterEdit();

    const added = store.addDashboardMeasure({
      name: 'Units',
      table: 'public.orders',
      aggregation: 'sum',
      column: 'quantity',
    });

    expect(added).not.toBeNull();
    expect(added!.id).toMatch(/.+/);
    expect(store.dashboardMeasures.map((m) => m.name)).toEqual(['Units']);
    expect(store.store.getState().dirty).toBe(true);
  });

  it('addDashboardMeasure is a no-op with no dashboard open', () => {
    const stub = apiStub(detailFor(1));
    const store = new DashboardStore(stub.api);
    expect(
      store.addDashboardMeasure({ name: 'X', table: 'public.orders', aggregation: 'count' }),
    ).toBeNull();
  });

  it('updateDashboardMeasure patches in place and never lets the id change', async () => {
    const { store } = await openWithMeasure();
    store.enterEdit();

    store.updateDashboardMeasure('d1', {
      name: 'Net revenue',
      expression: '[Revenue] * 0.9',
      column: null,
    } as Partial<Measure>);

    const [updated] = store.dashboardMeasures;
    expect(updated!.id).toBe('d1');
    expect(updated!.name).toBe('Net revenue');
    expect(updated!.expression).toBe('[Revenue] * 0.9');
  });

  it('updateDashboardMeasure ignores an unknown id (no phantom row, no dirty)', async () => {
    const { store } = await openWithMeasure();
    store.updateDashboardMeasure('nope', { name: 'Ghost' });
    expect(store.dashboardMeasures.map((m) => m.name)).toEqual(['Revenue']);
    expect(store.store.getState().dirty).toBe(false);
  });

  it('removeDashboardMeasure drops it, and undo brings it back (one doc seam)', async () => {
    const { store } = await openWithMeasure();
    store.enterEdit();

    store.removeDashboardMeasure('d1');
    expect(store.dashboardMeasures).toHaveLength(0);

    store.undo();
    expect(store.dashboardMeasures.map((m) => m.id)).toEqual(['d1']);
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
    // A3 (0.14.1): no minW/minH seeded — the grid owns the floor.
    expect(tile.layout).toEqual({ x: 0, y: 0, w: 4, h: 2 });
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
