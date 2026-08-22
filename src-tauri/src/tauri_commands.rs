use crate::pdf_manager::PDF_MANAGER;
use crate::py_render::{
    extract_pdf_image_json, get_page_count as get_pdf_page_count, get_page_images_json,
    get_pdf_reading_blocks_json, render_page_png, render_page_svg, render_page_svg_crop,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::png::PngEncoder;
use image::{imageops, ColorType, ImageEncoder, RgbaImage};
use pdf_core::{plan_visible_tiles, PdfInfo, TileReadyPayload, TileRequestAck, TileViewport};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position,
    Size, Url, WebviewUrl,
};
use tokio::sync::Mutex;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static CANCELED_REQUESTS: once_cell::sync::Lazy<Mutex<HashSet<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashSet::new()));
static PDF_BLOCK_CANCEL_FLAGS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static PDF_IMAGE_CANCEL_FLAGS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static WEBVIEW_TABS: once_cell::sync::Lazy<Mutex<HashMap<String, String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
const DEFAULT_NATIVE_WEBVIEW_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0";
const MAX_PROXY_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
const PDF_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const NATIVE_WEBVIEW_NAV_PATCH_SCRIPT: &str = r#"(function () {
  if ((window).__r0nixNavPatchInstalled) return;
  (window).__r0nixNavPatchInstalled = true;

  const toAbsolute = (raw) => {
    if (typeof raw !== "string") return "";
    const value = raw.trim();
    if (!value) return "";
    try {
      return new URL(value, window.location.href).toString();
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

  const originalOpen = window.open ? window.open.bind(window) : null;
  window.open = function (url, target, features) {
    if (navigateCurrent(String(url || ""))) {
      return window;
    }
    if (originalOpen) {
      try {
        return originalOpen(url, target, features);
      } catch {
        return window;
      }
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDownloadPayload {
    pub data_base64: String,
    pub final_url: String,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub status_code: u16,
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
    Url::parse(url).map_err(|err| format!("invalid webview url: {err}"))
}

fn ensure_non_empty_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn ensure_importable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "pdf" || ext == "md" || ext == "markdown"
        })
        .unwrap_or(false)
}

fn ensure_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "md" || ext == "markdown"
        })
        .unwrap_or(false)
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
    let allowed = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            matches!(
                ext.as_str(),
                "md" | "markdown" | "csv" | "json" | "svg" | "txt"
            )
        })
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err("text write only supports md, markdown, csv, json, svg, or txt files".to_string())
    }
}

fn ensure_allowed_binary_write_path(path: &Path) -> Result<(), String> {
    let allowed = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            matches!(
                ext.as_str(),
                "pdf"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "bmp"
                    | "tif"
                    | "tiff"
                    | "jp2"
                    | "jpx"
                    | "jbig2"
                    | "ccitt"
            )
        })
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err("binary write only supports pdf, png, jpg, or jpeg files".to_string())
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
    let mut path = app
        .path()
        .temp_dir()
        .map_err(|err| format!("temp directory unavailable: {err}"))?;
    path.push(file_name);
    if !ensure_importable_extension(&path) {
        return Err("temporary files only support pdf, md, or markdown files".to_string());
    }
    let bytes = decode_base64_bytes(&data_base64)?;
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
        let mut results = Vec::new();
        let mut visited_dirs = HashSet::new();
        let mut stack = vec![root];
        while let Some(current) = stack.pop() {
            let current = match current.canonicalize() {
                Ok(path) if visited_dirs.insert(path.clone()) => path,
                _ => continue,
            };
            let entries = match std::fs::read_dir(&current) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
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

async fn resolve_file_path(file_id: &str) -> Result<String, String> {
    let manager = PDF_MANAGER.lock().await;
    let info = manager
        .get_document_info(file_id)
        .map_err(|err| err.to_string())?;
    Ok(info.path)
}

async fn run_pdf_blocking<T, F>(label: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let task = tokio::task::spawn_blocking(task);
    match tokio::time::timeout(PDF_OPERATION_TIMEOUT, task).await {
        Ok(Ok(result)) => result.map_err(|err| format!("{label} failed: {err}")),
        Ok(Err(err)) => Err(format!("{label} task failed: {err}")),
        Err(_) => Err(format!(
            "{label} timed out after {} seconds",
            PDF_OPERATION_TIMEOUT.as_secs()
        )),
    }
}

#[tauri::command]
pub async fn open_pdf(file_id: String, path: String) -> Result<PdfInfo, String> {
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

#[tauri::command]
pub async fn close_pdf(file_id: String) -> Result<(), String> {
    let mut manager = PDF_MANAGER.lock().await;
    manager
        .close_document(&file_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_pdf_info(file_id: String) -> Result<PdfInfo, String> {
    let manager = PDF_MANAGER.lock().await;
    manager
        .get_document_info(&file_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_page_count(file_id: String) -> Result<usize, String> {
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

    let page_count_task = tokio::task::spawn_blocking(move || get_pdf_page_count(&path));
    let page_count = match tokio::time::timeout(Duration::from_secs(30), page_count_task).await {
        Ok(result) => result
            .map_err(|err| format!("page count task failed: {err}"))?
            .map_err(|err| format!("page count failed: {err}"))?,
        Err(_) => return Err("page count timed out after 30 seconds".to_string()),
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

#[tauri::command]
pub async fn read_opened_pdf_bytes(file_id: String) -> Result<Vec<u8>, String> {
    let path = resolve_file_path(&file_id).await?;
    tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|err| format!("read pdf bytes task failed: {err}"))?
        .map_err(|err| format!("failed to read pdf bytes: {err}"))
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
    eprintln!(
        "[request_tiles] file_id={} page={} zoom={:.2} viewport=({}, {}, {}, {})",
        file_id, page_no, zoom, viewport.x, viewport.y, viewport.width, viewport.height
    );
    let path = resolve_file_path(&file_id).await?;

    let tile_size = tile_size.unwrap_or(512).clamp(128, 1024);
    let safe_zoom = zoom.max(0.1);
    let render_zoom = render_scale.unwrap_or(safe_zoom).max(safe_zoom);
    let render_scale_factor = (render_zoom / safe_zoom).max(1.0);
    let request_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed));
    let tile_plan = plan_visible_tiles(&viewport, tile_size, 1);
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

        let request_id_for_blocking = request_id_for_task.clone();
        let file_id_for_blocking = file_id_for_task.clone();
        let render_result = tokio::task::spawn_blocking(move || {
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
    eprintln!("[cancel_tile_request] request_id={}", request_id);
    let mut canceled = CANCELED_REQUESTS.lock().await;
    canceled.insert(request_id);
    Ok(())
}

#[tauri::command]
pub async fn export_page_png(
    file_id: String,
    page_no: usize,
    zoom: Option<f32>,
) -> Result<String, String> {
    eprintln!(
        "[export_page_png] file_id={} page={} zoom={:?}",
        file_id, page_no, zoom
    );
    let path = resolve_file_path(&file_id).await?;
    let zoom = zoom.unwrap_or(2.0).max(0.1);

    let png = run_pdf_blocking("png export", move || render_page_png(&path, page_no, zoom)).await?;

    Ok(BASE64.encode(png))
}

#[tauri::command]
pub async fn extract_pdf_image(
    file_id: String,
    page_no: usize,
    xref: usize,
) -> Result<String, String> {
    eprintln!(
        "[extract_pdf_image] file_id={} page={} xref={}",
        file_id, page_no, xref
    );
    let path = resolve_file_path(&file_id).await?;
    run_pdf_blocking("pdf image extraction", move || {
        extract_pdf_image_json(&path, page_no, xref)
    })
    .await
}

#[tauri::command]
pub async fn export_page_svg(file_id: String, page_no: usize) -> Result<String, String> {
    eprintln!("[export_page_svg] file_id={} page={}", file_id, page_no);
    let path = resolve_file_path(&file_id).await?;

    run_pdf_blocking("svg export", move || render_page_svg(&path, page_no)).await
}

#[tauri::command]
pub async fn export_page_svg_crop(
    file_id: String,
    page_no: usize,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    eprintln!(
        "[export_page_svg_crop] file_id={} page={} left={} top={} width={} height={}",
        file_id, page_no, left, top, width, height
    );
    let path = resolve_file_path(&file_id).await?;

    run_pdf_blocking("svg crop export", move || {
        render_page_svg_crop(&path, page_no, left, top, width, height)
    })
    .await
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

    let cancel_flag_for_task = cancel_flag.clone();
    let task = tokio::task::spawn_blocking(move || {
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

    let cancel_flag_for_task = cancel_flag.clone();
    let task = tokio::task::spawn_blocking(move || {
        get_pdf_reading_blocks_json(&path, start_page, end_page, Some(cancel_flag_for_task))
    });
    let result = match tokio::time::timeout(Duration::from_secs(30), task).await {
        Ok(Ok(result)) => {
            result.map_err(|err| format!("get_pdf_reading_blocks task failed: {err}"))
        }
        Ok(Err(err)) => Err(format!("get_pdf_reading_blocks task failed: {err}")),
        Err(_) => {
            cancel_flag.store(true, Ordering::Release);
            Err("PDF reading block extraction timed out after 30 seconds".to_string())
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
    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(false);
    if let Some(proxy) = proxy_url {
        let trimmed = proxy.trim().to_string();
        if !trimmed.is_empty() {
            let req_proxy =
                reqwest::Proxy::all(&trimmed).map_err(|err| format!("invalid proxy url: {err}"))?;
            client_builder = client_builder.proxy(req_proxy);
        }
    }
    let client = client_builder
        .build()
        .map_err(|err| format!("failed to create proxy client: {err}"))?;
    let mut response = client
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
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROXY_DOWNLOAD_BYTES as u64)
    {
        return Err(format!(
            "download response exceeds {} MiB limit",
            MAX_PROXY_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("read response bytes failed: {err}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_PROXY_DOWNLOAD_BYTES {
            return Err(format!(
                "download response exceeds {} MiB limit",
                MAX_PROXY_DOWNLOAD_BYTES / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ProxyDownloadPayload {
        data_base64: BASE64.encode(&bytes),
        final_url,
        content_type,
        content_disposition,
        status_code,
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
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(Duration::from_millis(timeout_ms))
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|err| format!("failed to create model client: {err}"))?;

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

    let response = builder
        .body(payload)
        .send()
        .await
        .map_err(|err| format!("model service request failed: {err}"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = response
        .text()
        .await
        .map_err(|err| format!("failed to read model response: {err}"))?;
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
    {
        let mut tabs = WEBVIEW_TABS.lock().await;
        tabs.insert(tab_id.clone(), label.clone());
    }

    if let Some(webview) = app.get_webview(&label) {
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
    builder = builder.on_navigation(move |url| {
        let next = url.as_str();
        if is_pdf_url(next) {
            let payload = WebviewPdfLinkPayload {
                tab_id: nav_tab_id.clone(),
                url: next.to_string(),
            };
            let _ = nav_app.emit("r0nix://webview-pdf-link", payload);
            return false;
        }
        let payload = WebviewNavigatedPayload {
            tab_id: nav_tab_id.clone(),
            url: next.to_string(),
        };
        let _ = nav_app.emit("r0nix://webview-navigated", payload);
        true
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
    Ok(label)
}

#[tauri::command]
pub async fn navigate_webview_tab(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let parsed_url = parse_webview_url(&url)?;
    let label = {
        let tabs = WEBVIEW_TABS.lock().await;
        tabs.get(&tab_id)
            .cloned()
            .unwrap_or_else(|| native_webview_label(&tab_id))
    };

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
    let label = {
        let tabs = WEBVIEW_TABS.lock().await;
        tabs.get(&tab_id)
            .cloned()
            .unwrap_or_else(|| native_webview_label(&tab_id))
    };
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
    let label = {
        let tabs = WEBVIEW_TABS.lock().await;
        tabs.get(&tab_id)
            .cloned()
            .unwrap_or_else(|| native_webview_label(&tab_id))
    };
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
    let label = {
        let tabs = WEBVIEW_TABS.lock().await;
        tabs.get(&tab_id)
            .cloned()
            .unwrap_or_else(|| native_webview_label(&tab_id))
    };
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
    let label = {
        let tabs = WEBVIEW_TABS.lock().await;
        tabs.get(&tab_id)
            .cloned()
            .unwrap_or_else(|| native_webview_label(&tab_id))
    };
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
    let label = {
        let mut tabs = WEBVIEW_TABS.lock().await;
        tabs.remove(&tab_id)
            .unwrap_or_else(|| native_webview_label(&tab_id))
    };
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|err| format!("close native webview failed: {err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_allowed_binary_write_path, ensure_allowed_text_write_path,
        ensure_importable_extension, ensure_markdown_extension, is_pdf_url, normalize_download_url,
        sanitize_file_name,
    };
    use std::path::Path;

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

        assert!(ensure_allowed_text_write_path(Path::new("export.csv")).is_ok());
        assert!(ensure_allowed_text_write_path(Path::new("diagram.svg")).is_ok());
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
        assert!(
            vector_items.iter().all(|item| {
                let bbox = item["bbox"].as_array();
                bbox.and_then(|values| values.get(2))
                    .and_then(serde_json::Value::as_f64)
                    .zip(
                        bbox.and_then(|values| values.get(0))
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
            20.0,
            80.0,
            80.0,
        )
        .expect("export SVG crop");
        assert!(svg.contains("<svg"));
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
