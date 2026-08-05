<#
Starts the demo API (http://localhost:5040) in the background, first making
sure its rcd-postgres container is up. Safe to re-run: if something is already
listening on the port it reports that instance instead of starting another.
Logs: .run\backend.log   Stop with: scripts\stop-backend.ps1
#>
. "$PSScriptRoot\_common.ps1"

$existing = Get-AppListener $BackendPort
if ($existing) {
    Write-Host "Backend already running on port $BackendPort (PID $($existing.Pid), $($existing.Name)) - nothing to do."
    exit 0
}
if ((docker inspect -f '{{.State.Running}}' rcd-demo-api 2>$null) -eq 'true') {
    Write-Host "Backend already running in Docker (rcd-demo-api container on port $BackendPort) - nothing to do."
    Write-Host 'Manage it with docker compose (stop-backend.ps1 will stop it too).'
    exit 0
}

# The demo storage DB lives in the rcd-postgres container (host port 5445).
$composeFile = Join-Path $RepoRoot 'docker-compose.yml'
$pgRunning = (docker inspect -f '{{.State.Running}}' rcd-postgres 2>$null) -eq 'true'
if (-not $pgRunning) {
    Write-Host 'Starting rcd-postgres container...'
    docker compose -f $composeFile up -d postgres
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed - is Docker Desktop running?' }
}
$deadline = (Get-Date).AddSeconds(60)
do {
    $health = docker inspect -f '{{.State.Health.Status}}' rcd-postgres 2>$null
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)
if ($health -ne 'healthy') { throw "rcd-postgres did not become healthy in 60s (status: $health)" }

$project = Join-Path $RepoRoot 'backend\demo\ReconDashboards.DemoHost'
$log = Join-Path $RunDir 'backend.log'
Write-Host "Starting demo API (dotnet run, logs: $log)..."
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', "dotnet run --project `"$project`" > `"$log`" 2>&1" `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
Write-PidFile 'backend' $proc.Id

# First run compiles, so give it a while; bail early if the process dies.
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
    if (Get-AppListener $BackendPort) {
        Write-Host "Backend up: http://localhost:$BackendPort (launcher PID $($proc.Id))"
        exit 0
    }
    if ($proc.HasExited) {
        Remove-PidFile 'backend'
        Write-Host 'Backend process exited before listening - build or startup failure.'
        Show-LogTail $log
        exit 1
    }
    Start-Sleep -Milliseconds 500
}
Write-Host "Backend did not start listening on port $BackendPort within 120s."
Show-LogTail $log
Stop-ProcessTree $proc.Id
Remove-PidFile 'backend'
exit 1
