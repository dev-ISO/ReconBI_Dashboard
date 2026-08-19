import { useMemo } from 'react';
import { buttonStyleFromCss, sanitizeRichHtml } from '@recon/dashboards-core';
import { LIST_CLASSES } from '../richtext/richTextClasses';
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
const LABEL_CLASSES =
  'text-sm leading-snug [overflow-wrap:anywhere] [&_p]:my-0 ' +
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
  onActivate,
  disabled,
}: {
  spec: ButtonVisualSpec;
  /** Fill the given box instead of auto-sizing (single tile's fullSize and
   *  a group's align:'stretch' cross-axis fill). */
  fullSize?: boolean;
  /** Navigation callback; absent renders an inert preview. */
  onActivate?: () => void;
  /** Broken target: inert, no pointer affordance. */
  disabled?: boolean;
}) {
  const html = useMemo(() => sanitizeRichHtml(spec.html), [spec.html]);
  // Render-side second belt: the store sanitized on write, and this sanitizes
  // again before the declarations reach the element.
  const customStyle = useMemo(() => buttonStyleFromCss(spec.customCss ?? ''), [spec.customCss]);
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
        ...(spec.textColor ? { color: spec.textColor } : null),
        ...customStyle,
      }}
      className={`${fullSize ? 'h-full w-full' : 'max-h-full max-w-full px-4 py-1.5'} ${
        spec.background
          ? 'border border-transparent text-rcd-text'
          : 'border border-rcd-border bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-1)]'
      } ${disabled ? 'cursor-default opacity-60' : onActivate ? 'transition-[filter] hover:brightness-95 active:brightness-90' : 'cursor-default'} shrink-0 overflow-hidden`}
    >
      <span className={LABEL_CLASSES} dangerouslySetInnerHTML={{ __html: html || '<p>Button</p>' }} />
    </button>
  );
}
