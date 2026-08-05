import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, Filter, LayoutDashboard, Plus, RefreshCw, X, Zap } from 'lucide-react';
import {
  emptyChart,
  filterCardIsActive,
  isChartTile,
  isImageTile,
  isRunnable,
  isSlicerTile,
  isTextTile,
  newId,
  slicerPresetOf,
  toWireSpec,
  type AlertFiring,
  type ChartPointEvent,
  type ChartSpec,
  type DashboardTile,
  type FilterClause,
} from '@recon/dashboards-core';
import { ChartBuilder, type ChartBuilderProps } from '../chart-builder/ChartBuilder';
import type { ChartLegendSelectEvent } from '../chart/ChartTile';
import type { ChartDatumClickInfo } from '../chart/ChartRenderer';
import { useDashboardState, useModelState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSpinner } from '../primitives';
import { AddSlicerDialog } from './AddSlicerDialog';
import { AlertDialog, type AlertSource } from './AlertDialog';
import { ChartContextMenu } from './ChartContextMenu';
import { DashboardChartTile, type TileEffectiveState } from './DashboardChartTile';
import { DashboardGrid, type DashboardGridItem } from './DashboardGrid';
import { DashboardPrintView } from './DashboardPrintView';
import { DashboardToolbar } from './DashboardToolbar';
import { FieldParameterDialog } from './FieldParameterDialog';
import { FiltersPane } from './FiltersPane';
import { ImageTile } from './ImageTile';
import { ImageTileDialog } from './ImageTileDialog';
import { MOBILE_BREAKPOINT, MobileLayoutEditor, MobileStack } from './MobileLayout';
import { PageTabs } from './PageTabs';
import {
  PointContextMenu,
  type DrillthroughTarget,
  type PointDrillActions,
} from './PointContextMenu';
import { PrintConfigDialog, type PrintOptions } from './PrintConfigDialog';
import { relativePresetClause } from './relativeDate';
import { SeeDataDialog, type SeeDataRequest } from './SeeDataDialog';
import { SlicerTile } from './SlicerTile';
import { SubscriptionsDialog } from './SubscriptionsDialog';
import { TextTile } from './TextTile';

/**
 * The chart builder's field-parameter prop, typed locally so this compiles
 * regardless of when the builder lands it (same doctrine as ChartTile's
 * renderer contract; once ChartBuilderProps carries `parameters` the
 * intersection is a no-op).
 */
const ChartBuilderWithParams = ChartBuilder as ComponentType<
  ChartBuilderProps & {
    parameters?: { id: string; name: string; kind: 'dimension' | 'measure' }[];
  }
>;

export interface DashboardViewProps {
  dashboardId: number;
  /** Hides all editing affordances (host capability-driven). */
  readonly?: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The ONE transient-chip style (cross-filter / drillthrough / notices): pill
 * of fixed height with a muted icon, truncating label, and a dismiss ✕ —
 * identical radius/colors/shadow across every chip bar. `leading` prepends an
 * extra action (the drillthrough "Back" button) inside the pill.
 */
function TransientChip({
  icon,
  leading,
  dismissLabel,
  onDismiss,
  children,
}: {
  icon: ReactNode;
  leading?: ReactNode;
  dismissLabel: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-full border border-rcd-border bg-rcd-surface pr-1 text-xs text-rcd-text shadow-md ${
        leading ? 'pl-1' : 'pl-2.5'
      }`}
    >
      {leading}
      <span aria-hidden className="shrink-0 text-rcd-muted">
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
      <button
        type="button"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={onDismiss}
        className="shrink-0 rounded-full p-1 text-rcd-muted transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** Filesystem-safe download name from a chart title. */
const csvFileName = (title: string): string => {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned === '' ? 'chart' : cleaned;
};

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
  const drillthrough = useDashboardState((state) => state.drillthrough);
  const activePageId = useDashboardState((state) => state.activePageId);
  const selectedTileId = useDashboardState((state) => state.selectedTileId);
  const filterCards = useDashboardState((state) => state.current?.layout.filterCards ?? null);
  const filterCardOverrides = useDashboardState((state) => state.filterCardOverrides);
  const bookmarks = useDashboardState((state) => state.current?.layout.bookmarks ?? null);
  const lastAppliedBookmarkId = useDashboardState((state) => state.lastAppliedBookmarkId);

  const openModel = useModelState((state) => state.current);
  const catalog = useModelState((state) => state.catalog);
  const catalogStatus = useModelState((state) => state.catalogStatus);

  const [openError, setOpenError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [builder, setBuilder] = useState<{
    tileId: string | null;
    spec: ChartSpec;
    initialTab?: 'fields' | 'format';
  } | null>(null);
  /** Right-click context card on a CHART tile (edit mode only). */
  const [chartMenu, setChartMenu] = useState<{
    tileId: string;
    position: { x: number; y: number };
  } | null>(null);
  /** Point right-click menu (view mode): drillthrough targets + CSV export. */
  const [pointMenu, setPointMenu] = useState<{
    tileId: string;
    /** EFFECTIVE (drill-derived) chart at the moment of the click. */
    chart: ChartSpec;
    event: ChartPointEvent;
  } | null>(null);
  /**
   * Chart-LEVEL right-click menu (view mode): opens when the right-click hit
   * no chart point (KPIs, empty plot areas) so every tile has a menu.
   */
  const [tileMenu, setTileMenu] = useState<{
    tileId: string;
    chart: ChartSpec;
    position: { x: number; y: number };
  } | null>(null);
  /** "See data" dialog: aggregated result or a point's underlying records. */
  const [seeData, setSeeData] = useState<SeeDataRequest | null>(null);
  /** Transient toolbar-area notice (export failures / truncation). */
  const [notice, setNotice] = useState<string | null>(null);
  const [addSlicerOpen, setAddSlicerOpen] = useState(false);
  const [addImageOpen, setAddImageOpen] = useState(false);
  const [printConfigOpen, setPrintConfigOpen] = useState(false);
  /** Non-null while the print preview overlay is mounted. */
  const [printOptions, setPrintOptions] = useState<PrintOptions | null>(null);
  /** Filters pane visibility (collapsed by default, both modes). */
  const [filtersPaneOpen, setFiltersPaneOpen] = useState(false);
  /** Field-parameter manage dialog (edit mode, Add ▾ > Field parameter…). */
  const [paramsOpen, setParamsOpen] = useState(false);
  /** Subscriptions dialog (view mode, ⋯ > Subscribe…). */
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  /** Alert dialog + the chart context it was invoked from. */
  const [alertSource, setAlertSource] = useState<AlertSource | null>(null);
  /** Recent alert firings (bell); null until the first successful poll. */
  const [alertFirings, setAlertFirings] = useState<AlertFiring[] | null>(null);
  /** Edit mode: the canvas shows the phone-layout editor instead of the grid. */
  const [mobileEditOpen, setMobileEditOpen] = useState(false);

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

  // Pages are guaranteed non-empty after the store's open migration; the grid
  // shows the ACTIVE page's tiles only.
  const pages = current?.id === dashboardId ? (current.layout.pages ?? []) : [];
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0] ?? null;
  const tiles = activePage?.tiles ?? [];
  const editable = mode === 'edit' && !readonly;

  // Per-chart slicer + cross-filter + filter-card clauses. The memo depends on
  // the SUBSCRIBED tiles + slicerValues + crossFilter + filterCards (+ their
  // view-mode overrides) + activePageId slices, so any change (value, targets,
  // add/remove, datum click, card edit/toggle, page switch) re-renders this
  // component and recomputes — filtersForTile reads the exact same store state
  // the subscriptions delivered, so it can never be stale. ChartTile keys its
  // fetch effect on the cache-key string, so the fresh (but often deep-equal)
  // arrays never re-trigger requests.
  const filtersByTile = useMemo(() => {
    const map = new Map<string, FilterClause[]>();
    for (const tile of tiles) {
      // Only chart tiles consume filters (text/image/slicer tiles ignore them).
      if (!isChartTile(tile)) continue;
      map.set(tile.id, runtime.dashboards.filtersForTile(tile.id));
    }
    return map;
  }, [
    runtime,
    tiles,
    slicerValues,
    crossFilter,
    drillthrough,
    filterCards,
    filterCardOverrides,
    activePageId,
  ]);

  /**
   * What each chart tile is CURRENTLY showing — the drill-derived effective
   * spec + merged filters + drill runtime, reported by DashboardChartTile on
   * every render (ref assignment, no re-renders). The export menus build the
   * exact wire spec the tile's own fetch used from this; the point context
   * menu drives drill actions through it.
   */
  const effectiveByTile = useRef(new Map<string, TileEffectiveState>());
  const reportEffective = useCallback((tileId: string, effective: TileEffectiveState) => {
    effectiveByTile.current.set(tileId, effective);
  }, []);

  // Toolbar badge: enabled cards visible on this page currently contributing
  // at least one clause (visual cards of ANY chart on the page count — they
  // all filter, selected or not).
  const activeFilterCount = useMemo(
    () =>
      runtime.dashboards.visibleFilterCards(activePage?.id ?? null).filter(filterCardIsActive)
        .length,
    [runtime, filterCards, filterCardOverrides, activePage],
  );

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

  // Legend cross-filter (legendMode 'crossFilter'): the renderer reports the
  // clicked legend item's raw value + label (null = clear). The clause targets
  // the chart's LEGEND dimension and drives the same transient cross-filter
  // path as datum clicks — every other tile filters; the source tile shows
  // persistent legend emphasis (selectedLegendLabel) instead of dimming.
  const handleLegendSelect = useCallback(
    (tileId: string, chart: ChartSpec, e: ChartLegendSelectEvent | null) => {
      if (e === null) {
        // The emitting chart cleared its selection; only ITS legend filter
        // clears (never someone else's active cross-filter).
        const active = runtime.dashboards.store.getState().crossFilter;
        if (active && active.sourceTileId === tileId && active.kind === 'legend') {
          runtime.dashboards.clearCrossFilter();
        }
        return;
      }
      const dimension = chart.query.legend ?? null;
      if (!dimension) return;
      const clause: FilterClause =
        e.raw === null || e.raw === ''
          ? { table: dimension.table, column: dimension.column, operator: 'isNull', values: [] }
          : { table: dimension.table, column: dimension.column, operator: 'eq', values: [e.raw] };
      runtime.dashboards.setCrossFilter(
        tileId,
        clause,
        `${dimension.column}: ${e.label}`,
        e.label,
        'legend',
      );
    },
    [runtime],
  );

  // Transient notice auto-dismisses (manual x too).
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /**
   * CSV export of a chart tile's CURRENT effective query — drill position +
   * slicers + filter cards + cross-filter + drillthrough, exactly what the
   * tile is showing (the drill wrapper reports it; base spec as fallback).
   * Downloads via an object-URL anchor; failures surface as the notice chip.
   */
  const exportChartCsv = useCallback(
    async (tileId: string, mode: 'summarized' | 'underlying') => {
      const state = runtime.dashboards.store.getState();
      if (state.current?.modelId == null) return;
      const effective = effectiveByTile.current.get(tileId);
      const tile = (state.current.layout.pages ?? [])
        .flatMap((page) => page.tiles)
        .find((t) => t.id === tileId);
      const chart = effective?.chart ?? (tile && isChartTile(tile) ? tile.chart : null);
      if (!chart || !isRunnable(chart)) return;
      const clauses = effective?.filters ?? runtime.dashboards.filtersForTile(tileId);
      // Table measure-column filters (HAVING) ride the exported spec too, so
      // the CSV matches exactly what the filtered table shows.
      const having = effective?.having ?? null;
      const wire = toWireSpec(chart, state.current.modelId, clauses);
      try {
        const { blob, truncated } = await runtime.api.exportQueryCsv({
          spec: having !== null && having.length > 0 ? { ...wire, having } : wire,
          mode,
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${csvFileName(chart.title)}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
        if (truncated) setNotice('Export truncated: the server capped the row count.');
      } catch (error) {
        setNotice(`Export failed: ${messageOf(error)}`);
      }
    },
    [runtime],
  );

  /**
   * Drillthrough candidates for the open point menu: every OTHER page with
   * drillthrough enabled whose EVERY field matches a dimension of the clicked
   * chart's EFFECTIVE query (axis post-drill, legend, small multiples by
   * table+column). Items whose point lacks a field value render disabled.
   */
  const drillthroughTargets = useMemo<DrillthroughTarget[]>(() => {
    if (!pointMenu) return [];
    const { chart, event } = pointMenu;
    const dims: { dim: typeof chart.query.axis; value: unknown; label: string | undefined }[] = [
      { dim: chart.query.axis ?? null, value: event.axisValue, label: event.axisLabel },
      { dim: chart.query.legend ?? null, value: event.legendValue, label: event.legendLabel },
      {
        dim: chart.query.smallMultiples ?? null,
        value: event.smallMultipleValue,
        label:
          event.smallMultipleValue == null ? undefined : String(event.smallMultipleValue),
      },
    ];
    const targets: DrillthroughTarget[] = [];
    for (const page of pages) {
      if (page.id === activePage?.id) continue;
      const config = page.drillthrough;
      if (!config?.enabled || config.fields.length === 0) continue;
      let matchesAll = true;
      let disabledReason: string | null = null;
      const clauses: FilterClause[] = [];
      const labels: string[] = [];
      for (const field of config.fields) {
        const hit = dims.find(
          (d) => d.dim != null && d.dim.table === field.table && d.dim.column === field.column,
        );
        if (!hit) {
          matchesAll = false;
          break;
        }
        const value = hit.value;
        if (value === undefined || value === null) {
          disabledReason ??= `The clicked point has no ${field.column} value`;
          continue;
        }
        clauses.push({
          table: field.table,
          column: field.column,
          operator: 'eq',
          values: [value as string | number | boolean],
        });
        labels.push(hit.label ?? String(value));
      }
      if (!matchesAll) continue;
      targets.push({
        pageId: page.id,
        pageName: page.name,
        disabledReason,
        filters: clauses,
        label: labels.join(' · ') || page.name,
      });
    }
    return targets;
  }, [pointMenu, pages, activePage]);

  /**
   * Drill actions for the open point menu, driven through the effective-state
   * ref the tile reports every render — the menu can drill into the clicked
   * value even when the tile's drill-mode toggle is OFF.
   */
  const pointMenuDrill = useMemo<PointDrillActions | null>(() => {
    if (!pointMenu) return null;
    const drill = effectiveByTile.current.get(pointMenu.tileId)?.drill ?? null;
    if (!drill) return null;
    const { event } = pointMenu;
    return {
      canDrillDeeper: drill.canDrillDeeper,
      level: drill.level,
      pointLabel: event.axisLabel,
      onDrillDown: () => drill.drillDownInto(event),
      onDrillUp: drill.drillUp,
      onDrillReset: drill.resetDrill,
    };
  }, [pointMenu]);

  /** Opens the alert dialog pre-filled from a tile's CURRENT effective state. */
  const openAlertFor = useCallback(
    (tileId: string, chart?: ChartSpec) => {
      const effective = effectiveByTile.current.get(tileId);
      const chartSpec = chart ?? effective?.chart;
      if (!chartSpec || chartSpec.query.measures.length === 0) return;
      setAlertSource({
        chart: chartSpec,
        filters: effective?.filters ?? runtime.dashboards.filtersForTile(tileId),
      });
    },
    [runtime],
  );

  /**
   * "See data": the tile's CURRENT aggregated result (effective spec +
   * merged filters + table HAVING) rendered as a real table in a dialog.
   */
  const openSeeData = useCallback(
    (tileId: string, chart: ChartSpec) => {
      if (!isRunnable(chart)) return;
      const effective = effectiveByTile.current.get(tileId);
      setSeeData({
        kind: 'aggregated',
        tileId,
        chart,
        filters: effective?.filters ?? runtime.dashboards.filtersForTile(tileId),
        having: effective?.having ?? null,
      });
    },
    [runtime],
  );

  /**
   * "See records for <point>": UNDERLYING source rows behind the clicked
   * point — the tile's effective filters plus one eq/isNull clause per
   * dimension value the point carries (axis, legend, small multiples).
   */
  const openSeeRecords = useCallback(() => {
    if (!pointMenu) return;
    const state = runtime.dashboards.store.getState();
    if (state.current?.modelId == null) return;
    const { tileId, chart, event } = pointMenu;
    const effective = effectiveByTile.current.get(tileId);
    const clauses = [...(effective?.filters ?? runtime.dashboards.filtersForTile(tileId))];
    const pointDims = [
      { dim: chart.query.axis ?? null, value: event.axisValue },
      { dim: chart.query.legend ?? null, value: event.legendValue },
      { dim: chart.query.smallMultiples ?? null, value: event.smallMultipleValue },
    ];
    for (const { dim, value } of pointDims) {
      if (!dim || value === undefined) continue;
      clauses.push(
        value === null
          ? { table: dim.table, column: dim.column, operator: 'isNull', values: [] }
          : {
              table: dim.table,
              column: dim.column,
              operator: 'eq',
              values: [value as string | number | boolean],
            },
      );
    }
    const label =
      [event.axisLabel, event.legendLabel].filter((part) => part && part !== '').join(' · ') ||
      chart.title;
    setSeeData({
      kind: 'underlying',
      tileId,
      title: chart.title,
      contextLabel: label,
      spec: toWireSpec(chart, state.current.modelId, clauses),
    });
  }, [pointMenu, runtime]);

  /**
   * Drill actions for the chart-LEVEL menu: no point context, so only
   * "Drill up"/"Back to top" apply (and only once the tile is drilled).
   */
  const tileMenuDrill = useMemo<PointDrillActions | null>(() => {
    if (!tileMenu) return null;
    const drill = effectiveByTile.current.get(tileMenu.tileId)?.drill ?? null;
    if (!drill || drill.level === 0) return null;
    return {
      canDrillDeeper: false,
      level: drill.level,
      pointLabel: '',
      onDrillDown: () => {},
      onDrillUp: drill.drillUp,
      onDrillReset: drill.resetDrill,
    };
  }, [tileMenu]);

  /** Chart tiles by title for the slicer config menus' "Applies to" list. */
  const chartTileInfos = useMemo(
    () => tiles.filter(isChartTile).map((tile) => ({ id: tile.id, title: tile.chart.title })),
    [tiles],
  );

  const gridItems = useMemo<DashboardGridItem[]>(
    () => tiles.map((tile) => ({ id: tile.id, ...tile.layout })),
    [tiles],
  );

  // Refresh indicator: when THIS dashboard's data was last (re)loaded —
  // initial open, manual refresh, and each dashboard auto-refresh tick.
  // Tile fetches aren't observable from here (each ChartTile fetches on its
  // own), so `refreshing` is a brief ~800ms pulse that spins the toolbar icon.
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const spinTimer = useRef<number | null>(null);
  const markRefreshed = useCallback(() => {
    setLastRefreshAt(new Date());
    setRefreshing(true);
    if (spinTimer.current !== null) window.clearTimeout(spinTimer.current);
    spinTimer.current = window.setTimeout(() => setRefreshing(false), 800);
  }, []);
  useEffect(
    () => () => {
      if (spinTimer.current !== null) window.clearTimeout(spinTimer.current);
    },
    [],
  );

  // Initial load (and dashboard switches): stamp the load time once the open
  // dashboard matches this view; reset while another one is (still) loading.
  const dashboardLoaded = current?.id === dashboardId;
  useEffect(() => {
    setLastRefreshAt(dashboardLoaded ? new Date() : null);
  }, [dashboardLoaded, dashboardId]);

  /**
   * Relative-date slicers hold clauses computed from "today" at selection
   * time; every refresh recomputes any active preset so rolling windows stay
   * anchored to the current clock (store writes no-op when the dates are
   * unchanged — the common case within a day).
   */
  const recomputeRelativeSlicers = useCallback(() => {
    const state = runtime.dashboards.store.getState();
    const layout = state.current?.layout;
    if (!layout) return;
    for (const page of layout.pages ?? []) {
      for (const tile of page.tiles) {
        if (!isSlicerTile(tile) || tile.slicer.variant !== 'relativeDate') continue;
        const presetId = slicerPresetOf(state.slicerValues[tile.id]);
        if (presetId === null) continue;
        const clause = relativePresetClause(presetId, tile.slicer.table, tile.slicer.column);
        const current = state.slicerValues[tile.id];
        const currentClause =
          current != null && 'presetId' in current ? current.clause : null;
        if (JSON.stringify(clause) === JSON.stringify(currentClause)) continue;
        runtime.dashboards.setSlicerValue(
          tile.id,
          clause === null ? null : { clause, presetId },
        );
      }
    }
  }, [runtime]);

  // Auto-refresh: invalidate the shared query cache, then bump a token that
  // keys ChartTile — remounting refetches (brief skeleton) with fresh data.
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshTiles = useCallback(() => {
    recomputeRelativeSlicers();
    runtime.queries.invalidateAll();
    setRefreshToken((token) => token + 1);
    markRefreshed();
  }, [runtime, markRefreshed, recomputeRelativeSlicers]);

  const refreshSeconds = current?.id === dashboardId ? (current.layout.refreshSeconds ?? null) : null;

  useEffect(() => {
    // Auto-refresh is suspended while the print preview is open: a mid-print
    // cache invalidation would flash every tile back to a skeleton.
    if (mode !== 'view' || printOptions !== null || refreshSeconds == null || refreshSeconds <= 0)
      return;
    const timer = setInterval(refreshTiles, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [mode, refreshSeconds, refreshTiles, printOptions]);

  // Per-tile live refresh: charts whose format.refreshSeconds is set tick on
  // their own intervals (one interval per distinct seconds value), independent
  // of the dashboard-level refresh above. View mode only, print closed.
  const [tileRefreshTokens, setTileRefreshTokens] = useState<Record<string, number>>({});

  /** Chart tile ids grouped by their per-tile refresh interval (seconds). */
  const tileRefreshGroups = useMemo(() => {
    const groups = new Map<number, string[]>();
    if (modelId === null) return groups;
    for (const tile of tiles) {
      if (!isChartTile(tile)) continue;
      const seconds = tile.chart.format.refreshSeconds ?? null;
      if (seconds == null || seconds <= 0) continue;
      const ids = groups.get(seconds) ?? [];
      ids.push(tile.id);
      groups.set(seconds, ids);
    }
    return groups;
  }, [tiles, modelId]);

  // Ticks read the CURRENT tiles/filters through a ref so slicer/cross-filter
  // changes never reset the running intervals (and keys never go stale).
  const tickInputs = useRef<{
    tiles: DashboardTile[];
    filtersByTile: Map<string, FilterClause[]>;
    modelId: number | null;
  }>({ tiles, filtersByTile, modelId });
  tickInputs.current = { tiles, filtersByTile, modelId };

  const refreshTileGroup = useCallback(
    (tileIds: string[]) => {
      const inputs = tickInputs.current;
      if (inputs.modelId === null) return;
      // Targeted invalidation: recompute exactly the cache key ChartTile uses
      // (same spec + same filters array -> same stableStringify key) and drop
      // ONLY those entries from the shared query cache. Other mounted tiles
      // keep their entries — and their rendered data — untouched.
      const keys: string[] = [];
      for (const id of tileIds) {
        const tile = inputs.tiles.find((t) => t.id === id);
        if (!tile || !isChartTile(tile) || !isRunnable(tile.chart)) continue;
        keys.push(
          runtime.queries.keyFor(
            toWireSpec(tile.chart, inputs.modelId, inputs.filtersByTile.get(id) ?? NO_FILTERS),
          ),
        );
      }
      if (keys.length > 0) {
        runtime.queries.store.setState((state) => {
          const entries = { ...state.entries };
          for (const key of keys) delete entries[key];
          return { entries };
        });
      }
      // Remount just these tiles (key bump): each remount re-runs ChartTile's
      // fetch effect, which now misses the cache and refetches fresh data.
      setTileRefreshTokens((tokens) => {
        const next = { ...tokens };
        for (const id of tileIds) next[id] = (next[id] ?? 0) + 1;
        return next;
      });
    },
    [runtime],
  );

  useEffect(() => {
    if (mode !== 'view' || printOptions !== null || tileRefreshGroups.size === 0) return;
    const timers: number[] = [];
    for (const [seconds, tileIds] of tileRefreshGroups) {
      timers.push(window.setInterval(() => refreshTileGroup(tileIds), seconds * 1000));
    }
    return () => {
      for (const timer of timers) window.clearInterval(timer);
    };
  }, [mode, printOptions, tileRefreshGroups, refreshTileGroup]);

  // Alerts bell: poll recent firings on dashboard open + every 5 minutes.
  // Failures keep the bell hidden (null) — the backend may not be deployed.
  useEffect(() => {
    if (!dashboardLoaded) {
      setAlertFirings(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      runtime.api
        .listRecentAlertFirings(dashboardId)
        .then((firings) => {
          if (!cancelled) setAlertFirings(firings);
        })
        .catch(() => {
          // keep the previous list (or stay hidden) on failure
        });
    };
    poll();
    const timer = window.setInterval(poll, 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtime, dashboardLoaded, dashboardId]);

  // Mobile detection: a ResizeObserver on the VIEW ROOT (not the window — the
  // library can be embedded in a host pane narrower than the screen).
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setContainerWidth(width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const isMobileView =
    mode === 'view' && containerWidth !== null && containerWidth < MOBILE_BREAKPOINT;

  // The phone-layout editor only makes sense while editing; leaving edit mode
  // (save/discard) drops back to the desktop canvas.
  useEffect(() => {
    if (mode !== 'edit') setMobileEditOpen(false);
  }, [mode]);

  const handleLayoutChange = useCallback(
    (items: DashboardGridItem[]) => {
      const state = runtime.dashboards.store.getState();
      if (state.mode !== 'edit' || !state.current) return;
      const activeTiles =
        (state.current.layout.pages ?? []).find((page) => page.id === state.activePageId)?.tiles ??
        [];
      const layoutById = new Map(activeTiles.map((tile) => [tile.id, tile.layout]));
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

    // Text/image tiles: frameless content in view mode, standard TileFrame
    // chrome (title-bar dragging + config card) in edit mode — handled inside.
    if (isTextTile(tile)) {
      return <TextTile tileId={tile.id} spec={tile.text} editable={editable} />;
    }

    if (isImageTile(tile)) {
      return <ImageTile tileId={tile.id} spec={tile.image} editable={editable} />;
    }

    if (!isChartTile(tile)) return null;
    const chart = tile.chart;
    // Edit-mode click selects the tile (drives the Filters pane's "On this
    // visual" section). View mode never selects — datum clicks there belong to
    // cross-filtering/drilling alone. DashboardChartTile owns the selection
    // ring, the TileFrame chrome, and the transient drill-down runtime.
    return (
      <DashboardChartTile
        tileId={tile.id}
        chart={chart}
        modelId={modelId}
        editable={editable}
        selected={selectedTileId === tile.id}
        refreshKey={`${refreshToken}:${tileRefreshTokens[tile.id] ?? 0}`}
        filters={filtersByTile.get(tile.id) ?? NO_FILTERS}
        activeCategoryLabel={
          crossFilter &&
          crossFilter.sourceTileId === tile.id &&
          (crossFilter.kind ?? 'axis') === 'axis'
            ? crossFilter.categoryLabel
            : null
        }
        selectedLegendLabel={
          crossFilter && crossFilter.sourceTileId === tile.id && crossFilter.kind === 'legend'
            ? crossFilter.categoryLabel
            : null
        }
        onSelect={() => runtime.dashboards.selectTile(tile.id)}
        onEdit={() => setBuilder({ tileId: tile.id, spec: chart })}
        onDuplicate={() => runtime.dashboards.duplicateTile(tile.id)}
        onDelete={() => runtime.dashboards.removeTile(tile.id)}
        // Context card replaces the native menu in EDIT mode only; view mode
        // gets the POINT context menu (drillthrough/export) on chart points.
        onTileContextMenu={
          editable
            ? (position) => setChartMenu({ tileId: tile.id, position })
            : undefined
        }
        onCrossFilter={(effectiveChart, info) => handleDatumClick(tile.id, effectiveChart, info)}
        onLegendSelect={(effectiveChart, e) => handleLegendSelect(tile.id, effectiveChart, e)}
        onPointMenu={editable ? undefined : setPointMenu}
        // Whole-tile right-click (view mode): chart-level menu whenever the
        // click hit no chart point — every chart type incl. KPI gets a menu.
        onChartMenu={editable ? undefined : setTileMenu}
        reportEffective={reportEffective}
      />
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
      <ChartBuilderWithParams
        modelId={modelId}
        model={openModel.definition}
        catalog={builderCatalog}
        initial={builder.spec}
        initialTab={builder.initialTab}
        // Dashboard field parameters (id/name/kind) so the builder can offer
        // paramBindings for the axis/measures wells.
        parameters={(current.layout.parameters ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
        }))}
        onSave={handleBuilderSave}
        onCancel={() => setBuilder(null)}
      />
    );
  })();

  /** Chart tile the context card targets (undefined once the tile is gone). */
  const chartMenuTile = chartMenu ? tiles.find((t) => t.id === chartMenu.tileId) : undefined;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-rcd-bg">
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
        onAddText={() => runtime.dashboards.addTextTile()}
        onAddImage={() => setAddImageOpen(true)}
        onAddSlicer={() => setAddSlicerOpen(true)}
        addSlicerDisabled={modelId === null}
        onSave={() => void runtime.dashboards.save()}
        onDiscard={() => runtime.dashboards.discardEdits()}
        refreshSeconds={refreshSeconds}
        onChangeRefreshSeconds={(seconds) => runtime.dashboards.setRefreshSeconds(seconds)}
        onRefresh={refreshTiles}
        refreshing={refreshing}
        lastRefreshAt={lastRefreshAt}
        onExport={() => setPrintConfigOpen(true)}
        onToggleFilters={() => setFiltersPaneOpen((open) => !open)}
        filtersOpen={filtersPaneOpen}
        activeFilterCount={activeFilterCount}
        bookmarks={(bookmarks ?? []).map((b) => ({ id: b.id, name: b.name }))}
        lastAppliedBookmarkId={lastAppliedBookmarkId}
        canManageBookmarks={!readonly}
        onApplyBookmark={(id) => {
          runtime.dashboards.applyBookmark(id);
          // Bookmarks capture relative-date PRESETS; recompute their dates so
          // "Last 30 days" means the last 30 days from today, not capture day.
          recomputeRelativeSlicers();
        }}
        onAddBookmark={(name) => void runtime.dashboards.addBookmark(name)}
        onUpdateBookmark={(id) => runtime.dashboards.updateBookmark(id)}
        onRenameBookmark={(id, name) => runtime.dashboards.renameBookmark(id, name)}
        onDeleteBookmark={(id) => runtime.dashboards.deleteBookmark(id)}
        onManageParameters={() => setParamsOpen(true)}
        onSubscribe={readonly ? undefined : () => setSubscribeOpen(true)}
        alertFirings={alertFirings ?? undefined}
        mobileLayoutOpen={mobileEditOpen}
        onToggleMobileLayout={() => setMobileEditOpen((open) => !open)}
      />

      {/* Flex row: grid area + (optional) right-docked Filters pane. */}
      <div className="relative flex min-h-0 flex-1">
        {/* Chip strip under the toolbar: drillthrough context (on its target
            page), the cross-filter chip, and transient export notices — all on
            the shared TransientChip style (icon + label + dismiss). */}
        <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex max-w-[85%] -translate-x-1/2 flex-col items-center gap-1.5">
          {drillthrough && drillthrough.targetPageId === activePage?.id && (
            <TransientChip
              icon={<Zap size={12} />}
              dismissLabel="Clear drillthrough filter"
              onDismiss={() => runtime.dashboards.clearDrillthrough()}
              leading={
                <button
                  type="button"
                  onClick={() => runtime.dashboards.returnFromDrillthrough()}
                  className="flex h-full shrink-0 items-center gap-1 rounded-full px-2 text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                >
                  <ArrowLeft size={12} />
                  Back
                </button>
              }
            >
              Drillthrough: <span className="font-medium">{drillthrough.label}</span>
            </TransientChip>
          )}
          {notice && (
            <TransientChip
              icon={<AlertTriangle size={12} className="text-[var(--rcd-status-warn)]" />}
              dismissLabel="Dismiss notice"
              onDismiss={() => setNotice(null)}
            >
              {notice}
            </TransientChip>
          )}
          {/* Cross-filter chip: floats under the toolbar in BOTH modes; shows
              legend selections and datum clicks identically. */}
          {crossFilter && (
            <TransientChip
              icon={<Filter size={12} />}
              dismissLabel="Clear cross-filter"
              onDismiss={() => runtime.dashboards.clearCrossFilter()}
            >
              Filtered by <span className="font-medium">{crossFilter.label}</span>
            </TransientChip>
          )}
        </div>

        <div
          className={`h-full min-w-0 flex-1 overflow-auto ${
            (editable && mobileEditOpen) || isMobileView ? '' : 'p-3'
          }`}
        >
          {tiles.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--rcd-accent)_10%,transparent)]">
                <LayoutDashboard size={28} className="text-rcd-accent" />
              </span>
              {editable ? (
                <>
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium text-rcd-text">Nothing here yet</p>
                    <p className="text-sm text-rcd-muted">
                      Add a chart, then arrange tiles by dragging their title bars.
                    </p>
                  </div>
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
          ) : editable && mobileEditOpen ? (
            // Edit mode, phone toggle on: the centered ~380px column where
            // tiles are reordered / resized / hidden; saves into the page doc.
            <MobileLayoutEditor
              tiles={tiles}
              layout={activePage?.mobileLayout ?? null}
              onChange={(mobileLayout) => {
                if (activePage) runtime.dashboards.setPageMobileLayout(activePage.id, mobileLayout);
              }}
              renderTile={renderTile}
            />
          ) : isMobileView ? (
            // Narrow container (view mode): single-column phone stack in the
            // configured order; hidden tiles skipped; no dragging.
            <MobileStack
              tiles={tiles}
              layout={activePage?.mobileLayout ?? null}
              renderTile={renderTile}
            />
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

        {filtersPaneOpen && (
          <FiltersPane
            pageId={activePage?.id ?? null}
            tiles={tiles}
            modelId={modelId}
            editable={editable}
            onClose={() => setFiltersPaneOpen(false)}
          />
        )}
      </div>

      {/* Excel-style page tabs, docked under the scroll area in BOTH modes. */}
      <PageTabs pages={pages} activePageId={activePage?.id ?? null} editable={editable} />

      {chartMenu &&
        editable &&
        chartMenuTile &&
        isChartTile(chartMenuTile) &&
        // Portal past the transformed grid items: position:fixed inside a
        // transformed ancestor would resolve against the tile, not the viewport.
        createPortal(
          <div className="rcd-root bg-transparent">
            <ChartContextMenu
              title={chartMenuTile.chart.title}
              position={chartMenu.position}
              onFormat={() =>
                setBuilder({
                  tileId: chartMenuTile.id,
                  spec: chartMenuTile.chart,
                  initialTab: 'format',
                })
              }
              onEditFields={() =>
                setBuilder({
                  tileId: chartMenuTile.id,
                  spec: chartMenuTile.chart,
                  initialTab: 'fields',
                })
              }
              onDuplicate={() => runtime.dashboards.duplicateTile(chartMenuTile.id)}
              onExport={(exportMode) => void exportChartCsv(chartMenuTile.id, exportMode)}
              onSetAlert={
                modelId !== null && chartMenuTile.chart.query.measures.length > 0
                  ? () => openAlertFor(chartMenuTile.id)
                  : null
              }
              onDelete={() => runtime.dashboards.removeTile(chartMenuTile.id)}
              onClose={() => setChartMenu(null)}
            />
          </div>,
          document.body,
        )}

      {pointMenu &&
        // Same portal doctrine as the edit-mode context card: past the
        // transformed grid items so fixed coordinates resolve to the viewport.
        createPortal(
          <div className="rcd-root bg-transparent">
            <PointContextMenu
              title={pointMenu.chart.title}
              position={{ x: pointMenu.event.clientX, y: pointMenu.event.clientY }}
              drillthroughTargets={drillthroughTargets}
              drill={pointMenuDrill}
              onDrillthrough={(target) =>
                runtime.dashboards.startDrillthrough(target.pageId, target.filters, target.label)
              }
              seeRecords={
                modelId !== null
                  ? { label: pointMenu.event.axisLabel, onClick: openSeeRecords }
                  : null
              }
              onSetAlert={
                !readonly && modelId !== null && pointMenu.chart.query.measures.length > 0
                  ? () => openAlertFor(pointMenu.tileId, pointMenu.chart)
                  : null
              }
              onExport={(exportMode) => void exportChartCsv(pointMenu.tileId, exportMode)}
              onClose={() => setPointMenu(null)}
            />
          </div>,
          document.body,
        )}

      {tileMenu &&
        // Chart-LEVEL menu (view mode): same card + portal doctrine as the
        // point menu, shown when the right-click hit no chart point.
        createPortal(
          <div className="rcd-root bg-transparent">
            <PointContextMenu
              title={tileMenu.chart.title}
              position={tileMenu.position}
              drillthroughTargets={[]}
              drill={tileMenuDrill}
              onDrillthrough={() => {}}
              onSeeData={
                isRunnable(tileMenu.chart)
                  ? () => openSeeData(tileMenu.tileId, tileMenu.chart)
                  : null
              }
              onSetAlert={
                !readonly && modelId !== null && tileMenu.chart.query.measures.length > 0
                  ? () => openAlertFor(tileMenu.tileId, tileMenu.chart)
                  : null
              }
              onExport={(exportMode) => void exportChartCsv(tileMenu.tileId, exportMode)}
              onClose={() => setTileMenu(null)}
            />
          </div>,
          document.body,
        )}

      <SeeDataDialog
        request={seeData}
        modelId={modelId}
        onClose={() => setSeeData(null)}
        onExportSummarized={(tileId) => void exportChartCsv(tileId, 'summarized')}
        onNotice={setNotice}
      />

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

      <FieldParameterDialog open={paramsOpen} onClose={() => setParamsOpen(false)} />

      <SubscriptionsDialog
        open={subscribeOpen}
        dashboardId={dashboardId}
        onClose={() => setSubscribeOpen(false)}
        onError={setNotice}
      />

      {modelId !== null && (
        <AlertDialog
          open={alertSource !== null}
          dashboardId={dashboardId}
          modelId={modelId}
          source={alertSource}
          onClose={() => setAlertSource(null)}
          onError={setNotice}
        />
      )}

      <ImageTileDialog
        open={addImageOpen}
        title="Add image"
        initial={null}
        onClose={() => setAddImageOpen(false)}
        onSave={(spec) => {
          runtime.dashboards.addImageTile(spec);
          setAddImageOpen(false);
        }}
      />

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
          // The ACTIVE page prints; its name joins the header title once the
          // dashboard actually has multiple pages. Tiles print their BASE
          // specs — transient per-tile drill state is deliberately ignored.
          title={
            pages.length > 1 && activePage ? `${current.name} — ${activePage.name}` : current.name
          }
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
