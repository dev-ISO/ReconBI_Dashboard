import type { Aggregation } from '../types/model';
import type { MeasureCalcKind, MeasureRef } from '../types/query';

/**
 * Series-style key resolution with LEGACY fallback.
 *
 * Wave 21 (friendly column labels) changed the DEFAULT label of unaliased
 * inline measures from "Sum of open_vent" (raw column name) to
 * "Sum of Open Vent" (the model's FriendlyName). That default label is also
 * the KEY every per-series style map uses — format.colorOverrides,
 * seriesLabels, lineStyles, secondaryAxisKeys, conditionalFormats[].measureKey
 * — so dashboards saved before the model gained friendly names carry styles
 * keyed on the RAW form that the new labels no longer match.
 *
 * The compatibility contract (deliberately a FALLBACK, not a migration —
 * layout docs are never rewritten just by being viewed):
 *  - reads try the current styleKey first, then the legacy raw-form key;
 *  - writes always use the NEW styleKey, so a re-saved style self-heals.
 */

/**
 * Reads `map[styleKey]`, falling back to `map[legacyStyleKey]` when the
 * current key misses. The single seam every exact-match style lookup goes
 * through so the fallback rule lives in one place.
 */
export const seriesStyleLookup = <T>(
  map: Record<string, T> | undefined,
  styleKey: string,
  legacyStyleKey?: string,
): T | undefined => {
  if (!map) return undefined;
  const direct = map[styleKey];
  if (direct !== undefined) return direct;
  return legacyStyleKey !== undefined ? map[legacyStyleKey] : undefined;
};

/**
 * Wire aggregation -> the C# `Aggregation` enum member name. The pre-Wave-21
 * server composed inline-measure labels with the ENUM's ToString() —
 * `$"{spec.Aggregation} of {spec.Column}"` — so the legacy key must
 * reproduce that casing exactly ("CountDistinct", not "countDistinct").
 */
const LEGACY_AGGREGATION_NAMES: Record<Aggregation, string> = {
  sum: 'Sum',
  avg: 'Avg',
  min: 'Min',
  max: 'Max',
  count: 'Count',
  countDistinct: 'CountDistinct',
  stdDev: 'StdDev',
  variance: 'Variance',
  median: 'Median',
};

/**
 * Calc-kind label suffixes, byte-identical to the server's (QueryCompiler
 * result-column construction). Unchanged by Wave 21 — they compose onto both
 * the old and the new base label, so the legacy key needs them too.
 */
const CALC_SUFFIXES: Record<MeasureCalcKind, string> = {
  runningTotal: ' (running total)',
  ytd: ' (YTD)',
  priorPeriod: ' (prior)',
  periodChange: ' (change)',
  periodChangePct: ' (% change)',
};

/**
 * The DEFAULT label the pre-Wave-21 server produced for this measure ref, or
 * null when that label cannot differ from the current one:
 *  - alias set -> the alias won then and wins now;
 *  - model measure (measureId) -> labeled by the measure's NAME, untouched by
 *    friendly column labels;
 *  - inline without a column (bare count) -> "Count" then and now.
 * Only an unaliased inline measure over a column composed the raw column name
 * into its label — that is the one shape friendly labels re-labeled.
 *
 * Callers compare the result against the CURRENT result-column label and keep
 * it only when the two differ (no override on the column -> identical labels
 * -> no legacy key to carry).
 */
export const legacyInlineMeasureLabel = (measure: MeasureRef | undefined): string | null => {
  if (!measure || measure.alias || measure.measureId != null) return null;
  if (measure.column == null || measure.aggregation == null) return null;
  const aggregation = LEGACY_AGGREGATION_NAMES[measure.aggregation];
  if (aggregation === undefined) return null;
  const suffix = measure.calc ? (CALC_SUFFIXES[measure.calc.kind] ?? '') : '';
  return `${aggregation} of ${measure.column}${suffix}`;
};
