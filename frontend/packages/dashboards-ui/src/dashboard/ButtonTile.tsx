import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2, Unlink } from 'lucide-react';
import { sanitizeRichHtml, type ButtonTileSpec } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog } from '../primitives';
import { ButtonTileDialog } from './ButtonTileDialog';
import { TileBackgroundSwatches } from './TileBackgroundSwatches';
import { TileFrame } from './TileFrame';

export interface ButtonTileProps {
  tileId: string;
  spec: ButtonTileSpec;
  /** Edit mode: framed with config card; view mode renders the live button. */
  editable: boolean;
  /** The dashboard's pages — target resolution (broken-link badge) + the edit dialog's picker. */
  pages: { id: string; name: string }[];
}

/** Plain text of the rich label (tags stripped), for frame titles/aria. */
export const buttonLabelText = (spec: ButtonTileSpec): string =>
  spec.html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Element styling for the sanitized label subset (paragraph margins collapse
 *  so short labels center cleanly inside the button chrome). */
const LABEL_CLASSES =
  'text-sm leading-snug [overflow-wrap:anywhere] [&_p]:my-0 ' +
  '[&_h1]:my-0 [&_h1]:text-xl [&_h1]:font-semibold ' +
  '[&_h2]:my-0 [&_h2]:text-lg [&_h2]:font-semibold ' +
  '[&_h3]:my-0 [&_h3]:text-base [&_h3]:font-semibold';

/**
 * Presentational button body shared by both modes. Rendering a real <button>
 * keeps focus/keyboard semantics; the rich LABEL rides inside it (sanitized
 * again as the usual second belt — this is a static render, never a live
 * contentEditable, so dangerouslySetInnerHTML is fine here).
 */
function ButtonTileContent({
  spec,
  onActivate,
  disabled,
}: {
  spec: ButtonTileSpec;
  /** View-mode navigation; absent in edit mode (clicks select the tile). */
  onActivate?: () => void;
  /** Broken target in view mode: inert, no pointer affordance. */
  disabled?: boolean;
}) {
  const html = useMemo(() => sanitizeRichHtml(spec.html), [spec.html]);
  const fullSize = spec.fullSize === true;
  return (
    <div className={`flex h-full items-center justify-center ${fullSize ? '' : 'p-1'}`}>
      <button
        type="button"
        // Edit mode renders the chrome but the CLICK belongs to tile selection —
        // tabIndex -1 keeps the preview out of the tab order there.
        tabIndex={onActivate ? 0 : -1}
        aria-label={buttonLabelText(spec) || 'Button'}
        disabled={disabled}
        onClick={onActivate}
        style={{
          borderRadius: spec.radius ?? 8,
          ...(spec.background ? { backgroundColor: spec.background } : null),
        }}
        className={`${fullSize ? 'h-full w-full' : 'max-h-full max-w-full px-4 py-1.5'} ${
          spec.background
            ? 'border border-transparent text-rcd-text'
            : 'border border-rcd-border bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-1)]'
        } ${disabled ? 'cursor-default opacity-60' : onActivate ? 'transition-[filter] hover:brightness-95 active:brightness-90' : 'cursor-default'} overflow-hidden`}
      >
        <span className={LABEL_CLASSES} dangerouslySetInnerHTML={{ __html: html || '<p>Button</p>' }} />
      </button>
    </div>
  );
}

/**
 * Navigation-button tile. View mode: frameless live button — click switches to
 * the target page via setActivePage (which no-ops on dead ids, so a stale
 * target is inert). Edit mode: standard TileFrame (title-bar dragging), a
 * non-navigating preview with a "broken link" badge when the target page no
 * longer exists (resolved against `pages` every render), and the kebab /
 * right-click config card (edit dialog, background, remove).
 */
export function ButtonTile({ tileId, spec, editable, pages }: ButtonTileProps) {
  const runtime = useRuntime();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const targetExists = pages.some((page) => page.id === spec.targetPageId);

  if (!editable) {
    return (
      <ButtonTileContent
        spec={spec}
        disabled={!targetExists}
        onActivate={
          targetExists ? () => runtime.dashboards.setActivePage(spec.targetPageId) : undefined
        }
      />
    );
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
        <ButtonTileContent spec={spec} />
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
