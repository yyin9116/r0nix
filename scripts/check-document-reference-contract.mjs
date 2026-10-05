import { readFileSync } from "node:fs";

const types = readFileSync("src/types.ts", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const viewer = readFileSync("src/components/PDFViewer.tsx", "utf8");
const whiteboards = readFileSync("src/components/Whiteboards.tsx", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/interface ReaderAnnotation[\s\S]*?blockId\?: string/.test(types), "annotations must support stable reading block references");
assert(app.includes("blockId: typeof item.blockId === \"string\""), "stored annotations must restore block references");
assert(viewer.includes("findReadingBlockIdForRect"), "annotation creation must resolve the source reading block");
assert(whiteboards.includes("notesByDocument: Record<string, ReaderNote[]>"), "whiteboards must receive persisted reading notes");
assert(whiteboards.includes("source?: {"), "whiteboard cards must persist source metadata");
assert(whiteboards.includes("const source = {") && whiteboards.includes("blockId: note.blockId"), "imported note cards must retain block and page provenance");
assert(whiteboards.includes("sanitizeSource"), "whiteboard source metadata must be validated on restore");
assert(types.includes("focusRect?: ReaderAnnotationRect"), "PDF view state must support a one-shot source focus rectangle");
assert(app.includes("focusRect: pending.focusRect") && app.includes("scrollTop: 0"), "source navigation must clear stale scroll offsets");
assert(whiteboards.includes("selectedCard.source?.sourceRect"), "whiteboard source navigation must pass the saved bbox");
assert(viewer.includes("const focusRect = initialViewState.focusRect") && viewer.includes("nextRoot.clientHeight / 2"), "PDF viewer must center the requested source rectangle");

console.log("document-reference-contract: ok");
