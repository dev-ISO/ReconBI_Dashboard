<#
Stops the demo API: kills whatever process tree is listening on port 5040,
plus the recorded launcher PID if it's still alive. Leaves the rcd-postgres
container running (use `docker compose down` if you want that stopped too).
#>
. "$PSScriptRoot\_common.ps1"

$stopped = $false

$listener = Get-AppListener $BackendPort
if ($listener) {
    if (Test-ProcessLooksLike $listener.Pid @('cmd', 'dotnet', 'ReconDashboards*')) {
        Write-Host "Stopping backend listener on port $BackendPort (PID $($listener.Pid), $($listener.Name))..."
        Stop-ProcessTree $listener.Pid
        $stopped = $true
    } else {
        Write-Host "Port $BackendPort is held by '$($listener.Name)' (PID $($listener.Pid)) - not one of ours, leaving it alone."
    }
}

if ((docker inspect -f '{{.State.Running}}' rcd-demo-api 2>$null) -eq 'true') {
    Write-Host 'Stopping the rcd-demo-api container...'
    docker compose -f (Join-Path $RepoRoot 'docker-compose.yml') stop api
    $stopped = $true
}

$launcher = Read-PidFile 'backend'
if ($launcher -and $launcher -ne $listener.Pid) {
    if (Test-ProcessLooksLike $launcher @('cmd', 'dotnet', 'ReconDashboards*')) {
        Write-Host "Stopping backend launcher (PID $launcher)..."
        Stop-ProcessTree $launcher
        $stopped = $true
    }
}
Remove-PidFile 'backend'

if ($stopped) {
    Write-Host 'Backend stopped.'
} else {
    Write-Host "Backend is not running (nothing listening on port $BackendPort)."
}
