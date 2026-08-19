// Client-side mirror of the backend's query-compilation checks (QueryCompiler /
// SpecValueConverter / JoinPathResolver), so the builder can flag problems
// before a spec ever reaches POST /query. Codes mirror the server's
// rcd.query.* suffixes ('disconnected', 'unknown_column', …) and messages use
// the server's own wording, so the ChartTile error map covers both paths.
import { isMatrixChart, type ChartSpec } from '../types/chart';
import type {
  Aggregation,
  Measure,
  ModelDefinition,
  Relationship,
} from '../types/model';
import { DATE_TABLE_COLUMNS, dateTableKey, tableKey } from '../types/model';
import type { DimensionRef, MeasureRef, SortSpec } from '../types/query';
import type { Catalog, ColumnType } from '../types/schema';
import { isNumericType, isQueryableType, isTemporalType } from '../types/schema';

export interface ChartIssue {
  severity: 'error' | 'warning';
  /** Mirrors the server's rcd.query.* suffixes: 'disconnected', 'unknown_column', … */
  code: string;
  /** Actionable, same tone as the server messages. */
  message: string;
  well?: 'axis' | 'drill' | 'legend' | 'smallMultiples' | 'values' | 'filters' | 'sort';
  /**
   * WIRE-shaped location of the fault, in the pinned grammar shared with the
   * backend's ValidationIssue.Path (i = wire index):
   *   "query.table" | "dimensions[i]" | "dimensions[i].column" |
   *   "dimensions[i].dateBucket" | "measures[i]" | "measures[i].column" |
   *   "measures[i].aggregation" | "measures[i].expression" | "filters[i]" |
   *   "filters[i].column" | "filters[i].values" | "sort[i]" | "having[i]" |
   *   "limit"
   * Absent for issues without a wire address (reachability, non-wire drill
   * levels). Map back onto a builder well with pathToWell.
   */
  path?: string;
}

/* Mirrors of the server's RcdLimits defaults (hosts can raise them server-side,
 * but the seeded defaults are the contract the builder validates against). */
const MAX_DIMENSIONS = 8;
const MAX_MEASURES = 16;
const MAX_FILTERS = 32;
/** Server MaxRows default — the risk threshold for the missing-limit warning. */
const MAX_ROWS = 10_000;
/** Matrix tables: drill levels allowed BELOW the axis (axis + 3 = 4 row fields). */
const MAX_MATRIX_LEVELS = 3;

type Well = NonNullable<ChartIssue['well']>;

/**
 * Well tags of a spec's WIRE dimensions, in emission order (mirrors
 * toWireSpec): matrix tables [axis, drill…, legend], everything else
 * [axis, legend, smallMultiples] — absent parts skipped, so the array index
 * IS the wire dimension index.
 */
export function wireDimensionWells(spec: ChartSpec): Well[] {
  const query = spec.query;
  const wells: Well[] = [];
  if (query.axis) wells.push('axis');
  if (isMatrixChart(spec)) {
    const drills = query.drillLevels?.length ?? 0;
    for (let i = 0; i < drills; i++) wells.push('drill');
  }
  if (query.legend) wells.push('legend');
  if (query.smallMultiples) wells.push('smallMultiples');
  return wells;
}

/**
 * Maps a wire path (the pinned grammar above — the backend's
 * ValidationIssue.Path speaks it too) onto the builder well that owns it.
 * Dimension indexes resolve against the SPEC's own wire order, so a matrix
 * table's dimensions[2] lands on the right Rows level while a cartesian's
 * dimensions[1] lands on the legend. Undefined = no single well (query.table,
 * unknown shapes, out-of-range indexes).
 */
export function pathToWell(path: string, spec: ChartSpec): Well | undefined {
  const head = /^(\w+)(?:\[(\d+)\])?/.exec(path);
  if (!head) return undefined;
  switch (head[1]) {
    case 'measures':
      return 'values';
    case 'filters':
    case 'having':
      return 'filters';
    case 'sort':
    case 'limit':
      return 'sort';
    case 'dimensions': {
      const index = head[2] !== undefined ? Number(head[2]) : NaN;
      if (!Number.isInteger(index)) return undefined;
      return wireDimensionWells(spec)[index];
    }
    default:
      return undefined;
  }
}

/** What a (table, column) lookup could establish. */
interface ColumnLookup {
  /** 'unknownTable' = not in the model; 'drifted' = model table gone from the catalog. */
  status: 'ok' | 'unknownTable' | 'drifted' | 'unknownColumn' | 'unverifiable';
  type?: ColumnType;
  rawType?: string;
}

/**
 * Validates an authored chart spec against its model (and, when available,
 * the connection catalog). Errors mirror server-side compilation failures and
 * should block save; warnings flag likely-broken or risky configurations but
 * allow save. Column-existence/type checks are skipped while `catalog` is
 * null (not loaded yet / connection unavailable) — the model is the only
 * authority we have then.
 */
export function validateChartSpec(
  spec: ChartSpec,
  model: ModelDefinition,
  catalog: Catalog | null,
): ChartIssue[] {
  const issues: ChartIssue[] = [];
  const add = (
    severity: ChartIssue['severity'],
    code: string,
    message: string,
    well?: Well,
    path?: string,
  ): void => {
    issues.push({
      severity,
      code,
      message,
      ...(well !== undefined ? { well } : {}),
      ...(path !== undefined ? { path } : {}),
    });
  };
  const error = (code: string, message: string, well?: Well, path?: string): void =>
    add('error', code, message, well, path);
  const warning = (code: string, message: string, well?: Well, path?: string): void =>
    add('warning', code, message, well, path);

  const modelTables = new Set(model.tables.map((t) => tableKey(t.schema, t.name)));
  const dateTables = new Set((model.dateTables ?? []).map((t) => dateTableKey(t.name)));
  const catalogByKey = new Map((catalog?.tables ?? []).map((t) => [t.key, t]));
  const dateColumnTypes = new Map(DATE_TABLE_COLUMNS.map((c) => [c.name, c.type]));

  const lookup = (table: string, column: string): ColumnLookup => {
    if (dateTables.has(table)) {
      const type = dateColumnTypes.get(column);
      return type === undefined ? { status: 'unknownColumn' } : { status: 'ok', type };
    }
    if (!modelTables.has(table)) return { status: 'unknownTable' };
    if (catalog === null) return { status: 'unverifiable' };
    const catalogTable = catalogByKey.get(table);
    if (catalogTable === undefined) return { status: 'drifted' };
    const catalogColumn = catalogTable.columns.find((c) => c.name === column);
    if (catalogColumn === undefined) return { status: 'unknownColumn' };
    return { status: 'ok', type: catalogColumn.type, rawType: catalogColumn.rawType };
  };

  /**
   * Shared table/column existence + queryability reporting; true when usable.
   * `path` is the WIRE address of the owning ref ("dimensions[0]",
   * "measures[2]", "filters[1]"); column-level faults report at
   * `${path}.column` per the pinned grammar.
   */
  const checkColumn = (
    table: string,
    column: string,
    well: Well,
    context: string,
    path?: string,
  ): ColumnLookup => {
    const columnPath = path === undefined ? undefined : `${path}.column`;
    const found = lookup(table, column);
    switch (found.status) {
      case 'unknownTable':
        error('unknown_table', `Table '${table}' is not part of the model.`, well, path);
        break;
      case 'drifted':
        error('unknown_table', `Table '${table}' no longer exists in the data source.`, well, path);
        break;
      case 'unknownColumn':
        error('unknown_column', `Column '${column}' does not exist on '${table}'.`, well, columnPath);
        break;
      case 'ok':
        if (!isQueryableType(found.type!)) {
          const raw = found.rawType !== undefined ? ` (${found.rawType})` : '';
          error(
            'bad_column',
            `${context} has type ${found.type}${raw} and cannot be used here.`,
            well,
            columnPath,
          );
        }
        break;
      default:
        break; // unverifiable: catalog not loaded — skip column checks
    }
    return found;
  };

  // Tables that BFS must reach (only ones that exist in the model — unknown
  // tables already produced their own error and would double-report).
  const involved = new Set<string>();
  const involve = (table: string): void => {
    if (modelTables.has(table) || dateTables.has(table)) involved.add(table);
  };

  /* ------------------------------------------------------------- dimensions */

  const query = spec.query;
  const matrix = isMatrixChart(spec);
  const checkDimension = (dimension: DimensionRef, well: Well, path?: string): void => {
    const found = checkColumn(
      dimension.table,
      dimension.column,
      well,
      `Column '${dimension.table}.${dimension.column}'`,
      path,
    );
    involve(dimension.table);
    if (
      dimension.dateBucket != null &&
      found.status === 'ok' &&
      isQueryableType(found.type!) &&
      !isTemporalType(found.type!)
    ) {
      error(
        'bad_bucket',
        `'${dimension.table}.${dimension.column}' is ${found.type}; date bucketing needs a date or timestamp column.`,
        well,
        path === undefined ? undefined : `${path}.dateBucket`,
      );
    }
  };

  // Wire dimension paths track toWireSpec's emission order; legacy (non-matrix)
  // drill levels never reach the wire, so they carry no path.
  let wireDimension = 0;
  if (query.axis) checkDimension(query.axis, 'axis', `dimensions[${wireDimension++}]`);
  for (const level of query.drillLevels ?? []) {
    checkDimension(level, 'drill', matrix ? `dimensions[${wireDimension++}]` : undefined);
  }
  if (query.legend) checkDimension(query.legend, 'legend', `dimensions[${wireDimension++}]`);
  if (query.smallMultiples) {
    checkDimension(query.smallMultiples, 'smallMultiples', `dimensions[${wireDimension++}]`);
  }

  /* --------------------------------------------------------------- measures */

  const measuresById = new Map<string, Measure>(model.measures.map((m) => [m.id, m]));

  const checkMeasure = (measure: MeasureRef, index: number): void => {
    const path = `measures[${index}]`;
    if (measure.measureId != null) {
      const found = measuresById.get(measure.measureId);
      if (found === undefined) {
        error(
          'unknown_measure',
          `The model has no measure with id ${measure.measureId}.`,
          'values',
          path,
        );
        return;
      }
      involve(found.table);
      if (!modelTables.has(found.table) && !dateTables.has(found.table)) {
        error('unknown_table', `Table '${found.table}' is not part of the model.`, 'values', path);
      }
      for (const filter of found.filters ?? []) involve(filter.table);
      return;
    }

    if (measure.table == null || measure.aggregation == null) {
      error(
        'bad_measure',
        'An inline measure needs a table and an aggregation (or reference a model measure by id).',
        'values',
        path,
      );
      return;
    }

    involve(measure.table);
    if (measure.column == null) {
      if (measure.aggregation !== 'count') {
        error(
          'bad_measure',
          `Only Count may omit the source column; ${measure.aggregation} needs one.`,
          'values',
          `${path}.column`,
        );
      } else if (!modelTables.has(measure.table) && !dateTables.has(measure.table)) {
        error('unknown_table', `Table '${measure.table}' is not part of the model.`, 'values', path);
      }
      return;
    }

    const found = checkColumn(
      measure.table,
      measure.column,
      'values',
      `Column '${measure.table}.${measure.column}'`,
      path,
    );
    if (
      found.status === 'ok' &&
      isQueryableType(found.type!) &&
      !aggregationValidFor(measure.aggregation, found.type!)
    ) {
      error(
        'bad_measure',
        `${measure.aggregation} is not valid for column '${measure.column}' of type ${found.type}.`,
        'values',
        `${path}.aggregation`,
      );
    }
  };

  if (query.measures.length === 0) {
    error('no_measures', 'A chart query needs at least one measure.', 'values');
  }
  query.measures.forEach((measure, index) => checkMeasure(measure, index));

  /* ---------------------------------------------------------------- filters */

  query.filters.forEach((filter, index) => {
    const path = `filters[${index}]`;
    const found = checkColumn(
      filter.table,
      filter.column,
      'filters',
      `Filter column '${filter.table}.${filter.column}'`,
      path,
    );
    involve(filter.table);
    if (
      (filter.operator === 'contains' || filter.operator === 'startsWith') &&
      found.status === 'ok' &&
      isQueryableType(found.type!) &&
      found.type !== 'text'
    ) {
      error(
        'bad_filter',
        `Filter on '${filter.table}.${filter.column}': ${filter.operator} only applies to text columns; '${filter.column}' is ${found.type}.`,
        'filters',
        path,
      );
    }
  });

  /* ------------------------------------------------------------------- sort */

  // Wire dimension order mirrors toWireSpec: matrix tables emit
  // [axis, drill…, legend]; everything else [axis, legend, smallMultiples].
  const wireDimensionCount = wireDimensionWells(spec).length;
  (query.sort ?? []).forEach((sort, index) =>
    checkSort(sort, index, wireDimensionCount, query.measures.length, error),
  );

  /* ----------------------------------------------------------- count limits */

  // Matrix drill levels ARE wire dimensions (already counted); legacy drill
  // levels each become the axis at some drill depth, so they count too.
  const dimensionCount = wireDimensionCount + (matrix ? 0 : (query.drillLevels?.length ?? 0));
  if (dimensionCount > MAX_DIMENSIONS) {
    error('too_many_dimensions', `At most ${MAX_DIMENSIONS} dimensions are allowed.`);
  }
  if (matrix && (query.drillLevels?.length ?? 0) > MAX_MATRIX_LEVELS) {
    // Points at the FIRST Rows field over the cap (wire index axis + cap + 1);
    // 'drill' badges the table's multi-field Rows well, same as its levels do.
    error(
      'too_many_dimensions',
      `A table row hierarchy holds the first Rows field plus at most ${MAX_MATRIX_LEVELS} more — remove some Rows fields or turn the row hierarchy off.`,
      'drill',
      `dimensions[${1 + MAX_MATRIX_LEVELS}]`,
    );
  }
  if (query.measures.length > MAX_MEASURES) {
    error('too_many_measures', `At most ${MAX_MEASURES} measures are allowed.`, 'values');
  }
  if (query.filters.length > MAX_FILTERS) {
    error('too_many_filters', `At most ${MAX_FILTERS} filters are allowed.`, 'filters');
  }

  /* ---------------------------------------------------------- reachability */

  checkReachability(spec, model, involved, measuresById, error, warning);

  /* ------------------------------------------------- chart-type completeness */

  if (spec.type === 'scatter' && query.measures.length < 2) {
    warning(
      'chart_incomplete',
      'A scatter chart plots the first measure on X and the second on Y — add a second measure.',
      'values',
    );
  }
  if (spec.type === 'gantt' && query.measures.length < 2) {
    warning(
      'chart_incomplete',
      'A Gantt chart needs a start measure (first) and an end measure (second).',
      'values',
    );
  }
  if (spec.type === 'kpi' && query.legend) {
    warning('chart_incomplete', 'A KPI shows a single value; the legend split is ignored.', 'legend');
  }

  /* -------------------------------------------------- row-cap risk (topN) */

  if (query.axis && query.limit == null && catalog !== null) {
    const axisTable = catalogByKey.get(query.axis.table);
    const rowEstimate = axisTable?.rowEstimate;
    // Only warn when cheaply knowable: the catalog's table row estimate.
    if (rowEstimate != null && rowEstimate > MAX_ROWS) {
      warning(
        'high_cardinality',
        `'${query.axis.table}' holds roughly ${Math.round(rowEstimate).toLocaleString()} rows; without a Top N or row limit this chart may hit the server's row cap and truncate.`,
        'axis',
      );
    }
  }

  return issues;
}

/** Mirror of the backend's IsAggregationCompatible (QueryCompiler). */
const aggregationValidFor = (aggregation: Aggregation, type: ColumnType): boolean => {
  if (type === 'other') return false;
  switch (aggregation) {
    case 'sum':
    case 'avg':
    case 'stdDev':
    case 'variance':
    case 'median':
      return isNumericType(type);
    case 'min':
    case 'max':
      return isNumericType(type) || isTemporalType(type) || type === 'text';
    case 'count':
    case 'countDistinct':
      return true;
    default:
      return false;
  }
};

const checkSort = (
  sort: SortSpec,
  sortIndex: number,
  dimensionCount: number,
  measureCount: number,
  error: (code: string, message: string, well?: Well, path?: string) => void,
): void => {
  const { kind, index } = sort.target;
  if (kind === 'dimension' && (index < 0 || index >= dimensionCount)) {
    error(
      'bad_sort',
      `Sort references dimension ${index}, which does not exist.`,
      'sort',
      `sort[${sortIndex}]`,
    );
  } else if (kind === 'measure' && (index < 0 || index >= measureCount)) {
    error(
      'bad_sort',
      `Sort references measure ${index}, which does not exist.`,
      'sort',
      `sort[${sortIndex}]`,
    );
  }
};

/**
 * BFS over ACTIVE model relationships from the base table (the first
 * measure's table, matching the server's join planning). Disconnected tables
 * are errors in the server's own wording; equal-shortest-path ambiguity —
 * which the server rejects at query time — surfaces here as a warning so the
 * author can fix the model before the first failed query.
 */
const checkReachability = (
  spec: ChartSpec,
  model: ModelDefinition,
  involved: Set<string>,
  measuresById: Map<string, Measure>,
  error: (code: string, message: string, well?: Well) => void,
  warning: (code: string, message: string, well?: Well) => void,
): void => {
  const first = spec.query.measures[0];
  if (first === undefined) return;
  const base =
    first.measureId != null ? measuresById.get(first.measureId)?.table : (first.table ?? undefined);
  if (base === undefined) return;

  const active = model.relationships.filter((r) => r.isActive);
  const adjacency = new Map<string, { neighbor: string; via: Relationship }[]>();
  const addEdge = (from: string, to: string, via: Relationship): void => {
    const list = adjacency.get(from) ?? [];
    list.push({ neighbor: to, via });
    adjacency.set(from, list);
  };
  for (const rel of [...active].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    addEdge(rel.fromTable, rel.toTable, rel);
    addEdge(rel.toTable, rel.fromTable, rel);
  }

  // Mirror of JoinPathResolver: depth + predecessor + same-depth ambiguity.
  const depth = new Map<string, number>([[base, 0]]);
  const predecessor = new Map<string, string>();
  const ambiguous = new Set<string>();
  const queue: string[] = [base];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const { neighbor } of adjacency.get(current) ?? []) {
      const existing = depth.get(neighbor);
      if (existing === undefined) {
        depth.set(neighbor, depth.get(current)! + 1);
        predecessor.set(neighbor, current);
        queue.push(neighbor);
      } else if (existing === depth.get(current)! + 1 && predecessor.get(neighbor) !== current) {
        ambiguous.add(neighbor);
      }
    }
  }

  const reportedAmbiguous = new Set<string>();
  for (const required of [...involved].sort()) {
    if (!depth.has(required)) {
      error(
        'disconnected',
        `Table '${required}' is not connected to '${base}' through any active relationship. Add a relationship between them on the model canvas.`,
      );
      continue;
    }
    // Walk the predecessor chain: ambiguity anywhere on the path matters.
    let walk = required;
    while (walk !== base) {
      if (ambiguous.has(walk) && !reportedAmbiguous.has(walk)) {
        reportedAmbiguous.add(walk);
        warning(
          'ambiguous_path',
          `There are multiple equally short relationship paths to '${walk}'. Deactivate one of the competing relationships so the join path is unambiguous.`,
        );
      }
      walk = predecessor.get(walk)!;
    }
  }
};
