// PERSONAL MEASURES ARE MODEL-SCOPED.
//
// A measure is written against a MODEL's tables: `table` names one, `column`
// names a column on it, and an expression names both. Personal measures were
// first stored as one flat array with no model key, so opening a dashboard
// built on a DIFFERENT model offered them anyway — against tables that model
// may not even have. The field list showed them, the chart accepted them, and
// the failure arrived later from the server, phrased as a query error.
//
// So the settings document keys them by model id and every reader filters to
// the model actually in play. Nothing else about them changes: still one blob,
// still private, still available on every dashboard — of that model.
import type { DerivedField, Measure } from '../types/model';

/** Section key inside the per-user settings document. */
export const PERSONAL_MEASURES_SECTION = 'measures';

/**
 * Section key for PERSONAL derived fields. A separate section rather than a
 * second array inside `measures`: the two are different entities with
 * different validation, and a reader of one must never have to skip past the
 * other. Same model-keyed bucket shape, same read/write helpers.
 */
export const PERSONAL_DERIVED_FIELDS_SECTION = 'derivedFields';

/** modelId -> that model's personal measures. */
export type PersonalMeasuresByModel = Record<string, Measure[]>;

/**
 * Bucket key for a model. A dashboard with no model selected gets its own
 * '#none' bucket rather than being silently merged into some model's: it is a
 * real state (a dashboard is created before its model is chosen) and pooling
 * it would recreate exactly the cross-model bleed this module removes.
 */
export const personalMeasuresModelKey = (modelId: number | null): string =>
  modelId === null ? '#none' : String(modelId);

const isMeasureArray = (value: unknown): value is Measure[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Measure).id === 'string' &&
      typeof (entry as Measure).name === 'string',
  );

/**
 * MIGRATION OF THE FLAT SHAPE.
 *
 * The pre-keying document stored a bare `Measure[]`. Those measures carry no
 * model id and nothing else recorded one, so they cannot be attributed after
 * the fact — the choice is to guess or to drop.
 *
 * THIS BUILD GUESSES, ONCE: the flat array is attributed to the FIRST model it
 * is read against, which is overwhelmingly the model it was authored on (the
 * feature shipped days ago and the array belongs to whoever wrote it while
 * working on one dashboard). Guessing beats dropping because the failure mode
 * is recoverable in the UI — a measure filed under the wrong model can be seen,
 * copied and deleted — whereas a dropped one is gone with no trace.
 *
 * Returns the keyed document when a migration was performed, null when the
 * value already had the keyed shape (or is unusable and defaults apply).
 */
export const migrateFlatPersonalMeasures = (
  raw: unknown,
  modelId: number | null,
): PersonalMeasuresByModel | null => {
  if (!Array.isArray(raw)) return null;
  const measures = isMeasureArray(raw) ? raw : [];
  return { [personalMeasuresModelKey(modelId)]: measures };
};

/**
 * The personal measures for one model. Tolerates every shape the document can
 * hold — the flat legacy array, the keyed map, or junk written by another
 * build — because the settings store deliberately does not interpret sections
 * and a malformed preference must cost a preference, never the dashboard.
 */
export const readPersonalMeasures = (raw: unknown, modelId: number | null): Measure[] => {
  if (raw === undefined || raw === null) return [];
  // Legacy flat array: attributed to whichever model asks first, matching
  // migrateFlatPersonalMeasures so a read before the migration write agrees
  // with the read after it.
  if (Array.isArray(raw)) return isMeasureArray(raw) ? raw : [];
  if (typeof raw !== 'object') return [];
  const bucket = (raw as Record<string, unknown>)[personalMeasuresModelKey(modelId)];
  return isMeasureArray(bucket) ? bucket : [];
};

/**
 * Replaces ONE model's bucket, leaving every other model's alone. A whole-blob
 * write that dropped the other buckets would delete measures the user cannot
 * see from where they are standing — the worst kind of data loss, because
 * nothing on screen would hint at it.
 */
export const writePersonalMeasures = (
  raw: unknown,
  modelId: number | null,
  measures: readonly Measure[],
): PersonalMeasuresByModel => {
  const base = Array.isArray(raw)
    ? (migrateFlatPersonalMeasures(raw, modelId) ?? {})
    : typeof raw === 'object' && raw !== null
      ? { ...(raw as PersonalMeasuresByModel) }
      : {};
  return { ...base, [personalMeasuresModelKey(modelId)]: [...measures] };
};

/* ---------------------------------------------------- personal derived fields
 * Same document, same model-keyed buckets, different section. There is no
 * legacy flat shape to migrate here — the section was born keyed — so these
 * are the measure helpers minus the one-time guess.
 */

/** modelId -> that model's personal derived fields. */
export type PersonalDerivedFieldsByModel = Record<string, DerivedField[]>;

const isDerivedFieldArray = (value: unknown): value is DerivedField[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as DerivedField).id === 'string' &&
      typeof (entry as DerivedField).name === 'string' &&
      typeof (entry as DerivedField).table === 'string' &&
      typeof (entry as DerivedField).expression === 'string',
  );

/** The personal derived fields for one model; tolerates any stored shape. */
export const readPersonalDerivedFields = (
  raw: unknown,
  modelId: number | null,
): DerivedField[] => {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const bucket = (raw as Record<string, unknown>)[personalMeasuresModelKey(modelId)];
  return isDerivedFieldArray(bucket) ? bucket : [];
};

/** Replaces ONE model's bucket, leaving every other model's alone. */
export const writePersonalDerivedFields = (
  raw: unknown,
  modelId: number | null,
  fields: readonly DerivedField[],
): PersonalDerivedFieldsByModel => {
  const base =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...(raw as PersonalDerivedFieldsByModel) }
      : {};
  return { ...base, [personalMeasuresModelKey(modelId)]: [...fields] };
};
