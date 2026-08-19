// @vitest-environment jsdom
/**
 * ITEM 6 (frontend) — field-level validation reaches the WELLS.
 *
 * chartValidation already tagged every ChartIssue with the well that owns it,
 * and the server has carried a structured issue channel end-to-end for the
 * model editor for ages — but Wells.tsx never read either one, so a bad field
 * showed up only as an anonymous line in the summary list (or, for a server
 * fault, as a generic error card on the preview).
 *
 * Now: client issues AND server RcdApiError.issues (mapped through pathToWell,
 * whose wire-index arithmetic is covered in dashboards-core's
 * chartValidation.test.ts) badge the offending well with a red ring, a warning
 * glyph on its label, and a tooltip listing that well's messages.
 */
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pathToWell,
  type ChartIssue,
  type ChartQuery,
  type ChartSpec,
  type ChartType,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { Wells, issueMessagesFor } from '../src/chart-builder/Wells';

const MODEL: ModelDefinition = {
  version: 1,
  tables: [
    { schema: 'public', name: 'orders' },
    { schema: 'public', name: 'customers' },
  ],
  relationships: [],
  measures: [
    {
      id: 'm-total',
      name: 'Total',
      table: 'public.orders',
      aggregation: 'sum',
      column: 'order_total',
    },
  ],
};

const dim = (column: string) => ({ table: 'public.orders', column });

const TABLE_QUERY: ChartQuery = {
  axis: dim('region'),
  drillLevels: [dim('city')],
  legend: dim('status'),
  measures: [{ measureId: 'm-total' }],
  filters: [{ table: 'public.orders', column: 'status', operator: 'eq', values: ['open'] }],
};

const COLUMN_QUERY: ChartQuery = {
  axis: dim('region'),
  drillLevels: [dim('city')],
  legend: dim('status'),
  measures: [{ measureId: 'm-total' }],
  filters: [],
};

const issue = (well: ChartIssue['well'], message: string): ChartIssue => ({
  severity: 'error',
  code: 'unknown_column',
  message,
  ...(well !== undefined ? { well } : {}),
});

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

const renderWells = (
  chartType: ChartType,
  query: ChartQuery,
  issues: ChartIssue[] | undefined,
): void => {
  act(() => {
    root.render(
      <DndContext>
        <Wells
          chartType={chartType}
          query={query}
          model={MODEL}
          catalog={null}
          issues={issues}
          onChange={() => {}}
          onEditFilter={() => {}}
        />
      </DndContext>,
    );
  });
};

/** Every tooltip string currently on the page. */
const tooltips = (): string[] =>
  Array.from(host.querySelectorAll('[title]')).map((el) => el.getAttribute('title') ?? '');

/** aria-labels of the warning glyphs Wells renders next to flagged labels. */
const glyphLabels = (): string[] =>
  Array.from(host.querySelectorAll('[aria-label$="issues"]')).map(
    (el) => el.getAttribute('aria-label') ?? '',
  );

const ringCount = (): number => host.querySelectorAll('.ring-1').length;

describe('issueMessagesFor', () => {
  const tableRows = { id: 'axis', capacity: 'many' } as const;
  const cartesianAxis = { id: 'axis', capacity: 'one' } as const;

  it('collects the messages tagged with that well', () => {
    const issues = [issue('legend', 'bad legend'), issue('values', 'bad measure')];
    expect(issueMessagesFor({ id: 'legend', capacity: 'one' }, issues)).toEqual(['bad legend']);
    expect(issueMessagesFor({ id: 'values', capacity: 'many' }, issues)).toEqual(['bad measure']);
  });

  it("routes 'drill' onto the TABLE's multi-field Rows well", () => {
    const issues = [issue('drill', 'bad row 2')];
    expect(issueMessagesFor(tableRows, issues)).toEqual(['bad row 2']);
    // A cartesian axis holds one chip; its levels live in the DrillSection.
    expect(issueMessagesFor(cartesianAxis, issues)).toEqual([]);
  });

  it('is empty for an absent list and for untagged issues', () => {
    expect(issueMessagesFor(tableRows, undefined)).toEqual([]);
    expect(issueMessagesFor(tableRows, [issue(undefined, 'no well')])).toEqual([]);
  });
});

describe('Wells badging', () => {
  it('renders no ring, glyph or tooltip when nothing is wrong', () => {
    renderWells('table', TABLE_QUERY, []);
    expect(ringCount()).toBe(0);
    expect(glyphLabels()).toEqual([]);
  });

  it('badges the table Rows well for a drill-level issue', () => {
    renderWells('table', TABLE_QUERY, [issue('drill', "Column 'city' does not exist.")]);
    expect(glyphLabels()).toEqual(['Rows has issues']);
    expect(tooltips()).toContain("Column 'city' does not exist.");
    expect(ringCount()).toBe(1);
  });

  it('badges only the offending well, never its neighbours', () => {
    renderWells('column', COLUMN_QUERY, [issue('legend', 'bad legend')]);
    expect(glyphLabels()).toEqual(['Legend has issues']);
    expect(ringCount()).toBe(1);
  });

  it('lists EVERY message of one well in its tooltip', () => {
    renderWells('table', TABLE_QUERY, [
      issue('values', 'first problem'),
      issue('values', 'second problem'),
      issue('legend', 'elsewhere'),
    ]);
    expect(tooltips()).toContain('first problem\nsecond problem');
    expect(glyphLabels().sort()).toEqual(['Columns has issues', 'Values has issues']);
  });

  it('badges the cartesian DRILL sub-area, not the axis chip', () => {
    renderWells('column', COLUMN_QUERY, [issue('drill', 'bad drill level')]);
    expect(glyphLabels()).toEqual(['Drill levels have issues']);
    expect(tooltips()).toContain('bad drill level');
    // The drill sub-area recolors its rule instead of ringing a drop box.
    expect(ringCount()).toBe(0);
    expect(host.querySelectorAll('.border-\\[var\\(--rcd-status-critical\\)\\]').length).toBe(1);
  });

  it('badges the filters well', () => {
    renderWells('table', TABLE_QUERY, [issue('filters', 'bad filter')]);
    expect(glyphLabels()).toEqual(['Filters on this chart has issues']);
    expect(tooltips()).toContain('bad filter');
  });

  it('renders sort/limit issues inline — that section has no drop box', () => {
    renderWells('table', TABLE_QUERY, [issue('sort', 'Sort references dimension 4.')]);
    expect(host.textContent).toContain('Sort references dimension 4.');
    expect(glyphLabels()).toEqual([]);
    expect(ringCount()).toBe(0);
  });
});

describe('server issues reach the wells through pathToWell', () => {
  const matrixSpec: ChartSpec = {
    id: 'c1',
    type: 'table',
    title: 'T',
    query: TABLE_QUERY,
    format: {},
  };

  /** The ChartBuilder mapping, in miniature. */
  const mapServerIssues = (
    raw: { code: string; severity: string; message: string; path: string | null }[],
    spec: ChartSpec,
  ): ChartIssue[] =>
    raw.map((i): ChartIssue => {
      const well = i.path !== null ? pathToWell(i.path, spec) : undefined;
      return {
        severity: i.severity === 'warning' ? 'warning' : 'error',
        code: i.code,
        message: i.message,
        ...(well !== undefined ? { well } : {}),
        ...(i.path !== null ? { path: i.path } : {}),
      };
    });

  it('lands a dimensions[1] fault on the matrix table Rows well', () => {
    // Wire order for this spec: [axis, city(drill), status(legend)].
    const mapped = mapServerIssues(
      [
        {
          code: 'rcd.query.unknown_column',
          severity: 'error',
          message: "Column 'city' does not exist on 'public.orders'.",
          path: 'dimensions[1].column',
        },
      ],
      matrixSpec,
    );
    expect(mapped[0]!.well).toBe('drill');

    renderWells('table', TABLE_QUERY, mapped);
    expect(glyphLabels()).toEqual(['Rows has issues']);
    expect(tooltips()).toContain("Column 'city' does not exist on 'public.orders'.");
  });

  it('lands a measures[0].aggregation fault on Values', () => {
    const mapped = mapServerIssues(
      [
        {
          code: 'rcd.query.bad_measure',
          severity: 'error',
          message: 'sum is not valid for that column.',
          path: 'measures[0].aggregation',
        },
      ],
      matrixSpec,
    );
    expect(mapped[0]!.well).toBe('values');
    renderWells('table', TABLE_QUERY, mapped);
    expect(glyphLabels()).toEqual(['Values has issues']);
  });

  it('keeps a pathless server issue out of every well (summary list only)', () => {
    const mapped = mapServerIssues(
      [
        {
          code: 'rcd.query.disconnected',
          severity: 'error',
          message: 'These tables are not connected.',
          path: null,
        },
      ],
      matrixSpec,
    );
    expect(mapped[0]!.well).toBeUndefined();
    expect(mapped[0]!.path).toBeUndefined();

    renderWells('table', TABLE_QUERY, mapped);
    expect(glyphLabels()).toEqual([]);
    expect(ringCount()).toBe(0);
  });
});
