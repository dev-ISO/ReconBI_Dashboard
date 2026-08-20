/**
 * THE ONE FOLDER TREE.
 *
 * Two surfaces render display folders and, until this module existed, they
 * disagreed about what a folder even is. MeasuresPanel treated the whole
 * "Stage Tracker\Stage 1\Received" string as ONE flat header and sorted those
 * headers alphabetically; the chart builder's FieldList split the same string
 * into a NESTED tree and rendered it in whatever order the measures happened
 * to be declared in. Same data, two mental models — and a host now ships a
 * ten-folder hierarchy through both of them.
 *
 * So: one builder, one separator, one sort rule, used by both.
 *
 * THE SORT RULE — folders before loose items, folders alphabetically
 * (case-insensitive, locale-aware) at EVERY level, loose items in source
 * order. Source order is deliberate for the leaves: a model's measure order is
 * authored, and re-alphabetizing it would throw away a decision somebody made.
 * The folders themselves have no authored order at all (a folder exists only
 * because some item named it), so alphabetical is the only stable choice —
 * insertion order there meant "whichever item happened to be declared first",
 * which is not an order a reader can predict.
 */

/**
 * THE SEPARATOR, and the decision behind it.
 *
 * Backslash ONLY. A forward slash is an ordinary character inside a folder
 * NAME: 'Finance/Core' is one folder called "Finance/Core", not two.
 *
 * This keeps the pre-existing behaviour rather than quietly widening it, and
 * that is the point: folder strings are already authored and stored (measures
 * today, columns from now on). Teaching the splitter about '/' would silently
 * re-shape every existing folder whose NAME contains one — a data change
 * disguised as a rendering change, with no migration and no way for an author
 * to opt out. Backslash is also the convention the field is modelled on
 * (tabular-model display folders), so authors coming from there are not
 * surprised. If a host ever needs slash nesting, it belongs in the AUTHORING
 * step, where the change is visible and reversible.
 */
export const FOLDER_SEPARATOR = '\\';

/** Path segments of a display-folder string; [] for null/blank/whitespace. */
export const splitFolderPath = (folder: string | null | undefined): string[] =>
  (folder ?? '')
    .split(FOLDER_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');

/** Rejoins path segments into the canonical stored form. */
export const joinFolderPath = (path: readonly string[]): string => path.join(FOLDER_SEPARATOR);

export interface FolderNode<T> {
  /** This level's segment only ("Stage 1"), for the header. */
  name: string;
  /** Full path from the root, for keys and tooltips. */
  path: string[];
  /** Stable expansion/preference key — never an array index. */
  key: string;
  folders: FolderNode<T>[];
  /** Items filed directly at this level, in source order. */
  items: T[];
}

export interface FolderTree<T> {
  /** Items with no folder at all. Rendered LAST, after every folder. */
  root: T[];
  folders: FolderNode<T>[];
}

const sortNodes = <T,>(nodes: FolderNode<T>[]): void => {
  nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const node of nodes) sortNodes(node.folders);
};

/**
 * Groups `items` into a folder tree.
 *
 * `folderOf` returns the raw display-folder string for an item; `keyOf` turns
 * a path into the caller's preference-key namespace (the field list and the
 * model editor keep separate namespaces so a table key can never collide with
 * a folder key).
 */
export const buildFolderTree = <T,>(
  items: readonly T[],
  folderOf: (item: T) => string | null | undefined,
  keyOf: (path: string[]) => string,
): FolderTree<T> => {
  const root: T[] = [];
  const top: FolderNode<T>[] = [];

  const ensure = (nodes: FolderNode<T>[], path: string[]): FolderNode<T> => {
    const name = path[path.length - 1]!;
    let node = nodes.find((candidate) => candidate.name === name);
    if (!node) {
      node = { name, path: [...path], key: keyOf(path), folders: [], items: [] };
      nodes.push(node);
    }
    return node;
  };

  for (const item of items) {
    const segments = splitFolderPath(folderOf(item));
    if (segments.length === 0) {
      root.push(item);
      continue;
    }
    let nodes = top;
    let node: FolderNode<T> | null = null;
    for (let depth = 0; depth < segments.length; depth++) {
      node = ensure(nodes, segments.slice(0, depth + 1));
      nodes = node.folders;
    }
    node!.items.push(item);
  }

  sortNodes(top);
  return { root, folders: top };
};

/** Every folder key in the tree, depth-first (default-expansion seeding). */
export const collectFolderKeys = <T,>(nodes: readonly FolderNode<T>[], into: string[] = []): string[] => {
  for (const node of nodes) {
    into.push(node.key);
    collectFolderKeys(node.folders, into);
  }
  return into;
};

/** Total items in a subtree, including every descendant folder. */
export const folderItemCount = <T,>(node: FolderNode<T>): number =>
  node.items.length + node.folders.reduce((total, child) => total + folderItemCount(child), 0);

/**
 * Depth-first walk yielding EVERY folder in the same order the nested renderer
 * draws them. This is what lets a surface that genuinely cannot nest (a narrow
 * rail) still agree with the tree on grouping and ORDER — it renders the same
 * sequence, indented by `path.length` rather than nested in boxes.
 *
 * An intermediate folder holding no items of its own is still yielded: it is
 * the parent its children are indented under, and dropping it would leave them
 * hanging beneath the wrong header.
 */
export const flattenFolderTree = <T,>(
  nodes: readonly FolderNode<T>[],
  into: FolderNode<T>[] = [],
): FolderNode<T>[] => {
  for (const node of nodes) {
    into.push(node);
    flattenFolderTree(node.folders, into);
  }
  return into;
};
