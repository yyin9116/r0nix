import { readFileSync } from "node:fs";
import { view } from "./lib/source-view.mjs";
import { readerView } from "./lib/reader-view.mjs";

const menu = view(readFileSync("src/components/ReadingAssistMenu.tsx", "utf8"));
// 阅读器已拆成 1 + 4 个文件，DOM 块几何 / 文本层版本号等断言的目标随之分布在不同
// 文件里；readerView() 把模块当一个整体读，见 scripts/lib/reader-view.mjs。
const viewer = readerView();
const app = view(readFileSync("src/App.tsx", "utf8"));
const viewerCss = view(readFileSync("src/components/PDFViewer.css", "utf8"));
const service = view(readFileSync("src/services/readingAssistant.ts", "utf8"));
const settings = view(readFileSync("src/components/Settings.tsx", "utf8"));
// 批注水合已从 App.tsx 抽到独立模块（既可单测，也让 App.tsx 不再承担数据契约）。
const annotations = view(readFileSync("src/services/readerAnnotations.ts", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const quoteStart = menu.indexOf("const handleQuote = async () =>");
const quoteEnd = menu.indexOf("const expandWithQuestion", quoteStart);
const quoteHandler = menu.slice(quoteStart, quoteEnd);
assert(quoteStart >= 0 && quoteEnd > quoteStart, "Reading assist quote handler must remain explicit.");
assert(quoteHandler.indexOf("onSaveQuote?.") < quoteHandler.indexOf("await copyText"), "Citation persistence must not depend on clipboard success.");
assert(viewer.includes('setSidePanelView("translation")'), "PDF assist selection must open the translation side panel.");
assert(viewer.includes("setIsNotesOpen(true)"), "PDF assist selection must expand the side panel.");
assert(viewer.includes("const group = blockGroup.length > 0 ? blockGroup : paragraphGroup"), "DOM block geometry must be the primary paragraph selection source, with heuristic grouping as fallback.");
assert(viewer.includes("PDF_TEXT_BEARING_BLOCK_KINDS") && viewer.includes('"table"') && viewer.includes('"auxiliary"'), "structured text-bearing PDF blocks must share DOM geometry");
assert(viewer.includes("textLayerVersion"), "assist hover must rebind after the PDF.js text layer finishes rendering.");
assert(viewer.includes("!isNotesOpen || sidePanelView !== \"resources\""), "resource scans must stop when the resource sidebar is closed.");
assert(!viewer.includes("pdf-selection-scope flex-1 overflow-auto bg-zinc-200/50 dark:bg-zinc-950/50 relative z-0 select-none"), "The PDF scroll shell must not impose user-select:none on the text-layer ancestor.");
assert(viewerCss.includes(".pdf-page-block") && viewerCss.includes("-webkit-user-select: none"), "PDF page shells must remain excluded from native text selection.");
const textSpanRule = viewerCss.match(/\.textLayer span,\s*\.textLayer br\s*\{([\s\S]*?)\}/)?.[1] || "";
assert(!textSpanRule.includes("user-select"), "PDF.js text spans must not become independent WebKit selection islands.");
assert(viewerCss.includes("single-character selection and full-page flashes"), "The scoped selection boundary must document the WebKit regression guard.");
assert(menu.includes("askAbortRef.current !== controller"), "Ask AI results and failures must reject stale request controllers.");
assert(menu.includes("if (askAbortRef.current === controller)"), "Ask AI completion must only clear loading state for its owning request.");
// 弹层的定位/钳制只有一套几何。旧实现把尺寸写成常量（工具条 300/390、面板 372，
// 高度 48/260/420），而真实宽度是 `min(390px, calc(100vw - 24px))` —— 宽度本身是视口的函数，
// 高度更没有 CSS 来源。那两个本地钳制函数已删除，不得回归。
// 负断言只匹配**定义形式**：注释里提到这两个名字来解释「为什么删掉」是合法的，
// 被 includes 命中会误伤文档（view() 不剥注释）。
const revivedLocalClamp = /function\s+clamp(?:Toolbar|Menu)Position|const\s+clamp(?:Toolbar|Menu)Position/.test(menu.raw);
assert(
  menu.includes('from "../services/overlayPlacement"') && !revivedLocalClamp,
  "Overlay placement must go through services/overlayPlacement; the removed size-constant clamp helpers must not come back."
);
assert(service.includes("if (parentSignal?.aborted) abort();"), "LLM requests must forward an already-aborted caller signal.");
assert(service.includes("options?.timeoutMs ?? READING_ASSIST_TIMEOUT_MS"), "LLM browser requests must honor operation-specific timeouts.");
assert(service.includes("readResponseTextWithLimit"), "Browser LLM responses must be bounded before materializing the full body.");
assert(service.includes("MAX_LLM_RESPONSE_BYTES"), "Browser LLM responses must share a hard memory limit.");
assert(service.includes("const config = normalizeConfig(configSource);"), "Model connection tests must validate configuration inside their error boundary.");
assert(settings.includes("setModelTest({ status: \"error\""), "Settings model connection errors must restore a non-testing state.");
// ⚠️ 这条断言原先是 `app.includes('typeof item.blockId === "string"')`。批注水合被抽到
// services/readerAnnotations.ts 之后它**仍然通过** —— 因为 App.tsx 里 notes 的水合器
// （`blockId: typeof item.blockId === "string" …`）是**同形字符串**，命中的其实是它。
// 一个「绿着但不再覆盖自己所声称的东西」的守卫比没有守卫更糟，所以改成同时钉住
// ① App 确实经由该模块水合、② 该模块确实保留 blockId。
assert(
  app.includes('from "./services/readerAnnotations"') && annotations.includes("blockId: typeof item.blockId"),
  "stored annotations must be hydrated by services/readerAnnotations and retain an optional source block id."
);
assert(viewer.includes("findReadingBlockIdForRect"), "drawn annotations must resolve to the overlapping reading block.");
assert(viewer.includes("blockId: findReadingBlockIdForRect"), "new annotations must persist the source block id.");
assert(viewer.includes('mode?: "page" | "original" | "crop"'), "image export must distinguish page, original-resource, and crop semantics");
assert(viewer.includes("原始图片资源无法解码") && viewer.includes("exportImageCropPng"), "original image export failures must be visible and offer explicit crop export");

console.log("reading-assist-contract: ok");
