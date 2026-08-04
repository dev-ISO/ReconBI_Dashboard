import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { ChartFormat, ChartSpec, ChartType } from '@recon/dashboards-core';
import { RcdInput, RcdSelect } from '../primitives';

export interface FormatPanelProps {
  spec: ChartSpec;
  /** Series (or slice) names currently rendered — drives the color rows. */
  seriesKeys: string[];
  onChange(format: ChartFormat): void;
}

/** Chart types with no cartesian axes; the axis-titles section hides for them. */
const AXISLESS_TYPES: ReadonlyArray<ChartType> = ['pie', 'donut', 'kpi', 'table'];

/** Swatch value shown before an override exists (slot 1 of the palette, light). */
const DEFAULT_SWATCH = '#2a78d6';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-rcd-muted">{title}</h3>
      {children}
    </section>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-rcd-text">
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-rcd-accent"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * Stacked format controls for the chart builder. Every control writes the whole
 * next ChartFormat through onChange; the panel itself is stateless.
 */
export function FormatPanel({ spec, seriesKeys, onChange }: FormatPanelProps) {
  const format = spec.format;
  const patch = (partial: Partial<ChartFormat>) => onChange({ ...format, ...partial });

  const showLegend = format.showLegend ?? seriesKeys.length >= 2;
  const hasAxes = !AXISLESS_TYPES.includes(spec.type);

  const setOverride = (key: string, color: string) =>
    patch({ colorOverrides: { ...format.colorOverrides, [key]: color } });

  const clearOverride = (key: string) => {
    const next = { ...format.colorOverrides };
    delete next[key];
    patch({ colorOverrides: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <Section title="Legend">
        <CheckboxRow
          label="Show legend"
          checked={showLegend}
          onChange={(checked) => patch({ showLegend: checked })}
        />
        <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
          Position
          <RcdSelect
            value={format.legendPosition ?? 'bottom'}
            disabled={!showLegend}
            onChange={(event) =>
              patch({ legendPosition: event.target.value as 'top' | 'right' | 'bottom' })
            }
          >
            <option value="top">Top</option>
            <option value="right">Right</option>
            <option value="bottom">Bottom</option>
          </RcdSelect>
        </label>
      </Section>

      <Section title="Data labels">
        <CheckboxRow
          label="Show value labels"
          checked={format.showDataLabels ?? false}
          onChange={(checked) => patch({ showDataLabels: checked })}
        />
      </Section>

      <Section title="Value format">
        <RcdInput
          value={format.valueFormat ?? ''}
          placeholder="e.g. $ or % or #"
          aria-label="Value format"
          onChange={(event) => patch({ valueFormat: event.target.value || undefined })}
        />
      </Section>

      {hasAxes && (
        <Section title="Axis titles">
          <RcdInput
            value={format.xAxisLabel ?? ''}
            placeholder="X axis"
            aria-label="X axis title"
            onChange={(event) => patch({ xAxisLabel: event.target.value || undefined })}
          />
          <RcdInput
            value={format.yAxisLabel ?? ''}
            placeholder="Y axis"
            aria-label="Y axis title"
            onChange={(event) => patch({ yAxisLabel: event.target.value || undefined })}
          />
        </Section>
      )}

      {seriesKeys.length > 0 && (
        <Section title="Series colors">
          {seriesKeys.map((key) => {
            const override = format.colorOverrides?.[key];
            return (
              <div key={key} className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`Color for ${key}`}
                  className="h-6 w-8 shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0"
                  value={override ?? DEFAULT_SWATCH}
                  onChange={(event) => setOverride(key, event.target.value)}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-rcd-text">{key}</span>
                {override && (
                  <button
                    type="button"
                    aria-label={`Reset color for ${key}`}
                    className="rounded p-1 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                    onClick={() => clearOverride(key)}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </Section>
      )}
    </div>
  );
}
