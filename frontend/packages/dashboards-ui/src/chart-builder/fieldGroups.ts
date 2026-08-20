/**
 * HOW THE FIELD LIST'S COLUMNS ARE ARRANGED, in the three modes the user can
 * choose between. Pure: no React, no preferences, no rendering — given a model,
 * a catalog and a search string it returns groups. That is deliberate, because
 * the one invariant worth testing is the one a mode switch could break:
 *
 *   A MODE CHANGES HOW FIELDS ARE ARRANGED, NEVER WHICH FIELDS ARE OFFERED.
 *
 * Every mode below therefore covers the same population — every queryable,
 * non-hidden column of every visible model table, plus every engine date-table
 * column. What differs is only the boxes they are put in.
 */
import {
  DATE_TABLE_COLUMNS,
  dateTableKey,
  isQueryableType,
  tableKey,
  type Catalog,
  type ChartSpec,
  type ColumnType,
  type DerivedField,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { buildFolderTree, joinFolderPath, type FolderNode } from '../util/folderTree';
import { fieldKindOfColumnType, fieldKindLabel, FIELD_KINDS, type FieldKind } from './fieldColors';
import type { FieldGrouping } from './fieldListPrefs';

/**
 * *** THE MULTI-MEMBERSHIP THRESHOLD ***
 *
 * A column can belong to several categories, because the host truth this
 * models is many-to-many — in the tracker's own view manifest, six columns
 * appear on all six pages and fifteen of seventy-three appear on two or more.
 *
 * Up to this many folders, the column is LISTED UNDER EACH of them. Finding
 * "Business area" while you are looking at the Mitigation category is the
 * feature, not duplication noise: you were looking there because that is what
 * you are working on.
 *
 * At MORE than this many, listing it everywhere would put the same handful of
 * columns in front of you no matter which category you opened, which is the
 * clutter the categories exist to remove. Those get pooled into one "Common
 * fields" group instead — a column that appears on every page is not "about"
 * any single page.
 *
 * This is a RENDERING decision, not a data one: the stored shape is a plain
 * list of folders, so this number can be re-tuned from evidence with no
 * migration and no model rewrite.
 */
export const MAX_CATEGORY_FOLDERS_PER_COLUMN = 3;

/** Group keys for the two synthetic category buckets. */
export const COMMON_FIELDS_KEY = '#cat!common';
export const UNGROUPED_FIELDS_KEY = '#cat!ungrouped';

/** Preference-key namespace for a category folder path. */
export const categoryFolderKey = (path: readonly string[]): string =>
  `#cat/${joinFolderPath(path)}`;

/** Preference-key namespace for a type group. */
export const typeGroupKey = (kind: FieldKind): string => `#type/${kind}`;

export interface FieldColumnRow {
  /** dnd id and React key; also the "is this field in use?" identity. */
  id: string;
  table: string;
  column: string;
  type: ColumnType;
  kind: FieldKind;
  label: string;
  /** Owning table's display label — shown when a group mixes tables. */
  tableLabel: string;
  /**
   * The DERIVED FIELD this row is, when it is one. A derived field is a
   * virtual column OF ITS TABLE, so it is collected as an ordinary column and
   * every grouping mode files it exactly where the author would look for it —
   * beside the columns it is computed from in Table mode, under its category
   * in Category mode, and with the other text fields in Type mode. Only the
   * row's badge, its action menu and its refusal from a Values well differ.
   */
  derived?: DerivedField;
}

/** What the group's header glyph should be. */
export type FieldGroupIcon = 'table' | 'dateTable' | 'folder' | FieldKind;

export interface FieldColumnGroup {
  /** Stable preference key: a table key, a folder path, or a type name. */
  key: string;
  label: string;
  icon: FieldGroupIcon;
  /** Open unless the user said otherwise. */
  defaultOpen: boolean;
  /** Search matched the group NAME: keep every row, keep the collapse state. */
  nameMatched: boolean;
  /** Rows filed directly in this group, after search filtering. */
  rows: FieldColumnRow[];
  /** Nested sub-folders (category mode only). */
  folders: FolderNode<FieldColumnRow>[];
  /** Rows should name their table — the group mixes several. */
  qualifyRows: boolean;
  /** The model names a table the catalog does not have. */
  missingFromCatalog: boolean;
  /** Shown when the group has nothing to render. */
  emptyText: string;
}

export interface FieldGroupsInput {
  model: ModelDefinition;
  /** Column metadata; null = catalog unavailable (measures still work). */
  catalog: Catalog | null;
  grouping: FieldGrouping;
  /** Trimmed, lower-cased search text; '' when not searching. */
  query: string;
}

/** Every column the list offers, before any grouping is applied. */
interface SourceColumn extends FieldColumnRow {
  /** Category folders from the model; [] for date-table columns. */
  folders: string[];
  /** Date-table columns keep their own section in table/category modes. */
  dateTable: string | null;
}

/** A derived field as a field-list row — a text column of its own table. */
const derivedRow = (field: DerivedField, tableLabel: string): SourceColumn => ({
  id: `column:${field.table}:${field.name}`,
  table: field.table,
  column: field.name,
  type: 'text',
  kind: 'text',
  label: field.name,
  tableLabel,
  derived: field,
  folders: field.displayFolder ? [field.displayFolder] : [],
  dateTable: null,
});

const rowMatches = (row: FieldColumnRow, query: string): boolean =>
  query === '' || row.label.toLowerCase().includes(query) || row.column.toLowerCase().includes(query);

/**
 * The population, once, for every mode. Model tables come from the catalog
 * (types and existence are catalog truth, per ModelColumn's contract); date
 * tables come from the fixed engine schema and need no catalog, which is why
 * they still render when it failed to load.
 */
const collectColumns = (
  model: ModelDefinition,
  catalog: Catalog | null,
): { columns: SourceColumn[]; missingTables: string[] } => {
  const columns: SourceColumn[] = [];
  const missingTables: string[] = [];

  for (const table of model.tables) {
    if (table.hidden) continue;
    const key = tableKey(table.schema, table.name);
    const tableLabel = table.friendlyName ?? table.name;
    const catalogTable = catalog?.tables.find((candidate) => candidate.key === key);
    if (catalog !== null && catalogTable === undefined) {
      missingTables.push(key);
      continue;
    }
    const overrides = new Map((table.columns ?? []).map((column) => [column.name, column]));
    // Derived fields FIRST: they are the author's own vocabulary for this
    // table, and burying them under seventy physical columns would hide the
    // thing they just made.
    for (const field of model.derivedFields ?? []) {
      if (field.table === key) columns.push(derivedRow(field, tableLabel));
    }
    for (const column of catalogTable?.columns ?? []) {
      const override = overrides.get(column.name);
      if (!isQueryableType(column.type) || override?.hidden) continue;
      columns.push({
        id: `column:${key}:${column.name}`,
        table: key,
        column: column.name,
        type: column.type,
        kind: fieldKindOfColumnType(column.type),
        label: override?.friendlyName ?? column.name,
        tableLabel,
        folders: override?.displayFolders ?? [],
        dateTable: null,
      });
    }
  }

  for (const dateTable of model.dateTables ?? []) {
    const key = dateTableKey(dateTable.name);
    for (const column of DATE_TABLE_COLUMNS) {
      columns.push({
        id: `column:${key}:${column.name}`,
        table: key,
        column: column.name,
        type: column.type,
        kind: fieldKindOfColumnType(column.type),
        label: column.name,
        tableLabel: dateTable.name,
        folders: [],
        dateTable: dateTable.name,
      });
    }
  }

  return { columns, missingTables };
};

/** Group defaults, so each mode states only what makes it different. */
const makeGroup = (
  base: Pick<FieldColumnGroup, 'key' | 'label' | 'icon' | 'defaultOpen' | 'nameMatched'> &
    Partial<FieldColumnGroup>,
): FieldColumnGroup => ({
  rows: [],
  folders: [],
  qualifyRows: false,
  missingFromCatalog: false,
  emptyText: 'No matching fields.',
  ...base,
});

/** Table mode — today's arrangement, and the default. */
const buildTableGroups = (
  model: ModelDefinition,
  catalog: Catalog | null,
  columns: SourceColumn[],
  missingTables: string[],
  query: string,
): FieldColumnGroup[] => {
  const groups: FieldColumnGroup[] = [];
  const visibleTables = model.tables.filter((table) => !table.hidden);
  // SchemaExplorer's posture, adapted to a pane that opens on every builder
  // session: a small model opens everything, a large one only its first table.
  const openAll = visibleTables.length <= 3;

  if (catalog !== null) {
    visibleTables.forEach((table, index) => {
      const key = tableKey(table.schema, table.name);
      const label = table.friendlyName ?? table.name;
      const nameMatched =
        query === '' || label.toLowerCase().includes(query) || key.toLowerCase().includes(query);
      const all = columns.filter((column) => column.table === key);
      groups.push(
        makeGroup({
          key,
          label,
          icon: 'table',
          defaultOpen: openAll || index === 0,
          nameMatched,
          rows: nameMatched ? all : all.filter((row) => rowMatches(row, query)),
          missingFromCatalog: missingTables.includes(key),
          emptyText: query === '' ? 'No queryable columns.' : 'No matching columns.',
        }),
      );
    });
  }

  for (const dateTable of model.dateTables ?? []) {
    const key = dateTableKey(dateTable.name);
    const nameMatched = query === '' || dateTable.name.toLowerCase().includes(query);
    const all = columns.filter((column) => column.table === key);
    groups.push(
      makeGroup({
        key,
        label: dateTable.name,
        icon: 'dateTable',
        defaultOpen: true,
        nameMatched,
        rows: nameMatched ? all : all.filter((row) => rowMatches(row, query)),
        emptyText: 'No matching columns.',
      }),
    );
  }

  return groups;
};

/**
 * Category mode. Date tables keep their own groups: they carry no category
 * (the engine generates them) and they already ARE a coherent category, so
 * dissolving them into "Ungrouped" would lose information rather than add any.
 */
const buildCategoryGroups = (
  columns: SourceColumn[],
  query: string,
  dateGroups: FieldColumnGroup[],
): FieldColumnGroup[] => {
  const common: SourceColumn[] = [];
  const ungrouped: SourceColumn[] = [];
  /** One entry per (folder path, column) placement — a column may repeat. */
  const placements: { folder: string; row: SourceColumn }[] = [];

  for (const column of columns) {
    if (column.dateTable !== null) continue;
    const folders = column.folders.filter((folder) => folder.trim() !== '');
    if (folders.length === 0) ungrouped.push(column);
    else if (folders.length > MAX_CATEGORY_FOLDERS_PER_COLUMN) common.push(column);
    else for (const folder of folders) placements.push({ folder, row: column });
  }

  const tree = buildFolderTree(
    placements,
    (placement) => placement.folder,
    categoryFolderKey,
  );

  const unwrap = (node: FolderNode<{ folder: string; row: SourceColumn }>): FolderNode<FieldColumnRow> => ({
    name: node.name,
    path: node.path,
    key: node.key,
    folders: node.folders.map(unwrap).filter((child) => child.items.length > 0 || child.folders.length > 0),
    items: node.items.map((placement) => placement.row).filter((row) => rowMatches(row, query)),
  });

  const groups: FieldColumnGroup[] = [];

  // Common fields first: they are the identifiers every category needs, and
  // burying them under the alphabet would make the mode worse than no mode.
  if (common.length > 0) {
    groups.push(
      makeGroup({
        key: COMMON_FIELDS_KEY,
        label: 'Common fields',
        icon: 'folder',
        defaultOpen: true,
        nameMatched: query === '' || 'common fields'.includes(query),
        rows: common.filter((row) => rowMatches(row, query)),
        qualifyRows: true,
        emptyText: 'No matching fields.',
      }),
    );
  }

  for (const node of tree.folders) {
    const unwrapped = unwrap(node);
    groups.push(
      makeGroup({
        key: node.key,
        label: node.name,
        icon: 'folder',
        defaultOpen: true,
        nameMatched: query === '' || node.name.toLowerCase().includes(query),
        rows: unwrapped.items,
        folders: unwrapped.folders,
        qualifyRows: true,
        emptyText: 'No matching fields.',
      }),
    );
  }

  groups.push(...dateGroups);

  // Ungrouped last — the same place the measure list has always put a measure
  // with no display folder.
  if (ungrouped.length > 0) {
    groups.push(
      makeGroup({
        key: UNGROUPED_FIELDS_KEY,
        label: 'Ungrouped',
        icon: 'folder',
        defaultOpen: true,
        nameMatched: query === '' || 'ungrouped'.includes(query),
        rows: ungrouped.filter((row) => rowMatches(row, query)),
        qualifyRows: true,
        emptyText: 'No matching fields.',
      }),
    );
  }

  return groups;
};

/**
 * True when Category mode has nothing to work with — no column in the model
 * carries a category. Worth saying out loud rather than showing one giant
 * "Ungrouped" pile and letting the user conclude the mode is broken: categories
 * come from the MODEL, so the fix is a model change, not a preference change.
 */
export const hasNoCategories = (groups: readonly FieldColumnGroup[]): boolean =>
  !groups.some((group) => group.icon === 'folder' && group.key !== UNGROUPED_FIELDS_KEY);

/**
 * Type mode — the one that makes "find me a date I can put on an axis"
 * instant. Date tables dissolve here on purpose: their columns ARE typed, and
 * a Date group that omitted the calendar would be a lie.
 */
const buildTypeGroups = (columns: SourceColumn[], query: string): FieldColumnGroup[] =>
  FIELD_KINDS.filter((kind) => kind !== 'measure').map((kind) => {
    const all = columns.filter((column) => column.kind === kind);
    const label = fieldKindLabel(kind);
    const nameMatched = query === '' || label.toLowerCase().includes(query);
    return makeGroup({
      key: typeGroupKey(kind),
      label,
      icon: kind,
      defaultOpen: true,
      nameMatched,
      rows: nameMatched ? all : all.filter((row) => rowMatches(row, query)),
      qualifyRows: true,
      emptyText: query === '' ? 'No fields of this type.' : 'No matching fields.',
    });
  });

export const buildFieldColumnGroups = ({
  model,
  catalog,
  grouping,
  query,
}: FieldGroupsInput): FieldColumnGroup[] => {
  const { columns, missingTables } = collectColumns(model, catalog);
  const tableGroups = buildTableGroups(model, catalog, columns, missingTables, query);

  if (grouping === 'table') return tableGroups;
  if (grouping === 'type') return buildTypeGroups(columns, query);
  return buildCategoryGroups(
    columns,
    query,
    tableGroups.filter((group) => group.icon === 'dateTable'),
  );
};

/**
 * THE FIELDS A CHART ACTUALLY USES, as the row ids the list renders.
 *
 * This is what stops "hide a group" becoming a trap: a user tidies away a
 * table, then opens a chart built on it and cannot find the field the chart is
 * plotting. Every place a chart can name a field is covered — axis, the drill
 * hierarchy below it, legend, small multiples, filters, both kinds of value
 * (a model measure by id, an inline aggregation by table + column) and a field
 * parameter it is bound to.
 */
export const chartFieldUsage = (chart: ChartSpec): Set<string> => {
  const used = new Set<string>();
  const addColumn = (table: string | null | undefined, column: string | null | undefined): void => {
    if (table && column) used.add(`column:${table}:${column}`);
  };

  const { query } = chart;
  addColumn(query.axis?.table, query.axis?.column);
  for (const level of query.drillLevels ?? []) addColumn(level.table, level.column);
  addColumn(query.legend?.table, query.legend?.column);
  addColumn(query.smallMultiples?.table, query.smallMultiples?.column);
  for (const filter of query.filters) addColumn(filter.table, filter.column);
  for (const measure of query.measures) {
    if (measure.measureId) used.add(`measure:${measure.measureId}`);
    else addColumn(measure.table, measure.column);
  }
  if (query.paramBindings?.axis) used.add(`parameter:${query.paramBindings.axis}`);
  if (query.paramBindings?.measures) used.add(`parameter:${query.paramBindings.measures}`);
  return used;
};

/** Every row a group offers, its sub-folders included. */
export const groupRows = (group: FieldColumnGroup): FieldColumnRow[] => {
  const rows = [...group.rows];
  const walk = (nodes: readonly FolderNode<FieldColumnRow>[]): void => {
    for (const node of nodes) {
      rows.push(...node.items);
      walk(node.folders);
    }
  };
  walk(group.folders);
  return rows;
};

/** True when the group has nothing left to show after search filtering. */
export const groupIsEmpty = (group: FieldColumnGroup): boolean => groupRows(group).length === 0;
