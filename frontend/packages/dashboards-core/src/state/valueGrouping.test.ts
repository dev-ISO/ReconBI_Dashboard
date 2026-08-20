/**
 * VALUE GROUPING — the rules the whole feature rests on.
 *
 * The reported case, verbatim: a column holds "Yes" or a date, and the chart
 * draws "yes, (Blank), 02/03/2026, 04/22/2026, 12/15/2021, 08/28/2025". What
 * is wanted is TWO bars — blank as "No", everything else as "Yes".
 *
 * The interesting half of these tests is not the rule but its INVERSE: every
 * click-driven interaction downstream (drill, cross-filter, see-records,
 * drillthrough, header filters) is handed a group LABEL and has to filter the
 * RAW column with it. The invariant pinned below is that the translation never
 * over-matches — it may quietly return fewer rows than the clicked bar holds
 * (the NULL/empty-string edge), never more, and where it cannot manage even
 * that it returns null so the caller declines instead of filtering wrongly.
 */
import { describe, expect, it } from 'vitest';
import type { DimensionRef } from '../types/query';
import {
  blankVsRestGrouping,
  groupForLabel,
  groupingClauseFor,
  groupingClausesForLabels,
  groupingKeyOf,
  groupingLabels,
  groupingProblems,
  groupingPromotionProblems,
  groupingToExpression,
  groupingSurvives,
  hasGrouping,
  normalizeGrouping,
  otherLabelOf,
} from './valueGrouping';

const dim = (grouping: DimensionRef['grouping']): DimensionRef => ({
  table: 'public.report_systems',
  column: 'uploaded_to_edms',
  grouping,
});

/** THE OWNER'S CASE. */
const OWNER = blankVsRestGrouping('No', 'Yes');

describe('the owner`s case', () => {
  it('is two labels, in the order the chart plots them', () => {
    expect(groupingLabels(OWNER)).toEqual(['No', 'Yes']);
  });

  it('clicking "Yes" filters to every row that HAS a value', () => {
    // notBlank, not notNull: the engine groups '' as blank too, so notNull
    // would drag the empty-string rows into "Yes" — reporting an EDMS upload
    // that never happened.
    expect(groupingClauseFor(dim(OWNER), 'Yes')).toEqual({
      table: 'public.report_systems',
      column: 'uploaded_to_edms',
      operator: 'notBlank',
      values: [],
    });
  });

  it('clicking "No" filters to the blanks', () => {
    expect(groupingClauseFor(dim(OWNER), 'No')).toEqual({
      table: 'public.report_systems',
      column: 'uploaded_to_edms',
      operator: 'isBlank',
      values: [],
    });
  });

  it('promotes to a formula that says exactly the same thing', () => {
    expect(groupingToExpression('public.report_systems', 'uploaded_to_edms', OWNER)).toBe(
      'IF(ISBLANK(public.report_systems.uploaded_to_edms), "No", "Yes")',
    );
  });
});

describe('groupingClauseFor', () => {
  const listed = {
    groups: [
      { label: 'Open', values: ['open', 'in progress'] },
      { label: 'Closed', values: ['closed'] },
    ],
  };

  it('one listed value is an eq; several are an in', () => {
    expect(groupingClauseFor(dim(listed), 'Closed')).toMatchObject({
      operator: 'eq',
      values: ['closed'],
    });
    expect(groupingClauseFor(dim(listed), 'Open')).toMatchObject({
      operator: 'in',
      values: ['open', 'in progress'],
    });
  });

  it('the everything-else bucket is the complement of the listed values', () => {
    expect(groupingClauseFor(dim(listed), 'Other')).toMatchObject({
      operator: 'notIn',
      values: ['open', 'in progress', 'closed'],
    });
  });

  it('refuses a bucket that mixes listed values WITH blanks rather than approximating', () => {
    const mixed = { groups: [{ label: 'None', values: ['n/a'], matchBlank: true }] };
    // 'n/a' OR blank is a disjunction; a clause list is conjunctive. Returning
    // `in ['n/a']` would silently drop the blank rows the bar plots.
    expect(groupingClauseFor(dim(mixed), 'None')).toBeNull();
  });

  it('refuses an unknown label', () => {
    expect(groupingClauseFor(dim(OWNER), 'Maybe')).toBeNull();
  });

  it('returns null when the dimension is not grouped at all', () => {
    expect(groupingClauseFor({ table: 't', column: 'c' }, 'Yes')).toBeNull();
  });
});

describe('groupingClausesForLabels (a header-filter checklist)', () => {
  const three = {
    groups: [
      { label: 'Open', values: ['open'] },
      { label: 'Blank', matchBlank: true },
    ],
    otherLabel: 'Rest',
  };

  it('every bucket checked filters nothing', () => {
    expect(groupingClausesForLabels(dim(three), ['Open', 'Blank', 'Rest'])).toEqual([]);
  });

  it('one bucket checked is that bucket`s own clause', () => {
    expect(groupingClausesForLabels(dim(three), ['Blank'])).toEqual([
      expect.objectContaining({ operator: 'isBlank' }),
    ]);
  });

  it('a partial selection is expressed as exclusions, which AND together', () => {
    const listed = {
      groups: [
        { label: 'Open', values: ['open'] },
        { label: 'Held', values: ['held'] },
        { label: 'Closed', values: ['closed'] },
      ],
    };
    // Keeping Open + Held = exclude Closed AND exclude "Other": one notIn and
    // one in, which is exactly what a conjunctive clause list can carry.
    expect(groupingClausesForLabels(dim(listed), ['Open', 'Held'])).toEqual([
      expect.objectContaining({ operator: 'notIn', values: ['closed'] }),
      expect.objectContaining({ operator: 'in', values: ['open', 'held', 'closed'] }),
    ]);
  });

  it('refuses a selection whose excluded bucket cannot be negated exactly', () => {
    // Excluding "Rest" here means "open OR blank" — a disjunction, so the
    // whole selection is refused rather than half-applied.
    expect(groupingClausesForLabels(dim(three), ['Open', 'Blank'])).toBeNull();
  });
});

describe('normalizeGrouping', () => {
  it('drops buckets that collect nothing and trims the labels', () => {
    const normalized = normalizeGrouping({
      groups: [{ label: '  Yes  ', values: ['y'] }, { label: 'Empty' }],
      otherLabel: '  ',
    });
    expect(normalized).toEqual({ groups: [{ label: 'Yes', values: ['y'] }] });
  });

  it('a rule with nothing left is the ABSENCE of a grouping, not an empty one', () => {
    // Storing `{ groups: [] }` would put every single row under "Other".
    expect(normalizeGrouping({ groups: [{ label: 'Nothing' }] })).toBeNull();
    expect(normalizeGrouping(null)).toBeNull();
  });
});

describe('groupingProblems', () => {
  it('accepts the owner`s rule', () => {
    expect(groupingProblems(OWNER)).toEqual([]);
  });

  it('rejects an unnamed bucket, a duplicate name and a value in two buckets', () => {
    expect(groupingProblems({ groups: [{ label: '', values: ['a'] }] })).toContain(
      'give every group a name',
    );
    expect(
      groupingProblems({ groups: [{ label: 'A', values: ['a'] }], otherLabel: 'A' }),
    ).toContain('give each group a different name');
    expect(
      groupingProblems({
        groups: [
          { label: 'A', values: ['x'] },
          { label: 'B', values: ['x'] },
        ],
      }),
    ).toContain('the same value is listed in two groups');
  });

  it('rejects two buckets both claiming the blanks', () => {
    expect(
      groupingProblems({
        groups: [
          { label: 'A', matchBlank: true },
          { label: 'B', matchBlank: true },
        ],
      }),
    ).toContain('let only one group collect blanks');
  });
});

describe('promotion to a formula', () => {
  it('nests one IF per matched value, so no OR is ever needed', () => {
    const expression = groupingToExpression('public.orders', 'status', {
      groups: [{ label: 'Open', values: ['new', 'active'] }],
      otherLabel: 'Done',
    });
    expect(expression).toBe(
      'IF(public.orders.status = "new", "Open", IF(public.orders.status = "active", "Open", "Done"))',
    );
  });

  it('refuses text that would have to be escaped into a literal', () => {
    const risky = { groups: [{ label: 'He said "hi"', values: ['a'] }] };
    expect(groupingPromotionProblems(risky)).toContain(
      'remove quotes and backslashes from the names and values first',
    );
    expect(groupingToExpression('public.orders', 'status', risky)).toBeNull();
  });
});

describe('identity helpers', () => {
  it('hasGrouping is false for an empty rule and true for a real one', () => {
    expect(hasGrouping({ grouping: null })).toBe(false);
    expect(hasGrouping({ grouping: { groups: [] } })).toBe(false);
    expect(hasGrouping({ grouping: OWNER })).toBe(true);
  });

  it('groupingKeyOf separates two charts that group the SAME column differently', () => {
    const a = groupingKeyOf({ grouping: OWNER });
    const b = groupingKeyOf({ grouping: blankVsRestGrouping('Missing', 'Present') });
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    expect(groupingKeyOf({ grouping: null })).toBeNull();
  });

  it('a grouping survives a chip move but never onto a date grain', () => {
    expect(groupingSurvives(OWNER, null)).toBe(OWNER);
    expect(groupingSurvives(OWNER, 'month')).toBeNull();
  });

  it('otherLabelOf falls back to the engine default', () => {
    expect(otherLabelOf({ groups: [] })).toBe('Other');
    expect(otherLabelOf({ groups: [], otherLabel: '  ' })).toBe('Other');
  });

  it('groupForLabel tells a named bucket from the everything-else one', () => {
    expect(groupForLabel(OWNER, 'No')).toEqual({ kind: 'group', group: OWNER.groups[0] });
    expect(groupForLabel(OWNER, 'Yes')).toEqual({ kind: 'other' });
    expect(groupForLabel(OWNER, 'nope')).toBeNull();
  });
});
