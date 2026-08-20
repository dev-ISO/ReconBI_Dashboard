import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  opResultStampOf,
  type DashboardsApi,
  type DashboardShareInput,
  type ListActivityOptions,
  type SendDashboardOpBody,
} from '../api/DashboardsApi';
import { RcdApiError, rcdErrorMessage } from '../api/fetcher';
import {
  applyOpToDoc,
  diffLayoutDocs,
  invertLocalOp,
  mergePendingPayloads,
  pendingSlotKey,
} from './collabOps';
import {
  opConflictKey,
  OP_TARGET_MISSING_ERROR,
  TILE_LOCKED_ERROR,
  type DashboardCollabEditor,
  type DashboardEditorsChangedEvent,
  type DashboardLocalOp,
  type DashboardOpEvent,
  type DashboardOpPayload,
  type DashboardRemoteCursorEvent,
  type DashboardRemoteSlicerValueEvent,
  type DashboardTileLockEvent,
} from '../types/ops';
import type { ChartSpec, ContainerStyle } from '../types/chart';
import { inclusiveDateUpperBound } from '../util/dateBounds';
import {
  dashboardAccessOf,
  emptyLayout,
  filterCardClauses,
  isSlicerTile,
  slicerClauseOf,
  type ActivityEntry,
  type CrossFilter,
  type DashboardAccess,
  type DashboardShare,
  type RcdUser,
  type CrossFilterScope,
  type CrossFilterValue,
  type DashboardDetail,
  type DashboardLayoutDoc,
  type DashboardBookmark,
  type DashboardPage,
  type DashboardParameter,
  type DashboardSummary,
  type DashboardTile,
  type DispatchProgressEvent,
  type DispatchRecipientStatus,
  type DispatchStatus,
  type DispatchTrigger,
  type DrillthroughState,
  type FilterCard,
  type FilterIndicatorStyle,
  type PageDrillthrough,
  type PageMobileLayout,
  type ButtonGroupButton,
  type ButtonGroupTileSpec,
  type ButtonTileSpec,
  type ImageTileSpec,
  type SlicerTileSpec,
  type SlicerValue,
  type SlicerValues,
  type SlicerVariant,
  type TextTileSpec,
  type ViewFitMode,
} from '../types/dashboard';
import type {
  CellValue,
  DateBucket,
  DimensionRef,
  FilterClause,
  FilterValue,
} from '../types/query';
import type { ColumnType } from '../types/schema';
import type { Measure } from '../types/model';
import {
  chartMeasureDefinitions,
  chartMeasureIds,
  collectMeasureDefinitions,
  mergeMeasureDefinitions,
} from './measureScope';
import { stableStringify } from '../util/hash';
import { newId } from '../util/ids';
import { sanitizeButtonCss } from '../util/buttonStyle';
import { boldRunText, retitleInnerTitleHtml, sanitizeRichHtml } from '../util/richText';
import type { AsyncStatus } from './modelStore';

export interface OpenDashboard {
  id: number;
  name: string;
  description: string | null;
  modelId: number | null;
  isShared: boolean;
  ownerIsMe: boolean;
  /** Built-in (seeded) content — read-only for everyone; copy to edit. */
  isSystem: boolean;
  /** Owner's directory display name (null when unresolvable / pre-0.8 server). */
  ownerDisplayName: string | null;
  /**
   * Owner's opaque host id (null on a pre-0.14.1 server). The ONE identity the
   * store does carry: ownerIsMe cannot tell the share dialog WHICH id to keep
   * out of its picker, and the server refuses an owner grant outright.
   */
  ownerUserId: string | null;
  /** Caller's resolved rights (defaulted via dashboardAccessOf on pre-0.8 servers). */
  myAccess: DashboardAccess;
  /** Per-user grant count; 0 unless the caller is owner/admin. */
  shareCount: number;
  expectedUpdatedAtUtc: string;
  layout: DashboardLayoutDoc;
}

/**
 * Live per-subscription send progress, built from host-forwarded
 * DispatchProgressEvents (runtime.dashboards.applyDispatchProgress). Keyed by
 * SUBSCRIPTION id — the manager rows look progress up per subscription. An
 * entry survives after 'finished' so the strip can show the final roll-up
 * until the list refreshes; hosts that forward nothing simply never populate
 * this and UIs poll instead.
 */
export interface DispatchLiveProgress {
  dispatchId: number;
  subscriptionId: number;
  subscriptionName: string;
  trigger: DispatchTrigger;
  /** 'running' until the finished event lands. */
  status: DispatchStatus;
  recipientCount: number;
  startedUtc: string;
  /** Upserted per recipient event, keyed by email. */
  recipients: Record<
    string,
    { status: DispatchRecipientStatus; attempts: number; error: string | null }
  >;
  sentCount: number | null;
  failedCount: number | null;
  optedOutCount: number | null;
  error: string | null;
  finishedUtc: string | null;
}

export interface DashboardStoreState {
  list: DashboardSummary[];
  listStatus: AsyncStatus;
  /** See DispatchLiveProgress — realtime send-now/scheduled dispatch progress per subscription. */
  dispatchProgress: Record<number, DispatchLiveProgress>;
  current: OpenDashboard | null;
  mode: 'view' | 'edit';
  dirty: boolean;
  /** structuredClone snapshot taken on enterEdit; discardEdits restores it. */
  draftBackup: OpenDashboard | null;
  /** Page whose tiles render and receive ALL tile operations. */
  activePageId: string | null;
  selectedTileId: string | null;
  /**
   * Slicer selections keyed by slicer TILE id. The map stays global (tile ids
   * are unique across pages) so selections persist while switching pages;
   * page scoping happens in filtersForTile, which only consults slicers that
   * live on the target tile's page.
   */
  slicerValues: SlicerValues;
  /**
   * Transient click-to-highlight filters, AT MOST ONE PER (table, column) —
   * applyCrossFilter enforces the invariant (a new click on an already
   * filtered field replaces or merges into that field's entry; Ctrl/Cmd-click
   * adds fields/values). NOT persisted. Reset on page switch under the
   * default 'page' crossFilterScope; kept across pages under 'dashboard'.
   */
  crossFilters: CrossFilter[];
  /**
   * Transient page-wide hover highlight raised by hovering a datum on a chart
   * tile: every OTHER chart on the page whose effective axis/legend dimension
   * matches dims non-matching categories. NEVER persisted; never triggers
   * fetches; cleared on page switch and when the source tile unhovers/unmounts.
   */
  hoverHighlight: HoverHighlight | null;
  /**
   * Transient field-parameter selections (option index) keyed by parameter id.
   * Initialized from each parameter's defaultIndex on open; NEVER persisted.
   */
  parameterSelections: Record<string, number>;
  /**
   * Transient drillthrough context (set by invoking "Drill through" from a
   * point menu). NEVER persisted; its filters reach every chart tile on the
   * TARGET page via filtersForTile. Survives page switches so revisiting the
   * target page keeps its context until explicitly cleared.
   */
  drillthrough: DrillthroughState | null;
  /**
   * Bookmark whose applied state is still current — shows a check in the
   * Bookmarks menu; cleared by any slicer/filter/page change. Runtime only.
   */
  lastAppliedBookmarkId: string | null;
  /**
   * View-mode personal tweaks to filter cards (enable/disable + basic
   * selections), keyed by card id. NEVER persisted — viewers adjust filters
   * without editing the dashboard (Power BI-like). Cleared on open/close and
   * on enterEdit (edit mode always shows/writes the authored doc state).
   */
  filterCardOverrides: Record<string, FilterCardOverride>;
  /**
   * View-mode transient override of the doc's default view sizing (null =
   * follow `layout.defaultViewFit`, where absent means FIT TO PAGE). Lives in
   * the store — NOT component state — so the viewer's choice survives page
   * switches and any component remount within the session. NEVER persisted;
   * cleared on open/close. Edit-mode picks write the doc default instead.
   */
  viewFitOverride: ViewFitMode | null;
  /**
   * Whether an edit-session undo/redo step is available. The stacks themselves
   * live OUTSIDE the reactive state (class fields) — components only ever need
   * these two booleans, and stacks of deep layout clones have no business
   * feeding useSyncExternalStore. Draft sessions stack whole-doc snapshots
   * (historic behavior, untouched); LIVE sessions stack inverse OPS scoped to
   * the local user's own changes (COLLAB-DESIGN: a collaborator's concurrent
   * work can never be reverted by someone else's Ctrl+Z).
   */
  canUndo: boolean;
  canRedo: boolean;
  /**
   * COLLAB-DESIGN live mode: true while the edit session on a COLLABORATIVE
   * dashboard is active — every edit persists immediately as an op (that IS
   * the autosave), Save becomes "Done" (exit only, no doc PUT), Discard is
   * replaced by the (locally-scoped) undo. A dashboard is collaborative when
   * it has ≥1 share grant: a grantee holding edit rights proves one exists;
   * for the owner/admin the grant count is the honest client-side signal (the
   * per-grant edit flags are not on the open payload — a dashboard shared
   * view-only enters live mode too, harmlessly: ops simply autosave with no
   * other editors possible). Solo dashboards keep the draft/save/discard path
   * EXACTLY as before; so does an admin editing an unshared dashboard via
   * CanManageShared (the design's accepted edge). Set on enterEdit, cleared on
   * exit/close — and cleared mid-session when op delivery fails twice, which
   * degrades the session to draft semantics (see the ops pipeline).
   */
  liveMode: boolean;
  /**
   * Remote ops HELD by the merge doctrine (copied from the tracker's
   * applyRealtimeSystemInput): a remote op targeting an element with local
   * uncommitted changes is not applied — the concurrency baseline advances,
   * the local element stays untouched, and the conflict is surfaced honestly
   * here (keyed by the op's CONFLICT KEY — see opConflictKey; latest per
   * element) for the UI to badge. A held op is superseded when the local
   * change commits (our op is newer server-side) and re-applied when the
   * element becomes clean without a local write (e.g. a chart builder Cancel
   * releasing the tile lock).
   */
  heldRemoteOps: Record<string, DashboardOpEvent>;
  /**
   * Transient soft-lock notice ("this tile is being edited by someone else") —
   * set when a lock acquire/heartbeat is rejected, cleared via
   * clearLockNotice(). The toolbar area renders it as a dismissible chip.
   */
  lockNotice: string | null;
  /**
   * WAVE 2 presence: who is editing this dashboard right now, as reported by
   * the host's presence tracker (applyEditorsChanged — full set per event,
   * never deltas). Host-owned ephemera: view-mode safe, never dirties, reset
   * on open/close. The toolbar renders it as the avatar strip; the set may
   * include the local user (the store never learns its own numeric host id,
   * so it cannot filter self — hosts that want self-free strips filter before
   * forwarding).
   */
  collabEditors: DashboardCollabEditor[];
  /**
   * WAVE 2 cursors: collaborators' pointers keyed by HOST user id, each
   * stamped with its local arrival time. Aged out ~6 s after the last frame
   * (the collabSweep interval) — cursors have no "gone" wire event; silence
   * IS the signal. All received cursors are kept: the HOST filters the
   * sender's own echo before forwarding (pinned contract), because the store
   * cannot compare host-numeric ids to a self it never learns.
   */
  remoteCursors: Record<number, RemoteCursor>;
  /**
   * WAVE 2 lock visibility: OTHER editors' soft tile locks keyed by tile id,
   * for the "Editing: {name}" chip + outline. Removed on the released event
   * and aged out at expiresAtUtc (heartbeat extensions are deliberately not
   * broadcast — a chip fading before the holder finishes is the accepted
   * cost; the hold/409 machinery underneath is wave 1 and unaffected). Locks
   * THIS client holds never land here (applyTileLock drops them while our
   * heartbeat runs, and a successful acquire clears any echo that raced in).
   */
  tileLocks: Record<string, RemoteTileLock>;
  /**
   * LIVE-VISIBILITY quiesce: true while ANY quiesce source is active — the
   * user's "Pause live updates" toggle, an open print preview, an open print
   * config dialog (its live thumbnail renders store state), or an image-export
   * rasterization in flight. Gates ALL FOUR inbound ephemeral channels
   * (applyEditorsChanged / applyRemoteCursor / applyTileLock /
   * applyRemoteSlicerValue) AND applyRemoteOp AND our own outbound cursor
   * sends. Gated events are DROPPED, never queued — on the resume edge the
   * store resyncFromServer instead (never trust what was missed).
   */
  collabQuiesced: boolean;
  /** The user-held quiesce source ("Pause live updates") — session-only,
   * default off; the Live menu's checkbox state. */
  collabPaused: boolean;
  /**
   * "Show live cursors" (Live menu). ONE toggle governs BOTH directions: off
   * hides the overlay (the view gates rendering on it), drops inbound frames,
   * and no-ops sendCursorThrottled. Persisted per user in localStorage
   * (rcd.collab.showCursors); default on.
   */
  collabShowCursors: boolean;
  /**
   * The local doc may no longer match server truth: a remote change was
   * dropped un-applied (a held op superseded by our commit, wiped by session
   * exit, malformed, or inapplicable to this doc). Repaired by
   * resyncFromServer at the next quiet point (empty op buffer, no drain in
   * flight); the toolbar renders it as the "Syncing…" chip meanwhile.
   */
  collabDiverged: boolean;
  saveStatus: AsyncStatus;
  error: string | null;
  /**
   * Transient chart clipboard (copyChart / pasteChartTile). NEVER persisted;
   * survives closing/opening dashboards within the session so a chart copied
   * on one dashboard can be pasted on another.
   */
  chartClipboard: {
    chart: ChartSpec;
    sourceModelId: number | null;
    /**
     * The scoped measure DEFINITIONS the copied chart cites, snapshotted at
     * copy time (transitively — a calculated one may reference others by
     * name). Without them a chart pasted onto another dashboard renders
     * QRY_UNKNOWN_MEASURE: dashboard measures live in the SOURCE doc and
     * nothing else carries them across.
     */
    definitions: Measure[];
  } | null;
  /**
   * PERSONAL-scope measures (the per-user settings document's `measures`).
   * Held here so the query wire can send them and so the promotion rule can be
   * enforced when a chart is written into a dashboard; the store never loads
   * or persists them itself — the owner of the per-user store calls
   * setPersonalMeasures.
   */
  personalMeasures: Measure[];
}

/** The subset of FilterCard a viewer may tweak transiently in view mode. */
export interface FilterCardOverride {
  disabled?: boolean;
  basicValues?: FilterValue[] | null;
}

/** One remote pointer (wave 2): the cursor event + its local arrival stamp. */
export interface RemoteCursor {
  userId: number;
  userName: string;
  pageId: string;
  /** 0..1 fractions of the grid content box (zoom-independent — see ops.ts). */
  xFrac: number;
  yFrac: number;
  /** Sender timestamp (informational). */
  at: string;
  /** LOCAL Date.now() at arrival — the TTL clock (immune to sender skew). */
  receivedAt: number;
}

/** One OTHER editor's soft tile lock (wave 2 lock visibility). */
export interface RemoteTileLock {
  tileId: string;
  holderUserId: number;
  holderName: string;
  /** Receivers age the lock out at this edge (heartbeats never broadcast). */
  expiresAtUtc: string;
}

/**
 * Host-injected senders for the wave-2 OUTBOUND ephemeral channels (pinned
 * contract): DashboardsProvider threads its optional onSendCursor /
 * onSendSlicerValue props here via createDashboardsRuntime. Absent members
 * silently disable the corresponding sending (portal/demo hosts) — receiving
 * still works, since inbound events arrive through the apply* actions.
 */
export interface DashboardCollabSenders {
  onSendCursor?: (cursor: { pageId: string; xFrac: number; yFrac: number }) => void;
  onSendSlicerValue?: (value: { tileId: string; valueJson: string }) => void;
  /**
   * Persists the PERSONAL-scope measure set. createRuntime points this at the
   * per-user settings document; absent, personal measures stay session-local.
   * Not a collab channel, but this is the store's one host-seam bag and a
   * second one would be a distinction without a difference.
   */
  onPersistPersonalMeasures?: (measures: Measure[], modelId: number | null) => void;
}

/**
 * Is this dashboard part of a LIVE collaborative session's audience — i.e.
 * may wave-2 ephemera (presence, cursors, shared-slicer values) flow for it?
 * Deliberately BROADER than the wave-1 live-EDIT predicate
 * (isLiveCollaborative): a view-only grantee never live-edits, but they DO
 * see presence/cursors and participate in shared slicers, so the edit right
 * is not required — any share relationship (being a grantee, or owning/
 * managing a dashboard with grants) qualifies. Built-ins and merely-published
 * ("Everyone") dashboards stay out, mirroring wave 1's rule that the legacy
 * publish flag never makes a dashboard collaborative.
 */
export const isCollabLiveDashboard = (dashboard: OpenDashboard): boolean =>
  !dashboard.isSystem && (dashboard.myAccess.viaShare || dashboard.shareCount > 0);

/** Transient hover cross-highlight payload (see DashboardStoreState.hoverHighlight). */
export interface HoverHighlight {
  /** Dimension of the hovered category on the SOURCE chart (its effective axis/legend). */
  dimension: { table: string; column: string };
  /** RAW (pre-format) hovered cell value. */
  raw: CellValue;
  /** Formatted category label — the key other charts dim against. */
  label: string;
  /** Chart tile the hover came from; that tile never dims itself. */
  sourceTileId: string;
}

/* ================================================== cross-filter clause build
 * Clicking a datum turns ONE raw cell into the clause every other tile adds to
 * its query. For plain dimensions that is an `eq` (or `isNull`). For a DATE
 * BUCKET it must be a RANGE:
 *
 *  - the raw cell is the bucket's START INSTANT, and the engine frequently
 *    serializes it with a zone offset ("2023-09-30T19:00:00-05:00" IS the
 *    October bucket) — feeding that string back as a filter value blows up on
 *    a `date` column ("cannot be interpreted as Date");
 *  - even with a parseable value, `eq bucketStart` matches only rows that fall
 *    exactly on the boundary, not the bucket's other rows.
 *
 * So a bucket click emits DATE-ONLY 'yyyy-MM-dd' bounds covering the whole
 * bucket. Every calendar computation below runs on UTC parts — never
 * `new Date(x).toISOString()`, which drags the value through the browser's
 * local zone and can shift it a full day (exactly the reported bug).
 *
 * The range travels as ONE inclusive `between` clause because CrossFilter
 * carries a single FilterClause; [start, end] with end = nextBucketStart - 1
 * day is the exact same row set as [start, nextBucketStart) for date-grained
 * data.
 */

/** A timezone-free calendar date (month is 1-based). */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'yyyy-MM-dd' — the only date shape cross-filter clauses ever put on the wire. */
export const formatDateOnly = (date: CalendarDate): string =>
  `${String(date.year).padStart(4, '0')}-${pad2(date.month)}-${pad2(date.day)}`;

/** Calendar parts of an epoch instant, read in UTC. */
const utcCalendarOf = (ms: number): CalendarDate | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

/** UTC calendar arithmetic (Date.UTC normalizes overflowing month/day parts). */
const shiftUtc = (date: CalendarDate, months: number, days: number): CalendarDate => {
  // setUTCFullYear (not the Date.UTC year argument) so years 0-99 stay literal.
  const at = new Date(0);
  at.setUTCFullYear(date.year, date.month - 1 + months, date.day + days);
  return utcCalendarOf(at.getTime()) ?? date;
};

/**
 * ISO-8601-ish date/timestamp shapes the engine emits. Groups: y, m, d, HH,
 * mm, ss, zone ('Z' / '±hh:mm' / '±hhmm'; ABSENT for a naive local timestamp).
 */
const ISO_LIKE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Can `date` be the START of a bucket of this grain? */
const isBucketStart = (date: CalendarDate, bucket: DateBucket): boolean => {
  switch (bucket) {
    case 'year':
      return date.month === 1 && date.day === 1;
    case 'quarter':
      return (date.month - 1) % 3 === 0 && date.day === 1;
    case 'month':
      return date.day === 1;
    default:
      // week/day: any calendar date is a legal bucket start.
      return true;
  }
};

/**
 * The calendar date a raw bucket cell denotes, resolved WITHOUT ever touching
 * the browser's local zone:
 *  - naive string ("2023-10-01", "2023-10-01T00:00:00") -> its literal date
 *    (Date.parse would re-interpret it in the local zone);
 *  - zoned string -> the literal date when that is a legal midnight bucket
 *    start (the server rendered the boundary in its own zone), otherwise the
 *    UTC date of the instant (the "2023-09-30T19:00:00-05:00" case, whose
 *    instant is 2023-10-01T00:00Z = the October bucket);
 *  - Date / epoch number -> UTC parts.
 */
export const bucketDateOf = (raw: unknown, bucket: DateBucket): CalendarDate | null => {
  if (raw instanceof Date) return utcCalendarOf(raw.getTime());
  if (typeof raw === 'number') return utcCalendarOf(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  const match = ISO_LIKE.exec(text);
  if (match) {
    const literal: CalendarDate = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
    if (match[7] === undefined) return literal;
    const midnight = (match[4] ?? '00') === '00' && (match[5] ?? '00') === '00' && (match[6] ?? '00') === '00';
    if (midnight && isBucketStart(literal, bucket)) return literal;
    return utcCalendarOf(Date.parse(text)) ?? literal;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : utcCalendarOf(parsed);
};

/** Floors a calendar date onto its bucket's first day. */
const startOfBucket = (date: CalendarDate, bucket: DateBucket): CalendarDate => {
  switch (bucket) {
    case 'year':
      return { year: date.year, month: 1, day: 1 };
    case 'quarter':
      return { year: date.year, month: date.month - ((date.month - 1) % 3), day: 1 };
    case 'month':
      return { year: date.year, month: date.month, day: 1 };
    default:
      // week/day: the engine already truncated to the bucket's first day.
      return date;
  }
};

/** The bucket after `start` (its half-open upper bound). */
const nextBucketStart = (start: CalendarDate, bucket: DateBucket): CalendarDate => {
  switch (bucket) {
    case 'year':
      return shiftUtc(start, 12, 0);
    case 'quarter':
      return shiftUtc(start, 3, 0);
    case 'month':
      return shiftUtc(start, 1, 0);
    case 'week':
      return shiftUtc(start, 0, 7);
    default:
      return shiftUtc(start, 0, 1);
  }
};

/** Inclusive calendar bounds (+ the half-open upper bound) of a raw bucket cell. */
export const dateBucketRange = (
  raw: unknown,
  bucket: DateBucket,
): { start: CalendarDate; end: CalendarDate; next: CalendarDate } | null => {
  const at = bucketDateOf(raw, bucket);
  if (at === null) return null;
  const start = startOfBucket(at, bucket);
  const next = nextBucketStart(start, bucket);
  return { start, end: shiftUtc(next, 0, -1), next };
};

/**
 * Inclusive 'between' clause over date-only (or last-instant) bounds.
 *
 * The engine compiles `between` to `col >= a AND col <= b` against the RAW
 * column (never the truncated expression), so the upper bound has to match
 * the column's own resolution — `inclusiveDateUpperBound` owns that decision
 * for every date path in the app (cross-filters, slicers, presets). For a
 * `date` column `>= '2023-10-01' AND <= '2023-10-31'` is exactly
 * `[Oct 1, Nov 1)`; for a `timestamp` one the bound moves to the day's last
 * instant so the bucket's final day is not dropped.
 */
const betweenClause = (
  dimension: { table: string; column: string },
  start: CalendarDate,
  end: CalendarDate,
  columnType: ColumnType | null | undefined,
): FilterClause => ({
  table: dimension.table,
  column: dimension.column,
  operator: 'between',
  values: [formatDateOnly(start), inclusiveDateUpperBound(formatDateOnly(end), columnType)],
});

/**
 * What the RESULT column says about the clicked dimension. The result column
 * is authoritative: it reports the bucket the engine actually applied and the
 * column's catalog type. Both are optional — callers without a result fall
 * back to the spec's own dateBucket and the strict date form.
 */
export interface CrossFilterClauseOptions {
  columnType?: ColumnType | null;
  dateBucket?: DateBucket | null;
}

/**
 * The cross-filter clause for one clicked category value on `dimension`:
 * null -> isNull, a DATE-BUCKETED dimension -> the bucket's full range,
 * anything else -> eq on the raw value.
 */
export const crossFilterClauseFor = (
  dimension: DimensionRef,
  raw: CellValue | Date,
  options: CrossFilterClauseOptions = {},
): FilterClause => {
  const { table, column } = dimension;
  if (raw === null) return { table, column, operator: 'isNull', values: [] };
  const bucket = options.dateBucket ?? dimension.dateBucket ?? null;
  if (bucket !== null) {
    const range = dateBucketRange(raw, bucket);
    if (range !== null) return betweenClause(dimension, range.start, range.end, options.columnType);
  }
  return { table, column, operator: 'eq', values: [raw as FilterValue] };
};

/**
 * The cross-filter clause for a dragged AXIS RANGE on a date axis
 * (format.zoom.dragAction === 'crossFilter'): the bucket containing `fromRaw`
 * through the bucket containing `toRaw`, inclusive. Returns null when neither
 * endpoint resolves to a date.
 */
export const dateRangeClauseFor = (
  dimension: DimensionRef,
  fromRaw: unknown,
  toRaw: unknown,
  options: CrossFilterClauseOptions = {},
): FilterClause | null => {
  const bucket = options.dateBucket ?? dimension.dateBucket ?? 'day';
  const from = dateBucketRange(fromRaw, bucket);
  const to = dateBucketRange(toRaw, bucket);
  if (from === null && to === null) return null;
  const first = from ?? to!;
  const last = to ?? from!;
  // Tolerate a backwards drag (right-to-left selection).
  const ordered =
    formatDateOnly(first.start) <= formatDateOnly(last.start)
      ? { start: first.start, end: last.end }
      : { start: last.start, end: first.end };
  return betweenClause(dimension, ordered.start, ordered.end, options.columnType);
};

/**
 * Chart clone shared by EVERY copy path — duplicate tile, clipboard paste,
 * copy-to-dashboard (same- and cross-dashboard): fresh chart id, optional
 * " (copy)" title suffix, and — when the tile carries a rich inner title
 * (format.container.innerTitleHtml, the frameless seeded-tile pattern where
 * THAT is the visible name, not chart.title) — the inner title's bold
 * lead-in rewritten to the copy's title, so the copy shows its own name
 * immediately instead of masquerading as its source.
 *
 * The rewrite fires ONLY when the bold lead-in still READS as the SOURCE
 * chart's title (boldRunText === chart.title): an inner title the user
 * customized away from the chart title is their newer statement of what the
 * tile says, and an unconditional rewrite silently destroyed it on every
 * duplicate/paste/copy. Customized inner titles ride through untouched — the
 * copy is distinguished by its " (copy)" TITLE suffix alone. A helper miss
 * (no bold element in the HTML) likewise leaves the inner title untouched.
 */
export const cloneChartForCopy = (
  chart: ChartSpec,
  options?: { suffix?: boolean },
): ChartSpec => {
  const copy = structuredClone(chart);
  copy.id = newId();
  if (options?.suffix) copy.title = `${chart.title} (copy)`;
  const innerTitleHtml = copy.format.container?.innerTitleHtml;
  if (innerTitleHtml && boldRunText(innerTitleHtml) === chart.title.trim()) {
    const retitled = retitleInnerTitleHtml(innerTitleHtml, copy.title);
    if (retitled !== null) copy.format.container!.innerTitleHtml = retitled;
  }
  return copy;
};

const initialState: DashboardStoreState = {
  list: [],
  listStatus: 'idle',
  dispatchProgress: {},
  current: null,
  mode: 'view',
  dirty: false,
  draftBackup: null,
  activePageId: null,
  selectedTileId: null,
  slicerValues: {},
  crossFilters: [],
  hoverHighlight: null,
  parameterSelections: {},
  drillthrough: null,
  lastAppliedBookmarkId: null,
  filterCardOverrides: {},
  viewFitOverride: null,
  canUndo: false,
  canRedo: false,
  liveMode: false,
  heldRemoteOps: {},
  lockNotice: null,
  collabEditors: [],
  remoteCursors: {},
  tileLocks: {},
  collabQuiesced: false,
  collabPaused: false,
  collabShowCursors: true,
  collabDiverged: false,
  saveStatus: 'idle',
  error: null,
  chartClipboard: null,
  personalMeasures: [],
};

/** localStorage key of the per-user "Show live cursors" preference. */
const SHOW_CURSORS_STORAGE_KEY = 'rcd.collab.showCursors';

/** Persisted cursor preference; default ON (missing key, no storage, SSR). */
const readShowCursorsPreference = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(SHOW_CURSORS_STORAGE_KEY) !== '0';
  } catch {
    return true; // storage blocked (private mode) — behave like default
  }
};

const writeShowCursorsPreference = (show: boolean): void => {
  try {
    globalThis.localStorage?.setItem(SHOW_CURSORS_STORAGE_KEY, show ? '1' : '0');
  } catch {
    // storage blocked — the toggle still works for this session
  }
};

/** One undo/redo step: the whole document + which page was active. */
interface HistorySnapshot {
  layout: DashboardLayoutDoc;
  activePageId: string | null;
}

/** Same-tag pushes within `windowMs` of each other collapse into one entry. */
interface HistoryCoalesce {
  tag: string;
  windowMs: number;
}

const HISTORY_CAP = 50;

/** Cap on remembered own-op ids (echo dropping); oldest are evicted. */
const SENT_OP_CAP = 500;

/**
 * Soft tile-lock heartbeat cadence. Locks are a GridPresenceTracker clone —
 * a server-side TTL claim the holder refreshes by re-acquiring. The server
 * TTL is 30s, so 10s gives a 3× margin: two whole heartbeats can be lost to
 * a network blip before the lock lapses (20s left exactly one, and a single
 * dropped POST let a held lock expire under an open chart builder).
 */
const TILE_LOCK_HEARTBEAT_MS = 10_000;

/** Bound on the best-effort op-buffer drain that runs before an open()
 * dashboard switch / close() clears the session — navigation must not wedge
 * behind a dead network; whatever misses the window is lost with the session. */
const FLUSH_ON_EXIT_TIMEOUT_MS = 2_000;

/**
 * Remote-cursor lifetime after its LAST frame (wave 2). Cursors have no
 * "gone" wire event — pointerleave simply stops the ~10 Hz stream — so
 * receivers age them out. 6 s (the design's "TTL like chat typing
 * indicators") is long enough that a paused-but-present pointer survives the
 * send throttle, short enough that a departed one doesn't haunt the grid.
 */
const CURSOR_TTL_MS = 6_000;

/** Trailing-throttle window for outbound cursor frames (~10 Hz per design). */
const CURSOR_SEND_MS = 100;

/** Cadence of the cursor/lock expiry sweep (armed only while any exist). */
const COLLAB_SWEEP_MS = 1_000;

/**
 * Is this dashboard COLLABORATIVE (live-mode editing) for this caller? True
 * when ≥1 share grant exists: a grantee holding edit rights IS one; for the
 * owner/admin, shareCount is the client-side signal (per-grant edit flags are
 * not on the open payload — see DashboardStoreState.liveMode for why counting
 * view-only grants is harmless). Built-ins never (read-only anyway); the
 * legacy publish ("Everyone") flag grants VIEW only, so it does not count.
 */
const isLiveCollaborative = (dashboard: OpenDashboard): boolean =>
  !dashboard.isSystem &&
  dashboard.myAccess.canEdit &&
  (dashboard.myAccess.viaShare || dashboard.shareCount > 0);

/** One buffered, not-yet-POSTed local op (see bufferOps). */
interface PendingOp {
  op: DashboardLocalOp;
  /** Earliest instant this op may flush (coalescing window's trailing edge). */
  flushAt: number;
}

export class DashboardStore {
  readonly store: StoreApi<DashboardStoreState>;

  /* Edit-session undo/redo (see DashboardStoreState.canUndo). The stacks hold
   * PRE-change snapshots; only the canUndo/canRedo booleans are reactive. */
  private undoStack: HistorySnapshot[] = [];
  private redoStack: HistorySnapshot[] = [];
  private lastHistoryTag: string | null = null;
  private lastHistoryAt = 0;
  /** >0 while inside groupHistory — inner mutations skip their own push. */
  private historyDepth = 0;

  /* ---- collaborative live-mode session plumbing (COLLAB-DESIGN wave 1).
   * All non-reactive for the same reason as the snapshot stacks: components
   * only ever need liveMode / heldRemoteOps / canUndo, which ARE in state. */

  /** LIVE-session history: entries are inverse-op lists scoped to the local
   * user's own changes (never whole-doc snapshots — see undo()). */
  private liveUndoStack: DashboardLocalOp[][] = [];
  private liveRedoStack: DashboardLocalOp[][] = [];
  /** Open groupHistory accumulator while historyDepth > 0 in live mode. */
  private liveGroupEntry: DashboardLocalOp[] | null = null;
  /** Authored-but-unsent ops, keyed by pendingSlotKey (newer edits to the same
   * element merge in — per-element LWW makes that lossless). Map order is the
   * send order; page.add naturally precedes tile ops onto the new page. */
  private pendingOps = new Map<string, PendingOp>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes drains so two flushOps() calls can never interleave sends. */
  private flushChain: Promise<void> = Promise.resolve();
  /** Ids of ops THIS client sent — the broadcast echo is dropped by them. */
  private sentOpIds = new Set<string>();
  /** Active quiesce sources (pause toggle / print preview / print config /
   * image export). state.collabQuiesced is `size > 0`; the resume edge is the
   * last source clearing. */
  private quiesceSources = new Set<string>();
  /** Drains currently inside drainPending — with pendingOps.size, the L7
   * "quiet point" predicate (and the beforeunload prompt's). */
  private drainsInFlight = 0;
  /** True while a pagehide flush runs — sendOp rides fetch keepalive. */
  private flushKeepalive = false;
  /** Heartbeat timers of soft tile locks THIS client holds, keyed by tile id. */
  private tileLockHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
  /** In-flight lock acquires, keyed by tile id. releaseTileLock during the
   * flight marks `cancelled`; the resolving acquire then sends the wire
   * DELETE and never installs the heartbeat — a short drag / instant blur can
   * no longer leave a 30s orphan lock on the server. */
  private pendingLockAcquires = new Map<string, { cancelled: boolean }>();
  /** OUR opaque holder id, learned from the first successful lock acquire —
   * lets applyTileLock tell our own acquire echo from a STEAL of a tile we
   * still heartbeat (the store never learns the host user id any other way). */
  private ownLockHolderId: string | null = null;

  /* ---- wave-2 ephemera plumbing (same non-reactive doctrine as above). */

  /** Expiry sweep for remoteCursors/tileLocks; armed only while any exist. */
  private collabSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Trailing-throttle timer for outbound cursor frames. */
  private cursorSendTimer: ReturnType<typeof setTimeout> | null = null;
  /** Newest cursor authored inside the throttle window (sent on its edge). */
  private pendingCursor: { pageId: string; xFrac: number; yFrac: number } | null = null;
  /** Reentry guard: true while applyRemoteSlicerValue writes slicerValues, so
   * no code path can bounce an inbound shared-slicer value back out. */
  private applyingRemoteSlicerValue = false;

  constructor(
    private readonly api: DashboardsApi,
    /** Wave-2 outbound senders (host props threaded through the runtime);
     * absent members disable the corresponding channel. */
    private readonly collab: DashboardCollabSenders = {},
  ) {
    this.store = createStore<DashboardStoreState>(() => ({
      ...initialState,
      // The cursor toggle is a per-user preference, not session state.
      collabShowCursors: readShowCursorsPreference(),
    }));
  }

  private set(patch: Partial<DashboardStoreState>): void {
    this.store.setState(patch);
  }

  private get state(): DashboardStoreState {
    return this.store.getState();
  }

  /* ------------------------------------------------ live dispatch progress */

  /**
   * The host's realtime bridge calls this with each dispatch-progress event
   * its backend forwarded from IRcdDispatchProgressNotifier (e.g. the
   * tracker's SignalR rcdDispatchProgress event). This is deliberately the
   * ONLY store action a host pushes events INTO — everything else here is
   * user-driven. Out-of-order/stale events (a recipient event for a dispatch
   * we are no longer tracking) are dropped rather than inventing state; UIs
   * always have the polling fallback for ground truth.
   */
  applyDispatchProgress(event: DispatchProgressEvent): void {
    const progress = { ...this.state.dispatchProgress };
    switch (event.kind) {
      case 'started':
        progress[event.subscriptionId] = {
          dispatchId: event.dispatchId,
          subscriptionId: event.subscriptionId,
          subscriptionName: event.subscriptionName,
          trigger: event.trigger,
          status: 'running',
          recipientCount: event.recipientCount,
          startedUtc: event.startedUtc,
          recipients: {},
          sentCount: null,
          failedCount: null,
          optedOutCount: null,
          error: null,
          finishedUtc: null,
        };
        break;
      case 'recipient': {
        const entry = progress[event.subscriptionId];
        if (!entry || entry.dispatchId !== event.dispatchId) return;
        progress[event.subscriptionId] = {
          ...entry,
          recipients: {
            ...entry.recipients,
            [event.email]: {
              status: event.status,
              attempts: event.attempts,
              error: event.error,
            },
          },
        };
        break;
      }
      case 'finished': {
        const entry = progress[event.subscriptionId];
        if (entry !== undefined && entry.dispatchId !== event.dispatchId) return;
        // A finished without its started (bridge connected mid-send) still
        // paints the roll-up — the strip shows counts without per-recipient rows.
        progress[event.subscriptionId] = {
          dispatchId: event.dispatchId,
          subscriptionId: event.subscriptionId,
          subscriptionName: entry?.subscriptionName ?? '',
          trigger: entry?.trigger ?? 'manual',
          status: event.status,
          recipientCount:
            entry?.recipientCount ?? event.sentCount + event.failedCount + event.optedOutCount,
          startedUtc: entry?.startedUtc ?? event.finishedUtc,
          recipients: entry?.recipients ?? {},
          sentCount: event.sentCount,
          failedCount: event.failedCount,
          optedOutCount: event.optedOutCount,
          error: event.error,
          finishedUtc: event.finishedUtc,
        };
        break;
      }
    }

    this.set({ dispatchProgress: progress });
  }

  /** Drops tracked progress (one subscription, or all when omitted) — e.g. when the manager dialog closes. */
  clearDispatchProgress(subscriptionId?: number): void {
    if (subscriptionId === undefined) {
      this.set({ dispatchProgress: {} });
      return;
    }

    if (!(subscriptionId in this.state.dispatchProgress)) return;
    const progress = { ...this.state.dispatchProgress };
    delete progress[subscriptionId];
    this.set({ dispatchProgress: progress });
  }

  /**
   * Pushes the PRE-change document snapshot onto the undo stack (edit mode
   * only; capped at 50; any push clears the redo branch). Every doc-mutating
   * path calls this — mutateLayout is the central seam, and the two methods
   * that write `current` directly (addPage / removePage) plus multi-mutation
   * actions (groupHistory) push explicitly. `coalesce` merges rapid same-tag
   * calls (applyLayout drag storms within 400ms, updateChart slider storms on
   * one tile within 800ms) into ONE entry by keeping the first snapshot.
   */
  private pushHistory(coalesce?: HistoryCoalesce): void {
    // LIVE sessions never snapshot: their history is inverse OPS, recorded by
    // recordLocalOps at the same seams (locally-scoped undo doctrine).
    if (this.state.liveMode) return;
    if (this.historyDepth > 0) return;
    const current = this.state.current;
    if (!current || this.state.mode !== 'edit') return;
    const now = Date.now();
    const merge =
      coalesce !== undefined &&
      this.lastHistoryTag === coalesce.tag &&
      now - this.lastHistoryAt <= coalesce.windowMs &&
      this.undoStack.length > 0;
    this.lastHistoryTag = coalesce?.tag ?? null;
    this.lastHistoryAt = now;
    this.redoStack = [];
    if (!merge) {
      this.undoStack.push(
        structuredClone({ layout: current.layout, activePageId: this.state.activePageId }),
      );
      if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    }
    if (!this.state.canUndo || this.state.canRedo) this.set({ canUndo: true, canRedo: false });
  }

  /** Runs several doc mutations as ONE undo step. */
  private groupHistory(fn: () => void): void {
    if (this.state.liveMode) {
      // Live sessions group the INVERSE OPS of every inner mutation into one
      // locally-scoped history entry (recordLocalOps appends while depth > 0).
      this.historyDepth += 1;
      this.liveGroupEntry = this.liveGroupEntry ?? [];
      try {
        fn();
      } finally {
        this.historyDepth -= 1;
        if (this.historyDepth === 0) {
          const entry = this.liveGroupEntry;
          this.liveGroupEntry = null;
          this.lastHistoryTag = null;
          if (entry !== null && entry.length > 0) {
            this.liveRedoStack = [];
            this.liveUndoStack.push(entry);
            if (this.liveUndoStack.length > HISTORY_CAP) this.liveUndoStack.shift();
          }
          this.syncHistoryFlags();
        }
      }
      return;
    }
    this.pushHistory();
    this.historyDepth += 1;
    try {
      fn();
    } finally {
      this.historyDepth -= 1;
    }
  }

  /** Drops all stacks — snapshot AND live-op — (open/close/enterEdit/
   * discardEdits/live-session exit — NOT save). */
  private clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.liveUndoStack = [];
    this.liveRedoStack = [];
    this.liveGroupEntry = null;
    this.lastHistoryTag = null;
    if (this.state.canUndo || this.state.canRedo) this.set({ canUndo: false, canRedo: false });
  }

  /** Reflects the ACTIVE stacks (live-op vs snapshot) into the two booleans. */
  private syncHistoryFlags(): void {
    const live = this.state.liveMode;
    const canUndo = live ? this.liveUndoStack.length > 0 : this.undoStack.length > 0;
    const canRedo = live ? this.liveRedoStack.length > 0 : this.redoStack.length > 0;
    if (this.state.canUndo !== canUndo || this.state.canRedo !== canRedo) {
      this.set({ canUndo, canRedo });
    }
  }

  /**
   * Undo. DRAFT sessions restore the previous whole-doc snapshot (historic
   * behavior; dirties). LIVE sessions apply the top entry's inverse ops — a
   * locally-scoped revert touching ONLY elements this user changed — and emit
   * them through the same op pipeline so the revert syncs to collaborators.
   */
  undo(): void {
    const current = this.state.current;
    if (!current || this.state.mode !== 'edit') return;
    if (this.state.liveMode) {
      if (this.liveUndoStack.length === 0) return;
      const entry = this.liveUndoStack.pop()!;
      const redoEntry = this.applyLocalOpEntry(entry);
      if (redoEntry.length > 0) this.liveRedoStack.push(redoEntry);
      this.lastHistoryTag = null;
      this.syncHistoryFlags();
      return;
    }
    if (this.undoStack.length === 0) return;
    const snapshot = this.undoStack.pop()!;
    this.redoStack.push(
      structuredClone({ layout: current.layout, activePageId: this.state.activePageId }),
    );
    this.lastHistoryTag = null;
    this.applySnapshot(snapshot);
  }

  /** Re-applies the last undone step (edit mode only) — see undo(). */
  redo(): void {
    const current = this.state.current;
    if (!current || this.state.mode !== 'edit') return;
    if (this.state.liveMode) {
      if (this.liveRedoStack.length === 0) return;
      const entry = this.liveRedoStack.pop()!;
      const undoEntry = this.applyLocalOpEntry(entry);
      if (undoEntry.length > 0) {
        this.liveUndoStack.push(undoEntry);
        if (this.liveUndoStack.length > HISTORY_CAP) this.liveUndoStack.shift();
      }
      this.lastHistoryTag = null;
      this.syncHistoryFlags();
      return;
    }
    if (this.redoStack.length === 0) return;
    const snapshot = this.redoStack.pop()!;
    this.undoStack.push(
      structuredClone({ layout: current.layout, activePageId: this.state.activePageId }),
    );
    this.lastHistoryTag = null;
    this.applySnapshot(snapshot);
  }

  private applySnapshot(snapshot: HistorySnapshot): void {
    const current = this.state.current;
    if (!current) return;
    this.set({
      current: { ...current, layout: snapshot.layout },
      // The snapshot's page may have been added after (undo of addPage) — fall
      // back to a page that exists in the restored doc.
      activePageId: resolveActivePageId(snapshot.layout, snapshot.activePageId),
      dirty: true,
      selectedTileId: null,
      hoverHighlight: null,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    });
  }

  private mutateLayout(
    mutate: (layout: DashboardLayoutDoc) => DashboardLayoutDoc,
    coalesce?: HistoryCoalesce,
  ): void {
    const current = this.state.current;
    if (!current) return;
    this.pushHistory(coalesce);
    const nextLayout = mutate(current.layout);
    this.set({ current: { ...current, layout: nextLayout }, dirty: true });
    // THE emission decorator (COLLAB-DESIGN): every doc mutation funnels
    // through this seam (or addPage/removePage's decorated direct writes), so
    // diffing before/after here provably covers the whole action catalog.
    // recordLocalOps no-ops outside live edit sessions.
    this.recordLocalOps(current.layout, nextLayout, coalesce);
  }

  private mutatePages(
    mutate: (pages: DashboardPage[]) => DashboardPage[],
    coalesce?: HistoryCoalesce,
  ): void {
    this.mutateLayout((layout) => ({ ...layout, pages: mutate(pagesOf(layout)) }), coalesce);
  }

  /** Applies a tile-list mutation to the ACTIVE page (all tile ops route here). */
  private mutateActiveTiles(
    mutate: (tiles: DashboardTile[]) => DashboardTile[],
    coalesce?: HistoryCoalesce,
  ): void {
    const activePageId = this.state.activePageId;
    this.mutatePages(
      (pages) =>
        pages.map((page) =>
          page.id === activePageId ? { ...page, tiles: mutate(page.tiles) } : page,
        ),
      coalesce,
    );
  }

  /** Tiles of the active page ([] before a dashboard is open). */
  private activeTiles(): DashboardTile[] {
    const layout = this.state.current?.layout;
    if (!layout) return [];
    return pagesOf(layout).find((page) => page.id === this.state.activePageId)?.tiles ?? [];
  }

  /* ==================================================== collaborative editing
   * COLLAB-DESIGN wave 1: live-mode op emission, inbound application with the
   * dirty-hold merge doctrine, locally-scoped undo, soft tile locks, and the
   * reconnect-refetch resync. The HOST owns all transport: it joins the
   * dashboard-{id} SignalR group on live edit, forwards each RcdDashboardOp
   * event into applyRemoteOp, and calls resyncFromServer on reconnect — the
   * library never touches a socket (the applyDispatchProgress precedent).
   */

  /**
   * Emission decorator body: derives the ops one seam-level mutation produced
   * (structural doc diff — see collabOps), records their INVERSES as the
   * locally-scoped history entry, and buffers them for sending under the
   * mutation's own coalescing window (400ms drag storms / 800ms typing — the
   * exact windows the snapshot history already used). ONLY active during live
   * edit sessions; draft mode emits nothing (its Save PUT is the persistence).
   */
  private recordLocalOps(
    before: DashboardLayoutDoc,
    after: DashboardLayoutDoc,
    coalesce?: HistoryCoalesce,
  ): void {
    if (!this.state.liveMode || this.state.mode !== 'edit') return;
    if (before === after) return;
    const ops = diffLayoutDocs(before, after);
    if (ops.length === 0) return;

    const inverses = ops
      .map((op) => invertLocalOp(before, op))
      .filter((op): op is DashboardLocalOp => op !== null);
    if (this.historyDepth > 0) {
      // Inside groupHistory: PREPEND, so the entry's application order is the
      // reverse of the mutations' — each inverse lands on the doc state its
      // mutation started from.
      this.liveGroupEntry = [...inverses, ...(this.liveGroupEntry ?? [])];
    } else {
      const now = Date.now();
      const merge =
        coalesce !== undefined &&
        this.lastHistoryTag === coalesce.tag &&
        now - this.lastHistoryAt <= coalesce.windowMs &&
        this.liveUndoStack.length > 0;
      this.lastHistoryTag = coalesce?.tag ?? null;
      this.lastHistoryAt = now;
      this.liveRedoStack = [];
      // Same-tag bursts keep the FIRST inverse (the pre-burst state), exactly
      // like snapshot coalescing keeps the first snapshot.
      if (!merge && inverses.length > 0) {
        this.liveUndoStack.push(inverses);
        if (this.liveUndoStack.length > HISTORY_CAP) this.liveUndoStack.shift();
      }
      this.syncHistoryFlags();
    }

    this.bufferOps(ops, coalesce);
  }

  /**
   * Queues ops for sending. Newer ops on the same element MERGE into their
   * pending slot (per-element LWW — the latest payload is the whole truth;
   * see mergePendingPayloads for the two union cases), which is what turns a
   * drag/typing storm into ONE op. `dirty` mirrors "has un-persisted changes"
   * in live mode: raised here, cleared when the buffer drains.
   */
  private bufferOps(ops: DashboardLocalOp[], coalesce?: HistoryCoalesce): void {
    const flushAt = Date.now() + (coalesce?.windowMs ?? 0);
    for (const op of ops) {
      const key = pendingSlotKey(op);
      const existing = this.pendingOps.get(key);
      // Map.set on an existing key keeps its position — send order is
      // first-authored order (page.add stays ahead of tiles onto that page).
      this.pendingOps.set(key, {
        op: existing ? mergePendingPayloads(existing.op, op) : op,
        flushAt,
      });
    }
    if (this.state.liveMode && !this.state.dirty) this.set({ dirty: true });
    this.scheduleFlush();
  }

  /** (Re)arms the flush timer at the earliest pending deadline. */
  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    let earliest: number | null = null;
    for (const pending of this.pendingOps.values()) {
      if (earliest === null || pending.flushAt < earliest) earliest = pending.flushAt;
    }
    if (earliest === null) return;
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null;
        void this.flushOps();
      },
      Math.max(0, earliest - Date.now()),
    );
  }

  /** Drains the pending buffer (serialized — concurrent calls chain). */
  private flushOps(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.drainPending());
    return this.flushChain;
  }

  private async drainPending(): Promise<void> {
    this.drainsInFlight += 1;
    try {
      while (this.pendingOps.size > 0) {
        const current = this.state.current;
        if (!current || !this.state.liveMode) {
          // Session ended / degraded mid-drain — the doc still carries every
          // change (draft semantics take over); the buffer is moot.
          this.pendingOps.clear();
          return;
        }
        const first = this.pendingOps.entries().next().value as [string, PendingOp];
        const [key, pending] = first;
        // Take BEFORE the await: an edit landing on this element mid-send
        // becomes a fresh pending entry and goes out on the next iteration
        // instead of being silently dropped by a post-send delete.
        this.pendingOps.delete(key);
        const op = pending.op;
        const body: SendDashboardOpBody = {
          opId: newId(),
          targetKind: op.targetKind,
          targetId: op.targetId,
          payload: op.payload,
          baseUpdatedAtUtc: current.expectedUpdatedAtUtc,
        };
        // Remember BEFORE the await: the SignalR echo can beat the HTTP response.
        this.rememberSentOp(body.opId);
        try {
          const result = await this.sendOpWithRetry(current.id, body);
          const live = this.state.current;
          if (live && live.id === current.id) {
            // Our commit is the element's newest server state — any held remote
            // op for it is superseded (the collaborator's earlier write lost the
            // per-element race; theirs would arrive again only via a newer op).
            // A superseded hold is a DROPPED remote change: mark diverged so the
            // quiet-point resync re-fetches server truth instead of trusting
            // that nothing else rode on it.
            const conflictKey = opConflictKey(op.targetKind, op.targetId, op.payload);
            const superseded = conflictKey in this.state.heldRemoteOps;
            const { [conflictKey]: _superseded, ...held } = this.state.heldRemoteOps;
            const stamp = opResultStampOf(result) ?? live.expectedUpdatedAtUtc;
            this.set({
              current: { ...live, expectedUpdatedAtUtc: stamp },
              ...(superseded ? { heldRemoteOps: held, collabDiverged: true } : {}),
            });
          }
        } catch (error) {
          // op_target_missing (409): the op's required target vanished under a
          // collaborator's concurrent structure change. Per the server contract
          // this is the resync cue, NOT a delivery failure — drop the op (its
          // element no longer exists), refetch, and stop this drain: whatever
          // is still buffered flushes against the fresh baseline afterwards
          // (resyncFromServer re-arms the flush timer). The session stays live.
          if (error instanceof RcdApiError && error.errorCode === OP_TARGET_MISSING_ERROR) {
            void this.resyncFromServer();
            if (
              this.pendingOps.size === 0 &&
              this.state.liveMode &&
              this.state.mode === 'edit' &&
              this.state.dirty
            ) {
              this.set({ dirty: false });
            }
            return;
          }
          // Any other deterministic 4xx (tile_locked, permission_denied,
          // op_invalid, layout_size…) is a PER-OP verdict, never a session
          // failure: drop the op, tell the user, and mark diverged — the
          // quiet-point resync reverts the optimistic local apply to server
          // truth. The drain continues; the session STAYS LIVE.
          if (isOpScopedRejection(error)) {
            this.raiseOpBlockedNotice(op, error);
            this.set({ collabDiverged: true });
            continue;
          }
          // Transport / 5xx after the retry: the documented degrade doctrine.
          this.degradeToDraft(error);
          return;
        }
      }
      // Buffer drained: nothing un-persisted remains.
      if (this.state.liveMode && this.state.mode === 'edit' && this.state.dirty) {
        this.set({ dirty: false });
      }
    } finally {
      this.drainsInFlight -= 1;
      this.maybeResyncDiverged();
    }
  }

  /**
   * Toolbar toast for a per-op rejection (see drainPending). tile_locked names
   * the holder when the wave-2 lock chip already told us who it is.
   */
  private raiseOpBlockedNotice(op: DashboardLocalOp, error: RcdApiError): void {
    if (error.errorCode === TILE_LOCKED_ERROR) {
      const holder = op.targetId === null ? undefined : this.state.tileLocks[op.targetId]?.holderName;
      this.set({
        lockNotice:
          holder !== undefined
            ? `Your change was blocked — this tile is being edited by ${holder}.`
            : 'Your change was blocked — this tile is being edited by someone else.',
      });
      return;
    }
    this.set({ lockNotice: `Your change was blocked — ${messageOf(error)}` });
  }

  /**
   * L7 quiet point: once no local op is buffered or in flight, a diverged doc
   * re-fetches server truth and the flag clears. Runs after every drain and on
   * the quiesce resume edge; deferred while quiesced (the resume edge resyncs
   * anyway). resyncFromServer refuses a dirty post-degrade DRAFT — the flag
   * still clears then: the degrade banner and the save-time 409 own conflict
   * surfacing in that world, and a stuck "Syncing…" chip would lie.
   */
  private maybeResyncDiverged(): void {
    if (!this.state.collabDiverged) return;
    if (this.state.collabQuiesced) return;
    if (this.pendingOps.size > 0 || this.drainsInFlight > 0) return;
    void this.resyncFromServer().finally(() => {
      if (this.state.collabDiverged) this.set({ collabDiverged: false });
    });
  }

  /**
   * One transparent retry (same opId, so a commit-then-network-drop can be
   * deduplicated server-side); the second failure escalates to the caller.
   * Semantic 4xx rejections (op_invalid, forbidden, target_missing,
   * layout_size…) never retry — a deterministic answer cannot change.
   */
  private async sendOpWithRetry(dashboardId: number, body: SendDashboardOpBody) {
    const options = this.flushKeepalive ? { keepalive: true } : undefined;
    try {
      return await this.api.sendOp(dashboardId, body, options);
    } catch (error) {
      if (isOpScopedRejection(error)) throw error;
      return await this.api.sendOp(dashboardId, body, options);
    }
  }

  private rememberSentOp(opId: string): void {
    this.sentOpIds.add(opId);
    if (this.sentOpIds.size > SENT_OP_CAP) {
      const oldest = this.sentOpIds.values().next().value as string;
      this.sentOpIds.delete(oldest);
    }
  }

  /**
   * TRANSPORT/5xx delivery failed twice → the session DEGRADES TO DRAFT
   * SEMANTICS (documented failure doctrine; deterministic 4xx never lands
   * here — drainPending handles those per-op): emission stops (liveMode false
   * gates it), saveStatus surfaces the error, dirty stays true, and
   * Save/Discard return to the toolbar. Every change is still in the local
   * doc, so Save PUTs the whole doc over the last known baseline — a
   * concurrent editor's newer op still 409s that PUT honestly
   * (rcd.dashboard.stale). Ops committed BEFORE the failure are already
   * persisted; the baseline reflects them. The live inverse-op history cannot
   * drive snapshot undo, so history clears. Wiped holds count as dropped
   * remote changes (collabDiverged) — the quiet-point resync is refused while
   * the draft is dirty, which clears the flag and leaves conflict surfacing
   * to this banner + the save-time 409.
   */
  private degradeToDraft(error: unknown): void {
    this.pendingOps.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.liveUndoStack = [];
    this.liveRedoStack = [];
    this.liveGroupEntry = null;
    this.stopAllLockHeartbeats(false);
    this.set({
      liveMode: false,
      dirty: true,
      saveStatus: 'error',
      error: `Live sync failed — working offline from here. Save to retry. (${messageOf(error)})`,
      ...(Object.keys(this.state.heldRemoteOps).length > 0 ? { collabDiverged: true } : {}),
      heldRemoteOps: {},
      canUndo: false,
      canRedo: false,
    });
  }

  /**
   * Applies one live-history entry (a list of inverse ops) to the local doc
   * and EMITS it through the op pipeline, returning the entry that reverses it
   * (computed step-by-step against the evolving doc — that entry becomes the
   * redo/undo counterpart). Never touches the history stacks itself.
   */
  private applyLocalOpEntry(ops: DashboardLocalOp[]): DashboardLocalOp[] {
    const current = this.state.current;
    if (!current) return [];
    let layout = current.layout;
    const reversal: DashboardLocalOp[] = [];
    const applied: DashboardLocalOp[] = [];
    for (const op of ops) {
      const inverse = invertLocalOp(layout, op);
      const next = applyOpToDoc(layout, op.targetId, op.payload);
      if (next === null) continue;
      if (inverse !== null) reversal.unshift(inverse);
      applied.push(op);
      layout = next;
    }
    if (applied.length === 0) return [];
    this.set({
      current: { ...current, layout },
      selectedTileId: null,
      hoverHighlight: null,
      ...this.reconcileTransients(layout),
    });
    this.bufferOps(applied);
    return reversal;
  }

  /**
   * Inbound remote op — the host's realtime bridge forwards each
   * RcdDashboardOp hub event here verbatim (the second host→store event path
   * after applyDispatchProgress). Application reuses the same doc transform as
   * everything else, WITHOUT pushHistory and WITHOUT dirty. THE MERGE DOCTRINE
   * (tracker applyRealtimeSystemInput): an op targeting an element with local
   * uncommitted changes is HELD — the concurrency baseline advances, the local
   * element stays untouched, and the hold is surfaced in heldRemoteOps for the
   * UI to badge.
   *
   * Gates, in order: while QUIESCED (pause toggle / print / export) events are
   * DROPPED, never queued — the resume edge resyncFromServer instead, so a
   * long pause can never replay a stale backlog over fresh truth. And ops
   * apply only in VIEW mode or a LIVE edit session: a degraded (or solo
   * draft) edit session left the realtime group and its doc is a draft — a
   * late frame must not silently mutate what Save will PUT.
   */
  applyRemoteOp(event: DashboardOpEvent): void {
    const current = this.state.current;
    if (!current || current.id !== event.dashboardId) return;
    if (this.state.collabQuiesced) return;
    if (this.state.mode !== 'view' && !this.state.liveMode) return;
    if (this.sentOpIds.has(event.opId)) {
      // Our own echo: the POST response already applied it; only the baseline
      // may be newer (another op serialized between response and broadcast).
      this.advanceBaseline(event.resultUpdatedAtUtc);
      return;
    }
    // Parse BEFORE the hold check: the conflict key of a doc-level op depends
    // on what it touches (docSettingSet keys per scalar, pageReorder on its
    // own bucket) — see opConflictKey.
    let payload: DashboardOpPayload;
    try {
      payload = JSON.parse(event.payloadJson) as DashboardOpPayload;
    } catch {
      // Malformed frame — never guess; the baseline still advances, and the
      // dropped change marks the doc diverged so the quiet-point resync
      // repairs it (the frame's content is lost for good).
      this.advanceBaseline(event.resultUpdatedAtUtc);
      this.set({ collabDiverged: true });
      this.maybeResyncDiverged();
      return;
    }
    const conflictKey = opConflictKey(event.targetKind, event.targetId, payload);
    if (this.isConflictKeyDirty(conflictKey)) {
      this.advanceBaseline(event.resultUpdatedAtUtc);
      this.set({
        heldRemoteOps: { ...this.state.heldRemoteOps, [conflictKey]: event },
      });
      return;
    }
    this.applyRemotePayload(event, payload, conflictKey);
  }

  private applyRemotePayload(
    event: DashboardOpEvent,
    payload: DashboardOpPayload,
    conflictKey: string,
  ): void {
    const current = this.state.current;
    if (!current || current.id !== event.dashboardId) return;
    // Locally-scoped doctrine, second half: once a collaborator has written
    // this element, our older history entries for it must not revert THEIR
    // work — purge them (their newer write owns the element now).
    this.purgeLocalHistoryFor(conflictKey);
    const next = applyOpToDoc(current.layout, event.targetId, payload);
    if (next === null) {
      // Inapplicable to THIS doc (unknown target / newer-peer kind): the
      // change is dropped locally, so the doc is provisionally diverged from
      // the server truth that DID apply it — quiet-point resync repairs.
      this.advanceBaseline(event.resultUpdatedAtUtc);
      this.set({ collabDiverged: true });
      this.maybeResyncDiverged();
      return;
    }
    this.set({
      current: { ...current, layout: next, expectedUpdatedAtUtc: event.resultUpdatedAtUtc },
      ...this.reconcileTransients(next),
    });
  }

  /** Adopts a newer concurrency baseline without touching the doc. */
  private advanceBaseline(resultUpdatedAtUtc: string): void {
    const current = this.state.current;
    if (!current) return;
    this.set({ current: { ...current, expectedUpdatedAtUtc: resultUpdatedAtUtc } });
  }

  /**
   * "Locally dirty" for the hold doctrine: the conflict key has an authored-
   * but-unsent op in the buffer, OR it is a tile this client holds the soft
   * lock on (an open chart builder / focused text editor whose draft lives
   * outside the store until commit — the strongest reason locks exist).
   */
  private isConflictKeyDirty(conflictKey: string): boolean {
    if (conflictKey.startsWith('tile:') && this.tileLockHeartbeats.has(conflictKey.slice(5))) {
      return true;
    }
    for (const pending of this.pendingOps.values()) {
      if (
        opConflictKey(pending.op.targetKind, pending.op.targetId, pending.op.payload) ===
        conflictKey
      ) {
        return true;
      }
    }
    return false;
  }

  /** Strips ops targeting one conflict key from the live history stacks. */
  private purgeLocalHistoryFor(conflictKey: string): void {
    if (!this.state.liveMode) return;
    const strip = (stack: DashboardLocalOp[][]): DashboardLocalOp[][] =>
      stack
        .map((entry) =>
          entry.filter(
            (op) => opConflictKey(op.targetKind, op.targetId, op.payload) !== conflictKey,
          ),
        )
        .filter((entry) => entry.length > 0);
    this.liveUndoStack = strip(this.liveUndoStack);
    this.liveRedoStack = strip(this.liveRedoStack);
    this.syncHistoryFlags();
  }

  /** A held remote op lands once its element becomes clean WITHOUT a local
   * write superseding it (chart-builder Cancel, drag abort). */
  private applyHeldOpIfClean(conflictKey: string): void {
    const held = this.state.heldRemoteOps[conflictKey];
    if (held === undefined || this.isConflictKeyDirty(conflictKey)) return;
    const { [conflictKey]: _applied, ...rest } = this.state.heldRemoteOps;
    this.set({ heldRemoteOps: rest });
    try {
      const payload = JSON.parse(held.payloadJson) as DashboardOpPayload;
      this.applyRemotePayload(held, payload, conflictKey);
    } catch {
      // Malformed payload — the hold is dropped un-applied; quiet-point
      // resync repairs (see collabDiverged).
      this.set({ collabDiverged: true });
      this.maybeResyncDiverged();
    }
  }

  /* --------------------------------------------------- live-visibility L1/L2 */

  /**
   * Adds/removes one named QUIESCE source (see state.collabQuiesced): the
   * user's pause toggle ('pause'), the print preview, the print config
   * dialog's live thumbnail, an image-export rasterization. The flag is the
   * OR of all sources; on the resume edge (last source cleared) during a live
   * session or view membership the store ALWAYS resyncFromServer — gated
   * events were dropped, never queued, so refetch is the only honest recovery.
   */
  setCollabQuiesce(source: string, quiesced: boolean): void {
    const before = this.quiesceSources.size > 0;
    if (quiesced) this.quiesceSources.add(source);
    else this.quiesceSources.delete(source);
    const after = this.quiesceSources.size > 0;
    if (before === after) return;
    this.set({ collabQuiesced: after });
    if (after) return;
    const current = this.state.current;
    const member =
      current !== null &&
      isCollabLiveDashboard(current) &&
      (this.state.liveMode || this.state.mode === 'view');
    if (member) {
      void this.resyncFromServer().finally(() => {
        // The refetch IS the divergence repair — don't chase it with another.
        if (this.state.collabDiverged) this.set({ collabDiverged: false });
      });
      return;
    }
    this.maybeResyncDiverged();
  }

  /** "Pause live updates" (Live menu) — the user-held quiesce source.
   * Session-only; unpausing resyncs via the shared resume edge. */
  setLiveUpdatesPaused(paused: boolean): void {
    if (this.state.collabPaused === paused) return;
    this.set({ collabPaused: paused });
    this.setCollabQuiesce('pause', paused);
  }

  /**
   * "Show live cursors" (Live menu) — one toggle for BOTH directions: off
   * stops our outbound frames (sendCursorThrottled no-ops), drops inbound
   * ones, and clears what is already rendered; the view hides the overlay on
   * the same flag. Persisted per user (localStorage).
   */
  setShowLiveCursors(show: boolean): void {
    if (this.state.collabShowCursors === show) return;
    this.set({ collabShowCursors: show, ...(show ? {} : { remoteCursors: {} }) });
    if (!show) this.cancelCursorSend();
    writeShowCursorsPreference(show);
  }

  /** True while authored ops are still unsent/in flight — the view's
   * beforeunload prompt reads this synchronously. */
  hasUnsentOps(): boolean {
    return this.pendingOps.size > 0 || this.drainsInFlight > 0;
  }

  /**
   * Public drain of the pending op buffer (the view wires `pagehide` here).
   * With `keepalive` the sends ride fetch's keepalive so they can outlive the
   * page — best effort by nature (host fetchers may ignore the flag).
   */
  flushPendingOps(options?: { keepalive?: boolean }): Promise<void> {
    if (options?.keepalive !== true) return this.flushOps();
    this.flushKeepalive = true;
    return this.flushOps().finally(() => {
      this.flushKeepalive = false;
    });
  }

  /* ------------------------------------------------------ soft tile locks */

  /**
   * Acquires the soft lock on a tile (chart-builder open / text-editor focus /
   * drag start) and starts its TTL heartbeat. Resolves `{ok: false}` ONLY on a
   * positive "someone else holds it" (409) — which also raises lockNotice for
   * the toolbar chip; lock-SERVICE failures never block editing (soft locks
   * are conflict avoidance, not enforcement) and solo/draft sessions skip the
   * traffic entirely (no collaborators exist, and the endpoints may not).
   */
  async acquireTileLock(tileId: string): Promise<{ ok: boolean; message?: string }> {
    const current = this.state.current;
    if (!current || !this.state.liveMode) return { ok: true };
    // Track the flight: releaseTileLock landing BEFORE this resolves (a short
    // drag, an instant editor blur) marks it cancelled — then the resolved
    // claim is released on the wire immediately and no heartbeat ever starts,
    // instead of the tile staying server-locked for the full TTL.
    const flight = { cancelled: false };
    this.pendingLockAcquires.set(tileId, flight);
    let claim: Awaited<ReturnType<DashboardsApi['acquireTileLock']>> | undefined;
    try {
      claim = await this.api.acquireTileLock(current.id, tileId);
    } catch (error) {
      if (this.pendingLockAcquires.get(tileId) === flight) this.pendingLockAcquires.delete(tileId);
      const locked =
        error instanceof RcdApiError &&
        (error.errorCode === TILE_LOCKED_ERROR || error.status === 409);
      if (!locked) return { ok: true };
      const message = 'This tile is being edited by someone else right now.';
      this.set({ lockNotice: message });
      return { ok: false, message };
    }
    if (this.pendingLockAcquires.get(tileId) === flight) this.pendingLockAcquires.delete(tileId);
    // Our opaque holder id (host user id as the library stores it) — the only
    // way applyTileLock can tell our own echo from a steal of our tile.
    if (claim?.holderUserId != null) this.ownLockHolderId = String(claim.holderUserId);
    if (flight.cancelled) {
      void this.api.releaseTileLock(current.id, tileId).catch(() => undefined);
      return { ok: true };
    }
    this.startLockHeartbeat(current.id, tileId);
    // Wave-2 echo race: the broadcast of OUR acquire can beat this HTTP
    // response (the sentOpIds lesson) and land in tileLocks before the
    // heartbeat exists to identify it as ours — clear it, or the user's own
    // tile would wear an "Editing: you" chip for the next 30 s.
    if (tileId in this.state.tileLocks) {
      const { [tileId]: _ownEcho, ...rest } = this.state.tileLocks;
      this.set({ tileLocks: rest });
    }
    return { ok: true };
  }

  /**
   * Releases a held soft lock (builder close / editor blur / drag end). Fire-
   * and-forget on the wire (disconnect cleanup expires it server-side anyway).
   * If a remote op was held for this tile and no local write superseded it,
   * it applies NOW — the collaborator's edit was only deferred, never lost.
   */
  releaseTileLock(tileId: string): void {
    // Acquire still in flight: cancel it — the resolving acquire sends the
    // wire DELETE itself (racing a DELETE past the un-committed POST could
    // release nothing and then leave the late claim orphaned).
    const flight = this.pendingLockAcquires.get(tileId);
    if (flight !== undefined) flight.cancelled = true;
    const timer = this.tileLockHeartbeats.get(tileId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.tileLockHeartbeats.delete(tileId);
    }
    const current = this.state.current;
    if (current && this.state.liveMode && timer !== undefined) {
      void this.api.releaseTileLock(current.id, tileId).catch(() => undefined);
    }
    this.applyHeldOpIfClean(`tile:${tileId}`);
  }

  /** Dismisses the soft-lock toolbar notice. */
  clearLockNotice(): void {
    if (this.state.lockNotice !== null) this.set({ lockNotice: null });
  }

  private startLockHeartbeat(dashboardId: number, tileId: string): void {
    if (this.tileLockHeartbeats.has(tileId)) return;
    const timer = setInterval(() => {
      this.api.acquireTileLock(dashboardId, tileId).catch((error: unknown) => {
        const lost =
          error instanceof RcdApiError &&
          (error.errorCode === TILE_LOCKED_ERROR || error.status === 409);
        if (!lost) return; // transient service hiccup — keep heartbeating
        // The lock expired and someone else claimed it (e.g. we were offline
        // past the TTL). Stop claiming and tell the user; their next commit
        // still wins the element per LWW, which the notice makes honest.
        clearInterval(timer);
        this.tileLockHeartbeats.delete(tileId);
        this.set({ lockNotice: 'Your lock on a tile expired — someone else is editing it now.' });
      });
    }, TILE_LOCK_HEARTBEAT_MS);
    this.tileLockHeartbeats.set(tileId, timer);
  }

  /** Stops every heartbeat; optionally releases the locks on the wire. */
  private stopAllLockHeartbeats(releaseRemote: boolean): void {
    const current = this.state.current;
    for (const [tileId, timer] of this.tileLockHeartbeats) {
      clearInterval(timer);
      if (releaseRemote && current) {
        void this.api.releaseTileLock(current.id, tileId).catch(() => undefined);
      }
    }
    this.tileLockHeartbeats.clear();
  }

  /* ==================================== wave 2 — presence, cursors, locks,
   * shared slicers. All four inbound apply* actions are host→store event
   * forwarders (the applyDispatchProgress / applyRemoteOp pattern): guarded
   * on the open dashboard's id, VIEW-MODE SAFE, and they never touch dirty
   * or history — this is ephemeral session state, not document state. The
   * outbound half (cursor frames, shared-slicer values) goes through the
   * host-injected DashboardCollabSenders; without those props the sends
   * silently no-op (portal/demo hosts) while receiving keeps working.
   */

  /**
   * Presence roster from the host's tracker (full set per event, never
   * deltas). Deduped by user id — a user editing in two tabs is one person —
   * and no-op frames are skipped so identical rosters never re-render.
   */
  applyEditorsChanged(event: DashboardEditorsChangedEvent): void {
    const current = this.state.current;
    if (!current || current.id !== event.dashboardId) return;
    if (this.state.collabQuiesced) return; // dropped — rosters are full-set, the next frame heals
    const editors: DashboardCollabEditor[] = [];
    const seen = new Set<number>();
    for (const editor of event.editors ?? []) {
      if (typeof editor?.userId !== 'number' || seen.has(editor.userId)) continue;
      seen.add(editor.userId);
      editors.push({ userId: editor.userId, userName: editor.userName || String(editor.userId) });
    }
    const prev = this.state.collabEditors;
    const unchanged =
      prev.length === editors.length &&
      prev.every((p, i) => p.userId === editors[i]!.userId && p.userName === editors[i]!.userName);
    if (unchanged) return;
    this.set({ collabEditors: editors });
  }

  /**
   * One collaborator pointer frame. ALL received cursors are kept — the HOST
   * filters the sender's own echo before forwarding (pinned contract: the
   * store never learns the local user's numeric host id, so it could not
   * drop self reliably). Fractions clamp defensively into 0..1; the arrival
   * stamp drives the ~6 s TTL sweep (local clock — immune to sender skew).
   */
  applyRemoteCursor(event: DashboardRemoteCursorEvent): void {
    const current = this.state.current;
    if (!current || current.id !== event.dashboardId) return;
    // Quiesced OR cursors toggled off: frames drop (the overlay is hidden
    // either way, and the ~10 Hz stream would churn state for nothing).
    if (this.state.collabQuiesced || !this.state.collabShowCursors) return;
    if (
      typeof event.userId !== 'number' ||
      typeof event.pageId !== 'string' ||
      !Number.isFinite(event.xFrac) ||
      !Number.isFinite(event.yFrac)
    ) {
      return; // malformed frame — never render a pointer at NaN
    }
    const cursor: RemoteCursor = {
      userId: event.userId,
      userName: event.userName || String(event.userId),
      pageId: event.pageId,
      xFrac: clamp01(event.xFrac),
      yFrac: clamp01(event.yFrac),
      at: event.at,
      receivedAt: Date.now(),
    };
    this.set({ remoteCursors: { ...this.state.remoteCursors, [event.userId]: cursor } });
    this.armCollabSweep();
  }

  /**
   * A soft tile lock changed hands (fresh acquire / steal / release — never
   * heartbeats; see the state field's doc for the aging consequence). While
   * our heartbeat runs on the event's tile, an event carrying OUR holder id
   * is the echo of our own acquire — dropped, or the user's own tile would
   * badge "Editing: you". An event carrying ANOTHER user's id there is a
   * STEAL (our TTL lapsed and they claimed it): stop claiming immediately —
   * heartbeat + notice, then render the thief's chip — instead of waiting up
   * to a heartbeat interval for our next 409. No tile-existence check on
   * purpose: a lock can precede its tile's first op (chart builder).
   */
  applyTileLock(event: DashboardTileLockEvent): void {
    const current = this.state.current;
    if (!current || current.id !== event.dashboardId) return;
    if (this.state.collabQuiesced) return;
    if (typeof event.tileId !== 'string' || event.tileId === '') return;
    if (event.released) {
      if (!(event.tileId in this.state.tileLocks)) return;
      const { [event.tileId]: _released, ...rest } = this.state.tileLocks;
      this.set({ tileLocks: rest });
      return;
    }
    if (this.tileLockHeartbeats.has(event.tileId)) {
      const stolen =
        this.ownLockHolderId !== null && String(event.holderUserId) !== this.ownLockHolderId;
      if (!stolen) return; // own claim's echo (or an unidentifiable one — assume echo)
      const timer = this.tileLockHeartbeats.get(event.tileId)!;
      clearInterval(timer);
      this.tileLockHeartbeats.delete(event.tileId);
      this.set({ lockNotice: 'Your lock on a tile expired — someone else is editing it now.' });
      // fall through: the thief's chip renders like any foreign lock
    }
    this.set({
      tileLocks: {
        ...this.state.tileLocks,
        [event.tileId]: {
          tileId: event.tileId,
          holderUserId: event.holderUserId,
          holderName: event.holderName || String(event.holderUserId),
          expiresAtUtc: event.expiresAtUtc,
        },
      },
    });
    this.armCollabSweep();
  }

  /**
   * A collaborator picked a value on a SHARED slicer. Applies to the local
   * runtime selection WITHOUT rebroadcast — the write happens under the
   * reentry guard and bypasses setSlicerValue entirely, so no future funnel
   * through that action can bounce an inbound value back out (echo loops are
   * structurally impossible: receivers never send). Unknown/non-slicer tiles
   * drop the frame (a tileRemove op may have raced it); malformed JSON drops
   * rather than guesses.
   */
  applyRemoteSlicerValue(event: DashboardRemoteSlicerValueEvent): void {
    const current = this.state.current;
    if (!current || current.id !== event.dashboardId) return;
    // Dropped while quiesced (a shared pick is ephemeral session state — the
    // next pick heals; the resume resync repairs the doc, not this channel).
    if (this.state.collabQuiesced) return;
    const tile = pagesOf(current.layout)
      .flatMap((page) => page.tiles)
      .find((t) => t.id === event.tileId);
    if (!tile || !isSlicerTile(tile)) return;
    let value: SlicerValue;
    try {
      value = JSON.parse(event.valueJson) as SlicerValue;
    } catch {
      return;
    }
    this.applyingRemoteSlicerValue = true;
    try {
      // Same shape as setSlicerValue's write, including the bookmark-current
      // reset — the view diverged from any applied bookmark either way.
      this.set({
        slicerValues: { ...this.state.slicerValues, [event.tileId]: value },
        lastAppliedBookmarkId: null,
      });
    } finally {
      this.applyingRemoteSlicerValue = false;
    }
  }

  /**
   * Outbound pointer frame, trailing-throttled to ~10 Hz (CURSOR_SEND_MS):
   * the first frame of a burst sends immediately (a pointer that appears
   * NOW, not 100 ms late), every further frame inside the window replaces
   * the pending one, and the window's edge sends the newest — so a stroke's
   * final position always lands even though intermediate frames drop. No-ops
   * without the host's onSendCursor prop and outside live (shared) sessions.
   */
  sendCursorThrottled(pageId: string, xFrac: number, yFrac: number): void {
    const send = this.collab.onSendCursor;
    const current = this.state.current;
    if (!send || !current || !isCollabLiveDashboard(current)) return;
    // ONE toggle, both directions: cursors off means we neither render others'
    // nor broadcast our own; quiesced sessions go silent outbound too.
    if (!this.state.collabShowCursors || this.state.collabQuiesced) return;
    if (!Number.isFinite(xFrac) || !Number.isFinite(yFrac)) return;
    const cursor = { pageId, xFrac: clamp01(xFrac), yFrac: clamp01(yFrac) };
    if (this.cursorSendTimer !== null) {
      this.pendingCursor = cursor;
      return;
    }
    try {
      send(cursor);
    } catch {
      // Host bridge hiccup — drop the frame; the next one repaints anyway.
    }
    this.cursorSendTimer = setTimeout(() => {
      this.cursorSendTimer = null;
      const pending = this.pendingCursor;
      this.pendingCursor = null;
      // Re-entering delivers the trailing frame AND re-arms the window, so a
      // continuous drag settles into one send per window.
      if (pending !== null) this.sendCursorThrottled(pending.pageId, pending.xFrac, pending.yFrac);
    }, CURSOR_SEND_MS);
  }

  /**
   * Stops the cursor stream (pointerleave): drops the pending trailing frame
   * so a stale position never fires after the pointer left the grid. There
   * is deliberately no "cursor gone" wire event — receivers age the pointer
   * out by TTL, exactly like chat typing indicators.
   */
  cancelCursorSend(): void {
    this.pendingCursor = null;
    if (this.cursorSendTimer !== null) {
      clearTimeout(this.cursorSendTimer);
      this.cursorSendTimer = null;
    }
  }

  /** Arms the shared cursor/lock expiry sweep (idempotent). */
  private armCollabSweep(): void {
    if (this.collabSweepTimer !== null) return;
    this.collabSweepTimer = setInterval(() => this.sweepCollabEphemera(), COLLAB_SWEEP_MS);
  }

  /**
   * Ages out cursors (~6 s after their last frame, LOCAL clock) and locks
   * (past expiresAtUtc — the server's clock; skew within the 30 s TTL only
   * shifts when a chip fades, never correctness, since released events clear
   * eagerly). Disarms itself once both maps are empty so an idle dashboard
   * runs zero timers.
   */
  private sweepCollabEphemera(): void {
    const now = Date.now();
    const state = this.state;
    const patch: Partial<DashboardStoreState> = {};
    const cursorEntries = Object.entries(state.remoteCursors);
    const liveCursors = cursorEntries.filter(([, c]) => now - c.receivedAt < CURSOR_TTL_MS);
    if (liveCursors.length !== cursorEntries.length) {
      patch.remoteCursors = Object.fromEntries(liveCursors) as Record<number, RemoteCursor>;
    }
    const lockEntries = Object.entries(state.tileLocks);
    // NaN parse (malformed stamp) compares false → dropped now: a lock we
    // cannot age honestly must not stick forever.
    const liveLocks = lockEntries.filter(([, l]) => Date.parse(l.expiresAtUtc) > now);
    if (liveLocks.length !== lockEntries.length) {
      patch.tileLocks = Object.fromEntries(liveLocks);
    }
    if (Object.keys(patch).length > 0) this.set(patch);
    const empty =
      Object.keys(patch.remoteCursors ?? state.remoteCursors).length === 0 &&
      Object.keys(patch.tileLocks ?? state.tileLocks).length === 0;
    if (empty && this.collabSweepTimer !== null) {
      clearInterval(this.collabSweepTimer);
      this.collabSweepTimer = null;
    }
  }

  /** Drops the wave-2 timers + pending sends (dashboard open/close). */
  private stopCollabEphemera(): void {
    this.cancelCursorSend();
    if (this.collabSweepTimer !== null) {
      clearInterval(this.collabSweepTimer);
      this.collabSweepTimer = null;
    }
  }

  /* ------------------------------------------------------------- resync */

  /**
   * Reconnect = refetch, never replay (COLLAB-DESIGN): re-GETs the dashboard
   * and reconciles against the local dirty set. THE HOST WIRES CONNECTIVITY —
   * it calls this from its realtime reconnect handler (the library owns no
   * socket); nothing inside the library invokes it.
   *
   *  - Live edit session: the fresh doc becomes the base; authored-but-unsent
   *    pending ops replay onto it (they flush against the new baseline next),
   *    and tiles this client holds locks on keep their LOCAL version (an open
   *    builder/editor mid-edit). Held remote ops clear — the fresh doc IS the
   *    server truth they were part of.
   *  - Solo DRAFT session with local edits: untouched — never clobber a draft
   *    or advance its stamp; the save-time 409 is the honest conflict channel.
   *  - View mode / clean edit: a straight in-place refresh.
   */
  async resyncFromServer(): Promise<void> {
    const current = this.state.current;
    if (!current) return;
    if (this.state.mode === 'edit' && !this.state.liveMode && this.state.dirty) return;
    let detail: Awaited<ReturnType<DashboardsApi['getDashboard']>>;
    try {
      detail = await this.api.getDashboard(current.id);
    } catch (error) {
      this.set({ error: messageOf(error) });
      return;
    }
    const live = this.state.current;
    if (!live || live.id !== current.id) return; // navigated away meanwhile
    const fresh = toOpen(detail);
    let layout = fresh.layout;
    if (this.state.liveMode && this.state.mode === 'edit') {
      for (const pending of this.pendingOps.values()) {
        layout = applyOpToDoc(layout, pending.op.targetId, pending.op.payload) ?? layout;
      }
      for (const tileId of this.tileLockHeartbeats.keys()) {
        const holder = pagesOf(live.layout).find((p) => p.tiles.some((t) => t.id === tileId));
        const tile = holder?.tiles.find((t) => t.id === tileId);
        if (holder && tile) {
          layout =
            applyOpToDoc(layout, tileId, { kind: 'tileUpsert', tile, pageId: holder.id }) ??
            layout;
        }
      }
    }
    this.set({
      current: { ...fresh, layout },
      heldRemoteOps: {},
      ...this.reconcileTransients(layout),
    });
    this.scheduleFlush();
  }

  /**
   * Transient-state sweep after a non-user doc change (remote op / live undo /
   * resync): the same orphan cleanup removeTile/removePage do inline —
   * selections, slicer values, cross-filter sources, drillthrough pages and
   * parameter selections must never reference elements the doc no longer has;
   * NEW remote parameters seed their default selection.
   */
  private reconcileTransients(layout: DashboardLayoutDoc): Partial<DashboardStoreState> {
    const state = this.state;
    const pages = pagesOf(layout);
    const tileIds = new Set(pages.flatMap((page) => page.tiles.map((tile) => tile.id)));
    const pageIds = new Set(pages.map((page) => page.id));
    const patch: Partial<DashboardStoreState> = {
      activePageId: resolveActivePageId(layout, state.activePageId),
    };
    const slicerKeys = Object.keys(state.slicerValues);
    if (slicerKeys.some((id) => !tileIds.has(id))) {
      patch.slicerValues = Object.fromEntries(
        Object.entries(state.slicerValues).filter(([id]) => tileIds.has(id)),
      );
    }
    if (state.crossFilters.some((f) => !tileIds.has(f.sourceTileId))) {
      patch.crossFilters = state.crossFilters.filter((f) => tileIds.has(f.sourceTileId));
    }
    if (state.hoverHighlight !== null && !tileIds.has(state.hoverHighlight.sourceTileId)) {
      patch.hoverHighlight = null;
    }
    if (
      state.drillthrough !== null &&
      (!pageIds.has(state.drillthrough.sourcePageId) ||
        !pageIds.has(state.drillthrough.targetPageId))
    ) {
      patch.drillthrough = null;
    }
    if (state.selectedTileId !== null && !tileIds.has(state.selectedTileId)) {
      patch.selectedTileId = null;
    }
    const parameters = layout.parameters ?? [];
    const next: Record<string, number> = {};
    let selectionsChanged = Object.keys(state.parameterSelections).some(
      (id) => !parameters.some((p) => p.id === id),
    );
    for (const parameter of parameters) {
      const existing = state.parameterSelections[parameter.id];
      const value = clampIndex(
        existing ?? parameter.defaultIndex ?? 0,
        parameter.options.length,
      );
      next[parameter.id] = value;
      if (value !== existing) selectionsChanged = true;
    }
    if (selectionsChanged) patch.parameterSelections = next;
    return patch;
  }

  /**
   * Fire-and-forget op sends OUTSIDE a live session — the view-mode bookmark
   * path (see commitBookmarkMutation). Sequential, retry-once each; the last
   * committed stamp is returned so the caller can advance the baseline.
   */
  private async sendOpsDirect(
    dashboardId: number,
    ops: DashboardLocalOp[],
  ): Promise<{ ok: true; stamp: string | null } | { ok: false; message: string }> {
    let stamp: string | null = null;
    for (const op of ops) {
      const body: SendDashboardOpBody = {
        opId: newId(),
        targetKind: op.targetKind,
        targetId: op.targetId,
        payload: op.payload,
        baseUpdatedAtUtc: this.state.current?.expectedUpdatedAtUtc ?? '',
      };
      this.rememberSentOp(body.opId);
      try {
        const result = await this.sendOpWithRetry(dashboardId, body);
        stamp = opResultStampOf(result) ?? stamp;
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    }
    return { ok: true, stamp };
  }

  async loadList(): Promise<void> {
    this.set({ listStatus: 'loading' });
    try {
      const list = await this.api.listDashboards();
      this.set({ list, listStatus: 'ok' });
    } catch (error) {
      this.set({ listStatus: 'error', error: messageOf(error) });
    }
  }

  async open(id: number): Promise<void> {
    // C3: a live session's authored-but-unsent ops must not die with a
    // dashboard switch — drain them (bounded) BEFORE the reset clears them.
    if (this.state.liveMode && this.state.mode === 'edit' && this.pendingOps.size > 0) {
      await this.flushBounded();
    }
    const detail = await this.api.getDashboard(id);
    const current = toOpen(detail);
    this.clearHistory();
    this.resetCollabSession();
    // Wave-2 ephemera are per-dashboard: presence/cursors/locks of the
    // previous dashboard must never bleed into this one (the host re-joins
    // the new group and re-seeds presence). enterEdit deliberately does NOT
    // do this — presence survives mode switches within one dashboard.
    this.stopCollabEphemera();
    this.set({
      current,
      mode: 'view',
      dirty: false,
      draftBackup: null,
      activePageId: firstPageId(current.layout),
      selectedTileId: null,
      slicerValues: {},
      crossFilters: [],
      hoverHighlight: null,
      parameterSelections: defaultParameterSelections(current.layout),
      drillthrough: null,
      lastAppliedBookmarkId: null,
      filterCardOverrides: {},
      viewFitOverride: null,
      liveMode: false,
      heldRemoteOps: {},
      lockNotice: null,
      collabEditors: [],
      remoteCursors: {},
      tileLocks: {},
      // Pause is session-only (dropped as a quiesce source in reset above);
      // other sources (print/export overlays) clear via their own unmounts.
      collabPaused: false,
      collabQuiesced: this.quiesceSources.size > 0,
      collabDiverged: false,
      saveStatus: 'idle',
      error: null,
    });
  }

  /**
   * Drops every non-reactive collab artifact of the previous session. Lock
   * heartbeats RELEASE ON THE WIRE here (C13a): an open()-switch or session
   * reset that merely stopped the timers left collaborators blocked behind a
   * dying claim for the full 30s TTL.
   */
  private resetCollabSession(): void {
    this.stopAllLockHeartbeats(true);
    for (const flight of this.pendingLockAcquires.values()) flight.cancelled = true;
    this.pendingLockAcquires.clear();
    this.pendingOps.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.sentOpIds.clear();
    this.quiesceSources.delete('pause');
  }

  /** Bounded best-effort drain for navigation seams (see FLUSH_ON_EXIT_TIMEOUT_MS). */
  private flushBounded(): Promise<void> {
    if (this.pendingOps.size === 0) return Promise.resolve();
    return Promise.race([
      this.flushOps(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, FLUSH_ON_EXIT_TIMEOUT_MS);
      }),
    ]);
  }

  async create(name: string, modelId: number | null): Promise<number | null> {
    this.set({ saveStatus: 'loading', error: null });
    try {
      const detail = await this.api.createDashboard({ name, modelId, layout: emptyLayout() });
      const current = toOpen(detail);
      this.clearHistory();
      this.set({
        current,
        mode: 'edit',
        dirty: false,
        activePageId: firstPageId(current.layout),
        saveStatus: 'ok',
      });
      void this.loadList();
      return detail.id;
    } catch (error) {
      this.set({ saveStatus: 'error', error: messageOf(error) });
      return null;
    }
  }

  async close(): Promise<void> {
    // C3: drain authored-but-unsent live ops (bounded) before they die with
    // the session. Callers may fire-and-forget — the guard below keeps a
    // concurrent open() from being wiped by this close finishing late.
    const closing = this.state.current;
    if (closing && this.state.liveMode && this.pendingOps.size > 0) {
      await this.flushBounded();
      const live = this.state.current;
      if (!live || live.id !== closing.id) return; // superseded by a newer open()
    }
    this.clearHistory();
    // Locks die with the session (resetCollabSession releases them remotely so
    // collaborators unblock before the TTL); leftover unsent ops drop with the
    // doc they edit.
    this.resetCollabSession();
    // Wave-2 timers/pending sends die too (state resets via initialState).
    this.stopCollabEphemera();
    this.set({
      ...initialState,
      list: this.state.list,
      listStatus: this.state.listStatus,
      // The clipboard outlives the open dashboard on purpose — copy on one
      // dashboard, paste on the next (still never persisted).
      chartClipboard: this.state.chartClipboard,
      // Personal measures belong to the USER, not to the open dashboard.
      personalMeasures: this.state.personalMeasures,
      // Per-user preference and any still-mounted overlay quiesce survive too.
      collabShowCursors: this.state.collabShowCursors,
      collabQuiesced: this.quiesceSources.size > 0,
    });
  }

  enterEdit(): void {
    const current = this.state.current;
    if (!current) return;
    this.clearHistory();
    const liveMode = isLiveCollaborative(current);
    if (liveMode) this.resetCollabSession();
    // View-mode filter tweaks are personal state — edit mode always shows and
    // mutates the authored doc, so overrides reset here.
    //
    // LIVE sessions take no draft backup: there is no Discard (ops persist as
    // they happen; scoped undo is the revert affordance) and a whole-doc
    // restore could roll back collaborators' concurrent work. The HOST joins
    // the dashboard-{id} realtime group when it observes liveMode+edit.
    this.set({
      mode: 'edit',
      liveMode,
      draftBackup: liveMode ? null : structuredClone(current),
      filterCardOverrides: {},
      heldRemoteOps: {},
      lockNotice: null,
    });
  }

  discardEdits(): void {
    // Live sessions have no Discard (the toolbar replaces it with scoped
    // undo); guard against stray callers — a whole-doc restore would silently
    // revert collaborators' work.
    if (this.state.liveMode) return;
    this.clearHistory();
    const backup = this.state.draftBackup;
    const live = this.state.current;
    this.set({
      mode: 'view',
      dirty: false,
      draftBackup: null,
      selectedTileId: null,
      crossFilters: [],
      // The restore may drop pages/bookmarks these transients reference.
      drillthrough: null,
      lastAppliedBookmarkId: null,
      // Pages added during the edit vanish with the restore — fall back to a
      // page that exists in the backup when the active one is among them.
      ...(backup
        ? {
            // The concurrency stamp and publish flag are LIVE server state,
            // not draft content: setPublish mid-edit advances both, and
            // restoring the backup's stale expectedUpdatedAtUtc would make
            // every future save 409 (rcd.dashboard.stale) forever.
            current: {
              ...backup,
              ...(live
                ? { expectedUpdatedAtUtc: live.expectedUpdatedAtUtc, isShared: live.isShared }
                : {}),
            },
            activePageId: resolveActivePageId(backup.layout, this.state.activePageId),
          }
        : {}),
    });
  }

  /**
   * Draft mode: PUTs the whole doc (unchanged historic path — always carrying
   * expectedUpdatedAtUtc, which the backend now REQUIRES for updates). LIVE
   * mode: the toolbar's "Done" — every edit already persisted as an op, so
   * this only flushes the coalescing buffer and exits the edit session; no
   * doc PUT happens (one would pointlessly rewrite what the ops just wrote,
   * and could clobber a collaborator's newer element).
   */
  async save(): Promise<boolean> {
    const current = this.state.current;
    if (!current) return false;
    if (this.state.liveMode) return this.finishLiveSession();

    this.set({ saveStatus: 'loading', error: null });
    try {
      const saved = await this.api.updateDashboard(current.id, {
        name: current.name,
        description: current.description,
        modelId: current.modelId,
        layout: current.layout,
        isShared: current.isShared,
        expectedUpdatedAtUtc: current.expectedUpdatedAtUtc,
      });
      const next = toOpen(saved);
      this.set({
        current: next,
        mode: 'view',
        dirty: false,
        draftBackup: null,
        // Page ids survive the round-trip, so the user stays on their page.
        activePageId: resolveActivePageId(next.layout, this.state.activePageId),
        saveStatus: 'ok',
      });
      void this.loadList();
      return true;
    } catch (error) {
      // Post-degrade (or plain draft) whole-doc conflict: the generic stale
      // text says "reload" without saying what happens to the local work —
      // spell out that the changes are safe HERE and reloading discards them,
      // so the user copies anything vital first. The doc stays intact locally.
      const stale = error instanceof RcdApiError && error.errorCode === 'rcd.dashboard.stale';
      this.set({
        saveStatus: 'error',
        error: stale
          ? 'This dashboard changed on the server while you were editing. Your changes are still here — copy anything important, then reload to get the latest version and re-apply them.'
          : messageOf(error),
      });
      return false;
    }
  }

  /** "Done" (live mode): flush the op buffer, drop the locks, exit edit. */
  private async finishLiveSession(): Promise<boolean> {
    this.set({ saveStatus: 'loading', error: null });
    await this.flushOps();
    // A degraded flush already flipped to draft semantics with saveStatus
    // 'error' — stay IN edit mode so the user can Save (PUT) or keep working.
    if (!this.state.liveMode) return false;
    this.stopAllLockHeartbeats(true);
    this.clearHistory();
    // Holds wiped here were never applied — the exiting doc is stale where
    // they landed server-side; the quiet-point resync (view mode: straight
    // refresh) repairs it right after this set.
    const droppedHolds = Object.keys(this.state.heldRemoteOps).length > 0;
    this.set({
      mode: 'view',
      liveMode: false,
      dirty: false,
      draftBackup: null,
      selectedTileId: null,
      heldRemoteOps: {},
      lockNotice: null,
      saveStatus: 'ok',
      ...(droppedHolds ? { collabDiverged: true } : {}),
    });
    if (droppedHolds) this.maybeResyncDiverged();
    // The list's updatedAt moved with every op; refresh it like a save does.
    void this.loadList();
    return true;
  }

  addTile(chart: ChartSpec): void {
    // The promotion rule fires HERE, where a chart enters the document; the
    // promotion and the tile are one undo step.
    this.groupHistory(() => {
      const saved = this.promotePersonalMeasuresFor(chart);
      this.mutateActiveTiles((tiles) => {
        const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
        const tile: DashboardTile = {
          id: newId(),
          layout: { x: 0, y: maxY, w: 12, h: 8, minW: 4, minH: 4 },
          chart: saved,
        };
        return [...tiles, tile];
      });
    });
  }

  updateChart(tileId: string, chart: ChartSpec): void {
    const write = (saved: ChartSpec, coalesce?: HistoryCoalesce): void =>
      this.mutateActiveTiles(
        (tiles) => tiles.map((t) => (t.id === tileId ? { ...t, chart: saved } : t)),
        coalesce,
      );

    // A chart edited into citing a PERSONAL measure promotes it on the way in
    // (the promotion rule). That is a one-off structural change, not a slider
    // storm, so it groups with the chart write instead of coalescing.
    if (this.citedPersonalMeasures(chart).length > 0) {
      this.groupHistory(() => write(this.promotePersonalMeasuresFor(chart)));
      return;
    }

    // Same-tile bursts (FormatPanel slider storms) coalesce into one undo step.
    write(chart, { tag: `updateChart:${tileId}`, windowMs: 800 });
  }

  removeTile(tileId: string): void {
    // The tile removal + its orphaned filter cards are ONE undo step.
    this.groupHistory(() => {
      this.mutateActiveTiles((tiles) => tiles.filter((t) => t.id !== tileId));
      // Visual-scope filter cards targeting the removed tile go with it.
      const cards = this.state.current?.layout.filterCards ?? [];
      if (cards.some((c) => c.scope === 'visual' && c.targetTileId === tileId)) {
        this.mutateFilterCards((all) =>
          all.filter((c) => !(c.scope === 'visual' && c.targetTileId === tileId)),
        );
      }
    });
    if (this.state.selectedTileId === tileId) {
      this.set({ selectedTileId: null });
    }
    // Defensive: a removed slicer tile must not keep filtering charts.
    if (tileId in this.state.slicerValues) {
      const { [tileId]: _removed, ...rest } = this.state.slicerValues;
      this.set({ slicerValues: rest });
    }
    // Same for filters raised from a removed cross-filter source chart.
    if (this.state.crossFilters.some((f) => f.sourceTileId === tileId)) {
      this.set({ crossFilters: this.state.crossFilters.filter((f) => f.sourceTileId !== tileId) });
    }
    // …and a removed hover-highlight source.
    if (this.state.hoverHighlight?.sourceTileId === tileId) {
      this.set({ hoverHighlight: null });
    }
  }

  duplicateTile(tileId: string): void {
    this.mutateActiveTiles((tiles) => {
      const source = tiles.find((t) => t.id === tileId);
      if (!source) return tiles;
      // Free placement (no auto-compaction): drop the copy below ALL content
      // so it can never overlap an existing tile.
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const copy: DashboardTile = {
        id: newId(),
        layout: { ...source.layout, x: source.layout.x, y: maxY },
        ...(source.kind ? { kind: source.kind } : {}),
        ...(source.chart ? { chart: cloneChartForCopy(source.chart, { suffix: true }) } : {}),
        ...(source.slicer
          ? { slicer: structuredClone({ ...source.slicer, label: `${source.slicer.label} (copy)` }) }
          : {}),
        ...(source.text ? { text: structuredClone(source.text) } : {}),
        ...(source.image ? { image: structuredClone(source.image) } : {}),
        ...(source.button ? { button: structuredClone(source.button) } : {}),
        ...(source.buttonGroup ? { buttonGroup: structuredClone(source.buttonGroup) } : {}),
      };
      return [...tiles, copy];
    });
  }

  /** Grid callback: items carry tile ids + new geometry (active page only). */
  applyLayout(items: { id: string; x: number; y: number; w: number; h: number }[]): void {
    const byId = new Map(items.map((i) => [i.id, i]));
    // Drag/resize storms (RGL fires per animation step) are one undo step.
    this.mutateActiveTiles(
      (tiles) =>
        tiles.map((tile) => {
          const next = byId.get(tile.id);
          if (!next) return tile;
          const changed =
            next.x !== tile.layout.x ||
            next.y !== tile.layout.y ||
            next.w !== tile.layout.w ||
            next.h !== tile.layout.h;
          return changed
            ? { ...tile, layout: { ...tile.layout, x: next.x, y: next.y, w: next.w, h: next.h } }
            : tile;
        }),
      { tag: 'applyLayout', windowMs: 400 },
    );
  }

  selectTile(tileId: string | null): void {
    this.set({ selectedTileId: tileId });
  }

  /** Adds a slicer TILE to the active page; variant defaults to checklist.
   *  The fieldParam variant passes parameterId and empty table/column. */
  addSlicer(def: {
    table?: string;
    column?: string;
    label: string;
    variant?: SlicerVariant;
    parameterId?: string | null;
  }): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'slicer',
        layout: { x: 0, y: maxY, w: 6, h: 5, minW: 3, minH: 3 },
        slicer: {
          table: def.table ?? '',
          column: def.column ?? '',
          label: def.label,
          variant: def.variant ?? 'checklist',
          ...(def.parameterId != null ? { parameterId: def.parameterId } : {}),
        },
      };
      return [...tiles, tile];
    });
  }

  /** Patches a slicer tile's spec (variant, label, targets, showClear).
   *  Same-tile bursts (config-menu typing, the "Last N" custom box) coalesce
   *  into one undo step, mirroring updateChart's slider-storm rule. */
  updateSlicer(tileId: string, patch: Partial<SlicerTileSpec>): void {
    this.mutateActiveTiles(
      (tiles) =>
        tiles.map((t) => (t.id === tileId && t.slicer ? { ...t, slicer: { ...t.slicer, ...patch } } : t)),
      { tag: `updateSlicer:${tileId}`, windowMs: 800 },
    );
  }

  /** Removes a slicer tile and its selection. */
  removeSlicer(tileId: string): void {
    this.removeTile(tileId);
  }

  /**
   * Sets a slicer's runtime value. WAVE 2 (`options.broadcast`): when the
   * slicer is marked SHARED (SlicerTileSpec.shared) and this dashboard is a
   * live collaborative one, the new value also goes out through the host's
   * onSendSlicerValue prop so every viewer's slicer follows — ephemeral
   * session state on the wire, never persisted. `broadcast: false` is the
   * escape hatch for NON-GESTURE writes that merely derive local state:
   * the relativeDate default-preset seeding on open (broadcasting it would
   * blast the authored default over collaborators' current shared pick every
   * time anyone opens the dashboard) and the periodic preset re-computation
   * (every client derives the same dates from the shared preset locally —
   * broadcasting would have N clients spamming identical values per refresh
   * tick). Inbound values never re-enter here (applyRemoteSlicerValue writes
   * directly), and the reentry guard makes that a hard invariant.
   */
  setSlicerValue(slicerId: string, value: SlicerValue, options?: { broadcast?: boolean }): void {
    // Any slicer change diverges from the last-applied bookmark's snapshot.
    this.set({
      slicerValues: { ...this.state.slicerValues, [slicerId]: value },
      lastAppliedBookmarkId: null,
    });
    if (options?.broadcast === false || this.applyingRemoteSlicerValue) return;
    const send = this.collab.onSendSlicerValue;
    const current = this.state.current;
    if (!send || !current || !isCollabLiveDashboard(current)) return;
    const tile = pagesOf(current.layout)
      .flatMap((page) => page.tiles)
      .find((t) => t.id === slicerId);
    if (!tile || !isSlicerTile(tile) || tile.slicer.shared !== true) return;
    try {
      // JSON `null` travels for a cleared slicer — receivers clear too.
      send({ tileId: slicerId, valueJson: JSON.stringify(value ?? null) });
    } catch {
      // Host bridge hiccup — the local selection stands; sharing is best-effort.
    }
  }

  /**
   * Sets/clears the transient hover highlight. Writes only when the payload
   * actually differs (same source + label + dimension is a no-op) so hover
   * jitter never storms the store; a null clears.
   */
  setHoverHighlight(next: HoverHighlight | null): void {
    const current = this.state.hoverHighlight;
    if (current === null && next === null) return;
    if (
      current !== null &&
      next !== null &&
      current.sourceTileId === next.sourceTileId &&
      current.label === next.label &&
      current.dimension.table === next.dimension.table &&
      current.dimension.column === next.dimension.column
    ) {
      return;
    }
    this.set({ hoverHighlight: next });
  }

  /* -------------------------------------------------------- text/image tiles */

  /** Adds a rich-text tile to the active page (default placeholder content). */
  addTextTile(): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'text',
        layout: { x: 0, y: maxY, w: 8, h: 4, minW: 2, minH: 2 },
        text: { html: sanitizeRichHtml('<p>Text</p>') },
      };
      return [...tiles, tile];
    });
  }

  /** Adds an image tile to the active page (spec built by the add dialog). */
  addImageTile(spec: ImageTileSpec): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'image',
        layout: { x: 0, y: maxY, w: 8, h: 6, minW: 2, minH: 2 },
        image: { ...spec, src: safeImageSrc(spec.src) },
      };
      return [...tiles, tile];
    });
  }

  /** Patches a text tile's spec; html always passes through the sanitizer.
   *  Same-tile bursts coalesce like updateChart/updateSlicer — this was the
   *  one typing path missing its tag (COLLAB-DESIGN fix): the config card's
   *  Name box writes per keystroke, and in live mode the tag is also what
   *  folds a typing burst into ONE op instead of one per keystroke. */
  updateTextTile(tileId: string, patch: Partial<TextTileSpec>): void {
    const safe = patch.html === undefined ? patch : { ...patch, html: sanitizeRichHtml(patch.html) };
    this.mutateActiveTiles(
      (tiles) =>
        tiles.map((t) => (t.id === tileId && t.text ? { ...t, text: { ...t.text, ...safe } } : t)),
      { tag: `updateTextTile:${tileId}`, windowMs: 800 },
    );
  }

  /** Patches an image tile's spec; src is re-validated (data:image / https only). */
  updateImageTile(tileId: string, patch: Partial<ImageTileSpec>): void {
    const safe = patch.src === undefined ? patch : { ...patch, src: safeImageSrc(patch.src) };
    this.mutateActiveTiles((tiles) =>
      tiles.map((t) => (t.id === tileId && t.image ? { ...t, image: { ...t.image, ...safe } } : t)),
    );
  }

  /** Adds a navigation-button tile to the active page (spec built by the add dialog).
   *  The rich label + advanced CSS sanitize on EVERY write, same doctrine as
   *  text tiles (sanitizeRichHtml / sanitizeButtonCss). */
  addButtonTile(spec: ButtonTileSpec): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'button',
        // NO minW/minH seeded (0.14.1/A3): withKindMinima takes Math.max with
        // the STORED constraints, so a seeded floor could never be lowered
        // again by a later release — the grid owns the content-aware floor.
        layout: { x: 0, y: maxY, w: 4, h: 2 },
        button: sanitizeButtonFields(spec),
      };
      return [...tiles, tile];
    });
  }

  /** Patches a button tile's spec; html/customCss always pass the sanitizers. */
  updateButtonTile(tileId: string, patch: Partial<ButtonTileSpec>): void {
    const safe = sanitizeButtonFieldsPatch(patch);
    this.mutateActiveTiles((tiles) =>
      tiles.map((t) => (t.id === tileId && t.button ? { ...t, button: { ...t.button, ...safe } } : t)),
    );
  }

  /** Adds a button-GROUP tile to the active page (spec built by the group
   *  dialog). Same layout class and sanitize doctrine as single buttons —
   *  every button's rich label + advanced CSS pass the sanitizers here and on
   *  every later write. */
  addButtonGroupTile(spec: ButtonGroupTileSpec): void {
    this.mutateActiveTiles((tiles) => {
      const maxY = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
      const tile: DashboardTile = {
        id: newId(),
        kind: 'buttonGroup',
        // NO minW/minH seeded — see addButtonTile (0.14.1/A3).
        layout: { x: 0, y: maxY, w: 8, h: 2 },
        buttonGroup: sanitizeButtonGroupSpec(spec),
      };
      return [...tiles, tile];
    });
  }

  /** Patches a button-group tile's spec (group settings and/or the whole
   *  buttons list); every button's html/customCss pass the sanitizers. Rides
   *  the same mutateActiveTiles seam as updateButtonTile, so live-mode op
   *  emission is automatic (the seam-diff decorator). */
  updateButtonGroupTile(tileId: string, patch: Partial<ButtonGroupTileSpec>): void {
    const safe = sanitizeButtonGroupContainer(
      patch.buttons === undefined
        ? patch
        : { ...patch, buttons: patch.buttons.map(sanitizeButtonFields) },
    );
    this.mutateActiveTiles((tiles) =>
      tiles.map((t) =>
        t.id === tileId && t.buttonGroup
          ? { ...t, buttonGroup: { ...t.buttonGroup, ...safe } }
          : t,
      ),
    );
  }

  /* ------------------------------------------------------------------ pages */

  /** Appends an empty page (auto "Page N") and makes it active. */
  addPage(name?: string): void {
    const current = this.state.current;
    if (!current) return;
    const pages = pagesOf(current.layout);
    const page: DashboardPage = {
      id: newId(),
      name: name?.trim() || nextPageName(pages),
      tiles: [],
    };
    // Writes `current` directly (not via mutateLayout) — push explicitly and
    // run the op-emission decorator explicitly too (the second direct-write
    // seam beside removePage).
    this.pushHistory();
    const nextLayout = { ...current.layout, pages: [...pages, page] };
    this.set({
      current: { ...current, layout: nextLayout },
      dirty: true,
      activePageId: page.id,
      selectedTileId: null,
      // Page-scoped cross-filters die with the page switch; dashboard-scoped
      // ones survive (same doctrine as setActivePage).
      ...(this.scopeOf() === 'page' ? { crossFilters: [] } : {}),
    });
    this.recordLocalOps(current.layout, nextLayout);
  }

  /** Effective cross-filter scope of the open dashboard (default 'page'). */
  private scopeOf(): CrossFilterScope {
    return this.state.current?.layout.crossFilterScope ?? 'page';
  }

  renamePage(pageId: string, name: string): void {
    const next = name.trim();
    if (next === '') return;
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page || page.name === next) return;
    this.mutatePages((pages) => pages.map((p) => (p.id === pageId ? { ...p, name: next } : p)));
  }

  /** Sets the tab accent color (fixed palette hex) or clears it with null. */
  setPageColor(pageId: string, color: string | null): void {
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page || (page.color ?? null) === color) return;
    this.mutatePages((pages) => pages.map((p) => (p.id === pageId ? { ...p, color } : p)));
  }

  /**
   * Removes a page and every tile on it. No-op while it is the only page.
   * Removing the active page activates its right neighbor (left when it was
   * last). Slicer selections of the removed page's tiles are dropped; the
   * cross-filter clears when its source lived there.
   */
  removePage(pageId: string): void {
    const current = this.state.current;
    if (!current) return;
    const pages = pagesOf(current.layout);
    if (pages.length <= 1) return;
    const index = pages.findIndex((p) => p.id === pageId);
    const removed = index === -1 ? undefined : pages[index];
    if (!removed) return;
    const nextPages = pages.filter((p) => p.id !== pageId);
    const neighbor = nextPages[Math.min(index, nextPages.length - 1)] ?? nextPages[0];
    const removedIds = new Set(removed.tiles.map((t) => t.id));
    const selected = this.state.selectedTileId;
    // The removed page's page-scope cards and visual-scope cards targeting its
    // tiles are orphans — drop them (all-pages cards survive, of course).
    const cards = current.layout.filterCards ?? [];
    const nextCards = cards.filter(
      (c) =>
        !(c.scope === 'page' && c.pageId === pageId) &&
        !(c.scope === 'visual' && c.targetTileId != null && removedIds.has(c.targetTileId)),
    );
    // Writes `current` directly (not via mutateLayout) — push explicitly and
    // run the op-emission decorator explicitly (see addPage).
    this.pushHistory();
    const nextLayout = {
      ...current.layout,
      pages: nextPages,
      ...(nextCards.length !== cards.length ? { filterCards: nextCards } : {}),
    };
    this.set({
      current: {
        ...current,
        layout: nextLayout,
      },
      dirty: true,
      activePageId:
        this.state.activePageId === pageId ? (neighbor?.id ?? null) : this.state.activePageId,
      slicerValues: Object.fromEntries(
        Object.entries(this.state.slicerValues).filter(([id]) => !removedIds.has(id)),
      ),
      crossFilters: this.state.crossFilters.filter((f) => !removedIds.has(f.sourceTileId)),
      // Drillthrough context tied to the removed page (either end) is orphaned.
      drillthrough:
        this.state.drillthrough &&
        (this.state.drillthrough.sourcePageId === pageId ||
          this.state.drillthrough.targetPageId === pageId)
          ? null
          : this.state.drillthrough,
      selectedTileId: selected !== null && removedIds.has(selected) ? null : selected,
    });
    this.recordLocalOps(current.layout, nextLayout);
  }

  /**
   * Switches the visible page. Under the default 'page' cross-filter scope
   * the transient cross-filters reset (their source charts are no longer on
   * screen); under 'dashboard' scope they survive and keep filtering the new
   * page's tiles. Slicer selections persist per their tiles and re-apply when
   * their page is revisited. Never dirties the draft.
   */
  setActivePage(pageId: string): void {
    if (pageId === this.state.activePageId) return;
    const current = this.state.current;
    if (!current || !pagesOf(current.layout).some((p) => p.id === pageId)) return;
    // Page changes diverge from the last-applied bookmark (it captures pageId).
    this.set({
      activePageId: pageId,
      ...(this.scopeOf() === 'page' ? { crossFilters: [] } : {}),
      hoverHighlight: null,
      selectedTileId: null,
      lastAppliedBookmarkId: null,
    });
  }

  /** Sets or clears a page's phone layout (persisted with the doc). */
  setPageMobileLayout(pageId: string, mobileLayout: PageMobileLayout | null): void {
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page) return;
    if (stableStringify(page.mobileLayout ?? null) === stableStringify(mobileLayout)) return;
    this.mutatePages((pages) =>
      pages.map((p) => {
        if (p.id !== pageId) return p;
        if (mobileLayout !== null) return { ...p, mobileLayout };
        const { mobileLayout: _removed, ...rest } = p;
        return rest;
      }),
    );
  }

  /** Sets or clears a page's drillthrough target config (persisted with the doc). */
  setPageDrillthrough(pageId: string, drillthrough: PageDrillthrough | null): void {
    const current = this.state.current;
    if (!current) return;
    const page = pagesOf(current.layout).find((p) => p.id === pageId);
    if (!page) return;
    if (stableStringify(page.drillthrough ?? null) === stableStringify(drillthrough)) return;
    this.mutatePages((pages) =>
      pages.map((p) => {
        if (p.id !== pageId) return p;
        if (drillthrough !== null) return { ...p, drillthrough };
        const { drillthrough: _removed, ...rest } = p;
        return rest;
      }),
    );
  }

  /** Reorders a page one slot left/right (tab drag-free reordering). */
  movePage(pageId: string, direction: 'left' | 'right'): void {
    const current = this.state.current;
    if (!current) return;
    const pages = pagesOf(current.layout);
    const index = pages.findIndex((p) => p.id === pageId);
    if (index === -1) return;
    const target = direction === 'left' ? index - 1 : index + 1;
    if (target < 0 || target >= pages.length) return;
    this.mutatePages((all) => {
      const next = [...all];
      const [page] = next.splice(index, 1);
      if (!page) return all;
      next.splice(target, 0, page);
      return next;
    });
  }

  /* ----------------------------------------------------------- filter cards */

  private mutateFilterCards(
    mutate: (cards: FilterCard[]) => FilterCard[],
    coalesce?: HistoryCoalesce,
  ): void {
    this.mutateLayout(
      (layout) => ({ ...layout, filterCards: mutate(layout.filterCards ?? []) }),
      coalesce,
    );
  }

  /** Card with any view-mode personal overrides applied. */
  private effectiveFilterCard(card: FilterCard): FilterCard {
    const override = this.state.filterCardOverrides[card.id];
    if (!override) return card;
    return {
      ...card,
      ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
      ...(override.basicValues !== undefined ? { basicValues: override.basicValues } : {}),
    };
  }

  /** Adds a Filters-pane card (id assigned here); returns the new id. */
  addFilterCard(card: Omit<FilterCard, 'id'>): string {
    const id = newId();
    this.mutateFilterCards((cards) => [...cards, { ...card, id }]);
    return id;
  }

  /**
   * Patches a card. Edit mode writes the layout doc. View mode routes to the
   * TRANSIENT overrides and honors only `disabled` / `basicValues` — viewers
   * tweak filters without editing the dashboard; anything else is ignored.
   */
  updateFilterCard(id: string, patch: Partial<Omit<FilterCard, 'id'>>): void {
    if (this.state.mode === 'view') {
      if (patch.disabled === undefined && patch.basicValues === undefined) return;
      const override: FilterCardOverride = {
        ...this.state.filterCardOverrides[id],
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
        ...(patch.basicValues !== undefined ? { basicValues: patch.basicValues } : {}),
      };
      // Filter tweaks diverge from the last-applied bookmark's snapshot.
      this.set({
        filterCardOverrides: { ...this.state.filterCardOverrides, [id]: override },
        lastAppliedBookmarkId: null,
      });
      return;
    }
    // Same-card bursts (typing in an advanced-condition value box) coalesce
    // into one undo step — Ctrl+Z after typing "1000" must not leave "100".
    this.mutateFilterCards(
      (cards) => cards.map((c) => (c.id === id ? { ...c, ...patch, id } : c)),
      { tag: `filterCard:${id}`, windowMs: 800 },
    );
    this.set({ lastAppliedBookmarkId: null });
  }

  /** Removes a card (and any transient override riding on it). */
  removeFilterCard(id: string): void {
    this.mutateFilterCards((cards) => cards.filter((c) => c.id !== id));
    if (id in this.state.filterCardOverrides) {
      const { [id]: _removed, ...rest } = this.state.filterCardOverrides;
      this.set({ filterCardOverrides: rest });
    }
  }

  /** Flips a card's enabled state (view mode: transient override, not the doc). */
  toggleFilterCard(id: string): void {
    const card = (this.state.current?.layout.filterCards ?? []).find((c) => c.id === id);
    if (!card) return;
    this.updateFilterCard(id, { disabled: !(this.effectiveFilterCard(card).disabled ?? false) });
  }

  /**
   * Cards the Filters pane lists for a page: all-pages cards, the page's own
   * page-scope cards, and visual-scope cards whose target tile lives on the
   * page. View-mode overrides are already applied; doc order is preserved.
   */
  visibleFilterCards(pageId: string | null): FilterCard[] {
    const layout = this.state.current?.layout;
    if (!layout || pageId === null) return [];
    const tileIds = new Set(
      (pagesOf(layout).find((p) => p.id === pageId)?.tiles ?? []).map((t) => t.id),
    );
    return (layout.filterCards ?? [])
      .filter(
        (card) =>
          card.scope === 'allPages' ||
          (card.scope === 'page' && card.pageId === pageId) ||
          (card.scope === 'visual' && card.targetTileId != null && tileIds.has(card.targetTileId)),
      )
      .map((card) => this.effectiveFilterCard(card));
  }

  /* -------------------------------------------------------------- filtering */

  /**
   * Activates/merges the click-to-highlight cross-filter emitted by a chart
   * tile. Modifier semantics (Power BI-like; the caller maps clicks to
   * `mode`):
   *
   *  - 'replace' (plain click, Shift+click): the clicked point's filter
   *    becomes the ONLY active cross-filter. Clicking the currently sole
   *    active selection again toggles everything off (historic feel).
   *  - 'add' (Ctrl/Cmd+click): a DIFFERENT field gains its own filter
   *    alongside the existing ones (one per table.column, AND-composed); the
   *    SAME field toggles the clicked value in/out of that field's
   *    accumulated set (clause becomes 'in'; removing the last value removes
   *    the filter). Date-bucket fields cannot OR disjoint ranges in an
   *    AND-composed filter list, so a Ctrl-click on a second bucket extends
   *    the field's range to the SPANNING range (min start – max end) and the
   *    label says so ('Jul 2025 – Sep 2025'); Ctrl-clicking the exact active
   *    range toggles it off. Blank (isNull) cannot OR with values either —
   *    Ctrl-clicking blank replaces that field's set with the blank filter
   *    (and vice versa).
   *
   * `kind` records what was clicked on the source ('axis' datum by default;
   * 'legend' for legendMode 'crossFilter' selections) — the filtering path is
   * identical, only the source tile's emphasis rendering differs.
   */
  applyCrossFilter(input: {
    sourceTileId: string;
    clause: FilterClause;
    label: string;
    categoryLabel: string;
    kind?: 'axis' | 'legend';
    mode?: 'replace' | 'add';
  }): void {
    const { mode = 'replace' } = input;
    const filters = this.state.crossFilters;
    const next = buildCrossFilter(input);
    if (mode === 'replace') {
      const sole = filters.length === 1 ? filters[0] : undefined;
      if (
        sole &&
        sole.sourceTileId === input.sourceTileId &&
        stableStringify(sole.clause) === stableStringify(input.clause)
      ) {
        this.set({ crossFilters: [] });
        return;
      }
      this.set({ crossFilters: [next] });
      return;
    }
    const key = crossFilterFieldKey(input.clause);
    const index = filters.findIndex((f) => crossFilterFieldKey(f.clause) === key);
    if (index === -1) {
      this.set({ crossFilters: [...filters, next] });
      return;
    }
    const existing = filters[index]!;
    if (stableStringify(existing.clause) === stableStringify(input.clause)) {
      // Ctrl-click on the field's exact active selection: toggle the field off.
      this.set({ crossFilters: filters.filter((_, i) => i !== index) });
      return;
    }
    const merged = mergeCrossFilters(existing, next);
    this.set({
      crossFilters:
        merged === null
          ? filters.filter((_, i) => i !== index)
          : filters.map((f, i) => (i === index ? merged : f)),
    });
  }

  /**
   * Replaces one field's accumulated value set outright (the indicator chip's
   * "Edit value…" popover). Writes through the same shape Ctrl-click
   * accumulation produces; an empty set removes the field's filter. No-op
   * when the field has no active cross-filter (the popover only edits
   * existing chips).
   */
  setCrossFilterValues(table: string, column: string, values: CrossFilterValue[]): void {
    const filters = this.state.crossFilters;
    const index = filters.findIndex(
      (f) => f.clause.table === table && f.clause.column === column,
    );
    const existing = index === -1 ? undefined : filters[index];
    if (!existing) return;
    if (values.length === 0) {
      this.set({ crossFilters: filters.filter((_, i) => i !== index) });
      return;
    }
    const replacement = crossFilterFromValues(existing, values);
    this.set({
      crossFilters: filters.map((f, i) => (i === index ? replacement : f)),
    });
  }

  /** Clears the one cross-filter on (table, column), leaving the rest active. */
  removeCrossFilter(table: string, column: string): void {
    const filters = this.state.crossFilters;
    const next = filters.filter((f) => !(f.clause.table === table && f.clause.column === column));
    if (next.length !== filters.length) this.set({ crossFilters: next });
  }

  /**
   * Clears the filters a specific source tile raised (optionally only one
   * kind) — the legend-clear path: a chart clearing its own legend selection
   * must never wipe another tile's filters.
   */
  clearCrossFiltersFromSource(sourceTileId: string, kind?: 'axis' | 'legend'): void {
    const filters = this.state.crossFilters;
    const next = filters.filter(
      (f) => !(f.sourceTileId === sourceTileId && (kind === undefined || (f.kind ?? 'axis') === kind)),
    );
    if (next.length !== filters.length) this.set({ crossFilters: next });
  }

  /** Clears every active cross-filter. */
  clearCrossFilters(): void {
    if (this.state.crossFilters.length > 0) this.set({ crossFilters: [] });
  }

  /**
   * Sets the dashboard-wide cross-filter scope (persisted with the layout).
   * Narrowing back to 'page' drops any filters whose source tile does not
   * live on the active page — they only existed because of the wider scope.
   */
  setCrossFilterScope(scope: CrossFilterScope): void {
    const current = this.state.current;
    if (!current || (current.layout.crossFilterScope ?? 'page') === scope) return;
    this.mutateLayout((layout) => ({ ...layout, crossFilterScope: scope }));
    if (scope === 'page') {
      const activeIds = new Set(this.activeTiles().map((t) => t.id));
      const filters = this.state.crossFilters;
      const next = filters.filter((f) => activeIds.has(f.sourceTileId));
      if (next.length !== filters.length) this.set({ crossFilters: next });
    }
  }

  /** Selections of the ACTIVE page's slicer tiles (other pages' slicers do not leak). */
  activeFilters(): FilterClause[] {
    const clauses: FilterClause[] = [];
    for (const tile of this.activeTiles()) {
      if (!isSlicerTile(tile)) continue;
      const clause = slicerClauseOf(this.state.slicerValues[tile.id]);
      if (clause != null) clauses.push(clause);
    }
    return clauses;
  }

  /**
   * Filters a specific chart tile must include: the union of selections from
   * slicer tiles ON THE SAME PAGE whose targets are null/absent (all charts)
   * or include tileId, plus the active cross-filter when this tile is not its
   * source. Slicers never reach across pages; targets semantics are unchanged
   * within a page. The source chart never filters itself, and slicer targeting
   * does NOT constrain cross-filters — a datum click highlights every other
   * chart on the page regardless of any slicer's "applies to" list.
   *
   * Filter-pane cards additionally contribute (enabled cards only, view-mode
   * overrides applied): all-pages cards always; page-scope cards when their
   * pageId is the page the tile lives on; visual-scope cards when they target
   * exactly this tile.
   */
  filtersForTile(tileId: string): FilterClause[] {
    const layout = this.state.current?.layout;
    if (!layout) return [];
    const page = pagesOf(layout).find((p) => p.tiles.some((t) => t.id === tileId));
    const clauses: FilterClause[] = [];
    for (const tile of page?.tiles ?? []) {
      if (!isSlicerTile(tile)) continue;
      const targets = tile.slicer.targets;
      if (targets != null && !targets.includes(tileId)) continue;
      const clause = slicerClauseOf(this.state.slicerValues[tile.id]);
      if (clause != null) clauses.push(clause);
    }
    for (const card of layout.filterCards ?? []) {
      const effective = this.effectiveFilterCard(card);
      if (effective.disabled) continue;
      const applies =
        effective.scope === 'allPages' ||
        (effective.scope === 'page' && page !== undefined && effective.pageId === page.id) ||
        (effective.scope === 'visual' && effective.targetTileId === tileId);
      if (applies) clauses.push(...filterCardClauses(effective));
    }
    // Transient drillthrough context: every chart tile on the TARGET page
    // receives its clauses (same merge path as slicers/cards — nothing new for
    // ChartTile to learn about).
    const drillthrough = this.state.drillthrough;
    if (drillthrough && page !== undefined && page.id === drillthrough.targetPageId) {
      clauses.push(...drillthrough.filters);
    }
    // Cross-filters: every active one applies except those the tile itself
    // raised. Structurally identical clauses are pushed once — a cross-filter
    // duplicating an active slicer selection on the same column must not
    // stack the same predicate twice.
    const seen = new Set(clauses.map((c) => stableStringify(c)));
    for (const cross of this.state.crossFilters) {
      if (cross.sourceTileId === tileId) continue;
      const key = stableStringify(cross.clause);
      if (seen.has(key)) continue;
      seen.add(key);
      clauses.push(cross.clause);
    }
    return clauses;
  }

  /**
   * Filters that constrain a CASCADING slicer's AVAILABLE VALUES
   * (SlicerTileSpec.cascade) — i.e. what its distinct-values fetch is scoped
   * to. Deliberately NOT the same set as filtersForTile:
   *
   *  - INCLUDED: every OTHER slicer tile on the same page that currently holds
   *    a clause, and every active cross-filter. Slicer "applies to" targeting
   *    is ignored on purpose — it says which CHARTS a slicer filters, not what
   *    the data universe looks like.
   *  - EXCLUDED, always: any clause on this slicer's OWN table.column. A
   *    slicer must never narrow its own option list (that would make
   *    de-selecting a value impossible).
   *  - EXCLUDED, by design: filter-pane cards and drillthrough context. They
   *    are per-chart/per-page report scoping rather than user-driven slicing;
   *    folding them in would make a slicer's list depend on invisible authored
   *    state. (Documented scope choice — widen here if that changes.)
   *
   * Clauses are de-duplicated and sorted by their stable serialization so the
   * array is order-stable: it is hashed straight into the distinct-value cache
   * key (`stableStringify(DistinctValuesSpec)`, which includes `filters`).
   */
  cascadeFiltersForSlicer(tileId: string): FilterClause[] {
    const layout = this.state.current?.layout;
    if (!layout) return [];
    const page = pagesOf(layout).find((p) => p.tiles.some((t) => t.id === tileId));
    if (page === undefined) return [];
    const self = page.tiles.find((t) => t.id === tileId);
    const own = self?.slicer ? { table: self.slicer.table, column: self.slicer.column } : null;
    const isOwnColumn = (clause: FilterClause): boolean =>
      own !== null && clause.table === own.table && clause.column === own.column;

    const seen = new Set<string>();
    const clauses: FilterClause[] = [];
    const push = (clause: FilterClause | null | undefined): void => {
      if (clause == null || isOwnColumn(clause)) return;
      const key = stableStringify(clause);
      if (seen.has(key)) return;
      seen.add(key);
      clauses.push(clause);
    };

    for (const tile of page.tiles) {
      if (tile.id === tileId || !isSlicerTile(tile)) continue;
      push(slicerClauseOf(this.state.slicerValues[tile.id]));
    }
    for (const cross of this.state.crossFilters) {
      if (cross.sourceTileId === tileId) continue;
      push(cross.clause);
    }
    return clauses.sort((a, b) => {
      const ka = stableStringify(a);
      const kb = stableStringify(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  /* ------------------------------------------------------------ drillthrough */

  /**
   * Activates a drillthrough: switches to the target page and stores the
   * transient context (source page for "← Back", eq clauses from the clicked
   * point). Never persisted.
   */
  startDrillthrough(targetPageId: string, filters: FilterClause[], label: string): void {
    const current = this.state.current;
    if (!current || !pagesOf(current.layout).some((p) => p.id === targetPageId)) return;
    const sourcePageId = this.state.activePageId ?? targetPageId;
    if (targetPageId === sourcePageId) return;
    this.set({
      activePageId: targetPageId,
      drillthrough: { sourcePageId, targetPageId, filters: [...filters], label },
      // Drillthrough is an explicit navigation with its own filter context —
      // active cross-filters clear regardless of scope so the target page
      // never double-filters.
      crossFilters: [],
      selectedTileId: null,
      lastAppliedBookmarkId: null,
    });
  }

  /** Clears the drillthrough context, staying on the current page. */
  clearDrillthrough(): void {
    if (this.state.drillthrough !== null) this.set({ drillthrough: null });
  }

  /** "← Back": returns to the page the drillthrough came from and clears it. */
  returnFromDrillthrough(): void {
    const drillthrough = this.state.drillthrough;
    if (!drillthrough) return;
    const current = this.state.current;
    const sourceExists =
      current !== null && pagesOf(current.layout).some((p) => p.id === drillthrough.sourcePageId);
    this.set({
      drillthrough: null,
      ...(sourceExists
        ? {
            activePageId: drillthrough.sourcePageId,
            crossFilters: [],
            selectedTileId: null,
          }
        : {}),
    });
  }

  /* -------------------------------------------------------------- bookmarks */

  /** Current page + runtime filter context, cloned for safe doc storage. */
  private captureBookmarkState(): DashboardBookmark['state'] | null {
    const pageId = this.state.activePageId;
    if (pageId === null) return null;
    return {
      pageId,
      slicers: structuredClone(this.state.slicerValues),
      filterOverrides: structuredClone(this.state.filterCardOverrides),
    };
  }

  private mutateBookmarks(mutate: (bookmarks: DashboardBookmark[]) => DashboardBookmark[]): void {
    this.mutateLayout((layout) => ({ ...layout, bookmarks: mutate(layout.bookmarks ?? []) }));
  }

  /**
   * Finding 7: bookmark edits made in VIEW mode auto-persist — view mode has
   * no Save affordance, so a merely-dirty doc would silently lose the change
   * on close. Runs the doc mutation, then persists it immediately; a failure
   * surfaces the store error and REVERTS the doc mutation. Edit mode runs the
   * mutation alone — it saves with the draft (or, live, emits as ops) as any
   * other edit.
   *
   * HOW it persists is the COLLAB-DESIGN "fixed regardless" item: on a
   * COLLABORATIVE dashboard the mutation travels as ops (bookmarks are
   * id-keyed doc elements) instead of the historic whole-doc PUT — a viewer's
   * bookmark write can no longer clobber an editor's concurrent changes. Solo
   * dashboards keep the whole-doc save exactly as before (draft-mode path).
   */
  private commitBookmarkMutation(mutate: () => void): void {
    const current = this.state.current;
    if (!current) return;
    if (this.state.mode !== 'view') {
      mutate();
      return;
    }
    const layoutBefore = current.layout;
    const dirtyBefore = this.state.dirty;
    mutate();
    if (isLiveCollaborative(current)) {
      const after = this.state.current;
      if (!after || after.id !== current.id) return;
      const ops = diffLayoutDocs(layoutBefore, after.layout);
      void this.sendOpsDirect(current.id, ops).then((result) => {
        const live = this.state.current;
        if (!live || live.id !== current.id) return;
        if (result.ok) {
          this.set({
            current: result.stamp !== null ? { ...live, expectedUpdatedAtUtc: result.stamp } : live,
            dirty: dirtyBefore,
            saveStatus: 'ok',
          });
          return;
        }
        this.set({
          current: { ...live, layout: layoutBefore },
          dirty: dirtyBefore,
          saveStatus: 'error',
          error: result.message,
          lastAppliedBookmarkId: null,
        });
      });
      return;
    }
    void this.save().then((saved) => {
      if (saved) return;
      const live = this.state.current;
      if (!live || live.id !== current.id) return;
      this.set({
        current: { ...live, layout: layoutBefore },
        dirty: dirtyBefore,
        lastAppliedBookmarkId: null,
      });
    });
  }

  /**
   * Adds a bookmark capturing the CURRENT view (active page, slicer
   * selections, view-mode filter-card overrides). In edit mode it dirties the
   * draft like any other layout edit; in view mode it persists immediately
   * (finding 7). Returns the new id (null when no dashboard is open).
   */
  addBookmark(name: string): string | null {
    const trimmed = name.trim();
    const state = this.captureBookmarkState();
    if (trimmed === '' || state === null || !this.state.current) return null;
    const id = newId();
    this.commitBookmarkMutation(() => {
      this.mutateBookmarks((bookmarks) => [...bookmarks, { id, name: trimmed, state }]);
      // A freshly captured bookmark IS the current view.
      this.set({ lastAppliedBookmarkId: id });
    });
    return id;
  }

  /** Restores a bookmark's page + filter context (cross-filter resets). */
  applyBookmark(id: string): void {
    const current = this.state.current;
    if (!current) return;
    const bookmark = (current.layout.bookmarks ?? []).find((b) => b.id === id);
    if (!bookmark) return;
    const pageExists = pagesOf(current.layout).some((p) => p.id === bookmark.state.pageId);
    this.set({
      ...(pageExists ? { activePageId: bookmark.state.pageId } : {}),
      slicerValues: structuredClone(bookmark.state.slicers),
      // Finding 10: edit mode always shows the AUTHORED doc (enterEdit's
      // rule) — installing the captured overrides there would silently win
      // over every FiltersPane write and make its controls look inert. The
      // captured card tweaks are view-mode personal state; edit mode applies
      // page + slicers only.
      ...(this.state.mode === 'view'
        ? { filterCardOverrides: structuredClone(bookmark.state.filterOverrides) }
        : {}),
      // A bookmark restores its FULL captured filter context — transient
      // cross-filter/drillthrough state would pollute it. (Bookmarks capture
      // slicers + filter-card overrides, never cross-filters — unchanged.)
      crossFilters: [],
      drillthrough: null,
      selectedTileId: null,
      lastAppliedBookmarkId: id,
    });
  }

  /** Overwrites a bookmark's captured state with the current view.
   *  View mode persists immediately (finding 7). */
  updateBookmark(id: string): void {
    const state = this.captureBookmarkState();
    if (state === null) return;
    if (!(this.state.current?.layout.bookmarks ?? []).some((b) => b.id === id)) return;
    this.commitBookmarkMutation(() => {
      this.mutateBookmarks((bookmarks) =>
        bookmarks.map((b) => (b.id === id ? { ...b, state } : b)),
      );
      this.set({ lastAppliedBookmarkId: id });
    });
  }

  /** View mode persists immediately (finding 7). */
  renameBookmark(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const bookmark = (this.state.current?.layout.bookmarks ?? []).find((b) => b.id === id);
    if (!bookmark || bookmark.name === trimmed) return;
    this.commitBookmarkMutation(() => {
      this.mutateBookmarks((bookmarks) =>
        bookmarks.map((b) => (b.id === id ? { ...b, name: trimmed } : b)),
      );
    });
  }

  /** View mode persists immediately (finding 7). */
  deleteBookmark(id: string): void {
    if (!(this.state.current?.layout.bookmarks ?? []).some((b) => b.id === id)) return;
    this.commitBookmarkMutation(() => {
      this.mutateBookmarks((bookmarks) => bookmarks.filter((b) => b.id !== id));
      if (this.state.lastAppliedBookmarkId === id) this.set({ lastAppliedBookmarkId: null });
    });
  }

  /** View-mode auto-refresh interval (persisted with the layout on save). */
  setRefreshSeconds(seconds: number | null): void {
    this.mutateLayout((layout) => ({ ...layout, refreshSeconds: seconds }));
  }

  /**
   * Cross-filter indicator look/placement (persisted with the layout). A patch
   * MERGES onto whatever is there — absent fields keep falling back to the
   * component defaults, so an untouched dashboard never gains a filterIndicator
   * key. `null` resets the dashboard back to those defaults.
   */
  setFilterIndicator(patch: Partial<FilterIndicatorStyle> | null): void {
    const current = this.state.current;
    if (!current) return;
    const next =
      patch === null ? null : { ...(current.layout.filterIndicator ?? {}), ...patch };
    if (stableStringify(current.layout.filterIndicator ?? null) === stableStringify(next)) return;
    this.mutateLayout((layout) => ({ ...layout, filterIndicator: next }));
  }

  /**
   * Doc-level default view sizing (persisted with the layout on save; written
   * from the toolbar's View control in EDIT mode). FIT TO PAGE is the product
   * default, so 'fitPage'/null normalize to null — absent means fit and an
   * untouched dashboard never gains the key. 'actual' persists EXPLICITLY:
   * docs authored to actual size keep rendering 1:1 for viewers. View-mode
   * viewer overrides go through setViewFitOverride, never here.
   */
  setDefaultViewFit(fit: ViewFitMode | null): void {
    const next = fit === 'fitPage' ? null : fit;
    if ((this.state.current?.layout.defaultViewFit ?? null) === next) return;
    this.mutateLayout((layout) => ({ ...layout, defaultViewFit: next }));
  }

  /**
   * View-mode transient view-sizing override (see DashboardStoreState.
   * viewFitOverride). null returns the viewer to the doc default.
   */
  setViewFitOverride(fit: ViewFitMode | null): void {
    if (this.state.viewFitOverride === fit) return;
    this.set({ viewFitOverride: fit });
  }

  /* ------------------------------------------------------- field parameters */

  private mutateParameters(mutate: (parameters: DashboardParameter[]) => DashboardParameter[]): void {
    this.mutateLayout((layout) => ({ ...layout, parameters: mutate(layout.parameters ?? []) }));
  }

  /** Adds a field parameter (id assigned here); returns the new id. */
  addParameter(parameter: Omit<DashboardParameter, 'id'>): string {
    const id = newId();
    this.mutateParameters((parameters) => [...parameters, { ...parameter, id }]);
    // A fresh parameter starts at its default selection.
    this.set({
      parameterSelections: {
        ...this.state.parameterSelections,
        [id]: clampIndex(parameter.defaultIndex ?? 0, parameter.options.length),
      },
    });
    return id;
  }

  /** Patches a field parameter (doc edit — dirties the draft). */
  updateParameter(id: string, patch: Partial<Omit<DashboardParameter, 'id'>>): void {
    this.mutateParameters((parameters) =>
      parameters.map((p) => (p.id === id ? { ...p, ...patch, id } : p)),
    );
    // The option list may have shrunk under the current selection.
    const updated = (this.state.current?.layout.parameters ?? []).find((p) => p.id === id);
    if (updated) {
      const selection = this.state.parameterSelections[id] ?? updated.defaultIndex ?? 0;
      const clamped = clampIndex(selection, updated.options.length);
      if (clamped !== selection) {
        this.set({ parameterSelections: { ...this.state.parameterSelections, [id]: clamped } });
      }
    }
  }

  /** Removes a field parameter and its transient selection. Charts bound to it
   *  fall back to their own axis/measures; fieldParam slicers show a hint. */
  removeParameter(id: string): void {
    this.mutateParameters((parameters) => parameters.filter((p) => p.id !== id));
    if (id in this.state.parameterSelections) {
      const { [id]: _removed, ...rest } = this.state.parameterSelections;
      this.set({ parameterSelections: rest });
    }
  }

  /** Transient selection of a field parameter's option (never persisted). */
  setParameterSelection(id: string, index: number): void {
    const parameter = (this.state.current?.layout.parameters ?? []).find((p) => p.id === id);
    if (!parameter) return;
    const clamped = clampIndex(index, parameter.options.length);
    if (this.state.parameterSelections[id] === clamped) return;
    this.set({ parameterSelections: { ...this.state.parameterSelections, [id]: clamped } });
  }

  /* ------------------------------------- scoped measures (dashboard scope) */

  /** The open dashboard's own measures (dashboard scope); [] when none/closed. */
  get dashboardMeasures(): Measure[] {
    return this.state.current?.layout.measures ?? [];
  }

  /**
   * Seeds the PERSONAL-scope measure set from the per-user settings document.
   * Does NOT write back — this is the hydrate direction, and echoing what was
   * just read would schedule a pointless PUT (and, if hydration raced a local
   * edit, could overwrite it with the server's older copy).
   */
  hydratePersonalMeasures(measures: Measure[]): void {
    this.set({ personalMeasures: [...measures] });
  }

  /**
   * Replaces the PERSONAL-scope measure set and persists it, when the runtime
   * wired a persister (createRuntime points this at the per-user settings
   * document). Without one the set stays in-memory for the session — a host
   * that never mounts the settings store still gets a working scratchpad.
   */
  setPersonalMeasures(measures: Measure[]): void {
    const next = [...measures];
    this.set({ personalMeasures: next });
    // The MODEL is part of the address: a personal measure is written against
    // one model's tables, so the persister files it under that model rather
    // than into one pile that follows the user onto unrelated models.
    this.collab.onPersistPersonalMeasures?.(next, this.state.current?.modelId ?? null);
  }

  /**
   * The measure DEFINITIONS a chart needs on the query wire: the
   * dashboard-scoped and personal measures it cites, transitively (a
   * calculated one may reference others by name). Model measures are absent —
   * the server already has those. This is what every toWireSpec call site
   * passes as `definitions`; the result is stable-ordered, so it does not
   * churn query cache keys.
   */
  definitionsForChart(chart: ChartSpec): Measure[] {
    const available = [...this.dashboardMeasures, ...this.state.personalMeasures];
    return chartMeasureDefinitions(available, chart);
  }

  /** Replaces the open dashboard's measures[] through the normal doc seam. */
  private mutateMeasures(mutate: (measures: Measure[]) => Measure[]): void {
    this.mutateLayout((layout) => ({ ...layout, measures: mutate(layout.measures ?? []) }));
  }

  /*
   * DASHBOARD-SCOPE CRUD. These go through mutateMeasures — the ordinary doc
   * seam — so a measure edit is history-tracked, dirties the dashboard, and
   * emits the same per-element op live mode already carries for filter cards
   * and parameters. Nothing here validates: authoring validation is the
   * dialog's round-trip against /models/validate, and the engine is the final
   * word. No dashboard open = a no-op, never a throw.
   */

  /** Appends a measure to the open dashboard's scope; returns it with its id. */
  addDashboardMeasure(measure: Omit<Measure, 'id'> & { id?: string }): Measure | null {
    if (!this.state.current) return null;
    const withId: Measure = { ...measure, id: measure.id ?? newId() };
    this.mutateMeasures((measures) => [...measures, withId]);
    return withId;
  }

  /** Patches one dashboard measure in place (id is never patchable). */
  updateDashboardMeasure(id: string, patch: Partial<Omit<Measure, 'id'>>): void {
    if (!this.dashboardMeasures.some((m) => m.id === id)) return;
    this.mutateMeasures((measures) =>
      measures.map((m) => (m.id === id ? { ...m, ...patch, id: m.id } : m)),
    );
  }

  /**
   * Removes a dashboard measure. Charts still citing it fail with
   * QRY_UNKNOWN_MEASURE — deliberately NOT silently repaired here: the manager
   * warns about usage before it calls this, and quietly rewriting other
   * people's charts is worse than an explicit error.
   */
  removeDashboardMeasure(id: string): void {
    if (!this.dashboardMeasures.some((m) => m.id === id)) return;
    this.mutateMeasures((measures) => measures.filter((m) => m.id !== id));
  }

  /**
   * Promotes measures INTO the open dashboard's scope, collision-safe (the
   * same merge chart copy uses). Promotion COPIES — a personal original stays
   * in its owner's store — and keeps the id and name wherever the dashboard
   * has neither taken, so a chart citing the measure needs no rewrite.
   * Returns the merge outcome, or null when no dashboard is open.
   */
  promoteMeasuresToDashboard(
    measures: Measure[],
    chart: ChartSpec,
  ): { chart: ChartSpec; added: Measure[]; renamed: [string, string][] } | null {
    if (!this.state.current || measures.length === 0) {
      return this.state.current ? { chart, added: [], renamed: [] } : null;
    }
    const merged = mergeMeasureDefinitions(this.dashboardMeasures, measures, chart);
    if (merged.added.length > 0) this.mutateMeasures(() => merged.measures);
    return { chart: merged.chart ?? chart, added: merged.added, renamed: merged.renamed };
  }

  /**
   * Promotes a dashboard measure to SYSTEM scope by appending it to the
   * dashboard's model. Server-gated: a model the caller cannot write answers
   * 403 (and a system-owned one always does), which surfaces as the store
   * error and a rejected promise. The dashboard copy is deliberately LEFT in
   * place — removing it would break every other dashboard-scoped expression
   * that references it by name, and the model copy resolves first only if the
   * dashboard copy is gone. Callers that want the move rather than the copy
   * remove the dashboard measure afterwards.
   */
  async promoteMeasureToModel(measureId: string): Promise<Measure | null> {
    const current = this.state.current;
    const modelId = current?.modelId ?? null;
    if (!current || modelId === null) return null;
    const source = this.dashboardMeasures.find((m) => m.id === measureId);
    if (!source) return null;

    try {
      const model = await this.api.getModel(modelId);
      const merged = mergeMeasureDefinitions(
        model.definition.measures,
        // Transitively: a calculated measure is worthless in the model without
        // the measures its expression names.
        collectMeasureDefinitions([...this.dashboardMeasures], [measureId]),
      );
      if (merged.added.length === 0) return source;
      await this.api.updateModel(modelId, {
        name: model.name,
        description: model.description,
        dataSourceName: model.dataSourceName,
        definition: { ...model.definition, measures: merged.measures },
        isShared: model.isShared,
        expectedUpdatedAtUtc: model.updatedAtUtc,
      });
      return merged.added.find((m) => m.name === source.name) ?? merged.added[0] ?? null;
    } catch (error) {
      this.set({ error: rcdErrorMessage(error) });
      throw error;
    }
  }

  /**
   * THE PROMOTION RULE, enforced where a chart enters the document: a chart
   * saved into a dashboard may not reference a PERSONAL measure. A personal
   * measure is an exploration scratchpad — private to its author — so a chart
   * citing one would render for nobody else (QRY_UNKNOWN_MEASURE for every
   * grantee), would be unresolvable in the BACKGROUND context a scheduled
   * email runs in, and would leave an alert depending on a private document
   * months later. Every cited personal measure is therefore COPIED into the
   * dashboard's own scope, keeping its id and name; the original stays in the
   * user's store so the scratchpad keeps working.
   */
  private promotePersonalMeasuresFor(chart: ChartSpec): ChartSpec {
    const cited = this.citedPersonalMeasures(chart);
    if (cited.length === 0) return chart;
    const merged = mergeMeasureDefinitions(this.dashboardMeasures, cited, chart);
    if (merged.added.length === 0) return merged.chart ?? chart;
    this.mutateMeasures(() => merged.measures);
    return merged.chart ?? chart;
  }

  /** The personal measures a chart cites, transitively; [] is the common case. */
  private citedPersonalMeasures(chart: ChartSpec): Measure[] {
    return this.state.personalMeasures.length === 0
      ? []
      : collectMeasureDefinitions(this.state.personalMeasures, chartMeasureIds(chart));
  }

  /* -------------------------------------- chart clipboard / copy (0.9.0) */

  /**
   * Puts a chart on the transient clipboard (never persisted), together with
   * the scoped measure definitions it cites — the clipboard spans dashboards,
   * so the definitions must travel with it or the paste lands broken.
   */
  copyChart(chart: ChartSpec, sourceModelId: number | null): void {
    this.set({
      chartClipboard: {
        chart: structuredClone(chart),
        sourceModelId,
        definitions: structuredClone(this.definitionsForChart(chart)),
      },
    });
  }

  /**
   * Pastes the clipboard chart as a new tile on the active page (edit mode
   * only), following duplicateTile's conventions: fresh tile/chart ids,
   * "(copy)" title, placed below all content at maxY. The measure definitions
   * captured at copy time are merged into THIS dashboard's measures first
   * (id/name-collision safe), and the pasted chart's refs are re-pointed at
   * whatever the merge decided — one undo step for the pair.
   */
  pasteChartTile(): void {
    const clip = this.state.chartClipboard;
    if (!clip || this.state.mode !== 'edit' || !this.state.current) return;
    const copy = cloneChartForCopy(clip.chart, { suffix: true });
    this.groupHistory(() => {
      const merged = mergeMeasureDefinitions(this.dashboardMeasures, clip.definitions, copy);
      if (merged.added.length > 0) this.mutateMeasures(() => merged.measures);
      this.addTile(merged.chart ?? copy);
    });
  }

  /**
   * Copies a chart onto another dashboard (or this one). Same dashboard:
   * in-store append to the active page — dirties and honors the edit session
   * like any other draft change — with the " (copy)" suffix the other
   * same-dashboard copy paths use (a suffixless twin on the same page was
   * indistinguishable from its source); cross-dashboard copies keep the name
   * unchanged. Other dashboard: server round-trip
   * (getDashboard → append a tile to the FIRST page, or to the top-level
   * tiles on a legacy no-pages doc → updateDashboard with the fresh
   * expectedUpdatedAtUtc); a concurrent-save 409 (rcd.dashboard.stale)
   * refetches and retries ONCE. Failures surface via the store error (and the
   * rejected promise). Model mismatch is the UI's concern — the dialog warns;
   * this method just copies.
   *
   * SCOPED MEASURES TRAVEL WITH THE CHART. A chart citing dashboard (or
   * personal) measures used to land on the target as QRY_UNKNOWN_MEASURE: the
   * definitions live in the SOURCE document and only `chart` was carried. Now
   * the definitions it references — transitively, because a calculated measure
   * may name others — are merged into the target's own measures[], and the
   * copied chart's refs are re-pointed at whatever the merge decided. A
   * personal measure is promoted into the target's dashboard scope by the same
   * merge, per the promotion rule.
   */
  async copyChartToDashboard(
    targetId: number,
    chart: ChartSpec,
    _sourceModelId: number | null,
  ): Promise<void> {
    const definitions = this.definitionsForChart(chart);
    const current = this.state.current;
    if (current && current.id === targetId) {
      // Same dashboard: the definitions are already here — merge is a no-op
      // for anything identical, and promotes a cited personal measure.
      const copy = cloneChartForCopy(chart, { suffix: true });
      this.groupHistory(() => {
        const merged = mergeMeasureDefinitions(this.dashboardMeasures, definitions, copy);
        if (merged.added.length > 0) this.mutateMeasures(() => merged.measures);
        this.addTile(merged.chart ?? copy);
      });
      return;
    }
    try {
      await this.appendChartRemote(targetId, chart, definitions);
    } catch (error) {
      const stale =
        error instanceof RcdApiError && error.errorCode === 'rcd.dashboard.stale';
      if (!stale) {
        this.set({ error: messageOf(error) });
        throw error;
      }
      try {
        await this.appendChartRemote(targetId, chart, definitions);
      } catch (retryError) {
        this.set({ error: messageOf(retryError) });
        throw retryError;
      }
    }
  }

  /**
   * How many scoped measure definitions a "copy chart to…" would carry across
   * — what the copy dialog tells the user before they commit. Counts the
   * transitive set, i.e. exactly what appendChartRemote merges.
   */
  measureCarryCount(chart: ChartSpec): number {
    return this.definitionsForChart(chart).length;
  }

  /** One fetch → append → save round-trip (copyChartToDashboard's engine). */
  private async appendChartRemote(
    targetId: number,
    chart: ChartSpec,
    definitions: Measure[],
  ): Promise<void> {
    const detail = await this.api.getDashboard(targetId);
    const layout = detail.layout?.tiles ? detail.layout : emptyLayout();
    // Merge the carried definitions into the TARGET's measures first: the
    // merge may re-point the chart's refs (same id, different definition) or
    // dedupe a name, and the tile must be built from the rewritten chart.
    const merged = mergeMeasureDefinitions(layout.measures ?? [], definitions, chart);
    const carried = merged.chart ?? chart;
    const tileFor = (tiles: DashboardTile[]): DashboardTile => ({
      id: newId(),
      layout: {
        x: 0,
        y: tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0),
        w: 12,
        h: 8,
        minW: 4,
        minH: 4,
      },
      // No suffix (the name stays), but the clone still routes the inner
      // title through the retitle helper so title and inner title stay in
      // sync on the target dashboard.
      chart: cloneChartForCopy(carried),
    });
    const pages = layout.pages ?? [];
    const withMeasures: DashboardLayoutDoc =
      merged.added.length > 0 ? { ...layout, measures: merged.measures } : layout;
    const nextLayout: DashboardLayoutDoc =
      pages.length > 0
        ? {
            ...withMeasures,
            pages: pages.map((page, index) =>
              index === 0 ? { ...page, tiles: [...page.tiles, tileFor(page.tiles)] } : page,
            ),
          }
        : // Legacy doc with no pages: append to the top-level tiles.
          { ...withMeasures, tiles: [...withMeasures.tiles, tileFor(withMeasures.tiles)] };
    await this.api.updateDashboard(targetId, {
      name: detail.name,
      description: detail.description,
      modelId: detail.modelId,
      layout: nextLayout,
      isShared: detail.isShared,
      expectedUpdatedAtUtc: detail.updatedAtUtc,
    });
    void this.loadList();
  }

  /* --------------------------------------------- sharing/activity (0.8.0) */

  /**
   * Changes the linked model of the open dashboard. Owner/admin only —
   * grantee attempts are rejected server-side
   * ('rcd.dashboard.share_forbidden_fields'). Not part of the undo snapshot
   * (history captures the layout document only). LIVE edit sessions persist
   * it immediately through the metadata PATCH (modelId is a row column —
   * never an op, and live mode has no Save PUT to carry it; the PATCH cannot
   * clobber concurrent tile edits because it never touches LayoutJson).
   * DRAFT sessions keep the historic shape: dirty now, persisted by Save's
   * whole-doc PUT (which carries modelId), so Discard still reverts the pick.
   */
  setModelId(modelId: number | null): void {
    const current = this.state.current;
    if (!current || current.modelId === modelId) return;
    if (this.state.liveMode && this.state.mode === 'edit') {
      const prior = current.modelId;
      this.set({ current: { ...current, modelId } });
      void (async () => {
        try {
          const saved = await this.api.patchDashboardMeta(current.id, { modelId });
          const now = this.state.current;
          if (now && now.id === current.id) {
            this.set({
              current: { ...now, modelId: saved.modelId, expectedUpdatedAtUtc: saved.updatedAtUtc },
            });
          }
        } catch (error) {
          const now = this.state.current;
          if (now && now.id === current.id) {
            this.set({ current: { ...now, modelId: prior }, error: messageOf(error) });
          }
        }
      })();
      return;
    }
    this.set({ current: { ...current, modelId }, dirty: true });
  }

  /**
   * Writes ONLY the publish ("Everyone") flag of the open dashboard through
   * the metadata PATCH, adopting the fresh concurrency stamp without leaving
   * the caller's mode. Admin-gated server-side. Deliberately NEVER the
   * whole-doc PUT (in any mode): the old shape carried the in-memory layout,
   * so flipping publish mid-live-session could overwrite collaborators'
   * concurrent tile edits with this client's stale copy.
   */
  async setPublish(isShared: boolean): Promise<boolean> {
    const current = this.state.current;
    if (!current) return false;
    if (current.isShared === isShared) return true;
    try {
      const saved = await this.api.patchDashboardMeta(current.id, { isShared });
      const live = this.state.current;
      if (live && live.id === current.id) {
        this.set({
          current: { ...live, isShared: saved.isShared, expectedUpdatedAtUtc: saved.updatedAtUtc },
        });
      }
      void this.loadList();
      return true;
    } catch (error) {
      this.set({ error: messageOf(error) });
      return false;
    }
  }

  /**
   * Renames a dashboard (name + optional description) through the metadata
   * PATCH — the server logs the "renamed" activity and enforces rights
   * (grantee renames 403 as share_forbidden_fields; over-long names 400 as
   * rcd.dashboard.name_too_long). NEVER the whole-doc PUT (in any mode, open
   * row or not): a rename must not carry a layout at all — the old shape
   * could clobber a live collaborator's tiles (open row) or round-trip a
   * fetched doc for no reason (other rows). The open row additionally adopts
   * the fresh name/stamp into `current` without leaving the caller's mode.
   *
   * `description === undefined` keeps the existing description (the PATCH
   * omits the field). Refreshes the list either way (the rail and toolbar
   * read names from it). Returns false and surfaces the error on failure.
   */
  async renameDashboard(id: number, name: string, description?: string | null): Promise<boolean> {
    try {
      const saved = await this.api.patchDashboardMeta(id, {
        name,
        ...(description === undefined ? {} : { description }),
      });
      const live = this.state.current;
      if (live && live.id === id) {
        this.set({
          current: {
            ...live,
            name: saved.name,
            description: saved.description,
            expectedUpdatedAtUtc: saved.updatedAtUtc,
          },
        });
      }
      void this.loadList();
      return true;
    } catch (error) {
      this.set({ error: messageOf(error) });
      return false;
    }
  }

  /** The dashboard's grant rows (owner/admin). Errors propagate to the caller. */
  listShares(dashboardId: number): Promise<DashboardShare[]> {
    return this.api.listDashboardShares(dashboardId);
  }

  /**
   * Replaces the dashboard's full grant set, then refreshes the list (row
   * shareCounts changed) and the open dashboard's count. Errors propagate.
   */
  async saveShares(dashboardId: number, shares: DashboardShareInput[]): Promise<void> {
    await this.api.saveDashboardShares(dashboardId, { shares });
    const current = this.state.current;
    if (current && current.id === dashboardId) {
      this.set({ current: { ...current, shareCount: shares.length } });
    }
    void this.loadList();
  }

  /** Activity log page (newest first; `beforeId` pages backwards). */
  listActivity(dashboardId: number, options?: ListActivityOptions): Promise<ActivityEntry[]> {
    return this.api.listDashboardActivity(dashboardId, options);
  }

  /** Host user directory for the share picker ([] = not configured). */
  listUsers(query?: string): Promise<RcdUser[]> {
    return this.api.listUsers(query);
  }

  /**
   * Removes the CALLER's share row ("Remove from my list") and refreshes the
   * list. Deliberately does NOT close an open session on that dashboard —
   * navigation is the host's decision. Errors propagate.
   */
  async leave(dashboardId: number): Promise<void> {
    await this.api.leaveDashboard(dashboardId);
    void this.loadList();
  }
}

/* ----------------------------------------------------- cross-filter merging
 * One CrossFilter per (table, column) — these helpers own the invariant.
 */

const crossFilterFieldKey = (clause: FilterClause): string =>
  `${clause.table}\u0000${clause.column}`;

/** Two CrossFilterValue raws denote the same cell (null only matches null). */
const sameRaw = (a: FilterValue | null, b: FilterValue | null): boolean =>
  a === null || b === null ? a === b : typeof a === typeof b ? a === b : String(a) === String(b);

/**
 * A fresh CrossFilter from one click. Discrete clauses (eq/isNull) get their
 * value set seeded so later Ctrl-clicks can toggle; 'between' (date bucket)
 * clauses get endpoint labels so span extensions can label the merged range.
 */
const buildCrossFilter = (input: {
  sourceTileId: string;
  clause: FilterClause;
  label: string;
  categoryLabel: string;
  kind?: 'axis' | 'legend';
}): CrossFilter => {
  const { sourceTileId, clause, label, categoryLabel, kind = 'axis' } = input;
  const base: CrossFilter = { sourceTileId, clause, label, categoryLabel, kind };
  if (clause.operator === 'eq') {
    return { ...base, values: [{ raw: clause.values[0] ?? null, label: categoryLabel }] };
  }
  if (clause.operator === 'isNull') {
    return { ...base, values: [{ raw: null, label: categoryLabel }] };
  }
  if (clause.operator === 'between') {
    return { ...base, rangeLabels: { start: categoryLabel, end: categoryLabel } };
  }
  return base;
};

/** The discrete value set behind a filter (null = not a discrete filter). */
const discreteValuesOf = (filter: CrossFilter): CrossFilterValue[] | null => {
  if (filter.values !== undefined) return filter.values;
  const { clause } = filter;
  if (clause.operator === 'eq') {
    return [{ raw: clause.values[0] ?? null, label: filter.categoryLabel }];
  }
  if (clause.operator === 'isNull') return [{ raw: null, label: filter.categoryLabel }];
  if (clause.operator === 'in') {
    return clause.values.map((raw) => ({ raw, label: String(raw) }));
  }
  return null;
};

/**
 * Rebuilds a field's filter from an explicit discrete value set (Ctrl-click
 * toggling and the "Edit value…" popover). The set is never empty here
 * (callers remove the filter instead). A lone blank compiles to isNull; a
 * blank mixed with values is unrepresentable (no OR in the clause
 * vocabulary), so blanks are dropped when values are present.
 */
const crossFilterFromValues = (
  template: CrossFilter,
  values: CrossFilterValue[],
): CrossFilter => {
  const { table, column } = template.clause;
  const nonNull = values.filter((v): v is CrossFilterValue & { raw: FilterValue } => v.raw !== null);
  const kept = nonNull.length > 0 ? nonNull : values.slice(0, 1);
  const categoryLabel = kept.map((v) => v.label).join(', ');
  const clause: FilterClause =
    nonNull.length === 0
      ? { table, column, operator: 'isNull', values: [] }
      : nonNull.length === 1
        ? { table, column, operator: 'eq', values: [nonNull[0]!.raw] }
        : { table, column, operator: 'in', values: nonNull.map((v) => v.raw) };
  return {
    sourceTileId: template.sourceTileId,
    clause,
    label: `${column}: ${categoryLabel}`,
    categoryLabel,
    kind: template.kind ?? 'axis',
    values: kept,
  };
};

/**
 * Ctrl-click merge of an incoming single-click filter into the field's
 * existing one (same table.column, clauses differ — identical clauses toggle
 * off before this runs). Returns null when the merge empties the field.
 *
 *  - discrete + discrete: toggle the clicked value in/out of the set;
 *  - between + between: extend to the SPANNING range (min start, max end) —
 *    OR-of-disjoint-ranges is not expressible in the AND-composed filter
 *    list, so the honest behavior is the labeled span;
 *  - blank vs values / range vs discrete (bucket changed mid-session): the
 *    incoming filter replaces the field's entry.
 */
const mergeCrossFilters = (existing: CrossFilter, incoming: CrossFilter): CrossFilter | null => {
  if (existing.clause.operator === 'between' && incoming.clause.operator === 'between') {
    const exStart = String(existing.clause.values[0] ?? '');
    const exEnd = String(existing.clause.values[1] ?? '');
    const inStart = String(incoming.clause.values[0] ?? '');
    const inEnd = String(incoming.clause.values[1] ?? '');
    // ISO date strings compare correctly as text.
    const exLabels = existing.rangeLabels ?? {
      start: existing.categoryLabel,
      end: existing.categoryLabel,
    };
    const inLabels = incoming.rangeLabels ?? {
      start: incoming.categoryLabel,
      end: incoming.categoryLabel,
    };
    const start = inStart < exStart ? inStart : exStart;
    const end = inEnd > exEnd ? inEnd : exEnd;
    const startLabel = inStart < exStart ? inLabels.start : exLabels.start;
    const endLabel = inEnd > exEnd ? inLabels.end : exLabels.end;
    const categoryLabel = startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
    const { table, column } = incoming.clause;
    return {
      sourceTileId: incoming.sourceTileId,
      clause: { table, column, operator: 'between', values: [start, end] },
      label: `${column}: ${categoryLabel}`,
      categoryLabel,
      kind: incoming.kind ?? existing.kind ?? 'axis',
      rangeLabels: { start: startLabel, end: endLabel },
    };
  }
  const existingValues = discreteValuesOf(existing);
  const incomingValues = discreteValuesOf(incoming);
  const clicked = incomingValues?.[0];
  if (existingValues === null || incomingValues === null || clicked === undefined) {
    // Shape mismatch (range vs discrete) — the new click wins the field.
    return incoming;
  }
  // Blank cannot OR with values: clicking blank over values (or a value over
  // blank) replaces the field's selection.
  if (clicked.raw === null || existingValues.some((v) => v.raw === null)) return incoming;
  const index = existingValues.findIndex((v) => sameRaw(v.raw, clicked.raw));
  const nextValues =
    index === -1
      ? [...existingValues, clicked]
      : existingValues.filter((_, i) => i !== index);
  if (nextValues.length === 0) return null;
  return crossFilterFromValues(incoming, nextValues);
};

/** Clamp an option index into [0, count-1] (0 when the list is empty). */
const clampIndex = (index: number, count: number): number =>
  count <= 0 ? 0 : Math.min(Math.max(Math.trunc(index), 0), count - 1);

/** Default selections: every parameter starts at its defaultIndex (clamped). */
const defaultParameterSelections = (layout: DashboardLayoutDoc): Record<string, number> =>
  Object.fromEntries(
    (layout.parameters ?? []).map((p) => [p.id, clampIndex(p.defaultIndex ?? 0, p.options.length)]),
  );

const toOpen = (detail: DashboardDetail): OpenDashboard => ({
  id: detail.id,
  name: detail.name,
  description: detail.description,
  modelId: detail.modelId,
  isShared: detail.isShared,
  ownerIsMe: detail.ownerIsMe,
  isSystem: detail.isSystem ?? false,
  ownerDisplayName: detail.ownerDisplayName ?? null,
  ownerUserId: detail.ownerUserId ?? null,
  // Pre-0.8 servers omit myAccess — owner gets full rights, others view-only.
  myAccess: dashboardAccessOf(detail),
  shareCount: detail.shareCount ?? 0,
  expectedUpdatedAtUtc: detail.updatedAtUtc,
  layout: migratePages(migrateSlicers(detail.layout?.tiles ? detail.layout : emptyLayout())),
});

const pagesOf = (layout: DashboardLayoutDoc): DashboardPage[] => layout.pages ?? [];

/** Defensive 0..1 clamp for cursor fractions (both directions of the wire). */
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const firstPageId = (layout: DashboardLayoutDoc): string | null =>
  pagesOf(layout)[0]?.id ?? null;

/** Keeps `preferred` while it still names a page; falls back to the first page. */
const resolveActivePageId = (
  layout: DashboardLayoutDoc,
  preferred: string | null,
): string | null =>
  preferred !== null && pagesOf(layout).some((page) => page.id === preferred)
    ? preferred
    : firstPageId(layout);

/** Smallest "Page N" (counting from pages.length + 1) not already taken. */
const nextPageName = (pages: DashboardPage[]): string => {
  const names = new Set(pages.map((page) => page.name));
  let n = pages.length + 1;
  while (names.has(`Page ${n}`)) n += 1;
  return `Page ${n}`;
};

/**
 * Migrates legacy top-bar slicers (layout.slicers[]) into checklist slicer
 * TILES appended below all content (free canvas, no pushing — they can never
 * overlap), then empties slicers[]. Idempotent: migrated docs re-open clean.
 * The migration is in-memory only until the user saves.
 */
const migrateSlicers = (layout: DashboardLayoutDoc): DashboardLayoutDoc => {
  const legacy = layout.slicers ?? [];
  if (legacy.length === 0) return layout.slicers ? layout : { ...layout, slicers: [] };
  const maxY = layout.tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
  const migrated: DashboardTile[] = legacy.map((def, index) => ({
    id: def.id,
    kind: 'slicer',
    layout: {
      x: (index % 4) * 6,
      y: maxY + Math.floor(index / 4) * 4,
      w: 6,
      h: 4,
      minW: 3,
      minH: 3,
    },
    slicer: { table: def.table, column: def.column, label: def.label, variant: 'checklist' },
  }));
  return { ...layout, tiles: [...layout.tiles, ...migrated], slicers: [] };
};

/**
 * Pages migration (runs AFTER migrateSlicers, so migrated slicer tiles land on
 * the page). Docs that already carry non-empty pages keep them as the source
 * of truth; legacy docs get one "Page 1" wrapping their tiles. Either way the
 * top-level tiles array is blanked — pages own the tiles from here on, and
 * save writes `tiles: []` so pre-pages readers still parse the doc. In-memory
 * only until the user saves. Idempotent.
 */
const migratePages = (layout: DashboardLayoutDoc): DashboardLayoutDoc => {
  const pages = layout.pages ?? [];
  if (pages.length > 0) return layout.tiles.length === 0 ? layout : { ...layout, tiles: [] };
  return { ...layout, tiles: [], pages: [{ id: newId(), name: 'Page 1', tiles: layout.tiles }] };
};

/**
 * Image sources the layout doc accepts: an encoded upload (data:image/*) or an
 * https URL. Anything else (javascript:, http:, blob:, …) is dropped to '' —
 * the tile renders its broken-image state instead of a dangerous URL.
 */
const safeImageSrc = (src: string): string => {
  const trimmed = src.trim();
  return /^data:image\//i.test(trimmed) || /^https:\/\//i.test(trimmed) ? trimmed : '';
};

/**
 * Sanitizes the writable belt-critical fields every button shape shares —
 * the rich label (sanitizeRichHtml) and the advanced-CSS override
 * (sanitizeButtonCss). Generic over ButtonTileSpec and ButtonGroupButton so
 * ALL four button write paths route through one helper.
 */
const sanitizeButtonFields = <T extends { html: string; customCss?: string }>(spec: T): T => ({
  ...spec,
  html: sanitizeRichHtml(spec.html),
  ...(spec.customCss !== undefined ? { customCss: sanitizeButtonCss(spec.customCss) } : {}),
});

/** Patch-shaped variant: html/customCss sanitize only when present. */
const sanitizeButtonFieldsPatch = <T extends { html?: string; customCss?: string }>(
  patch: T,
): T => ({
  ...patch,
  ...(patch.html !== undefined ? { html: sanitizeRichHtml(patch.html) } : {}),
  ...(patch.customCss !== undefined ? { customCss: sanitizeButtonCss(patch.customCss) } : {}),
});

/**
 * The group's container carries ONE html-bearing field (innerTitleHtml), which
 * must pass sanitizeRichHtml on every write like every other rich field —
 * plain fields ride the spread untouched. null container is preserved as null
 * (an explicit "no container"); absent stays absent.
 */
const sanitizeButtonGroupContainer = <T extends { container?: ContainerStyle | null }>(
  spec: T,
): T =>
  spec.container == null || spec.container.innerTitleHtml == null
    ? spec
    : {
        ...spec,
        container: {
          ...spec.container,
          innerTitleHtml: sanitizeRichHtml(spec.container.innerTitleHtml),
        },
      };

/** Full-spec sanitize for button-group writes (every button in the list). */
const sanitizeButtonGroupSpec = (spec: ButtonGroupTileSpec): ButtonGroupTileSpec =>
  sanitizeButtonGroupContainer({
    ...spec,
    buttons: spec.buttons.map((button): ButtonGroupButton => sanitizeButtonFields(button)),
  });

/** Error text for store state: RcdApiError-aware (friendly code fallbacks). */
const messageOf = (error: unknown): string => rcdErrorMessage(error);

/**
 * A deterministic 4xx verdict on ONE op (tile_locked, permission_denied,
 * op_invalid, layout_size…) — never retried (the answer cannot change) and
 * never a session failure (drainPending drops the op and resyncs). 408/429
 * stay transient: retryable, and degrading like transport failures.
 */
const isOpScopedRejection = (error: unknown): error is RcdApiError =>
  error instanceof RcdApiError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;
