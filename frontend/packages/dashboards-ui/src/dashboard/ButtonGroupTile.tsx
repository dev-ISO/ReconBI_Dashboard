import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2, Unlink } from 'lucide-react';
import { type ButtonGroupTileSpec } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog } from '../primitives';
import { ButtonGroupTileDialog } from './ButtonGroupTileDialog';
import { ButtonVisual, buttonLabelText } from './ButtonVisual';
import { TileBackgroundSwatches } from './TileBackgroundSwatches';
import { TileFrame } from './TileFrame';

export interface ButtonGroupTileProps {
  tileId: string;
  spec: ButtonGroupTileSpec;
  /** Edit mode: framed with config card; view mode renders the live buttons. */
  editable: boolean;
  /** The dashboard's pages — target resolution + the edit dialog's pickers. */
  pages: { id: string; name: string }[];
}

const ALIGN_ITEMS: Record<ButtonGroupTileSpec['align'], CSSProperties['alignItems']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

/**
 * Button-group tile (B3). View mode: frameless flex container of live
 * navigation buttons. Edit mode: standard TileFrame; the buttons stay LIVE
 * (B5 — left-click navigates in both modes, the whole content doubles as a
 * grid drag handle, and ButtonVisual swallows the click that concludes a
 * drag); right-click/kebab opens the config card (Edit buttons dialog,
 * container background, remove). Buttons whose target page no longer exists
 * render disabled, and edit mode badges the tile.
 */
export function ButtonGroupTile({ tileId, spec, editable, pages }: ButtonGroupTileProps) {
  const runtime = useRuntime();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const pageExists = (id: string) => pages.some((page) => page.id === id);
  const brokenCount = spec.buttons.filter((button) => !pageExists(button.targetPageId)).length;

  // setActivePage no-ops on dead ids, so a stale target is inert either way;
  // disabled chrome comes from the per-button render below.
  const activate = (targetPageId: string) => {
    if (pageExists(targetPageId)) runtime.dashboards.setActivePage(targetPageId);
  };

  const content = (
    <div
      className="h-full overflow-hidden p-1"
      style={{
        display: 'flex',
        flexDirection: spec.direction === 'column' ? 'column' : 'row',
        flexWrap: spec.wrap ? 'wrap' : 'nowrap',
        gap: spec.gap,
        alignItems: ALIGN_ITEMS[spec.align] ?? 'center',
        alignContent: 'flex-start',
        ...(spec.background ? { backgroundColor: spec.background } : null),
      }}
    >
      {/* align 'stretch' fills the cross axis natively (the buttons' cross
          size is auto), so no fullSize class is needed per button. */}
      {spec.buttons.map((button) => (
        <ButtonVisual
          key={button.id}
          spec={button}
          disabled={!pageExists(button.targetPageId)}
          onActivate={
            pageExists(button.targetPageId) ? () => activate(button.targetPageId) : undefined
          }
        />
      ))}
    </div>
  );

  const body = <WholeButtonClipper spec={spec}>{content}</WholeButtonClipper>;

  if (!editable) {
    return body;
  }

  return (
    <TileFrame
      title="Button group"
      editable
      onMenu={(position) => setMenuPos(position)}
      onContextMenu={(event) => {
        // Config card instead of the native browser menu.
        event.preventDefault();
        event.stopPropagation();
        setMenuPos({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="relative h-full">
        {/* B5: same as single buttons — the content is a grid drag handle so
            click-and-drag MOVES the tile while a plain click navigates. */}
        <div className="rcd-tile-drag-handle h-full">{body}</div>
        {brokenCount > 0 && (
          <span
            className="absolute left-1 top-1 z-10 inline-flex items-center gap-1 rounded-md border border-[var(--rcd-status-warn)] bg-rcd-surface px-1.5 py-0.5 text-[10px] font-medium text-[var(--rcd-status-warn)]"
            title="A page this group navigated to was deleted — pick new targets in Edit buttons."
          >
            <Unlink size={11} aria-hidden />
            {brokenCount === 1 ? 'Broken link' : `${brokenCount} broken links`}
          </span>
        )}
      </div>

      {menuPos &&
        // Portal past the transformed grid item: position:fixed inside a
        // transformed ancestor would resolve against the tile, not the viewport.
        createPortal(
          <div className="rcd-root bg-transparent">
            <ButtonGroupConfigMenu
              tileId={tileId}
              spec={spec}
              position={menuPos}
              onEditButtons={() => {
                setMenuPos(null);
                setEditOpen(true);
              }}
              onClose={() => setMenuPos(null)}
            />
          </div>,
          document.body,
        )}

      {editOpen &&
        // Same portal reasoning as the config card: the dialog overlay is
        // position:fixed and must escape the transformed grid item.
        createPortal(
          <div className="rcd-root bg-transparent">
            <ButtonGroupTileDialog
              open
              title="Edit button group"
              initial={spec}
              pages={pages}
              onClose={() => setEditOpen(false)}
              onSave={(next) => {
                runtime.dashboards.updateButtonGroupTile(tileId, next);
                setEditOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </TileFrame>
  );
}

/**
 * Whole-button clipping (B4): hides any DIRECT BUTTON of the flex container
 * that does not fully fit the container's box, so undersize clips complete
 * buttons instead of slicing one in half. visibility (not display) keeps the
 * flex layout stable, and a ResizeObserver re-evaluates on every size change.
 */
function WholeButtonClipper({
  spec,
  children,
}: {
  spec: ButtonGroupTileSpec;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const box = host?.firstElementChild;
    if (!host || !(box instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    const clip = () => {
      const bounds = host.getBoundingClientRect();
      for (const child of Array.from(box.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const rect = child.getBoundingClientRect();
        // 1px slack absorbs subpixel rounding under fit-to-page scaling.
        const fits =
          rect.right <= bounds.right + 1 &&
          rect.bottom <= bounds.bottom + 1 &&
          rect.left >= bounds.left - 1 &&
          rect.top >= bounds.top - 1;
        child.style.visibility = fits ? '' : 'hidden';
      }
    };
    const observer = new ResizeObserver(clip);
    observer.observe(host);
    clip();
    return () => observer.disconnect();
    // Re-clip when the spec changes shape (buttons added/removed, packing).
  }, [spec]);

  return (
    <div ref={hostRef} className="h-full overflow-hidden">
      {children}
    </div>
  );
}

/* ---------------------------------------------------------- config card */

/**
 * Right-click / kebab configuration card for a button-group tile (edit mode
 * only) — the single-button card's pattern: fixed-position card closed by
 * outside click or Escape; the caller portals it to document.body.
 */
function ButtonGroupConfigMenu({
  tileId,
  spec,
  position,
  onEditButtons,
  onClose,
}: {
  tileId: string;
  spec: ButtonGroupTileSpec;
  position: { x: number; y: number };
  onEditButtons: () => void;
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [confirmRemove, setConfirmRemove] = useState(false);

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

  // Outside click / Escape closes (the remove confirm owns the keyboard then).
  useEffect(() => {
    if (confirmRemove) return;
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
  }, [onClose, confirmRemove]);

  return (
    <>
      <div
        ref={cardRef}
        role="menu"
        aria-label="Configure button group tile"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed z-50 flex w-56 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
      >
        <button
          type="button"
          role="menuitem"
          onClick={onEditButtons}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Pencil size={14} />
          Edit buttons…
        </button>
        {/* B5 discoverability: edit-mode clicks follow the link. */}
        <p className="px-3 pb-1 pt-0.5 text-[11px] leading-snug text-rcd-muted">
          Click follows the button - right-click to edit.
        </p>

        <Divider />
        <SectionLabel>Background</SectionLabel>
        <TileBackgroundSwatches
          value={spec.background ?? null}
          onChange={(background) =>
            runtime.dashboards.updateButtonGroupTile(tileId, { background })
          }
        />

        <Divider />
        <button
          type="button"
          role="menuitem"
          onClick={() => setConfirmRemove(true)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Trash2 size={14} />
          Remove button group
        </button>
      </div>

      <ConfirmDialog
        title="Remove button group"
        message="Remove this button group tile? It is removed from the dashboard (kept until you save)."
        confirmLabel="Remove"
        danger
        open={confirmRemove}
        onConfirm={() => {
          setConfirmRemove(false);
          runtime.dashboards.removeTile(tileId);
          onClose();
        }}
        onCancel={() => {
          setConfirmRemove(false);
          onClose();
        }}
      />
    </>
  );
}

/** Frame title helper: the group's labels joined (config card / a11y). */
export const buttonGroupLabelText = (spec: ButtonGroupTileSpec): string =>
  spec.buttons
    .map((button) => buttonLabelText(button))
    .filter((label) => label !== '')
    .join(' · ');

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
      {children}
    </p>
  );
}

function Divider() {
  return <div className="my-1 border-t border-rcd-border" />;
}
