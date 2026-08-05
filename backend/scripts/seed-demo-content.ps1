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
#
# -Showcase: skips seeding and creates/updates ONE shared dashboard "Feature
# Showcase" (owner carol) on the Maintenance Operations model demonstrating
# every advanced feature: drill hierarchies, legend cross-filter spotlight,
# dropdownMulti slicer, time-intelligence calcs (runningTotal / ytd /
# periodChangePct), reference lines + trendlines, rich-HTML axis titles,
# small multiples, conditional formats (barFill / dataBar / cellBackground),
# a drillthrough target page and dashboard bookmarks. Idempotent via
# deterministic ids: re-runs PUT the same doc onto the same dashboard.
#
# -Full: creates FIVE dense, corporate-grade shared dashboards (owner carol),
# each 3 pages: Executive Overview, Operations Command Center, Cost & Vendor
# Management, Workforce & Productivity, Asset Reliability. Additively appends
# a few measures to the two existing models (Open Rate / Closed Orders /
# Critical Backlog; Pass Count / Pass Rate), creates one new shared model
# "Workforce" (employees->sites ACTIVE so headcount rolls up correctly), and
# derives every conditional-format / reference-line threshold from live
# queries. Idempotent via deterministic md5 ids + name-matched re-PUT; then
# verifies by GETting each dashboard back and running every chart tile's wire
# query (params resolved to their default option).
param([string]$BaseUrl = 'http://localhost:5040', [switch]$Restyle, [switch]$Showcase, [switch]$Full)

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

# --- shared GET/PUT helpers (used by the -Restyle and -Showcase phases) ---
function GetModelByName([string]$Name) {
    $summary = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models" -Headers $headers |
        ForEach-Object { $_ } |
        Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $summary) { throw "Model '$Name' not found - run the plain seed phase first" }
    Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models/$($summary.id)" -Headers $headers
}

function GetDashboardByName([string]$Name) {
    $summary = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards" -Headers $headers |
        ForEach-Object { $_ } |
        Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $summary) { throw "Dashboard '$Name' not found - run the plain seed phase first" }
    Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards/$($summary.id)" -Headers $headers
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

# ===========================================================================
# RESTYLE PHASE (-Restyle): showcase restyling of the seeded dashboards.
# GET by name -> rebuild layout (reusing existing tile/chart ids) -> PUT with
# expectedUpdatedAtUtc. Run the plain seed phase first if content is missing.
# ===========================================================================
if ($Restyle) {

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

# ===========================================================================
# SHOWCASE PHASE (-Showcase): ONE shared "Feature Showcase" dashboard on the
# Maintenance Operations model, 4 pages, exercising every advanced feature.
# Idempotent: every id is deterministic (md5 of a stable key), so re-runs PUT
# an identical doc onto the same dashboard and bookmark refs never dangle.
# ===========================================================================
if ($Showcase) {

    Write-Host "`nShowcase: fetching model"
    $model = GetModelByName 'Maintenance Operations'
    $modelId = $model.id
    $mTotalCost = MeasureId $model 'Total Cost'
    $mWorkOrders = MeasureId $model 'Work Orders'
    $mOpenOrders = MeasureId $model 'Open Orders'
    $mAvgCost = MeasureId $model 'Avg Cost per Order'

    # Deterministic guid from a stable key (idempotent ids across re-runs).
    function DetId([string]$Key) {
        $md5 = [System.Security.Cryptography.MD5]::Create()
        try {
            [guid]::new($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("rcd-showcase:$Key"))).ToString()
        } finally { $md5.Dispose() }
    }

    # Wire ChartQuerySpec per toWireSpec: dimensions = [axis, legend?, smallMultiples?].
    function WireSpec([hashtable]$Query) {
        $dims = @()
        if ($Query.axis) { $dims += $Query.axis }
        if ($Query.legend) { $dims += $Query.legend }
        if ($Query.smallMultiples) { $dims += $Query.smallMultiples }
        $spec = @{
            modelId    = $modelId
            dimensions = $dims
            measures   = $Query.measures
            filters    = $Query.filters
            sort       = @()
        }
        # Plain assignment (no if-expression) so single-element arrays never
        # unwrap to a bare object on the wire.
        if ($Query.sort) { $spec.sort = @($Query.sort) }
        if ($null -ne $Query.limit) { $spec.limit = $Query.limit }
        $spec
    }

    function ChartTile([string]$Key, [string]$Type, [string]$Title, [hashtable]$Layout, [hashtable]$Query, [hashtable]$Format) {
        @{
            id = DetId "tile-$Key"; kind = 'chart'; layout = $Layout
            chart = @{ id = DetId "chart-$Key"; type = $Type; title = $Title; query = $Query; format = $Format }
        }
    }

    # Data-derived budget / RAG thresholds so conditional rules actually split
    # colors on the real data instead of guessing magnitudes.
    $siteRows = (RunQuery @{
        modelId = $modelId
        dimensions = @(@{ table = 'public.sites'; column = 'name' })
        measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mAvgCost })
        filters = @(); sort = @()
    }).rows
    $siteCosts = @($siteRows | ForEach-Object { [double]$_[1] })
    $siteAvgs = @($siteRows | ForEach-Object { [double]$_[2] } | Sort-Object)
    $budget = [math]::Round((($siteCosts | Measure-Object -Average).Average) / 1000) * 1000
    $ragLow = [math]::Round($siteAvgs[[int][math]::Floor($siteAvgs.Count / 3)])
    $ragHigh = [math]::Round($siteAvgs[[int][math]::Floor(2 * $siteAvgs.Count / 3)])
    Write-Host "  Budget line: `$$budget; Avg-cost RAG thresholds: `$$ragLow / `$$ragHigh"

    $dimRegion = @{ table = 'public.sites'; column = 'region' }
    $dimSiteName = @{ table = 'public.sites'; column = 'name' }
    $dimPriority = @{ table = 'public.work_orders'; column = 'priority' }
    $dimMonth = @{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'month' }

    # --- chart queries (kept in variables: the tile specs AND the wire-query
    #     verification below both use them, so they can never drift apart) ---
    $qDrill = @{
        axis = $dimRegion
        drillLevels = @($dimSiteName, $dimPriority)
        measures = @(@{ measureId = $mTotalCost }); filters = @()
    }
    $qSpotlight = @{
        axis = $dimMonth; legend = $dimPriority
        measures = @(@{ measureId = $mTotalCost }); filters = @()
    }
    $qYtdKpi = @{
        axis = $dimMonth
        measures = @(@{ measureId = $mTotalCost; calc = @{ kind = 'ytd' } })
        filters = @()
        sort = @(@{ target = @{ kind = 'dimension'; index = 0 }; direction = 'desc' })
        limit = 1
    }
    $qRunning = @{
        axis = $dimMonth
        measures = @(
            @{ measureId = $mTotalCost }
            @{ measureId = $mTotalCost; calc = @{ kind = 'runningTotal' } }
        )
        filters = @()
    }
    $qYoy = @{
        axis = $dimMonth
        measures = @(@{ measureId = $mTotalCost; calc = @{ kind = 'periodChangePct'; offset = 12 } })
        filters = @()
    }
    $qSmallMult = @{
        axis = $dimMonth; smallMultiples = $dimRegion
        measures = @(@{ measureId = $mTotalCost }); filters = @()
    }
    $qBudget = @{
        axis = $dimSiteName
        measures = @(@{ measureId = $mTotalCost }); filters = @()
        sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
    }
    $qScorecard = @{
        axis = $dimSiteName
        measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mAvgCost })
        filters = @()
        sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
    }
    # Row-level look via min-aggregates over the id axis (engine is aggregate-only).
    $qOrders = @{
        axis = @{ table = 'public.work_orders'; column = 'id' }
        measures = @(
            @{ table = 'public.work_orders'; column = 'opened_on'; aggregation = 'min'; alias = 'Opened' }
            @{ table = 'public.work_orders'; column = 'priority'; aggregation = 'min'; alias = 'Priority' }
            @{ table = 'public.work_orders'; column = 'status'; aggregation = 'min'; alias = 'Status' }
            @{ measureId = $mTotalCost }
        )
        filters = @()
        sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        limit = 25
    }
    $qKpiOrders = @{ measures = @(@{ measureId = $mWorkOrders }); filters = @() }
    $qKpiOpen = @{ measures = @(@{ measureId = $mOpenOrders }); filters = @() }
    $qKpiCost = @{ measures = @(@{ measureId = $mTotalCost }); filters = @() }

    $pgDrill = DetId 'page-drill'
    $pgTime = DetId 'page-time'
    $pgAnalytics = DetId 'page-analytics'
    $pgDetails = DetId 'page-details'
    $slRegionId = DetId 'tile-slicer-region'

    # ----------------------------------------------------------------- page 1
    $drillTiles = @(
        @{
            id = DetId 'tile-p1-header'; kind = 'text'; layout = @{ x = 0; y = 0; w = 24; h = 3 }
            text = @{
                html = '<h2>Drill &amp; Explore</h2><p><span style="color:#64748b">Drill the left chart from Region into Site, then Priority. Click a legend chip on the right chart to spotlight that priority across the whole page. Both slicers filter every chart.</span></p>'
                align = 'left'
            }
        }
        @{
            id = $slRegionId; kind = 'slicer'; layout = @{ x = 0; y = 3; w = 7; h = 4 }
            slicer = @{ table = 'public.sites'; column = 'region'; label = 'Region (multi dropdown)'
                        variant = 'dropdownMulti'; style = @{ compact = $true } }
        }
        @{
            id = DetId 'tile-slicer-priority'; kind = 'slicer'; layout = @{ x = 7; y = 3; w = 9; h = 4 }
            slicer = @{ table = 'public.work_orders'; column = 'priority'; label = 'Priority'; variant = 'buttons'
                        style = @{ compact = $true } }
        }
        @{
            id = DetId 'tile-p1-note'; kind = 'text'; layout = @{ x = 16; y = 3; w = 8; h = 4 }
            text = @{
                html = '<p><b>Legend spotlight</b></p><p><span style="color:#9a3412">Click a legend item to spotlight the page; click it again to clear.</span></p>'
                align = 'left'; background = '#fff7ed'
            }
        }
        (ChartTile 'drill' 'column' 'Cost by Region (drill: Site, Priority)' @{ x = 0; y = 7; w = 12; h = 9 } $qDrill @{
            theme = 'ocean'; colorByCategory = $true; showDataLabels = $true; valueFormat = '$#,0'
            yAxisFormat = @{ kind = 'compact' }
            container = @{
                hideHeader = $true
                innerTitleHtml = '<p><b>Cost by Region</b> <span style="color:#64748b">&mdash; drill down to Site, then Priority</span></p>'
            }
        })
        (ChartTile 'spotlight' 'stackedColumn' 'Monthly Cost by Priority' @{ x = 12; y = 7; w = 12; h = 9 } $qSpotlight @{
            theme = 'sunset'; legendInteractive = $true; legendMode = 'crossFilter'
            dateFormat = 'monthYear'; yAxisFormat = @{ kind = 'compact' }; legendPosition = 'bottom'
            tooltip = @{ showPercent = $true; accentBorder = $true }
        })
    )

    # ----------------------------------------------------------------- page 2
    $timeTiles = @(
        @{
            id = DetId 'tile-p2-header'; kind = 'text'; layout = @{ x = 0; y = 0; w = 24; h = 3 }
            text = @{
                html = '<h2>Time Intelligence</h2><p><span style="color:#64748b">Engine-computed window calculations: running total, year-to-date and year-over-year % change of monthly cost &mdash; with an average reference line and a linear trendline on the main series.</span></p>'
                align = 'left'
            }
        }
        (ChartTile 'ytd-kpi' 'kpi' 'YTD Cost (latest month)' @{ x = 0; y = 3; w = 6; h = 5 } $qYtdKpi @{
            valueFormat = '$#,0'
            seriesLabels = @{ 'Total Cost (YTD)' = 'Year-to-date cost' }
            container = @{ borderColor = '#eb6834'; borderWidth = 1; borderRadius = 12; shadow = 'sm' }
        })
        (ChartTile 'running' 'line' 'Monthly Cost and Running Total' @{ x = 6; y = 3; w = 18; h = 10 } $qRunning @{
            theme = 'berry'; dateFormat = 'monthYear'; valueFormat = '$#,0'
            yAxisFormat = @{ kind = 'compact' }
            lineStyles = @{
                'Total Cost'                 = @{ dash = 'solid'; width = 3 }
                'Total Cost (running total)' = @{ dash = 'dashed'; width = 2 }
            }
            seriesLabels = @{ 'Total Cost' = 'Monthly cost'; 'Total Cost (running total)' = 'Cumulative cost' }
            referenceLines = @(@{ id = DetId 'ref-avg'; kind = 'average'; measureKey = 'Total Cost'
                                  label = 'Monthly average'; color = '#eb6834'; dash = 'dashed'; showLabel = $true })
            trendlines = @(@{ id = DetId 'trend-lin'; kind = 'linear'; seriesKey = 'Total Cost'
                              color = '#8b5cf6'; dash = 'dotted'; width = 2 })
            xAxisLabelHtml = '<b>Month</b> <span style="color:#2a78d6">(2023&ndash;2026)</span>'
            yAxisLabelHtml = '<b>Cost</b> <span style="color:#64748b">(USD)</span>'
        })
        (ChartTile 'yoy' 'line' 'Monthly Cost: YoY % Change (12-month offset)' @{ x = 0; y = 13; w = 24; h = 9 } $qYoy @{
            theme = 'forest'; dateFormat = 'monthYear'; valueFormat = '0.0%'
            yAxisFormat = @{ kind = 'percent'; decimals = 0 }
            seriesLabels = @{ 'Total Cost (% change)' = 'YoY change in monthly cost' }
            lineStyles = @{ 'Total Cost (% change)' = @{ dash = 'solid'; width = 2 } }
            referenceLines = @(@{ id = DetId 'ref-zero'; kind = 'constant'; value = 0
                                  label = 'No change'; color = '#64748b'; dash = 'dotted'; showLabel = $true })
        })
    )

    # ----------------------------------------------------------------- page 3
    $analyticsTiles = @(
        (ChartTile 'smallmult' 'line' 'Monthly Cost by Region (small multiples)' @{ x = 0; y = 0; w = 24; h = 10 } $qSmallMult @{
            theme = 'ocean'; dateFormat = 'monthYear'; yAxisFormat = @{ kind = 'compact' }; valueFormat = '$#,0'
            smallMultiples = @{ columns = 2; sharedY = $true; showPanelTitles = $true }
            container = @{
                hideHeader = $true
                innerTitleHtml = '<p><b>Monthly Cost by Region</b> <span style="color:#64748b">&mdash; one panel per region, shared y-axis</span></p>'
            }
        })
        (ChartTile 'budget' 'column' 'Cost by Site vs Budget' @{ x = 0; y = 10; w = 12; h = 9 } $qBudget @{
            valueFormat = '$#,0'; yAxisFormat = @{ kind = 'compact' }
            referenceLines = @(@{ id = DetId 'ref-budget'; kind = 'constant'; value = $budget
                                  label = 'Budget'; color = '#111827'; dash = 'dashed'; showLabel = $true })
            conditionalFormats = @(@{
                id = DetId 'cf-barfill'; measureKey = 'Total Cost'; style = 'barFill'
                rules = @(
                    @{ op = 'gt'; value = $budget; color = '#dc2626' }
                    @{ op = 'lte'; value = $budget; color = '#16a34a' }
                )
            })
        })
        (ChartTile 'scorecard' 'table' 'Site Scorecard' @{ x = 12; y = 10; w = 12; h = 9 } $qScorecard @{
            valueFormat = '$#,0'; legendStyle = @{ bold = $true }
            conditionalFormats = @(
                @{ id = DetId 'cf-databar'; measureKey = 'Total Cost'; style = 'dataBar'
                   dataBarColor = '#2a78d6'; rules = @() }
                @{ id = DetId 'cf-rag'; measureKey = 'Avg Cost per Order'; style = 'cellBackground'
                   rules = @(
                       @{ op = 'lt'; value = $ragLow; color = '#bbf7d0' }
                       @{ op = 'lt'; value = $ragHigh; color = '#fde68a' }
                       @{ op = 'gte'; value = $ragHigh; color = '#fecaca' }
                   ) }
            )
        })
    )

    # ----------------------------------------------------------------- page 4
    $kpiContainer = @{ borderColor = '#8b5cf6'; borderWidth = 1; borderRadius = 12; shadow = 'sm' }
    $detailTiles = @(
        @{
            id = DetId 'tile-p4-header'; kind = 'text'; layout = @{ x = 0; y = 0; w = 24; h = 3 }
            text = @{
                html = '<p><b>Right-click a region elsewhere &rarr; Drill through here.</b></p><p><span style="color:#64748b">This page is a drillthrough target on sites.region: invoke Drill through from a region point on any other page and the KPIs and table below filter to that region.</span></p>'
                align = 'left'; background = '#f5f3ff'
            }
        }
        (ChartTile 'kpi-orders' 'kpi' 'Work Orders' @{ x = 0; y = 3; w = 8; h = 4 } $qKpiOrders @{ container = $kpiContainer })
        (ChartTile 'kpi-open' 'kpi' 'Open Orders' @{ x = 8; y = 3; w = 8; h = 4 } $qKpiOpen @{ container = $kpiContainer })
        (ChartTile 'kpi-cost' 'kpi' 'Total Cost' @{ x = 16; y = 3; w = 8; h = 4 } $qKpiCost @{
            valueFormat = '$#,0'; container = $kpiContainer })
        (ChartTile 'orders-table' 'table' 'Recent Work Orders (latest 25 by open date)' @{ x = 0; y = 7; w = 24; h = 11 } $qOrders @{
            legendStyle = @{ bold = $true }; valueFormat = '$#,0'
        })
    )

    # ------------------------------------------------------------- bookmarks
    $gulfSlicers = @{}
    $gulfSlicers[$slRegionId] = @{ table = 'public.sites'; column = 'region'; operator = 'in'; values = @('Gulf Coast') }
    $bookmarks = @(
        @{ id = DetId 'bm-exec'; name = 'Exec: YTD view'
           state = @{ pageId = $pgTime; slicers = @{}; filterOverrides = @{} } }
        @{ id = DetId 'bm-gulf'; name = 'Ops: Gulf Coast'
           state = @{ pageId = $pgDrill; slicers = $gulfSlicers; filterOverrides = @{} } }
    )

    $layout = @{
        version = 1; tiles = @(); slicers = @()
        pages = @(
            @{ id = $pgDrill; name = 'Drill & Explore'; color = '#2a78d6'; tiles = $drillTiles }
            @{ id = $pgTime; name = 'Time Intelligence'; color = '#eb6834'; tiles = $timeTiles }
            @{ id = $pgAnalytics; name = 'Small Multiples & Analytics'; color = '#1baf7a'; tiles = $analyticsTiles }
            @{ id = $pgDetails; name = 'Order Details'; color = '#8b5cf6'; tiles = $detailTiles
               drillthrough = @{ enabled = $true; fields = @(@{ table = 'public.sites'; column = 'region' }) } }
        )
        bookmarks = $bookmarks
    }

    # ------------------------------------------------- create or update (PUT)
    Write-Host "`nShowcase: saving 'Feature Showcase'"
    $existing = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards" -Headers $headers |
        ForEach-Object { $_ } |
        Where-Object { $_.name -eq 'Feature Showcase' } | Select-Object -First 1
    if ($existing) {
        $detail = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards/$($existing.id)" -Headers $headers
        $dash = PutDashboard $detail $layout
        Write-Host "  UPDATE  dashboard 'Feature Showcase' re-saved (id $($dash.id))" -ForegroundColor Yellow
    } else {
        $body = @{
            name = 'Feature Showcase'
            description = 'Every advanced feature on one dashboard: drill hierarchies, cross-filter spotlight, time intelligence, small multiples, conditional formatting, drillthrough and bookmarks.'
            modelId = $modelId
            isShared = $true
            layout = $layout
        } | ConvertTo-Json -Depth 24
        $dash = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/dashboards" `
            -Headers $headers -ContentType 'application/json' -Body $body -StatusCodeVariable status
        Assert ($status -eq 201 -and $dash.id -gt 0) "dashboard 'Feature Showcase' created with 201 (id $($dash.id))"
    }

    # ------------------------------------------------- verify: document shape
    Write-Host "`nShowcase verification: persisted document"
    $check = GetDashboardByName 'Feature Showcase'
    Assert ($check.modelId -eq $modelId) 'bound to the Maintenance Operations model'
    Assert ($check.isShared -and $check.ownerIsMe) 'shared and owned by carol'
    $pages = @($check.layout.pages)
    Assert ($pages.Count -eq 4) "4 pages persisted (got $($pages.Count))"
    Assert ((($pages | ForEach-Object { $_.name }) -join '|') -eq 'Drill & Explore|Time Intelligence|Small Multiples & Analytics|Order Details') 'page names + order persisted'
    Assert ((($pages | ForEach-Object { $_.color }) | Select-Object -Unique).Count -eq 4) 'page tab colors are distinct'

    $p1 = $pages[0]; $p2 = $pages[1]; $p3 = $pages[2]; $p4 = $pages[3]
    $drillChart = @($p1.tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-drill') } | Select-Object -First 1
    Assert (@($drillChart.chart.query.drillLevels).Count -eq 2) 'drill hierarchy: axis + 2 drill levels'
    $spot = @($p1.tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-spotlight') } | Select-Object -First 1
    Assert ($spot.chart.format.legendMode -eq 'crossFilter') 'legendMode crossFilter persisted'
    $slicer = @($p1.tiles) | Where-Object { $_.id -eq $slRegionId } | Select-Object -First 1
    Assert ($slicer.slicer.variant -eq 'dropdownMulti') 'dropdownMulti slicer variant persisted'

    $run = @($p2.tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-running') } | Select-Object -First 1
    Assert (@($run.chart.format.referenceLines).Count -eq 1 -and @($run.chart.format.trendlines).Count -eq 1) 'reference line + trendline persisted'
    Assert ([bool]$run.chart.format.xAxisLabelHtml -and [bool]$run.chart.format.yAxisLabelHtml) 'rich-HTML axis titles persisted'
    $ytdTile = @($p2.tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-ytd-kpi') } | Select-Object -First 1
    Assert ($ytdTile.chart.query.measures[0].calc.kind -eq 'ytd') 'KPI ytd calc persisted'

    $sm = @($p3.tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-smallmult') } | Select-Object -First 1
    Assert ($sm.chart.query.smallMultiples.column -eq 'region' -and $sm.chart.format.smallMultiples.columns -eq 2 -and $sm.chart.format.smallMultiples.sharedY) 'small multiples split + grid format persisted'
    $bud = @($p3.tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-budget') } | Select-Object -First 1
    Assert ($bud.chart.format.referenceLines[0].label -eq 'Budget' -and $bud.chart.format.conditionalFormats[0].style -eq 'barFill') 'Budget constant line + barFill rules persisted'
    $sc = @($p3.tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-scorecard') } | Select-Object -First 1
    Assert (((@($sc.chart.format.conditionalFormats) | ForEach-Object { $_.style }) -join ',') -eq 'dataBar,cellBackground') 'table dataBar + cellBackground rules persisted'

    Assert ($p4.drillthrough.enabled -and $p4.drillthrough.fields[0].column -eq 'region') 'Order Details is a drillthrough target on sites.region'
    $bms = @($check.layout.bookmarks)
    Assert ($bms.Count -eq 2) "2 bookmarks persisted (got $($bms.Count))"
    $execBm = $bms | Where-Object { $_.name -eq 'Exec: YTD view' } | Select-Object -First 1
    Assert ($execBm.state.pageId -eq $pgTime) 'Exec bookmark points at Time Intelligence'
    $gulfBm = $bms | Where-Object { $_.name -eq 'Ops: Gulf Coast' } | Select-Object -First 1
    Assert ($gulfBm.state.pageId -eq $pgDrill -and (@($gulfBm.state.slicers.$slRegionId.values) -contains 'Gulf Coast')) 'Gulf Coast bookmark captures the region slicer selection'

    # --------------------------------------------- verify: every chart's wire
    Write-Host "`nShowcase verification: wire queries (toWireSpec per chart)"
    function WireCheck([string]$Name, [hashtable]$Query, [int]$MinRows = 1) {
        try {
            $r = RunQuery (WireSpec $Query)
            $n = @($r.rows).Count
            if ($n -ge $MinRows) {
                Write-Host "  $([char]0x2713) $Name ($n rows)" -ForegroundColor Green
            } else {
                Write-Host "  $([char]0x2717) $Name (expected >= $MinRows rows, got $n)" -ForegroundColor Red
                $script:failures++
            }
        } catch {
            $detailMsg = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
            Write-Host "  $([char]0x2717) $Name ($detailMsg)" -ForegroundColor Red
            $script:failures++
        }
    }

    WireCheck 'P1 Cost by Region (drill level 0)' $qDrill 4
    WireCheck 'P1 drill level 1 (sites under a region)' @{
        axis = $dimSiteName; measures = @(@{ measureId = $mTotalCost })
        filters = @(@{ table = 'public.sites'; column = 'region'; operator = 'eq'; values = @('Gulf Coast') })
    }
    WireCheck 'P1 drill level 2 (priorities under a site)' @{
        axis = $dimPriority; measures = @(@{ measureId = $mTotalCost })
        filters = @(
            @{ table = 'public.sites'; column = 'region'; operator = 'eq'; values = @('Gulf Coast') }
            @{ table = 'public.sites'; column = 'name'; operator = 'eq'; values = @('Baytown Plant') }
        )
    }
    WireCheck 'P1 Monthly Cost by Priority (crossFilter legend)' $qSpotlight 100
    WireCheck 'P2 YTD KPI (calc ytd, latest month first)' $qYtdKpi
    WireCheck 'P2 Running-total line (calc runningTotal)' $qRunning 40
    WireCheck 'P2 YoY % line (calc periodChangePct, offset 12)' $qYoy 40
    WireCheck 'P3 Small multiples (axis + smallMultiples dims)' $qSmallMult 100
    WireCheck 'P3 Cost by Site vs Budget' $qBudget 6
    WireCheck 'P3 Site Scorecard' $qScorecard 6
    WireCheck 'P4 Recent Work Orders table' $qOrders 25
    WireCheck 'P4 KPI Work Orders' $qKpiOrders
    WireCheck 'P4 KPI Open Orders' $qKpiOpen
    WireCheck 'P4 KPI Total Cost' $qKpiCost
    WireCheck 'P4 Orders table under drillthrough (region = Gulf Coast)' @{
        axis = $qOrders.axis; measures = $qOrders.measures
        sort = $qOrders.sort; limit = $qOrders.limit
        filters = @(@{ table = 'public.sites'; column = 'region'; operator = 'eq'; values = @('Gulf Coast') })
    }

    # --- summary ---
    $tileTotal = (@($pages) | ForEach-Object { @($_.tiles).Count } | Measure-Object -Sum).Sum
    Write-Host ''
    Write-Host ('-' * 60)
    Write-Host "Showcase: Feature Showcase (id $($check.id)) - 4 pages, $tileTotal tiles, 2 bookmarks"
    if ($failures -gt 0) {
        Write-Host "`n$failures showcase check(s) FAILED" -ForegroundColor Red
        exit 1
    }
    Write-Host "`nAll showcase checks passed." -ForegroundColor Green
    exit 0
}

# ===========================================================================
# FULL PHASE (-Full): FIVE dense, corporate-grade shared dashboards (owner
# carol), each with >= 3 fully-built pages. Requires the plain seed phase to
# have run (models 'Maintenance Operations' + 'Inspections'). Additive only:
# appends a few measures to the two existing models, creates one new shared
# model 'Workforce', and creates/updates ONLY the five -Full dashboards.
# Idempotent via deterministic md5 ids + name-matched re-PUT.
# ===========================================================================
if ($Full) {

    Write-Host "`nFull: fetching models"
    $maintModel = GetModelByName 'Maintenance Operations'
    $inspModel = GetModelByName 'Inspections'

    # Deterministic guid from a stable key (idempotent ids across re-runs).
    function DetId([string]$Key) {
        $md5 = [System.Security.Cryptography.MD5]::Create()
        try {
            [guid]::new($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("rcd-full:$Key"))).ToString()
        } finally { $md5.Dispose() }
    }

    # ------------------------------------------------- additive model measures
    # Appends missing-by-name measures to an existing model via PUT (never
    # removes or rewrites anything already there). Returns the fresh model.
    function EnsureModelMeasures($Model, [object[]]$Wanted) {
        $have = @($Model.definition.measures | ForEach-Object { $_.name })
        $missing = @($Wanted | Where-Object { $have -notcontains $_.name })
        if ($missing.Count -eq 0) {
            Write-Host "  SKIP  model '$($Model.name)' already has the -Full measures" -ForegroundColor Yellow
            return $Model
        }
        $definition = $Model.definition | ConvertTo-Json -Depth 24 | ConvertFrom-Json -AsHashtable
        $definition.measures = @($definition.measures) + $missing
        $body = @{
            name = $Model.name; description = $Model.description; dataSourceName = $Model.dataSourceName
            definition = $definition; isShared = $Model.isShared; expectedUpdatedAtUtc = $Model.updatedAtUtc
        } | ConvertTo-Json -Depth 24
        $updated = Invoke-RestMethod -Method Put -Uri "$BaseUrl/api/rcd/v1/models/$($Model.id)" `
            -Headers $headers -ContentType 'application/json' -Body $body
        Write-Host "  UPDATE  model '$($Model.name)': added $(($missing | ForEach-Object { $_.name }) -join ', ')" -ForegroundColor Yellow
        return $updated
    }

    $maintModel = EnsureModelMeasures $maintModel @(
        @{ id = NewId; name = 'Open Rate'; table = 'public.work_orders'; aggregation = 'sum'
           expression = '1.0 * [Open Orders] / [Work Orders]'; formatHint = 'percent' }
        @{ id = NewId; name = 'Closed Orders'; table = 'public.work_orders'; aggregation = 'count'
           filters = @(@{ table = 'public.work_orders'; column = 'status'; operator = 'eq'; values = @('closed') }) }
        @{ id = NewId; name = 'Critical Backlog'; table = 'public.work_orders'; aggregation = 'count'
           filters = @(
               @{ table = 'public.work_orders'; column = 'priority'; operator = 'eq'; values = @('critical') }
               @{ table = 'public.work_orders'; column = 'status'; operator = 'in'; values = @('open', 'in_progress') }
           ) }
    )
    $inspModel = EnsureModelMeasures $inspModel @(
        @{ id = NewId; name = 'Pass Count'; table = 'public.inspections'; aggregation = 'count'
           filters = @(@{ table = 'public.inspections'; column = 'result'; operator = 'eq'; values = @('pass') }) }
        @{ id = NewId; name = 'Pass Rate'; table = 'public.inspections'; aggregation = 'sum'
           expression = '1.0 * [Pass Count] / [Inspection Count]'; formatHint = 'percent' }
    )

    # ------------------------------------------------------- Workforce model
    # employees.site_id is ACTIVE here (it is inactive in Maintenance
    # Operations), so headcount and orders roll up to the employee's home
    # site/region - the semantics a workforce dashboard needs.
    function EnsureFullModel([string]$Name, [hashtable]$Definition, [string]$Description) {
        $existing = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models" -Headers $headers |
            ForEach-Object { $_ } |
            Where-Object { $_.name -eq $Name } | Select-Object -First 1
        if ($existing) {
            Write-Host "  SKIP  model '$Name' already exists (id $($existing.id))" -ForegroundColor Yellow
            return Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/models/$($existing.id)" -Headers $headers
        }
        $body = @{
            name = $Name; description = $Description; dataSourceName = 'demo'
            definition = $Definition; isShared = $true
        } | ConvertTo-Json -Depth 16
        $model = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/models" `
            -Headers $headers -ContentType 'application/json' -Body $body -StatusCodeVariable status
        Assert ($status -eq 201 -and $model.id -gt 0) "model '$Name' created with 201 (id $($model.id))"
        return $model
    }

    Write-Host "`nFull: model 'Workforce'"
    $wfModel = EnsureFullModel 'Workforce' @{
        version = 1
        tables = @(
            @{ schema = 'public'; name = 'sites'; position = @{ x = 40; y = 40 } }
            @{ schema = 'public'; name = 'employees'; position = @{ x = 320; y = 40 } }
            @{ schema = 'public'; name = 'work_orders'; position = @{ x = 600; y = 40 } }
        )
        relationships = @(
            @{ id = NewId; fromTable = 'public.employees'; fromColumn = 'site_id'; toTable = 'public.sites'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
            @{ id = NewId; fromTable = 'public.work_orders'; fromColumn = 'assigned_to'; toTable = 'public.employees'; toColumn = 'id'; cardinality = 'manyToOne'; isActive = $true; source = 'fk' }
        )
        measures = @(
            @{ id = NewId; name = 'Labor Hours'; table = 'public.work_orders'; aggregation = 'sum'; column = 'labor_hours' }
            @{ id = NewId; name = 'Work Orders'; table = 'public.work_orders'; aggregation = 'count' }
            @{ id = NewId; name = 'Open Orders'; table = 'public.work_orders'; aggregation = 'count'
               filters = @(@{ table = 'public.work_orders'; column = 'status'; operator = 'in'; values = @('open', 'in_progress') }) }
            @{ id = NewId; name = 'Closed Orders'; table = 'public.work_orders'; aggregation = 'count'
               filters = @(@{ table = 'public.work_orders'; column = 'status'; operator = 'eq'; values = @('closed') }) }
            @{ id = NewId; name = 'Headcount'; table = 'public.employees'; aggregation = 'countDistinct'; column = 'id' }
            @{ id = NewId; name = 'Total Cost'; table = 'public.work_orders'; aggregation = 'sum'; column = 'total_cost'; formatHint = 'currency' }
            @{ id = NewId; name = 'Avg Hours per Order'; table = 'public.work_orders'; aggregation = 'sum'
               expression = 'SUM(public.work_orders.labor_hours) / COUNT(*)' }
        )
    } 'Workload, labor and assignments rolled up to each employee''s home site (employees->sites active).'

    # ----------------------------------------------------------- measure ids
    $mTotalCost = MeasureId $maintModel 'Total Cost'
    $mLaborHours = MeasureId $maintModel 'Labor Hours'
    $mWorkOrders = MeasureId $maintModel 'Work Orders'
    $mOpenOrders = MeasureId $maintModel 'Open Orders'
    $mAvgCost = MeasureId $maintModel 'Avg Cost per Order'
    $mPartsSpend = MeasureId $maintModel 'Parts Spend'
    $mOpenRate = MeasureId $maintModel 'Open Rate'
    $mClosedOrders = MeasureId $maintModel 'Closed Orders'
    $mCriticalBacklog = MeasureId $maintModel 'Critical Backlog'
    $iInspCount = MeasureId $inspModel 'Inspection Count'
    $iFailCount = MeasureId $inspModel 'Fail Count'
    $iPassRate = MeasureId $inspModel 'Pass Rate'
    $iLaborHours = MeasureId $inspModel 'Total Labor Hours'
    $wLabor = MeasureId $wfModel 'Labor Hours'
    $wOrders = MeasureId $wfModel 'Work Orders'
    $wOpen = MeasureId $wfModel 'Open Orders'
    $wClosed = MeasureId $wfModel 'Closed Orders'
    $wHead = MeasureId $wfModel 'Headcount'
    $wCost = MeasureId $wfModel 'Total Cost'
    $wAvgHours = MeasureId $wfModel 'Avg Hours per Order'

    # ------------------------------------------------ data-derived thresholds
    # Every budget line / RAG cutoff / KPI target comes from a live query so
    # the conditional rules actually split colors on the real data.
    Write-Host "`nFull: deriving thresholds from live data"
    function Tercile([double[]]$Sorted, [int]$Which) { $Sorted[[int][math]::Floor($Which * $Sorted.Count / 3)] }

    # /query is rate-limited (token bucket, QueriesPerMinutePerUser). The -Full
    # verification fires ~115 queries, so wait out 503s instead of failing.
    function PostQueryBody([string]$Body) {
        for ($attempt = 1; $attempt -le 36; $attempt++) {
            try {
                return Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/query" `
                    -Headers $headers -ContentType 'application/json' -Body $Body
            } catch {
                $code = 0
                if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
                if ($code -eq 503 -and $attempt -lt 36) { Start-Sleep -Seconds 5; continue }
                throw
            }
        }
    }
    function RunQueryF([hashtable]$Spec) { PostQueryBody ($Spec | ConvertTo-Json -Depth 12) }
    function Scalar([int]$ModelId, [hashtable]$Measure) {
        [double]((RunQueryF @{ modelId = $ModelId; dimensions = @(); measures = @($Measure); filters = @(); sort = @() }).rows[0][0])
    }

    $siteRows = (RunQueryF @{
        modelId = $maintModel.id
        dimensions = @(@{ table = 'public.sites'; column = 'name' })
        measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mAvgCost })
        filters = @(); sort = @()
    }).rows
    $siteCosts = @($siteRows | ForEach-Object { [double]$_[1] })
    $siteAvgs = @($siteRows | ForEach-Object { [double]$_[2] } | Sort-Object)
    $budget = [math]::Round((($siteCosts | Measure-Object -Average).Average) / 1000) * 1000
    $avgCostHigh = [math]::Round((Tercile $siteAvgs 2))

    $openNow = Scalar $maintModel.id @{ measureId = $mOpenOrders }
    $rateNow = Scalar $maintModel.id @{ measureId = $mOpenRate }
    $openTarget = [math]::Round($openNow * 1.2)
    $rateTarget = [math]::Round($rateNow * 1.15, 3)

    $qtyRows = (RunQueryF @{
        modelId = $maintModel.id
        dimensions = @(@{ table = 'public.parts'; column = 'description' })
        measures = @(@{ table = 'public.work_order_parts'; column = 'quantity'; aggregation = 'sum'; alias = 'Qty Used' })
        filters = @(); sort = @()
    }).rows
    $qtys = @($qtyRows | ForEach-Object { [double]$_[1] } | Sort-Object)
    $qtyLow = [math]::Round((Tercile $qtys 1))
    $qtyHigh = [math]::Round((Tercile $qtys 2))

    $wlRows = (RunQueryF @{
        modelId = $wfModel.id
        dimensions = @(@{ table = 'public.employees'; column = 'name' })
        measures = @(@{ measureId = $wOrders }); filters = @(); sort = @()
    }).rows
    $wlHigh = [math]::Ceiling(((@($wlRows | ForEach-Object { [double]$_[1] }) | Measure-Object -Average).Average))

    $prRows = (RunQueryF @{
        modelId = $inspModel.id
        dimensions = @(@{ table = 'public.technicians'; column = 'name' })
        measures = @(@{ measureId = $iPassRate }); filters = @(); sort = @()
    }).rows
    $prs = @($prRows | ForEach-Object { [double]$_[1] } | Sort-Object)
    $prLow = [math]::Round((Tercile $prs 1), 3)
    $prHigh = [math]::Round((Tercile $prs 2), 3)
    $passRateAll = Scalar $inspModel.id @{ measureId = $iPassRate }
    $passTarget = [math]::Round($passRateAll * 0.95, 3)
    $failsAll = Scalar $inspModel.id @{ measureId = $iFailCount }
    $failTarget = [math]::Round($failsAll * 0.5)

    Write-Host ("  Budget {0}; avg-cost watch {1}; open target {2}; open-rate target {3}" -f $budget, $avgCostHigh, $openTarget, $rateTarget)
    Write-Host ("  Qty RAG {0}/{1}; workload high {2}; pass-rate RAG {3}/{4}; pass target {5}; fail target {6}" -f $qtyLow, $qtyHigh, $wlHigh, $prLow, $prHigh, $passTarget, $failTarget)

    # ------------------------------------------------------------ tile helpers
    $red = '#dc2626'; $green = '#16a34a'
    function ChartTile([string]$Key, [string]$Type, [string]$Title, [hashtable]$Layout, [hashtable]$Query, [hashtable]$Format) {
        @{
            id = DetId "tile-$Key"; kind = 'chart'; layout = $Layout
            chart = @{ id = DetId "chart-$Key"; type = $Type; title = $Title; query = $Query; format = $Format }
        }
    }
    # Frameless accent-bordered KPI card with a rich inner title.
    function KpiCard([string]$Key, [string]$Title, [string]$Sub, [int]$X, [int]$Y, [string]$Accent, [hashtable]$Query, [hashtable]$Format = @{}) {
        $fmt = @{} + $Format
        $fmt.container = @{
            hideHeader = $true; borderColor = $Accent; borderWidth = 1; borderRadius = 12; shadow = 'sm'
            innerTitleHtml = ('<p><b>{0}</b> <span style="color:#64748b">{1}</span></p>' -f $Title, $Sub)
        }
        ChartTile $Key 'kpi' $Title @{ x = $X; y = $Y; w = 6; h = 4 } $Query $fmt
    }
    function TextTile([string]$Key, [hashtable]$Layout, [string]$Html, [string]$Background = $null) {
        $text = @{ html = $Html; align = 'left' }
        if ($Background) { $text.background = $Background }
        @{ id = DetId "tile-$Key"; kind = 'text'; layout = $Layout; text = $text }
    }
    function SlicerTile([string]$Key, [hashtable]$Layout, [hashtable]$Slicer) {
        @{ id = DetId "tile-$Key"; kind = 'slicer'; layout = $Layout; slicer = $Slicer }
    }
    # Frameless hero container with a rich inner title.
    function HeroTitle([string]$Title, [string]$Sub) {
        @{
            hideHeader = $true
            innerTitleHtml = ('<p><b>{0}</b> <span style="color:#64748b">&mdash; {1}</span></p>' -f $Title, $Sub)
        }
    }

    # --------------------------------------------------------- shared literals
    $dRegion = @{ table = 'public.sites'; column = 'region' }
    $dSite = @{ table = 'public.sites'; column = 'name' }
    $dPriority = @{ table = 'public.work_orders'; column = 'priority' }
    $dStatus = @{ table = 'public.work_orders'; column = 'status' }
    $dMonth = @{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'month' }
    $dYear = @{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'year' }
    $dQuarter = @{ table = 'public.work_orders'; column = 'opened_on'; dateBucket = 'quarter' }
    $dVendor = @{ table = 'public.vendors'; column = 'name' }
    $dVendorRegion = @{ table = 'public.vendors'; column = 'region' }
    $dCategory = @{ table = 'public.parts'; column = 'category' }
    $dPartDesc = @{ table = 'public.parts'; column = 'description' }
    $dValveType = @{ table = 'public.valves'; column = 'valve_type' }
    $dEmployee = @{ table = 'public.employees'; column = 'name' }
    $dEmpTitle = @{ table = 'public.employees'; column = 'title' }
    $dIMonth = @{ table = 'public.inspections'; column = 'inspected_on'; dateBucket = 'month' }
    $dIResult = @{ table = 'public.inspections'; column = 'result' }
    $dTech = @{ table = 'public.technicians'; column = 'name' }
    $dInstallYear = @{ table = 'public.valves'; column = 'install_date'; dateBucket = 'year' }
    $dInstallMonth = @{ table = 'public.valves'; column = 'install_date'; dateBucket = 'month' }

    $priorityLabels = @{ critical = 'Critical'; high = 'High'; medium = 'Medium'; low = 'Low' }
    $statusLabels = @{ open = 'Open'; in_progress = 'In progress'; closed = 'Closed'; cancelled = 'Cancelled' }
    $resultLabels = @{ pass = 'Pass'; fail = 'Fail'; adjusted = 'Adjusted' }
    $thisYear = (Get-Date).Year
    $lastYear = $thisYear - 1

    # ------------------------------------------------------ create-or-update
    function EnsureFullDashboard([string]$Name, [int]$ModelId, [hashtable]$Layout, [string]$Description) {
        $existing = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards" -Headers $headers |
            ForEach-Object { $_ } |
            Where-Object { $_.name -eq $Name } | Select-Object -First 1
        if ($existing) {
            $detail = Invoke-RestMethod -Uri "$BaseUrl/api/rcd/v1/dashboards/$($existing.id)" -Headers $headers
            $saved = PutDashboard $detail $Layout
            Write-Host "  UPDATE  dashboard '$Name' re-saved (id $($saved.id))" -ForegroundColor Yellow
            return $saved
        }
        $body = @{
            name = $Name; description = $Description; modelId = $ModelId; isShared = $true; layout = $Layout
        } | ConvertTo-Json -Depth 24
        $dash = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rcd/v1/dashboards" `
            -Headers $headers -ContentType 'application/json' -Body $body -StatusCodeVariable status
        Assert ($status -eq 201 -and $dash.id -gt 0) "dashboard '$Name' created with 201 (id $($dash.id))"
        return $dash
    }

    # =======================================================================
    # DASHBOARD 1: Executive Overview (Maintenance Operations, ocean #1868ae)
    # =======================================================================
    Write-Host "`nFull: Executive Overview"
    $oc = '#1868ae'

    $d1p1 = @(
        (KpiCard 'd1-k-ytd' 'Cost YTD' "$thisYear to date" 0 0 $oc @{
            axis = $dMonth
            measures = @(@{ measureId = $mTotalCost; calc = @{ kind = 'ytd' } })
            filters = @()
            sort = @(@{ target = @{ kind = 'dimension'; index = 0 }; direction = 'desc' }); limit = 1
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost (YTD)' = 'year-to-date spend' } })
        (KpiCard 'd1-k-orders' 'Work Orders' 'all time' 6 0 $oc @{
            measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{ seriesLabels = @{ 'Work Orders' = 'orders logged' } })
        (KpiCard 'd1-k-openrate' 'Open %' 'share still open' 12 0 $oc @{
            measures = @(@{ measureId = $mOpenRate }); filters = @()
        } @{ valueFormat = '0.0%'; seriesLabels = @{ 'Open Rate' = 'open + in progress' } })
        (KpiCard 'd1-k-avg' 'Avg Cost / Order' 'blended' 18 0 $oc @{
            measures = @(@{ measureId = $mAvgCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Avg Cost per Order' = 'per work order' } })
        (SlicerTile 'd1-sl-region' @{ x = 0; y = 4; w = 8; h = 4 } @{
            table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'checklist'; style = @{ compact = $true } })
        (SlicerTile 'd1-sl-priority' @{ x = 8; y = 4; w = 8; h = 4 } @{
            table = 'public.work_orders'; column = 'priority'; label = 'Priority'; variant = 'buttons'; style = @{ compact = $true } })
        (SlicerTile 'd1-sl-opened' @{ x = 16; y = 4; w = 8; h = 4 } @{
            table = 'public.work_orders'; column = 'opened_on'; label = 'Opened'; variant = 'dateRange' })
        (ChartTile 'd1-hero' 'line' 'Cost Trend & Cumulative Spend' @{ x = 0; y = 8; w = 16; h = 9 } @{
            axis = $dMonth
            measures = @(
                @{ measureId = $mTotalCost }
                @{ measureId = $mTotalCost; calc = @{ kind = 'runningTotal' } }
            )
            filters = @()
        } @{
            theme = 'ocean'; dateFormat = 'monthYear'; valueFormat = '$#,0'
            yAxisFormat = @{ kind = 'compact' }; y2AxisFormat = @{ kind = 'compact' }; y2AxisLabel = 'Cumulative'
            secondaryAxisKeys = @('Total Cost (running total)')
            seriesLabels = @{ 'Total Cost' = 'Monthly spend'; 'Total Cost (running total)' = 'Cumulative spend' }
            lineStyles = @{
                'Total Cost' = @{ dash = 'solid'; width = 3 }
                'Total Cost (running total)' = @{ dash = 'dashed'; width = 2 }
            }
            referenceLines = @(@{ id = DetId 'd1-ref-avg'; kind = 'average'; measureKey = 'Total Cost'
                                  label = 'Monthly average'; color = '#f2542d'; dash = 'dashed'; showLabel = $true })
            trendlines = @(@{ id = DetId 'd1-trend'; kind = 'linear'; seriesKey = 'Total Cost'
                              color = '#7cd0d8'; dash = 'dotted'; width = 2 })
            tooltip = @{ accentBorder = $true }
            container = HeroTitle 'Cost trend' 'monthly spend, cumulative total (right axis), average and linear trend'
        })
        (ChartTile 'd1-donut' 'donut' 'Spend by Region' @{ x = 16; y = 8; w = 8; h = 9 } @{
            legend = $dRegion; measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{
            theme = 'ocean'; legendPosition = 'bottom'
            tooltip = @{ showPercent = $true; accentBorder = $true }
            container = @{ shadow = 'md'; borderRadius = 16 }
        })
        (ChartTile 'd1-sites' 'table' 'Top Sites by Spend' @{ x = 0; y = 17; w = 12; h = 9 } @{
            axis = $dSite
            measures = @(
                @{ table = 'public.sites'; column = 'region'; aggregation = 'min'; alias = 'Region' }
                @{ measureId = $mTotalCost }
                @{ measureId = $mAvgCost }
            )
            filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 1 }; direction = 'desc' })
        } @{
            legendStyle = @{ bold = $true }
            conditionalFormats = @(@{ id = DetId 'd1-cf-databar'; measureKey = 'Total Cost'; style = 'dataBar'
                                      dataBarColor = '#1868ae'; rules = @() })
            table = @{ stripes = $true; density = 'normal' }
        })
        (ChartTile 'd1-mix' 'stackedColumn' 'Priority Mix by Region' @{ x = 12; y = 17; w = 12; h = 9 } @{
            axis = $dRegion; legend = $dPriority; measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{
            theme = 'ocean'; legendPosition = 'bottom'; legendInteractive = $true
            tooltip = @{ showPercent = $true }; seriesLabels = $priorityLabels
        })
    )

    $d1p2 = @(
        (KpiCard 'd1-k2-cy' "Cost $thisYear" 'year to date' 0 0 $oc @{
            measures = @(@{ measureId = $mTotalCost })
            filters = @(@{ table = 'public.work_orders'; column = 'opened_on'; operator = 'gte'; values = @("$thisYear-01-01") })
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = "Jan-today $thisYear" } })
        (KpiCard 'd1-k2-ly' "Cost $lastYear" 'full year' 6 0 $oc @{
            measures = @(@{ measureId = $mTotalCost })
            filters = @(@{ table = 'public.work_orders'; column = 'opened_on'; operator = 'between'; values = @("$lastYear-01-01", "$lastYear-12-31") })
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = "full year $lastYear" } })
        (KpiCard 'd1-k2-yoy' 'YoY Change' 'latest month vs prior year' 12 0 $oc @{
            axis = $dMonth
            measures = @(@{ measureId = $mTotalCost; calc = @{ kind = 'periodChangePct'; offset = 12 } })
            filters = @()
            sort = @(@{ target = @{ kind = 'dimension'; index = 0 }; direction = 'desc' }); limit = 1
        } @{
            valueFormat = '0.0%'; seriesLabels = @{ 'Total Cost (% change)' = 'cost vs prior year' }
            conditionalFormats = @(@{ id = DetId 'd1-cf-yoy'; measureKey = 'Total Cost (% change)'; style = 'kpi'
                                      rules = @(@{ op = 'gt'; value = 0; color = $red }, @{ op = 'lte'; value = 0; color = $green }) })
        })
        (KpiCard 'd1-k2-orders' "Orders $thisYear" 'year to date' 18 0 $oc @{
            measures = @(@{ measureId = $mWorkOrders })
            filters = @(@{ table = 'public.work_orders'; column = 'opened_on'; operator = 'gte'; values = @("$thisYear-01-01") })
        } @{ seriesLabels = @{ 'Work Orders' = 'opened this year' } })
        (ChartTile 'd1-yoy' 'line' 'Year-over-Year Cost Change' @{ x = 0; y = 4; w = 24; h = 8 } @{
            axis = $dMonth
            measures = @(@{ measureId = $mTotalCost; calc = @{ kind = 'periodChangePct'; offset = 12 } })
            filters = @()
        } @{
            theme = 'ocean'; dateFormat = 'monthYear'; valueFormat = '0.0%'
            yAxisFormat = @{ kind = 'percent'; decimals = 0 }
            seriesLabels = @{ 'Total Cost (% change)' = 'YoY change in monthly spend' }
            lineStyles = @{ 'Total Cost (% change)' = @{ dash = 'solid'; width = 2 } }
            referenceLines = @(@{ id = DetId 'd1-ref-zero'; kind = 'constant'; value = 0
                                  label = 'No change'; color = '#64748b'; dash = 'dotted'; showLabel = $true })
            container = HeroTitle 'Growth' 'monthly spend vs the same month a year earlier (12-month offset)'
        })
        (ChartTile 'd1-smallmult' 'line' 'Monthly Cost by Region' @{ x = 0; y = 12; w = 12; h = 9 } @{
            axis = $dMonth; smallMultiples = $dRegion
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{
            theme = 'ocean'; dateFormat = 'monthYear'; valueFormat = '$#,0'; yAxisFormat = @{ kind = 'compact' }
            smallMultiples = @{ columns = 2; sharedY = $true; showPanelTitles = $true }
            container = HeroTitle 'Seasonality by region' 'one panel per region, shared y-axis'
        })
        (ChartTile 'd1-drill' 'column' 'Cost by Year (drill: Quarter, Month)' @{ x = 12; y = 12; w = 12; h = 9 } @{
            axis = $dYear; drillLevels = @($dQuarter, $dMonth)
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{
            theme = 'ocean'; colorByCategory = $true; showDataLabels = $true; valueFormat = '$#,0'
            yAxisFormat = @{ kind = 'compact' }; dateFormat = 'year'
        })
    )

    $d1p3 = @(
        (TextTile 'd1-p3-note' @{ x = 0; y = 0; w = 24; h = 2 } '<p><b>Drillthrough target.</b> <span style="color:#64748b">Right-click a region on any other page and choose Drill through &rarr; Regional Deep Dive; every tile below then filters to that region.</span></p>' '#eff6ff')
        (KpiCard 'd1-k3-cost' 'Total Cost' 'in scope' 0 2 $oc @{
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = 'maintenance spend' } })
        (KpiCard 'd1-k3-orders' 'Work Orders' 'in scope' 6 2 $oc @{
            measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{ seriesLabels = @{ 'Work Orders' = 'orders logged' } })
        (KpiCard 'd1-k3-open' 'Open Orders' 'in scope' 12 2 $oc @{
            measures = @(@{ measureId = $mOpenOrders }); filters = @()
        } @{ seriesLabels = @{ 'Open Orders' = 'open + in progress' } })
        (KpiCard 'd1-k3-labor' 'Labor Hours' 'in scope' 18 2 $oc @{
            measures = @(@{ measureId = $mLaborHours }); filters = @()
        } @{ seriesLabels = @{ 'Labor Hours' = 'hours booked' } })
        (ChartTile 'd1-p3-table' 'table' 'Sites in Scope' @{ x = 0; y = 6; w = 12; h = 9 } @{
            axis = $dSite
            measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mAvgCost })
            filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            legendStyle = @{ bold = $true }
            conditionalFormats = @(@{ id = DetId 'd1-cf-databar2'; measureKey = 'Total Cost'; style = 'dataBar'
                                      dataBarColor = '#1868ae'; rules = @() })
            table = @{ stripes = $true }
        })
        (ChartTile 'd1-p3-mix' 'donut' 'Priority Mix' @{ x = 12; y = 6; w = 12; h = 9 } @{
            legend = $dPriority; measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{
            theme = 'ocean'; legendPosition = 'right'
            tooltip = @{ showPercent = $true }; seriesLabels = $priorityLabels
        })
        (ChartTile 'd1-p3-trend' 'area' 'Monthly Spend' @{ x = 0; y = 15; w = 24; h = 8 } @{
            axis = $dMonth; measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{
            theme = 'ocean'; dateFormat = 'monthYear'; valueFormat = '$#,0'; yAxisFormat = @{ kind = 'compact' }
            trendlines = @(@{ id = DetId 'd1-trend-ma'; kind = 'movingAverage'; window = 3; seriesKey = 'Total Cost'
                              color = '#0e4d92'; dash = 'dashed'; width = 2 })
            container = HeroTitle 'Monthly spend' '3-month moving average overlay'
        })
    )

    # Per-page phone layouts: KPIs first, hero next, slicers folded to the end.
    function D1Mobile([string[]]$OrderKeys, [string]$HeroKey) {
        $mobile = @{ order = @($OrderKeys | ForEach-Object { DetId "tile-$_" }); heights = @{} }
        if ($HeroKey) { $mobile.heights[(DetId "tile-$HeroKey")] = 340 }
        $mobile
    }
    $d1Pages = @(
        @{ id = DetId 'd1-page-1'; name = 'Company Pulse'; color = '#1868ae'; tiles = $d1p1
           mobileLayout = (D1Mobile @('d1-k-ytd', 'd1-k-orders', 'd1-k-openrate', 'd1-k-avg', 'd1-hero', 'd1-donut', 'd1-sites', 'd1-mix', 'd1-sl-region', 'd1-sl-priority', 'd1-sl-opened') 'd1-hero') }
        @{ id = DetId 'd1-page-2'; name = 'Growth & Seasonality'; color = '#26a5b8'; tiles = $d1p2
           mobileLayout = (D1Mobile @('d1-k2-cy', 'd1-k2-ly', 'd1-k2-yoy', 'd1-k2-orders', 'd1-yoy', 'd1-smallmult', 'd1-drill') 'd1-yoy') }
        @{ id = DetId 'd1-page-3'; name = 'Regional Deep Dive'; color = '#0e4d92'; tiles = $d1p3
           drillthrough = @{ enabled = $true; fields = @(@{ table = 'public.sites'; column = 'region' }) }
           mobileLayout = (D1Mobile @('d1-k3-cost', 'd1-k3-orders', 'd1-k3-open', 'd1-k3-labor', 'd1-p3-trend', 'd1-p3-table', 'd1-p3-mix', 'd1-p3-note') 'd1-p3-trend') }
    )
    $d1Gulf = @{}
    $d1Gulf[(DetId 'tile-d1-sl-region')] = @{ table = 'public.sites'; column = 'region'; operator = 'in'; values = @('Gulf Coast') }
    $d1Layout = @{
        version = 1; tiles = @(); slicers = @()
        pages = $d1Pages
        bookmarks = @(
            @{ id = DetId 'd1-bm-pulse'; name = 'Exec: company pulse'
               state = @{ pageId = DetId 'd1-page-1'; slicers = @{}; filterOverrides = @{} } }
            @{ id = DetId 'd1-bm-gulf'; name = 'Focus: Gulf Coast'
               state = @{ pageId = DetId 'd1-page-1'; slicers = $d1Gulf; filterOverrides = @{} } }
            @{ id = DetId 'd1-bm-growth'; name = 'Growth & seasonality'
               state = @{ pageId = DetId 'd1-page-2'; slicers = @{}; filterOverrides = @{} } }
        )
    }
    $d1 = EnsureFullDashboard 'Executive Overview' $maintModel.id $d1Layout `
        'C-suite view of maintenance spend: pulse KPIs, growth and seasonality, and a regional drillthrough deep dive.'

    # =======================================================================
    # DASHBOARD 2: Operations Command Center (Maintenance Operations, sunset)
    # =======================================================================
    Write-Host "`nFull: Operations Command Center"
    $su = '#f2542d'

    $d2p1 = @(
        (KpiCard 'd2-k-open' 'Open Orders' "target &le; $openTarget" 0 0 $su @{
            measures = @(@{ measureId = $mOpenOrders }); filters = @()
        } @{
            seriesLabels = @{ 'Open Orders' = 'open + in progress' }
            conditionalFormats = @(@{ id = DetId 'd2-cf-open'; measureKey = 'Open Orders'; style = 'kpi'
                                      rules = @(@{ op = 'gt'; value = $openTarget; color = $red }, @{ op = 'lte'; value = $openTarget; color = $green }) })
        })
        (KpiCard 'd2-k-crit' 'Critical Backlog' 'critical, still open' 6 0 $su @{
            measures = @(@{ measureId = $mCriticalBacklog }); filters = @()
        } @{
            seriesLabels = @{ 'Critical Backlog' = 'needs attention' }
            conditionalFormats = @(@{ id = DetId 'd2-cf-crit'; measureKey = 'Critical Backlog'; style = 'kpi'
                                      rules = @(@{ op = 'gt'; value = 0; color = $red }, @{ op = 'lte'; value = 0; color = $green }) })
        })
        (KpiCard 'd2-k-rate' 'Open %' "target &le; $($rateTarget * 100)%" 12 0 $su @{
            measures = @(@{ measureId = $mOpenRate }); filters = @()
        } @{
            valueFormat = '0.0%'; seriesLabels = @{ 'Open Rate' = 'share of all orders' }
            conditionalFormats = @(@{ id = DetId 'd2-cf-rate'; measureKey = 'Open Rate'; style = 'kpi'
                                      rules = @(@{ op = 'gt'; value = $rateTarget; color = $red }, @{ op = 'lte'; value = $rateTarget; color = $green }) })
        })
        (KpiCard 'd2-k-avg' 'Avg Cost / Order' 'blended' 18 0 $su @{
            measures = @(@{ measureId = $mAvgCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Avg Cost per Order' = 'per work order' } })
        (SlicerTile 'd2-sl-window' @{ x = 0; y = 4; w = 8; h = 4 } @{
            table = 'public.work_orders'; column = 'opened_on'; label = 'Opened window'
            variant = 'relativeDate'; preset = 'last90d'; style = @{ compact = $true } })
        (SlicerTile 'd2-sl-status' @{ x = 8; y = 4; w = 8; h = 4 } @{
            table = 'public.work_orders'; column = 'status'; label = 'Status'; variant = 'buttons'; style = @{ compact = $true } })
        (SlicerTile 'd2-sl-region' @{ x = 16; y = 4; w = 8; h = 4 } @{
            table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'dropdownMulti'; style = @{ compact = $true } })
        (ChartTile 'd2-live' 'column' 'Open Orders by Site (live)' @{ x = 0; y = 8; w = 12; h = 9 } @{
            axis = $dSite; measures = @(@{ measureId = $mOpenOrders }); filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            theme = 'sunset'; colorByCategory = $true; showDataLabels = $true; refreshSeconds = 30
            container = HeroTitle 'Open orders by site' 'auto-refreshes every 30 seconds'
        })
        (ChartTile 'd2-priostack' 'stackedColumn' 'Monthly Orders by Priority' @{ x = 12; y = 8; w = 12; h = 9 } @{
            axis = $dMonth; legend = $dPriority; measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{
            theme = 'sunset'; legendInteractive = $true; legendMode = 'crossFilter'; legendPosition = 'bottom'
            dateFormat = 'monthYear'; tooltip = @{ showPercent = $true; accentBorder = $true }
            seriesLabels = $priorityLabels
        })
    )

    $d2p2 = @(
        (KpiCard 'd2-k2-cost' 'Total Cost' 'in scope' 0 0 $su @{
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = 'maintenance spend' } })
        (KpiCard 'd2-k2-orders' 'Work Orders' 'in scope' 6 0 $su @{
            measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{ seriesLabels = @{ 'Work Orders' = 'orders logged' } })
        (KpiCard 'd2-k2-closed' 'Closed Orders' 'completed' 12 0 $su @{
            measures = @(@{ measureId = $mClosedOrders }); filters = @()
        } @{ seriesLabels = @{ 'Closed Orders' = 'status = closed' } })
        (KpiCard 'd2-k2-labor' 'Labor Hours' 'booked' 18 0 $su @{
            measures = @(@{ measureId = $mLaborHours }); filters = @()
        } @{ seriesLabels = @{ 'Labor Hours' = 'across all orders' } })
        (SlicerTile 'd2-sl-site' @{ x = 0; y = 4; w = 12; h = 4 } @{
            table = 'public.sites'; column = 'name'; label = 'Site'; variant = 'dropdownMulti'; style = @{ compact = $true } })
        (SlicerTile 'd2-sl-priority' @{ x = 12; y = 4; w = 12; h = 4 } @{
            table = 'public.work_orders'; column = 'priority'; label = 'Priority'; variant = 'buttons'; style = @{ compact = $true } })
        (ChartTile 'd2-drill' 'column' 'Cost by Region (drill: Site)' @{ x = 0; y = 8; w = 12; h = 9 } @{
            axis = $dRegion; drillLevels = @($dSite)
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{
            theme = 'sunset'; colorByCategory = $true; showDataLabels = $true; valueFormat = '$#,0'
            yAxisFormat = @{ kind = 'compact' }
            container = HeroTitle 'Cost by region' 'drill down into individual sites'
        })
        (ChartTile 'd2-budget' 'column' 'Site Spend vs Budget' @{ x = 12; y = 8; w = 12; h = 9 } @{
            axis = $dSite; measures = @(@{ measureId = $mTotalCost }); filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            valueFormat = '$#,0'; yAxisFormat = @{ kind = 'compact' }
            referenceLines = @(@{ id = DetId 'd2-ref-budget'; kind = 'constant'; value = $budget
                                  label = 'Budget'; color = '#111827'; dash = 'dashed'; showLabel = $true })
            conditionalFormats = @(@{ id = DetId 'd2-cf-budget'; measureKey = 'Total Cost'; style = 'barFill'
                                      rules = @(@{ op = 'gt'; value = $budget; color = $red }, @{ op = 'lte'; value = $budget; color = $green }) })
        })
        (ChartTile 'd2-statusmix' 'stackedColumn' 'Status Mix by Site' @{ x = 0; y = 17; w = 24; h = 8 } @{
            axis = $dSite; legend = $dStatus; measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{
            theme = 'sunset'; legendInteractive = $true; legendMode = 'isolate'; legendPosition = 'bottom'
            tooltip = @{ showPercent = $true }; seriesLabels = $statusLabels
        })
    )

    $d2p3 = @(
        (TextTile 'd2-p3-note' @{ x = 0; y = 0; w = 24; h = 2 } '<p><b>Drillthrough target on Site + Status.</b> <span style="color:#64748b">Right-click a segment on Status Mix by Site and choose Drill through &rarr; Order Details to land here filtered to that site and status.</span></p>' '#fff7ed')
        (KpiCard 'd2-k3-orders' 'Work Orders' 'in scope' 0 2 $su @{
            measures = @(@{ measureId = $mWorkOrders }); filters = @()
        } @{ seriesLabels = @{ 'Work Orders' = 'orders in view' } })
        (KpiCard 'd2-k3-open' 'Open Orders' 'in scope' 6 2 $su @{
            measures = @(@{ measureId = $mOpenOrders }); filters = @()
        } @{ seriesLabels = @{ 'Open Orders' = 'open + in progress' } })
        (KpiCard 'd2-k3-cost' 'Total Cost' 'in scope' 12 2 $su @{
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = 'maintenance spend' } })
        (KpiCard 'd2-k3-parts' 'Parts Used' 'units consumed' 18 2 $su @{
            measures = @(@{ table = 'public.work_order_parts'; column = 'quantity'; aggregation = 'sum'; alias = 'Parts Used' })
            filters = @()
        } @{ seriesLabels = @{ 'Parts Used' = 'part units' } })
        (ChartTile 'd2-orders' 'table' 'Work Order Register' @{ x = 0; y = 6; w = 24; h = 12 } @{
            axis = @{ table = 'public.work_orders'; column = 'id' }
            measures = @(
                @{ table = 'public.work_orders'; column = 'opened_on'; aggregation = 'min'; alias = 'Opened' }
                @{ table = 'public.sites'; column = 'name'; aggregation = 'min'; alias = 'Site' }
                @{ table = 'public.employees'; column = 'name'; aggregation = 'min'; alias = 'Assigned To' }
                @{ table = 'public.work_orders'; column = 'priority'; aggregation = 'min'; alias = 'Priority' }
                @{ table = 'public.work_orders'; column = 'status'; aggregation = 'min'; alias = 'Status' }
                @{ measureId = $mTotalCost }
            )
            filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            legendStyle = @{ bold = $true }
            table = @{ borders = 'grid'; density = 'compact'; pageSize = 50; totals = $true
                       pinned = 1; filterable = $true; stripes = $true; headerBold = $true }
        })
    )

    $d2Last30 = @{}
    $d2Last30[(DetId 'tile-d2-sl-window')] = @{ clause = $null; presetId = 'last30d' }
    $d2Active = @{}
    $d2Active[(DetId 'tile-d2-sl-status')] = @{ table = 'public.work_orders'; column = 'status'; operator = 'in'; values = @('open', 'in_progress') }
    $d2Layout = @{
        version = 1; tiles = @(); slicers = @()
        pages = @(
            @{ id = DetId 'd2-page-1'; name = 'Live Backlog'; color = '#f2542d'; tiles = $d2p1 }
            @{ id = DetId 'd2-page-2'; name = 'Site Performance'; color = '#f9a03f'; tiles = $d2p2 }
            @{ id = DetId 'd2-page-3'; name = 'Order Details'; color = '#d81159'; tiles = $d2p3
               drillthrough = @{ enabled = $true; fields = @(
                   @{ table = 'public.sites'; column = 'name' }
                   @{ table = 'public.work_orders'; column = 'status' }
               ) } }
        )
        bookmarks = @(
            @{ id = DetId 'd2-bm-30d'; name = 'Live: last 30 days'
               state = @{ pageId = DetId 'd2-page-1'; slicers = $d2Last30; filterOverrides = @{} } }
            @{ id = DetId 'd2-bm-backlog'; name = 'Backlog only'
               state = @{ pageId = DetId 'd2-page-1'; slicers = $d2Active; filterOverrides = @{} } }
            @{ id = DetId 'd2-bm-sites'; name = 'Site performance'
               state = @{ pageId = DetId 'd2-page-2'; slicers = @{}; filterOverrides = @{} } }
        )
    }
    $d2 = EnsureFullDashboard 'Operations Command Center' $maintModel.id $d2Layout `
        'Daily ops console: live backlog with targets, site performance vs budget, and a drillthrough work-order register.'

    # =======================================================================
    # DASHBOARD 3: Cost & Vendor Management (Maintenance Operations, berry)
    # =======================================================================
    Write-Host "`nFull: Cost & Vendor Management"
    $be = '#7b2cbf'
    $paramLens = DetId 'd3-param-lens'

    $d3p1 = @(
        (KpiCard 'd3-k-cost' 'Total Cost' 'all maintenance' 0 0 $be @{
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = 'labor + parts' } })
        (KpiCard 'd3-k-parts' 'Parts Spend' 'line cost' 6 0 $be @{
            measures = @(@{ measureId = $mPartsSpend }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Parts Spend' = 'consumed parts' } })
        (KpiCard 'd3-k-qty' 'Parts Used' 'units consumed' 12 0 $be @{
            measures = @(@{ table = 'public.work_order_parts'; column = 'quantity'; aggregation = 'sum'; alias = 'Parts Used' })
            filters = @()
        } @{ seriesLabels = @{ 'Parts Used' = 'part units' } })
        (KpiCard 'd3-k-avg' 'Avg Cost / Order' 'blended' 18 0 $be @{
            measures = @(@{ measureId = $mAvgCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Avg Cost per Order' = 'per work order' } })
        (SlicerTile 'd3-sl-lens' @{ x = 0; y = 4; w = 8; h = 4 } @{
            table = ''; column = ''; label = 'Spend lens'; variant = 'fieldParam'
            parameterId = $paramLens; style = @{ compact = $true } })
        (SlicerTile 'd3-sl-region' @{ x = 8; y = 4; w = 8; h = 4 } @{
            table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'dropdownMulti'; style = @{ compact = $true } })
        (SlicerTile 'd3-sl-opened' @{ x = 16; y = 4; w = 8; h = 4 } @{
            table = 'public.work_orders'; column = 'opened_on'; label = 'Opened'; variant = 'dateRange' })
        (ChartTile 'd3-lens' 'column' 'Parts Spend by Lens' @{ x = 0; y = 8; w = 12; h = 9 } @{
            axis = $dRegion
            paramBindings = @{ axis = $paramLens }
            measures = @(@{ measureId = $mPartsSpend }); filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            theme = 'berry'; colorByCategory = $true; showDataLabels = $true; valueFormat = '$#,0'
            yAxisFormat = @{ kind = 'compact' }
            container = HeroTitle 'Parts spend' 'switch the axis with the Spend lens field parameter'
        })
        (ChartTile 'd3-vendors' 'bar' 'Vendor Spend Ranking' @{ x = 12; y = 8; w = 12; h = 9 } @{
            axis = $dVendor; measures = @(@{ measureId = $mPartsSpend }); filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' }); limit = 10
        } @{
            theme = 'berry'; showDataLabels = $true; valueFormat = '$#,0'; xAxisFormat = @{ kind = 'compact' }
        })
        (ChartTile 'd3-trend' 'line' 'Maintenance vs Parts Spend' @{ x = 0; y = 17; w = 24; h = 8 } @{
            axis = $dMonth
            measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mPartsSpend }); filters = @()
        } @{
            theme = 'berry'; dateFormat = 'monthYear'; valueFormat = '$#,0'; yAxisFormat = @{ kind = 'compact' }
            seriesLabels = @{ 'Total Cost' = 'Total maintenance spend'; 'Parts Spend' = 'Parts line cost' }
            lineStyles = @{
                'Total Cost' = @{ dash = 'solid'; width = 3 }
                'Parts Spend' = @{ dash = 'dashed'; width = 2 }
            }
            trendlines = @(@{ id = DetId 'd3-ma'; kind = 'movingAverage'; window = 3; seriesKey = 'Parts Spend'
                              color = '#5a189a'; dash = 'dotted'; width = 2 })
            container = HeroTitle 'Spend trend' 'parts cost inside total maintenance spend, 3-month moving average'
        })
    )

    $d3p2 = @(
        (KpiCard 'd3-k2-parts' 'Parts Spend' 'line cost' 0 0 $be @{
            measures = @(@{ measureId = $mPartsSpend }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Parts Spend' = 'consumed parts' } })
        (KpiCard 'd3-k2-qty' 'Qty Used' 'units' 6 0 $be @{
            measures = @(@{ table = 'public.work_order_parts'; column = 'quantity'; aggregation = 'sum'; alias = 'Qty Used' })
            filters = @()
        } @{ seriesLabels = @{ 'Qty Used' = 'part units' } })
        (KpiCard 'd3-k2-skus' 'Distinct Parts' 'SKUs consumed' 12 0 $be @{
            measures = @(@{ table = 'public.work_order_parts'; column = 'part_id'; aggregation = 'countDistinct'; alias = 'Distinct Parts' })
            filters = @()
        } @{ seriesLabels = @{ 'Distinct Parts' = 'unique SKUs' } })
        (KpiCard 'd3-k2-rating' 'Avg Vendor Rating' 'out of 5' 18 0 $be @{
            measures = @(@{ table = 'public.vendors'; column = 'rating'; aggregation = 'avg'; alias = 'Avg Vendor Rating' })
            filters = @()
        } @{ valueFormat = '0.0'; seriesLabels = @{ 'Avg Vendor Rating' = 'supplier quality' } })
        (ChartTile 'd3-partstable' 'table' 'Part Consumption' @{ x = 0; y = 4; w = 14; h = 10 } @{
            axis = $dPartDesc
            measures = @(
                @{ table = 'public.parts'; column = 'category'; aggregation = 'min'; alias = 'Category' }
                @{ measureId = $mPartsSpend }
                @{ table = 'public.work_order_parts'; column = 'quantity'; aggregation = 'sum'; alias = 'Qty Used' }
            )
            filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 1 }; direction = 'desc' }); limit = 20
        } @{
            legendStyle = @{ bold = $true }
            conditionalFormats = @(
                @{ id = DetId 'd3-cf-databar'; measureKey = 'Parts Spend'; style = 'dataBar'
                   dataBarColor = '#7b2cbf'; rules = @() }
                @{ id = DetId 'd3-cf-qty'; measureKey = 'Qty Used'; style = 'cellBackground'
                   rules = @(
                       @{ op = 'lt'; value = $qtyLow; color = '#bbf7d0' }
                       @{ op = 'lt'; value = $qtyHigh; color = '#fde68a' }
                       @{ op = 'gte'; value = $qtyHigh; color = '#fecaca' }
                   ) }
            )
            table = @{ density = 'compact'; stripes = $true; borders = 'rows'; filterable = $true }
        })
        (ChartTile 'd3-catmix' 'stackedColumn' 'Category Mix by Region' @{ x = 14; y = 4; w = 10; h = 10 } @{
            axis = $dRegion; legend = $dCategory; measures = @(@{ measureId = $mPartsSpend }); filters = @()
        } @{
            theme = 'berry'; legendPosition = 'bottom'; legendInteractive = $true
            tooltip = @{ showPercent = $true }; valueFormat = '$#,0'
        })
        (ChartTile 'd3-catshare' 'donut' 'Spend Share by Category' @{ x = 0; y = 14; w = 10; h = 8 } @{
            legend = $dCategory; measures = @(@{ measureId = $mPartsSpend }); filters = @()
        } @{
            theme = 'berry'; legendPosition = 'right'; tooltip = @{ showPercent = $true }
        })
        (ChartTile 'd3-vregion' 'column' 'Vendor Region: Spend & Rating' @{ x = 10; y = 14; w = 14; h = 8 } @{
            axis = $dVendorRegion
            measures = @(
                @{ measureId = $mPartsSpend }
                @{ table = 'public.vendors'; column = 'rating'; aggregation = 'avg'; alias = 'Avg Rating' }
            )
            filters = @()
        } @{
            theme = 'berry'; valueFormat = '$#,0'; yAxisFormat = @{ kind = 'compact' }
            secondaryAxisKeys = @('Avg Rating'); y2AxisFormat = @{ kind = 'number'; decimals = 1 }; y2AxisLabel = 'Avg rating'
            seriesLabels = @{ 'Parts Spend' = 'Spend'; 'Avg Rating' = 'Vendor rating (right axis)' }
        })
    )

    $d3p3 = @(
        (KpiCard 'd3-k3-avg' 'Avg Cost / Order' "watch &gt; `$$avgCostHigh" 0 0 $be @{
            measures = @(@{ measureId = $mAvgCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Avg Cost per Order' = 'per work order' } })
        (KpiCard 'd3-k3-cost' 'Total Cost' 'all maintenance' 6 0 $be @{
            measures = @(@{ measureId = $mTotalCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = 'labor + parts' } })
        (KpiCard 'd3-k3-labor' 'Labor Hours' 'booked' 12 0 $be @{
            measures = @(@{ measureId = $mLaborHours }); filters = @()
        } @{ seriesLabels = @{ 'Labor Hours' = 'across all orders' } })
        (KpiCard 'd3-k3-rate' 'Open %' 'share still open' 18 0 $be @{
            measures = @(@{ measureId = $mOpenRate }); filters = @()
        } @{ valueFormat = '0.0%'; seriesLabels = @{ 'Open Rate' = 'open + in progress' } })
        (ChartTile 'd3-scatter' 'scatter' 'Cost vs Labor by Site' @{ x = 0; y = 4; w = 14; h = 10 } @{
            axis = $dSite; legend = $dValveType
            measures = @(@{ measureId = $mTotalCost }, @{ measureId = $mLaborHours }); filters = @()
        } @{
            theme = 'berry'
            xAxisFormat = @{ kind = 'compact' }
            xAxisLabelHtml = '<b>Total cost</b> <span style="color:#64748b">(USD)</span>'
            yAxisLabelHtml = '<b>Labor</b> <span style="color:#64748b">(hours)</span>'
            trendlines = @(@{ id = DetId 'd3-lin'; kind = 'linear'; color = '#5a189a'; dash = 'dotted'; width = 2 })
            container = HeroTitle 'Cost vs labor' 'each point is a site x valve type; linear fit overlaid'
        })
        (ChartTile 'd3-threshold' 'column' 'Avg Cost per Order by Site' @{ x = 14; y = 4; w = 10; h = 10 } @{
            axis = $dSite; measures = @(@{ measureId = $mAvgCost }); filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            valueFormat = '$#,0'
            referenceLines = @(@{ id = DetId 'd3-ref-thr'; kind = 'constant'; value = $avgCostHigh
                                  label = 'Watch threshold'; color = '#111827'; dash = 'dashed'; showLabel = $true })
            conditionalFormats = @(@{ id = DetId 'd3-cf-thr'; measureKey = 'Avg Cost per Order'; style = 'barFill'
                                      rules = @(@{ op = 'gt'; value = $avgCostHigh; color = $red }, @{ op = 'lte'; value = $avgCostHigh; color = $green }) })
        })
    )

    $d3West = @{}
    $d3West[(DetId 'tile-d3-sl-region')] = @{ table = 'public.sites'; column = 'region'; operator = 'in'; values = @('West') }
    $d3Layout = @{
        version = 1; tiles = @(); slicers = @()
        pages = @(
            @{ id = DetId 'd3-page-1'; name = 'Spend Overview'; color = '#7b2cbf'; tiles = $d3p1 }
            @{ id = DetId 'd3-page-2'; name = 'Parts & Inventory'; color = '#9d4edd'; tiles = $d3p2 }
            @{ id = DetId 'd3-page-3'; name = 'Cost Drivers'; color = '#5a189a'; tiles = $d3p3 }
        )
        parameters = @(
            @{
                id = $paramLens; name = 'Spend Lens'; kind = 'dimension'; defaultIndex = 0
                options = @(
                    @{ label = 'Region'; dimension = $dRegion }
                    @{ label = 'Vendor'; dimension = $dVendor }
                    @{ label = 'Part Category'; dimension = $dCategory }
                )
            }
        )
        bookmarks = @(
            @{ id = DetId 'd3-bm-spend'; name = 'Spend overview'
               state = @{ pageId = DetId 'd3-page-1'; slicers = @{}; filterOverrides = @{} } }
            @{ id = DetId 'd3-bm-west'; name = 'West region spend'
               state = @{ pageId = DetId 'd3-page-1'; slicers = $d3West; filterOverrides = @{} } }
            @{ id = DetId 'd3-bm-drivers'; name = 'Cost drivers'
               state = @{ pageId = DetId 'd3-page-3'; slicers = @{}; filterOverrides = @{} } }
        )
    }
    $d3 = EnsureFullDashboard 'Cost & Vendor Management' $maintModel.id $d3Layout `
        'Procurement view: parts spend through a switchable field-parameter lens, vendor ranking, inventory RAG and cost-driver analytics.'

    # =======================================================================
    # DASHBOARD 4: Workforce & Productivity (Workforce model, forest)
    # =======================================================================
    Write-Host "`nFull: Workforce & Productivity"
    $fo = '#2d6a4f'

    $d4p1 = @(
        (KpiCard 'd4-k-head' 'Headcount' 'maintenance staff' 0 0 $fo @{
            measures = @(@{ measureId = $wHead }); filters = @()
        } @{ seriesLabels = @{ 'Headcount' = 'technicians & planners' } })
        (KpiCard 'd4-k-orders' 'Work Orders' 'assigned' 6 0 $fo @{
            measures = @(@{ measureId = $wOrders }); filters = @()
        } @{ seriesLabels = @{ 'Work Orders' = 'orders assigned' } })
        (KpiCard 'd4-k-labor' 'Labor Hours' 'booked' 12 0 $fo @{
            measures = @(@{ measureId = $wLabor }); filters = @()
        } @{ seriesLabels = @{ 'Labor Hours' = 'across the team' } })
        (KpiCard 'd4-k-avghrs' 'Avg Hours / Order' 'effort per job' 18 0 $fo @{
            measures = @(@{ measureId = $wAvgHours }); filters = @()
        } @{ valueFormat = '0.0'; seriesLabels = @{ 'Avg Hours per Order' = 'hours per order' } })
        (SlicerTile 'd4-sl-region' @{ x = 0; y = 4; w = 8; h = 4 } @{
            table = 'public.sites'; column = 'region'; label = 'Home region'; variant = 'checklist'; style = @{ compact = $true } })
        (SlicerTile 'd4-sl-title' @{ x = 8; y = 4; w = 8; h = 4 } @{
            table = 'public.employees'; column = 'title'; label = 'Role'; variant = 'dropdownMulti'; style = @{ compact = $true } })
        (SlicerTile 'd4-sl-priority' @{ x = 16; y = 4; w = 8; h = 4 } @{
            table = 'public.work_orders'; column = 'priority'; label = 'Priority'; variant = 'buttons'; style = @{ compact = $true } })
        (ChartTile 'd4-workload' 'bar' 'Orders by Employee (Top 15)' @{ x = 0; y = 8; w = 12; h = 10 } @{
            axis = $dEmployee; measures = @(@{ measureId = $wOrders }); filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' }); limit = 15
        } @{
            theme = 'forest'; showDataLabels = $true
            conditionalFormats = @(@{ id = DetId 'd4-cf-wl'; measureKey = 'Work Orders'; style = 'barFill'
                                      rules = @(@{ op = 'gt'; value = $wlHigh; color = '#1b4332' }, @{ op = 'lte'; value = $wlHigh; color = '#74c69d' }) })
            container = HeroTitle 'Workload' ('dark bars carry more than the team average of {0} orders' -f $wlHigh)
        })
        (ChartTile 'd4-labor' 'line' 'Monthly Labor Hours' @{ x = 12; y = 8; w = 12; h = 10 } @{
            axis = $dMonth; measures = @(@{ measureId = $wLabor }); filters = @()
        } @{
            theme = 'forest'; dateFormat = 'monthYear'
            seriesLabels = @{ 'Labor Hours' = 'Hours booked' }
            lineStyles = @{ 'Labor Hours' = @{ dash = 'solid'; width = 3 } }
            trendlines = @(@{ id = DetId 'd4-ma'; kind = 'movingAverage'; window = 3; seriesKey = 'Labor Hours'
                              color = '#1b4332'; dash = 'dashed'; width = 2 })
            container = HeroTitle 'Labor trend' '3-month moving average overlay'
        })
    )

    $d4p2 = @(
        (KpiCard 'd4-k2-open' 'Open Orders' 'in flight' 0 0 $fo @{
            measures = @(@{ measureId = $wOpen }); filters = @()
        } @{ seriesLabels = @{ 'Open Orders' = 'open + in progress' } })
        (KpiCard 'd4-k2-closed' 'Closed Orders' 'completed' 6 0 $fo @{
            measures = @(@{ measureId = $wClosed }); filters = @()
        } @{ seriesLabels = @{ 'Closed Orders' = 'status = closed' } })
        (KpiCard 'd4-k2-cost' 'Total Cost' 'of assigned work' 12 0 $fo @{
            measures = @(@{ measureId = $wCost }); filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Total Cost' = 'assigned orders' } })
        (KpiCard 'd4-k2-labor' 'Labor Hours' 'booked' 18 0 $fo @{
            measures = @(@{ measureId = $wLabor }); filters = @()
        } @{ seriesLabels = @{ 'Labor Hours' = 'across the team' } })
        (SlicerTile 'd4-sl2-priority' @{ x = 0; y = 4; w = 12; h = 4 } @{
            table = 'public.work_orders'; column = 'priority'; label = 'Priority'; variant = 'buttons'; style = @{ compact = $true } })
        (SlicerTile 'd4-sl2-status' @{ x = 12; y = 4; w = 12; h = 4 } @{
            table = 'public.work_orders'; column = 'status'; label = 'Status'; variant = 'buttons'; style = @{ compact = $true } })
        (ChartTile 'd4-rolestack' 'stackedColumn' 'Order Status by Role' @{ x = 0; y = 8; w = 14; h = 10 } @{
            axis = $dEmpTitle; legend = $dStatus; measures = @(@{ measureId = $wOrders }); filters = @()
        } @{
            theme = 'forest'; legendInteractive = $true; legendMode = 'isolate'; legendPosition = 'bottom'
            tooltip = @{ showPercent = $true }; seriesLabels = $statusLabels
        })
        (ChartTile 'd4-smallmult' 'line' 'Monthly Orders by Region' @{ x = 14; y = 8; w = 10; h = 10 } @{
            axis = $dMonth; smallMultiples = $dRegion
            measures = @(@{ measureId = $wOrders }); filters = @()
        } @{
            theme = 'forest'; dateFormat = 'monthShort'
            smallMultiples = @{ columns = 2; sharedY = $true; showPanelTitles = $true; maxPanels = 4 }
            container = HeroTitle 'Regional cadence' 'orders per month by home region'
        })
    )

    $d4p3 = @(
        (TextTile 'd4-p3-note' @{ x = 0; y = 0; w = 24; h = 2 } '<p><b>Drillthrough target on Employee.</b> <span style="color:#64748b">Right-click a bar on Orders by Employee and choose Drill through &rarr; Assignments to see that person''s book of work.</span></p>' '#ecfdf5')
        (KpiCard 'd4-k3-orders' 'Work Orders' 'in scope' 0 2 $fo @{
            measures = @(@{ measureId = $wOrders }); filters = @()
        } @{ seriesLabels = @{ 'Work Orders' = 'orders assigned' } })
        (KpiCard 'd4-k3-open' 'Open Orders' 'in scope' 6 2 $fo @{
            measures = @(@{ measureId = $wOpen }); filters = @()
        } @{ seriesLabels = @{ 'Open Orders' = 'open + in progress' } })
        (KpiCard 'd4-k3-labor' 'Labor Hours' 'in scope' 12 2 $fo @{
            measures = @(@{ measureId = $wLabor }); filters = @()
        } @{ seriesLabels = @{ 'Labor Hours' = 'hours booked' } })
        (KpiCard 'd4-k3-head' 'Headcount' 'in scope' 18 2 $fo @{
            measures = @(@{ measureId = $wHead }); filters = @()
        } @{ seriesLabels = @{ 'Headcount' = 'people' } })
        (ChartTile 'd4-roster' 'table' 'Assignment Roster' @{ x = 0; y = 6; w = 24; h = 12 } @{
            axis = $dEmployee
            measures = @(
                @{ table = 'public.employees'; column = 'title'; aggregation = 'min'; alias = 'Role' }
                @{ table = 'public.sites'; column = 'name'; aggregation = 'min'; alias = 'Home Site' }
                @{ measureId = $wOrders }
                @{ measureId = $wOpen }
                @{ measureId = $wLabor }
                @{ measureId = $wCost }
            )
            filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 2 }; direction = 'desc' })
        } @{
            legendStyle = @{ bold = $true }
            conditionalFormats = @(@{ id = DetId 'd4-cf-databar'; measureKey = 'Work Orders'; style = 'dataBar'
                                      dataBarColor = '#2d6a4f'; rules = @() })
            table = @{ borders = 'grid'; density = 'compact'; pageSize = 25; totals = $true
                       pinned = 1; filterable = $true; stripes = $true }
        })
    )

    $d4Critical = @{}
    $d4Critical[(DetId 'tile-d4-sl2-priority')] = @{ table = 'public.work_orders'; column = 'priority'; operator = 'in'; values = @('critical') }
    $d4Layout = @{
        version = 1; tiles = @(); slicers = @()
        pages = @(
            @{ id = DetId 'd4-page-1'; name = 'Team Overview'; color = '#2d6a4f'; tiles = $d4p1 }
            @{ id = DetId 'd4-page-2'; name = 'Utilization'; color = '#40916c'; tiles = $d4p2 }
            @{ id = DetId 'd4-page-3'; name = 'Assignments'; color = '#1b4332'; tiles = $d4p3
               drillthrough = @{ enabled = $true; fields = @(@{ table = 'public.employees'; column = 'name' }) } }
        )
        bookmarks = @(
            @{ id = DetId 'd4-bm-team'; name = 'Team overview'
               state = @{ pageId = DetId 'd4-page-1'; slicers = @{}; filterOverrides = @{} } }
            @{ id = DetId 'd4-bm-crit'; name = 'Utilization: critical work'
               state = @{ pageId = DetId 'd4-page-2'; slicers = $d4Critical; filterOverrides = @{} } }
            @{ id = DetId 'd4-bm-roster'; name = 'Assignment roster'
               state = @{ pageId = DetId 'd4-page-3'; slicers = @{}; filterOverrides = @{} } }
        )
    }
    $d4 = EnsureFullDashboard 'Workforce & Productivity' $wfModel.id $d4Layout `
        'People view on the Workforce model: headcount, workload balance, utilization by role and a per-employee assignment roster.'

    # =======================================================================
    # DASHBOARD 5: Asset Reliability (Inspections model, mono)
    # =======================================================================
    Write-Host "`nFull: Asset Reliability"
    $sl = '#1f2937'

    $d5p1 = @(
        (KpiCard 'd5-k-pass' 'Pass Rate' "target &ge; $($passTarget * 100)%" 0 0 $sl @{
            measures = @(@{ measureId = $iPassRate }); filters = @()
        } @{
            valueFormat = '0.0%'; seriesLabels = @{ 'Pass Rate' = 'fleet-wide' }
            conditionalFormats = @(@{ id = DetId 'd5-cf-pass'; measureKey = 'Pass Rate'; style = 'kpi'
                                      rules = @(@{ op = 'gte'; value = $passTarget; color = $green }, @{ op = 'lt'; value = $passTarget; color = $red }) })
        })
        (KpiCard 'd5-k-count' 'Inspections' 'all time' 6 0 $sl @{
            measures = @(@{ measureId = $iInspCount }); filters = @()
        } @{ seriesLabels = @{ 'Inspection Count' = 'tests performed' } })
        (KpiCard 'd5-k-fail' 'Failures' 'result = fail' 12 0 $sl @{
            measures = @(@{ measureId = $iFailCount }); filters = @()
        } @{
            seriesLabels = @{ 'Fail Count' = 'failed tests' }
            conditionalFormats = @(@{ id = DetId 'd5-cf-fail'; measureKey = 'Fail Count'; style = 'kpi'
                                      rules = @(@{ op = 'gt'; value = $failTarget; color = $red }, @{ op = 'lte'; value = $failTarget; color = $green }) })
        })
        (KpiCard 'd5-k-parts' 'Parts Cost' 'inspection consumables' 18 0 $sl @{
            measures = @(@{ table = 'public.inspections'; column = 'parts_cost'; aggregation = 'sum'; alias = 'Parts Cost' })
            filters = @()
        } @{ valueFormat = '$#,0'; seriesLabels = @{ 'Parts Cost' = 'consumables' } })
        (SlicerTile 'd5-sl-result' @{ x = 0; y = 4; w = 8; h = 4 } @{
            table = 'public.inspections'; column = 'result'; label = 'Result'; variant = 'buttons'; style = @{ compact = $true } })
        (SlicerTile 'd5-sl-region' @{ x = 8; y = 4; w = 8; h = 4 } @{
            table = 'public.sites'; column = 'region'; label = 'Region'; variant = 'checklist'; style = @{ compact = $true } })
        (SlicerTile 'd5-sl-date' @{ x = 16; y = 4; w = 8; h = 4 } @{
            table = 'public.inspections'; column = 'inspected_on'; label = 'Inspected'; variant = 'dateRange' })
        (ChartTile 'd5-trend' 'stackedColumn' 'Monthly Results' @{ x = 0; y = 8; w = 14; h = 9 } @{
            axis = $dIMonth; legend = $dIResult; measures = @(@{ measureId = $iInspCount }); filters = @()
        } @{
            theme = 'mono'; legendInteractive = $true; legendPosition = 'bottom'; dateFormat = 'monthYear'
            tooltip = @{ showPercent = $true }; seriesLabels = $resultLabels
            colorOverrides = @{ pass = '#16a34a'; fail = '#dc2626'; adjusted = '#f59e0b' }
            container = HeroTitle 'Monthly results' 'pass / adjusted / fail composition per month'
        })
        (ChartTile 'd5-league' 'table' 'Inspector League' @{ x = 14; y = 8; w = 10; h = 9 } @{
            axis = $dTech
            measures = @(@{ measureId = $iInspCount }, @{ measureId = $iPassRate }); filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            legendStyle = @{ bold = $true }
            conditionalFormats = @(
                @{ id = DetId 'd5-cf-bar'; measureKey = 'Inspection Count'; style = 'dataBar'
                   dataBarColor = '#1f2937'; rules = @() }
                @{ id = DetId 'd5-cf-rag'; measureKey = 'Pass Rate'; style = 'cellBackground'
                   rules = @(
                       @{ op = 'lt'; value = $prLow; color = '#fecaca' }
                       @{ op = 'lt'; value = $prHigh; color = '#fde68a' }
                       @{ op = 'gte'; value = $prHigh; color = '#bbf7d0' }
                   ) }
            )
            table = @{ density = 'compact'; stripes = $true }
        })
    )

    $d5p2 = @(
        (KpiCard 'd5-k2-valves' 'Valve Fleet' 'relief valves' 0 0 $sl @{
            measures = @(@{ table = 'public.valves'; column = 'id'; aggregation = 'countDistinct'; alias = 'Valves' })
            filters = @()
        } @{ seriesLabels = @{ 'Valves' = 'in service' } })
        (KpiCard 'd5-k2-psi' 'Avg Set Pressure' 'psi' 6 0 $sl @{
            measures = @(@{ table = 'public.valves'; column = 'set_pressure_psi'; aggregation = 'avg'; alias = 'Avg Set Pressure' })
            filters = @()
        } @{ valueFormat = '#,0'; seriesLabels = @{ 'Avg Set Pressure' = 'across the fleet' } })
        (KpiCard 'd5-k2-count' 'Inspections' 'all time' 12 0 $sl @{
            measures = @(@{ measureId = $iInspCount }); filters = @()
        } @{ seriesLabels = @{ 'Inspection Count' = 'tests performed' } })
        (KpiCard 'd5-k2-pass' 'Pass Rate' 'fleet-wide' 18 0 $sl @{
            measures = @(@{ measureId = $iPassRate }); filters = @()
        } @{ valueFormat = '0.0%'; seriesLabels = @{ 'Pass Rate' = 'share passing' } })
        (ChartTile 'd5-fleet' 'stackedColumn' 'Fleet by Site & Type' @{ x = 0; y = 4; w = 8; h = 10 } @{
            axis = $dSite; legend = $dValveType
            measures = @(@{ table = 'public.valves'; column = 'id'; aggregation = 'countDistinct'; alias = 'Valves' })
            filters = @()
        } @{
            theme = 'mono'; legendPosition = 'bottom'; tooltip = @{ showPercent = $true }
        })
        (ChartTile 'd5-scatter' 'scatter' 'Set Pressure vs Inspections' @{ x = 8; y = 4; w = 8; h = 10 } @{
            axis = @{ table = 'public.valves'; column = 'tag' }; legend = $dValveType
            measures = @(
                @{ table = 'public.valves'; column = 'set_pressure_psi'; aggregation = 'avg'; alias = 'Set Pressure (psi)' }
                @{ measureId = $iInspCount }
            )
            filters = @()
        } @{
            theme = 'mono'
            container = HeroTitle 'Pressure vs attention' 'each point is a valve: x set pressure, y inspections'
        })
        (ChartTile 'd5-age' 'column' 'Valves by Install Year (drill: Month)' @{ x = 16; y = 4; w = 8; h = 10 } @{
            axis = $dInstallYear; drillLevels = @($dInstallMonth)
            measures = @(@{ table = 'public.valves'; column = 'id'; aggregation = 'countDistinct'; alias = 'Valves' })
            filters = @()
        } @{
            theme = 'mono'; colorByCategory = $true; showDataLabels = $true; dateFormat = 'year'
        })
    )

    $d5p3 = @(
        (TextTile 'd5-p3-note' @{ x = 0; y = 0; w = 24; h = 2 } '<p><b>Drillthrough target on Inspector.</b> <span style="color:#64748b">Right-click a row in the Inspector League and choose Drill through &rarr; Findings to audit that inspector''s recent work.</span></p>' '#f8fafc')
        (KpiCard 'd5-k3-count' 'Inspections' 'in scope' 0 2 $sl @{
            measures = @(@{ measureId = $iInspCount }); filters = @()
        } @{ seriesLabels = @{ 'Inspection Count' = 'tests performed' } })
        (KpiCard 'd5-k3-fail' 'Failures' 'in scope' 6 2 $sl @{
            measures = @(@{ measureId = $iFailCount }); filters = @()
        } @{ seriesLabels = @{ 'Fail Count' = 'failed tests' } })
        (KpiCard 'd5-k3-pass' 'Pass Rate' 'in scope' 12 2 $sl @{
            measures = @(@{ measureId = $iPassRate }); filters = @()
        } @{ valueFormat = '0.0%'; seriesLabels = @{ 'Pass Rate' = 'share passing' } })
        (KpiCard 'd5-k3-labor' 'Labor Hours' 'inspection effort' 18 2 $sl @{
            measures = @(@{ measureId = $iLaborHours }); filters = @()
        } @{ seriesLabels = @{ 'Total Labor Hours' = 'hours booked' } })
        (SlicerTile 'd5-sl3-date' @{ x = 0; y = 6; w = 12; h = 4 } @{
            table = 'public.inspections'; column = 'inspected_on'; label = 'Inspected'; variant = 'dateRange' })
        (SlicerTile 'd5-sl3-tech' @{ x = 12; y = 6; w = 12; h = 4 } @{
            table = 'public.technicians'; column = 'name'; label = 'Inspector'; variant = 'dropdownMulti'; style = @{ compact = $true } })
        (ChartTile 'd5-log' 'table' 'Inspection Log' @{ x = 0; y = 10; w = 24; h = 12 } @{
            axis = @{ table = 'public.inspections'; column = 'id' }
            measures = @(
                @{ table = 'public.inspections'; column = 'inspected_on'; aggregation = 'min'; alias = 'Date' }
                @{ table = 'public.technicians'; column = 'name'; aggregation = 'min'; alias = 'Inspector' }
                @{ table = 'public.sites'; column = 'name'; aggregation = 'min'; alias = 'Site' }
                @{ table = 'public.valves'; column = 'tag'; aggregation = 'min'; alias = 'Valve' }
                @{ table = 'public.inspections'; column = 'result'; aggregation = 'min'; alias = 'Result' }
                @{ table = 'public.inspections'; column = 'parts_cost'; aggregation = 'sum'; alias = 'Parts Cost' }
            )
            filters = @()
            sort = @(@{ target = @{ kind = 'measure'; index = 0 }; direction = 'desc' })
        } @{
            legendStyle = @{ bold = $true }
            table = @{ borders = 'grid'; density = 'compact'; pageSize = 50; totals = $true
                       pinned = 1; filterable = $true; stripes = $true }
        })
    )

    $d5Fails = @{}
    $d5Fails[(DetId 'tile-d5-sl-result')] = @{ table = 'public.inspections'; column = 'result'; operator = 'in'; values = @('fail') }
    $d5Layout = @{
        version = 1; tiles = @(); slicers = @()
        pages = @(
            @{ id = DetId 'd5-page-1'; name = 'Inspection Health'; color = '#1f2937'; tiles = $d5p1 }
            @{ id = DetId 'd5-page-2'; name = 'Valve Fleet'; color = '#4b5563'; tiles = $d5p2 }
            @{ id = DetId 'd5-page-3'; name = 'Findings'; color = '#6b7280'; tiles = $d5p3
               drillthrough = @{ enabled = $true; fields = @(@{ table = 'public.technicians'; column = 'name' }) } }
        )
        bookmarks = @(
            @{ id = DetId 'd5-bm-health'; name = 'Inspection health'
               state = @{ pageId = DetId 'd5-page-1'; slicers = @{}; filterOverrides = @{} } }
            @{ id = DetId 'd5-bm-fails'; name = 'Failures only'
               state = @{ pageId = DetId 'd5-page-1'; slicers = $d5Fails; filterOverrides = @{} } }
            @{ id = DetId 'd5-bm-fleet'; name = 'Valve fleet'
               state = @{ pageId = DetId 'd5-page-2'; slicers = @{}; filterOverrides = @{} } }
        )
    }
    $d5 = EnsureFullDashboard 'Asset Reliability' $inspModel.id $d5Layout `
        'Reliability engineering view of the valve fleet: pass-rate health, fleet composition and age, and an auditable findings log.'

    # =======================================================================
    # VERIFICATION: GET each dashboard back, check shape, then run EVERY chart
    # tile's wire query (toWireSpec order [axis, legend?, smallMultiples?];
    # paramBindings resolved to the parameter's default option).
    # =======================================================================
    $fullDashboards = @(
        @{ Name = 'Executive Overview'; ModelId = $maintModel.id }
        @{ Name = 'Operations Command Center'; ModelId = $maintModel.id }
        @{ Name = 'Cost & Vendor Management'; ModelId = $maintModel.id }
        @{ Name = 'Workforce & Productivity'; ModelId = $wfModel.id }
        @{ Name = 'Asset Reliability'; ModelId = $inspModel.id }
    )

    function VerifyFullDashboard([string]$Name, [int]$ExpectedModelId) {
        $doc = GetDashboardByName $Name
        $pages = @($doc.layout.pages)
        Write-Host "`nVerify: $Name (id $($doc.id))"
        Assert ($doc.modelId -eq $ExpectedModelId) "$($Name): bound to the expected model"
        Assert ($doc.isShared -and $doc.ownerIsMe) "$($Name): shared and owned by carol"
        Assert ($pages.Count -ge 3) "$($Name): >= 3 pages (got $($pages.Count))"
        Assert (((@($pages | ForEach-Object { $_.color })) | Select-Object -Unique).Count -eq $pages.Count) "$($Name): distinct page tab colors"
        Assert (@($doc.layout.bookmarks).Count -ge 2) "$($Name): >= 2 bookmarks"
        $parameters = @($doc.layout.parameters)
        foreach ($page in $pages) {
            $tiles = @($page.tiles)
            Assert ($tiles.Count -ge 6) "$($Name) / $($page.name): >= 6 tiles (got $($tiles.Count))"
            foreach ($tile in $tiles) {
                if ($tile.kind -ne 'chart' -or -not $tile.chart) { continue }
                $q = $tile.chart.query
                $axis = $q.axis
                $measures = @($q.measures)
                if ($q.paramBindings) {
                    if ($q.paramBindings.axis) {
                        $p = $parameters | Where-Object { $_.id -eq $q.paramBindings.axis } | Select-Object -First 1
                        if ($p) {
                            $idx = if ($null -ne $p.defaultIndex) { [int]$p.defaultIndex } else { 0 }
                            $axis = $p.options[$idx].dimension
                        }
                    }
                    if ($q.paramBindings.measures) {
                        $p = $parameters | Where-Object { $_.id -eq $q.paramBindings.measures } | Select-Object -First 1
                        if ($p) {
                            $idx = if ($null -ne $p.defaultIndex) { [int]$p.defaultIndex } else { 0 }
                            $measures = @($p.options[$idx].measure)
                        }
                    }
                }
                $dims = @()
                if ($axis) { $dims += $axis }
                if ($q.legend) { $dims += $q.legend }
                if ($q.smallMultiples) { $dims += $q.smallMultiples }
                $spec = [ordered]@{
                    modelId = $doc.modelId
                    dimensions = $dims
                    measures = $measures
                    filters = @(); sort = @()
                }
                if ($q.filters) { $spec.filters = @($q.filters) }
                if ($q.sort) { $spec.sort = @($q.sort) }
                if ($null -ne $q.limit) { $spec.limit = $q.limit }
                $label = "$($page.name) / $($tile.chart.title)"
                try {
                    $r = PostQueryBody ($spec | ConvertTo-Json -Depth 12)
                    $n = @($r.rows).Count
                    if ($n -ge 1) {
                        Write-Host "  $([char]0x2713) $label ($n rows)" -ForegroundColor Green
                    } else {
                        Write-Host "  $([char]0x2717) $label (0 rows)" -ForegroundColor Red
                        $script:failures++
                    }
                } catch {
                    $detailMsg = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
                    Write-Host "  $([char]0x2717) $label ($detailMsg)" -ForegroundColor Red
                    $script:failures++
                }
            }
        }
        $doc
    }

    Write-Host "`nFull verification: persisted docs + wire queries"
    $verified = @{}
    foreach ($fd in $fullDashboards) { $verified[$fd.Name] = VerifyFullDashboard $fd.Name $fd.ModelId }

    # Feature spot checks on the persisted docs.
    Write-Host "`nFull verification: feature spot checks"
    $vd1 = $verified['Executive Overview']; $vd2 = $verified['Operations Command Center']
    $vd3 = $verified['Cost & Vendor Management']; $vd4 = $verified['Workforce & Productivity']
    $vd5 = $verified['Asset Reliability']
    $d1Hero = @(@($vd1.layout.pages)[0].tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-d1-hero') } | Select-Object -First 1
    Assert (@($d1Hero.chart.format.secondaryAxisKeys).Count -eq 1) 'D1 hero: secondaryAxisKeys dual-axis persisted'
    Assert (@($vd1.layout.pages | Where-Object { $_.mobileLayout }).Count -eq 3) 'D1: mobileLayout on all 3 pages'
    Assert (@(@($vd1.layout.pages)[2].drillthrough.fields).Count -eq 1) 'D1: Regional Deep Dive drillthrough target'
    $d2Window = @(@($vd2.layout.pages)[0].tiles) | Where-Object { $_.id -eq (DetId 'tile-d2-sl-window') } | Select-Object -First 1
    Assert ($d2Window.slicer.variant -eq 'relativeDate' -and $d2Window.slicer.preset -eq 'last90d') 'D2: relativeDate slicer defaults to Last 90 days'
    $d2Spot = @(@($vd2.layout.pages)[0].tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-d2-priostack') } | Select-Object -First 1
    Assert ($d2Spot.chart.format.legendMode -eq 'crossFilter') 'D2: legendMode crossFilter persisted'
    $d2Iso = @(@($vd2.layout.pages)[1].tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-d2-statusmix') } | Select-Object -First 1
    Assert ($d2Iso.chart.format.legendMode -eq 'isolate') 'D2: legendMode isolate persisted'
    Assert (@(@($vd2.layout.pages)[2].drillthrough.fields).Count -eq 2) 'D2: Order Details drillthrough on site + status'
    Assert (@($vd3.layout.parameters).Count -eq 1) 'D3: field parameter persisted'
    $d3Lens = @(@($vd3.layout.pages)[0].tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-d3-lens') } | Select-Object -First 1
    Assert ($d3Lens.chart.query.paramBindings.axis -eq $paramLens) 'D3: chart bound to the Spend Lens parameter'
    $d3Scatter = @(@($vd3.layout.pages)[2].tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-d3-scatter') } | Select-Object -First 1
    Assert ([bool]$d3Scatter.chart.format.xAxisLabelHtml -and [bool]$d3Scatter.chart.format.yAxisLabelHtml) 'D3: rich-HTML axis titles on the scatter'
    $d4Sm = @(@($vd4.layout.pages)[1].tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-d4-smallmult') } | Select-Object -First 1
    Assert ($d4Sm.chart.query.smallMultiples.column -eq 'region') 'D4: small multiples split persisted'
    $d5Age = @(@($vd5.layout.pages)[1].tiles) | Where-Object { $_.chart.id -eq (DetId 'chart-d5-age') } | Select-Object -First 1
    Assert (@($d5Age.chart.query.drillLevels).Count -eq 1) 'D5: install-date year->month drill persisted'

    # --- summary ---
    Write-Host ''
    Write-Host ('-' * 60)
    foreach ($fd in $fullDashboards) {
        $doc = $verified[$fd.Name]
        $counts = (@($doc.layout.pages) | ForEach-Object { "$($_.name)=$(@($_.tiles).Count)" }) -join ', '
        Write-Host ("Full: {0} (id {1}) - {2}" -f $fd.Name, $doc.id, $counts)
    }
    if ($failures -gt 0) {
        Write-Host "`n$failures full-phase check(s) FAILED" -ForegroundColor Red
        exit 1
    }
    Write-Host "`nAll full-phase checks passed." -ForegroundColor Green
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
