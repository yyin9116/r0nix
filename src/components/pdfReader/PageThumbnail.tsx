/**
 * 侧栏缩略图：单页的懒渲染缩略图（IntersectionObserver 进入视口才渲染）。
 * 从 PDFViewer.tsx 拆出（原 1752-1935 行）。
 *
 * ⚠️ 2026-10-10：`<canvas>` 改为**只在进入视口 ±240px 时才挂载**。
 *
 * 为什么必须挂载/卸载、而不是只靠 `content-visibility: auto`：`content-visibility`
 * 能丢弃普通子树的布局与绘制，但**丢弃不了 canvas 的后备缓冲** —— 浏览器不能把
 * 已画好的 canvas 内容扔掉，否则滚回来画面就空了。于是 200 页文档里那 200 个
 * `<canvas>` 就是 200 块常驻缓冲，合成器要一直替它们记账。
 *
 * 实测（`probe-pdf-scroll-cost.mjs`，同一会话背靠背 A/B，WebKit 200 页）：
 * 把侧栏缩略图整体 `display:none` 后，⑥ 段连续滚动慢帧 **44/360(12.2%) → 2/360(0.6%)**。
 * 且「轻页夹具 vs 每页 1600×2200 位图的重页夹具」慢帧几乎一样（43 vs 40）——
 * 说明残余掉帧既不来自页位图、也不来自 JS（长任务恒 0、LoAF 为空），而是缩略图 canvas。
 */
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import * as api from "../../services/pdfApi";
import {
  acquireThumbnailRenderSlot,
  activeCanvasRenders,
  cancelAndAwaitCanvasRender,
  trackCanvasRender,
  type CanvasRenderTask,
} from "./readerCore";

export interface PageThumbnailProps {
  doc: PDFDocumentProxy | null;
  fileId?: string;
  pageNo: number;
  active: boolean;
  onClick: (pageNo: number) => void;
  onItemRef: (pageNo: number, node: HTMLButtonElement | null) => void;
  pageLabel: string;
  onContextMenu?: (pageNo: number, event: React.MouseEvent<HTMLButtonElement>) => void;
  thumbnailObserverRef: RefObject<IntersectionObserver | null>;
  /**
   * 注册本页的可见性回调。回调参数是**双向**的（进入 / 离开都上报），
   * 因为「离得远就卸载 canvas」必须知道离开，否则只能进不能出（原实现就是只报进入）。
   */
  onRegisterThumbnailVisibility: (pageNo: number, onVisibilityChange: ((visible: boolean) => void) | null) => void;
}

export const PageThumbnail = memo(function PageThumbnail({
  doc,
  fileId,
  pageNo,
  active,
  onClick,
  onItemRef,
  pageLabel,
  onContextMenu,
  thumbnailObserverRef,
  onRegisterThumbnailVisibility,
}: PageThumbnailProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * 已渲染守卫的钥匙。本 effect 重跑时（`showCanvas` 翻转、换页翻 `active`、
   * 换文档）canvas 内容可能还好好地在 DOM 里 —— 不加这道守卫，每次换页都会把
   * 已画好的缩略图从零重画一遍，这正是「缩略图永远在逐渐加载」的主要来源（2026-10-09 反馈）。
   * key 里带文档指纹，换文档后同一页码不会误判为已渲染。
   *
   * ⚠️ 但**不能**只靠 key + `canvas.width > 1` 判断（原实现）：
   * 新建的 `<canvas>` 默认 `width` 就是 **300**，所以「离得远卸载、滚回来重挂」的
   * 那个新 canvas 会让 `width > 1` 成立 → 直接 `setReady(true)` 却一帧没画 →
   * 缩略图变空白。必须再比**节点身份**：只有「同一把钥匙 + 同一个 canvas 元素」
   * 才算真已渲染。
   */
  const renderedKeyRef = useRef("");
  const renderedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * `nearView` = 是否落在缩略图视口的 ±240px 内（由共享 IntersectionObserver **双向**上报）。
   * 它同时决定两件事：要不要**挂载 canvas**、以及 `content-visibility` 用 visible 还是 auto。
   * 初始给前 8 页与当前页 true，避免首屏出现一段空白。
   */
  const [nearView, setNearView] = useState(pageNo <= 8 || active);
  const [ready, setReady] = useState(false);
  /**
   * 当前页永远保留 canvas：`active` 是「用户正在看的那一页」，
   * 哪怕它此刻不在缩略图视口内（侧栏滚到别处）也要能立刻显示。
   */
  const showCanvas = nearView || active;

  useEffect(() => {
    const node = buttonRef.current;
    onItemRef(pageNo, node);
    return () => {
      onItemRef(pageNo, null);
    };
  }, [onItemRef, pageNo]);

  useEffect(() => {
    const node = buttonRef.current;
    const observer = thumbnailObserverRef.current;
    if (!node || typeof IntersectionObserver ==="undefined") {
      if (typeof IntersectionObserver ==="undefined") setNearView(true);
      return;
    }
    // 进入与离开都要上报：离开时把 canvas 卸载掉，这是「200 个常驻 canvas」的解法。
    const onVisibility = (visible: boolean) => setNearView(visible);
    onRegisterThumbnailVisibility(pageNo, onVisibility);
    observer?.observe(node);
    return () => {
      observer?.unobserve(node);
      onRegisterThumbnailVisibility(pageNo, null);
    };
  }, [onRegisterThumbnailVisibility, pageNo, thumbnailObserverRef]);

  useEffect(() => {
    // `showCanvas` 兼作「canvas 此刻在不在 DOM 里」的开关：
    // React 在提交阶段先接好 ref、再跑被动 effect，所以这里 `canvasRef.current` 一定是新的。
    if (!showCanvas) {
      // canvas 已被卸载，回来时必须重画 —— 先撤掉 ready，把占位块露出来，
      // 否则重进的瞬间会露出一个「空的但以为已画好」的白框。
      setReady(false);
      return;
    }
    if (!doc && !fileId) return;

    let cancelled = false;
    let task: CanvasRenderTask | null = null;
    let objectUrl ="";
    let page: PDFPageProxy | null = null;

    const run = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;

      // 已渲染守卫：同一把钥匙 **且同一个 canvas 元素** 时才认为已渲染
      // （新 canvas 的默认 width 就是 300，只看 width 会把空画布置成 ready）。
      const renderedKey = `${doc ? `doc:${doc.fingerprints?.[0] ?? ""}` : `file:${fileId ?? ""}`}:${pageNo}`;
      if (renderedKeyRef.current === renderedKey && renderedCanvasRef.current === canvas) {
        setReady(true);
        return;
      }

      // 并发闸：最多 2 张缩略图同时在渲，避免与主画布抢 pdf.js worker（见 readerCore）。
      const releaseSlot = await acquireThumbnailRenderSlot();
      if (cancelled) {
        releaseSlot();
        return;
      }
      try {
        await cancelAndAwaitCanvasRender(canvas);
        if (cancelled) return;

        if (doc) {
          page = await doc.getPage(pageNo);
          if (cancelled) {
            page.cleanup();
            page = null;
            return;
          }
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
          renderedKeyRef.current = renderedKey;
          renderedCanvasRef.current = canvas;
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
        renderedKeyRef.current = renderedKey;
        renderedCanvasRef.current = canvas;
        setReady(true);
      } finally {
        releaseSlot();
      }
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
      page?.cleanup();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc, fileId, pageNo, showCanvas]);

  return (
    <button
      ref={buttonRef}
      data-thumbnail-page={pageNo}
      className={`mx-auto flex w-full flex-col items-center gap-2 p-2 rounded-lg transition-all border ${
        active
          ?"border-content-primary/75 bg-surface-hover/80 shadow-sm"
          :"border-border-default hover:border-content-muted bg-surface-panel"
      }`}
      style={{
        contentVisibility: showCanvas ?"visible" :"auto",
        containIntrinsicSize:"182px 150px",
      }}
      onClick={() => onClick(pageNo)}
      title={`${pageLabel} ${pageNo}`}
      type="button"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(pageNo, event);
      }}
    >
      <div className="relative bg-surface-panel shadow-sm rounded-sm w-[112px] min-h-[150px] flex items-center justify-center">
        {showCanvas ? (
          <canvas ref={canvasRef} className={`block transition-opacity ${ready ?"opacity-100" :"opacity-0"}`} />
        ) : null}
        {!showCanvas || !ready ? <div className="absolute inset-0 bg-surface-sunken" /> : null}
      </div>
      <span className="text-xs font-mono text-content-muted">{pageNo}</span>
    </button>
  );
});
