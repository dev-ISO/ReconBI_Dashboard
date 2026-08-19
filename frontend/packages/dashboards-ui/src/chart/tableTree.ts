// Matrix (row hierarchy) shaping for the table chart: folds the leading
// hierarchy dimension columns of a QueryResult into a tree of group nodes with
// client-side rolled-up measure values, then flattens the tree (respecting the
// expanded-keys set) into the display rows TableChart's tbody map renders.
// Pure data — no React.
import {
  formatCellValue,
  isTemporalType,
  type CellValue,
  type ChartSpec,
  type QueryColumn,
} from '@recon/dashboards-core';

/**
 * How one measure column folds into a parent (group) row:
 * - 'sum'   — SUM of the leaf values (sum/count aggregations: children
 *             partition the parent, so the leaf sum IS the parent value);
 * - 'min' / 'max' — MIN/MAX of the leaf values (min/max aggregations, and
 *             temporal measures per TableOptions.dateAggregation);
 * - 'blank' — no roll-up: avg, countDistinct, stdDev/variance/median, quick
 *             calcs, and model measures. These are NON-ADDITIVE: an average
 *             of averages is not the average, a distinct count cannot be
 *             summed across partitions, and model/calc measures hide their
 *             formula from the client. Computing the true parent value would
 *             take one re-query per group level; rendering an em-dash is
 *             honest, a wrong number is not.
 */
export type FoldKind = 'sum' | 'min' | 'max' | 'blank';

/** One group node of the matrix tree. */
export interface TableNode {
  /** Stable path key: depth-joined encoded raw values (expanded-set member). */
  key: string;
  /** 0-based hierarchy level of this group row (0 = the axis dimension). */
  depth: number;
  /** Raw dimension cell value at this node's depth. */
  value: CellValue;
  /** Formatted label of `value` (per the level's result column). */
  label: string;
  /**
   * Synthetic full-width row aligned to result.columns: this node's own dim
   * cell carries `value`, every other dim cell is null, measure cells carry
   * the folded value ('blank' kinds fold to null).
   */
  row: CellValue[];
  /** Child group nodes (empty at the deepest group level). */
  children: TableNode[];
  /** Leaf result rows attached DIRECTLY to this node (deepest level only). */
  leafRows: CellValue[][];
  /** Leaf rows under this node, descendants included. */
  leafCount: number;
}

/** One row the matrix table displays: a group roll-up or a raw leaf row. */
export type VisibleTableRow =
  | {
      kind: 'group';
      key: string;
      depth: number;
      row: CellValue[];
      node: TableNode;
      expanded: boolean;
    }
  | { kind: 'leaf'; key: string; depth: number; row: CellValue[] };

/** Stable identity for a raw cell inside a path key ('1' vs 1 vs true). */
const encodeValue = (value: CellValue): string =>
  value === null ? '\u0000null' : `${typeof value}:${String(value)}`;

/** Level separator inside path keys (keeps sibling paths unambiguous). */
const KEY_SEPARATOR = '\u001f';

/**
 * Fold kinds for every MEASURE column, in result order. Positional contract:
 * measure column i corresponds to spec.query.measures[i] (wire order).
 * Temporal columns come FIRST: their kind follows table.dateAggregation
 * ('earliest' -> min by default, 'latest' -> max) — the same rule the
 * grand-total companion query rewrites by, so parent rows and the Total row
 * always agree.
 */
export function measureFoldKinds(
  spec: ChartSpec,
  measureColumns: readonly QueryColumn[],
  dateAggregation: Record<string, 'earliest' | 'latest'> | undefined,
): FoldKind[] {
  return measureColumns.map((column, i) => {
    const measure = spec.query.measures[i];
    // Model measures / quick calcs: aggregation (or windowing) is opaque or
    // non-additive client-side — see the FoldKind doc for why blank is right.
    if (measure === undefined || measure.measureId != null || measure.calc != null) return 'blank';
    if (isTemporalType(column.type)) {
      return (dateAggregation?.[column.name] ?? 'earliest') === 'latest' ? 'max' : 'min';
    }
    switch (measure.aggregation) {
      case 'sum':
      case 'count':
        return 'sum';
      case 'min':
        return 'min';
      case 'max':
        return 'max';
      default:
        return 'blank'; // avg, countDistinct, stdDev, variance, median
    }
  });
}

/** Type-aware comparison: numbers numerically, everything else as strings
 *  (ISO date strings order chronologically under string comparison). */
const lessThan = (a: CellValue, b: CellValue): boolean =>
  typeof a === 'number' && typeof b === 'number' ? a < b : String(a) < String(b);

/**
 * Folds `rows` into the matrix tree over the leading `hierarchyDepth`
 * dimension columns of `columns`. Map-based, so NON-CONTIGUOUS groups fold
 * correctly (the wire prepends dim sorts for stable order, but the fold never
 * relies on it). Group nodes exist for depths 0..hierarchyDepth-2; the deepest
 * hierarchy level's values live on the raw LEAF rows themselves (which also
 * carry any legend dimension column). Requires hierarchyDepth >= 2 — with one
 * hierarchy dim there is nothing to group.
 */
export function buildTableTree(
  rows: readonly CellValue[][],
  columns: readonly QueryColumn[],
  hierarchyDepth: number,
  foldKinds: readonly FoldKind[],
): TableNode[] {
  const dimColumns = columns.filter((c) => c.role === 'dimension').slice(0, hierarchyDepth);
  const dimCellIndex = dimColumns.map((c) => columns.indexOf(c));
  const measureColumns = columns.filter((c) => c.role === 'measure');
  const measureCellIndex = measureColumns.map((c) => columns.indexOf(c));
  const groupLevels = hierarchyDepth - 1;
  if (groupLevels < 1 || dimColumns.length < hierarchyDepth) return [];

  const roots: TableNode[] = [];
  const index = new Map<string, TableNode>();

  for (const row of rows) {
    let parent: TableNode | null = null;
    let pathKey = '';
    for (let depth = 0; depth < groupLevels; depth++) {
      const cellIndex = dimCellIndex[depth]!;
      const raw = row[cellIndex] ?? null;
      pathKey = pathKey === '' ? encodeValue(raw) : `${pathKey}${KEY_SEPARATOR}${encodeValue(raw)}`;
      let node = index.get(pathKey);
      if (!node) {
        const synthetic: CellValue[] = columns.map(() => null);
        synthetic[cellIndex] = raw;
        node = {
          key: pathKey,
          depth,
          value: raw,
          label: formatCellValue(raw, dimColumns[depth]!),
          row: synthetic,
          children: [],
          leafRows: [],
          leafCount: 0,
        };
        index.set(pathKey, node);
        (parent === null ? roots : parent.children).push(node);
      }
      node.leafCount += 1;
      if (depth === groupLevels - 1) node.leafRows.push(row as CellValue[]);
      parent = node;
    }
  }

  // Roll-up pass: every node folds over ALL descendant leaf rows (children
  // partition the parent, so folding leaves directly equals folding children
  // for every supported kind).
  const fold = (node: TableNode): CellValue[][] => {
    const leaves =
      node.children.length === 0 ? node.leafRows : node.children.flatMap((child) => fold(child));
    measureCellIndex.forEach((cellIndex, m) => {
      const kind = foldKinds[m] ?? 'blank';
      if (kind === 'blank') return; // stays null -> renders as the em-dash
      let acc: CellValue = null;
      for (const leaf of leaves) {
        const cell = leaf[cellIndex] ?? null;
        if (cell === null) continue;
        if (kind === 'sum') {
          if (typeof cell !== 'number') continue;
          acc = typeof acc === 'number' ? acc + cell : cell;
        } else if (acc === null || (kind === 'min' ? lessThan(cell, acc) : lessThan(acc, cell))) {
          acc = cell;
        }
      }
      node.row[cellIndex] = acc;
    });
    return leaves;
  };
  for (const root of roots) fold(root);

  return roots;
}

/**
 * Flattens the tree into display order honoring `expandedKeys` (group rows
 * always render; a COLLAPSED node hides everything beneath it). Leaf keys are
 * the parent key plus the leaf's position — stable within one result.
 */
export function flattenTableTree(
  roots: readonly TableNode[],
  expandedKeys: ReadonlySet<string>,
): VisibleTableRow[] {
  const out: VisibleTableRow[] = [];
  const walk = (node: TableNode): void => {
    const expanded = expandedKeys.has(node.key);
    out.push({ kind: 'group', key: node.key, depth: node.depth, row: node.row, node, expanded });
    if (!expanded) return;
    for (const child of node.children) walk(child);
    node.leafRows.forEach((row, i) => {
      out.push({ kind: 'leaf', key: `${node.key}:${i}`, depth: node.depth + 1, row });
    });
  };
  for (const root of roots) walk(root);
  return out;
}

/** Every group key in the tree (the expand-all set). */
export function collectGroupKeys(roots: readonly TableNode[]): string[] {
  const keys: string[] = [];
  const walk = (node: TableNode): void => {
    keys.push(node.key);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return keys;
}
