use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error, Clone)]
pub enum CoreError {
    #[error("document not found: {0}")]
    DocumentNotFound(String),
    #[error("failed to open document: {0}")]
    OpenFailed(String),
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
        let file_size = std::fs::metadata(path)
            .map(|m| m.len())
            .map_err(|err| CoreError::OpenFailed(format!("cannot read file metadata: {err}")))?;

        // Placeholder until the renderer pipeline is moved into Rust core.
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
    if viewport.width <= 0.0 || viewport.height <= 0.0 || tile_size == 0 {
        return Vec::new();
    }

    let tile = tile_size as f32;
    let overscan = overscan_tiles as f32 * tile;

    let start_x = ((viewport.x - overscan).max(0.0) / tile).floor() as u32 * tile_size;
    let start_y = ((viewport.y - overscan).max(0.0) / tile).floor() as u32 * tile_size;
    let end_x = (((viewport.x + viewport.width + overscan) / tile).ceil() as u32).max(1) * tile_size;
    let end_y = (((viewport.y + viewport.height + overscan) / tile).ceil() as u32).max(1) * tile_size;

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
    use super::PdfCore;

    #[test]
    fn creates_empty_core() {
        let core = PdfCore::new();
        assert!(core.list_documents().is_empty());
    }
}
