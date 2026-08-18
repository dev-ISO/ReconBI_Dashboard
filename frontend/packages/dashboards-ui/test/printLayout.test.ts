// Unit tests for the pure print pipeline: page geometry (margin presets),
// header math, band pagination, the job-wide 'fit' factor (growth + cap), and
// the emitted @page/print-CSS + browser-dialog checklist strings. Everything
// under test is deterministic math — no DOM, no React.
import { describe, expect, it } from 'vitest';
import type { ChartSpec, DashboardTile } from '@recon/dashboards-core';
import type { PrintOptions } from '../src/dashboard/PrintConfigDialog';
import {
  computePrintJob,
  computePrintLayout,
  headerHeightPx,
  isUncommonPaper,
  pageGeometry,
  printBrowserChecklist,
  printPageCss,
  GRID_COLS,
  GRID_GAP,
  GRID_ROW_H,
  type PrintSectionInput,
} from '../src/dashboard/printLayout';

/* --------------------------------------------------------------- fixtures */

const tile = (id: string, x: number, y: number, w: number, h: number): DashboardTile => ({
  id,
  layout: { x, y, w, h },
  // printLayout only reads id/layout and the chart-tile guard (kind absent +
  // chart present = chart tile) — a minimal spec is honest here.
  chart: { title: id } as unknown as ChartSpec,
});

const opts = (over: Partial<PrintOptions> = {}): PrintOptions => ({
  paper: 'letter',
  orientation: 'landscape',
  margin: 'normal',
  scale: 'fit',
  flow: 'grid',
  alignH: 'left',
  alignV: 'top',
  pagesMode: 'current',
  customPageIds: [],
  includeTitle: true,
  includeTimestamp: true,
  includeFilters: true,
  ...over,
});

const section = (tiles: DashboardTile[], pageId = 'p1'): PrintSectionInput => ({
  pageId,
  title: 'Dashboard',
  tiles,
  filterSummary: [],
});

/** Grid-flow mirrors (same formulas as printLayout — keeps expectations honest). */
const colW = (layoutWidth: number) => (layoutWidth - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
const tileWidthPx = (layoutWidth: number, w: number) => w * colW(layoutWidth) + (w - 1) * GRID_GAP;
const bandHeightPx = (rows: number) => rows * (GRID_ROW_H + GRID_GAP) - GRID_GAP;

/** Header with title + timestamp, no filter line: 28 + 4 + 16 + 16 bottom. */
const HEADER_DEFAULT = 64;

/* ------------------------------------------------------------ pageGeometry */

describe('pageGeometry', () => {
  it('produces the documented content boxes at normal (12mm) margins', () => {
    // The doc-table values in printLayout.ts, spot-checked per paper/orientation.
    expect(pageGeometry('letter', 'landscape')).toMatchObject({
      paperWidthMm: 279.4,
      paperHeightMm: 215.9,
      marginMm: 12,
      contentWidthPx: 965,
      contentHeightPx: 725,
    });
    expect(pageGeometry('letter', 'portrait')).toMatchObject({
      contentWidthPx: 725,
      contentHeightPx: 965,
    });
    expect(pageGeometry('a4', 'portrait')).toMatchObject({
      contentWidthPx: 702,
      contentHeightPx: 1031,
    });
    expect(pageGeometry('legal', 'landscape')).toMatchObject({
      contentWidthPx: 1253,
      contentHeightPx: 725,
    });
    expect(pageGeometry('tabloid', 'portrait')).toMatchObject({
      contentWidthPx: 965,
      contentHeightPx: 1541,
    });
  });

  it('narrow margins widen the printable area', () => {
    expect(pageGeometry('letter', 'landscape', 'narrow')).toMatchObject({
      marginMm: 6,
      contentWidthPx: 1010,
      contentHeightPx: 770,
    });
  });

  it("'none' hands the whole sheet to content (paper == content box)", () => {
    const geometry = pageGeometry('letter', 'landscape', 'none');
    // 11in x 8.5in at 96dpi, exactly.
    expect(geometry).toMatchObject({
      marginMm: 0,
      marginPx: 0,
      contentWidthPx: 1056,
      contentHeightPx: 816,
    });
    expect(geometry.paperWidthPx).toBe(geometry.contentWidthPx);
    expect(geometry.paperHeightPx).toBe(geometry.contentHeightPx);
  });

  it("defaults to 'normal' when the margin argument is omitted", () => {
    expect(pageGeometry('a4', 'landscape')).toEqual(pageGeometry('a4', 'landscape', 'normal'));
  });
});

/* ---------------------------------------------------------- headerHeightPx */

describe('headerHeightPx', () => {
  it('is a pure function of the include options', () => {
    expect(headerHeightPx(opts(), true)).toBe(84); // 28+16+16 + 2*4 gaps + 16
    expect(headerHeightPx(opts(), false)).toBe(HEADER_DEFAULT); // 28+16 + 4 + 16
    expect(
      headerHeightPx(
        opts({ includeTitle: false, includeTimestamp: false, includeFilters: false }),
        true,
      ),
    ).toBe(0);
  });
});

/* ------------------------------------------------- computePrintLayout: pages */

describe('computePrintLayout pagination', () => {
  it('keeps a small dashboard on one page', () => {
    const layout = computePrintLayout([tile('a', 0, 0, 6, 4)], opts({ scale: 100 }), false);
    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0]!.blocks).toHaveLength(1);
    expect(layout.pages[0]!.blocks[0]).toMatchObject({ scale: 1, marginTop: 0 });
    expect(layout.headerHeight).toBe(HEADER_DEFAULT);
  });

  it('starts a band that would cross the page boundary on the next page', () => {
    // Two 10-row bands (428px each): 64 + 428 + 12 + 428 = 932 > 725.
    const tiles = [tile('a', 0, 0, 24, 10), tile('b', 0, 10, 24, 10)];
    const layout = computePrintLayout(tiles, opts({ scale: 100 }), false);
    expect(layout.pages).toHaveLength(2);
    expect(layout.pages[0]!.blocks).toHaveLength(1);
    expect(layout.pages[1]!.blocks).toHaveLength(1);
    // First block of a fresh page carries no inter-block gap.
    expect(layout.pages[1]!.blocks[0]!.marginTop).toBe(0);
  });

  it('shrinks an oversize band to exactly the free height (never slices it)', () => {
    // One 20-row band: 868px > 725 - 64 available under the header.
    const layout = computePrintLayout([tile('a', 0, 0, 24, 20)], opts({ scale: 100 }), false);
    expect(layout.pages).toHaveLength(1);
    const block = layout.pages[0]!.blocks[0]!;
    const available = 725 - HEADER_DEFAULT;
    expect(block.scale).toBeCloseTo(available / bandHeightPx(20), 10);
    expect(block.height).toBeCloseTo(available, 6);
  });

  it('page-1 header consumes capacity (dropping it can save a page)', () => {
    // Two 8-row bands (340px): with header 64+340+12+340 = 756 > 725 → 2 pages;
    // without header 692 ≤ 725 → 1 page.
    const tiles = [tile('a', 0, 0, 24, 8), tile('b', 0, 8, 24, 8)];
    expect(computePrintLayout(tiles, opts({ scale: 100 }), false).pages).toHaveLength(2);
    const bare = opts({ scale: 100, includeTitle: false, includeTimestamp: false });
    expect(computePrintLayout(tiles, bare, false).pages).toHaveLength(1);
  });

  it('margin preset changes page capacity (and therefore page counts)', () => {
    // Same two 8-row bands: 'none' grows the letter-landscape content box to
    // 816px tall, so 64+340+12+340 = 756 now fits one page.
    const tiles = [tile('a', 0, 0, 24, 8), tile('b', 0, 8, 24, 8)];
    expect(computePrintLayout(tiles, opts({ scale: 100 }), false).pages).toHaveLength(2);
    expect(
      computePrintLayout(tiles, opts({ scale: 100, margin: 'none' }), false).pages,
    ).toHaveLength(1);
  });

  it("'fit' paginates identically to 100% (growth happens at the job level)", () => {
    const tiles = [tile('a', 0, 0, 12, 6), tile('b', 12, 0, 12, 6), tile('c', 0, 6, 24, 10)];
    expect(computePrintLayout(tiles, opts(), false)).toEqual(
      computePrintLayout(tiles, opts({ scale: 100 }), false),
    );
  });
});

/* ------------------------------------------------------- job-wide fit factor */

describe('computePrintJob job-wide fit', () => {
  it('percent scales never grow (fitScale 1, layout passed through verbatim)', () => {
    const tiles = [tile('a', 0, 0, 6, 4)];
    const job = computePrintJob([section(tiles)], opts({ scale: 100 }));
    expect(job.fitScale).toBe(1);
    expect(job.sections[0]!.layout).toEqual(computePrintLayout(tiles, opts({ scale: 100 }), false));
  });

  it('grows a small dashboard and caps the factor at 2', () => {
    // 6x4 tile: width ratio ≈ 4.15, height ratio ≈ 4.03 → capped at 2.
    const job = computePrintJob([section([tile('a', 0, 0, 6, 4)])], opts());
    expect(job.fitScale).toBe(2);
    const block = job.sections[0]!.layout.pages[0]!.blocks[0]!;
    expect(block.scale).toBe(2);
    expect(block.height).toBe(bandHeightPx(4) * 2);
    // The reserved footprint doubles with the render scale (outer box model).
    expect(block.width).toBe(block.layoutWidth * 2);
  });

  it('growth is width-bound by the RENDERED tile extent, floor-quantized', () => {
    // 16-col tile: extent 639.33px → width ratio ≈ 1.5094 beats the height
    // ratio (≈ 4.03) → factor floor-quantized to 3 decimals.
    const job = computePrintJob([section([tile('a', 0, 0, 16, 4)])], opts());
    const extent = tileWidthPx(965, 16);
    const expected = Math.floor((965 / extent) * 1000) / 1000;
    expect(job.fitScale).toBe(expected);
    expect(expected).toBeGreaterThan(1.5);
    expect(expected).toBeLessThan(1.51);
  });

  it('accounts for the page-1 header reserve', () => {
    // 8x8 tile (band 340px, narrow enough that height binds): with the header
    // the factor is (725-64)/340 ≈ 1.944; without it 725/340 ≈ 2.13 → cap 2.
    const tiles = [tile('a', 0, 0, 8, 8)];
    const withHeader = computePrintJob([section(tiles)], opts());
    const bare = computePrintJob(
      [section(tiles)],
      opts({ includeTitle: false, includeTimestamp: false }),
    );
    expect(withHeader.fitScale).toBe(Math.floor(((725 - HEADER_DEFAULT) / 340) * 1000) / 1000);
    expect(bare.fitScale).toBe(2);
    expect(withHeader.fitScale).toBeLessThan(bare.fitScale);
  });

  it('takes the minimum over every physical page of the job', () => {
    // Two 10-row 12-col bands → two pages. Page 1 (header): (725-64)/428;
    // page 2: 725/428; width ratio ≈ 2.03. The tightest page wins.
    const tiles = [tile('a', 0, 0, 12, 10), tile('b', 0, 10, 12, 10)];
    const job = computePrintJob([section(tiles)], opts());
    expect(job.totalPages).toBe(2);
    expect(job.fitScale).toBe(Math.floor(((725 - HEADER_DEFAULT) / bandHeightPx(10)) * 1000) / 1000);
    // Every grown page must still fit its content box (the fit invariant).
    for (const jobSection of job.sections) {
      jobSection.layout.pages.forEach((page, localIndex) => {
        const headerH = localIndex === 0 ? jobSection.layout.headerHeight : 0;
        const usedH = page.blocks.reduce((sum, b) => sum + b.marginTop + b.height, 0);
        expect(headerH + usedH).toBeLessThanOrEqual(725 + 0.001);
        for (const block of page.blocks) {
          const extent = block.tiles.reduce((max, t) => Math.max(max, t.left + t.width), 0);
          expect(extent * block.scale).toBeLessThanOrEqual(965 + 0.001);
        }
      });
    }
  });

  it('a full-width dashboard cannot grow (width ratio 1)', () => {
    const job = computePrintJob([section([tile('a', 0, 0, 24, 6)])], opts());
    expect(job.fitScale).toBe(1);
  });

  it('an oversize shrunk-to-fit band pins the job to 1 (its page is full)', () => {
    const job = computePrintJob([section([tile('a', 0, 0, 24, 20)])], opts());
    expect(job.fitScale).toBe(1);
  });

  it('sequential flow is width-bound to 1 (tiles already span the page)', () => {
    const job = computePrintJob([section([tile('a', 0, 0, 6, 4)])], opts({ flow: 'sequential' }));
    expect(job.fitScale).toBe(1);
  });

  it('one cramped workbook section limits the whole job (uniform factor)', () => {
    const roomy = section([tile('a', 0, 0, 6, 4)], 'p1');
    const fullWidth = section([tile('b', 0, 0, 24, 6)], 'p2');
    expect(computePrintJob([roomy], opts()).fitScale).toBe(2);
    expect(computePrintJob([roomy, fullWidth], opts()).fitScale).toBe(1);
  });

  it('an empty job stays a single unscaled sheet', () => {
    const job = computePrintJob([], opts());
    expect(job.totalPages).toBe(1);
    expect(job.fitScale).toBe(1);
  });
});

/* ------------------------------------------------------------- printPageCss */

describe('printPageCss', () => {
  it('claims the whole sheet and pins it in mm (letter landscape, normal)', () => {
    const css = printPageCss(opts());
    expect(css).toContain('@page { size: 279.4mm 215.9mm; margin: 0; }');
    expect(css).toContain('@media print {');
    expect(css).toContain('body.rcd-printing .rcd-print-sheet {');
    expect(css).toContain('width: 279.4mm !important;');
    expect(css).toContain('height: calc(215.9mm - 1px) !important;');
    expect(css).toContain('padding: 12mm !important;');
  });

  it('follows paper/orientation/margin (a4 portrait, narrow)', () => {
    const css = printPageCss(opts({ paper: 'a4', orientation: 'portrait', margin: 'narrow' }));
    expect(css).toContain('@page { size: 210mm 297mm; margin: 0; }');
    expect(css).toContain('width: 210mm !important;');
    expect(css).toContain('height: calc(297mm - 1px) !important;');
    expect(css).toContain('padding: 6mm !important;');
  });

  it("margin 'none' prints edge to edge", () => {
    expect(printPageCss(opts({ margin: 'none' }))).toContain('padding: 0mm !important;');
  });
});

/* -------------------------------------------------- browser-dialog checklist */

describe('printBrowserChecklist', () => {
  it('spells out the exact browser-dialog settings for the chosen job', () => {
    const items = printBrowserChecklist(opts());
    expect(items[0]).toContain('Save as PDF');
    expect(items).toContain('Paper: Letter');
    expect(items).toContain('Layout: Landscape');
    expect(items).toContain('Margins: Default');
    expect(items).toContain('Scale: 100%');
    expect(items).toContain('Headers and footers: off');
  });

  it('tracks paper and orientation', () => {
    const items = printBrowserChecklist(opts({ paper: 'tabloid', orientation: 'portrait' }));
    expect(items).toContain('Paper: Tabloid');
    expect(items).toContain('Layout: Portrait');
  });

  it('flags stock physical printers rarely hold', () => {
    expect(isUncommonPaper('letter')).toBe(false);
    expect(isUncommonPaper('a4')).toBe(false);
    expect(isUncommonPaper('legal')).toBe(true);
    expect(isUncommonPaper('tabloid')).toBe(true);
  });
});
