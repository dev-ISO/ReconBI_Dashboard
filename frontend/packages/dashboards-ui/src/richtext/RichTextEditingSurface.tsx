import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  IndentDecrease,
  IndentIncrease,
  List,
  ListOrdered,
  RemoveFormatting,
  Strikethrough,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import { sanitizeRichHtml } from '@recon/dashboards-core';
import { RcdSelect } from '../primitives';
import {
  RichTextContextMenu,
  RichTextFormatControls,
  RichTextStatusChip,
  type RichTextFeatureFlags,
  type RichTextMenuAction,
  type RichTextMenuActive,
} from './RichTextContextMenu';
import {
  applyFontSizePx,
  applyListMarker,
  caretList,
  caretListItem,
  commandState,
  commandValue,
  execCommand,
  execListCommand,
  FONT_SIZES_PX,
  handleEditorTab,
  paintFormatting,
  readInlineFormatting,
  restoreSelection,
  selectionRangeIn,
  type InlineFormatting,
  type ListFamily,
} from './richTextCommands';
import { useRichTextMenu } from './useRichTextMenu';

/**
 * The ONE rich-text editor for the library — text-tile bodies, the
 * inner/axis-title dialogs and the button-label dialog all render this
 * surface, so Tab handling, the right-click format menu, lists and the
 * formatting toolbar behave identically everywhere.
 *
 * DOM-ownership contract (React 19, pinned by test/contentEditable.test.tsx):
 * the contentEditable is seeded IMPERATIVELY — React renders the element
 * childless and never touches its contents again. dangerouslySetInnerHTML on
 * a live editor is forbidden: React 19 re-applies it on EVERY re-render, so
 * any parent re-render mid-typing (collab op, lock notice, keystroke echo)
 * would stomp the user's typing back to the seed. By default the seed is
 * mount-only (dialogs remount per open, so each open re-seeds); `syncSeed`
 * (the text tile) additionally adopts EXTERNAL seed changes — remote collab
 * edits — but only while no editing session is active and only when the
 * sanitized content actually differs (our own commit echoing back through the
 * store must be a no-op, or the echo itself would stomp).
 *
 * Editing session = focus anywhere inside the surface (editor, toolbar, the
 * portaled format menu). `onFocus` fires when it begins (text tile: acquire
 * the soft lock); when it ends, `onCommit(html)` fires FIRST and `onBlur`
 * SECOND — the text tile commits then releases its lock in that order, so a
 * held remote op stays superseded by the newer local write instead of
 * clobbering the text just committed.
 *
 * The right-click FORMAT MENU opens only on right-click INSIDE the editor
 * (with a live selection: SELECTION mode styles it; with a collapsed caret:
 * CARET mode — commands stage the browser's pending typing formatting and a
 * chip signals "type to apply"). Right-clicks outside the editor are not
 * consumed here, so tile chrome keeps its config card. Escape closes the
 * menu ONLY (capture + stopPropagation in the dismissable — never the
 * RcdDialog hosting the editor); the surface itself never consumes Escape.
 */

export interface RichTextFeatures {
  lists?: boolean;
  align?: boolean;
  size?: boolean;
  color?: boolean;
  strike?: boolean;
}

export interface RichTextEditingSurfaceProps {
  /** Initial HTML — sanitized and seeded imperatively (see contract above). */
  seedHtml: string;
  /** Adopt EXTERNAL seedHtml changes while idle (text-tile collab freshness).
   *  Off (default) the seed is strictly mount-only — the dialog contract. */
  syncSeed?: boolean;
  /** Fires with the editor's raw innerHTML after every edit (live previews). */
  onChange?: (html: string) => void;
  /** Fires with the editor's raw innerHTML when the editing session ends —
   *  ALWAYS before onBlur (commit-then-release ordering). */
  onCommit?: (html: string) => void;
  /** Classes for the contentEditable element itself. */
  className?: string;
  /** Classes for the wrapper around toolbar + editor (layout hooks). */
  rootClassName?: string;
  /** Inline styles for the editor element (tile background / text-align). */
  editorStyle?: CSSProperties;
  /** false consumes Enter — single-line surfaces (button labels). */
  multiline?: boolean;
  features?: RichTextFeatures;
  ariaLabel: string;
  /** Editing session began (text tile: acquire the tile's soft lock). */
  onFocus?: () => void;
  /** Editing session ended — fires AFTER onCommit (release the soft lock). */
  onBlur?: () => void;
  /** Dialog hosting: the toolbar is always visible (no focus flicker while
   *  the dialog manages focus) instead of appearing on focus. */
  inDialog?: boolean;
}

/** Menu actions that stage PENDING TYPING formatting in caret mode (inline
 *  styles); block actions (lists/align/indent) apply immediately either way. */
const INLINE_ACTION_KINDS = new Set(['bold', 'italic', 'underline', 'strike', 'size', 'color', 'clear']);

const CARET_MOVE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'];

/** Copied formatting + whether the painter persists after one application. */
interface PainterState {
  formatting: InlineFormatting;
  sticky: boolean;
}

export function RichTextEditingSurface({
  seedHtml,
  syncSeed = false,
  onChange,
  onCommit,
  className = '',
  rootClassName = 'flex min-h-0 flex-col gap-1.5',
  editorStyle,
  multiline = true,
  features,
  ariaLabel,
  onFocus,
  onBlur,
  inDialog = false,
}: RichTextEditingSurfaceProps) {
  const flags: RichTextFeatureFlags = {
    lists: features?.lists ?? true,
    align: features?.align ?? true,
    size: features?.size ?? true,
    color: features?.color ?? true,
    strike: features?.strike ?? true,
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  /** The menu's portaled content root — focus inside it is "ours". */
  const menuContentRef = useRef<HTMLDivElement | null>(null);
  /** Last selection inside the editor — restored before menu/toolbar commands
   *  whose controls steal focus (selects, native color inputs). */
  const savedRangeRef = useRef<Range | null>(null);

  const menu = useRichTextMenu();
  /** Synchronous mirror of menu-open: dismissal and blur handlers race the
   *  state update, and the session logic must read the truth mid-gesture. */
  const menuOpenRef = useRef(false);
  const [menuMode, setMenuMode] = useState<'selection' | 'caret'>('selection');
  const [menuActive, setMenuActive] = useState<RichTextMenuActive | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [caretFormatting, setCaretFormatting] = useState<InlineFormatting | null>(null);
  /** The selection's viewport rect at menu-open — the menu never covers it. */
  const [selectionRect, setSelectionRect] = useState<{ top: number; bottom: number } | null>(null);

  const [sessionActive, setSessionActive] = useState(false);
  const sessionActiveRef = useRef(false);

  const [painter, setPainter] = useState<PainterState | null>(null);
  /** Caret-mode armed chip: pending typing formatting is waiting for input. */
  const [typingArmed, setTypingArmed] = useState(false);
  const typingArmedRef = useRef(false);
  typingArmedRef.current = typingArmed;

  // Latest callbacks without re-binding effects/handlers.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;

  /* ------------------------------------------------------------- seeding */

  // Seed the editor's DOM exactly ONCE, imperatively (layout effect: before
  // paint, so the first frame already shows content). After this the browser
  // owns the editor's DOM — React never renders children into it.
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (el) el.innerHTML = sanitizeRichHtml(seedHtml);
    // Mount-only by design — a changing seed must NOT re-stomp (React-19 rule
    // pinned in test/contentEditable.test.tsx); syncSeed's guarded adoption
    // below is the only sanctioned re-seed path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // syncSeed (text tile): adopt EXTERNAL content changes — a remote collab op
  // landing while this user is NOT editing must show up in the editor. Guards,
  // in order of importance:
  //  - never while an editing session is active or the menu is open (while WE
  //    edit, the soft lock holds remote ops anyway — rewriting mid-typing is
  //    exactly the B4 data-loss bug this surface exists to fix);
  //  - only when the SANITIZED content genuinely differs (our own commit
  //    echoes back through the store sanitized; textual echo differences must
  //    not trigger a rewrite).
  useEffect(() => {
    if (!syncSeed) return;
    const el = editorRef.current;
    if (!el) return;
    if (sessionActiveRef.current || menuOpenRef.current) return;
    const incoming = sanitizeRichHtml(seedHtml);
    if (incoming === sanitizeRichHtml(el.innerHTML)) return;
    el.innerHTML = incoming;
    savedRangeRef.current = null; // the saved range pointed into replaced DOM
  }, [seedHtml, syncSeed]);

  const emit = useCallback(() => {
    const el = editorRef.current;
    if (el) onChangeRef.current?.(el.innerHTML);
  }, []);

  /* ------------------------------------------------------------- session */

  const beginSession = () => {
    if (sessionActiveRef.current) return;
    sessionActiveRef.current = true;
    setSessionActive(true);
    // Prefer CSS spans over <font>/<b> output and <p> line blocks over <div>
    // where the engine supports it (Chromium does). List/indent commands flip
    // styleWithCSS off around themselves — see execListCommand.
    execCommand('styleWithCSS', 'true');
    execCommand('defaultParagraphSeparator', 'p');
    onFocusRef.current?.();
  };

  /** Ends the editing session. Idempotent — the blur event and the menu's
   *  outside-dismissal can both conclude the same gesture. onCommit fires
   *  BEFORE onBlur: the text tile commits its html, THEN releases its soft
   *  lock, so a held remote op stays superseded by the newer local write
   *  rather than clobbering the text just committed. */
  const endSession = () => {
    if (!sessionActiveRef.current) return;
    sessionActiveRef.current = false;
    setSessionActive(false);
    setTypingArmed(false);
    const el = editorRef.current;
    if (el) onCommitRef.current?.(el.innerHTML);
    onBlurRef.current?.();
  };

  const handleRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    // Focus moves WITHIN the surface (toolbar selects/inputs) or into the
    // portaled menu (its color/hex inputs) keep the session alive.
    if (next && event.currentTarget.contains(next)) return;
    if (next && menuContentRef.current?.contains(next)) return;
    // While the menu is open its dismissal logic owns the session decision
    // (menu buttons preventDefault mousedown, so most clicks never blur; the
    // ones that do — outside clicks — run through handleMenuOutside first).
    if (menuOpenRef.current) return;
    endSession();
  };

  /* ------------------------------------------------------- menu plumbing */

  const saveSelection = () => {
    const el = editorRef.current;
    if (!el) return;
    const range = selectionRangeIn(el);
    if (range) savedRangeRef.current = range.cloneRange();
  };

  /** Formatting snapshot for the menu's active states, computed FRESH at
   *  every open and after every apply. */
  const readMenuActive = (): RichTextMenuActive => {
    const el = editorRef.current;
    const inline = el ? readInlineFormatting(el) : null;
    const list = el ? caretList(el) : null;
    const family = list ? (list.tagName.toLowerCase() as ListFamily) : null;
    const explicit = list?.style.getPropertyValue('list-style-type') ?? '';
    return {
      bold: commandState('bold') || (inline?.bold ?? false),
      italic: commandState('italic') || (inline?.italic ?? false),
      underline: commandState('underline') || (inline?.underline ?? false),
      strike: commandState('strikeThrough') || (inline?.strike ?? false),
      listFamily: family,
      marker: family ? (explicit !== '' ? explicit : family === 'ul' ? 'disc' : 'decimal') : '',
      align: commandState('justifyCenter')
        ? 'center'
        : commandState('justifyRight')
          ? 'right'
          : commandState('justifyLeft')
            ? 'left'
            : null,
      color: inline?.color ?? null,
      fontSizePx: inline?.fontSizePx ?? null,
    };
  };

  /** Sanitized copy of the selected slice for the preview strip (a STATIC
   *  render — never a live editor, so dangerouslySetInnerHTML is fine there). */
  const readPreviewHtml = (): string | null => {
    const el = editorRef.current;
    if (!el) return null;
    // The LIVE selection is gone whenever focus left the editor — which is
    // routine here: menu buttons preventDefault their mousedown, but the native
    // colour input and the hex field legitimately take focus, and some browsers
    // drop the contentEditable selection outright when they do. selectionRangeIn
    // then returns null, previewHtml became null, and the strip silently swapped
    // the real slice for an unstyled "Sample text" — the preview looking broken
    // at exactly the moment the user was choosing a colour.
    //
    // savedRangeRef holds the same slice, re-saved after every apply, so it is
    // the accurate fallback. It is only trusted while its nodes are still in the
    // editor: execCommand rebuilds nodes, and a detached range would throw.
    const saved = savedRangeRef.current;
    const range =
      selectionRangeIn(el) ??
      (saved && el.contains(saved.commonAncestorContainer) ? saved : null);
    if (!range || range.collapsed) return null;
    try {
      const holder = el.ownerDocument.createElement('div');
      holder.appendChild(range.cloneContents());
      return sanitizeRichHtml(holder.innerHTML);
    } catch {
      return null;
    }
  };

  /** Caret-mode sample styling: explicit ancestor formatting merged with the
   *  browser's PENDING typing state (queryCommandState/Value reflect staged
   *  formatting on a collapsed caret in Chromium). */
  const readCaretFormatting = (): InlineFormatting | null => {
    const el = editorRef.current;
    if (!el) return null;
    const inline = readInlineFormatting(el);
    let pendingColor: string | null = null;
    try {
      const value = commandValue('foreColor');
      // The editor's own computed color comes back for unstyled carets —
      // only a DIFFERENT value is a real staged/explicit choice.
      if (value && value !== window.getComputedStyle(el).color) pendingColor = value;
    } catch {
      /* non-browser environment — sample renders unstyled */
    }
    return {
      bold: commandState('bold') || (inline?.bold ?? false),
      italic: commandState('italic') || (inline?.italic ?? false),
      underline: commandState('underline') || (inline?.underline ?? false),
      strike: commandState('strikeThrough') || (inline?.strike ?? false),
      color: inline?.color ?? pendingColor,
      fontSizePx: inline?.fontSizePx ?? null,
    };
  };

  const refreshMenuState = () => {
    setMenuActive(readMenuActive());
    // Keep the last good slice if this read cannot find one at all: a preview
    // that goes blank mid-edit is worse than one that is a moment stale, and
    // the menu's mode was fixed when it opened — a SELECTION menu never wants
    // the caret-mode sample.
    setPreviewHtml((previous) => readPreviewHtml() ?? previous);
    setCaretFormatting(readCaretFormatting());
  };

  /**
   * The format menu opens ONLY here: right-click inside the editor with the
   * selection living in it. Non-collapsed → SELECTION mode; collapsed caret →
   * CARET mode (staging pending-typing formatting). Everything the menu shows
   * — the formatting snapshot, the preview, the avoid-rect — is computed
   * fresh per open, never reused from a previous session. Without a usable
   * selection the browser's native menu stays available (spellcheck/paste).
   */
  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const el = editorRef.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    savedRangeRef.current = range.cloneRange();
    // Formatting from the menu is an editing session (the text tile must hold
    // its soft lock while the user styles, exactly as while typing).
    beginSession();
    setMenuMode(selection.isCollapsed ? 'caret' : 'selection');
    if (!selection.isCollapsed) setTypingArmed(false); // selection mode replaces staged intent
    refreshMenuState();
    let rect: { top: number; bottom: number } | null = null;
    try {
      const r = range.getBoundingClientRect();
      if (r && (r.width > 0 || r.height > 0)) rect = { top: r.top, bottom: r.bottom };
    } catch {
      /* environments without Range.getBoundingClientRect (tests) */
    }
    setSelectionRect(rect);
    // The tile's config-card contextmenu (TileFrame) must not also react —
    // INSIDE the editor this menu wins, OUTSIDE the config card keeps its turf.
    event.stopPropagation();
    menuOpenRef.current = true;
    menu.open(event); // preventDefaults the native menu
  };

  /** Explicit close (Done / Escape): back onto the styled selection. */
  const closeMenuAndRefocus = () => {
    menuOpenRef.current = false;
    menu.close();
    const el = editorRef.current;
    if (el) restoreSelection(el, savedRangeRef.current);
  };

  /** Outside-pointerdown / second-right-click dismissal: close, and end the
   *  editing session when the gesture left the surface entirely (a click back
   *  into the editor/toolbar keeps editing). Running here — synchronously in
   *  the capture phase — puts the commit BEFORE anything the click lands on. */
  const handleMenuOutside = (target: Node | null) => {
    menuOpenRef.current = false;
    menu.close();
    if (target && rootRef.current?.contains(target)) return;
    endSession();
  };

  /** While the menu's own native color input is engaged, the first outside
   *  pointerdown only disengages the picker — the menu must not be torn down
   *  under the OS color dialog. Escape/Done still close normally. */
  const guardColorPickerDismiss = () => {
    const active = document.activeElement;
    const engaged =
      menuContentRef.current !== null &&
      active instanceof HTMLInputElement &&
      active.type === 'color' &&
      menuContentRef.current.contains(active);
    if (!engaged) return false;
    active.blur();
    return true;
  };

  /**
   * Run a menu command: restore the selection saved at open (menu buttons
   * preventDefault mousedown so it usually still lives — but native inputs
   * steal it), execute against the live DOM, re-save the possibly rebuilt
   * selection, emit, and refresh the menu's snapshot so its controls track
   * what is applied. The menu STAYS OPEN through all of it. In caret mode
   * inline actions arm the "type to apply" chip — the staging itself is the
   * browser's own pending-typing formatting.
   */
  const applyMenuAction = (action: RichTextMenuAction) => {
    const el = editorRef.current;
    if (!el) return;
    if (!selectionRangeIn(el)) restoreSelection(el, savedRangeRef.current);
    else el.focus({ preventScroll: true });

    switch (action.kind) {
      case 'bold':
        execCommand('bold');
        break;
      case 'italic':
        execCommand('italic');
        break;
      case 'underline':
        execCommand('underline');
        break;
      case 'strike':
        execCommand('strikeThrough');
        break;
      case 'clear':
        execCommand('removeFormat');
        break;
      case 'list':
        execListCommand(action.family === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
        break;
      case 'marker':
        applyListMarker(el, action.family, action.marker);
        break;
      case 'indent':
        // Indentation exists only as nested-list structure in the sanitizer's
        // model (no margin/padding styles) — outside a list this is a no-op.
        if (caretListItem(el)) execListCommand('indent');
        break;
      case 'outdent':
        if (caretListItem(el)) execListCommand('outdent');
        break;
      case 'size':
        applyFontSizePx(el, action.px);
        break;
      case 'color':
        execCommand('foreColor', action.hex);
        break;
      case 'align':
        execCommand(
          action.value === 'left' ? 'justifyLeft' : action.value === 'center' ? 'justifyCenter' : 'justifyRight',
        );
        break;
    }

    saveSelection();
    emit();
    refreshMenuState();
    if (menuMode === 'caret' && INLINE_ACTION_KINDS.has(action.kind)) setTypingArmed(true);
  };

  /* ------------------------------------------------------- format painter */

  /** Pending delayed-close after a single brush click (a double-click
   *  upgrades to sticky first). */
  const painterCloseTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (painterCloseTimerRef.current) window.clearTimeout(painterCloseTimerRef.current);
    },
    [],
  );

  const handlePainterClick = () => {
    if (painterCloseTimerRef.current) return; // second click of a dbl-click
    if (painter) {
      setPainter(null); // brush again = cancel (Word behaviour)
      return;
    }
    const el = editorRef.current;
    if (!el) return;
    if (!selectionRangeIn(el)) restoreSelection(el, savedRangeRef.current);
    const formatting = readInlineFormatting(el);
    if (!formatting) return;
    setPainter({ formatting, sticky: false });
    // Close on a short delay so a double-click can still upgrade to sticky.
    painterCloseTimerRef.current = window.setTimeout(() => {
      painterCloseTimerRef.current = null;
      closeMenuAndRefocus();
    }, 250);
  };

  const handlePainterDoubleClick = () => {
    if (painterCloseTimerRef.current) {
      window.clearTimeout(painterCloseTimerRef.current);
      painterCloseTimerRef.current = null;
    }
    setPainter((current) => (current ? { ...current, sticky: true } : current));
    closeMenuAndRefocus();
  };

  /**
   * Painter mode: the NEXT selection made in the editor receives the copied
   * formatting. Document-level listeners, but only gestures that STARTED
   * inside the editor paint (a click elsewhere that leaves an old selection
   * alive must not). Esc cancels — consumed, so cancelling the painter never
   * doubles as closing a surrounding dialog; single-shot exits after one
   * application; sticky persists until Esc.
   */
  useEffect(() => {
    if (!painter) return undefined;
    let gestureInEditor = false;
    let cancelled = false; // a deferred paint must not land after mode end

    const onPointerDown = (event: PointerEvent) => {
      gestureInEditor = editorRef.current?.contains(event.target as Node) ?? false;
    };

    const paintSelection = () => {
      const el = editorRef.current;
      if (!el) return;
      const range = selectionRangeIn(el);
      if (!range || range.collapsed) return;
      paintFormatting(el, painter.formatting);
      saveSelection();
      emit();
      if (!painter.sticky) setPainter(null);
    };

    const onMouseUp = () => {
      if (!gestureInEditor) return;
      gestureInEditor = false;
      // Defer a tick: the selection is finalized after mouseup.
      window.setTimeout(() => {
        if (!cancelled) paintSelection();
      }, 0);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); // this Esc means "cancel the painter", nothing else
      setPainter(null);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelled = true;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [painter, emit]);

  /* ------------------------------------------------------- input plumbing */

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const el = editorRef.current;
      if (el) handleEditorTab(el, event, flags.lists);
      return;
    }
    if (event.key === 'Enter' && !multiline) {
      event.preventDefault(); // single-line surface — no line breaks, ever
      return;
    }
    // Moving the caret abandons staged caret-mode formatting (it was armed
    // for one spot); Escape disarms the CHIP but is NOT consumed — the
    // surface never eats Escape (dialogs keep their close behaviour).
    if (typingArmedRef.current && CARET_MOVE_KEYS.includes(event.key)) setTypingArmed(false);
  };

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    // Typed characters land already wearing the staged formatting (the
    // browser's pending-typing state) — the armed chip retires.
    const inputType = (event.nativeEvent as InputEvent).inputType ?? '';
    if (typingArmedRef.current && inputType.startsWith('insert')) setTypingArmed(false);
    emit();
  };

  /* ------------------------------------------------------------ toolbar */

  /** Toolbar command: focus/selection stay in the editor (buttons eat their
   *  mousedown); controls that DO steal focus (size select, color input)
   *  save the selection on mousedown and restore before applying. */
  const toolbarExec = (run: () => void) => {
    const el = editorRef.current;
    if (!el) return;
    if (!selectionRangeIn(el)) restoreSelection(el, savedRangeRef.current);
    run();
    saveSelection();
    emit();
  };

  const toolbarVisible = inDialog || sessionActive;
  const editorRect =
    painter || typingArmed ? editorRef.current?.getBoundingClientRect() : undefined;

  return (
    <div ref={rootRef} className={rootClassName} onBlur={handleRootBlur}>
      {toolbarVisible && (
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 rounded-md border border-rcd-border bg-rcd-bg p-0.5">
          <ToolbarButton icon={Bold} label="Bold" onAction={() => toolbarExec(() => execCommand('bold'))} />
          <ToolbarButton icon={Italic} label="Italic" onAction={() => toolbarExec(() => execCommand('italic'))} />
          <ToolbarButton
            icon={Underline}
            label="Underline"
            onAction={() => toolbarExec(() => execCommand('underline'))}
          />
          {flags.strike && (
            <ToolbarButton
              icon={Strikethrough}
              label="Strikethrough"
              onAction={() => toolbarExec(() => execCommand('strikeThrough'))}
            />
          )}

          {flags.size && (
            <>
              <ToolbarDivider />
              <RcdSelect
                aria-label="Font size"
                title="Font size"
                value=""
                onMouseDown={saveSelection}
                onChange={(event) => {
                  const px = event.target.value;
                  if (px !== '') {
                    toolbarExec(() => {
                      const el = editorRef.current;
                      if (el) applyFontSizePx(el, px);
                    });
                  }
                }}
                className="h-6 !px-1 !py-0 text-xs"
              >
                <option value="" disabled>
                  Size
                </option>
                {FONT_SIZES_PX.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </RcdSelect>
            </>
          )}

          {flags.color && (
            <input
              type="color"
              aria-label="Text color"
              title="Text color"
              defaultValue="#0b0b0b"
              onMouseDown={saveSelection}
              onChange={(event) => toolbarExec(() => execCommand('foreColor', event.target.value))}
              className="h-6 w-6 shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0.5"
            />
          )}

          {flags.lists && (
            <>
              <ToolbarDivider />
              <ToolbarButton
                icon={List}
                label="Bulleted list"
                onAction={() => toolbarExec(() => execListCommand('insertUnorderedList'))}
              />
              <ToolbarButton
                icon={ListOrdered}
                label="Numbered list"
                onAction={() => toolbarExec(() => execListCommand('insertOrderedList'))}
              />
              <ToolbarButton
                icon={IndentIncrease}
                label="Increase indent"
                onAction={() =>
                  toolbarExec(() => {
                    const el = editorRef.current;
                    if (el && caretListItem(el)) execListCommand('indent');
                  })
                }
              />
              <ToolbarButton
                icon={IndentDecrease}
                label="Decrease indent"
                onAction={() =>
                  toolbarExec(() => {
                    const el = editorRef.current;
                    if (el && caretListItem(el)) execListCommand('outdent');
                  })
                }
              />
            </>
          )}

          {flags.align && (
            <>
              <ToolbarDivider />
              <ToolbarButton
                icon={AlignLeft}
                label="Align left"
                onAction={() => toolbarExec(() => execCommand('justifyLeft'))}
              />
              <ToolbarButton
                icon={AlignCenter}
                label="Align center"
                onAction={() => toolbarExec(() => execCommand('justifyCenter'))}
              />
              <ToolbarButton
                icon={AlignRight}
                label="Align right"
                onAction={() => toolbarExec(() => execCommand('justifyRight'))}
              />
            </>
          )}

          <ToolbarDivider />
          <ToolbarButton
            icon={RemoveFormatting}
            label="Clear formatting"
            onAction={() => toolbarExec(() => execCommand('removeFormat'))}
          />
        </div>
      )}

      {/* Browser-owned after the imperative seed: childless in React, and
          NEVER dangerouslySetInnerHTML — see the DOM-ownership contract. */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={multiline}
        aria-label={ariaLabel}
        onFocus={beginSession}
        onKeyDown={handleKeyDown}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        onMouseDown={(event) => {
          // A left-click relocates the caret — staged typing formatting no
          // longer applies there. (A right-click re-opens the menu on the
          // same staged state, so it survives.)
          if (event.button === 0 && typingArmedRef.current) setTypingArmed(false);
        }}
        onInput={handleInput}
        onContextMenu={handleContextMenu}
        className={className}
        style={editorStyle}
      />

      {/* Painter-mode hint chip, floated just above the editor. */}
      {painter && editorRect && (
        <RichTextStatusChip editorRect={editorRect} icon="painter">
          Painting — select text to apply{painter.sticky ? ' · sticky' : ''} (Esc to cancel)
        </RichTextStatusChip>
      )}

      {/* Caret-mode armed chip: staged formatting awaits the next typing. */}
      {typingArmed && !painter && !menu.anchor && editorRect && (
        <RichTextStatusChip editorRect={editorRect} icon="typing">
          New-text formatting set — type to apply
        </RichTextStatusChip>
      )}

      {/* The format menu — right-click inside the editor is the ONLY way it
          opens. It stays open through every styling interaction and closes
          only on Done, Escape, a click outside or a second right-click; it
          never covers the selection being styled. */}
      {menu.anchor && (
        <RichTextContextMenu
          anchor={menu.anchor}
          avoidRect={selectionRect}
          dismissGuard={guardColorPickerDismiss}
          onEscape={closeMenuAndRefocus}
          onOutside={handleMenuOutside}
        >
          {/* preventDefault on mousedown so menu buttons never steal the
              editor selection (the <input>s stopPropagation — pickers and
              the hex field need focus). */}
          <div ref={menuContentRef} onMouseDown={(event) => event.preventDefault()}>
            <RichTextFormatControls
              mode={menuMode}
              features={flags}
              previewHtml={previewHtml}
              caretFormatting={caretFormatting}
              active={menuActive ?? readMenuActive()}
              apply={applyMenuAction}
              painterActive={painter !== null}
              onPainterClick={handlePainterClick}
              onPainterDoubleClick={handlePainterDoubleClick}
              onDone={closeMenuAndRefocus}
            />
          </div>
        </RichTextContextMenu>
      )}
    </div>
  );
}

/** Toolbar button that never steals the editor selection (mousedown eaten). */
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
