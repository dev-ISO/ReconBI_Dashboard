import { useEffect, useRef, useState } from 'react';
import { Check, Pause, Radio, RefreshCw } from 'lucide-react';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { RcdIconButton } from '../primitives';

/**
 * Toolbar "Live" controls (live-visibility wave). Rendered whenever the
 * dashboard is shared or a live session is active (DashboardView gates the
 * mount); everything inside reads the store directly:
 *
 *  - "Show live cursors" — ONE toggle for both directions (render others' +
 *    send our own); per-user persisted (store owns the localStorage key).
 *  - "Pause live updates" — the user-held quiesce source; session-only.
 *    While paused a "Live paused" pill sits beside the menu; unpausing
 *    ALWAYS resyncs from the server (the store's resume-edge doctrine —
 *    gated events are dropped, never queued).
 *  - Divergence/backlog chips: "Syncing…" while the local doc awaits its
 *    quiet-point refetch, and "N waiting" while remote changes are HELD on
 *    elements this user is editing (heldRemoteOps).
 */
export function LiveMenu() {
  const runtime = useRuntime();
  const paused = useDashboardState((state) => state.collabPaused);
  const showCursors = useDashboardState((state) => state.collabShowCursors);
  const diverged = useDashboardState((state) => state.collabDiverged);
  const heldCount = useDashboardState((state) => Object.keys(state.heldRemoteOps).length);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggles: { key: string; label: string; checked: boolean; onToggle: () => void }[] = [
    {
      key: 'cursors',
      label: 'Show live cursors',
      checked: showCursors,
      onToggle: () => runtime.dashboards.setShowLiveCursors(!showCursors),
    },
    {
      key: 'pause',
      label: 'Pause live updates',
      checked: paused,
      onToggle: () => runtime.dashboards.setLiveUpdatesPaused(!paused),
    },
  ];

  return (
    <div className="flex shrink-0 items-center gap-1.5" data-rcd-no-export>
      {/* Divergence/backlog chips sit LEFT of the menu so the button (and the
          user's muscle memory for it) never moves when they appear. */}
      {diverged && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[11px] font-medium text-rcd-text-2 shadow-[var(--rcd-shadow-1)]"
          title="Reconciling with the server — a remote change could not apply locally."
          role="status"
        >
          <RefreshCw size={11} className="animate-spin" aria-hidden />
          Syncing…
        </span>
      )}
      {heldCount > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[11px] font-medium text-rcd-text-2 shadow-[var(--rcd-shadow-1)]"
          title="Updates from collaborators are waiting on elements you are editing; they apply when you finish."
          role="status"
        >
          {heldCount} {heldCount === 1 ? 'update' : 'updates'} waiting
        </span>
      )}
      {paused && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[11px] font-medium text-[var(--rcd-status-warn)] shadow-[var(--rcd-shadow-1)]"
          title="Live updates are paused — unpause to catch up (refetches the latest version)."
          role="status"
        >
          <Pause size={11} aria-hidden />
          Live paused
        </span>
      )}

      <div className="relative shrink-0" ref={rootRef}>
        <RcdIconButton
          aria-label="Live collaboration options"
          title="Live"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={open || paused ? 'bg-black/5 text-rcd-text dark:bg-white/10' : ''}
        >
          <Radio size={14} />
        </RcdIconButton>

        {open && (
          <div
            role="menu"
            aria-label="Live collaboration options"
            className="absolute right-0 top-full z-40 mt-1 w-52 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
          >
            {toggles.map((toggle) => (
              <button
                key={toggle.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={toggle.checked}
                onClick={toggle.onToggle}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
              >
                <span className="w-3.5 shrink-0">
                  {toggle.checked && <Check size={14} className="text-rcd-accent" />}
                </span>
                {toggle.label}
              </button>
            ))}
            <p className="px-3 pb-1 pt-1.5 text-[11px] leading-tight text-rcd-muted">
              Pausing stops incoming changes while you read or print; unpausing loads the
              latest version.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
