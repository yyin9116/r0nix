import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Link2,
  ExternalLink,
  Languages,
  List,
  Maximize,
  MessageSquare,
  MousePointer2,
  Pencil,
  Search,
  Sparkles,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import * as api from "../services/pdfApi";
import type { AppLanguage } from "../services/userSettings";
import type { PdfReadingBlock, PdfViewState, ReaderAnnotation, ReaderAnnotationKind, ReaderNote } from "../types";
import type { PDFImageInfo } from "../services/pdfApi";
import { ContextMenu, buildViewerContextActions } from "./ContextMenu";
import { ReadingAssistMenu, type ReadingAssistSelection } from "./ReadingAssistMenu";
import {
  translateReadingBlock,
  translateReadingBlocks,
  translateReadingSelection,
  type LlmServiceConfig,
  type TranslationBlockResult,
} from "../services/readingAssistant";
import { loadTranslationCache, saveTranslationCache } from "../services/translationCache";
import { buildDomPdfReadingBlocks } from "../services/pdfBlocks";
import { loadResourceIndex, saveResourceIndex, type CachedResourceLink } from "../services/resourceIndexCache";
import "./PDFViewer.css";

interface PDFViewerProps {
  title: string;
  documentId?: string;
  fileId?: string;
  language: AppLanguage;
  notes: ReaderNote[];
  annotations: ReaderAnnotation[];
  onOpenFileDialog?: () => void;
  onAddNote?: (page: number, content: string, kind: ReaderNote["kind"], reference?: string, source?: { documentId?: string; blockId?: string; sourceRect?: ReaderNote["sourceRect"] }) => void;
  onUpdateNote?: (noteId: string, content: string) => void;
  onRemoveNote?: (noteId: string) => void;
  onAddAnnotation?: (annotation: Omit<ReaderAnnotation, "id" | "createdAt">) => void;
  onRemoveAnnotation?: (annotationId: string) => void;
  onResolveDefaultPath?: (fileName: string) => string;
  onProgress?: (page: number, totalPages: number) => void;
  initialViewState?: PdfViewState;
  onViewStateChange?: (state: PdfViewState) => void;
  onOpenExternal?: (url: string) => void;
  aiModelConfig: LlmServiceConfig;
}

type SidebarTab = "outline" | "thumbs";
type ToolType = "select" | "hand" | "highlight" | "underline" | "strike" | "text";

type PageSize = {
  width: number;
  height: number;
};

type DraftAnnotation = {
  page: number;
  kind: ReaderAnnotationKind;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

const DEFAULT_PAGE_SIZE: PageSize = { width: 595, height: 842 };
const ACTIVE_NEIGHBOR = 2;
const TEXT_NOTE_DEFAULT_WIDTH = 0.22;
const TEXT_NOTE_DEFAULT_HEIGHT = 0.08;
const MIN_IMAGE_OVERLAY_AREA = 0.0025;
const MIN_IMAGE_OVERLAY_SIDE = 18;
const MAX_IMAGE_OVERLAY_ASPECT = 8;
type CanvasRenderTask = { cancel: () => void; promise: Promise<void> };
const activeCanvasRenders = new WeakMap<HTMLCanvasElement, CanvasRenderTask>();
const PAGE_RENDER_OVERSCAN_WHILE_ZOOMING = 5;
const WHEEL_ZOOM_SENSITIVITY = 0.14;
const WHEEL_ZOOM_MIN_STEP = 7;
const ZOOM_ANIMATION_EASE = 0.32;
const ZOOM_ANIMATION_SETTLE = 0.18;
const ZOOM_RENDER_COMMIT_DELAY_MS = 160;
const ZOOM_LOCK_RELEASE_DELAY_MS = ZOOM_RENDER_COMMIT_DELAY_MS + 48;

type ImageContextTarget = {
  pageNo: number;
  image: PDFImageInfo;
  rect: { left: number; top: number; width: number; height: number };
};

type DocumentLinkResource = CachedResourceLink;
type DocumentDoiResource = { doi: string; resourceId: string; documentId?: string };

type ResourceScanState = {
  status: "idle" | "scanning" | "ready" | "cancelled";
  completed: number;
  total: number;
  failedPages: number[];
};

type ViewerContextMenuState = {
  x: number;
  y: number;
  isOpen: boolean;
  pageNo: number;
  imageTarget: ImageContextTarget | null;
};

async function cancelAndAwaitCanvasRender(canvas: HTMLCanvasElement) {
  const existing = activeCanvasRenders.get(canvas);
  if (!existing) return;
  try {
    existing.cancel();
  } catch {
    // ignore cancellation failures
  }
  try {
    await existing.promise;
  } catch {
    // ignore render cancellation errors
  } finally {
    if (activeCanvasRenders.get(canvas) === existing) {
      activeCanvasRenders.delete(canvas);
    }
  }
}

function trackCanvasRender(canvas: HTMLCanvasElement, task: CanvasRenderTask) {
  activeCanvasRenders.set(canvas, task);
  task.promise.finally(() => {
    if (activeCanvasRenders.get(canvas) === task) {
      activeCanvasRenders.delete(canvas);
    }
  });
}

const I18N = {
  "zh-CN": {
    outline: "大纲",
    thumbs: "缩略图",
    noOutline: "暂无大纲。",
    handTool: "抓手工具",
    selectText: "选择文本",
    highlight: "高亮",
    underline: "下划线",
    strikethrough: "删除线",
    addText: "文本批注",
    zoomOut: "缩小",
    zoomIn: "放大",
    resetZoom: "重置缩放",
    prevPage: "上一页",
    nextPage: "下一页",
    exportLabel: "导出",
    searching: "搜索中",
    search: "搜索",
    readerView: "阅读",
    translationView: "翻译",
    imageLabelView: "图片标注",
    fullTranslation: "全文翻译",
    exitFullTranslation: "返回阅读",
    exportImages: "导出图片",
    exportImagesTitle: "可导出图片",
    exportImagePng: "导出此 PNG",
    exportImageSvg: "导出此 SVG",
    toggleNotes: "切换右侧栏",
    hideLeftSidebar: "收起侧边栏",
    showLeftSidebar: "展开侧边栏",
    noPdfOpened: "未打开 PDF",
    noPdfHint: "请从资料库打开 PDF，或选择本地文件。",
    openPdf: "打开 PDF",
    loadingPdf: "正在加载 PDF...",
    notesAnnotations: "笔记与批注",
    sidePanelNotes: "笔记",
    sidePanelTranslation: "翻译",
    sidePanelResources: "资源",
    resources: "文件资源",
    resourcesIntro: "查看当前 PDF 中已识别的图片、链接和 DOI。",
    resourceImages: "图片",
    resourceLinks: "链接",
    resourcesLoading: "正在扫描资源…",
    page: "第",
    notesIntro: "先选批注工具，再在页面拖拽标注；也可在下方直接记录当前页笔记。",
    annotationTool: "批注工具",
    switchToAnnotationTool: "切换到批注工具后可进行标注",
    annotationsCount: "条批注",
    dragToAnnotate: "拖拽即可创建批注；选择“文本批注”后会在松开鼠标时输入内容。",
    addNoteTitle: "添加笔记",
    addNoteBtn: "添加笔记",
    addNotePlaceholder: "写下本页或当前选区的笔记...",
    storedWithPage: "保存到第 {page} 页",
    pageAnnotations: "页面批注",
    noAnnotations: "本页暂无批注。请选择高亮/下划线/删除线/文本批注后在页面拖拽创建。",
    pageNotes: "页面笔记",
    noNotes: "本页暂无笔记。可在上方输入框填写并点击“添加笔记”。",
    selectedAnnotation: "已选批注",
    deleteAnnotation: "删除批注",
    deleteNote: "删除笔记",
    delete: "删除",
    pageActions: "页面操作",
    pageRefLabel: "第 {page} 页",
    copyPageRefSuccess: "页面引用已复制",
    clipboardUnavailable: "剪贴板不可用",
    addNotePanelHint: "请在右侧面板添加笔记",
    searchKeywordPrompt: "搜索关键词",
    enterKeyword: "请输入要搜索的关键词",
    foundOnPage: "在第 {page} 页找到",
    noMatches: "未找到 \"{query}\"",
    noteAdded: "笔记已添加",
    textAnnotationPrompt: "输入文本批注内容",
    textAnnotationCancelled: "已取消文本批注",
    dragToCreate: "请在页面拖拽以创建批注",
    annotationSaved: "{label} 已保存",
    annotationDeleted: "批注已删除",
    overlayWithoutText: "已保存页面覆盖层（无内嵌文本）。",
    areaAnnotationSaved: "区域批注已保存。",
    copyPageReference: "复制页面引用",
    addNoteHere: "在此添加笔记",
    exportCurrentPng: "导出当前页 PNG",
    exportCurrentSvg: "导出当前页 SVG",
    cancel: "取消",
    pdfImages: "PDF 图片",
    translationPreview: "翻译预览",
    translationEmpty: "点击 PDF 段落后的“翻译”按钮，在这里预览译文。",
    translating: "正在翻译...",
    translateFailed: "翻译失败",
    noPdfImages: "当前页未检测到可导出图片。",
    imageLabelDetecting: "正在识别当前页附近图片...",
    imageLabelReady: "已识别 {count} 个图片/矢量图区域。",
    imageLabelFailed: "图片识别失败：{message}",
    imageType: "类型",
    pngExported: "PNG 已导出",
    svgExported: "SVG 已导出",
    rendering: "渲染中...",
    pdfNotLoaded: "PDF 文档尚未加载，请从资料库重新打开。",
    clickForAssist: "点击打开阅读辅助",
  },
  "en-US": {
    outline: "Outline",
    thumbs: "Thumbs",
    noOutline: "No outline available.",
    handTool: "Hand Tool",
    selectText: "Select Text",
    highlight: "Highlight",
    underline: "Underline",
    strikethrough: "Strikethrough",
    addText: "Text Note",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    resetZoom: "Reset zoom",
    prevPage: "Previous page",
    nextPage: "Next page",
    exportLabel: "Export",
    searching: "Searching",
    search: "Search",
    readerView: "Reader",
    translationView: "Translation",
    imageLabelView: "Image labels",
    fullTranslation: "Full translation",
    exitFullTranslation: "Back to reader",
    exportImages: "Export images",
    exportImagesTitle: "Exportable images",
    exportImagePng: "Export this PNG",
    exportImageSvg: "Export this SVG",
    toggleNotes: "Toggle side panel",
    hideLeftSidebar: "Hide sidebar",
    showLeftSidebar: "Show sidebar",
    noPdfOpened: "No PDF opened",
    noPdfHint: "Open a PDF from the Library or choose a local file.",
    openPdf: "Open PDF",
    loadingPdf: "Loading PDF...",
    notesAnnotations: "Notes & Annotations",
    sidePanelNotes: "Notes",
    sidePanelTranslation: "Translation",
    sidePanelResources: "Resources",
    resources: "File resources",
    resourcesIntro: "Browse detected images, links, and DOIs in this PDF.",
    resourceImages: "Images",
    resourceLinks: "Links",
    resourcesLoading: "Scanning resources…",
    page: "Page",
    notesIntro: "Pick an annotation tool, then drag on the page to mark content. You can also write a page note below.",
    annotationTool: "Annotation tool",
    switchToAnnotationTool: "Switch to an annotation tool to draw",
    annotationsCount: "annotations",
    dragToAnnotate: "Drag to create annotations; text notes will prompt for content on pointer release.",
    addNoteTitle: "Add note",
    addNoteBtn: "Add note",
    addNotePlaceholder: "Write a note about this page or the current selection...",
    storedWithPage: "Stored with page {page}",
    pageAnnotations: "Page annotations",
    noAnnotations: "No annotations on this page yet. Choose a tool and drag on the page to create one.",
    pageNotes: "Page notes",
    noNotes: "No notes on this page yet. Type in the note box above and click Add note.",
    selectedAnnotation: "Selected annotation",
    deleteAnnotation: "Delete annotation",
    deleteNote: "Delete note",
    delete: "Delete",
    pageActions: "Page actions",
    pageRefLabel: "page {page}",
    copyPageRefSuccess: "Page reference copied",
    clipboardUnavailable: "Clipboard unavailable",
    addNotePanelHint: "Add a note in the side panel",
    searchKeywordPrompt: "Search keyword",
    enterKeyword: "Enter a keyword to search",
    foundOnPage: "Found on page {page}",
    noMatches: "No matches for \"{query}\"",
    noteAdded: "Note added",
    textAnnotationPrompt: "Text annotation content",
    textAnnotationCancelled: "Text annotation was cancelled",
    dragToCreate: "Drag on the page to create an annotation",
    annotationSaved: "{label} saved",
    annotationDeleted: "Annotation deleted",
    overlayWithoutText: "Stored page overlay without inline text.",
    areaAnnotationSaved: "Area annotation saved on page.",
    copyPageReference: "Copy page reference",
    addNoteHere: "Add note here",
    exportCurrentPng: "Export current page PNG",
    exportCurrentSvg: "Export current page SVG",
    cancel: "Cancel",
    pdfImages: "PDF Images",
    translationPreview: "Translation",
    translationEmpty: "Click Translate from the reading assist menu to preview text here.",
    translating: "Translating...",
    translateFailed: "Translation failed",
    noPdfImages: "No exportable images detected on this page.",
    imageLabelDetecting: "Detecting images near the current page...",
    imageLabelReady: "Detected {count} image/vector regions.",
    imageLabelFailed: "Image detection failed: {message}",
    imageType: "Type",
    pngExported: "PNG exported",
    svgExported: "SVG exported",
    rendering: "Rendering...",
    pdfNotLoaded: "PDF document is not loaded. Re-open the file from Library.",
    clickForAssist: "Click for reading assist",
  },
} as const;

function cleanBaseName(title: string) {
  return (title || "document")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function toOutlineTitles(outline: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>) {
  if (!outline) return [] as string[];
  return outline
    .map((item) => (typeof item.title === "string" ? item.title.trim() : ""))
    .filter(Boolean)
    .slice(0, 40);
}

function clampPage(page: number, totalPages: number) {
  return Math.max(1, Math.min(Math.max(1, totalPages), Math.round(page)));
}

function clampZoomValue(value: number) {
  if (!Number.isFinite(value)) return 100;
  return Math.max(50, Math.min(400, value));
}

function normalizeImageBbox(bbox: number[], pageSize: PageSize) {
  const values = bbox.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return null;
  const maxValue = Math.max(...values.map((value) => Math.abs(value)));
  const scaleX = maxValue <= 1.01 ? pageSize.width : 1;
  const scaleY = maxValue <= 1.01 ? pageSize.height : 1;
  const left = Math.max(0, Math.min(pageSize.width, Math.min(values[0] * scaleX, values[2] * scaleX)));
  const top = Math.max(0, Math.min(pageSize.height, Math.min(values[1] * scaleY, values[3] * scaleY)));
  const right = Math.max(0, Math.min(pageSize.width, Math.max(values[0] * scaleX, values[2] * scaleX)));
  const bottom = Math.max(0, Math.min(pageSize.height, Math.max(values[1] * scaleY, values[3] * scaleY)));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

function isLikelyImageOverlay(rect: { width: number; height: number }, pageSize: PageSize) {
  const areaRatio = (rect.width * rect.height) / Math.max(1, pageSize.width * pageSize.height);
  const aspect = Math.max(rect.width / Math.max(1, rect.height), rect.height / Math.max(1, rect.width));
  return (
    areaRatio >= MIN_IMAGE_OVERLAY_AREA &&
    rect.width >= MIN_IMAGE_OVERLAY_SIDE &&
    rect.height >= MIN_IMAGE_OVERLAY_SIDE &&
    aspect <= MAX_IMAGE_OVERLAY_ASPECT
  );
}

function isLikelyVectorOverlay(rect: { width: number; height: number }, pageSize: PageSize) {
  const areaRatio = (rect.width * rect.height) / Math.max(1, pageSize.width * pageSize.height);
  const aspect = Math.max(rect.width / Math.max(1, rect.height), rect.height / Math.max(1, rect.width));
  return areaRatio >= 0.0018 && areaRatio <= 0.45 && rect.width >= 14 && rect.height >= 14 && aspect <= 18;
}

function rectsOverlapRatio(
  rect: { left: number; top: number; width: number; height: number },
  blockRect: { x: number; y: number; width: number; height: number },
  pageSize: PageSize
) {
  const block = {
    left: blockRect.x * pageSize.width,
    top: blockRect.y * pageSize.height,
    width: blockRect.width * pageSize.width,
    height: blockRect.height * pageSize.height,
  };
  const left = Math.max(rect.left, block.left);
  const top = Math.max(rect.top, block.top);
  const right = Math.min(rect.left + rect.width, block.left + block.width);
  const bottom = Math.min(rect.top + rect.height, block.top + block.height);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const rectArea = Math.max(1, rect.width * rect.height);
  return overlap / rectArea;
}

function isLikelyImageCandidate(
  img: PDFImageInfo,
  rect: { left: number; top: number; width: number; height: number },
  pageSize: PageSize,
  blocks: PdfReadingBlock[]
) {
  if (img.source === "vector") {
    if (!isLikelyVectorOverlay(rect, pageSize)) return false;
  } else if (!isLikelyImageOverlay(rect, pageSize)) return false;
  const pageArea = Math.max(1, pageSize.width * pageSize.height);
  const areaRatio = (rect.width * rect.height) / pageArea;
  if (areaRatio > 0.72) return false;

  const imageBlockMatch = blocks.some(
    (block) => block.kind === "image" && block.rect && rectsOverlapRatio(rect, block.rect, pageSize) >= 0.18
  );
  if (imageBlockMatch) return true;

  const textOverlap = blocks
    .filter((block) => block.kind !== "image" && block.rect)
    .reduce((max, block) => Math.max(max, rectsOverlapRatio(rect, block.rect as NonNullable<PdfReadingBlock["rect"]>, pageSize)), 0);
  return img.source === "vector" ? textOverlap < 0.46 : textOverlap < 0.32;
}

function imageBlockToCandidate(block: PdfReadingBlock, pageSize: PageSize): { img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } } | null {
  if (block.kind !== "image" || !block.rect) return null;
  const rect = {
    left: block.rect.x * pageSize.width,
    top: block.rect.y * pageSize.height,
    width: block.rect.width * pageSize.width,
    height: block.rect.height * pageSize.height,
  };
  if (!isLikelyImageOverlay(rect, pageSize)) return null;
  return {
    img: {
      xref: 0,
      resourceId: `resource-${block.id}`,
      documentId: block.documentId,
      pageNumber: block.page,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      extension: "crop",
      bbox: [rect.left, rect.top, rect.left + rect.width, rect.top + rect.height],
      source: "block",
    },
    rect,
  };
}

function dedupeImageCandidates(
  items: Array<{ img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } }>,
  pageSize: PageSize
) {
  const sorted = [...items].sort((left, right) => {
    const rank = (item: { img: PDFImageInfo }) => item.img.source === "xref" ? 0 : item.img.source === "vector" ? 1 : 2;
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return right.rect.width * right.rect.height - left.rect.width * left.rect.height;
  });
  const kept: typeof items = [];
  for (const item of sorted) {
    const duplicate = kept.some((existing) => {
      if (item.img.xref > 0 && existing.img.xref === item.img.xref) {
        return rectsOverlapRatio(item.rect, {
          x: existing.rect.left / pageSize.width,
          y: existing.rect.top / pageSize.height,
          width: existing.rect.width / pageSize.width,
          height: existing.rect.height / pageSize.height,
        }, pageSize) > 0.8;
      }
      const overlapA = rectsOverlapRatio(item.rect, {
        x: existing.rect.left / pageSize.width,
        y: existing.rect.top / pageSize.height,
        width: existing.rect.width / pageSize.width,
        height: existing.rect.height / pageSize.height,
      }, pageSize);
      const overlapB = rectsOverlapRatio(existing.rect, {
        x: item.rect.left / pageSize.width,
        y: item.rect.top / pageSize.height,
        width: item.rect.width / pageSize.width,
        height: item.rect.height / pageSize.height,
      }, pageSize);
      return Math.max(overlapA, overlapB) > 0.72;
    });
    if (!duplicate) kept.push(item);
  }
  return kept;
}

async function cropPngBase64(
  pagePngBase64: string,
  rect: { left: number; top: number; width: number; height: number },
  pageSize: PageSize
) {
  const image = new Image();
  const imageUrl = `data:image/png;base64,${pagePngBase64}`;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("PNG image decode failed"));
    image.src = imageUrl;
  });
  const scaleX = image.naturalWidth / Math.max(1, pageSize.width);
  const scaleY = image.naturalHeight / Math.max(1, pageSize.height);
  const sourceX = Math.max(0, Math.floor(rect.left * scaleX));
  const sourceY = Math.max(0, Math.floor(rect.top * scaleY));
  const sourceWidth = Math.max(1, Math.ceil(rect.width * scaleX));
  const sourceHeight = Math.max(1, Math.ceil(rect.height * scaleY));
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(image.naturalWidth - sourceX, sourceWidth);
  canvas.height = Math.min(image.naturalHeight - sourceY, sourceHeight);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(image, sourceX, sourceY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

function equalSet(left: Set<number>, right: Set<number>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function isAnnotationTool(tool: ToolType): tool is ReaderAnnotationKind {
  return tool === "highlight" || tool === "underline" || tool === "strike" || tool === "text";
}

function normalizeRect(startX: number, startY: number, currentX: number, currentY: number) {
  const left = Math.max(0, Math.min(startX, currentX));
  const top = Math.max(0, Math.min(startY, currentY));
  const right = Math.min(1, Math.max(startX, currentX));
  const bottom = Math.min(1, Math.max(startY, currentY));
  return {
    x: left,
    y: top,
    width: Math.max(0.002, right - left),
    height: Math.max(0.002, bottom - top),
  };
}

function createTextRect(x: number, y: number) {
  return {
    x: Math.max(0, Math.min(1 - TEXT_NOTE_DEFAULT_WIDTH, x)),
    y: Math.max(0, Math.min(1 - TEXT_NOTE_DEFAULT_HEIGHT, y)),
    width: TEXT_NOTE_DEFAULT_WIDTH,
    height: TEXT_NOTE_DEFAULT_HEIGHT,
  };
}

function getAnnotationBadgeStyle(kind: ReaderAnnotationKind): CSSProperties {
  switch (kind) {
    case "highlight":
      return { backgroundColor: "rgba(250, 204, 21, 0.18)", color: "#a16207" };
    case "underline":
      return { backgroundColor: "rgba(37, 99, 235, 0.12)", color: "#1d4ed8" };
    case "strike":
      return { backgroundColor: "rgba(220, 38, 38, 0.12)", color: "#b91c1c" };
    case "text":
      return { backgroundColor: "var(--reader-accent-soft)", color: "var(--reader-accent)" };
  }
}

function getAnnotationOverlayStyle(annotation: ReaderAnnotation, selected: boolean): CSSProperties {
  const base: CSSProperties = {
    left: `${annotation.rect.x * 100}%`,
    top: `${annotation.rect.y * 100}%`,
    width: `${annotation.rect.width * 100}%`,
    height: `${annotation.rect.height * 100}%`,
    boxShadow: selected ? "0 0 0 2px rgba(24,24,27,0.32)" : "0 0 0 1px rgba(24,24,27,0.12)",
  };

  switch (annotation.kind) {
    case "highlight":
      return {
        ...base,
        backgroundColor: "rgba(250, 204, 21, 0.28)",
        border: "1px solid rgba(202, 138, 4, 0.35)",
      };
    case "underline":
      return {
        ...base,
        backgroundImage:
          "linear-gradient(to bottom, transparent 82%, rgba(37, 99, 235, 0.9) 82%, rgba(37, 99, 235, 0.9) 100%)",
        backgroundColor: "rgba(37, 99, 235, 0.06)",
      };
    case "strike":
      return {
        ...base,
        backgroundImage:
          "linear-gradient(to bottom, transparent 45%, rgba(220, 38, 38, 0.9) 45%, rgba(220, 38, 38, 0.9) 57%, transparent 57%)",
        backgroundColor: "rgba(220, 38, 38, 0.05)",
      };
    case "text":
      return {
        ...base,
        backgroundColor: "rgba(24, 24, 27, 0.92)",
        border: "1px solid rgba(255,255,255,0.14)",
        color: "#ffffff",
      };
  }
}

function getDraftOverlayStyle(kind: ReaderAnnotationKind, rect: { x: number; y: number; width: number; height: number }): CSSProperties {
  const draftAnnotation: ReaderAnnotation = {
    id: "draft",
    page: 1,
    kind,
    rect,
    createdAt: new Date().toISOString(),
  };
  return {
    ...getAnnotationOverlayStyle(draftAnnotation, false),
    opacity: 0.75,
  };
}

type PdfTextSpan = {
  node: HTMLElement;
  text: string;
  rect: DOMRect;
  centerY: number;
};

type PdfTextLine = {
  spans: PdfTextSpan[];
  text: string;
  rect: DOMRect;
  centerY: number;
};

function combineClientRects(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function getPdfTextSpans(layer: HTMLElement): PdfTextSpan[] {
  return Array.from(layer.querySelectorAll("span"))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => {
      const text = node.textContent?.replace(/\s+/g, " ").trim() || "";
      const rect = node.getBoundingClientRect();
      return { node, text, rect, centerY: rect.top + rect.height / 2 };
    })
    .filter((item) => item.text.length > 0 && item.rect.width > 0 && item.rect.height > 0);
}

function getPdfSpanAtPoint(layer: HTMLElement, clientX: number, clientY: number, cachedSpans?: PdfTextSpan[]): HTMLElement | null {
  const spans = cachedSpans || getPdfTextSpans(layer);
  let nearest: PdfTextSpan | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const item of spans) {
    const { rect } = item;
    const expandedLeft = rect.left - 2;
    const expandedRight = rect.right + 2;
    const expandedTop = rect.top - 3;
    const expandedBottom = rect.bottom + 3;
    if (clientX >= expandedLeft && clientX <= expandedRight && clientY >= expandedTop && clientY <= expandedBottom) {
      return item.node;
    }

    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearest = item;
      nearestDistance = distance;
    }
  }

  return nearestDistance <= 10 ? nearest?.node ?? null : null;
}

function groupPdfTextLines(spans: PdfTextSpan[]): PdfTextLine[] {
  const sorted = [...spans].sort((a, b) =>
    Math.abs(a.centerY - b.centerY) > 3 ? a.centerY - b.centerY : a.rect.left - b.rect.left
  );
  const lines: PdfTextSpan[][] = [];

  for (const span of sorted) {
    const last = lines[lines.length - 1];
    const lastCenter = last
      ? last.reduce((sum, item) => sum + item.centerY, 0) / last.length
      : Number.NaN;
    const tolerance = Math.max(3, span.rect.height * 0.45);
    if (last && Math.abs(lastCenter - span.centerY) <= tolerance) {
      last.push(span);
    } else {
      lines.push([span]);
    }
  }

  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.rect.left - b.rect.left);
    return {
      spans: ordered,
      text: textFromPdfSpans(ordered.map((item) => item.node)),
      rect: combineClientRects(ordered.map((item) => item.rect)),
      centerY: ordered.reduce((sum, item) => sum + item.centerY, 0) / ordered.length,
    };
  });
}

function collectPdfParagraphSpansFromTarget(target: HTMLElement, cachedSpans?: PdfTextSpan[]): HTMLElement[] {
  const layer = target.closest(".textLayer");
  if (!(layer instanceof HTMLElement)) return [];
  const spans = cachedSpans || getPdfTextSpans(layer);
  if (spans.length === 0) return [];

  const targetSpan = spans.find((item) => item.node === target || item.node.contains(target));
  if (!targetSpan) return [];

  const allLines = groupPdfTextLines(spans);
  const targetLine = allLines.find((line) => line.spans.some((item) => item.node === targetSpan.node));
  if (!targetLine) return [];

  // A PDF page commonly has two columns. Keep paragraph grouping inside the
  // column under the pointer; grouping the whole text layer makes the first
  // line span both columns and produces a partial/oversized hover rectangle.
  const targetLineSpans = [...targetLine.spans].sort((left, right) => left.rect.left - right.rect.left);
  const medianHeight = targetLineSpans[Math.floor(targetLineSpans.length / 2)]?.rect.height || targetSpan.rect.height;
  const targetIndex = targetLineSpans.findIndex((item) => item.node === targetSpan.node);
  let segmentStart = 0;
  let segmentEnd = targetLineSpans.length;
  for (let index = 1; index <= targetLineSpans.length; index += 1) {
    const previous = targetLineSpans[index - 1];
    const current = targetLineSpans[index];
    if (!current || current.rect.left - previous.rect.right > Math.max(18, medianHeight * 2.4)) {
      if (targetIndex >= segmentStart && targetIndex < index) {
        segmentEnd = index;
        break;
      }
      segmentStart = index;
    }
  }
  const columnLine = targetLineSpans.slice(segmentStart, segmentEnd);
  const columnLeft = Math.min(...columnLine.map((item) => item.rect.left));
  const columnRight = Math.max(...columnLine.map((item) => item.rect.right));
  const columnPadding = Math.max(8, medianHeight * 1.8);
  const lines = groupPdfTextLines(
    spans.filter((item) => {
      const center = item.rect.left + item.rect.width / 2;
      return center >= columnLeft - columnPadding && center <= columnRight + columnPadding;
    })
  );
  const targetLineIndex = lines.findIndex((line) => line.spans.some((item) => item.node === targetSpan.node));
  if (targetLineIndex < 0) return [];

  const lineHeights = lines.map((line) => line.rect.height).filter((height) => height > 0);
  const medianLineHeight = lineHeights.length
    ? [...lineHeights].sort((a, b) => a - b)[Math.floor(lineHeights.length / 2)]
    : targetSpan.rect.height;
  const selectedLine = lines[targetLineIndex];
  const paragraph: PdfTextLine[] = [selectedLine];

  const canJoin = (previous: PdfTextLine, next: PdfTextLine) => {
    const verticalGap = next.rect.top - previous.rect.bottom;
    const leftDelta = Math.abs(next.rect.left - selectedLine.rect.left);
    const nextLooksIndented = next.rect.left - selectedLine.rect.left > medianLineHeight * 1.8;
    const previousEndsSentence = /[.!?。！？]\s*$/.test(previous.text);
    const nextStartsSection = /^[A-Z][A-Za-z\s-]{0,70}$/.test(next.text) && next.text.length < 90;
    if (verticalGap > medianLineHeight * 1.35) return false;
    if (nextLooksIndented && previousEndsSentence) return false;
    if (nextStartsSection) return false;
    return leftDelta <= Math.max(28, medianLineHeight * 3.2) || !previousEndsSentence;
  };

  for (let index = targetLineIndex - 1; index >= 0; index -= 1) {
    if (!canJoin(lines[index], paragraph[0])) break;
    paragraph.unshift(lines[index]);
  }

  for (let index = targetLineIndex + 1; index < lines.length; index += 1) {
    if (!canJoin(paragraph[paragraph.length - 1], lines[index])) break;
    paragraph.push(lines[index]);
  }

  return paragraph.flatMap((line) => line.spans.map((item) => item.node));
}

function textFromPdfSpans(spans: HTMLElement[]) {
  return spans
    .map((span) => span.textContent?.replace(/\s+/g, " ").trim() || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

function getBlockHit(target: HTMLElement, blocks: PdfReadingBlock[], layer: HTMLElement) {
  const layerRect = layer.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const x = (targetRect.left + targetRect.width / 2 - layerRect.left) / Math.max(1, layerRect.width);
  const y = (targetRect.top + targetRect.height / 2 - layerRect.top) / Math.max(1, layerRect.height);
  const directHit = blocks.find((block) => {
    const rect = block.rect;
    if (!rect) return false;
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  });
  if (directHit) return directHit;

  let nearest: PdfReadingBlock | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    const rect = block.rect;
    if (!rect) continue;
    const dx = x < rect.x ? rect.x - x : x > rect.x + rect.width ? x - (rect.x + rect.width) : 0;
    const dy = y < rect.y ? rect.y - y : y > rect.y + rect.height ? y - (rect.y + rect.height) : 0;
    const distance = Math.hypot(dx * layerRect.width, dy * layerRect.height);
    if (distance < nearestDistance) {
      nearest = block;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= 8 ? nearest : undefined;
}

function drawSpanGroupHighlightElements(group: HTMLElement[], host: HTMLElement, existing: HTMLDivElement[]) {
  const hostRect = host.getBoundingClientRect();
  const spans = group
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter((item) => item.rect.width > 0 && item.rect.height > 0)
    .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
  if (spans.length === 0) return [];
  const padX = 5;
  const padY = 4;
  const left = Math.min(...spans.map((item) => item.rect.left));
  const top = Math.min(...spans.map((item) => item.rect.top));
  const right = Math.max(...spans.map((item) => item.rect.right));
  const bottom = Math.max(...spans.map((item) => item.rect.bottom));
  const element = existing[0] || document.createElement("div");
  element.className = "pdf-assist-block-highlight";
  element.style.left = `${Math.max(0, left - hostRect.left - padX)}px`;
  element.style.top = `${Math.max(0, top - hostRect.top - padY)}px`;
  element.style.width = `${Math.min(hostRect.width, right - left + padX * 2)}px`;
  element.style.height = `${Math.min(hostRect.height, bottom - top + padY * 2)}px`;
  if (element.parentElement !== host) host.appendChild(element);
  const elements = [element];
  for (const stale of existing.slice(1)) stale.remove();
  return elements;
}

function getAssistAnchorFromHighlights(highlights: HTMLDivElement[], fallbackX: number, fallbackY: number) {
  const rects = highlights.map((highlight) => highlight.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return { x: fallbackX, y: fallbackY };
  const rect = combineClientRects(rects);
  return {
    x: rect.left + rect.width / 2,
    y: rect.bottom + 8,
  };
}

interface PageCanvasProps {
  doc: PDFDocumentProxy | null;
  pageNo: number;
  renderZoomScale: number;
  active: boolean;
  enableTextLayer: boolean;
  enableAssistBlocks: boolean;
  linksEnabled: boolean;
  onSize: (pageNo: number, width: number, height: number) => void;
  onError: (message: string) => void;
  renderingLabel: string;
  onOpenExternal?: (url: string) => void;
  onAssistSelection?: (selection: Omit<ReadingAssistSelection, "id" | "sourceTitle">) => void;
  onReadingBlocks?: (pageNo: number, blocks: PdfReadingBlock[]) => void;
  onPageLinks?: (pageNo: number, links: Array<{ url: string }>) => void;
}

function PageCanvas({
  doc,
  pageNo,
  renderZoomScale,
  active,
  enableTextLayer,
  enableAssistBlocks,
  linksEnabled,
  onSize,
  onError,
  renderingLabel,
  onOpenExternal,
  onAssistSelection,
  onReadingBlocks,
  onPageLinks,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textHostRef = useRef<HTMLDivElement | null>(null);
  const linkHostRef = useRef<HTMLDivElement | null>(null);
  const assistHitRef = useRef<HTMLDivElement | null>(null);
  const assistHighlightsRef = useRef<HTMLDivElement[]>([]);
  const linkTokenRef = useRef(0);
  const activeAssistSpansRef = useRef<HTMLElement[]>([]);
  const textSpanCacheRef = useRef<PdfTextSpan[] | null>(null);
  const paragraphCacheRef = useRef<WeakMap<HTMLElement, HTMLElement[]>>(new WeakMap());
  const activeAssistTargetRef = useRef<HTMLElement | null>(null);
  const readingBlocksRef = useRef<PdfReadingBlock[]>([]);
  const textLayerRef = useRef<{
    pageNo: number;
    div: HTMLDivElement;
    render: (params: { viewport: unknown }) => Promise<void>;
    show: () => void;
    hide: () => void;
    cancel: () => void;
  } | null>(null);
  const tokenRef = useRef(0);
  const hasPaintedRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "rendering" | "ready">("idle");

  useEffect(() => {
    const host = textHostRef.current;
    const hitLayer = assistHitRef.current;
    if (!host || !hitLayer || !enableTextLayer || !enableAssistBlocks || !onAssistSelection || status !== "ready") return;

    const clearActive = () => {
      for (const node of activeAssistSpansRef.current) {
        node.classList.remove("pdf-assist-text-active");
      }
      activeAssistSpansRef.current = [];
      activeAssistTargetRef.current = null;
      for (const element of assistHighlightsRef.current) element.remove();
      assistHighlightsRef.current = [];
    };

    const setActiveFromPoint = (clientX: number, clientY: number): { text: string; block: PdfReadingBlock | null } => {
      const textLayer = host.querySelector(".textLayer");
      if (!(textLayer instanceof HTMLElement)) return { text: "", block: null };
      const spans = textSpanCacheRef.current || getPdfTextSpans(textLayer);
      textSpanCacheRef.current = spans;
      const span = getPdfSpanAtPoint(textLayer, clientX, clientY, spans);
      if (!(span instanceof HTMLElement)) return { text: "", block: null };
      const block = getBlockHit(span, readingBlocksRef.current, textLayer) || null;
      const group = paragraphCacheRef.current.get(span) || collectPdfParagraphSpansFromTarget(span, spans);
      paragraphCacheRef.current.set(span, group);
      if (group.length === 0) return { text: "", block: null };
      if (activeAssistTargetRef.current === span && assistHighlightsRef.current.length > 0) {
        return { text: textFromPdfSpans(group) || block?.text || "", block };
      }
      clearActive();
      for (const node of group) node.classList.add("pdf-assist-text-active");
      activeAssistSpansRef.current = group;
      activeAssistTargetRef.current = span;
      assistHighlightsRef.current = drawSpanGroupHighlightElements(group, host, assistHighlightsRef.current);
      return { text: textFromPdfSpans(group) || block?.text || "", block };
    };

    let moveFrame: number | null = null;
    let pendingPoint: { x: number; y: number } | null = null;
    const onPointerMove = (event: PointerEvent) => {
      pendingPoint = { x: event.clientX, y: event.clientY };
      if (moveFrame !== null) return;
      moveFrame = window.requestAnimationFrame(() => {
        moveFrame = null;
        const point = pendingPoint;
        pendingPoint = null;
        if (point) setActiveFromPoint(point.x, point.y);
      });
    };
    const onPointerLeave = () => {
      pendingPoint = null;
      if (moveFrame !== null) window.cancelAnimationFrame(moveFrame);
      moveFrame = null;
      clearActive();
    };
    const onClick = (event: MouseEvent) => {
      const hit = setActiveFromPoint(event.clientX, event.clientY);
      const text = hit.text;
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      onAssistSelection({
        text,
        reference: `page ${pageNo}`,
        blockId: hit.block?.id,
        sourceRect: hit.block?.rect,
        ...getAssistAnchorFromHighlights(assistHighlightsRef.current, event.clientX + 10, event.clientY - 10),
      });
    };

    hitLayer.addEventListener("pointermove", onPointerMove);
    hitLayer.addEventListener("pointerleave", onPointerLeave);
    hitLayer.addEventListener("click", onClick, true);
    return () => {
      hitLayer.removeEventListener("pointermove", onPointerMove);
      hitLayer.removeEventListener("pointerleave", onPointerLeave);
      hitLayer.removeEventListener("click", onClick, true);
      if (moveFrame !== null) window.cancelAnimationFrame(moveFrame);
      clearActive();
    };
  }, [enableAssistBlocks, enableTextLayer, onAssistSelection, pageNo, status]);

  useEffect(() => {
    if (!doc) {
      setStatus("idle");
      textSpanCacheRef.current = null;
      paragraphCacheRef.current = new WeakMap();
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
      if (textHostRef.current) textHostRef.current.innerHTML = "";
      return;
    }

    let cancelled = false;
    let renderTask: CanvasRenderTask | null = null;
      const token = ++tokenRef.current;
    textSpanCacheRef.current = null;
    paragraphCacheRef.current = new WeakMap();

    const run = async () => {
      const page = await doc.getPage(pageNo);
      if (cancelled || token !== tokenRef.current) return;

      const baseViewport = page.getViewport({ scale: 1 });
      onSize(pageNo, baseViewport.width, baseViewport.height);

      if (!active) {
        setStatus("idle");
        textLayerRef.current?.hide();
        return;
      }

      const renderViewport = page.getViewport({ scale: renderZoomScale });
      const visualViewport = renderViewport;

      const linkHost = linkHostRef.current;
      if (linkHost) {
        linkHost.innerHTML = "";
      }

      if (active && (linksEnabled || onPageLinks) && linkHost) {
        const tokenLinks = ++linkTokenRef.current;
        try {
          const annotations = await page.getAnnotations();
          if (tokenLinks === linkTokenRef.current) {
            const links: Array<{ url: string }> = [];
            const overlay = linksEnabled && onOpenExternal ? document.createElement("div") : null;
            if (overlay) {
              overlay.className = "page-link-overlay";
              overlay.style.width = `${Math.ceil(visualViewport.width)}px`;
              overlay.style.height = `${Math.ceil(visualViewport.height)}px`;
            }

            for (const item of annotations as Array<Record<string, unknown>>) {
              const subtype = item.subtype;
              if (subtype !== "Link") continue;
              const url = typeof item.url === "string" ? item.url : "";
              if (!url) continue;
              links.push({ url });
              if (!overlay || !onOpenExternal) continue;
              const rect = item.rect as unknown;
              if (!Array.isArray(rect) || rect.length !== 4) continue;

              const [x1, y1, x2, y2] = rect as number[];
              const left = Math.min(x1, x2);
              const right = Math.max(x1, x2);
              const bottom = Math.min(y1, y2);
              const top = Math.max(y1, y2);

              // Convert PDF points to viewport pixels
              const tl = visualViewport.convertToViewportPoint(left, top);
              const br = visualViewport.convertToViewportPoint(right, bottom);
              const x = Math.min(tl[0], br[0]);
              const y = Math.min(tl[1], br[1]);
              const w = Math.max(1, Math.abs(br[0] - tl[0]));
              const h = Math.max(1, Math.abs(br[1] - tl[1]));

              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "page-link-hit";
              btn.style.left = `${x}px`;
              btn.style.top = `${y}px`;
              btn.style.width = `${w}px`;
              btn.style.height = `${h}px`;
              btn.title = url;
              btn.onclick = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                onOpenExternal(url);
              };
              overlay.appendChild(btn);
            }

            onPageLinks?.(pageNo, links);
            linkHost.replaceChildren(...(overlay ? [overlay] : []));
          }
        } catch {
          // ignore link overlay failures
        }
      }

      const canvas = canvasRef.current;

      if (!canvas) return;
      await cancelAndAwaitCanvasRender(canvas);
      if (cancelled || token !== tokenRef.current) return;

      setStatus("rendering");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const renderCanvas = document.createElement("canvas");
      const renderContext = renderCanvas.getContext("2d", { alpha: false });
      if (!renderContext) return;
      renderCanvas.width = Math.ceil(renderViewport.width * dpr);
      renderCanvas.height = Math.ceil(renderViewport.height * dpr);
      renderContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderContext.fillStyle = "#ffffff";
      renderContext.fillRect(0, 0, renderViewport.width, renderViewport.height);

      renderTask = page.render({ canvasContext: renderContext, canvas: renderCanvas, viewport: renderViewport }) as unknown as CanvasRenderTask;
      trackCanvasRender(canvas, renderTask);
      await renderTask.promise;
      if (cancelled || token !== tokenRef.current) return;

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      canvas.width = renderCanvas.width;
      canvas.height = renderCanvas.height;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(renderCanvas, 0, 0);
      hasPaintedRef.current = true;

      // Keep canvas visible regardless of text-layer availability.
      setStatus("ready");

      const textHost = textHostRef.current;
      if (enableTextLayer && textHost) {
        try {
          let builder = textLayerRef.current;
          if (!builder || builder.pageNo !== pageNo) {
            builder?.cancel();
            const viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
            const TextLayerBuilderCtor = viewerModule.TextLayerBuilder as unknown as new (args: { pdfPage: unknown }) => {
              div: HTMLDivElement;
              render: (params: { viewport: unknown }) => Promise<void>;
              show: () => void;
              hide: () => void;
              cancel: () => void;
            };
            const created = new TextLayerBuilderCtor({ pdfPage: page });
            builder = {
              pageNo,
              div: created.div,
              render: created.render.bind(created),
              show: created.show.bind(created),
              hide: created.hide.bind(created),
              cancel: created.cancel.bind(created),
            };
            textLayerRef.current = builder;
          }

          if (!textHost.contains(builder.div)) {
            textHost.replaceChildren(builder.div);
          }

          await builder.render({ viewport: visualViewport });
          builder.show();
          textSpanCacheRef.current = getPdfTextSpans(builder.div);
          paragraphCacheRef.current = new WeakMap();
          readingBlocksRef.current = buildDomPdfReadingBlocks(builder.div, pageNo);
          onReadingBlocks?.(pageNo, readingBlocksRef.current);
        } catch {
          textLayerRef.current?.cancel();
          textLayerRef.current = null;
          readingBlocksRef.current = [];
          textSpanCacheRef.current = null;
          paragraphCacheRef.current = new WeakMap();
          onReadingBlocks?.(pageNo, []);
          textHost.innerHTML = "";
        }
      } else if (textHost) {
        textLayerRef.current?.hide();
        readingBlocksRef.current = [];
        textSpanCacheRef.current = null;
        paragraphCacheRef.current = new WeakMap();
        onReadingBlocks?.(pageNo, []);
        textHost.innerHTML = "";
      }
    };

    void run().catch((error) => {
      if (cancelled) return;
      if (error instanceof Error && error.name === "RenderingCancelledException") return;
      // Do not hide rendered canvas when optional overlay steps fail.
      setStatus((prev) => (prev === "ready" ? prev : "idle"));
      onError(error instanceof Error ? error.message : "Failed to render page");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      const canvas = canvasRef.current;
      if (canvas) {
        const existing = activeCanvasRenders.get(canvas);
        existing?.cancel();
      }
      textLayerRef.current?.cancel();
    };
  }, [active, doc, enableTextLayer, linksEnabled, onError, onOpenExternal, onPageLinks, onReadingBlocks, onSize, pageNo, renderZoomScale]);

  useEffect(() => {
    return () => {
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div
        ref={textHostRef}
        className={`page-text-overlay transition-opacity duration-150 ${
          enableTextLayer && status === "ready" ? "opacity-100" : "opacity-0"
        } ${enableTextLayer && !enableAssistBlocks && status === "ready" ? "is-selectable" : ""} ${
          enableTextLayer && enableAssistBlocks && status === "ready" ? "is-assist" : ""
        }`}
      />
      {enableTextLayer && enableAssistBlocks && status === "ready" ? (
        <div ref={assistHitRef} className="pdf-assist-hit-layer" aria-hidden="true" />
      ) : null}
      <div ref={linkHostRef} className="absolute inset-0 pointer-events-none" />
      {active && status === "rendering" && !hasPaintedRef.current ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white/65 text-zinc-500 text-xs">
          {renderingLabel}
        </div>
      ) : null}
    </div>
  );
}

interface PageThumbnailProps {
  doc: PDFDocumentProxy | null;
  fileId?: string;
  pageNo: number;
  active: boolean;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  onClick: (pageNo: number) => void;
  onItemRef: (pageNo: number, node: HTMLButtonElement | null) => void;
  pageLabel: string;
  onContextMenu?: (pageNo: number, event: React.MouseEvent<HTMLButtonElement>) => void;
}

function PageThumbnail({ doc, fileId, pageNo, active, scrollRootRef, onClick, onItemRef, pageLabel, onContextMenu }: PageThumbnailProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inView, setInView] = useState(pageNo <= 8 || active);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const node = buttonRef.current;
    onItemRef(pageNo, node);
    return () => {
      onItemRef(pageNo, null);
    };
  }, [onItemRef, pageNo]);

  useEffect(() => {
    if (inView || active) return;
    const node = buttonRef.current;
    const root = scrollRootRef.current;
    if (!node || !root || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { root, rootMargin: "240px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [active, inView, scrollRootRef]);

  useEffect(() => {
    const shouldRender = inView || active;
    if (!shouldRender || (!doc && !fileId)) return;

    let cancelled = false;
    let task: CanvasRenderTask | null = null;
    let objectUrl = "";

    const run = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      await cancelAndAwaitCanvasRender(canvas);
      if (cancelled) return;

      if (doc) {
        const page = await doc.getPage(pageNo);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        const targetWidth = 108;
        const thumbScale = targetWidth / Math.max(1, viewport.width);
        const thumbViewport = page.getViewport({ scale: thumbScale });
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

        canvas.width = Math.max(1, Math.round(thumbViewport.width * dpr));
        canvas.height = Math.max(1, Math.round(thumbViewport.height * dpr));
        canvas.style.width = `${Math.round(thumbViewport.width)}px`;
        canvas.style.height = `${Math.round(thumbViewport.height)}px`;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, thumbViewport.width, thumbViewport.height);

        task = page.render({ canvas, canvasContext: context, viewport: thumbViewport }) as unknown as CanvasRenderTask;
        trackCanvasRender(canvas, task);
        await task.promise;
        if (cancelled) return;
        setReady(true);
        return;
      }

      if (!fileId) return;
      const pngBase64 = await api.exportPagePNG(fileId, pageNo, 0.35);
      if (cancelled) return;

      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("thumbnail image decode failed"));
        element.src = objectUrl;
      });

      if (cancelled) return;
      const ratio = 108 / Math.max(1, image.width);
      const drawWidth = Math.max(1, Math.round(image.width * ratio));
      const drawHeight = Math.max(1, Math.round(image.height * ratio));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      canvas.width = Math.max(1, Math.round(drawWidth * dpr));
      canvas.height = Math.max(1, Math.round(drawHeight * dpr));
      canvas.style.width = `${drawWidth}px`;
      canvas.style.height = `${drawHeight}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, drawWidth, drawHeight);
      context.drawImage(image, 0, 0, drawWidth, drawHeight);
      setReady(true);
    };

    void run().catch(() => {
      if (cancelled) return;
      setReady(false);
    });

    return () => {
      cancelled = true;
      task?.cancel();
      const canvas = canvasRef.current;
      if (canvas) {
        const existing = activeCanvasRenders.get(canvas);
        existing?.cancel();
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, doc, fileId, inView, pageNo]);

  return (
    <button
      ref={buttonRef}
      className={`mx-auto flex w-full flex-col items-center gap-2 p-2 rounded-lg transition-all border ${
        active
          ? "border-zinc-900/75 dark:border-zinc-100 bg-zinc-100 dark:bg-zinc-800/80 shadow-sm"
          : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 bg-white dark:bg-zinc-900"
      }`}
      onClick={() => onClick(pageNo)}
      title={`${pageLabel} ${pageNo}`}
      type="button"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(pageNo, event);
      }}
    >
      <div className="relative bg-white shadow-sm rounded-sm w-[112px] min-h-[150px] flex items-center justify-center">
        <canvas ref={canvasRef} className={`block transition-opacity ${ready ? "opacity-100" : "opacity-0"}`} />
        {!ready ? <div className="absolute inset-0 bg-zinc-100" /> : null}
      </div>
      <span className="text-xs font-mono text-zinc-500 dark:text-zinc-500">{pageNo}</span>
    </button>
  );
}

export function PDFViewer({
  title,
  documentId,
  fileId,
  language,
  notes,
  annotations,
  onOpenFileDialog,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
  onAddAnnotation,
  onRemoveAnnotation,
  onResolveDefaultPath,
  initialViewState,
  onViewStateChange,
  onProgress,
  onOpenExternal,
  aiModelConfig,
}: PDFViewerProps) {
  const [zoom, setZoom] = useState(() => clampZoomValue(initialViewState?.zoom ?? 100));
  const [renderZoom, setRenderZoom] = useState(() => clampZoomValue(initialViewState?.zoom ?? 100));
  const [page, setPage] = useState(() => Math.max(1, Math.round(initialViewState?.page ?? 1)));
  const [totalPages, setTotalPages] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [actionHint, setActionHint] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("thumbs");
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [activeTool, setActiveTool] = useState<ToolType>("select");
  const [readerMode, setReaderMode] = useState<"reader" | "translation" | "image-label">("reader");
  const [outlineTitles, setOutlineTitles] = useState<string[]>([]);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [activePages, setActivePages] = useState<Set<number>>(new Set([1, 2, 3]));
  const [contextMenu, setContextMenu] = useState<ViewerContextMenuState>({
    x: 0,
    y: 0,
    isOpen: false,
    pageNo: 1,
    imageTarget: null,
  });
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [draftAnnotation, setDraftAnnotation] = useState<DraftAnnotation | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [isGestureRightDown, setIsGestureRightDown] = useState(false);
  const [lockedZoomPage, setLockedZoomPage] = useState<number | null>(null);
  const [pdfImagesByPage, setPdfImagesByPage] = useState<Record<number, PDFImageInfo[]>>({});
  const [readingBlocksVersion, setReadingBlocksVersion] = useState(0);
  const [imageLabelStatus, setImageLabelStatus] = useState<{ kind: "idle" | "loading" | "ready" | "error"; message: string }>({ kind: "idle", message: "" });
  const [isImageExportOpen, setIsImageExportOpen] = useState(false);
  const [assistSelection, setAssistSelection] = useState<ReadingAssistSelection | null>(null);
  const [translationPanel, setTranslationPanel] = useState<{
    selection: ReadingAssistSelection;
    answer: string;
    status: string;
    isLoading: boolean;
  } | null>(null);
  const [fullTranslation, setFullTranslation] = useState<{
    status: string;
    completed: number;
    total: number;
    results: TranslationBlockResult[];
    isLoading: boolean;
  }>({ status: "", completed: 0, total: 0, results: [], isLoading: false });
  const [sidePanelView, setSidePanelView] = useState<"notes" | "translation" | "resources">("notes");
  const [linksByPage, setLinksByPage] = useState<Record<number, DocumentLinkResource[]>>({});
  const [resourceScan, setResourceScan] = useState<ResourceScanState>({ status: "idle", completed: 0, total: 0, failedPages: [] });
  const [resourceScanAttempt, setResourceScanAttempt] = useState(0);
  const t = I18N[language];
  const annotationLabels = useMemo<Record<ReaderAnnotationKind, string>>(() => ({
    highlight: t.highlight,
    underline: t.underline,
    strike: t.strikethrough,
    text: t.addText,
  }), [t.addText, t.highlight, t.strikethrough, t.underline]);
  const gestureStartRef = useRef<{ x: number; y: number } | null>(null);
  const rightDragRef = useRef<{ active: boolean; moved: boolean; pointerId: number | null; pageNo: number | null }>({ active: false, moved: false, pointerId: null, pageNo: null });
  const suppressNextContextMenuRef = useRef(false);
  const rightWindowHandlersRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onUp: (event: PointerEvent) => void;
    onCancel: (event: PointerEvent) => void;
  } | null>(null);

  const onProgressRef = useRef(onProgress);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const thumbListRef = useRef<HTMLDivElement | null>(null);
  const thumbItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const zoomAnimationRef = useRef<number | null>(null);
  const zoomRenderCommitTimerRef = useRef<number | null>(null);
  const zoomTargetRef = useRef(zoom);
  const pageRef = useRef(page);
  const viewStateRef = useRef<PdfViewState | undefined>(initialViewState);
  const viewStateTimerRef = useRef<number | null>(null);
  const isRestoringViewRef = useRef(false);
  const suppressSyncUntilRef = useRef(0);
  const thumbJumpUntilRef = useRef(0);
  const zoomAnchorRef = useRef<{ pageNo: number; relX: number; relY: number; viewportX: number; viewportY: number } | null>(null);
  const lockedZoomPageRef = useRef<number | null>(null);
  const readingBlocksByPageRef = useRef<Map<number, PdfReadingBlock[]>>(new Map());
  const pdfImagesByPageRef = useRef<Record<number, PDFImageInfo[]>>({});
  const imageDetectionInFlightRef = useRef<Set<number>>(new Set());
  const readingBlocksLoadRef = useRef<Promise<PdfReadingBlock[]> | null>(null);
  const readingBlocksLoadedFileRef = useRef<string | null>(null);
  const fullTranslationAbortRef = useRef<AbortController | null>(null);
  const resourcesScanRef = useRef(0);
  const resourceScanAbortRef = useRef<AbortController | null>(null);
  const resourceCacheLoadedRef = useRef(false);
  const linksByPageRef = useRef<Record<number, DocumentLinkResource[]>>({});
  const imageTargetAtPointRef = useRef<(pageNo: number, clientX: number, clientY: number) => ImageContextTarget | null>(() => null);

  const hasDoc = Boolean(fileId && pdfDoc);
  const resourceCacheKey = documentId || fileId || "";
  const zoomScale = useMemo(() => Math.max(0.5, zoom / 100), [zoom]);
  const renderZoomScale = useMemo(() => Math.max(0.5, renderZoom / 100), [renderZoom]);
  const visiblePage = lockedZoomPage ?? page;

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const pageNotes = useMemo(() => notes.filter((note) => note.page === page), [notes, page]);
  const pageAnnotations = useMemo(
    () =>
      annotations
        .filter((annotation) => annotation.page === page)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [annotations, page]
  );
  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedAnnotationId) || null,
    [annotations, selectedAnnotationId]
  );

  useEffect(() => {
    viewStateRef.current = initialViewState;
  }, [initialViewState]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!isGestureRightDown && !suppressNextContextMenuRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, [isGestureRightDown]);

  useEffect(() => {
    if (!selectedAnnotationId || !onRemoveAnnotation) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) {
        return;
      }
      onRemoveAnnotation(selectedAnnotationId);
      setSelectedAnnotationId(null);
      showActionHint(t.annotationDeleted);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRemoveAnnotation, selectedAnnotationId]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    const restoredPage = Math.max(1, Math.round(initialViewState?.page ?? 1));
    viewStateRef.current = initialViewState;
    isRestoringViewRef.current = Boolean(fileId && initialViewState);
    if (zoomAnimationRef.current !== null) {
      window.cancelAnimationFrame(zoomAnimationRef.current);
      zoomAnimationRef.current = null;
    }
    if (zoomRenderCommitTimerRef.current !== null) {
      window.clearTimeout(zoomRenderCommitTimerRef.current);
      zoomRenderCommitTimerRef.current = null;
    }
    setPage(restoredPage);
    const restoredZoom = clampZoomValue(initialViewState?.zoom ?? 100);
    zoomTargetRef.current = restoredZoom;
    setZoom(restoredZoom);
    setRenderZoom(restoredZoom);
    setRenderError("");
    setPageSizes({});
    setActivePages(new Set([clampPage(restoredPage - 1, Number.MAX_SAFE_INTEGER), restoredPage, restoredPage + 1]));
      setDraftAnnotation(null);
      setSelectedAnnotationId(null);
      lockedZoomPageRef.current = null;
      setLockedZoomPage(null);
    setSidebarTab("thumbs");
    setIsNotesOpen(false);
    setLinksByPage({});
    linksByPageRef.current = {};
    setResourceScan({ status: "idle", completed: 0, total: 0, failedPages: [] });
    setResourceScanAttempt(0);
    setPdfImagesByPage({});
    pdfImagesByPageRef.current = {};
    resourceCacheLoadedRef.current = false;
    setReadingBlocksVersion(0);
    setImageLabelStatus({ kind: "idle", message: "" });
    readingBlocksByPageRef.current.clear();
    readingBlocksLoadedFileRef.current = null;
    readingBlocksLoadRef.current = null;
    fullTranslationAbortRef.current?.abort();
    fullTranslationAbortRef.current = null;
    setTranslationPanel(null);
    setFullTranslation({ status: "", completed: 0, total: 0, results: [], isLoading: false });

    if (!fileId) {
      setPdfDoc(null);
      setTotalPages(1);
      setOutlineTitles([]);
      setLoading(false);
      return;
    }

    const cached = api.getPdfDocument(fileId);
    if (!cached) {
      setPdfDoc(null);
      setTotalPages(1);
      setOutlineTitles([]);
      setLoading(false);
      setRenderError(t.pdfNotLoaded);
      return;
    }

    setLoading(true);
    setPdfDoc(cached);
    setTotalPages(Math.max(1, cached.numPages || 1));

    let disposed = false;
    const loadingGuard = window.setTimeout(() => {
      if (!disposed) setLoading(false);
    }, 260);

    void cached
      .getOutline()
      .then((items) => {
        if (disposed) return;
        setOutlineTitles(toOutlineTitles(items));
      })
      .catch(() => {
        if (disposed) return;
        setOutlineTitles([]);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      window.clearTimeout(loadingGuard);
    };
  }, [fileId, t.pdfNotLoaded]);

  useEffect(() => {
    if (!resourceCacheKey || typeof window === "undefined") return;
    resourceCacheLoadedRef.current = false;
    const cached = loadResourceIndex(resourceCacheKey);
    if (cached) {
      setPdfImagesByPage(cached.images);
      pdfImagesByPageRef.current = cached.images;
      setLinksByPage(cached.links);
      linksByPageRef.current = cached.links;
    }
    queueMicrotask(() => {
      resourceCacheLoadedRef.current = true;
    });
  }, [fileId, resourceCacheKey]);

  useEffect(() => {
    if (!resourceCacheKey || !resourceCacheLoadedRef.current || typeof window === "undefined") return;
    saveResourceIndex(resourceCacheKey, { images: pdfImagesByPage, links: linksByPage });
  }, [linksByPage, pdfImagesByPage, resourceCacheKey]);

  useEffect(() => {
    setPage((prev) => clampPage(prev, totalPages));
  }, [totalPages]);

  useEffect(() => {
    if (selectedAnnotationId && !annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
      setSelectedAnnotationId(null);
    }
  }, [annotations, selectedAnnotationId]);

  const updatePageSize = useCallback((pageNo: number, width: number, height: number) => {
    setPageSizes((prev) => {
      const existing = prev[pageNo];
      const safeWidth = Math.max(1, Math.round(width));
      const safeHeight = Math.max(1, Math.round(height));
      if (existing && existing.width === safeWidth && existing.height === safeHeight) {
        return prev;
      }
      return { ...prev, [pageNo]: { width: safeWidth, height: safeHeight } };
    });
  }, []);

  const emitViewState = useCallback(
    (next: Partial<PdfViewState>) => {
      if (!fileId || !onViewStateChange) return;
      const root = scrollRef.current;
      const merged: PdfViewState = {
        page,
        totalPages,
        zoom,
        scrollTop: root?.scrollTop ?? viewStateRef.current?.scrollTop ?? 0,
        scrollLeft: root?.scrollLeft ?? viewStateRef.current?.scrollLeft ?? 0,
        updatedAt: new Date().toISOString(),
        ...next,
      };
      viewStateRef.current = merged;
      if (viewStateTimerRef.current !== null) {
        window.clearTimeout(viewStateTimerRef.current);
      }
      viewStateTimerRef.current = window.setTimeout(() => {
        viewStateTimerRef.current = null;
        onViewStateChange(merged);
      }, 120);
    },
    [fileId, onViewStateChange, page, totalPages, zoom]
  );
  const isTranslationReader = readerMode === "translation";
  const isImageLabelReader = readerMode === "image-label";

  const scrollPageToAnchor = useCallback(
    (targetPage: number, options?: { vertical?: "top" | "center"; emit?: boolean }) => {
      const root = scrollRef.current;
      const node = pageRefs.current.get(clampPage(targetPage, totalPages));
      if (!root || !node) return false;
      const rootRect = root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const verticalOffset =
        options?.vertical === "top"
          ? 12
          : Math.max(12, (root.clientHeight - node.clientHeight) / 2);
      const nextTop = Math.max(0, root.scrollTop + (nodeRect.top - rootRect.top) - verticalOffset);
      const nextLeft = Math.max(0, root.scrollLeft + (nodeRect.left - rootRect.left) - Math.max(0, (root.clientWidth - node.clientWidth) / 2));
      root.scrollTo({ top: nextTop, left: nextLeft, behavior: "auto" });
      if (options?.emit !== false) {
        emitViewState({
          page: clampPage(targetPage, totalPages),
          totalPages,
          zoom,
          scrollTop: nextTop,
          scrollLeft: nextLeft,
        });
      }
      return true;
    },
    [emitViewState, totalPages, zoom]
  );

  useEffect(() => {
    return () => {
      if (viewStateTimerRef.current !== null) {
        window.clearTimeout(viewStateTimerRef.current);
      }
      if (zoomAnimationRef.current !== null) {
        window.cancelAnimationFrame(zoomAnimationRef.current);
      }
      if (zoomRenderCommitTimerRef.current !== null) {
        window.clearTimeout(zoomRenderCommitTimerRef.current);
      }
    };
  }, []);

  const scheduleRenderZoomCommit = useCallback((targetZoom: number) => {
    if (zoomRenderCommitTimerRef.current !== null) {
      window.clearTimeout(zoomRenderCommitTimerRef.current);
    }
    zoomRenderCommitTimerRef.current = window.setTimeout(() => {
      zoomRenderCommitTimerRef.current = null;
      setRenderZoom(clampZoomValue(targetZoom));
      window.requestAnimationFrame(() => {
        zoomAnchorRef.current = null;
      });
    }, ZOOM_RENDER_COMMIT_DELAY_MS);
  }, []);

  const captureZoomAnchor = useCallback(
    (pageNo: number, clientX?: number, clientY?: number) => {
      const root = scrollRef.current;
      const node = pageRefs.current.get(clampPage(pageNo, totalPages));
      if (!root || !node) return;
      const rootRect = root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const viewportX = typeof clientX === "number" ? clientX - rootRect.left : root.clientWidth / 2;
      const viewportY = typeof clientY === "number" ? clientY - rootRect.top : root.clientHeight / 2;
      zoomAnchorRef.current = {
        pageNo: clampPage(pageNo, totalPages),
        relX: Math.max(0, Math.min(1, (rootRect.left + viewportX - nodeRect.left) / Math.max(1, nodeRect.width))),
        relY: Math.max(0, Math.min(1, (rootRect.top + viewportY - nodeRect.top) / Math.max(1, nodeRect.height))),
        viewportX,
        viewportY,
      };
    },
    [totalPages]
  );

  const animateZoomToTarget = useCallback(() => {
    if (zoomAnimationRef.current !== null) return;
    const tick = () => {
      zoomAnimationRef.current = null;
      setZoom((currentZoom) => {
        const target = zoomTargetRef.current;
        const delta = target - currentZoom;
        if (Math.abs(delta) <= ZOOM_ANIMATION_SETTLE) {
          scheduleRenderZoomCommit(target);
          return target;
        }
        zoomAnimationRef.current = window.requestAnimationFrame(tick);
        return currentZoom + delta * ZOOM_ANIMATION_EASE;
      });
    };
    zoomAnimationRef.current = window.requestAnimationFrame(tick);
  }, [scheduleRenderZoomCommit]);

  const smoothZoomBy = useCallback(
    (delta: number, options?: { pageNo?: number; clientX?: number; clientY?: number }) => {
      const anchorPage = clampPage(options?.pageNo ?? lockedZoomPageRef.current ?? lockedZoomPage ?? visiblePage, totalPages);
      captureZoomAnchor(anchorPage, options?.clientX, options?.clientY);
      zoomTargetRef.current = clampZoomValue(zoomTargetRef.current + delta);
      scheduleRenderZoomCommit(zoomTargetRef.current);
      animateZoomToTarget();
    },
    [animateZoomToTarget, captureZoomAnchor, lockedZoomPage, scheduleRenderZoomCommit, totalPages, visiblePage]
  );

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const root = scrollRef.current;
      if (!root || !fileId) return;
      if (isRestoringViewRef.current) return;
      if (Date.now() < suppressSyncUntilRef.current) return;
      const currentLockedPage = lockedZoomPageRef.current ?? lockedZoomPage;
      if (currentLockedPage !== null) {
        emitViewState({
          page: currentLockedPage,
          totalPages,
          zoom,
          scrollTop: root.scrollTop,
          scrollLeft: root.scrollLeft,
        });
        return;
      }

      const rootRect = root.getBoundingClientRect();
      const centerX = rootRect.left + root.clientWidth / 2;
      const centerY = rootRect.top + root.clientHeight / 2;
      const centerPageNode = document
        .elementsFromPoint(centerX, centerY)
        .map((node) => (node instanceof HTMLElement ? node.closest<HTMLElement>("[data-pdf-page]") : null))
        .find((node): node is HTMLElement => Boolean(node));
      const nearest = centerPageNode ? Number(centerPageNode.dataset.pdfPage) : page;
      const nextActive = new Set<number>();

      for (let delta = 1; delta <= ACTIVE_NEIGHBOR; delta += 1) {
        nextActive.add(clampPage(nearest - delta, totalPages));
        nextActive.add(clampPage(nearest + delta, totalPages));
      }
      nextActive.add(nearest);

      setActivePages((prev) => (equalSet(prev, nextActive) ? prev : nextActive));
      setPage((prev) => (prev === nearest ? prev : nearest));
      emitViewState({
        page: nearest,
        totalPages,
        zoom: zoomTargetRef.current,
        scrollTop: root.scrollTop,
        scrollLeft: root.scrollLeft,
      });
    });
  }, [emitViewState, fileId, lockedZoomPage, page, totalPages, zoom]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !fileId) return;

    const onScroll = () => scheduleSync();
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    scheduleSync();

    return () => {
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [fileId, scheduleSync]);

  useEffect(() => {
    if (isGestureRightDown) return;
    scheduleSync();
  }, [isGestureRightDown, scheduleSync, totalPages, zoom, pageSizes]);

  const recenterVisiblePageSoon = useCallback(() => {
    if (!fileId) return;
    const targetPage = clampPage(lockedZoomPageRef.current ?? pageRef.current, totalPages);
    window.requestAnimationFrame(() => {
      scrollPageToAnchor(targetPage, { vertical: "center", emit: false });
      window.setTimeout(() => scrollPageToAnchor(targetPage, { vertical: "center", emit: false }), 180);
    });
  }, [fileId, scrollPageToAnchor, totalPages]);


  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    const root = scrollRef.current;
    if (!root) return;
    const node = pageRefs.current.get(anchor.pageNo);
    if (!node) return;
    const rootRect = root.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const layoutScale = Math.max(0.01, renderZoomScale);
    const visualScale = zoomScale / layoutScale;
    const pageX = anchor.relX * node.clientWidth * visualScale;
    const pageY = anchor.relY * node.clientHeight * visualScale;
    const viewportX = Number.isFinite(anchor.viewportX) ? anchor.viewportX : root.clientWidth / 2;
    const viewportY = Number.isFinite(anchor.viewportY) ? anchor.viewportY : root.clientHeight / 2;
    const untransformedLeft = nodeRect.left + (nodeRect.width - node.clientWidth * visualScale) / 2;
    const nextLeft = root.scrollLeft + (untransformedLeft - rootRect.left + pageX) - viewportX;
    const nextTop = root.scrollTop + (nodeRect.top - rootRect.top + pageY) - viewportY;
    root.scrollTo({
      left: Math.max(0, nextLeft),
      top: Math.max(0, nextTop),
      behavior: "auto",
    });
    emitViewState({
      zoom,
      scrollTop: Math.max(0, nextTop),
      scrollLeft: Math.max(0, nextLeft),
    });
  }, [emitViewState, renderZoomScale, zoom, zoomScale]);

  useLayoutEffect(() => {
    if (!fileId || !initialViewState) return;
    if (!isRestoringViewRef.current) return;
    const root = scrollRef.current;
    if (!root) return;
    const targetPage = clampPage(initialViewState?.page ?? page, totalPages);
    const targetZoom = clampZoomValue(initialViewState?.zoom ?? zoom);
    zoomTargetRef.current = targetZoom;
    setPage(targetPage);
    setZoom(targetZoom);
    setRenderZoom(targetZoom);
    window.requestAnimationFrame(() => {
      const nextRoot = scrollRef.current;
      if (!nextRoot) return;
      const top = Math.max(0, initialViewState?.scrollTop ?? 0);
      const left = Math.max(0, initialViewState?.scrollLeft ?? 0);
      if (top > 0 || left > 0) {
        nextRoot.scrollTo({ top, left, behavior: "auto" });
        window.setTimeout(() => {
          isRestoringViewRef.current = false;
          scheduleSync();
        }, 80);
        return;
      }
      const node = pageRefs.current.get(targetPage);
      if (!node) {
        window.setTimeout(() => {
          isRestoringViewRef.current = false;
          scheduleSync();
        }, 80);
        return;
      }
      const rootRect = nextRoot.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      nextRoot.scrollTo({ top: Math.max(0, nextRoot.scrollTop + (nodeRect.top - rootRect.top) - 12), behavior: "auto" });
      window.setTimeout(() => {
        isRestoringViewRef.current = false;
        scheduleSync();
      }, 80);
    });
  }, [fileId, initialViewState, page, scheduleSync, totalPages, zoom]);

  useEffect(() => {
    if (!fileId) return;
    onProgressRef.current?.(page, totalPages);
  }, [fileId, page, totalPages]);

  useEffect(() => {
    if (sidebarTab !== "thumbs") return;
    if (lockedZoomPage !== null) return;
    const list = thumbListRef.current;
    const node = thumbItemRefs.current.get(page);
    if (!list || !node) return;
    const targetTop = node.offsetTop - list.clientHeight / 2 + node.clientHeight / 2;
    const boundedTop = Math.max(0, Math.min(targetTop, list.scrollHeight - list.clientHeight));
    const behavior: ScrollBehavior = Date.now() < thumbJumpUntilRef.current ? "auto" : "smooth";
    list.scrollTo({ top: boundedTop, behavior });
  }, [lockedZoomPage, page, sidebarTab]);

  const goToPage = useCallback(
    (pageNo: number, behavior: ScrollBehavior = "smooth", options?: { source?: "thumb" | "control" | "restore" }) => {
      const target = clampPage(pageNo, totalPages);
      const root = scrollRef.current;
      const node = pageRefs.current.get(target);
      if (!root || !node) {
        setPage(target);
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const targetTop = root.scrollTop + (nodeRect.top - rootRect.top) - 12;
      if (options?.source === "thumb") {
        suppressSyncUntilRef.current = Date.now() + 360;
        thumbJumpUntilRef.current = Date.now() + 420;
        setPage(target);
        setActivePages((prev) => {
          const next = new Set(prev);
          next.add(clampPage(target - 1, totalPages));
          next.add(target);
          next.add(clampPage(target + 1, totalPages));
          return equalSet(prev, next) ? prev : next;
        });
        root.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
        return;
      }
      root.scrollTo({ top: Math.max(0, targetTop), behavior });
      setPage(target);
    },
    [totalPages]
  );

  const goToSource = useCallback(
    (targetPage: number, sourceRect?: ReaderNote["sourceRect"]) => {
      const target = clampPage(targetPage, totalPages);
      if (!sourceRect) {
        goToPage(target, "auto");
        return;
      }
      goToPage(target, "auto");
      window.requestAnimationFrame(() => {
        const root = scrollRef.current;
        const node = pageRefs.current.get(target);
        if (!root || !node) return;
        const rootRect = root.getBoundingClientRect();
        const pageRect = node.getBoundingClientRect();
        const centerX = pageRect.left + sourceRect.x * pageRect.width + (sourceRect.width * pageRect.width) / 2;
        const centerY = pageRect.top + sourceRect.y * pageRect.height + (sourceRect.height * pageRect.height) / 2;
        root.scrollTo({
          left: Math.max(0, root.scrollLeft + centerX - rootRect.left - root.clientWidth / 2),
          top: Math.max(0, root.scrollTop + centerY - rootRect.top - root.clientHeight / 2),
          behavior: "auto",
        });
        emitViewState({ page: target, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft });
      });
    },
    [emitViewState, goToPage, totalPages]
  );

  const showActionHint = (message: string) => {
    setActionHint(message);
    window.setTimeout(() => setActionHint(""), 2000);
  };
  const exportPng = async (target?: { pageNo: number; imageTarget?: ImageContextTarget | null }) => {
    if (!fileId) return;
    const targetPage = clampPage(target?.pageNo ?? page, totalPages);
    try {
      const pageSize = pageSizes[targetPage] || DEFAULT_PAGE_SIZE;
      const imageTarget = target?.imageTarget;
      const extracted = imageTarget?.image.source === "xref" && imageTarget.image.xref > 0
        ? await api.extractPDFImage(fileId, targetPage, imageTarget.image.xref)
        : null;
      // Original xref resources do not need a full-page raster first. This is
      // faster and avoids making a large export part of a small image action.
      const pagePngBase64 = extracted ? "" : await api.exportPagePNG(fileId, targetPage, 2);
      const pngBase64 = extracted?.dataBase64
        ?? (imageTarget ? await cropPngBase64(pagePngBase64, imageTarget.rect, pageSize) : pagePngBase64);
      const baseName = cleanBaseName(title || "document");
      const extension = extracted?.extension || "png";
      const defaultName = imageTarget
        ? `${baseName}-page-${targetPage}-image-${imageTarget.image.xref || "crop"}.${extension}`
        : `${baseName}-page-${targetPage}.png`;
      if (extracted) {
        await api.saveImageToFile(pngBase64, onResolveDefaultPath?.(defaultName) || defaultName, extension);
      } else {
        await api.savePNGToFile(pngBase64, onResolveDefaultPath?.(defaultName) || defaultName);
      }
      showActionHint(t.pngExported);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(`PNG export failed: ${message}`);
    }
  };
  const exportSvg = async (target?: { pageNo: number; imageTarget?: ImageContextTarget | null }) => {
    if (!fileId) return;
    const targetPage = clampPage(target?.pageNo ?? page, totalPages);
    try {
      const imageTarget = target?.imageTarget;
      const svg = imageTarget
        ? await api.exportPageSVGCrop(fileId, targetPage, imageTarget.rect)
        : await api.exportPageSVG(fileId, targetPage);
      const baseName = cleanBaseName(title || "document");
      const defaultName = imageTarget
        ? `${baseName}-page-${targetPage}-image-${imageTarget.image.xref || "crop"}.svg`
        : `${baseName}-page-${targetPage}.svg`;
      await api.saveSVGToFile(svg, onResolveDefaultPath?.(defaultName) || defaultName);
      showActionHint(t.svgExported);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(`SVG export failed: ${message}`);
    }
  };


  const handleSearch = async () => {
    if (!pdfDoc) return;

    const query = window.prompt(t.searchKeywordPrompt);
    if (query === null) return;

    const trimmed = query.trim();
    if (!trimmed) {
      showActionHint(t.enterKeyword);
      return;
    }

    setRenderError("");
    setIsSearching(true);
    try {
      const needle = trimmed.toLowerCase();
      for (let pageNo = 1; pageNo <= pdfDoc.numPages; pageNo += 1) {
        const pdfPage = await pdfDoc.getPage(pageNo);
        const textContent = await pdfPage.getTextContent();
        const text = textContent.items
          .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
          .join(" ")
          .toLowerCase();

        if (text.includes(needle)) {
          goToPage(pageNo, "auto");
          showActionHint(t.foundOnPage.replace("{page}", String(pageNo)));
          return;
        }
      }
      showActionHint(t.noMatches.replace("{query}", trimmed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(`Search failed: ${message}`);
    } finally {
      setIsSearching(false);
    }
  };

  const submitNote = () => {
    const trimmed = noteDraft.trim();
    if (!trimmed) return;
    onAddNote?.(page, trimmed, activeTool === "highlight" ? "highlight" : "note");
    setNoteDraft("");
    showActionHint(t.noteAdded);
  };

  const updateDraftPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handleAnnotationPointerDown = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (!isAnnotationTool(activeTool)) return;
    const point = updateDraftPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftAnnotation({
      page: pageNo,
      kind: activeTool,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
    setSelectedAnnotationId(null);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleAnnotationPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draftAnnotation) return;
    const point = updateDraftPoint(event);
    if (!point) return;
    setDraftAnnotation((prev) =>
      prev
        ? {
            ...prev,
            currentX: point.x,
            currentY: point.y,
          }
        : prev
    );
  };

  const commitDraftAnnotation = async () => {
    if (!draftAnnotation) return;
    const { kind, page: targetPage, startX, startY, currentX, currentY } = draftAnnotation;
    setDraftAnnotation(null);

    let rect = normalizeRect(startX, startY, currentX, currentY);
    let content: string | undefined;

    if (kind === "text") {
      rect = createTextRect(startX, startY);
      const raw = window.prompt(t.textAnnotationPrompt);
      if (raw === null) return;
      const trimmed = raw.trim();
      if (!trimmed) {
        showActionHint(t.textAnnotationCancelled);
        return;
      }
      content = trimmed;
    } else if (rect.width < 0.01 && rect.height < 0.01) {
      showActionHint(t.dragToCreate);
      return;
    }

    onAddAnnotation?.({
      page: targetPage,
      kind,
      rect,
      content,
    });
    setPage(targetPage);
    setIsNotesOpen(true);
    showActionHint(t.annotationSaved.replace("{label}", annotationLabels[kind]));
  };

  const handleAnnotationPointerUp = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (!draftAnnotation || draftAnnotation.page !== pageNo) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void commitDraftAnnotation();
  };

  const handleAnnotationPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (draftAnnotation && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraftAnnotation(null);
  };

  const detachRightWindowHandlers = useCallback(() => {
    const handlers = rightWindowHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("pointermove", handlers.onMove as EventListener);
    window.removeEventListener("pointerup", handlers.onUp as EventListener);
    window.removeEventListener("pointercancel", handlers.onCancel as EventListener);
    rightWindowHandlersRef.current = null;
  }, []);

  const cancelRightGesture = useCallback(
    (pointerId: number) => {
      const right = rightDragRef.current;
      if (!right.active || right.pointerId !== pointerId) return;

      rightDragRef.current = { active: false, moved: false, pointerId: null, pageNo: null };
      gestureStartRef.current = null;
      detachRightWindowHandlers();
      setIsGestureRightDown(false);
      window.setTimeout(() => {
        lockedZoomPageRef.current = null;
        setLockedZoomPage(null);
      }, ZOOM_LOCK_RELEASE_DELAY_MS);
      suppressNextContextMenuRef.current = true;
      window.setTimeout(() => {
        suppressNextContextMenuRef.current = false;
      }, 120);
    },
    [detachRightWindowHandlers]
  );


  const moveRightGesture = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const right = rightDragRef.current;
      if (!right.active || right.pointerId !== pointerId) return;
      const start = gestureStartRef.current;
      if (!start) {
        gestureStartRef.current = { x: clientX, y: clientY };
        return;
      }

      const dx = clientX - start.x;
      const dy = clientY - start.y;
      if (!right.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        rightDragRef.current = { ...right, moved: true };
      }

      if (!right.moved) return;

      const root = scrollRef.current;
      if (root) {
        root.scrollLeft -= dx;
        root.scrollTop -= dy;
      }

      gestureStartRef.current = { x: clientX, y: clientY };
    },
    []
  );

  const endRightGesture = useCallback(
    (pointerId: number, clientX: number, clientY: number, options?: { openMenuIfClick?: boolean }) => {
      const right = rightDragRef.current;
      if (!right.active || right.pointerId !== pointerId) return false;

      const shouldOpenMenu = Boolean(options?.openMenuIfClick) && !right.moved;

      rightDragRef.current = { active: false, moved: false, pointerId: null, pageNo: null };
      gestureStartRef.current = null;
      detachRightWindowHandlers();
      setIsGestureRightDown(false);
      window.setTimeout(() => {
        lockedZoomPageRef.current = null;
        setLockedZoomPage(null);
      }, ZOOM_LOCK_RELEASE_DELAY_MS);

      // suppress the native/contextmenu event that usually fires after right click release
      suppressNextContextMenuRef.current = true;
      window.setTimeout(() => {
        suppressNextContextMenuRef.current = false;
      }, 120);

      if (shouldOpenMenu && right.pageNo) {
        setPage(clampPage(right.pageNo, totalPages));
        setContextMenu({
          x: clientX,
          y: clientY,
          isOpen: true,
          pageNo: clampPage(right.pageNo, totalPages),
          imageTarget: imageTargetAtPointRef.current(right.pageNo, clientX, clientY),
        });
      }

      return true;
    },
    [detachRightWindowHandlers, totalPages]
  );


  const attachRightWindowHandlers = useCallback(() => {
    if (rightWindowHandlersRef.current) return;
    const onMove = (event: PointerEvent) => {
      moveRightGesture(event.pointerId, event.clientX, event.clientY);
      // avoid text selection / native gestures while right-dragging
      event.preventDefault();
    };
    const onUp = (event: PointerEvent) => {
      if (endRightGesture(event.pointerId, event.clientX, event.clientY, { openMenuIfClick: true })) {
        event.preventDefault();
      }
    };
    const onCancel = (event: PointerEvent) => {
      cancelRightGesture(event.pointerId);
    };

    rightWindowHandlersRef.current = { onMove, onUp, onCancel };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    window.addEventListener("pointercancel", onCancel, { passive: true });
  }, [cancelRightGesture, endRightGesture, moveRightGesture]);

  const handleViewerPointerDown = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    const isRight = event.button === 2 || (event.buttons & 2) === 2;
    if (isRight) {
      const lockedPage = clampPage(pageNo, totalPages);
      rightDragRef.current = { active: true, moved: false, pointerId: event.pointerId, pageNo: lockedPage };
      lockedZoomPageRef.current = lockedPage;
      gestureStartRef.current = { x: event.clientX, y: event.clientY };
      setIsGestureRightDown(true);
      setLockedZoomPage(lockedPage);
      setPage(lockedPage);
      const nextActive = new Set<number>();
      for (let delta = -PAGE_RENDER_OVERSCAN_WHILE_ZOOMING; delta <= PAGE_RENDER_OVERSCAN_WHILE_ZOOMING; delta += 1) {
        nextActive.add(clampPage(lockedPage + delta, totalPages));
      }
      setActivePages(nextActive);
      attachRightWindowHandlers();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures; window listeners will still track the gesture
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleAnnotationPointerDown(pageNo, event);
  };

  const handleViewerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const right = rightDragRef.current;
    if (right.active && right.pointerId === event.pointerId) {
      moveRightGesture(event.pointerId, event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleAnnotationPointerMove(event);
  };

  const handleViewerPointerUp = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    const right = rightDragRef.current;
    if (right.active && right.pointerId === event.pointerId && right.pageNo === pageNo) {
      endRightGesture(event.pointerId, event.clientX, event.clientY, { openMenuIfClick: true });
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleAnnotationPointerUp(pageNo, event);
  };

  const handleViewerPointerCancel = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    const right = rightDragRef.current;
    if (right.active && right.pointerId === event.pointerId && right.pageNo === pageNo) {
      cancelRightGesture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleAnnotationPointerCancel(event);
  };

  const draftRect = useMemo(() => {
    if (!draftAnnotation) return null;
    if (draftAnnotation.kind === "text") {
      return createTextRect(draftAnnotation.startX, draftAnnotation.startY);
    }
    return normalizeRect(
      draftAnnotation.startX,
      draftAnnotation.startY,
      draftAnnotation.currentX,
      draftAnnotation.currentY
    );
  }, [draftAnnotation]);

  const updateReadingBlocks = useCallback((pageNo: number, blocks: PdfReadingBlock[]) => {
    if (blocks.length === 0) {
      readingBlocksByPageRef.current.delete(pageNo);
      return;
    }
    readingBlocksByPageRef.current.set(pageNo, blocks.map((block) => ({ ...block, documentId: documentId || block.documentId })));
  }, [documentId]);

  const updatePageLinks = useCallback((pageNo: number, links: Array<{ url: string }>) => {
    setLinksByPage((previous) => {
      const next = {
        ...previous,
        [pageNo]: links.map((link, index) => ({
        ...link,
        page: pageNo,
        documentId,
        resourceId: `${documentId || fileId}:link:${pageNo}:${index}:${link.url}`,
      })),
      };
      linksByPageRef.current = next;
      return next;
    });
  }, [documentId, fileId]);

  const storeReadingBlocks = useCallback((blocks: PdfReadingBlock[]) => {
    const byPage = new Map<number, PdfReadingBlock[]>();
    for (const block of blocks) {
      const pageBlocks = byPage.get(block.page) || [];
      pageBlocks.push(block);
      byPage.set(block.page, pageBlocks);
    }
    for (const [pageNo, pageBlocks] of byPage) {
      readingBlocksByPageRef.current.set(pageNo, pageBlocks.map((block) => ({ ...block, documentId: documentId || block.documentId })));
    }
  }, [documentId]);

  const loadPageReadingBlocks = useCallback(async (pageNo: number) => {
    if (!fileId) return [] as PdfReadingBlock[];
    const target = clampPage(pageNo, totalPages);
    const blocks = await api.getPDFReadingBlocks(fileId, undefined, undefined, {
      startPage: target,
      endPage: target,
    });
    storeReadingBlocks(blocks);
    setReadingBlocksVersion((value) => value + 1);
    return blocks;
  }, [fileId, storeReadingBlocks, totalPages]);

  const detectPageImages = useCallback(
    async (pageNo: number) => {
      if (!fileId) return;
      const target = clampPage(pageNo, totalPages);
      if (pdfImagesByPageRef.current[target] !== undefined || imageDetectionInFlightRef.current.has(target)) return;
      imageDetectionInFlightRef.current.add(target);
      try {
        const { images } = await api.getPDFImages(fileId, target);
        setPdfImagesByPage((prev) => {
          const nextImages = images.map((image, index) => ({
            ...image,
            documentId: documentId || image.documentId,
            resourceId: image.resourceId || `${documentId || fileId}:image:${target}:${image.xref || index}`,
          }));
          const next = { ...prev, [target]: nextImages };
          pdfImagesByPageRef.current = next;
          return next;
        });
        return images;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setImageLabelStatus({ kind: "error", message: t.imageLabelFailed.replace("{message}", message) });
        throw error;
      } finally {
        imageDetectionInFlightRef.current.delete(target);
      }
    },
    [documentId, fileId, t.imageLabelFailed, totalPages]
  );

  const ensureReadingBlocksLoaded = useCallback((signal?: AbortSignal) => {
    if (!fileId) return Promise.resolve([] as PdfReadingBlock[]);
    if (readingBlocksLoadedFileRef.current === fileId) {
      return Promise.resolve(Array.from(readingBlocksByPageRef.current.values()).flat());
    }
    if (readingBlocksLoadRef.current) return readingBlocksLoadRef.current;
    readingBlocksLoadRef.current = api.getPDFReadingBlocks(fileId, (completed, total) => {
        setImageLabelStatus({
          kind: "loading",
          message: language === "zh-CN" ? `正在抽取全文块 ${completed}/${total} 页...` : `Extracting reading blocks ${completed}/${total} pages...`,
        });
      }, signal)
      .then((blocks) => {
        storeReadingBlocks(blocks);
        readingBlocksLoadedFileRef.current = fileId;
        setReadingBlocksVersion((value) => value + 1);
        return blocks;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setImageLabelStatus({ kind: "error", message: t.imageLabelFailed.replace("{message}", message) });
        throw error;
      })
      .finally(() => {
        readingBlocksLoadRef.current = null;
      });
    return readingBlocksLoadRef.current;
  }, [fileId, language, storeReadingBlocks, t.imageLabelFailed]);

  const getVisibleImagesForPage = useCallback(
    (pageNo: number) => {
      const pageSize = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
      const pageReadingBlocks = readingBlocksByPageRef.current.get(pageNo) || [];
      const xrefItems = (pdfImagesByPage[pageNo] || [])
        .map((img) => {
          const bbox = Array.isArray(img.bbox) && img.bbox.length === 4 ? img.bbox : null;
          const rect = bbox ? normalizeImageBbox(bbox, pageSize) : null;
          if (!rect) return null;
          if (!isLikelyImageCandidate(img, rect, pageSize, pageReadingBlocks)) return null;
          return { img, rect };
        })
        .filter((item): item is { img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } } => Boolean(item));
      const blockItems = pageReadingBlocks
        .map((block) => imageBlockToCandidate(block, pageSize))
        .filter((item): item is { img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } } => Boolean(item));
      return dedupeImageCandidates([...xrefItems, ...blockItems], pageSize);
    },
    [pageSizes, pdfImagesByPage, readingBlocksVersion]
  );

  imageTargetAtPointRef.current = (pageNo, clientX, clientY) => {
    const targetPage = clampPage(pageNo, totalPages);
    const pageNode = pageRefs.current.get(targetPage);
    if (!pageNode) return null;
    const pageRect = pageNode.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return null;
    const pageSize = pageSizes[targetPage] || DEFAULT_PAGE_SIZE;
    const localX = ((clientX - pageRect.left) / pageRect.width) * pageSize.width;
    const localY = ((clientY - pageRect.top) / pageRect.height) * pageSize.height;
    const hit = getVisibleImagesForPage(targetPage).find(({ rect }) =>
      localX >= rect.left &&
      localX <= rect.left + rect.width &&
      localY >= rect.top &&
      localY <= rect.top + rect.height
    );
    return hit ? { pageNo: targetPage, image: hit.img, rect: hit.rect } : null;
  };

  const prefetchImageLabelsAround = useCallback(
    (centerPage: number) => {
      if (!fileId || !pdfDoc) return;
      const target = clampPage(centerPage, totalPages);
      const backgroundPages = [target + 1, target - 1]
        .map((item) => clampPage(item, totalPages))
        .filter((item, index, array) => array.indexOf(item) === index);
      setImageLabelStatus({ kind: "loading", message: t.imageLabelDetecting });
      void detectPageImages(target)
        .then(async (results) => {
          const nearbyPages = [target, ...backgroundPages].filter((pageNo, index, pages) => pages.indexOf(pageNo) === index);
          await Promise.all(nearbyPages.map(async (pageNo) => {
            try {
              await loadPageReadingBlocks(pageNo);
            } catch {
              // Xref/vector detection remains useful when the optional page block fallback fails.
            }
          }));
          for (const pageNo of backgroundPages) void detectPageImages(pageNo).catch(() => undefined);
          const count = Math.max(results?.length ?? 0, getVisibleImagesForPage(target).length);
          setImageLabelStatus({ kind: "ready", message: t.imageLabelReady.replace("{count}", String(count)) });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setImageLabelStatus({ kind: "error", message: t.imageLabelFailed.replace("{message}", message) });
        });
    },
    [detectPageImages, fileId, getVisibleImagesForPage, loadPageReadingBlocks, pdfDoc, t.imageLabelDetecting, t.imageLabelFailed, t.imageLabelReady, totalPages]
  );

  const getCollectedReadingBlocks = useCallback(() => {
    return Array.from(readingBlocksByPageRef.current.values())
      .flat()
      .filter((block) => block.text.trim().length > 0)
      .sort((left, right) => (left.page === right.page ? left.id.localeCompare(right.id) : left.page - right.page));
  }, []);

  const loadFullTranslationBlocks = useCallback(async (signal: AbortSignal) => {
    if (!fileId) return getCollectedReadingBlocks();
    try {
      const blocks = await ensureReadingBlocksLoaded(signal);
      if (signal.aborted) return [];
      const textBlocks = blocks
        .filter((block) => block.text.trim().length > 0)
        .sort((left, right) => (left.page === right.page ? left.id.localeCompare(right.id) : left.page - right.page));
      if (textBlocks.length > 0) {
        storeReadingBlocks(textBlocks);
        return textBlocks;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showActionHint(
        language === "zh-CN"
          ? `全文块抽取失败，改用已加载页面：${message}`
          : `Full-document block extraction failed; using loaded pages: ${message}`
      );
    }
    return getCollectedReadingBlocks();
  }, [ensureReadingBlocksLoaded, fileId, getCollectedReadingBlocks, language, storeReadingBlocks]);

  const startFullTranslation = useCallback(() => {
    if (!fileId) {
      showActionHint(language === "zh-CN" ? "请先打开 PDF。" : "Open a PDF first.");
      return;
    }

    fullTranslationAbortRef.current?.abort();
    const controller = new AbortController();
    fullTranslationAbortRef.current = controller;
    setIsNotesOpen(true);
    setSidePanelView("translation");
    setFullTranslation({
      status: language === "zh-CN" ? "正在抽取全文块..." : "Extracting full-document blocks...",
      completed: 0,
      total: 0,
      results: [],
      isLoading: true,
    });

    void loadFullTranslationBlocks(controller.signal)
      .then((blocks) => {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("全文翻译已取消。");
        }
        if (blocks.length === 0) {
          throw new Error(language === "zh-CN" ? "未抽取到可翻译文本块。" : "No translatable text blocks were extracted.");
        }
        setFullTranslation((prev) => ({
          ...prev,
          status: language === "zh-CN" ? "正在分块翻译..." : "Translating blocks...",
          total: blocks.length,
        }));
        const cached = loadTranslationCache("pdf", documentId || fileId, aiModelConfig, blocks);
        if (cached) {
          return Promise.resolve({ blocks, results: cached.results });
        }
        return translateReadingBlocks({
          config: aiModelConfig,
          blocks,
          sourceTitle: title,
          signal: controller.signal,
          onProgress: (completed, total, latest) => {
            setFullTranslation((prev) => ({
              ...prev,
              completed,
              total,
              status: `${completed}/${total}`,
              results: latest ? [...prev.results, latest] : prev.results,
            }));
          },
        }).then((results) => ({ blocks, results }));
      })
      .then((results) => {
        saveTranslationCache("pdf", documentId || fileId, aiModelConfig, results.blocks, results.results);
        setFullTranslation({
          status: language === "zh-CN" ? "全文翻译完成" : "Full translation complete",
          completed: results.results.length,
          total: results.blocks.length,
          results: results.results,
          isLoading: false,
        });
      })
      .catch((error) => {
        const aborted = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        setFullTranslation((prev) => ({
          ...prev,
          status: aborted ? (language === "zh-CN" ? "全文翻译已取消" : "Full translation cancelled") : `${t.translateFailed}: ${message}`,
          isLoading: false,
        }));
      })
      .finally(() => {
        if (fullTranslationAbortRef.current === controller) {
          fullTranslationAbortRef.current = null;
        }
      });
  }, [aiModelConfig, documentId, fileId, language, loadFullTranslationBlocks, t.translateFailed, title]);

  const retryFullTranslationBlock = useCallback(async (block: PdfReadingBlock) => {
    if (!fileId) return;
    setFullTranslation((prev) => ({ ...prev, status: language === "zh-CN" ? "正在重试段落..." : "Retrying block..." }));
    try {
      const result = await translateReadingBlock({ config: aiModelConfig, block, sourceTitle: title });
      setFullTranslation((prev) => {
        const results = [...prev.results.filter((item) => item.block.id !== block.id), result].sort((a, b) => a.block.id.localeCompare(b.block.id));
        saveTranslationCache("pdf", documentId || fileId, aiModelConfig, results.map((item) => item.block), results);
        return { ...prev, results, status: language === "zh-CN" ? "段落翻译已更新" : "Block translation updated" };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFullTranslation((prev) => ({ ...prev, results: prev.results.map((item) => item.block.id === block.id ? { ...item, error: message } : item), status: `${t.translateFailed}: ${message}` }));
    }
  }, [aiModelConfig, documentId, fileId, language, t.translateFailed, title]);

  const openTranslationPreview = useCallback(
    (selection: ReadingAssistSelection) => {
      setIsNotesOpen(true);
      setSidePanelView("translation");
      setTranslationPanel({
        selection,
        answer: "",
        status: t.translating,
        isLoading: true,
      });
      void translateReadingSelection({
        config: aiModelConfig,
        excerpt: selection.text,
        reference: `${selection.sourceTitle} / ${selection.reference}`,
      })
        .then((result) => {
          setTranslationPanel({
            selection,
            answer: result.answer,
            status: "",
            isLoading: false,
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setTranslationPanel({
            selection,
            answer: "",
            status: `${t.translateFailed}: ${message}`,
            isLoading: false,
          });
        });
    },
    [aiModelConfig, t.translateFailed, t.translating]
  );

  useEffect(() => {
    if (!fileId || !pdfDoc) return;
    if (isImageLabelReader) {
      prefetchImageLabelsAround(page);
      return;
    }
    void detectPageImages(page);
  }, [detectPageImages, fileId, isImageLabelReader, page, pdfDoc, prefetchImageLabelsAround]);

  useEffect(() => {
    if (!fileId || !pdfDoc || sidePanelView !== "resources") return;
    const scanId = ++resourcesScanRef.current;
    const controller = new AbortController();
    resourceScanAbortRef.current?.abort();
    resourceScanAbortRef.current = controller;
    setResourceScan({ status: "scanning", completed: 0, total: totalPages, failedPages: [] });
    void ensureReadingBlocksLoaded(controller.signal).catch(() => undefined);
    void (async () => {
      const failedPages: number[] = [];
      for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
        if (controller.signal.aborted || resourcesScanRef.current !== scanId) return;
        if (pdfImagesByPageRef.current[pageNo] !== undefined && Object.prototype.hasOwnProperty.call(linksByPageRef.current, pageNo)) {
          setResourceScan((previous) => ({ ...previous, completed: pageNo }));
          continue;
        }
        try {
          const pageProxy = await pdfDoc.getPage(pageNo);
          const annotations = await pageProxy.getAnnotations();
          const links = (annotations as Array<Record<string, unknown>>)
            .filter((item) => item.subtype === "Link" && typeof item.url === "string" && item.url)
            .map((item, index) => ({
              url: item.url as string,
              page: pageNo,
              documentId,
              resourceId: `${documentId || fileId}:link:${pageNo}:${index}:${item.url as string}`,
            }));
          setLinksByPage((previous) => {
            const next = { ...previous, [pageNo]: links };
            linksByPageRef.current = next;
            return next;
          });
          await detectPageImages(pageNo);
        } catch {
          failedPages.push(pageNo);
        }
        setResourceScan((previous) => ({
          ...previous,
          completed: pageNo,
          failedPages: [...failedPages],
        }));
      }
      if (!controller.signal.aborted && resourcesScanRef.current === scanId) {
        setResourceScan({ status: "ready", completed: totalPages, total: totalPages, failedPages });
      }
    })();
    return () => {
      controller.abort();
      if (resourceScanAbortRef.current === controller) resourceScanAbortRef.current = null;
      setResourceScan((previous) => previous.status === "scanning" ? { ...previous, status: "cancelled" } : previous);
    };
  }, [detectPageImages, ensureReadingBlocksLoaded, fileId, pdfDoc, resourceScanAttempt, sidePanelView, totalPages]);

  const documentLinks = useMemo(
    () => Object.values(linksByPage).flat().filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index),
    [linksByPage]
  );
  const documentImages = useMemo(
    () => {
      const indexedPages = new Set<number>([
        ...Object.keys(pdfImagesByPage).map(Number),
        ...Array.from(readingBlocksByPageRef.current.keys()),
      ]);
      return Array.from(indexedPages)
        .filter((pageNo) => pageNo >= 1 && pageNo <= totalPages)
        .sort((left, right) => left - right)
        .flatMap((pageNo) => getVisibleImagesForPage(pageNo).map(({ img: image }) => ({ page: pageNo, image })));
    },
    [getVisibleImagesForPage, pdfImagesByPage, readingBlocksVersion, totalPages]
  );
  const documentDois = useMemo<DocumentDoiResource[]>(() => {
    const source = Array.from(readingBlocksByPageRef.current.values()).flat().map((block) => block.text).join("\n");
    return Array.from(new Set(source.match(/\b10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/gi) || []))
      .map((doi) => doi.replace(/[.,;:)]+$/, ""))
      .filter(Boolean)
      .map((doi) => ({ doi, documentId, resourceId: `${documentId || fileId}:doi:${doi}` }));
  }, [documentId, fileId, readingBlocksVersion]);

  const renderAnnotationCard = (annotation: ReaderAnnotation) => (
    <div
      key={annotation.id}
      className={`group relative rounded-2xl border p-4 ${
        selectedAnnotationId === annotation.id
          ? "border-zinc-900 dark:border-zinc-100 bg-zinc-100 dark:bg-zinc-800/50"
          : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950"
      }`}
      onClick={() => {
        setSelectedAnnotationId(annotation.id);
        goToSource(annotation.page, annotation.rect);
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          <span className="px-2 py-0.5 rounded-full" style={getAnnotationBadgeStyle(annotation.kind)}>
            {annotationLabels[annotation.kind]}
          </span>
          {t.page} {annotation.page}
        </div>
        {onRemoveAnnotation ? (
          <button
            className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onRemoveAnnotation(annotation.id);
            }}
            title={t.deleteAnnotation}
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
        x {Math.round(annotation.rect.x * 100)}% | y {Math.round(annotation.rect.y * 100)}% | w {Math.round(annotation.rect.width * 100)}% | h {Math.round(annotation.rect.height * 100)}%
      </div>
      <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
        {annotation.content || t.areaAnnotationSaved}
      </p>
      <div className="text-[11px] text-zinc-400 mt-3">{new Date(annotation.createdAt).toLocaleString()}</div>
    </div>
  );
  return (
    <div className="relative flex h-full bg-zinc-100 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200 font-sans overflow-hidden">
      {actionHint ? (
        <div className="absolute top-4 right-4 z-50 px-3 py-1.5 rounded-md text-xs shadow-lg" style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}>
          {actionHint}
        </div>
      ) : null}
      <ReadingAssistMenu
        selection={assistSelection}
        language={language}
        modelConfig={aiModelConfig}
        onClose={() => setAssistSelection(null)}
        onHint={showActionHint}
        onTranslate={openTranslationPreview}
        onSaveQuote={(selection, quote) => onAddNote?.(page, quote, "highlight", selection.reference, { documentId, blockId: selection.blockId, sourceRect: selection.sourceRect })}
        variant={isTranslationReader ? "inline-toolbar" : "panel"}
      />

      <div className={`${isLeftSidebarOpen ? "w-[196px]" : "w-0"} transition-[width] duration-150 ease-out bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 hidden md:flex md:flex-col shrink-0 overflow-hidden`}>
        <div className="w-[196px] flex border-b border-zinc-200 dark:border-zinc-800 items-center px-2 py-1.5">
          <button onClick={() => setSidebarTab("outline")} className={`flex-1 rounded-md px-2 py-2 text-sm font-semibold leading-none flex items-center justify-center gap-1.5 transition-colors ${sidebarTab === "outline" ? "text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800/70" : "text-zinc-500 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40"}`}>
            <List size={15} /> {t.outline}
          </button>
          <button onClick={() => setSidebarTab("thumbs")} className={`flex-1 rounded-md px-2 py-2 text-sm font-semibold leading-none flex items-center justify-center gap-1.5 transition-colors ${sidebarTab === "thumbs" ? "text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800/70" : "text-zinc-500 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40"}`}>
            <ImageIcon size={15} /> {t.thumbs}
          </button>
        </div>

        <div ref={thumbListRef} className="flex-1 overflow-y-auto p-3 space-y-2 text-sm text-zinc-600 dark:text-zinc-400 bg-zinc-50/60 dark:bg-zinc-950/60">
          {sidebarTab === "outline" ? (
            outlineTitles.length > 0 ? (
              outlineTitles.map((item, index) => (
                <button key={`${item}-${index}`} className="w-full text-left rounded-md px-2.5 py-2 leading-5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer" onClick={() => goToPage(index + 1)}>
                  {item}
                </button>
              ))
            ) : (
              <div className="text-zinc-400 dark:text-zinc-500">{t.noOutline}</div>
            )
          ) : (
            Array.from({ length: totalPages }, (_, index) => {
              const pageNo = index + 1;
              return (
                <PageThumbnail
                  key={pageNo}
                  doc={pdfDoc}
                  fileId={fileId}
                  pageNo={pageNo}
                  active={visiblePage === pageNo}
                  scrollRootRef={thumbListRef}
                  onClick={(targetPage) => goToPage(targetPage, "auto", { source: "thumb" })}
                  onItemRef={(targetPage, node) => {
                    if (node) thumbItemRefs.current.set(targetPage, node);
                    else thumbItemRefs.current.delete(targetPage);
                  }}
                  pageLabel={t.page}
                  onContextMenu={(targetPage, event) => {
                    setPage(clampPage(targetPage, totalPages));
                    setContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      isOpen: true,
                      pageNo: clampPage(targetPage, totalPages),
                      imageTarget: null,
                    });
                  }}
                />
              );
            })
          )}
        </div>
      </div>

      <div
        className="flex-1 flex flex-col min-w-0"
        style={{ paddingRight: isNotesOpen ? "20rem" : 0 }}
      >
        <div className="min-h-14 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 flex flex-nowrap items-center justify-between gap-2 px-3 py-2 shrink-0 shadow-sm z-30 overflow-visible">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <button
              type="button"
              className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors"
              onClick={() => {
                setIsLeftSidebarOpen((value) => !value);
                recenterVisiblePageSoon();
              }}
              title={isLeftSidebarOpen ? t.hideLeftSidebar : t.showLeftSidebar}
            >
              {isLeftSidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
            </button>
            <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-md mr-2 shrink-0">
              <ToolButton icon={<Hand size={16} />} active={activeTool === "hand"} onClick={() => setActiveTool("hand")} title={t.handTool} />
              <ToolButton icon={<MousePointer2 size={16} />} active={activeTool === "select"} onClick={() => setActiveTool("select")} title={t.selectText} />
              <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1 self-center" />
              <ToolButton icon={<Highlighter size={16} />} active={activeTool === "highlight"} onClick={() => setActiveTool("highlight")} title={t.highlight} />
              <ToolButton icon={<Underline size={16} />} active={activeTool === "underline"} onClick={() => setActiveTool("underline")} title={t.underline} />
              <ToolButton icon={<Strikethrough size={16} />} active={activeTool === "strike"} onClick={() => setActiveTool("strike")} title={t.strikethrough} />
              <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1 self-center" />
              <ToolButton icon={<Type size={16} />} active={activeTool === "text"} onClick={() => setActiveTool("text")} title={t.addText} />
            </div>

            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => smoothZoomBy(-12)} title={t.zoomOut}>
              <ZoomOut size={18} />
            </button>
            <span className="text-xs font-mono w-12 text-center text-zinc-600 dark:text-zinc-400">{Math.round(zoom)}%</span>
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => smoothZoomBy(12)} title={t.zoomIn}>
              <ZoomIn size={18} />
            </button>
            <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1" />
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => {
              captureZoomAnchor(visiblePage);
              zoomTargetRef.current = 100;
              scheduleRenderZoomCommit(100);
              animateZoomToTarget();
            }} title={t.resetZoom}>
              <Maximize size={18} />
            </button>
            <button
              type="button"
              className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors disabled:opacity-50"
              title={isSearching ? t.searching : t.search}
              onClick={() => {
                void handleSearch();
              }}
              disabled={!hasDoc || isSearching}
            >
              <Search size={18} />
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => goToPage(visiblePage - 1)} title={t.prevPage}>
              <ChevronLeft size={18} />
            </button>
            <div className="text-sm font-mono text-zinc-600 dark:text-zinc-400 flex items-center gap-1">
              <input type="text" inputMode="numeric" pattern="[0-9]*" value={visiblePage} onChange={(event) => {
                if (!/^\d*$/.test(event.target.value)) return;
                const next = Number(event.target.value);
                if (!Number.isFinite(next)) return;
                goToPage(next, "auto");
              }} className="w-14 text-center bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded py-0.5 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-100 text-zinc-900 dark:text-zinc-100" />
              <span className="text-zinc-400 dark:text-zinc-500">/ {totalPages}</span>
            </div>
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => goToPage(visiblePage + 1)} title={t.nextPage}>
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <div className="toolbar-lang">
              <button
                className="toolbar-responsive-action toolbar-responsive-action-primary"
                style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
                onClick={() => {
                  setIsImageExportOpen((value) => {
                    if (!value) {
                      void Promise.all([detectPageImages(page), loadPageReadingBlocks(page)]).catch(() => undefined);
                    }
                    return !value;
                  });
                }}
                disabled={!hasDoc}
                title={t.exportImages}
                aria-label={t.exportImages}
              >
                <ImageIcon size={18} />
              </button>
              {isImageExportOpen ? (
                <div className="absolute right-0 top-full z-[120] mt-2 w-72 rounded-lg border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.exportImagesTitle}</div>
                    <button type="button" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => setIsImageExportOpen(false)}>
                      {t.cancel}
                    </button>
                  </div>
                  <div className="max-h-80 space-y-1 overflow-y-auto">
                    {getVisibleImagesForPage(page).length > 0 ? (
                      getVisibleImagesForPage(page).map(({ img, rect }, idx) => (
                        <div key={`export-image-${page}-${idx}`} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                            <span className="font-mono">image-{idx + 1}</span>
                            <span className="font-mono">{Math.round(rect.width)}x{Math.round(rect.height)} · {img.extension || "unknown"}</span>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold"
                              style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
                              onClick={() => {
                                setIsImageExportOpen(false);
                                void exportPng({ pageNo: page, imageTarget: { pageNo: page, image: img, rect } });
                              }}
                            >
                              {t.exportImagePng}
                            </button>
                            <button
                              type="button"
                              className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                              onClick={() => {
                                setIsImageExportOpen(false);
                                void exportSvg({ pageNo: page, imageTarget: { pageNo: page, image: img, rect } });
                              }}
                            >
                              {t.exportImageSvg}
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        {t.noPdfImages}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/80">
              <button
                type="button"
                className={`toolbar-responsive-action ${
                  readerMode === "reader"
                    ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-white hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                }`}
                onClick={() => {
                  setReaderMode("reader");
                  setActiveTool("select");
                  recenterVisiblePageSoon();
                }}
                title={t.readerView}
                aria-label={t.readerView}
              >
                <BookOpen size={18} />
              </button>
              <button
                type="button"
                className={`toolbar-responsive-action ${
                  readerMode === "translation"
                    ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-white hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                }`}
                onClick={() => {
                  setReaderMode("translation");
                  setActiveTool("select");
                  setIsNotesOpen(true);
                  setSidePanelView("translation");
                  recenterVisiblePageSoon();
                }}
                title={t.translationView}
                aria-label={t.translationView}
              >
                <Languages size={18} />
              </button>
              <button
                type="button"
                className={`toolbar-responsive-action ${
                  readerMode === "image-label"
                    ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-white hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                }`}
                onClick={() => {
                  setReaderMode("image-label");
                  setActiveTool("hand");
                  prefetchImageLabelsAround(pageRef.current);
                  recenterVisiblePageSoon();
                }}
                title={t.imageLabelView}
                aria-label={t.imageLabelView}
              >
                <ImageIcon size={18} />
              </button>
            </div>
            <button className={`p-1.5 rounded-md transition-colors ${isNotesOpen ? "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800" : "text-zinc-400 dark:text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"}`} onClick={() => {
              setIsNotesOpen((value) => !value);
              recenterVisiblePageSoon();
            }} title={t.toggleNotes}>
              {isNotesOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto bg-zinc-200/50 dark:bg-zinc-950/50 relative z-0"
          onWheel={(event) => {
            if (!isGestureRightDown) return;
            event.preventDefault();
            event.stopPropagation();
            const lockedPage = lockedZoomPageRef.current ?? lockedZoomPage ?? visiblePage;
            const wheelMagnitude = Math.max(WHEEL_ZOOM_MIN_STEP, Math.min(24, Math.abs(event.deltaY) * WHEEL_ZOOM_SENSITIVITY));
            const step = event.deltaY < 0 ? wheelMagnitude : -wheelMagnitude;
            smoothZoomBy(step, { pageNo: lockedPage, clientX: event.clientX, clientY: event.clientY });
          }}
        >
          {isImageLabelReader && imageLabelStatus.kind !== "idle" ? (
            <div
              className={`pointer-events-none absolute right-4 top-4 z-20 max-w-sm rounded-md border px-3 py-1.5 text-xs shadow-sm ${
                imageLabelStatus.kind === "error"
                  ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/80 dark:text-red-200"
                  : "border-zinc-200 bg-white/95 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-300"
              }`}
            >
              {imageLabelStatus.message}
            </div>
          ) : null}
          {!fileId ? (
            <div className="w-full h-full flex items-center justify-center text-center p-8">
              <div className="space-y-4">
                <h2 className="font-serif text-2xl text-zinc-800 dark:text-zinc-200">{t.noPdfOpened}</h2>
                <p className="text-zinc-500 dark:text-zinc-400">{t.noPdfHint}</p>
                <button className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" onClick={onOpenFileDialog}>
                  <FolderOpen size={16} />
                  {t.openPdf}
                </button>
              </div>
            </div>
          ) : (
            <div className="min-h-full w-max min-w-full px-4 py-8 md:px-8">
              <div className="mx-auto flex w-fit flex-col items-center gap-6">
                {Array.from({ length: totalPages }, (_, index) => {
                  const pageNo = index + 1;
                  const size = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
                  const width = Math.max(1, Math.round(size.width * renderZoomScale));
                  const height = Math.max(1, Math.round(size.height * renderZoomScale));
                  const active = lockedZoomPage === null
                    ? activePages.has(pageNo)
                    : Math.abs(pageNo - lockedZoomPage) <= PAGE_RENDER_OVERSCAN_WHILE_ZOOMING;
                  const visualScale = lockedZoomPage === pageNo
                    ? zoomScale / Math.max(0.01, renderZoomScale)
                    : 1;
                  const pageAnnotationItems = active ? annotations.filter((annotation) => annotation.page === pageNo) : [];
                  const pageDraftRect = active && draftAnnotation?.page === pageNo ? draftRect : null;
                  const pageSize = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
                  // Keep image hit targets available in every PDF view. They are
                  // visually transparent outside image-label mode, so text
                  // selection remains native while image context actions work.
                  const visiblePageImages = active ? getVisibleImagesForPage(pageNo) : [];

                  return (
                    <div
                      key={pageNo}
                      ref={(node) => {
                        if (node) pageRefs.current.set(pageNo, node);
                        else pageRefs.current.delete(pageNo);
                      }}
                      data-pdf-page={pageNo}
                      className={`pdf-page-block relative overflow-hidden bg-white shadow-xl border origin-top ${isGestureRightDown ? "cursor-ns-resize" : activeTool === "hand" ? "cursor-grab active:cursor-grabbing" : activeTool === "select" ? "cursor-text" : "cursor-crosshair"} dark:invert dark:hue-rotate-180 ${visiblePage === pageNo ? "border-zinc-900/60" : "border-zinc-200"}`}
                      style={{
                        width,
                        height,
                        transform: visualScale === 1 ? undefined : `scale(${visualScale})`,
                        transformOrigin: "top center",
                        zIndex: visualScale === 1 ? undefined : 3,
                      }}
                      onPointerDown={(event) => handleViewerPointerDown(pageNo, event)}
                      onPointerMove={handleViewerPointerMove}
                      onPointerUp={(event) => handleViewerPointerUp(pageNo, event)}
                      onPointerCancel={(event) => handleViewerPointerCancel(pageNo, event)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (suppressNextContextMenuRef.current) {
                          return;
                        }
                        setPage(clampPage(pageNo, totalPages));
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          isOpen: true,
                          pageNo: clampPage(pageNo, totalPages),
                          imageTarget: null,
                        });
                      }}
                    >
                      {active ? (
                        <>
                          <PageCanvas
                          doc={pdfDoc}
                          pageNo={pageNo}
                          renderZoomScale={renderZoomScale}
                          active={active}
                          enableTextLayer={activeTool === "select" || isTranslationReader}
                          enableAssistBlocks={isTranslationReader}
                          linksEnabled={!isTranslationReader}
                          onSize={updatePageSize}
                          onError={setRenderError}
                          renderingLabel={t.rendering}
                          onOpenExternal={onOpenExternal}
                          onAssistSelection={
                            isTranslationReader
                              ? (selection) =>
                                  setAssistSelection({
                                    ...selection,
                                    id: `translation-${pageNo}-${Date.now()}`,
                                    sourceTitle: title,
                                  })
                              : undefined
                          }
                          onReadingBlocks={updateReadingBlocks}
                          onPageLinks={updatePageLinks}
                          />
                          <div
                            className="absolute inset-0"
                            style={{ pointerEvents: (activeTool === "select" || isTranslationReader) && !isGestureRightDown ? "none" : "auto" }}
                          >
                            {pageAnnotationItems.map((annotation) => (
                              <button
                                key={annotation.id}
                                type="button"
                                className={`absolute rounded-sm transition-all ${annotation.kind === "text" ? "px-2 py-1 text-left overflow-hidden" : ""}`}
                                style={getAnnotationOverlayStyle(annotation, selectedAnnotationId === annotation.id)}
                                title={annotation.content || annotationLabels[annotation.kind]}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedAnnotationId(annotation.id);
                                  setPage(pageNo);
                                  setIsNotesOpen(true);
                                }}
                              >
                                {annotation.kind === "text" ? (
                                  <span className="block text-[11px] leading-4 text-white whitespace-pre-wrap">{annotation.content}</span>
                                ) : null}
                              </button>
                            ))}
                            {pageDraftRect && draftAnnotation ? (
                              <div className="absolute pointer-events-none rounded-sm" style={getDraftOverlayStyle(draftAnnotation.kind, pageDraftRect)} />
                            ) : null}
                          </div>
                          {visiblePageImages.map(({ img, rect }, idx) => {
                            return (
                              <div
                                key={`img-box-${pageNo}-${idx}`}
                                className="absolute overflow-visible"
                                style={{
                                  left: `${(rect.left / pageSize.width) * 100}%`,
                                  top: `${(rect.top / pageSize.height) * 100}%`,
                                  width: `${(Math.max(1, rect.width) / pageSize.width) * 100}%`,
                                  height: `${(Math.max(1, rect.height) / pageSize.height) * 100}%`,
                                  pointerEvents: isImageLabelReader ? "auto" : "none",
                                  border: isImageLabelReader ? "1px solid color-mix(in srgb, var(--reader-accent) 82%, transparent)" : "1px solid transparent",
                                  backgroundColor: isImageLabelReader ? "color-mix(in srgb, var(--reader-accent) 13%, transparent)" : "transparent",
                                }}
                                onPointerDown={(event) => {
                                  if (event.button === 2 || (event.buttons & 2) === 2) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setPage(clampPage(pageNo, totalPages));
                                  setContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    isOpen: true,
                                    pageNo: clampPage(pageNo, totalPages),
                                    imageTarget: { pageNo, image: img, rect },
                                  });
                                }}
                              >
                                {isImageLabelReader ? <span
                                  className="absolute left-0 top-0 rounded-br-md px-1.5 py-0.5 text-[10px] font-mono"
                                  style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
                                >
                                  {t.imageType}: {img.extension || "unknown"}
                                </span> : null}
                              </div>
                            );
                          })}
                          {visiblePage === pageNo ? <div className="pointer-events-none absolute inset-0 ring-1 ring-zinc-900/25" /> : null}
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {loading ? <div className="absolute inset-0 flex items-center justify-center bg-white/60 dark:bg-zinc-950/60 text-zinc-500 text-sm">{t.loadingPdf}</div> : null}
          {renderError ? <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-md bg-red-50 text-red-700 text-xs border border-red-200 shadow-sm">{renderError}</div> : null}
        </div>
      </div>

      <div
        className={`absolute right-0 top-0 z-40 hidden h-full w-[20rem] transform-gpu flex-col overflow-hidden border-l border-zinc-200 bg-white shadow-[-18px_0_38px_rgba(15,23,42,0.08)] transition-transform duration-200 ease-out will-change-transform dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-[-18px_0_38px_rgba(0,0,0,0.32)] lg:flex ${
          isNotesOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isNotesOpen}
      >
        <div className="w-[20rem] flex flex-col h-full">
          <div className="h-14 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between px-4 shrink-0 bg-zinc-50 dark:bg-zinc-950">
            <div className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100 text-sm">
              {sidePanelView === "translation" ? <Languages size={16} /> : sidePanelView === "resources" ? <Link2 size={16} /> : <MessageSquare size={16} />}
              {sidePanelView === "translation" ? t.translationPreview : sidePanelView === "resources" ? t.resources : t.notesAnnotations}
            </div>
            <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium" style={{ backgroundColor: "var(--reader-accent-soft)", color: "var(--reader-accent)" }}>
              <Sparkles size={12} /> {t.page} {page}
            </div>
          </div>

          <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 p-1">
              <button
                type="button"
                className={`h-8 rounded-md text-xs font-semibold transition-colors ${sidePanelView === "notes" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"}`}
                onClick={() => setSidePanelView("notes")}
              >
                {t.sidePanelNotes}
              </button>
              <button
                type="button"
                className={`h-8 rounded-md text-xs font-semibold transition-colors ${sidePanelView === "translation" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"}`}
                onClick={() => setSidePanelView("translation")}
              >
                {t.sidePanelTranslation}
              </button>
              <button
                type="button"
                className={`h-8 rounded-md text-xs font-semibold transition-colors ${sidePanelView === "resources" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"}`}
                onClick={() => setSidePanelView("resources")}
              >
                {t.sidePanelResources}
              </button>
            </div>
          </div>

          {sidePanelView === "translation" ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-white dark:bg-zinc-900">
              <div>
                <div className="font-serif text-2xl font-bold text-zinc-900 dark:text-zinc-100 leading-tight">{t.translationPreview}</div>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">
                  {fullTranslation.status || translationPanel?.selection.reference || t.translationEmpty}
                </p>
              </div>
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">{aiModelConfig.model || "model"}</div>
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{aiModelConfig.baseUrl || "LiteLLM / OpenAI-compatible"}</div>
                  </div>
                  {fullTranslation.isLoading ? (
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs font-medium bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                      onClick={() => fullTranslationAbortRef.current?.abort()}
                    >
                      {t.cancel}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs font-medium"
                      style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
                      onClick={startFullTranslation}
                    >
                      {t.fullTranslation}
                    </button>
                  )}
                </div>
                {fullTranslation.total > 0 ? (
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full transition-[width]"
                      style={{
                        width: `${Math.min(100, Math.round((fullTranslation.completed / Math.max(1, fullTranslation.total)) * 100))}%`,
                        backgroundColor: "var(--reader-accent)",
                      }}
                    />
                  </div>
                ) : null}
              </div>
              {translationPanel ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{translationPanel.selection.sourceTitle}</div>
                    <div className="max-h-48 overflow-auto text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                      {translationPanel.selection.text}
                    </div>
                  </div>
                  <div className="min-h-48 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 text-sm leading-6 text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">
                    {translationPanel.status || translationPanel.answer}
                  </div>
                </div>
              ) : null}
              {fullTranslation.results.length > 0 ? (
                <div className="space-y-3">
                  <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    {language === "zh-CN" ? "全文分块翻译" : "Full Translation Blocks"}
                  </div>
                  {fullTranslation.results.map((item) => (
                    <div key={item.block.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400"><span>{t.page} {item.block.page}</span><span>{item.block.kind}</span></div>
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <div className="min-w-0 rounded-lg bg-zinc-50 p-3 text-[11px] leading-5 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"><div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">{language === "zh-CN" ? "原文" : "Source"}</div>{item.block.text}</div>
                        <div className="min-w-0 rounded-lg border border-[var(--reader-accent)]/20 bg-[var(--reader-accent-soft)] p-3 text-sm leading-6 text-zinc-900 dark:text-zinc-100 whitespace-pre-wrap"><div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--reader-accent)" }}>{language === "zh-CN" ? "译文" : "Translation"}</div>{item.error ? <div className="space-y-2 text-red-600 dark:text-red-400"><div>{item.error}</div><button type="button" onClick={() => void retryFullTranslationBlock(item.block)} className="rounded border border-red-300 px-2 py-1 text-xs">{language === "zh-CN" ? "重试此段" : "Retry block"}</button></div> : item.translation}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : !translationPanel ? (
                <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  {t.translationEmpty}
                </div>
              ) : (
                null
              )}
            </div>
          ) : sidePanelView === "resources" ? (
            <div className="flex-1 overflow-y-auto space-y-5 bg-white p-5 dark:bg-zinc-900">
              <div>
                <div className="font-serif text-2xl font-bold leading-tight text-zinc-900 dark:text-zinc-100">{t.resources}</div>
                <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t.resourcesIntro}</p>
                {resourceScan.status === "scanning" ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"><span className="block h-full rounded-full" style={{ width: `${Math.round((resourceScan.completed / Math.max(1, resourceScan.total)) * 100)}%`, backgroundColor: "var(--reader-accent)" }} /></span>
                    <span className="shrink-0 font-mono">{resourceScan.completed}/{resourceScan.total}</span>
                  </div>
                ) : null}
                {resourceScan.failedPages.length > 0 ? (
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-amber-600 dark:text-amber-400">
                    <span>{language === "zh-CN" ? `有 ${resourceScan.failedPages.length} 页资源扫描失败` : `${resourceScan.failedPages.length} pages failed to scan`}</span>
                    <button type="button" className="rounded border border-amber-300 px-2 py-1 font-medium hover:bg-amber-50 dark:border-amber-800 dark:hover:bg-amber-950/40" onClick={() => setResourceScanAttempt((value) => value + 1)}>
                      {language === "zh-CN" ? "重试" : "Retry"}
                    </button>
                  </div>
                ) : null}
              </div>
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"><ImageIcon size={14} /> {t.resourceImages} <span className="ml-auto font-mono">{documentImages.length}</span></div>
                {documentImages.length > 0 ? documentImages.map(({ page: imagePage, image }, index) => (
                  <button key={`resource-image-${imagePage}-${image.xref}-${index}`} type="button" className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-left transition-colors hover:border-[var(--reader-accent)] dark:border-zinc-800 dark:bg-zinc-950" onClick={() => { setPage(imagePage); setReaderMode("image-label"); }}>
                    <ImageIcon size={16} style={{ color: "var(--reader-accent)" }} />
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-700 dark:text-zinc-200">{image.extension || "image"} · {image.width} x {image.height}</span>
                    <span className="text-[11px] text-zinc-500">{t.page} {imagePage}</span>
                  </button>
                )) : <div className="rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700">{t.resourcesLoading}</div>}
              </section>
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"><Link2 size={14} /> {t.resourceLinks} <span className="ml-auto font-mono">{documentLinks.length}</span></div>
                {documentLinks.length > 0 ? documentLinks.map((link) => <button key={link.url} type="button" className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-left text-xs text-zinc-700 hover:border-[var(--reader-accent)] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200" onClick={() => onOpenExternal?.(link.url)}><ExternalLink size={14} /><span className="min-w-0 flex-1 truncate">{link.url}</span><span className="text-[11px] text-zinc-500">{t.page} {link.page}</span></button>) : <div className="rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700">{t.resourcesLoading}</div>}
              </section>
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"><ExternalLink size={14} /> DOI <span className="ml-auto font-mono">{documentDois.length}</span></div>
                {documentDois.length > 0 ? documentDois.map((resource) => <button key={resource.resourceId} type="button" className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-left text-xs text-zinc-700 hover:border-[var(--reader-accent)] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200" onClick={() => onOpenExternal?.(`https://doi.org/${resource.doi}`)}><ExternalLink size={14} /><span className="truncate">{resource.doi}</span></button>) : <div className="rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700">{t.resourcesLoading}</div>}
              </section>
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-5 bg-white dark:bg-zinc-900">
            <div>
              <div className="font-serif text-2xl font-bold text-zinc-900 dark:text-zinc-100 leading-tight">{title}</div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">{t.notesIntro}</p>
            </div>

            <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">{t.annotationTool}</div>
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{isAnnotationTool(activeTool) ? annotationLabels[activeTool] : t.switchToAnnotationTool}</div>
                </div>
                <div className="rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ backgroundColor: "var(--reader-accent-soft)", color: "var(--reader-accent)" }}>
                  {pageAnnotations.length} {t.annotationsCount}
                </div>
              </div>
              <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {t.dragToAnnotate}
              </p>
            </div>

            <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">{t.addNoteBtn}</div>
              <textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder={t.addNotePlaceholder} className="w-full min-h-[96px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600" />
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-zinc-500">{t.storedWithPage.replace("{page}", String(page))}</span>
                <button onClick={submitNote} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium" style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}>
                  <MessageSquare size={14} />
                  {t.addNoteTitle}
                </button>
              </div>
            </div>
            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.pageAnnotations}</div>
              {pageAnnotations.length > 0 ? (
                pageAnnotations.map(renderAnnotationCard)
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400 text-center">{t.noAnnotations}</div>
              )}
            </div>

            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.pageNotes}</div>
              {pageNotes.length > 0 ? (
                pageNotes.map((note) => (
                  <div key={note.id} className="group relative cursor-pointer rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4" onClick={() => goToSource(note.page, note.sourceRect)}>
                      <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        <span className="px-2 py-0.5 rounded-full" style={{ backgroundColor: note.kind === "highlight" ? "rgba(250, 204, 21, 0.18)" : "var(--reader-accent-soft)", color: note.kind === "highlight" ? "#a16207" : "var(--reader-accent)" }}>
                          {note.kind === "highlight" ? t.highlight : t.addNoteTitle}
                        </span>
                        {t.page} {note.page}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {onUpdateNote ? <button className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100" onClick={(event) => { event.stopPropagation(); setEditingNoteId(note.id); setEditingNoteDraft(note.content); }} title={language === "zh-CN" ? "编辑笔记" : "Edit note"}><Pencil size={14} /></button> : null}
                        {onRemoveNote ? <button className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={(event) => { event.stopPropagation(); onRemoveNote(note.id); }} title={t.deleteNote}><Trash2 size={14} /></button> : null}
                      </div>
                    </div>
                    {editingNoteId === note.id ? (
                      <div className="space-y-2">
                        <textarea value={editingNoteDraft} onChange={(event) => setEditingNoteDraft(event.target.value)} className="w-full min-h-[96px] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-sm leading-6 resize-none focus:outline-none focus:ring-1" />
                        <div className="flex justify-end gap-2"><button className="px-2.5 py-1 rounded-md text-xs" onClick={() => setEditingNoteId(null)}>{t.cancel}</button><button className="px-2.5 py-1 rounded-md text-xs text-white" style={{ backgroundColor: "var(--reader-accent)" }} onClick={() => { onUpdateNote?.(note.id, editingNoteDraft); setEditingNoteId(null); }}>{language === "zh-CN" ? "保存" : "Save"}</button></div>
                      </div>
                    ) : <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{note.content}</p>}
                    {note.reference ? <div className="mt-2 text-[11px] text-zinc-400">{note.reference}</div> : null}
                    <div className="text-[11px] text-zinc-400 mt-3">{new Date(note.createdAt).toLocaleString()}</div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400 text-center">{t.noNotes}</div>
              )}
            </div>

            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.pdfImages}</div>
              {(() => {
                const visibleImages = getVisibleImagesForPage(page).map((item) => item.img);
                return visibleImages.length > 0 ? (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 space-y-2">
                  {visibleImages.map((img, idx) => (
                    <div key={`img-item-${page}-${idx}`} className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300 border-b border-zinc-100 dark:border-zinc-800 pb-1.5 last:border-0 last:pb-0">
                      <span className="font-mono">image-{idx + 1}</span>
                      <span className="font-mono">{img.extension}</span>
                    </div>
                  ))}
                </div>
                ) : (
                <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-4 text-sm text-zinc-500 dark:text-zinc-400 text-center">{t.noPdfImages}</div>
                );
              })()}
            </div>

            {selectedAnnotation ? (
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.selectedAnnotation}</div>
                  {onRemoveAnnotation ? (
                    <button
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                      onClick={() => {
                        onRemoveAnnotation(selectedAnnotation.id);
                        setSelectedAnnotationId(null);
                        showActionHint(t.annotationDeleted);
                      }}
                      title={t.deleteAnnotation}
                    >
                      <Trash2 size={12} /> {t.delete}
                    </button>
                  ) : null}
                </div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">{annotationLabels[selectedAnnotation.kind]}</div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{selectedAnnotation.content || t.overlayWithoutText}</p>
              </div>
            ) : null}
          </div>
          )}
        </div>
      </div>

      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        isOpen={contextMenu.isOpen}
        title={t.pageActions}
        actions={buildViewerContextActions({
          onCopyPageLabel: async () => {
            try {
              await navigator.clipboard.writeText(`${title} - ${t.pageRefLabel.replace("{page}", String(page))}`);
              showActionHint(t.copyPageRefSuccess);
            } catch {
              showActionHint(t.clipboardUnavailable);
            }
          },
          onAddNote: () => {
            setIsNotesOpen(true);
            showActionHint(t.addNotePanelHint);
          },
          onExportPng: () => {
            void exportPng({ pageNo: contextMenu.pageNo, imageTarget: contextMenu.imageTarget });
          },
          onExportSvg: () => {
            void exportSvg({ pageNo: contextMenu.pageNo, imageTarget: contextMenu.imageTarget });
          },
          onClose: () => setContextMenu((state) => ({ ...state, isOpen: false, imageTarget: null })),
          labels: {
            copyPageReference: t.copyPageReference,
            addNoteHere: t.addNoteHere,
            exportCurrentPng: t.exportCurrentPng,
            exportCurrentSvg: t.exportCurrentSvg,
            exportImagePng: t.exportImagePng,
            exportImageSvg: t.exportImageSvg,
            cancel: t.cancel,
          },
          imageTarget: Boolean(contextMenu.imageTarget),
        })}
        onClose={() => setContextMenu((state) => ({ ...state, isOpen: false, imageTarget: null }))}
      />
    </div>
  );
}

function ToolButton({
  icon,
  active,
  onClick,
  title,
}: {
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-1.5 rounded transition-all ${
        active
          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
          : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50"
      }`}
      title={title}
    >
      {icon}
    </button>
  );
}
