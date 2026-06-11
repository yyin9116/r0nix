import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Hand,
  Highlighter,
  Image as ImageIcon,
  List,
  Maximize,
  MessageSquare,
  MousePointer2,
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
import type { ReaderAnnotation, ReaderAnnotationKind, ReaderNote } from "../types";
import type { PDFImageInfo } from "../services/pdfApi";
import { ContextMenu, buildViewerContextActions } from "./ContextMenu";
import "./PDFViewer.css";

interface PDFViewerProps {
  title: string;
  fileId?: string;
  language: AppLanguage;
  notes: ReaderNote[];
  annotations: ReaderAnnotation[];
  onOpenFileDialog?: () => void;
  onAddNote?: (page: number, content: string, kind: ReaderNote["kind"]) => void;
  onRemoveNote?: (noteId: string) => void;
  onAddAnnotation?: (annotation: Omit<ReaderAnnotation, "id" | "createdAt">) => void;
  onRemoveAnnotation?: (annotationId: string) => void;
  onResolveDefaultPath?: (fileName: string) => string;
  onProgress?: (page: number, totalPages: number) => void;
  onOpenExternal?: (url: string) => void;
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
const PAGE_OVERSCAN = 900;
const ACTIVE_NEIGHBOR = 2;
const TEXT_NOTE_DEFAULT_WIDTH = 0.22;
const TEXT_NOTE_DEFAULT_HEIGHT = 0.08;
type CanvasRenderTask = { cancel: () => void; promise: Promise<void> };
const activeCanvasRenders = new WeakMap<HTMLCanvasElement, CanvasRenderTask>();

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
    toggleNotes: "切换右侧栏",
    hideLeftSidebar: "收起侧边栏",
    showLeftSidebar: "展开侧边栏",
    noPdfOpened: "未打开 PDF",
    noPdfHint: "请从资料库打开 PDF，或选择本地文件。",
    openPdf: "打开 PDF",
    loadingPdf: "正在加载 PDF...",
    notesAnnotations: "笔记与批注",
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
    noPdfImages: "当前页未检测到可导出图片。",
    imageType: "类型",
    pngExported: "PNG 已导出",
    svgExported: "SVG 已导出",
    rendering: "渲染中...",
    pdfNotLoaded: "PDF 文档尚未加载，请从资料库重新打开。",
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
    toggleNotes: "Toggle side panel",
    hideLeftSidebar: "Hide sidebar",
    showLeftSidebar: "Show sidebar",
    noPdfOpened: "No PDF opened",
    noPdfHint: "Open a PDF from the Library or choose a local file.",
    openPdf: "Open PDF",
    loadingPdf: "Loading PDF...",
    notesAnnotations: "Notes & Annotations",
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
    noPdfImages: "No exportable images detected on this page.",
    imageType: "Type",
    pngExported: "PNG exported",
    svgExported: "SVG exported",
    rendering: "Rendering...",
    pdfNotLoaded: "PDF document is not loaded. Re-open the file from Library.",
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

interface PageCanvasProps {
  doc: PDFDocumentProxy | null;
  pageNo: number;
  zoomScale: number;
  active: boolean;
  enableTextLayer: boolean;
  onSize: (pageNo: number, width: number, height: number) => void;
  onError: (message: string) => void;
  renderingLabel: string;
  onOpenExternal?: (url: string) => void;
}

function PageCanvas({ doc, pageNo, zoomScale, active, enableTextLayer, onSize, onError, renderingLabel, onOpenExternal }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textHostRef = useRef<HTMLDivElement | null>(null);
  const linkHostRef = useRef<HTMLDivElement | null>(null);
  const linkTokenRef = useRef(0);
  const textLayerRef = useRef<{
    pageNo: number;
    div: HTMLDivElement;
    render: (params: { viewport: unknown }) => Promise<void>;
    show: () => void;
    hide: () => void;
    cancel: () => void;
  } | null>(null);
  const tokenRef = useRef(0);
  const [status, setStatus] = useState<"idle" | "rendering" | "ready">("idle");

  useEffect(() => {
    if (!doc) {
      setStatus("idle");
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
      if (textHostRef.current) textHostRef.current.innerHTML = "";
      return;
    }

    let cancelled = false;
    let renderTask: CanvasRenderTask | null = null;
    const token = ++tokenRef.current;

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

      const viewport = page.getViewport({ scale: zoomScale });

      const linkHost = linkHostRef.current;
      if (linkHost) {
        linkHost.innerHTML = "";
      }

      if (active && linkHost && onOpenExternal) {
        const tokenLinks = ++linkTokenRef.current;
        try {
          const annotations = await page.getAnnotations();
          if (tokenLinks === linkTokenRef.current) {
            const overlay = document.createElement("div");
            overlay.className = "page-link-overlay";
            overlay.style.width = `${Math.ceil(viewport.width)}px`;
            overlay.style.height = `${Math.ceil(viewport.height)}px`;

            for (const item of annotations as Array<Record<string, unknown>>) {
              const subtype = item.subtype;
              if (subtype !== "Link") continue;
              const url = typeof item.url === "string" ? item.url : "";
              if (!url) continue;
              const rect = item.rect as unknown;
              if (!Array.isArray(rect) || rect.length !== 4) continue;

              const [x1, y1, x2, y2] = rect as number[];
              const left = Math.min(x1, x2);
              const right = Math.max(x1, x2);
              const bottom = Math.min(y1, y2);
              const top = Math.max(y1, y2);

              // Convert PDF points to viewport pixels
              const tl = viewport.convertToViewportPoint(left, top);
              const br = viewport.convertToViewportPoint(right, bottom);
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

            linkHost.replaceChildren(overlay);
          }
        } catch {
          // ignore link overlay failures
        }
      }

      const canvas = canvasRef.current;

      if (!canvas) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      await cancelAndAwaitCanvasRender(canvas);
      if (cancelled || token !== tokenRef.current) return;

      setStatus("rendering");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);

      renderTask = page.render({ canvasContext: context, canvas, viewport }) as unknown as CanvasRenderTask;
      trackCanvasRender(canvas, renderTask);
      await renderTask.promise;
      if (cancelled || token !== tokenRef.current) return;

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

          await builder.render({ viewport });
          builder.show();
        } catch {
          textLayerRef.current?.cancel();
          textLayerRef.current = null;
          textHost.innerHTML = "";
        }
      } else if (textHost) {
        textLayerRef.current?.hide();
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
  }, [active, doc, enableTextLayer, onError, onSize, pageNo, zoomScale]);

  useEffect(() => {
    return () => {
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="block" />
      <div
        ref={textHostRef}
        className={`page-text-overlay transition-opacity duration-150 ${enableTextLayer && status === "ready" ? "opacity-100" : "opacity-0"}`}
      />
      <div ref={linkHostRef} className="absolute inset-0" style={{ pointerEvents: "auto" }} />
      {active && status === "rendering" ? (
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
  fileId,
  language,
  notes,
  annotations,
  onOpenFileDialog,
  onAddNote,
  onRemoveNote,
  onAddAnnotation,
  onRemoveAnnotation,
  onResolveDefaultPath,
  onProgress,
  onOpenExternal,
}: PDFViewerProps) {
  const [zoom, setZoom] = useState(100);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [actionHint, setActionHint] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("thumbs");
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [activeTool, setActiveTool] = useState<ToolType>("select");
  const [outlineTitles, setOutlineTitles] = useState<string[]>([]);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [activePages, setActivePages] = useState<Set<number>>(new Set([1, 2, 3]));
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; isOpen: boolean }>({ x: 0, y: 0, isOpen: false });
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [draftAnnotation, setDraftAnnotation] = useState<DraftAnnotation | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [isGestureRightDown, setIsGestureRightDown] = useState(false);
  const [pdfImagesByPage, setPdfImagesByPage] = useState<Record<number, PDFImageInfo[]>>({});
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

  const hasDoc = Boolean(fileId && pdfDoc);
  const zoomScale = useMemo(() => Math.max(0.5, zoom / 100), [zoom]);
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
    setPage(1);
    setRenderError("");
    setPageSizes({});
    setActivePages(new Set([1, 2, 3]));
    setDraftAnnotation(null);
    setSelectedAnnotationId(null);
    setSidebarTab("thumbs");
    setIsNotesOpen(false);
    setPdfImagesByPage({});

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

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const root = scrollRef.current;
      if (!root || !fileId) return;

      const rootRect = root.getBoundingClientRect();
      const top = root.scrollTop;
      const bottom = top + root.clientHeight;
      const center = top + root.clientHeight / 2;

      let nearest = page;
      let nearestDist = Number.POSITIVE_INFINITY;
      const nextActive = new Set<number>();

      for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
        const node = pageRefs.current.get(pageNo);
        if (!node) continue;
        const nodeRect = node.getBoundingClientRect();
        const nodeTop = top + (nodeRect.top - rootRect.top);
        const nodeBottom = nodeTop + node.clientHeight;

        if (nodeBottom >= top - PAGE_OVERSCAN && nodeTop <= bottom + PAGE_OVERSCAN) {
          nextActive.add(pageNo);
        }

        const distance = Math.abs((nodeTop + nodeBottom) / 2 - center);
        if (distance < nearestDist) {
          nearestDist = distance;
          nearest = pageNo;
        }
      }

      for (let delta = 1; delta <= ACTIVE_NEIGHBOR; delta += 1) {
        nextActive.add(clampPage(nearest - delta, totalPages));
        nextActive.add(clampPage(nearest + delta, totalPages));
      }
      nextActive.add(nearest);

      setActivePages((prev) => (equalSet(prev, nextActive) ? prev : nextActive));
      setPage((prev) => (prev === nearest ? prev : nearest));
    });
  }, [fileId, page, totalPages]);

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

  useEffect(() => {
    if (!fileId) return;
    onProgressRef.current?.(page, totalPages);
  }, [fileId, page, totalPages]);

  useEffect(() => {
    if (sidebarTab !== "thumbs") return;
    const list = thumbListRef.current;
    const node = thumbItemRefs.current.get(page);
    if (!list || !node) return;
    const targetTop = node.offsetTop - list.clientHeight / 2 + node.clientHeight / 2;
    const boundedTop = Math.max(0, Math.min(targetTop, list.scrollHeight - list.clientHeight));
    list.scrollTo({ top: boundedTop, behavior: "smooth" });
  }, [page, sidebarTab]);

  const goToPage = useCallback(
    (pageNo: number, behavior: ScrollBehavior = "smooth") => {
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
      root.scrollTo({ top: Math.max(0, targetTop), behavior });
      setPage(target);
    },
    [totalPages]
  );

  const showActionHint = (message: string) => {
    setActionHint(message);
    window.setTimeout(() => setActionHint(""), 2000);
  };
  const exportPng = async () => {
    if (!fileId) return;
    try {
      const pngBase64 = await api.exportPagePNG(fileId, page, 2);
      const baseName = cleanBaseName(title || "document");
      const defaultName = `${baseName}-page-${page}.png`;
      await api.savePNGToFile(pngBase64, onResolveDefaultPath?.(defaultName) || defaultName);
      showActionHint(t.pngExported);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(`PNG export failed: ${message}`);
    }
  };
  const exportSvg = async () => {
    if (!fileId) return;
    try {
      const svg = await api.exportPageSVG(fileId, page);
      const baseName = cleanBaseName(title || "document");
      const defaultName = `${baseName}-page-${page}.svg`;
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


  const clampZoom = (value: number) => Math.max(50, Math.min(400, Math.round(value)));

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

      // suppress the native/contextmenu event that usually fires after right click release
      suppressNextContextMenuRef.current = true;
      window.setTimeout(() => {
        suppressNextContextMenuRef.current = false;
      }, 120);

      if (shouldOpenMenu && right.pageNo) {
        setPage(clampPage(right.pageNo, totalPages));
        setContextMenu({ x: clientX, y: clientY, isOpen: true });
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
      rightDragRef.current = { active: true, moved: false, pointerId: event.pointerId, pageNo };
      gestureStartRef.current = { x: event.clientX, y: event.clientY };
      setIsGestureRightDown(true);
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

  const detectPageImages = useCallback(
    async (pageNo: number) => {
      if (!fileId) return;
      try {
        const { images } = await api.getPDFImages(fileId, pageNo);
        setPdfImagesByPage((prev) => ({ ...prev, [pageNo]: images }));
      } catch {
        setPdfImagesByPage((prev) => ({ ...prev, [pageNo]: [] }));
      }
    },
    [fileId]
  );

  useEffect(() => {
    if (!fileId || !pdfDoc) return;
    if (pdfImagesByPage[page] !== undefined) return;
    void detectPageImages(page);
  }, [detectPageImages, fileId, page, pdfDoc, pdfImagesByPage]);

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
        goToPage(annotation.page, "auto");
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
    <div className="flex h-full bg-zinc-100 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200 font-sans overflow-hidden">
      {actionHint ? (
        <div className="absolute top-4 right-4 z-50 px-3 py-1.5 rounded-md text-xs shadow-lg" style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}>
          {actionHint}
        </div>
      ) : null}

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
                  active={page === pageNo}
                  scrollRootRef={thumbListRef}
                  onClick={(targetPage) => goToPage(targetPage, "auto")}
                  onItemRef={(targetPage, node) => {
                    if (node) thumbItemRefs.current.set(targetPage, node);
                    else thumbItemRefs.current.delete(targetPage);
                  }}
                  pageLabel={t.page}
                  onContextMenu={(targetPage, event) => {
                    setPage(clampPage(targetPage, totalPages));
                    setContextMenu({ x: event.clientX, y: event.clientY, isOpen: true });
                  }}
                />
              );
            })
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="min-h-14 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 px-4 py-2 shrink-0 shadow-sm z-10">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors"
              onClick={() => setIsLeftSidebarOpen((value) => !value)}
              title={isLeftSidebarOpen ? t.hideLeftSidebar : t.showLeftSidebar}
            >
              {isLeftSidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
            </button>
            <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-md mr-4 shrink-0">
              <ToolButton icon={<Hand size={16} />} active={activeTool === "hand"} onClick={() => setActiveTool("hand")} title={t.handTool} />
              <ToolButton icon={<MousePointer2 size={16} />} active={activeTool === "select"} onClick={() => setActiveTool("select")} title={t.selectText} />
              <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1 self-center" />
              <ToolButton icon={<Highlighter size={16} />} active={activeTool === "highlight"} onClick={() => setActiveTool("highlight")} title={t.highlight} />
              <ToolButton icon={<Underline size={16} />} active={activeTool === "underline"} onClick={() => setActiveTool("underline")} title={t.underline} />
              <ToolButton icon={<Strikethrough size={16} />} active={activeTool === "strike"} onClick={() => setActiveTool("strike")} title={t.strikethrough} />
              <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1 self-center" />
              <ToolButton icon={<Type size={16} />} active={activeTool === "text"} onClick={() => setActiveTool("text")} title={t.addText} />
            </div>

            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => setZoom((value) => Math.max(50, value - 10))} title={t.zoomOut}>
              <ZoomOut size={18} />
            </button>
            <span className="text-xs font-mono w-12 text-center text-zinc-600 dark:text-zinc-400">{Math.round(zoom)}%</span>
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => setZoom((value) => Math.min(400, value + 10))} title={t.zoomIn}>
              <ZoomIn size={18} />
            </button>
            <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-2" />
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => setZoom(100)} title={t.resetZoom}>
              <Maximize size={18} />
            </button>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => goToPage(page - 1)} title={t.prevPage}>
              <ChevronLeft size={18} />
            </button>
            <div className="text-sm font-mono text-zinc-600 dark:text-zinc-400 flex items-center gap-1">
              <input type="number" min={1} max={Math.max(1, totalPages)} value={page} onChange={(event) => {
                const next = Number(event.target.value);
                if (!Number.isFinite(next)) return;
                goToPage(next, "auto");
              }} className="w-14 text-center bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded py-0.5 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-100 text-zinc-900 dark:text-zinc-100" />
              <span className="text-zinc-400 dark:text-zinc-500">/ {totalPages}</span>
            </div>
            <button className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors" onClick={() => goToPage(page + 1)} title={t.nextPage}>
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0 ml-4">
            <button className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md shadow-sm" style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }} onClick={() => {
                void exportPng();
              }} disabled={!hasDoc}>
              <ImageIcon size={14} />
              {t.exportLabel} PNG
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md shadow-sm border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200" onClick={() => {
                void exportSvg();
              }} disabled={!hasDoc}>
              <ImageIcon size={14} />
              {t.exportLabel} SVG
            </button>
            <button
              className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors disabled:opacity-50"
              title={isSearching ? t.searching : t.search}
              onClick={() => {
                void handleSearch();
              }}
              disabled={!hasDoc || isSearching}
            >
              <Search size={18} />
            </button>
            <button className={`p-1.5 rounded-md transition-colors ${isNotesOpen ? "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800" : "text-zinc-400 dark:text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"}`} onClick={() => setIsNotesOpen((value) => !value)} title={t.toggleNotes}>
              {isNotesOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto bg-zinc-200/50 dark:bg-zinc-950/50 relative"
          onWheel={(event) => {
            if (!isGestureRightDown) return;
            event.preventDefault();
            event.stopPropagation();
            const delta = event.deltaY;
            const step = delta < 0 ? 10 : -10;
            setZoom((prev) => clampZoom(prev + step));
          }}
        >
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
            <div className="mx-auto w-fit min-w-full py-8 px-4 md:px-8">
              <div className="flex flex-col items-center gap-6">
                {Array.from({ length: totalPages }, (_, index) => {
                  const pageNo = index + 1;
                  const size = pageSizes[pageNo] || DEFAULT_PAGE_SIZE;
                  const width = Math.max(1, Math.round(size.width * zoomScale));
                  const height = Math.max(1, Math.round(size.height * zoomScale));
                  const active = activePages.has(pageNo);
                  const pageAnnotationItems = annotations.filter((annotation) => annotation.page === pageNo);
                  const pageDraftRect = draftAnnotation?.page === pageNo ? draftRect : null;

                  return (
                    <div
                      key={pageNo}
                      ref={(node) => {
                        if (node) pageRefs.current.set(pageNo, node);
                        else pageRefs.current.delete(pageNo);
                      }}
                      className={`relative bg-white shadow-xl border transition-all origin-top ${isGestureRightDown ? "cursor-ns-resize" : activeTool === "hand" ? "cursor-grab active:cursor-grabbing" : activeTool === "select" ? "cursor-text" : "cursor-crosshair"} dark:invert dark:hue-rotate-180 ${page === pageNo ? "border-zinc-900/60" : "border-zinc-200"}`}
                      style={{ width, minHeight: height }}
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
                        setContextMenu({ x: event.clientX, y: event.clientY, isOpen: true });
                      }}
                    >
                      <PageCanvas
                        doc={pdfDoc}
                        pageNo={pageNo}
                        zoomScale={zoomScale}
                        active={active}
                        enableTextLayer={activeTool === "select"}
                        onSize={updatePageSize}
                        onError={setRenderError}
                        renderingLabel={t.rendering}
                        onOpenExternal={onOpenExternal}
                      />
                      <div
                        className="absolute inset-0"
                        style={{ pointerEvents: activeTool === "select" && !isGestureRightDown ? "none" : "auto" }}
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
                      {(pdfImagesByPage[pageNo] || []).map((img, idx) => {
                        const bbox = Array.isArray(img.bbox) && img.bbox.length === 4 ? img.bbox : null;
                        if (!bbox) return null;

                        const left = Math.max(0, Math.min(1, Number(bbox[0]) || 0));
                        const top = Math.max(0, Math.min(1, Number(bbox[1]) || 0));
                        const right = Math.max(0, Math.min(1, Number(bbox[2]) || 0));
                        const bottom = Math.max(0, Math.min(1, Number(bbox[3]) || 0));
                        const width = Math.max(0.002, right - left);
                        const height = Math.max(0.002, bottom - top);

                        return (
                          <div
                            key={`img-box-${pageNo}-${idx}`}
                            className="pointer-events-none absolute border border-teal-500/80 bg-teal-500/10"
                            style={{
                              left: `${left * 100}%`,
                              top: `${top * 100}%`,
                              width: `${width * 100}%`,
                              height: `${height * 100}%`,
                            }}
                          >
                            <span className="absolute -top-5 left-0 rounded-md bg-teal-600 px-1.5 py-0.5 text-[10px] font-mono text-white">
                              {t.imageType}: {img.extension || "unknown"}
                            </span>
                          </div>
                        );
                      })}
                      {page === pageNo ? <div className="pointer-events-none absolute inset-0 ring-1 ring-zinc-900/25" /> : null}
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

      <div className={`${isNotesOpen ? "w-[20rem]" : "w-0"} transition-[width] duration-300 ease-in-out bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 flex flex-col hidden lg:flex shrink-0 overflow-hidden`}>
        <div className="w-[20rem] flex flex-col h-full">
          <div className="h-14 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between px-4 shrink-0 bg-zinc-50 dark:bg-zinc-950">
            <div className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100 text-sm">
              <MessageSquare size={16} /> {t.notesAnnotations}
            </div>
            <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium" style={{ backgroundColor: "var(--reader-accent-soft)", color: "var(--reader-accent)" }}>
              <Sparkles size={12} /> {t.page} {page}
            </div>
          </div>

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
                  <div key={note.id} className="group relative rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        <span className="px-2 py-0.5 rounded-full" style={{ backgroundColor: note.kind === "highlight" ? "rgba(250, 204, 21, 0.18)" : "var(--reader-accent-soft)", color: note.kind === "highlight" ? "#a16207" : "var(--reader-accent)" }}>
                          {note.kind === "highlight" ? t.highlight : t.addNoteTitle}
                        </span>
                        {t.page} {note.page}
                      </div>
                      {onRemoveNote ? (
                        <button className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100" onClick={() => onRemoveNote(note.id)} title={t.deleteNote}>
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                    </div>
                    <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{note.content}</p>
                    <div className="text-[11px] text-zinc-400 mt-3">{new Date(note.createdAt).toLocaleString()}</div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400 text-center">{t.noNotes}</div>
              )}
            </div>

            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.pdfImages}</div>
              {(pdfImagesByPage[page] || []).length > 0 ? (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 space-y-2">
                  {(pdfImagesByPage[page] || []).map((img, idx) => (
                    <div key={`img-item-${page}-${idx}`} className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300 border-b border-zinc-100 dark:border-zinc-800 pb-1.5 last:border-0 last:pb-0">
                      <span className="font-mono">image-{idx + 1}</span>
                      <span className="font-mono">{img.extension}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-4 text-sm text-zinc-500 dark:text-zinc-400 text-center">{t.noPdfImages}</div>
              )}
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
            void exportPng();
          },
          onExportSvg: () => {
            void exportSvg();
          },
          onClose: () => setContextMenu((state) => ({ ...state, isOpen: false })),
          labels: {
            copyPageReference: t.copyPageReference,
            addNoteHere: t.addNoteHere,
            exportCurrentPng: t.exportCurrentPng,
            exportCurrentSvg: t.exportCurrentSvg,
            cancel: t.cancel,
          },
        })}
        onClose={() => setContextMenu((state) => ({ ...state, isOpen: false }))}
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

