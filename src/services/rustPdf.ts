import { invoke } from '@tauri-apps/api/core';
import { writeNativeBinaryFile, writeNativeTextFile } from "./nativeFiles";

export interface PdfInfo {
  file_id: string;
  path: string;
  page_count: number;
  title?: string;
  author?: string;
  file_size: number;
}

export interface TileViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileRequestAck {
  request_id: string;
  total_tiles: number;
}

export interface TileReadyPayload {
  request_id: string;
  file_id: string;
  page_no: number;
  zoom: number;
  tile_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: string;
  png_base64?: string | null;
}

export async function openPdf(fileId: string, path: string): Promise<PdfInfo> {
  return await invoke<PdfInfo>('open_pdf', { fileId, path });
}

export async function closePdf(fileId: string): Promise<void> {
  await invoke('close_pdf', { fileId });
}

export async function getPdfInfo(fileId: string): Promise<PdfInfo> {
  return await invoke<PdfInfo>('get_pdf_info', { fileId });
}

export async function getPageCount(fileId: string): Promise<number> {
  return await invoke<number>('get_page_count', { fileId });
}

export async function listPdfs(): Promise<string[]> {
  return await invoke<string[]>('list_pdfs');
}

export async function readOpenedPdfBytes(fileId: string): Promise<Uint8Array> {
  const raw = await invoke<unknown>('read_opened_pdf_bytes', { fileId });
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error('read_opened_pdf_bytes returned invalid payload');
}

export async function requestTiles(
  fileId: string,
  pageNo: number,
  zoom: number,
  viewport: TileViewport,
  tileSize = 512,
  renderScale?: number
): Promise<TileRequestAck> {
  return await invoke<TileRequestAck>("request_tiles", {
    fileId,
    pageNo,
    zoom,
    viewport,
    tileSize,
    renderScale,
  });
}

export async function cancelTileRequest(requestId: string): Promise<void> {
  await invoke("cancel_tile_request", { requestId });
}

export async function exportPagePng(
  fileId: string,
  pageNo: number,
  zoom = 2
): Promise<string> {
  return await invoke<string>("export_page_png", { fileId, pageNo, zoom });
}

export async function extractPdfImage(
  fileId: string,
  pageNo: number,
  xref: number
): Promise<string> {
  return await invoke<string>("extract_pdf_image", { fileId, pageNo, xref });
}

export async function exportPageSvg(
  fileId: string,
  pageNo: number
): Promise<string> {
  return await invoke<string>("export_page_svg", { fileId, pageNo });
}

export async function exportPageSvgCrop(
  fileId: string,
  pageNo: number,
  rect: { left: number; top: number; width: number; height: number }
): Promise<string> {
  return await invoke<string>("export_page_svg_crop", {
    fileId,
    pageNo,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  });
}


export async function getPageImages(
  fileId: string,
  pageNo: number
): Promise<string> {
  return await invoke<string>("get_page_images", { fileId, pageNo });
}

export async function getPdfReadingBlocks(fileId: string, startPage?: number, endPage?: number): Promise<string> {
  return await invoke<string>("get_pdf_reading_blocks", { fileId, startPage, endPage });
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function savePngToFile(
  pngBase64: string,
  defaultFilename: string
): Promise<void> {
  await saveBinaryToFile(pngBase64, defaultFilename, ["png"]);
}

export async function saveBinaryToFile(
  dataBase64: string,
  defaultFilename: string,
  extensions: string[]
): Promise<void> {
  const { save } = await import("@tauri-apps/plugin-dialog");

  const filePath = await save({
    defaultPath: defaultFilename,
    filters: [
      {
        name: "Image",
        extensions,
      },
    ],
  });

  if (filePath) {
    await writeNativeBinaryFile(filePath, base64ToBytes(dataBase64));
  }
}

export async function saveSvgToFile(
  svgContent: string,
  defaultFilename: string
): Promise<void> {
  const { save } = await import('@tauri-apps/plugin-dialog');

  const filePath = await save({
    defaultPath: defaultFilename,
    filters: [
      {
        name: 'SVG Vector Graphics',
        extensions: ['svg'],
      },
    ],
  });

  if (filePath) {
    await writeNativeTextFile(filePath, svgContent);
  }
}
