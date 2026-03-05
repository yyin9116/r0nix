import { useEffect, useRef, useCallback } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';

interface VirtualPageProps {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
}

export function VirtualPage({ pdfDocument, pageNumber, scale }: VirtualPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);

  const renderPage = useCallback(async () => {
    // Cancel any in-progress render
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    let page: PDFPageProxy;
    try {
      page = await pdfDocument.getPage(pageNumber);
    } catch {
      return;
    }
    pageRef.current = page;

    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale });

    // Set canvas dimensions for HiDPI
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    try {
      const renderTask = page.render({
        canvas: canvasRef.current,
        canvasContext: ctx,
        viewport,
        transform: [dpr, 0, 0, dpr, 0, 0],
      });
      renderTaskRef.current = renderTask;
      await renderTask.promise;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'RenderingCancelledException') {
        return;
      }
      console.error(`Failed to render page ${pageNumber}:`, err);
      return;
    }

    // Render text layer
    textLayerDiv.innerHTML = '';
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;

    const textContent = await page.getTextContent();
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();
  }, [pdfDocument, pageNumber, scale]);

  useEffect(() => {
    renderPage();

    return () => {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [renderPage]);

  // Estimate dimensions for the container before render completes
  const estimatedWidth = 595 * scale;
  const estimatedHeight = 842 * scale;

  return (
    <div
      className="virtual-page-container"
      style={{
        position: 'relative',
        width: canvasRef.current ? undefined : estimatedWidth,
        height: canvasRef.current ? undefined : estimatedHeight,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        backgroundColor: '#FFFFFF',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
}
