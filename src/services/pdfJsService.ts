import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

const documentCache = new Map<string, PDFDocumentProxy>();
type LoadingEntry = {
  promise: Promise<PDFDocumentProxy>;
  destroy: () => Promise<void>;
};

const documentLoadingCache = new Map<string, LoadingEntry>();
const PDF_JS_LOAD_TIMEOUT_MS = 30_000;

export async function loadPdfDocument(
  fileId: string,
  data: Uint8Array
): Promise<PDFDocumentProxy> {
  const existing = documentCache.get(fileId);
  if (existing) {
    return existing;
  }

  const loadingEntry = documentLoadingCache.get(fileId);
  if (loadingEntry) {
    return loadingEntry.promise;
  }

  let loadingTask: PDFDocumentLoadingTask | null = null;
  let destroyed = false;
  let destroyPromise: Promise<void> | null = null;
  const destroyLoadingTask = async () => {
    if (destroyPromise) return destroyPromise;
    destroyed = true;
    destroyPromise = loadingTask
      ? loadingTask.destroy().catch(() => undefined)
      : Promise.resolve();
    return destroyPromise;
  };

  const loadingPromise = (async () => {
    await import('./pdfJsSetup');
    const { getDocument } = await import('pdfjs-dist');
    if (destroyed) {
      throw new DOMException('PDF.js loading was cancelled', 'AbortError');
    }
    loadingTask = getDocument({ data });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`PDF.js loading timed out after ${PDF_JS_LOAD_TIMEOUT_MS}ms`));
        }, PDF_JS_LOAD_TIMEOUT_MS);
      });
      const doc = await Promise.race([loadingTask.promise, timeout]);
      if (destroyed) {
        await doc.destroy();
        throw new DOMException('PDF.js loading was cancelled', 'AbortError');
      }
      documentCache.set(fileId, doc);
      return doc;
    } catch (error) {
      await destroyLoadingTask();
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  })();

  const entry: LoadingEntry = { promise: loadingPromise, destroy: destroyLoadingTask };
  documentLoadingCache.set(fileId, entry);
  try {
    return await loadingPromise;
  } finally {
    if (documentLoadingCache.get(fileId) === entry) {
      documentLoadingCache.delete(fileId);
    }
  }
}

export function getCachedDocument(fileId: string): PDFDocumentProxy | undefined {
  return documentCache.get(fileId);
}

export async function closePdfDocument(fileId: string): Promise<void> {
  const loadingEntry = documentLoadingCache.get(fileId);
  if (loadingEntry) {
    // Do not wait for a slow or malformed document to finish parsing before
    // releasing the tab. The shared promise owns the eventual rejection and
    // will destroy a document that races with cancellation before caching it.
    await loadingEntry.destroy();
    void loadingEntry.promise.catch(() => undefined);
    return;
  }
  const doc = documentCache.get(fileId);
  if (doc) {
    await doc.destroy();
    documentCache.delete(fileId);
  }
}
