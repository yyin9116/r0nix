/**
 * 侧栏缩略图：单页的懒渲染缩略图（IntersectionObserver 进入视口才渲染）。
 * 从 PDFViewer.tsx 拆出（原 1752-1935 行）。
 */
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import * as api from "../../services/pdfApi";
import {
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
  onRegisterThumbnailVisibility: (pageNo: number, onEnter: (() => void) | null) => void;
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
    const node = buttonRef.current;
    const observer = thumbnailObserverRef.current;
    if (!node || typeof IntersectionObserver ==="undefined") {
      if (typeof IntersectionObserver ==="undefined") setInView(true);
      return;
    }
    const onEnter = () => setInView(true);
    onRegisterThumbnailVisibility(pageNo, onEnter);
    observer?.observe(node);
    return () => {
      observer?.unobserve(node);
      onRegisterThumbnailVisibility(pageNo, null);
    };
  }, [onRegisterThumbnailVisibility, pageNo, thumbnailObserverRef]);

  useEffect(() => {
    const shouldRender = inView || active;
    if (!shouldRender || (!doc && !fileId)) return;

    let cancelled = false;
    let task: CanvasRenderTask | null = null;
    let objectUrl ="";
    let page: PDFPageProxy | null = null;

    const run = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
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
        canvas.style.width =`${Math.round(thumbViewport.width)}px`;
        canvas.style.height =`${Math.round(thumbViewport.height)}px`;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.fillStyle ="#ffffff";
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

      objectUrl = URL.createObjectURL(new Blob([bytes], { type:"image/png" }));
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
      canvas.style.width =`${drawWidth}px`;
      canvas.style.height =`${drawHeight}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle ="#ffffff";
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
      page?.cleanup();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, doc, fileId, inView, pageNo]);

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
        contentVisibility: active || inView ?"visible" :"auto",
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
        <canvas ref={canvasRef} className={`block transition-opacity ${ready ?"opacity-100" :"opacity-0"}`} />
        {!ready ? <div className="absolute inset-0 bg-surface-sunken" /> : null}
      </div>
      <span className="text-xs font-mono text-content-muted">{pageNo}</span>
    </button>
  );
});
