import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Paintbrush, Pencil, Trash2, type LucideIcon } from 'lucide-react';
import { ConfirmDialog } from '../primitives';

export interface ChartContextMenuProps {
  /** Chart title (aria label + delete confirm message). */
  title: string;
  /** Screen coordinates of the right-click; the card clamps itself to the viewport. */
  position: { x: number; y: number };
  /** Opens the builder dialog on the Format tab. */
  onFormat: () => void;
  /** Opens the builder dialog on the Fields tab. */
  onEditFields: () => void;
  onDuplicate: () => void;
  /** Called after the user confirms the destructive delete. */
  onDelete: () => void;
  onClose: () => void;
}

/**
 * Right-click context card for CHART tiles (edit mode only; view-mode
 * right-click keeps the native browser menu). Same pattern as
 * SlicerConfigMenu: a fixed-position card — NOT a native context menu —
 * closed by outside click or Escape; the caller portals it to document.body
 * so grid-item transforms cannot skew the fixed coordinates.
 */
export function ChartContextMenu({
  title,
  position,
  onFormat,
  onEditFields,
  onDuplicate,
  onDelete,
  onClose,
}: ChartContextMenuProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  // Outside click / Escape closes (the delete confirm owns the keyboard then).
  useEffect(() => {
    if (confirmDelete) return;
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
  }, [onClose, confirmDelete]);

  return (
    <>
      <div
        ref={cardRef}
        role="menu"
        aria-label={`Actions for ${title}`}
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed z-50 flex w-44 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-xl"
      >
        <MenuItem
          icon={Paintbrush}
          label="Format chart…"
          onClick={() => {
            onFormat();
            onClose();
          }}
        />
        <MenuItem
          icon={Pencil}
          label="Edit fields…"
          onClick={() => {
            onEditFields();
            onClose();
          }}
        />
        <MenuItem
          icon={Copy}
          label="Duplicate"
          onClick={() => {
            onDuplicate();
            onClose();
          }}
        />
        <div className="my-1 border-t border-rcd-border" />
        <MenuItem icon={Trash2} label="Delete" danger onClick={() => setConfirmDelete(true)} />
      </div>

      <ConfirmDialog
        title="Delete chart"
        message={`Delete "${title}"? The tile is removed from the dashboard (kept until you save).`}
        confirmLabel="Delete"
        danger
        open={confirmDelete}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
          onClose();
        }}
        onCancel={() => {
          setConfirmDelete(false);
          onClose();
        }}
      />
    </>
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
