/**
 * 单页画布：PDF 渲染 + 文字层 + 链接层 + 阅读辅助块。
 * 从 PDFViewer.tsx 拆出（原 1241-1751 行）—— 它是全仓最长的一段组件逻辑
 * （渲染任务调度 / 资源扫描超时 / 文本层几何缓存），与主体 UI 无关。
 */
import { memo, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PdfReadingBlock } from "../../types";
import { buildDomPdfReadingBlocks } from "../../services/pdfBlocks";
import type { ReadingAssistSelection } from "../ReadingAssistMenu";
import {
  activeCanvasRenders,
  cancelAndAwaitCanvasRender,
  collectPdfBlockSpans,
  collectPdfParagraphSpansFromTarget,
  drawSpanGroupHighlightElements,
  getAssistAnchorFromHighlights,
  getBlockHit,
  getNormalizedSpanGroupRect,
  getPdfSpanAtPoint,
  getPdfTextLayerGeometry,
  getPdfTextSpans,
  hasPdfTextLayerGeometryChanged,
  mergeDomPdfReadingBlocks,
  textFromPdfSpans,
  trackCanvasRender,
  type CanvasRenderTask,
  type PdfTextLayerGeometry,
  type PdfTextSpan,
} from "./readerCore";

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
  onAssistSelection?: (selection: Omit<ReadingAssistSelection,"id" |"sourceTitle">) => void;
  onReadingBlocks?: (pageNo: number, blocks: PdfReadingBlock[]) => void;
  structuredBlocks?: PdfReadingBlock[];
  structuredBlocksVersion?: number;
  onPageLinks?: (pageNo: number, links: Array<{ url: string }>) => void;
  onPageRendered?: (pageNo: number, renderZoomScale: number) => void;
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
  onAssistSelection,
  onReadingBlocks,
  structuredBlocks = [],
  structuredBlocksVersion = 0,
  onPageLinks,
  onPageRendered,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textHostRef = useRef<HTMLDivElement | null>(null);
  const linkHostRef = useRef<HTMLDivElement | null>(null);
  const assistHighlightsRef = useRef<HTMLDivElement[]>([]);
  const linkTokenRef = useRef(0);
  const activeAssistSpansRef = useRef<HTMLElement[]>([]);
  const activeAssistBlockRef = useRef<PdfReadingBlock | null>(null);
  const textSpanCacheRef = useRef<PdfTextSpan[] | null>(null);
  const textSpanGeometryRef = useRef<PdfTextLayerGeometry | null>(null);
  const paragraphCacheRef = useRef<WeakMap<HTMLElement, HTMLElement[]>>(new WeakMap());
  const activeAssistGroupRef = useRef<HTMLElement[]>([]);
  const readingBlocksRef = useRef<PdfReadingBlock[]>([]);
  const structuredBlocksRef = useRef<PdfReadingBlock[]>(structuredBlocks);
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
  const paintedDocRef = useRef<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<"idle" |"rendering" |"ready">("idle");
  const [textLayerVersion, setTextLayerVersion] = useState(0);

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

    const clearActive = () => {
      for (const node of activeAssistSpansRef.current) {
        node.classList.remove("pdf-assist-text-active");
      }
      activeAssistSpansRef.current = [];
      activeAssistGroupRef.current = [];
      activeAssistBlockRef.current = null;
      for (const element of assistHighlightsRef.current) element.remove();
      assistHighlightsRef.current = [];
    };

    const setActiveFromPoint = (
      clientX: number,
      clientY: number,
      eventTarget?: EventTarget | null,
    ): { text: string; block: PdfReadingBlock | null } => {
      const textLayer = host.querySelector(".textLayer");
      if (!(textLayer instanceof HTMLElement)) return { text:"", block: null };
      const highlightTarget =
        eventTarget instanceof HTMLElement ? eventTarget.closest(".pdf-assist-block-highlight") : null;
      // The visible block rectangles sit above the transparent PDF.js spans.
      // Once a block is active, keep using that exact group while the pointer
      // crosses its line rectangles instead of falling back to nearest-span
      // lookup and flickering between partial groups.
      if (highlightTarget && activeAssistGroupRef.current.length > 0) {
        return {
          text: textFromPdfSpans(activeAssistGroupRef.current),
          block: activeAssistBlockRef.current,
        };
      }
      const geometry = getPdfTextLayerGeometry(textLayer);
      if (hasPdfTextLayerGeometryChanged(textSpanGeometryRef.current, geometry)) {
        textSpanCacheRef.current = null;
        paragraphCacheRef.current = new WeakMap();
        textSpanGeometryRef.current = geometry;
      }
      const spans = textSpanCacheRef.current || getPdfTextSpans(textLayer);
      textSpanCacheRef.current = spans;
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
      const cachedGroup = paragraphCacheRef.current.get(span);
      const blockGroup = collectPdfBlockSpans(block, spans, textLayer);
      // This block index is built from the same visible PDF.js spans. Use it
      // first so hit testing, highlight geometry, and quoted text share one
      // paragraph boundary. The heuristic remains a fallback for the short
      // interval before the DOM index is ready or for an unusual layer with
      // no usable block rectangle.
      const paragraphGroup = cachedGroup || collectPdfParagraphSpansFromTarget(span, spans);
      const group = blockGroup.length > 0 ? blockGroup : paragraphGroup;
      paragraphCacheRef.current.set(span, group);
      if (group.length === 0) return { text:"", block: null };
      const sameActiveGroup =
        activeAssistGroupRef.current.length === group.length &&
        activeAssistGroupRef.current.every((node, index) => node === group[index]);
      if (sameActiveGroup && assistHighlightsRef.current.length > 0) {
        return { text: textFromPdfSpans(group) || block?.text ||"", block };
      }
      clearActive();
      for (const node of group) node.classList.add("pdf-assist-text-active");
      activeAssistSpansRef.current = group;
      activeAssistGroupRef.current = group;
      activeAssistBlockRef.current = block;
      assistHighlightsRef.current = drawSpanGroupHighlightElements(group, host, assistHighlightsRef.current);
      return { text: textFromPdfSpans(group) || block?.text ||"", block };
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
      const sourceRect =
        textLayer instanceof HTMLElement
          ? getNormalizedSpanGroupRect(activeAssistSpansRef.current, textLayer)
          : hit.block?.rect;
      event.preventDefault();
      event.stopPropagation();
      onAssistSelection({
        text,
        reference:`page ${pageNo}`,
        blockId: hit.block?.id,
        sourceRect,
        ...getAssistAnchorFromHighlights(assistHighlightsRef.current, event.clientX + 10, event.clientY - 10),
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
      onSize(pageNo, baseViewport.width, baseViewport.height);

      const renderViewport = page.getViewport({ scale: renderZoomScale });
      const visualViewport = renderViewport;

      const linkHost = linkHostRef.current;
      if (linkHost) {
        linkHost.innerHTML ="";
      }

      if (active && (linksEnabled || onPageLinks) && linkHost) {
        const tokenLinks = ++linkTokenRef.current;
        void (async () => {
          try {
            const annotations = await page.getAnnotations();
            if (cancelled || token !== tokenRef.current || tokenLinks !== linkTokenRef.current) return;
            const links: Array<{ url: string }> = [];
            const openLink = onOpenLinkInApp || onOpenExternal;
            const overlay = linksEnabled && openLink ? document.createElement("div") : null;
            if (overlay) {
              overlay.className ="page-link-overlay";
              overlay.style.width =`${Math.ceil(visualViewport.width)}px`;
              overlay.style.height =`${Math.ceil(visualViewport.height)}px`;
            }

            for (const item of annotations as Array<Record<string, unknown>>) {
              const subtype = item.subtype;
              if (subtype !=="Link") continue;
              const url = typeof item.url ==="string" ? item.url :"";
              if (!url) continue;
              links.push({ url });
              if (!overlay || !openLink) continue;
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
              btn.type ="button";
              btn.className ="page-link-hit";
              btn.style.left =`${x}px`;
              btn.style.top =`${y}px`;
              btn.style.width =`${w}px`;
              btn.style.height =`${h}px`;
              btn.title = url;
              btn.onclick = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                openLink(url);
              };
              overlay.appendChild(btn);
            }

            onPageLinks?.(pageNo, links);
            linkHost.replaceChildren(...(overlay ? [overlay] : []));
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
      const renderCanvas = document.createElement("canvas");
      const renderContext = renderCanvas.getContext("2d", { alpha: false });
      if (!renderContext) return;
      renderCanvas.width = Math.ceil(renderViewport.width * dpr);
      renderCanvas.height = Math.ceil(renderViewport.height * dpr);
      renderContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderContext.fillStyle ="#ffffff";
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

      // Keep canvas visible regardless of text-layer availability.
      setStatus("ready");
      // The zoom lock protects the painted page geometry. Text-layer parsing
      // is an optional follow-up and must not keep neighboring pages hidden
      // when the canvas itself is already stable at the target scale.
      onPageRendered?.(pageNo, renderZoomScale);

      const textHost = textHostRef.current;
      if (enableTextLayer && textHost) {
        // PDF.js 的文本层靠 CSS 变量链定位，其中 --scale-factor 上游只在
        // PDFPageView.update() 且 _isStandalone 时注入；本项目只借用
        // TextLayerBuilder，所以必须在这里自己补（链条定义见 PDFViewer.css
        // 的 .page-text-overlay）。
        // 取值用「画布实测 CSS 宽度 ÷ 页面原始宽度」而不是 renderZoomScale：
        // .pdf-page-block 是 border-box 且带 1px 边框，内容盒比 renderViewport
        // 窄 2px，直接复用 renderZoomScale 会让文本层比画布宽、命中区整体右移。
        // 画布才是文本层要对齐的对象，所以以它为准。
        const canvasEl = canvas;
        const applyTextLayerScale = () => {
          if (canvasEl.clientWidth > 0 && baseViewport.width > 0) {
            textHost.style.setProperty(
              "--scale-factor",
              String(canvasEl.clientWidth / baseViewport.width),
            );
          }
        };
        applyTextLayerScale();
        // 画布尺寸变化（缩放、页尺寸回填）后跟着重算。--scale-factor 一变，
        // 文本层自身的 width/height/font-size（写成 calc(var(--total-scale-factor)…)）
        // 会自行重新求值，不需要重建文本层。
        textLayerScaleObserverRef.current?.disconnect();
        textLayerScaleObserverRef.current = new ResizeObserver(applyTextLayerScale);
        textLayerScaleObserverRef.current.observe(canvasEl);
        try {
          let builder = textLayerRef.current;
          if (!builder || builder.pageNo !== pageNo) {
            builder?.cancel();
            const viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
            const TextLayerBuilderCtor = viewerModule.TextLayerBuilder as unknown as new (args: {
              pdfPage: unknown;
            }) => {
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
          if (cancelled || token !== tokenRef.current) return;
          builder.show();
          textSpanCacheRef.current = getPdfTextSpans(builder.div);
          textSpanGeometryRef.current = getPdfTextLayerGeometry(builder.div);
          paragraphCacheRef.current = new WeakMap();
          const domBlocks = buildDomPdfReadingBlocks(builder.div, pageNo);
          readingBlocksRef.current = mergeDomPdfReadingBlocks(domBlocks, structuredBlocksRef.current);
          onReadingBlocks?.(pageNo, domBlocks);
          setTextLayerVersion((value) => value + 1);
        } catch {
          textLayerRef.current?.cancel();
          textLayerRef.current = null;
          readingBlocksRef.current = [];
          textSpanCacheRef.current = null;
          paragraphCacheRef.current = new WeakMap();
          onReadingBlocks?.(pageNo, []);
          setTextLayerVersion((value) => value + 1);
          textHost.innerHTML ="";
        }
      } else if (textHost) {
        textLayerRef.current?.hide();
        readingBlocksRef.current = [];
        textSpanCacheRef.current = null;
        paragraphCacheRef.current = new WeakMap();
        onReadingBlocks?.(pageNo, []);
        setTextLayerVersion((value) => value + 1);
        textHost.innerHTML ="";
      }
    };

    void run().catch((error) => {
      if (cancelled) return;
      if (error instanceof Error && error.name ==="RenderingCancelledException") return;
      // Do not hide rendered canvas when optional overlay steps fail.
      setStatus((prev) => (prev ==="ready" ? prev :"idle"));
      onError(error instanceof Error ? error.message :"Failed to render page");
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
      textLayerRef.current?.cancel();
      page?.cleanup();
    };
  }, [
    active,
    doc,
    enableTextLayer,
    linksEnabled,
    onError,
    onOpenExternal,
    onOpenLinkInApp,
    onPageLinks,
    onPageRendered,
    onReadingBlocks,
    onSize,
    pageNo,
    renderZoomScale,
  ]);

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
