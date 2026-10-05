/**
 * 阅读器核心：共享类型 + 纯工具函数。
 * ---------------------------------------------------------------------------
 * 从 PDFViewer.tsx 拆出（原 94-1240 行）。这一段的共同点是「与 UI 无关」：
 * 渲染任务调度、资源扫描超时、图片候选判定、批注几何、PDF 文本层读取与分组。
 * 它们同时被 PageCanvas / PageThumbnail / PDFViewer 主体消费，所以抽到最底层，
 * 依赖方向保持单向：readerCore ← {PageCanvas, PageThumbnail, PDFViewer}。
 */
import type { CSSProperties } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type {
  PdfReadingBlock,
  ReaderAnnotation,
  ReaderAnnotationKind,
  ReaderAnnotationRect,
} from "../../types";
import type { PDFImageInfo } from "../../services/pdfApi";
import { groupPdfTextHighlightRects } from "../../services/pdfBlocks";
import type { CachedResourceLink } from "../../services/resourceIndexCache";

export type SidebarTab ="outline" |"thumbs";
export type ToolType ="select" |"hand" |"highlight" |"underline" |"strike" |"text";

export type PageSize = {
  width: number;
  height: number;
};

export function imageTargetKey(target: ImageContextTarget | null | undefined) {
  if (!target) return null;
  const image = target.image;
  return`${target.pageNo}:${image.source}:${image.xref || 0}:${Math.round(target.rect.left)}:${Math.round(target.rect.top)}:${Math.round(target.rect.width)}:${Math.round(target.rect.height)}`;
}

export type DraftAnnotation = {
  page: number;
  kind: ReaderAnnotationKind;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export const DEFAULT_PAGE_SIZE: PageSize = { width: 595, height: 842 };
export const ACTIVE_NEIGHBOR = 2;
export const TEXT_NOTE_DEFAULT_WIDTH = 0.22;
export const TEXT_NOTE_DEFAULT_HEIGHT = 0.08;

export function resourceCacheIdentity(base: string, fileSize?: number, fingerprint ="") {
  const stableFingerprint = fingerprint.trim();
  if (stableFingerprint) return`${base}:fingerprint-${encodeURIComponent(stableFingerprint)}`;
  if (!Number.isFinite(fileSize) || (fileSize as number) <= 0) return base;
  return`${base}:size-${Math.round(fileSize as number)}`;
}
// Keep these thresholds aligned with the native image index. Raster xref
// resources are already identified by PDF metadata; filtering them by text
// overlap hides legitimate figures with labels or captions.
export const MIN_IMAGE_OVERLAY_AREA = 0.00005;
export const MIN_IMAGE_OVERLAY_SIDE = 6;
export const MAX_RASTER_IMAGE_AREA_RATIO = 0.96;
export const MAX_IMAGE_OVERLAY_ASPECT = 64;
export type CanvasRenderTask = { cancel: () => void; promise: Promise<void> };
export const activeCanvasRenders = new WeakMap<HTMLCanvasElement, CanvasRenderTask>();
export const PAGE_RENDER_OVERSCAN_WHILE_ZOOMING = 5;
export const WHEEL_ZOOM_SENSITIVITY = 0.14;
export const WHEEL_ZOOM_MIN_STEP = 7;
export const ZOOM_ANIMATION_EASE = 0.32;
export const ZOOM_ANIMATION_SETTLE = 0.18;
export const ZOOM_RENDER_COMMIT_DELAY_MS = 160;
export const ZOOM_RENDER_READY_FALLBACK_MS = 1800;
export const RESOURCE_SCAN_PAGE_TIMEOUT_MS = 30_000;

export function withResourceScanTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out after ${RESOURCE_SCAN_PAGE_TIMEOUT_MS}ms`)),
      RESOURCE_SCAN_PAGE_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function getPdfPageWithResourceTimeout(doc: PDFDocumentProxy, pageNo: number): Promise<PDFPageProxy> {
  let timedOut = false;
  const pagePromise = doc.getPage(pageNo);
  pagePromise.then(
    (page) => {
      if (timedOut) page.cleanup();
    },
    () => undefined,
  );
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      timedOut = true;
      reject(new Error(`PDF page ${pageNo} resource scan timed out after ${RESOURCE_SCAN_PAGE_TIMEOUT_MS}ms`));
    }, RESOURCE_SCAN_PAGE_TIMEOUT_MS);
    pagePromise.then(
      (page) => {
        if (timedOut) return;
        window.clearTimeout(timer);
        resolve(page);
      },
      (error) => {
        if (timedOut) return;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type ImageContextTarget = {
  pageNo: number;
  image: PDFImageInfo;
  rect: { left: number; top: number; width: number; height: number };
};

export type DocumentLinkResource = CachedResourceLink;
export type DocumentDoiResource = { doi: string; resourceId: string; documentId?: string };

export type ResourceScanState = {
  status:"idle" |"scanning" |"ready" |"cancelled";
  completed: number;
  total: number;
  failedPages: number[];
};

export type ViewerContextMenuState = {
  x: number;
  y: number;
  isOpen: boolean;
  pageNo: number;
  imageTarget: ImageContextTarget | null;
};

export async function cancelAndAwaitCanvasRender(canvas: HTMLCanvasElement) {
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

export function trackCanvasRender(canvas: HTMLCanvasElement, task: CanvasRenderTask) {
  activeCanvasRenders.set(canvas, task);
  const clear = () => {
    if (activeCanvasRenders.get(canvas) === task) {
      activeCanvasRenders.delete(canvas);
    }
  };
  // Do not leave the rejected promise returned by finally() unhandled when a
  // PDF.js render is cancelled during fast scrolling or zooming.
  void task.promise.then(clear, clear);
}

export const I18N = {
"zh-CN": {
    outline:"大纲",
    thumbs:"缩略图",
    noOutline:"暂无大纲。",
    handTool:"抓手工具",
    selectText:"选择文本",
    highlight:"高亮",
    underline:"下划线",
    strikethrough:"删除线",
    addText:"文本批注",
    zoomOut:"缩小",
    zoomIn:"放大",
    resetZoom:"重置缩放",
    prevPage:"上一页",
    nextPage:"下一页",
    exportLabel:"导出",
    searching:"搜索中",
    search:"搜索",
    readerView:"阅读",
    translationView:"翻译",
    imageLabelView:"图片标注",
    fullTranslation:"全文翻译",
    exitFullTranslation:"返回阅读",
    exportImages:"导出图片",
    exportImagesTitle:"可导出图片",
    exportImagePng:"导出原始 PNG",
    exportImageCropPng:"导出裁剪 PNG",
    exportImageSvg:"导出矢量 SVG",
    toggleNotes:"切换右侧栏",
    hideLeftSidebar:"收起侧边栏",
    showLeftSidebar:"展开侧边栏",
    noPdfOpened:"未打开 PDF",
    noPdfHint:"请从资料库打开 PDF，或选择本地文件。",
    openPdf:"打开 PDF",
    loadingPdf:"正在加载 PDF...",
    notesAnnotations:"笔记与批注",
    sidePanelNotes:"笔记",
    sidePanelTranslation:"翻译",
    sidePanelResources:"资源",
    resources:"文件资源",
    resourcesIntro:"查看当前 PDF 中已识别的图片、链接和 DOI。",
    resourceImages:"图片",
    resourceLinks:"链接",
    resourcesLoading:"正在扫描资源…",
    page:"第",
    notesIntro:"先选批注工具，再在页面拖拽标注；也可在下方直接记录当前页笔记。",
    annotationTool:"批注工具",
    switchToAnnotationTool:"切换到批注工具后可进行标注",
    annotationsCount:"条批注",
    dragToAnnotate:"拖拽即可创建批注；选择“文本批注”后会在松开鼠标时输入内容。",
    addNoteTitle:"添加笔记",
    addNoteBtn:"添加笔记",
    addNotePlaceholder:"写下本页或当前选区的笔记...",
    storedWithPage:"保存到第 {page} 页",
    pageAnnotations:"页面批注",
    noAnnotations:"本页暂无批注。请选择高亮/下划线/删除线/文本批注后在页面拖拽创建。",
    pageNotes:"页面笔记",
    noNotes:"本页暂无笔记。可在上方输入框填写并点击“添加笔记”。",
    selectedAnnotation:"已选批注",
    deleteAnnotation:"删除批注",
    deleteNote:"删除笔记",
    delete:"删除",
    pageActions:"页面操作",
    pageRefLabel:"第 {page} 页",
    copyPageRefSuccess:"页面引用已复制",
    clipboardUnavailable:"剪贴板不可用",
    addNotePanelHint:"请在右侧面板添加笔记",
    searchKeywordPrompt:"搜索关键词",
    enterKeyword:"请输入要搜索的关键词",
    foundOnPage:"在第 {page} 页找到",
    noMatches: '未找到"{query}"',
    noteAdded:"笔记已添加",
    textAnnotationPrompt:"输入文本批注内容",
    textAnnotationCancelled:"已取消文本批注",
    dragToCreate:"请在页面拖拽以创建批注",
    annotationSaved:"{label} 已保存",
    annotationDeleted:"批注已删除",
    overlayWithoutText:"已保存页面覆盖层（无内嵌文本）。",
    areaAnnotationSaved:"区域批注已保存。",
    copyPageReference:"复制页面引用",
    addNoteHere:"在此添加笔记",
    exportCurrentPng:"导出当前页 PNG",
    exportCurrentSvg:"导出当前页 SVG",
    cancel:"取消",
    save:"保存",
    pdfImages:"PDF 图片",
    translationPreview:"翻译预览",
    translationEmpty:"点击 PDF 段落后的“翻译”按钮，在这里预览译文。",
    translating:"正在翻译...",
    translateFailed:"翻译失败",
    noPdfImages:"当前页未检测到可导出图片。",
    imageLabelDetecting:"正在识别当前页附近图片...",
    imageLabelReady:"已识别 {count} 个图片/矢量图区域。",
    imageLabelFailed:"图片识别失败：{message}",
    imageType:"类型",
    pngExported:"PNG 已导出",
    svgExported:"SVG 已导出",
    rendering:"渲染中...",
    pdfNotLoaded:"PDF 文档尚未加载，请从资料库重新打开。",
    clickForAssist:"点击打开阅读辅助",
  },
"en-US": {
    outline:"Outline",
    thumbs:"Thumbs",
    noOutline:"No outline available.",
    handTool:"Hand Tool",
    selectText:"Select Text",
    highlight:"Highlight",
    underline:"Underline",
    strikethrough:"Strikethrough",
    addText:"Text Note",
    zoomOut:"Zoom out",
    zoomIn:"Zoom in",
    resetZoom:"Reset zoom",
    prevPage:"Previous page",
    nextPage:"Next page",
    exportLabel:"Export",
    searching:"Searching",
    search:"Search",
    readerView:"Reader",
    translationView:"Translation",
    imageLabelView:"Image labels",
    fullTranslation:"Full translation",
    exitFullTranslation:"Back to reader",
    exportImages:"Export images",
    exportImagesTitle:"Exportable images",
    exportImagePng:"Export original PNG",
    exportImageCropPng:"Export crop PNG",
    exportImageSvg:"Export vector SVG",
    toggleNotes:"Toggle side panel",
    hideLeftSidebar:"Hide sidebar",
    showLeftSidebar:"Show sidebar",
    noPdfOpened:"No PDF opened",
    noPdfHint:"Open a PDF from the Library or choose a local file.",
    openPdf:"Open PDF",
    loadingPdf:"Loading PDF...",
    notesAnnotations:"Notes & Annotations",
    sidePanelNotes:"Notes",
    sidePanelTranslation:"Translation",
    sidePanelResources:"Resources",
    resources:"File resources",
    resourcesIntro:"Browse detected images, links, and DOIs in this PDF.",
    resourceImages:"Images",
    resourceLinks:"Links",
    resourcesLoading:"Scanning resources…",
    page:"Page",
    notesIntro:"Pick an annotation tool, then drag on the page to mark content. You can also write a page note below.",
    annotationTool:"Annotation tool",
    switchToAnnotationTool:"Switch to an annotation tool to draw",
    annotationsCount:"annotations",
    dragToAnnotate:"Drag to create annotations; text notes will prompt for content on pointer release.",
    addNoteTitle:"Add note",
    addNoteBtn:"Add note",
    addNotePlaceholder:"Write a note about this page or the current selection...",
    storedWithPage:"Stored with page {page}",
    pageAnnotations:"Page annotations",
    noAnnotations:"No annotations on this page yet. Choose a tool and drag on the page to create one.",
    pageNotes:"Page notes",
    noNotes:"No notes on this page yet. Type in the note box above and click Add note.",
    selectedAnnotation:"Selected annotation",
    deleteAnnotation:"Delete annotation",
    deleteNote:"Delete note",
    delete:"Delete",
    pageActions:"Page actions",
    pageRefLabel:"page {page}",
    copyPageRefSuccess:"Page reference copied",
    clipboardUnavailable:"Clipboard unavailable",
    addNotePanelHint:"Add a note in the side panel",
    searchKeywordPrompt:"Search keyword",
    enterKeyword:"Enter a keyword to search",
    foundOnPage:"Found on page {page}",
    noMatches: 'No matches for"{query}"',
    noteAdded:"Note added",
    textAnnotationPrompt:"Text annotation content",
    textAnnotationCancelled:"Text annotation was cancelled",
    dragToCreate:"Drag on the page to create an annotation",
    annotationSaved:"{label} saved",
    annotationDeleted:"Annotation deleted",
    overlayWithoutText:"Stored page overlay without inline text.",
    areaAnnotationSaved:"Area annotation saved on page.",
    copyPageReference:"Copy page reference",
    addNoteHere:"Add note here",
    exportCurrentPng:"Export current page PNG",
    exportCurrentSvg:"Export current page SVG",
    cancel:"Cancel",
    save:"Save",
    pdfImages:"PDF Images",
    translationPreview:"Translation",
    translationEmpty:"Click Translate from the reading assist menu to preview text here.",
    translating:"Translating...",
    translateFailed:"Translation failed",
    noPdfImages:"No exportable images detected on this page.",
    imageLabelDetecting:"Detecting images near the current page...",
    imageLabelReady:"Detected {count} image/vector regions.",
    imageLabelFailed:"Image detection failed: {message}",
    imageType:"Type",
    pngExported:"PNG exported",
    svgExported:"SVG exported",
    rendering:"Rendering...",
    pdfNotLoaded:"PDF document is not loaded. Re-open the file from Library.",
    clickForAssist:"Click for reading assist",
  },
} as const;

export function cleanBaseName(title: string) {
  return (title ||"document")
    .replace(/[\\/:*?"<>|]/g,"-")
    .replace(/\s+/g,"")
    .trim();
}

export type OutlineEntry = {
  title: string;
  page: number | null;
  url: string | null;
  destination: OutlineDestination;
};

export type OutlineDestination = string | unknown[] | null;

export function toOutlineEntries(outline: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>) {
  if (!outline) return [] as OutlineEntry[];
  return outline
    .map((item) => ({
      title: typeof item.title ==="string" ? item.title.trim() :"",
      page: null,
      url: typeof item.url ==="string" && item.url.trim() ? item.url : null,
      destination: item.dest as OutlineDestination,
    }))
    .filter((item) => Boolean(item.title))
    .slice(0, 40);
}

export async function resolveOutlinePage(doc: PDFDocumentProxy, destination: OutlineDestination): Promise<number | null> {
  const explicit = Array.isArray(destination)
    ? destination
    : typeof destination ==="string"
      ? await doc.getDestination(destination)
      : null;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;

  const pageRef = explicit[0];
  if (typeof pageRef ==="number" && Number.isFinite(pageRef)) {
    return Math.max(1, Math.round(pageRef) + 1);
  }
  if (!pageRef || typeof pageRef !=="object") return null;

  try {
    const pageIndex = await doc.getPageIndex(pageRef as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return Number.isFinite(pageIndex) ? Math.max(1, pageIndex + 1) : null;
  } catch {
    return null;
  }
}

export function clampPage(page: number, totalPages: number) {
  return Math.max(1, Math.min(Math.max(1, totalPages), Math.round(page)));
}

export function compareReadingBlockOrder(left: PdfReadingBlock, right: PdfReadingBlock) {
  if (left.page !== right.page) return left.page - right.page;
  const leftIndex = Number(/-(\d+)$/.exec(left.id)?.[1]);
  const rightIndex = Number(/-(\d+)$/.exec(right.id)?.[1]);
  if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex) && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  return left.id.localeCompare(right.id);
}

export function clampZoomValue(value: number) {
  if (!Number.isFinite(value)) return 100;
  return Math.max(50, Math.min(400, value));
}

export function normalizeImageBbox(bbox: number[], pageSize: PageSize) {
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

export function isLikelyImageOverlay(rect: { width: number; height: number }, pageSize: PageSize) {
  const areaRatio = (rect.width * rect.height) / Math.max(1, pageSize.width * pageSize.height);
  const aspect = Math.max(rect.width / Math.max(1, rect.height), rect.height / Math.max(1, rect.width));
  return (
    areaRatio >= MIN_IMAGE_OVERLAY_AREA &&
    rect.width >= MIN_IMAGE_OVERLAY_SIDE &&
    rect.height >= MIN_IMAGE_OVERLAY_SIDE &&
    aspect <= MAX_IMAGE_OVERLAY_ASPECT
  );
}

export function isLikelyVectorOverlay(rect: { width: number; height: number }, pageSize: PageSize) {
  const areaRatio = (rect.width * rect.height) / Math.max(1, pageSize.width * pageSize.height);
  const aspect = Math.max(rect.width / Math.max(1, rect.height), rect.height / Math.max(1, rect.width));
  return areaRatio >= 0.0018 && areaRatio <= 0.88 && rect.width >= 14 && rect.height >= 14 && aspect <= 18;
}

export function rectsOverlapRatio(
  rect: { left: number; top: number; width: number; height: number },
  blockRect: { x: number; y: number; width: number; height: number },
  pageSize: PageSize,
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

export function isLikelyImageCandidate(
  img: PDFImageInfo,
  rect: { left: number; top: number; width: number; height: number },
  pageSize: PageSize,
  blocks: PdfReadingBlock[],
) {
  if (img.source ==="vector") {
    if (!isLikelyVectorOverlay(rect, pageSize)) return false;
  } else if (!isLikelyImageOverlay(rect, pageSize)) return false;
  const pageArea = Math.max(1, pageSize.width * pageSize.height);
  const areaRatio = (rect.width * rect.height) / pageArea;
  // Large raster images can be legitimate scans or full-page figures. Only
  // reject an almost complete page, which is the usual background fallback.
  if (img.source !=="vector" && areaRatio > MAX_RASTER_IMAGE_AREA_RATIO) return false;

  const imageBlockMatch = blocks.some(
    (block) => block.kind ==="image" && block.rect && rectsOverlapRatio(rect, block.rect, pageSize) >= 0.18,
  );
  if (img.source !=="vector") return true;
  if (imageBlockMatch) return true;

  const textOverlap = blocks
    .filter((block) => block.kind !=="image" && block.rect)
    .reduce(
      (max, block) =>
        Math.max(max, rectsOverlapRatio(rect, block.rect as NonNullable<PdfReadingBlock["rect"]>, pageSize)),
      0,
    );
  return textOverlap < 0.46;
}

export function imageBlockToCandidate(
  block: PdfReadingBlock,
  pageSize: PageSize,
): { img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } } | null {
  if (block.kind !=="image" || !block.rect) return null;
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
      resourceId:`resource-${block.id}`,
      documentId: block.documentId,
      pageNumber: block.page,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      extension:"crop",
      bbox: [rect.left, rect.top, rect.left + rect.width, rect.top + rect.height],
      source:"block",
    },
    rect,
  };
}

export function dedupeImageCandidates(
  items: Array<{ img: PDFImageInfo; rect: { left: number; top: number; width: number; height: number } }>,
  pageSize: PageSize,
) {
  const sorted = [...items].sort((left, right) => {
    const rank = (item: { img: PDFImageInfo }) =>
      item.img.source ==="xref" ? 0 : item.img.source ==="vector" ? 1 : 2;
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return right.rect.width * right.rect.height - left.rect.width * left.rect.height;
  });
  const kept: typeof items = [];
  for (const item of sorted) {
    const duplicate = kept.some((existing) => {
      if (item.img.xref > 0 && existing.img.xref === item.img.xref) {
        return (
          rectsOverlapRatio(
            item.rect,
            {
              x: existing.rect.left / pageSize.width,
              y: existing.rect.top / pageSize.height,
              width: existing.rect.width / pageSize.width,
              height: existing.rect.height / pageSize.height,
            },
            pageSize,
          ) > 0.8
        );
      }
      const overlapA = rectsOverlapRatio(
        item.rect,
        {
          x: existing.rect.left / pageSize.width,
          y: existing.rect.top / pageSize.height,
          width: existing.rect.width / pageSize.width,
          height: existing.rect.height / pageSize.height,
        },
        pageSize,
      );
      const overlapB = rectsOverlapRatio(
        existing.rect,
        {
          x: item.rect.left / pageSize.width,
          y: item.rect.top / pageSize.height,
          width: item.rect.width / pageSize.width,
          height: item.rect.height / pageSize.height,
        },
        pageSize,
      );
      if (item.img.source ==="vector" || existing.img.source ==="vector") {
        // Containment is meaningful for vector figures: a chart can contain
        // nested plots, legends, and axes. Deduplicate only near-identical
        // rectangles, never merely because one path contains another.
        return overlapA > 0.88 && overlapB > 0.88;
      }
      return Math.max(overlapA, overlapB) > 0.72;
    });
    if (!duplicate) kept.push(item);
  }
  return kept;
}

export async function cropPngBase64(
  pagePngBase64: string,
  rect: { left: number; top: number; width: number; height: number },
  pageSize: PageSize,
) {
  const image = new Image();
  const imageUrl =`data:image/png;base64,${pagePngBase64}`;
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
  return dataUrl.replace(/^data:image\/png;base64,/,"");
}

export function equalSet(left: Set<number>, right: Set<number>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function isAnnotationTool(tool: ToolType): tool is ReaderAnnotationKind {
  return tool ==="highlight" || tool ==="underline" || tool ==="strike" || tool ==="text";
}

export function normalizeRect(startX: number, startY: number, currentX: number, currentY: number) {
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

export function findReadingBlockIdForRect(rect: ReaderAnnotationRect, blocks: PdfReadingBlock[]) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const candidates = blocks
    .filter((block) => block.rect && block.rect.width > 0 && block.rect.height > 0)
    .map((block) => {
      const blockRect = block.rect as ReaderAnnotationRect;
      const containsCenter =
        centerX >= blockRect.x &&
        centerX <= blockRect.x + blockRect.width &&
        centerY >= blockRect.y &&
        centerY <= blockRect.y + blockRect.height;
      const overlapLeft = Math.max(rect.x, blockRect.x);
      const overlapTop = Math.max(rect.y, blockRect.y);
      const overlapRight = Math.min(rect.x + rect.width, blockRect.x + blockRect.width);
      const overlapBottom = Math.min(rect.y + rect.height, blockRect.y + blockRect.height);
      const overlap = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop);
      const blockArea = Math.max(0.000001, blockRect.width * blockRect.height);
      return { block, containsCenter, overlapRatio: overlap / blockArea, blockArea };
    })
    .filter((item) => item.containsCenter || item.overlapRatio > 0.08)
    .sort((left, right) => {
      if (left.containsCenter !== right.containsCenter) return left.containsCenter ? -1 : 1;
      if (left.overlapRatio !== right.overlapRatio) return right.overlapRatio - left.overlapRatio;
      return left.blockArea - right.blockArea;
    });
  return candidates[0]?.block.id;
}

export function createTextRect(x: number, y: number) {
  return {
    x: Math.max(0, Math.min(1 - TEXT_NOTE_DEFAULT_WIDTH, x)),
    y: Math.max(0, Math.min(1 - TEXT_NOTE_DEFAULT_HEIGHT, y)),
    width: TEXT_NOTE_DEFAULT_WIDTH,
    height: TEXT_NOTE_DEFAULT_HEIGHT,
  };
}

export function getAnnotationBadgeStyle(kind: ReaderAnnotationKind): CSSProperties {
  switch (kind) {
    case"highlight":
      return { backgroundColor:"rgba(250, 204, 21, 0.18)", color:"#a16207" };
    case"underline":
      return { backgroundColor:"rgba(37, 99, 235, 0.12)", color:"#1d4ed8" };
    case"strike":
      return { backgroundColor:"rgba(220, 38, 38, 0.12)", color:"#b91c1c" };
    case"text":
      return { backgroundColor:"var(--reader-accent-soft)", color:"var(--reader-accent)" };
  }
}

export function getAnnotationOverlayStyle(annotation: ReaderAnnotation, selected: boolean): CSSProperties {
  const base: CSSProperties = {
    left:`${annotation.rect.x * 100}%`,
    top:`${annotation.rect.y * 100}%`,
    width:`${annotation.rect.width * 100}%`,
    height:`${annotation.rect.height * 100}%`,
    boxShadow: selected ?"0 0 0 2px rgba(24,24,27,0.32)" :"0 0 0 1px rgba(24,24,27,0.12)",
  };

  switch (annotation.kind) {
    case"highlight":
      return {
        ...base,
        backgroundColor:"rgba(250, 204, 21, 0.28)",
        border:"1px solid rgba(202, 138, 4, 0.35)",
      };
    case"underline":
      return {
        ...base,
        backgroundImage:
"linear-gradient(to bottom, transparent 82%, rgba(37, 99, 235, 0.9) 82%, rgba(37, 99, 235, 0.9) 100%)",
        backgroundColor:"rgba(37, 99, 235, 0.06)",
      };
    case"strike":
      return {
        ...base,
        backgroundImage:
"linear-gradient(to bottom, transparent 45%, rgba(220, 38, 38, 0.9) 45%, rgba(220, 38, 38, 0.9) 57%, transparent 57%)",
        backgroundColor:"rgba(220, 38, 38, 0.05)",
      };
    case"text":
      // 这个气泡【刻意】在两主题下都是深色、文字恒为白 —— 它坐在 PDF 纸面上，
      // 而纸面不随 UI 主题反色（见 tokens.css 的 --surface-paper 说明）。
      // 因此这里不能用 text-content-inverse / text-accent-on 之类的令牌：
      // 深色主题下它们会翻成深色字，落在深色气泡上直接消失。
      return {
        ...base,
        backgroundColor:"rgba(24, 24, 27, 0.92)",
        border:"1px solid rgba(255,255,255,0.14)",
        color:"#ffffff",
      };
  }
}

export function getDraftOverlayStyle(
  kind: ReaderAnnotationKind,
  rect: { x: number; y: number; width: number; height: number },
): CSSProperties {
  const draftAnnotation: ReaderAnnotation = {
    id:"draft",
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

export type PdfTextSpan = {
  node: HTMLElement;
  text: string;
  rect: DOMRect;
  centerY: number;
};

export type PdfTextLayerGeometry = Pick<DOMRect,"left" |"top" |"width" |"height">;

export type PdfTextLine = {
  spans: PdfTextSpan[];
  text: string;
  rect: DOMRect;
  centerY: number;
};

export function combineClientRects(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

export function getPdfTextSpans(layer: HTMLElement): PdfTextSpan[] {
  return Array.from(layer.querySelectorAll("span"))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => {
      const text = node.textContent?.replace(/\s+/g,"").trim() ||"";
      const rect = node.getBoundingClientRect();
      return { node, text, rect, centerY: rect.top + rect.height / 2 };
    })
    .filter((item) => item.text.length > 0 && item.rect.width > 0 && item.rect.height > 0);
}

export function getPdfTextLayerGeometry(layer: HTMLElement): PdfTextLayerGeometry {
  const rect = layer.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function hasPdfTextLayerGeometryChanged(previous: PdfTextLayerGeometry | null, next: PdfTextLayerGeometry) {
  if (!previous) return true;
  return (
    previous.left !== next.left ||
    previous.top !== next.top ||
    previous.width !== next.width ||
    previous.height !== next.height
  );
}

export function getPdfSpanAtPoint(
  layer: HTMLElement,
  clientX: number,
  clientY: number,
  cachedSpans?: PdfTextSpan[],
): HTMLElement | null {
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

  return nearestDistance <= 10 ? (nearest?.node ?? null) : null;
}

export function groupPdfTextLines(spans: PdfTextSpan[]): PdfTextLine[] {
  const sorted = [...spans].sort((a, b) =>
    Math.abs(a.centerY - b.centerY) > 3 ? a.centerY - b.centerY : a.rect.left - b.rect.left,
  );
  const lines: PdfTextSpan[][] = [];

  for (const span of sorted) {
    const last = lines[lines.length - 1];
    const lastCenter = last ? last.reduce((sum, item) => sum + item.centerY, 0) / last.length : Number.NaN;
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

export function collectPdfParagraphSpansFromTarget(target: HTMLElement, cachedSpans?: PdfTextSpan[]): HTMLElement[] {
  const layer = target.closest(".textLayer");
  if (!(layer instanceof HTMLElement)) return [];
  const spans = cachedSpans || getPdfTextSpans(layer);
  if (spans.length === 0) return [];

  const targetSpan = spans.find((item) => item.node === target || item.node.contains(target));
  if (!targetSpan) return [];

  const allLines = groupPdfTextLines(spans);
  const targetLine = allLines.find((line) => line.spans.some((item) => item.node === targetSpan.node));
  if (!targetLine) return [];
  const layerRect = layer.getBoundingClientRect();
  if (layerRect.width <= 0 || layerRect.height <= 0) return [];

  // A PDF page commonly has two columns. Keep paragraph grouping inside the
  // column under the pointer; grouping the whole text layer makes the first
  // line span both columns and produces a partial/oversized hover rectangle.
  const targetLineSpans = [...targetLine.spans].sort((left, right) => left.rect.left - right.rect.left);
  const medianHeight = targetLineSpans[Math.floor(targetLineSpans.length / 2)]?.rect.height || targetSpan.rect.height;
  const lineSegments: PdfTextSpan[][] = [];
  for (const span of targetLineSpans) {
    const current = lineSegments[lineSegments.length - 1];
    const previous = current?.[current.length - 1];
    if (!previous || span.rect.left - previous.rect.right <= Math.max(18, medianHeight * 2.4)) {
      if (current) current.push(span);
      else lineSegments.push([span]);
    } else {
      lineSegments.push([span]);
    }
  }
  const columnLine = lineSegments.find((segment) => segment.some((item) => item.node === targetSpan.node)) || [
    targetSpan,
  ];
  const targetColumnCenter =
    (Math.min(...columnLine.map((item) => item.rect.left)) + Math.max(...columnLine.map((item) => item.rect.right))) /
    2;
  const columnSpans = spans.filter(
    (item) => Math.abs(item.rect.left + item.rect.width / 2 - targetColumnCenter) <= layerRect.width * 0.28,
  );
  // A single-column line can legitimately span most of the page. The fixed
  // center-radius heuristic is only valid after a real column split; using it
  // for a wide line drops the paragraph's left and right text spans.
  const scopedColumnSpans = lineSegments.length === 1 ? spans : columnSpans.length > 0 ? columnSpans : columnLine;
  const columnLeft = Math.min(...scopedColumnSpans.map((item) => item.rect.left));
  const columnRight = Math.max(...scopedColumnSpans.map((item) => item.rect.right));
  const columnPadding = Math.max(8, medianHeight * 1.8);
  const lines = groupPdfTextLines(
    spans.filter((item) => {
      const center = item.rect.left + item.rect.width / 2;
      return center >= columnLeft - columnPadding && center <= columnRight + columnPadding;
    }),
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

export function textFromPdfSpans(spans: HTMLElement[]) {
  return spans
    .map((span) => span.textContent?.replace(/\s+/g,"").trim() ||"")
    .filter(Boolean)
    .join("")
    .replace(/\s+([,.;:!?，。；：！？])/g,"$1")
    .trim();
}

export function getBlockHit(target: HTMLElement, blocks: PdfReadingBlock[], layer: HTMLElement) {
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

export const PDF_TEXT_BEARING_BLOCK_KINDS = new Set<PdfReadingBlock["kind"]>([
"text",
"title",
"list",
"table",
"quote",
"auxiliary",
"code",
"equation",
]);

export function collectPdfBlockSpans(block: PdfReadingBlock | null, spans: PdfTextSpan[], layer: HTMLElement): HTMLElement[] {
  // Text-bearing structured blocks share the PDF.js text-layer geometry. The
  // block kind is metadata for translation/quoting, not a reason to fall back
  // to a second paragraph heuristic for titles, tables, quotes, or footnotes.
  if (!block?.rect || !PDF_TEXT_BEARING_BLOCK_KINDS.has(block.kind)) return [];
  const layerRect = layer.getBoundingClientRect();
  if (layerRect.width <= 0 || layerRect.height <= 0) return [];
  const paddingX = Math.min(0.012, 8 / layerRect.width);
  const paddingY = Math.min(0.012, 8 / layerRect.height);
  const left = block.rect.x - paddingX;
  const top = block.rect.y - paddingY;
  const right = block.rect.x + block.rect.width + paddingX;
  const bottom = block.rect.y + block.rect.height + paddingY;
  return spans
    .filter(({ rect }) => {
      const centerX = (rect.left + rect.width / 2 - layerRect.left) / layerRect.width;
      const centerY = (rect.top + rect.height / 2 - layerRect.top) / layerRect.height;
      return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
    })
    .map(({ node }) => node);
}

export function drawSpanGroupHighlightElements(group: HTMLElement[], host: HTMLElement, existing: HTMLDivElement[]) {
  const hostRect = host.getBoundingClientRect();
  const spans = group
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter((item) => item.rect.width > 0 && item.rect.height > 0)
    .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
  if (spans.length === 0) return [];

  // A single union rectangle fills the whitespace between lines and can span
  // both columns. Keep the native text-layer geometry, but draw one compact
  // rectangle for each continuous line segment instead.
  const highlightRects = groupPdfTextHighlightRects(
    spans.map(({ rect }) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    })),
  );
  const elements = highlightRects.map((highlightRect, index) => {
    const lineHeight = highlightRect.bottom - highlightRect.top;
    const padX = Math.min(5, Math.max(2, lineHeight * 0.24));
    const padY = Math.min(4, Math.max(2, lineHeight * 0.18));
    const { left, top, right, bottom } = highlightRect;
    const element = existing[index] || document.createElement("div");
    element.className ="pdf-assist-block-highlight";
    element.style.left =`${Math.max(0, left - hostRect.left - padX)}px`;
    element.style.top =`${Math.max(0, top - hostRect.top - padY)}px`;
    const leftOffset = Math.max(0, left - hostRect.left - padX);
    const maxWidth = Math.max(0, hostRect.right - hostRect.left - leftOffset);
    element.style.width =`${Math.min(maxWidth, right - left + padX * 2)}px`;
    element.style.height =`${Math.min(hostRect.height, bottom - top + padY * 2)}px`;
    if (element.parentElement !== host) host.appendChild(element);
    return element;
  });
  for (const stale of existing.slice(elements.length)) stale.remove();
  return elements;
}

export function getNormalizedSpanGroupRect(group: HTMLElement[], layer: HTMLElement): ReaderAnnotationRect | undefined {
  const layerRect = layer.getBoundingClientRect();
  if (layerRect.width <= 0 || layerRect.height <= 0) return undefined;
  const rects = group.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return {
    x: Math.max(0, Math.min(1, (left - layerRect.left) / layerRect.width)),
    y: Math.max(0, Math.min(1, (top - layerRect.top) / layerRect.height)),
    width: Math.max(0, Math.min(1, (right - left) / layerRect.width)),
    height: Math.max(0, Math.min(1, (bottom - top) / layerRect.height)),
  };
}

export function mergeDomPdfReadingBlocks(domBlocks: PdfReadingBlock[], structuredBlocks: PdfReadingBlock[]) {
  const candidates = structuredBlocks.filter(
    (block) =>
      block.source !=="pdfjs-dom" && block.rect && PDF_TEXT_BEARING_BLOCK_KINDS.has(block.kind) && block.text.trim(),
  );
  const used = new Set<string>();
  return domBlocks.map((domBlock) => {
    if (!domBlock.rect || !domBlock.text.trim()) return domBlock;
    let best: PdfReadingBlock | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
      if (used.has(candidate.id) || !candidate.rect) continue;
      const left = Math.max(domBlock.rect.x, candidate.rect.x);
      const top = Math.max(domBlock.rect.y, candidate.rect.y);
      const right = Math.min(domBlock.rect.x + domBlock.rect.width, candidate.rect.x + candidate.rect.width);
      const bottom = Math.min(domBlock.rect.y + domBlock.rect.height, candidate.rect.y + candidate.rect.height);
      const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
      const domArea = domBlock.rect.width * domBlock.rect.height;
      const overlap = domArea > 0 ? intersection / domArea : 0;
      const domPrefix = domBlock.text.slice(0, 48).toLowerCase();
      const candidateText = candidate.text.toLowerCase();
      const textMatch = domPrefix.length >= 12 && candidateText.includes(domPrefix.slice(0, 24)) ? 0.35 : 0;
      const score = overlap + textMatch;
      if (score > bestScore && overlap >= 0.18) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) return domBlock;
    used.add(best.id);
    return {
      ...domBlock,
      id: best.id,
      kind: best.kind,
      source: best.source,
      documentId: best.documentId || domBlock.documentId,
      depth: best.depth,
      tableAlign: best.tableAlign,
    };
  });
}

export function getAssistAnchorFromHighlights(highlights: HTMLDivElement[], fallbackX: number, fallbackY: number) {
  const rects = highlights
    .map((highlight) => highlight.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return { x: fallbackX, y: fallbackY };
  const rect = combineClientRects(rects);
  return {
    x: rect.left + rect.width / 2,
    y: rect.bottom + 8,
  };
}
