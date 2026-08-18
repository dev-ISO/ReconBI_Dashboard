import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Filter as FilterIcon,
  Loader2,
} from 'lucide-react';
import {
  formatCellValue,
  seriesStyleLookup,
  type CellValue,
  type ChartPointEvent,
  type ChartSpec,
  type ConditionalFormatSpec,
  type QueryColumn,
  type QueryResult,
} from '@recon/dashboards-core';
import { conditionalColor, matchRuleColor } from './analytics';
import { legacyMeasureColumnLabels } from './chartData';
import { textStyleToCss } from './textStyle';
import type { ChartDatumClickInfo, ChartDatumFacet, ChartSelection } from './ChartRenderer';

/** One sort level: a result column NAME plus its direction. */
export interface TableSortLevel {
  /** Result column NAME. */
  column: string;
  direction: 'asc' | 'desc';
}

/**
 * Active header sort (null = unsorted). MULTI-LEVEL: the object itself is the
 * PRIMARY level and `thenBy` carries the tie-breakers in priority order, so
 * every consumer that only reads {column, direction} keeps seeing the primary
 * sort exactly as before (the pass-through layers between this renderer and
 * the tile are typed on that narrower shape and forward the value verbatim).
 * Use `tableSortLevels` / `tableSortFromLevels` to work with the flat list.
 */
export interface TableSortState extends TableSortLevel {
  /** Levels applied AFTER the primary one, in priority order (2nd, 3rd, …). */
  thenBy?: TableSortLevel[];
}

/** Flattens a sort state into its ordered levels ([] = unsorted). */
export const tableSortLevels = (sort: TableSortState | null | undefined): TableSortLevel[] =>
  sort ? [{ column: sort.column, direction: sort.direction }, ...(sort.thenBy ?? [])] : [];

/** Inverse of `tableSortLevels`: head + tail ([] = null = unsorted). */
export const tableSortFromLevels = (levels: TableSortLevel[]): TableSortState | null => {
  const [first, ...rest] = levels;
  if (!first) return null;
  return {
    column: first.column,
    direction: first.direction,
    ...(rest.length > 0 ? { thenBy: rest } : null),
  };
};

/** Partial layout change from a resize/reorder gesture; consumer merges it. */
export interface TableLayoutPatch {
  /** Only the column(s) the gesture touched, px, keyed by result column NAME. */
  columnWidths?: Record<string, number>;
  /** FULL display order (every rendered column name) after a reorder drop. */
  columnOrder?: string[];
  /**
   * Viewer picked a page size from the pager's pageSizeOptions picker
   * (0 = "All"/unpaged). Rides the same layout-patch channel as widths/order:
   * transient personal view state in view mode, a doc write in edit mode.
   */
  pageSize?: number;
}

/** Operators a header-menu condition filter can carry. */
export type TableFilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains'
  | 'startsWith';

/**
 * One committed header-menu filter, keyed by result column NAME. 'values' is
 * an Excel-style checked-value list (raw cells); 'condition' is a single
 * operator clause ('between' carries two values). At most one filter per
 * column; the TILE owns the list and maps it onto wire FilterClauses/HAVING.
 */
export type TableColumnFilter = { column: string } & (
  | {
      kind: 'values';
      /**
       * Checked raw cells to KEEP — or, when `inverted`, the UNCHECKED cells
       * to EXCLUDE while everything else (blanks included) stays. Measure
       * columns commit the inverted form whenever "(Blanks)" is checked:
       * post-aggregation membership (wire HAVING 'in') can never match a NULL
       * aggregate, so the consumer maps inverted lists onto 'notIn', whose
       * complement semantics keep NULLs.
       */
      values: CellValue[];
      inverted?: boolean;
    }
  | { kind: 'condition'; operator: TableFilterOperator; values: (string | number)[] }
);

/**
 * Echo of the cross-filter THIS table is currently driving, so the source row(s)
 * can mark themselves. Structurally a SUPERSET of the renderer's ChartSelection
 * (wave 12), so ChartRenderer forwards its own `selection` prop verbatim:
 *
 * - `category` / `legendValue` are the single-value facets. A table has one
 *   interaction identity (its first dimension column), so EITHER facet matching
 *   a row marks it — unlike the cartesian charts, where the two facets address
 *   different axes and must both match.
 * - `categories` carries a Ctrl-accumulated MULTI-value set; every row matching
 *   any entry is marked. Optional: the consumer that only has the wave-12
 *   single-value contract simply omits it.
 *
 * Matching uses the same rule the cartesian/pie selection uses — the formatted
 * label, or a stringified RAW cell — so consumers may echo either form.
 */
export interface TableSelection extends ChartSelection {
  /** Ctrl-accumulated multi-select; each entry matched like `category`. */
  categories?: readonly string[] | null;
  /**
   * COLUMN-QUALIFIED facets (wave 18): the active filters tagged with the
   * "table.column" each one filters, matched against the result column's
   * `source`. Required to mark the right cell once clickFilter 'cell' lets a
   * click filter on a column other than the first; when present they mark the
   * matching CELLS (accent bar per cell) and the unqualified facets above are
   * only a fallback for consumers that don't send them.
   */
  cells?: readonly { source: string | null; label: string }[] | null;
}

export interface TableChartProps {
  spec: ChartSpec;
  result: QueryResult;
  onDatumClick?: (info: ChartDatumClickInfo) => void;
  onPointClick?: (e: ChartPointEvent) => void;
  onPointContextMenu?: (e: ChartPointEvent) => void;
  /** Row hover in/out (already throttled by ChartRenderer); null = left the table. */
  onPointHover?: (e: ChartPointEvent | null) => void;
  /** Page-level hover highlight echo: NON-matching rows dim (see ChartRenderer). */
  highlightCategory?: { label: string } | null;
  /**
   * The row value(s) driving THIS table's own active cross-filter. Matching
   * rows render an accent left bar plus a tinted background for as long as the
   * filter holds, and go back to normal the moment it clears. Opted out of by
   * format.selectionHighlight === false, like every other selection marking.
   */
  selection?: TableSelection | null;
  /**
   * Echo of the tile's server-side sort (all levels); drives the header
   * indicators only — arrows plus a priority badge while multi-level.
   */
  tableSort?: TableSortState | null;
  /**
   * Header click cycles asc -> desc -> none on that column ALONE (replacing
   * every level); SHIFT+click appends it as the next level, or cycles that
   * level asc -> desc -> removed while keeping its position. The menu's sort
   * rows drive the same two actions explicitly. Gated by table.sortable.
   */
  onTableSortChange?: (s: TableSortState | null) => void;
  /** 0-based page index the TILE is currently serving (default 0). */
  tablePage?: number;
  /** Total pages; null = unknown -> keep "next" enabled until the tile says otherwise. */
  tablePageCount?: number | null;
  onTablePageChange?: (page: number) => void;
  /**
   * Total row count over the FULL filtered result (the tile's lazy companion
   * count query); null = unknown. Drives the "of N" row label and, together
   * with tablePageCount, the Last-page jump. The pager degrades gracefully
   * without it: plain "Page X", no Last button.
   */
  tableTotalRows?: number | null;
  /**
   * Full-data totals, aligned to the MEASURE columns in RESULT order (index i
   * = i-th measure column). Renders a bold pinned bottom "Total" row.
   */
  totalsRow?: (number | null)[] | null;
  /** Column resize (drag the header edge, min 60px) / header drag-to-reorder. */
  onTableLayoutChange?: (patch: TableLayoutPatch) => void;
  /**
   * Echo of the committed header-menu filters — the TILE owns the truth; the
   * table only renders badges and pre-populates menus from it.
   */
  tableFilters?: TableColumnFilter[];
  /**
   * Header-menu filter commits: fires with the FULL updated filter list
   * (Apply replaces/asserts the column's entry, Clear filter removes it).
   * Menus render only when format.table.filterable !== false.
   */
  onTableFilterChange?: (filters: TableColumnFilter[]) => void;
  /**
   * Fetches the distinct values for a DIMENSION column's checkbox filter list
   * (server-side limited; the menu notes when the cap is hit). Called lazily
   * when a dimension header menu opens.
   */
  onRequestColumnValues?: (column: string) => Promise<CellValue[]>;
}

/** Row cap when the tile is NOT paging (pageSize unset): render-cost guard. */
const TABLE_ROW_CAP = 500;

/** Columns can't be dragged narrower than this (px). */
const MIN_COLUMN_WIDTH = 60;

/** Default width assumed for a never-measured column mid-gesture. */
const FALLBACK_COLUMN_WIDTH = 120;

/** Theme-neutral zebra/hover overlay tint (works on light and dark surfaces). */
const STRIPE_TINT = 'rgba(127, 127, 127, 0.07)';

/**
 * Row(s) driving this table's active cross-filter: a translucent accent wash
 * that LAYERS over whatever the cell already paints (zebra stripe, pinned
 * surface, conditional-format fill), so the mark never hides the data.
 */
const SELECTION_TINT = 'color-mix(in srgb, var(--rcd-accent-interactive) 16%, transparent)';

/**
 * The accent bar down the left edge of a selected row — same
 * --rcd-accent-interactive the charts' selection ring uses, so a filtering
 * table row and a filtering bar/slice read as one system. Painted as an inset
 * shadow on the row's FIRST cell (a border would shift the column width).
 */
const SELECTION_BAR = 'inset 3px 0 0 var(--rcd-accent-interactive)';

/** Row heights (px) per table.density. */
const DENSITY_ROW_HEIGHTS = { compact: 28, normal: 36, relaxed: 44 } as const;

/**
 * Default header background: the shadcn "muted" tone — the muted token mixed
 * softly over the surface. Stays SOLID in both themes (sticky headers need a
 * solid paint to scroll over body cells without bleed-through).
 */
const DEFAULT_HEADER_BG = 'color-mix(in srgb, var(--rcd-muted) 8%, var(--rcd-surface))';

/** Value lists are server-limited; at/past this length the menu says so. */
const COLUMN_VALUES_CAP = 200;

/**
 * Backgrounds for sticky (pinned) cells: they scroll over other cells, so they
 * need a SOLID surface behind any tint — a bare rgba stripe would let the
 * scrolled content bleed through. Non-pinned cells just take the tint.
 */
const pinnedBackground = (tint: string | null): string =>
  tint ? tintOver(tint, 'var(--rcd-surface)') : 'var(--rcd-surface)';

/**
 * Layers a translucent tint over an existing paint. A flat two-stop gradient is
 * the only way a `background` shorthand can stack a tint on top of another
 * color/gradient; the base rides as the shorthand's final (color) layer.
 */
function tintOver(tint: string, base: string): string {
  return `linear-gradient(${tint}, ${tint}), ${base}`;
}

interface ColumnLayout {
  column: QueryColumn;
  /** Index into the result's row arrays (rows stay in wire column order). */
  cellIndex: number;
  /** Sticky-left offset when pinned; null = not pinned. */
  pinnedLeft: number | null;
  width: number | undefined;
}

/** Stable identity for a distinct cell value inside the checkbox list. */
const valueKey = (value: CellValue): string =>
  value === null ? '\u0000null' : `${typeof value}:${String(value)}`;

/** Condition operators offered for TEXT-ish dimension columns. */
const TEXT_OPERATORS: { op: TableFilterOperator; label: string }[] = [
  { op: 'eq', label: 'Equals' },
  { op: 'contains', label: 'Contains' },
  { op: 'startsWith', label: 'Starts with' },
];

/** Condition operators offered for numeric/date dimensions and measures. */
const NUMERIC_OPERATORS: { op: TableFilterOperator; label: string }[] = [
  { op: 'eq', label: '=' },
  { op: 'neq', label: '≠' },
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'between', label: 'Between' },
];

/** Numeric inputs parse to numbers when they can; dims may pass raw strings. */
const conditionValue = (raw: string, numeric: boolean): string | number => {
  if (!numeric) return raw;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? raw : parsed;
};

interface HeaderMenuPanelProps {
  column: QueryColumn;
  /** Display label after seriesLabels overrides (menu heading). */
  displayLabel: string;
  position: { top: number; left: number };
  onClose: () => void;
  /** This column's direction in the active sort; null = not a sort level. */
  sorted: 'asc' | 'desc' | null;
  /** 1-based priority of this column among the levels; 0 = not a level. */
  sortPriority: number;
  /** How many sort levels are active across the whole table. */
  sortLevelCount: number;
  /**
   * Sort section (absent = column not sortable / no consumer). `additive`
   * false replaces every level with this column; true adds it as the next
   * level (or re-points its existing level, keeping the position).
   */
  onSort?: (direction: 'asc' | 'desc', additive: boolean) => void;
  /** Drops THIS column's level, keeping the others. */
  onRemoveSortLevel?: () => void;
  /** Clears every level. */
  onClearSort?: () => void;
  /** Filter section (undefined = no filter consumer -> sort-only menu). */
  filter?: TableColumnFilter | null;
  onCommitFilter?: (filter: TableColumnFilter | null) => void;
  onRequestColumnValues?: (column: string) => Promise<CellValue[]>;
}

/**
 * The dropped-open header menu (portaled; state mounts fresh per open, so the
 * draft always starts from the committed filter). Sort rows drive the existing
 * onTableSortChange contract directly (and close); the filter draft commits
 * only on Apply.
 */
function HeaderMenuPanel({
  column,
  displayLabel,
  position,
  onClose,
  sorted,
  sortPriority,
  sortLevelCount,
  onSort,
  onRemoveSortLevel,
  onClearSort,
  filter = null,
  onCommitFilter,
  onRequestColumnValues,
}: HeaderMenuPanelProps) {
  const isMeasure = column.role === 'measure';
  const textual = !isMeasure && (column.type === 'text' || column.type === 'boolean');
  const operators = textual ? TEXT_OPERATORS : NUMERIC_OPERATORS;
  const numericInput = isMeasure || column.type === 'integer' || column.type === 'decimal';
  // Excel semantics on EVERY column: measures get the checklist too (the
  // consumer serves their DISTINCT AGGREGATED values over the full filtered,
  // pre-pagination result).
  const canListValues = Boolean(onRequestColumnValues);

  // ---- filter draft (seeded from the committed filter) ----------------------
  const [operator, setOperator] = useState<TableFilterOperator | ''>(
    filter?.kind === 'condition' ? filter.operator : '',
  );
  const [v1, setV1] = useState(
    filter?.kind === 'condition' && filter.values[0] !== undefined
      ? String(filter.values[0])
      : '',
  );
  const [v2, setV2] = useState(
    filter?.kind === 'condition' && filter.values[1] !== undefined
      ? String(filter.values[1])
      : '',
  );
  // checked: key -> raw value; null = untouched (reads as "all selected").
  // Seeded from a committed values filter so reopening shows the selection.
  // An INVERTED filter stores the UNCHECKED values, so its seed waits for the
  // domain to load (see the fetch below) and starts as "all selected".
  const [checked, setChecked] = useState<Map<string, CellValue> | null>(
    filter?.kind === 'values' && filter.inverted !== true
      ? new Map(filter.values.map((value) => [valueKey(value), value]))
      : null,
  );
  const [search, setSearch] = useState('');
  // Committed inverted exclusion keys captured at mount (panel remounts per open).
  const invertedSeedRef = useRef<Set<string> | null>(
    filter?.kind === 'values' && filter.inverted === true
      ? new Set(filter.values.map(valueKey))
      : null,
  );

  // ---- distinct values (lazy fetch on open) --------------------------------
  const [values, setValues] = useState<CellValue[] | null>(null);
  const [valuesError, setValuesError] = useState(false);
  const [loadingValues, setLoadingValues] = useState(canListValues);
  useEffect(() => {
    if (!canListValues || !onRequestColumnValues) return;
    let cancelled = false;
    setLoadingValues(true);
    setValuesError(false);
    onRequestColumnValues(column.name).then(
      (fetched) => {
        if (cancelled) return;
        setValues(fetched);
        setLoadingValues(false);
        const excluded = invertedSeedRef.current;
        if (excluded) {
          // Re-derive the checked set from the inverted commit: domain minus
          // the excluded values. `prev ??` keeps any interaction that raced in.
          setChecked(
            (prev) =>
              prev ??
              new Map(
                fetched
                  .filter((v) => !excluded.has(valueKey(v)))
                  .map((v): [string, CellValue] => [valueKey(v), v]),
              ),
          );
        }
      },
      () => {
        if (cancelled) return;
        setValuesError(true);
        setLoadingValues(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // Fetch once per open; the panel remounts on every open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const valueLabel = (value: CellValue): string => {
    if (value === null) return '(Blanks)';
    const text = formatCellValue(value, column);
    return text === '' ? '(Blanks)' : text;
  };
  const searchLower = search.trim().toLowerCase();
  const visibleValues =
    values === null
      ? []
      : searchLower === ''
        ? values
        : values.filter((v) => valueLabel(v).toLowerCase().includes(searchLower));

  const isChecked = (value: CellValue): boolean =>
    checked === null || checked.has(valueKey(value));
  const toggleValue = (value: CellValue) => {
    setChecked((prev) => {
      // First touch materializes "all selected" so unchecking one works.
      const next = new Map(
        prev ?? (values ?? []).map((v): [string, CellValue] => [valueKey(v), v]),
      );
      const key = valueKey(value);
      if (next.has(key)) next.delete(key);
      else next.set(key, value);
      return next;
    });
  };

  const conditionEngaged =
    operator !== '' && v1.trim() !== '' && (operator !== 'between' || v2.trim() !== '');

  const apply = () => {
    if (!onCommitFilter) return;
    if (conditionEngaged) {
      const conditionValues: (string | number)[] = [conditionValue(v1.trim(), numericInput)];
      if (operator === 'between') conditionValues.push(conditionValue(v2.trim(), numericInput));
      onCommitFilter({
        column: column.name,
        kind: 'condition',
        operator,
        values: conditionValues,
      });
    } else if (checked !== null) {
      // Checking everything back reads as "no filter".
      const allSelected = values !== null && checked.size >= values.length;
      if (allSelected) {
        onCommitFilter(null);
      } else if (isMeasure && values !== null && checked.has(valueKey(null))) {
        // "(Blanks)" checked on a measure: HAVING 'in' can never match a NULL
        // aggregate, so commit the complement (the UNCHECKED values) as an
        // inverted list — the consumer maps it onto 'notIn', which keeps
        // blanks. It is also the cheaper form when most values stay checked.
        const excluded = values.filter((v) => v !== null && !checked.has(valueKey(v)));
        onCommitFilter({ column: column.name, kind: 'values', values: excluded, inverted: true });
      } else {
        onCommitFilter({ column: column.name, kind: 'values', values: [...checked.values()] });
      }
    } else {
      onCommitFilter(null);
    }
    onClose();
  };
  const clearFilter = () => {
    onCommitFilter?.(null);
    onClose();
  };

  // ---- sort section wording (Excel-like, type-aware) ------------------------
  const ascWord = textual ? 'A→Z' : 'smallest to largest';
  const descWord = textual ? 'Z→A' : 'largest to smallest';
  /** This column is the ENTIRE sort — the plain "Sort …" rows describe it. */
  const isSoleLevel = sortPriority === 1 && sortLevelCount === 1;
  /**
   * The add/extend rows only appear once they mean something: some sort is
   * already active AND it is not just this column on its own.
   */
  const showAddRows = sortLevelCount > 0 && !isSoleLevel;
  const addPrefix = sortPriority > 0 ? `Level ${sortPriority}: ` : 'Add to sort: ';

  const sortRow = (
    label: string,
    active: boolean,
    action: () => void,
    disabled = false,
  ): ReactNode => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        action();
        onClose();
      }}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
        disabled
          ? 'cursor-default text-rcd-muted opacity-50'
          : 'text-rcd-text hover:bg-black/5 dark:hover:bg-white/10'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={12} className="shrink-0 text-rcd-accent" />}
    </button>
  );

  const inputClass =
    'min-w-0 flex-1 rounded border border-rcd-border bg-transparent px-1.5 py-1 text-xs text-rcd-text placeholder:text-rcd-muted focus:outline-none focus:ring-1 focus:ring-rcd-accent';

  // Escape closes the menu (matches the backdrop click).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    // The .rcd-root wrapper re-establishes theme tokens outside the tree.
    // stopPropagation on the wrapper: React PORTALS bubble events through the
    // REACT tree, so without it every click inside the menu (the Condition
    // <select>, checkboxes, Apply, even the backdrop) would reach the header
    // cell's onClick and cycle the SORT — the "sort flips when I pick a
    // condition" bug. Only the explicit Sort rows may drive sorting.
    <div
      className="rcd-root bg-transparent"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="fixed inset-0 z-[70]" aria-hidden onClick={onClose} />
      <div
        role="menu"
        aria-label={`${displayLabel} column menu`}
        style={{ top: position.top, left: position.left, maxHeight: 'calc(100vh - 16px)' }}
        className="fixed z-[71] flex w-64 flex-col overflow-hidden rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-lg"
      >
        {onSort && (
          <>
            {/* Replace-everything rows: checked only when this column IS the
                whole sort (a lone level in that direction). */}
            {sortRow(`Sort ${ascWord}`, isSoleLevel && sorted === 'asc', () => onSort('asc', false))}
            {sortRow(`Sort ${descWord}`, isSoleLevel && sorted === 'desc', () => onSort('desc', false))}
            {showAddRows && (
              <>
                <div className="my-1 border-t border-rcd-border" />
                {sortRow(
                  `${addPrefix}${ascWord}`,
                  !isSoleLevel && sorted === 'asc',
                  () => onSort('asc', true),
                )}
                {sortRow(
                  `${addPrefix}${descWord}`,
                  !isSoleLevel && sorted === 'desc',
                  () => onSort('desc', true),
                )}
              </>
            )}
            {sortPriority > 0 && sortLevelCount > 1 && (
              <>
                {sortRow('Remove from sort', false, () => onRemoveSortLevel?.())}
              </>
            )}
            {sortRow(
              sortLevelCount > 1 ? `Clear sort (${sortLevelCount} levels)` : 'Clear sort',
              false,
              () => onClearSort?.(),
              sortLevelCount === 0,
            )}
          </>
        )}
        {onSort && onCommitFilter && <div className="my-1 border-t border-rcd-border" />}
        {onCommitFilter && (
          <div className="flex min-h-0 flex-col gap-2 px-2.5 pb-1 pt-1.5">
            {canListValues && (
              <div className="flex min-h-0 flex-col gap-1.5">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search values"
                  className={inputClass}
                />
                {loadingValues && (
                  <div className="flex items-center gap-1.5 py-1 text-xs text-rcd-muted">
                    <Loader2 size={12} className="animate-spin" /> Loading values…
                  </div>
                )}
                {valuesError && (
                  <div className="py-1 text-xs" style={{ color: 'var(--rcd-status-critical)' }}>
                    Couldn’t load values.
                  </div>
                )}
                {values !== null && (
                  <>
                    <div className="flex items-center gap-2 text-[11px]">
                      <button
                        type="button"
                        onClick={() =>
                          setChecked(new Map(values.map((v): [string, CellValue] => [valueKey(v), v])))
                        }
                        className="text-rcd-accent hover:underline"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setChecked(new Map())}
                        className="text-rcd-accent hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="max-h-40 min-h-0 overflow-auto rounded border border-rcd-border">
                      {visibleValues.length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-rcd-muted">No values</div>
                      )}
                      {visibleValues.map((value) => {
                        const key = valueKey(value);
                        return (
                          <label
                            key={key}
                            className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked(value)}
                              onChange={() => toggleValue(value)}
                              className="h-3 w-3 shrink-0 accent-[var(--rcd-accent)]"
                            />
                            <span className="min-w-0 flex-1 truncate">{valueLabel(value)}</span>
                          </label>
                        );
                      })}
                    </div>
                    {values.length >= COLUMN_VALUES_CAP && (
                      <div className="text-[10px] text-rcd-muted">
                        Showing first {values.length} values
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <select
                  value={operator}
                  onChange={(e) => setOperator(e.target.value as TableFilterOperator | '')}
                  aria-label="Filter condition"
                  className="min-w-0 shrink-0 rounded border border-rcd-border bg-rcd-surface px-1 py-1 text-xs text-rcd-text focus:outline-none focus:ring-1 focus:ring-rcd-accent"
                >
                  <option value="">Condition…</option>
                  {operators.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={v1}
                  onChange={(e) => setV1(e.target.value)}
                  placeholder={operator === 'between' ? 'From' : 'Value'}
                  aria-label="Filter value"
                  className={inputClass}
                />
                {operator === 'between' && (
                  <input
                    type="text"
                    value={v2}
                    onChange={(e) => setV2(e.target.value)}
                    placeholder="To"
                    aria-label="Filter upper value"
                    className={inputClass}
                  />
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-rcd-border pt-1.5">
              <button
                type="button"
                onClick={clearFilter}
                className="rounded px-2 py-1 text-xs text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10"
              >
                Clear filter
              </button>
              <button
                type="button"
                onClick={apply}
                className="rounded bg-[var(--rcd-accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Estimated menu height for viewport clamping (values list makes it tall).
 * `sortRows` = 0 when the column is not sortable; the multi-level rows make
 * the sort section grow, so it is measured in rows rather than assumed.
 */
const menuEstimatedHeight = (hasValues: boolean, sortRows: number): number =>
  (sortRows > 0 ? sortRows * 28 + 8 : 0) + (hasValues ? 300 : 90);

interface HeaderMenuProps {
  column: QueryColumn;
  displayLabel: string;
  sorted: 'asc' | 'desc' | null;
  /** 1-based sort priority of this column (0 = not a sort level). */
  sortPriority: number;
  /** Active sort levels across the table (drives the level-aware rows). */
  sortLevelCount: number;
  filtered: boolean;
  sortEnabled: boolean;
  filter: TableColumnFilter | null;
  onSort?: (direction: 'asc' | 'desc', additive: boolean) => void;
  onRemoveSortLevel?: () => void;
  onClearSort?: () => void;
  onCommitFilter?: (filter: TableColumnFilter | null) => void;
  onRequestColumnValues?: (column: string) => Promise<CellValue[]>;
}

/**
 * Hover-revealed ▼ trigger + its dropdown. Portaled to <body> with a viewport-
 * clamped fixed position (same gotcha as the builder's quick-calc menu: the
 * table lives inside scrollable/transformed containers that clip absolute
 * menus and re-root fixed ones). Always visible while the column has an
 * active sort or filter.
 */
function HeaderMenu({
  column,
  displayLabel,
  sorted,
  sortPriority,
  sortLevelCount,
  filtered,
  sortEnabled,
  filter,
  onSort,
  onRemoveSortLevel,
  onClearSort,
  onCommitFilter,
  onRequestColumnValues,
}: HeaderMenuProps) {
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const open = menuPos !== null;
  const active = sorted !== null || filtered;

  const toggle = () => {
    if (open) {
      setMenuPos(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 256; // w-64
    // Rows: 2 replace + clear, + 2 add/extend rows once a sort exists that is
    // not this column alone, + "Remove from sort" on a shared level.
    const soleLevel = sortPriority === 1 && sortLevelCount === 1;
    const sortRows = sortEnabled
      ? 3 +
        (sortLevelCount > 0 && !soleLevel ? 2 : 0) +
        (sortPriority > 0 && sortLevelCount > 1 ? 1 : 0)
      : 0;
    const estimatedHeight = menuEstimatedHeight(
      Boolean(onRequestColumnValues) && Boolean(onCommitFilter),
      sortRows,
    );
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const top =
      below + estimatedHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - estimatedHeight - 4)
        : below;
    setMenuPos({ top, left });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${displayLabel} column menu`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // The th click still cycles sort; the trigger must not.
          e.stopPropagation();
          toggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        draggable={false}
        className={`shrink-0 rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10 ${
          active || open
            ? 'text-rcd-accent opacity-100'
            : 'text-rcd-muted opacity-0 focus-visible:opacity-100 group-hover/th:opacity-100'
        }`}
      >
        <ChevronDown size={12} />
      </button>
      {menuPos && (
        <HeaderMenuPanel
          column={column}
          displayLabel={displayLabel}
          position={menuPos}
          onClose={() => setMenuPos(null)}
          sorted={sorted}
          sortPriority={sortPriority}
          sortLevelCount={sortLevelCount}
          onSort={sortEnabled ? onSort : undefined}
          onRemoveSortLevel={sortEnabled ? onRemoveSortLevel : undefined}
          onClearSort={sortEnabled ? onClearSort : undefined}
          filter={filter}
          onCommitFilter={onCommitFilter}
          onRequestColumnValues={onRequestColumnValues}
        />
      )}
    </>
  );
}

/**
 * Table chart with full interactive chrome. The renderer stays presentation-
 * only: sorting, paging, totals AND header-menu filters are DRIVEN BY THE
 * TILE via props — header and pager interactions only emit intents
 * (onTableSortChange / onTablePageChange / onTableFilterChange), and rows
 * render exactly as given. Column layout (widths/order/pins/stripes) comes
 * from format.table; resize and reorder gestures emit onTableLayoutChange
 * patches for the consumer to persist. Structural styling (alignment,
 * borders, header paint, density, font size) also reads format.table.
 */
export function TableChart({
  spec,
  result,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  onPointHover,
  highlightCategory = null,
  selection = null,
  tableSort = null,
  onTableSortChange,
  tablePage = 0,
  tablePageCount = null,
  onTablePageChange,
  tableTotalRows = null,
  totalsRow = null,
  onTableLayoutChange,
  tableFilters,
  onTableFilterChange,
  onRequestColumnValues,
}: TableChartProps) {
  const format = spec.format;
  const table = format.table ?? {};
  const headerStyle = textStyleToCss(format.legendStyle);
  const paged = table.pageSize != null && table.pageSize > 0;
  // Paged results are already one page (ChartQuerySpec.offset/limit); the cap
  // only guards the single-page path.
  const rows = paged ? result.rows : result.rows.slice(0, TABLE_ROW_CAP);
  const measureColumns = result.columns.filter((c) => c.role === 'measure');
  // Pre-Wave-21 label form per measure column (undefined = identical) — the
  // legacy fallback key for seriesLabels / conditionalFormats saved before
  // friendly labels re-labeled inline measures (ChartSeries.legacyStyleKey
  // contract). Keyed by column NAME so per-cell lookups stay O(1).
  const legacyLabelByName = new Map<string, string | undefined>(
    legacyMeasureColumnLabels(measureColumns, spec).map((legacy, i) => [
      measureColumns[i]!.name,
      legacy,
    ]),
  );

  // ---- structural styling from TableOptions --------------------------------
  const headerAlign = table.headerAlign ?? 'center';
  const baseVerticalAlign = table.verticalAlign ?? 'middle';
  /** Per-column vertical alignment: columnVerticalAlign wins, then verticalAlign. */
  const verticalAlignFor = (column: QueryColumn): 'top' | 'middle' | 'bottom' =>
    table.columnVerticalAlign?.[column.name] ?? baseVerticalAlign;
  const wrapText = table.wrapText === true;
  /**
   * Cell text fitting: default truncates on one line (Excel-like uniform
   * rows); wrapText lets content wrap and the row height grow (the td height
   * then acts as a minimum).
   */
  const cellTextFit: CSSProperties = wrapText
    ? { whiteSpace: 'normal', overflowWrap: 'anywhere' }
    : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const borderMode = table.borders ?? 'rows';
  const borderColor = table.borderColor ?? 'var(--rcd-border)';
  const rowHeight = DENSITY_ROW_HEIGHTS[table.density ?? 'normal'];
  const headerBackground = table.headerBackground ?? DEFAULT_HEADER_BG;
  const headerColor = table.headerColor ?? 'var(--rcd-text-2)';
  const headerWeight = table.headerBold !== false ? 600 : 400;
  const cellBorder: CSSProperties = {
    ...(borderMode === 'rows' || borderMode === 'grid'
      ? { borderBottom: `1px solid ${borderColor}` }
      : null),
    ...(borderMode === 'columns' || borderMode === 'grid'
      ? { borderRight: `1px solid ${borderColor}` }
      : null),
  };
  /** Body alignment: explicit columnAlign, else measures right / the rest left. */
  const bodyAlign = (column: QueryColumn): 'left' | 'center' | 'right' =>
    table.columnAlign?.[column.name] ?? (column.role === 'measure' ? 'right' : 'left');
  /** Header alignment: a column's columnAlign override wins over headerAlign. */
  const headerAlignFor = (column: QueryColumn): 'left' | 'center' | 'right' =>
    table.columnAlign?.[column.name] ?? headerAlign;

  // ---- column layout: order -> pin offsets -> widths ----------------------
  // table.columnOrder lists column NAMES; unlisted columns append in wire
  // order, and stale names (removed measures) drop out silently.
  const byName = new Map(result.columns.map((c) => [c.name, c]));
  const orderedColumns: QueryColumn[] = [];
  for (const name of table.columnOrder ?? []) {
    const column = byName.get(name);
    if (column) {
      orderedColumns.push(column);
      byName.delete(name);
    }
  }
  for (const column of result.columns) {
    if (byName.has(column.name)) orderedColumns.push(column);
  }

  // Live widths: persisted format.table.columnWidths under the in-flight drag
  // draft (draft wins while dragging; the consumer echoes it back on commit).
  const [draftWidths, setDraftWidths] = useState<Record<string, number>>({});
  const widths: Record<string, number> = { ...table.columnWidths, ...draftWidths };

  // Pinned offsets need REAL widths (unsized columns auto-size), so header
  // cells are measured after layout; the guarded set keeps renders finite.
  const headerRefs = useRef(new Map<string, HTMLTableCellElement>());
  const [measuredLefts, setMeasuredLefts] = useState<Record<string, number>>({});
  const pinnedCount = Math.max(0, Math.min(table.pinned ?? 0, orderedColumns.length));
  useLayoutEffect(() => {
    if (pinnedCount === 0) return;
    let left = 0;
    const next: Record<string, number> = {};
    for (const column of orderedColumns.slice(0, pinnedCount)) {
      next[column.name] = left;
      // offsetWidth, not getBoundingClientRect: these offsets feed sticky
      // `left` styles, which are LAYOUT px. Under a scaled ancestor (the
      // dashboard's fit-to-page viewport) rect widths are VISUAL px and the
      // pinned columns drifted apart; offsetWidth stays in layout units in
      // both modes. (Integer rounding is well under a px of drift per column.)
      left +=
        widths[column.name] ??
        headerRefs.current.get(column.name)?.offsetWidth ??
        FALLBACK_COLUMN_WIDTH;
    }
    setMeasuredLefts((prev) => {
      const prevKeys = Object.keys(prev);
      const same =
        prevKeys.length === Object.keys(next).length &&
        prevKeys.every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
  });

  const layout: ColumnLayout[] = orderedColumns.map((column, i) => ({
    column,
    cellIndex: result.columns.indexOf(column),
    pinnedLeft: i < pinnedCount ? (measuredLefts[column.name] ?? 0) : null,
    width: widths[column.name],
  }));
  // Fixed layout makes resize deterministic; the explicit min-width lets the
  // table overflow horizontally (which is what makes pinning useful) instead
  // of squeezing the unsized columns to nothing.
  const anyWidths = layout.some((l) => l.width !== undefined);
  const tableMinWidth = anyWidths
    ? layout.reduce((sum, l) => sum + (l.width ?? FALLBACK_COLUMN_WIDTH), 0)
    : undefined;

  // ---- resize (pointer capture on the header-edge handle) -----------------
  const resizable = Boolean(onTableLayoutChange);
  /**
   * `width` is the LIVE dragged width, kept on the ref alongside the draft
   * state: pointermove is a continuous-priority event, so the state update
   * from the final move may not have committed when pointerup fires — a
   * commit that read `draftWidths` here could see a stale (or empty) draft
   * and silently drop the resize. The ref always holds the exact last width.
   */
  const resizeRef = useRef<{
    name: string;
    startX: number;
    startWidth: number;
    width: number | null;
  } | null>(null);
  const startResize = (name: string) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // offsetWidth, not getBoundingClientRect: the measured width seeds a
    // LAYOUT-px column width. Measuring the VISUAL rect under a scaled
    // ancestor (fit-to-page viewport) made the column visibly jump to the
    // scaled size the moment a resize began.
    const startWidth =
      widths[name] ??
      headerRefs.current.get(name)?.offsetWidth ??
      FALLBACK_COLUMN_WIDTH;
    resizeRef.current = { name, startX: e.clientX, startWidth, width: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    const width = Math.max(MIN_COLUMN_WIDTH, Math.round(drag.startWidth + e.clientX - drag.startX));
    drag.width = width;
    setDraftWidths((prev) => (prev[drag.name] === width ? prev : { ...prev, [drag.name]: width }));
  };
  const endResize = () => {
    const drag = resizeRef.current;
    if (!drag) return;
    resizeRef.current = null;
    if (drag.width !== null) {
      onTableLayoutChange?.({ columnWidths: { [drag.name]: drag.width } });
    }
    // Release the draft: the consumer's echo (doc write in edit mode, layout
    // override in view mode) owns the value from here. A draft that lingered
    // forever used to MASK later doc/override changes — the doc could silently
    // lose widths while the table still painted them, so resizes only
    // "un-stuck" after a remount. The commit above and this clear land in one
    // batched render alongside the consumer's echo, so nothing flickers.
    setDraftWidths((prev) => {
      if (!(drag.name in prev)) return prev;
      const { [drag.name]: _released, ...rest } = prev;
      return rest;
    });
  };

  // ---- reorder (HTML5 header drag) ----------------------------------------
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const handleDrop = (targetName: string) => {
    if (!dragColumn || dragColumn === targetName) return;
    const names = orderedColumns.map((c) => c.name).filter((n) => n !== dragColumn);
    const at = names.indexOf(targetName);
    // Dropping ON a column inserts BEFORE it (the drop indicator's left edge).
    names.splice(at === -1 ? names.length : at, 0, dragColumn);
    onTableLayoutChange?.({ columnOrder: names });
  };

  // ---- sorting (multi-level) -----------------------------------------------
  const sortable = table.sortable !== false && Boolean(onTableSortChange);
  /** Active levels in priority order; index 0 = primary. */
  const sortLevels = tableSortLevels(tableSort);
  const sortIndexOf = (name: string): number =>
    sortLevels.findIndex((level) => level.column === name);
  const emitLevels = (levels: TableSortLevel[]) =>
    onTableSortChange?.(tableSortFromLevels(levels));

  /**
   * Header click. `additive` (shift) EXTENDS the sort: an unsorted column
   * becomes the next level, an existing level cycles asc -> desc -> removed
   * in place. A plain click collapses back to a single level on this column,
   * cycling asc -> desc -> unsorted only when it already IS the whole sort.
   */
  const cycleSort = (name: string, additive: boolean) => {
    if (!onTableSortChange) return;
    const index = sortIndexOf(name);
    const current = index === -1 ? null : (sortLevels[index] ?? null);
    if (!additive) {
      const sole = index === 0 && sortLevels.length === 1;
      if (!sole || current === null) {
        onTableSortChange({ column: name, direction: 'asc' });
      } else if (current.direction === 'asc') {
        onTableSortChange({ column: name, direction: 'desc' });
      } else {
        onTableSortChange(null);
      }
      return;
    }
    if (current === null) {
      emitLevels([...sortLevels, { column: name, direction: 'asc' }]);
      return;
    }
    const next = [...sortLevels];
    if (current.direction === 'asc') next[index] = { column: name, direction: 'desc' };
    else next.splice(index, 1);
    emitLevels(next);
  };

  /** Menu action: set this column's direction, replacing or extending. */
  const setSortDirection = (name: string, direction: 'asc' | 'desc', additive: boolean) => {
    if (!onTableSortChange) return;
    if (!additive) {
      onTableSortChange({ column: name, direction });
      return;
    }
    const index = sortIndexOf(name);
    if (index === -1) {
      emitLevels([...sortLevels, { column: name, direction }]);
      return;
    }
    const next = [...sortLevels];
    next[index] = { column: name, direction };
    emitLevels(next);
  };

  /** Menu action: drop just this column's level, keeping the others' order. */
  const removeSortLevel = (name: string) => {
    const index = sortIndexOf(name);
    if (index === -1) return;
    emitLevels(sortLevels.filter((_, i) => i !== index));
  };

  // ---- header-menu filters -------------------------------------------------
  // Menus are gated by table.filterable; the tile owns the committed list.
  const menusEnabled =
    table.filterable !== false && (sortable || Boolean(onTableFilterChange));
  const filterFor = (name: string): TableColumnFilter | null =>
    tableFilters?.find((f) => f.column === name) ?? null;
  const commitFilter = onTableFilterChange
    ? (name: string, filter: TableColumnFilter | null) => {
        const next = (tableFilters ?? []).filter((f) => f.column !== name);
        if (filter) next.push(filter);
        onTableFilterChange(next);
      }
    : undefined;

  // ---- row / cell events (click / context / hover / highlight) -------------
  // ROW IDENTITY (hover, right-click/drill, the point-event axis value) always
  // keys off the FIRST dimension column — drill walks the axis hierarchy, so it
  // must stay on the axis whatever a click cross-filters by.
  //
  // CROSS-FILTER identity is configurable (format.table.clickFilter):
  //   'cell' (default) — the clicked cell's OWN dimension column + value;
  //                      a MEASURE cell falls back to the first dimension.
  //   'firstColumn'    — legacy: always the first dimension's value.
  //   'row'            — every dimension of the row, in one action.
  // Result dimension columns are in wire order ([axis, legend, smallMultiples]),
  // so their ORDINAL is the dimension index the consumer maps back onto the spec.
  const dimensionColumns = result.columns.filter((c) => c.role === 'dimension');
  const clickColumn = dimensionColumns[0] ?? null;
  const clickIndex = clickColumn ? result.columns.indexOf(clickColumn) : -1;
  const clickFilterMode = table.clickFilter ?? 'cell';
  const rowLabel = (row: CellValue[]): string =>
    clickColumn ? formatCellValue(row[clickIndex] ?? null, clickColumn) : '';
  /** The datum facet for one dimension column of a row. */
  const facetFor = (row: CellValue[], column: QueryColumn): ChartDatumFacet => {
    const value = row[result.columns.indexOf(column)] ?? null;
    return {
      dimensionIndex: dimensionColumns.indexOf(column),
      source: column.source,
      value,
      label: formatCellValue(value, column),
    };
  };
  /**
   * What a click on `column` of `row` cross-filters by (null = the result has
   * no dimension at all, so there is nothing to filter). The legacy
   * {value,label} pair always describes the SINGLE clause a plain consumer
   * would apply; 'row' additionally carries every dimension in `facets`.
   */
  const datumClickInfo = (
    row: CellValue[],
    column: QueryColumn | null,
  ): ChartDatumClickInfo | null => {
    if (!clickColumn) return null;
    if (clickFilterMode === 'cell' && column?.role === 'dimension') return facetFor(row, column);
    const first = facetFor(row, clickColumn);
    return clickFilterMode === 'row'
      ? { ...first, facets: dimensionColumns.map((c) => facetFor(row, c)) }
      : first;
  };
  const handleCellClick =
    onDatumClick && clickColumn
      ? (row: CellValue[], column: QueryColumn) => {
          const info = datumClickInfo(row, column);
          if (info) onDatumClick(info);
        }
      : null;
  /**
   * Cell-level hover affordance: in 'cell' mode the click target IS the cell,
   * so DIMENSION cells tint on hover (measure cells stay flat — they only fall
   * back to the row's first dimension and shouldn't advertise otherwise). Row
   * modes keep the plain row hover. Painted as an inset shadow so it layers
   * over whatever background the cell already carries.
   */
  const cellHoverAffordance = clickFilterMode === 'cell' && Boolean(handleCellClick);
  const rowEvent =
    clickColumn && (onPointClick || onPointContextMenu || onPointHover)
      ? (row: CellValue[], e: { clientX: number; clientY: number }): ChartPointEvent => ({
          axisValue: row[clickIndex] ?? null,
          axisLabel: rowLabel(row),
          clientX: e.clientX,
          clientY: e.clientY,
        })
      : null;
  const clickable = Boolean(handleCellClick) || Boolean(rowEvent && onPointClick);

  // ---- selection: the row(s) driving this table's own cross-filter ---------
  // Facets are flattened once per render: the accumulated set first, then the
  // two single-value facets (either may name the click column on a table — see
  // TableSelection). Empty list = nothing selected, so no row work happens.
  const selectionFacets: string[] =
    format.selectionHighlight === false || selection === null || clickColumn === null
      ? []
      : [...(selection.categories ?? []), selection.category, selection.legendValue].filter(
          (facet): facet is string => typeof facet === 'string',
        );
  /**
   * Does this row's click-column value drive the active cross-filter? Same rule
   * the cartesian/pie selection uses: the FORMATTED label, or a stringified RAW
   * cell, so the consumer may echo back either form.
   */
  const rowSelected = (row: CellValue[]): boolean => {
    if (selectionFacets.length === 0) return false;
    const label = rowLabel(row);
    const raw = row[clickIndex] ?? null;
    return selectionFacets.some(
      (facet) => facet === label || (raw !== null && String(raw) === facet),
    );
  };

  /**
   * COLUMN-QUALIFIED selection (wave 18): with clickFilter 'cell' the active
   * filter can sit on ANY dimension column, so the unqualified facets above
   * would mark the wrong column (or nothing). These carry the filtered
   * "table.column" alongside the label, so the mark lands on the CELL that is
   * actually driving the page — and, in 'row' mode, on each of the row's
   * filtered cells.
   */
  const selectionCells =
    format.selectionHighlight === false || selection === null ? [] : (selection.cells ?? []);
  /** Is THIS dimension cell one of the values driving the active cross-filter? */
  const cellSelected = (row: CellValue[], column: QueryColumn): boolean => {
    if (selectionCells.length === 0 || column.role !== 'dimension') return false;
    const raw = row[result.columns.indexOf(column)] ?? null;
    const label = formatCellValue(raw, column);
    return selectionCells.some(
      (cell) =>
        // A facet without a source (or a result without one) cannot be pinned
        // to a column, so it falls back to matching on the label alone.
        (cell.source == null || column.source == null || cell.source === column.source) &&
        (cell.label === label || (raw !== null && String(raw) === cell.label)),
    );
  };
  /**
   * The facets grouped BY FIELD, keeping only fields this table actually shows.
   * Filters compose the same way the query does — OR within a field (a
   * Ctrl-accumulated value set), AND across fields ('row' mode's clause per
   * dimension) — so a row is marked only when EVERY filtered field matches it,
   * exactly the rows the filter keeps. With one field (the common 'cell' case)
   * this is just "any row carrying the value", as before.
   */
  const selectionGroups: { source: string | null; labels: string[] }[] = [];
  for (const cell of selectionCells) {
    // A field none of this table's dimensions carries can never match; ignoring
    // it keeps the AND from blanking the marking entirely.
    if (cell.source != null && !dimensionColumns.some((c) => c.source === cell.source)) continue;
    const group = selectionGroups.find((g) => g.source === cell.source);
    if (group) group.labels.push(cell.label);
    else selectionGroups.push({ source: cell.source, labels: [cell.label] });
  }
  /** Does the row satisfy EVERY filtered field (see selectionGroups)? */
  const rowSelectedByCells = (matched: Set<number>): boolean => {
    if (selectionGroups.length === 0 || matched.size === 0) return false;
    return selectionGroups.every((group) =>
      [...matched].some((index) => {
        const column = layout[index]?.column;
        if (!column) return false;
        return (
          group.source == null || column.source == null || column.source === group.source
        );
      }),
    );
  };

  // ---- data bars: scale to the DISPLAYED rows' max |value| per column ------
  const dataBars = new Map<
    string,
    { cf: ConditionalFormatSpec; maxAbs: number; hasNegative: boolean }
  >();
  for (const column of measureColumns) {
    const legacyLabel = legacyLabelByName.get(column.name);
    const cf = format.conditionalFormats?.find(
      (f) =>
        f.style === 'dataBar' &&
        // legacyLabel: data bars saved against a pre-Wave-21 measure label.
        (f.measureKey === column.label || (legacyLabel !== undefined && f.measureKey === legacyLabel)),
    );
    if (!cf) continue;
    const columnIndex = result.columns.indexOf(column);
    let maxAbs = 0;
    let hasNegative = false;
    for (const row of rows) {
      const v = row[columnIndex];
      if (typeof v !== 'number') continue;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
      if (v < 0) hasNegative = true;
    }
    if (maxAbs > 0) dataBars.set(column.name, { cf, maxAbs, hasNegative });
  }

  // ---- totals ("Total" label sits in the first displayed dimension column) --
  const totalsActive = totalsRow != null && measureColumns.length > 0;
  const totalLabelName = layout.find((l) => l.column.role !== 'measure')?.column.name;

  // ---- pager ---------------------------------------------------------------
  const pageSize = table.pageSize ?? 0;
  const firstRowNumber = tablePage * pageSize + 1;
  const lastRowNumber = firstRowNumber + rows.length - 1;
  const canPrev = Boolean(onTablePageChange) && tablePage > 0;
  const canNext =
    Boolean(onTablePageChange) && (tablePageCount == null ? true : tablePage < tablePageCount - 1);
  // Page-size picker (viewer-facing): rides the layout-patch channel, so it
  // needs a layout consumer. 0 = "All" (unpaged).
  const sizeOptions = (table.pageSizeOptions ?? []).filter(
    (n) => Number.isFinite(n) && n > 0 && Number.isInteger(n),
  );
  const sizePickerEnabled = sizeOptions.length > 0 && Boolean(onTableLayoutChange);
  const currentSize = paged ? (table.pageSize as number) : 0;
  const sizeChoices = sizeOptions.includes(currentSize)
    ? [0, ...sizeOptions]
    : currentSize === 0
      ? [0, ...sizeOptions]
      : [0, currentSize, ...sizeOptions]; // keep the author default reachable
  const pickPageSize = (n: number) => {
    onTableLayoutChange?.({ pageSize: n });
    // Back to the first page; while unpaged the handler is absent and the
    // tile's page state is already 0 (it resets on every paged -> All switch).
    onTablePageChange?.(0);
  };
  const showPager = paged || sizePickerEnabled;
  /**
   * Total row count: the tile's companion count query when it has answered
   * (tableTotalRows), else derivable locally — unpaged tables have every row
   * in hand; paged tables learn the total once the LAST page is reached
   * (page count via the tile's short-page detection).
   */
  const totalRows =
    tableTotalRows ??
    (!paged
      ? result.rows.length
      : tablePageCount != null && tablePage === tablePageCount - 1
        ? tablePage * pageSize + rows.length
        : null);
  const canLast =
    Boolean(onTablePageChange) && tablePageCount != null && tablePage < tablePageCount - 1;

  const headerLabel = (column: QueryColumn): string =>
    column.role === 'measure'
      ? (seriesStyleLookup(format.seriesLabels, column.label, legacyLabelByName.get(column.name)) ??
        column.label)
      : column.label;

  return (
    <div
      className="flex h-full w-full flex-col"
      onMouseLeave={onPointHover ? () => onPointHover(null) : undefined}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className={`w-full border-separate border-spacing-0 text-sm ${anyWidths ? 'table-fixed' : ''}`}
          style={tableMinWidth !== undefined ? { minWidth: tableMinWidth } : undefined}
        >
          {anyWidths && (
            <colgroup>
              {layout.map((l) => (
                <col key={l.column.name} style={l.width !== undefined ? { width: l.width } : undefined} />
              ))}
            </colgroup>
          )}
          <thead>
            <tr>
              {layout.map((l) => {
                const { column } = l;
                const pinned = l.pinnedLeft !== null;
                const sortIndex = sortIndexOf(column.name);
                const sorted = sortLevels[sortIndex]?.direction ?? null;
                const filter = filterFor(column.name);
                return (
                  <th
                    key={column.name}
                    ref={(el) => {
                      if (el) headerRefs.current.set(column.name, el);
                      else headerRefs.current.delete(column.name);
                    }}
                    draggable={Boolean(onTableLayoutChange)}
                    onDragStart={(e: ReactDragEvent) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', column.name);
                      setDragColumn(column.name);
                    }}
                    onDragOver={(e) => {
                      if (dragColumn && dragColumn !== column.name) {
                        e.preventDefault();
                        setDropTarget(column.name);
                      }
                    }}
                    onDragLeave={() => setDropTarget((t) => (t === column.name ? null : t))}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleDrop(column.name);
                      setDragColumn(null);
                      setDropTarget(null);
                    }}
                    onDragEnd={() => {
                      setDragColumn(null);
                      setDropTarget(null);
                    }}
                    // Shift+click extends the sort instead of replacing it
                    // (the th is already select-none, so the modifier click
                    // cannot start a text selection).
                    onClick={sortable ? (e) => cycleSort(column.name, e.shiftKey) : undefined}
                    aria-sort={
                      !sortable
                        ? undefined
                        : sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : 'none'
                    }
                    style={{
                      background: headerBackground,
                      color: headerColor,
                      fontWeight: headerWeight,
                      verticalAlign: 'middle',
                      borderBottom: `1px solid ${borderColor}`,
                      ...(borderMode === 'columns' || borderMode === 'grid'
                        ? { borderRight: `1px solid ${borderColor}` }
                        : null),
                      ...headerStyle,
                      ...(pinned ? { left: l.pinnedLeft ?? 0 } : null),
                      // Drop indicator: the dragged column will land BEFORE
                      // this one (matches handleDrop's insert-before rule).
                      ...(dropTarget === column.name
                        ? { boxShadow: 'inset 2px 0 0 var(--rcd-accent, currentColor)' }
                        : null),
                    }}
                    // Layering: pinned headers float above plain headers, which
                    // float above pinned body cells, which float above the rest —
                    // all kept BELOW z-20, the floor where floating TILE chrome
                    // (TileFrame kebab/hover controls) lives. At z-20/z-30 these
                    // sticky headers painted over AND stole clicks from the tile's
                    // edit kebab, so a table tile looked uneditable.
                    // group/th (named, not bare `group`): the column-menu chevron
                    // reveals on hovering THIS header cell only — a bare group
                    // matched the tile wrapper's group class, so hovering anywhere
                    // in the tile lit up every chevron at once.
                    className={`group/th sticky top-0 select-none px-3 py-2 text-xs ${
                      pinned ? 'z-10' : 'z-[5]'
                    } ${sortable ? 'cursor-pointer' : ''}`}
                    title={
                      sortable ? 'Click to sort · Shift+click to add a sort level' : undefined
                    }
                  >
                    <span
                      className={`relative flex max-w-full items-center gap-1 ${
                        headerAlignFor(column) === 'center'
                          ? 'justify-center'
                          : headerAlignFor(column) === 'right'
                            ? 'justify-end'
                            : 'justify-start'
                      }`}
                    >
                      <span className={wrapText ? 'whitespace-normal break-words' : 'truncate'}>
                        {headerLabel(column)}
                      </span>
                      {sorted !== null && (
                        // Direction arrow, plus the 1-based priority badge
                        // while more than one level is active.
                        <span className="flex shrink-0 items-center gap-0.5">
                          {sorted === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                          {sortLevels.length > 1 && (
                            <span
                              title={`Sort level ${sortIndex + 1} of ${sortLevels.length}`}
                              style={{
                                background:
                                  'color-mix(in srgb, var(--rcd-accent) 18%, transparent)',
                              }}
                              className="rounded-[3px] px-1 text-[10px] font-semibold leading-[14px] text-rcd-accent tabular-nums"
                            >
                              {sortIndex + 1}
                            </span>
                          )}
                        </span>
                      )}
                      {filter !== null && (
                        <FilterIcon
                          size={10}
                          className="shrink-0 text-rcd-accent"
                          fill="currentColor"
                          aria-label="Filtered"
                        />
                      )}
                      {menusEnabled && (
                        <HeaderMenu
                          column={column}
                          displayLabel={headerLabel(column)}
                          sorted={sorted}
                          sortPriority={sortIndex + 1}
                          sortLevelCount={sortLevels.length}
                          filtered={filter !== null}
                          sortEnabled={sortable}
                          filter={filter}
                          onSort={(direction, additive) =>
                            setSortDirection(column.name, direction, additive)
                          }
                          onRemoveSortLevel={() => removeSortLevel(column.name)}
                          onClearSort={() => onTableSortChange?.(null)}
                          onCommitFilter={
                            commitFilter
                              ? (f) => commitFilter(column.name, f)
                              : undefined
                          }
                          onRequestColumnValues={onRequestColumnValues}
                        />
                      )}
                    </span>
                    {resizable && (
                      // Edge drag handle; wider hit area than its 1px look.
                      // draggable=false + stopPropagation keep it out of the
                      // header's reorder drag and sort click.
                      <span
                        draggable={false}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={startResize(column.name)}
                        onPointerMove={moveResize}
                        onPointerUp={endResize}
                        onPointerCancel={endResize}
                        className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none hover:bg-rcd-border"
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody style={table.fontSize !== undefined ? { fontSize: table.fontSize } : undefined}>
            {rows.map((row, rowIndex) => {
              const striped = Boolean(table.stripes) && rowIndex % 2 === 1;
              // Hover highlight: NON-matching rows dim; the matching row keeps
              // full strength plus a subtle tint so it reads as the focus.
              const rowMatchesHighlight =
                highlightCategory !== null && clickColumn !== null
                  ? rowLabel(row) === highlightCategory.label
                  : null;
              // This row's value is (one of) the active cross-filter value(s).
              // Two paths: the legacy first-column match, and the
              // column-qualified cell match that follows a 'cell'/'row' click.
              const selectedCells = new Set<number>();
              if (selectionCells.length > 0) {
                layout.forEach((l, i) => {
                  if (cellSelected(row, l.column)) selectedCells.add(i);
                });
                // Only the rows the filter actually keeps stay marked; a row
                // matching just one of several AND-ed fields loses its cells.
                if (!rowSelectedByCells(selectedCells)) selectedCells.clear();
              }
              const selected = selectedCells.size > 0 || rowSelected(row);
              return (
                <tr
                  key={rowIndex}
                  // Global attribute, so it is valid on a plain table row: it
                  // announces WHICH row the page is filtered by.
                  aria-current={selected ? true : undefined}
                  onContextMenu={
                    rowEvent && onPointContextMenu
                      ? (e) => {
                          e.preventDefault();
                          onPointContextMenu(rowEvent(row, e));
                        }
                      : undefined
                  }
                  onMouseEnter={
                    rowEvent && onPointHover ? (e) => onPointHover(rowEvent(row, e)) : undefined
                  }
                  className={`${
                    clickable ? 'cursor-pointer ' : ''
                  }hover:bg-black/5 dark:hover:bg-white/10 ${
                    // Selection outranks the hover dim: a row the page is
                    // filtered by never fades because someone hovered elsewhere.
                    rowMatchesHighlight === false && !selected ? 'opacity-40' : ''
                  }`}
                >
                  {layout.map((l, columnIndex) => {
                    const { column } = l;
                    const raw = row[l.cellIndex] ?? null;
                    const isMeasure = column.role === 'measure';
                    const pinned = l.pinnedLeft !== null;
                    // cellBackground / cellText rules key the measure's
                    // DEFAULT label; first matching spec (then rule) wins.
                    // They survive reorder/pinning/paging because they only
                    // depend on the column + cell value.
                    const cellBackground = isMeasure
                      ? conditionalColor(
                          format.conditionalFormats,
                          'cellBackground',
                          column.label,
                          raw,
                          legacyLabelByName.get(column.name),
                        )
                      : undefined;
                    const cellText = isMeasure
                      ? conditionalColor(
                          format.conditionalFormats,
                          'cellText',
                          column.label,
                          raw,
                          legacyLabelByName.get(column.name),
                        )
                      : undefined;
                    const dataBar = isMeasure ? dataBars.get(column.name) : undefined;
                    const text = formatCellValue(raw, column);
                    let content: ReactNode = text;
                    if (dataBar && typeof raw === 'number') {
                      // Proportional bar behind the value, scaled to the
                      // column's max |value|. With negatives, zero sits at
                      // mid-cell: positives grow right, negatives left, each
                      // scaled into its half; all-positive columns use the
                      // full width. Rules may recolor a matching cell's bar;
                      // dataBarColor (default theme accent) otherwise.
                      const fraction = Math.abs(raw) / dataBar.maxAbs;
                      const barColor =
                        matchRuleColor(dataBar.cf.rules, raw) ??
                        dataBar.cf.dataBarColor ??
                        'var(--rcd-accent)';
                      const barBox: CSSProperties = dataBar.hasNegative
                        ? raw >= 0
                          ? { left: '50%', width: `${fraction * 50}%` }
                          : { right: '50%', width: `${fraction * 50}%` }
                        : { left: 0, width: `${fraction * 100}%` };
                      content = (
                        <div className="relative">
                          <div
                            aria-hidden
                            className="absolute inset-y-0 rounded-sm"
                            style={{ ...barBox, background: barColor, opacity: 0.3 }}
                          />
                          <span className="relative">{text}</span>
                        </div>
                      );
                    }
                    const tint =
                      rowMatchesHighlight === true ? STRIPE_TINT : striped ? STRIPE_TINT : null;
                    // Background precedence: conditional rule > pinned surface
                    // (+ tint) > bare tint. Pinned cells always get a SOLID
                    // base so scrolled columns never bleed through them.
                    const baseBackground =
                      cellBackground ?? (pinned ? pinnedBackground(tint) : (tint ?? undefined));
                    // The selection wash goes ON TOP of all of that (including
                    // a conditional-format fill), so the filtering row reads as
                    // selected without losing its own colors.
                    const background = selected
                      ? tintOver(SELECTION_TINT, baseBackground ?? 'transparent')
                      : baseBackground;
                    // Accent bar: on the CELL(S) actually driving the filter
                    // when the selection is column-qualified, else on the
                    // row's leading cell (the legacy first-column marker).
                    const barHere = selected
                      ? selectedCells.size > 0
                        ? selectedCells.has(columnIndex)
                        : columnIndex === 0
                      : false;
                    return (
                      <td
                        key={column.name}
                        onClick={
                          handleCellClick || (rowEvent && onPointClick)
                            ? (e) => {
                                handleCellClick?.(row, column);
                                if (rowEvent && onPointClick) onPointClick(rowEvent(row, e));
                              }
                            : undefined
                        }
                        style={{
                          background,
                          color: cellText,
                          height: rowHeight,
                          textAlign: bodyAlign(column),
                          verticalAlign: verticalAlignFor(column),
                          ...cellTextFit,
                          ...cellBorder,
                          ...(pinned ? { left: l.pinnedLeft ?? 0 } : null),
                          ...(barHere ? { boxShadow: SELECTION_BAR } : null),
                        }}
                        // z-[1], demoted with the header cells: pinned BODY
                        // cells must stay under BOTH header tiers (plain
                        // headers now sit at z-[5]) and, like all renderer
                        // chrome, under the tile's floating controls.
                        className={`px-3 py-1 text-rcd-text ${
                          pinned ? 'sticky z-[1]' : ''
                        } ${isMeasure ? 'tabular-nums' : ''} ${
                          // Cell-level click target: tint the hovered cell (an
                          // inset wash that layers over its own background).
                          // Skipped on the cell already wearing the accent bar,
                          // whose inline box-shadow would win anyway.
                          cellHoverAffordance && !isMeasure && !barHere
                            ? 'hover:shadow-[inset_0_0_0_9999px_rgba(127,127,127,0.10)]'
                            : ''
                        }`}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          {totalsActive && (
            <tfoot>
              <tr>
                {layout.map((l) => {
                  const { column } = l;
                  const pinned = l.pinnedLeft !== null;
                  const isMeasure = column.role === 'measure';
                  // totalsRow aligns to measure columns in RESULT order, so a
                  // reordered display still reads the right total.
                  const total = isMeasure
                    ? (totalsRow?.[measureColumns.indexOf(column)] ?? null)
                    : null;
                  return (
                    <td
                      key={column.name}
                      style={{
                        background: pinnedBackground(null),
                        borderTop: `1px solid ${borderColor}`,
                        textAlign: bodyAlign(column),
                        ...(borderMode === 'columns' || borderMode === 'grid'
                          ? { borderRight: `1px solid ${borderColor}` }
                          : null),
                        ...(pinned ? { left: l.pinnedLeft ?? 0 } : null),
                      }}
                      // Same sub-z-20 layering contract as the header cells:
                      // renderer chrome must never outrank floating tile chrome.
                      className={`sticky bottom-0 px-3 py-1.5 font-semibold text-rcd-text ${
                        pinned ? 'z-10' : 'z-[5]'
                      } ${isMeasure ? 'tabular-nums' : ''}`}
                    >
                      {isMeasure
                        ? total !== null
                          ? formatCellValue(total, column)
                          : ''
                        : column.name === totalLabelName
                          ? 'Total'
                          : ''}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
        {!paged && result.rows.length > TABLE_ROW_CAP && (
          <div className="px-3 py-2 text-xs text-rcd-muted">
            Showing {TABLE_ROW_CAP} of {result.rows.length} rows
          </div>
        )}
      </div>
      {showPager && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-rcd-border px-2 py-1 text-xs text-rcd-text-2">
          {sizePickerEnabled && (
            <label className="mr-auto flex items-center gap-1">
              <span>Rows per page</span>
              <select
                value={currentSize}
                onChange={(e) => pickPageSize(Number(e.target.value))}
                aria-label="Rows per page"
                className="rounded border border-rcd-border bg-rcd-surface px-1 py-0.5 text-xs text-rcd-text focus:outline-none focus:ring-1 focus:ring-rcd-accent"
              >
                {sizeChoices.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'All' : n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="tabular-nums">
            {!paged
              ? `${totalRows} rows`
              : rows.length > 0
                ? `${totalRows != null ? `${totalRows} rows · ` : ''}rows ${firstRowNumber}–${lastRowNumber}`
                : 'no rows'}
          </span>
          {paged && (
            <>
              <button
                type="button"
                disabled={!canPrev}
                onClick={() => onTablePageChange?.(0)}
                className="rounded p-0.5 enabled:hover:bg-black/5 disabled:opacity-40 enabled:dark:hover:bg-white/10"
                aria-label="First page"
              >
                <ChevronsLeft size={14} />
              </button>
              <button
                type="button"
                disabled={!canPrev}
                onClick={() => onTablePageChange?.(tablePage - 1)}
                className="rounded p-0.5 enabled:hover:bg-black/5 disabled:opacity-40 enabled:dark:hover:bg-white/10"
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="tabular-nums">
                Page {tablePage + 1}
                {tablePageCount != null ? ` of ${tablePageCount}` : ''}
              </span>
              <button
                type="button"
                disabled={!canNext}
                onClick={() => onTablePageChange?.(tablePage + 1)}
                className="rounded p-0.5 enabled:hover:bg-black/5 disabled:opacity-40 enabled:dark:hover:bg-white/10"
                aria-label="Next page"
              >
                <ChevronRight size={14} />
              </button>
              {/* Last-page jump needs a known page count; without one it sits
                  disabled rather than guessing (graceful "Page X" mode). */}
              <button
                type="button"
                disabled={!canLast}
                onClick={() => tablePageCount != null && onTablePageChange?.(tablePageCount - 1)}
                className="rounded p-0.5 enabled:hover:bg-black/5 disabled:opacity-40 enabled:dark:hover:bg-white/10"
                aria-label="Last page"
              >
                <ChevronsRight size={14} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
