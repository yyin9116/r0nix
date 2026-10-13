/**
 * PDF「空白」形态探针：复现「打开后正文/缩略图空白 → 点缩略图出现 → 滚动再空白」，
 * 并在每个时刻把「空白」拆到可读的层次上。
 *
 * 为什么需要它：空白至少有四种完全不同的成因，外观一模一样：
 *   ① 组件根本没挂载（活跃页集合为空 —— 虚拟化没算出来）
 *   ② 组件挂了但渲染没跑（被并发闸/异步 await 挡住）
 *   ③ 渲染跑了但画布被清空（像素缓冲被归零，而"已画"守卫挡住了重绘）
 *   ④ 画布有像素但被 CSS 藏了（opacity / content-visibility / 被覆盖层盖住）
 * 只看截图区分不了这四种。这个脚本对每个时刻同时量：
 *   mounted  —— 该页有没有 canvas.pdf-page-canvas / 缩略图 canvas
 *   sized    —— canvas.width/height（0 或 300x150 默认值 = 从没被绘过）
 *   painted  —— 实际采样非白像素比例（③ 与 ②/① 的分界线）
 *   hidden   —— 祖先链上的 opacity/visibility/display 与覆盖层
 *
 * 用法：node scripts/probe-pdf-blank.mjs [页码数]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const PAGE_COUNT = Number(process.argv[2] || 60);
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

function createPdfFixture(pageCount) {
  const content = [
    "BT /F1 11 Tf 72 740 Td 0 -16 Td",
    ...Array.from({ length: 30 }, (_, index) => `(Paragraph line ${index + 1} of a representative document page for blank probing) Tj 0 -16 Td`),
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
    `<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}\nendstream`,
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
  return Buffer.from(`${body}${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "binary");
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
 * 采样「非白像素比例」。这是区分「没画」与「画了又被清空」的唯一手段 ——
 * canvas.width 在两种情况下都可以是非零。
 *
 * ⚠️ 必须同时看 alpha：**从没画过的 canvas 是透明的**（RGBA 全 0），只比 RGB 会
 * 把「透明黑」判成「有墨」，于是 ratio=1 —— 恰好把「重挂载后一帧没画」这个 bug
 * 伪装成「内容正常」。透明像素要跳过，它代表「没画过」，不代表性内容。
 */
const SAMPLE_SCRIPT = () => {
  const sampleCanvas = (canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const info = { w: canvas.width, h: canvas.height, ratio: null, error: null };
    if (info.w < 2 || info.h < 2) return info;
    try {
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return info;
      const data = ctx.getImageData(0, 0, info.w, info.h).data;
      let nonWhite = 0;
      let total = 0;
      // 逐 4 像素取样（步长 16 字节）：整页扫描太慢，采样足够分辨「有墨/全白」。
      for (let index = 0; index < data.length; index += 64) {
        if (data[index + 3] < 8) continue; // 透明 = 从没画过，不算有墨
        total += 1;
        if (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240) nonWhite += 1;
      }
      info.ratio = total ? Number((nonWhite / total).toFixed(4)) : null;
    } catch (error) {
      info.error = String(error && error.message ? error.message : error).slice(0, 80);
    }
    return info;
  };

  const hiddenAncestors = (node) => {
    const marks = [];
    let current = node;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      if (style.opacity !== "1" || style.visibility !== "visible" || style.display === "none") {
        marks.push(`${current.tagName.toLowerCase()}.${String(current.className).slice(0, 40)} opacity=${style.opacity} vis=${style.visibility} disp=${style.display}`);
      }
      if (style.contentVisibility && style.contentVisibility !== "visible") {
        marks.push(`${current.tagName.toLowerCase()} content-visibility=${style.contentVisibility}`);
      }
      current = current.parentElement;
    }
    return marks;
  };

  const pages = [...document.querySelectorAll("[data-pdf-page]")].map((block) => {
    const pageNo = Number(block.dataset.pdfPage);
    const canvas = block.querySelector("canvas.pdf-page-canvas");
    const textOverlay = block.querySelector(".page-text-overlay");
    return {
      pageNo,
      canvasMounted: Boolean(canvas),
      canvas: sampleCanvas(canvas),
      textOverlayClass: textOverlay ? String(textOverlay.className) : null,
      overlayOpacity: textOverlay ? getComputedStyle(textOverlay).opacity : null,
      rect: (() => {
        const rect = block.getBoundingClientRect();
        return { top: Math.round(rect.top), h: Math.round(rect.height) };
      })(),
      hidden: canvas ? hiddenAncestors(canvas) : [],
    };
  });

  const root = document.querySelector(".pdf-selection-scope");
  const rootRect = root ? root.getBoundingClientRect() : null;
  const inViewport = rootRect
    ? pages.filter((item) => item.rect.top < rootRect.bottom && item.rect.top + item.rect.h > rootRect.top)
    : [];

  const describeThumb = (button) => {
    const pageNo = Number(button.dataset.thumbnailPage);
    const canvas = button.querySelector("canvas");
    return {
      pageNo,
      canvasClass: canvas ? String(canvas.className) : null,
      canvas: sampleCanvas(canvas),
      placeholder: Boolean(button.querySelector(".bg-surface-sunken")),
    };
  };

  const allThumbs = [...document.querySelectorAll("[data-thumbnail-page]")];
  // 缩略图列表自己的滚动容器（含 overflow-y-auto 的那层）
  const thumbList = allThumbs[0] ? allThumbs[0].closest(".overflow-y-auto") : null;
  const thumbListRect = thumbList ? thumbList.getBoundingClientRect() : null;
  const thumbsInViewport = thumbListRect
    ? allThumbs
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.bottom > thumbListRect.top && rect.top < thumbListRect.bottom;
        })
        .map(describeThumb)
    : [];
  const thumbnails = allThumbs.slice(0, 12).map(describeThumb);

  return {
    scroll: root ? { top: Math.round(root.scrollTop), height: Math.round(root.scrollHeight), client: Math.round(root.clientHeight) } : null,
    totalPages: pages.length,
    mountedPages: pages.filter((item) => item.canvasMounted).map((item) => item.pageNo),
    viewportPages: inViewport.map((item) => item.pageNo),
    viewport: inViewport.map((item) => ({ pageNo: item.pageNo, mounted: item.canvasMounted, canvas: item.canvas, overlayOpacity: item.overlayOpacity, hidden: item.hidden })),
    thumbnails,
    thumbsInViewport,
    thumbListScroll: thumbList ? { top: Math.round(thumbList.scrollTop), client: Math.round(thumbList.clientHeight) } : null,
    // 全文档范围里「挂了 canvas 但没内容」的页 —— ②/③ 的集合
    mountedButBlank: pages.filter((item) => item.canvasMounted && item.canvas && item.canvas.w > 1 && (item.canvas.ratio ?? 0) <= 0.0005).map((item) => item.pageNo),
  };
};

async function report(page, label) {
  const data = await page.evaluate(SAMPLE_SCRIPT);
  console.log(`\n──────── ${label} ────────`);
  console.log(`滚动: top=${data.scroll?.top} client=${data.scroll?.client} height=${data.scroll?.height} | 页块总数=${data.totalPages}`);
  console.log(`挂载 PageCanvas 的页: [${data.mountedPages.join(", ")}]`);
  console.log(`视口内页: [${data.viewportPages.join(", ")}]`);
  for (const item of data.viewport) {
    const canvas = item.canvas;
    const paint = canvas ? `canvas=${canvas.w}x${canvas.h} 非白=${canvas.ratio === null ? "n/a" : canvas.ratio}${canvas.error ? ` err=${canvas.error}` : ""}` : "canvas=无";
    console.log(`  第${String(item.pageNo).padStart(3)}页 mounted=${item.mounted ? "是" : "否"} ${paint} overlayOpacity=${item.overlayOpacity}`);
    for (const mark of item.hidden) console.log(`          隐藏项: ${mark}`);
  }
  console.log(`已挂载但无内容(全白/未绘)的页: [${data.mountedButBlank.join(", ")}]`);
  console.log(`缩略图列表滚动: top=${data.thumbListScroll?.top} client=${data.thumbListScroll?.client} | 列表可视区内缩略图:`);
  for (const thumb of data.thumbsInViewport) {
    const canvas = thumb.canvas;
    console.log(`  第${String(thumb.pageNo).padStart(3)}页 ${canvas ? `${canvas.w}x${canvas.h} 非白=${canvas.ratio === null ? "n/a" : canvas.ratio}` : "无canvas"} class="${thumb.canvasClass}" 占位层=${thumb.placeholder}`);
  }
  console.log("缩略图前 12 张:");
  for (const thumb of data.thumbnails) {
    const canvas = thumb.canvas;
    console.log(`  第${String(thumb.pageNo).padStart(3)}页 ${canvas ? `${canvas.w}x${canvas.h} 非白=${canvas.ratio === null ? "n/a" : canvas.ratio}` : "无canvas"} class="${thumb.canvasClass}" 占位层=${thumb.placeholder}`);
  }
  return data;
}

async function main() {
  const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const server = spawn(serverCommand, ["run", "dev", "--", "--host", "127.0.0.1"], { stdio: "ignore", detached: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "r0nix-blank-probe-"));
  let context = null;
  try {
    await waitForServer(baseUrl);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: findBrowserExecutable(),
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: ["--no-first-run"],
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await chooserPromise).setFiles({
      name: `blank-fixture-${PAGE_COUNT}p.pdf`,
      mimeType: "application/pdf",
      buffer: createPdfFixture(PAGE_COUNT),
    });

    // ① 打开后的第一时刻：等首屏 canvas 挂上 DOM，但**【不等它可见】** ——
    // 用户描述的就是「PDF 已加载、正文空白」，所以这里要抓的正是这个窗口。
    await page.locator("[data-pdf-page] canvas.pdf-page-canvas").first().waitFor({ state: "attached", timeout: 60_000 });
    await delay(1200);
    await report(page, "① 刚打开（等 1.2s，不等可见）");

    await delay(3000);
    await report(page, "② 打开后静置 3s");

    // ③ 点缩略图（用户说点了就能看到正文）
    const thumb = page.locator("[data-thumbnail-page]").nth(2);
    await thumb.click();
    await delay(1500);
    await report(page, "③ 点击第 3 张缩略图后");

    // ④ 滚动滚轮（用户说滚一下就又空白）
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 120);
    await delay(1200);
    await report(page, "④ 滚轮向下 120px 后");

    await page.mouse.wheel(0, 120);
    await delay(1800);
    await report(page, "⑤ 再滚一次后静置");

    // ⑥ 直接跳到第 30 页（等价于「恢复上次阅读位置」：scrollTo + 一次 scheduleSync）
    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      const node = document.querySelector('[data-pdf-page="30"]');
      if (!root || !node) return;
      const rootRect = root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      root.scrollTop += nodeRect.top - rootRect.top - 12;
    });
    await delay(2000);
    await report(page, "⑥ 跳到第 30 页（模拟恢复阅读位置）");

    // ⑦ 点缩略图回第 30 页附近（用户：点一下就能看到正文）
    await page.locator('[data-thumbnail-page="30"]').click();
    await delay(1800);
    await report(page, "⑦ 点击第 30 张缩略图后");

    // ⑧ 再滚一次滚轮（用户：正文与缩略图又变空白）
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 120);
    await delay(1800);
    await report(page, "⑧ 再滚一次滚轮后");

    // ⑨ 滚动帧耗时：换「命中测试」与「几何缓存」两种实现对代价敏感，
    // 所以顺手量一组帧间隔分布，避免修正确性时把滚动性能赔回去。
    const frameStats = await page.evaluate(async () => {
      const root = document.querySelector(".pdf-selection-scope");
      if (!root) return null;
      root.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const deltas = [];
      let last = performance.now();
      for (let step = 0; step < 120; step += 1) {
        root.scrollTop += 40;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        deltas.push(now - last);
        last = now;
      }
      deltas.sort((a, b) => a - b);
      const at = (ratio) => Number(deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * ratio))].toFixed(1));
      return { p50: at(0.5), p95: at(0.95), max: Number(deltas[deltas.length - 1].toFixed(1)), frames: deltas.length };
    });
    console.log(`\n──────── ⑨ 连续滚动 120 帧的帧间隔 ────────\n  p50=${frameStats?.p50}ms p95=${frameStats?.p95}ms max=${frameStats?.max}ms（帧数 ${frameStats?.frames}）`);

    // ⑩ / ⑪ 侧栏缩略图「滚远 → 卸载 canvas → 滚回来 → 必须重画」（2026-10-10 回归）──
    //
    // 为什么必须单列这两段：侧栏缩略图的 `<canvas>` 现在只在视口 ±240px 内才挂载
    // （200 页文档里 200 个 canvas 常驻就是连续滚动 12% 慢帧的主因）。
    // 但「已渲染守卫」用的钥匙 `renderedKeyRef` 挂在**组件**上、不随 canvas 卸载而清空，
    // 于是滚回来时会「钥匙命中 → 直接 setReady(true) 却一帧没画」→ 空白缩略图。
    // 原守卫里的 `canvas.width > 1` 挡不住：**新建 canvas 的默认 width 就是 300**。
    // 只有真的「滚远再滚回」才能证否 —— 单看 DOM 数量、单看一次采样都看不出来。
    const scrollThumbListTo = (where) =>
      page.evaluate((position) => {
        const first = document.querySelector("[data-thumbnail-page]");
        const list = first ? first.closest(".overflow-y-auto") : null;
        if (!list) return null;
        list.scrollTop = position === "bottom" ? list.scrollHeight : 0;
        return { top: Math.round(list.scrollTop) };
      }, where);

    await scrollThumbListTo("bottom");
    await delay(1400);
    await report(page, "⑩ 缩略图列表滚到最底（顶部那批 canvas 应已卸载）");

    await scrollThumbListTo("top");
    await delay(1600);
    const remounted = await report(page, "⑪ 缩略图列表滚回顶部（走「重新挂载」路径）");

    const liveThumbs = remounted.thumbsInViewport.filter((thumb) => thumb.canvas && thumb.canvas.w > 1);
    const blankRemounts = liveThumbs.filter((thumb) => (thumb.canvas.ratio ?? 0) <= 0.0005);
    // 症状签名：从没画过的 canvas 会保留 HTMLCanvasElement 的默认尺寸 300×150，
    // 且内容全透明（上面的 alpha 修正后 ratio=0）。单列出来便于一眼认因。
    const neverPainted = blankRemounts.filter((thumb) => thumb.canvas.w === 300 && thumb.canvas.h === 150);
    console.log(
      `\n⇒ 滚回顶部后可视区内缩略图: ${remounted.thumbsInViewport.length} 张（有 canvas 的 ${liveThumbs.length} 张），` +
        `其中「已挂载却全白」= ${blankRemounts.length} 张${blankRemounts.length === 0 ? " ✓" : " ✗ 重新挂载后没有重画"}`,
    );
    if (neverPainted.length > 0) {
      console.log(
        `   ↳ 其中 ${neverPainted.length} 张仍是默认 300×150（` +
          `${neverPainted.map((thumb) => `第${thumb.pageNo}页`).join("、")}）—— 典型的「重挂载后一帧没画」`,
      );
    }
    if (blankRemounts.length > 0) {
      console.log(`   空白页: [${blankRemounts.map((thumb) => thumb.pageNo).join(", ")}]`);
      process.exitCode = 1;
    }
    if (liveThumbs.length === 0) {
      console.log("   ⚠️ 滚回顶部后一张缩略图都没挂载 canvas，这一段没测到东西");
      process.exitCode = 1;
    }
  } finally {
    await context?.close().catch(() => undefined);
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // server already gone
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("probe-pdf-blank failed:", error);
  process.exitCode = 1;
});
