import { readFileSync } from "node:fs";

const app = readFileSync("src/App.tsx", "utf8");
const rust = readFileSync("src-tauri/src/tauri_commands.rs", "utf8");
const browser = readFileSync("src/components/WebBrowser.tsx", "utf8");
const registry = readFileSync("src-tauri/src/main.rs", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(app.includes("openingPdfUrlsRef"), "PDF URL opens must be deduplicated");
assert(app.includes("sourceTabId && !latestTabsRef.current.some"), "late PDF events must be ignored after the source web tab is removed");
assert(app.includes("assertPdfPayload"), "downloaded PDF payloads must be validated before opening");
assert(app.includes("safePdfFileName"), "download filenames must be safe before writing temp files");
assert(app.includes("event.payload?.tabId"), "native PDF events must retain their source tab id");
assert(app.includes("hideNativeWebviewTab(sourceTabId)"), "source webview must be hidden before opening the PDF");
assert(rust.includes("WEBVIEW_TABS.lock().await.remove(&tab_id)"), "closing a webview must unregister it before teardown");
assert(rust.includes("pub async fn download_pdf_to_temp"), "native PDF opens must stream to a temp file");
assert(/output\s*\.\s*write_all\(&chunk\)/.test(rust), "native PDF downloads must avoid transferring the whole file through IPC");
assert(registry.includes("tauri_commands::download_pdf_to_temp"), "native PDF download command must be registered");
assert(rust.includes("pub async fn remove_managed_web_pdf_temp"), "failed native PDF opens must have a guarded temp cleanup command");
assert(registry.includes("tauri_commands::remove_managed_web_pdf_temp"), "managed PDF temp cleanup command must be registered");
assert(app.includes("removeManagedWebPdfTemp(downloaded.path)"), "failed or orphaned native PDF opens must remove their temp file");
assert(app.includes("failed to remove managed PDF temp after tab close"), "closing a web PDF tab must remove its managed temp file");
assert(app.includes("const browserFile = new File([bytes], fileName"), "browser PDF opens must use the browser upload adapter outside Tauri");
assert(app.includes("await api.uploadFile(browserFile)"), "browser PDF opens must not call Tauri-only temp-file IPC");
assert(app.includes("URL.createObjectURL(new Blob([bytes]"), "browser resource downloads must use a browser-safe Blob path");
assert(app.includes("latestTabsRef.current.some((tab) => tab.id === sourceTabId"), "closing the source web tab must cancel the late PDF open");
assert(app.includes("failed to release late browser PDF upload"), "browser PDF uploads must release late results after the source web tab closes");
assert(browser.includes('listen<{ tabId: string }>("r0nix://webview-pdf-link"'), "the web tab must show loading state as soon as native PDF navigation is intercepted");
assert(browser.includes("looksLikePdfUrl(normalized) && onOpenPdfInApp"), "direct PDF address navigation must bypass the native WebView");
assert(rust.includes("webview::{DownloadEvent, WebviewBuilder}"), "native webview PDF downloads must use Tauri download events");
assert(rust.includes("builder = builder.on_download"), "native webview downloads must be intercepted before WebView opens them");
assert(rust.includes("next.protocol !== \"http:\" && next.protocol !== \"https:\""), "native webview URL patch must reject non-HTTP(S) window.open targets");
assert(rust.includes("if !matches!(url.scheme(), \"http\" | \"https\")"), "native webview navigation must reject non-HTTP(S) schemes");
assert(rust.includes("destination_is_pdf"), "download interception must recognize PDF attachment filenames");
assert(rust.includes("nav_app.emit(\"r0nix://webview-pdf-link\""), "PDF navigation must emit an open event");
assert(rust.includes("hide_webview_after_pdf_interception"), "PDF interception must hide the native surface through the main-thread queue");
assert(rust.includes("app.run_on_main_thread(move ||"), "PDF interception hide must not re-enter WebKit synchronously");
const navigationCallback = rust.slice(
  rust.indexOf("builder = builder.on_navigation"),
  rust.indexOf("builder = builder.on_download"),
);
assert(!navigationCallback.includes("webview.hide"), "navigation callback must not mutate the native child WebView synchronously");
const downloadCallback = rust.slice(
  rust.indexOf("builder = builder.on_download"),
  rust.indexOf("let main = app"),
);
assert(!downloadCallback.includes("webview.hide"), "download callback must not mutate the native child WebView synchronously");
assert(app.includes("hideNativeWebviewTab(sourceTabId)"), "frontend must hide the source WebView after receiving a PDF event");
assert(browser.includes("if (nativeMode) {\n        void hideNativeWebviewTab(tabId);\n      }"), "direct PDF address navigation must hide the native surface before downloading");
assert(app.includes("if (disposed) {\n        for (const dispose of unlisteners) dispose();"), "late native webview listener registration must clean up after App unmount.");
assert(rust.includes("pub fn cleanup_stale_web_pdf_temp_files"), "stale downloaded PDF temp files must be cleaned on startup");
assert(rust.includes("MANAGED_WEB_PDF_PREFIX"), "downloaded PDF temp files must use an explicit managed prefix");
assert(rust.includes("tokio::fs::remove_file(path).await"), "closing a PDF must remove its managed downloaded temp file");
assert(registry.includes("cleanup_stale_web_pdf_temp_files"), "startup must invoke downloaded PDF temp cleanup");

console.log("webview-pdf-open-contract: ok");
