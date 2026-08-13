import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '../types/chart';
import type { ModelDefinition } from '../types/model';
import type { Catalog, CatalogColumn, CatalogTable, ColumnType } from '../types/schema';
import { validateChartSpec, type ChartIssue } from './chartValidation';

const column = (name: string, type: ColumnType, ordinal = 0): CatalogColumn => ({
  name,
  ordinal,
  rawType: type,
  type,
  isNullable: true,
  comment: null,
});

const table = (
  schema: string,
  name: string,
  columns: CatalogColumn[],
  rowEstimate: number | null = 100,
): CatalogTable => ({
  schema,
  name,
  key: `${schema}.${name}`,
  kind: 'table',
  rowEstimate,
  comment: null,
  columns,
  primaryKey: [],
  uniqueConstraints: [],
});

const catalog: Catalog = {
  connection: 'demo',
  versionHash: 'x',
  fetchedAtUtc: '2026-01-01T00:00:00Z',
  tables: [
    table('public', 'orders', [
      column('order_total', 'decimal'),
      column('order_date', 'date'),
      column('status', 'text'),
      column('customer_id', 'integer'),
      column('payload', 'json'),
    ]),
    table('public', 'customers', [column('id', 'integer'), column('region', 'text')]),
    table('public', 'events', [column('id', 'integer'), column('name', 'text')], 50_000),
    table('public', 'bridge_a', [column('id', 'integer')]),
    table('public', 'bridge_b', [column('id', 'integer')]),
  ],
  foreignKeys: [],
  suggestions: [],
};

const model: ModelDefinition = {
  version: 1,
  tables: [
    { schema: 'public', name: 'orders' },
    { schema: 'public', name: 'customers' },
    { schema: 'public', name: 'events' },
    { schema: 'public', name: 'ghost' }, // in the model, gone from the catalog
    { schema: 'public', name: 'bridge_a' },
    { schema: 'public', name: 'bridge_b' },
  ],
  relationships: [
    {
      id: 'r1',
      fromTable: 'public.orders',
      fromColumn: 'customer_id',
      toTable: 'public.customers',
      toColumn: 'id',
      cardinality: 'manyToOne',
      isActive: true,
      source: 'fk',
    },
    // Diamond onto events: two equal-length paths (ambiguity warning).
    {
      id: 'r2',
      fromTable: 'public.orders',
      fromColumn: 'customer_id',
      toTable: 'public.bridge_a',
      toColumn: 'id',
      cardinality: 'manyToOne',
      isActive: true,
      source: 'manual',
    },
    {
      id: 'r3',
      fromTable: 'public.orders',
      fromColumn: 'customer_id',
      toTable: 'public.bridge_b',
      toColumn: 'id',
      cardinality: 'manyToOne',
      isActive: true,
      source: 'manual',
    },
    {
      id: 'r4',
      fromTable: 'public.bridge_a',
      fromColumn: 'id',
      toTable: 'public.events',
      toColumn: 'id',
      cardinality: 'manyToOne',
      isActive: true,
      source: 'manual',
    },
    {
      id: 'r5',
      fromTable: 'public.bridge_b',
      fromColumn: 'id',
      toTable: 'public.events',
      toColumn: 'id',
      cardinality: 'manyToOne',
      isActive: true,
      source: 'manual',
    },
  ],
  measures: [
    { id: 'm-total', name: 'Total', table: 'public.orders', aggregation: 'sum', column: 'order_total' },
  ],
  dateTables: [{ name: 'Calendar' }],
};

const baseSpec = (): ChartSpec => ({
  id: 'c1',
  type: 'column',
  title: 'Orders',
  query: {
    axis: { table: 'public.customers', column: 'region' },
    measures: [{ measureId: 'm-total' }],
    filters: [],
  },
  format: {},
});

const errors = (issues: ChartIssue[]): ChartIssue[] => issues.filter((i) => i.severity === 'error');
const codes = (issues: ChartIssue[]): string[] => issues.map((i) => i.code);

describe('validateChartSpec', () => {
  it('accepts a clean spec', () => {
    expect(validateChartSpec(baseSpec(), model, catalog)).toEqual([]);
  });

  it('flags a table missing from the model', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.nope', column: 'x' };
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues).toMatchObject([
      { code: 'unknown_table', well: 'axis', message: "Table 'public.nope' is not part of the model." },
    ]);
  });

  it('flags a model table that drifted out of the catalog', () => {
    const spec = baseSpec();
    spec.query.legend = { table: 'public.ghost', column: 'x' };
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(codes(issues)).toContain('unknown_table');
    expect(issues[0]!.message).toBe("Table 'public.ghost' no longer exists in the data source.");
    expect(issues[0]!.well).toBe('legend');
  });

  it('flags an unknown column', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.orders', column: 'nope' };
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues).toMatchObject([
      { code: 'unknown_column', message: "Column 'nope' does not exist on 'public.orders'." },
    ]);
  });

  it('skips column-existence checks while the catalog is null', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.orders', column: 'nope' };
    expect(validateChartSpec(spec, model, null)).toEqual([]);
  });

  it('still flags unknown model tables without a catalog', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.nope', column: 'x' };
    expect(codes(errors(validateChartSpec(spec, model, null)))).toContain('unknown_table');
  });

  it('flags non-queryable column types', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.orders', column: 'payload' };
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues[0]).toMatchObject({ code: 'bad_column', well: 'axis' });
    expect(issues[0]!.message).toContain('cannot be used here');
  });

  it('flags a date bucket on a non-temporal column', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.orders', column: 'status', dateBucket: 'month' };
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues).toMatchObject([
      {
        code: 'bad_bucket',
        message: "'public.orders.status' is text; date bucketing needs a date or timestamp column.",
      },
    ]);
  });

  it('flags an unknown measure id', () => {
    const spec = baseSpec();
    spec.query.measures = [{ measureId: 'm-missing' }];
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues).toMatchObject([
      { code: 'unknown_measure', well: 'values', message: 'The model has no measure with id m-missing.' },
    ]);
  });

  it('flags an inline measure without table/aggregation', () => {
    const spec = baseSpec();
    spec.query.measures = [{ column: 'order_total' }];
    expect(codes(errors(validateChartSpec(spec, model, catalog)))).toContain('bad_measure');
  });

  it('flags non-count aggregations that omit the column', () => {
    const spec = baseSpec();
    spec.query.measures = [{ table: 'public.orders', aggregation: 'sum' }];
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues[0]!.message).toBe('Only Count may omit the source column; sum needs one.');
  });

  it('allows count without a column', () => {
    const spec = baseSpec();
    spec.query.measures = [{ table: 'public.orders', aggregation: 'count' }];
    expect(validateChartSpec(spec, model, catalog)).toEqual([]);
  });

  it('flags aggregation/type mismatches (sum of text) and allows min/max on temporal', () => {
    const spec = baseSpec();
    spec.query.measures = [{ table: 'public.orders', column: 'status', aggregation: 'sum' }];
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues).toMatchObject([
      { code: 'bad_measure', message: "sum is not valid for column 'status' of type text." },
    ]);

    const okSpec = baseSpec();
    okSpec.query.measures = [{ table: 'public.orders', column: 'order_date', aggregation: 'max' }];
    expect(validateChartSpec(okSpec, model, catalog)).toEqual([]);
  });

  it('flags an empty measure list', () => {
    const spec = baseSpec();
    spec.query.measures = [];
    expect(codes(errors(validateChartSpec(spec, model, catalog)))).toContain('no_measures');
  });

  it('validates date-table references', () => {
    const spec = baseSpec();
    spec.query.axis = { table: '#date.Calendar', column: 'year' };
    // Calendar is not joined to orders in this model — reachability reports it.
    const connected = validateChartSpec(spec, model, catalog).filter((i) => i.code !== 'disconnected');
    expect(connected).toEqual([]);

    spec.query.axis = { table: '#date.Nope', column: 'year' };
    expect(codes(errors(validateChartSpec(spec, model, catalog)))).toContain('unknown_table');

    spec.query.axis = { table: '#date.Calendar', column: 'not_a_column' };
    expect(codes(errors(validateChartSpec(spec, model, catalog)))).toContain('unknown_column');
  });

  it('flags text-only filter operators on non-text columns', () => {
    const spec = baseSpec();
    spec.query.filters = [
      { table: 'public.orders', column: 'order_total', operator: 'contains', values: ['x'] },
    ];
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(issues[0]).toMatchObject({ code: 'bad_filter', well: 'filters' });
  });

  it('flags stale sort targets', () => {
    const spec = baseSpec();
    spec.query.sort = [
      { target: { kind: 'dimension', index: 2 }, direction: 'asc' },
      { target: { kind: 'measure', index: 5 }, direction: 'desc' },
    ];
    const issues = errors(validateChartSpec(spec, model, catalog));
    expect(codes(issues)).toEqual(['bad_sort', 'bad_sort']);
    expect(issues[0]!.message).toBe('Sort references dimension 2, which does not exist.');
  });

  it('flags authored-count overruns (dims incl. drill, measures, filters)', () => {
    const spec = baseSpec();
    spec.query.legend = { table: 'public.orders', column: 'status' };
    spec.query.smallMultiples = { table: 'public.customers', column: 'region' };
    spec.query.drillLevels = Array.from({ length: 6 }, () => ({
      table: 'public.orders',
      column: 'status',
    }));
    spec.query.measures = Array.from({ length: 17 }, () => ({ measureId: 'm-total' }));
    spec.query.filters = Array.from({ length: 33 }, () => ({
      table: 'public.orders',
      column: 'status',
      operator: 'eq' as const,
      values: ['open'],
    }));
    const found = codes(errors(validateChartSpec(spec, model, catalog)));
    expect(found).toContain('too_many_dimensions');
    expect(found).toContain('too_many_measures');
    expect(found).toContain('too_many_filters');
  });

  it('reports disconnected tables in the server wording', () => {
    const disconnectedModel: ModelDefinition = {
      ...model,
      relationships: [],
    };
    const issues = errors(validateChartSpec(baseSpec(), disconnectedModel, catalog));
    expect(issues).toMatchObject([
      {
        code: 'disconnected',
        message:
          "Table 'public.customers' is not connected to 'public.orders' through any active relationship. Add a relationship between them on the model canvas.",
      },
    ]);
  });

  it('warns on ambiguous equal-shortest join paths', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.events', column: 'name' };
    spec.query.limit = 100; // silence the row-cap warning; events is large
    const issues = validateChartSpec(spec, model, catalog);
    expect(issues).toMatchObject([{ severity: 'warning', code: 'ambiguous_path' }]);
    expect(issues[0]!.message).toContain('multiple equally short relationship paths');
  });

  it('warns on chart-type completeness (scatter, gantt, kpi)', () => {
    const scatter = baseSpec();
    scatter.type = 'scatter';
    expect(validateChartSpec(scatter, model, catalog)).toMatchObject([
      { severity: 'warning', code: 'chart_incomplete', well: 'values' },
    ]);

    const gantt = baseSpec();
    gantt.type = 'gantt';
    expect(codes(validateChartSpec(gantt, model, catalog))).toContain('chart_incomplete');

    const kpi = baseSpec();
    kpi.type = 'kpi';
    kpi.query.legend = { table: 'public.orders', column: 'status' };
    expect(validateChartSpec(kpi, model, catalog)).toMatchObject([
      { severity: 'warning', code: 'chart_incomplete', well: 'legend' },
    ]);
  });

  it('warns when a very large axis table has no row limit', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.events', column: 'name' };
    const issues = validateChartSpec(spec, model, catalog);
    expect(codes(issues)).toContain('high_cardinality');

    spec.query.limit = 500;
    expect(codes(validateChartSpec(spec, model, catalog))).not.toContain('high_cardinality');
  });
});
