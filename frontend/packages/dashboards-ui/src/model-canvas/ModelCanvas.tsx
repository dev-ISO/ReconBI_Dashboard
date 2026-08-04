import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag,
} from '@xyflow/react';
import {
  isQueryableType,
  tableKey,
  type CanvasPosition,
  type Catalog,
  type ModelDefinition,
  type RelationshipSuggestion,
} from '@recon/dashboards-core';
import { TableNode, type TableNodeColumn, type TableNodeType } from './TableNode';
import { SuggestionEdge, type SuggestionEdgeType } from './SuggestionEdge';
import './model-canvas.css';

/** Kept as re-exported aliases so hosts can type ad-hoc canvas content. */
export type CanvasNode = Node;
export type CanvasEdge = Edge;

type ModelCanvasEdge = Edge | SuggestionEdgeType;

export interface ModelCanvasConnectInput {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface ModelCanvasProps {
  definition: ModelDefinition;
  catalog: Catalog | null;
  suggestions: RelationshipSuggestion[];
  onMoveTable: (key: string, position: CanvasPosition) => void;
  /** Raw connection; direction semantics (many side = from) are the store's call. */
  onConnect: (input: ModelCanvasConnectInput) => void;
  onEditRelationship: (id: string) => void;
  onAcceptSuggestion: (suggestion: RelationshipSuggestion) => void;
  onRemoveTable: (key: string) => void;
}

const nodeTypes = { rcdTable: TableNode } satisfies NodeTypes;
const edgeTypes = { rcdSuggestion: SuggestionEdge } satisfies EdgeTypes;

/** Display cap per node; columns used by relationships are always kept visible. */
const COLUMN_CAP = 12;

const fallbackPosition = (index: number): CanvasPosition => ({
  x: 60 + (index % 3) * 300,
  y: 60 + Math.floor(index / 3) * 280 + (index % 3) * 24,
});

const endpointKey = (fromTable: string, fromColumn: string, toTable: string, toColumn: string): string =>
  `${fromTable}|${fromColumn}|${toTable}|${toColumn}`;

const buildNodes = (
  definition: ModelDefinition,
  catalog: Catalog | null,
  requiredColumns: ReadonlyMap<string, ReadonlySet<string>>,
  onRemove: (key: string) => void,
): TableNodeType[] =>
  definition.tables.map((table, index) => {
    const key = tableKey(table.schema, table.name);
    const catalogTable = catalog?.tables.find((t) => t.key === key) ?? null;
    const allColumns = catalogTable?.columns ?? [];

    const visible = allColumns.slice(0, COLUMN_CAP);
    const required = requiredColumns.get(key);
    if (required) {
      for (const column of allColumns.slice(COLUMN_CAP)) {
        if (required.has(column.name)) visible.push(column);
      }
    }
    const columns: TableNodeColumn[] = visible.map((column) => ({
      name: column.name,
      queryable: isQueryableType(column.type),
    }));

    return {
      id: key,
      type: 'rcdTable' as const,
      position: table.position ?? fallbackPosition(index),
      data: {
        tableKey: key,
        title: table.friendlyName ?? table.name,
        schema: table.schema,
        columns,
        moreCount: allColumns.length - visible.length,
        catalogLoaded: catalog !== null,
        missing: catalog !== null && catalogTable === null,
        onRemove,
      },
    };
  });

/**
 * Relationship-modeling canvas: one custom node per model table, one edge per
 * relationship (solid when active, dashed when inactive), plus dotted ghost
 * edges for FK suggestions with an inline Accept action.
 */
export function ModelCanvas({
  definition,
  catalog,
  suggestions,
  onMoveTable,
  onConnect,
  onEditRelationship,
  onAcceptSuggestion,
  onRemoveTable,
}: ModelCanvasProps) {
  const tableKeys = useMemo(
    () => new Set(definition.tables.map((t) => tableKey(t.schema, t.name))),
    [definition.tables],
  );

  const visibleSuggestions = useMemo(() => {
    const existing = new Set<string>();
    for (const r of definition.relationships) {
      existing.add(endpointKey(r.fromTable, r.fromColumn, r.toTable, r.toColumn));
      existing.add(endpointKey(r.toTable, r.toColumn, r.fromTable, r.fromColumn));
    }
    return suggestions.filter(
      (s) =>
        !s.compositeUnsupported &&
        tableKeys.has(s.fromTable) &&
        tableKeys.has(s.toTable) &&
        !existing.has(endpointKey(s.fromTable, s.fromColumn, s.toTable, s.toColumn)),
    );
  }, [definition.relationships, suggestions, tableKeys]);

  /** Columns that must stay visible (and keep handles) despite the display cap. */
  const requiredColumns = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (table: string, column: string) => {
      const set = map.get(table) ?? new Set<string>();
      set.add(column);
      map.set(table, set);
    };
    for (const r of definition.relationships) {
      add(r.fromTable, r.fromColumn);
      add(r.toTable, r.toColumn);
    }
    for (const s of visibleSuggestions) {
      add(s.fromTable, s.fromColumn);
      add(s.toTable, s.toColumn);
    }
    return map;
  }, [definition.relationships, visibleSuggestions]);

  const [nodes, setNodes] = useState<TableNodeType[]>(() =>
    buildNodes(definition, catalog, requiredColumns, onRemoveTable),
  );

  useEffect(() => {
    setNodes(buildNodes(definition, catalog, requiredColumns, onRemoveTable));
  }, [definition, catalog, requiredColumns, onRemoveTable]);

  const edges = useMemo<ModelCanvasEdge[]>(() => {
    if (!catalog) return [];

    const relationshipEdges: ModelCanvasEdge[] = definition.relationships
      .filter((r) => tableKeys.has(r.fromTable) && tableKeys.has(r.toTable))
      .map((r) => ({
        id: r.id,
        source: r.fromTable,
        sourceHandle: r.fromColumn,
        target: r.toTable,
        targetHandle: r.toColumn,
        label: r.cardinality === 'manyToOne' ? '* — 1' : '1 — 1',
        style: r.isActive
          ? { stroke: 'var(--rcd-accent)', strokeWidth: 1.5, opacity: 0.7 }
          : { stroke: 'var(--rcd-accent)', strokeWidth: 1.5, opacity: 0.45, strokeDasharray: '7 5' },
        labelStyle: { fill: 'var(--rcd-text-2)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--rcd-surface)', fillOpacity: 0.9 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
      }));

    const suggestionEdges: ModelCanvasEdge[] = visibleSuggestions.map((s) => ({
      id: `suggestion:${endpointKey(s.fromTable, s.fromColumn, s.toTable, s.toColumn)}`,
      type: 'rcdSuggestion' as const,
      source: s.fromTable,
      sourceHandle: s.fromColumn,
      target: s.toTable,
      targetHandle: s.toColumn,
      selectable: false,
      data: { suggestion: s, onAccept: onAcceptSuggestion },
    }));

    return [...relationshipEdges, ...suggestionEdges];
  }, [catalog, definition.relationships, tableKeys, visibleSuggestions, onAcceptSuggestion]);

  const handleNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (!source || !target || !sourceHandle || !targetHandle) return;
      if (source === target && sourceHandle === targetHandle) return;
      onConnect({
        fromTable: source,
        fromColumn: sourceHandle,
        toTable: target,
        toColumn: targetHandle,
      });
    },
    [onConnect],
  );

  const handleNodeDragStop = useCallback<OnNodeDrag<TableNodeType>>(
    (_event, node) => {
      onMoveTable(node.id, { x: node.position.x, y: node.position.y });
    },
    [onMoveTable],
  );

  const handleEdgeClick = useCallback(
    (_event: ReactMouseEvent, edge: ModelCanvasEdge) => {
      if (edge.type === 'rcdSuggestion') return;
      onEditRelationship(edge.id);
    },
    [onEditRelationship],
  );

  return (
    <div className="rcd-model-canvas h-full w-full">
      <ReactFlow<TableNodeType, ModelCanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        onNodeDragStop={handleNodeDragStop}
        onEdgeClick={handleEdgeClick}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.15}
        deleteKeyCode={null}
      >
        <Background gap={18} size={1.5} color="var(--rcd-grid-line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
