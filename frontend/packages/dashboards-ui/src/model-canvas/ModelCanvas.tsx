import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag,
} from '@xyflow/react';
import { ArrowLeftRight, Pencil, Power, PowerOff, Rows3, Trash2 } from 'lucide-react';
import {
  isQueryableType,
  tableKey,
  type CanvasPosition,
  type Catalog,
  type ModelDefinition,
  type RelationshipSuggestion,
} from '@recon/dashboards-core';
import { TableNode, type TableNodeColumn, type TableNodeColumnRel, type TableNodeType } from './TableNode';
import { SuggestionEdge, type SuggestionEdgeType } from './SuggestionEdge';
import { RelationshipEdge, type RelationshipEdgeType } from './RelationshipEdge';
import { CanvasContextMenu, type CanvasMenuItem } from './CanvasContextMenu';
import { relationshipColor } from './relationshipColors';
import './model-canvas.css';

/** Kept as re-exported aliases so hosts can type ad-hoc canvas content. */
export type CanvasNode = Node;
export type CanvasEdge = Edge;

type ModelCanvasEdge = RelationshipEdgeType | SuggestionEdgeType;

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
  /** Immediate delete (keyboard / context menu); the model is local-until-Save. */
  onDeleteRelationships: (ids: string[]) => void;
  onSetRelationshipActive: (id: string, isActive: boolean) => void;
  /** One-to-many ⇄ many-to-one via endpoint swap (wire stays manyToOne). */
  onSwapRelationship: (id: string) => void;
}

const nodeTypes = { rcdTable: TableNode } satisfies NodeTypes;
const edgeTypes = { rcdSuggestion: SuggestionEdge, rcdRelationship: RelationshipEdge } satisfies EdgeTypes;

/** Display cap per node; columns used by relationships are always kept visible. */
const COLUMN_CAP = 12;

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

const fallbackPosition = (index: number): CanvasPosition => ({
  x: 60 + (index % 3) * 300,
  y: 60 + Math.floor(index / 3) * 280 + (index % 3) * 24,
});

const endpointKey = (fromTable: string, fromColumn: string, toTable: string, toColumn: string): string =>
  `${fromTable}|${fromColumn}|${toTable}|${toColumn}`;

/** Width fallback until React Flow measures the node (TableNode renders at Tailwind w-52 = 208px). */
const NODE_WIDTH_FALLBACK = 208;

/** TableNode handle ids are `${column}::<l|r>-<src|tgt>`; this recovers the column name. */
const handleColumn = (handleId: string): string => handleId.replace(/::[lr]-(src|tgt)$/, '');

type CanvasMenuState =
  | { kind: 'edge'; id: string; x: number; y: number }
  | { kind: 'node'; id: string; x: number; y: number };

const buildNodes = (
  definition: ModelDefinition,
  catalog: Catalog | null,
  requiredColumns: ReadonlyMap<string, ReadonlySet<string>>,
  expandedTables: ReadonlySet<string>,
  selectedRelationshipIds: ReadonlySet<string>,
  onRemove: (key: string) => void,
): TableNodeType[] => {
  // Per-column relationship info (color/active/selected) for both endpoints of
  // every drawn relationship — the same table filter as the edges, so a column
  // is never tinted for a line that is not on the canvas.
  const presentKeys = new Set(definition.tables.map((t) => tableKey(t.schema, t.name)));
  const columnRels = new Map<string, Map<string, TableNodeColumnRel[]>>();
  const addRel = (table: string, column: string, info: TableNodeColumnRel) => {
    const byColumn = columnRels.get(table) ?? new Map<string, TableNodeColumnRel[]>();
    const list = byColumn.get(column) ?? [];
    list.push(info);
    byColumn.set(column, list);
    columnRels.set(table, byColumn);
  };
  for (const r of definition.relationships) {
    if (!presentKeys.has(r.fromTable) || !presentKeys.has(r.toTable)) continue;
    const base = {
      relationshipId: r.id,
      color: relationshipColor(r.id),
      isActive: r.isActive,
      selected: selectedRelationshipIds.has(r.id),
    };
    addRel(r.fromTable, r.fromColumn, { ...base, otherEndpoint: `${r.toTable}.${r.toColumn}` });
    addRel(r.toTable, r.toColumn, { ...base, otherEndpoint: `${r.fromTable}.${r.fromColumn}` });
  }

  return definition.tables.map((table, index) => {
    const key = tableKey(table.schema, table.name);
    const catalogTable = catalog?.tables.find((t) => t.key === key) ?? null;
    const allColumns = catalogTable?.columns ?? [];

    const expanded = expandedTables.has(key);
    const visible = expanded ? [...allColumns] : allColumns.slice(0, COLUMN_CAP);
    const required = requiredColumns.get(key);
    if (!expanded && required) {
      for (const column of allColumns.slice(COLUMN_CAP)) {
        if (required.has(column.name)) visible.push(column);
      }
    }
    const relsForTable = columnRels.get(key);
    const columns: TableNodeColumn[] = visible.map((column) => ({
      name: column.name,
      queryable: isQueryableType(column.type),
      relationships: relsForTable?.get(column.name),
    }));

    return {
      id: key,
      type: 'rcdTable' as const,
      position: table.position ?? fallbackPosition(index),
      // Keyboard delete must never remove tables (only relationship edges).
      deletable: false,
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
};

/**
 * Relationship-modeling canvas: one custom node per model table, one colored
 * custom edge per relationship (solid when active, dashed when inactive; the
 * midpoint chip opens the editor), plus dotted ghost edges for FK suggestions
 * with an inline Accept action. Clicking a line selects it; Delete/Backspace
 * removes selected relationships immediately (local-until-Save); right-click
 * opens context menus on lines and tables.
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
  onDeleteRelationships,
  onSetRelationshipActive,
  onSwapRelationship,
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

  /** Selected relationship edge ids — owned here (not by React Flow) so the
      selection survives the definition-driven edge rebuilds. */
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  /** Tables the user expanded past the column cap via the context menu. */
  const [expandedTables, setExpandedTables] = useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  const [menu, setMenu] = useState<CanvasMenuState | null>(null);

  const [nodes, setNodes] = useState<TableNodeType[]>(() =>
    buildNodes(definition, catalog, requiredColumns, EMPTY_STRING_SET, EMPTY_STRING_SET, onRemoveTable),
  );

  // Rebuild nodes on definition/catalog changes, preserving node selection so
  // an in-flight selection is not clobbered by unrelated model edits.
  useEffect(() => {
    setNodes((previous) => {
      const selectedNodeIds = new Set(previous.filter((n) => n.selected).map((n) => n.id));
      const rebuilt = buildNodes(
        definition,
        catalog,
        requiredColumns,
        expandedTables,
        selectedEdgeIds,
        onRemoveTable,
      );
      return selectedNodeIds.size === 0
        ? rebuilt
        : rebuilt.map((node) => (selectedNodeIds.has(node.id) ? { ...node, selected: true } : node));
    });
  }, [definition, catalog, requiredColumns, expandedTables, selectedEdgeIds, onRemoveTable]);

  // Drop selections pointing at relationships that no longer exist.
  useEffect(() => {
    setSelectedEdgeIds((current) => {
      if (current.size === 0) return current;
      const valid = new Set(definition.relationships.map((r) => r.id));
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [definition.relationships]);

  const openEdgeMenu = useCallback((id: string, x: number, y: number) => {
    setSelectedEdgeIds(new Set([id]));
    setMenu({ kind: 'edge', id, x, y });
  }, []);

  const edges = useMemo<ModelCanvasEdge[]>(() => {
    if (!catalog) return [];

    // Attach each edge to the sides facing the other node so lines never wrap
    // behind nodes. Reads CURRENT positions from local `nodes` state (a memo
    // dep), so sides flip live while dragging.
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const centerX = (id: string): number => {
      const node = nodeById.get(id);
      if (!node) return 0;
      return node.position.x + (node.measured?.width ?? NODE_WIDTH_FALLBACK) / 2;
    };
    const sideHandles = (
      sourceId: string,
      sourceColumn: string,
      targetId: string,
      targetColumn: string,
    ): { sourceHandle: string; targetHandle: string } =>
      centerX(sourceId) <= centerX(targetId)
        ? { sourceHandle: `${sourceColumn}::r-src`, targetHandle: `${targetColumn}::l-tgt` }
        : { sourceHandle: `${sourceColumn}::l-src`, targetHandle: `${targetColumn}::r-tgt` };

    const relationshipEdges: ModelCanvasEdge[] = definition.relationships
      .filter((r) => tableKeys.has(r.fromTable) && tableKeys.has(r.toTable))
      .map((r) => ({
        id: r.id,
        type: 'rcdRelationship' as const,
        source: r.fromTable,
        target: r.toTable,
        ...sideHandles(r.fromTable, r.fromColumn, r.toTable, r.toColumn),
        selected: selectedEdgeIds.has(r.id),
        data: {
          cardinality: r.cardinality,
          isActive: r.isActive,
          color: relationshipColor(r.id),
          onOpenEditor: onEditRelationship,
          onOpenMenu: openEdgeMenu,
        },
      }));

    const suggestionEdges: ModelCanvasEdge[] = visibleSuggestions.map((s) => ({
      id: `suggestion:${endpointKey(s.fromTable, s.fromColumn, s.toTable, s.toColumn)}`,
      type: 'rcdSuggestion' as const,
      source: s.fromTable,
      target: s.toTable,
      ...sideHandles(s.fromTable, s.fromColumn, s.toTable, s.toColumn),
      selectable: false,
      deletable: false,
      data: { suggestion: s, onAccept: onAcceptSuggestion },
    }));

    return [...relationshipEdges, ...suggestionEdges];
  }, [
    catalog,
    definition.relationships,
    tableKeys,
    visibleSuggestions,
    onAcceptSuggestion,
    onEditRelationship,
    openEdgeMenu,
    selectedEdgeIds,
    nodes,
  ]);

  /**
   * Clicking an SVG edge leaves focus on <body> (browsers don't focus SVG on
   * click), so the wrapper's onKeyDown would never fire. Pull focus into the
   * canvas on selection — but only when it isn't already inside (React Flow
   * focuses nodes natively; don't steal that).
   */
  const wrapperRef = useRef<HTMLDivElement>(null);
  const focusCanvas = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (wrapper && !wrapper.contains(document.activeElement)) {
      wrapper.focus({ preventScroll: true });
    }
  }, []);

  const handleNodesChange = useCallback(
    (changes: NodeChange<TableNodeType>[]) => {
      if (changes.some((c) => c.type === 'select' && c.selected)) focusCanvas();
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [focusCanvas],
  );

  /** Mirror React Flow's edge selection changes into our own selection state. */
  const handleEdgesChange = useCallback((changes: EdgeChange<ModelCanvasEdge>[]) => {
    if (changes.some((c) => c.type === 'select' && c.selected)) focusCanvas();
    setSelectedEdgeIds((current) => {
      let next: Set<string> | null = null;
      for (const change of changes) {
        if (change.type !== 'select' || change.id.startsWith('suggestion:')) continue;
        next ??= new Set(current);
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      return next ?? current;
    });
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (!source || !target || !sourceHandle || !targetHandle) return;
      // Handles carry side/role suffixes; strip them back to column names.
      const fromColumn = handleColumn(sourceHandle);
      const toColumn = handleColumn(targetHandle);
      if (source === target && fromColumn === toColumn) return;
      onConnect({
        fromTable: source,
        fromColumn,
        toTable: target,
        toColumn,
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

  const handleEdgeContextMenu = useCallback(
    (event: ReactMouseEvent, edge: ModelCanvasEdge) => {
      event.preventDefault();
      if (edge.type !== 'rcdRelationship') {
        setMenu(null);
        return;
      }
      openEdgeMenu(edge.id, event.clientX, event.clientY);
    },
    [openEdgeMenu],
  );

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: TableNodeType) => {
    event.preventDefault();
    setMenu({ kind: 'node', id: node.id, x: event.clientX, y: event.clientY });
  }, []);

  const handlePaneContextMenu = useCallback((event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault();
    setMenu(null);
  }, []);

  /**
   * Canvas-scoped keyboard handling (React Flow's own deleteKeyCode stays off:
   * its listener is window-wide and could fire from dialogs). This only sees
   * keydowns bubbling from focus inside the canvas, and still skips anything
   * typed into a form control. Delete/Backspace removes the selected
   * relationship edges — never nodes; Escape clears the selection.
   */
  const handleCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedEdgeIds.size === 0) return;
        event.preventDefault();
        onDeleteRelationships([...selectedEdgeIds]);
        setSelectedEdgeIds(EMPTY_STRING_SET);
        setMenu(null);
      } else if (event.key === 'Escape') {
        setSelectedEdgeIds((current) => (current.size > 0 ? EMPTY_STRING_SET : current));
        setNodes((current) =>
          current.some((n) => n.selected)
            ? current.map((n) => (n.selected ? { ...n, selected: false } : n))
            : current,
        );
        setMenu(null);
      }
    },
    [selectedEdgeIds, onDeleteRelationships],
  );

  let menuContent: ReactNode = null;
  if (menu?.kind === 'edge') {
    const relationship = definition.relationships.find((r) => r.id === menu.id);
    if (relationship) {
      const actions: CanvasMenuItem[] = [
        {
          key: 'edit',
          icon: <Pencil size={14} />,
          label: 'Edit relationship…',
          onSelect: () => onEditRelationship(relationship.id),
        },
        {
          key: 'active',
          icon: relationship.isActive ? <PowerOff size={14} /> : <Power size={14} />,
          label: relationship.isActive ? 'Set inactive' : 'Set active',
          onSelect: () => onSetRelationshipActive(relationship.id, !relationship.isActive),
        },
      ];
      // One-to-one has no many side; direction is meaningless.
      if (relationship.cardinality === 'manyToOne') {
        actions.push({
          key: 'swap',
          icon: <ArrowLeftRight size={14} />,
          label: 'Swap direction',
          onSelect: () => onSwapRelationship(relationship.id),
        });
      }
      menuContent = (
        <CanvasContextMenu
          ariaLabel={`Relationship ${relationship.fromTable}.${relationship.fromColumn} to ${relationship.toTable}.${relationship.toColumn}`}
          position={{ x: menu.x, y: menu.y }}
          groups={[
            actions,
            [
              {
                key: 'delete',
                icon: <Trash2 size={14} />,
                label: 'Delete relationship',
                danger: true,
                onSelect: () => onDeleteRelationships([relationship.id]),
              },
            ],
          ]}
          onClose={() => setMenu(null)}
        />
      );
    }
  } else if (menu?.kind === 'node') {
    const nodeId = menu.id;
    const node = nodes.find((n) => n.id === nodeId);
    const expanded = expandedTables.has(nodeId);
    const moreCount = node?.data.moreCount ?? 0;
    const columnItems: CanvasMenuItem[] = [];
    if (!expanded && moreCount > 0) {
      columnItems.push({
        key: 'expand',
        icon: <Rows3 size={14} />,
        label: `Show all columns (+${moreCount} more)`,
        onSelect: () => setExpandedTables((current) => new Set(current).add(nodeId)),
      });
    }
    if (expanded) {
      columnItems.push({
        key: 'collapse',
        icon: <Rows3 size={14} />,
        label: 'Show fewer columns',
        onSelect: () =>
          setExpandedTables((current) => {
            const next = new Set(current);
            next.delete(nodeId);
            return next;
          }),
      });
    }
    menuContent = (
      <CanvasContextMenu
        ariaLabel={`Table ${nodeId}`}
        position={{ x: menu.x, y: menu.y }}
        groups={[
          columnItems,
          [
            {
              key: 'remove',
              icon: <Trash2 size={14} />,
              label: 'Remove table…',
              danger: true,
              onSelect: () => onRemoveTable(nodeId),
            },
          ],
        ]}
        onClose={() => setMenu(null)}
      />
    );
  }

  return (
    <div
      ref={wrapperRef}
      // Programmatically focusable (focusCanvas) without joining tab order.
      tabIndex={-1}
      className="rcd-model-canvas h-full w-full outline-none"
      onKeyDown={handleCanvasKeyDown}
      // Native browser menu is suppressed everywhere inside the canvas; our
      // node/edge handlers open the custom card instead.
      onContextMenu={(event) => event.preventDefault()}
    >
      <ReactFlow<TableNodeType, ModelCanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeDragStop={handleNodeDragStop}
        onEdgeContextMenu={handleEdgeContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.15}
        deleteKeyCode={null}
      >
        <Background gap={18} size={1.5} color="var(--rcd-grid-line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {menuContent}
    </div>
  );
}
