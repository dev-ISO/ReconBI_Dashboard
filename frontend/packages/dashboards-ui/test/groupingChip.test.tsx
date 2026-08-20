// @vitest-environment jsdom
/**
 * THE CHIP AFFORDANCE — where value grouping is authored from.
 *
 * "Group values…" sits beside the DATE GRAIN, deliberately: both answer the
 * same question ("what should one bar MEAN?"), and that question belongs on
 * the chip, where the field already is. These tests hold the placement, the
 * write-back, and the two mutual exclusions the compiler would otherwise have
 * to reject:
 *
 *   a grouped chip has NO date grain  (they rewrite the same expression)
 *   a derived chip has neither        (it is already text, and already a rule)
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Catalog,
  ChartQuery,
  ModelDefinition,
  ValueGrouping,
} from '@recon/dashboards-core';
import { Wells, type GroupingTarget } from '../src/chart-builder/Wells';

const MODEL: ModelDefinition = {
  version: 1,
  tables: [{ schema: 'public', name: 'orders' }],
  relationships: [],
  measures: [],
  derivedFields: [
    {
      id: 'f1',
      name: 'Shipped?',
      table: 'public.orders',
      expression: 'IF(ISBLANK(public.orders.shipped_at), "No", "Yes")',
      dataType: 'text',
    },
  ],
};

const CATALOG: Catalog = {
  connection: 'demo',
  versionHash: 'x',
  fetchedAtUtc: '2026-01-01T00:00:00Z',
  tables: [
    {
      schema: 'public',
      name: 'orders',
      key: 'public.orders',
      kind: 'table',
      rowEstimate: 10,
      comment: null,
      primaryKey: [],
      uniqueConstraints: [],
      columns: [
        {
          name: 'shipped_at',
          ordinal: 0,
          rawType: 'date',
          type: 'date',
          isNullable: true,
          comment: null,
        },
      ],
    },
  ],
  foreignKeys: [],
  suggestions: [],
};

const OWNER_RULE: ValueGrouping = {
  groups: [{ label: 'No', matchBlank: true }],
  otherLabel: 'Yes',
};

let host: HTMLDivElement;
let root: Root;
let changes: ChartQuery[];
let asked: GroupingTarget[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  changes = [];
  asked = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (query: ChartQuery, wired = true): void => {
  act(() => {
    root.render(
      <DndContext>
        <Wells
          chartType="column"
          query={query}
          model={MODEL}
          catalog={CATALOG}
          onChange={(next) => changes.push(next)}
          onEditFilter={() => {}}
          onGroupValues={wired ? (target) => asked.push(target) : undefined}
        />
      </DndContext>,
    );
  });
};

const byLabel = <T extends Element>(label: string): T => {
  const node = host.querySelector<T>(`[aria-label="${label}"]`);
  if (!node) throw new Error(`no element labelled "${label}"`);
  return node;
};

const has = (label: string): boolean => host.querySelector(`[aria-label="${label}"]`) !== null;

const click = (element: Element): void => {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const dateAxis = (over: Partial<ChartQuery['axis']> = {}): ChartQuery => ({
  axis: { table: 'public.orders', column: 'shipped_at', dateBucket: 'month', ...over },
  measures: [{ table: 'public.orders', column: 'shipped_at', aggregation: 'count' }],
  filters: [],
});

describe('the "Group values…" affordance', () => {
  it('sits on an ordinary dimension chip, alongside the date grain', () => {
    render(dateAxis());
    expect(has('Group values of shipped_at')).toBe(true);
    expect(has('Date bucket for shipped_at')).toBe(true);
  });

  it('is absent when the host does not wire it', () => {
    render(dateAxis(), false);
    expect(has('Group values of shipped_at')).toBe(false);
  });

  it('asks the builder to open the editor, carrying the dimension and its label', () => {
    render(dateAxis());
    click(byLabel('Group values of shipped_at'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.dimension).toMatchObject({ column: 'shipped_at' });
    expect(asked[0]!.label).toBe('shipped_at');
  });

  it('writing a rule back CLEARS the date grain — they are the same expression', () => {
    render(dateAxis());
    click(byLabel('Group values of shipped_at'));
    act(() => asked[0]!.onApply(OWNER_RULE));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.axis).toEqual({
      table: 'public.orders',
      column: 'shipped_at',
      dateBucket: null,
      grouping: OWNER_RULE,
    });
  });

  it('clearing the rule leaves the chip an ordinary dimension again', () => {
    render(dateAxis({ dateBucket: null, grouping: OWNER_RULE }));
    click(byLabel('Edit value grouping for shipped_at'));
    act(() => asked[0]!.onApply(null));
    expect(changes[0]!.axis).toEqual({
      table: 'public.orders',
      column: 'shipped_at',
      dateBucket: null,
    });
  });
});

describe('the two mutual exclusions', () => {
  it('a GROUPED chip offers no date grain, even over a date column', () => {
    render(dateAxis({ dateBucket: null, grouping: OWNER_RULE }));
    expect(has('Date bucket for shipped_at')).toBe(false);
    // …and says how many bars it now draws.
    expect(byLabel('Edit value grouping for shipped_at').textContent).toContain('2 groups');
  });

  it('a DERIVED chip offers neither a grain nor a grouping', () => {
    render({
      axis: { table: 'public.orders', column: 'Shipped?' },
      measures: [{ table: 'public.orders', column: 'shipped_at', aggregation: 'count' }],
      filters: [],
    });
    expect(has('Date bucket for Shipped?')).toBe(false);
    expect(has('Group values of Shipped?')).toBe(false);
  });
});

describe('other wells', () => {
  it('a legend chip can be grouped too', () => {
    render({
      ...dateAxis(),
      legend: { table: 'public.orders', column: 'shipped_at' },
    });
    expect(has('Group values of shipped_at')).toBe(true);
  });
});
