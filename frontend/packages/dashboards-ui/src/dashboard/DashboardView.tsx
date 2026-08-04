import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, LayoutDashboard, Plus, RefreshCw, X } from 'lucide-react';
import {
  emptyChart,
  isChartTile,
  isSlicerTile,
  newId,
  type ChartSpec,
  type FilterClause,
} from '@recon/dashboards-core';
import { ChartBuilder } from '../chart-builder/ChartBuilder';
import { ChartTile } from '../chart/ChartTile';
import type { ChartDatumClickInfo } from '../chart/ChartRenderer';
import { useDashboardState, useModelState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSpinner } from '../primitives';
import { AddSlicerDialog } from './AddSlicerDialog';
import { DashboardGrid, type DashboardGridItem } from './DashboardGrid';
import { DashboardPrintView } from './DashboardPrintView';
import { DashboardToolbar } from './DashboardToolbar';
import { PrintConfigDialog, type PrintOptions } from './PrintConfigDialog';
import { SlicerTile } from './SlicerTile';
import { TileFrame } from './TileFrame';

export interface DashboardViewProps {
  dashboardId: number;
  /** Hides all editing affordances (host capability-driven). */
  readonly?: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const NO_FILTERS: FilterClause[] = [];

/** The embeddable entry point: toolbar + tile grid, view/edit modes. */
export function DashboardView({ dashboardId, readonly = false }: DashboardViewProps) {
  const runtime = useRuntime();

  const current = useDashboardState((state) => state.current);
  const mode = useDashboardState((state) => state.mode);
  const dirty = useDashboardState((state) => state.dirty);
  const saveStatus = useDashboardState((state) => state.saveStatus);
  const storeError = useDashboardState((state) => state.error);
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const crossFilter = useDashboardState((state) => state.crossFilter);

  const openModel = useModelState((state) => state.current);
  const catalog = useModelState((state) => state.catalog);
  const catalogStatus = useModelState((state) => state.catalogStatus);

  const [openError, setOpenError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [builder, setBuilder] = useState<{ tileId: string | null; spec: ChartSpec } | null>(null);
  const [addSlicerOpen, setAddSlicerOpen] = useState(false);
  const [printConfigOpen, setPrintConfigOpen] = useState(false);
  /** Non-null while the print preview overlay is mounted. */
  const [printOptions, setPrintOptions] = useState<PrintOptions | null>(null);

  const openDashboard = useCallback(() => {
    setOpenError(null);
    // A freshly created dashboard is already open (in edit mode); keep it.
    if (runtime.dashboards.store.getState().current?.id === dashboardId) return;
    runtime.dashboards.open(dashboardId).catch((error: unknown) => setOpenError(messageOf(error)));
  }, [runtime, dashboardId]);

  useEffect(() => {
    openDashboard();
    return () => {
      // Never close() an active edit session: StrictMode remounts this effect
      // (mount → cleanup → mount), and an unconditional close() here wiped the
      // 'edit' state a fresh create() had just set — the remount's open() then
      // re-fetched the dashboard into view mode. View-mode sessions still close
      // so a later visit re-fetches fresh data.
      if (runtime.dashboards.store.getState().mode !== 'edit') runtime.dashboards.close();
    };
  }, [runtime, openDashboard]);

  const modelId = current?.id === dashboardId ? current.modelId : null;

  const loadModel = useCallback(() => {
    if (modelId === null) return;
    setModelError(null);
    if (runtime.models.store.getState().current?.id === modelId) return;
    runtime.models.openModel(modelId).catch((error: unknown) => setModelError(messageOf(error)));
  }, [runtime, modelId]);

  useEffect(() => {
    loadModel();
  }, [loadModel]);

  const tiles = current?.id === dashboardId ? current.layout.tiles : [];
  const editable = mode === 'edit' && !readonly;

  // Per-chart slicer + cross-filter clauses. The memo depends on the
  // SUBSCRIBED tiles + slicerValues + crossFilter slices, so any change
  // (value, targets, add/remove, datum click) re-renders this component and
  // recomputes — filtersForTile reads the exact same store state the
  // subscriptions delivered, so it can never be stale. ChartTile keys its
  // fetch effect on the cache-key string, so the fresh (but often deep-equal)
  // arrays never re-trigger requests.
  const filtersByTile = useMemo(() => {
    const map = new Map<string, FilterClause[]>();
    for (const tile of tiles) {
      if (isSlicerTile(tile)) continue;
      map.set(tile.id, runtime.dashboards.filtersForTile(tile.id));
    }
    return map;
  }, [runtime, tiles, slicerValues, crossFilter]);

  // Cross-filter: the renderer reports raw value + label; THIS layer knows the
  // tile's query, so it maps the click onto the chart's category dimension —
  // axis for cartesian/table charts, legend for pie/donut (RADIAL wells keep
  // the slice dimension there; hand-built specs may still carry it in axis,
  // hence the fallback). Null datum -> isNull clause. Same-datum clicks toggle
  // off inside the store.
  const handleDatumClick = useCallback(
    (tileId: string, chart: ChartSpec, info: ChartDatumClickInfo) => {
      const dimension =
        chart.type === 'pie' || chart.type === 'donut'
          ? (chart.query.legend ?? chart.query.axis ?? null)
          : (chart.query.axis ?? null);
      if (!dimension) return;
      const clause: FilterClause =
        info.value === null
          ? { table: dimension.table, column: dimension.column, operator: 'isNull', values: [] }
          : { table: dimension.table, column: dimension.column, operator: 'eq', values: [info.value] };
      runtime.dashboards.setCrossFilter(
        tileId,
        clause,
        `${dimension.column}: ${info.label}`,
        info.label,
      );
    },
    [runtime],
  );

  /** Chart tiles by title for the slicer config menus' "Applies to" list. */
  const chartTileInfos = useMemo(
    () => tiles.filter(isChartTile).map((tile) => ({ id: tile.id, title: tile.chart.title })),
    [tiles],
  );

  const gridItems = useMemo<DashboardGridItem[]>(
    () => tiles.map((tile) => ({ id: tile.id, ...tile.layout })),
    [tiles],
  );

  // Auto-refresh: invalidate the shared query cache, then bump a token that
  // keys ChartTile — remounting refetches (brief skeleton) with fresh data.
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshTiles = useCallback(() => {
    runtime.queries.invalidateAll();
    setRefreshToken((token) => token + 1);
  }, [runtime]);

  const refreshSeconds = current?.id === dashboardId ? (current.layout.refreshSeconds ?? null) : null;

  useEffect(() => {
    // Auto-refresh is suspended while the print preview is open: a mid-print
    // cache invalidation would flash every tile back to a skeleton.
    if (mode !== 'view' || printOptions !== null || refreshSeconds == null || refreshSeconds <= 0)
      return;
    const timer = setInterval(refreshTiles, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [mode, refreshSeconds, refreshTiles, printOptions]);

  const handleLayoutChange = useCallback(
    (items: DashboardGridItem[]) => {
      const state = runtime.dashboards.store.getState();
      if (state.mode !== 'edit' || !state.current) return;
      const layoutById = new Map(state.current.layout.tiles.map((tile) => [tile.id, tile.layout]));
      const changed = items.some((item) => {
        const layout = layoutById.get(item.id);
        return (
          !layout ||
          layout.x !== item.x ||
          layout.y !== item.y ||
          layout.w !== item.w ||
          layout.h !== item.h
        );
      });
      if (changed) runtime.dashboards.applyLayout(items);
    },
    [runtime],
  );

  const openAddChart = () => setBuilder({ tileId: null, spec: emptyChart(newId()) });

  const handleBuilderSave = (spec: ChartSpec) => {
    if (!builder) return;
    if (builder.tileId === null) runtime.dashboards.addTile(spec);
    else runtime.dashboards.updateChart(builder.tileId, spec);
    setBuilder(null);
  };

  if (!current || current.id !== dashboardId) {
    if (openError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-rcd-bg p-6 text-center">
          <AlertTriangle size={26} className="text-[var(--rcd-status-warn)]" />
          <p className="max-w-md text-sm text-rcd-text-2">{openError}</p>
          <RcdButton onClick={openDashboard}>
            <RefreshCw size={14} />
            Retry
          </RcdButton>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center bg-rcd-bg">
        <RcdSpinner label="Loading dashboard…" />
      </div>
    );
  }

  const renderTile = (id: string) => {
    const tile = tiles.find((t) => t.id === id);
    if (!tile) return null;

    if (isSlicerTile(tile)) {
      return (
        <SlicerTile
          tileId={tile.id}
          spec={tile.slicer}
          modelId={modelId}
          editable={editable}
          chartTiles={chartTileInfos}
        />
      );
    }

    if (!isChartTile(tile)) return null;
    const chart = tile.chart;
    return (
      <TileFrame
        title={chart.title}
        editable={editable}
        onEdit={() => setBuilder({ tileId: tile.id, spec: chart })}
        onDuplicate={() => runtime.dashboards.duplicateTile(tile.id)}
        onDelete={() => runtime.dashboards.removeTile(tile.id)}
      >
        {modelId === null ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-rcd-muted">
            No model attached to this dashboard.
          </div>
        ) : (
          <ChartTile
            key={refreshToken}
            spec={chart}
            modelId={modelId}
            filters={filtersByTile.get(tile.id) ?? NO_FILTERS}
            onDatumClick={(info) => handleDatumClick(tile.id, chart, info)}
            activeCategory={
              crossFilter && crossFilter.sourceTileId === tile.id
                ? { label: crossFilter.categoryLabel }
                : null
            }
          />
        )}
      </TileFrame>
    );
  };

  const builderCatalog =
    catalogStatus === 'ok' && catalog && openModel && catalog.connection === openModel.dataSourceName
      ? catalog
      : null;

  const builderBody = (() => {
    if (!builder) return null;
    if (modelId === null) {
      return (
        <p className="p-4 text-sm text-rcd-text-2">
          This dashboard has no model attached. Attach a model to build charts.
        </p>
      );
    }
    if (modelError) {
      return (
        <div className="flex flex-col items-center gap-3 p-6 text-center">
          <AlertTriangle size={22} className="text-[var(--rcd-status-warn)]" />
          <p className="max-w-md text-sm text-rcd-text-2">{modelError}</p>
          <RcdButton onClick={loadModel}>
            <RefreshCw size={14} />
            Retry
          </RcdButton>
        </div>
      );
    }
    if (!openModel || openModel.id !== modelId) {
      return (
        <div className="flex h-40 items-center justify-center">
          <RcdSpinner label="Loading model…" />
        </div>
      );
    }
    return (
      <ChartBuilder
        modelId={modelId}
        model={openModel.definition}
        catalog={builderCatalog}
        initial={builder.spec}
        onSave={handleBuilderSave}
        onCancel={() => setBuilder(null)}
      />
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col bg-rcd-bg">
      <DashboardToolbar
        name={current.name}
        isShared={current.isShared}
        mode={mode}
        dirty={dirty}
        saving={saveStatus === 'loading'}
        error={saveStatus === 'error' ? storeError : null}
        readonly={readonly}
        onEnterEdit={() => runtime.dashboards.enterEdit()}
        onAddChart={openAddChart}
        onAddSlicer={() => setAddSlicerOpen(true)}
        addSlicerDisabled={modelId === null}
        onSave={() => void runtime.dashboards.save()}
        onDiscard={() => runtime.dashboards.discardEdits()}
        refreshSeconds={refreshSeconds}
        onChangeRefreshSeconds={(seconds) => runtime.dashboards.setRefreshSeconds(seconds)}
        onRefresh={refreshTiles}
        onExport={() => setPrintConfigOpen(true)}
      />

      <div className="relative min-h-0 flex-1">
        {/* Cross-filter chip: floats under the toolbar in BOTH modes. */}
        {crossFilter && (
          <div className="absolute left-1/2 top-2 z-20 flex max-w-[85%] -translate-x-1/2 items-center gap-1.5 rounded-full border border-rcd-border bg-rcd-surface py-1 pl-3 pr-1 text-xs text-rcd-text shadow-md">
            <span className="truncate">
              Filtered by <span className="font-medium">{crossFilter.label}</span>
            </span>
            <button
              type="button"
              aria-label="Clear cross-filter"
              onClick={() => runtime.dashboards.clearCrossFilter()}
              className="shrink-0 rounded-full p-0.5 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <div className="h-full overflow-auto p-3">
          {tiles.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <LayoutDashboard size={32} className="text-rcd-muted" />
              {editable ? (
                <>
                  <p className="text-sm text-rcd-text-2">Nothing here yet.</p>
                  <RcdButton variant="primary" onClick={openAddChart}>
                    <Plus size={14} />
                    Add your first chart
                  </RcdButton>
                </>
              ) : (
                <p className="text-sm text-rcd-muted">
                  This dashboard has no charts yet.
                  {!readonly && ' Click Edit to add one.'}
                </p>
              )}
            </div>
          ) : (
            <DashboardGrid
              items={gridItems}
              editable={editable}
              onLayoutChange={handleLayoutChange}
              renderItem={renderTile}
              draggableHandle=".rcd-tile-drag-handle"
            />
          )}
        </div>
      </div>

      <RcdDialog
        title={builder?.tileId ? 'Edit chart' : 'Add chart'}
        open={builder !== null}
        onClose={() => setBuilder(null)}
        wide
        draggable
        resizable
      >
        {builderBody}
      </RcdDialog>

      {modelId !== null && (
        <AddSlicerDialog
          open={addSlicerOpen}
          modelId={modelId}
          onClose={() => setAddSlicerOpen(false)}
        />
      )}

      <PrintConfigDialog
        open={printConfigOpen}
        onClose={() => setPrintConfigOpen(false)}
        onConfirm={(options) => {
          setPrintConfigOpen(false);
          setPrintOptions(options);
        }}
      />

      {printOptions !== null && (
        <DashboardPrintView
          title={current.name}
          tiles={tiles}
          modelId={modelId}
          filtersByTile={filtersByTile}
          options={printOptions}
          onClose={() => setPrintOptions(null)}
        />
      )}
    </div>
  );
}
