import fs from "node:fs";
import assert from "node:assert/strict";

const rust = fs.readFileSync("src-tauri/src/tauri_commands.rs", "utf8");
const bridge = fs.readFileSync("src/services/rustPdf.ts", "utf8");
const nativeFiles = fs.readFileSync("src/services/nativeFiles.ts", "utf8");
const api = fs.readFileSync("src/services/pdfApi.ts", "utf8");
const registry = fs.readFileSync("src-tauri/src/main.rs", "utf8");
const pdfJs = fs.readFileSync("src/services/pdfJsService.ts", "utf8");

assert.match(rust, /read_opened_pdf_bytes[\s\S]*request_id: Option<String>/);
assert.match(rust, /pub async fn cancel_pdf_byte_read/);
assert.match(rust, /pub async fn cancel_pdf_page_count/);
assert.match(rust, /PDF_PYTHON_TASK_PERMITS/);
assert.match(rust, /acquire_python_task_permit/);
assert.match(rust, /let _python_permit = python_permit/);
assert.match(rust, /MAX_PDF_BYTES/);
assert.match(rust, /pdf is too large to open safely/);
assert.match(rust, /temporary file exceeds the safe/);
assert.match(bridge, /cancelPdfByteRead/);
assert.match(bridge, /cancelPdfPageCount/);
assert.match(api, /cancelPdfByteRead\(requestId\)/);
assert.match(api, /getPageCount\(fileId, requestId\)/);
assert.match(api, /cancelPdfPageCount\(requestId\)/);
assert.match(registry, /tauri_commands::cancel_pdf_byte_read/);
assert.match(registry, /tauri_commands::cancel_pdf_page_count/);
assert.match(rust, /MANAGED_IMPORT_PREFIX/);
assert.match(rust, /pub async fn remove_managed_import_temp/);
assert.match(nativeFiles, /remove_managed_import_temp/);
assert.match(nativeFiles, /isManagedImportTempPath/);
assert.match(api, /removeManagedImportTemp/);
assert.match(api, /MAX_IMPORT_FILE_BYTES/);
assert.match(api, /assertImportFileSize\(file\)/);
assert.match(pdfJs, /await loadingEntry\.destroy\(\);\s*void loadingEntry\.promise\.catch/);
assert.doesNotMatch(pdfJs, /await loadingEntry\.promise/);
assert.match(api, /BROWSER_REQUEST_TIMEOUT_MS/);
assert.match(api, /fetchBrowserRequest/);
assert.match(api, /controller\.abort\(new Error\("Browser backend request timed out\."\)\)/);
assert.doesNotMatch(
  api,
  /await fetch\(`(?:http:\/\/localhost:8000|\$\{BROWSER_API_BASE\})\/api\/(?:files|pdf|markdown)/,
  "Browser PDF API branches must use the bounded fetch adapter",
);
assert.match(api, /fetchBrowserRequest\(`\$\{BROWSER_API_BASE\}\/api\/files`\)/);
assert.match(api, /fetchBrowserRequest\(`\$\{BROWSER_API_BASE\}\/api\/files\/\$\{fileId\}`/);
assert.match(api, /fetchBrowserRequest\(`\$\{BROWSER_API_BASE\}\/api\/pdf\/\$\{fileId\}\/info`\)/);
assert.match(api, /fetchBrowserRequest\(`\$\{BROWSER_API_BASE\}\/api\/pdf\/\$\{fileId\}\/images`, \{ signal \}\)/);
assert.match(api, /fetchBrowserRequest\(`\$\{BROWSER_API_BASE\}\/api\/markdown\/\$\{fileId\}\/save`/);
assert.match(rust, /Ok\(Ok\(result\)\) => result,[\s\S]{0,180}Ok\(Err\(err\)\) => Err\(format!\("read pdf bytes task failed/);
assert.match(rust, /if let Some\(request_id\) = request_id\.as_deref\(\) \{[\s\S]{0,120}PDF_BYTE_READ_CANCEL_FLAGS\.lock\(\)\.await\.remove/);
assert.match(rust, /const CANCELED_REQUEST_TTL: Duration = Duration::from_secs\(600\)/);
assert.match(rust, /async fn mark_request_canceled\(request_id: String\)/);
assert.match(rust, /tokio::time::sleep\(CANCELED_REQUEST_TTL\)\.await/);
assert.match(rust, /cancel_tile_request\(request_id: String\)[\s\S]{0,260}mark_request_canceled\(request_id\)\.await/);
assert.match(rust, /cancel_llm_chat_completion\(request_id: String\)[\s\S]{0,220}mark_request_canceled\(request_id\)\.await/);

// 字节过 IPC 必须保持 base64（不是 `Vec<u8>`）。
// macOS 上 Tauri 的 IPC 是纯文本通道（`InvokeResponseBody::Raw` 也走
// `format_result` → `serde_json::to_string(&Vec<u8>)`），`Vec<u8>` 会变成
// **十进制数字数组**：3.55 字符/字节 × Rust 侧 3 份副本，再过 `JSON.parse`
// 出 7.2 字节/元素的 JS 数字数组 —— 端到端 ≈ 19–23 倍文件大小的瞬时峰值。
// 这是「打开 200 页 PDF 内存 2G+」的主因，依据见 read_opened_pdf_bytes 头部注释。
assert.match(rust, /pub async fn read_opened_pdf_bytes\([\s\S]{0,140}-> Result<String, String>/);
assert.doesNotMatch(
  rust,
  /read_opened_pdf_bytes[\s\S]{0,400}-> Result<Vec<u8>, String>/,
  "PDF bytes must not cross the macOS IPC as a JSON number array",
);
assert.match(rust, /result\.map\(\|bytes\| BASE64\.encode\(&bytes\)\)/);
assert.match(bridge, /typeof raw === 'string'\) return base64ToBytes\(raw\)/);

console.log("pdf-open-cancellation: ok");
