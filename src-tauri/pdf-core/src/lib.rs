use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

const MAX_PLANNED_TILES: usize = 4096;
const MAX_VIEWPORT_EXTENT: f32 = 1_048_576.0;

#[derive(Debug, Error, Clone)]
pub enum CoreError {
    #[error("document not found: {0}")]
    DocumentNotFound(String),
    #[error("failed to open document: {0}")]
    OpenFailed(String),
    #[error("document is already open: {0}")]
    DocumentAlreadyOpen(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfInfo {
    pub file_id: String,
    pub path: String,
    pub page_count: usize,
    pub title: Option<String>,
    pub author: Option<String>,
    pub file_size: u64,
}

#[derive(Default)]
pub struct PdfCore {
    documents: HashMap<String, PdfInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileViewport {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileReadyPayload {
    pub request_id: String,
    pub file_id: String,
    pub page_no: usize,
    pub zoom: f32,
    pub tile_id: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub status: String,
    pub png_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileRequestAck {
    pub request_id: String,
    pub total_tiles: usize,
}

impl PdfCore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_document(&mut self, file_id: String, path: &str) -> Result<PdfInfo, CoreError> {
        if file_id.trim().is_empty() {
            return Err(CoreError::OpenFailed("file id is empty".to_string()));
        }
        if self.documents.contains_key(&file_id) {
            return Err(CoreError::DocumentAlreadyOpen(file_id));
        }
        let file_size = std::fs::metadata(path)
            .map(|m| m.len())
            .map_err(|err| CoreError::OpenFailed(format!("cannot read file metadata: {err}")))?;

        let info = PdfInfo {
            file_id: file_id.clone(),
            path: path.to_string(),
            page_count: 0,
            title: None,
            author: None,
            file_size,
        };

        self.documents.insert(file_id, info.clone());
        Ok(info)
    }

    pub fn close_document(&mut self, file_id: &str) -> Result<(), CoreError> {
        self.documents
            .remove(file_id)
            .ok_or_else(|| CoreError::DocumentNotFound(file_id.to_string()))?;
        Ok(())
    }

    pub fn get_document_info(&self, file_id: &str) -> Result<PdfInfo, CoreError> {
        self.documents
            .get(file_id)
            .cloned()
            .ok_or_else(|| CoreError::DocumentNotFound(file_id.to_string()))
    }

    pub fn set_page_count(&mut self, file_id: &str, page_count: usize) -> Result<(), CoreError> {
        let info = self
            .documents
            .get_mut(file_id)
            .ok_or_else(|| CoreError::DocumentNotFound(file_id.to_string()))?;
        info.page_count = page_count;
        Ok(())
    }

    pub fn list_documents(&self) -> Vec<String> {
        self.documents.keys().cloned().collect()
    }
}

pub fn plan_visible_tiles(
    viewport: &TileViewport,
    tile_size: u32,
    overscan_tiles: u32,
) -> Vec<(u32, u32, u32, u32)> {
    if !viewport.x.is_finite()
        || !viewport.y.is_finite()
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width <= 0.0
        || viewport.height <= 0.0
        || viewport.x.abs() > MAX_VIEWPORT_EXTENT
        || viewport.y.abs() > MAX_VIEWPORT_EXTENT
        || viewport.width > MAX_VIEWPORT_EXTENT
        || viewport.height > MAX_VIEWPORT_EXTENT
        || tile_size == 0
    {
        return Vec::new();
    }

    let tile = tile_size as f32;
    let overscan = overscan_tiles as f32 * tile;

    let start_x = ((viewport.x - overscan).max(0.0) / tile).floor() as u32 * tile_size;
    let start_y = ((viewport.y - overscan).max(0.0) / tile).floor() as u32 * tile_size;
    let end_x = (((viewport.x + viewport.width + overscan) / tile).ceil() as u32).max(1) * tile_size;
    let end_y = (((viewport.y + viewport.height + overscan) / tile).ceil() as u32).max(1) * tile_size;

    let planned_x = end_x.saturating_sub(start_x).div_ceil(tile_size) as usize;
    let planned_y = end_y.saturating_sub(start_y).div_ceil(tile_size) as usize;
    if planned_x.saturating_mul(planned_y) > MAX_PLANNED_TILES {
        return Vec::new();
    }

    let mut tiles = Vec::new();
    let mut y = start_y;
    while y < end_y {
        let mut x = start_x;
        while x < end_x {
            tiles.push((x, y, tile_size, tile_size));
            x = x.saturating_add(tile_size);
        }
        y = y.saturating_add(tile_size);
    }
    tiles
}

#[cfg(test)]
mod tests {
    use super::{CoreError, PdfCore};

    #[test]
    fn creates_empty_core() {
        let core = PdfCore::new();
        assert!(core.list_documents().is_empty());
    }

    #[test]
    fn rejects_empty_and_duplicate_file_ids() {
        let path = std::env::temp_dir().join(format!("r0nix-pdf-core-{}.pdf", std::process::id()));
        std::fs::write(&path, b"fixture").expect("write fixture");
        let mut core = PdfCore::new();

        assert!(matches!(
            core.open_document(String::new(), path.to_str().unwrap()),
            Err(CoreError::OpenFailed(_))
        ));
        core.open_document("file-1".to_string(), path.to_str().unwrap())
            .expect("first open should succeed");
        assert!(matches!(
            core.open_document("file-1".to_string(), path.to_str().unwrap()),
            Err(CoreError::DocumentAlreadyOpen(id)) if id == "file-1"
        ));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn rejects_non_finite_and_unbounded_tile_viewports() {
        use super::{plan_visible_tiles, TileViewport};

        assert!(plan_visible_tiles(
            &TileViewport { x: 0.0, y: 0.0, width: f32::NAN, height: 100.0 },
            512,
            1,
        ).is_empty());
        assert!(plan_visible_tiles(
            &TileViewport { x: 0.0, y: 0.0, width: 100_000.0, height: 100_000.0 },
            512,
            1,
        ).is_empty());
    }
}
