import type { QueryColumn, CellValue } from '../types/query';
import type { AxisValueFormat, DateFormatPreset } from '../types/chart';

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const currencyFormat = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const percentFormat = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const yearFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric' });

/** Human label for one cell, driven by the column's type/bucket/format hint. */
export const formatCellValue = (value: CellValue, column: QueryColumn): string => {
  if (value === null) return '(Blank)';

  if (typeof value === 'number') {
    const hint = column.formatHint ?? '';
    if (hint.includes('$') || hint === 'currency') return currencyFormat.format(value);
    if (hint.includes('%') || hint === 'percent') return percentFormat.format(value);
    return numberFormat.format(value);
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  if ((column.type === 'date' || column.type === 'timestamp') && typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      switch (column.dateBucket) {
        case 'year':
          return yearFormat.format(parsed);
        case 'quarter':
          return `Q${Math.floor(parsed.getMonth() / 3) + 1} ${parsed.getFullYear()}`;
        case 'month':
          return monthFormat.format(parsed);
        default:
          return dateFormat.format(parsed);
      }
    }
  }

  return String(value);
};

/** Numeric axis tick formatting per AxisValueFormat. */
export const formatAxisValue = (value: number, format?: AxisValueFormat): string => {
  const decimals = format?.decimals;
  switch (format?.kind ?? 'auto') {
    case 'currency':
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: decimals ?? 0,
      }).format(value);
    case 'percent':
      return new Intl.NumberFormat(undefined, {
        style: 'percent',
        maximumFractionDigits: decimals ?? 1,
      }).format(value);
    case 'compact':
      return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: decimals ?? 1,
      }).format(value);
    case 'number':
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: decimals ?? 0,
        minimumFractionDigits: decimals !== undefined ? decimals : undefined,
      }).format(value);
    default:
      return numberFormat.format(value);
  }
};

/** Date axis label per preset; falls back to the bucket-aware default. */
export const formatDateLabel = (
  value: CellValue,
  column: QueryColumn,
  preset?: DateFormatPreset,
): string => {
  if (value === null) return '(Blank)';
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || !preset || preset === 'auto') {
    return formatCellValue(value, column);
  }
  switch (preset) {
    case 'monthShort':
      return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(parsed);
    case 'monthLong':
      return new Intl.DateTimeFormat(undefined, { month: 'long' }).format(parsed);
    case 'monthNum':
      return String(parsed.getMonth() + 1);
    case 'monthYear':
      return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(parsed);
    case 'dayShort':
      return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(parsed);
    case 'dayLong':
      return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(parsed);
    case 'dayOfMonth':
      return String(parsed.getDate());
    case 'quarter':
      return `Q${Math.floor(parsed.getMonth() / 3) + 1} ${parsed.getFullYear()}`;
    case 'year':
      return String(parsed.getFullYear());
    case 'isoDate':
      return parsed.toISOString().slice(0, 10);
    default:
      return formatCellValue(value, column);
  }
};
