// VALUE GROUPING — the rules, without a DOM.
//
// A grouping turns one dimension's raw values into labelled buckets. The
// engine compiles it to a CASE expression through the dateBucket seam, so the
// GROUP BY, the ORDER BY and every result label already speak in labels rather
// than raw values.
//
// That is exactly what makes the consumer sweep interesting: every interaction
// that turns a clicked CELL back into a FILTER — drill-down, cross-filter,
// see-records, drillthrough, table header filters — is handed a LABEL and has
// to filter the underlying RAW column with it. This module owns that
// translation, once, so no consumer invents its own.
//
// THE RULE THE TRANSLATION OBEYS: never over-match. A click-derived filter may
// return fewer rows than the clicked bar contains (a NULL edge case), never
// more — showing rows the user did not click is the failure that silently
// misleads. Where a bucket cannot be expressed within that rule, the
// translation returns null and the caller declines the interaction rather than
// filtering wrongly.
import type {
  DimensionRef,
  FilterClause,
  FilterValue,
  ValueGroup,
  ValueGrouping,
} from '../types/query';

/** The engine's label for rows that match no group (grouping.otherLabel ?? this). */
export const DEFAULT_OTHER_LABEL = 'Other';

/**
 * Client mirrors of the engine's own caps (QueryCompiler.MaxGroupingBuckets and
 * RcdLimits.MaxInValues), so the editor refuses exactly what the compiler would
 * and never blocks a rule the engine would have run. A host may raise
 * MaxInValues server-side; the seeded default is the contract mirrored here,
 * exactly as chartValidation mirrors MAX_FILTERS.
 */
export const MAX_VALUE_GROUPS = 64;
export const MAX_GROUP_VALUES = 1000;
/** Engine cap on one label's length (QueryCompiler.MaxGroupingLabelLength). */
export const MAX_GROUP_LABEL_LENGTH = 200;

/**
 * A stable identity for a dimension's grouping, or null when it has none.
 * Two dimensions with the same key plot the same buckets, so a label means the
 * same thing on both — which is exactly the question cross-tile hover matching
 * and any other label-keyed comparison has to answer.
 */
export const groupingKeyOf = (dimension: Pick<DimensionRef, 'grouping'>): string | null => {
  const grouping = dimension.grouping;
  if (!grouping || grouping.groups.length === 0) return null;
  const groups = grouping.groups
    .map(
      (group) =>
        `${group.label}\u0001${(group.values ?? []).map(String).join('\u0002')}\u0001${
          group.matchBlank === true ? 'b' : ''
        }`,
    )
    .join('\u0003');
  return `${groups}\u0004${otherLabelOf(grouping)}`;
};

/** True when the dimension carries a usable grouping. */
export const hasGrouping = (dimension: Pick<DimensionRef, 'grouping'>): boolean =>
  (dimension.grouping?.groups.length ?? 0) > 0;

/** The "everything else" label actually shown for a grouping. */
export const otherLabelOf = (grouping: ValueGrouping): string => {
  const label = grouping.otherLabel?.trim();
  return label === undefined || label === '' ? DEFAULT_OTHER_LABEL : label;
};

/** Every label the grouping can produce, in bucket order, "other" last. */
export const groupingLabels = (grouping: ValueGrouping): string[] => [
  ...grouping.groups.map((group) => group.label),
  otherLabelOf(grouping),
];

const valuesOf = (group: ValueGroup): FilterValue[] => group.values ?? [];

/** A bucket that collects nothing is a no-op the engine would still emit. */
export const groupIsEmpty = (group: ValueGroup): boolean =>
  valuesOf(group).length === 0 && group.matchBlank !== true;

/**
 * Drops empty buckets and trims labels, or returns null when nothing is left —
 * the shape the editor writes back, so a half-built rule never reaches the
 * wire. A grouping with no populated bucket is not "a grouping with no rules",
 * it is the ABSENCE of a grouping, and storing it would make every row read
 * "Other".
 */
export const normalizeGrouping = (grouping: ValueGrouping | null): ValueGrouping | null => {
  if (grouping === null) return null;
  const groups = grouping.groups
    .map((group): ValueGroup => {
      const values = valuesOf(group);
      return {
        label: group.label.trim(),
        ...(values.length > 0 ? { values } : {}),
        ...(group.matchBlank === true ? { matchBlank: true } : {}),
      };
    })
    .filter((group) => !groupIsEmpty(group));
  if (groups.length === 0) return null;
  const other = grouping.otherLabel?.trim();
  return {
    groups,
    ...(other !== undefined && other !== '' ? { otherLabel: other } : {}),
  };
};

/** What is wrong with a grouping, in the client validator's wording. */
export const groupingProblems = (grouping: ValueGrouping): string[] => {
  const problems: string[] = [];
  if (grouping.groups.length === 0) problems.push('add at least one group');
  if (grouping.groups.length > MAX_VALUE_GROUPS) {
    problems.push(`keep it to ${MAX_VALUE_GROUPS} groups or fewer`);
  }
  if (grouping.groups.some((group) => group.label.trim() === '')) {
    problems.push('give every group a name');
  }
  if (grouping.groups.some((group) => valuesOf(group).length > MAX_GROUP_VALUES)) {
    problems.push(`keep each group under ${MAX_GROUP_VALUES} values`);
  }
  if (groupingLabels(grouping).some((label) => label.length > MAX_GROUP_LABEL_LENGTH)) {
    problems.push(`keep every name under ${MAX_GROUP_LABEL_LENGTH} characters`);
  }
  const labels = groupingLabels(grouping).map((label) => label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) problems.push('give each group a different name');
  if (grouping.groups.filter((group) => group.matchBlank === true).length > 1) {
    problems.push('let only one group collect blanks');
  }
  const seen = new Set<string>();
  for (const group of grouping.groups) {
    for (const value of valuesOf(group)) {
      const key = `${typeof value}:${String(value)}`;
      if (seen.has(key)) {
        problems.push('the same value is listed in two groups');
        return problems;
      }
      seen.add(key);
    }
  }
  return problems;
};

/** Which bucket a label denotes, or null when the label belongs to neither. */
export const groupForLabel = (
  grouping: ValueGrouping,
  label: string,
): { kind: 'group'; group: ValueGroup } | { kind: 'other' } | null => {
  const group = grouping.groups.find((candidate) => candidate.label === label);
  if (group) return { kind: 'group', group };
  return label === otherLabelOf(grouping) ? { kind: 'other' } : null;
};

/**
 * THE TRANSLATION: the filter that keeps exactly the rows behind one grouped
 * label, expressed against the UNDERLYING column — or null when no single
 * clause can say it without over-matching.
 *
 * The expressible cases cover every rule the editor can build in one step,
 * including the one this wave exists for (blank -> "No", everything else ->
 * "Yes"):
 *   values only            -> eq / in
 *   blanks only            -> isBlank
 *   other, blanks claimed  -> notBlank
 *   other, values claimed  -> notIn
 * The refused case is a bucket that mixes listed values WITH blanks (or an
 * "other" facing both): that is a disjunction, and a FilterClause list is
 * conjunctive, so there is no honest single clause.
 *
 * BLANK IS ITS OWN OPERATOR. The engine folds an EMPTY STRING into the blank
 * bucket (`col IS NULL OR col = ''`), which `isNull` cannot say — a row holding
 * '' would display under the blank label and then filter as non-blank, so the
 * bar said 3 and the drill showed 2. `isBlank`/`notBlank` mirror the engine's
 * rule exactly, which is why these translations are exact rather than merely
 * safe. Redefining blank as NULL-alone would have "fixed" this by moving the
 * error into the CHART: an empty-string row would render under "Yes", reporting
 * an EDMS upload that never happened.
 */
export const groupingClauseFor = (
  dimension: DimensionRef,
  label: string,
): FilterClause | null => {
  const grouping = dimension.grouping;
  if (!grouping || grouping.groups.length === 0) return null;
  const { table, column } = dimension;
  const target = groupForLabel(grouping, label);
  if (target === null) return null;

  if (target.kind === 'group') {
    const values = valuesOf(target.group);
    const blank = target.group.matchBlank === true;
    if (values.length > 0 && blank) return null; // a disjunction; see above
    if (blank) return { table, column, operator: 'isBlank', values: [] };
    if (values.length === 0) return null;
    return values.length === 1
      ? { table, column, operator: 'eq', values: [values[0]!] }
      : { table, column, operator: 'in', values: [...values] };
  }

  // "Everything else": the complement of every bucket at once.
  const claimed = grouping.groups.flatMap(valuesOf);
  const blankClaimed = grouping.groups.some((group) => group.matchBlank === true);
  if (claimed.length > 0 && blankClaimed) return null; // needs notIn AND notNull
  if (blankClaimed) return { table, column, operator: 'notBlank', values: [] };
  if (claimed.length === 0) return null;
  // NULL rows fall in "other" but `NOT IN` drops them — an under-match, which
  // the module's rule allows and an over-match would not.
  return { table, column, operator: 'notIn', values: claimed };
};

/**
 * The conjunction that keeps exactly the rows behind a SET of grouped labels —
 * what a table header filter (a checklist) needs.
 *
 * Expressed as "exclude every bucket the user did NOT check", because a
 * negation is conjunctive and a union of buckets is not. Returns null when any
 * unchecked bucket cannot be negated without over-matching.
 */
export const groupingClausesForLabels = (
  dimension: DimensionRef,
  labels: readonly string[],
): FilterClause[] | null => {
  const grouping = dimension.grouping;
  if (!grouping || grouping.groups.length === 0) return null;
  const wanted = new Set(labels);
  const all = groupingLabels(grouping);
  const excluded = all.filter((label) => !wanted.has(label));
  if (excluded.length === 0) return [];
  // One kept bucket is cheaper to say positively, and says it exactly.
  if (excluded.length === all.length - 1) {
    const kept = all.find((label) => wanted.has(label));
    const clause = kept === undefined ? null : groupingClauseFor(dimension, kept);
    return clause === null ? null : [clause];
  }
  const { table, column } = dimension;
  const clauses: FilterClause[] = [];
  for (const label of excluded) {
    const target = groupForLabel(grouping, label);
    if (target === null) return null;
    if (target.kind === 'other') {
      // Excluding "other" = the row must land in one of the NAMED buckets.
      const claimed = grouping.groups.flatMap(valuesOf);
      const blankClaimed = grouping.groups.some((group) => group.matchBlank === true);
      if (claimed.length > 0 && blankClaimed) return null;
      if (blankClaimed) clauses.push({ table, column, operator: 'isBlank', values: [] });
      else if (claimed.length > 0) clauses.push({ table, column, operator: 'in', values: claimed });
      else return null;
      continue;
    }
    const values = valuesOf(target.group);
    const blank = target.group.matchBlank === true;
    if (values.length > 0 && blank) return null;
    if (blank) clauses.push({ table, column, operator: 'notBlank', values: [] });
    else if (values.length > 0) clauses.push({ table, column, operator: 'notIn', values });
    else return null;
  }
  return clauses;
};

/**
 * The grouping a chip KEEPS when it moves between wells. A grouping belongs to
 * the field, not to the well it happens to sit in — dropping it on a move
 * would silently un-group a chart the user grouped on purpose — but it cannot
 * survive onto a date grain, which rewrites the same expression.
 */
export const groupingSurvives = (
  grouping: ValueGrouping | null | undefined,
  dateBucket: unknown,
): ValueGrouping | null => (dateBucket == null && grouping ? grouping : null);

/**
 * The one-step rule the owner's case needs, ready-made: blanks under
 * `blankLabel`, everything else under `otherLabel`. The grouping editor seeds
 * from this so the whole job is two words and a Save.
 */
export const blankVsRestGrouping = (blankLabel: string, otherLabel: string): ValueGrouping => ({
  groups: [{ label: blankLabel, matchBlank: true }],
  otherLabel,
});

/* -------------------------------------------------- promotion to a formula */

/**
 * Text a row-level expression may carry as a literal. Refused rather than
 * escaped: a quote or a backslash inside a bound string is exactly where an
 * escaping convention I have to GUESS becomes either a parse error or, worse,
 * something that parses into a different rule. A rule holding one is still
 * perfectly usable as a chart-local grouping (labels and values ride the wire
 * as bound parameters there, never as text) — it just cannot be spelled as a
 * formula, and the editor says so instead of writing one that lies.
 */
const literalIsSafe = (text: string): boolean => !/["\\\r\n]/.test(text);

/** Why this grouping cannot be written as an expression, or [] when it can. */
export const groupingPromotionProblems = (grouping: ValueGrouping): string[] => {
  const problems = groupingProblems(grouping);
  const texts = [
    ...groupingLabels(grouping),
    ...grouping.groups.flatMap((group) => valuesOf(group).map(String)),
  ];
  if (texts.some((text) => !literalIsSafe(text))) {
    problems.push('remove quotes and backslashes from the names and values first');
  }
  return problems;
};

const literal = (value: string): string => `"${value}"`;

/**
 * The row-level expression a grouping becomes when it is PROMOTED to a named
 * derived field — the same rule, spelled in the formula language.
 *
 * Deliberately built from the smallest vocabulary that can say it: a bare
 * column leaf, a string literal, ISBLANK and IF. No OR, no IN, no SWITCH —
 * several matched values become several nested IFs answering the same label,
 * which is longer to read and impossible to get wrong. Returns null when the
 * rule cannot be written honestly (see groupingPromotionProblems).
 */
export const groupingToExpression = (
  table: string,
  column: string,
  grouping: ValueGrouping,
): string | null => {
  if (groupingPromotionProblems(grouping).length > 0) return null;
  const leaf = `${table}.${column}`;
  // Innermost first: everything that matched nothing above is "other".
  let expression = literal(otherLabelOf(grouping));
  for (let i = grouping.groups.length - 1; i >= 0; i--) {
    const group = grouping.groups[i]!;
    const label = literal(group.label);
    for (let v = valuesOf(group).length - 1; v >= 0; v--) {
      const value = String(valuesOf(group)[v]!);
      expression = `IF(${leaf} = ${literal(value)}, ${label}, ${expression})`;
    }
    if (group.matchBlank === true) {
      expression = `IF(ISBLANK(${leaf}), ${label}, ${expression})`;
    }
  }
  return expression;
};
