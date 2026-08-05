<#
Stops the portal dev server: kills whatever process tree is listening on
port 5200, plus the recorded launcher PID if it's still alive.
#>
. "$PSScriptRoot\_common.ps1"

$stopped = $false

$listener = Get-AppListener $FrontendPort
if ($listener) {
    if (Test-ProcessLooksLike $listener.Pid @('cmd', 'node', 'npm')) {
        Write-Host "Stopping frontend listener on port $FrontendPort (PID $($listener.Pid), $($listener.Name))..."
        Stop-ProcessTree $listener.Pid
        $stopped = $true
    } else {
        Write-Host "Port $FrontendPort is held by '$($listener.Name)' (PID $($listener.Pid)) - not one of ours, leaving it alone."
    }
}

$launcher = Read-PidFile 'frontend'
if ($launcher -and $launcher -ne $listener.Pid) {
    if (Test-ProcessLooksLike $launcher @('cmd', 'node', 'npm')) {
        Write-Host "Stopping frontend launcher (PID $launcher)..."
        Stop-ProcessTree $launcher
        $stopped = $true
    }
}
Remove-PidFile 'frontend'

if ($stopped) {
    Write-Host 'Frontend stopped.'
} else {
    Write-Host "Frontend is not running (nothing listening on port $FrontendPort)."
}
