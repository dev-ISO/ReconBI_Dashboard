import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '../types/chart';
import type { ModelDefinition } from '../types/model';
import type { Catalog, CatalogColumn, CatalogTable, ColumnType } from '../types/schema';
import {
  pathToWell,
  validateChartSpec,
  wireDimensionWells,
  type ChartIssue,
} from './chartValidation';

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

  // 0.14.1: a TABLE is a passthrough column list, so Rows alone is a complete
  // spec (the engine emits a GROUP BY over the dimensions = SELECT DISTINCT).
  // Mirrors isRunnable — the two must agree or Save enables a chart the tile
  // then refuses to render.
  it('allows a measure-less table with rows, but not a measure-less chart or a bare table', () => {
    const passthrough = baseSpec();
    passthrough.type = 'table';
    passthrough.query.measures = [];
    expect(codes(errors(validateChartSpec(passthrough, model, catalog)))).not.toContain(
      'no_measures',
    );

    const bareTable = baseSpec();
    bareTable.type = 'table';
    bareTable.query.measures = [];
    bareTable.query.axis = null;
    expect(codes(errors(validateChartSpec(bareTable, model, catalog)))).toContain('no_measures');

    const measurelessColumn = baseSpec();
    measurelessColumn.query.measures = [];
    expect(codes(errors(validateChartSpec(measurelessColumn, model, catalog)))).toContain(
      'no_measures',
    );
  });

  // 0.14.1 mirror of the engine's IsAggregationCompatible: Min/Max are legal
  // on TEXT, which is what a passthrough table column ("Min of Client",
  // aliased to "Client") relies on. The builder now offers it too.
  it('allows min/max on text', () => {
    const spec = baseSpec();
    spec.query.measures = [
      { table: 'public.orders', column: 'status', aggregation: 'min', alias: 'Status' },
    ];
    expect(validateChartSpec(spec, model, catalog)).toEqual([]);
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

/* ------------------------------------------------------------------------- *
 * ITEM 6 — wire paths and the well they map back onto.
 *
 * The path grammar is PINNED and shared with the backend's
 * ValidationIssue.Path ("dimensions[i].column", "measures[i].aggregation", …),
 * so these tests double as the wire contract for the server half: whatever the
 * compiler tags an issue with must land on the right builder well here.
 * ------------------------------------------------------------------------- */

/** A table spec with a Rows hierarchy; matrix defaults ON. */
const matrixSpec = (): ChartSpec => ({
  id: 'c2',
  type: 'table',
  title: 'Rows',
  query: {
    axis: { table: 'public.customers', column: 'region' },
    drillLevels: [
      { table: 'public.orders', column: 'status' },
      { table: 'public.orders', column: 'customer_id' },
    ],
    legend: { table: 'public.orders', column: 'order_date' },
    measures: [{ measureId: 'm-total' }],
    filters: [],
  },
  format: {},
});

describe('wireDimensionWells', () => {
  it('mirrors toWireSpec for a matrix table: [axis, drill…, legend]', () => {
    expect(wireDimensionWells(matrixSpec())).toEqual(['axis', 'drill', 'drill', 'legend']);
  });

  it('drops the levels again when matrix is off', () => {
    const spec = matrixSpec();
    spec.format = { table: { matrix: false } };
    expect(wireDimensionWells(spec)).toEqual(['axis', 'legend']);
  });

  it('keeps cartesians on [axis, legend, smallMultiples]', () => {
    const spec = baseSpec();
    spec.query.drillLevels = [{ table: 'public.orders', column: 'status' }];
    spec.query.legend = { table: 'public.orders', column: 'status' };
    spec.query.smallMultiples = { table: 'public.orders', column: 'order_date' };
    expect(wireDimensionWells(spec)).toEqual(['axis', 'legend', 'smallMultiples']);
  });

  it('skips absent parts so the array index IS the wire index', () => {
    const spec = baseSpec();
    spec.query.axis = null;
    spec.query.legend = { table: 'public.orders', column: 'status' };
    expect(wireDimensionWells(spec)).toEqual(['legend']);
  });
});

describe('pathToWell', () => {
  it('resolves dimension indexes against the MATRIX wire order', () => {
    const spec = matrixSpec();
    expect(pathToWell('dimensions[0]', spec)).toBe('axis');
    expect(pathToWell('dimensions[1].column', spec)).toBe('drill');
    expect(pathToWell('dimensions[2].dateBucket', spec)).toBe('drill');
    expect(pathToWell('dimensions[3]', spec)).toBe('legend');
  });

  it('resolves the same index differently for a cartesian chart', () => {
    const spec = baseSpec();
    spec.query.legend = { table: 'public.orders', column: 'status' };
    spec.query.smallMultiples = { table: 'public.orders', column: 'order_date' };
    expect(pathToWell('dimensions[1]', spec)).toBe('legend');
    expect(pathToWell('dimensions[2]', spec)).toBe('smallMultiples');
  });

  it('maps every non-dimension head of the pinned grammar', () => {
    const spec = matrixSpec();
    expect(pathToWell('measures[0]', spec)).toBe('values');
    expect(pathToWell('measures[3].column', spec)).toBe('values');
    expect(pathToWell('measures[1].aggregation', spec)).toBe('values');
    expect(pathToWell('measures[1].expression', spec)).toBe('values');
    expect(pathToWell('filters[0]', spec)).toBe('filters');
    expect(pathToWell('filters[2].column', spec)).toBe('filters');
    expect(pathToWell('filters[2].values', spec)).toBe('filters');
    expect(pathToWell('having[0]', spec)).toBe('filters');
    expect(pathToWell('sort[1]', spec)).toBe('sort');
    expect(pathToWell('limit', spec)).toBe('sort');
  });

  it('returns undefined for paths with no single owning well', () => {
    const spec = matrixSpec();
    expect(pathToWell('query.table', spec)).toBeUndefined();
    expect(pathToWell('dimensions[9]', spec)).toBeUndefined(); // out of range
    expect(pathToWell('dimensions', spec)).toBeUndefined(); // no index
    expect(pathToWell('', spec)).toBeUndefined();
    expect(pathToWell('!!!', spec)).toBeUndefined();
    expect(pathToWell('somethingElse[0]', spec)).toBeUndefined();
  });
});

describe('validateChartSpec wire paths', () => {
  /** Every issue that carries a path must agree with pathToWell on the well. */
  const expectRoundTrip = (spec: ChartSpec): ChartIssue[] => {
    const issues = validateChartSpec(spec, model, catalog);
    for (const issue of issues) {
      if (issue.path === undefined) continue;
      expect({ path: issue.path, well: pathToWell(issue.path, spec) }).toEqual({
        path: issue.path,
        well: issue.well,
      });
    }
    return issues;
  };

  it('addresses a bad axis column at dimensions[0].column', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.orders', column: 'nope' };
    expect(expectRoundTrip(spec)).toMatchObject([
      { code: 'unknown_column', well: 'axis', path: 'dimensions[0].column' },
    ]);
  });

  it('addresses a bad bucket at dimensions[i].dateBucket', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.orders', column: 'status', dateBucket: 'month' };
    expect(expectRoundTrip(spec)).toMatchObject([
      { code: 'bad_bucket', well: 'axis', path: 'dimensions[0].dateBucket' },
    ]);
  });

  it('addresses an unknown TABLE at the ref itself, not its column', () => {
    const spec = baseSpec();
    spec.query.axis = { table: 'public.nope', column: 'x' };
    expect(expectRoundTrip(spec)).toMatchObject([
      { code: 'unknown_table', well: 'axis', path: 'dimensions[0]' },
    ]);
  });

  it('numbers matrix drill levels as REAL wire dimensions', () => {
    const spec = matrixSpec();
    spec.query.drillLevels = [
      { table: 'public.orders', column: 'nope' },
      { table: 'public.orders', column: 'status' },
    ];
    expect(expectRoundTrip(spec)).toMatchObject([
      { code: 'unknown_column', well: 'drill', path: 'dimensions[1].column' },
    ]);
  });

  it('gives LEGACY drill levels no path (they never reach the wire)', () => {
    const spec = matrixSpec();
    spec.format = { table: { matrix: false } };
    spec.query.drillLevels = [{ table: 'public.orders', column: 'nope' }];
    const issues = expectRoundTrip(spec);
    expect(issues).toMatchObject([{ code: 'unknown_column', well: 'drill' }]);
    expect(issues[0]!.path).toBeUndefined();
    // …and the legend behind it keeps ITS wire index at 1, not 2.
    expect(wireDimensionWells(spec)).toEqual(['axis', 'legend']);
  });

  it('addresses measures by wire index, aggregation faults at .aggregation', () => {
    const spec = baseSpec();
    spec.query.measures = [
      { measureId: 'm-total' },
      { table: 'public.orders', column: 'status', aggregation: 'sum' },
    ];
    expect(expectRoundTrip(spec)).toMatchObject([
      { code: 'bad_measure', well: 'values', path: 'measures[1].aggregation' },
    ]);
  });

  it('addresses a missing measure column at measures[i].column', () => {
    const spec = baseSpec();
    spec.query.measures = [{ table: 'public.orders', aggregation: 'sum' }];
    expect(expectRoundTrip(spec)).toMatchObject([
      { code: 'bad_measure', well: 'values', path: 'measures[0].column' },
    ]);
  });

  it('addresses filters and sort by their own wire index', () => {
    const spec = baseSpec();
    spec.query.filters = [
      { table: 'public.orders', column: 'status', operator: 'eq', values: ['a'] },
      { table: 'public.orders', column: 'order_total', operator: 'contains', values: ['x'] },
    ];
    spec.query.sort = [{ target: { kind: 'measure', index: 9 }, direction: 'asc' }];
    const issues = expectRoundTrip(spec);
    expect(issues).toMatchObject([
      { code: 'bad_filter', well: 'filters', path: 'filters[1]' },
      { code: 'bad_sort', well: 'sort', path: 'sort[0]' },
    ]);
  });

  it('caps the matrix hierarchy at the axis plus three levels', () => {
    const spec = matrixSpec();
    spec.query.legend = null;
    spec.query.drillLevels = ['status', 'customer_id', 'order_total', 'order_date'].map(
      (column) => ({ table: 'public.orders', column }),
    );
    const issues = expectRoundTrip(spec).filter((i) => i.code === 'too_many_dimensions');
    expect(issues).toMatchObject([{ well: 'drill', path: 'dimensions[4]' }]);
    expect(issues[0]!.message).toContain('row hierarchy');

    // Exactly at the cap (axis + 3 = 5 wire dims with the legend) is fine —
    // well under the server's MaxDimensions of 8, so no backend raise needed.
    spec.query.drillLevels = spec.query.drillLevels!.slice(0, 3);
    spec.query.legend = { table: 'public.orders', column: 'order_date' };
    expect(wireDimensionWells(spec)).toHaveLength(5);
    expect(codes(validateChartSpec(spec, model, catalog))).not.toContain('too_many_dimensions');
  });
});
