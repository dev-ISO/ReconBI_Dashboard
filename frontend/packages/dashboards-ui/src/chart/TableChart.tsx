import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  formatCellValue,
  type CellValue,
  type ChartPointEvent,
  type ChartSpec,
  type ConditionalFormatSpec,
  type QueryColumn,
  type QueryResult,
} from '@recon/dashboards-core';
import { conditionalColor, matchRuleColor } from './analytics';
import { textStyleToCss } from './textStyle';
import type { ChartDatumClickInfo } from './ChartRenderer';

/** Active header sort (column = result column NAME; null = unsorted). */
export interface TableSortState {
  column: string;
  direction: 'asc' | 'desc';
}

/** Partial layout change from a resize/reorder gesture; consumer merges it. */
export interface TableLayoutPatch {
  /** Only the column(s) the gesture touched, px, keyed by result column NAME. */
  columnWidths?: Record<string, number>;
  /** FULL display order (every rendered column name) after a reorder drop. */
  columnOrder?: string[];
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
  /** Echo of the tile's server-side sort; drives the header indicators only. */
  tableSort?: TableSortState | null;
  /** Header click cycles asc -> desc -> none. Gated by table.sortable !== false. */
  onTableSortChange?: (s: TableSortState | null) => void;
  /** 0-based page index the TILE is currently serving (default 0). */
  tablePage?: number;
  /** Total pages; null = unknown -> keep "next" enabled until the tile says otherwise. */
  tablePageCount?: number | null;
  onTablePageChange?: (page: number) => void;
  /**
   * Full-data totals, aligned to the MEASURE columns in RESULT order (index i
   * = i-th measure column). Renders a bold pinned bottom "Total" row.
   */
  totalsRow?: (number | null)[] | null;
  /** Column resize (drag the header edge, min 60px) / header drag-to-reorder. */
  onTableLayoutChange?: (patch: TableLayoutPatch) => void;
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
 * Backgrounds for sticky (pinned) cells: they scroll over other cells, so they
 * need a SOLID surface behind any tint — a bare rgba stripe would let the
 * scrolled content bleed through. Non-pinned cells just take the tint.
 */
const pinnedBackground = (tint: string | null): string =>
  tint ? `linear-gradient(${tint}, ${tint}), var(--rcd-surface)` : 'var(--rcd-surface)';

interface ColumnLayout {
  column: QueryColumn;
  /** Index into the result's row arrays (rows stay in wire column order). */
  cellIndex: number;
  /** Sticky-left offset when pinned; null = not pinned. */
  pinnedLeft: number | null;
  width: number | undefined;
}

/**
 * Table chart with full interactive chrome. The renderer stays presentation-
 * only: sorting, paging and totals are DRIVEN BY THE TILE via props — header
 * and pager interactions only emit intents (onTableSortChange /
 * onTablePageChange), and rows render exactly as given. Column layout
 * (widths/order/pins/stripes) comes from format.table; resize and reorder
 * gestures emit onTableLayoutChange patches for the consumer to persist.
 */
export function TableChart({
  spec,
  result,
  onDatumClick,
  onPointClick,
  onPointContextMenu,
  onPointHover,
  highlightCategory = null,
  tableSort = null,
  onTableSortChange,
  tablePage = 0,
  tablePageCount = null,
  onTablePageChange,
  totalsRow = null,
  onTableLayoutChange,
}: TableChartProps) {
  const format = spec.format;
  const table = format.table ?? {};
  const headerStyle = textStyleToCss(format.legendStyle);
  const paged = table.pageSize != null && table.pageSize > 0;
  // Paged results are already one page (ChartQuerySpec.offset/limit); the cap
  // only guards the single-page path.
  const rows = paged ? result.rows : result.rows.slice(0, TABLE_ROW_CAP);
  const measureColumns = result.columns.filter((c) => c.role === 'measure');

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
      left +=
        widths[column.name] ??
        headerRefs.current.get(column.name)?.getBoundingClientRect().width ??
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
  const resizeRef = useRef<{ name: string; startX: number; startWidth: number } | null>(null);
  const startResize = (name: string) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth =
      widths[name] ??
      headerRefs.current.get(name)?.getBoundingClientRect().width ??
      FALLBACK_COLUMN_WIDTH;
    resizeRef.current = { name, startX: e.clientX, startWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    const width = Math.max(MIN_COLUMN_WIDTH, Math.round(drag.startWidth + e.clientX - drag.startX));
    setDraftWidths((prev) => (prev[drag.name] === width ? prev : { ...prev, [drag.name]: width }));
  };
  const endResize = () => {
    const drag = resizeRef.current;
    if (!drag) return;
    resizeRef.current = null;
    const width = draftWidths[drag.name];
    if (width !== undefined) onTableLayoutChange?.({ columnWidths: { [drag.name]: width } });
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

  // ---- sorting -------------------------------------------------------------
  const sortable = table.sortable !== false && Boolean(onTableSortChange);
  const cycleSort = (name: string) => {
    if (!onTableSortChange) return;
    if (!tableSort || tableSort.column !== name) {
      onTableSortChange({ column: name, direction: 'asc' });
    } else if (tableSort.direction === 'asc') {
      onTableSortChange({ column: name, direction: 'desc' });
    } else {
      onTableSortChange(null);
    }
  };

  // ---- row events (click / context / hover / highlight) --------------------
  // Row interactions key off the FIRST dimension column (when present) — same
  // contract as before the overhaul; column reorder does not change it.
  const clickColumn = result.columns.find((c) => c.role === 'dimension') ?? null;
  const clickIndex = clickColumn ? result.columns.indexOf(clickColumn) : -1;
  const rowLabel = (row: CellValue[]): string =>
    clickColumn ? formatCellValue(row[clickIndex] ?? null, clickColumn) : '';
  const handleRowClick =
    onDatumClick && clickColumn
      ? (row: CellValue[]) => onDatumClick({ value: row[clickIndex] ?? null, label: rowLabel(row) })
      : null;
  const rowEvent =
    clickColumn && (onPointClick || onPointContextMenu || onPointHover)
      ? (row: CellValue[], e: { clientX: number; clientY: number }): ChartPointEvent => ({
          axisValue: row[clickIndex] ?? null,
          axisLabel: rowLabel(row),
          clientX: e.clientX,
          clientY: e.clientY,
        })
      : null;
  const clickable = Boolean(handleRowClick) || Boolean(rowEvent && onPointClick);

  // ---- data bars: scale to the DISPLAYED rows' max |value| per column ------
  const dataBars = new Map<
    string,
    { cf: ConditionalFormatSpec; maxAbs: number; hasNegative: boolean }
  >();
  for (const column of measureColumns) {
    const cf = format.conditionalFormats?.find(
      (f) => f.style === 'dataBar' && f.measureKey === column.label,
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
                const sorted = tableSort?.column === column.name ? tableSort.direction : null;
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
                    onClick={sortable ? () => cycleSort(column.name) : undefined}
                    style={{
                      ...headerStyle,
                      background: pinnedBackground(null),
                      ...(pinned ? { left: l.pinnedLeft ?? 0 } : null),
                      // Drop indicator: the dragged column will land BEFORE
                      // this one (matches handleDrop's insert-before rule).
                      ...(dropTarget === column.name
                        ? { boxShadow: 'inset 2px 0 0 var(--rcd-accent, currentColor)' }
                        : null),
                    }}
                    // Layering: pinned headers float above plain headers, which
                    // float above pinned body cells, which float above the rest.
                    className={`sticky top-0 select-none border-b border-rcd-border px-3 py-2 text-xs font-semibold text-rcd-text-2 ${
                      pinned ? 'z-30' : 'z-20'
                    } ${column.role === 'measure' ? 'text-right' : 'text-left'} ${
                      sortable ? 'cursor-pointer' : ''
                    }`}
                    title={sortable ? 'Click to sort' : undefined}
                  >
                    <span className="relative inline-flex max-w-full items-center gap-1">
                      <span className="truncate">
                        {column.role === 'measure'
                          ? (format.seriesLabels?.[column.label] ?? column.label)
                          : column.label}
                      </span>
                      {sorted === 'asc' && <ArrowUp size={12} className="shrink-0" />}
                      {sorted === 'desc' && <ArrowDown size={12} className="shrink-0" />}
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
          <tbody>
            {rows.map((row, rowIndex) => {
              const striped = Boolean(table.stripes) && rowIndex % 2 === 1;
              // Hover highlight: NON-matching rows dim; the matching row keeps
              // full strength plus a subtle tint so it reads as the focus.
              const rowMatchesHighlight =
                highlightCategory !== null && clickColumn !== null
                  ? rowLabel(row) === highlightCategory.label
                  : null;
              return (
                <tr
                  key={rowIndex}
                  onClick={
                    handleRowClick || (rowEvent && onPointClick)
                      ? (e) => {
                          handleRowClick?.(row);
                          if (rowEvent && onPointClick) onPointClick(rowEvent(row, e));
                        }
                      : undefined
                  }
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
                    rowMatchesHighlight === false ? 'opacity-40' : ''
                  }`}
                >
                  {layout.map((l) => {
                    const { column } = l;
                    const raw = row[l.cellIndex] ?? null;
                    const isMeasure = column.role === 'measure';
                    const pinned = l.pinnedLeft !== null;
                    // cellBackground / cellText rules key the measure's
                    // DEFAULT label; first matching spec (then rule) wins.
                    // They survive reorder/pinning/paging because they only
                    // depend on the column + cell value.
                    const cellBackground = isMeasure
                      ? conditionalColor(format.conditionalFormats, 'cellBackground', column.label, raw)
                      : undefined;
                    const cellText = isMeasure
                      ? conditionalColor(format.conditionalFormats, 'cellText', column.label, raw)
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
                    const background =
                      cellBackground ?? (pinned ? pinnedBackground(tint) : (tint ?? undefined));
                    return (
                      <td
                        key={column.name}
                        style={{
                          background,
                          color: cellText,
                          ...(pinned ? { left: l.pinnedLeft ?? 0 } : null),
                        }}
                        className={`border-b border-rcd-border px-3 py-1.5 text-rcd-text ${
                          pinned ? 'sticky z-10' : ''
                        } ${isMeasure ? 'text-right tabular-nums' : 'text-left'}`}
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
                        ...(pinned ? { left: l.pinnedLeft ?? 0 } : null),
                      }}
                      className={`sticky bottom-0 border-t border-rcd-border px-3 py-1.5 font-semibold text-rcd-text ${
                        pinned ? 'z-30' : 'z-20'
                      } ${isMeasure ? 'text-right tabular-nums' : 'text-left'}`}
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
      {paged && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-rcd-border px-2 py-1 text-xs text-rcd-text-2">
          <span className="tabular-nums">
            {rows.length > 0 ? `rows ${firstRowNumber}–${lastRowNumber}` : 'no rows'}
          </span>
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
        </div>
      )}
    </div>
  );
}
