/**
 * Command layer for the shared rich-text editing surface.
 *
 * The library's editing model is deliberately the LIGHT one: contentEditable +
 * document.execCommand for mutations, with sanitizeRichHtml as the safety net
 * on every commit path (store writes re-sanitize, renderers re-sanitize — the
 * editor never has to be perfect, only the allowlist does). This module wraps
 * that model so the surface and its menu never call execCommand raw:
 *
 *  - every call is try/caught (execCommand is deprecated; an engine without it
 *    degrades to plain-text editing, never to a crash);
 *  - selection SAVE/RESTORE as a Range (menu clicks and native inputs blur or
 *    steal the DOM selection — the saved Range is restored before every
 *    command so applications always land on the text the user right-clicked);
 *  - list/indent commands flip styleWithCSS OFF around themselves and restore
 *    it: with styleWithCSS on, Chromium expresses indentation as
 *    margin-left/padding spans, which the sanitizer (correctly) eats — with it
 *    off, Chromium nests real <ul>/<ol> structure that survives the allowlist;
 *  - Word-like marker choice writes list-style-type on the nearest list
 *    element (the one styleable list property the sanitizer admits); choosing
 *    a marker from the OTHER family swaps the list tag (ul↔ol) moving the
 *    <li> children across, so "1. 2. 3." on a bulleted list converts the list
 *    instead of styling nonsense.
 */

/** Marker choices offered by the bullet gallery (Word's bullet library). */
export const BULLET_MARKERS = ['disc', 'circle', 'square', 'none'] as const;

/** Marker choices offered by the numbering gallery (Word's numbering library). */
export const NUMBER_MARKERS = [
  'decimal',
  'lower-alpha',
  'upper-alpha',
  'lower-roman',
  'upper-roman',
] as const;

export type ListFamily = 'ul' | 'ol';

/** Font sizes (px) offered by the toolbar + menu — the text tile's set. */
export const FONT_SIZES_PX = ['12', '14', '16', '20', '24', '32'] as const;

/** Four no-break spaces: the Tab insertion outside lists (a plain "\t" is
 *  collapsed by HTML whitespace handling and lost by the sanitizer round-trip;
 *  NBSPs survive both and read as a Word-like tab stop). */
export const TAB_SPACES = '    ';

/** execCommand, degraded to a no-op wherever the engine lacks it. */
export const execCommand = (command: string, value?: string): void => {
  try {
    document.execCommand(command, false, value);
  } catch {
    /* execCommand unavailable — formatting is a no-op, typing still works */
  }
};

/** queryCommandState, degraded to false (used only for active-state chrome). */
export const commandState = (command: string): boolean => {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
};

/** queryCommandValue, degraded to null. Chromium reports PENDING typing state
 *  here too (a collapsed-caret foreColor shows up before any text is typed),
 *  which is what lets the caret-mode preview render staged formatting. */
export const commandValue = (command: string): string | null => {
  try {
    const value = document.queryCommandValue(command);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
};

/**
 * List-structure commands run with styleWithCSS OFF and restore it after —
 * the editors keep styleWithCSS ON for inline styling (span/style output
 * instead of <font>), but Chromium's list/indent handling under styleWithCSS
 * emits margin-left spans the sanitizer strips (the indent would silently
 * vanish on commit). Off, Chromium produces nested <ul>/<ol>/<li> structure —
 * exactly what the allowlist keeps.
 */
export const execListCommand = (
  command: 'insertUnorderedList' | 'insertOrderedList' | 'indent' | 'outdent',
): void => {
  execCommand('styleWithCSS', 'false');
  execCommand(command);
  execCommand('styleWithCSS', 'true');
};

/** The current selection's Range when it lives inside `root`, else null. */
export const selectionRangeIn = (root: HTMLElement): Range | null => {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
};

/** Restores a previously saved Range into the document selection, focusing
 *  `root` first (menu buttons preventDefault their mousedown, but native
 *  inputs — color picker, hex field — legitimately steal focus). Returns
 *  false when the Range's nodes no longer exist (an execCommand rewrote that
 *  part of the DOM) — callers then fall back to the live selection. */
export const restoreSelection = (root: HTMLElement, range: Range | null): boolean => {
  root.focus({ preventScroll: true });
  if (!range) return false;
  if (!root.contains(range.commonAncestorContainer)) return false;
  const selection = root.ownerDocument.getSelection();
  if (!selection) return false;
  try {
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
};

/** Nearest element for a node (text nodes answer their parent). */
const elementOf = (node: Node): HTMLElement | null =>
  node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;

/** The <li> the selection sits in (inside `root`), else null — the Tab
 *  handler's "am I in a list?" probe and the menu's list active-state. */
export const caretListItem = (root: HTMLElement): HTMLLIElement | null => {
  const range = selectionRangeIn(root);
  if (!range) return null;
  const li = elementOf(range.startContainer)?.closest('li') ?? null;
  return li && root.contains(li) ? li : null;
};

/** The list element (ul/ol) around the selection, inside `root`. */
export const caretList = (root: HTMLElement): HTMLUListElement | HTMLOListElement | null => {
  const li = caretListItem(root);
  const list = li?.closest('ul,ol') ?? null;
  return list && root.contains(list) ? (list as HTMLUListElement | HTMLOListElement) : null;
};

/**
 * Tab inside the editor — consumed ALWAYS (an editor that tab-focuses away
 * mid-thought is the bug this wave fixes):
 *  - in a <li> (lists enabled): Tab indents / Shift+Tab outdents the item —
 *    Word's list behavior, via nested-list structure (see execListCommand);
 *  - anywhere else: Tab inserts four no-break spaces (a Word-like tab stop
 *    the sanitizer round-trips), Shift+Tab is a consumed no-op.
 * stopPropagation on every handled Tab so a surrounding dialog's focus trap
 * (or the grid's key handling) never also acts on it. Escape is deliberately
 * NOT handled here — the surface never consumes Escape; the format menu (its
 * own dismissable layer) is the only rich-text party that does.
 */
export const handleEditorTab = (
  root: HTMLElement,
  event: { shiftKey: boolean; preventDefault: () => void; stopPropagation: () => void },
  listsEnabled: boolean,
): void => {
  event.preventDefault();
  event.stopPropagation();
  if (listsEnabled && caretListItem(root)) {
    execListCommand(event.shiftKey ? 'outdent' : 'indent');
    return;
  }
  if (event.shiftKey) return; // consumed no-op — never tab-focus out backwards
  execCommand('insertText', TAB_SPACES);
};

/**
 * Applies a Word-gallery marker: ensure the selection is inside a list of
 * `family` (converting the other family's list by TAG SWAP — the <li>
 * children move across, so content, nesting and the selection survive), then
 * write list-style-type on that list element (the one list style the
 * sanitizer admits; an explicit marker beats the class-level nesting ladder).
 */
export const applyListMarker = (root: HTMLElement, family: ListFamily, marker: string): void => {
  if (!caretListItem(root)) {
    // Not in a list yet: create one of the right family around the selection.
    execListCommand(family === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
  }
  let list = caretList(root);
  if (!list) return; // engine without execCommand — nothing to style
  if (list.tagName.toLowerCase() !== family) {
    // Family swap: a new ul/ol adopts the children + the style attribute
    // (the only attribute the sanitizer lets a list keep).
    const swapped = root.ownerDocument.createElement(family);
    const style = list.getAttribute('style');
    if (style !== null) swapped.setAttribute('style', style);
    while (list.firstChild) swapped.appendChild(list.firstChild);
    list.replaceWith(swapped);
    list = swapped as HTMLUListElement | HTMLOListElement;
  }
  list.style.setProperty('list-style-type', marker);
};

/**
 * execCommand has no px font-size: apply the largest legacy size (7), then
 * rewrite the marker output (<font size="7"> or, with styleWithCSS,
 * font-size: xxx-large spans) to the requested pixel size. (Lifted verbatim
 * from the text tile's toolbar so all surfaces size identically.)
 */
export const applyFontSizePx = (root: HTMLElement, px: string): void => {
  execCommand('fontSize', '7');
  root.querySelectorAll('font[size="7"]').forEach((font) => {
    const span = root.ownerDocument.createElement('span');
    span.style.fontSize = `${px}px`;
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
  });
  root.querySelectorAll<HTMLElement>('span[style*="font-size"]').forEach((span) => {
    if (span.style.fontSize === 'xxx-large') span.style.fontSize = `${px}px`;
  });
};

/* ------------------------------------------------------------ format painter */

/**
 * The inline formatting at the selection start, read from the DOM (ancestor
 * walk), NOT from queryCommandState — the walk is engine-independent and
 * reads only EXPLICIT formatting (tags + inline styles), so painting never
 * smears computed defaults (inherited color/size) onto the target as explicit
 * spans. color/fontSize keep the NEAREST ancestor's inline value.
 */
export interface InlineFormatting {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string | null;
  fontSizePx: string | null;
}

export const readInlineFormatting = (root: HTMLElement): InlineFormatting | null => {
  const range = selectionRangeIn(root);
  if (!range) return null;
  const formatting: InlineFormatting = {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: null,
    fontSizePx: null,
  };
  for (
    let el: HTMLElement | null = elementOf(range.startContainer);
    el && el !== root && root.contains(el);
    el = el.parentElement
  ) {
    const tag = el.tagName.toLowerCase();
    const weight = el.style.fontWeight;
    if (tag === 'b' || tag === 'strong' || weight === 'bold' || Number(weight) >= 600) {
      formatting.bold = true;
    }
    if (tag === 'i' || tag === 'em' || el.style.fontStyle === 'italic') formatting.italic = true;
    const deco = el.style.textDecoration;
    if (tag === 'u' || deco.includes('underline')) formatting.underline = true;
    if (tag === 's' || deco.includes('line-through')) formatting.strike = true;
    if (formatting.color === null && el.style.color !== '') formatting.color = el.style.color;
    if (formatting.fontSizePx === null && el.style.fontSize !== '') {
      formatting.fontSizePx = el.style.fontSize.replace(/px$/, '');
    }
  }
  return formatting;
};

/**
 * Format-painter application: make the current selection wear `formatting` —
 * replace semantics per facet, Word-style. Toggles (b/i/u/s) flip only when
 * the target's state (read at the selection start — an approximation for
 * mixed selections, same as Word's own brush) differs from the copied state;
 * color/size apply directly when the copied selection carried an explicit
 * value.
 */
export const paintFormatting = (root: HTMLElement, formatting: InlineFormatting): void => {
  const current = readInlineFormatting(root);
  if (!current) return;
  if (current.bold !== formatting.bold) execCommand('bold');
  if (current.italic !== formatting.italic) execCommand('italic');
  if (current.underline !== formatting.underline) execCommand('underline');
  if (current.strike !== formatting.strike) execCommand('strikeThrough');
  if (formatting.color !== null) execCommand('foreColor', formatting.color);
  if (formatting.fontSizePx !== null) applyFontSizePx(root, formatting.fontSizePx);
};
