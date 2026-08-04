import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import {
  CATEGORICAL_SLOTS,
  CHART_THEMES,
  sanitizeRichHtml,
  type AxisValueFormat,
  type ChartFormat,
  type ChartSpec,
  type ChartThemeName,
  type ChartType,
  type ContainerStyle,
  type DateFormatPreset,
  type SeriesLineStyle,
  type TextStyle,
  type TooltipStyle,
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

/**
 * Numeric value-axis format editor: kind select + decimals (0-4). "Auto"
 * removes the whole AxisValueFormat so specs stay minimal; decimals are only
 * meaningful (and enabled) once a concrete kind is chosen.
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
    if (value?.decimals !== undefined) next.decimals = value.decimals;
    onChange(next);
  };

  const setDecimals = (decimals: number | undefined) => {
    if (kind === 'auto') return;
    const next: AxisValueFormat = { kind };
    if (decimals !== undefined) next.decimals = decimals;
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
        </RcdSelect>
        <input
          type="number"
          min={0}
          max={4}
          aria-label={`${label} decimals`}
          title="Decimal places"
          placeholder="dp"
          disabled={kind === 'auto'}
          className={NUMBER_INPUT_CLASS}
          value={value?.decimals ?? ''}
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
      {helper && <p className="text-xs text-rcd-muted">{helper}</p>}
    </div>
  );
}

/**
 * Minimal self-contained rich-text editor for the tile's inner title:
 * contentEditable plus a B/I/U/size/color toolbar driven by the legacy
 * execCommand API (deprecated but universally shipped; every call is wrapped in
 * try/catch so an engine without it degrades to plain-text editing).
 * styleWithCSS is requested first so output prefers span/style over <font>
 * tags. The live preview and the applied value both run through the core
 * sanitizeRichHtml allowlist, so nothing outside it ever reaches the spec.
 */
function InnerTitleDialog({
  initialHtml,
  onApply,
  onCancel,
}: {
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
      title="Inner title"
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
          aria-label="Inner title rich text"
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
                Empty — applying clears the inner title.
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
 * Power BI-style format pane: collapsible sections over the full ChartFormat
 * contract. Every control writes the whole next ChartFormat through onChange;
 * resets remove fields so persisted specs stay minimal. The panel itself keeps
 * no format state — only which sections are expanded and whether the inner
 * title dialog is open.
 */
export function FormatPanel({ spec, seriesKeys, onChange }: FormatPanelProps) {
  const format = spec.format;
  const patch = (partial: Partial<ChartFormat>) => onChange({ ...format, ...partial });

  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set(['theme']));
  const [innerTitleOpen, setInnerTitleOpen] = useState(false);

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
  const hasAxes = !AXISLESS_TYPES.includes(spec.type);
  const horizontal = HORIZONTAL_TYPES.includes(spec.type);
  const isLineType = LINE_TYPES.includes(spec.type);
  const supportsPercent = PERCENT_TYPES.includes(spec.type);
  const supportsTooltip = spec.type !== 'kpi' && spec.type !== 'table';
  const tooltipEnabled = format.tooltip?.enabled ?? true;
  const activeTheme = format.theme ?? 'default';

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
              onClick={() => setInnerTitleOpen(true)}
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
          checked={format.legendInteractive ?? true}
          onChange={(checked) => patch({ legendInteractive: checked ? undefined : false })}
        />
        <p className="text-xs text-rcd-muted">Clicking a legend item shows or hides its series.</p>
        <TextStyleRow
          label="Legend text"
          value={format.legendStyle}
          onChange={(next) => patch({ legendStyle: next })}
        />
      </CollapsibleSection>

      {hasAxes && (
        <CollapsibleSection title="Axes" {...sectionProps('axes')}>
          <RcdInput
            value={format.xAxisLabel ?? ''}
            placeholder="X axis title"
            aria-label="X axis title"
            onChange={(event) => patch({ xAxisLabel: event.target.value || undefined })}
          />
          <RcdInput
            value={format.yAxisLabel ?? ''}
            placeholder="Y axis title"
            aria-label="Y axis title"
            onChange={(event) => patch({ yAxisLabel: event.target.value || undefined })}
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
          {spec.query.axis?.dateBucket && (
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
            <h4 className="text-xs font-medium text-rcd-muted">Names</h4>
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
            <h4 className="text-xs font-medium text-rcd-muted">Colors</h4>
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
            <h4 className="text-xs font-medium text-rcd-muted">Line style</h4>
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
        <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
          Value format
          <RcdInput
            value={format.valueFormat ?? ''}
            placeholder="e.g. $ or % or #"
            aria-label="Value format"
            onChange={(event) => patch({ valueFormat: event.target.value || undefined })}
          />
        </label>
      </CollapsibleSection>

      <CollapsibleSection title="Live update" {...sectionProps('refresh')}>
        <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
          Refresh
          <RcdSelect
            aria-label="Live refresh interval"
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

      {innerTitleOpen && (
        <InnerTitleDialog
          initialHtml={sanitizeRichHtml(container?.innerTitleHtml ?? '')}
          onApply={(next) => {
            setContainer({ innerTitleHtml: next });
            setInnerTitleOpen(false);
          }}
          onCancel={() => setInnerTitleOpen(false)}
        />
      )}
    </div>
  );
}
