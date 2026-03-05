import './pdfJsSetup';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';

const documentCache = new Map<string, PDFDocumentProxy>();

export async function loadPdfDocument(
  fileId: string,
  data: Uint8Array
): Promise<PDFDocumentProxy> {
  const existing = documentCache.get(fileId);
  if (existing) {
    return existing;
  }

  const loadingTask = getDocument({ data });
  const doc = await loadingTask.promise;
  documentCache.set(fileId, doc);
  return doc;
}

export function getCachedDocument(fileId: string): PDFDocumentProxy | undefined {
  return documentCache.get(fileId);
}

export async function closePdfDocument(fileId: string): Promise<void> {
  const doc = documentCache.get(fileId);
  if (doc) {
    await doc.destroy();
    documentCache.delete(fileId);
  }
}
