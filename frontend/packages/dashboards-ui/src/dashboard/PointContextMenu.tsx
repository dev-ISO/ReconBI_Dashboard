import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileDown, Zap } from 'lucide-react';
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

export interface PointContextMenuProps {
  /** Chart title (aria label). */
  title: string;
  /** Screen coordinates of the right-click; the card clamps itself to the viewport. */
  position: { x: number; y: number };
  /** Drillthrough-enabled pages whose fields all match the chart's dimensions. */
  drillthroughTargets: DrillthroughTarget[];
  onDrillthrough: (target: DrillthroughTarget) => void;
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
  onDrillthrough,
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
      className="fixed z-50 flex w-52 flex-col rounded-md border border-rcd-border bg-rcd-surface py-1 shadow-lg"
    >
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
    </div>
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
