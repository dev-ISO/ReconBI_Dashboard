import { useId, useMemo, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatDateLabel,
  formatDatePattern,
  seriesColor,
  type CellValue,
  type ChartPointEvent,
  type ChartSpec,
  type GanttOptions,
  type QueryColumn,
  type QueryResult,
} from '@recon/dashboards-core';
import { RAW_AXIS_KEY, shapeGanttData, type GanttTask, type ShapedGanttData } from './chartData';
// Shared primitives from the renderer (intentional, module-eval-safe cycle):
// the SAME tooltip card + placement, interactive legend, selection tokens and
// placeholder every other chart uses — reused, not forked.
import {
  chartLegend,
  DIM_OPACITY,
  GRID_STROKE,
  Placeholder,
  RcdChartTooltip,
  SELECTION_STROKE,
  selectionCategoryMatches,
  selectionFacetMatches,
  TIP_ORIGIN,
  type ChartDatumClickInfo,
  type ChartSelection,
  type LegendControl,
  type LegendItemDatum,
  type TooltipPayloadEntry,
} from './ChartRenderer';

/* -------------------------------------------------------------------------
 * Time axis: nice date ticks + auto masks + humanized durations
 * ---------------------------------------------------------------------- */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Never render more than this many ticks (keeps narrow tiles readable). */
const TICK_TARGET = 7;

/**
 * Epoch-aligned tick walk for sub-month steps. Alignment is to UTC multiples
 * on purpose: date-typed cells parse to UTC midnights (same `new Date(iso)`
 * the rest of the app uses), so UTC-aligned day/week ticks land exactly on
 * the bar-start grid instead of a local-midnight grid that misses it.
 */
const epochTicks =
  (step: number) =>
  (min: number, max: number): number[] => {
    const out: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max; t += step) out.push(t);
    return out;
  };

/** UTC month-boundary tick walk (stepMonths = 3 → quarters, 12 → years…). */
const monthTicks =
  (stepMonths: number) =>
  (min: number, max: number): number[] => {
    const first = new Date(min);
    let months = first.getUTCFullYear() * 12 + first.getUTCMonth();
    if (Date.UTC(Math.floor(months / 12), months % 12, 1) < min) months += 1;
    const rem = months % stepMonths;
    if (rem !== 0) months += stepMonths - rem;
    const out: number[] = [];
    for (;;) {
      const t = Date.UTC(Math.floor(months / 12), months % 12, 1);
      if (t > max) break;
      out.push(t);
      months += stepMonths;
    }
    return out;
  };

interface TickCandidate {
  /** Approximate step width, for choosing (months use a 30.44-day mean). */
  approx: number;
  /** Auto label mask (formatDatePattern tokens; quotes are literals). */
  mask: string;
  ticks: (min: number, max: number) => number[];
}

const TICK_CANDIDATES: readonly TickCandidate[] = [
  ...[1, 5, 15, 30].map((n) => ({ approx: n * MINUTE, mask: 'HH:mm', ticks: epochTicks(n * MINUTE) })),
  ...[1, 3, 6, 12].map((n) => ({ approx: n * HOUR, mask: 'HH:mm', ticks: epochTicks(n * HOUR) })),
  ...[1, 2].map((n) => ({ approx: n * DAY, mask: 'd MMM', ticks: epochTicks(n * DAY) })),
  ...[1, 2].map((n) => ({ approx: n * WEEK, mask: 'd MMM', ticks: epochTicks(n * WEEK) })),
  { approx: 30.44 * DAY, mask: 'MMM yyyy', ticks: monthTicks(1) },
  { approx: 91.3 * DAY, mask: '"Q"Qq yyyy', ticks: monthTicks(3) },
  { approx: 182.6 * DAY, mask: 'MMM yyyy', ticks: monthTicks(6) },
  ...[1, 2, 5, 10, 20, 50, 100].map((n) => ({
    approx: n * 365.25 * DAY,
    mask: 'yyyy',
    ticks: monthTicks(n * 12),
  })),
];

/** Smallest candidate step that keeps the tick count at or under the target. */
const pickTickPlan = (min: number, max: number): { ticks: number[]; mask: string } => {
  const span = Math.max(1, max - min);
  for (const candidate of TICK_CANDIDATES) {
    if (span / candidate.approx <= TICK_TARGET) {
      const ticks = candidate.ticks(min, max);
      if (ticks.length >= 2) return { ticks, mask: candidate.mask };
    }
  }
  // Degenerate span (or a pathological range): just label the two ends.
  return { ticks: [min, max], mask: 'd MMM yyyy' };
};

/** "12 days" / "3.5 hours" / "2 months" — tooltip duration text. */
export const humanizeDurationMs = (ms: number): string => {
  const abs = Math.abs(ms);
  const say = (value: number, unit: string): string => {
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${text} ${unit}${rounded === 1 ? '' : 's'}`;
  };
  if (abs < HOUR) return say(abs / MINUTE, 'minute');
  if (abs < 2 * DAY) return say(abs / HOUR, 'hour');
  if (abs < 60 * DAY) return say(abs / DAY, 'day');
  if (abs < 730 * DAY) return say(abs / (30.44 * DAY), 'month');
  return say(abs / (365.25 * DAY), 'year');
};

/* -------------------------------------------------------------------------
 * Chart
 * ---------------------------------------------------------------------- */

const AXIS_KEY = '__axis';
const TASK_KEY = '__task';
const RANGE_KEY = '__range';

/** Category-axis rail width when task labels render on the axis. */
const TASK_AXIS_WIDTH = 110;

/** Minimum drawn bar width px (zero-duration tasks read as milestones). */
const MIN_BAR_PX = 2;

/** Inside labels only render when the bar can actually carry the text. */
const INSIDE_LABEL_MIN_PX = 48;

const axisTickStyle = { fontSize: 11, fill: 'var(--rcd-muted)' } as const;

/** One plotted row: category label + raw + the [start, end] range + its task. */
type GanttRow = Record<string, CellValue | [number, number] | GanttTask>;

/** Geometry recharts hands a Bar shape/background renderer (fields we read). */
interface BarShapeGeom {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
}

export interface GanttChartProps {
  spec: ChartSpec;
  result: QueryResult;
  legend: LegendControl;
  onDatumClick?: (info: ChartDatumClickInfo) => void;
  onPointClick?: (e: ChartPointEvent) => void;
  onPointContextMenu?: (e: ChartPointEvent) => void;
  /** Already throttled by ChartRenderer; undefined = don't attach handlers. */
  onPointHover?: (e: ChartPointEvent | null) => void;
  activeCategory?: { label: string } | null;
  highlightCategory?: { label: string } | null;
  selection?: ChartSelection | null;
}

/** Full date-time text for tooltip start/end rows (time only when it exists). */
const boundText = (ms: number, column: QueryColumn | null): string =>
  formatDatePattern(new Date(ms), column?.type === 'timestamp' ? 'd MMM yyyy HH:mm' : 'd MMM yyyy');

/**
 * Tooltip content adapter: recharts injects active/payload/label/coordinate;
 * the single ranged-bar payload entry is expanded into the gantt's smart rows
 * (group, start, end, humanized duration, progress) and rendered through the
 * SHARED RcdChartTooltip card, so styling and the dodge-the-data placement
 * behave exactly like every other chart.
 */
function GanttTooltipContent({
  active,
  payload,
  label,
  coordinate,
  spec,
  shaped,
  colorOf,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  coordinate?: { x?: number; y?: number };
  spec: ChartSpec;
  shaped: ShapedGanttData;
  colorOf: (task: GanttTask) => string;
}) {
  const row = payload?.[0]?.payload as GanttRow | undefined;
  const task = row?.[TASK_KEY] as GanttTask | undefined;
  const rename = (name: string): string => spec.format.seriesLabels?.[name] ?? name;
  const entries: TooltipPayloadEntry[] = [];
  if (task) {
    if (task.group !== null) {
      entries.push({ name: 'Group', value: rename(task.group), color: colorOf(task) });
    }
    entries.push({
      name: rename(shaped.startColumn?.label ?? 'Start'),
      value: boundText(task.startMs, shaped.startColumn),
      color: 'var(--rcd-muted)',
    });
    entries.push({
      name: rename(shaped.endColumn?.label ?? 'End'),
      value: boundText(task.endMs, shaped.endColumn),
      color: 'var(--rcd-muted)',
    });
    entries.push({
      name: 'Duration',
      value: humanizeDurationMs(task.endMs - task.startMs),
      color: 'var(--rcd-muted)',
    });
    if (task.progress !== null) {
      entries.push({
        name: rename(shaped.progressColumn?.label ?? 'Progress'),
        value: `${Math.round(task.progress * 100)}%`,
        color: colorOf(task),
      });
    }
  }
  return (
    <RcdChartTooltip
      active={active === true && task !== undefined}
      payload={entries}
      label={label}
      coordinate={coordinate}
      styleSpec={spec.format.tooltip}
      formatEntry={(value) => (value == null ? '' : String(value))}
      marks="bars"
    />
  );
}

/**
 * Fully customizable gantt: rows = tasks, x = a real time axis with clean
 * date ticks, bars = recharts RANGED Bars ([startMs, endMs] value arrays on a
 * numeric axis in vertical layout) with a custom shape for rounded corners,
 * progress fill and on-bar labels. Recharts was chosen over a hand-rolled SVG
 * layer because ranged bars compose cleanly with everything the chart frame
 * already provides — axes/grid/ResponsiveContainer, the shared tooltip system,
 * ReferenceLine (today), per-bar mouse events, legend plumbing — leaving only
 * the bar SHAPE custom, which recharts explicitly supports.
 */
export function GanttChart({
  spec,
  result,
  legend,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  onPointHover,
  activeCategory = null,
  highlightCategory = null,
  selection = null,
}: GanttChartProps) {
  const format = spec.format;
  const opts: GanttOptions = format.gantt ?? {};
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const shaped = useMemo(() => shapeGanttData(result, spec), [result, spec]);
  const hasGroup = shaped.groups.length > 0;

  // ---- colors --------------------------------------------------------------
  const groupColor = new Map(shaped.groups.map((g) => [g.label, g.color]));
  const monochrome = opts.singleColor === true || !hasGroup;
  const baseColor =
    opts.color ??
    seriesColor(0, shaped.startColumn?.label ?? 'Tasks', format.colorOverrides, format.theme);
  const colorOf = (task: GanttTask): string =>
    monochrome ? baseColor : (groupColor.get(task.group ?? '') ?? baseColor);

  // ---- legend (groups) -----------------------------------------------------
  const legendItems: LegendItemDatum[] = shaped.groups.map((g) => ({
    key: g.label,
    label: format.seriesLabels?.[g.label] ?? g.label,
    color: monochrome ? baseColor : g.color,
    raw: g.raw,
    legendLabel: g.label,
  }));
  // STABLE LEGEND (same doctrine as pie/cartesian/scatter): a grouped gantt
  // legends itself whenever any group survives — `> 1` would delete the
  // legend (and the only label the surviving group has) the moment a
  // cross-filter leaves one group standing. Explicit showLegend still wins.
  const showLegend = hasGroup && (format.showLegend ?? true);
  const hidden = legend.hidden;
  const tasks = hasGroup
    ? shaped.tasks.filter((t) => !hidden.has(t.group ?? ''))
    : shaped.tasks;

  if (!shaped.startColumn || !shaped.endColumn) {
    return <Placeholder>Gantt needs Start and End date fields.</Placeholder>;
  }
  if (tasks.length === 0) {
    return (
      <Placeholder>
        {shaped.skipped > 0
          ? `No tasks to draw — ${shaped.skipped} row${shaped.skipped === 1 ? '' : 's'} have no start or end date.`
          : 'No data.'}
      </Placeholder>
    );
  }

  // ---- rows + time domain --------------------------------------------------
  const rows: GanttRow[] = tasks.map((task) => ({
    [AXIS_KEY]: task.label,
    [RAW_AXIS_KEY]: task.raw,
    [RANGE_KEY]: [task.startMs, task.endMs],
    [TASK_KEY]: task,
  }));
  const todayMs = Date.now();
  const showToday = opts.showToday === true;
  let minMs = Math.min(...tasks.map((t) => t.startMs));
  let maxMs = Math.max(...tasks.map((t) => t.endMs));
  if (showToday) {
    // The marker is a fixed line, so the domain must reach it — predictable
    // "where is today relative to the plan" reading.
    minMs = Math.min(minMs, todayMs);
    maxMs = Math.max(maxMs, todayMs);
  }
  const pad = Math.max((maxMs - minMs) * 0.03, maxMs === minMs ? DAY : MINUTE);
  const domainMin = minMs - pad;
  const domainMax = maxMs + pad;
  const { ticks, mask } = pickTickPlan(domainMin, domainMax);

  const tickLabel = (ms: number): string => {
    const date = new Date(ms);
    if (format.dateFormatPattern) {
      const custom = formatDatePattern(date, format.dateFormatPattern);
      if (custom !== '') return custom;
    }
    if (format.dateFormat && format.dateFormat !== 'auto') {
      return formatDateLabel(date.toISOString(), shaped.startColumn!, format.dateFormat);
    }
    return formatDatePattern(date, mask);
  };

  // ---- selection / highlight -----------------------------------------------
  const selHasCategories = (selection?.categories?.length ?? 0) > 0;
  const selectionOn =
    format.selectionHighlight !== false &&
    selection != null &&
    (selection.category != null || selection.legendValue != null || selHasCategories);
  const taskSelected = (task: GanttTask): boolean =>
    selectionOn &&
    (selection?.category == null && !selHasCategories
      ? true
      : selectionCategoryMatches(selection!, task.label, task.raw)) &&
    (selection?.legendValue == null ||
      selectionFacetMatches(selection.legendValue, task.group ?? undefined, task.groupRaw));
  // Hover echo: a label matching a TASK dims the other rows; otherwise a
  // label matching a GROUP dims the other groups (same rule the cartesians
  // apply to categories vs series).
  const highlightTaskMode =
    highlightCategory !== null && tasks.some((t) => t.label === highlightCategory.label);
  const highlightGroupMode =
    highlightCategory !== null &&
    !highlightTaskMode &&
    shaped.groups.some((g) => g.label === highlightCategory.label);
  const taskOpacity = (task: GanttTask): number | undefined => {
    if (selectionOn) return taskSelected(task) ? 1 : DIM_OPACITY;
    if (highlightTaskMode && highlightCategory && task.label !== highlightCategory.label) {
      return DIM_OPACITY;
    }
    if (highlightGroupMode && highlightCategory && task.group !== highlightCategory.label) {
      return DIM_OPACITY;
    }
    if (activeCategory && task.label !== activeCategory.label) return DIM_OPACITY;
    return undefined;
  };

  // ---- events (standard point-event contract) ------------------------------
  const pointEvent = (
    task: GanttTask,
    e: { clientX: number; clientY: number },
  ): ChartPointEvent => ({
    axisValue: task.raw,
    axisLabel: task.label,
    legendValue: hasGroup ? task.groupRaw : undefined,
    legendLabel: hasGroup ? (task.group ?? undefined) : undefined,
    clientX: e.clientX,
    clientY: e.clientY,
  });
  const handleBarClick =
    onDatumClick || onPointClick
      ? (_: unknown, index: number, event: ReactMouseEvent) => {
          const task = tasks[index];
          if (!task) return;
          onDatumClick?.({ value: task.raw, label: task.label });
          onPointClick?.(pointEvent(task, event));
        }
      : undefined;
  const handleBarContextMenu = onPointContextMenu
    ? (_: unknown, index: number, event: ReactMouseEvent) => {
        const task = tasks[index];
        if (!task) return;
        event.preventDefault();
        onPointContextMenu(pointEvent(task, event));
      }
    : undefined;
  const handleBarHover = onPointHover
    ? (_: unknown, index: number, event: ReactMouseEvent) => {
        const task = tasks[index];
        if (task) onPointHover(pointEvent(task, event));
      }
    : undefined;

  // ---- bar rendering -------------------------------------------------------
  const cornerRadius = opts.cornerRadius ?? 3;
  const taskLabels = opts.taskLabels ?? 'axis';
  const showProgress = opts.showProgress !== false && shaped.progressColumn !== null;

  /** Custom ranged-bar shape: rounded rect + progress fill + on-bar label. */
  const renderBar = (raw: unknown): ReactElement => {
    const geom = raw as BarShapeGeom;
    const index = geom.index ?? -1;
    const task = tasks[index];
    if (!task || geom.x === undefined || geom.y === undefined || geom.height === undefined) {
      return <g />;
    }
    const width = Math.max(geom.width ?? 0, MIN_BAR_PX);
    const height = geom.height;
    const r = Math.max(0, Math.min(cornerRadius, height / 2, width / 2));
    const selected = taskSelected(task);
    const opacity = taskOpacity(task);
    const clipId = `rcdg-${uid}-${index}`;
    const progressWidth = task.progress !== null ? width * task.progress : 0;
    const midY = geom.y + height / 2;
    return (
      <g>
        {showProgress && task.progress !== null && (
          <clipPath id={clipId}>
            <rect x={geom.x} y={geom.y} width={width} height={height} rx={r} ry={r} />
          </clipPath>
        )}
        <rect
          x={geom.x}
          y={geom.y}
          width={width}
          height={height}
          rx={r}
          ry={r}
          fill={colorOf(task)}
          fillOpacity={opacity}
          stroke={selected ? SELECTION_STROKE : undefined}
          strokeWidth={selected ? 1.5 : undefined}
        />
        {showProgress && task.progress !== null && (
          // Completion fill: a text-token overlay at low alpha darkens the
          // bar's own color in light theme and lightens it in dark theme, so
          // the fill reads in both without a second palette.
          <rect
            x={geom.x}
            y={geom.y}
            width={progressWidth}
            height={height}
            fill="var(--rcd-text)"
            fillOpacity={(opacity ?? 1) * 0.3}
            clipPath={`url(#${clipId})`}
            pointerEvents="none"
          />
        )}
        {taskLabels === 'inside' && width >= INSIDE_LABEL_MIN_PX && height >= 10 && (
          <text
            x={geom.x + 6}
            y={midY}
            dominantBaseline="central"
            fontSize={10}
            fill="#ffffff"
            fillOpacity={(opacity ?? 1) * 0.95}
            pointerEvents="none"
          >
            {task.label}
          </text>
        )}
        {taskLabels === 'adjacent' && height >= 10 && (
          <text
            x={geom.x + width + 6}
            y={midY}
            dominantBaseline="central"
            fontSize={10}
            fill="var(--rcd-text-2)"
            fillOpacity={opacity}
            pointerEvents="none"
          >
            {task.label}
          </text>
        )}
      </g>
    );
  };

  /** Zebra banding: recharts Bar `background` spans the full row band. */
  const renderBand = (raw: unknown): ReactElement => {
    const geom = raw as BarShapeGeom;
    if (
      (geom.index ?? 0) % 2 === 0 ||
      geom.x === undefined ||
      geom.y === undefined ||
      geom.width === undefined ||
      geom.height === undefined
    ) {
      return <g />;
    }
    // Pad the band a hair past the bar so adjacent rows read as stripes even
    // with a chunky barSize (the background rect recharts hands us is the
    // bar-height slot, not the full category band).
    const padY = Math.min(4, geom.height * 0.2);
    return (
      <rect
        x={geom.x}
        y={geom.y - padY}
        width={geom.width}
        height={geom.height + padY * 2}
        fill="var(--rcd-text)"
        fillOpacity={0.035}
        pointerEvents="none"
      />
    );
  };

  return (
    <div className="relative h-full w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" debounce={60}>
        <ComposedChart
          data={rows}
          layout="vertical"
          margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
          barCategoryGap="25%"
          onMouseLeave={onPointHover ? () => onPointHover(null) : undefined}
        >
          {/* Time gridlines (from the value/x axis) on, row rules off — the
              same value-axis-only default the horizontal bar charts use. */}
          <CartesianGrid
            vertical={format.gridX ?? true}
            horizontal={format.gridY ?? false}
            stroke={GRID_STROKE}
          />
          <XAxis
            type="number"
            domain={[domainMin, domainMax]}
            ticks={ticks}
            tick={axisTickStyle}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(value: unknown) =>
              typeof value === 'number' ? tickLabel(value) : String(value)
            }
          />
          <YAxis
            type="category"
            dataKey={AXIS_KEY}
            width={taskLabels === 'axis' ? TASK_AXIS_WIDTH : 8}
            tick={taskLabels === 'axis' ? axisTickStyle : false}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          {format.tooltip?.enabled === false ? null : (
            <Tooltip
              cursor={{ fill: 'var(--rcd-text)', fillOpacity: 0.04 }}
              isAnimationActive={false}
              position={TIP_ORIGIN}
              offset={0}
              content={<GanttTooltipContent spec={spec} shaped={shaped} colorOf={colorOf} />}
            />
          )}
          {showLegend && chartLegend(format, legendItems, legend)}
          <Bar
            dataKey={RANGE_KEY}
            isAnimationActive={false}
            shape={renderBar}
            activeBar={false}
            {...(opts.barSize !== undefined ? { barSize: opts.barSize } : null)}
            background={opts.rowBanding === true ? renderBand : undefined}
            cursor={handleBarClick ? 'pointer' : undefined}
            onClick={handleBarClick}
            onContextMenu={handleBarContextMenu}
            onMouseEnter={handleBarHover}
          />
          {showToday && (
            <ReferenceLine
              x={todayMs}
              stroke={opts.todayColor ?? '#ef4444'}
              strokeDasharray="4 3"
              label={{
                value: 'Today',
                position: 'insideTop',
                fill: opts.todayColor ?? '#ef4444',
                fontSize: 10,
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      {shaped.skipped > 0 && (
        <div className="pointer-events-none absolute right-2 top-1 rounded border border-rcd-border bg-rcd-surface px-1.5 py-0.5 text-[10px] text-rcd-muted">
          {shaped.skipped} row{shaped.skipped === 1 ? '' : 's'} without dates
        </div>
      )}
    </div>
  );
}
