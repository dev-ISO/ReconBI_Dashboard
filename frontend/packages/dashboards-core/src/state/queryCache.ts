import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartQuerySpec, DistinctValuesResult, DistinctValuesSpec, QueryResult } from '../types/query';
import { stableStringify } from '../util/hash';

export interface QueryCacheEntry {
  status: 'loading' | 'ok' | 'error';
  data?: QueryResult;
  error?: string;
  errorCode?: string | null;
  /**
   * Structured field-level validation issues off a failed run's RcdApiError
   * (the server's ValidationIssue list — path speaks the wire-path grammar
   * chartValidation's pathToWell maps back onto builder wells). Present only
   * on 'error' entries whose response carried them.
   */
  issues?: { code: string; severity: string; message: string; path: string | null }[];
  fetchedAt: number;
}

export interface QueryCacheState {
  entries: Record<string, QueryCacheEntry>;
}

/** Tuning knobs threaded from createDashboardsRuntime / DashboardsProvider. */
export interface QueryCacheOptions {
  /** Fresh-'ok' reuse window for chart queries. Default 180_000. */
  queryTtlMs?: number;
  /** Fresh reuse window for distinct-value lists. Default 300_000. */
  distinctTtlMs?: number;
  /**
   * Cap on cached result entries (query entries and distinct results each).
   * On insert, the oldest-fetchedAt non-loading entries are evicted down to
   * the cap; entries older than 10× their TTL drop opportunistically too.
   * Default 300.
   */
  maxEntries?: number;
  /**
   * Cap on concurrent HTTP requests issued by run()/distinct() combined — a
   * FIFO queue, so a 36-tile page cannot burst the server's per-user rate
   * limit (QueueLimit=0 → immediate 429s) or the shared database. Cache hits
   * and in-flight joins bypass the queue entirely. Default 6.
   */
  maxConcurrent?: number;
}

const DEFAULT_QUERY_TTL_MS = 180_000;
const DEFAULT_DISTINCT_TTL_MS = 300_000;
const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_CONCURRENT = 6;

/**
 * Shared result cache for tiles, previews, and slicers. In-flight requests
 * are deduplicated by spec hash; entries expire by TTL and are evicted by an
 * LRU-by-fetch-time cap; actual HTTP requests flow through a FIFO concurrency
 * gate (see QueryCacheOptions.maxConcurrent); React components subscribe via
 * the vanilla store.
 */
export class QueryCache {
  readonly store: StoreApi<QueryCacheState>;
  private readonly inFlight = new Map<string, Promise<QueryResult>>();
  private readonly distinctInFlight = new Map<string, Promise<DistinctValuesResult>>();
  private readonly distinctResults = new Map<string, { data: DistinctValuesResult; fetchedAt: number }>();

  private readonly queryTtlMs: number;
  private readonly distinctTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxConcurrent: number;

  /* FIFO semaphore over actual HTTP requests. `active` counts held slots;
   * waiters resolve in arrival order, inheriting the released slot. */
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly api: DashboardsApi,
    options: QueryCacheOptions = {},
  ) {
    this.queryTtlMs = options.queryTtlMs ?? DEFAULT_QUERY_TTL_MS;
    this.distinctTtlMs = options.distinctTtlMs ?? DEFAULT_DISTINCT_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
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
    // Only fresh 'ok' short-circuits: stale 'ok' keeps rendering while the
    // refetch runs, and error entries refetch on the next effect run.
    if (existing?.status === 'ok' && Date.now() - existing.fetchedAt < this.queryTtlMs) {
      return existing.data!;
    }

    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight;

    this.setEntry(key, { status: 'loading', fetchedAt: Date.now() });
    // Deliberately NOT forwarding the caller's abort signal: the in-flight
    // promise is shared across subscribers (and StrictMode double-mounts), so
    // one caller's abort must not doom it for everyone. Aborting a caller just
    // abandons its await; the response still lands in the cache.
    const promise = this.scheduled(() => this.api.runQuery(spec))
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
          // RcdApiError.issues ride along so consumers (builder well badges,
          // the tile error card) can point at the offending field.
          const issues =
            error && typeof error === 'object' && 'issues' in error &&
            Array.isArray((error as { issues: unknown }).issues)
              ? (error as { issues: NonNullable<QueryCacheEntry['issues']> }).issues
              : undefined;
          this.setEntry(key, {
            status: 'error',
            error: message,
            errorCode,
            ...(issues !== undefined && issues.length > 0 ? { issues } : {}),
            fetchedAt: Date.now(),
          });
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
    if (cached && Date.now() - cached.fetchedAt < this.distinctTtlMs) return cached.data;

    const inFlight = this.distinctInFlight.get(key);
    if (inFlight) return inFlight;

    // Shared promise — never bound to one caller's signal (see run()).
    const promise = this.scheduled(() => this.api.getDistinctValues(spec))
      .then((data) => {
        this.setDistinct(key, data);
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

  /* --------------------------------------------------------------- scheduler */

  /** Runs `request` once a concurrency slot is free (FIFO). */
  private async scheduled<T>(request: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await request();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    // A waiter inherits the slot, keeping `active` constant; otherwise free it.
    if (next) next();
    else this.active -= 1;
  }

  /* ----------------------------------------------------------------- eviction */

  private setEntry(key: string, entry: QueryCacheEntry): void {
    this.store.setState((state) => ({
      entries: this.evict({ ...state.entries, [key]: entry }, key),
    }));
  }

  /**
   * Cap + opportunistic staleness sweep, run on every insert. Never evicts
   * 'loading' entries (their in-flight promise is about to write) or the key
   * just written. `entries` is already a fresh object — mutate in place.
   */
  private evict(entries: Record<string, QueryCacheEntry>, keep: string): Record<string, QueryCacheEntry> {
    const staleBefore = Date.now() - this.queryTtlMs * 10;
    const evictable = Object.keys(entries).filter(
      (k) => k !== keep && entries[k]!.status !== 'loading',
    );
    const drop = new Set(evictable.filter((k) => entries[k]!.fetchedAt < staleBefore));
    const over = Object.keys(entries).length - drop.size - this.maxEntries;
    if (over > 0) {
      const oldestFirst = evictable
        .filter((k) => !drop.has(k))
        .sort((a, b) => entries[a]!.fetchedAt - entries[b]!.fetchedAt);
      for (const k of oldestFirst.slice(0, over)) drop.add(k);
    }
    for (const k of drop) delete entries[k];
    return entries;
  }

  private setDistinct(key: string, data: DistinctValuesResult): void {
    this.distinctResults.set(key, { data, fetchedAt: Date.now() });
    const staleBefore = Date.now() - this.distinctTtlMs * 10;
    for (const [k, v] of this.distinctResults) {
      if (k !== key && v.fetchedAt < staleBefore) this.distinctResults.delete(k);
    }
    const over = this.distinctResults.size - this.maxEntries;
    if (over > 0) {
      const oldestFirst = [...this.distinctResults.entries()]
        .filter(([k]) => k !== key)
        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
        .slice(0, over);
      for (const [k] of oldestFirst) this.distinctResults.delete(k);
    }
  }

  private clearEntry(key: string): void {
    this.store.setState((state) => {
      const { [key]: _removed, ...rest } = state.entries;
      return { entries: rest };
    });
  }
}
