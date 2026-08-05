# Starts backend (API + postgres container) then frontend. Each part is
# skipped automatically if it is already running.
& "$PSScriptRoot\start-backend.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$PSScriptRoot\start-frontend.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ''
Write-Host 'Portal: http://localhost:5200   API: http://localhost:5040'
