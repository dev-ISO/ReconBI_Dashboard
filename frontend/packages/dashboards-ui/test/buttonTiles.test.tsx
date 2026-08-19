// @vitest-environment jsdom
/**
 * BUTTONS wave UI behavior:
 *  - B5 click-vs-drag: a left-click on a button navigates in EDIT mode; the
 *    click that concludes a grid drag is suppressed; right-click opens the
 *    tile config card, never navigation. Group buttons behave identically.
 *  - B4 per-kind minimum sizes on the grid's layout-item mapping.
 *  - B1/B2 ButtonVisual: custom colors + sanitized customCss render, blocked
 *    declarations never reach the element.
 *  - B3 group dialog: add / duplicate / remove / reorder round-trip through
 *    onSave.
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ButtonGroupTileSpec,
  ButtonTileSpec,
  DashboardsRuntime,
  RcdFetcher,
} from '@recon/dashboards-core';
import { DashboardsProvider, useRuntime } from '../src/provider/DashboardsProvider';
import { ButtonTile } from '../src/dashboard/ButtonTile';
import { ButtonGroupTile } from '../src/dashboard/ButtonGroupTile';
import { ButtonGroupTileDialog } from '../src/dashboard/ButtonGroupTileDialog';
import { ButtonVisual } from '../src/dashboard/ButtonVisual';
import {
  markGridDragEnd,
  markGridDragStart,
  withKindMinima,
} from '../src/dashboard/DashboardGrid';

const stubFetcher = (<T,>(): Promise<T> => Promise.resolve(undefined as unknown as T)) as RcdFetcher;

const PAGES = [
  { id: 'p1', name: 'Overview' },
  { id: 'p2', name: 'Detail' },
];

let host: HTMLDivElement;
let root: Root;
let runtime: DashboardsRuntime | null = null;

/** Grabs the provider-scoped runtime so tests can spy on store methods. */
function CaptureRuntime() {
  runtime = useRuntime();
  return null;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  runtime = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (children: React.ReactNode) =>
  act(() =>
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={stubFetcher}>
        <CaptureRuntime />
        {children}
      </DashboardsProvider>,
    ),
  );

const click = (el: HTMLElement) => act(() => el.click());

const rightClick = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
  });

const buttonByLabel = (label: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

/* ------------------------------------------------------------------ B5 */

describe('click vs drag vs right-click (B5)', () => {
  // Each test advances the base hour so the module-scoped drag tracker's
  // "just ended" timestamp from a previous test is always long stale.
  let base = Date.parse('2026-01-01T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    base += 3_600_000;
    vi.setSystemTime(base);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const spec: ButtonTileSpec = { html: '<p>Go</p>', targetPageId: 'p2' };

  it('left-click NAVIGATES in edit mode', () => {
    mount(<ButtonTile tileId="t1" spec={spec} editable pages={PAGES} />);
    const setActivePage = vi
      .spyOn(runtime!.dashboards, 'setActivePage')
      .mockImplementation(() => {});

    click(buttonByLabel('Go'));
    expect(setActivePage).toHaveBeenCalledTimes(1);
    expect(setActivePage).toHaveBeenCalledWith('p2');
  });

  it('the click that concludes a grid drag is suppressed; later clicks navigate again', () => {
    mount(<ButtonTile tileId="t1" spec={spec} editable pages={PAGES} />);
    const setActivePage = vi
      .spyOn(runtime!.dashboards, 'setActivePage')
      .mockImplementation(() => {});

    // Mid-drag: any click is the drag's.
    markGridDragStart();
    click(buttonByLabel('Go'));
    expect(setActivePage).not.toHaveBeenCalled();

    // The closing click lands right after RGL's dragStop — still suppressed.
    markGridDragEnd();
    click(buttonByLabel('Go'));
    expect(setActivePage).not.toHaveBeenCalled();

    // A genuine later click navigates.
    vi.advanceTimersByTime(400);
    click(buttonByLabel('Go'));
    expect(setActivePage).toHaveBeenCalledTimes(1);
  });

  it('right-click opens the config card, not navigation', () => {
    mount(<ButtonTile tileId="t1" spec={spec} editable pages={PAGES} />);
    const setActivePage = vi
      .spyOn(runtime!.dashboards, 'setActivePage')
      .mockImplementation(() => {});

    rightClick(buttonByLabel('Go'));
    expect(document.querySelector('[aria-label="Configure button tile"]')).not.toBeNull();
    expect(setActivePage).not.toHaveBeenCalled();
    // The card carries the B5 hint.
    expect(document.body.textContent).toContain('Click follows the button - right-click to edit.');
  });

  it('buttons inside a GROUP behave identically (navigate + post-drag suppression)', () => {
    const group: ButtonGroupTileSpec = {
      buttons: [
        { id: 'b1', html: '<p>Overview</p>', targetPageId: 'p1' },
        { id: 'b2', html: '<p>Detail</p>', targetPageId: 'p2' },
      ],
      direction: 'row',
      wrap: true,
      gap: 8,
      align: 'center',
    };
    mount(<ButtonGroupTile tileId="g1" spec={group} editable pages={PAGES} />);
    const setActivePage = vi
      .spyOn(runtime!.dashboards, 'setActivePage')
      .mockImplementation(() => {});

    click(buttonByLabel('Detail'));
    expect(setActivePage).toHaveBeenCalledWith('p2');

    markGridDragStart();
    markGridDragEnd();
    click(buttonByLabel('Overview'));
    expect(setActivePage).toHaveBeenCalledTimes(1); // suppressed

    vi.advanceTimersByTime(400);
    click(buttonByLabel('Overview'));
    expect(setActivePage).toHaveBeenCalledTimes(2);
    expect(setActivePage).toHaveBeenLastCalledWith('p1');

    // Group right-click: config card, not navigation.
    rightClick(buttonByLabel('Detail'));
    expect(document.querySelector('[aria-label="Configure button group tile"]')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ B4 */

describe('per-kind minimum sizes on layout items (B4)', () => {
  it('floors button tiles (stored mins AND geometry raised on render)', () => {
    expect(withKindMinima({ id: 't', kind: 'button', x: 0, y: 0, w: 2, h: 1, minW: 2, minH: 1 })).toEqual(
      { id: 't', kind: 'button', x: 0, y: 0, w: 3, h: 2, minW: 3, minH: 2 },
    );
  });

  it('floors buttonGroup tiles', () => {
    expect(withKindMinima({ id: 'g', kind: 'buttonGroup', x: 1, y: 2, w: 3, h: 1 })).toEqual({
      id: 'g',
      kind: 'buttonGroup',
      x: 1,
      y: 2,
      w: 4,
      h: 2,
      minW: 4,
      minH: 2,
    });
  });

  it('keeps LARGER stored constraints and geometry untouched', () => {
    expect(
      withKindMinima({ id: 't', kind: 'button', x: 0, y: 0, w: 6, h: 4, minW: 5, minH: 3 }),
    ).toEqual({ id: 't', kind: 'button', x: 0, y: 0, w: 6, h: 4, minW: 5, minH: 3 });
  });

  it('is identity for kinds without a floor (charts keep their own mins)', () => {
    const chart = { id: 'c', kind: 'chart', x: 0, y: 0, w: 12, h: 8, minW: 4, minH: 4 };
    expect(withKindMinima(chart)).toBe(chart);
    const untyped = { id: 'u', x: 0, y: 0, w: 1, h: 1 };
    expect(withKindMinima(untyped)).toBe(untyped);
  });
});

/* -------------------------------------------------------------- B1 + B2 */

describe('ButtonVisual custom colors + customCss (B1/B2)', () => {
  it('applies custom background/text colors and sanitized customCss; blocked declarations never land', () => {
    act(() =>
      root.render(
        <ButtonVisual
          spec={{
            html: '<p>Styled</p>',
            background: '#123456',
            textColor: '#ffffff',
            radius: 12,
            customCss:
              'background-image: linear-gradient(90deg, #ff0000, #0000ff); position: absolute; margin: 10px;',
          }}
        />,
      ),
    );
    const button = buttonByLabel('Styled');
    expect(button.style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(button.style.color).toBe('rgb(255, 255, 255)');
    expect(button.style.borderRadius).toBe('12px');
    expect(button.style.backgroundImage).toContain('linear-gradient');
    expect(button.style.position).toBe('');
    expect(button.style.margin).toBe('');
    // The rich label rides inside, sanitized.
    expect(button.innerHTML).toContain('<p>Styled</p>');
  });

  it('customCss WINS over the custom color (the full-control layer)', () => {
    act(() =>
      root.render(
        <ButtonVisual
          spec={{
            html: '<p>Override</p>',
            background: '#123456',
            customCss: 'background-color: rgb(9, 9, 9);',
          }}
        />,
      ),
    );
    expect(buttonByLabel('Override').style.backgroundColor).toBe('rgb(9, 9, 9)');
  });
});

/* ------------------------------------------------------------------ B3 */

describe('ButtonGroupTileDialog list management (B3)', () => {
  const initial: ButtonGroupTileSpec = {
    buttons: [
      { id: 'a', html: '<p>A</p>', targetPageId: 'p1' },
      { id: 'b', html: '<p>B</p>', targetPageId: 'p2' },
    ],
    direction: 'row',
    wrap: true,
    gap: 8,
    align: 'center',
    background: null,
  };

  const mountDialog = (onSave: (spec: ButtonGroupTileSpec) => void) =>
    act(() =>
      root.render(
        <ButtonGroupTileDialog
          open
          title="Edit button group"
          initial={initial}
          pages={PAGES}
          onClose={() => {}}
          onSave={onSave}
        />,
      ),
    );

  const apply = () => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const applyButton = buttons.find((b) => b.textContent === 'Apply')!;
    click(applyButton);
  };

  it('reorders with the up/down controls and saves the new order', () => {
    let saved: ButtonGroupTileSpec | null = null;
    mountDialog((spec) => {
      saved = spec;
    });

    click(buttonByLabel('Move B up'));
    apply();

    expect(saved).not.toBeNull();
    expect(saved!.buttons.map((b) => b.id)).toEqual(['b', 'a']);
    expect(saved!.buttons.map((b) => b.html)).toEqual(['<p>B</p>', '<p>A</p>']);
  });

  it('adds a button (defaulting to the first page) and keeps group settings', () => {
    let saved: ButtonGroupTileSpec | null = null;
    mountDialog((spec) => {
      saved = spec;
    });

    const addButton = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Add button',
    )!;
    click(addButton);
    apply();

    expect(saved!.buttons).toHaveLength(3);
    const added = saved!.buttons[2]!;
    expect(added.targetPageId).toBe('p1');
    expect(added.html).toBe('<p>Button</p>');
    expect(saved!).toMatchObject({ direction: 'row', wrap: true, gap: 8, align: 'center' });
  });

  it('duplicates a row under a NEW id, right after its source', () => {
    let saved: ButtonGroupTileSpec | null = null;
    mountDialog((spec) => {
      saved = spec;
    });

    click(buttonByLabel('Duplicate A'));
    apply();

    expect(saved!.buttons).toHaveLength(3);
    expect(saved!.buttons.map((b) => b.html)).toEqual(['<p>A</p>', '<p>A</p>', '<p>B</p>']);
    expect(saved!.buttons[1]!.id).not.toBe(saved!.buttons[0]!.id);
  });

  it('removes a row (and disables removal of the last one)', () => {
    let saved: ButtonGroupTileSpec | null = null;
    mountDialog((spec) => {
      saved = spec;
    });

    click(buttonByLabel('Remove A'));
    // One row left — its remove control is disabled.
    expect(buttonByLabel('Remove B').disabled).toBe(true);
    apply();

    expect(saved!.buttons.map((b) => b.id)).toEqual(['b']);
  });
});
