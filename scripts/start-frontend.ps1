<#
Starts the portal dev server (http://localhost:5200) in the background.
Safe to re-run: if something is already listening on the port it reports that
instance instead of starting another (this also stops Vite from silently
hopping to 5201, 5202, ... for each duplicate launch).
Logs: .run\frontend.log   Stop with: scripts\stop-frontend.ps1
#>
. "$PSScriptRoot\_common.ps1"

$existing = Get-AppListener $FrontendPort
if ($existing) {
    Write-Host "Frontend already running on port $FrontendPort (PID $($existing.Pid), $($existing.Name)) - nothing to do."
    exit 0
}

$frontendDir = Join-Path $RepoRoot 'frontend'
if (-not (Test-Path (Join-Path $frontendDir 'node_modules'))) {
    Write-Host 'node_modules missing - running npm install first (one-time)...'
    Push-Location $frontendDir
    try { npm install } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}

$log = Join-Path $RunDir 'frontend.log'
Write-Host "Starting portal dev server (npm run dev, logs: $log)..."
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', "npm run dev > `"$log`" 2>&1" `
    -WorkingDirectory $frontendDir -WindowStyle Hidden -PassThru
Write-PidFile 'frontend' $proc.Id

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if (Get-AppListener $FrontendPort) {
        Write-Host "Frontend up: http://localhost:$FrontendPort (launcher PID $($proc.Id))"
        exit 0
    }
    if ($proc.HasExited) {
        Remove-PidFile 'frontend'
        Write-Host 'Frontend process exited before listening - startup failure.'
        Show-LogTail $log
        exit 1
    }
    Start-Sleep -Milliseconds 500
}
Write-Host "Frontend did not start listening on port $FrontendPort within 60s."
Show-LogTail $log
Stop-ProcessTree $proc.Id
Remove-PidFile 'frontend'
exit 1
