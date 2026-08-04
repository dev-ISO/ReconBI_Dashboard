import type { QueryColumn, CellValue } from '../types/query';

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
