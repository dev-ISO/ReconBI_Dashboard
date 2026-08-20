import { useMemo } from 'react';
import { buttonStyleFromCss, sanitizeRichHtml } from '@recon/dashboards-core';
import { LIST_CLASSES } from '../richtext/richTextClasses';
import {
  BUTTON_VARIANT_CLASSES,
  contrastingTextColor,
  slicerPillClasses,
  type ButtonScale,
  type ButtonVariant,
} from './buttonLayout';
import { clickFollowsGridDrag } from './DashboardGrid';

/** Plain text of a rich button label (tags stripped), for frame titles/aria.
 *  Takes any label-carrying shape — single-tile specs and group buttons both. */
export const buttonLabelText = (spec: { html: string }): string =>
  spec.html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Element styling for the sanitized label subset (paragraph margins collapse
 *  so short labels center cleanly inside the button chrome). LIST_CLASSES as
 *  a second belt: the label editor disables list UI, but pasted content can
 *  carry lists through the sanitizer — they must not render marker-less. */
/* NOTE: no text-size class here — the SIZE lives on the button (the shared
 * scale's text-xs/text-sm/text-[15px]) and the label inherits it. A text-sm on
 * this span would silently defeat the sm/lg sizes. */
const LABEL_CLASSES =
  'leading-snug [overflow-wrap:anywhere] [&_p]:my-0 ' +
  '[&_h1]:my-0 [&_h1]:text-xl [&_h1]:font-semibold ' +
  '[&_h2]:my-0 [&_h2]:text-lg [&_h2]:font-semibold ' +
  '[&_h3]:my-0 [&_h3]:text-base [&_h3]:font-semibold ' +
  LIST_CLASSES;

/** The stylable fields ButtonVisual consumes — the intersection of
 *  ButtonTileSpec and ButtonGroupButton, so single buttons and group items
 *  render through the identical component (and the dialogs' live previews
 *  render the exact truth). */
export interface ButtonVisualSpec {
  html: string;
  background?: string | null;
  textColor?: string | null;
  radius?: number;
  customCss?: string;
}

/**
 * THE button rendering, shared by the single-button tile, every button of a
 * group, and the edit dialogs' live previews. A real <button> keeps
 * focus/keyboard semantics; the rich LABEL rides inside it (sanitized again
 * as the usual second belt — this is a static render, never a live
 * contentEditable, so dangerouslySetInnerHTML is fine here). Style layering,
 * base → custom: preset chrome classes, then the background/textColor custom
 * colors (B1 — a custom color overrides the preset look), then the sanitized
 * customCss declarations (B2 — the full-control layer wins over everything).
 *
 * B5: clicks NAVIGATE in both view and edit mode; the click that concludes a
 * grid drag is swallowed via clickFollowsGridDrag (in edit mode the button
 * body doubles as a grid drag handle).
 */
export function ButtonVisual({
  spec,
  fullSize = false,
  size = null,
  variant = 'default',
  stretch = false,
  onActivate,
  disabled,
}: {
  spec: ButtonVisualSpec;
  /** Fill the given box instead of auto-sizing (single tile's fullSize and
   *  a group's align:'stretch' cross-axis fill). */
  fullSize?: boolean;
  /**
   * Shared button scale — a FIXED height + padding + text size (A6). null
   * keeps the pre-0.14.1 auto geometry (padding-only, height follows the
   * label), which the single-button tile stays on: its label may be several
   * rich lines tall and a fixed height would clip it.
   */
  size?: ButtonScale | null;
  /** Preset chrome, applied BELOW spec.background. */
  variant?: ButtonVariant;
  /** Equal-width mode: fill the grid track instead of hugging the label. */
  stretch?: boolean;
  /** Navigation callback; absent renders an inert preview. */
  onActivate?: () => void;
  /** Broken target: inert, no pointer affordance. */
  disabled?: boolean;
}) {
  const html = useMemo(() => sanitizeRichHtml(spec.html), [spec.html]);
  // Render-side second belt: the store sanitized on write, and this sanitizes
  // again before the declarations reach the element.
  const customStyle = useMemo(() => buttonStyleFromCss(spec.customCss ?? ''), [spec.customCss]);

  // A5 CONTRAST: a custom fill with no textColor used to keep text-rcd-text in
  // BOTH branches — near-black label text on a dark fill. Derive a readable
  // color instead (still beaten by textColor and by customCss, which spread
  // after it).
  // TWO-SIDED on purpose: the fill is a persisted literal that does NOT follow
  // the theme, so letting the label follow it is exactly what washes a pale
  // button out in dark mode (the theme token resolves to near-white on top of
  // a near-white fill). Dark ink is correct on a pale fill in BOTH themes.
  const derivedTextColor =
    spec.background && !spec.textColor ? contrastingTextColor(spec.background) : null;

  const geometry = fullSize
    ? 'h-full w-full shrink-0'
    : `${size ? slicerPillClasses(size) : 'px-4 py-1.5 text-sm'} max-h-full ${
        stretch ? 'w-full min-w-0' : 'max-w-full shrink-0'
      }`;

  return (
    <button
      type="button"
      tabIndex={onActivate ? 0 : -1}
      aria-label={buttonLabelText(spec) || 'Button'}
      disabled={disabled}
      onClick={
        onActivate
          ? () => {
              // A drag's closing click moves the tile — it never navigates.
              if (clickFollowsGridDrag()) return;
              onActivate();
            }
          : undefined
      }
      style={{
        borderRadius: spec.radius ?? 8,
        ...(spec.background ? { backgroundColor: spec.background } : null),
        ...(derivedTextColor ? { color: derivedTextColor } : null),
        ...(spec.textColor ? { color: spec.textColor } : null),
        ...customStyle,
      }}
      className={`${geometry} ${
        spec.background
          ? 'border border-transparent text-rcd-text'
          : BUTTON_VARIANT_CLASSES[variant]
      } ${disabled ? 'cursor-default opacity-60' : onActivate ? 'transition-[filter] hover:brightness-95 active:brightness-90' : 'cursor-default'} overflow-hidden`}
    >
      <span className={LABEL_CLASSES} dangerouslySetInnerHTML={{ __html: html || '<p>Button</p>' }} />
    </button>
  );
}
