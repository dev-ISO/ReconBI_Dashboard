// Scoped measures: the pure helpers shared by the query wire (which must SEND
// the definitions a chart cites) and by chart copy/paste (which must CARRY
// them onto the target dashboard).
//
// A measure lives in one of three scopes:
//   SYSTEM    — ModelDefinition.measures; the server already has it.
//   DASHBOARD — DashboardLayoutDoc.measures; travels with the dashboard.
//   PERSONAL  — the per-user settings document; never leaves its author.
// Only the last two need a definition on the wire, and only they can collide
// when a chart moves between dashboards. Everything here is pure and treats
// its inputs as immutable.
import type { ChartSpec } from '../types/chart';
import type { Measure } from '../types/model';
import { stableStringify } from '../util/hash';
import { newId } from '../util/ids';

/**
 * The [bracketed] names an expression references. A deliberate raw scan rather
 * than a parse: this runs on text the user may still be editing, and
 * over-collecting a name that is not a measure costs nothing (the lookup
 * misses), while under-collecting would silently drop a real dependency.
 * Mirrors the server's MeasureOverlay.ExpressionReferenceNames.
 */
export const expressionReferenceNames = (expression: string): string[] => {
  const names: string[] = [];
  let start = -1;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (c === '[') start = i + 1;
    else if (c === ']' && start >= 0) {
      const name = expression.slice(start, i).trim();
      if (name !== '') names.push(name);
      start = -1;
    }
  }
  return names;
};

/**
 * The TRANSITIVE closure of `available` a set of measure ids needs: the
 * measures themselves plus, for calculated ones, every measure their
 * expression names in [brackets] — the parser resolves those BY NAME against
 * the merged definition, so a dependency that does not travel resolves to
 * nothing. Ids `available` does not hold are skipped (they are model
 * measures). Output keeps `available` order, so it is stable and so is any
 * cache key built from it.
 */
export const collectMeasureDefinitions = (
  available: readonly Measure[],
  measureIds: readonly string[],
): Measure[] => {
  if (available.length === 0 || measureIds.length === 0) return [];
  const byId = new Map<string, Measure>();
  const byName = new Map<string, Measure>();
  for (const measure of available) {
    if (!byId.has(measure.id)) byId.set(measure.id, measure);
    const key = measure.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, measure);
  }

  const taken = new Set<string>();
  const queue: Measure[] = [];
  for (const id of measureIds) {
    const measure = byId.get(id);
    if (measure && !taken.has(measure.id)) {
      taken.add(measure.id);
      queue.push(measure);
    }
  }

  while (queue.length > 0) {
    const measure = queue.shift()!;
    if (!measure.expression) continue;
    for (const name of expressionReferenceNames(measure.expression)) {
      const referenced = byName.get(name.toLowerCase());
      if (referenced && !taken.has(referenced.id)) {
        taken.add(referenced.id);
        queue.push(referenced);
      }
    }
  }

  return available.filter((m) => taken.has(m.id));
};

/** Every measure id a chart's query references (model, dashboard or personal). */
export const chartMeasureIds = (chart: ChartSpec): string[] => {
  const ids: string[] = [];
  for (const ref of chart.query.measures) {
    if (ref.measureId) ids.push(ref.measureId);
  }
  return ids;
};

/**
 * The definitions from `available` that `chart` needs on the wire — the entry
 * point every toWireSpec call site uses.
 */
export const chartMeasureDefinitions = (
  available: readonly Measure[] | null | undefined,
  chart: ChartSpec,
): Measure[] =>
  available && available.length > 0
    ? collectMeasureDefinitions(available, chartMeasureIds(chart))
    : [];

/** Outcome of merging carried definitions into a target dashboard's measures. */
export interface MeasureMergeResult {
  /** The target's measures[] after the merge. */
  measures: Measure[];
  /** The chart with its measure refs re-pointed; null when none was given. */
  chart: ChartSpec | null;
  /** Definitions that were genuinely ADDED to the target. */
  added: Measure[];
  /** Definitions the target already held identically (reused, not duplicated). */
  reused: Measure[];
  /** Added under a deduped name because the name was taken: [from, to]. */
  renamed: [string, string][];
}

const sameDefinition = (a: Measure, b: Measure): boolean => {
  // Identity is the DEFINITION, not the id: everything except the id must
  // match. stableStringify (not JSON.stringify) because one side is typically
  // a measure that round-tripped through the server, where key order is not
  // the authoring order — an order-sensitive compare would report "different"
  // for two byte-identical measures and clone one needlessly on every copy.
  const strip = ({ id: _id, ...rest }: Measure) => rest;
  return stableStringify(strip(a)) === stableStringify(strip(b));
};

/**
 * The name a COPY of `name` gets in a set that already holds `taken` names:
 * "X (copy)", then "X (copy 2)", … — the modelStore.duplicateMeasure
 * precedent, exported so every scope's duplicate/copy action spells it the
 * same way. Comparison is case-insensitive, matching the server's
 * OrdinalIgnoreCase name-collision rule (MDL010, and the overlay's
 * duplicate-name rejection).
 */
export const nextMeasureCopyName = (taken: Iterable<string>, name: string): string => {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  let candidate = `${name} (copy)`;
  for (let n = 2; lower.has(candidate.toLowerCase()); n++) candidate = `${name} (copy ${n})`;
  return candidate;
};

const dedupedName = (taken: Set<string>, name: string): string =>
  nextMeasureCopyName(taken, name);

/**
 * Re-points a chart's measure refs through `idMap`. Only IDS are rewritten
 * here: a chart never names a measure — `[name]` references live inside
 * measure EXPRESSIONS, which rewriteExpression handles.
 */
const rewriteChart = (chart: ChartSpec | null, idMap: Map<string, string>): ChartSpec | null => {
  if (chart === null || idMap.size === 0) return chart;
  return {
    ...chart,
    query: {
      ...chart.query,
      measures: chart.query.measures.map((ref) =>
        ref.measureId && idMap.has(ref.measureId)
          ? { ...ref, measureId: idMap.get(ref.measureId)! }
          : ref,
      ),
    },
  };
};

/** Applies name renames inside a carried definition's expression [refs]. */
const rewriteExpression = (expression: string, nameMap: Map<string, string>): string => {
  if (nameMap.size === 0) return expression;
  return expression.replace(/\[([^\]]*)\]/g, (whole, inner: string) => {
    const replacement = nameMap.get(inner.trim().toLowerCase());
    return replacement === undefined ? whole : `[${replacement}]`;
  });
};

/**
 * Merges the measure definitions a copied chart carries into a TARGET
 * dashboard's measures[], resolving the three collisions that can happen:
 *
 *  - identical definition under the same id  → REUSE the target's (no clone,
 *    no rename; the two dashboards genuinely share the measure).
 *  - same id, DIFFERENT definition           → mint a new id and re-point the
 *    copied chart's ref at it; the target's own measure is never mutated.
 *  - NAME taken by a different definition    → add under a deduped name
 *    ("X (copy)") and rewrite the [references] of every carried definition
 *    that pointed at that name, so the copied formulas keep meaning what they
 *    meant on the source dashboard.
 *
 * Returns the new measures[] and the rewritten chart; nothing is mutated.
 */
export const mergeMeasureDefinitions = (
  targetMeasures: readonly Measure[],
  carried: readonly Measure[],
  chart: ChartSpec | null = null,
  mintId: () => string = newId,
): MeasureMergeResult => {
  if (carried.length === 0) {
    return { measures: [...targetMeasures], chart, added: [], reused: [], renamed: [] };
  }

  const measures = [...targetMeasures];
  const takenIds = new Set(measures.map((m) => m.id));
  const takenNames = new Set(measures.map((m) => m.name.toLowerCase()));

  const idMap = new Map<string, string>();
  const nameMap = new Map<string, string>();
  const added: Measure[] = [];
  const reused: Measure[] = [];
  const renamed: [string, string][] = [];

  // Pass 1: decide each carried definition's id and name in the target. Names
  // must all be decided before any expression is rewritten, because a carried
  // definition may reference another carried one that is renamed later.
  const pending: { source: Measure; id: string; name: string }[] = [];
  for (const source of carried) {
    // Identical definition already on the target (whatever its id) — the two
    // dashboards genuinely share this measure; reuse it and re-point the ref.
    const twin = measures.find((m) => sameDefinition(m, source));
    if (twin) {
      if (twin.id !== source.id) idMap.set(source.id, twin.id);
      reused.push(twin);
      continue;
    }

    // Same id, DIFFERENT definition: mint a fresh id rather than shadowing the
    // target's measure (which every other chart there still depends on).
    const idTaken = takenIds.has(source.id);
    const id = idTaken ? mintId() : source.id;
    if (idTaken) idMap.set(source.id, id);
    takenIds.add(id);

    let name = source.name;
    if (takenNames.has(name.toLowerCase())) {
      name = dedupedName(takenNames, source.name);
      nameMap.set(source.name.toLowerCase(), name);
      renamed.push([source.name, name]);
    }
    takenNames.add(name.toLowerCase());
    pending.push({ source, id, name });
  }

  // Pass 2: materialize, rewriting the [refs] a rename moved.
  for (const { source, id, name } of pending) {
    const measure: Measure = {
      ...source,
      id,
      name,
      ...(source.expression ? { expression: rewriteExpression(source.expression, nameMap) } : {}),
    };
    measures.push(measure);
    added.push(measure);
  }

  return { measures, chart: rewriteChart(chart, idMap), added, reused, renamed };
};
