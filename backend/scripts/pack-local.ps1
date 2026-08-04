# Packs the three library projects into .nupkg files and (optionally) copies
# them into host repos' Backend\LocalPackages folders.
#
# ALWAYS bump -Version for every iteration you hand to a host: NuGet caches by
# version, so re-packing the same version silently serves stale bits.
param(
    [string]$Version = '0.1.0',
    [string[]]$CopyTo = @()   # e.g. 'C:\...\PSV Valve Tracker\Backend\LocalPackages'
)

$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    $output = Join-Path (Get-Location) 'artifacts' 'nupkg'
    New-Item -ItemType Directory -Force $output | Out-Null

    foreach ($project in @(
        'src/ReconDashboards.Core/ReconDashboards.Core.csproj',
        'src/ReconDashboards.Postgres/ReconDashboards.Postgres.csproj',
        'src/ReconDashboards.AspNetCore/ReconDashboards.AspNetCore.csproj'
    )) {
        dotnet pack $project -c Release -o $output "-p:Version=$Version" --nologo
        if ($LASTEXITCODE -ne 0) { throw "dotnet pack failed for $project" }
    }

    Write-Host "Packed $Version -> $output"

    foreach ($destination in $CopyTo) {
        New-Item -ItemType Directory -Force $destination | Out-Null
        Copy-Item (Join-Path $output "*.$Version.nupkg") $destination -Force
        Write-Host "Copied packages to $destination"
    }
}
finally {
    Pop-Location
}
