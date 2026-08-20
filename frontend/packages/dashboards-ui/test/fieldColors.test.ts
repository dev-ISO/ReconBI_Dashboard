/**
 * FIELD-TYPE COLOURS — legible in both themes, and never load-bearing.
 *
 * Colour here is an accent on a glyph that is already distinct by shape, next
 * to text that already names the field. That is the accessibility rule, and
 * the tests below are its enforcement: the KIND mapping is exhaustive (so a
 * new column type cannot silently lose its colour AND its icon), and every
 * token clears the WCAG 1.4.11 bar of 3:1 against the surface it is drawn on
 * in BOTH themes.
 *
 * The contrast maths is the library's existing relativeLuminance/contrastRatio
 * pair, not a private copy: there are already two luminance implementations in
 * this codebase (buttons and Gantt ink) and a third — even one hiding in a
 * test — would be one too many.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ColumnType } from '@recon/dashboards-core';
import { contrastRatio } from '../src/dashboard/buttonLayout';
import {
  FIELD_KINDS,
  fieldKindColor,
  fieldKindLabel,
  fieldKindOfColumnType,
  fieldKindStyle,
  type FieldKind,
} from '../src/chart-builder/fieldColors';

const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/rcd.css', import.meta.url)),
  'utf8',
);

/** The two theme blocks, so a token can be read per theme. */
const THEMES = {
  light: { block: CSS.slice(0, CSS.indexOf("html[data-theme='dark']")), surface: '#ffffff' },
  dark: {
    block: CSS.slice(CSS.indexOf("html[data-theme='dark']")),
    surface: '#18181b',
  },
} as const;

const tokenValue = (theme: keyof typeof THEMES, kind: FieldKind): string => {
  const match = new RegExp(`--rcd-field-${kind}:\\s*(#[0-9a-fA-F]{3,8})`).exec(THEMES[theme].block);
  if (!match) throw new Error(`--rcd-field-${kind} is not defined in the ${theme} theme`);
  return match[1]!;
};

/** WCAG 1.4.11 non-text contrast: a graphical object needs 3:1. */
const MIN_GLYPH_CONTRAST = 3;

describe('field-type colours', () => {
  it('maps every column type to a kind — no type can fall through', () => {
    const types: ColumnType[] = [
      'text',
      'integer',
      'decimal',
      'boolean',
      'date',
      'timestamp',
      'uuid',
      'json',
      'other',
    ];
    for (const type of types) {
      expect(FIELD_KINDS).toContain(fieldKindOfColumnType(type));
    }
    expect(fieldKindOfColumnType('integer')).toBe('number');
    expect(fieldKindOfColumnType('decimal')).toBe('number');
    expect(fieldKindOfColumnType('timestamp')).toBe('date');
    // uuid is a categorical identifier: it groups like text and reads like text.
    expect(fieldKindOfColumnType('uuid')).toBe('text');
  });

  it('labels boolean as the user’s word for it', () => {
    expect(fieldKindLabel('boolean')).toBe('Yes/No');
    expect(FIELD_KINDS.map(fieldKindLabel)).toEqual([
      'Text',
      'Number',
      'Date',
      'Yes/No',
      'Measures',
    ]);
  });

  it('references its OWN token family, never the categorical chart palette', () => {
    for (const kind of FIELD_KINDS) {
      expect(fieldKindColor(kind)).toBe(`var(--rcd-field-${kind})`);
      // A future --rcd-cat-N palette change must not restyle the field list.
      expect(fieldKindColor(kind)).not.toContain('--rcd-cat');
      expect(fieldKindStyle(kind)).toEqual({ color: `var(--rcd-field-${kind})` });
    }
  });

  it('defines all five tokens in BOTH themes', () => {
    for (const kind of FIELD_KINDS) {
      expect(tokenValue('light', kind)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokenValue('dark', kind)).toMatch(/^#[0-9a-f]{6}$/i);
      // Dark is RE-STEPPED, not reused: the 700-weight light values fall to
      // roughly 2:1 on a #18181b card.
      expect(tokenValue('dark', kind)).not.toBe(tokenValue('light', kind));
    }
  });

  it('every glyph clears 3:1 on its theme’s surface', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const kind of FIELD_KINDS) {
        const ratio = contrastRatio(tokenValue(theme, kind), THEMES[theme].surface);
        expect(ratio, `${kind} on ${theme}`).not.toBeNull();
        expect(ratio!, `${kind} on ${theme}`).toBeGreaterThanOrEqual(MIN_GLYPH_CONTRAST);
      }
    }
  });

  it('the five colours are distinguishable from EACH OTHER, not just from the page', () => {
    // Colour is never the only signal, but two kinds that read as the same hue
    // would make it actively misleading. 1.35:1 between neighbours is enough
    // to separate them at glyph size without forcing garish steps.
    for (const theme of ['light', 'dark'] as const) {
      for (const a of FIELD_KINDS) {
        for (const b of FIELD_KINDS) {
          if (a === b) continue;
          expect(tokenValue(theme, a), `${a} vs ${b} on ${theme}`).not.toBe(tokenValue(theme, b));
        }
      }
    }
  });
});

describe('contrastRatio', () => {
  it('is the WCAG ratio, symmetric, 1 for identical and 21 for black on white', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('returns null rather than guessing at an unparseable colour', () => {
    expect(contrastRatio('rebeccapurple', '#ffffff')).toBeNull();
    expect(contrastRatio('#ffffff', 'var(--x)')).toBeNull();
  });
});
