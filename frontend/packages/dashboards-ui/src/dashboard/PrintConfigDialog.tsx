import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { RcdButton, RcdDialog, RcdSelect } from '../primitives';
import { PrintSheets } from './DashboardPrintView';
import { computePrintJob, isUncommonPaper, printBrowserChecklist } from './printLayout';
import { usePrintSections } from './usePrintSections';

/** Paper stock the print pipeline can size (valid CSS `@page size` keywords). */
export type PrintPaper = 'letter' | 'a4' | 'legal' | 'tabloid';

export type PrintOrientation = 'landscape' | 'portrait';

/** 'grid' preserves the dashboard geometry; 'sequential' = one tile per row. */
export type PrintTileFlow = 'grid' | 'sequential';

/**
 * Page-margin preset, applied to all four sides. 'normal' is the historic
 * hard-coded 12mm; 'narrow' halves it; 'none' hands the whole sheet to
 * content (@page prints edge-to-edge — physical printers still clip their
 * unprintable border, so 'none' is really a save-as-PDF affordance).
 */
export type PrintMargin = 'normal' | 'narrow' | 'none';

/** Where the composed content sits inside the printable area. */
export type PrintAlignH = 'left' | 'center' | 'right';
export type PrintAlignV = 'top' | 'middle' | 'bottom';

/**
 * Which dashboard pages the job includes (workbook-style printing):
 * 'current' = today's behavior (the active page only), 'all' = every page tab
 * in order, 'custom' = the checked subset of tabs (customPageIds).
 */
export type PrintPagesMode = 'current' | 'all' | 'custom';

export interface PrintOptions {
  paper: PrintPaper;
  orientation: PrintOrientation;
  /** Margin preset — decides the printable area every layout number uses. */
  margin: PrintMargin;
  /**
   * 'fit' lays tiles out at the printable page width, then grows the WHOLE
   * job by one uniform factor (capped at 2×) until the tightest page runs out
   * of width or height — small dashboards actually fill the paper. A number
   * is a zoom percentage: 50 halves tile/text size (more content per page),
   * 150 enlarges — the layout width compensates so the page width is always
   * full.
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
  /** Workbook scope: which dashboard pages join the job. */
  pagesMode: PrintPagesMode;
  /**
   * Custom pick (pagesMode 'custom'): dashboard page ids to include. Consumed
   * in TAB order regardless of check order; ids are intersected with the open
   * dashboard's tabs (session memory may carry another dashboard's ids) and an
   * empty intersection falls back to the current page.
   */
  customPageIds: string[];
  includeTitle: boolean;
  includeTimestamp: boolean;
  includeFilters: boolean;
}

const DEFAULT_OPTIONS: PrintOptions = {
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

const MARGIN_OPTIONS: { value: PrintMargin; label: string }[] = [
  { value: 'normal', label: 'Normal (12 mm)' },
  { value: 'narrow', label: 'Narrow (6 mm)' },
  { value: 'none', label: 'None' },
];

const SCALE_OPTIONS: { value: string; label: string }[] = [
  { value: 'fit', label: 'Fit to page' },
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

const PAGES_MODE_OPTIONS: { value: PrintPagesMode; label: string }[] = [
  { value: 'current', label: 'Current page' },
  { value: 'all', label: 'All dashboard pages' },
  { value: 'custom', label: 'Custom…' },
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
 * The right pane is a LIVE, NAVIGABLE thumbnail of the printed job: the same
 * usePrintSections + computePrintJob + PrintSheets the full preview uses,
 * transform-scaled down and non-interactive. Any physical page of the job can
 * be shown (arrows, ArrowLeft/ArrowRight while the preview is focused, or a
 * typed page number), and the page count tracks every option live — including
 * workbook jobs that span several dashboard pages.
 */
export function PrintConfigDialog({ open, onClose, onConfirm }: PrintConfigDialogProps) {
  const [draft, setDraft] = useState<PrintOptions>(() => ({ ...sessionOptions }));

  // Re-seed from the session memory each time the dialog opens.
  useEffect(() => {
    if (open) setDraft({ ...sessionOptions });
  }, [open]);

  // The thumbnail mirrors what DashboardPrintView will print: the SAME hook
  // resolves the included pages, per-section headers and per-tile filters.
  const { sections, filtersByTile, modelId, pageTabs, activePageId } = usePrintSections(draft);

  // Page count + geometry from the SAME pure job the preview prints.
  const job = useMemo(() => computePrintJob(sections, draft), [sections, draft]);
  const totalPages = job.totalPages;
  const { geometry } = job;
  const thumbScale = Math.min(
    THUMB_MAX_W / geometry.paperWidthPx,
    THUMB_MAX_H / geometry.paperHeightPx,
  );

  /* ----------------------------------------------------- preview navigation
   * previewPage is 1-based and ALWAYS valid: option changes clamp it into the
   * new page count, and changing WHICH dashboard pages are included resets to
   * page 1 (the job's content changed wholesale). pageText is the type-in
   * buffer — it only commits on Enter/blur, clamped.
   */
  const [previewPage, setPreviewPage] = useState(1);
  const [pageText, setPageText] = useState('1');

  const goTo = (page: number) => {
    const clamped = Math.min(Math.max(1, Math.round(page)), Math.max(1, totalPages));
    setPreviewPage(clamped);
    setPageText(String(clamped));
  };

  // Reset on open and whenever the included-pages set changes.
  const sectionsKey = `${draft.pagesMode}|${sections.map((s) => s.pageId).join(',')}`;
  const lastKey = useRef(sectionsKey);
  useEffect(() => {
    if (open) {
      setPreviewPage(1);
      setPageText('1');
    }
  }, [open]);
  useEffect(() => {
    if (lastKey.current !== sectionsKey) {
      lastKey.current = sectionsKey;
      setPreviewPage(1);
      setPageText('1');
    }
  }, [sectionsKey]);

  // Clamp when paper/orientation/scale/flow changes shrink the page count.
  useEffect(() => {
    if (previewPage > totalPages) {
      setPreviewPage(Math.max(1, totalPages));
      setPageText(String(Math.max(1, totalPages)));
    }
  }, [previewPage, totalPages]);

  const commitPageText = () => {
    const parsed = Number.parseInt(pageText, 10);
    if (Number.isNaN(parsed)) setPageText(String(previewPage));
    else goTo(parsed);
  };

  const patch = (partial: Partial<PrintOptions>) => setDraft((prev) => ({ ...prev, ...partial }));

  const setPagesMode = (mode: PrintPagesMode) => {
    if (mode === 'custom') {
      // Seed an empty/stale custom pick with the current page so the
      // checklist never silently means "nothing".
      const valid = draft.customPageIds.filter((id) => pageTabs.some((tab) => tab.id === id));
      patch({
        pagesMode: mode,
        customPageIds:
          valid.length > 0 ? valid : activePageId !== null ? [activePageId] : [],
      });
    } else {
      patch({ pagesMode: mode });
    }
  };

  const toggleCustomPage = (pageId: string, checked: boolean) => {
    const set = new Set(draft.customPageIds);
    if (checked) set.add(pageId);
    else set.delete(pageId);
    // Persist in TAB order — the job consumes tab order either way, but the
    // stored option stays deterministic.
    patch({ customPageIds: pageTabs.map((tab) => tab.id).filter((id) => set.has(id)) });
  };

  const customCount = pageTabs.filter((tab) => draft.customPageIds.includes(tab.id)).length;

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

            <Field label="Margins">
              <RcdSelect
                aria-label="Margins"
                value={draft.margin}
                onChange={(event) => patch({ margin: event.target.value as PrintMargin })}
              >
                {MARGIN_OPTIONS.map((option) => (
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

            {/* Workbook scope — only meaningful once the dashboard has tabs. */}
            {pageTabs.length > 1 && (
              <Field label="Pages to include">
                <RcdSelect
                  aria-label="Pages to include"
                  value={draft.pagesMode}
                  onChange={(event) => setPagesMode(event.target.value as PrintPagesMode)}
                >
                  {PAGES_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </RcdSelect>
              </Field>
            )}

            {pageTabs.length > 1 && draft.pagesMode === 'custom' && (
              <div className="flex flex-col gap-1">
                <div
                  className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-md border border-rcd-border p-2"
                  role="group"
                  aria-label="Dashboard pages to include"
                >
                  {pageTabs.map((tab) => (
                    <label
                      key={tab.id}
                      className="flex cursor-pointer items-center gap-2 text-sm text-rcd-text"
                    >
                      <input
                        type="checkbox"
                        className="accent-[var(--rcd-accent)]"
                        checked={draft.customPageIds.includes(tab.id)}
                        onChange={(event) => toggleCustomPage(tab.id, event.target.checked)}
                      />
                      <span className="min-w-0 truncate">{tab.name}</span>
                    </label>
                  ))}
                </div>
                {customCount === 0 && (
                  <p className="text-[11px] leading-4 text-rcd-muted">
                    Nothing checked — the current page will print.
                  </p>
                )}
              </div>
            )}
          </div>

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
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-rcd-text-2">Preview</span>
            <div className="flex-1" />
            <button
              type="button"
              aria-label="Previous page"
              disabled={previewPage <= 1}
              onClick={() => goTo(previewPage - 1)}
              className="rounded-md border border-rcd-border p-1 text-rcd-text-2 hover:bg-rcd-surface hover:text-rcd-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-rcd-text-2">Page</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="Preview page number"
              value={pageText}
              onChange={(event) => setPageText(event.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitPageText}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitPageText();
                }
              }}
              className="h-6 w-10 rounded-md border border-rcd-border bg-transparent text-center text-xs text-rcd-text outline-none focus:border-[var(--rcd-accent-interactive,var(--rcd-accent))]"
            />
            <span className="whitespace-nowrap text-xs text-rcd-text-2">of {totalPages}</span>
            <button
              type="button"
              aria-label="Next page"
              disabled={previewPage >= totalPages}
              onClick={() => goTo(previewPage + 1)}
              className="rounded-md border border-rcd-border p-1 text-rcd-text-2 hover:bg-rcd-surface hover:text-rcd-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          {/* Focusable so ArrowLeft/ArrowRight page the preview from the
              keyboard; the sheet itself stays non-interactive. */}
          <div
            role="region"
            aria-label={`Print preview, page ${previewPage} of ${totalPages}. Use arrow keys to change pages.`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                goTo(previewPage - 1);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                goTo(previewPage + 1);
              }
            }}
            className="flex flex-1 items-start justify-center overflow-auto rounded-md border border-rcd-border bg-[#26262a] p-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--rcd-accent-interactive,var(--rcd-accent))]"
          >
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
                  sections={sections}
                  modelId={modelId}
                  filtersByTile={filtersByTile}
                  options={draft}
                  onlyPage={previewPage - 1}
                  showPageNumbers={false}
                />
              </div>
            </div>
          </div>
          <p className="text-[11px] leading-4 text-rcd-muted">
            The preview uses the exact printed page geometry — every page here matches the PDF,
            page for page.
          </p>
          {/* Browsers give web pages no way to preset the print dialog (destination,
              stock, header strip…), and any mismatch there silently defeats the
              geometry above. Spell out the exact settings, driven by the current
              options so the words can never drift from the chosen job. */}
          <p className="text-[11px] leading-4 text-rcd-muted">
            In the browser dialog that opens next set:{' '}
            <span className="font-medium">{printBrowserChecklist(draft).join(' · ')}</span>.
          </p>
          {isUncommonPaper(draft.paper) && (
            <p className="text-[11px] leading-4 text-[var(--rcd-status-warn)]" role="alert">
              {draft.paper === 'legal' ? 'Legal' : 'Tabloid'} stock: physical printers silently
              rescale the page when the loaded paper does not match. Use{' '}
              <span className="font-medium">Save as PDF</span> for exact output.
            </p>
          )}
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
