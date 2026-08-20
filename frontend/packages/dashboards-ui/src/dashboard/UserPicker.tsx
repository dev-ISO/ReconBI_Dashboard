import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, UserRound, X } from 'lucide-react';
import type { RcdUser } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdInput } from '../primitives';

/**
 * Candidate rows rendered at once. The list scrolls (max-h-40), so the cap is
 * about render cost, not UX; when more users match, a "Showing N of M" line
 * says so instead of silently truncating (the old cap of 8 made mid-sized
 * directories look incomplete).
 */
export const CANDIDATE_CAP = 50;

/** One current selection, rendered as a removable chip above the candidates. */
export interface UserPickerChip {
  /** Identity — must match what `keyOf` returns so the row stops re-offering it. */
  key: string;
  label: string;
  /** Native tooltip (the full address, the display name, whatever is elided). */
  title?: string;
  /**
   * Selection the directory cannot vouch for — a saved recipient with no
   * matching user (contractor, distribution list). Flagged, NEVER dropped.
   */
  unknown?: boolean;
}

export interface UserPickerProps {
  /**
   * Resets and (re)loads on each `false -> true` flip, for pickers that live
   * inside an always-mounted dialog. Callers that mount/unmount with their
   * form leave it at the default.
   */
  open?: boolean;
  /** Field label above the search box. */
  label: ReactNode;
  /** aria-label of the search input (the label element is not a `for` target). */
  searchAriaLabel: string;
  placeholder?: string;
  /** Shown INSTEAD of the search box when the host has no directory configured. */
  emptyDirectoryNote: ReactNode;
  /** Keys already spoken for (existing rows + current chips); filtered out of candidates. */
  takenKeys: ReadonlySet<string>;
  /**
   * The identity this picker selects BY: user id for sharing, email address for
   * recipients. `null` = this row cannot be picked (a directory that exposes no
   * email cannot feed an address-based selection) — rendered disabled, never
   * pushed as a null.
   */
  keyOf: (user: RcdUser) => string | null;
  /** Why a `keyOf === null` row is disabled. */
  disabledRowHint?: string;
  onPick: (user: RcdUser) => void;
  chips: UserPickerChip[];
  onRemoveChip: (chip: UserPickerChip) => void;
  /** Defaults to ShareDialog's original wording. */
  removeChipLabel?: (chip: UserPickerChip) => string;
  /** Right-hand suffix of a candidate row; defaults to the user's email. */
  rowSuffix?: (user: RcdUser) => ReactNode;
  noMatchNote?: string;
  /**
   * Every successful directory response (`unfiltered` = the whole directory,
   * not a query's hits). Lets a caller learn which of ITS values the directory
   * actually knows — the subscription form flags the rest rather than dropping
   * them.
   */
  onDirectory?: (users: RcdUser[], unfiltered: boolean) => void;
}

/**
 * Searchable directory multi-select: debounced search over the host's user
 * directory, chips for the current selection, and a capped candidate list with
 * empty/error/no-match states.
 *
 * Extracted verbatim from ShareDialog (which selects by user id) so the
 * subscription editor can select by EMAIL against the same directory — the two
 * differ only in `keyOf`, the row suffix and the chip vocabulary. Free typing
 * is not offered: whatever the caller cannot find here, it cannot add here.
 */
export function UserPicker({
  open = true,
  label,
  searchAriaLabel,
  placeholder = 'Search by username or email',
  emptyDirectoryNote,
  takenKeys,
  keyOf,
  disabledRowHint,
  onPick,
  chips,
  onRemoveChip,
  removeChipLabel,
  rowSuffix,
  noMatchNote = 'No people match — search by username or email address.',
  onDirectory,
}: UserPickerProps) {
  const runtime = useRuntime();

  /** Directory results for the current query; null until the first load. */
  const [users, setUsers] = useState<RcdUser[] | null>(null);
  /** True when the UNFILTERED first fetch returns [] (not configured). */
  const [directoryEmpty, setDirectoryEmpty] = useState(false);
  const [query, setQuery] = useState('');
  /** Non-null after the freshest search request failed (cleared on success). */
  const [searchError, setSearchError] = useState<string | null>(null);

  /**
   * Directory-search sequencing: each issued search takes a ticket; only the
   * freshest ticket's response may land, so an older slow response can never
   * overwrite a newer query's results. `searched` marks that a non-initial
   * search actually ran — the debounced effect's mount run (query still '') is
   * skipped entirely, because the open effect below already fetched the
   * unfiltered directory once.
   */
  const searchSeqRef = useRef(0);
  const searchedRef = useRef(false);
  /** Latest callback without making the fetch effects depend on identity. */
  const onDirectoryRef = useRef(onDirectory);
  onDirectoryRef.current = onDirectory;

  // (Re)load the unfiltered directory on each open.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let cancelled = false;
    searchSeqRef.current++;
    searchedRef.current = false;
    setQuery('');
    setSearchError(null);
    runtime.api
      .listUsers(undefined, controller.signal)
      .then((directory) => {
        if (cancelled) return;
        setUsers(directory);
        setDirectoryEmpty(directory.length === 0);
        onDirectoryRef.current?.(directory, true);
      })
      .catch(() => {
        // An aborted request is this effect tearing itself down, not a failure.
        if (!cancelled) setSearchError('Could not load the user directory.');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, runtime]);

  // Debounced directory search (skipped entirely when unconfigured). The
  // initial empty-query run duplicates the open effect's unfiltered fetch, so
  // it is skipped until a real search happened; clearing the box after that
  // re-fetches the unfiltered list as before.
  useEffect(() => {
    if (!open || directoryEmpty) return;
    const q = query.trim();
    if (q === '' && !searchedRef.current) return;
    searchedRef.current = true;
    const seq = ++searchSeqRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      runtime.api
        .listUsers(q === '' ? undefined : q, controller.signal)
        .then((result) => {
          if (seq === searchSeqRef.current) {
            setUsers(result);
            setSearchError(null);
            onDirectoryRef.current?.(result, q === '');
          }
        })
        .catch(() => {
          // The previous results stay on screen (a failed keystroke should
          // degrade, not blank the list) — but say so: silence here made a
          // failed search indistinguishable from "no results". The ticket
          // guard applies to failures too: only the freshest may complain,
          // and an abort has already advanced the ticket.
          if (seq === searchSeqRef.current) setSearchError('Search failed — try again.');
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, directoryEmpty, query, runtime]);

  /**
   * Directory hits not already taken (uncapped; render cap below). A row with
   * no key can never be "taken" — it stays listed, disabled, so an entry the
   * directory cannot address is visible rather than silently filtered away.
   */
  const matching = useMemo(
    () =>
      (users ?? []).filter((user) => {
        const key = keyOf(user);
        return key === null || !takenKeys.has(key);
      }),
    [users, takenKeys, keyOf],
  );
  const candidates = matching.slice(0, CANDIDATE_CAP);

  return (
    <div className="flex flex-col gap-2">
      {directoryEmpty ? (
        emptyDirectoryNote
      ) : (
        <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
          {label}
          <div className="relative">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-rcd-muted"
            />
            <RcdInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // Names what the directory can actually match — typing a
              // person's real name finds nothing when the directory
              // only indexes usernames and emails.
              placeholder={placeholder}
              aria-label={searchAriaLabel}
              className="w-full pl-8"
            />
          </div>
        </label>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.key}
              title={chip.title}
              className={`inline-flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 text-xs font-medium shadow-[var(--rcd-shadow-1)] ${
                chip.unknown
                  ? 'border-dashed border-[var(--rcd-status-warn)] bg-rcd-bg text-rcd-text-2'
                  : 'border-rcd-border bg-rcd-surface text-rcd-text'
              }`}
            >
              {chip.label}
              <button
                type="button"
                aria-label={
                  removeChipLabel?.(chip) ?? `Remove ${chip.label} from the selection`
                }
                onClick={() => onRemoveChip(chip)}
                className="rounded p-0.5 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {!directoryEmpty && (
        <>
          {candidates.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-rcd-border">
              {candidates.map((user) => {
                const key = keyOf(user);
                const suffix = rowSuffix ? rowSuffix(user) : user.email;
                return (
                  <button
                    key={user.id}
                    type="button"
                    disabled={key === null}
                    title={key === null ? disabledRowHint : undefined}
                    onClick={() => {
                      if (key !== null) onPick(user);
                    }}
                    className="flex w-full items-center gap-2 border-b border-rcd-border px-2.5 py-1.5 text-left last:border-b-0 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-white/10 dark:disabled:hover:bg-transparent"
                  >
                    <UserRound size={14} aria-hidden className="shrink-0 text-rcd-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm text-rcd-text">
                      {user.displayName}
                    </span>
                    {key === null && disabledRowHint !== undefined ? (
                      <span className="shrink-0 truncate text-xs text-rcd-muted">
                        {disabledRowHint}
                      </span>
                    ) : (
                      suffix != null &&
                      suffix !== '' && (
                        <span className="shrink-0 truncate text-xs text-rcd-muted">{suffix}</span>
                      )
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {matching.length > CANDIDATE_CAP && (
            <p className="text-xs text-rcd-muted">
              Showing {CANDIDATE_CAP} of {matching.length} — keep typing to narrow.
            </p>
          )}
          {searchError && (
            <p className="text-xs text-[var(--rcd-status-critical)]" role="alert">
              {searchError}
            </p>
          )}
          {candidates.length === 0 && query.trim() !== '' && !searchError && (
            <p className="text-xs text-rcd-muted">{noMatchNote}</p>
          )}
        </>
      )}
    </div>
  );
}
