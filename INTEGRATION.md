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
- `IRowFilterContributor` (zero or more) — row-level scoping. Called for EVERY
  table in every compiled query, including join targets. Return
  `RowFilterDecision.Filter(new RowFilter("col", RowFilterOperator.In, values))`
  to constrain, `Allow` to pass, `DenyAccess()` to block. A thrown exception
  DENIES the query — there is no unfiltered fallback. Scope your fact tables,
  not just dimension tables: the contributor only applies to tables actually
  referenced by a query.

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

## 5. Upgrade runbook

1. Bump the version: re-pack (`pack-local.ps1 -Version`), re-vendor tarballs.
2. Update host package references / `npm i` the new tarballs.
3. If the library schema changed: re-run the migration artifact (EF bundle or
   regenerated `rcd_schema.sql`) before deploying the new backend.
4. Never re-use a version number — NuGet and npm both cache by version.
