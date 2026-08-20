import { useEffect, useState } from 'react';
import type { DashboardsRuntime, RcdMeta } from '@recon/dashboards-core';
import { useRuntime } from './DashboardsProvider';

/**
 * GET /meta, fetched at most once per runtime and shared by every caller.
 *
 * The store deliberately never carries an identity, so `canManageShared` is
 * only knowable from this endpoint — and the measure manager needs it on
 * mount to decide whether System rows are editable or read-only. Caching per
 * runtime (not per component) keeps a builder that mounts the manager, the
 * field list and a dialog from issuing three identical requests.
 *
 * A failure is NOT retried and NOT surfaced: every consumer treats an unknown
 * answer as "no admin standing", which is the safe direction — the server is
 * the authority either way, and a meta outage must not hand out rights.
 */
const cache = new WeakMap<DashboardsRuntime, Promise<RcdMeta | null>>();

export const loadRcdMeta = (runtime: DashboardsRuntime): Promise<RcdMeta | null> => {
  const existing = cache.get(runtime);
  if (existing) return existing;
  const pending = runtime.api
    .getMeta()
    .then((meta) => meta as RcdMeta | null)
    .catch(() => null);
  cache.set(runtime, pending);
  return pending;
};

/** The caller's admin standing; false until known, and false on any failure. */
export function useCanManageShared(): boolean {
  const runtime = useRuntime();
  const [canManageShared, setCanManageShared] = useState(false);

  useEffect(() => {
    let live = true;
    void loadRcdMeta(runtime).then((meta) => {
      if (live && meta) setCanManageShared(meta.canManageShared === true);
    });
    return () => {
      live = false;
    };
  }, [runtime]);

  return canManageShared;
}
