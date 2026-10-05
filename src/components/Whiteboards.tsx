import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  LayoutTemplate,
  Plus,
  StickyNote,
  Trash2,
  ZoomIn,
  ZoomOut,
  PanelRight,
} from "lucide-react";
import type { ReaderAnnotationRect, ReaderDocument, ReaderNote } from "../types";
import type { AppLanguage } from "../services/userSettings";
import { readVersionedLocalState, writeVersionedLocalState } from "../services/localStore";
import { BOARD_COLOR_ORDER, BOARD_PALETTE, normalizeCardColor, type CardColor } from "../theme/boardPalette";
import { WhiteboardCanvas } from "./WhiteboardCanvas";

interface WhiteboardsProps {
  documents: ReaderDocument[];
  notesByDocument: Record<string, ReaderNote[]>;
  onOpenPdf: (doc: ReaderDocument) => void;
  onOpenPdfAt?: (doc: ReaderDocument, page: number, sourceRect?: ReaderAnnotationRect) => void;
  language: AppLanguage;
}

export type WhiteboardCard = {
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
  source?: {
    noteId?: string;
    documentId: string;
    blockId?: string;
    page: number;
    sourceRect?: ReaderAnnotationRect;
    reference?: string;
  };
  updatedAt: string;
};
export type WhiteboardConnection = {
  id: string;
  fromCardId: string;
  toCardId: string;
  createdAt: string;
};
export type WhiteboardGroup = {
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
export type WhiteboardState = {
  version: 2;
  zoom: number;
  cards: WhiteboardCard[];
  connections: WhiteboardConnection[];
  groups: WhiteboardGroup[];
};
const I18N = {
  "zh-CN": {
    boardTitle: "白板",
    boardStats: (cards: number, groups: number, connections: number) => `${cards} 张卡片，${groups} 个分组，${connections} 条连接`,
    addNote: "添加笔记",
    seedBoard: "套用研究模板",
    zoomOut: "缩小",
    resetZoom: "重置缩放",
    zoomIn: "放大",
    clearBoard: "清空白板",
    clearBoardConfirm: "当前白板内容将被清空，是否继续？",
    seedBoardConfirm: "套用模板会替换当前白板内容，是否继续？",
    emptyTitle: "搭建可执行的研究白板",
    emptyDesc: "创建论文分组、调整卡片大小、编辑笔记颜色，并通过真实连线组织思路，所有内容会本地持久化。",
    addFirstNote: "添加第一条笔记",
    seedFromPapers: "从论文套用模板",
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
    openSource: "回到来源",
    readingNotes: "阅读笔记",
    readingNotesDesc: "将已有笔记作为带来源的卡片加入白板。",
    addReadingNote: "加入白板",
    noReadingNotes: "暂无已保存的阅读笔记。",
    sourcePage: "来源页",
    sourceBlock: "阅读块",
    selectedLink: "当前连接",
    connectsTo: "连接到",
    missingCard: "卡片不存在",
    deleteLink: "删除连接",
    selectHint: "选择一张卡片可编辑颜色和内容，或点击虚线连接将其删除。",
    recentPapers: "最近论文",
    recentDesc: "可创建单论文卡片，或基于单篇论文快速搭建研究分组。",
    paperCard: "论文卡片",
    researchCluster: "模板分组",
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
    colorBlue: "蓝色",
    dragCanvas: "\u62d6\u52a8\u753b\u5e03",
    dragCanvasOn: "\u5df2\u5f00\u542f",
    dragCanvasOff: "\u5df2\u5173\u95ed",
  },
  "en-US": {
    boardTitle: "Whiteboards",
    boardStats: (cards: number, groups: number, connections: number) => `${cards} cards, ${groups} clusters, ${connections} links`,
    addNote: "Add Note",
    seedBoard: "Apply Research Template",
    zoomOut: "Zoom out",
    resetZoom: "Reset zoom",
    zoomIn: "Zoom in",
    clearBoard: "Clear Board",
    clearBoardConfirm: "The current board will be cleared. Continue?",
    seedBoardConfirm: "Applying a template will replace the current board. Continue?",
    emptyTitle: "Build a working research board",
    emptyDesc: "Create paper clusters, resize cards, edit note colors, and connect ideas with real links that stay persisted locally.",
    addFirstNote: "Add First Note",
    seedFromPapers: "Apply Paper Template",
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
    openSource: "Open source",
    readingNotes: "Reading notes",
    readingNotesDesc: "Add existing notes as source-linked cards.",
    addReadingNote: "Add to board",
    noReadingNotes: "No saved reading notes yet.",
    sourcePage: "Source page",
    sourceBlock: "Reading block",
    selectedLink: "Selected link",
    connectsTo: "connects to",
    missingCard: "Missing card",
    deleteLink: "Delete Link",
    selectHint: "Select a card to edit its color tag and content, or click a dashed connection to remove it.",
    recentPapers: "Recent Papers",
    recentDesc: "Create a paper-only card or scaffold a clustered research board from one paper.",
    paperCard: "Paper Card",
    researchCluster: "Template Cluster",
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
    colorBlue: "Blue",
    dragCanvas: "Drag canvas",
    dragCanvasOn: "On",
    dragCanvasOff: "Off",
  },
} as const;

const STORAGE_KEY = "r0nix_reader_whiteboard_v1";
const STORAGE_VERSION = 2;
const BOARD_WIDTH = 1920;
const BOARD_HEIGHT = 1280;
const MIN_CARD_WIDTH = 220;
const MIN_CARD_HEIGHT = 150;
const MAX_CARD_WIDTH = 560;
const MAX_CARD_HEIGHT = 460;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.6;

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeZoom(value: number) {
  return clamp(Number.isFinite(value) ? value : 1, MIN_ZOOM, MAX_ZOOM);
}

function sanitizeSource(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    noteId?: unknown;
    documentId?: unknown;
    blockId?: unknown;
    page?: unknown;
    sourceRect?: Partial<ReaderAnnotationRect>;
    reference?: unknown;
  };
  if (typeof candidate.documentId !== "string" || !candidate.documentId.trim()) return undefined;
  const page = typeof candidate.page === "number" && Number.isFinite(candidate.page)
    ? Math.max(1, Math.round(candidate.page))
    : 1;
  const rect = candidate.sourceRect;
  const sourceRect = rect &&
    typeof rect.x === "number" && typeof rect.y === "number" &&
    typeof rect.width === "number" && typeof rect.height === "number"
    ? {
        x: clamp(rect.x, 0, 1),
        y: clamp(rect.y, 0, 1),
        width: clamp(rect.width, 0.002, 1),
        height: clamp(rect.height, 0.002, 1),
      }
    : undefined;
  return {
    noteId: typeof candidate.noteId === "string" && candidate.noteId ? candidate.noteId : undefined,
    documentId: candidate.documentId,
    blockId: typeof candidate.blockId === "string" && candidate.blockId ? candidate.blockId : undefined,
    page,
    sourceRect,
    reference: typeof candidate.reference === "string" && candidate.reference.trim() ? candidate.reference.trim() : undefined,
  };
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
    color: normalizeCardColor(item.color),
    groupId: typeof item.groupId === "string" ? item.groupId : undefined,
    docId: typeof item.docId === "string" ? item.docId : undefined,
    source: sanitizeSource(item.source),
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
    color: normalizeCardColor(item.color),
    docId: typeof item.docId === "string" ? item.docId : undefined,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
  };
}

function loadBoardState(): WhiteboardState {
  const empty: WhiteboardState = { version: 2, zoom: 1, cards: [], connections: [], groups: [] };
  return readVersionedLocalState(STORAGE_KEY, STORAGE_VERSION, empty, (parsed) => {
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
    const groupIds = new Set(groups.map((group) => group.id));
    for (const card of cards) {
      if (card.groupId && !groupIds.has(card.groupId)) card.groupId = undefined;
    }
    return { version: 2, zoom: normalizeZoom(candidate.zoom ?? 1), cards, groups, connections };
  });
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
    color: normalizeCardColor(seed?.color),
    groupId: typeof seed?.groupId === "string" ? seed.groupId : undefined,
    source: seed?.source,
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
    color: normalizeCardColor(seed?.color ?? "zinc"),
    groupId: typeof seed?.groupId === "string" ? seed.groupId : undefined,
    docId: doc.id,
    updatedAt: new Date().toISOString(),
  };
}

export function Whiteboards({ documents, notesByDocument, onOpenPdf, onOpenPdfAt, language }: WhiteboardsProps) {
  const [board, setBoard] = useState<WhiteboardState>(loadBoardState);
  const t = I18N[language];
  const colorLabelById: Record<CardColor, string> = {
    zinc: t.colorZinc,
    blue: t.colorBlue,
  };
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [isSidecarOpen, setIsSidecarOpen] = useState(true);
  const documentMap = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const cardMap = useMemo(() => new Map(board.cards.map((card) => [card.id, card])), [board.cards]);
  const recentDocs = useMemo(() => documents.slice(0, 6), [documents]);
  const readingNotes = useMemo(
    () => recentDocs.flatMap((doc) => (notesByDocument[doc.id] || []).map((note) => ({ doc, note }))).slice(0, 10),
    [notesByDocument, recentDocs],
  );
  const selectedCard = selectedCardId ? cardMap.get(selectedCardId) || null : null;
  const selectedConnection = useMemo(() => board.connections.find((connection) => connection.id === selectedConnectionId) || null, [board.connections, selectedConnectionId]);
  const stats = useMemo(() => ({
    notes: board.cards.filter((card) => card.type === "note").length,
    papers: board.cards.filter((card) => card.type === "paper").length,
    groups: board.groups.length,
    connections: board.connections.length,
  }), [board.cards, board.groups, board.connections]);

  useEffect(() => {
    writeVersionedLocalState(STORAGE_KEY, STORAGE_VERSION, board);
  }, [board]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedConnectionId(null);
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (selectedConnectionId) {
        removeConnection(selectedConnectionId);
      } else if (selectedCardId) {
        removeCard(selectedCardId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedCardId, selectedConnectionId]);

  const patchCard = (id: string, patch: Partial<WhiteboardCard>) => {
    setBoard((prev) => ({
      ...prev,
      cards: prev.cards.map((card) => card.id === id ? { ...card, ...patch, updatedAt: new Date().toISOString() } : card),
    }));
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
  };

  const addNote = () => {
    const offset = board.cards.length % 5;
    const next = createNoteCard({ title: t.researchNote, x: 56 + offset * 40, y: 56 + offset * 28, color: "zinc" });
    setBoard((prev) => ({ ...prev, cards: [...prev.cards, next] }));
    setSelectedCardId(next.id);
    setSelectedConnectionId(null);
  };

  const addReadingNote = (doc: ReaderDocument, note: ReaderNote) => {
    const source = {
      noteId: note.id,
      documentId: doc.id,
      blockId: note.blockId,
      page: note.page,
      sourceRect: note.sourceRect,
      reference: note.reference,
    };
    setBoard((prev) => {
      const exists = prev.cards.some((card) => card.source?.noteId === note.id);
      if (exists) return prev;
      const next = createNoteCard({
        title: note.reference || `${t.readingNotes} · ${doc.title}`,
        content: note.content,
        source,
        x: 56 + (prev.cards.length % 5) * 40,
        y: 56 + (prev.cards.length % 5) * 28,
        color: "blue",
      });
      setSelectedCardId(next.id);
      setSelectedConnectionId(null);
      return { ...prev, cards: [...prev.cards, next] };
    });
  };

  const addPaper = (doc: ReaderDocument) => {
    setBoard((prev) => {
      if (prev.cards.some((card) => card.type === "paper" && card.docId === doc.id && !card.groupId)) return prev;
      const next = createPaperCard(doc, prev.cards.length, { color: "zinc" });
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
      const paper = createPaperCard(doc, prev.cards.length, { x: groupX + 28, y: groupY + 56, width: 340, height: 218, groupId, color: "zinc" });
      const noteTemplates = [
        createNoteCard({ title: t.problemClaim, content: t.problemClaimDesc, x: groupX + 400, y: groupY + 56, width: 248, height: 170, groupId, color: "zinc" }),
        createNoteCard({ title: t.methodsEvidence, content: t.methodsEvidenceDesc, x: groupX + 680, y: groupY + 56, width: 248, height: 170, groupId, color: "zinc" }),
        createNoteCard({ title: t.openQuestions, content: t.openQuestionsDesc, x: groupX + 400, y: groupY + 246, width: 528, height: 132, groupId, color: "blue" }),
      ];
      const nextConnections = noteTemplates.map((note) => ({ id: createId("wb-link"), fromCardId: paper.id, toCardId: note.id, createdAt: new Date().toISOString() }));
      setSelectedCardId(paper.id);
      setSelectedConnectionId(null);
      return { ...prev, groups: [...prev.groups, nextGroup], cards: [...prev.cards, paper, ...noteTemplates], connections: [...prev.connections, ...nextConnections] };
    });
  };

  const seedBoard = () => {
    if ((board.cards.length > 0 || board.groups.length > 0 || board.connections.length > 0) && !window.confirm(t.seedBoardConfirm)) return;
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
      const paper = createPaperCard(doc, nextBoard.cards.length, { x: groupX + 28, y: groupY + 56, width: 340, height: 218, groupId, color: "zinc" });
      const notes = [
        createNoteCard({ title: t.mainContribution, content: t.mainContributionDesc, x: groupX + 400, y: groupY + 56, width: 248, height: 160, groupId, color: "zinc" }),
        createNoteCard({ title: t.evidenceToVerify, content: t.evidenceToVerifyDesc, x: groupX + 680, y: groupY + 56, width: 248, height: 160, groupId, color: "zinc" }),
      ];
      const connections = notes.map((note) => ({ id: createId("wb-link"), fromCardId: paper.id, toCardId: note.id, createdAt: new Date().toISOString() }));
      nextBoard = { ...nextBoard, groups: [...nextBoard.groups, group], cards: [...nextBoard.cards, paper, ...notes], connections: [...nextBoard.connections, ...connections] };
    }
    setBoard(nextBoard);
    setSelectedCardId(intro.id);
    setSelectedConnectionId(null);
  };

  const clearBoard = () => {
    if ((board.cards.length > 0 || board.groups.length > 0 || board.connections.length > 0) && !window.confirm(t.clearBoardConfirm)) return;
    setBoard({ version: 2, zoom: board.zoom, cards: [], groups: [], connections: [] });
    setSelectedCardId(null);
    setSelectedConnectionId(null);
  };

  const adjustZoom = (delta: number) => {
    setBoard((prev) => ({ ...prev, zoom: normalizeZoom(prev.zoom + delta) }));
  };

  const setZoom = (value: number) => {
    setBoard((prev) => ({ ...prev, zoom: normalizeZoom(value) }));
  };
  return (
    <div className="flex h-full bg-surface-panel text-content-primary font-sans">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-content-primary">{t.boardTitle}</h1>
            <p className="text-xs text-content-muted mt-1">{t.boardStats(board.cards.length, stats.groups, stats.connections)}</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <button onClick={addNote} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-content-primary text-content-inverse hover:bg-content-primary-hover transition-colors"><StickyNote size={15} />{t.addNote}</button>
            <button onClick={seedBoard} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><LayoutTemplate size={15} />{t.seedBoard}</button>
            <div className="inline-flex items-center gap-1 rounded-xl border border-border-default px-2 py-1 bg-surface-panel">
              <button onClick={() => adjustZoom(-0.1)} className="p-1.5 rounded-lg text-content-muted hover:bg-surface-hover transition-colors" title={t.zoomOut}><ZoomOut size={15} /></button>
              <button onClick={() => setZoom(1)} className="px-2 py-1 text-xs font-medium rounded-lg text-content-secondary hover:bg-surface-hover transition-colors" title={t.resetZoom}>{Math.round(board.zoom * 100)}%</button>
              <button onClick={() => adjustZoom(0.1)} className="p-1.5 rounded-lg text-content-muted hover:bg-surface-hover transition-colors" title={t.zoomIn}><ZoomIn size={15} /></button>
            </div>
            <button onClick={() => setIsSidecarOpen((value) => !value)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><PanelRight size={15} />{isSidecarOpen ? t.hideSidecar : t.showSidecar}</button>
            <button onClick={clearBoard} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><Trash2 size={15} />{t.clearBoard}</button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 bg-surface-app">
          <WhiteboardCanvas
            board={board}
            documents={documentMap}
            language={language}
            onBoardChange={(updater) => setBoard(updater)}
            onSelectCard={(id) => { setSelectedCardId(id); setSelectedConnectionId(null); }}
            onSelectConnection={(id) => { setSelectedConnectionId(id); setSelectedCardId(null); }}
          />
          {board.cards.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-10 text-center">
              <div className="pointer-events-auto max-w-xl rounded-3xl border border-dashed border-border-default bg-surface-panel/90 px-8 py-10 shadow-sm backdrop-blur">
                <LayoutTemplate size={28} className="mx-auto mb-4 text-content-disabled" />
                <h2 className="text-2xl font-semibold text-content-primary mb-3">{t.emptyTitle}</h2>
                <p className="text-sm leading-7 text-content-secondary mb-6">{t.emptyDesc}</p>
                <div className="flex items-center justify-center gap-3 flex-wrap">
                  <button onClick={addNote} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-content-primary text-content-inverse hover:bg-content-primary-hover transition-colors"><Plus size={15} />{t.addFirstNote}</button>
                  <button onClick={seedBoard} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><FileText size={15} />{t.seedFromPapers}</button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <aside className={`${isSidecarOpen ? "w-96" : "w-0"} transition-[width] duration-300 ease-in-out shrink-0 border-l border-border-subtle bg-surface-panel hidden xl:flex xl:flex-col overflow-hidden`}>
        <div className="px-5 py-4 border-b border-border-subtle">
          <div className="text-sm font-semibold text-content-primary">{selectedCard ? t.inspector : selectedConnection ? t.connection : t.sidecar}</div>
          <p className="text-xs text-content-muted mt-1">{t.sidecarDefaultHint}</p>
        </div>

        <div className="w-96 flex-1 overflow-auto p-4 space-y-4">
          {selectedCard ? (
            <div className="rounded-3xl border border-border-subtle bg-surface-app p-4 space-y-4">
              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-content-muted mb-2">{t.selectedCard}</div>
                <input value={selectedCard.title} onChange={(event) => patchCard(selectedCard.id, { title: event.target.value })} className="w-full bg-surface-panel rounded-xl border border-border-subtle px-3 py-2 text-sm font-medium" />
              </div>

              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-content-muted mb-2">{t.colorTag}</div>
                <div className="grid grid-cols-5 gap-2">
                  {BOARD_COLOR_ORDER.map((id) => {
                    const swatch = BOARD_PALETTE[id];
                    return (
                      <button key={id} onClick={() => patchCard(selectedCard.id, { color: id })} className={`rounded-2xl border px-2 py-3 text-[11px] font-medium transition-colors ${selectedCard.color === id ? "border-content-primary text-content-primary" : "border-border-default text-content-muted"}`} style={{ backgroundColor: swatch.chip }}>
                        <span className="mx-auto mb-2 block h-3 w-3 rounded-full" style={{ backgroundColor: swatch.border }} />{colorLabelById[id]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-content-muted mb-2">{t.content}</div>
                <textarea value={selectedCard.content} onChange={(event) => patchCard(selectedCard.id, { content: event.target.value })} className="w-full min-h-[180px] rounded-2xl border border-border-subtle bg-surface-panel px-3 py-3 text-sm leading-6 resize-none" />
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs text-content-muted">
                <div className="rounded-2xl border border-border-subtle bg-surface-panel px-3 py-3">{t.size} {Math.round(selectedCard.width)} × {Math.round(selectedCard.height)}</div>
                <div className="rounded-2xl border border-border-subtle bg-surface-panel px-3 py-3">{selectedCard.groupId ? t.clusteredCard : t.freeformCard}</div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => removeCard(selectedCard.id)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><Trash2 size={13} />{t.deleteCard}</button>
                {selectedCard.docId && documentMap.get(selectedCard.docId) ? (
                  <button onClick={() => { const doc = documentMap.get(selectedCard.docId as string); if (doc) onOpenPdf(doc); }} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium bg-content-primary text-content-inverse hover:bg-content-primary-hover transition-colors"><FileText size={13} />{t.openLinkedPdf}</button>
                ) : null}
                {selectedCard.source && documentMap.get(selectedCard.source.documentId) ? (
                  <button onClick={() => { const doc = documentMap.get(selectedCard.source?.documentId || ""); if (doc) (onOpenPdfAt || onOpenPdf)(doc, selectedCard.source?.page || 1, selectedCard.source?.sourceRect); }} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium bg-[var(--reader-accent)] text-[var(--reader-accent-contrast)] hover:opacity-90 transition-opacity"><FileText size={13} />{t.openSource} · {t.sourcePage} {selectedCard.source.page}</button>
                ) : null}
              </div>
            </div>
          ) : selectedConnection ? (
            <div className="rounded-3xl border border-border-subtle bg-surface-app p-4 space-y-4">
              <div className="text-xs uppercase tracking-[0.16em] text-content-muted">{t.selectedLink}</div>
              <div className="rounded-2xl border border-border-subtle bg-surface-panel px-4 py-4 space-y-2">
                <div className="text-sm font-medium text-content-primary">{cardMap.get(selectedConnection.fromCardId)?.title || t.missingCard}</div>
                <div className="text-xs text-content-disabled">{t.connectsTo}</div>
                <div className="text-sm font-medium text-content-primary">{cardMap.get(selectedConnection.toCardId)?.title || t.missingCard}</div>
              </div>
              <button onClick={() => removeConnection(selectedConnection.id)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><Trash2 size={13} />{t.deleteLink}</button>
            </div>
          ) : (
            <div className="rounded-3xl border border-dashed border-border-default bg-surface-app p-5 text-sm leading-7 text-content-secondary">{t.selectHint}</div>
          )}

          <div className="rounded-3xl border border-border-subtle bg-surface-app p-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-content-primary">{t.recentPapers}</div>
              <p className="text-xs text-content-muted mt-1">{t.recentDesc}</p>
            </div>
            {recentDocs.length > 0 ? recentDocs.map((doc) => (
              <div key={doc.id} className="rounded-2xl border border-border-subtle bg-surface-panel p-3 space-y-3">
                <div>
                  <div className="text-sm font-medium text-content-primary line-clamp-2">{doc.title}</div>
                  <div className="text-xs text-content-muted mt-1 line-clamp-2">{doc.authors.length > 0 ? doc.authors.join(", ") : t.unknownAuthors}</div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => addPaper(doc)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-content-primary text-content-inverse hover:bg-content-primary-hover transition-colors"><Plus size={12} />{t.paperCard}</button>
                  <button onClick={() => addPaperCluster(doc)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><LayoutTemplate size={12} />{t.researchCluster}</button>
                  <button onClick={() => onOpenPdf(doc)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-border-default bg-surface-panel text-content-secondary hover:bg-surface-hover transition-colors"><FileText size={12} />{t.open}</button>
                </div>
              </div>
            )) : (
              <div className="rounded-2xl border border-dashed border-border-default p-4 text-sm text-content-muted">{t.importHint}</div>
            )}
          </div>

          <div className="rounded-3xl border border-border-subtle bg-surface-app p-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-content-primary">{t.readingNotes}</div>
              <p className="text-xs text-content-muted mt-1">{t.readingNotesDesc}</p>
            </div>
            {readingNotes.length > 0 ? readingNotes.map(({ doc, note }) => (
              <div key={`${doc.id}:${note.id}`} className="rounded-2xl border border-border-subtle bg-surface-panel p-3 space-y-2">
                <div className="text-xs font-medium text-content-primary line-clamp-1">{doc.title}</div>
                <div className="text-sm leading-6 text-content-secondary line-clamp-3">{note.content}</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-content-muted">{t.sourcePage} {note.page}{note.blockId ? ` · ${t.sourceBlock}` : ""}</span>
                  <button onClick={() => addReadingNote(doc, note)} className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-2 py-1 text-[11px] font-medium text-content-secondary hover:bg-surface-hover"><Plus size={12} />{t.addReadingNote}</button>
                </div>
              </div>
            )) : <div className="rounded-2xl border border-dashed border-border-default p-4 text-xs text-content-muted">{t.noReadingNotes}</div>}
          </div>

          <div className="rounded-3xl border border-border-subtle bg-surface-app p-4">
            <div className="text-sm font-semibold text-content-primary mb-2">{t.boardSnapshot}</div>
            <div className="grid grid-cols-2 gap-3 text-xs text-content-muted">
              <div className="rounded-2xl border border-border-subtle bg-surface-panel px-3 py-3">{t.notes}: {stats.notes}</div>
              <div className="rounded-2xl border border-border-subtle bg-surface-panel px-3 py-3">{t.papers}: {stats.papers}</div>
              <div className="rounded-2xl border border-border-subtle bg-surface-panel px-3 py-3">{t.clusters}: {stats.groups}</div>
              <div className="rounded-2xl border border-border-subtle bg-surface-panel px-3 py-3">{t.links}: {stats.connections}</div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
