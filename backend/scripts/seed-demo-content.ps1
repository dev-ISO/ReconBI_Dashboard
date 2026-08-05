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
param([string]$BaseUrl = 'http://localhost:5040', [switch]$Restyle, [switch]$Showcase)

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
