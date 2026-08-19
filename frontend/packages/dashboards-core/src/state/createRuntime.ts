import { DashboardsApi } from '../api/DashboardsApi';
import type { RcdFetcher } from '../api/fetcher';
import { DashboardStore } from './dashboardStore';
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
    dashboards: new DashboardStore(api),
    queries: new QueryCache(api, options?.queryOptions),
    options: {
      scheduleTimeZoneId: options?.scheduleTimeZoneId ?? 'UTC',
      scheduleTimeLabel: options?.scheduleTimeLabel ?? 'UTC',
    },
  };
};
