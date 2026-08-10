import { useEffect, useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { isChartTile, type FilterClause } from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSelect } from '../primitives';
import { PrintSheets } from './DashboardPrintView';
import { computePrintLayout, filterSummaryFor } from './printLayout';

/** Paper stock the print pipeline can size (valid CSS `@page size` keywords). */
export type PrintPaper = 'letter' | 'a4' | 'legal' | 'tabloid';

export type PrintOrientation = 'landscape' | 'portrait';

/** 'grid' preserves the dashboard geometry; 'sequential' = one tile per row. */
export type PrintTileFlow = 'grid' | 'sequential';

/** Where the composed content sits inside the printable area. */
export type PrintAlignH = 'left' | 'center' | 'right';
export type PrintAlignV = 'top' | 'middle' | 'bottom';

export interface PrintOptions {
  paper: PrintPaper;
  orientation: PrintOrientation;
  /**
   * 'fit' lays tiles out at exactly the printable page width. A number is a
   * zoom percentage: 50 halves tile/text size (more content per page), 150
   * enlarges — the layout width compensates so the page width is always full.
   */
  scale: 'fit' | number;
  flow: PrintTileFlow;
  /**
   * Placement of the composed content inside the printable area. Horizontal
   * only has slack when the content is narrower than the page (a dashboard
   * that leaves grid columns empty, or a shrink-to-fit band); vertical has
   * slack on any page the content does not fill. Defaults reproduce the
   * historic top-left composition exactly.
   */
  alignH: PrintAlignH;
  alignV: PrintAlignV;
  includeTitle: boolean;
  includeTimestamp: boolean;
  includeFilters: boolean;
}

const DEFAULT_OPTIONS: PrintOptions = {
  paper: 'letter',
  orientation: 'landscape',
  scale: 'fit',
  flow: 'grid',
  alignH: 'left',
  alignV: 'top',
  includeTitle: true,
  includeTimestamp: true,
  includeFilters: true,
};

/** Session-scoped memory: reopening the dialog restores the last-used options. */
let sessionOptions: PrintOptions = { ...DEFAULT_OPTIONS };

const PAPER_OPTIONS: { value: PrintPaper; label: string }[] = [
  { value: 'letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
  { value: 'legal', label: 'Legal (8.5 × 14 in)' },
  { value: 'tabloid', label: 'Tabloid (11 × 17 in)' },
];

const ORIENTATION_OPTIONS: { value: PrintOrientation; label: string }[] = [
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait', label: 'Portrait' },
];

const SCALE_OPTIONS: { value: string; label: string }[] = [
  { value: 'fit', label: 'Fit to page width' },
  { value: '50', label: '50%' },
  { value: '75', label: '75%' },
  { value: '100', label: '100%' },
  { value: '125', label: '125%' },
  { value: '150', label: '150%' },
];

const FLOW_OPTIONS: { value: PrintTileFlow; label: string }[] = [
  { value: 'grid', label: 'Grid (match dashboard layout)' },
  { value: 'sequential', label: 'Sequential (one tile per row)' },
];

const ALIGN_H_OPTIONS: { value: PrintAlignH; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

const ALIGN_V_OPTIONS: { value: PrintAlignV; label: string }[] = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
];

/** Thumbnail budget (px); the sheet is transform-scaled to fit inside it. */
const THUMB_MAX_W = 460;
const THUMB_MAX_H = 350;

export interface PrintConfigDialogProps {
  open: boolean;
  onClose: () => void;
  /** "Open print preview": hand the chosen options to the print view. */
  onConfirm: (options: PrintOptions) => void;
}

/**
 * PDF-export configurator. The actual export uses the browser's print-to-PDF:
 * confirming mounts DashboardPrintView, which renders a print-quality copy of
 * the dashboard and calls window.print() on demand (no dependencies added).
 *
 * The right pane is a LIVE thumbnail of printed page 1: the same
 * computePrintLayout + PrintSheets the full preview uses, transform-scaled
 * down and non-interactive, re-rendering as settings change (charts come from
 * the warm query cache, so this is cheap).
 */
export function PrintConfigDialog({ open, onClose, onConfirm }: PrintConfigDialogProps) {
  const [draft, setDraft] = useState<PrintOptions>(() => ({ ...sessionOptions }));

  // Re-seed from the session memory each time the dialog opens.
  useEffect(() => {
    if (open) setDraft({ ...sessionOptions });
  }, [open]);

  // The thumbnail mirrors what DashboardView will hand the print view: the
  // ACTIVE page's tiles, the dashboard's model and the live per-tile filters.
  const runtime = useRuntime();
  const current = useDashboardState((state) => state.current);
  const activePageId = useDashboardState((state) => state.activePageId);
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const crossFilter = useDashboardState((state) => state.crossFilter);

  const pages = current?.layout.pages ?? [];
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0] ?? null;
  const tiles = useMemo(() => activePage?.tiles ?? [], [activePage]);
  const modelId = current?.modelId ?? null;
  const title =
    current === null
      ? 'Dashboard'
      : pages.length > 1 && activePage
        ? `${current.name} — ${activePage.name}`
        : current.name;

  // Same construction as DashboardView's filtersByTile: subscribed slices
  // (tiles/slicerValues/crossFilter) drive recomputation, filtersForTile reads
  // the exact same store state — never stale.
  const filtersByTile = useMemo(() => {
    const map = new Map<string, FilterClause[]>();
    for (const tile of tiles) {
      if (!isChartTile(tile)) continue;
      map.set(tile.id, runtime.dashboards.filtersForTile(tile.id));
    }
    return map;
  }, [runtime, tiles, slicerValues, crossFilter]);

  // Page count + thumbnail scale from the SAME pure layout the preview uses.
  const hasFilterSummary = useMemo(
    () => filterSummaryFor(tiles, slicerValues, crossFilter).length > 0,
    [tiles, slicerValues, crossFilter],
  );
  const layout = useMemo(
    () => computePrintLayout(tiles, draft, hasFilterSummary),
    [tiles, draft, hasFilterSummary],
  );
  const { geometry } = layout;
  const thumbScale = Math.min(
    THUMB_MAX_W / geometry.paperWidthPx,
    THUMB_MAX_H / geometry.paperHeightPx,
  );

  const patch = (partial: Partial<PrintOptions>) => setDraft((prev) => ({ ...prev, ...partial }));

  const confirm = () => {
    sessionOptions = { ...draft };
    onConfirm(draft);
  };

  return (
    <RcdDialog
      title="Export to PDF"
      open={open}
      onClose={onClose}
      wide
      draggable
      resizable
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton variant="primary" onClick={confirm}>
            <Printer size={14} />
            Open print preview
          </RcdButton>
        </>
      }
    >
      <div className="flex gap-5">
        {/* Settings column */}
        <div className="flex w-[17rem] shrink-0 flex-col gap-4">
          <p className="text-xs text-rcd-muted">
            Opens a print preview of this dashboard. Use your browser&apos;s print dialog with
            &ldquo;Save as PDF&rdquo; as the destination.
          </p>

          <div className="flex flex-col gap-3">
            <Field label="Paper size">
              <RcdSelect
                aria-label="Paper size"
                value={draft.paper}
                onChange={(event) => patch({ paper: event.target.value as PrintPaper })}
              >
                {PAPER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </RcdSelect>
            </Field>

            <Field label="Orientation">
              <RcdSelect
                aria-label="Orientation"
                value={draft.orientation}
                onChange={(event) =>
                  patch({ orientation: event.target.value as PrintOrientation })
                }
              >
                {ORIENTATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </RcdSelect>
            </Field>

            <Field label="Scale">
              <RcdSelect
                aria-label="Scale"
                value={draft.scale === 'fit' ? 'fit' : String(draft.scale)}
                onChange={(event) =>
                  patch({
                    scale: event.target.value === 'fit' ? 'fit' : Number(event.target.value),
                  })
                }
              >
                {SCALE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </RcdSelect>
            </Field>

            {/* Honest note where a "quality / DPI" control would otherwise go.
                This pipeline is the browser's own print-to-PDF: charts are
                SVG and text is text, so nothing here rasterizes and there is
                no app-side render scale that changes output resolution.
                Scale above is a real control (it changes how much content
                fits per page); a DPI dropdown would be a placebo. */}
            <p className="-mt-1 text-[11px] leading-4 text-rcd-muted">
              Charts and text export as <span className="font-medium">vector</span> graphics — the
              scale above changes how much fits on a page, not the resolution. Final DPI is
              decided by the printer or the &ldquo;Save as PDF&rdquo; settings in your
              browser&apos;s print dialog.
            </p>

            <Field label="Tile flow">
              <RcdSelect
                aria-label="Tile flow"
                value={draft.flow}
                onChange={(event) => patch({ flow: event.target.value as PrintTileFlow })}
              >
                {FLOW_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </RcdSelect>
            </Field>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs text-rcd-text-2">Content alignment</legend>
              <div className="flex gap-2">
                <Field label="Horizontal">
                  <RcdSelect
                    aria-label="Horizontal content alignment"
                    value={draft.alignH}
                    onChange={(event) => patch({ alignH: event.target.value as PrintAlignH })}
                  >
                    {ALIGN_H_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </RcdSelect>
                </Field>
                <Field label="Vertical">
                  <RcdSelect
                    aria-label="Vertical content alignment"
                    value={draft.alignV}
                    onChange={(event) => patch({ alignV: event.target.value as PrintAlignV })}
                  >
                    {ALIGN_V_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </RcdSelect>
                </Field>
              </div>
            </fieldset>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs text-rcd-text-2">Include</legend>
            <IncludeToggle
              label="Dashboard title"
              checked={draft.includeTitle}
              onChange={(next) => patch({ includeTitle: next })}
            />
            <IncludeToggle
              label="Timestamp"
              checked={draft.includeTimestamp}
              onChange={(next) => patch({ includeTimestamp: next })}
            />
            <IncludeToggle
              label="Active filters summary"
              checked={draft.includeFilters}
              onChange={(next) => patch({ includeFilters: next })}
            />
          </fieldset>
        </div>

        {/* Live preview column */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-xs text-rcd-text-2">
            Preview — page 1 of {layout.pages.length}
          </span>
          <div className="flex flex-1 items-start justify-center overflow-auto rounded-md border border-rcd-border bg-[#26262a] p-3">
            <div
              aria-hidden
              className="pointer-events-none select-none overflow-hidden"
              style={{
                width: geometry.paperWidthPx * thumbScale,
                height: geometry.paperHeightPx * thumbScale,
              }}
            >
              <div
                style={{
                  width: geometry.paperWidthPx,
                  transform: `scale(${thumbScale})`,
                  transformOrigin: 'top left',
                }}
              >
                <PrintSheets
                  title={title}
                  tiles={tiles}
                  modelId={modelId}
                  filtersByTile={filtersByTile}
                  options={draft}
                  maxPages={1}
                  showPageNumbers={false}
                />
              </div>
            </div>
          </div>
          <p className="text-[11px] leading-4 text-rcd-muted">
            The preview uses the exact printed page geometry — what you see here is page 1 of the
            PDF.
          </p>
          {/* Browsers give web pages no way to preselect a destination: an app
              "Printer" dropdown here could not do anything. Say so instead. */}
          <p className="text-[11px] leading-4 text-rcd-muted">
            Pick the printer (or <span className="font-medium">Save as PDF</span>) and its DPI in
            the browser print dialog that opens next — browsers do not let a web page choose it.
          </p>
        </div>
      </div>
    </RcdDialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-rcd-text-2">
      {label}
      {children}
    </label>
  );
}

function IncludeToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-rcd-text">
      <input
        type="checkbox"
        className="accent-[var(--rcd-accent)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
