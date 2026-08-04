import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { DashboardPage } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog } from '../primitives';

export interface PageTabsProps {
  pages: DashboardPage[];
  activePageId: string | null;
  /** Edit mode: add / rename / color / reorder / delete affordances. */
  editable: boolean;
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
export function PageTabs({ pages, activePageId, editable }: PageTabsProps) {
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

  return (
    <>
      <div
        role="tablist"
        aria-label="Dashboard pages"
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-t border-rcd-border bg-rcd-bg px-1.5"
      >
        {pages.map((page) => {
          const active = page.id === activePageId;
          if (renaming?.pageId === page.id) {
            return (
              <div
                key={page.id}
                role="tab"
                aria-selected={active}
                className="relative flex shrink-0 items-center gap-1.5 px-1.5 py-1"
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
                  className="w-32 rounded border border-rcd-accent bg-rcd-surface px-1.5 py-0.5 text-sm text-rcd-text outline-none"
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
              className={`relative flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                active
                  ? 'bg-rcd-surface font-medium text-rcd-text'
                  : 'text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10'
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
              {active && (
                <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-rcd-accent" />
              )}
            </button>
          );
        })}

        {editable && (
          <button
            type="button"
            aria-label="Add page"
            title="Add page"
            onClick={() => runtime.dashboards.addPage()}
            className="ml-0.5 shrink-0 rounded-md p-1.5 text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {menu && menuPage && (
        <PageTabMenu
          page={menuPage}
          index={menuIndex}
          pageCount={pages.length}
          position={{ x: menu.x, y: menu.y }}
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
  onRename,
  onDelete,
  onClose,
}: {
  page: DashboardPage;
  index: number;
  pageCount: number;
  position: { x: number; y: number };
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
      className="fixed z-50 flex w-52 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-xl"
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
        disabled={pageCount <= 1}
        title={pageCount <= 1 ? 'A dashboard keeps at least one page' : undefined}
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
