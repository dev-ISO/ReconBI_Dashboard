/**
 * Final on-mark data-label text for ChartFormat.dataLabelContent.
 *
 * `formatted` is the value already rendered through the chart's value
 * formatter (valueFormat / measure metadata — composed OUTSIDE, the formatter
 * returns a finished string); `value` and `total` are the raw numbers. The
 * percent string follows the tooltip precedent: (value/total*100).toFixed(1)%.
 *
 * Denominators are SIGNED sums, exactly what the axis/stack reads — no
 * absolute values, so a negative segment of a positive stack reads as a
 * negative share, consistent with the marks. When the total is not a positive
 * finite number a share cannot be stated honestly and the label falls back to
 * the plain value.
 */
export const composeDataLabel = (
  formatted: string,
  value: number,
  total: number,
  content: 'value' | 'percent' | 'both' | undefined,
): string => {
  const mode = content ?? 'value';
  if (mode === 'value') return formatted;
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return formatted;
  const percent = `${((value / total) * 100).toFixed(1)}%`;
  return mode === 'percent' ? percent : `${formatted} (${percent})`;
};
