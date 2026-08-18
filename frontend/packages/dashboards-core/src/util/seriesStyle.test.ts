import { describe, expect, it } from 'vitest';
import { legacyInlineMeasureLabel, seriesStyleLookup } from './seriesStyle';

/* Wave 21 friendly labels changed the DEFAULT label of unaliased inline
 * measures ("Sum of open_vent" -> "Sum of Open Vent") — the very string every
 * per-series style map keys on. These tests pin the compatibility contract:
 * reads fall back to the legacy raw-form key, writes use the new key, and the
 * legacy key is composed byte-identically to the OLD server format
 * ($"{Aggregation} of {spec.Column}" with C# enum casing + calc suffix). */

describe('seriesStyleLookup', () => {
  const map = {
    'Sum of Open Vent': '#new',
    'Sum of open_vent': '#legacy',
    'Avg of pressure': '#only-legacy',
  };

  it('prefers the current styleKey when both keys are present', () => {
    expect(seriesStyleLookup(map, 'Sum of Open Vent', 'Sum of open_vent')).toBe('#new');
  });

  it('falls back to the legacy raw-form key when the friendly key misses', () => {
    expect(seriesStyleLookup(map, 'Avg of Line Pressure', 'Avg of pressure')).toBe(
      '#only-legacy',
    );
  });

  it('returns undefined when neither key resolves', () => {
    expect(seriesStyleLookup(map, 'Max of Flow', 'Max of flow')).toBeUndefined();
  });

  it('never falls back without a legacy key', () => {
    expect(seriesStyleLookup(map, 'Avg of Line Pressure')).toBeUndefined();
  });

  it('tolerates an absent map', () => {
    expect(seriesStyleLookup(undefined, 'Sum of Open Vent', 'Sum of open_vent')).toBeUndefined();
  });
});

describe('legacyInlineMeasureLabel', () => {
  it('composes "<Agg> of <raw column>" with the C# enum casing', () => {
    expect(
      legacyInlineMeasureLabel({ table: 'public.orders', column: 'order_total', aggregation: 'sum' }),
    ).toBe('Sum of order_total');
  });

  it.each([
    ['countDistinct', 'CountDistinct'],
    ['stdDev', 'StdDev'],
    ['variance', 'Variance'],
    ['median', 'Median'],
    ['avg', 'Avg'],
  ] as const)('casing: %s -> %s', (wire, pascal) => {
    expect(
      legacyInlineMeasureLabel({ table: 't', column: 'c', aggregation: wire }),
    ).toBe(`${pascal} of c`);
  });

  it('appends the calc suffix exactly as the server does', () => {
    expect(
      legacyInlineMeasureLabel({
        table: 't',
        column: 'order_total',
        aggregation: 'sum',
        calc: { kind: 'runningTotal' },
      }),
    ).toBe('Sum of order_total (running total)');
    expect(
      legacyInlineMeasureLabel({
        table: 't',
        column: 'c',
        aggregation: 'avg',
        calc: { kind: 'periodChangePct' },
      }),
    ).toBe('Avg of c (% change)');
    expect(
      legacyInlineMeasureLabel({
        table: 't',
        column: 'c',
        aggregation: 'sum',
        calc: { kind: 'ytd' },
      }),
    ).toBe('Sum of c (YTD)');
  });

  it('returns null for the shapes Wave 21 never re-labeled', () => {
    // Alias wins then and now.
    expect(
      legacyInlineMeasureLabel({ table: 't', column: 'c', aggregation: 'sum', alias: 'My Total' }),
    ).toBeNull();
    // Model measures label by measure NAME.
    expect(legacyInlineMeasureLabel({ measureId: 'm1' })).toBeNull();
    // Bare count (no column) labels as just the aggregation.
    expect(legacyInlineMeasureLabel({ table: 't', aggregation: 'count' })).toBeNull();
    expect(legacyInlineMeasureLabel(undefined)).toBeNull();
  });
});
