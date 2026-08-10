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
import type { PrintOptions, PrintOrientation, PrintPaper } from './PrintConfigDialog';

/** A printable tile: chart, text, or image (slicers never print). */
export type ChartTileEntry = DashboardTile;

/* ---------------------------------------------------------------- paper math
 * All geometry is exact CSS px at 96dpi. The printed page box is declared via
 * an injected `@page { size: <W>mm <H>mm; margin: 12mm }`, so the printable
 * (content) area is the paper minus 12mm on every side. Content px are FLOORED
 * so the on-screen layout is always a hair inside the browser's printable
 * area — content can never spill onto a stray extra page.
 *
 * Content-area px per paper/orientation (width × height):
 *   letter   portrait  725 × 965    landscape  965 × 725
 *   a4       portrait  702 × 1031   landscape 1031 × 702
 *   legal    portrait  725 × 1253   landscape 1253 × 725
 *   tabloid  portrait  965 × 1541   landscape 1541 × 965
 */
export const PAGE_MARGIN_MM = 12;
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
  /** Full paper in px (content + margins) — the on-screen sheet size. */
  paperWidthPx: number;
  paperHeightPx: number;
  /** Printable content box in px (paper minus the 12mm margins, floored). */
  contentWidthPx: number;
  contentHeightPx: number;
  /** 12mm in px — the sheet's visual padding, 1:1 with the real margins. */
  marginPx: number;
}

export function pageGeometry(paper: PrintPaper, orientation: PrintOrientation): PageGeometry {
  const size = PAPER_SIZES_MM[paper];
  const paperWidthMm = orientation === 'landscape' ? size.long : size.short;
  const paperHeightMm = orientation === 'landscape' ? size.short : size.long;
  const contentWidthPx = Math.floor(mmToPx(paperWidthMm - 2 * PAGE_MARGIN_MM));
  const contentHeightPx = Math.floor(mmToPx(paperHeightMm - 2 * PAGE_MARGIN_MM));
  const marginPx = mmToPx(PAGE_MARGIN_MM);
  return {
    paperWidthMm,
    paperHeightMm,
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

/** Active slicer selections + cross-filter, as printable header chips. */
export function filterSummaryFor(
  tiles: DashboardTile[],
  slicerValues: SlicerValues,
  crossFilter: CrossFilter | null,
): string[] {
  const parts: string[] = [];
  for (const tile of tiles) {
    if (!isSlicerTile(tile)) continue;
    const clause = slicerClauseOf(slicerValues[tile.id]);
    if (!clause) continue;
    parts.push(`${tile.slicer.label}: ${describeClause(clause)}`);
  }
  if (crossFilter) parts.push(`Highlighted by ${crossFilter.label}`);
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
  /** User zoom (1 for 'fit'; N/100 otherwise). */
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
  const geometry = pageGeometry(options.paper, options.orientation);
  const userScale = options.scale === 'fit' ? 1 : options.scale / 100;
  const layoutWidth = geometry.contentWidthPx / userScale;
  const headerHeight = headerHeightPx(options, hasFilterSummary);
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
