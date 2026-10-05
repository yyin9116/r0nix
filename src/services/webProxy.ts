import { invoke } from "@tauri-apps/api/core";
import { debugError } from "./debugLogger";

export const DIRECT_RESOURCE_TIMEOUT_MS = 30_000;
export const DIRECT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const DIRECT_PDF_MAX_BYTES = 512 * 1024 * 1024;

function byteLimitLabel(maxBytes: number) {
  return `${Math.max(1, Math.ceil(maxBytes / 1024 / 1024))} MiB`;
}

export interface ProxyDownloadResult {
  bytes: ArrayBuffer;
  finalUrl: string;
  contentType: string;
  contentDisposition: string;
  status: number;
}

export async function downloadDirectHttpResource(
  url: string,
  options?: { maxBytes?: number; timeoutMs?: number },
): Promise<ProxyDownloadResult> {
  const maxBytes = options?.maxBytes ?? DIRECT_DOWNLOAD_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DIRECT_RESOURCE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(new Error("resource download timed out")), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`resource exceeds ${byteLimitLabel(maxBytes)} limit`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`resource exceeds ${byteLimitLabel(maxBytes)} limit`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const value = new Uint8Array(await response.arrayBuffer());
      if (value.byteLength > maxBytes) {
        throw new Error(`resource exceeds ${byteLimitLabel(maxBytes)} limit`);
      }
      chunks.push(value);
      total = value.byteLength;
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes: bytes.buffer,
      finalUrl: response.url || url,
      contentType: response.headers.get("content-type") || "",
      contentDisposition: response.headers.get("content-disposition") || "",
      status: response.status,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

interface NativeProxyDownloadPayload {
  dataBase64: string;
  finalUrl: string;
  contentType?: string;
  contentDisposition?: string;
  statusCode: number;
}

export interface NativePdfDownloadPayload {
  path: string;
  fileName: string;
  finalUrl: string;
}

function decodeBase64(input: string): ArrayBuffer {
  const raw = atob(input);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out.buffer as ArrayBuffer;
}

export async function downloadPdfViaProxy(url: string, proxyUrl: string): Promise<ProxyDownloadResult | null> {
  const trimmedProxy = proxyUrl.trim();
  if (!trimmedProxy) return null;
  try {
    const payload = await invoke<NativeProxyDownloadPayload>("download_pdf_via_proxy", {
      url,
      proxy_url: trimmedProxy,
    });
    return {
      bytes: decodeBase64(payload.dataBase64),
      finalUrl: payload.finalUrl || url,
      contentType: payload.contentType || "",
      contentDisposition: payload.contentDisposition || "",
      status: payload.statusCode || 0,
    };
  } catch (error) {
    debugError("proxy", "download via proxy failed", { url, error });
    return null;
  }
}

export async function downloadPdfToNativeTemp(url: string, proxyUrl?: string): Promise<NativePdfDownloadPayload> {
  return invoke<NativePdfDownloadPayload>("download_pdf_to_temp", {
    url,
    proxy_url: proxyUrl?.trim() || null,
  });
}

export async function removeManagedWebPdfTemp(path: string): Promise<void> {
  await invoke("remove_managed_web_pdf_temp", { path });
}
