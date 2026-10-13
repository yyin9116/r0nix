/**
 * PDF 内存探针：打开长文档 + 逐页滚动，量化内存增长并归因到具体载体。
 *
 * 为什么需要它：macOS 活动监视器里的「2G+」是**整进程**数字，它把
 * pdf.js 的文档结构、DOM 节点、canvas 像素缓冲、WebKit 自身缓存混在一起，
 * 只看总数无法判断该修哪一层。这个脚本把三件事分开量：
 *   ① 进程树 RSS（含 canvas 像素缓冲 —— 它不在 JS 堆里，performance.memory 看不到）
 *   ② JS 堆（pdf.js 的文档结构、标注、块数据都在这里）
 *   ③ DOM 节点数与 canvas 像素字节数（谁在累积一眼可见）
 *
 * 用法：node scripts/probe-pdf-memory.mjs [页码数]
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const PAGE_COUNT = Number(process.argv[2] || 200);
const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:1420";

function findBrowserExecutable() {
  const candidates =
    process.platform === "darwin"
      ? [
          process.env.CHROME_PATH,
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : [
          process.env.CHROME_PATH,
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/** 生成 pageCount 页的文本 PDF（每页多行正文，模拟真实文档的文本层规模）。 */
function createPdfFixture(pageCount) {
  const lines = [
    "BT /F1 11 Tf 72 740 Td 0 -16 Td",
    ...Array.from({ length: 30 }, (_, index) => `(Paragraph line ${index + 1} of a representative document page for memory probing) Tj 0 -16 Td`),
    "ET",
  ].join("\n");
  const pageObjects = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  const fontId = pageCount + 3;
  const contentId = pageCount + 4;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(lines, "binary")} >>\nstream\n${lines}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "binary"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "binary");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${body}${xref}${trailer}`, "binary");
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

/**
 * 量测口径（本机禁止 ps，拿不到 RSS，所以全部在页面内量）：
 *   heap        —— JS 堆：pdf.js 文档结构、阅读块、标注等都在这里
 *   nodes       —— DOM 节点数：文本层/标注层是否被留下
 *   canvasLive  —— **当前还挂在 DOM 上**的 canvas 及其像素字节
 *   canvasAlloc —— **累计分配过**的 canvas 像素字节（含已卸载、等 GC 的）
 *
 * canvasAlloc 是本次排查的关键：canvas 的像素缓冲不在 JS 堆里，
 * 只有它能把「页面滚过去之后，那些卸载掉的 canvas 到底有没有把显存还回来」
 * 变成可读的数字。累计值远大于 canvasLive ⇒ 存在 churn（反复分配/释放）。
 */
const PROBE_INIT_SCRIPT = () => {
  /**
   * 只统计**真正触发重新分配**的尺寸变化。
   *
   * 口径很重要：`canvas.height = 同值` 只是清空位图，引擎不需要重新 malloc；
   * 把这类赋值也算进去会把「复用池化画布」的收益抹掉（实测：赋值口径 407 次 / 
   * 真实重新分配 ≈ 200 次）。所以要按元素记住上一次的尺寸，只在尺寸变化时记账。
   */
  const lastSize = new WeakMap();
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height");
  Object.defineProperty(HTMLCanvasElement.prototype, "height", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set(value) {
      const width = this.width;
      const height = Number(value);
      const previous = lastSize.get(this);
      const changed = !previous || previous.width !== width || previous.height !== height;
      if (changed) lastSize.set(this, { width, height });
      if (changed && width > 1 && height > 1) {
        const bytes = width * height * 4;
        window.__r0nixCanvasAlloc = (window.__r0nixCanvasAlloc || 0) + bytes;
        window.__r0nixCanvasAllocCount = (window.__r0nixCanvasAllocCount || 0) + 1;
        // 面积分桶：缩略图 ~1.5 万像素，页面主画布 ~50 万像素（dpr 1）到
        // ~200 万像素（Retina dpr 2）。分不开就说不清是谁在 churn。
        const bucket = width * height > 400_000 ? "page" : "small";
        const byBucket = (window.__r0nixCanvasAllocByBucket ||= { page: 0, small: 0 });
        const countByBucket = (window.__r0nixCanvasAllocCountByBucket ||= { page: 0, small: 0 });
        byBucket[bucket] += bytes;
        countByBucket[bucket] += 1;
        // 大画布按调用点归因：取栈里第一帧应用代码（跳过 React/浏览器内部帧）。
        if (bucket === "page") {
          const origin = {};
          for (const line of (new Error().stack || "").split("\n").slice(1)) {
            const match = line.match(/((?:src|node_modules|@fs)[^\s)]+?):\d+:\d+/);
            if (!match) continue;
            const file = match[1].replace(/^.*\/(src|node_modules)\//, "$1/").split("?")[0];
            if (file.includes("react-dom") || file.includes("scheduler")) continue;
            origin[file] = (origin[file] || 0) + 1;
            break;
          }
          const origins = (window.__r0nixCanvasOrigins ||= {});
          for (const [file, count] of Object.entries(origin)) {
            origins[file] = (origins[file] || 0) + count;
          }
        }
      }
      descriptor.set.call(this, value);
    },
  });
};

async function sample(page, label) {
  const toMb = (bytes) => Math.round(bytes / 1048576);
  const metrics = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("canvas")];
    const megabytes = (bytes) => Math.round(bytes / 1048576);
    return {
      heap: performance.memory ? megabytes(performance.memory.usedJSHeapSize) : null,
      heapPeak: performance.memory ? megabytes(performance.memory.totalJSHeapSize) : null,
      nodes: document.getElementsByTagName("*").length,
      canvasLiveCount: canvases.length,
      canvasLiveMb: megabytes(canvases.reduce((sum, node) => sum + node.width * node.height * 4, 0)),
      canvasAllocMb: megabytes(window.__r0nixCanvasAlloc || 0),
      canvasAllocCount: window.__r0nixCanvasAllocCount || 0,
      canvasByBucket: window.__r0nixCanvasAllocByBucket || { page: 0, small: 0 },
      canvasCountByBucket: window.__r0nixCanvasAllocCountByBucket || { page: 0, small: 0 },
      canvasOrigins: window.__r0nixCanvasOrigins || {},
      textSpans: document.querySelectorAll(".textLayer span").length,
    };
  });
  console.log(
    `${label.padEnd(20)} heap=${String(metrics.heap).padStart(4)}MB ` +
      `live=${String(metrics.canvasLiveCount).padStart(3)}个/${String(metrics.canvasLiveMb).padStart(4)}MB ` +
      `alloc=${String(metrics.canvasAllocMb).padStart(5)}MB(${metrics.canvasAllocCount}次) ` +
      `[主画布 ${toMb(metrics.canvasByBucket.page)}MB/${metrics.canvasCountByBucket.page}次 · ` +
      `小图 ${toMb(metrics.canvasByBucket.small)}MB/${metrics.canvasCountByBucket.small}次] ` +
      `nodes=${String(metrics.nodes).padStart(6)} spans=${metrics.textSpans}`
  );
  return metrics;
}

async function main() {
  const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const server = spawn(serverCommand, ["run", "dev", "--", "--host", "127.0.0.1"], {
    stdio: "ignore",
    detached: true,
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "r0nix-mem-probe-"));
  let browser = null;
  try {
    await waitForServer(baseUrl);
    const executablePath = findBrowserExecutable();
    // 用持久上下文而不是 --user-data-dir：Playwright 禁止把后者写进 args。
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: ["--no-first-run"],
    });
    browser = context.browser();
    await context.addInitScript(PROBE_INIT_SCRIPT);
    const page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });
    await sample(page, "应用空载");

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await chooserPromise).setFiles({
      name: `memory-fixture-${PAGE_COUNT}p.pdf`,
      mimeType: "application/pdf",
      buffer: createPdfFixture(PAGE_COUNT),
    });
    await page.locator('[data-pdf-page="1"] canvas.pdf-page-canvas').waitFor({ state: "visible", timeout: 60_000 });
    await delay(1500);
    await sample(page, "首页渲染完成");

    // 逐屏滚动走完全文档：每屏停留 220ms 让渲染与文本层跟上，
    // 这模拟读者真实的一次通读（也是内存增长的真实条件）。
    const total = PAGE_COUNT;
    let lastReported = 0;
    for (let step = 1; step <= 90; step += 1) {
      const done = await page.evaluate(() => {
        const root = document.querySelector(".pdf-selection-scope");
        if (!root) return true;
        root.scrollTop = root.scrollTop + root.clientHeight * 0.9;
        return root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      });
      await delay(220);
      const currentPage = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("[data-pdf-page]")];
        const root = document.querySelector(".pdf-selection-scope");
        if (!root) return 0;
        const center = root.getBoundingClientRect().top + root.clientHeight / 2;
        const hit = nodes.find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top <= center && rect.bottom >= center;
        });
        return Number(hit?.dataset.pdfPage || 0);
      });
      if (currentPage - lastReported >= 20) {
        lastReported = currentPage;
        await sample(page, `滚动到第 ${currentPage} 页`);
      }
      if (done) break;
    }
    await delay(2000);
    await sample(page, "读完全文（静置 2s）");

    // 回到首页再看一眼：如果内存随「访问过的页数」单调增长而不回落，
    // 说明被访问过的页留下了不释放的缓冲。
    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (root) root.scrollTop = 0;
    });
    await delay(2500);
    const final = await sample(page, "回到第 1 页（静置）");

    const origins = Object.entries(final.canvasOrigins).sort((left, right) => right[1] - left[1]);
    console.log("\n主画布像素缓冲分配的调用点归因（累计次数）：");
    for (const [file, count] of origins.slice(0, 8)) {
      console.log(`  ${String(count).padStart(5)} 次  ${file}`);
    }
  } finally {
    await browser?.close().catch(() => undefined);
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // server already gone
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("probe-pdf-memory failed:", error);
  process.exitCode = 1;
});
