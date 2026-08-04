import {
  AreaChart,
  BarChart3,
  BarChartHorizontal,
  Hash,
  LineChart,
  PieChart,
  ScatterChart,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import type { ChartType } from '@recon/dashboards-core';

export interface ChartTypePickerProps {
  value: ChartType;
  onChange: (type: ChartType) => void;
}

const OPTIONS: { type: ChartType; label: string; icon: LucideIcon; enabled: boolean }[] = [
  { type: 'column', label: 'Column', icon: BarChart3, enabled: true },
  { type: 'bar', label: 'Bar', icon: BarChartHorizontal, enabled: false },
  { type: 'line', label: 'Line', icon: LineChart, enabled: false },
  { type: 'area', label: 'Area', icon: AreaChart, enabled: false },
  { type: 'pie', label: 'Pie', icon: PieChart, enabled: false },
  { type: 'scatter', label: 'Scatter', icon: ScatterChart, enabled: false },
  { type: 'kpi', label: 'KPI', icon: Hash, enabled: false },
  { type: 'table', label: 'Table', icon: Table2, enabled: false },
];

/** Icon grid of chart types; only 'column' is live in this slice. */
export function ChartTypePicker({ value, onChange }: ChartTypePickerProps) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Chart type">
      {OPTIONS.map(({ type, label, icon: Icon, enabled }) => {
        const selected = value === type;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            disabled={!enabled}
            title={enabled ? label : 'coming soon'}
            onClick={() => onChange(type)}
            className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
              selected
                ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_12%,transparent)] text-rcd-accent'
                : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10'
            } disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent`}
          >
            <Icon size={17} />
          </button>
        );
      })}
    </div>
  );
}
