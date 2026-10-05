import { readFileSync } from "node:fs";

const viewer = readFileSync("src/components/MarkdownViewer.tsx", "utf8");
const pdfApi = readFileSync("src/services/pdfApi.ts", "utf8");
const app = readFileSync("src/App.tsx", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(viewer.includes("blockId,\n      x:"), "Markdown reading-assist selections must carry the source block id.");
assert(viewer.includes('"data-reading-block-id": block.id'), "Markdown preview blocks must expose the same stable block id used by notes.");
assert(viewer.includes("assistProps(assistKind, index, text, block.id)"), "Markdown assist handlers must bind to the rendered block, not only its array index.");
assert(viewer.includes("setMode(\"preview\")"), "Markdown note navigation must return to the preview pane before focusing a block.");
assert(viewer.includes("window.requestAnimationFrame(() => window.requestAnimationFrame(focusBlock))"), "Markdown note navigation must wait for the preview block to mount.");
assert(pdfApi.includes("Markdown service returned an invalid content payload."), "Markdown API responses must fail explicitly when content is missing instead of silently returning an empty document.");
assert(app.includes("contentDirty"), "Markdown tabs must persist whether their content is an unsaved draft.");
assert(app.includes("contentBase"), "Markdown tabs must persist the disk content used as the draft base.");
assert(app.includes("existing.contentBase === payload.content"), "Markdown restore must reject a draft when the disk content changed externally.");
assert(app.includes("markMarkdownTabSaved"), "Markdown save must clear the draft marker after a successful write.");
assert(app.includes("closing.contentDirty"), "Closing an unsaved Markdown tab must require explicit user confirmation.");
assert(app.includes("unsavedMarkdownClose"), "Unsaved Markdown close confirmation must be localized.");

console.log("markdown-contract: ok");
