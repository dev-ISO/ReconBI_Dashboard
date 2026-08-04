import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatAxisValue,
  formatCellValue,
  seriesColor,
  type AxisValueFormat,
  type CellValue,
  type ChartFormat,
  type ChartSpec,
  type QueryColumn,
  type QueryResult,
  type SeriesLineStyle,
  type TextStyle,
  type TooltipStyle,
} from '@recon/dashboards-core';
import { RAW_AXIS_KEY, shapeChartData, shapePieData, shapeScatterData } from './chartData';
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
   * Set on the SOURCE chart while its cross-filter is active: categories whose
   * formatted label differs render at fillOpacity 0.35. Implemented for
   * single-series column/bar (the Cell path) and pie/donut; multi-series and
   * stacked charts skip dimming (a category there spans several marks).
   */
  activeCategory?: { label: string } | null;
}

const axisTickStyle = { fontSize: 11, fill: 'var(--rcd-text-2)' } as const;

const legendWrapperStyle = { fontSize: 12, color: 'var(--rcd-text-2)' } as const;

/** Debounce (ms) for ResponsiveContainer re-measures during grid/tile resizes. */
const RESIZE_DEBOUNCE = 60;

const TABLE_ROW_CAP = 500;

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
    const column =
      overrideColumn ??
      (seriesKey ? measureColumns.find((c) => c.name === seriesKey) : undefined) ??
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
      wrapperStyle,
    } as const;
  }
  return {
    verticalAlign: format.legendPosition === 'top' ? 'top' : 'bottom',
    wrapperStyle,
  } as const;
}

/** One legend entry: dataKey (toggle identity), display label, swatch color. */
interface LegendItemDatum {
  key: string;
  label: string;
  color: string;
}

/**
 * Power BI-style clickable legend, rendered as recharts Legend `content` so it
 * inherits placement + wrapperStyle (fontSize/color cascade to the buttons via
 * the preflight `color: inherit`). Items come from OUR series list — never the
 * recharts payload, which omits series we filtered out — so hidden entries stay
 * visible (dimmed + struck-through) and can be toggled back.
 */
function InteractiveLegendContent({
  items,
  hidden,
  onToggle,
  layout,
}: {
  items: LegendItemDatum[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  layout: 'horizontal' | 'vertical';
}) {
  return (
    <ul
      className={
        layout === 'vertical'
          ? 'flex flex-col items-start gap-1 pl-2'
          : 'flex flex-wrap items-center justify-center gap-x-3 gap-y-1'
      }
    >
      {items.map((item, i) => {
        const isHidden = hidden.has(item.key);
        return (
          <li key={`${i}-${item.key}`} className="min-w-0 max-w-full">
            <button
              type="button"
              onClick={() => onToggle(item.key)}
              title={isHidden ? `Show ${item.label}` : `Hide ${item.label}`}
              className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5"
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ background: item.color, opacity: isHidden ? 0.35 : 1 }}
              />
              <span className={`truncate ${isHidden ? 'line-through opacity-45' : ''}`}>
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
 * Legend element for one chart: interactive (click toggles series visibility)
 * unless format.legendInteractive === false, which falls back to the plain
 * recharts legend. Placement/text style (legendPosition/legendStyle) apply to
 * both variants.
 */
function chartLegend(
  format: ChartFormat,
  items: LegendItemDatum[],
  hidden: ReadonlySet<string>,
  onToggle: (key: string) => void,
): ReactNode {
  const placement = legendProps(format);
  if (format.legendInteractive === false) return <Legend {...placement} />;
  return (
    <Legend
      {...placement}
      content={
        <InteractiveLegendContent
          items={items}
          hidden={hidden}
          onToggle={onToggle}
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

/** Base margins, widened when an axis title needs room. */
const chartMargin = (format: ChartFormat, extras?: { bottom?: boolean; left?: boolean }) => ({
  top: 8,
  right: 12,
  bottom: format.xAxisLabel || extras?.bottom ? 18 : 4,
  left: format.yAxisLabel || extras?.left ? 8 : 4,
});

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
      className="max-w-[280px] rounded-lg border border-rcd-border px-2.5 py-2 text-xs shadow-md"
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

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-rcd-muted">
      {children}
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
  activeCategory = null,
}: ChartRendererProps) {
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(NO_HIDDEN);
  const format = spec.format;
  // When the legend is non-interactive every series renders, even if hidden
  // state lingers from before the flag was flipped.
  const hidden = format.legendInteractive === false ? NO_HIDDEN : hiddenSeries;
  const toggleSeries = (key: string) =>
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const measureColumns = result.columns.filter((c) => c.role === 'measure');
  const formatValue = makeValueFormatter(format, measureColumns);

  switch (spec.type) {
    case 'column':
    case 'bar':
    case 'stackedColumn':
    case 'stackedBar': {
      const shaped = shapeChartData(result, spec);
      const horizontal = spec.type === 'bar' || spec.type === 'stackedBar';
      const stacked = spec.type === 'stackedColumn' || spec.type === 'stackedBar';
      const showLegend = format.showLegend ?? shaped.series.length > 1;
      const visibleSeries = shaped.series.filter((s) => !hidden.has(s.key));
      const labelPosition = stacked ? 'center' : horizontal ? 'right' : 'top';
      // Single-series column/bar only: each category gets its own palette
      // slot; in this mode colorOverrides keyed by the CATEGORY label win.
      const singleSeriesBar =
        shaped.series.length === 1 && (spec.type === 'column' || spec.type === 'bar');
      const colorByCategory = Boolean(format.colorByCategory) && singleSeriesBar;
      // Cross-filter source dimming rides the same per-category Cell path, so
      // it too is single-series column/bar only; stacked/legend charts keep
      // full opacity (a category there spans several marks — skipped in v1).
      const dimming = activeCategory !== null && singleSeriesBar;
      const renderCells = colorByCategory || dimming;
      // Recharts hands (barItem, index) — index addresses shaped.data directly,
      // which is sturdier across recharts versions than digging into payload.
      const handleBarClick = onDatumClick
        ? (_: unknown, index: number) => {
            const row = shaped.data[index];
            if (!row) return;
            onDatumClick({
              value: row[RAW_AXIS_KEY] ?? null,
              label: String(row[shaped.axisKey] ?? ''),
            });
          }
        : undefined;
      const valueTickFormatter = axisTickFormatter(
        horizontal ? format.xAxisFormat : format.yAxisFormat,
      );
      return (
        <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
          <BarChart
            data={shaped.data}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={chartMargin(format)}
          >
            <CartesianGrid
              vertical={horizontal}
              horizontal={!horizontal}
              stroke="var(--rcd-grid-line)"
            />
            {horizontal ? (
              <XAxis
                type="number"
                tick={axisTickStyle}
                tickLine={false}
                axisLine={false}
                tickFormatter={valueTickFormatter}
                label={xAxisLabelProps(format.xAxisLabel, format.axisTitleStyle)}
              />
            ) : (
              <XAxis
                dataKey={shaped.axisKey}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={{ stroke: 'var(--rcd-axis)' }}
                label={xAxisLabelProps(format.xAxisLabel, format.axisTitleStyle)}
              />
            )}
            {horizontal ? (
              <YAxis
                type="category"
                dataKey={shaped.axisKey}
                width={110}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={{ stroke: 'var(--rcd-axis)' }}
                label={yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)}
              />
            ) : (
              <YAxis
                tick={axisTickStyle}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={valueTickFormatter}
                label={yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)}
              />
            )}
            {themedTooltip(formatValue, format, 'fill', stacked ? { active: true } : undefined)}
            {showLegend &&
              chartLegend(
                format,
                shaped.series.map((s) => ({ key: s.key, label: s.label, color: s.color })),
                hidden,
                toggleSeries,
              )}
            {visibleSeries.map((series) => (
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
                cursor={handleBarClick ? 'pointer' : undefined}
                onClick={handleBarClick}
              >
                {renderCells &&
                  shaped.data.map((row, dataIndex) => {
                    const categoryLabel = String(row[shaped.axisKey] ?? '');
                    return (
                      <Cell
                        key={dataIndex}
                        fill={
                          colorByCategory
                            ? seriesColor(
                                dataIndex,
                                categoryLabel,
                                format.colorOverrides,
                                format.theme,
                              )
                            : series.color
                        }
                        fillOpacity={
                          dimming && activeCategory && categoryLabel !== activeCategory.label
                            ? 0.35
                            : undefined
                        }
                      />
                    );
                  })}
                {format.showDataLabels && (
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
            ))}
          </BarChart>
        </ResponsiveContainer>
      );
    }

    case 'line': {
      const shaped = shapeChartData(result, spec);
      const showLegend = format.showLegend ?? shaped.series.length > 1;
      const visibleSeries = shaped.series.filter((s) => !hidden.has(s.key));
      return (
        <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
          <LineChart data={shaped.data} margin={chartMargin(format)}>
            <CartesianGrid vertical={false} stroke="var(--rcd-grid-line)" />
            <XAxis
              dataKey={shaped.axisKey}
              tick={axisTickStyle}
              tickLine={false}
              axisLine={{ stroke: 'var(--rcd-axis)' }}
              label={xAxisLabelProps(format.xAxisLabel, format.axisTitleStyle)}
            />
            <YAxis
              tick={axisTickStyle}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={axisTickFormatter(format.yAxisFormat)}
              label={yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)}
            />
            {themedTooltip(formatValue, format, 'line')}
            {showLegend &&
              chartLegend(
                format,
                shaped.series.map((s) => ({ key: s.key, label: s.label, color: s.color })),
                hidden,
                toggleSeries,
              )}
            {visibleSeries.map((series) => {
              const lineStyle = format.lineStyles?.[series.styleKey];
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
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      );
    }

    case 'area': {
      const shaped = shapeChartData(result, spec);
      const showLegend = format.showLegend ?? shaped.series.length > 1;
      const visibleSeries = shaped.series.filter((s) => !hidden.has(s.key));
      return (
        <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
          <AreaChart data={shaped.data} margin={chartMargin(format)}>
            <CartesianGrid vertical={false} stroke="var(--rcd-grid-line)" />
            <XAxis
              dataKey={shaped.axisKey}
              tick={axisTickStyle}
              tickLine={false}
              axisLine={{ stroke: 'var(--rcd-axis)' }}
              label={xAxisLabelProps(format.xAxisLabel, format.axisTitleStyle)}
            />
            <YAxis
              tick={axisTickStyle}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={axisTickFormatter(format.yAxisFormat)}
              label={yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)}
            />
            {themedTooltip(formatValue, format, 'line')}
            {showLegend &&
              chartLegend(
                format,
                shaped.series.map((s) => ({ key: s.key, label: s.label, color: s.color })),
                hidden,
                toggleSeries,
              )}
            {visibleSeries.map((series) => {
              const lineStyle = format.lineStyles?.[series.styleKey];
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
                  isAnimationActive={false}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      );
    }

    case 'pie':
    case 'donut': {
      const { slices } = shapePieData(result, spec);
      if (slices.length === 0) return <Placeholder>Pie needs a measure.</Placeholder>;
      const showLegend = format.showLegend ?? slices.length > 1;
      // Hidden slices are removed from the pie entirely (the visible total is
      // the percent denominator); the interactive legend still lists them.
      const visibleSlices = slices.filter((s) => !hidden.has(s.label));
      const visibleTotal = visibleSlices.reduce((sum, s) => sum + s.value, 0);
      // Sector index addresses the VISIBLE slices array (data order === sector order).
      const handleSliceClick = onDatumClick
        ? (_: unknown, index: number) => {
            const slice = visibleSlices[index];
            if (slice) onDatumClick({ value: slice.raw, label: slice.label });
          }
        : undefined;
      return (
        <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
          <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            {themedTooltip(formatValue, format, 'none', { active: true, total: visibleTotal })}
            {showLegend &&
              chartLegend(
                format,
                slices.map((s) => ({ key: s.label, label: s.label, color: s.color })),
                hidden,
                toggleSeries,
              )}
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
            >
              {visibleSlices.map((slice, i) => (
                <Cell
                  key={`${i}-${slice.label}`}
                  fill={slice.color}
                  fillOpacity={
                    activeCategory && slice.label !== activeCategory.label ? 0.35 : undefined
                  }
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
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
      return (
        <div className="relative h-full w-full min-w-0 overflow-hidden">
          <ResponsiveContainer width="100%" height="100%" debounce={RESIZE_DEBOUNCE}>
            <ScatterChart margin={chartMargin(format, { bottom: true, left: true })}>
              <CartesianGrid stroke="var(--rcd-grid-line)" />
              <XAxis
                type="number"
                dataKey="x"
                name={xColumn.label}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={{ stroke: 'var(--rcd-axis)' }}
                tickFormatter={axisTickFormatter(format.xAxisFormat)}
                label={xAxisLabelProps(format.xAxisLabel ?? xColumn.label, format.axisTitleStyle)}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={yColumn.label}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={axisTickFormatter(format.yAxisFormat)}
                label={yAxisLabelProps(format.yAxisLabel ?? yColumn.label, format.axisTitleStyle)}
              />
              {themedTooltip(formatPoint, format, 'dashed')}
              {showLegend &&
                chartLegend(
                  format,
                  scatter.series.map((s) => ({ key: s.key, label: s.label, color: s.color })),
                  hidden,
                  toggleSeries,
                )}
              {visibleSeries.map((series) => (
                <Scatter
                  key={series.key}
                  name={series.label}
                  data={series.points}
                  fill={series.color}
                  isAnimationActive={false}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
          {scatter.droppedSeries > 0 && (
            <div className="absolute right-2 top-1 rounded border border-rcd-border bg-rcd-surface px-1.5 py-0.5 text-[10px] text-rcd-muted">
              +{scatter.droppedSeries} more series not shown
            </div>
          )}
        </div>
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

      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
          <div className="text-4xl font-semibold tabular-nums text-rcd-text">
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
                  onClick={handleRowClick ? () => handleRowClick(row) : undefined}
                  className={
                    handleRowClick
                      ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/10'
                      : 'hover:bg-black/5 dark:hover:bg-white/10'
                  }
                >
                  {result.columns.map((column, columnIndex) => (
                    <td
                      key={column.name}
                      className={`border-b border-rcd-border px-3 py-1.5 text-rcd-text ${
                        column.role === 'measure' ? 'text-right tabular-nums' : 'text-left'
                      }`}
                    >
                      {formatCellValue(row[columnIndex] ?? null, column)}
                    </td>
                  ))}
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
