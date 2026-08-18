import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import {
  isChartTile,
  isImageTile,
  isTextTile,
  sanitizeRichHtml,
  type ContainerStyle,
  type FilterClause,
} from '@recon/dashboards-core';
import { ChartTile } from '../chart/ChartTile';
import { INNER_TITLE_CLASSES } from './TileFrame';
import { TextTileContent } from './TextTile';
import { ImageTileContent } from './ImageTile';
import { useDashboardState } from '../provider/DashboardsProvider';
import { RcdButton } from '../primitives';
import type { PrintOptions } from './PrintConfigDialog';
import { usePrintSections } from './usePrintSections';
import {
  computePrintJob,
  pageGeometry,
  PAGE_MARGIN_MM,
  type ChartTileEntry,
  type PrintBlock,
  type PrintJobSection,
  type PrintSectionInput,
} from './printLayout';

export interface DashboardPrintViewProps {
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

/** PrintOptions alignment -> flex placement of the composed content. */
const VERTICAL_ALIGN = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
} as const;

const HORIZONTAL_ALIGN = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
} as const;

export interface PrintSheetsProps {
  /** Included dashboard pages, in tab order (usePrintSections builds these). */
  sections: PrintSectionInput[];
  modelId: number | null;
  filtersByTile: Map<string, FilterClause[]>;
  options: PrintOptions;
  /**
   * Render ONLY this zero-based physical page (the dialog thumbnail passes
   * the selected preview page); absent = render the whole job.
   */
  onlyPage?: number;
  /** On-screen "Page n of N" captions under each sheet (hidden in print). */
  showPageNumbers?: boolean;
}

/**
 * The paginated stack of paper sheets, shared by the full-screen preview and
 * the config dialog's live thumbnail (same computePrintJob — same pages).
 * Every sheet is rendered at the paper's EXACT px size (96dpi) with the 12mm
 * margin as padding, so the on-screen preview is 1:1 with the printed page,
 * orientation included. Sheets are `pointer-events: none` — charts never
 * react to hover/click in a preview.
 *
 * Workbook jobs: each section (dashboard page) starts on a fresh sheet, its
 * first sheet carries that page's own header (title/timestamp/filters per the
 * Include options), and physical page numbers run continuously.
 */
export function PrintSheets({
  sections,
  modelId,
  filtersByTile,
  options,
  onlyPage,
  showPageNumbers = true,
}: PrintSheetsProps) {
  const crossFilters = useDashboardState((state) => state.crossFilters);
  const [timestamp] = useState(() => new Date().toLocaleString());

  /**
   * Source-tile emphasis on paper mirrors the on-screen doctrine: only a
   * SINGLE-value filter marks its source (the renderer contract takes one
   * label; a multi-value set would mis-dim the other selected categories).
   */
  const sourceEmphasisFor = (tileId: string) => {
    let category: string | null = null;
    let legend: string | null = null;
    for (const cross of crossFilters) {
      if (cross.sourceTileId !== tileId) continue;
      const label = (cross.values?.length ?? 1) === 1 ? cross.categoryLabel : null;
      if ((cross.kind ?? 'axis') === 'axis') category = label;
      else legend = label;
    }
    return { category, legend };
  };

  const job = useMemo(() => computePrintJob(sections, options), [sections, options]);
  const { geometry, totalPages } = job;

  const renderTileBody = (tile: ChartTileEntry) => {
    if (isTextTile(tile)) {
      return (
        <div className="h-full w-full overflow-hidden p-1">
          {/* Paper cannot scroll: no auto-scroll, no reserved gutter. */}
          <TextTileContent spec={tile.text} scroll={false} />
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
    // Print renders the BASE chart spec: transient per-tile drill state lives
    // in the on-screen DashboardChartTile and is deliberately ignored here.
    return (
      <PrintTileBox title={tile.chart.title} container={tile.chart.format.container ?? null}>
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
              sourceEmphasisFor(tile.id).category !== null
                ? { label: sourceEmphasisFor(tile.id).category! }
                : null
            }
            selectedLegendLabel={sourceEmphasisFor(tile.id).legend}
          />
        )}
      </PrintTileBox>
    );
  };

  const renderSheet = (section: PrintJobSection, localIndex: number) => {
    const { layout } = section;
    const page = layout.pages[localIndex]!;
    const pageIndex = section.startPage + localIndex; // zero-based, job-wide
    const sectionIsEmpty = layout.pages.every((p) => p.blocks.length === 0);
    return (
      <div
        key={`${section.pageId || 'section'}-${localIndex}`}
        className="rcd-print-page mx-auto mb-6 w-fit last:mb-0"
      >
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
            className="rcd-print-sheet-inner flex flex-col overflow-hidden"
            style={{
              width: geometry.contentWidthPx,
              height: geometry.contentHeightPx,
              // Composed-content placement inside the printable area. The
              // pagination math is unchanged (it measures from the top);
              // this only distributes the leftover slack. In PRINT the sheet
              // height goes auto, so DashboardPrintView injects a matching
              // min-height whenever the vertical setting is not 'top'.
              justifyContent: VERTICAL_ALIGN[options.alignV ?? 'top'],
              alignItems: HORIZONTAL_ALIGN[options.alignH ?? 'left'],
            }}
          >
            {localIndex === 0 && layout.headerHeight > 0 && (
              /* Fixed line heights + truncate: the header's height must match
                 headerHeightPx exactly or pagination drifts. Every section's
                 FIRST sheet carries its own header — the dashboard-page name
                 rides the title line, so a workbook job labels each page run. */
              <header
                className="mb-4 flex w-full shrink-0 flex-col gap-1"
                style={{ textAlign: options.alignH ?? 'left' }}
              >
                {options.includeTitle && (
                  <h1 className="truncate text-xl font-semibold leading-7 text-rcd-text">
                    {section.title}
                  </h1>
                )}
                {options.includeTimestamp && (
                  <p className="truncate text-xs leading-4 text-rcd-muted">Printed {timestamp}</p>
                )}
                {options.includeFilters && section.filterSummary.length > 0 && (
                  <p
                    className="truncate text-xs leading-4 text-rcd-text-2"
                    title={section.filterSummary.join(' · ')}
                  >
                    <span className="font-medium">Active filters:</span>{' '}
                    {section.filterSummary.join(' · ')}
                  </p>
                )}
              </header>
            )}
            {localIndex === 0 && sectionIsEmpty && (
              <p className="py-10 text-center text-sm text-rcd-muted">
                {job.sections.length > 1
                  ? 'This dashboard page has no chart tiles to print.'
                  : 'This dashboard has no chart tiles to print.'}
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
    );
  };

  return (
    <div className="rcd-print-pages" style={LIGHT_TOKENS}>
      {job.sections.map((section) =>
        section.layout.pages.map((_, localIndex) => {
          if (onlyPage !== undefined && section.startPage + localIndex !== onlyPage) return null;
          return renderSheet(section, localIndex);
        }),
      )}
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
      className="shrink-0 overflow-hidden"
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

/**
 * Minimal print tile chrome (no drag handle / kebab / hover affordances),
 * honoring the tile's container customization the way TileFrame does on
 * screen: hideHeader drops the header bar (frameless tiles would otherwise
 * print a title bar they never show), and a rich inner title renders
 * sanitized above the body — so printed built-ins keep their bold lead-in +
 * description instead of showing the bare chart.title.
 */
function PrintTileBox({
  title,
  container,
  children,
}: {
  title: string;
  container: ContainerStyle | null;
  children: ReactNode;
}) {
  const hideHeader = container?.hideHeader === true;
  // Sanitize-before-inject, same second-belt doctrine as TileFrame (print
  // renders rarely — no memo needed).
  const innerTitleSafe = sanitizeRichHtml(container?.innerTitleHtml ?? '');
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-rcd-border bg-rcd-surface">
      {!hideHeader && (
        <div className="border-b border-rcd-border px-2.5 py-1">
          <span className="block truncate text-sm font-medium text-rcd-text" title={title}>
            {title}
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {innerTitleSafe !== '' && (
          <div
            className={INNER_TITLE_CLASSES}
            dangerouslySetInnerHTML={{ __html: innerTitleSafe }}
          />
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

/**
 * Full-screen print preview overlay, portaled directly under <body> so the
 * @media print rules in rcd.css can hide every OTHER body child while
 * `body.rcd-printing` is set. Content (which dashboard pages, their tiles and
 * filters) comes from usePrintSections — the exact hook the config dialog's
 * thumbnail used, so this overlay always shows the job that was previewed.
 * Tiles re-render fresh ChartTiles with the same spec/filters as on screen —
 * the shared query cache serves them instantly. Slicer tiles are excluded from
 * print (their selections appear in the header summary instead).
 */
export function DashboardPrintView({ options, onClose }: DashboardPrintViewProps) {
  const { sections, filtersByTile, modelId } = usePrintSections(options);

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
    // Vertical content alignment needs a page-tall box to distribute slack in,
    // but the print rules deliberately let each sheet go height:auto (so a
    // rounding hair can never spill onto a blank page). Re-establish the box
    // as a MIN-height, one pixel shy of the @page content area, and only when
    // the setting actually asks for it — 'top' stays byte-identical to before.
    const contentHeightMm = geometry.paperHeightMm - 2 * PAGE_MARGIN_MM;
    const alignV = options.alignV ?? 'top';
    styleEl.textContent = [
      `@page { size: ${geometry.paperWidthMm}mm ${geometry.paperHeightMm}mm; margin: ${PAGE_MARGIN_MM}mm; }`,
      '@media print {',
      `  html, body { width: ${geometry.contentWidthPx}px !important; height: auto !important; }`,
      ...(alignV === 'top'
        ? []
        : [
            '  body.rcd-printing .rcd-print-sheet-inner {',
            `    min-height: calc(${contentHeightMm}mm - 1px) !important;`,
            '  }',
          ]),
      '}',
    ].join('\n');
    document.head.appendChild(styleEl);
    return () => styleEl.remove();
  }, [options.paper, options.orientation, options.alignV]);

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
      aria-label={`Print preview: ${sections[0]?.title ?? 'Dashboard'}`}
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
          sections={sections}
          modelId={modelId}
          filtersByTile={filtersByTile}
          options={options}
        />
      </div>
    </div>,
    document.body,
  );
}
