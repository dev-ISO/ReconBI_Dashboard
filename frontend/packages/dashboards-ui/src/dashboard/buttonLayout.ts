import type { CSSProperties } from 'react';

/**
 * SHARED BUTTON VOCABULARY (0.14.1 / A6 "toolbar bar").
 *
 * The buttons-variant slicer grew the only cohesive button language in the
 * library — one size scale with FIXED heights, a gap tied to that scale, one
 * pill geometry, and a fill layout that keeps wrapped rows from going ragged.
 * Button tiles had none of it (auto height, free-form padding), which is why a
 * group read as "random buttons placed". This module is that vocabulary lifted
 * out of SlicerTile.tsx VERBATIM so BOTH consumers share it by construction:
 * SlicerTile re-exports the two helpers (its callers and tests are unchanged)
 * and ButtonVisual/ButtonGroupTile now render through the same classes.
 *
 * Literal class names throughout — host Tailwind builds scan for whole names.
 */

/** The one size scale (SlicerTileStyle.buttonSize / ButtonGroupTileSpec.size). */
export type ButtonScale = 'sm' | 'md' | 'lg';

/** FIXED heights — the thing button tiles lacked; uniform rows come from here. */
export const BUTTON_SIZE_CLASSES: Record<ButtonScale, string> = {
  sm: 'h-6 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-10 px-4 text-[15px]',
};

export const BUTTON_GAP_CLASSES: Record<ButtonScale, string> = {
  sm: 'gap-1',
  md: 'gap-1.5',
  lg: 'gap-2',
};

/** Horizontal placement of the group / of items inside grid cells. */
export const BUTTON_JUSTIFY_CLASSES = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
} as const;

export const BUTTON_JUSTIFY_ITEMS_CLASSES = {
  left: 'justify-items-start',
  center: 'justify-items-center',
  right: 'justify-items-end',
} as const;

/** Vertical placement of the whole group inside the tile body. */
export const BUTTON_VALIGN_CLASSES = {
  top: 'justify-start',
  middle: 'justify-center',
  bottom: 'justify-end',
} as const;

/**
 * Shared pill geometry for EVERY slicer button surface (ButtonsSlicer and
 * FieldParamSlicer) and, since 0.14.1, every sized button tile: one size
 * scale, centered content, truncation-safe. State colors (active/idle/
 * unavailable, or a button tile's variant/fill) stay with each consumer.
 */
export const slicerPillClasses = (size: ButtonScale): string =>
  `inline-flex items-center justify-center overflow-hidden rounded-md border transition-colors ${BUTTON_SIZE_CLASSES[size]}`;

/**
 * Container classes (+ inline grid template) for a buttons group.
 *
 * Fill mode is a CSS GRID of uniform auto-fill tracks — flex with
 * `flex-1 basis-24` distributed the leftover space PER LINE, so a 2-pill
 * last row grew to half the tile while the 5-pill rows above stayed narrow
 * (the ragged-widths bug); minmax(6rem, 1fr) keeps every pill the same width
 * on every row while wrapping stays intact. Explicit `columns` keeps its
 * fixed-track grid exactly as before; items-center rides every branch.
 */
export const slicerButtonLayout = (
  size: ButtonScale,
  align: keyof typeof BUTTON_JUSTIFY_CLASSES,
  fill: boolean,
  columns: number | null,
): { group: string; item: string; gridTemplateColumns?: string } => {
  const gap = BUTTON_GAP_CLASSES[size];
  if (columns !== null) {
    return {
      group: `grid ${gap} content-start items-center ${
        fill ? 'justify-items-stretch' : BUTTON_JUSTIFY_ITEMS_CLASSES[align]
      }`,
      item: fill ? 'w-full min-w-0' : 'max-w-full',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    };
  }
  if (fill) {
    return {
      group: `grid ${gap} content-start items-center justify-items-stretch`,
      item: 'w-full min-w-0',
      gridTemplateColumns: 'repeat(auto-fill, minmax(6rem, 1fr))',
    };
  }
  return {
    group: `flex flex-wrap content-start items-center ${gap} ${BUTTON_JUSTIFY_CLASSES[align]}`,
    item: 'max-w-full',
  };
};

/* ------------------------------------------------ button-group packing (A2)
 * The group tile packs with INLINE flex/grid (its gap is an authored px value,
 * not a class), so it needs the same vocabulary expressed as CSS values.
 */

/** ButtonGroupTileSpec.justify -> main-axis distribution. */
export const GROUP_JUSTIFY_CONTENT = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
  between: 'space-between',
} as const;

export type ButtonGroupJustify = keyof typeof GROUP_JUSTIFY_CONTENT;

/** ButtonGroupTileSpec.align -> cross-axis alignment (alignItems). */
export const GROUP_ALIGN_ITEMS = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
} as const;

export type ButtonGroupAlign = keyof typeof GROUP_ALIGN_ITEMS;

/**
 * alignContent for a WRAPPING group. It is a CROSS-axis property, so it
 * follows `align` (the cross-axis control) — the container used to hardcode
 * flex-start, which is why wrapped rows hugged the top no matter what the
 * author picked. 'stretch' is alignItems-only for lines, so wrapped lines
 * stretch to share the cross axis, which is the honest reading of it.
 */
export const groupAlignContent = (align: ButtonGroupAlign): CSSProperties['alignContent'] =>
  GROUP_ALIGN_ITEMS[align];

/* ------------------------------------------------------------ variants (A6)
 * A preset chrome layer BELOW spec.background: dashboard.ts has always
 * promised a custom fill "always overrides the preset chrome", so a button
 * with a background never takes a variant's own fill classes.
 */

export type ButtonVariant = 'default' | 'primary' | 'ghost';

/** RcdButton's vocabulary (primitives/index.tsx) mapped onto button tiles. */
export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default: 'border border-rcd-border bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-1)]',
  primary: 'border border-transparent bg-rcd-accent text-white shadow-[var(--rcd-shadow-1)]',
  ghost: 'border border-transparent bg-transparent text-rcd-text-2',
};

/* ------------------------------------------------------- label contrast (A5)
 * ButtonVisual kept the `text-rcd-text` class in BOTH branches, so a dark
 * custom fill with no textColor rendered near-black label text. When the
 * author picked a fill but no text color, DERIVE one.
 */

/** #rgb / #rrggbb -> [r,g,b] 0-255; null for anything else (values persist verbatim). */
const rgbOfHex = (hex: string): [number, number, number] | null => {
  const raw = hex.trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
};

/** WCAG relative luminance of an sRGB channel. */
const channelLuminance = (value: number): number => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * WCAG relative luminance (0 = black, 1 = white). Exported for the tests that
 * pin the switch point.
 */
export const relativeLuminance = (hex: string): number | null => {
  const rgb = rgbOfHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  return (
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
  );
};

/**
 * The crossover luminance where white text stops out-contrasting black text
 * (sqrt(1.05 * 0.05) - 0.05 ≈ 0.179 — the standard WCAG switch point).
 */
export const CONTRAST_SWITCH_LUMINANCE = 0.179;

/**
 * WCAG contrast ratio between two colors, 1 (identical) to 21 (black/white);
 * null when either color cannot be parsed.
 *
 * Lives HERE, on top of relativeLuminance, so nothing has to re-derive the
 * (L+0.05) ratio anywhere else. The library already carries two luminance
 * implementations (this one and the Gantt bar-ink one); a third would be one
 * too many, and a private copy inside a test would be the same mistake with
 * less visibility.
 */
export const contrastRatio = (a: string, b: string): number | null => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * A readable label color for a custom fill: '#ffffff' on dark fills, null on
 * light ones (null keeps the theme's own text token, which is correct there
 * AND stays theme-aware). null for unparseable values — an author-supplied
 * string is never second-guessed.
 */
export const readableTextColor = (background: string): string | null => {
  const luminance = relativeLuminance(background);
  if (luminance === null) return null;
  return luminance < CONTRAST_SWITCH_LUMINANCE ? '#ffffff' : null;
};

/**
 * Near-black ink for fills too light to carry white text. Literal (not
 * var(--rcd-text)) on purpose and equal to the LIGHT theme's text token: it is
 * paired with a fill that is itself persisted verbatim, so the pair must read
 * the same for every viewer regardless of THEIR theme — a token would flip to
 * near-white in dark mode and wash straight back out.
 */
export const DARK_INK = '#09090b';

/**
 * TWO-SIDED sibling of readableTextColor, for surfaces whose text color is
 * NOT theme-managed once a background is set.
 *
 * readableTextColor returns null on light fills to defer to the theme's own
 * token, which is right for buttons (their class-driven color still adapts).
 * A rich-text tile has no such luck: it paints the persisted background but
 * inherits `text-rcd-text`, which FLIPS to near-white in dark mode over a
 * background that did not — the pale-tile wash-out. So: white below the WCAG
 * switch point, explicit dark ink above it, and null ONLY when the color
 * cannot be parsed (an author-supplied string is never second-guessed).
 *
 * Shares rgbOfHex/relativeLuminance/CONTRAST_SWITCH_LUMINANCE with its
 * one-sided sibling — deliberately no second luminance implementation.
 */
export const contrastingTextColor = (background: string): string | null => {
  const luminance = relativeLuminance(background);
  if (luminance === null) return null;
  return luminance < CONTRAST_SWITCH_LUMINANCE ? '#ffffff' : DARK_INK;
};
