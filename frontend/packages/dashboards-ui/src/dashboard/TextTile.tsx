import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  RemoveFormatting,
  Strikethrough,
  Trash2,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import { sanitizeRichHtml, type TextTileSpec } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdInput, RcdSelect } from '../primitives';
import { TileBackgroundSwatches } from './TileBackgroundSwatches';
import { TileFrame } from './TileFrame';

export interface TextTileProps {
  tileId: string;
  spec: TextTileSpec;
  /** Edit mode: framed + contentEditable; view mode renders frameless html. */
  editable: boolean;
}

/**
 * Element styling for the sanitized rich-text subset (Tailwind preflight
 * strips default margins/list styles). Arbitrary variants keep the classes
 * literal so any host Tailwind build generates them.
 */
const RICH_TEXT_CLASSES =
  'text-sm leading-snug text-rcd-text [overflow-wrap:anywhere] ' +
  '[&_a]:text-rcd-accent [&_a]:underline ' +
  '[&_h1]:my-1 [&_h1]:text-2xl [&_h1]:font-semibold ' +
  '[&_h2]:my-1 [&_h2]:text-xl [&_h2]:font-semibold ' +
  '[&_h3]:my-0.5 [&_h3]:text-lg [&_h3]:font-semibold ' +
  '[&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0.5 [&_ul]:list-disc [&_ul]:pl-5';

/**
 * The tile's content area SCROLLS instead of clipping: a text tile only two
 * grid rows tall used to slice its single line in half with no way to reach
 * the rest. Vertical auto-scroll with a stable gutter (so the last line never
 * hides behind the scrollbar), a subtle thin thumb that is actually visible on
 * a white tile, and bottom padding so the final line's descenders are never
 * flush against the clip edge. Paddings stay tight — TileFrame already adds
 * its own p-2, and every px matters in a two-row tile.
 */
const SCROLL_CLASSES =
  'min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable] ' +
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent ' +
  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/20 ' +
  'hover:[&::-webkit-scrollbar-thumb]:bg-black/35 ' +
  'dark:[&::-webkit-scrollbar-thumb]:bg-white/25 dark:hover:[&::-webkit-scrollbar-thumb]:bg-white/40';

const specStyle = (spec: TextTileSpec): CSSProperties => ({
  ...(spec.background ? { backgroundColor: spec.background } : null),
  ...(spec.align ? { textAlign: spec.align } : null),
});

/**
 * Presentational rich-text body (view mode + reusable by the print view).
 * Sanitizes again before dangerouslySetInnerHTML as a second belt — the store
 * already sanitizes every write.
 *
 * `scroll` is on by default; the print view turns it OFF (paper cannot scroll,
 * and a reserved scrollbar gutter would shift the printed text).
 */
export function TextTileContent({
  spec,
  className = '',
  scroll = true,
}: {
  spec: TextTileSpec;
  className?: string;
  scroll?: boolean;
}) {
  const html = useMemo(() => sanitizeRichHtml(spec.html), [spec.html]);
  return (
    <div
      className={`${RICH_TEXT_CLASSES} h-full rounded-lg px-2 pb-2 pt-1.5 ${
        scroll ? SCROLL_CLASSES : 'overflow-hidden'
      } ${className}`}
      style={specStyle(spec)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Rich-text tile. View mode: frameless sanitized html (no TileFrame chrome).
 * Edit mode: standard TileFrame (title-bar dragging) around a contentEditable
 * editor with a formatting toolbar; the kebab / right-click opens the config
 * card (background, alignment, remove).
 */
export function TextTile({ tileId, spec, editable }: TextTileProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  if (!editable) return <TextTileContent spec={spec} />;

  return (
    <TileFrame
      // Author-given name (config card); trimmed-empty falls back to the
      // generic label. View mode stays frameless, so this is edit-only chrome.
      title={spec.title?.trim() || 'Text'}
      editable
      onMenu={(position) => setMenuPos(position)}
      onContextMenu={(event) => {
        // Config card instead of the native browser menu — but never inside the
        // editor itself, where the native menu provides spellcheck/paste.
        if (event.target instanceof HTMLElement && event.target.closest('[contenteditable]')) return;
        event.preventDefault();
        event.stopPropagation();
        setMenuPos({ x: event.clientX, y: event.clientY });
      }}
    >
      <TextTileEditor tileId={tileId} spec={spec} />

      {menuPos &&
        // Portal past the transformed grid item: position:fixed inside a
        // transformed ancestor would resolve against the tile, not the viewport.
        createPortal(
          <div className="rcd-root bg-transparent">
            <TextTileConfigMenu
              tileId={tileId}
              spec={spec}
              position={menuPos}
              onClose={() => setMenuPos(null)}
            />
          </div>,
          document.body,
        )}
    </TileFrame>
  );
}

/* ---------------------------------------------------------------- editor */

const FONT_SIZES = ['12', '14', '16', '20', '24', '32'];

/**
 * contentEditable editor with a formatting toolbar that appears while focused.
 * Formatting uses document.execCommand (deprecated but functional in Chromium;
 * every action is wrapped so unsupported engines degrade to a no-op). On blur
 * the html is sanitized and committed to the store.
 */
function TextTileEditor({ tileId, spec }: { tileId: string; spec: TextTileSpec }) {
  const runtime = useRuntime();
  const editorRef = useRef<HTMLDivElement>(null);
  /** Last selection inside the editor — restored before select/color commands. */
  const savedRange = useRef<Range | null>(null);
  const [focused, setFocused] = useState(false);

  const html = useMemo(() => sanitizeRichHtml(spec.html), [spec.html]);

  // Unmounting mid-focus (leaving edit mode, page switch) never blurs — make
  // sure the soft lock is dropped anyway (no-op when it was never acquired).
  useEffect(
    () => () => runtime.dashboards.releaseTileLock(tileId),
    [runtime, tileId],
  );

  const commit = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    const next = sanitizeRichHtml(root.innerHTML);
    if (next !== sanitizeRichHtml(spec.html)) {
      runtime.dashboards.updateTextTile(tileId, { html: next });
    }
  }, [runtime, tileId, spec.html]);

  const exec = (command: string, value?: string) => {
    try {
      document.execCommand(command, false, value);
    } catch {
      // execCommand unavailable in this engine — formatting is a no-op.
    }
  };

  const saveSelection = () => {
    const selection = window.getSelection();
    const root = editorRef.current;
    if (!selection || selection.rangeCount === 0 || !root) return;
    const range = selection.getRangeAt(0);
    if (root.contains(range.commonAncestorContainer)) savedRange.current = range.cloneRange();
  };

  const restoreSelection = () => {
    const range = savedRange.current;
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    if (!range) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  /**
   * execCommand has no px font-size: apply the largest legacy size (7), then
   * rewrite the marker output (<font size="7"> or, with styleWithCSS,
   * font-size: xxx-large spans) to the requested pixel size.
   */
  const applyFontSize = (px: string) => {
    restoreSelection();
    exec('fontSize', '7');
    const root = editorRef.current;
    if (!root) return;
    root.querySelectorAll('font[size="7"]').forEach((font) => {
      const span = document.createElement('span');
      span.style.fontSize = `${px}px`;
      while (font.firstChild) span.appendChild(font.firstChild);
      font.replaceWith(span);
    });
    root.querySelectorAll<HTMLElement>('span[style*="font-size"]').forEach((span) => {
      if (span.style.fontSize === 'xxx-large') span.style.fontSize = `${px}px`;
    });
    saveSelection();
  };

  const handleFocus = () => {
    setFocused(true);
    // Prefer CSS spans over <font>/<b> output and <p> line blocks over <div>
    // where the engine supports it (Chromium does).
    exec('styleWithCSS', 'true');
    exec('defaultParagraphSeparator', 'p');
    // Collab wave 1: claim the tile's soft lock while typing here — remote
    // ops on this tile hold instead of yanking the text mid-edit, and other
    // editors' builders see it as taken. Fire-and-forget: a refusal never
    // blocks typing (soft locks avoid conflicts, they don't enforce; a 409
    // raises the store's lockNotice chip), and solo sessions no-op inside.
    void runtime.dashboards.acquireTileLock(tileId);
  };

  const handleWrapperBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    // Ignore focus moves WITHIN the editor+toolbar (e.g. into the size select).
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setFocused(false);
    commit();
    // Commit BEFORE release: the blur's updateTextTile lands in the pending
    // buffer first, so a held remote op stays superseded by our newer write
    // rather than clobbering the text we just committed.
    runtime.dashboards.releaseTileLock(tileId);
  };

  return (
    <div className="flex h-full flex-col" onBlur={handleWrapperBlur}>
      {focused && (
        <div className="mb-1 flex shrink-0 flex-wrap items-center gap-0.5 rounded-md border border-rcd-border bg-rcd-bg p-0.5">
          <ToolbarButton icon={Bold} label="Bold" onAction={() => exec('bold')} />
          <ToolbarButton icon={Italic} label="Italic" onAction={() => exec('italic')} />
          <ToolbarButton icon={Underline} label="Underline" onAction={() => exec('underline')} />
          <ToolbarButton
            icon={Strikethrough}
            label="Strikethrough"
            onAction={() => exec('strikeThrough')}
          />

          <ToolbarDivider />

          <RcdSelect
            aria-label="Font size"
            title="Font size"
            value=""
            onMouseDown={saveSelection}
            onChange={(event) => {
              if (event.target.value !== '') applyFontSize(event.target.value);
            }}
            className="h-6 !px-1 !py-0 text-xs"
          >
            <option value="" disabled>
              Size
            </option>
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </RcdSelect>

          <input
            type="color"
            aria-label="Text color"
            title="Text color"
            defaultValue="#0b0b0b"
            onMouseDown={saveSelection}
            onChange={(event) => {
              restoreSelection();
              exec('foreColor', event.target.value);
              saveSelection();
            }}
            className="h-6 w-6 shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0.5"
          />

          <ToolbarDivider />

          <ToolbarButton icon={AlignLeft} label="Align left" onAction={() => exec('justifyLeft')} />
          <ToolbarButton
            icon={AlignCenter}
            label="Align center"
            onAction={() => exec('justifyCenter')}
          />
          <ToolbarButton icon={AlignRight} label="Align right" onAction={() => exec('justifyRight')} />

          <ToolbarDivider />

          <ToolbarButton
            icon={RemoveFormatting}
            label="Clear formatting"
            onAction={() => exec('removeFormat')}
          />
        </div>
      )}

      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Text tile content"
        onFocus={handleFocus}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        className={`${RICH_TEXT_CLASSES} ${SCROLL_CLASSES} flex-1 cursor-text rounded-md px-1.5 pb-1.5 pt-1 outline-none ring-[var(--rcd-accent-interactive)] focus:ring-1`}
        style={specStyle(spec)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** Toolbar button that never steals the editor selection (mousedown is eaten). */
function ToolbarButton({
  icon: Icon,
  label,
  onAction,
}: {
  icon: LucideIcon;
  label: string;
  onAction: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // preventDefault keeps focus (and the selection) in the contentEditable.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAction}
      className="rounded p-1 text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
    >
      <Icon size={14} />
    </button>
  );
}

function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-rcd-border" />;
}

/* ---------------------------------------------------------- config card */

const ALIGN_OPTIONS: { value: 'left' | 'center' | 'right'; label: string; icon: LucideIcon }[] = [
  { value: 'left', label: 'Align left', icon: AlignLeft },
  { value: 'center', label: 'Align center', icon: AlignCenter },
  { value: 'right', label: 'Align right', icon: AlignRight },
];

/**
 * Right-click / kebab configuration card for a text tile (edit mode only).
 * Fixed-position card (NOT a native context menu) closed by outside click or
 * Escape; the caller portals it to document.body.
 */
function TextTileConfigMenu({
  tileId,
  spec,
  position,
  onClose,
}: {
  tileId: string;
  spec: TextTileSpec;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Clamp to the viewport once the card has a measured size.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 4)),
    });
  }, [position]);

  // Outside click / Escape closes (the remove confirm owns the keyboard then).
  useEffect(() => {
    if (confirmRemove) return;
    const onPointerDown = (event: MouseEvent) => {
      if (cardRef.current && event.target instanceof Node && !cardRef.current.contains(event.target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, confirmRemove]);

  const align = spec.align ?? 'left';

  return (
    <>
      <div
        ref={cardRef}
        role="menu"
        aria-label="Configure text tile"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed z-50 flex w-56 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
      >
        {/* Name: edit-mode frame title + the phone editor's row label (the
            image tile's alt-text precedent). Written per keystroke — the store
            spreads the Partial and only special-cases html. */}
        <SectionLabel>Name</SectionLabel>
        <div className="px-3 pb-1.5">
          <RcdInput
            value={spec.title ?? ''}
            placeholder="Text"
            aria-label="Text tile name"
            maxLength={80}
            onChange={(event) => runtime.dashboards.updateTextTile(tileId, { title: event.target.value })}
            className="w-full"
          />
        </div>

        <Divider />
        <SectionLabel>Background</SectionLabel>
        <TileBackgroundSwatches
          value={spec.background ?? null}
          onChange={(background) => runtime.dashboards.updateTextTile(tileId, { background })}
        />

        <Divider />
        <SectionLabel>Alignment</SectionLabel>
        <div className="flex items-center gap-1 px-3 pb-1.5">
          {ALIGN_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={align === value}
              aria-label={label}
              title={label}
              onClick={() => runtime.dashboards.updateTextTile(tileId, { align: value })}
              className={`rounded-md border p-1.5 ${
                align === value
                  ? 'border-rcd-border bg-black/10 text-rcd-text dark:bg-white/15'
                  : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
              }`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>

        <Divider />
        <button
          type="button"
          role="menuitem"
          onClick={() => setConfirmRemove(true)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Trash2 size={14} />
          Remove text
        </button>
      </div>

      <ConfirmDialog
        title="Remove text"
        message="Remove this text tile? It is removed from the dashboard (kept until you save)."
        confirmLabel="Remove"
        danger
        open={confirmRemove}
        onConfirm={() => {
          setConfirmRemove(false);
          runtime.dashboards.removeTile(tileId);
          onClose();
        }}
        onCancel={() => {
          setConfirmRemove(false);
          onClose();
        }}
      />
    </>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
      {children}
    </p>
  );
}

function Divider() {
  return <div className="my-1 border-t border-rcd-border" />;
}
