/**
 * Series color resolution: explicit override -> fixed categorical slot.
 * Slots are CSS variables so light/dark theming is instant and host-driven.
 * More than 8 series should be folded to "Other" upstream, never cycled.
 */
export const CATEGORICAL_SLOTS = 8;

export const seriesColor = (
  index: number,
  seriesKey?: string,
  overrides?: Record<string, string>,
): string => {
  if (seriesKey && overrides?.[seriesKey]) return overrides[seriesKey];
  return `var(--rcd-cat-${(index % CATEGORICAL_SLOTS) + 1})`;
};
