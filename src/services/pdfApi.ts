/**
 * Unified PDF API adapter
 *
 * Auto-detects environment:
 * - Tauri: Uses Rust backend for file I/O + PDF.js for rendering
 * - Browser: Uses Python backend
 */

import * as rustPdf from './rustPdf';
import { loadPdfDocument, getCachedDocument, closePdfDocument } from './pdfJsService';
import { debugError, debugLog } from './debugLogger';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const isTauri =
  typeof window !== 'undefined' &&
  ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

console.log(`[API Adapter] Running in ${isTauri ? 'Tauri' : 'Browser'} mode`);

const BROWSER_API_BASE = 'http://localhost:8000';
const browserLocalFiles = new Map<string, FileInfo>();

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
  return `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function uploadFileInBrowserLocal(file: File): Promise<FileInfo> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext !== 'pdf') {
    throw new Error('Browser fallback currently supports PDF files only');
  }
  const fileId = generateBrowserFileId();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await loadPdfDocument(fileId, data);
  const info: FileInfo = {
    id: fileId,
    name: file.name,
    type: 'pdf',
    path: file.name,
    meta: {
      pages: doc.numPages,
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
    words?: number;
    readTime?: number;
    size?: string;
  };
}

export interface MarkdownContentResponse {
  content: string;
  wordCount: number;
  readTime: number;
}

export interface PDFImageInfo {
  xref: number;
  pageNumber: number;
  width: number;
  height: number;
  extension: string;
  bbox?: number[];
}

export interface ExtractedImage {
  page: number;
  index: number;
  path: string;
  size: string;
  width: number;
  height: number;
}

export interface ExtractImagesResponse {
  images: ExtractedImage[];
  outputDir: string;
  total: number;
}

export interface TileViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TileReadyPayload = rustPdf.TileReadyPayload;

// ============ File Management ============

export async function openFile(path: string): Promise<FileInfo> {
  debugLog('api.openFile', 'start', { path, isTauri });
  if (isTauri) {
    const fileId = `file-${Date.now()}`;
    const info = await rustPdf.openPdf(fileId, path);
    debugLog('api.openFile', 'rust open_pdf success', info);
    let pages = info.page_count;
    try {
      const data = await rustPdf.readOpenedPdfBytes(info.file_id);
      const doc = await loadPdfDocument(info.file_id, data);
      pages = doc.numPages;
      debugLog('api.openFile', 'pdfjs loaded', { pages });
    } catch (error) {
      console.warn('[API Adapter] PDF.js load failed, keep rust page count:', error);
      debugError('api.openFile', 'pdfjs load failed', error);
    }

    return {
      id: info.file_id,
      name: path.split(/[\\/]/).pop() || 'unknown',
      type: 'pdf',
      path: info.path,
      meta: {
        pages: pages > 0 ? pages : undefined,
        size: `${(info.file_size / 1024 / 1024).toFixed(1)} MB`,
      },
    };
  } else {
    try {
      const response = await fetch(`${BROWSER_API_BASE}/api/files/open`, {
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

export async function uploadFile(file: File): Promise<FileInfo> {
  if (isTauri) {
    const { writeFile } = await import('@tauri-apps/plugin-fs');

    const tempPath = `${await getTempDir()}/${file.name}`;
    const arrayBuffer = await file.arrayBuffer();
    await writeFile(tempPath, new Uint8Array(arrayBuffer));

    return openFile(tempPath);
  } else {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${BROWSER_API_BASE}/api/files/upload`, {
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
      console.warn('[API Adapter] backend unavailable, switch to browser local mode');
      return uploadFileInBrowserLocal(file);
    }
  }
}

async function getTempDir(): Promise<string> {
  const { tempDir } = await import('@tauri-apps/api/path');
  return await tempDir();
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
        console.error(`Failed to get info for ${fileId}:`, error);
      }
    }

    return { files };
  } else {
    try {
      const response = await fetch(`${BROWSER_API_BASE}/api/files`);
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
    await closePdfDocument(fileId);
    await rustPdf.closePdf(fileId);
    return { success: true };
  } else {
    if (browserLocalFiles.has(fileId)) {
      browserLocalFiles.delete(fileId);
      await closePdfDocument(fileId);
      return { success: true };
    }
    const response = await fetch(`${BROWSER_API_BASE}/api/files/${fileId}`, {
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
  zoom = 2
): Promise<string> {
  if (!isTauri) {
    throw new Error('exportPagePNG is only available in Tauri mode');
  }
  return rustPdf.exportPagePng(fileId, pageNo, zoom);
}

export async function exportPageSVG(fileId: string, pageNo: number): Promise<string> {
  if (!isTauri) {
    throw new Error('exportPageSVG is only available in Tauri mode');
  }
  return rustPdf.exportPageSvg(fileId, pageNo);
}

export async function savePNGToFile(pngBase64: string, defaultFilename: string): Promise<void> {
  if (!isTauri) {
    throw new Error('savePNGToFile is only available in Tauri mode');
  }
  await rustPdf.savePngToFile(pngBase64, defaultFilename);
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
    const response = await fetch(`${BROWSER_API_BASE}/api/pdf/${fileId}/info`);
    if (!response.ok) {
      throw new Error(`Failed to get PDF info: ${response.statusText}`);
    }
    return response.json();
  }
}

// ============ PDF Image Extraction (Python backend only) ============

export async function getPDFImages(fileId: string): Promise<{ images: PDFImageInfo[] }> {
  if (isTauri) {
    console.warn('[API Adapter] getPDFImages not implemented in Rust backend yet');
    return { images: [] };
  } else {
    const response = await fetch(`http://localhost:8000/api/pdf/${fileId}/images`);

    if (!response.ok) {
      throw new Error(`Failed to get PDF images: ${response.statusText}`);
    }

    return response.json();
  }
}

export async function getPDFImage(fileId: string, xref: number): Promise<Blob> {
  if (isTauri) {
    throw new Error('getPDFImage not implemented in Rust backend yet');
  } else {
    const response = await fetch(`http://localhost:8000/api/pdf/${fileId}/image/${xref}`);

    if (!response.ok) {
      throw new Error(`Failed to get PDF image: ${response.statusText}`);
    }

    return response.blob();
  }
}

export async function getPDFImageSVG(fileId: string, pageNumber: number, xref: number): Promise<Blob> {
  if (isTauri) {
    throw new Error('getPDFImageSVG not implemented in Rust backend yet');
  } else {
    const response = await fetch(`http://localhost:8000/api/pdf/${fileId}/page/${pageNumber}/image/${xref}/svg`);

    if (!response.ok) {
      throw new Error(`Failed to get PDF SVG: ${response.statusText}`);
    }

    return response.blob();
  }
}

export async function extractPDFImages(
  fileId: string,
  pages?: number[],
  deduplicate: boolean = true
): Promise<ExtractImagesResponse> {
  if (isTauri) {
    throw new Error('extractPDFImages not implemented in Rust backend yet');
  } else {
    const response = await fetch(`http://localhost:8000/api/pdf/${fileId}/extract-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages, deduplicate }),
    });

    if (!response.ok) {
      throw new Error(`Failed to extract images: ${response.statusText}`);
    }

    return response.json();
  }
}

// ============ Markdown Operations ============

export async function getMarkdownContent(
  fileId: string
): Promise<MarkdownContentResponse> {
  if (isTauri) {
    throw new Error('Markdown not implemented in Rust backend yet');
  } else {
    const response = await fetch(`http://localhost:8000/api/markdown/${fileId}/content`);

    if (!response.ok) {
      throw new Error(`Failed to get markdown content: ${response.statusText}`);
    }

    return response.json();
  }
}

export async function saveMarkdown(
  fileId: string,
  content: string
): Promise<{ success: boolean }> {
  if (isTauri) {
    throw new Error('Markdown not implemented in Rust backend yet');
  } else {
    const response = await fetch(`http://localhost:8000/api/markdown/${fileId}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      throw new Error(`Failed to save markdown: ${response.statusText}`);
    }

    return response.json();
  }
}

export async function previewMarkdown(content: string): Promise<{ html: string }> {
  if (isTauri) {
    throw new Error('Markdown not implemented in Rust backend yet');
  } else {
    const response = await fetch(`http://localhost:8000/api/markdown/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      throw new Error(`Failed to preview markdown: ${response.statusText}`);
    }

    return response.json();
  }
}
