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
}

/** Host tuning for a runtime (DashboardsProvider forwards its props here). */
export interface DashboardsRuntimeOptions {
  /** Query cache tuning: TTLs, entry cap, request concurrency. */
  queryOptions?: QueryCacheOptions;
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
  };
};
