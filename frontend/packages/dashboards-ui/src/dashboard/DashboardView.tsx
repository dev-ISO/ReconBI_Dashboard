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
import { AlertTriangle, ArrowLeft, LayoutDashboard, Plus, RefreshCw, X, Zap } from 'lucide-react';
import {
  crossFilterClauseFor,
  dateRangeClauseFor,
  emptyChart,
  filterCardIsActive,
  isChartTile,
  isImageTile,
  isRunnable,
  isSlicerTile,
  isTextTile,
  newId,
  rcdErrorMessage,
  slicerClauseOf,
  slicerPresetOf,
  stableStringify,
  toWireSpec,
  type AlertFiring,
  type ChartPointEvent,
  type ChartSpec,
  type CrossFilterClauseOptions,
  type DashboardTile,
  type DimensionRef,
  type FilterClause,
  type FilterIndicatorStyle,
  type FilterValue,
  type QueryColumn,
  type ViewFitMode,
} from '@recon/dashboards-core';
import { ChartBuilder, type ChartBuilderProps } from '../chart-builder/ChartBuilder';
import type { ChartLegendSelectEvent } from '../chart/ChartTile';
import type { ChartDatumClickInfo } from '../chart/ChartRenderer';
import { useDashboardState, useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdSelect, RcdSpinner } from '../primitives';
import { ActivityPanel } from './ActivityPanel';
import { AddSlicerDialog } from './AddSlicerDialog';
import { ShareDialog } from './ShareDialog';
import { AlertDialog, type AlertSource } from './AlertDialog';
import { ChartContextMenu } from './ChartContextMenu';
import { DashboardChartTile, type TileEffectiveState } from './DashboardChartTile';
import { DashboardGrid, type DashboardGridItem } from './DashboardGrid';
import { DashboardPrintView } from './DashboardPrintView';
import { DashboardToolbar } from './DashboardToolbar';
import { FieldParameterDialog } from './FieldParameterDialog';
import { FilterChipMenu } from './FilterChipMenu';
import {
  FilterIndicator,
  HeaderFilterBar,
  isBottomPlacement,
  isFlowPlacement,
  resolveIndicatorStyle,
  type ActiveFilterEntry,
  type FilterIndicatorPlacement,
} from './FilterIndicator';
import { FilterIndicatorMenu } from './FilterIndicatorMenu';
import { FiltersPane } from './FiltersPane';
import { FitPageViewport } from './FitPageViewport';
import { ImageTile } from './ImageTile';
import { ImageTileDialog } from './ImageTileDialog';
import { MOBILE_BREAKPOINT, MobileLayoutEditor, MobileStack } from './MobileLayout';
import { PageTabs } from './PageTabs';
import {
  PointContextMenu,
  type DrillthroughTarget,
  type PointDrillActions,
} from './PointContextMenu';
import { resolveColumnType, useModelCatalog } from './columnType';
import { describeClause } from './printLayout';
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
  /**
   * Navigate to another dashboard (used after "Make a copy"). Without it the
   * copy is announced via the notice chip and reachable from the list.
   */
  onOpenDashboard?: (id: number) => void;
  /**
   * Called after this dashboard was deleted or removed from the caller's
   * list, so the host can navigate away.
   */
  onDeleted?: () => void;
  /** Host-injected toolbar actions (threaded to the toolbar's extraActions). */
  extraActions?: ReactNode;
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
      className={`pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-rcd-border bg-rcd-surface pr-1 text-xs font-medium text-rcd-text shadow-[var(--rcd-shadow-2)] ${
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
        className="shrink-0 rounded-md p-1 text-rcd-muted transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * What the RESULT says about a clicked dimension. The result column is
 * authoritative for both facts the clause builder needs: the catalog type
 * (a `date` column rejects any time component; a `timestamp` one needs its
 * upper bound at the last instant of the day) and the bucket the engine
 * actually applied. Result columns arrive in wire dimension order
 * [axis, legend, smallMultiples], the same order toWireSpec emits.
 */
/**
 * The chart's dimensions in WIRE order — the same order toWireSpec emits and
 * therefore the order the result's dimension columns arrive in, so a renderer
 * that reports a dimension INDEX (tables, wave 18) addresses this list.
 */
const wireDimensions = (chart: ChartSpec): DimensionRef[] =>
  [chart.query.axis, chart.query.legend, chart.query.smallMultiples].filter(
    (dim): dim is DimensionRef => dim != null,
  );

const dimensionMeta = (
  chart: ChartSpec,
  dimension: DimensionRef,
  columns: QueryColumn[] | null,
): CrossFilterClauseOptions => {
  const wire = wireDimensions(chart);
  const index = wire.findIndex(
    (dim) => dim.table === dimension.table && dim.column === dimension.column,
  );
  const column =
    index === -1 ? undefined : (columns ?? []).filter((c) => c.role === 'dimension')[index];
  return column === undefined
    ? { dateBucket: dimension.dateBucket ?? null }
    : { columnType: column.type, dateBucket: column.dateBucket ?? dimension.dateBucket ?? null };
};

/** Filesystem-safe download name from a chart title. */
const csvFileName = (title: string): string => {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned === '' ? 'chart' : cleaned;
};

const NO_FILTERS: FilterClause[] = [];

/* -------------------------------------------------------- click modifiers
 * The renderer's datum/legend events carry no modifier flags and no native
 * MouseEvent (ChartDatumClickInfo is {value,label}; ChartPointEvent only has
 * clientX/Y), and renderer files are outside this wave. So the Ctrl/Cmd state
 * is read from the native event itself via a window-level CAPTURE-phase
 * listener: it fires before any React handler in the same event dispatch, so
 * by the time the renderer's onDatumClick reaches this layer the flags are
 * already recorded. (Deliberately not keydown/keyup bookkeeping — that goes
 * stale when the window loses focus while the key is held.) pointerdown +
 * pointerup + click are all recorded so drag-completed gestures (axis range
 * select ends on mouseup) read correctly too; the freshness window rejects
 * leftovers from unrelated earlier gestures.
 */
const lastClickModifiers = { additive: false, at: 0 };

const recordClickModifiers = (event: MouseEvent): void => {
  lastClickModifiers.additive = event.ctrlKey || event.metaKey;
  lastClickModifiers.at = performance.now();
};

/** Ctrl/Cmd was held on the pointer gesture currently being handled. */
const readAdditiveModifier = (): boolean =>
  lastClickModifiers.additive && performance.now() - lastClickModifiers.at < 500;

function useClickModifierTracker(): void {
  useEffect(() => {
    window.addEventListener('pointerdown', recordClickModifiers, true);
    window.addEventListener('pointerup', recordClickModifiers, true);
    window.addEventListener('click', recordClickModifiers, true);
    return () => {
      window.removeEventListener('pointerdown', recordClickModifiers, true);
      window.removeEventListener('pointerup', recordClickModifiers, true);
      window.removeEventListener('click', recordClickModifiers, true);
    };
  }, []);
}

/**
 * Human labels for the drag-to-dock slots (drag ghost caption). The floating
 * slots say so out loud — dropping there is a deliberate move OFF the default
 * toolbar row and back over the tiles.
 */
const SLOT_LABELS: Record<FilterIndicatorPlacement, string> = {
  'top-center': 'Floating — top center',
  'top-left': 'Floating — top left',
  'top-right': 'Floating — top right',
  'bottom-left': 'Floating — bottom left',
  'bottom-right': 'Floating — bottom right',
  header: 'Toolbar (default)',
  footer: 'Footer bar',
};

/** The embeddable entry point: toolbar + tile grid, view/edit modes. */
export function DashboardView({
  dashboardId,
  readonly = false,
  onOpenDashboard,
  onDeleted,
  extraActions,
}: DashboardViewProps) {
  const runtime = useRuntime();

  const current = useDashboardState((state) => state.current);
  const mode = useDashboardState((state) => state.mode);
  const dirty = useDashboardState((state) => state.dirty);
  const canUndo = useDashboardState((state) => state.canUndo);
  const canRedo = useDashboardState((state) => state.canRedo);
  const saveStatus = useDashboardState((state) => state.saveStatus);
  const storeError = useDashboardState((state) => state.error);
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const crossFilters = useDashboardState((state) => state.crossFilters);
  const drillthrough = useDashboardState((state) => state.drillthrough);
  const activePageId = useDashboardState((state) => state.activePageId);
  const selectedTileId = useDashboardState((state) => state.selectedTileId);
  const filterCards = useDashboardState((state) => state.current?.layout.filterCards ?? null);
  const filterCardOverrides = useDashboardState((state) => state.filterCardOverrides);
  const bookmarks = useDashboardState((state) => state.current?.layout.bookmarks ?? null);
  const filterIndicatorStyle = useDashboardState(
    (state) => state.current?.layout.filterIndicator ?? null,
  );
  const lastAppliedBookmarkId = useDashboardState((state) => state.lastAppliedBookmarkId);

  // The catalog itself is read through useModelCatalog (below), which applies
  // the "is this THIS model's catalog?" guard in one place.
  const openModel = useModelState((state) => state.current);

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
  /** Share dialog (toolbar Share button; owner/admin). */
  const [shareOpen, setShareOpen] = useState(false);
  /** Activity log dialog (⋯ > Activity; edit-rights holders). */
  const [activityOpen, setActivityOpen] = useState(false);
  /** Linked-model picker (⋯ > Linked model…; owner/admin, edit mode). */
  const [linkedModelOpen, setLinkedModelOpen] = useState(false);
  /** Pending destructive confirms for the overflow menu's Delete / Leave. */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** Alert dialog + the chart context it was invoked from. */
  const [alertSource, setAlertSource] = useState<AlertSource | null>(null);
  /** Recent alert firings (bell); null until the first successful poll. */
  const [alertFirings, setAlertFirings] = useState<AlertFiring[] | null>(null);
  /** Edit mode: the canvas shows the phone-layout editor instead of the grid. */
  const [mobileEditOpen, setMobileEditOpen] = useState(false);
  /** Edit mode: "Filters & indicator" config card, anchored under its toolbar button. */
  const [indicatorMenu, setIndicatorMenu] = useState<{ x: number; y: number } | null>(null);
  /** Right-click menu on an indicator chip (entry id + viewport position). */
  const [chipMenu, setChipMenu] = useState<{ entryId: string; position: { x: number; y: number } } | null>(
    null,
  );
  /**
   * View-mode drag-to-dock placement (session-only personal tweak; edit-mode
   * drags persist to the doc instead and never set this).
   */
  const [placementOverride, setPlacementOverride] = useState<FilterIndicatorPlacement | null>(null);
  /** Pointer position while the indicator is being dragged; null = not dragging. */
  const [indicatorDragPos, setIndicatorDragPos] = useState<{ x: number; y: number } | null>(null);
  /**
   * View-mode session override of the doc's default view sizing (null =
   * follow `layout.defaultViewFit`). Transient personal tweak, never
   * persisted — but held in the STORE, not component state, so it survives
   * page switches and any remount of this component within the session;
   * edit-mode picks write the doc default instead (and edit mode always
   * renders 1:1 regardless).
   */
  const viewFitOverride = useDashboardState((state) => state.viewFitOverride);

  // Ctrl/Cmd-click detection for additive cross-filtering (see module header).
  useClickModifierTracker();

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

  /** This model's catalog, or null while it is loading/stale/failed. */
  const modelCatalog = useModelCatalog(modelId);

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

  /* ------------------------------------------------ access rights (0.8.0)
   * `myAccess` is server-authoritative (the store defaults it for pre-0.8
   * servers: owner = full, everyone else view-only). This is honest UX only —
   * every write is re-checked server-side. Owner/admin arrive with all three
   * class flags set, so nothing changes for them.
   */
  const access = current?.id === dashboardId ? current.myAccess : null;
  const isSystem = current?.id === dashboardId ? current.isSystem : false;
  /** Can this user enter edit mode at all? (Built-ins are copy-to-edit.) */
  const canEnterEdit = !readonly && !isSystem && (access?.canEdit ?? false);
  /** Owner or CanManageShared admin (a grantee's access is viaShare). */
  const canManageShares =
    !readonly && access !== null && (access.isOwner || (access.canEdit && !access.viaShare));
  const canEditLayout = editable && (access?.canEditLayout ?? false);
  const canManagePages = editable && (access?.canManagePages ?? false);
  const canEditCharts = editable && (access?.canEditCharts ?? false);

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z while editing. Document-level (key events
  // only reach the view root when focus happens to sit inside it) but gated on
  // THIS view's edit mode, and ignored whenever focus is in a text control —
  // those own their native undo.
  useEffect(() => {
    if (!editable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      event.preventDefault();
      if (key === 'y' || (key === 'z' && event.shiftKey)) runtime.dashboards.redo();
      else runtime.dashboards.undo();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editable, runtime]);

  /** ⋯ > Make a copy: caller-owned duplicate of the visible dashboard. */
  const makeCopy = useCallback(async () => {
    try {
      const copy = await runtime.api.duplicateDashboard(dashboardId);
      void runtime.dashboards.loadList();
      if (onOpenDashboard) onOpenDashboard(copy.id);
      else setNotice(`Copy created: "${copy.name}" — find it in your dashboards list.`);
    } catch (error) {
      setNotice(`Copy failed: ${rcdErrorMessage(error)}`);
    }
  }, [runtime, dashboardId, onOpenDashboard]);

  /** ⋯ > Delete (owner/admin): soft delete, then hand navigation to the host. */
  const deleteDashboard = useCallback(async () => {
    try {
      await runtime.api.deleteDashboard(dashboardId);
      void runtime.dashboards.loadList();
      if (onDeleted) onDeleted();
      else setNotice('Dashboard deleted.');
    } catch (error) {
      setNotice(`Delete failed: ${rcdErrorMessage(error)}`);
    }
  }, [runtime, dashboardId, onDeleted]);

  /** ⋯ > Remove from my list (grantee): drops only the caller's share row. */
  const leaveDashboard = useCallback(async () => {
    try {
      await runtime.dashboards.leave(dashboardId);
      if (onDeleted) onDeleted();
      else setNotice('Removed from your list.');
    } catch (error) {
      setNotice(`Remove failed: ${rcdErrorMessage(error)}`);
    }
  }, [runtime, dashboardId, onDeleted]);

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
    crossFilters,
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

  /* ------------------------------------------------------ filter indicator */

  /**
   * Effective indicator style. Two derivations on top of the persisted doc
   * value:
   *  - ACCENT: an explicit accentColor always wins; otherwise the active
   *    PAGE's tab color (pages carry colors) accents the indicator, and with
   *    neither set the app accent (--rcd-accent) applies — the historic
   *    default. Chart CHART_THEMES are per-tile and never leak into
   *    dashboard chrome.
   *  - PLACEMENT: a view-mode drag-to-dock override (session-only) wins over
   *    the doc placement; edit-mode drags write the doc instead, and edit
   *    mode always SHOWS the authored placement (same doctrine as the
   *    filter-card overrides).
   */
  const effectiveIndicatorStyle = useMemo<FilterIndicatorStyle>(
    () => ({
      ...(filterIndicatorStyle ?? {}),
      ...(filterIndicatorStyle?.accentColor == null && activePage?.color
        ? { accentColor: activePage.color }
        : {}),
      ...(placementOverride !== null && mode !== 'edit'
        ? { placement: placementOverride }
        : {}),
    }),
    [filterIndicatorStyle, activePage?.color, placementOverride, mode],
  );

  const indicator = resolveIndicatorStyle(effectiveIndicatorStyle);

  /**
   * Every transient filter the indicator advertises: each active cross-filter
   * (one per field) plus each slicer selection on this page. All are
   * runtime-only state and every entry owns its own clear.
   *
   * Duplicate suppression: a cross-filter whose clause is structurally
   * identical to an active slicer's clause renders NO chip of its own — the
   * slicer chip announces the predicate (visibly a slicer) and its ✕ clears
   * BOTH, so "region: Gulf Coast" can never appear twice.
   */
  const filterEntries = useMemo<ActiveFilterEntry[]>(() => {
    const entries: ActiveFilterEntry[] = [];
    const slicerClauseKeys = new Map<string, number>();
    for (const tile of tiles) {
      if (!isSlicerTile(tile)) continue;
      const clause = slicerClauseOf(slicerValues[tile.id]);
      if (clause === null) continue;
      slicerClauseKeys.set(stableStringify(clause), entries.length);
      entries.push({
        id: tile.id,
        kind: 'slicer',
        field: tile.slicer.label,
        value: describeClause(clause),
        onClear: () => runtime.dashboards.setSlicerValue(tile.id, null),
      });
    }
    for (const cross of crossFilters) {
      const { table, column } = cross.clause;
      const twin = slicerClauseKeys.get(stableStringify(cross.clause));
      if (twin !== undefined) {
        const slicerEntry = entries[twin]!;
        const clearSlicer = slicerEntry.onClear;
        entries[twin] = {
          ...slicerEntry,
          onClear: () => {
            clearSlicer();
            runtime.dashboards.removeCrossFilter(table, column);
          },
        };
        continue;
      }
      entries.push({
        id: `xf:${table}.${column}`,
        kind: 'crossFilter',
        field: column,
        value: cross.categoryLabel,
        onClear: () => runtime.dashboards.removeCrossFilter(table, column),
      });
    }
    return entries;
  }, [runtime, crossFilters, tiles, slicerValues]);

  const clearAllFilters = useCallback(() => {
    // Every cross-filter (any page — dashboard scope may hold off-page ones)
    // plus this page's slicer selections.
    runtime.dashboards.clearCrossFilters();
    for (const entry of filterEntries) {
      if (entry.kind === 'slicer') entry.onClear();
    }
  }, [runtime, filterEntries]);

  /**
   * Badge tooltip per chart tile: the filters that ACTUALLY reach it — every
   * cross-filter (never on its own source tile) and any slicer whose
   * "applies to" list covers it. Absent = no badge on that tile.
   */
  const badgeLabelByTile = useMemo(() => {
    const map = new Map<string, string>();
    if (!indicator.badgeTiles) return map;
    for (const tile of tiles) {
      if (!isChartTile(tile)) continue;
      const names: string[] = [];
      for (const cross of crossFilters) {
        if (cross.sourceTileId !== tile.id) names.push(cross.label);
      }
      for (const other of tiles) {
        if (!isSlicerTile(other)) continue;
        const targets = other.slicer.targets;
        if (targets != null && !targets.includes(tile.id)) continue;
        const clause = slicerClauseOf(slicerValues[other.id]);
        if (clause === null) continue;
        names.push(`${other.slicer.label}: ${describeClause(clause)}`);
      }
      if (names.length > 0) map.set(tile.id, names.join(' · '));
    }
    return map;
  }, [indicator.badgeTiles, tiles, crossFilters, slicerValues]);

  // Cross-filter: the renderer reports raw value + label; THIS layer knows the
  // tile's query, so it maps the click onto the chart's category dimension —
  // axis for cartesian/table charts, legend for pie/donut (RADIAL wells keep
  // the slice dimension there; hand-built specs may still carry it in axis,
  // hence the fallback). crossFilterClauseFor turns the raw cell into the
  // clause: isNull for a blank, a DATE RANGE for a bucketed date dimension
  // (never an eq on the bucket's start instant), eq otherwise. Modifier
  // routing: plain/Shift click = 'replace' (one filter, toggle-off on the
  // same sole datum); Ctrl/Cmd = 'add' (accumulate values on the field /
  // add another field alongside) — the store owns the merge semantics.
  // A datum click may now name WHICH dimension it means (tables: clickFilter
  // 'cell') and may carry SEVERAL at once (clickFilter 'row'); charts that
  // send neither keep the historic "the chart's one category dimension" path.
  const handleDatumClick = useCallback(
    (tileId: string, chart: ChartSpec, info: ChartDatumClickInfo, columns: QueryColumn[] | null) => {
      // The chart's own category dimension: what an unqualified click means.
      const fallback =
        chart.type === 'pie' || chart.type === 'donut'
          ? (chart.query.legend ?? chart.query.axis ?? null)
          : (chart.query.axis ?? null);
      const wire = wireDimensions(chart);
      /** Positional dimension when the renderer named one, else the fallback. */
      const dimensionAt = (index: number | undefined): DimensionRef | null =>
        index === undefined || index < 0 ? fallback : (wire[index] ?? fallback);
      const facets =
        info.facets && info.facets.length > 0
          ? info.facets
          : [{ dimensionIndex: info.dimensionIndex, value: info.value, label: info.label }];
      // One clause per named dimension, de-duplicated by field: the store keeps
      // at most one cross-filter per (table, column) anyway.
      const applied: { clause: FilterClause; dimension: DimensionRef; label: string }[] = [];
      for (const facet of facets) {
        const dimension = dimensionAt(facet.dimensionIndex);
        if (!dimension) continue;
        if (applied.some((a) => a.dimension.table === dimension.table && a.dimension.column === dimension.column)) {
          continue;
        }
        applied.push({
          clause: crossFilterClauseFor(dimension, facet.value, dimensionMeta(chart, dimension, columns)),
          dimension,
          label: facet.label,
        });
      }
      if (applied.length === 0) return;
      const additive = readAdditiveModifier();
      // ONE user action, several clauses ('row'): the store's per-call
      // 'replace' cannot express it — its toggle-off branch would EAT the
      // first clause whenever that exact filter is already the sole active
      // one, and each further call would wipe the previous. So a plain
      // multi-clause click clears once and then adds every clause; the
      // toggle-off symmetry a single-value click has is restored explicitly
      // above it. Store state is read straight off the store so the callback
      // stays dependency-free (and never stale), and React batches the writes
      // into one commit, so no intermediate filter set ever paints or fetches.
      if (applied.length > 1) {
        const active = runtime.dashboards.store.getState().crossFilters;
        if (!additive) {
          const same =
            active.length === applied.length &&
            active.every(
              (f, i) =>
                f.sourceTileId === tileId &&
                stableStringify(f.clause) === stableStringify(applied[i]!.clause),
            );
          // Same row clicked again -> release the whole set.
          if (same) {
            runtime.dashboards.clearCrossFilters();
            return;
          }
          if (active.length > 0) runtime.dashboards.clearCrossFilters();
        }
      }
      applied.forEach(({ clause, dimension, label }) => {
        runtime.dashboards.applyCrossFilter({
          sourceTileId: tileId,
          clause,
          label: `${dimension.column}: ${label}`,
          categoryLabel: label,
          // Single clause keeps the historic replace/toggle semantics; a
          // multi-clause set has already been cleared, so every clause adds.
          mode: additive || applied.length > 1 ? 'add' : 'replace',
        });
      });
    },
    [runtime],
  );

  /**
   * Date-axis drag range (format.zoom.dragAction === 'crossFilter'): the same
   * range-style clause a bucket click produces, spanning the dragged window
   * and sourced from this tile. A plain drag replaces the active filters; a
   * Ctrl/Cmd drag merges into the field's existing range (spanning-range
   * doctrine) or joins the other fields' filters.
   */
  const handleAxisRangeCrossFilter = useCallback(
    (
      tileId: string,
      chart: ChartSpec,
      range: { fromRaw: unknown; toRaw: unknown },
      columns: QueryColumn[] | null,
    ) => {
      const dimension = chart.query.axis ?? null;
      if (!dimension) return;
      const clause = dateRangeClauseFor(
        dimension,
        range.fromRaw,
        range.toRaw,
        dimensionMeta(chart, dimension, columns),
      );
      if (clause === null) return;
      const label = `${clause.values[0] ?? ''} – ${String(clause.values[1] ?? '').slice(0, 10)}`;
      runtime.dashboards.applyCrossFilter({
        sourceTileId: tileId,
        clause,
        label: `${dimension.column}: ${label}`,
        categoryLabel: label,
        mode: readAdditiveModifier() ? 'add' : 'replace',
      });
    },
    [runtime],
  );

  // Legend cross-filter (legendMode 'crossFilter'): the renderer reports the
  // clicked legend item's raw value + label (null = clear). The clause targets
  // the chart's LEGEND dimension and drives the same transient cross-filter
  // path as datum clicks — every other tile filters; the source tile shows
  // persistent legend emphasis (selectedLegendLabel) instead of dimming.
  const handleLegendSelect = useCallback(
    (
      tileId: string,
      chart: ChartSpec,
      e: ChartLegendSelectEvent | null,
      columns: QueryColumn[] | null,
    ) => {
      if (e === null) {
        // The emitting chart cleared its selection; only ITS legend filters
        // clear (never someone else's active cross-filter).
        runtime.dashboards.clearCrossFiltersFromSource(tileId, 'legend');
        return;
      }
      const dimension = chart.query.legend ?? null;
      if (!dimension) return;
      // Legend dimensions can be date-bucketed too (a "by year" legend), so the
      // same range-vs-eq decision applies here.
      const clause = crossFilterClauseFor(
        dimension,
        e.raw === '' ? null : e.raw,
        dimensionMeta(chart, dimension, columns),
      );
      runtime.dashboards.applyCrossFilter({
        sourceTileId: tileId,
        clause,
        label: `${dimension.column}: ${e.label}`,
        categoryLabel: e.label,
        kind: 'legend',
        mode: readAdditiveModifier() ? 'add' : 'replace',
      });
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

  /**
   * Source-tile click emphasis per chart tile (dimming for axis clicks,
   * persistent legend emphasis for legend selections). The renderer contract
   * takes ONE label, so emphasis only renders while the tile's filter holds a
   * SINGLE value — a Ctrl-accumulated multi-value set would otherwise dim the
   * OTHER selected categories as if unselected. Under 'dashboard' scope this
   * naturally only renders on the source tile's own page (other pages don't
   * mount the tile).
   */
  const sourceEmphasisByTile = useMemo(() => {
    const map = new Map<
      string,
      {
        category: string | null;
        legend: string | null;
        categories: string[] | null;
        cells: { source: string | null; label: string }[];
      }
    >();
    for (const cross of crossFilters) {
      const single = (cross.values?.length ?? 1) === 1;
      const label = single ? cross.categoryLabel : null;
      const entry = map.get(cross.sourceTileId) ?? {
        category: null,
        legend: null,
        categories: null,
        cells: [],
      };
      if ((cross.kind ?? 'axis') === 'axis') {
        entry.category = label;
        // Tables can mark EVERY selected row of a Ctrl-accumulated set (they
        // have one interaction identity per row); charts keep the single-label
        // rule above.
        entry.categories = cross.values?.map((v) => v.label) ?? null;
        // COLUMN-QUALIFIED echo: a table whose clicks filter per CELL may hold
        // several fields at once from one tile (clickFilter 'row'), and the
        // single category slot above can only carry the last one. Every active
        // value is echoed with the field it filters, so the table marks the
        // exact cells — unlike the slots above, these ACCUMULATE across fields.
        const source = `${cross.clause.table}.${cross.clause.column}`;
        for (const value of cross.values ?? [{ label: cross.categoryLabel }]) {
          entry.cells.push({ source, label: value.label });
        }
      } else {
        entry.legend = label;
      }
      map.set(cross.sourceTileId, entry);
    }
    return map;
  }, [crossFilters]);

  /* -------------------------------------------- indicator drag-to-dock */

  /** The relative grid row hosting the floating indicator (slot geometry). */
  const contentRowRef = useRef<HTMLDivElement>(null);

  /**
   * The seven docking slots as viewport anchor points: the five classic
   * corners/center of the content row, the toolbar row ('header'), and the
   * bottom edge ('footer'). Recomputed per call from live rects.
   */
  const slotAnchors = useCallback((): {
    placement: FilterIndicatorPlacement;
    x: number;
    y: number;
  }[] => {
    const root = rootRef.current?.getBoundingClientRect();
    const content = contentRowRef.current?.getBoundingClientRect() ?? root;
    if (!root || !content) return [];
    const inset = 24;
    return [
      { placement: 'header', x: root.left + root.width / 2, y: root.top + 24 },
      { placement: 'top-left', x: content.left + inset, y: content.top + inset },
      { placement: 'top-center', x: content.left + content.width / 2, y: content.top + inset },
      { placement: 'top-right', x: content.right - inset, y: content.top + inset },
      { placement: 'bottom-left', x: content.left + inset, y: content.bottom - inset },
      { placement: 'bottom-right', x: content.right - inset, y: content.bottom - inset },
      { placement: 'footer', x: content.left + content.width / 2, y: content.bottom + 16 },
    ];
  }, []);

  const nearestSlot = useCallback(
    (x: number, y: number): FilterIndicatorPlacement | null => {
      let best: FilterIndicatorPlacement | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const anchor of slotAnchors()) {
        const distance = (anchor.x - x) ** 2 + (anchor.y - y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = anchor.placement;
        }
      }
      return best;
    },
    [slotAnchors],
  );

  const indicatorDragging = indicatorDragPos !== null;

  // Window-level drag tracking while the grip is held: pointermove drives the
  // ghost, pointerup snaps to the nearest slot (doc write in edit mode —
  // persists on Save; transient session override in view mode), Escape
  // cancels. Listeners live only for the drag's duration.
  useEffect(() => {
    if (!indicatorDragging) return;
    const onMove = (event: PointerEvent) => {
      setIndicatorDragPos({ x: event.clientX, y: event.clientY });
    };
    const onUp = (event: PointerEvent) => {
      const slot = nearestSlot(event.clientX, event.clientY);
      setIndicatorDragPos(null);
      if (slot === null) return;
      const state = runtime.dashboards.store.getState();
      // Doc write needs layout rights; anyone else's drag is a session tweak.
      if (state.mode === 'edit' && state.current?.myAccess.canEditLayout) {
        runtime.dashboards.setFilterIndicator({ placement: slot });
        // A stale session override must not mask the freshly authored slot
        // once the edit is saved and view mode returns.
        setPlacementOverride(null);
      } else {
        setPlacementOverride(slot);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIndicatorDragPos(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [indicatorDragging, nearestSlot, runtime]);

  const startIndicatorDrag = useCallback((event: { clientX: number; clientY: number }) => {
    setIndicatorDragPos({ x: event.clientX, y: event.clientY });
  }, []);

  /* ------------------------------------------------ indicator chip menu */

  /** Context the open chip menu operates on (resolved from the entry id). */
  const chipMenuContext = useMemo(() => {
    if (!chipMenu) return null;
    const entry = filterEntries.find((e) => e.id === chipMenu.entryId);
    if (!entry) return null;
    const cross = chipMenu.entryId.startsWith('xf:')
      ? crossFilters.find((f) => `xf:${f.clause.table}.${f.clause.column}` === chipMenu.entryId)
      : undefined;
    return { entry, cross: cross ?? null };
  }, [chipMenu, filterEntries, crossFilters]);

  /**
   * "Edit value…" support for a cross-filter chip: discrete clauses only
   * (eq/in/isNull) — a date-range chip has no finite value list to check off.
   * Values load through the SAME distinct-values API the slicers use; the
   * checked set writes back through setCrossFilterValues, the exact store
   * path Ctrl-click accumulation uses.
   */
  const chipMenuEdit = useMemo(() => {
    const cross = chipMenuContext?.cross ?? null;
    if (!cross || modelId === null) return null;
    const { clause } = cross;
    if (clause.operator !== 'eq' && clause.operator !== 'in' && clause.operator !== 'isNull')
      return null;
    const { table, column } = clause;
    return {
      current: (cross.values ?? [])
        .map((v) => v.raw)
        .filter((v): v is FilterValue => v !== null),
      loadValues: async () => {
        const result = await runtime.queries.distinct({
          modelId,
          table,
          column,
          filters: [],
          limit: 200,
        });
        return result.values;
      },
      onApply: (values: FilterValue[]) =>
        runtime.dashboards.setCrossFilterValues(
          table,
          column,
          values.map((raw) => ({ raw, label: String(raw) })),
        ),
    };
  }, [chipMenuContext, modelId, runtime]);

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
        const clause = relativePresetClause(
          presetId,
          tile.slicer.table,
          tile.slicer.column,
          resolveColumnType(modelCatalog, tile.slicer.table, tile.slicer.column),
        );
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
  }, [runtime, modelCatalog]);

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

  /* --------------------------------------------- edit-mode canvas boundary */

  /** The grid scroll area (ref'd for the edit-mode page-boundary measure). */
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  /**
   * Edit-mode page boundary: the canvas height (px) that fits the CURRENT
   * viewport without scrolling — Power BI's "page edge". Measured off the
   * scroll area's client box minus its p-3 padding, rounded with a 1px
   * dead-band so ResizeObserver jitter never churns the canvas.
   */
  const [canvasBoundary, setCanvasBoundary] = useState<number | null>(null);
  useEffect(() => {
    if (!editable || mobileEditOpen) {
      setCanvasBoundary(null);
      return;
    }
    const node = scrollAreaRef.current;
    if (!node) return;
    const measure = () => {
      const next = Math.round(node.clientHeight) - 24; // p-3 top + bottom
      setCanvasBoundary((prev) =>
        next <= 0 ? null : prev !== null && Math.abs(prev - next) < 1 ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [editable, mobileEditOpen]);

  /* ------------------------------------------------------ view fit (scale) */

  /**
   * Effective view sizing: edit mode shows (and edits) the authored doc
   * default but always RENDERS 1:1 (drag/resize math must stay unscaled);
   * view mode honors the session override first, then the doc default. FIT
   * TO PAGE is the product default — a doc with no `defaultViewFit` fits;
   * docs explicitly authored to 'actual' render 1:1 (and the toolbar's View
   * menu still lets viewers switch either way). The phone stack ignores fit
   * entirely — scaling a single-column stack down would just shrink text.
   */
  const docViewFit: ViewFitMode =
    (current?.id === dashboardId ? current.layout.defaultViewFit : null) ?? 'fitPage';
  const effectiveViewFit: ViewFitMode =
    mode === 'edit' ? docViewFit : (viewFitOverride ?? docViewFit);
  const fitPageActive =
    mode === 'view' && !isMobileView && effectiveViewFit === 'fitPage';

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
          // Slicer tile CONFIG edits are layout-class changes (the differ's
          // doctrine) — grantees without layout rights get the view-mode tile.
          editable={canEditLayout}
          chartTiles={chartTileInfos}
        />
      );
    }

    // Text/image tiles: frameless content in view mode, standard TileFrame
    // chrome (title-bar dragging + config card) in edit mode — handled inside.
    // Their content edits are layout-class changes, hence canEditLayout.
    if (isTextTile(tile)) {
      return <TextTile tileId={tile.id} spec={tile.text} editable={canEditLayout} />;
    }

    if (isImageTile(tile)) {
      return <ImageTile tileId={tile.id} spec={tile.image} editable={canEditLayout} />;
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
        // Chart spec/format edits + tile delete are charts-class changes.
        editable={canEditCharts}
        selected={selectedTileId === tile.id}
        refreshKey={`${refreshToken}:${tileRefreshTokens[tile.id] ?? 0}`}
        filters={filtersByTile.get(tile.id) ?? NO_FILTERS}
        activeCategoryLabel={sourceEmphasisByTile.get(tile.id)?.category ?? null}
        activeCategories={sourceEmphasisByTile.get(tile.id)?.categories ?? null}
        activeCells={sourceEmphasisByTile.get(tile.id)?.cells ?? null}
        selectedLegendLabel={sourceEmphasisByTile.get(tile.id)?.legend ?? null}
        onSelect={() => runtime.dashboards.selectTile(tile.id)}
        onEdit={() => setBuilder({ tileId: tile.id, spec: chart })}
        onDuplicate={() => runtime.dashboards.duplicateTile(tile.id)}
        onDelete={() => runtime.dashboards.removeTile(tile.id)}
        // Context card replaces the native menu in EDIT mode only; view mode
        // gets the POINT context menu (drillthrough/export) on chart points.
        onTileContextMenu={
          canEditCharts
            ? (position) => setChartMenu({ tileId: tile.id, position })
            : undefined
        }
        filterBadgeLabel={badgeLabelByTile.get(tile.id) ?? null}
        filterBadgeAccent={indicator.accentColor}
        onCrossFilter={(effectiveChart, info, columns) =>
          handleDatumClick(tile.id, effectiveChart, info, columns)
        }
        onLegendSelect={(effectiveChart, e, columns) =>
          handleLegendSelect(tile.id, effectiveChart, e, columns)
        }
        onAxisRangeCrossFilter={(effectiveChart, range, columns) =>
          handleAxisRangeCrossFilter(tile.id, effectiveChart, range, columns)
        }
        onPointMenu={editable ? undefined : setPointMenu}
        // Whole-tile right-click (view mode): chart-level menu whenever the
        // click hit no chart point — every chart type incl. KPI gets a menu.
        onChartMenu={editable ? undefined : setTileMenu}
        reportEffective={reportEffective}
      />
    );
  };

  // Same guard as modelCatalog (the builder only renders once openModel is
  // this dashboard's model, so the extra id check cannot exclude anything).
  const builderCatalog = modelCatalog;

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

  // Where the indicator renders. 'header' is the DEFAULT (an absent placement
  // resolves to it) AND it outranks every variant: whenever the filters belong
  // in the toolbar they render as toolbar chips, so out of the box NOTHING is
  // ever painted over a tile. That ordering matters — 'banner' used to win,
  // which is how a doc placed at 'header' still ended up as a full-width bar
  // laid over the top row of tiles under fit-to-page.
  //
  // Every other placement is opt-in, reachable only through an explicit doc
  // value or a drag-to-dock: a banner leaves the tile area entirely (in flow,
  // above or below the grid row — 'footer' counts as bottom); a top-center
  // pill/stack joins the existing chip column so the two never stack on top of
  // each other; 'footer' is a slim in-flow bar at the bottom edge; the four
  // corners plus top-center float inside the grid row.
  const hasActiveFilters = filterEntries.length > 0;
  const headerIndicator = hasActiveFilters && indicator.placement === 'header';
  const bannerIndicator =
    hasActiveFilters && !headerIndicator && indicator.variant === 'banner';
  const bannerAtBottom = isBottomPlacement(indicator.placement);
  const footerIndicator =
    hasActiveFilters && !bannerIndicator && indicator.placement === 'footer';
  const inlineIndicator =
    hasActiveFilters && !bannerIndicator && indicator.placement === 'top-center';
  const floatingIndicator =
    hasActiveFilters &&
    !bannerIndicator &&
    !inlineIndicator &&
    !isFlowPlacement(indicator.placement);

  /** Shared wiring for every FilterIndicator render site. */
  const indicatorHandlers = {
    onClearAll: clearAllFilters,
    onEntryContextMenu: (entryId: string, position: { x: number; y: number }) =>
      setChipMenu({ entryId, position }),
    onGripPointerDown: startIndicatorDrag,
  };

  /**
   * Toolbar chips stay compact unless the doc explicitly sizes them — every
   * header size is capped below the 48px toolbar row, so the row's height (and
   * therefore the height left for the fitted page) never moves when filters
   * come and go.
   */
  const headerIndicatorStyle: FilterIndicatorStyle = {
    ...effectiveIndicatorStyle,
    size: effectiveIndicatorStyle.size ?? 'sm',
  };

  /** Live drop-target caption while dragging (ghost + a11y feedback). */
  const dragTargetLabel = indicatorDragPos
    ? SLOT_LABELS[nearestSlot(indicatorDragPos.x, indicatorDragPos.y) ?? 'top-center']
    : null;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-rcd-bg">
      <DashboardToolbar
        name={current.name}
        isShared={current.isShared}
        isSystem={isSystem}
        mode={mode}
        dirty={dirty}
        saving={saveStatus === 'loading'}
        error={saveStatus === 'error' ? storeError : null}
        // Rights-aware: view-only users (and built-ins) get no Edit affordance.
        readonly={!canEnterEdit}
        onEnterEdit={() => runtime.dashboards.enterEdit()}
        onAddChart={openAddChart}
        onAddText={() => runtime.dashboards.addTextTile()}
        onAddImage={() => setAddImageOpen(true)}
        onAddSlicer={() => setAddSlicerOpen(true)}
        addSlicerDisabled={modelId === null}
        canAddTiles={canEditCharts}
        onSave={() => void runtime.dashboards.save()}
        onDiscard={() => runtime.dashboards.discardEdits()}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={editable ? () => runtime.dashboards.undo() : undefined}
        onRedo={editable ? () => runtime.dashboards.redo() : undefined}
        onShare={canManageShares && !isSystem ? () => setShareOpen(true) : undefined}
        onActivity={
          !readonly && (access?.canEdit ?? false) ? () => setActivityOpen(true) : undefined
        }
        onLinkedModel={
          canManageShares && mode === 'edit' ? () => setLinkedModelOpen(true) : undefined
        }
        onMakeCopy={() => void makeCopy()}
        onDelete={canManageShares && !isSystem ? () => setConfirmDelete(true) : undefined}
        onLeave={
          access !== null && !access.isOwner && access.viaShare
            ? () => setConfirmLeave(true)
            : undefined
        }
        extraActions={extraActions}
        refreshSeconds={refreshSeconds}
        onChangeRefreshSeconds={
          // Auto-refresh is a doc setting (layout-class change).
          mode === 'edit' && !canEditLayout
            ? undefined
            : (seconds) => runtime.dashboards.setRefreshSeconds(seconds)
        }
        onRefresh={refreshTiles}
        refreshing={refreshing}
        lastRefreshAt={lastRefreshAt}
        onExport={() => setPrintConfigOpen(true)}
        onToggleFilters={() => setFiltersPaneOpen((open) => !open)}
        filtersOpen={filtersPaneOpen}
        activeFilterCount={activeFilterCount}
        bookmarks={(bookmarks ?? []).map((b) => ({ id: b.id, name: b.name }))}
        lastAppliedBookmarkId={lastAppliedBookmarkId}
        // Bookmark management writes the doc (settings class -> layout right).
        canManageBookmarks={!readonly && !isSystem && (access?.canEditLayout ?? false)}
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
        // Field parameters are doc settings (layout-class change).
        onManageParameters={canEditLayout ? () => setParamsOpen(true) : undefined}
        onSubscribe={readonly ? undefined : () => setSubscribeOpen(true)}
        alertFirings={alertFirings ?? undefined}
        mobileLayoutOpen={mobileEditOpen}
        // The phone layout lives on the page (pages-class change).
        onToggleMobileLayout={
          mode === 'edit' && !canManagePages
            ? undefined
            : () => setMobileEditOpen((open) => !open)
        }
        onConfigureFilterIndicator={
          canEditLayout ? (position) => setIndicatorMenu(position) : undefined
        }
        viewFit={effectiveViewFit}
        // View menu: transient session choice in view mode; the persisted doc
        // default in edit mode (store normalizes 'actual' back to absent).
        // Hidden in the phone stack, where fit doesn't apply.
        onChangeViewFit={
          isMobileView
            ? undefined
            : mode === 'edit'
              ? canEditLayout // doc default is a layout-class change
                ? (fit) => runtime.dashboards.setDefaultViewFit(fit)
                : undefined
              : (fit) => runtime.dashboards.setViewFitOverride(fit)
        }
        // 'header' = THE DEFAULT: compact chips inline in this toolbar row,
        // measured against the row's flexible middle and collapsing into a
        // "+N filters" popover rather than ever wrapping the toolbar.
        centerContent={
          headerIndicator ? (
            <HeaderFilterBar
              entries={filterEntries}
              style={headerIndicatorStyle}
              {...indicatorHandlers}
            />
          ) : undefined
        }
      />

      {/* Banner indicator: in normal flow so it spans the full width and never
          covers a tile (top edge here, bottom edge below the grid row). While
          FIT is active it renders as an overlay INSIDE the content row instead
          (below): an in-flow indicator appearing/disappearing would change the
          measured height, resize every tile, and feed the shake loop. */}
      {bannerIndicator && !bannerAtBottom && !fitPageActive && (
        <FilterIndicator
          entries={filterEntries}
          style={effectiveIndicatorStyle}
          {...indicatorHandlers}
        />
      )}

      {/* Flex row: grid area + (optional) right-docked Filters pane. Ref'd for
          the drag-to-dock slot geometry. */}
      <div ref={contentRowRef} className="relative flex min-h-0 flex-1">
        {/* FIT-mode overlays for the in-flow indicator placements: same chips,
            zero influence on the measured box (see the banner note above). */}
        {fitPageActive && bannerIndicator && !bannerAtBottom && (
          <div className="absolute inset-x-0 top-0 z-20">
            <FilterIndicator
              entries={filterEntries}
              style={effectiveIndicatorStyle}
              {...indicatorHandlers}
            />
          </div>
        )}
        {fitPageActive && bannerIndicator && bannerAtBottom && (
          <div className="absolute inset-x-0 bottom-0 z-20">
            <FilterIndicator
              entries={filterEntries}
              style={effectiveIndicatorStyle}
              {...indicatorHandlers}
            />
          </div>
        )}
        {fitPageActive && footerIndicator && (
          <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-1.5 overflow-x-auto border-t border-rcd-border bg-rcd-surface px-3 py-1">
            <FilterIndicator
              entries={filterEntries}
              style={effectiveIndicatorStyle}
              inline
              {...indicatorHandlers}
            />
          </div>
        )}
        {/* Chip strip under the toolbar: the top-center filter indicator (so it
            can never overlap the toolbar's refresh caption), the drillthrough
            context on its target page, and transient export notices. */}
        <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex max-w-[85%] -translate-x-1/2 flex-col items-center gap-1.5">
          {inlineIndicator && (
            <FilterIndicator
              entries={filterEntries}
              style={effectiveIndicatorStyle}
              inline
              {...indicatorHandlers}
            />
          )}
          {drillthrough && drillthrough.targetPageId === activePage?.id && (
            <TransientChip
              icon={<Zap size={12} />}
              dismissLabel="Clear drillthrough filter"
              onDismiss={() => runtime.dashboards.clearDrillthrough()}
              leading={
                <button
                  type="button"
                  onClick={() => runtime.dashboards.returnFromDrillthrough()}
                  className="flex h-full shrink-0 items-center gap-1 rounded-md px-2 text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
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
        </div>

        {/* Floating (pill/stack) indicator docked at a corner slot. */}
        {floatingIndicator && (
          <FilterIndicator
            entries={filterEntries}
            style={effectiveIndicatorStyle}
            {...indicatorHandlers}
          />
        )}

        <div
          ref={scrollAreaRef}
          // Fit mode never scrolls BY CONSTRUCTION (the page is scaled to fit
          // the box), so the scrollbar is hard-disabled there: a sub-pixel
          // overflow toggling a scrollbar would change the measured client box
          // and oscillate the scale — the infinite-shake feedback path.
          className={`h-full min-w-0 flex-1 ${fitPageActive ? 'overflow-hidden' : 'overflow-auto'} ${
            (editable && mobileEditOpen) || isMobileView ? '' : 'p-3'
          }`}
        >
          {tiles.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--rcd-accent)_10%,transparent)]">
                <LayoutDashboard size={28} className="text-rcd-accent" />
              </span>
              {canEditCharts ? (
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
                  {canEnterEdit && mode === 'view' && ' Click Edit to add one.'}
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
            // Fit to page (view mode only): the viewport scales the grid down
            // so the whole page fits the available height; inactive it is a
            // style-less passthrough. Edit mode and MobileStack never scale.
            // contentKey re-measures synchronously on page switches so the new
            // page's scale applies BEFORE its first paint.
            <FitPageViewport active={fitPageActive} contentKey={activePage?.id ?? null}>
              <DashboardGrid
                items={gridItems}
                editable={editable}
                // Grantees without layout rights get a static grid (honest
                // UX; the differ + server reject their moves regardless).
                locked={!canEditLayout}
                onLayoutChange={handleLayoutChange}
                renderItem={renderTile}
                draggableHandle=".rcd-tile-drag-handle"
                boundaryHeight={editable ? canvasBoundary : null}
              />
            </FitPageViewport>
          )}
        </div>

        {filtersPaneOpen && (
          <FiltersPane
            pageId={activePage?.id ?? null}
            tiles={tiles}
            modelId={modelId}
            // Filter cards are doc settings — layout-class changes.
            editable={canEditLayout}
            onClose={() => setFiltersPaneOpen(false)}
          />
        )}
      </div>

      {bannerIndicator && bannerAtBottom && !fitPageActive && (
        <FilterIndicator
          entries={filterEntries}
          style={effectiveIndicatorStyle}
          {...indicatorHandlers}
        />
      )}

      {/* 'footer' docking slot: slim in-flow chip bar at the bottom edge
          (overlay inside the content row instead while fit is active). */}
      {footerIndicator && !fitPageActive && (
        <div className="flex w-full shrink-0 items-center justify-center gap-1.5 overflow-x-auto border-t border-rcd-border bg-rcd-surface px-3 py-1">
          <FilterIndicator
            entries={filterEntries}
            style={effectiveIndicatorStyle}
            inline
            {...indicatorHandlers}
          />
        </div>
      )}

      {/* Excel-style page tabs, docked under the scroll area in BOTH modes. */}
      <PageTabs pages={pages} activePageId={activePage?.id ?? null} editable={canManagePages} />

      {chartMenu &&
        canEditCharts &&
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

      {indicatorMenu &&
        canEditLayout &&
        // Same portal doctrine as every other floating card in this view.
        createPortal(
          <div className="rcd-root bg-transparent">
            <FilterIndicatorMenu
              style={filterIndicatorStyle}
              position={indicatorMenu}
              onClose={() => setIndicatorMenu(null)}
            />
          </div>,
          document.body,
        )}

      {chipMenu &&
        chipMenuContext &&
        // Chip right-click menu: portal past the transformed grid (fixed
        // coordinates must resolve against the viewport).
        createPortal(
          <div className="rcd-root bg-transparent">
            <FilterChipMenu
              entryLabel={`${chipMenuContext.entry.field}: ${chipMenuContext.entry.value}`}
              position={chipMenu.position}
              edit={chipMenuContext.entry.kind === 'crossFilter' ? chipMenuEdit : null}
              onClearThis={chipMenuContext.entry.onClear}
              onClearAll={clearAllFilters}
              onClose={() => setChipMenu(null)}
            />
          </div>,
          document.body,
        )}

      {indicatorDragPos &&
        // Drag-to-dock ghost: a small caption pill following the pointer that
        // names the slot the indicator will snap to on release.
        createPortal(
          <div className="rcd-root bg-transparent">
            <div
              className="pointer-events-none fixed z-[60] flex items-center gap-1.5 rounded-lg border border-rcd-border bg-rcd-surface px-2.5 py-1.5 text-xs font-medium text-rcd-text shadow-[var(--rcd-shadow-2)]"
              style={{ left: indicatorDragPos.x + 12, top: indicatorDragPos.y + 12 }}
              role="status"
            >
              Move filters — dock: <span className="font-semibold">{dragTargetLabel}</span>
            </div>
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
        // Definite panel height so the builder's flex layout tracks resizes
        // (preview grows with the dialog instead of leaving dead space).
        fillHeight
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

      <ShareDialog
        open={shareOpen}
        dashboardId={dashboardId}
        onClose={() => setShareOpen(false)}
        // The frontend has no dedicated admin signal, so owner-or-admin sees
        // the publish toggle; a non-admin owner's flip is refused server-side.
        canPublish={canManageShares}
        isShared={current.isShared}
      />

      <ActivityPanel
        open={activityOpen}
        dashboardId={dashboardId}
        onClose={() => setActivityOpen(false)}
      />

      <LinkedModelDialog
        open={linkedModelOpen}
        modelId={current.modelId}
        onClose={() => setLinkedModelOpen(false)}
        onPick={(id) => {
          runtime.dashboards.setModelId(id);
          setLinkedModelOpen(false);
        }}
      />

      <ConfirmDialog
        title="Delete dashboard"
        message={`Delete "${current.name}"? Everyone loses access. This cannot be undone.`}
        confirmLabel="Delete"
        danger
        open={confirmDelete}
        onConfirm={() => {
          setConfirmDelete(false);
          void deleteDashboard();
        }}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        title="Remove from my list"
        message={`Remove "${current.name}" from your list? Only your access is removed — the dashboard itself is untouched.`}
        confirmLabel="Remove"
        danger
        open={confirmLeave}
        onConfirm={() => {
          setConfirmLeave(false);
          void leaveDashboard();
        }}
        onCancel={() => setConfirmLeave(false)}
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
        // The print view resolves its own content (which dashboard pages the
        // options include, their tiles, headers and per-tile filters) through
        // usePrintSections — the same hook the config dialog previewed with.
        // Tiles print their BASE specs — transient per-tile drill state is
        // deliberately ignored.
        <DashboardPrintView options={printOptions} onClose={() => setPrintOptions(null)} />
      )}
    </div>
  );
}

/**
 * "Linked model…" picker (owner/admin, edit mode): a small dialog listing the
 * caller's visible models. The pick writes `modelId` into the DRAFT via the
 * store — it persists through the normal Save path like any other edit.
 */
function LinkedModelDialog({
  open,
  modelId,
  onClose,
  onPick,
}: {
  open: boolean;
  modelId: number | null;
  onClose: () => void;
  onPick: (modelId: number | null) => void;
}) {
  const runtime = useRuntime();
  const models = useModelState((state) => state.models);
  const modelsStatus = useModelState((state) => state.modelsStatus);
  const [choice, setChoice] = useState<string>(modelId === null ? '' : String(modelId));

  useEffect(() => {
    if (!open) return;
    setChoice(modelId === null ? '' : String(modelId));
    void runtime.models.loadModels();
  }, [open, modelId, runtime]);

  return (
    <RcdDialog
      title="Linked model"
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton
            variant="primary"
            onClick={() => onPick(choice === '' ? null : Number(choice))}
          >
            Apply
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
          Semantic model
          <RcdSelect value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="">No model</option>
            {models.map((model) => (
              <option key={model.id} value={String(model.id)}>
                {model.name}
              </option>
            ))}
          </RcdSelect>
          {modelsStatus === 'loading' && (
            <span className="text-xs text-rcd-muted">Loading models…</span>
          )}
        </label>
        <p className="text-xs text-rcd-muted">
          Applies to the draft — Save the dashboard to keep it. Existing charts keep their field
          references; switching models can break charts whose fields the new model lacks.
        </p>
      </div>
    </RcdDialog>
  );
}
