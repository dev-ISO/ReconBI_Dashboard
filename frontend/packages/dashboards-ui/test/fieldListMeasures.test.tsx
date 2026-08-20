// @vitest-environment jsdom
/**
 * THE FIELD LIST becomes a management surface — first tests it has ever had.
 *
 * Scout finding this answers: "authoring is NOT reachable from the chart
 * builder. ZERO affordance. FieldList's Measures header is a plain disclosure;
 * no '+', no menu, no pencil on measure rows." A user building a chart could
 * see a measure was wrong and had nowhere to go.
 *
 * Pinned here: the "+" and the per-row menu exist; the menu offers the same
 * actions everywhere; a scope the caller cannot write shows its actions
 * DISABLED WITH THE REASON rather than hiding them (hiding trades "why did
 * that fail?" for "why can't I see it?"); and rows carry their scope, because
 * one list now mixes a measure everybody shares with one only this user has.
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Measure, ModelDefinition } from '@recon/dashboards-core';
import { FieldList } from '../src/chart-builder/FieldList';
import {
  buildScopedMeasures,
  type MeasureScope,
  type MeasureScopeRights,
  type ScopedMeasure,
} from '../src/chart-builder/measureScopes';

const measure = (id: string, name: string): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  column: 'total',
});

const SYSTEM = measure('s1', 'Revenue');
const DASHBOARD = measure('d1', 'Units');
const PERSONAL = measure('p1', 'Scratch');

const SCOPED = buildScopedMeasures([SYSTEM], [DASHBOARD], [PERSONAL]);

/** The effective model the builder composes: all three scopes, merged. */
const MODEL: ModelDefinition = {
  version: 1,
  tables: [],
  relationships: [],
  measures: [SYSTEM, DASHBOARD, PERSONAL],
};

const writable: MeasureScopeRights = { available: true, canWrite: true, reason: null };
const locked: MeasureScopeRights = {
  available: true,
  canWrite: false,
  reason: 'This is a built-in model — only an administrator can change its measures.',
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const handlers = () => ({
  onEdit: vi.fn(),
  onDuplicate: vi.fn(),
  onDelete: vi.fn(),
  onTransfer: vi.fn(),
});

const render = (
  rights: Record<MeasureScope, MeasureScopeRights>,
  spies: ReturnType<typeof handlers>,
  extras: { onCreate?: () => void; onManage?: () => void } = {},
) => {
  act(() => {
    root.render(
      <DndContext>
        <FieldList
          model={MODEL}
          catalog={null}
          onAdd={() => {}}
          measures={{
            scoped: SCOPED,
            rights,
            handlers: spies,
            onCreate: extras.onCreate ?? (() => {}),
            onManage: extras.onManage ?? (() => {}),
          }}
        />
      </DndContext>,
    );
  });
};

const renderPlain = () => {
  act(() => {
    root.render(
      <DndContext>
        <FieldList model={MODEL} catalog={null} onAdd={() => {}} />
      </DndContext>,
    );
  });
};

const byLabel = (label: string): HTMLButtonElement => {
  const element = host.querySelector(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`No button labelled "${label}"`);
  return element as HTMLButtonElement;
};

const menuItems = (): { label: string; disabled: boolean; title: string | null }[] =>
  [...host.querySelectorAll('[role="menuitem"]')].map((item) => ({
    label: item.textContent ?? '',
    disabled: (item as HTMLButtonElement).disabled,
    title: item.getAttribute('title'),
  }));

const ALL_WRITABLE: Record<MeasureScope, MeasureScopeRights> = {
  system: writable,
  dashboard: writable,
  personal: writable,
};

describe('FieldList measure management', () => {
  it('offers a "+" and a "Manage measures…" entry when management is wired', () => {
    const onCreate = vi.fn();
    const onManage = vi.fn();
    render(ALL_WRITABLE, handlers(), { onCreate, onManage });

    act(() => byLabel('New measure').click());
    expect(onCreate).toHaveBeenCalled();

    const manage = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Manage measures'),
    )!;
    act(() => manage.click());
    expect(onManage).toHaveBeenCalled();
  });

  it('adds NOTHING when management is absent — the standalone builder is unchanged', () => {
    renderPlain();
    expect(host.querySelector('button[aria-label="New measure"]')).toBeNull();
    expect(host.querySelector('[aria-label^="Actions for"]')).toBeNull();
    expect(host.textContent).not.toContain('Manage measures');
    // Scope is a management concept; without management there is no badge.
    expect(host.textContent).not.toContain('Personal');
    // The measures themselves still render and are still draggable.
    expect(host.textContent).toContain('Revenue');
  });

  it('badges the narrower scopes and leaves System (the norm) unmarked', () => {
    render(ALL_WRITABLE, handlers());
    const badges = [...host.querySelectorAll('span[title]')]
      .map((span) => span.getAttribute('title') ?? '')
      .filter((title) => title.startsWith('Belongs to this dashboard') || title.startsWith('Your own measure'));
    expect(badges).toHaveLength(2);
    // "System" would badge nearly every row in a real model, so the ROW stays
    // unmarked — the scope SECTION says it once instead (wave 4).
    expect(
      [...host.querySelectorAll('span')].some((span) => span.textContent === 'System'),
    ).toBe(false);
  });

  it('splits measures into the three scope sections, all three always present', () => {
    render(ALL_WRITABLE, handlers());
    const headings = [...host.querySelectorAll('button[aria-expanded]')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    // Widest audience first — the same order the manager uses.
    expect(headings).toContain('System measures1');
    expect(headings).toContain('This dashboard1');
    expect(headings).toContain('My measures1');
  });

  it('an empty scope says so rather than disappearing', () => {
    act(() => {
      root.render(
        <DndContext>
          <FieldList
            model={{ ...MODEL, measures: [SYSTEM] }}
            catalog={null}
            onAdd={() => {}}
            measures={{
              scoped: buildScopedMeasures([SYSTEM], [], []),
              rights: ALL_WRITABLE,
              handlers: handlers(),
              onCreate: () => {},
              onManage: () => {},
            }}
          />
        </DndContext>,
      );
    });
    expect(host.textContent).toContain('No measures belong to this dashboard yet.');
    expect(host.textContent).toContain('None of your own yet');
  });

  it('a read-only scope explains itself on the section, not just per row', () => {
    render({ ...ALL_WRITABLE, system: locked }, handlers());
    expect(host.textContent).toContain('only an administrator can change its measures');
  });

  it('the row menu offers edit, duplicate, delete and one entry per other scope', () => {
    const spies = handlers();
    render(ALL_WRITABLE, spies);

    act(() => byLabel('Actions for Scratch').click());
    expect(menuItems().map((i) => i.label)).toEqual([
      'Edit…',
      'Duplicate',
      'Delete…',
      // Widening a personal measure is a MOVE; both other scopes are wider.
      'Move to System measures',
      'Move to This dashboard',
    ]);
  });

  it('a system measure offers COPIES outward, never a move that would break others', () => {
    render(ALL_WRITABLE, handlers());
    act(() => byLabel('Actions for Revenue').click());
    expect(menuItems().map((i) => i.label)).toEqual([
      'Edit…',
      'Duplicate',
      'Delete…',
      'Copy to This dashboard',
      'Copy to My measures',
    ]);
  });

  it('routes each menu action to the shared handler', () => {
    const spies = handlers();
    render(ALL_WRITABLE, spies);

    act(() => byLabel('Actions for Units').click());
    const duplicate = [...host.querySelectorAll('[role="menuitem"]')].find(
      (i) => i.textContent === 'Duplicate',
    )!;
    act(() => (duplicate as HTMLButtonElement).click());

    expect(spies.onDuplicate).toHaveBeenCalledTimes(1);
    const entry = spies.onDuplicate.mock.calls[0]![0] as ScopedMeasure;
    expect(entry.measure.id).toBe('d1');
    expect(entry.scope).toBe('dashboard');
    // Selecting an item closes the menu.
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('a read-only scope keeps its actions VISIBLE, disabled, with the reason', () => {
    render({ ...ALL_WRITABLE, system: locked }, handlers());

    act(() => byLabel('Actions for Revenue').click());
    const items = menuItems();
    // Viewing is still offered — read-only means read, not blind.
    expect(items[0]!.label).toBe('View…');
    expect(items[0]!.disabled).toBe(false);
    const duplicate = items.find((i) => i.label === 'Duplicate')!;
    expect(duplicate.disabled).toBe(true);
    expect(duplicate.title).toMatch(/administrator/i);
    // Copying OUT of a locked scope only writes the destination, so it stays.
    expect(items.find((i) => i.label === 'Copy to My measures')!.disabled).toBe(false);
  });

  it('a move INTO a locked scope is disabled — both ends of a move are writes', () => {
    render({ ...ALL_WRITABLE, system: locked }, handlers());
    act(() => byLabel('Actions for Units').click());
    const toSystem = menuItems().find((i) => i.label === 'Move to System measures')!;
    expect(toSystem.disabled).toBe(true);
    expect(toSystem.title).toMatch(/administrator/i);
  });
});
