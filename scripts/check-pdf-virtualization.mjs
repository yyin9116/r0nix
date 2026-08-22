import { readFileSync } from "node:fs";

const viewer = readFileSync("src/components/PDFViewer.tsx", "utf8");
const styles = readFileSync("src/components/PDFViewer.css", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(viewer.includes("Array.from({ length: totalPages },"), "PDF page placeholders must preserve document scroll geometry.");
assert(viewer.includes("activePages.has(pageNo)"), "PDF rendering must be gated by the active page set.");
assert(viewer.includes("{active ? ("), "Canvas and text-layer subtree must be mounted only for active pages.");
assert(viewer.includes("active ? getVisibleImagesForPage(pageNo) : []"), "Image overlays must not scan or mount for inactive pages.");
assert(styles.includes("content-visibility: auto"), "Inactive PDF pages must use content-visibility.");
assert(styles.includes("contain-intrinsic-size"), "Inactive PDF pages must have intrinsic placeholder dimensions.");

console.log("pdf-virtualization: ok");
