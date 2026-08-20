import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { newId, type ButtonGroupButton, type ButtonGroupTileSpec } from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect } from '../primitives';
import {
  ButtonColorField,
  ButtonFieldsEditor,
  buttonFieldsOfDraft,
  draftFromButtonFields,
  readButtonRecentColors,
  rememberButtonRecentColor,
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
  const [justify, setJustify] = useState<NonNullable<ButtonGroupTileSpec['justify']>>('left');
  const [size, setSize] = useState<NonNullable<ButtonGroupTileSpec['size']>>('md');
  const [variant, setVariant] = useState<NonNullable<ButtonGroupTileSpec['variant']>>('default');
  const [equalWidth, setEqualWidth] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  /** A1: false = the legacy frameless look; true = the standard tile frame. */
  const [framed, setFramed] = useState(false);
  /** The one expanded row's id (compact list; new rows auto-expand). */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Recent colors for the apply-to-all control (shared storage key). */
  const [recents, setRecents] = useState<string[]>(() => readButtonRecentColors());

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
    setJustify(initial?.justify ?? 'left');
    setSize(initial?.size ?? 'md');
    setVariant(initial?.variant ?? 'default');
    setEqualWidth(initial?.equalWidth ?? false);
    setGroupTitle(initial?.title ?? '');
    // EXISTING group: an absent container is the legacy frameless look and is
    // preserved (see groupContainerStyle). NEW group: framed by default — D1's
    // "toolbar bar" is a tile that reads as one deliberate element, and the
    // author can untick it. This only sets the CHECKBOX; the render default
    // for a spec with no container stays frameless.
    setFramed(initial ? initial.container != null && initial.container.hideHeader !== true : true);
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

  /** A4: the owner styles N buttons one row at a time today. */
  const applyFillToAll = (background: string | null) =>
    setRows((previous) => previous.map((row) => ({ ...row, background })));

  /** The fill every row already shares (null when they differ or are default). */
  const commonFill = (() => {
    const first = rows[0]?.background ?? null;
    return rows.every((row) => (row.background ?? null) === first) ? first : null;
  })();

  const handleSave = () => {
    if (!valid) return;
    // EVERY field explicit, null/false/'' included: updateButtonGroupTile is a
    // SHALLOW spread-merge, so an omitted key silently keeps the old value
    // (the reason the old dialog could never turn fullSize back off). The
    // nested container is replaced WHOLESALE, so it is emitted whole — the
    // spread preserves fields this dialog does not author (a hand-set border,
    // an innerTitleHtml) instead of dropping them.
    onSave({
      buttons: rows.map((row): ButtonGroupButton => ({ id: row.id, ...buttonFieldsOfDraft(row) })),
      direction,
      wrap,
      gap: clampGap(gapDraft),
      align,
      justify,
      size,
      variant,
      equalWidth,
      title: groupTitle.trim(),
      container: { ...initial?.container, hideHeader: !framed },
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
        {/* --------------------------------------------------- container */}
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Title
            <RcdInput
              value={groupTitle}
              placeholder="Button group"
              aria-label="Button group title"
              onChange={(event) => setGroupTitle(event.target.value)}
            />
          </label>

          {/* A1: groups authored before 0.14.1 have no container at all and
              keep their frameless look; ticking this gives the tile the same
              frame every other element can show. */}
          <label className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-rcd-text-2">
            <input
              type="checkbox"
              checked={framed}
              onChange={(event) => setFramed(event.target.checked)}
              className="accent-[var(--rcd-accent)]"
            />
            Show tile container (frame + title bar)
          </label>
        </div>

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

          {/* A2: "Alignment" used to mean alignItems — the CROSS axis — while
              the main axis was never set at all, which is why the control felt
              arbitrary. The pair is now labelled by the axis it moves. */}
          <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Position (across)
            <RcdSelect
              value={justify}
              aria-label="Position across the container"
              onChange={(event) =>
                setJustify(event.target.value as NonNullable<ButtonGroupTileSpec['justify']>)
              }
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
              <option value="between">Space between</option>
            </RcdSelect>
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Align (down)
            <RcdSelect
              value={align}
              aria-label="Align down the container"
              onChange={(event) => setAlign(event.target.value as ButtonGroupTileSpec['align'])}
            >
              <option value="start">Top</option>
              <option value="center">Middle</option>
              <option value="end">Bottom</option>
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

        {/* ------------------------------------------- toolbar look (A6) */}
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Button size
            <RcdSelect
              value={size}
              aria-label="Button size"
              onChange={(event) =>
                setSize(event.target.value as NonNullable<ButtonGroupTileSpec['size']>)
              }
            >
              <option value="sm">Small</option>
              <option value="md">Medium</option>
              <option value="lg">Large</option>
            </RcdSelect>
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
            Button style
            <RcdSelect
              value={variant}
              aria-label="Button style"
              onChange={(event) =>
                setVariant(event.target.value as NonNullable<ButtonGroupTileSpec['variant']>)
              }
            >
              <option value="default">Outline</option>
              <option value="primary">Accent</option>
              <option value="ghost">Ghost</option>
            </RcdSelect>
          </label>

          <label className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-rcd-text-2">
            <input
              type="checkbox"
              checked={equalWidth}
              onChange={(event) => setEqualWidth(event.target.checked)}
              className="accent-[var(--rcd-accent)]"
            />
            Equal button widths
          </label>
        </div>

        {/* A4: style N buttons at once instead of one expanded row at a time. */}
        <div className="flex flex-wrap items-start gap-4 rounded-md border border-rcd-border px-2.5 py-2">
          <ButtonColorField
            label="Apply fill to all buttons"
            hint={`Sets the fill on all ${rows.length} button${rows.length === 1 ? '' : 's'} at once.`}
            value={commonFill}
            onChange={applyFillToAll}
            recents={recents}
            onRemember={(hex) => setRecents(rememberButtonRecentColor(hex))}
          />
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
                      previewSize={size}
                      previewVariant={variant}
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
