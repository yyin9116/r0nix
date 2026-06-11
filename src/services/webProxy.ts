import { debugError } from "./debugLogger";

export interface ProxyDownloadResult {
  bytes: ArrayBuffer;
  finalUrl: string;
  contentType: string;
  contentDisposition: string;
  status: number;
}

interface NativeProxyDownloadPayload {
  dataBase64: string;
  finalUrl: string;
  contentType?: string;
  contentDisposition?: string;
  statusCode: number;
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
    const { invoke } = await import("@tauri-apps/api/core");
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
