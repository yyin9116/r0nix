/**
 * PDF 滚动开销探针：把「滚动卡顿」拆成可指着数说的三段，并带归因。
 *
 * 为什么需要它：用户反复报「滚动卡」，而「卡」至少有四种完全不同的来源，
 * 手感一模一样，修法互不相同：
 *   ① 每帧跑了重活（React 重渲染 / 派生计算）      → 优化 JS
 *   ② 每帧被强制同步布局（elementFromPoint / 逐节点 getBoundingClientRect）
 *                                                  → 消除 layout thrash
 *   ③ 每帧要做太重的样式重算 / 绘制（DOM 元素太多、图层太多）→ 减 DOM / 减绘制
 *   ④ 合成/光栅化压力（大 canvas、大面积重绘）      → 减像素
 * 只看「滚起来不跟手」区分不了这四种。这个脚本用 `long-animation-frame`
 * (LoAF, Chromium 123+) 对每帧同时给出：
 *   duration          —— 这一帧整体多长
 *   scriptTime        —— 脚本占用（= renderStart - startTime）
 *   styleLayoutTime   —— 样式重算 + 布局（= styleAndLayoutStart - renderStart）
 *   renderTime        —— 绘制 / 合成（= 帧末尾 - styleAndLayoutStart）
 *   forcedLayout      —— 脚本里【强制同步布局】的累计（layout thrash 的直接证据）
 *   scripts[]         —— 归因到具体函数 + 源文件行号，按耗时排序
 *
 * 用法：node scripts/probe-pdf-scroll-cost.mjs [页码数]   （默认 200，对齐用户场景）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHeavyPdfFixture, createPdfFixture } from "./lib/pdf-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require("playwright-core");

/**
 * 引擎选择 —— 这条**必须**能切到 WebKit。
 *
 * 应用跑在 Tauri 的 WKWebView 里，而 WKWebView 是 WebKit 内核。用 Chromium 量出来的
 * 「60fps 满帧」不能代表 WKWebView：合成器、栅格化线程模型、`content-visibility`
 * 的实现、长列表的样式重算策略都不同。用户报「卡」而 Chromium 量不出卡时，
 * 第一个要排除的就是「这是 Chromium 与 WebKit 的差别」。
 *
 *   PROBE_ENGINE=webkit node scripts/probe-pdf-scroll-cost.mjs 200 heavy
 */
const ENGINE = process.env.PROBE_ENGINE === "webkit" ? "webkit" : "chromium";
/**
 * `PROBE_NO_CV=1`：把页块上的 `content-visibility` 全部按 `!important` 关掉再量。
 *
 * 为什么要这个开关：作者样式表里的 `!important` 能压过行内样式，所以这一条
 * 就能把「页块上的 content-visibility: auto」整体停用，不必改源码。
 * `content-visibility` 在 Chromium 与 WebKit 上的实现差别很大 —— 前者会跳过
 * 离屏子树的布局与绘制，后者在长列表里进出视口时要重做布局。用户报的卡只在
 * WebKit 出现时，第一条要排除的就是它。
 */
const NO_CONTENT_VISIBILITY = process.env.PROBE_NO_CV === "1";
/**
 * `PROBE_HIDE_THUMBS=1`：把侧栏缩略图（`[data-thumbnail-page]`）整体 `display:none`。
 *
 * 为什么要这个开关：轻页与重页夹具（一个 30 行文字无图、一个每页 1600×2200
 * 位图）在 ⑥ 段的慢帧几乎一样（43/360 vs 40/360）—— **页位图不是残余掉帧的来源**。
 * 两个夹具唯一同样重的结构就是侧栏那 **200 个缩略图 canvas**：每个 canvas 都是一个
 * 独立的绘制缓冲，WebKit 在长列表里要为它们管理合成层。这个开关就是用来把
 * 「残余掉帧是不是缩略图 canvas 造成的」一次问清楚：如果关掉后慢帧显著下降，
 * 来源就锁定在缩略图；如果没变，则与缩略图无关。
 */
const HIDE_THUMBS = process.env.PROBE_HIDE_THUMBS === "1";
const PAGE_COUNT = Number(process.argv[2] || 200);
/**
 * `heavy` 夹具：每页一张 1600×2200 的 RGB 位图 + 60 行文字。
 *
 * 为什么必须有它：真实 PDF 的重量在「每页一张位图要解码+缩放+绘制」和
 * 「文本层几百个 span 要建」。
 *
 * ⚠️ 但**不要**再用「轻量夹具满帧、重页才卡」这套推理：本轮实测两边 ⑥ 段慢帧
 * 分别是 43/360 与 40/360，去掉全部位图慢帧一点没降。帧级数字本身方差可达 2~3 倍，
 * 单次运行不可引用（见 /Users/yinyin/workspace/.workbuddy/memory 里「第三批」记录）。
 */
const HEAVY = process.argv[3] === "heavy";
const makeFixture = () => (HEAVY ? createHeavyPdfFixture(PAGE_COUNT) : createPdfFixture(PAGE_COUNT));
// 传了 E2E_BASE_URL 就认为服务已在外部跑着（例如 vite preview 的生产构建），
// 不再自启 dev server —— 否则量到的是 dev 专属开销（jsxDEV / validateProperty /
// warnInvalidARIAProps / assignFiberPropertiesInDEV 全在生产构建里消失）。
const EXTERNAL_SERVER = Boolean(process.env.E2E_BASE_URL);
const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:1420";

function findBrowserExecutable() {
  const candidates = process.platform === "darwin"
    ? [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function waitForServer(url, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(400);
  }
  throw new Error(`dev server never came up at ${url}`);
}

/** 在页面里装 LoAF 采集器 + 帧间隔记录器。必须在应用加载前注入。 */
const INSTALL = () => {
  const w = /** @type {any} */ (window);
  w.__loaf = [];
  w.__frameIntervals = [];
  w.__longTasks = [];

  try {
    const loafObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__loaf.push({
          start: entry.startTime,
          duration: entry.duration,
          renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          blockingDuration: entry.blockingDuration,
          scripts: (entry.scripts || []).map((script) => ({
            name: script.name,
            invoker: script.invoker,
            sourceURL: script.sourceURL,
            sourceFunctionName: script.sourceFunctionName,
            sourceCharPosition: script.sourceCharPosition,
            duration: script.duration,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
            pauseDuration: script.pauseDuration,
          })),
        });
      }
    });
    loafObserver.observe({ type: "long-animation-frame", buffered: true });
  } catch (error) {
    w.__loafError = String(error);
  }

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__longTasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch (error) {
    w.__longTaskError = String(error);
  }

  /**
   * 页帧交换计数：PageCanvas 画完一张整页位图后，用 `context.drawImage(renderCanvas, 0, 0)`
   * 一次性搬到可见画布（原子换帧，见 readerCore 的暂存画布池注释）。
   * 所以「大于 300×300 的目标画布上的一次 drawImage」≈ 「一页刚画完」。
   *
   * 为什么需要它：`pdfjs-dist` 的渲染代价在 LoAF 里只有一行「脚本 45ms」，
   * 没有次数。而「滚动 6 秒画了 40 页」与「画了 4 页」是完全不同的两件事 ——
   * 前者说明渲染没被节流、在滚动期间和输入抢主线程。
   */
  w.__pageSwaps = [];
  try {
    const proto = CanvasRenderingContext2D.prototype;
    const originalDrawImage = proto.drawImage;
    proto.drawImage = function patchedDrawImage(...args) {
      const startedAt = performance.now();
      const result = originalDrawImage.apply(this, args);
      const cost = performance.now() - startedAt;
      const target = this.canvas;
      if (target && target.width >= 300 && target.height >= 300) {
        w.__pageSwaps.push({ at: Number(startedAt.toFixed(1)), ms: Number(cost.toFixed(2)), w: target.width, h: target.height });
      }
      return result;
    };
  } catch (error) {
    w.__pageSwapError = String(error);
  }

  /**
   * 强制同步布局的直接计时 —— 「谁把一帧吃掉了」的最终归因。
   *
   * `elementFromPoint`（命中测试）与 `getBoundingClientRect` 都会让浏览器**立刻**
   * 把待处理的样式与布局算完（flush），代价与文档规模正相关。而滚动期间它们是在
   * 每帧的 rAF 里被调的（`pageNumberAtViewportCenter` 与各处量测），所以「慢帧随
   * 总页数线性增长」如果成立，账就该记在这里。
   *
   * Chromium 的布局是增量的、这些调用很快；WebKit 在超长滚动内容（168k px）上
   * 的 flush 代价完全不同 —— 这正是需要逐调用计时才能分辨的地方。
   */
  w.__hitTests = [];
  try {
    const originalHitTest = Document.prototype.elementFromPoint;
    Document.prototype.elementFromPoint = function patchedHitTest(...args) {
      const startedAt = performance.now();
      const result = originalHitTest.apply(this, args);
      w.__hitTests.push(Number((performance.now() - startedAt).toFixed(3)));
      return result;
    };
  } catch (error) {
    w.__hitTestError = String(error);
  }
  /**
   * 滚动期间的指针事件计数。
   *
   * 这条要验的是一个跨引擎行为差异：**WebKit 会在滚动后补发 `mousemove` /
   * `pointermove`**（鼠标不动，但光标下的内容变了，WebKit 认为指针"换了个对象"），
   * Chromium 不会。如果成立，那么所有挂在 pointermove 上的热路径（本应用是
   * 「悬停高亮当前段落」）在 WebKit 上会变成"每滚一帧跑一次"，而在 Chromium 上
   * 完全静默 —— 这正好能解释「同一份代码 Chromium 满帧、WebKit 掉 23%」。
   */
  w.__pointerMoves = { pointermove: [], mousemove: [] };
  for (const type of ["pointermove", "mousemove"]) {
    window.addEventListener(type, () => { w.__pointerMoves[type].push(performance.now()); }, true);
  }

  /**
   * 数 PageCanvas「波浪线 effect」的执行次数 —— 它就是逐 span 量 rect 的入口
   * （`getPdfTextSpans(textLayer)`）。
   *
   * 零侵入做法：那个 effect 在 DEV 下每次执行都会重写 `window.__r0nixWavyProbe`
   * （见 PageCanvas 的 DEV_PROBE 分支），给它装一个 setter 就能计数，
   * 不必改一行产品代码。计数 = (页 × 执行次数)，配合页数即可反推触发频率。
   */
  w.__wavyProbeWrites = 0;
  let wavyStore;
  try {
    Object.defineProperty(window, "__r0nixWavyProbe", {
      configurable: true,
      get() { return wavyStore; },
      set(value) { wavyStore = value; w.__wavyProbeWrites += 1; },
    });
  } catch (error) {
    w.__wavyProbeError = String(error);
  }

  w.__gbcr = [];
  /**
   * `getBoundingClientRect` 的调用方直方图。
   *
   * 为什么不用 Profiler 的调用栈：CDP 的 CPU profile 里，原生函数的父帧经常是
   * 「没有 URL 的匿名帧」，沿着它往上找不到产品代码 —— 实测就是这样，归因全落空。
   * 而 V8 的 `new Error().stack` 在调用点抓，第一手就是 JS 帧，且带真实文件行号。
   *
   * 采样抓（每 200 次抓一次）：抓栈本身有开销，不能每次都抓，否则量的是探针自己。
   */
  w.__gbcrStacks = {};
  w.__gbcrTargets = {};
  w.__spanMeasureAt = [];
  let gbcrSeen = 0;
  const normalizeFrame = (line) => line
    .trim()
    .replace(/^at\s+/, "")
    .replace(/^.*?\/src\//, "src/")
    .replace(/^.*?\/deps\//, "deps/")
    .replace(/^.*?\/node_modules\//, "node_modules/");
  try {
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function patchedRect() {
      const startedAt = performance.now();
      const result = originalRect.apply(this, arguments);
      w.__gbcr.push(Number((performance.now() - startedAt).toFixed(3)));
      gbcrSeen += 1;
      // 被量的【元素种类】直方图 —— 比函数名更能钉死代码路径：
      // 「量的是 textLayer 里的 span」和「量的是 .pdf-page-block」是两个完全不同的
      // 上游位置，而 dev 构建里函数名/行号都被 Vite 的转换打偏了，不可靠。
      if (w.__gbcr.length <= 6000) {
        const el = this;
        const textLayer = el.closest ? el.closest(".textLayer") : null;
        const page = el.closest ? el.closest("[data-pdf-page]") : null;
        const tag = el.tagName || "?";
        const cls = String(el.className || "").split(" ").filter(Boolean).slice(0, 2).join(".");
        const key = `${tag}${cls ? "." + cls : ""}${textLayer ? " [.textLayer]" : ""}${page ? ` [page${page.dataset.pdfPage}]` : ""}`;
        w.__gbcrTargets[key] = (w.__gbcrTargets[key] || 0) + 1;
        // 记下「量 span」的时间戳：连续两次间隔 <3ms 视为同一次批量（同一次
        // getPdfTextSpans），间隔更大则是新的一次调用。用突发个数反推
        // 「每帧调用几次」，比猜上游触发条件可靠。
        if (textLayer) w.__spanMeasureAt.push(Number(performance.now().toFixed(3)));
      }
      if (gbcrSeen % 200 === 1) {
        const frames = String(new Error().stack || "")
          .split("\n")
          .slice(1, 6)
          .map(normalizeFrame)
          .filter((line) => line && !line.includes("patchedRect"));
        const key = frames.slice(0, 3).join(" | ");
        if (key) w.__gbcrStacks[key] = (w.__gbcrStacks[key] || 0) + 1;
      }
      return result;
    };
  } catch (error) {
    w.__gbcrError = String(error);
  }

  // 帧间隔记录器：rAF 自循环，记录完整一段。
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    w.__frameIntervals.push(Number((now - last).toFixed(2)));
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** DOM 体型统计 —— 200 页全挂载时这是样式重算与绘制的直接输入。 */
const SURVEY = () => {
  const all = document.querySelectorAll("*");
  const pages = document.querySelectorAll("[data-pdf-page]");
  let canvases = 0;
  let canvasPixels = 0;
  for (const canvas of document.querySelectorAll("canvas")) {
    canvases += 1;
    canvasPixels += canvas.width * canvas.height;
  }
  const count = (selector) => document.querySelectorAll(selector).length;
  return {
    totalElements: all.length,
    pages: pages.length,
    canvases,
    canvasMegapixels: Number((canvasPixels / 1e6).toFixed(1)),
    textSpans: count("[data-pdf-page] span"),
    wavySvgs: count("[data-pdf-page] svg"),
    companionCards: count("[data-companion-margin-card]"),
    thumbnails: count("[data-thumbnail-page]"),
    thumbCanvases: count("[data-thumbnail-page] canvas"),
    scrollHeight: Math.round(document.querySelector(".pdf-selection-scope")?.scrollHeight ?? 0),
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
};

/** 数值数组的耗时统计（count/total/max/p95）。用于逐调用计时的钩子。 */
function summarizeDurations(values) {
  if (!values || !values.length) return { count: 0, total: 0, max: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total: Number(total.toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    p95: Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(3)),
  };
}

function summarizeFrames(deltas) {
  if (!deltas || !deltas.length) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  const slow = deltas.filter((value) => value > 24).length;
  return {
    frames: deltas.length,
    p50: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
    slowFrames: slow,
    slowRatio: Number((slow / deltas.length).toFixed(3)),
  };
}

function summarizeLoaf(entries) {
  if (!entries.length) return null;
  const segments = entries.map((entry) => {
    const end = entry.start + entry.duration;
    const scriptEnd = entry.renderStart || end;
    const styleStart = entry.styleAndLayoutStart || scriptEnd;
    return {
      duration: entry.duration,
      script: Math.max(0, scriptEnd - entry.start),
      styleLayout: Math.max(0, styleStart - scriptEnd),
      render: Math.max(0, end - styleStart),
      blocking: entry.blockingDuration,
    };
  });
  const sum = (key) => Number(segments.reduce((total, item) => total + item[key], 0).toFixed(1));
  const avg = (key) => Number((sum(key) / segments.length).toFixed(2));
  const durations = segments.map((item) => item.duration).sort((a, b) => a - b);
  const at = (ratio) => Number(durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))].toFixed(1));

  // 脚本归因：按 duration 与按 forcedStyleAndLayoutDuration 各排一次。
  const flatScripts = [];
  for (const entry of entries) {
    for (const script of entry.scripts || []) flatScripts.push(script);
  }
  const byDuration = [...flatScripts].sort((a, b) => b.duration - a.duration).slice(0, 12);
  const byForced = [...flatScripts].sort((a, b) => b.forcedStyleAndLayoutDuration - a.forcedStyleAndLayoutDuration).slice(0, 12);
  const totalForced = Number(flatScripts.reduce((total, script) => total + (script.forcedStyleAndLayoutDuration || 0), 0).toFixed(1));

  return {
    entries: entries.length,
    durationTotal: sum("duration"),
    durationP50: at(0.5),
    durationP95: at(0.95),
    durationMax: at(1),
    scriptTotal: sum("script"),
    styleLayoutTotal: sum("styleLayout"),
    renderTotal: sum("render"),
    blockingTotal: Number(segments.reduce((total, item) => total + item.blocking, 0).toFixed(1)),
    scriptAvg: avg("script"),
    styleLayoutAvg: avg("styleLayout"),
    renderAvg: avg("render"),
    forcedLayoutTotal: totalForced,
    byDuration,
    byForced,
  };
}

/**
 * CPU 采样剖析的聚合：把 `Profiler.stop` 的原始 profile 变成可读热点表。
 *
 * 为什么要它：LoAF 只告诉我「脚本段 99ms」，但归因到 `performWorkUntilDeadline`
 * 这种 React 内部分发器 —— 还要再猜一层「到底哪个组件/哪个函数」。
 * 采样剖析直接给函数名 + 源文件行号，self（自身）与 inclusive（含子调用）双视角：
 *   self 高  → 这个函数自己慢（重计算）
 *   incl 高  —— 这条调用链整体慢（可能是被调用的子函数慢）
 *   url 是空 → 原生/浏览器内部（如 style recalc、layout、GC）
 */
function summarizeProfile(profile) {
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);

  const selfUs = new Map();
  const inclusiveUs = new Map();
  const SAMPLE_US = 100; // 与 setSamplingInterval 对齐

  for (const id of profile.samples || []) {
    selfUs.set(id, (selfUs.get(id) || 0) + SAMPLE_US);
    // 沿调用栈向上累计 inclusive（去重，栈内同一函数只记一次）
    const seen = new Set();
    let current = byId.get(id);
    while (current) {
      if (!seen.has(current.id)) {
        seen.add(current.id);
        inclusiveUs.set(current.id, (inclusiveUs.get(current.id) || 0) + SAMPLE_US);
      }
      const parentId = current.parent;
      current = parentId !== undefined ? byId.get(parentId) : undefined;
    }
  }

  const describe = (id) => {
    const node = byId.get(id) || {};
    const frame = node.callFrame || {};
    const url = String(frame.url || "");
    const short = url.startsWith("http://127.0.0.1:1420/") ? url.replace("http://127.0.0.1:1420/", "").split("?")[0] : url;
    return {
      id,
      name: frame.functionName || "(anonymous)",
      url: short || "(browser/native)",
      line: (frame.lineNumber ?? -1) + 1,
    };
  };

  const rows = [...selfUs.keys()].map((id) => ({
    ...describe(id),
    self: Number(((selfUs.get(id) || 0) / 1000).toFixed(1)),
    inclusive: Number(((inclusiveUs.get(id) || 0) / 1000).toFixed(1)),
  }));

  const totalUs = (profile.samples || []).length * SAMPLE_US;
  const projectRows = rows.filter((row) => row.url.startsWith("src/") || row.url.startsWith("node_modules"));
  const bySelf = [...rows].sort((a, b) => b.self - a.self).slice(0, 22);
  const byInclusive = [...rows].sort((a, b) => b.inclusive - a.inclusive).slice(0, 22);
  const byProjectSelf = [...projectRows].sort((a, b) => b.self - a.self).slice(0, 22);

  /**
   * 调用方归因：对指定的一组「强制同步布局」原生函数，沿调用栈向上找**第一个
   * 项目代码帧**（src/ 或我们自己写的 ts），统计谁在调、调了多少。
   *
   * 为什么必须做这一步：`getBoundingClientRect` self=55ms 只告诉我"有人在量"，不
   * 告诉我是哪一段产品代码在量 —— 而"哪一段"决定修法（消除这次量测 / 提前量一次
   * 缓存 / 改到 effect 里量）。
   */
  const LAYOUT_READERS = new Set([
    "getBoundingClientRect", "getClientRects", "elementFromPoint", "elementsFromPoint",
    "getComputedStyle", "clientWidth", "clientHeight", "offsetWidth", "offsetHeight", "scrollHeight",
  ]);
  const callers = new Map();
  for (const id of profile.samples || []) {
    const node = byId.get(id);
    if (!node) continue;
    const frame = node.callFrame || {};
    if (!LAYOUT_READERS.has(frame.functionName)) continue;
    // 记「第一个有 URL 的祖先帧」及其上两层：
    //   · 只看 /src/ 会漏掉「调用者是 pdf.js 或 React」这种情况 —— 而那恰恰是最可能
    //     的答案（pdf.js 的文本层 / canvas 层每帧都在量自身几何）；
    //   · 只看一层不够：上层可能是个包装器，真正的人在再见两层之上。
    const chain = [];
    let current = node.parent !== undefined ? byId.get(node.parent) : undefined;
    while (current && chain.length < 3) {
      const callerFrame = current.callFrame || {};
      const callerUrl = String(callerFrame.url || "");
      if (callerUrl) {
        chain.push(
          `${callerFrame.functionName || "(anonymous)"}@${
            callerUrl.includes("/src/") ? callerUrl.replace(/^.*\/src\//, "src/") : callerUrl.replace("http://127.0.0.1:1420/", "")
          }:${(callerFrame.lineNumber ?? -1) + 1}`,
        );
      }
      current = current.parent !== undefined ? byId.get(current.parent) : undefined;
    }
    const key = `${frame.functionName} ← ${chain.length ? chain.join(" ← ") : "(未归因：调用栈里没有带 URL 的帧)"}`;
    callers.set(key, (callers.get(key) || 0) + SAMPLE_US);
  }
  const byCaller = [...callers.entries()]
    .map(([key, us]) => ({ key, ms: Number((us / 1000).toFixed(1)) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 16);

  return {
    totalMs: Number((totalUs / 1000).toFixed(1)),
    samples: (profile.samples || []).length,
    bySelf,
    byInclusive,
    byProjectSelf,
    byCaller,
  };
}

function printProfile(label, summary) {
  console.log(`\n──────── ${label} ────────`);
  if (!summary) {
    console.log("  无剖析数据");
    return;
  }
  console.log(`  采样 ${summary.samples} 次（0.1ms/次），累计 ${summary.totalMs}ms`);
  console.log("  按【自身耗时 self】top：");
  for (const row of summary.bySelf) {
    if (row.self < 1) break;
    console.log(`    self=${String(row.self).padStart(8)}ms  incl=${String(row.inclusive).padStart(8)}ms  ${row.name}  @${row.url}:${row.line}`);
  }
  console.log("  按【项目内自身耗时】top：");
  for (const row of summary.byProjectSelf) {
    if (row.self < 1) break;
    console.log(`    self=${String(row.self).padStart(8)}ms  incl=${String(row.inclusive).padStart(8)}ms  ${row.name}  @${row.url}:${row.line}`);
  }
  console.log("  按【含子调用 inclusive】top：");
  for (const row of summary.byInclusive) {
    if (row.inclusive < 1) break;
    console.log(`    incl=${String(row.inclusive).padStart(8)}ms  self=${String(row.self).padStart(8)}ms  ${row.name}  @${row.url}:${row.line}`);
  }
  if (summary.byCaller?.length) {
    console.log("  ★【强制同步布局】调用方归因（谁在量 DOM）：");
    for (const row of summary.byCaller) {
      console.log(`    ${String(row.ms).padStart(8)}ms  ${row.key}`);
    }
  }
}

function printLoaf(label, info) {
  console.log(`\n──────── ${label} ────────`);
  if (!info) {
    console.log("  无 LoAF 条目（该段没有 >50ms 的帧）");
    return;
  }
  console.log(`  长帧数=${info.entries}  帧时长 总=${info.durationTotal}ms p50=${info.durationP50} p95=${info.durationP95} max=${info.durationMax}`);
  console.log(`  三段合计: 脚本=${info.scriptTotal}ms  样式+布局=${info.styleLayoutTotal}ms  绘制=${info.renderTotal}ms  （阻塞合计=${info.blockingTotal}ms）`);
  console.log(`  三段均值: 脚本=${info.scriptAvg}ms  样式+布局=${info.styleLayoutAvg}ms  绘制=${info.renderAvg}ms`);
  console.log(`  ★ 脚本内【强制同步布局】合计=${info.forcedLayoutTotal}ms`);
  if (info.byDuration.length) {
    console.log("  按脚本耗时 top:");
    for (const script of info.byDuration) {
      console.log(`    ${String(script.duration.toFixed(1)).padStart(7)}ms  强制布局=${String((script.forcedStyleAndLayoutDuration || 0).toFixed(1)).padStart(6)}ms  ${script.sourceFunctionName || script.name || "?"}  @${String(script.sourceURL).split("/").slice(-2).join("/")}`);
    }
  }
  const forcedLeaders = info.byForced.filter((script) => (script.forcedStyleAndLayoutDuration || 0) > 0.5);
  if (forcedLeaders.length) {
    console.log("  按【强制同步布局】top（layout thrash 的元凶）:");
    for (const script of forcedLeaders) {
      console.log(`    强制布局=${String((script.forcedStyleAndLayoutDuration || 0).toFixed(1)).padStart(7)}ms  脚本=${String(script.duration.toFixed(1)).padStart(7)}ms  ${script.sourceFunctionName || script.name || "?"}  @${String(script.sourceURL).split("/").slice(-2).join("/")}`);
    }
  }
}

async function main() {
  const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const server = EXTERNAL_SERVER
    ? null
    : spawn(serverCommand, ["run", "dev", "--", "--host", "127.0.0.1"], { stdio: "ignore", detached: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "r0nix-scroll-probe-"));
  let context = null;
  let browser = null;
  console.log(`\n目标：${baseUrl}${EXTERNAL_SERVER ? "（外部服务 / 生产构建）" : "（探针自启 dev server）"}`);
  console.log(`引擎：${ENGINE}${ENGINE === "webkit" ? "（对齐 Tauri 的 WKWebView 内核）" : ""}`);
  try {
    await waitForServer(baseUrl);
    if (ENGINE === "webkit") {
      // WebKit 在 Playwright 里不支持 launchPersistentContext，用 launch + newContext
      // 等价替代（本探针不需要持久化 profile）。
      browser = await webkit.launch({ headless: false });
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    } else {
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: findBrowserExecutable(),
        headless: false,
        viewport: { width: 1440, height: 900 },
        args: ["--no-first-run"],
      });
      browser = context.browser();
    }
    const page = await context.newPage();
    await page.addInitScript(INSTALL);
    page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
    // 页面里的失败请求会成百上千条（浏览器本地模式下图像检测必失败），
    // 全打出来会把探针自己的报告淹掉 —— 只看前 4 条，够确认「有这条路」即可。
    let consoleBudget = 4;
    page.on("console", (message) => {
      if (consoleBudget <= 0) return;
      if (message.type() === "error" || message.type() === "warning") {
        consoleBudget -= 1;
        console.log(`[console.${message.type()}] ${message.text().slice(0, 200)}`);
      }
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    if (NO_CONTENT_VISIBILITY) {
      await page.addStyleTag({ content: "*, *::before, *::after { content-visibility: visible !important; }" });
      console.log("（PROBE_NO_CV=1：已按 !important 停用全部 content-visibility）");
    }
    if (HIDE_THUMBS) {
      await page.addStyleTag({ content: "[data-thumbnail-page] { display: none !important; }" });
      console.log("（PROBE_HIDE_THUMBS=1：已把侧栏缩略图整体 display:none）");
    }
    await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await chooserPromise).setFiles({
      name: `scroll-cost-${HEAVY ? "heavy-" : ""}${PAGE_COUNT}p.pdf`,
      mimeType: "application/pdf",
      buffer: makeFixture(),
    });

    await page.locator("[data-pdf-page] canvas.pdf-page-canvas").first().waitFor({ state: "attached", timeout: 90_000 });
    await delay(4000);
    console.log(`\n════════ 夹具：${PAGE_COUNT} 页${HEAVY ? "（重页：每页 1600×2200 位图 + 60 行文字）" : "（轻量：30 行文字、无图）"} ════════`);

    // 0) 静置基线
    await page.evaluate(() => { window.__loaf.length = 0; window.__frameIntervals.length = 0; window.__longTasks.length = 0; });
    await delay(2500);
    const idle = await page.evaluate(() => ({ loaf: window.__loaf.length, frames: [...window.__frameIntervals] }));
    console.log(`\n──────── ⓪ 静置 2.5s（无滚动） ────────`);
    console.log(`  长帧=${idle.loaf}  帧间隔 p50=${summarizeFrames(idle.frames)?.p50}ms`);

    const survey = await page.evaluate(SURVEY);
    console.log(`\n──────── ① DOM 体型 ────────`);
    console.log(`  元素总数=${survey.totalElements}  页块=${survey.pages}  canvas=${survey.canvases}（合计 ${survey.canvasMegapixels} MP）`);
    console.log(`  文本层 span=${survey.textSpans}  波浪线 svg=${survey.wavySvgs}  批注卡=${survey.companionCards}`);
    console.log(`  缩略图=${survey.thumbnails}（画布 ${survey.thumbCanvases}）  滚动高度=${survey.scrollHeight}px  视口=${survey.viewport.w}x${survey.viewport.h}`);

    // ② 程序化帧锁定滚动（基线）：每帧 +60px，帧间隔可比
    const { deltas, loaf, longTasks } = await page.evaluate(async ({ steps, step }) => {
      const root = document.querySelector(".pdf-selection-scope");
      if (!root) return { deltas: null, loaf: [], longTasks: [] };
      root.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 600));
      window.__loaf.length = 0;
      window.__longTasks.length = 0;
      const out = [];
      let last = performance.now();
      for (let index = 0; index < steps; index += 1) {
        root.scrollTop += step;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        out.push(Number((now - last).toFixed(2)));
        last = now;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { deltas: out, loaf: [...window.__loaf], longTasks: [...window.__longTasks] };
    }, { steps: 200, step: 60 });

    const frameSummary = summarizeFrames(deltas);
    console.log(`\n──────── ② 程序化滚动 200 帧（每帧 +60px） ────────`);
    console.log(`  帧间隔 p50=${frameSummary?.p50}ms  p95=${frameSummary?.p95}ms  max=${frameSummary?.max}ms  超过 24ms 的帧=${frameSummary?.slowFrames}/${frameSummary?.frames}（${frameSummary?.slowRatio}）`);
    console.log(`  长任务（>50ms）=${longTasks.length}  合计=${longTasks.reduce((total, item) => total + item.duration, 0).toFixed(1)}ms`);
    printLoaf("② 滚动期间的 LoAF 归因", summarizeLoaf(loaf));

    // ③ 真实滚轮输入路径（合成事件，等同用户手势）
    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (root) root.scrollTop = 0;
    });
    await delay(700);
    await page.evaluate(() => { window.__loaf.length = 0; window.__longTasks.length = 0; window.__frameIntervals.length = 0; });
    await page.mouse.move(720, 450);
    for (let index = 0; index < 60; index += 1) {
      await page.mouse.wheel(0, 120);
      await delay(16);
    }
    await delay(600);
    const wheelState = await page.evaluate(() => ({
      loaf: [...window.__loaf],
      longTasks: [...window.__longTasks],
      frames: [...window.__frameIntervals],
      scrollTop: Math.round(document.querySelector(".pdf-selection-scope")?.scrollTop ?? 0),
    }));
    const wheelFrames = summarizeFrames(wheelState.frames);
    console.log(`\n──────── ③ 真实滚轮 60 次（每次 120px，含合成开销） ────────`);
    console.log(`  滚动到 top=${wheelState.scrollTop}  帧间隔 p50=${wheelFrames?.p50}ms  p95=${wheelFrames?.p95}ms  max=${wheelFrames?.max}ms  超过 24ms 的帧=${wheelFrames?.slowFrames}/${wheelFrames?.frames}`);
    console.log(`  长任务=${wheelState.longTasks.length}  合计=${wheelState.longTasks.reduce((total, item) => total + item.duration, 0).toFixed(1)}ms`);
    printLoaf("③ 滚轮期间的 LoAF 归因", summarizeLoaf(wheelState.loaf));

    // ④ 深处滚动（活跃页集合之外的区域）—— 检查是否退化
    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      const node = document.querySelector(`[data-pdf-page="${Math.round(Number(document.querySelectorAll("[data-pdf-page]").length) / 2)}"]`);
      if (root && node) {
        const rootRect = root.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        root.scrollTop += nodeRect.top - rootRect.top - 12;
      }
      window.__loaf.length = 0;
      window.__longTasks.length = 0;
    });
    await delay(1200);
    const deep = await page.evaluate(async ({ steps, step }) => {
      const root = document.querySelector(".pdf-selection-scope");
      window.__loaf.length = 0;
      window.__longTasks.length = 0;
      const out = [];
      let last = performance.now();
      for (let index = 0; index < steps; index += 1) {
        root.scrollTop += step;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        out.push(Number((now - last).toFixed(2)));
        last = now;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { deltas: out, loaf: [...window.__loaf], longTasks: [...window.__longTasks] };
    }, { steps: 120, step: 60 });
    const deepFrames = summarizeFrames(deep.deltas);
    console.log(`\n──────── ④ 深处（文档中段）滚动 120 帧 ────────`);
    console.log(`  帧间隔 p50=${deepFrames?.p50}ms  p95=${deepFrames?.p95}ms  max=${deepFrames?.max}ms  超过 24ms 的帧=${deepFrames?.slowFrames}/${deepFrames?.frames}`);
    console.log(`  长任务=${deep.longTasks.length}  合计=${deep.longTasks.reduce((total, item) => total + item.duration, 0).toFixed(1)}ms`);
    printLoaf("④ 深处滚动 LoAF 归因", summarizeLoaf(deep.loaf));

    // ⑤ 冷启动段：重新开一份，**从 0 秒就开始滚** —— 覆盖整个缩略图加载期。
    //    用户描述的就是这个窗口（「缩略图逐渐加载」+「滑动卡」同时发生）。
    console.log(`\n\n════════ ⑤ 冷启动：打开即滚（缩略图仍在加载） ════════`);
    await page.evaluate(() => { window.__loaf.length = 0; window.__longTasks.length = 0; });
    const coldChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await coldChooser).setFiles({
      name: `scroll-cost-cold-${HEAVY ? "heavy-" : ""}${PAGE_COUNT}p.pdf`,
      mimeType: "application/pdf",
      buffer: makeFixture(),
    });

    // 不等任何东西：setFiles 一返回就进滚动循环，让缩略图加载与滚动重叠。
    const cold = await page.evaluate(async ({ steps, step, bucketMs }) => {
      const root = document.querySelector(".pdf-selection-scope");
      if (!root) return { buckets: [], loaf: [], frames: [], thumbnails: 0 };
      window.__loaf.length = 0;
      window.__longTasks.length = 0;
      const started = performance.now();
      const deltas = [];
      const times = [];
      let last = performance.now();
      for (let index = 0; index < steps; index += 1) {
        root.scrollTop += step;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        deltas.push(now - last);
        times.push(now - started);
        last = now;
      }
      // 分桶汇总（默认每 2s 一桶）
      const buckets = [];
      let bucketStart = 0;
      for (let index = 0; index < deltas.length; index += 1) {
        const bucketIndex = Math.floor(times[index] / bucketMs);
        while (buckets.length <= bucketIndex) buckets.push({ from: buckets.length * bucketMs, values: [] });
        buckets[bucketIndex].values.push(deltas[index]);
      }
      const thumbnails = document.querySelectorAll("[data-thumbnail-page] canvas").length;
      return {
        buckets: buckets.map((bucket) => {
          const sorted = [...bucket.values].sort((a, b) => a - b);
          const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
          return {
            from: bucket.from,
            frames: bucket.values.length,
            p50: Number(at(0.5).toFixed(1)),
            p95: Number(at(0.95).toFixed(1)),
            max: Number(sorted[sorted.length - 1].toFixed(1)),
            slow: bucket.values.filter((value) => value > 24).length,
          };
        }),
        loaf: [...window.__loaf],
        longTasks: [...window.__longTasks],
        frames: deltas,
        thumbnails,
      };
    }, { steps: 700, step: 40, bucketMs: 2000 });

    console.log("  分桶帧间隔（每 2s 一桶；「慢帧」= >24ms）:");
    for (const bucket of cold.buckets) {
      // 桶从 0 起算，但先等 DOM 结构就绪需要一点时间；空桶跳过。
      if (!bucket.frames) continue;
      const bar = "█".repeat(Math.min(40, bucket.slow));
      console.log(`    t=${(bucket.from / 1000).toFixed(1)}s 帧数=${String(bucket.frames).padStart(4)} p50=${String(bucket.p50).padStart(5)}ms p95=${String(bucket.p95).padStart(6)}ms max=${String(bucket.max).padStart(6)}ms 慢帧=${String(bucket.slow).padStart(3)} ${bar}`);
    }
    const coldFrames = summarizeFrames(cold.frames);
    console.log(`  整段: 帧数=${coldFrames?.frames} p50=${coldFrames?.p50}ms p95=${coldFrames?.p95}ms max=${coldFrames?.max}ms 慢帧=${coldFrames?.slowFrames}（${coldFrames?.slowRatio}）  缩略图画布=${cold.thumbnails}`);
    console.log(`  长任务（>50ms）=${cold.longTasks.length}  合计=${cold.longTasks.reduce((total, item) => total + item.duration, 0).toFixed(1)}ms`);
    printLoaf("⑤ 冷启动 LoAF 归因", summarizeLoaf(cold.loaf));

    // ⑥ 滚动 + 归因：把「脚本段」再往下钻到函数级。
    //    WebKit 没有 CDP，拿不到 Profiler —— 这一段的帧间隔 / 页帧交换 / 长任务仍然量，
    //    只是不给函数级归因。这几个量本身跨引擎可比，函数归因才是 Chromium 独有。
    console.log(`\n\n════════ ⑥ 连续滚动 6s（函数级归因${ENGINE === "webkit" ? "不可用：WebKit 无 CDP" : ""}） ════════`);
    const client = ENGINE === "webkit" ? null : await context.newCDPSession(page);
    if (client) {
      await client.send("Profiler.enable");
      await client.send("Profiler.setSamplingInterval", { interval: 100 });
    }
    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (root) {
        root.scrollTop = 0;
        window.__loaf.length = 0;
        window.__longTasks.length = 0;
        window.__pageSwaps.length = 0;
        window.__hitTests.length = 0;
        window.__gbcr.length = 0;
        window.__gbcrStacks = {};
        window.__gbcrTargets = {};
        window.__spanMeasureAt = [];
        window.__wavyProbeWrites = 0;
        window.__pointerMoves = { pointermove: [], mousemove: [] };
      }
    });
    await delay(700);
    if (client) await client.send("Profiler.start");
    const profileScroll = await page.evaluate(async ({ steps, step }) => {
      const root = document.querySelector(".pdf-selection-scope");
      if (!root) return null;
      window.__pageSwaps.length = 0;
      const deltas = [];
      let last = performance.now();
      for (let index = 0; index < steps; index += 1) {
        root.scrollTop += step;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        deltas.push(Number((now - last).toFixed(2)));
        last = now;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        deltas,
        loaf: [...window.__loaf],
        longTasks: [...window.__longTasks],
        pageSwaps: [...window.__pageSwaps],
        hitTests: [...window.__hitTests],
        gbcr: [...window.__gbcr],
        gbcrStacks: { ...window.__gbcrStacks },
        gbcrTargets: { ...window.__gbcrTargets },
        spanMeasureAt: [...window.__spanMeasureAt],
        wavyProbeWrites: window.__wavyProbeWrites,
        pointerMoves: { pointermove: window.__pointerMoves.pointermove.length, mousemove: window.__pointerMoves.mousemove.length },
        scrollTop: Math.round(root.scrollTop),
      };
    }, { steps: 360, step: 40 });
    const profile = client ? (await client.send("Profiler.stop")).profile : null;
    const profileFrames = summarizeFrames(profileScroll?.deltas);
    console.log(`  整段 360 帧: p50=${profileFrames?.p50}ms p95=${profileFrames?.p95}ms max=${profileFrames?.max}ms 慢帧=${profileFrames?.slowFrames}/${profileFrames?.frames}（${profileFrames?.slowRatio}）  滚到 top=${profileScroll?.scrollTop}`);
    console.log(`  长任务=${profileScroll?.longTasks.length}  合计=${profileScroll?.longTasks.reduce((total, item) => total + item.duration, 0).toFixed(1)}ms`);
    const swaps = profileScroll?.pageSwaps || [];
    console.log(`  ★ 页帧交换（= 滚动期间画完的页数）: ${swaps.length} 次  合计 drawImage=${swaps.reduce((total, item) => total + item.ms, 0).toFixed(1)}ms  最慢单次=${swaps.length ? Math.max(...swaps.map((item) => item.ms)).toFixed(2) : 0}ms`);
    if (swaps.length) {
      // 每次交换的时间点，看它们是否密集扎堆（扎堆 = 并发渲染抢主线程）
      const span = swaps[swaps.length - 1].at - swaps[0].at;
      console.log(`  交换分布: 跨度=${span.toFixed(0)}ms  平均间隔=${(span / Math.max(1, swaps.length - 1)).toFixed(0)}ms`);
    }
    const hit = summarizeDurations(profileScroll?.hitTests);
    const rect = summarizeDurations(profileScroll?.gbcr);
    console.log(`  ★ 强制同步布局逐调用计时:`);
    console.log(`    elementFromPoint: ${hit.count} 次  合计=${hit.total}ms  单次 p95=${hit.p95}ms  最慢=${hit.max}ms`);
    console.log(`    getBoundingClientRect: ${rect.count} 次  合计=${rect.total}ms  单次 p95=${rect.p95}ms  最慢=${rect.max}ms`);
    const targetRows = Object.entries(profileScroll?.gbcrTargets || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (targetRows.length) {
      console.log(`  ★ getBoundingClientRect 被量的元素（次数 top）:`);
      for (const [key, count] of targetRows) console.log(`      ${String(count).padStart(6)}×  ${key}`);
    }
    console.log(`  ★ PageCanvas 波浪线 effect 执行次数（= 逐 span 量 rect 的入口）: ${profileScroll?.wavyProbeWrites ?? 0} 次 / 6s（滚过约 17 页）`);
    const stamps = profileScroll?.spanMeasureAt || [];
    if (stamps.length) {
      let bursts = 1;
      for (let index = 1; index < stamps.length; index += 1) {
        if (stamps[index] - stamps[index - 1] > 3) bursts += 1;
      }
      const span = (stamps[stamps.length - 1] - stamps[0]) / 1000;
      console.log(`  ★ 「量文本层 span」的批量次数 ≈ ${bursts} 次 / ${span.toFixed(1)}s = ${(bursts / Math.max(0.001, span)).toFixed(1)} 次/秒（每次批量内 ${(stamps.length / bursts).toFixed(1)} 个 span）`);
    }
    const stackRows = Object.entries(profileScroll?.gbcrStacks || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (stackRows.length) {
      console.log(`  ★ getBoundingClientRect 调用方（采样抓栈，共 ${stackRows.reduce((n, [, c]) => n + c, 0)} 个采样）:`);
      for (const [key, count] of stackRows) console.log(`      ${String(count).padStart(4)}×  ${key}`);
    }
    console.log(`  ★ 滚动期间的指针事件: pointermove=${profileScroll?.pointerMoves?.pointermove ?? 0} 次  mousemove=${profileScroll?.pointerMoves?.mousemove ?? 0} 次（鼠标全程未动，360 帧）`);
    printLoaf("⑥ 滚动 LoAF 归因", summarizeLoaf(profileScroll?.loaf || []));
    if (profile) printProfile("⑥ 滚动期间的 CPU 热点", summarizeProfile(profile));
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    try {
      if (server) process.kill(-server.pid, "SIGTERM");
    } catch {
      // server already gone
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("probe-pdf-scroll-cost failed:", error);
  process.exitCode = 1;
});
