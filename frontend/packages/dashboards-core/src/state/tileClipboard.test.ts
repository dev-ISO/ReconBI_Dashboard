/**
 * COPY / PASTE OF ANY DASHBOARD ELEMENT.
 *
 * The requirement is one sentence — "it's a new element once pasted that has
 * the same settings until edited" — and every test here is a way of failing it.
 *
 * A copy that shares ANY identity with its source is the bug that surfaces
 * later as "editing this one changed that one", or as a field that quietly
 * refuses an edit because two elements answer to the same name. So identity is
 * checked at EVERY level a dashboard element owns one: the tile, the chart
 * inside it, and — the one a plain structuredClone gets wrong — the ids of a
 * button group's individual buttons, which are what the group editor patches,
 * expands, reorders and removes by.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartSpec } from '../types/chart';
import type { DashboardDetail, DashboardTile } from '../types/dashboard';
import { cloneTileForCopy, DashboardStore } from './dashboardStore';

const detailFor = (id: number, tiles: DashboardTile[] = []): DashboardDetail => ({
  id,
  name: `Dash ${id}`,
  description: null,
  modelId: 1,
  isShared: false,
  ownerIsMe: true,
  createdAtUtc: '2026-01-01T00:00:00Z',
  updatedAtUtc: 'stamp-1',
  layout: { version: 1, tiles: [], slicers: [], pages: [{ id: 'p1', name: 'Page 1', tiles }] },
});

const openStore = async (detail: DashboardDetail): Promise<DashboardStore> => {
  const api = {
    getDashboard: vi.fn(async () => structuredClone(detail)),
    updateDashboard: vi.fn(async () => structuredClone(detail)),
    listDashboards: vi.fn(async () => []),
    getModel: vi.fn(async (id: number) => ({
      id,
      name: 'Demo model',
      description: null,
      dataSourceName: 'demo',
      isShared: true,
      ownerIsMe: true,
      createdAtUtc: '2026-01-01T00:00:00Z',
      updatedAtUtc: 'model-stamp-1',
      definition: { version: 1, tables: [], relationships: [], measures: [] },
    })),
  } as unknown as DashboardsApi;
  const store = new DashboardStore(api);
  await store.open(detail.id);
  return store;
};

const tilesOf = (store: DashboardStore): DashboardTile[] =>
  store.store.getState().current!.layout.pages![0]!.tiles;

const chartFor = (): ChartSpec => ({
  id: 'chart-1',
  type: 'column',
  title: 'Orders',
  query: { measures: [{ measureId: 'm1' }], filters: [] },
  format: {},
});

const groupTile = (): DashboardTile => ({
  id: 'tile-group',
  layout: { x: 0, y: 0, w: 6, h: 3 },
  kind: 'buttonGroup',
  buttonGroup: {
    buttons: [
      { id: 'btn-a', html: '<p>One</p>', targetPageId: 'p1' },
      { id: 'btn-b', html: '<p>Two</p>', targetPageId: 'p1' },
    ],
    direction: 'row',
    wrap: true,
    gap: 8,
    align: 'stretch',
  },
});

const textTile = (): DashboardTile => ({
  id: 'tile-text',
  layout: { x: 0, y: 0, w: 4, h: 2 },
  kind: 'text',
  text: { html: '<p>Hello</p>', title: 'Notes', align: 'center' },
});

describe('cloneTileForCopy gives the copy its own identity', () => {
  it('re-mints the tile id and carries the settings verbatim', () => {
    const copy = cloneTileForCopy(textTile());
    expect(copy.id).not.toBe('tile-text');
    expect(copy.text).toEqual(textTile().text);
  });

  it('re-mints BUTTON GROUP CHILD ids — the ones the editor patches by', () => {
    const copy = cloneTileForCopy(groupTile());
    const ids = copy.buttonGroup!.buttons.map((b) => b.id);
    expect(ids).not.toContain('btn-a');
    expect(ids).not.toContain('btn-b');
    expect(new Set(ids).size).toBe(2);
    // Everything that is not identity rides through untouched.
    expect(copy.buttonGroup!.buttons.map((b) => b.html)).toEqual(['<p>One</p>', '<p>Two</p>']);
    expect(copy.buttonGroup!.direction).toBe('row');
  });

  it('re-mints the chart id', () => {
    const copy = cloneTileForCopy({
      id: 'tile-chart',
      layout: { x: 0, y: 0, w: 6, h: 4 },
      chart: chartFor(),
    });
    expect(copy.id).not.toBe('tile-chart');
    expect(copy.chart!.id).not.toBe('chart-1');
  });

  it('shares NO object with its source — editing the copy cannot move the original', () => {
    const source = groupTile();
    const copy = cloneTileForCopy(source);
    copy.buttonGroup!.buttons[0]!.html = '<p>Edited</p>';
    copy.buttonGroup!.direction = 'column';
    copy.layout.w = 99;
    expect(source.buttonGroup!.buttons[0]!.html).toBe('<p>One</p>');
    expect(source.buttonGroup!.direction).toBe('row');
    expect(source.layout.w).toBe(6);
  });

  it('carries the other kinds, and suffixes only what has a name', () => {
    const image = cloneTileForCopy({
      id: 't',
      layout: { x: 0, y: 0, w: 2, h: 2 },
      kind: 'image',
      image: { src: 'https://x/y.png', fit: 'contain', alt: 'A' },
    });
    expect(image.image).toEqual({ src: 'https://x/y.png', fit: 'contain', alt: 'A' });

    const button = cloneTileForCopy({
      id: 't',
      layout: { x: 0, y: 0, w: 2, h: 1 },
      kind: 'button',
      button: { html: '<p>Go</p>', targetPageId: 'p2' },
    });
    expect(button.button).toEqual({ html: '<p>Go</p>', targetPageId: 'p2' });

    const slicer = cloneTileForCopy(
      {
        id: 't',
        layout: { x: 0, y: 0, w: 3, h: 2 },
        kind: 'slicer',
        slicer: { table: 't', column: 'c', label: 'Region', variant: 'checklist' },
      },
      { suffix: true },
    );
    expect(slicer.slicer!.label).toBe('Region (copy)');
  });
});

describe('copyTile / pasteTile', () => {
  it('pastes a NEW element with the same settings', async () => {
    const store = await openStore(detailFor(1, [textTile()]));
    store.enterEdit();
    store.copyTile('tile-text');
    const pastedId = store.pasteTile();

    const tiles = tilesOf(store);
    expect(tiles).toHaveLength(2);
    const pasted = tiles.find((t) => t.id === pastedId)!;
    expect(pasted.id).not.toBe('tile-text');
    expect(pasted.text).toEqual(textTile().text);
    expect(tiles.find((t) => t.id === 'tile-text')!.text!.html).toBe('<p>Hello</p>');
  });

  it('a pasted button group is independently editable', async () => {
    const store = await openStore(detailFor(1, [groupTile()]));
    store.enterEdit();
    store.copyTile('tile-group');
    const pastedId = store.pasteTile()!;

    const source = tilesOf(store).find((t) => t.id === 'tile-group')!;
    const pasted = tilesOf(store).find((t) => t.id === pastedId)!;
    const sourceIds = source.buttonGroup!.buttons.map((b) => b.id);
    const pastedIds = pasted.buttonGroup!.buttons.map((b) => b.id);
    expect(sourceIds.some((id) => pastedIds.includes(id))).toBe(false);

    // A real edit through the store reaches only the pasted element.
    store.updateButtonGroupTile(pastedId, { direction: 'column' });
    expect(tilesOf(store).find((t) => t.id === pastedId)!.buttonGroup!.direction).toBe('column');
    expect(tilesOf(store).find((t) => t.id === 'tile-group')!.buttonGroup!.direction).toBe('row');
  });

  it('pastes repeatedly, each one a distinct element', async () => {
    const store = await openStore(detailFor(1, [groupTile()]));
    store.enterEdit();
    store.copyTile('tile-group');
    const first = store.pasteTile()!;
    const second = store.pasteTile()!;
    expect(first).not.toBe(second);

    const childIds = tilesOf(store).flatMap((t) => t.buttonGroup?.buttons.map((b) => b.id) ?? []);
    expect(new Set(childIds).size).toBe(childIds.length);
  });

  it('lands below everything, so a paste never covers an existing tile', async () => {
    const tall: DashboardTile = { ...textTile(), layout: { x: 0, y: 0, w: 4, h: 5 } };
    const store = await openStore(detailFor(1, [tall]));
    store.enterEdit();
    store.copyTile('tile-text');
    const pastedId = store.pasteTile()!;
    expect(tilesOf(store).find((t) => t.id === pastedId)!.layout.y).toBe(5);
  });

  it('is a no-op in view mode', async () => {
    const store = await openStore(detailFor(1, [textTile()]));
    store.copyTile('tile-text');
    expect(store.pasteTile()).toBeNull();
    expect(tilesOf(store)).toHaveLength(1);
  });

  it('is a no-op with an empty clipboard', async () => {
    const store = await openStore(detailFor(1, [textTile()]));
    store.enterEdit();
    expect(store.pasteTile()).toBeNull();
    expect(tilesOf(store)).toHaveLength(1);
  });

  it('undoes as ONE step, leaving no orphan behind', async () => {
    const store = await openStore(detailFor(1, [groupTile()]));
    store.enterEdit();
    store.copyTile('tile-group');
    store.pasteTile();
    expect(tilesOf(store)).toHaveLength(2);
    store.undo();
    expect(tilesOf(store)).toHaveLength(1);
  });
});

describe('cross-dashboard paste repairs what cannot resolve', () => {
  const slicerTile = (targets: string[]): DashboardTile => ({
    id: 'tile-slicer',
    layout: { x: 0, y: 0, w: 3, h: 2 },
    kind: 'slicer',
    slicer: { table: 't', column: 'c', label: 'Region', variant: 'checklist', targets },
  });

  it('keeps a target that really is on the destination page', async () => {
    const store = await openStore(
      detailFor(1, [
        { id: 'chart-tile-x', layout: { x: 0, y: 0, w: 6, h: 4 }, chart: chartFor() },
        slicerTile(['chart-tile-x']),
      ]),
    );
    store.enterEdit();
    store.copyTile('tile-slicer');
    const pastedId = store.pasteTile()!;
    expect(tilesOf(store).find((t) => t.id === pastedId)!.slicer!.targets).toEqual(['chart-tile-x']);
  });

  it('drops a target that names no tile at all, even in the same dashboard', async () => {
    // The test is "does this resolve where the slicer will live", not "did the
    // dashboard change" — a target naming nothing can never filter anything.
    const store = await openStore(detailFor(1, [slicerTile(['chart-that-is-gone'])]));
    store.enterEdit();
    store.copyTile('tile-slicer');
    const pastedId = store.pasteTile()!;
    expect(tilesOf(store).find((t) => t.id === pastedId)!.slicer!.targets).toBeNull();
  });

  it('drops targets that resolve to nothing in ANOTHER dashboard', async () => {
    const source = await openStore(detailFor(1, [slicerTile(['chart-tile-x'])]));
    source.enterEdit();
    source.copyTile('tile-slicer');
    const clip = source.store.getState().tileClipboard!;

    // Targets naming charts that do not exist here would make the slicer
    // filter NOTHING while looking perfectly healthy — the worst failure
    // shape. It falls back to its documented "all charts" default instead.
    const other = await openStore(detailFor(2));
    other.enterEdit();
    other.store.setState({ tileClipboard: clip });
    const pastedId = other.pasteTile()!;
    expect(tilesOf(other).find((t) => t.id === pastedId)!.slicer!.targets).toBeNull();
  });

  it('leaves a button target page alone — a dead link is badged, not invented', async () => {
    const source = await openStore(
      detailFor(1, [
        {
          id: 'tile-button',
          layout: { x: 0, y: 0, w: 2, h: 1 },
          kind: 'button',
          button: { html: '<p>Go</p>', targetPageId: 'page-of-dash-1' },
        },
      ]),
    );
    source.enterEdit();
    source.copyTile('tile-button');
    const clip = source.store.getState().tileClipboard!;

    const other = await openStore(detailFor(2));
    other.enterEdit();
    other.store.setState({ tileClipboard: clip });
    const pastedId = other.pasteTile()!;
    // Silently re-pointing it at some other page would invent an intent the
    // author never expressed; edit mode badges the dead target instead.
    expect(tilesOf(other).find((t) => t.id === pastedId)!.button!.targetPageId).toBe(
      'page-of-dash-1',
    );
  });
});

describe('copy and paste ACROSS PAGES', () => {
  const twoPages = (page1: DashboardTile[], page2: DashboardTile[] = []): DashboardDetail => ({
    ...detailFor(1),
    layout: {
      version: 1,
      tiles: [],
      slicers: [],
      pages: [
        { id: 'p1', name: 'Page 1', tiles: page1 },
        { id: 'p2', name: 'Page 2', tiles: page2 },
      ],
    },
  });

  const pageTiles = (store: DashboardStore, index: number): DashboardTile[] =>
    store.store.getState().current!.layout.pages![index]!.tiles;

  it('pastes onto whichever page is active, leaving the source page alone', async () => {
    const store = await openStore(twoPages([textTile()]));
    store.enterEdit();
    store.copyTile('tile-text');
    store.setActivePage('p2');
    const pastedId = store.pasteTile()!;

    expect(pageTiles(store, 0)).toHaveLength(1);
    expect(pageTiles(store, 1)).toHaveLength(1);
    expect(pageTiles(store, 1)[0]!.id).toBe(pastedId);
    expect(pageTiles(store, 1)[0]!.text).toEqual(textTile().text);
  });

  it('the clipboard survives the page switch that clears the selection', async () => {
    const store = await openStore(twoPages([groupTile()]));
    store.enterEdit();
    store.copyTile('tile-group');
    store.setActivePage('p2');
    // setActivePage deliberately drops selectedTileId; the clipboard is not
    // selection and must outlive it, or copy-here-paste-there is impossible.
    expect(store.store.getState().selectedTileId).toBeNull();
    expect(store.store.getState().tileClipboard).not.toBeNull();
    expect(store.pasteTile()).not.toBeNull();
  });

  it('a pasted button keeps its target page — pages are dashboard-wide', async () => {
    const store = await openStore(
      twoPages([
        {
          id: 'tile-button',
          layout: { x: 0, y: 0, w: 2, h: 1 },
          kind: 'button',
          button: { html: '<p>To page 2</p>', targetPageId: 'p2' },
        },
      ]),
    );
    store.enterEdit();
    store.copyTile('tile-button');
    store.setActivePage('p2');
    const pastedId = store.pasteTile()!;
    expect(pageTiles(store, 1)[0]!.id).toBe(pastedId);
    expect(pageTiles(store, 1)[0]!.button!.targetPageId).toBe('p2');
  });

  it('a slicer pasted onto ANOTHER page drops targets it can never reach', async () => {
    // Slicers are PAGE-SCOPED: filtersForTile only consults slicers on the
    // tile's own page. Carrying page-1 chart ids onto page 2 would leave a
    // slicer that filters NOTHING while looking perfectly healthy.
    const store = await openStore(
      twoPages([
        { id: 'chart-a', layout: { x: 0, y: 0, w: 6, h: 4 }, chart: chartFor() },
        {
          id: 'tile-slicer',
          layout: { x: 0, y: 4, w: 3, h: 2 },
          kind: 'slicer',
          slicer: {
            table: 't',
            column: 'c',
            label: 'Region',
            variant: 'checklist',
            targets: ['chart-a'],
          },
        },
      ]),
    );
    store.enterEdit();
    store.copyTile('tile-slicer');

    // Same page: the target is right there, so the rule is untouched.
    const samePage = store.pasteTile()!;
    expect(pageTiles(store, 0).find((t) => t.id === samePage)!.slicer!.targets).toEqual([
      'chart-a',
    ]);

    // Other page: nothing it names exists here, so it falls back to "all charts".
    store.setActivePage('p2');
    const otherPage = store.pasteTile()!;
    expect(pageTiles(store, 1).find((t) => t.id === otherPage)!.slicer!.targets).toBeNull();
  });

  it('keeps the targets that DO exist on the destination page', async () => {
    const store = await openStore(
      twoPages(
        [
          {
            id: 'tile-slicer',
            layout: { x: 0, y: 0, w: 3, h: 2 },
            kind: 'slicer',
            slicer: {
              table: 't',
              column: 'c',
              label: 'Region',
              variant: 'checklist',
              targets: ['chart-a', 'chart-b'],
            },
          },
        ],
        [{ id: 'chart-b', layout: { x: 0, y: 0, w: 6, h: 4 }, chart: chartFor() }],
      ),
    );
    store.enterEdit();
    store.copyTile('tile-slicer');
    store.setActivePage('p2');
    const pastedId = store.pasteTile()!;
    // chart-b is on page 2; chart-a is not on any page here. Keep the real one
    // rather than collapsing to "all charts" and widening what it filters.
    expect(pageTiles(store, 1).find((t) => t.id === pastedId)!.slicer!.targets).toEqual([
      'chart-b',
    ]);
  });
});
