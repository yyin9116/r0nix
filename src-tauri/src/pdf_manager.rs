use once_cell::sync::Lazy;
use pdf_core::{CoreError, PdfCore, PdfInfo};
use tokio::sync::Mutex;

pub static PDF_MANAGER: Lazy<Mutex<PdfManager>> = Lazy::new(|| Mutex::new(PdfManager::new()));

pub struct PdfManager {
    core: PdfCore,
}

impl PdfManager {
    pub fn new() -> Self {
        Self {
            core: PdfCore::new(),
        }
    }

    pub fn open_document(&mut self, file_id: String, path: &str) -> Result<PdfInfo, CoreError> {
        self.core.open_document(file_id, path)
    }

    pub fn close_document(&mut self, file_id: &str) -> Result<(), CoreError> {
        self.core.close_document(file_id)
    }

    pub fn get_document_info(&self, file_id: &str) -> Result<PdfInfo, CoreError> {
        self.core.get_document_info(file_id)
    }

    pub fn set_page_count(&mut self, file_id: &str, page_count: usize) -> Result<(), CoreError> {
        self.core.set_page_count(file_id, page_count)
    }

    pub fn list_documents(&self) -> Vec<String> {
        self.core.list_documents()
    }
}

#[cfg(test)]
mod tests {
    use super::PdfManager;

    #[test]
    fn manager_starts_empty() {
        let manager = PdfManager::new();
        assert!(manager.list_documents().is_empty());
    }
}
