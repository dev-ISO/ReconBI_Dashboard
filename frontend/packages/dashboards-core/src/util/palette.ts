import type { ChartThemeName } from '../types/chart';
import { seriesStyleLookup } from './seriesStyle';

/**
 * Series color resolution: explicit override -> theme palette -> fixed
 * categorical CSS-variable slot. Slots are CSS variables so light/dark theming
 * is instant and host-driven; theme palettes are literal hex (identical in
 * both modes, like user overrides). More than 8 series should be folded to
 * "Other" upstream, never cycled.
 */
export const CATEGORICAL_SLOTS = 8;

/**
 * Predefined 8-slot palettes selectable per chart via format.theme. Hue
 * identities are stable across releases (saved dashboards must stay
 * recognizable); values are tuned toward the neutral shadcn-style UI — the
 * palest tints were deepened and the near-invisible extremes lifted so every
 * slot reads as a solid flat fill on both white and near-black surfaces.
 */
export const CHART_THEMES: Record<Exclude<ChartThemeName, 'default'>, readonly string[]> = {
  ocean: ['#1868ae', '#26a5b8', '#5fc3cd', '#0e4d92', '#5aa9e6', '#2d5f86', '#3caea3', '#6cc48f'],
  sunset: ['#f2542d', '#f9a03f', '#f5c33c', '#d81159', '#8f2d56', '#fb6f92', '#eda60a', '#c1440e'],
  forest: ['#2d6a4f', '#74c69d', '#40916c', '#93cfa9', '#27593f', '#7fc59b', '#588157', '#3f5d4b'],
  berry: ['#7b2cbf', '#c77dff', '#9d4edd', '#c793f2', '#5a189a', '#ff5d8f', '#b5179e', '#53228c'],
  mono: ['#1f2937', '#4b5563', '#6b7280', '#9ca3af', '#374151', '#aab1bb', '#111827', '#c3c8d0'],
};

export const seriesColor = (
  index: number,
  seriesKey?: string,
  overrides?: Record<string, string>,
  theme?: ChartThemeName,
  /**
   * Pre-Wave-21 raw-form key (seriesStyle.legacyInlineMeasureLabel): overrides
   * saved before friendly labels re-labeled inline measures still resolve.
   * Writes never use it — the swatch UI keys new overrides on `seriesKey`.
   */
  legacySeriesKey?: string,
): string => {
  if (seriesKey) {
    const override = seriesStyleLookup(overrides, seriesKey, legacySeriesKey);
    if (override) return override;
  }
  if (theme && theme !== 'default') {
    const palette = CHART_THEMES[theme];
    const themed = palette[index % palette.length];
    if (themed) return themed;
  }
  return `var(--rcd-cat-${(index % CATEGORICAL_SLOTS) + 1})`;
};
