import type { CSSProperties } from 'react';
import type { TextStyle } from '@recon/dashboards-core';

/**
 * Maps a ChartFormat TextStyle onto inline CSS. Only set fields are emitted,
 * so theme defaults (Tailwind classes / --rcd-* tokens) keep applying to the
 * rest. Consumers: axis/legend/KPI text here, and the tile frame's title
 * (rendered outside this folder) can reuse it for format.titleStyle.
 */
export function textStyleToCss(style?: TextStyle): CSSProperties {
  if (!style) return {};
  const css: CSSProperties = {};
  if (style.fontSize !== undefined) css.fontSize = style.fontSize;
  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = 'italic';
  if (style.color) css.color = style.color;
  return css;
}
