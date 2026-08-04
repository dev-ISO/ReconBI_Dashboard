# Builds the frontend packages, packs them as npm tarballs, and (optionally)
# copies the tarballs into host repos' vendor\ folders. Hosts reference them as
#   "@recon/dashboards-core": "file:vendor/recon-dashboards-core-<v>.tgz"
# and commit the tarballs so `npm ci` stays reproducible with no registry.
param(
    [string[]]$CopyTo = @()   # e.g. 'C:\...\PSV Valve Tracker\Frontend\vendor'
)

$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    npm run build -w '@recon/dashboards-core'
    if ($LASTEXITCODE -ne 0) { throw 'core build failed' }
    npm run build -w '@recon/dashboards-ui'
    if ($LASTEXITCODE -ne 0) { throw 'ui build failed' }

    $artifacts = Join-Path (Get-Location) 'artifacts'
    New-Item -ItemType Directory -Force $artifacts | Out-Null

    npm pack ./packages/dashboards-core --pack-destination $artifacts
    if ($LASTEXITCODE -ne 0) { throw 'core pack failed' }
    npm pack ./packages/dashboards-ui --pack-destination $artifacts
    if ($LASTEXITCODE -ne 0) { throw 'ui pack failed' }

    Write-Host "Tarballs in $artifacts"

    foreach ($destination in $CopyTo) {
        New-Item -ItemType Directory -Force $destination | Out-Null
        Copy-Item (Join-Path $artifacts 'recon-dashboards-*.tgz') $destination -Force
        Write-Host "Copied tarballs to $destination"
    }
}
finally {
    Pop-Location
}
