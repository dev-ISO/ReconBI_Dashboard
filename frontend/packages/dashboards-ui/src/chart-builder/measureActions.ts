// Every write the measure manager performs, in one place, so the field-list
// row menu and the manager dialog cannot drift apart.
//
// The rule that shapes all of it: A MEASURE IS ADDRESSED TWO WAYS. Charts cite
// it by ID; expressions cite it by NAME. So every transfer has to decide what
// happens to both, and the honest answer depends on direction:
//
//   WIDENING  (personal → dashboard → system) is a MOVE: the id is preserved
//   and the source copy is removed, so every chart that already cites it keeps
//   resolving — it just resolves somewhere more people can see.
//
//   NARROWING (system → dashboard → personal) is a COPY: the original stays
//   where the rest of the product depends on it, and the copy takes a FRESH id
//   and a DEDUPED name. Reusing either would be a bug — a duplicate id is
//   rejected by the query overlay (and silently shadowed by the compiler), and
//   a duplicate name makes every model expression saying [ThatName] ambiguous.
import { useCallback, useMemo, useState } from 'react';
import {
  newId,
  nextMeasureCopyName,
  type ChartSpec,
  type Measure,
} from '@recon/dashboards-core';
import { useDashboardState, useModelState, useRuntime } from '../provider/DashboardsProvider';
import { useCanManageShared } from '../provider/useRcdMeta';
import type { MeasureDraft } from '../model-editor/MeasureDialog';
import {
  allScopeRights,
  buildScopedMeasures,
  measuresOfScopes,
  type MeasureScope,
  type MeasureScopeRights,
  type ScopedMeasure,
} from './measureScopes';

/** system > dashboard > personal — how many people a scope reaches. */
const SCOPE_WIDTH: Record<MeasureScope, number> = { system: 2, dashboard: 1, personal: 0 };

/** Widening promotes (move); narrowing forks (copy). See the module note. */
export const transferVerb = (from: MeasureScope, to: MeasureScope): 'move' | 'copy' =>
  SCOPE_WIDTH[to] > SCOPE_WIDTH[from] ? 'move' : 'copy';

export interface MeasureActionsInput {
  /** The dashboard's model; System-scope writes go to it. */
  modelId: number | null;
  /**
   * The model definition's own measures, for the case where the model STORE
   * holds something else (a host with the model editor open elsewhere) or
   * nothing at all (the standalone builder). The store wins when it holds this
   * same model, because that is where a System write lands.
   */
  fallbackSystemMeasures: readonly Measure[];
  /** The chart being edited — measure refs are re-pointed when an id moves. */
  chart: ChartSpec;
  onChartChange: (chart: ChartSpec) => void;
}

export interface MeasureActions {
  /** Every measure the builder can offer, tagged with scope and collisions. */
  scoped: ScopedMeasure[];
  /** The flat list the field list and the client validator consume. */
  effective: Measure[];
  rights: Record<MeasureScope, MeasureScopeRights>;
  /** A write is in flight (a System write is a server round-trip). */
  busy: boolean;
  /** Last failure; cleared by the next action. */
  error: string | null;
  /** Last thing worth saying out loud (a rename, a copy left behind). */
  notice: string | null;
  clearMessages: () => void;
  create: (scope: MeasureScope, draft: MeasureDraft) => Promise<Measure | null>;
  update: (scope: MeasureScope, id: string, draft: MeasureDraft) => Promise<void>;
  duplicate: (scope: MeasureScope, id: string) => Promise<void>;
  remove: (scope: MeasureScope, id: string) => Promise<void>;
  transfer: (from: MeasureScope, to: MeasureScope, id: string) => Promise<void>;
}

/** Re-points every ref at `fromId` to `toId`; returns the same chart if none. */
const repointChart = (chart: ChartSpec, fromId: string, toId: string): ChartSpec => {
  if (fromId === toId) return chart;
  if (!chart.query.measures.some((ref) => ref.measureId === fromId)) return chart;
  return {
    ...chart,
    query: {
      ...chart.query,
      measures: chart.query.measures.map((ref) =>
        ref.measureId === fromId ? { ...ref, measureId: toId } : ref,
      ),
    },
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useMeasureActions({
  modelId,
  fallbackSystemMeasures,
  chart,
  onChartChange,
}: MeasureActionsInput): MeasureActions {
  const runtime = useRuntime();
  const models = runtime.models;
  const dashboards = runtime.dashboards;
  const canManageShared = useCanManageShared();

  const storeModel = useModelState((s) => s.current);
  // Only THIS model's store entry counts: a host with another model open in
  // the model editor must not have its measures leak into this builder, and a
  // System write must land on the model the chart actually resolves against.
  const modelCurrent = storeModel !== null && storeModel.id === modelId ? storeModel : null;
  const systemMeasures = modelCurrent?.definition.measures ?? fallbackSystemMeasures;
  const dashboardDoc = useDashboardState((s) => s.current);
  const dashboardMeasures = dashboardDoc?.layout.measures;
  const personalMeasures = useDashboardState((s) => s.personalMeasures);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const scoped = useMemo(
    () => buildScopedMeasures(systemMeasures, dashboardMeasures ?? [], personalMeasures),
    [systemMeasures, dashboardMeasures, personalMeasures],
  );
  const effective = useMemo(() => measuresOfScopes(scoped), [scoped]);

  const rights = useMemo(
    () =>
      allScopeRights({
        model: modelCurrent
          ? { isSystem: modelCurrent.isSystem, ownerIsMe: modelCurrent.ownerIsMe }
          : null,
        canManageShared,
        dashboard: dashboardDoc
          ? { canEditLayout: dashboardDoc.myAccess.canEditLayout }
          : null,
      }),
    [modelCurrent, canManageShared, dashboardDoc],
  );

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  /** Names already taken anywhere the engine can see — the dedupe universe. */
  const takenNames = useCallback(() => scoped.map((entry) => entry.measure.name), [scoped]);

  /**
   * Commits the model store to the server. Used by every System-scope write:
   * the builder has no "save model" button, so a measure edit that only lived
   * in the store would vanish the moment the model reloads. A refusal (the
   * server still owns the decision) rolls the local change back, so the store
   * never keeps a change the server rejected.
   */
  const saveModel = useCallback(
    async (rollback: () => void): Promise<boolean> => {
      const ok = await models.save();
      if (!ok) {
        rollback();
        setError(models.store.getState().error ?? 'The model could not be saved.');
      }
      return ok;
    },
    [models],
  );

  const create = useCallback(
    async (scope: MeasureScope, draft: MeasureDraft): Promise<Measure | null> => {
      clearMessages();
      if (scope === 'system') {
        setBusy(true);
        try {
          const added = models.addMeasure(draft);
          const ok = await saveModel(() => models.removeMeasure(added.id));
          return ok ? added : null;
        } catch (e: unknown) {
          setError(messageOf(e));
          return null;
        } finally {
          setBusy(false);
        }
      }
      if (scope === 'dashboard') {
        const added = dashboards.addDashboardMeasure(draft);
        if (added === null) setError('No dashboard is open, so it cannot hold a measure.');
        return added;
      }
      const added: Measure = { ...draft, id: newId() };
      dashboards.setPersonalMeasures([...personalMeasures, added]);
      return added;
    },
    [clearMessages, models, dashboards, personalMeasures, saveModel],
  );

  const update = useCallback(
    async (scope: MeasureScope, id: string, draft: MeasureDraft): Promise<void> => {
      clearMessages();
      if (scope === 'system') {
        const before = systemMeasures.find((m) => m.id === id) ?? null;
        setBusy(true);
        try {
          models.updateMeasure(id, draft);
          await saveModel(() => {
            if (before) models.updateMeasure(id, before);
          });
        } catch (e: unknown) {
          setError(messageOf(e));
        } finally {
          setBusy(false);
        }
        return;
      }
      if (scope === 'dashboard') {
        dashboards.updateDashboardMeasure(id, draft);
        return;
      }
      dashboards.setPersonalMeasures(
        personalMeasures.map((m) => (m.id === id ? { ...m, ...draft, id: m.id } : m)),
      );
    },
    [clearMessages, models, dashboards, personalMeasures, systemMeasures, saveModel],
  );

  /** A measure's definition minus its identity — the payload of any copy. */
  const definitionOf = useCallback(
    (id: string): Measure | null => scoped.find((e) => e.measure.id === id)?.measure ?? null,
    [scoped],
  );

  const duplicate = useCallback(
    async (scope: MeasureScope, id: string): Promise<void> => {
      const source = definitionOf(id);
      if (!source) return;
      // Deduped across EVERY scope, not just this one: names are resolved
      // model-wide, so "Total" in the dashboard shadows nothing but breaks
      // [Total] in the model all the same.
      const copy = { ...source, name: nextMeasureCopyName(takenNames(), source.name) };
      const { id: _dropped, ...draft } = copy;
      await create(scope, draft as MeasureDraft);
    },
    [definitionOf, takenNames, create],
  );

  const remove = useCallback(
    async (scope: MeasureScope, id: string): Promise<void> => {
      clearMessages();
      if (scope === 'system') {
        const before = systemMeasures.find((m) => m.id === id) ?? null;
        setBusy(true);
        try {
          models.removeMeasure(id);
          await saveModel(() => {
            if (before) models.addMeasure(before);
          });
        } catch (e: unknown) {
          setError(messageOf(e));
        } finally {
          setBusy(false);
        }
        return;
      }
      if (scope === 'dashboard') {
        dashboards.removeDashboardMeasure(id);
        return;
      }
      dashboards.setPersonalMeasures(personalMeasures.filter((m) => m.id !== id));
    },
    [clearMessages, models, dashboards, personalMeasures, systemMeasures, saveModel],
  );

  const transfer = useCallback(
    async (from: MeasureScope, to: MeasureScope, id: string): Promise<void> => {
      clearMessages();
      const source = definitionOf(id);
      if (!source || from === to) return;
      const verb = transferVerb(from, to);

      /* ---------------------------------------------- narrowing: a fresh copy */
      if (verb === 'copy') {
        const copy: Measure = {
          ...source,
          id: newId(),
          name: nextMeasureCopyName(takenNames(), source.name),
        };
        const { id: _dropped, ...draft } = copy;
        const added = await create(to, draft as MeasureDraft);
        if (added) {
          setNotice(
            `Copied as “${added.name}”. The original stays in ${
              from === 'system' ? 'the model' : 'this dashboard'
            } — other charts still use it.`,
          );
        }
        return;
      }

      /* ------------------------------------------------ widening: a promotion */
      if (to === 'dashboard') {
        // Wave 2's promotion action: collision-safe, keeps the id and name
        // wherever the dashboard has neither taken, and hands back a chart
        // whose refs point at whatever it decided.
        const result = dashboards.promoteMeasuresToDashboard([source], chart);
        if (result === null) {
          setError('No dashboard is open, so it cannot hold a measure.');
          return;
        }
        if (result.chart !== chart) onChartChange(result.chart);
        if (from === 'personal') {
          dashboards.setPersonalMeasures(personalMeasures.filter((m) => m.id !== id));
        }
        const renamed = result.renamed.find(([before]) => before === source.name);
        setNotice(
          renamed
            ? `Moved to this dashboard as “${renamed[1]}” — that name was already taken.`
            : `“${source.name}” now belongs to this dashboard.`,
        );
        return;
      }

      // to === 'system'
      if (modelId === null) {
        setError('This dashboard has no model, so it has nowhere to keep a system measure.');
        return;
      }
      setBusy(true);
      try {
        if (from === 'dashboard') {
          // promoteMeasureToModel carries the transitive [reference] closure
          // with it — a calculated measure is worthless in the model without
          // the measures its expression names.
          const promoted = await dashboards.promoteMeasureToModel(id);
          if (!promoted) {
            setError('The measure could not be promoted.');
            return;
          }
          if (promoted.id === id) {
            // The id survived, so every chart citing it resolves against the
            // model copy — the dashboard copy is now redundant.
            dashboards.removeDashboardMeasure(id);
            setNotice(`“${promoted.name}” is now a system measure, shared by every dashboard.`);
          } else {
            // A different id means the model already used this one; removing
            // the dashboard copy would break the charts that cite it.
            setNotice(
              `“${promoted.name}” was added to the model, but the copy on this dashboard was kept — its id was already in use.`,
            );
          }
          if (!models.store.getState().dirty) await models.openModel(modelId);
          return;
        }
        // personal → system. No promotion action covers this direction (the
        // store's promote reads dashboard scope), so it goes through the model
        // store's own CRUD. A fresh id is safe here and nowhere else: a
        // personal measure can only be cited by the draft open in the builder,
        // because the promotion rule copies cited personal measures into the
        // dashboard before a chart is ever saved.
        const clash = systemMeasures.some(
          (m) => m.name.trim().toLowerCase() === source.name.trim().toLowerCase(),
        );
        const name = clash ? nextMeasureCopyName(takenNames(), source.name) : source.name;
        const { id: _dropped, ...draft } = { ...source, name };
        const added = models.addMeasure(draft);
        const ok = await saveModel(() => models.removeMeasure(added.id));
        if (!ok) return;
        dashboards.setPersonalMeasures(personalMeasures.filter((m) => m.id !== id));
        onChartChange(repointChart(chart, id, added.id));
        setNotice(`“${added.name}” is now a system measure, shared by every dashboard.`);
      } catch (e: unknown) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [
      clearMessages,
      definitionOf,
      takenNames,
      create,
      dashboards,
      models,
      modelId,
      chart,
      onChartChange,
      personalMeasures,
      systemMeasures,
      saveModel,
    ],
  );

  return {
    scoped,
    effective,
    rights,
    busy,
    error,
    notice,
    clearMessages,
    create,
    update,
    duplicate,
    remove,
    transfer,
  };
}
