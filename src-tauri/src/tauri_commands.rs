use crate::pdf_manager::PDF_MANAGER;
use crate::py_render::{
    get_page_count as get_pdf_page_count, get_page_images_json, render_page_png, render_page_svg,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::png::PngEncoder;
use image::{imageops, ColorType, ImageEncoder, RgbaImage};
use pdf_core::{plan_visible_tiles, PdfInfo, TileReadyPayload, TileRequestAck, TileViewport};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, Url, WebviewUrl,
    WebviewWindowBuilder,
};
use tokio::sync::Mutex;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static CANCELED_REQUESTS: once_cell::sync::Lazy<Mutex<HashSet<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashSet::new()));
static WEBVIEW_TABS: once_cell::sync::Lazy<Mutex<HashMap<String, String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
const DEFAULT_NATIVE_WEBVIEW_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0";

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

fn is_pdf_url(url: &str) -> bool {
    let lowered_raw = url.to_ascii_lowercase();
    if lowered_raw.contains(".pdf")
        || lowered_raw.contains("%2epdf")
        || lowered_raw.contains("%2fpdf")
    {
        return true;
    }

    if let Ok(parsed) = Url::parse(url) {
        let path = parsed.path().to_ascii_lowercase();
        if path.ends_with(".pdf") {
            return true;
        }
        if path.contains("/pdf/") || path.contains("/pdfs/") || path.ends_with("/pdf") {
            return true;
        }
        if path.contains("/download") && path.contains("pdf") {
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
            .query()
            .map(|value| {
                let query = value.to_ascii_lowercase();
                query.contains(".pdf")
                    || query.contains("application/pdf")
                    || query.contains("format=pdf")
                    || query.contains("type=pdf")
                    || query.contains("mime=pdf")
                    || query.contains("output=pdf")
            })
            .unwrap_or(false)
        {
            return true;
        }
        if parsed
            .fragment()
            .map(|value| {
                let fragment = value.to_ascii_lowercase();
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
    lowered_raw.contains(".pdf")
        || lowered_raw.contains("%2epdf")
        || lowered_raw.contains("/pdf/")
        || lowered_raw.contains("/pdfs/")
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

#[tauri::command]
pub async fn open_pdf(file_id: String, path: String) -> Result<PdfInfo, String> {
    eprintln!("[open_pdf] file_id={} path={}", file_id, path);
    let mut manager = PDF_MANAGER.lock().await;
    let mut info = manager
        .open_document(file_id, &path)
        .map_err(|err| err.to_string())?;
    drop(manager);

    let page_count_task_path = path.clone();
    let page_count_task = tokio::task::spawn_blocking(move || get_pdf_page_count(&page_count_task_path));

    match tokio::time::timeout(Duration::from_secs(8), page_count_task).await {
        Ok(Ok(Ok(page_count))) => {
            let mut manager = PDF_MANAGER.lock().await;
            if let Err(err) = manager.set_page_count(&info.file_id, page_count) {
                eprintln!("[open_pdf] set page count failed: {}", err);
            } else {
                info.page_count = page_count;
                eprintln!(
                    "[open_pdf] success file_id={} page_count={}",
                    info.file_id, info.page_count
                );
            }
        }
        Ok(Ok(Err(err))) => {
            eprintln!("[open_pdf] page count failed: {}", err);
        }
        Ok(Err(err)) => {
            eprintln!("[open_pdf] page count task failed: {}", err);
        }
        Err(_) => {
            eprintln!("[open_pdf] page count timed out, fallback to lazy loading");
        }
    }

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
    let manager = PDF_MANAGER.lock().await;
    manager
        .get_document_info(&file_id)
        .map(|info| info.page_count)
        .map_err(|err| err.to_string())
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

    let png = tokio::task::spawn_blocking(move || render_page_png(&path, page_no, zoom))
        .await
        .map_err(|err| format!("png export task failed: {err}"))??;

    Ok(BASE64.encode(png))
}

#[tauri::command]
pub async fn export_page_svg(file_id: String, page_no: usize) -> Result<String, String> {
    eprintln!("[export_page_svg] file_id={} page={}", file_id, page_no);
    let path = resolve_file_path(&file_id).await?;

    tokio::task::spawn_blocking(move || render_page_svg(&path, page_no))
        .await
        .map_err(|err| format!("svg export task failed: {err}"))?
}

#[tauri::command]
pub async fn get_page_images(file_id: String, page_no: usize) -> Result<String, String> {
    eprintln!("[get_page_images] file_id={} page={}", file_id, page_no);
    let path = resolve_file_path(&file_id).await?;

    tokio::task::spawn_blocking(move || get_page_images_json(&path, page_no))
        .await
        .map_err(|err| format!("get_page_images task failed: {err}"))?
}

#[tauri::command]
pub async fn download_pdf_via_proxy(
    url: String,
    proxy_url: Option<String>,
) -> Result<ProxyDownloadPayload, String> {
    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .danger_accept_invalid_certs(false);
    if let Some(proxy) = proxy_url {
        let trimmed = proxy.trim().to_string();
        if !trimmed.is_empty() {
            let req_proxy = reqwest::Proxy::all(&trimmed)
                .map_err(|err| format!("invalid proxy url: {err}"))?;
            client_builder = client_builder.proxy(req_proxy);
        }
    }
    let client = client_builder
        .build()
        .map_err(|err| format!("failed to create proxy client: {err}"))?;
    let response = client
        .get(url)
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
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("read response bytes failed: {err}"))?;
    Ok(ProxyDownloadPayload {
        data_base64: BASE64.encode(bytes),
        final_url,
        content_type,
        content_disposition,
        status_code,
    })
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
    {
        let mut tabs = WEBVIEW_TABS.lock().await;
        tabs.insert(tab_id.clone(), label.clone());
    }

    if let Some(window) = app.get_webview_window(&label) {
        window
            .navigate(parsed_url)
            .map_err(|err| format!("navigate existing webview failed: {err}"))?;
        window
            .show()
            .map_err(|err| format!("show existing webview failed: {err}"))?;
        if focus.unwrap_or(false) {
            window
                .set_focus()
                .map_err(|err| format!("focus existing webview failed: {err}"))?;
        }
        if let Some(window_title) = title {
            let _ = window.set_title(&window_title);
        }
        return Ok(label);
    }

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .visible(true)
        .focused(focus.unwrap_or(false))
        .resizable(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(false)
        .skip_taskbar(true)
        .user_agent(DEFAULT_NATIVE_WEBVIEW_UA)
        .title(title.as_deref().unwrap_or("Web Tab"));
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
    if let Some(main) = app.get_webview_window("main") {
        if let Ok(size) = main.inner_size() {
            let width = (size.width as f64 * 0.82).max(920.0);
            let height = (size.height as f64 * 0.84).max(680.0);
            builder = builder.inner_size(width, height);
        }
    }

    builder
        .build()
        .map_err(|err| format!("build native webview failed: {err}"))?;
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

    if let Some(window) = app.get_webview_window(&label) {
        window
            .navigate(parsed_url)
            .map_err(|err| format!("navigate native webview failed: {err}"))?;
    }
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
    if let Some(window) = app.get_webview_window(&label) {
        window
            .show()
            .map_err(|err| format!("show native webview failed: {err}"))?;
        if focus.unwrap_or(false) {
            window
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
    if let Some(window) = app.get_webview_window(&label) {
        window
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
    if let Some(window) = app.get_webview_window(&label) {
        let safe_width = width.max(360.0);
        let safe_height = height.max(240.0);
        window
            .set_size(Size::Logical(LogicalSize::new(safe_width, safe_height)))
            .map_err(|err| format!("sync native webview size failed: {err}"))?;
        window
            .set_position(Position::Logical(LogicalPosition::new(x, y)))
            .map_err(|err| format!("sync native webview position failed: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_webview_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = {
        let mut tabs = WEBVIEW_TABS.lock().await;
        tabs.remove(&tab_id)
            .unwrap_or_else(|| native_webview_label(&tab_id))
    };
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|err| format!("close native webview failed: {err}"))?;
    }
    Ok(())
}
