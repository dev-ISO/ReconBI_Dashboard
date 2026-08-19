import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronRight,
  Eraser,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Paintbrush,
  Sparkles,
  Strikethrough,
  Underline,
} from 'lucide-react';
import {
  BULLET_MARKERS,
  FONT_SIZES_PX,
  NUMBER_MARKERS,
  type InlineFormatting,
  type ListFamily,
} from './richTextCommands';
import { useRcdDismissable } from './useRcdDismissable';
import {
  parseHexInput,
  readMenuSections,
  readRecentColors,
  rememberRecentColor,
  writeMenuSections,
  type RichTextMenuAnchor,
  type RichTextMenuSectionId,
  type RichTextMenuSections,
} from './useRichTextMenu';

/*
 * The right-click format menu for the shared rich-text editing surface —
 * a port of the reference implementation's ContextMenu + FormatControls
 * (UnanetProgressWebpage), rethemed onto rcd tokens and reshaped to this
 * library's sanitizer model (no gradients/effects; lists, size, colour,
 * alignment instead). Behaviours kept intact from the reference:
 *
 *  - portaled to document.body (grid items are TRANSFORMED — a fixed-position
 *    child of a transformed ancestor resolves against the tile, not the
 *    viewport) and wrapped in .rcd-root so the token variables resolve;
 *  - measured for real (layout effect + ResizeObserver) so the viewport clamp
 *    uses actual dimensions — a fixed estimate yanked short menus around;
 *  - avoidRect placement: never covers the selection being styled (fully
 *    below it when the menu fits, else fully above);
 *  - NO close-on-scroll: applying styles reflows the editor and the menu body
 *    itself scrolls — a reflow must not yank the menu away mid-interaction;
 *  - a SECOND right-click outside closes it (armed on the next tick so the
 *    opening right-click can't self-close), with stopPropagation so the
 *    trigger underneath (tile config card) doesn't open at the new spot;
 *  - dismissGuard: while the menu's own native colour input is engaged, the
 *    first outside pointerdown only disengages the picker — never tears the
 *    menu down under the OS colour dialog;
 *  - Escape peels exactly ONE layer (capture + stopPropagation in
 *    useRcdDismissable) — it closes the menu, never the RcdDialog around the
 *    editor.
 */

export function RichTextContextMenu({
  anchor,
  avoidRect,
  minWidth = 320,
  dismissGuard,
  onEscape,
  onOutside,
  children,
}: {
  anchor: RichTextMenuAnchor;
  /** Viewport rect (top/bottom) the menu must never cover — the selection. */
  avoidRect: { top: number; bottom: number } | null;
  minWidth?: number;
  /** Return true to swallow an outside-pointerdown dismissal (never Escape). */
  dismissGuard?: () => boolean;
  /** Explicit close (Escape) — close-and-refocus-the-editor. */
  onEscape: () => void;
  /** Outside dismissal; the target lets the surface decide whether the
   *  editing session ends too (clicked away) or continues (clicked editor). */
  onOutside: (target: Node | null) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Read fresh per dismissal so the surface can pass an inline guard.
  const dismissGuardRef = useRef(dismissGuard);
  dismissGuardRef.current = dismissGuard;
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;

  useRcdDismissable(
    ref,
    (target) => {
      if (dismissGuardRef.current?.()) return;
      onOutsideRef.current(target);
    },
    { onEscape },
  );

  // The menu's REAL rendered size — the clamp uses actual dimensions, and the
  // ResizeObserver re-measures when sections expand while open. Measured in a
  // layout effect (pre-paint, no visible jump).
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Armed on the NEXT tick so the right-click that OPENED the menu isn't the
    // one that closes it. A further right-click INSIDE only suppresses the
    // native menu; OUTSIDE it closes this one, and stopPropagation keeps the
    // trigger underneath (the tile's config-card contextmenu) from opening a
    // fresh popover at the new spot.
    let onContextMenu: ((event: MouseEvent) => void) | null = null;
    const armTimer = window.setTimeout(() => {
      onContextMenu = (event: MouseEvent) => {
        if (ref.current?.contains(event.target as Node)) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onOutsideRef.current(event.target as Node | null);
      };
      document.addEventListener('contextmenu', onContextMenu, true);
    }, 0);
    return () => {
      window.clearTimeout(armTimer);
      if (onContextMenu) document.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, []);

  // Fixed at the pointer, shifted just enough to stay inside the viewport.
  // Until the first measurement lands (same frame, pre-paint) a conservative
  // estimate keeps the very first layout roughly right.
  const w = size?.w ?? minWidth;
  const h = size?.h ?? 280;
  let position: { left: number; top: number };
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - w - 8));
  if (avoidRect) {
    const below = avoidRect.bottom + 6;
    const fitsBelow = below + h + 8 <= window.innerHeight;
    position = { left, top: fitsBelow ? below : Math.max(8, avoidRect.top - h - 6) };
  } else {
    position = { left, top: Math.max(8, Math.min(anchor.y, window.innerHeight - h - 8)) };
  }

  return createPortal(
    // rcd-root: the menu leaves the provider's subtree via the portal, so the
    // token variables must be re-established here (config-card precedent).
    <div className="rcd-root bg-transparent">
      <div
        ref={ref}
        role="menu"
        aria-label="Text formatting"
        className="fixed z-[70] overflow-hidden rounded-md border border-rcd-border bg-rcd-surface text-sm text-rcd-text shadow-[var(--rcd-shadow-2)]"
        style={{ ...position, minWidth }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------ controls */

/** Formatting snapshot driving the menu's active states. */
export interface RichTextMenuActive {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  listFamily: ListFamily | null;
  /** Explicit list-style-type on the surrounding list ('' = family default). */
  marker: string;
  align: 'left' | 'center' | 'right' | null;
  color: string | null;
  fontSizePx: string | null;
}

export type RichTextMenuAction =
  | { kind: 'bold' }
  | { kind: 'italic' }
  | { kind: 'underline' }
  | { kind: 'strike' }
  | { kind: 'clear' }
  | { kind: 'list'; family: ListFamily }
  | { kind: 'marker'; family: ListFamily; marker: string }
  | { kind: 'indent' }
  | { kind: 'outdent' }
  | { kind: 'size'; px: string }
  | { kind: 'color'; hex: string }
  | { kind: 'align'; value: 'left' | 'center' | 'right' };

export interface RichTextFeatureFlags {
  lists: boolean;
  align: boolean;
  size: boolean;
  color: boolean;
  strike: boolean;
}

/** The palette offered as one-click swatches (reference palette). */
const SWATCH_COLORS: readonly { hex: string; name: string }[] = [
  { hex: '#ef4444', name: 'Red' },
  { hex: '#f97316', name: 'Orange' },
  { hex: '#eab308', name: 'Yellow' },
  { hex: '#22c55e', name: 'Green' },
  { hex: '#3b82f6', name: 'Blue' },
  { hex: '#8b5cf6', name: 'Purple' },
  { hex: '#ec4899', name: 'Pink' },
  { hex: '#94a3b8', name: 'Grey' },
];

const ACTIVE_SWATCH = 'ring-2 ring-[var(--rcd-accent-interactive)] ring-offset-1';

const HINT_TEXT = 'text-[10px] leading-snug text-rcd-muted';

/** '#rrggbb' -> 'rgb(r, g, b)' — inline styles read back as rgb() in Chromium,
 *  so swatch active-rings compare in that space. */
const hexToRgb = (hex: string): string | null => {
  const canonical = parseHexInput(hex);
  if (!canonical) return null;
  const n = Number.parseInt(canonical.slice(1), 16);
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
};

const colorMatches = (current: string | null, hex: string): boolean => {
  if (current === null) return false;
  const lower = current.toLowerCase().replace(/\s+/g, ' ');
  return lower === hex.toLowerCase() || lower === hexToRgb(hex)?.toLowerCase();
};

function ToolButton({
  title,
  active = false,
  onClick,
  onDoubleClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`rounded p-1 ${
        active
          ? 'bg-[color-mix(in_srgb,var(--rcd-accent-interactive)_18%,transparent)] text-rcd-text'
          : 'text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

/** A collapsible menu section: chevron header (persisted open state). */
function Section({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded border border-rcd-border/70">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-rcd-muted hover:bg-black/5 dark:hover:bg-white/10"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {label}
      </button>
      {open && <div className="flex flex-col gap-1.5 px-2 pb-2 pt-0.5">{children}</div>}
    </div>
  );
}

/** A Word-gallery tile (marker/numbering choice). */
function GalleryTile({
  label,
  glyph,
  active,
  onClick,
}: {
  label: string;
  glyph: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-8 min-w-9 items-center justify-center rounded border px-1.5 text-sm ${
        active
          ? 'border-[var(--rcd-accent-interactive)] bg-[color-mix(in_srgb,var(--rcd-accent-interactive)_14%,transparent)] text-rcd-text'
          : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
      }`}
    >
      {glyph}
    </button>
  );
}

const BULLET_GLYPHS: Record<(typeof BULLET_MARKERS)[number], string> = {
  disc: '•',
  circle: '◦',
  square: '▪',
  none: '–',
};

const NUMBER_GLYPHS: Record<(typeof NUMBER_MARKERS)[number], string> = {
  decimal: '1.',
  'lower-alpha': 'a.',
  'upper-alpha': 'A.',
  'lower-roman': 'i.',
  'upper-roman': 'I.',
};

/** Marker labels for tooltips. */
const MARKER_LABELS: Record<string, string> = {
  disc: 'Bullet (disc)',
  circle: 'Bullet (circle)',
  square: 'Bullet (square)',
  none: 'No marker',
  decimal: 'Numbers (1 2 3)',
  'lower-alpha': 'Letters (a b c)',
  'upper-alpha': 'Letters (A B C)',
  'lower-roman': 'Roman (i ii iii)',
  'upper-roman': 'Roman (I II III)',
};

/** Native colour input + a typable hex field (reference's CustomColorPicker,
 *  trimmed): live preview while the picker drags, commit on settle — commits
 *  are what land in the per-user recent colours. */
function CustomColorPicker({
  value,
  onPreview,
  onCommit,
}: {
  value: string | null;
  onPreview: (hex: string) => void;
  onCommit: (hex: string) => void;
}) {
  const canonical = value ? (parseHexInput(value) ?? null) : null;
  const [text, setText] = useState(canonical ?? '');
  const textRef = useRef<HTMLInputElement | null>(null);
  const previewedRef = useRef(false);

  // Track the applied value (live formatting refresh) unless mid-typing.
  useEffect(() => {
    if (document.activeElement === textRef.current) return;
    setText(canonical ?? '');
  }, [canonical]);

  const commitText = () => {
    const hex = parseHexInput(text);
    if (hex) {
      setText(hex);
      if (hex !== canonical) onCommit(hex);
    } else {
      setText(canonical ?? '');
    }
  };

  return (
    <div className="flex items-center gap-1">
      <span className="flex-shrink-0 text-[9px] font-semibold uppercase tracking-wide text-rcd-muted">
        Custom
      </span>
      <input
        type="color"
        value={canonical ?? '#3b82f6'}
        title="Color picker"
        aria-label="Custom color picker"
        // Let the native picker take focus (the wrapping menu preventDefaults
        // mousedown); applies restore the saved selection, so losing the DOM
        // selection here is fine.
        onMouseDown={(event) => event.stopPropagation()}
        onChange={(event) => {
          previewedRef.current = true;
          onPreview(event.target.value);
        }}
        onBlur={(event) => {
          if (!previewedRef.current) return;
          previewedRef.current = false;
          const hex = parseHexInput(event.target.value);
          if (hex) onCommit(hex);
        }}
        className="h-5 w-6 flex-shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0"
      />
      <input
        ref={textRef}
        type="text"
        value={text}
        placeholder="#rrggbb"
        spellCheck={false}
        title="Type or paste a hex color"
        aria-label="Custom color hex value"
        onMouseDown={(event) => event.stopPropagation()}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitText();
          }
        }}
        onBlur={commitText}
        className="w-[4.6rem] rounded border border-rcd-border bg-transparent px-1 py-0.5 font-mono text-[10px] text-rcd-text outline-none focus:border-[var(--rcd-accent-interactive)]"
      />
    </div>
  );
}

export function RichTextFormatControls({
  mode,
  features,
  previewHtml,
  caretFormatting,
  active,
  apply,
  painterActive,
  onPainterClick,
  onPainterDoubleClick,
  onDone,
}: {
  /** 'selection' styles selected text live; 'caret' stages formatting for
   *  the text typed next (the browser's native pending-typing styles). */
  mode: 'selection' | 'caret';
  features: RichTextFeatureFlags;
  /** Sanitized HTML of the selected slice (selection mode), else null. */
  previewHtml: string | null;
  /** Caret mode: the staged/inherited inline formatting for the sample line. */
  caretFormatting: InlineFormatting | null;
  active: RichTextMenuActive;
  apply: (action: RichTextMenuAction) => void;
  painterActive: boolean;
  onPainterClick: () => void;
  onPainterDoubleClick: () => void;
  onDone: () => void;
}) {
  // Collapsible sections: last-open state per user; the Lists section
  // auto-expands when the selection already sits in a list (re-opening on
  // styled text always shows its configuration — reference behaviour).
  const [sections, setSections] = useState<RichTextMenuSections>(() => {
    const initial = readMenuSections();
    if (active.listFamily !== null) initial.lists = true;
    return initial;
  });
  const toggleSection = (id: RichTextMenuSectionId) =>
    setSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      writeMenuSections(next);
      return next;
    });

  const [recentColors, setRecentColors] = useState<string[]>(() => readRecentColors());
  const commitColor = (hex: string) => {
    apply({ kind: 'color', hex });
    setRecentColors(rememberRecentColor(hex));
  };

  const sampleStyle: CSSProperties = caretFormatting
    ? {
        fontWeight: caretFormatting.bold ? 600 : undefined,
        fontStyle: caretFormatting.italic ? 'italic' : undefined,
        textDecoration:
          [
            caretFormatting.underline ? 'underline' : null,
            caretFormatting.strike ? 'line-through' : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
        color: caretFormatting.color ?? undefined,
        fontSize: caretFormatting.fontSizePx ? `${caretFormatting.fontSizePx}px` : undefined,
      }
    : {};

  return (
    <div className="flex max-h-[70vh] w-80 flex-col gap-1 overflow-y-auto p-1.5">
      {/* Live preview: the styling rendered for real, free of the editor's
          selection highlight — see the result WHILE choosing. */}
      <div className="flex flex-col gap-0.5">
        <span className="px-0.5 text-[9px] font-semibold uppercase tracking-wide text-rcd-muted">
          {mode === 'caret' ? 'Preview — new text will look like this' : 'Preview'}
        </span>
        <div className="max-h-20 overflow-hidden whitespace-pre-wrap break-words rounded border border-rcd-border/70 bg-rcd-bg px-2 py-1 text-[13px] leading-snug text-rcd-text">
          {mode === 'caret' || previewHtml === null ? (
            <span style={sampleStyle}>Sample text</span>
          ) : (
            // Static render of already-sanitized markup (never a live editor).
            <span dangerouslySetInnerHTML={{ __html: previewHtml }} />
          )}
        </div>
        {mode === 'caret' && (
          <p className={`px-0.5 ${HINT_TEXT}`}>
            No text is selected — these styles apply to what you type next at the cursor.
          </p>
        )}
      </div>

      {/* Always-visible top row: the essentials. */}
      <div className="flex items-center gap-0.5">
        <ToolButton title="Bold (Ctrl+B)" active={active.bold} onClick={() => apply({ kind: 'bold' })}>
          <Bold size={14} />
        </ToolButton>
        <ToolButton title="Italic (Ctrl+I)" active={active.italic} onClick={() => apply({ kind: 'italic' })}>
          <Italic size={14} />
        </ToolButton>
        <ToolButton
          title="Underline (Ctrl+U)"
          active={active.underline}
          onClick={() => apply({ kind: 'underline' })}
        >
          <Underline size={14} />
        </ToolButton>
        {features.strike && (
          <ToolButton
            title="Strikethrough"
            active={active.strike}
            onClick={() => apply({ kind: 'strike' })}
          >
            <Strikethrough size={14} />
          </ToolButton>
        )}
        <span className="mx-0.5 h-4 w-px bg-rcd-border" />
        <ToolButton
          title={
            painterActive
              ? 'Format painter is on — click to cancel (Esc also cancels)'
              : 'Format painter — copy this formatting, then select text to apply it (double-click: keep painting until Esc)'
          }
          active={painterActive}
          onClick={onPainterClick}
          onDoubleClick={onPainterDoubleClick}
        >
          <Paintbrush size={14} />
        </ToolButton>
        <ToolButton title="Clear formatting" onClick={() => apply({ kind: 'clear' })}>
          <Eraser size={14} />
        </ToolButton>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={onDone}
          className="rounded bg-rcd-accent px-2 py-0.5 text-[11px] font-semibold text-white hover:opacity-90"
        >
          Done
        </button>
      </div>

      {features.lists && (
        <Section label="Lists" open={sections.lists} onToggle={() => toggleSection('lists')}>
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-14 flex-shrink-0 text-[9px] font-semibold uppercase tracking-wide text-rcd-muted">
              Bullets
            </span>
            {BULLET_MARKERS.map((marker) => (
              <GalleryTile
                key={marker}
                label={MARKER_LABELS[marker]!}
                glyph={BULLET_GLYPHS[marker]}
                active={active.listFamily === 'ul' && active.marker === marker}
                onClick={() => apply({ kind: 'marker', family: 'ul', marker })}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-14 flex-shrink-0 text-[9px] font-semibold uppercase tracking-wide text-rcd-muted">
              Numbers
            </span>
            {NUMBER_MARKERS.map((marker) => (
              <GalleryTile
                key={marker}
                label={MARKER_LABELS[marker]!}
                glyph={NUMBER_GLYPHS[marker]}
                active={active.listFamily === 'ol' && active.marker === marker}
                onClick={() => apply({ kind: 'marker', family: 'ol', marker })}
              />
            ))}
          </div>
          <div className="flex items-center gap-0.5">
            <ToolButton
              title="Bulleted list"
              active={active.listFamily === 'ul'}
              onClick={() => apply({ kind: 'list', family: 'ul' })}
            >
              <ListIconGlyph kind="ul" />
            </ToolButton>
            <ToolButton
              title="Numbered list"
              active={active.listFamily === 'ol'}
              onClick={() => apply({ kind: 'list', family: 'ol' })}
            >
              <ListIconGlyph kind="ol" />
            </ToolButton>
            <span className="mx-0.5 h-4 w-px bg-rcd-border" />
            <ToolButton title="Increase indent (Tab)" onClick={() => apply({ kind: 'indent' })}>
              <IndentIncrease size={14} />
            </ToolButton>
            <ToolButton title="Decrease indent (Shift+Tab)" onClick={() => apply({ kind: 'outdent' })}>
              <IndentDecrease size={14} />
            </ToolButton>
            <span className={`ml-1 ${HINT_TEXT}`}>Tab / Shift+Tab indent inside lists</span>
          </div>
        </Section>
      )}

      {features.size && (
        <Section label="Text size" open={sections.size} onToggle={() => toggleSection('size')}>
          <div className="flex flex-wrap items-center gap-1">
            {FONT_SIZES_PX.map((px) => (
              <button
                key={px}
                type="button"
                title={`${px} px`}
                aria-label={`Text size ${px} pixels`}
                aria-pressed={active.fontSizePx === px}
                onClick={() => apply({ kind: 'size', px })}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${
                  active.fontSizePx === px
                    ? 'border-[var(--rcd-accent-interactive)] bg-[color-mix(in_srgb,var(--rcd-accent-interactive)_14%,transparent)] text-rcd-text'
                    : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
                }`}
              >
                {px}
              </button>
            ))}
          </div>
        </Section>
      )}

      {features.color && (
        <Section label="Text color" open={sections.color} onToggle={() => toggleSection('color')}>
          <div className="flex flex-wrap items-center gap-1">
            {SWATCH_COLORS.map((color) => (
              <button
                key={color.hex}
                type="button"
                title={color.name}
                aria-label={`Color ${color.name}`}
                onClick={() => commitColor(color.hex)}
                className={`h-4 w-4 flex-shrink-0 rounded-full transition hover:scale-110 ${
                  colorMatches(active.color, color.hex) ? ACTIVE_SWATCH : ''
                }`}
                style={{ backgroundColor: color.hex }}
              />
            ))}
          </div>
          {recentColors.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="flex-shrink-0 text-[9px] font-semibold uppercase tracking-wide text-rcd-muted">
                Recent
              </span>
              {recentColors.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  title={hex}
                  aria-label={`Recent color ${hex}`}
                  onClick={() => commitColor(hex)}
                  className={`h-4 w-4 flex-shrink-0 rounded-full border border-rcd-border transition hover:scale-110 ${
                    colorMatches(active.color, hex) ? ACTIVE_SWATCH : ''
                  }`}
                  style={{ backgroundColor: hex }}
                />
              ))}
            </div>
          )}
          <CustomColorPicker
            value={active.color}
            onPreview={(hex) => apply({ kind: 'color', hex })}
            onCommit={commitColor}
          />
        </Section>
      )}

      {features.align && (
        <Section label="Alignment" open={sections.align} onToggle={() => toggleSection('align')}>
          <div className="flex items-center gap-0.5">
            <ToolButton
              title="Align left"
              active={active.align === 'left'}
              onClick={() => apply({ kind: 'align', value: 'left' })}
            >
              <AlignLeft size={14} />
            </ToolButton>
            <ToolButton
              title="Align center"
              active={active.align === 'center'}
              onClick={() => apply({ kind: 'align', value: 'center' })}
            >
              <AlignCenter size={14} />
            </ToolButton>
            <ToolButton
              title="Align right"
              active={active.align === 'right'}
              onClick={() => apply({ kind: 'align', value: 'right' })}
            >
              <AlignRight size={14} />
            </ToolButton>
          </div>
        </Section>
      )}
    </div>
  );
}

/** lucide's List/ListOrdered are imported by the surface's toolbar; the menu
 *  draws tiny textual glyphs instead to keep its icon row visually distinct
 *  from the gallery tiles right above it. */
function ListIconGlyph({ kind }: { kind: ListFamily }) {
  return (
    <span aria-hidden className="block w-4 text-center text-[11px] leading-4">
      {kind === 'ul' ? '•–' : '1–'}
    </span>
  );
}

/** Floating status chip (format painter armed / staged typing formatting) —
 *  portaled + rcd-root for the same transformed-ancestor reasons as the menu. */
export function RichTextStatusChip({
  editorRect,
  icon,
  children,
}: {
  editorRect: { left: number; top: number };
  icon: 'painter' | 'typing';
  children: ReactNode;
}) {
  return createPortal(
    <div className="rcd-root bg-transparent">
      <div
        role="status"
        className="pointer-events-none fixed z-[75] flex items-center gap-1.5 rounded-full border border-rcd-border bg-rcd-surface px-3 py-1 text-[11px] font-semibold text-rcd-text shadow-[var(--rcd-shadow-2)]"
        style={{
          left: Math.max(8, Math.min(editorRect.left, window.innerWidth - 280)),
          top: Math.max(8, editorRect.top - 32),
        }}
      >
        {icon === 'painter' ? <Paintbrush size={11} /> : <Sparkles size={11} />}
        {children}
      </div>
    </div>,
    document.body,
  );
}
