// @vitest-environment jsdom
/**
 * DERIVED FIELDS in the builder.
 *
 * The architectural decision this wave rests on is that a derived field is a
 * VIRTUAL COLUMN OF ITS TABLE, not a new shape of dimension. These tests hold
 * the two ends of that:
 *
 *  - the FIELD LIST files it exactly where a column of that table goes, in
 *    every grouping mode, with the wave-4 TEXT colour and a scope badge;
 *  - the WELLS refuse it into Values before the drop, because a row-level
 *    label has nothing to aggregate — and refuse it a date grain, because it
 *    is already text.
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Catalog,
  ChartQuery,
  DerivedField,
  ModelDefinition,
} from '@recon/dashboards-core';
import { FieldList } from '../src/chart-builder/FieldList';
import { buildFieldColumnGroups, groupRows } from '../src/chart-builder/fieldGroups';
import { canAccept, applyDrop, moveChip } from '../src/chart-builder/wellConfig';
import {
  buildScopedDerivedFields,
  derivedFieldsOfScopes,
  derivedUsageCount,
} from '../src/chart-builder/derivedFieldActions';
import type { MeasureScope, MeasureScopeRights } from '../src/chart-builder/measureScopes';

const field = (id: string, name: string, over: Partial<DerivedField> = {}): DerivedField => ({
  id,
  name,
  table: 'public.orders',
  expression: 'IF(ISBLANK(public.orders.shipped_at), "No", "Yes")',
  dataType: 'text',
  ...over,
});

const SYSTEM = field('f-sys', 'Shipped?');
const DASHBOARD = field('f-dash', 'Late?', { expression: 'IF(1 = 1, "a", "b")' });
const PERSONAL = field('f-me', 'Scratch field', { expression: 'IF(2 = 2, "a", "b")' });

const SCOPED = buildScopedDerivedFields([SYSTEM], [DASHBOARD], [PERSONAL]);

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
      primaryKey: [],
      uniqueConstraints: [],
    },
  ],
  foreignKeys: [],
  suggestions: [],
};

const MODEL: ModelDefinition = {
  version: 1,
  tables: [{ schema: 'public', name: 'orders' }],
  relationships: [],
  measures: [],
  derivedFields: [SYSTEM, DASHBOARD, PERSONAL],
};

const writable: MeasureScopeRights = { available: true, canWrite: true, reason: null };
const ALL_WRITABLE: Record<MeasureScope, MeasureScopeRights> = {
  system: writable,
  dashboard: writable,
  personal: writable,
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

const render = (onCreate = vi.fn()) => {
  act(() => {
    root.render(
      <DndContext>
        <FieldList
          model={MODEL}
          catalog={CATALOG}
          onAdd={() => {}}
          derived={{
            scoped: SCOPED,
            rights: ALL_WRITABLE,
            handlers: {
              onEdit: vi.fn(),
              onDuplicate: vi.fn(),
              onDelete: vi.fn(),
              onTransfer: vi.fn(),
            },
            onCreate,
          }}
        />
      </DndContext>,
    );
  });
  return onCreate;
};

const rowLabels = (): string[] =>
  [...host.querySelectorAll('[data-testid="rcd-field-list"] button')]
    .map((b) => b.textContent ?? '')
    .filter((text) => text !== '');

describe('the field list', () => {
  it('lists a derived field from every scope beside the real columns of its table', () => {
    render();
    const text = host.textContent ?? '';
    expect(text).toContain('Shipped?');
    expect(text).toContain('Late?');
    expect(text).toContain('Scratch field');
    expect(text).toContain('shipped_at');
  });

  it('badges the narrower scopes, and marks a system one simply as a field', () => {
    render();
    const badges = [...host.querySelectorAll('span[title]')]
      .map((span) => span.getAttribute('title') ?? '')
      .filter((title) => title.includes('computed per row'));
    expect(badges.some((t) => t.includes('belongs to this dashboard'))).toBe(true);
    expect(badges.some((t) => t.includes('private to you'))).toBe(true);
  });

  it('shows the formula as the row tooltip, so a name alone is never the whole story', () => {
    render();
    const row = [...host.querySelectorAll('button[title]')].find((b) =>
      (b.textContent ?? '').includes('Shipped?'),
    );
    expect(row?.getAttribute('title')).toContain('IF(ISBLANK(public.orders.shipped_at)');
  });

  it('offers one entry point for making a new one', () => {
    const onCreate = render();
    const button = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('New field'),
    ) as HTMLButtonElement;
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCreate).toHaveBeenCalled();
  });

  it('gives each row an action menu, exactly as measure rows have', () => {
    render();
    expect(host.querySelector('button[aria-label="Actions for Shipped?"]')).not.toBeNull();
  });
});

describe('grouping modes', () => {
  const groupsFor = (grouping: 'table' | 'category' | 'type') =>
    buildFieldColumnGroups({ model: MODEL, catalog: CATALOG, grouping, query: '' });

  it('Table mode files it under its own table', () => {
    const table = groupsFor('table').find((g) => g.key === 'public.orders')!;
    expect(groupRows(table).map((r) => r.column)).toContain('Shipped?');
  });

  it('Type mode files it with the TEXT fields — colour means type, and it is text', () => {
    const text = groupsFor('type').find((g) => g.key === '#type/text')!;
    const row = groupRows(text).find((r) => r.column === 'Shipped?');
    expect(row).toBeDefined();
    expect(row!.kind).toBe('text');
    expect(row!.derived).toBeDefined();
    // And it is NOT in the Date group, even though its source column is a date.
    const dates = groupsFor('type').find((g) => g.key === '#type/date')!;
    expect(groupRows(dates).map((r) => r.column)).not.toContain('Shipped?');
  });

  it('Category mode honours a display folder like a measure`s', () => {
    const foldered: ModelDefinition = {
      ...MODEL,
      derivedFields: [field('f1', 'Shipped?', { displayFolder: 'Logistics' })],
    };
    const groups = buildFieldColumnGroups({
      model: foldered,
      catalog: CATALOG,
      grouping: 'category',
      query: '',
    });
    const logistics = groups.find((g) => g.label === 'Logistics');
    expect(logistics).toBeDefined();
    expect(groupRows(logistics!).map((r) => r.column)).toEqual(['Shipped?']);
  });
});

describe('the wells refuse what a derived field cannot be', () => {
  const derivedDrag = {
    kind: 'column' as const,
    table: 'public.orders',
    column: 'Shipped?',
    type: 'text' as const,
    derived: true as const,
  };
  const plainDrag = { ...derivedDrag, column: 'shipped_at', type: 'date' as const, derived: undefined };

  it('a Values well never accepts one', () => {
    expect(canAccept('values', derivedDrag)).toBe(false);
    expect(canAccept('values', { ...plainDrag, derived: undefined })).toBe(true);
  });

  it('every dimension well still does', () => {
    for (const well of ['axis', 'legend', 'smallMultiples', 'drill'] as const) {
      expect(canAccept(well, derivedDrag)).toBe(true);
    }
  });

  it('a drop into Values is a no-op on the query, not a silently converted measure', () => {
    const query: ChartQuery = { measures: [], filters: [] };
    expect(applyDrop('column', query, 'values', derivedDrag)).toBe(query);
  });

  it('a CHIP dragged out of an axis into Values is refused too', () => {
    const query: ChartQuery = {
      axis: { table: 'public.orders', column: 'Shipped?' },
      measures: [],
      filters: [],
    };
    const moved = moveChip(
      'column',
      query,
      {
        kind: 'chip',
        from: { well: 'axis', index: 0 },
        ref: { kind: 'dimension', dimension: query.axis! },
        type: 'text',
        label: 'Shipped?',
        derived: true,
      },
      { well: 'values' },
    );
    expect(moved).toBeNull();
  });

  it('lands on an axis with NO date grain even when the payload claims a date type', () => {
    const query: ChartQuery = { measures: [], filters: [] };
    const next = applyDrop('column', query, 'axis', {
      ...derivedDrag,
      type: 'date',
    });
    expect(next.axis).toEqual({
      table: 'public.orders',
      column: 'Shipped?',
      dateBucket: null,
    });
  });
});

describe('scope resolution', () => {
  it('flags two fields on one table answering to one name', () => {
    const clash = buildScopedDerivedFields([field('a', 'Status')], [field('b', 'Status')], []);
    expect(clash.every((entry) => entry.duplicateName)).toBe(true);
  });

  it('a name is an ADDRESS, so the narrower scope wins it', () => {
    const clash = buildScopedDerivedFields(
      [field('a', 'Status', { expression: 'wide' })],
      [field('b', 'Status', { expression: 'narrow' })],
      [],
    );
    const effective = derivedFieldsOfScopes(clash);
    expect(effective).toHaveLength(1);
    expect(effective[0]!.expression).toBe('narrow');
  });

  it('the same name on a DIFFERENT table is a different field, not a clash', () => {
    const distinct = buildScopedDerivedFields(
      [field('a', 'Status')],
      [field('b', 'Status', { table: 'public.tickets' })],
      [],
    );
    expect(distinct.some((entry) => entry.duplicateName)).toBe(false);
    expect(derivedFieldsOfScopes(distinct)).toHaveLength(2);
  });

  it('counts how many of the chart`s wells name a field', () => {
    const chart = {
      id: 'c',
      type: 'column' as const,
      title: 't',
      query: {
        axis: { table: 'public.orders', column: 'Shipped?' },
        legend: { table: 'public.orders', column: 'Shipped?' },
        measures: [],
        filters: [],
      },
      format: {},
    };
    expect(derivedUsageCount(chart, SYSTEM)).toBe(2);
    expect(derivedUsageCount(chart, DASHBOARD)).toBe(0);
  });
});
