import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface CanvasMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface CanvasContextMenuProps {
  ariaLabel: string;
  /** Screen coordinates of the right-click; the card clamps itself to the viewport. */
  position: { x: number; y: number };
  /** Item groups; separators render between non-empty groups. */
  groups: CanvasMenuItem[][];
  onClose: () => void;
}

/**
 * Right-click context card for the model canvas (relationship edges + table
 * nodes). Same pattern as PointContextMenu: a fixed-position card — NOT a
 * native context menu — closed by outside click or Escape. Portaled to
 * document.body so React Flow's viewport transform cannot skew the fixed
 * coordinates; the portal wrapper re-applies rcd-root because the --rcd-*
 * tokens are scoped to it.
 */
export function CanvasContextMenu({ ariaLabel, position, groups, onClose }: CanvasContextMenuProps) {
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

  const visibleGroups = groups.filter((group) => group.length > 0);
  if (visibleGroups.length === 0) return null;

  return createPortal(
    <div className="rcd-root bg-transparent">
      <div
        ref={cardRef}
        role="menu"
        aria-label={ariaLabel}
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed z-50 flex w-56 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
      >
        {visibleGroups.map((group, groupIndex) => (
          <Fragment key={groupIndex}>
            {groupIndex > 0 && <div className="my-1 border-t border-rcd-border" />}
            {group.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect();
                  onClose();
                }}
                className={
                  item.danger
                    ? 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10'
                    : 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10'
                }
              >
                {item.icon && <span className="shrink-0">{item.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
