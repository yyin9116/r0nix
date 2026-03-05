use once_cell::sync::Lazy;
use r0nix::tauri_commands::{
    clear_caches, close_pdf, export_page_svg, export_svg_crop, get_page_count, get_pdf_info,
    list_pdfs, open_pdf, render_pdf_page,
};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
        let length = text.as_bytes().len();
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
    for id in 1..objects.len() {
        offsets[id] = output.as_bytes().len();
        output.push_str(&objects[id]);
    }

    let xref_start = output.as_bytes().len();
    output.push_str("xref\n");
    output.push_str(&format!("0 {}\n", objects.len()));
    output.push_str("0000000000 65535 f \n");
    for id in 1..objects.len() {
        output.push_str(&format!("{:010} 00000 n \n", offsets[id]));
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
async fn test_tauri_commands_render_and_get_page_count() {
    let _guard = TEST_LOCK.lock().unwrap();
    let path = write_test_pdf(2);
    let path_str = path.to_string_lossy().to_string();
    let file_id = "tauri-doc-1".to_string();

    open_pdf(file_id.clone(), path_str).await.unwrap();

    let info = get_pdf_info(file_id.clone()).await.unwrap();
    assert_eq!(info.file_id, file_id);
    assert_eq!(info.page_count, 2);

    let count = get_page_count(file_id.clone()).await.unwrap();
    assert_eq!(count, 2);

    let listed = list_pdfs().await.unwrap();
    assert!(listed.contains(&file_id));

    let rendered = render_pdf_page(file_id.clone(), 0, 1.0).await.unwrap();
    assert!(!rendered.image_base64.is_empty());
    assert!(rendered.width > 0);
    assert!(rendered.height > 0);

    let svg = export_page_svg(file_id.clone(), 0, false).await.unwrap();
    assert!(!svg.svg_content.is_empty());
    assert!(svg.width > 0.0);
    assert!(svg.height > 0.0);

    let cropped = export_svg_crop(file_id.clone(), 0, 0.0, 0.0, 120.0, 80.0, false)
        .await
        .unwrap();
    assert!(!cropped.svg_content.is_empty());
    assert_eq!(cropped.width, 120.0);
    assert_eq!(cropped.height, 80.0);

    clear_caches().await.unwrap();

    close_pdf(file_id).await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_tauri_commands_invalid_page() {
    let _guard = TEST_LOCK.lock().unwrap();
    let path = write_test_pdf(1);
    let path_str = path.to_string_lossy().to_string();
    let file_id = "tauri-doc-2".to_string();

    open_pdf(file_id.clone(), path_str).await.unwrap();

    let err = render_pdf_page(file_id.clone(), 5, 1.0).await.unwrap_err();
    assert!(err.contains("Invalid page number"));

    close_pdf(file_id).await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_tauri_commands_missing_document() {
    let _guard = TEST_LOCK.lock().unwrap();
    let err = render_pdf_page("missing-doc".to_string(), 0, 1.0)
        .await
        .unwrap_err();
    assert!(err.contains("Document not found"));
}
