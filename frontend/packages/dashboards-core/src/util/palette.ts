import type { ChartThemeName } from '../types/chart';

/**
 * Series color resolution: explicit override -> theme palette -> fixed
 * categorical CSS-variable slot. Slots are CSS variables so light/dark theming
 * is instant and host-driven; theme palettes are literal hex (identical in
 * both modes, like user overrides). More than 8 series should be folded to
 * "Other" upstream, never cycled.
 */
export const CATEGORICAL_SLOTS = 8;

/** Predefined 8-slot palettes selectable per chart via format.theme. */
export const CHART_THEMES: Record<Exclude<ChartThemeName, 'default'>, readonly string[]> = {
  ocean: ['#1868ae', '#26a5b8', '#7cd0d8', '#0e4d92', '#5aa9e6', '#173f5f', '#3caea3', '#8fd5a6'],
  sunset: ['#f2542d', '#f9a03f', '#ffd166', '#d81159', '#8f2d56', '#fb6f92', '#ffb703', '#c1440e'],
  forest: ['#2d6a4f', '#74c69d', '#40916c', '#b7e4c7', '#1b4332', '#95d5b2', '#588157', '#344e41'],
  berry: ['#7b2cbf', '#c77dff', '#9d4edd', '#e0aaff', '#5a189a', '#ff5d8f', '#b5179e', '#3c096c'],
  mono: ['#1f2937', '#4b5563', '#6b7280', '#9ca3af', '#374151', '#d1d5db', '#111827', '#e5e7eb'],
};

export const seriesColor = (
  index: number,
  seriesKey?: string,
  overrides?: Record<string, string>,
  theme?: ChartThemeName,
): string => {
  if (seriesKey && overrides?.[seriesKey]) return overrides[seriesKey];
  if (theme && theme !== 'default') {
    const palette = CHART_THEMES[theme];
    const themed = palette[index % palette.length];
    if (themed) return themed;
  }
  return `var(--rcd-cat-${(index % CATEGORICAL_SLOTS) + 1})`;
};
