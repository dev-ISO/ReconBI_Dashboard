// @vitest-environment jsdom
/**
 * PIE SLICE SHARE LABELS — and, more importantly, when they REFUSE to draw.
 *
 * The ask was "show the percentage on each portion, but dynamically handle lots
 * of tiny portions and don't make a mess". So the interesting tests are the
 * suppression ones: a label is dropped when the author's share floor says so,
 * AND independently when the slice is physically too small to hold the text.
 * The second rule is what keeps a 40-slice chart readable without tuning.
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { sliceLabelRenderer } from '../src/chart/ChartRenderer';

/** A comfortable slice: a quarter of a big pie. */
const BIG = {
  cx: 200,
  cy: 200,
  midAngle: 45,
  innerRadius: 0,
  outerRadius: 160,
  percent: 0.25,
  fill: '#1f77b4',
};

const render = (options: Parameters<typeof sliceLabelRenderer>[0], props: object) =>
  sliceLabelRenderer(options)({ ...BIG, ...props }) as ReactElement<{
    children: string;
    fill: string;
    stroke: string;
    textAnchor: string;
  }> | null;

describe('slice label suppression', () => {
  it('draws a healthy slice', () => {
    const el = render({ show: true }, {});
    expect(el).not.toBeNull();
    expect(el!.props.children).toBe('25%');
  });

  it('drops slices at or below the share floor', () => {
    // Default floor is 5%.
    expect(render({ show: true }, { percent: 0.04 })).toBeNull();
    expect(render({ show: true }, { percent: 0.05 })).toBeNull();
    expect(render({ show: true }, { percent: 0.051 })).not.toBeNull();
  });

  it('honours a custom floor, including 0 meaning "label everything"', () => {
    expect(render({ show: true, minPercent: 20 }, { percent: 0.19 })).toBeNull();
    expect(render({ show: true, minPercent: 0 }, { percent: 0.06 })).not.toBeNull();
  });

  it('drops a slice too NARROW for its text even when the share allows it', () => {
    // 6% of a small pie: above the floor, but the arc at the label radius is
    // only a few px — the label would spill across its neighbours.
    expect(render({ show: true, minPercent: 0 }, { percent: 0.06, outerRadius: 30 })).toBeNull();
    // The same share on a big pie has room.
    expect(render({ show: true, minPercent: 0 }, { percent: 0.06, outerRadius: 300 })).not.toBeNull();
  });

  it('drops a slice whose RING is too thin — a hairline donut', () => {
    expect(
      render({ show: true }, { innerRadius: 150, outerRadius: 160 }),
    ).toBeNull();
    expect(
      render({ show: true }, { innerRadius: 100, outerRadius: 160 }),
    ).not.toBeNull();
  });

  it('never applies the fit rules to OUTSIDE labels — there is nothing to spill into', () => {
    expect(
      render({ show: true, minPercent: 0, position: 'outside' }, { percent: 0.06, outerRadius: 30 }),
    ).not.toBeNull();
  });

  it('rejects nonsense geometry instead of drawing NaN coordinates', () => {
    expect(render({ show: true }, { percent: undefined })).toBeNull();
    expect(render({ show: true }, { midAngle: undefined })).toBeNull();
    expect(render({ show: true }, { cx: Number.NaN })).toBeNull();
  });
});

describe('slice label ink', () => {
  it('uses dark ink on a PALE slice and white on a dark one, each with the opposite halo', () => {
    const pale = render({ show: true }, { fill: '#f2f4f7' })!;
    expect(pale.props.fill).toBe('#111827');
    expect(pale.props.stroke).toBe('#ffffff');

    const dark = render({ show: true }, { fill: '#1f2937' })!;
    expect(dark.props.fill).toBe('#ffffff');
    expect(dark.props.stroke).toBe('#111827');
  });

  it('still halos when the fill is a CSS VARIABLE whose luminance is unknowable', () => {
    // Palette defaults are var(--rcd-cat-N): the ink falls back to white, and
    // without the halo the label would vanish on a pale palette slot. This is
    // the wash-out case the halo exists for.
    const el = render({ show: true }, { fill: 'var(--rcd-cat-3)' })!;
    expect(el.props.fill).toBe('#ffffff');
    expect(el.props.stroke).toBe('#111827');
  });
});

describe('slice label formatting', () => {
  it('rounds to whole percent by default and honours decimals', () => {
    expect(render({ show: true }, { percent: 0.12345 })!.props.children).toBe('12%');
    expect(render({ show: true, decimals: 1 }, { percent: 0.12345 })!.props.children).toBe('12.3%');
    expect(render({ show: true, decimals: 2 }, { percent: 0.12345 })!.props.children).toBe('12.35%');
  });

  it('anchors outside labels away from the centre', () => {
    const right = render({ show: true, position: 'outside' }, { midAngle: 0 })!;
    const left = render({ show: true, position: 'outside' }, { midAngle: 180 })!;
    expect(right.props.textAnchor).toBe('start');
    expect(left.props.textAnchor).toBe('end');
  });
});
