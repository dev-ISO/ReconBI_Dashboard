import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, GripVertical, MoreVertical, Pencil, Trash2, type LucideIcon } from 'lucide-react';
import { ConfirmDialog, RcdIconButton } from '../primitives';

export interface TileFrameProps {
  title: string;
  /** Shows the drag handle + kebab actions (dashboard edit mode). */
  editable: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  children: ReactNode;
}

/**
 * Tile chrome: title bar (drag handle in edit mode) + kebab actions. The title
 * bar carries the `rcd-tile-drag-handle` class that DashboardGrid targets, so
 * the kebab and tile content stay clickable while dragging is title-bar only.
 */
export function TileFrame({ title, editable, onEdit, onDuplicate, onDelete, children }: TileFrameProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the kebab on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Lift this tile above grid siblings while its menu is open.
  useEffect(() => {
    if (!menuOpen) return;
    const gridItem = rootRef.current?.closest<HTMLElement>('.react-grid-item');
    if (!gridItem) return;
    const previous = gridItem.style.zIndex;
    gridItem.style.zIndex = '30';
    return () => {
      gridItem.style.zIndex = previous;
    };
  }, [menuOpen]);

  return (
    <div
      ref={rootRef}
      className="flex h-full flex-col rounded-lg border border-rcd-border bg-rcd-surface shadow-sm"
    >
      <div className="flex items-center border-b border-rcd-border py-1 pl-2 pr-1">
        <div
          className={`flex min-w-0 flex-1 items-center gap-1.5 py-0.5 ${
            editable ? 'rcd-tile-drag-handle cursor-move' : ''
          }`}
        >
          {editable && <GripVertical size={14} className="shrink-0 text-rcd-muted" />}
          <span className="truncate text-sm font-medium text-rcd-text" title={title}>
            {title}
          </span>
        </div>

        {editable && (
          <div className="relative" ref={menuRef}>
            <RcdIconButton
              aria-label={`Actions for ${title}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreVertical size={15} />
            </RcdIconButton>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-1 w-36 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-lg"
              >
                <MenuItem
                  icon={Pencil}
                  label="Edit"
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit();
                  }}
                />
                <MenuItem
                  icon={Copy}
                  label="Duplicate"
                  onClick={() => {
                    setMenuOpen(false);
                    onDuplicate();
                  }}
                />
                <MenuItem
                  icon={Trash2}
                  label="Delete"
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmDelete(true);
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 p-2">{children}</div>

      {confirmDelete &&
        // Portal past the transformed grid item so the fixed overlay covers the
        // viewport; the .rcd-root wrapper re-establishes theme tokens.
        createPortal(
          <div className="rcd-root bg-transparent">
            <ConfirmDialog
              title="Delete chart"
              message={`Delete "${title}"? The tile is removed from the dashboard (kept until you save).`}
              confirmLabel="Delete"
              danger
              open
              onConfirm={() => {
                setConfirmDelete(false);
                onDelete();
              }}
              onCancel={() => setConfirmDelete(false)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
        danger ? 'text-[var(--rcd-status-critical)]' : 'text-rcd-text'
      } hover:bg-black/5 dark:hover:bg-white/10`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
