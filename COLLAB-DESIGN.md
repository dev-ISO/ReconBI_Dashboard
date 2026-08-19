# Collaborative Dashboard Editing — design contract (target: 0.12.x, two waves)

Multiple people editing the same shared dashboard at once, safely: live sync,
autosave, presence, named cursors, and per-element merge so nobody's work is
ever silently discarded. Architecture chosen from a full assessment of this
codebase (see rationale at the end); the tracker's systems-grid collaboration
machinery (GridPresenceTracker, SystemEditorsChanged, applyRealtimeSystemInput)
is the shipped prior art this design deliberately mirrors.

**Chosen architecture: op-broadcast with per-tile last-writer-wins + soft tile
locks, with a server-side three-way tile merge as the reconnect/conflict
fallback.** Full CRDT was evaluated and REJECTED: CRDT convergence cannot
express the per-grantee permission model (layout/pages/charts classes), and the
layout doc is consumed as plain JSON by the differ, permission gate, email
snapshots, print, and seeds.

---

## Core mechanics (both waves)

### The op
Every edit becomes an op: `{dashboardId, opId, actorUserId, class:
layout|pages|charts, targetKind: tile|page|doc, targetId, payloadJson,
baseUpdatedAtUtc}`. The op vocabulary IS the store's existing action catalog —
all ~35 mutations already funnel through 4 seams (mutateActiveTiles,
mutateLayout, addPage/removePage direct writes), so emission is a decorator on
those seams, throttled by the existing coalescing windows (400 ms drags,
800 ms typing; updateTextTile gains the tag it's missing).

### Server: POST /dashboards/{id}/ops
(i) resolve the actor's share flags; (ii) classify the op with the SAME rules
DashboardLayoutDiffer already encodes (tile.layout→layout-class, chart→charts,
pages→pages, etc.) — an op cannot bypass the grantee gate; (iii) apply to
LayoutJson inside a transaction with SELECT … FOR UPDATE (kills the existing
save TOCTOU for the op path); (iv) bump UpdatedAtUtc; (v) fire
IRcdDashboardOpNotifier (Core abstraction, no-op default, TryAdd-registered —
the IRcdDispatchProgressNotifier pattern from 0.11.0). setModelId and
name/description/isShared are NOT ops (server already 403s grantees on them).

### Client: runtime.dashboards.applyRemoteOp(op)
Inbound applier reusing the mutation seams WITHOUT pushHistory and WITHOUT
dirty. THE MERGE DOCTRINE (copied from systemsStore.applyRealtimeSystemInput):
a remote op targeting an element the local user has locally-dirty edits on is
HELD (baseline advances, element untouched, conflict surfaced honestly);
remote ops on clean elements apply immediately. Suspend applying while
printOptions !== null (mirror the auto-refresh guard).

### Live mode vs draft mode
A dashboard with ≥1 edit-capable share grant is LIVE: entering edit joins the
`dashboard-{id}` group, every op persists immediately (this IS the autosave),
the toolbar reads "Live editing — changes save as you go", Save becomes "Done"
(exits edit mode), and Discard is replaced by scoped undo. Solo dashboards
(no edit grants) keep today's draft/save/discard exactly. Known accepted edge:
an admin editing an unshared dashboard via CanManageShared stays in draft mode
and keeps today's 409 behavior.

### Soft tile locks (conflict avoidance, not enforcement)
Server-side (dashboardId, tileId) claims with TTL heartbeat, acquired on
chart-builder open / drag start / text-editor focus, cleaned on disconnect —
a clone of GridPresenceTracker. Wave 1 uses locks invisibly: to hold
conflicting remote ops and to make the chart builder refuse to save over a
tile someone else re-locked (its draft never rebases — the strongest reason
locks exist). Wave 2 renders them.

### Undo/redo under live sync
History becomes locally-scoped: undo re-applies inverse state only for
elements the LOCAL user changed this session (emitted as ops so it syncs);
a collaborator's concurrent work can never be reverted by someone else's
Ctrl+Z. (Today's whole-doc snapshots would revert their tiles too.)

### Reconnect = refetch, not replay
On SignalR reconnect: re-GET the dashboard, reconcile against the local dirty
set (chat's resync doctrine). No op log, no replay, no vector clocks in wave 1.

### Fixed regardless (wave 1 includes)
- Omitted expectedUpdatedAtUtc no longer means blind overwrite: the save
  endpoint REQUIRES the stamp for updates (grandfathering internal callers).
- View-mode bookmark autosave stops writing the whole migrated doc: bookmarks
  become ops (they're id-keyed doc elements already).
- Backend tests for rcd.dashboard.stale (currently zero).
- Shares-PUT gains expectedUpdatedAtUtc-style concurrency (deferred from the
  0.11.x permission wave to here, where the machinery exists).

---

## Wave 1 — safe concurrent editing (no cursors, no presence UI)
Library: IRcdDashboardOpNotifier + op DTOs; ops endpoint (classification,
FOR UPDATE, notifier); store op emission at the 4 seams + applyRemoteOp +
locally-scoped history + dirty-hold set; live-mode session plumbing; soft-lock
service + heartbeat; suspension rules. Tracker: dashboard-{id} SignalR group +
Join/Leave hub methods + disconnect cleanup; RcdDashboardOp event in
RealtimeEventNames/realtimeContract (chat-island module-augmentation style);
notifier adapter over RealtimeNotifier; useRealtimeEvents → applyRemoteOp
forwarding. Tests: op classification parity with the differ (every differ test
case re-expressed as an op), dirty-hold semantics, FOR UPDATE serialization,
lock TTL, reconnect reconciliation.
Exit criteria: two browsers editing different tiles of one dashboard never
lose work in any interleaving; same-tile conflict is held + surfaced; kill the
network mid-edit and reconnect reconciles.

## Wave 2 — presence, cursors, shared interactions
- "Editing now" avatar strip (clone SystemsPage's banner incl. capability +
  personal-setting gating) fed by the same presence tracker.
- Named cursors: ephemeral pointer channel (throttled ~10 Hz, TTL like chat
  typing indicators — HTTP-in/SignalR-out or hub method; never persisted),
  rendered as colored pointers with display names over the grid; grid-relative
  coordinates so zoom/fit render correctly per client.
- Lock visibility: tile outline + "being edited by X" chip.
- Shared slicers: SlicerTileSpec.shared?: boolean (owner-configured); when
  set, setSlicerValue broadcasts as an ephemeral (non-persisted) session value
  to the group; unset slicers stay per-user as today. relativeDate preset
  writes stay authored defaults (doc), never broadcast.
- Hover/cross-filter/drill: NEVER broadcast (already per-session — verified).
- Global filters: already modelled as owner-authored filterCards[] + per-user
  filterCardOverrides — wave 2 only polishes the labeling ("Global filter" vs
  "Your view") in FiltersPane/indicator, no architecture.

## Sequencing
After 0.11.x ships (subscriptions management + the rename/button/permissions
wave). Wave 1 and Wave 2 are separate releases; Wave 1 is valuable alone.

## Rationale (assessment summary)
Whole-doc saves are ~20 KB vs 0.6–1.8 KB per-tile ops; every doc element is
already id-keyed (differ aligns docs by those ids — its extraction machinery
is the merge core); the differ's three classes are already the per-grantee
authorization model, portable per-op; presence/locks/merge doctrines exist
shipped in the tracker's systems grid; the 0.11.0 dispatch-progress seam is
the first inbound host→store event path and this design extends it. Rejected:
(b) merge-only-on-save as primary (no live sync between saves, whole-doc
replaces nuke transient state); (c) CRDT (permission model unauthorizable,
massive downstream JSON consumers). Single-instance SignalR (no backplane) is
an accepted constraint — documented; scale-out would need Redis backplane +
shared lock store.
