const isTauriRuntime =
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);

async function invokeNative<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
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
