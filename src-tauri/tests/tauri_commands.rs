use once_cell::sync::Lazy;
use r0nix::tauri_commands::{
    close_pdf_document, export_page_png, export_page_svg, get_page_count, get_pdf_info, list_pdfs,
    open_pdf,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

static TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn build_test_pdf_bytes(page_count: usize) -> Vec<u8> {
    let mut objects: Vec<String> = Vec::new();
    objects.push(String::new());

    objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string());

    let kids = (0..page_count)
        .map(|idx| format!("{} 0 R", 3 + idx))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(format!(
        "2 0 obj\n<< /Type /Pages /Kids [{}] /Count {} >>\nendobj\n",
        kids, page_count
    ));

    let font_id = 3 + page_count * 2;
    for idx in 0..page_count {
        let page_id = 3 + idx;
        let contents_id = 3 + page_count + idx;
        objects.push(format!(
            "{page_id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents {contents_id} 0 R /Resources << /Font << /F1 {font_id} 0 R >> >> >>\nendobj\n"
        ));
    }

    for idx in 0..page_count {
        let contents_id = 3 + page_count + idx;
        let text = format!("BT /F1 12 Tf 72 72 Td (Page {}) Tj ET\n", idx + 1);
        let length = text.len();
        objects.push(format!(
            "{contents_id} 0 obj\n<< /Length {} >>\nstream\n{}endstream\nendobj\n",
            length, text
        ));
    }

    objects.push(format!(
        "{font_id} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
    ));

    let mut output = String::new();
    output.push_str("%PDF-1.4\n");

    let mut offsets = vec![0usize; objects.len()];
    for (id, object) in objects.iter().enumerate().skip(1) {
        offsets[id] = output.len();
        output.push_str(object);
    }

    let xref_start = output.len();
    output.push_str("xref\n");
    output.push_str(&format!("0 {}\n", objects.len()));
    output.push_str("0000000000 65535 f \n");
    for (_, offset) in offsets.iter().enumerate().skip(1) {
        output.push_str(&format!("{:010} 00000 n \n", offset));
    }
    output.push_str("trailer\n");
    output.push_str(&format!("<< /Size {} /Root 1 0 R >>\n", objects.len()));
    output.push_str("startxref\n");
    output.push_str(&format!("{}\n", xref_start));
    output.push_str("%%EOF\n");

    output.into_bytes()
}

fn write_test_pdf(page_count: usize) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    path.push(format!("tauri_pdf_test_{}_{}.pdf", page_count, stamp));
    std::fs::write(&path, build_test_pdf_bytes(page_count)).unwrap();
    path
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a matching embedded Python/PyMuPDF runtime"]
async fn test_tauri_commands_open_info_and_list() {
    let _guard = TEST_LOCK.lock().await;
    let path = write_test_pdf(2);
    let path_str = path.to_string_lossy().to_string();
    let file_id = "tauri-doc-1".to_string();

    open_pdf(file_id.clone(), path_str).await.unwrap();

    let info = get_pdf_info(file_id.clone()).await.unwrap();
    assert_eq!(info.file_id, file_id);
    assert_eq!(info.path, path.to_string_lossy());

    let count = get_page_count(file_id.clone(), None).await.unwrap();
    let resolved_info = get_pdf_info(file_id.clone()).await.unwrap();
    assert_eq!(count, resolved_info.page_count);

    let listed = list_pdfs().await.unwrap();
    assert!(listed.contains(&file_id));

    close_pdf_document(file_id).await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a matching embedded Python/PyMuPDF runtime"]
async fn test_tauri_commands_export_png_and_svg() {
    let _guard = TEST_LOCK.lock().await;
    let path = write_test_pdf(2);
    let path_str = path.to_string_lossy().to_string();
    let file_id = "tauri-doc-render".to_string();

    open_pdf(file_id.clone(), path_str).await.unwrap();

    let png_base64 = export_page_png(file_id.clone(), 1, Some(1.0), None)
        .await
        .unwrap();
    assert!(!png_base64.is_empty());

    let svg = export_page_svg(file_id.clone(), 1, None).await.unwrap();
    assert!(svg.contains("<svg"));

    close_pdf_document(file_id).await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a matching embedded Python/PyMuPDF runtime"]
async fn test_tauri_commands_invalid_page() {
    let _guard = TEST_LOCK.lock().await;
    let path = write_test_pdf(1);
    let path_str = path.to_string_lossy().to_string();
    let file_id = "tauri-doc-2".to_string();

    open_pdf(file_id.clone(), path_str).await.unwrap();

    let err = export_page_png(file_id.clone(), 5, Some(1.0), None)
        .await
        .unwrap_err();
    assert!(err.contains("out of range"));

    close_pdf_document(file_id).await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_tauri_commands_missing_document() {
    let _guard = TEST_LOCK.lock().await;
    let err = export_page_png("missing-doc".to_string(), 1, Some(1.0), None)
        .await
        .unwrap_err();
    assert!(err.contains("document not found"));
}
