import { invoke } from "@tauri-apps/api/core";

const isTauriRuntime =
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);

// invoke 静态引入：@tauri-apps/api/core 早已进入入口 chunk（debugLogger /
// nativeFiles / rustPdf 都是静态引入），原来的 await import() 拿不到任何代码
// 分割收益，只会让 Rollup 报 "dynamic import will not move module into another
// chunk"。这里保留 async 签名只是为了不改调用方的 await 语义。
async function invokeNative<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, payload);
}

export function canUseNativeWebview(): boolean {
  return isTauriRuntime;
}

export async function createOrShowNativeWebviewTab(
  tabId: string,
  url: string,
  title?: string,
  focus = false
): Promise<void> {
  if (!isTauriRuntime || !tabId || !url) return;
  await invokeNative<string>("create_or_show_webview_tab", {
    tabId,
    url,
    title: title || null,
    focus,
  });
}

export async function navigateNativeWebviewTab(tabId: string, url: string): Promise<void> {
  if (!isTauriRuntime || !tabId || !url) return;
  await invokeNative<string>("navigate_webview_tab", { tabId, url });
}

export async function navigateNativeWebviewTabHistory(tabId: string, direction: "back" | "forward"): Promise<void> {
  if (!isTauriRuntime || !tabId) return;
  await invokeNative<string>("navigate_webview_tab_history", { tabId, direction });
}

export async function showNativeWebviewTab(tabId: string, focus = false): Promise<void> {
  if (!isTauriRuntime || !tabId) return;
  await invokeNative<string>("show_webview_tab", { tabId, focus });
}

export async function hideNativeWebviewTab(tabId: string): Promise<void> {
  if (!isTauriRuntime || !tabId) return;
  await invokeNative<string>("hide_webview_tab", { tabId });
}

export async function closeNativeWebviewTab(tabId: string): Promise<void> {
  if (!isTauriRuntime || !tabId) return;
  await invokeNative<string>("close_webview_tab", { tabId });
}

export async function syncNativeWebviewTabBounds(
  tabId: string,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<void> {
  if (!isTauriRuntime || !tabId) return;
  await invokeNative<string>("sync_webview_tab_bounds", {
    tabId,
    x,
    y,
    width,
    height,
  });
}
