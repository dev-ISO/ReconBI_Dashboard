// The three places a measure can live, and who may write each one.
//
// SYSTEM    — ModelDefinition.measures. Shared by every dashboard on the model.
// DASHBOARD — DashboardLayoutDoc.measures. Travels when the dashboard is
//             copied or shared; invisible to other dashboards.
// PERSONAL  — the per-user settings document. Follows one user everywhere and
//             nobody else ever sees it.
//
// Everything here is pure so the rules can be tested without a DOM: the
// permission gate in particular is a correctness surface, not decoration —
// showing an editable row the server will refuse is exactly the trap this
// wave exists to remove.
import type { ChartSpec, Measure } from '@recon/dashboards-core';

export type MeasureScope = 'system' | 'dashboard' | 'personal';

/** Section order in the manager and in the field list — widest audience first. */
export const MEASURE_SCOPES: readonly MeasureScope[] = ['system', 'dashboard', 'personal'];

/** Section heading. */
export const scopeLabel = (scope: MeasureScope): string =>
  scope === 'system' ? 'System measures' : scope === 'dashboard' ? 'This dashboard' : 'My measures';

/** Compact form, for row badges and "Copy to …" menu entries. */
export const scopeShortLabel = (scope: MeasureScope): string =>
  scope === 'system' ? 'System' : scope === 'dashboard' ? 'Dashboard' : 'Personal';

/** One line explaining who else can see a measure in this scope. */
export const scopeBlurb = (scope: MeasureScope): string =>
  scope === 'system'
    ? 'Defined on the model — available on every dashboard that uses it.'
    : scope === 'dashboard'
      ? 'Stored with this dashboard, and travels when it is copied or shared.'
      : 'Private to you, on every dashboard. Copied into a dashboard when a saved chart uses it.';

/** What the caller may do in one scope, and why not when they may not. */
export interface MeasureScopeRights {
  /** False = the scope has no home in this context (e.g. no dashboard open). */
  available: boolean;
  /** May create / edit / duplicate / delete in this scope. */
  canWrite: boolean;
  /** Shown on the read-only rows; null when canWrite. */
  reason: string | null;
}

export interface MeasureScopeContext {
  /** The open model's standing; null while it loads. */
  model: { isSystem: boolean; ownerIsMe: boolean } | null;
  /** GET /meta canManageShared — the caller's admin standing. */
  canManageShared: boolean;
  /** The open dashboard's rights; null when the builder runs standalone. */
  dashboard: { canEditLayout: boolean } | null;
}

/**
 * THE GATE. Mirrors DataModelService.UpdateAsync exactly, including the
 * carve-out that lets an administrator edit the MEASURES of a system-owned
 * model (everything else on such a model stays immutable). Getting this wrong
 * in the permissive direction is the reported annoyance this wave fixes: the
 * old UI let anyone edit a system measure and then failed at save with a 403,
 * losing the edit.
 */
export const scopeRights = (
  scope: MeasureScope,
  context: MeasureScopeContext,
): MeasureScopeRights => {
  if (scope === 'personal') return { available: true, canWrite: true, reason: null };

  if (scope === 'dashboard') {
    if (context.dashboard === null) {
      return {
        available: false,
        canWrite: false,
        reason: 'Open a dashboard to give a measure a home that travels with it.',
      };
    }
    return context.dashboard.canEditLayout
      ? { available: true, canWrite: true, reason: null }
      : {
          available: true,
          canWrite: false,
          reason:
            "You do not have permission to change this dashboard's content. Copy the measure to My measures to work on it.",
        };
  }

  const model = context.model;
  if (model === null) {
    return { available: false, canWrite: false, reason: 'The model is not loaded.' };
  }
  if (model.isSystem) {
    return context.canManageShared
      ? { available: true, canWrite: true, reason: null }
      : {
          available: true,
          canWrite: false,
          reason:
            'This is a built-in model — only an administrator can change its measures. Copy one to this dashboard or to My measures to make it yours.',
        };
  }
  if (!model.ownerIsMe && !context.canManageShared) {
    return {
      available: true,
      canWrite: false,
      reason: "Only the model's owner (or an administrator) can change its measures.",
    };
  }
  return { available: true, canWrite: true, reason: null };
};

/** Rights for all three scopes at once (the manager reads this once). */
export const allScopeRights = (
  context: MeasureScopeContext,
): Record<MeasureScope, MeasureScopeRights> => ({
  system: scopeRights('system', context),
  dashboard: scopeRights('dashboard', context),
  personal: scopeRights('personal', context),
});

/** One measure, tagged with where it lives and with what is wrong with it. */
export interface ScopedMeasure {
  measure: Measure;
  scope: MeasureScope;
  /**
   * Its id is ALSO used by a wider scope, so the engine resolves the other one
   * (QueryCompiler takes the first id match, and the query overlay rejects the
   * duplicate outright). Always a data problem, never something the manager
   * created — the authoring paths mint fresh ids.
   */
  shadowedById: boolean;
  /**
   * Its name is used by another measure in another scope. `[Name]` references
   * resolve by name, so this makes every expression citing it ambiguous
   * (server MDL013) — model-wide, not just here.
   */
  duplicateName: boolean;
}

/**
 * The measure set the builder actually offers, in scope order: model measures,
 * then this dashboard's, then the user's own. Order matters — it is the
 * resolution order the server uses when it merges the query's `definitions`
 * overlay onto the model, so the flags below describe what the ENGINE will do,
 * not a display preference.
 */
export const buildScopedMeasures = (
  system: readonly Measure[],
  dashboard: readonly Measure[],
  personal: readonly Measure[],
): ScopedMeasure[] => {
  const entries: { measure: Measure; scope: MeasureScope }[] = [
    ...system.map((measure) => ({ measure, scope: 'system' as const })),
    ...dashboard.map((measure) => ({ measure, scope: 'dashboard' as const })),
    ...personal.map((measure) => ({ measure, scope: 'personal' as const })),
  ];

  const idCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const { measure } of entries) {
    idCounts.set(measure.id, (idCounts.get(measure.id) ?? 0) + 1);
    const key = measure.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const seenIds = new Set<string>();
  return entries.map(({ measure, scope }) => {
    const shadowedById = seenIds.has(measure.id);
    seenIds.add(measure.id);
    return {
      measure,
      scope,
      shadowedById,
      duplicateName: (nameCounts.get(measure.name.trim().toLowerCase()) ?? 0) > 1,
    };
  });
};

/** The flat measure list downstream code (field list, validator) consumes. */
export const measuresOfScopes = (scoped: readonly ScopedMeasure[]): Measure[] =>
  scoped.filter((entry) => !entry.shadowedById).map((entry) => entry.measure);

/** Where a given measure lives, or null when the builder cannot see it. */
export const scopeOfMeasure = (
  scoped: readonly ScopedMeasure[],
  measureId: string,
): MeasureScope | null => scoped.find((entry) => entry.measure.id === measureId)?.scope ?? null;

/** How many times the chart being edited cites this measure. */
export const measureUsageCount = (chart: ChartSpec, measureId: string): number =>
  chart.query.measures.filter((ref) => ref.measureId === measureId).length;

/** The two scopes a measure can be copied/moved into from `from`. */
export const otherScopes = (from: MeasureScope): MeasureScope[] =>
  MEASURE_SCOPES.filter((scope) => scope !== from);
