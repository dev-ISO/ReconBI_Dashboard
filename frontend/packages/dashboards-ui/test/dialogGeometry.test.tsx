// @vitest-environment jsdom
/**
 * FIRST coverage of RcdDialog's drag/resize geometry (0.14.1 owner batch, B1).
 * Nothing pinned this surface before — not the drag, not the resize, not the
 * remembered geometry — which is how three defects lived in it at once.
 *
 * Pinned here:
 *  - a geometryKey dialog PERSISTS position and size (localStorage, validated
 *    on read) and restores them under a DIFFERENT title, because "Add chart"
 *    and "Edit chart" are the same panel;
 *  - a dragged-but-never-resized dialog is clamped against the panel's REAL
 *    width, not DIALOG_MIN_W — the bug that let a restored dialog sit
 *    off-screen, and that stops self-healing once geometry is persisted;
 *  - corrupt storage is rejected outright (a {x: "nope"} must never reach
 *    clamp(), where NaN propagates and positions the panel into the void);
 *  - dialogs WITHOUT a geometryKey still behave exactly as before: session
 *    memory only, nothing written to storage;
 *  - opening a key with no memory RESETS the panel instead of inheriting the
 *    previous key's geometry through React state (RcdDialog stays mounted
 *    across opens).
 *
 * Each case uses its OWN geometry key/title: the session cache is module-level
 * by design, so shared keys would leak between cases.
 */
import { act, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RcdDialog } from '../src/primitives';

const STORAGE_KEY = 'rcd.dialog.geometry';

/** The panel rect jsdom cannot compute (it lays nothing out). */
let rect = { left: 100, top: 50, width: 600, height: 500 };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  rect = { left: 100, top: 50, width: 600, height: 500 };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (children: ReactNode) => act(() => root.render(children));

const panel = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!;
const titleBar = (): HTMLElement => panel().firstElementChild as HTMLElement;
const resizeHandle = (): HTMLElement => panel().querySelector<HTMLElement>('.cursor-nwse-resize')!;

/**
 * React dispatches by event TYPE, so a bubbling MouseEvent named 'pointerdown'
 * reaches onPointerDown — jsdom implements neither PointerEvent nor pointer
 * capture, both of which the handlers use.
 */
const pointer = (target: Element, type: string, x: number, y: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  });

const drag = async (from: [number, number], to: [number, number]) => {
  const bar = titleBar();
  await pointer(bar, 'pointerdown', from[0], from[1]);
  await pointer(bar, 'pointermove', to[0], to[1]);
  await pointer(bar, 'pointerup', to[0], to[1]);
};

const stored = (): Record<string, { x?: number; y?: number; w?: number; h?: number }> =>
  JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => rect,
      };
    },
  });
  // jsdom has no pointer capture at all.
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', {
    configurable: true,
    value: () => {},
  });
});

describe('RcdDialog geometry', () => {
  it('persists a drag and restores it under a different title (one key, both modes)', async () => {
    await render(
      <RcdDialog title="Add chart" open onClose={() => {}} draggable resizable geometryKey="k-share">
        <p>body</p>
      </RcdDialog>,
    );

    // Grab at (150,60) — 50/10 inside the panel at (100,50) — and drop at (200,120).
    await drag([150, 60], [200, 120]);

    expect(stored()['k-share']).toEqual({ x: 150, y: 110 });

    // Reopened as the OTHER title: same panel, same geometry.
    await render(<div />);
    await render(
      <RcdDialog title="Edit chart" open onClose={() => {}} draggable resizable geometryKey="k-share">
        <p>body</p>
      </RcdDialog>,
    );

    expect(panel().style.left).toBe('150px');
    expect(panel().style.top).toBe('110px');
  });

  it('persists a resize', async () => {
    await render(
      <RcdDialog title="Add chart" open onClose={() => {}} draggable resizable geometryKey="k-resize">
        <p>body</p>
      </RcdDialog>,
    );

    const handle = resizeHandle();
    await pointer(handle, 'pointerdown', 700, 550);
    await pointer(handle, 'pointermove', 800, 600);
    await pointer(handle, 'pointerup', 800, 600);

    // 600x500 grown by (100, 50), inside the min/max clamps.
    expect(stored()['k-resize']).toEqual({ x: 100, y: 50, w: 700, h: 550 });

    await render(<div />);
    await render(
      <RcdDialog title="Edit chart" open onClose={() => {}} draggable resizable geometryKey="k-resize">
        <p>body</p>
      </RcdDialog>,
    );
    expect(panel().style.width).toBe('700px');
    expect(panel().style.height).toBe('550px');
  });

  it('clamps a stored position against the REAL panel width, not DIALOG_MIN_W', async () => {
    // Dragged but never resized (no w/h stored) and far off-screen.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'k-clamp': { x: 5000, y: 5000 } }));
    rect = { left: 0, top: 0, width: 896, height: 600 }; // a `wide` panel: 56rem

    await render(
      <RcdDialog title="Add chart" open onClose={() => {}} wide draggable resizable geometryKey="k-clamp">
        <p>body</p>
      </RcdDialog>,
    );

    expect(panel().style.left).toBe(`${window.innerWidth - 896}px`);
    expect(panel().style.top).toBe(`${window.innerHeight - 600}px`);
    // The old clamp used the 480x360 minimums and left the panel half off-screen.
    expect(panel().style.left).not.toBe(`${window.innerWidth - 480}px`);
  });

  it.each([
    ['a non-numeric field', JSON.stringify({ 'k-bad': { x: 'nope', y: 10 } })],
    ['a null field', JSON.stringify({ 'k-bad': { x: null, y: null, w: null, h: null } })],
    ['an absurd field', JSON.stringify({ 'k-bad': { x: 1e12, y: 1e12 } })],
    ['a zero size', JSON.stringify({ 'k-bad': { w: 0, h: 0 } })],
    ['garbage', 'not json at all'],
  ])('ignores corrupted stored geometry: %s', async (_label, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);

    await render(
      <RcdDialog title="Add chart" open onClose={() => {}} draggable resizable geometryKey="k-bad">
        <p>body</p>
      </RcdDialog>,
    );

    // Nothing positioned or sized: the panel keeps its class-driven centering.
    expect(panel().style.left).toBe('');
    expect(panel().style.top).toBe('');
    expect(panel().style.width).toBe('');
    expect(panel().style.height).toBe('');
  });

  it('never persists for a dialog without a geometryKey (session memory only)', async () => {
    await render(
      <RcdDialog title="Opt out" open onClose={() => {}} draggable resizable>
        <p>body</p>
      </RcdDialog>,
    );

    await drag([150, 60], [200, 120]);

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // …but the session still remembers it, exactly as before this change.
    await render(<div />);
    await render(
      <RcdDialog title="Opt out" open onClose={() => {}} draggable resizable>
        <p>body</p>
      </RcdDialog>,
    );
    expect(panel().style.left).toBe('150px');
  });

  it('resets instead of inheriting geometry when the new key has no memory', async () => {
    // ONE mounted instance, reused across opens (open={builder !== null}) —
    // the state that used to leak from one title to the other.
    const dialog = (title: string, open: boolean) => (
      <RcdDialog title={title} open={open} onClose={() => {}} draggable resizable>
        <p>body</p>
      </RcdDialog>
    );

    await render(dialog('Leak A', true));
    await drag([150, 60], [200, 120]);
    expect(panel().style.left).toBe('150px');

    await render(dialog('Leak A', false));
    await render(dialog('Leak B', true));

    expect(panel().style.left).toBe('');
    expect(panel().style.top).toBe('');
  });
});
