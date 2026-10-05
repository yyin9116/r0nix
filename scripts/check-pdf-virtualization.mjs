import { readFileSync } from "node:fs";
import { flat, view } from "./lib/source-view.mjs";
import { fileView, readerView } from "./lib/reader-view.mjs";

const FILE_PDF_VIEWER = "src/components/PDFViewer.tsx";
const FILE_PAGE_CANVAS = "src/components/pdfReader/PageCanvas.tsx";

/**
 * 源码一律经过 `view()`（忽略空白比较），原因见 scripts/lib/source-view.mjs。
 * 简言之：本文件 80+ 条断言原本是逐字符精确匹配，源码被格式化器压缩空格后
 * 正断言静默失败、负断言静默放行，整条门禁从 2026-10-03 起一直红着。
 *
 * ★ 2026-10-04：PDFViewer.tsx 从 5509 行单文件拆成 1 + 4 个文件后的读法
 * ---------------------------------------------------------------------------
 * `readerView()`（scripts/lib/reader-view.mjs）把阅读器模块当一个整体读，
 * 于是下面 80+ 条断言一行都不用改 —— 拆分只是搬运，没有跨文件重排逻辑。
 *
 * 两类断言必须点名具体文件：
 *   ① 依赖**相对顺序**的（indexOf 先后比较）→ FILE_PAGE_CANVAS
 *   ② 逐文件语义（如「两个渲染点各清理一次」）→ 各自的 fileView
 * 并集会让负断言**变强**（在更多文件里找禁止写法），这是想要的方向；
 * 本文件所有负断言的针在阅读器模块里都不存在，已逐条核对。
 */
const viewer = readerView();
/** 阅读器主体（拆分后仍是最大的那个文件）。 */
const pdfViewer = fileView(FILE_PDF_VIEWER);
/** 逐页画布渲染任务所在文件：只有「按先后顺序」的断言能在这里读。 */
const pageCanvas = fileView(FILE_PAGE_CANVAS);
const styles = view(readFileSync("src/components/PDFViewer.css", "utf8"));
const app = view(readFileSync("src/App.tsx", "utf8"));
const native = view(readFileSync("src-tauri/src/tauri_commands.rs", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(viewer.includes("Array.from({ length: totalPages },"), "PDF page placeholders must preserve document scroll geometry.");
assert(viewer.includes("const pageNumbers = useMemo"), "Long PDF page number lists must be memoized.");
assert(viewer.includes("const annotationsByPage = useMemo"), "Page annotations must be grouped once instead of filtered for every page render.");
assert(viewer.includes("annotationsByPage.get(pageNo) || []"), "Active page overlays must consume the grouped annotation index.");
assert(viewer.includes("activePages.has(pageNo)"), "PDF rendering must be gated by the active page set.");
assert(viewer.includes("{active ? ("), "Canvas and text-layer subtree must be mounted only for active pages.");
const renderRunStart = pageCanvas.indexOf("const run = async () => {");
const inactiveGate = pageCanvas.indexOf("if (!active)", renderRunStart);
const getPageCall = pageCanvas.indexOf("page = await doc.getPage(pageNo);", renderRunStart);
assert(renderRunStart >= 0 && inactiveGate >= 0 && getPageCall > inactiveGate, "Inactive PDF pages must be rejected before getPage() allocates a PDFPageProxy.");
assert(viewer.includes("hasPaintedRef.current"), "Text-layer visibility must survive same-document canvas redraws.");
assert(viewer.includes("active ? getVisibleImagesForPage(pageNo) : []"), "Image overlays must not scan or mount for inactive pages.");
assert(viewer.includes("thumbnailObserverRef"), "Thumbnails must share one IntersectionObserver instead of creating one per page.");
assert(viewer.includes("onRegisterThumbnailVisibility"), "Thumbnails must register visibility callbacks with the shared observer.");
assert(viewer.includes("const PageThumbnail = memo"), "Thumbnail rows must avoid rerendering unchanged pages.");
assert(viewer.includes("handleThumbnailClick"), "Thumbnail handlers must be stable across viewer state updates.");
// ★ 2026-10-05：预览从「锁定页」上移到「整个页流」后，原点从百分比改成了绝对像素。
// 意图没变（锚定指针位置），但换算方式变了：每页各按自己的**相对**原点缩放会改变
// 页间距（看起来像散开），所以必须共用一个**绝对**原点 —— 锚点在页流坐标系里的像素位置。
// 这里刻意断言「原点由锚点算出」而不是只断言 transformOrigin 被写过：
// 后者在退化成 `transformOrigin: "top left"` 时仍然绿。
assert(
  viewer.includes("const originX = base ? anchor.viewportX - base.left : 0") &&
    viewer.includes("const originY = base ? anchor.viewportY - base.top : 0") &&
    viewer.includes("flow.style.transformOrigin = `${originX}px ${originY}px`"),
  "Zoom preview must anchor the transform at the pointer position.",
);
// 负断言：禁止退回「只缩放锁定的那一页」。那正是「某一页先缩放、其他页后跟上」
// 的来源 —— 用户直接看到的不一致，比性能取舍更要紧。
assert(
  !viewer.includes("lockedZoomPage === pageNo ? zoomScale") &&
    !viewer.includes('transform: visualScale === 1 ? undefined : `scale(${visualScale})`'),
  "Zoom preview must scale the whole page flow, not only the locked page.",
);
// rAF 缩放循环不消费 --duration-* / --ease-*，令牌层把时长归零对它无效，
// 所以它必须自己判断 reduce —— 不判断的话 reduce 用户照样看完整逐帧逼近。
// 断言完整的 matchMedia **调用形式**而不是裸名字 "prefers-reduced-motion"：
// 裸名字在分支被改成 `if (false)` 时仍然绿（本仓踩过 4 次的同类坑）。
// ★ 诚实标注这条守卫的边界：它挡得住「整条判断被删掉 / 换成别的常量」，
//   挡不住「条件被改成永假而函数名还在」—— 那种改动只能靠行为断言。
assert(
  viewer.includes('window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true'),
  "Zoom animation must honor prefers-reduced-motion; the rAF loop ignores CSS duration tokens.",
);
assert(!viewer.includes("const anchorClientX = nodeRect.left + anchor.relX * nodeRect.width"), "Zoom preview must not apply a second scroll correction after anchoring the transform origin.");
assert(!viewer.includes("const anchorClientY = nodeRect.top + anchor.relY * nodeRect.height"), "Zoom preview must not apply a second vertical scroll correction after anchoring the transform origin.");
assert(!viewer.includes("const visualScale = zoomScale / layoutScale"), "Zoom anchor correction must not mix layout and transformed scales.");
assert(viewer.includes("zoomLockReleaseTimerRef"), "Zoom must keep the current page locked until layout commit settles.");
assert(viewer.includes("onPageRendered"), "Zoom lock release must observe actual target-page rendering.");
assert(viewer.includes("ZOOM_RENDER_READY_FALLBACK_MS"), "Zoom lock release must have a bounded fallback for failed renders.");
assert(viewer.includes("zoomRenderReadyRef.current"), "Zoom release must distinguish rendered target pages from stale layout state.");
assert(viewer.includes("if (rightDragRef.current.active) return;"), "Right-wheel zoom must not commit a new PDF render scale during the gesture.");
assert(viewer.includes("scheduleRenderZoomCommit(zoomTargetRef.current);"), "Right-wheel zoom must commit the final render scale after pointer release.");
assert(viewer.includes("void task.promise.then(clear, clear)"), "Cancelled PDF.js render tasks must not create unhandled promise rejections.");
assert(viewer.includes("if (lockedZoomPageRef.current === null)"), "Toolbar and wheel zoom must share the current-page lock.");
assert(viewer.includes("collectPdfBlockSpans"), "Translation hover must retain backend block geometry as a fallback.");
assert(viewer.includes("const group = blockGroup.length > 0 ? blockGroup : paragraphGroup"), "Translation hover must prefer the complete PDF.js DOM block and use heuristic grouping only as fallback.");
assert(viewer.includes("activeAssistGroupRef"), "Translation hover must reuse an existing paragraph highlight while crossing its spans.");
assert(viewer.includes("hasPdfTextLayerGeometryChanged"), "Text-layer geometry caches must invalidate after zoom or sidebar layout changes.");
assert(viewer.includes("textSpanGeometryRef"), "Translation hover must track the current text-layer geometry.");
assert(viewer.includes("getNormalizedSpanGroupRect"), "Reading-assist source positions must use the actual highlighted text-layer geometry.");
assert(viewer.includes("if (currentFileIdRef.current !== fileId) return images;"), "Async image scans must not write results into a newly opened document.");
assert(viewer.includes("if (currentFileIdRef.current !== fileId) return blocks;"), "Async reading-block scans must not write results into a newly opened document.");
const blockStoreStart = pdfViewer.indexOf("const storeReadingBlocks = useCallback");
const blockStoreEnd = pdfViewer.indexOf("const loadPageReadingBlocks", blockStoreStart);
assert(blockStoreStart >= 0 && blockStoreEnd > blockStoreStart && flat(pdfViewer.raw.slice(blockStoreStart, blockStoreEnd)).includes("},[documentId,fileId],);"), "Reading-block storage must refresh when the active PDF changes.");
assert(viewer.includes("fullTranslationResultsRef"), "Full translation progress must accumulate results outside React state updates.");
assert(viewer.includes("pdfPage.cleanup();"), "Full-text search must release each PDF.js page after reading it.");
assert(viewer.includes("getPdfPageWithResourceTimeout(pdfDoc, pageNo)"), "Full-text search must bound PDF.js page acquisition.");
assert(viewer.includes("withResourceScanTimeout(pdfPage.getTextContent(), `PDF search page ${pageNo} text`"), "Full-text search must bound per-page text extraction.");
assert(viewer.includes("pdfDoc.cleanup();"), "Unmounted PDF viewers must release PDF.js page-level resources while retaining the cached document handle.");
assert((viewer.match(/page\.cleanup\(\);\n\s*page = null;\n\s*return;/g) || []).length >= 2, "Late PDF page proxies from both document pages and thumbnails must be cleaned up immediately.");
assert(viewer.includes("lg:pr-80"), "The translation sidebar must reserve space only on large layouts.");
assert(viewer.includes("transition-[padding-right]"), "Sidebar expansion must animate the PDF available width.");
assert(viewer.includes('className="translation-results space-y-3"'), "Full translation results must expose a stable performance boundary.");
assert(viewer.includes('contentVisibility: "auto"'), "Off-screen translation results must be skipped by the browser compositor.");
assert(viewer.includes("// Keep resource extraction serialized."), "Resource extraction must stay serialized to protect visible PDF rendering.");
assert(viewer.includes("const publishProgress = () =>"), "Resource scan progress must be coalesced instead of updating React for every page.");
assert(viewer.includes("window.requestAnimationFrame"), "Resource scan progress must use an animation-frame boundary.");
assert(viewer.includes("cancelProgressFrame"), "Cancelled resource scans must cancel queued progress frames.");
assert(viewer.includes("resourceScanAbortRef.current?.abort(new DOMException(\"The document changed\", \"AbortError\"))"), "Document changes must abort the previous resource scan immediately.");
assert(viewer.includes("for (const task of imageDetectionInFlightRef.current.values())"), "Document changes must abort shared image detection tasks before clearing them.");
assert(viewer.includes("for (const controller of readingBlocksAbortRef.current.values())"), "Document changes must abort page reading-block tasks before clearing them.");
assert(viewer.includes("readingBlocksLoadAbortRef.current?.abort"), "Document changes must abort full-document reading-block extraction.");
assert(viewer.includes("api.getPDFReadingBlocks(fileId, undefined, controller.signal"), "Page reading-block extraction must carry an abort signal.");
assert(viewer.includes("if (signal?.aborted) detachCallerAbort();"), "Full reading-block extraction must honor an already-aborted caller signal.");
assert(viewer.includes("if (readingBlocksInFlightRef.current.get(requestKey) === request)"), "Stale page block cleanup must not delete a newer shared request.");
assert(viewer.includes("if (readingBlocksLoadRef.current === request) readingBlocksLoadRef.current = null"), "Stale full block cleanup must not clear a newer shared request.");
assert(viewer.includes('resourceScanAbortRef.current?.abort(new DOMException("The viewer was closed", "AbortError"))'), "Viewer teardown must abort resource scans.");
assert(viewer.includes('readingBlocksLoadAbortRef.current?.abort(new DOMException("The viewer was closed", "AbortError"))'), "Viewer teardown must abort full reading-block extraction.");
assert(viewer.includes('readingBlocksInFlightRef.current.clear();'), "Viewer teardown must release page reading-block requests.");
assert(viewer.includes("const resourceCacheLoadGenerationRef = useRef(0)"), "Resource cache loading must have a generation guard.");
assert(viewer.includes("const loadGeneration = ++resourceCacheLoadGenerationRef.current"), "Resource cache loads must capture their generation.");
assert(viewer.includes("resourceCacheLoadGenerationRef.current === loadGeneration"), "Stale resource cache microtasks must not mark a newer document as loaded.");
assert(viewer.includes("RESOURCE_SCAN_PAGE_TIMEOUT_MS"), "Resource scans must have a bounded per-page timeout.");
assert(viewer.includes("getPdfPageWithResourceTimeout"), "Timed-out page acquisition must clean up a late PDFPageProxy.");
assert(viewer.includes("withResourceScanTimeout"), "PDF.js resource extraction must not wait forever on annotations or text content.");
assert(!viewer.includes("results: latest ? [...prev.results, latest]"), "Full translation progress must not copy the complete results array for every block.");
assert(viewer.includes("setReadingBlocksVersion((value) => value + 1);"), "PDF.js DOM block updates must refresh derived image/resource views immediately.");
assert(!viewer.includes("page-text-overlay transition-opacity"), "Text-layer selection must not fade the full overlay during state changes.");
/* 【已作废 · 2026-10-04】原为：
 *   assert(styles.includes("isolation: isolate"), "Native text selection must be isolated to the PDF text layer.");
 *
 * 作废理由：全仓 `isolation: isolate` 只有一处实例，宿主是 `.page-stack`；而该类比在
 * HEAD 的 src、拆分后的 src、以及 dist 产物（含动态拼接的可能）里**三处都零消费者**，
 * 属死 CSS，已随本轮死代码清理删除。也就是说这条断言一直在用一条永不生效的规则做担保
 * —— 它过去打印「绿」并不代表选择域真被隔离，而它变红也不代表功能回归。
 *
 * 真正的选择隔离由绑在**活规则**上的相邻断言承担（下面这几条的选择器消费者均已在
 * src 与产物两侧核对过）：
 *   · `.pdf-selection-scope .textLayer span::selection` —— 作用域限定到 PDF.js 文本 span
 *   · 禁止页面级 `.pdf-selection-scope ::selection`
 *   · `.page-text-overlay.is-selectable .textLayer` / `.textLayer *` —— 文本层边界显式化
 *   · 禁止把 span / br 切成独立选择岛；禁止在文本层祖先上 user-select:none
 * 故本条作废不降低任何活约束。另注：`isolation` 是层叠上下文属性，与选择行为无因果关系；
 * 当前活容器 `.pdf-selection-scope` 已由 TSX 的 `relative z-0` 建立层叠上下文。
 *
 * 换成下面这条**存活断言** —— 它防的正是上面那个坑本身：某条规则还写在 CSS 里、
 * 但已经没有消费者（或反过来，选择域类被从 TSX 里删掉却没人发现）。 */
assert(
  styles.includes(".pdf-selection-scope") && viewer.includes("pdf-selection-scope"),
  "PDF selection scope must stay bound to a live consumer, not to orphan CSS.",
);
assert(styles.includes(".pdf-selection-scope .textLayer span::selection"), "PDF selection must be scoped to PDF.js text spans.");
assert(!styles.includes(".pdf-selection-scope ::selection"), "PDF selection must not install a page-wide selection pseudo-element.");
assert(!app.includes("selection:bg-zinc-200") && !app.includes("dark:selection:bg-zinc-700"), "App shell must not override PDF.js selection with a global selection rule.");
assert(viewer.includes("const zoomPreviewRef = useRef(zoom)"), "Zoom preview must keep its per-frame value outside React render state.");
assert(
  viewer.includes("smoothZoomByFactorRef.current(pinchZoomFactor("),
  "Pinch must go through the ratio path, not the wheel's delta path.",
);
assert(viewer.includes("const applyZoomPreview = useCallback"), "Zoom preview must update the page flow directly during animation.");
assert(!viewer.includes("setZoom((currentZoom)"), "Zoom animation must not re-render the whole PDF viewer on every frame.");
assert(styles.includes(".page-text-overlay.is-selectable .textLayer *"), "Native PDF selection must preserve PDF.js text-layer descendants.");
assert(styles.includes(".page-text-overlay.is-selectable .textLayer"), "WebKit PDF selection must be explicit at the text-layer boundary.");
assert(!styles.includes(".page-text-overlay.is-selectable .textLayer span,\n.page-text-overlay.is-selectable .textLayer br"), "PDF.js text spans must not become independent selection islands.");
assert(styles.includes(".page-text-overlay.is-assist .pdf-assist-block-highlight"), "Translation hover rectangles must own assist pointer interaction.");
assert(viewer.includes("activeAssistBlockRef"), "Translation hover must retain the active block while crossing its line rectangles.");
assert(viewer.includes('mode?: "page" | "original" | "crop"'), "Image export must distinguish original resources from rendered crops.");
assert(viewer.includes("原始图片资源无法解码") && viewer.includes("exportImageCropPng"), "Failed original image extraction must offer an explicit crop action.");
assert(styles.includes("content-visibility: auto"), "Inactive PDF pages must use content-visibility.");
assert(styles.includes("contain-intrinsic-size"), "Inactive PDF pages must have intrinsic placeholder dimensions.");
assert(styles.includes(".pdf-selection-scope") && styles.includes("overflow-anchor: none"), "PDF zoom must disable browser scroll anchoring while page geometry changes.");
assert(!viewer.includes('pdf-selection-scope flex-1 overflow-auto bg-zinc-200/50 dark:bg-zinc-950/50 relative z-0 select-none'), "PDF selection scope must not impose user-select:none on the text-layer ancestor.");
const tileTaskStart = native.indexOf("pub async fn request_tiles");
const tileTaskEnd = native.indexOf("#[tauri::command]", tileTaskStart + 1);
const tileTask = native.slice(tileTaskStart, tileTaskEnd > tileTaskStart ? tileTaskEnd : undefined);
assert(tileTask.includes('acquire_python_task_permit("tile render")'), "Tile rendering must share the bounded Python concurrency gate.");
assert(tileTask.includes("let _python_permit = python_permit"), "Tile render tasks must hold the Python permit for their full render lifetime.");
assert(tileTask.includes("tile viewport must contain finite positive dimensions"), "Tile requests must reject invalid viewport dimensions before planning work.");
assert(tileTask.includes("tile viewport is too large to render safely"), "Tile requests must reject unbounded tile plans.");
assert(native.includes("const MAX_RENDER_ZOOM: f32 = 8.0"), "Native PDF rendering must cap the requested zoom.");
assert(native.includes("SVG crop rectangle must contain finite positive dimensions"), "SVG crop exports must reject invalid rectangles.");

// 文本选中能力必须同源：PageCanvas 的 enableTextLayer 与批注 overlay 的 pointer-events
// 消费同一个判定。分开写会得到「文本层渲染了、但被 overlay 挡住」——
// 看得见却选不中，且不报任何错，是这类分层里最难排查的形态。
assert(
  viewer.includes("enableTextLayer={textSelectionEnabled}"),
  "Text layer enablement must read the shared textSelectionEnabled predicate.",
);
assert(
  viewer.includes("textSelectionEnabled && !isGestureRightDown"),
  "Annotation overlay must yield pointer events using the same predicate that enables the text layer.",
);
// 反证：判定式本身只允许在变量定义处出现一次，否则两处会各自漂移。
const selectPredicate = 'activeTool ==="select" || isTranslationReader';
assert(
  viewer.split(selectPredicate).length - 1 === 1,
  "The text-selection predicate must be defined once, not duplicated at each consumer.",
);

// 光标必须描述右键拖拽**实际做的事**：moveRightGesture 改的是 scrollLeft/scrollTop，
// 是平移（pan），不是缩放。此前这里写的是 cursor-ns-resize（上下调尺寸），
// 与实际行为不符，且 hand 工具用 cursor-grab 暗示「左键能拖」—— 而拖拽只认右键。
assert(!viewer.includes("cursor-ns-resize"), "Right-drag pans the page; its cursor must not claim resize semantics.");
assert(
  !viewer.includes("cursor-grab active:cursor-grabbing"),
  "The hand tool must not show a grab cursor: dragging the page requires the right button.",
);
// 手型必须同时在页块与滚动容器上 —— 只改页块会让页间留白处光标不变，看着像没生效。
assert(
  viewer.split('isGestureRightDown ?"cursor-grabbing"').length - 1 === 2,
  "The pan cursor must cover both page blocks and the scroll container's empty space.",
);

console.log("pdf-virtualization: ok");
