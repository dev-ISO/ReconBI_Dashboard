// @vitest-environment jsdom
/**
 * ITEM 5 — slicer button sizing.
 *
 * Two defects, one geometry:
 *  - fill mode was `flex flex-wrap` + `flex-1 basis-24`, and flex shares the
 *    leftover width PER LINE: five pills on row 1 stayed narrow while the two
 *    that wrapped to row 2 ballooned to half the tile. A CSS grid of
 *    repeat(auto-fill, minmax(6rem, 1fr)) tracks gives every pill the same
 *    width on every row and still wraps. The fill branch also forgot
 *    items-center, which every branch now carries.
 *  - FieldParamSlicer hard-coded its own divergent padding and ignored
 *    style.buttonSize outright, so mixed slicer tiles looked mismatched. Both
 *    surfaces now go through slicerPillClasses.
 *
 * jsdom because the module under test is a React component module.
 */
import { describe, expect, it } from 'vitest';
import { slicerButtonLayout, slicerPillClasses } from '../src/dashboard/SlicerTile';

const SIZES = ['sm', 'md', 'lg'] as const;

describe('slicerPillClasses', () => {
  it('centers, clips and rounds every pill at every size', () => {
    for (const size of SIZES) {
      const classes = slicerPillClasses(size);
      expect(classes).toContain('inline-flex');
      expect(classes).toContain('items-center');
      expect(classes).toContain('justify-center');
      expect(classes).toContain('overflow-hidden');
      expect(classes).toContain('rounded-md');
      expect(classes).toContain('border');
    }
  });

  it('carries exactly one whole-name size class per size (Tailwind-scannable)', () => {
    expect(slicerPillClasses('sm')).toContain('h-6 px-2 text-xs');
    expect(slicerPillClasses('md')).toContain('h-8 px-3 text-sm');
    expect(slicerPillClasses('lg')).toContain('h-10 px-4 text-[15px]');
  });
});

describe('slicerButtonLayout', () => {
  it('fill mode is a UNIFORM auto-fill grid, never per-line flex', () => {
    const layout = slicerButtonLayout('md', 'left', true, null);
    expect(layout.group).toContain('grid');
    expect(layout.group).not.toContain('flex-wrap');
    expect(layout.gridTemplateColumns).toBe('repeat(auto-fill, minmax(6rem, 1fr))');
    // The old ragged-width culprits are gone.
    expect(layout.item).toBe('w-full min-w-0');
    expect(layout.item).not.toContain('flex-1');
    expect(layout.item).not.toContain('basis-24');
  });

  it('explicit columns keep their fixed-track grid', () => {
    const layout = slicerButtonLayout('md', 'center', false, 4);
    expect(layout.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    expect(layout.group).toContain('justify-items-center');
    expect(layout.item).toBe('max-w-full');
  });

  it('columns + fill stretches items inside their fixed tracks', () => {
    const layout = slicerButtonLayout('lg', 'right', true, 3);
    expect(layout.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    expect(layout.group).toContain('justify-items-stretch');
    expect(layout.group).not.toContain('justify-items-end');
    expect(layout.item).toBe('w-full min-w-0');
  });

  it('natural (non-fill, no columns) mode stays a wrapping flex row', () => {
    const layout = slicerButtonLayout('sm', 'right', false, null);
    expect(layout.group).toContain('flex flex-wrap');
    expect(layout.group).toContain('justify-end');
    expect(layout.gridTemplateColumns).toBeUndefined();
    expect(layout.item).toBe('max-w-full');
  });

  it('items-center rides EVERY branch (the fill branch used to omit it)', () => {
    for (const fill of [true, false]) {
      for (const columns of [null, 3]) {
        expect(slicerButtonLayout('md', 'left', fill, columns).group).toContain('items-center');
      }
    }
  });

  it('uses the size-matched gap on every branch', () => {
    const gaps = { sm: 'gap-1', md: 'gap-1.5', lg: 'gap-2' } as const;
    for (const size of SIZES) {
      for (const fill of [true, false]) {
        for (const columns of [null, 2]) {
          expect(slicerButtonLayout(size, 'left', fill, columns).group).toContain(gaps[size]);
        }
      }
    }
  });

  it('always starts content at the top of the tile body', () => {
    for (const fill of [true, false]) {
      for (const columns of [null, 2]) {
        expect(slicerButtonLayout('md', 'left', fill, columns).group).toContain('content-start');
      }
    }
  });
});
