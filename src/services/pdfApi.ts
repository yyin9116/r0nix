/**
 * Unified PDF API adapter
 *
 * Auto-detects environment:
 * - Tauri: Uses Rust backend for file I/O + PDF.js for rendering
 * - Browser: Uses Python backend
 */

import * as rustPdf from './rustPdf';
import { loadPdfDocument, getCachedDocument, closePdfDocument } from './pdfJsService';
import { debugError, debugLog, debugWarn } from './debugLogger';
import { isManagedImportTempPath, readNativeTextFile, removeManagedImportTemp, writeNativeTempFile, writeNativeTextFile } from './nativeFiles';
import type { PdfReadingBlock, PdfReadingBlockKind, ReaderAnnotationRect } from '../types';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const isTauri =
  typeof window !== 'undefined' &&
  ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

debugLog('api.adapter', 'initialized', { runtime: isTauri ? 'tauri' : 'browser' });

const BROWSER_API_BASE = 'http://localhost:8000';
const BROWSER_REQUEST_TIMEOUT_MS = 30_000;
const browserLocalFiles = new Map<string, FileInfo>();
const browserLocalMarkdown = new Map<string, string>();
const nativeMarkdownPaths = new Map<string, string>();
export const MAX_IMPORT_FILE_BYTES = 512 * 1024 * 1024;

function assertImportFileSize(file: File) {
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error(`文件超过 ${Math.ceil(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MiB 限制，无法导入。`);
  }
}

function cacheBrowserMarkdown(fileId: string, path: string, content: string) {
  browserLocalMarkdown.set(fileId, content);
  browserLocalMarkdown.set(path, content);
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function backendHintError(action: string): Error {
  return new Error(
    `Browser mode ${action} failed: backend is not reachable at ${BROWSER_API_BASE}. ` +
      'Start backend with: cd backend && python main.py'
  );
}

function generateBrowserFileId() {
  return generateRuntimeId("browser");
}

function generateRuntimeId(prefix: string) {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${randomUuid || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function createExportCancellation(signal?: AbortSignal) {
  const requestId = isTauri ? generateRuntimeId("pdf-export") : undefined;
  const cancelNativeTask = () => {
    if (!requestId) return;
    void rustPdf.cancelPdfExport(requestId).catch((error) => {
      debugWarn("api.pdfExport", "failed to cancel native export", error);
    });
  };
  signal?.addEventListener("abort", cancelNativeTask, { once: true });
  return {
    requestId,
    cleanup: () => signal?.removeEventListener("abort", cancelNativeTask),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function uploadFileInBrowserLocal(file: File): Promise<FileInfo> {
  const fileId = generateBrowserFileId();
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') {
    const text = await file.text();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const info: FileInfo = {
      id: fileId,
      name: file.name,
      type: 'markdown',
      path: file.name,
      meta: {
        words,
        readTime: Math.max(1, Math.ceil(words / 220)),
        size: `${(file.size / 1024).toFixed(1)} KB`,
      },
    };
    browserLocalFiles.set(fileId, info);
    cacheBrowserMarkdown(fileId, info.path, text);
    return info;
  }

  if (ext !== 'pdf') {
    throw new Error('Browser fallback currently supports PDF/Markdown files only');
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await loadPdfDocument(fileId, data);
  const info: FileInfo = {
    id: fileId,
    name: file.name,
    type: 'pdf',
    path: file.name,
      meta: {
        pages: doc.numPages,
        fileSize: file.size,
        size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
    },
  };
  browserLocalFiles.set(fileId, info);
  return info;
}

// ============ Type Definitions ============

export interface FileInfo {
  id: string;
  name: string;
  type: "pdf" | "markdown";
  path: string;
  meta: {
    pages?: number;
    fileSize?: number;
    words?: number;
    readTime?: number;
    size?: string;
  };
}

export interface PDFImageInfo {
  xref: number;
  resourceId?: string;
  documentId?: string;
  pageNumber: number;
  width: number;
  height: number;
  pageWidth?: number;
  pageHeight?: number;
  extension: string;
  bbox?: number[];
  source?: "xref" | "block" | "vector";
}

async function fetchBrowserRequest(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = BROWSER_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new Error("Browser backend request timed out.")), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    parentSignal?.removeEventListener("abort", forwardAbort);
  }
}

export interface ExtractedPdfImage {
  xref: number;
  pageNumber: number;
  extension: string;
  width: number;
  height: number;
  dataBase64: string;
}

export interface TileViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TileReadyPayload = rustPdf.TileReadyPayload;

const PDF_READING_BLOCK_KINDS = new Set<PdfReadingBlockKind>([
  "text",
  "title",
  "list",
  "table",
  "image",
  "equation",
  "code",
  "quote",
  "auxiliary",
]);

function normalizeReadingBlockRect(raw: unknown): ReaderAnnotationRect | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rect = raw as Record<string, unknown>;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0, Math.min(1, width)),
    height: Math.max(0, Math.min(1, height)),
  };
}

function normalizePdfReadingBlocks(raw: unknown): PdfReadingBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index): PdfReadingBlock | null => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" && obj.id.trim() ? obj.id : "";
      const page = Math.max(1, Math.round(Number(obj.page) || 1));
      const kind = typeof obj.kind === "string" && PDF_READING_BLOCK_KINDS.has(obj.kind as PdfReadingBlockKind)
        ? (obj.kind as PdfReadingBlockKind)
        : "text";
      const text = typeof obj.text === "string" ? obj.text.replace(/\s+/g, " ").trim() : "";
      if (!text && kind !== "image") return null;
      return {
        id: id || `pymupdf-${page}-${index}`,
        page,
        kind,
        text,
        rect: normalizeReadingBlockRect(obj.rect),
        source: "pymupdf",
      };
    })
    .filter((item): item is PdfReadingBlock => Boolean(item));
}

// ============ File Management ============

export async function openFile(path: string): Promise<FileInfo> {
  debugLog('api.openFile', 'start', { path, isTauri });
  if (isTauri) {
    const fileId = generateRuntimeId("file");
    const info = await rustPdf.openPdf(fileId, path);
    debugLog('api.openFile', 'rust open_pdf success', info);
    let pages = info.page_count;
    try {
      const requestId = generateRuntimeId("pdf-read");
      const data = await withTimeout(
        rustPdf.readOpenedPdfBytes(info.file_id, requestId),
        30000,
        'Rust read_opened_pdf_bytes',
        () => {
          void rustPdf.cancelPdfByteRead(requestId).catch((cancelError) => {
            debugWarn('api.openFile', 'failed to cancel timed-out PDF byte read', cancelError);
          });
        },
      );
      const doc = await loadPdfDocument(info.file_id, data);
      pages = doc.numPages;
      debugLog('api.openFile', 'pdfjs loaded', { pages });
    } catch (error) {
      debugWarn('api.openFile', 'pdfjs load failed; releasing Rust PDF handle', error);
      try {
        await rustPdf.closePdf(info.file_id);
      } catch (closeError) {
        debugWarn('api.openFile', 'failed to release Rust PDF handle after PDF.js load failure', closeError);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PDF.js failed to load the document: ${message}`);
    }

    return {
      id: info.file_id,
      name: path.split(/[\\/]/).pop() || 'unknown',
      type: 'pdf',
      path: info.path,
      meta: {
        pages: pages > 0 ? pages : undefined,
        fileSize: info.file_size,
        size: `${(info.file_size / 1024 / 1024).toFixed(1)} MB`,
      },
    };
  } else {
    try {
      const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/files/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        throw new Error(`Failed to open file: ${response.statusText}`);
      }
      return response.json();
    } catch (error) {
      if (isNetworkError(error)) {
        throw backendHintError('open-by-path');
      }
      throw error;
    }
  }
}

export async function openMarkdownFile(path: string): Promise<FileInfo> {
  const fileName = path.split(/[\\/]/).pop() || path;
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext !== 'md' && ext !== 'markdown') {
    throw new Error('Only markdown files are supported');
  }

  if (isTauri) {
    const content = await readNativeTextFile(path);
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const id = generateRuntimeId("md");
    nativeMarkdownPaths.set(id, path);
    return {
      id,
      name: fileName,
      type: 'markdown',
      path,
      meta: {
        words,
        readTime: Math.max(1, Math.ceil(words / 220)),
        size: `${(new TextEncoder().encode(content).length / 1024).toFixed(1)} KB`,
      },
    };
  }

  const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/files/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw new Error(`Failed to open markdown file: ${response.statusText}`);
  }
  return response.json();
}

export async function readMarkdownText(path: string): Promise<string> {
  if (isTauri) {
    return readNativeTextFile(path);
  }

  const localContent = browserLocalMarkdown.get(path);
  if (typeof localContent === 'string') {
    return localContent;
  }

  const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/markdown/by-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw new Error(`Failed to read markdown: ${response.statusText}`);
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object" || typeof (payload as { content?: unknown }).content !== "string") {
    throw new Error("Markdown service returned an invalid content payload.");
  }
  return (payload as { content: string }).content;
}

export async function uploadFile(file: File): Promise<FileInfo> {
  assertImportFileSize(file);
  if (isTauri) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'md' || ext === 'markdown') {
      const content = await file.text();
      const tempPath = await writeNativeTempFile(file.name, new TextEncoder().encode(content));
      try {
        return await openMarkdownFile(tempPath);
      } catch (error) {
        await removeManagedImportTemp(tempPath).catch(() => undefined);
        throw error;
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const tempPath = await writeNativeTempFile(file.name, new Uint8Array(arrayBuffer));
    try {
      return await openFile(tempPath);
    } catch (error) {
      await removeManagedImportTemp(tempPath).catch(() => undefined);
      throw error;
    }
  } else {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/files/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Failed to upload file: ${response.statusText}`);
      }
      return response.json();
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }
      debugWarn('api.uploadFile', 'backend unavailable; using browser-local mode');
      return uploadFileInBrowserLocal(file);
    }
  }
}

export async function listFiles(): Promise<{ files: FileInfo[] }> {
  if (isTauri) {
    const fileIds = await rustPdf.listPdfs();
    const files: FileInfo[] = [];

    for (const fileId of fileIds) {
      try {
        const info = await rustPdf.getPdfInfo(fileId);
        const doc = getCachedDocument(fileId);
        files.push({
          id: info.file_id,
          name: info.path.split(/[\\/]/).pop() || 'unknown',
          type: 'pdf',
          path: info.path,
          meta: {
            pages: doc ? doc.numPages : 0,
            size: `${(info.file_size / 1024 / 1024).toFixed(1)} MB`,
          },
        });
      } catch (error) {
        debugError('api.listFiles', 'failed to get file info', { fileId, error });
      }
    }

    return { files };
  } else {
    try {
      const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/files`);
      if (!response.ok) {
        throw new Error(`Failed to list files: ${response.statusText}`);
      }
      return response.json();
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      return { files: Array.from(browserLocalFiles.values()) };
    }
  }
}

export async function closeFile(fileId: string): Promise<{ success: boolean }> {
  if (isTauri) {
    const markdownPath = nativeMarkdownPaths.get(fileId);
    if (markdownPath) {
      nativeMarkdownPaths.delete(fileId);
      if (isManagedImportTempPath(markdownPath)) {
        await removeManagedImportTemp(markdownPath).catch(() => undefined);
      }
      return { success: true };
    }
    try {
      await closePdfDocument(fileId);
    } finally {
      await rustPdf.closePdf(fileId);
    }
    return { success: true };
  } else {
    if (browserLocalFiles.has(fileId)) {
      const local = browserLocalFiles.get(fileId);
      if (local) {
        browserLocalMarkdown.delete(local.path);
      }
      browserLocalMarkdown.delete(fileId);
      browserLocalFiles.delete(fileId);
      await closePdfDocument(fileId);
      return { success: true };
    }
    const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/files/${fileId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`Failed to close file: ${response.statusText}`);
    }
    return response.json();
  }
}

// ============ PDF.js Document Access ============

export function getPdfDocument(fileId: string): PDFDocumentProxy | undefined {
  return getCachedDocument(fileId);
}

export async function requestTiles(
  fileId: string,
  pageNo: number,
  zoom: number,
  viewport: TileViewport,
  tileSize = 512,
  renderScale?: number
): Promise<rustPdf.TileRequestAck> {
  debugLog('api.requestTiles', 'start', { fileId, pageNo, zoom, viewport, tileSize, renderScale, isTauri });
  if (!isTauri) {
    return { request_id: 'browser-noop', total_tiles: 0 };
  }
  const ack = await rustPdf.requestTiles(fileId, pageNo, zoom, viewport, tileSize, renderScale);
  debugLog('api.requestTiles', 'ack', ack);
  return ack;
}

export async function cancelTileRequest(requestId: string): Promise<void> {
  if (!isTauri || requestId === 'browser-noop') return;
  await rustPdf.cancelTileRequest(requestId);
}

export async function exportPagePNG(
  fileId: string,
  pageNo: number,
  zoom = 2,
  signal?: AbortSignal,
): Promise<string> {
  if (!isTauri) {
    throw new Error('exportPagePNG is only available in Tauri mode');
  }
  throwIfAborted(signal);
  const task = createExportCancellation(signal);
  try {
    const result = await rustPdf.exportPagePng(fileId, pageNo, zoom, task.requestId);
    throwIfAborted(signal);
    return result;
  } finally {
    task.cleanup();
  }
}

export async function extractPDFImage(
  fileId: string,
  pageNo: number,
  xref: number,
  signal?: AbortSignal,
): Promise<ExtractedPdfImage> {
  if (!isTauri) {
    throw new Error('extractPDFImage is only available in Tauri mode');
  }
  throwIfAborted(signal);
  const task = createExportCancellation(signal);
  let raw: string;
  try {
    raw = await rustPdf.extractPdfImage(fileId, pageNo, xref, task.requestId);
    throwIfAborted(signal);
  } finally {
    task.cleanup();
  }
  const parsed = JSON.parse(raw) as Partial<ExtractedPdfImage>;
  if (
    parsed.xref !== xref ||
    parsed.pageNumber !== pageNo ||
    typeof parsed.extension !== 'string' ||
    typeof parsed.dataBase64 !== 'string'
  ) {
    throw new Error('Rust returned an invalid extracted PDF image');
  }
  return parsed as ExtractedPdfImage;
}

export async function exportPageSVG(fileId: string, pageNo: number, signal?: AbortSignal): Promise<string> {
  if (!isTauri) {
    throw new Error('exportPageSVG is only available in Tauri mode');
  }
  throwIfAborted(signal);
  const task = createExportCancellation(signal);
  try {
    const result = await rustPdf.exportPageSvg(fileId, pageNo, task.requestId);
    throwIfAborted(signal);
    return result;
  } finally {
    task.cleanup();
  }
}

export async function exportPageSVGCrop(
  fileId: string,
  pageNo: number,
  rect: { left: number; top: number; width: number; height: number },
  signal?: AbortSignal,
): Promise<string> {
  if (!isTauri) {
    throw new Error('exportPageSVGCrop is only available in Tauri mode');
  }
  throwIfAborted(signal);
  const task = createExportCancellation(signal);
  try {
    const result = await rustPdf.exportPageSvgCrop(fileId, pageNo, rect, task.requestId);
    throwIfAborted(signal);
    return result;
  } finally {
    task.cleanup();
  }
}

export async function savePNGToFile(pngBase64: string, defaultFilename: string): Promise<void> {
  if (!isTauri) {
    throw new Error('savePNGToFile is only available in Tauri mode');
  }
  await rustPdf.savePngToFile(pngBase64, defaultFilename);
}

export async function saveImageToFile(
  dataBase64: string,
  defaultFilename: string,
  extension: string
): Promise<void> {
  if (!isTauri) {
    throw new Error('saveImageToFile is only available in Tauri mode');
  }
  const normalizedExtension = extension.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  await rustPdf.saveBinaryToFile(dataBase64, defaultFilename, [normalizedExtension]);
}

export async function saveSVGToFile(svgContent: string, defaultFilename: string): Promise<void> {
  if (!isTauri) {
    throw new Error('saveSVGToFile is only available in Tauri mode');
  }
  await rustPdf.saveSvgToFile(svgContent, defaultFilename);
}

// ============ PDF Info ============

export async function getPDFInfo(fileId: string): Promise<{
  pages: number;
  title: string;
  author: string;
  size: string;
}> {
  if (isTauri) {
    const info = await rustPdf.getPdfInfo(fileId);
    const doc = getCachedDocument(fileId);
    const pages = doc ? doc.numPages : info.page_count;
    return {
      pages: pages > 0 ? pages : 1,
      title: info.title || 'Untitled',
      author: info.author || 'Unknown',
      size: `${(info.file_size / 1024 / 1024).toFixed(1)} MB`,
    };
  } else {
    const local = browserLocalFiles.get(fileId);
    if (local) {
      const doc = getCachedDocument(fileId);
      const pages = doc ? doc.numPages : local.meta.pages || 1;
      return {
        pages,
        title: local.name,
        author: 'Unknown',
        size: local.meta.size || 'Unknown',
      };
    }
    const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/pdf/${fileId}/info`);
    if (!response.ok) {
      throw new Error(`Failed to get PDF info: ${response.statusText}`);
    }
    return response.json();
  }
}

// ============ PDF Image Extraction ============

export async function getPDFImages(
  fileId: string,
  pageNumber?: number,
  signal?: AbortSignal,
): Promise<{ images: PDFImageInfo[] }> {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
    }
  };
  throwIfAborted();
  const requestId = isTauri ? generateRuntimeId("pdf-images") : undefined;
  const cancelNativeTask = () => {
    if (!requestId) return;
    void rustPdf.cancelPdfImageScan(requestId).catch((error) => {
      debugWarn("api.getPDFImages", "failed to cancel native image scan", error);
    });
  };
  signal?.addEventListener("abort", cancelNativeTask, { once: true });
  try {
    if (isTauri) {
      if (!pageNumber || pageNumber < 1) return { images: [] };
      let json: string;
      try {
        json = await rustPdf.getPageImages(fileId, pageNumber, requestId);
      } catch (error) {
        throwIfAborted();
        throw error;
      }
      throwIfAborted();
      const raw = JSON.parse(json) as unknown;
      const images = Array.isArray(raw)
        ? raw
          .map((item): PDFImageInfo | null => {
            if (!item || typeof item !== 'object') return null;
            const obj = item as Record<string, unknown>;
            const bboxRaw = obj.bbox;
            const bbox = Array.isArray(bboxRaw) && bboxRaw.length === 4
              ? bboxRaw.map((value) => Number(value))
              : undefined;
            const pageNumberValue = Number(obj.pageNumber);
            const width = Number(obj.width);
            const height = Number(obj.height);
            const pageWidthValue = Number(obj.pageWidth);
            const pageHeightValue = Number(obj.pageHeight);
            const xref = Number(obj.xref);
            const extension = typeof obj.extension === 'string' ? obj.extension.trim() : '';
            const source = obj.source;

            if (
              !Number.isInteger(pageNumberValue) || pageNumberValue !== pageNumber ||
              !Number.isFinite(width) || width <= 0 ||
              !Number.isFinite(height) || height <= 0 ||
              extension.length === 0 ||
              !Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) ||
              (source !== 'xref' && source !== 'block' && source !== 'vector') ||
              (source === 'xref' && (!Number.isInteger(xref) || xref < 1)) ||
              (source !== 'xref' && (!Number.isInteger(xref) || xref < 0)) ||
              (obj.pageWidth !== undefined && (!Number.isFinite(pageWidthValue) || pageWidthValue <= 0)) ||
              (obj.pageHeight !== undefined && (!Number.isFinite(pageHeightValue) || pageHeightValue <= 0))
            ) {
              return null;
            }

            return {
              xref,
              pageNumber: pageNumberValue,
              width,
              height,
              pageWidth: obj.pageWidth === undefined ? undefined : pageWidthValue,
              pageHeight: obj.pageHeight === undefined ? undefined : pageHeightValue,
              extension,
              bbox,
              source,
            };
          })
          .filter((item): item is PDFImageInfo => item !== null)
        : [];
      return { images };
    }

    const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/pdf/${fileId}/images`, { signal });
    if (!response.ok) {
      throw new Error(`Failed to get PDF images: ${response.statusText}`);
    }

    const payload = (await response.json()) as unknown;
    const rawImages = payload && typeof payload === "object" && Array.isArray((payload as { images?: unknown }).images)
      ? (payload as { images: unknown[] }).images
      : [];
    const images = rawImages
      .map((item): PDFImageInfo | null => {
        if (!item || typeof item !== "object") return null;
        const obj = item as Record<string, unknown>;
        const xref = Number(obj.xref);
        const itemPage = Number(obj.pageNumber);
        const width = Number(obj.width);
        const height = Number(obj.height);
        const pageWidth = obj.pageWidth === undefined ? undefined : Number(obj.pageWidth);
        const pageHeight = obj.pageHeight === undefined ? undefined : Number(obj.pageHeight);
        const extension = typeof obj.extension === "string" ? obj.extension.trim() : "";
        const bbox = Array.isArray(obj.bbox) && obj.bbox.length === 4
          ? obj.bbox.map((value) => Number(value))
          : undefined;
        const source = obj.source === "block" || obj.source === "vector" || obj.source === "xref"
          ? obj.source
          : xref > 0
            ? "xref"
            : undefined;
        if (
          !Number.isInteger(xref) || xref < 0 ||
          !Number.isInteger(itemPage) || itemPage < 1 || (pageNumber !== undefined && itemPage !== pageNumber) ||
          !Number.isFinite(width) || width <= 0 ||
          !Number.isFinite(height) || height <= 0 ||
          extension.length === 0 ||
          (bbox !== undefined && (bbox.length !== 4 || !bbox.every(Number.isFinite))) ||
          !source ||
          (source === "xref" && xref < 1) ||
          (pageWidth !== undefined && (!Number.isFinite(pageWidth) || pageWidth <= 0)) ||
          (pageHeight !== undefined && (!Number.isFinite(pageHeight) || pageHeight <= 0))
        ) {
          return null;
        }
        return {
          xref,
          pageNumber: itemPage,
          width,
          height,
          pageWidth,
          pageHeight,
          extension,
          bbox,
          source,
        };
      })
      .filter((item): item is PDFImageInfo => item !== null);
    if (!pageNumber) return { images };
    return {
      images,
    };
  } finally {
    signal?.removeEventListener("abort", cancelNativeTask);
  }
}

export async function getPDFReadingBlocks(
  fileId: string,
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
  range?: { startPage?: number; endPage?: number }
): Promise<PdfReadingBlock[]> {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
    }
  };
  throwIfAborted();
  const requestId = isTauri ? generateRuntimeId("pdf-blocks") : undefined;
  const cancelNativeTask = () => {
    if (!requestId) return;
    void rustPdf.cancelPdfPageCount(requestId).catch((error) => {
      debugWarn("api.getPDFReadingBlocks", "failed to cancel native page count", error);
    });
    void rustPdf.cancelPdfReadingBlocks(requestId).catch((error) => {
      debugWarn("api.getPDFReadingBlocks", "failed to cancel native reading block task", error);
    });
  };
  signal?.addEventListener("abort", cancelNativeTask, { once: true });
  if (isTauri) {
    try {
      const total = await rustPdf.getPageCount(fileId, requestId);
      throwIfAborted();
      const chunkSize = 24;
      const blocks: PdfReadingBlock[] = [];
      const firstPage = Math.max(1, Math.min(total, Math.round(range?.startPage ?? 1)));
      const lastPage = Math.max(firstPage, Math.min(total, Math.round(range?.endPage ?? total)));
      for (let startPage = firstPage; startPage <= lastPage; startPage += chunkSize) {
        throwIfAborted();
        const endPage = Math.min(lastPage, startPage + chunkSize - 1);
        let json: string;
        try {
          json = await rustPdf.getPdfReadingBlocks(fileId, startPage, endPage, requestId);
        } catch (error) {
          throwIfAborted();
          throw error;
        }
        throwIfAborted();
        const raw = JSON.parse(json) as unknown;
        blocks.push(...normalizePdfReadingBlocks(raw));
        onProgress?.(endPage, total);
      }
      return blocks;
    } finally {
      signal?.removeEventListener("abort", cancelNativeTask);
    }
  }

  try {
    const doc = getCachedDocument(fileId);
    if (!doc) throw new Error(`PDF document is not loaded: ${fileId}`);
    const blocks: PdfReadingBlock[] = [];
    const firstPage = Math.max(1, Math.min(doc.numPages, Math.round(range?.startPage ?? 1)));
    const lastPage = Math.max(firstPage, Math.min(doc.numPages, Math.round(range?.endPage ?? doc.numPages)));
    for (let pageNo = firstPage; pageNo <= lastPage; pageNo += 1) {
      throwIfAborted();
      const page = await doc.getPage(pageNo);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        throwIfAborted();
        const items = content.items as Array<Record<string, unknown>>;
        const text = items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;

        const rects = items
          .map((item) => {
            const transform = Array.isArray(item.transform) ? item.transform.map(Number) : [];
            const x = Number(transform[4]);
            const baseline = Number(transform[5]);
            const width = Number(item.width);
            const height = Number(item.height) || Math.abs(Number(transform[3]));
            if (![x, baseline, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
            return {
              left: x,
              top: viewport.height - baseline - height,
              right: x + width,
              bottom: viewport.height - baseline,
            };
          })
          .filter((rect): rect is { left: number; top: number; right: number; bottom: number } => Boolean(rect));
        const left = rects.length > 0 ? Math.max(0, Math.min(...rects.map((rect) => rect.left))) : 0;
        const top = rects.length > 0 ? Math.max(0, Math.min(...rects.map((rect) => rect.top))) : 0;
        const right = rects.length > 0 ? Math.min(viewport.width, Math.max(...rects.map((rect) => rect.right))) : viewport.width;
        const bottom = rects.length > 0 ? Math.min(viewport.height, Math.max(...rects.map((rect) => rect.bottom))) : viewport.height;
        blocks.push({
          id: `pdfjs-${pageNo}-text`,
          page: pageNo,
          kind: "text",
          text,
          rect: {
            x: left / Math.max(1, viewport.width),
            y: top / Math.max(1, viewport.height),
            width: Math.max(0.01, (right - left) / Math.max(1, viewport.width)),
            height: Math.max(0.01, (bottom - top) / Math.max(1, viewport.height)),
          },
          source: "pdfjs-dom",
        });
        onProgress?.(pageNo, doc.numPages);
      } finally {
        page.cleanup();
      }
    }
    return blocks;
  } finally {
    signal?.removeEventListener("abort", cancelNativeTask);
  }
}

// ============ Markdown Operations ============

export async function saveMarkdown(
  fileId: string,
  content: string
): Promise<{ success: boolean }> {
  if (isTauri) {
    const path = nativeMarkdownPaths.get(fileId);
    if (!path) throw new Error('Markdown file is not open in the native runtime');
    await writeNativeTextFile(path, content);
    return { success: true };
  }
  const response = await fetchBrowserRequest(`${BROWSER_API_BASE}/api/markdown/${fileId}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save markdown: ${response.statusText}`);
  }

  return response.json();
}
