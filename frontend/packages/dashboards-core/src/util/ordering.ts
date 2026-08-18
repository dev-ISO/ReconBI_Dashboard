/**
 * Manual-order reconciliation shared by format.categoryOrder /
 * format.seriesOrder (chart shaping + the builder's drag lists). Semantics
 * follow the TableOptions.columnOrder precedent (TableChart): listed names
 * come first in the order given, items not listed append in their CURRENT
 * order, stale names (no longer present in the data) drop silently — so a
 * saved order survives fields being renamed, filtered away, or added without
 * ever hiding data or throwing.
 */

/**
 * Reorders `items` against a persisted name order. `keyOf` names each item
 * (category rows key on their formatted axis label, series on styleKey).
 * Duplicate names — e.g. coarse date formats collapsing two buckets onto one
 * label — keep their current relative order (Array.prototype.sort is stable,
 * and duplicate entries in `order` beyond the first are ignored). An absent
 * or empty order returns `items` unchanged (same identity — shapers can pass
 * results straight through).
 */
export const reconcileOrderBy = <T>(
  order: readonly string[] | undefined,
  items: T[],
  keyOf: (item: T) => string,
): T[] => {
  if (!order || order.length === 0) return items;
  const rank = new Map<string, number>();
  order.forEach((name, index) => {
    if (!rank.has(name)) rank.set(name, index);
  });
  const listed = items.filter((item) => rank.has(keyOf(item)));
  if (listed.length === 0) return items;
  const unlisted = items.filter((item) => !rank.has(keyOf(item)));
  listed.sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  return [...listed, ...unlisted];
};

/** String-list convenience over reconcileOrderBy (the drag-list display path). */
export const reconcileOrder = (
  order: readonly string[] | undefined,
  items: string[],
): string[] => reconcileOrderBy(order, items, (item) => item);
