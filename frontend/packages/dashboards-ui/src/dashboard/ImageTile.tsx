import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ImageOff, RefreshCw, Trash2 } from 'lucide-react';
import type { ImageTileSpec } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog } from '../primitives';
import { ImageTileDialog } from './ImageTileDialog';
import { TileBackgroundSwatches } from './TileBackgroundSwatches';
import { TileFrame } from './TileFrame';

export interface ImageTileProps {
  tileId: string;
  spec: ImageTileSpec;
  /** Edit mode: framed with config card; view mode renders the frameless image. */
  editable: boolean;
}

/**
 * Presentational image body (view mode + reusable by the print view). Renders
 * the broken-image placeholder when the src is empty or fails to load.
 */
export function ImageTileContent({ spec }: { spec: ImageTileSpec }) {
  const [failed, setFailed] = useState(false);

  // A changed source gets a fresh chance to load.
  useEffect(() => {
    setFailed(false);
  }, [spec.src]);

  const background = spec.background ? { backgroundColor: spec.background } : undefined;

  if (spec.src === '' || failed) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-rcd-border text-rcd-muted"
        style={background}
      >
        <ImageOff size={20} />
        <span className="text-xs">Image unavailable</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden rounded-lg" style={background}>
      <img
        src={spec.src}
        alt={spec.alt ?? ''}
        draggable={false}
        onError={() => setFailed(true)}
        className="h-full w-full"
        style={{ objectFit: spec.fit }}
      />
    </div>
  );
}

/**
 * Image tile. View mode: frameless image (no TileFrame chrome). Edit mode:
 * standard TileFrame (title-bar dragging); the kebab / right-click opens the
 * config card (change image, fit, background, remove).
 */
export function ImageTile({ tileId, spec, editable }: ImageTileProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const runtime = useRuntime();

  if (!editable) return <ImageTileContent spec={spec} />;

  return (
    <TileFrame
      title={spec.alt?.trim() || 'Image'}
      editable
      onMenu={(position) => setMenuPos(position)}
      onContextMenu={(event) => {
        // Config card instead of the native browser menu.
        event.preventDefault();
        event.stopPropagation();
        setMenuPos({ x: event.clientX, y: event.clientY });
      }}
    >
      <ImageTileContent spec={spec} />

      {menuPos &&
        // Portal past the transformed grid item: position:fixed inside a
        // transformed ancestor would resolve against the tile, not the viewport.
        createPortal(
          <div className="rcd-root bg-transparent">
            <ImageTileConfigMenu
              tileId={tileId}
              spec={spec}
              position={menuPos}
              onChangeImage={() => {
                setMenuPos(null);
                setChangeOpen(true);
              }}
              onClose={() => setMenuPos(null)}
            />
          </div>,
          document.body,
        )}

      {changeOpen &&
        // Same portal reasoning as the config card: the dialog overlay is
        // position:fixed and must escape the transformed grid item.
        createPortal(
          <div className="rcd-root bg-transparent">
            <ImageTileDialog
              open
              title="Change image"
              initial={spec}
              onClose={() => setChangeOpen(false)}
              onSave={(next) => {
                runtime.dashboards.updateImageTile(tileId, next);
                setChangeOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </TileFrame>
  );
}

/* ---------------------------------------------------------- config card */

const FIT_OPTIONS: { value: ImageTileSpec['fit']; label: string }[] = [
  { value: 'contain', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'fill', label: 'Fill' },
];

/**
 * Right-click / kebab configuration card for an image tile (edit mode only).
 * Fixed-position card (NOT a native context menu) closed by outside click or
 * Escape; the caller portals it to document.body.
 */
function ImageTileConfigMenu({
  tileId,
  spec,
  position,
  onChangeImage,
  onClose,
}: {
  tileId: string;
  spec: ImageTileSpec;
  position: { x: number; y: number };
  onChangeImage: () => void;
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
        aria-label="Configure image tile"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed z-50 flex w-56 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-xl"
      >
        <button
          type="button"
          role="menuitem"
          onClick={onChangeImage}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
        >
          <RefreshCw size={14} />
          Change image…
        </button>

        <Divider />
        <SectionLabel>Fit</SectionLabel>
        {FIT_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
          >
            <input
              type="radio"
              name={`rcd-image-fit-${tileId}`}
              className="accent-[var(--rcd-accent)]"
              checked={spec.fit === option.value}
              onChange={() => runtime.dashboards.updateImageTile(tileId, { fit: option.value })}
            />
            {option.label}
          </label>
        ))}

        <Divider />
        <SectionLabel>Background</SectionLabel>
        <TileBackgroundSwatches
          value={spec.background ?? null}
          onChange={(background) => runtime.dashboards.updateImageTile(tileId, { background })}
        />

        <Divider />
        <button
          type="button"
          role="menuitem"
          onClick={() => setConfirmRemove(true)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--rcd-status-critical)] hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Trash2 size={14} />
          Remove image
        </button>
      </div>

      <ConfirmDialog
        title="Remove image"
        message="Remove this image tile? It is removed from the dashboard (kept until you save)."
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
