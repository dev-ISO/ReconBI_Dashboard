import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Dot,
  LabelList,
  Legend,
  Line,
  Pie,
  PieChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  useChartHeight,
  useChartLayout,
  useChartWidth,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  XAxis,
  YAxis,
  type ActiveDotProps,
  type MouseHandlerDataParam,
} from 'recharts';
import {
  formatAxisValue,
  formatCellValue,
  sanitizeRichHtml,
  seriesColor,
  type AxisValueFormat,
  type CellValue,
  type ChartFormat,
  type ChartPointEvent,
  type ChartSpec,
  type QueryColumn,
  type QueryResult,
  type ReferenceLineSpec,
  type SeriesLineStyle,
  type TextStyle,
  type TooltipStyle,
} from '@recon/dashboards-core';
import {
  measureNameForKey,
  RAW_AXIS_KEY,
  shapeChartData,
  shapePieData,
  shapeScatterData,
  splitSmallMultiples,
  type ChartSeries,
  type PieSlice,
  type ShapedChartData,
  type SmallMultiplePanel,
} from './chartData';
import {
  buildTrendlines,
  conditionalColor,
  linearFitSegment,
  numberExtent,
  paddedNiceDomain,
  referenceLineValue,
  resolveAxisScale,
  seriesValues,
  sharedValueDomain,
  valueExtent,
  type ResolvedAxisScale,
  type TrendlineOverlay,
} from './analytics';
import { AxisFitTick, resolveLabelFit } from './axisFit';
import { textStyleToCss } from './textStyle';
import { TableChart, type TableColumnFilter } from './TableChart';
// Intentional import cycle (module-eval safe: every cross-reference is inside
// a function body): GanttChart reuses this file's tooltip card, legend and
// selection primitives instead of forking them.
import { GanttChart } from './GanttChart';
import './chart.css';

export type {
  TableColumnFilter,
  TableFilterOperator,
  TableLayoutPatch,
  TableSortState,
} from './TableChart';

/** Payload of a cross-filter datum click. */
export interface ChartDatumClickInfo {
  /** RAW (pre-format) cell value of the clicked category; null = blank. */
  value: CellValue;
  /** Formatted display label of the clicked category. */
  label: string;
}

/**
 * The data point(s) currently driving THIS chart's own active cross-filter
 * (echoed back by the consumer so the source chart can emphasize them).
 * Matching is by FORMATTED label (ChartDatumClickInfo.label /
 * ChartPointEvent.axisLabel / legendLabel); a stringified RAW cell also
 * matches, so consumers may echo either form.
 */
export interface ChartSelection {
  /** Selected category (axis value); null/undefined = no category facet. */
  category?: string | null;
  /** Selected legend value; null/undefined = no legend facet. */
  legendValue?: string | null;
  /**
   * Every selected category label when a Ctrl-accumulated multi-value set is
   * active (category then holds null). Tables highlight all of them; other
   * charts currently ignore it.
   */
  categories?: readonly string[] | null;
}

/**
 * Drag-selected span of a bucketed DATE axis (zoom.dragAction 'crossFilter').
 * fromRaw/toRaw are the RAW axis bucket cells of the span's edge buckets —
 * the same raw values point events carry, NOT display labels — inclusive of
 * both edges.
 */
export interface ChartAxisRangeSelection {
  fromRaw: unknown;
  toRaw: unknown;
}

export interface ChartRendererProps {
  spec: ChartSpec;
  result: QueryResult;
  /**
   * Cross-filter hook: fires with the clicked category's raw value + formatted
   * label. Wired for column/bar/stacked bars, pie/donut slices, and table rows
   * that have a dimension; line/area/scatter/kpi emit nothing (v1). The
   * renderer stays query-agnostic — the CALLER maps the raw value onto its
   * dimension (table/column) and builds the FilterClause.
   */
  onDatumClick?: (info: ChartDatumClickInfo) => void;
  /**
   * Point-level click: fires from every interactive datum (bars and stacked
   * segments, line/area active dots, pie/donut slices, scatter points, table
   * rows) with the full ChartPointEvent payload. Fires IN ADDITION to
   * onDatumClick — the consumer decides which to act on. KPI is a no-op.
   */
  onPointClick?: (e: ChartPointEvent) => void;
  /**
   * Point-level context menu (right-click; the browser menu is suppressed via
   * preventDefault). Same coverage as onPointClick; line/area resolve the
   * ACTIVE hovered category at chart level, so measureKey/value stay unset.
   */
  onPointContextMenu?: (e: ChartPointEvent) => void;
  /**
   * Set on the SOURCE chart while its cross-filter is active: categories whose
   * formatted label differs render at fillOpacity 0.35. Implemented for
   * single-series column/bar (the Cell path) and pie/donut; multi-series and
   * stacked charts skip dimming (a category there spans several marks).
   */
  activeCategory?: { label: string } | null;
  /**
   * The data point(s) currently driving this chart's own active cross-filter.
   * While non-null (and format.selectionHighlight !== false) matching data
   * points render emphasized — full opacity plus a subtle accent ring — and
   * everything else dims to ~0.35, the same dim the hover highlight uses, so
   * the two read as one system (selection wins over hover while both are
   * present). Covers column/bar (vertical + horizontal, stacked, multi-
   * series), pie/donut slices, line/area (enlarged dots on the selected
   * category; legendValue dims the other series) and scatter groups.
   */
  selection?: ChartSelection | null;
  /**
   * Axis range-select hook: fires when format.zoom.dragAction ===
   * 'crossFilter' and the user drag-selects a span of a bucketed DATE axis
   * (requires zoom.dragZoom). The view also zooms to the span, so the source
   * chart shows the selection it just emitted. Non-date axes fall back to a
   * plain view zoom and never fire this.
   */
  onAxisRangeSelect?: (range: ChartAxisRangeSelection) => void;
  /**
   * Legend cross-filter hook (format.legendMode === 'crossFilter'): clicking a
   * legend item fires with the RAW legend-dimension cell (pie: the slice's
   * raw) + formatted label; clicking the currently selected item — or
   * double-click reset — fires null to clear. The renderer stays
   * query-agnostic: the CALLER maps the raw value onto its legend dimension
   * and builds the FilterClause. Charts without a legend identity fall back to
   * 'isolate' and never fire this.
   */
  onLegendSelect?: (e: { raw: CellValue; label: string } | null) => void;
  /**
   * Echo of the active legend cross-filter selection (the `label` the consumer
   * received from onLegendSelect). The matching legend item renders emphasized
   * (bold); the rest dim. Null/undefined = no selection marking.
   */
  selectedLegendLabel?: string | null;
  /**
   * Page hover-highlight source: fires when the pointer enters a datum (bars
   * and stacked segments, the ACTIVE category of line/area charts via
   * chart-level mousemove, pie slices, scatter points, table rows) and null
   * when it leaves the plot. Emission is throttled internally (~60ms,
   * trailing) so consumers aren't flooded; leave (null) flushes immediately.
   * Suppressed entirely when format.hoverHighlight === false — CONSUMERS gate
   * whether they APPLY highlights, the source gates emitting.
   */
  onPointHover?: (e: ChartPointEvent | null) => void;
  /**
   * Page hover-highlight echo: NON-matching categories/series render at ~0.35
   * opacity while set (matching marks stay full). Category matches dim per
   * category on bar-family charts (the Cell path), pie slices and table rows;
   * a label matching a SERIES (display name, styleKey or legend half) dims
   * the other series instead — including line/area strokes and scatter
   * groups. Distinct from the activeCategory cross-filter dim: both can
   * coexist, and the hover highlight wins visually while present.
   */
  highlightCategory?: { label: string } | null;
  /** Echo of the tile's table sort (indicator arrows); see TableChart. */
  tableSort?: { column: string; direction: 'asc' | 'desc' } | null;
  /** Table header click cycles asc -> desc -> none (table.sortable !== false). */
  onTableSortChange?: (s: { column: string; direction: 'asc' | 'desc' } | null) => void;
  /** 0-based page the tile is serving (footer shows Page N = tablePage + 1). */
  tablePage?: number;
  /** Total pages; null = unknown, keeps "next" enabled until the tile knows. */
  tablePageCount?: number | null;
  onTablePageChange?: (page: number) => void;
  /** Full-data totals aligned to the measure columns (bold pinned bottom row). */
  totalsRow?: (number | null)[] | null;
  /** Column resize / header drag-to-reorder patches for the tile to persist. */
  onTableLayoutChange?: (patch: { columnWidths?: Record<string, number>; columnOrder?: string[] }) => void;
  /**
   * Echo of the committed table header-menu filters — the TILE owns the list
   * (it maps them onto wire FilterClauses / HAVING); the table renders badges
   * and pre-populates its menus from it.
   */
  tableFilters?: TableColumnFilter[];
  /** Header-menu filter commits: the FULL updated per-column filter list. */
  onTableFilterChange?: (filters: TableColumnFilter[]) => void;
  /**
   * Distinct-value fetch for a DIMENSION column's checkbox filter list
   * (server-side limited). Called lazily when a dimension header menu opens.
   */
  onRequestColumnValues?: (column: string) => Promise<CellValue[]>;
}

/** Value/category tick type: slightly smaller and muted so data leads. */
const axisTickStyle = { fontSize: 11, fill: 'var(--rcd-muted)' } as const;

/** Gap between tick text and the plot (shadcn charts breathe ~8px). */
const TICK_MARGIN = 8;

const legendWrapperStyle = { fontSize: 12, color: 'var(--rcd-text-2)' } as const;

/** Recessive grid hairlines: SOLID at 50% of the border token (shadcn look). */
export const GRID_STROKE = 'color-mix(in srgb, var(--rcd-border) 50%, transparent)';

/** Rounded corners on the VALUE END of a bar (radius 4). */
const barEndRadius = (horizontal: boolean): [number, number, number, number] =>
  horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];

/** Debounce (ms) for ResponsiveContainer re-measures during grid/tile resizes. */
const RESIZE_DEBOUNCE = 60;

/** Width (px) reserved beside a pie/donut for a right-positioned legend. */
const PIE_RIGHT_LEGEND_WIDTH = 230;

/** Horizontal breathing room around a pie/donut without a right legend. */
const PIE_SIDE_PAD = 32;

/** Gap (px) between small-multiple panels. */
const SM_GRID_GAP = 8;

/** Small-multiple panels narrower than this hide data labels to stay readable. */
const SM_MIN_LABEL_WIDTH = 160;

/** Shared empty set: the "nothing hidden" value (also used when non-interactive). */
const NO_HIDDEN: ReadonlySet<string> = new Set();

/**
 * Debounced ResizeObserver measurement of a container div — the shared
 * pattern behind CenteredPieFrame, the small-multiples grid and the cartesian
 * label-fit/zoom wrapper. Null until the first measure lands.
 */
function useDebouncedSize(
  ref: RefObject<HTMLDivElement | null>,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_DEBOUNCE);
    });
    observer.observe(node);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref]);
  return size;
}

/**
 * Does one ChartSelection facet (a formatted label — or a stringified raw
 * cell) match this label/raw pair? Accepting either form keeps the renderer
 * agnostic about which one the consumer chose to echo back.
 */
export const selectionFacetMatches = (
  facet: string,
  label: string | undefined,
  raw: CellValue | undefined,
): boolean => facet === label || (raw != null && String(raw) === facet);

/**
 * Does the selection's CATEGORY side match this label/raw pair? Covers both
 * the single-label facet and a Ctrl-accumulated multi-value set (categories) —
 * every selected category gets the emphasis treatment, not just the last one.
 */
export const selectionCategoryMatches = (
  selection: ChartSelection,
  label: string | undefined,
  raw: CellValue | undefined,
): boolean => {
  if (selection.category != null && selectionFacetMatches(selection.category, label, raw)) {
    return true;
  }
  return (selection.categories ?? []).some((facet) => selectionFacetMatches(facet, label, raw));
};

/** Opacity every non-selected / non-highlighted mark dims to (one system). */
export const DIM_OPACITY = 0.35;

/** Accent ring stroke marking the selected data point(s). */
export const SELECTION_STROKE = 'var(--rcd-accent-interactive)';

/** Pixel threshold: a sub-4px drag counts as a click, never a zoom. */
const DRAG_ZOOM_MIN_PX = 4;

/** Wheel zoom never narrows the view below this many buckets. */
const MIN_WHEEL_BUCKETS = 3;

/* -------------------------------------------------------------------------
 * Zoom control cluster (replaces the recharts Brush strip)
 *
 * A compact button toolbar overlaying a corner of the plot: zoom in/out, pan
 * left/right, reset. Semi-transparent until hovered (chart.css), positioned
 * above the x-axis labels so it never covers them. Buttons step by a FRACTION
 * of the current window (never one bucket) and repeat while held, so long
 * series pan smoothly. All view-only — nothing here touches persisted state.
 * ---------------------------------------------------------------------- */

type ZoomStepAction = 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'reset';

/** Fraction of the current window each cluster step (or hold tick) moves. */
const ZOOM_STEP_FRACTION = 0.25;

/** Press-and-hold repeat cadence for the cluster buttons. */
const ZOOM_HOLD_REPEAT_MS = 140;

/** 24-grid stroke icons (lucide-style) for the cluster buttons. */
const ZOOM_ICONS: Record<ZoomStepAction, ReactNode> = {
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6M8.5 11h5M11 8.5v5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6M8.5 11h5" />
    </>
  ),
  panLeft: <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />,
  panRight: <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  reset: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
};

const ZOOM_BUTTON_TITLES: Record<ZoomStepAction, string> = {
  zoomIn: 'Zoom in (hold to repeat)',
  zoomOut: 'Zoom out (hold to repeat)',
  panLeft: 'Pan left (hold to repeat)',
  panRight: 'Pan right (hold to repeat)',
  reset: 'Reset view',
};

function ZoomControlCluster({
  onStep,
  disabled,
  style,
}: {
  onStep: (action: ZoomStepAction) => void;
  /** Per-action no-op flags (edge of data / zoom limit / already at default). */
  disabled: Record<ZoomStepAction, boolean>;
  style?: CSSProperties;
}) {
  // One shared hold timer: pressing any button steps once immediately, then
  // repeats until release. Release is a WINDOW listener — a button that
  // becomes disabled mid-hold (edge reached) stops receiving pointer events,
  // so its own pointerup could never arrive.
  const holdRef = useRef<number | null>(null);
  const stopHold = () => {
    if (holdRef.current !== null) {
      window.clearInterval(holdRef.current);
      holdRef.current = null;
    }
  };
  useEffect(() => stopHold, []);
  const press = (action: ZoomStepAction) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // No focus grab / text selection on rapid presses.
    event.preventDefault();
    stopHold();
    onStep(action);
    // onStep reads the live window from a ref, so a held-down callback never
    // goes stale across the re-renders its own steps cause.
    holdRef.current = window.setInterval(() => onStep(action), ZOOM_HOLD_REPEAT_MS);
    window.addEventListener('pointerup', stopHold, { once: true });
    window.addEventListener('pointercancel', stopHold, { once: true });
  };
  const button = (action: ZoomStepAction) => (
    <button
      key={action}
      type="button"
      title={ZOOM_BUTTON_TITLES[action]}
      aria-label={ZOOM_BUTTON_TITLES[action]}
      disabled={disabled[action]}
      className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-rcd-text-2 transition-colors hover:bg-rcd-border hover:text-rcd-text disabled:pointer-events-none disabled:opacity-35"
      onPointerDown={press(action)}
      // Keyboard activation (Enter/Space fires click with detail 0) steps
      // once; pointer presses are fully handled above.
      onClick={(event) => {
        if (event.detail === 0) onStep(action);
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {ZOOM_ICONS[action]}
      </svg>
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label="Zoom controls"
      className="rcd-zoom-cluster absolute z-10 flex items-center gap-0.5 rounded-md border border-rcd-border bg-rcd-surface p-0.5 shadow-sm"
      style={style}
      // The plot's own double-click resets the view; double-pressing a
      // cluster button must not ALSO trigger it.
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {button('zoomOut')}
      {button('zoomIn')}
      <span aria-hidden className="mx-0.5 h-3.5 w-px bg-rcd-border" />
      {button('panLeft')}
      {button('panRight')}
      <span aria-hidden className="mx-0.5 h-3.5 w-px bg-rcd-border" />
      {button('reset')}
    </div>
  );
}

/** "No scale options" resolution: recharts defaults, nothing to warn about. */
const NO_AXIS_SCALE: ResolvedAxisScale = { logFallback: false };

/** Formats one measure value; seriesKey picks the column in measure-series mode. */
type ValueFormatter = (value: unknown, seriesKey?: string) => string;

/**
 * Synthetic measure column carrying format.valueFormat as its hint, so
 * formatCellValue's hint rules ("$" -> currency, "%" -> percent, else
 * thousands) apply unchanged.
 */
const formatHintColumn = (formatHint: string): QueryColumn => ({
  name: '__value',
  label: '',
  role: 'measure',
  type: 'decimal',
  source: null,
  dateBucket: null,
  formatHint,
});

/**
 * Is format.valueFormat a full Excel-style pattern (digit placeholders /
 * sections) rather than one of the legacy hint strings ("$", "%", "currency",
 * "percent")? Any `#`, `0` or `;` routes through formatNumberPattern (via
 * formatAxisValue kind 'custom'); bare hints keep the legacy path, so existing
 * specs render byte-identically.
 */
const looksLikeNumberPattern = (s: string): boolean => /[#0;]/.test(s);

/** valueFormat-aware number text: pattern engine or the legacy hint column. */
const valueFormatText = (value: number, valueFormat: string): string =>
  looksLikeNumberPattern(valueFormat)
    ? formatAxisValue(value, { kind: 'custom', pattern: valueFormat })
    : formatCellValue(value, formatHintColumn(valueFormat));

function makeValueFormatter(format: ChartFormat, measureColumns: QueryColumn[]): ValueFormatter {
  const valueFormat = format.valueFormat;
  return (value, seriesKey) => {
    if (typeof value !== 'number') return value == null ? '' : String(value);
    if (valueFormat) return valueFormatText(value, valueFormat);
    // measureNameForKey unwraps combo (measure × legend) dataKeys to their
    // measure column; plain keys pass through unchanged.
    const column =
      (seriesKey ? measureColumns.find((c) => c.name === measureNameForKey(seriesKey)) : undefined) ??
      measureColumns[0];
    return column ? formatCellValue(value, column) : String(value);
  };
}

/** Trailing-throttle window for onPointHover emission. */
const HOVER_THROTTLE_MS = 60;

/**
 * Trailing ~60ms throttle around onPointHover so chart-level mousemove can't
 * flood the consumer; the LATEST event in a window wins. A null (pointer left
 * the plot) cancels the window and flushes immediately — a highlight that
 * lingers after leave reads as lag. Returns undefined when there is no
 * consumer so children skip attaching handlers altogether.
 */
function useThrottledPointHover(
  cb: ((e: ChartPointEvent | null) => void) | undefined,
): ((e: ChartPointEvent | null) => void) | undefined {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ChartPointEvent | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const throttled = useMemo(
    () => (e: ChartPointEvent | null) => {
      if (e === null) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        pendingRef.current = null;
        cbRef.current?.(null);
        return;
      }
      pendingRef.current = e;
      if (timerRef.current) return; // the trailing emit picks up the latest
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (pendingRef.current) cbRef.current?.(pendingRef.current);
      }, HOVER_THROTTLE_MS);
    },
    [],
  );
  return cb ? throttled : undefined;
}

/** Legend placement + text style from spec.format; bottom is the default. */
function legendProps(format: ChartFormat) {
  const wrapperStyle = { ...legendWrapperStyle, ...textStyleToCss(format.legendStyle) };
  if (format.legendPosition === 'right') {
    return {
      layout: 'vertical',
      align: 'right',
      verticalAlign: 'middle',
      // Vertical legends size to their longest label; cap the wrapper so they
      // can never crowd out the plot (items ellipsize via `truncate`).
      wrapperStyle: { ...wrapperStyle, maxWidth: 'min(35%, 240px)' },
    } as const;
  }
  return {
    verticalAlign: format.legendPosition === 'top' ? 'top' : 'bottom',
    wrapperStyle,
  } as const;
}

/**
 * One legend entry: dataKey (visibility identity), display label, swatch
 * color. `raw`/`legendLabel` are present only when the entry is backed by a
 * legend-dimension value (or pie slice) — the identity crossFilter mode needs.
 */
export interface LegendItemDatum {
  key: string;
  label: string;
  color: string;
  raw?: CellValue;
  legendLabel?: string;
}

type LegendMode = NonNullable<ChartFormat['legendMode']>;

/**
 * Legend interaction state + handlers, built once in ChartRenderer and shared
 * by every chart shape (single cartesian, small-multiple grids, pie, scatter).
 * Handlers receive the full item list so isolate can compute "everything but
 * the clicked item" and crossFilter can resolve its identity fallback.
 */
export interface LegendControl {
  /** Configured mode; crossFilter may still fall back per chart (see effectiveLegendMode). */
  mode: LegendMode;
  hidden: ReadonlySet<string>;
  /** Consumer echo of the active legend cross-filter selection. */
  selectedLabel: string | null;
  /** `multi` = Ctrl/Cmd held (isolate multi-select). */
  onItemClick: (items: LegendItemDatum[], item: LegendItemDatum, multi: boolean) => void;
  /** Double-click reset: restore all series / clear the cross-filter. */
  onReset: (items: LegendItemDatum[]) => void;
}

/**
 * crossFilter needs a legend identity to filter by; when the series come from
 * measures (no item carries legendLabel) it falls back to isolate, per the
 * ChartFormat contract.
 */
const effectiveLegendMode = (mode: LegendMode, items: LegendItemDatum[]): LegendMode =>
  mode === 'crossFilter' && !items.some((i) => i.legendLabel !== undefined) ? 'isolate' : mode;

/** Hover hint describing what a legend click will do in the active mode. */
function legendItemTitle(
  mode: LegendMode,
  label: string,
  isHidden: boolean,
  isSelected: boolean,
  soleVisible: boolean,
): string {
  switch (mode) {
    case 'isolate':
      if (soleVisible) return 'Click to restore all (double-click also resets)';
      return isHidden
        ? `Click to isolate ${label}; Ctrl+click to add it`
        : `Click to isolate ${label}`;
    case 'crossFilter':
      return isSelected ? 'Click to clear the cross-filter' : `Click to cross-filter by ${label}`;
    default:
      return isHidden ? `Show ${label}` : `Hide ${label}`;
  }
}

/**
 * Power BI-style clickable legend, rendered as recharts Legend `content` so it
 * inherits placement + wrapperStyle (fontSize/color cascade to the buttons via
 * the preflight `color: inherit`). Items come from OUR series list — never the
 * recharts payload, which omits series we filtered out — so hidden entries stay
 * visible (dimmed + struck-through) and can be toggled back. Double-clicking
 * anywhere on the list resets (restores all / clears the cross-filter).
 */
function InteractiveLegendContent({
  items,
  control,
  layout,
  interactive = true,
}: {
  items: LegendItemDatum[];
  control: LegendControl;
  layout: 'horizontal' | 'vertical';
  /** Small-multiple grids render this list even when legendInteractive === false. */
  interactive?: boolean;
}) {
  const mode = effectiveLegendMode(control.mode, items);
  const visibleCount = items.filter((i) => !control.hidden.has(i.key)).length;
  return (
    <ul
      className={
        layout === 'vertical'
          ? 'flex w-full flex-col items-start gap-1 pl-2'
          : 'flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1'
      }
      onDoubleClick={interactive ? () => control.onReset(items) : undefined}
    >
      {items.map((item, i) => {
        const isHidden = control.hidden.has(item.key);
        const isSelected =
          mode === 'crossFilter' &&
          control.selectedLabel !== null &&
          (item.legendLabel ?? item.label) === control.selectedLabel;
        // With an active cross-filter selection every OTHER item dims, so the
        // selected one reads as the page-wide focus.
        const dimmedBySelection =
          mode === 'crossFilter' && control.selectedLabel !== null && !isSelected;
        return (
          <li key={`${i}-${item.key}`} className="min-w-0 max-w-full">
            <button
              type="button"
              onClick={
                interactive
                  ? (e) => control.onItemClick(items, item, e.ctrlKey || e.metaKey)
                  : undefined
              }
              title={
                interactive
                  ? legendItemTitle(
                      mode,
                      item.label,
                      isHidden,
                      isSelected,
                      !isHidden && visibleCount === 1,
                    )
                  : undefined
              }
              // Fixed row height keeps vertical legends evenly ribbed and
              // gives every item the same (larger-than-swatch) hit target.
              className={`flex h-5 min-w-0 max-w-full items-center gap-1.5 ${
                interactive ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{
                  background: item.color,
                  opacity: isHidden ? 0.35 : dimmedBySelection ? 0.45 : 1,
                }}
              />
              <span
                className={`truncate ${
                  isHidden ? 'line-through opacity-45' : dimmedBySelection ? 'opacity-45' : ''
                } ${isSelected ? 'font-semibold' : ''}`}
              >
                {item.label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Legend element for one chart: interactive (clicks act per format.legendMode)
 * unless format.legendInteractive === false, which falls back to the plain
 * recharts legend. Placement/text style (legendPosition/legendStyle) apply to
 * both variants.
 */
export function chartLegend(
  format: ChartFormat,
  items: LegendItemDatum[],
  control: LegendControl,
): ReactNode {
  const placement = legendProps(format);
  if (format.legendInteractive === false) return <Legend {...placement} />;
  return (
    <Legend
      {...placement}
      content={
        <InteractiveLegendContent
          items={items}
          control={control}
          layout={format.legendPosition === 'right' ? 'vertical' : 'horizontal'}
        />
      }
    />
  );
}

/** Numeric tick formatter honoring an AxisValueFormat ('auto' when unset). */
const axisTickFormatter =
  (axisFormat: AxisValueFormat | undefined) =>
  (value: unknown): string =>
    typeof value === 'number' ? formatAxisValue(value, axisFormat) : String(value);

/** strokeDasharray for a format.lineStyles dash preset; solid = none. */
const strokeDash = (style: SeriesLineStyle | undefined): string | undefined =>
  style?.dash === 'dashed' ? '8 5' : style?.dash === 'dotted' ? '2 4' : undefined;

/**
 * strokeDasharray for reference-line / trendline overlays. Unset reads as
 * dashed — the conventional guide look, and it keeps overlays visually
 * distinct from the solid data marks.
 */
const guideDash = (dash: 'solid' | 'dashed' | 'dotted' | undefined): string | undefined =>
  dash === 'solid' ? undefined : dash === 'dotted' ? '2 3' : '6 4';

/** SVG text attributes for an axis title; theme defaults unless styled. */
const axisTitleTextProps = (style: TextStyle | undefined) => ({
  fontSize: style?.fontSize ?? 11,
  fill: style?.color ?? 'var(--rcd-text-2)',
  fontWeight: style?.bold ? 600 : undefined,
  fontStyle: style?.italic ? ('italic' as const) : undefined,
});

const xAxisLabelProps = (text: string | undefined, style?: TextStyle) =>
  text
    ? {
        value: text,
        position: 'insideBottom' as const,
        offset: -4,
        ...axisTitleTextProps(style),
      }
    : undefined;

const yAxisLabelProps = (text: string | undefined, style?: TextStyle) =>
  text
    ? {
        value: text,
        angle: -90,
        position: 'insideLeft' as const,
        offset: 8,
        ...axisTitleTextProps(style),
      }
    : undefined;

/** Right-hand (y2) axis title: mirrors the left, rotated the other way. */
const y2AxisLabelProps = (text: string | undefined, style?: TextStyle) =>
  text
    ? {
        value: text,
        angle: 90,
        position: 'insideRight' as const,
        offset: 8,
        ...axisTitleTextProps(style),
      }
    : undefined;

/**
 * dataKeys of the series plotted on the secondary (right) axis. Assignment
 * matches format.secondaryAxisKeys against the series' display-name key
 * (styleKey / label) OR the MEASURE display name behind it — so listing a
 * measure moves every (measure × legend) combo series of that measure at
 * once, while an exact full combo name still targets one series.
 *
 * STACK RULE: a stack must live on ONE axis — recharts computes stack offsets
 * per axis, so splitting members across axes would draw two half-stacks with
 * independent baselines and lie about totals. If ANY member is assigned, the
 * WHOLE stack moves to y2.
 */
function secondarySeriesKeys(
  series: ChartSeries[],
  format: ChartFormat,
  stacked: boolean,
): Set<string> {
  const assigned = format.secondaryAxisKeys ?? [];
  if (assigned.length === 0) return new Set();
  const names = new Set(assigned);
  const matches = (s: ChartSeries) =>
    names.has(s.styleKey) ||
    names.has(s.label) ||
    (s.measureLabel !== undefined && names.has(s.measureLabel));
  const hits = series.filter(matches);
  if (hits.length === 0) return new Set();
  if (stacked) return new Set(series.map((s) => s.key));
  return new Set(hits.map((s) => s.key));
}

/**
 * Base margins, widened when an axis title needs room. Rich-HTML titles render
 * OUTSIDE the plot (AxisTitleFrame reserves their space in flow), so they
 * suppress both the SVG label and its margin allowance.
 */
const chartMargin = (format: ChartFormat, extras?: { bottom?: boolean; left?: boolean }) => ({
  top: 8,
  right: 12,
  bottom: (format.xAxisLabel && !format.xAxisLabelHtml) || extras?.bottom ? 18 : 4,
  left: (format.yAxisLabel && !format.yAxisLabelHtml) || extras?.left ? 8 : 4,
});

/**
 * Rich-HTML axis titles (format.xAxisLabelHtml / yAxisLabelHtml). Instead of
 * absolute overlays fighting recharts margins, the frame RESERVES their space
 * in normal flow: y title in a left rail (vertical writing mode rotated 180°
 * so it reads bottom-up, matching the SVG -90° label), x title in a strip
 * centered below the plot. The chart shrinks accordingly, so titles can never
 * overlap ticks at any size. Content is sanitized again at render (belt on top
 * of the editor's write-time sanitize). Small-multiple grids wrap the WHOLE
 * grid — one shared pair of titles, not per panel. When neither html title is
 * set the frame is a pass-through and the plain xAxisLabel/yAxisLabel SVG
 * labels keep working untouched.
 */
function AxisTitleFrame({
  format,
  y2 = false,
  children,
}: {
  format: ChartFormat;
  /**
   * Secondary-axis intent: the chart type supports y2 and secondaryAxisKeys
   * is non-empty. Gates the RIGHT rail (y2AxisLabelHtml) — a right title on a
   * chart with no right axis would just be confusing.
   */
  y2?: boolean;
  children: ReactNode;
}) {
  const xHtml = useMemo(
    () => (format.xAxisLabelHtml ? sanitizeRichHtml(format.xAxisLabelHtml) : ''),
    [format.xAxisLabelHtml],
  );
  const yHtml = useMemo(
    () => (format.yAxisLabelHtml ? sanitizeRichHtml(format.yAxisLabelHtml) : ''),
    [format.yAxisLabelHtml],
  );
  const y2Html = useMemo(
    () => (y2 && format.y2AxisLabelHtml ? sanitizeRichHtml(format.y2AxisLabelHtml) : ''),
    [y2, format.y2AxisLabelHtml],
  );
  if (xHtml === '' && yHtml === '' && y2Html === '') return <>{children}</>;
  return (
    <div className="flex h-full w-full min-w-0">
      {yHtml !== '' && (
        <div className="flex shrink-0 items-center justify-center pl-0.5">
          <div
            className="max-h-full overflow-hidden text-xs text-rcd-text-2"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
            dangerouslySetInnerHTML={{ __html: yHtml }}
          />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
        {xHtml !== '' && (
          <div
            className="shrink-0 overflow-hidden px-2 pb-1 pt-0.5 text-center text-xs text-rcd-text-2"
            dangerouslySetInnerHTML={{ __html: xHtml }}
          />
        )}
      </div>
      {y2Html !== '' && (
        // Right rail mirroring the left one; unrotated vertical-rl reads
        // top-down — the conventional direction for a right-side axis title.
        <div className="flex shrink-0 items-center justify-center pr-0.5">
          <div
            className="max-h-full overflow-hidden text-xs text-rcd-text-2"
            style={{ writingMode: 'vertical-rl' }}
            dangerouslySetInnerHTML={{ __html: y2Html }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One <ReferenceLine> from a spec + resolved value. `axis` names the VALUE
 * axis it sits on ('y' normally, 'x' on horizontal bar charts). Recharts'
 * default z-order already paints ReferenceLine above bars/areas and below the
 * tooltip, which is exactly the layering we want.
 */
function guideReferenceLine(
  ref: ReferenceLineSpec,
  value: number,
  axis: 'x' | 'y',
  formatText: (value: number) => string,
  /** Value-axis id ('y2' anchors to the secondary right axis). */
  yAxisId?: string,
): ReactNode {
  const color = ref.color ?? 'var(--rcd-muted)';
  // Label: explicit label, else "<kind> <formatted value>". 'constant' keeps
  // just the value — "constant 42" reads like a bug.
  const prefix = ref.kind === 'constant' ? '' : `${ref.kind} `;
  return (
    <ReferenceLine
      key={ref.id}
      {...(yAxisId ? { yAxisId } : null)}
      {...(axis === 'x' ? { x: value } : { y: value })}
      stroke={color}
      strokeWidth={ref.width ?? 1}
      strokeDasharray={guideDash(ref.dash)}
      // Constants can sit outside the data range; grow the domain so the
      // guide is always visible instead of silently clipping.
      ifOverflow="extendDomain"
      label={
        ref.showLabel !== false
          ? {
              value: `${prefix}${formatText(value)}`,
              position: axis === 'x' ? ('insideTop' as const) : ('insideTopRight' as const),
              fill: color,
              fontSize: 10,
            }
          : undefined
      }
    />
  );
}

type TooltipCursor = 'fill' | 'dashed' | 'none';

/**
 * What the hovered datum LOOKS like on the plot — the shape the tooltip card
 * has to dodge:
 * - 'bars'   a whole category slot, from the value-axis baseline to the
 *            tallest (or stacked) bar end: a column (or a row on horizontal
 *            bars).
 * - 'points' the marks of every series at the active category (line/area):
 *            small discs sitting on one category slot.
 * - 'point'  a single item AT the active coordinate (scatter): the coordinate
 *            is the datum.
 * - 'none'   nothing cartesian to dodge (pie/donut); only the pointer itself.
 */
type TooltipMarks = 'bars' | 'points' | 'point' | 'none';

/** Default marks for a cursor style, so new chart kinds get sane placement. */
const marksForCursor = (cursor: TooltipCursor): TooltipMarks =>
  cursor === 'fill' ? 'bars' : cursor === 'dashed' ? 'points' : 'none';

/** Shape of one recharts tooltip payload entry (the fields we read). */
export interface TooltipPayloadEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: string | number;
  payload?: unknown;
  /** Recharts tooltipType echo: 'none' = the series opted out of tooltips. */
  type?: string;
}

/**
 * TOOLTIP LEAK FIX: recharts hands CUSTOM tooltip content the raw payload,
 * including entries whose series opted out via `tooltipType="none"` — only
 * recharts' DEFAULT content filters those, so trendline overlays surfaced as
 * `__trend:<id>:<key>` rows in our card. Drop opted-out entries AND anything
 * riding a synthetic `__`-prefixed dataKey (`__trend:`, `__rawAxis`, …):
 * internal keys must never render as tooltip rows. Real series always carry
 * wire column names (never `__`-prefixed; combo keys use U+001F separators
 * and are name-labelled upstream), so nothing legitimate matches.
 */
const visibleTooltipEntries = (
  payload: TooltipPayloadEntry[] | undefined,
): TooltipPayloadEntry[] =>
  (payload ?? []).filter(
    (entry) =>
      entry.type !== 'none' &&
      !(typeof entry.dataKey === 'string' && entry.dataKey.startsWith('__')),
  );

/* -------------------------------------------------------------------------
 * Smart tooltip placement
 *
 * Everything below works in ONE coordinate space: pixels relative to the chart
 * container (recharts' `.recharts-wrapper`), which is the space of the tooltip
 * `coordinate`, of usePlotArea() and of useChartWidth()/useChartHeight().
 * ---------------------------------------------------------------------- */

/** A pixel box in chart-container space. */
interface TipBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Gap kept between the card and the cursor / the data it is dodging. */
const TIP_GAP = 12;
/** Breathing room between the card and whatever it is clamped inside. */
const TIP_EDGE = 4;
/** Half-size of the "never sit under the pointer / the dot" box. */
const TIP_PAD = 10;
/** Assumed half-width of a bar slot when the axis can't report its band. */
const TIP_BAND_FALLBACK = 20;
/** Widest the card may get before wrapping (also capped by the container). */
const TIP_MAX_W = 280;

const tipOverlap = (a: TipBox, b: TipBox): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * A later candidate has to beat an earlier one by this much before it wins.
 * Keeps the preference order sticky so the card doesn't hop between spots as
 * the pointer drifts a few pixels.
 */
const TIP_STICKY = 400;

/**
 * Price (in px² of covered data) of moving the card one px further from the
 * pointer. A tooltip that dodges every mark but lands in a far corner is worse
 * than one that clips a neighbouring bar, so distance has to be paid for: at
 * this rate a detour of 100px must save ~12% of the card's own area in
 * coverage to be worth it, which keeps the corner pins as a real last resort.
 */
const TIP_NEAR = 12;

/** Distance from a point to the nearest edge of a box (0 when inside). */
const tipDistance = (box: TipBox, p: { x: number; y: number }): number =>
  Math.hypot(
    Math.max(box.left - p.x, 0, p.x - box.right),
    Math.max(box.top - p.y, 0, p.y - box.bottom),
  );

/**
 * Picks the top-left corner of the tooltip card. Candidates are tried in
 * preference order:
 *
 *   1. above-right of the pointer, pushed clear of the active column
 *   2. flip horizontally — above-left
 *   3. below-right, 4. below-left
 *   5-7. above the DATA itself (works where 1-4 can't: a short bar in a narrow
 *        tile has no room beside it but plenty over it), centred then nudged
 *        to either side
 *   8. under the data
 *   9-12. pinned to a plot-area corner — the "nothing fits" backstop
 *
 * Scoring is two-tier. `avoid` (the hovered marks plus the pointer) is a HARD
 * constraint: a candidate covering any of it is only used when nothing else is
 * left, and then the least-covering one wins. Among candidates that clear it,
 * `neighbours` (every other rendered mark) breaks the tie, so the card prefers
 * genuine whitespace over sitting on the bars next door — subject to TIP_STICKY
 * so the ordering above still decides near-ties.
 *
 * Every candidate is clamped into `bounds` BEFORE it is scored, so a candidate
 * that only fits by sliding back over the data loses to one that genuinely
 * fits: clamping and dodging are decided together rather than in sequence.
 */
function placeTooltip(
  cursor: { x: number; y: number },
  size: { w: number; h: number },
  /** The region the card must not cover (active marks + the pointer). */
  avoid: TipBox,
  plot: TipBox,
  container: TipBox,
  /** Other rendered marks, used only to break ties. Empty when unknown. */
  neighbours: readonly TipBox[] = [],
): { x: number; y: number } {
  const { w, h } = size;
  // Clamp inside the PLOT when the card fits there (keeps it off the axes
  // and legend); fall back to the whole container in tiny tiles, where
  // insisting on the plot area would leave nowhere to stand.
  const fitsPlot =
    w + 2 * TIP_EDGE <= plot.right - plot.left && h + 2 * TIP_EDGE <= plot.bottom - plot.top;
  const bounds = fitsPlot ? plot : container;
  const minX = bounds.left + TIP_EDGE;
  const minY = bounds.top + TIP_EDGE;
  const maxX = Math.max(minX, bounds.right - TIP_EDGE - w);
  const maxY = Math.max(minY, bounds.bottom - TIP_EDGE - h);

  // Horizontal anchors clear the active column (a bar slot is wide, and the
  // coordinate sits at its CENTRE — offsetting from the cursor alone is what
  // parks the card on top of the bars). Vertical anchors follow the pointer so
  // the card still tracks the mouse.
  const xRight = Math.max(cursor.x, avoid.right) + TIP_GAP;
  const xLeft = Math.min(cursor.x, avoid.left) - TIP_GAP - w;
  const xCentre = cursor.x - w / 2;
  const yAbove = cursor.y - TIP_GAP - h;
  const yBelow = cursor.y + TIP_GAP;
  const yOver = avoid.top - TIP_GAP - h;
  const yUnder = avoid.bottom + TIP_GAP;

  const candidates: ReadonlyArray<readonly [number, number]> = [
    [xRight, yAbove],
    [xLeft, yAbove],
    [xRight, yBelow],
    [xLeft, yBelow],
    [xCentre, yOver],
    [xRight, yOver],
    [xLeft, yOver],
    [xCentre, yUnder],
    [plot.right - TIP_EDGE - w, plot.top + TIP_EDGE],
    [plot.left + TIP_EDGE, plot.top + TIP_EDGE],
    [plot.right - TIP_EDGE - w, plot.bottom - TIP_EDGE - h],
    [plot.left + TIP_EDGE, plot.bottom - TIP_EDGE - h],
  ];

  let clear: { x: number; y: number } | null = null;
  let clearCost = Number.POSITIVE_INFINITY;
  let fallback = { x: minX, y: minY };
  let fallbackCost = Number.POSITIVE_INFINITY;
  for (const [rawX, rawY] of candidates) {
    const x = Math.min(Math.max(rawX, minX), maxX);
    const y = Math.min(Math.max(rawY, minY), maxY);
    const box: TipBox = { left: x, top: y, right: x + w, bottom: y + h };
    const reach = TIP_NEAR * tipDistance(box, cursor);
    const hard = tipOverlap(box, avoid);
    if (hard > 0) {
      const cost = hard + reach;
      if (cost < fallbackCost - TIP_STICKY || fallbackCost === Number.POSITIVE_INFINITY) {
        fallbackCost = cost;
        fallback = { x, y };
      }
      continue;
    }
    let cost = reach;
    for (const mark of neighbours) cost += tipOverlap(box, mark);
    if (cost < clearCost - TIP_STICKY || clear === null) {
      clearCost = cost;
      clear = { x, y };
    }
  }
  return clear ?? fallback;
}

/**
 * Measures the tooltip card once per SIZE change (ResizeObserver) instead of
 * reading layout on every pointer move — recharts re-renders tooltip content
 * on every mousemove, so a getBoundingClientRect in the render path would
 * thrash. The last size survives the card unmounting, so re-entering a chart
 * lands correctly on the first frame instead of flashing at a stale spot.
 */
function useTooltipCardSize(
  ref: RefObject<HTMLDivElement | null>,
  mounted: boolean,
): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!mounted || el === null) return;
    const read = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w <= 0 || h <= 0) return;
      setSize((prev) =>
        prev !== null && Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5
          ? prev
          : { w, h },
      );
    };
    // Read once up front: without a measurement there is no placement, and the
    // card stays hidden — so this must not depend on ResizeObserver existing.
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, mounted]);
  return size;
}

/** Past this many rendered bars the chart has no whitespace worth hunting. */
const TIP_MAX_NEIGHBOURS = 400;

/**
 * Rectangles of the rendered bars, in chart-container px, so placement can
 * prefer whitespace over the bars NEXT TO the hovered one (the user-visible
 * failure: a card parked on the neighbouring column). Bars are the only marks
 * read here — a line/area is one path whose bounding box is the whole series,
 * which would say "everything is covered" and help nobody.
 *
 * Bar geometry only moves when the chart is re-laid out, so this reads once
 * per hover session (and again if the plot resizes) rather than per pointer
 * move; measurement happens in an effect, never during render.
 */
function useNeighbourMarks(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  plotKey: string,
): readonly TipBox[] {
  const [marks, setMarks] = useState<readonly TipBox[]>([]);
  useEffect(() => {
    const wrapper = ref.current?.closest('.recharts-wrapper');
    if (!enabled || wrapper == null) {
      setMarks((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const nodes = wrapper.querySelectorAll('.recharts-bar-rectangle');
    if (nodes.length === 0 || nodes.length > TIP_MAX_NEIGHBOURS) {
      setMarks((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const origin = wrapper.getBoundingClientRect();
    const next: TipBox[] = [];
    nodes.forEach((node) => {
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      next.push({
        left: r.left - origin.left,
        top: r.top - origin.top,
        right: r.right - origin.left,
        bottom: r.bottom - origin.top,
      });
    });
    setMarks(next);
  }, [ref, enabled, plotKey]);
  return marks;
}

/** Series color for a tooltip row: entry.color, else the datum's own (pie). */
const tooltipEntryColor = (entry: TooltipPayloadEntry): string => {
  if (entry.color) return entry.color;
  const datum = entry.payload;
  if (datum && typeof datum === 'object' && 'color' in datum) {
    const color = (datum as { color?: unknown }).color;
    if (typeof color === 'string') return color;
  }
  return 'var(--rcd-text-2)';
};

/**
 * Themed tooltip card replacing the recharts default. Rounded surface/border
 * card (format.tooltip background/textColor override the tokens); category
 * header; one row per series with a colored left accent bar (accentBorder,
 * default) or a small square swatch, secondary series name, and the formatted
 * value leading in weight. showPercent appends the share of the VISIBLE total.
 * active/payload/label/coordinate are injected by recharts when it clones the
 * element.
 *
 * PLACEMENT lives here rather than on <Tooltip> because only the content knows
 * its own rendered size: recharts' wrapper is pinned to the container origin
 * (position={TIP_ORIGIN}) and the card translates itself. See placeTooltip for
 * the decision order; the active-data region is derived from the axis scales,
 * so the math is pure arithmetic — no DOM probing on the hover path.
 */
export function RcdChartTooltip({
  active,
  payload,
  label,
  coordinate,
  styleSpec,
  formatEntry,
  showPercent = false,
  percentTotal,
  marks = 'none',
  stacked = false,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  /** Active point in chart-container px (recharts-injected). */
  coordinate?: { x?: number; y?: number };
  styleSpec: TooltipStyle | undefined;
  formatEntry: (value: unknown, dataKey: string | undefined) => string;
  showPercent?: boolean;
  /** Percent denominator override (pie: visible-slice total); else payload sum. */
  percentTotal?: number;
  /** Shape of the hovered datum, for the dodge math. */
  marks?: TooltipMarks;
  /** Stacked series: the mark ends at the CUMULATIVE value, not each value. */
  stacked?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Synthetic/opted-out payload entries never become rows — and everything
  // below (visibility, dodge spans, percent totals) reads the FILTERED list,
  // so hidden entries can't skew the math either.
  const entries = useMemo(() => visibleTooltipEntries(payload), [payload]);
  const visible = active === true && entries.length > 0;
  const cardSize = useTooltipCardSize(cardRef, visible);

  // Chart geometry straight from the recharts store (this component renders
  // inside the chart's context, through recharts' own portal): no DOM reads,
  // and every value is already in chart-container pixels.
  const plotArea = usePlotArea();
  const chartWidth = useChartWidth();
  const chartHeight = useChartHeight();
  const layout = useChartLayout();
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const y2Scale = useYAxisScale('y2');
  // Horizontal bars ('vertical' layout): categories run down the Y axis and
  // values along X, so the two spans below swap axes.
  const rowsVertical = layout === 'vertical';
  // Re-read bar geometry only when the plot itself moves or resizes.
  const neighbours = useNeighbourMarks(
    cardRef,
    visible && marks === 'bars',
    `${plotArea?.x ?? 0}:${plotArea?.y ?? 0}:${plotArea?.width ?? 0}:${plotArea?.height ?? 0}`,
  );

  /**
   * Where the active marks sit, per axis, in container px:
   * - `value` spans baseline→bar end (bars) or dot→dot (points);
   * - `cross` is the category band, read exactly off the band scale via the
   *   'start'/'end' band positions rather than guessed from tick spacing.
   * Depends on the payload, not on the pointer, so it survives mouse moves
   * inside one category.
   */
  const span = useMemo(() => {
    const valueScales = (rowsVertical ? [xScale] : [yScale, y2Scale]).filter(
      (s): s is NonNullable<typeof s> => s != null,
    );
    let value: { min: number; max: number } | null = null;
    if ((marks === 'bars' || marks === 'points') && entries.length > 0 && valueScales.length > 0) {
      const numbers = entries
        .map((entry) => entry.value)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      // Stacked marks end at the running total; grouped/overlaid marks each
      // end at their own value. Dual axis: union both mappings (we can't tell
      // from the payload which axis an entry belongs to, and a region that is
      // slightly too big only makes the card dodge a little further).
      const ends = stacked ? [numbers.reduce((sum, v) => sum + v, 0)] : numbers;
      const points: number[] = [];
      for (const scale of valueScales) {
        for (const end of ends) {
          const px = scale(end);
          if (typeof px === 'number' && Number.isFinite(px)) points.push(px);
        }
        // Bars are anchored to the zero baseline, so the column is the whole
        // span from baseline to end, not just the end.
        if (marks === 'bars') {
          const zero = scale(0);
          if (typeof zero === 'number' && Number.isFinite(zero)) points.push(zero);
        }
      }
      if (points.length > 0) {
        const pad = marks === 'points' ? TIP_PAD : 0;
        value = { min: Math.min(...points) - pad, max: Math.max(...points) + pad };
      }
    }
    let cross: { min: number; max: number } | null = null;
    const catScale = rowsVertical ? yScale : xScale;
    if (marks === 'bars' && catScale != null && label !== undefined) {
      const start = catScale(label, { position: 'start' });
      const end = catScale(label, { position: 'end' });
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        Math.abs(end - start) > 1
      ) {
        cross = { min: Math.min(start, end), max: Math.max(start, end) };
      }
    }
    return { value, cross };
  }, [entries, label, marks, stacked, rowsVertical, xScale, yScale, y2Scale]);

  // Resolve the boxes, then place. Until the card has been measured once we
  // render it hidden rather than guessing a size and jumping.
  const cx = coordinate?.x;
  const cy = coordinate?.y;
  let placement: { x: number; y: number } | null = null;
  let boundsWidth: number | undefined;
  let boundsHeight: number | undefined;
  if (cardSize !== null && typeof cx === 'number' && typeof cy === 'number') {
    const hasPlot = plotArea != null && plotArea.width > 0 && plotArea.height > 0;
    const plot: TipBox = hasPlot
      ? {
          left: plotArea.x,
          top: plotArea.y,
          right: plotArea.x + plotArea.width,
          bottom: plotArea.y + plotArea.height,
        }
      : { left: 0, top: 0, right: chartWidth ?? 0, bottom: chartHeight ?? 0 };
    const container: TipBox = {
      left: 0,
      top: 0,
      right: chartWidth != null && chartWidth > 0 ? chartWidth : plot.right,
      bottom: chartHeight != null && chartHeight > 0 ? chartHeight : plot.bottom,
    };
    boundsWidth = container.right;
    boundsHeight = container.bottom;
    // Category band around the pointer; a bare pointer pad when there is no
    // band to speak of (scatter items, pie sectors, numeric line axes).
    const crossAt = rowsVertical ? cy : cx;
    const cross = span.cross ?? {
      min: crossAt - (marks === 'bars' ? TIP_BAND_FALLBACK : TIP_PAD),
      max: crossAt + (marks === 'bars' ? TIP_BAND_FALLBACK : TIP_PAD),
    };
    const valueAt = rowsVertical ? cx : cy;
    const value = span.value ?? { min: valueAt - TIP_PAD, max: valueAt + TIP_PAD };
    const marksBox: TipBox = rowsVertical
      ? { left: value.min, top: cross.min, right: value.max, bottom: cross.max }
      : { left: cross.min, top: value.min, right: cross.max, bottom: value.max };
    // Clip to the plot (a scale can project a baseline far outside it) and
    // union the pointer itself, so the card never lands under the cursor.
    const avoid: TipBox = {
      left: Math.min(Math.max(marksBox.left, plot.left), cx - TIP_PAD),
      top: Math.min(Math.max(marksBox.top, plot.top), cy - TIP_PAD),
      right: Math.max(Math.min(marksBox.right, plot.right), cx + TIP_PAD),
      bottom: Math.max(Math.min(marksBox.bottom, plot.bottom), cy + TIP_PAD),
    };
    placement = placeTooltip({ x: cx, y: cy }, cardSize, avoid, plot, container, neighbours);
  }

  if (!visible) return null;
  const accent = styleSpec?.accentBorder !== false;
  const card: CSSProperties = {
    background: styleSpec?.background || 'var(--rcd-surface)',
    color: styleSpec?.textColor || 'var(--rcd-text)',
    // Capping against the container is what makes "always fits" true rather
    // than best-effort: a card wider/taller than the tile can't be clamped
    // into it, so it is never allowed to get that big in the first place.
    maxWidth:
      boundsWidth != null && boundsWidth > 0
        ? Math.min(TIP_MAX_W, Math.max(120, boundsWidth - 2 * TIP_EDGE))
        : TIP_MAX_W,
    ...(boundsHeight != null && boundsHeight > 0
      ? { maxHeight: Math.max(48, boundsHeight - 2 * TIP_EDGE), overflow: 'hidden' }
      : null),
    transform: placement ? `translate(${placement.x}px, ${placement.y}px)` : undefined,
    visibility: placement ? undefined : 'hidden',
  };
  const total =
    percentTotal ??
    entries.reduce((sum, e) => sum + (typeof e.value === 'number' ? e.value : 0), 0);
  return (
    <div
      ref={cardRef}
      className="max-w-[280px] rounded-lg border border-rcd-border px-3 py-2 text-xs shadow-md"
      style={card}
    >
      {label !== undefined && label !== '' && (
        <div className="mb-1 truncate font-medium">{String(label)}</div>
      )}
      <div className="flex flex-col gap-1">
        {entries.map((entry, i) => {
          const dataKey = typeof entry.dataKey === 'string' ? entry.dataKey : undefined;
          const color = tooltipEntryColor(entry);
          const share =
            showPercent && total > 0 && typeof entry.value === 'number'
              ? ` (${((entry.value / total) * 100).toFixed(1)}%)`
              : '';
          return (
            <div key={`${i}-${dataKey ?? ''}`} className="flex items-center gap-1.5">
              {accent ? (
                <span
                  aria-hidden
                  className="h-3 w-[2.5px] shrink-0 rounded-full"
                  style={{ background: color }}
                />
              ) : (
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ background: color }}
                />
              )}
              <span className="min-w-0 flex-1 truncate opacity-70">
                {entry.name != null ? String(entry.name) : ''}
              </span>
              <span className="shrink-0 text-right font-medium tabular-nums">
                {formatEntry(entry.value, dataKey)}
                {share}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Pins recharts' tooltip wrapper to the chart container's origin so the card
 * can position itself (see RcdChartTooltip). Module-level for a stable
 * identity — the wrapper is memoized on its props.
 */
export const TIP_ORIGIN: { x: number; y: number } = { x: 0, y: 0 };

/**
 * Tooltip element for one chart (all types share it); null when
 * format.tooltip.enabled === false. `percent` marks the chart shapes where
 * showPercent applies (pie/donut/stacked) and optionally pins the denominator.
 * `marks` overrides the mark shape the placement math dodges when the cursor
 * style doesn't imply it (scatter: a dashed cursor, but a single item).
 */
function themedTooltip(
  formatEntry: (value: unknown, dataKey: string | undefined) => string,
  format: ChartFormat,
  cursor: TooltipCursor,
  percent?: { active: boolean; total?: number },
  marks?: TooltipMarks,
): ReactNode {
  if (format.tooltip?.enabled === false) return null;
  // Hover affordances, shadcn-style: bars get a soft muted rectangle behind
  // the hovered category; line/area/scatter get a dashed vertical hairline.
  const cursorProp =
    cursor === 'fill'
      ? { fill: 'var(--rcd-text)', fillOpacity: 0.04 }
      : cursor === 'dashed'
        ? { stroke: 'var(--rcd-axis)', strokeDasharray: '3 3' }
        : false;
  return (
    <Tooltip
      cursor={cursorProp}
      isAnimationActive={false}
      // Recharts' own placement (offset from the cursor, flipped at the view
      // box edge) can't see the bars it is covering and clamps to the plot box
      // only. We take it over: the wrapper is parked at the container origin
      // with zero offset, and RcdChartTooltip translates the card to a spot
      // computed from the tooltip's measured size, the plot area and the
      // active marks. The card still tends above/right of the pointer.
      position={TIP_ORIGIN}
      offset={0}
      content={
        <RcdChartTooltip
          styleSpec={format.tooltip}
          formatEntry={formatEntry}
          showPercent={percent?.active === true && format.tooltip?.showPercent === true}
          percentTotal={percent?.total}
          marks={marks ?? marksForCursor(cursor)}
          // The one caller that passes `percent.active` on a cartesian chart
          // is the stacked path; pie is 'none' and has no stacking.
          stacked={percent?.active === true && cursor !== 'none'}
        />
      }
    />
  );
}

/**
 * Pie/donut only: anchors the legend to the chart instead of letting
 * ResponsiveContainer stretch across a wide tile (which parks the pie in the
 * middle of the leftover space and glues a right legend to the far edge).
 * Width is capped at the pie's natural footprint — the container height (the
 * pie is height-bound) plus room for a right legend or a small side pad — and
 * the capped box is centered, so the legend hugs the pie at any tile width.
 * Measurement is a ResizeObserver debounced like ResponsiveContainer's
 * re-measures; until the first measure lands we render full-width.
 */
function CenteredPieFrame({ legendRight, children }: { legendRight: boolean; children: ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const frameSize = useDebouncedSize(frameRef);
  const width =
    frameSize === null
      ? '100%'
      : Math.min(
          frameSize.width,
          frameSize.height + (legendRight ? PIE_RIGHT_LEGEND_WIDTH : PIE_SIDE_PAD),
        );
  return (
    <div ref={frameRef} className="flex h-full w-full justify-center">
      <div className="h-full" style={{ width }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Donut-hole total, rendered INSIDE the recharts tree so it reads the real
 * plot area (which already accounts for legend placement) via usePlotArea.
 * Radii mirror the <Pie> percentages (inner 55% / max radius = half the
 * smaller plot dimension). Hidden when the hole is too small to read; the
 * value font shrinks to fit the hole before giving up.
 */
function DonutCenterTotal({ text }: { text: string }) {
  const plotArea = usePlotArea();
  if (!plotArea || plotArea.width <= 0 || plotArea.height <= 0) return null;
  const innerRadius = (Math.min(plotArea.width, plotArea.height) / 2) * 0.55;
  if (innerRadius < 32) return null;
  const cx = plotArea.x + plotArea.width / 2;
  const cy = plotArea.y + plotArea.height / 2;
  // Fit the formatted total inside the hole (~0.62em average glyph width).
  const maxTextWidth = innerRadius * 1.7;
  const fontSize = Math.max(
    11,
    Math.min(20, innerRadius * 0.32, maxTextWidth / Math.max(1, text.length * 0.62)),
  );
  return (
    <g pointerEvents="none" aria-hidden>
      <text
        x={cx}
        y={cy - fontSize * 0.55}
        textAnchor="middle"
        fontSize={10}
        fill="var(--rcd-muted)"
      >
        Total
      </text>
      <text
        x={cx}
        y={cy + fontSize * 0.72}
        textAnchor="middle"
        fontSize={fontSize}
        fontWeight={600}
        fill="var(--rcd-text)"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {text}
      </text>
    </g>
  );
}

export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-rcd-muted">
      {children}
    </div>
  );
}

/** Invisible symbol for helper Scatters that only exist to draw their line. */
const noShape = () => null;

/** Per-panel rendering context when the chart is one small-multiples panel. */
interface PanelContext {
  /** RAW small-multiples cell of this panel (rides into point events). */
  smallMultipleValue: CellValue;
  /** Edge-panel tick visibility (Power BI style; see SmallMultiplesChart). */
  showXTicks: boolean;
  showYTicks: boolean;
  /** Shared value-axis domain when format.smallMultiples.sharedY. */
  valueDomain?: [number, number];
  /** Narrow panels drop data labels to stay readable. */
  hideDataLabels: boolean;
}

interface CartesianChartProps {
  spec: ChartSpec;
  shaped: ShapedChartData;
  formatValue: ValueFormatter;
  legend: LegendControl;
  onDatumClick?: (info: ChartDatumClickInfo) => void;
  onPointClick?: (e: ChartPointEvent) => void;
  onPointContextMenu?: (e: ChartPointEvent) => void;
  /** Already throttled by ChartRenderer; undefined = don't attach handlers. */
  onPointHover?: (e: ChartPointEvent | null) => void;
  activeCategory?: { label: string } | null;
  highlightCategory?: { label: string } | null;
  /** Echo of this chart's own active cross-filter selection (see ChartRendererProps). */
  selection?: ChartSelection | null;
  /** Date-axis drag range select (zoom.dragAction 'crossFilter'). */
  onAxisRangeSelect?: (range: ChartAxisRangeSelection) => void;
  /** Present when rendering as one small-multiples panel (no legend, tight axes). */
  panel?: PanelContext;
}

/** Legend entries for shaped series (legend identity riding along when present). */
const seriesLegendItems = (series: ChartSeries[]): LegendItemDatum[] =>
  series.map((s) => ({
    key: s.key,
    label: s.label,
    color: s.color,
    raw: s.legendRaw,
    legendLabel: s.legendLabel,
  }));

/**
 * The whole cartesian family (column/bar/stacked/line/area) on one
 * ComposedChart — recharts 3 presets are all the same CartesianChart under
 * the hood, and ComposedChart is the one that also hosts trendline <Line>
 * overlays over bars. Doubles as the small-multiples panel body (`panel`).
 */
function CartesianChart({
  spec,
  shaped,
  formatValue,
  legend,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  onPointHover,
  activeCategory = null,
  highlightCategory = null,
  selection = null,
  onAxisRangeSelect,
  panel,
}: CartesianChartProps) {
  const format = spec.format;
  const hidden = legend.hidden;
  // Container measurement drives category-label fitting and wheel-zoom
  // geometry; per-panel instances measure their own panel body.
  const wrapRef = useRef<HTMLDivElement>(null);
  const wrapSize = useDebouncedSize(wrapRef);
  // Transient zoom view window (indices into the plotted rows); NEVER
  // persisted. Null = full extent.
  const [viewWindow, setViewWindow] = useState<{ start: number; end: number } | null>(null);
  // Live drag-select span (display-row indices) rendered as a ReferenceArea.
  const [dragSpan, setDragSpan] = useState<{ startIdx: number; endIdx: number } | null>(null);
  const dragRef = useRef<{ startIdx: number; startX: number; moved: boolean } | null>(null);
  // A completed zoom drag must not double as a datum click: the flag is set on
  // mouseup and cleared on the next macrotask, after the browser's click.
  const suppressClickRef = useRef(false);
  // Window geometry for the native (non-passive) wheel listener.
  const wheelStateRef = useRef({ start: 0, end: 0, len: 0, axisLeft: 0, axisRight: 0 });
  const horizontal = spec.type === 'bar' || spec.type === 'stackedBar';
  const stacked = spec.type === 'stackedColumn' || spec.type === 'stackedBar';
  const isBars = spec.type !== 'line' && spec.type !== 'area';
  // Rich-HTML axis titles render OUTSIDE the plot (AxisTitleFrame) and replace
  // the SVG labels entirely.
  const htmlXTitle = Boolean(format.xAxisLabelHtml);
  const htmlYTitle = Boolean(format.yAxisLabelHtml);
  // Panels never render their own legend — the grid shares ONE legend.
  // STABLE LEGEND (see the pie): series backed by a LEGEND DIMENSION collapse
  // to a single survivor under a cross-filter, and `> 1` then deleted the
  // legend mid-interaction along with the only label that series has. Legend-
  // dimension charts legend themselves whenever they have any series; measure-
  // series charts keep the old rule (one measure needs no legend).
  const legendItems = seriesLegendItems(shaped.series);
  const hasLegendDimension = legendItems.some((i) => i.legendLabel !== undefined);
  const showLegend =
    !panel &&
    (format.showLegend ?? (hasLegendDimension ? legendItems.length > 0 : shaped.series.length > 1));
  // Memoized: this identity feeds the memoized trendline/window rows below —
  // recharts treats a new data array as brand-new data (full re-render), so
  // nothing on the render path may rebuild these per render.
  const visibleSeries = useMemo(
    () => shaped.series.filter((s) => !hidden.has(s.key)),
    [shaped.series, hidden],
  );
  const labelPosition = stacked ? 'center' : horizontal ? 'right' : 'top';
  const showDataLabels = Boolean(format.showDataLabels) && !panel?.hideDataLabels;
  // Single-series column/bar only: each category gets its own palette
  // slot; in this mode colorOverrides keyed by the CATEGORY label win.
  const singleSeriesBar =
    shaped.series.length === 1 && (spec.type === 'column' || spec.type === 'bar');
  const colorByCategory = Boolean(format.colorByCategory) && singleSeriesBar;
  // Cross-filter source dimming rides the same per-category Cell path, so
  // it too is single-series column/bar only; stacked/legend charts keep
  // full opacity (a category there spans several marks — skipped in v1).
  const dimming = activeCategory !== null && singleSeriesBar;
  // barFill conditional rules share the Cell path and the same single-series
  // restriction (a rule recoloring one segment of a stack would lie).
  const barFillActive =
    singleSeriesBar && (format.conditionalFormats ?? []).some((f) => f.style === 'barFill');
  const valueTickFormatter = axisTickFormatter(
    horizontal ? format.xAxisFormat : format.yAxisFormat,
  );

  // Secondary (right) value axis. Vertical value axes only: on horizontal
  // bars the value axis is X, and a "right axis" has no meaning there —
  // secondaryAxisKeys is ignored silently. The axis renders ONLY when at
  // least one series is assigned.
  const y2Keys = horizontal
    ? new Set<string>()
    : secondarySeriesKeys(shaped.series, format, stacked);
  const hasSecondary = y2Keys.size > 0;
  const y2TickFormatter = axisTickFormatter(format.y2AxisFormat);
  // Tooltips and data labels format PER AXIS: y2 series use y2AxisFormat when
  // set; everything else keeps the shared valueFormat / measure-hint path.
  const formatSeriesValue: ValueFormatter = (value, seriesKey) =>
    seriesKey && y2Keys.has(seriesKey) && format.y2AxisFormat && typeof value === 'number'
      ? formatAxisValue(value, format.y2AxisFormat)
      : formatValue(value, seriesKey);

  // Hover-highlight echo. A label matching a CATEGORY dims the other
  // categories via the per-bar Cell path (bar family only — a line/area path
  // can't be part-dimmed); otherwise a label matching a SERIES (display name,
  // styleKey, or the legend half of a combo) dims the other series whole.
  const seriesMatchesHighlight = (s: ChartSeries): boolean =>
    highlightCategory !== null &&
    (s.label === highlightCategory.label ||
      s.styleKey === highlightCategory.label ||
      s.legendLabel === highlightCategory.label);
  const highlightCategoryMode =
    highlightCategory !== null &&
    isBars &&
    shaped.data.some((row) => String(row[shaped.axisKey] ?? '') === highlightCategory.label);
  const highlightSeriesMode =
    highlightCategory !== null && !highlightCategoryMode && shaped.series.some(seriesMatchesHighlight);
  const seriesDimmed = (s: ChartSeries): boolean =>
    highlightSeriesMode && !seriesMatchesHighlight(s);

  // ---- selection highlight (this chart's own active cross-filter) ----------
  // Matching points keep full opacity plus a subtle accent ring; everything
  // else drops to the same 0.35 the hover dim uses, so hover and selection
  // read as one system — and SELECTION WINS over hover while both are
  // present. Unlike the legacy activeCategory dim, this path covers multi-
  // series and stacked bars too (each matching segment rings individually).
  const selHasCategories = (selection?.categories?.length ?? 0) > 0;
  const selectionOn =
    format.selectionHighlight !== false &&
    selection != null &&
    (selection.category != null || selection.legendValue != null || selHasCategories);
  const selSeriesMatches = (s: ChartSeries): boolean =>
    !selectionOn ||
    selection?.legendValue == null ||
    selectionFacetMatches(selection.legendValue, s.legendLabel ?? s.label, s.legendRaw);
  const selRowMatches = (row: Record<string, CellValue>): boolean =>
    !selectionOn ||
    (selection?.category == null && !selHasCategories) ||
    selectionCategoryMatches(
      selection!,
      String(row[shaped.axisKey] ?? ''),
      row[RAW_AXIS_KEY],
    );

  const renderCells =
    colorByCategory || dimming || barFillActive || highlightCategoryMode || (selectionOn && isBars);

  // Trendlines: column/stackedColumn/line/area only — horizontal bars would
  // need value-axis fitting and are skipped silently (as are pie/kpi/table).
  // The overlays are injected into row COPIES under synthetic keys, so the
  // shaped data the legend/reference lines read stays untouched. MEMOIZED:
  // rows are the chart's data identity — rebuilding them per render made
  // recharts fully re-render (and drop gestures) on every hover/drag state
  // change, which is where the old zoom jank came from.
  const trendSpecs = format.trendlines;
  const { rows, overlays } = useMemo(() => {
    const specs = !horizontal ? (trendSpecs ?? []) : [];
    return specs.length > 0
      ? buildTrendlines(specs, visibleSeries, shaped.data)
      : { rows: shaped.data, overlays: [] as TrendlineOverlay[] };
  }, [trendSpecs, horizontal, visibleSeries, shaped.data]);

  // ---- zoom view window (format.zoom) --------------------------------------
  // Cartesian MAIN charts only: small-multiple panels ignore zoom entirely (a
  // grid of independently-zoomed panels would be incoherent), and horizontal
  // bars keep their category axis on y, where none of the horizontal-span
  // tools apply. The window is transient view state — never persisted.
  const zoomOpts = format.zoom;
  const zoomEligible = !panel && !horizontal && rows.length > 1;
  const dragZoomOn = zoomEligible && zoomOpts?.dragZoom === true;
  const wheelOn = zoomEligible && zoomOpts?.wheel === true;
  const initialLastN = zoomOpts?.initialWindow?.lastN;
  const hasInitialWindow = typeof initialLastN === 'number' && initialLastN >= 1;
  // The corner button cluster replaces the old Brush strip: a truthy legacy
  // `brush` is an alias for "zoom controls enabled" (wire compat), and any
  // other zoom tool shows the cluster too, so every zoomed state stays
  // visibly adjustable/resettable without hunting for hidden gestures.
  const clusterOn =
    zoomEligible &&
    Boolean(zoomOpts && (zoomOpts.brush || zoomOpts.dragZoom || zoomOpts.wheel || hasInitialWindow));
  const zoomActive = clusterOn || dragZoomOn || wheelOn;

  /** The configured default view over `len` rows; null = full extent. */
  const defaultViewFor = (len: number): { start: number; end: number } | null =>
    zoomEligible && hasInitialWindow && initialLastN < len
      ? { start: len - initialLastN, end: len - 1 }
      : null;

  // (Re)apply the default view whenever the data identity changes (new
  // result, drill, slicer change — a stale window over different rows would
  // lie) or the configured initial view is edited (live Format-panel
  // preview). Render-phase state adoption, NOT an effect: the first frame
  // already shows the right window instead of flashing the full extent.
  const dataIdentity = `${rows.length}|${String(rows[0]?.[RAW_AXIS_KEY] ?? '')}|${String(
    rows[rows.length - 1]?.[RAW_AXIS_KEY] ?? '',
  )}|${hasInitialWindow ? initialLastN : ''}`;
  const [appliedIdentity, setAppliedIdentity] = useState<string | null>(null);
  if (appliedIdentity !== dataIdentity) {
    setAppliedIdentity(dataIdentity);
    setViewWindow(defaultViewFor(rows.length));
  }

  const lastRow = rows.length - 1;
  const winStart = viewWindow ? Math.max(0, Math.min(viewWindow.start, lastRow)) : 0;
  const winEnd = viewWindow ? Math.max(winStart, Math.min(viewWindow.end, lastRow)) : lastRow;
  /**
   * Rows the user actually SEES — recharts renders (and indexes events/Cells
   * against) exactly this slice, so every handler below addresses
   * displayRows. Identity is MEMOIZED (and the full extent reuses `rows`
   * as-is): recharts must only see a new array when the window really moved,
   * never because something unrelated re-rendered mid-gesture.
   */
  const displayRows = useMemo(
    () => (winStart === 0 && winEnd === lastRow ? rows : rows.slice(winStart, winEnd + 1)),
    [rows, winStart, winEnd, lastRow],
  );

  // ---- axis scales (AxisScaleOptions) --------------------------------------
  // Extents cover the VISIBLE series on each axis (so legend toggles re-fit
  // like recharts' own auto domain) plus the trendline overlays fitted to
  // them — a linear fit can poke past the data. Horizontal bars put the VALUE
  // axis on x, so xAxisScale drives it there. sharedY small-multiple panels
  // receive their (already scale-adjusted) domain from the grid instead.
  const primaryKeys = visibleSeries
    .filter((s) => !y2Keys.has(s.key))
    .map((s) => s.key)
    .concat(overlays.filter((o) => !y2Keys.has(o.source.key)).map((o) => o.dataKey));
  const y2SeriesKeys = visibleSeries
    .filter((s) => y2Keys.has(s.key))
    .map((s) => s.key)
    .concat(overlays.filter((o) => y2Keys.has(o.source.key)).map((o) => o.dataKey));
  const valueScale = panel?.valueDomain
    ? NO_AXIS_SCALE
    : resolveAxisScale(
        horizontal ? format.xAxisScale : format.yAxisScale,
        valueExtent(rows, primaryKeys, stacked),
      );
  const y2Scale = hasSecondary
    ? resolveAxisScale(format.y2AxisScale, valueExtent(rows, y2SeriesKeys, stacked))
    : NO_AXIS_SCALE;
  // Log fallback surfaces as a subtle in-chart note, never console spam.
  const logNotes: string[] = [];
  if (valueScale.logFallback) logNotes.push('Log axis needs positive values — kept linear');
  if (y2Scale.logFallback) logNotes.push('Log right axis needs positive values — kept linear');

  // ---- category label fit (format.xLabelFit) -------------------------------
  // Vertical category axes only (the horizontal-bar category axis is the
  // fixed-width y rail). Until the first container measure lands the axis
  // keeps the classic thinned pattern, then re-renders fitted; the zoomed
  // view re-fits for the labels actually shown.
  const yAxisWidth = horizontal ? 110 : panel ? (panel.showYTicks ? 42 : 8) : 56;
  const y2AxisWidth = hasSecondary ? (panel ? 8 : 56) : 0;
  const xTicksVisible = !(panel && !panel.showXTicks);
  const plotWidth = wrapSize ? Math.max(0, wrapSize.width - yAxisWidth - y2AxisWidth - 18) : null;
  const labelFit =
    !horizontal && xTicksVisible && plotWidth !== null && plotWidth > 0 && displayRows.length > 0
      ? resolveLabelFit(
          displayRows.map((row) => String(row[shaped.axisKey] ?? '')),
          plotWidth / displayRows.length,
          format.xLabelFit,
        )
      : null;
  const fittedTicks = labelFit !== null && labelFit.mode !== 'thin';

  // ---- drag zoom / drag range cross-filter ---------------------------------
  const displayIndexFromState = (state: MouseHandlerDataParam): number | undefined => {
    const raw = state.activeTooltipIndex;
    const index = typeof raw === 'number' ? raw : raw != null ? Number(raw) : NaN;
    return Number.isInteger(index) && index >= 0 && index < displayRows.length
      ? index
      : undefined;
  };

  const dragMouseDown = dragZoomOn
    ? (state: MouseHandlerDataParam, event: ReactMouseEvent<SVGGraphicsElement>) => {
        if (event.button !== 0) return;
        const idx = displayIndexFromState(state);
        if (idx === undefined) return;
        dragRef.current = { startIdx: idx, startX: event.clientX, moved: false };
      }
    : undefined;

  const dragMouseMove = dragZoomOn
    ? (state: MouseHandlerDataParam, event: ReactMouseEvent<SVGGraphicsElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        // Sub-threshold movement stays a click; no span, no zoom.
        if (Math.abs(event.clientX - drag.startX) < DRAG_ZOOM_MIN_PX) return;
        const idx = displayIndexFromState(state);
        if (idx === undefined) return;
        drag.moved = true;
        setDragSpan({ startIdx: drag.startIdx, endIdx: idx });
      }
    : undefined;

  const dragMouseUp = dragZoomOn
    ? (state: MouseHandlerDataParam, event: ReactMouseEvent<SVGGraphicsElement>) => {
        const drag = dragRef.current;
        dragRef.current = null;
        const span = dragSpan;
        setDragSpan(null);
        if (!drag || !drag.moved) return;
        if (Math.abs(event.clientX - drag.startX) < DRAG_ZOOM_MIN_PX) return;
        const endIdx = displayIndexFromState(state) ?? span?.endIdx;
        if (endIdx === undefined) return;
        const i0 = Math.min(drag.startIdx, endIdx);
        const i1 = Math.max(drag.startIdx, endIdx);
        // Swallow the click the browser fires right after this mouseup so the
        // drag can't double as a datum cross-filter click.
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        // dragAction 'crossFilter' on a bucketed DATE axis emits the RAW
        // bucket cells of the span edges (inclusive) AND zooms the view, so
        // the source chart shows the span it just pushed onto the page.
        // Non-date axes fall back to the plain view zoom.
        if (
          zoomOpts?.dragAction === 'crossFilter' &&
          shaped.axisIsDate &&
          onAxisRangeSelect &&
          displayRows[i0] &&
          displayRows[i1]
        ) {
          onAxisRangeSelect({
            fromRaw: displayRows[i0]![RAW_AXIS_KEY] ?? null,
            toRaw: displayRows[i1]![RAW_AXIS_KEY] ?? null,
          });
        }
        if (i1 > i0) setViewWindow({ start: winStart + i0, end: winStart + i1 });
      }
    : undefined;

  // ---- wheel zoom ----------------------------------------------------------
  // Geometry for the native listener (React wheel handlers are passive, so
  // preventDefault needs a manual non-passive listener).
  wheelStateRef.current = {
    start: winStart,
    end: winEnd,
    len: rows.length,
    axisLeft: yAxisWidth + 8,
    axisRight: y2AxisWidth + 12,
  };
  useEffect(() => {
    if (!wheelOn) return;
    const node = wrapRef.current;
    if (!node) return;
    // Wheel rule (least-annoying): plain wheel zooms only while the chart is
    // ALREADY zoomed in; ctrl/cmd+wheel always zooms. At full zoom-out a
    // plain wheel scrolls the page normally, and zooming out past the full
    // extent releases the wheel back to page scrolling.
    const onWheel = (e: WheelEvent) => {
      const st = wheelStateRef.current;
      const zoomedIn = st.start > 0 || st.end < st.len - 1;
      if (!e.ctrlKey && !e.metaKey && !zoomedIn) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const count = st.end - st.start + 1;
      const zoomIn = e.deltaY < 0;
      if (zoomIn && count <= MIN_WHEEL_BUCKETS) return;
      const newCount = zoomIn
        ? Math.max(MIN_WHEEL_BUCKETS, Math.floor(count * 0.8))
        : Math.max(count + 1, Math.ceil(count * 1.25));
      if (!zoomIn && newCount >= st.len) {
        setViewWindow(null);
        return;
      }
      // Zoom centred on the cursor: keep the bucket under the pointer at the
      // same fractional position inside the new window. Fit-to-page wraps
      // dashboards in a CSS scale(), so the client rect is in SCALED viewport
      // px while the axis widths are LAYOUT px — normalize the pointer into
      // layout px via the rect/offsetWidth ratio (the same compensation
      // recharts applies internally) before mixing the two.
      const rect = node.getBoundingClientRect();
      const scale = node.offsetWidth > 0 ? rect.width / node.offsetWidth : 1;
      const xLayout = (e.clientX - rect.left) / scale;
      const plotW = Math.max(1, node.offsetWidth - st.axisLeft - st.axisRight);
      const f = Math.min(1, Math.max(0, (xLayout - st.axisLeft) / plotW));
      const anchor = st.start + Math.round(f * (count - 1));
      const start = Math.min(
        Math.max(0, anchor - Math.round(f * (newCount - 1))),
        st.len - newCount,
      );
      setViewWindow({ start, end: start + newCount - 1 });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [wheelOn]);

  // ---- zoom control cluster steps ------------------------------------------
  // Shared by the corner buttons (single press and press-and-hold repeats).
  // Reads the LIVE window from wheelStateRef — assigned every render above —
  // so a hold interval created several renders ago still steps correctly.
  // Steps move by ZOOM_STEP_FRACTION of the current window (min one bucket),
  // and zooming out past the full extent clears the window entirely (which
  // also releases plain-wheel scrolling back to the page).
  const stepView = (action: ZoomStepAction) => {
    const st = wheelStateRef.current;
    const count = st.end - st.start + 1;
    const clampStart = (start: number, size: number) =>
      Math.min(Math.max(0, start), Math.max(0, st.len - size));
    const centered = (size: number) =>
      clampStart(Math.round((st.start + st.end) / 2 - (size - 1) / 2), size);
    switch (action) {
      case 'reset':
        setViewWindow(defaultViewFor(st.len));
        return;
      case 'panLeft':
      case 'panRight': {
        if (count >= st.len) return;
        const step =
          Math.max(1, Math.round(count * ZOOM_STEP_FRACTION)) * (action === 'panLeft' ? -1 : 1);
        const start = clampStart(st.start + step, count);
        setViewWindow({ start, end: start + count - 1 });
        return;
      }
      case 'zoomIn': {
        if (count <= MIN_WHEEL_BUCKETS) return;
        const size = Math.max(MIN_WHEEL_BUCKETS, Math.round(count * (1 - ZOOM_STEP_FRACTION)));
        const start = centered(size);
        setViewWindow({ start, end: start + size - 1 });
        return;
      }
      case 'zoomOut': {
        const size = Math.min(
          st.len,
          Math.max(count + 1, Math.round(count / (1 - ZOOM_STEP_FRACTION))),
        );
        if (size >= st.len) {
          setViewWindow(null);
          return;
        }
        const start = centered(size);
        setViewWindow({ start, end: start + size - 1 });
        return;
      }
    }
  };
  const atFullExtent = winStart === 0 && winEnd === lastRow;
  const defaultView = defaultViewFor(rows.length);
  const atDefaultView = defaultView
    ? winStart === defaultView.start && winEnd === defaultView.end
    : atFullExtent;

  // ---- designed fills (shadcn look) ---------------------------------------
  // Bars are flat solid fills at full color (no gradient, no self-stroke);
  // areas are the series color at a soft ~12% fill under a 2px stroke.
  /** Resolved fill for one bar cell (colorByCategory / barFill rules / series). */
  const resolveCellFill = (
    series: ChartSeries,
    row: Record<string, CellValue>,
    dataIndex: number,
  ): string => {
    const categoryLabel = String(row[shaped.axisKey] ?? '');
    // Fill precedence: explicit colorOverrides keyed by the CATEGORY label
    // (colorByCategory mode) > first matching barFill rule > palette slot /
    // series color. An explicit per-category override is the strongest user
    // intent; rules still beat the default palette.
    const paletteFill = colorByCategory
      ? seriesColor(dataIndex, categoryLabel, format.colorOverrides, format.theme)
      : series.color;
    const overridden = colorByCategory && Boolean(format.colorOverrides?.[categoryLabel]);
    const ruleFill =
      !overridden && barFillActive
        ? conditionalColor(
            format.conditionalFormats,
            'barFill',
            series.styleKey,
            row[series.key] ?? null,
          )
        : undefined;
    return ruleFill ?? paletteFill;
  };

  /** ChartPointEvent for one struck row (+ series when a specific mark was hit). */
  const pointEvent = (
    row: Record<string, CellValue> | undefined,
    series: ChartSeries | undefined,
    e: { clientX: number; clientY: number },
  ): ChartPointEvent => ({
    axisValue: row?.[RAW_AXIS_KEY] ?? null,
    axisLabel: String(row?.[shaped.axisKey] ?? ''),
    legendValue: shaped.hasLegend && series ? (series.legendRaw ?? null) : undefined,
    // Combo series (measure × legend): report the LEGEND half, not the full
    // combo name. Plain legend series keep the display label as before
    // (styleKey === legendLabel there).
    legendLabel:
      shaped.hasLegend && series
        ? series.legendLabel !== undefined && series.legendLabel !== series.styleKey
          ? series.legendLabel
          : series.label
        : undefined,
    smallMultipleValue: panel?.smallMultipleValue,
    measureKey: series?.styleKey,
    value:
      series && row
        ? typeof row[series.key] === 'number'
          ? (row[series.key] as number)
          : null
        : undefined,
    clientX: e.clientX,
    clientY: e.clientY,
  });

  // Recharts hands (barItem, index, event) — index addresses the DISPLAYED
  // rows (the zoom-window slice when one is active), which is sturdier across
  // recharts versions than digging into payload. Cross-filter (onDatumClick)
  // and the point event BOTH fire; the consumer decides what each means. A
  // click landing right after a completed zoom drag is swallowed
  // (suppressClickRef) so a drag never doubles as a datum click.
  const barClick = (series: ChartSeries) =>
    onDatumClick || onPointClick
      ? (_: unknown, index: number, event: ReactMouseEvent) => {
          if (suppressClickRef.current) return;
          const row = displayRows[index];
          if (!row) return;
          onDatumClick?.({
            value: row[RAW_AXIS_KEY] ?? null,
            label: String(row[shaped.axisKey] ?? ''),
          });
          onPointClick?.(pointEvent(row, series, event));
        }
      : undefined;
  const barContextMenu = (series: ChartSeries) =>
    onPointContextMenu
      ? (_: unknown, index: number, event: ReactMouseEvent) => {
          const row = displayRows[index];
          if (!row) return;
          event.preventDefault();
          onPointContextMenu(pointEvent(row, series, event));
        }
      : undefined;
  // Hover source (bar family): per-mark enter reports the exact struck series
  // + value; throttling already happened upstream.
  const barHover = (series: ChartSeries) =>
    onPointHover
      ? (_: unknown, index: number, event: ReactMouseEvent) => {
          const row = displayRows[index];
          if (row) onPointHover(pointEvent(row, series, event));
        }
      : undefined;

  // Line/area click target: a custom activeDot ELEMENT. The object form of
  // activeDot adapts handlers against the option object and drops the DOM
  // event, so we render our own <Dot>, whose handlers recharts adapts to
  // (allProps, event) — dotProps.payload is the hovered row.
  const clickableActiveDot = (series: ChartSeries) =>
    onPointClick
      ? (dotProps: ActiveDotProps) => (
          <Dot
            {...dotProps}
            r={4}
            stroke="var(--rcd-surface)"
            strokeWidth={1}
            cursor="pointer"
            onClick={(_, event) => {
              if (suppressClickRef.current) return;
              const row = dotProps.payload as Record<string, CellValue> | undefined;
              onPointClick(pointEvent(row, series, event));
            }}
          />
        )
      : undefined;

  /**
   * Persistent selection dot for line/area: the selected category renders an
   * enlarged accent-ringed dot on every series matching the selection's
   * legend facet; other points draw nothing. Recharts calls the renderer for
   * EVERY point, so misses return an empty <g>.
   */
  const selectionDot = (series: ChartSeries) =>
    selectionOn && selection?.category != null && selSeriesMatches(series)
      ? // Loosely typed: recharts' per-point dot props type isn't exported;
        // we only read cx/cy/payload/index.
        (dotProps: unknown) => {
          const p = dotProps as { cx?: number; cy?: number; payload?: unknown; index?: number };
          const row = p.payload as Record<string, CellValue> | undefined;
          const hit =
            row !== undefined &&
            typeof p.cx === 'number' &&
            typeof p.cy === 'number' &&
            selRowMatches(row);
          return hit ? (
            <Dot
              key={`sel-${p.index ?? ''}`}
              cx={p.cx}
              cy={p.cy}
              r={4.5}
              fill={series.color}
              stroke={SELECTION_STROKE}
              strokeWidth={1.5}
            />
          ) : (
            <g key={`sel-${p.index ?? ''}`} />
          );
        }
      : false;

  // Active hovered row from chart-level state (line/area handlers); indices
  // address the displayed (zoom-windowed) rows.
  const rowFromChartState = (state: MouseHandlerDataParam) => {
    const raw = state.activeTooltipIndex;
    const index = typeof raw === 'number' ? raw : raw != null ? Number(raw) : NaN;
    return Number.isInteger(index) ? displayRows[index] : undefined;
  };

  // Line/area context menu resolves the ACTIVE hovered category from the
  // chart-level hover state; no specific series is struck, so measureKey and
  // value stay undefined. Bars use per-mark onContextMenu instead.
  const chartContextMenu =
    !isBars && onPointContextMenu
      ? (state: MouseHandlerDataParam, event: ReactMouseEvent<SVGGraphicsElement>) => {
          const row = rowFromChartState(state);
          if (!row) return;
          event.preventDefault();
          onPointContextMenu(pointEvent(row, undefined, event));
        }
      : undefined;

  // Line/area hover source: the ACTIVE category via chart-level mousemove
  // (paths have no per-datum enter); bars use per-mark handlers instead so
  // the exact struck series rides along.
  const chartMouseMove =
    !isBars && onPointHover
      ? (state: MouseHandlerDataParam, event: ReactMouseEvent<SVGGraphicsElement>) => {
          const row = rowFromChartState(state);
          if (row) onPointHover(pointEvent(row, undefined, event));
        }
      : undefined;

  // Chart-level mouse composition: hover tracking and drag-zoom share
  // mousemove/leave; drag-zoom owns mousedown/up.
  const handleChartMouseMove =
    chartMouseMove || dragMouseMove
      ? (state: MouseHandlerDataParam, event: ReactMouseEvent<SVGGraphicsElement>) => {
          dragMouseMove?.(state, event);
          chartMouseMove?.(state, event);
        }
      : undefined;
  const handleChartMouseLeave =
    onPointHover || dragZoomOn
      ? () => {
          onPointHover?.(null);
          if (dragZoomOn) {
            // Leaving the plot mid-drag cancels the pending span.
            dragRef.current = null;
            setDragSpan(null);
          }
        }
      : undefined;

  // Reference lines sit on the VALUE axis (y normally, x for horizontal
  // bars). Computed kinds read the FULL plotted dataset of the target series
  // (see referenceLineValue for why visibility is ignored); in small-multiple
  // panels each panel computes its own stats — every panel is its own chart.
  const referenceLines = (format.referenceLines ?? []).flatMap((ref) => {
    // ref.secondary anchors to y2 — but only while the secondary axis exists
    // (some series assigned); with the axis hidden there is no scale to
    // anchor to, so the guide is skipped rather than drawn against the
    // wrong axis.
    const onSecondary = Boolean(ref.secondary);
    if (onSecondary && !hasSecondary) return [];
    const target =
      (ref.measureKey ? shaped.series.find((s) => s.styleKey === ref.measureKey) : undefined) ??
      shaped.series[0];
    const value = referenceLineValue(ref, target ? seriesValues(shaped.data, target.key) : []);
    if (value === null) return [];
    return [
      guideReferenceLine(
        ref,
        value,
        horizontal ? 'x' : 'y',
        onSecondary ? y2TickFormatter : valueTickFormatter,
        onSecondary ? 'y2' : undefined,
      ),
    ];
  });

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full min-w-0"
      // Double-click anywhere on the plot resets the zoom view to the
      // configured default (initialWindow when set, else the full extent).
      onDoubleClick={zoomActive ? () => setViewWindow(defaultViewFor(rows.length)) : undefined}
    >
    <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
      <ComposedChart
        data={displayRows}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={
          panel
            ? { top: 4, right: 6, bottom: 2, left: 2 }
            : {
                ...chartMargin(format),
                // Room for the y2 SVG title (an HTML title lives outside).
                ...(hasSecondary && format.y2AxisLabel && !format.y2AxisLabelHtml
                  ? { right: 18 }
                  : null),
              }
        }
        // Slimmer default gaps between category slots (shadcn bars sit closer).
        barCategoryGap="20%"
        onContextMenu={chartContextMenu}
        onMouseDown={dragMouseDown}
        onMouseMove={handleChartMouseMove}
        onMouseUp={dragMouseUp}
        onMouseLeave={handleChartMouseLeave}
      >
        {/* format.gridX/gridY toggle each axis's lines. Defaults preserve the
            long-standing look: lines from the VALUE axis on (horizontal rules
            on vertical charts, vertical rules on horizontal bars), category-
            axis lines off. */}
        <CartesianGrid
          vertical={format.gridX ?? horizontal}
          horizontal={format.gridY ?? !horizontal}
          stroke={GRID_STROKE}
        />
        {horizontal ? (
          <XAxis
            type="number"
            tick={panel && !panel.showXTicks ? false : axisTickStyle}
            tickLine={false}
            axisLine={false}
            tickMargin={panel ? 3 : TICK_MARGIN}
            tickFormatter={valueTickFormatter}
            domain={panel?.valueDomain ?? valueScale.domain}
            scale={valueScale.scale}
            // Axis TITLES stay on the single chart; panels are too small.
            // HTML titles render outside the plot instead (AxisTitleFrame).
            label={
              panel || htmlXTitle
                ? undefined
                : xAxisLabelProps(format.xAxisLabel, format.axisTitleStyle)
            }
          />
        ) : (
          <XAxis
            dataKey={shaped.axisKey}
            tick={
              !xTicksVisible ? false : fittedTicks && labelFit ? <AxisFitTick fit={labelFit} /> : axisTickStyle
            }
            tickLine={false}
            axisLine={false}
            tickMargin={panel ? 3 : TICK_MARGIN}
            // Fitted modes label EVERY bucket (rotating/wrapping as needed and
            // reserving the height below); the unfitted fallback keeps the
            // classic thinned pattern — interior ticks drop instead of
            // colliding, first/last stay so the extent reads.
            interval={fittedTicks ? 0 : 'preserveStartEnd'}
            minTickGap={fittedTicks ? undefined : 8}
            height={fittedTicks && labelFit ? labelFit.height : undefined}
            label={
              panel || htmlXTitle
                ? undefined
                : xAxisLabelProps(format.xAxisLabel, format.axisTitleStyle)
            }
          />
        )}
        {horizontal ? (
          <YAxis
            type="category"
            dataKey={shaped.axisKey}
            width={panel ? (panel.showYTicks ? 70 : 8) : 110}
            tick={panel && !panel.showYTicks ? false : axisTickStyle}
            tickLine={false}
            axisLine={false}
            tickMargin={panel ? 3 : TICK_MARGIN}
            label={
              panel || htmlYTitle
                ? undefined
                : yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)
            }
          />
        ) : (
          <YAxis
            tick={panel && !panel.showYTicks ? false : axisTickStyle}
            tickLine={false}
            axisLine={false}
            tickMargin={panel ? 3 : TICK_MARGIN}
            width={panel ? (panel.showYTicks ? 42 : 8) : 56}
            tickFormatter={valueTickFormatter}
            domain={panel?.valueDomain ?? valueScale.domain}
            scale={valueScale.scale}
            label={
              panel || htmlYTitle
                ? undefined
                : yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)
            }
          />
        )}
        {hasSecondary && (
          // Secondary (right) value axis. Grid lines stay bound to the
          // PRIMARY axis (recharts' CartesianGrid follows the first y-axis),
          // so y2 never adds a second, conflicting set of rules. Panels keep
          // the scale but hide the ticks — small multiples are too narrow
          // for a second tick rail.
          <YAxis
            yAxisId="y2"
            orientation="right"
            tick={panel ? false : axisTickStyle}
            tickLine={false}
            axisLine={false}
            tickMargin={panel ? 3 : TICK_MARGIN}
            width={panel ? 8 : 56}
            tickFormatter={y2TickFormatter}
            domain={y2Scale.domain}
            scale={y2Scale.scale}
            label={
              panel || format.y2AxisLabelHtml
                ? undefined
                : y2AxisLabelProps(format.y2AxisLabel, format.axisTitleStyle)
            }
          />
        )}
        {themedTooltip(formatSeriesValue, format, isBars ? 'fill' : 'dashed', stacked ? { active: true } : undefined)}
        {showLegend && chartLegend(format, legendItems, legend)}
        {visibleSeries.map((series) => {
          const yAxisId = y2Keys.has(series.key) ? 'y2' : undefined;
          // Highlight (series mode) dims non-matching series whole; the
          // hover highlight wins visually over the activeCategory dim (which
          // stays per-category on the Cell path below).
          const dimSeries = seriesDimmed(series);
          if (isBars) {
            const handleClick = barClick(series);
            // Only the OUTERMOST stacked segment rounds (the stack renders in
            // series order, so the last visible member is the value end);
            // plain bars always round their value end.
            const roundEnd =
              !stacked || series.key === visibleSeries[visibleSeries.length - 1]?.key;
            return (
              <Bar
                key={series.key}
                yAxisId={yAxisId}
                dataKey={series.key}
                name={series.label}
                // Flat solid fill, no self-stroke (shadcn bars); stacked
                // segments keep the 2px surface gap between members.
                fill={series.color}
                fillOpacity={
                  selectionOn
                    ? selSeriesMatches(series)
                      ? undefined
                      : DIM_OPACITY
                    : dimSeries
                      ? 0.35
                      : undefined
                }
                stroke={stacked ? 'var(--rcd-surface)' : undefined}
                strokeWidth={stacked ? 2 : 0}
                stackId={stacked ? 'stack' : undefined}
                radius={roundEnd ? barEndRadius(horizontal) : 0}
                isAnimationActive={false}
                cursor={handleClick ? 'pointer' : undefined}
                onClick={handleClick}
                onContextMenu={barContextMenu(series)}
                onMouseEnter={barHover(series)}
              >
                {renderCells &&
                  displayRows.map((row, dataIndex) => {
                    const categoryLabel = String(row[shaped.axisKey] ?? '');
                    const resolved = resolveCellFill(series, row, dataIndex);
                    // Opacity precedence: an active SELECTION wins outright
                    // (matching cells full + accent ring, the rest 0.35);
                    // otherwise hover highlight (category mode) beats the
                    // activeCategory cross-filter dim while present. All
                    // three dim NON-matching categories to the same 0.35.
                    const cellSelected =
                      selectionOn && selRowMatches(row) && selSeriesMatches(series);
                    const dimmedByHighlight =
                      highlightCategoryMode &&
                      highlightCategory !== null &&
                      categoryLabel !== highlightCategory.label;
                    const cellOpacity = selectionOn
                      ? cellSelected
                        ? 1
                        : DIM_OPACITY
                      : dimmedByHighlight
                        ? 0.35
                        : dimming && activeCategory && categoryLabel !== activeCategory.label
                          ? 0.35
                          : undefined;
                    return (
                      <Cell
                        key={dataIndex}
                        fill={resolved}
                        stroke={
                          cellSelected
                            ? SELECTION_STROKE
                            : stacked
                              ? 'var(--rcd-surface)'
                              : undefined
                        }
                        strokeWidth={cellSelected && !stacked ? 1.5 : undefined}
                        fillOpacity={cellOpacity}
                      />
                    );
                  })}
                {showDataLabels && (
                  <LabelList
                    dataKey={series.key}
                    position={labelPosition}
                    fontSize={10}
                    fill="var(--rcd-text-2)"
                    formatter={(label) =>
                      typeof label === 'number' ? formatSeriesValue(label, series.key) : label
                    }
                  />
                )}
              </Bar>
            );
          }
          const lineStyle = format.lineStyles?.[series.styleKey];
          // Selection on line/area: series failing the legend facet dim to
          // 0.35 (selection wins over the hover dim); series that match get
          // an enlarged accent-ringed dot on the selected category.
          const strokeDim = selectionOn
            ? selSeriesMatches(series)
              ? undefined
              : DIM_OPACITY
            : dimSeries
              ? 0.35
              : undefined;
          if (spec.type === 'line') {
            return (
              <Line
                key={series.key}
                yAxisId={yAxisId}
                type="monotone"
                dataKey={series.key}
                name={series.label}
                stroke={series.color}
                strokeOpacity={strokeDim}
                strokeWidth={lineStyle?.width ?? 2}
                strokeDasharray={strokeDash(lineStyle)}
                dot={selectionDot(series)}
                activeDot={
                  clickableActiveDot(series) ?? {
                    r: 4,
                    stroke: 'var(--rcd-surface)',
                    strokeWidth: 1,
                  }
                }
                isAnimationActive={false}
              />
            );
          }
          return (
            <Area
              key={series.key}
              yAxisId={yAxisId}
              type="monotone"
              dataKey={series.key}
              name={series.label}
              stroke={series.color}
              strokeOpacity={strokeDim}
              strokeWidth={lineStyle?.width ?? 2}
              strokeDasharray={strokeDash(lineStyle)}
              // Soft solid area fill (~12% of the series color) under the
              // full-strength 2px stroke — the shadcn area treatment.
              fill={series.color}
              fillOpacity={strokeDim !== undefined ? 0.05 : 0.12}
              dot={selectionDot(series)}
              activeDot={
                clickableActiveDot(series) ?? {
                  r: 4,
                  stroke: 'var(--rcd-surface)',
                  strokeWidth: 1,
                }
              }
              isAnimationActive={false}
            />
          );
        })}
        {overlays.map((overlay) => (
          <Line
            key={overlay.dataKey}
            // A trendline rides the axis of the series it was fitted to.
            yAxisId={y2Keys.has(overlay.source.key) ? 'y2' : undefined}
            type="linear"
            dataKey={overlay.dataKey}
            stroke={overlay.spec.color ?? overlay.source.color}
            // Default color: the source series' own color knocked back so the
            // overlay reads as derived (series colors can be CSS variables,
            // so opacity — not a hex blend).
            strokeOpacity={overlay.spec.color ? 1 : 0.7}
            strokeWidth={overlay.spec.width ?? 2}
            strokeDasharray={guideDash(overlay.spec.dash)}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            // Overlays never appear in the legend or the tooltip rows.
            legendType="none"
            tooltipType="none"
          />
        ))}
        {referenceLines}
        {dragSpan &&
          (() => {
            // Live drag-select feedback: a translucent accent span between
            // the anchor and the current bucket (inclusive edges).
            const a = Math.min(dragSpan.startIdx, dragSpan.endIdx);
            const b = Math.max(dragSpan.startIdx, dragSpan.endIdx);
            const x1 = displayRows[a]?.[shaped.axisKey];
            const x2 = displayRows[b]?.[shaped.axisKey];
            return x1 != null && x2 != null ? (
              <ReferenceArea
                x1={String(x1)}
                x2={String(x2)}
                fill={SELECTION_STROKE}
                fillOpacity={0.08}
                stroke={SELECTION_STROKE}
                strokeOpacity={0.35}
              />
            ) : null;
          })()}
      </ComposedChart>
    </ResponsiveContainer>
    {clusterOn && (
      <ZoomControlCluster
        onStep={stepView}
        disabled={{
          zoomIn: winEnd - winStart + 1 <= MIN_WHEEL_BUCKETS,
          zoomOut: atFullExtent,
          panLeft: winStart <= 0,
          panRight: winEnd >= lastRow,
          reset: atDefaultView,
        }}
        // Bottom-right of the PLOT: clear of the x-axis labels below (their
        // fitted height when measured) and of the right value axis when one
        // is mounted — the cluster overlays data whitespace only.
        style={{
          right: (hasSecondary ? 56 : 0) + 12,
          bottom:
            (fittedTicks && labelFit ? labelFit.height : 30) +
            (format.xAxisLabel && !htmlXTitle ? 16 : 0) +
            8,
        }}
      />
    )}
    {logNotes.length > 0 && (
      // Console-free log-fallback marker: a subtle in-chart badge, styled
      // like the small-multiples "+N more" note.
      <div className="pointer-events-none absolute right-2 top-1 rounded border border-rcd-border bg-rcd-surface px-1.5 py-0.5 text-[10px] text-rcd-muted">
        {logNotes.join(' · ')}
      </div>
    )}
    </div>
  );
}

/**
 * 'auto' small-multiples columns: pick 2-4 by container aspect so panels stay
 * near-square (wide tiles take more columns); never more columns than panels.
 */
const autoColumns = (size: { width: number; height: number } | null, count: number): number => {
  const aspect = size && size.height > 0 ? size.width / size.height : 1.6;
  const target = aspect >= 2.6 ? 4 : aspect >= 1.5 ? 3 : 2;
  return Math.max(1, Math.min(target, count));
};

interface SmallMultiplesChartProps {
  spec: ChartSpec;
  panels: SmallMultiplePanel[];
  formatValue: ValueFormatter;
  legend: LegendControl;
  onDatumClick?: (info: ChartDatumClickInfo) => void;
  onPointClick?: (e: ChartPointEvent) => void;
  onPointContextMenu?: (e: ChartPointEvent) => void;
  onPointHover?: (e: ChartPointEvent | null) => void;
  activeCategory?: { label: string } | null;
  highlightCategory?: { label: string } | null;
  /** Selection highlight applies per panel; zoom/brush stay main-chart only. */
  selection?: ChartSelection | null;
}

/**
 * Small-multiples grid: one mini CartesianChart per panel, ONE shared
 * interactive legend (toggling hides the series in every panel), per-panel
 * tooltips, and Power BI-style edge axes — x ticks on bottom-row panels and y
 * ticks on first-column panels when sharedY, per-panel axes otherwise. The
 * container is measured with the same debounced ResizeObserver pattern as
 * CenteredPieFrame; the measured box drives 'auto' columns and the
 * small-panel data-label cutoff.
 */
function SmallMultiplesChart({
  spec,
  panels,
  formatValue,
  legend,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  onPointHover,
  activeCategory = null,
  highlightCategory = null,
  selection = null,
}: SmallMultiplesChartProps) {
  const hidden = legend.hidden;
  const frameRef = useRef<HTMLDivElement>(null);
  const frameSize = useDebouncedSize(frameRef);

  const format = spec.format;
  const sm = format.smallMultiples ?? {};
  const sharedY = sm.sharedY !== false;
  const showTitles = sm.showPanelTitles !== false;
  const stacked = spec.type === 'stackedColumn' || spec.type === 'stackedBar';
  // At least one panel always renders (a 0/negative maxPanels would blank the tile).
  const shown = panels.slice(0, Math.max(1, sm.maxPanels ?? 12));
  const droppedPanels = panels.length - shown.length;

  // Canonical series: shape ALL rows (SM column already stripped from every
  // panel) once, so a legend value keeps one color and one position in every
  // panel — per-panel shaping would re-index colors by local appearance.
  // Panels then render the canonical series against their own rows; a series
  // missing from a panel simply draws nothing there.
  const combined: QueryResult = {
    columns: shown[0]!.result.columns,
    rows: panels.flatMap((p) => p.result.rows),
    meta: shown[0]!.result.meta,
  };
  const canonical = shapeChartData(combined, spec);
  const panelShaped = shown.map((panel) => ({
    panel,
    shaped: {
      ...shapeChartData(panel.result, spec),
      series: canonical.series,
      hasLegend: canonical.hasLegend,
    },
  }));

  // sharedY: one value-axis domain over every panel, from the VISIBLE series
  // only, so legend toggles re-scale exactly like a single chart would.
  // Secondary-axis series are excluded — the shared domain binds the PRIMARY
  // axis; each panel's y2 auto-scales on its own.
  const horizontal = spec.type === 'bar' || spec.type === 'stackedBar';
  const y2Keys = horizontal
    ? new Set<string>()
    : secondarySeriesKeys(canonical.series, format, stacked);
  const visibleKeys = canonical.series
    .filter((s) => !hidden.has(s.key) && !y2Keys.has(s.key))
    .map((s) => s.key);
  // Scale-aware shared domain: range 'auto'/'custom' drop the forced zero
  // baseline before fitting/overriding; 'zero' (default) keeps the classic
  // zero-anchored bounds. Log scales are ignored under sharedY (one shared
  // linear domain beats per-panel log fallbacks) — a per-panel log axis is
  // available by turning sharedY off.
  const scaleOpts = horizontal ? format.xAxisScale : format.yAxisScale;
  const scaleRange = scaleOpts?.range;
  const fitsData = scaleRange === 'auto' || scaleRange === 'custom';
  const sharedBase = sharedY
    ? sharedValueDomain(
        panelShaped.map((p) => p.shaped.data),
        visibleKeys,
        stacked,
        !fitsData,
      )
    : undefined;
  const valueDomain: [number, number] | undefined = sharedBase
    ? scaleRange === 'auto'
      ? paddedNiceDomain(sharedBase[0], sharedBase[1])
      : scaleRange === 'custom'
        ? [scaleOpts?.min ?? sharedBase[0], scaleOpts?.max ?? sharedBase[1]]
        : sharedBase
    : undefined;

  const columns =
    typeof sm.columns === 'number' && sm.columns >= 1
      ? Math.floor(sm.columns)
      : autoColumns(frameSize, shown.length);
  const rowCount = Math.max(1, Math.ceil(shown.length / columns));
  const panelWidth = frameSize
    ? (frameSize.width - SM_GRID_GAP * (columns - 1)) / columns
    : Number.POSITIVE_INFINITY;
  const hideDataLabels = panelWidth < SM_MIN_LABEL_WIDTH;

  // STABLE LEGEND (see CartesianChart): the grid's shared legend survives a
  // cross-filter that leaves one series standing.
  const smLegendItems = seriesLegendItems(canonical.series);
  const showLegend =
    format.showLegend ??
    (smLegendItems.some((i) => i.legendLabel !== undefined)
      ? smLegendItems.length > 0
      : canonical.series.length > 1);
  const legendRight = format.legendPosition === 'right';
  const legendTop = format.legendPosition === 'top';
  // The shared legend lives OUTSIDE the recharts trees, so the plain-<Legend>
  // fallback isn't available; when legendInteractive === false the same list
  // renders and clicks simply no-op.
  const legendNode = showLegend ? (
    <div
      className={
        legendRight
          ? 'flex max-w-[min(35%,240px)] shrink-0 items-center overflow-hidden pl-2'
          : 'flex shrink-0 justify-center px-2 py-1'
      }
      style={{ ...legendWrapperStyle, ...textStyleToCss(format.legendStyle) }}
    >
      <InteractiveLegendContent
        items={smLegendItems}
        control={legend}
        layout={legendRight ? 'vertical' : 'horizontal'}
        interactive={format.legendInteractive !== false}
      />
    </div>
  ) : null;

  return (
    <div
      className={`relative flex h-full w-full min-w-0 ${legendRight ? 'flex-row' : 'flex-col'}`}
    >
      {legendTop && legendNode}
      <div
        ref={frameRef}
        className="grid min-h-0 min-w-0 flex-1"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rowCount}, minmax(0, 1fr))`,
          gap: SM_GRID_GAP,
        }}
      >
        {panelShaped.map(({ panel, shaped }, i) => {
          // "Bottom row" = no panel below (covers a ragged last row).
          const bottomRow = i + columns >= shown.length;
          const firstCol = i % columns === 0;
          return (
            <div key={`${i}-${panel.title}`} className="flex min-h-0 min-w-0 flex-col">
              {showTitles && (
                // Subtle caption, not a heading: muted, medium weight, capped
                // to one truncated line (full text on the title tooltip).
                <div
                  className="shrink-0 truncate px-1 text-center text-[11px] font-medium leading-4 text-rcd-muted"
                  title={panel.title}
                >
                  {panel.title}
                </div>
              )}
              <div className="min-h-0 min-w-0 flex-1">
                <CartesianChart
                  spec={spec}
                  shaped={shaped}
                  formatValue={formatValue}
                  legend={legend}
                  onDatumClick={onDatumClick}
                  onPointClick={onPointClick}
                  onPointContextMenu={onPointContextMenu}
                  onPointHover={onPointHover}
                  activeCategory={activeCategory}
                  highlightCategory={highlightCategory}
                  selection={selection}
                  panel={{
                    smallMultipleValue: panel.value,
                    showXTicks: !sharedY || bottomRow,
                    showYTicks: !sharedY || firstCol,
                    valueDomain,
                    hideDataLabels,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {droppedPanels > 0 && (
        <div className="absolute right-2 top-1 rounded border border-rcd-border bg-rcd-surface px-1.5 py-0.5 text-[10px] text-rcd-muted">
          +{droppedPanels} more
        </div>
      )}
      {!legendTop && legendNode}
    </div>
  );
}

/**
 * Loaded lazily (rcd-charts chunk). All recharts marks render with
 * isAnimationActive={false}: animation is rAF-driven and freezes at frame 0 in
 * throttled background tabs; dashboards want instant, deterministic paint.
 *
 * Legend toggling: hiddenSeries is LOCAL view state (never persisted to the
 * spec) keyed by series dataKey (cartesian/scatter) or slice label (pie).
 * Hidden series are filtered out of the mark elements — colors stay stable
 * because the shapers assign them by ORIGINAL index before filtering — while
 * the interactive legend keeps listing every series from the shaped data.
 */
export default function ChartRenderer({
  spec,
  result,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  activeCategory = null,
  selection = null,
  onAxisRangeSelect,
  onLegendSelect,
  selectedLegendLabel = null,
  onPointHover,
  highlightCategory = null,
  tableSort = null,
  onTableSortChange,
  tablePage = 0,
  tablePageCount = null,
  onTablePageChange,
  totalsRow = null,
  onTableLayoutChange,
  tableFilters,
  onTableFilterChange,
  onRequestColumnValues,
}: ChartRendererProps) {
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(NO_HIDDEN);
  const format = spec.format;
  // Hover EMISSION is gated by format.hoverHighlight (consumers gate whether
  // they APPLY highlights); the throttle keeps chart-level mousemoves from
  // flooding the consumer.
  const hover = useThrottledPointHover(
    format.hoverHighlight !== false ? onPointHover : undefined,
  );
  // When the legend is non-interactive every series renders, even if hidden
  // state lingers from before the flag was flipped.
  const hidden = format.legendInteractive === false ? NO_HIDDEN : hiddenSeries;
  const legendMode: LegendMode = format.legendMode ?? 'toggle';

  /**
   * One legend controller for every chart shape. crossFilter emits to the
   * consumer instead of touching local visibility; toggle/isolate mutate the
   * local hidden set. Handlers resolve the EFFECTIVE mode from the item list
   * they're given, so measure-series charts under 'crossFilter' isolate.
   */
  const legendControl: LegendControl = {
    mode: legendMode,
    hidden,
    selectedLabel: selectedLegendLabel ?? null,
    onItemClick: (items, item, multi) => {
      const mode = effectiveLegendMode(legendMode, items);
      if (mode === 'toggle') {
        setHiddenSeries((prev) => {
          const next = new Set(prev);
          if (next.has(item.key)) next.delete(item.key);
          else next.add(item.key);
          return next;
        });
        return;
      }
      if (mode === 'isolate') {
        setHiddenSeries((prev) => {
          // Ctrl/Cmd+click while isolation is active: toggle the clicked
          // series in/out of the visible set (Power BI multi-select).
          if (multi && prev.size > 0) {
            const next = new Set(prev);
            if (next.has(item.key)) next.delete(item.key);
            else next.add(item.key);
            // Hiding the last visible series would blank the chart — restore
            // everything instead.
            return items.some((i) => !next.has(i.key)) ? next : NO_HIDDEN;
          }
          const visible = items.filter((i) => !prev.has(i.key));
          // Clicking the sole visible (isolated) item restores all.
          if (visible.length === 1 && visible[0]!.key === item.key) return NO_HIDDEN;
          return new Set(items.filter((i) => i.key !== item.key).map((i) => i.key));
        });
        return;
      }
      // crossFilter: emit; the CONSUMER filters the page and echoes the
      // selection back via selectedLegendLabel. Clicking the selected item
      // again clears.
      const label = item.legendLabel ?? item.label;
      if (selectedLegendLabel != null && selectedLegendLabel === label) onLegendSelect?.(null);
      else onLegendSelect?.({ raw: item.raw ?? null, label });
    },
    onReset: (items) => {
      setHiddenSeries(NO_HIDDEN);
      if (effectiveLegendMode(legendMode, items) === 'crossFilter' && selectedLegendLabel != null) {
        onLegendSelect?.(null);
      }
    },
  };

  const measureColumns = result.columns.filter((c) => c.role === 'measure');
  const formatValue = makeValueFormatter(format, measureColumns);

  switch (spec.type) {
    case 'column':
    case 'bar':
    case 'stackedColumn':
    case 'stackedBar':
    case 'line':
    case 'area': {
      // y2 title rail intent: vertical value axes only, and only when the
      // user assigned something (the axis itself still hides until a series
      // actually matches).
      const horizontal = spec.type === 'bar' || spec.type === 'stackedBar';
      const y2Titles = !horizontal && (format.secondaryAxisKeys?.length ?? 0) > 0;
      // Small multiples: the third ordered dimension splits the chart into a
      // panel grid (cartesian family only — other types ignore it).
      const panels = splitSmallMultiples(result, spec);
      if (panels && panels.length > 0) {
        // The title frame wraps the WHOLE grid: one shared x/y title pair.
        return (
          <AxisTitleFrame format={format} y2={y2Titles}>
            <SmallMultiplesChart
              spec={spec}
              panels={panels}
              formatValue={formatValue}
              legend={legendControl}
              onDatumClick={onDatumClick}
              onPointClick={onPointClick}
              onPointContextMenu={onPointContextMenu}
              onPointHover={hover}
              activeCategory={activeCategory}
              highlightCategory={highlightCategory}
              selection={selection}
            />
          </AxisTitleFrame>
        );
      }
      return (
        <AxisTitleFrame format={format} y2={y2Titles}>
          <CartesianChart
            spec={spec}
            shaped={shapeChartData(result, spec)}
            formatValue={formatValue}
            legend={legendControl}
            onDatumClick={onDatumClick}
            onPointClick={onPointClick}
            onPointContextMenu={onPointContextMenu}
            onPointHover={hover}
            activeCategory={activeCategory}
            highlightCategory={highlightCategory}
            selection={selection}
            onAxisRangeSelect={onAxisRangeSelect}
          />
        </AxisTitleFrame>
      );
    }

    case 'pie':
    case 'donut': {
      const { slices } = shapePieData(result, spec);
      // A measure with NO ROWS shapes to zero slices too (any cross-filter can
      // empty a pie), so distinguish the two: only a missing measure is a spec
      // problem — the other is just a filter with no matches.
      if (slices.length === 0) {
        return (
          <Placeholder>
            {result.columns.some((c) => c.role === 'measure')
              ? 'No data for this filter.'
              : 'Pie needs a measure.'}
          </Placeholder>
        );
      }
      // Slices carry a legend identity (crossFilter) only when a dimension
      // labels them; a dimensionless pie is a single measure-named slice.
      const hasSliceDimension = result.columns.some((c) => c.role === 'dimension');
      // STABLE LEGEND: the default must not depend on how many slices SURVIVE
      // the page's cross-filters. `slices.length > 1` deleted the legend the
      // moment a filter left one category standing — and a pie has no axis, so
      // the remaining ring was left unlabelled. A dimension-labelled pie now
      // legends itself whenever it has any slice at all; a dimensionless pie
      // (one measure-named slice) keeps the old rule. Explicit showLegend still
      // wins in both directions.
      const showLegend = format.showLegend ?? (hasSliceDimension || slices.length > 1);
      const sliceLegendItems: LegendItemDatum[] = slices.map((s) => ({
        key: s.label,
        label: s.label,
        color: s.color,
        raw: hasSliceDimension ? s.raw : undefined,
        legendLabel: hasSliceDimension ? s.label : undefined,
      }));
      const pieMode = effectiveLegendMode(legendMode, sliceLegendItems);
      // Isolate DIMS the non-isolated slices (0.15) instead of removing them:
      // removal re-normalizes the survivors, so an isolated slice becomes a
      // featureless full circle — dimming keeps the ring geometry and the
      // slice's true share visible. Toggle keeps the original remove-and-
      // renormalize behavior.
      const dimHiddenSlices = pieMode === 'isolate';
      // Toggle mode: hidden slices are removed from the pie entirely (the
      // visible total is the percent denominator); the interactive legend
      // still lists them.
      const visibleSlices = dimHiddenSlices ? slices : slices.filter((s) => !hidden.has(s.label));
      const visibleTotal = visibleSlices.reduce((sum, s) => sum + s.value, 0);
      // The slice label IS the (first) dimension, so it rides as axisValue;
      // measureKey reports the sliced measure.
      const measureLabel = measureColumns[0]?.label;
      const pieEvent = (
        slice: PieSlice,
        e: { clientX: number; clientY: number },
      ): ChartPointEvent => ({
        axisValue: slice.raw,
        axisLabel: slice.label,
        measureKey: measureLabel,
        value: slice.value,
        clientX: e.clientX,
        clientY: e.clientY,
      });
      // Sector index addresses the VISIBLE slices array (data order === sector order).
      const handleSliceClick =
        onDatumClick || onPointClick
          ? (_: unknown, index: number, event: ReactMouseEvent) => {
              const slice = visibleSlices[index];
              if (!slice) return;
              onDatumClick?.({ value: slice.raw, label: slice.label });
              onPointClick?.(pieEvent(slice, event));
            }
          : undefined;
      const handleSliceContextMenu = onPointContextMenu
        ? (_: unknown, index: number, event: ReactMouseEvent) => {
            const slice = visibleSlices[index];
            if (!slice) return;
            event.preventDefault();
            onPointContextMenu(pieEvent(slice, event));
          }
        : undefined;
      const handleSliceHover = hover
        ? (_: unknown, index: number, event: ReactMouseEvent) => {
            const slice = visibleSlices[index];
            if (slice) hover(pieEvent(slice, event));
          }
        : undefined;
      // Selection highlight on slices: a slice's label is both its category
      // and its legend identity, so either facet may name it. The selected
      // slice keeps full opacity + an accent ring; the rest dim to 0.35.
      const pieHasCategories = (selection?.categories?.length ?? 0) > 0;
      const pieSelectionOn =
        format.selectionHighlight !== false &&
        selection != null &&
        (selection.category != null || selection.legendValue != null || pieHasCategories);
      const sliceSelected = (slice: PieSlice): boolean =>
        pieSelectionOn &&
        (selection?.category == null && !pieHasCategories
          ? true
          : selectionCategoryMatches(selection!, slice.label, slice.raw)) &&
        (selection?.legendValue == null ||
          selectionFacetMatches(selection.legendValue, slice.label, slice.raw));
      return (
        <CenteredPieFrame legendRight={showLegend && format.legendPosition === 'right'}>
          <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
            <PieChart
              margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
              onMouseLeave={hover ? () => hover(null) : undefined}
            >
              {themedTooltip(formatValue, format, 'none', { active: true, total: visibleTotal })}
              {showLegend && chartLegend(format, sliceLegendItems, legendControl)}
              <Pie
                data={visibleSlices}
                dataKey="value"
                nameKey="label"
                innerRadius={spec.type === 'donut' ? '55%' : 0}
                outerRadius="85%"
                // Slice gaps come from paddingAngle; the 1px surface stroke
                // keeps rounded corners crisp against the card.
                paddingAngle={1.5}
                cornerRadius={3}
                stroke="var(--rcd-surface)"
                strokeWidth={1}
                isAnimationActive={false}
                cursor={handleSliceClick ? 'pointer' : undefined}
                onClick={handleSliceClick}
                onContextMenu={handleSliceContextMenu}
                onMouseEnter={handleSliceHover}
              >
                {visibleSlices.map((slice, i) => {
                  const selected = sliceSelected(slice);
                  return (
                    <Cell
                      key={`${i}-${slice.label}`}
                      fill={slice.color}
                      stroke={selected ? SELECTION_STROKE : undefined}
                      strokeWidth={selected ? 1.5 : undefined}
                      // Opacity precedence: isolate's hidden dim (strongest,
                      // 0.15) > selection (selected slice full + ring, rest
                      // 0.35) > hover highlight > activeCategory cross-filter
                      // dim — selection wins over hover while present.
                      fillOpacity={
                        dimHiddenSlices && hidden.has(slice.label)
                          ? 0.15
                          : pieSelectionOn
                            ? selected
                              ? 1
                              : DIM_OPACITY
                            : highlightCategory && slice.label !== highlightCategory.label
                              ? 0.35
                              : activeCategory && slice.label !== activeCategory.label
                                ? 0.35
                                : undefined
                      }
                    />
                  );
                })}
              </Pie>
              {spec.type === 'donut' && (
                <DonutCenterTotal text={formatValue(visibleTotal)} />
              )}
            </PieChart>
          </ResponsiveContainer>
        </CenteredPieFrame>
      );
    }

    case 'scatter': {
      const scatter = shapeScatterData(result, spec);
      const xColumn = scatter.xColumn;
      const yColumn = scatter.yColumn;
      if (!xColumn || !yColumn) {
        return <Placeholder>Scatter needs two measures (x and y).</Placeholder>;
      }
      const formatPoint = (value: unknown, dataKey: string | undefined): string => {
        if (typeof value !== 'number') return value == null ? '' : String(value);
        if (format.valueFormat) return valueFormatText(value, format.valueFormat);
        return formatCellValue(value, dataKey === 'y' ? yColumn : xColumn);
      };
      const visibleSeries = scatter.series.filter((s) => !hidden.has(s.key));
      // The split carries a legend identity (crossFilter) only when it IS the
      // legend dimension; an axis-only split still colors groups but has
      // nothing to cross-filter by.
      const splitIsLegend = Boolean(spec.query.legend);
      // STABLE LEGEND (see CartesianChart): a legend-split scatter keeps its
      // legend when a cross-filter leaves a single group.
      const showLegend =
        format.showLegend ??
        (splitIsLegend ? scatter.series.length > 0 : scatter.series.length > 1);
      const scatterLegendItems: LegendItemDatum[] = scatter.series.map((s) => ({
        key: s.key,
        label: s.label,
        color: s.color,
        raw: splitIsLegend ? s.raw : undefined,
        legendLabel: splitIsLegend ? s.key : undefined,
      }));
      // Rich-HTML axis titles render outside the plot (AxisTitleFrame).
      const htmlXTitle = Boolean(format.xAxisLabelHtml);
      const htmlYTitle = Boolean(format.yAxisLabelHtml);
      // A scatter point is (x measure, y measure) within a split-dimension
      // series: the split doubles as the axis identity, and y — the
      // conventional "value" — reports as measureKey/value.
      const scatterEvent = (
        series: (typeof scatter.series)[number],
        item: unknown,
        e: { clientX: number; clientY: number },
      ): ChartPointEvent => {
        const payload = (item as { payload?: { y?: number } }).payload;
        return {
          axisValue: series.raw,
          axisLabel: series.label,
          measureKey: yColumn.label,
          value: typeof payload?.y === 'number' ? payload.y : null,
          clientX: e.clientX,
          clientY: e.clientY,
        };
      };
      // Scatter trendlines: linear only (a moving average needs an ordered
      // category axis). ScatterChart can't host <Line> overlays, so each fit
      // renders as a two-point Scatter with an invisible symbol + its
      // connecting line.
      const trendSegments = (format.trendlines ?? [])
        .filter((t) => t.kind === 'linear')
        .flatMap((t) => {
          const targets = t.seriesKey
            ? visibleSeries.filter((s) => s.key === t.seriesKey)
            : visibleSeries;
          return targets.flatMap((series) => {
            const segment = linearFitSegment(series.points);
            return segment ? [{ id: `${t.id}:${series.key}`, trend: t, series, segment }] : [];
          });
        });
      // Reference lines: scatter's value axis is y; measureKey has no series
      // meaning here, so stats run over ALL plotted points.
      const allY = scatter.series.flatMap((s) => s.points.map((p) => p.y));
      const yTickFormatter = axisTickFormatter(format.yAxisFormat);
      // Axis scales: both scatter axes are numeric, so xAxisScale/yAxisScale
      // both apply. 'auto' un-pins tiny-range clusters from the zero-based
      // default; log falls back to linear (with an in-chart note) when the
      // visible points cross <= 0.
      const visiblePoints = visibleSeries.flatMap((s) => s.points);
      const xScale = resolveAxisScale(
        format.xAxisScale,
        numberExtent(visiblePoints.map((p) => p.x)),
      );
      const yScale = resolveAxisScale(
        format.yAxisScale,
        numberExtent(visiblePoints.map((p) => p.y)),
      );
      const scatterLogNotes: string[] = [];
      if (xScale.logFallback) scatterLogNotes.push('Log x axis needs positive values — kept linear');
      if (yScale.logFallback) scatterLogNotes.push('Log y axis needs positive values — kept linear');
      // Selection highlight: the split value IS the point identity here, so
      // either selection facet may name a series; matching groups keep full
      // opacity + an accent ring, the rest dim to the shared 0.35.
      const scatterHasCategories = (selection?.categories?.length ?? 0) > 0;
      const scatterSelectionOn =
        format.selectionHighlight !== false &&
        selection != null &&
        (selection.category != null || selection.legendValue != null || scatterHasCategories);
      const scatterSelected = (series: (typeof scatter.series)[number]): boolean =>
        scatterSelectionOn &&
        (((selection?.category != null || scatterHasCategories) &&
          selectionCategoryMatches(selection!, series.label, series.raw)) ||
          (selection?.legendValue != null &&
            selectionFacetMatches(selection.legendValue, series.label, series.raw)));
      return (
        <AxisTitleFrame format={format}>
          <div className="relative h-full w-full min-w-0 overflow-hidden">
          <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
            <ScatterChart
              margin={chartMargin(format, { bottom: !htmlXTitle, left: !htmlYTitle })}
              onMouseLeave={hover ? () => hover(null) : undefined}
            >
              {/* Scatter draws both rule sets by default (both axes are
                  numeric value axes); gridX/gridY toggle each explicitly. */}
              <CartesianGrid
                vertical={format.gridX ?? true}
                horizontal={format.gridY ?? true}
                stroke={GRID_STROKE}
              />
              <XAxis
                type="number"
                dataKey="x"
                name={xColumn.label}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={false}
                tickMargin={TICK_MARGIN}
                tickFormatter={axisTickFormatter(format.xAxisFormat)}
                domain={xScale.domain}
                scale={xScale.scale}
                label={
                  htmlXTitle
                    ? undefined
                    : xAxisLabelProps(format.xAxisLabel ?? xColumn.label, format.axisTitleStyle)
                }
              />
              <YAxis
                type="number"
                dataKey="y"
                name={yColumn.label}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={false}
                tickMargin={TICK_MARGIN}
                width={64}
                tickFormatter={yTickFormatter}
                domain={yScale.domain}
                scale={yScale.scale}
                label={
                  htmlYTitle
                    ? undefined
                    : yAxisLabelProps(format.yAxisLabel ?? yColumn.label, format.axisTitleStyle)
                }
              />
              {/* Scatter tooltips are per-ITEM: the coordinate is the dot, and
                  the payload's x/y entries don't map through one value scale,
                  so the card dodges the dot rather than a category slot. */}
              {themedTooltip(formatPoint, format, 'dashed', undefined, 'point')}
              {showLegend && chartLegend(format, scatterLegendItems, legendControl)}
              {visibleSeries.map((series) => (
                <Scatter
                  key={series.key}
                  name={series.label}
                  data={series.points}
                  fill={series.color}
                  // 70% points with a 1px surface ring keep overlapping dots
                  // legible; the hovered point pops to full strength/size.
                  stroke={
                    scatterSelectionOn && scatterSelected(series)
                      ? SELECTION_STROKE
                      : 'var(--rcd-surface)'
                  }
                  strokeWidth={1}
                  // Opacity: an active selection wins (matching group full +
                  // accent ring, the rest 0.35); otherwise the hover
                  // highlight dims the OTHER series' points — the split
                  // value is the series identity for both.
                  fillOpacity={
                    scatterSelectionOn
                      ? scatterSelected(series)
                        ? 1
                        : DIM_OPACITY
                      : highlightCategory &&
                          scatter.series.some((s) => s.label === highlightCategory.label) &&
                          series.label !== highlightCategory.label
                        ? 0.35
                        : 0.7
                  }
                  activeShape={{ size: 120, fillOpacity: 1 }}
                  isAnimationActive={false}
                  cursor={onPointClick ? 'pointer' : undefined}
                  onClick={
                    onPointClick
                      ? (item: unknown, _i: number, event: ReactMouseEvent) =>
                          onPointClick(scatterEvent(series, item, event))
                      : undefined
                  }
                  onContextMenu={
                    onPointContextMenu
                      ? (item: unknown, _i: number, event: ReactMouseEvent) => {
                          event.preventDefault();
                          onPointContextMenu(scatterEvent(series, item, event));
                        }
                      : undefined
                  }
                  onMouseEnter={
                    hover
                      ? (item: unknown, _i: number, event: ReactMouseEvent) =>
                          hover(scatterEvent(series, item, event))
                      : undefined
                  }
                />
              ))}
              {trendSegments.map((t) => (
                <Scatter
                  key={t.id}
                  data={t.segment}
                  line={{
                    stroke: t.trend.color ?? t.series.color,
                    strokeOpacity: t.trend.color ? 1 : 0.7,
                    strokeWidth: t.trend.width ?? 2,
                    strokeDasharray: guideDash(t.trend.dash),
                  }}
                  shape={noShape}
                  legendType="none"
                  tooltipType="none"
                  isAnimationActive={false}
                />
              ))}
              {(format.referenceLines ?? []).flatMap((ref) => {
                const value = referenceLineValue(ref, allY);
                return value === null ? [] : [guideReferenceLine(ref, value, 'y', yTickFormatter)];
              })}
            </ScatterChart>
          </ResponsiveContainer>
          {scatter.droppedSeries > 0 && (
            <div className="absolute right-2 top-1 rounded border border-rcd-border bg-rcd-surface px-1.5 py-0.5 text-[10px] text-rcd-muted">
              +{scatter.droppedSeries} more series not shown
            </div>
          )}
          {scatterLogNotes.length > 0 && (
            // Console-free log-fallback marker (left side: the right badge
            // slot belongs to the dropped-series note).
            <div className="pointer-events-none absolute left-2 top-1 rounded border border-rcd-border bg-rcd-surface px-1.5 py-0.5 text-[10px] text-rcd-muted">
              {scatterLogNotes.join(' · ')}
            </div>
          )}
          </div>
        </AxisTitleFrame>
      );
    }

    case 'gantt':
      // Timeline bars over the shared legend/selection/tooltip system; the
      // gantt file reuses (imports) this file's primitives rather than
      // forking them.
      return (
        <GanttChart
          spec={spec}
          result={result}
          legend={legendControl}
          onDatumClick={onDatumClick}
          onPointClick={onPointClick}
          onPointContextMenu={onPointContextMenu}
          onPointHover={hover}
          activeCategory={activeCategory}
          highlightCategory={highlightCategory}
          selection={selection}
        />
      );

    case 'kpi': {
      const row = result.rows[0];
      const primary = measureColumns[0];
      if (!row || !primary) return <Placeholder>KPI needs a measure.</Placeholder>;

      const kpiText = (value: CellValue, column: QueryColumn): string =>
        typeof value === 'number' && format.valueFormat
          ? valueFormatText(value, format.valueFormat)
          : formatCellValue(value, column);

      const primaryValue = row[result.columns.indexOf(primary)] ?? null;
      const secondary = measureColumns[1];
      const secondaryValue = secondary ? (row[result.columns.indexOf(secondary)] ?? null) : null;
      const kpiLabel = (column: QueryColumn): string =>
        format.seriesLabels?.[column.label] ?? column.label;
      // 'kpi' conditional rules color the primary value text (keyed by the
      // measure's DEFAULT label, like every other measureKey).
      const kpiColor = conditionalColor(
        format.conditionalFormats,
        'kpi',
        primary.label,
        primaryValue,
      );

      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
          {/* leading-none: the number's font box otherwise sits optically low
              in the tile (4xl line-height adds ~25% dead space above/below). */}
          <div
            className="text-4xl font-semibold leading-none tracking-tight tabular-nums text-rcd-text"
            style={kpiColor ? { color: kpiColor } : undefined}
          >
            {kpiText(primaryValue, primary)}
          </div>
          <div
            className="text-xs font-medium uppercase tracking-[0.08em] text-rcd-text-2"
            style={textStyleToCss(format.titleStyle)}
          >
            {kpiLabel(primary)}
          </div>
          {secondary && (
            // Delta-ready secondary row: value leads in weight, its label
            // trails muted — ready to carry a change indicator.
            <div className="mt-0.5 flex items-baseline gap-1.5 text-sm">
              <span className="font-medium tabular-nums text-rcd-text-2">
                {kpiText(secondaryValue, secondary)}
              </span>
              <span className="text-xs text-rcd-muted">{kpiLabel(secondary)}</span>
            </div>
          )}
        </div>
      );
    }

    case 'table':
      // The tile drives the DATA (server-side sort/offset/limit + a separate
      // totals query); TableChart renders the chrome and emits intents.
      return (
        <TableChart
          spec={spec}
          result={result}
          onDatumClick={onDatumClick}
          onPointClick={onPointClick}
          onPointContextMenu={onPointContextMenu}
          onPointHover={hover}
          highlightCategory={highlightCategory}
          selection={selection}
          tableSort={tableSort}
          onTableSortChange={onTableSortChange}
          tablePage={tablePage}
          tablePageCount={tablePageCount}
          onTablePageChange={onTablePageChange}
          totalsRow={totalsRow}
          onTableLayoutChange={onTableLayoutChange}
          tableFilters={tableFilters}
          onTableFilterChange={onTableFilterChange}
          onRequestColumnValues={onRequestColumnValues}
        />
      );

    default:
      return <Placeholder>Chart type “{spec.type}” isn’t supported.</Placeholder>;
  }
}
