import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import {
  isChartTile,
  isImageTile,
  isTextTile,
  type DashboardTile,
  type FilterClause,
} from '@recon/dashboards-core';
import { ChartTile } from '../chart/ChartTile';
import { TextTileContent } from './TextTile';
import { ImageTileContent } from './ImageTile';
import { useDashboardState } from '../provider/DashboardsProvider';
import { RcdButton } from '../primitives';
import type { PrintOptions } from './PrintConfigDialog';
import {
  computePrintLayout,
  filterSummaryFor,
  pageGeometry,
  PAGE_MARGIN_MM,
  type ChartTileEntry,
  type PrintBlock,
} from './printLayout';

export interface DashboardPrintViewProps {
  /** Dashboard name for the optional printed header. */
  title: string;
  tiles: DashboardTile[];
  modelId: number | null;
  /** The SAME per-tile filters the on-screen tiles use — identical cache keys. */
  filtersByTile: Map<string, FilterClause[]>;
  options: PrintOptions;
  onClose: () => void;
}

/**
 * Light-theme token values hardcoded from rcd.css standalone defaults. Applied
 * INLINE on the sheet-stack root so they beat both the dark-theme selector and
 * any host --color-* overrides — charts always print on light paper.
 */
const LIGHT_TOKENS = {
  '--rcd-bg': '#f9f9f7',
  '--rcd-surface': '#fcfcfb',
  '--rcd-text': '#0b0b0b',
  '--rcd-accent': '#2a78d6',
  '--rcd-text-2': '#52514e',
  '--rcd-muted': '#898781',
  '--rcd-border': 'rgba(11, 11, 11, 0.1)',
  '--rcd-grid-line': '#e1e0d9',
  '--rcd-axis': '#c3c2b7',
  '--rcd-cat-1': '#2a78d6',
  '--rcd-cat-2': '#eb6834',
  '--rcd-cat-3': '#1baf7a',
  '--rcd-cat-4': '#eda100',
  '--rcd-cat-5': '#e87ba4',
  '--rcd-cat-6': '#008300',
  '--rcd-cat-7': '#4a3aa7',
  '--rcd-cat-8': '#e34948',
  '--rcd-status-good': '#0ca30c',
  '--rcd-status-warn': '#fab219',
  '--rcd-status-serious': '#ec835a',
  '--rcd-status-critical': '#d03b3b',
} as CSSProperties;

const NO_FILTERS: FilterClause[] = [];

export interface PrintSheetsProps {
  title: string;
  tiles: DashboardTile[];
  modelId: number | null;
  filtersByTile: Map<string, FilterClause[]>;
  options: PrintOptions;
  /** Render at most this many pages (the dialog thumbnail passes 1). */
  maxPages?: number;
  /** On-screen "Page n of N" captions under each sheet (hidden in print). */
  showPageNumbers?: boolean;
}

/**
 * The paginated stack of paper sheets, shared by the full-screen preview and
 * the config dialog's live thumbnail (same computePrintLayout — same pages).
 * Every sheet is rendered at the paper's EXACT px size (96dpi) with the 12mm
 * margin as padding, so the on-screen preview is 1:1 with the printed page,
 * orientation included. Sheets are `pointer-events: none` — charts never
 * react to hover/click in a preview.
 */
export function PrintSheets({
  title,
  tiles,
  modelId,
  filtersByTile,
  options,
  maxPages,
  showPageNumbers = true,
}: PrintSheetsProps) {
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const crossFilter = useDashboardState((state) => state.crossFilter);
  const [timestamp] = useState(() => new Date().toLocaleString());

  const filterSummary = useMemo(
    () => filterSummaryFor(tiles, slicerValues, crossFilter),
    [tiles, slicerValues, crossFilter],
  );

  const layout = useMemo(
    () => computePrintLayout(tiles, options, filterSummary.length > 0),
    [tiles, options, filterSummary],
  );
  const { geometry } = layout;
  const isEmpty = layout.pages.every((page) => page.blocks.length === 0);
  const totalPages = layout.pages.length;
  const visiblePages =
    maxPages !== undefined ? layout.pages.slice(0, Math.max(1, maxPages)) : layout.pages;

  const renderTileBody = (tile: ChartTileEntry) => {
    if (isTextTile(tile)) {
      return (
        <div className="h-full w-full overflow-hidden p-1">
          <TextTileContent spec={tile.text} />
        </div>
      );
    }
    if (isImageTile(tile)) {
      return (
        <div className="h-full w-full overflow-hidden">
          <ImageTileContent spec={tile.image} />
        </div>
      );
    }
    if (!isChartTile(tile)) return null;
    return (
      <PrintTileBox title={tile.chart.title}>
        {modelId === null ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-rcd-muted">
            No model attached to this dashboard.
          </div>
        ) : (
          <ChartTile
            spec={tile.chart}
            modelId={modelId}
            filters={filtersByTile.get(tile.id) ?? NO_FILTERS}
            activeCategory={
              crossFilter && crossFilter.sourceTileId === tile.id
                ? { label: crossFilter.categoryLabel }
                : null
            }
          />
        )}
      </PrintTileBox>
    );
  };

  return (
    <div className="rcd-print-pages" style={LIGHT_TOKENS}>
      {visiblePages.map((page, pageIndex) => (
        <div key={pageIndex} className="rcd-print-page mx-auto mb-6 w-fit last:mb-0">
          {/* The white sheet: full paper px; the padding IS the 12mm margin
              (visual 1:1). For print the padding/height are stripped — @page
              applies the real margins and the content defines the height. */}
          <section
            aria-label={`Page ${pageIndex + 1} of ${totalPages}`}
            className="rcd-print-sheet pointer-events-none select-none bg-white shadow-xl"
            style={{
              width: geometry.paperWidthPx,
              height: geometry.paperHeightPx,
              padding: geometry.marginPx,
            }}
          >
            <div
              className="rcd-print-sheet-inner overflow-hidden"
              style={{ width: geometry.contentWidthPx, height: geometry.contentHeightPx }}
            >
              {pageIndex === 0 && layout.headerHeight > 0 && (
                /* Fixed line heights + truncate: the header's height must match
                   headerHeightPx exactly or pagination drifts. */
                <header className="mb-4 flex flex-col gap-1">
                  {options.includeTitle && (
                    <h1 className="truncate text-xl font-semibold leading-7 text-rcd-text">
                      {title}
                    </h1>
                  )}
                  {options.includeTimestamp && (
                    <p className="truncate text-xs leading-4 text-rcd-muted">Printed {timestamp}</p>
                  )}
                  {options.includeFilters && filterSummary.length > 0 && (
                    <p
                      className="truncate text-xs leading-4 text-rcd-text-2"
                      title={filterSummary.join(' · ')}
                    >
                      <span className="font-medium">Active filters:</span>{' '}
                      {filterSummary.join(' · ')}
                    </p>
                  )}
                </header>
              )}
              {pageIndex === 0 && isEmpty && (
                <p className="py-10 text-center text-sm text-rcd-muted">
                  This dashboard has no chart tiles to print.
                </p>
              )}
              {page.blocks.map((block) => (
                <BlockBox key={block.key} block={block} render={renderTileBody} />
              ))}
            </div>
          </section>
          {showPageNumbers && (
            <p className="rcd-print-pagenum mt-1.5 text-center text-xs text-white/60">
              Page {pageIndex + 1} of {totalPages}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One pagination block. The OUTER box is in normal flow with the exact scaled
 * footprint (so in-flow stacking reproduces the pure pagination math on screen
 * AND in print); the inner box carries the layout size and the transform
 * (top-left origin). Tiles sit at fixed pixel rects — nothing is percentage-
 * sized, so charts can never overflow their boxes.
 */
function BlockBox({
  block,
  render,
}: {
  block: PrintBlock;
  render: (tile: ChartTileEntry) => ReactNode;
}) {
  return (
    <div
      className="overflow-hidden"
      style={{ width: block.width, height: block.height, marginTop: block.marginTop }}
    >
      <div
        className="relative"
        style={{
          width: block.layoutWidth,
          height: block.layoutHeight,
          ...(block.scale !== 1
            ? { transform: `scale(${block.scale})`, transformOrigin: 'top left' }
            : null),
        }}
      >
        {block.tiles.map((placed) => (
          <div
            key={placed.tile.id}
            className="absolute overflow-hidden"
            style={{
              left: placed.left,
              top: placed.top,
              width: placed.width,
              height: placed.height,
            }}
          >
            {render(placed.tile)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Minimal print tile chrome (no drag handle / kebab / hover affordances). */
function PrintTileBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface">
      <div className="border-b border-rcd-border px-2.5 py-1">
        <span className="block truncate text-sm font-medium text-rcd-text" title={title}>
          {title}
        </span>
      </div>
      <div className="min-h-0 flex-1 p-2">{children}</div>
    </div>
  );
}

/**
 * Full-screen print preview overlay, portaled directly under <body> so the
 * @media print rules in rcd.css can hide every OTHER body child while
 * `body.rcd-printing` is set. Tiles re-render fresh ChartTiles with the same
 * spec/filters as on screen — the shared query cache serves them instantly.
 * Slicer tiles are excluded from print (their selections appear in the header
 * summary instead).
 */
export function DashboardPrintView({
  title,
  tiles,
  modelId,
  filtersByTile,
  options,
  onClose,
}: DashboardPrintViewProps) {
  // Flag the document for the print stylesheet while the overlay is open.
  useEffect(() => {
    document.body.classList.add('rcd-printing');
    return () => document.body.classList.remove('rcd-printing');
  }, []);

  // @page cannot be parameterized from a static stylesheet — inject the chosen
  // paper/orientation as a runtime <style> for the lifetime of the overlay.
  // EXPLICIT mm dimension pairs (width first — landscape = wider first): Chrome
  // honors dimension pairs far more reliably than the orientation keywords.
  // Pinning html/body to the printable width keeps the print layout engine at
  // the exact width the sheets were computed for.
  useEffect(() => {
    const geometry = pageGeometry(options.paper, options.orientation);
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-rcd-print', '');
    styleEl.textContent = [
      `@page { size: ${geometry.paperWidthMm}mm ${geometry.paperHeightMm}mm; margin: ${PAGE_MARGIN_MM}mm; }`,
      '@media print {',
      `  html, body { width: ${geometry.contentWidthPx}px !important; height: auto !important; }`,
      '}',
    ].join('\n');
    document.head.appendChild(styleEl);
    return () => styleEl.remove();
  }, [options.paper, options.orientation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="rcd-root rcd-print-view fixed inset-0 z-[100] overflow-auto"
      style={{ ...LIGHT_TOKENS, backgroundColor: 'rgba(24, 24, 26, 0.85)' }}
      data-print="true"
      role="dialog"
      aria-modal="true"
      aria-label={`Print preview: ${title}`}
    >
      {/* On-screen toolbar; hidden by the @media print rules. */}
      <div className="rcd-print-toolbar sticky top-0 z-10 flex items-center gap-3 bg-[#1c1c1f] px-4 py-2.5 shadow-md">
        <span className="shrink-0 text-sm font-semibold text-white">Print preview</span>
        <span className="hidden min-w-0 truncate text-xs text-white/60 sm:inline">
          Use &ldquo;Save as PDF&rdquo; as the destination in the print dialog.
        </span>
        <div className="min-w-0 flex-1" />
        <RcdButton variant="primary" onClick={() => window.print()}>
          <Printer size={14} />
          Print
        </RcdButton>
        <button
          type="button"
          aria-label="Close print preview"
          onClick={onClose}
          className="rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>

      <div className="rcd-print-stage p-6">
        <PrintSheets
          title={title}
          tiles={tiles}
          modelId={modelId}
          filtersByTile={filtersByTile}
          options={options}
        />
      </div>
    </div>,
    document.body,
  );
}
