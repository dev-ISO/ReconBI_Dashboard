// @vitest-environment jsdom
/**
 * Button advanced-CSS sanitizer (BUTTONS wave B2): property allowlist +
 * safe-value belt over a detached element's CSSOM parse. jsdom provides the
 * CSSOM; in production the store sanitizes on every write and the renderer
 * sanitizes again (buttonStyleFromCss).
 */
import { describe, expect, it } from 'vitest';
import { buttonStyleFromCss, sanitizeButtonCss } from './buttonStyle';

describe('sanitizeButtonCss', () => {
  it('keeps a gradient background-image (the explicitly supported case)', () => {
    const out = sanitizeButtonCss('background-image: linear-gradient(90deg, #ff0000, #0000ff);');
    expect(out).toContain('background-image:');
    expect(out).toContain('linear-gradient');
  });

  it('keeps the everyday visual knobs', () => {
    const out = sanitizeButtonCss(
      'color: #ffffff; border: 1px solid #333; border-radius: 12px; ' +
        'box-shadow: 0 2px 4px rgba(0,0,0,0.3); font-weight: 700; ' +
        'padding: 4px 12px; text-transform: uppercase; transform: scale(1.05); ' +
        'transition: all 0.2s ease; cursor: pointer; opacity: 0.9;',
    );
    for (const fragment of [
      'color:',
      'border:',
      'border-radius: 12px',
      'box-shadow:',
      'font-weight: 700',
      'padding: 4px 12px',
      'text-transform: uppercase',
      'transform: scale(1.05)',
      'transition: all 0.2s ease',
      'cursor: pointer',
      'opacity: 0.9',
    ]) {
      expect(out).toContain(fragment);
    }
  });

  it('drops url() payloads on any property (the value belt, not the allowlist)', () => {
    expect(sanitizeButtonCss('background-image: url(https://evil/x.png);')).toBe('');
    expect(sanitizeButtonCss('background: url("https://evil/x.png");')).toBe('');
    // Escaped url( decodes through the CSSOM and is still caught.
    expect(sanitizeButtonCss('background-image: \\75 rl(https://evil/x.png);')).toBe('');
  });

  it('drops var(, expression(, image-set( and javascript payloads', () => {
    expect(sanitizeButtonCss('color: var(--steal);')).toBe('');
    expect(sanitizeButtonCss('background: expression(alert(1));')).toBe('');
    expect(sanitizeButtonCss('background-image: image-set("a.png" 1x);')).toBe('');
    expect(sanitizeButtonCss('cursor: javascript;')).toBe('');
  });

  it('drops layout/overlay properties BY OMISSION (position, margin, z-index, display, size, pointer-events)', () => {
    const out = sanitizeButtonCss(
      'position: absolute; z-index: 9999; margin: -100px; display: block; ' +
        'width: 5000px; height: 5000px; pointer-events: none; content: "x"; color: red;',
    );
    expect(out).toBe('color: red;');
  });

  it('keeps allowed declarations while dropping blocked ones in the same block', () => {
    const out = sanitizeButtonCss(
      'background-image: linear-gradient(180deg, #111, #444); position: fixed; font-size: 18px;',
    );
    expect(out).toContain('linear-gradient');
    expect(out).toContain('font-size: 18px');
    expect(out).not.toContain('position');
  });

  it('is idempotent', () => {
    const once = sanitizeButtonCss(
      'background-image: linear-gradient(90deg, #ff0000, #0000ff); color: #fff; ' +
        'border: 2px dashed #123456; padding: 2px 8px; position: absolute;',
    );
    expect(sanitizeButtonCss(once)).toBe(once);
  });

  it('returns "" for empty, whitespace and unparseable junk', () => {
    expect(sanitizeButtonCss('')).toBe('');
    expect(sanitizeButtonCss('   ')).toBe('');
    expect(sanitizeButtonCss('not css at all')).toBe('');
    expect(sanitizeButtonCss(';;;;')).toBe('');
  });

  it('drops !important declarations (the belt blocks "!")', () => {
    expect(sanitizeButtonCss('color: red !important;')).toBe('');
  });
});

describe('buttonStyleFromCss', () => {
  it('camelCases kept declarations into a React style object', () => {
    const style = buttonStyleFromCss(
      'background-image: linear-gradient(90deg, #ff0000, #0000ff); font-size: 18px; border-radius: 10px;',
    );
    expect(style['backgroundImage']).toContain('linear-gradient');
    expect(style['fontSize']).toBe('18px');
    expect(style['borderRadius']).toBe('10px');
  });

  it('never emits blocked properties (render-side second belt)', () => {
    const style = buttonStyleFromCss('position: absolute; margin: 10px; color: red;');
    expect(style['position']).toBeUndefined();
    expect(style['margin']).toBeUndefined();
    expect(style['color']).toBe('red');
  });

  it('returns {} for empty/blocked-only input', () => {
    expect(buttonStyleFromCss('')).toEqual({});
    expect(buttonStyleFromCss('z-index: 4;')).toEqual({});
  });
});
