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
const serviceRaw = readFileSync("src/services/readingAssistant.ts", "utf8");
const settings = view(readFileSync("src/components/Settings.tsx", "utf8"));
// 批注水合已从 App.tsx 抽到独立模块（既可单测，也让 App.tsx 不再承担数据契约）。
const annotations = view(readFileSync("src/services/readerAnnotations.ts", "utf8"));
const companionRaw = readFileSync("src/services/readingCompanion.ts", "utf8");
const companion = view(companionRaw);

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

// ── 伴读 Agent 的硬约束（docs/companion-reading-plan.md §3.4 / §3.5 / §9） ──
// #3「行为信号永不上传」是产品决定，代码里唯一能机械验证的代理就是：
// 这个模块不许出现任何网络调用。连 console.log 一起禁 —— 打日志同样是把本机行为外泄。
// 注意：view() 不剥注释，所以注释里提到这些 API 也会命中；源码里的注释因此刻意
// 写成了不带括号的形式。
assert(
  !companionRaw.includes("invoke(") &&
    !companionRaw.includes("fetch(") &&
    !companionRaw.includes("XMLHttpRequest") &&
    !companionRaw.includes("console.log"),
  "services/readingCompanion.ts must stay offline: no Tauri invoke, fetch, XHR or logging."
);
// #4 deriveIntensity 必须是纯函数，否则无法单测 —— 而它决定用户看到多少主动提示。
// 只查函数体，避免把文件头里解释「为什么禁止」的注释误判成违规。
const deriveMarker = "export function deriveIntensity";
const deriveStart = companionRaw.indexOf(deriveMarker);
const deriveRest = companionRaw.slice(deriveStart + deriveMarker.length);
const nextExport = deriveRest.indexOf("\nexport ");
const deriveBody = deriveRest.slice(0, nextExport < 0 ? deriveRest.length : nextExport);
assert(deriveStart >= 0, "services/readingCompanion.ts must export deriveIntensity.");
assert(
  !deriveBody.includes("Date.now") && !deriveBody.includes("Math.random") && !deriveBody.includes("localStorage"),
  "deriveIntensity must stay a pure function: no clock, no randomness, no IO."
);
// 否定集合必须走版本化封装，不要绕过它直接碰 localStorage（损坏隔离与前向兼容都在那层）。
assert(
  companion.includes('from "./localStore.ts"') && !companionRaw.includes("window.localStorage"),
  "the companion dismissal set must persist through the versioned localStore wrapper."
);
// §3.5 那个「投诉级 bug」：只删标注不写否定集合 = 翻回这页它又长出来。
// ⚠️ 这是**弱证据**，而且弱得有据可查：实测把调用包进 `if (false && …)` 之后
// 守卫照样是绿的 —— 字符串守卫只能证明「这行字还在」，证明不了「它会被执行」。
// 真正的判据是 `dismissalForRemovedAnnotation` 上的行为断言（见 test-reading-companion.mjs），
// 这条只负责防「整条接线被删掉」这种最粗的回归。
assert(
  app.includes("dismissalForRemovedAnnotation") && app.includes("loadDismissedBlocks"),
  "removing an AI annotation must also record its block in the companion dismissal set."
);
assert(
  companion.includes("export function dismissalForRemovedAnnotation"),
  "the dismissal decision must live in services/readingCompanion.ts where it is covered by behaviour tests."
);

// ── 伴读候选提示（§6）：不得另开网络通道，解析必须在纯逻辑层 ──
// 「不新增 Rust 命令、不另写一份 fetch + 超时 + 截断」的可验证代理：
// suggestReadingCompanion 的函数体内不许出现自己的 fetch / invoke，
// 它只能走既有的 requestChatCompletionText。
const suggMarker = "export async function suggestReadingCompanion";
const suggStart = serviceRaw.indexOf(suggMarker);
assert(suggStart >= 0, "readingAssistant.ts must export suggestReadingCompanion.");
const suggBody = serviceRaw.slice(suggStart);
assert(
  !suggBody.includes("fetch(") && !suggBody.includes("invoke("),
  "companion suggestions must reuse the existing LLM channel, not open a second network path."
);
assert(
  suggBody.includes("requestChatCompletionText") &&
    suggBody.includes("parseCompanionSuggestions") &&
    suggBody.includes("limitCompanionSuggestions"),
  "companion suggestions must go through the shared request helper and the tested parser."
);
// 解析不放 readingAssistant.ts 是因为那里 import 了 @tauri-apps/api，node 加载不了，
// 于是解析只能靠字符串断言 —— 而「模型返回垃圾时会不会崩」最需要行为断言。
assert(
  serviceRaw.includes('from "./companionSuggestion"'),
  "companion suggestion parsing must live in services/companionSuggestion.ts where it can be unit tested."
);

// #1 的那半句「`wavy` 不在 ToolType 里」**不在这里守** —— 它已经变成编译期断言
// （`readerCore.ts` 的 `WAVY_IS_NOT_A_USER_TOOL`：类型退化成 never 时构建当场红）。
// 这里只守类型系统看不见的那半句：白名单必须含 wavy。
assert(
  annotations.includes('wavy: true'),
  "the annotation kind whitelist must include the AI-only wavy kind."
);
// #5 不得出现第二个内联浮层组件：会出现两个「AI 在这儿说话」的位置，
// 锚点 / 钳制 / abort 各写一份。伴读气泡必须复用 ReadingAssistMenu 的 inline-toolbar 变体。
// 只匹配**引用形式**（import / 组件用法），不匹配裸名字 ——
// 否则将来有人在注释里写「不要新建 CompanionBubble」会被误判（view() 不剥注释）。
const secondOverlayRef = (source, name) =>
  new RegExp(`(from\\s*"[^"]*${name}"|<${name}[\\s/>])`).test(source);

assert(
  menu.includes('variant === "inline-toolbar"') || menu.includes('variant: "panel" | "inline-toolbar"'),
  "ReadingAssistMenu must keep its inline toolbar variant for the companion bubble to reuse."
);

for (const name of ["CompanionBubble", "CompanionPopover", "CompanionOverlay"]) {
  assert(
    !secondOverlayRef(viewer.raw, name) && !secondOverlayRef(app.raw, name),
    `a second inline overlay component (${name}) must not be introduced; reuse ReadingAssistMenu.`
  );
}

// 停留采集模块同样必须纯且离线：它跑在滚动回调里，任何 IO 或不确定性都会
// 既拖慢滚动、又让「停留多久触发」变得不可复现。
const dwell = view(readFileSync("src/services/companionDwell.ts", "utf8"));
for (const forbidden of ["Date.now", "Math.random", "fetch(", "invoke(", "XMLHttpRequest", "localStorage"]) {
  assert(
    !dwell.includes(forbidden),
    `companion dwell must stay a pure, offline module; found ${forbidden}.`
  );
}

console.log("reading-assist-contract: ok");
