use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::env;
use std::ffi::CStr;
use std::path::{Path, PathBuf};
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

/// 可执行文件同级目录里，内嵌 Python 运行时可能出现的位置。
///
/// macOS 的 `.app` 布局和 Windows/Linux 不一样：可执行文件在 `Contents/MacOS/`，
/// 资源在 `Contents/Resources/`。**只找同级的小写 `resources/` 在 macOS 上永远命中不了。**
///
/// 命中不了并不等于「立刻报错」—— 拿不到 runtime 就不设 `PYTHONHOME`，Python 会
/// 悄悄回落到**编译期写死的构建机 framework 前缀**。于是包在构建机上一切正常，
/// 换到没装同一版本 python.org 解释器的用户机上，第一次用 PDF 就
/// `ModuleNotFoundError: encodings` 并以退出码 1 结束进程。
fn runtime_candidates_for(exe_dir: &Path) -> Vec<PathBuf> {
    vec![
        exe_dir.join("..").join("Resources").join("runtime"),
        exe_dir.join("resources").join("runtime"),
        exe_dir.join("runtime"),
        exe_dir.to_path_buf(),
    ]
}

fn runtime_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.extend(runtime_candidates_for(exe_dir));
        }
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("runtime"));
        candidates.push(cwd.join("runtime"));
    }

    candidates
}

fn pick_runtime_home() -> Option<PathBuf> {
    runtime_candidates().into_iter().find_map(|candidate| {
        if !(candidate_has_matching_stdlib(&candidate)
            || candidate.join("Lib").join("encodings").exists())
        {
            return None;
        }
        // macOS 那个候选带 `..`；规范化之后再当 PYTHONHOME 用，日志和 sys.prefix 都干净。
        Some(std::fs::canonicalize(&candidate).unwrap_or(candidate))
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

/// CPython 在 Unix 上的标准库目录名带点：`python312` -> `python3.12`。
/// Windows 用 `Lib/`，所以只有非 Windows 的路径才需要这个转换。
fn dotted_python_dir(tag: &str) -> Option<String> {
    let version = tag.strip_prefix("python")?;
    // 先量长度再切。`split_at(1)` 对空串会 panic（本文件原来的
    // `&tag[6..7]` 写法对短 tag 也一样），而这里是从 `Py_GetVersion()` 拿来的
    // 外部字符串 —— 不该因为它形状意外就把进程带走。
    if version.len() < 2 || !version.is_char_boundary(1) {
        return None;
    }
    let (major, minor) = version.split_at(1);
    Some(format!("python{major}.{minor}"))
}

fn candidate_has_matching_stdlib(candidate: &std::path::Path) -> bool {
    let Some(tag) = linked_python_tag() else {
        return false;
    };
    candidate.join(format!("{tag}.zip")).exists()
        || dotted_python_dir(&tag)
            .map(|dir| candidate.join("lib").join(dir).join("encodings").exists())
            .unwrap_or(false)
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
                // 目录名是 `lib/python3.12/lib-dynload`，不是 `lib/python312/`。
                // 拼错就 `.exists()` 为假、整条路径不进 PYTHONPATH，于是 lib-dynload 里
                // 那批 C 扩展（zlib、_struct、_hashlib …）统统不可导入 —— 包明明把
                // lib-dynload 打进去了，却一次都用不上。
                linked_tag
                    .as_deref()
                    .and_then(dotted_python_dir)
                    .map(|dir| runtime_home.join("lib").join(dir).join("lib-dynload"))
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

/// `r0nix --check-python-runtime`：让打包后的应用自证「用的是包内那份 Python」。
///
/// 为什么需要它：这一整类缺陷在构建机上是**看不见的**。构建机（和 CI runner）装了
/// python.org 的解释器，所以即使应用找不到内嵌 runtime、没设 `PYTHONHOME`，Python 也会
/// 回落到编译期写死的 framework 前缀，一切照常；只有到了没装同一版本 Python 的用户机
/// 上才第一次炸。光跑「进程还活着吗」也抓不住 —— 应用启动阶段根本不碰 Python。
///
/// 所以这里不满足于「能 import」：它断言 `sys.base_prefix` **就是包内的 runtime**，
/// 把「包是自包含的」变成构建产物上一条可以执行的断言。
pub fn python_runtime_self_check_if_requested() -> Option<i32> {
    if !env::args().any(|arg| arg == "--check-python-runtime") {
        return None;
    }

    Some(match self_check_python_runtime() {
        Ok(summary) => {
            println!("python-runtime-check: {summary}");
            println!("python-runtime-check: ok");
            0
        }
        Err(message) => {
            eprintln!("python-runtime-check: FAILED -- {message}");
            1
        }
    })
}

fn self_check_python_runtime() -> Result<String, String> {
    let home = pick_runtime_home().ok_or_else(|| {
        format!(
            "找不到内嵌的 Python 运行时。候选路径：{:#?}",
            runtime_candidates()
        )
    })?;
    let expected = std::fs::canonicalize(&home).unwrap_or_else(|_| home.clone());

    ensure_python_runtime();

    Python::with_gil(|py| -> PyResult<String> {
        let sys = py.import_bound("sys")?;
        let base_prefix: String = sys.getattr("base_prefix")?.extract()?;
        let actual =
            std::fs::canonicalize(&base_prefix).unwrap_or_else(|_| PathBuf::from(&base_prefix));

        if actual != expected {
            return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                "Python 的 base_prefix 是 {}，不是包内的 {}。包不自包含：\
                 在没有同一版本 Python 的机器上，第一次用 PDF 就会初始化失败。",
                actual.display(),
                expected.display()
            )));
        }

        py.import_bound("encodings")?;
        // 只 import 还不够。让原生层真跑一次 —— 建一个空文档、加一页、读页数：
        // 这会真正加载包内的 `_mupdf.so` / `libmupdf.dylib`，也就是
        // `export_page_png` / `get_page_images` 依赖的那条路径。
        let fitz = py.import_bound("fitz")?;
        let doc = fitz.call_method0("open")?;
        doc.call_method0("new_page")?;
        let page_count: usize = doc.getattr("page_count")?.extract()?;
        doc.call_method0("close")?;
        if page_count != 1 {
            return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                "PyMuPDF 自检异常：新建文档的页数是 {page_count}，期望 1"
            )));
        }

        Ok(format!(
            "home={} base_prefix={} encodings+PyMuPDF 可用",
            expected.display(),
            actual.display()
        ))
    })
    .map_err(|err| err.to_string())
}

fn close_python_document(doc: &Bound<'_, PyAny>) -> PyResult<()> {
    doc.call_method0("close").map(|_| ())
}

pub fn get_page_count(path: &str) -> Result<usize, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<usize> {
        let fitz = py.import_bound("fitz")?;
        let doc = fitz.call_method1("open", (path_owned.as_str(),))?;
        let result = doc.getattr("page_count").and_then(|value| value.extract());
        let close_result = close_python_document(&doc);
        match (result, close_result) {
            (Ok(page_count), Ok(())) => Ok(page_count),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    })
    .map_err(|err| format!("pymupdf page count failed: {err}"))
}

pub fn render_page_png(path: &str, page_no: usize, zoom: f32) -> Result<Vec<u8>, String> {
    ensure_python_runtime();
    let safe_zoom = if zoom.is_finite() {
        zoom.clamp(0.1, 8.0)
    } else {
        return Err("render zoom must be finite".to_string());
    };
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<Vec<u8>> {
        let fitz = py.import_bound("fitz")?;
        let doc = fitz.call_method1("open", (path_owned.as_str(),))?;
        let result: PyResult<Vec<u8>> = (|| {
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
            page.call_method("get_pixmap", (), Some(&kwargs))
                .and_then(|pixmap| pixmap.call_method1("tobytes", ("png",)))
                .and_then(|bytes| bytes.extract())
        })();
        let close_result = close_python_document(&doc);
        match (result, close_result) {
            (Ok(png), Ok(())) => Ok(png),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    })
    .map_err(|err| format!("pymupdf render failed: {err}"))
}

pub fn render_page_svg(path: &str, page_no: usize) -> Result<String, String> {
    ensure_python_runtime();
    let path_owned = path.to_string();

    Python::with_gil(|py| -> PyResult<String> {
        let fitz = py.import_bound("fitz")?;
        let doc = fitz.call_method1("open", (path_owned.as_str(),))?;
        let result: PyResult<String> = (|| {
            let page_count: usize = doc.getattr("page_count")?.extract()?;
            if page_no == 0 || page_no > page_count {
                return Err(pyo3::exceptions::PyValueError::new_err(format!(
                    "page {page_no} out of range (1..={page_count})"
                )));
            }
            let page = doc.call_method1("load_page", ((page_no - 1) as i32,))?;
            page.call_method0("get_svg_image")
                .and_then(|svg| svg.extract())
        })();
        let close_result = close_python_document(&doc);
        match (result, close_result) {
            (Ok(svg), Ok(())) => Ok(svg),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
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
        let svg_result: PyResult<String> = (|| {
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
                return Err(pyo3::exceptions::PyValueError::new_err("crop rect is empty"));
            }
            let locals = PyDict::new_bound(py);
            locals.set_item("page", page)?;
            locals.set_item("x0", x0)?;
            locals.set_item("y0", y0)?;
            // PyMuPDF's SVG paths use a matrix that flips the PDF Y axis.
            // Convert the PDF top-origin crop to the SVG bottom-origin viewBox.
            locals.set_item("svg_y0", page_h - y1)?;
            locals.set_item("crop_width", x1 - x0)?;
            locals.set_item("crop_height", y1 - y0)?;
            py.run_bound(
            r#"
import re

svg = page.get_svg_image()
clip_id = "r0nix-crop"
clip_def = f'<defs><clipPath id="{clip_id}"><rect x="{x0:g}" y="{svg_y0:g}" width="{crop_width:g}" height="{crop_height:g}"/></clipPath></defs>'
svg = re.sub(
    r'<svg\b([^>]*)>',
    f'<svg\1 viewBox="{x0:g} {svg_y0:g} {crop_width:g} {crop_height:g}" width="{crop_width:g}pt" height="{crop_height:g}pt" overflow="hidden">{clip_def}<g clip-path="url(#{clip_id})">',
    svg,
    count=1,
)
svg = re.sub(r'</svg>\s*$', '</g></svg>', svg, count=1)
result = svg
"#,
            Some(&locals),
            Some(&locals),
            )?;
            locals
                .get_item("result")?
                .ok_or_else(|| pyo3::exceptions::PyRuntimeError::new_err("missing cropped SVG result"))?
                .extract()
        })();
        let close_result = close_python_document(&doc);
        match (svg_result, close_result) {
            (Ok(svg), Ok(())) => Ok(svg),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
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
    page_x0 = float(page_rect.x0)
    page_y0 = float(page_rect.y0)
    page_area = max(1.0, float(page_rect.width) * float(page_rect.height))
    items = []

    def valid_box(left, top, right, bottom, vector=False):
        box_w = max(0.0, right - left)
        box_h = max(0.0, bottom - top)
        area_ratio = (box_w * box_h) / page_area
        aspect = max(box_w / max(1.0, box_h), box_h / max(1.0, box_w))
        if vector:
            # Large figures can legitimately occupy most of a paper column or
            # page. Reserve only the near-full-page range for background
            # filtering; a 45% cap silently dropped wide vector charts.
            return box_w >= 14 and box_h >= 14 and 0.0018 <= area_ratio <= 0.88 and aspect <= 18
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
                # A zero tolerance means overlap-only merging. Treating a
                # touching edge as "close" combines adjacent figures into a
                # single export target.
                close = tolerance > 0.0 and gap_x <= tolerance and gap_y <= tolerance
                same_box = abs(left - ml) < tolerance and abs(top - mt) < tolerance and abs(right - mr) < tolerance and abs(bottom - mb) < tolerance
                if same_box or close or inter / min(area, m_area) > overlap_threshold:
                    merged_rects[idx] = (min(left, ml), min(top, mt), max(right, mr), max(bottom, mb))
                    merged = True
                    break
            if not merged:
                merged_rects.append((left, top, right, bottom))
        return merged_rects

    def dedupe_vector_rects(rects, overlap_threshold=0.96):
        # Vector figures frequently contain nested paths (plots, axes,
        # legends, and labels). A one-sided overlap test treats containment as
        # duplication and expands the export target toward the outer path.
        # Only remove paths that cover almost exactly the same rectangle.
        unique = []
        for left, top, right, bottom in sorted(rects, key=lambda r: (r[1], r[0])):
            area = max(1.0, (right - left) * (bottom - top))
            duplicate = False
            for uleft, utop, uright, ubottom in unique:
                inter_l = max(left, uleft)
                inter_t = max(top, utop)
                inter_r = min(right, uright)
                inter_b = min(bottom, ubottom)
                inter = max(0.0, inter_r - inter_l) * max(0.0, inter_b - inter_t)
                u_area = max(1.0, (uright - uleft) * (ubottom - utop))
                if inter / area >= overlap_threshold and inter / u_area >= overlap_threshold:
                    duplicate = True
                    break
            if not duplicate:
                unique.append((left, top, right, bottom))
        return unique

    check_cancelled()
    image_records = page.get_images(full=True)
    check_cancelled()
    for image in image_records:
        check_cancelled()
        xref = int(image[0])
        width = int(image[2]) if len(image) > 2 else 0
        height = int(image[3]) if len(image) > 3 else 0

        ext = ""
        try:
            check_cancelled()
            ext = str(doc.extract_image(xref).get("ext", ""))
            check_cancelled()
        except Exception:
            ext = ""

        rects = []
        try:
            check_cancelled()
            rects = page.get_image_rects(xref)
            check_cancelled()
        except Exception:
            rects = []

        if not rects:
            continue

        normalized_rects = []
        for rect in rects:
            check_cancelled()
            left = float(min(rect.x0, rect.x1) - page_x0)
            right = float(max(rect.x0, rect.x1) - page_x0)
            top = float(min(rect.y0, rect.y1) - page_y0)
            bottom = float(max(rect.y0, rect.y1) - page_y0)
            left = max(0.0, min(float(page_rect.width), left))
            right = max(0.0, min(float(page_rect.width), right))
            top = max(0.0, min(float(page_rect.height), top))
            bottom = max(0.0, min(float(page_rect.height), bottom))
            if not valid_box(left, top, right, bottom):
                continue
            normalized_rects.append((left, top, right, bottom))

        # A reused xref can appear in several nearby placements. Only merge
        # clipped duplicates, otherwise adjacent figures become one export.
        for left, top, right, bottom in merge_rects(normalized_rects, tolerance=0.0, overlap_threshold=0.92):
            items.append({
                "xref": xref,
                "pageNumber": int(page_no),
                "pageWidth": float(page_rect.width),
                "pageHeight": float(page_rect.height),
                "width": width,
                "height": height,
                "extension": ext,
                "bbox": [left, top, right, bottom],
                "source": "xref",
            })

    # Inline images and some structure-preserving PDF producers expose image
    # placements only through get_image_info(), not through get_images(). This
    # returns metadata without serializing image bytes or computing xref
    # digests; ordinary xrefs are already handled by the loop above.
    image_infos = []
    try:
        check_cancelled()
        image_infos = page.get_image_info()
        check_cancelled()
    except Exception:
        image_infos = []

    for block in image_infos:
        check_cancelled()
        bbox = block.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        left = float(min(bbox[0], bbox[2]) - page_x0)
        right = float(max(bbox[0], bbox[2]) - page_x0)
        top = float(min(bbox[1], bbox[3]) - page_y0)
        bottom = float(max(bbox[1], bbox[3]) - page_y0)
        left = max(0.0, min(float(page_rect.width), left))
        right = max(0.0, min(float(page_rect.width), right))
        top = max(0.0, min(float(page_rect.height), top))
        bottom = max(0.0, min(float(page_rect.height), bottom))
        if not valid_box(left, top, right, bottom):
            continue

        # The frontend deduplicates overlapping xref/block candidates while
        # preserving the block source for inline resources.
        items.append({
            "xref": 0,
            "pageNumber": int(page_no),
            "pageWidth": float(page_rect.width),
            "pageHeight": float(page_rect.height),
            "width": int(block.get("width", max(1.0, right - left)) or 0),
            "height": int(block.get("height", max(1.0, bottom - top)) or 0),
            "extension": "crop",
            "bbox": [left, top, right, bottom],
            "source": "block",
        })

    vector_rects = []
    try:
        check_cancelled()
        drawings = page.get_drawings()
        check_cancelled()
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
            # A single white filled path in a small area is usually a logo
            # knockout or page decoration, not an exportable figure. Keep
            # stroked shapes and multi-path drawings, which cover charts and
            # diagrams, while avoiding false SVG targets around page chrome.
            items_for_drawing = drawing.get("items") or []
            fill = drawing.get("fill")
            white_fill = (
                isinstance(fill, (list, tuple)) and len(fill) >= 3 and
                all(float(channel) >= 0.97 for channel in fill[:3])
            )
            area_ratio = ((right - left) * (bottom - top)) / page_area
            if len(items_for_drawing) <= 1 and white_fill and area_ratio < 0.02:
                continue
            vector_rects.append((left, top, right, bottom))

    # Only collapse duplicate/near-identical drawing paths. Adjacent paths can
    # be separate chart marks, borders, or glyph outlines; merging them by a
    # proximity threshold creates false page-sized image targets.
    for left, top, right, bottom in dedupe_vector_rects(vector_rects):
        if not valid_box(left, top, right, bottom, vector=True):
            continue
        items.append({
            "xref": 0,
            "pageNumber": int(page_no),
            "pageWidth": float(page_rect.width),
            "pageHeight": float(page_rect.height),
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
# Even a touching reused xref must remain two exportable placements.
page.insert_image(fitz.Rect(100, 20, 180, 100), stream=image_bytes)
# A wide, short raster resource protects against aspect-ratio filtering that
# used to hide banners and figure labels from the export list.
page.insert_image(fitz.Rect(110, 160, 195, 168), stream=image_bytes)
page.draw_rect(fitz.Rect(100, 120, 150, 170), color=(0.1, 0.3, 0.8), width=2)
# A nested path must remain a separate vector export target rather than being
# swallowed by the outer chart frame.
page.draw_rect(fitz.Rect(105, 125, 145, 165), color=(0.2, 0.8, 0.3), width=1)
page.draw_rect(fitz.Rect(160, 120, 174, 170), color=(0.8, 0.2, 0.2), width=2)
# A wide vector figure must remain exportable even when it occupies more than
# 45% of the page; only near-full-page backgrounds should be filtered.
page.draw_rect(fitz.Rect(20, 20, 180, 145), color=(0.4, 0.4, 0.4), width=1)
# Keep a non-zero crop-box origin so image coordinates must be normalized
# against page.rect.x0/page.rect.y0 rather than assumed to start at zero.
page.set_cropbox(fitz.Rect(10, 10, 190, 190))
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

        # get_text("dict") 而不是 get_text("blocks")：后者只给块级并集框。
        # 学术论文常见「整栏一块」的版面，一个 block 横跨 5–10 个自然段，
        # 此时并集框既不能切段落也不能定位标注（波浪线贴在并集框底部，
        # 看起来像「跑到整段下面去了」）。dict多一层 lines[]，是解析器
        # 自己算出的行几何，不是我们猜的。
        for block_index, block in enumerate(page.get_text("dict")["blocks"]):
            check_cancelled()
            if int(block.get("type", 0)) == 1:
                # 图片块：dict 里没有行，保留并集框供图片索引使用。
                bbox = [float(v) for v in block["bbox"]]
                if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                    continue
                left = max(0.0, min(page_w, min(bbox[0], bbox[2]) - page_x0))
                top = max(0.0, min(page_h, min(bbox[1], bbox[3]) - page_y0))
                right = max(0.0, min(page_w, max(bbox[0], bbox[2]) - page_x0))
                bottom = max(0.0, min(page_h, max(bbox[1], bbox[3]) - page_y0))
                if right <= left or bottom <= top:
                    continue
                items.append({
                    "id": f"pymupdf-{page_index + 1}-{block_index}",
                    "page": page_index + 1,
                    "kind": "image",
                    "text": "",
                    "rect": {
                        "x": left / page_w,
                        "y": top / page_h,
                        "width": (right - left) / page_w,
                        "height": (bottom - top) / page_h,
                    },
                    "source": "pymupdf",
                })
                continue

            lines = []
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                # 行内文本按span 原样拼接：pymupdf 已经把词间的空格放进去了，
                # 不再用 re.sub(r"\s+", " ") —— 那会把整段的换行压平成空格，
                # 于是「整段」在文本上真的变成了一行（2026-10-07 实测）。
                line_text = "".join(str(span.get("text", "")) for span in spans)
                line_bbox = [float(v) for v in line["bbox"]]
                if not line_text.strip():
                    continue
                if line_bbox[2] <= line_bbox[0] or line_bbox[3] <= line_bbox[1]:
                    continue
                lines.append({
                    "text": line_text,
                    "rect": {
                        "x": max(0.0, min(page_w, line_bbox[0] - page_x0)) / page_w,
                        "y": max(0.0, min(page_h, line_bbox[1] - page_y0)) / page_h,
                        "width": (max(0.0, min(page_w, line_bbox[2] - page_x0))
                                  - max(0.0, min(page_w, line_bbox[0] - page_x0))) / page_w,
                        "height": (max(0.0, min(page_h, line_bbox[3] - page_y0))
                                   - max(0.0, min(page_h, line_bbox[1] - page_y0))) / page_h,
                    },
                })

            if not lines:
                continue

            # 块文本以 "\n" 连接行：保住「这里换行了」这个事实，
            # 翻译与提问时才知道它是一段多行，不是一个长句。
            text = "\n".join(line["text"] for line in lines).strip()
            if not text:
                continue

            bbox = [float(v) for v in block["bbox"]]
            left = max(0.0, min(page_w, min(bbox[0], bbox[2]) - page_x0))
            top = max(0.0, min(page_h, min(bbox[1], bbox[3]) - page_y0))
            right = max(0.0, min(page_w, max(bbox[0], bbox[2]) - page_x0))
            bottom = max(0.0, min(page_h, max(bbox[1], bbox[3]) - page_y0))
            if right <= left or bottom <= top:
                continue

            items.append({
                "id": f"pymupdf-{page_index + 1}-{block_index}",
                "page": page_index + 1,
                "kind": "text",
                "text": text,
                "rect": {
                    "x": left / page_w,
                    "y": top / page_h,
                    "width": (right - left) / page_w,
                    "height": (bottom - top) / page_h,
                },
                "lines": lines,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_candidates_cover_the_macos_app_layout() {
        let exe_dir = Path::new("/Applications/r0nix.app/Contents/MacOS");
        let candidates = runtime_candidates_for(exe_dir);

        assert!(
            candidates.contains(&exe_dir.join("..").join("Resources").join("runtime")),
            "macOS .app 布局必须有候选，否则打包后永远拿不到内嵌 runtime：{candidates:#?}"
        );
        assert!(
            candidates.contains(&exe_dir.join("resources").join("runtime")),
            "Windows/Linux 的同级 resources/ 布局必须保留：{candidates:#?}"
        );
    }

    #[test]
    fn dotted_python_dir_uses_the_unix_layout() {
        assert_eq!(
            dotted_python_dir("python312").as_deref(),
            Some("python3.12")
        );
        assert_eq!(dotted_python_dir("python39").as_deref(), Some("python3.9"));
        assert_eq!(
            dotted_python_dir("python311").as_deref(),
            Some("python3.11")
        );
        // 没有版本号就不该编出一个目录名来。
        assert_eq!(dotted_python_dir("python"), None);
        assert_eq!(dotted_python_dir("cpython312"), None);
    }
}
