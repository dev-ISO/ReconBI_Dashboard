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
  MAX_PROMOTABLE_BRANCHES,
  ruleIsUsable,
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
    // A blank "everything else" label normalizes to the effective one rather
    // than being dropped — see "the everything-else label is always written".
    expect(normalized).toEqual({ groups: [{ label: 'Yes', values: ['y'] }], otherLabel: 'Other' });
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

/**
 * THE "OTHER" LABEL MUST REACH THE ENGINE.
 *
 * The engine and this module disagree about a MISSING otherLabel: the compiler
 * emits `ELSE CAST(col AS text)` (each unmatched value keeps its own text)
 * while otherLabelOf reports 'Other'. Normalization closes that by always
 * writing the label, so the bucket the UI names is the bucket the SQL builds.
 */
describe('the everything-else label is always written', () => {
  const valuesOnly = { groups: [{ label: 'Open', values: ['open'] }] };

  it('normalization fills in the effective label rather than omitting it', () => {
    expect(normalizeGrouping(valuesOnly)?.otherLabel).toBe('Other');
    expect(normalizeGrouping({ ...valuesOnly, otherLabel: '   ' })?.otherLabel).toBe('Other');
  });

  it('keeps an explicit label verbatim', () => {
    expect(normalizeGrouping({ ...valuesOnly, otherLabel: 'Everything else' })?.otherLabel).toBe(
      'Everything else',
    );
  });

  it('the label the UI shows is the one a click can filter on', () => {
    // Before the fix this label existed only client-side: the engine emitted
    // raw values, so groupForLabel found nothing and the click did nothing.
    const normalized = normalizeGrouping(valuesOnly)!;
    expect(groupingLabels(normalized)).toContain(otherLabelOf(normalized));
    expect(groupForLabel(normalized, 'Other')).toEqual({ kind: 'other' });
    expect(groupingClauseFor(dim(normalized), 'Other')).toMatchObject({ operator: 'notIn' });
  });

  it('promotion cannot relabel rows the grouping left alone', () => {
    // IF(..., "Other") is only honest because normalization made "Other" the
    // grouping's real answer too.
    const normalized = normalizeGrouping(valuesOnly)!;
    expect(groupingToExpression('public.report_systems', 'uploaded_to_edms', normalized)).toBe(
      'IF(public.report_systems.uploaded_to_edms = "open", "Open", "Other")',
    );
  });
});

/**
 * A GROUPING MAY BE BIGGER THAN A FORMULA.
 *
 * Chart-local values compile to one bound array, so a thousand cost nothing.
 * Promotion turns each into a nested IF that the engine counts against its
 * row-level node cap — so the editor must refuse up front rather than hand the
 * author a node-count error from a formula they never wrote.
 */
describe('promotion has a smaller budget than grouping', () => {
  const withValues = (count: number) => ({
    groups: [{ label: 'Listed', values: Array.from({ length: count }, (_, i) => `v${i}`) }],
    otherLabel: 'Other',
  });

  it('accepts a rule at the budget', () => {
    expect(groupingPromotionProblems(withValues(MAX_PROMOTABLE_BRANCHES))).toEqual([]);
    expect(
      groupingToExpression('public.report_systems', 'uploaded_to_edms', withValues(MAX_PROMOTABLE_BRANCHES)),
    ).not.toBeNull();
  });

  it('refuses one past it, and says what to do instead', () => {
    const problems = groupingPromotionProblems(withValues(MAX_PROMOTABLE_BRANCHES + 1));
    expect(problems.join(' ')).toContain('chart grouping instead');
    // And refuses to emit — the caller cannot promote past the check.
    expect(
      groupingToExpression('public.report_systems', 'uploaded_to_edms', withValues(MAX_PROMOTABLE_BRANCHES + 1)),
    ).toBeNull();
  });

  it('the same rule is still perfectly valid as a chart grouping', () => {
    expect(groupingProblems(withValues(MAX_PROMOTABLE_BRANCHES + 1))).toEqual([]);
  });

  it('a blank bucket spends budget too — it is another nested IF', () => {
    const grouping = {
      groups: [
        { label: 'Listed', values: Array.from({ length: MAX_PROMOTABLE_BRANCHES }, (_, i) => `v${i}`) },
        { label: 'No', matchBlank: true },
      ],
      otherLabel: 'Other',
    };
    expect(groupingPromotionProblems(grouping).join(' ')).toContain('chart grouping instead');
  });
});

/**
 * EXCEL-STYLE RULES — the dynamic half of a bucket.
 *
 * A listed bucket freezes the values that existed when it was written; a rule is
 * evaluated in SQL, so tomorrow's value joins on its own. These tests hold the
 * CLIENT half of that: what normalizes onto the wire, what a click can honestly
 * translate to, and what the editor must refuse.
 */
describe('grouping rules', () => {
  const ruleGroup = (rules: { operator: string; value?: unknown }[], extra = {}) => ({
    groups: [{ label: 'Westlake', rules, ...extra } as never],
    otherLabel: 'Other',
  });

  it('a bucket with only a rule is not empty', () => {
    expect(normalizeGrouping(ruleGroup([{ operator: 'contains', value: 'west' }]))).not.toBeNull();
  });

  it('drops half-typed rules rather than sending them', () => {
    // An operator with no operand is a compile error the author would meet as
    // a broken chart, so it never reaches the wire.
    const normalized = normalizeGrouping({
      groups: [
        {
          label: 'Westlake',
          rules: [
            { operator: 'contains', value: 'west' },
            { operator: 'contains', value: '   ' },
          ],
        } as never,
      ],
      otherLabel: 'Other',
    });
    expect(normalized!.groups[0]!.rules).toEqual([{ operator: 'contains', value: 'west' }]);
  });

  it('keeps valueless operators, which are complete without one', () => {
    expect(ruleIsUsable({ operator: 'isBlank' })).toBe(true);
    expect(ruleIsUsable({ operator: 'notBlank' })).toBe(true);
    expect(ruleIsUsable({ operator: 'contains' })).toBe(false);
  });

  it('only writes ruleMode when it changes the meaning', () => {
    const one = normalizeGrouping(ruleGroup([{ operator: 'contains', value: 'w' }], { ruleMode: 'all' }));
    expect(one!.groups[0]!.ruleMode).toBeUndefined(); // one rule: any === all

    const two = normalizeGrouping(
      ruleGroup(
        [
          { operator: 'startsWith', value: 'W' },
          { operator: 'endsWith', value: 't' },
        ],
        { ruleMode: 'all' },
      ),
    );
    expect(two!.groups[0]!.ruleMode).toBe('all');
  });

  it('flags a rule with no value', () => {
    expect(groupingProblems(ruleGroup([{ operator: 'contains' }])).join(' ')).toContain(
      'give every rule a value',
    );
  });

  it('RULES ARE PART OF THE IDENTITY — two rule sets are two groupings', () => {
    // groupingKeyOf drives cross-tile hover matching. Without rules in the key,
    // two charts grouping one column differently would highlight each other.
    const a = groupingKeyOf({ grouping: ruleGroup([{ operator: 'contains', value: 'west' }]) });
    const b = groupingKeyOf({ grouping: ruleGroup([{ operator: 'contains', value: 'east' }]) });
    const c = groupingKeyOf({ grouping: ruleGroup([{ operator: 'startsWith', value: 'west' }]) });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('cannot be promoted to a reusable field, and says why', () => {
    const problems = groupingPromotionProblems(ruleGroup([{ operator: 'contains', value: 'w' }]));
    expect(problems.join(' ')).toContain('keep it as a chart grouping');
    expect(
      groupingToExpression('public.report_systems', 'uploaded_to_edms', ruleGroup([
        { operator: 'contains', value: 'w' },
      ])),
    ).toBeNull();
  });
});

describe('clicking a rule-based bar', () => {
  const dimOf = (rules: { operator: string; value?: unknown }[], mode?: 'any' | 'all') =>
    dim({ groups: [{ label: 'Westlake', rules, ...(mode ? { ruleMode: mode } : {}) } as never], otherLabel: 'Other' });

  it('translates the operators the filter language can say', () => {
    expect(groupingClauseFor(dimOf([{ operator: 'contains', value: 'west' }]), 'Westlake')).toEqual({
      table: 'public.report_systems',
      column: 'uploaded_to_edms',
      operator: 'contains',
      values: ['west'],
    });
    expect(groupingClauseFor(dimOf([{ operator: 'isBlank' }]), 'Westlake')).toMatchObject({
      operator: 'isBlank',
      values: [],
    });
    expect(groupingClauseFor(dimOf([{ operator: 'greaterThan', value: 5 }]), 'Westlake')).toMatchObject({
      operator: 'gt',
      values: [5],
    });
  });

  it('DECLINES the operators it cannot say, rather than approximating', () => {
    // There is no "not contains" / "ends with" filter operator. Filtering with
    // something close would show rows the user did not click.
    expect(groupingClauseFor(dimOf([{ operator: 'notContains', value: 'x' }]), 'Westlake')).toBeNull();
    expect(groupingClauseFor(dimOf([{ operator: 'endsWith', value: 'x' }]), 'Westlake')).toBeNull();
  });

  it('declines several rules — an OR, or an AND, is not one clause', () => {
    const two = [
      { operator: 'contains', value: 'a' },
      { operator: 'contains', value: 'b' },
    ];
    expect(groupingClauseFor(dimOf(two), 'Westlake')).toBeNull();
    expect(groupingClauseFor(dimOf(two, 'all'), 'Westlake')).toBeNull();
  });

  it('declines "everything else" whenever any bucket matches by rule', () => {
    expect(groupingClauseFor(dimOf([{ operator: 'contains', value: 'w' }]), 'Other')).toBeNull();
  });

  it('declines a header-filter checklist over rule buckets', () => {
    expect(groupingClausesForLabels(dimOf([{ operator: 'contains', value: 'w' }]), ['Westlake'])).toBeNull();
  });
});
