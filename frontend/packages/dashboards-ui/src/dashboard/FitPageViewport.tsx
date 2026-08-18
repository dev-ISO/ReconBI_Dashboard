import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * "Fit to page" viewport for the VIEW-mode grid: scales the page DOWN (never
 * up past 1:1) so its full height fits the box the host gives the dashboard —
 * the whole page is visible with no vertical scrolling.
 *
 * WHY `zoom` AND NOT `transform: scale()` (the blurry-text fix): Blink keeps
 * a transformed subtree's glyph geometry at its PRE-transform size and
 * disables subpixel/LCD antialiasing inside it, then scales the raster — a
 * fractional scale (which fit mode almost always produces) therefore renders
 * every glyph slightly soft, and the muted greys lose stem weight into
 * illegibility. CSS `zoom` scales USED VALUES during layout instead: fonts,
 * boxes and SVG lay out and paint at their true final size, with hinting and
 * subpixel AA intact — a zoomed page is exactly as sharp as an unzoomed one.
 * (The print pipeline keeps its per-block transform: print rasterizes the
 * vector output itself, so it was never blurry and is not ours to touch.)
 *
 * GEOMETRY under zoom — the unit model every measurement below relies on
 * (standardized CSS zoom: Chrome/Edge 126+, Safari 17+, Firefox 126+):
 *
 *  - `zoom: s` on the wrapper multiplies its contents' used lengths by s for
 *    rendering and correspondingly DIVIDES the containing-block size the
 *    contents see: a plain block wrapper lays out s-times wider in its own
 *    CSS px (availWidth / s) and renders exactly availWidth wide. The width
 *    compensation the transform version needed an explicit
 *    `width: availWidth / scale` for now falls out of zoom itself — no width
 *    style at all. react-grid-layout's WidthProvider measures its container's
 *    own-coordinate-space layout width, so it lays tiles out to availWidth / s
 *    all by itself; RGL row heights are width-independent, so the natural
 *    height is stable under the compensation.
 *  - offsetWidth/offsetHeight (and scrollHeight) of elements INSIDE the
 *    zoomed subtree are reported in the element's OWN coordinate space — the
 *    same "natural layout px" offsetHeight returned under the transform, so
 *    no zoom-reset measurement pass is needed. The RENDERED height is
 *    offsetHeight × s, so the fit condition naturalH × s ≤ availH yields the
 *    SAME formula as before: s = availH / naturalH, with availH read from the
 *    UNZOOMED outer box in page px.
 *  - getBoundingClientRect() inside the subtree still returns VISUAL page px
 *    (zoom applied), exactly as under transform — portal/menu anchoring
 *    elsewhere in the library keeps its invariant unchanged.
 *  - Unlike a transform, zoom participates in layout: the wrapper's own
 *    border box is naturalH × s tall, so ancestors see the true rendered
 *    size directly (no reliance on transformed-overflow arithmetic) and no
 *    scroll can appear while the fit holds. Nothing here clips (`overflow`
 *    stays visible), so tile shadows render intact.
 *
 * STABILITY (the anti-shake contract). The scale must never feed back on
 * itself: a scale change resizes every chart, and if any of those resizes
 * could move the measured boxes the page oscillates forever. Zoom sharpens
 * the concern: BECAUSE it re-lays-out the content (that is exactly why it is
 * sharp), naturalH can genuinely shift a little when s changes — per-length
 * px snapping in the zoomed space, plus text re-wrapping at the compensated
 * width. Five guards mathematically break every such loop:
 *
 *  1. Integer metrics only — clientWidth/clientHeight/offsetHeight round to
 *     CSS pixels, so sub-pixel layout jitter reads as "no change".
 *  2. A < 1px dead-band on the AVAILABLE box: a ResizeObserver delivery whose
 *     outer box differs from the last ACCEPTED measurement by less than 1px
 *     is dropped without touching state.
 *  3. Hysteresis on the natural height: deltas under 4px are zoom rounding /
 *     re-wrap noise, not real content change, and never re-fit. (Worst case
 *     the page runs ~4px past its box — invisible next to tile padding, and
 *     strictly better than shaking.)
 *  4. An iteration cap: at most 2 naturalH-driven re-fits per settle window
 *     while the available box is unchanged. A real feedback loop (naturalH
 *     moving ≥ 4px in response to our own zoom change) freezes on its current
 *     scale within two steps instead of chasing itself; one deferred
 *     catch-up re-measure at the end of the window picks up any REAL content
 *     growth (async chart loads) that landed while frozen, so the fit is
 *     always eventually correct — and a true bistable oscillator decays to
 *     at most one flip per window instead of shaking every frame.
 *  5. The scale is quantized to 3 decimals (floored, so the zoomed page can
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

/** Guard 3: naturalH deltas under this are zoom noise, never a re-fit. */
const NATURAL_H_HYSTERESIS_PX = 4;
/** Guard 4: naturalH-driven re-fits allowed per settle window. */
const MAX_REFITS_PER_WINDOW = 2;
/** Guard 4: quiet time that ends a feedback burst (and delays catch-up). */
const SETTLE_WINDOW_MS = 600;

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
  /** Last committed fit: the quantized zoom factor (null until measured). */
  const [fit, setFit] = useState<number | null>(null);
  /** Last ACCEPTED raw measurement (guards 2–3 compare against it). */
  const raw = useRef<{ availH: number; availW: number; naturalH: number } | null>(null);
  /** Guard-4 bookkeeping: naturalH-driven re-fits in the current window. */
  const refits = useRef({ count: 0, last: 0 });

  useLayoutEffect(() => {
    if (!active) {
      raw.current = null;
      refits.current = { count: 0, last: 0 };
      setFit(null);
      return;
    }
    const outer = outerRef.current;
    const content = contentRef.current;
    if (!outer || !content) return;
    let catchUpTimer: number | null = null;

    const measure = (force: boolean) => {
      const availH = outer.clientHeight;
      const availW = outer.clientWidth;
      // Natural layout height in the content's OWN coordinate space — under
      // an ancestor `zoom`, offsetHeight stays in unzoomed own-space units
      // (see the unit model above), so this is the grid's natural height at
      // the compensated width regardless of the currently applied zoom.
      const naturalH = content.offsetHeight;
      // Transient zero-size pass: keep the last stable fit (and stay hidden
      // if there was none yet) instead of flashing an unscaled frame.
      if (availH <= 0 || availW <= 0 || naturalH <= 0) return;
      const prev = raw.current;
      const availChanged =
        prev === null ||
        Math.abs(prev.availH - availH) >= 1 ||
        Math.abs(prev.availW - availW) >= 1;
      if (force || availChanged) {
        // External trigger (activation, page switch, host resize): a fresh
        // settle window starts — the cap only meters SELF-inflicted re-fits.
        refits.current = { count: 0, last: 0 };
      } else {
        // naturalH-only delivery: the one path our own zoom change can feed.
        if (Math.abs(prev.naturalH - naturalH) < NATURAL_H_HYSTERESIS_PX) {
          return; // guards 2+3: sub-hysteresis — no state, no relayout
        }
        const now = Date.now();
        if (now - refits.current.last > SETTLE_WINDOW_MS) refits.current.count = 0;
        if (refits.current.count >= MAX_REFITS_PER_WINDOW) {
          // Guard 4 tripped: treat this as feedback. Freeze the scale but
          // ACCEPT the measurement (so the hysteresis baseline tracks
          // reality), and schedule one catch-up at the end of the window —
          // genuine content growth that landed while frozen still gets its
          // re-fit once the loop has had time to die down.
          raw.current = { availH, availW, naturalH };
          if (catchUpTimer === null) {
            catchUpTimer = window.setTimeout(() => {
              catchUpTimer = null;
              measure(true);
            }, SETTLE_WINDOW_MS);
          }
          return;
        }
        refits.current.count += 1;
        refits.current.last = now;
      }
      raw.current = { availH, availW, naturalH };
      const scale = quantizeScale(availH / naturalH);
      setFit((old) => (old === scale ? old : scale));
    };
    // Synchronous pre-paint measurement: first activation AND every page
    // switch (contentKey) re-measure before the browser paints.
    measure(true);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(outer);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (catchUpTimer !== null) window.clearTimeout(catchUpTimer);
    };
  }, [active, contentKey]);

  const scaled = active && fit !== null && fit < 1;

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
                ? // The zoom does ALL the work: contents lay out at
                  // availW / fit of their own px (width compensation) and
                  // paint at exactly availW × availH — see the unit model in
                  // the header comment. At fit === 1 the style is omitted
                  // entirely: the unscaled page renders with zero wrappers'
                  // worth of side effects (fast path).
                  { zoom: fit }
                : undefined
        }
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}
