/**
 * THE SCOPE GATE — the first tests this surface has ever had.
 *
 * Two failures this pins, both of them real:
 *
 *  1. The model editor let ANYONE edit a measure on a built-in (system-owned)
 *     model. The row looked live, the edit applied locally, and the save came
 *     back 403 — the work was gone and the reason was a toast. The gate now
 *     mirrors DataModelService.UpdateAsync, including the administrator
 *     carve-out that genuinely can write a system model's measures.
 *
 *  2. Two measures sharing a NAME break every model expression that says
 *     [ThatName] — model-wide, not just in the scope that owns them — and two
 *     sharing an ID make the engine resolve the wrong one. The scope builder
 *     detects both across scopes, which is the only place the server's own
 *     validator cannot look (a dashboard/personal measure is not in the stored
 *     model).
 */
import { describe, expect, it } from 'vitest';
import type { ChartSpec, Measure } from '@recon/dashboards-core';
import {
  buildScopedMeasures,
  measureUsageCount,
  measuresOfScopes,
  otherScopes,
  scopeOfMeasure,
  scopeRights,
  type MeasureScopeContext,
} from '../src/chart-builder/measureScopes';
import { transferVerb } from '../src/chart-builder/measureActions';

const measure = (id: string, name: string): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  column: 'total',
});

const context = (over: Partial<MeasureScopeContext> = {}): MeasureScopeContext => ({
  model: { isSystem: false, ownerIsMe: true },
  canManageShared: false,
  dashboard: { canEditLayout: true },
  ...over,
});

describe('scopeRights — System', () => {
  it('a built-in model is READ-ONLY for an ordinary user, with a reason', () => {
    const rights = scopeRights('system', context({ model: { isSystem: true, ownerIsMe: false } }));
    expect(rights.available).toBe(true);
    expect(rights.canWrite).toBe(false);
    expect(rights.reason).toMatch(/administrator/i);
  });

  it('a built-in model IS writable for an administrator (the backend carve-out)', () => {
    const rights = scopeRights(
      'system',
      context({ model: { isSystem: true, ownerIsMe: false }, canManageShared: true }),
    );
    expect(rights.canWrite).toBe(true);
    expect(rights.reason).toBeNull();
  });

  it('owning a normal model is enough', () => {
    expect(scopeRights('system', context()).canWrite).toBe(true);
  });

  it("someone else's normal model is read-only unless you are an admin", () => {
    const stranger = context({ model: { isSystem: false, ownerIsMe: false } });
    expect(scopeRights('system', stranger).canWrite).toBe(false);
    expect(scopeRights('system', stranger).reason).toMatch(/owner/i);
    expect(scopeRights('system', { ...stranger, canManageShared: true }).canWrite).toBe(true);
  });

  it('an unloaded model offers nothing — never a silently editable row', () => {
    const rights = scopeRights('system', context({ model: null }));
    expect(rights.available).toBe(false);
    expect(rights.canWrite).toBe(false);
  });
});

describe('scopeRights — Dashboard and Personal', () => {
  it('dashboard writes need the layout right', () => {
    expect(scopeRights('dashboard', context()).canWrite).toBe(true);
    const viewer = scopeRights('dashboard', context({ dashboard: { canEditLayout: false } }));
    expect(viewer.canWrite).toBe(false);
    expect(viewer.reason).toMatch(/permission/i);
  });

  it('no dashboard open = the scope has no home', () => {
    const rights = scopeRights('dashboard', context({ dashboard: null }));
    expect(rights.available).toBe(false);
    expect(rights.reason).toMatch(/Open a dashboard/i);
  });

  it('personal measures are always yours to write — no server, no permission', () => {
    const rights = scopeRights(
      'personal',
      context({ model: null, dashboard: null, canManageShared: false }),
    );
    expect(rights).toEqual({ available: true, canWrite: true, reason: null });
  });
});

describe('buildScopedMeasures', () => {
  it('tags each measure with its scope, widest first (the engine order)', () => {
    const scoped = buildScopedMeasures(
      [measure('s1', 'Revenue')],
      [measure('d1', 'Units')],
      [measure('p1', 'Scratch')],
    );
    expect(scoped.map((e) => [e.measure.id, e.scope])).toEqual([
      ['s1', 'system'],
      ['d1', 'dashboard'],
      ['p1', 'personal'],
    ]);
    expect(scoped.every((e) => !e.shadowedById && !e.duplicateName)).toBe(true);
  });

  it('flags a NAME shared across scopes — [refs] cannot tell them apart', () => {
    const scoped = buildScopedMeasures([measure('s1', 'Revenue')], [measure('d1', 'revenue')], []);
    expect(scoped.map((e) => e.duplicateName)).toEqual([true, true]);
  });

  it('flags the narrower measure when an ID is reused, and drops it from the effective set', () => {
    const scoped = buildScopedMeasures([measure('m1', 'Revenue')], [measure('m1', 'Other')], []);
    expect(scoped.map((e) => e.shadowedById)).toEqual([false, true]);
    // The engine resolves the FIRST id match, so the effective list must too.
    expect(measuresOfScopes(scoped).map((m) => m.name)).toEqual(['Revenue']);
  });

  it('scopeOfMeasure answers where a measure lives, and null for a stranger', () => {
    const scoped = buildScopedMeasures([], [measure('d1', 'Units')], []);
    expect(scopeOfMeasure(scoped, 'd1')).toBe('dashboard');
    expect(scopeOfMeasure(scoped, 'zzz')).toBeNull();
  });
});

describe('transferVerb — widening promotes, narrowing forks', () => {
  it('widening is a MOVE (id preserved, charts keep resolving)', () => {
    expect(transferVerb('personal', 'dashboard')).toBe('move');
    expect(transferVerb('personal', 'system')).toBe('move');
    expect(transferVerb('dashboard', 'system')).toBe('move');
  });

  it('narrowing is a COPY (the original stays for everything that depends on it)', () => {
    expect(transferVerb('system', 'dashboard')).toBe('copy');
    expect(transferVerb('system', 'personal')).toBe('copy');
    expect(transferVerb('dashboard', 'personal')).toBe('copy');
  });

  it('every scope offers exactly the other two as targets', () => {
    expect(otherScopes('system')).toEqual(['dashboard', 'personal']);
    expect(otherScopes('dashboard')).toEqual(['system', 'personal']);
    expect(otherScopes('personal')).toEqual(['system', 'dashboard']);
  });
});

describe('measureUsageCount', () => {
  const chart = (ids: string[]): ChartSpec => ({
    id: 'c1',
    type: 'column',
    title: 'T',
    query: { measures: ids.map((measureId) => ({ measureId })), filters: [] },
    format: {},
  });

  it('counts the refs the chart being edited holds', () => {
    expect(measureUsageCount(chart(['m1', 'm2', 'm1']), 'm1')).toBe(2);
    expect(measureUsageCount(chart(['m2']), 'm1')).toBe(0);
  });
});
