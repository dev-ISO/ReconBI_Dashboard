/**
 * THE FLAW (spec D2), pinned as a unit.
 *
 * The measure dialog's live check kept every issue whose CODE looked
 * expression-shaped and never read `issue.path`. The consequence, in a model
 * with 84 measures: ONE broken formula anywhere disabled Save for every other
 * measure in the model. The author's only way forward was to go and fix (or
 * delete) somebody else's measure first — from a dialog that did not even say
 * which one was broken.
 *
 * The server has stamped the owning measure on the issue all along
 * (`measures[i]`, plus `.expression` / `.column` / `.aggregation` /
 * `.filters[f]` suffixes). These tests hold the reader to it, including the
 * one-character trap that makes a naive prefix match wrong: `measures[1]` must
 * not swallow `measures[10]`.
 */
import { describe, expect, it } from 'vitest';
import type { Measure } from '@recon/dashboards-core';
import {
  blockingIssues,
  duplicateNameOf,
  issuesForMeasureIndex,
  type ValidationIssue,
} from '../src/model-editor/MeasureDialog';

const issue = (
  code: string,
  path: string | null,
  severity: 'error' | 'warning' = 'error',
): ValidationIssue => ({ code, severity, message: `${code} at ${path}`, path });

const measure = (id: string, name: string): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  column: 'total',
});

describe('issuesForMeasureIndex', () => {
  it('THE REGRESSION: another measure being broken does not block this one', () => {
    const issues = [
      issue('MDL012', 'measures[0].expression'), // somebody else's broken formula
      issue('MDL013', 'measures[4].expression'), // and another
    ];
    // The candidate is measures[2] and is perfectly fine.
    expect(issuesForMeasureIndex(issues, 2)).toEqual([]);
  });

  it('keeps the candidate’s own issue, at the row path and at every suffix', () => {
    const own = [
      issue('MDL002', 'measures[2]'),
      issue('MDL012', 'measures[2].expression'),
      issue('MDL014', 'measures[2].column'),
      issue('MDL008', 'measures[2].aggregation'),
      issue('MDL002', 'measures[2].filters[0]'),
    ];
    expect(issuesForMeasureIndex([...own, issue('MDL012', 'measures[3].expression')], 2)).toEqual(
      own,
    );
  });

  it('measures[1] never swallows measures[10] — the dot is part of the prefix', () => {
    const issues = [issue('MDL012', 'measures[10].expression'), issue('MDL012', 'measures[1]')];
    expect(issuesForMeasureIndex(issues, 1).map((i) => i.path)).toEqual(['measures[1]']);
  });

  it('drops path-less issues: they cannot be attributed to a row', () => {
    // MDL010 (duplicate names) is the only measure-relevant path-less issue,
    // and duplicateNameOf owns that case — across all three scopes, which the
    // server round-trip cannot see at all.
    expect(issuesForMeasureIndex([issue('MDL010', null, 'warning')], 0)).toEqual([]);
  });

  it('a candidate that is not in the posted list owns nothing', () => {
    expect(issuesForMeasureIndex([issue('MDL012', 'measures[0]')], -1)).toEqual([]);
  });
});

describe('blockingIssues', () => {
  it('errors block; warnings are shown and do not', () => {
    const errors = [issue('MDL012', 'measures[0].expression')];
    const warnings = [issue('MDL011', 'measures[0]', 'warning')];
    expect(blockingIssues([...errors, ...warnings])).toEqual(errors);
  });
});

describe('duplicateNameOf', () => {
  const siblings = [measure('s1', 'Revenue'), measure('d1', 'Units')];

  it('finds a collision case-insensitively (the engine groups that way)', () => {
    expect(duplicateNameOf(siblings, '  revenue ', 'new')?.id).toBe('s1');
  });

  it('never reports the measure against itself', () => {
    expect(duplicateNameOf(siblings, 'Revenue', 's1')).toBeNull();
  });

  it('an empty name is not a collision (the required-name rule owns that)', () => {
    expect(duplicateNameOf(siblings, '   ', 'new')).toBeNull();
  });

  it('a free name is free', () => {
    expect(duplicateNameOf(siblings, 'Margin', 'new')).toBeNull();
  });
});
