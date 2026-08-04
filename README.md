# ReconDashboards

Reusable, data-agnostic charting + dashboard system ("Power BI-lite"): point it at a
PostgreSQL database, it introspects tables/columns/foreign keys, lets users model
relationships on a drag-and-drop canvas, build charts with dimension/measure field
wells, and save per-user + shared dashboards of resizable tiles.

Ships as:
- **.NET class library** (`backend/`) any ASP.NET Core host mounts with one DI call
  (`AddReconDashboards`), plus a demo host API.
- **React component library** (`frontend/packages/`) embeddable in host SPAs, plus a
  standalone portal app built from the same components.

## Layout

| Path | What |
|---|---|
| `backend/src/ReconDashboards.Core` | Engine: semantic model, validator, join resolution, SQL compiler (dialect-agnostic), persistence, options. No ASP.NET, no Npgsql. |
| `backend/src/ReconDashboards.Postgres` | PostgreSQL provider: pg_catalog introspection, SQL dialect, read-only executor, EF migrations for the `rcd_` tables. |
| `backend/src/ReconDashboards.AspNetCore` | Controllers under a configurable route prefix (`api/rcd/v1`), auth policy slots, `AddReconDashboards` DI. |
| `backend/demo/ReconDashboards.DemoHost` | Thin demo API (JWT demo users, seeded sample DB). |
| `frontend/packages/dashboards-core` | Headless: types, API client, zustand runtime, query cache. |
| `frontend/packages/dashboards-ui` | Components: model canvas, chart builder, dashboard grid, theming. |
| `frontend/apps/portal` | Standalone dashboard portal (Vite, port 5200). |
| `legacy/` | Retired FastAPI + Next.js prototype. |

## Quickstart (dev)

```powershell
# backend solution
dotnet build backend/ReconDashboards.slnx

# frontend workspaces
cd frontend
npm install
npm run dev        # portal on http://localhost:5200
```

Demo database + API (`docker compose up`, ports 5445/5040) arrive with the engine
vertical slice.

## Ports

| Service | Port |
|---|---|
| Demo API | 5040 |
| Portal (Vite dev) | 5200 |
| Postgres (Docker) | 5445 |

Chosen to avoid the host apps' 5020/5025/5180/5190/5435.
