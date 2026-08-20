import { DashboardsApi } from '../api/DashboardsApi';
import type { RcdFetcher } from '../api/fetcher';
import { DashboardStore, type DashboardCollabSenders } from './dashboardStore';
import { ModelStore } from './modelStore';
import {
  PERSONAL_MEASURES_SECTION,
  migrateFlatPersonalMeasures,
  personalMeasuresModelKey,
  readPersonalMeasures,
  writePersonalMeasures,
} from './personalMeasures';
import { QueryCache, type QueryCacheOptions } from './queryCache';
import { UserSettingsStore, type UserSettingsStoreOptions } from './userSettingsStore';

export interface DashboardsRuntime {
  api: DashboardsApi;
  models: ModelStore;
  dashboards: DashboardStore;
  queries: QueryCache;
  /**
   * The signed-in user's private preferences, held server-side so they follow
   * the user to any machine. Hydrates lazily on first use and costs nothing
   * until something reads or writes a section; the host should call
   * `userSettings.dispose()` on unmount/logout so a debounced write is flushed
   * rather than lost.
   */
  userSettings: UserSettingsStore;
  /** Resolved host display options consumed by UI components. */
  options: {
    /** IANA zone id schedule times are entered/shown in (mirrors the backend's
     * ReconDashboardsOptions.ScheduleTimeZoneId). Used to render UTC instants
     * (e.g. "last sent") as schedule-zone wall time via Intl. */
    scheduleTimeZoneId: string;
    /** Short label ("CT") shown next to schedule times in dialogs. */
    scheduleTimeLabel: string;
  };
}

/** Host tuning for a runtime (DashboardsProvider forwards its props here). */
export interface DashboardsRuntimeOptions {
  /** Query cache tuning: TTLs, entry cap, request concurrency. */
  queryOptions?: QueryCacheOptions;
  /** Per-user settings tuning (write debounce). Defaults suit every host. */
  userSettingsOptions?: UserSettingsStoreOptions;
  /**
   * Zone in which subscription send times are interpreted — MUST match the
   * host backend's ReconDashboardsOptions.ScheduleTimeZoneId or the UI's
   * labels lie about when emails go out. Default 'UTC' matches the backend
   * default for hosts that configure neither.
   */
  scheduleTimeZoneId?: string;
  /** Display label for scheduleTimeZoneId ("CT"). Default 'UTC'. */
  scheduleTimeLabel?: string;
  /**
   * COLLAB wave 2 outbound ephemera: host callback publishing one throttled
   * cursor frame ({pageId, xFrac, yFrac}) to the dashboard's realtime group.
   * Absent = cursor sending silently disabled (portal/demo hosts); inbound
   * cursors still render via runtime.dashboards.applyRemoteCursor.
   */
  onSendCursor?: DashboardCollabSenders['onSendCursor'];
  /**
   * COLLAB wave 2: host callback publishing a SHARED slicer's new value
   * ({tileId, valueJson}) to the group. Absent = shared-slicer sending
   * silently disabled; inbound values still apply.
   */
  onSendSlicerValue?: DashboardCollabSenders['onSendSlicerValue'];
}

/**
 * One runtime per DashboardsProvider mount — context-scoped, never module
 * singletons, so the library can be embedded multiple times on one page.
 */
export const createDashboardsRuntime = (
  baseUrl: string,
  fetcher: RcdFetcher,
  options?: DashboardsRuntimeOptions,
): DashboardsRuntime => {
  const api = new DashboardsApi(baseUrl.replace(/\/+$/, ''), fetcher);
  const userSettings = new UserSettingsStore(api, options?.userSettingsOptions);
  const dashboards = new DashboardStore(api, {
    onSendCursor: options?.onSendCursor,
    onSendSlicerValue: options?.onSendSlicerValue,
    // PERSONAL-scope measures live in the per-user settings document, keyed by
    // MODEL (a measure names one model's tables). The dashboard store holds the
    // working copy for the open dashboard's model; writes go through the
    // settings store's debounce, so a burst of edits is one PUT, and only the
    // active model's bucket is replaced.
    onPersistPersonalMeasures: (measures, modelId) =>
      userSettings.update((doc) => ({
        ...doc,
        [PERSONAL_MEASURES_SECTION]: writePersonalMeasures(
          doc[PERSONAL_MEASURES_SECTION],
          modelId,
          measures,
        ),
      })),
  });

  /**
   * Keeps the working copy pointed at the OPEN DASHBOARD'S MODEL. Re-seeds
   * whenever that model changes, and does nothing while no dashboard is open —
   * closing one leaves the last set in place, matching the store's own rule
   * that personal measures belong to the user, not to the dashboard.
   */
  let seededKey: string | null = null;
  const syncPersonalMeasures = (): void => {
    const current = dashboards.store.getState().current;
    if (!current) return;
    const key = personalMeasuresModelKey(current.modelId);
    if (key === seededKey) return;
    seededKey = key;

    const raw = userSettings.section<unknown>(PERSONAL_MEASURES_SECTION, null);
    // One-time migration of the pre-keying flat array (see personalMeasures.ts:
    // it is attributed to the first model it is seen against).
    const migrated = migrateFlatPersonalMeasures(raw, current.modelId);
    if (migrated !== null) userSettings.setSection(PERSONAL_MEASURES_SECTION, migrated);
    dashboards.hydratePersonalMeasures(readPersonalMeasures(migrated ?? raw, current.modelId));
  };
  dashboards.store.subscribe(syncPersonalMeasures);

  // Load the document in the background. Deliberately fire-and-forget and
  // deliberately NOT awaited by the runtime: a settings outage must not stop
  // dashboards from opening — personal measures simply stay empty, and the
  // store's own error state carries the reason. hydrate() is idempotent, so a
  // later read by the field list joins this same request rather than racing it.
  void userSettings
    .hydrate()
    .then(() => {
      // A dashboard opened while this was in flight has already run the sync
      // against an empty document; re-run it against the real one.
      seededKey = null;
      syncPersonalMeasures();
    })
    .catch(() => {
      /* surfaced by userSettings.state.error; nothing to do here. */
    });

  return {
    api,
    models: new ModelStore(api),
    dashboards,
    queries: new QueryCache(api, options?.queryOptions),
    userSettings,
    options: {
      scheduleTimeZoneId: options?.scheduleTimeZoneId ?? 'UTC',
      scheduleTimeLabel: options?.scheduleTimeLabel ?? 'UTC',
    },
  };
};
