import { MousePointer2, Pencil } from 'lucide-react';
import {
  CATEGORICAL_SLOTS,
  seriesColor,
  type DashboardCollabEditor,
} from '@recon/dashboards-core';
import { useDashboardState } from '../provider/DashboardsProvider';

/* COLLAB-DESIGN wave 2 — the presence/cursor/lock rendering trio. All three
 * surfaces read the store's host-fed ephemera (collabEditors, remoteCursors,
 * tileLocks) and render pure chrome: pointer-events-none, data-rcd-no-export,
 * zero influence on layout or document state.
 */

/**
 * Deterministic per-user accent. Reuses the chart palette's default slots so
 * collaborator colors feel native to the product and stay CONSISTENT across
 * surfaces (the same person's avatar chip and cursor share a color) and
 * across clients (every client derives it from the same host user id — no
 * negotiation needed).
 */
export const collabColorOf = (userId: number): string =>
  seriesColor(Math.abs(Math.trunc(userId)) % CATEGORICAL_SLOTS);

/** "Jane Q. Doe" → "JD" (first + last word); single word → its first two letters. */
export const collabInitialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[words.length - 1]![0]!}`.toUpperCase();
};

/** Avatar chips beyond this count collapse into one "+N" chip. */
const MAX_PRESENCE_CHIPS = 4;

/**
 * "Editing now" avatar strip for the toolbar (compact initials chips with
 * name tooltips, overflow "+N"). Renders NOTHING when the roster is empty —
 * the strip is presence, not chrome. The roster arrives deduped from the
 * store; it may include the local user (the library never learns its own
 * numeric host id — hosts wanting self-free strips filter before forwarding).
 */
export function PresenceStrip({ editors }: { editors: DashboardCollabEditor[] }) {
  if (editors.length === 0) return null;
  const visible = editors.slice(0, MAX_PRESENCE_CHIPS);
  const hidden = editors.slice(MAX_PRESENCE_CHIPS);
  return (
    <div
      className="flex shrink-0 items-center"
      role="group"
      aria-label={`Editing now: ${editors.map((e) => e.userName).join(', ')}`}
      data-rcd-no-export
    >
      <Pencil size={11} className="mr-1 shrink-0 text-rcd-muted" aria-hidden />
      {/* Slight overlap (-ml) reads as one social cluster, not N buttons. */}
      <div className="flex items-center">
        {visible.map((editor, index) => (
          <span
            key={editor.userId}
            title={`${editor.userName} is editing`}
            className={`flex h-5 w-5 items-center justify-center rounded-full border border-rcd-surface text-[9px] font-semibold leading-none text-white shadow-[var(--rcd-shadow-1)] ${
              index > 0 ? '-ml-1' : ''
            }`}
            style={{ backgroundColor: collabColorOf(editor.userId) }}
          >
            {collabInitialsOf(editor.userName)}
          </span>
        ))}
        {hidden.length > 0 && (
          <span
            title={hidden.map((e) => e.userName).join(', ')}
            className="-ml-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-rcd-surface bg-rcd-bg px-1 text-[9px] font-semibold leading-none text-rcd-text-2 shadow-[var(--rcd-shadow-1)]"
          >
            +{hidden.length}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Collaborators' named pointers over the dashboard grid. MUST be mounted as
 * an absolutely-positioned child of the GRID CONTENT BOX *inside* the
 * fit-to-page zoom wrapper: cursor events carry 0..1 fractions of that box's
 * layout size, and percentage offsets inside the zoomed subtree inherit the
 * zoom exactly like the tiles do — so every client sees the pointer over the
 * same tile regardless of its own scale (the pinned zoom-independence rule).
 * Only the ACTIVE page's cursors render (events carry pageId); a
 * collaborator on another page simply has no pointer here. Aging out is the
 * store's job (~6 s TTL) — this component just draws what the store holds.
 */
export function RemoteCursorOverlay({ pageId }: { pageId: string | null }) {
  const remoteCursors = useDashboardState((state) => state.remoteCursors);
  if (pageId === null) return null;
  const cursors = Object.values(remoteCursors).filter((cursor) => cursor.pageId === pageId);
  if (cursors.length === 0) return null;
  return (
    // overflow-hidden: a pointer at frac ≈ 1 must never widen the grid box
    // (which would feed the fit-viewport's measurement loop).
    <div aria-hidden data-rcd-no-export className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {cursors.map((cursor) => {
        const color = collabColorOf(cursor.userId);
        return (
          <div
            key={cursor.userId}
            className="absolute transition-[left,top] duration-100 ease-linear"
            style={{ left: `${cursor.xFrac * 100}%`, top: `${cursor.yFrac * 100}%` }}
          >
            {/* The pointer glyph's hotspot is its top-left tip — no offset. */}
            <MousePointer2 size={16} style={{ color }} fill={color} strokeWidth={1} />
            <span
              className="absolute left-3.5 top-3.5 max-w-40 truncate whitespace-nowrap rounded px-1 py-px text-[10px] font-medium leading-tight text-white shadow-[var(--rcd-shadow-1)]"
              style={{ backgroundColor: color }}
            >
              {cursor.userName}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Foreign-lock dressing on a tile: a subtle inset outline in the holder's
 * color plus an "Editing: {name}" chip. Rendered by DashboardView's tile
 * wrapper only for locks OTHER editors hold (the store already drops own-lock
 * echoes). Top-LEFT chip on purpose — the top-right corner belongs to the
 * tile's filter badge and hover controls. Cleared by the released event or
 * the expiresAtUtc sweep (store-side).
 */
export function TileLockOverlay({ holderUserId, holderName }: { holderUserId: number; holderName: string }) {
  const color = collabColorOf(holderUserId);
  return (
    <div aria-hidden data-rcd-no-export className="pointer-events-none absolute inset-0 z-30">
      <div
        className="absolute inset-0 rounded-[inherit] border-2 opacity-70"
        style={{ borderColor: color, borderRadius: 8 }}
      />
      <span
        className="absolute left-1.5 top-1.5 flex max-w-[80%] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none text-white shadow-[var(--rcd-shadow-1)]"
        style={{ backgroundColor: color }}
        title={`${holderName} is editing this tile`}
      >
        <Pencil size={9} aria-hidden className="shrink-0" />
        Editing: {holderName}
      </span>
    </div>
  );
}
