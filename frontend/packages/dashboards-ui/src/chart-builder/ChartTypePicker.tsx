import {
  AreaChart,
  BarChart3,
  BarChartHorizontal,
  ChartBarStacked,
  ChartColumnStacked,
  CircleDot,
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

const OPTIONS: { type: ChartType; label: string; icon: LucideIcon }[] = [
  { type: 'column', label: 'Column', icon: BarChart3 },
  { type: 'stackedColumn', label: 'Stacked column', icon: ChartColumnStacked },
  { type: 'bar', label: 'Bar', icon: BarChartHorizontal },
  { type: 'stackedBar', label: 'Stacked bar', icon: ChartBarStacked },
  { type: 'line', label: 'Line', icon: LineChart },
  { type: 'area', label: 'Area', icon: AreaChart },
  { type: 'pie', label: 'Pie', icon: PieChart },
  { type: 'donut', label: 'Donut', icon: CircleDot },
  { type: 'scatter', label: 'Scatter', icon: ScatterChart },
  { type: 'kpi', label: 'KPI', icon: Hash },
  { type: 'table', label: 'Table', icon: Table2 },
];

/** Icon grid of chart types. */
export function ChartTypePicker({ value, onChange }: ChartTypePickerProps) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Chart type">
      {OPTIONS.map(({ type, label, icon: Icon }) => {
        const selected = value === type;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => onChange(type)}
            className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
              selected
                ? 'border-rcd-accent bg-[color-mix(in_srgb,var(--rcd-accent)_12%,transparent)] text-rcd-accent'
                : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            <Icon size={17} />
          </button>
        );
      })}
    </div>
  );
}
