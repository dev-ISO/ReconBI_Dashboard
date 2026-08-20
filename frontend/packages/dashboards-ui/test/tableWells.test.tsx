// @vitest-environment jsdom
/**
 * 0.14.1 TABLE ERGONOMICS — the three builder affordances a passthrough table
 * needs, none of which existed before (the library's own seeded dashboards use
 * this exact shape, but only because their JSON was hand-authored):
 *
 *   E1 the aggregation select offers Min/Max on a TEXT column
 *   E3 a value chip can be RENAMED inline — it writes MeasureRef.alias, which
 *      the engine already honors as the column header, turning "Min of Client"
 *      into "Client"
 *   E4 a temporal chip can choose "Exact date" (dateBucket null), so a table
 *      row can show the real Latest Week Ending instead of a month bucket
 *   D1 the table's Values well is optional, so it wears no "Required" tag
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
  ChartType,
  ModelDefinition,
} from '@recon/dashboards-core';
import { Wells } from '../src/chart-builder/Wells';

const MODEL: ModelDefinition = {
  version: 1,
  tables: [{ schema: 'public', name: 'projects' }],
  relationships: [],
  measures: [],
};

const CATALOG: Catalog = {
  connection: 'demo',
  versionHash: 'x',
  fetchedAtUtc: '2026-01-01T00:00:00Z',
  tables: [
    {
      schema: 'public',
      name: 'projects',
      key: 'public.projects',
      kind: 'table',
      rowEstimate: 100,
      comment: null,
      primaryKey: [],
      uniqueConstraints: [],
      columns: [
        {
          name: 'project_full_name',
          ordinal: 0,
          rawType: 'text',
          type: 'text',
          isNullable: true,
          comment: null,
        },
        {
          name: 'week_ending',
          ordinal: 1,
          rawType: 'date',
          type: 'date',
          isNullable: true,
          comment: null,
        },
        {
          name: 'revenue',
          ordinal: 2,
          rawType: 'numeric',
          type: 'decimal',
          isNullable: true,
          comment: null,
        },
      ],
    },
  ],
  foreignKeys: [],
  suggestions: [],
};

/** project_full_name in Rows, week_ending as an inline Min column. */
const PASSTHROUGH: ChartQuery = {
  axis: { table: 'public.projects', column: 'project_full_name', dateBucket: null },
  measures: [{ table: 'public.projects', column: 'week_ending', aggregation: 'min' }],
  filters: [],
};

let host: HTMLDivElement;
let root: Root;
let changes: ChartQuery[];
let filterEdits: number[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  changes = [];
  filterEdits = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const renderWells = (chartType: ChartType, query: ChartQuery): void => {
  act(() => {
    root.render(
      <DndContext>
        <Wells
          chartType={chartType}
          query={query}
          model={MODEL}
          catalog={CATALOG}
          onChange={(next) => changes.push(next)}
          onEditFilter={(index) => filterEdits.push(index)}
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

const optionLabels = (select: HTMLSelectElement): string[] =>
  Array.from(select.options).map((option) => option.textContent ?? '');

/** Fires a real change event so React's synthetic handler runs. */
const setValue = (select: HTMLSelectElement, value: string): void => {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const type = (input: HTMLInputElement, value: string): void => {
  act(() => {
    // React tracks the last set value on the DOM node; bypass its setter so
    // the synthetic onChange actually fires for a programmatic assignment.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const press = (input: HTMLInputElement, key: string): void => {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

describe('E1 — aggregations offered on a text value chip', () => {
  it('offers Min and Max on text, not just the two counts', () => {
    renderWells('table', {
      ...PASSTHROUGH,
      measures: [{ table: 'public.projects', column: 'project_full_name', aggregation: 'min' }],
    });
    const select = byLabel<HTMLSelectElement>('Aggregation for project_full_name');
    expect(optionLabels(select)).toEqual(['Min', 'Max', 'Count', 'Distinct count']);
  });
});

describe('E3 — inline alias editor on a value chip', () => {
  it('renames the column, writing MeasureRef.alias', () => {
    renderWells('table', PASSTHROUGH);
    act(() => byLabel<HTMLButtonElement>('Rename week_ending').click());

    const input = byLabel<HTMLInputElement>('Name for week_ending');
    // The placeholder shows what the header currently reads.
    expect(input.placeholder).toBe('week_ending');
    type(input, 'Latest Week Ending');
    press(input, 'Enter');

    expect(changes.at(-1)!.measures[0]).toEqual({
      table: 'public.projects',
      column: 'week_ending',
      aggregation: 'min',
      alias: 'Latest Week Ending',
    });
  });

  it('clearing the box DELETES the alias rather than persisting an empty one', () => {
    renderWells('table', {
      ...PASSTHROUGH,
      measures: [
        {
          table: 'public.projects',
          column: 'week_ending',
          aggregation: 'min',
          alias: 'Latest Week Ending',
        },
      ],
    });
    // The chip reads as its alias once it has one.
    act(() => byLabel<HTMLButtonElement>('Rename Latest Week Ending').click());
    const input = byLabel<HTMLInputElement>('Name for Latest Week Ending');
    expect(input.value).toBe('Latest Week Ending');
    type(input, '   ');
    press(input, 'Enter');

    expect(changes.at(-1)!.measures[0]).toEqual({
      table: 'public.projects',
      column: 'week_ending',
      aggregation: 'min',
    });
    expect('alias' in changes.at(-1)!.measures[0]!).toBe(false);
  });

  it('Escape abandons the edit without touching the query', () => {
    renderWells('table', PASSTHROUGH);
    act(() => byLabel<HTMLButtonElement>('Rename week_ending').click());
    const input = byLabel<HTMLInputElement>('Name for week_ending');
    type(input, 'nope');
    press(input, 'Escape');
    expect(changes).toEqual([]);
  });
});

describe('E4 — "Exact date" bucket', () => {
  it('offers Exact date and writes a null bucket', () => {
    renderWells('table', {
      ...PASSTHROUGH,
      axis: { table: 'public.projects', column: 'week_ending', dateBucket: 'month' },
      measures: [],
    });
    const select = byLabel<HTMLSelectElement>('Date bucket for week_ending');
    expect(optionLabels(select)).toEqual([
      'Exact date',
      'Year',
      'Quarter',
      'Month',
      'Week',
      'Day',
    ]);
    expect(select.value).toBe('month');

    setValue(select, '');
    expect(changes.at(-1)!.axis).toEqual({
      table: 'public.projects',
      column: 'week_ending',
      dateBucket: null,
    });
  });

  it('shows an unbucketed date chip AS "Exact date" instead of lying about Month', () => {
    renderWells('table', {
      ...PASSTHROUGH,
      axis: { table: 'public.projects', column: 'week_ending', dateBucket: null },
      measures: [],
    });
    const select = byLabel<HTMLSelectElement>('Date bucket for week_ending');
    expect(select.value).toBe('');
  });
});

describe('F1 — chips are draggable BETWEEN wells', () => {
  /** Two rows and two value columns — enough for both reorder grips to show. */
  const FULL: ChartQuery = {
    axis: { table: 'public.projects', column: 'project_full_name', dateBucket: null },
    drillLevels: [{ table: 'public.projects', column: 'week_ending', dateBucket: null }],
    measures: [
      { table: 'public.projects', column: 'revenue', aggregation: 'sum' },
      { table: 'public.projects', column: 'week_ending', aggregation: 'min', alias: 'Latest' },
    ],
    filters: [
      { table: 'public.projects', column: 'project_full_name', operator: 'in', values: ['a'] },
    ],
  };

  /** Every chip label doubles as a drag handle; the tooltip says so. */
  const dragHandles = (): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>('[title*="drag onto another well"]'));

  it('makes every chip LABEL a drag handle — rows, values and the legend alike', () => {
    renderWells('table', { ...FULL, legend: { table: 'public.projects', column: 'revenue' } });
    const titles = dragHandles().map((node) => node.getAttribute('title'));
    expect(titles).toContain('project_full_name — drag onto another well to move it');
    expect(titles).toContain('week_ending — drag onto another well to move it');
    // The value chip reads as its alias, and drags under that name.
    expect(titles).toContain('Latest — drag onto another well to move it');
    // Columns (the table legend) is a one-chip well and is draggable too.
    expect(titles.filter((title) => title?.startsWith('revenue'))).toHaveLength(2);
    for (const handle of dragHandles()) {
      expect(handle.className).toContain('cursor-grab');
    }
  });

  it('keeps the Rows reorder grips after the nested drag context was removed', () => {
    renderWells('table', FULL);
    // The rows list used to run its own DndContext purely to be sortable; it
    // now sorts in the builder's context, and the grips are unchanged.
    expect(host.querySelector('[aria-label="Reorder project_full_name"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Reorder week_ending"]')).not.toBeNull();
  });

  it('gives VALUE chips a reorder grip too — measure order is table column order', () => {
    renderWells('table', FULL);
    expect(host.querySelector('[aria-label="Reorder Latest"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Reorder revenue"]')).not.toBeNull();
  });

  it('shows no grip on a lone chip — there is nothing to reorder it against', () => {
    renderWells('table', PASSTHROUGH);
    expect(host.querySelector('[aria-label^="Reorder"]')).toBeNull();
  });

  it('leaves the chip CONTROLS as controls — the drag never swallows a click', () => {
    renderWells('table', FULL);
    // The filter chip's label is both a drag handle and the edit button.
    const filterButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (node) => node.title.startsWith('Edit filter:'),
    );
    act(() => filterButton!.click());
    expect(filterEdits).toEqual([0]);

    // …and the ✕ on a dragged chip still removes it.
    act(() => byLabel<HTMLButtonElement>('Remove revenue').click());
    expect(changes.at(-1)!.measures.map((m) => m.column)).toEqual(['week_ending']);
  });

  it('swaps the label for the alias input while renaming, so typing is not a drag', () => {
    renderWells('table', FULL);
    act(() => byLabel<HTMLButtonElement>('Rename Latest').click());
    expect(host.querySelector('[title="Latest — drag onto another well to move it"]')).toBeNull();
    expect(byLabel<HTMLInputElement>('Name for Latest')).not.toBeNull();
  });
});

describe('D1 — a table needs no Values', () => {
  it('renders no Required tag on the table Values well', () => {
    renderWells('table', { ...PASSTHROUGH, measures: [] });
    const required = Array.from(host.querySelectorAll('span')).filter(
      (node) => node.textContent === 'Required',
    );
    expect(required).toHaveLength(0);
  });

  it('calls the row limit a row limit, not a Top N, when there is nothing to rank by', () => {
    renderWells('table', { ...PASSTHROUGH, measures: [] });
    expect(host.querySelector('[aria-label="Row limit"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Top N row limit"]')).toBeNull();

    renderWells('table', PASSTHROUGH);
    expect(host.querySelector('[aria-label="Top N row limit"]')).not.toBeNull();
  });
});
