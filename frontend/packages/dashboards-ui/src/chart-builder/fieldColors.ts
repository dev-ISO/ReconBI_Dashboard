/**
 * FIELD KINDS AND THEIR COLOURS.
 *
 * A field's colour encodes WHAT KIND OF THING IT IS — text, number, date,
 * yes/no, or a measure — and nothing else. Not its folder, not its scope, not
 * which chart it is in. That is the property worth spending colour on: it is
 * the question a chart author actually asks of the list ("where is a date I
 * can put on this axis?"), and because it is intrinsic to the field, a colour
 * means the same thing in every grouping mode and in the wells.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE:
 *  1. Colour is an ACCENT on a glyph that is already distinct by SHAPE, next
 *     to text that already says the name. Remove the colour and the list still
 *     works — which is the requirement, not a nicety.
 *  2. The tokens are the field-list family (--rcd-field-*), never the
 *     categorical chart palette (--rcd-cat-*). Those answer a different
 *     question and are free to change without consulting this file.
 */
import { isNumericType, isTemporalType, type ColumnType } from '@recon/dashboards-core';

/** The five kinds a field row can be. Also the "Type" grouping's groups. */
export type FieldKind = 'text' | 'number' | 'date' | 'boolean' | 'measure';

/**
 * Display order for the Type grouping, and for anything else that lists all
 * five: the shapes a chart author reaches for most, first.
 */
export const FIELD_KINDS: readonly FieldKind[] = ['text', 'number', 'date', 'boolean', 'measure'];

/** Group heading / legend label. 'boolean' reads as "Yes/No" to a user. */
export const fieldKindLabel = (kind: FieldKind): string => {
  switch (kind) {
    case 'text':
      return 'Text';
    case 'number':
      return 'Number';
    case 'date':
      return 'Date';
    case 'boolean':
      return 'Yes/No';
    case 'measure':
      return 'Measures';
  }
};

/**
 * Which kind a catalog column counts as. uuid falls in with text (it is a
 * categorical identifier and groups like one); json/other are not queryable
 * and never reach a field list at all, but they are mapped rather than thrown
 * so a caller can never get `undefined` back.
 */
export const fieldKindOfColumnType = (type: ColumnType): FieldKind => {
  if (isNumericType(type)) return 'number';
  if (isTemporalType(type)) return 'date';
  if (type === 'boolean') return 'boolean';
  return 'text';
};

/**
 * CSS token reference for a kind, ready for an inline `style` — the same
 * `var(--rcd-…)` idiom the categorical palette uses. Inline rather than a
 * Tailwind class on purpose: the library's preset maps only a handful of
 * tokens, and a host's Tailwind build would have to be re-generated to learn
 * new ones. A var() reference works in every host, embedded or standalone.
 */
export const fieldKindColor = (kind: FieldKind): string => `var(--rcd-field-${kind})`;

/** Inline style for a coloured glyph. `currentColor` icons inherit it. */
export const fieldKindStyle = (kind: FieldKind): { color: string } => ({
  color: fieldKindColor(kind),
});
