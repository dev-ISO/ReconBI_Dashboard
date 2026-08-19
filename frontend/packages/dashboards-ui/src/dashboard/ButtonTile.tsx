import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2, Unlink } from 'lucide-react';
import { type ButtonTileSpec } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog } from '../primitives';
import { ButtonTileDialog } from './ButtonTileDialog';
import { ButtonVisual, buttonLabelText } from './ButtonVisual';
import { TileBackgroundSwatches } from './TileBackgroundSwatches';
import { TileFrame } from './TileFrame';

// The shared button rendering was extracted to ButtonVisual.tsx for the
// button-group wave; re-exported so existing imports (MobileLayout's row
// labels) keep working unchanged.
export { ButtonVisual, buttonLabelText, type ButtonVisualSpec } from './ButtonVisual';

export interface ButtonTileProps {
  tileId: string;
  spec: ButtonTileSpec;
  /** Edit mode: framed with config card; view mode renders the live button. */
  editable: boolean;
  /** The dashboard's pages — target resolution (broken-link badge) + the edit dialog's picker. */
  pages: { id: string; name: string }[];
}

/** Single-tile body: the shared visual centered in the tile (or filling it). */
function ButtonTileContent({
  spec,
  onActivate,
  disabled,
}: {
  spec: ButtonTileSpec;
  onActivate?: () => void;
  disabled?: boolean;
}) {
  const fullSize = spec.fullSize === true;
  return (
    <div
      className={`flex h-full items-center justify-center overflow-hidden ${fullSize ? '' : 'p-1'}`}
    >
      <ButtonVisual spec={spec} fullSize={fullSize} onActivate={onActivate} disabled={disabled} />
    </div>
  );
}

/**
 * Navigation-button tile. View mode: frameless live button — click switches to
 * the target page via setActivePage (which no-ops on dead ids, so a stale
 * target is inert). Edit mode: standard TileFrame (title-bar dragging), the
 * SAME live button (B5 — left-click navigates in both modes; the button body
 * is additionally a grid drag handle, and the drag's closing click is
 * swallowed inside ButtonVisual), a "broken link" badge when the target page
 * no longer exists (resolved against `pages` every render), and the kebab /
 * right-click config card (edit dialog, background, remove).
 */
export function ButtonTile({ tileId, spec, editable, pages }: ButtonTileProps) {
  const runtime = useRuntime();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const targetExists = pages.some((page) => page.id === spec.targetPageId);
  const activate = targetExists
    ? () => runtime.dashboards.setActivePage(spec.targetPageId)
    : undefined;

  if (!editable) {
    return <ButtonTileContent spec={spec} disabled={!targetExists} onActivate={activate} />;
  }

  return (
    <TileFrame
      title={buttonLabelText(spec) || 'Button'}
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
        {/* B5: the whole content doubles as an RGL drag handle in edit mode so
            click-and-drag MOVES the tile from anywhere on the button, while a
            plain left-click still navigates (ButtonVisual swallows the click
            that concludes a drag). */}
        <div className="rcd-tile-drag-handle h-full">
          <ButtonTileContent spec={spec} disabled={!targetExists} onActivate={activate} />
        </div>
        {!targetExists && (
          <span
            className="absolute left-1 top-1 z-10 inline-flex items-center gap-1 rounded-md border border-[var(--rcd-status-warn)] bg-rcd-surface px-1.5 py-0.5 text-[10px] font-medium text-[var(--rcd-status-warn)]"
            title="The page this button navigated to was deleted — pick a new target in Edit button."
          >
            <Unlink size={11} aria-hidden />
            Broken link
          </span>
        )}
      </div>

      {menuPos &&
        // Portal past the transformed grid item: position:fixed inside a
        // transformed ancestor would resolve against the tile, not the viewport.
        createPortal(
          <div className="rcd-root bg-transparent">
            <ButtonTileConfigMenu
              tileId={tileId}
              spec={spec}
              position={menuPos}
              onEditButton={() => {
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
            <ButtonTileDialog
              open
              title="Edit button"
              initial={spec}
              pages={pages}
              onClose={() => setEditOpen(false)}
              onSave={(next) => {
                runtime.dashboards.updateButtonTile(tileId, next);
                setEditOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </TileFrame>
  );
}

/* ---------------------------------------------------------- config card */

/**
 * Right-click / kebab configuration card for a button tile (edit mode only).
 * Fixed-position card (NOT a native context menu) closed by outside click or
 * Escape; the caller portals it to document.body.
 */
function ButtonTileConfigMenu({
  tileId,
  spec,
  position,
  onEditButton,
  onClose,
}: {
  tileId: string;
  spec: ButtonTileSpec;
  position: { x: number; y: number };
  onEditButton: () => void;
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
        aria-label="Configure button tile"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed z-50 flex w-56 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
      >
        <button
          type="button"
          role="menuitem"
          onClick={onEditButton}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Pencil size={14} />
          Edit button…
        </button>
        {/* B5 discoverability: edit-mode clicks follow the link. */}
        <p className="px-3 pb-1 pt-0.5 text-[11px] leading-snug text-rcd-muted">
          Click follows the button - right-click to edit.
        </p>

        <Divider />
        <SectionLabel>Background</SectionLabel>
        <TileBackgroundSwatches
          value={spec.background ?? null}
          onChange={(background) => runtime.dashboards.updateButtonTile(tileId, { background })}
        />

        <Divider />
        <button
          type="button"
          role="menuitem"
          onClick={() => setConfirmRemove(true)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Trash2 size={14} />
          Remove button
        </button>
      </div>

      <ConfirmDialog
        title="Remove button"
        message="Remove this button tile? It is removed from the dashboard (kept until you save)."
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
