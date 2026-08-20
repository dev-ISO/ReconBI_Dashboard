import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DashboardsApi, RcdUserSettingsDoc } from '../api/DashboardsApi';
import { rcdErrorMessage } from '../api/fetcher';
import type { AsyncStatus } from './modelStore';

/** Document version this build writes. */
export const USER_SETTINGS_VERSION = 1;

/**
 * Debounce for the server write. Matches the tracker host's own UI-settings
 * sync (useUiSettingsHydration): long enough that dragging a slider or
 * expanding a dozen folders costs ONE request, short enough that closing the
 * tab a few seconds later still has something to flush.
 */
export const USER_SETTINGS_DEBOUNCE_MS = 6_000;

export interface UserSettingsState {
  /** Hydration status. Writes are accepted in every state (see `update`). */
  status: AsyncStatus;
  /** The whole document, always present — the empty default before hydration. */
  doc: RcdUserSettingsDoc;
  /** True while a local change has not reached the server yet. */
  dirty: boolean;
  /** Last hydrate/save failure, cleared by the next success. */
  error: string | null;
}

export interface UserSettingsStoreOptions {
  /** Override the write debounce (tests, hosts with a chattier UX). */
  debounceMs?: number;
}

const emptyDoc = (): RcdUserSettingsDoc => ({ version: USER_SETTINGS_VERSION });

const initialState = (): UserSettingsState => ({
  status: 'idle',
  doc: emptyDoc(),
  dirty: false,
  error: null,
});

/**
 * The per-user preference store: ONE server-side document per user, followed to
 * any machine. Shared infrastructure — the field list's organization lives here,
 * and personal measures will too — so it stays deliberately generic: it moves
 * and merges SECTIONS, and never interprets one.
 *
 * Contract, in the order it matters:
 *  - HYDRATE ON FIRST NEED. `hydrate()` is idempotent and concurrent callers
 *    share one in-flight request. Nothing hydrates at construction: a host that
 *    never touches preferences never issues the request.
 *  - WRITES BEFORE HYDRATION ARE NOT LOST. A mutation made while the document
 *    is still loading is recorded and REPLAYED on top of the server document
 *    when it lands, so an early UI interaction neither clobbers the stored
 *    document nor is dropped by it.
 *  - DEBOUNCED, COALESCED WRITE. Rapid changes collapse into one PUT.
 *  - LAST-WRITE-WINS THE WHOLE BLOB. The document is one user's private state;
 *    the loser of a two-tab race is that user's other tab, so a field-level
 *    merge would only invent conflicts. Sections this build does not know about
 *    still ride through untouched.
 *  - NEVER LOSE A PENDING WRITE. `flush()` sends immediately; `dispose()`
 *    flushes on the way out (the host wires it to unmount/logout, the way the
 *    tracker flushes its UI settings on logout).
 */
export class UserSettingsStore {
  readonly store: StoreApi<UserSettingsState>;

  private readonly debounceMs: number;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Shared by every concurrent hydrate() caller; null once settled. */
  private hydrating: Promise<void> | null = null;

  /** True once the server document (or its absence) has been observed. */
  private hydrated = false;

  /**
   * Mutations applied before hydration finished. Replayed onto the server
   * document so an early edit survives the response landing on top of it.
   */
  private preHydrationMutations: ((doc: RcdUserSettingsDoc) => RcdUserSettingsDoc)[] = [];

  /** Serializes PUTs so a debounced write and a flush cannot interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  /** Serialized document as the server last confirmed it; '' until known. */
  private lastSyncedJson = '';

  private disposed = false;

  constructor(
    private readonly api: DashboardsApi,
    options?: UserSettingsStoreOptions,
  ) {
    this.store = createStore<UserSettingsState>(() => initialState());
    this.debounceMs = options?.debounceMs ?? USER_SETTINGS_DEBOUNCE_MS;
  }

  private set(patch: Partial<UserSettingsState>): void {
    this.store.setState(patch);
  }

  private get state(): UserSettingsState {
    return this.store.getState();
  }

  /** The whole document as currently known locally. */
  get document(): RcdUserSettingsDoc {
    return this.state.doc;
  }

  /**
   * Loads the document once. Safe to call from every consumer on mount —
   * repeat calls join the in-flight request or return immediately.
   *
   * A failure is recorded and NOT retried on a timer (preferences are not worth
   * a retry storm); the next explicit hydrate() tries again. Crucially, a
   * failed hydration NEVER unblocks the write path: PUT replaces the whole
   * document, so writing a locally-assembled one on top of a server document
   * this client failed to read would destroy sections it never saw.
   */
  hydrate(): Promise<void> {
    if (this.hydrated || this.disposed) return Promise.resolve();
    if (this.hydrating) return this.hydrating;

    this.set({ status: 'loading' });
    const inFlight = this.api
      .getUserSettings()
      .then((result) => {
        const base = normalizeDoc(result.settings);
        // Replay anything the user changed while this was in flight, so the
        // server document cannot silently undo an edit already on screen.
        const doc = this.preHydrationMutations.reduce((acc, mutate) => mutate(acc), base);
        const replayed = this.preHydrationMutations.length > 0;
        this.preHydrationMutations = [];
        this.hydrated = true;
        this.lastSyncedJson = JSON.stringify(base);
        this.set({ status: 'ok', doc, error: null, dirty: replayed });
        if (replayed) this.armSave();
      })
      .catch((error: unknown) => {
        this.set({ status: 'error', error: rcdErrorMessage(error) });
      })
      .finally(() => {
        if (this.hydrating === inFlight) this.hydrating = null;
      });

    this.hydrating = inFlight;
    return inFlight;
  }

  /**
   * Reads one section, yielding `fallback` when it is absent — which is also
   * what an unhydrated store returns, so a consumer can read before hydration
   * without a special case.
   *
   * The cast is UNCHECKED on purpose: this store moves sections, it does not
   * define them. The document is written by other machines and older or newer
   * builds, so the OWNING feature must sanitize what it gets back, exactly as
   * the tracker host's per-view column-preference sanitizers do.
   */
  section<T>(key: string, fallback: T): T {
    const value = this.state.doc[key];
    return value === undefined || value === null ? fallback : (value as T);
  }

  /** Replaces one section wholesale and schedules the write. */
  setSection(key: string, value: unknown): void {
    this.update((doc) => ({ ...doc, [key]: value }));
  }

  /**
   * Applies a mutation to the whole document. The mutation MUST be pure and
   * return a new object — the store hands the same document to every consumer.
   * Kicks off hydration if it has not started, so a consumer that only ever
   * writes still ends up merging onto the stored document.
   */
  update(mutate: (doc: RcdUserSettingsDoc) => RcdUserSettingsDoc): void {
    if (this.disposed) return;

    if (!this.hydrated) {
      // Queued, not written: `save` refuses to PUT without a hydrated base.
      this.preHydrationMutations.push(mutate);
      this.set({ doc: normalizeDoc(mutate(this.state.doc)), dirty: true });
      void this.hydrate();
      return;
    }

    const next = normalizeDoc(mutate(this.state.doc));
    if (JSON.stringify(next) === JSON.stringify(this.state.doc)) return;
    this.set({ doc: next, dirty: true });
    this.armSave();
  }

  /** (Re)starts the debounce window — the trailing edge is the only send. */
  private armSave(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, this.debounceMs);
  }

  /**
   * Sends the pending document NOW and resolves when it has landed. Cancels the
   * debounce, so a flush immediately after a change costs exactly one request.
   * If hydration is still in flight it is awaited FIRST, so an edit made in the
   * first moments of a session is merged onto the stored document rather than
   * dropped by a flush that raced it.
   *
   * Never rejects: a failed preference save must not break a logout or an
   * unmount, and the document stays dirty so the next write retries it.
   */
  async flush(options?: { keepalive?: boolean }): Promise<void> {
    this.cancelTimer();
    if (!this.hydrated && this.hydrating) {
      await this.hydrating;
      // The replay above arms its own debounce; this flush supersedes it.
      this.cancelTimer();
    }
    return this.save(options);
  }

  private cancelTimer(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private save(options?: { keepalive?: boolean }): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      if (!this.state.dirty) return;
      // Without a hydrated base a PUT would replace the stored document with
      // one assembled from the empty default — destroying every section this
      // client never managed to read. Stay dirty and wait instead.
      if (!this.hydrated) return;
      const doc = this.state.doc;
      const json = JSON.stringify(doc);
      if (json === this.lastSyncedJson) {
        this.set({ dirty: false });
        return;
      }

      try {
        const result = await this.api.putUserSettings(doc, options);
        this.lastSyncedJson = JSON.stringify(normalizeDoc(result.settings));
        // Only clear `dirty` if nothing changed while the request was in
        // flight — otherwise the newer edit would never be sent.
        if (JSON.stringify(this.state.doc) === json) this.set({ dirty: false, error: null });
      } catch (error: unknown) {
        this.set({ error: rcdErrorMessage(error) });
      }
    });
    return this.writeChain;
  }

  /**
   * Final flush + teardown. The host calls this on unmount and on logout; after
   * it, mutations are ignored and no timer can fire. `keepalive` rides fetch's
   * keepalive so a pagehide flush can outlive the document.
   */
  dispose(options?: { keepalive?: boolean }): Promise<void> {
    if (this.disposed) return this.writeChain;
    const pending = this.flush(options);
    this.disposed = true;
    return pending;
  }

  /**
   * Drops all local state WITHOUT sending — for an identity change, where the
   * next user must not inherit (or overwrite with) the previous one's document.
   * Flush first if the outgoing user's edits still matter.
   */
  reset(): void {
    this.cancelTimer();
    this.hydrating = null;
    this.hydrated = false;
    this.preHydrationMutations = [];
    this.lastSyncedJson = '';
    this.disposed = false;
    this.store.setState(initialState(), true);
  }
}

/**
 * Guarantees the two things every consumer may assume about the document: it is
 * an object, and it carries a numeric `version`. Everything else — including
 * sections written by a newer build — passes through untouched, because a write
 * replaces the whole blob and anything dropped here is destroyed on the server.
 */
const normalizeDoc = (value: unknown): RcdUserSettingsDoc => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyDoc();
  const doc = value as RcdUserSettingsDoc;
  return typeof doc.version === 'number'
    ? doc
    : { ...doc, version: USER_SETTINGS_VERSION };
};
