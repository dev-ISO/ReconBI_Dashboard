import { describe, expect, it } from 'vitest';
import { composeDataLabel } from './dataLabels';

describe('composeDataLabel', () => {
  it("'value' (and unset) returns the formatted string untouched", () => {
    expect(composeDataLabel('1,234', 1234, 5000, 'value')).toBe('1,234');
    expect(composeDataLabel('1,234', 1234, 5000, undefined)).toBe('1,234');
  });

  it("'percent' renders the tooltip-style share", () => {
    expect(composeDataLabel('1,250', 1250, 5000, 'percent')).toBe('25.0%');
  });

  it("'both' composes value and share", () => {
    expect(composeDataLabel('1,250', 1250, 5000, 'both')).toBe('1,250 (25.0%)');
  });

  it('negative values keep their sign against a positive total (signed sums)', () => {
    expect(composeDataLabel('-1,250', -1250, 5000, 'percent')).toBe('-25.0%');
  });

  it('falls back to the plain value when the total is zero or negative', () => {
    expect(composeDataLabel('10', 10, 0, 'percent')).toBe('10');
    expect(composeDataLabel('10', 10, -40, 'both')).toBe('10');
  });

  it('falls back on non-finite inputs', () => {
    expect(composeDataLabel('10', 10, Number.NaN, 'percent')).toBe('10');
    expect(composeDataLabel('∞', Number.POSITIVE_INFINITY, 100, 'percent')).toBe('∞');
  });
});
