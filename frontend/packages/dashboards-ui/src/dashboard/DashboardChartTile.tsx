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
  groupingClauseFor,
  groupingClausesForLabels,
  groupingKeyOf,
  groupingLabels,
  hasGrouping,
  isMatrixChart,
  isTemporalType,
  stableStringify,
  toWireSpec,
  type CellValue,
  type ChartPointEvent,
  type ChartSpec,
  type DashboardParameter,
  type DimensionRef,
  type FilterClause,
  type FilterValue,
  type MeasureRef,
  type QueryColumn,
  type QueryResult,
  type SortSpec,
} from '@recon/dashboards-core';
import {
  ChartTile,
  type ChartHavingClause,
  type ChartLegendSelectEvent,
  type ChartTableLayoutPatch,
  type TableColumnFilter,
} from '../chart/ChartTile';
// TableSortState is the renderer's MULTI-LEVEL sort echo (primary level plus
// `thenBy` tie-breakers). ChartTile/ChartRenderer type the same prop on the
// narrower {column, direction} shape and forward the value verbatim, so the
// extra levels ride through untouched — this tile reads them here.
import type { ChartDatumClickInfo, TableSortState } from '../chart/ChartRenderer';
import { useDashboardState, useQueryCacheState, useRuntime } from '../provider/DashboardsProvider';
import { RcdIconButton } from '../primitives';
import { TileFilterBadge } from './FilterIndicator';
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

/** One level of the table's multi-level sort (renderer contract, flattened). */
type TableSortLevel = { column: string; direction: 'asc' | 'desc' };

/** Flattens the renderer's sort echo into ordered levels ([] = unsorted). */
const sortLevelsOf = (sort: TableSortState | null): TableSortLevel[] =>
  sort === null
    ? []
    : [{ column: sort.column, direction: sort.direction }, ...(sort.thenBy ?? [])];

/** Rebuilds the renderer echo from ordered levels (head + `thenBy` tail). */
const sortStateOf = (levels: TableSortLevel[]): TableSortState | null => {
  const [first, ...rest] = levels;
  if (!first) return null;
  return { ...first, ...(rest.length > 0 ? { thenBy: rest } : null) };
};

/**
 * Transient interactive-table state (sort + page); resets with the query.
 * The sort is kept in BOTH forms: `sort` is the renderer's echo (all levels)
 * and `sortSpecs` the wire ORDER BY terms it maps onto, aligned 1:1 and in
 * the same priority order. Never persisted — sorting stays transient in edit
 * mode too (only layout patches write to the doc).
 */
interface TileTableState {
  sort: TableSortState | null;
  sortSpecs: SortSpec[];
  page: number;
}

const NO_SORT_SPECS: SortSpec[] = [];

const TABLE_ROOT: TileTableState = { sort: null, sortSpecs: NO_SORT_SPECS, page: 0 };

const NO_TABLE_FILTERS: TableColumnFilter[] = [];

/** format.table shape (kept structural — the core type is not re-exported). */
type TableOptionsShape = NonNullable<ChartSpec['format']['table']>;

/**
 * Merges a renderer layout patch over stored table options. columnWidths is
 * DEEP-merged: a resize patch carries only the column(s) the gesture touched,
 * so a shallow spread would clobber every previously resized column's width —
 * the "my column widths don't stick" bug (each new resize silently erased the
 * others from the doc; the renderer's transient drag draft masked the loss
 * until a remount made it visible).
 */
const mergeTablePatch = (
  base: TableOptionsShape | undefined,
  patch: ChartTableLayoutPatch,
): TableOptionsShape => ({
  ...base,
  ...patch,
  ...(patch.columnWidths
    ? { columnWidths: { ...base?.columnWidths, ...patch.columnWidths } }
    : null),
});

/**
 * A chart's dimensions in wire order (mirrors toWireSpec): matrix tables emit
 * [axis, drills..., legend], everything else [axis, legend, smallMultiples].
 */
const wireDimensionsOf = (chart: ChartSpec): DimensionRef[] => {
  const dims: DimensionRef[] = [];
  if (chart.query.axis) dims.push(chart.query.axis);
  if (isMatrixChart(chart)) dims.push(...(chart.query.drillLevels ?? []));
  if (chart.query.legend) dims.push(chart.query.legend);
  if (chart.query.smallMultiples) dims.push(chart.query.smallMultiples);
  return dims;
};

/** Positional meta of a result's MEASURE columns (name + temporal-ness). */
interface TotalsMeasureColumn {
  name: string;
  temporal: boolean;
}

/** Extracts the measure columns' totals-relevant meta, in result order. */
export const totalsMeasureColumnsOf = (columns: QueryColumn[]): TotalsMeasureColumn[] =>
  columns
    .filter((column) => column.role === 'measure')
    .map((column) => ({ name: column.name, temporal: isTemporalType(column.type) }));

/**
 * Measures for the totals companion query: TEMPORAL measure columns total as
 * MIN ('earliest', the default) or MAX ('latest') per table.dateAggregation —
 * the same per-column rule matrix parent rows fold by, so the Total row and
 * the roll-ups always agree. Only INLINE measures can be rewritten (a model
 * measure's aggregation lives server-side behind its id); those keep their
 * own aggregation. Column meta is positional: measure i -> i-th measure
 * column (wire order); null meta (no result yet) leaves everything untouched.
 */
export const totalsMeasuresFor = (
  measures: MeasureRef[],
  measureColumns: readonly TotalsMeasureColumn[] | null,
  dateAggregation: Record<string, 'earliest' | 'latest'> | undefined,
): MeasureRef[] =>
  measures.map((measure, i) => {
    const column = measureColumns?.[i];
    if (!column?.temporal || measure.measureId != null || measure.column == null) return measure;
    const aggregation =
      (dateAggregation?.[column.name] ?? 'earliest') === 'latest' ? 'max' : 'min';
    return measure.aggregation === aggregation ? measure : { ...measure, aggregation };
  });

/**
 * Reduces the companion result's single row to the measure-aligned totals
 * array. Cells pass through AS-IS — date totals arrive as ISO strings and must
 * survive to formatCellValue (the old `typeof value === 'number'` reducer
 * silently nulled them); only a genuinely missing cell becomes null.
 */
export const totalsRowFromResult = (result: QueryResult): (CellValue | null)[] | null => {
  const row = result.rows[0];
  if (!row) return null;
  return result.columns
    .map((column, i) => ({ column, i }))
    .filter(({ column }) => column.role === 'measure')
    .map(({ i }) => row[i] ?? null);
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
 * - MEASURE columns -> HAVING entries {measureIndex, operator, values}:
 *   numeric conditions map 1:1; Excel value checklists map onto membership —
 *   a plain list keeps the checked aggregated values (HAVING 'in'; NULL never
 *   matches), an INVERTED list (renderer contract: the UNCHECKED values,
 *   committed when "(Blanks)" is checked) maps onto 'notIn', whose complement
 *   semantics keep blank (NULL) aggregates. contains/startsWith still have no
 *   post-aggregation wire form and are dropped.
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
      if (hasGrouping(dim)) {
        // A grouped column's cells ARE labels, so the checklist is a set of
        // buckets. groupingClausesForLabels expresses "keep these buckets" as
        // a CONJUNCTION of exclusions (the only form a FilterClause list can
        // take); an inexpressible selection drops the filter rather than
        // guessing, and the note the renderer already shows for an unfiltered
        // column applies.
        if (filter.kind !== 'values') continue;
        const labels = filter.values
          .filter((v): v is FilterValue => v !== null)
          .map((v) => String(v));
        const grouped = groupingClausesForLabels(dim, labels);
        if (grouped !== null) clauses.push(...grouped);
        continue;
      }
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
    if (measureIndex === -1) continue;
    if (filter.kind === 'values') {
      const numbers = filter.values.filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      );
      if (numbers.length === 0) continue; // nothing expressible -> no-op
      // `inverted` is the renderer-side extension of the shared filter
      // contract (TableChart's TableColumnFilter); structural typing lets the
      // wider object flow through, so it is read off the value here.
      const inverted = (filter as { inverted?: boolean }).inverted === true;
      having.push({ measureIndex, operator: inverted ? 'notIn' : 'in', values: numbers });
      continue;
    }
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
  /**
   * Every selected label when this tile's axis cross-filter holds a
   * Ctrl-accumulated multi-value set (activeCategoryLabel is then null —
   * tables highlight all of them; charts ignore it).
   */
  activeCategories?: readonly string[] | null;
  /**
   * The same active values as activeCategories, each tagged with the
   * "table.column" it filters — TABLES need the column to mark the exact cell
   * driving the page once clickFilter 'cell'/'row' lets a click filter on a
   * column other than the first. Other chart types ignore it.
   */
  activeCells?: readonly { source: string | null; label: string }[] | null;
  /** Legend label while this tile is the LEGEND cross-filter source (emphasis). */
  selectedLegendLabel: string | null;
  /**
   * Small corner badge naming the dashboard filter(s) currently reaching this
   * tile (FilterIndicatorStyle.badgeTiles). Null/absent = no badge.
   */
  filterBadgeLabel?: string | null;
  /** Accent override for the badge (indicator style). */
  filterBadgeAccent?: string | null;
  onSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  /** Copies the whole tile to the session clipboard (kebab > Copy). */
  onCopy?: () => void;
  /** Absent = the caller lacks the delete right (0.11.1) — the affordance hides. */
  onDelete?: () => void;
  /** Edit-mode right-click on the tile (opens the chart context card). */
  onTileContextMenu?: (position: { x: number; y: number }) => void;
  /**
   * Cross-filter datum click, called with the EFFECTIVE (drilled) chart plus
   * the freshest RESULT columns — the clause builder needs the column's
   * catalog type and the bucket the engine actually applied to turn a clicked
   * date bucket into a range instead of an (unparseable) eq.
   */
  onCrossFilter: (
    chart: ChartSpec,
    info: ChartDatumClickInfo,
    columns: QueryColumn[] | null,
  ) => void;
  /**
   * Legend cross-filter selection (legendMode 'crossFilter'), called with the
   * EFFECTIVE (drilled) chart; null event = clear the page-wide filter.
   */
  onLegendSelect: (
    chart: ChartSpec,
    e: ChartLegendSelectEvent | null,
    columns: QueryColumn[] | null,
  ) => void;
  /**
   * Date-axis drag range (format.zoom.dragAction === 'crossFilter'): the RAW
   * endpoints of the dragged window, to become the SAME range-style
   * cross-filter a bucket click produces, sourced from this tile.
   */
  onAxisRangeCrossFilter?: (
    chart: ChartSpec,
    range: { fromRaw: unknown; toRaw: unknown },
    columns: QueryColumn[] | null,
  ) => void;
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
  activeCategories = null,
  activeCells = null,
  selectedLegendLabel,
  filterBadgeLabel = null,
  filterBadgeAccent = null,
  onSelect,
  onEdit,
  onDuplicate,
  onCopy,
  onDelete,
  onTileContextMenu,
  onCrossFilter,
  onLegendSelect,
  onAxisRangeCrossFilter,
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
  // Matrix tables consume drillLevels as WIRE dimensions (row hierarchy), so
  // the drill affordances hide and the drill runtime stays at the root —
  // drill and matrix are mutually exclusive readings of the same array.
  const matrixActive = isMatrixChart(chart);
  const hasHierarchy = !matrixActive && drillLevels.length > 0 && chart.query.axis != null;
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
      if (hasGrouping(dim)) {
        // The traversed step carries the group's LABEL, because that is what
        // the grouped level plotted. Filtering the raw column with it would
        // match nothing at all, so it goes back through the grouping rule; a
        // bucket with no honest single-clause form contributes NO filter (the
        // deeper level is then unfiltered rather than wrongly filtered, and
        // the breadcrumb still names the step the user took).
        const clause = groupingClauseFor(dim, slot.label ?? String(slot.value ?? ''));
        if (clause !== null) pathFilters.push(clause);
        return;
      }
      pathFilters.push(
        slot.value === null
          ? { table: dim.table, column: dim.column, operator: 'isNull', values: [] }
          : { table: dim.table, column: dim.column, operator: 'eq', values: [slot.value] },
      );
    });
    return {
      ...chart,
      // Manual category order keys the LEVEL-0 axis labels; a drilled axis
      // shows different categories, so the order is dropped while drilled
      // instead of silently mismatching. seriesOrder keys the legend, which
      // drilling never swaps — it stays.
      ...(chart.format.categoryOrder
        ? { format: { ...chart.format, categoryOrder: undefined } }
        : null),
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

  const [tableState, setTableState] = useState<TileTableState>(TABLE_ROOT);
  /** Transient Excel-style per-column header filters (renderer contract). */
  const [tableFilters, setTableFilters] = useState<TableColumnFilter[]>(NO_TABLE_FILTERS);
  /** View-mode column width/order/page-size tweaks (edit mode persists to the doc). */
  const [tableLayoutOverride, setTableLayoutOverride] = useState<ChartTableLayoutPatch | null>(null);

  // Effective page size: a viewer's pager pick (renderer contract: it rides
  // the layout-patch channel; 0 = "All"/unpaged) wins over the authored
  // table.pageSize. The pick is transient view state, so it re-queries via
  // the existing offset/limit mechanism without touching the doc.
  const pageSizePick = tableLayoutOverride?.pageSize;
  const effectivePageSize = pageSizePick ?? tableOptions?.pageSize ?? null;
  // Matrix forces single-page: server paging and client row-grouping don't
  // compose (a page boundary would split groups and lie in the roll-ups) —
  // the TABLE_ROW_CAP render guard takes over.
  const pageSize =
    isTable && !matrixActive && effectivePageSize != null && effectivePageSize > 0
      ? effectivePageSize
      : null;

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
  /**
   * Measure-column meta (name + temporal-ness) from the freshest result. The
   * totals companion's temporal rewrite needs it inside a memo, and memos
   * can't read a bare ref reliably — so it lives in state, CONTENT-guarded so
   * a re-render only happens when the measure columns actually change (in
   * practice once per query shape, not per refetch).
   */
  const [measureColumnMeta, setMeasureColumnMeta] = useState<TotalsMeasureColumn[] | null>(null);
  const handleResult = useCallback((result: QueryResult) => {
    lastResultRef.current = result;
    const meta = totalsMeasureColumnsOf(result.columns);
    setMeasureColumnMeta((prev) =>
      prev !== null &&
      prev.length === meta.length &&
      prev.every((m, i) => m.name === meta[i]!.name && m.temporal === meta[i]!.temporal)
        ? prev
        : meta,
    );
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

  /**
   * Maps EVERY level of the renderer's sort onto wire SortSpecs (the engine
   * composes them into one ORDER BY, in this order). Levels whose column can
   * no longer be mapped are dropped; if nothing maps, the change is ignored
   * (same guard as the single-level path). Any sort change goes back to the
   * first page, multi-level included.
   */
  const handleTableSortChange = useCallback((sort: TableSortState | null) => {
    setTableState((prev) => {
      const levels = sortLevelsOf(sort);
      if (levels.length === 0) {
        return prev.sort === null
          ? prev
          : { sort: null, sortSpecs: NO_SORT_SPECS, page: 0 };
      }
      const kept: TableSortLevel[] = [];
      const sortSpecs: SortSpec[] = [];
      for (const level of levels) {
        const target = sortTargetFor(level.column);
        if (target === null) continue;
        kept.push(level);
        sortSpecs.push({ target, direction: level.direction });
      }
      if (sortSpecs.length === 0) return prev;
      return { sort: sortStateOf(kept), sortSpecs, page: 0 };
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
   * Distinct values for a column's filter dropdown, always with the tile's
   * current filters MINUS that column's own header filter (Excel semantics:
   * the open menu shows what the OTHER filters leave visible).
   * - DIMENSION columns run a /query/values request through the shared cache.
   * - MEASURE columns run the tile's own grouped query WITHOUT offset/limit
   *   (so pagination can never truncate the list) through the shared cache
   *   and reduce that column to its distinct aggregated values, sorted, with
   *   a null entry when blank aggregates exist. Capped at 200 (the renderer's
   *   COLUMN_VALUES_CAP note threshold).
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
      const others = translateTableFilters(
        inputs.tableFilters.filter((f) => f.column !== column),
        result?.columns,
        dims,
      );
      if (!dim) {
        // Measure column: distinct AGGREGATED values over the full filtered,
        // pre-pagination result. Other measures' HAVING conditions still apply.
        const target = (result?.columns ?? []).find(
          (c) => c.role === 'measure' && c.name === column,
        );
        if (!target) return [];
        const base = toWireSpec(
          inputs.drilledChart,
          modelId,
          [...inputs.filters, ...others.clauses],
          runtime.dashboards.wireDefinitionsForChart(inputs.drilledChart),
        );
        const spec = others.having.length > 0 ? { ...base, having: others.having } : base;
        const full = await runtime.queries.run(spec);
        const index = full.columns.findIndex((c) => c.name === column);
        if (index === -1) return [];
        const seen = new Map<string, CellValue>();
        for (const row of full.rows) {
          const value = row[index] ?? null;
          const key = value === null ? ' null' : `${typeof value}:${String(value)}`;
          if (!seen.has(key)) seen.set(key, value);
        }
        return [...seen.values()]
          .sort((a, b) => {
            if (a === null) return 1; // blanks last, Excel-style
            if (b === null) return -1;
            if (typeof a === 'number' && typeof b === 'number') return a - b;
            return String(a).localeCompare(String(b));
          })
          .slice(0, 200);
      }
      // A GROUPED column's distinct values are its LABELS, and they are known
      // without asking the server — asking would return the raw values, which
      // are not what any cell in that column shows.
      if (hasGrouping(dim)) return groupingLabels(dim.grouping!);
      const values = await runtime.queries.distinct({
        modelId,
        table: dim.table,
        column: dim.column,
        filters: [...inputs.drilledChart.query.filters, ...inputs.filters, ...others.clauses],
        // A DERIVED column exists only in the overlay, so the lookup carries
        // the same definitions the chart's own query carries or the server
        // cannot resolve the column at all.
        derivedFields: runtime.dashboards.derivedFieldsForChart(inputs.drilledChart),
        limit: 1000,
      });
      return values.values;
    },
    [runtime, modelId],
  );

  const handleTableLayoutChange = useCallback(
    (patch: ChartTableLayoutPatch) => {
      if (editable) {
        // EDIT mode: persist into the BASE chart's format.table (dirties the
        // doc). columnWidths merge DEEP (see mergeTablePatch) so resizing one
        // column never erases the widths of previously resized ones.
        const state = runtime.dashboards.store.getState();
        const tile = (state.current?.layout.pages ?? [])
          .flatMap((page) => page.tiles)
          .find((t) => t.id === tileId);
        if (!tile?.chart) return;
        runtime.dashboards.updateChart(tileId, {
          ...tile.chart,
          format: {
            ...tile.chart.format,
            table: mergeTablePatch(tile.chart.format.table, patch),
          },
        });
        return;
      }
      // View mode: transient personal tweak only — accumulated with the same
      // deep columnWidths merge, and kept in component state so it survives
      // table page flips within the session.
      setTableLayoutOverride((prev) => ({
        ...prev,
        ...patch,
        ...(patch.columnWidths
          ? { columnWidths: { ...prev?.columnWidths, ...patch.columnWidths } }
          : null),
      }));
    },
    [editable, runtime, tileId],
  );

  /**
   * Authored Top-N on the (drilled) spec. Pagination must never widen it: the
   * pageable universe is the FIRST authoredLimit rows (finding 6 — a pageSize
   * larger than the Top-N used to overwrite it and show rows the author cut).
   */
  const authoredLimit = drilledChart.query.limit ?? null;

  /**
   * The offset walk is bounded by the authored Top-N: the last reachable page
   * is the one containing the Top-N's final row, so a stale pager click (count
   * companion failed) can never fetch rows past the authored cut.
   */
  const maxPage =
    pageSize !== null && authoredLimit !== null
      ? Math.max(0, Math.ceil(authoredLimit / pageSize) - 1)
      : null;
  const tablePage = maxPage !== null ? Math.min(tableState.page, maxPage) : tableState.page;

  /** Row offset for server-side table pagination (merged into the wire spec). */
  const tableOffset = pageSize !== null ? tablePage * pageSize : null;

  /**
   * Per-page row limit: the page size, shrunk on the LAST page inside an
   * authored Top-N so the page never reads past it.
   */
  const pageLimit =
    pageSize === null
      ? null
      : authoredLimit === null
        ? pageSize
        : Math.max(1, Math.min(pageSize, authoredLimit - (tableOffset ?? 0)));

  /**
   * The spec ChartTile actually fetches/renders: the drilled chart plus the
   * transient table sort (replacing spec.sort), page-size limit, and any
   * view-mode column layout override. Non-table charts pass through.
   */
  const queryChart = useMemo<ChartSpec>(() => {
    if (!isTable) return drilledChart;
    const sortSpecs = tableState.sortSpecs;
    const needsSort = sortSpecs.length > 0;
    const needsLayout = tableLayoutOverride !== null;
    if (!needsSort && !needsLayout && pageLimit === null) return drilledChart;
    return {
      ...drilledChart,
      query: {
        ...drilledChart.query,
        // Every level, in priority order -> one composed ORDER BY.
        ...(needsSort ? { sort: sortSpecs } : {}),
        ...(pageLimit !== null ? { limit: pageLimit } : {}),
      },
      ...(needsLayout
        ? {
            format: {
              ...drilledChart.format,
              // Deep columnWidths merge: the override only carries the
              // columns the viewer touched; authored widths must survive.
              table: mergeTablePatch(drilledChart.format.table, tableLayoutOverride ?? {}),
            },
          }
        : {}),
    };
  }, [isTable, drilledChart, tableState.sortSpecs, tableLayoutOverride, pageLimit]);

  /* ------------------------------------------------------------ totals row */

  // Companion no-dimension query over the SAME measures + filters (incl. the
  // drill path, every transient dashboard filter, and the table's own
  // dimension-column filters), through the query cache. HAVING conditions are
  // deliberately excluded: on a no-dimension query they would gate the single
  // total row, not re-total the visible groups.
  const totalsSpec = useMemo(() => {
    if (!isTable || tableOptions?.totals !== true || modelId === null) return null;
    // Correct for a measure-less passthrough table: there is nothing to total,
    // and a no-dimension/no-measure spec has an empty SELECT list (which the
    // compiler rejects). TableChart's totalsActive guard agrees.
    if (drilledChart.query.measures.length === 0) return null;
    return toWireSpec(
      {
        ...drilledChart,
        query: {
          ...drilledChart.query,
          axis: null,
          legend: null,
          smallMultiples: null,
          // A matrix chart's drillLevels are wire dimensions — the companion
          // must stay a NO-dimension query, so they are stripped here too.
          drillLevels: undefined,
          // Temporal measure columns total as MIN/MAX per table.dateAggregation
          // (earliest by default); numeric measures pass through untouched.
          measures: totalsMeasuresFor(
            drilledChart.query.measures,
            measureColumnMeta,
            tableOptions?.dateAggregation,
          ),
          sort: [],
          limit: null,
        },
      },
      modelId,
      mergedFilters,
      runtime.dashboards.wireDefinitionsForChart(drilledChart),
    );
  }, [
    isTable,
    tableOptions?.totals,
    tableOptions?.dateAggregation,
    modelId,
    drilledChart,
    mergedFilters,
    measureColumnMeta,
    runtime,
  ]);

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

  const totalsRow = useMemo<(CellValue | null)[] | null>(() => {
    if (!totalsSpec || totalsEntry?.status !== 'ok' || !totalsEntry.data) return null;
    return totalsRowFromResult(totalsEntry.data);
  }, [totalsSpec, totalsEntry]);

  /* -------------------------------------------------------- table row count */

  // Pager "Page X of Y" / "N rows": the SAME companion-query-through-the-cache
  // mechanism the totals row uses, run whenever the table pages (totals on or
  // off). The count of a grouped table's rows is the count of its GROUPS, so
  // the companion is the tile's own grouped query with sort/limit/offset
  // stripped — sort can't change the group set, so every sort state shares
  // one cached entry, and the wire spec matches what pagination walks
  // (dimension filters AND HAVING included). Lazy + cached: it runs once per
  // filter state and only while pageSize is active.
  const countSpec = useMemo(() => {
    if (!isTable || pageSize === null || modelId === null) return null;
    // NOTE: unlike the totals companion above, this one does NOT require a
    // measure. A measure-less passthrough table is a pure dimension query and
    // counts its groups perfectly well — guarding it here is what used to
    // black out "Page X of Y" / "N rows".
    // The authored Top-N caps the companion too (finding 6): the pageable
    // universe is the first authoredLimit groups, so the pager must count
    // exactly those — not the unlimited group count.
    const base = toWireSpec(
      { ...drilledChart, query: { ...drilledChart.query, sort: [], limit: authoredLimit } },
      modelId,
      mergedFilters,
      runtime.dashboards.wireDefinitionsForChart(drilledChart),
    );
    return tableHaving.length > 0 ? { ...base, having: tableHaving } : base;
  }, [
    isTable,
    pageSize,
    modelId,
    drilledChart,
    mergedFilters,
    tableHaving,
    authoredLimit,
    runtime,
  ]);

  const countKey = countSpec ? runtime.queries.keyFor(countSpec) : null;
  const countEntry = useQueryCacheState((state) =>
    countKey ? state.entries[countKey] : undefined,
  );
  const countSpecRef = useRef(countSpec);
  countSpecRef.current = countSpec;

  useEffect(() => {
    if (!countKey) return;
    const spec = countSpecRef.current;
    if (!spec) return;
    runtime.queries.run(spec).catch(() => {
      // surfaced via the cache entry (the pager degrades to "Page X")
    });
  }, [runtime, countKey, refreshKey]);

  // A server-truncated companion can't count everything — report "unknown"
  // (graceful "Page X", no Last jump) instead of a wrong smaller total. With
  // an authored Top-N the truncation point IS the known total: the pageable
  // universe ends exactly at the authored cut.
  const tableTotalRows = useMemo<number | null>(() => {
    if (!countSpec || countEntry?.status !== 'ok' || !countEntry.data) return null;
    const rowCount = countEntry.data.rows.length;
    if (countEntry.data.meta.truncated) return authoredLimit;
    return authoredLimit !== null ? Math.min(rowCount, authoredLimit) : rowCount;
  }, [countSpec, countEntry, authoredLimit]);
  const tablePageCount =
    tableTotalRows !== null && pageSize !== null
      ? Math.max(1, Math.ceil(tableTotalRows / pageSize))
      : null;

  /* ------------------------------------------------------- hover highlight */

  const hoverEnabled = chart.format.hoverHighlight !== false;
  /**
   * Receiver-side subscription, reduced to a PRIMITIVE inside the selector:
   * the label THIS tile should dim against (null = no dimming). Subscribing
   * to the raw hoverHighlight object re-rendered EVERY tile on the page on
   * every hovered-category change (the payload's identity changes per write);
   * a string/null snapshot compares by value, so a hover broadcast re-renders
   * only the tiles whose effective highlight actually changed — the source
   * tile and non-matching tiles skip entirely.
   */
  const drilledAxis = drilledChart.query.axis ?? null;
  const drilledLegend = drilledChart.query.legend ?? null;
  const highlightLabel = useDashboardState((state) => {
    const hh = state.hoverHighlight;
    if (!hoverEnabled || hh === null || hh.sourceTileId === tileId) return null;
    const matches = (dim: DimensionRef | null): boolean =>
      dim !== null &&
      dim.table === hh.dimension.table &&
      dim.column === hh.dimension.column &&
      // Same column, different buckets = different labels. Without this a
      // chart showing raw dates dims itself against a "Yes" it never plots.
      groupingKeyOf(dim) === (hh.dimension.groupingKey ?? null);
    return matches(drilledAxis) || matches(drilledLegend) ? hh.label : null;
  });

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
        dimension: {
          table: dimension.table,
          column: dimension.column,
          groupingKey: groupingKeyOf(dimension),
        },
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
  // Identity is stable while the label is unchanged (renderer prop equality).
  const highlightCategory = useMemo(
    () => (highlightLabel === null ? null : { label: highlightLabel }),
    [highlightLabel],
  );

  /* ------------------------------------------------ own selection / ranges */

  /**
   * Echo of THIS tile's own cross-filter source state: the clicked category
   * and/or legend value stay marked on the source chart while the page-wide
   * filter is live (format.selectionHighlight === false opts out). The
   * receiver-side dimming other tiles get is unrelated (highlightCategory).
   */
  const selection = useMemo(() => {
    if (chart.format.selectionHighlight === false) return null;
    const categories = activeCategories && activeCategories.length > 1 ? activeCategories : null;
    const cells = activeCells && activeCells.length > 0 ? activeCells : null;
    if (
      activeCategoryLabel === null &&
      selectedLegendLabel === null &&
      categories === null &&
      cells === null
    ) {
      return null;
    }
    return { category: activeCategoryLabel, legendValue: selectedLegendLabel, categories, cells };
  }, [
    chart.format.selectionHighlight,
    activeCategoryLabel,
    activeCategories,
    activeCells,
    selectedLegendLabel,
  ]);

  // Freshest effective chart + result columns for the stable range callback
  // (assignment every render, mirrors hoverDimsRef).
  const crossInputsRef = useRef<{ chart: ChartSpec; columns: QueryColumn[] | null }>({
    chart: drilledChart,
    columns: null,
  });
  crossInputsRef.current = {
    chart: drilledChart,
    columns: lastResultRef.current?.columns ?? null,
  };

  /** Date-axis drag selection -> the same range cross-filter a bucket click makes. */
  const axisRangeEnabled =
    onAxisRangeCrossFilter !== undefined && chart.format.zoom?.dragAction === 'crossFilter';

  const handleAxisRangeSelect = useCallback(
    (range: { fromRaw: unknown; toRaw: unknown }) => {
      const inputs = crossInputsRef.current;
      onAxisRangeCrossFilter?.(inputs.chart, range, inputs.columns);
    },
    [onAxisRangeCrossFilter],
  );

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
    // data-rcd-no-export: interactive chrome, never part of an image export.
    <div
      className="flex min-w-0 shrink-0 items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      data-rcd-no-export
    >
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
      // DOM anchor for tile-scoped lookups that live outside this component —
      // the image-export menu items resolve the chart's <svg> through it.
      data-rcd-tile={tileId}
      className={`relative h-full rounded-xl ${editable && selected ? 'ring-2 ring-[var(--rcd-accent-interactive)]' : ''}`}
      onClick={editable ? onSelect : undefined}
    >
      {filterBadgeLabel !== null && filterBadgeLabel !== '' && (
        // Edit mode keeps the kebab in the top-right corner — shift left of it.
        <TileFilterBadge
          label={filterBadgeLabel}
          accentColor={filterBadgeAccent}
          positionClassName={editable ? 'right-9 top-1.5' : 'right-1.5 top-1.5'}
        />
      )}
      <TileFrame
        title={chart.title}
        editable={editable}
        container={chart.format.container ?? null}
        titleStyle={chart.format.titleStyle ?? null}
        headerExtra={drillControls}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onCopy={onCopy}
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
              drillMode
                ? undefined
                : (info) =>
                    onCrossFilter(drilledChart, info, lastResultRef.current?.columns ?? null)
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
            onLegendSelect={(e) =>
              onLegendSelect(drilledChart, e, lastResultRef.current?.columns ?? null)
            }
            selectedLegendLabel={selectedLegendLabel}
            activeCategory={activeCategoryLabel !== null ? { label: activeCategoryLabel } : null}
            // Renderer-side marking of THIS tile's own clicked datum/legend
            // value while it is the cross-filter source.
            selection={selection}
            // D3: the per-measure failure notice offers a way to FIX the
            // measure. This tile has no authoring surface of its own, so the
            // shortcut opens the chart builder — which is where the measure
            // manager lives, and where the notice repeats with a direct
            // shortcut to that measure's editor. A viewer who cannot edit
            // charts still gets the notice, just without the button.
            onEditMeasure={editable ? () => onEdit() : undefined}
            onAxisRangeSelect={axisRangeEnabled ? handleAxisRangeSelect : undefined}
            onPointHover={hoverEnabled ? handlePointHover : undefined}
            highlightCategory={highlightCategory}
            tableSort={tableState.sort}
            onTableSortChange={
              isTable && tableOptions?.sortable !== false ? handleTableSortChange : undefined
            }
            tablePage={tablePage}
            tablePageCount={tablePageCount}
            onTablePageChange={pageSize !== null ? handleTablePageChange : undefined}
            tableTotalRows={tableTotalRows}
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
