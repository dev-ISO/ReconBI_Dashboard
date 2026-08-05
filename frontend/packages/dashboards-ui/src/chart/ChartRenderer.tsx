import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
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
  type ConditionalFormatSpec,
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
  matchRuleColor,
  referenceLineValue,
  seriesValues,
  sharedValueDomain,
  type TrendlineOverlay,
} from './analytics';
import { textStyleToCss } from './textStyle';

/** Payload of a cross-filter datum click. */
export interface ChartDatumClickInfo {
  /** RAW (pre-format) cell value of the clicked category; null = blank. */
  value: CellValue;
  /** Formatted display label of the clicked category. */
  label: string;
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
}

const axisTickStyle = { fontSize: 11, fill: 'var(--rcd-text-2)' } as const;

const legendWrapperStyle = { fontSize: 12, color: 'var(--rcd-text-2)' } as const;

/** Debounce (ms) for ResponsiveContainer re-measures during grid/tile resizes. */
const RESIZE_DEBOUNCE = 60;

const TABLE_ROW_CAP = 500;

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

function makeValueFormatter(format: ChartFormat, measureColumns: QueryColumn[]): ValueFormatter {
  const overrideColumn = format.valueFormat ? formatHintColumn(format.valueFormat) : null;
  return (value, seriesKey) => {
    if (typeof value !== 'number') return value == null ? '' : String(value);
    // measureNameForKey unwraps combo (measure × legend) dataKeys to their
    // measure column; plain keys pass through unchanged.
    const column =
      overrideColumn ??
      (seriesKey ? measureColumns.find((c) => c.name === measureNameForKey(seriesKey)) : undefined) ??
      measureColumns[0];
    return column ? formatCellValue(value, column) : String(value);
  };
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
interface LegendItemDatum {
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
interface LegendControl {
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
          : 'flex flex-wrap items-center justify-center gap-x-3 gap-y-1'
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
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
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
function chartLegend(
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
function AxisTitleFrame({ format, children }: { format: ChartFormat; children: ReactNode }) {
  const xHtml = useMemo(
    () => (format.xAxisLabelHtml ? sanitizeRichHtml(format.xAxisLabelHtml) : ''),
    [format.xAxisLabelHtml],
  );
  const yHtml = useMemo(
    () => (format.yAxisLabelHtml ? sanitizeRichHtml(format.yAxisLabelHtml) : ''),
    [format.yAxisLabelHtml],
  );
  if (xHtml === '' && yHtml === '') return <>{children}</>;
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
): ReactNode {
  const color = ref.color ?? 'var(--rcd-muted)';
  // Label: explicit label, else "<kind> <formatted value>". 'constant' keeps
  // just the value — "constant 42" reads like a bug.
  const prefix = ref.kind === 'constant' ? '' : `${ref.kind} `;
  return (
    <ReferenceLine
      key={ref.id}
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

type TooltipCursor = 'fill' | 'line' | 'dashed' | 'none';

/** Shape of one recharts tooltip payload entry (the fields we read). */
interface TooltipPayloadEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: string | number;
  payload?: unknown;
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
 * active/payload/label are injected by recharts when it clones the element.
 */
function RcdChartTooltip({
  active,
  payload,
  label,
  styleSpec,
  formatEntry,
  showPercent = false,
  percentTotal,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  styleSpec: TooltipStyle | undefined;
  formatEntry: (value: unknown, dataKey: string | undefined) => string;
  showPercent?: boolean;
  /** Percent denominator override (pie: visible-slice total); else payload sum. */
  percentTotal?: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const accent = styleSpec?.accentBorder !== false;
  const card: CSSProperties = {
    background: styleSpec?.background || 'var(--rcd-surface)',
    color: styleSpec?.textColor || 'var(--rcd-text)',
  };
  const total =
    percentTotal ??
    payload.reduce((sum, e) => sum + (typeof e.value === 'number' ? e.value : 0), 0);
  return (
    <div
      className="max-w-[280px] rounded-lg border border-rcd-border px-2.5 py-2 text-xs shadow-lg"
      style={card}
    >
      {label !== undefined && label !== '' && (
        <div className="mb-1 truncate font-semibold">{String(label)}</div>
      )}
      <div className="flex flex-col gap-1">
        {payload.map((entry, i) => {
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
                  className="h-3 w-[3px] shrink-0 rounded-full"
                  style={{ background: color }}
                />
              ) : (
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ background: color }}
                />
              )}
              <span className="min-w-0 flex-1 truncate opacity-75">
                {entry.name != null ? String(entry.name) : ''}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">
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
 * Tooltip element for one chart (all types share it); null when
 * format.tooltip.enabled === false. `percent` marks the chart shapes where
 * showPercent applies (pie/donut/stacked) and optionally pins the denominator.
 */
function themedTooltip(
  formatEntry: (value: unknown, dataKey: string | undefined) => string,
  format: ChartFormat,
  cursor: TooltipCursor,
  percent?: { active: boolean; total?: number },
): ReactNode {
  if (format.tooltip?.enabled === false) return null;
  const cursorProp =
    cursor === 'fill'
      ? { fill: 'var(--rcd-border)' }
      : cursor === 'line'
        ? { stroke: 'var(--rcd-axis)' }
        : cursor === 'dashed'
          ? { stroke: 'var(--rcd-axis)', strokeDasharray: '4 4' }
          : false;
  return (
    <Tooltip
      cursor={cursorProp}
      isAnimationActive={false}
      // Flip ABOVE the cursor (default x keeps it to the right) so the card
      // never covers the datum; still clamps inside the chart.
      reverseDirection={{ y: true }}
      content={
        <RcdChartTooltip
          styleSpec={format.tooltip}
          formatEntry={formatEntry}
          showPercent={percent?.active === true && format.tooltip?.showPercent === true}
          percentTotal={percent?.total}
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
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setFrameSize({ width: node.clientWidth, height: node.clientHeight });
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
  }, []);
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

function Placeholder({ children }: { children: ReactNode }) {
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
  activeCategory?: { label: string } | null;
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
  activeCategory = null,
  panel,
}: CartesianChartProps) {
  const format = spec.format;
  const hidden = legend.hidden;
  const horizontal = spec.type === 'bar' || spec.type === 'stackedBar';
  const stacked = spec.type === 'stackedColumn' || spec.type === 'stackedBar';
  const isBars = spec.type !== 'line' && spec.type !== 'area';
  // Rich-HTML axis titles render OUTSIDE the plot (AxisTitleFrame) and replace
  // the SVG labels entirely.
  const htmlXTitle = Boolean(format.xAxisLabelHtml);
  const htmlYTitle = Boolean(format.yAxisLabelHtml);
  // Panels never render their own legend — the grid shares ONE legend.
  const showLegend = !panel && (format.showLegend ?? shaped.series.length > 1);
  const visibleSeries = shaped.series.filter((s) => !hidden.has(s.key));
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
  const renderCells = colorByCategory || dimming || barFillActive;
  const valueTickFormatter = axisTickFormatter(
    horizontal ? format.xAxisFormat : format.yAxisFormat,
  );

  // Trendlines: column/stackedColumn/line/area only — horizontal bars would
  // need value-axis fitting and are skipped silently (as are pie/kpi/table).
  // The overlays are injected into row COPIES under synthetic keys, so the
  // shaped data the legend/reference lines read stays untouched.
  const trendSpecs = !horizontal ? (format.trendlines ?? []) : [];
  const { rows, overlays } =
    trendSpecs.length > 0
      ? buildTrendlines(trendSpecs, visibleSeries, shaped.data)
      : { rows: shaped.data, overlays: [] as TrendlineOverlay[] };

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

  // Recharts hands (barItem, index, event) — index addresses the plotted rows
  // directly, which is sturdier across recharts versions than digging into
  // payload. Cross-filter (onDatumClick) and the point event BOTH fire; the
  // consumer decides what each means.
  const barClick = (series: ChartSeries) =>
    onDatumClick || onPointClick
      ? (_: unknown, index: number, event: ReactMouseEvent) => {
          const row = rows[index];
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
          const row = rows[index];
          if (!row) return;
          event.preventDefault();
          onPointContextMenu(pointEvent(row, series, event));
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
            r={3}
            cursor="pointer"
            onClick={(_, event) => {
              const row = dotProps.payload as Record<string, CellValue> | undefined;
              onPointClick(pointEvent(row, series, event));
            }}
          />
        )
      : undefined;

  // Line/area context menu resolves the ACTIVE hovered category from the
  // chart-level hover state; no specific series is struck, so measureKey and
  // value stay undefined. Bars use per-mark onContextMenu instead.
  const chartContextMenu =
    !isBars && onPointContextMenu
      ? (state: MouseHandlerDataParam, event: ReactMouseEvent<SVGGraphicsElement>) => {
          const raw = state.activeTooltipIndex;
          const index = typeof raw === 'number' ? raw : raw != null ? Number(raw) : NaN;
          const row = Number.isInteger(index) ? rows[index] : undefined;
          if (!row) return;
          event.preventDefault();
          onPointContextMenu(pointEvent(row, undefined, event));
        }
      : undefined;

  // Reference lines sit on the VALUE axis (y normally, x for horizontal
  // bars). Computed kinds read the FULL plotted dataset of the target series
  // (see referenceLineValue for why visibility is ignored); in small-multiple
  // panels each panel computes its own stats — every panel is its own chart.
  const referenceLines = (format.referenceLines ?? []).flatMap((ref) => {
    const target =
      (ref.measureKey ? shaped.series.find((s) => s.styleKey === ref.measureKey) : undefined) ??
      shaped.series[0];
    const value = referenceLineValue(ref, target ? seriesValues(shaped.data, target.key) : []);
    if (value === null) return [];
    return [guideReferenceLine(ref, value, horizontal ? 'x' : 'y', valueTickFormatter)];
  });

  return (
    <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
      <ComposedChart
        data={rows}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={panel ? { top: 4, right: 6, bottom: 2, left: 2 } : chartMargin(format)}
        onContextMenu={chartContextMenu}
      >
        <CartesianGrid
          vertical={isBars ? horizontal : false}
          horizontal={isBars ? !horizontal : true}
          stroke="var(--rcd-grid-line)"
        />
        {horizontal ? (
          <XAxis
            type="number"
            tick={panel && !panel.showXTicks ? false : axisTickStyle}
            tickLine={false}
            axisLine={false}
            tickFormatter={valueTickFormatter}
            domain={panel?.valueDomain}
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
            tick={panel && !panel.showXTicks ? false : axisTickStyle}
            tickLine={false}
            axisLine={{ stroke: 'var(--rcd-axis)' }}
            // Dense category axes drop interior ticks instead of colliding;
            // first/last stay so the extent is always readable.
            interval="preserveStartEnd"
            minTickGap={8}
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
            axisLine={{ stroke: 'var(--rcd-axis)' }}
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
            width={panel ? (panel.showYTicks ? 42 : 8) : 56}
            tickFormatter={valueTickFormatter}
            domain={panel?.valueDomain}
            label={
              panel || htmlYTitle
                ? undefined
                : yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)
            }
          />
        )}
        {themedTooltip(formatValue, format, isBars ? 'fill' : 'line', stacked ? { active: true } : undefined)}
        {showLegend && chartLegend(format, seriesLegendItems(shaped.series), legend)}
        {visibleSeries.map((series) => {
          if (isBars) {
            const handleClick = barClick(series);
            return (
              <Bar
                key={series.key}
                dataKey={series.key}
                name={series.label}
                fill={series.color}
                stroke="var(--rcd-surface)"
                strokeWidth={stacked ? 2 : 1}
                stackId={stacked ? 'stack' : undefined}
                radius={stacked ? 0 : horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]}
                isAnimationActive={false}
                cursor={handleClick ? 'pointer' : undefined}
                onClick={handleClick}
                onContextMenu={barContextMenu(series)}
              >
                {renderCells &&
                  rows.map((row, dataIndex) => {
                    const categoryLabel = String(row[shaped.axisKey] ?? '');
                    // Fill precedence: explicit colorOverrides keyed by the
                    // CATEGORY label (colorByCategory mode) > first matching
                    // barFill rule > palette slot / series color. An explicit
                    // per-category override is the strongest user intent;
                    // rules still beat the default palette.
                    const paletteFill = colorByCategory
                      ? seriesColor(dataIndex, categoryLabel, format.colorOverrides, format.theme)
                      : series.color;
                    const overridden =
                      colorByCategory && Boolean(format.colorOverrides?.[categoryLabel]);
                    const ruleFill =
                      !overridden && barFillActive
                        ? conditionalColor(
                            format.conditionalFormats,
                            'barFill',
                            series.styleKey,
                            row[series.key] ?? null,
                          )
                        : undefined;
                    return (
                      <Cell
                        key={dataIndex}
                        fill={ruleFill ?? paletteFill}
                        fillOpacity={
                          dimming && activeCategory && categoryLabel !== activeCategory.label
                            ? 0.35
                            : undefined
                        }
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
                      typeof label === 'number' ? formatValue(label, series.key) : label
                    }
                  />
                )}
              </Bar>
            );
          }
          const lineStyle = format.lineStyles?.[series.styleKey];
          if (spec.type === 'line') {
            return (
              <Line
                key={series.key}
                type="linear"
                dataKey={series.key}
                name={series.label}
                stroke={series.color}
                strokeWidth={lineStyle?.width ?? 2}
                strokeDasharray={strokeDash(lineStyle)}
                dot={false}
                activeDot={clickableActiveDot(series) ?? { r: 3 }}
                isAnimationActive={false}
              />
            );
          }
          return (
            <Area
              key={series.key}
              type="linear"
              dataKey={series.key}
              name={series.label}
              stroke={series.color}
              strokeWidth={lineStyle?.width ?? 2}
              strokeDasharray={strokeDash(lineStyle)}
              fill={series.color}
              fillOpacity={0.25}
              dot={false}
              activeDot={clickableActiveDot(series)}
              isAnimationActive={false}
            />
          );
        })}
        {overlays.map((overlay) => (
          <Line
            key={overlay.dataKey}
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
      </ComposedChart>
    </ResponsiveContainer>
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
  activeCategory?: { label: string } | null;
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
  activeCategory = null,
}: SmallMultiplesChartProps) {
  const hidden = legend.hidden;
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setFrameSize({ width: node.clientWidth, height: node.clientHeight });
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
  }, []);

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
  const visibleKeys = canonical.series.filter((s) => !hidden.has(s.key)).map((s) => s.key);
  const valueDomain = sharedY
    ? sharedValueDomain(
        panelShaped.map((p) => p.shaped.data),
        visibleKeys,
        stacked,
      )
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

  const showLegend = format.showLegend ?? canonical.series.length > 1;
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
        items={seriesLegendItems(canonical.series)}
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
                  activeCategory={activeCategory}
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
  onLegendSelect,
  selectedLegendLabel = null,
}: ChartRendererProps) {
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(NO_HIDDEN);
  const format = spec.format;
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
      // Small multiples: the third ordered dimension splits the chart into a
      // panel grid (cartesian family only — other types ignore it).
      const panels = splitSmallMultiples(result, spec);
      if (panels && panels.length > 0) {
        // The title frame wraps the WHOLE grid: one shared x/y title pair.
        return (
          <AxisTitleFrame format={format}>
            <SmallMultiplesChart
              spec={spec}
              panels={panels}
              formatValue={formatValue}
              legend={legendControl}
              onDatumClick={onDatumClick}
              onPointClick={onPointClick}
              onPointContextMenu={onPointContextMenu}
              activeCategory={activeCategory}
            />
          </AxisTitleFrame>
        );
      }
      return (
        <AxisTitleFrame format={format}>
          <CartesianChart
            spec={spec}
            shaped={shapeChartData(result, spec)}
            formatValue={formatValue}
            legend={legendControl}
            onDatumClick={onDatumClick}
            onPointClick={onPointClick}
            onPointContextMenu={onPointContextMenu}
            activeCategory={activeCategory}
          />
        </AxisTitleFrame>
      );
    }

    case 'pie':
    case 'donut': {
      const { slices } = shapePieData(result, spec);
      if (slices.length === 0) return <Placeholder>Pie needs a measure.</Placeholder>;
      const showLegend = format.showLegend ?? slices.length > 1;
      // Slices carry a legend identity (crossFilter) only when a dimension
      // labels them; a dimensionless pie is a single measure-named slice.
      const hasSliceDimension = result.columns.some((c) => c.role === 'dimension');
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
      return (
        <CenteredPieFrame legendRight={showLegend && format.legendPosition === 'right'}>
          <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
            <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              {themedTooltip(formatValue, format, 'none', { active: true, total: visibleTotal })}
              {showLegend && chartLegend(format, sliceLegendItems, legendControl)}
              <Pie
                data={visibleSlices}
                dataKey="value"
                nameKey="label"
                innerRadius={spec.type === 'donut' ? '55%' : 0}
                outerRadius="85%"
                stroke="var(--rcd-surface)"
                strokeWidth={2}
                isAnimationActive={false}
                cursor={handleSliceClick ? 'pointer' : undefined}
                onClick={handleSliceClick}
                onContextMenu={handleSliceContextMenu}
              >
                {visibleSlices.map((slice, i) => (
                  <Cell
                    key={`${i}-${slice.label}`}
                    fill={slice.color}
                    fillOpacity={
                      dimHiddenSlices && hidden.has(slice.label)
                        ? 0.15
                        : activeCategory && slice.label !== activeCategory.label
                          ? 0.35
                          : undefined
                    }
                  />
                ))}
              </Pie>
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
      const overrideColumn = format.valueFormat ? formatHintColumn(format.valueFormat) : null;
      const formatPoint = (value: unknown, dataKey: string | undefined): string => {
        if (typeof value !== 'number') return value == null ? '' : String(value);
        return formatCellValue(value, overrideColumn ?? (dataKey === 'y' ? yColumn : xColumn));
      };
      const showLegend = format.showLegend ?? scatter.series.length > 1;
      const visibleSeries = scatter.series.filter((s) => !hidden.has(s.key));
      // The split carries a legend identity (crossFilter) only when it IS the
      // legend dimension; an axis-only split still colors groups but has
      // nothing to cross-filter by.
      const splitIsLegend = Boolean(spec.query.legend);
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
      return (
        <AxisTitleFrame format={format}>
          <div className="relative h-full w-full min-w-0 overflow-hidden">
          <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
            <ScatterChart margin={chartMargin(format, { bottom: !htmlXTitle, left: !htmlYTitle })}>
              <CartesianGrid stroke="var(--rcd-grid-line)" />
              <XAxis
                type="number"
                dataKey="x"
                name={xColumn.label}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={{ stroke: 'var(--rcd-axis)' }}
                tickFormatter={axisTickFormatter(format.xAxisFormat)}
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
                width={64}
                tickFormatter={yTickFormatter}
                label={
                  htmlYTitle
                    ? undefined
                    : yAxisLabelProps(format.yAxisLabel ?? yColumn.label, format.axisTitleStyle)
                }
              />
              {themedTooltip(formatPoint, format, 'dashed')}
              {showLegend && chartLegend(format, scatterLegendItems, legendControl)}
              {visibleSeries.map((series) => (
                <Scatter
                  key={series.key}
                  name={series.label}
                  data={series.points}
                  fill={series.color}
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
          </div>
        </AxisTitleFrame>
      );
    }

    case 'kpi': {
      const row = result.rows[0];
      const primary = measureColumns[0];
      if (!row || !primary) return <Placeholder>KPI needs a measure.</Placeholder>;

      const kpiText = (value: CellValue, column: QueryColumn): string =>
        typeof value === 'number' && format.valueFormat
          ? formatCellValue(value, formatHintColumn(format.valueFormat))
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
        <div className="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center">
          {/* leading-none: the number's font box otherwise sits optically low
              in the tile (4xl line-height adds ~25% dead space above/below). */}
          <div
            className="text-4xl font-semibold leading-none tabular-nums text-rcd-text"
            style={kpiColor ? { color: kpiColor } : undefined}
          >
            {kpiText(primaryValue, primary)}
          </div>
          <div className="text-sm text-rcd-text-2" style={textStyleToCss(format.titleStyle)}>
            {kpiLabel(primary)}
          </div>
          {secondary && (
            <div className="mt-1 text-sm tabular-nums text-rcd-muted">
              {kpiText(secondaryValue, secondary)} {kpiLabel(secondary)}
            </div>
          )}
        </div>
      );
    }

    case 'table': {
      const rows = result.rows.slice(0, TABLE_ROW_CAP);
      // Header text follows legendStyle; measure headers honor seriesLabels.
      const headerStyle = textStyleToCss(format.legendStyle);
      // Row click cross-filters by the FIRST dimension column (when present).
      // No dimming for tables (v1) — the active row isn't visually marked.
      const clickColumn = result.columns.find((c) => c.role === 'dimension') ?? null;
      const clickIndex = clickColumn ? result.columns.indexOf(clickColumn) : -1;
      const handleRowClick =
        onDatumClick && clickColumn
          ? (row: CellValue[]) =>
              onDatumClick({
                value: row[clickIndex] ?? null,
                label: formatCellValue(row[clickIndex] ?? null, clickColumn),
              })
          : null;
      // Point events also need the dimension for axisValue; rows without one
      // stay silent (there is nothing meaningful to report).
      const rowEvent =
        clickColumn && (onPointClick || onPointContextMenu)
          ? (row: CellValue[], e: { clientX: number; clientY: number }): ChartPointEvent => ({
              axisValue: row[clickIndex] ?? null,
              axisLabel: formatCellValue(row[clickIndex] ?? null, clickColumn),
              clientX: e.clientX,
              clientY: e.clientY,
            })
          : null;
      // Data bars scale to the DISPLAYED rows' max |value| per column (rows
      // beyond the cap aren't rendered, and scaling to them would mislead).
      const dataBars = new Map<
        string,
        { cf: ConditionalFormatSpec; maxAbs: number; hasNegative: boolean }
      >();
      for (const column of measureColumns) {
        const cf = format.conditionalFormats?.find(
          (f) => f.style === 'dataBar' && f.measureKey === column.label,
        );
        if (!cf) continue;
        const columnIndex = result.columns.indexOf(column);
        let maxAbs = 0;
        let hasNegative = false;
        for (const row of rows) {
          const v = row[columnIndex];
          if (typeof v !== 'number') continue;
          if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
          if (v < 0) hasNegative = true;
        }
        if (maxAbs > 0) dataBars.set(column.name, { cf, maxAbs, hasNegative });
      }
      const clickable = Boolean(handleRowClick) || Boolean(rowEvent && onPointClick);
      return (
        <div className="h-full w-full overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th
                    key={column.name}
                    style={headerStyle}
                    className={`sticky top-0 border-b border-rcd-border bg-rcd-surface px-3 py-2 text-xs font-semibold text-rcd-text-2 ${
                      column.role === 'measure' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {column.role === 'measure'
                      ? (format.seriesLabels?.[column.label] ?? column.label)
                      : column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  onClick={
                    handleRowClick || (rowEvent && onPointClick)
                      ? (e) => {
                          handleRowClick?.(row);
                          if (rowEvent && onPointClick) onPointClick(rowEvent(row, e));
                        }
                      : undefined
                  }
                  onContextMenu={
                    rowEvent && onPointContextMenu
                      ? (e) => {
                          e.preventDefault();
                          onPointContextMenu(rowEvent(row, e));
                        }
                      : undefined
                  }
                  className={
                    clickable
                      ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/10'
                      : 'hover:bg-black/5 dark:hover:bg-white/10'
                  }
                >
                  {result.columns.map((column, columnIndex) => {
                    const raw = row[columnIndex] ?? null;
                    const isMeasure = column.role === 'measure';
                    // cellBackground / cellText rules key the measure's
                    // DEFAULT label; first matching spec (then rule) wins.
                    const cellBackground = isMeasure
                      ? conditionalColor(format.conditionalFormats, 'cellBackground', column.label, raw)
                      : undefined;
                    const cellText = isMeasure
                      ? conditionalColor(format.conditionalFormats, 'cellText', column.label, raw)
                      : undefined;
                    const dataBar = isMeasure ? dataBars.get(column.name) : undefined;
                    const text = formatCellValue(raw, column);
                    let content: ReactNode = text;
                    if (dataBar && typeof raw === 'number') {
                      // Proportional bar behind the value, scaled to the
                      // column's max |value|. With negatives, zero sits at
                      // mid-cell: positives grow right, negatives left, each
                      // scaled into its half; all-positive columns use the
                      // full width. Rules may recolor a matching cell's bar;
                      // dataBarColor (default theme accent) otherwise.
                      const fraction = Math.abs(raw) / dataBar.maxAbs;
                      const barColor =
                        matchRuleColor(dataBar.cf.rules, raw) ??
                        dataBar.cf.dataBarColor ??
                        'var(--rcd-accent)';
                      const barBox: CSSProperties = dataBar.hasNegative
                        ? raw >= 0
                          ? { left: '50%', width: `${fraction * 50}%` }
                          : { right: '50%', width: `${fraction * 50}%` }
                        : { left: 0, width: `${fraction * 100}%` };
                      content = (
                        <div className="relative">
                          <div
                            aria-hidden
                            className="absolute inset-y-0 rounded-sm"
                            style={{ ...barBox, background: barColor, opacity: 0.3 }}
                          />
                          <span className="relative">{text}</span>
                        </div>
                      );
                    }
                    return (
                      <td
                        key={column.name}
                        style={
                          cellBackground || cellText
                            ? { background: cellBackground, color: cellText }
                            : undefined
                        }
                        className={`border-b border-rcd-border px-3 py-1.5 text-rcd-text ${
                          isMeasure ? 'text-right tabular-nums' : 'text-left'
                        }`}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length > TABLE_ROW_CAP && (
            <div className="px-3 py-2 text-xs text-rcd-muted">
              Showing {TABLE_ROW_CAP} of {result.rows.length} rows
            </div>
          )}
        </div>
      );
    }

    default:
      return <Placeholder>Chart type “{spec.type}” isn’t supported.</Placeholder>;
  }
}
