/**
 * THE FIELD LIST'S PER-USER PREFERENCES — how it is grouped, what is open, and
 * what is hidden. Stored server-side in the per-user settings document
 * (section "fieldList"), so they follow the user to another machine and affect
 * nobody else. Dashboard-agnostic by construction: nothing here is keyed by
 * dashboard or by model.
 *
 * WHY THIS EXISTS AT ALL. Expansion state used to be plain component state,
 * seeded once at mount and thrown away every time the builder modal closed.
 * Collapse the twelve tables you are not using, edit a chart, come back — all
 * twelve are open again. Of everything in this wave that is the change a daily
 * user feels, so the keys below are chosen to be STABLE across sessions: a
 * table key, a folder path, a scope id, a type name. Never an array index, and
 * never a label (a friendlyName edit must not silently reset a preference).
 *
 * DEGRADATION. Every read goes through the settings store's LOCAL document and
 * every write through its debounce. If the server is unreachable the store
 * still holds the change in memory, so the list behaves exactly as it did
 * before this wave — organized, just not remembered. Nothing here can block
 * the builder from opening, and nothing awaits a request.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { UserSettingsStore } from '@recon/dashboards-core';

/** Section key inside the per-user settings document. */
export const FIELD_LIST_SETTINGS_SECTION = 'fieldList';

/** How the field list arranges what it offers. Never WHICH fields it offers. */
export type FieldGrouping = 'table' | 'category' | 'type';

export const FIELD_GROUPINGS: readonly FieldGrouping[] = ['table', 'category', 'type'];

export const fieldGroupingLabel = (grouping: FieldGrouping): string =>
  grouping === 'table' ? 'Table' : grouping === 'category' ? 'Category' : 'Type';

export const fieldGroupingHint = (grouping: FieldGrouping): string => {
  switch (grouping) {
    case 'table':
      return 'Group fields by the table they come from.';
    case 'category':
      return 'Group fields by the category the model gives them.';
    case 'type':
      return 'Group fields by what they are: text, number, date, yes/no, measure.';
  }
};

export interface FieldListPrefs {
  grouping: FieldGrouping;
  /** Groups the user opened that default CLOSED. */
  expanded: string[];
  /** Groups the user closed that default OPEN. */
  collapsed: string[];
  /** Groups hidden from the picker entirely (restorable — never destructive). */
  hidden: string[];
}

/**
 * Expansion is stored as TWO explicit lists rather than one "open" set,
 * because the default is not uniform: a small model opens every table, a large
 * one opens only the first, folders open, and a group the user has never
 * touched should keep following that default even as the model grows. Only a
 * deliberate toggle is recorded, and a toggle back to the default is UNrecorded
 * again, so the stored document stays small and an improved default still
 * reaches everyone who never overrode it.
 */
export const defaultFieldListPrefs = (): FieldListPrefs => ({
  grouping: 'table',
  expanded: [],
  collapsed: [],
  hidden: [],
});

/**
 * Upper bound per list. The settings document has a server-side byte cap and
 * one user could otherwise accumulate keys from every model they ever opened.
 * Oldest entries fall off the front — the recent ones are the ones in use.
 */
const MAX_KEYS = 400;

const capped = (keys: string[]): string[] =>
  keys.length <= MAX_KEYS ? keys : keys.slice(keys.length - MAX_KEYS);

const sanitizeKeys = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '') seen.add(entry);
  }
  return capped([...seen]);
};

/**
 * The settings store deliberately does NOT interpret sections — it moves them.
 * So the owning feature sanitizes, because the document may have been written
 * by another machine, an older build, or a newer one. Anything unrecognized
 * degrades to the default rather than throwing: a corrupt preference must cost
 * a preference, never the builder.
 */
export const readFieldListPrefs = (raw: unknown): FieldListPrefs => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultFieldListPrefs();
  const value = raw as Record<string, unknown>;
  const grouping = value.grouping;
  return {
    grouping:
      typeof grouping === 'string' && (FIELD_GROUPINGS as readonly string[]).includes(grouping)
        ? (grouping as FieldGrouping)
        : 'table',
    expanded: sanitizeKeys(value.expanded),
    collapsed: sanitizeKeys(value.collapsed),
    hidden: sanitizeKeys(value.hidden),
  };
};

const withKey = (keys: string[], key: string, present: boolean): string[] => {
  const has = keys.includes(key);
  if (has === present) return keys;
  return present ? capped([...keys, key]) : keys.filter((entry) => entry !== key);
};

/** Records an explicit open/closed choice, or clears it when it matches the default. */
export const setGroupOpen = (
  prefs: FieldListPrefs,
  key: string,
  open: boolean,
  defaultOpen: boolean,
): FieldListPrefs => {
  const atDefault = open === defaultOpen;
  return {
    ...prefs,
    expanded: withKey(prefs.expanded, key, !atDefault && open),
    collapsed: withKey(prefs.collapsed, key, !atDefault && !open),
  };
};

export const setGroupHidden = (
  prefs: FieldListPrefs,
  key: string,
  hidden: boolean,
): FieldListPrefs => ({ ...prefs, hidden: withKey(prefs.hidden, key, hidden) });

/** Everything the field list needs to read and change its preferences. */
export interface FieldListPrefsController {
  prefs: FieldListPrefs;
  grouping: FieldGrouping;
  setGrouping: (grouping: FieldGrouping) => void;
  /** Resolved open state: an explicit choice, else the caller's default. */
  isOpen: (key: string, defaultOpen: boolean) => boolean;
  setOpen: (key: string, open: boolean, defaultOpen: boolean) => void;
  isHidden: (key: string) => boolean;
  setHidden: (key: string, hidden: boolean) => void;
  /** Un-hides a specific set — the "Show all" on the restore affordance. */
  showAll: (keys: readonly string[]) => void;
}

const NOOP_UNSUBSCRIBE = () => {};
const noopSubscribe = () => NOOP_UNSUBSCRIBE;
const noSection = (): unknown => undefined;

/**
 * Binds the field list to the per-user settings store. `settings` may be null
 * — a host that mounts no settings store (or a test) then gets the same
 * controller backed by component state, which is exactly the pre-wave
 * behaviour and is what a settings outage effectively degrades to as well.
 */
export function useFieldListPrefs(settings: UserSettingsStore | null): FieldListPrefsController {
  const [local, setLocal] = useState<FieldListPrefs>(defaultFieldListPrefs);

  // Lazily, and only because something is actually reading preferences. A host
  // that never opens the builder never issues the request.
  useEffect(() => {
    if (settings) void settings.hydrate();
  }, [settings]);

  const subscribe = useMemo(
    () => (settings ? (onChange: () => void) => settings.store.subscribe(onChange) : noopSubscribe),
    [settings],
  );
  const getSection = useMemo(
    () =>
      settings
        ? () => settings.store.getState().doc[FIELD_LIST_SETTINGS_SECTION]
        : noSection,
    [settings],
  );
  // getServerSnapshot === getSnapshot: the document is per-user client state,
  // and SSR simply sees the (empty) default.
  const raw = useSyncExternalStore(subscribe, getSection, getSection);

  const stored = useMemo(() => readFieldListPrefs(raw), [raw]);
  const prefs = settings ? stored : local;

  const write = useCallback(
    (mutate: (current: FieldListPrefs) => FieldListPrefs) => {
      if (settings) {
        // Re-read inside the mutation so a burst of toggles composes on the
        // freshest document rather than on the render's snapshot.
        settings.update((doc) => ({
          ...doc,
          [FIELD_LIST_SETTINGS_SECTION]: mutate(readFieldListPrefs(doc[FIELD_LIST_SETTINGS_SECTION])),
        }));
      } else {
        setLocal(mutate);
      }
    },
    [settings],
  );

  const expanded = useMemo(() => new Set(prefs.expanded), [prefs.expanded]);
  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);
  const hidden = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);

  const isOpen = useCallback(
    (key: string, defaultOpen: boolean) =>
      expanded.has(key) ? true : collapsed.has(key) ? false : defaultOpen,
    [expanded, collapsed],
  );

  return useMemo(
    () => ({
      prefs,
      grouping: prefs.grouping,
      setGrouping: (grouping: FieldGrouping) => write((current) => ({ ...current, grouping })),
      isOpen,
      setOpen: (key: string, open: boolean, defaultOpen: boolean) =>
        write((current) => setGroupOpen(current, key, open, defaultOpen)),
      isHidden: (key: string) => hidden.has(key),
      setHidden: (key: string, next: boolean) =>
        write((current) => setGroupHidden(current, key, next)),
      showAll: (keys: readonly string[]) =>
        write((current) => ({
          ...current,
          hidden: current.hidden.filter((key) => !keys.includes(key)),
        })),
    }),
    [prefs, isOpen, hidden, write],
  );
}
