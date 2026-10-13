/**
 * 单页画布：PDF 渲染 + 文字层 + 链接层 + 阅读辅助块。
 * 从 PDFViewer.tsx 拆出（原 1241-1751 行）—— 它是全仓最长的一段组件逻辑
 * （渲染任务调度 / 资源扫描超时 / 文本层几何缓存），与主体 UI 无关。
 */
import { memo, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PdfReadingBlock, ReaderAnnotation } from "../../types";
import { buildDomPdfReadingBlocks } from "../../services/pdfBlocks";
import type { ReadingAssistSelection } from "../ReadingAssistMenu";
import {
  acquireScratchCanvas,
  activeCanvasRenders,
  cancelAndAwaitCanvasRender,
  collectPdfParagraphSpansFromTarget,
  getBlockHit,
  getNormalizedSpanGroupRect,
  getPdfSpanAtPoint,
  getPdfTextLayerGeometry,
  getPdfTextSpans,
  hasPdfTextLayerGeometryResized,
  mergeDomPdfReadingBlocks,
  resolveOutlinePage,
  shiftPdfTextSpans,
  textFromPdfSpans,
  trackCanvasRender,
  type CanvasRenderTask,
  type PdfTextLayerGeometry,
  type PdfTextSpan,
} from "./readerCore";
import {
  TextLayerMarker,
  clientRectFromRanges,
  collectBlockSpansByLines,
  rangesFromSpans,
  type TextRangeGroup,
} from "./textLayerMarker";

/** 段落激活底色的 class 前缀。与 PDFViewer.css 的 `.r0nix-marker-active` 成对。 */
export const MARKER_ACTIVE_CLASS = "r0nix-marker-active";

/**
 * 波浪线的 class 前缀。每条标注一个后缀（`-{annotation.id}`），
 * 这样多条 AI 标记可以同时存在且各自独立增删。
 */
export const MARKER_WAVY_CLASS = "r0nix-marker-wavy";

export interface PageCanvasProps {
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
  onOpenLinkInApp?: (url: string) => void;
  /**
   * PDF 内部链接（GoTo 目标）被点击时要跳到的页码。
   *
   * 必须由调用方提供：只有上层才知道「跳页」在本应用里意味着什么
   * （滚动到哪一页、要不要记录历史）。不给就不响应内部跳转。
   */
  onNavigateToPage?: (pageNo: number) => void;
  onAssistSelection?: (selection: Omit<ReadingAssistSelection,"id" |"sourceTitle">) => void;
  onReadingBlocks?: (pageNo: number, blocks: PdfReadingBlock[]) => void;
  structuredBlocks?: PdfReadingBlock[];
  structuredBlocksVersion?: number;
  onPageLinks?: (pageNo: number, links: Array<{ url: string }>) => void;
  onPageRendered?: (pageNo: number, renderZoomScale: number) => void;
  /**
   * 首次把纸面画出来时上报一次。
   *
   * 存在的理由：`loading` 状态之前等的是目录解析（`getOutline`），那跟页面上没画东西
   * 是两回事 —— 目录秒回，canvas 还在渲染，于是纸面空白且没有任何加载提示。
   * 让「首屏画出来了」这个真实信号来收掉加载态，空白期才有东西可看。
   */
  onFirstPagePainted?: (pageNo: number) => void;
  /**
   * 把本页的 `TextLayerMarker` 交给上层。
   *
   * AI 波浪线标注必须画在 **text layer 内部**（跟着每个片段的基线），
   * 而 marker 只有拿到 `TextLayerBuilder` 在 render 时算好的 `textDivs` 映射才可用。
   * 上层拿不到这个映射，就只能退回「按段落矩形画覆盖 div」—— 那正是波浪线
   * 贴在整段底部、双栏糊成一片的根因。所以这里把实例透出去，而不是让上层
   * 反过来去猜 DOM。
   */
  onTextLayerMarker?: (pageNo: number, marker: TextLayerMarker | null) => void;
  /**
   * 本页要画成波浪线的标注。key 用 `annotation.id`。
   *
   * 上层传标注、这里翻成区间 —— 因为只有本页的 marker 知道这些标注的
   * `rect` 该落到哪几个 div 上，这个换算没法在父组件做。
   */
  wavyAnnotations?: ReaderAnnotation[];
  /** 波浪线随标注变化而重画的版本号。 */
  wavyAnnotationsVersion?: number;
}

export const PageCanvas = memo(function PageCanvas({
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
  onOpenLinkInApp,
  onNavigateToPage,
  onAssistSelection,
  onReadingBlocks,
  structuredBlocks = [],
  structuredBlocksVersion = 0,
  onPageLinks,
  onPageRendered,
  onFirstPagePainted,
  onTextLayerMarker,
  wavyAnnotations = [],
  wavyAnnotationsVersion = 0,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textHostRef = useRef<HTMLDivElement | null>(null);
  const linkHostRef = useRef<HTMLDivElement | null>(null);
  const linkTokenRef = useRef(0);
  /** 当前挂在 DOM 上的 pdf.js AnnotationLayerBuilder，重渲染/卸载时要 cancel。 */
  const annotationLayerRef = useRef<{ cancel: () => void } | null>(null);
  /**
   * 跳页回调用 ref 持有，不写进 effect 依赖：父组件很可能传的是内联箭头函数，
   * 一旦进依赖，每次渲染都会重跑整个渲染 effect（画布重绘 + 重扫注释）。
   */
  const navigateToPageRef = useRef(onNavigateToPage);
  navigateToPageRef.current = onNavigateToPage;
  /**
   * 通知型回调一律用 ref 持有，**不进渲染 effect 的依赖**。
   *
   * 理由不是洁癖：父组件传内联箭头函数时，它的身份每次父组件渲染都变，
   * 一旦进依赖，整个渲染 effect（画布重绘 + 文本层重建）就会跟着重跑。
   * 实测（2026-10-05）：`onOpenLinkInApp` 是 App 里的内联箭头，导致**静置状态下
   * 文本层每秒被重建 8 次**，读者刚划出来的选中会在 120ms 内被下一次重建吃掉 ——
   * 表现就是「看得见、选不中，且没有任何报错」。
   *
   * 它们是「通知」，不是「渲染输入」：effect 该在数据变化时跑，不该在
   * 调用方换了同义函数时跑。
   */
  const notifyRef = useRef({ onError, onOpenExternal, onOpenLinkInApp, onPageLinks, onPageRendered, onFirstPagePainted, onReadingBlocks, onSize, onTextLayerMarker });
  notifyRef.current = { onError, onOpenExternal, onOpenLinkInApp, onPageLinks, onPageRendered, onFirstPagePainted, onReadingBlocks, onSize, onTextLayerMarker };
  const activeAssistSpansRef = useRef<HTMLElement[]>([]);
  const activeAssistBlockRef = useRef<PdfReadingBlock | null>(null);
  const textSpanCacheRef = useRef<PdfTextSpan[] | null>(null);
  const textSpanGeometryRef = useRef<PdfTextLayerGeometry | null>(null);
  const paragraphCacheRef = useRef<WeakMap<HTMLElement, HTMLElement[]>>(new WeakMap());
  const activeAssistGroupRef = useRef<HTMLElement[]>([]);
  /** 当前激活段落对应的区间。锚点定位用它，见 onClick 内的注释。 */
  const activeAssistRangesRef = useRef<TextRangeGroup["ranges"]>([]);
  /**
   * 上一轮波浪线渲染**是否真的画了东西**。
   *
   * 用来把「由有到无」与「一直都没有」分开：`setGroups([])` 不是空操作
   * （见 renderWavyAnnotations 里早退那一段），但删掉标注之后必须清一次，
   * 否则线会留在纸上 —— `setGroups` 由外部驱动，没有「每次都重画」的语义。
   */
  const renderedWavyRef = useRef(false);
  const readingBlocksRef = useRef<PdfReadingBlock[]>([]);
  const structuredBlocksRef = useRef<PdfReadingBlock[]>(structuredBlocks);
  /**
   * text layer 标注器。每页一个实例，跟着文本层生命周期走。
   *
   * 刻意与 `textLayerRef` 分开：builder 会在缩放时复用同一个 div（只 `update()`），
   * 而 marker 的 DOM 映射在 `update()` 后仍然有效，所以 marker 比 builder 活得久。
   */
  const markerRef = useRef<TextLayerMarker>(new TextLayerMarker());
  const wavyAnnotationsRef = useRef<ReaderAnnotation[]>(wavyAnnotations);
  wavyAnnotationsRef.current = wavyAnnotations;
  const textLayerRef = useRef<{
    pageNo: number;
    div: HTMLDivElement;
    render: (params: { viewport: unknown }) => Promise<void>;
    show: () => void;
    hide: () => void;
    cancel: () => void;
  } | null>(null);
  const tokenRef = useRef(0);
  const textLayerScaleObserverRef = useRef<ResizeObserver | null>(null);
  const hasPaintedRef = useRef(false);
  /**
   * 本组件是否还没上报过任何一次绘制。
   *
   * 只在**首次绘制**时触发 `onFirstPagePainted`，之后所有翻页、重渲染都不再触发 ——
   * 否则每翻一页都会重新点亮加载态，纸面反复闪白。
   *
   * 组件不随文档卸载复用，所以这个 ref 的生命周期天然等于「这一页实例的首次绘制」。
   */
  const isFirstPageRef = useRef(true);
  const paintedDocRef = useRef<PDFDocumentProxy | null>(null);
  /**
   * DEV 诊断探针总开关（**长期保留**，2026-10-09 用户裁决）。
   * 波浪线渲染的 `window.__r0nixWavyProbe`（按页分键：markerReady/spanCount/
   * groupCount/rangeCount/rects…）从这里取电 —— 它是「数据里有、纸上看不见」
   * 这类几何断层的标准排查入口（2026-10-08 波浪线全灭事故靠它三层定位）。
   * 生产构建（import.meta.env.DEV=false）下全部探针零开销，不会泄漏到用户侧。
   */
  const DEV_PROBE = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const [status, setStatus] = useState<"idle" |"rendering" |"ready">("idle");
  const [textLayerVersion, setTextLayerVersion] = useState(0);

  /**
   * 取本页文本层的 span 几何（**唯一入口**，带「平移复用」的缓存）。
   *
   * 为什么不能各处直接 `getPdfTextSpans(textLayer)`：
   * `getPdfTextSpans` 会对**每一个 span** 调一次 `getBoundingClientRect`，而每一次
   * 都是强制同步布局（flush）。200 页文档实测：滚动 6 秒里量了 29,000 次、合计 924ms，
   * 而同期慢帧相对基线的超额总量≈900ms —— 也就是说这一条就吃掉了全部顿挫。
   * 它在 Chromium 上不显形（同样 37k 次只要 187ms），在 WebKit（= Tauri 的
   * WKWebView）上单次最贵到 10ms，于是同一份代码「Chromium 满帧、WebKit 掉 20%」。
   *
   * 关键在于**缓存的失效判据**。旧判据（`hasPdfTextLayerGeometryChanged`）把
   * `left/top` 也算进去，而那是视口坐标 —— 滚动时每帧都变，缓存于是被结构性打废，
   * 任何一次取用都要把整层重量一遍。而 `left/top` 变了只说明「整层平移」，
   * span 之间的相对几何没变：平移直接搬运缓存即可，只有**尺寸**变了才是真重排。
   *
   * 顺带把两个入口合并成一个：以前悬停路径（setActiveFromPoint）有缓存，
   * 波浪线 effect 却是裸调用 —— 后者每次父组件渲染都重建文本层的 span 数组。
   */
  const readTextSpans = (textLayer: HTMLElement): PdfTextSpan[] => {
    const geometry = getPdfTextLayerGeometry(textLayer);
    const previous = textSpanGeometryRef.current;
    if (hasPdfTextLayerGeometryResized(previous, geometry)) {
      // 真重排：整层 span 的几何都得重新量（缩放 / 换文档 / 排版变化）。
      textSpanCacheRef.current = null;
      paragraphCacheRef.current = new WeakMap();
    } else if (
      textSpanCacheRef.current &&
      previous &&
      (previous.left !== geometry.left || previous.top !== geometry.top)
    ) {
      // 只平移（滚动）：搬缓存，不量 DOM。
      textSpanCacheRef.current = shiftPdfTextSpans(
        textSpanCacheRef.current,
        geometry.left - previous.left,
        geometry.top - previous.top,
      );
    }
    textSpanGeometryRef.current = geometry;
    const spans = textSpanCacheRef.current ?? getPdfTextSpans(textLayer);
    textSpanCacheRef.current = spans;
    return spans;
  };

  useEffect(() => {
    const host = textHostRef.current;
    if (
      !host ||
      !enableTextLayer ||
      !enableAssistBlocks ||
      !onAssistSelection ||
      status !=="ready" ||
      textLayerVersion === 0
    )
      return;

    const marker = markerRef.current;

    const clearActive = () => {
      activeAssistSpansRef.current = [];
      activeAssistGroupRef.current = [];
      activeAssistRangesRef.current = [];
      activeAssistBlockRef.current = null;
      // 只撤激活底色。波浪线是常驻标注，不能被划词悬停一起带走 ——
      // 否则读者鼠标一扫，整页的 AI 标记就全消失了。
      marker.removeClass(MARKER_ACTIVE_CLASS);
    };

    /**
     * 取指针所在**段落**的 span 集合。
     *
     * 这是「选中一段带入邻段」的修复点。旧实现走
     * `collectPdfParagraphSpansFromTarget` 的几何启发式（量行距/缩进/句号），
     * 在双栏论文上必然误判；现在优先用 `PdfReadingBlock.lines`（pymupdf
     * `get_text("dict")` 的 `lines[].bbox`）反查文本层 span，判定用中心点命中。
     *
     * 没有 `lines` 的块（markdown 来源、老数据）才退回启发式。
     */
    const resolveParagraphGroup = (
      span: HTMLElement,
      block: PdfReadingBlock | null,
      spans: PdfTextSpan[],
      layer: HTMLElement,
    ): HTMLElement[] => {
      const cached = paragraphCacheRef.current.get(span);
      if (cached) return cached;

      let group: HTMLElement[] = [];
      if (block?.lines?.length) {
        const layerRect = layer.getBoundingClientRect();
        const members = collectBlockSpansByLines(
          spans.map(({ node, rect }) => ({ node, rect })),
          block.lines,
          layerRect,
        );
        group = members.map((item) => item.node);
      }
      if (group.length === 0) {
        group = collectPdfParagraphSpansFromTarget(span, spans);
      }
      paragraphCacheRef.current.set(span, group);
      return group;
    };

    const setActiveFromPoint = (
      clientX: number,
      clientY: number,
      eventTarget?: EventTarget | null,
    ): { text: string; block: PdfReadingBlock | null } => {
      const textLayer = host.querySelector(".textLayer");
      if (!(textLayer instanceof HTMLElement)) return { text:"", block: null };
      // 几何缓存与失效判据统一走 readTextSpans（见它的注释：滚动不该打废缓存）。
      const spans = readTextSpans(textLayer);
      // PDF.js already dispatches pointer events from the real text span. Use
      // that target on the hot path; geometry lookup is only needed over the
      // small gaps between transparent text spans.
      const targetSpan = eventTarget instanceof HTMLElement ? eventTarget.closest("span") : null;
      const span =
        targetSpan && textLayer.contains(targetSpan)
          ? targetSpan
          : getPdfSpanAtPoint(textLayer, clientX, clientY, spans);
      if (!(span instanceof HTMLElement)) return { text:"", block: null };
      const block = getBlockHit(span, readingBlocksRef.current, textLayer) || null;
      // 段落成员一律走行级 bbox 切分。这里**不再**用
      // `collectPdfBlockSpans`（按块并集框收 span）—— 那会把整栏/整块都收进来，
      // 正是「整段误选」的第二个来源。
      const group = resolveParagraphGroup(span, block, spans, textLayer);
      if (group.length === 0) return { text:"", block: null };
      const sameActiveGroup =
        activeAssistGroupRef.current.length === group.length &&
        activeAssistGroupRef.current.every((node, index) => node === group[index]);
      const text = textFromPdfSpans(group) || block?.text || "";
      if (sameActiveGroup) {
        return { text, block };
      }
      clearActive();
      activeAssistSpansRef.current = group;
      activeAssistGroupRef.current = group;
      activeAssistBlockRef.current = block;
      // 整段激活：判定矩形取整组的包围盒。组是按行级 bbox 认领出来的，
      // 成员本就属于同一段，所以这里用并集框不会引入邻段。
      const groupRects = group.map((node) => node.getBoundingClientRect());
      const groupBox = groupRects.length
        ? {
            left: Math.min(...groupRects.map((item) => item.left)),
            top: Math.min(...groupRects.map((item) => item.top)),
            right: Math.max(...groupRects.map((item) => item.right)),
            bottom: Math.max(...groupRects.map((item) => item.bottom)),
          }
        : null;
      const activeGroup = groupBox
        ? rangesFromSpans(
            marker,
            group.map((node, index) => ({ node, rect: groupRects[index] })),
            groupBox,
            MARKER_ACTIVE_CLASS,
          )
        : { className: MARKER_ACTIVE_CLASS, ranges: [] };
      activeAssistRangesRef.current = activeGroup.ranges;
      marker.setGroups([activeGroup]);
      return { text, block };
    };

    let moveFrame: number | null = null;
    let pendingPoint: { x: number; y: number } | null = null;
    let pendingTarget: EventTarget | null = null;
    const onPointerMove = (event: PointerEvent) => {
      pendingPoint = { x: event.clientX, y: event.clientY };
      pendingTarget = event.target;
      if (moveFrame !== null) return;
      moveFrame = window.requestAnimationFrame(() => {
        moveFrame = null;
        const point = pendingPoint;
        const target = pendingTarget;
        pendingPoint = null;
        pendingTarget = null;
        if (point) setActiveFromPoint(point.x, point.y, target);
      });
    };
    const onPointerLeave = () => {
      pendingPoint = null;
      pendingTarget = null;
      if (moveFrame !== null) window.cancelAnimationFrame(moveFrame);
      moveFrame = null;
      clearActive();
    };
    const onClick = (event: MouseEvent) => {
      const hit = setActiveFromPoint(event.clientX, event.clientY, event.target);
      const text = hit.text;
      if (!text) return;
      const textLayer = host.querySelector(".textLayer");
      const layer = textLayer instanceof HTMLElement ? textLayer : null;
      // 锚点取**实际命中片段**的包围盒，而不是段落 rect 的并集框。
      // 并集框的右上角是版心里的空白，锚点挂上去会飘到段落外侧，
      // 表现为「点星星弹出的解释是别处的」。
      const hitRect = clientRectFromRanges(marker, activeAssistRangesRef.current ?? []);
      const sourceRect =
        layer && hitRect
          ? getNormalizedSpanGroupRect(activeAssistSpansRef.current, layer)
          : hit.block?.rect;
      const anchorPoint = hitRect
        ? { x: hitRect.left + hitRect.width / 2, y: hitRect.bottom + 8 }
        : { x: event.clientX + 10, y: event.clientY - 10 };
      event.preventDefault();
      event.stopPropagation();
      onAssistSelection({
        text,
        reference:`page ${pageNo}`,
        page: pageNo,
        blockId: hit.block?.id,
        sourceRect,
        ...anchorPoint,
      });
    };

    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);
    host.addEventListener("click", onClick, true);
    return () => {
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
      host.removeEventListener("click", onClick, true);
      if (moveFrame !== null) window.cancelAnimationFrame(moveFrame);
      clearActive();
    };
  }, [enableAssistBlocks, enableTextLayer, onAssistSelection, pageNo, status, textLayerVersion]);

  /**
   * AI 波浪线标注 → text layer 内的行内波浪线。
   *
   * 为什么标注由上层传进来、这里才画：只有本页 marker 知道 `annotation.rect`
   * 该落到哪几个 `divIdx` 上。这个换算依赖 `TextLayerBuilder` 在 render 时算好的
   * `textDivs`，父组件拿不到，所以「标注 → 区间」这一步只能留在本页。
   *
   * 每次都**全量重算**而不是增量打标：marker 的切分是破坏性的（要重排文本节点），
   * 增量更新得维护上一轮的区间状态，而标注总量是每页个位数 —— 全量重算的
   * 成本远低于把状态机写对的成本。
   */
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker.ready) {
      if (DEV_PROBE) {
        const probeStore = (window as unknown as Record<string, unknown>).__r0nixWavyProbe as Record<string, unknown> | undefined;
        const store = probeStore && typeof probeStore === "object" ? probeStore : {};
        store[String(pageNo)] = { stoppedAt: "marker-not-ready", markerDivCount: marker.divCount() };
        (window as unknown as Record<string, unknown>).__r0nixWavyProbe = store;
      }
      return;
    }
    const textLayer = textHostRef.current?.querySelector(".textLayer");
    if (!(textLayer instanceof HTMLElement)) {
      if (DEV_PROBE) {
        const probeStore = (window as unknown as Record<string, unknown>).__r0nixWavyProbe as Record<string, unknown> | undefined;
        const store = probeStore && typeof probeStore === "object" ? probeStore : {};
        store[String(pageNo)] = { stoppedAt: "text-layer-not-found" };
        (window as unknown as Record<string, unknown>).__r0nixWavyProbe = store;
      }
      return;
    }
    /**
     * ★ 无事可画就整体早退 —— **`setGroups([])` 不是空操作**。
     *
     * `setGroups()` 无论传什么都会进 `#render()`，而 `#render()` 的第一件事是
     * `#restoreText()`：把本页**每一个** text div 的 `textContent` 与 `className`
     * 重写一遍（每页 60–200 次 DOM 写入，外加一次整页文本失效）。
     *
     * 成本为什么落在滚动上：本 effect 依赖 `status` 与 `textLayerVersion`，
     * 而这两个值在**渲染任何一页**的过程中都要变好几轮（idle→rendering→ready、
     * 文本层版本 0→1→…）。于是每渲染一页就跑好几轮，其中绝大多数轮次这一页上
     * 一条波浪线都没有 —— 那些轮次的整页重写是纯浪费，且恰好集中在
     * 「滚动 → 翻页 → 渲染」这条路径上，也就是读者感觉最卡的时候。
     *
     * 保留「上一轮画过就清一次」：删掉标注后必须把线擦掉，所以只在**由有到无**
     * 的那一次调 `setGroups([])`，之后就一直早退。
     */
    const wavyItems = wavyAnnotationsRef.current.filter(
      (annotation) => annotation.kind === "wavy" && annotation.rect && annotation.rect.width > 0 && annotation.rect.height > 0,
    );
    if (wavyItems.length === 0 && activeAssistRangesRef.current.length === 0) {
      if (renderedWavyRef.current) {
        renderedWavyRef.current = false;
        marker.setGroups([]);
      }
      if (DEV_PROBE) {
        const probeStore = (window as unknown as Record<string, unknown>).__r0nixWavyProbe as Record<string, unknown> | undefined;
        const store = probeStore && typeof probeStore === "object" ? probeStore : {};
        // 沿用既有 `stoppedAt` 约定：这一段本身也是「排查时最想知道的一句话」——
        // 「这一页没画」到底是没数据、还是被有意跳过了。
        store[String(pageNo)] = {
          stoppedAt: "nothing-to-draw",
          markerReady: marker.ready,
          markerDivCount: marker.divCount(),
        };
        (window as unknown as Record<string, unknown>).__r0nixWavyProbe = store;
      }
      return;
    }

    const layerRect = textLayer.getBoundingClientRect();
    if (layerRect.width <= 0 || layerRect.height <= 0) {
      if (DEV_PROBE) {
        const probeStore = (window as unknown as Record<string, unknown>).__r0nixWavyProbe as Record<string, unknown> | undefined;
        const store = probeStore && typeof probeStore === "object" ? probeStore : {};
        store[String(pageNo)] = { stoppedAt: "layer-rect-zero", layerRect: { w: layerRect.width, h: layerRect.height } };
        (window as unknown as Record<string, unknown>).__r0nixWavyProbe = store;
      }
      return;
    }
    const spans = readTextSpans(textLayer);

    const groups: TextRangeGroup[] = [];
    const debugRects: unknown[] = [];
    for (const annotation of wavyItems) {
      const rect = annotation.rect;
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
      // 归一化矩形 → 客户端坐标。判定在 rangesFromSpans 里做（中心点命中），
      // 这里只负责换算坐标系。
      const clientRect = {
        left: layerRect.left + rect.x * layerRect.width,
        top: layerRect.top + rect.y * layerRect.height,
        right: layerRect.left + (rect.x + rect.width) * layerRect.width,
        bottom: layerRect.top + (rect.y + rect.height) * layerRect.height,
      };
      if (DEV_PROBE) {
        debugRects.push({
          rect,
          clientRect,
          layerTop: layerRect.top,
          layerLeft: layerRect.left,
          spanCenters: spans.slice(0, 4).map((span) => ({
            cx: span.rect.left + span.rect.width / 2,
            cy: span.rect.top + span.rect.height / 2,
            text: span.node.textContent?.slice(0, 20) ?? "",
          })),
        });
      }
      groups.push(rangesFromSpans(marker, spans, clientRect, `${MARKER_WAVY_CLASS}-${annotation.id}`));
    }

    // 激活底色要跟着划词悬停走，不能被这一轮重绘抹掉。
    const active = activeAssistRangesRef.current;
    if (active.length) groups.push({ className: MARKER_ACTIVE_CLASS, ranges: active });
    // DEV 诊断探针：波浪线「存在数据却不显示」这类故障的每一环都可能断，
    // 而且全部静默（ready=false 时 setGroups 是空操作、ranges 空时 render 不画）。
    // 把每一环的实际值暴露给 e2e / 现场排查，别让下一次诊断再从零猜起。
    if (DEV_PROBE) {
      const probeStore = (window as unknown as Record<string, unknown>).__r0nixWavyProbe as Record<string, unknown> | undefined;
      const store = probeStore && typeof probeStore === "object" ? probeStore : {};
      store[String(pageNo)] = {
        markerReady: marker.ready,
        markerDivCount: marker.divCount(),
        spanCount: spans.length,
        firstSpanIndexed: spans[0] ? marker.indexOf(spans[0].node) : null,
        groupCount: groups.length,
        rangeCount: groups.reduce((sum, group) => sum + group.ranges.length, 0),
        rects: debugRects,
      };
      (window as unknown as Record<string, unknown>).__r0nixWavyProbe = store;
    }
    marker.setGroups(groups);
    // 记住「这一轮真画了」，供下一次早退判据使用（见 renderedWavyRef）。
    renderedWavyRef.current = groups.length > 0;
  }, [status, textLayerVersion, wavyAnnotations, wavyAnnotationsVersion]);

  /** 文本层就绪后把 marker 交给上层，供伴读锚点定位与波浪线渲染使用。 */
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker.ready) {
      notifyRef.current.onTextLayerMarker?.(pageNo, null);
      return;
    }
    notifyRef.current.onTextLayerMarker?.(pageNo, marker);
    return () => {
      notifyRef.current.onTextLayerMarker?.(pageNo, null);
    };
  }, [pageNo, status, textLayerVersion]);

  useEffect(() => {
    structuredBlocksRef.current = structuredBlocks;
    const textLayer = textLayerRef.current?.div;
    if (!textLayer || !enableAssistBlocks) return;
    const domBlocks = buildDomPdfReadingBlocks(textLayer, pageNo);
    readingBlocksRef.current = mergeDomPdfReadingBlocks(domBlocks, structuredBlocks);
    setTextLayerVersion((value) => value + 1);
  }, [enableAssistBlocks, pageNo, structuredBlocks, structuredBlocksVersion]);

  useEffect(() => {
    if (!doc) {
      setStatus("idle");
      setTextLayerVersion(0);
      hasPaintedRef.current = false;
      paintedDocRef.current = null;
      textSpanCacheRef.current = null;
      textSpanGeometryRef.current = null;
      paragraphCacheRef.current = new WeakMap();
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
      if (textHostRef.current) textHostRef.current.innerHTML ="";
      return;
    }

    let cancelled = false;
    let renderTask: CanvasRenderTask | null = null;
    let page: PDFPageProxy | null = null;
    if (paintedDocRef.current !== doc) {
      hasPaintedRef.current = false;
      paintedDocRef.current = doc;
    }
    const token = ++tokenRef.current;
    setStatus("idle");
    textLayerRef.current?.cancel();
    textLayerRef.current = null;
    textHostRef.current?.replaceChildren();
    setTextLayerVersion(0);
    textSpanCacheRef.current = null;
    textSpanGeometryRef.current = null;
    paragraphCacheRef.current = new WeakMap();
    textLayerScaleObserverRef.current?.disconnect();
    textLayerScaleObserverRef.current = null;

    const run = async () => {
      // Keep inactive page shells as layout-only placeholders. Calling
      // getPage() before this gate defeats canvas virtualization and leaves
      // every page proxy alive during the initial render of a long PDF.
      if (!active) {
        setStatus("idle");
        textLayerRef.current?.hide();
        return;
      }

      page = await doc.getPage(pageNo);
      if (cancelled || token !== tokenRef.current) {
        // The effect cleanup can run while getPage() is still pending. In
        // that case`page` was null when cleanup ran, so dispose the late
        // PDFPageProxy here instead of leaking it during rapid page changes.
        page.cleanup();
        page = null;
        return;
      }

      const baseViewport = page.getViewport({ scale: 1 });
      notifyRef.current.onSize(pageNo, baseViewport.width, baseViewport.height);

      const renderViewport = page.getViewport({ scale: renderZoomScale });
      const visualViewport = renderViewport;

      const linkHost = linkHostRef.current;
      if (linkHost) {
        linkHost.innerHTML ="";
      }

      if (active && (linksEnabled || notifyRef.current.onPageLinks) && linkHost) {
        const tokenLinks = ++linkTokenRef.current;
        void (async () => {
          try {
            const annotations = await page.getAnnotations();
            if (cancelled || token !== tokenRef.current || tokenLinks !== linkTokenRef.current) return;
            const links: Array<{ url: string }> = [];
            for (const item of annotations as Array<Record<string, unknown>>) {
              if (item.subtype !=="Link") continue;
              const url = typeof item.url ==="string" ? item.url :"";
              if (url) links.push({ url });
            }
            notifyRef.current.onPageLinks?.(pageNo, links);

            if (!linksEnabled || !linkHost) return;

            // 命中区交给 pdf.js 官方 AnnotationLayer：坐标换算、外链、以及**内部
            // dest 跳转**都由库负责。
            // ⚠️ 这里以前是手写的：只认 `item.url`，而论文里的章节/参考文献跳转
            // 是纯 dest 内链（没有 url），会被 `if (!url) continue` 整条丢掉 ——
            // 表现就是「PDF 里的超链接点了没反应」。库同时支持两种，不要手写。
            const viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
            const AnnotationLayerBuilderCtor = viewerModule.AnnotationLayerBuilder as unknown as new (args: {
              pdfPage: unknown;
              linkService: unknown;
              renderForms: boolean;
              onAppend: (div: HTMLDivElement) => void;
            }) => {
              div: HTMLDivElement;
              render: (params: { viewport: unknown }) => Promise<void>;
              cancel: () => void;
            };
            const openLink = notifyRef.current.onOpenLinkInApp || notifyRef.current.onOpenExternal;
            const linkService = {
              externalLinkEnabled: Boolean(openLink),
              pagesCount: doc?.numPages ?? pageNo,
              page: pageNo,
              rotation: 0,
              isInPresentationMode: false,
              // 内部跳转：destination 解析成页码复用现成的 resolveOutlinePage
              // （书签跳转走的是同一条解析路径），不要另写一份。
              goToDestination: async (dest: unknown) => {
                if (!doc) return;
                const target = await resolveOutlinePage(doc, dest as Parameters<typeof resolveOutlinePage>[1]);
                if (target) navigateToPageRef.current?.(target);
              },
              goToPage: () => undefined,
              goToXY: () => undefined,
              addLinkAttributes: (link: HTMLAnchorElement, url: string) => {
                link.href = url;
                link.rel ="noopener noreferrer";
                // 外链走本仓已有的打开策略（受「在应用内打开链接」设置控制），
                // 不交给浏览器默认行为。
                if (openLink) {
                  link.onclick = (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openLink(url);
                    return false;
                  };
                } else {
                  link.target ="_blank";
                }
              },
              // 内链的 href 只是显示用：库在 onclick 里 return false，不会真的导航。
              getDestinationHash: () =>"#",
              getAnchorUrl: () =>"#",
              setHash: () => undefined,
              executeNamedAction: () => undefined,
              executeSetOCGState: () => undefined,
            };

            annotationLayerRef.current?.cancel();
            const overlay = document.createElement("div");
            overlay.className ="page-link-overlay";
            overlay.style.width =`${Math.ceil(visualViewport.width)}px`;
            overlay.style.height =`${Math.ceil(visualViewport.height)}px`;
            const builder = new AnnotationLayerBuilderCtor({
              pdfPage: page,
              linkService,
              renderForms: false,
              // ⚠️ `builder.div` 是 `render()` 里才创建的（构造函数里是 null）。
              // 先 appendChild(builder.div) 会拿到 undefined 并抛错，被下面 catch
              // 静默吞掉 —— 表现就是「注释层从来没出现过，链接照样点不动」。
              // 官方给的就是 onAppend 这个时机：div 一建好就交出来由宿主挂上。
              onAppend: (div: HTMLDivElement) => {
                overlay.appendChild(div);
                linkHost.replaceChildren(overlay);
              },
            });
            annotationLayerRef.current = builder;
            await builder.render({ viewport: visualViewport });
          } catch {
            // Link overlays are optional; a slow or malformed annotation must not block page paint.
          }
        })();
      }

      const canvas = canvasRef.current;

      if (!canvas) return;
      await cancelAndAwaitCanvasRender(canvas);
      if (cancelled || token !== tokenRef.current) return;

      setStatus("rendering");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // 暂存画布走池，不再每次新建整页位图（理由见 acquireScratchCanvas 的注释）。
      const { canvas: renderCanvas, release: releaseScratchCanvas } = await acquireScratchCanvas();
      try {
        const renderContext = renderCanvas.getContext("2d", { alpha: false });
        if (!renderContext) return;
        renderCanvas.width = Math.ceil(renderViewport.width * dpr);
        renderCanvas.height = Math.ceil(renderViewport.height * dpr);
        renderContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderContext.fillStyle = "#ffffff";
        renderContext.fillRect(0, 0, renderViewport.width, renderViewport.height);

        renderTask = page.render({
          canvasContext: renderContext,
          canvas: renderCanvas,
          viewport: renderViewport,
        }) as unknown as CanvasRenderTask;
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
      } finally {
        // 归还前必须确认 pdf.js 已经**停止写入**这张画布：取消发生在 band 之间，
        // 立刻归还的话下一张页可能正好在用同一张暂存画布，画面会串。
        if (renderTask) await renderTask.promise.catch(() => undefined);
        releaseScratchCanvas();
      }

      // Keep canvas visible regardless of text-layer availability.
      setStatus("ready");
      // The zoom lock protects the painted page geometry. Text-layer parsing
      // is an optional follow-up and must not keep neighboring pages hidden
      // when the canvas itself is already stable at the target scale.
      notifyRef.current.onPageRendered?.(pageNo, renderZoomScale);
      // 首屏加载态靠这条通知收尾。`onPageRendered` 承担不了这件事 ——
      // 它服务于缩放锁定，会因为「页面不是缩放锁定页」或「缩放档不匹配」而提前 return，
      // 拿它的返回值当加载完成信号会在正常路径上永远收不到。
      if (isFirstPageRef.current) {
        isFirstPageRef.current = false;
        notifyRef.current.onFirstPagePainted?.(pageNo);
      }

      // PDF.js 的文本层与注释层靠同一条 CSS 变量链定位，其中 --scale-factor 上游只在
      // PDFPageView.update() 且 _isStandalone 时注入；本项目只借用 TextLayerBuilder /
      // AnnotationLayerBuilder，所以必须自己补（链条定义见 PDFViewer.css 的
      // .page-text-overlay 与 .page-link-overlay）。
      // 取值用「画布实测 CSS 宽度 ÷ 页面原始宽度」而不是 renderZoomScale：
      // .pdf-page-block 是 border-box 且带 1px 边框，内容盒比 renderViewport
      // 窄 2px，直接复用 renderZoomScale 会让文本层比画布宽、命中区整体右移。
      // 画布才是两层要对齐的对象，所以以它为准。
      // ★ 注释层吃的是同一条链：不一起注入，.annotationLayer 的 width/height 会
      // 算成 0，section 的百分比落在 0 宽盒子里，链接又是「明明在却点不到」。
      // 因此这一段**不能**塞进 `if (enableTextLayer)` —— 链接在文本层关掉时也要能用。
      const canvasEl = canvas;
      const applyLayerScale = () => {
        if (canvasEl.clientWidth > 0 && baseViewport.width > 0) {
          const scaleFactor = String(canvasEl.clientWidth / baseViewport.width);
          textHostRef.current?.style.setProperty("--scale-factor", scaleFactor);
          linkHostRef.current?.style.setProperty("--scale-factor", scaleFactor);
        }
      };
      applyLayerScale();
      // 画布尺寸变化（缩放、页尺寸回填）后跟着重算。--scale-factor 一变，
      // 两层的 width/height/font-size（写成 calc(var(--total-scale-factor)…)）
      // 会自行重新求值，不需要重建层。
      textLayerScaleObserverRef.current?.disconnect();
      textLayerScaleObserverRef.current = new ResizeObserver(applyLayerScale);
      textLayerScaleObserverRef.current.observe(canvasEl);

      const textHost = textHostRef.current;
      if (enableTextLayer && textHost) {
        try {
          let builder = textLayerRef.current;
          if (!builder || builder.pageNo !== pageNo) {
            builder?.cancel();
            const viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
            const TextLayerBuilderCtor = viewerModule.TextLayerBuilder as unknown as new (args: {
              pdfPage: unknown;
              /**
               * 官方预留的宿主扩展点：`render()` 内部会
               * `highlighter.setTextMapping(textDivs, textContentItemsStr)` 再 `enable()`。
               * 不接它就没有 `textDivs` 与原文的映射，标注只能退回「画覆盖 div」。
               */
              highlighter?: { setTextMapping: (d: HTMLElement[], t: string[]) => void; enable: () => void; disable: () => void };
            }) => {
              div: HTMLDivElement;
              render: (params: { viewport: unknown }) => Promise<void>;
              show: () => void;
              hide: () => void;
              cancel: () => void;
            };
            const created = new TextLayerBuilderCtor({
              pdfPage: page,
              highlighter: markerRef.current,
            });
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
          if (cancelled || token !== tokenRef.current) return;
          builder.show();
          /**
           * ★ 只**作废**缓存，不在这里预先测。
           *
           * 原先这里是 `textSpanCacheRef.current = getPdfTextSpans(builder.div)` ——
           * 渲染完立刻把本页整层 span 量一遍（每页 60–225 次 `getBoundingClientRect`，
           * 每一次都是强制同步布局冲刷）。但这一笔**只有当有人来问时才值**：
           * 量它的是划词悬停（要有指针在本页上）与波浪线渲染（本页要有标注）。
           * 两者都不成立时（滚动经过的绝大多数页），这次测量纯粹白做 ——
           * 而它就在「翻页 → 渲染」这条路径上，正是读者感觉卡的地方。
           *
           * 清成 null 之后，`readTextSpans` 会在第一个消费者到来时**按需**测一次，
           * 成本一样但只在真有消费者时支付。同时清掉几何基准，让那次测量
           * 走「判据认为重排过」的分支（`previous === null`），语义与「刚换了一页」一致。
           */
          textSpanCacheRef.current = null;
          textSpanGeometryRef.current = null;
          paragraphCacheRef.current = new WeakMap();
          const domBlocks = buildDomPdfReadingBlocks(builder.div, pageNo);
          readingBlocksRef.current = mergeDomPdfReadingBlocks(domBlocks, structuredBlocksRef.current);
          notifyRef.current.onReadingBlocks?.(pageNo, domBlocks);
          setTextLayerVersion((value) => value + 1);
        } catch {
          textLayerRef.current?.cancel();
          textLayerRef.current = null;
          readingBlocksRef.current = [];
          textSpanCacheRef.current = null;
          paragraphCacheRef.current = new WeakMap();
          notifyRef.current.onReadingBlocks?.(pageNo, []);
          setTextLayerVersion((value) => value + 1);
          textHost.innerHTML ="";
        }
      } else if (textHost) {
        textLayerRef.current?.hide();
        textSpanCacheRef.current = null;
        paragraphCacheRef.current = new WeakMap();
        setTextLayerVersion((value) => value + 1);
        textHost.innerHTML ="";
        // ⚠️ 这里**不能**清 readingBlocks / notify 空数组。批注工具激活
        // （activeTool !== "select" → enableTextLayer=false）会撤掉文本层 DOM，
        // 但已算好的行几何是**页面归一化坐标**——与缩放无关、与文本层 DOM 的
        // 存亡无关，恰恰是批注工具拖拽落纸时 `snapAnnotationRectToLines`
        // 唯一能拿到的吸附数据。2026-10-08 实测：在这里清空会让
        // 「点工具 → 拖拽」链路的行吸附整体失效，下划线退回
        // LINE_HEIGHT_FALLBACK 兜底高度，不贴行也不收窄 —— 而这正是
        // 「工具实现有问题，下划线拖出来是一条缝」的根因之一。
        // 与本文件 !active 分支（滚出视区也保留 blocks）同一原则：
        // 几何数据的生命周期跟随页面，不跟随文本层的可见性。
      }
    };

    void run().catch((error) => {
      if (cancelled) return;
      if (error instanceof Error && error.name ==="RenderingCancelledException") return;
      // Do not hide rendered canvas when optional overlay steps fail.
      setStatus((prev) => (prev ==="ready" ? prev :"idle"));
      notifyRef.current.onError(error instanceof Error ? error.message : "Failed to render page");
    });

    return () => {
      cancelled = true;
      textLayerScaleObserverRef.current?.disconnect();
      textLayerScaleObserverRef.current = null;
      renderTask?.cancel();
      const canvas = canvasRef.current;
      if (canvas) {
        const existing = activeCanvasRenders.get(canvas);
        existing?.cancel();
      }
      // ⚠️ 这里**不**释放像素缓冲：本清理函数在每次 effect 重跑时都会执行
      // （换批注工具、缩放、换文档都会重跑），在这里释放会让画布先变空白
      // 再重画 —— 读者感知为「一切换工具就闪一下白」。
      // 释放放在下面那个只在卸载时运行的 effect 里。
      textLayerRef.current?.cancel();
      annotationLayerRef.current?.cancel();
      annotationLayerRef.current = null;
      page?.cleanup();
    };
  }, [
    // 只剩**真正的渲染输入**。通知型回调全部走 notifyRef（见它的注释）：
    // 它们每次父组件渲染都会换身份，留在依赖里会让文本层被反复重建，
    // 直接吃掉读者正在进行的划词选中。
    active,
    doc,
    enableTextLayer,
    linksEnabled,
    pageNo,
    renderZoomScale,
  ]);

  useEffect(() => {
    return () => {
      /**
       * **确定性释放像素缓冲**，不要等 GC（只在**卸载**时执行）。
       *
       * 页面离开活跃集合时本组件被卸载，`<canvas>` 随之脱离文档 ——
       * 但脱离不等于像素缓冲立刻归还：浏览器要等这个元素被 GC 才回收
       * （WebKit/Chromium 都是这个行为）。
       *
       * 写法与 pdf.js 官方一致：`BasePDFPageView._destroyCanvas()`
       * （`pdfjs-dist/web/pdf_viewer.mjs:5025-5032`）就是
       * `canvas.remove(); canvas.width = canvas.height = 0;` ——
       * 归零会让引擎**立即**丢弃 backing store，而不是留一张位图等 GC。
       * 本组件里 canvas 的所有权归 React，所以只做归零那半句。
       */
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
      annotationLayerRef.current?.cancel();
      annotationLayerRef.current = null;
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div
        ref={textHostRef}
        className={`page-text-overlay ${
          enableTextLayer && (status ==="ready" || (active && hasPaintedRef.current)) ?"opacity-100" :"opacity-0"
        } ${enableTextLayer && !enableAssistBlocks && (status ==="ready" || (active && hasPaintedRef.current)) ?"is-selectable" :""} ${
          enableTextLayer && enableAssistBlocks && status ==="ready" ?"is-assist" :""
        }`}
      />
      <div ref={linkHostRef} className="absolute inset-0 z-10 pointer-events-none" />
      {active && status ==="rendering" && !hasPaintedRef.current ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-panel/65 text-content-muted text-xs">
          {renderingLabel}
        </div>
      ) : null}
    </div>
  );
});
