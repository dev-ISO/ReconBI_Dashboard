import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { ChartFormat, ChartSpec, ChartType, TextStyle } from '@recon/dashboards-core';
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

/** Swatch shown before a text color is chosen (neutral, close to --rcd-text-2). */
const TEXT_SWATCH = '#64748b';

const clampFontSize = (value: number): number => Math.min(32, Math.max(8, Math.trunc(value)));

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
 * One compact text-style row: size (8-32) + bold/italic toggles + color with
 * reset. Emits undefined once every field is back at its default, so specs
 * stay minimal.
 */
function TextStyleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TextStyle | undefined;
  onChange: (next: TextStyle | undefined) => void;
}) {
  const set = (partial: Partial<TextStyle>) => {
    const merged = { ...value, ...partial };
    const next: TextStyle = {};
    if (merged.fontSize !== undefined) next.fontSize = merged.fontSize;
    if (merged.bold) next.bold = true;
    if (merged.italic) next.italic = true;
    if (merged.color) next.color = merged.color;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  const toggleClass = (active: boolean) =>
    `flex h-6 w-6 shrink-0 items-center justify-center rounded border text-xs ${
      active
        ? 'border-rcd-accent bg-rcd-accent text-white'
        : 'border-rcd-border text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10'
    }`;

  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-rcd-text" title={label}>
        {label}
      </span>
      <input
        type="number"
        min={8}
        max={32}
        aria-label={`${label} font size`}
        placeholder="px"
        className="w-14 shrink-0 rounded-md border border-rcd-border bg-rcd-surface px-1.5 py-1 text-sm text-rcd-text outline-none focus:border-rcd-accent"
        value={value?.fontSize ?? ''}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          set({
            fontSize:
              event.target.value === '' || Number.isNaN(parsed) ? undefined : Math.trunc(parsed),
          });
        }}
        onBlur={() => {
          if (value?.fontSize !== undefined && value.fontSize !== clampFontSize(value.fontSize)) {
            set({ fontSize: clampFontSize(value.fontSize) });
          }
        }}
      />
      <button
        type="button"
        aria-label={`${label} bold`}
        aria-pressed={Boolean(value?.bold)}
        className={`${toggleClass(Boolean(value?.bold))} font-bold`}
        onClick={() => set({ bold: !value?.bold })}
      >
        B
      </button>
      <button
        type="button"
        aria-label={`${label} italic`}
        aria-pressed={Boolean(value?.italic)}
        className={`${toggleClass(Boolean(value?.italic))} italic`}
        onClick={() => set({ italic: !value?.italic })}
      >
        I
      </button>
      <input
        type="color"
        aria-label={`${label} color`}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0"
        value={value?.color ?? TEXT_SWATCH}
        onChange={(event) => set({ color: event.target.value })}
      />
      {value?.color && (
        <button
          type="button"
          aria-label={`Reset ${label} color`}
          className="shrink-0 rounded p-1 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
          onClick={() => set({ color: undefined })}
        >
          <X size={12} />
        </button>
      )}
    </div>
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

  /** Empty string clears the override; the map drops entirely once empty. */
  const setSeriesLabel = (key: string, label: string) => {
    const next = { ...format.seriesLabels };
    if (label) next[key] = label;
    else delete next[key];
    patch({ seriesLabels: Object.keys(next).length > 0 ? next : undefined });
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

      <Section title="Text styles">
        <TextStyleRow
          label="Title"
          value={format.titleStyle}
          onChange={(next) => patch({ titleStyle: next })}
        />
        {hasAxes && (
          <TextStyleRow
            label="Axis titles"
            value={format.axisTitleStyle}
            onChange={(next) => patch({ axisTitleStyle: next })}
          />
        )}
        <TextStyleRow
          label="Legend"
          value={format.legendStyle}
          onChange={(next) => patch({ legendStyle: next })}
        />
      </Section>

      {seriesKeys.length > 0 && (
        <Section title="Series names">
          {seriesKeys.map((key) => (
            <div key={key} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-rcd-text-2" title={key}>
                {key}
              </span>
              <RcdInput
                className="w-36 shrink-0"
                value={format.seriesLabels?.[key] ?? ''}
                placeholder="Rename"
                aria-label={`Display name for ${key}`}
                onChange={(event) => setSeriesLabel(key, event.target.value)}
              />
            </div>
          ))}
        </Section>
      )}

      {(spec.type === 'column' || spec.type === 'bar') && (
        <Section title="Category colors">
          <CheckboxRow
            label="Color by category"
            checked={format.colorByCategory ?? false}
            onChange={(checked) => patch({ colorByCategory: checked || undefined })}
          />
          <p className="text-xs text-rcd-muted">
            Single-series charts give each bar its own palette color; color overrides then apply
            per category.
          </p>
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
