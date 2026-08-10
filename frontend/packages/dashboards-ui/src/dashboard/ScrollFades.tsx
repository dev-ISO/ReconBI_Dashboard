import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Live scroll geometry of one scroll container. Drives the fade/“+N more”
 * affordances so an overflowing list never looks like a broken half-row.
 */
export interface ScrollState {
  /** Content is taller than the viewport. */
  scrollable: boolean;
  atTop: boolean;
  atBottom: boolean;
  scrollTop: number;
  /** clientHeight of the scroll viewport. */
  viewportHeight: number;
  /** scrollHeight of the scrolled content. */
  contentHeight: number;
}

const INITIAL: ScrollState = {
  scrollable: false,
  atTop: true,
  atBottom: true,
  scrollTop: 0,
  viewportHeight: 0,
  contentHeight: 0,
};

const sameState = (a: ScrollState, b: ScrollState): boolean =>
  a.scrollable === b.scrollable &&
  a.atTop === b.atTop &&
  a.atBottom === b.atBottom &&
  a.scrollTop === b.scrollTop &&
  a.viewportHeight === b.viewportHeight &&
  a.contentHeight === b.contentHeight;

/**
 * Tracks a scroll container's geometry (scroll events + ResizeObserver on the
 * viewport and its children, so content growth re-measures too). Pass a
 * `revision` that changes whenever the children are replaced, so the observer
 * re-subscribes to the new nodes.
 */
export function useScrollAffordance(
  ref: RefObject<HTMLElement | null>,
  revision: unknown = null,
): ScrollState {
  const [state, setState] = useState<ScrollState>(INITIAL);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const { scrollTop, scrollHeight, clientHeight } = element;
    const next: ScrollState = {
      scrollable: scrollHeight - clientHeight > 1,
      atTop: scrollTop <= 1,
      atBottom: scrollTop + clientHeight >= scrollHeight - 1,
      scrollTop,
      viewportHeight: clientHeight,
      contentHeight: scrollHeight,
    };
    setState((prev) => (sameState(prev, next) ? prev : next));
  }, [ref]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      // Same object identity — React bails out instead of re-rendering.
      setState(INITIAL);
      return;
    }
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    // ResizeObserver is absent in some SSR/test environments; the listener
    // alone still keeps the affordances honest while scrolling.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(element);
    for (const child of Array.from(element.children)) observer?.observe(child);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [ref, measure, revision]);

  return state;
}

export interface ScrollFadesProps {
  state: ScrollState;
  /**
   * Rows hidden below the fold; renders the “+N more” hint chip. Pass 0 to
   * show only the gradients.
   */
  moreCount?: number;
  /** Chip wording for non-row lists ("+3 more values"). */
  moreLabel?: (count: number) => string;
  /** Fade tint; defaults to the tile surface. */
  tone?: 'surface' | 'bg';
}

/**
 * Overlay affordances for a scroll container: a soft gradient at whichever
 * edge has more content, plus a "+N more" chip pinned to the bottom edge.
 * Render INSIDE a `relative` frame that wraps the scroll viewport (never
 * inside the viewport itself — it would scroll away). Purely decorative:
 * pointer-events-none so clicks reach the rows underneath.
 */
export function ScrollFades({
  state,
  moreCount = 0,
  moreLabel = (count) => `+${count} more`,
  tone = 'surface',
}: ScrollFadesProps) {
  // Literal classes (host Tailwind builds scan for full class names).
  const topFade =
    tone === 'surface'
      ? 'bg-gradient-to-b from-rcd-surface to-transparent'
      : 'bg-gradient-to-b from-rcd-bg to-transparent';
  const bottomFade =
    tone === 'surface'
      ? 'bg-gradient-to-t from-rcd-surface to-transparent'
      : 'bg-gradient-to-t from-rcd-bg to-transparent';
  const showChip = moreCount > 0 && !state.atBottom;

  return (
    <>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-4 rounded-t-md transition-opacity duration-150 ${topFade} ${
          state.scrollable && !state.atTop ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md transition-opacity duration-150 ${bottomFade} ${
          state.scrollable && !state.atBottom ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-rcd-border bg-rcd-surface px-2 py-px text-[10px] font-medium leading-4 text-rcd-muted shadow-[var(--rcd-shadow-1)] transition-opacity duration-150 ${
          showChip ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {moreLabel(Math.max(moreCount, 1))}
      </span>
    </>
  );
}
