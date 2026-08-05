import type { ChartType } from '@recon/dashboards-core';

/**
 * Chart-type-aware loading placeholders + the "updating" progress bar.
 *
 * Self-contained styling: the shimmer/pulse/slide keyframes ship in a local
 * <style> element (styles/rcd.css is outside this feature's ownership), scoped
 * by rcd-cskel-* class names so nothing leaks. Theme tokens only — the bone
 * gradient mixes var(--rcd-border) with the surface so it reads correctly in
 * both themes. `prefers-reduced-motion: reduce` swaps the shimmer sweep for a
 * gentle opacity pulse and freezes the progress bar to a static strip.
 */
const SKELETON_CSS = `
@keyframes rcd-cskel-shimmer {
  0% { background-position: -300px 0; }
  100% { background-position: 300px 0; }
}
@keyframes rcd-cskel-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@keyframes rcd-cskel-slide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(410%); }
}
.rcd-cskel-bone {
  background: linear-gradient(
    90deg,
    var(--rcd-border) 30%,
    color-mix(in srgb, var(--rcd-surface) 65%, var(--rcd-border)) 50%,
    var(--rcd-border) 70%
  );
  background-size: 600px 100%;
  animation: rcd-cskel-shimmer 1.6s linear infinite;
}
.rcd-cskel-ring {
  border-color: var(--rcd-border);
  animation: rcd-cskel-pulse 1.6s ease-in-out infinite;
}
.rcd-cskel-progress {
  background: var(--rcd-accent);
  animation: rcd-cskel-slide 1.2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .rcd-cskel-bone {
    background: var(--rcd-border);
    animation: rcd-cskel-pulse 2s ease-in-out infinite;
  }
  .rcd-cskel-ring { animation: none; }
  .rcd-cskel-progress {
    animation: none;
    transform: none;
    width: 100%;
    opacity: 0.5;
  }
}
`;

function SkeletonStyles() {
  return <style>{SKELETON_CSS}</style>;
}

/** Deterministic pseudo-random extents so every tile shimmers the same shapes. */
const COLUMN_HEIGHTS = [55, 80, 40, 95, 65, 30, 75, 50];
const BAR_WIDTHS = [70, 45, 90, 55, 75, 35];
const ROW_WIDTHS = [90, 75, 85, 60, 80, 70];

/** Smooth fake polyline for line/area silhouettes (viewBox 0 0 100 40). */
const LINE_PATH = 'M0 32 C 10 28, 16 14, 26 16 S 42 30, 52 24 S 68 6, 78 10 S 92 20, 100 14';
const AREA_PATH = `${LINE_PATH} L 100 40 L 0 40 Z`;

export interface ChartLoadingSkeletonProps {
  type: ChartType;
}

/**
 * Initial-load placeholder: a shimmering silhouette of the chart type about to
 * render, so tiles read as "a bar chart is coming" instead of a gray box.
 */
export function ChartLoadingSkeleton({ type }: ChartLoadingSkeletonProps) {
  return (
    <div
      role="status"
      aria-label="Loading chart"
      className="h-full w-full overflow-hidden p-2"
    >
      <SkeletonStyles />
      <Silhouette type={type} />
    </div>
  );
}

function Silhouette({ type }: { type: ChartType }) {
  switch (type) {
    case 'bar':
    case 'stackedBar':
      return (
        <div className="flex h-full w-full flex-col justify-center gap-2">
          {BAR_WIDTHS.map((width, i) => (
            <div
              key={i}
              className="rcd-cskel-bone h-[9%] max-h-5 rounded-sm"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      );

    case 'line':
    case 'area':
      return (
        <svg
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-hidden
        >
          {type === 'area' && (
            <path d={AREA_PATH} fill="var(--rcd-border)" opacity={0.5}>
              <animate
                attributeName="opacity"
                values="0.5;0.25;0.5"
                dur="1.6s"
                repeatCount="indefinite"
              />
            </path>
          )}
          <path
            d={LINE_PATH}
            fill="none"
            stroke="var(--rcd-border)"
            strokeWidth={2.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          >
            <animate
              attributeName="opacity"
              values="1;0.45;1"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </path>
        </svg>
      );

    case 'pie':
    case 'donut':
      return (
        <div className="flex h-full w-full items-center justify-center">
          <div
            aria-hidden
            className="rcd-cskel-ring aspect-square h-[70%] max-h-40 rounded-full border-[14px]"
          />
        </div>
      );

    case 'table':
      return (
        <div className="flex h-full w-full flex-col gap-2">
          <div className="rcd-cskel-bone h-5 shrink-0 rounded-sm" />
          {ROW_WIDTHS.map((width, i) => (
            <div
              key={i}
              className="rcd-cskel-bone h-3.5 shrink-0 rounded-sm"
              style={{ width: `${width}%`, opacity: 0.8 }}
            />
          ))}
        </div>
      );

    case 'kpi':
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3">
          <div className="rcd-cskel-bone h-10 w-1/2 max-w-40 rounded-md" />
          <div className="rcd-cskel-bone h-3 w-1/3 max-w-24 rounded-sm" />
        </div>
      );

    // column / stackedColumn / scatter (and anything future) fall back to the
    // vertical-bars silhouette — the most recognizable "chart is coming" shape.
    default:
      return (
        <div className="flex h-full w-full items-end justify-center gap-2">
          {COLUMN_HEIGHTS.map((height, i) => (
            <div
              key={i}
              className="rcd-cskel-bone w-[9%] max-w-8 rounded-t-sm"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      );
  }
}

/**
 * Thin indeterminate progress strip along the tile top, shown while a fetch is
 * in flight OVER a still-rendered previous result (refresh / filter change /
 * drill). Absolutely positioned, 2px tall — zero layout shift.
 */
export function TileUpdatingBar() {
  return (
    <div
      role="status"
      aria-label="Updating chart"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
    >
      <SkeletonStyles />
      <div className="rcd-cskel-progress h-full w-1/4 rounded-full" />
    </div>
  );
}
