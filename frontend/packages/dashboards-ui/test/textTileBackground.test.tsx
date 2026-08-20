// @vitest-environment jsdom
/**
 * 0.14.1 owner batch, C1 — the dark-mode wash-out.
 *
 * A text tile paints a PERSISTED background (identical for every viewer, by
 * design) but used to leave the foreground on `text-rcd-text`, a token that
 * flips with the VIEWER's theme: white text on a pale tile in dark mode, and
 * near-black on the near-black swatch in light mode. specStyle now derives the
 * foreground from the background, so old tiles fix themselves with no schema
 * change.
 *
 * specStyle had ZERO coverage before this file (no test asserted a text tile's
 * background at all), and the swatch palette had none either.
 */
import { act, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TextTileSpec } from '@recon/dashboards-core';
import { TextTile } from '../src/dashboard/TextTile';
import { contrastingTextColor, readableTextColor, DARK_INK } from '../src/dashboard/buttonLayout';
import {
  TILE_BACKGROUNDS_DEEP,
  TILE_BACKGROUNDS_LIGHT,
} from '../src/dashboard/TileBackgroundSwatches';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (children: ReactNode) => act(() => root.render(children));

/** View mode is frameless: the rich-text body is the only element rendered. */
const body = (): HTMLElement => host.firstElementChild as HTMLElement;

const tile = (spec: Partial<TextTileSpec>) => (
  <TextTile tileId="t1" editable={false} spec={{ html: '<p>Hello</p>', ...spec }} />
);

describe('text tile background contrast', () => {
  it('puts dark ink on a pale background (the dark-mode wash-out)', async () => {
    await render(tile({ background: '#dce9f9' }));

    expect(body().style.backgroundColor).toBe('rgb(220, 233, 249)');
    expect(body().style.color).toBe('rgb(9, 9, 11)');
  });

  it('puts white on a deep background (the light-mode inverse)', async () => {
    await render(tile({ background: '#1a1a19' }));

    expect(body().style.color).toBe('rgb(255, 255, 255)');
  });

  it('leaves the theme token alone when no background is set', async () => {
    await render(tile({}));

    expect(body().style.color).toBe('');
    expect(body().style.backgroundColor).toBe('');
  });

  it('keeps alignment working alongside the derived color', async () => {
    await render(tile({ background: '#ffffff', align: 'center' }));

    expect(body().style.textAlign).toBe('center');
    expect(body().style.color).toBe('rgb(9, 9, 11)');
  });

  it('never second-guesses a color it cannot parse', () => {
    expect(contrastingTextColor('rebeccapurple')).toBeNull();
    expect(contrastingTextColor('var(--rcd-surface)')).toBeNull();
  });

  it('is the TWO-SIDED sibling of readableTextColor, sharing its switch point', () => {
    // The button helper defers to the theme on light fills (null); the tile
    // helper cannot — that deferral IS the bug it fixes.
    expect(readableTextColor('#ffffff')).toBeNull();
    expect(contrastingTextColor('#ffffff')).toBe(DARK_INK);
    // Both agree on dark fills.
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(contrastingTextColor('#000000')).toBe('#ffffff');
    expect(contrastingTextColor('#000')).toBe('#ffffff');
  });
});

describe('tile background palette', () => {
  it('pairs every light swatch with a deep counterpart', () => {
    expect(TILE_BACKGROUNDS_DEEP).toHaveLength(TILE_BACKGROUNDS_LIGHT.length);
    // The pre-0.14.1 palette (eight near-whites + one near-black) survives.
    expect(TILE_BACKGROUNDS_LIGHT).toContain('#ffffff');
    expect(TILE_BACKGROUNDS_DEEP).toContain('#1a1a19');
  });

  it('every swatch carries legible text in either theme', () => {
    for (const color of TILE_BACKGROUNDS_LIGHT) {
      expect(contrastingTextColor(color)).toBe(DARK_INK);
    }
    for (const color of TILE_BACKGROUNDS_DEEP) {
      expect(contrastingTextColor(color)).toBe('#ffffff');
    }
  });

  it('renders every swatch as a pickable button', async () => {
    // Rendered through the tile's config card in the component itself; here we
    // only assert the palette is complete and unique (a duplicate hex would
    // silently collapse two swatches onto one React key).
    const all = [...TILE_BACKGROUNDS_LIGHT, ...TILE_BACKGROUNDS_DEEP];
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
  });
});
