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
import type { CachedResourceLink } from "../../services/resourceIndexCache";

export type SidebarTab ="outline" |"thumbs";
/** 用户能主动绘制的标注工具 —— 是 ReaderAnnotationKind 去掉 AI-only 的 `wavy`。 */
export type ReaderAnnotationTool = Exclude<ReaderAnnotationKind, "wavy">;
export type ToolType ="select" |"hand" | ReaderAnnotationTool;

/**
 * 编译期断言：`wavy` **绝不能**进入用户可用的工具集。
 *
 * 这条**不用守卫脚本里的字符串匹配**来守 —— 字符串只能证明「源码里还有这行字」，
 * 而本仓已经实测过这类守卫抓不到「永假条件」（见 docs/companion-reading-plan.md §9）。
 * 让类型系统自己守：一旦有人把 `wavy` 加回 `ReaderAnnotationTool`
 * （例如把 ToolType 改成手写的完整联合、忘了 Exclude），这个类型会退化成 `never`，
 * 下面那句 `= true` 当场报 TS2322，**构建就红**。
 *
 * `wavy` 是 AI-only 的：用户不能手动画波浪线，否则「形状承载语义」会退化成「比谁手快」。
 */
export type WavyIsNotAUserTool = "wavy" extends ReaderAnnotationTool ? never : true;
export const WAVY_IS_NOT_A_USER_TOOL: WavyIsNotAUserTool = true;

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
  /** 草稿只可能由用户主动绘制 —— 因此是 ReaderAnnotationTool，不含 AI-only 的 `wavy`。 */
  kind: ReaderAnnotationTool;
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
// ⚠️ 缩放手势的灵敏度与步进常量（WHEEL_ZOOM_SENSITIVITY / MIN_STEP / MAX_STEP）
// **不在这里** —— 它们已随手势识别一起迁到 `services/pdfZoomGesture.ts`。
// 本文件曾与那份各留一份同名的 0.14 / 7，两处数值相同纯属人工同步；
// 手势层一旦调标定，这里就会静默变成另一套手感。
export const ZOOM_ANIMATION_EASE = 0.32;
export const ZOOM_ANIMATION_SETTLE = 0.18;
export const ZOOM_RENDER_COMMIT_DELAY_MS = 160;
export const ZOOM_RENDER_READY_FALLBACK_MS = 1800;

/**
 * 「换页后多久才去扫这一页的元数据（图像 / 阅读块）」的静默期。
 *
 * 为什么需要静默期：`detectPageImages(page)` 会**穿过 PDF.js / 后端边界**发一次
 * 请求（Tauri 下是本地服务 + PyMuPDF 扫这一页的图像）。它原先挂在以 `page`
 * 为依赖的 effect 上 —— 每次跨页都发一次。滚动跨 10 页就是 10 次请求、取消 9 次，
 * 且每一次都在和滚动抢主线程与后端。用户报的正是「滚动/翻页卡」。
 *
 * 240ms 与 `emitViewState` 的 120ms 防抖同一思路（都是「滚动停下再落账」），
 * 取两倍是为了让后端扫描明确排在阅读位置同步之后。
 *
 * 安全性：右键菜单里的图像命中区不依赖这次预取 —— 它自己会再要一次
 * （`handleViewerContextMenu` 里的 `detectPageImagesRef.current(pageNo)`），
 * 所以「预取晚一点」只影响「提前量」，不影响功能正确性。
 */
export const PAGE_METADATA_IDLE_MS = 240;
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

/**
 * 缩略图渲染并发闸：全应用最多同时 N 张缩略图在渲，其余按进入视口的顺序排队。
 *
 * 为什么必须限流：缩略图与主画布共用同一个 pdf.js worker。滚动时
 * IntersectionObserver（rootMargin 240px）一次能放进十几张缩略图，不限流的话
 * 它们立刻全部 page.render，与当前页的主渲染抢 worker 带宽 —— 用户感知就是
 * 「翻页/滚动卡顿 + 缩略图一张张逐渐亮起」（2026-10-09 反馈）。
 * 限流到 2 之后，主渲染永远排在队头，缩略图串行补齐，肉眼几乎无感。
 */
const THUMBNAIL_MAX_CONCURRENT_RENDERS = 2;
let thumbnailRenderSlotsInUse = 0;
const thumbnailRenderWaiters: Array<() => void> = [];

export async function acquireThumbnailRenderSlot(): Promise<() => void> {
  if (thumbnailRenderSlotsInUse >= THUMBNAIL_MAX_CONCURRENT_RENDERS) {
    await new Promise<void>((resolve) => {
      thumbnailRenderWaiters.push(resolve);
    });
  }
  thumbnailRenderSlotsInUse += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    thumbnailRenderSlotsInUse -= 1;
    // 只唤醒一个等待者：它恢复执行时会自己把计数加回去。
    thumbnailRenderWaiters.shift()?.();
  };
}

/**
 * 页面渲染的**暂存画布池**。
 *
 * 为什么需要暂存画布：pdf.js 的 `page.render()` 是按 band 分批渐进写入的。
 * 直接渲染到可见画布上，读者会看到纸面一行行长出来；先渲到暂存画布、
 * 完成后再一次性 `drawImage` 过去，可见画布只更新一次（原子换帧）。
 * 尤其是**缩放提交**那一刻：`canvas.width = 新宽度` 会立即清空位图，
 * 直接渲染的话读者会先看到一片白再慢慢填回来。
 *
 * 这与 pdf.js 官方做的**是同一件事**：`BasePDFPageView.#showCanvas`
 * （`pdfjs-dist/web/pdf_viewer.mjs:4969-4986`）同样用
 * `ctx.drawImage(tempCanvas, 0, 0)` 把旧帧搬到新画布上再显示，
 * 靠 `minDurationToUpdateCanvas`（默认 500ms）决定要不要更新。
 * 差别只在实现位置：官方每次 `_createCanvas()` **新建**一个 canvas，把旧的
 * 留成单槽 `#tempCanvas`；本组件复用一个 canvas，所以需要一个小池子。
 *
 * ⚠️ **它解决的**是「每渲一页就新分配一张整页位图」的**分配抖动**，
 * 不是 2G+ 那种**驻留**问题 —— 2026-10-09 实测：池化 + 卸载时归零之后，
 * 累计分配从 770MB / 611 次降到 396MB / 409 次，而**驻留始终只有 20–40MB**。
 * 「打开 200 页 PDF 涨到 2G+」的主因在别处，是整份 PDF 过 Tauri IPC
 * 被 `serde_json` 展开成十进制数字数组（≈19–23 倍文件大小的瞬时峰值），
 * 见 `src-tauri/src/tauri_commands.rs` 的 `read_opened_pdf_bytes` 注释。
 * 不要把这两个量混在一起读。
 *
 * 容量 3 的依据：同时活跃的页面最多 5 张（nearest ± 2），但真正并发执行
 * 「渲进暂存画布」这一段的时间窗很窄；池满时等待归还，不会无限增长。
 * 池内画布**保留 backing store**（这正是省掉分配的目的），
 * 稳态代价是 3 张位图常驻（dpr2 的 A4 约 23MB）。
 */
const SCRATCH_CANVAS_POOL_SIZE = 3;
const scratchCanvasPool: HTMLCanvasElement[] = [];
const scratchCanvasWaiters: Array<() => void> = [];
let scratchCanvasesInUse = 0;

export interface ScratchCanvasLease {
  canvas: HTMLCanvasElement;
  release: () => void;
}

export async function acquireScratchCanvas(): Promise<ScratchCanvasLease> {
  for (;;) {
    const pooled = scratchCanvasPool.pop();
    if (pooled) {
      scratchCanvasesInUse += 1;
      return { canvas: pooled, release: makeScratchRelease(pooled) };
    }
    if (scratchCanvasesInUse < SCRATCH_CANVAS_POOL_SIZE) {
      scratchCanvasesInUse += 1;
      const created = typeof document === "undefined" ? null : document.createElement("canvas");
      if (created) return { canvas: created, release: makeScratchRelease(created) };
      scratchCanvasesInUse -= 1;
      throw new Error("scratch canvas unavailable");
    }
    await new Promise<void>((resolve) => {
      scratchCanvasWaiters.push(resolve);
    });
  }
}

function makeScratchRelease(canvas: HTMLCanvasElement): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scratchCanvasesInUse -= 1;
    scratchCanvasPool.push(canvas);
    // 唤醒一个等待者；它会重新走一遍 pop。
    scratchCanvasWaiters.shift()?.();
  };
}

/**
 * dev-only：把画布池的占用暴露给内存探针（`devRuntimeCensus` 会读它）。
 *
 * 为什么必须报出来：池里的画布**不在 DOM 里** —— `document.querySelectorAll("canvas")`
 * 完全看不到它们，而它们**保留着 backing store**（这正是省掉重复分配的目的，见上）。
 * 于是「关闭标签后画布数归零、footprint 却仍留一截」这种读数会被误读成「有东西泄漏」，
 * 实际其中一部分正是这里按设计常驻的位图。
 *
 * 走 `window` 通道而不是导出函数：`devRuntimeCensus` 在**入口图**里，静态 import 本模块
 * 会把 readerCore 从懒加载块拖进入口包 —— 为一个 dev 读数改变生产的打包结构不值得。
 * 生产构建（DEV=false）下这段不执行，也没有任何调用方。
 */
if (
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV &&
  typeof window !== "undefined"
) {
  (window as unknown as Record<string, unknown>).__r0nixScratchPoolCensus = () => ({
    pooled: scratchCanvasPool.length,
    inUse: scratchCanvasesInUse,
    bytes: scratchCanvasPool.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0),
    sizes: scratchCanvasPool.map((canvas) => `${canvas.width}x${canvas.height}`),
  });
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
    wavy:"波浪线",
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
    companionToolbar:"伴读：就当前这段问一句",
    companionNoBlock:"这一页还没解析出可提问的段落，等文字识别完成后再试",
    /** 伴读锚点的无障碍名。内容优先用模型那句疑问，没有时退到这一句。 */
    companionOpen:"打开伴读提示",
    companionNoProse:"页眉、页脚与标题不参与伴读 —— 请在正文段落上唤出。",
    /** 手动唤出但该块没有批注卡可展开（被「暂不提示」或预算/请求未成）。 */
    companionDismissedHint:"这一段当前没有伴读批注（可能已被「暂不提示」）。",
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
    sidePanelHistory:"历史",
    assistHistory:"AI 记录",
    assistHistoryIntro:"翻译、问问 AI、解释的结果会自动存进这份文档的历史，重启后仍可回看。",
    assistHistoryEmpty:"还没有记录。划词后使用翻译 / 问问 AI / 解释，结果会出现在这里。",
    assistHistoryClear:"清空",
    assistHistoryCleared:"已清空历史记录",
    historyKindTranslate:"翻译",
    historyKindAsk:"问问 AI",
    historyKindExplain:"解释",
    historyKindFullTranslation:"全文翻译",
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
    wavy:"Wavy",
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
    companionToolbar:"Companion: ask about this passage",
    companionNoBlock:"No question-ready passage on this page yet; wait for text recognition",
    companionOpen:"Open companion hint",
    companionNoProse:"Headers, footers and headings are not companion targets \u2014 pick a body paragraph.",
    companionDismissedHint:"No companion note on this passage right now (it may have been dismissed with \u201cNot now\u201d).",
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
    sidePanelHistory:"History",
    assistHistory:"AI records",
    assistHistoryIntro:"Translate / Ask AI / Explain results are saved to this document's history and survive restarts.",
    assistHistoryEmpty:"No records yet. Use Translate / Ask AI / Explain on a selection and results will appear here.",
    assistHistoryClear:"Clear",
    assistHistoryCleared:"History cleared",
    historyKindTranslate:"Translate",
    historyKindAsk:"Ask AI",
    historyKindExplain:"Explain",
    historyKindFullTranslation:"Full translation",
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

export function isAnnotationTool(tool: ToolType): tool is ReaderAnnotationTool {
  return tool ==="highlight" || tool ==="underline" || tool ==="strike" || tool ==="text";
}

/**
 * 行类标注工具：交互载体是**文本选区**而不是 overlay 拖拽。
 *
 * 2026-10-09 用户裁决：「标注应该和选择文本是同一个操作，左键选择」——
 * highlight/underline/strike 激活时文本层保持可选（与 select 工具同一通路），
 * mouseup 上的非空选区直接落成对应类型的标注，不再走 overlay 坐标绘制。
 * `text`（便签）是唯一例外：它放置的是对话框而非行内划线，保留拖放定位。
 *
 * 穷举断言：往 `ReaderAnnotationKind` 里加新 kind（且它不是 wavy/text）时，
 * `Record<LineAnnotationTool, true>` 会因缺成员当场报编译错 —— 新行类工具
 * 必须显式决定「进不进选择式交互」，不能静默落到 overlay 拖拽的老路上。
 */
export type LineAnnotationTool = Exclude<ReaderAnnotationTool, "text">;
const LINE_TOOL_COVERAGE: Record<LineAnnotationTool, true> = {
  highlight: true,
  underline: true,
  strike: true,
};

export function isLineAnnotationTool(tool: ToolType): tool is LineAnnotationTool {
  // 判定直接查穷举表：新 kind 必须先在这张表里登记（否则上面的 Record 编译报错），
  // 运行时行为与编译期覆盖天然一致。
  return tool in LINE_TOOL_COVERAGE;
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

/**
 * 一行正文在**归一化页面坐标**里的典型高度。
 *
 * 与 `readingCompanion.ts` 的同名常量同源（A4 4.2mm ≈ 0.0141、
 * US Letter ≈ 0.0150，取偏保守的一侧）。这里复制一份而不是跨目录 import，
 * 是因为两个模块的依赖方向相反：readerCore 是渲染层最底层的纯工具，
 * 不该为了一个数字把 services/ 拉进来。改一处必须同步改另一处 ——
 * `scripts/test-reader-annotations.mjs` 的对齐断言会同时校验两者。
 */
const LINE_HEIGHT_FALLBACK = 0.014;

/**
 * 把用户拖出来的划线矩形**吸附到真实行盒**上。
 *
 * ## 为什么必须有这一步（2026-10-08 实测「只能看到波浪线」的真正成因）
 *
 * `normalizeRect` 的兜底是 `height: Math.max(0.002, …)`。而划线这个手势
 * 天然是**横着划一道**——手沿着一行文字从左拖到右，垂直位移接近 0 ——
 * 于是高度落到 0.002，即页面高度的 0.2%。A4（842pt）上是 **1.7px**。
 *
 * 1.7px 高的盒子里：
 * - `highlight` 的半透明黄底（`--annotation-highlight-fill`，alpha 0.28）
 *   画在 1.7px 上，等于一条若有若无的细缝；
 * - `underline` / `strike` 的渐变线分别定位在盒子的 82%~100% 与 45%~57%，
 *   在 1.7px 里就是**亚像素**，浏览器直接不画。
 *
 * 于是表现就是「highlight / underline / strike / text 全都看不见，
 * 只有波浪线在」—— 而波浪线之所以看得见，是因为它由 PageCanvas 画在
 * **文本层内部**，跟着每个文字片段自己的行盒走，从来不经过这个矩形。
 *
 * ⚠️ 这也解释了为什么之前查 z-index 查不出问题：层叠顺序确实曾经错过一次
 * （已修），但即使层序完全正确，1.7px 的矩形本身也画不出东西。
 * 两个缺陷叠在一起，症状却只有一个。
 *
 * ## 吸附规则
 *
 * - 命中行：纵向与原矩形有重叠、且横向与之有重叠的那些行（都取自
 *   `PdfReadingBlock.lines`，即 pymupdf `get_text("dict")` 的行级 bbox，
 *   是解析器给出的几何，不是我们猜的）；
 * - 纵向：取命中行���并集。横向：保留用户拖的范围，只在必要时**收窄**到
 *   命中行的横向并集（用户拖出了行边界时不外扩——外扩会把高亮涂到
 *   相邻行的字上）；
 * - 命中不到行（无 `lines` 的老数据 / markdown 来源 / 表格图注）
 *   时退回 `height = LINE_HEIGHT_FALLBACK`，保证「至少有一行高」，
 *   而不是留一条1.7px 的缝让读者以为功能坏了；
 * - **不动 `text` 批注**：它的矩形是固定尺寸的对话框，不是行内划线。
 */
export function snapAnnotationRectToLines(
  rect: ReaderAnnotationRect,
  lines: readonly { rect?: ReaderAnnotationRect }[] | undefined,
): ReaderAnnotationRect {
  // ⚠️ 脏坐标必须在这里**收敛成安全值**，不能原样返回。
  // NaN 会一路传染：写入侧的 `Math.max(0, Math.min(1, NaN))` 仍是 NaN
  //（Math.min 与 NaN 运算恒得 NaN），于是 style 里出现 `left: NaN%`，
  // 浏览器丢弃整条声明，标注**静默不显示** —— 而数据里明明有。
  // 症状与「保存失败」无法区分，所以这一层必须自己兜住。
  const safe = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  const cleanRect: ReaderAnnotationRect = {
    x: safe(rect.x, 0),
    y: safe(rect.y, 0),
    width: safe(rect.width, 0),
    height: safe(rect.height, 0),
  };
  // 收敛前先记住「原本是不是脏的」—— 收敛后脏数据与退化矩形长得一样（都是 0 宽），
  // 但处理方式相反：退化矩形要原样交给上层判定（它表示这一划根本没画出来），
  // 脏数据必须返回收敛值，否则 NaN 就在这里原样漏出去了。
  const wasDirty = cleanRect.x !== rect.x || cleanRect.y !== rect.y || cleanRect.width !== rect.width || cleanRect.height !== rect.height;

  // 退化矩形（零宽/零高）不是「需要吸附」的情形 —— 它表示这一划根本没画出来，
  // 交给上层判定（commitDraftAnnotation 会提示读者重划）。这里原样返回，
  // 替它编一个尺寸反而会把一次失败的手势伪装成一次成功的划线。
  if (!(cleanRect.width > 0) || !(cleanRect.height > 0)) {
    return wasDirty ? cleanRect : rect;
  }

  const hits = (lines ?? []).filter((line) => {
    const lineRect = line?.rect;
    if (!lineRect) return false;
    if (!(lineRect.width > 0) || !(lineRect.height > 0)) return false;
    const overlapX =
      Math.min(cleanRect.x + cleanRect.width, lineRect.x + lineRect.width) - Math.max(cleanRect.x, lineRect.x);
    const overlapY =
      Math.min(cleanRect.y + cleanRect.height, lineRect.y + lineRect.height) - Math.max(cleanRect.y, lineRect.y);
    return overlapX > 0 && overlapY > 0;
  });

  if (hits.length === 0) {
    return {
      x: cleanRect.x,
      y: cleanRect.y,
      width: cleanRect.width,
      height: Math.max(cleanRect.height, LINE_HEIGHT_FALLBACK),
    };
  }

  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const line of hits) {
    const lineRect = line.rect as ReaderAnnotationRect;
    top = Math.min(top, lineRect.y);
    bottom = Math.max(bottom, lineRect.y + lineRect.height);
    left = Math.min(left, lineRect.x);
    right = Math.max(right, lineRect.x + lineRect.width);
  }

  // 横向保留用户意图（他拖到哪就是哪），只收窄不外扩。
  const snappedX = Math.max(cleanRect.x, left);
  const snappedRight = Math.min(cleanRect.x + cleanRect.width, right);
  return {
    x: snappedX,
    y: top,
    // 纵向取行并集：用户横划时这是唯一能给出可见高度的信息。
    height: Math.max(bottom - top, LINE_HEIGHT_FALLBACK),
    width: Math.max(0.002, snappedRight - snappedX),
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

/**
 * 手工 wavy 标注的波形图为什么不能写死颜色。
 *
 * 波形是 SVG data URI，而 data URI 内部无法引用外部 CSS 变量。旧实现在这里
 * 写死 `stroke='%23b91c1c'` 并注释「因为纸面不随主题反色所以没问题」——
 * 深色反色下沉到 canvas（见 PDFViewer.css）之后那条前提已经不成立，
 * 深红落在深色纸面上几乎看不见。
 *
 * 现在波形图挪进 tokens.css 的 `--manual-wavy-image`，且只作 mask 使用：
 * mask 只取 alpha 通道，颜色由 `--annotation-wavy-stroke` 经 background-color
 * 染上，于是它第一次跟上了主题。消费端规则见 PDFViewer.css 的
 * `[data-annotation-kind="wavy"]`。
 */

export function getAnnotationBadgeStyle(kind: ReaderAnnotationKind): CSSProperties {
  switch (kind) {
    case"highlight":
      return { backgroundColor:"var(--annotation-highlight-fill)", color:"var(--state-warn-fg)" };
    case"underline":
      return { backgroundColor:"var(--annotation-underline-fill)", color:"var(--annotation-underline-line)" };
    case"strike":
      return { backgroundColor:"var(--annotation-strike-fill)", color:"var(--annotation-strike-line)" };
    case"text":
      return { backgroundColor:"var(--reader-accent-soft)", color:"var(--reader-accent)" };
    case"wavy":
      // 波浪线是 **AI 划的**，不是用户划的。用「虚线描边」而不是实心底色，
      // 是为了与实心的 strike 区分：形状承载语义（这是 AI 的推测），
      // 颜色只承载强度。见 docs/design-system.md §11.8。
      return {
        backgroundColor:"transparent",
        color:"var(--annotation-wavy-stroke)",
        border:"1px dashed color-mix(in srgb, var(--annotation-wavy-stroke) 55%, transparent)",
      };
  }
}

export function getAnnotationOverlayStyle(annotation: ReaderAnnotation, selected: boolean): CSSProperties {
  const base: CSSProperties = {
    left:`${annotation.rect.x * 100}%`,
    top:`${annotation.rect.y * 100}%`,
    width:`${annotation.rect.width * 100}%`,
    height:`${annotation.rect.height * 100}%`,
    // 描边走令牌：深色下 --content-primary 是浅色，自动从「暗描边」翻成「浅描边」，
    // 不需要在这里再写一份深浅两套值（写死深色时深色主题下会看不见选中框）。
    boxShadow: selected
      ? "0 0 0 2px color-mix(in srgb, var(--content-primary) 32%, transparent)"
      : "0 0 0 1px color-mix(in srgb, var(--content-primary) 12%, transparent)",
  };

  switch (annotation.kind) {
    case"highlight":
      return {
        ...base,
        backgroundColor:"var(--annotation-highlight-fill)",
        border:"1px solid var(--annotation-highlight-border)",
      };
    case"underline":
      return {
        ...base,
        // 渐变的两个色标都要走令牌：color-mix 允许 var()，且能在深色下换值。
        backgroundImage:
          "linear-gradient(to bottom, transparent 82%, var(--annotation-underline-line) 82%, var(--annotation-underline-line) 100%)",
        backgroundColor:"var(--annotation-underline-fill)",
      };
    case"strike":
      return {
        ...base,
        backgroundImage:
          "linear-gradient(to bottom, transparent 45%, var(--annotation-strike-line) 45%, var(--annotation-strike-line) 57%, transparent 57%)",
        backgroundColor:"var(--annotation-strike-fill)",
      };
    case"text":
      // 文本批注气泡：**刻意**在两主题下都是深底白字，不跟随 UI 主题。
      // 它要压在 PDF 纸面上，而纸面在深色下会被反相 —— 一个跟随主题的浅色气泡
      // 落在深色纸面上虽然能看见，但读者刚扫过去时会以为那是页面本身的一部分
      // （图表、页眉都可能是一片浅色）。恒定深底让它永远读作「不属于这一页的东西」。
      return {
        ...base,
        backgroundColor:"var(--annotation-note-bg)",
        border:"1px solid var(--annotation-note-border)",
        color:"var(--annotation-note-fg)",
      };
    case"wavy":
      // 手工/历史 wavy 标注的兜底渲染。**当前路径下 `wavy` 是 AI-only**
      // （见本文件的 WAVY_IS_NOT_A_USER_TOOL 断言），AI 新留的波浪线由
      // textLayerMarker 在文本层内部画，不走这个覆盖层 —— 这里只服务
      // 水合进来的旧数据。
      return {
        ...base,
        backgroundImage:"var(--manual-wavy-image)",
        backgroundRepeat:"repeat-x",
        backgroundPosition:"left bottom",
        backgroundSize:"12px 6px",
        pointerEvents:"none",
      };
  }
}

export function getDraftOverlayStyle(
  kind: ReaderAnnotationTool,
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

/**
 * 文本层**尺寸**是否变了（= 真的重排了：缩放、换文档、字号/排版变化）。
 *
 * ★ 这里曾经有一个 `hasPdfTextLayerGeometryChanged`（同时比较 left/top/width/height），
 * 已**删除** —— 它不是「更宽松的版本」，而是一个坐标系错误。`left/top` 是**视口坐标**，
 * 滚动时每帧都变。于是缓存的 span 几何在滚动中被结构性打废，任何一次取用都要把整层
 * span 重量一遍（200 页文档实测每批 225 个 span）。而 `left/top` 变化在语义上只说明
 * 「整层平移了」，span 之间的相对几何**一点没变** —— 平移可以直接搬运缓存，重排不可以。
 *
 * 之所以删而不是留着：「同时判四边」看起来更保守、更容易被下一个作者复用，
 * 而它的失效模式是**静默**的（功能全对，只是每帧多量 225 次矩形）。
 * `check-pdf-virtualization.mjs` 有一条负断言禁止它回来。
 *
 * 实测（2026-10-10，WebKit，200 页重页）：`getBoundingClientRect` 29k 次 / 6s、
 * 合计 924ms，正好等于同期慢帧相对 17ms 基线的超额总量（≈900ms）；而 Chromium
 * 同样 37k 次只要 187ms，所以这条路径只在 WebKit 上炸。修法就是不让滚动打废缓存。
 */
export function hasPdfTextLayerGeometryResized(previous: PdfTextLayerGeometry | null, next: PdfTextLayerGeometry) {
  if (!previous) return true;
  // 尺寸用容差比较：子像素抖动（dpr 换算）不该被当成重排，否则缓存又会每帧失效。
  const epsilon = 0.5;
  return (
    Math.abs(previous.width - next.width) > epsilon ||
    Math.abs(previous.height - next.height) > epsilon
  );
}

/**
 * 把已缓存的 span 几何整体平移 (dx, dy)。
 *
 * 只调 `rect.left/top` 与 `centerY` 即可 —— 宽高不变。消费者（命中测试、按行分组、
 * 标注区段换算）都在视口坐标系里一致地使用这些矩形，所以整体平移对它们完全等价于
 * 重新量一遍，但代价从「每个 span 一次强制布局冲刷」降到「一次对象分配」。
 */
export function shiftPdfTextSpans(spans: PdfTextSpan[], dx: number, dy: number): PdfTextSpan[] {
  if (!dx && !dy) return spans;
  return spans.map((span) => ({
    node: span.node,
    text: span.text,
    rect: new DOMRect(span.rect.left + dx, span.rect.top + dy, span.rect.width, span.rect.height),
    centerY: span.centerY + dy,
  }));
}

/**
 * 视口中心落在**哪一页** —— 命中测试交给浏览器，不要自己维护页顶几何缓存。
 *
 * 这里是全仓踩过最隐蔽的一次静默回归的现场（2026-10-10）：
 * 曾经用「每页页顶的几何数组 + 二分查找」按 `scrollHeight` 为失效指纹缓存，
 * 但缓存里存的是 `rect.top - rootRect.top - scrollTop`，比较基准却是
 * `scrollTop + clientHeight / 2` —— 两边不在同一坐标系，等价于把阈值写成了
 * `3 × scrollTop`。scrollTop = 0 时两种写法结果相同，所以**首屏与当时的 e2e
 * 一直全绿**；一旦阅读位置在深处（恢复上次位置 / 深跳），活跃窗口就整体超前
 * `2 × scrollTop ÷ 页高` 页，**屏幕上正在看的那一页根本不在活跃集合里**，
 * 于是正文整片空白；点缩略图会直接改写活跃集合、所以立刻可见，再滚一下又空白。
 * 实测（60 页夹具，scrollTop = 23938）判定成第 58 页，而视口里是第 29–30 页。
 *
 * 结论与 `elementsFromPoint` 那次一致：**别维护 DOM 的影分身**。
 * 「视口中心下面是谁」是浏览器已经做好的事 —— 一次 hit test，
 * 代价与读一次 `clientHeight` 同级，且不存在失效时机问题。
 * 用 `elementFromPoint`（单个元素）而不是 `elementsFromPoint`（整条栈）。
 *
 * 取不到（点在页间空白、整页被 `visibility: hidden` 等）时返回 null，
 * 由调用方回退到上一次的页码 —— 回退值一定在活跃集合里，不会造成空白。
 */
export function pageNumberAtViewportCenter(root: HTMLElement): number | null {
  const rect = root.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const block = hit?.closest("[data-pdf-page]") as HTMLElement | null;
  const pageNo = Number(block?.dataset.pdfPage);
  return Number.isInteger(pageNo) && pageNo > 0 ? pageNo : null;
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
  /**
   * 历史 bug（2026-10-06 实测）：旧实现把每个 span 内的空白全部剥掉再无缝拼接，
   * 本意是合并 pdf.js 把单词劈成多个 span 的断词（"Fig" + "ure"），但副作用是
   * 词与词之间的空格也一起消失了 —— 划词文本变成
   * "Figure1Schematicoftwo-channel..."，模型拿到的是一堆字符，翻译与提问质量
   * 随之崩塌。
   *
   * 现在按**几何间距**决定连接符：
   *   - span 内部空白折叠成单个空格（不再删除）；
   *   - 同一行内 span 间有水平空隙 → 空格（词距）；
   *   - 跨行的竖直间距超过约 0.6em → 段落分隔（"\n\n"），否则 → 空格（同段换行）；
   *   - 水平无缝隙（断词）→ 直接连上；前段以连字符结尾时也直接连。
   *
   * 文本层此刻必然在 DOM 里（这个函数只被 textLayer 的 span 组调用），
   * getClientRects 的开销可以接受。
   */
  const joinKind = (previous: HTMLElement, next: HTMLElement): "" | " " | "\n\n" => {
    const previousRects = previous.getClientRects();
    const nextRects = next.getClientRects();
    if (!previousRects.length || !nextRects.length) return " ";
    const last = previousRects[previousRects.length - 1];
    const first = nextRects[0];
    const fontSize = Number.parseFloat(window.getComputedStyle(previous).fontSize) || 12;
    const verticalGap = first.top - last.bottom;
    if (verticalGap > fontSize * 0.6) return "\n\n";
    const horizontalGap = first.left - last.right;
    if (horizontalGap > fontSize * 0.2) return " ";
    return "";
  };

  const parts: Array<{ element: HTMLElement; text: string }> = [];
  for (const span of spans) {
    const text = (span.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    parts.push({ element: span, text });
  }

  let output = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index === 0) {
      output = part.text;
      continue;
    }
    const join = joinKind(parts[index - 1].element, part.element);
    // 行尾连字符 + 无缝拼接属于跨行断词（"state-" / "of" → "state-of"），去连字符。
    const previousEndsHyphen = /-$/.test(output);
    if (join === "" && previousEndsHyphen) output = output.slice(0, -1) + part.text;
    else output += join + part.text;
  }
  return output
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
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

/**
 * ⚠️ 本文件曾有两个「按块并集框操作 span」的函数，都已删除，不要恢复：
 *
 * - `collectPdfBlockSpans` —— 按 `block.rect` 并集框收 span。
 * - `drawSpanGroupHighlightElements` —— 按段落矩形画绝对定位覆盖 div。
 *
 * 两者是「点一下选了两段」「波浪线贴在整段底部」「双栏糊成一片」这三个
 * 实测 bug 的共同根因：段落 rect 是**并集框**，拿它做逐 span 的取舍或做
 * 覆盖矩形，粒度必然错。
 *
 * 现在一律走 `pdfReader/textLayerMarker.ts`：段落边界用解析器的行级 bbox
 * （`PdfReadingBlock.lines`），标注渲染用 pdf.js 官方的行内切分算法。
 */

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
      // ⚠️ 刻意**不**吸收 structured 块的 lines：保留 domBlock 自己的行几何。
      // 波浪线区间命中、锚点定位、整句扩展都拿行 rect 与 text layer 的
      // getBoundingClientRect 对表 —— DOM 行与 text layer 同源（都量自渲染后的
      // span），pymupdf 的 bbox 走的是另一套坐标系，混进来会让命中整体偏移。
      // DOM 行 text 与 pymupdf 行 text 的差异只影响「句末标点判断的精度」，
      // 不影响几何正确性。
    };
  });
}

