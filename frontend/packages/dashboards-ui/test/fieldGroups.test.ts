/**
 * THE THREE GROUPING MODES, and the invariant that makes them safe:
 *
 *   A MODE CHANGES HOW FIELDS ARE ARRANGED, NEVER WHICH FIELDS ARE OFFERED.
 *
 * Also pinned here: the many-to-many category rule. A column can belong to
 * several of the host's pages — in the tracker's own manifest six columns are
 * on all six pages and fifteen of seventy-three are on two or more — so a
 * single folder string could not have expressed the truth. The threshold that
 * decides "list it under each" versus "pool it into Common fields" is a
 * rendering choice, and it is tested as one.
 */
import { describe, expect, it } from 'vitest';
import type { Catalog, ChartSpec, ModelDefinition } from '@recon/dashboards-core';
import {
  buildFieldColumnGroups,
  chartFieldUsage,
  COMMON_FIELDS_KEY,
  groupRows,
  hasNoCategories,
  MAX_CATEGORY_FOLDERS_PER_COLUMN,
  UNGROUPED_FIELDS_KEY,
} from '../src/chart-builder/fieldGroups';

const CATALOG: Catalog = {
  connection: 'warehouse',
  versionHash: 'v1',
  fetchedAtUtc: '2026-01-01T00:00:00Z',
  tables: [
    {
      schema: 'public',
      name: 'systems',
      key: 'public.systems',
      kind: 'view',
      rowEstimate: null,
      comment: null,
      primaryKey: [],
      uniqueConstraints: [],
      columns: [
        { name: 'system_number', ordinal: 1, rawType: 'text', type: 'text', isNullable: false, comment: null },
        { name: 'device_count', ordinal: 2, rawType: 'int4', type: 'integer', isNullable: true, comment: null },
        { name: 'review_date', ordinal: 3, rawType: 'date', type: 'date', isNullable: true, comment: null },
        { name: 'open_vent', ordinal: 4, rawType: 'bool', type: 'boolean', isNullable: true, comment: null },
        { name: 'payload', ordinal: 5, rawType: 'jsonb', type: 'json', isNullable: true, comment: null },
        { name: 'secret', ordinal: 6, rawType: 'text', type: 'text', isNullable: true, comment: null },
      ],
    },
    {
      schema: 'public',
      name: 'devices',
      key: 'public.devices',
      kind: 'view',
      rowEstimate: null,
      comment: null,
      primaryKey: [],
      uniqueConstraints: [],
      columns: [
        { name: 'tag', ordinal: 1, rawType: 'text', type: 'text', isNullable: false, comment: null },
      ],
    },
  ],
  foreignKeys: [],
} as unknown as Catalog;

const MODEL: ModelDefinition = {
  version: 1,
  tables: [
    {
      schema: 'public',
      name: 'systems',
      friendlyName: 'Systems',
      columns: [
        // In every page of the host app — six is more than the threshold.
        {
          name: 'system_number',
          friendlyName: 'System number',
          displayFolders: ['List', 'Revalidation', 'Mitigation', 'Dispersion', 'Analysis', 'Packages'],
        },
        // In two — under the threshold, so it appears under BOTH.
        { name: 'device_count', displayFolders: ['List', 'Mitigation'] },
        // In one.
        { name: 'review_date', displayFolders: ['Revalidation'] },
        // In none.
        { name: 'open_vent' },
        // Hidden by the model: never offered, in any mode.
        { name: 'secret', hidden: true },
      ],
    },
    { schema: 'public', name: 'devices' },
  ],
  relationships: [],
  measures: [],
  dateTables: [{ name: 'dates' }],
};

const build = (grouping: 'table' | 'category' | 'type', query = '') =>
  buildFieldColumnGroups({ model: MODEL, catalog: CATALOG, grouping, query });

/** Every distinct field id a mode puts in front of the user. */
const offered = (grouping: 'table' | 'category' | 'type'): Set<string> =>
  new Set(build(grouping).flatMap((group) => groupRows(group).map((row) => row.id)));

describe('field grouping modes', () => {
  it('offers exactly the same fields in all three modes', () => {
    const table = offered('table');
    const category = offered('category');
    const type = offered('type');
    expect([...category].sort()).toEqual([...table].sort());
    expect([...type].sort()).toEqual([...table].sort());
    // …and that population is the right one: queryable, non-hidden columns
    // plus every engine date-table column.
    expect(table.has('column:public.systems:secret')).toBe(false); // model-hidden
    expect(table.has('column:public.systems:payload')).toBe(false); // json = not queryable
    expect(table.has('column:#date.dates:year')).toBe(true);
    expect(table.size).toBe(4 + 1 + 25); // systems + devices + date table
  });

  it('TABLE mode groups by table, with the date table as its own section', () => {
    const groups = build('table');
    expect(groups.map((g) => g.key)).toEqual(['public.systems', 'public.devices', '#date.dates']);
    expect(groups[0]!.label).toBe('Systems');
    // Small model: every table starts open.
    expect(groups.every((g) => g.defaultOpen)).toBe(true);
  });

  it('TYPE mode groups by what a field IS, date-table columns included', () => {
    const groups = build('type');
    expect(groups.map((g) => g.label)).toEqual(['Text', 'Number', 'Date', 'Yes/No']);
    const dates = groups.find((g) => g.label === 'Date')!;
    expect(dates.rows.some((row) => row.column === 'review_date')).toBe(true);
    // A Date group that omitted the calendar would be a lie.
    expect(dates.rows.some((row) => row.table === '#date.dates')).toBe(true);
    // Mixed tables, so rows say where they came from.
    expect(dates.qualifyRows).toBe(true);
  });

  it('CATEGORY mode lists a column under EACH of its folders, up to the threshold', () => {
    const groups = build('category');
    const list = groups.find((g) => g.label === 'List')!;
    const mitigation = groups.find((g) => g.label === 'Mitigation')!;
    // device_count is in two folders: it appears in both, deliberately.
    expect(list.rows.some((r) => r.column === 'device_count')).toBe(true);
    expect(mitigation.rows.some((r) => r.column === 'device_count')).toBe(true);
  });

  it('pools a column in MORE than the threshold into one "Common fields" group', () => {
    const groups = build('category');
    const common = groups.find((g) => g.key === COMMON_FIELDS_KEY)!;
    expect(common.rows.map((r) => r.column)).toEqual(['system_number']);
    // …and it is NOT repeated under each of its six folders.
    for (const group of groups) {
      if (group.key === COMMON_FIELDS_KEY) continue;
      expect(group.rows.some((r) => r.column === 'system_number')).toBe(false);
    }
    // Common fields lead: they are the identifiers every category needs.
    expect(groups[0]!.key).toBe(COMMON_FIELDS_KEY);
    expect(MAX_CATEGORY_FOLDERS_PER_COLUMN).toBe(3);
  });

  it('files a column with no category into "Ungrouped", rendered last', () => {
    const groups = build('category');
    expect(groups[groups.length - 1]!.key).toBe(UNGROUPED_FIELDS_KEY);
    const ungrouped = groups[groups.length - 1]!;
    expect(ungrouped.rows.some((r) => r.column === 'open_vent')).toBe(true);
    // A table with no column overrides at all lands here too.
    expect(ungrouped.rows.some((r) => r.column === 'tag')).toBe(true);
  });

  it('nests a backslash-separated category and sorts the folders alphabetically', () => {
    const nested: ModelDefinition = {
      ...MODEL,
      tables: [
        {
          schema: 'public',
          name: 'systems',
          columns: [
            { name: 'review_date', displayFolders: ['Safety\\Dispersion'] },
            { name: 'open_vent', displayFolders: ['Safety\\Analysis'] },
            { name: 'device_count', displayFolders: ['Ops'] },
          ],
        },
      ],
      dateTables: [],
    };
    const groups = buildFieldColumnGroups({
      model: nested,
      catalog: CATALOG,
      grouping: 'category',
      query: '',
    });
    expect(groups.map((g) => g.label)).toEqual(['Ops', 'Safety', 'Ungrouped']);
    const safety = groups.find((g) => g.label === 'Safety')!;
    expect(safety.folders.map((f) => f.name)).toEqual(['Analysis', 'Dispersion']);
    expect(safety.rows).toHaveLength(0); // nothing filed at the Safety level itself
  });

  it('says so when the model gives its fields no categories at all', () => {
    const plain: ModelDefinition = {
      version: 1,
      tables: [{ schema: 'public', name: 'devices' }],
      relationships: [],
      measures: [],
    };
    const groups = buildFieldColumnGroups({
      model: plain,
      catalog: CATALOG,
      grouping: 'category',
      query: '',
    });
    expect(hasNoCategories(groups)).toBe(true);
    expect(hasNoCategories(build('category'))).toBe(false);
  });

  it('search keeps every column of a NAME-matched group and filters the rest', () => {
    const matched = build('table', 'systems');
    const systems = matched.find((g) => g.key === 'public.systems')!;
    expect(systems.nameMatched).toBe(true);
    expect(systems.rows).toHaveLength(4); // the whole table, not just hits

    const byColumn = build('table', 'review');
    const filtered = byColumn.find((g) => g.key === 'public.systems')!;
    expect(filtered.nameMatched).toBe(false);
    expect(filtered.rows.map((r) => r.column)).toEqual(['review_date']);
  });

  it('a friendlyName is what search and the row label use', () => {
    const groups = build('category', 'system number');
    const common = groups.find((g) => g.key === COMMON_FIELDS_KEY)!;
    expect(common.rows.map((r) => r.label)).toEqual(['System number']);
  });

  it('renders measures-only when the catalog is unavailable', () => {
    const groups = buildFieldColumnGroups({
      model: MODEL,
      catalog: null,
      grouping: 'table',
      query: '',
    });
    // No catalog = no column groups, but the date table still renders: its
    // schema is fixed and needs no introspection.
    expect(groups.map((g) => g.key)).toEqual(['#date.dates']);
  });
});

describe('chartFieldUsage', () => {
  const chart = (query: Partial<ChartSpec['query']>): ChartSpec => ({
    id: 'c1',
    type: 'column',
    title: 'T',
    query: { measures: [], filters: [], ...query },
    format: {},
  });

  it('covers every place a chart can name a field', () => {
    const used = chartFieldUsage(
      chart({
        axis: { table: 'public.systems', column: 'system_number' },
        drillLevels: [{ table: 'public.systems', column: 'device_count' }],
        legend: { table: 'public.devices', column: 'tag' },
        smallMultiples: { table: '#date.dates', column: 'year' },
        filters: [{ table: 'public.systems', column: 'open_vent', operator: 'eq', values: [true] }],
        measures: [{ measureId: 'm1' }, { table: 'public.systems', column: 'device_count', aggregation: 'sum' }],
      }),
    );

    expect(used).toEqual(
      new Set([
        'column:public.systems:system_number',
        'column:public.systems:device_count',
        'column:public.devices:tag',
        'column:#date.dates:year',
        'column:public.systems:open_vent',
        'measure:m1',
      ]),
    );
  });

  it('is empty for an empty chart — hiding is unrestricted until something is built', () => {
    expect(chartFieldUsage(chart({})).size).toBe(0);
  });
});
