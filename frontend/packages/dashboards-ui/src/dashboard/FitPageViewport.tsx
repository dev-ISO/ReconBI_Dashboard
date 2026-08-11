import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * "Fit to page" viewport for the VIEW-mode grid: scales the page DOWN (never
 * up past 1:1) so its full height fits the box the host gives the dashboard —
 * the whole page is visible with no vertical scrolling.
 *
 * Geometry: with s = min(1, availHeight / contentHeight), the grid renders at
 * layout width availWidth / s inside a wrapper with `transform: scale(s)`
 * (origin top-left). The scaled result is therefore exactly availWidth wide —
 * width compensation, no horizontal sliver to center away — and exactly
 * availHeight tall whenever it scales at all. react-grid-layout's
 * WidthProvider measures its container's LAYOUT width (contentRect, which CSS
 * transforms do not affect), so it lays tiles out to availWidth / s all by
 * itself; RGL row heights are width-independent, so contentHeight is stable
 * and the scale computation cannot feed back on itself.
 *
 * No scroll remains because a scroll container's scrollable overflow is
 * computed from TRANSFORMED bounding boxes: the scaled subtree contributes
 * contentHeight * s (= availHeight), not its unscaled layout height. Nothing
 * here clips (`overflow` stays visible), so tile shadows render intact.
 *
 * Re-measures via ResizeObserver on both boxes: host resizes (outer) and
 * page switches / tile add-remove / height changes (content). Inactive, the
 * wrappers are style-less passthrough divs — edit mode and the phone stack
 * never scale.
 */
export function FitPageViewport({ active, children }: { active: boolean; children: ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Last measurement: scale + the avail width the compensation is based on. */
  const [fit, setFit] = useState<{ scale: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      setFit(null);
      return;
    }
    const outer = outerRef.current;
    const content = contentRef.current;
    if (!outer || !content) return;
    const measure = () => {
      const availH = outer.clientHeight;
      const availW = outer.clientWidth;
      // Layout height — offsetHeight ignores the ancestor transform, so this
      // stays the grid's NATURAL height even while scaled.
      const naturalH = content.offsetHeight;
      const scale = availH > 0 && naturalH > 0 ? Math.min(1, availH / naturalH) : 1;
      setFit((prev) =>
        prev !== null && prev.scale === scale && prev.width === availW
          ? prev
          : { scale, width: availW },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active]);

  // width > 0 guards a transient zero-width layout pass (e.g. mid flex
  // reflow): rendering the grid at width 0/s would blank it until the next
  // measurement, whereas passing through unscaled just shows one unscaled
  // frame.
  const scaled = active && fit !== null && fit.scale < 1 && fit.width > 0;

  return (
    <div ref={outerRef} className={active ? 'h-full' : undefined}>
      <div
        style={
          scaled && fit !== null
            ? {
                width: fit.width / fit.scale,
                transform: `scale(${fit.scale})`,
                transformOrigin: 'top left',
              }
            : undefined
        }
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}
