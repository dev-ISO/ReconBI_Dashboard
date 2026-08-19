import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  GripHorizontal,
  GripVertical,
  MoreVertical,
  Pencil,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { sanitizeRichHtml, type ContainerStyle, type TextStyle } from '@recon/dashboards-core';
import { textStyleToCss } from '../chart/textStyle';
import { ConfirmDialog, RcdIconButton } from '../primitives';

export interface TileFrameProps {
  title: string;
  /** Shows the drag handle + kebab actions (dashboard edit mode). */
  editable: boolean;
  /**
   * Container customization (chart tiles' format.container). hideHeader makes
   * the tile frameless: no header bar; edit mode shows a slim hover drag strip
   * plus a floating kebab so moving/config still work. The remaining fields
   * override the default surface/border/shadow via inline style; absent fields
   * keep the theme defaults. innerTitleHtml renders a sanitized rich block
   * INSIDE the body above the content (both modes, header hidden or not).
   */
  container?: ContainerStyle | null;
  /**
   * format.titleStyle: styles the header-bar title text. Until now the Format
   * panel's "Title" control was a silent no-op on every non-KPI chart — the
   * header hard-coded its classes and never read it.
   */
  titleStyle?: TextStyle | null;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  /**
   * Replaces the built-in kebab menu: the kebab reports its screen position and
   * the caller renders its own menu (slicer tiles' config menu).
   */
  onMenu?: (position: { x: number; y: number }) => void;
  /** Right-click hook on the whole tile (caller must preventDefault). */
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /** Extra header content rendered before the kebab (e.g. a clear-filter x). */
  headerExtra?: ReactNode;
  children: ReactNode;
}

/** Tailwind-equivalent shadow values for the container shadow presets. */
const SHADOWS: Record<NonNullable<ContainerStyle['shadow']>, string> = {
  none: 'none',
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
};

/**
 * Element styling for the sanitized inner-title subset (Tailwind preflight
 * strips default margins/list styles). Literal classes so host builds keep
 * them. Exported for DashboardPrintView's PrintTileBox, which renders the
 * same inner title on paper.
 */
export const INNER_TITLE_CLASSES =
  'shrink-0 pb-1 text-sm leading-snug text-rcd-text [overflow-wrap:anywhere] ' +
  '[&_a]:text-rcd-accent [&_a]:underline ' +
  '[&_h1]:my-0.5 [&_h1]:text-xl [&_h1]:font-semibold ' +
  '[&_h2]:my-0.5 [&_h2]:text-lg [&_h2]:font-semibold ' +
  '[&_h3]:my-0.5 [&_h3]:text-base [&_h3]:font-semibold ' +
  '[&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_ul]:list-disc [&_ul]:pl-5';

/** Inline overrides for the frame; defaults (classes) stay when fields are absent. */
const frameStyleOf = (container: ContainerStyle | null | undefined): CSSProperties => ({
  ...(container?.background ? { backgroundColor: container.background } : null),
  ...(container?.borderColor ? { borderColor: container.borderColor } : null),
  ...(container?.borderWidth !== undefined ? { borderWidth: container.borderWidth } : null),
  ...(container?.borderRadius !== undefined ? { borderRadius: container.borderRadius } : null),
  ...(container?.shadow ? { boxShadow: SHADOWS[container.shadow] } : null),
});

/**
 * Tile chrome: title bar (drag handle in edit mode) + kebab actions. The title
 * bar carries the `rcd-tile-drag-handle` class that DashboardGrid targets, so
 * the kebab and tile content stay clickable while dragging is title-bar only.
 *
 * With container.hideHeader the header bar disappears entirely (frameless
 * look): view mode is clean content; edit mode overlays a slim hover drag
 * strip at the top (same rcd-tile-drag-handle class) and floats the kebab
 * top-right on hover.
 */
export function TileFrame({
  title,
  editable,
  container = null,
  titleStyle = null,
  onEdit,
  onDuplicate,
  onDelete,
  onMenu,
  onContextMenu,
  headerExtra,
  children,
}: TileFrameProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const hideHeader = container?.hideHeader === true;
  const innerTitleHtml = container?.innerTitleHtml ?? '';
  // Second-belt sanitize before dangerouslySetInnerHTML (the format panel
  // already sanitizes on write, same doctrine as text tiles).
  const innerTitleSafe = useMemo(() => sanitizeRichHtml(innerTitleHtml), [innerTitleHtml]);

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

  // One kebab instance, rendered either in the header bar or (frameless edit
  // mode) inside the floating top-right hover wrapper.
  const kebab = editable ? (
    // data-rcd-no-export: interactive chrome, never part of an image export.
    <div className="relative" ref={menuRef} data-rcd-no-export>
      <RcdIconButton
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          if (onMenu) {
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.left, y: rect.bottom + 4 });
          } else {
            setMenuOpen((open) => !open);
          }
        }}
      >
        <MoreVertical size={15} />
      </RcdIconButton>
      {menuOpen && !onMenu && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-36 rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
        >
          <MenuItem
            icon={Pencil}
            label="Edit"
            onClick={() => {
              setMenuOpen(false);
              onEdit?.();
            }}
          />
          <MenuItem
            icon={Copy}
            label="Duplicate"
            onClick={() => {
              setMenuOpen(false);
              onDuplicate?.();
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
  ) : null;

  return (
    <div
      ref={rootRef}
      onContextMenu={onContextMenu}
      style={frameStyleOf(container)}
      className="rcd-card group relative flex h-full flex-col"
    >
      {!hideHeader && (
        <div className="flex items-center border-b border-rcd-border py-1 pl-2.5 pr-1">
          <div
            className={`flex min-w-0 flex-1 items-center gap-1.5 py-0.5 ${
              editable ? 'rcd-tile-drag-handle cursor-move' : ''
            }`}
          >
            {editable && <GripVertical size={14} className="shrink-0 text-rcd-muted" />}
            <span
              className="truncate text-sm font-medium leading-5 text-rcd-text"
              style={textStyleToCss(titleStyle ?? undefined)}
              title={title}
            >
              {title}
            </span>
          </div>

          {headerExtra}

          {kebab}
        </div>
      )}

      {hideHeader && (editable || headerExtra) && (
        <>
          {/* Slim hover drag strip — EDIT MODE ONLY (view mode never needs a
              drag handle). Always in the DOM (react-grid-layout binds by
              class) and always TRANSPARENT: the old solid hover bar covered
              frameless tiles' inner titles. Only the small centered grip pill
              paints on hover; the full-width strip stays an invisible grab
              area at the very top edge. */}
          {editable && (
            <div
              className="rcd-tile-drag-handle absolute inset-x-0 top-0 z-10 flex h-4 cursor-move items-start justify-center"
              title={`Drag to move ${title}`}
              data-rcd-no-export
            >
              <span className="mt-[3px] flex items-center rounded-full border border-rcd-border bg-rcd-surface px-1.5 py-px opacity-0 shadow-sm transition-opacity group-hover:opacity-90">
                <GripHorizontal size={10} className="text-rcd-muted" />
              </span>
            </div>
          )}
          {/* Floating header extras + kebab, above the drag strip so they stay
              clickable. Frameless tiles keep their header-area controls (e.g.
              drill buttons) in this same hover strip in BOTH modes.
              z-40: renderer-internal chrome may legitimately float (table
              sticky headers, zoom clusters) but the TILE's own controls must
              always win paint AND hit-testing over it — a kebab that loses to
              a sticky <th> is an edit affordance users can never click.
              Edit mode keeps the cluster faintly visible at rest instead of
              opacity-0: a frameless tile otherwise shows ZERO evidence it can
              be edited until the user happens to hover the right corner. */}
          <div
            className={`absolute right-1 top-1 z-40 flex items-center gap-0.5 rounded-md bg-rcd-surface shadow-sm transition-opacity group-hover:opacity-100 ${
              editable ? 'opacity-60' : 'opacity-0'
            }`}
            data-rcd-no-export
          >
            {headerExtra}
            {kebab}
          </div>
        </>
      )}

      <div className="flex min-h-0 flex-1 flex-col p-2">
        {innerTitleSafe !== '' && (
          <div className={INNER_TITLE_CLASSES} dangerouslySetInnerHTML={{ __html: innerTitleSafe }} />
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </div>

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
                onDelete?.();
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
