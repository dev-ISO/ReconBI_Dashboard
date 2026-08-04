import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartQuerySpec, DistinctValuesResult, DistinctValuesSpec, QueryResult } from '../types/query';
import { stableStringify } from '../util/hash';

export interface QueryCacheEntry {
  status: 'loading' | 'ok' | 'error';
  data?: QueryResult;
  error?: string;
  errorCode?: string | null;
  fetchedAt: number;
}

export interface QueryCacheState {
  entries: Record<string, QueryCacheEntry>;
}

const QUERY_TTL_MS = 60_000;
const DISTINCT_TTL_MS = 300_000;

/**
 * Shared result cache for tiles, previews, and slicers. In-flight requests
 * are deduplicated by spec hash; entries expire by TTL; React components
 * subscribe via the vanilla store.
 */
export class QueryCache {
  readonly store: StoreApi<QueryCacheState>;
  private readonly inFlight = new Map<string, Promise<QueryResult>>();
  private readonly distinctInFlight = new Map<string, Promise<DistinctValuesResult>>();
  private readonly distinctResults = new Map<string, { data: DistinctValuesResult; fetchedAt: number }>();

  constructor(private readonly api: DashboardsApi) {
    this.store = createStore<QueryCacheState>(() => ({ entries: {} }));
  }

  keyFor(spec: ChartQuerySpec): string {
    return stableStringify(spec);
  }

  entryFor(key: string): QueryCacheEntry | undefined {
    return this.store.getState().entries[key];
  }

  async run(spec: ChartQuerySpec, _signal?: AbortSignal): Promise<QueryResult> {
    const key = this.keyFor(spec);
    const existing = this.entryFor(key);
    if (existing?.status === 'ok' && Date.now() - existing.fetchedAt < QUERY_TTL_MS) {
      return existing.data!;
    }

    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight;

    this.setEntry(key, { status: 'loading', fetchedAt: Date.now() });
    // Deliberately NOT forwarding the caller's abort signal: the in-flight
    // promise is shared across subscribers (and StrictMode double-mounts), so
    // one caller's abort must not doom it for everyone. Aborting a caller just
    // abandons its await; the response still lands in the cache.
    const promise = this.api
      .runQuery(spec)
      .then((data) => {
        this.setEntry(key, { status: 'ok', data, fetchedAt: Date.now() });
        return data;
      })
      .catch((error: unknown) => {
        // Aborts are the caller's business; don't poison the cache entry.
        if (error instanceof DOMException && error.name === 'AbortError') {
          this.clearEntry(key);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          const errorCode =
            error && typeof error === 'object' && 'errorCode' in error
              ? ((error as { errorCode: string | null }).errorCode ?? null)
              : null;
          this.setEntry(key, { status: 'error', error: message, errorCode, fetchedAt: Date.now() });
        }
        throw error;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    return promise;
  }

  async distinct(spec: DistinctValuesSpec, _signal?: AbortSignal): Promise<DistinctValuesResult> {
    const key = stableStringify(spec);
    const cached = this.distinctResults.get(key);
    if (cached && Date.now() - cached.fetchedAt < DISTINCT_TTL_MS) return cached.data;

    const inFlight = this.distinctInFlight.get(key);
    if (inFlight) return inFlight;

    // Shared promise — never bound to one caller's signal (see run()).
    const promise = this.api
      .getDistinctValues(spec)
      .then((data) => {
        this.distinctResults.set(key, { data, fetchedAt: Date.now() });
        return data;
      })
      .finally(() => this.distinctInFlight.delete(key));

    this.distinctInFlight.set(key, promise);
    return promise;
  }

  invalidateAll(): void {
    this.store.setState({ entries: {} });
    this.distinctResults.clear();
  }

  private setEntry(key: string, entry: QueryCacheEntry): void {
    this.store.setState((state) => ({ entries: { ...state.entries, [key]: entry } }));
  }

  private clearEntry(key: string): void {
    this.store.setState((state) => {
      const { [key]: _removed, ...rest } = state.entries;
      return { entries: rest };
    });
  }
}
