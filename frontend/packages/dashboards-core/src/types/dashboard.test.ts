import { describe, expect, it } from 'vitest';
import { dashboardAccessOf, isButtonTile, type DashboardAccess } from './dashboard';

/**
 * dashboardAccessOf must tolerate BOTH generations of older server:
 *  - pre-0.8: no myAccess at all (owner full, others view-only);
 *  - pre-0.11.1: myAccess without canMoveTiles/canDeleteContent — the two new
 *    rights normalize to the flags they were split out of, so grantees keep
 *    their pre-split abilities against a lagging backend.
 */
describe('dashboardAccessOf 0.11.1 flag fallbacks', () => {
  const base: DashboardAccess = {
    isOwner: false,
    canEdit: true,
    canEditLayout: false,
    canManagePages: false,
    canEditCharts: false,
    viaShare: true,
    viaPublish: false,
  };

  it('owner fallback (no myAccess) grants both new rights', () => {
    const access = dashboardAccessOf({ ownerIsMe: true, isShared: false });
    expect(access.canMoveTiles).toBe(true);
    expect(access.canDeleteContent).toBe(true);
  });

  it('viewer fallback (no myAccess) denies both new rights', () => {
    const access = dashboardAccessOf({ ownerIsMe: false, isShared: true });
    expect(access.canMoveTiles).toBe(false);
    expect(access.canDeleteContent).toBe(false);
    expect(access.viaPublish).toBe(true);
  });

  it('pre-0.11.1 myAccess: canMoveTiles falls back to canEditLayout', () => {
    const layoutOnly = dashboardAccessOf({
      ownerIsMe: false,
      isShared: false,
      myAccess: { ...base, canEditLayout: true },
    });
    expect(layoutOnly.canMoveTiles).toBe(true);
    expect(layoutOnly.canDeleteContent).toBe(false);
  });

  it('pre-0.11.1 myAccess: canDeleteContent falls back to canEditCharts || canManagePages', () => {
    const chartsOnly = dashboardAccessOf({
      ownerIsMe: false,
      isShared: false,
      myAccess: { ...base, canEditCharts: true },
    });
    expect(chartsOnly.canDeleteContent).toBe(true);
    expect(chartsOnly.canMoveTiles).toBe(false);

    const pagesOnly = dashboardAccessOf({
      ownerIsMe: false,
      isShared: false,
      myAccess: { ...base, canManagePages: true },
    });
    expect(pagesOnly.canDeleteContent).toBe(true);
  });

  it('0.11.1 myAccess: explicit flags pass through untouched (false stays false)', () => {
    const explicit = dashboardAccessOf({
      ownerIsMe: false,
      isShared: false,
      myAccess: { ...base, canEditLayout: true, canMoveTiles: false, canDeleteContent: true },
    });
    // The server SAID no-move despite layout rights — the fallback must not override it.
    expect(explicit.canMoveTiles).toBe(false);
    expect(explicit.canDeleteContent).toBe(true);
  });
});

describe('isButtonTile', () => {
  it('narrows only kind button with a spec present', () => {
    expect(
      isButtonTile({
        id: 't1',
        layout: { x: 0, y: 0, w: 4, h: 2 },
        kind: 'button',
        button: { html: '<p>Go</p>', targetPageId: 'p1' },
      }),
    ).toBe(true);
    expect(isButtonTile({ id: 't1', layout: { x: 0, y: 0, w: 4, h: 2 }, kind: 'button' })).toBe(false);
    expect(isButtonTile({ id: 't1', layout: { x: 0, y: 0, w: 4, h: 2 }, kind: 'text' })).toBe(false);
  });
});
