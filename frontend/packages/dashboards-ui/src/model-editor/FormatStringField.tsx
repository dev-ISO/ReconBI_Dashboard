import { formatNumberPattern } from '@recon/dashboards-core';
import { RcdInput, RcdSelect } from '../primitives';

/** Sample values previewed under the input (positive + negative section). */
const SAMPLE_POSITIVE = 1234.5678;
const SAMPLE_NEGATIVE = -1234.5678;

/**
 * Preset patterns. Every one of these is a shape formatNumberPattern actually
 * implements: `#`/`0` placeholders, ',' grouping, '%' (×100), "quoted"
 * literals, `pos;neg` sections, and trailing commas that scale by 1000 each.
 */
const PRESETS: readonly { label: string; pattern: string }[] = [
  { label: '1,235', pattern: '#,##0' },
  { label: '1,234.57', pattern: '#,##0.00' },
  { label: '$1,234.57', pattern: '$#,##0.00' },
  { label: '$1,234.57 / ($1,234.57)', pattern: '$#,##0.00;($#,##0.00)' },
  { label: '12.3%', pattern: '#,##0.0%' },
  { label: '1.2K (thousands)', pattern: '#,##0.0,"K"' },
  { label: '1.2M (millions)', pattern: '#,##0.0,,"M"' },
];

export interface FormatStringFieldProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Excel-style number pattern editor with a preset picker and a live preview
 * rendered through the very function the grid/chart uses at runtime
 * (formatNumberPattern), so what you see here is what cells will show.
 */
export function FormatStringField({ value, onChange }: FormatStringFieldProps) {
  const trimmed = value.trim();
  const presetValue = PRESETS.some((p) => p.pattern === value) ? value : '';

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-rcd-text-2">Format string (optional)</span>
      <div className="flex gap-2">
        <RcdInput
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="#,##0.00"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono"
          aria-label="Format string"
        />
        <RcdSelect
          value={presetValue}
          onChange={(event) => {
            if (event.target.value !== '') onChange(event.target.value);
          }}
          aria-label="Format presets"
          className="w-44 shrink-0"
        >
          <option value="">Custom…</option>
          {PRESETS.map((preset) => (
            <option key={preset.pattern} value={preset.pattern}>
              {preset.label}
            </option>
          ))}
        </RcdSelect>
      </div>
      {trimmed === '' ? (
        <span className="text-xs text-rcd-muted">
          Leave empty to inherit the column's format hint. Patterns win over the hint everywhere
          the measure is rendered.
        </span>
      ) : (
        <span className="text-xs text-rcd-muted">
          Preview:{' '}
          <code className="font-mono text-rcd-text">
            {formatNumberPattern(SAMPLE_POSITIVE, value)}
          </code>{' '}
          ·{' '}
          <code className="font-mono text-rcd-text">
            {formatNumberPattern(SAMPLE_NEGATIVE, value)}
          </code>
        </span>
      )}
    </div>
  );
}
