import type { AxisLabelFit } from '@recon/dashboards-core';

/**
 * Category-axis label fitting (format.xLabelFit). Measures the rendered label
 * widths against the per-category slot width and picks the least-rotated mode
 * that keeps EVERY bucket labeled: horizontal -> angled (-35°) -> vertical.
 * 'wrap' breaks on spaces up to wrapLines; explicit modes force. When even
 * vertical labels physically collide the axis falls back to the classic
 * thinned pattern ('thin': preserveStartEnd + minTickGap) — a clean subset
 * beats an unreadable picket fence.
 */

/** Tick font used for measurement — mirrors axisTickStyle (11px) + rcd stack. */
const TICK_FONT =
  '11px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Tick text line height at fontSize 11. */
const LINE_H = 12;

/** Minimum clear gap between adjacent horizontal labels. */
const H_GAP = 6;

/**
 * Slot width below which -35° labels collide: adjacent baselines sit
 * slot·sin(35°) apart, and ~11px of clearance keeps 11px text legible.
 */
const ANGLE_MIN_SLOT = 20;

/** Vertical labels need one line height per slot. */
const VERT_MIN_SLOT = LINE_H + 1;

const ANGLE_SIN = 0.574; // sin 35°

/** Angled labels longer than this are ellipsized (caps the reserved height). */
export const ANGLE_MAX_PX = 120;

/** Vertical labels longer than this are ellipsized. */
export const VERT_MAX_PX = 80;

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Rendered width (px) of tick text; ~6.2px/char estimate when no DOM. */
export function measureTickLabel(text: string): number {
  if (measureCtx === undefined) {
    measureCtx =
      typeof document !== 'undefined'
        ? document.createElement('canvas').getContext('2d')
        : null;
  }
  if (!measureCtx) return text.length * 6.2;
  measureCtx.font = TICK_FONT;
  return measureCtx.measureText(text).width;
}

/** Ellipsize `text` to at most `maxPx` rendered pixels. */
export function truncateToWidth(text: string, maxPx: number): string {
  if (measureTickLabel(text) <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  // Binary search the longest prefix whose "prefix…" still fits.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureTickLabel(`${text.slice(0, mid)}…`) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : `${text.slice(0, lo)}…`;
}

/**
 * Greedy word wrap to `maxPx`, capped at `maxLines`; overflow past the last
 * line (or a single over-long word) ellipsizes. Always returns >= 1 line.
 */
export function wrapToWidth(text: string, maxPx: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const candidate = current === '' ? words[i]! : `${current} ${words[i]}`;
    if (current !== '' && measureTickLabel(candidate) > maxPx) {
      lines.push(current);
      current = words[i]!;
      if (lines.length === maxLines) {
        // Out of lines: everything left collapses into the dropped tail.
        current = words.slice(i).join(' ');
        break;
      }
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines) lines.push(current);
  else if (current !== '' && current !== lines[lines.length - 1]) {
    // Tail didn't fit — mark the last kept line as elided.
    lines[lines.length - 1] = truncateToWidth(`${lines[lines.length - 1]} ${current}`, maxPx);
  }
  return lines.map((line) => (measureTickLabel(line) > maxPx ? truncateToWidth(line, maxPx) : line));
}

export type FitMode = 'horizontal' | 'angled' | 'vertical' | 'wrap' | 'thin';

export interface ResolvedLabelFit {
  mode: FitMode;
  /** XAxis height (px) reserving the room the mode needs below the plot. */
  height: number;
  wrapLines: number;
  /** Horizontal px per category at the measured plot width. */
  slotWidth: number;
}

/**
 * Picks the render mode for a set of category labels in `slotWidth`-px slots.
 * 'auto' escalates by measurement; explicit modes force. Returns 'thin' (the
 * pre-existing preserveStartEnd behavior) only when nothing else can work.
 */
export function resolveLabelFit(
  labels: string[],
  slotWidth: number,
  fit: AxisLabelFit | undefined,
): ResolvedLabelFit {
  const wrapLines = Math.max(1, Math.floor(fit?.wrapLines ?? 2));
  const requested = fit?.mode ?? 'auto';
  let maxW = 0;
  for (const label of labels) {
    const w = measureTickLabel(label);
    if (w > maxW) maxW = w;
  }

  const heightFor = (mode: FitMode): number => {
    switch (mode) {
      case 'angled':
        return Math.ceil(Math.min(maxW, ANGLE_MAX_PX) * ANGLE_SIN) + 16;
      case 'vertical':
        return Math.ceil(Math.min(maxW, VERT_MAX_PX)) + 14;
      case 'wrap': {
        // Reserve only the lines actually needed (capped at wrapLines).
        let lines = 1;
        for (const label of labels) {
          const n = wrapToWidth(label, Math.max(20, slotWidth - 4), wrapLines).length;
          if (n > lines) lines = n;
          if (lines === wrapLines) break;
        }
        return lines * LINE_H + 12;
      }
      default:
        return 30; // recharts XAxis default
    }
  };

  let mode: FitMode;
  if (requested !== 'auto') {
    mode = requested;
  } else if (maxW + H_GAP <= slotWidth) {
    mode = 'horizontal';
  } else if (slotWidth >= ANGLE_MIN_SLOT) {
    mode = 'angled';
  } else if (slotWidth >= VERT_MIN_SLOT) {
    mode = 'vertical';
  } else {
    mode = 'thin';
  }
  return { mode, height: heightFor(mode), wrapLines, slotWidth };
}

interface AxisFitTickProps {
  /** Injected by recharts when it clones the tick element. */
  x?: number;
  y?: number;
  payload?: { value?: unknown };
  fit: ResolvedLabelFit;
}

/**
 * Custom XAxis tick honoring a ResolvedLabelFit. Text style mirrors
 * axisTickStyle; rotated modes anchor at the tick so labels hang below the
 * axis (angled up-left, vertical reading bottom-up), and 'wrap' renders
 * centered tspan lines.
 */
export function AxisFitTick({ x = 0, y = 0, payload, fit }: AxisFitTickProps) {
  const text = String(payload?.value ?? '');
  const common = { fontSize: 11, fill: 'var(--rcd-muted)' } as const;
  switch (fit.mode) {
    case 'angled':
      return (
        <text
          x={x}
          y={y}
          dy={6}
          textAnchor="end"
          transform={`rotate(-35 ${x} ${y + 6})`}
          {...common}
        >
          {truncateToWidth(text, ANGLE_MAX_PX)}
        </text>
      );
    case 'vertical':
      return (
        <text
          x={x}
          y={y + 4}
          dy={3}
          textAnchor="end"
          transform={`rotate(-90 ${x} ${y + 4})`}
          {...common}
        >
          {truncateToWidth(text, VERT_MAX_PX)}
        </text>
      );
    case 'wrap': {
      const lines = wrapToWidth(text, Math.max(20, fit.slotWidth - 4), fit.wrapLines);
      return (
        <text x={x} y={y} textAnchor="middle" {...common}>
          {lines.map((line, i) => (
            <tspan key={i} x={x} dy={i === 0 ? 10 : LINE_H}>
              {line}
            </tspan>
          ))}
        </text>
      );
    }
    default:
      // Forced horizontal: every bucket labeled, over-long labels ellipsized
      // to their slot instead of overlapping neighbours.
      return (
        <text x={x} y={y} dy={10} textAnchor="middle" {...common}>
          {truncateToWidth(text, Math.max(24, fit.slotWidth - 2))}
        </text>
      );
  }
}
