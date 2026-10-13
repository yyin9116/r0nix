/**
 * app-shell-contract
 * ---------------------------------------------------------------------------
 * 钉住**启动那一刻到主界面就位**这段外壳上的三条行为，以及右下角 toast 的 i18n 接线。
 *
 * 共同点：它们全都不影响任何业务功能，tsc 与既有断言一律看不见，但用户第一眼
 * 就会看到 —— 属于「测试全绿但产品是坏的」那一类，所以值得单独一份守卫。
 *
 * ① 启动屏不许声明 webfont。
 *   splash 是自包含的内联样式，而 `Inter` / `Noto Sans SC` 由 index.css 的
 *   Google Fonts `@import` 异步拉取 —— 首帧一定还没到。声明它们的后果是：
 *   先按 fallback 排一版，字体到位后重排一次，表现为「加载页上的字变了一次」
 *   （2026-10-08 实测，在版本号那行最明显）。系统字体栈第一帧就是最终形态。
 *
 * ② 侧边栏默认展开。
 *   默认折叠时，首屏是一张没有目录的纸 —— 而目录是这个阅读器里唯一的导航。
 *
 * ③ toast 文案不许硬编码。
 *   右下角提示走的是 `updateBusyMessage`，它不接受语言参数，所以文案得自带。
 *   旧实现把 "opening pdf" 直接写进调用点（2026-10-08 实测：中文界面右下角
 *   冒出英文）。现在统一从 services/appToasts.ts 按语言取值。
 *
 * ★ 匹配一律避开注释：本文件大量注释正是在解释这些约束，`view()` 不剥注释，
 *   裸 includes 会把「不要写死文案」这句话本身当成违规。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./lib/source-view.mjs";

const html = stripComments(readFileSync("index.html", "utf8"));
const mainRaw = readFileSync("src/main.tsx", "utf8");
const main = stripComments(mainRaw);
const appRaw = readFileSync("src/App.tsx", "utf8");
const app = stripComments(appRaw);
const toastsRaw = readFileSync("src/services/appToasts.ts", "utf8");
const toasts = stripComments(toastsRaw);

// ── ① 启动屏字体 ──
// 只查 splash 作用域（<style> 内、以 .splash 开头的规则），
// 否则 App 自己的 webfont 声明会被误判成启动屏声明。
const splashCss = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
const splashFontRules = [...splashCss.matchAll(/font-family\s*:([^;}]+)/g)].map((m) => m[1]);
assert(splashFontRules.length > 0, "index.html must declare a font-family for the splash screen.");
for (const value of splashFontRules) {
  assert(
    !/\bInter\b/.test(value) && !/Noto Sans SC/.test(value),
    `the splash screen must not name a webfont: found "${value.trim()}". Async @imported fonts always miss the first frame, so naming them forces a reflow (font "changes" once on the version line).`
  );
}
// 兜底栈必须真的落在系统字体上，否则「不声明 webfont」只是换一种坏法。
assert(
  splashFontRules.some((value) => /system-ui|-apple-system|BlinkMacSystemFont/.test(value)),
  "the splash screen must fall back to a system font stack."
);

// 淡出必须等字体就绪，否则「字体到位」与「启动屏消失」会撞在同一帧 ——
// 症状是版本号那行字在消失过程中换了一次脸。
//
// ⚠️ 这里必须匹配**链式调用**（`document.fonts.ready` 后面跟着 `.catch(...).then(...)`），
// 不能只查 `includes("document.fonts")`：守卫里出现了 `document.fonts?.ready` 这个
// 能力探测（main.tsx 确实需要它兜底极老环境），只查名字的话把 `.ready` 换成
// `Promise.resolve()` 照样绿 —— 实测过。把等待换掉而留着探测，是最容易发生的退化。
assert(
  /document\.fonts\.ready\s*\n?\s*\.catch\([\s\S]{0,120}?\)\s*\n?\s*\.then\(/.test(main),
  "main.tsx must await document.fonts.ready (and keep the offline fallback timer) before fading the splash screen."
);
// ⚠️ 只查常量**存在**是不够的：把它改成 0 一样绿，而那正好等于「不等」。
// 所以断言的是「缓冲时长为正」，不是「有个叫这名字的东西」。
const graceMs = Number(main.match(/SPLASH_FONTS_GRACE_MS\s*=\s*(\d+)/)?.[1]);
assert(
  Number.isFinite(graceMs) && graceMs > 0,
  `the splash font grace period must be a positive delay (current ${graceMs}); document.fonts.ready resolves before webfonts have actually swapped, so a zero buffer reintroduces the flash.`
);

// 版本号只有一个来源：Vite 的 %APP_VERSION% 占位符。
// 兜底式写入（仅当占位符没被替换时才写）是允许的，但不允许出现第二个硬编码版本串。
const versionLiterals = (main.match(/["'`]\d+\.\d+\.\d+[^"'`]*["'`]/g) || []).filter(
  (value) => !value.includes("%")
);
assert(
  versionLiterals.length === 0,
  `the app version must come from a single source (Vite's %APP_VERSION%); found literal(s): ${versionLiterals.join(", ")}`
);

// ── ② 侧边栏默认展开 ──
// 匹配 state 声明本身，而不是裸 `useState(true)` —— 后者在文件里有一百处。
assert(
  /const\s+\[isSidebarOpen\s*,\s*setIsSidebarOpen\]\s*=\s*useState\(true\)/.test(app),
  "the workspace sidebar must be expanded by default; a reader landing on a navigation-less page has no way to move."
);

// ── ③ toast 文案 i18n ──
assert(
  toasts.includes("export function getAppToasts"),
  "toast copy must come from services/appToasts.ts so it can be resolved per language."
);
// 中英两套都要齐。缺一侧 = 切到那种语言时 fallback 到另一侧，正是原来的 bug。
for (const locale of ["ZH_CN", "EN_US"]) {
  assert(
    new RegExp(`const ${locale}\\b`).test(toasts),
    `services/appToasts.ts must define a ${locale} table; a missing side silently falls back to the other language.`
  );
}
// 调用点：updateBusyMessage 的第一个实参必须是查表结果，不能是字面量。
// 逐个调用点检查实参形态 —— 只查「文件里出现了 toasts.」会漏掉绝大多数硬编码。
// 正则带 `s` 标志：`updateBusyMessage(\n  cond ? … : …)` 这种换行排版很常见，
// 不跨行匹配会把它们抓成「空字符串实参」的假阳性。
const busyCalls = [...app.matchAll(/updateBusyMessage\(\s*([\s\S]*?)\s*[,)]/g)].map((m) => m[1].trim());
assert(busyCalls.length > 0, "App.tsx must still drive the busy toast through updateBusyMessage.");
// ⚠️ 空串是**控制指令**不是文案：`updateBusyMessage("", 120)` 表示「立刻把正在
// 显示的提示撤掉」（打开流程里先清场，再由下一条正式提示接手）。它没有要翻译的
// 文本，不该被这条守卫当成 i18n 缺失 —— 实测 4 处，全部是这一种用法。
const isClearCall = (arg) => /^["'`]\s*["'`]$/.test(arg);
const hardcoded = busyCalls.filter((arg) => /^["'`]/.test(arg) && !isClearCall(arg));
assert(
  hardcoded.length === 0,
  `every updateBusyMessage argument must be looked up per language; found hardcoded: ${hardcoded.join(", ")}`
);
// 反向自查：清场指令必须还在 —— 它是打开流程的竞态防线，删掉会留下上一份文档的残影。
assert(
  busyCalls.some(isClearCall),
  "the busy toast must keep its clear instruction (updateBusyMessage(\"\", …)); without it the previous document's message lingers on screen."
);
// 曾经的漏网之鱼，逐个点名钉住：这几个键任何一个被删掉都会让调用点编译失败，
// 但如果有人把调用点一起改成字面量，上面那条会红 —— 两者缺一不可。
const namedKeys = ["openingPdf", "openingMarkdown", "downloadingPdfFromUrl", "importedDocuments"];
for (const key of namedKeys) {
  assert(toasts.includes(`${key}:`), `appToasts must define the "${key}" copy (the i18n gap reported on 2026-10-08).`);
}
// ★ 两侧必须真的不同。只查「两个表都在」不够 —— 把 EN_US 的值直接复制一份中文
//   就能骗过上面所有断言，而那正是这个 bug 的形态（英文界面里混进中文，反之亦然）。
//   逐键比对：同名键在两个表里的取值只要有一个相同，就是漏翻的证据
//   （标点/数字构成的短文案天然相同，用长度门槛把它们排除在判定之外）。
function localeValues(locale) {
  const start = toasts.indexOf(`const ${locale}`);
  assert(start >= 0, `appToasts must define a ${locale} table.`);
  const rest = toasts.slice(start + `const ${locale}`.length);
  const end = rest.search(/\nconst\s|\nfunction\s|\nexport\s/);
  return rest.slice(0, end < 0 ? rest.length : end);
}
const zhValues = localeValues("ZH_CN");
const enValues = localeValues("EN_US");
const untranslated = [];
for (const match of zhValues.matchAll(/^\s*(\w+):\s*"([^"]*)",?\s*$/gm)) {
  const [, key, zhText] = match;
  if (/^[\d\s.:%/()-]+$/.test(zhText)) continue; // 纯数字/符号，两侧本就相同
  const enMatch = new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, "m").exec(enValues);
  if (!enMatch) {
    untranslated.push(`${key} (missing in EN_US)`);
  } else if (enMatch[1] === zhText) {
    untranslated.push(`${key} ("${zhText}")`);
  }
}
assert(
  untranslated.length === 0,
  `every ZH_CN toast must have a distinct EN_US counterpart; untranslated: ${untranslated.join(", ")}`
);
// 参数化文案必须是函数式模板，不能是 replace 拼接 —— 后者在文案含 {fileName} 时
// 会漏替换，且拼不出来的中间态会闪一下。
assert(
  toasts.includes("interpolate") && toasts.includes("export function getAppToasts"),
  "parameterised toast copy must use the typed template helper rather than string replace."
);
// 切换语言后必须重算：字典挂在 useMemo 上，依赖 language。
assert(
  /useMemo\(\(\)\s*=>\s*getAppToasts\(settings\.language\),\s*\[settings\.language\]\)/.test(app),
  "the toast dictionary must be recomputed from settings.language so a language switch takes effect immediately."
);

console.log("app-shell-contract: ok");