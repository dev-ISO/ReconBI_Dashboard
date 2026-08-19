import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  isQueryableType,
  tableKey,
  type DashboardPage,
  type DrillthroughField,
  type PageDrillthrough,
} from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdInput, RcdSelect } from '../primitives';

export interface PageTabsProps {
  pages: DashboardPage[];
  activePageId: string | null;
  /** Edit mode: add / rename / color / reorder affordances. */
  editable: boolean;
  /**
   * Deleting a page additionally requires the CanDeleteContent right (0.11.1)
   * — gated separately from `editable` so a pages-only grantee can still
   * rename/reorder while the Delete item stays disabled (honest UX; the
   * server enforces regardless). Absent = follow `editable`.
   */
  canDeletePages?: boolean;
}

/**
 * Fixed hex palette sampling the --rcd-cat-* light-theme slots. Literal values
 * (not var() references) because the chosen color is persisted verbatim in the
 * layout doc and must render identically for every viewer/theme.
 */
const PAGE_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
];

/**
 * Excel-style page tab bar docked at the bottom of DashboardView (both modes).
 * Click switches pages; edit mode adds a "+" button, double-click inline
 * rename, and a right-click context card (rename / color / reorder / delete).
 * All destructive paths go through ConfirmDialog — no native menus.
 */
export function PageTabs({ pages, activePageId, editable, canDeletePages }: PageTabsProps) {
  const runtime = useRuntime();
  const [renaming, setRenaming] = useState<{ pageId: string; draft: string } | null>(null);
  const [menu, setMenu] = useState<{ pageId: string; x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DashboardPage | null>(null);

  const startRename = (page: DashboardPage) => setRenaming({ pageId: page.id, draft: page.name });

  const commitRename = () => {
    if (!renaming) return;
    const next = renaming.draft.trim();
    if (next !== '') runtime.dashboards.renamePage(renaming.pageId, next);
    setRenaming(null);
  };

  const menuIndex = menu ? pages.findIndex((page) => page.id === menu.pageId) : -1;
  const menuPage = menuIndex === -1 ? null : (pages[menuIndex] ?? null);
  // Stable position identity: an inline {x, y} literal re-ran the card's
  // clamp useLayoutEffect on EVERY parent render (store updates, hover
  // state), making the open card jump back to its raw anchor. `menu` is
  // state, so this identity holds until the menu actually moves.
  const menuPosition = useMemo(() => (menu ? { x: menu.x, y: menu.y } : null), [menu]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-rcd-border bg-rcd-bg px-2 py-1.5">
        {/* shadcn Tabs: muted rounded-lg container; the active tab is a raised
            surface pill. The page-color dot stays on every tab. */}
        <div
          role="tablist"
          aria-label="Dashboard pages"
          className="flex shrink-0 items-center gap-0.5 rounded-lg bg-black/5 p-1 dark:bg-white/10"
        >
          {pages.map((page) => {
            const active = page.id === activePageId;
            if (renaming?.pageId === page.id) {
              return (
                <div
                  key={page.id}
                  role="tab"
                  aria-selected={active}
                  className="relative flex shrink-0 items-center gap-1.5 px-1 py-0.5"
                >
                  {page.color && (
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: page.color }}
                    />
                  )}
                  <input
                    value={renaming.draft}
                    onChange={(event) => setRenaming({ pageId: page.id, draft: event.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename();
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                    aria-label={`Rename page ${page.name}`}
                    autoFocus
                    onFocus={(event) => event.target.select()}
                    className="w-32 rounded-md border border-[var(--rcd-accent-interactive)] bg-rcd-surface px-1.5 py-0.5 text-sm text-rcd-text outline-none"
                  />
                </div>
              );
            }
            return (
              <button
                key={page.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={page.name}
                onClick={() => runtime.dashboards.setActivePage(page.id)}
                onDoubleClick={editable ? () => startRename(page) : undefined}
                onContextMenu={
                  editable
                    ? (event) => {
                        // Context card instead of the native browser menu.
                        event.preventDefault();
                        setMenu({ pageId: page.id, x: event.clientX, y: event.clientY });
                      }
                    : undefined
                }
                className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm transition-colors ${
                  active
                    ? 'bg-rcd-surface font-medium text-rcd-text shadow-[var(--rcd-shadow-1)]'
                    : 'text-rcd-text-2 hover:text-rcd-text'
                }`}
              >
                {page.color && (
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: page.color }}
                  />
                )}
                <span className="max-w-[10rem] truncate">{page.name}</span>
              </button>
            );
          })}
        </div>

        {editable && (
          <button
            type="button"
            aria-label="Add page"
            title="Add page"
            onClick={() => runtime.dashboards.addPage()}
            className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {menu && menuPage && menuPosition && (
        <PageTabMenu
          page={menuPage}
          index={menuIndex}
          pageCount={pages.length}
          position={menuPosition}
          canDelete={canDeletePages ?? editable}
          onRename={() => startRename(menuPage)}
          onDelete={() => setConfirmDelete(menuPage)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        title="Delete page"
        message={
          confirmDelete
            ? `Delete page "${confirmDelete.name}"? All tiles on it are removed (kept until you save).`
            : ''
        }
        confirmLabel="Delete"
        danger
        open={confirmDelete !== null}
        onConfirm={() => {
          if (confirmDelete) runtime.dashboards.removePage(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
}

/**
 * Right-click context card for a page tab. A fixed-position card (NOT a native
 * context menu) closed by outside click or Escape, clamped to the viewport.
 * The tab bar sits in normal (untransformed) flow, so no portal is needed.
 */
function PageTabMenu({
  page,
  index,
  pageCount,
  position,
  canDelete,
  onRename,
  onDelete,
  onClose,
}: {
  page: DashboardPage;
  index: number;
  pageCount: number;
  position: { x: number; y: number };
  /** CanDeleteContent right — the Delete item disables without it. */
  canDelete: boolean;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);

  // Clamp to the viewport once the card has a measured size.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 4)),
    });
  }, [position]);

  // Outside click / Escape closes.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (cardRef.current && event.target instanceof Node && !cardRef.current.contains(event.target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const setColor = (color: string | null) => {
    runtime.dashboards.setPageColor(page.id, color);
    onClose();
  };

  return (
    <div
      ref={cardRef}
      role="menu"
      aria-label={`Options for page ${page.name}`}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 flex w-64 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
    >
      <MenuButton
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        <Pencil size={14} />
        Rename
      </MenuButton>

      <Divider />
      <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
        Color
      </p>
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
        {PAGE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="menuitem"
            aria-label={`Set tab color ${color}`}
            title={color}
            onClick={() => setColor(color)}
            style={{ backgroundColor: color }}
            className={`h-5 w-5 shrink-0 rounded-full ${
              (page.color ?? null) === color
                ? 'border-2 border-rcd-text'
                : 'border border-rcd-border hover:border-rcd-text-2'
            }`}
          />
        ))}
        <button
          type="button"
          role="menuitem"
          onClick={() => setColor(null)}
          className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
            page.color == null
              ? 'border-rcd-text text-rcd-text'
              : 'border-rcd-border text-rcd-text-2 hover:border-rcd-text-2 hover:text-rcd-text'
          }`}
        >
          None
        </button>
      </div>

      <Divider />
      <DrillthroughSection page={page} />

      <Divider />
      <MenuButton
        disabled={index <= 0}
        onClick={() => {
          runtime.dashboards.movePage(page.id, 'left');
          onClose();
        }}
      >
        <ArrowLeft size={14} />
        Move left
      </MenuButton>
      <MenuButton
        disabled={index >= pageCount - 1}
        onClick={() => {
          runtime.dashboards.movePage(page.id, 'right');
          onClose();
        }}
      >
        <ArrowRight size={14} />
        Move right
      </MenuButton>

      <Divider />
      <button
        type="button"
        role="menuitem"
        disabled={pageCount <= 1 || !canDelete}
        title={
          pageCount <= 1
            ? 'A dashboard keeps at least one page'
            : !canDelete
              ? 'Your access does not allow deleting pages'
              : undefined
        }
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
      >
        <Trash2 size={14} />
        Delete page
      </button>
    </div>
  );
}

function MenuButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-rcd-border" />;
}

/**
 * "Drillthrough" subsection of the page-config card: enable toggle + the
 * table/column fields a drillthrough into this page filters by. Fields are
 * added via model-driven selects when the dashboard's model (and catalog) are
 * loaded in the model store, with a free-text fallback otherwise. Edits go
 * straight to the layout doc (dirty like any other page edit); the card stays
 * open while editing and closes on outside click.
 */
function DrillthroughSection({ page }: { page: DashboardPage }) {
  const runtime = useRuntime();
  const openModel = useModelState((state) => state.current);
  const catalog = useModelState((state) => state.catalog);

  const config = page.drillthrough ?? null;
  const enabled = config?.enabled ?? false;
  const fields = config?.fields ?? [];

  // Pending "add field" row (selects when the model is loaded, free text else).
  const [pendingTable, setPendingTable] = useState('');
  const [pendingColumn, setPendingColumn] = useState('');

  const usableCatalog =
    openModel !== null && catalog !== null && catalog.connection === openModel.dataSourceName
      ? catalog
      : null;

  const tables = useMemo(
    () => (openModel !== null ? openModel.definition.tables.filter((t) => !t.hidden) : []),
    [openModel],
  );
  const modelDriven = tables.length > 0;

  const columns = useMemo(() => {
    if (!usableCatalog || pendingTable === '') return [];
    const modelTable = tables.find((t) => tableKey(t.schema, t.name) === pendingTable);
    const overrides = new Map((modelTable?.columns ?? []).map((c) => [c.name, c]));
    return (usableCatalog.tables.find((t) => t.key === pendingTable)?.columns ?? [])
      .filter((c) => isQueryableType(c.type) && !overrides.get(c.name)?.hidden)
      .map((c) => ({ name: c.name, label: overrides.get(c.name)?.friendlyName ?? c.name }));
  }, [usableCatalog, pendingTable, tables]);

  // When the model arrives AFTER the user started typing (the inputs swap to
  // selects), carry typed values over by case-insensitive match so they don't
  // silently render as a blank select while Add still writes them. Values
  // that match nothing keep the free-text inputs below (with a hint) instead.
  useEffect(() => {
    if (!modelDriven || pendingTable === '') return;
    const trimmed = pendingTable.trim().toLowerCase();
    const match = tables.find((t) => tableKey(t.schema, t.name).toLowerCase() === trimmed);
    if (match) {
      const key = tableKey(match.schema, match.name);
      if (key !== pendingTable) setPendingTable(key);
    }
  }, [modelDriven, tables, pendingTable]);
  useEffect(() => {
    if (pendingColumn === '' || columns.length === 0) return;
    const trimmed = pendingColumn.trim().toLowerCase();
    const match = columns.find((c) => c.name.toLowerCase() === trimmed);
    if (match && match.name !== pendingColumn) setPendingColumn(match.name);
  }, [columns, pendingColumn]);

  // Selects can only DISPLAY values that exist among their options — pending
  // text the reconciliation above could not resolve stays in the free-text
  // style (never invisibly inside a blank select).
  const pendingTableDisplayable =
    pendingTable === '' || tables.some((t) => tableKey(t.schema, t.name) === pendingTable);
  const pendingColumnDisplayable =
    pendingColumn === '' || columns.some((c) => c.name === pendingColumn);
  const showSelects = modelDriven && pendingTableDisplayable && pendingColumnDisplayable;

  const commit = (next: PageDrillthrough | null) =>
    runtime.dashboards.setPageDrillthrough(page.id, next);

  const toggleEnabled = () => {
    if (enabled) commit(fields.length === 0 ? null : { enabled: false, fields });
    else commit({ enabled: true, fields });
  };

  const addField = () => {
    const table = pendingTable.trim();
    const column = pendingColumn.trim();
    if (table === '' || column === '') return;
    if (fields.some((f) => f.table === table && f.column === column)) return;
    commit({ enabled, fields: [...fields, { table, column }] });
    setPendingTable('');
    setPendingColumn('');
  };

  const removeField = (field: DrillthroughField) => {
    commit({
      enabled,
      fields: fields.filter((f) => !(f.table === field.table && f.column === field.column)),
    });
  };

  return (
    <>
      <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
        Drillthrough
      </p>
      <div className="flex flex-col gap-1.5 px-3 pb-1.5">
        <label className="flex items-center gap-2 text-sm text-rcd-text">
          <input
            type="checkbox"
            checked={enabled}
            onChange={toggleEnabled}
            className="accent-[var(--rcd-accent)]"
          />
          Allow drill through to this page
        </label>

        {enabled && (
          <>
            {fields.map((field) => (
              <div
                key={`${field.table}.${field.column}`}
                className="flex items-center gap-1.5 rounded border border-rcd-border px-2 py-1 text-xs text-rcd-text-2"
              >
                <span className="min-w-0 flex-1 truncate" title={`${field.table}.${field.column}`}>
                  {field.table}.{field.column}
                </span>
                <button
                  type="button"
                  aria-label={`Remove drillthrough field ${field.table}.${field.column}`}
                  onClick={() => removeField(field)}
                  className="shrink-0 rounded p-0.5 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {fields.length === 0 && (
              <p className="text-xs text-rcd-muted">Add the field(s) this page filters by.</p>
            )}

            {showSelects ? (
              <>
                <RcdSelect
                  aria-label="Drillthrough field table"
                  value={pendingTable}
                  onChange={(event) => {
                    setPendingTable(event.target.value);
                    setPendingColumn('');
                  }}
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
                <div className="flex items-center gap-1.5">
                  <RcdSelect
                    aria-label="Drillthrough field column"
                    value={pendingColumn}
                    onChange={(event) => setPendingColumn(event.target.value)}
                    disabled={pendingTable === '' || usableCatalog === null}
                    className="min-w-0 flex-1"
                  >
                    <option value="">Choose a column…</option>
                    {columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.label}
                      </option>
                    ))}
                  </RcdSelect>
                  <RcdButton
                    disabled={pendingTable === '' || pendingColumn === ''}
                    onClick={addField}
                  >
                    Add
                  </RcdButton>
                </div>
              </>
            ) : (
              // No model/catalog reachable — or typed values the loaded
              // model could not resolve: free-text "schema.table" + column.
              <>
                <div className="flex items-center gap-1.5">
                  <RcdInput
                    aria-label="Drillthrough field table"
                    value={pendingTable}
                    onChange={(event) => setPendingTable(event.target.value)}
                    placeholder="schema.table"
                    className="min-w-0 flex-1"
                  />
                  <RcdInput
                    aria-label="Drillthrough field column"
                    value={pendingColumn}
                    onChange={(event) => setPendingColumn(event.target.value)}
                    placeholder="column"
                    className="min-w-0 flex-1"
                  />
                  <RcdButton
                    disabled={pendingTable.trim() === '' || pendingColumn.trim() === ''}
                    onClick={addField}
                  >
                    Add
                  </RcdButton>
                </div>
                {modelDriven && (
                  <p className="text-[11px] leading-snug text-rcd-muted">
                    These names don’t match the model — fix the spelling, or clear them to
                    pick from the lists.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
