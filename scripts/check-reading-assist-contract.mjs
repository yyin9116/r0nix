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
const pageCanvas = view(readFileSync("src/components/pdfReader/PageCanvas.tsx", "utf8"));
const companionDwell = view(readFileSync("src/services/companionDwell.ts", "utf8"));

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
/**
 * 段落边界必须来自**解析器给的行级几何**，几何启发式只能兜底。
 *
 * ⚠️ 这条断言原先匹配的是 `const group = blockGroup.length > 0 ? blockGroup : paragraphGroup`
 * —— 即「按块并集框收 span」优先。那正是「点一下选了两段」的成因：
 * 块 rect 是整块并集框，学术论文里一个块能横跨 5–10 个自然段，
 * 按它收 span 必然把邻段一起框进来。
 *
 * 现在的主来源换成 `PdfReadingBlock.lines`（pymupdf `get_text("dict")`
 * 的 `lines[].bbox`）—— 排版引擎给的行几何，判定用中心点命中，跨行不互吞。
 * 断言随之改为钉住新形态，**原则不变**：几何优先、启发式兜底。
 */
assert(
  viewer.includes("resolveParagraphGroup") &&
    viewer.includes("block?.lines?.length") &&
    viewer.includes("collectBlockSpansByLines") &&
    viewer.includes("group = collectPdfParagraphSpansFromTarget(span, spans)"),
  "Paragraph boundaries must come from parser line geometry, with heuristic grouping as fallback."
);
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
// ⚠️ 这里断言的是「算出来的 blockId 一路传进了 onAddAnnotation」，不是某一行写法。
// 原先只查 `blockId: findReadingBlockIdForRect`，行吸附改造后改成
// `const blockId = …` 再在下一段传参，那条断言就静默失效了 ——
// 守卫绿着而它声称覆盖的东西已经不在代码里。
assert(
  /const blockId = findReadingBlockIdForRect\(/.test(viewer.raw) &&
    /onAddAnnotation\?\.\(\{[\s\S]{0,220}?\bblockId,/.test(viewer.raw),
  "new annotations must persist the source block id (computed by findReadingBlockIdForRect and forwarded to onAddAnnotation)."
);
// 行吸附必须在**写入之前**做：存进 localStorage 的矩形在别的入口
// （笔记卡片、导出、AI 重新定位）里都要用，渲染侧兜底只解决「看不看得见」。
assert(
  /const visibleRect\s*=\s*\n?\s*kind === "text"[\s\S]{0,200}?snapAnnotationRectToLines\(/.test(viewer.raw),
  "annotation rects must be snapped to real text lines before persisting, not only at render time."
);
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
// #5 不得出现第二个**浮动浮层**组件：会出现两个「AI 在这儿说话」的位置，
// 锚点 / 钳制 / abort 各写一份。2026-10-09 起伴读形态是页侧批注卡
// （CompanionMarginCard，挂在批注栏里随文档滚动，不是浮层，不受此条约束）；
// 浮动浮层仍只有 ReadingAssistMenu 一家。
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

// 与停留层同款：companionSuggestion.ts 也必须保持纯且离线。
// 它一旦 import 了 @tauri-apps/api 或掺进时钟/随机，就再也加载不进 node，
// 「模型返回垃圾时会不会崩」这条最该被行为断言覆盖的性质就退回成字符串断言了。
const suggestionLogic = view(readFileSync("src/services/companionSuggestion.ts", "utf8"));
for (const forbidden of ["Date.now", "Math.random", "fetch(", "invoke(", "XMLHttpRequest", "localStorage"]) {
  assert(
    !suggestionLogic.includes(forbidden),
    `companion suggestion logic must stay pure and offline; found ${forbidden}.`
  );
}

// 提示必须锚在停留块上：调用点要把 focusedBlockId 带进去，
// 并且结果要用 pickSuggestionForBlock 筛一遍 —— 模型是不可信输入源，
// 它会挑同页「更像结论」的另一块，那会造成「内容说 A、气泡挂在 B」的错位。
//
// ⚠️ 只认**调用**，不认 import 行：实测过，只匹配裸名字时把调用换成 `suggestions[0]`
// 守卫照样绿（import 那一行还在）。同理，下面「暂不提示」那条也不能只匹配裸名字 ——
// `onDismissCompanionRemoved` 之类同样含那段前缀。
const viewerCallLines = viewer.raw.split("\n").filter((line) => !line.trimStart().startsWith("import"));
const viewerCalls = (name) => viewerCallLines.some((line) => line.includes(`${name}(`));
assert(
  viewer.includes("focusedBlockId:") && viewerCalls("pickSuggestionForBlock"),
  "the companion bubble must anchor its hint to the block the reader dwelled on."
);

// ⚠️ 弱证据，且弱得有据可查：字符串守卫只能证明「这行字还在」，证明不了它会被执行
// （§9 里 `if (false && …)` 的实证）。「提示必须自报理由」无法用编译期不变量表达 ——
// `ReaderAnnotation.reason` 是可选字段，但不渲染它 tsc 并不报错。
// 所以这里只防「整块被删掉」这种最粗的回归，别把它当强约束。
// 2026-10-09：理由的渲染载体从气泡卡片换成了页侧批注卡。
const marginCardRaw = readFileSync("src/components/pdfReader/CompanionMarginCard.tsx", "utf8");
assert(
  marginCardRaw.includes("annotation.reason"),
  "a companion hint must state why it appeared — an unexplained proactive action reads as noise."
);
// 批注卡与锚点同源：都必须取自**预算截断后**的清单，否则会出现
// 「卡在讲一段没有波浪线的文字」的错位（与锚点那条同一事故形态）。
const marginCallAt = viewer.raw.indexOf("placeCompanionMarginCards(");
assert(marginCallAt > 0, "placeCompanionMarginCards must be called to assert its arguments.");
assert(
  viewer.raw.slice(marginCallAt, marginCallAt + 200).includes("pageWavyAnnotations"),
  "companion margin cards must derive from the budget-truncated marker list, not the raw annotation list."
);
// 「暂不提示」是打扰度判据（施工单 §11）唯一的输入：
// 没有它，读者只能关掉全局开关 —— 而他只是不想看**这一块**。
assert(
  /onDismissCompanion\s*[=:]/.test(viewer.raw) && viewerCalls("dismissCompanionBlock"),
  "the companion bubble must offer 'not now' and record it in the dismissal set."
);

// ── 标注层的可点性与可见性（2026-10-08 实测回归） ──
//
// 这一组四条都是**纸面上看得见、但功能已经坏了**的问题，tsc 与既有断言全都看不见：
// 波浪线画出来了（所以「有标注」成立），锚点也渲染出来了（所以「有锚点」成立），
// 但点不动、被文本层吃掉、深色下不可见。它们只能靠源码断言钉住。

// ① 锚点必须浮在文本层之上。
// ⚠️ 旧值是 z-index 3，而 `.page-text-overlay` 是 9：文本层在 assist 态下
// `pointer-events: auto`，于是点击落到 span 上被段落命中逻辑吃掉 ——
// 表现是「锚点看得见、点不动」。这里断言的是**常量**而不是 JSX 里的字面量，
// 因为那条值必须与 readingCompanion.ts 同源（两处各写一个数字 = 迟早漂移）。
const anchorZIndex = Number(companionRaw.match(/COMPANION_ANCHOR_Z_INDEX\s*=\s*(\d+)/)?.[1]);
assert(Number.isFinite(anchorZIndex), "COMPANION_ANCHOR_Z_INDEX must be a numeric constant.");
const textLayerZIndex = Number(viewerCss.match(/\.page-text-overlay\s*\{[^}]*?z-index:\s*(\d+)/s)?.[1]);
assert(Number.isFinite(textLayerZIndex), ".page-text-overlay must declare an explicit z-index.");
assert(
  anchorZIndex > textLayerZIndex,
  `companion anchors (z-index ${anchorZIndex}) must sit above .page-text-overlay (${textLayerZIndex}); otherwise the text layer swallows anchor clicks.`
);
// 锚点定位必须与缩放无关：用百分比而不是「未缩放 pageSize 换算出的 px」——
// 后者落在按 `pageSize × renderZoomScale` 渲染的容器里，150% 下整体偏到段落左侧。
assert(
  viewer.includes("left: `calc(${position.x * 100}%") && viewer.includes("top: `calc(${position.y * 100}%"),
  "companion anchors must be positioned in percentages so they track page zoom."
);

// ② 深色反色只作用于 canvas 位图，绝不能挂在纸面容器上。
// ⚠️ 旧实现在 `.pdf-page-block` 上挂 `dark:invert dark:hue-rotate-180`，把
// 文本层 / 标注层 / 锚点一起反色了：深色下 accent 近白（#f4f4f5）被 invert 成近黑，
// 压在被反色的深色纸面上彻底不可见（2026-10-08 实测「夜间看不到波浪线」）。
// 负断言匹配的是**类名出现在 page-block 的 className 里**，不是「CSS 文件里没有
// invert」—— 后者会把合法的 canvas 规则也一起判死。
assert(
  !/className=\{`[^`]*pdf-page-block[^`]*dark:invert/.test(viewer.raw),
  "the PDF page shell must not carry dark:invert; the dark filter belongs on .pdf-page-canvas only."
);
assert(
  /\[data-theme="dark"\][^{]*\.pdf-page-canvas\s*\{[^}]*filter:\s*invert\(1\)\s+hue-rotate\(180deg\)/s.test(viewerCss),
  "the dark-mode inversion must be scoped to the rasterised canvas so overlays keep their theme colours."
);

// ③ 手工波浪线（wavy）必须跟随主题。
// data URI 里的颜色无法令牌化（SVG 内部引用不到外部 CSS 变量），所以做法是
// mask-image 只取 alpha 通道，颜色由 `--annotation-wavy-stroke` 染上。
// 这两条缺一不可：只有颜色令牌没有 mask，深色下仍然是写死的红。
assert(
  viewerCss.includes('mask-image: var(--manual-wavy-image)') &&
    viewerCss.includes("background-color: var(--annotation-wavy-stroke)"),
  "manual wavy annotations must take their colour from the themeable --annotation-wavy-stroke token via a mask."
);
const tokens = view(readFileSync("src/tokens.css", "utf8"));
// ⚠️ 必须匹配「声明」而不是裸名字：`--annotation-wavy-stroke` 在本文件里也出现在
// 注释里（解释 mask 为什么必要），只查 includes 的话把两行声明删光仍然绿。
// 正则是「变量名 + 冒号 + 非空白值」，注释里的「由 --x 经 … 染上」匹配不上。
const declaresToken = (name) => new RegExp(`${name}:\\s*[^\\s;]+`).test(tokens.raw);
assert(
  declaresToken("--annotation-wavy-stroke") && declaresToken("--manual-wavy-image"),
  "tokens.css must actually declare both the wavy stroke colour and its mask image (the only sanctioned colour exemption)."
);

// ④ 每页的伴读波浪线必须按预算截断。
// ⚠️ 只在写入侧把关是不够的：`canAddCompanionMarker` 只数**当下**这一页，
// 而标注跨会话累积在 localStorage 里，`promptedPagesRef` 每次打开文档都重置 ——
// 于是预算 medium=2 的页面能攒到 6+ 条（2026-10-08 实测「全文都是波浪线」）。
// 截断必须在渲染层，而锚点必须取自**截断后**的清单，否则会出现
// 「锚点悬在一段没有波浪线的文字旁边」。
assert(
  companion.includes("export function visibleCompanionMarkersOnPage"),
  "companion markers must be truncated at render time; the write-side budget check alone lets them accumulate."
);
assert(
  viewer.includes("visibleCompanionMarkersOnPage(pageAnnotationItems") &&
    /companionAnchorsOnPage\(pageWavyAnnotations/.test(viewer.raw),
  "companion anchors must derive from the budget-truncated marker list, not the raw annotation list."
);

// ⑤ ★ 每条标注的**跨度**也必须收窄到行级 —— 条数与跨度是两个独立维度。
//
// 2026-10-08 复盘：只做了 ④（截断条数）就宣称修好，用户实测反馈「没变化」。
// 因为存量标注的 rect 是**块级并集框**（PyFuPDF 一个 block 在双栏论文里横跨
// 5–10 个自然段），medium 档截到 2 条之后仍然每条划满一整段，视觉上照样是满页波浪线。
//
// 关键在时序：几何归一化必须排在预算截断**之前**，否则几何无效的标注
// 会先占掉预算名额再被丢弃 —— light 档只有一条名额时，
// 一条画不出来的标注就把唯一能显示的那条挤掉了，屏幕上一条线都没有。
assert(
  companion.includes("export function clampMarkerRectToSentence"),
  "marker rects must be clamped to a whole sentence; the block-level union rect makes one marker cover a whole paragraph, while a single line cuts the sentence in half."
);
// 句子要跨行就得有行级数据，而行级数据只存在于块上 → 必须由调用方接进来。
// v2 的「仅一行，不完全」正是这条没接线的后果。
assert(
  /linesForBlock:[\s\S]*?\.lines/.test(viewer.raw),
  "the renderer must feed line-level bboxes into the marker geometry, otherwise sentences stay truncated to one line."
);

// ⑥ 人工标注覆盖层的 z-index 必须高于 .page-text-overlay 的 9。
// 2026-10-08 实测「只看到波浪线，看不到其他类型划线」：那一层没写 z-index
//（= 0 级）而文本层是 9，highlight/underline/strike/text 全被纸面文字盖住；
// AI 波浪线因为画在文本层内部才幸免 —— 这正是「只有波浪线」这个现象的成因。
assert(
  /zIndex:\s*10,/.test(viewer.raw),
  "the annotation overlay must sit above .page-text-overlay (z-index 9); at the default level it is hidden under the page text."
);
// 反向约束：不能取 11 —— 那会盖过同为 10 的 .page-link-overlay，内部链接点不动。
assert(
  !/zIndex:\s*1[1-9],/.test(viewer.raw),
  "the annotation overlay must not exceed z-index 10; .page-link-overlay is also 10 and links must stay clickable."
);

// 伴读不该盯上页眉页脚页码 —— 那是主动功能最容易被整体关掉的原因。
assert(
  /isNonProseRegion/.test(viewer.raw) && companionDwell.includes("export function isNonProseRegion"),
  "companion triggers must skip headers, footers and page numbers; misfiring on them makes readers disable the whole feature."
);
// 三条触发路径必须共用同一道过滤，否则读者手动点页眉就能绕过自动触发时的闸。
// 期望值 3 = 停留触发（onFire）+ 手动打开（openCompanionForBlock）+ 兜底选块
//（firstCompanionBlockOnPage）。**不要**为了让断言通过而调高这个数字：
// 加一处新的触发路径时就该同步在这里，否则新路径会静默绕过过滤。
//
// ⚠️ 别把它和下面那条「渲染侧兜存量」合并成一个计数：两者性质不同 ——
// 这里是「入口该拦的有没有拦」，那里是「历史数据有没有被画出来」。
// 合成一个数字的话，加了第 4 条触发路径（或删了兜存量接线）都能让另一处顶替它，
// 守卫重新变成绿的，却已经不再覆盖它声称的东西。
const filterUses = (viewer.raw.match(/isNonProseRegion\(/g) || []).length;
assert(
  filterUses === 4,
  `the non-prose filter must guard 3 companion entry points plus the render-side fallback; found ${filterUses}.`
);
// 渲染侧必须真的把判据接到 visibleCompanionMarkersOnPage 上，而不是只把回调
// 写进类型定义 —— 那是最容易「看着接好了」却静默失效的位置。
//
// 用「定位调用起点 → 取一段窗口 → 窗口内必须有回调」而不是「两个字符串挨着」：
// 参数对象里夹着大段注释，挨着匹配等于要求作者不许写注释，改天就又成了假绿。
const markerCallAt = viewer.raw.indexOf("visibleCompanionMarkersOnPage(");
assert(markerCallAt > 0, "visibleCompanionMarkersOnPage must be called to assert its arguments.");
assert(
  viewer.raw.slice(markerCallAt, markerCallAt + 1200).includes("isNonProseBlock:"),
  "visibleCompanionMarkersOnPage must receive isNonProseBlock so legacy header/footer wavy lines stop rendering."
);
// 兜存量必须「查得到块才拦」：判据缺失不等于该拦，误杀一条正文标注比漏放一条
// 页眉标注更难解释（老数据没有 blockId，块卸载时也查不到）。
assert(
  /return block \? isNonProseRegion\(block\) : false;/.test(viewer.raw),
  "the render-side non-prose fallback must not block when the block cannot be resolved."
);

// 模型调用必须前移到停留判定时，并有按块缓存 —— 否则「点开还要等」只是被挪到别处。
assert(
  /requestCompanionSuggestion\(block, \{ silent: true \}\)/.test(viewer.raw),
  "the model call must be warmed up when the dwell fires, not deferred until the reader clicks."
);
assert(
  /suggestionCacheRef/.test(viewer.raw) && /silent\?:\s*boolean|\{ silent \}/.test(viewer.raw),
  "the warmed-up suggestion must be cached per block and requested silently, so opening the bubble reads from cache instead of waiting."
);
// ⚠️ 比较必须限定在 `visibleCompanionMarkersOnPage` **函数体内**。
// 用全文件 indexOf 会命中 `canAddCompanionMarker` 里那处同名预算查表
// （它在另一个函数、位置更靠前），于是顺序断言恒假 —— 守卫自己先坏了。
const truncateStart = companion.indexOf("export function visibleCompanionMarkersOnPage");
assert(truncateStart > 0, "visibleCompanionMarkersOnPage must exist to assert its ordering.");
const truncateBody = companion.slice(truncateStart, truncateStart + 2000);
const normalizeAt = truncateBody.indexOf("annotations.flatMap(");
const budgetAt = truncateBody.indexOf("COMPANION_MARKER_BUDGET[input.intensity]");
assert(
  normalizeAt > 0 && budgetAt > 0 && normalizeAt < budgetAt,
  "geometry normalization must run before the budget truncation; otherwise unrenderable markers still consume the budget."
);
// ⚠️ 必须匹配 `{loading || !firstPagePainted ? (` 这个**完整 JSX 条件**，
// 不能只搜 `loading || !firstPagePainted` —— 上面那段注释里恰好写了同一串字符，
// 而 `view()` 只剥离行注释、保留块注释，于是「遮罩退回只看 loading」也能绿。
assert(
  /\{loading \|\| !firstPagePainted \? \(/.test(viewer.raw),
  "the first-screen mask must stay up until the canvas actually paints; `loading` only covers outline parsing, so the paper goes blank with no feedback."
);
assert(
  pageCanvas.includes("onFirstPagePainted") && /paintGuard = window\.setTimeout/.test(viewer.raw),
  "a painted-page callback plus a timeout fallback are both required; without the fallback a failed render leaves the mask covering the document forever."
);

// ── 伴读锚点：入口必须一直在（2026-10-08 反馈：「找不到锚点了，看不到」）─────
//
// 锚点是伴读唯一的**可见入口**：气泡靠停留或点击才出现，锚点才是那一个
// 一直躺在文字旁边的东西。上一版的问题不是它被删了，而是它「该显示时才显示」——
// hover 离开就没了，于是读者得到「这个功能我找不到」的结论。
//
// 下面三条分别对应三个真实消失路径。
assert(
  viewer.includes("companionAnchorsOnPage(pageWavyAnnotations, pageNo)"),
  "companion anchors must be derived from the budget-truncated wavy list; anchoring to untruncated annotations floats the entry point next to text that has no line."
);
assert(
  /activeMarginCardId === annotation\.id/.test(viewer.raw),
  "an anchor must stay visible while its margin card is open; hiding the entry point on mouse-out turns a menu into something the reader cannot find again."
);
// 气泡打开时锚点还得盖在标注层之上：标注层为了不挡划词整块设了 pointer-events-none，
// 锚点挂在它里面就永远收不到点击（症状同样是「锚点在那里但点不动」）。
assert(
  /data-companion-anchor="true"/.test(viewer.raw),
  "the anchor must be marked so it can be excluded from hit-test sweeps; an unmarked element is indistinguishable from the page body."
);
assert(
  /pointer-events-none[\s\S]{0,900}?\{companionAnchorItems\.map/.test(viewer.raw),
  "the annotation overlay must disable pointer events while anchors sit outside it, otherwise anchors never receive clicks."
);

console.log("reading-assist-contract: ok");
