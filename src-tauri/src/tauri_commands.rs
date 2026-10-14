use crate::pdf_manager::PDF_MANAGER;
use crate::py_render::{
    extract_pdf_image_json, get_page_count as get_pdf_page_count, get_page_images_json,
    get_pdf_reading_blocks_json, render_page_png, render_page_svg, render_page_svg_crop,
};
use crate::workspace;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::png::PngEncoder;
use image::{imageops, ColorType, ImageEncoder, RgbaImage};
use pdf_core::{plan_visible_tiles, PdfInfo, TileReadyPayload, TileRequestAck, TileViewport};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    webview::{DownloadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, Url, WebviewUrl,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static CANCELED_REQUESTS: once_cell::sync::Lazy<Mutex<HashSet<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashSet::new()));
static CANCELED_NOTIFY: once_cell::sync::Lazy<tokio::sync::Notify> =
    once_cell::sync::Lazy::new(tokio::sync::Notify::new);
static PDF_BLOCK_CANCEL_FLAGS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static PDF_IMAGE_CANCEL_FLAGS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static PDF_EXPORT_CANCEL_FLAGS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static PDF_BYTE_READ_CANCEL_FLAGS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static PDF_PAGE_COUNT_CANCEL_FLAGS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static PDF_PYTHON_TASK_PERMITS: once_cell::sync::Lazy<Arc<Semaphore>> =
    once_cell::sync::Lazy::new(|| Arc::new(Semaphore::new(2)));
static WEBVIEW_TABS: once_cell::sync::Lazy<Mutex<HashMap<String, String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
// Match the actual macOS WebKit engine. A Windows Edge UA on WebKit causes
// search sites to serve incompatible challenge/advertising variants.
const DEFAULT_NATIVE_WEBVIEW_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const MAX_PROXY_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_LLM_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RENDER_ZOOM: f32 = 8.0;
const MANAGED_WEB_PDF_PREFIX: &str = "r0nix-web-";
const MANAGED_IMPORT_PREFIX: &str = "r0nix-import-";
const PDF_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const PDF_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const PYTHON_PERMIT_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const STALE_TEMP_FILE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const CANCELED_REQUEST_TTL: Duration = Duration::from_secs(600);
const MAX_IMPORT_SCAN_DIRS: usize = 10_000;
const IMPORT_SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const IMPORTABLE_EXTENSIONS: &[&str] = &["pdf", "md", "markdown"];
const PDF_EXTENSIONS: &[&str] = &["pdf"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown"];
const TEXT_WRITE_EXTENSIONS: &[&str] = &["md", "markdown", "csv", "json", "svg", "txt"];
const BINARY_WRITE_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "jp2", "jpx", "jbig2",
    "ccitt",
];
const NATIVE_WEBVIEW_NAV_PATCH_SCRIPT: &str = r#"(function () {
  if ((window).__r0nixNavPatchInstalled) return;
  (window).__r0nixNavPatchInstalled = true;

  const toAbsolute = (raw) => {
    if (typeof raw !== "string") return "";
    const value = raw.trim();
    if (!value) return "";
    try {
      const next = new URL(value, window.location.href);
      if (next.protocol !== "http:" && next.protocol !== "https:") return "";
      return next.toString();
    } catch {
      return "";
    }
  };

  const navigateCurrent = (raw) => {
    const next = toAbsolute(raw);
    if (!next) return false;
    window.location.assign(next);
    return true;
  };

  window.open = function (url, target, features) {
    if (navigateCurrent(String(url || ""))) {
      return window;
    }
    return window;
  };

  document.addEventListener(
    "click",
    function (event) {
      const node = event.target;
      if (!(node instanceof Element)) return;
      const anchor = node.closest("a[href]");
      if (!anchor) return;
      const target = (anchor.getAttribute("target") || "").toLowerCase();
      if (target !== "_blank") return;
      const href = anchor.getAttribute("href") || "";
      if (!href) return;
      if (!navigateCurrent(href)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
})();"#;

// Navigation and download callbacks can run inside WebKit's callback stack.
// Queue the hide on Tauri's main thread so the PDF surface never flashes as a
// blank document, without mutating the child WebView re-entrantly.
fn hide_webview_after_pdf_interception(app: &AppHandle, label: String) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(webview) = app_handle.get_webview(&label) {
            let _ = webview.hide();
        }
    });
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDownloadPayload {
    pub data_base64: String,
    pub final_url: String,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub status_code: u16,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativePdfDownloadPayload {
    pub path: String,
    pub file_name: String,
    pub final_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatCompletionRequest {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub timeout_ms: Option<u64>,
    pub request_id: Option<String>,
    pub messages: Vec<LlmChatMessage>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WebviewPdfLinkPayload {
    tab_id: String,
    url: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WebviewNavigatedPayload {
    tab_id: String,
    url: String,
}

fn native_webview_label(tab_id: &str) -> String {
    let mut label = String::from("webtab-");
    for ch in tab_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            label.push(ch);
        } else {
            label.push('-');
        }
    }
    if label.len() > 64 {
        label.truncate(64);
    }
    label
}

fn parse_webview_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).map_err(|err| format!("invalid webview url: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("native webview only supports http:// and https:// URLs".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("native webview URL must include a host".to_string());
    }
    Ok(parsed)
}

async fn registered_webview_label(tab_id: &str) -> Result<String, String> {
    WEBVIEW_TABS
        .lock()
        .await
        .get(tab_id)
        .cloned()
        .ok_or_else(|| format!("native webview tab is not registered: {tab_id}"))
}

fn ensure_non_empty_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn ensure_importable_extension(path: &Path) -> bool {
    ensure_extension_allowed(path, IMPORTABLE_EXTENSIONS)
}

fn ensure_pdf_extension(path: &Path) -> bool {
    ensure_extension_allowed(path, PDF_EXTENSIONS)
}

fn ensure_extension_allowed(path: &Path, allowed_extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            allowed_extensions
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn is_managed_web_pdf_path(temp_dir: &Path, path: &Path) -> bool {
    path.parent() == Some(temp_dir)
        && ensure_pdf_extension(path)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(MANAGED_WEB_PDF_PREFIX))
}

fn is_managed_import_temp_path(temp_dir: &Path, path: &Path) -> bool {
    path.parent() == Some(temp_dir)
        && ensure_importable_extension(path)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(MANAGED_IMPORT_PREFIX))
}

fn is_managed_temp_path(temp_dir: &Path, path: &Path) -> bool {
    is_managed_web_pdf_path(temp_dir, path) || is_managed_import_temp_path(temp_dir, path)
}

pub fn cleanup_stale_web_pdf_temp_files(app: &AppHandle) -> Result<usize, String> {
    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|err| format!("temporary directory unavailable: {err}"))?;
    let now = SystemTime::now();
    let entries = std::fs::read_dir(&temp_dir)
        .map_err(|err| format!("failed to scan temporary directory: {err}"))?;
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_managed_temp_path(&temp_dir, &path) {
            continue;
        }
        let is_stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_TEMP_FILE_AGE);
        if is_stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn ensure_markdown_extension(path: &Path) -> bool {
    ensure_extension_allowed(path, MARKDOWN_EXTENSIONS)
}

fn sanitize_file_name(file_name: &str) -> Result<String, String> {
    let name = file_name.trim();
    if name.is_empty() {
        return Err("file name is empty".to_string());
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("file name must not contain path separators".to_string());
    }
    Ok(name.to_string())
}

fn decode_base64_bytes(data_base64: &str) -> Result<Vec<u8>, String> {
    BASE64
        .decode(data_base64)
        .map_err(|err| format!("invalid base64 payload: {err}"))
}

fn normalize_download_url(raw: &str) -> Result<reqwest::Url, String> {
    let parsed =
        reqwest::Url::parse(raw.trim()).map_err(|err| format!("invalid download url: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("download url must start with http:// or https://".to_string());
    }
    Ok(parsed)
}

pub(crate) fn is_pdf_url(url: &str) -> bool {
    let lowered_raw = url.to_ascii_lowercase();
    if lowered_raw.contains(".pdf")
        || lowered_raw.contains("%2epdf")
        || lowered_raw.contains("%2fpdf")
        || lowered_raw.contains("application/pdf")
    {
        return true;
    }

    if let Ok(parsed) = Url::parse(url) {
        let path = parsed.path().to_ascii_lowercase();
        if path.ends_with(".pdf")
            || path.contains("/pdf/")
            || path.contains("/pdfs/")
            || path.ends_with("/pdf")
            || path.ends_with("/pdfs")
            || (path.contains("/download") && path.contains("pdf"))
        {
            return true;
        }
        for segment in path.split('/') {
            if segment == "pdf" || segment == "pdfs" {
                return true;
            }
        }
        for (key, value) in parsed.query_pairs() {
            let key = key.to_ascii_lowercase();
            let value = value.to_ascii_lowercase();
            if value.contains(".pdf") || value == "pdf" || value.contains("application/pdf") {
                return true;
            }
            if (key == "format"
                || key == "type"
                || key == "mime"
                || key == "output"
                || key == "file"
                || key == "filename")
                && value.contains("pdf")
            {
                return true;
            }
        }
        if parsed
            .fragment()
            .map(|fragment| {
                let fragment = fragment.to_ascii_lowercase();
                fragment.contains(".pdf")
                    || fragment.contains("application/pdf")
                    || fragment.contains("format=pdf")
                    || fragment.contains("type=pdf")
            })
            .unwrap_or(false)
        {
            return true;
        }
        return false;
    }

    lowered_raw.contains("/pdf/") || lowered_raw.contains("/pdfs/")
}

#[tauri::command]
pub async fn frontend_log(
    level: String,
    scope: String,
    message: String,
    payload: Option<String>,
) -> Result<(), String> {
    match payload {
        Some(payload) if !payload.is_empty() => {
            eprintln!("[frontend][{}][{}] {} | {}", level, scope, message, payload);
        }
        _ => {
            eprintln!("[frontend][{}][{}] {}", level, scope, message);
        }
    }
    Ok(())
}

fn ensure_allowed_text_write_path(path: &Path) -> Result<(), String> {
    if ensure_extension_allowed(path, TEXT_WRITE_EXTENSIONS) {
        Ok(())
    } else {
        Err(format!(
            "text write only supports {} files",
            TEXT_WRITE_EXTENSIONS.join(", ")
        ))
    }
}

fn ensure_allowed_binary_write_path(path: &Path) -> Result<(), String> {
    if ensure_extension_allowed(path, BINARY_WRITE_EXTENSIONS) {
        Ok(())
    } else {
        Err(format!(
            "binary write only supports {} files",
            BINARY_WRITE_EXTENSIONS.join(", ")
        ))
    }
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let path = ensure_non_empty_path(&path)?;
    if !ensure_markdown_extension(&path) {
        return Err("only markdown files can be read as text".to_string());
    }
    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path)
            .map_err(|err| format!("failed to read text file {}: {err}", path.display()))
    })
    .await
    .map_err(|err| format!("read text task failed: {err}"))?
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path = ensure_non_empty_path(&path)?;
    ensure_allowed_text_write_path(&path)?;
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, content)
            .map_err(|err| format!("failed to write text file {}: {err}", path.display()))
    })
    .await
    .map_err(|err| format!("write text task failed: {err}"))?
}

#[tauri::command]
pub async fn write_binary_file(path: String, data_base64: String) -> Result<(), String> {
    let path = ensure_non_empty_path(&path)?;
    ensure_allowed_binary_write_path(&path)?;
    let bytes = decode_base64_bytes(&data_base64)?;
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, bytes)
            .map_err(|err| format!("failed to write binary file {}: {err}", path.display()))
    })
    .await
    .map_err(|err| format!("write binary task failed: {err}"))?
}

#[tauri::command]
pub async fn write_temp_file(
    app: AppHandle,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    let file_name = sanitize_file_name(&file_name)?;
    let max_base64_len = MAX_PDF_BYTES.div_ceil(3) as usize * 4;
    if data_base64.len() > max_base64_len {
        return Err(format!(
            "temporary file exceeds the safe {} MiB limit",
            MAX_PDF_BYTES / (1024 * 1024)
        ));
    }
    let mut path = app
        .path()
        .temp_dir()
        .map_err(|err| format!("temp directory unavailable: {err}"))?;
    let unique = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.push(format!("{MANAGED_IMPORT_PREFIX}{unique}-{file_name}"));
    if !ensure_importable_extension(&path) {
        return Err("temporary files only support pdf, md, or markdown files".to_string());
    }
    let bytes = decode_base64_bytes(&data_base64)?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(format!(
            "temporary file exceeds the safe {} MiB limit",
            MAX_PDF_BYTES / (1024 * 1024)
        ));
    }
    let output_path = path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, bytes)
            .map_err(|err| format!("failed to write temp file {}: {err}", path.display()))
    })
    .await
    .map_err(|err| format!("write temp task failed: {err}"))??;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn collect_importable_paths(root: String) -> Result<Vec<String>, String> {
    let root = ensure_non_empty_path(&root)?;
    tokio::task::spawn_blocking(move || {
        let root = root
            .canonicalize()
            .map_err(|err| format!("failed to access import folder: {err}"))?;
        let mut results = Vec::new();
        let mut visited_dirs = HashSet::new();
        let mut stack = vec![root];
        let started_at = Instant::now();
        while let Some(current) = stack.pop() {
            if started_at.elapsed() >= IMPORT_SCAN_TIMEOUT {
                return Err(format!(
                    "import folder scan timed out after {} seconds",
                    IMPORT_SCAN_TIMEOUT.as_secs()
                ));
            }
            if visited_dirs.len() >= MAX_IMPORT_SCAN_DIRS {
                return Err(format!(
                    "import folder contains more than {MAX_IMPORT_SCAN_DIRS} directories"
                ));
            }
            if !visited_dirs.insert(current.clone()) {
                continue;
            }
            let entries = match std::fs::read_dir(&current) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(_) => continue,
                };
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    stack.push(path);
                    continue;
                }
                if ensure_importable_extension(&path) {
                    results.push(path.to_string_lossy().to_string());
                }
                if results.len() >= 5000 {
                    return Ok(results);
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|err| format!("collect importable paths task failed: {err}"))?
}

fn encode_tile_png_base64(tile: &RgbaImage) -> Result<String, String> {
    let mut png_bytes = Vec::new();
    PngEncoder::new(&mut png_bytes)
        .write_image(tile.as_raw(), tile.width(), tile.height(), ColorType::Rgba8)
        .map_err(|err| format!("failed to encode tile png: {err}"))?;
    Ok(BASE64.encode(png_bytes))
}

fn build_tile_payloads(
    request_id: &str,
    file_id: &str,
    page_no: usize,
    zoom: f32,
    tile_plan: Vec<(u32, u32, u32, u32)>,
    page_png: &[u8],
    render_scale_factor: f32,
) -> Result<Vec<TileReadyPayload>, String> {
    let page_image = image::load_from_memory(page_png)
        .map_err(|err| format!("failed to decode rendered page png: {err}"))?
        .to_rgba8();

    let page_width = page_image.width();
    let page_height = page_image.height();
    let mut payloads = Vec::with_capacity(tile_plan.len());

    let factor = render_scale_factor.max(1.0);

    let logical_page_width = ((page_width as f32) / factor).round() as u32;
    let logical_page_height = ((page_height as f32) / factor).round() as u32;

    for (x, y, width, height) in tile_plan {
        if x >= logical_page_width || y >= logical_page_height {
            continue;
        }

        let logical_tile_width = width.min(logical_page_width.saturating_sub(x));
        let logical_tile_height = height.min(logical_page_height.saturating_sub(y));
        if logical_tile_width == 0 || logical_tile_height == 0 {
            continue;
        }

        let crop_x = ((x as f32) * factor).floor() as u32;
        let crop_y = ((y as f32) * factor).floor() as u32;
        let crop_width = ((logical_tile_width as f32) * factor).ceil() as u32;
        let crop_height = ((logical_tile_height as f32) * factor).ceil() as u32;

        if crop_x >= page_width || crop_y >= page_height {
            continue;
        }

        let crop_tile_width = crop_width.min(page_width.saturating_sub(crop_x));
        let crop_tile_height = crop_height.min(page_height.saturating_sub(crop_y));
        if crop_tile_width == 0 || crop_tile_height == 0 {
            continue;
        }

        let tile_image = imageops::crop_imm(
            &page_image,
            crop_x,
            crop_y,
            crop_tile_width,
            crop_tile_height,
        )
        .to_image();
        let png_base64 = encode_tile_png_base64(&tile_image)?;

        payloads.push(TileReadyPayload {
            request_id: request_id.to_string(),
            file_id: file_id.to_string(),
            page_no,
            zoom,
            tile_id: format!("{page_no}-{x}-{y}-{width}-{height}-{zoom:.3}"),
            x,
            y,
            width: logical_tile_width,
            height: logical_tile_height,
            status: "ready".to_string(),
            png_base64: Some(png_base64),
        });
    }

    Ok(payloads)
}

async fn is_request_canceled(request_id: &str) -> bool {
    let canceled = CANCELED_REQUESTS.lock().await;
    canceled.contains(request_id)
}

async fn mark_request_canceled(request_id: String) {
    CANCELED_REQUESTS.lock().await.insert(request_id.clone());
    CANCELED_NOTIFY.notify_waiters();
    tokio::spawn(async move {
        tokio::time::sleep(CANCELED_REQUEST_TTL).await;
        CANCELED_REQUESTS.lock().await.remove(&request_id);
    });
}

async fn wait_for_request_canceled(request_id: &str) {
    loop {
        let notified = CANCELED_NOTIFY.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if is_request_canceled(request_id).await {
            return;
        }
        notified.await;
    }
}

async fn resolve_file_path(file_id: &str) -> Result<String, String> {
    let manager = PDF_MANAGER.lock().await;
    let info = manager
        .get_document_info(file_id)
        .map_err(|err| err.to_string())?;
    Ok(info.path)
}

async fn acquire_python_task_permit(label: &'static str) -> Result<OwnedSemaphorePermit, String> {
    match tokio::time::timeout(
        PYTHON_PERMIT_ACQUIRE_TIMEOUT,
        PDF_PYTHON_TASK_PERMITS.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(_)) => Err(format!("{label} concurrency gate is unavailable")),
        Err(_) => Err(format!(
            "{label} is busy; try again after the current PDF task finishes"
        )),
    }
}

async fn run_pdf_export_blocking<T, F>(
    label: &'static str,
    request_id: Option<String>,
    task: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let python_permit = acquire_python_task_permit(label).await?;
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Some(request_id) = request_id.as_deref() {
        if request_id.trim().is_empty() {
            return Err("export request id cannot be empty".to_string());
        }
        PDF_EXPORT_CANCEL_FLAGS
            .lock()
            .await
            .insert(request_id.to_string(), cancel_flag.clone());
    }

    let task_flag = cancel_flag.clone();
    let task = tokio::task::spawn_blocking(move || {
        let _python_permit = python_permit;
        if task_flag.load(Ordering::Acquire) {
            return Err("r0nix-cancelled".to_string());
        }
        let result = task();
        if task_flag.load(Ordering::Acquire) {
            Err("r0nix-cancelled".to_string())
        } else {
            result
        }
    });
    let result = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, task).await {
        Ok(Ok(result)) => result.map_err(|err| format!("{label} failed: {err}")),
        Ok(Err(err)) => Err(format!("{label} task failed: {err}")),
        Err(_) => {
            cancel_flag.store(true, Ordering::Release);
            Err(format!(
                "{label} timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ))
        }
    };
    if let Some(request_id) = request_id {
        PDF_EXPORT_CANCEL_FLAGS.lock().await.remove(&request_id);
    }
    result
}

#[tauri::command]
pub async fn open_pdf(file_id: String, path: String) -> Result<PdfInfo, String> {
    let path = ensure_non_empty_path(&path)?;
    if !ensure_pdf_extension(&path) {
        return Err("only PDF files can be opened by open_pdf".to_string());
    }
    if file_id.trim().is_empty() {
        return Err("file id is empty".to_string());
    }
    let path = path.to_string_lossy().into_owned();
    eprintln!("[open_pdf] file_id={} path={}", file_id, path);
    let mut manager = PDF_MANAGER.lock().await;
    let info = manager
        .open_document(file_id, &path)
        .map_err(|err| err.to_string())?;
    drop(manager);
    eprintln!(
        "[open_pdf] metadata ready file_id={} page_count=deferred",
        info.file_id
    );
    Ok(info)
}

// Core document lifecycle is kept separate from Tauri so it can be tested
// without constructing an application handle. The command wrapper below owns
// only managed temporary-file cleanup.
pub async fn close_pdf_document(file_id: String) -> Result<Option<PathBuf>, String> {
    let mut manager = PDF_MANAGER.lock().await;
    let path = manager
        .get_document_info(&file_id)
        .ok()
        .map(|info| PathBuf::from(info.path));
    manager
        .close_document(&file_id)
        .map(|_| path)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn close_pdf(app: AppHandle, file_id: String) -> Result<(), String> {
    let path = close_pdf_document(file_id).await?;

    if let Some(path) = path {
        if let Ok(temp_dir) = app.path().temp_dir() {
            if is_managed_temp_path(&temp_dir, &path) {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_managed_web_pdf_temp(app: AppHandle, path: String) -> Result<(), String> {
    let path = ensure_non_empty_path(&path)?;
    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|err| format!("temporary directory unavailable: {err}"))?;
    if !is_managed_web_pdf_path(&temp_dir, &path) {
        return Err("refusing to remove an unmanaged PDF temp path".to_string());
    }
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove temporary PDF: {error}")),
    }
}

#[tauri::command]
pub async fn remove_managed_import_temp(app: AppHandle, path: String) -> Result<(), String> {
    let path = ensure_non_empty_path(&path)?;
    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|err| format!("temporary directory unavailable: {err}"))?;
    if !is_managed_import_temp_path(&temp_dir, &path) {
        return Err("refusing to remove an unmanaged import temp path".to_string());
    }
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove temporary import: {error}")),
    }
}

#[tauri::command]
pub async fn get_pdf_info(file_id: String) -> Result<PdfInfo, String> {
    let manager = PDF_MANAGER.lock().await;
    manager
        .get_document_info(&file_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_page_count(file_id: String, request_id: Option<String>) -> Result<usize, String> {
    let (known_page_count, path) = {
        let manager = PDF_MANAGER.lock().await;
        let info = manager
            .get_document_info(&file_id)
            .map_err(|err| err.to_string())?;
        (info.page_count, info.path)
    };
    if known_page_count > 0 {
        return Ok(known_page_count);
    }

    let request_id = request_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "page-count-{}",
                REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            )
        });
    let cancel_flag = Arc::new(AtomicBool::new(false));
    PDF_PAGE_COUNT_CANCEL_FLAGS
        .lock()
        .await
        .insert(request_id.clone(), cancel_flag.clone());
    let python_permit = match acquire_python_task_permit("page count").await {
        Ok(permit) => permit,
        Err(error) => {
            PDF_PAGE_COUNT_CANCEL_FLAGS.lock().await.remove(&request_id);
            return Err(error);
        }
    };
    let task_flag = cancel_flag.clone();
    let page_count_task = tokio::task::spawn_blocking(move || {
        let _python_permit = python_permit;
        if task_flag.load(Ordering::Acquire) {
            return Err("r0nix-cancelled".to_string());
        }
        let result = get_pdf_page_count(&path);
        if task_flag.load(Ordering::Acquire) {
            Err("r0nix-cancelled".to_string())
        } else {
            result
        }
    });
    let page_count = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, page_count_task).await {
        Ok(result) => {
            PDF_PAGE_COUNT_CANCEL_FLAGS.lock().await.remove(&request_id);
            result
                .map_err(|err| format!("page count task failed: {err}"))?
                .map_err(|err| format!("page count failed: {err}"))?
        }
        Err(_) => {
            cancel_flag.store(true, Ordering::Release);
            PDF_PAGE_COUNT_CANCEL_FLAGS.lock().await.remove(&request_id);
            return Err(format!(
                "page count timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ));
        }
    };
    let mut manager = PDF_MANAGER.lock().await;
    manager
        .set_page_count(&file_id, page_count)
        .map_err(|err| err.to_string())?;
    eprintln!(
        "[get_page_count] resolved file_id={} pages={page_count}",
        file_id
    );
    Ok(page_count)
}

#[tauri::command]
pub async fn list_pdfs() -> Result<Vec<String>, String> {
    let manager = PDF_MANAGER.lock().await;
    Ok(manager.list_documents())
}

/// 把已打开的 PDF 原件读给前端（pdf.js 需要一份原始字节）。
///
/// ## 为什么返回 base64 字符串，而不是 `Vec<u8>`
///
/// 因为 **Tauri 在 macOS 上的 IPC 是纯文本通道，而且没有任何「二进制旁路」**。
/// 这不是猜测，是 tauri-2.10.2 源码里的三条事实（2026-10-09 核对）：
///
/// 1. `impl<T: Serialize> IpcResponse for T` → `serde_json::to_string(&self)`
///    （`tauri/src/ipc/mod.rs:181-187`）。`Vec<u8>` 是 `Serialize`，于是**每一个字节
///    变成一串十进制数字**（平均 3.55 字符/字节，实测 20MiB → 71MiB 文本）。
/// 2. 即使改用「二进制」的 `InvokeResponseBody::Raw(Vec<u8>)` 也**没有用**：
///    `tauri/src/ipc/protocol.rs:390-403` 对 `cfg!(target_os = "macos" | "ios")`
///    显式跳过 channel 快速通路，仍然走 `format_result` → `serde_json::to_string(&Vec<u8>)`。
/// 3. `format_callback.rs` 的 `serialize_js_with` 对这个 `[` 开头的长度 >10KiB 的
///    载荷会再套一层 `Serialized`（转义成单引号 JS 字面量），于是**同一份文本在
///    Rust 侧同时存在 3 份**（serde_json 字符串 / 转义副本 / `format!` 拼接副本）。
///
/// 端到端放大倍数（2026-10-09 实测，20MiB 样本）：Rust 侧 ≈ 11.6x，
/// WebView 侧 `JSON.parse` 出的 JS 数字数组就是 **7.2x**（V8 每个元素 8 字节），
/// 合计 **≈ 19–23x 文件大小、全是瞬时峰值**。一份 90MiB 的扫描版 PDF 光过桥就要 2GB ——
/// 这正是「打开 200 页 PDF 内存 2G+」的主因（画布那条路只占 20–40MB 驻留，
/// 见 `readerCore.ts` 的暂存画布注释）。
///
/// base64 把每一份副本从 3.55x 降到 **1.34x**，且不再产生 JS 数字数组，
/// 同样的文件过桥峰值从 ≈19N 掉到 ≈7N。它**不是**「pdf.js/PyMuPDF 该给我而没给」的东西 ——
/// 它发生在两者之外，是宿主 IPC 通道的固有限制。
///
/// ## 真正的终局（尚未实施，需要一次真机验证）
///
/// pdf.js 自己就有流式读取：`getDocument({ url, rangeChunkSize })` 会走
/// `Range: bytes=` 分块拉取，内存与**分块**成正比而不是与文件成正比。
/// 但它**只在 `http(s)` scheme 下启用**：`pdf.mjs:13327` 的
/// `this.isHttp = /^https?:/i.test(source.url)` 与 `:13257` 的
/// `if (disableRange || !isHttp) return` 会把 `asset://`、以及任何自建 scheme
/// 直接踢回「整文件下载」。所以想吃到 pdf.js 的成熟流式路径，前端拿到的 URL
/// 必须是 http(s) —— 也就是要在 Tauri 里起一个仅监听 127.0.0.1 + 随机端口 + 令牌的
/// 本机 HTTP 服务（带 `Accept-Ranges`/`Content-Range`）。见 README/评审记录。
#[tauri::command]
pub async fn read_opened_pdf_bytes(
    file_id: String,
    request_id: Option<String>,
) -> Result<String, String> {
    let path = resolve_file_path(&file_id).await?;
    let request_id = request_id.filter(|value| !value.trim().is_empty());
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Some(request_id) = request_id.as_deref() {
        PDF_BYTE_READ_CANCEL_FLAGS
            .lock()
            .await
            .insert(request_id.to_string(), cancel_flag.clone());
    }
    let task_flag = cancel_flag.clone();
    let task = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut file =
            File::open(path).map_err(|err| format!("failed to open pdf bytes: {err}"))?;
        let file_size = file
            .metadata()
            .map_err(|err| format!("failed to inspect pdf bytes: {err}"))?
            .len();
        if file_size > MAX_PDF_BYTES {
            return Err(format!(
                "pdf is too large to open safely ({} MiB limit)",
                MAX_PDF_BYTES / (1024 * 1024)
            ));
        }
        let mut bytes = Vec::with_capacity(file_size as usize);
        let mut buffer = [0_u8; 1024 * 1024];
        loop {
            if task_flag.load(Ordering::Acquire) {
                return Err("r0nix-cancelled".to_string());
            }
            let read = file
                .read(&mut buffer)
                .map_err(|err| format!("failed to read pdf bytes: {err}"))?;
            if read == 0 {
                break;
            }
            if bytes.len().saturating_add(read) > MAX_PDF_BYTES as usize {
                return Err(format!(
                    "pdf grew beyond the safe {} MiB limit while reading",
                    MAX_PDF_BYTES / (1024 * 1024)
                ));
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        if task_flag.load(Ordering::Acquire) {
            return Err("r0nix-cancelled".to_string());
        }
        Ok(bytes)
    });
    let result = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => Err(format!("read pdf bytes task failed: {err}")),
        Err(_) => {
            cancel_flag.store(true, Ordering::Release);
            Err(format!(
                "read pdf bytes timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ))
        }
    };
    if let Some(request_id) = request_id.as_deref() {
        PDF_BYTE_READ_CANCEL_FLAGS.lock().await.remove(request_id);
    }
    // base64（STANDARD，带 padding）而不是 Vec<u8>：理由见本函数头部第 1–3 条。
    // 这一步的额外峰值是 4/3N，换掉的是「3 份 3.55N 文本 + 7.2N 数字数组」。
    result.map(|bytes| BASE64.encode(&bytes))
}

/// dev-only 的自动化钩子：让应用**启动即打开指定文件**。
///
/// 为什么需要它：内存足迹的量测必须在**真实 Tauri 进程**里做 —— 浏览器（Playwright）
/// 走的是 `file.arrayBuffer()`，完全绕过 Tauri IPC，量不到那段峰值；而 macOS 上驱动
/// 真实应用的 UI 需要辅助功能权限（本机 `UI elements enabled = false`，AppleScript
/// 点不动「打开文件」对话框）。所以留一个只读环境变量的入口。
///
/// 路径来自环境变量 `R0NIX_AUTO_OPEN`。**release 构建恒返回 `None`**
/// （`cfg!(debug_assertions)` 是编译期常量），因此生产行为与没有这个命令完全一致。
#[tauri::command]
pub fn dev_auto_open_path() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("R0NIX_AUTO_OPEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// dev-only 的自动化钩子：自动打开的文档在 N 毫秒后**关闭**。
///
/// 为什么需要它：`dev_auto_open_path` 只能量到「打开后驻留多少」，量不到
/// **「关标签后是否真的释放」** —— 而这正是「2GB 不下降」到底属于
/// 「按设计驻留、关掉就还」还是「泄漏」的分水岭。macOS 上驱动真实应用 UI 需要
/// 辅助功能权限（本机未授权），点不动标签上的关闭按钮，所以同样留一个环境变量入口。
///
/// 值来自 `R0NIX_AUTO_CLOSE_MS`，解析失败视为「不关」。**`0` 有明确含义：打开后立即关闭**
/// —— 完全不用定时器，因为 WKWebView 对**不可见窗口**会节流 `setTimeout`，长定时器实测
/// 根本不触发（窗口被遮挡时整个钩子静默失效）。要量「关闭是否释放」，用 `0` 做 A/B 对比
/// 比等待一个延迟更可靠。
/// **release 构建恒返回 `None`**，生产行为与没有这个命令完全一致。
#[tauri::command]
pub fn dev_auto_close_after_ms() -> Option<u64> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("R0NIX_AUTO_CLOSE_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
}

/// dev-only 的自动化钩子：关闭动作**清单**（`R0NIX_AUTO_CLOSE_ACTIONS`）。
///
/// 为什么不能只有一个「关闭」：`closeFile` 与「用户按了标签上的关闭按钮」是两件事。
/// 前者只销毁 pdf.js 文档与 Rust 句柄，**标签仍留在界面上、viewer 与画布都没卸载**；
/// 后者走 `handleCloseTab`，移除标签、卸载 viewer，再排队释放文件。上一轮把前者
/// 当成「关标签」，读数因而无法指向真正的持有者。
///
/// 取值逗号分隔，按顺序执行：`file` / `tab` / `workers`。未知动作原样返回，由前端
/// 记成警告 —— 静默忽略拼错的动作名会让整组对照失去意义。
/// **release 构建恒返回 `None`**，生产行为与没有这个命令完全一致。
#[tauri::command]
pub fn dev_auto_close_actions() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("R0NIX_AUTO_CLOSE_ACTIONS")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// dev-only 的自动化钩子：**循环模式**（`R0NIX_AUTO_CYCLE=1`）。
///
/// 语义：不「全部打开后再关」，而是**每打开一份就立刻关掉它**，于是「文档数」等于
/// 「轮数」—— 在**同一个进程**里重复「打开 → 关闭」若干轮。
///
/// 为什么这个对照不可替代：单轮只能得到「关掉后还剩多少」。要判断剩下的是
/// **泄漏**（每轮线性累加）还是**水位**（首次冲高后复用、不再增长），必须在同一进程内
/// 比较第 1 轮与第 N 轮的稳态 —— 跨会话比较受系统内存压力影响，能差出几百 MB
/// （探针自己的注释就写了「内存绝对值不可跨会话比」）。
///
/// **release 构建恒返回 `false`**，生产行为与没有这个命令完全一致。
#[tauri::command]
pub fn dev_auto_cycle() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    std::env::var("R0NIX_AUTO_CYCLE")
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "1" || value == "true" || value == "yes"
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn cancel_pdf_byte_read(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("pdf byte read request id cannot be empty".to_string());
    }
    if let Some(flag) = PDF_BYTE_READ_CANCEL_FLAGS.lock().await.get(&request_id) {
        flag.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_pdf_page_count(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("page count request id cannot be empty".to_string());
    }
    if let Some(flag) = PDF_PAGE_COUNT_CANCEL_FLAGS.lock().await.get(&request_id) {
        flag.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn request_tiles(
    app: AppHandle,
    file_id: String,
    page_no: usize,
    zoom: f32,
    viewport: TileViewport,
    tile_size: Option<u32>,
    render_scale: Option<f32>,
) -> Result<TileRequestAck, String> {
    if page_no == 0 {
        return Err("tile page number must be at least 1".to_string());
    }
    if !viewport.x.is_finite()
        || !viewport.y.is_finite()
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width <= 0.0
        || viewport.height <= 0.0
    {
        return Err("tile viewport must contain finite positive dimensions".to_string());
    }
    if !zoom.is_finite() || zoom <= 0.0 {
        return Err("tile zoom must be finite and positive".to_string());
    }
    eprintln!(
        "[request_tiles] file_id={} page={} zoom={:.2} viewport=({}, {}, {}, {})",
        file_id, page_no, zoom, viewport.x, viewport.y, viewport.width, viewport.height
    );
    let path = resolve_file_path(&file_id).await?;

    let tile_size = tile_size.unwrap_or(512).clamp(128, 1024);
    let safe_zoom = zoom.clamp(0.1, MAX_RENDER_ZOOM);
    let render_zoom = render_scale
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(safe_zoom)
        .clamp(safe_zoom, MAX_RENDER_ZOOM);
    let render_scale_factor = (render_zoom / safe_zoom).max(1.0);
    let request_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed));
    let tile_plan = plan_visible_tiles(&viewport, tile_size, 1);
    if tile_plan.is_empty() {
        return Err("tile viewport is too large to render safely".to_string());
    }
    let ack = TileRequestAck {
        request_id: request_id.clone(),
        total_tiles: tile_plan.len(),
    };
    eprintln!(
        "[request_tiles] ack request_id={} total_tiles={}",
        ack.request_id, ack.total_tiles
    );

    let app_handle = app.clone();
    let request_id_for_task = request_id.clone();
    let file_id_for_task = file_id.clone();
    tokio::spawn(async move {
        if is_request_canceled(&request_id_for_task).await {
            let _ = app_handle.emit("pdf://request_done", request_id_for_task.clone());
            let mut canceled = CANCELED_REQUESTS.lock().await;
            canceled.remove(&request_id_for_task);
            return;
        }

        let python_permit = match acquire_python_task_permit("tile render").await {
            Ok(permit) => permit,
            Err(error) => {
                eprintln!(
                    "[tile] concurrency gate rejected {} p{}: {}",
                    file_id_for_task, page_no, error
                );
                let _ = app_handle.emit("pdf://request_done", request_id_for_task.clone());
                let mut canceled = CANCELED_REQUESTS.lock().await;
                canceled.remove(&request_id_for_task);
                return;
            }
        };
        if is_request_canceled(&request_id_for_task).await {
            drop(python_permit);
            let _ = app_handle.emit("pdf://request_done", request_id_for_task.clone());
            let mut canceled = CANCELED_REQUESTS.lock().await;
            canceled.remove(&request_id_for_task);
            return;
        }

        let request_id_for_blocking = request_id_for_task.clone();
        let file_id_for_blocking = file_id_for_task.clone();
        let render_result = tokio::task::spawn_blocking(move || {
            let _python_permit = python_permit;
            let page_png = render_page_png(&path, page_no, render_zoom)?;
            build_tile_payloads(
                &request_id_for_blocking,
                &file_id_for_blocking,
                page_no,
                zoom,
                tile_plan,
                &page_png,
                render_scale_factor,
            )
        })
        .await;

        let payloads = match render_result {
            Ok(Ok(payloads)) => payloads,
            Ok(Err(err)) => {
                eprintln!(
                    "[tile] failed to render payloads for {} p{} @ {:.2}: {}",
                    file_id_for_task, page_no, zoom, err
                );
                Vec::new()
            }
            Err(err) => {
                eprintln!(
                    "[tile] render task join error for {} p{} @ {:.2}: {}",
                    file_id_for_task, page_no, zoom, err
                );
                Vec::new()
            }
        };

        for payload in payloads {
            if is_request_canceled(&request_id_for_task).await {
                break;
            }
            let _ = app_handle.emit("pdf://tile_ready", payload);
        }

        let _ = app_handle.emit("pdf://request_done", request_id_for_task.clone());
        let mut canceled = CANCELED_REQUESTS.lock().await;
        canceled.remove(&request_id_for_task);
    });

    Ok(ack)
}

#[tauri::command]
pub async fn cancel_tile_request(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("tile request id cannot be empty".to_string());
    }
    eprintln!("[cancel_tile_request] request_id={}", request_id);
    mark_request_canceled(request_id).await;
    Ok(())
}

#[tauri::command]
pub async fn cancel_llm_chat_completion(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("LLM request id cannot be empty".to_string());
    }
    mark_request_canceled(request_id).await;
    Ok(())
}

#[tauri::command]
pub async fn export_page_png(
    file_id: String,
    page_no: usize,
    zoom: Option<f32>,
    request_id: Option<String>,
) -> Result<String, String> {
    eprintln!(
        "[export_page_png] file_id={} page={} zoom={:?}",
        file_id, page_no, zoom
    );
    let path = resolve_file_path(&file_id).await?;
    let zoom = zoom
        .filter(|value| value.is_finite())
        .unwrap_or(2.0)
        .clamp(0.1, MAX_RENDER_ZOOM);

    let png = run_pdf_export_blocking("png export", request_id, move || {
        render_page_png(&path, page_no, zoom)
    })
    .await?;

    Ok(BASE64.encode(png))
}

#[tauri::command]
pub async fn extract_pdf_image(
    file_id: String,
    page_no: usize,
    xref: usize,
    request_id: Option<String>,
) -> Result<String, String> {
    eprintln!(
        "[extract_pdf_image] file_id={} page={} xref={}",
        file_id, page_no, xref
    );
    let path = resolve_file_path(&file_id).await?;
    run_pdf_export_blocking("pdf image extraction", request_id, move || {
        extract_pdf_image_json(&path, page_no, xref)
    })
    .await
}

#[tauri::command]
pub async fn export_page_svg(
    file_id: String,
    page_no: usize,
    request_id: Option<String>,
) -> Result<String, String> {
    eprintln!("[export_page_svg] file_id={} page={}", file_id, page_no);
    let path = resolve_file_path(&file_id).await?;

    run_pdf_export_blocking("svg export", request_id, move || {
        render_page_svg(&path, page_no)
    })
    .await
}

#[tauri::command]
pub async fn export_page_svg_crop(
    file_id: String,
    page_no: usize,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    request_id: Option<String>,
) -> Result<String, String> {
    if !left.is_finite()
        || !top.is_finite()
        || !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
    {
        return Err("SVG crop rectangle must contain finite positive dimensions".to_string());
    }
    eprintln!(
        "[export_page_svg_crop] file_id={} page={} left={} top={} width={} height={}",
        file_id, page_no, left, top, width, height
    );
    let path = resolve_file_path(&file_id).await?;

    run_pdf_export_blocking("svg crop export", request_id, move || {
        render_page_svg_crop(&path, page_no, left, top, width, height)
    })
    .await
}

#[tauri::command]
pub async fn cancel_pdf_export(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("export request id cannot be empty".to_string());
    }
    if let Some(flag) = PDF_EXPORT_CANCEL_FLAGS.lock().await.get(&request_id) {
        flag.store(true, Ordering::Release);
    }
    eprintln!("[cancel_pdf_export] request_id={}", request_id);
    Ok(())
}

#[tauri::command]
pub async fn get_page_images(
    file_id: String,
    page_no: usize,
    request_id: Option<String>,
) -> Result<String, String> {
    eprintln!(
        "[get_page_images] file_id={} page={} request_id={:?}",
        file_id, page_no, request_id
    );
    let path = resolve_file_path(&file_id).await?;
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Some(request_id) = request_id.as_deref() {
        if request_id.trim().is_empty() {
            return Err("image scan request id cannot be empty".to_string());
        }
        PDF_IMAGE_CANCEL_FLAGS
            .lock()
            .await
            .insert(request_id.to_string(), cancel_flag.clone());
    }

    let python_permit = match acquire_python_task_permit("image scan").await {
        Ok(permit) => permit,
        Err(error) => {
            if let Some(request_id) = request_id.as_deref() {
                PDF_IMAGE_CANCEL_FLAGS.lock().await.remove(request_id);
            }
            return Err(error);
        }
    };
    let cancel_flag_for_task = cancel_flag.clone();
    let task = tokio::task::spawn_blocking(move || {
        let _python_permit = python_permit;
        get_page_images_json(&path, page_no, Some(cancel_flag_for_task))
    });
    let result = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, task).await {
        Ok(Ok(result)) => result.map_err(|err| format!("get page images failed: {err}")),
        Ok(Err(err)) => Err(format!("get page images task failed: {err}")),
        Err(_) => {
            cancel_flag.store(true, Ordering::Release);
            Err(format!(
                "get page images timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ))
        }
    };
    if let Some(request_id) = request_id {
        PDF_IMAGE_CANCEL_FLAGS.lock().await.remove(&request_id);
    }
    result
}

#[tauri::command]
pub async fn cancel_pdf_image_scan(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("image scan request id cannot be empty".to_string());
    }
    if let Some(flag) = PDF_IMAGE_CANCEL_FLAGS.lock().await.get(&request_id) {
        flag.store(true, Ordering::Release);
    }
    eprintln!("[cancel_pdf_image_scan] request_id={}", request_id);
    Ok(())
}

#[tauri::command]
pub async fn get_pdf_reading_blocks(
    file_id: String,
    start_page: Option<usize>,
    end_page: Option<usize>,
    request_id: Option<String>,
) -> Result<String, String> {
    eprintln!(
        "[get_pdf_reading_blocks] file_id={} start={:?} end={:?} request_id={:?}",
        file_id, start_page, end_page, request_id
    );
    let path = resolve_file_path(&file_id).await?;
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Some(request_id) = request_id.as_deref() {
        if request_id.trim().is_empty() {
            return Err("reading block request id cannot be empty".to_string());
        }
        PDF_BLOCK_CANCEL_FLAGS
            .lock()
            .await
            .insert(request_id.to_string(), cancel_flag.clone());
    }

    let python_permit = match acquire_python_task_permit("reading block extraction").await {
        Ok(permit) => permit,
        Err(error) => {
            if let Some(request_id) = request_id.as_deref() {
                PDF_BLOCK_CANCEL_FLAGS.lock().await.remove(request_id);
            }
            return Err(error);
        }
    };
    let cancel_flag_for_task = cancel_flag.clone();
    let task = tokio::task::spawn_blocking(move || {
        let _python_permit = python_permit;
        get_pdf_reading_blocks_json(&path, start_page, end_page, Some(cancel_flag_for_task))
    });
    let result = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, task).await {
        Ok(Ok(result)) => {
            result.map_err(|err| format!("get_pdf_reading_blocks task failed: {err}"))
        }
        Ok(Err(err)) => Err(format!("get_pdf_reading_blocks task failed: {err}")),
        Err(_) => {
            cancel_flag.store(true, Ordering::Release);
            Err(format!(
                "PDF reading block extraction timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ))
        }
    };
    if let Some(request_id) = request_id {
        PDF_BLOCK_CANCEL_FLAGS.lock().await.remove(&request_id);
    }
    result
}

#[tauri::command]
pub async fn cancel_pdf_reading_blocks(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("reading block request id cannot be empty".to_string());
    }
    if let Some(flag) = PDF_BLOCK_CANCEL_FLAGS.lock().await.get(&request_id) {
        flag.store(true, Ordering::Release);
    }
    eprintln!("[cancel_pdf_reading_blocks] request_id={}", request_id);
    Ok(())
}

#[tauri::command]
pub async fn download_pdf_via_proxy(
    url: String,
    proxy_url: Option<String>,
) -> Result<ProxyDownloadPayload, String> {
    let parsed_url = normalize_download_url(&url)?;
    let client = crate::http::build_http_client(PDF_OPERATION_TIMEOUT, 8, proxy_url.as_deref())?;
    let response = client
        .get(parsed_url)
        .send()
        .await
        .map_err(|err| format!("request via proxy failed: {err}"))?;
    let status_code = response.status().as_u16();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let content_disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let bytes = crate::http::read_capped_body(response, MAX_PROXY_DOWNLOAD_BYTES).await?;
    Ok(ProxyDownloadPayload {
        data_base64: BASE64.encode(&bytes),
        final_url,
        content_type,
        content_disposition,
        status_code,
    })
}

fn download_file_name(final_url: &str, content_disposition: Option<&str>) -> String {
    let header_name = content_disposition
        .and_then(|value| {
            value.split(';').find_map(|part| {
                let trimmed = part.trim();
                let (key, value) = trimmed.split_once('=')?;
                if key.trim().eq_ignore_ascii_case("filename")
                    || key.trim().eq_ignore_ascii_case("filename*")
                {
                    Some(value.trim().trim_matches('"').to_string())
                } else {
                    None
                }
            })
        })
        .filter(|value| !value.trim().is_empty());
    let url_name = Url::parse(final_url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back().map(ToOwned::to_owned))
        })
        .filter(|value| !value.trim().is_empty());
    let raw = header_name
        .or(url_name)
        .unwrap_or_else(|| "document.pdf".to_string());
    let safe = raw
        .replace(['/', '\\', '\0'], "-")
        .replace(['<', '>', ':', '"', '|', '?', '*'], "-")
        .trim()
        .to_string();
    let safe = if safe.is_empty() {
        "document.pdf"
    } else {
        safe.as_str()
    };
    let safe = if safe.to_ascii_lowercase().ends_with(".pdf") {
        safe.to_string()
    } else {
        format!("{safe}.pdf")
    };
    sanitize_file_name(&safe).unwrap_or_else(|_| "document.pdf".to_string())
}

#[tauri::command]
pub async fn download_pdf_to_temp(
    app: AppHandle,
    url: String,
    proxy_url: Option<String>,
) -> Result<NativePdfDownloadPayload, String> {
    let parsed_url = normalize_download_url(&url)?;
    let client = crate::http::build_http_client(PDF_DOWNLOAD_TIMEOUT, 8, proxy_url.as_deref())?;
    let mut response = client
        .get(parsed_url)
        .send()
        .await
        .map_err(|err| format!("PDF download failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("PDF download returned HTTP {}", response.status()));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
    {
        return Err("server returned an HTML page instead of a PDF".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PDF_BYTES)
    {
        return Err(format!(
            "PDF download exceeds {} MiB limit",
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }

    let final_url = response.url().to_string();
    let file_name = download_file_name(
        &final_url,
        response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok()),
    );
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let mut path = app
        .path()
        .temp_dir()
        .map_err(|err| format!("temporary directory unavailable: {err}"))?;
    path.push(format!("{MANAGED_WEB_PDF_PREFIX}{unique}-{file_name}"));
    let output_path = path.clone();
    let mut output = tokio::fs::File::create(&path)
        .await
        .map_err(|err| format!("failed to create temporary PDF: {err}"))?;
    let mut total = 0_u64;
    let mut prefix = Vec::with_capacity(1024);
    loop {
        let chunk = match response.chunk().await {
            Ok(chunk) => chunk,
            Err(err) => {
                let _ = tokio::fs::remove_file(&path).await;
                return Err(format!("failed to read PDF download: {err}"));
            }
        };
        let Some(chunk) = chunk else { break };
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_PDF_BYTES {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(format!(
                "PDF download exceeds {} MiB limit",
                MAX_PDF_BYTES / 1024 / 1024
            ));
        }
        if prefix.len() < 1024 {
            let remaining = 1024 - prefix.len();
            prefix.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
        if let Err(err) = output.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(format!("failed to write temporary PDF: {err}"));
        }
    }
    if let Err(err) = output.flush().await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(format!("failed to flush temporary PDF: {err}"));
    }
    if !prefix.windows(5).any(|window| window == b"%PDF-") {
        let _ = tokio::fs::remove_file(&path).await;
        return Err("downloaded content is not a valid PDF".to_string());
    }
    Ok(NativePdfDownloadPayload {
        path: output_path.to_string_lossy().into_owned(),
        file_name,
        final_url,
    })
}

fn normalize_llm_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("model base url is empty".to_string());
    }
    let parsed =
        reqwest::Url::parse(trimmed).map_err(|err| format!("invalid model base url: {err}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("model base url must start with http:// or https://".to_string()),
    }
    Ok(trimmed.to_string())
}

fn join_llm_chat_url(base_url: &str) -> String {
    if base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else {
        format!("{base_url}/chat/completions")
    }
}

async fn read_llm_response_body(response: reqwest::Response) -> Result<String, String> {
    let bytes = crate::http::read_capped_body(response, MAX_LLM_RESPONSE_BYTES).await?;
    String::from_utf8(bytes).map_err(|err| format!("model service response was not UTF-8: {err}"))
}

fn sanitize_llm_messages(messages: Vec<LlmChatMessage>) -> Result<Vec<serde_json::Value>, String> {
    if messages.is_empty() {
        return Err("messages are empty".to_string());
    }
    if messages.len() > 16 {
        return Err("too many messages".to_string());
    }
    messages
        .into_iter()
        .map(|message| {
            let role = message.role.trim();
            if role != "system" && role != "user" && role != "assistant" {
                return Err(format!("unsupported message role: {role}"));
            }
            let content = message.content.trim();
            if content.is_empty() {
                return Err("message content is empty".to_string());
            }
            if content.chars().count() > 24_000 {
                return Err("message content is too long".to_string());
            }
            Ok(serde_json::json!({
                "role": role,
                "content": content,
            }))
        })
        .collect()
}

#[tauri::command]
pub async fn llm_chat_completion(request: LlmChatCompletionRequest) -> Result<String, String> {
    let base_url = normalize_llm_base_url(&request.base_url)?;
    let model = request.model.trim();
    if model.is_empty() {
        return Err("model name is empty".to_string());
    }
    let messages = sanitize_llm_messages(request.messages)?;
    let temperature = request
        .temperature
        .filter(|value| value.is_finite())
        .unwrap_or(0.2)
        .clamp(0.0, 2.0);
    let max_tokens = request.max_tokens.unwrap_or(2048).clamp(1, 8192);

    let timeout_ms = request.timeout_ms.unwrap_or(60_000).clamp(1_000, 120_000);
    let request_id = request.request_id.filter(|value| !value.trim().is_empty());
    let client = crate::http::build_http_client(Duration::from_millis(timeout_ms), 3, None)?;

    let mut builder = client
        .post(join_llm_chat_url(&base_url))
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(api_key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.bearer_auth(api_key);
    }

    let payload = serde_json::json!({
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": messages,
    })
    .to_string();

    let response = if let Some(request_id) = request_id.as_deref() {
        let result = tokio::select! {
            result = builder.body(payload).send() => result.map_err(|err| format!("model service request failed: {err}")),
            _ = wait_for_request_canceled(request_id) => Err("model service request cancelled".to_string()),
        };
        match result {
            Ok(response) => response,
            Err(error) => {
                CANCELED_REQUESTS.lock().await.remove(request_id);
                return Err(error);
            }
        }
    } else {
        builder
            .body(payload)
            .send()
            .await
            .map_err(|err| format!("model service request failed: {err}"))?
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = if let Some(request_id) = request_id.as_deref() {
        let result = tokio::select! {
            result = read_llm_response_body(response) => result,
            _ = wait_for_request_canceled(request_id) => Err("model service request cancelled".to_string()),
        };
        match result {
            Ok(body) => body,
            Err(error) => {
                CANCELED_REQUESTS.lock().await.remove(request_id);
                return Err(error);
            }
        }
    } else {
        read_llm_response_body(response).await?
    };
    if let Some(request_id) = request_id.as_deref() {
        CANCELED_REQUESTS.lock().await.remove(request_id);
    }
    if !status.is_success() {
        let details: String = body.chars().take(240).collect();
        return Err(format!(
            "model service returned HTTP {}{}",
            status.as_u16(),
            if details.trim().is_empty() {
                String::new()
            } else {
                format!(" {details}")
            }
        ));
    }
    if body.trim().is_empty() {
        return Err("model service returned an empty response".to_string());
    }
    let prefix = body
        .trim_start()
        .chars()
        .take(500)
        .collect::<String>()
        .to_ascii_lowercase();
    if content_type.contains("text/html")
        || prefix.starts_with("<!doctype html")
        || prefix.starts_with("<html")
        || prefix.contains("<head")
        || prefix.contains("<body")
        || prefix.contains("</html>")
    {
        return Err("model service returned an HTML page; check that Base URL points to the API endpoint such as http://127.0.0.1:4000/v1, not a web UI".to_string());
    }
    Ok(body)
}

#[tauri::command]
pub async fn create_or_show_webview_tab(
    app: AppHandle,
    tab_id: String,
    url: String,
    title: Option<String>,
    focus: Option<bool>,
) -> Result<String, String> {
    if tab_id.trim().is_empty() {
        return Err("tab id is empty".to_string());
    }
    let parsed_url = parse_webview_url(&url)?;
    let label = native_webview_label(&tab_id);
    let _ = title;
    if let Some(webview) = app.get_webview(&label) {
        WEBVIEW_TABS
            .lock()
            .await
            .insert(tab_id.clone(), label.clone());
        webview
            .navigate(parsed_url)
            .map_err(|err| format!("navigate existing webview failed: {err}"))?;
        webview
            .show()
            .map_err(|err| format!("show existing webview failed: {err}"))?;
        if focus.unwrap_or(false) {
            webview
                .set_focus()
                .map_err(|err| format!("focus existing webview failed: {err}"))?;
        }
        return Ok(label);
    }

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .user_agent(DEFAULT_NATIVE_WEBVIEW_UA)
        .focused(focus.unwrap_or(false))
        .initialization_script(NATIVE_WEBVIEW_NAV_PATCH_SCRIPT);
    let nav_app = app.clone();
    let nav_tab_id = tab_id.clone();
    let download_app = app.clone();
    let download_tab_id = tab_id.clone();
    builder = builder.on_navigation(move |url| {
        let next = url.as_str();
        if !matches!(url.scheme(), "http" | "https") {
            return false;
        }
        if is_pdf_url(next) {
            // Keep this callback side-effect free. On macOS this runs inside
            // WebKit's navigation stack; mutating the same view here can cause
            // a transient blank page followed by a process crash. The
            // frontend hides the view after receiving the event.
            let payload = WebviewPdfLinkPayload {
                tab_id: nav_tab_id.clone(),
                url: next.to_string(),
            };
            let _ = nav_app.emit("r0nix://webview-pdf-link", payload);
            hide_webview_after_pdf_interception(&nav_app, native_webview_label(&nav_tab_id));
            return false;
        }
        let payload = WebviewNavigatedPayload {
            tab_id: nav_tab_id.clone(),
            url: next.to_string(),
        };
        let _ = nav_app.emit("r0nix://webview-navigated", payload);
        true
    });
    builder = builder.on_download(move |_webview, event| match event {
        DownloadEvent::Requested { url, destination } => {
            let url_string = url.to_string();
            let destination_is_pdf = destination
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
            if is_pdf_url(&url_string) || destination_is_pdf {
                // Returning false cancels the download. The frontend hides
                // the source view after receiving the event, outside this
                // platform callback.
                let payload = WebviewPdfLinkPayload {
                    tab_id: download_tab_id.clone(),
                    url: url_string,
                };
                let _ = download_app.emit("r0nix://webview-pdf-link", payload);
                hide_webview_after_pdf_interception(
                    &download_app,
                    native_webview_label(&download_tab_id),
                );
                // Let the frontend validate and stream the PDF instead of
                // letting WebView create a blank download/PDF surface.
                false
            } else {
                true
            }
        }
        DownloadEvent::Finished { .. } => true,
        _ => true,
    });
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    main.add_child(
        builder,
        Position::Logical(LogicalPosition::new(0.0, 0.0)),
        Size::Logical(LogicalSize::new(1.0, 1.0)),
    )
    .map_err(|err| format!("build embedded native webview failed: {err}"))?;
    WEBVIEW_TABS.lock().await.insert(tab_id, label.clone());
    Ok(label)
}

#[tauri::command]
pub async fn navigate_webview_tab(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let parsed_url = parse_webview_url(&url)?;
    let label = registered_webview_label(&tab_id).await?;

    if let Some(webview) = app.get_webview(&label) {
        webview
            .navigate(parsed_url)
            .map_err(|err| format!("navigate native webview failed: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn navigate_webview_tab_history(
    app: AppHandle,
    tab_id: String,
    direction: String,
) -> Result<(), String> {
    let label = registered_webview_label(&tab_id).await?;
    let script = match direction.as_str() {
        "back" => "history.back();",
        "forward" => "history.forward();",
        other => {
            return Err(format!(
                "unsupported native webview history direction: {other}"
            ))
        }
    };
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("native webview does not exist: {label}"))?;
    webview
        .eval(script)
        .map_err(|err| format!("navigate native webview history failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn show_webview_tab(
    app: AppHandle,
    tab_id: String,
    focus: Option<bool>,
) -> Result<(), String> {
    let label = registered_webview_label(&tab_id).await?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .show()
            .map_err(|err| format!("show native webview failed: {err}"))?;
        if focus.unwrap_or(false) {
            webview
                .set_focus()
                .map_err(|err| format!("focus native webview failed: {err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_webview_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = registered_webview_label(&tab_id).await?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .hide()
            .map_err(|err| format!("hide native webview failed: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_webview_tab_bounds(
    app: AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = registered_webview_label(&tab_id).await?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("native webview does not exist: {label}"))?;
    let safe_width = width.max(1.0);
    let safe_height = height.max(1.0);
    webview
        .set_size(Size::Logical(LogicalSize::new(safe_width, safe_height)))
        .map_err(|err| format!("sync native webview size failed: {err}"))?;
    webview
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|err| format!("sync native webview position failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn close_webview_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    // Remove the registration before closing the platform view. A close can
    // synchronously trigger late navigation/resize callbacks; those callbacks
    // must fail the lookup instead of operating on a view being torn down.
    let label = WEBVIEW_TABS.lock().await.remove(&tab_id);
    let Some(label) = label else {
        return Ok(());
    };
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|err| format!("close native webview failed: {err}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 本地工作区 —— 设置、密钥、资料库、伴读历史的唯一落盘根目录
//
// 见 workspace.rs 的布局说明。原来的做法把设置散在 localStorage、伴读历史散在
// app_data_dir 顶层，密钥在系统钥匙串 —— 三处各有一套生命周期。现在统一收口。
// ---------------------------------------------------------------------------

fn app_data_dir_or_err(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("app data dir unavailable: {err}"))
}

fn workspace_layout_or_err(app: &AppHandle) -> Result<workspace::WorkspaceLayout, String> {
    let app_data = app_data_dir_or_err(app)?;
    workspace::ensure_layout(&app_data)
}

/// 设置面板的「本地存储」面板数据源：路径 + 占用。
#[tauri::command]
pub async fn workspace_info(app: AppHandle) -> Result<workspace::WorkspaceInfo, String> {
    Ok(workspace::into_info(&workspace_layout_or_err(&app)?))
}

/// 切换工作区根目录。旧内容会先整份复制到新位置，复制成功后才改指针。
#[tauri::command]
pub async fn set_workspace_root(
    app: AppHandle,
    path: String,
) -> Result<workspace::WorkspaceInfo, String> {
    let target = ensure_non_empty_path(&path)?;
    let app_data = app_data_dir_or_err(&app)?;
    let layout = tokio::task::spawn_blocking(move || workspace::relocate(&app_data, &target))
        .await
        .map_err(|err| format!("workspace relocate task failed: {err}"))??;
    Ok(workspace::into_info(&layout))
}

/// 清空派生缓存。文档 / 设置 / 密钥 / 历史都不在这里面。
#[tauri::command]
pub async fn clear_workspace_cache(app: AppHandle) -> Result<usize, String> {
    let layout = workspace_layout_or_err(&app)?;
    tokio::task::spawn_blocking(move || workspace::clear_cache(&layout))
        .await
        .map_err(|err| format!("workspace cache task failed: {err}"))?
}

/// 把 PDF 复制一份进工作区 documents/，返回工作区内的稳定路径。
///
/// 资料库导入走这里：原件被移动、改名或删除之后，副本仍可打开 ——
/// 这是「本地资料库」和「最近打开列表」的根本区别。
#[tauri::command]
pub async fn import_document_to_workspace(
    app: AppHandle,
    source_path: String,
) -> Result<String, String> {
    let source = ensure_non_empty_path(&source_path)?;
    if !ensure_importable_extension(&source) {
        return Err("only pdf, md, or markdown files can be imported".to_string());
    }
    let layout = workspace_layout_or_err(&app)?;
    tokio::task::spawn_blocking(move || {
        let file_name = workspace::managed_document_file_name(&source);
        let target = workspace::resolve_in(&layout.documents_dir, &file_name)?;
        if target == source {
            return Ok(target.to_string_lossy().into_owned());
        }
        std::fs::copy(&source, &target).map_err(|err| {
            format!(
                "failed to copy {} into the workspace: {err}",
                source.display()
            )
        })?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| format!("workspace import task failed: {err}"))?
}

/// 删除工作区内的文档副本。路径必须真的落在 documents/ 下。
#[tauri::command]
pub async fn remove_workspace_document(app: AppHandle, path: String) -> Result<(), String> {
    let requested = ensure_non_empty_path(&path)?;
    let layout = workspace_layout_or_err(&app)?;
    let documents_dir = layout.documents_dir.clone();
    let resolved = workspace::resolve_in(&documents_dir, &requested.to_string_lossy())?;
    // resolve_in 只做词法校验；再比一次父目录，挡住符号链接与拼接技巧。
    if resolved.parent() != Some(documents_dir.as_path()) {
        return Err("refusing to remove a path outside the workspace documents folder".to_string());
    }
    match tokio::fs::remove_file(&resolved).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove workspace document: {error}")),
    }
}

/// 在访达 / 资源管理器里打开工作区目录，让用户能自己看到、备份、搬走这些文件。
#[tauri::command]
pub async fn reveal_workspace(app: AppHandle) -> Result<String, String> {
    let layout = workspace_layout_or_err(&app)?;
    let root = layout.root.to_string_lossy().into_owned();
    open_directory_in_file_manager(&root).await?;
    Ok(root)
}

async fn open_directory_in_file_manager(path: &str) -> Result<(), String> {
    let target = path.to_string();
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = std::process::Command::new("open");
            command.arg(&target);
            command
        };
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = std::process::Command::new("explorer");
            command.arg(&target);
            command
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = {
            let mut command = std::process::Command::new("xdg-open");
            command.arg(&target);
            command
        };
        command
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("failed to open the workspace folder: {err}"))
    })
    .await
    .map_err(|err| format!("reveal workspace task failed: {err}"))?
}

// ---------------------------------------------------------------------------
// 秘密存储（工作区内 0600 文件）
//
// ⚠️ 为什么不再用 macOS 钥匙串：钥匙串对**每次读取**都弹授权框要密码，
// 而 API Key 每次启动都要读 —— 于是变成「开软件先输密码」。用户明确要求
// 改为本地文件存储，密钥随工作区一起被备份、搬走、清除。
//
// 安全边界没有丢，只是换了位置：
// - 工作区目录 0700、secrets.json 0600（仅当前系统账号可读）；
// - 永不进 localStorage（契约由 userSettings.ts + test-settings-security.mjs 钉住）；
// - 写盘走临时文件 + rename，避免半截文件把密钥写坏成不可恢复的乱码。
//
// 钥匙串只保留一条**用户主动点击**才走的迁移通道（migrate_keychain_secret）。
// ---------------------------------------------------------------------------

const SECRET_SERVICE: &str = "r0nix";
pub const SECRET_ACCOUNT_API_KEY: &str = "ai-api-key";
const SECRETS_FILE: &str = "secrets.json";

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SecretsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    secrets: HashMap<String, String>,
}

fn read_secrets_file(path: &Path) -> Result<SecretsFile, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            // 损坏的密钥文件不能静默当成「没存」：那样用户会以为密钥丢了并覆盖它。
            // 返回 None 表示「无法解析」，由调用方决定是报错还是走迁移。
            .map_err(|err| format!("secrets file is corrupted: {err}")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(SecretsFile {
            version: 1,
            secrets: HashMap::new(),
        }),
        Err(err) => Err(format!("failed to read secrets file: {err}")),
    }
}

fn write_secrets_file(path: &Path, file: &SecretsFile) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(file)
        .map_err(|err| format!("failed to serialize secrets: {err}"))?;
    // 临时文件 + rename：rename 在同一文件系统内是原子的，
    // 因此磁盘上不会出现「写了一半的密钥文件」。
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serialized).map_err(|err| format!("failed to write secrets: {err}"))?;
    workspace::restrict_secret_permissions_public(&temp);
    std::fs::rename(&temp, path).map_err(|err| format!("failed to commit secrets: {err}"))?;
    workspace::restrict_secret_permissions_public(path);
    Ok(())
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, account)
        .map_err(|err| format!("keychain unavailable: {err}"))
}

/// 写入秘密；空串语义为「删除」。
#[tauri::command]
pub async fn store_secret(app: AppHandle, account: String, secret: String) -> Result<(), String> {
    let layout = workspace_layout_or_err(&app)?;
    tokio::task::spawn_blocking(move || {
        if account.trim().is_empty() {
            return Err("secret account is empty".to_string());
        }
        let path = workspace::resolve_in(&layout.config_dir, SECRETS_FILE)?;
        let mut file = read_secrets_file(&path)?;
        file.version = 1;
        if secret.is_empty() {
            // 删除不存在的条目不算错（幂等）。
            file.secrets.remove(&account);
        } else {
            file.secrets.insert(account, secret);
        }
        write_secrets_file(&path, &file)
    })
    .await
    .map_err(|err| format!("store secret task failed: {err}"))?
}

/// 读取秘密；不存在返回 `null`（而非错误），前端据此区分「没存过」与「存失败」。
#[tauri::command]
pub async fn load_secret(app: AppHandle, account: String) -> Result<Option<String>, String> {
    let layout = workspace_layout_or_err(&app)?;
    tokio::task::spawn_blocking(move || {
        let path = workspace::resolve_in(&layout.config_dir, SECRETS_FILE)?;
        let file = read_secrets_file(&path)?;
        Ok(file.secrets.get(&account).cloned())
    })
    .await
    .map_err(|err| format!("load secret task failed: {err}"))?
}

/// 一次性把钥匙串里的旧密钥搬进工作区文件，然后删掉钥匙串条目。
///
/// 只在用户**主动点击**设置里的迁移按钮时调用 —— 启动流程绝不碰钥匙串，
/// 否则又会回到「每次启动都要输密码」。
#[tauri::command]
pub async fn migrate_keychain_secret(app: AppHandle) -> Result<Option<String>, String> {
    let layout = workspace_layout_or_err(&app)?;
    tokio::task::spawn_blocking(move || {
        let path = workspace::resolve_in(&layout.config_dir, SECRETS_FILE)?;
        let mut file = read_secrets_file(&path)?;
        // 工作区已有密钥就什么都不做：文件是现在的权威，钥匙串只是历史。
        if let Some(existing) = file.secrets.get(SECRET_ACCOUNT_API_KEY) {
            if !existing.is_empty() {
                let _ = keyring_entry(SECRET_ACCOUNT_API_KEY)?.delete_password();
                return Ok(Some(existing.clone()));
            }
        }
        let entry = keyring_entry(SECRET_ACCOUNT_API_KEY)?;
        let legacy = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(err) => {
                return Err(format!(
                    "macOS refused to release the keychain entry (that prompt asking for your password is exactly what we are removing): {err}"
                ))
            }
        };
        if legacy.is_empty() {
            return Ok(None);
        }
        file.version = 1;
        file.secrets
            .insert(SECRET_ACCOUNT_API_KEY.to_string(), legacy.clone());
        write_secrets_file(&path, &file)?;
        // 搬完就删钥匙串条目：留着它等于留一个每次读取都要授权的旧入口。
        let _ = entry.delete_password();
        Ok(Some(legacy))
    })
    .await
    .map_err(|err| format!("keychain migration task failed: {err}"))?
}

/// 应用数据目录（macOS: ~/Library/Application Support/<id>）。
/// 工作区之外的宿主目录，读者用它来展示「工作区在哪」。
#[tauri::command]
pub async fn app_data_dir(app: AppHandle) -> Result<String, String> {
    Ok(app_data_dir_or_err(&app)?.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// 工作区 JSON 存储 —— 设置、伴读历史、资料库索引的落盘通道。
//
// 为什么不用通用 read_text_file / write_text_file：
// - read_text_file 只放行 md/markdown，读 .json 会被扩展名白名单直接拒绝；
// - write_text_file 面向「用户选的文件路径」，父目录得自己保证存在，
//   而 `assist-history/` 首次写入时尚不存在；放开它等于扩大任意写覆盖面。
// 因此这里提供专用通道，并把路径强制限制在工作区之内：
// 前端只传相对 key，拼路径、越界校验、目录创建都在这里做。
//
// ⚠️ 旧实现自己写了一套校验，并且**拒绝任何含路径分隔符的 key**；
// 而 assistHistory 传的恰恰是 `assist-history/<id>.json`。于是每次写入都被拒，
// 历史静默退回 localStorage，重启即丢。校验逻辑已迁到 workspace::resolve_in，
// 那里逐段放行合法的多级 key。
// ---------------------------------------------------------------------------

/// 读工作区 JSON。文件不存在返回 `Ok(None)`（区别于「读失败」），
/// 调用方据此实现「首次打开该 PDF 还没有历史」。
#[tauri::command]
pub async fn read_app_data_json(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let layout = workspace_layout_or_err(&app)?;
    let path = workspace::resolve_in(&layout.root, &key)?;
    tokio::task::spawn_blocking(move || {
        // NotFound 是正常状态（该文档尚无历史），不当作错误。
        match std::fs::read_to_string(&path) {
            Ok(content) => Ok(Some(content)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("failed to read workspace json: {err}")),
        }
    })
    .await
    .map_err(|err| format!("workspace read task failed: {err}"))?
}

/// 写工作区 JSON，父目录不存在时自动创建。
#[tauri::command]
pub async fn write_app_data_json(
    app: AppHandle,
    key: String,
    content: String,
) -> Result<(), String> {
    let layout = workspace_layout_or_err(&app)?;
    let path = workspace::resolve_in(&layout.root, &key)?;
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create workspace dir: {err}"))?;
        }
        // 临时文件 + rename：断电 / 崩溃时不会留下半截 JSON，
        // 下次启动读到的是上一个完整版本，而不是一个解析失败的残片。
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, content)
            .map_err(|err| format!("failed to write workspace json: {err}"))?;
        std::fs::rename(&temp, &path)
            .map_err(|err| format!("failed to commit workspace json: {err}"))
    })
    .await
    .map_err(|err| format!("workspace write task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_llm_chat_completion, cancel_pdf_byte_read, cancel_pdf_page_count,
        ensure_allowed_binary_write_path, ensure_allowed_text_write_path,
        ensure_importable_extension, ensure_markdown_extension, ensure_pdf_extension,
        is_managed_import_temp_path, is_managed_web_pdf_path, is_pdf_url, is_request_canceled,
        normalize_download_url, parse_webview_url, read_secrets_file, sanitize_file_name,
        wait_for_request_canceled, write_secrets_file, CANCELED_REQUESTS,
        PDF_BYTE_READ_CANCEL_FLAGS, PDF_PAGE_COUNT_CANCEL_FLAGS, SECRETS_FILE,
        SECRET_ACCOUNT_API_KEY,
    };
    use crate::workspace;
    use std::collections::HashMap;
    use std::{
        path::Path,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    /// 密钥文件往返：这条链路是「不输密码」方案的全部依赖，必须端到端验过。
    #[test]
    fn secrets_file_round_trips_without_touching_the_keychain() {
        let dir = std::env::temp_dir().join("r0nix-secrets-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(SECRETS_FILE);

        // 首次写入
        let mut secrets = HashMap::new();
        secrets.insert(
            SECRET_ACCOUNT_API_KEY.to_string(),
            "sk-local-file".to_string(),
        );
        write_secrets_file(
            &path,
            &super::SecretsFile {
                version: 1,
                secrets,
            },
        )
        .expect("writing secrets must succeed");

        let read = read_secrets_file(&path).expect("reading secrets must succeed");
        assert_eq!(
            read.secrets.get(SECRET_ACCOUNT_API_KEY).map(String::as_str),
            Some("sk-local-file"),
            "the API key must survive a round trip through the local file"
        );

        // 文件权限必须是 0600：工作区里可能有密钥，它不能对同机其他账号可读。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("stat secrets")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "secrets.json must be 0600, got {mode:o}");
        }

        // 不留临时文件残骸
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the commit temp file must be renamed away, not left behind"
        );

        // 删除语义：空串等价于移除，且删除不存在的键必须幂等
        let mut current = read_secrets_file(&path).expect("re-read");
        current.secrets.remove(SECRET_ACCOUNT_API_KEY);
        write_secrets_file(&path, &current).expect("clearing must succeed");
        let cleared = read_secrets_file(&path).expect("re-read after clear");
        assert!(
            !cleared.secrets.contains_key(SECRET_ACCOUNT_API_KEY),
            "an empty secret must remove the entry"
        );
        write_secrets_file(&path, &cleared).expect("clearing again must be idempotent");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 损坏的密钥文件必须**报错**而不是当成「没存过」。
    ///
    /// 后者会让用户以为密钥丢了、重新输入，然后覆盖掉本来还能救回来的内容。
    #[test]
    fn a_corrupted_secrets_file_is_reported_instead_of_looking_empty() {
        let dir = std::env::temp_dir().join("r0nix-secrets-corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(SECRETS_FILE);
        std::fs::write(&path, "{ truncated").expect("write corrupt file");

        let result = read_secrets_file(&path);
        assert!(
            result.is_err(),
            "a corrupt secrets file must not read as empty"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 缺文件必须读成「空集合」，这是首次启动的正常状态。
    #[test]
    fn a_missing_secrets_file_reads_as_empty() {
        let dir = std::env::temp_dir().join("r0nix-secrets-missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let read =
            read_secrets_file(&dir.join(SECRETS_FILE)).expect("missing file is not an error");
        assert!(read.secrets.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 工作区 JSON 通道必须真的接受多级 key（伴读历史一直是多级的）。
    #[test]
    fn workspace_json_keys_accept_nested_history_paths() {
        let root = std::env::temp_dir().join("r0nix-workspace-json-keys");
        let path = workspace::resolve_in(&root, "assist-history/doc-42.json")
            .expect("a nested key must resolve");
        assert_eq!(path, root.join("assist-history").join("doc-42.json"));
        // 越界仍然要挡住
        assert!(workspace::resolve_in(&root, "config/../../escape.json").is_err());
    }

    /// 切换工作区必须先复制再改指针，失败时旧数据仍在。
    #[test]
    fn relocating_the_workspace_copies_before_switching() {
        let app_data = std::env::temp_dir().join("r0nix-workspace-relocate-src");
        let target = std::env::temp_dir().join("r0nix-workspace-relocate-dst");
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&app_data).expect("create app data");

        let layout = workspace::ensure_layout(&app_data).expect("layout");
        std::fs::write(layout.config_dir.join("settings.json"), "{\"probe\":true}")
            .expect("seed a file");

        let moved = workspace::relocate(&app_data, &target).expect("relocate");
        assert_eq!(moved.root, target);
        assert!(
            moved.is_custom,
            "a relocated workspace must be flagged custom"
        );
        assert!(
            target.join("config").join("settings.json").exists(),
            "existing data must be copied to the new location"
        );
        assert!(
            layout.root.join("config").join("settings.json").exists(),
            "the old copy must be left intact as a fallback"
        );

        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&target);
    }

    /// 目标非空时必须拒绝：把工作区塞进一个装满别的文件的目录会毁掉那些文件。
    #[test]
    fn relocating_into_a_non_empty_folder_is_refused() {
        let app_data = std::env::temp_dir().join("r0nix-workspace-relocate-busy-src");
        let target = std::env::temp_dir().join("r0nix-workspace-relocate-busy-dst");
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&app_data).expect("create app data");
        std::fs::create_dir_all(&target).expect("create target");
        std::fs::write(target.join("someone-elses-file.txt"), "keep me").expect("seed");

        let result = workspace::relocate(&app_data, &target);
        assert!(result.is_err(), "a non-empty target must be refused");
        assert!(
            target.join("someone-elses-file.txt").exists(),
            "existing files in the target must be left alone"
        );

        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[tokio::test]
    async fn llm_cancellation_is_visible_to_the_request_waiter() {
        let request_id = "llm-test-cancel".to_string();
        CANCELED_REQUESTS.lock().await.remove(&request_id);
        let waiter_id = request_id.clone();
        let waiter = tokio::spawn(async move {
            wait_for_request_canceled(&waiter_id).await;
        });
        cancel_llm_chat_completion(request_id.clone())
            .await
            .expect("cancellation command should accept a valid id");
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("request waiter should observe cancellation")
            .expect("request waiter should not panic");
        CANCELED_REQUESTS.lock().await.remove(&request_id);
    }

    #[tokio::test]
    async fn cancellation_before_wait_is_observed_immediately() {
        let request_id = "llm-cancel-before-wait-test".to_string();
        CANCELED_REQUESTS.lock().await.insert(request_id.clone());
        tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_request_canceled(&request_id),
        )
        .await
        .expect("a pre-existing cancel flag must return without waiting for a notify");
        CANCELED_REQUESTS.lock().await.remove(&request_id);
    }

    #[tokio::test]
    async fn cancellation_state_is_scoped_to_request_id() {
        let request_id = "llm-cancel-waiter-test".to_string();
        let other_id = "llm-cancel-other-test".to_string();
        CANCELED_REQUESTS.lock().await.remove(&request_id);
        CANCELED_REQUESTS.lock().await.insert(other_id.clone());
        assert!(!is_request_canceled(&request_id).await);
        assert!(is_request_canceled(&other_id).await);
        CANCELED_REQUESTS.lock().await.remove(&other_id);
    }

    #[tokio::test]
    async fn pdf_open_cancellation_marks_registered_native_tasks() {
        let byte_request = "pdf-byte-cancel-test".to_string();
        let page_request = "pdf-page-count-cancel-test".to_string();
        let byte_flag = Arc::new(AtomicBool::new(false));
        let page_flag = Arc::new(AtomicBool::new(false));
        PDF_BYTE_READ_CANCEL_FLAGS
            .lock()
            .await
            .insert(byte_request.clone(), byte_flag.clone());
        PDF_PAGE_COUNT_CANCEL_FLAGS
            .lock()
            .await
            .insert(page_request.clone(), page_flag.clone());

        cancel_pdf_byte_read(byte_request.clone())
            .await
            .expect("byte read cancellation should accept a registered request");
        cancel_pdf_page_count(page_request.clone())
            .await
            .expect("page count cancellation should accept a registered request");

        assert!(byte_flag.load(Ordering::Acquire));
        assert!(page_flag.load(Ordering::Acquire));
        PDF_BYTE_READ_CANCEL_FLAGS
            .lock()
            .await
            .remove(&byte_request);
        PDF_PAGE_COUNT_CANCEL_FLAGS
            .lock()
            .await
            .remove(&page_request);
    }

    #[test]
    fn detects_common_pdf_navigation_urls() {
        let pdf_urls = [
            "https://example.com/paper.pdf",
            "https://example.com/article/pdf/10.1000/demo",
            "https://example.com/pdfs/abc",
            "https://example.com/download?file=paper.pdf",
            "https://example.com/export?format=pdf",
            "https://example.com/view#type=pdf",
            "https://example.com/view?mime=application/pdf",
            "https://example.com/download%2Fpaper%2Epdf",
        ];

        for url in pdf_urls {
            assert!(is_pdf_url(url), "expected PDF URL: {url}");
        }
    }

    #[test]
    fn ignores_non_pdf_navigation_urls() {
        let non_pdf_urls = [
            "https://example.com/article/html/10.1000/demo",
            "https://example.com/download?file=paper.txt",
            "https://example.com/profile",
        ];

        for url in non_pdf_urls {
            assert!(!is_pdf_url(url), "expected non-PDF URL: {url}");
        }
    }

    #[test]
    fn restricts_native_file_command_extensions() {
        assert!(ensure_markdown_extension(Path::new("note.md")));
        assert!(ensure_markdown_extension(Path::new("note.markdown")));
        assert!(!ensure_markdown_extension(Path::new("note.txt")));

        assert!(ensure_importable_extension(Path::new("paper.pdf")));
        assert!(ensure_importable_extension(Path::new("note.md")));
        assert!(!ensure_importable_extension(Path::new("secret.env")));
        assert!(ensure_pdf_extension(Path::new("PAPER.PDF")));
        assert!(!ensure_pdf_extension(Path::new("note.md")));
        assert!(parse_webview_url("https://example.com/paper").is_ok());
        assert!(parse_webview_url("file:///tmp/paper.pdf").is_err());
        assert!(parse_webview_url("javascript:alert(1)").is_err());

        assert!(ensure_allowed_text_write_path(Path::new("export.csv")).is_ok());
        assert!(ensure_allowed_text_write_path(Path::new("diagram.svg")).is_ok());
        assert!(ensure_allowed_text_write_path(Path::new("EXPORT.CSV")).is_ok());
        assert!(ensure_allowed_text_write_path(Path::new("script.sh")).is_err());

        assert!(ensure_allowed_binary_write_path(Path::new("page.png")).is_ok());
        assert!(ensure_allowed_binary_write_path(Path::new("figure.webp")).is_ok());
        assert!(ensure_allowed_binary_write_path(Path::new("figure.jp2")).is_ok());
        assert!(ensure_allowed_binary_write_path(Path::new("paper.pdf")).is_ok());
        assert!(ensure_allowed_binary_write_path(Path::new("notes.md")).is_err());
    }

    #[test]
    fn rejects_temp_file_names_with_path_separators() {
        assert!(sanitize_file_name("paper.pdf").is_ok());
        assert!(sanitize_file_name("note.md").is_ok());
        assert!(sanitize_file_name("../paper.pdf").is_err());
        assert!(sanitize_file_name("nested/paper.pdf").is_err());
        assert!(sanitize_file_name("nested\\paper.pdf").is_err());
    }

    #[test]
    fn managed_web_pdf_cleanup_is_limited_to_the_app_temp_directory() {
        let temp_dir = Path::new("/tmp/r0nix");
        assert!(is_managed_web_pdf_path(
            temp_dir,
            Path::new("/tmp/r0nix/r0nix-web-123-paper.pdf")
        ));
        assert!(!is_managed_web_pdf_path(
            temp_dir,
            Path::new("/tmp/r0nix/paper.pdf")
        ));
        assert!(!is_managed_web_pdf_path(
            temp_dir,
            Path::new("/tmp/other/r0nix-web-123-paper.pdf")
        ));
        assert!(!is_managed_web_pdf_path(
            temp_dir,
            Path::new("/tmp/r0nix/r0nix-web-123-paper.txt")
        ));
    }

    #[test]
    fn managed_import_cleanup_is_limited_to_owned_temp_files() {
        let temp_dir = Path::new("/tmp/r0nix");
        assert!(is_managed_import_temp_path(
            temp_dir,
            Path::new("/tmp/r0nix/r0nix-import-42-paper.pdf")
        ));
        assert!(is_managed_import_temp_path(
            temp_dir,
            Path::new("/tmp/r0nix/r0nix-import-42-note.md")
        ));
        assert!(!is_managed_import_temp_path(
            temp_dir,
            Path::new("/tmp/r0nix/paper.pdf")
        ));
        assert!(!is_managed_import_temp_path(
            temp_dir,
            Path::new("/tmp/other/r0nix-import-42-paper.pdf")
        ));
        assert!(!is_managed_import_temp_path(
            temp_dir,
            Path::new("/tmp/r0nix/r0nix-import-42-script.sh")
        ));
    }

    #[test]
    fn restricts_proxy_download_urls_to_http() {
        assert!(normalize_download_url("https://example.com/paper.pdf").is_ok());
        assert!(normalize_download_url("http://127.0.0.1:8080/paper.pdf").is_ok());
        assert!(normalize_download_url("file:///tmp/paper.pdf").is_err());
        assert!(normalize_download_url("javascript:alert(1)").is_err());
        assert!(normalize_download_url("").is_err());
    }

    #[test]
    #[ignore = "requires the embedded Python/PyMuPDF runtime"]
    fn verifies_original_image_and_svg_crop_exports() {
        use crate::py_render::{
            extract_pdf_image_json, get_page_images_json, render_page_svg_crop,
        };
        use base64::Engine as _;
        use std::time::{SystemTime, UNIX_EPOCH};

        let path = std::env::temp_dir().join(format!(
            "r0nix-export-fixture-{}.pdf",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let image_bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .expect("fixture PNG");
        crate::py_render::ensure_test_pdf_with_image(&path, &image_bytes)
            .expect("create PDF fixture");

        let listed: serde_json::Value = serde_json::from_str(
            &get_page_images_json(path.to_str().expect("fixture path"), 1, None)
                .expect("list PDF images"),
        )
        .expect("valid image list JSON");
        let image = listed
            .as_array()
            .and_then(|items| items.first())
            .expect("one embedded image");
        assert!(
            listed.as_array().is_some_and(|items| items.len() >= 2),
            "wide raster resources must remain discoverable"
        );
        let raster_items = listed
            .as_array()
            .expect("image list array")
            .iter()
            .filter(|item| item["source"] == "xref")
            .collect::<Vec<_>>();
        assert!(
            raster_items.len() >= 3,
            "nearby placements of one xref must remain separate export targets"
        );
        let vector_items = listed
            .as_array()
            .expect("image list array")
            .iter()
            .filter(|item| item["source"] == "vector")
            .collect::<Vec<_>>();
        assert!(
            vector_items.len() >= 2,
            "separate vector paths must remain separate resources"
        );
        let vector_widths = vector_items
            .iter()
            .filter_map(|item| {
                let bbox = item["bbox"].as_array()?;
                let left = bbox.first()?.as_f64()?;
                let right = bbox.get(2)?.as_f64()?;
                Some(right - left)
            })
            .collect::<Vec<_>>();
        assert!(
            vector_widths
                .iter()
                .any(|width| (*width - 50.0).abs() < 0.1)
                && vector_widths
                    .iter()
                    .any(|width| (*width - 40.0).abs() < 0.1),
            "nested vector paths must retain both outer and inner export bounds"
        );
        assert!(
            vector_items.iter().any(|item| {
                let bbox = item["bbox"].as_array();
                bbox.and_then(|values| values.get(2))
                    .and_then(serde_json::Value::as_f64)
                    .zip(
                        bbox.and_then(|values| values.first())
                            .and_then(serde_json::Value::as_f64),
                    )
                    .is_some_and(|(right, left)| right - left > 100.0)
            }),
            "large vector figures must remain discoverable"
        );
        assert!(
            vector_items.iter().any(|item| {
                let bbox = item["bbox"].as_array();
                bbox.and_then(|values| values.get(2))
                    .and_then(serde_json::Value::as_f64)
                    .zip(
                        bbox.and_then(|values| values.first())
                            .and_then(serde_json::Value::as_f64),
                    )
                    .is_some_and(|(right, left)| right - left < 70.0)
            }),
            "nearby vector paths must not be merged into a large candidate"
        );
        let xref = image["xref"].as_u64().expect("image xref") as usize;
        assert_eq!(image["extension"], "png");
        assert_eq!(image["width"], 1);
        assert_eq!(image["height"], 1);
        assert_eq!(image["bbox"][0].as_f64(), Some(10.0));
        assert_eq!(image["bbox"][1].as_f64(), Some(10.0));

        let extracted: serde_json::Value = serde_json::from_str(
            &extract_pdf_image_json(path.to_str().expect("fixture path"), 1, xref)
                .expect("extract original image"),
        )
        .expect("valid extracted image JSON");
        assert_eq!(extracted["xref"].as_u64(), Some(xref as u64));
        assert_eq!(extracted["extension"], "png");
        assert_eq!(extracted["width"], 1);
        assert_eq!(extracted["height"], 1);
        let extracted_bytes = base64::engine::general_purpose::STANDARD
            .decode(extracted["dataBase64"].as_str().expect("base64 image"))
            .expect("decode extracted image");
        assert!(extracted_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(!extracted_bytes.is_empty());

        let svg = render_page_svg_crop(
            path.to_str().expect("fixture path"),
            1,
            20.0,
            30.0,
            60.0,
            40.0,
        )
        .expect("export SVG crop");
        assert!(svg.contains("<svg"));
        assert!(
            svg.contains("viewBox=\"20 110 60 40\""),
            "SVG crop must convert PDF top-origin coordinates to SVG coordinates"
        );
        assert!(
            svg.contains("clipPath id=\"r0nix-crop\"")
                && svg.contains("clip-path=\"url(#r0nix-crop)\"")
                && svg.contains("overflow=\"hidden\""),
            "SVG crop must explicitly clip the exported content to the target bounds"
        );
        assert!(
            svg.len() < 50_000,
            "crop unexpectedly expanded to page-sized SVG"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    #[ignore = "requires the embedded Python/PyMuPDF runtime"]
    fn image_scan_honors_cancellation_probe() {
        use crate::py_render::{ensure_test_pdf_with_image, get_page_images_json};
        use base64::Engine as _;
        use std::sync::{atomic::AtomicBool, Arc};
        use std::time::{SystemTime, UNIX_EPOCH};

        let path = std::env::temp_dir().join(format!(
            "r0nix-image-cancel-fixture-{}.pdf",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let image_bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .expect("fixture PNG");
        ensure_test_pdf_with_image(&path, &image_bytes).expect("create image fixture");
        let result = get_page_images_json(
            path.to_str().expect("fixture path"),
            1,
            Some(Arc::new(AtomicBool::new(true))),
        );
        assert!(result
            .expect_err("cancelled image scan must fail")
            .contains("r0nix-cancelled"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    #[ignore = "requires the embedded Python/PyMuPDF runtime"]
    fn extracts_a_1000_page_document_in_bounded_chunks() {
        use crate::py_render::{ensure_test_pdf_with_text_pages, get_pdf_reading_blocks_json};
        use std::time::{SystemTime, UNIX_EPOCH};

        let path = std::env::temp_dir().join(format!(
            "r0nix-long-fixture-{}.pdf",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        ensure_test_pdf_with_text_pages(&path, 1000).expect("create long PDF fixture");

        let mut pages = std::collections::BTreeSet::new();
        for start_page in (1..=1000).step_by(24) {
            let end_page = (start_page + 23).min(1000);
            let raw = get_pdf_reading_blocks_json(
                path.to_str().expect("fixture path"),
                Some(start_page),
                Some(end_page),
                None,
            )
            .expect("extract chunk");
            let blocks: Vec<serde_json::Value> =
                serde_json::from_str(&raw).expect("valid blocks JSON");
            for block in blocks {
                if let Some(page) = block["page"].as_u64() {
                    pages.insert(page as usize);
                }
            }
        }
        assert_eq!(pages.len(), 1000);
        assert_eq!(pages.first(), Some(&1));
        assert_eq!(pages.last(), Some(&1000));
        let _ = std::fs::remove_file(path);
    }

    // `report()` 读 `getrusage(RUSAGE_SELF)`，是 Unix 专有接口：Windows 的 libc 里没有
    // `rusage` / `getrusage` / `RUSAGE_SELF` 这三个符号。这个探针本来就是给 macOS 的
    // 内存调查用的，所以在非 Unix 平台整段剔除 —— 否则 `--all-targets` 会在 Windows 上
    // 编译失败（clippy 门禁即挂在这里）。
    #[cfg(unix)]
    #[test]
    #[ignore = "manual memory probe: prints peak RSS across the PyMuPDF stages"]
    fn probe_pdf_memory_footprint() {
        use crate::pdf_manager::PdfManager;
        use crate::py_render::{
            ensure_test_pdf_with_text_pages, get_pdf_reading_blocks_json, render_page_png,
        };
        use std::time::{SystemTime, UNIX_EPOCH};

        /// `ru_maxrss` 在 macOS 是**字节**、在 Linux 是 KiB —— 单位别混。
        fn report(label: &str) {
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
            let bytes = if cfg!(target_os = "macos") {
                usage.ru_maxrss as f64
            } else {
                usage.ru_maxrss as f64 * 1024.0
            };
            println!(
                "[mem-probe] {label:<30} peak RSS = {:>8.1} MiB",
                bytes / 1048576.0
            );
        }

        let path = std::env::temp_dir().join(format!(
            "r0nix-mem-probe-{}.pdf",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        ensure_test_pdf_with_text_pages(&path, 200).expect("create memory fixture");
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        println!(
            "[mem-probe] fixture: {} pages, {:.2} MiB",
            200,
            size as f64 / 1048576.0
        );
        report("1. 夹具落盘后（基线）");

        let path_str = path.to_str().expect("fixture path");
        let mut manager = PdfManager::new();
        manager
            .open_document("mem-probe".to_string(), path_str)
            .expect("open fixture document");
        report("2. open_document 之后");

        // 模拟真实打开流程：阅读块按 24 页分块抽完（与 extracts_a_1000_page 同一路径）。
        for start_page in (1..=200usize).step_by(24) {
            let end_page = (start_page + 23).min(200);
            let raw = get_pdf_reading_blocks_json(path_str, Some(start_page), Some(end_page), None)
                .expect("extract reading blocks");
            std::hint::black_box(raw.len());
        }
        report("3. 200 页 reading blocks 抽完");

        let png = render_page_png(path_str, 1, 2.0).expect("render page 1");
        std::hint::black_box(png.len());
        report("4. render_page_png 一页后");

        manager
            .close_document("mem-probe")
            .expect("close fixture document");
        report("5. close_document 之后");

        let _ = std::fs::remove_file(&path);
    }

    /// 量「整份 PDF 过 base64 IPC」这条路的**峰值 RSS**。
    ///
    /// 为什么必须单独量：真实 Tauri 打开文档时，Rust 主进程与 WebView 是**两个不同进程**，
    /// 峰值 RSS 可以直接相加。而 Playwright 探针走的是浏览器 `file.arrayBuffer()` 路径，
    /// **完全绕过这条 IPC 通路**，所以它量不到这一段 —— 只能在这里补齐。
    ///
    /// 复现的是 `read_opened_pdf_bytes` 的实际峰值链（该函数本体是 async tauri command，
    /// 起不来完整 app 上下文，所以按同样顺序展开）：
    /// `Vec<u8>`(N) → `BASE64.encode`(1.33N) → `serde_json::to_string`(≈1.35N)。
    ///
    /// 夹具由 `scripts/probe-pdf-memory-footprint.mjs` 生成（每页独立位图的扫描件）。
    /// 用法：
    /// ```text
    /// node scripts/probe-pdf-memory-footprint.mjs 200          # 产出 /tmp/scanned-200.pdf
    /// R0NIX_MEM_FIXTURE=/tmp/scanned-200.pdf \
    ///   cargo test --lib probe_pdf_base64_ipc_peak -- --ignored --nocapture
    /// ```
    /// 注意 `ru_maxrss` 是**峰值且单调不减**，所以「drop 之后」不会回落 —— 这不是泄漏，
    /// 只看各步之间的**增量**。
    // 同上：`report()` 依赖 `getrusage`，Windows 上无此符号。
    #[cfg(unix)]
    #[test]
    #[ignore = "manual memory probe: peak RSS of the base64 IPC byte path"]
    fn probe_pdf_base64_ipc_peak() {
        use base64::Engine as _;

        fn report(label: &str) {
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
            let bytes = if cfg!(target_os = "macos") {
                usage.ru_maxrss as f64
            } else {
                usage.ru_maxrss as f64 * 1024.0
            };
            println!(
                "[ipc-probe] {label:<32} peak RSS = {:>8.1} MiB",
                bytes / 1048576.0
            );
        }

        let path = std::env::var("R0NIX_MEM_FIXTURE")
            .unwrap_or_else(|_| "/tmp/scanned-200.pdf".to_string());
        let size = match std::fs::metadata(&path) {
            Ok(meta) => meta.len(),
            Err(_) => {
                println!(
                    "[ipc-probe] 跳过：找不到夹具 {path}\n\
                     [ipc-probe] 先跑 node scripts/probe-pdf-memory-footprint.mjs 200 生成它"
                );
                return;
            }
        };
        println!(
            "[ipc-probe] 夹具 {path} = {:.1} MiB",
            size as f64 / 1048576.0
        );
        report("0. 基线");

        let bytes = std::fs::read(&path).expect("read fixture");
        report("1. 读入 Vec<u8>（N）");

        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        report("2. base64 编码（+1.33N）");

        let json = serde_json::to_string(&encoded).expect("serialize base64 payload");
        report("3. JSON 序列化（+1.35N）");

        std::hint::black_box((&bytes, &json));
        drop(json);
        drop(encoded);
        drop(bytes);
        report("4. 全部 drop 后（峰值不回落）");
    }

    #[test]
    #[ignore = "requires the embedded Python/PyMuPDF runtime"]
    fn reading_block_extraction_honors_cancellation_probe() {
        use crate::py_render::{ensure_test_pdf_with_text_pages, get_pdf_reading_blocks_json};
        use std::sync::{atomic::AtomicBool, Arc};
        use std::time::{SystemTime, UNIX_EPOCH};

        let path = std::env::temp_dir().join(format!(
            "r0nix-cancel-fixture-{}.pdf",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        ensure_test_pdf_with_text_pages(&path, 4).expect("create cancellation fixture");
        let flag = Arc::new(AtomicBool::new(true));
        let result = get_pdf_reading_blocks_json(
            path.to_str().expect("fixture path"),
            Some(1),
            Some(4),
            Some(flag),
        );
        assert!(result
            .expect_err("cancelled extraction must fail")
            .contains("r0nix-cancelled"));
        let _ = std::fs::remove_file(path);
    }
}
