import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  LayoutTemplate,
  Link2,
  Move,
  Plus,
  Sparkles,
  StickyNote,
  Trash2,
  ZoomIn,
  ZoomOut,
  PanelRight,
  Hand,
} from "lucide-react";
import type { ReaderDocument } from "../types";
import type { AppLanguage } from "../services/userSettings";

interface WhiteboardsProps {
  documents: ReaderDocument[];
  onOpenPdf: (doc: ReaderDocument) => void;
  language: AppLanguage;
}

type CardColor = "zinc" | "stone" | "slate" | "olive" | "blue";
type WhiteboardCard = {
  id: string;
  type: "note" | "paper";
  title: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: CardColor;
  groupId?: string;
  docId?: string;
  updatedAt: string;
};
type WhiteboardConnection = {
  id: string;
  fromCardId: string;
  toCardId: string;
  createdAt: string;
};
type WhiteboardGroup = {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: CardColor;
  docId?: string;
  createdAt: string;
};
type WhiteboardState = {
  version: 2;
  zoom: number;
  cards: WhiteboardCard[];
  connections: WhiteboardConnection[];
  groups: WhiteboardGroup[];
};
type InteractionState =
  | {
      type: "drag";
      cardId: string;
      pointerBoardX: number;
      pointerBoardY: number;
      startX: number;
      startY: number;
      width: number;
      height: number;
    }
  | {
      type: "resize";
      cardId: string;
      pointerBoardX: number;
      pointerBoardY: number;
      startWidth: number;
      startHeight: number;
      x: number;
      y: number;
    };

type BoardPanState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

const I18N = {
  "zh-CN": {
    boardTitle: "白板",
    boardStats: (cards: number, groups: number, connections: number) => `${cards} 张卡片，${groups} 个分组，${connections} 条连接`,
    addNote: "添加笔记",
    seedBoard: "生成研究白板",
    zoomOut: "缩小",
    resetZoom: "重置缩放",
    zoomIn: "放大",
    clearBoard: "清空白板",
    emptyTitle: "搭建可执行的研究白板",
    emptyDesc: "创建论文分组、调整卡片大小、编辑笔记颜色，并通过真实连线组织思路，所有内容会本地持久化。",
    addFirstNote: "添加第一条笔记",
    seedFromPapers: "从论文生成",
    cluster: "分组",
    cardsNoun: "张卡片",
    linkedToPaper: "关联论文",
    inCluster: "位于分组",
    note: "笔记",
    paper: "论文",
    cancelLinking: "取消连线",
    connectToCard: "连接到该卡片",
    startLinking: "开始连线",
    removeCard: "删除卡片",
    unknownAuthors: "未知作者",
    openPdf: "打开 PDF",
    linkedMissing: "该关联论文已不在当前资料库中。",
    notePlaceholder: "记录证据、对比结论或下一步实验想法...",
    resizeCard: "调整卡片大小",
    inspector: "检查器",
    connection: "连接",
    sidecar: "研究侧栏",
    sidecarLinkHint: "点击另一张卡片上的连线按钮来创建连接。",
    sidecarDefaultHint: "使用克制配色、分组和卡片连接来整理论文笔记。",
    selectedCard: "当前卡片",
    colorTag: "颜色标签",
    content: "内容",
    size: "尺寸",
    clusteredCard: "分组卡片",
    freeformCard: "自由卡片",
    linking: "连线中...",
    startLink: "开始连接",
    deleteCard: "删除卡片",
    openLinkedPdf: "打开关联 PDF",
    selectedLink: "当前连接",
    connectsTo: "连接到",
    missingCard: "卡片不存在",
    deleteLink: "删除连接",
    selectHint: "选择一张卡片可编辑颜色和内容，或点击虚线连接将其删除。",
    recentPapers: "最近论文",
    recentDesc: "可创建单论文卡片，或基于单篇论文快速搭建研究分组。",
    paperCard: "论文卡片",
    researchCluster: "研究分组",
    open: "打开",
    importHint: "请先导入一些 PDF，然后可在此基于它们生成分组。",
    boardSnapshot: "白板概览",
    hideSidecar: "收起右侧栏",
    showSidecar: "展开右侧栏",
    notes: "笔记",
    papers: "论文",
    clusters: "分组",
    links: "连接",
    researchNote: "研究笔记",
    problemClaim: "问题与核心结论",
    problemClaimDesc: "这篇论文回答了什么问题？核心结论是什么？",
    methodsEvidence: "方法与证据",
    methodsEvidenceDesc: "关键方法、数据集或实验设置是什么？最有说服力的证据是什么？",
    openQuestions: "开放问题",
    openQuestionsDesc: "下一步实验、潜在缺陷、对比对象或实现思路。",
    readingPlan: "阅读计划",
    readingPlanDesc: "先建立一个论文分组，再添加对比笔记，并用连线串联关键证据。",
    boardBrief: "研究白板摘要",
    boardBriefDesc: "按论文建立分组，把结论连接到笔记卡片，并在对比方法与结论时持续补充综合笔记。",
    mainContribution: "主要贡献",
    mainContributionDesc: "这篇工作的真正创新点是什么？",
    evidenceToVerify: "待验证证据",
    evidenceToVerifyDesc: "有哪些结果或图表值得重点复核？",
    colorZinc: "锌灰",
    colorStone: "岩灰",
    colorSlate: "石板",
    colorOlive: "橄榄",
    colorBlue: "蓝色",
    dragCanvas: "\u62d6\u52a8\u753b\u5e03",
    dragCanvasOn: "\u5df2\u5f00\u542f",
    dragCanvasOff: "\u5df2\u5173\u95ed",
  },
  "en-US": {
    boardTitle: "Whiteboards",
    boardStats: (cards: number, groups: number, connections: number) => `${cards} cards, ${groups} clusters, ${connections} links`,
    addNote: "Add Note",
    seedBoard: "Seed Research Board",
    zoomOut: "Zoom out",
    resetZoom: "Reset zoom",
    zoomIn: "Zoom in",
    clearBoard: "Clear Board",
    emptyTitle: "Build a working research board",
    emptyDesc: "Create paper clusters, resize cards, edit note colors, and connect ideas with real links that stay persisted locally.",
    addFirstNote: "Add First Note",
    seedFromPapers: "Seed From Papers",
    cluster: "Cluster",
    cardsNoun: "cards",
    linkedToPaper: "linked to paper",
    inCluster: "in cluster",
    note: "Note",
    paper: "Paper",
    cancelLinking: "Cancel linking",
    connectToCard: "Connect to this card",
    startLinking: "Start linking",
    removeCard: "Remove card",
    unknownAuthors: "Unknown authors",
    openPdf: "Open PDF",
    linkedMissing: "The linked paper is no longer available in the current library list.",
    notePlaceholder: "Capture evidence, comparisons, or next experiments...",
    resizeCard: "Resize card",
    inspector: "Inspector",
    connection: "Connection",
    sidecar: "Research Sidecar",
    sidecarLinkHint: "Click the link button on another card to create a connection.",
    sidecarDefaultHint: "Use restrained color tags, clusters, and card links to organize paper notes.",
    selectedCard: "Selected card",
    colorTag: "Color tag",
    content: "Content",
    size: "Size",
    clusteredCard: "Clustered card",
    freeformCard: "Freeform card",
    linking: "Linking...",
    startLink: "Start Link",
    deleteCard: "Delete Card",
    openLinkedPdf: "Open Linked PDF",
    selectedLink: "Selected link",
    connectsTo: "connects to",
    missingCard: "Missing card",
    deleteLink: "Delete Link",
    selectHint: "Select a card to edit its color tag and content, or click a dashed connection to remove it.",
    recentPapers: "Recent Papers",
    recentDesc: "Create a paper-only card or scaffold a clustered research board from one paper.",
    paperCard: "Paper Card",
    researchCluster: "Research Cluster",
    open: "Open",
    importHint: "Import a few PDFs first, then you can scaffold clusters from them here.",
    boardSnapshot: "Board Snapshot",
    hideSidecar: "Hide side panel",
    showSidecar: "Show side panel",
    notes: "Notes",
    papers: "Papers",
    clusters: "Clusters",
    links: "Links",
    researchNote: "Research Note",
    problemClaim: "Problem + claim",
    problemClaimDesc: "What question does this paper answer? What is the core claim?",
    methodsEvidence: "Methods + evidence",
    methodsEvidenceDesc: "Key method, dataset, or experimental setup. Capture the strongest evidence.",
    openQuestions: "Open questions",
    openQuestionsDesc: "Follow-up experiment, weakness, comparison target, or implementation idea.",
    readingPlan: "Reading Plan",
    readingPlanDesc: "Start with one paper cluster, add comparison notes, and connect evidence across cards.",
    boardBrief: "Research board brief",
    boardBriefDesc: "Use clusters per paper, connect findings to note cards, and keep synthesis notes as you compare methods and claims.",
    mainContribution: "Main contribution",
    mainContributionDesc: "What is genuinely new here?",
    evidenceToVerify: "Evidence to verify",
    evidenceToVerifyDesc: "What result or figure should be checked in detail?",
    colorZinc: "Zinc",
    colorStone: "Stone",
    colorSlate: "Slate",
    colorOlive: "Olive",
    colorBlue: "Blue",
    dragCanvas: "Drag canvas",
    dragCanvasOn: "On",
    dragCanvasOff: "Off",
  },
} as const;

const STORAGE_KEY = "r0nix_reader_whiteboard_v1";
const BOARD_WIDTH = 1920;
const BOARD_HEIGHT = 1280;
const MIN_CARD_WIDTH = 220;
const MIN_CARD_HEIGHT = 150;
const MAX_CARD_WIDTH = 560;
const MAX_CARD_HEIGHT = 460;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.6;

const CARD_PALETTE: Array<{ id: CardColor; border: string; chip: string; fill: string; text: string }> = [
  { id: "zinc", border: "rgba(63,63,70,0.9)", chip: "rgba(82,82,91,0.12)", fill: "rgba(250,250,250,0.96)", text: "#18181b" },
  { id: "stone", border: "rgba(87,83,78,0.85)", chip: "rgba(120,113,108,0.12)", fill: "rgba(250,250,249,0.96)", text: "#1c1917" },
  { id: "slate", border: "rgba(51,65,85,0.88)", chip: "rgba(71,85,105,0.14)", fill: "rgba(248,250,252,0.96)", text: "#0f172a" },
  { id: "olive", border: "rgba(82,82,55,0.88)", chip: "rgba(113,113,63,0.14)", fill: "rgba(250,250,244,0.96)", text: "#27272a" },
  { id: "blue", border: "rgba(37,99,235,0.8)", chip: "rgba(59,130,246,0.12)", fill: "rgba(248,250,252,0.96)", text: "#172554" },
];

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeZoom(value: number) {
  return clamp(Number.isFinite(value) ? value : 1, MIN_ZOOM, MAX_ZOOM);
}

function normalizeColor(value: unknown): CardColor {
  return value === "stone" || value === "slate" || value === "olive" || value === "blue" ? value : "zinc";
}

function getPalette(color: CardColor) {
  return CARD_PALETTE.find((item) => item.id === color) || CARD_PALETTE[0];
}

function sanitizeCard(item: Partial<WhiteboardCard>, index: number): WhiteboardCard | null {
  if (typeof item?.id !== "string") return null;
  if (item.type !== "paper" && item.type !== "note") return null;
  return {
    id: item.id,
    type: item.type,
    title: typeof item.title === "string" && item.title.trim() ? item.title : item.type === "paper" ? "Paper" : "Note",
    content: typeof item.content === "string" ? item.content : "",
    x: typeof item.x === "number" ? item.x : 64 + (index % 3) * 280,
    y: typeof item.y === "number" ? item.y : 64 + Math.floor(index / 3) * 200,
    width: clamp(typeof item.width === "number" ? item.width : 280, MIN_CARD_WIDTH, MAX_CARD_WIDTH),
    height: clamp(typeof item.height === "number" ? item.height : 200, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT),
    color: normalizeColor(item.color),
    groupId: typeof item.groupId === "string" ? item.groupId : undefined,
    docId: typeof item.docId === "string" ? item.docId : undefined,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

function sanitizeConnection(item: Partial<WhiteboardConnection>): WhiteboardConnection | null {
  if (typeof item?.id !== "string") return null;
  if (typeof item.fromCardId !== "string" || typeof item.toCardId !== "string" || item.fromCardId === item.toCardId) return null;
  return { id: item.id, fromCardId: item.fromCardId, toCardId: item.toCardId, createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString() };
}

function sanitizeGroup(item: Partial<WhiteboardGroup>, index: number): WhiteboardGroup | null {
  if (typeof item?.id !== "string") return null;
  return {
    id: item.id,
    title: typeof item.title === "string" && item.title.trim() ? item.title : `Cluster ${index + 1}`,
    x: typeof item.x === "number" ? item.x : 64 + (index % 2) * 520,
    y: typeof item.y === "number" ? item.y : 64 + Math.floor(index / 2) * 420,
    width: clamp(typeof item.width === "number" ? item.width : 980, 620, BOARD_WIDTH - 48),
    height: clamp(typeof item.height === "number" ? item.height : 380, 280, BOARD_HEIGHT - 48),
    color: normalizeColor(item.color),
    docId: typeof item.docId === "string" ? item.docId : undefined,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
  };
}

function loadBoardState(): WhiteboardState {
  const empty: WhiteboardState = { version: 2, zoom: 1, cards: [], connections: [], groups: [] };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        version: 2,
        zoom: 1,
        cards: parsed.map((item, index) => sanitizeCard(item as Partial<WhiteboardCard>, index)).filter((item): item is WhiteboardCard => Boolean(item)),
        groups: [],
        connections: [],
      };
    }
    if (!parsed || typeof parsed !== "object") return empty;
    const candidate = parsed as Partial<WhiteboardState> & {
      cards?: Array<Partial<WhiteboardCard>>;
      groups?: Array<Partial<WhiteboardGroup>>;
      connections?: Array<Partial<WhiteboardConnection>>;
    };
    const cards = Array.isArray(candidate.cards)
      ? candidate.cards.map((item, index) => sanitizeCard(item, index)).filter((item): item is WhiteboardCard => Boolean(item))
      : [];
    const groups = Array.isArray(candidate.groups)
      ? candidate.groups.map((item, index) => sanitizeGroup(item, index)).filter((item): item is WhiteboardGroup => Boolean(item))
      : [];
    const cardIds = new Set(cards.map((card) => card.id));
    const connections = Array.isArray(candidate.connections)
      ? candidate.connections
          .map((item) => sanitizeConnection(item))
          .filter((item): item is WhiteboardConnection => item !== null)
          .filter((item) => cardIds.has(item.fromCardId) && cardIds.has(item.toCardId))
      : [];
    return { version: 2, zoom: normalizeZoom(candidate.zoom ?? 1), cards, groups, connections };
  } catch {
    return empty;
  }
}

function createNoteCard(seed?: Partial<WhiteboardCard>): WhiteboardCard {
  return {
    id: createId("wb-note"),
    type: "note",
    title: seed?.title || "New Note",
    content: seed?.content || "",
    x: seed?.x ?? 72,
    y: seed?.y ?? 72,
    width: clamp(seed?.width ?? 300, MIN_CARD_WIDTH, MAX_CARD_WIDTH),
    height: clamp(seed?.height ?? 210, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT),
    color: normalizeColor(seed?.color),
    groupId: typeof seed?.groupId === "string" ? seed.groupId : undefined,
    updatedAt: new Date().toISOString(),
  };
}

function createPaperCard(doc: ReaderDocument, index: number, seed?: Partial<WhiteboardCard>): WhiteboardCard {
  return {
    id: seed?.id || createId(`wb-paper-${doc.id}`),
    type: "paper",
    title: seed?.title || doc.title,
    content: seed?.content || [doc.authors.join(", "), doc.journal, doc.year || ""].filter(Boolean).join(" | ") || "Linked paper",
    x: seed?.x ?? 96 + (index % 3) * 320,
    y: seed?.y ?? 120 + Math.floor(index / 3) * 220,
    width: clamp(seed?.width ?? 320, MIN_CARD_WIDTH, MAX_CARD_WIDTH),
    height: clamp(seed?.height ?? 210, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT),
    color: normalizeColor(seed?.color ?? "slate"),
    groupId: typeof seed?.groupId === "string" ? seed.groupId : undefined,
    docId: doc.id,
    updatedAt: new Date().toISOString(),
  };
}

function buildConnectionPath(from: WhiteboardCard, to: WhiteboardCard) {
  const startOnRight = from.x <= to.x;
  const startX = startOnRight ? from.x + from.width : from.x;
  const startY = from.y + from.height / 2;
  const endX = startOnRight ? to.x : to.x + to.width;
  const endY = to.y + to.height / 2;
  const delta = clamp(Math.abs(endX - startX) * 0.42, 70, 220);
  const c1x = startOnRight ? startX + delta : startX - delta;
  const c2x = startOnRight ? endX - delta : endX + delta;
  return `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`;
}

export function Whiteboards({ documents, onOpenPdf, language }: WhiteboardsProps) {
  const [board, setBoard] = useState<WhiteboardState>(loadBoardState);
  const t = I18N[language];
  const colorLabelById: Record<CardColor, string> = {
    zinc: t.colorZinc,
    stone: t.colorStone,
    slate: t.colorSlate,
    olive: t.colorOlive,
    blue: t.colorBlue,
  };
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [pendingConnectionFromId, setPendingConnectionFromId] = useState<string | null>(null);
  const [isSidecarOpen, setIsSidecarOpen] = useState(true);
  const [isPanMode, setIsPanMode] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollWrapRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const panRef = useRef<BoardPanState | null>(null);
  const documentMap = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const cardMap = useMemo(() => new Map(board.cards.map((card) => [card.id, card])), [board.cards]);
  const recentDocs = useMemo(() => documents.slice(0, 6), [documents]);
  const selectedCard = selectedCardId ? cardMap.get(selectedCardId) || null : null;
  const selectedConnection = useMemo(() => board.connections.find((connection) => connection.id === selectedConnectionId) || null, [board.connections, selectedConnectionId]);
  const stats = useMemo(() => ({
    notes: board.cards.filter((card) => card.type === "note").length,
    papers: board.cards.filter((card) => card.type === "paper").length,
    groups: board.groups.length,
    connections: board.connections.length,
  }), [board.cards, board.groups, board.connections]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
  }, [board]);

  const clientToBoard = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const zoom = board.zoom || 1;
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;
      const point = clientToBoard(event.clientX, event.clientY);
      setBoard((prev) => {
        const cards = prev.cards.map((card) => {
          if (card.id !== interaction.cardId) return card;
          if (interaction.type === "drag") {
            const nextX = clamp(interaction.startX + (point.x - interaction.pointerBoardX), 24, BOARD_WIDTH - interaction.width - 24);
            const nextY = clamp(interaction.startY + (point.y - interaction.pointerBoardY), 24, BOARD_HEIGHT - interaction.height - 24);
            return { ...card, x: nextX, y: nextY, updatedAt: new Date().toISOString() };
          }
          const nextWidth = clamp(interaction.startWidth + (point.x - interaction.pointerBoardX), MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, BOARD_WIDTH - interaction.x - 24));
          const nextHeight = clamp(interaction.startHeight + (point.y - interaction.pointerBoardY), MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, BOARD_HEIGHT - interaction.y - 24));
          return { ...card, width: nextWidth, height: nextHeight, updatedAt: new Date().toISOString() };
        });
        return { ...prev, cards };
      });
    };

    const handlePanMove = (event: PointerEvent) => {
      const panState = panRef.current;
      if (!panState || event.pointerId !== panState.pointerId) return;
      const wrap = scrollWrapRef.current;
      if (!wrap) return;
      const dx = event.clientX - panState.startClientX;
      const dy = event.clientY - panState.startClientY;
      wrap.scrollLeft = panState.startScrollLeft - dx;
      wrap.scrollTop = panState.startScrollTop - dy;
    };

    const clearInteraction = () => {
      interactionRef.current = null;
    };

    const clearPan = () => {
      panRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointermove", handlePanMove);
    window.addEventListener("pointerup", clearInteraction);
    window.addEventListener("pointercancel", clearInteraction);
    window.addEventListener("pointerup", clearPan);
    window.addEventListener("pointercancel", clearPan);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointermove", handlePanMove);
      window.removeEventListener("pointerup", clearInteraction);
      window.removeEventListener("pointercancel", clearInteraction);
      window.removeEventListener("pointerup", clearPan);
      window.removeEventListener("pointercancel", clearPan);
    };
  }, [board.zoom]);

  const patchCard = (id: string, patch: Partial<WhiteboardCard>) => {
    setBoard((prev) => ({
      ...prev,
      cards: prev.cards.map((card) => card.id === id ? { ...card, ...patch, updatedAt: new Date().toISOString() } : card),
    }));
  };

  const addConnection = (fromCardId: string, toCardId: string) => {
    if (fromCardId === toCardId) {
      setPendingConnectionFromId(null);
      return;
    }
    setBoard((prev) => {
      const exists = prev.connections.some((connection) =>
        (connection.fromCardId === fromCardId && connection.toCardId === toCardId) ||
        (connection.fromCardId === toCardId && connection.toCardId === fromCardId)
      );
      if (exists) return prev;
      const nextConnection: WhiteboardConnection = { id: createId("wb-link"), fromCardId, toCardId, createdAt: new Date().toISOString() };
      setSelectedConnectionId(nextConnection.id);
      setSelectedCardId(null);
      return { ...prev, connections: [...prev.connections, nextConnection] };
    });
    setPendingConnectionFromId(null);
  };

  const removeConnection = (id: string) => {
    setBoard((prev) => ({ ...prev, connections: prev.connections.filter((connection) => connection.id !== id) }));
    setSelectedConnectionId((current) => current === id ? null : current);
  };

  const removeCard = (id: string) => {
    setBoard((prev) => ({
      ...prev,
      cards: prev.cards.filter((card) => card.id !== id),
      connections: prev.connections.filter((connection) => connection.fromCardId !== id && connection.toCardId !== id),
    }));
    setSelectedCardId((current) => current === id ? null : current);
    setPendingConnectionFromId((current) => current === id ? null : current);
  };

  const addNote = () => {
    const offset = board.cards.length % 5;
    const next = createNoteCard({ title: t.researchNote, x: 56 + offset * 40, y: 56 + offset * 28, color: "stone" });
    setBoard((prev) => ({ ...prev, cards: [...prev.cards, next] }));
    setSelectedCardId(next.id);
    setSelectedConnectionId(null);
  };

  const addPaper = (doc: ReaderDocument) => {
    setBoard((prev) => {
      if (prev.cards.some((card) => card.type === "paper" && card.docId === doc.id && !card.groupId)) return prev;
      const next = createPaperCard(doc, prev.cards.length, { color: "slate" });
      setSelectedCardId(next.id);
      setSelectedConnectionId(null);
      return { ...prev, cards: [...prev.cards, next] };
    });
  };

  const addPaperCluster = (doc: ReaderDocument) => {
    setBoard((prev) => {
      if (prev.groups.some((group) => group.docId === doc.id)) return prev;
      const clusterIndex = prev.groups.length;
      const groupId = createId("wb-group");
      const groupX = 72 + (clusterIndex % 2) * 520;
      const groupY = 72 + Math.floor(clusterIndex / 2) * 430;
      const nextGroup: WhiteboardGroup = { id: groupId, title: `${doc.title} ${t.cluster}`, x: groupX, y: groupY, width: 980, height: 380, color: "zinc", docId: doc.id, createdAt: new Date().toISOString() };
      const paper = createPaperCard(doc, prev.cards.length, { x: groupX + 28, y: groupY + 56, width: 340, height: 218, groupId, color: "slate" });
      const noteTemplates = [
        createNoteCard({ title: t.problemClaim, content: t.problemClaimDesc, x: groupX + 400, y: groupY + 56, width: 248, height: 170, groupId, color: "stone" }),
        createNoteCard({ title: t.methodsEvidence, content: t.methodsEvidenceDesc, x: groupX + 680, y: groupY + 56, width: 248, height: 170, groupId, color: "olive" }),
        createNoteCard({ title: t.openQuestions, content: t.openQuestionsDesc, x: groupX + 400, y: groupY + 246, width: 528, height: 132, groupId, color: "blue" }),
      ];
      const nextConnections = noteTemplates.map((note) => ({ id: createId("wb-link"), fromCardId: paper.id, toCardId: note.id, createdAt: new Date().toISOString() }));
      setSelectedCardId(paper.id);
      setSelectedConnectionId(null);
      return { ...prev, groups: [...prev.groups, nextGroup], cards: [...prev.cards, paper, ...noteTemplates], connections: [...prev.connections, ...nextConnections] };
    });
  };

  const seedBoard = () => {
    if (recentDocs.length === 0) {
      const intro = createNoteCard({ title: t.readingPlan, content: t.readingPlanDesc, x: 80, y: 80, width: 360, height: 220 });
      setBoard({ version: 2, zoom: board.zoom, cards: [intro], groups: [], connections: [] });
      setSelectedCardId(intro.id);
      setSelectedConnectionId(null);
      return;
    }
    const intro = createNoteCard({ title: t.boardBrief, content: t.boardBriefDesc, x: 88, y: 84, width: 380, height: 220, color: "zinc" });
    let nextBoard: WhiteboardState = { version: 2, zoom: board.zoom, cards: [intro], groups: [], connections: [] };
    for (const doc of recentDocs.slice(0, 2)) {
      const clusterIndex = nextBoard.groups.length;
      const groupId = createId("wb-group");
      const groupX = 120 + (clusterIndex % 2) * 520;
      const groupY = 340 + Math.floor(clusterIndex / 2) * 430;
      const group: WhiteboardGroup = { id: groupId, title: `${doc.title} ${t.cluster}`, x: groupX, y: groupY, width: 980, height: 380, color: "zinc", docId: doc.id, createdAt: new Date().toISOString() };
      const paper = createPaperCard(doc, nextBoard.cards.length, { x: groupX + 28, y: groupY + 56, width: 340, height: 218, groupId, color: "slate" });
      const notes = [
        createNoteCard({ title: t.mainContribution, content: t.mainContributionDesc, x: groupX + 400, y: groupY + 56, width: 248, height: 160, groupId, color: "stone" }),
        createNoteCard({ title: t.evidenceToVerify, content: t.evidenceToVerifyDesc, x: groupX + 680, y: groupY + 56, width: 248, height: 160, groupId, color: "olive" }),
      ];
      const connections = notes.map((note) => ({ id: createId("wb-link"), fromCardId: paper.id, toCardId: note.id, createdAt: new Date().toISOString() }));
      nextBoard = { ...nextBoard, groups: [...nextBoard.groups, group], cards: [...nextBoard.cards, paper, ...notes], connections: [...nextBoard.connections, ...connections] };
    }
    setBoard(nextBoard);
    setSelectedCardId(intro.id);
    setSelectedConnectionId(null);
    setPendingConnectionFromId(null);
  };

  const clearBoard = () => {
    setBoard({ version: 2, zoom: board.zoom, cards: [], groups: [], connections: [] });
    setSelectedCardId(null);
    setSelectedConnectionId(null);
    setPendingConnectionFromId(null);
  };

  const adjustZoom = (delta: number) => {
    setBoard((prev) => ({ ...prev, zoom: normalizeZoom(prev.zoom + delta) }));
  };

  const setZoom = (value: number) => {
    setBoard((prev) => ({ ...prev, zoom: normalizeZoom(value) }));
  };
  return (
    <div className="flex h-full bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 font-sans">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{t.boardTitle}</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.boardStats(board.cards.length, stats.groups, stats.connections)}</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <button onClick={() => setIsPanMode((value) => !value)} className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${isPanMode ? "border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300" : "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
              <Hand size={15} />
              {t.dragCanvas}
              <span className="rounded-md bg-white/70 dark:bg-zinc-900/70 px-1.5 py-0.5 text-[11px] font-mono">{isPanMode ? t.dragCanvasOn : t.dragCanvasOff}</span>
            </button>
            <button onClick={addNote} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-white transition-colors"><StickyNote size={15} />{t.addNote}</button>
            <button onClick={seedBoard} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><Sparkles size={15} />{t.seedBoard}</button>
            <div className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 dark:border-zinc-700 px-2 py-1 bg-white dark:bg-zinc-900">
              <button onClick={() => adjustZoom(-0.1)} className="p-1.5 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" title={t.zoomOut}><ZoomOut size={15} /></button>
              <button onClick={() => setZoom(1)} className="px-2 py-1 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" title={t.resetZoom}>{Math.round(board.zoom * 100)}%</button>
              <button onClick={() => adjustZoom(0.1)} className="p-1.5 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" title={t.zoomIn}><ZoomIn size={15} /></button>
            </div>
            <button onClick={() => setIsSidecarOpen((value) => !value)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><PanelRight size={15} />{isSidecarOpen ? t.hideSidecar : t.showSidecar}</button>
            <button onClick={clearBoard} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><Trash2 size={15} />{t.clearBoard}</button>
          </div>
        </div>

        <div ref={scrollWrapRef} className={`flex-1 overflow-auto p-6 bg-zinc-50 dark:bg-zinc-950 ${isPanMode ? "cursor-grab active:cursor-grabbing" : ""}`}>
          <div className="mx-auto min-w-max">
            <div style={{ width: BOARD_WIDTH * board.zoom, minHeight: BOARD_HEIGHT * board.zoom }}>
              <div
                ref={viewportRef}
                className="relative rounded-3xl border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden"
                style={{ width: BOARD_WIDTH, minHeight: BOARD_HEIGHT, transform: `scale(${board.zoom})`, transformOrigin: "top left", backgroundColor: "rgba(244, 244, 245, 0.82)", backgroundImage: "radial-gradient(circle at 1px 1px, rgba(113,113,122,0.16) 1px, transparent 0)", backgroundSize: "24px 24px" }}
                onPointerDown={(event) => {
                  const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
                  if (!isPanMode && !isRightButton) return;
                  const wrap = scrollWrapRef.current;
                  if (!wrap) return;
                  panRef.current = {
                    pointerId: event.pointerId,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    startScrollLeft: wrap.scrollLeft,
                    startScrollTop: wrap.scrollTop,
                  };
                }}
                onMouseDown={() => {
                  if (isPanMode) return;
                  setSelectedCardId(null);
                  setSelectedConnectionId(null);
                }}
                onWheel={(event) => {
                  if (!event.ctrlKey) return;
                  event.preventDefault();
                  const delta = event.deltaY > 0 ? -0.08 : 0.08;
                  setBoard((prev) => ({ ...prev, zoom: normalizeZoom(prev.zoom + delta) }));
                }}
                onContextMenu={(event) => event.preventDefault()}
              >
                {board.cards.length === 0 ? (
                  <div className="absolute inset-0 flex items-center justify-center p-10 text-center">
                    <div className="max-w-xl rounded-3xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/80 px-8 py-10 backdrop-blur">
                      <LayoutTemplate size={28} className="mx-auto mb-4 text-zinc-400" />
                      <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">{t.emptyTitle}</h2>
                      <p className="text-sm leading-7 text-zinc-600 dark:text-zinc-400 mb-6">{t.emptyDesc}</p>
                      <div className="flex items-center justify-center gap-3 flex-wrap">
                        <button onClick={(event) => { event.stopPropagation(); addNote(); }} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-white transition-colors"><Plus size={15} />{t.addFirstNote}</button>
                        <button onClick={(event) => { event.stopPropagation(); seedBoard(); }} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><FileText size={15} />{t.seedFromPapers}</button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {board.groups.map((group) => {
                  const palette = getPalette(group.color);
                  const groupedCards = board.cards.filter((card) => card.groupId === group.id);
                  return (
                    <div key={group.id} className="absolute rounded-[28px] border border-dashed pointer-events-none" style={{ left: group.x, top: group.y, width: group.width, height: group.height, borderColor: palette.border, backgroundColor: palette.chip }}>
                      <div className="absolute left-5 top-4 flex items-center gap-3">
                        <span className="inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ backgroundColor: palette.fill, color: palette.text }}>{t.cluster}</span>
                        <div>
                          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{group.title}</div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{groupedCards.length} {t.cardsNoun} {group.docId ? t.linkedToPaper : t.inCluster}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <svg className="absolute inset-0 h-full w-full overflow-visible">
                  {board.connections.map((connection) => {
                    const from = cardMap.get(connection.fromCardId);
                    const to = cardMap.get(connection.toCardId);
                    if (!from || !to) return null;
                    const active = connection.id === selectedConnectionId;
                    const path = buildConnectionPath(from, to);
                    return (
                      <g key={connection.id} className="cursor-pointer" onMouseDown={(event) => { event.stopPropagation(); setSelectedConnectionId(connection.id); setSelectedCardId(null); }}>
                        <path d={path} fill="none" stroke="transparent" strokeWidth={18} />
                        <path d={path} fill="none" stroke={active ? "#18181b" : "rgba(82,82,91,0.56)"} strokeWidth={active ? 3 : 2} strokeDasharray={active ? "0" : "6 6"} strokeLinecap="round" />
                      </g>
                    );
                  })}
                </svg>
                {board.cards.map((card) => {
                  const linkedDoc = card.docId ? documentMap.get(card.docId) : undefined;
                  const selected = selectedCardId === card.id;
                  const palette = getPalette(card.color);
                  const linking = pendingConnectionFromId === card.id;
                  return (
                    <div key={card.id} className={`absolute rounded-2xl border shadow-lg overflow-hidden ${selected ? "ring-2 ring-zinc-900/20 dark:ring-zinc-100/15" : "ring-0"}`} style={{ left: card.x, top: card.y, width: card.width, minHeight: card.height, backgroundColor: palette.fill, borderColor: selected ? palette.border : "rgba(228, 228, 231, 0.96)" }} onMouseDown={(event) => { event.stopPropagation(); if (isPanMode || event.button === 2) return; setSelectedCardId(card.id); setSelectedConnectionId(null); }}>
                      <div className="flex items-center justify-between px-3 py-2 border-b cursor-grab active:cursor-grabbing" style={{ backgroundColor: palette.chip, borderColor: "rgba(228, 228, 231, 0.88)" }} onPointerDown={(event) => { event.stopPropagation(); if (isPanMode || event.button !== 0) return; const point = clientToBoard(event.clientX, event.clientY); interactionRef.current = { type: "drag", cardId: card.id, pointerBoardX: point.x, pointerBoardY: point.y, startX: card.x, startY: card.y, width: card.width, height: card.height }; setSelectedCardId(card.id); setSelectedConnectionId(null); }}>
                        <div className="flex items-center gap-2 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-[0.16em]">
                          {card.type === "note" ? <StickyNote size={13} /> : <FileText size={13} />}
                          {card.type === "note" ? t.note : t.paper}
                          <span className="inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette.border }} />
                        </div>
                        <div className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
                          <button className={`p-1 rounded-md transition-colors ${linking ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-white/70 dark:hover:bg-zinc-800"}`} onClick={(event) => { event.stopPropagation(); if (pendingConnectionFromId && pendingConnectionFromId !== card.id) { addConnection(pendingConnectionFromId, card.id); return; } setPendingConnectionFromId((current) => current === card.id ? null : card.id); setSelectedCardId(card.id); setSelectedConnectionId(null); }} title={linking ? t.cancelLinking : pendingConnectionFromId ? t.connectToCard : t.startLinking}><Link2 size={13} /></button>
                          <Move size={13} />
                          <button className="p-1 rounded-md hover:bg-white/70 dark:hover:bg-zinc-800 hover:text-red-500 transition-colors" onClick={(event) => { event.stopPropagation(); removeCard(card.id); }} title={t.removeCard}><Trash2 size={13} /></button>
                        </div>
                      </div>

                      <div className="p-3 space-y-3" style={{ color: palette.text }}>
                        <input value={card.title} onChange={(event) => patchCard(card.id, { title: event.target.value })} className="w-full bg-transparent text-sm font-semibold border-0 border-b border-zinc-200 dark:border-zinc-800 pb-2 focus:outline-none" />
                        {card.type === "paper" ? (
                          <>
                            <textarea value={card.content} onChange={(event) => patchCard(card.id, { content: event.target.value })} className="w-full bg-transparent resize-none text-sm leading-6 border-0 focus:outline-none text-zinc-700 dark:text-zinc-300" style={{ minHeight: Math.max(84, card.height - 132) }} />
                            {linkedDoc ? (
                              <div className="space-y-2">
                                <div className="text-xs text-zinc-500 dark:text-zinc-400 leading-5">{linkedDoc.authors.length > 0 ? linkedDoc.authors.join(", ") : t.unknownAuthors}</div>
                                <button onClick={() => onOpenPdf(linkedDoc)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-white transition-colors"><FileText size={13} />{t.openPdf}</button>
                              </div>
                            ) : (
                              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t.linkedMissing}</div>
                            )}
                          </>
                        ) : (
                          <textarea value={card.content} onChange={(event) => patchCard(card.id, { content: event.target.value })} className="w-full bg-transparent resize-none text-sm leading-6 border-0 focus:outline-none text-zinc-700 dark:text-zinc-300" style={{ minHeight: Math.max(96, card.height - 96) }} placeholder={t.notePlaceholder} />
                        )}
                      </div>

                      <button className="absolute right-2 bottom-2 h-5 w-5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white/90 dark:bg-zinc-900/90 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-se-resize" title={t.resizeCard} onPointerDown={(event) => { event.stopPropagation(); if (isPanMode || event.button !== 0) return; const point = clientToBoard(event.clientX, event.clientY); interactionRef.current = { type: "resize", cardId: card.id, pointerBoardX: point.x, pointerBoardY: point.y, startWidth: card.width, startHeight: card.height, x: card.x, y: card.y }; setSelectedCardId(card.id); setSelectedConnectionId(null); }}>
                        <span className="block h-full w-full bg-[linear-gradient(135deg,transparent_35%,currentColor_35%,currentColor_45%,transparent_45%,transparent_60%,currentColor_60%,currentColor_70%,transparent_70%)] opacity-60" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      <aside className={`${isSidecarOpen ? "w-96" : "w-0"} transition-[width] duration-300 ease-in-out shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hidden xl:flex xl:flex-col overflow-hidden`}>
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{selectedCard ? t.inspector : selectedConnection ? t.connection : t.sidecar}</div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{pendingConnectionFromId ? t.sidecarLinkHint : t.sidecarDefaultHint}</p>
        </div>

        <div className="w-96 flex-1 overflow-auto p-4 space-y-4">
          {selectedCard ? (
            <div className="rounded-3xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 space-y-4">
              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400 mb-2">{t.selectedCard}</div>
                <input value={selectedCard.title} onChange={(event) => patchCard(selectedCard.id, { title: event.target.value })} className="w-full bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-3 py-2 text-sm font-medium focus:outline-none" />
              </div>

              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400 mb-2">{t.colorTag}</div>
                <div className="grid grid-cols-5 gap-2">
                  {CARD_PALETTE.map((palette) => (
                    <button key={palette.id} onClick={() => patchCard(selectedCard.id, { color: palette.id })} className={`rounded-2xl border px-2 py-3 text-[11px] font-medium transition-colors ${selectedCard.color === palette.id ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100" : "border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400"}`} style={{ backgroundColor: palette.chip }}>
                      <span className="mx-auto mb-2 block h-3 w-3 rounded-full" style={{ backgroundColor: palette.border }} />{colorLabelById[palette.id]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400 mb-2">{t.content}</div>
                <textarea value={selectedCard.content} onChange={(event) => patchCard(selectedCard.id, { content: event.target.value })} className="w-full min-h-[180px] rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3 text-sm leading-6 focus:outline-none resize-none" />
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3">{t.size} {Math.round(selectedCard.width)} × {Math.round(selectedCard.height)}</div>
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3">{selectedCard.groupId ? t.clusteredCard : t.freeformCard}</div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => setPendingConnectionFromId((current) => current === selectedCard.id ? null : selectedCard.id)} className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${pendingConnectionFromId === selectedCard.id ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900" : "border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}><Link2 size={13} />{pendingConnectionFromId === selectedCard.id ? t.linking : t.startLink}</button>
                <button onClick={() => removeCard(selectedCard.id)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><Trash2 size={13} />{t.deleteCard}</button>
                {selectedCard.docId && documentMap.get(selectedCard.docId) ? (
                  <button onClick={() => { const doc = documentMap.get(selectedCard.docId as string); if (doc) onOpenPdf(doc); }} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-white transition-colors"><FileText size={13} />{t.openLinkedPdf}</button>
                ) : null}
              </div>
            </div>
          ) : selectedConnection ? (
            <div className="rounded-3xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 space-y-4">
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">{t.selectedLink}</div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-4 space-y-2">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{cardMap.get(selectedConnection.fromCardId)?.title || t.missingCard}</div>
                <div className="text-xs text-zinc-400">{t.connectsTo}</div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{cardMap.get(selectedConnection.toCardId)?.title || t.missingCard}</div>
              </div>
              <button onClick={() => removeConnection(selectedConnection.id)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><Trash2 size={13} />{t.deleteLink}</button>
            </div>
          ) : (
            <div className="rounded-3xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 p-5 text-sm leading-7 text-zinc-600 dark:text-zinc-400">{t.selectHint}</div>
          )}

          <div className="rounded-3xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t.recentPapers}</div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.recentDesc}</p>
            </div>
            {recentDocs.length > 0 ? recentDocs.map((doc) => (
              <div key={doc.id} className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 space-y-3">
                <div>
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2">{doc.title}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">{doc.authors.length > 0 ? doc.authors.join(", ") : t.unknownAuthors}</div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => addPaper(doc)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-white transition-colors"><Plus size={12} />{t.paperCard}</button>
                  <button onClick={() => addPaperCluster(doc)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><Sparkles size={12} />{t.researchCluster}</button>
                  <button onClick={() => onOpenPdf(doc)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><FileText size={12} />{t.open}</button>
                </div>
              </div>
            )) : (
              <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-4 text-sm text-zinc-500 dark:text-zinc-400">{t.importHint}</div>
            )}
          </div>

          <div className="rounded-3xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">{t.boardSnapshot}</div>
            <div className="grid grid-cols-2 gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3">{t.notes}: {stats.notes}</div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3">{t.papers}: {stats.papers}</div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3">{t.clusters}: {stats.groups}</div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3">{t.links}: {stats.connections}</div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

