/**
 * ITEMS 3 + 4 — the horizontal-bar category rail (<YAxis type="category">).
 *
 * Item 3: the rail used to be a hard-coded 110px, duplicated in the plotWidth
 * estimate, with no ellipsis and no tooltip — long row names simply vanished.
 * resolveCategoryAxisWidth measures them instead (clamped between a 40px floor
 * and min(224px, the caller's cap)), and CategoryAxisTick ellipsizes with the
 * full text on a native <title>.
 *
 * Item 4: the same axis set NO interval, so recharts fell back to
 * 'preserveEnd' and dropped interior row labels on its own heuristic.
 * categoryAxisInterval labels every row while each row band can carry a line
 * of text, and only then hands back to the thinned pattern.
 *
 * measureTickLabel has no canvas outside a browser, so widths here come from
 * its documented ~6.2px/char fallback — deterministic, which is why the
 * numeric expectations below are safe.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_AXIS_MAX_PX,
  CATEGORY_AXIS_MIN_PX,
  CategoryAxisTick,
  VERT_MIN_SLOT,
  categoryAxisInterval,
  measureTickLabel,
  resolveCategoryAxisWidth,
} from '../src/chart/axisFit';

const LONG = 'Northern Territory Regional Distribution Centre';

describe('resolveCategoryAxisWidth', () => {
  it('measures the WIDEST label and adds the tick padding', () => {
    const widest = measureTickLabel('Bergen');
    expect(resolveCategoryAxisWidth(['Oslo', 'Bergen', 'Rome'], 300)).toBe(
      Math.ceil(widest) + 16,
    );
  });

  it('never returns less than the floor, even with no labels at all', () => {
    expect(resolveCategoryAxisWidth([], 300)).toBe(CATEGORY_AXIS_MIN_PX);
    expect(resolveCategoryAxisWidth([''], 300)).toBe(CATEGORY_AXIS_MIN_PX);
    expect(resolveCategoryAxisWidth(['A'], 300)).toBe(CATEGORY_AXIS_MIN_PX);
  });

  it('clamps to the caller cap — a narrow tile keeps its plot', () => {
    expect(resolveCategoryAxisWidth([LONG], 100)).toBe(100);
    // 40% of a 200px wrap: the rail may not eat the chart.
    expect(resolveCategoryAxisWidth([LONG], 200 * 0.4)).toBe(80);
  });

  it('clamps to the 224px hard maximum however wide the cap', () => {
    expect(resolveCategoryAxisWidth([LONG.repeat(4)], 10_000)).toBe(CATEGORY_AXIS_MAX_PX);
    expect(CATEGORY_AXIS_MAX_PX).toBe(224);
  });

  it('honors the floor over the cap when the cap is absurdly small', () => {
    expect(resolveCategoryAxisWidth([LONG], 4)).toBe(CATEGORY_AXIS_MIN_PX);
    expect(resolveCategoryAxisWidth([LONG], 0)).toBe(CATEGORY_AXIS_MIN_PX);
  });

  it('grows monotonically with the longest label', () => {
    const a = resolveCategoryAxisWidth(['Oslo'], 400);
    const b = resolveCategoryAxisWidth(['Oslo', 'Oslo and Bergen'], 400);
    expect(b).toBeGreaterThan(a);
  });
});

describe('categoryAxisInterval', () => {
  it('labels EVERY row while the row band fits a line of text', () => {
    // 10 rows over 200px = 20px per band, comfortably over VERT_MIN_SLOT.
    expect(categoryAxisInterval(200, 10)).toBe(0);
  });

  it('falls back to the thinned pattern once rows are tighter than a line', () => {
    // 40 rows over 200px = 5px per band.
    expect(categoryAxisInterval(200, 40)).toBe('preserveStartEnd');
  });

  it('switches exactly at one line height per row', () => {
    expect(VERT_MIN_SLOT).toBe(13);
    expect(categoryAxisInterval(VERT_MIN_SLOT * 10, 10)).toBe(0);
    expect(categoryAxisInterval(VERT_MIN_SLOT * 10 - 1, 10)).toBe('preserveStartEnd');
  });

  it('stays thinned before the first container measure lands', () => {
    expect(categoryAxisInterval(null, 3)).toBe('preserveStartEnd');
    expect(categoryAxisInterval(200, 0)).toBe('preserveStartEnd');
    expect(categoryAxisInterval(200, -1)).toBe('preserveStartEnd');
  });
});

describe('CategoryAxisTick', () => {
  const render = (value: string, maxPx: number): string =>
    renderToStaticMarkup(
      <CategoryAxisTick x={10} y={20} payload={{ value }} maxPx={maxPx} />,
    );

  it('renders a fitting label in full, with NO tooltip', () => {
    const html = render('Oslo', 200);
    expect(html).toContain('Oslo');
    expect(html).not.toContain('<title>');
    expect(html).not.toContain('…');
  });

  it('ellipsizes an over-long label and puts the FULL text on a <title>', () => {
    const html = render(LONG, 40);
    expect(html).toContain('…');
    expect(html).toContain(`<title>${LONG}</title>`);
    expect(html).not.toMatch(new RegExp(`>${LONG}<\\/text>`));
  });

  it('anchors to the end of the rail so labels sit against the plot', () => {
    expect(render('Oslo', 200)).toContain('text-anchor="end"');
  });

  it('survives a missing payload (recharts clones ticks before data lands)', () => {
    expect(renderToStaticMarkup(<CategoryAxisTick maxPx={80} />)).toContain('<text');
  });
});
