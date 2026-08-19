import { useEffect, useRef, useState } from 'react';
import { sanitizeRichHtml, type ButtonTileSpec } from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';

export interface ButtonTileDialogProps {
  open: boolean;
  /** Dialog title: 'Add button' (new tile) or 'Edit button' (config card). */
  title: string;
  /** Prefill for the edit flow; null starts blank. */
  initial: ButtonTileSpec | null;
  /** The dashboard's pages (id + display name) for the target picker. */
  pages: { id: string; name: string }[];
  onClose: () => void;
  onSave: (spec: ButtonTileSpec) => void;
}

const DEFAULT_RADIUS = 8;
const MIN_RADIUS = 0;
const MAX_RADIUS = 40;

const DEFAULT_LABEL_HTML = '<p>Button</p>';

/**
 * Add/edit dialog for navigation-button tiles: a small rich-text label editor
 * (bold/size/color spans — the user explicitly wants rich labels), the target
 * page, corner radius, and the fill-tile switch. Background is owned by the
 * tile's config card (same split as the image tile's dialog).
 */
export function ButtonTileDialog({ open, title, initial, pages, onClose, onSave }: ButtonTileDialogProps) {
  const [html, setHtml] = useState('');
  const [targetPageId, setTargetPageId] = useState('');
  /** Radius as the input's raw text; clamped to [0, 40] on blur (NumberRow rule). */
  const [radiusDraft, setRadiusDraft] = useState(String(DEFAULT_RADIUS));
  const [fullSize, setFullSize] = useState(false);

  // (Re)initialize from the incoming spec ONLY on the closed→open EDGE —
  // the ImageTileDialog rule: keying on `initial`'s identity too would wipe
  // in-progress drafts whenever undo/redo elsewhere mints a fresh (equal)
  // spec object while the dialog is open.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setHtml(initial?.html ?? DEFAULT_LABEL_HTML);
    setTargetPageId(initial?.targetPageId ?? pages[0]?.id ?? '');
    setRadiusDraft(String(initial?.radius ?? DEFAULT_RADIUS));
    setFullSize(initial?.fullSize ?? false);
  }, [open, initial, pages]);

  const clampRadius = (raw: string): number => {
    const value = Math.trunc(Number(raw));
    if (!Number.isFinite(value)) return initial?.radius ?? DEFAULT_RADIUS;
    return Math.min(Math.max(value, MIN_RADIUS), MAX_RADIUS);
  };

  // A target the pages list no longer contains (broken link being edited):
  // surfaced as an explicit "(missing page)" option so the select never sits
  // silently blank while still holding the stale id.
  const targetMissing = targetPageId !== '' && !pages.some((page) => page.id === targetPageId);

  const valid = targetPageId !== '';

  const handleSave = () => {
    if (!valid) return;
    const sanitized = sanitizeRichHtml(html);
    const isEmpty = sanitized.replace(/<[^>]*>/g, '').trim() === '';
    onSave({
      html: isEmpty ? DEFAULT_LABEL_HTML : sanitized,
      targetPageId,
      radius: clampRadius(radiusDraft),
      ...(fullSize ? { fullSize: true } : {}),
      // Background is owned by the tile's config card; the edit flow keeps it.
      ...(initial?.background != null ? { background: initial.background } : {}),
    });
  };

  return (
    <RcdDialog
      title={title}
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton variant="primary" onClick={handleSave} disabled={!valid}>
            {title === 'Edit button' ? 'Apply' : 'Add'}
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-rcd-text-2">Label</span>
          {/* RcdDialog unmounts its children while closed, so this editor
              remounts (and re-seeds) on every open with the CURRENT html. */}
          <RichLabelEditor seedHtml={initial?.html ?? DEFAULT_LABEL_HTML} onChange={setHtml} />
        </div>

        <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
          Navigates to page
          <RcdSelect value={targetPageId} onChange={(event) => setTargetPageId(event.target.value)}>
            {targetMissing && (
              <option value={targetPageId} disabled>
                (missing page)
              </option>
            )}
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.name}
              </option>
            ))}
          </RcdSelect>
        </label>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs font-medium text-rcd-text-2">
            Corner radius (px)
            <RcdInput
              type="number"
              min={MIN_RADIUS}
              max={MAX_RADIUS}
              value={radiusDraft}
              aria-label="Button corner radius in pixels"
              onChange={(event) => setRadiusDraft(event.target.value)}
              // Clamp on BLUR, never mid-type (the NumberRow rule): clamping
              // per keystroke makes typing "12" impossible past "1".
              onBlur={() => setRadiusDraft(String(clampRadius(radiusDraft)))}
              className="w-20"
            />
          </label>

          <label className="flex items-center gap-1.5 text-xs font-medium text-rcd-text-2">
            <input
              type="checkbox"
              checked={fullSize}
              onChange={(event) => setFullSize(event.target.checked)}
              className="accent-[var(--rcd-accent)]"
            />
            Fill the whole tile
          </label>
        </div>
      </div>
    </RcdDialog>
  );
}

/* ---------------------------------------------------------------- editor */

const COLOR_INPUT_CLASS =
  'h-8 w-8 shrink-0 cursor-pointer rounded-md border border-rcd-border bg-transparent p-1';

/**
 * Small rich-text label editor (FormatPanel's RichTextDialog pattern). The
 * contentEditable is seeded imperatively EXACTLY ONCE on mount: React 19
 * re-applies dangerouslySetInnerHTML on every re-render (pinned in
 * test/contentEditable.test.tsx), and this component re-renders per keystroke
 * (onInput → onChange), so a rendered seed would overwrite typing mid-word.
 * After the one-time seed the browser owns the editor's DOM; React renders
 * the element childless and never touches its contents again.
 */
function RichLabelEditor({
  seedHtml,
  onChange,
}: {
  seedHtml: string;
  onChange: (html: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = sanitizeRichHtml(seedHtml);
    // Mount-only by design — see above; a changing seed must NOT re-stomp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exec = (command: string, value?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    try {
      document.execCommand('styleWithCSS', false, 'true');
    } catch {
      /* optional — <font> fallback output is normalized by the sanitizer */
    }
    try {
      document.execCommand(command, false, value);
    } catch {
      /* execCommand unavailable — formatting off, text editing still works */
    }
    onChange(editor.innerHTML);
  };

  const toolButton =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-rcd-border text-xs text-rcd-text-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Bold"
          className={`${toolButton} font-bold`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => exec('bold')}
        >
          B
        </button>
        <button
          type="button"
          aria-label="Italic"
          className={`${toolButton} italic`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => exec('italic')}
        >
          I
        </button>
        <button
          type="button"
          aria-label="Underline"
          className={`${toolButton} underline`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => exec('underline')}
        >
          U
        </button>
        <RcdSelect
          aria-label="Font size"
          value=""
          className="h-7 !px-1 !py-0 text-xs"
          onChange={(event) => {
            if (event.target.value !== '') exec('fontSize', event.target.value);
          }}
        >
          <option value="">Size</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="6">Huge</option>
        </RcdSelect>
        <input
          type="color"
          aria-label="Text color"
          defaultValue="#1f2937"
          className={COLOR_INPUT_CLASS}
          onInput={(event) => exec('foreColor', event.currentTarget.value)}
        />
      </div>
      <div
        ref={editorRef}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Button label rich text"
        className="min-h-[3rem] rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 text-sm text-rcd-text outline-none focus:border-rcd-accent"
        onInput={(event) => onChange(event.currentTarget.innerHTML)}
      />
    </div>
  );
}
