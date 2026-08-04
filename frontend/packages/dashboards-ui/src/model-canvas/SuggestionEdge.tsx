import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { RelationshipSuggestion } from '@recon/dashboards-core';

export interface SuggestionEdgeData extends Record<string, unknown> {
  suggestion: RelationshipSuggestion;
  onAccept: (suggestion: RelationshipSuggestion) => void;
}

export type SuggestionEdgeType = Edge<SuggestionEdgeData, 'rcdSuggestion'>;

/**
 * Dotted ghost edge for an FK-derived relationship suggestion, with an
 * "Accept" button at the midpoint that promotes it to a real relationship.
 */
export function SuggestionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<SuggestionEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: 'var(--rcd-muted)',
          strokeWidth: 1.25,
          strokeDasharray: '2 5',
          opacity: 0.8,
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="nodrag nopan absolute rounded-full border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[10px] font-medium text-rcd-accent shadow-sm hover:border-rcd-accent"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (data) data.onAccept(data.suggestion);
          }}
          title={data ? `Suggested by ${data.suggestion.constraintName}` : undefined}
        >
          Accept
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
