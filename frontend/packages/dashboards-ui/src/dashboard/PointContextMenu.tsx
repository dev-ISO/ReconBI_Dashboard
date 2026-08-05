import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, BellPlus, CornerUpLeft, FileDown, Rows3, Table2, Zap } from 'lucide-react';
import type { FilterClause } from '@recon/dashboards-core';

/** One candidate drillthrough page for the clicked point. */
export interface DrillthroughTarget {
  pageId: string;
  pageName: string;
  /** Non-null = item disabled with this tooltip (point lacks a field value). */
  disabledReason: string | null;
  /** One eq clause per drillthrough field, built from the point. */
  filters: FilterClause[];
  /** Human chip label for the target page, e.g. "Gulf Coast". */
  label: string;
}

/** Drill actions offered for the clicked point (charts with a hierarchy). */
export interface PointDrillActions {
  /** True when a deeper hierarchy level exists below the current one. */
  canDrillDeeper: boolean;
  /** Current drill level (0 = the chart's own axis). */
  level: number;
  /** Formatted label of the clicked point ("Drill down into <label>"). */
  pointLabel: string;
  /** Drills into the clicked value (even when the drill-mode toggle is OFF). */
  onDrillDown: () => void;
  onDrillUp: () => void;
  /** Resets the whole drill state (back to the original chart). */
  onDrillReset: () => void;
}

export interface PointContextMenuProps {
  /** Chart title (aria label). */
  title: string;
  /** Screen coordinates of the right-click; the card clamps itself to the viewport. */
  position: { x: number; y: number };
  /** Drillthrough-enabled pages whose fields all match the chart's dimensions. */
  drillthroughTargets: DrillthroughTarget[];
  /** Drill hierarchy actions for the clicked point; null = no hierarchy. */
  drill?: PointDrillActions | null;
  onDrillthrough: (target: DrillthroughTarget) => void;
  /** "See data" — the tile's current aggregated result in a table dialog. */
  onSeeData?: (() => void) | null;
  /** "See records for <label>" — underlying rows behind the clicked point. */
  seeRecords?: { label: string; onClick: () => void } | null;
  /** "Set alert on this measure…" (charts with ≥1 measure); hidden when absent. */
  onSetAlert?: (() => void) | null;
  onExport: (mode: 'summarized' | 'underlying') => void;
  onClose: () => void;
}

/**
 * Right-click context card for a chart POINT (view mode): "Drill through" to
 * matching pages + "Export data" as CSV. Same pattern as ChartContextMenu: a
 * fixed-position card — NOT a native context menu — closed by outside click or
 * Escape; the caller portals it to document.body so grid-item transforms
 * cannot skew the fixed coordinates.
 */
export function PointContextMenu({
  title,
  position,
  drillthroughTargets,
  drill = null,
  onDrillthrough,
  onSeeData = null,
  seeRecords = null,
  onSetAlert = null,
  onExport,
  onClose,
}: PointContextMenuProps) {
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

  return (
    <div
      ref={cardRef}
      role="menu"
      aria-label={`Point actions for ${title}`}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 flex w-52 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-[var(--rcd-shadow-2)]"
    >
      {(onSeeData || seeRecords) && (
        <>
          {onSeeData && (
            <ActionItem
              icon={<Table2 size={14} />}
              onClick={() => {
                onSeeData();
                onClose();
              }}
            >
              See data
            </ActionItem>
          )}
          {seeRecords && (
            <ActionItem
              icon={<Rows3 size={14} />}
              onClick={() => {
                seeRecords.onClick();
                onClose();
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                See records for <span className="font-medium">{seeRecords.label}</span>
              </span>
            </ActionItem>
          )}
          <div className="my-1 border-t border-rcd-border" />
        </>
      )}

      {drill && (drill.canDrillDeeper || drill.level > 0) && (
        <>
          <p className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
            Drill
          </p>
          {drill.canDrillDeeper && (
            <ActionItem
              icon={<ArrowDown size={14} />}
              onClick={() => {
                drill.onDrillDown();
                onClose();
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                Drill down into <span className="font-medium">{drill.pointLabel}</span>
              </span>
            </ActionItem>
          )}
          {drill.level > 0 && (
            <>
              <ActionItem
                icon={<ArrowUp size={14} />}
                onClick={() => {
                  drill.onDrillUp();
                  onClose();
                }}
              >
                Drill up
              </ActionItem>
              <ActionItem
                icon={<CornerUpLeft size={14} />}
                onClick={() => {
                  drill.onDrillReset();
                  onClose();
                }}
              >
                Back to top
              </ActionItem>
            </>
          )}
          <div className="my-1 border-t border-rcd-border" />
        </>
      )}

      {drillthroughTargets.length > 0 && (
        <>
          <p className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
            Drill through
          </p>
          {drillthroughTargets.map((target) => (
            <button
              key={target.pageId}
              type="button"
              role="menuitem"
              disabled={target.disabledReason !== null}
              title={target.disabledReason ?? `Drill through to ${target.pageName}`}
              onClick={() => {
                onDrillthrough(target);
                onClose();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
            >
              <Zap size={14} />
              <span className="min-w-0 flex-1 truncate">{target.pageName}</span>
            </button>
          ))}
          <div className="my-1 border-t border-rcd-border" />
        </>
      )}

      <p className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
        Export data
      </p>
      <MenuItem
        label="Summarized (CSV)"
        onClick={() => {
          onExport('summarized');
          onClose();
        }}
      />
      <MenuItem
        label="Underlying rows (CSV)"
        onClick={() => {
          onExport('underlying');
          onClose();
        }}
      />

      {onSetAlert && (
        <>
          <div className="my-1 border-t border-rcd-border" />
          <ActionItem
            icon={<BellPlus size={14} />}
            onClick={() => {
              onSetAlert();
              onClose();
            }}
          >
            Set alert on this measure…
          </ActionItem>
        </>
      )}
    </div>
  );
}

function ActionItem({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
    >
      {icon}
      {children}
    </button>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rcd-text hover:bg-black/5 dark:hover:bg-white/10"
    >
      <FileDown size={14} />
      {label}
    </button>
  );
}
