/**
 * Advanced-CSS sanitizer for button tiles (ButtonTileSpec.customCss and every
 * button of a ButtonGroupTileSpec) — the richText.ts doctrine applied to a
 * style DECLARATION LIST instead of markup: a property allowlist plus a
 * safe-value belt on every kept declaration.
 *
 * Parsing rides a DETACHED element's style.cssText (CSSOM): the browser drops
 * malformed declarations, decodes CSS escapes (so `\75 rl(...)` comes back as
 * a literal `url(...)` the value guard then catches) and canonicalizes values.
 * The output is the SECOND element's cssText after filtering, which makes the
 * sanitizer idempotent by construction — sanitizing its own output re-parses
 * to the identical string.
 *
 * Allowed properties are visual-only knobs of the BUTTON element itself.
 * Blocked BY OMISSION (deliberately — layout belongs to the tile, and
 * overlay/clickjack surfaces stay closed): position, z-index, margin,
 * display, width/height, content, pointer-events.
 *
 * Called on EVERY store write path (DashboardStore.addButtonTile /
 * updateButtonTile / addButtonGroupTile / updateButtonGroupTile), so persisted
 * layout docs never carry unvetted declarations; renderers additionally
 * sanitize before applying (buttonStyleFromCss) as the usual second belt.
 * In non-browser environments (no document) it degrades to '' — unvetted CSS
 * never passes through, mirroring sanitizeRichHtml's no-DOM stance.
 */

/**
 * The only properties that survive, shorthands and their longhands both (the
 * CSSOM canonical form may report either depending on what was written).
 * background-image is gradients-only in practice: url(/image-set( payloads
 * are killed by the value guard, never by the property list.
 */
export const BUTTON_STYLE_PROPERTIES = [
  'background',
  'background-color',
  'background-image',
  'color',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'box-shadow',
  'outline',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'letter-spacing',
  'text-transform',
  'text-decoration',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'opacity',
  'filter',
  'transform',
  'transition',
  'cursor',
] as const;

const ALLOWED = new Set<string>(BUTTON_STYLE_PROPERTIES);

/**
 * Belt-and-braces value check on top of CSSOM parsing. The charset admits what
 * the allowed properties legitimately need — colors/gradients (#, %, commas,
 * parens), font stacks (quotes), calc arithmetic (+ * /) — and nothing that
 * could terminate or restructure a declaration.
 */
const SAFE_VALUE = /^[\w\s#%.,()"'/*+-]+$/;
const FORBIDDEN_VALUE = /url\s*\(|expression\s*\(|var\s*\(|image-set\s*\(|javascript|@|\\|!|[;{}<>]/i;

const isSafeValue = (value: string): boolean =>
  SAFE_VALUE.test(value) && !FORBIDDEN_VALUE.test(value);

/** One kept declaration of the canonical output. */
interface Declaration {
  property: string;
  value: string;
}

/**
 * Parses raw CSS through a detached element and keeps only allowlisted
 * properties whose canonical values pass the guard. Returns null when no DOM
 * is available.
 */
const filterDeclarations = (css: string): Declaration[] | null => {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('div');
  probe.style.cssText = css;
  const kept: Declaration[] = [];
  // Walk the CANONICAL cssText (shorthand-collapsed, escape-decoded) rather
  // than the indexed property list, which enumerates every longhand a
  // shorthand expands to and would duplicate the output.
  for (const declaration of probe.style.cssText.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property === '' || value === '') continue;
    if (!ALLOWED.has(property)) continue;
    if (!isSafeValue(value)) continue;
    kept.push({ property, value });
  }
  return kept;
};

/**
 * Sanitizes free-form CSS declarations down to the allowlisted subset above.
 * Idempotent; invalid/blocked declarations are silently dropped (the edit
 * dialog's live preview renders through the same sanitizer, so what the
 * preview shows is what ships). '' in, '' out; '' also in any non-browser
 * environment (see module doc).
 */
export const sanitizeButtonCss = (css: string): string => {
  if (typeof css !== 'string' || css.trim() === '') return '';
  const kept = filterDeclarations(css);
  if (kept === null || kept.length === 0) return '';
  // Round-trip the kept declarations through a second element so the returned
  // string IS a canonical cssText — re-sanitizing it cannot change it.
  const out = document.createElement('div');
  for (const { property, value } of kept) out.style.setProperty(property, value);
  return out.style.cssText;
};

/** 'border-top-color' -> 'borderTopColor' (React style-object key). */
const camelCase = (property: string): string =>
  property.replace(/-([a-z])/g, (_whole, letter: string) => letter.toUpperCase());

/**
 * The render-side second belt: sanitizes and converts to a React style
 * object, ready to spread OVER the button's base styles (custom CSS is the
 * "full control" layer, so it wins). {} when nothing survives or no DOM.
 */
export const buttonStyleFromCss = (css: string): Record<string, string> => {
  if (typeof css !== 'string' || css.trim() === '') return {};
  const kept = filterDeclarations(css);
  if (kept === null) return {};
  const style: Record<string, string> = {};
  for (const { property, value } of kept) style[camelCase(property)] = value;
  return style;
};
