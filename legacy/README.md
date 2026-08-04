# Legacy prototype (retired 2026-08-04)

This folder preserves the original DynamicChartBuilder prototype, replaced by the
ReconDashboards system at the repo root:

- `api-python/` — FastAPI backend that parsed a single Excel workbook
  (`Excel/Grp_Resource.xlsx`, not committed) into memory with two fixed
  dimensions (office x resource). No database, no persistence.
- `frontend-next-prototype/` — Next.js 15 app with one working chart type
  (draggable Recharts line chart). No save/load.
- `docker-compose.yaml`, `cmds.bat`, `start-containers.bat` — ran the two
  containers above on ports 5000/8000.

Nothing here is referenced by the new system. Kept for reference only; safe to
delete once the rebuild is stable. Full history is in git (first commit).
