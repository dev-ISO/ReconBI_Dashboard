// Pure print geometry + pagination shared by DashboardPrintView (full-screen
// preview) and PrintConfigDialog (live thumbnail) — one function, no drift.
import {
  displayDateBound,
  isChartTile,
  isImageTile,
  isSlicerTile,
  isTextTile,
  slicerClauseOf,
  type CrossFilter,
  type DashboardTile,
  type FilterClause,
  type SlicerValues,
} from '@recon/dashboards-core';
import type { PrintMargin, PrintOptions, PrintOrientation, PrintPaper } from './PrintConfigDialog';

/** A printable tile: chart, text, or image (slicers and buttons never print). */
export type ChartTileEntry = DashboardTile;

/* ---------------------------------------------------------------- paper math
 * All geometry is exact CSS px at 96dpi. The printed page is claimed WHOLE via
 * an injected `@page { size: <W>mm <H>mm; margin: 0 }` (see printPageCss); the
 * sheet element is the paper and its padding is the chosen margin preset, so
 * the printable (content) area is the paper minus the margin on every side.
 * Content px are FLOORED so the on-screen layout is always a hair inside the
 * real printable area — content can never spill onto a stray extra page.
 *
 * Content-area px per paper/orientation at the default 12mm margins
 * (width × height):
 *   letter   portrait  725 × 965    landscape  965 × 725
 *   a4       portrait  702 × 1031   landscape 1031 × 702
 *   legal    portrait  725 × 1253   landscape 1253 × 725
 *   tabloid  portrait  965 × 1541   landscape 1541 × 965
 */

/** Margin preset → mm per side. 'normal' is the historic hard-coded 12mm. */
export const MARGIN_MM: Record<PrintMargin, number> = { normal: 12, narrow: 6, none: 0 };

const DPI = 96;
const MM_PER_IN = 25.4;

export const mmToPx = (mm: number): number => (mm / MM_PER_IN) * DPI;

/** Exact paper dimensions in mm (letter/legal/tabloid are inch stocks). */
const PAPER_SIZES_MM: Record<PrintPaper, { short: number; long: number }> = {
  letter: { short: 215.9, long: 279.4 },
  a4: { short: 210, long: 297 },
  legal: { short: 215.9, long: 355.6 },
  tabloid: { short: 279.4, long: 431.8 },
};

export interface PageGeometry {
  /** Oriented full-paper size in mm — feed straight into `@page { size }`. */
  paperWidthMm: number;
  paperHeightMm: number;
  /** Chosen per-side margin in mm — the sheet's print padding. */
  marginMm: number;
  /** Full paper in px (content + margins) — the on-screen sheet size. */
  paperWidthPx: number;
  paperHeightPx: number;
  /** Printable content box in px (paper minus the margins, floored). */
  contentWidthPx: number;
  contentHeightPx: number;
  /** The margin in px — the sheet's visual padding, 1:1 with print. */
  marginPx: number;
}

export function pageGeometry(
  paper: PrintPaper,
  orientation: PrintOrientation,
  margin: PrintMargin = 'normal',
): PageGeometry {
  const size = PAPER_SIZES_MM[paper];
  const marginMm = MARGIN_MM[margin];
  const paperWidthMm = orientation === 'landscape' ? size.long : size.short;
  const paperHeightMm = orientation === 'landscape' ? size.short : size.long;
  const contentWidthPx = Math.floor(mmToPx(paperWidthMm - 2 * marginMm));
  const contentHeightPx = Math.floor(mmToPx(paperHeightMm - 2 * marginMm));
  const marginPx = mmToPx(marginMm);
  return {
    paperWidthMm,
    paperHeightMm,
    marginMm,
    paperWidthPx: contentWidthPx + 2 * marginPx,
    paperHeightPx: contentHeightPx + 2 * marginPx,
    contentWidthPx,
    contentHeightPx,
    marginPx,
  };
}

/* ------------------------------------------------------------- header height
 * The printed header uses FIXED line heights (leading-7 / leading-4 + truncate
 * in the markup), so its height is a pure function of the options — pagination
 * needs no DOM measurement and the dialog thumbnail computes the exact same
 * number.
 */
const HEADER_TITLE_LINE = 28; // text-xl leading-7
const HEADER_META_LINE = 16; // text-xs leading-4
const HEADER_LINE_GAP = 4; // gap-1
const HEADER_MARGIN_BOTTOM = 16; // mb-4

export function headerHeightPx(options: PrintOptions, hasFilterSummary: boolean): number {
  const lines: number[] = [];
  if (options.includeTitle) lines.push(HEADER_TITLE_LINE);
  if (options.includeTimestamp) lines.push(HEADER_META_LINE);
  if (options.includeFilters && hasFilterSummary) lines.push(HEADER_META_LINE);
  if (lines.length === 0) return 0;
  const text = lines.reduce((sum, line) => sum + line, 0);
  return text + HEADER_LINE_GAP * (lines.length - 1) + HEADER_MARGIN_BOTTOM;
}

/* ------------------------------------------------------------ filter summary */

/**
 * Human summary of a slicer/date clause — the printed filter line AND the
 * on-screen filter indicator share it so both read identically.
 */
export const describeClause = (clause: FilterClause): string => {
  // Date ranges on a timestamp column carry the day's last instant as their
  // upper bound; people read the range in days, so show it that way.
  const values = clause.values.map((value) =>
    typeof value === 'string' ? displayDateBound(value) : String(value),
  );
  switch (clause.operator) {
    case 'between':
      return `${values[0] ?? ''} to ${values[1] ?? ''}`;
    case 'gte':
      return `from ${values[0] ?? ''}`;
    case 'lte':
      return `through ${values[0] ?? ''}`;
    case 'isNull':
      return '(blank)';
    case 'notNull':
      return '(not blank)';
    default:
      return values.join(', ');
  }
};

/** Active slicer selections + cross-filters, as printable header chips. */
export function filterSummaryFor(
  tiles: DashboardTile[],
  slicerValues: SlicerValues,
  crossFilters: CrossFilter[],
): string[] {
  const parts: string[] = [];
  for (const tile of tiles) {
    if (!isSlicerTile(tile)) continue;
    const clause = slicerClauseOf(slicerValues[tile.id]);
    if (!clause) continue;
    parts.push(`${tile.slicer.label}: ${describeClause(clause)}`);
  }
  for (const cross of crossFilters) parts.push(`Highlighted by ${cross.label}`);
  return parts;
}

/* ------------------------------------------------------------------- layout
 * Grid-flow geometry mirrors DashboardGrid (24 cols, 32px rows, 12px gaps).
 */
export const GRID_COLS = 24;
export const GRID_ROW_H = 32;
export const GRID_GAP = 12;

/* Sequential flow: natural height from the tile's grid rows, clamped. */
const SEQ_ROW_PX = 40;
const SEQ_MIN_H = 240;
const SEQ_MAX_H = 520;

/** Vertical gap between blocks on a page (matches the grid gap). */
export const BLOCK_GAP = 12;

/** One tile placed inside a block, in UNSCALED layout px. */
export interface PlacedPrintTile {
  tile: ChartTileEntry;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A pagination unit (grid band / sequential tile) placed on a page. The block
 * renders an inner box at layoutWidth × layoutHeight, transform-scaled by
 * `scale`; the outer box reserves exactly width × height on the sheet.
 */
export interface PrintBlock {
  key: string;
  /** Pre-transform layout size (tiles are positioned in this space). */
  layoutWidth: number;
  layoutHeight: number;
  /** Total render transform: user zoom × shrink-to-fit for oversize blocks. */
  scale: number;
  /** Sheet footprint px (layout size × scale). */
  width: number;
  height: number;
  /** In-flow spacing above this block on its page (0 for the first block). */
  marginTop: number;
  tiles: PlacedPrintTile[];
}

export interface PrintPage {
  blocks: PrintBlock[];
}

export interface PrintLayout {
  geometry: PageGeometry;
  /** User zoom (1 for 'fit' — the job-wide fit growth is baked into the
   *  BLOCKS by computePrintJob, never into this number; N/100 otherwise). */
  userScale: number;
  /** Width the tile geometry is computed at (contentWidth / userScale). */
  layoutWidth: number;
  /**
   * Width the composed content ACTUALLY occupies, pre-scale: the span of grid
   * columns the dashboard uses (grid flow) or the full layout width
   * (sequential). Narrower than layoutWidth whenever the dashboard leaves
   * empty columns — that slack is what horizontal alignment redistributes.
   */
  contentWidth: number;
  /** Page-1 header footprint (0 when every header line is off). */
  headerHeight: number;
  /** Never empty — a chartless dashboard yields one page with zero blocks. */
  pages: PrintPage[];
}

/** A horizontal band of tiles whose y-ranges overlap (grid-flow page unit). */
interface Band {
  yStart: number;
  yEnd: number;
  tiles: ChartTileEntry[];
}

const computeBands = (tiles: ChartTileEntry[]): Band[] => {
  const sorted = [...tiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const bands: Band[] = [];
  for (const tile of sorted) {
    const last = bands[bands.length - 1];
    if (last && tile.layout.y < last.yEnd) {
      last.tiles.push(tile);
      last.yEnd = Math.max(last.yEnd, tile.layout.y + tile.layout.h);
    } else {
      bands.push({ yStart: tile.layout.y, yEnd: tile.layout.y + tile.layout.h, tiles: [tile] });
    }
  }
  return bands;
};

interface RawBlock {
  key: string;
  layoutHeight: number;
  tiles: PlacedPrintTile[];
}

/**
 * Slices the dashboard's tile bands into page-sized sheets:
 * - bands/tiles are measured at layoutWidth, footprinted at × userScale;
 * - a band that would cross a page boundary starts on the next page;
 * - a band taller than its page's free height gets an extra shrink-to-fit
 *   scale so it always fits ONE page (never sliced mid-chart);
 * - the page-1 header (fixed, computed height) consumes page-1 capacity.
 *
 * The preview renders these pages 1:1 (same px), so what you see on screen —
 * including page boundaries and orientation — is exactly what prints.
 */
export function computePrintLayout(
  tiles: DashboardTile[],
  options: PrintOptions,
  hasFilterSummary: boolean,
): PrintLayout {
  const geometry = pageGeometry(options.paper, options.orientation, options.margin ?? 'normal');
  const userScale = options.scale === 'fit' ? 1 : options.scale / 100;
  const layoutWidth = geometry.contentWidthPx / userScale;
  const headerHeight = headerHeightPx(options, hasFilterSummary);
  // Printable tiles ONLY: slicers and navigation BUTTONS are interactive
  // chrome — a slicer's picker and a button's page-switch mean nothing on
  // paper — so both are excluded outright (not rendered, no space reserved;
  // the bands below simply never see them).
  const chartTiles = tiles.filter(
    (tile) => isChartTile(tile) || isTextTile(tile) || isImageTile(tile),
  );

  let raw: RawBlock[];
  // Composed content width: grid flow shrink-wraps to the columns the
  // dashboard actually uses (shifted flush left), so a layout occupying only
  // half the grid has real slack for the alignment setting to distribute
  // instead of silently hugging the left margin. Bands keep their RELATIVE
  // offsets — the whole composition shifts by one common amount, so tiles
  // stacked across bands stay aligned with each other.
  //
  // Shrink-wrap is an ALIGNMENT affordance, not a layout normalization, so it
  // engages ONLY for 'center'/'right'. At the default 'left' the grid keeps
  // its absolute column origin — a dashboard indented to column 2 prints
  // indented, byte-identical to the pre-shrink-wrap algorithm — because
  // re-origining there would silently change every default print.
  const shrinkWrap = (options.alignH ?? 'left') !== 'left';
  let contentWidth = layoutWidth;
  if (options.flow === 'grid') {
    const colW = (layoutWidth - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
    let originX = 0;
    if (shrinkWrap && chartTiles.length > 0) {
      const firstCol = chartTiles.reduce((min, tile) => Math.min(min, tile.layout.x), GRID_COLS);
      const lastCol = chartTiles.reduce(
        (max, tile) => Math.max(max, tile.layout.x + tile.layout.w),
        0,
      );
      const span = Math.max(1, lastCol - firstCol);
      originX = firstCol * (colW + GRID_GAP);
      contentWidth = span * colW + (span - 1) * GRID_GAP;
    }
    raw = computeBands(chartTiles).map((band, index) => ({
      key: `band-${index}`,
      layoutHeight: (band.yEnd - band.yStart) * (GRID_ROW_H + GRID_GAP) - GRID_GAP,
      tiles: band.tiles.map((tile) => ({
        tile,
        left: tile.layout.x * (colW + GRID_GAP) - originX,
        top: (tile.layout.y - band.yStart) * (GRID_ROW_H + GRID_GAP),
        width: tile.layout.w * colW + (tile.layout.w - 1) * GRID_GAP,
        height: tile.layout.h * GRID_ROW_H + (tile.layout.h - 1) * GRID_GAP,
      })),
    }));
  } else {
    raw = [...chartTiles]
      .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
      .map((tile) => {
        const height = Math.min(SEQ_MAX_H, Math.max(SEQ_MIN_H, tile.layout.h * SEQ_ROW_PX));
        return {
          key: tile.id,
          layoutHeight: height,
          tiles: [{ tile, left: 0, top: 0, width: layoutWidth, height }],
        };
      });
  }

  const pageH = geometry.contentHeightPx;
  const pages: PrintPage[] = [{ blocks: [] }];
  let used = headerHeight; // page-1 capacity already consumed by the header
  let count = 0;
  for (const block of raw) {
    const footprint = block.layoutHeight * userScale;
    let gapBefore = count > 0 ? BLOCK_GAP : 0;
    if (count > 0 && used + gapBefore + footprint > pageH) {
      pages.push({ blocks: [] });
      used = 0;
      count = 0;
      gapBefore = 0;
    }
    // First block on a page never pushes to the next one — if it is too tall
    // for the free height (oversize band, or a tall band under the header) it
    // shrinks to exactly fit instead.
    const available = Math.max(pageH - used - gapBefore, 1);
    const fit = footprint > 0 ? Math.min(1, available / footprint) : 1;
    const scale = userScale * fit;
    pages[pages.length - 1]!.blocks.push({
      key: block.key,
      layoutWidth: contentWidth,
      layoutHeight: block.layoutHeight,
      scale,
      width: contentWidth * scale,
      height: block.layoutHeight * scale,
      marginTop: gapBefore,
      tiles: block.tiles,
    });
    used += gapBefore + block.layoutHeight * scale;
    count += 1;
  }

  return { geometry, userScale, layoutWidth, contentWidth, headerHeight, pages };
}

/* -------------------------------------------------- workbook-style print job
 * "Print the whole workbook": several dashboard pages concatenated into ONE
 * print job. Each included dashboard page is paginated INDEPENDENTLY through
 * computePrintLayout — identical geometry to printing that page alone — and
 * the per-section page runs are then concatenated: every section starts on a
 * fresh physical sheet and page numbers run continuously across the job.
 *
 * A single-section job is therefore byte-identical to today's single-page
 * print (same function, same inputs) — the default 'current page' path cannot
 * regress by construction.
 *
 * Band-packer audit notes (wave 18), for the record:
 *  - A tile/band taller than a page's content box is SCALED TO FIT that page
 *    (never clipped, never sliced mid-chart) — the honest-vector doctrine
 *    prefers a slightly smaller but complete chart over splitting an SVG
 *    across sheets. Documented in computePrintLayout.
 *  - On page 1 the header consumes capacity first; an oversize FIRST band
 *    shrinks under it rather than pushing to page 2 (a header-only page 1
 *    would be uglier than a few percent of shrink). Deliberate.
 *  - Pages are only created when a block lands on them, so trailing empty
 *    pages are impossible; a chartless section yields exactly one sheet.
 *  - Wide scales (125/150%) shrink layoutWidth so width never overflows;
 *    heights that outgrow the page fall into the shrink-to-fit path above.
 */

/** One dashboard page's contribution to a print job (pure input). */
export interface PrintSectionInput {
  /** Dashboard page id ('' for a synthetic empty section). */
  pageId: string;
  /** Printed header title for this section (dashboard name — page name). */
  title: string;
  tiles: DashboardTile[];
  /** Printed "Active filters" chips for this section's header line. */
  filterSummary: string[];
}

export interface PrintJobSection extends PrintSectionInput {
  /** This section's own pagination — computePrintLayout, with the job-wide
   *  'fit' growth factor (if any) already baked into every block. */
  layout: PrintLayout;
  /** Zero-based physical page index of the section's first sheet. */
  startPage: number;
}

export interface PrintJob {
  /** Shared paper geometry (all sections print on the same stock). */
  geometry: PageGeometry;
  sections: PrintJobSection[];
  /** Physical sheet count across every included dashboard page. */
  totalPages: number;
  /** Job-wide 'fit' growth factor already applied to every block (1 for the
   *  percent scales, and whenever no page has room to grow). */
  fitScale: number;
}

/* ----------------------------------------------------------- job-wide 'fit'
 * 'Fit to page' used to be a quiet no-op: it laid tiles out at the printable
 * width and the only fitting that ever ran was the per-block SHRINK for
 * oversize bands — a half-empty dashboard printed small in a sea of white.
 * Real fit: ONE uniform factor for the whole job, the minimum over every
 * physical page of (available / used) in BOTH axes, so after scaling every
 * page still fits by construction. Growth is allowed (that is the point) but
 * capped at 2× so a one-tile dashboard cannot print as a poster; shrink is
 * never needed because the factor-1 pagination already fits, so the factor is
 * clamped to [1, cap] (also swallowing float noise from exact-fit pages).
 *
 * The factor is applied AFTER pagination through the existing per-block scale
 * mechanism (the outer box reserves the scaled footprint): page assignments
 * and page counts never change, the composed pages just zoom uniformly — and
 * print output is vector, so growth costs no sharpness. One factor for the
 * WHOLE job (not per page/section) keeps a workbook visually coherent: the
 * same chart never prints at two sizes on consecutive sheets.
 *
 * Per-page constraints:
 *  - width: the RENDERED extent of each block's tiles (max right edge ×
 *    block scale), not the block's box width — at the default left alignment
 *    the block box spans the full layout width even when the dashboard only
 *    uses half the columns, and counting that empty slack would forbid all
 *    growth. The grown box may overhang the printable area, but only empty
 *    space overhangs (the tile extent is what is constrained) and the sheet
 *    clips it.
 *  - height: the page-1 header is real text OUTSIDE the block scale
 *    mechanism and keeps its fixed height, so each section's first page only
 *    grows into (content height − header). Inter-block gaps scale WITH the
 *    factor so the composition zooms proportionally.
 */
const FIT_GROWTH_CAP = 2;

/** Uniform job growth factor (see block comment). 1 = no room to grow. */
function jobFitScale(sections: PrintJobSection[], geometry: PageGeometry): number {
  let factor = FIT_GROWTH_CAP;
  let constrained = false;
  for (const section of sections) {
    section.layout.pages.forEach((page, localIndex) => {
      if (page.blocks.length === 0) return; // header-only/empty sheet: no bound
      const headerH = localIndex === 0 ? section.layout.headerHeight : 0;
      let usedH = 0;
      let usedW = 0;
      for (const block of page.blocks) {
        usedH += block.marginTop + block.height;
        const extent = block.tiles.reduce((max, tile) => Math.max(max, tile.left + tile.width), 0);
        usedW = Math.max(usedW, extent * block.scale);
      }
      if (usedH > 0) {
        factor = Math.min(factor, (geometry.contentHeightPx - headerH) / usedH);
        constrained = true;
      }
      if (usedW > 0) {
        factor = Math.min(factor, geometry.contentWidthPx / usedW);
        constrained = true;
      }
    });
  }
  if (!constrained) return 1;
  // Floored to 3 decimals like every other print scale (rounding UP could
  // overflow a page); clamped growth-only — see block comment.
  return Math.max(1, Math.min(FIT_GROWTH_CAP, Math.floor(factor * 1000) / 1000));
}

/** One block, uniformly grown: footprint, gap and render scale together. */
const growBlock = (block: PrintBlock, factor: number): PrintBlock => ({
  ...block,
  scale: block.scale * factor,
  width: block.width * factor,
  height: block.height * factor,
  marginTop: block.marginTop * factor,
});

export function computePrintJob(sections: PrintSectionInput[], options: PrintOptions): PrintJob {
  const list: PrintSectionInput[] =
    sections.length > 0
      ? sections
      : [{ pageId: '', title: '', tiles: [], filterSummary: [] }];
  let out: PrintJobSection[] = [];
  let startPage = 0;
  for (const section of list) {
    const layout = computePrintLayout(section.tiles, options, section.filterSummary.length > 0);
    out.push({ ...section, layout, startPage });
    startPage += layout.pages.length; // computePrintLayout never returns 0 pages
  }
  const geometry = out[0]!.layout.geometry;
  // Job-wide fit growth (percent scales are exact user intent — never grown).
  const fitScale = options.scale === 'fit' ? jobFitScale(out, geometry) : 1;
  if (fitScale !== 1) {
    out = out.map((section) => ({
      ...section,
      layout: {
        ...section.layout,
        pages: section.layout.pages.map((page) => ({
          blocks: page.blocks.map((block) => growBlock(block, fitScale)),
        })),
      },
    }));
  }
  return { geometry, sections: out, totalPages: startPage, fitScale };
}

/* ------------------------------------------------------------ print page CSS
 * @page cannot be parameterized from a static stylesheet, so
 * DashboardPrintView injects this string as a runtime <style> for the
 * lifetime of the overlay. Built here — pure — so unit tests can assert the
 * exact CSS a given option set prints with.
 *
 * Page-box model: `@page { margin: 0 }` hands the WHOLE sheet of paper to the
 * layout and each .rcd-print-sheet IS one sheet — pinned to the exact paper
 * mm size (mm beats the on-screen inline px, which are only a 96dpi
 * round-trip of the same numbers), with the chosen margin as PADDING
 * (border-box, so the padding carves out exactly the printable area the
 * pagination math used). The browser is left with no margin arithmetic of its
 * own to disagree with: preview and paper agree by construction, and the
 * browser dialog's "Margins: Default" resolves to our @page margins (0).
 * Height sits 1px shy of the paper so the mm→px round-trip can never spill a
 * sheet onto a stray blank page. Everything geometry-independent (page
 * breaks, chrome hiding, box-sizing/overflow, the 100%-height content box)
 * lives statically in rcd.css.
 */
/**
 * CSS paged-media KEYWORD for each paper. Raw `<W>mm <H>mm` sizes express
 * orientation only by dimension order, and PDF-printer drivers (Foxit et al.)
 * routinely normalize that to the stock's portrait and ROTATE the content —
 * the "my tabloid PDF comes out sideways" bug. `size: <keyword> <orientation>`
 * carries the orientation explicitly through the print pipeline. (CSS calls
 * the 11in x 17in stock "ledger"; the trade name tabloid is the same paper.)
 */
const PAPER_CSS_KEYWORD: Record<PrintPaper, string> = {
  letter: 'letter',
  a4: 'A4',
  legal: 'legal',
  tabloid: 'ledger',
};

export function printPageCss(options: PrintOptions): string {
  const geometry = pageGeometry(options.paper, options.orientation, options.margin ?? 'normal');
  // Two `size` declarations on purpose: the mm pair is the fallback for
  // engines without the named size; where both parse (Chrome/Edge), the later
  // keyword+orientation wins and pins the PDF page orientation itself, so a
  // landscape job stays landscape through PDF-printer drivers instead of
  // arriving rotated.
  return [
    `@page { size: ${geometry.paperWidthMm}mm ${geometry.paperHeightMm}mm; size: ${PAPER_CSS_KEYWORD[options.paper]} ${options.orientation}; margin: 0; }`,
    '@media print {',
    '  body.rcd-printing .rcd-print-sheet {',
    `    width: ${geometry.paperWidthMm}mm !important;`,
    `    height: calc(${geometry.paperHeightMm}mm - 1px) !important;`,
    `    padding: ${geometry.marginMm}mm !important;`,
    // Auto side margins are zero when the destination page equals our @page
    // size; on a driver's wider stock they keep the sheet centered instead of
    // corner-pinned (mirrors .rcd-print-page in rcd.css).
    '    margin: 0 auto !important;',
    '  }',
    '}',
  ].join('\n');
}

/* --------------------------------------------------- browser-dialog checklist
 * The browser's own print dialog re-asks for destination, paper, layout,
 * margins, scale and its header/footer strip — and any mismatch there
 * silently defeats the geometry above (printer drivers rescale mismatched
 * stock; the header strip overlays the page edge). The config dialog and the
 * preview toolbar both render this option-driven checklist so the words can
 * never drift from the chosen job.
 */
const PAPER_SHORT_LABEL: Record<PrintPaper, string> = {
  letter: 'Letter',
  a4: 'A4',
  legal: 'Legal',
  tabloid: 'Tabloid',
};

export function printBrowserChecklist(options: PrintOptions): string[] {
  return [
    'Destination: "Save as PDF" (for exact output)',
    `Paper: ${PAPER_SHORT_LABEL[options.paper]}`,
    `Layout: ${options.orientation === 'landscape' ? 'Landscape' : 'Portrait'}`,
    // 'Default' because @page { margin: 0 } IS the default the browser reads.
    'Margins: Default',
    'Scale: 100%',
    'Headers and footers: off',
  ];
}

/** Stock physical printers rarely hold — drivers then silently rescale. */
export const isUncommonPaper = (paper: PrintPaper): boolean =>
  paper !== 'letter' && paper !== 'a4';
