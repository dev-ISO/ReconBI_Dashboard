import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardsApi, RcdUserSettings, RcdUserSettingsDoc } from '../api/DashboardsApi';
import { RcdApiError } from '../api/fetcher';
import { USER_SETTINGS_DEBOUNCE_MS, UserSettingsStore } from './userSettingsStore';

/**
 * Fake server: holds one document, records every PUT, and can hold the initial
 * GET open so a test can act during hydration.
 */
const fakeApi = (
  stored: RcdUserSettingsDoc = { version: 1 },
): {
  api: DashboardsApi;
  puts: RcdUserSettingsDoc[];
  gets: () => number;
  holdGet: () => void;
  releaseGet: () => void;
  failGetWith: (error: unknown) => void;
  failNextPutWith: (error: unknown) => void;
} => {
  let doc = stored;
  let getCount = 0;
  let hold: { promise: Promise<void>; release: () => void } | null = null;
  let getError: unknown = null;
  let putError: unknown = null;
  const puts: RcdUserSettingsDoc[] = [];

  const api = {
    getUserSettings: async (): Promise<RcdUserSettings> => {
      getCount++;
      if (hold) await hold.promise;
      if (getError) throw getError;
      return { settings: doc, updatedAtUtc: '2026-08-20T09:00:00Z' };
    },
    putUserSettings: async (settings: RcdUserSettingsDoc): Promise<RcdUserSettings> => {
      if (putError) {
        const thrown = putError;
        putError = null;
        throw thrown;
      }
      puts.push(structuredClone(settings));
      doc = settings;
      return { settings, updatedAtUtc: '2026-08-20T09:05:00Z' };
    },
  } as unknown as DashboardsApi;

  return {
    api,
    puts,
    gets: () => getCount,
    holdGet: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { promise, release };
    },
    releaseGet: () => {
      hold?.release();
      hold = null;
    },
    failGetWith: (error: unknown) => {
      getError = error;
    },
    failNextPutWith: (error: unknown) => {
      putError = error;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('UserSettingsStore hydration', () => {
  it('hydrates once no matter how many consumers ask', async () => {
    const server = fakeApi({ version: 1, fieldList: { grouping: 'type' } });
    const store = new UserSettingsStore(server.api);

    await Promise.all([store.hydrate(), store.hydrate(), store.hydrate()]);
    await store.hydrate();

    expect(server.gets()).toBe(1);
    expect(store.section('fieldList', {})).toEqual({ grouping: 'type' });
    expect(store.store.getState().status).toBe('ok');
  });

  it('does not touch the network until something needs it', () => {
    const server = fakeApi();
    // eslint-disable-next-line no-new
    new UserSettingsStore(server.api);

    expect(server.gets()).toBe(0);
  });

  it('a write made during hydration is replayed on top of the server document', async () => {
    vi.useFakeTimers();
    const server = fakeApi({ version: 1, fieldList: { grouping: 'table' }, other: 'kept' });
    server.holdGet();
    const store = new UserSettingsStore(server.api);

    // The user flips a preference before the GET has come back.
    store.setSection('fieldList', { grouping: 'type' });
    expect(server.gets()).toBe(1);

    server.releaseGet();
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS);

    // The local edit won; the section it never saw survived.
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toEqual({ version: 1, fieldList: { grouping: 'type' }, other: 'kept' });
  });

  it('never writes when hydration failed — a blind PUT would destroy the stored document', async () => {
    vi.useFakeTimers();
    const server = fakeApi({ version: 1, precious: 'do not lose' });
    server.failGetWith(new RcdApiError('boom', 500));
    const store = new UserSettingsStore(server.api);

    store.setSection('fieldList', { grouping: 'type' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS * 2);
    await store.flush();

    expect(server.puts).toHaveLength(0);
    expect(store.store.getState().status).toBe('error');
    // Still dirty: the edit is pending, not discarded.
    expect(store.store.getState().dirty).toBe(true);
  });
});

describe('UserSettingsStore debounced write', () => {
  it('coalesces a burst of changes into ONE request on the trailing edge', async () => {
    vi.useFakeTimers();
    const server = fakeApi();
    const store = new UserSettingsStore(server.api);
    await store.hydrate();

    store.setSection('fieldList', { grouping: 'table' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS - 1);
    store.setSection('fieldList', { grouping: 'type' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS - 1);
    store.setSection('fieldList', { grouping: 'category' });

    expect(server.puts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS);

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]!.fieldList).toEqual({ grouping: 'category' });
    expect(store.store.getState().dirty).toBe(false);
  });

  it('sends the WHOLE document — sections it does not understand ride along', async () => {
    vi.useFakeTimers();
    const server = fakeApi({ version: 1, someFutureWave: { nested: [1, 2, 3] } });
    const store = new UserSettingsStore(server.api);
    await store.hydrate();

    store.setSection('fieldList', { grouping: 'type' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS);

    expect(server.puts[0]).toEqual({
      version: 1,
      someFutureWave: { nested: [1, 2, 3] },
      fieldList: { grouping: 'type' },
    });
  });

  it('ignores a no-op write', async () => {
    vi.useFakeTimers();
    const server = fakeApi({ version: 1, fieldList: { grouping: 'type' } });
    const store = new UserSettingsStore(server.api);
    await store.hydrate();

    store.setSection('fieldList', { grouping: 'type' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS);

    expect(server.puts).toHaveLength(0);
    expect(store.store.getState().dirty).toBe(false);
  });

  it('keeps the document dirty when a save fails, and the next save retries it', async () => {
    vi.useFakeTimers();
    const server = fakeApi();
    const store = new UserSettingsStore(server.api);
    await store.hydrate();
    server.failNextPutWith(new RcdApiError('nope', 422, 'rcd.limit.user_settings_size'));

    store.setSection('fieldList', { grouping: 'type' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS);

    expect(server.puts).toHaveLength(0);
    expect(store.store.getState().dirty).toBe(true);
    expect(store.store.getState().error).toContain('nope');

    store.setSection('fieldList', { grouping: 'table' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS);

    expect(server.puts).toHaveLength(1);
    expect(store.store.getState().dirty).toBe(false);
  });
});

describe('UserSettingsStore flush and dispose', () => {
  it('flush sends immediately and cancels the pending debounce (one request, not two)', async () => {
    vi.useFakeTimers();
    const server = fakeApi();
    const store = new UserSettingsStore(server.api);
    await store.hydrate();

    store.setSection('fieldList', { grouping: 'type' });
    await store.flush();

    expect(server.puts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS * 2);
    expect(server.puts).toHaveLength(1);
  });

  it('dispose flushes a pending write instead of dropping it on unmount', async () => {
    vi.useFakeTimers();
    const server = fakeApi();
    const store = new UserSettingsStore(server.api);
    await store.hydrate();

    store.setSection('fieldList', { grouping: 'type' });
    // Nothing has been sent yet — the debounce window is still open.
    expect(server.puts).toHaveLength(0);

    await store.dispose();

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]!.fieldList).toEqual({ grouping: 'type' });
  });

  it('dispose during hydration still lands the edit merged onto the server document', async () => {
    vi.useFakeTimers();
    const server = fakeApi({ version: 1, other: 'kept' });
    server.holdGet();
    const store = new UserSettingsStore(server.api);

    store.setSection('fieldList', { grouping: 'type' });
    const disposed = store.dispose();
    server.releaseGet();
    await disposed;

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toEqual({ version: 1, other: 'kept', fieldList: { grouping: 'type' } });
  });

  it('accepts no further writes once disposed', async () => {
    vi.useFakeTimers();
    const server = fakeApi();
    const store = new UserSettingsStore(server.api);
    await store.hydrate();
    await store.dispose();

    store.setSection('fieldList', { grouping: 'type' });
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS * 2);

    expect(server.puts).toHaveLength(0);
  });

  it('reset drops local state without sending, so the next identity starts clean', async () => {
    vi.useFakeTimers();
    const server = fakeApi({ version: 1, mine: 'user-1' });
    const store = new UserSettingsStore(server.api);
    await store.hydrate();

    store.setSection('fieldList', { grouping: 'type' });
    store.reset();
    await vi.advanceTimersByTimeAsync(USER_SETTINGS_DEBOUNCE_MS * 2);

    expect(server.puts).toHaveLength(0);
    expect(store.document).toEqual({ version: 1 });
    expect(store.store.getState().status).toBe('idle');
  });
});

describe('UserSettingsStore document shape', () => {
  it('falls back to the versioned empty document for a non-object stored value', async () => {
    const server = fakeApi([] as unknown as RcdUserSettingsDoc);
    const store = new UserSettingsStore(server.api);

    await store.hydrate();

    expect(store.document).toEqual({ version: 1 });
  });

  it('stamps a version onto a document that arrived without one', async () => {
    const server = fakeApi({ fieldList: { grouping: 'type' } } as unknown as RcdUserSettingsDoc);
    const store = new UserSettingsStore(server.api);

    await store.hydrate();

    expect(store.document.version).toBe(1);
    expect(store.section('fieldList', {})).toEqual({ grouping: 'type' });
  });

  it('section returns the fallback before hydration and for an absent key', () => {
    const server = fakeApi();
    const store = new UserSettingsStore(server.api);

    expect(store.section('fieldList', { grouping: 'table' })).toEqual({ grouping: 'table' });
    expect(store.section('measures', [])).toEqual([]);
  });
});
