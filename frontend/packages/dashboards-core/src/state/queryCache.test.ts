import { afterEach, describe, expect, it, vi } from 'vitest';
import { RcdApiError } from '../api/fetcher';
import type { DashboardsApi } from '../api/DashboardsApi';
import type { ChartQuerySpec, QueryResult } from '../types/query';
import { QueryCache } from './queryCache';

const specFor = (n: number): ChartQuerySpec => ({
  modelId: 1,
  dimensions: [],
  measures: [{ table: 'public.orders', column: 'total', aggregation: 'sum', alias: `m${n}` }],
  filters: [],
  sort: [],
});

const resultFor = (tag: number): QueryResult => ({
  columns: [],
  rows: [[tag]],
  meta: { rowCount: 1, truncated: false, elapsedMs: 1, warnings: [], sql: null },
});

interface Deferred {
  promise: Promise<QueryResult>;
  resolve: (r: QueryResult) => void;
  reject: (e: unknown) => void;
}

const deferred = (): Deferred => {
  let resolve!: (r: QueryResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<QueryResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Drains pure-microtask chains (the FIFO scheduler's acquire/release hops).
 * Works under fake timers too — no setTimeout involved.
 */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Api stub whose runQuery hands out one controllable promise per call. */
const apiWithQueue = (): {
  api: DashboardsApi;
  calls: Deferred[];
  runQuery: ReturnType<typeof vi.fn>;
} => {
  const calls: Deferred[] = [];
  const runQuery = vi.fn(() => {
    const d = deferred();
    calls.push(d);
    return d.promise;
  });
  return { api: { runQuery } as unknown as DashboardsApi, calls, runQuery };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('QueryCache TTL reuse', () => {
  it('reuses a fresh ok entry and refetches once the TTL passes', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { api, calls, runQuery } = apiWithQueue();
    const cache = new QueryCache(api, { queryTtlMs: 60_000 });

    const first = cache.run(specFor(1));
    await tick();
    calls[0]!.resolve(resultFor(1));
    await expect(first).resolves.toEqual(resultFor(1));

    // Within TTL: served from cache, no new request.
    await expect(cache.run(specFor(1))).resolves.toEqual(resultFor(1));
    expect(runQuery).toHaveBeenCalledTimes(1);

    // Past TTL: refetch.
    vi.setSystemTime(1_000_000 + 60_001);
    const third = cache.run(specFor(1));
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(resultFor(2));
    await expect(third).resolves.toEqual(resultFor(2));
  });

  it('defaults the query TTL to 180s', async () => {
    vi.useFakeTimers({ now: 0 });
    const { api, calls, runQuery } = apiWithQueue();
    const cache = new QueryCache(api);

    const first = cache.run(specFor(1));
    await tick();
    calls[0]!.resolve(resultFor(1));
    await first;

    vi.setSystemTime(179_999);
    await cache.run(specFor(1));
    expect(runQuery).toHaveBeenCalledTimes(1);

    vi.setSystemTime(180_001);
    void cache.run(specFor(1)).catch(() => {});
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(resultFor(2));
  });

  it('does not short-circuit error entries — the next run refetches', async () => {
    const { api, calls, runQuery } = apiWithQueue();
    const cache = new QueryCache(api);

    const first = cache.run(specFor(1));
    await tick();
    calls[0]!.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    expect(cache.entryFor(cache.keyFor(specFor(1)))?.status).toBe('error');

    const second = cache.run(specFor(1));
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(resultFor(2));
    await expect(second).resolves.toEqual(resultFor(2));
  });

  /* ITEM 6 — field-level issues off a failed run. The builder badges wells
   * from them and the tile error card shows the first one, so they must
   * survive the rejection into the cache entry (and only when present). */
  it('banks RcdApiError.issues on the error entry', async () => {
    const { api, calls } = apiWithQueue();
    const cache = new QueryCache(api);

    const run = cache.run(specFor(1));
    await tick();
    const issues = [
      {
        code: 'rcd.query.unknown_column',
        severity: 'error',
        message: "Column 'nope' does not exist on 'public.orders'.",
        path: 'dimensions[1].column',
      },
    ];
    calls[0]!.reject(
      new RcdApiError('Query failed.', 400, 'rcd.query.unknown_column', issues),
    );
    await expect(run).rejects.toThrow('Query failed.');

    const entry = cache.entryFor(cache.keyFor(specFor(1)));
    expect(entry).toMatchObject({
      status: 'error',
      errorCode: 'rcd.query.unknown_column',
      issues,
    });
  });

  it('leaves issues absent for a plain error and for an empty issue list', async () => {
    const { api, calls } = apiWithQueue();
    const cache = new QueryCache(api);

    const plain = cache.run(specFor(1));
    await tick();
    calls[0]!.reject(new Error('boom'));
    await expect(plain).rejects.toThrow('boom');
    expect(cache.entryFor(cache.keyFor(specFor(1)))?.issues).toBeUndefined();

    const empty = cache.run(specFor(2));
    await tick();
    calls[1]!.reject(new RcdApiError('Nope.', 500, 'rcd.query.failed'));
    await expect(empty).rejects.toThrow('Nope.');
    expect(cache.entryFor(cache.keyFor(specFor(2)))?.issues).toBeUndefined();
  });
});

describe('QueryCache in-flight dedupe', () => {
  it('joins concurrent callers onto one request', async () => {
    const { api, calls, runQuery } = apiWithQueue();
    const cache = new QueryCache(api);

    const a = cache.run(specFor(1));
    const b = cache.run(specFor(1));
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(1);

    calls[0]!.resolve(resultFor(7));
    await expect(a).resolves.toEqual(resultFor(7));
    await expect(b).resolves.toEqual(resultFor(7));
  });
});

describe('QueryCache eviction', () => {
  it('evicts the oldest non-loading entries past maxEntries', async () => {
    vi.useFakeTimers({ now: 0 });
    const { api, calls } = apiWithQueue();
    const cache = new QueryCache(api, { maxEntries: 2 });

    for (let n = 0; n < 3; n++) {
      vi.setSystemTime(n * 1_000);
      const run = cache.run(specFor(n));
      await tick();
      calls[n]!.resolve(resultFor(n));
      await run;
    }

    const entries = cache.store.getState().entries;
    expect(Object.keys(entries)).toHaveLength(2);
    expect(cache.entryFor(cache.keyFor(specFor(0)))).toBeUndefined(); // oldest gone
    expect(cache.entryFor(cache.keyFor(specFor(1)))?.status).toBe('ok');
    expect(cache.entryFor(cache.keyFor(specFor(2)))?.status).toBe('ok');
  });

  it('never evicts loading entries', async () => {
    vi.useFakeTimers({ now: 0 });
    const { api, calls } = apiWithQueue();
    const cache = new QueryCache(api, { maxEntries: 1 });

    const pendingA = cache.run(specFor(1)); // stays loading
    await tick();
    vi.setSystemTime(1_000);
    const runB = cache.run(specFor(2));
    await tick();
    calls[1]!.resolve(resultFor(2));
    await runB;

    expect(cache.entryFor(cache.keyFor(specFor(1)))?.status).toBe('loading');
    calls[0]!.resolve(resultFor(1));
    await pendingA;
    expect(cache.entryFor(cache.keyFor(specFor(1)))?.status).toBe('ok');
  });

  it('drops entries older than 10x the TTL opportunistically', async () => {
    vi.useFakeTimers({ now: 0 });
    const { api, calls } = apiWithQueue();
    const cache = new QueryCache(api, { queryTtlMs: 1_000, maxEntries: 100 });

    const first = cache.run(specFor(1));
    await tick();
    calls[0]!.resolve(resultFor(1));
    await first;

    vi.setSystemTime(10_001); // > 10x TTL
    const second = cache.run(specFor(2));
    await tick();
    calls[1]!.resolve(resultFor(2));
    await second;

    expect(cache.entryFor(cache.keyFor(specFor(1)))).toBeUndefined();
  });
});

describe('QueryCache scheduler', () => {
  it('caps concurrent requests and admits waiters in FIFO order', async () => {
    const { api, calls, runQuery } = apiWithQueue();
    const cache = new QueryCache(api, { maxConcurrent: 2 });

    const runs = [0, 1, 2, 3].map((n) => cache.run(specFor(n)));
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(2);

    // Releasing one slot admits exactly the NEXT queued request (spec 2).
    calls[0]!.resolve(resultFor(0));
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(3);
    expect(runQuery.mock.calls[2]![0]).toEqual(specFor(2));

    calls[1]!.resolve(resultFor(1));
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(4);
    expect(runQuery.mock.calls[3]![0]).toEqual(specFor(3));

    calls[2]!.resolve(resultFor(2));
    calls[3]!.resolve(resultFor(3));
    await expect(Promise.all(runs)).resolves.toHaveLength(4);
  });

  it('lets cache hits and in-flight joins bypass the queue', async () => {
    const { api, calls, runQuery } = apiWithQueue();
    const cache = new QueryCache(api, { maxConcurrent: 1 });

    const warm = cache.run(specFor(1));
    await tick();
    calls[0]!.resolve(resultFor(1));
    await warm;

    // Saturate the single slot.
    void cache.run(specFor(2)).catch(() => {});
    await tick();
    expect(runQuery).toHaveBeenCalledTimes(2);

    // Fresh hit resolves immediately despite the busy scheduler.
    await expect(cache.run(specFor(1))).resolves.toEqual(resultFor(1));
    calls[1]!.resolve(resultFor(2));
  });

  it('is shared between run() and distinct()', async () => {
    const distinctCalls: Deferred[] = [];
    const runCalls: Deferred[] = [];
    const runQuery = vi.fn(() => {
      const d = deferred();
      runCalls.push(d);
      return d.promise;
    });
    const getDistinctValues = vi.fn(() => {
      const d = deferred();
      distinctCalls.push(d);
      return d.promise as unknown as Promise<never>;
    });
    const cache = new QueryCache(
      { runQuery, getDistinctValues } as unknown as DashboardsApi,
      { maxConcurrent: 1 },
    );

    void cache.run(specFor(1)).catch(() => {});
    const distinct = cache.distinct({ modelId: 1, table: 't', column: 'c', filters: [] });
    await tick();
    // The distinct call waits behind the running query.
    expect(getDistinctValues).not.toHaveBeenCalled();

    runCalls[0]!.resolve(resultFor(1));
    await tick();
    expect(getDistinctValues).toHaveBeenCalledTimes(1);
    distinctCalls[0]!.resolve(resultFor(0)); // shape irrelevant to the scheduler
    await distinct;
  });
});
