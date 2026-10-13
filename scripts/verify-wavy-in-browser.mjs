/**
 * 浏览器里的视觉验证：波浪线是否真的贴着每行文字、跨行是否连续。
 *
 * 为什么必须真浏览器：整套修复依赖两件只有布局引擎能证明的事 ——
 * 1. 切出来的 `.appended` 片段确实是**行内流式**的（`position: initial` 生效，
 *    没有被 `.textLayer span { position: absolute }` 带走）；
 * 2. `text-decoration: underline wavy` 画在**每一行自己的基线**上，
 *    而不是像旧的覆盖 div 那样贴在段落矩形底部。
 *
 * 这两点都不是纯函数能验的，所以这里起一个 vite dev server，
 * 在真 Chrome 里加载**真实的 pdf.js + 生产代码里的 TextLayerMarker**，
 * 把三段文本渲染出来，再量每段的下划线几何，最后截图。
 *
 * ## 为什么不挂进 `test:fixtures`
 *
 * 它需要本机装有 Google Chrome（`channel: "chrome"`），CI 上没有。
 * 挂进去等于让常规测试在 CI 上必红，而红的原因与代码质量无关。
 * 所以它是**手动 / 发版前**跑的那一档：`npm run test:wavy-visual`。
 *
 * 几何层的那部分（段落切分）已经在 `test:fixtures` 里，由
 * `verify-text-layer-geometry.mjs` 用真实 pdf.js + 真实 pymupdf 覆盖 ——
 * 那部分无浏览器依赖。两者分工：这里验「CSS 与布局」，那里验「切段算法」。
 *
 * 产出：/tmp/marker-check/verify-wavy.png
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const PDF_PATH = "/tmp/marker-check/three-paras.pdf";
const OUT_PNG = "/tmp/marker-check/verify-wavy.png";
const PORT = 1433;

if (!existsSync(PDF_PATH)) {
  console.error("缺少夹具，先跑：npm run fixture:geometry");
  process.exit(1);
}
const pdfDataUrl = `data:application/pdf;base64,${readFileSync(PDF_PATH).toString("base64")}`;

// 起一个独立的 vite 实例。
// ⚠️ 端口：项目 vite.config.ts 里写死了 `port: 1420, strictPort: true`，
// 而 `server` 选项会与它**合并**（不是覆盖）—— 显式改本地端口才有效。
// 用 1420 会和正在运行的 dev server 撞车，所以另起一个端口。
// ⚠️ 必须用项目自己的配置：`configFile: false` 时 vite 不转译 TS/TSX，
// 而 harness 要 import 生产代码里的 `textLayerMarker.ts`。
const server = await createServer({
  configFile: "./vite.config.ts",
  logLevel: "error",
  // HMR 在这里毫无用处，却会往 console 灌 WebSocket 连接失败 ——
  // 无头浏览器把 loopback WebSocket 判为「本地网络访问」直接拒掉。
  // 那些噪音会让「页面抛错」这条断言永远红，而且与被测行为无关。
  server: { port: PORT, strictPort: true, host: "127.0.0.1", hmr: false },
});
await server.listen();
const address = server.httpServer.address();
const actualPort = typeof address === "object" && address ? address.port : PORT;
const base = `http://127.0.0.1:${actualPort}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });

/**
 * 只收**与被测代码相关**的错误。
 *
 * Vite 的 HMR 客户端在无头浏览器里必然刷 WebSocket 连接失败（loopback
 * WebSocket 被判为本地网络访问），而 `server.hmr = false` 会被
 * vite.config.ts 的合并逻辑盖掉。过滤它，而不是为了消掉噪音去改项目配置。
 */
const IGNORED_ERROR_PATTERNS = [/\[vite\]/, /websocket/i];
const realErrors = () => errors.filter((error) => !IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(error)));

const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});

/**
 * 测试页。CSS 里的 `.textLayer` 基础规则照抄 PDFViewer.css 的对应片段 ——
 * 尤其 `.textLayer span { position: absolute }`：正是这条规则会带走行内片段，
 * 所以它必须在场，否则测出来的「position: static」没有意义。
 */
const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { margin: 0; background: #525659; }
  #host { position: relative; width: 595px; height: 842px; background: #fff; }
  .textLayer {
    position: absolute; inset: 0; line-height: 1;
    --total-scale-factor: 1; --scale-factor: 1;
  }
  .textLayer > :not(.markedContent) {
    --font-height: 11; --scale-x: 1; --rotate: 0deg;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(calc(1 / var(--min-font-size, 1)));
  }
  .textLayer .markedContent { display: contents; }
  .textLayer span, .textLayer br {
    color: transparent; position: absolute; white-space: pre;
    transform-origin: 0% 0%; margin: 0; padding: 0;
  }
  .reader-accent { --reader-accent: #2563eb; }
  /* ↓↓↓ 被测样式：与 PDFViewer.css 中的同名规则**逐字一致** ↓↓↓
     ⚠️ 这里刻意用 [class*="..."] 而不是精确类名：生产代码给每条标注的 class
     是 \`r0nix-marker-wavy-{annotation.id}\`（带 id 后缀，多条标记才能各自独立
     增删）。若 CSS 写成 \`.r0nix-marker-wavy\` 精确匹配，一条都选不中 ——
     而这个脚本用带后缀的 class 名，正好能守住它。 */
  .textLayer [class*="r0nix-marker-wavy"] {
    text-decoration-line: underline;
    text-decoration-style: wavy;
    text-decoration-color: color-mix(in srgb, var(--reader-accent) 72%, transparent);
    text-decoration-thickness: 1px;
    text-underline-offset: 0.16em;
    text-decoration-skip-ink: none;
  }
  .appended:is(.textLayer [class*="r0nix-marker-wavy"]) { position: initial; }
</style></head>
<body class="reader-accent"><div id="host"></div>
<script type="module">
  // 逐个 import 并单独 try：一次性 import 时任何一个失败都会被静默降级成
  // 「命名空间为空对象」，看不出是哪一行出的问题（实测踩过）。
  const mods = {};
  const steps = [
    ["pdfjs", () => import("${base}/node_modules/pdfjs-dist/build/pdf.mjs")],
    ["pdfjsViewer", () => import("${base}/node_modules/pdfjs-dist/web/pdf_viewer.mjs")],
    ["marker", () => import("${base}/src/components/pdfReader/textLayerMarker.ts")],
  ];
  for (const [key, load] of steps) {
    try {
      mods[key] = await load();
      window.__modError = null;
    } catch (error) {
      window.__modError = key + ": " + String(error);
      mods[key] = {};
    }
  }
  window.__pdfjs = mods.pdfjs;
  window.__pdfjsViewer = mods.pdfjsViewer;
  window.__TextLayerMarker = mods.marker;
  window.__base = "${base}";
  window.__ready = true;
</script>
</body></html>`;

/**
 * harness 通过 `page.route` 注入，不落盘、不走 vite 的 html 路由。
 *
 * ⚠️ 两个踩过的坑，都记录在这里免得再犯：
 *
 * 1. 写进 `public/` 再请求它，vite 会**回退到 index.html**（应用入口）——
 *    页面确实加载成功，只是加载的是整个 React 应用，症状是
 *    「window.__pdfjs 是 undefined，且没有任何报错」。
 * 2. 用 `http://r0nix.local/...` 这类伪造 origin 注入 harness，会被 CORS 拦掉
 *    从 loopback 加载的模块（`ERR_FAILED`，且只在 console 里出现）。
 *    所以 URL 必须与 vite server **同源** —— 这里直接用 base 下的一个路径。
 */
const HARNESS_URL = `${base}/__text-layer-harness.html`;
await page.route(HARNESS_URL, (route) =>
  route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS }),
);

let result;
try {
  await page.goto(HARNESS_URL, { waitUntil: "domcontentloaded" });
  // 等三个模块都挂上再继续。`load` 只保证 HTML 与同步脚本完成，
  // module script 是 deferred 的 —— 只等 `load` 会拿到 undefined。
  try {
    await page.waitForFunction(
      () =>
        window.__ready === true &&
        typeof window.__TextLayerMarker?.TextLayerMarker === "function" &&
        typeof window.__pdfjsViewer?.TextLayerBuilder === "function",
      { timeout: 30000 },
    );
  } catch (error) {
    // 超时时把页面里看到的一切打出来：模块解析失败、控制台报错都会在这里显形。
    // 只抛「超时」的话，排查要来回改三轮。
    console.error("harness 未就绪。页面状态：", await page.evaluate(() => ({
      ready: window.__ready,
      modError: window.__modError,
      marker: Object.keys(window.__TextLayerMarker || {}),
      viewer: window.__pdfjsViewer ? Object.keys(window.__pdfjsViewer).slice(0, 8) : null,
      pdfjs: typeof window.__pdfjs,
    })));
    console.error("console/page errors:", errors);
    // 把实际拿到的 HTML 前几行打出来：模块 script 整段消失的话，
    // 说明 vite 的 index.html 转换把它吃掉了（这是最可能的一种）。
    const served = await page.content();
    console.error("页面 HTML 片段:", served.slice(0, 400));
    throw error;
  }

  result = await page.evaluate(async ({ pdfDataUrl }) => {
    const { getDocument, GlobalWorkerOptions } = window.__pdfjs;
    const { TextLayerBuilder } = window.__pdfjsViewer;
    const { TextLayerMarker } = window.__TextLayerMarker;
    GlobalWorkerOptions.workerSrc = `${window.__base}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;

    const host = document.getElementById("host");
    const binary = Uint8Array.from(atob(pdfDataUrl.split(",")[1]), (c) => c.charCodeAt(0));
    const doc = await getDocument({
      data: binary,
      standardFontDataUrl: `${window.__base}/node_modules/pdfjs-dist/standard_fonts/`,
    }).promise;
    const pdfPage = await doc.getPage(1);
    const viewport = pdfPage.getViewport({ scale: 1 });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    host.appendChild(canvas);
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), canvas, viewport }).promise;

    // 走生产链路：TextLayerBuilder 的 highlighter 扩展点。
    const marker = new TextLayerMarker();
    // 记录 setTextMapping 被调用了几次、每次传进来什么 —— 官方在
    // `#renderingDone` 分支会再调一次，两次内容不同就会把索引映射悄悄换掉。
    const calls = [];
    const originalSetMapping = marker.setTextMapping.bind(marker);
    marker.setTextMapping = (divs, texts) => {
      calls.push({ divs: Array.isArray(divs) ? divs.length : -1, texts: Array.isArray(texts) ? texts.length : -1 });
      return originalSetMapping(divs, texts);
    };
    const builder = new TextLayerBuilder({ pdfPage, highlighter: marker, container: host });
    await builder.render({ viewport });
    const div = builder.div;
    div.className = "textLayer";
    host.appendChild(div);

    const items = [...div.querySelectorAll("span")];
    if (marker.divCount() === 0) {
      marker.setTextMapping(items, items.map((s) => s.textContent || ""));
    }
    window.__setMappingCalls = calls;
    const ranges = [];
    items.forEach((span) => {
      const idx = marker.indexOf(span);
      const len = span.textContent.length;
      if (idx >= 0 && len > 0) ranges.push({ begin: { divIdx: idx, offset: 0 }, end: { divIdx: idx, offset: len } });
    });
    // ⚠️ 用**带 id 后缀**的 class —— 与 PageCanvas 的
    // `${MARKER_WAVY_CLASS}-${annotation.id}` 完全同形。CSS 若写成精确类名，
    // 这个脚本就会因为「样式没生效」而红 —— 那正是要守住的回归。
    marker.setGroups([{ className: "r0nix-marker-wavy-ai-1", ranges }]);

    const appended = div.querySelectorAll('[class*="r0nix-marker-wavy"].appended');
    const hostRect = host.getBoundingClientRect();
    const boxes = [...appended].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top - hostRect.top,
        bottom: r.bottom - hostRect.top,
        height: r.height,
        left: r.left - hostRect.left,
        width: r.width,
        text: el.textContent,
      };
    });

    return {
      appendedCount: appended.length,
      boxes,
      fullText: div.textContent.replace(/\s+/g, " ").trim(),
      computedPosition: appended[0] ? getComputedStyle(appended[0]).position : null,
      decorationStyle: appended[0] ? getComputedStyle(appended[0]).textDecorationStyle : null,
      // 诊断用：span 与 divIdx 的对应关系是否成立。
      diag: {
        spanCount: items.length,
        divCount: marker.divCount(),
        firstSpanIndex: items[0] ? marker.indexOf(items[0]) : null,
        firstSpanIsDiv: items[0] ? marker.divAt(0) === items[0] : null,
        // WeakMap 到底建了多少条？逐个 divIdx 反查 indexOf。
        lookupByIdx: [0, 1, 2, 3].map((i) => {
          const div = marker.divAt(i);
          return { i, found: div ? marker.indexOf(div) : null, tag: div ? div.tagName : null };
        }),
        // DOM 里 span 的实际 tagName（若是 div 就说明 textDivs 不是 span）
        firstTag: items[0] ? items[0].tagName : null,
        builderDivClass: div.className,
        setMappingCalls: window.__setMappingCalls,
        // 波浪线是否与文字等宽？行内片段不吃外层 span 的 scaleX，
        // 会比原文字宽一截 —— 那是肉眼可见的错位，必须量出来。
        widthRatio: (() => {
          const span = div.querySelector("span:not(.appended)");
          const app = div.querySelector('[class*="r0nix-marker-wavy"].appended');
          if (!span || !app) return null;
          const a = span.getBoundingClientRect().width;
          const b = app.getBoundingClientRect().width;
          return a > 0 ? b / a : null;
        })(),
        offsetDelta: (() => {
          const span = div.querySelector("span:not(.appended)");
          const app = div.querySelector('[class*="r0nix-marker-wavy"].appended');
          if (!span || !app) return null;
          return (
            app.getBoundingClientRect().left - span.getBoundingClientRect().left
          );
        })(),
      },
    };
  }, { pdfDataUrl });

  await page.screenshot({ path: OUT_PNG });
} finally {
  await browser.close();
  await server.close();

}

// ── 断言 ────────────────────────────────────────────────────────────────
assert.deepEqual(realErrors(), [], `页面抛错：${realErrors().join(" | ")}`);
assert.equal(result.appendedCount, 9, `应标出 9 个行片段，实际 ${result.appendedCount}`);
assert.equal(result.computedPosition, "static", `片段应是行内流式（position: static），实际 ${result.computedPosition}`);
assert.equal(result.decorationStyle, "wavy", `下划线应为 wavy，实际 ${result.decorationStyle}`);

// 关键几何断言：每行片段的高度应接近单行字高（约 11–20px）。
// 若是段落高的并集框（旧的覆盖 div 方案），这里会是几百 px。
for (const box of result.boxes) {
  assert.ok(
    box.height > 0 && box.height < 40,
    `行片段高度 ${box.height.toFixed(1)}px 不像单行（旧的覆盖 div 会是整段高）`,
  );
}

// 行与行之间必须分得开：9 个片段的 top 应互不相同。
const tops = new Set(result.boxes.map((b) => Math.round(b.top)));
assert.equal(tops.size, 9, `9 行应有 9 个不同的纵向位置，实际 ${tops.size} 个`);

// 三段之间的行距应大于段内行距（夹具刻意如此）—— 证明分段的视觉分组成立。
const sorted = [...result.boxes].sort((a, b) => a.top - b.top);
const withinGap = sorted[1].top - sorted[0].top;
const betweenGap = sorted[3].top - sorted[2].top;
assert.ok(betweenGap > withinGap, `段间距(${betweenGap.toFixed(1)}) 应大于行间距(${withinGap.toFixed(1)})`);

// 文本完好。
assert.ok(result.fullText.includes("Alpha paragraph one line one"), "文本层内容丢失");
assert.ok(result.fullText.includes("Charlie paragraph three line three"), "文本层尾部丢失");

await browser.close();

// 波浪线必须与它标注的文字严格对齐。行内片段不吃外层 span 的 scaleX，
// 若 CSS 里漏了 `position: initial`，片段会被 `position: absolute` 带走；
// 若宽度对不上，视觉上就是「线比字长一截」。
assert.ok(
  result.diag.widthRatio !== null && Math.abs(result.diag.widthRatio - 1) < 0.02,
  `波浪线宽度应与文字一致，实际比值 ${result.diag.widthRatio}`,
);
assert.ok(
  result.diag.offsetDelta !== null && Math.abs(result.diag.offsetDelta) < 1,
  `波浪线左边缘应与文字对齐，实际偏移 ${result.diag.offsetDelta}px`,
);

console.log("浏览器视觉验证：9 行各自成段，波浪线贴基线且与文字等宽，文本完好");
console.log(`  段内行距 ${withinGap.toFixed(1)}px < 段间距 ${betweenGap.toFixed(1)}px`);
console.log(`  行片段高度 ${result.boxes[0].height.toFixed(1)}px（单行，非段落并集）`);
console.log(`  position=${result.computedPosition} decoration=${result.decorationStyle}`);
console.log(`  宽度比 ${result.diag.widthRatio.toFixed(3)} 左偏移 ${result.diag.offsetDelta.toFixed(2)}px`);
console.log(`  截图: ${OUT_PNG}`);
