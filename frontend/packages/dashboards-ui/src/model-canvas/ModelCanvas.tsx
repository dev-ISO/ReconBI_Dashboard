import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';

export type CanvasNode = Node;
export type CanvasEdge = Edge;

export interface ModelCanvasProps {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
}

/**
 * Relationship-modeling canvas. Grows custom table nodes with per-column
 * connection handles in the vertical-slice phase; for now it proves the
 * React Flow rendering pipeline.
 */
export function ModelCanvas({ nodes = [], edges = [] }: ModelCanvasProps) {
  return (
    <div className="rcd-model-canvas h-full w-full">
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
