use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::env;
use std::ffi::CStr;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Once,
};

static PYTHON_RUNTIME_ONCE: Once = Once::new();

#[pyclass]
pub struct CancellationProbe {
    flag: Arc<AtomicBool>,
}

#[pymethods]
impl CancellationProbe {
    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
}

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
        candidate_has_matching_stdlib(candidate) || candidate.join("Lib").join("encodings").exists()
    })
}

fn linked_python_tag() -> Option<String> {
    unsafe {
        let raw = pyo3::ffi::Py_GetVersion();
        if raw.is_null() {
            return None;
        }
        let version = CStr::from_ptr(raw).to_string_lossy();
        let mut parts = version.split_whitespace().next()?.split('.');
        let major = parts.next()?;
        let minor = parts.next()?;
        Some(format!("python{major}{minor}"))
    }
}

fn candidate_has_matching_stdlib(candidate: &std::path::Path) -> bool {
    let Some(tag) = linked_python_tag() else {
        return false;
    };
    candidate.join(format!("{tag}.zip")).exists()
        || candidate
            .join("lib")
            .join(format!("python{}.{}", &tag[6..7], &tag[7..]))
            .join("encodings")
            .exists()
}

fn ensure_python_runtime() {
    PYTHON_RUNTIME_ONCE.call_once(|| {
        // The bundled runtime is read-only at application runtime. Prevent
        // Python bytecode caches from changing Tauri's watched resource tree.
        env::set_var("PYTHONDONTWRITEBYTECODE", "1");
        if let Some(runtime_home) = pick_runtime_home() {
            let runtime_str = runtime_home.to_string_lossy().into_owned();
            let site_packages = runtime_home.join("site-packages");
            let lib_site_packages = runtime_home.join("Lib").join("site-packages");
            let linked_tag = linked_python_tag();

            let mut python_paths = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&runtime_home) {
                let mut stdlib_zips = entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .map(|name| {
                                name.ends_with(".zip")
                                    && linked_tag
                                        .as_deref()
                                        .map(|tag| name == format!("{tag}.zip"))
                                        .unwrap_or(false)
                            })
                            .unwrap_or(false)
                    })
                    .collect::<Vec<_>>();
                stdlib_zips.sort();
                for stdlib_zip in stdlib_zips {
                    python_paths.push(stdlib_zip.to_string_lossy().into_owned());
                }
            }
            python_paths.push(runtime_str.clone());
            let dynload_dir = if cfg!(windows) {
                Some(runtime_home.join("DLLs"))
            } else {
                linked_tag.as_deref().and_then(|tag| {
                    tag.strip_prefix("python").map(|version| {
                        runtime_home
                            .join("lib")
                            .join(format!("python{version}"))
                            .join("lib-dynload")
                    })
                })
            };
            if let Some(dynload_dir) = dynload_dir.filter(|path| path.exists()) {
                python_paths.push(dynload_dir.to_string_lossy().into_owned());
            }
            if site_packages.exists() {
                python_paths.push(site_packages.to_string_lossy().into_owned());
            }
            if lib_site_packages.exists() {
                python_paths.push(lib_site_packages.to_string_lossy().into_owned());
            }

            if candidate_has_matching_stdlib(&runtime_home) {
                env::set_var("PYTHONHOME", &runtime_str);
            }
            let separator = if cfg!(windows) { ";" } else { ":" };
            env::set_var("PYTHONPATH", python_paths.join(separator));
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

pub fn render_page_svg_crop(
    path: &str,
    page_no: usize,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
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
        let rect = page.getattr("rect")?;
        let page_w: f64 = rect.getattr("width")?.extract()?;
        let page_h: f64 = rect.getattr("height")?.extract()?;
        let x0 = left.max(0.0).min(page_w);
        let y0 = top.max(0.0).min(page_h);
        let x1 = (left + width).max(0.0).min(page_w);
        let y1 = (top + height).max(0.0).min(page_h);
        if x1 <= x0 || y1 <= y0 {
            return Err(pyo3::exceptions::PyValueError::new_err(
                "crop rect is empty",
            ));
        }
        let locals = PyDict::new_bound(py);
        locals.set_item("page", page)?;
        locals.set_item("x0", x0)?;
        locals.set_item("y0", y0)?;
        locals.set_item("crop_width", x1 - x0)?;
        locals.set_item("crop_height", y1 - y0)?;
        py.run_bound(
            r#"
import re

svg = page.get_svg_image()
svg = re.sub(r'viewBox="[^"]*"', f'viewBox="{x0:g} {y0:g} {crop_width:g} {crop_height:g}"', svg, count=1)
svg = re.sub(r'width="[^"]*"', f'width="{crop_width:g}pt"', svg, count=1)
svg = re.sub(r'height="[^"]*"', f'height="{crop_height:g}pt"', svg, count=1)
result = svg
"#,
            Some(&locals),
            Some(&locals),
        )?;
        locals
            .get_item("result")?
            .ok_or_else(|| pyo3::exceptions::PyRuntimeError::new_err("missing cropped SVG result"))?
            .extract()
    })
    .map_err(|err| format!("pymupdf svg crop export failed: {err}"))
}

pub fn get_page_images_json(
    path: &str,
    page_no: usize,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<String, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<String> {
        let locals = PyDict::new_bound(py);
        locals.set_item("path", path_owned.as_str())?;
        locals.set_item("page_no", page_no as i32)?;
        if let Some(flag) = cancel_flag {
            locals.set_item("cancel_probe", Py::new(py, CancellationProbe { flag })?)?;
        } else {
            locals.set_item("cancel_probe", py.None())?;
        }

        py.run_bound(
            r#"
import fitz
import json

def check_cancelled():
    if cancel_probe is not None and cancel_probe.is_cancelled():
        raise RuntimeError("r0nix-cancelled")

doc = fitz.open(path)
try:
    total = int(doc.page_count)
    if page_no <= 0 or page_no > total:
        raise ValueError(f"page {page_no} out of range (1..={total})")

    page = doc.load_page(page_no - 1)
    page_rect = page.rect
    page_area = max(1.0, float(page_rect.width) * float(page_rect.height))
    items = []

    def valid_box(left, top, right, bottom, vector=False):
        box_w = max(0.0, right - left)
        box_h = max(0.0, bottom - top)
        area_ratio = (box_w * box_h) / page_area
        aspect = max(box_w / max(1.0, box_h), box_h / max(1.0, box_w))
        if vector:
            return box_w >= 14 and box_h >= 14 and 0.0018 <= area_ratio <= 0.45 and aspect <= 18
        # Raster resources are often banners, strips, or tiled PDF assets.
        # A strict aspect/area cutoff silently drops legitimate figures and
        # logos before the user can inspect or export them.
        return box_w >= 6 and box_h >= 6 and area_ratio >= 0.00005 and aspect <= 64

    def merge_rects(rects, tolerance=8.0, overlap_threshold=0.65):
        merged_rects = []
        for left, top, right, bottom in sorted(rects, key=lambda r: (r[1], r[0])):
            merged = False
            for idx, (ml, mt, mr, mb) in enumerate(merged_rects):
                inter_l = max(left, ml)
                inter_t = max(top, mt)
                inter_r = min(right, mr)
                inter_b = min(bottom, mb)
                inter = max(0.0, inter_r - inter_l) * max(0.0, inter_b - inter_t)
                area = max(1.0, (right - left) * (bottom - top))
                m_area = max(1.0, (mr - ml) * (mb - mt))
                gap_x = max(0.0, max(left, ml) - min(right, mr))
                gap_y = max(0.0, max(top, mt) - min(bottom, mb))
                close = gap_x <= tolerance and gap_y <= tolerance
                same_box = abs(left - ml) < tolerance and abs(top - mt) < tolerance and abs(right - mr) < tolerance and abs(bottom - mb) < tolerance
                if same_box or close or inter / min(area, m_area) > overlap_threshold:
                    merged_rects[idx] = (min(left, ml), min(top, mt), max(right, mr), max(bottom, mb))
                    merged = True
                    break
            if not merged:
                merged_rects.append((left, top, right, bottom))
        return merged_rects

    for image in page.get_images(full=True):
        check_cancelled()
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

        normalized_rects = []
        for rect in rects:
            check_cancelled()
            left = float(min(rect.x0, rect.x1))
            right = float(max(rect.x0, rect.x1))
            top = float(min(rect.y0, rect.y1))
            bottom = float(max(rect.y0, rect.y1))
            if not valid_box(left, top, right, bottom):
                continue
            normalized_rects.append((left, top, right, bottom))

        # A reused xref can appear in several nearby placements. Only merge
        # clipped duplicates, otherwise adjacent figures become one export.
        for left, top, right, bottom in merge_rects(normalized_rects, tolerance=0.0, overlap_threshold=0.92):
            items.append({
                "xref": xref,
                "pageNumber": int(page_no),
                "width": width,
                "height": height,
                "extension": ext,
                "bbox": [left, top, right, bottom],
                "source": "xref",
            })

    vector_rects = []
    try:
        drawings = page.get_drawings()
    except Exception:
        drawings = []

    for drawing in drawings:
        check_cancelled()
        rect = drawing.get("rect")
        if rect is None:
            continue
        left = float(max(0.0, min(page_rect.width, min(rect.x0, rect.x1) - page_rect.x0)))
        right = float(max(0.0, min(page_rect.width, max(rect.x0, rect.x1) - page_rect.x0)))
        top = float(max(0.0, min(page_rect.height, min(rect.y0, rect.y1) - page_rect.y0)))
        bottom = float(max(0.0, min(page_rect.height, max(rect.y0, rect.y1) - page_rect.y0)))
        if valid_box(left, top, right, bottom, vector=True):
            vector_rects.append((left, top, right, bottom))

    # Only collapse duplicate/near-identical drawing paths. Adjacent paths can
    # be separate chart marks, borders, or glyph outlines; merging them by a
    # proximity threshold creates false page-sized image targets.
    for left, top, right, bottom in merge_rects(vector_rects, tolerance=0.0, overlap_threshold=0.92):
        if not valid_box(left, top, right, bottom, vector=True):
            continue
        items.append({
            "xref": 0,
            "pageNumber": int(page_no),
            "width": int(max(1.0, right - left)),
            "height": int(max(1.0, bottom - top)),
            "extension": "svg",
            "bbox": [left, top, right, bottom],
            "source": "vector",
        })

    result = json.dumps(items)
finally:
    doc.close()
"#,
            Some(&locals),
            Some(&locals),
        )?;

        let result_obj = locals.get_item("result")?.ok_or_else(|| {
            pyo3::exceptions::PyRuntimeError::new_err("missing result from python")
        })?;
        result_obj.extract()
    })
    .map_err(|err| format!("pymupdf list images failed: {err}"))
}

pub fn extract_pdf_image_json(path: &str, page_no: usize, xref: usize) -> Result<String, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<String> {
        let locals = PyDict::new_bound(py);
        locals.set_item("path", path_owned.as_str())?;
        locals.set_item("page_no", page_no as i32)?;
        locals.set_item("xref", xref as i32)?;
        py.run_bound(
            r#"
import base64
import fitz
import json

doc = fitz.open(path)
try:
    total = int(doc.page_count)
    if page_no <= 0 or page_no > total:
        raise ValueError(f"page {page_no} out of range (1..={total})")
    page = doc.load_page(page_no - 1)
    page_xrefs = {int(item[0]) for item in page.get_images(full=True) if len(item) > 0}
    if xref <= 0 or xref not in page_xrefs:
        raise ValueError(f"image xref {xref} is not present on page {page_no}")
    extracted = doc.extract_image(xref)
    image_bytes = extracted.get("image")
    if not image_bytes:
        raise ValueError(f"image xref {xref} has no extractable bytes")
    result = json.dumps({
        "xref": int(xref),
        "pageNumber": int(page_no),
        "extension": str(extracted.get("ext", "bin")),
        "width": int(extracted.get("width", 0)),
        "height": int(extracted.get("height", 0)),
        "dataBase64": base64.b64encode(image_bytes).decode("ascii"),
    })
finally:
    doc.close()
"#,
            Some(&locals),
            Some(&locals),
        )?;

        let result_obj = locals.get_item("result")?.ok_or_else(|| {
            pyo3::exceptions::PyRuntimeError::new_err("missing extracted image result")
        })?;
        result_obj.extract()
    })
    .map_err(|err| format!("pymupdf image extraction failed: {err}"))
}

#[cfg(test)]
pub fn ensure_test_pdf_with_image(
    path: &std::path::Path,
    image_bytes: &[u8],
) -> Result<(), String> {
    ensure_python_runtime();
    let path_owned = path.to_string_lossy().into_owned();
    Python::with_gil(|py| -> PyResult<()> {
        let locals = PyDict::new_bound(py);
        locals.set_item("path", path_owned.as_str())?;
        locals.set_item(
            "image_bytes",
            pyo3::types::PyBytes::new_bound(py, image_bytes),
        )?;
        py.run_bound(
            r#"
import fitz
doc = fitz.open()
page = doc.new_page(width=200, height=200)
page.insert_image(fitz.Rect(20, 20, 100, 100), stream=image_bytes)
# A nearby reused xref must remain two exportable placements.
page.insert_image(fitz.Rect(102, 20, 182, 100), stream=image_bytes)
# A wide, short raster resource protects against aspect-ratio filtering that
# used to hide banners and figure labels from the export list.
page.insert_image(fitz.Rect(110, 160, 195, 168), stream=image_bytes)
page.draw_rect(fitz.Rect(120, 120, 180, 180), color=(0.1, 0.3, 0.8), width=2)
page.draw_rect(fitz.Rect(183, 120, 197, 180), color=(0.8, 0.2, 0.2), width=2)
doc.save(path)
doc.close()
"#,
            Some(&locals),
            Some(&locals),
        )?;
        Ok(())
    })
    .map_err(|err| format!("create test PDF failed: {err}"))
}

#[cfg(test)]
pub fn ensure_test_pdf_with_text_pages(
    path: &std::path::Path,
    page_count: usize,
) -> Result<(), String> {
    ensure_python_runtime();
    let path_owned = path.to_string_lossy().into_owned();
    Python::with_gil(|py| -> PyResult<()> {
        let locals = PyDict::new_bound(py);
        locals.set_item("path", path_owned.as_str())?;
        locals.set_item("page_count", page_count)?;
        py.run_bound(
            r#"
import fitz
doc = fitz.open()
for index in range(page_count):
    page = doc.new_page(width=595, height=842)
    page.insert_text((48, 72), f"r0nix long document fixture page {index + 1}", fontsize=12)
doc.save(path)
doc.close()
"#,
            Some(&locals),
            Some(&locals),
        )?;
        Ok(())
    })
    .map_err(|err| format!("create long PDF fixture failed: {err}"))
}

pub fn get_pdf_reading_blocks_json(
    path: &str,
    start_page: Option<usize>,
    end_page: Option<usize>,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<String, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<String> {
        let locals = PyDict::new_bound(py);
        locals.set_item("path", path_owned.as_str())?;
        locals.set_item("start_page", start_page.unwrap_or(1))?;
        locals.set_item("end_page", end_page.unwrap_or(0))?;
        if let Some(flag) = cancel_flag {
            locals.set_item("cancel_probe", Py::new(py, CancellationProbe { flag })?)?;
        } else {
            locals.set_item("cancel_probe", py.None())?;
        }

        py.run_bound(
            r#"
import fitz
import json
import re

def check_cancelled():
    if cancel_probe is not None and cancel_probe.is_cancelled():
        raise RuntimeError("r0nix-cancelled")

doc = fitz.open(path)
try:
    items = []
    first_page = max(1, int(start_page)) - 1
    last_page = min(int(doc.page_count), int(end_page)) if int(end_page) > 0 else int(doc.page_count)
    for page_index in range(first_page, max(first_page, last_page)):
        check_cancelled()
        page = doc.load_page(page_index)
        rect = page.rect
        page_x0 = float(rect.x0)
        page_y0 = float(rect.y0)
        page_w = float(rect.width) or 1.0
        page_h = float(rect.height) or 1.0

        for block_index, block in enumerate(page.get_text("blocks")):
            check_cancelled()
            if len(block) < 5:
                continue

            x0, y0, x1, y1 = map(float, block[:4])
            raw_text = "" if block[4] is None else str(block[4])
            text = re.sub(r"\s+", " ", raw_text).strip()
            block_type = int(block[6]) if len(block) > 6 else 0
            kind = "image" if block_type == 1 else "text"

            if not text and kind != "image":
                continue

            left = max(0.0, min(page_w, min(x0, x1) - page_x0))
            top = max(0.0, min(page_h, min(y0, y1) - page_y0))
            right = max(0.0, min(page_w, max(x0, x1) - page_x0))
            bottom = max(0.0, min(page_h, max(y0, y1) - page_y0))
            if right <= left or bottom <= top:
                continue

            items.append({
                "id": f"pymupdf-{page_index + 1}-{block_index}",
                "page": page_index + 1,
                "kind": kind,
                "text": text,
                "rect": {
                    "x": left / page_w,
                    "y": top / page_h,
                    "width": (right - left) / page_w,
                    "height": (bottom - top) / page_h,
                },
                "source": "pymupdf",
            })

    result = json.dumps(items, ensure_ascii=False)
finally:
    doc.close()
"#,
            Some(&locals),
            Some(&locals),
        )?;

        let result_obj = locals.get_item("result")?.ok_or_else(|| {
            pyo3::exceptions::PyRuntimeError::new_err("missing result from python")
        })?;
        result_obj.extract()
    })
    .map_err(|err| format!("pymupdf reading block extraction failed: {err}"))
}
