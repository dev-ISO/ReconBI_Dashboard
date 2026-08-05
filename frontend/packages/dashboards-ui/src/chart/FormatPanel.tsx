import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, PenLine, Trash2, X } from 'lucide-react';
import {
  CATEGORICAL_SLOTS,
  CHART_THEMES,
  formatDatePattern,
  formatNumberPattern,
  newId,
  sanitizeRichHtml,
  type AxisValueFormat,
  type ChartFormat,
  type ChartSpec,
  type ChartThemeName,
  type ChartType,
  type ConditionalFormatSpec,
  type ConditionalOp,
  type ConditionalRule,
  type ContainerStyle,
  type DateFormatPreset,
  type ReferenceLineSpec,
  type SeriesLineStyle,
  type SmallMultiplesFormat,
  type TableOptions,
  type TextStyle,
  type TooltipStyle,
  type TrendlineSpec,
} from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';

export interface FormatPanelProps {
  spec: ChartSpec;
  /** Series (or slice) names currently rendered — drives the color rows. */
  seriesKeys: string[];
  onChange(format: ChartFormat): void;
}

/** Chart types with no cartesian axes; the Axes section hides for them. */
const AXISLESS_TYPES: ReadonlyArray<ChartType> = ['pie', 'donut', 'kpi', 'table'];

/** Types whose value axis is X (horizontal orientation). */
const HORIZONTAL_TYPES: ReadonlyArray<ChartType> = ['bar', 'stackedBar'];

/** Types that render series as strokes; the per-series line-style rows show for them. */
const LINE_TYPES: ReadonlyArray<ChartType> = ['line', 'area'];

/** Types where tooltip "percent of total" makes sense. */
const PERCENT_TYPES: ReadonlyArray<ChartType> = ['pie', 'donut', 'stackedColumn', 'stackedBar'];

/** Swatch value shown before an override exists (slot 1 of the palette, light). */
const DEFAULT_SWATCH = '#2a78d6';

/** Swatch shown before a text color is chosen (neutral, close to --rcd-text-2). */
const TEXT_SWATCH = '#64748b';

/** Theme picker rows: the default row previews the host CSS-variable slots. */
const THEME_OPTIONS: ReadonlyArray<{ name: ChartThemeName; label: string; colors: readonly string[] }> = [
  {
    name: 'default',
    label: 'Default',
    colors: Array.from({ length: CATEGORICAL_SLOTS }, (_, i) => `var(--rcd-cat-${i + 1})`),
  },
  { name: 'ocean', label: 'Ocean', colors: CHART_THEMES.ocean },
  { name: 'sunset', label: 'Sunset', colors: CHART_THEMES.sunset },
  { name: 'forest', label: 'Forest', colors: CHART_THEMES.forest },
  { name: 'berry', label: 'Berry', colors: CHART_THEMES.berry },
  { name: 'mono', label: 'Mono', colors: CHART_THEMES.mono },
];

const DATE_FORMAT_OPTIONS: ReadonlyArray<{ value: DateFormatPreset; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'monthShort', label: 'Month (Jan)' },
  { value: 'monthLong', label: 'Month (January)' },
  { value: 'monthNum', label: 'Month (1-12)' },
  { value: 'monthYear', label: 'Month + year (Jan 2026)' },
  { value: 'dayShort', label: 'Weekday (Mon)' },
  { value: 'dayLong', label: 'Weekday (Monday)' },
  { value: 'dayOfMonth', label: 'Day of month (1-31)' },
  { value: 'quarter', label: 'Quarter (Q1 2026)' },
  { value: 'year', label: 'Year (2026)' },
  { value: 'isoDate', label: 'ISO date (2026-08-04)' },
];

/** Table page-size presets; anything else renders through the Custom input. */
const TABLE_PAGE_SIZE_PRESETS: readonly number[] = [25, 50, 100, 250];

const REFRESH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Off' },
  { value: '5', label: 'Every 5s' },
  { value: '15', label: 'Every 15s' },
  { value: '30', label: 'Every 30s' },
  { value: '60', label: 'Every 1m' },
  { value: '300', label: 'Every 5m' },
];

const NUMBER_INPUT_CLASS =
  'w-14 shrink-0 rounded-md border border-rcd-border bg-rcd-surface px-1.5 py-1 text-sm text-rcd-text outline-none focus:border-rcd-accent disabled:opacity-40';

const RESET_BUTTON_CLASS =
  'shrink-0 rounded p-1 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10';

/** Sub-group heading inside a section; matches the section-header language. */
const SUBHEAD_CLASS = 'text-[11px] font-semibold uppercase tracking-wide text-rcd-muted';

/** Helper captions for the legend click-action modes. */
const LEGEND_MODE_CAPTIONS: Record<'toggle' | 'isolate' | 'crossFilter', string> = {
  toggle: 'Click hides or shows the clicked series.',
  isolate: 'Click shows only that series; click again to restore.',
  crossFilter: 'Click highlights that group across every chart on the page.',
};

const clampFontSize = (value: number): number => Math.min(32, Math.max(8, Math.trunc(value)));

/** Chevron-headed collapsible block; keeps the panel's uppercase header language. */
function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col border-b border-rcd-border pb-2 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded py-1 text-left hover:bg-black/5 dark:hover:bg-white/10"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-rcd-muted" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-rcd-muted" />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-rcd-muted">
          {title}
        </span>
      </button>
      {open && <div className="mt-1.5 flex flex-col gap-2 pb-1 pl-4">{children}</div>}
    </section>
  );
}

function CheckboxRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center gap-2 text-sm ${disabled ? 'text-rcd-muted' : 'text-rcd-text'}`}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-rcd-accent disabled:opacity-40"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** Compact pill button group; matches the Left/Right axis-assignment look. */
function SegmentedRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="flex shrink-0 overflow-hidden rounded-md border border-rcd-border"
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              aria-label={`${label}: ${option.label}`}
              className={`px-2 py-0.5 text-[11px] font-medium transition-colors ${
                active
                  ? 'bg-rcd-accent text-white'
                  : 'text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10'
              }`}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Label + clamped integer input; empty clears back to the (theme) default. */
function NumberRow({
  label,
  value,
  min,
  max,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        className={NUMBER_INPUT_CLASS}
        value={value ?? ''}
        onChange={(event) => {
          if (event.target.value === '') {
            onChange(undefined);
            return;
          }
          const parsed = Number(event.target.value);
          if (Number.isNaN(parsed)) {
            onChange(undefined);
            return;
          }
          onChange(Math.min(max, Math.max(min, Math.trunc(parsed))));
        }}
      />
    </label>
  );
}

/** Label + color swatch + reset-to-default X (shown only once a value is set). */
function ColorRow({
  label,
  value,
  fallback,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  fallback: string;
  disabled?: boolean;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-rcd-text-2" title={label}>
        {label}
      </span>
      <input
        type="color"
        aria-label={`${label} color`}
        disabled={disabled}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0 disabled:cursor-default disabled:opacity-40"
        value={value ?? fallback}
        onChange={(event) => onChange(event.target.value)}
      />
      {value != null && !disabled && (
        <button
          type="button"
          aria-label={`Reset ${label}`}
          className={RESET_BUTTON_CLASS}
          onClick={() => onChange(undefined)}
        >
          <X size={12} />
        </button>
      )}
    </div>
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
        className={NUMBER_INPUT_CLASS}
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
          className={RESET_BUTTON_CLASS}
          onClick={() => set({ color: undefined })}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** formatNumberPattern with malformed-pattern safety for the live previews. */
const safeNumberPattern = (value: number, pattern: string): string => {
  try {
    return formatNumberPattern(value, pattern);
  } catch {
    return '—';
  }
};

/** formatDatePattern with malformed-mask safety for the live preview. */
const safeDatePattern = (date: Date, pattern: string): string => {
  try {
    return formatDatePattern(date, pattern);
  } catch {
    return '—';
  }
};

/** Compact token cheat-sheet shown under every custom number-pattern input. */
const NUMBER_PATTERN_CHEAT = 'Tokens: 0 # , . % ; "text" — trailing , = ÷1000';

/**
 * Monospace Excel-style pattern input with a live preview (a large positive and
 * a negative sample) plus the token cheat sheet. Shared by the axis custom
 * formats and the Values section's custom pattern mode.
 */
function NumberPatternField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <RcdInput
        className="min-w-0 font-mono"
        value={value}
        placeholder='e.g. $#,##0;($#,##0)'
        aria-label={`${label} custom pattern`}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.trim() !== '' && (
        <p className="font-mono text-xs text-rcd-muted">
          1234567.891 → {safeNumberPattern(1234567.891, value)} · -1234.5 →{' '}
          {safeNumberPattern(-1234.5, value)}
        </p>
      )}
      <p className="text-xs text-rcd-muted">{NUMBER_PATTERN_CHEAT}</p>
    </div>
  );
}

/**
 * Numeric value-axis format editor: kind select + decimals (0-4). "Auto"
 * removes the whole AxisValueFormat so specs stay minimal; decimals are only
 * meaningful (and enabled) once a concrete non-custom kind is chosen.
 * "Custom…" swaps decimals for an Excel-style pattern input with live preview.
 */
function AxisFormatEditor({
  label,
  helper,
  value,
  onChange,
}: {
  label: string;
  helper?: string;
  value: AxisValueFormat | undefined;
  onChange: (next: AxisValueFormat | undefined) => void;
}) {
  const kind = value?.kind ?? 'auto';

  const setKind = (nextKind: NonNullable<AxisValueFormat['kind']>) => {
    if (nextKind === 'auto') {
      onChange(undefined);
      return;
    }
    const next: AxisValueFormat = { kind: nextKind };
    if (nextKind === 'custom') {
      if (value?.pattern) next.pattern = value.pattern;
    } else if (value?.decimals !== undefined) {
      next.decimals = value.decimals;
    }
    onChange(next);
  };

  const setDecimals = (decimals: number | undefined) => {
    if (kind === 'auto' || kind === 'custom') return;
    const next: AxisValueFormat = { kind };
    if (decimals !== undefined) next.decimals = decimals;
    onChange(next);
  };

  const setPattern = (pattern: string) => {
    const next: AxisValueFormat = { kind: 'custom' };
    if (pattern !== '') next.pattern = pattern;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm text-rcd-text-2" title={label}>
          {label}
        </span>
        <RcdSelect
          aria-label={`${label} kind`}
          className="w-24 shrink-0"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as NonNullable<AxisValueFormat['kind']>)
          }
        >
          <option value="auto">Auto</option>
          <option value="number">Number</option>
          <option value="currency">Currency</option>
          <option value="percent">Percent</option>
          <option value="compact">Compact</option>
          <option value="custom">Custom…</option>
        </RcdSelect>
        <input
          type="number"
          min={0}
          max={4}
          aria-label={`${label} decimals`}
          title="Decimal places"
          placeholder="dp"
          disabled={kind === 'auto' || kind === 'custom'}
          className={NUMBER_INPUT_CLASS}
          value={kind === 'custom' ? '' : (value?.decimals ?? '')}
          onChange={(event) => {
            if (event.target.value === '') {
              setDecimals(undefined);
              return;
            }
            const parsed = Number(event.target.value);
            setDecimals(
              Number.isNaN(parsed) ? undefined : Math.min(4, Math.max(0, Math.trunc(parsed))),
            );
          }}
        />
      </div>
      {kind === 'custom' && (
        <NumberPatternField label={label} value={value?.pattern ?? ''} onChange={setPattern} />
      )}
      {helper && <p className="text-xs text-rcd-muted">{helper}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analytics / conditional formatting editors
// ---------------------------------------------------------------------------

const COLOR_INPUT_CLASS =
  'h-6 w-8 shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0';

/** Grow-to-fit numeric input for rule/constant values (decimals allowed). */
const FLEX_NUMBER_INPUT_CLASS =
  'min-w-0 flex-1 rounded-md border border-rcd-border bg-rcd-surface px-1.5 py-1 text-sm text-rcd-text outline-none focus:border-rcd-accent';

const ADD_BUTTON_CLASS =
  'self-start rounded-md border border-rcd-border bg-rcd-surface px-2 py-1 text-xs font-medium text-rcd-text hover:bg-black/5 dark:hover:bg-white/10';

const parseNumberOr = (raw: string): number | undefined => {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const REFERENCE_KIND_OPTIONS: ReadonlyArray<{ value: ReferenceLineSpec['kind']; label: string }> = [
  { value: 'constant', label: 'Constant' },
  { value: 'average', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

const CONDITIONAL_OP_OPTIONS: ReadonlyArray<{ value: ConditionalOp; label: string }> = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
  { value: 'between', label: 'between' },
];

const CONDITIONAL_STYLE_LABELS: Record<ConditionalFormatSpec['style'], string> = {
  cellBackground: 'Cell background',
  cellText: 'Cell text',
  dataBar: 'Data bar',
  barFill: 'Bar fill',
  kpi: 'KPI value',
};

/** Styles a conditional format may target for the given chart type (invalid hidden). */
const conditionalStylesFor = (type: ChartType): ConditionalFormatSpec['style'][] => {
  if (type === 'table') return ['cellBackground', 'cellText', 'dataBar'];
  if (type === 'column' || type === 'bar') return ['barFill'];
  if (type === 'kpi') return ['kpi'];
  return [];
};

/** Compact solid/dashed/dotted select; 'solid' clears back to the default. */
function DashSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: 'solid' | 'dashed' | 'dotted' | undefined;
  onChange: (next: 'dashed' | 'dotted' | undefined) => void;
}) {
  return (
    <RcdSelect
      aria-label={label}
      className="w-20 shrink-0"
      value={value ?? 'solid'}
      onChange={(event) =>
        onChange(
          event.target.value === 'solid' ? undefined : (event.target.value as 'dashed' | 'dotted'),
        )
      }
    >
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </RcdSelect>
  );
}

/** Clamped 1-4 stroke-width input shared by the analytics rows. */
function StrokeWidthInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      min={1}
      max={4}
      aria-label={label}
      title="Line width (px)"
      placeholder="1"
      className={NUMBER_INPUT_CLASS}
      value={value ?? ''}
      onChange={(event) => {
        const parsed = parseNumberOr(event.target.value);
        onChange(parsed === undefined ? undefined : Math.min(4, Math.max(1, Math.trunc(parsed))));
      }}
    />
  );
}

function ReferenceLineRow({
  line,
  seriesKeys,
  showSecondary,
  onChange,
  onRemove,
}: {
  line: ReferenceLineSpec;
  seriesKeys: string[];
  /** Offer the "Right axis" toggle (only when secondaryAxisKeys is non-empty). */
  showSecondary: boolean;
  onChange: (partial: Partial<ReferenceLineSpec>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-rcd-border p-1.5">
      <div className="flex items-center gap-1.5">
        <RcdSelect
          aria-label="Reference line kind"
          className="w-24 shrink-0"
          value={line.kind}
          onChange={(event) =>
            onChange({ kind: event.target.value as ReferenceLineSpec['kind'] })
          }
        >
          {REFERENCE_KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </RcdSelect>
        {line.kind === 'constant' ? (
          <input
            type="number"
            step="any"
            aria-label="Reference line value"
            placeholder="Value"
            className={FLEX_NUMBER_INPUT_CLASS}
            value={line.value ?? ''}
            onChange={(event) => onChange({ value: parseNumberOr(event.target.value) })}
          />
        ) : (
          <RcdSelect
            aria-label="Reference line measure"
            className="min-w-0 flex-1"
            value={line.measureKey ?? ''}
            onChange={(event) => onChange({ measureKey: event.target.value || undefined })}
          >
            <option value="">First measure</option>
            {seriesKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </RcdSelect>
        )}
        <button
          type="button"
          aria-label="Delete reference line"
          className={RESET_BUTTON_CLASS}
          onClick={onRemove}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <RcdInput
          className="min-w-0 flex-1"
          placeholder="Label"
          aria-label="Reference line label"
          value={line.label ?? ''}
          onChange={(event) => onChange({ label: event.target.value || undefined })}
        />
        <input
          type="color"
          aria-label="Reference line color"
          className={COLOR_INPUT_CLASS}
          value={line.color ?? DEFAULT_SWATCH}
          onChange={(event) => onChange({ color: event.target.value })}
        />
        <DashSelect
          label="Reference line style"
          value={line.dash}
          onChange={(dash) => onChange({ dash })}
        />
        <StrokeWidthInput
          label="Reference line width"
          value={line.width}
          onChange={(width) => onChange({ width })}
        />
      </div>
      <div className="flex items-center gap-3">
        <CheckboxRow
          label="Show label"
          checked={line.showLabel ?? true}
          onChange={(checked) => onChange({ showLabel: checked })}
        />
        {showSecondary && (
          <CheckboxRow
            label="Right axis"
            checked={line.secondary ?? false}
            onChange={(checked) => onChange({ secondary: checked || undefined })}
          />
        )}
      </div>
    </div>
  );
}

function TrendlineRow({
  line,
  seriesKeys,
  onChange,
  onRemove,
}: {
  line: TrendlineSpec;
  seriesKeys: string[];
  onChange: (partial: Partial<TrendlineSpec>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-rcd-border p-1.5">
      <div className="flex items-center gap-1.5">
        <RcdSelect
          aria-label="Trendline kind"
          className="w-fit shrink-0"
          value={line.kind}
          onChange={(event) => onChange({ kind: event.target.value as TrendlineSpec['kind'] })}
        >
          <option value="linear">Linear</option>
          <option value="movingAverage">Moving average</option>
        </RcdSelect>
        {line.kind === 'movingAverage' && (
          <input
            type="number"
            min={2}
            max={52}
            aria-label="Moving average window"
            title="Window (buckets)"
            placeholder="3"
            className={NUMBER_INPUT_CLASS}
            value={line.window ?? ''}
            onChange={(event) => {
              const parsed = parseNumberOr(event.target.value);
              onChange({
                window:
                  parsed === undefined ? undefined : Math.min(52, Math.max(2, Math.trunc(parsed))),
              });
            }}
          />
        )}
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          aria-label="Delete trendline"
          className={RESET_BUTTON_CLASS}
          onClick={onRemove}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <RcdSelect
          aria-label="Trendline series"
          className="min-w-0 flex-1"
          value={line.seriesKey ?? ''}
          onChange={(event) => onChange({ seriesKey: event.target.value || undefined })}
        >
          <option value="">All series</option>
          {seriesKeys.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </RcdSelect>
        <input
          type="color"
          aria-label="Trendline color"
          className={COLOR_INPUT_CLASS}
          value={line.color ?? DEFAULT_SWATCH}
          onChange={(event) => onChange({ color: event.target.value })}
        />
        <DashSelect label="Trendline style" value={line.dash} onChange={(dash) => onChange({ dash })} />
        <StrokeWidthInput
          label="Trendline width"
          value={line.width}
          onChange={(width) => onChange({ width })}
        />
      </div>
    </div>
  );
}

function ConditionalFormatCard({
  item,
  styleOptions,
  seriesKeys,
  onChange,
  onRemove,
}: {
  item: ConditionalFormatSpec;
  styleOptions: ConditionalFormatSpec['style'][];
  seriesKeys: string[];
  onChange: (partial: Partial<ConditionalFormatSpec>) => void;
  onRemove: () => void;
}) {
  const measureOptions =
    item.measureKey && !seriesKeys.includes(item.measureKey)
      ? [item.measureKey, ...seriesKeys]
      : seriesKeys;
  const styles = styleOptions.includes(item.style) ? styleOptions : [item.style, ...styleOptions];

  const setRule = (index: number, partial: Partial<ConditionalRule>) =>
    onChange({
      rules: item.rules.map((rule, i) => (i === index ? { ...rule, ...partial } : rule)),
    });

  const removeRule = (index: number) =>
    onChange({ rules: item.rules.filter((_, i) => i !== index) });

  const moveRule = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= item.rules.length) return;
    const next = [...item.rules];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    onChange({ rules: next });
  };

  const addRule = () =>
    onChange({ rules: [...item.rules, { op: 'gt', value: 0, color: DEFAULT_SWATCH }] });

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-rcd-border p-1.5">
      <div className="flex items-center gap-1.5">
        <RcdSelect
          aria-label="Conditional format measure"
          className="min-w-0 flex-1"
          value={item.measureKey}
          onChange={(event) => onChange({ measureKey: event.target.value })}
        >
          {item.measureKey === '' && <option value="">Select measure…</option>}
          {measureOptions.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </RcdSelect>
        <RcdSelect
          aria-label="Conditional format style"
          className="w-fit shrink-0"
          value={item.style}
          onChange={(event) =>
            onChange({ style: event.target.value as ConditionalFormatSpec['style'] })
          }
        >
          {styles.map((style) => (
            <option key={style} value={style}>
              {CONDITIONAL_STYLE_LABELS[style]}
            </option>
          ))}
        </RcdSelect>
        <button
          type="button"
          aria-label="Delete conditional format"
          className={RESET_BUTTON_CLASS}
          onClick={onRemove}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {item.style === 'dataBar' && (
        <ColorRow
          label="Data bar color"
          value={item.dataBarColor}
          fallback={DEFAULT_SWATCH}
          onChange={(next) => onChange({ dataBarColor: next })}
        />
      )}
      <h4 className={SUBHEAD_CLASS}>Rules</h4>
      {item.rules.map((rule, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <RcdSelect
            aria-label={`Rule ${index + 1} operator`}
            className="w-fit shrink-0"
            value={rule.op}
            onChange={(event) => setRule(index, { op: event.target.value as ConditionalOp })}
          >
            {CONDITIONAL_OP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </RcdSelect>
          <input
            type="number"
            step="any"
            aria-label={`Rule ${index + 1} value`}
            placeholder="Value"
            className={FLEX_NUMBER_INPUT_CLASS}
            value={rule.value}
            onChange={(event) => setRule(index, { value: parseNumberOr(event.target.value) ?? 0 })}
          />
          {rule.op === 'between' && (
            <input
              type="number"
              step="any"
              aria-label={`Rule ${index + 1} upper value`}
              placeholder="and"
              className={FLEX_NUMBER_INPUT_CLASS}
              value={rule.value2 ?? ''}
              onChange={(event) => setRule(index, { value2: parseNumberOr(event.target.value) })}
            />
          )}
          <input
            type="color"
            aria-label={`Rule ${index + 1} color`}
            className={COLOR_INPUT_CLASS}
            value={rule.color}
            onChange={(event) => setRule(index, { color: event.target.value })}
          />
          <button
            type="button"
            aria-label={`Move rule ${index + 1} up`}
            disabled={index === 0}
            className={`${RESET_BUTTON_CLASS} disabled:opacity-30`}
            onClick={() => moveRule(index, -1)}
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            aria-label={`Move rule ${index + 1} down`}
            disabled={index === item.rules.length - 1}
            className={`${RESET_BUTTON_CLASS} disabled:opacity-30`}
            onClick={() => moveRule(index, 1)}
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            aria-label={`Delete rule ${index + 1}`}
            className={RESET_BUTTON_CLASS}
            onClick={() => removeRule(index)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" className={ADD_BUTTON_CLASS} onClick={addRule}>
        + Add rule
      </button>
      <p className="text-xs text-rcd-muted">Rules run top-to-bottom; the first match wins.</p>
    </div>
  );
}

/**
 * Minimal self-contained rich-text editor dialog, shared by the tile's inner
 * title and the rich axis titles: contentEditable plus a B/I/U/size/color
 * toolbar driven by the legacy execCommand API (deprecated but universally
 * shipped; every call is wrapped in try/catch so an engine without it degrades
 * to plain-text editing). styleWithCSS is requested first so output prefers
 * span/style over <font> tags. The live preview and the applied value both run
 * through the core sanitizeRichHtml allowlist, so nothing outside it ever
 * reaches the spec. Applying an empty editor emits undefined (clears the
 * target field).
 */
function RichTextDialog({
  title,
  initialHtml,
  onApply,
  onCancel,
}: {
  /** Dialog + aria title, e.g. "Inner title" or "X axis title". */
  title: string;
  initialHtml: string;
  onApply: (html: string | undefined) => void;
  onCancel: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(initialHtml);

  const sanitized = sanitizeRichHtml(html);
  const isEmpty = sanitized.replace(/<[^>]*>/g, '').trim() === '';

  const exec = (command: string, value?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    try {
      document.execCommand('styleWithCSS', false, 'true');
    } catch {
      /* optional — <font> fallback output is normalized by the sanitizer */
    }
    try {
      document.execCommand(command, false, value);
    } catch {
      /* execCommand unavailable — formatting off, text editing still works */
    }
    setHtml(editor.innerHTML);
  };

  const toolButton =
    'flex h-6 w-6 shrink-0 items-center justify-center rounded border border-rcd-border text-xs text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10';

  return (
    <RcdDialog
      title={title}
      open
      onClose={onCancel}
      footer={
        <>
          <RcdButton onClick={onCancel}>Cancel</RcdButton>
          <RcdButton
            variant="primary"
            onClick={() => onApply(isEmpty ? undefined : sanitized)}
          >
            Apply
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Bold"
            className={`${toolButton} font-bold`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => exec('bold')}
          >
            B
          </button>
          <button
            type="button"
            aria-label="Italic"
            className={`${toolButton} italic`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => exec('italic')}
          >
            I
          </button>
          <button
            type="button"
            aria-label="Underline"
            className={`${toolButton} underline`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => exec('underline')}
          >
            U
          </button>
          <RcdSelect
            aria-label="Font size"
            value=""
            onChange={(event) => {
              if (event.target.value !== '') exec('fontSize', event.target.value);
            }}
          >
            <option value="">Size</option>
            <option value="2">Small</option>
            <option value="3">Normal</option>
            <option value="5">Large</option>
            <option value="6">Huge</option>
          </RcdSelect>
          <input
            type="color"
            aria-label="Text color"
            defaultValue="#1f2937"
            className="h-6 w-8 shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0"
            onInput={(event) => exec('foreColor', event.currentTarget.value)}
          />
        </div>
        <div
          ref={editorRef}
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={`${title} rich text`}
          className="min-h-[5rem] rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 text-sm text-rcd-text outline-none focus:border-rcd-accent"
          onInput={(event) => setHtml(event.currentTarget.innerHTML)}
          dangerouslySetInnerHTML={{ __html: initialHtml }}
        />
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
            Preview
          </span>
          <div className="min-h-[2.5rem] rounded-md border border-dashed border-rcd-border px-2.5 py-1.5 text-sm text-rcd-text">
            {isEmpty ? (
              <span className="text-xs text-rcd-muted">
                Empty — applying clears this title.
              </span>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: sanitized }} />
            )}
          </div>
        </div>
      </div>
    </RcdDialog>
  );
}

/**
 * Plain axis-title input plus the rich-title affordances: an "aA"-pencil button
 * opening the shared RichTextDialog, a "rich" badge once html is set (the plain
 * input dims — the rich title overrides it), and a clear button removing the
 * html again.
 */
function AxisTitleField({
  axis,
  plain,
  html,
  onPlainChange,
  onEdit,
  onClear,
}: {
  /** "X" | "Y" | "Right (Y2)" — used for placeholder + aria labels. */
  axis: string;
  plain: string;
  html: string | null | undefined;
  onPlainChange: (next: string | undefined) => void;
  onEdit: () => void;
  onClear: () => void;
}) {
  const hasHtml = html != null && html !== '';
  return (
    <div className="flex items-center gap-1.5">
      <RcdInput
        className={`min-w-0 flex-1 ${hasHtml ? 'opacity-50' : ''}`}
        value={plain}
        placeholder={`${axis} axis title`}
        aria-label={`${axis} axis title`}
        title={hasHtml ? 'Rich title overrides this' : undefined}
        onChange={(event) => onPlainChange(event.target.value || undefined)}
      />
      {hasHtml && (
        <span
          className="shrink-0 rounded bg-[color-mix(in_srgb,var(--rcd-accent)_15%,transparent)] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rcd-accent"
          title="A rich title is set and overrides the plain title"
        >
          rich
        </span>
      )}
      <button
        type="button"
        aria-label={`Edit ${axis} axis rich title`}
        title="Rich title editor"
        className="flex h-6 shrink-0 items-center gap-0.5 rounded border border-rcd-border px-1.5 text-[11px] font-medium text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10"
        onClick={onEdit}
      >
        <span aria-hidden>aA</span>
        <PenLine size={10} aria-hidden />
      </button>
      {hasHtml && (
        <button
          type="button"
          aria-label={`Clear ${axis} axis rich title`}
          title="Remove the rich title"
          className={RESET_BUTTON_CLASS}
          onClick={onClear}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * Power BI-style format pane: collapsible sections over the full ChartFormat
 * contract. Every control writes the whole next ChartFormat through onChange;
 * resets remove fields so persisted specs stay minimal. The panel itself keeps
 * no format state — only which sections are expanded and which rich-text
 * dialog (inner title / axis title) is open.
 */
export function FormatPanel({ spec, seriesKeys, onChange }: FormatPanelProps) {
  const format = spec.format;
  const patch = (partial: Partial<ChartFormat>) => onChange({ ...format, ...partial });

  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set(['theme']));
  /** Which rich-text dialog is open (shared RichTextDialog instance). */
  const [richTarget, setRichTarget] = useState<'inner' | 'x' | 'y' | 'y2' | null>(null);
  /** "Custom" chosen in the table page-size select before a number is typed. */
  const [customPageSize, setCustomPageSize] = useState(false);
  /** Values section: pattern editor (live preview) vs. the plain format input. */
  const [customValueFormat, setCustomValueFormat] = useState(
    () => format.valueFormat !== undefined && /[0#;"]/.test(format.valueFormat),
  );

  const toggleSection = (id: string) =>
    setOpenSections((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sectionProps = (id: string) => ({
    open: openSections.has(id),
    onToggle: () => toggleSection(id),
  });

  const container = format.container;
  const showLegend = format.showLegend ?? seriesKeys.length >= 2;
  const legendInteractive = format.legendInteractive ?? true;
  const legendMode = format.legendMode ?? 'toggle';
  const hasAxes = !AXISLESS_TYPES.includes(spec.type);
  const horizontal = HORIZONTAL_TYPES.includes(spec.type);
  const isLineType = LINE_TYPES.includes(spec.type);
  const supportsPercent = PERCENT_TYPES.includes(spec.type);
  const supportsTooltip = spec.type !== 'kpi' && spec.type !== 'table';
  const tooltipEnabled = format.tooltip?.enabled ?? true;
  const activeTheme = format.theme ?? 'default';

  // --- Secondary (right) value axis ---
  // Cartesian combos only: pie/donut/kpi/table are axisless, scatter's two
  // measures are its X/Y — none of them can host a second value axis.
  const supportsSecondaryAxis = hasAxes && spec.type !== 'scatter';
  const secondaryKeys = format.secondaryAxisKeys ?? [];
  const hasSecondary = supportsSecondaryAxis && secondaryKeys.length > 0;
  const setSecondaryKey = (key: string, secondary: boolean) => {
    const next = secondary
      ? secondaryKeys.includes(key)
        ? secondaryKeys
        : [...secondaryKeys, key]
      : secondaryKeys.filter((existing) => existing !== key);
    patch({ secondaryAxisKeys: next.length > 0 ? next : undefined });
  };

  /** Merge + prune table options; the object itself drops once fully default. */
  const setTable = (partial: Partial<TableOptions>) => {
    const merged = { ...format.table, ...partial };
    const next: TableOptions = {};
    if (merged.columnWidths && Object.keys(merged.columnWidths).length > 0) {
      next.columnWidths = merged.columnWidths;
    }
    if (merged.columnOrder && merged.columnOrder.length > 0) next.columnOrder = merged.columnOrder;
    if (merged.pinned !== undefined && merged.pinned > 0) next.pinned = merged.pinned;
    if (merged.totals) next.totals = true;
    if (merged.pageSize != null) next.pageSize = merged.pageSize;
    if (merged.stripes) next.stripes = true;
    if (merged.sortable === false) next.sortable = false;
    if (merged.filterable === false) next.filterable = false;
    if (merged.headerAlign !== undefined && merged.headerAlign !== 'center') {
      next.headerAlign = merged.headerAlign;
    }
    if (merged.columnAlign && Object.keys(merged.columnAlign).length > 0) {
      next.columnAlign = merged.columnAlign;
    }
    if (merged.verticalAlign === 'top') next.verticalAlign = 'top';
    if (merged.borders !== undefined && merged.borders !== 'rows') next.borders = merged.borders;
    if (merged.borderColor != null) next.borderColor = merged.borderColor;
    if (merged.headerBackground != null) next.headerBackground = merged.headerBackground;
    if (merged.headerColor != null) next.headerColor = merged.headerColor;
    if (merged.headerBold === false) next.headerBold = false;
    if (merged.density !== undefined && merged.density !== 'normal') next.density = merged.density;
    if (merged.fontSize !== undefined) next.fontSize = merged.fontSize;
    patch({ table: Object.keys(next).length > 0 ? next : undefined });
  };

  /** Auto (undefined) removes the key; the map itself drops via setTable's prune. */
  const setColumnAlign = (key: string, align: 'left' | 'center' | 'right' | undefined) => {
    const next = { ...format.table?.columnAlign };
    if (align) next[key] = align;
    else delete next[key];
    setTable({ columnAlign: next });
  };

  // Table result columns for the per-column alignment editor. columnAlign is
  // keyed by result column NAME, and toWireSpec emits names positionally:
  // dimensions [axis, legend, smallMultiples] -> dim0..dimN, then measures ->
  // meas0..measN — the same names TableChart keys columnWidths/columnAlign by.
  const tableColumns: { key: string; label: string }[] = [];
  if (spec.type === 'table') {
    const dims = [spec.query.axis, spec.query.legend, spec.query.smallMultiples].filter(
      (dim): dim is NonNullable<typeof dim> => dim != null,
    );
    dims.forEach((dim, index) => {
      tableColumns.push({
        key: `dim${index}`,
        label: dim.dateBucket ? `${dim.column} (${dim.dateBucket})` : dim.column,
      });
    });
    spec.query.measures.forEach((measure, index) => {
      // Display only: alias > seriesKeys (measure display names when there is
      // no legend split) > raw column; renames via seriesLabels still apply.
      const base =
        measure.alias ??
        (spec.query.legend == null ? seriesKeys[index] : undefined) ??
        measure.column ??
        `Measure ${index + 1}`;
      tableColumns.push({ key: `meas${index}`, label: format.seriesLabels?.[base] ?? base });
    });
  }

  /** Merge + prune: drops every default-valued field, then the object itself. */
  const setContainer = (partial: Partial<ContainerStyle>) => {
    const merged = { ...container, ...partial };
    const next: ContainerStyle = {};
    if (merged.hideHeader) next.hideHeader = true;
    if (merged.background != null) next.background = merged.background;
    if (merged.borderColor != null) next.borderColor = merged.borderColor;
    if (merged.borderWidth !== undefined) next.borderWidth = merged.borderWidth;
    if (merged.borderRadius !== undefined) next.borderRadius = merged.borderRadius;
    if (merged.shadow !== undefined) next.shadow = merged.shadow;
    if (merged.innerTitleHtml != null && merged.innerTitleHtml !== '') {
      next.innerTitleHtml = merged.innerTitleHtml;
    }
    patch({ container: Object.keys(next).length > 0 ? next : undefined });
  };

  const setTooltip = (partial: Partial<TooltipStyle>) => {
    const merged = { ...format.tooltip, ...partial };
    const next: TooltipStyle = {};
    if (merged.enabled === false) next.enabled = false;
    if (merged.background != null) next.background = merged.background;
    if (merged.textColor != null) next.textColor = merged.textColor;
    if (merged.accentBorder === false) next.accentBorder = false;
    if (merged.showPercent) next.showPercent = true;
    patch({ tooltip: Object.keys(next).length > 0 ? next : undefined });
  };

  const setLineStyle = (key: string, partial: Partial<SeriesLineStyle>) => {
    const merged = { ...format.lineStyles?.[key], ...partial };
    const entry: SeriesLineStyle = {};
    if (merged.dash !== undefined && merged.dash !== 'solid') entry.dash = merged.dash;
    if (merged.width !== undefined) entry.width = merged.width;
    const map = { ...format.lineStyles };
    if (Object.keys(entry).length > 0) map[key] = entry;
    else delete map[key];
    patch({ lineStyles: Object.keys(map).length > 0 ? map : undefined });
  };

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

  const valueAxisFormat = horizontal ? format.xAxisFormat : format.yAxisFormat;
  const setValueAxisFormat = (next: AxisValueFormat | undefined) =>
    patch(horizontal ? { xAxisFormat: next } : { yAxisFormat: next });

  // --- Analytics (reference lines + trendlines) ---
  const setReferenceLine = (id: string, partial: Partial<ReferenceLineSpec>) =>
    patch({
      referenceLines: format.referenceLines?.map((line) =>
        line.id === id ? { ...line, ...partial } : line,
      ),
    });
  const removeReferenceLine = (id: string) => {
    const next = (format.referenceLines ?? []).filter((line) => line.id !== id);
    patch({ referenceLines: next.length > 0 ? next : undefined });
  };
  const addReferenceLine = () =>
    patch({
      referenceLines: [...(format.referenceLines ?? []), { id: newId(), kind: 'average' as const }],
    });

  const setTrendline = (id: string, partial: Partial<TrendlineSpec>) =>
    patch({
      trendlines: format.trendlines?.map((line) =>
        line.id === id ? { ...line, ...partial } : line,
      ),
    });
  const removeTrendline = (id: string) => {
    const next = (format.trendlines ?? []).filter((line) => line.id !== id);
    patch({ trendlines: next.length > 0 ? next : undefined });
  };
  const addTrendline = () =>
    patch({ trendlines: [...(format.trendlines ?? []), { id: newId(), kind: 'linear' as const }] });

  // --- Conditional formatting ---
  const conditionalStyles = conditionalStylesFor(spec.type);
  const setConditionalFormat = (id: string, partial: Partial<ConditionalFormatSpec>) =>
    patch({
      conditionalFormats: format.conditionalFormats?.map((item) =>
        item.id === id ? { ...item, ...partial } : item,
      ),
    });
  const removeConditionalFormat = (id: string) => {
    const next = (format.conditionalFormats ?? []).filter((item) => item.id !== id);
    patch({ conditionalFormats: next.length > 0 ? next : undefined });
  };
  const addConditionalFormat = () =>
    patch({
      conditionalFormats: [
        ...(format.conditionalFormats ?? []),
        {
          id: newId(),
          measureKey: seriesKeys[0] ?? '',
          style: conditionalStyles[0] ?? 'cellBackground',
          rules: [{ op: 'gt' as const, value: 0, color: DEFAULT_SWATCH }],
        },
      ],
    });

  // --- Small multiples (grid options; the split dimension lives on the query) ---
  const hasSmallMultiples = spec.query.smallMultiples != null;
  const setSmallMultiples = (partial: Partial<SmallMultiplesFormat>) => {
    const merged = { ...format.smallMultiples, ...partial };
    const next: SmallMultiplesFormat = {};
    if (merged.columns !== undefined && merged.columns !== 'auto') next.columns = merged.columns;
    if (merged.maxPanels !== undefined) next.maxPanels = merged.maxPanels;
    if (merged.sharedY === false) next.sharedY = false;
    if (merged.showPanelTitles === false) next.showPanelTitles = false;
    patch({ smallMultiples: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <div className="flex flex-col gap-2">
      <CollapsibleSection title="Theme" {...sectionProps('theme')}>
        <div className="grid grid-cols-2 gap-1.5">
          {THEME_OPTIONS.map(({ name, label, colors }) => {
            const selected = activeTheme === name;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={selected}
                title={label}
                className={`flex flex-col items-start gap-1 rounded-md border p-1.5 text-left transition-colors ${
                  selected
                    ? 'border-rcd-accent ring-1 ring-rcd-accent'
                    : 'border-rcd-border hover:border-rcd-accent'
                }`}
                onClick={() => patch({ theme: name === 'default' ? undefined : name })}
              >
                <span className="flex gap-0.5">
                  {colors.map((color, index) => (
                    <span
                      key={index}
                      className="h-3 w-3 rounded-sm"
                      style={{ background: color }}
                    />
                  ))}
                </span>
                <span className="text-[10px] font-medium text-rcd-text-2">{label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-rcd-muted">
          Per-series color overrides below still win over the theme.
        </p>
      </CollapsibleSection>

      <CollapsibleSection title="Container" {...sectionProps('container')}>
        <CheckboxRow
          label="Hide header"
          checked={container?.hideHeader ?? false}
          onChange={(checked) => setContainer({ hideHeader: checked })}
        />
        <ColorRow
          label="Background"
          value={container?.background}
          fallback="#ffffff"
          onChange={(next) => setContainer({ background: next })}
        />
        <ColorRow
          label="Border color"
          value={container?.borderColor}
          fallback="#d1d5db"
          onChange={(next) => setContainer({ borderColor: next })}
        />
        <NumberRow
          label="Border width"
          min={0}
          max={8}
          placeholder="1"
          value={container?.borderWidth}
          onChange={(next) => setContainer({ borderWidth: next })}
        />
        <NumberRow
          label="Corner radius"
          min={0}
          max={24}
          placeholder="8"
          value={container?.borderRadius}
          onChange={(next) => setContainer({ borderRadius: next })}
        />
        <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
          Shadow
          <RcdSelect
            className="w-32 shrink-0"
            value={container?.shadow ?? 'none'}
            onChange={(event) =>
              setContainer({
                shadow:
                  event.target.value === 'none'
                    ? undefined
                    : (event.target.value as 'sm' | 'md' | 'lg'),
              })
            }
          >
            <option value="none">None</option>
            <option value="sm">Small</option>
            <option value="md">Medium</option>
            <option value="lg">Large</option>
          </RcdSelect>
        </label>
        <TextStyleRow
          label="Title"
          value={format.titleStyle}
          onChange={(next) => patch({ titleStyle: next })}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-rcd-text-2">Inner title</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-md border border-rcd-border bg-rcd-surface px-2 py-1 text-xs font-medium text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
              onClick={() => setRichTarget('inner')}
            >
              {container?.innerTitleHtml ? 'Edit…' : 'Add…'}
            </button>
            {Boolean(container?.innerTitleHtml) && (
              <button
                type="button"
                aria-label="Clear inner title"
                className={RESET_BUTTON_CLASS}
                onClick={() => setContainer({ innerTitleHtml: undefined })}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-rcd-muted">
          Rich text rendered inside the tile, above the chart.
        </p>
      </CollapsibleSection>

      <CollapsibleSection title="Legend" {...sectionProps('legend')}>
        <CheckboxRow
          label="Show legend"
          checked={showLegend}
          onChange={(checked) => patch({ showLegend: checked })}
        />
        <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
          Position
          <RcdSelect
            className="w-32 shrink-0"
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
        <CheckboxRow
          label="Interactive legend"
          checked={legendInteractive}
          onChange={(checked) => patch({ legendInteractive: checked ? undefined : false })}
        />
        {legendInteractive && (
          <>
            <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
              Click action
              <RcdSelect
                aria-label="Legend click action"
                className="w-32 shrink-0"
                disabled={!showLegend}
                value={legendMode}
                onChange={(event) =>
                  patch({
                    legendMode:
                      event.target.value === 'toggle'
                        ? undefined
                        : (event.target.value as 'isolate' | 'crossFilter'),
                  })
                }
              >
                <option value="toggle">Toggle series</option>
                <option value="isolate">Isolate series</option>
                <option value="crossFilter">Highlight page</option>
              </RcdSelect>
            </label>
            <p className="text-xs text-rcd-muted">{LEGEND_MODE_CAPTIONS[legendMode]}</p>
          </>
        )}
        <TextStyleRow
          label="Legend text"
          value={format.legendStyle}
          onChange={(next) => patch({ legendStyle: next })}
        />
        <CheckboxRow
          label="Hover highlighting"
          checked={format.hoverHighlight ?? true}
          onChange={(checked) => patch({ hoverHighlight: checked ? undefined : false })}
        />
        <p className="text-xs text-rcd-muted">
          Hovering a data point spotlights it across the page.
        </p>
      </CollapsibleSection>

      {hasAxes && (
        <CollapsibleSection title="Axes" {...sectionProps('axes')}>
          <AxisTitleField
            axis="X"
            plain={format.xAxisLabel ?? ''}
            html={format.xAxisLabelHtml}
            onPlainChange={(next) => patch({ xAxisLabel: next })}
            onEdit={() => setRichTarget('x')}
            onClear={() => patch({ xAxisLabelHtml: undefined })}
          />
          <AxisTitleField
            axis="Y"
            plain={format.yAxisLabel ?? ''}
            html={format.yAxisLabelHtml}
            onPlainChange={(next) => patch({ yAxisLabel: next })}
            onEdit={() => setRichTarget('y')}
            onClear={() => patch({ yAxisLabelHtml: undefined })}
          />
          <TextStyleRow
            label="Axis titles"
            value={format.axisTitleStyle}
            onChange={(next) => patch({ axisTitleStyle: next })}
          />
          {spec.type === 'scatter' ? (
            <>
              <AxisFormatEditor
                label="X axis format"
                value={format.xAxisFormat}
                onChange={(next) => patch({ xAxisFormat: next })}
              />
              <AxisFormatEditor
                label="Y axis format"
                value={format.yAxisFormat}
                onChange={(next) => patch({ yAxisFormat: next })}
              />
            </>
          ) : (
            <AxisFormatEditor
              label="Value axis format"
              helper={
                horizontal
                  ? 'Horizontal chart — applies to the X (value) axis.'
                  : 'Vertical chart — applies to the Y (value) axis.'
              }
              value={valueAxisFormat}
              onChange={setValueAxisFormat}
            />
          )}
          {supportsSecondaryAxis && (
            <>
              <h4 className={SUBHEAD_CLASS}>Value axes</h4>
              {seriesKeys.length === 0 ? (
                <p className="text-xs text-rcd-muted">
                  Add measures to assign series to the left or right axis.
                </p>
              ) : (
                seriesKeys.map((key) => {
                  const onRight = secondaryKeys.includes(key);
                  return (
                    <div key={key} className="flex items-center gap-1.5">
                      <span
                        className="min-w-0 flex-1 truncate text-sm text-rcd-text-2"
                        title={key}
                      >
                        {key}
                      </span>
                      <div
                        role="group"
                        aria-label={`Value axis for ${key}`}
                        className="flex shrink-0 overflow-hidden rounded-md border border-rcd-border"
                      >
                        {(['Left', 'Right'] as const).map((side) => {
                          const active = side === 'Right' ? onRight : !onRight;
                          return (
                            <button
                              key={side}
                              type="button"
                              aria-pressed={active}
                              aria-label={`${key} on the ${side.toLowerCase()} axis`}
                              className={`px-2 py-0.5 text-[11px] font-medium transition-colors ${
                                active
                                  ? 'bg-rcd-accent text-white'
                                  : 'text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10'
                              }`}
                              onClick={() => setSecondaryKey(key, side === 'Right')}
                            >
                              {side}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
              {hasSecondary && (
                <>
                  <AxisFormatEditor
                    label="Right axis format"
                    value={format.y2AxisFormat}
                    onChange={(next) => patch({ y2AxisFormat: next })}
                  />
                  <AxisTitleField
                    axis="Right (Y2)"
                    plain={format.y2AxisLabel ?? ''}
                    html={format.y2AxisLabelHtml}
                    onPlainChange={(next) => patch({ y2AxisLabel: next })}
                    onEdit={() => setRichTarget('y2')}
                    onClear={() => patch({ y2AxisLabelHtml: undefined })}
                  />
                </>
              )}
            </>
          )}
          {spec.query.axis?.dateBucket && (
            <>
              <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
                Date labels
                <RcdSelect
                  aria-label="Date label format"
                  value={format.dateFormat ?? 'auto'}
                  onChange={(event) =>
                    patch({
                      dateFormat:
                        event.target.value === 'auto'
                          ? undefined
                          : (event.target.value as DateFormatPreset),
                    })
                  }
                >
                  {DATE_FORMAT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </RcdSelect>
              </label>
              <RcdInput
                className="min-w-0 font-mono"
                value={format.dateFormatPattern ?? ''}
                placeholder="Custom mask, e.g. MMM yyyy"
                aria-label="Custom date mask"
                onChange={(event) =>
                  patch({ dateFormatPattern: event.target.value || undefined })
                }
              />
              {Boolean(format.dateFormatPattern) && (
                <p className="font-mono text-xs text-rcd-muted">
                  Today → {safeDatePattern(new Date(), format.dateFormatPattern ?? '')}
                </p>
              )}
              <p className="text-xs text-rcd-muted">
                Mask overrides the preset. Tokens: yyyy yy MMMM MMM MM M dd d EEEE EEE Qq HH mm —
                literals in quotes.
              </p>
            </>
          )}
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Series" {...sectionProps('series')}>
        {seriesKeys.length === 0 && (
          <p className="text-xs text-rcd-muted">
            Add measures (or a legend field) to configure series.
          </p>
        )}
        {seriesKeys.length > 0 && (
          <>
            <h4 className={SUBHEAD_CLASS}>Names</h4>
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
            <h4 className={SUBHEAD_CLASS}>Colors</h4>
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
                      className={RESET_BUTTON_CLASS}
                      onClick={() => clearOverride(key)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}
        {(spec.type === 'column' || spec.type === 'bar') && (
          <>
            <CheckboxRow
              label="Color by category"
              checked={format.colorByCategory ?? false}
              onChange={(checked) => patch({ colorByCategory: checked || undefined })}
            />
            <p className="text-xs text-rcd-muted">
              Single-series charts give each bar its own palette color; color overrides then apply
              per category.
            </p>
          </>
        )}
        {isLineType && seriesKeys.length > 0 && (
          <>
            <h4 className={SUBHEAD_CLASS}>Line style</h4>
            {seriesKeys.map((key) => {
              const style = format.lineStyles?.[key];
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-rcd-text-2" title={key}>
                    {key}
                  </span>
                  <RcdSelect
                    aria-label={`Line dash for ${key}`}
                    className="w-24 shrink-0"
                    value={style?.dash ?? 'solid'}
                    onChange={(event) =>
                      setLineStyle(key, {
                        dash:
                          event.target.value === 'solid'
                            ? undefined
                            : (event.target.value as 'dashed' | 'dotted'),
                      })
                    }
                  >
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                    <option value="dotted">Dotted</option>
                  </RcdSelect>
                  <input
                    type="number"
                    min={1}
                    max={6}
                    aria-label={`Line width for ${key}`}
                    title="Stroke width (px)"
                    placeholder="2"
                    className={NUMBER_INPUT_CLASS}
                    value={style?.width ?? ''}
                    onChange={(event) => {
                      if (event.target.value === '') {
                        setLineStyle(key, { width: undefined });
                        return;
                      }
                      const parsed = Number(event.target.value);
                      setLineStyle(key, {
                        width: Number.isNaN(parsed)
                          ? undefined
                          : Math.min(6, Math.max(1, Math.trunc(parsed))),
                      });
                    }}
                  />
                </div>
              );
            })}
          </>
        )}
      </CollapsibleSection>

      {supportsTooltip && (
        <CollapsibleSection title="Tooltip" {...sectionProps('tooltip')}>
          <CheckboxRow
            label="Show tooltip"
            checked={tooltipEnabled}
            onChange={(checked) => setTooltip({ enabled: checked ? undefined : false })}
          />
          <ColorRow
            label="Background"
            disabled={!tooltipEnabled}
            value={format.tooltip?.background}
            fallback="#ffffff"
            onChange={(next) => setTooltip({ background: next })}
          />
          <ColorRow
            label="Text color"
            disabled={!tooltipEnabled}
            value={format.tooltip?.textColor}
            fallback={TEXT_SWATCH}
            onChange={(next) => setTooltip({ textColor: next })}
          />
          <CheckboxRow
            label="Series accent bar"
            disabled={!tooltipEnabled}
            checked={format.tooltip?.accentBorder ?? true}
            onChange={(checked) => setTooltip({ accentBorder: checked ? undefined : false })}
          />
          {supportsPercent && (
            <CheckboxRow
              label="Show percent of total"
              disabled={!tooltipEnabled}
              checked={format.tooltip?.showPercent ?? false}
              onChange={(checked) => setTooltip({ showPercent: checked })}
            />
          )}
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Data labels & values" {...sectionProps('labels')}>
        <CheckboxRow
          label="Show value labels"
          checked={format.showDataLabels ?? false}
          onChange={(checked) => patch({ showDataLabels: checked })}
        />
        <div className="flex flex-col gap-1 text-sm text-rcd-text-2">
          Value format
          {customValueFormat ? (
            <NumberPatternField
              label="Value format"
              value={format.valueFormat ?? ''}
              onChange={(next) => patch({ valueFormat: next || undefined })}
            />
          ) : (
            <RcdInput
              value={format.valueFormat ?? ''}
              placeholder="e.g. $ or % or #"
              aria-label="Value format"
              onChange={(event) => patch({ valueFormat: event.target.value || undefined })}
            />
          )}
        </div>
        <CheckboxRow
          label="Custom pattern"
          checked={customValueFormat}
          onChange={setCustomValueFormat}
        />
      </CollapsibleSection>

      {spec.type === 'table' && (
        <CollapsibleSection title="Table" {...sectionProps('table')}>
          <h4 className={SUBHEAD_CLASS}>Structure</h4>
          <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
            Borders
            <RcdSelect
              aria-label="Table borders"
              className="w-32 shrink-0"
              value={format.table?.borders ?? 'rows'}
              onChange={(event) =>
                setTable({ borders: event.target.value as NonNullable<TableOptions['borders']> })
              }
            >
              <option value="none">None</option>
              <option value="rows">Rows</option>
              <option value="columns">Columns</option>
              <option value="grid">Grid</option>
            </RcdSelect>
          </label>
          {(format.table?.borders ?? 'rows') !== 'none' && (
            <ColorRow
              label="Border color"
              value={format.table?.borderColor}
              fallback="#d1d5db"
              onChange={(next) => setTable({ borderColor: next })}
            />
          )}
          <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
            Density
            <RcdSelect
              aria-label="Table row density"
              className="w-32 shrink-0"
              value={format.table?.density ?? 'normal'}
              onChange={(event) =>
                setTable({ density: event.target.value as NonNullable<TableOptions['density']> })
              }
            >
              <option value="compact">Compact</option>
              <option value="normal">Normal</option>
              <option value="relaxed">Relaxed</option>
            </RcdSelect>
          </label>
          <NumberRow
            label="Body font size"
            min={8}
            max={32}
            placeholder="theme"
            value={format.table?.fontSize}
            onChange={(next) => setTable({ fontSize: next })}
          />
          <SegmentedRow
            label="Vertical align"
            options={[
              { value: 'top', label: 'Top' },
              { value: 'middle', label: 'Middle' },
            ]}
            value={format.table?.verticalAlign ?? 'middle'}
            onChange={(next) => setTable({ verticalAlign: next })}
          />

          <h4 className={SUBHEAD_CLASS}>Header</h4>
          <SegmentedRow
            label="Alignment"
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ]}
            value={format.table?.headerAlign ?? 'center'}
            onChange={(next) => setTable({ headerAlign: next })}
          />
          <CheckboxRow
            label="Bold header text"
            checked={format.table?.headerBold ?? true}
            onChange={(checked) => setTable({ headerBold: checked ? undefined : false })}
          />
          <ColorRow
            label="Header background"
            value={format.table?.headerBackground}
            fallback="#f3f4f6"
            onChange={(next) => setTable({ headerBackground: next })}
          />
          <ColorRow
            label="Header text"
            value={format.table?.headerColor}
            fallback={TEXT_SWATCH}
            onChange={(next) => setTable({ headerColor: next })}
          />

          <h4 className={SUBHEAD_CLASS}>Columns</h4>
          {tableColumns.length === 0 ? (
            <p className="text-xs text-rcd-muted">
              Add rows or values to align individual columns.
            </p>
          ) : (
            <>
              {tableColumns.map(({ key, label }) => (
                <SegmentedRow
                  key={key}
                  label={label}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'left', label: 'L' },
                    { value: 'center', label: 'C' },
                    { value: 'right', label: 'R' },
                  ]}
                  value={format.table?.columnAlign?.[key] ?? 'auto'}
                  onChange={(next) => setColumnAlign(key, next === 'auto' ? undefined : next)}
                />
              ))}
              <p className="text-xs text-rcd-muted">
                Auto aligns numbers right and text left.
              </p>
            </>
          )}

          <h4 className={SUBHEAD_CLASS}>Behavior</h4>
          <CheckboxRow
            label="Totals row"
            checked={format.table?.totals ?? false}
            onChange={(checked) => setTable({ totals: checked || undefined })}
          />
          <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
            Page size
            <RcdSelect
              aria-label="Table page size"
              className="w-32 shrink-0"
              value={
                customPageSize ||
                (format.table?.pageSize != null &&
                  !TABLE_PAGE_SIZE_PRESETS.includes(format.table.pageSize))
                  ? 'custom'
                  : format.table?.pageSize == null
                    ? ''
                    : String(format.table.pageSize)
              }
              onChange={(event) => {
                if (event.target.value === 'custom') {
                  setCustomPageSize(true);
                  return;
                }
                setCustomPageSize(false);
                setTable({
                  pageSize: event.target.value === '' ? undefined : Number(event.target.value),
                });
              }}
            >
              <option value="">None</option>
              {TABLE_PAGE_SIZE_PRESETS.map((size) => (
                <option key={size} value={String(size)}>
                  {size}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </RcdSelect>
          </label>
          {(customPageSize ||
            (format.table?.pageSize != null &&
              !TABLE_PAGE_SIZE_PRESETS.includes(format.table.pageSize))) && (
            <NumberRow
              label="Rows per page"
              min={1}
              max={10000}
              placeholder="50"
              value={format.table?.pageSize ?? undefined}
              onChange={(next) => setTable({ pageSize: next })}
            />
          )}
          <CheckboxRow
            label="Stripes"
            checked={format.table?.stripes ?? false}
            onChange={(checked) => setTable({ stripes: checked || undefined })}
          />
          <CheckboxRow
            label="Sortable"
            checked={format.table?.sortable ?? true}
            onChange={(checked) => setTable({ sortable: checked ? undefined : false })}
          />
          <CheckboxRow
            label="Column filter menus"
            checked={format.table?.filterable ?? true}
            onChange={(checked) => setTable({ filterable: checked ? undefined : false })}
          />
          <p className="text-xs text-rcd-muted">
            Excel-style filter and sort menus in each column header.
          </p>
          <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
            Pinned columns
            <RcdSelect
              aria-label="Pinned columns"
              className="w-32 shrink-0"
              value={String(format.table?.pinned ?? 0)}
              onChange={(event) =>
                setTable({
                  pinned: event.target.value === '0' ? undefined : Number(event.target.value),
                })
              }
            >
              {[0, 1, 2, 3, 4].map((count) => (
                <option key={count} value={String(count)}>
                  {count === 0 ? 'None' : count}
                </option>
              ))}
            </RcdSelect>
          </label>
          {(Object.keys(format.table?.columnWidths ?? {}).length > 0 ||
            (format.table?.columnOrder?.length ?? 0) > 0) && (
            <button
              type="button"
              className={ADD_BUTTON_CLASS}
              onClick={() => setTable({ columnWidths: undefined, columnOrder: undefined })}
            >
              Reset column layout
            </button>
          )}
          <p className="text-xs text-rcd-muted">
            Column widths and order are set by dragging directly on the table.
          </p>
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Analytics" {...sectionProps('analytics')}>
        {!hasAxes ? (
          <p className="text-xs text-rcd-muted">
            Reference lines and trendlines apply to cartesian charts only.
          </p>
        ) : (
          <>
            <h4 className={SUBHEAD_CLASS}>Reference lines</h4>
            {(format.referenceLines ?? []).map((line) => (
              <ReferenceLineRow
                key={line.id}
                line={line}
                seriesKeys={seriesKeys}
                showSecondary={hasSecondary}
                onChange={(partial) => setReferenceLine(line.id, partial)}
                onRemove={() => removeReferenceLine(line.id)}
              />
            ))}
            <button type="button" className={ADD_BUTTON_CLASS} onClick={addReferenceLine}>
              + Add reference line
            </button>
            <h4 className={SUBHEAD_CLASS}>Trendlines</h4>
            {(format.trendlines ?? []).map((line) => (
              <TrendlineRow
                key={line.id}
                line={line}
                seriesKeys={seriesKeys}
                onChange={(partial) => setTrendline(line.id, partial)}
                onRemove={() => removeTrendline(line.id)}
              />
            ))}
            <button type="button" className={ADD_BUTTON_CLASS} onClick={addTrendline}>
              + Add trendline
            </button>
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Conditional formatting" {...sectionProps('conditional')}>
        {conditionalStyles.length === 0 ? (
          <p className="text-xs text-rcd-muted">
            Conditional formatting applies to table, column/bar, and KPI charts.
          </p>
        ) : (
          <>
            {(format.conditionalFormats ?? []).map((item) => (
              <ConditionalFormatCard
                key={item.id}
                item={item}
                styleOptions={conditionalStyles}
                seriesKeys={seriesKeys}
                onChange={(partial) => setConditionalFormat(item.id, partial)}
                onRemove={() => removeConditionalFormat(item.id)}
              />
            ))}
            <button type="button" className={ADD_BUTTON_CLASS} onClick={addConditionalFormat}>
              + Add conditional format
            </button>
            {(spec.type === 'column' || spec.type === 'bar') && (
              <p className="text-xs text-rcd-muted">
                Bar fill recolors categories when a single series renders.
              </p>
            )}
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Small multiples" {...sectionProps('smallMultiples')}>
        {!hasSmallMultiples ? (
          <p className="text-xs text-rcd-muted">
            Add a field to the Small multiples well to configure the panel grid.
          </p>
        ) : (
          <>
            <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
              Columns
              <RcdSelect
                aria-label="Small multiples columns"
                className="w-32 shrink-0"
                value={
                  format.smallMultiples?.columns === undefined
                    ? 'auto'
                    : String(format.smallMultiples.columns)
                }
                onChange={(event) =>
                  setSmallMultiples({
                    columns:
                      event.target.value === 'auto' ? undefined : Number(event.target.value),
                  })
                }
              >
                <option value="auto">Auto</option>
                {[1, 2, 3, 4, 5, 6].map((count) => (
                  <option key={count} value={String(count)}>
                    {count}
                  </option>
                ))}
              </RcdSelect>
            </label>
            <NumberRow
              label="Max panels"
              min={1}
              max={48}
              placeholder="12"
              value={format.smallMultiples?.maxPanels}
              onChange={(next) => setSmallMultiples({ maxPanels: next })}
            />
            <CheckboxRow
              label="Shared Y axis"
              checked={format.smallMultiples?.sharedY ?? true}
              onChange={(checked) => setSmallMultiples({ sharedY: checked ? undefined : false })}
            />
            <CheckboxRow
              label="Panel titles"
              checked={format.smallMultiples?.showPanelTitles ?? true}
              onChange={(checked) =>
                setSmallMultiples({ showPanelTitles: checked ? undefined : false })
              }
            />
            <p className="text-xs text-rcd-muted">
              Extra panels beyond the cap are dropped with a note on the chart.
            </p>
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Live update" {...sectionProps('refresh')}>
        <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
          Refresh
          <RcdSelect
            aria-label="Live refresh interval"
            className="w-32 shrink-0"
            value={format.refreshSeconds != null ? String(format.refreshSeconds) : ''}
            onChange={(event) =>
              patch({
                refreshSeconds:
                  event.target.value === '' ? undefined : Number(event.target.value),
              })
            }
          >
            {REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </RcdSelect>
        </label>
        <p className="text-xs text-rcd-muted">
          Re-runs this chart's query on an interval while it is visible on a dashboard.
        </p>
      </CollapsibleSection>

      {richTarget !== null && (
        <RichTextDialog
          title={
            richTarget === 'inner'
              ? 'Inner title'
              : richTarget === 'x'
                ? 'X axis title'
                : richTarget === 'y'
                  ? 'Y axis title'
                  : 'Right (Y2) axis title'
          }
          initialHtml={sanitizeRichHtml(
            (richTarget === 'inner'
              ? container?.innerTitleHtml
              : richTarget === 'x'
                ? format.xAxisLabelHtml
                : richTarget === 'y'
                  ? format.yAxisLabelHtml
                  : format.y2AxisLabelHtml) ?? '',
          )}
          onApply={(next) => {
            if (richTarget === 'inner') setContainer({ innerTitleHtml: next });
            else if (richTarget === 'x') patch({ xAxisLabelHtml: next });
            else if (richTarget === 'y') patch({ yAxisLabelHtml: next });
            else patch({ y2AxisLabelHtml: next });
            setRichTarget(null);
          }}
          onCancel={() => setRichTarget(null)}
        />
      )}
    </div>
  );
}
