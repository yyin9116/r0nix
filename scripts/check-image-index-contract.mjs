import { readFileSync } from "node:fs";
import { view } from "./lib/source-view.mjs";
import { readerView } from "./lib/reader-view.mjs";

const native = view(readFileSync("src-tauri/src/py_render.rs", "utf8"));
const adapter = view(readFileSync("src/services/pdfApi.ts", "utf8"));
// 阅读器已拆成 1 + 4 个文件，断言的对象（矢量化去重、面积比上限）随之分布在不同
// 文件里；readerView() 把模块当一个整体读，见 scripts/lib/reader-view.mjs。
const viewer = readerView();
const cache = view(readFileSync("src/services/resourceIndexCache.ts", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(native.includes("page.get_image_info()"), "Native image indexing must inspect metadata for inline image placements.");
assert(native.includes('"source": "block"'), "Native image indexing must preserve block image provenance.");
assert(native.includes("def dedupe_vector_rects"), "Native vector candidates must not merge nested drawing paths.");
assert(viewer.includes('item.img.source === "vector" || existing.img.source === "vector"'), "Frontend vector dedupe must use bidirectional overlap.");
assert(native.includes('"pageWidth": float(page_rect.width)'), "Native image indexing must preserve the source page width.");
assert(native.includes('"pageHeight": float(page_rect.height)'), "Native image indexing must preserve the source page height.");
assert(adapter.includes("const pageWidthValue = Number(obj.pageWidth)"), "The frontend adapter must parse source page dimensions.");
assert(adapter.includes("source !== 'xref' && source !== 'block' && source !== 'vector'"), "The frontend adapter must preserve vector and block image provenance.");
assert(!adapter.includes('obj.source === "vector" ? "vector" : "xref"'), "The frontend adapter must not collapse block images into xref images.");
assert(adapter.includes("extension.length === 0"), "The frontend adapter must reject image candidates without an extension.");
assert(adapter.includes("!Number.isFinite(width) || width <= 0"), "The frontend adapter must reject invalid image widths.");
assert(adapter.includes("!Number.isFinite(height) || height <= 0"), "The frontend adapter must reject invalid image heights.");
assert(adapter.includes("!bbox.every(Number.isFinite)"), "The frontend adapter must reject malformed image bounding boxes.");
assert(adapter.includes("source !== 'xref' && source !== 'block' && source !== 'vector'"), "The frontend adapter must reject unknown image provenance.");
assert(adapter.includes("pageNumberValue !== pageNumber"), "The frontend adapter must reject image records returned for another page.");
assert(adapter.includes("source === 'xref' && (!Number.isInteger(xref) || xref < 1)"), "The frontend adapter must reject xref records without a valid xref.");
assert(adapter.includes(".filter((item): item is PDFImageInfo => item !== null)"), "The frontend adapter must filter invalid native image records explicitly.");
assert(adapter.includes("const rawImages = payload && typeof payload === \"object\""), "The browser image adapter must validate the response envelope.");
assert(adapter.includes("(pageNumber !== undefined && itemPage !== pageNumber)"), "The browser image adapter must reject cross-page image records.");
assert(adapter.includes("const source = obj.source === \"block\""), "The browser image adapter must preserve compatible image provenance.");
assert(adapter.includes("!Number.isInteger(xref) || xref < 0"), "The browser image adapter must accept zero xrefs for block/vector candidates.");
assert(adapter.includes("(source === \"xref\" && xref < 1)"), "The browser image adapter must still require a positive xref for original resources.");
assert(!adapter.includes("pageNumber: Number(obj.pageNumber) || pageNumber"), "The frontend adapter must not synthesize page numbers for malformed records.");
assert(!adapter.includes("width: Number(obj.width) || 0"), "The frontend adapter must not synthesize image dimensions for malformed records.");
assert(!adapter.includes("height: Number(obj.height) || 0"), "The frontend adapter must not synthesize image dimensions for malformed records.");
assert(!adapter.includes("extension: typeof obj.extension === 'string' ? obj.extension : ''"), "The frontend adapter must not accept empty image extensions.");
assert(viewer.includes("img.source !== \"vector\" && areaRatio > MAX_RASTER_IMAGE_AREA_RATIO"), "Raster image candidates must not use the vector area limit.");
assert(viewer.includes("const MAX_RASTER_IMAGE_AREA_RATIO = 0.96"), "Raster image candidates must allow legitimate near-page images while rejecting backgrounds.");
assert(cache.includes("const pageWidth = item.pageWidth === undefined ? undefined : Number(item.pageWidth)"), "The resource cache must preserve image source page width.");
assert(cache.includes("const pageHeight = item.pageHeight === undefined ? undefined : Number(item.pageHeight)"), "The resource cache must preserve image source page height.");
assert(cache.includes("const CACHE_VERSION = 5"), "The resource cache schema must advance when image validation changes.");
assert(cache.includes("!bbox.every(Number.isFinite)"), "The resource cache must reject malformed cached image bounding boxes.");
assert(viewer.includes("contextPointRef"), "Image context menus must retain the pointer location while indexing completes.");
assert(viewer.includes("detectPageImagesRef.current"), "Image context menus must complete indexing before resolving the pointer target.");

console.log("image-index-contract: ok");
