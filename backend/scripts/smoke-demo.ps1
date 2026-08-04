# End-to-end smoke of the running demo stack (docker compose up + migrate).
# Exercises: demo login, catalog + FK suggestions, model save (incl. the
# manually-added technicians->sites relationship, inactive to avoid a cycle),
# chart query with joins, alice's Gulf Coast row scoping, dashboard sharing,
# and viewer permission denial.
param([string]$BaseUrl = 'http://localhost:5040')

$ErrorActionPreference = 'Stop'
$failures = 0

function Assert([bool]$Condition, [string]$What) {
    if ($Condition) {
        Write-Host "  PASS  $What" -ForegroundColor Green
    } else {
        Write-Host "  FAIL  $What" -ForegroundColor Red
        $script:failures++
    }
}

function Login([string]$Username) {
    (Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/demo-login" `
        -ContentType 'application/json' -Body (@{ username = $Username } | ConvertTo-Json)).token
}

function AuthHeaders([string]$Token) { @{ Authorization = "Bearer $Token" } }

Write-Host "Smoke: $BaseUrl"

# --- health + logins ---
$health = Invoke-RestMethod -Uri "$BaseUrl/health"
Assert ($health.status -eq 'ok') 'health endpoint'

$carol = Login 'carol'   # admin
$alice = Login 'alice'   # author, Gulf Coast scope
$bob = Login 'bob'       # viewer
Assert ($carol -and $alice -and $bob) 'demo logins issue tokens'

# --- catalog ---
$catalog = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/connections/demo/catalog" -Headers (AuthHeaders $carol)
Assert ($catalog.tables.Count -ge 5) "catalog exposes seeded tables (got $($catalog.tables.Count))"
$suggestionCount = @($catalog.suggestions).Count
Assert ($suggestionCount -eq 4) "FK suggestions found (got $suggestionCount, expected 4 - technicians.home_site_id has no FK)"

# --- model create (carol) ---
$definition = @{
    version = 1
    tables = @(
        @{ schema = 'public'; name = 'sites'; position = @{ x = 40; y = 40 } }
        @{ schema = 'public'; name = 'units'; position = @{ x = 300; y = 40 } }
        @{ schema = 'public'; name = 'valves'; position = @{ x = 560; y = 40 } }
        @{ schema = 'public'; name = 'technicians'; position = @{ x = 300; y = 300 } }
        @{ schema = 'public'; name = 'inspections'; position = @{ x = 560; y = 300 } }
    )
    relationships = @(
        @{ id = [guid]::NewGuid().ToString(); fromTable = 'public.units'; fromColumn = 'site_id'; toTable = 'public.sites'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = [guid]::NewGuid().ToString(); fromTable = 'public.valves'; fromColumn = 'unit_id'; toTable = 'public.units'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = [guid]::NewGuid().ToString(); fromTable = 'public.inspections'; fromColumn = 'valve_id'; toTable = 'public.valves'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = [guid]::NewGuid().ToString(); fromTable = 'public.inspections'; fromColumn = 'technician_id'; toTable = 'public.technicians'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        # The hand-added relationship from the GUI demo; inactive because the
        # FK chain already connects technicians via inspections (cycle otherwise).
        @{ id = [guid]::NewGuid().ToString(); fromTable = 'public.technicians'; fromColumn = 'home_site_id'; toTable = 'public.sites'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $false; source = 'manual' }
    )
    measures = @(
        @{ id = [guid]::NewGuid().ToString(); name = 'Total Labor Hours'; table = 'public.inspections'; aggregation = 'sum'; column = 'labor_hours' }
        @{ id = [guid]::NewGuid().ToString(); name = 'Inspection Count'; table = 'public.inspections'; aggregation = 'count' }
    )
}

$modelBody = @{
    name = "Smoke Model $([guid]::NewGuid().ToString('N').Substring(0, 8))"
    dataSourceName = 'demo'
    definition = $definition
} | ConvertTo-Json -Depth 12

$model = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/models" `
    -Headers (AuthHeaders $carol) -ContentType 'application/json' -Body $modelBody
Assert ($model.id -gt 0) "model created (id $($model.id))"

# --- chart query: labor hours by region (3 joins) ---
$querySpec = @{
    modelId = $model.id
    dimensions = @(@{ table = 'public.sites'; column = 'region' })
    measures = @(@{ table = 'public.inspections'; column = 'labor_hours'; aggregation = 'sum'; alias = 'Hours' })
    filters = @()
    sort = @()
} | ConvertTo-Json -Depth 8

$carolResult = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/query" `
    -Headers (AuthHeaders $carol) -ContentType 'application/json' -Body $querySpec
Assert ($carolResult.rows.Count -eq 4) "carol sees all 4 regions (got $($carolResult.rows.Count))"
Assert ($carolResult.meta.sql -match 'LEFT JOIN') 'generated SQL uses LEFT JOINs (debug echo active in Development)'

$aliceResult = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/query" `
    -Headers (AuthHeaders $alice) -ContentType 'application/json' -Body $querySpec
Assert ($aliceResult.rows.Count -eq 1 -and $aliceResult.rows[0][0] -eq 'Gulf Coast') `
    "alice is row-scoped to Gulf Coast (got $($aliceResult.rows.Count) row(s))"

# --- model-measure reference + monthly bucketing ---
$measureId = ($model.definition.measures | Where-Object { $_.name -eq 'Total Labor Hours' }).id
$bucketSpec = @{
    modelId = $model.id
    dimensions = @(@{ table = 'public.inspections'; column = 'inspected_on'; dateBucket = 'month' })
    measures = @(@{ measureId = $measureId })
    filters = @()
    sort = @()
} | ConvertTo-Json -Depth 8
$bucketResult = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/query" `
    -Headers (AuthHeaders $carol) -ContentType 'application/json' -Body $bucketSpec
Assert ($bucketResult.rows.Count -ge 30) "monthly bucketing over ~3 years (got $($bucketResult.rows.Count) months)"

# --- distinct values for slicers ---
$valuesBody = @{ modelId = $model.id; table = 'public.sites'; column = 'region'; filters = @() } | ConvertTo-Json -Depth 6
$carolValues = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/query/values" `
    -Headers (AuthHeaders $carol) -ContentType 'application/json' -Body $valuesBody
Assert (@($carolValues.values).Count -eq 4) "distinct regions for carol (got $(@($carolValues.values).Count))"
$aliceValues = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/query/values" `
    -Headers (AuthHeaders $alice) -ContentType 'application/json' -Body $valuesBody
Assert (@($aliceValues.values).Count -eq 1) 'distinct regions are scoped for alice'

# --- dashboards: share + visibility ---
$dashboardBody = @{
    name = "Smoke Board $([guid]::NewGuid().ToString('N').Substring(0, 8))"
    modelId = $model.id
    isShared = $true
    layout = @{ version = 1; tiles = @(); slicers = @() }
} | ConvertTo-Json -Depth 8
$dashboard = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/dashboards" `
    -Headers (AuthHeaders $carol) -ContentType 'application/json' -Body $dashboardBody
Assert ($dashboard.id -gt 0 -and $dashboard.isShared) 'carol created a shared dashboard'

$bobBoards = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards" -Headers (AuthHeaders $bob)
$bobSees = $bobBoards | Where-Object { $_.id -eq $dashboard.id }
Assert ($null -ne $bobSees -and -not $bobSees.ownerIsMe) 'bob sees the shared dashboard (not as owner)'

# --- authorization: viewer cannot author ---
$bobDenied = $false
try {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/models" `
        -Headers (AuthHeaders $bob) -ContentType 'application/json' -Body $modelBody | Out-Null
} catch {
    $bobDenied = $_.Exception.Response.StatusCode.value__ -eq 403
}
Assert $bobDenied 'bob (viewer) is denied model creation (403)'

# --- cleanup ---
Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/rcd/v1/dashboards/$($dashboard.id)" -Headers (AuthHeaders $carol) | Out-Null
Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/rcd/v1/models/$($model.id)" -Headers (AuthHeaders $carol) | Out-Null

if ($failures -gt 0) {
    Write-Host "`n$failures check(s) FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "`nAll smoke checks passed." -ForegroundColor Green
