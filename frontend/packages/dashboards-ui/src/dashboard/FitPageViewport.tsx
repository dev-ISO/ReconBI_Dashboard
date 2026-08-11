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
 * under the width compensation.
 *
 * No scroll remains because a scroll container's scrollable overflow is
 * computed from TRANSFORMED bounding boxes: the scaled subtree contributes
 * contentHeight * s (= availHeight), not its unscaled layout height. Nothing
 * here clips (`overflow` stays visible), so tile shadows render intact.
 *
 * STABILITY (the anti-shake contract). The scale must never feed back on
 * itself: a scale change resizes every chart, and if any of those resizes
 * could move the measured boxes the page oscillates forever. Three guards
 * mathematically break every such loop:
 *
 *  1. Integer metrics only — clientWidth/clientHeight/offsetHeight round to
 *     CSS pixels, so sub-pixel layout jitter reads as "no change".
 *  2. A < 1px dead-band on raw measurements: a ResizeObserver delivery whose
 *     boxes differ from the last ACCEPTED measurement by less than 1px is
 *     dropped without touching state.
 *  3. The scale is quantized to 3 decimals (floored, so the scaled page can
 *     never overflow by rounding up): equal-ish measurements always produce
 *     the SAME scale value and the memoized setState bails out.
 *
 * The host must additionally keep the measured boxes independent of anything
 * the fit result influences — DashboardView turns the grid area's scrollbar
 * off (`overflow-hidden`) and takes in-flow filter indicators out of the
 * measured column while fit is active, so applying/clearing filters can never
 * move availHeight.
 *
 * NO FIRST-PAINT FLICKER: measurement runs synchronously in useLayoutEffect,
 * so the first scale (and every `contentKey` = page-switch re-measure)
 * commits BEFORE the browser paints. Until the very first successful
 * measurement the wrapper renders `visibility: hidden` (not display:none —
 * the hidden grid must still lay out to be measurable), so an unscaled frame
 * is never painted. A transient zero-size pass (mid flex reflow, hidden tab)
 * never overwrites a good fit: the last stable scale keeps rendering.
 *
 * Inactive, the wrappers are style-less passthrough divs — edit mode and the
 * phone stack never scale.
 */

/** Scale floored to 3 decimals — never rounds UP into overflow. */
const quantizeScale = (scale: number): number => Math.min(1, Math.floor(scale * 1000) / 1000);

export function FitPageViewport({
  active,
  contentKey,
  children,
}: {
  active: boolean;
  /**
   * Identity of the measured content (the active page id). A change forces a
   * synchronous pre-paint re-measure, so page switches apply their scale
   * before the new page is ever painted — even if the ResizeObserver never
   * fires (equal-height pages) or its delivery was throttled away.
   */
  contentKey?: string | null;
  children: ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Last committed fit: quantized scale + the avail width it compensates. */
  const [fit, setFit] = useState<{ scale: number; width: number } | null>(null);
  /** Last ACCEPTED raw measurement (the < 1px dead-band compares against it). */
  const raw = useRef<{ availH: number; availW: number; naturalH: number } | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      raw.current = null;
      setFit(null);
      return;
    }
    const outer = outerRef.current;
    const content = contentRef.current;
    if (!outer || !content) return;
    const measure = (force: boolean) => {
      const availH = outer.clientHeight;
      const availW = outer.clientWidth;
      // Layout height — offsetHeight ignores the ancestor transform, so this
      // stays the grid's NATURAL height even while scaled.
      const naturalH = content.offsetHeight;
      // Transient zero-size pass: keep the last stable fit (and stay hidden
      // if there was none yet) instead of flashing an unscaled frame.
      if (availH <= 0 || availW <= 0 || naturalH <= 0) return;
      const prev = raw.current;
      if (
        !force &&
        prev !== null &&
        Math.abs(prev.availH - availH) < 1 &&
        Math.abs(prev.availW - availW) < 1 &&
        Math.abs(prev.naturalH - naturalH) < 1
      ) {
        return; // sub-pixel RO delivery: ignored — no state, no relayout
      }
      raw.current = { availH, availW, naturalH };
      const scale = quantizeScale(availH / naturalH);
      setFit((old) =>
        old !== null && old.scale === scale && old.width === availW
          ? old
          : { scale, width: availW },
      );
    };
    // Synchronous pre-paint measurement: first activation AND every page
    // switch (contentKey) re-measure before the browser paints.
    measure(true);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(outer);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, contentKey]);

  const scaled = active && fit !== null && fit.scale < 1;

  return (
    <div ref={outerRef} className={active ? 'h-full' : undefined}>
      <div
        style={
          !active
            ? undefined
            : fit === null
              ? // Pre-first-measure: laid out (measurable) but never painted.
                { visibility: 'hidden' }
              : scaled
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
