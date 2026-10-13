import { readFileSync } from "node:fs";
import { flat, stripComments, view } from "./lib/source-view.mjs";
import { fileView, readerView } from "./lib/reader-view.mjs";

const FILE_PDF_VIEWER = "src/components/PDFViewer.tsx";
const FILE_PAGE_CANVAS = "src/components/pdfReader/PageCanvas.tsx";
const FILE_COMPANION_CARD = "src/components/pdfReader/CompanionMarginCard.tsx";
const FILE_PAGE_THUMBNAIL = "src/components/pdfReader/PageThumbnail.tsx";

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
/** 阅读器模块的**原文**（未折叠空白、未剥注释）—— 给需要在剥注释视图上做负断言的断言用。 */
const readerRaw = readerView().raw;
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
//
// ★ 2026-10-10：原点的**来源**改了 —— 而且这是同一处错了两回之后的第三个版本。
// 旧写法把「锚点」与「页流基准」拆成两个 ref，基准只在 applyZoomTarget 判定
// 「自己刚锁上页」时采一次；而右键路径在 handleViewerPointerDown 里已经锁过页，
// 那段整段被跳过 → 基准恒为 null → 代码的 `base ? … : 0` 兜底把原点钉成 0 0
// → 页流绕**自己左上角**缩放 → 光标下的内容整片滑走
// （实测页内归一化位置：0.5 → 0.357 → 0.26 → 0.19 → 0.098，连滚 5 拍已经滑掉 4/5 个页宽）。
// 现在原点与锚点在**同一次量测**里算出、存进**同一个对象**，
// 「有锚点却算不出原点」在类型上不再可表达。所以这里断言三件事：
// ① 原点取自锚点本身；② 采锚点时顺手量了页流、把原点写进同一个对象；
// ③ 独立的页流基准缓存不许回来。
//
// ★ 2026-10-10 补充：写 origin / transform 的位置移进了 `applyZoomPreviewScale`
//   （为了让「transform 与逆比例」成对维护，见后面第 ④ 组断言），所以这一条改成
//   **两侧一起断言**：helper 里写的是传进来的 origin，调用点传的是锚点的 origin。
//   只查一侧的话，把调用点改成常量（退回 0 0 那条老路）依然会绿。
assert(
  viewer.includes("flow.style.transformOrigin = `${originX}px ${originY}px`") &&
    viewer.includes("applyZoomPreviewScale(flow, visualScale, anchor.originX, anchor.originY)"),
  "Zoom preview must take the transform origin from the anchor itself, not from a separate cache that can be missing.",
);
assert(
  viewer.includes("originX: rootRect.left + viewportX - flowRect.left") &&
    viewer.includes("originY: rootRect.top + viewportY - flowRect.top") &&
    viewer.includes("originX: number;") &&
    viewer.includes("originY: number;"),
  "captureZoomAnchor must measure the flow rect next to the page rect and store the origin on the anchor's type — a split source is what let the origin silently fall back to 0 0.",
);
// 负断言必须在**剥掉注释**的视图上做：本次事故的完整证据就写在注释里
// （zoomAnchorRef 的说明点名了 zoomFlowBaseRef），在原文上匹配会把证据本身算成违规。
assert(
  !flat(stripComments(readerRaw)).includes("zoomFlowBaseRef"),
  "the zoom flow base must not return as a separate cache: 'anchor present but origin unavailable' is exactly the state that produced origin 0 0.",
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
// ★ 2026-10-10：这两条原先禁止**任何**滚动补偿，起因是旧实现曾在预览帧里再补一次滚动，
// 页面于是左右漂移并回弹。真正该禁的不是「补偿」，而是「**逐帧**补偿」——
// 所以规则收紧成：补偿不得出现在逐帧执行的预览路径里，并且必须满足两条前提
// （① 只在 renderZoom 提交后跑一次；② 用锚点的 relX/relY 量出现值再推回去，而不是按比例推算）。
//
// ⚠️ 这一段全部在**剥掉注释**的视图上做：本次改动的证据本身就在注释里写着
// 「此刻改 scrollLeft/Top」「兜底会清掉锚点」，在原文上做负断言会把证据算成违规。
const pdfViewerCode = stripComments(readFileSync(FILE_PDF_VIEWER, "utf8"));
const previewStart = pdfViewerCode.indexOf("const applyZoomPreview = useCallback(");
const previewEnd = pdfViewerCode.indexOf("useLayoutEffect(() => {", previewStart);
assert(
  previewStart > 0 && previewEnd > previewStart,
  "applyZoomPreview must be followed by the commit-time anchor-restore effect.",
);
const previewBody = view(pdfViewerCode.slice(previewStart, previewEnd));
assert(
  !previewBody.includes("scrollTop") && !previewBody.includes("scrollLeft"),
  "the per-frame zoom preview must not touch the scroll position; the correction belongs to the one-shot effect that runs after the renderZoom commit.",
);
const restoreBody = view(pdfViewerCode.slice(previewEnd, previewEnd + 2400));
assert(
  restoreBody.includes("root.scrollLeft += currentX - (rootRect.left + pending.viewportX)") &&
    restoreBody.includes("root.scrollTop += currentY - (rootRect.top + pending.viewportY)"),
  "the commit-time restore must measure where the anchor point ended up and push it back to the captured screen position (measure, don't extrapolate).",
);
assert(
  restoreBody.includes("}, [renderZoom]);"),
  "the anchor restore must be keyed on renderZoom so it runs once per commit, not per frame.",
);
// ★ 2026-10-10：两个定时器必须互斥 —— 这次事故是**竞态**，最容易被当成偶发。
// scheduleRenderZoomCommit 排下新的提交后，必须立刻作废上一轮残留的「锁释放兜底」：
// 兜底无条件调 releaseLockedZoomPage()，而它会清掉 zoomAnchorRef，于是提交时
// 拿不到锚点、补不了滚动。实测：右键连滚 3 拍（提交先跑）正常、连滚 5 拍
// （残留兜底先跑）跳 285px —— 同一个操作两种结果。
// 断言顺序：清兜底必须发生在 `rightDragRef.current.active` 提前返回**之前**，
// 否则按住右键期间每一步都会重新排兜底，作废就白做了。
const commitStart = pdfViewerCode.indexOf("const scheduleRenderZoomCommit = useCallback(");
const commitBody = view(pdfViewerCode.slice(commitStart, commitStart + 2800));
const fallbackClearedAt = commitBody.indexOf("window.clearTimeout(zoomLockReleaseTimerRef.current)");
const dragGateAt = commitBody.indexOf("if (rightDragRef.current.active) return;");
assert(
  fallbackClearedAt > 0 && dragGateAt > fallbackClearedAt,
  "scheduling a render-zoom commit must cancel the pending lock-release fallback *before* the right-drag early return; otherwise the fallback can fire first, clear the zoom anchor, and the commit loses its scroll compensation.",
);
assert(!viewer.includes("const visualScale = zoomScale / layoutScale"), "Zoom anchor correction must not mix layout and transformed scales.");
assert(viewer.includes("zoomLockReleaseTimerRef"), "Zoom must keep the current page locked until layout commit settles.");
assert(viewer.includes("onPageRendered"), "Zoom lock release must observe actual target-page rendering.");
assert(viewer.includes("ZOOM_RENDER_READY_FALLBACK_MS"), "Zoom lock release must have a bounded fallback for failed renders.");
assert(viewer.includes("zoomRenderReadyRef.current"), "Zoom release must distinguish rendered target pages from stale layout state.");
assert(viewer.includes("if (rightDragRef.current.active) return;"), "Right-wheel zoom must not commit a new PDF render scale during the gesture.");
assert(viewer.includes("scheduleRenderZoomCommit(zoomTargetRef.current);"), "Right-wheel zoom must commit the final render scale after pointer release.");
assert(viewer.includes("void task.promise.then(clear, clear)"), "Cancelled PDF.js render tasks must not create unhandled promise rejections.");
assert(viewer.includes("if (lockedZoomPageRef.current === null)"), "Toolbar and wheel zoom must share the current-page lock.");
/**
 * 段落边界必须来自**解析器给的行级几何**，几何启发式只能兜底。
 *
 * ⚠️ 这两条原先钉的是「按块并集框收 span 优先」：
 *   - `collectPdfBlockSpans`（按 block.rect 并集框收 span）
 *   - `const group = blockGroup.length > 0 ? blockGroup : paragraphGroup`
 *
 * 那正是「点一下选了两段」的成因：块 rect 是整块并集框，学术论文里一个块能
 * 横跨 5–10 个自然段，按它收 span 必然把邻段一起框进来。
 *
 * 主来源已换成 `PdfReadingBlock.lines`（pymupdf `get_text("dict")` 的
 * `lines[].bbox`）—— 排版引擎给的行几何，判定用中心点命中，跨行不互吞。
 * **原则不变**：几何优先、启发式兜底；只是几何从「块级」精确到了「行级」。
 */
assert(viewer.includes("collectBlockSpansByLines"), "Translation hover must derive paragraph boundaries from parser line geometry.");
assert(viewer.includes("block?.lines?.length"), "Translation hover must prefer parser line bboxes when the block carries them.");
assert(viewer.includes("group = collectPdfParagraphSpansFromTarget(span, spans)"), "Translation hover must keep heuristic grouping as the fallback.");
assert(viewer.includes("activeAssistGroupRef"), "Translation hover must reuse an existing paragraph highlight while crossing its spans.");
assert(
  viewer.includes("hasPdfTextLayerGeometryResized"),
  "Text-layer geometry caches must invalidate on **size** change (zoom / layout), never on viewport position.",
);
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
// 捏合必须走**倍率**路径，不能混进滚轮的增量路径 —— 两者量纲不同，
// 同一个 delta 在两条路径下含义完全不同。
//
// ⚠️ 别改回「断言 `smoothZoomByFactorRef.current(pinchZoomFactor(` 紧挨着出现」：
// 那是换用@use-gesture 之前的写法（当时只有一行）。现在 onPinch 先算好 factor
// 再传进去，字面量自然不成立了 —— 而把它调成「有就行」的宽松匹配，又会退化成
// 「文件里提到过 pinchZoomFactor 就算数」。
//
// 这里钉的是**结构**：onPinch 里必须有倍率调用，且必须传给按倍率缩放的那条通道
// （smoothZoomByFactor），不能传给按步进缩放的 smoothZoomBy —— 后者正是
// 滚轮那条路，接错的后果是捏合一下就缩一个固定档，与手势幅度无关。
const onPinchAt = viewer.indexOf("onPinch:");
assert(onPinchAt > 0, "the pinch handler must exist.");
// 窗口给得比实际距离宽：onPinch 与它调用的那行之间夹着解释「为什么必须除掉
// lastOffset」的长注释。那段注释是这个函数最容易被误删的部分之一，
// 断言不该因为它长就失效。
const pinchBody = viewer.slice(onPinchAt, onPinchAt + 700);
assert(
  pinchBody.includes("pinchZoomFactor(") && pinchBody.includes("smoothZoomByFactorRef.current("),
  "Pinch must go through the ratio path (pinchZoomFactor → smoothZoomByFactor), not the wheel's delta/step path."
);
assert(
  !pinchBody.includes("smoothZoomByRef.current(") && !pinchBody.includes("wheelZoomStep("),
  "Pinch must not reuse the wheel's step-based zoom channel; a fixed step per gesture ignores how far the reader pinched."
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

/**
 * ★ 2026-10-10：滚动卡顿（WebKit / WKWebView 特有）的三条契约
 * ---------------------------------------------------------------------------
 * 用户报「已经把缩放取消了，滚动还是卡」。这份代码在 Chromium 上**量不出来**：
 * 200 页夹具（每页 1600×2200 位图 + 60 行文字）滚动 p50 16.7ms、0 慢帧。
 * 换到 WebKit —— 也就是 Tauri 实际跑的 WKWebView 内核 —— 同一份代码同一夹具
 * 是 23% 慢帧。逐调用计时：`getBoundingClientRect` 6 秒内 29,000 次、合计 924ms，
 * 而同期慢帧相对 17ms 基线的超额总量≈900ms —— 这一个入口吃干了全部顿挫。
 * （复跑：`PROBE_ENGINE=webkit node scripts/probe-pdf-scroll-cost.mjs 200 heavy`）
 *
 * 下面三条对应三处「不报错的错」：它们都不改变任何可见行为 —— 波浪线照画、
 * 悬停照亮、图片照能识别，只是每帧多做几百次强制同步布局、或多发几次后端请求。
 * 正因为静默，**只有守卫能拦住它们回来**。
 */
const readerCode = view(stripComments(readerRaw));
const pageCanvasCode = view(stripComments(readFileSync(FILE_PAGE_CANVAS, "utf8")));
const strippedPdfViewer = stripComments(readFileSync(FILE_PDF_VIEWER, "utf8"));
const pdfViewerCodeView = view(strippedPdfViewer);
// 伴读批注卡：它是「页流内 UI chrome」目前唯一的实例（见下面第 ④ 组断言）。
const companionCardView = view(stripComments(readFileSync(FILE_COMPANION_CARD, "utf8")));
const pageThumbnailView = view(stripComments(readFileSync(FILE_PAGE_THUMBNAIL, "utf8")));

// ① 文本层 span 几何必须有**唯一入口**，且缓存失效判据只看尺寸。
assert(
  pageCanvasCode.includes("const readTextSpans = (textLayer: HTMLElement): PdfTextSpan[] =>"),
  "文本层 span 几何必须有唯一入口 readTextSpans：裸调 getPdfTextSpans 会对每个 span 各做一次强制同步布局，WebKit 上单次最贵 12ms。",
);
assert(
  pageCanvasCode.includes("hasPdfTextLayerGeometryResized(previous, geometry)") &&
    pageCanvasCode.includes("shiftPdfTextSpans("),
  "滚动只是整层平移：几何缓存必须「尺寸变才重量、平移搬运」，否则每帧都要把整层 span 重量一遍。",
);
// 裸调用**只允许一处**：readTextSpans 内部的兜底取值。
// 第二处就意味着有人绕过了缓存 —— 而这不会报任何错，只是悄悄变慢。
//
// 2026-10-10 这里从 2 收紧到 1：原先渲染完成后还有一次「给缓存播种」
// （`textSpanCacheRef.current = getPdfTextSpans(builder.div)`），
// 它把每页整层 span（60–225 次强制同步布局）压在「翻页 → 渲染」这条路径上，
// 而那一笔只有当划词悬停或本页有标注时才值。改成按需测量后，
// 这条断言的语义从「别绕过缓存」升级成「只准有一处测量，且它必须是被调用的那一处」。
const countOf = (haystack, needle) => haystack.split(needle).length - 1;
const bareSpanReads = countOf(pageCanvasCode.flat, "getPdfTextSpans(");
assert(
  bareSpanReads === 1,
  `getPdfTextSpans 只允许在 readTextSpans 的兜底取值处出现一次，当前 ${bareSpanReads} 处 —— 多出来的那处要么绕过了缓存，要么在渲染路径上预先测了一遍整层 span（两种都不会报错，只是悄悄变慢）。`,
);
const spanCacheEntries = countOf(pageCanvasCode.flat, "readTextSpans(textLayer)");
assert(
  spanCacheEntries === 2,
  `两条消费路径（悬停命中、波浪线 effect）都必须走 readTextSpans，当前 ${spanCacheEntries} 处。`,
);

// ② 空标注清单必须是**共享常量**身份，不能是每次渲染都新建的数组字面量。
assert(
  pdfViewerCodeView.includes("const EMPTY_ANNOTATIONS: ReaderAnnotation[] = []"),
  "空标注清单必须是模块级共享常量：数组字面量每次渲染换引用，会让每个活跃页的波浪线 effect 在父组件每次渲染时重跑一遍（实测 465 次 / 6s）。",
);
assert(
  pdfViewerCodeView.includes(
    "derivedWavyAnnotations.length === 0 ? EMPTY_ANNOTATIONS : derivedWavyAnnotations",
  ),
  "波浪线标注的空结果必须换回共享常量，不能让两条分支各自产出的新数组直接传下去。",
);
assert(
  pdfViewerCodeView.includes("wavyAnnotations={pageWavyAnnotations}"),
  "波浪线标注必须消费上面那份被稳定化的变量（下游 effect 依赖它的身份），不能就地再算一次。",
);

// ③ 换页的图像元数据预取必须过静默期，不能与换页同步触发。
const metaDeps = "[fileId, isImageLabelReader, page, pdfDoc]";
const metaAnchor = strippedPdfViewer.indexOf(metaDeps);
const metaStart = strippedPdfViewer.lastIndexOf("useEffect(() => {", metaAnchor);
const metaEffect = view(strippedPdfViewer.slice(metaStart, metaAnchor));
assert(
  metaAnchor > 0 && metaStart > 0 && metaStart < metaAnchor,
  "找不到「换页即预取图像元数据」那个 effect —— 契约锚点失效，请先确认它没有被合并或改名。",
);
assert(
  metaEffect.includes("window.setTimeout(() => {") && metaEffect.includes("PAGE_METADATA_IDLE_MS"),
  "换页的图像元数据预取必须过 PAGE_METADATA_IDLE_MS 静默期：换页即扫会让滚动跨 10 页连发 10 次后端请求（PyMuPDF 扫该页）并取消 9 次，与滚动抢主线程。",
);
assert(
  metaEffect.raw.indexOf("const timer = window.setTimeout(") <
    metaEffect.raw.indexOf("detectPageImagesRef.current(page"),
  "图像扫描必须排在静默期定时器**之内**，不能与换页同步触发。",
);
assert(
  metaEffect.includes("window.clearTimeout(timer)") && metaEffect.includes("controller.abort()"),
  "静默期定时器必须在 effect 清理里取消，否则离开这一页后仍会发出已经过期的扫描。",
);

// 负断言：视口坐标绝不能参与几何缓存的失效判据。
// 在**剥注释**的视图上做 —— 上面几处的注释都点名了这个标识符，在原文上匹配会把证据当成违规。
assert(
  !readerCode.includes("hasPdfTextLayerGeometryChanged"),
  "视口坐标（left/top）绝不能参与文本层几何缓存的失效判据：滚动每帧都改 left/top，缓存会被结构性打废。整层平移请走 shiftPdfTextSpans。",
);

/* ────────────────────────────────────────────────────────────────────────
 * 2026-10-10（第二批）：「右键缩放把浮层一起放大」与「缩放误弹右键菜单」
 *
 * 这三条都是从**读者报告**倒推回来的，且都已实测复现/验证过，所以守卫的判据
 * 一律取「机制在位」而不是「某个字面量曾经存在」：
 *   · 页流内 UI chrome 的抵消 —— `probe-pdf-overlay-scale.mjs` 的 C 段有定量对照
 *     （页流 scale(1.0837) 时，带类的 200px 元素实测 200，不带类的实测 216.73）
 *   · 右键缩放不弹菜单 —— 同探针的 A 段读「松手后右键菜单：未打开」
 *   · 波浪线 effect 的空跑 —— 早退判据一旦被删，`setGroups([])` 会退化成
 *     「每渲染一页把整页 text div 重写好几遍」
 * ──────────────────────────────────────────────────────────────────────── */

// ④ 页流内的 UI chrome 必须抵消缩放预览（否则伴读批注卡会被抻大）。
// 逆比例是 CSS 变量，所以断言必须**跨文件**做：TS 侧写变量、CSS 侧读变量，
// 改名字只改一边的话，两边单看都是对的，只有拼起来才失效。
const inverseVarMatch = /ZOOM_PREVIEW_INVERSE_VAR = "([^"]+)"/.exec(strippedPdfViewer);
assert(
  Boolean(inverseVarMatch),
  "缩放预览的逆比例变量必须收敛在 ZOOM_PREVIEW_INVERSE_VAR 这一个常量上（写它的一处、读它的在 CSS）。",
);
const inverseVarName = inverseVarMatch ? inverseVarMatch[1] : "";
assert(
  styles.includes(`var(${inverseVarName}, 1)`),
  `PDFViewer.css 必须用 var(${inverseVarName}, 1) 做页流内 UI chrome 的抵消 —— CSS 缺了这一条，批注卡在缩放预览期间会被页流的 transform 一起抻大。`,
);
assert(
  styles.includes(".pdf-flow-ui-chrome") && styles.includes("transform:scale("),
  "页流内 UI chrome 的抵消规则必须是一个可挂载的类（新加页流内定尺寸 UI 时要能挂上它）。",
);
assert(
  companionCardView.includes("pdf-flow-ui-chrome"),
  "伴读批注卡必须挂上 .pdf-flow-ui-chrome：它 264px 定宽 + CSS px 字号，不抵消就会被缩放预览抻大（读者报的「伴读气泡随右键缩放放大」）。",
);
assert(
  /transformOrigin:\s*placement\.side === "right" \? "top right" : "top left"/.test(strippedPdfViewer),
  "抵消的变形原点必须与被钉住的那条边对齐（右侧卡 top right / 左侧卡 top left）；原点挂反了卡片会从贴边处整体滑开。",
);

// transform / origin / 逆比例必须成对：写在一处、清在两处，且都不许裸写 flow.style。
const previewBodyStart = strippedPdfViewer.indexOf("const applyZoomPreview = useCallback(");
const previewBodyEnd = strippedPdfViewer.indexOf("useLayoutEffect(() => {", previewBodyStart);
const previewBodyRaw = strippedPdfViewer.slice(previewBodyStart, previewBodyEnd);
assert(
  previewBodyStart > 0 && previewBodyRaw.includes("applyZoomPreviewScale(flow, visualScale, anchor.originX, anchor.originY)"),
  "applyZoomPreview 必须走 applyZoomPreviewScale 这个唯一入口 —— 它同时写下 transform 与逆比例，漏掉任一个都不会报错（漏 transform 页面不缩放，漏逆比例批注卡被抻大）。",
);
assert(
  !previewBodyRaw.includes("flow.style.transform"),
  "applyZoomPreview 里不允许再裸写 flow.style.transform：裸写就绕过了逆比例的成对维护。",
);
assert(
  previewBodyRaw.includes("ZOOM_PREVIEW_INVERSE_VAR") === false,
  "逆比例变量名只能在 helper 里引用，不要在 applyZoomPreview 里重复一次。",
);
const releaseStart = strippedPdfViewer.indexOf("const releaseLockedZoomPage = useCallback(");
const releaseEnd = strippedPdfViewer.indexOf("const handleFirstPagePainted", releaseStart);
const releaseBody = strippedPdfViewer.slice(releaseStart, releaseEnd);
assert(
  releaseStart > 0 && releaseBody.includes("clearZoomPreviewScale(flow)"),
  "手势结束必须走 clearZoomPreviewScale(flow) 把 transform / origin / 逆比例三者一起清掉 —— 只清 transform 会让批注卡留在一个被抵消的尺寸上。",
);
assert(
  !releaseBody.includes("flow.style.transform"),
  "releaseLockedZoomPage 里不允许裸清 flow.style.transform：只清 transform 会留下过期的逆比例。",
);

// ⑤ 右键按住 + 滚轮是**缩放**手势，不能因为 `moved` 为假就被当成「原地点击」弹菜单。
// 判据：松手时的开菜单条件必须同时排除「平移过」与「缩放过」。
const shouldOpenMenuLine = /const shouldOpenMenu = [^;]+;/.exec(strippedPdfViewer);
assert(
  Boolean(shouldOpenMenuLine),
  "找不到 endRightGesture 里的 shouldOpenMenu 判据 —— 契约锚点失效，请先确认它没有被改名。",
);
const shouldOpenMenuCode = (shouldOpenMenuLine ? shouldOpenMenuLine[0] : "").replace(/\s+/g, " ");
assert(
  shouldOpenMenuCode.includes("!zoomChangedDuringGesture"),
  `「松手是否弹右键菜单」必须同时排除「这次手势缩放过」—— 滚轮不移动指针，只看 moved 会把每一次缩放都判成原地点击（实测：右键滚 3 拍，松手后菜单必开）。当前判据：${shouldOpenMenuCode}`,
);
assert(
  strippedPdfViewer.includes("zoomAtStart: zoomTargetRef.current"),
  "缩放基线（zoomAtStart）必须在 pointerdown 时记录 —— 判据若恒为 null，「缩放过」这条永远不成立，等于没修。",
);
assert(
  strippedPdfViewer.includes("Math.abs(zoomTargetRef.current - right.zoomAtStart) > 0.5"),
  "「缩放过」要按缩放**目标的变化量**判定：三条缩放入口（右键滚轮 / 捏合 / pinch 引擎）最终都落在 zoomTargetRef，比逐个入口打标记少漏一处。",
);

// ⑥ 波浪线 effect 无事可画时必须整体早退：`setGroups([])` 会进 #render()，
//    而 #render() 第一件事是 #restoreText()（整页 text div 重写）。
assert(
  pageCanvasCode.includes('stoppedAt: "nothing-to-draw"') &&
    pageCanvasCode.includes("if (wavyItems.length === 0 && activeAssistRangesRef.current.length === 0)"),
  "波浪线 effect 必须有无事可画时的早退分支：空集重复 setGroups 会把整页 text div 重写一遍，而它恰好集中在「翻页 → 渲染」这条滚动路径上。",
);
assert(
  pageCanvasCode.includes("renderedWavyRef"),
  "早退必须用 renderedWavyRef 区分「由有到无」与「一直都没有」—— 否则删掉标注后波浪线会留在纸上（setGroups 不自动重绘）。",
);
assert(
  pageCanvasCode.includes("marker.setGroups([])"),
  "「由有到无」那一次仍必须真的清一次，不能因为早退就把擦除也跳过去。",
);
// 渲染路径上不许再预先测量整层 span。这一条**不需要**单独写一句负断言：
// 它已经严格包含在上面「只允许一处」的计数断言里（多处一次调用盘就红了），
// 再写一条永远不会先触发的负断言只是重复，而重复的守卫会被读成「两条都在管」。
// 这里只在计数断言的文案里点明它的第二种失败模式（见上面 bareSpanReads 的说明）。

// ⑦ 侧栏缩略图的 `<canvas>` 只准在视口附近挂载（2026-10-10）。
//
// 背景：200 页文档里 200 个 `<canvas>` 常驻就是连续滚动残余 12% 慢帧的主因。
// `content-visibility: auto` 挡不住 —— 它能丢弃普通子树的布局与绘制，
// 但**丢弃不了 canvas 的后备缓冲**（浏览器不能把你画好的内容扔掉，否则滚回来就空了）。
//
// 实测（同会话背靠背 A/B，WebKit，轻量 200 页夹具）：
//   缩略图整体 display:none → ⑥ 段连续滚动慢帧 44/360(12.2%) → 2/360(0.6%)
//   真改成「视口 ±240px 内才挂载」→ 4/360(1.1%)，canvas 元素数 204 → 10
// 这三条断言守的就是那个机制，去掉任何一条都会静默退回到 200 个常驻 canvas。
assert(
  pageThumbnailView.includes("const showCanvas = nearView || active;"),
  "缩略图 canvas 的挂载开关必须是 `nearView || active`：`active` 保证当前页随时可见，`nearView` 保证离得远就卸载。",
);
assert(
  pageThumbnailView.includes("{showCanvas ? (") && pageThumbnailView.includes("<canvas ref={canvasRef}"),
  "canvas 元素必须真的**条件挂载**（`{showCanvas ? <canvas …/> : null}`）。写成 `style.display` 或 `hidden` 都留住了后备缓冲，等于没改。",
);
assert(
  pageThumbnailView.includes("if (!showCanvas) {") && pageThumbnailView.includes("setReady(false);"),
  "canvas 被卸载时必须撤掉 ready：否则重进的瞬间会露出一个「空的却以为已画好」的白框。",
);
// 已渲染守卫：钥匙 + **节点身份**都必须对上。
//
// 这不是风格问题，是 2026-10-10 真实踩到的 bug：守卫原来写 `canvas.width > 1`，
// 而**新建 canvas 的默认 width 恰好就是 300** —— 于是「卸载后重挂载」的新 canvas
// 让守卫成立 → 直接 setReady(true) 却一帧没画 → 缩略图变空白。
// 这个 bug 只有「滚远再滚回」才暴露，静态看代码完全合理。
assert(
  pageThumbnailView.includes("renderedCanvasRef.current === canvas"),
  "已渲染守卫必须比 canvas **节点身份**，不能只看 `canvas.width`：新建 canvas 默认 width=300，会让「重挂载后一帧没画」误判成已渲染。",
);
assert(
  !pageThumbnailView.includes("canvas.width > 1"),
  "`canvas.width > 1` 不能作为「已渲染」判据：默认 canvas 就是 300×150，这个条件对新 canvas 恒真。",
);
// 双向可见性上报：只报「进入」的话，canvas 永远只进不出，等于回到常驻。
assert(
  pdfViewerCodeView.includes("thumbnailVisibilityHandlersRef.current.get(pageNo)?.(entry.isIntersecting)"),
  "共享 IntersectionObserver 必须把 `entry.isIntersecting` **双向**透传（进入与离开都上报），否则「离得远就卸载」永远不会触发。",
);
assert(
  pdfViewerCodeView.includes("useRef<Map<number, (visible: boolean) => void>>"),
  "缩略图可见性回调表的签名必须带 `visible: boolean`：无参回调只能表达「进入」。",
);
assert(
  pageThumbnailView.includes("onVisibility") && pageThumbnailView.includes("setNearView(visible)"),
  "PageThumbnail 必须把可见性回调接成 setNearView(visible)，而不是只 setInView(true)。",
);

console.log("pdf-virtualization: ok");
