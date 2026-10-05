import { readFileSync } from "node:fs";
import { view } from "./lib/source-view.mjs";

const viewer = view(readFileSync("src/components/PDFViewer.tsx", "utf8"));
const app = view(readFileSync("src/App.tsx", "utf8"));
const webProxy = view(readFileSync("src/services/webProxy.ts", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(viewer.includes("resolveOutlinePage"), "PDF outline navigation must resolve real destinations.");
assert(!viewer.includes("goToPage(index + 1)"), "PDF outline navigation must not use the outline index as a page number.");
assert(viewer.includes('goToPage(imagePage, "auto")'), "Resource image entries must navigate to their source page.");
assert(app.includes("function sanitizePdfViewState"), "Persisted PDF view state must be validated before hydration.");
assert(app.includes("Math.max(50, Math.min(400"), "Persisted PDF zoom must be clamped to the supported range.");
assert(app.includes("Math.max(0, finite(value.scrollTop, 0))"), "Persisted PDF scroll offsets must not restore negative values.");
assert(webProxy.includes("DIRECT_DOWNLOAD_MAX_BYTES") && webProxy.includes("response.body"), "Direct downloads must be bounded and streamed.");
assert(!app.includes("const response = await fetch(normalized);"), "External downloads must use the bounded HTTP adapter.");

console.log("core-navigation-contract: ok");
