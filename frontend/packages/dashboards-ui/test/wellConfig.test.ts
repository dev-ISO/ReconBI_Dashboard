/**
 * FIRST tests for wellConfig — the chart builder's drop-inference core
 * (applyDrop / toValueMeasure / toDimension / aggregationOptionsFor /
 * defaultWellFor / normalizeQueryForType), which shipped through 0.14.0
 * entirely uncovered.
 *
 * The 0.14.1 table-ergonomics batch changes exactly the behaviors pinned
 * here, all of which the owner hit while trying to build "project full name +
 * Latest Week Ending":
 *   E1  Min/Max are offered on TEXT (the engine has always allowed them)
 *   E2  a TABLE's Values well is a passthrough column list: text/dates land
 *       as Min, numbers keep Sum/Count
 *   E4  a temporal field in a table's ROWS keeps its exact value instead of
 *       being force-bucketed to 'month'
 *   D1  the table Values well is no longer flagged Required
 * Everything else asserted here is PRE-EXISTING behavior, captured so the
 * cross-well-drag work that lands in these same functions next has a net.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChartFormat,
  ChartQuery,
  ChartSpec,
  ChartType,
  ColumnType,
  DimensionRef,
  FilterClause,
  MeasureRef,
} from '@recon/dashboards-core';
import {
  aggregationOptionsFor,
  applyDrop,
  canDropChip,
  defaultWellFor,
  hasRowsList,
  moveChip,
  normalizeQueryForType,
  remapIndexedRefs,
  valuesMaxFor,
  wellsFor,
  type ChipDragData,
  type ChipShape,
  type FieldDragData,
  type WellId,
} from '../src/chart-builder/wellConfig';

const empty = (): ChartQuery => ({ measures: [], filters: [] });

const col = (column: string, type: ColumnType): FieldDragData => ({
  kind: 'column',
  table: 'public.projects',
  column,
  type,
});

const TEXT = col('project_full_name', 'text');
const DATE = col('week_ending', 'date');
const STAMP = col('updated_at', 'timestamp');
const NUMBER = col('revenue', 'decimal');
const ID_NUMBER = col('project_id', 'integer');
const FLAG = col('is_active', 'boolean');

const modelMeasure: FieldDragData = { kind: 'measure', measureId: 'm-1', name: 'Total' };

/* ------------------------------------------------------------ E1: options */

describe('aggregationOptionsFor', () => {
  it('offers Min/Max on text — the engine allows them and passthrough tables need them', () => {
    expect(aggregationOptionsFor('text')).toEqual(['min', 'max', 'count', 'countDistinct']);
  });

  it('offers Min/Max on dates and timestamps', () => {
    expect(aggregationOptionsFor('date')).toEqual(['min', 'max', 'count', 'countDistinct']);
    expect(aggregationOptionsFor('timestamp')).toEqual(['min', 'max', 'count', 'countDistinct']);
  });

  it('keeps boolean and uuid count-only — the engine rejects Min/Max there', () => {
    expect(aggregationOptionsFor('boolean')).toEqual(['count', 'countDistinct']);
    expect(aggregationOptionsFor('uuid')).toEqual(['count', 'countDistinct']);
  });

  it('offers every aggregation for numbers and for an unknown (no-catalog) type', () => {
    expect(aggregationOptionsFor('decimal')).toContain('sum');
    expect(aggregationOptionsFor('integer')).toContain('median');
    expect(aggregationOptionsFor(null)).toHaveLength(9);
  });
});

/* ------------------------------------------------- E2: values-well defaults */

describe('applyDrop into a values well', () => {
  it('defaults a TABLE text column to Min (a flat passthrough column)', () => {
    const query = applyDrop('table', empty(), 'values', TEXT);
    expect(query.measures).toEqual([
      { table: 'public.projects', column: 'project_full_name', aggregation: 'min' },
    ]);
  });

  it('defaults a TABLE date/timestamp column to Min too', () => {
    expect(applyDrop('table', empty(), 'values', DATE).measures[0]!.aggregation).toBe('min');
    expect(applyDrop('table', empty(), 'values', STAMP).measures[0]!.aggregation).toBe('min');
  });

  it('leaves NUMBERS alone in a table — Values is still a real measure list', () => {
    expect(applyDrop('table', empty(), 'values', NUMBER).measures[0]!.aggregation).toBe('sum');
    // …and identifier-shaped numbers still land as Count, never Sum.
    expect(applyDrop('table', empty(), 'values', ID_NUMBER).measures[0]!.aggregation).toBe('count');
  });

  it('keeps booleans on countDistinct in a table — Min of a boolean is illegal', () => {
    expect(applyDrop('table', empty(), 'values', FLAG).measures[0]!.aggregation).toBe(
      'countDistinct',
    );
  });

  it('does NOT apply the table default to other chart types', () => {
    expect(applyDrop('column', empty(), 'values', TEXT).measures[0]!.aggregation).toBe(
      'countDistinct',
    );
    expect(applyDrop('bar', empty(), 'values', DATE).measures[0]!.aggregation).toBe('countDistinct');
  });

  it('still honors a SLOT well default (gantt Start = Min, End = Max)', () => {
    let query = applyDrop('gantt', empty(), 'values', DATE, 0);
    query = applyDrop('gantt', query, 'values', col('finished_at', 'date'), 1);
    expect(query.measures.map((m) => m.aggregation)).toEqual(['min', 'max']);
  });

  it('drops a model measure by id with no aggregation of its own', () => {
    expect(applyDrop('table', empty(), 'values', modelMeasure).measures).toEqual([
      { measureId: 'm-1' },
    ]);
  });

  it('is a no-op for an exact duplicate measure', () => {
    const once = applyDrop('table', empty(), 'values', TEXT);
    expect(applyDrop('table', once, 'values', TEXT).measures).toHaveLength(1);
  });

  it('replaces the last chip when a capped values well is full (pie holds one)', () => {
    const first = applyDrop('pie', empty(), 'values', NUMBER);
    const second = applyDrop('pie', first, 'values', col('cost', 'decimal'));
    expect(second.measures).toHaveLength(1);
    expect(second.measures[0]!.column).toBe('cost');
  });
});

/* ------------------------------------------------------ E4: the date bucket */

describe('applyDrop of a temporal field into rows/axis', () => {
  it('keeps a TABLE row field UNBUCKETED — "Latest Week Ending" stays an exact date', () => {
    expect(applyDrop('table', empty(), 'axis', DATE).axis).toEqual({
      table: 'public.projects',
      column: 'week_ending',
      dateBucket: null,
    });
  });

  it('keeps later table row fields unbucketed too (they append to drillLevels)', () => {
    const withRow = applyDrop('table', empty(), 'axis', TEXT);
    const withDate = applyDrop('table', withRow, 'axis', DATE);
    expect(withDate.drillLevels).toEqual([
      { table: 'public.projects', column: 'week_ending', dateBucket: null },
    ]);
  });

  it('still buckets a CARTESIAN axis to month — a plotted date axis needs categories', () => {
    expect(applyDrop('column', empty(), 'axis', DATE).axis?.dateBucket).toBe('month');
    expect(applyDrop('line', empty(), 'drill', DATE).axis?.dateBucket).toBe('month');
  });

  it('buckets a table LEGEND (Columns) like every other grouping dimension', () => {
    expect(applyDrop('table', empty(), 'legend', DATE).legend?.dateBucket).toBe('month');
  });

  it('never gives a non-temporal column a bucket', () => {
    expect(applyDrop('column', empty(), 'axis', TEXT).axis?.dateBucket).toBeNull();
  });
});

/* ------------------------------------------------------- D1: well shape */

describe('table well definitions', () => {
  it('no longer marks Values required — Rows alone is a complete table', () => {
    const values = wellsFor('table').find((well) => well.id === 'values');
    expect(values?.required).toBeUndefined();
    expect(wellsFor('table').find((well) => well.id === 'axis')?.required).toBe(true);
  });

  it('stops calling the table Values well number-only in its placeholder', () => {
    const values = wellsFor('table').find((well) => well.id === 'values');
    expect(values?.placeholder).not.toContain('number field');
  });

  it('recognizes the table as the multi-field rows list, and nothing else', () => {
    const types: ChartType[] = ['table', 'column', 'bar', 'line', 'pie', 'scatter', 'gantt', 'kpi'];
    expect(types.filter(hasRowsList)).toEqual(['table']);
  });
});

/* ------------------------------------------- pre-existing behavior, pinned */

describe('routing and normalization (pre-existing)', () => {
  it('routes a click-added number to values and a text field to the empty axis', () => {
    expect(defaultWellFor('column', empty(), NUMBER)).toEqual({ well: 'values' });
    expect(defaultWellFor('column', empty(), TEXT)).toEqual({ well: 'axis' });
  });

  it('routes a gantt date to the first free date slot', () => {
    expect(defaultWellFor('gantt', empty(), DATE)).toEqual({ well: 'values', slot: 0 });
  });

  it('reports the values capacity per type', () => {
    expect(valuesMaxFor('table')).toBe(Number.POSITIVE_INFINITY);
    expect(valuesMaxFor('pie')).toBe(1);
    expect(valuesMaxFor('scatter')).toBe(2);
    expect(valuesMaxFor('gantt')).toBe(3);
  });

  it('carries a lone axis to the slice dimension when switching to pie, and back', () => {
    const asColumn = applyDrop('column', empty(), 'axis', TEXT);
    const asPie = normalizeQueryForType('pie', asColumn);
    expect(asPie.axis).toBeNull();
    expect(asPie.legend?.column).toBe('project_full_name');
    expect(normalizeQueryForType('column', asPie).axis?.column).toBe('project_full_name');
  });

  it('prunes measures past the target type capacity on a type switch', () => {
    let query = applyDrop('table', empty(), 'values', NUMBER);
    query = applyDrop('table', query, 'values', col('cost', 'decimal'));
    expect(normalizeQueryForType('pie', query).measures).toHaveLength(1);
  });
});

/* ======================================================================== */
/* F1 — CROSS-WELL DRAG                                                     */
/* "I want the ability to be able to click and drag items from the rows and */
/* put it in values and vice versa and with columns and filters like I'm    */
/* moving items from them without having to find them everytime."           */
/* ======================================================================== */

const TABLE = 'public.projects';
const dim = (column: string, dateBucket: DimensionRef['dateBucket'] = null): DimensionRef => ({
  table: TABLE,
  column,
  dateBucket,
});
const meas = (column: string, aggregation: MeasureRef['aggregation']): MeasureRef => ({
  table: TABLE,
  column,
  aggregation,
});
const clause = (column: string): FilterClause => ({
  table: TABLE,
  column,
  operator: 'in',
  values: ['a', 'b'],
});

const chip = (
  well: WellId,
  index: number,
  ref: ChipShape,
  type: ColumnType | null,
): ChipDragData => ({ kind: 'chip', from: { well, index }, ref, type, label: 'chip' });

const dimChip = (well: WellId, index: number, dimension: DimensionRef, type: ColumnType | null) =>
  chip(well, index, { kind: 'dimension', dimension }, type);
const measChip = (index: number, measure: MeasureRef, type: ColumnType | null) =>
  chip('values', index, { kind: 'measure', measure }, type);
const filterChip = (index: number, filter: FilterClause, type: ColumnType | null) =>
  chip('filters', index, { kind: 'filter', clause: filter }, type);

describe('moveChip — Rows <-> Values on a table (the owner’s example)', () => {
  const rowsAndValues = (): ChartQuery => ({
    axis: dim('project_full_name'),
    drillLevels: [dim('week_ending')],
    measures: [meas('revenue', 'sum')],
    filters: [],
  });

  it('moves a ROW into Values as a passthrough Min column', () => {
    const query = moveChip(
      'table',
      rowsAndValues(),
      dimChip('axis', 1, dim('week_ending'), 'date'),
      { well: 'values' },
    );
    expect(query?.drillLevels).toBeUndefined();
    expect(query?.axis).toEqual(dim('project_full_name'));
    // The table Values well is a passthrough column list -> Min, not a count.
    expect(query?.measures).toEqual([
      meas('revenue', 'sum'),
      { table: TABLE, column: 'week_ending', aggregation: 'min' },
    ]);
  });

  it('moves a VALUE back into Rows, unbucketed, dropping the aggregation', () => {
    const query = moveChip(
      'table',
      rowsAndValues(),
      measChip(0, { ...meas('revenue', 'sum'), alias: 'Revenue' }, 'decimal'),
      { well: 'axis' },
    );
    expect(query?.measures).toEqual([]);
    expect(query?.drillLevels).toEqual([dim('week_ending'), dim('revenue')]);
  });

  it('lands on the position it was dropped on, not the end of the well', () => {
    const query = moveChip(
      'table',
      rowsAndValues(),
      measChip(0, meas('revenue', 'sum'), 'decimal'),
      { well: 'axis', index: 0 },
    );
    // Row 1 IS query.axis on the wire — the dropped field becomes the new one.
    expect(query?.axis).toEqual(dim('revenue'));
    expect(query?.drillLevels).toEqual([dim('project_full_name'), dim('week_ending')]);
  });

  it('reorders inside Rows (row 3 to row 1) without leaving the well', () => {
    const query = moveChip(
      'table',
      rowsAndValues(),
      dimChip('axis', 1, dim('week_ending'), 'date'),
      { well: 'axis', index: 0 },
    );
    expect(query?.axis).toEqual(dim('week_ending'));
    expect(query?.drillLevels).toEqual([dim('project_full_name')]);
  });

  it('reorders inside Values — in a table, measure order IS column order', () => {
    const query = moveChip(
      'table',
      { ...rowsAndValues(), measures: [meas('a', 'sum'), meas('b', 'sum'), meas('c', 'sum')] },
      measChip(2, meas('c', 'sum'), 'decimal'),
      { well: 'values', index: 0 },
    );
    expect(query?.measures.map((m) => m.column)).toEqual(['c', 'a', 'b']);
  });

  it('refuses a move that would duplicate a field already in the target', () => {
    const query: ChartQuery = {
      axis: dim('project_full_name'),
      measures: [meas('project_full_name', 'min')],
      filters: [],
    };
    expect(
      moveChip('table', query, dimChip('axis', 0, dim('project_full_name'), 'text'), {
        well: 'values',
      }),
    ).toBeNull();
  });

  it('is a no-op when a chip is dropped back where it started', () => {
    expect(
      moveChip('table', rowsAndValues(), measChip(0, meas('revenue', 'sum'), 'decimal'), {
        well: 'values',
        index: 0,
      }),
    ).toBeNull();
  });
});

describe('moveChip — shapes that have no other form are refused', () => {
  const query = (): ChartQuery => ({
    axis: dim('region'),
    measures: [{ measureId: 'm-1' }, { ...meas('revenue', 'sum'), calc: { kind: 'ytd' } }],
    filters: [],
  });

  it('refuses a MODEL measure into Rows — it carries no column of its own', () => {
    const chipData = measChip(0, { measureId: 'm-1' }, null);
    expect(canDropChip('table', query(), chipData, { well: 'axis' })).toBe(false);
    expect(moveChip('table', query(), chipData, { well: 'axis' })).toBeNull();
  });

  it('refuses a measure carrying a quick calculation into Rows or Filters', () => {
    const chipData = measChip(1, { ...meas('revenue', 'sum'), calc: { kind: 'ytd' } }, 'decimal');
    expect(canDropChip('table', query(), chipData, { well: 'axis' })).toBe(false);
    expect(canDropChip('table', query(), chipData, { well: 'filters' })).toBe(false);
  });

  it('still lets both of them move between VALUES positions', () => {
    const moved = moveChip('table', query(), measChip(0, { measureId: 'm-1' }, null), {
      well: 'values',
      index: 1,
    });
    expect(moved?.measures[1]).toEqual({ measureId: 'm-1' });
  });
});

describe('moveChip — capacity: swap, never destroy', () => {
  const columnChart = (): ChartQuery => ({
    axis: dim('region'),
    legend: dim('status'),
    measures: [meas('revenue', 'sum')],
    filters: [],
  });

  it('SWAPS two one-chip dimension wells instead of dropping the occupant', () => {
    const query = moveChip('column', columnChart(), dimChip('legend', 0, dim('status'), 'text'), {
      well: 'axis',
    });
    expect(query?.axis).toEqual(dim('status'));
    expect(query?.legend).toEqual(dim('region'));
  });

  it('SWAPS scatter X and Y', () => {
    const scatter: ChartQuery = {
      legend: null,
      measures: [meas('cost', 'sum'), meas('revenue', 'sum')],
      filters: [],
    };
    const query = moveChip('scatter', scatter, measChip(0, meas('cost', 'sum'), 'decimal'), {
      well: 'values',
      slot: 1,
    });
    expect(query?.measures.map((m) => m.column)).toEqual(['revenue', 'cost']);
  });

  it('writes a SLOT swap in place — the later slots must not slide down one', () => {
    const gantt: ChartQuery = {
      axis: dim('task'),
      legend: dim('owner'),
      measures: [meas('started_at', 'min'), meas('finished_at', 'max'), meas('pct', 'sum')],
      filters: [],
    };
    const query = moveChip('gantt', gantt, dimChip('legend', 0, dim('owner'), 'text'), {
      well: 'values',
      slot: 0,
    });
    // Start becomes the owner column; End and Progress stay on slots 1 and 2.
    expect(query?.measures.map((m) => m.column)).toEqual(['owner', 'finished_at', 'pct']);
    expect(query?.legend).toEqual(dim('started_at'));
  });

  it('SWAPS into a values well that is already at its maximum (pie holds one)', () => {
    const pie: ChartQuery = {
      legend: dim('status'),
      measures: [meas('revenue', 'sum')],
      filters: [],
    };
    const query = moveChip('pie', pie, dimChip('legend', 0, dim('status'), 'text'), {
      well: 'values',
    });
    // The slice dimension became the measure; the measure became the slices.
    expect(query?.measures).toEqual([{ table: TABLE, column: 'status', aggregation: 'countDistinct' }]);
    expect(query?.legend).toEqual(dim('revenue'));
  });

  it('REFUSES the swap when the displaced chip has no form in the source well', () => {
    const withModelMeasure: ChartQuery = {
      axis: dim('region'),
      legend: dim('status'),
      measures: [{ measureId: 'm-1' }],
      filters: [],
    };
    const chipData = dimChip('legend', 0, dim('status'), 'text');
    // Values is full (pie max 1) and holds a MODEL measure, which cannot become
    // the legend dimension — so the drop is refused rather than eating it.
    expect(canDropChip('pie', withModelMeasure, chipData, { well: 'values' })).toBe(false);
    expect(moveChip('pie', withModelMeasure, chipData, { well: 'values' })).toBeNull();
  });
});

describe('moveChip — filters', () => {
  const withFilter = (): ChartQuery => ({
    axis: dim('region'),
    legend: dim('status'),
    measures: [meas('revenue', 'sum')],
    filters: [clause('client')],
  });

  it('never lands a chip in Filters directly — the FilterEditor detour owns that', () => {
    expect(
      moveChip('column', withFilter(), dimChip('legend', 0, dim('status'), 'text'), {
        well: 'filters',
      }),
    ).toBeNull();
    // …but the well still accepts the drag, so it does not read as forbidden.
    expect(
      canDropChip('column', withFilter(), dimChip('legend', 0, dim('status'), 'text'), {
        well: 'filters',
      }),
    ).toBe(true);
  });

  it('moves a filter FIELD into an empty well, dropping the clause', () => {
    const query = moveChip('column', withFilter(), filterChip(0, clause('client'), 'text'), {
      well: 'smallMultiples',
    });
    expect(query?.filters).toEqual([]);
    expect(query?.smallMultiples).toEqual(dim('client'));
  });

  it('refuses a filter into an OCCUPIED one-chip well — the displaced chip would need an operator', () => {
    const chipData = filterChip(0, clause('client'), 'text');
    expect(canDropChip('column', withFilter(), chipData, { well: 'legend' })).toBe(false);
    expect(moveChip('column', withFilter(), chipData, { well: 'legend' })).toBeNull();
  });
});

describe('moveChip — date grain follows the well it lands in', () => {
  it('keeps a table ROW date exact and buckets it when it moves to Columns', () => {
    const query: ChartQuery = { axis: dim('week_ending'), measures: [], filters: [] };
    const moved = moveChip('table', query, dimChip('axis', 0, dim('week_ending'), 'date'), {
      well: 'legend',
    });
    expect(moved?.legend?.dateBucket).toBe('month');
  });

  it('preserves a grain the user already chose', () => {
    const query: ChartQuery = { axis: dim('week_ending', 'year'), measures: [], filters: [] };
    const moved = moveChip('column', query, dimChip('axis', 0, dim('week_ending', 'year'), 'date'), {
      well: 'legend',
    });
    expect(moved?.legend?.dateBucket).toBe('year');
  });

  it('lands a bucketed date in a table’s Rows unbucketed once it is a measure round-trip', () => {
    const query: ChartQuery = {
      axis: dim('project_full_name'),
      measures: [meas('week_ending', 'min')],
      filters: [],
    };
    const moved = moveChip('table', query, measChip(0, meas('week_ending', 'min'), 'date'), {
      well: 'axis',
    });
    expect(moved?.drillLevels).toEqual([dim('week_ending')]);
  });
});

/* ----------------------------------------------- the index-remap hazard */

const spec = (type: ChartType, query: ChartQuery, format: ChartFormat = {}): ChartSpec => ({
  id: 'chart-1',
  type,
  title: 'T',
  query,
  format,
});

describe('remapIndexedRefs — everything that addresses a field BY POSITION', () => {
  const table = (): ChartSpec =>
    spec(
      'table',
      {
        axis: dim('project_full_name'),
        measures: [meas('revenue', 'sum'), meas('cost', 'sum')],
        filters: [],
        sort: [{ target: { kind: 'measure', index: 1 }, direction: 'desc' }],
      },
      {
        seriesLabels: { 'Sum of cost': 'Cost' },
        table: {
          columnWidths: { dim0: 100, meas0: 80, meas1: 90 },
          columnOrder: ['dim0', 'meas1', 'meas0'],
          columnAlign: { meas1: 'right' },
          dateAggregation: { meas1: 'latest' },
        },
      },
    );

  const moved = (before: ChartSpec, query: ChartQuery | null): ChartSpec =>
    remapIndexedRefs(before, { ...before, query: query ?? before.query });

  it('follows a measure that changed position (sort target + every meas{i} key)', () => {
    const before = table();
    const after = moved(
      before,
      moveChip('table', before.query, measChip(0, meas('revenue', 'sum'), 'decimal'), {
        well: 'values',
        index: 1,
      }),
    );
    expect(after.query.measures.map((m) => m.column)).toEqual(['cost', 'revenue']);
    // "cost" was measure 1 and is now measure 0 — the sort must still rank by cost.
    expect(after.query.sort).toEqual([{ target: { kind: 'measure', index: 0 }, direction: 'desc' }]);
    expect(after.format.table?.columnWidths).toEqual({ dim0: 100, meas1: 80, meas0: 90 });
    expect(after.format.table?.columnOrder).toEqual(['dim0', 'meas0', 'meas1']);
    expect(after.format.table?.columnAlign).toEqual({ meas0: 'right' });
    expect(after.format.table?.dateAggregation).toEqual({ meas0: 'latest' });
  });

  it('drops a sort rule and the layout keys of a measure that LEFT the values well', () => {
    const before = table();
    const after = moved(
      before,
      moveChip('table', before.query, measChip(1, meas('cost', 'sum'), 'decimal'), {
        well: 'axis',
      }),
    );
    expect(after.query.measures.map((m) => m.column)).toEqual(['revenue']);
    // The rule ranked by "cost", which is no longer a measure at all — silently
    // re-pointing it at whatever slid into index 1 would sort by the wrong thing.
    expect(after.query.sort).toBeUndefined();
    // "cost" became row 2, so a SECOND wire dimension appeared; the surviving
    // measure keeps meas0 and the dropped one's keys are gone.
    expect(after.format.table?.columnWidths).toEqual({ dim0: 100, meas0: 80 });
    expect(after.format.table?.columnAlign).toEqual({});
  });

  it('leaves the LABEL-keyed style maps alone — they were never positional', () => {
    const before = table();
    const after = moved(
      before,
      moveChip('table', before.query, measChip(0, meas('revenue', 'sum'), 'decimal'), {
        well: 'values',
        index: 1,
      }),
    );
    expect(after.format.seriesLabels).toEqual({ 'Sum of cost': 'Cost' });
  });

  it('re-points dimension sort targets when a dimension is inserted before them', () => {
    const before = spec('column', {
      axis: dim('region'),
      smallMultiples: dim('year_label'),
      measures: [meas('revenue', 'sum')],
      filters: [],
      sort: [{ target: { kind: 'dimension', index: 1 }, direction: 'asc' }],
    });
    // A legend lands BETWEEN the axis and small multiples on the wire.
    const after = remapIndexedRefs(before, {
      ...before,
      query: { ...before.query, legend: dim('status') },
    });
    expect(after.query.sort).toEqual([{ target: { kind: 'dimension', index: 2 }, direction: 'asc' }]);
  });

  it('clears the manual category order when the level-0 dimension is replaced', () => {
    const before = spec(
      'column',
      {
        axis: dim('region'),
        legend: dim('status'),
        measures: [meas('revenue', 'sum')],
        filters: [],
      },
      { categoryOrder: ['North', 'South'], seriesOrder: ['Open', 'Closed'] },
    );
    const after = moved(
      before,
      moveChip('column', before.query, dimChip('legend', 0, dim('status'), 'text'), {
        well: 'axis',
      }),
    );
    expect(after.query.axis).toEqual(dim('status'));
    expect(after.format.categoryOrder).toBeUndefined();
    // seriesOrder keys on the series LABEL, so the swap leaves it alone.
    expect(after.format.seriesOrder).toEqual(['Open', 'Closed']);
  });

  it('returns the spec untouched when nothing moved (an aggregation edit)', () => {
    const before = table();
    const after = remapIndexedRefs(before, {
      ...before,
      query: { ...before.query, measures: [meas('revenue', 'avg'), meas('cost', 'sum')] },
    });
    expect(after.query.sort).toEqual([{ target: { kind: 'measure', index: 1 }, direction: 'desc' }]);
    expect(after.format.table?.columnWidths).toEqual({ dim0: 100, meas0: 80, meas1: 90 });
  });
});
