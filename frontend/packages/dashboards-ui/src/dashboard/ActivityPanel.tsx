import { useCallback, useEffect, useRef, useState } from 'react';
import {
  rcdErrorMessage,
  type ActivityEntry,
  type LayoutChangeSummaryJson,
  type RenameDetailJson,
  type ShareDetailJson,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSpinner } from '../primitives';

export interface ActivityPanelProps {
  open: boolean;
  dashboardId: number;
  onClose: () => void;
}

const PAGE_SIZE = 50;

/** «did what» phrases per activity action (unknown actions fall back). */
const ACTION_PHRASES: Record<string, string> = {
  created: 'created the dashboard',
  saved: 'updated the dashboard',
  renamed: 'renamed the dashboard',
  shared: 'shared the dashboard',
  unshared: 'removed access',
  shareChanged: 'changed access',
  left: 'left the dashboard',
  deleted: 'deleted the dashboard',
  duplicated: 'made a copy',
};

/**
 * Tolerant UTC parse: the server serializes `timestamp` columns without a
 * zone suffix — treat a zoneless ISO string as UTC instead of local time.
 */
const parseUtc = (iso: string): Date =>
  new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);

/** "just now" / "5m ago" / "3h ago" / "2d ago" / short date. */
const relativeTime = (iso: string): string => {
  const at = parseUtc(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const age = Date.now() - at.getTime();
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  if (age < 7 * 86_400_000) return `${Math.floor(age / 86_400_000)}d ago`;
  return at.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Human detail lines from a saved LayoutChangeSummary / share / rename detail. */
const detailLinesOf = (entry: ActivityEntry): string[] => {
  const detail = entry.detail;
  if (detail === null || detail === undefined) return [];
  const lines: string[] = [];

  // "renamed the dashboard" detail: {from, to}.
  if (entry.action === 'renamed') {
    const rename = detail as RenameDetailJson;
    if (rename.from && rename.to) lines.push(`“${rename.from}” → “${rename.to}”`);
    return lines;
  }

  const share = detail as ShareDetailJson;
  if (Array.isArray(share.targetUserIds) && share.targetUserIds.length > 0) {
    const count = share.targetUserIds.length;
    lines.push(count === 1 ? '1 person' : `${count} people`);
  }

  const summary = detail as LayoutChangeSummaryJson;
  for (const name of summary.pagesAdded ?? []) lines.push(`Added page “${name}”`);
  for (const name of summary.pagesRemoved ?? []) lines.push(`Removed page “${name}”`);
  for (const rename of summary.pagesRenamed ?? []) {
    lines.push(`Renamed page “${rename.from}” to “${rename.to}”`);
  }
  if (summary.tilesAdded) lines.push(`${plural(summary.tilesAdded, 'tile')} added`);
  if (summary.tilesRemoved) lines.push(`${plural(summary.tilesRemoved, 'tile')} removed`);
  if (summary.chartsModified && summary.chartsModified.length > 0) {
    lines.push(`Charts modified: ${summary.chartsModified.join(', ')}`);
  }
  for (const rename of summary.chartsRenamed ?? []) {
    // from === to means only the (visible) rich inner title changed.
    lines.push(
      rename.from === rename.to
        ? `Retitled chart “${rename.to}”`
        : `Renamed chart “${rename.from}” to “${rename.to}”`,
    );
  }
  if (summary.geometryChanged) lines.push('Tiles moved or resized');
  if (summary.settingsChanged) lines.push('Dashboard settings changed');
  return lines;
};

/**
 * Reverse-chronological activity log for one dashboard: "«user» «did what» ·
 * «when ago»" rows with detail lines rendered from the saved layout-change
 * summary, paged backwards via the beforeId cursor ("Load more").
 */
export function ActivityPanel({ open, dashboardId, onClose }: ActivityPanelProps) {
  const runtime = useRuntime();

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  /** Failed page fetch: the message plus the cursor to re-request THAT page. */
  const [error, setError] = useState<{ message: string; beforeId?: number } | null>(null);
  const [hasMore, setHasMore] = useState(false);

  /**
   * Request ticket: every fetch takes a fresh one and only the freshest may
   * land. A dashboardId change (new loadPage identity → new fetch) or re-open
   * therefore invalidates any in-flight response — a slow page from the
   * previous dashboard can no longer populate this one's list.
   */
  const requestSeqRef = useRef(0);

  const loadPage = useCallback(
    async (beforeId?: number) => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await runtime.dashboards.listActivity(dashboardId, {
          limit: PAGE_SIZE,
          ...(beforeId !== undefined ? { beforeId } : {}),
        });
        if (seq !== requestSeqRef.current) return;
        setEntries((prev) => (beforeId === undefined ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE_SIZE);
      } catch (err) {
        // A load-more failure keeps the fetched entries (finding 14); only
        // the failed PAGE is re-requested by Retry, via its beforeId cursor.
        if (seq === requestSeqRef.current) setError({ message: rcdErrorMessage(err), beforeId });
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [runtime, dashboardId],
  );

  // Fresh first page on each open.
  useEffect(() => {
    if (!open) return;
    setEntries([]);
    setHasMore(false);
    setError(null);
    void loadPage();
  }, [open, loadPage]);

  const oldest = entries[entries.length - 1];

  return (
    <RcdDialog title="Activity" open={open} onClose={onClose}>
      {entries.length === 0 && error ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-[var(--rcd-status-critical)]" role="alert">
            {error.message}
          </p>
          <RcdButton onClick={() => void loadPage(error.beforeId)}>Retry</RcdButton>
        </div>
      ) : entries.length === 0 && loading ? (
        <div className="flex h-32 items-center justify-center">
          <RcdSpinner label="Loading activity…" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-rcd-muted">No activity recorded yet.</p>
      ) : (
        <div className="flex flex-col">
          {entries.map((entry) => (
            <div key={entry.id} className="border-b border-rcd-border py-2 last:border-b-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm text-rcd-text">
                  <span className="font-medium">{entry.displayName ?? entry.userId}</span>{' '}
                  {ACTION_PHRASES[entry.action] ?? 'updated the dashboard'}
                </span>
                <span
                  className="shrink-0 text-[11px] text-rcd-muted"
                  title={parseUtc(entry.atUtc).toLocaleString()}
                >
                  {relativeTime(entry.atUtc)}
                </span>
              </div>
              {detailLinesOf(entry).map((line, index) => (
                <p key={index} className="mt-0.5 pl-3 text-xs text-rcd-text-2">
                  {line}
                </p>
              ))}
            </div>
          ))}
          {/* Load-more failure: the fetched list stays; the error renders
              inline below it and Retry re-requests exactly the failed page. */}
          {error && (
            <div className="flex flex-col items-start gap-2 pt-3">
              <p className="text-xs text-[var(--rcd-status-critical)]" role="alert">
                {error.message}
              </p>
              <RcdButton size="sm" disabled={loading} onClick={() => void loadPage(error.beforeId)}>
                Retry
              </RcdButton>
            </div>
          )}
          {!error && hasMore && oldest !== undefined && (
            <div className="flex justify-center pt-3">
              <RcdButton size="sm" disabled={loading} onClick={() => void loadPage(oldest.id)}>
                {loading ? 'Loading…' : 'Load more'}
              </RcdButton>
            </div>
          )}
        </div>
      )}
    </RcdDialog>
  );
}
