import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Filter, Plus, Trash2, X } from 'lucide-react';
import {
  columnLabelOf,
  filterCardHasUnsupportedOr,
  isChartTile,
  isCompleteFilterCondition,
  isNumericType,
  isQueryableType,
  isTemporalType,
  tableKey,
  type AsyncStatus,
  type Catalog,
  type ColumnType,
  type DashboardTile,
  type FilterCard,
  type FilterCardCondition,
  type FilterOperator,
  type FilterScope,
  type FilterValue,
  type ModelTable,
} from '@recon/dashboards-core';
import { DistinctValueList } from '../chart-builder/DistinctValueList';
import { OPERATOR_LABELS, operatorsFor } from '../chart-builder/wellConfig';
import { useDashboardState, useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdIconButton, RcdInput, RcdSelect } from '../primitives';

export interface FiltersPaneProps {
  /** Active page id — the pane lists this page's visible cards. */
  pageId: string | null;
  /** Tiles of the active page (visual-section titles + selection resolution). */
  tiles: DashboardTile[];
  /** Dashboard's model; null disables adding (no fields to pick from). */
  modelId: number | null;
  /** Edit mode: structural mutations (add/remove/mode/advanced/scope). */
  editable: boolean;
  onClose: () => void;
}

/** A field chosen from the add-filter picker. */
interface PickedField {
  table: string;
  column: string;
  columnType: ColumnType | null;
}

const SCOPE_BADGES: Record<FilterScope, string> = {
  visual: 'This visual',
  page: 'This page',
  allPages: 'All pages',
};

/**
 * Advanced condition rows are single-value only: 'in' is what basic mode
 * compiles to, and 'notIn'/'between' need multi-value rows the card's
 * condition shape (one optional value) cannot carry.
 */
const advancedOperatorsFor = (type: ColumnType | null): readonly FilterOperator[] =>
  operatorsFor(type).filter((op) => op !== 'in' && op !== 'notIn' && op !== 'between');

const MAX_CONDITIONS = 3;

const cardColumnType = (card: FilterCard): ColumnType | null =>
  (card.columnType ?? null) as ColumnType | null;

/**
 * One-line human summary of a card's current filter, e.g. "is West or South"
 * or "> 100 and ≤ 500". Null when the card filters nothing yet. Exported for
 * reuse (e.g. the printed header's filter chips).
 */
export const filterCardSummary = (card: FilterCard): string | null => {
  if (card.mode === 'basic') {
    const values = (card.basicValues ?? []).map(String);
    if (values.length === 0) return null;
    return values.length <= 3 ? `is ${values.join(' or ')}` : `is one of ${values.length} values`;
  }
  const complete = (card.conditions ?? []).filter(isCompleteFilterCondition);
  if (complete.length === 0) return null;
  const join = (card.conditionJoin ?? 'and') === 'or' ? ' or ' : ' and ';
  return complete
    .map((c) =>
      c.operator === 'isNull' || c.operator === 'notNull'
        ? OPERATOR_LABELS[c.operator]
        : `${OPERATOR_LABELS[c.operator]} ${String(c.value ?? '')}`,
    )
    .join(join);
};

/**
 * Power BI-style Filters pane: a right-docked column of filter cards grouped
 * by scope. Rendered in BOTH modes; structural mutations (add/remove/mode/
 * conditions) are edit-only, while view mode may still toggle cards on/off and
 * change basic selections (routed to transient overrides by the store).
 */
export function FiltersPane({ pageId, tiles, modelId, editable, onClose }: FiltersPaneProps) {
  const runtime = useRuntime();
  const current = useDashboardState((state) => state.current);
  const overrides = useDashboardState((state) => state.filterCardOverrides);
  const selectedTileId = useDashboardState((state) => state.selectedTileId);

  const openModel = useModelState((state) => state.current);
  const catalog = useModelState((state) => state.catalog);
  const catalogStatus = useModelState((state) => state.catalogStatus);

  /** Card ids with an expanded body (new cards start expanded). */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // The memo tracks the exact store slices that can change card output
  // (layout mutations arrive via `current`, view tweaks via `overrides`).
  const cards = useMemo(
    () => runtime.dashboards.visibleFilterCards(pageId),
    [runtime, current, overrides, pageId],
  );

  const selectedChart = useMemo(() => {
    const tile = tiles.find((t) => t.id === selectedTileId);
    return tile && isChartTile(tile) ? { id: tile.id, title: tile.chart.title } : null;
  }, [tiles, selectedTileId]);

  const visualCards = cards.filter(
    (card) => card.scope === 'visual' && card.targetTileId === selectedChart?.id,
  );
  const pageCards = cards.filter((card) => card.scope === 'page');
  const allPagesCards = cards.filter((card) => card.scope === 'allPages');

  const modelReady = modelId !== null && openModel !== null && openModel.id === modelId;
  const usableCatalog =
    modelReady && catalogStatus === 'ok' && catalog && catalog.connection === openModel.dataSourceName
      ? catalog
      : null;

  const modelTables = useMemo(
    () => (modelReady ? openModel.definition.tables.filter((t) => !t.hidden) : []),
    [modelReady, openModel],
  );

  const tableLabelOf = (table: string): string => {
    const modelTable = modelTables.find((t) => tableKey(t.schema, t.name) === table);
    return modelTable?.friendlyName ?? modelTable?.name ?? table;
  };

  /** Friendly column label via the shared core helper; raw name until the model loads. */
  const columnLabel = (table: string, column: string): string =>
    modelReady && openModel ? columnLabelOf(openModel.definition, table, column) : column;

  const addCard = (scope: FilterScope, field: PickedField) => {
    const id = runtime.dashboards.addFilterCard({
      scope,
      targetTileId: scope === 'visual' ? (selectedChart?.id ?? null) : null,
      pageId: scope === 'page' ? pageId : null,
      table: field.table,
      column: field.column,
      columnType: field.columnType,
      mode: 'basic',
      basicValues: [],
      conditions: null,
      conditionJoin: 'and',
    });
    setExpanded((prev) => ({ ...prev, [id]: true }));
  };

  const renderCards = (list: FilterCard[]) =>
    list.map((card) => (
      <FilterCardView
        key={card.id}
        card={card}
        modelId={modelId}
        editable={editable}
        columnLabel={columnLabel(card.table, card.column)}
        tableLabel={tableLabelOf(card.table)}
        expanded={expanded[card.id] ?? false}
        onToggleExpanded={() =>
          setExpanded((prev) => ({ ...prev, [card.id]: !(prev[card.id] ?? false) }))
        }
      />
    ));

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-rcd-border bg-rcd-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-rcd-border px-3 py-2">
        <Filter size={14} className="text-rcd-text-2" />
        <span className="text-sm font-semibold text-rcd-text">Filters</span>
        <div className="min-w-0 flex-1" />
        <RcdIconButton aria-label="Close filters pane" title="Close filters" onClick={onClose}>
          <X size={14} />
        </RcdIconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {editable && (
          <PaneSection
            title={selectedChart ? `On this visual — ${selectedChart.title}` : 'On this visual'}
            addButton={
              selectedChart ? (
                <AddFilterButton
                  tables={modelTables}
                  catalog={usableCatalog}
                  catalogStatus={catalogStatus}
                  modelReady={modelReady}
                  onPick={(field) => addCard('visual', field)}
                />
              ) : null
            }
          >
            {selectedChart === null ? (
              <p className="text-xs text-rcd-muted">
                Select a chart tile to see and add filters for that visual.
              </p>
            ) : visualCards.length === 0 ? (
              <p className="text-xs text-rcd-muted">No filters on this visual.</p>
            ) : (
              renderCards(visualCards)
            )}
          </PaneSection>
        )}

        <PaneSection
          title="On this page"
          addButton={
            editable ? (
              <AddFilterButton
                tables={modelTables}
                catalog={usableCatalog}
                catalogStatus={catalogStatus}
                modelReady={modelReady}
                onPick={(field) => addCard('page', field)}
              />
            ) : null
          }
        >
          {pageCards.length === 0 ? (
            <p className="text-xs text-rcd-muted">No filters on this page.</p>
          ) : (
            renderCards(pageCards)
          )}
        </PaneSection>

        <PaneSection
          title="On all pages"
          addButton={
            editable ? (
              <AddFilterButton
                tables={modelTables}
                catalog={usableCatalog}
                catalogStatus={catalogStatus}
                modelReady={modelReady}
                onPick={(field) => addCard('allPages', field)}
              />
            ) : null
          }
        >
          {allPagesCards.length === 0 ? (
            <p className="text-xs text-rcd-muted">No filters on all pages.</p>
          ) : (
            renderCards(allPagesCards)
          )}
        </PaneSection>

        {modelId === null && (
          <p className="text-xs text-rcd-muted">
            This dashboard has no model attached, so filters cannot be added.
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- sections */

function PaneSection({
  title,
  addButton,
  children,
}: {
  title: string;
  addButton: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3
          className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-rcd-muted"
          title={title}
        >
          {title}
        </h3>
        {addButton}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------ field picker */

interface AddFilterButtonProps {
  tables: ModelTable[];
  catalog: Catalog | null;
  catalogStatus: AsyncStatus;
  modelReady: boolean;
  onPick: (field: PickedField) => void;
}

/**
 * "+ Add filter" with an anchored field-picker card (styled popover, NOT a
 * native menu): model tables in a select, catalog columns as a click list.
 * Closed by outside click or Escape.
 */
function AddFilterButton({ tables, catalog, catalogStatus, modelReady, onPick }: AddFilterButtonProps) {
  const [open, setOpen] = useState(false);
  const [table, setTable] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const columns = useMemo(() => {
    if (!catalog || table === '') return [];
    const modelTable = tables.find((t) => tableKey(t.schema, t.name) === table);
    const overrides = new Map((modelTable?.columns ?? []).map((c) => [c.name, c]));
    return (catalog.tables.find((t) => t.key === table)?.columns ?? [])
      .filter((c) => isQueryableType(c.type) && !overrides.get(c.name)?.hidden)
      .map((c) => ({
        name: c.name,
        type: c.type,
        label: overrides.get(c.name)?.friendlyName ?? c.name,
      }));
  }, [catalog, table, tables]);

  const pick = (column: { name: string; type: ColumnType }) => {
    setOpen(false);
    setTable('');
    onPick({ table, column: column.name, columnType: column.type });
  };

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
      >
        <Plus size={12} />
        Add filter
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Add a filter field"
          className="absolute right-0 top-full z-40 mt-1 flex w-64 flex-col gap-2 rounded-md border border-rcd-border bg-rcd-surface p-2 shadow-[var(--rcd-shadow-2)]"
        >
          {!modelReady ? (
            <p className="p-1 text-xs text-rcd-muted">Loading the dashboard&apos;s model…</p>
          ) : (
            <>
              <RcdSelect
                aria-label="Filter table"
                value={table}
                onChange={(event) => setTable(event.target.value)}
                className="w-full"
              >
                <option value="">Choose a table…</option>
                {tables.map((t) => {
                  const key = tableKey(t.schema, t.name);
                  return (
                    <option key={key} value={key}>
                      {t.friendlyName ?? t.name}
                    </option>
                  );
                })}
              </RcdSelect>

              {table !== '' && catalog === null ? (
                <p className="p-1 text-xs text-rcd-muted">
                  {catalogStatus === 'error'
                    ? 'Could not load the column catalog.'
                    : 'Loading columns…'}
                </p>
              ) : table !== '' && columns.length === 0 ? (
                <p className="p-1 text-xs text-rcd-muted">No filterable columns in this table.</p>
              ) : table !== '' ? (
                <div className="max-h-48 overflow-y-auto rounded-md border border-rcd-border">
                  {columns.map((column) => (
                    <button
                      key={column.name}
                      type="button"
                      onClick={() => pick(column)}
                      className="flex w-full items-center px-2 py-1 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <span className="min-w-0 truncate" title={column.label}>
                        {column.label}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="p-1 text-xs text-rcd-muted">Pick a table to list its columns.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- the card */

interface FilterCardViewProps {
  card: FilterCard;
  modelId: number | null;
  editable: boolean;
  columnLabel: string;
  tableLabel: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}

function FilterCardView({
  card,
  modelId,
  editable,
  columnLabel,
  tableLabel,
  expanded,
  onToggleExpanded,
}: FilterCardViewProps) {
  const runtime = useRuntime();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const columnType = cardColumnType(card);
  const enabled = !card.disabled;
  const summary = filterCardSummary(card);
  const unsupportedOr = filterCardHasUnsupportedOr(card);
  // View mode can interact with basic selections only; advanced cards are
  // summary + toggle there (structure is edit-only).
  const expandable = editable || card.mode === 'basic';

  const toggleBasicValue = (value: FilterValue) => {
    const selected = card.basicValues ?? [];
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    runtime.dashboards.updateFilterCard(card.id, { basicValues: next });
  };

  const setMode = (mode: 'basic' | 'advanced') => {
    if (mode === card.mode) return;
    // Entering advanced mode seeds one empty condition row to edit.
    const conditions =
      mode === 'advanced' && (card.conditions ?? []).length === 0
        ? [{ operator: advancedOperatorsFor(columnType)[0] ?? 'eq' }]
        : card.conditions;
    runtime.dashboards.updateFilterCard(card.id, { mode, conditions });
  };

  return (
    <div className={`rounded-md border border-rcd-border bg-rcd-bg ${enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-start gap-1 py-1.5 pl-1 pr-1.5">
        <button
          type="button"
          aria-label={expanded ? `Collapse ${columnLabel} filter` : `Expand ${columnLabel} filter`}
          aria-expanded={expanded}
          disabled={!expandable}
          onClick={onToggleExpanded}
          className="mt-0.5 shrink-0 rounded p-0.5 text-rcd-muted hover:bg-black/5 hover:text-rcd-text disabled:opacity-30 dark:hover:bg-white/10"
        >
          {expanded && expandable ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium text-rcd-text" title={columnLabel}>
              {columnLabel}
            </span>
            <span className="shrink-0 rounded-full border border-rcd-border px-1.5 text-[10px] leading-4 text-rcd-muted">
              {SCOPE_BADGES[card.scope]}
            </span>
          </div>
          <p className="truncate text-[11px] text-rcd-muted" title={tableLabel}>
            {tableLabel}
          </p>
          {summary !== null && !unsupportedOr && (
            <p className="truncate text-[11px] text-rcd-text-2" title={summary}>
              {summary}
            </p>
          )}
          {unsupportedOr && (
            <p className="flex items-center gap-1 text-[11px] text-[var(--rcd-status-warn)]">
              <AlertTriangle size={11} className="shrink-0" />
              <span className="min-w-0 truncate">Or needs all &quot;=&quot; — not applied</span>
            </p>
          )}
        </div>

        <label
          className="mt-0.5 flex shrink-0 cursor-pointer items-center"
          title={enabled ? 'Disable this filter' : 'Enable this filter'}
        >
          <input
            type="checkbox"
            aria-label={`${columnLabel} filter enabled`}
            className="accent-[var(--rcd-accent)]"
            checked={enabled}
            onChange={() => runtime.dashboards.toggleFilterCard(card.id)}
          />
        </label>

        {editable && (
          <RcdIconButton
            aria-label={`Remove ${columnLabel} filter`}
            title="Remove filter"
            className="-my-0.5 shrink-0"
            onClick={() => setConfirmRemove(true)}
          >
            <X size={13} />
          </RcdIconButton>
        )}
      </div>

      {expanded && expandable && (
        <div className="flex flex-col gap-2 border-t border-rcd-border p-2">
          {editable && (
            <div className="flex rounded-md border border-rcd-border p-0.5">
              {(['basic', 'advanced'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={card.mode === mode}
                  onClick={() => setMode(mode)}
                  className={`flex-1 rounded px-2 py-0.5 text-xs font-medium ${
                    card.mode === mode
                      ? 'bg-rcd-surface text-rcd-text shadow-sm'
                      : 'text-rcd-muted hover:text-rcd-text'
                  }`}
                >
                  {mode === 'basic' ? 'Basic' : 'Advanced'}
                </button>
              ))}
            </div>
          )}

          {card.mode === 'basic' ? (
            modelId === null ? (
              <p className="text-xs text-rcd-muted">No model attached — values unavailable.</p>
            ) : (
              <DistinctValueList
                modelId={modelId}
                table={card.table}
                column={card.column}
                selected={card.basicValues ?? []}
                onToggle={toggleBasicValue}
              />
            )
          ) : (
            <AdvancedEditor card={card} columnType={columnType} />
          )}
        </div>
      )}

      <ConfirmDialog
        title="Remove filter"
        message={`Remove the "${columnLabel}" filter? It stops filtering immediately (kept until you save).`}
        confirmLabel="Remove"
        danger
        open={confirmRemove}
        onConfirm={() => {
          setConfirmRemove(false);
          runtime.dashboards.removeFilterCard(card.id);
        }}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}

/* --------------------------------------------------------- advanced editor */

const inputTypeFor = (type: ColumnType | null): 'number' | 'date' | 'text' => {
  if (type !== null && isNumericType(type)) return 'number';
  if (type !== null && isTemporalType(type)) return 'date';
  return 'text';
};

/** '' clears to null (incomplete row); numbers parse, anything else is raw text. */
const coerceValue = (raw: string, type: ColumnType | null): FilterValue | null => {
  if (raw.trim() === '') return null;
  if (type !== null && isNumericType(type)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return raw;
};

const conditionInputText = (value: FilterValue | null | undefined): string =>
  value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);

/** 1-3 condition rows + And/Or join, mirrored straight into the store. */
function AdvancedEditor({ card, columnType }: { card: FilterCard; columnType: ColumnType | null }) {
  const runtime = useRuntime();
  const operators = advancedOperatorsFor(columnType);
  const conditions: FilterCardCondition[] =
    (card.conditions ?? []).length > 0
      ? (card.conditions ?? [])
      : [{ operator: operators[0] ?? 'eq' }];
  const join = card.conditionJoin ?? 'and';

  const setConditions = (next: FilterCardCondition[]) =>
    runtime.dashboards.updateFilterCard(card.id, { conditions: next });

  const patchCondition = (index: number, patch: Partial<FilterCardCondition>) =>
    setConditions(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  const inputType = inputTypeFor(columnType);

  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => {
        const needsValue = condition.operator !== 'isNull' && condition.operator !== 'notNull';
        return (
          <div key={index} className="flex flex-col gap-1">
            {index > 0 && (
              <div className="flex items-center gap-3 text-xs text-rcd-text-2" role="radiogroup" aria-label="Combine conditions with">
                {(['and', 'or'] as const).map((option) => (
                  <label key={option} className="flex cursor-pointer items-center gap-1">
                    <input
                      type="radio"
                      name={`rcd-filter-join-${card.id}`}
                      className="accent-[var(--rcd-accent)]"
                      checked={join === option}
                      onChange={() =>
                        runtime.dashboards.updateFilterCard(card.id, { conditionJoin: option })
                      }
                    />
                    {option === 'and' ? 'And' : 'Or'}
                  </label>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1">
              <RcdSelect
                aria-label={`Condition ${index + 1} operator`}
                value={condition.operator}
                onChange={(event) => {
                  const operator = event.target.value as FilterOperator;
                  patchCondition(index, {
                    operator,
                    // isNull/notNull carry no value; keep it otherwise.
                    ...(operator === 'isNull' || operator === 'notNull' ? { value: null } : {}),
                  });
                }}
                className="w-28 shrink-0"
              >
                {operators.map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </option>
                ))}
              </RcdSelect>

              {needsValue &&
                (columnType === 'boolean' ? (
                  <RcdSelect
                    aria-label={`Condition ${index + 1} value`}
                    value={
                      condition.value === true ? 'true' : condition.value === false ? 'false' : ''
                    }
                    onChange={(event) =>
                      patchCondition(index, {
                        value: event.target.value === '' ? null : event.target.value === 'true',
                      })
                    }
                    className="min-w-0 flex-1"
                  >
                    <option value="">Value…</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </RcdSelect>
                ) : (
                  <RcdInput
                    aria-label={`Condition ${index + 1} value`}
                    type={inputType}
                    value={conditionInputText(condition.value)}
                    onChange={(event) =>
                      patchCondition(index, { value: coerceValue(event.target.value, columnType) })
                    }
                    placeholder="Value"
                    className="min-w-0 flex-1"
                  />
                ))}

              {conditions.length > 1 && (
                <RcdIconButton
                  aria-label={`Remove condition ${index + 1}`}
                  title="Remove condition"
                  className="shrink-0"
                  onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
                >
                  <Trash2 size={13} />
                </RcdIconButton>
              )}
            </div>
          </div>
        );
      })}

      {conditions.length < MAX_CONDITIONS && (
        <button
          type="button"
          onClick={() =>
            setConditions([...conditions, { operator: operators[0] ?? 'eq' }])
          }
          className="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
        >
          <Plus size={12} />
          Add condition
        </button>
      )}

      {filterCardHasUnsupportedOr(card) && (
        <p className="flex items-start gap-1 text-[11px] text-[var(--rcd-status-warn)]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          &quot;Or&quot; currently supports only &quot;=&quot; conditions (they combine into one
          &quot;one of&quot; filter). Mixed operators need engine OR support — this filter is not
          applied.
        </p>
      )}
    </div>
  );
}
