/**
 * Rich-text sanitizer for text tiles (TextTileSpec.html).
 *
 * DOMParser-based allowlist walk — no dependencies. The output contains ONLY:
 *   - tags: p, br, b, strong, i, em, u, s, h1, h2, h3, ul, ol, li, span, a
 *   - a: href (http/https only) + forced rel="noopener noreferrer" target="_blank"
 *   - style (span/p/h1-h3 only): color, font-size, text-align, font-weight,
 *     font-style, text-decoration
 * Everything else is stripped: every other attribute (including all on* event
 * handlers), script/style/iframe/etc. subtrees entirely, unknown wrappers are
 * unwrapped to their children. Chromium contentEditable block <div>s and legacy
 * execCommand <font color> output are normalized to <p> / <span style="color">.
 *
 * Called on EVERY store write path (DashboardStore.addTextTile /
 * updateTextTile), so persisted layout docs never carry unsanitized markup;
 * renderers additionally sanitize before dangerouslySetInnerHTML as a second
 * belt.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'h1',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'span',
  'a',
]);

/** Tags allowed to carry a (filtered) style attribute. */
const STYLE_TAGS = new Set(['span', 'p', 'h1', 'h2', 'h3']);

/** The only style properties that survive. */
const ALLOWED_STYLES = [
  'color',
  'font-size',
  'text-align',
  'font-weight',
  'font-style',
  'text-decoration',
] as const;

/**
 * Dangerous/active-content elements dropped WITH their children. Anything not
 * listed here and not allowlisted is unwrapped (children kept) instead.
 */
const DROP_WITH_CHILDREN = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'title',
  'head',
  'svg',
  'math',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'img',
  'picture',
  'map',
  'area',
  'dialog',
]);

/**
 * Belt-and-braces value check on top of CSSOM parsing: no quotes, semicolons,
 * backslashes, or function-call escapes beyond what colors need. None of the
 * six allowed properties legitimately uses url()/var()/etc.
 */
const SAFE_STYLE_VALUE = /^[a-z0-9#%.,()\s-]+$/i;
const FORBIDDEN_STYLE_VALUE = /url\s*\(|expression\s*\(|var\s*\(|image-set\s*\(|javascript/i;

const SAFE_HREF = /^https?:\/\//i;

const isSafeStyleValue = (value: string): boolean =>
  SAFE_STYLE_VALUE.test(value) && !FORBIDDEN_STYLE_VALUE.test(value);

/** Copies the allowlisted style properties (safe values only) onto `target`. */
const copyAllowedStyles = (source: HTMLElement, target: HTMLElement): void => {
  for (const prop of ALLOWED_STYLES) {
    const value = source.style.getPropertyValue(prop).trim();
    if (value !== '' && isSafeStyleValue(value)) target.style.setProperty(prop, value);
  }
};

const sanitizeChildren = (doc: Document, source: Node, target: Element): void => {
  for (let child = source.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments, CDATA, PIs
    const element = child as HTMLElement;
    let tag = element.tagName.toLowerCase();

    if (DROP_WITH_CHILDREN.has(tag)) continue;

    // Chromium contentEditable produces <div> line blocks; keep the line
    // structure by mapping them to paragraphs. Legacy execCommand emits
    // <font color>; map it to the span/style form the allowlist accepts.
    let fontColor: string | null = null;
    if (tag === 'div') tag = 'p';
    else if (tag === 'font') {
      const color = element.getAttribute('color')?.trim() ?? '';
      if (color !== '' && isSafeStyleValue(color)) fontColor = color;
      tag = 'span';
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrapper (table, blockquote, section, …): unwrap, keep children.
      sanitizeChildren(doc, element, target);
      continue;
    }

    const out = doc.createElement(tag);

    if (tag === 'a') {
      const href = element.getAttribute('href')?.trim() ?? '';
      if (!SAFE_HREF.test(href)) {
        // Link without a safe destination: keep the text, drop the anchor.
        sanitizeChildren(doc, element, target);
        continue;
      }
      out.setAttribute('href', href);
      out.setAttribute('target', '_blank');
      out.setAttribute('rel', 'noopener noreferrer');
    }

    if (STYLE_TAGS.has(tag)) {
      copyAllowedStyles(element, out as HTMLElement);
      if (fontColor !== null && (out as HTMLElement).style.getPropertyValue('color') === '') {
        (out as HTMLElement).style.setProperty('color', fontColor);
      }
    }

    sanitizeChildren(doc, element, out);

    // <br> and empty structural tags are fine; empty spans carry nothing.
    if (tag === 'span' && out.childNodes.length === 0) continue;

    target.appendChild(out);
  }
};

/**
 * Sanitizes untrusted rich-text HTML down to the allowlisted subset above.
 * Idempotent. In non-browser environments (no DOMParser) it degrades to
 * escaped plain text — content stays readable, markup never passes through.
 */
export const sanitizeRichHtml = (html: string): string => {
  if (typeof html !== 'string' || html === '') return '';
  if (typeof DOMParser === 'undefined') {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const container = doc.createElement('div');
  sanitizeChildren(doc, doc.body, container);
  return container.innerHTML;
};
