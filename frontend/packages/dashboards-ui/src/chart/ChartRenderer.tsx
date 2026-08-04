import type { ReactNode } from 'react';
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
  formatCellValue,
  seriesColor,
  type CellValue,
  type ChartFormat,
  type ChartSpec,
  type QueryColumn,
  type QueryResult,
  type TextStyle,
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

const tooltipContentStyle = {
  backgroundColor: 'var(--rcd-surface)',
  border: '1px solid var(--rcd-border)',
  borderRadius: 8,
  color: 'var(--rcd-text)',
  fontSize: 12,
} as const;

const legendWrapperStyle = { fontSize: 12, color: 'var(--rcd-text-2)' } as const;

const TABLE_ROW_CAP = 500;

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

/** Themed tooltip; formatEntry receives (value, dataKey of the hovered series). */
function themedTooltip(
  formatEntry: (value: unknown, dataKey: string | undefined) => string,
  cursor: TooltipCursor,
) {
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
      contentStyle={tooltipContentStyle}
      formatter={(value, _name, item) =>
        formatEntry(value, typeof item.dataKey === 'string' ? item.dataKey : undefined)
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
 */
export default function ChartRenderer({
  spec,
  result,
  onDatumClick,
  activeCategory = null,
}: ChartRendererProps) {
  const format = spec.format;
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
      return (
        <ResponsiveContainer width="100%" height="100%">
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
                label={yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)}
              />
            )}
            {themedTooltip(formatValue, 'fill')}
            {showLegend && <Legend {...legendProps(format)} />}
            {shaped.series.map((series) => (
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
                            ? seriesColor(dataIndex, categoryLabel, format.colorOverrides)
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
      return (
        <ResponsiveContainer width="100%" height="100%">
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
              label={yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)}
            />
            {themedTooltip(formatValue, 'line')}
            {showLegend && <Legend {...legendProps(format)} />}
            {shaped.series.map((series) => (
              <Line
                key={series.key}
                type="linear"
                dataKey={series.key}
                name={series.label}
                stroke={series.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      );
    }

    case 'area': {
      const shaped = shapeChartData(result, spec);
      const showLegend = format.showLegend ?? shaped.series.length > 1;
      return (
        <ResponsiveContainer width="100%" height="100%">
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
              label={yAxisLabelProps(format.yAxisLabel, format.axisTitleStyle)}
            />
            {themedTooltip(formatValue, 'line')}
            {showLegend && <Legend {...legendProps(format)} />}
            {shaped.series.map((series) => (
              <Area
                key={series.key}
                type="linear"
                dataKey={series.key}
                name={series.label}
                stroke={series.color}
                strokeWidth={2}
                fill={series.color}
                fillOpacity={0.25}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      );
    }

    case 'pie':
    case 'donut': {
      const { slices } = shapePieData(result, spec);
      if (slices.length === 0) return <Placeholder>Pie needs a measure.</Placeholder>;
      const showLegend = format.showLegend ?? slices.length > 1;
      // Sector index addresses our own slices array (data order === sector order).
      const handleSliceClick = onDatumClick
        ? (_: unknown, index: number) => {
            const slice = slices[index];
            if (slice) onDatumClick({ value: slice.raw, label: slice.label });
          }
        : undefined;
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            {themedTooltip(formatValue, 'none')}
            {showLegend && <Legend {...legendProps(format)} />}
            <Pie
              data={slices}
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
              {slices.map((slice, i) => (
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
      return (
        <div className="relative h-full w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={chartMargin(format, { bottom: true, left: true })}>
              <CartesianGrid stroke="var(--rcd-grid-line)" />
              <XAxis
                type="number"
                dataKey="x"
                name={xColumn.label}
                tick={axisTickStyle}
                tickLine={false}
                axisLine={{ stroke: 'var(--rcd-axis)' }}
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
                label={yAxisLabelProps(format.yAxisLabel ?? yColumn.label, format.axisTitleStyle)}
              />
              {themedTooltip(formatPoint, 'dashed')}
              {showLegend && <Legend {...legendProps(format)} />}
              {scatter.series.map((series) => (
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
