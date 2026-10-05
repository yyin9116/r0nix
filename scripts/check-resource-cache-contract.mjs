import { readFileSync } from "node:fs";
import { view } from "./lib/source-view.mjs";

const viewer = view(readFileSync("src/components/PDFViewer.tsx", "utf8"));
const cache = view(readFileSync("src/services/resourceIndexCache.ts", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(cache.includes("scannedPages"), "resource cache must persist an independent scanned page set");
assert(viewer.includes("scannedPages: resourceScannedPages"), "viewer must save the independent scanned page set");
assert(
  /if \(!resourceScannedPagesRef\.current\.has\(pageNo\)\)[\s\S]{0,500}setResourceScannedPages/.test(viewer),
  "legacy cache hits must be promoted into the scanned page set",
);
assert(viewer.includes("resourceCacheIdentity(documentId || fileId || \"\", documentFileSize, pdfFingerprint)"), "resource cache must include source identity");
assert(viewer.includes("pdfDoc?.fingerprints?.find"), "resource cache should prefer PDF.js document fingerprints");

console.log("resource-cache-contract: ok");
