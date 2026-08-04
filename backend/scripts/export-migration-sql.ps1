# Exports the idempotent SQL artifact (rcd_schema.sql) for hosts that apply
# schema via psql (Unanet doctrine). Safe to re-run: guarded by
# __RcdMigrationsHistory, so applying twice is a no-op.
param(
    [string]$Output = (Join-Path $PSScriptRoot '..' 'artifacts' 'rcd_schema.sql')
)

$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    New-Item -ItemType Directory -Force (Split-Path $Output) | Out-Null
    dotnet ef migrations script --idempotent --project src/ReconDashboards.Postgres --output $Output
    if ($LASTEXITCODE -ne 0) { throw "dotnet ef migrations script failed with exit code $LASTEXITCODE" }
    Write-Host "Wrote $Output"
}
finally {
    Pop-Location
}
