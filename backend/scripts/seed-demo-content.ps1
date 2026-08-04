# Seeds rich demo content (models + dashboards) through the running API.
# Requires: docker compose stack up, db/init/03-seed-v2.sql applied, API at
# http://localhost:5040. Idempotent: existing models/dashboards are matched by
# name and reused instead of recreated.
#
# Creates (all shared so every demo user sees them):
#   MODEL "Maintenance Operations"  - 8-table FK web + Calendar date table +
#                                     6 measures (incl. filtered + expression)
#   MODEL "Inspections"             - the classic 5-table inspection model
#   DASHBOARD "Maintenance Overview" - KPI row, slicers, column/donut/line/
#                                      stackedColumn/table tiles
#   DASHBOARD "Inspection Quality"   - KPIs + column/line + slicers
# Then runs sample /query calls to prove the content is live.
#
# -Restyle: skips seeding and instead restyles the two demo dashboards into a
# visual showcase of the styling system (themes, containers, multi-page tabs,
# text tiles, live refresh). Idempotent: GET by name -> transform -> PUT back;
# existing tile/chart ids are reused so re-runs are stable.
param([string]$BaseUrl = 'http://localhost:5040', [switch]$Restyle)

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

function NewId { [guid]::NewGuid().ToString() }

function MeasureId($Model, [string]$Name) {
    $m = $Model.definition.measures | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $m) { throw "Measure '$Name' not found on model '$($Model.name)'" }
    $m.id
}

function RunQuery([hashtable]$Spec) {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/query" `
        -Headers $headers -ContentType 'application/json' -Body ($Spec | ConvertTo-Json -Depth 10)
}

Write-Host "Seeding demo content: $BaseUrl"

# --- login (carol = admin) ---
$token = (Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/demo-login" `
    -ContentType 'application/json' -Body (@{ username = 'carol' } | ConvertTo-Json)).token
$headers = @{ Authorization = "Bearer $token" }
Assert ([bool]$token) 'carol login issues a token'

# ===========================================================================
# RESTYLE PHASE (-Restyle): showcase restyling of the seeded dashboards.
# GET by name -> rebuild layout (reusing existing tile/chart ids) -> PUT with
# expectedUpdatedAtUtc. Run the plain seed phase first if content is missing.
# ===========================================================================
if ($Restyle) {

    function GetModelByName([string]$Name) {
        $summary = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models" -Headers $headers |
            ForEach-Object { $_ } |
            Where-Object { $_.name -eq $Name } | Select-Object -First 1
        if (-not $summary) { throw "Model '$Name' not found - run the seed phase (no -Restyle) first" }
        Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models/$($summary.id)" -Headers $headers
    }

    function GetDashboardByName([string]$Name) {
        $summary = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards" -Headers $headers |
            ForEach-Object { $_ } |
            Where-Object { $_.name -eq $Name } | Select-Object -First 1
        if (-not $summary) { throw "Dashboard '$Name' not found - run the seed phase (no -Restyle) first" }
        Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards/$($summary.id)" -Headers $headers
    }

    # Every tile in the doc, whether it lives in legacy `tiles` or in `pages`
    # (a previous -Restyle run). Returned as a mutable pool for TakeTile.
    function TilePool($Detail) {
        $all = @()
        foreach ($page in @($Detail.layout.pages)) { if ($page) { $all += @($page.tiles) } }
        $all += @($Detail.layout.tiles)
        , [System.Collections.ArrayList]@($all | Where-Object { $_ })
    }

    # First pool tile matching the predicate; removed from the pool so repeated
    # matches (two 'Open Orders' KPIs) resolve in document order. $null = new.
    function TakeTile([System.Collections.ArrayList]$Pool, [scriptblock]$Predicate) {
        for ($i = 0; $i -lt $Pool.Count; $i++) {
            if (& $Predicate $Pool[$i]) { $tile = $Pool[$i]; $Pool.RemoveAt($i); return $tile }
        }
        return $null
    }

    # Stable ids: reuse the matched tile's (and its chart's) ids across re-runs.
    function TileIds($Found) {
        if ($Found) {
            @{ tile = $Found.id; chart = if ($Found.chart) { $Found.chart.id } else { NewId } }
        } else {
            @{ tile = NewId; chart = NewId }
        }
    }

    # Reuse the page id when a page of that name already exists (re-run).
    function PageId($Detail, [string]$Name) {
        $page = @($Detail.layout.pages) | Where-Object { $_ -and $_.name -eq $Name } | Select-Object -First 1
        if ($page) { $page.id } else { NewId }
    }

    function PutDashboard($Detail, [hashtable]$Layout) {
        $body = @{
            name                 = $Detail.name
            description          = $Detail.description
            modelId              = $Detail.modelId
            isShared             = $Detail.isShared
            layout               = $Layout
            expectedUpdatedAtUtc = $Detail.updatedAtUtc
        } | ConvertTo-Json -Depth 24
        Invoke-RestMethod -Method Put -Uri "$BaseUrl/api/rcd/v1/dashboards/$($Detail.id)" `
            -Headers $headers -ContentType 'application/json' -Body $body
    }

    Write-Host "`nRestyle: fetching models + dashboards"
    $maintModel = GetModelByName 'Maintenance Operations'
    $inspModel = GetModelByName 'Inspections'
    $mTotalCost = MeasureId $maintModel 'Total Cost'
    $mLaborHours = MeasureId $maintModel 'Labor Hours'
    $mWorkOrders = MeasureId $maintModel 'Work Orders'
    $mOpenOrders = MeasureId $maintModel 'Open Orders'
    $mAvgCost = MeasureId $maintModel 'Avg Cost per Order'
    $mPartsSpend = MeasureId $maintModel 'Parts Spend'
    $mFailCount = MeasureId $inspModel 'Fail Count'
    $mInspCount = MeasureId $inspModel 'Inspection Count'

    # -----------------------------------------------------------------------
    # DASHBOARD 1: Maintenance Overview -> 3 pages (Overview / Cost Analysis /
    # Live Ops). Accent-bordered KPIs, themed charts, frameless inner titles,
    # a two-line correlation chart and a 15s live-refresh tile.
    # -----------------------------------------------------------------------
    Write-Host "`nRestyle: Maintenance Overview"
    $maintDash = GetDashboardByName 'Maintenance Overview'
    $pool = TilePool $maintDash

    $kpiContainer = @{ borderColor = '#2a78d6'; borderWidth = 1; borderRadius = 12; shadow = 'sm' }
    function KpiRestyled([System.Collections.ArrayList]$Pool, [string]$Title, [string]$MeasureId, [int]$X, [hashtable]$Format) {
        $ids = TileIds (TakeTile $Pool { param($t) $t.chart.type -eq 'kpi' -and $t.chart.title -eq $Title })
        @{
            id = $ids.tile; kind = 'chart'; layout = @{ x = $X; y = 0; w = 6; h = 4 }
            chart = @{
                id = $ids.chart; type = 'kpi'; title = $Title
                query = @{ measures = @(@{ measureId = $MeasureId }); filters = @() }
                format = $Format
            }
        }
    }

    # --- page: Overview ---
    $overviewTiles = @(
        (KpiRestyled $pool 'Total Cost' $mTotalCost 0 @{ valueFormat = '$#,0'; container = $kpiContainer })
        (KpiRestyled $pool 'Work Orders' $mWorkOrders 6 @{ container = $kpiContainer })
        (KpiRestyled $pool 'Open Orders' $mOpenOrders 12 @{ container = $kpiContainer })
        (KpiRestyled $pool 'Avg Cost per Order' $mAvgCost 18 @{ valueFormat = '$#,0'; container = $kpiContainer })
    )
    $regionSlicer = TakeTile $pool { param($t) $t.slicer.variant -eq 'checklist' -and $t.slicer.column -eq 'region' }
    $overviewTiles += @{
        id = (TileIds $regionSlicer).tile; kind = 'slicer'; layout = @{ x = 0; y = 4; w = 12; h = 5 }
        slicer = @{ table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'checklist'
                    style = @{ compact = $true } }
    }
    $prioritySlicer = TakeTile $pool { param($t) $t.slicer.variant -eq 'buttons' -and $t.slicer.column -eq 'priority' }
    $overviewTiles += @{
        id = (TileIds $prioritySlicer).tile; kind = 'slicer'; layout = @{ x = 12; y = 4; w = 12; h = 5 }
        slicer = @{ table = 'public.work_orders'; column = 'priority'; label = 'Priority'; variant = 'buttons'
                    style = @{ hideHeader = $true; compact = $true } }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Cost by Region' })
    $overviewTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 9; w = 12; h = 8 }
        chart = @{
            id = $ids.chart; type = 'column'; title = 'Cost by Region'
            query = @{
                axis = @{ table = 'public.sites'; column = 'region' }
                measures = @(@{ measureId = $mTotalCost }); filters = @()
            }
            format = @{
                theme = 'ocean'; showDataLabels = $true; valueFormat = '$#,0'
                yAxisFormat = @{ kind = 'compact' }
                tooltip = @{ accentBorder = $true }
                container = @{
                    hideHeader = $true
                    innerTitleHtml = '<p><b>Cost by Region</b> <span style="color:#64748b">&mdash; maintenance spend</span></p>'
                }
            }
        }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Orders by Priority' })
    $overviewTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 12; y = 9; w = 12; h = 8 }
        chart = @{
            id = $ids.chart; type = 'donut'; title = 'Orders by Priority'
            query = @{
                legend = @{ table = 'public.work_orders'; column = 'priority' }
                measures = @(@{ measureId = $mWorkOrders }); filters = @()
            }
            format = @{
                theme = 'sunset'; legendPosition = 'right'
                tooltip = @{ showPercent = $true }
                container = @{ shadow = 'md'; borderRadius = 16 }
            }
        }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Monthly Cost Trend' })
    $overviewTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 17; w = 24; h = 8 }
        chart = @{
            id = $ids.chart; type = 'line'; title = 'Monthly Cost Trend'
            query = @{
                axis = @{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'month' }
                measures = @(@{ measureId = $mTotalCost }); filters = @()
            }
            format = @{
                valueFormat = '$#,0'; dateFormat = 'monthYear'
                yAxisFormat = @{ kind = 'compact' }
                lineStyles = @{ 'Total Cost' = @{ dash = 'solid'; width = 3 } }
                container = @{
                    hideHeader = $true
                    innerTitleHtml = '<p><b>Monthly Cost Trend</b> <span style="color:#64748b">&mdash; total maintenance cost per month</span></p>'
                }
            }
        }
    }

    # --- page: Cost Analysis ---
    $textTile = TakeTile $pool { param($t) $t.kind -eq 'text' -and $t.text.html -like '*Cost Analysis*' }
    $costTiles = @(
        @{
            id = (TileIds $textTile).tile; kind = 'text'; layout = @{ x = 0; y = 0; w = 24; h = 3 }
            text = @{
                html = '<h2>Cost Analysis</h2><p><span style="color:#64748b">Stacked composition, vendor spend and the labor-hours correlation behind total maintenance cost.</span></p>'
                align = 'left'
            }
        }
    )
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Cost by Region and Priority' })
    $costTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 3; w = 12; h = 8 }
        chart = @{
            id = $ids.chart; type = 'stackedColumn'; title = 'Cost by Region and Priority'
            query = @{
                axis = @{ table = 'public.sites'; column = 'region' }
                legend = @{ table = 'public.work_orders'; column = 'priority' }
                measures = @(@{ measureId = $mTotalCost }); filters = @()
            }
            format = @{
                theme = 'forest'; legendInteractive = $true; valueFormat = '$#,0'
                tooltip = @{ showPercent = $true }
            }
        }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Top Vendors by Parts Spend' })
    $costTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 12; y = 3; w = 12; h = 8 }
        chart = @{
            id = $ids.chart; type = 'table'; title = 'Top Vendors by Parts Spend'
            query = @{
                axis = @{ table = 'public.vendors'; column = 'name' }
                measures = @(@{ measureId = $mPartsSpend }); filters = @()
                sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
                limit = 10
            }
            format = @{ legendStyle = @{ bold = $true } }
        }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Cost vs Labor' })
    $costVsLaborQuery = @{
        axis = @{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'month' }
        measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mLaborHours }); filters = @()
    }
    $costTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 11; w = 24; h = 8 }
        chart = @{
            id = $ids.chart; type = 'line'; title = 'Cost vs Labor'
            query = $costVsLaborQuery
            format = @{
                theme = 'berry'; dateFormat = 'monthYear'
                yAxisFormat = @{ kind = 'compact' }
                lineStyles = @{
                    'Total Cost'  = @{ dash = 'solid'; width = 3 }
                    'Labor Hours' = @{ dash = 'dashed'; width = 2 }
                }
                seriesLabels = @{ 'Total Cost' = 'Cost ($)'; 'Labor Hours' = 'Labor (hrs)' }
            }
        }
    }

    # --- page: Live Ops ---
    # Second 'Open Orders' KPI in document order (the first went to Overview);
    # a fresh tile on the first restyle run.
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.type -eq 'kpi' -and $t.chart.title -eq 'Open Orders' })
    $liveTiles = @(
        @{
            id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 0; w = 6; h = 4 }
            chart = @{
                id = $ids.chart; type = 'kpi'; title = 'Open Orders'
                query = @{ measures = @(@{ measureId = $mOpenOrders }); filters = @() }
                format = @{ container = @{ borderColor = '#1baf7a'; borderWidth = 1; borderRadius = 12; shadow = 'sm' } }
            }
        }
    )
    $dateSlicer = TakeTile $pool { param($t) $t.slicer.variant -eq 'dateRange' }
    $liveTiles += @{
        id = (TileIds $dateSlicer).tile; kind = 'slicer'; layout = @{ x = 6; y = 0; w = 10; h = 4 }
        slicer = @{ table = 'public.work_orders'; column = 'opened_on'; label = 'Opened'; variant = 'dateRange' }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Open Orders by Region' })
    $liveTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 4; w = 12; h = 8 }
        chart = @{
            id = $ids.chart; type = 'column'; title = 'Open Orders by Region'
            query = @{
                axis = @{ table = 'public.sites'; column = 'region' }
                measures = @(@{ measureId = $mOpenOrders }); filters = @()
            }
            format = @{ theme = 'mono'; colorByCategory = $true; showDataLabels = $true; refreshSeconds = 15 }
        }
    }

    if ($pool.Count -gt 0) {
        Write-Host "  NOTE  $($pool.Count) unmatched tile(s) dropped from Maintenance Overview" -ForegroundColor Yellow
    }

    $maintLayout = @{
        version = 1; tiles = @(); slicers = @()
        pages = @(
            @{ id = PageId $maintDash 'Overview'; name = 'Overview'; color = '#2a78d6'; tiles = $overviewTiles }
            @{ id = PageId $maintDash 'Cost Analysis'; name = 'Cost Analysis'; color = '#eb6834'; tiles = $costTiles }
            @{ id = PageId $maintDash 'Live Ops'; name = 'Live Ops'; color = '#1baf7a'; tiles = $liveTiles }
        )
    }
    if ($null -ne $maintDash.layout.filterCards) { $maintLayout.filterCards = @($maintDash.layout.filterCards) }
    if ($null -ne $maintDash.layout.refreshSeconds) { $maintLayout.refreshSeconds = $maintDash.layout.refreshSeconds }

    $updated = PutDashboard $maintDash $maintLayout
    Assert ($updated.layout.pages.Count -eq 3) "Maintenance Overview saved with 3 pages (got $($updated.layout.pages.Count))"

    # -----------------------------------------------------------------------
    # DASHBOARD 2: Inspection Quality (stays single-page): header text tile,
    # forest theme + per-category colors, compact slicer, dashed monthly line.
    # -----------------------------------------------------------------------
    Write-Host "`nRestyle: Inspection Quality"
    $inspDash = GetDashboardByName 'Inspection Quality'
    $pool = TilePool $inspDash

    $headerTile = TakeTile $pool { param($t) $t.kind -eq 'text' }
    $inspTiles = @(
        @{
            id = (TileIds $headerTile).tile; kind = 'text'; layout = @{ x = 0; y = 0; w = 24; h = 3 }
            text = @{
                html = '<h2>Inspection Quality</h2><p><span style="color:#64748b">Pass/fail outcomes by region and month across the valve fleet.</span></p>'
                align = 'left'
            }
        }
    )
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Fail Count' })
    $inspTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 3; w = 6; h = 4 }
        chart = @{
            id = $ids.chart; type = 'kpi'; title = 'Fail Count'
            query = @{ measures = @(@{ measureId = $mFailCount }); filters = @() }
            format = @{}
        }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Inspection Count' })
    $inspTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 6; y = 3; w = 6; h = 4 }
        chart = @{
            id = $ids.chart; type = 'kpi'; title = 'Inspection Count'
            query = @{ measures = @(@{ measureId = $mInspCount }); filters = @() }
            format = @{}
        }
    }
    $resultSlicer = TakeTile $pool { param($t) $t.slicer.variant -eq 'buttons' -and $t.slicer.column -eq 'result' }
    $inspTiles += @{
        id = (TileIds $resultSlicer).tile; kind = 'slicer'; layout = @{ x = 12; y = 3; w = 6; h = 4 }
        slicer = @{ table = 'public.inspections'; column = 'result'; label = 'Result'; variant = 'buttons'
                    style = @{ compact = $true } }
    }
    $inspRegionSlicer = TakeTile $pool { param($t) $t.slicer.variant -eq 'checklist' -and $t.slicer.column -eq 'region' }
    $inspTiles += @{
        id = (TileIds $inspRegionSlicer).tile; kind = 'slicer'; layout = @{ x = 18; y = 3; w = 6; h = 4 }
        slicer = @{ table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'checklist' }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Fail Count by Region' })
    $inspTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 0; y = 7; w = 12; h = 8 }
        chart = @{
            id = $ids.chart; type = 'column'; title = 'Fail Count by Region'
            query = @{
                axis = @{ table = 'public.sites'; column = 'region' }
                measures = @(@{ measureId = $mFailCount }); filters = @()
            }
            format = @{ theme = 'forest'; colorByCategory = $true; showDataLabels = $true }
        }
    }
    $ids = TileIds (TakeTile $pool { param($t) $t.chart.title -eq 'Inspections by Month' })
    $inspTiles += @{
        id = $ids.tile; kind = 'chart'; layout = @{ x = 12; y = 7; w = 12; h = 8 }
        chart = @{
            id = $ids.chart; type = 'line'; title = 'Inspections by Month'
            query = @{
                axis = @{ table = 'public.inspections'; column = 'inspected_on'; dateBucket = 'month' }
                measures = @(@{ measureId = $mInspCount }); filters = @()
            }
            format = @{
                dateFormat = 'monthShort'
                lineStyles = @{ 'Inspection Count' = @{ dash = 'dashed'; width = 2 } }
            }
        }
    }

    if ($pool.Count -gt 0) {
        Write-Host "  NOTE  $($pool.Count) unmatched tile(s) dropped from Inspection Quality" -ForegroundColor Yellow
    }

    $inspLayout = @{ version = 1; tiles = $inspTiles; slicers = @() }
    if ($null -ne $inspDash.layout.filterCards) { $inspLayout.filterCards = @($inspDash.layout.filterCards) }
    if ($null -ne $inspDash.layout.refreshSeconds) { $inspLayout.refreshSeconds = $inspDash.layout.refreshSeconds }

    $updated = PutDashboard $inspDash $inspLayout
    Assert ($updated.layout.tiles.Count -eq 7) "Inspection Quality saved with 7 tiles (got $($updated.layout.tiles.Count))"

    # -----------------------------------------------------------------------
    # Verification: re-GET both docs and prove the restyle persisted, then run
    # the new Cost vs Labor spec through /query.
    # -----------------------------------------------------------------------
    Write-Host "`nRestyle verification"
    $check = GetDashboardByName 'Maintenance Overview'
    Assert (@($check.layout.pages).Count -eq 3) "pages persisted (got $(@($check.layout.pages).Count))"
    Assert ((@($check.layout.pages) | ForEach-Object { $_.name }) -join '|' -eq 'Overview|Cost Analysis|Live Ops') 'page names + order persisted'
    Assert (@($check.layout.tiles).Count -eq 0) 'legacy tiles array emptied (pages are the source of truth)'
    $pageTileCounts = (@($check.layout.pages) | ForEach-Object { @($_.tiles).Count }) -join ','
    Assert ($pageTileCounts -eq '9,4,3') "page tile counts 9,4,3 (got $pageTileCounts)"
    $overviewPage = @($check.layout.pages)[0]
    $costRegion = @($overviewPage.tiles) | Where-Object { $_.chart.title -eq 'Cost by Region' } | Select-Object -First 1
    Assert ($costRegion.chart.format.theme -eq 'ocean' -and $costRegion.chart.format.container.hideHeader) 'Cost by Region: ocean theme + frameless inner title'
    $livePage = @($check.layout.pages)[2]
    $liveChart = @($livePage.tiles) | Where-Object { $_.chart.title -eq 'Open Orders by Region' } | Select-Object -First 1
    Assert ($liveChart.chart.format.refreshSeconds -eq 15 -and $liveChart.chart.format.colorByCategory) 'Open Orders by Region: 15s live refresh + colorByCategory'

    $checkInsp = GetDashboardByName 'Inspection Quality'
    $inspColumn = @($checkInsp.layout.tiles) | Where-Object { $_.chart.title -eq 'Fail Count by Region' } | Select-Object -First 1
    Assert ($inspColumn.chart.format.theme -eq 'forest' -and $inspColumn.chart.format.colorByCategory) 'Fail Count by Region: forest theme + colorByCategory'
    Assert ($null -ne (@($checkInsp.layout.tiles) | Where-Object { $_.kind -eq 'text' })) 'Inspection Quality header text tile present'

    $costVsLabor = RunQuery @{
        modelId = $maintDash.modelId
        dimensions = @($costVsLaborQuery.axis)
        measures = $costVsLaborQuery.measures
        filters = @(); sort = @()
    }
    Assert (@($costVsLabor.rows).Count -ge 40) "Cost vs Labor query returns 40+ monthly rows (got $(@($costVsLabor.rows).Count))"
    Assert (@($costVsLabor.columns).Count -eq 3) "Cost vs Labor query returns axis + 2 measure columns (got $(@($costVsLabor.columns).Count))"

    Write-Host ''
    Write-Host ('-' * 60)
    Write-Host "Restyled: Maintenance Overview (id $($maintDash.id), 3 pages), Inspection Quality (id $($inspDash.id))"
    if ($failures -gt 0) {
        Write-Host "`n$failures restyle check(s) FAILED" -ForegroundColor Red
        exit 1
    }
    Write-Host "`nAll restyle checks passed." -ForegroundColor Green
    exit 0
}

# --- refresh catalog so the v2 tables are visible ---
$catalog = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/connections/demo/catalog/refresh" -Headers $headers
Assert ($catalog.tables.Count -ge 10) "catalog refresh sees v2 tables (got $($catalog.tables.Count))"
Assert ($null -ne ($catalog.tables | Where-Object { $_.name -eq 'work_order_parts' })) 'work_order_parts present in catalog'

# --- idempotency helpers ---
function EnsureModel([string]$Name, [hashtable]$Definition, [string]$Description) {
    # ForEach-Object flattens: Invoke-RestMethod emits a JSON array as ONE
    # array object, which member-enumeration would otherwise mis-match.
    $existing = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models" -Headers $headers |
        ForEach-Object { $_ } |
        Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($existing) {
        Write-Host "  SKIP  model '$Name' already exists (id $($existing.id))" -ForegroundColor Yellow
        return Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models/$($existing.id)" -Headers $headers
    }
    $body = @{
        name = $Name
        description = $Description
        dataSourceName = 'demo'
        definition = $Definition
        isShared = $true
    } | ConvertTo-Json -Depth 16
    $model = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/models" `
        -Headers $headers -ContentType 'application/json' -Body $body -StatusCodeVariable status
    Assert ($status -eq 201 -and $model.id -gt 0) "model '$Name' created with 201 (id $($model.id))"
    return $model
}

function EnsureDashboard([string]$Name, [int]$ModelId, [hashtable]$Layout, [string]$Description) {
    $existing = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards" -Headers $headers |
        ForEach-Object { $_ } |
        Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($existing) {
        Write-Host "  SKIP  dashboard '$Name' already exists (id $($existing.id))" -ForegroundColor Yellow
        return Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards/$($existing.id)" -Headers $headers
    }
    $body = @{
        name = $Name
        description = $Description
        modelId = $ModelId
        isShared = $true
        layout = $Layout
    } | ConvertTo-Json -Depth 16
    $dashboard = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/dashboards" `
        -Headers $headers -ContentType 'application/json' -Body $body -StatusCodeVariable status
    Assert ($status -eq 201 -and $dashboard.id -gt 0) "dashboard '$Name' created with 201 (id $($dashboard.id))"
    return $dashboard
}

# ===========================================================================
# MODEL 1: Maintenance Operations
# ===========================================================================
$maintenanceDefinition = @{
    version = 1
    tables = @(
        @{ schema = 'public'; name = 'sites'; position = @{ x = 40; y = 40 } }
        @{ schema = 'public'; name = 'units'; position = @{ x = 320; y = 40 } }
        @{ schema = 'public'; name = 'valves'; position = @{ x = 600; y = 40 } }
        @{ schema = 'public'; name = 'employees'; position = @{ x = 40; y = 320 } }
        @{ schema = 'public'; name = 'work_orders'; position = @{ x = 600; y = 320 } }
        @{ schema = 'public'; name = 'vendors'; position = @{ x = 40; y = 600 } }
        @{ schema = 'public'; name = 'parts'; position = @{ x = 320; y = 600 } }
        @{ schema = 'public'; name = 'work_order_parts'; position = @{ x = 600; y = 600 } }
    )
    relationships = @(
        @{ id = NewId; fromTable = 'public.units'; fromColumn = 'site_id'; toTable = 'public.sites'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.valves'; fromColumn = 'unit_id'; toTable = 'public.units'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.work_orders'; fromColumn = 'valve_id'; toTable = 'public.valves'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.work_orders'; fromColumn = 'assigned_to'; toTable = 'public.employees'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        # INACTIVE: would create a second active path work_orders->employees->sites
        # alongside work_orders->valves->units->sites (the ambiguity-loop demo).
        @{ id = NewId; fromTable = 'public.employees'; fromColumn = 'site_id'; toTable = 'public.sites'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $false; source = 'fk' }
        @{ id = NewId; fromTable = 'public.parts'; fromColumn = 'vendor_id'; toTable = 'public.vendors'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.work_order_parts'; fromColumn = 'work_order_id'; toTable = 'public.work_orders'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.work_order_parts'; fromColumn = 'part_id'; toTable = 'public.parts'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        # Role-playing date: opened_on drives the Calendar; closed_on stays free
        # for a second date table if a demo wants to add one live.
        @{ id = NewId; fromTable = 'public.work_orders'; fromColumn = 'opened_on'; toTable = '#date.Calendar'; toColumn = 'date_key'; cardinality = 'manyToOne'; isActive = $true; source = 'manual' }
    )
    measures = @(
        @{ id = NewId; name = 'Total Cost'; table = 'public.work_orders'; aggregation = 'sum'; column = 'total_cost'; formatHint = 'currency' }
        @{ id = NewId; name = 'Labor Hours'; table = 'public.work_orders'; aggregation = 'sum'; column = 'labor_hours' }
        @{ id = NewId; name = 'Work Orders'; table = 'public.work_orders'; aggregation = 'count' }
        @{ id = NewId; name = 'Open Orders'; table = 'public.work_orders'; aggregation = 'count'
           filters = @(@{ table = 'public.work_orders'; column = 'status'; operator = 'in'; values = @('open', 'in_progress') }) }
        # Expression measure: column must stay null; aggregation is ignored but
        # 'sum' satisfies the wire shape.
        @{ id = NewId; name = 'Avg Cost per Order'; table = 'public.work_orders'; aggregation = 'sum'
           expression = 'SUM(public.work_orders.total_cost) / COUNT(*)'; formatHint = 'currency' }
        @{ id = NewId; name = 'Parts Spend'; table = 'public.work_order_parts'; aggregation = 'sum'; column = 'line_cost'; formatHint = 'currency' }
    )
    dateTables = @(
        @{ name = 'Calendar'; rangeStart = '2023-01-01'; rangeEnd = '2026-12-31' }
    )
}

Write-Host "`nModel: Maintenance Operations"
$maintModel = EnsureModel 'Maintenance Operations' $maintenanceDefinition `
    'Work orders, parts spend and staffing across the plant network (v2 demo schema).'

# ===========================================================================
# MODEL 2: Inspections (the classic demo model)
# ===========================================================================
$inspectionsDefinition = @{
    version = 1
    tables = @(
        @{ schema = 'public'; name = 'sites'; position = @{ x = 40; y = 40 } }
        @{ schema = 'public'; name = 'units'; position = @{ x = 320; y = 40 } }
        @{ schema = 'public'; name = 'valves'; position = @{ x = 600; y = 40 } }
        @{ schema = 'public'; name = 'technicians'; position = @{ x = 320; y = 320 } }
        @{ schema = 'public'; name = 'inspections'; position = @{ x = 600; y = 320 } }
    )
    relationships = @(
        @{ id = NewId; fromTable = 'public.units'; fromColumn = 'site_id'; toTable = 'public.sites'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.valves'; fromColumn = 'unit_id'; toTable = 'public.units'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.inspections'; fromColumn = 'valve_id'; toTable = 'public.valves'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        @{ id = NewId; fromTable = 'public.inspections'; fromColumn = 'technician_id'; toTable = 'public.technicians'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        # Hand-added in the GUI demo; inactive because the FK chain already
        # connects technicians via inspections (cycle otherwise).
        @{ id = NewId; fromTable = 'public.technicians'; fromColumn = 'home_site_id'; toTable = 'public.sites'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $false; source = 'manual' }
    )
    measures = @(
        @{ id = NewId; name = 'Total Labor Hours'; table = 'public.inspections'; aggregation = 'sum'; column = 'labor_hours' }
        @{ id = NewId; name = 'Inspection Count'; table = 'public.inspections'; aggregation = 'count' }
        @{ id = NewId; name = 'Fail Count'; table = 'public.inspections'; aggregation = 'count'
           filters = @(@{ table = 'public.inspections'; column = 'result'; operator = 'eq'; values = @('fail') }) }
    )
}

Write-Host "`nModel: Inspections"
$inspModel = EnsureModel 'Inspections' $inspectionsDefinition `
    'Valve inspection outcomes by site, technician and month.'

# Measure ids (from freshly-created OR pre-existing models).
$mTotalCost = MeasureId $maintModel 'Total Cost'
$mWorkOrders = MeasureId $maintModel 'Work Orders'
$mOpenOrders = MeasureId $maintModel 'Open Orders'
$mAvgCost = MeasureId $maintModel 'Avg Cost per Order'
$mPartsSpend = MeasureId $maintModel 'Parts Spend'
$mFailCount = MeasureId $inspModel 'Fail Count'
$mInspCount = MeasureId $inspModel 'Inspection Count'

# ===========================================================================
# DASHBOARD 1: Maintenance Overview (24-column grid)
# ===========================================================================
function KpiTile([string]$Title, [string]$MeasureId, [int]$X, [hashtable]$Format = @{}) {
    @{
        id = NewId
        kind = 'chart'
        layout = @{ x = $X; y = 0; w = 6; h = 4 }
        chart = @{
            id = NewId; type = 'kpi'; title = $Title
            query = @{ measures = @(@{ measureId = $MeasureId }); filters = @() }
            format = $Format
        }
    }
}

$maintLayout = @{
    version = 1
    slicers = @()
    tiles = @(
        # --- KPI row (y=0) ---
        (KpiTile 'Total Cost' $mTotalCost 0 @{ valueFormat = '$#,0' })
        (KpiTile 'Work Orders' $mWorkOrders 6)
        (KpiTile 'Open Orders' $mOpenOrders 12)
        (KpiTile 'Avg Cost per Order' $mAvgCost 18 @{ valueFormat = '$#,0' })
        # --- slicer row (y=4) ---
        @{
            id = NewId; kind = 'slicer'; layout = @{ x = 0; y = 4; w = 6; h = 5 }
            slicer = @{ table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'checklist' }
        }
        @{
            id = NewId; kind = 'slicer'; layout = @{ x = 6; y = 4; w = 6; h = 5 }
            slicer = @{ table = 'public.work_orders'; column = 'priority'; label = 'Priority'; variant = 'buttons' }
        }
        @{
            id = NewId; kind = 'slicer'; layout = @{ x = 12; y = 4; w = 6; h = 4 }
            slicer = @{ table = 'public.work_orders'; column = 'opened_on'; label = 'Opened'; variant = 'dateRange' }
        }
        # --- chart row (y=9) ---
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 0; y = 9; w = 12; h = 8 }
            chart = @{
                id = NewId; type = 'column'; title = 'Cost by Region'
                query = @{
                    axis = @{ table = 'public.sites'; column = 'region' }
                    measures = @(@{ measureId = $mTotalCost }); filters = @()
                }
                format = @{ showDataLabels = $true; valueFormat = '$#,0' }
            }
        }
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 12; y = 9; w = 12; h = 8 }
            chart = @{
                id = NewId; type = 'donut'; title = 'Orders by Priority'
                query = @{
                    legend = @{ table = 'public.work_orders'; column = 'priority' }
                    measures = @(@{ measureId = $mWorkOrders }); filters = @()
                }
                format = @{ legendPosition = 'right' }
            }
        }
        # --- full-width trend (y=17) ---
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 0; y = 17; w = 24; h = 8 }
            chart = @{
                id = NewId; type = 'line'; title = 'Monthly Cost Trend'
                query = @{
                    axis = @{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'month' }
                    measures = @(@{ measureId = $mTotalCost }); filters = @()
                }
                format = @{ valueFormat = '$#,0' }
            }
        }
        # --- bottom row (y=25) ---
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 0; y = 25; w = 12; h = 8 }
            chart = @{
                id = NewId; type = 'stackedColumn'; title = 'Cost by Region and Priority'
                query = @{
                    axis = @{ table = 'public.sites'; column = 'region' }
                    legend = @{ table = 'public.work_orders'; column = 'priority' }
                    measures = @(@{ measureId = $mTotalCost }); filters = @()
                }
                format = @{ valueFormat = '$#,0' }
            }
        }
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 12; y = 25; w = 12; h = 8 }
            chart = @{
                id = NewId; type = 'table'; title = 'Top Vendors by Parts Spend'
                query = @{
                    axis = @{ table = 'public.vendors'; column = 'name' }
                    measures = @(@{ measureId = $mPartsSpend }); filters = @()
                    sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
                    limit = 10
                }
                format = @{}
            }
        }
    )
}

Write-Host "`nDashboard: Maintenance Overview"
$maintDash = EnsureDashboard 'Maintenance Overview' $maintModel.id $maintLayout `
    'Cost, workload and vendor spend across all plant sites.'

# ===========================================================================
# DASHBOARD 2: Inspection Quality
# ===========================================================================
$inspLayout = @{
    version = 1
    slicers = @()
    tiles = @(
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 0; y = 0; w = 6; h = 4 }
            chart = @{
                id = NewId; type = 'kpi'; title = 'Fail Count'
                query = @{ measures = @(@{ measureId = $mFailCount }); filters = @() }
                format = @{}
            }
        }
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 6; y = 0; w = 6; h = 4 }
            chart = @{
                id = NewId; type = 'kpi'; title = 'Inspection Count'
                query = @{ measures = @(@{ measureId = $mInspCount }); filters = @() }
                format = @{}
            }
        }
        @{
            id = NewId; kind = 'slicer'; layout = @{ x = 12; y = 0; w = 6; h = 4 }
            slicer = @{ table = 'public.inspections'; column = 'result'; label = 'Result'; variant = 'buttons' }
        }
        @{
            id = NewId; kind = 'slicer'; layout = @{ x = 18; y = 0; w = 6; h = 4 }
            slicer = @{ table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'checklist' }
        }
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 0; y = 4; w = 12; h = 8 }
            chart = @{
                id = NewId; type = 'column'; title = 'Fail Count by Region'
                query = @{
                    axis = @{ table = 'public.sites'; column = 'region' }
                    measures = @(@{ measureId = $mFailCount }); filters = @()
                }
                format = @{ showDataLabels = $true }
            }
        }
        @{
            id = NewId; kind = 'chart'; layout = @{ x = 12; y = 4; w = 12; h = 8 }
            chart = @{
                id = NewId; type = 'line'; title = 'Inspections by Month'
                query = @{
                    axis = @{ table = 'public.inspections'; column = 'inspected_on'; dateBucket = 'month' }
                    measures = @(@{ measureId = $mInspCount }); filters = @()
                }
                format = @{}
            }
        }
    )
}

Write-Host "`nDashboard: Inspection Quality"
$inspDash = EnsureDashboard 'Inspection Quality' $inspModel.id $inspLayout `
    'Inspection pass/fail quality trends by region and month.'

# ===========================================================================
# Verification queries: prove the seeded specs return data.
# ===========================================================================
Write-Host "`nVerification queries"

# 1. The Monthly Cost Trend tile's spec (role-playing date bucket on the fact).
$trend = RunQuery @{
    modelId = $maintModel.id
    dimensions = @(@{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'month' })
    measures = @(@{ measureId = $mTotalCost })
    filters = @(); sort = @()
}
Assert ($trend.rows.Count -ge 40) "monthly cost trend spans 40+ months (got $($trend.rows.Count))"

# 2. Cost by Region (3-hop join work_orders->valves->units->sites).
$byRegion = RunQuery @{
    modelId = $maintModel.id
    dimensions = @(@{ table = 'public.sites'; column = 'region' })
    measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mOpenOrders })
    filters = @(); sort = @()
}
Assert ($byRegion.rows.Count -eq 4) "cost by region covers all 4 regions (got $($byRegion.rows.Count))"

# 3. Top Vendors (bridge-table path work_order_parts->parts->vendors).
$vendors = RunQuery @{
    modelId = $maintModel.id
    dimensions = @(@{ table = 'public.vendors'; column = 'name' })
    measures = @(@{ measureId = $mPartsSpend })
    filters = @()
    sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
    limit = 10
}
Assert ($vendors.rows.Count -gt 0 -and $vendors.rows.Count -le 10) "top vendors by parts spend (got $($vendors.rows.Count) rows)"

# 4. Calendar date-table rollup by year.
$byYear = RunQuery @{
    modelId = $maintModel.id
    dimensions = @(@{ table = '#date.Calendar'; column = 'year' })
    measures = @(@{ measureId = $mTotalCost })
    filters = @(); sort = @()
}
Assert ($byYear.rows.Count -eq 4) "Calendar year rollup 2023-2026 (got $($byYear.rows.Count) years)"

# 5. Inspections model: filtered measure by region.
$fails = RunQuery @{
    modelId = $inspModel.id
    dimensions = @(@{ table = 'public.sites'; column = 'region' })
    measures = @(@{ measureId = $mFailCount })
    filters = @(); sort = @()
}
Assert ($fails.rows.Count -eq 4) "fail count by region covers 4 regions (got $($fails.rows.Count))"

# --- summary ---
Write-Host ''
Write-Host ('-' * 60)
Write-Host "Models:     Maintenance Operations (id $($maintModel.id)), Inspections (id $($inspModel.id))"
Write-Host "Dashboards: Maintenance Overview (id $($maintDash.id)), Inspection Quality (id $($inspDash.id))"
if ($failures -gt 0) {
    Write-Host "`n$failures check(s) FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "`nAll demo-content checks passed." -ForegroundColor Green
