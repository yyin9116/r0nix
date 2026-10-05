import { memo, useCallback, useEffect, useMemo } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AppLanguage } from "../services/userSettings";
import { BOARD_PALETTE } from "../theme/boardPalette";
import type { ReaderDocument } from "../types";
import type { WhiteboardCard, WhiteboardConnection, WhiteboardState } from "./Whiteboards";

type CardCanvasData = { kind: "card"; card: WhiteboardCard; language: AppLanguage; documents: Map<string, ReaderDocument> };
type GroupCanvasData = { kind: "group"; group: WhiteboardState["groups"][number]; language: AppLanguage };
type CanvasData = CardCanvasData | GroupCanvasData;
type CanvasNode = Node<CanvasData>;

const CardNode = memo(function CardNode({ data, selected }: NodeProps<Node<CardCanvasData>>) {
  const card = data.card;
  const palette = BOARD_PALETTE[card.color];
  const typeLabel = data.language === "zh-CN" ? (card.type === "paper" ? "论文" : "笔记") : (card.type === "paper" ? "Paper" : "Note");
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border shadow-lg ${selected ? "ring-2 ring-[var(--reader-accent)]/45" : ""}`}
      style={{ width: card.width, minHeight: card.height, backgroundColor: palette.fill, borderColor: selected ? "var(--reader-accent)" : palette.border, color: palette.text }}
    >
      {/* Handle 的白圈是刻意的「纸面镂空」：卡片填充来自 BOARD_PALETTE，永远近白、
          刻意不随主题翻转，所以白圈不能用主题描边令牌 —— 换成 border-border-subtle
          会在深色下给圆点套上深色环。--surface-paper 正是「永远为纸面的白」这个语义。 */}
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-surface-paper !bg-[var(--reader-accent)]" />
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ backgroundColor: palette.chip, borderColor: `${palette.border}55` }}>
        <span>{typeLabel}</span>
        {card.source ? <span className="rounded-full bg-[var(--reader-accent)]/12 px-1.5 py-0.5 text-[9px] normal-case tracking-normal">p.{card.source.page}</span> : null}
      </div>
      <div className="space-y-2 p-3">
        <div className="line-clamp-2 text-sm font-semibold">{card.title}</div>
        <div className="line-clamp-6 whitespace-pre-wrap text-sm leading-6 opacity-80">{card.content}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-surface-paper !bg-[var(--reader-accent)]" />
    </div>
  );
});

const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<GroupCanvasData>>) {
  const group = data.group;
  const palette = BOARD_PALETTE[group.color];
  const groupLabel = data.language === "zh-CN" ? "分组" : "Group";
  return (
    <div
      className="pointer-events-none rounded-[28px] border border-dashed"
      style={{ width: group.width, height: group.height, borderColor: palette.border, backgroundColor: palette.chip }}
    >
      <div className="absolute left-5 top-4 flex items-center gap-3">
        <span className="rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ backgroundColor: palette.fill, color: palette.text }}>{groupLabel}</span>
        <span className="max-w-[620px] truncate text-sm font-semibold text-content-primary">{group.title}</span>
      </div>
    </div>
  );
});

const nodeTypes = { card: CardNode, group: GroupNode };

function toNodes(board: WhiteboardState, language: AppLanguage, documents: Map<string, ReaderDocument>): CanvasNode[] {
  const groups: CanvasNode[] = board.groups.map((group) => ({
    id: group.id,
    type: "group",
    position: { x: group.x, y: group.y },
    data: { kind: "group", group, language },
    draggable: false,
    selectable: false,
    zIndex: -1,
  }));
  const cards: CanvasNode[] = board.cards.map((card) => ({
    id: card.id,
    type: "card",
    position: { x: card.x, y: card.y },
    data: { kind: "card", card, language, documents },
    draggable: true,
    selectable: true,
  }));
  return [...groups, ...cards];
}

function toEdges(connections: WhiteboardConnection[]): Edge[] {
  return connections.map((connection) => ({
    id: connection.id,
    source: connection.fromCardId,
    target: connection.toCardId,
    type: "smoothstep",
    animated: false,
    style: { stroke: "var(--reader-accent)", strokeWidth: 1.7 },
  }));
}

interface WhiteboardCanvasProps {
  board: WhiteboardState;
  documents: Map<string, ReaderDocument>;
  language: AppLanguage;
  onBoardChange: (updater: (previous: WhiteboardState) => WhiteboardState) => void;
  onSelectCard: (id: string | null) => void;
  onSelectConnection: (id: string | null) => void;
}

function WhiteboardCanvasInner({ board, documents, language, onBoardChange, onSelectCard, onSelectConnection }: WhiteboardCanvasProps) {
  const initialNodes = useMemo(() => toNodes(board, language, documents), []);
  const initialEdges = useMemo(() => toEdges(board.connections), []);
  const [nodes, setNodes] = useNodesState<CanvasNode>(initialNodes);
  const [edges, setEdges] = useEdgesState(initialEdges);
  const { setViewport, getViewport } = useReactFlow();

  useEffect(() => {
    setNodes(toNodes(board, language, documents));
    setEdges(toEdges(board.connections));
  }, [board.cards, board.connections, board.groups, documents, language, setEdges, setNodes]);

  useEffect(() => {
    const viewport = getViewport();
    if (Math.abs(viewport.zoom - board.zoom) > 0.01) {
      setViewport({ ...viewport, zoom: board.zoom }, { duration: 0 });
    }
  }, [board.zoom, getViewport, setViewport]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    const removedNodeIds = new Set(
      changes
        .filter((change): change is Extract<NodeChange<CanvasNode>, { type: "remove" }> => change.type === "remove")
        .map((change) => change.id),
    );
    if (removedNodeIds.size > 0) {
      onBoardChange((previous) => ({
        ...previous,
        cards: previous.cards.filter((card) => !removedNodeIds.has(card.id)),
        groups: previous.groups.filter((group) => !removedNodeIds.has(group.id)),
        connections: previous.connections.filter(
          (connection) => !removedNodeIds.has(connection.fromCardId) && !removedNodeIds.has(connection.toCardId),
        ),
      }));
    }
    const positionChanges = changes.filter((change): change is NodeChange<CanvasNode> & { type: "position"; dragging?: boolean } => change.type === "position" && Boolean(change.position) && change.dragging === false);
    if (positionChanges.length === 0) return;
    onBoardChange((previous) => ({
      ...previous,
      cards: previous.cards.map((card) => {
        const change = positionChanges.find((item) => item.id === card.id);
        return change?.position ? { ...card, x: change.position.x, y: change.position.y, updatedAt: new Date().toISOString() } : card;
      }),
    }));
  }, [onBoardChange, setNodes]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (removed.size > 0) onBoardChange((previous) => ({ ...previous, connections: previous.connections.filter((connection) => !removed.has(connection.id)) }));
  }, [onBoardChange, setEdges]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const duplicate = board.connections.some((item) =>
      (item.fromCardId === connection.source && item.toCardId === connection.target) ||
      (item.fromCardId === connection.target && item.toCardId === connection.source),
    );
    if (duplicate) return;
    const id = `wb-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextEdge = { ...connection, id, type: "smoothstep" } as Edge;
    setEdges((current) => addEdge(nextEdge, current));
    onBoardChange((previous) => ({
      ...previous,
      connections: [...previous.connections, { id, fromCardId: connection.source as string, toCardId: connection.target as string, createdAt: new Date().toISOString() }],
    }));
  }, [board.connections, onBoardChange, setEdges]);

  return (
    <div className="h-full w-full" onContextMenu={(event) => event.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => { onSelectCard(node.id); onSelectConnection(null); }}
        onEdgeClick={(_, edge) => { onSelectConnection(edge.id); onSelectCard(null); }}
        onPaneClick={() => { onSelectCard(null); onSelectConnection(null); }}
        onMoveEnd={(_, viewport) => onBoardChange((previous) => ({ ...previous, zoom: viewport.zoom }))}
        defaultViewport={{ x: 24, y: 24, zoom: board.zoom }}
        minZoom={0.35}
        maxZoom={2}
        fitView={false}
        panOnDrag
        selectionOnDrag
        deleteKeyCode={["Backspace", "Delete"]}
        /* 署名徽标保持默认可见。hideAttribution 只应在订阅 React Flow Pro 之后使用
           —— 本仓未订阅，故显式写 false（而不是删掉这行：删掉会让决定消失在代码里）。
           依据：node_modules/@xyflow/react/dist/esm/index.js 里 Attribution 组件的
           data-message 明写「Please only hide this attribution when you are
           subscribed to React Flow Pro」。守卫见 scripts/check-whiteboard-contract.mjs。 */
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={24} size={1} color="rgba(113,113,122,0.22)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => {
          const data = node.data as CanvasData;
          return data.kind === "group" ? BOARD_PALETTE[data.group.color].border : BOARD_PALETTE[data.card.color].border;
        }} />
      </ReactFlow>
    </div>
  );
}

export function WhiteboardCanvas(props: WhiteboardCanvasProps) {
  return (
    <ReactFlowProvider>
      <WhiteboardCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export { CardNode };
