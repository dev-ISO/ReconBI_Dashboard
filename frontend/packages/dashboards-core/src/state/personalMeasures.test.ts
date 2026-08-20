/**
 * PERSONAL MEASURES ARE MODEL-SCOPED.
 *
 * They shipped as one flat array with no model key, which meant opening a
 * dashboard on a DIFFERENT model offered them anyway — against tables that
 * model may not have. The field list showed them, the chart accepted them, and
 * the failure arrived later as a query error.
 *
 * These pin the keyed shape, the one-time migration of the flat one (and which
 * model it guesses), and the rule that keeps the guess survivable: a write to
 * one model's bucket never touches another's.
 */
import { describe, expect, it } from 'vitest';
import type { Measure } from '../types/model';
import {
  migrateFlatPersonalMeasures,
  personalMeasuresModelKey,
  readPersonalMeasures,
  writePersonalMeasures,
} from './personalMeasures';

const measure = (id: string, name: string): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  column: 'total',
});

const A = measure('a', 'Mine on model 5');
const B = measure('b', 'Mine on model 9');

describe('personalMeasuresModelKey', () => {
  it('keys by model id, with a distinct bucket for "no model chosen yet"', () => {
    expect(personalMeasuresModelKey(5)).toBe('5');
    // A real state — a dashboard exists before its model is picked — and
    // pooling it into some model's bucket would recreate the very bleed this
    // module removes.
    expect(personalMeasuresModelKey(null)).toBe('#none');
  });
});

describe('readPersonalMeasures', () => {
  it('returns only the asked-for model’s measures', () => {
    const doc = { '5': [A], '9': [B] };
    expect(readPersonalMeasures(doc, 5)).toEqual([A]);
    expect(readPersonalMeasures(doc, 9)).toEqual([B]);
    // THE BUG THIS FIXES: a model with none of its own gets none, not
    // somebody else's.
    expect(readPersonalMeasures(doc, 7)).toEqual([]);
  });

  it('reads the legacy flat array as belonging to whichever model asks first', () => {
    expect(readPersonalMeasures([A, B], 5)).toEqual([A, B]);
    expect(readPersonalMeasures([A, B], 9)).toEqual([A, B]);
  });

  it('degrades to empty for anything unusable — a preference, never a crash', () => {
    for (const junk of [undefined, null, 42, 'nope', { '5': 'not-an-array' }, { '5': [{}] }]) {
      expect(readPersonalMeasures(junk, 5)).toEqual([]);
    }
  });
});

describe('migrateFlatPersonalMeasures', () => {
  it('converts the flat array once, attributing it to the first model seen', () => {
    expect(migrateFlatPersonalMeasures([A], 5)).toEqual({ '5': [A] });
    // Guessing beats dropping: a measure filed under the wrong model can be
    // seen, copied and deleted; a dropped one is gone with no trace.
    expect(migrateFlatPersonalMeasures([A], null)).toEqual({ '#none': [A] });
  });

  it('reports "nothing to do" for a document already keyed', () => {
    expect(migrateFlatPersonalMeasures({ '5': [A] }, 9)).toBeNull();
    expect(migrateFlatPersonalMeasures(undefined, 5)).toBeNull();
  });

  it('drops junk entries rather than migrating them into the keyed shape', () => {
    expect(migrateFlatPersonalMeasures([{ nope: true }], 5)).toEqual({ '5': [] });
  });
});

describe('writePersonalMeasures', () => {
  it('replaces ONE model’s bucket and leaves the others intact', () => {
    const doc = { '5': [A], '9': [B] };
    const next = writePersonalMeasures(doc, 5, []);
    expect(next['5']).toEqual([]);
    // Deleting measures the user cannot see from where they are standing is
    // the worst kind of data loss: nothing on screen would hint at it.
    expect(next['9']).toEqual([B]);
  });

  it('migrates the flat shape on the way through, then writes', () => {
    expect(writePersonalMeasures([A], 5, [A, B])).toEqual({ '5': [A, B] });
  });

  it('starts from empty for an unusable document rather than throwing', () => {
    expect(writePersonalMeasures('junk', 5, [A])).toEqual({ '5': [A] });
    expect(writePersonalMeasures(null, null, [A])).toEqual({ '#none': [A] });
  });

  it('copies the input, so the caller’s array cannot mutate the document', () => {
    const input = [A];
    const doc = writePersonalMeasures({}, 5, input);
    input.push(B);
    expect(doc['5']).toEqual([A]);
  });

  it('round-trips with readPersonalMeasures for every model', () => {
    let doc: unknown = [A]; // start on the legacy shape
    doc = writePersonalMeasures(doc, 5, [A]);
    doc = writePersonalMeasures(doc, 9, [B]);
    expect(readPersonalMeasures(doc, 5)).toEqual([A]);
    expect(readPersonalMeasures(doc, 9)).toEqual([B]);
  });
});
