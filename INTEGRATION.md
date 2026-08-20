# Integrating ReconDashboards into a host application

The library mounts into an ASP.NET Core host with one DI call and into a React
SPA as an embeddable component set. This guide covers both, plus the database
setup and the per-host rollout steps for the two Recon apps.

## 1. Database prerequisites

**Chart data connection — use a read-only role.** Never point a data source at
an owner/app role:

```sql
CREATE ROLE chart_reader LOGIN PASSWORD '<secret>';
GRANT CONNECT ON DATABASE <appdb> TO chart_reader;
GRANT USAGE ON SCHEMA public TO chart_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chart_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO chart_reader;
```

The engine additionally opens sessions with `default_transaction_read_only=on`
and a statement timeout, and only ever compiles single SELECT statements — the
role is the first line of defense, not the only one.

**Library storage (rcd_ tables).** The library owns three tables
(`rcd_data_models`, `rcd_dashboards`, `rcd_query_audit`) under its own
migrations history table `__RcdMigrationsHistory`, so it coexists with the
host's EF context in the same database. Apply schema per your doctrine —
never auto-migrate at startup:

- **EF bundle (Docker hosts):** the demo's Dockerfile shows the pattern —
  `dotnet ef migrations bundle --context ReconDashboardsDbContext ...` in the
  build stage, executed by a one-shot compose service.
- **Idempotent SQL (IIS hosts):** apply `db/rcd_schema.sql` via psql. Safe to
  re-run; regenerate with `backend/scripts/export-migration-sql.ps1` after
  library upgrades.

## 2. Backend (.NET)

Get packages: run `backend/scripts/pack-local.ps1 -Version <v> -CopyTo
<host>\Backend\LocalPackages`, and add a `nuget.config` next to the host
csproj:

```xml
<configuration>
  <packageSources>
    <add key="local" value="LocalPackages" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
```

csproj (versions float within 10.x so the host's exact EF/Npgsql pins win):

```xml
<PackageReference Include="ReconDashboards.Core" Version="<v>" />
<PackageReference Include="ReconDashboards.Postgres" Version="<v>" />
<PackageReference Include="ReconDashboards.AspNetCore" Version="<v>" />
```

Program.cs:

```csharp
builder.Services.AddControllers()
    .AddReconDashboards(rcd =>
    {
        rcd.RoutePrefix = "api/rcd";               // endpoints under api/rcd/v1/*
        rcd.ViewPolicy = null;                     // fallback auth still applies
        rcd.AuthorPolicy = "RcdAuthor";            // host-defined policies
        rcd.AdminPolicy = "RequireAdminRole";
        rcd.EnableQueryAudit = true;
        rcd.ConfigureStorage = o => o.UseNpgsql(
            builder.Configuration.GetConnectionString("DefaultConnection")!,
            n => n.MigrationsAssembly("ReconDashboards.Postgres")
                  .MigrationsHistoryTable("__RcdMigrationsHistory"));
        rcd.AddPostgresDataSource("main", ds =>
        {
            ds.ConnectionString = builder.Configuration.GetConnectionString("RcdChartsReadOnly")!;
            ds.DeniedTables.AddRange(["Users", "RefreshTokens"]);   // deny wins
        });
    });

builder.Services.AddScoped<ICurrentUserProvider, HostCurrentUserProvider>();
builder.Services.AddScoped<IRowFilterContributor, HostScopeContributor>();   // optional, FAIL CLOSED
```

`app.MapControllers()` picks the endpoints up; `app.UseRateLimiter()` (already
present in both hosts) activates the per-user query rate limit.

Host-implemented seams:

- `ICurrentUserProvider` — two members: `GetUserId()` (stable opaque id, e.g.
  the NameIdentifier claim) and `CanManageShared` (admin role check). The
  library stores the id as an opaque string; no FKs into host tables.
- `IUserDirectory` (optional, 0.8.0+) — backs the Share dialog's user picker
  (`GET users?query=`) and decorates share lists / activity entries / dashboard
  summaries with display names. Two members: `ListUsersAsync(query, ct)` and a
  batch `ResolveAsync(userIds, ct)` (never called per-row). Implement it over
  your Users table and register it AFTER `AddReconDashboards` (last
  registration wins). Without one, the built-in `NullUserDirectory` applies:
  the picker lists nothing (the dialog shows "user directory not configured")
  and ids echo back as display names — everything else keeps working.
- `IRowFilterContributor` (zero or more) — row-level scoping. Called for EVERY
  table in every compiled query, including join targets. Return
  `RowFilterDecision.Filter(new RowFilter("col", RowFilterOperator.In, values))`
  to constrain, `Allow` to pass, `DenyAccess()` to block. A thrown exception
  DENIES the query — there is no unfiltered fallback. Scope your fact tables,
  not just dimension tables: the contributor only applies to tables actually
  referenced by a query.

### Scheduling + email delivery (subscriptions & alerts)

Opt-in: `builder.Services.AddReconDashboardsScheduling()` after
`AddReconDashboards` registers the 1-minute background evaluator for
subscription snapshots and data alerts.

- **Email transport** — register your own `IRcdEmailSender` (an adapter over
  the host's existing mail pipeline) and call `AddReconDashboardsScheduling()`
  with NO arguments: the library then registers no sender of its own.
  Alternatively pass `builder.Configuration` and configure `Rcd:Email`
  (Host/Port/From/User/Password/UseSsl) for the built-in `SmtpEmailSender`;
  with no `Rcd:Email:Host` that path falls back to a `FileEmailSink` .eml drop
  folder — fine for the demo host, never intended for production.
- **Plant-local schedules** — `rcd.ScheduleTimeZoneId` (IANA/Windows id,
  default `"UTC"`) is the zone daily/weekly send times are interpreted in;
  `rcd.ScheduleTimeZoneLabel` (default `"UTC"`, e.g. `"CT"`) is stamped into
  emails. Mirror both on the frontend via the provider:
  `<DashboardsProvider scheduleTimeZoneId="America/Chicago"
  scheduleTimeLabel="CT" …>` so the Subscribe dialog labels match reality.
  DST edges are defined: a spring-forward gap time advances by the gap; a
  fall-back ambiguous time maps to standard time (one send per day).
- Wire fields are `timeOfDayLocal` ("HH:mm" in that zone) and `dayOfWeek`
  (0 = Sunday); recipients travel as ONE `';'`-joined string. The storage
  columns keep their historical `*Utc` names — no schema change on upgrade.

### Subscriptions & alerts management (0.11.0+)

Every send — scheduled or the manager UI's **Send now** — runs the same
per-recipient pipeline and is recorded in `rcd_subscription_dispatches` +
`rcd_subscription_dispatch_recipients` (90-day retention, library-pruned).
Failed recipients retry in-process at +2min/+8min; a restart abandons retries
and the next tick closes the orphaned dispatch as `failed`, honestly.

- **Unsubscribe + open tracking** — set BOTH `rcd.UnsubscribeSecret` (any long
  random string; e.g. from an `RCD_UNSUBSCRIBE_SECRET` env var) and
  `rcd.PublicBaseUrl` (the public origin mail clients can reach, e.g. the
  tunnel URL). Emails then carry an HMAC-token unsubscribe footer (anonymous
  confirm page offering per-subscription AND global scopes; opt-outs land in
  `rcd_subscription_optouts` / `rcd_global_optouts`) and a 1×1 open pixel
  ("Opened (approximate)" in the history UI). With either option unset,
  emails simply omit footer and pixel — never broken links.
- **Host seams (both optional, no-op by default)** —
  `IRcdDispatchProgressNotifier` (DispatchStarted / RecipientResult /
  DispatchFinished, targeted at the subscription OWNER's user id) lets the
  host forward live send progress over its own socket; the frontend applies
  events via `runtime.dashboards.applyDispatchProgress(event)` and falls back
  to 2s polling when no events arrive. `IRcdDeliveryFailureNotifier` fires
  once per dispatch that closes failed/partial — e.g. write a notification-
  bell row. Register either AFTER `AddReconDashboards` (same override
  pattern as `IUserDirectory`); implementations must be best-effort.
- **UI** — export `SubscriptionsManager` is the management dialog (host
  mounts it inside `DashboardsProvider`, e.g. from a sidebar footer
  "Manage subscriptions" button); the per-dashboard Subscribe… dialog links
  to it via its `onManageAll` prop. `GET /meta` now reports
  `canManageShared`, which drives the manager's Mine/All admin scope switch.
- **Schema** — re-apply `db/rcd_schema.sql` (idempotent) on upgrade: it adds
  the four tables above.

### Per-user settings

`rcd_user_settings` stores ONE opaque JSON document per user (primary key is
the host's own user id from `ICurrentUserProvider` — as everywhere else here,
no foreign key ever points at a host table). It backs the chart builder's field
organization and personal measures; the server parses and re-serializes it and
validates nothing about its contents, so new preference sections ship without a
migration.

- **API** — `GET/PUT api/rcd/v1/user-settings`, View policy slot: settings are
  self-service, and a caller can only ever reach their own row because the id
  is taken from the identity seam and never from the route or the body.
- **First read** returns an empty document rather than a 404 — "no preferences
  yet" and "these preferences" are the same state to every consumer.
- **Size** — `RcdLimits.MaxUserSettingsBytes` (128 KB by default), measured on
  the stored bytes so formatting cannot cost a user their save.
- **Schema** — re-apply `db/rcd_schema.sql` on upgrade; it adds this one table.
  Hosts that keep their own copy of the file (the PSV tracker keeps one at
  `Scripts/db/rcd_schema.sql`) must refresh it in the same change.

### Dashboard permissions (0.8.0+)

Three distinct verbs (see SHARING-DESIGN.md for the full contract):

- **Share**: named-user grants in `rcd_dashboard_shares`, each with three
  flags — `canEditLayout` (move/resize tiles, doc settings, slicer/text/image
  tile add/remove/edit), `canManagePages`, `canEditCharts` (chart tile
  add/remove, chart spec/format edits); all false = view-only. A grantee
  save is diffed server-side and rejected (403
  `rcd.dashboard.permission_denied`) when a change class exceeds their flags;
  grantees can never change name/description/modelId/isShared
  (`rcd.dashboard.share_forbidden_fields`).
- **Publish**: the legacy `IsShared` boolean ("Everyone"), still admin-gated
  via `ICurrentUserProvider.CanManageShared`.
- **Built-in**: rows owned by `RcdOptions.SystemOwnerUserId` (default
  `"system"`) are read-only for everyone — update/delete/share return 403
  `rcd.dashboard.system_readonly` / `rcd.model.system_readonly`; duplicate
  stays available to any viewer. Seed scripts (raw SQL) remain the only writer,
  with ONE exception (see below).
- **System MEASURE carve-out**: `PUT /models/{id}` on a system-owned model is
  accepted from a caller with `CanManageShared` when the request changes ONLY
  the definition's `measures`. Everything else on a seeded model stays
  immutable: a request that also changes tables, column overrides,
  relationships, date tables, the version, the name, the description, the data
  source or the sharing flag is refused with 403
  `rcd.model.system_measures_only`, and a save that changes no measure at all
  is the unchanged 403 `rcd.model.system_readonly`. Callers without
  `CanManageShared`, and `DELETE`, are unaffected. Existing measures are still
  re-validated against the live catalog, so a broken formula cannot be saved.
  This is what makes a System-scope measure authorable through the API instead
  of only by editing the seed JSON and re-seeding.

Visibility is owner OR published OR share row. `DELETE /dashboards/{id}` is
contextual: owner/admin soft-delete; a grantee only removes their own share
row ("remove from my list"); publish-only viewers get 403. Every dashboard
summary/detail now carries `isSystem`, `ownerDisplayName`, `shareCount`
(0 unless owner/admin) and `myAccess { isOwner, canEdit, canEditLayout,
canManagePages, canEditCharts, viaShare, viaPublish }`.

New endpoints (all under the route prefix + `/v1`):

| Endpoint | Slot | Purpose |
|---|---|---|
| `GET  dashboards/{id}/shares` | View | `{ shares: [...] }`, owner/admin only |
| `PUT  dashboards/{id}/shares` | View | replaces the FULL grant set |
| `POST dashboards/{id}/leave` | View | removes the caller's share row |
| `GET  dashboards/{id}/activity?limit&beforeId` | View | `{ entries: [...] }`, newest 500 kept per dashboard |
| `GET  users?query=` | View | share-picker directory (`IUserDirectory`) |

Policy-slot note: dashboard `update`/`delete` moved from the Author to the
View slot in 0.8.0 — the service-level rights above are authoritative (a
grantee with edit permission may lack the host's author capability).
`create`/`duplicate` and all model writes stay Author.

## 3. Frontend (React)

Get tarballs: `frontend/scripts/pack-and-vendor.ps1 -CopyTo <host>\Frontend\vendor`,
then in the host: `npm i ./vendor/recon-dashboards-core-<v>.tgz
./vendor/recon-dashboards-ui-<v>.tgz` (commit tarballs + lockfile).

Tailwind config: add the preset and content glob (literal-class purge safe):

```js
presets: [require('@recon/dashboards-ui/tailwind-preset')],
content: [...existing, './node_modules/@recon/dashboards-ui/dist/**/*.js'],
```

Entry point: `import '@recon/dashboards-ui/styles.css';` — CSS-variable
contract + vendored grid/canvas styles only; no element selectors, existing
host styles are untouched. Theming keys off `html[data-theme="dark"]`; the
`--rcd-*` tokens fall back through the host's `--color-*` variables.

Fetcher adapter (~5 lines over the host's `request<T>`):

```ts
const fetcher: RcdFetcher = (path, init) =>
  request(path, { method: init?.method, body: init?.body, token: authStore.token, signal: init?.signal });
```

Page:

```tsx
<DashboardsProvider baseUrl="/api/rcd/v1" fetcher={fetcher}>
  <DashboardView dashboardId={id} readonly={!canEdit} />   {/* or DashboardListPanel / ModelListPanel / ModelEditor */}
</DashboardsProvider>
```

Register the page in the host's router (lazy import + capability keys per host
convention) and add the chunk split to vite.config manualChunks:

```js
'rcd-charts': ['recharts'],
'rcd-flow': ['@xyflow/react'],
'rcd-grid': ['react-grid-layout', 'react-resizable', 'react-draggable'],
```

## 4. Error codes

All failures are ProblemDetails with a stable `errorCode` extension
(`rcd.model.*`, `rcd.dashboard.*`, `rcd.query.*`, `rcd.source.*`,
`rcd.limit.*`). Query compilation errors surface actionable messages
("add a relationship between X and Y on the model canvas"); SQL and database
internals never leave the server.

**Partial query results.** A compilation failure attributed to ONE measure no
longer fails the whole query. `POST /query` (and summarized `POST
/query/export`) replace that measure with a tombstone — a column that selects
NULL under the SAME `meas{i}` name, label and position, so sort targets, having
indexes and column-keyed format maps keep pointing where the caller aimed them
— and return 200 with the remaining series. The response then carries:

```jsonc
"meta": {
  "measureFailures": [
    { "index": 1, "label": "Margin %", "code": "rcd.query.unknown_measure",
      "message": "The model has no measure with id …" }
  ]
}
```

`index` is the wire index into the request's `measures`. The key is ABSENT on a
fully successful query, so its presence alone means "this result is partial";
a client that ignores it renders an unexplained empty series, which is the one
outcome to avoid. Isolation is deliberately narrow: a dimension, filter or sort
failure, a rejected `definitions` overlay, and a query whose measures ALL fail
are still 4xx with the original error. Row-level export (`mode=underlying`) is
excluded — its measures pick the anchor table, not result columns.

## 5. Upgrade runbook

1. Bump the version: re-pack (`pack-local.ps1 -Version`), re-vendor tarballs.
2. Update host package references / `npm i` the new tarballs.
3. If the library schema changed: re-run the migration artifact (EF bundle or
   regenerated `rcd_schema.sql`) before deploying the new backend.
4. Never re-use a version number — NuGet and npm both cache by version.

### 0.7.0 → 0.8.0

1. Apply the new migration `20260811182420_DashboardSharesAndActivity`
   (adds `rcd_dashboard_shares` + `rcd_dashboard_activity`): re-run your EF
   bundle, or re-apply the regenerated `db/rcd_schema.sql` — both are
   idempotent. Do this BEFORE deploying the 0.8.0 backend.
2. Optionally register an `IUserDirectory` (see §2) so the Share dialog can
   list users; without it sharing still works but the picker is empty.
3. If your seeds use a different built-in owner id than `"system"`, set
   `rcd.SystemOwnerUserId` accordingly (or null to disable read-only seeds).
4. Re-check host authorization: dashboard update/delete now sit in the View
   policy slot (see §2) — hosts that relied on the Author policy to block
   viewers from PUT/DELETE keep the same effective behavior through the
   service-level ownership checks, but custom policy mappings should be
   reviewed.
5. Wire changes are additive only (`isSystem`, `ownerDisplayName`, `myAccess`,
   `shareCount` on dashboard summaries/details; `isSystem` on models).
