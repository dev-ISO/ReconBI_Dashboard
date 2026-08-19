import { DashboardsApi } from '../api/DashboardsApi';
import type { RcdFetcher } from '../api/fetcher';
import { DashboardStore, type DashboardCollabSenders } from './dashboardStore';
import { ModelStore } from './modelStore';
import { QueryCache, type QueryCacheOptions } from './queryCache';

export interface DashboardsRuntime {
  api: DashboardsApi;
  models: ModelStore;
  dashboards: DashboardStore;
  queries: QueryCache;
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
  return {
    api,
    models: new ModelStore(api),
    dashboards: new DashboardStore(api, {
      onSendCursor: options?.onSendCursor,
      onSendSlicerValue: options?.onSendSlicerValue,
    }),
    queries: new QueryCache(api, options?.queryOptions),
    options: {
      scheduleTimeZoneId: options?.scheduleTimeZoneId ?? 'UTC',
      scheduleTimeLabel: options?.scheduleTimeLabel ?? 'UTC',
    },
  };
};
