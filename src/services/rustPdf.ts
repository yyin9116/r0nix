import { invoke } from '@tauri-apps/api/core';
import { save } from "@tauri-apps/plugin-dialog";
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

export async function getPageCount(fileId: string, requestId?: string): Promise<number> {
  return await invoke<number>('get_page_count', { fileId, requestId });
}

export async function listPdfs(): Promise<string[]> {
  return await invoke<string[]>('list_pdfs');
}

/**
 * 读取已打开 PDF 的原始字节，交给 pdf.js。
 *
 * Rust 侧以 **base64 字符串**返回，不是 `Vec<u8>`。这不是风格差异：
 * Tauri 2 在 macOS 上的 IPC 只能传文本，`Vec<u8>` 会被 `serde_json` 展开成
 * **十进制数字数组**（3.55 字符/字节），再被 `JSON.parse` 成一个 JS 数字数组
 * （V8 实测量到 7.2 字节/元素）—— 端到端 ≈ 19–23 倍文件大小的瞬时峰值，
 * 是「打开 200 页 PDF 内存 2G+」的主因。逐条源码依据见
 * `src-tauri/src/tauri_commands.rs` 里 `read_opened_pdf_bytes` 的头部注释。
 *
 * 兼容分支：测试桩与旧构建可能仍回传 `Uint8Array` / `number[]`，
 * 一并接住，免得只因为载荷形态变化就在打开文档这一步炸掉。
 */
export async function readOpenedPdfBytes(fileId: string, requestId?: string): Promise<Uint8Array> {
  const raw = await invoke<unknown>('read_opened_pdf_bytes', { fileId, requestId });
  if (typeof raw === 'string') return base64ToBytes(raw);
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error('read_opened_pdf_bytes returned invalid payload');
}

/**
 * dev-only：读取「启动即自动打开」的路径，供内存/性能量测自动化使用。
 *
 * 真实 Tauri 的 IPC 路径（base64 编码 + 传输 + JS 解码）只能在真实应用里量 ——
 * 浏览器探针走 `file.arrayBuffer()`，完全绕过它。而 macOS 上驱动真实应用的 UI
 * 需要辅助功能权限（本机未授权），所以由环境变量 `R0NIX_AUTO_OPEN` 注入路径。
 *
 * Rust 侧 `dev_auto_open_path` 在 **release 构建恒返回 null**，
 * 且调用点有 `import.meta.env.DEV` 守卫 → 生产环境这段永远不会执行。
 */
export async function readDevAutoOpenPath(): Promise<string | null> {
  const value = await invoke<string | null>('dev_auto_open_path');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * dev-only：自动打开的文档在多少毫秒后关闭（`R0NIX_AUTO_CLOSE_MS`）。
 *
 * 与 `readDevAutoOpenPath` 配套 —— 打开只能量「驻留多少」，关闭才能量
 * 「是否真的释放」，而后者是「驻留 vs 泄漏」的分水岭。**`0` = 打开后立即关闭**，
 * 用于绕开 WKWebView 对不可见窗口的 `setTimeout` 节流（长定时器实测不触发）。
 * release 恒为 null。
 */
export async function readDevAutoCloseAfterMs(): Promise<number | null> {
  const value = await invoke<number | null>('dev_auto_close_after_ms');
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * dev-only：自动打开的文档在多少毫秒后执行**哪些关闭动作**（`R0NIX_AUTO_CLOSE_ACTIONS`）。
 *
 * 为什么需要「动作」而不是一个开关：`closeFile` 与「用户按了标签上的关闭按钮」
 * 是**两件不同的事** —— 前者只销毁 pdf.js 文档与 Rust 句柄，标签仍留在界面上、
 * viewer 与它的画布都没卸载；后者走 `handleCloseTab`，会移除标签、卸载 viewer，
 * 再排队释放文件。把两者混为一谈，会把「没卸载」误读成「卸载了也不释放」。
 *
 * 取值是逗号分隔的动作名，按顺序执行：
 *  · `file`    —— `api.closeFile(fileId)`（只销毁文档，**不**移除标签）
 *  · `tab`     —— `handleCloseTab(tabId)`（真实关标签：卸载 viewer + 释放文件）
 *  · `workers` —— 强制 `terminate()` 全部仍在世的 Web Worker
 *
 * 不设该变量时**默认 `["file"]`**，与历史行为一致。未知动作名会被原样返回，
 * 由调用点记成警告 —— 静默忽略拼错的动作名会让整组对照失去意义。
 * release 构建恒为 null。
 */
export async function readDevAutoCloseActions(): Promise<string[] | null> {
  const value = await invoke<string | null>('dev_auto_close_actions');
  if (typeof value !== 'string') return null;
  const actions = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return actions.length > 0 ? actions : null;
}

/**
 * dev-only：**循环模式**（`R0NIX_AUTO_CYCLE=1`）—— 每打开一份就立刻关掉它，
 * 于「文档数」等于「轮数」，在同一进程内重复「打开 → 关闭」。
 *
 * 为什么需要它：单轮只量得到「关掉后还剩多少」；要判断剩下的是**泄漏**（每轮线性
 * 累加）还是**水位**（首次冲高后复用、不再增长），必须在同一进程内比第 1 轮与第 N 轮。
 * 跨会话比较受系统内存压力影响，能差出几百 MB。
 * release 构建恒为 false。
 */
export async function readDevAutoCycle(): Promise<boolean> {
  return (await invoke<boolean>('dev_auto_cycle')) === true;
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
  zoom = 2,
  requestId?: string,
): Promise<string> {
  return await invoke<string>("export_page_png", { fileId, pageNo, zoom, requestId });
}

export async function cancelPdfByteRead(requestId: string): Promise<void> {
  await invoke('cancel_pdf_byte_read', { requestId });
}

export async function cancelPdfPageCount(requestId: string): Promise<void> {
  await invoke('cancel_pdf_page_count', { requestId });
}

export async function extractPdfImage(
  fileId: string,
  pageNo: number,
  xref: number,
  requestId?: string,
): Promise<string> {
  return await invoke<string>("extract_pdf_image", { fileId, pageNo, xref, requestId });
}

export async function exportPageSvg(
  fileId: string,
  pageNo: number,
  requestId?: string,
): Promise<string> {
  return await invoke<string>("export_page_svg", { fileId, pageNo, requestId });
}

export async function exportPageSvgCrop(
  fileId: string,
  pageNo: number,
  rect: { left: number; top: number; width: number; height: number }
  , requestId?: string
): Promise<string> {
  return await invoke<string>("export_page_svg_crop", {
    fileId,
    pageNo,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    requestId,
  });
}

export async function cancelPdfExport(requestId: string): Promise<void> {
  await invoke("cancel_pdf_export", { requestId });
}


export async function getPageImages(
  fileId: string,
  pageNo: number,
  requestId?: string,
): Promise<string> {
  return await invoke<string>("get_page_images", { fileId, pageNo, requestId });
}

export async function cancelPdfImageScan(requestId: string): Promise<void> {
  await invoke("cancel_pdf_image_scan", { requestId });
}

export async function getPdfReadingBlocks(
  fileId: string,
  startPage?: number,
  endPage?: number,
  requestId?: string,
): Promise<string> {
  return await invoke<string>("get_pdf_reading_blocks", { fileId, startPage, endPage, requestId });
}

export async function cancelPdfReadingBlocks(requestId: string): Promise<void> {
  await invoke("cancel_pdf_reading_blocks", { requestId });
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
