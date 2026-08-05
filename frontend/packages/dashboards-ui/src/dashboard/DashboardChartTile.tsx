import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { ArrowDown, ArrowUp, ChevronsDown, CornerUpLeft } from 'lucide-react';
import {
  stableStringify,
  toWireSpec,
  type CellValue,
  type ChartPointEvent,
  type ChartSpec,
  type DashboardParameter,
  type DimensionRef,
  type FilterClause,
  type FilterValue,
  type QueryColumn,
  type QueryResult,
  type SortSpec,
} from '@recon/dashboards-core';
import {
  ChartTile,
  type ChartHavingClause,
  type ChartLegendSelectEvent,
  type ChartTableLayoutPatch,
  type ChartTableSort,
  type TableColumnFilter,
} from '../chart/ChartTile';
import type { ChartDatumClickInfo } from '../chart/ChartRenderer';
import { useDashboardState, useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { RcdIconButton } from '../primitives';
import { TileFrame } from './TileFrame';

/**
 * One traversed drill step. A concrete entry filters the deeper level to the
 * clicked value (null value = the blank category -> isNull clause); a null
 * SLOT means the level was entered via "go to next level" (axis swaps, no
 * filter) — the DrillState contract's path entries, extended with that
 * filterless case. Transient component state, NEVER persisted.
 */
type DrillPathSlot = { value: FilterValue | null; label: string } | null;

interface TileDrill {
  level: number;
  path: DrillPathSlot[];
}

const DRILL_ROOT: TileDrill = { level: 0, path: [] };

/** Transient interactive-table state (sort + page); resets with the query. */
interface TileTableState {
  sort: (ChartTableSort & { target: SortSpec['target'] }) | null;
  page: number;
}

const TABLE_ROOT: TileTableState = { sort: null, page: 0 };

const NO_TABLE_FILTERS: TableColumnFilter[] = [];

/** A chart's dimensions in wire order [axis, legend, smallMultiples] (mirrors toWireSpec). */
const wireDimensionsOf = (chart: ChartSpec): DimensionRef[] => {
  const dims: DimensionRef[] = [];
  if (chart.query.axis) dims.push(chart.query.axis);
  if (chart.query.legend) dims.push(chart.query.legend);
  if (chart.query.smallMultiples) dims.push(chart.query.smallMultiples);
  return dims;
};

type HavingOperator = ChartHavingClause['operator'];

/** Table-filter condition operators expressible as wire HAVING conditions. */
const HAVING_OPERATORS: ReadonlySet<string> = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
]);

/**
 * Translates the renderer's per-column header filters into wire terms, mapped
 * through the RESULT columns onto the effective spec:
 * - DIMENSION columns -> FilterClauses ('values' -> in, null-only -> isNull;
 *   conditions map 1:1 onto FilterOperators, 'between' takes two values);
 * - MEASURE columns -> HAVING entries {measureIndex, operator, values}
 *   (numeric conditions only — contains/startsWith and value lists have no
 *   post-aggregation wire form and are dropped).
 */
const translateTableFilters = (
  list: TableColumnFilter[],
  columns: QueryColumn[] | undefined,
  dims: DimensionRef[],
): { clauses: FilterClause[]; having: ChartHavingClause[] } => {
  const clauses: FilterClause[] = [];
  const having: ChartHavingClause[] = [];
  if (!columns || list.length === 0) return { clauses, having };
  const dimNames = columns.filter((c) => c.role === 'dimension').map((c) => c.name);
  const measureNames = columns.filter((c) => c.role === 'measure').map((c) => c.name);
  for (const filter of list) {
    const dimIndex = dimNames.indexOf(filter.column);
    if (dimIndex !== -1) {
      const dim = dims[dimIndex];
      if (!dim) continue;
      if (filter.kind === 'values') {
        const nonNull = filter.values.filter((v): v is FilterValue => v !== null);
        if (nonNull.length === 0 && filter.values.length > 0) {
          // Only the blank entry checked: keep exactly the null rows.
          clauses.push({ table: dim.table, column: dim.column, operator: 'isNull', values: [] });
        } else if (nonNull.length > 0) {
          clauses.push({ table: dim.table, column: dim.column, operator: 'in', values: nonNull });
        }
      } else {
        const values =
          filter.operator === 'between' ? filter.values.slice(0, 2) : filter.values;
        clauses.push({ table: dim.table, column: dim.column, operator: filter.operator, values });
      }
      continue;
    }
    const measureIndex = measureNames.indexOf(filter.column);
    if (measureIndex === -1 || filter.kind !== 'condition') continue;
    if (!HAVING_OPERATORS.has(filter.operator)) continue;
    const numbers = filter.values
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => Number.isFinite(n));
    const needed = filter.operator === 'between' ? 2 : 1;
    if (numbers.length < needed) continue;
    having.push({
      measureIndex,
      operator: filter.operator as HavingOperator,
      values: filter.operator === 'between' ? numbers.slice(0, 2) : numbers.slice(0, 1),
    });
  }
  return { clauses, having };
};

/** Drill operations the point context menu drives (exposed via reportEffective). */
export interface TileDrillApi {
  /** True when the chart has a hierarchy and a deeper level exists. */
  canDrillDeeper: boolean;
  /** Current drill level (0 = the chart's own axis). */
  level: number;
  /** Drills into the clicked point's value (works with drill mode OFF). */
  drillDownInto: (e: ChartPointEvent) => void;
  drillUp: () => void;
  /** Resets the whole drill state back to the original chart. */
  resetDrill: () => void;
}

/** What a chart tile reports it is CURRENTLY showing (ref-style, every render). */
export interface TileEffectiveState {
  /** Effective (param-substituted + drilled) chart spec. */
  chart: ChartSpec;
  /** Dashboard-level filters merged into the tile's fetch (incl. any table
   *  dimension-column filters). */
  filters: FilterClause[];
  /** Post-aggregation measure conditions (table measure-column filters);
   *  merged into wire specs built from this state (CSV export). */
  having?: ChartHavingClause[];
  /** Drill runtime for the point context menu; null = no hierarchy. */
  drill: TileDrillApi | null;
}

export interface DashboardChartTileProps {
  tileId: string;
  /** BASE chart spec from the layout doc (param/drill derivation happens here). */
  chart: ChartSpec;
  modelId: number | null;
  editable: boolean;
  selected: boolean;
  /**
   * Refresh token from the dashboard/tile refresh counters. Passed to
   * ChartTile as a PROP (not a React key): the tile stays mounted and keeps
   * its previous chart visible (dimmed, updating bar) while the refetch runs.
   */
  refreshKey: string;
  /** Dashboard-level filters (slicers + cards + cross-filter + drillthrough). */
  filters: FilterClause[];
  /** Category label while this tile is the AXIS cross-filter source (dims others). */
  activeCategoryLabel: string | null;
  /** Legend label while this tile is the LEGEND cross-filter source (emphasis). */
  selectedLegendLabel: string | null;
  onSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Edit-mode right-click on the tile (opens the chart context card). */
  onTileContextMenu?: (position: { x: number; y: number }) => void;
  /** Cross-filter datum click, called with the EFFECTIVE (drilled) chart. */
  onCrossFilter: (chart: ChartSpec, info: ChartDatumClickInfo) => void;
  /**
   * Legend cross-filter selection (legendMode 'crossFilter'), called with the
   * EFFECTIVE (drilled) chart; null event = clear the page-wide filter.
   */
  onLegendSelect: (chart: ChartSpec, e: ChartLegendSelectEvent | null) => void;
  /** Point right-click (view mode): the EFFECTIVE chart + point payload. */
  onPointMenu?: (payload: { tileId: string; chart: ChartSpec; event: ChartPointEvent }) => void;
  /**
   * View-mode right-click anywhere on the tile that did NOT hit a chart point
   * (KPIs, empty plot area, headers): opens the chart-level context menu with
   * the EFFECTIVE chart. Every chart type gets a menu through this.
   */
  onChartMenu?: (payload: {
    tileId: string;
    chart: ChartSpec;
    position: { x: number; y: number };
  }) => void;
  /**
   * Ref-style report of what this tile is CURRENTLY showing (effective spec +
   * filters + drill runtime) — the export menus build the exact wire spec from
   * it and the point context menu drives drill actions through it.
   */
  reportEffective: (tileId: string, effective: TileEffectiveState) => void;
}

/**
 * Substitutes field-parameter bindings into a chart's query: 'axis' replaces
 * the axis dimension (incl. its dateBucket) with the parameter's selected
 * option; 'measures' REPLACES the measure list with the selected measure.
 * Runs BEFORE drill/filter derivation, so drills and cross-filters operate on
 * the substituted dimension. Unbound charts pass through untouched.
 */
const applyParamBindings = (
  chart: ChartSpec,
  parameters: DashboardParameter[] | null,
  selections: Record<string, number>,
): ChartSpec => {
  const bindings = chart.query.paramBindings;
  if (!bindings || !parameters || parameters.length === 0) return chart;
  const resolve = (id: string | null | undefined) => {
    if (!id) return null;
    const parameter = parameters.find((p) => p.id === id);
    if (!parameter || parameter.options.length === 0) return null;
    const raw = selections[parameter.id] ?? parameter.defaultIndex ?? 0;
    const index = Math.min(Math.max(Math.trunc(raw), 0), parameter.options.length - 1);
    return parameter.options[index] ?? null;
  };
  const axisOption = resolve(bindings.axis);
  const measureOption = resolve(bindings.measures);
  const axis = axisOption?.dimension ?? chart.query.axis;
  const measures = measureOption?.measure ? [measureOption.measure] : chart.query.measures;
  if (axis === chart.query.axis && measures === chart.query.measures) return chart;
  return { ...chart, query: { ...chart.query, axis, measures } };
};

/**
 * Chart tile with the dashboard runtime around ChartTile:
 * - field-parameter substitution (axis/measures) BEFORE everything else;
 * - transient per-tile drill state (axis swap + traversed-path eq filters);
 * - hover cross-highlighting (source + receiver sides via the store);
 * - interactive-table sort/page/totals/layout wiring.
 * Fresh derived spec objects per render are fine — ChartTile keys its fetch
 * effect on the cache key STRING, never on object identity.
 */
export function DashboardChartTile({
  tileId,
  chart: baseChart,
  modelId,
  editable,
  selected,
  refreshKey,
  filters,
  activeCategoryLabel,
  selectedLegendLabel,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  onTileContextMenu,
  onCrossFilter,
  onLegendSelect,
  onPointMenu,
  onChartMenu,
  reportEffective,
}: DashboardChartTileProps) {
  const runtime = useRuntime();
  const [drill, setDrill] = useState<TileDrill>(DRILL_ROOT);
  const [drillMode, setDrillMode] = useState(false);

  /* -------------------------------------------------- parameter substitution */

  const parameters = useDashboardState((state) => state.current?.layout.parameters ?? null);
  const parameterSelections = useDashboardState((state) => state.parameterSelections);
  const chart = useMemo(
    () => applyParamBindings(baseChart, parameters, parameterSelections),
    [baseChart, parameters, parameterSelections],
  );

  // Transient drill position resets whenever the effective base query changes
  // (spec edits redefine the hierarchy; a parameter switch swaps the axis);
  // keyed on content, not object identity.
  const queryKey = useMemo(() => stableStringify(chart.query), [chart.query]);
  useEffect(() => {
    setDrill(DRILL_ROOT);
    setDrillMode(false);
  }, [queryKey]);

  const drillLevels = chart.query.drillLevels ?? [];
  const hasHierarchy = drillLevels.length > 0 && chart.query.axis != null;
  const maxLevel = hasHierarchy ? drillLevels.length : 0;
  // Defensive clamp: a mid-edit spec swap can briefly outpace the reset effect.
  const level = Math.min(drill.level, maxLevel);

  /** Dimension shown as the axis at a drill level (0 = the chart's own axis). */
  const dimensionAt = (lvl: number): DimensionRef =>
    lvl === 0 ? chart.query.axis! : drillLevels[lvl - 1]!;

  // Effective query: level 0 is the base spec untouched; deeper levels swap
  // the axis to the level's dimension and append one eq/isNull clause per
  // FILTERED traversed step ("go to next level" slots contribute none).
  const drilledChart = useMemo<ChartSpec>(() => {
    if (!hasHierarchy || level === 0) return chart;
    const pathFilters: FilterClause[] = [];
    drill.path.slice(0, level).forEach((slot, i) => {
      if (slot === null) return;
      const dim = dimensionAt(i);
      pathFilters.push(
        slot.value === null
          ? { table: dim.table, column: dim.column, operator: 'isNull', values: [] }
          : { table: dim.table, column: dim.column, operator: 'eq', values: [slot.value] },
      );
    });
    return {
      ...chart,
      query: {
        ...chart.query,
        axis: drillLevels[level - 1],
        filters: [...chart.query.filters, ...pathFilters],
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimensionAt/drillLevels derive from chart
  }, [chart, hasHierarchy, level, drill.path]);

  const canDrillDeeper = hasHierarchy && level < maxLevel;

  const drillDown = useCallback(
    (e: ChartPointEvent) => {
      setDrill((prev) => {
        const lvl = Math.min(prev.level, maxLevel);
        if (lvl >= maxLevel) return prev;
        return {
          level: lvl + 1,
          path: [
            ...prev.path.slice(0, lvl),
            { value: e.axisValue as FilterValue | null, label: e.axisLabel },
          ],
        };
      });
    },
    [maxLevel],
  );

  const drillUp = useCallback(() => {
    setDrill((prev) => {
      const lvl = Math.min(prev.level, maxLevel);
      return lvl === 0 ? prev : { level: lvl - 1, path: prev.path.slice(0, lvl - 1) };
    });
  }, [maxLevel]);

  /** "Go to next level": axis swaps, no path filter (a filterless slot). */
  const nextLevel = () => {
    setDrill((prev) => {
      const lvl = Math.min(prev.level, maxLevel);
      if (lvl >= maxLevel) return prev;
      return { level: lvl + 1, path: [...prev.path.slice(0, lvl), null] };
    });
  };

  const popToLevel = (target: number) => {
    setDrill((prev) => {
      const lvl = Math.min(prev.level, maxLevel);
      if (target >= lvl || target < 0) return prev;
      return { level: target, path: prev.path.slice(0, target) };
    });
  };

  /** Home: resets the whole drill state at once (back to the original chart). */
  const resetDrill = useCallback(() => setDrill(DRILL_ROOT), []);

  /* --------------------------------------------------- interactive table */

  const isTable = chart.type === 'table';
  const tableOptions = chart.format.table ?? null;
  const pageSize = isTable && tableOptions?.pageSize != null && tableOptions.pageSize > 0
    ? tableOptions.pageSize
    : null;

  const [tableState, setTableState] = useState<TileTableState>(TABLE_ROOT);
  /** Transient Excel-style per-column header filters (renderer contract). */
  const [tableFilters, setTableFilters] = useState<TableColumnFilter[]>(NO_TABLE_FILTERS);
  /** View-mode column width/order tweaks (edit mode persists to the doc). */
  const [tableLayoutOverride, setTableLayoutOverride] = useState<ChartTableLayoutPatch | null>(null);

  // Sort/page/column-filter reset whenever the EFFECTIVE query identity
  // changes — drill level/path, drillthrough/slicer/cross-filter clauses,
  // parameter swaps. (Deliberately keyed on the DASHBOARD filters, not the
  // table's own translated clauses — a header filter must not reset itself.)
  const identityKey = useMemo(
    () => stableStringify({ query: drilledChart.query, filters }),
    [drilledChart.query, filters],
  );
  useEffect(() => {
    setTableState(TABLE_ROOT);
    setTableFilters(NO_TABLE_FILTERS);
  }, [identityKey]);

  /** Freshest rendered result (ref assignment from ChartTile — no re-renders). */
  const lastResultRef = useRef<QueryResult | null>(null);
  const handleResult = useCallback((result: QueryResult) => {
    lastResultRef.current = result;
  }, []);

  /** Maps a result column NAME onto the effective spec's dimension/measure index. */
  const sortTargetFor = (column: string): SortSpec['target'] | null => {
    const columns = lastResultRef.current?.columns;
    if (!columns) return null;
    const dims = columns.filter((c) => c.role === 'dimension');
    const measures = columns.filter((c) => c.role === 'measure');
    const dimIndex = dims.findIndex((c) => c.name === column);
    if (dimIndex !== -1) return { kind: 'dimension', index: dimIndex };
    const measureIndex = measures.findIndex((c) => c.name === column);
    if (measureIndex !== -1) return { kind: 'measure', index: measureIndex };
    return null;
  };

  const handleTableSortChange = useCallback((sort: ChartTableSort | null) => {
    setTableState((prev) => {
      if (sort === null) return { ...prev, sort: null, page: 0 };
      const target = sortTargetFor(sort.column);
      if (target === null) return prev;
      return { sort: { ...sort, target }, page: 0 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sortTargetFor reads a ref
  }, []);

  const handleTablePageChange = useCallback((page: number) => {
    setTableState((prev) => ({ ...prev, page: Math.max(0, page) }));
  }, []);

  /* --------------------------------------------- table column filters */

  // Translate-on-fetch: header filters map through the freshest result's
  // column names onto the effective spec — dimension columns to FilterClauses,
  // measure columns to wire HAVING entries.
  const { clauses: tableFilterClauses, having: tableHaving } = useMemo(
    () =>
      translateTableFilters(
        tableFilters,
        lastResultRef.current?.columns,
        wireDimensionsOf(drilledChart),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columns are read from a ref
    [tableFilters, drilledChart],
  );

  /** Dashboard filters + table dimension-column filters — the tile's fetch set. */
  const mergedFilters = useMemo(
    () => (tableFilterClauses.length === 0 ? filters : [...filters, ...tableFilterClauses]),
    [filters, tableFilterClauses],
  );

  const handleTableFilterChange = useCallback((next: TableColumnFilter[]) => {
    setTableFilters(next);
    // A different filter set starts back at the first page.
    setTableState((prev) => (prev.page === 0 ? prev : { ...prev, page: 0 }));
  }, []);

  // Fresh inputs read through a ref so the async values callback stays stable.
  const columnValuesInputRef = useRef({ drilledChart, filters, tableFilters });
  columnValuesInputRef.current = { drilledChart, filters, tableFilters };

  /**
   * Distinct values for a column's filter dropdown. Dimension columns run a
   * /query/values request through the shared cache WITH the tile's current
   * filters minus that column's own header filter (Excel semantics: the open
   * menu shows what the OTHER filters leave visible). Measure columns resolve
   * empty (the renderer offers conditions only there).
   */
  const handleRequestColumnValues = useCallback(
    async (column: string): Promise<CellValue[]> => {
      if (modelId === null) return [];
      const inputs = columnValuesInputRef.current;
      const result = lastResultRef.current;
      const dims = wireDimensionsOf(inputs.drilledChart);
      const dimNames = (result?.columns ?? [])
        .filter((c) => c.role === 'dimension')
        .map((c) => c.name);
      const dim = dims[dimNames.indexOf(column)];
      if (!dim) return [];
      const others = translateTableFilters(
        inputs.tableFilters.filter((f) => f.column !== column),
        result?.columns,
        dims,
      );
      const values = await runtime.queries.distinct({
        modelId,
        table: dim.table,
        column: dim.column,
        filters: [...inputs.drilledChart.query.filters, ...inputs.filters, ...others.clauses],
        limit: 1000,
      });
      return values.values;
    },
    [runtime, modelId],
  );

  const handleTableLayoutChange = useCallback(
    (patch: ChartTableLayoutPatch) => {
      if (editable) {
        // EDIT mode: persist into the BASE chart's format.table (dirties the doc).
        const state = runtime.dashboards.store.getState();
        const tile = (state.current?.layout.pages ?? [])
          .flatMap((page) => page.tiles)
          .find((t) => t.id === tileId);
        if (!tile?.chart) return;
        runtime.dashboards.updateChart(tileId, {
          ...tile.chart,
          format: {
            ...tile.chart.format,
            table: { ...tile.chart.format.table, ...patch },
          },
        });
        return;
      }
      // View mode: transient personal tweak only.
      setTableLayoutOverride((prev) => ({ ...prev, ...patch }));
    },
    [editable, runtime, tileId],
  );

  /**
   * The spec ChartTile actually fetches/renders: the drilled chart plus the
   * transient table sort (replacing spec.sort), page-size limit, and any
   * view-mode column layout override. Non-table charts pass through.
   */
  const queryChart = useMemo<ChartSpec>(() => {
    if (!isTable) return drilledChart;
    const needsSort = tableState.sort !== null;
    const needsLayout = tableLayoutOverride !== null;
    if (!needsSort && !needsLayout && pageSize === null) return drilledChart;
    return {
      ...drilledChart,
      query: {
        ...drilledChart.query,
        ...(needsSort
          ? {
              sort: [
                { target: tableState.sort!.target, direction: tableState.sort!.direction },
              ],
            }
          : {}),
        ...(pageSize !== null ? { limit: pageSize } : {}),
      },
      ...(needsLayout
        ? {
            format: {
              ...drilledChart.format,
              table: { ...drilledChart.format.table, ...tableLayoutOverride },
            },
          }
        : {}),
    };
  }, [isTable, drilledChart, tableState.sort, tableLayoutOverride, pageSize]);

  /** Row offset for server-side table pagination (merged into the wire spec). */
  const tableOffset = pageSize !== null ? tableState.page * pageSize : null;

  /* ------------------------------------------------------------ totals row */

  // Companion no-dimension query over the SAME measures + filters (incl. the
  // drill path, every transient dashboard filter, and the table's own
  // dimension-column filters), through the query cache. HAVING conditions are
  // deliberately excluded: on a no-dimension query they would gate the single
  // total row, not re-total the visible groups.
  const totalsSpec = useMemo(() => {
    if (!isTable || tableOptions?.totals !== true || modelId === null) return null;
    if (drilledChart.query.measures.length === 0) return null;
    return toWireSpec(
      {
        ...drilledChart,
        query: {
          ...drilledChart.query,
          axis: null,
          legend: null,
          smallMultiples: null,
          sort: [],
          limit: null,
        },
      },
      modelId,
      mergedFilters,
    );
  }, [isTable, tableOptions?.totals, modelId, drilledChart, mergedFilters]);

  const totalsKey = totalsSpec ? runtime.queries.keyFor(totalsSpec) : null;
  const totalsEntry = useQueryCacheState((state) =>
    totalsKey ? state.entries[totalsKey] : undefined,
  );
  const totalsSpecRef = useRef(totalsSpec);
  totalsSpecRef.current = totalsSpec;

  useEffect(() => {
    if (!totalsKey) return;
    const spec = totalsSpecRef.current;
    if (!spec) return;
    runtime.queries.run(spec).catch(() => {
      // surfaced via the cache entry (totals simply stay absent on error)
    });
  }, [runtime, totalsKey, refreshKey]);

  const totalsRow = useMemo<(number | null)[] | null>(() => {
    if (!totalsSpec || totalsEntry?.status !== 'ok' || !totalsEntry.data) return null;
    const result = totalsEntry.data;
    const row = result.rows[0];
    if (!row) return null;
    return result.columns
      .map((column, i) => ({ column, i }))
      .filter(({ column }) => column.role === 'measure')
      .map(({ i }) => {
        const value = row[i];
        return typeof value === 'number' ? value : null;
      });
  }, [totalsSpec, totalsEntry]);

  /* ------------------------------------------------------- hover highlight */

  const hoverEnabled = chart.format.hoverHighlight !== false;
  const hoverHighlight = useDashboardState((state) => state.hoverHighlight);

  // Fresh effective dims per render, read by stable callbacks through a ref.
  const hoverDimsRef = useRef<{ chart: ChartSpec }>({ chart: drilledChart });
  hoverDimsRef.current = { chart: drilledChart };

  const handlePointHover = useCallback(
    (e: ChartPointEvent | null) => {
      const store = runtime.dashboards;
      if (e === null) {
        if (store.store.getState().hoverHighlight?.sourceTileId === tileId) {
          store.setHoverHighlight(null);
        }
        return;
      }
      const effective = hoverDimsRef.current.chart;
      const axis =
        effective.type === 'pie' || effective.type === 'donut'
          ? (effective.query.legend ?? effective.query.axis ?? null)
          : (effective.query.axis ?? null);
      const legend = effective.query.legend ?? null;
      // Axis dimension by default; the legend dimension when the event only
      // carries a legend identity (no axis on this chart).
      let dimension = axis;
      let raw = e.axisValue;
      let label = e.axisLabel;
      if (dimension === null && legend !== null && e.legendValue !== undefined) {
        dimension = legend;
        raw = e.legendValue;
        label = e.legendLabel ?? String(e.legendValue);
      }
      if (dimension === null) return;
      // The store no-ops on identical payloads, so hover jitter never storms
      // subscribers (and hover can never trigger fetches or grid re-layout).
      store.setHoverHighlight({
        dimension: { table: dimension.table, column: dimension.column },
        raw,
        label,
        sourceTileId: tileId,
      });
    },
    [runtime, tileId],
  );

  // A hover raised by this tile clears when the tile unmounts (page switch is
  // already handled by the store).
  useEffect(
    () => () => {
      const store = runtime.dashboards;
      if (store.store.getState().hoverHighlight?.sourceTileId === tileId) {
        store.setHoverHighlight(null);
      }
    },
    [runtime, tileId],
  );

  // Receiver side: dim non-matching categories while ANOTHER tile hovers a
  // category whose dimension matches this chart's effective axis or legend.
  const highlightCategory = useMemo(() => {
    if (!hoverEnabled || hoverHighlight === null || hoverHighlight.sourceTileId === tileId) {
      return null;
    }
    const { dimension } = hoverHighlight;
    const matches = (dim: DimensionRef | null | undefined): boolean =>
      dim != null && dim.table === dimension.table && dim.column === dimension.column;
    return matches(drilledChart.query.axis) || matches(drilledChart.query.legend)
      ? { label: hoverHighlight.label }
      : null;
  }, [hoverEnabled, hoverHighlight, tileId, drilledChart.query.axis, drilledChart.query.legend]);

  /* -------------------------------------------------------------- reporting */

  // Ref-style report (assignment only, mirrors ChartTile's wireSpecRef): the
  // export menus read the freshest effective spec — and the point context menu
  // the drill runtime — without extra renders.
  reportEffective(tileId, {
    chart: drilledChart,
    // Includes the table's dimension-column filters (and having below) so CSV
    // exports match exactly what the filtered table shows.
    filters: mergedFilters,
    ...(tableHaving.length > 0 ? { having: tableHaving } : {}),
    drill: hasHierarchy
      ? { canDrillDeeper, level, drillDownInto: drillDown, drillUp, resetDrill }
      : null,
  });

  /* ------------------------------------------------- context-menu routing */

  /**
   * View-mode right-click routing: the renderer's point handler (an inner
   * element) fires FIRST during the same native event's propagation and marks
   * this flag, so the tile-level handler yields to the point menu. The flag
   * self-clears on the next macrotask — a renderer that stops propagation can
   * never strand it into swallowing the NEXT tile-level right-click.
   */
  const pointMenuFiredRef = useRef(false);
  const markPointMenuFired = () => {
    pointMenuFiredRef.current = true;
    window.setTimeout(() => {
      pointMenuFiredRef.current = false;
    }, 0);
  };

  // Whole-tile right-click: edit mode keeps the chart config card; view mode
  // opens the chart-level menu wherever no point menu claimed the click —
  // KPIs, empty plot areas, and between-point misses all get a menu.
  const handleTileContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (editable) {
      if (!onTileContextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      onTileContextMenu({ x: event.clientX, y: event.clientY });
      return;
    }
    if (!onChartMenu) return;
    event.preventDefault();
    event.stopPropagation();
    if (pointMenuFiredRef.current) return;
    onChartMenu({
      tileId,
      chart: drilledChart,
      position: { x: event.clientX, y: event.clientY },
    });
  };

  const contextMenuActive = editable ? onTileContextMenu !== undefined : onChartMenu !== undefined;

  /* -------------------------------------------------------- drill controls */

  // Breadcrumb: one crumb per traversed level; filtered steps show the clicked
  // label, filterless steps show the level's dimension column. Clicking a
  // crumb pops back to that level (the last crumb is the current position).
  const crumbs = hasHierarchy
    ? Array.from({ length: level }, (_, i) => ({
        level: i + 1,
        label: drill.path[i]?.label ?? dimensionAt(i + 1).column,
      }))
    : [];

  const drillControls = hasHierarchy ? (
    <div className="flex min-w-0 shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {crumbs.length > 0 && (
        <span className="flex max-w-[12rem] items-center gap-0.5 truncate text-[11px] leading-none text-rcd-muted">
          {crumbs.map((crumb, i) => (
            <span key={crumb.level} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <span aria-hidden className="opacity-70">▸</span>}
              {crumb.level === level ? (
                <span className="truncate font-medium text-rcd-text-2" title={crumb.label}>
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  title={`Back to ${crumb.label}`}
                  onClick={() => popToLevel(crumb.level)}
                  className="truncate rounded px-0.5 py-0.5 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </span>
      )}
      <span className="flex items-center gap-0.5">
        {level > 0 && (
          <RcdIconButton
            aria-label="Back to original chart"
            title="Back to original chart"
            onClick={resetDrill}
            className="!p-1"
          >
            <CornerUpLeft size={13} />
          </RcdIconButton>
        )}
        <RcdIconButton
          aria-label="Drill up"
          title="Drill up"
          disabled={level === 0}
          onClick={drillUp}
          className="!p-1"
        >
          <ArrowUp size={13} />
        </RcdIconButton>
        <RcdIconButton
          aria-label="Go to the next level in the hierarchy"
          title="Go to the next level in the hierarchy"
          disabled={!canDrillDeeper}
          onClick={nextLevel}
          className="!p-1"
        >
          <ChevronsDown size={13} />
        </RcdIconButton>
        <RcdIconButton
          aria-label={drillMode ? 'Drill mode on (clicks drill down)' : 'Drill mode off (clicks cross-filter)'}
          title={drillMode ? 'Drill mode on: clicks drill down' : 'Turn on drill mode'}
          aria-pressed={drillMode}
          onClick={() => setDrillMode((on) => !on)}
          className={`!p-1 ${drillMode ? 'bg-black/5 text-[var(--rcd-accent-interactive)] dark:bg-white/10' : ''}`}
        >
          <ArrowDown size={13} />
        </RcdIconButton>
      </span>
    </div>
  ) : null;

  return (
    <div
      className={`h-full rounded-xl ${editable && selected ? 'ring-2 ring-[var(--rcd-accent-interactive)]' : ''}`}
      onClick={editable ? onSelect : undefined}
    >
      <TileFrame
        title={chart.title}
        editable={editable}
        container={chart.format.container ?? null}
        headerExtra={drillControls}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onContextMenu={contextMenuActive ? handleTileContextMenu : undefined}
      >
        {modelId === null ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-rcd-muted">
            No model attached to this dashboard.
          </div>
        ) : (
          <ChartTile
            refreshKey={refreshKey}
            spec={queryChart}
            modelId={modelId}
            filters={mergedFilters}
            offset={tableOffset}
            having={tableHaving.length > 0 ? tableHaving : null}
            // Drill mode owns clicks exclusively: on, clicks drill (never
            // cross-filter); off, clicks cross-filter exactly as before.
            onDatumClick={
              drillMode ? undefined : (info) => onCrossFilter(drilledChart, info)
            }
            onPointClick={drillMode && canDrillDeeper ? drillDown : undefined}
            onPointContextMenu={
              onPointMenu
                ? (event) => {
                    // Claim this right-click before it bubbles to the tile
                    // handler (which would otherwise open the chart-level menu).
                    markPointMenuFired();
                    onPointMenu({ tileId, chart: drilledChart, event });
                  }
                : undefined
            }
            // Legend clicks are never drill clicks — they cross-filter (or
            // clear) regardless of drill mode.
            onLegendSelect={(e) => onLegendSelect(drilledChart, e)}
            selectedLegendLabel={selectedLegendLabel}
            activeCategory={activeCategoryLabel !== null ? { label: activeCategoryLabel } : null}
            onPointHover={hoverEnabled ? handlePointHover : undefined}
            highlightCategory={highlightCategory}
            tableSort={tableState.sort}
            onTableSortChange={
              isTable && tableOptions?.sortable !== false ? handleTableSortChange : undefined
            }
            tablePage={tableState.page}
            tablePageCount={null}
            onTablePageChange={pageSize !== null ? handleTablePageChange : undefined}
            totalsRow={totalsRow}
            onTableLayoutChange={isTable ? handleTableLayoutChange : undefined}
            tableFilters={isTable ? tableFilters : undefined}
            onTableFilterChange={
              isTable && tableOptions?.filterable !== false ? handleTableFilterChange : undefined
            }
            onRequestColumnValues={
              isTable && tableOptions?.filterable !== false
                ? handleRequestColumnValues
                : undefined
            }
            onResult={handleResult}
          />
        )}
      </TileFrame>
    </div>
  );
}
