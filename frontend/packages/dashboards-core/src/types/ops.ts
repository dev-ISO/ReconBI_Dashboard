// Collaborative-editing op vocabulary (COLLAB-DESIGN wave 1).
//
// Every live-mode edit becomes ONE op: a small, id-keyed record the ops
// endpoint (POST /dashboards/{id}/ops) applies to LayoutJson server-side and
// broadcasts verbatim to the dashboard's SignalR group. The vocabulary is
// CLOSED and mirrors the store's mutation seams — all ~35 store actions funnel
// through 4 seams (mutateActiveTiles, mutateLayout, addPage/removePage), so a
// structural doc diff at those seams provably covers the whole catalog.
//
// THE PAYLOAD SHAPES BELOW ARE THE WIRE CONTRACT VERBATIM (reconciled to the
// backend's DashboardOpApplier, which is authoritative): camelCase kinds, and
// STRICT payloads — the server rejects any top-level property a kind does not
// declare (op_invalid), so senders must never attach extras. Receivers
// re-apply the broadcast PayloadJson unparsed-then-verbatim, which is exactly
// why the library's INTERNAL vocabulary and the wire vocabulary are one and
// the same type: the server's application and every receiver's application
// stay provably the same op.
//
//   tileUpsert / tileRemove / tileGeometry            (targetKind 'tile')
//   pageAdd / pageRename / pageColor /
//   pageSet / pageRemove                              (targetKind 'page')
//   pageReorder / docElementUpsert /
//   docElementRemove / docSettingSet                  (targetKind 'doc')
//
// targetId carries the element's id; it is null ONLY for pageReorder and
// docSettingSet (true doc-level ops). Removal kinds are idempotent server-side
// (an already-gone target is a no-op); kinds that need their target answer a
// vanished one with 409 rcd.dashboard.op_target_missing — the client's cue to
// resyncFromServer (reconnect = refetch doctrine).
//
// setModelId and name/description/isShared are deliberately NOT ops (the
// design excludes them; the server already 403s grantees on those fields) —
// they keep their existing immediate-PUT paths.
import type {
  DashboardBookmark,
  DashboardPage,
  DashboardParameter,
  DashboardTile,
  FilterCard,
  FilterIndicatorStyle,
  CrossFilterScope,
  PageDrillthrough,
  PageMobileLayout,
  TileLayout,
  ViewFitMode,
} from './dashboard';
import type { Measure } from './model';

/** The differ's three permission classes, resolved per-op by the server's
 * grantee gate. The client computes them faithfully (chart tiles → charts,
 * page ops → pages, everything else → layout) but the SERVER's classification
 * is authoritative — an op can never bypass the grant model. */
export type DashboardOpClass = 'layout' | 'pages' | 'charts';

export type DashboardOpTargetKind = 'tile' | 'page' | 'doc';

/**
 * One committed dashboard edit op as broadcast to the dashboard's group —
 * mirrors the tracker's RcdDashboardOpEventDto (Backend/Interfaces) and the
 * host-local RcdDashboardOpEvent (rcdCollab.ts) field for field. The host's
 * realtime bridge forwards each event into
 * `runtime.dashboards.applyRemoteOp(event)` untouched.
 */
export interface DashboardOpEvent {
  dashboardId: number;
  /** Client-generated unique id — receivers drop the echo of their own op by it. */
  opId: string;
  /** Host user who authored the edit (attribution; resolved server-side). */
  actorUserId: number;
  /** See DashboardOpClass; `(string & {})` tolerates future server classes. */
  class: DashboardOpClass | (string & {});
  targetKind: DashboardOpTargetKind | (string & {});
  /** Id of the targeted doc element; null for doc-level (doc.set) ops. */
  targetId: string | null;
  /** Serialized DashboardOpPayload — opaque to server and tracker alike. */
  payloadJson: string;
  /** The dashboard's UpdatedAtUtc AFTER this op; receivers advance their
   * concurrency baseline to it (reconnect = refetch, never replay). */
  resultUpdatedAtUtc: string;
}

/** The doc's id-keyed element collections doc.elementUpsert/Remove address.
 *  'measures' = the dashboard-scoped measure store; it is here (rather than
 *  riding docSettingSet as one whole-array scalar) so a live-mode measure edit
 *  merges PER MEASURE like a filter card, instead of last-writer-wins over
 *  every measure at once. Without this entry diffLayoutDocs emits ZERO ops for
 *  a measure edit and the edit is silently lost on save. */
export type DocElementField = 'filterCards' | 'bookmarks' | 'parameters' | 'measures';

/** An element of one of the doc's id-keyed collections. */
export type DocElement = FilterCard | DashboardBookmark | DashboardParameter | Measure;

/** The doc-level scalar keys docSettingSet writes (one key per op; the server
 * additionally refuses the structural keys "pages"/"tiles" for ANY caller). */
export type DocSettingKey =
  | 'refreshSeconds'
  | 'filterIndicator'
  | 'crossFilterScope'
  | 'defaultViewFit';

/** docSettingSet value shape per key (null is a legal stored value; a wire
 * payload with the `value` property ABSENT removes the key instead). */
export type DocSettingValue =
  | number
  | FilterIndicatorStyle
  | CrossFilterScope
  | ViewFitMode
  | null;

/** The page-scoped scalar props pageSet may patch — and NOTHING else (the
 * server op_invalids other keys: whole-page writes would stomp concurrent
 * tile edits). A key present with null REMOVES it; absent leaves it. */
export interface PageScalarPatch {
  mobileLayout?: PageMobileLayout | null;
  drillthrough?: PageDrillthrough | null;
}

/**
 * The op body — produced by the sender's doc diff, POSTed as a JSON OBJECT
 * (`payload`), broadcast back to receivers serialized in payloadJson. The
 * target element's id rides the op record's targetId. Upserts carry the FULL
 * element (per-element last-writer-wins — no partial patches to merge, no
 * operational transforms). STRICT: no properties beyond the declared ones.
 */
export type DashboardOpPayload =
  /** Add or fully replace one tile (tile.id === targetId). `pageId` places a
   * NEW tile and is ignored on replace (cross-page moves travel as
   * tileRemove + tileUpsert). */
  | { kind: 'tileUpsert'; tile: DashboardTile; pageId?: string }
  | { kind: 'tileRemove' }
  /** Move/resize only — the geometry half of the differ's layout class. */
  | { kind: 'tileGeometry'; layout: TileLayout }
  /** Insert a page (page.id === targetId; tiles normally empty) at `index`
   * (clamped; append when absent). An existing id is REPLACED (idempotent). */
  | { kind: 'pageAdd'; page: DashboardPage; index?: number }
  | { kind: 'pageRename'; name: string }
  /** `color` ABSENT removes the page's color (the wire's "clear"). */
  | { kind: 'pageColor'; color?: string | null }
  | { kind: 'pageSet'; patch: PageScalarPatch }
  | { kind: 'pageRemove' }
  /** Doc-level (targetKind 'doc', targetId null): surviving pages follow this
   * order; pages the list does not know (concurrent adds) keep relative order
   * at the end, so a stale reorder never drops a page. */
  | { kind: 'pageReorder'; pageIds: string[] }
  /** Add or fully replace one element (element.id === targetId) of an
   * id-keyed doc collection; new elements append. */
  | { kind: 'docElementUpsert'; field: DocElementField; element: DocElement }
  | { kind: 'docElementRemove'; field: DocElementField }
  /** Doc-level (targetKind 'doc', targetId null): ONE scalar per op. `value`
   * ABSENT removes the key (JSON.stringify drops undefined, so senders clear
   * by omission; null is a legal stored value and travels as null). */
  | { kind: 'docSettingSet'; key: DocSettingKey; value?: DocSettingValue };

/**
 * A not-yet-serialized op on the SENDING side: payload + addressing.
 * dashboardId/opId/baseUpdatedAtUtc are stamped at send time (the payload may
 * sit in the coalescing buffer first). `class` is INTERNAL bookkeeping only —
 * the reconciled wire request carries no class (the server classifies every
 * op with the differ's own rules, so the grantee gate can never be bypassed);
 * it documents the expected classification for history entries and tests.
 */
export interface DashboardLocalOp {
  class: DashboardOpClass;
  targetKind: DashboardOpTargetKind;
  targetId: string | null;
  payload: DashboardOpPayload;
}

/**
 * The per-element identity used by the dirty-hold doctrine and the pending
 * buffer: a remote op and a local edit conflict iff they share this key.
 * Id-targeted ops key on their element; the two null-target doc ops key on
 * what they actually touch — docSettingSet per SCALAR KEY and pageReorder on
 * its own page-order bucket — so a pending reorder never holds (and then
 * falsely supersedes) a collaborator's unrelated refreshSeconds change.
 */
export const opConflictKey = (
  targetKind: string,
  targetId: string | null,
  payload: DashboardOpPayload,
): string => {
  if (targetId !== null) return `${targetKind}:${targetId}`;
  if (payload.kind === 'docSettingSet') return `doc:@setting:${payload.key}`;
  if (payload.kind === 'pageReorder') return 'doc:@pageOrder';
  return `${targetKind}:`;
};

/* ===================================================== wave 2 — presence,
 * cursors, shared interactions. These are the INBOUND host→store event shapes
 * (the pinned wire contract): the host's realtime bridge forwards each hub
 * event verbatim into the matching runtime.dashboards.apply* action, exactly
 * like RcdDashboardOp → applyRemoteOp. All four channels are HOST-owned
 * ephemera — presence, cursor and shared-slicer traffic never touches the
 * library backend; only tile-lock changes originate there (via
 * IRcdDashboardTileLockNotifier). User ids are the HOST's numeric ids
 * (translated by the host, same as DashboardOpEvent.actorUserId).
 */

/** One editor in the dashboard's "editing now" presence set. */
export interface DashboardCollabEditor {
  userId: number;
  userName: string;
}

/** Presence roster change → runtime.dashboards.applyEditorsChanged(event).
 * The host's presence tracker owns membership; every event carries the FULL
 * current set (never deltas), so a missed frame self-heals on the next. */
export interface DashboardEditorsChangedEvent {
  dashboardId: number;
  editors: DashboardCollabEditor[];
}

/** A collaborator's pointer → runtime.dashboards.applyRemoteCursor(event).
 *
 * xFrac/yFrac are the pointer's position as 0..1 FRACTIONS of the grid
 * content box's layout size — zoom-independent by construction, so every
 * client renders the pointer over the same tile regardless of its own
 * fit-to-page scale. THE HOST FILTERS THE SENDER'S OWN ECHO before
 * forwarding: the store cannot (it never learns the local user's numeric
 * host id) and therefore keeps every cursor it receives. */
export interface DashboardRemoteCursorEvent {
  dashboardId: number;
  userId: number;
  userName: string;
  /** Page the pointer is on — receivers render it on that page only. */
  pageId: string;
  xFrac: number;
  yFrac: number;
  /** Sender timestamp (ISO); informational — receivers TTL on arrival time. */
  at: string;
}

/** A soft tile lock changed → runtime.dashboards.applyTileLock(event).
 * Broadcast for fresh acquires, steals and explicit releases only — never
 * heartbeat extensions — so receivers ALSO drop a lock once expiresAtUtc
 * passes (the holder may well still hold it; a vanished chip is the accepted
 * cost of a quiet channel, and the next steal/release still lands). */
export interface DashboardTileLockEvent {
  dashboardId: number;
  tileId: string;
  holderUserId: number;
  holderName: string;
  expiresAtUtc: string;
  released: boolean;
}

/** A SHARED slicer's value picked by a collaborator →
 * runtime.dashboards.applyRemoteSlicerValue(event). valueJson is the
 * serialized SlicerValue (JSON `null` = cleared); ephemeral session state —
 * never persisted, never rebroadcast by receivers. */
export interface DashboardRemoteSlicerValueEvent {
  dashboardId: number;
  tileId: string;
  userId: number;
  valueJson: string;
}

/** Error code the tile-lock endpoints return when another user holds the lock. */
export const TILE_LOCKED_ERROR = 'rcd.dashboard.tile_locked';

/** Error code of an op whose required target vanished (409) — the client's
 * cue to resyncFromServer rather than degrade (reconnect = refetch doctrine). */
export const OP_TARGET_MISSING_ERROR = 'rcd.dashboard.op_target_missing';
