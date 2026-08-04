import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartSpec, QueryResult } from '@recon/dashboards-core';
import { shapeChartData } from './chartData';

export interface ChartRendererProps {
  spec: ChartSpec;
  result: QueryResult;
}

const axisTickStyle = { fontSize: 11, fill: 'var(--rcd-text-2)' } as const;

/**
 * Loaded lazily (rcd-charts chunk). Column charts land with the vertical
 * slice; the full type set follows in the feature phase.
 */
export default function ChartRenderer({ spec, result }: ChartRendererProps) {
  const shaped = shapeChartData(result, spec);
  const showLegend = spec.format.showLegend ?? shaped.series.length > 1;

  switch (spec.type) {
    case 'column':
      return (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={shaped.data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--rcd-grid-line)" />
            <XAxis
              dataKey={shaped.axisKey}
              tick={axisTickStyle}
              tickLine={false}
              axisLine={{ stroke: 'var(--rcd-axis)' }}
            />
            <YAxis tick={axisTickStyle} tickLine={false} axisLine={false} width={56} />
            <Tooltip
              cursor={{ fill: 'var(--rcd-border)' }}
              contentStyle={{
                backgroundColor: 'var(--rcd-surface)',
                border: '1px solid var(--rcd-border)',
                borderRadius: 8,
                color: 'var(--rcd-text)',
                fontSize: 12,
              }}
            />
            {showLegend && <Legend wrapperStyle={{ fontSize: 12, color: 'var(--rcd-text-2)' }} />}
            {shaped.series.map((series) => (
              <Bar
                key={series.key}
                dataKey={series.key}
                name={series.label}
                fill={series.color}
                stroke="var(--rcd-surface)"
                strokeWidth={1}
                radius={[2, 2, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      );

    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-rcd-muted">
          Chart type “{spec.type}” arrives with the full chart set.
        </div>
      );
  }
}
