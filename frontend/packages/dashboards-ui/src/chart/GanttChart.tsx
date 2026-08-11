import { useId, useMemo, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
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
import { truncateToWidth } from './axisFit';
import { RAW_AXIS_KEY, shapeGanttData, type GanttTask, type ShapedGanttData } from './chartData';
import {
  DAY,
  HOUR,
  MINUTE,
  MONTH,
  WEEK,
  YEAR,
  onBarTextColor,
  shortDurationText,
  sortGanttTasks,
  weekendBands,
} from './ganttUtils';
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
  { approx: MONTH, mask: 'MMM yyyy', ticks: monthTicks(1) },
  { approx: 3 * MONTH, mask: '"Q"Qq yyyy', ticks: monthTicks(3) },
  { approx: 6 * MONTH, mask: 'MMM yyyy', ticks: monthTicks(6) },
  ...[1, 2, 5, 10, 20, 50, 100].map((n) => ({
    approx: n * YEAR,
    mask: 'yyyy',
    ticks: monthTicks(n * 12),
  })),
];

/** Explicit tick units (format.gantt.axisTicks) for when 'auto' picks poorly. */
const FORCED_TICKS: Record<string, TickCandidate> = {
  weekly: { approx: WEEK, mask: 'd MMM', ticks: epochTicks(WEEK) },
  monthly: { approx: MONTH, mask: 'MMM yyyy', ticks: monthTicks(1) },
  quarterly: { approx: 3 * MONTH, mask: '"Q"Qq yyyy', ticks: monthTicks(3) },
  yearly: { approx: YEAR, mask: 'yyyy', ticks: monthTicks(12) },
};

/** A forced unit that would draw more ticks than this falls back to 'auto'. */
const FORCED_TICK_CEILING = 60;

/** The chosen plan: the tick values, their label mask and the step they walk. */
interface TickPlan {
  ticks: number[];
  mask: string;
  /** Approximate step width ms — weekend shading only applies below month scale. */
  step: number;
}

/** Smallest candidate step that keeps the tick count at or under the target. */
const pickTickPlan = (
  min: number,
  max: number,
  forced?: GanttOptions['axisTicks'],
): TickPlan => {
  const explicit = forced && forced !== 'auto' ? FORCED_TICKS[forced] : undefined;
  if (explicit) {
    const ticks = explicit.ticks(min, max);
    // A forced unit only wins while it stays legible; an unreadable wall of
    // ticks (or a unit coarser than the whole span) falls back to auto.
    if (ticks.length >= 2 && ticks.length <= FORCED_TICK_CEILING) {
      return { ticks, mask: explicit.mask, step: explicit.approx };
    }
  }
  const span = Math.max(1, max - min);
  for (const candidate of TICK_CANDIDATES) {
    if (span / candidate.approx <= TICK_TARGET) {
      const ticks = candidate.ticks(min, max);
      if (ticks.length >= 2) return { ticks, mask: candidate.mask, step: candidate.approx };
    }
  }
  // Degenerate span (or a pathological range): just label the two ends.
  return { ticks: [min, max], mask: 'd MMM yyyy', step: span };
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

/** On-bar label metrics: 10px sans is ~5.6px/char; 6px of padding each side. */
const LABEL_CHAR_PX = 5.6;
const LABEL_PAD_PX = 6;
const textWidthPx = (text: string): number => text.length * LABEL_CHAR_PX;

/** Weekend shading is a day-scale affordance; month+ ticks skip it silently. */
const WEEKEND_SHADE_MAX_STEP = 20 * DAY;

/** Lane mode forces every category tick up to this many rows (see below). */
const LANE_TICK_LIMIT = 40;

/** Invisible axis-label suffix used to keep lane-mode category keys unique. */
const ZERO_WIDTH = String.fromCharCode(0x200b);
const ZERO_WIDTH_SUFFIX = new RegExp(`${ZERO_WIDTH}+$`);

/**
 * Text budget for a lane-mode tick: the rail minus the tick margin, the left
 * chart margin and the task indent. Recharts' own <Text> tick wraps to the
 * axis width; LaneTick draws a single <text>, so it must ellipsize instead or
 * a long name would run off the left edge of the SVG and be cut mid-glyph.
 */
const LANE_TICK_MAX_PX = TASK_AXIS_WIDTH - 18;

const axisTickStyle = { fontSize: 11, fill: 'var(--rcd-muted)' } as const;

/** One plotted row: category label + raw + the [start, end] range + its task. */
type GanttRow = Record<string, CellValue | [number, number] | GanttTask>;

/**
 * A group header lane (groupLanes mode): the slim summary row that opens each
 * cluster. It occupies a real category row so recharts lays it out with the
 * tasks, but carries no task — clicks/tooltips/cross-filter ignore it.
 */
interface GanttLaneHeader {
  label: string;
  color: string;
  count: number;
  startMs: number;
  endMs: number;
}

/** One plotted category row: either a task or (lane mode) a group header. */
interface GanttLane {
  task: GanttTask | null;
  header: GanttLaneHeader | null;
}

/**
 * Lane-mode category tick: group names read as headers, task names sit
 * indented under them. Passed to YAxis as an ELEMENT (`tick={<LaneTick …/>}`)
 * — recharts 3 clones it with x/y/payload; a bare render FUNCTION silently
 * produces empty tick groups.
 */
function LaneTick({
  x = 0,
  y = 0,
  payload,
  lanes = [],
}: {
  x?: number;
  y?: number;
  payload?: { value?: string; index?: number };
  lanes?: GanttLane[];
}): ReactElement {
  const header = lanes[payload?.index ?? -1]?.header ?? null;
  // The de-dup suffix is invisible but still measures — strip it before
  // fitting the name to the rail.
  const value = String(payload?.value ?? '').replace(ZERO_WIDTH_SUFFIX, '');
  const text = truncateToWidth(value, LANE_TICK_MAX_PX);
  return (
    <text
      x={x - (header ? 0 : 4)}
      y={y}
      textAnchor="end"
      dominantBaseline="central"
      fontSize={11}
      fontWeight={header ? 600 : undefined}
      fill={header ? 'var(--rcd-text-2)' : 'var(--rcd-muted)'}
    >
      {text !== value && <title>{value}</title>}
      {text}
    </text>
  );
}

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
  // Per-GROUP colors need no special plumbing here: shapeGanttData already
  // resolves each group's color through seriesColor(index, groupLabel,
  // format.colorOverrides, theme) — the very keys the Series > Colors swatches
  // write — so a swatch override lands on the bars, the legend and the tooltip
  // at once.
  const colorOf = (task: GanttTask): string =>
    monochrome ? baseColor : (groupColor.get(task.group ?? '') ?? baseColor);
  /** Bar fill for a task: milestones may carry their own color. */
  const fillOf = (task: GanttTask): string =>
    task.startMs === task.endMs && opts.milestoneColor != null
      ? opts.milestoneColor
      : colorOf(task);

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
  const visible = hasGroup
    ? shaped.tasks.filter((t) => !hidden.has(t.group ?? ''))
    : shaped.tasks;

  // ---- row order -----------------------------------------------------------
  // PRECEDENCE: an explicit query.sort always wins — shapeGanttData leaves the
  // engine's row order untouched in that case, and so do we. Otherwise the
  // gantt's own sortBy applies; its default (undefined) is exactly the
  // start-ascending order shapeGanttData already produced.
  const querySorted = (spec.query.sort?.length ?? 0) > 0;
  const tasks = querySorted ? visible : sortGanttTasks(visible, opts.sortBy, opts.sortDirection);

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

  // ---- lanes (plotted rows) ------------------------------------------------
  // Default: one lane per task, in task order. groupLanes clusters the tasks
  // under their group and opens each cluster with a slim HEADER lane (a lane
  // with no task): recharts lays it out as a normal category row, but it
  // carries no datum, so hover/click/cross-filter simply skip it and every
  // per-task semantic below is untouched.
  const groupLanes = opts.groupLanes === true && hasGroup;
  const lanes: GanttLane[] = [];
  if (groupLanes) {
    const placed = new Set<GanttTask>();
    for (const group of shaped.groups) {
      const members = tasks.filter((task) => task.group === group.label);
      if (members.length === 0) continue; // legend-hidden or filtered away
      lanes.push({
        task: null,
        header: {
          label: group.label,
          color: monochrome ? baseColor : group.color,
          count: members.length,
          startMs: Math.min(...members.map((m) => m.startMs)),
          endMs: Math.max(...members.map((m) => m.endMs)),
        },
      });
      for (const task of members) {
        placed.add(task);
        lanes.push({ task, header: null });
      }
    }
    // Defensive: a task whose group never registered still gets a lane.
    for (const task of tasks) if (!placed.has(task)) lanes.push({ task, header: null });
  } else {
    for (const task of tasks) lanes.push({ task, header: null });
  }

  // ---- rows + time domain --------------------------------------------------
  // Recharts identifies category rows by their axis VALUE, so lane mode (which
  // adds header rows and can repeat a task name across groups) de-duplicates
  // with trailing zero-width spaces — invisible in the tick rail and tooltip.
  const usedAxisLabels = new Set<string>();
  const rows: GanttRow[] = lanes.map(({ task, header }) => {
    let axisLabel = header ? header.label : task!.label;
    if (groupLanes) {
      while (usedAxisLabels.has(axisLabel)) axisLabel += ZERO_WIDTH;
      usedAxisLabels.add(axisLabel);
    }
    return {
      [AXIS_KEY]: axisLabel,
      [RAW_AXIS_KEY]: task ? task.raw : null,
      [RANGE_KEY]: header ? [header.startMs, header.endMs] : [task!.startMs, task!.endMs],
      ...(task ? { [TASK_KEY]: task } : null),
    };
  });
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
  const { ticks, mask, step } = pickTickPlan(domainMin, domainMax, opts.axisTicks);

  // Weekend bands read as "non-working time" only while the axis is at day
  // scale; at month+ steps a Sat/Sun stripe is sub-pixel noise, so it is
  // skipped silently (no error, no empty nodes) instead of being drawn badly.
  const weekends =
    opts.shadeWeekends === true && step <= WEEKEND_SHADE_MAX_STEP
      ? weekendBands(domainMin, domainMax)
      : [];

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
  // Lane-indexed lookup: recharts hands us the ROW index, and in lane mode a
  // row may be a group header (task null) — those simply do nothing.
  const taskAt = (index: number): GanttTask | null => lanes[index]?.task ?? null;
  const handleBarClick =
    onDatumClick || onPointClick
      ? (_: unknown, index: number, event: ReactMouseEvent) => {
          const task = taskAt(index);
          if (!task) return;
          onDatumClick?.({ value: task.raw, label: task.label });
          onPointClick?.(pointEvent(task, event));
        }
      : undefined;
  const handleBarContextMenu = onPointContextMenu
    ? (_: unknown, index: number, event: ReactMouseEvent) => {
        const task = taskAt(index);
        if (!task) return;
        event.preventDefault();
        onPointContextMenu(pointEvent(task, event));
      }
    : undefined;
  const handleBarHover = onPointHover
    ? (_: unknown, index: number, event: ReactMouseEvent) => {
        const task = taskAt(index);
        if (task) onPointHover(pointEvent(task, event));
      }
    : undefined;

  // ---- bar rendering -------------------------------------------------------
  const cornerRadius = opts.cornerRadius ?? 3;
  const taskLabels = opts.taskLabels ?? 'axis';
  const showProgress = opts.showProgress !== false && shaped.progressColumn !== null;
  const durationLabels = opts.durationLabels ?? 'off';
  const diamondMilestones = opts.milestoneShape === 'diamond';
  const barOpacity =
    typeof opts.barOpacity === 'number' ? Math.min(1, Math.max(0, opts.barOpacity)) : null;
  /**
   * Folds the author's bar opacity into the dim/selection opacity. With no
   * barOpacity set this is the identity — including passing `undefined`
   * straight through, so the default markup keeps recharts' own default.
   */
  const fillAlpha = (opacity: number | undefined): number | undefined =>
    barOpacity === null ? opacity : (opacity ?? 1) * barOpacity;

  /** Zebra parity per lane: group headers never band, tasks alternate. */
  const bandParity: boolean[] = [];
  {
    let taskOrdinal = 0;
    for (const lane of lanes) {
      if (lane.header) {
        bandParity.push(false);
        continue;
      }
      bandParity.push(taskOrdinal % 2 === 1);
      taskOrdinal += 1;
    }
  }

  // Recharts thins category ticks when they would collide, which would drop
  // group names from the rail. Up to a sane row count lane mode forces every
  // tick (interval 0); past it the thinning wins and the header CAPTION takes
  // the name over instead, so a group is never left unlabeled.
  const laneTicksComplete = groupLanes && lanes.length <= LANE_TICK_LIMIT;
  const nameInRail = groupLanes && taskLabels === 'axis' && laneTicksComplete;

  /** The slim summary row that opens a cluster in groupLanes mode. */
  const renderHeaderLane = (header: GanttLaneHeader, geom: BarShapeGeom): ReactElement => {
    const x = geom.x ?? 0;
    const y = geom.y ?? 0;
    const height = geom.height ?? 0;
    const width = Math.max(geom.width ?? 0, MIN_BAR_PX);
    const midY = y + height / 2;
    const capsule = Math.min(5, Math.max(2, height * 0.22));
    const span = shortDurationText(header.endMs - header.startMs);
    const count = `${header.count} task${header.count === 1 ? '' : 's'}`;
    // The tick rail already carries the group NAME when task labels sit on the
    // axis; anywhere else the header caption has to carry it itself.
    const caption = nameInRail ? `${count} · ${span}` : `${header.label} · ${count} · ${span}`;
    const captionAbove = height >= 14;
    return (
      <g pointerEvents="none">
        <rect
          x={x}
          y={midY - capsule / 2}
          width={width}
          height={capsule}
          rx={capsule / 2}
          ry={capsule / 2}
          fill={header.color}
          fillOpacity={0.6}
        />
        <text
          x={captionAbove ? x : x + width + LABEL_PAD_PX}
          y={captionAbove ? midY - capsule / 2 - 4 : midY}
          dominantBaseline={captionAbove ? 'auto' : 'central'}
          fontSize={10}
          fontWeight={600}
          fill="var(--rcd-muted)"
        >
          {caption}
        </text>
      </g>
    );
  };

  /** Custom ranged-bar shape: bar/diamond body + progress fill + on-bar labels. */
  const renderBar = (raw: unknown): ReactElement => {
    const geom = raw as BarShapeGeom;
    const index = geom.index ?? -1;
    const lane = lanes[index];
    if (!lane || geom.x === undefined || geom.y === undefined || geom.height === undefined) {
      return <g />;
    }
    if (lane.header) return renderHeaderLane(lane.header, geom);
    const task = lane.task!;
    const width = Math.max(geom.width ?? 0, MIN_BAR_PX);
    const height = geom.height;
    const r = Math.max(0, Math.min(cornerRadius, height / 2, width / 2));
    const selected = taskSelected(task);
    const opacity = taskOpacity(task);
    const clipId = `rcdg-${uid}-${index}`;
    const progressWidth = task.progress !== null ? width * task.progress : 0;
    const midY = geom.y + height / 2;
    const fill = fillOf(task);
    // Zero-duration tasks are milestones. As diamonds they get a real marker
    // centered on the instant instead of a 2px sliver; the body then has no
    // usable inside width, so inside labels fall away on their own.
    const milestone = diamondMilestones && task.startMs === task.endMs;
    const half = Math.max(3, Math.min(height / 2, 7));
    const centerX = geom.x + width / 2;
    const bodyRight = milestone ? centerX + half : geom.x + width;
    const bodyWidth = milestone ? 0 : width;

    const durationText =
      durationLabels === 'off' ? '' : shortDurationText(task.endMs - task.startMs);
    const insideTaskWidth =
      taskLabels === 'inside' ? textWidthPx(task.label) + LABEL_PAD_PX * 2 : 0;
    const insideDuration =
      durationLabels === 'inside' &&
      height >= 10 &&
      bodyWidth >= textWidthPx(durationText) + LABEL_PAD_PX * 2 + insideTaskWidth;
    const adjacentDuration = durationLabels === 'adjacent' && height >= 10;
    // An 'adjacent' duration queues up after an 'adjacent' task label so the
    // two never collide (widths estimated from the 10px label metric).
    const adjacentDurationX =
      bodyRight +
      LABEL_PAD_PX +
      (taskLabels === 'adjacent' ? textWidthPx(task.label) + LABEL_PAD_PX : 0);
    const insideInk = opts.labelColor ?? onBarTextColor(fill);
    const adjacentInk = opts.labelColor ?? 'var(--rcd-text-2)';

    return (
      <g>
        {showProgress && task.progress !== null && !milestone && (
          <clipPath id={clipId}>
            <rect x={geom.x} y={geom.y} width={width} height={height} rx={r} ry={r} />
          </clipPath>
        )}
        {milestone ? (
          <polygon
            points={`${centerX},${midY - half} ${centerX + half},${midY} ${centerX},${midY + half} ${centerX - half},${midY}`}
            fill={fill}
            fillOpacity={fillAlpha(opacity)}
            stroke={selected ? SELECTION_STROKE : undefined}
            strokeWidth={selected ? 1.5 : undefined}
          />
        ) : (
          <rect
            x={geom.x}
            y={geom.y}
            width={width}
            height={height}
            rx={r}
            ry={r}
            fill={fill}
            fillOpacity={fillAlpha(opacity)}
            stroke={selected ? SELECTION_STROKE : undefined}
            strokeWidth={selected ? 1.5 : undefined}
          />
        )}
        {showProgress && task.progress !== null && !milestone && (
          // Completion fill: by default a text-token overlay at low alpha,
          // which darkens the bar's own color in light theme and lightens it
          // in dark, so the fill reads in both without a second palette. An
          // explicit progressColor paints that color at full strength instead.
          <rect
            x={geom.x}
            y={geom.y}
            width={progressWidth}
            height={height}
            fill={opts.progressColor ?? 'var(--rcd-text)'}
            fillOpacity={
              opts.progressColor != null
                ? (fillAlpha(opacity) ?? 1)
                : (fillAlpha(opacity) ?? 1) * 0.3
            }
            clipPath={`url(#${clipId})`}
            pointerEvents="none"
          />
        )}
        {taskLabels === 'inside' && bodyWidth >= INSIDE_LABEL_MIN_PX && height >= 10 && (
          <text
            x={geom.x + LABEL_PAD_PX}
            y={midY}
            dominantBaseline="central"
            fontSize={10}
            fill={insideInk}
            fillOpacity={(opacity ?? 1) * 0.95}
            pointerEvents="none"
          >
            {task.label}
          </text>
        )}
        {taskLabels === 'adjacent' && height >= 10 && (
          <text
            x={bodyRight + LABEL_PAD_PX}
            y={midY}
            dominantBaseline="central"
            fontSize={10}
            fill={adjacentInk}
            fillOpacity={opacity}
            pointerEvents="none"
          >
            {task.label}
          </text>
        )}
        {insideDuration && (
          // Right-aligned inside the bar: leaves the left edge to the task
          // label when both are 'inside'.
          <text
            x={geom.x + width - LABEL_PAD_PX}
            y={midY}
            textAnchor="end"
            dominantBaseline="central"
            fontSize={10}
            fill={insideInk}
            fillOpacity={(opacity ?? 1) * 0.85}
            pointerEvents="none"
          >
            {durationText}
          </text>
        )}
        {adjacentDuration && (
          <text
            x={adjacentDurationX}
            y={midY}
            dominantBaseline="central"
            fontSize={10}
            fill={opts.labelColor ?? 'var(--rcd-muted)'}
            fillOpacity={opacity}
            pointerEvents="none"
          >
            {durationText}
          </text>
        )}
      </g>
    );
  };

  /** Zebra banding: recharts Bar `background` spans the full row band. */
  const renderBand = (raw: unknown): ReactElement => {
    const geom = raw as BarShapeGeom;
    if (
      !bandParity[geom.index ?? 0] ||
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
        fill={opts.bandingColor ?? 'var(--rcd-text)'}
        fillOpacity={opts.bandingColor != null ? 0.25 : 0.035}
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
          barCategoryGap={groupLanes ? '14%' : '25%'}
          onMouseLeave={onPointHover ? () => onPointHover(null) : undefined}
        >
          {/* Time gridlines (from the value/x axis) on, row rules off — the
              orientation-aware default the horizontal bar charts use
              (vertical = gridX ?? true, horizontal = gridY ?? false), so
              format.gridX / format.gridY drive the gantt like any cartesian. */}
          <CartesianGrid
            vertical={format.gridX ?? true}
            horizontal={format.gridY ?? false}
            stroke={GRID_STROKE}
          />
          {/* Non-working time, Sat/Sun merged into one band per weekend.
              Recharts 3 layers by z-index, not DOM order: ReferenceArea sits
              at 100, under the bars (300) and over the grid (-100) and the
              row banding (-50), which is exactly the stacking we want. */}
          {weekends.map(([from, to]) => (
            <ReferenceArea
              key={from}
              x1={from}
              x2={to}
              fill={opts.shadeColor ?? 'var(--rcd-text)'}
              fillOpacity={opts.shadeColor != null ? 0.16 : 0.05}
              stroke="none"
              ifOverflow="hidden"
            />
          ))}
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
            tick={
              taskLabels === 'axis'
                ? groupLanes
                  ? <LaneTick lanes={lanes} />
                  : axisTickStyle
                : false
            }
            {...(laneTicksComplete ? { interval: 0 } : null)}
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
              label={
                opts.todayLabel === false
                  ? undefined
                  : {
                      value: 'Today',
                      position: 'insideTop',
                      fill: opts.todayColor ?? '#ef4444',
                      fontSize: 10,
                    }
              }
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
