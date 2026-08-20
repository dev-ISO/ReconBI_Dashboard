import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2, Unlink } from 'lucide-react';
import { type ButtonGroupTileSpec, type ContainerStyle } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog } from '../primitives';
import { ButtonGroupTileDialog } from './ButtonGroupTileDialog';
import { ButtonVisual, buttonLabelText } from './ButtonVisual';
import {
  GROUP_ALIGN_ITEMS,
  GROUP_JUSTIFY_CONTENT,
  groupAlignContent,
  type ButtonGroupJustify,
} from './buttonLayout';
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

/** Fallback frame title (mirrors TextTileSpec.title's "Text"). */
export const DEFAULT_GROUP_TITLE = 'Button group';

/** The group's frame title: authored, else the generic fallback. */
export const buttonGroupTitle = (spec: ButtonGroupTileSpec): string =>
  spec.title?.trim() || DEFAULT_GROUP_TITLE;

/** True when the tile shows the standard header bar (A1 opt-in). */
export const buttonGroupFramed = (spec: ButtonGroupTileSpec): boolean =>
  spec.container != null && spec.container.hideHeader !== true;

/**
 * The ContainerStyle handed to TileFrame (A1).
 *
 * ABSENT/frameless containers get the chrome NEUTRALIZED — transparent fill,
 * zero border, no shadow — because TileFrame always paints `.rcd-card`, and a
 * group authored before 0.14.1 rendered with no card at all in view mode.
 * Explicit values (a hand-authored border, say) still win. `spec.background`
 * is the ONE writer for the fill: container.background is never authored and
 * is overridden here, so the two can never disagree (A1's duplicate).
 */
export const groupContainerStyle = (spec: ButtonGroupTileSpec): ContainerStyle => {
  const container = spec.container ?? null;
  const framed = buttonGroupFramed(spec);
  return {
    ...container,
    hideHeader: !framed,
    ...(framed
      ? null
      : {
          borderWidth: container?.borderWidth ?? 0,
          shadow: container?.shadow ?? 'none',
        }),
    background: spec.background ?? (framed ? (container?.background ?? null) : 'transparent'),
  };
};

/**
 * True when the group's content should cancel TileFrame's body padding: a
 * frameless container with NO visible chrome of its own (no border, no inner
 * title to sit under) is exactly the pre-0.14.1 look, and it must stay
 * edge-to-edge so a 1-row-high tile can still show a button.
 */
export const containerBleeds = (container: ContainerStyle): boolean =>
  container.hideHeader === true &&
  (container.borderWidth ?? 0) === 0 &&
  (container.innerTitleHtml ?? '') === '';

/**
 * Button-group tile (B3). Renders the standard TileFrame in BOTH modes
 * (0.14.1/A1, modelled on SlicerTile) — the container is an authored choice
 * now, defaulting to the legacy frameless look. The buttons stay LIVE
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

  const container = groupContainerStyle(spec);
  const bleed = containerBleeds(container);
  const body = (
    <WholeButtonClipper spec={spec}>
      <ButtonGroupContent
        spec={spec}
        onActivate={(targetPageId) => activate(targetPageId)}
        isBroken={(targetPageId) => !pageExists(targetPageId)}
      />
    </WholeButtonClipper>
  );

  return (
    <TileFrame
      title={buttonGroupTitle(spec)}
      editable={editable}
      container={container}
      onMenu={editable ? (position) => setMenuPos(position) : undefined}
      onContextMenu={
        editable
          ? (event) => {
              // Config card instead of the native browser menu.
              event.preventDefault();
              event.stopPropagation();
              setMenuPos({ x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
      {/* BLEED: TileFrame's body padding (p-2) is fixed, but a frameless group
          rendered edge-to-edge before 0.14.1 and its minH:1 floor only makes
          sense without it — so a chrome-less frameless container cancels the
          padding with -m-2 and keeps its own p-1. Framed (or bordered, or
          inner-titled) containers keep the standard body padding. */}
      <div className={`relative h-full ${bleed ? '-m-2' : ''}`}>
        {/* B5: same as single buttons — the content is a grid drag handle so
            click-and-drag MOVES the tile while a plain click navigates. */}
        <div className={`h-full ${editable ? 'rcd-tile-drag-handle' : ''}`}>{body}</div>
        {editable && brokenCount > 0 && (
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
 * The group's packed buttons — shared by the live tile and the print sheet
 * (which passes no callbacks, so every button renders inert).
 *
 * PACKING (A2): `direction` picks the main axis, `justify` distributes along
 * it (this was NEVER set before 0.14.1, which is why every row was
 * permanently left-packed), `align` is the cross axis, and alignContent now
 * follows `align` so wrapped rows stop hugging the top. equalWidth swaps the
 * flex row for the shared auto-fill grid so every button gets one width.
 */
export function ButtonGroupContent({
  spec,
  onActivate,
  isBroken,
}: {
  spec: ButtonGroupTileSpec;
  /** Navigation callback; absent renders inert buttons (print/preview). */
  onActivate?: (targetPageId: string) => void;
  /** Broken-target predicate; absent means "every target resolves". */
  isBroken?: (targetPageId: string) => boolean;
}) {
  const size = spec.size ?? 'md';
  const justify: ButtonGroupJustify = spec.justify ?? 'left';
  const column = spec.direction === 'column';
  const equalWidth = spec.equalWidth === true;
  // Equal width on a ROW is the shared auto-fill grid (uniform tracks on every
  // wrapped line); on a COLUMN it is simply a full-width cross-axis stretch.
  const grid = equalWidth && !column;

  const style: CSSProperties = {
    display: grid ? 'grid' : 'flex',
    gap: spec.gap,
    ...(grid
      ? {
          gridTemplateColumns: 'repeat(auto-fill, minmax(6rem, 1fr))',
          justifyItems: 'stretch',
          alignItems: GROUP_ALIGN_ITEMS[spec.align] ?? 'center',
          alignContent: groupAlignContent(spec.align),
          justifyContent: GROUP_JUSTIFY_CONTENT[justify],
        }
      : {
          flexDirection: column ? 'column' : 'row',
          flexWrap: spec.wrap ? 'wrap' : 'nowrap',
          justifyContent: GROUP_JUSTIFY_CONTENT[justify],
          alignItems:
            equalWidth && column ? 'stretch' : (GROUP_ALIGN_ITEMS[spec.align] ?? 'center'),
          alignContent: groupAlignContent(spec.align),
        }),
  };

  return (
    <div className="h-full overflow-hidden p-1" style={style}>
      {/* align 'stretch' fills the cross axis natively (the buttons' cross
          size is auto), so no fullSize class is needed per button. */}
      {spec.buttons.map((button) => {
        const broken = isBroken?.(button.targetPageId) === true;
        return (
          <ButtonVisual
            key={button.id}
            spec={button}
            size={size}
            variant={spec.variant ?? 'default'}
            stretch={grid}
            disabled={broken}
            onActivate={onActivate && !broken ? () => onActivate(button.targetPageId) : undefined}
          />
        );
      })}
    </div>
  );
}

/**
 * Whole-button clipping (B4): hides any DIRECT BUTTON of the flex container
 * that does not fully fit the container's box, so undersize clips complete
 * buttons instead of slicing one in half. visibility (not display) keeps the
 * flex layout stable, and a ResizeObserver re-evaluates on every size change.
 *
 * 0.14.1 (A3): the minimum-size floors dropped to content-aware values, so an
 * author CAN now size a group below its buttons. Hiding every button would
 * leave an empty container that looks broken and offers no way back, so the
 * FIRST button always renders (clipped by the host's overflow instead of
 * vanishing) and the hidden remainder is announced by a "+N more" chip.
 */
function WholeButtonClipper({
  spec,
  children,
}: {
  spec: ButtonGroupTileSpec;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hiddenCount, setHiddenCount] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    const box = host?.firstElementChild;
    if (!host || !(box instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    const clip = () => {
      const bounds = host.getBoundingClientRect();
      let hidden = 0;
      Array.from(box.children).forEach((child, index) => {
        if (!(child instanceof HTMLElement)) return;
        const rect = child.getBoundingClientRect();
        // 1px slack absorbs subpixel rounding under fit-to-page scaling.
        const fits =
          rect.right <= bounds.right + 1 &&
          rect.bottom <= bounds.bottom + 1 &&
          rect.left >= bounds.left - 1 &&
          rect.top >= bounds.top - 1;
        // NEVER empty the container: button 0 stays visible whatever happens.
        const show = fits || index === 0;
        child.style.visibility = show ? '' : 'hidden';
        if (!show) hidden += 1;
      });
      setHiddenCount((previous) => (previous === hidden ? previous : hidden));
    };
    const observer = new ResizeObserver(clip);
    observer.observe(host);
    clip();
    return () => observer.disconnect();
    // Re-clip when the spec changes shape (buttons added/removed, packing).
  }, [spec]);

  return (
    <div ref={hostRef} className="relative h-full overflow-hidden">
      {children}
      {hiddenCount > 0 && (
        <span
          // Absolutely positioned so announcing the overflow never changes the
          // measurement it is reporting on (no ResizeObserver feedback loop).
          className="pointer-events-none absolute bottom-0.5 right-0.5 z-10 rounded border border-rcd-border bg-rcd-surface px-1 text-[10px] font-medium leading-4 text-rcd-muted"
          title={`${hiddenCount} more ${
            hiddenCount === 1 ? 'button does' : 'buttons do'
          } not fit — make the tile bigger to show ${hiddenCount === 1 ? 'it' : 'them'}.`}
        >
          +{hiddenCount} more
        </span>
      )}
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
        {/* A4(i): this paints the CONTAINER, not the buttons — the dialog's
            identical-looking control ("Button fill") is the one that changes a
            button's color. The two used to share the word "Background". */}
        <SectionLabel>Container background</SectionLabel>
        <p className="px-3 pb-1 text-[11px] leading-snug text-rcd-muted">
          Fills the tile behind the buttons. Button colors live in Edit buttons.
        </p>
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
