// @vitest-environment jsdom
/**
 * 0.14.1 button refinements (SECTION A):
 *  - A1 container: TileFrame renders in BOTH modes; an absent container keeps
 *    the legacy frameless look (no header, no card chrome), an explicit one
 *    shows the standard frame + title.
 *  - A2 placement: `justify` drives the MAIN axis (it was never set at all),
 *    `align` drives the cross axis AND wrapped-line packing.
 *  - A3 clipper: an undersized group never renders empty — button 0 always
 *    shows and the hidden remainder is announced.
 *  - A5 contrast: a dark custom fill with no textColor derives a readable one.
 *  - A6 look: the shared size scale + equal-width grid.
 *  - A7 print: button tiles render on paper, statically.
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ButtonGroupTileSpec,
  DashboardTile,
  FilterClause,
  RcdFetcher,
} from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import { ButtonGroupTile } from '../src/dashboard/ButtonGroupTile';
import { ButtonVisual } from '../src/dashboard/ButtonVisual';
import { PrintSheets } from '../src/dashboard/DashboardPrintView';
import { readableTextColor, relativeLuminance } from '../src/dashboard/buttonLayout';
import type { PrintOptions } from '../src/dashboard/PrintConfigDialog';

const stubFetcher = (<T,>(): Promise<T> => Promise.resolve(undefined as unknown as T)) as RcdFetcher;

const PAGES = [
  { id: 'p1', name: 'Overview' },
  { id: 'p2', name: 'Detail' },
];

const group = (over: Partial<ButtonGroupTileSpec> = {}): ButtonGroupTileSpec => ({
  buttons: [
    { id: 'b1', html: '<p>One</p>', targetPageId: 'p1' },
    { id: 'b2', html: '<p>Two</p>', targetPageId: 'p2' },
  ],
  direction: 'row',
  wrap: true,
  gap: 8,
  align: 'center',
  ...over,
});

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

const mount = (children: React.ReactNode) =>
  act(() =>
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={stubFetcher}>
        {children}
      </DashboardsProvider>,
    ),
  );

const buttonByLabel = (label: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

/** The flex/grid packing box (the direct parent of the group's buttons). */
const packingBox = (): HTMLElement => buttonByLabel('One').parentElement!;

/** The tile frame's card root. */
const cardRoot = (): HTMLElement => host.querySelector<HTMLElement>('.rcd-card')!;

/* ------------------------------------------------------------------- A1 */

describe('container (A1)', () => {
  it('renders the frame in VIEW mode, frameless by default, with no card chrome', () => {
    mount(<ButtonGroupTile tileId="g1" spec={group()} editable={false} pages={PAGES} />);

    // The frame is always there now (it carries the container styling)...
    const card = cardRoot();
    expect(card).not.toBeNull();
    // ...but an absent container reproduces the pre-0.14.1 look exactly:
    // no header bar, no border, no shadow, no surface fill.
    expect(document.body.textContent).not.toContain('Button group');
    expect(card.style.backgroundColor).toBe('transparent');
    expect(card.style.borderWidth).toBe('0px');
    expect(card.style.boxShadow).toBe('none');
    // ...and the body padding is cancelled so a 1-row tile still fits a button.
    expect(host.querySelector('.-m-2')).not.toBeNull();
  });

  it('an explicit container shows the standard header bar and title', () => {
    mount(
      <ButtonGroupTile
        tileId="g1"
        spec={group({ container: { hideHeader: false }, title: 'Navigation' })}
        editable={false}
        pages={PAGES}
      />,
    );

    expect(document.body.textContent).toContain('Navigation');
    // Framed tiles keep the card chrome and the standard body padding.
    expect(cardRoot().style.borderWidth).toBe('');
    expect(host.querySelector('.-m-2')).toBeNull();
  });

  it('falls back to "Button group" when no title is authored', () => {
    mount(
      <ButtonGroupTile
        tileId="g1"
        spec={group({ container: { hideHeader: false } })}
        editable={false}
        pages={PAGES}
      />,
    );
    expect(document.body.textContent).toContain('Button group');
  });

  it('spec.background is the ONE fill writer and lands on the frame', () => {
    mount(
      <ButtonGroupTile
        tileId="g1"
        // container.background disagrees on purpose: spec.background wins.
        spec={group({ background: '#123456', container: { background: '#ff0000' } })}
        editable={false}
        pages={PAGES}
      />,
    );
    expect(cardRoot().style.backgroundColor).toBe('rgb(18, 52, 86)');
  });
});

/* ------------------------------------------------------------------- A2 */

describe('placement (A2)', () => {
  it('maps justify to the MAIN axis and align to the cross axis', () => {
    mount(
      <ButtonGroupTile
        tileId="g1"
        spec={group({ justify: 'center', align: 'end' })}
        editable={false}
        pages={PAGES}
      />,
    );
    const box = packingBox();
    expect(box.style.justifyContent).toBe('center');
    expect(box.style.alignItems).toBe('flex-end');
    // Wrapped ROWS follow the cross-axis control too — they used to be pinned
    // to flex-start whatever the author picked.
    expect(box.style.alignContent).toBe('flex-end');
  });

  it('defaults to left-packed (what every pre-0.14.1 group rendered as)', () => {
    mount(<ButtonGroupTile tileId="g1" spec={group()} editable={false} pages={PAGES} />);
    expect(packingBox().style.justifyContent).toBe('flex-start');
  });

  it('supports space-between and column direction', () => {
    mount(
      <ButtonGroupTile
        tileId="g1"
        spec={group({ justify: 'between', direction: 'column' })}
        editable={false}
        pages={PAGES}
      />,
    );
    const box = packingBox();
    expect(box.style.justifyContent).toBe('space-between');
    expect(box.style.flexDirection).toBe('column');
  });
});

/* ------------------------------------------------------------------- A6 */

describe('toolbar look (A6)', () => {
  it('gives every button the shared FIXED-height size class', () => {
    mount(<ButtonGroupTile tileId="g1" spec={group({ size: 'lg' })} editable={false} pages={PAGES} />);
    expect(buttonByLabel('One').className).toContain('h-10');
    expect(buttonByLabel('Two').className).toContain('h-10');
  });

  it('equalWidth swaps the flex row for the shared auto-fill grid', () => {
    mount(
      <ButtonGroupTile tileId="g1" spec={group({ equalWidth: true })} editable={false} pages={PAGES} />,
    );
    const box = packingBox();
    expect(box.style.display).toBe('grid');
    expect(box.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(6rem, 1fr))');
    expect(buttonByLabel('One').className).toContain('w-full');
  });

  it('a variant paints preset chrome, and a custom fill still overrides it', () => {
    mount(
      <ButtonGroupTile
        tileId="g1"
        spec={group({
          variant: 'primary',
          buttons: [
            { id: 'b1', html: '<p>One</p>', targetPageId: 'p1' },
            { id: 'b2', html: '<p>Two</p>', targetPageId: 'p2', background: '#123456' },
          ],
        })}
        editable={false}
        pages={PAGES}
      />,
    );
    expect(buttonByLabel('One').className).toContain('bg-rcd-accent');
    expect(buttonByLabel('Two').className).not.toContain('bg-rcd-accent');
    expect(buttonByLabel('Two').style.backgroundColor).toBe('rgb(18, 52, 86)');
  });
});

/* ------------------------------------------------------------------- A5 */

describe('label contrast (A5)', () => {
  it('derives white label text on a dark fill with no textColor', () => {
    act(() =>
      root.render(<ButtonVisual spec={{ html: '<p>Dark</p>', background: '#123456' }} />),
    );
    expect(buttonByLabel('Dark').style.color).toBe('rgb(255, 255, 255)');
  });

  /**
   * A pale fill gets DARK INK, not the theme token. Deferring to the token was
   * the original behavior and it washed the label out in dark mode: the fill is
   * a persisted literal that does not follow the theme, so a token that
   * resolves to near-white lands on top of a near-white button. Dark ink is
   * correct on a pale fill under BOTH themes, which is why the derivation is
   * two-sided (contrastingTextColor) rather than one-sided.
   */
  it('derives dark ink on a light fill so dark mode cannot wash it out', () => {
    act(() =>
      root.render(<ButtonVisual spec={{ html: '<p>Light</p>', background: '#f5f5f5' }} />),
    );
    expect(buttonByLabel('Light').style.color).toBe('rgb(9, 9, 11)');
  });

  it('an explicit textColor always wins over the derived one', () => {
    act(() =>
      root.render(
        <ButtonVisual spec={{ html: '<p>Set</p>', background: '#000000', textColor: '#ff0000' }} />,
      ),
    );
    expect(buttonByLabel('Set').style.color).toBe('rgb(255, 0, 0)');
  });

  it('pins the luminance switch point and shrugs off unparseable colors', () => {
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#ffffff')).toBeNull();
    expect(readableTextColor('#2563eb')).toBe('#ffffff'); // accent blue
    expect(readableTextColor('#eda100')).toBeNull(); // amber reads dark-on-light
    expect(readableTextColor('#000')).toBe('#ffffff'); // 3-digit form
    expect(readableTextColor('rebeccapurple')).toBeNull();
    expect(relativeLuminance('not a color')).toBeNull();
  });
});

/* ------------------------------------------------------------------- A3 */

describe('whole-button clipper never empties the container (A3)', () => {
  const originalRect = Element.prototype.getBoundingClientRect;
  const originalRO = globalThis.ResizeObserver;

  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
    globalThis.ResizeObserver = originalRO;
  });

  /** Host box is 100px wide; each button claims 100px starting at its index. */
  const stubGeometry = (widths: Record<string, [number, number]>) => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const label = this.getAttribute('aria-label');
      const [left, right] =
        this.tagName === 'BUTTON' && label && widths[label] ? widths[label] : [0, 100];
      return {
        left,
        right,
        top: 0,
        bottom: 30,
        width: right - left,
        height: 30,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
  };

  it('hides only the buttons that overflow and announces them', () => {
    stubGeometry({ One: [0, 90], Two: [98, 190], Three: [198, 290] });
    mount(
      <ButtonGroupTile
        tileId="g1"
        spec={group({
          buttons: [
            { id: 'b1', html: '<p>One</p>', targetPageId: 'p1' },
            { id: 'b2', html: '<p>Two</p>', targetPageId: 'p2' },
            { id: 'b3', html: '<p>Three</p>', targetPageId: 'p1' },
          ],
        })}
        editable={false}
        pages={PAGES}
      />,
    );

    expect(buttonByLabel('One').style.visibility).toBe('');
    expect(buttonByLabel('Two').style.visibility).toBe('hidden');
    expect(buttonByLabel('Three').style.visibility).toBe('hidden');
    expect(document.body.textContent).toContain('+2 more');
  });

  it('KEEPS the first button even when nothing fits (never a blank tile)', () => {
    stubGeometry({ One: [0, 400], Two: [402, 800] });
    mount(<ButtonGroupTile tileId="g1" spec={group()} editable={false} pages={PAGES} />);

    expect(buttonByLabel('One').style.visibility).toBe('');
    expect(buttonByLabel('Two').style.visibility).toBe('hidden');
    expect(document.body.textContent).toContain('+1 more');
  });

  it('says nothing when everything fits', () => {
    stubGeometry({ One: [0, 40], Two: [42, 90] });
    mount(<ButtonGroupTile tileId="g1" spec={group()} editable={false} pages={PAGES} />);

    expect(buttonByLabel('Two').style.visibility).toBe('');
    expect(document.body.textContent).not.toContain('more');
  });
});

/* ------------------------------------------------------------------- A7 */

describe('print view renders button tiles (A7)', () => {
  const PRINT_OPTIONS: PrintOptions = {
    paper: 'letter',
    orientation: 'landscape',
    margin: 'normal',
    scale: 100,
    flow: 'grid',
    alignH: 'left',
    alignV: 'top',
    pagesMode: 'current',
    customPageIds: [],
    includeTitle: false,
    includeTimestamp: false,
    includeFilters: false,
  };

  const TILES: DashboardTile[] = [
    {
      id: 'button-1',
      layout: { x: 0, y: 0, w: 4, h: 2 },
      kind: 'button',
      button: { html: '<p>Go</p>', targetPageId: 'p2' },
    },
    {
      id: 'group-1',
      layout: { x: 4, y: 0, w: 8, h: 2 },
      kind: 'buttonGroup',
      buttonGroup: group({ container: { hideHeader: false }, title: 'Navigation' }),
    },
  ];

  it('draws the buttons statically — no navigation, no focus stop', () => {
    const setActivePage = vi.fn();
    mount(
      <PrintSheets
        sections={[{ pageId: 'p1', title: 'Dash', tiles: TILES, filterSummary: [] }]}
        modelId={null}
        filtersByTile={new Map<string, FilterClause[]>()}
        options={PRINT_OPTIONS}
      />,
    );

    const printed = buttonByLabel('Go');
    expect(printed).not.toBeNull();
    expect(buttonByLabel('One')).not.toBeNull();
    expect(buttonByLabel('Two')).not.toBeNull();
    // Inert: not tabbable and no click handler wired.
    expect(printed.tabIndex).toBe(-1);
    act(() => printed.click());
    expect(setActivePage).not.toHaveBeenCalled();
    // A framed group prints its title block like any other tile.
    expect(document.body.textContent).toContain('Navigation');
  });
});
