import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Search, UserRound, X } from 'lucide-react';
import { rcdErrorMessage, type RcdUser } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect, RcdSpinner } from '../primitives';

export interface ShareDialogProps {
  open: boolean;
  dashboardId: number;
  onClose: () => void;
  /**
   * Shows the "Everyone (publish)" toggle bound to the legacy isShared flag.
   * Admin-gated server-side (ICurrentUserProvider.CanManageShared) — hosts
   * without an admin signal may pass owner-or-admin and let the server refuse.
   */
  canPublish?: boolean;
  /** Current publish state (drives the toggle's initial value). */
  isShared?: boolean;
  /** Called after shares (and any publish change) saved successfully. */
  onSaved?: () => void;
}

/**
 * DATA-DRIVEN flag descriptors: THE single place a grant flag exists in this
 * dialog. Adding a right = adding one entry — the checkboxes (template + per
 * row), the view/edit split, the wire payload and the row mapping all iterate
 * this array. Keys are the wire names (DashboardShareInput fields).
 */
const PERMISSION_FLAGS = [
  { key: 'canEditLayout', label: 'Layout', title: 'Doc settings; add/edit text, image, button and slicer tiles' },
  { key: 'canManagePages', label: 'Pages', title: 'Add, rename, reorder and recolor pages' },
  { key: 'canEditCharts', label: 'Charts', title: 'Add chart tiles; edit chart fields and formatting (renaming stays owner-only)' },
  { key: 'canMoveTiles', label: 'Move/resize', title: 'Arrange tiles: move and resize them on the grid' },
  { key: 'canDeleteContent', label: 'Delete', title: 'Remove tiles and pages (on top of the matching edit right)' },
] as const;

type PermissionKey = (typeof PERMISSION_FLAGS)[number]['key'];

type PermissionFlags = Record<PermissionKey, boolean>;

const allFlags = (value: boolean): PermissionFlags =>
  Object.fromEntries(PERMISSION_FLAGS.map((flag) => [flag.key, value])) as PermissionFlags;

/** One editable grant row (existing share or freshly picked user). */
interface ShareRow extends PermissionFlags {
  userId: string;
  displayName: string | null;
  /** "granted by X on date" (existing rows only; fresh picks have neither). */
  grantedByDisplayName?: string | null;
  createdAtUtc?: string;
}

/** All flags false = view-only. */
const rowCanEdit = (row: ShareRow): boolean => PERMISSION_FLAGS.some((flag) => row[flag.key]);

/** The bulk "apply to selected" permission template. */
interface PermissionTemplate {
  mode: 'view' | 'edit';
  flags: PermissionFlags;
}

const DEFAULT_TEMPLATE: PermissionTemplate = { mode: 'view', flags: allFlags(true) };

/**
 * Candidate rows rendered at once. The list scrolls (max-h-40), so the cap is
 * about render cost, not UX; when more users match, a "Showing N of M" line
 * says so instead of silently truncating (the old cap of 8 made mid-sized
 * directories look incomplete).
 */
const CANDIDATE_CAP = 50;

const templatePermissions = (template: PermissionTemplate): PermissionFlags =>
  template.mode === 'view' ? allFlags(false) : { ...template.flags };

/** Shared look of the granular permission checkboxes (one per PERMISSION_FLAGS entry). */
function PermissionChecks({
  value,
  onChange,
  idPrefix,
}: {
  value: PermissionFlags;
  onChange: (patch: Partial<PermissionFlags>) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {PERMISSION_FLAGS.map((flag) => (
        <label
          key={flag.key}
          htmlFor={`${idPrefix}-${flag.key}`}
          title={flag.title}
          className="flex items-center gap-1.5 text-xs text-rcd-text-2"
        >
          <input
            id={`${idPrefix}-${flag.key}`}
            type="checkbox"
            checked={value[flag.key]}
            onChange={(event) => onChange({ [flag.key]: event.target.checked })}
            className="accent-[var(--rcd-accent)]"
          />
          {flag.label}
        </label>
      ))}
    </div>
  );
}

/** Tolerant UTC parse (server timestamps come zoneless), for the granted-on date. */
const grantedOnText = (iso: string | undefined): string | null => {
  if (!iso) return null;
  const at = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Server grant row → editable dialog row. Absent 0.11.1 flags (older server) read false. */
const toShareRow = (share: {
  userId: string;
  displayName: string | null;
  canEditLayout: boolean;
  canManagePages: boolean;
  canEditCharts: boolean;
  canMoveTiles?: boolean;
  canDeleteContent?: boolean;
  grantedByDisplayName?: string | null;
  grantedByUserId?: string;
  createdAtUtc?: string;
}): ShareRow => ({
  userId: share.userId,
  displayName: share.displayName,
  canEditLayout: share.canEditLayout,
  canManagePages: share.canManagePages,
  canEditCharts: share.canEditCharts,
  canMoveTiles: share.canMoveTiles ?? false,
  canDeleteContent: share.canDeleteContent ?? false,
  grantedByDisplayName: share.grantedByDisplayName ?? share.grantedByUserId ?? null,
  ...(share.createdAtUtc !== undefined ? { createdAtUtc: share.createdAtUtc } : {}),
});

/**
 * Share management for one dashboard (owner/admin): searchable multi-select
 * user picker with chips, per-user view/edit permission rows (edit expands
 * Layout/Pages/Charts checkboxes), bulk apply-on-add, removal of existing
 * grants, and — for admins — the legacy "Everyone (publish)" toggle. Save
 * issues ONE PUT replacing the full grant set.
 */
export function ShareDialog({
  open,
  dashboardId,
  onClose,
  canPublish = false,
  isShared,
  onSaved,
}: ShareDialogProps) {
  const runtime = useRuntime();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<ShareRow[]>([]);
  /** Directory results for the current query; null until the first load. */
  const [users, setUsers] = useState<RcdUser[] | null>(null);
  /** True when the UNFILTERED directory came back empty (not configured). */
  const [directoryEmpty, setDirectoryEmpty] = useState(false);
  const [query, setQuery] = useState('');
  /** Non-null after the freshest search request failed (cleared on success). */
  const [searchError, setSearchError] = useState<string | null>(null);
  /** Picked-but-not-yet-added users (the chips). */
  const [picked, setPicked] = useState<RcdUser[]>([]);
  const [template, setTemplate] = useState<PermissionTemplate>(DEFAULT_TEMPLATE);
  const [publish, setPublish] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Directory-search sequencing (finding 16): each issued search takes a
   * ticket; only the freshest ticket's response may land, so an older slow
   * response can never overwrite a newer query's results. `searched` marks
   * that a non-initial search actually ran — the debounced effect's mount run
   * (query still '') is skipped entirely, because the open effect below
   * already fetched the unfiltered directory once.
   */
  const searchSeqRef = useRef(0);
  const searchedRef = useRef(false);

  // (Re)load shares + directory on each open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    searchSeqRef.current++;
    searchedRef.current = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setSearchError(null);
    setRows([]);
    setPicked([]);
    setQuery('');
    setTemplate(DEFAULT_TEMPLATE);
    setPublish(isShared ?? false);
    Promise.all([runtime.dashboards.listShares(dashboardId), runtime.dashboards.listUsers()])
      .then(([shares, directory]) => {
        if (cancelled) return;
        setRows(shares.map(toShareRow));
        setUsers(directory);
        setDirectoryEmpty(directory.length === 0);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(rcdErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, dashboardId, runtime, isShared]);

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
    const timer = window.setTimeout(() => {
      runtime.dashboards
        .listUsers(q === '' ? undefined : q)
        .then((result) => {
          if (seq === searchSeqRef.current) {
            setUsers(result);
            setSearchError(null);
          }
        })
        .catch(() => {
          // The previous results stay on screen (a failed keystroke should
          // degrade, not blank the list) — but say so: silence here made a
          // failed search indistinguishable from "no results". The ticket
          // guard applies to failures too: only the freshest may complain.
          if (seq === searchSeqRef.current) setSearchError('Search failed — try again.');
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, directoryEmpty, query, runtime]);

  /** Directory hits not already granted or picked (uncapped; render cap below). */
  const matching = useMemo(() => {
    const taken = new Set([...rows.map((r) => r.userId), ...picked.map((u) => u.id)]);
    return (users ?? []).filter((user) => !taken.has(user.id));
  }, [users, rows, picked]);
  const candidates = matching.slice(0, CANDIDATE_CAP);

  const addPicked = () => {
    if (picked.length === 0) return;
    const perms = templatePermissions(template);
    setRows((prev) => [
      ...prev,
      ...picked
        .filter((user) => !prev.some((row) => row.userId === user.id))
        .map((user) => ({ userId: user.id, displayName: user.displayName, ...perms })),
    ]);
    setPicked([]);
  };

  const patchRow = (userId: string, patch: Partial<ShareRow>) => {
    setRows((prev) => prev.map((row) => (row.userId === userId ? { ...row, ...patch } : row)));
  };

  /** Re-reads the server's grant rows (partial-failure recovery display). */
  const refreshRows = async () => {
    try {
      const shares = await runtime.dashboards.listShares(dashboardId);
      setRows(shares.map(toShareRow));
      setPicked([]);
    } catch {
      // keep the edited rows; the error message already tells the user what happened
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    // Chips still sitting in the picker are included with the template perms —
    // picking someone and hitting Save should never silently drop them.
    const perms = templatePermissions(template);
    const finalRows = [
      ...rows,
      ...picked
        .filter((user) => !rows.some((row) => row.userId === user.id))
        .map((user) => ({ userId: user.id, displayName: user.displayName, ...perms })),
    ];
    // Publish flips FIRST (finding 13): it is the admin-gated call likeliest
    // to be refused, so failing it saves NOTHING — no half-committed state to
    // explain. If it succeeds and saveShares then fails, the message states
    // exactly what saved and the rows refresh to the server's truth.
    const wantPublishFlip = canPublish && isShared !== undefined && publish !== isShared;
    let publishFlipped = false;
    try {
      if (wantPublishFlip) {
        const ok = await runtime.dashboards.setPublish(publish);
        if (!ok) {
          throw new Error(
            runtime.dashboards.store.getState().error ?? 'The publish change was rejected.',
          );
        }
        publishFlipped = true;
      }
      await runtime.dashboards.saveShares(
        dashboardId,
        finalRows.map((row) => ({
          userId: row.userId,
          // Wire payload straight from the flag descriptors — one source of truth.
          ...(Object.fromEntries(
            PERMISSION_FLAGS.map((flag) => [flag.key, row[flag.key]]),
          ) as PermissionFlags),
        })),
      );
      onSaved?.();
      onClose();
    } catch (error) {
      if (publishFlipped) {
        setSaveError(
          `Publish is now ${publish ? 'ON' : 'OFF'} (that change saved), but the people list did not save: ${rcdErrorMessage(error)}`,
        );
        void refreshRows();
      } else if (wantPublishFlip) {
        setSaveError(`Nothing was saved — the publish change failed: ${rcdErrorMessage(error)}`);
      } else {
        setSaveError(rcdErrorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <RcdDialog
      title="Share dashboard"
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose} disabled={saving}>
            Cancel
          </RcdButton>
          <RcdButton variant="primary" onClick={() => void handleSave()} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </RcdButton>
        </>
      }
    >
      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <RcdSpinner label="Loading sharing…" />
        </div>
      ) : loadError ? (
        <p className="text-sm text-[var(--rcd-status-critical)]" role="alert">
          {loadError}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* -------------------------------------------------- user picker */}
          {directoryEmpty ? (
            <p className="rounded-lg border border-rcd-border bg-rcd-bg px-3 py-2 text-xs text-rcd-muted">
              User directory not configured — people search is unavailable. Existing access can
              still be removed below.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
                Add people
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
                    placeholder="Search by username or email"
                    aria-label="Search people to share with"
                    className="w-full pl-8"
                  />
                </div>
              </label>

              {picked.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {picked.map((user) => (
                    <span
                      key={user.id}
                      className="inline-flex items-center gap-1 rounded-md border border-rcd-border bg-rcd-surface py-0.5 pl-2 pr-1 text-xs font-medium text-rcd-text shadow-[var(--rcd-shadow-1)]"
                    >
                      {user.displayName}
                      <button
                        type="button"
                        aria-label={`Remove ${user.displayName} from the selection`}
                        onClick={() => setPicked((prev) => prev.filter((u) => u.id !== user.id))}
                        className="rounded p-0.5 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {candidates.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-rcd-border">
                  {candidates.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => setPicked((prev) => [...prev, user])}
                      className="flex w-full items-center gap-2 border-b border-rcd-border px-2.5 py-1.5 text-left last:border-b-0 hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <UserRound size={14} aria-hidden className="shrink-0 text-rcd-muted" />
                      <span className="min-w-0 flex-1 truncate text-sm text-rcd-text">
                        {user.displayName}
                      </span>
                      {user.email && (
                        <span className="shrink-0 truncate text-xs text-rcd-muted">{user.email}</span>
                      )}
                    </button>
                  ))}
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
                <p className="text-xs text-rcd-muted">
                  No people match — search by username or email address.
                </p>
              )}

              {/* Bulk template applied to every picked chip on Add. */}
              {picked.length > 0 && (
                <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-rcd-border bg-rcd-bg px-2.5 py-2">
                  <RcdSelect
                    aria-label="Access for the selected people"
                    value={template.mode}
                    onChange={(event) =>
                      setTemplate((prev) => ({ ...prev, mode: event.target.value as 'view' | 'edit' }))
                    }
                  >
                    <option value="view">Can view</option>
                    <option value="edit">Can edit</option>
                  </RcdSelect>
                  {template.mode === 'edit' && (
                    <PermissionChecks
                      idPrefix="rcd-share-template"
                      value={template.flags}
                      onChange={(patch) =>
                        setTemplate((prev) => ({ ...prev, flags: { ...prev.flags, ...patch } }))
                      }
                    />
                  )}
                  <RcdButton size="sm" variant="primary" className="ml-auto" onClick={addPicked}>
                    Add {picked.length === 1 ? '1 person' : `${picked.length} people`}
                  </RcdButton>
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------ current grants */}
          <div className="flex flex-col gap-1">
            <p className="text-sm text-rcd-text-2">People with access</p>
            {rows.length === 0 ? (
              <p className="text-xs text-rcd-muted">Not shared with anyone yet.</p>
            ) : (
              <div className="flex flex-col rounded-lg border border-rcd-border">
                {rows.map((row) => {
                  const grantedOn = grantedOnText(row.createdAtUtc);
                  return (
                    <div
                      key={row.userId}
                      className="flex flex-wrap items-center gap-2 border-b border-rcd-border px-2.5 py-2 last:border-b-0"
                    >
                      <UserRound size={14} aria-hidden className="shrink-0 text-rcd-muted" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-rcd-text" title={row.userId}>
                          {row.displayName ?? row.userId}
                        </span>
                        {/* Grant provenance (existing rows only — fresh picks
                            gain theirs once saved). */}
                        {row.grantedByDisplayName != null && (
                          <span className="truncate text-[11px] text-rcd-muted">
                            granted by {row.grantedByDisplayName}
                            {grantedOn !== null ? ` on ${grantedOn}` : ''}
                          </span>
                        )}
                      </span>
                      <RcdSelect
                        aria-label={`Access for ${row.displayName ?? row.userId}`}
                        value={rowCanEdit(row) ? 'edit' : 'view'}
                        onChange={(event) =>
                          patchRow(row.userId, allFlags(event.target.value === 'edit'))
                        }
                      >
                        <option value="view">Can view</option>
                        <option value="edit">Can edit</option>
                      </RcdSelect>
                      {rowCanEdit(row) && (
                        <PermissionChecks
                          idPrefix={`rcd-share-${row.userId}`}
                          value={row}
                          onChange={(patch) => patchRow(row.userId, patch)}
                        />
                      )}
                      <RcdIconButton
                        aria-label={`Remove access for ${row.displayName ?? row.userId}`}
                        title="Remove access"
                        onClick={() =>
                          setRows((prev) => prev.filter((r) => r.userId !== row.userId))
                        }
                      >
                        <X size={13} />
                      </RcdIconButton>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ------------------------------------------------------ publish */}
          {canPublish && (
            <label className="flex items-start gap-2 border-t border-rcd-border pt-3 text-sm text-rcd-text">
              <input
                type="checkbox"
                checked={publish}
                onChange={(event) => setPublish(event.target.checked)}
                className="mt-0.5 accent-[var(--rcd-accent)]"
              />
              <span className="flex flex-col">
                <span className="flex items-center gap-1.5">
                  <Globe size={13} aria-hidden className="text-rcd-muted" />
                  Everyone (publish)
                </span>
                <span className="text-xs text-rcd-muted">
                  Anyone in the workspace can view this dashboard.
                </span>
              </span>
            </label>
          )}

          {saveError && (
            <p className="text-xs text-[var(--rcd-status-critical)]" role="alert">
              {saveError}
            </p>
          )}
        </div>
      )}
    </RcdDialog>
  );
}
