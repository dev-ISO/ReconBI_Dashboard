import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  createDashboardsRuntime,
  type DashboardsRuntime,
  type DashboardStoreState,
  type ModelStoreState,
  type QueryCacheOptions,
  type QueryCacheState,
  type RcdFetcher,
} from '@recon/dashboards-core';

const RuntimeContext = createContext<DashboardsRuntime | null>(null);

export interface DashboardsProviderProps {
  /** Prefix of the mounted API, e.g. "/api/rcd/v1". No trailing slash. */
  baseUrl: string;
  /** Host-adapted authenticated fetch. */
  fetcher: RcdFetcher;
  /**
   * Query-cache tuning (TTLs, entry cap, request-concurrency cap) threaded to
   * createDashboardsRuntime. Pass a stable (module-level or memoized) object —
   * a fresh literal per render would rebuild the whole runtime.
   */
  queryOptions?: QueryCacheOptions;
  children: ReactNode;
}

/**
 * Scopes one runtime (api + stores + query cache) to a subtree and provides
 * the .rcd-root theming boundary. Multiple providers on one page are fine.
 */
export function DashboardsProvider({
  baseUrl,
  fetcher,
  queryOptions,
  children,
}: DashboardsProviderProps) {
  const runtime = useMemo(
    () => createDashboardsRuntime(baseUrl, fetcher, queryOptions ? { queryOptions } : undefined),
    [baseUrl, fetcher, queryOptions],
  );
  return (
    <RuntimeContext.Provider value={runtime}>
      <div className="rcd-root flex h-full min-h-0 flex-col">{children}</div>
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): DashboardsRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('ReconDashboards components must be wrapped in <DashboardsProvider>.');
  return runtime;
}

export function useModelState<T>(selector: (state: ModelStoreState) => T): T {
  return useStore(useRuntime().models.store, selector);
}

export function useDashboardState<T>(selector: (state: DashboardStoreState) => T): T {
  return useStore(useRuntime().dashboards.store, selector);
}

export function useQueryCacheState<T>(selector: (state: QueryCacheState) => T): T {
  return useStore(useRuntime().queries.store, selector);
}
