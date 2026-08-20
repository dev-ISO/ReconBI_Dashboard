import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MeasureMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Renders in the critical colour (Delete). */
  danger?: boolean;
  /**
   * Disabled entries STAY VISIBLE with their reason as the tooltip. Hiding an
   * action the caller lacks makes the product look like it cannot do the
   * thing; showing it greyed with "why" makes it look like a permission.
   */
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

/** A visual break between groups (CRUD | transfers). */
export const MEASURE_MENU_SEPARATOR = '---';

/**
 * The per-measure "⋯" menu, shared by the field list's measure rows and the
 * manager's own rows so both offer exactly the same actions.
 *
 * Deliberately small: a button, an absolutely-positioned list, dismissal on
 * outside-click and Escape. No portal — it lives inside a scrolling pane that
 * already clips correctly, and a portal would need the dialog stack's z-order
 * story for no gain.
 */
export function MeasureRowMenu({
  label,
  items,
  compact = false,
}: {
  /** Accessible name, e.g. 'Actions for Total revenue'. */
  label: string;
  items: (MeasureMenuItem | typeof MEASURE_MENU_SEPARATOR)[];
  /** Field-list density: a smaller, hover-revealed trigger. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        className={`rounded p-1 text-rcd-muted hover:bg-black/10 hover:text-rcd-text dark:hover:bg-white/10 ${
          compact ? 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100' : ''
        } ${open ? 'opacity-100' : ''}`}
      >
        <MoreHorizontal size={compact ? 12 : 14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 min-w-44 overflow-hidden rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
        >
          {items.map((item, index) =>
            item === MEASURE_MENU_SEPARATOR ? (
              <hr key={`sep-${index}`} className="my-1 border-rcd-border" />
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                  item.disabled
                    ? 'cursor-not-allowed text-rcd-muted opacity-60'
                    : item.danger
                      ? 'text-[var(--rcd-status-critical)] hover:bg-black/5 dark:hover:bg-white/10'
                      : 'text-rcd-text hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
