import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
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
  /**
   * Zone in which subscription send times are entered and shown — MUST match
   * the host backend's ReconDashboardsOptions.ScheduleTimeZoneId (e.g.
   * "America/Chicago") or the dialog's labels lie about when emails go out.
   * Default 'UTC' mirrors the backend default.
   */
  scheduleTimeZoneId?: string;
  /** Short display label for scheduleTimeZoneId ("CT"). Default 'UTC'. */
  scheduleTimeLabel?: string;
  /**
   * COLLAB wave 2 outbound cursor channel: called with one throttled pointer
   * frame ({pageId, xFrac, yFrac} — fractions of the grid content box) for
   * the host to publish to the open dashboard's realtime group. ABSENT =
   * cursor sending silently disabled (portal/demo hosts); inbound cursors
   * still render when the host forwards them into applyRemoteCursor.
   * Identity may change freely across renders (latest-ref routed) — only
   * PRESENCE flips rebuild the runtime.
   */
  onSendCursor?: (cursor: { pageId: string; xFrac: number; yFrac: number }) => void;
  /**
   * COLLAB wave 2 shared-slicer channel: called with a SHARED slicer's new
   * value ({tileId, valueJson}) for the host to publish to the group. Same
   * absent-disables / latest-ref semantics as onSendCursor.
   */
  onSendSlicerValue?: (value: { tileId: string; valueJson: string }) => void;
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
  scheduleTimeZoneId,
  scheduleTimeLabel,
  onSendCursor,
  onSendSlicerValue,
  children,
}: DashboardsProviderProps) {
  // Latest-ref routing for the wave-2 sender props: hosts naturally pass
  // inline lambdas, and letting their per-render identities into the useMemo
  // deps would rebuild the ENTIRE runtime (stores, cache, open dashboard) on
  // every host render. The runtime instead captures stable wrappers reading
  // these refs, so the newest callback is always the one invoked. Only
  // PRESENCE (defined vs undefined — "does this host have a live channel at
  // all?") participates in the deps: absent props must yield absent senders
  // (the store's "silently disable sending" contract), and host wiring is
  // static in practice, so a presence flip is a legitimate rebuild.
  const sendCursorRef = useRef(onSendCursor);
  sendCursorRef.current = onSendCursor;
  const sendSlicerValueRef = useRef(onSendSlicerValue);
  sendSlicerValueRef.current = onSendSlicerValue;
  const hasSendCursor = onSendCursor !== undefined;
  const hasSendSlicerValue = onSendSlicerValue !== undefined;

  const runtime = useMemo(
    () =>
      createDashboardsRuntime(baseUrl, fetcher, {
        queryOptions,
        scheduleTimeZoneId,
        scheduleTimeLabel,
        onSendCursor: hasSendCursor ? (cursor) => sendCursorRef.current?.(cursor) : undefined,
        onSendSlicerValue: hasSendSlicerValue
          ? (value) => sendSlicerValueRef.current?.(value)
          : undefined,
      }),
    [baseUrl, fetcher, queryOptions, scheduleTimeZoneId, scheduleTimeLabel, hasSendCursor, hasSendSlicerValue],
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
