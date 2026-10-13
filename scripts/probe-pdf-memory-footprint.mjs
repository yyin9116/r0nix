/**
 * PDF 内存足迹探针：量「整进程 RSS」随文档与阅读过程的变化，并把它分解到具体载体。
 *
 * ── 与 probe-pdf-memory.mjs 的分工 ─────────────────────────────
 *   · probe-pdf-memory.mjs  → 页面内量（JS 堆 / DOM / canvas 像素），回答「谁在 JS 侧累积」
 *   · 本脚本                → 操作系统量（**进程 RSS**），回答「活动监视器里那个『2G』是多少、分到哪」
 * 两者互补：页面内数字解释「为什么」，RSS 解释「总共多少」。
 *
 * ── 为什么必须单独有这一个 ────────────────────────────────────
 * 用户报的是 macOS 活动监视器里的「2G+」。那是**整进程 RSS**，而页面内
 * `performance.memory` 看不到 canvas 像素缓冲（不在 JS 堆里）、看不到 WebKit
 * 自己的解码/网络缓存、看不到 worker 的堆。只看页面内数字会系统性地低估，
 * 且低估的部分恰好是 canvas 与图片解码 —— 也就是重文档 PDF 的主战场。
 * 本机 `ps` 可用（2026-10-10 复核），所以直接读 `ps -o rss=`，不做估算。
 *
 * ── 校准声明（读结论前必读）──────────────────────────────────
 * 默认引擎 webkit 用的是 Playwright 自带构建，它在 macOS 上是**单浏览器进程**；
 * 系统 WKWebView（Tauri 实际用的）会拆成 WebContent / Networking / GPU 多个子进程。
 * 因此：**相对增长与结构分解可信，绝对总量偏小**（缺了进程拆分带来的额外开销）。
 * 真实 Tauri 应用的绝对值需要用活动监视器/`ps` 在真机上取一次做校准。
 *
 * 用法：
 *   node scripts/probe-pdf-memory-footprint.mjs [页数]
 *   PROBE_ENGINE=chromium node scripts/probe-pdf-memory-footprint.mjs 200
 *   PROBE_BIG_ONLY=1       跳过「小文档对照」阶段，只跑 200 页全流程（省时间）
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createPdfFixture, createScannedPdfFixture } from "./lib/pdf-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require("playwright-core");

const PAGE_COUNT = Number(process.argv[2] || 200);
const ENGINE = process.env.PROBE_ENGINE === "chromium" ? "chromium" : "webkit";
const BIG_ONLY = process.env.PROBE_BIG_ONLY === "1";
const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:1420";

function findBrowserExecutable() {
  const candidates =
    process.platform === "darwin"
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

/**
 * 读全系统进程表。
 *
 * ⚠️ 为什么不只看「探针进程的后代」：macOS 上 WebKit 的 WebContent / Networking / GPU
 * 是 **XPC 服务进程，父进程是 launchd**，不在 node 的进程树里。只沿 child 链走会
 * **安静地漏掉 pdf.js 的 worker**（它可能落在 WebContent 里），而漏掉它等于这次
 * 调查白做 —— 实测第一版就是「浏览器 RSS 恒 120MB、完全不随文档变」，正是这个症状。
 * 所以改成读全表 + 按可执行路径判断归属，并额外打印全系统 top 进程做兜底透明。
 */
function readAllProcesses() {
  let raw;
  try {
    raw = execSync("ps -eo pid=,ppid=,rss=,comm=", { encoding: "utf8" });
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), comm: match[4].trim() });
  }
  return rows;
}

/** 递归收集某进程的全部后代（用于识别 dev server 这类真后代）。 */
function collectTree(rootPid, rows) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const out = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) || []) {
      out.push(child);
      walk(child.pid);
    }
  };
  walk(rootPid);
  return out;
}

/**
 * 浏览器进程识别：按**可执行路径**而不是短名。
 *
 * Playwright 的浏览器/WebKit 进程路径都落在 `ms-playwright` 缓存目录下；
 * 由此可与**用户自己的 Safari**（同样叫 `com.apple.WebKit.WebContent`）区分开 ——
 * 只按进程名匹配会把 Safari 的内存算进这次实验。
 */
const BROWSER_PATH = /ms-playwright|Playwright\.app|Chrome for Testing|chromium-/i;

/** 只要「浏览器 RSS 合计」这一个数（供高频峰值采样用，省掉明细组装）。 */
function readBrowserRssMb() {
  return Math.round(
    readAllProcesses()
      .filter((row) => BROWSER_PATH.test(row.comm))
      .reduce((sum, row) => sum + row.rssKb, 0) / 1024,
  );
}

/**
 * 全程峰值追踪。
 *
 * 为什么必需：用户看到的「2G」是他**盯着活动监视器**时那个数字，也就是**峰值**，
 * 而各阶段稳态采样点全在 delay 之后 —— 恰好错过峰值。第一版探针就因为这个
 * 把「滚动峰值 1170MB」读成了「静置后 399MB」，两者差 3 倍，结论会完全相反。
 * 采样间隔 400ms：`ps` 全表同步执行约 20ms，太密会阻塞事件循环、反而拖慢滚动
 * （滚动一慢，内存曲线形状也变了）。
 */
function startPeakTracker(intervalMs = 400) {
  const state = { peakMb: 0, samples: 0, history: [] };
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const mb = readBrowserRssMb();
        state.samples += 1;
        state.history.push(mb);
        if (mb > state.peakMb) state.peakMb = mb;
      } catch {
        // 采样失败不终止追踪：进程表偶发读失败不该让整轮实验白做
      }
      await delay(intervalMs);
    }
  })();
  return {
    state,
    async finish() {
      stop = true;
      await loop;
      return state;
    },
  };
}

function sampleProcesses(label) {
  const rows = readAllProcesses();
  const tree = collectTree(process.pid, rows);
  const ancestry = new Set([process.pid, ...tree.map((row) => row.pid)]);

  const browserRows = rows.filter((row) => BROWSER_PATH.test(row.comm));
  const browserMb = Math.round(browserRows.reduce((sum, row) => sum + row.rssKb, 0) / 1024);
  // dev server：探针的真后代里，排除浏览器本身。
  const devServerMb = Math.round(
    tree
      .filter((row) => !BROWSER_PATH.test(row.comm))
      .reduce((sum, row) => sum + row.rssKb, 0) / 1024,
  );

  const top = [...rows].sort((left, right) => right.rssKb - left.rssKb).slice(0, 8).map((row) => ({
    pid: row.pid,
    rssMb: Math.round(row.rssKb / 1024),
    comm: row.comm,
  }));

  return {
    label,
    browserMb,
    devServerMb,
    browserProcs: browserRows
      .map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        rssMb: Math.round(row.rssKb / 1024),
        inTree: ancestry.has(row.pid),
        comm: row.comm,
      }))
      .sort((left, right) => right.rssMb - left.rssMb),
    top,
  };
}

/**
 * 页面内量测：只量**只有页面知道**的东西（canvas 像素、DOM、页数）。
 * 不再量 JS 堆 —— WebKit 没有 `performance.memory`，而这个脚本的 RSS 已经涵盖了它。
 */
const PROBE_INIT_SCRIPT = () => {
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
      // 口径：`canvas.height = 同值` 只是清空位图，不重新 malloc；只有尺寸变化才记账，
      // 否则「池化复用画布」的收益会被抹掉。
      if (changed && width > 1 && height > 1) {
        window.__memCanvasAlloc = (window.__memCanvasAlloc || 0) + width * height * 4;
        window.__memCanvasAllocCount = (window.__memCanvasAllocCount || 0) + 1;
      }
      descriptor.set.call(this, value);
    },
  });
};

async function samplePage(page, label) {
  const metrics = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("canvas")];
    const liveBytes = canvases.reduce((sum, node) => sum + node.width * node.height * 4, 0);
    const pagesInDom = document.querySelectorAll("[data-pdf-page]").length;
    return {
      canvasCount: canvases.length,
      canvasLiveMb: Math.round(liveBytes / 1048576),
      canvasAllocMb: Math.round((window.__memCanvasAlloc || 0) / 1048576),
      canvasAllocCount: window.__memCanvasAllocCount || 0,
      nodes: document.getElementsByTagName("*").length,
      pagesInDom,
      spans: document.querySelectorAll(".textLayer span").length,
    };
  });
  return { label, ...metrics };
}

function printRow(proc, pg) {
  console.log(
    `  ${proc.label.padEnd(24)} ` +
      `RSS: 浏览器 ${String(proc.browserMb).padStart(4)}MB (+dev ${String(proc.devServerMb).padStart(4)}MB)  |  ` +
      `页面: canvas ${String(pg.canvasCount).padStart(3)}个/${String(pg.canvasLiveMb).padStart(4)}MB` +
      ` 累计分配 ${String(pg.canvasAllocMb).padStart(5)}MB(${pg.canvasAllocCount}次)  ` +
      `页在DOM ${String(pg.pagesInDom).padStart(3)}  span ${String(pg.spans).padStart(5)}  nodes ${String(pg.nodes).padStart(6)}`,
  );
}

/**
 * 打开夹具文件并等到首页画布可见。
 * 走真实的「打开文件…」按钮 + filechooser，与用户操作一致（不绕过应用流程）。
 *
 * ⚠️ 必须落盘再用路径喂给 `setFiles`：Playwright 的 `setFiles({buffer})` 上限 50MB，
 * 而扫描件夹具 200 页就有 110 MiB —— 传 buffer 会直接抛
 * `Cannot set buffer larger than 50Mb`。用路径没这个限制，也更贴近真实打开流程。
 */
async function openFixture(page, fixturePath, title) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "打开文件..." }).click();
  await (await chooserPromise).setFiles(fixturePath);
  await page.locator('[data-pdf-page="1"] canvas.pdf-page-canvas').waitFor({ state: "visible", timeout: 180_000 });
  return title;
}

/** 逐屏滚到底，模拟读者一次通读；`onStep` 用来同步采内存曲线。 */
async function scrollThrough(page, { settleMs = 180, onStep } = {}) {
  for (let step = 0; step < 120; step += 1) {
    const done = await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (!root) return true;
      root.scrollTop = root.scrollTop + root.clientHeight * 0.9;
      return root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
    });
    await delay(settleMs);
    if (onStep) onStep(step + 1);
    if (done) return step + 1;
  }
  return 120;
}

async function main() {
  const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const server = spawn(serverCommand, ["run", "dev", "--", "--host", "127.0.0.1"], { stdio: "ignore", detached: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "r0nix-mem-fp-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "r0nix-mem-fixtures-"));
  let browser = null;
  let tracker = null;

  // 大/小夹具都用「每页独立位图」的扫描件版：只有它能把整份文件撑到与用户
  // 反馈同量级（200 页 ≈ 110 MiB）。共享位图的 heavy 版 200 页只有 0.21 MiB，
  // 用它测内存等于没测 —— 理由见 pdf-fixture.mjs 里 createScannedPdfFixture 的注释。
  const smallFixture = BIG_ONLY ? null : createScannedPdfFixture(2);
  const bigFixture = createScannedPdfFixture(PAGE_COUNT);
  // 轻量对照组：同页数、无图 → 用来把「页数」和「每页像素量」这两个变量拆开。
  const lightFixture = BIG_ONLY ? null : createPdfFixture(PAGE_COUNT);

  const paths = {
    light: join(fixtureDir, `mem-light-${PAGE_COUNT}p.pdf`),
    small: join(fixtureDir, "mem-small-2p.pdf"),
    big: join(fixtureDir, `mem-scanned-${PAGE_COUNT}p.pdf`),
  };
  if (lightFixture) writeFileSync(paths.light, lightFixture);
  if (smallFixture) writeFileSync(paths.small, smallFixture);
  writeFileSync(paths.big, bigFixture);

  // Rust 侧的 `probe_pdf_base64_ipc_peak` 需要同一份夹具（它量的是 IPC 编码峰值，
  // 只能在 Rust 进程里量）。默认删掉以免留 100+ MiB 临时文件，需要跨语言对照时
  // 用 PROBE_KEEP_FIXTURE=1 落一份到固定路径。
  if (process.env.PROBE_KEEP_FIXTURE === "1") {
    const keepPath = `/tmp/scanned-${PAGE_COUNT}.pdf`;
    writeFileSync(keepPath, bigFixture);
    console.log(`\n（PROBE_KEEP_FIXTURE=1：夹具已留档 ${keepPath}）`);
    console.log(`  Rust 侧对照：R0NIX_MEM_FIXTURE=${keepPath} \\`);
    console.log(`    cargo test --manifest-path src-tauri/Cargo.toml --lib probe_pdf_base64_ipc_peak -- --ignored --nocapture\n`);
  }

  try {
    await waitForServer(baseUrl);

    console.log(`\n════════ 内存足迹探针 ════════`);
    console.log(`引擎：${ENGINE}${ENGINE === "webkit" ? "（对齐 Tauri 的 WKWebView 内核）" : ""}`);
    console.log(`夹具：${PAGE_COUNT} 页扫描件（每页独立 1600×2200 位图 + 60 行文字）= ${(bigFixture.length / 1048576).toFixed(1)} MiB`);
    if (lightFixture) console.log(`对照：${PAGE_COUNT} 页轻量（30 行文字、无图）= ${(lightFixture.length / 1048576).toFixed(2)} MiB`);
    if (smallFixture) console.log(`对照：2 页扫描件 = ${(smallFixture.length / 1048576).toFixed(2)} MiB`);
    console.log(`（RSS 按**进程可执行路径**归集，含 XPC 拆出去的 WebContent；dev server 单列不计入）\n`);

    let context;
    if (ENGINE === "webkit") {
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
    await context.addInitScript(PROBE_INIT_SCRIPT);
    const page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });
    await delay(2500);

    // ── A. 空载：固定开销（WebKit + React 应用壳）──
    const a = sampleProcesses("A 空载");
    printRow(a, await samplePage(page, a.label));

    // 全程峰值追踪从这里开始：覆盖打开与滚动的全部窗口。
    tracker = startPeakTracker();

    let light = null;
    if (lightFixture) {
      // ── B. 轻量 200 页：把「页数」与「每页像素量」拆开的关键对照 ──
      await openFixture(page, paths.light, "light");
      await delay(2500);
      light = sampleProcesses("B 轻量200页(无图)");
      printRow(light, await samplePage(page, light.label));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });
      await delay(2500);
      const reloaded = sampleProcesses("B2 reload 回空载");
      printRow(reloaded, await samplePage(page, reloaded.label));
      console.log(
        `     ↳ reload 后是否回落到空载：${reloaded.browserMb - a.browserMb} MB（负值=回收，正值=未归还）`,
      );
    }

    let small = null;
    if (smallFixture) {
      await openFixture(page, paths.small, "small");
      await delay(2000);
      small = sampleProcesses("C 2页扫描件");
      printRow(small, await samplePage(page, small.label));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });
      await delay(2000);
      const reloaded = sampleProcesses("C2 reload 回空载");
      printRow(reloaded, await samplePage(page, reloaded.label));
    }

    // ── D. 200 页扫描件：全流程 ──
    await openFixture(page, paths.big, "big");
    await delay(3000);
    const opened = sampleProcesses("D 打开扫描件");
    printRow(opened, await samplePage(page, opened.label));

    const scrollCurve = [];
    const scrolled = await scrollThrough(page, { onStep: () => scrollCurve.push(readBrowserRssMb()) });
    const readAll = sampleProcesses("E 滚完全文");
    printRow(readAll, await samplePage(page, readAll.label));
    console.log(`     ↳ 滚动步数 ${scrolled}`);
    if (scrollCurve.length > 2) {
      const min = Math.min(...scrollCurve);
      const max = Math.max(...scrollCurve);
      console.log(`     ↳ 滚动期 RSS 曲线：起 ${scrollCurve[0]}MB → 末 ${scrollCurve.at(-1)}MB（min ${min} / max ${max}）`);
      console.log(`       每 10 步：${scrollCurve.filter((_, index) => index % 10 === 0).join(" → ")} MB`);
    }

    await delay(6000);
    const settled = sampleProcesses("F 静置 6s");
    printRow(settled, await samplePage(page, settled.label));
    console.log(`     ↳ 相对滚完时变化：${settled.browserMb - readAll.browserMb} MB`);

    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (root) root.scrollTop = 0;
    });
    await delay(3000);
    const backTop = sampleProcesses("G 回第1页");
    printRow(backTop, await samplePage(page, backTop.label));
    console.log(`     ↳ 相对滚完时变化：${backTop.browserMb - readAll.browserMb} MB（负值=随视口回收）`);

    // ── 结论行 ──
    const peak = await tracker.finish();
    console.log(`\n──────── 分解 ────────`);
    const baseline = a.browserMb;
    const docSizeMb = bigFixture.length / 1048576;
    console.log(`  空载固定开销（WebKit+应用壳）        ${baseline} MB`);
    console.log(
      `  ★ 全程峰值（${peak.samples} 次采样，400ms 间隔）  ${peak.peakMb} MB` +
        `  = 文件大小 (${docSizeMb.toFixed(1)} MiB) 的 ${(peak.peakMb / docSizeMb).toFixed(1)}×`,
    );
    console.log(`  读完全文后的浏览器进程              ${readAll.browserMb} MB`);
    console.log(
      `  文档相关增量                        ${readAll.browserMb - baseline} MB` +
        `  = 文件大小 (${docSizeMb.toFixed(1)} MiB) 的 ${((readAll.browserMb - baseline) / docSizeMb).toFixed(1)}×`,
    );
    console.log(`  每页摊销（峰值增量 ÷ 页数）         ${((peak.peakMb - baseline) / PAGE_COUNT).toFixed(2)} MB/页`);
    console.log(
      `    ⚠️ 这个值由**每页像素量**决定（本夹具 1600×2200 RGBA ≈ 14 MB/页原始），不是文件大小的函数；` +
        `\n       换更小/更大的页面尺寸峰值会同比例变化 —— 300dpi A4 扫描件（≈2400×3300）会显著更高。`,
    );
    if (light) {
      console.log(`  对照：轻量 ${PAGE_COUNT} 页（同页数、无图）稳态 ${light.browserMb} MB（此处为稳态读数，不可直接与峰值相减）`);
    }
    console.log(`\n  浏览器进程明细（读完全文时，共 ${readAll.browserProcs.length} 个）：`);
    for (const proc of readAll.browserProcs.slice(0, 8)) {
      console.log(
        `    ${String(proc.rssMb).padStart(5)} MB  pid=${String(proc.pid).padStart(6)} ppid=${String(proc.ppid).padStart(6)}` +
          `  ${proc.inTree ? "树内" : "XPC "}  ${proc.comm.slice(0, 64)}`,
      );
    }

    // 兜底透明：万一有哪个相关进程没被路径规则命中，全系统 top 能让人一眼看出来。
    console.log(`\n  全系统 RSS top 8（兜底，防漏计）：`);
    for (const proc of readAll.top) {
      console.log(`    ${String(proc.rssMb).padStart(5)} MB  pid=${String(proc.pid).padStart(6)}  ${proc.comm.slice(0, 64)}`);
    }
  } finally {
    await tracker?.finish().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // server already gone
    }
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("probe-pdf-memory-footprint failed:", error);
  process.exitCode = 1;
});
