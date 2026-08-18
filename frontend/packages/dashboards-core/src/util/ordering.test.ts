import { describe, expect, it } from 'vitest';
import { reconcileOrder, reconcileOrderBy } from './ordering';

describe('reconcileOrder', () => {
  it('returns the items unchanged (same identity) without an order', () => {
    const items = ['A', 'B', 'C'];
    expect(reconcileOrder(undefined, items)).toBe(items);
    expect(reconcileOrder([], items)).toBe(items);
  });

  it('puts listed names first, in order', () => {
    expect(reconcileOrder(['C', 'A'], ['A', 'B', 'C'])).toEqual(['C', 'A', 'B']);
  });

  it('appends unlisted items in their current order', () => {
    expect(reconcileOrder(['D'], ['A', 'B', 'C', 'D'])).toEqual(['D', 'A', 'B', 'C']);
  });

  it('drops stale names silently', () => {
    expect(reconcileOrder(['Gone', 'B', 'AlsoGone'], ['A', 'B'])).toEqual(['B', 'A']);
  });

  it('an entirely stale order leaves the items untouched', () => {
    const items = ['A', 'B'];
    expect(reconcileOrder(['X', 'Y'], items)).toBe(items);
  });

  it('duplicate item names keep their current relative order (stable)', () => {
    // Coarse date formats can collapse two buckets onto one label; both rows
    // must survive a reorder, adjacent, in engine order.
    expect(reconcileOrder(['Jan', 'Feb'], ['Feb', 'Jan', 'Jan', 'Mar'])).toEqual([
      'Jan',
      'Jan',
      'Feb',
      'Mar',
    ]);
  });

  it('duplicate names IN THE ORDER beyond the first are ignored', () => {
    expect(reconcileOrder(['B', 'A', 'B'], ['A', 'B'])).toEqual(['B', 'A']);
  });
});

describe('reconcileOrderBy', () => {
  it('reorders objects by their key', () => {
    const rows = [
      { label: 'A', value: 1 },
      { label: 'B', value: 2 },
      { label: 'C', value: 3 },
    ];
    expect(reconcileOrderBy(['B', 'C', 'A'], rows, (r) => r.label)).toEqual([
      { label: 'B', value: 2 },
      { label: 'C', value: 3 },
      { label: 'A', value: 1 },
    ]);
  });

  it('never mutates the input array', () => {
    const rows = ['A', 'B', 'C'];
    reconcileOrderBy(['C'], rows, (r) => r);
    expect(rows).toEqual(['A', 'B', 'C']);
  });
});
