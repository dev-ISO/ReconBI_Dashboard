import type { CSSProperties } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { Cardinality } from '@recon/dashboards-core';

export interface RelationshipEdgeData extends Record<string, unknown> {
  cardinality: Cardinality;
  isActive: boolean;
  /** Stable per-relationship hue, shared with the endpoint column markers. */
  color: string;
  /** Opens the relationship editor dialog (chip click — the ONLY dialog trigger). */
  onOpenEditor: (id: string) => void;
  /** Opens the relationship context menu at screen coordinates (chip right-click). */
  onOpenMenu: (id: string, x: number, y: number) => void;
}

export type RelationshipEdgeType = Edge<RelationshipEdgeData, 'rcdRelationship'>;

/** Distance from the handle to the endpoint cardinality glyph, along the line. */
const GLYPH_OFFSET = 18;

/** Handles only ever sit on the left/right node faces; offset outward from the node. */
const glyphX = (x: number, position: Position): number =>
  position === Position.Left ? x - GLYPH_OFFSET : x + GLYPH_OFFSET;

/**
 * Custom edge for a real (accepted) relationship: colored bezier line, small
 * '*'/'1' cardinality glyphs near each endpoint, and a midpoint chip that is
 * the single click target for opening the edit dialog. Clicking the line
 * itself only selects the edge (React Flow default); selection renders the
 * stroke at full opacity with a soft halo. Inactive relationships stay dashed
 * at reduced opacity but keep their hue.
 */
export function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<RelationshipEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const color = data?.color ?? 'var(--rcd-muted)';
  const isActive = data?.isActive ?? true;
  const oneToOne = data?.cardinality === 'oneToOne';
  const isSelected = selected === true;

  const strokeStyle: CSSProperties = {
    stroke: color,
    strokeWidth: isSelected ? 2.5 : 1.5,
    opacity: isSelected ? 1 : isActive ? 0.7 : 0.45,
    transition: 'stroke-width 120ms ease, opacity 120ms ease',
    ...(isActive ? null : { strokeDasharray: '7 5' }),
  };

  const glyphStyle = (x: number, y: number): CSSProperties => ({
    transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
    color,
    backgroundColor: 'var(--rcd-surface)',
    borderColor: `color-mix(in srgb, ${color} 45%, var(--rcd-border))`,
    opacity: isSelected ? 1 : isActive ? 0.9 : 0.55,
  });

  const glyphClass =
    'pointer-events-none absolute flex h-4 min-w-[16px] items-center justify-center rounded border px-0.5 text-[9px] font-bold leading-none';

  return (
    <>
      {/* Soft halo under the selected stroke. */}
      {isSelected && (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeOpacity={0.15}
          strokeLinecap="round"
          aria-hidden
        />
      )}
      <BaseEdge id={id} path={path} style={strokeStyle} />
      <EdgeLabelRenderer>
        {/* Endpoint cardinality glyphs: '*' at the many (from/source) end, '1' at the one end. */}
        <span aria-hidden className={glyphClass} style={glyphStyle(glyphX(sourceX, sourcePosition), sourceY)}>
          {oneToOne ? '1' : '*'}
        </span>
        <span aria-hidden className={glyphClass} style={glyphStyle(glyphX(targetX, targetPosition), targetY)}>
          1
        </span>
        {/* Midpoint chip — the only click target that opens the edit dialog. */}
        <button
          type="button"
          className="nodrag nopan absolute flex cursor-pointer items-center gap-1.5 rounded-full border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[10px] font-semibold text-rcd-text-2 shadow-[var(--rcd-shadow-1)] transition-shadow hover:shadow-[var(--rcd-shadow-2)] hover:ring-2 hover:ring-[var(--rel-color)]"
          style={
            {
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              '--rel-color': `color-mix(in srgb, ${color} 55%, transparent)`,
              ...(isSelected ? { borderColor: color } : null),
              ...(isActive || isSelected ? null : { opacity: 0.65 }),
            } as CSSProperties
          }
          onClick={(event) => {
            event.stopPropagation();
            data?.onOpenEditor(id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data?.onOpenMenu(id, event.clientX, event.clientY);
          }}
          title="Edit relationship"
          aria-label={`Edit relationship (${oneToOne ? 'one to one' : 'many to one'})`}
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          {oneToOne ? '1 : 1' : '* : 1'}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
