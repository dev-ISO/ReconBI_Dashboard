import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { newId, type ButtonGroupButton, type ButtonGroupTileSpec } from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect } from '../primitives';
import {
  ButtonFieldsEditor,
  buttonFieldsOfDraft,
  draftFromButtonFields,
  type ButtonFieldsDraft,
} from './ButtonTileDialog';
import { buttonLabelText } from './ButtonVisual';

export interface ButtonGroupTileDialogProps {
  open: boolean;
  /** 'Add button group' (new tile) or 'Edit button group' (config card). */
  title: string;
  /** Prefill for the edit flow; null starts with one blank button. */
  initial: ButtonGroupTileSpec | null;
  /** The dashboard's pages (id + display name) for the target pickers. */
  pages: { id: string; name: string }[];
  onClose: () => void;
  onSave: (spec: ButtonGroupTileSpec) => void;
}

const DEFAULT_GAP = 8;
const MIN_GAP = 0;
const MAX_GAP = 48;

const clampGap = (raw: string): number => {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) return DEFAULT_GAP;
  return Math.min(Math.max(value, MIN_GAP), MAX_GAP);
};

/** One managed row: the shared button draft plus its stable id. */
type ButtonRowDraft = ButtonFieldsDraft & { id: string };

const rowFromButton = (button: ButtonGroupButton): ButtonRowDraft => ({
  id: button.id,
  ...draftFromButtonFields(button, button.targetPageId),
});

/**
 * Add/edit dialog for button-GROUP tiles (B3): a managed list of buttons —
 * add / duplicate / remove / reorder (up/down) — with one expandable
 * per-button editor (the ButtonFieldsEditor shared with the single-button
 * dialog: rich label with multiline off + lists off, target page, custom
 * colors, radius, advanced CSS + live preview), plus the group's packing
 * settings (direction, wrap, gap, alignment). The container background stays
 * on the tile's config card, mirroring the single-button split.
 */
export function ButtonGroupTileDialog({
  open,
  title,
  initial,
  pages,
  onClose,
  onSave,
}: ButtonGroupTileDialogProps) {
  const [rows, setRows] = useState<ButtonRowDraft[]>([]);
  const [direction, setDirection] = useState<ButtonGroupTileSpec['direction']>('row');
  const [wrap, setWrap] = useState(true);
  const [gapDraft, setGapDraft] = useState(String(DEFAULT_GAP));
  const [align, setAlign] = useState<ButtonGroupTileSpec['align']>('center');
  /** The one expanded row's id (compact list; new rows auto-expand). */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const blankRow = (): ButtonRowDraft => ({
    id: newId(),
    ...draftFromButtonFields(null, pages[0]?.id ?? ''),
  });

  // (Re)initialize ONLY on the closed→open EDGE — the ImageTileDialog rule
  // (see ButtonTileDialog): re-keying on `initial` identity would wipe
  // in-progress drafts when undo/redo mints fresh (equal) spec objects.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    const seeded = initial ? initial.buttons.map(rowFromButton) : [blankRow()];
    setRows(seeded);
    setDirection(initial?.direction ?? 'row');
    setWrap(initial?.wrap ?? true);
    setGapDraft(String(initial?.gap ?? DEFAULT_GAP));
    setAlign(initial?.align ?? 'center');
    setExpandedId(initial ? null : (seeded[0]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial, pages]);

  const patchRow = (id: string, patch: Partial<ButtonFieldsDraft>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const addRow = () => {
    const row = blankRow();
    setRows((prev) => [...prev, row]);
    setExpandedId(row.id);
  };

  const duplicateRow = (id: string) => {
    // Mint the id OUTSIDE the updater — updaters must stay pure (StrictMode
    // double-invokes them), and the expansion needs the same id anyway.
    const copyId = newId();
    setRows((prev) => {
      const index = prev.findIndex((row) => row.id === id);
      const source = prev[index];
      if (!source) return prev;
      const copy: ButtonRowDraft = { ...source, id: copyId };
      return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)];
    });
    setExpandedId(copyId);
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setExpandedId((current) => (current === id ? null : current));
  };

  const moveRow = (id: string, delta: -1 | 1) =>
    setRows((prev) => {
      const index = prev.findIndex((row) => row.id === id);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(index, 1);
      if (!row) return prev;
      next.splice(target, 0, row);
      return next;
    });

  const valid = rows.length > 0 && rows.every((row) => row.targetPageId !== '');

  const handleSave = () => {
    if (!valid) return;
    onSave({
      buttons: rows.map((row): ButtonGroupButton => ({ id: row.id, ...buttonFieldsOfDraft(row) })),
      direction,
      wrap,
      gap: clampGap(gapDraft),
      align,
      // Container background is the config card's; the edit flow keeps it.
      background: initial?.background ?? null,
    });
  };

  return (
    <RcdDialog
      title={title}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton variant="primary" onClick={handleSave} disabled={!valid}>
            {title === 'Edit button group' ? 'Apply' : 'Add'}
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* ------------------------------------------------ group packing */}
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Direction
            <RcdSelect
              value={direction}
              onChange={(event) =>
                setDirection(event.target.value as ButtonGroupTileSpec['direction'])
              }
            >
              <option value="row">Row</option>
              <option value="column">Column</option>
            </RcdSelect>
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Alignment
            <RcdSelect
              value={align}
              onChange={(event) => setAlign(event.target.value as ButtonGroupTileSpec['align'])}
            >
              <option value="start">Start</option>
              <option value="center">Center</option>
              <option value="end">End</option>
              <option value="stretch">Stretch</option>
            </RcdSelect>
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Gap (px)
            <RcdInput
              type="number"
              min={MIN_GAP}
              max={MAX_GAP}
              value={gapDraft}
              aria-label="Gap between buttons in pixels"
              onChange={(event) => setGapDraft(event.target.value)}
              // Clamp on BLUR, never mid-type (the NumberRow rule).
              onBlur={() => setGapDraft(String(clampGap(gapDraft)))}
              className="w-20"
            />
          </label>

          <label className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-rcd-text-2">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
              className="accent-[var(--rcd-accent)]"
            />
            Wrap onto new lines
          </label>
        </div>

        {/* ------------------------------------------------- buttons list */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-rcd-text-2">Buttons</span>
          {rows.map((row, index) => {
            const expanded = expandedId === row.id;
            const label = buttonLabelText({ html: row.html }) || 'Button';
            return (
              <div key={row.id} className="rounded-md border border-rcd-border">
                <div className="flex items-center gap-1 px-1.5 py-1">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} button ${label}`}
                    onClick={() => setExpandedId(expanded ? null : row.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    {expanded ? (
                      <ChevronDown size={14} className="shrink-0 text-rcd-muted" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-rcd-muted" />
                    )}
                    <span className="truncate">{label}</span>
                  </button>
                  <RcdIconButton
                    aria-label={`Move ${label} up`}
                    disabled={index === 0}
                    onClick={() => moveRow(row.id, -1)}
                  >
                    <ArrowUp size={13} />
                  </RcdIconButton>
                  <RcdIconButton
                    aria-label={`Move ${label} down`}
                    disabled={index === rows.length - 1}
                    onClick={() => moveRow(row.id, 1)}
                  >
                    <ArrowDown size={13} />
                  </RcdIconButton>
                  <RcdIconButton aria-label={`Duplicate ${label}`} onClick={() => duplicateRow(row.id)}>
                    <Copy size={13} />
                  </RcdIconButton>
                  <RcdIconButton
                    aria-label={`Remove ${label}`}
                    disabled={rows.length === 1}
                    onClick={() => removeRow(row.id)}
                  >
                    <Trash2 size={13} />
                  </RcdIconButton>
                </div>
                {expanded && (
                  <div className="border-t border-rcd-border px-2.5 py-2">
                    <ButtonFieldsEditor
                      draft={row}
                      onChange={(patch) => patchRow(row.id, patch)}
                      pages={pages}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <RcdButton onClick={addRow} className="self-start">
            <Plus size={14} />
            Add button
          </RcdButton>
        </div>
      </div>
    </RcdDialog>
  );
}
