# Shared helpers for the start/stop scripts. Dot-source this; don't run it directly.
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:RunDir = Join-Path $RepoRoot '.run'
New-Item -ItemType Directory -Force $RunDir | Out-Null

$script:BackendPort = 5040
$script:FrontendPort = 5200

# The app process LISTENING on the port, or $null. The port is the source of
# truth for "already running" — PID files are only a fallback for cleanup.
# svchost listeners are excluded: Docker's port proxy (winnat) holds
# 0.0.0.0:<port> under svchost when a container publishes — or previously
# published — the port. That is not a local instance and must never be killed;
# the containerized case is handled separately via `docker inspect`.
function Get-AppListener([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object {
            $ownerPid = [int]$_.OwningProcess
            [pscustomobject]@{
                Pid     = $ownerPid
                Name    = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
                Address = $_.LocalAddress
            }
        } |
        Where-Object { $_.Name -and $_.Name -ne 'svchost' } |
        Select-Object -First 1
}

function Read-PidFile([string]$Name) {
    $path = Join-Path $RunDir "$Name.pid"
    if (Test-Path $path) { return [int](Get-Content $path -TotalCount 1) }
    return $null
}

function Write-PidFile([string]$Name, [int]$ProcessId) {
    Set-Content -Path (Join-Path $RunDir "$Name.pid") -Value $ProcessId
}

function Remove-PidFile([string]$Name) {
    Remove-Item (Join-Path $RunDir "$Name.pid") -Force -ErrorAction SilentlyContinue
}

# Kills the whole process tree (dotnet run / npm each wrap the real server).
function Stop-ProcessTree([int]$ProcessId) {
    taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
}

# PID files can go stale and the PID be reused by an unrelated process, so only
# kill a fallback PID whose name matches what we launched.
function Test-ProcessLooksLike([int]$ProcessId, [string[]]$NamePatterns) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    foreach ($pattern in $NamePatterns) {
        if ($proc.ProcessName -like $pattern) { return $true }
    }
    return $false
}

function Show-LogTail([string]$LogPath, [int]$Lines = 25) {
    if (Test-Path $LogPath) {
        Write-Host "--- last $Lines log lines ($LogPath) ---"
        Get-Content $LogPath -Tail $Lines | ForEach-Object { Write-Host "  $_" }
    }
}
