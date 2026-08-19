/**
 * Element styling for the sanitized rich-text subset (Tailwind preflight
 * strips default margins/list styles, so every rendered surface must restore
 * them explicitly). Arbitrary variants keep the classes literal so any host
 * Tailwind build generates them — each full class name lives inside ONE
 * string literal (never split across a concatenation) for the same reason.
 *
 * Shared here (not in TextTile) so the editing surface, the rich-text
 * dialogs, and every read-only renderer style the SAME subset identically —
 * lists especially: markup that looks right in the editor must look right on
 * the tile, in print, and in dialog previews.
 */

/**
 * Word-like nested-list defaults: each nesting level gets the next marker in
 * Word's ladder (disc → circle → square, decimal → lower-alpha → lower-roman)
 * unless the author picked an explicit marker in the gallery — an inline
 * list-style-type (the only way the sanitizer lets a marker through) always
 * beats these class defaults.
 */
export const NESTED_LIST_CLASSES =
  '[&_ul_ul]:list-[circle] [&_ul_ul_ul]:list-[square] ' +
  '[&_ol_ol]:list-[lower-alpha] [&_ol_ol_ol]:list-[lower-roman]';

/** Base list rendering (top-level markers + indent) plus the nested ladder. */
export const LIST_CLASSES =
  '[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 ' + NESTED_LIST_CLASSES;

/**
 * The full rich-text body styling used by text tiles and the rich-text
 * editors/previews (dialogs included — lists rendered there must not appear
 * unstyled while the tile shows markers).
 */
export const RICH_TEXT_CLASSES =
  'text-sm leading-snug text-rcd-text [overflow-wrap:anywhere] ' +
  '[&_a]:text-rcd-accent [&_a]:underline ' +
  '[&_h1]:my-1 [&_h1]:text-2xl [&_h1]:font-semibold ' +
  '[&_h2]:my-1 [&_h2]:text-xl [&_h2]:font-semibold ' +
  '[&_h3]:my-0.5 [&_h3]:text-lg [&_h3]:font-semibold ' +
  '[&_li]:my-0.5 [&_p]:my-0.5 ' +
  LIST_CLASSES;
