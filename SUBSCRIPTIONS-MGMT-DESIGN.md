# Subscriptions & Alerts Management — design contract (target: 0.11.0)

Brings dashboard subscriptions and alerts up to the management standard set by
the tracker's scheduled reports (`ReportsController scheduled/*` +
`ScheduledReportDispatcher`): admin visibility, one-click pause, send-now,
per-send delivery history with failure visibility, per-recipient unsubscribe,
and a real management surface for alerts. This is a LIBRARY wave — the tracker
consumes it as packages; the only tracker-side work is re-applying
`rcd_schema.sql` and (optionally) granting the admin capability it already has.

**Prerequisite:** the 0.10.5 wave (wire fix + plant-local time + scheduler/
email wiring). Everything below assumes deliveries actually send.

---

## 1. Schema (additive only; re-export rcd_schema.sql; hand-apply per the
##    established path — local, dev-DO, prod)

```sql
-- One row per delivery occurrence (scheduled or manual send-now), per
-- subscription. Mirrors ScheduledReportSendAttempt.
CREATE TABLE rcd_subscription_dispatches (
    "Id"              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "SubscriptionId"  integer NOT NULL,           -- no FK cascade: history survives sub deletion (SubscriptionName snapshotted)
    "SubscriptionName" varchar(200) NOT NULL,     -- snapshot, like NotificationDelivery copies Title
    "DashboardId"     integer NOT NULL,
    "Trigger"         varchar(10) NOT NULL,       -- 'schedule' | 'manual'
    "RequestedBy"     varchar(64)  NULL,          -- user id for manual sends
    "StartedUtc"      timestamp NOT NULL,
    "FinishedUtc"     timestamp NULL,
    "Status"          varchar(12) NOT NULL,       -- 'running' | 'sent' | 'partial' | 'failed' | 'skipped'
    "Error"           varchar(1000) NULL          -- occurrence-level error (render failure etc.)
);
CREATE INDEX ix_rcd_sub_dispatches_sub ON rcd_subscription_dispatches ("SubscriptionId", "StartedUtc" DESC);

-- One row per recipient per dispatch. Mirrors ScheduledReportRecipientDelivery.
CREATE TABLE rcd_subscription_dispatch_recipients (
    "Id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "DispatchId"  bigint NOT NULL REFERENCES rcd_subscription_dispatches("Id") ON DELETE CASCADE,
    "Email"       varchar(320) NOT NULL,
    "Status"      varchar(12) NOT NULL,            -- 'sent' | 'failed' | 'optedOut'
    "Attempts"    integer NOT NULL DEFAULT 0,
    "Error"       varchar(1000) NULL,
    "SentUtc"     timestamp NULL,
    -- Open tracking (pixel): first-open instant + total opens. Accuracy is
    -- inherently approximate — mail clients proxy or block images, and the
    -- pixel resolves through the app (Cloudflare Access), so only recipients
    -- who can reach the app register. Surfaced as "Opened"/"—", never as a
    -- read receipt guarantee.
    "OpenedUtc"   timestamp NULL,
    "OpenCount"   integer NOT NULL DEFAULT 0
);
CREATE INDEX ix_rcd_sub_dispatch_recips ON rcd_subscription_dispatch_recipients ("DispatchId");

-- Per-subscription recipient opt-outs (the unsubscribe target).
CREATE TABLE rcd_subscription_optouts (
    "SubscriptionId" integer NOT NULL,
    "Email"          varchar(320) NOT NULL,
    "OptedOutUtc"    timestamp NOT NULL,
    PRIMARY KEY ("SubscriptionId", "Email")
);

-- Global opt-out: suppresses this address from EVERY dashboard subscription
-- email. Checked before the per-subscription table; clearing is admin-only.
CREATE TABLE rcd_global_optouts (
    "Email"       varchar(320) PRIMARY KEY,
    "OptedOutUtc" timestamp NOT NULL
);

-- Alert firing history already exists (rcd_alert_firings) — reused as-is.
```

No changes to `rcd_subscriptions` / `rcd_alerts`. `LastRunUtc` stays as the
scheduler's due-math cache; the dispatch table is the audit truth.

## 2. Delivery semantics (SchedulingEvaluator changes)

- **Per-recipient sends** replace the single multi-recipient email (required
  for opt-out and per-recipient status; matches the sibling). Recipients that
  match an opt-out row are recorded as `optedOut`, never attempted.
- **Retries with backoff, in-process:** up to 3 attempts per recipient at
  0s / 2min / 8min (sibling's exponential pattern, capped for the 1-minute
  scheduler cadence: the dispatch row stays `running`, a small in-memory retry
  queue inside `RcdSchedulerService` finishes it; process restart abandons
  retries — the dispatch closes as `failed` on next tick, honestly recorded).
- Occurrence status roll-up: all sent → `sent`; some → `partial`; none →
  `failed`; owner lost dashboard access / dashboard deleted → `skipped` with
  reason in `Error`.
- Every send goes through the SAME dispatch pipeline whether scheduled or
  send-now (`Trigger` distinguishes them).
- **Unsubscribe footer** on every subscription email: a link to
  `{PublicBaseUrl}/api/rcd/v1/subscriptions/unsubscribe?token=…`, where token =
  HMAC-SHA256(subscriptionId + ':' + email) with a server-side secret
  (`ReconDashboardsOptions.UnsubscribeSecret`; tracker supplies one via env).
  GET renders a minimal confirm page offering BOTH scopes — "Unsubscribe from
  this report" and "Unsubscribe from all dashboard emails" (global) — POST
  records the chosen opt-out. The token is self-authenticating — no login
  identity needed — but the app sits behind Cloudflare Access, so recipients
  must be able to reach the app (true for plant staff; documented limitation
  for external recipients).
- **Open tracking:** each sent email embeds a 1×1 pixel
  `{PublicBaseUrl}/api/rcd/v1/subscriptions/open?token=…` (HMAC over the
  dispatch-recipient id). The anonymous endpoint returns the GIF and stamps
  OpenedUtc (first open) / increments OpenCount. Mirrors the sibling's
  tracking; same Cloudflare Access + image-proxy accuracy caveats as the
  schema comment. Deliberately privacy-visible: the manager UI labels the
  column "Opened (approximate)".
- **Live send-progress (SignalR) via a host seam:** the library cannot own a
  socket, so it defines `IRcdDispatchProgressNotifier` (Core abstraction,
  no-op default) with DispatchStarted / RecipientResult / DispatchFinished
  targeted at the OWNER's user id. The tracker implements it over its
  existing EventsHub/RealtimeNotifier (new `rcdDispatchProgress` event in
  RealtimeEventNames/realtimeContract), and `useRealtimeEvents` forwards the
  payload into the dashboards runtime via a new
  `runtime.dashboards.applyDispatchProgress(event)` action — the same
  library-seam pattern as IUserDirectory. The manager UI renders a live
  per-recipient progress strip during Send now and falls back to 2s polling
  when the host never forwards events (portal/demo hosts).
- **Failure alerts into the notification bell via a host seam:**
  `IRcdDeliveryFailureNotifier` (Core abstraction, no-op default) fires when a
  dispatch closes `failed`/`partial` with subscription name + first error.
  The tracker adapter writes a NotificationDelivery bell row for the OWNER
  (new SourceKind `'rcd'`, title/body copied — self-contained like all
  delivery rows) and pushes it live via the existing
  NotificationDeliveredAsync realtime path. Implementer MUST verify the
  tracker RetentionWorker's pruning tolerates the new SourceKind (age-based
  fallback) and that the bell's synthesis/read paths ignore unknown kinds
  gracefully.
- **Retention:** dispatch rows older than 90 days pruned by a daily sweep in
  `RcdSchedulerService` (library-contained; no host worker involvement).

## 3. Endpoints (SubscriptionsController + AlertsController)

| Endpoint | Who | Notes |
|---|---|---|
| `GET /subscriptions?scope=mine\|all` | mine: any authoring user; all: CanManageShared | `all` adds owner display name via IUserDirectory |
| `POST /subscriptions/{id}/enabled` `{enabled}` | owner or admin | one-click pause/resume (mirrors SystemNotification SetEnabled) |
| `POST /subscriptions/{id}/send-now` | owner or admin | enqueues a `manual` dispatch; 429-style guard: one concurrent manual send per subscription |
| `GET /subscriptions/{id}/dispatches?limit=20` | owner or admin | dispatch rows + recipient rows (history) |
| `GET/POST /subscriptions/unsubscribe?token=` | anonymous (token-authenticated) | confirm page + opt-out write |
| `GET /subscriptions/{id}/optouts` / `DELETE …/optouts/{email}` | owner or admin | see + clear opt-outs (re-invite someone) |
| `GET /subscriptions/unsubscribe?token=` (page) / `POST` `{scope: 'one'\|'all'}` | anonymous (token) | per-subscription or GLOBAL opt-out |
| `GET /subscriptions/open?token=` | anonymous (token) | 1×1 open-tracking pixel; stamps OpenedUtc/OpenCount |
| `GET /subscriptions/optouts/global` / `DELETE …/global/{email}` | admin (CanManageShared) | view + clear global suppressions |
| `GET /alerts?scope=mine\|all` | as above | exists as `mine` only today — add scope |
| `POST /alerts/{id}/enabled` | owner or admin | pause an alert |
| existing `alerts/{id}` PUT/DELETE, `alerts/{id}/test`, `alerts/firings` | — | already implemented, finally get a UI |

Permission seam: the existing `ICurrentUserProvider.CanManageShared` — no new
capability. (Tracker: Admins already have it.)

## 4. UI (dashboards-ui)

**New "Subscriptions & alerts" manager** — opened from (a) the Dashboards
sidebar footer ("Manage subscriptions") and (b) the existing per-dashboard
Subscribe… dialog's "Manage all…" link. One dialog, two tabs:

- **Subscriptions tab:** table of subscriptions — Name, Dashboard, Schedule
  (plant-local wording), Recipients count, Enabled toggle (one click),
  **Last delivery** badge (`Sent 7:00 AM CT` / `Failed — SMTP timeout` /
  `Partial 2/3`), owner (admin scope), actions: **Send now**, History, Edit
  (opens the existing dialog prefilled), Delete. Scope switch "Mine / All"
  visible only with CanManageShared. Send now shows a LIVE per-recipient
  progress strip (SignalR seam above; 2s polling fallback when the host never
  forwards events).
- **History drawer:** last 20 dispatches for a subscription; each expands to
  per-recipient rows with status, attempts, error text, opt-out marker, and
  "Opened (approximate)" from the tracking pixel.
- **Alerts tab:** alerts with measure/condition summary, Enabled toggle, last
  fired (from `alerts/firings`), Test send, Edit (reopens AlertDialog), Delete
  — making alerts findable after creation for the first time.
- The per-dashboard Subscribe… dialog list rows also get the Last-delivery
  badge and the one-click Enabled toggle (same components).

## 5. Tracker-side work (small)

1. Re-run `rcd_schema.sql` (new export) on local + dev-DO + prod — the
   established hand-apply path; additive tables only, idempotent.
2. `.env`: `RCD_UNSUBSCRIBE_SECRET` (any long random string) +
   `RCD_PUBLIC_BASE_URL` (the tunnel URL) threaded into options.
3. Host seams: implement `IRcdDispatchProgressNotifier` over
   EventsHub/RealtimeNotifier (+ realtimeContract event + useRealtimeEvents
   forwarding into `runtime.dashboards.applyDispatchProgress`), and
   `IRcdDeliveryFailureNotifier` over NotificationDeliveryService (SourceKind
   `'rcd'` bell rows; verify RetentionWorker + bell paths tolerate the kind).
4. Everything else — capability, email transport, zone options — lands in
   0.10.5.

## 6. Explicitly out of scope (future candidates)

Digest/quiet-hours scheduling; delivery windows per recipient; Slack/Teams
transports.

## 7. Estimate & sequencing

Library: schema export + evaluator rework (the largest piece: per-recipient
pipeline + retry queue + dispatch writes + opt-out/global checks + pixel and
unsubscribe token endpoints + progress/failure notifier seams), ~11 endpoints,
manager UI (~2 new components + live progress strip + edits to 2 dialogs),
tests (evaluator dispatch/retry/opt-out/global paths, token round-trips for
unsubscribe AND pixel, API surface, notifier no-op defaults). Tracker: seam
adapters (progress → SignalR, failure → bell), realtime contract event,
useRealtimeEvents forwarding, env keys, schema apply. One focused
implementation wave (Fable) + orchestrator review; QUEUED to start
immediately after the 0.10.5 review completes (user-approved 2026-08-19) —
prod verification of 0.10.5 happens in parallel, and 0.11.0 ships only after
both its own gates AND 0.10.5's prod verification pass.
