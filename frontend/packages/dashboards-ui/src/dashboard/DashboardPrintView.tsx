import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import {
  isChartTile,
  isSlicerTile,
  type ChartSpec,
  type DashboardTile,
  type FilterClause,
} from '@recon/dashboards-core';
import { ChartTile } from '../chart/ChartTile';
import { useDashboardState } from '../provider/DashboardsProvider';
import { RcdButton } from '../primitives';
import type { PrintOptions, PrintOrientation, PrintPaper } from './PrintConfigDialog';

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

type ChartTileEntry = DashboardTile & { chart: ChartSpec };

/* ---------------------------------------------------------------- paper math
 * Content width = paper edge across the print direction minus the two 12mm
 * @page margins, converted at CSS 96dpi. Letter landscape:
 * (11in − 2 × 12mm/25.4) × 96 ≈ 965px. The sheet renders at this exact pixel
 * width so what you preview is what paginates.
 */
const DPI = 96;
const PAGE_MARGIN_MM = 12;
const MARGIN_IN = PAGE_MARGIN_MM / 25.4;

const PAPER_SIZES_IN: Record<PrintPaper, { short: number; long: number }> = {
  letter: { short: 8.5, long: 11 },
  a4: { short: 8.27, long: 11.69 },
  legal: { short: 8.5, long: 14 },
  tabloid: { short: 11, long: 17 },
};

const printableWidthPx = (paper: PrintPaper, orientation: PrintOrientation): number => {
  const size = PAPER_SIZES_IN[paper];
  const across = orientation === 'landscape' ? size.long : size.short;
  return Math.floor((across - 2 * MARGIN_IN) * DPI);
};

/* Grid-flow geometry mirrors DashboardGrid (24 cols, 32px rows, 12px gaps). */
const COLS = 24;
const ROW_H = 32;
const GAP = 12;

/* Sequential flow: natural height from the tile's grid rows, clamped. */
const SEQ_ROW_PX = 40;
const SEQ_MIN_H = 240;
const SEQ_MAX_H = 520;

/**
 * Light-theme token values hardcoded from rcd.css standalone defaults. Applied
 * INLINE on the overlay root so they beat both the dark-theme selector and any
 * host --color-* overrides — charts always print on light paper.
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

/** Human summary of a slicer/date clause for the printed filter line. */
const describeClause = (clause: FilterClause): string => {
  const values = clause.values.map((value) => String(value));
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

/**
 * Full-screen print preview overlay, portaled directly under <body> so the
 * @media print rules in rcd.css can hide every OTHER body child while
 * `body.rcd-printing` is set. Tiles re-render fresh ChartTiles with the same
 * spec/filters as on screen — the shared query cache serves them instantly.
 * Slicer tiles are excluded from print (their selections appear in the header
 * summary instead). Charts sit in fixed-pixel boxes so ResponsiveContainer
 * measures correctly on first paint.
 */
export function DashboardPrintView({
  title,
  tiles,
  modelId,
  filtersByTile,
  options,
  onClose,
}: DashboardPrintViewProps) {
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const crossFilter = useDashboardState((state) => state.crossFilter);

  const [timestamp] = useState(() => new Date().toLocaleString());

  // Flag the document for the print stylesheet while the overlay is open.
  useEffect(() => {
    document.body.classList.add('rcd-printing');
    return () => document.body.classList.remove('rcd-printing');
  }, []);

  // @page cannot be parameterized from a static stylesheet — inject the chosen
  // paper/orientation as a runtime <style> for the lifetime of the overlay.
  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-rcd-print', '');
    styleEl.textContent = `@page { size: ${options.paper} ${options.orientation}; margin: ${PAGE_MARGIN_MM}mm; }`;
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

  const contentW = printableWidthPx(options.paper, options.orientation);
  const scale = options.scale === 'fit' ? 1 : options.scale / 100;
  // The layout is built wider/narrower by 1/scale, then transformed back so
  // the printed strip is always exactly the page's content width.
  const layoutW = contentW / scale;

  const chartTiles = useMemo(() => tiles.filter(isChartTile), [tiles]);

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    for (const tile of tiles) {
      if (!isSlicerTile(tile)) continue;
      const clause = slicerValues[tile.id];
      if (!clause) continue;
      parts.push(`${tile.slicer.label}: ${describeClause(clause)}`);
    }
    if (crossFilter) parts.push(`Highlighted by ${crossFilter.label}`);
    return parts;
  }, [tiles, slicerValues, crossFilter]);

  const renderTileBody = (tile: ChartTileEntry) => (
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

  const tilesContent =
    chartTiles.length === 0 ? (
      <p className="py-10 text-center text-sm text-rcd-muted">
        This dashboard has no chart tiles to print.
      </p>
    ) : options.flow === 'grid' ? (
      computeBands(chartTiles).map((band, index) => {
        const colW = (layoutW - GAP * (COLS - 1)) / COLS;
        const bandH = (band.yEnd - band.yStart) * (ROW_H + GAP) - GAP;
        return (
          <ScaledBlock key={index} scale={scale} width={layoutW} height={bandH}>
            {band.tiles.map((tile) => (
              <div
                key={tile.id}
                className="absolute"
                style={{
                  left: tile.layout.x * (colW + GAP),
                  top: (tile.layout.y - band.yStart) * (ROW_H + GAP),
                  width: tile.layout.w * colW + (tile.layout.w - 1) * GAP,
                  height: tile.layout.h * ROW_H + (tile.layout.h - 1) * GAP,
                }}
              >
                {renderTileBody(tile)}
              </div>
            ))}
          </ScaledBlock>
        );
      })
    ) : (
      [...chartTiles]
        .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
        .map((tile) => (
          <ScaledBlock
            key={tile.id}
            scale={scale}
            width={layoutW}
            height={Math.min(SEQ_MAX_H, Math.max(SEQ_MIN_H, tile.layout.h * SEQ_ROW_PX))}
          >
            <div className="absolute inset-0">{renderTileBody(tile)}</div>
          </ScaledBlock>
        ))
    );

  const showHeader =
    options.includeTitle ||
    options.includeTimestamp ||
    (options.includeFilters && filterSummary.length > 0);

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
        {/* The white sheet: exactly the printable content width; the p-10
            "page margin" is visual only and stripped for print (@page adds
            the real 12mm margins). */}
        <div className="rcd-print-sheet mx-auto w-fit bg-white p-10 shadow-xl">
          <div style={{ width: contentW }}>
            {showHeader && (
              <header className="mb-4 flex flex-col gap-1">
                {options.includeTitle && (
                  <h1 className="text-xl font-semibold text-rcd-text">{title}</h1>
                )}
                {options.includeTimestamp && (
                  <p className="text-xs text-rcd-muted">Printed {timestamp}</p>
                )}
                {options.includeFilters && filterSummary.length > 0 && (
                  <p className="text-xs text-rcd-text-2">
                    <span className="font-medium">Active filters:</span>{' '}
                    {filterSummary.join(' · ')}
                  </p>
                )}
              </header>
            )}
            {tilesContent}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A pagination unit (grid band / sequential tile). The OUTER box is never
 * transformed, so break-inside: avoid still works when zoomed; the inner box
 * carries the layout size and the scale transform (top-left origin), and the
 * outer box reserves exactly the scaled footprint.
 */
function ScaledBlock({
  scale,
  width,
  height,
  children,
}: {
  scale: number;
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <div className="rcd-print-block mb-3" style={{ width: width * scale, height: height * scale }}>
      <div
        className="relative"
        style={{
          width,
          height,
          ...(scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'top left' } : null),
        }}
      >
        {children}
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
