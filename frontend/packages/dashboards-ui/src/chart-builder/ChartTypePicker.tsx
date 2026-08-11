import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AreaChart,
  BarChart3,
  BarChartHorizontal,
  ChartBarStacked,
  ChartColumnStacked,
  ChartGantt,
  CircleDot,
  Hash,
  LineChart,
  PieChart,
  ScatterChart,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import type { ChartType } from '@recon/dashboards-core';
import { wellsFor } from './wellConfig';

export interface ChartTypePickerProps {
  value: ChartType;
  onChange: (type: ChartType) => void;
}

const OPTIONS: { type: ChartType; label: string; icon: LucideIcon; description: string }[] = [
  {
    type: 'column',
    label: 'Column',
    icon: BarChart3,
    description: 'Compare values across categories with vertical bars.',
  },
  {
    type: 'stackedColumn',
    label: 'Stacked column',
    icon: ChartColumnStacked,
    description: 'Show how parts add up to a total within each category.',
  },
  {
    type: 'bar',
    label: 'Bar',
    icon: BarChartHorizontal,
    description: 'Horizontal bars — best when category names are long.',
  },
  {
    type: 'stackedBar',
    label: 'Stacked bar',
    icon: ChartBarStacked,
    description: 'Horizontal stacked bars: parts of a total per category.',
  },
  {
    type: 'line',
    label: 'Line',
    icon: LineChart,
    description: 'Show a trend over time or ordered categories.',
  },
  {
    type: 'area',
    label: 'Area',
    icon: AreaChart,
    description: 'A line with the area filled — emphasizes magnitude.',
  },
  {
    type: 'pie',
    label: 'Pie',
    icon: PieChart,
    description: "Each category's share of the whole, as slices.",
  },
  {
    type: 'donut',
    label: 'Donut',
    icon: CircleDot,
    description: 'A pie with a center hole showing the total.',
  },
  {
    type: 'scatter',
    label: 'Scatter',
    icon: ScatterChart,
    description: 'Plot two measures against each other to spot patterns.',
  },
  {
    type: 'gantt',
    label: 'Gantt',
    icon: ChartGantt,
    description: 'Timeline bars from a start date to an end date — one row per task.',
  },
  {
    type: 'kpi',
    label: 'KPI',
    icon: Hash,
    description: 'One big number, with an optional comparison below it.',
  },
  {
    type: 'table',
    label: 'Table',
    icon: Table2,
    description: 'Rows and columns of values, sortable and pageable.',
  },
];

/** "Slots: X axis · Y axis — values · Legend" — derived so it stays in sync. */
const wellsHintFor = (type: ChartType): string =>
  wellsFor(type)
    .map((well) => well.label)
    .join(' · ');

const TOOLTIP_DELAY_MS = 350;
const TOOLTIP_WIDTH = 256; // w-64

interface TooltipState {
  type: ChartType;
  top: number;
  left: number;
}

/**
 * Chart-type grid: comfortable buttons with the type name always visible, and
 * a rich tooltip (name + description + the type's wells) that arms over the
 * WHOLE button after a short delay. Selection behavior is unchanged.
 */
export function ChartTypePicker({ value, onChange }: ChartTypePickerProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const timerRef = useRef<number | null>(null);

  const cancelTooltip = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTooltip(null);
  };

  useEffect(() => cancelTooltip, []);

  const armTooltip = (type: ChartType, element: HTMLElement) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const rect = element.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2, window.innerWidth - TOOLTIP_WIDTH - 8),
      );
      // Below the button; flips above when the viewport bottom is close.
      const estimatedHeight = 92;
      const below = rect.bottom + 6;
      const top =
        below + estimatedHeight > window.innerHeight - 8
          ? Math.max(8, rect.top - estimatedHeight - 6)
          : below;
      setTooltip({ type, top, left });
    }, TOOLTIP_DELAY_MS);
  };

  const tooltipOption = tooltip ? OPTIONS.find((option) => option.type === tooltip.type) : null;

  return (
    <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Chart type">
      {OPTIONS.map(({ type, label, icon: Icon }) => {
        const selected = value === type;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            onClick={() => {
              cancelTooltip();
              onChange(type);
            }}
            onMouseEnter={(event) => armTooltip(type, event.currentTarget)}
            onMouseLeave={cancelTooltip}
            onFocus={(event) => armTooltip(type, event.currentTarget)}
            onBlur={cancelTooltip}
            className={`flex min-h-[3.4rem] flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 transition-colors ${
              selected
                ? 'bg-rcd-text text-rcd-surface shadow-[var(--rcd-shadow-1)]'
                : 'text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
            }`}
          >
            <Icon size={18} className="shrink-0" />
            <span className="w-full text-center text-[10px] font-medium leading-[1.15]">
              {label}
            </span>
          </button>
        );
      })}

      {tooltip &&
        tooltipOption &&
        createPortal(
          // rcd-root wrapper: --rcd-* tokens are scoped, portals re-establish them.
          <div className="rcd-root bg-transparent">
            <div
              role="tooltip"
              style={{ top: tooltip.top, left: tooltip.left, width: TOOLTIP_WIDTH }}
              className="pointer-events-none fixed z-[75] rounded-md border border-rcd-border bg-rcd-surface p-2.5 shadow-[var(--rcd-shadow-2)]"
            >
              <div className="text-xs font-semibold text-rcd-text">{tooltipOption.label}</div>
              <div className="pt-0.5 text-[11px] leading-snug text-rcd-text-2">
                {tooltipOption.description}
              </div>
              <div className="pt-1 text-[11px] leading-snug text-rcd-muted">
                Slots: {wellsHintFor(tooltipOption.type)}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
