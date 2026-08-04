import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { RcdButton, RcdDialog, RcdSelect } from '../primitives';

/** Paper stock the print pipeline can size (valid CSS `@page size` keywords). */
export type PrintPaper = 'letter' | 'a4' | 'legal' | 'tabloid';

export type PrintOrientation = 'landscape' | 'portrait';

/** 'grid' preserves the dashboard geometry; 'sequential' = one tile per row. */
export type PrintTileFlow = 'grid' | 'sequential';

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
  includeTitle: boolean;
  includeTimestamp: boolean;
  includeFilters: boolean;
}

const DEFAULT_OPTIONS: PrintOptions = {
  paper: 'letter',
  orientation: 'landscape',
  scale: 'fit',
  flow: 'grid',
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
 */
export function PrintConfigDialog({ open, onClose, onConfirm }: PrintConfigDialogProps) {
  const [draft, setDraft] = useState<PrintOptions>(() => ({ ...sessionOptions }));

  // Re-seed from the session memory each time the dialog opens.
  useEffect(() => {
    if (open) setDraft({ ...sessionOptions });
  }, [open]);

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
      <div className="flex flex-col gap-4">
        <p className="text-xs text-rcd-muted">
          Opens a print preview of this dashboard. Use your browser&apos;s print dialog with
          &ldquo;Save as PDF&rdquo; as the destination.
        </p>

        <div className="grid grid-cols-2 gap-3">
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
              onChange={(event) => patch({ orientation: event.target.value as PrintOrientation })}
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
                patch({ scale: event.target.value === 'fit' ? 'fit' : Number(event.target.value) })
              }
            >
              {SCALE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </RcdSelect>
          </Field>

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
