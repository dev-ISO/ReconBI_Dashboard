import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Filter,
  Folder,
  Hash,
  Lock,
  Plus,
  Search,
  Settings2,
  Sigma,
  Table2,
  ToggleLeft,
  Type,
  Variable,
} from 'lucide-react';
import type { Catalog, Measure, ModelDefinition } from '@recon/dashboards-core';
import { ColumnTypeIcon } from '../data-pane/SchemaExplorer';
import { RcdInput } from '../primitives';
import { buildFolderTree, type FolderNode } from '../util/folderTree';
import { fieldKindLabel, fieldKindStyle, type FieldKind } from './fieldColors';
import {
  buildFieldColumnGroups,
  groupRows,
  hasNoCategories,
  type FieldColumnGroup,
  type FieldColumnRow,
  type FieldGroupIcon,
} from './fieldGroups';
import {
  fieldGroupingHint,
  fieldGroupingLabel,
  FIELD_GROUPINGS,
  useFieldListPrefs,
  type FieldGrouping,
  type FieldListPrefsController,
} from './fieldListPrefs';
import { MeasureRowMenu } from './MeasureRowMenu';
import { buildMeasureMenuItems, type MeasureMenuHandlers } from './measureMenu';
import {
  buildDerivedFieldMenuItems,
  type DerivedFieldMenuHandlers,
} from './DerivedFieldSections';
import type { ScopedDerivedField } from './derivedFieldActions';
import {
  MEASURE_SCOPES,
  scopeBlurb,
  scopeLabel,
  scopeShortLabel,
  type MeasureScope,
  type MeasureScopeRights,
  type ScopedMeasure,
} from './measureScopes';
import type { BuilderParameter, FieldDragData } from './wellConfig';

/**
 * Everything the Measures section needs to become a MANAGEMENT surface rather
 * than a read-only list. Optional: the standalone builder and any host that
 * does not want authoring here simply omits it and the section renders exactly
 * as it always did.
 */
export interface FieldListMeasureManagement {
  /** Where each measure lives, keyed by the same ids `model.measures` carries. */
  scoped: readonly ScopedMeasure[];
  rights: Record<MeasureScope, MeasureScopeRights>;
  handlers: MeasureMenuHandlers;
  /** The section's "+" — a new measure, scope chosen in the manager. */
  onCreate: () => void;
  /** Opens the full three-scope manager. */
  onManage: () => void;
}

/**
 * Everything the DERIVED FIELD rows need to become manageable in place. A
 * derived field renders as a COLUMN of its table (that is what it is), so
 * there is no new section — only a badge, a row menu, and one entry point for
 * making a new one.
 */
export interface FieldListDerivedManagement {
  /** Where each derived field lives, keyed by table+name (its address). */
  scoped: readonly ScopedDerivedField[];
  rights: Record<MeasureScope, MeasureScopeRights>;
  handlers: DerivedFieldMenuHandlers;
  /** "New field…" — scope chosen in the manager, like the measure "+". */
  onCreate: () => void;
}

export interface FieldListProps {
  /**
   * The EFFECTIVE model: the stored definition with the dashboard-scoped and
   * personal measures merged into `measures`, mirroring the overlay the server
   * applies before it compiles. Everything downstream — this list, the client
   * validator, the well chips — then treats a scoped measure exactly like a
   * model one, which is the whole reason a scoped measure is usable at all.
   */
  model: ModelDefinition;
  /** Column metadata for the model's data source; measure-only fallback when null. */
  catalog: Catalog | null;
  /**
   * Dashboard field parameters (threaded by the dashboard runtime). Absent or
   * empty hides the Parameters section — the standalone builder never gets it.
   */
  parameters?: BuilderParameter[];
  /** Click-to-add: the builder routes the entry to the most sensible well. */
  onAdd: (data: FieldDragData) => void;
  /** Funnel affordance on column rows: adds the column as a chart filter. */
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
  /** Present = the Measures section gains a "+" and a per-row action menu. */
  measures?: FieldListMeasureManagement;
  /** Present = derived-field rows gain a scope badge and an action menu. */
  derived?: FieldListDerivedManagement;
  /**
   * Per-user grouping / expansion / hidden-group preferences. Omit and the
   * list keeps them in memory for the session — the pre-wave behaviour, and
   * what a settings outage degrades to.
   */
  prefs?: FieldListPrefsController;
  /**
   * Row ids the chart being edited actually references
   * (`column:{table}:{column}` and `measure:{id}` — the same ids the rows
   * carry). A hidden group still shows these: hiding is a decluttering tool,
   * and a user who cannot find the field their own chart is built on has been
   * handed a mystery instead of a tidy list.
   */
  inUse?: ReadonlySet<string>;
}

/** Expansion-state keys for the fixed sections. */
const MEASURES_KEY = '#measures';
const PARAMETERS_KEY = '#parameters';
const measureScopeKey = (scope: MeasureScope): string => `${MEASURES_KEY}/${scope}`;
/** Namespaced by scope so two scopes' identically-named folders stay distinct. */
const measureFolderKey = (scope: MeasureScope) => (path: string[]): string =>
  `${measureScopeKey(scope)}/${path.join('\\')}`;

const EMPTY_IN_USE: ReadonlySet<string> = new Set<string>();

/**
 * Model-scoped field pane in the SchemaExplorer idiom: a search input over
 * tables AND columns, a per-user grouping choice (Table / Category / Type),
 * collapsible groups whose state is REMEMBERED between sessions, and a
 * Measures area split by scope. Drag payloads, click-to-add (with the
 * post-drag swallow upstream), and the funnel affordance are unchanged; the
 * disclosure buttons themselves are never draggable.
 */
export function FieldList({
  model,
  catalog,
  parameters,
  onAdd,
  onAddFilter,
  measures: management,
  derived: derivedManagement,
  prefs: providedPrefs,
  inUse = EMPTY_IN_USE,
}: FieldListProps) {
  // The in-memory fallback is the SAME controller, wired to nothing: one code
  // path, so an outage cannot take a different branch than the tests exercise.
  const fallbackPrefs = useFieldListPrefs(null);
  const prefs = providedPrefs ?? fallbackPrefs;

  // Search stays EPHEMERAL on purpose: it is a momentary act, not a
  // preference, and restoring a stale filter on reopen would look like a bug.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (text: string): boolean => text.toLowerCase().includes(q);

  const grouping = prefs.grouping;

  /* -------------------------------------------------------------- columns */

  const columnGroups = useMemo(
    () => buildFieldColumnGroups({ model, catalog, grouping, query: q }),
    [model, catalog, grouping, q],
  );

  /* ------------------------------------------------------------- measures */

  const scopeOf = useMemo(() => {
    const byId = new Map<string, MeasureScope>();
    for (const entry of management?.scoped ?? []) byId.set(entry.measure.id, entry.scope);
    return byId;
  }, [management]);

  const keptMeasures = useMemo(
    () =>
      q === ''
        ? model.measures
        : model.measures.filter(
            (m) => matches(m.name) || (m.displayFolder != null && matches(m.displayFolder)),
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matches derives from q
    [model.measures, q],
  );

  /**
   * W4C: three ALWAYS-PRESENT sections, widest audience first. An empty one
   * says so and a read-only one says why — a section that vanished when empty
   * would hide the very thing this wave is trying to make legible, which is
   * that a measure lives SOMEWHERE and you get to choose where.
   */
  const measureSections = useMemo(() => {
    if (!management) {
      return [
        {
          scope: 'system' as MeasureScope,
          key: measureScopeKey('system'),
          label: 'Measures',
          showHeader: false,
          rights: { available: true, canWrite: true, reason: null } as MeasureScopeRights,
          total: model.measures.length,
          tree: buildFolderTree(keptMeasures, (m) => m.displayFolder, measureFolderKey('system')),
        },
      ];
    }
    return MEASURE_SCOPES.map((scope) => {
      const kept = keptMeasures.filter((m) => scopeOf.get(m.id) === scope);
      return {
        scope,
        key: measureScopeKey(scope),
        label: scopeLabel(scope),
        showHeader: true,
        rights: management.rights[scope],
        total: management.scoped.filter((entry) => entry.scope === scope).length,
        tree: buildFolderTree(kept, (m) => m.displayFolder, measureFolderKey(scope)),
      };
    });
  }, [management, keptMeasures, model.measures.length, scopeOf]);

  /* ----------------------------------------------------------- parameters */

  const visibleParameters =
    parameters === undefined
      ? []
      : q === ''
        ? parameters
        : parameters.filter((p) => matches(p.name));

  /* -------------------------------------------------- hidden-group recall */

  /**
   * Every group the user could have hidden IN THIS ARRANGEMENT. Scoping the
   * recall to the current mode is the honest reading of "Show hidden (N)": a
   * type group hidden in Type mode is not hidden from Table mode, it simply
   * does not exist there.
   */
  const hideable = useMemo(() => {
    const entries: { key: string; label: string }[] = columnGroups.map((group) => ({
      key: group.key,
      label: group.label,
    }));
    for (const section of measureSections) {
      if (section.showHeader) entries.push({ key: section.key, label: section.label });
    }
    if (parameters !== undefined && parameters.length > 0) {
      entries.push({ key: PARAMETERS_KEY, label: 'Parameters' });
    }
    return entries;
  }, [columnGroups, measureSections, parameters]);

  const hiddenGroups = hideable.filter((entry) => prefs.isHidden(entry.key));

  /* --------------------------------------------------------------- render */

  const renderMeasure = (measure: Measure) => {
    const entry = management?.scoped.find((candidate) => candidate.measure.id === measure.id);
    // Scope is worth a glance on the ROW too: the sections group by scope, but
    // a searched or folder-nested row is read out of context, and dragging the
    // wrong one into a chart is a silent mistake. The widest scope stays the
    // unmarked default — badging System would badge nearly every row.
    const scopeBadge = entry && entry.scope !== 'system' ? entry.scope : null;
    const badge =
      scopeBadge === null && !measure.expression ? undefined : (
        <>
          {scopeBadge !== null && <ScopeBadge scope={scopeBadge} />}
          {measure.expression ? <FxBadge /> : null}
        </>
      );
    return (
      <FieldEntry
        key={measure.id}
        id={`measure:${measure.id}`}
        data={{ kind: 'measure', measureId: measure.id, name: measure.name }}
        label={measure.name}
        icon={<Sigma size={13} />}
        iconKind="measure"
        badge={badge}
        onAdd={onAdd}
        action={
          management && entry ? (
            <MeasureRowMenu
              compact
              label={`Actions for ${measure.name}`}
              items={buildMeasureMenuItems(entry, management.rights, management.handlers)}
            />
          ) : undefined
        }
      />
    );
  };

  const renderMeasureFolder = (node: FolderNode<Measure>): React.ReactNode => (
    <FolderSection
      key={node.key}
      node={node}
      prefs={prefs}
      searching={q !== ''}
      renderItem={renderMeasure}
      renderFolder={renderMeasureFolder}
    />
  );

  const measuresOpen = prefs.isOpen(MEASURES_KEY, true) || q !== '';
  const parametersOpen = prefs.isOpen(PARAMETERS_KEY, true) || q !== '';
  const measuresVisible =
    q === '' || measureSections.some((section) => section.tree.root.length > 0 || section.tree.folders.length > 0);

  return (
    <div className="flex flex-col pb-2" data-testid="rcd-field-list">
      <div className="relative p-2 pb-1">
        <Search
          size={13}
          className="pointer-events-none absolute left-4 top-1/2 mt-[1px] -translate-y-1/2 text-rcd-muted"
        />
        <RcdInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search fields…"
          aria-label="Search fields"
          className="w-full pl-7"
        />
      </div>

      <GroupingPicker grouping={grouping} onChange={prefs.setGrouping} />

      {catalog === null && (
        <p className="px-3 pt-2 text-xs text-rcd-muted">
          Column catalog unavailable — drag measures below, or reopen the model to load columns.
        </p>
      )}

      {grouping === 'category' && catalog !== null && hasNoCategories(columnGroups) && (
        <p className="px-3 pt-2 text-xs text-rcd-muted">
          This model gives its fields no categories yet, so they are all listed together. Categories
          come from the model, not from this list.
        </p>
      )}

      {columnGroups.map((group) => (
        <ColumnGroupSection
          key={group.key}
          group={group}
          prefs={prefs}
          query={q}
          inUse={inUse}
          derived={derivedManagement}
          onAdd={onAdd}
          onAddFilter={onAddFilter}
        />
      ))}

      {derivedManagement !== undefined && (
        <button
          type="button"
          onClick={derivedManagement.onCreate}
          title="A field computed per row — group values, or write a small formula"
          className="mx-1 mt-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
        >
          <Plus size={12} className="shrink-0" />
          New field…
        </button>
      )}

      {measuresVisible && (
        <>
          <SectionHeader
            icon={<Sigma size={12} />}
            label="Measures"
            expanded={measuresOpen}
            onToggle={() => prefs.setOpen(MEASURES_KEY, !prefs.isOpen(MEASURES_KEY, true), true)}
            action={
              management ? (
                <button
                  type="button"
                  aria-label="New measure"
                  title="New measure"
                  onClick={management.onCreate}
                  className="mr-2 shrink-0 rounded p-0.5 text-rcd-muted hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10"
                >
                  <Plus size={13} />
                </button>
              ) : undefined
            }
          />
          {measuresOpen && (
            <>
              {measureSections.map((section) => (
                <MeasureScopeSection
                  key={section.key}
                  section={section}
                  prefs={prefs}
                  searching={q !== ''}
                  inUse={inUse}
                  managed={management !== undefined}
                  renderMeasure={renderMeasure}
                  renderFolder={renderMeasureFolder}
                />
              ))}
              {management && (
                <button
                  type="button"
                  onClick={management.onManage}
                  className="mx-1 mt-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                >
                  <Settings2 size={12} className="shrink-0" />
                  Manage measures…
                </button>
              )}
            </>
          )}
        </>
      )}

      {parameters !== undefined && parameters.length > 0 && visibleParameters.length > 0 && (
        <ParametersSection
          parameters={visibleParameters}
          prefs={prefs}
          expanded={parametersOpen}
          inUse={inUse}
          onAdd={onAdd}
        />
      )}

      {hiddenGroups.length > 0 && (
        <HiddenGroupsRecall groups={hiddenGroups} prefs={prefs} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- grouping */

/**
 * The mode switch. Three buttons rather than a select: the whole point is that
 * the alternatives are visible, and a user who has never thought about
 * grouping should be able to discover Category and Type by reading the pane.
 */
function GroupingPicker({
  grouping,
  onChange,
}: {
  grouping: FieldGrouping;
  onChange: (grouping: FieldGrouping) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-rcd-muted">Group by</span>
      <div
        role="group"
        aria-label="Group fields by"
        className="flex flex-1 items-center gap-0.5 rounded-md bg-black/5 p-0.5 dark:bg-white/10"
      >
        {FIELD_GROUPINGS.map((option) => {
          const active = option === grouping;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              title={fieldGroupingHint(option)}
              onClick={() => onChange(option)}
              className={`flex-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                active
                  ? 'bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-1)]'
                  : 'text-rcd-muted hover:text-rcd-text'
              }`}
            >
              {fieldGroupingLabel(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- column groups */

function GroupIcon({ icon }: { icon: FieldGroupIcon }) {
  switch (icon) {
    case 'table':
      return <Table2 size={12} className="shrink-0" />;
    case 'dateTable':
      return <CalendarDays size={12} className="shrink-0" />;
    case 'folder':
      return <Folder size={12} className="shrink-0" />;
    case 'text':
      return <Type size={12} className="shrink-0" style={fieldKindStyle('text')} />;
    case 'number':
      return <Hash size={12} className="shrink-0" style={fieldKindStyle('number')} />;
    case 'date':
      return <CalendarDays size={12} className="shrink-0" style={fieldKindStyle('date')} />;
    case 'boolean':
      return <ToggleLeft size={12} className="shrink-0" style={fieldKindStyle('boolean')} />;
    case 'measure':
      return <Sigma size={12} className="shrink-0" style={fieldKindStyle('measure')} />;
  }
}

function ColumnGroupSection({
  group,
  prefs,
  query,
  inUse,
  derived,
  onAdd,
  onAddFilter,
}: {
  group: FieldColumnGroup;
  prefs: FieldListPrefsController;
  /** Trimmed lowercase search query ('' = not searching). */
  query: string;
  inUse: ReadonlySet<string>;
  derived?: FieldListDerivedManagement;
  onAdd: (data: FieldDragData) => void;
  onAddFilter?: (data: Extract<FieldDragData, { kind: 'column' }>) => void;
}) {
  const all = groupRows(group);
  const hidden = prefs.isHidden(group.key);
  // THE IN-USE EXCEPTION. A hidden group that still holds a field this chart
  // references keeps rendering — only those fields, with a note saying why.
  const rescued = hidden ? all.filter((row) => inUse.has(row.id)) : [];

  if (query !== '' && !group.nameMatched && all.length === 0) return null;
  if (hidden && rescued.length === 0) return null;

  const searchOpen = query !== '' && !group.nameMatched && all.length > 0;
  const expanded = prefs.isOpen(group.key, group.defaultOpen) || searchOpen || hidden;

  const renderRow = (row: FieldColumnRow) => {
    const data = {
      kind: 'column',
      table: row.table,
      column: row.column,
      type: row.type,
      // The marker the wells read to refuse a Values drop before it happens.
      ...(row.derived ? { derived: true as const } : null),
    } as const;
    const entry =
      row.derived === undefined
        ? undefined
        : derived?.scoped.find(
            (candidate) =>
              candidate.field.table === row.table && candidate.field.name === row.column,
          );
    return (
      <FieldEntry
        key={row.id}
        id={row.id}
        data={data}
        label={row.label}
        icon={row.derived ? <Type size={13} /> : <ColumnTypeIcon type={row.type} />}
        iconKind={row.kind}
        title={row.derived ? `Computed per row: ${row.derived.expression}` : undefined}
        badge={
          row.derived ? (
            <DerivedBadge scope={entry?.scope ?? null} />
          ) : group.qualifyRows ? (
            <TableQualifier label={row.tableLabel} />
          ) : undefined
        }
        onAdd={onAdd}
        onFilter={onAddFilter ? () => onAddFilter(data) : undefined}
        action={
          derived && entry ? (
            <MeasureRowMenu
              compact
              label={`Actions for ${row.label}`}
              items={buildDerivedFieldMenuItems(entry, derived.rights, derived.handlers)}
            />
          ) : undefined
        }
      />
    );
  };

  const renderFolder = (node: FolderNode<FieldColumnRow>): React.ReactNode => (
    <FolderSection
      key={node.key}
      node={node}
      prefs={prefs}
      searching={query !== ''}
      renderItem={renderRow}
      renderFolder={renderFolder}
    />
  );

  return (
    <HideableSection
      groupKey={group.key}
      label={group.label}
      icon={<GroupIcon icon={group.icon} />}
      prefs={prefs}
      expanded={expanded}
      onToggle={() => prefs.setOpen(group.key, !expanded, group.defaultOpen)}
      inUseCount={rescued.length}
    >
      {group.missingFromCatalog ? (
        <p className="px-3 py-1 text-xs text-rcd-muted">Table not found in the catalog.</p>
      ) : hidden ? (
        rescued.map(renderRow)
      ) : all.length === 0 ? (
        <p className="px-3 py-1 text-xs text-rcd-muted">{group.emptyText}</p>
      ) : (
        <>
          {group.folders.map(renderFolder)}
          {group.rows.map(renderRow)}
        </>
      )}
    </HideableSection>
  );
}

/** Table-of-origin marker, so an identically named column stays identifiable. */
function TableQualifier({ label }: { label: string }) {
  return (
    <span className="ml-auto shrink-0 truncate text-[10px] text-rcd-muted" title={label}>
      {label}
    </span>
  );
}

/* ------------------------------------------------------- measure sections */

interface MeasureSection {
  scope: MeasureScope;
  key: string;
  label: string;
  showHeader: boolean;
  rights: MeasureScopeRights;
  /** Measures in this scope BEFORE search filtering — "is it empty, really?" */
  total: number;
  tree: { root: Measure[]; folders: FolderNode<Measure>[] };
}

function MeasureScopeSection({
  section,
  prefs,
  searching,
  inUse,
  managed,
  renderMeasure,
  renderFolder,
}: {
  section: MeasureSection;
  prefs: FieldListPrefsController;
  searching: boolean;
  inUse: ReadonlySet<string>;
  managed: boolean;
  renderMeasure: (measure: Measure) => React.ReactNode;
  renderFolder: (node: FolderNode<Measure>) => React.ReactNode;
}) {
  const all = [...section.tree.root, ...flattenMeasures(section.tree.folders)];
  const hidden = managed && prefs.isHidden(section.key);
  const rescued = hidden ? all.filter((measure) => inUse.has(`measure:${measure.id}`)) : [];
  if (hidden && rescued.length === 0) return null;

  const body = hidden ? (
    <>{rescued.map(renderMeasure)}</>
  ) : all.length === 0 ? (
    <p className="px-3 py-1 text-xs text-rcd-muted">
      {searching
        ? 'No matching measures.'
        : section.rights.available
          ? emptyScopeText(section.scope, managed)
          : (section.rights.reason ?? 'Not available here.')}
    </p>
  ) : (
    <>
      {section.tree.folders.map(renderFolder)}
      {section.tree.root.map(renderMeasure)}
    </>
  );

  // No management wired: one implicit scope, rendered exactly as it always
  // was — no header, no scope chrome, nothing new on the standalone builder.
  if (!section.showHeader) return <>{body}</>;

  const expanded = prefs.isOpen(section.key, true) || searching || hidden;
  return (
    <HideableSection
      groupKey={section.key}
      label={section.label}
      icon={<Sigma size={11} className="shrink-0" style={fieldKindStyle('measure')} />}
      prefs={prefs}
      expanded={expanded}
      onToggle={() => prefs.setOpen(section.key, !expanded, true)}
      inUseCount={rescued.length}
      count={section.total}
      indent
      note={
        !hidden && !section.rights.canWrite && section.rights.reason !== null && all.length > 0
          ? section.rights.reason
          : undefined
      }
      title={scopeBlurb(section.scope)}
    >
      {body}
    </HideableSection>
  );
}

const flattenMeasures = (nodes: readonly FolderNode<Measure>[]): Measure[] => {
  const out: Measure[] = [];
  for (const node of nodes) {
    out.push(...node.items);
    out.push(...flattenMeasures(node.folders));
  }
  return out;
};

const emptyScopeText = (scope: MeasureScope, managed: boolean): string => {
  if (!managed) return 'No measures defined in this model.';
  switch (scope) {
    case 'system':
      return 'No measures on this model yet.';
    case 'dashboard':
      return 'No measures belong to this dashboard yet.';
    case 'personal':
      return 'None of your own yet — measures you make here are private to you.';
  }
};

/* ----------------------------------------------------------- parameters */

/**
 * Field parameters. Hideable like everything else — and subject to the same
 * exception: a parameter the chart is BOUND to stays visible, because losing
 * sight of it would leave the binding chip in the wells with nothing in the
 * list to explain it.
 */
function ParametersSection({
  parameters,
  prefs,
  expanded,
  inUse,
  onAdd,
}: {
  parameters: BuilderParameter[];
  prefs: FieldListPrefsController;
  expanded: boolean;
  inUse: ReadonlySet<string>;
  onAdd: (data: FieldDragData) => void;
}) {
  const hidden = prefs.isHidden(PARAMETERS_KEY);
  const rescued = hidden
    ? parameters.filter((parameter) => inUse.has(`parameter:${parameter.id}`))
    : [];
  if (hidden && rescued.length === 0) return null;

  return (
    <HideableSection
      groupKey={PARAMETERS_KEY}
      label="Parameters"
      icon={<Variable size={12} />}
      prefs={prefs}
      expanded={expanded || hidden}
      onToggle={() => prefs.setOpen(PARAMETERS_KEY, !prefs.isOpen(PARAMETERS_KEY, true), true)}
      inUseCount={rescued.length}
    >
      {(hidden ? rescued : parameters).map((parameter) => (
        <FieldEntry
          key={parameter.id}
          id={`parameter:${parameter.id}`}
          data={{
            kind: 'parameter',
            parameterId: parameter.id,
            name: parameter.name,
            paramKind: parameter.kind,
          }}
          label={parameter.name}
          icon={<Variable size={13} className="text-rcd-accent" />}
          badge={<ParamKindBadge kind={parameter.kind} />}
          onAdd={onAdd}
        />
      ))}
    </HideableSection>
  );
}

/* ------------------------------------------------------------ hide/recall */

/**
 * The always-available way back. Deliberately a persistent row rather than a
 * toast or an undo: hiding is a preference that outlives the session, so the
 * affordance that reverses it has to outlive the session too.
 */
function HiddenGroupsRecall({
  groups,
  prefs,
}: {
  groups: { key: string; label: string }[];
  prefs: FieldListPrefsController;
}) {
  const key = '#hidden';
  const open = prefs.isOpen(key, false);
  return (
    <div className="mt-2 border-t border-rcd-border pt-1">
      <button
        type="button"
        onClick={() => prefs.setOpen(key, !open, false)}
        aria-expanded={open}
        className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0" />
        ) : (
          <ChevronRight size={11} className="shrink-0" />
        )}
        <EyeOff size={12} className="shrink-0" />
        Show hidden ({groups.length})
      </button>
      {open && (
        <div className="ml-3 flex flex-col border-l border-rcd-border pl-1">
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              aria-label={`Show ${group.label}`}
              onClick={() => prefs.setHidden(group.key, false)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Eye size={12} className="shrink-0 text-rcd-muted" />
              <span className="truncate">{group.label}</span>
            </button>
          ))}
          {groups.length > 1 && (
            <button
              type="button"
              onClick={() => prefs.showAll(groups.map((group) => group.key))}
              className="px-2 py-1 text-left text-xs text-rcd-accent hover:underline"
            >
              Show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- chrome */

/** Cosmetic suffix marking what a field parameter swaps: axis fields or measures. */
function ParamKindBadge({ kind }: { kind: BuilderParameter['kind'] }) {
  return (
    <span
      title={kind === 'dimension' ? 'Field parameter — binds to the axis' : 'Field parameter — binds to values'}
      className="ml-auto shrink-0 rounded bg-[color-mix(in_srgb,var(--rcd-accent)_15%,transparent)] px-1 text-[10px] font-medium leading-4 text-rcd-accent"
    >
      {kind === 'dimension' ? 'axis' : 'values'}
    </span>
  );
}

/**
 * Where a measure lives. Rendered only for the narrower scopes — a System
 * measure is the norm and marking it would badge nearly every row.
 */
function ScopeBadge({ scope }: { scope: MeasureScope }) {
  return (
    <span
      title={
        scope === 'dashboard'
          ? 'Belongs to this dashboard — travels when it is copied or shared'
          : 'Your own measure — nobody else can see it'
      }
      className="ml-auto shrink-0 rounded border border-rcd-border px-1 text-[10px] font-medium leading-4 text-rcd-muted"
    >
      {scopeShortLabel(scope)}
    </span>
  );
}

/**
 * Marks a row as a DERIVED field rather than a real column, and says where it
 * lives when that is not the widest scope — the same reading a measure row's
 * scope badge gives, for the same reason: a row read out of context (searched,
 * or nested in a folder) is one drag away from being in a chart.
 */
function DerivedBadge({ scope }: { scope: MeasureScope | null }) {
  return (
    <span
      title={
        scope === 'dashboard'
          ? 'A field computed per row — belongs to this dashboard'
          : scope === 'personal'
            ? 'A field computed per row — private to you'
            : 'A field computed per row'
      }
      className="ml-auto shrink-0 rounded border border-rcd-border px-1 text-[10px] font-medium leading-4 text-rcd-muted"
    >
      {scope === 'system' || scope === null ? 'field' : scopeShortLabel(scope)}
    </span>
  );
}

/** Cosmetic suffix marking a calculated (expression-backed) measure. */
function FxBadge() {
  return (
    <span
      title="Calculated measure"
      className="ml-auto shrink-0 rounded bg-black/10 px-1 text-[10px] font-medium italic leading-4 text-rcd-muted dark:bg-white/10"
    >
      fx
    </span>
  );
}

/**
 * One folder inside a group (measure display folders, category sub-folders).
 * Its open state is persisted under the folder PATH, so it survives a reopen
 * and does not move when a sibling is renamed.
 */
function FolderSection<T>({
  node,
  prefs,
  searching,
  renderItem,
  renderFolder,
}: {
  node: FolderNode<T>;
  prefs: FieldListPrefsController;
  searching: boolean;
  renderItem: (item: T) => React.ReactNode;
  renderFolder: (node: FolderNode<T>) => React.ReactNode;
}) {
  const open = prefs.isOpen(node.key, true) || searching;
  return (
    <div>
      <button
        type="button"
        onClick={() => prefs.setOpen(node.key, !open, true)}
        aria-expanded={open}
        className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-rcd-muted" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-rcd-muted" />
        )}
        <Folder size={12} className="shrink-0 text-rcd-muted" />
        <span className="truncate" title={node.path.join(' \\ ')}>
          {node.name}
        </span>
      </button>
      {open && (
        <div className="ml-3 border-l border-rcd-border pl-1">
          {node.folders.map(renderFolder)}
          {node.items.map(renderItem)}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible section disclosure row (chevron + label). A plain toggle
 * button — deliberately NOT a draggable; only FieldEntry rows carry dnd.
 */
function SectionHeader({
  label,
  icon,
  expanded,
  onToggle,
  action,
  indent,
  title,
  count,
}: {
  label: string;
  icon?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** Trailing control (the Measures "+"). Kept OUTSIDE the toggle button —
   *  a nested button is invalid HTML and swallows the disclosure click. */
  action?: React.ReactNode;
  /** Sub-section (a measure scope inside Measures). */
  indent?: boolean;
  title?: string;
  count?: number;
}) {
  const disclosure = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={title}
      className={`flex min-w-0 flex-1 items-center gap-1 pb-1 text-left text-xs font-medium uppercase tracking-wide text-rcd-muted hover:text-rcd-text ${
        indent ? 'pl-5 pr-3 pt-2 normal-case tracking-normal' : 'px-3 pt-3'
      }`}
    >
      {expanded ? (
        <ChevronDown size={12} className="shrink-0" />
      ) : (
        <ChevronRight size={12} className="shrink-0" />
      )}
      {icon}
      <span className="truncate" title={label}>
        {label}
      </span>
      {count !== undefined && count > 0 && (
        <span className="shrink-0 text-[10px] font-normal text-rcd-muted">{count}</span>
      )}
    </button>
  );
  if (!action) return disclosure;
  return (
    <div className="flex w-full items-center">
      {disclosure}
      <span className={`flex shrink-0 items-center pb-1 ${indent ? 'pt-2' : 'pt-3'}`}>{action}</span>
    </div>
  );
}

/**
 * A section header plus the hide/unhide affordance and the two notes hiding
 * can produce. Everything that can be hidden goes through here, so the rules —
 * a hidden group is never silently emptied, an in-use field always escapes —
 * live in exactly one place.
 */
function HideableSection({
  groupKey,
  label,
  icon,
  prefs,
  expanded,
  onToggle,
  inUseCount,
  count,
  indent,
  note,
  title,
  children,
}: {
  groupKey: string;
  label: string;
  icon?: React.ReactNode;
  prefs: FieldListPrefsController;
  expanded: boolean;
  onToggle: () => void;
  /** >0 = the group is hidden but keeps this many fields the chart uses. */
  inUseCount: number;
  count?: number;
  indent?: boolean;
  /** Read-only explanation shown under the header. */
  note?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const hidden = prefs.isHidden(groupKey);
  return (
    <div className="group/section">
      <SectionHeader
        label={label}
        icon={icon}
        expanded={expanded}
        onToggle={onToggle}
        indent={indent}
        title={title}
        count={count}
        action={
          <button
            type="button"
            aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
            title={
              hidden
                ? `Show ${label} again`
                : `Hide ${label} from this list (only for you — fields this chart uses stay visible)`
            }
            onClick={() => prefs.setHidden(groupKey, !hidden)}
            className="mr-2 shrink-0 rounded p-0.5 text-rcd-muted opacity-0 hover:bg-black/10 hover:text-rcd-text focus-visible:opacity-100 group-hover/section:opacity-100 dark:hover:bg-white/10"
          >
            {hidden ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        }
      />
      {expanded && (
        <>
          {inUseCount > 0 && (
            <p className="mx-1 mb-0.5 flex items-start gap-1 rounded-md bg-black/5 px-2 py-1 text-[11px] text-rcd-muted dark:bg-white/10">
              <EyeOff size={11} aria-hidden className="mt-[2px] shrink-0" />
              <span>
                Hidden — showing {inUseCount} field{inUseCount === 1 ? '' : 's'} this chart uses.
              </span>
            </p>
          )}
          {note !== undefined && (
            <p className="mx-1 mb-0.5 flex items-start gap-1 rounded-md px-2 py-0.5 text-[11px] text-rcd-muted">
              <Lock size={11} aria-hidden className="mt-[2px] shrink-0" />
              <span>{note}</span>
            </p>
          )}
          {children}
        </>
      )}
    </div>
  );
}

function FieldEntry({
  id,
  data,
  label,
  icon,
  iconKind,
  badge,
  title,
  onAdd,
  onFilter,
  action,
}: {
  id: string;
  data: FieldDragData;
  label: string;
  icon: React.ReactNode;
  /** Row tooltip (a derived field shows its formula). */
  title?: string;
  /**
   * Colours the glyph by what kind of field this is. An ACCENT only: the icon
   * shape and the label already carry the same information, so the row is
   * complete without colour vision.
   */
  iconKind?: FieldKind;
  /** Cosmetic suffix (e.g. the "fx" marker); never part of the drag payload. */
  badge?: React.ReactNode;
  onAdd: (data: FieldDragData) => void;
  /** When present, shows the funnel button that adds the field as a filter. */
  onFilter?: () => void;
  /** Trailing control rendered outside the draggable button (the row menu). */
  action?: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data });

  return (
    <div
      className={`group mx-1 flex items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10 ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <button
        type="button"
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        onClick={() => onAdd(data)}
        title={title ?? 'Drag into a well, or click to add'}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-2 py-1 text-left text-sm text-rcd-text"
      >
        <span
          className={iconKind ? 'shrink-0' : 'shrink-0 text-rcd-muted'}
          style={iconKind ? fieldKindStyle(iconKind) : undefined}
          title={iconKind ? fieldKindLabel(iconKind) : undefined}
        >
          {icon}
        </span>
        <span className="truncate">{label}</span>
        {badge}
        {/* The "click +" the well placeholders point at — visual affordance
            only; the whole row is already click-to-add. */}
        <Plus
          size={12}
          aria-hidden
          className={`${badge ? '' : 'ml-auto '}shrink-0 text-rcd-muted opacity-0 group-hover:opacity-100`}
        />
      </button>
      {onFilter && (
        <button
          type="button"
          aria-label={`Filter by ${label}`}
          title={`Filter by ${label}`}
          onClick={onFilter}
          className="mr-1 shrink-0 rounded p-1 text-rcd-muted opacity-0 hover:bg-black/10 hover:text-rcd-text focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10"
        >
          <Filter size={12} />
        </button>
      )}
      {action && <span className="mr-1 flex shrink-0 items-center">{action}</span>}
    </div>
  );
}
