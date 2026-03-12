use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::env;
use std::path::PathBuf;
use std::sync::Once;

static PYTHON_RUNTIME_ONCE: Once = Once::new();

fn runtime_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("resources").join("runtime"));
            candidates.push(exe_dir.join("runtime"));
            candidates.push(exe_dir.to_path_buf());
        }
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("runtime"));
        candidates.push(cwd.join("runtime"));
    }

    candidates
}

fn pick_runtime_home() -> Option<PathBuf> {
    runtime_candidates().into_iter().find(|candidate| {
        candidate.join("python311.zip").exists()
            || candidate.join("Lib").join("encodings").exists()
            || candidate.join("site-packages").join("fitz").exists()
    })
}

fn ensure_python_runtime() {
    PYTHON_RUNTIME_ONCE.call_once(|| {
        if let Some(runtime_home) = pick_runtime_home() {
            let runtime_str = runtime_home.to_string_lossy().into_owned();
            let stdlib_zip = runtime_home.join("python311.zip");
            let site_packages = runtime_home.join("site-packages");
            let lib_site_packages = runtime_home.join("Lib").join("site-packages");

            let mut python_paths = Vec::new();
            if stdlib_zip.exists() {
                python_paths.push(stdlib_zip.to_string_lossy().into_owned());
            }
            python_paths.push(runtime_str.clone());
            if site_packages.exists() {
                python_paths.push(site_packages.to_string_lossy().into_owned());
            }
            if lib_site_packages.exists() {
                python_paths.push(lib_site_packages.to_string_lossy().into_owned());
            }

            env::set_var("PYTHONHOME", &runtime_str);
            env::set_var("PYTHONPATH", python_paths.join(";"));
        }

        pyo3::prepare_freethreaded_python();
    });
}

pub fn get_page_count(path: &str) -> Result<usize, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<usize> {
        let fitz = py.import_bound("fitz")?;
        let doc = fitz.call_method1("open", (path_owned.as_str(),))?;
        doc.getattr("page_count")?.extract()
    })
    .map_err(|err| format!("pymupdf page count failed: {err}"))
}

pub fn render_page_png(path: &str, page_no: usize, zoom: f32) -> Result<Vec<u8>, String> {
    ensure_python_runtime();
    let safe_zoom = zoom.max(0.1);
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<Vec<u8>> {
        let fitz = py.import_bound("fitz")?;
        let doc = fitz.call_method1("open", (path_owned.as_str(),))?;
        let page_count: usize = doc.getattr("page_count")?.extract()?;

        if page_no == 0 || page_no > page_count {
            return Err(pyo3::exceptions::PyValueError::new_err(format!(
                "page {page_no} out of range (1..={page_count})"
            )));
        }

        let page = doc.call_method1("load_page", ((page_no - 1) as i32,))?;
        let matrix = fitz
            .getattr("Matrix")?
            .call1((safe_zoom as f64, safe_zoom as f64))?;

        let kwargs = PyDict::new_bound(py);
        kwargs.set_item("matrix", matrix)?;
        kwargs.set_item("alpha", false)?;

        let pixmap = page.call_method("get_pixmap", (), Some(&kwargs))?;
        pixmap.call_method1("tobytes", ("png",))?.extract()
    })
    .map_err(|err| format!("pymupdf render failed: {err}"))
}

pub fn render_page_svg(path: &str, page_no: usize) -> Result<String, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<String> {
        let fitz = py.import_bound("fitz")?;
        let doc = fitz.call_method1("open", (path_owned.as_str(),))?;
        let page_count: usize = doc.getattr("page_count")?.extract()?;

        if page_no == 0 || page_no > page_count {
            return Err(pyo3::exceptions::PyValueError::new_err(format!(
                "page {page_no} out of range (1..={page_count})"
            )));
        }

        let page = doc.call_method1("load_page", ((page_no - 1) as i32,))?;
        page.call_method0("get_svg_image")?.extract()
    })
    .map_err(|err| format!("pymupdf svg export failed: {err}"))
}


pub fn get_page_images_json(path: &str, page_no: usize) -> Result<String, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<String> {
        let locals = PyDict::new_bound(py);
        locals.set_item("path", path_owned.as_str())?;
        locals.set_item("page_no", page_no as i32)?;

        py.run_bound(
            r#"
import fitz
import json

doc = fitz.open(path)
try:
    total = int(doc.page_count)
    if page_no <= 0 or page_no > total:
        raise ValueError(f"page {page_no} out of range (1..={total})")

    page = doc.load_page(page_no - 1)
    page_w = float(page.rect.width or 1.0)
    page_h = float(page.rect.height or 1.0)

    items = []
    for image in page.get_images(full=True):
        xref = int(image[0])
        width = int(image[2]) if len(image) > 2 else 0
        height = int(image[3]) if len(image) > 3 else 0

        ext = ""
        try:
            ext = str(doc.extract_image(xref).get("ext", ""))
        except Exception:
            ext = ""

        rects = []
        try:
            rects = page.get_image_rects(xref)
        except Exception:
            rects = []

        if not rects:
            continue

        for rect in rects:
            x0 = max(0.0, min(1.0, float(rect.x0) / page_w))
            y0 = max(0.0, min(1.0, float(rect.y0) / page_h))
            x1 = max(0.0, min(1.0, float(rect.x1) / page_w))
            y1 = max(0.0, min(1.0, float(rect.y1) / page_h))
            left = min(x0, x1)
            right = max(x0, x1)
            top = min(y0, y1)
            bottom = max(y0, y1)
            items.append({
                "xref": xref,
                "pageNumber": int(page_no),
                "width": width,
                "height": height,
                "extension": ext,
                "bbox": [left, top, right, bottom],
            })

    result = json.dumps(items)
finally:
    doc.close()
"#,
            None,
            Some(&locals),
        )?;

        let result_obj = locals
            .get_item("result")?
            .ok_or_else(|| pyo3::exceptions::PyRuntimeError::new_err("missing result from python"))?;
        result_obj.extract()
    })
    .map_err(|err| format!("pymupdf list images failed: {err}"))
}
