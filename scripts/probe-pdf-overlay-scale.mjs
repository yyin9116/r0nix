/**
 * 「浮层会不会跟着缩放一起被放大」探针。
 *
 * ## 为什么需要它
 *
 * 读者报告：**伴读气泡与右键菜单也会随右键缩放放大**。
 * 但代码上这两类浮层是**不同性质**的：
 *   · 页侧批注卡（CompanionMarginCard）挂在批注栏里 —— 批注栏是
 *     `pageFlowRef` 的**后代**，而预览缩放正是写在这个元素上的
 *     （`flow.style.transform = scale(…)`，见 applyZoomPreview）。
 *     子元素被祖先的 transform 放大是**必然**的，不需要任何条件。
 *   · 右键菜单（ContextMenu）与划词气泡（ReadingAssistMenu）是
 *     `position: fixed` 且**不在**页流内 —— CSS 上它们不可能被 flow 的
 *     transform 放大（除非某个祖先带 transform/filter/will-change，
 *     那会把 fixed 的包含块改掉）。
 *
 * 「必然」与「不可能」同时出现在一份报告里，说明报告里至少有一半的
 * 归因需要修正 —— 而**修正归因不能靠读代码猜**。
 *
 * ## 判定口径（三层，逐层收窄）
 *
 * ① `visualViewport.scale` —— ≠1 就是**原生放大**（整个 WebView，含所有固定浮层）。
 *    这是「固定浮层为什么会变大」最容易被忘掉的一种解释，所以先量它。
 * ② 页流的 inline transform + `insideFlow` —— 把「会被放大」与「只是看起来像」
 *    分开。这一列是本次输出的关键：它不需要任何关于组件的先验知识。
 * ③ **全文档枚举**（不预设元素清单）—— 逐个元素记录宽度，diff 出所有
 *    「缩放预览期间宽度变了、且 `insideFlow=false`」的元素。
 *    只追踪一张手写的选择器清单是不够的：清单之外若有别的浮层在放大，
 *    输出会安静地漏掉它，而「漏掉」在这里等价于「结论下错」。
 *
 * 用法：
 *   node scripts/probe-pdf-overlay-scale.mjs [页码数]
 *   PROBE_ENGINE=webkit node scripts/probe-pdf-overlay-scale.mjs
 *   PROBE_HEADLESS=1 …（无头；几何可信，但少了合成层信息）
 *
 * ⚠️ 引擎必须选 WebKit 才有意义：读者的运行环境是 Tauri 的 WKWebView。
 * Chromium 上看不出 WebKit 的合成与视口行为差异（上一轮已吃过一次亏）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require("playwright-core");

const PAGE_COUNT = Number(process.argv[2] || 10);
const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:1420";
const ENGINE = process.env.PROBE_ENGINE === "webkit" ? "webkit" : "chromium";
const HEADLESS = process.env.PROBE_HEADLESS === "1";

/** 宽度变化超过该阈值才算「被放大」，躲开亚像素抖动。 */
const WIDTH_EPSILON = 1;

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

/** 纯文字夹具：本探针只关心几何，不需要位图（位图只在测光栅化成本时才有意义）。 */
function createPdfFixture(pageCount) {
  const content = [
    "BT /F1 11 Tf 72 740 Td 0 -16 Td",
    ...Array.from({ length: 30 }, (_, index) => `(Paragraph line ${index + 1} of a representative document page for overlay probing) Tj 0 -16 Td`),
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
      // 端口还没起来，继续等
    }
    await delay(400);
  }
  throw new Error(`dev server never came up at ${url}`);
}

/**
 * 页面内快照（**全文档**）。
 *
 * 页流的定位方式：从 `[data-pdf-page="1"]` 沿祖先向上找**第一个带 inline transform**
 * 的元素 —— 不写死 class 名，因为「谁是页流」这件事在源码里是
 * `pageFlowRef` 的绑定，而不是某个稳定的 class。找不到 = 此刻没有预览缩放，
 * 这本身是有意义的读数（不是错误）。
 */
const SNAPSHOT = () => {
  const findFlow = () => {
    let node = document.querySelector('[data-pdf-page="1"]');
    while (node) {
      if (node.style && node.style.transform) return node;
      node = node.parentElement;
    }
    return null;
  };
  const flow = findFlow();
  const zoomEl = [...document.querySelectorAll("span")]
    .map((node) => node.textContent || "")
    .find((text) => /^\d+%$/.test(text.trim()));
  const rows = [];
  let index = 0;
  for (const node of document.body.querySelectorAll("*")) {
    index += 1;
    const rect = node.getBoundingClientRect();
    // 只留「读得出来」的元素：太小的盒子宽度抖动没意义，还会把输出淹掉。
    if (rect.width < 40 || rect.height < 12) continue;
    const cls = typeof node.className === "string" ? node.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    rows.push({
      k: `${index}|${node.tagName.toLowerCase()}${cls ? "." + cls : ""}`,
      w: Math.round(rect.width * 100) / 100,
      l: Math.round(rect.left),
      inFlow: flow ? flow.contains(node) : null,
      position: getComputedStyle(node).position,
    });
  }
  return {
    zoom: zoomEl ? Number(zoomEl.trim().replace("%", "")) : null,
    visualScale: window.visualViewport ? window.visualViewport.scale : "(无 visualViewport)",
    innerWidth: window.innerWidth,
    docClientWidth: document.documentElement.clientWidth,
    flowTransform: flow ? flow.style.transform || "(空)" : "(无预览 transform)",
    menuOpen: Boolean(document.querySelector("[data-reader-context-menu]")),
    rows,
  };
};

function printHeader(label, snapshot) {
  console.log(
    `  ${label}  zoom=${snapshot.zoom}%  页面缩放=${snapshot.visualScale}  ` +
      `innerWidth=${snapshot.innerWidth}  docClientWidth=${snapshot.docClientWidth}  ` +
      `菜单在场=${snapshot.menuOpen ? "是" : "否"}`,
  );
  console.log(`    页流 transform: "${snapshot.flowTransform}"`);
}

/**
 * 对比两次全文档快照，只报「宽度变了」的。
 *
 * ★ 重点看 `inFlow=false` 的那些行：它们**不在**页流里，却被缩放了 ——
 *   那就是读者报的现象；若一条都没有，说明读者看到的「放大」另有来源
 *   （原生放大 / 看错元素），此时第一层的 `页面缩放` 读数就是分水岭。
 */
function diffWide(before, after) {
  const beforeMap = new Map(before.rows.map((row) => [row.k, row]));
  const inFlow = [];
  const outFlow = [];
  for (const row of after.rows) {
    const previous = beforeMap.get(row.k);
    if (!previous) continue;
    const delta = Math.round((row.w - previous.w) * 100) / 100;
    if (Math.abs(delta) <= WIDTH_EPSILON) continue;
    const line =
      `${row.k.slice(row.k.indexOf("|") + 1)} 宽度 ${previous.w} → ${row.w}` +
      `（${((row.w / previous.w - 1) * 100).toFixed(1)}%）left=${previous.l}→${row.l} position=${row.position}`;
    (row.inFlow ? inFlow : outFlow).push(line);
  }
  return { inFlow, outFlow };
}

function printDiff(label, diff) {
  console.log(`    ↳ ${label}`);
  if (!diff.outFlow.length && !diff.inFlow.length) {
    console.log(`        (无宽度变化)`);
    return;
  }
  if (diff.outFlow.length) {
    console.log(`        ★ 页流**外**却在变宽（读者报的就是这一类）：`);
    for (const line of diff.outFlow.slice(0, 12)) console.log(`            ${line}`);
    if (diff.outFlow.length > 12) console.log(`            …还有 ${diff.outFlow.length - 12} 个`);
  }
  if (diff.inFlow.length) {
    console.log(`        页流内随缩放变宽（预期行为）共 ${diff.inFlow.length} 个，前几个：`);
    for (const line of diff.inFlow.slice(0, 5)) console.log(`            ${line}`);
    if (diff.inFlow.length > 5) console.log(`            …还有 ${diff.inFlow.length - 5} 个`);
  }
}

async function main() {
  const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const server = spawn(serverCommand, ["run", "dev", "--", "--host", "127.0.0.1"], { stdio: "ignore", detached: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "r0nix-overlay-scale-"));
  let context = null;
  let browser = null;
  try {
    await waitForServer(baseUrl);
    console.log(`引擎：${ENGINE}${ENGINE === "webkit" ? "（对齐 Tauri 的 WKWebView 内核）" : "（仅作对照）"}`);
    if (ENGINE === "webkit") {
      browser = await webkit.launch({ headless: HEADLESS });
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    } else {
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: findBrowserExecutable(),
        headless: HEADLESS,
        viewport: { width: 1440, height: 900 },
        args: ["--no-first-run"],
      });
    }
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`   [页面异常] ${String(error).slice(0, 180)}`));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await chooserPromise).setFiles({
      name: `overlay-scale-fixture-${PAGE_COUNT}p.pdf`,
      mimeType: "application/pdf",
      buffer: createPdfFixture(PAGE_COUNT),
    });
    await page.locator("[data-pdf-page] canvas.pdf-page-canvas").first().waitFor({ state: "attached", timeout: 60_000 });
    await delay(2500);

    const box = page.locator('[data-pdf-page="1"]').first();
    const rect = await box.boundingBox();
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);

    // ── ⓪ 基线 ──────────────────────────────────────────────────────────
    console.log("\n════ ⓪ 基线（什么都没按）════");
    const baseline = await page.evaluate(SNAPSHOT);
    printHeader("基线", baseline);
    console.log(`    送进 diff 的元素数：${baseline.rows.length}`);

    // ── A. 右键按住 + 滚轮 ──────────────────────────────────────────────
    //
    // 时点必须卡在**手势期间**：`scheduleRenderZoomCommit` 在手势里会提前返回
    // （`if (rightDragRef.current.active) return`），所以预览 transform 全程在场；
    // 若在 ctrl+滚轮后隔 300ms 才采样，160ms 的提交早把它清掉了，等于没量。
    console.log("\n════ A. 右键按住 + 滚轮向上（ΔY=-120 ×3）════");
    await page.mouse.move(cx, cy);
    await delay(150);
    await page.mouse.down({ button: "right" });
    await delay(200);
    const beforeA = await page.evaluate(SNAPSHOT);
    printHeader("按下右键后", beforeA);
    for (let index = 1; index <= 3; index += 1) {
      await page.mouse.wheel(0, -120);
      await delay(320);
      const snap = await page.evaluate(SNAPSHOT);
      printHeader(`第 ${index} 拍`, snap);
      printDiff(`相对「按下右键后」`, diffWide(beforeA, snap));
    }
    await page.mouse.up({ button: "right" });
    await delay(900);
    const afterA = await page.evaluate(SNAPSHOT);
    printHeader("松手后", afterA);
    console.log(
      `  ⇒ 松手后右键菜单：${afterA.menuOpen ? "**打开了** ← 这就是「缩放频繁弹出菜单」" : "未打开"}`,
    );

    // ── B. 菜单在场 + 右键按住 + 滚轮（这一段的菜单是真的在场）─────────
    console.log("\n════ B. 菜单在场 + 右键按住 + 滚轮 ════");
    if (!afterA.menuOpen) {
      // 没有菜单就先点一个出来，保证 B 段测的是「菜单在场」这个条件。
      await page.mouse.down({ button: "right" });
      await delay(60);
      await page.mouse.up({ button: "right" });
      await delay(800);
    }
    const beforeB = await page.evaluate(SNAPSHOT);
    printHeader("菜单刚打开", beforeB);
    if (!beforeB.menuOpen) {
      console.log("  (菜单没能打开，跳过 B 段)");
    } else {
      await page.mouse.down({ button: "right" });
      await delay(200);
      const stillOpen = await page.evaluate(() => Boolean(document.querySelector("[data-reader-context-menu]")));
      console.log(`  按下右键后菜单：${stillOpen ? "仍在场" : "被关掉了"}`);
      for (let index = 1; index <= 3; index += 1) {
        await page.mouse.wheel(0, -120);
        await delay(320);
        const snap = await page.evaluate(SNAPSHOT);
        printHeader(`第 ${index} 拍`, snap);
        printDiff(`相对「菜单刚打开」`, diffWide(beforeB, snap));
      }
      await page.mouse.up({ button: "right" });
      await delay(700);
    }

    // ── C. 「页流内 UI chrome 是否被抵消」的确定性对照 ────────────────────
    //
    // 为什么不能只看真实的批注卡：它要等伴读建议落一条标注才出现，而且它多宽取决于
    // 侧栏放不放得下 —— 拿它当断言，测试会在「恰好没有标注」的运行里安静地跳过。
    //
    // 改为在页流内注入一对**同样尺寸**的对照元素：一个带抵消类、一个不带。
    // 页流被放大 v 倍时，二者实测宽度应当是 `200` 与 `200 × v` ——
    // 一条断言同时验证了「机制在位」与「机制真的生效」，不依赖任何业务状态。
    console.log("\n════ C. 页流内 UI chrome 抵消（注入 200px 对照元素）════");
    const CONTROL_CLASS = "pdf-flow-ui-chrome";
    const installed = await page.evaluate((controlClass) => {
      const page1 = document.querySelector('[data-pdf-page="1"]');
      if (!page1) return false;
      document.getElementById("probe-controls")?.remove();
      const host = document.createElement("div");
      host.id = "probe-controls";
      host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none";
      for (const [id, cls] of [["control-on", controlClass], ["control-off", ""]]) {
        const node = document.createElement("div");
        node.id = id;
        node.className = cls;
        node.style.cssText = "position:absolute;left:0;top:0;width:200px;height:10px";
        host.appendChild(node);
      }
      page1.appendChild(host);
      return true;
    }, CONTROL_CLASS);
    if (!installed) {
      console.log("  (第 1 页不在场，跳过 C 段)");
    } else {
      const readControls = () =>
        page.evaluate(() => {
          const read = (id) => {
            const node = document.getElementById(id);
            if (!node) return null;
            return Math.round(node.getBoundingClientRect().width * 100) / 100;
          };
          const flow = (() => {
            let node = document.querySelector('[data-pdf-page="1"]');
            while (node) {
              if (node.style && node.style.transform) return node;
              node = node.parentElement;
            }
            return null;
          })();
          return {
            on: read("control-on"),
            off: read("control-off"),
            inverseVar: flow ? flow.style.getPropertyValue("--reader-zoom-preview-inv") || "(未设置)" : "(无页流)",
          };
        });
      console.log(`  静止时：带类=${JSON.stringify((await readControls()).on)}  不带类=${JSON.stringify((await readControls()).off)}`);
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: "right" });
      await delay(200);
      for (let index = 1; index <= 2; index += 1) {
        await page.mouse.wheel(0, -120);
        await delay(320);
        const flowTransform = (await page.evaluate(SNAPSHOT)).flowTransform;
        const controls = await readControls();
        const scale = Number((/scale\(([\d.]+)\)/.exec(flowTransform) || [])[1] || 1);
        const expectedOn = 200;
        const expectedOff = Math.round(200 * scale * 100) / 100;
        const onOk = Math.abs((controls.on ?? 0) - expectedOn) <= 1;
        const offOk = Math.abs((controls.off ?? 0) - expectedOff) <= 2;
        console.log(
          `  第 ${index} 拍  页流=${flowTransform}  逆比例变量=${controls.inverseVar}\n` +
            `      带 .${CONTROL_CLASS} 实测=${controls.on}（期望 ${expectedOn}）${onOk ? " ✓" : " ✗"}\n` +
            `      不带类      实测=${controls.off}（期望 ${expectedOff}）${offOk ? " ✓（说明页流确实放大了）" : " ✗"}`,
        );
      }
      await page.mouse.up({ button: "right" });
      await delay(700);
      const afterControls = await readControls();
      console.log(
        `  松手后：带类=${afterControls.on}  不带类=${afterControls.off}  逆比例变量=${afterControls.inverseVar}` +
          `（都应回到 200，变量应为未设置）`,
      );
      await page.evaluate(() => document.getElementById("probe-controls")?.remove());
    }

    // ── D. 结论行 ──────────────────────────────────────────────────────
    const final = await page.evaluate(SNAPSHOT);
    console.log("\n════ 结论读数 ════");
    printHeader("收尾", final);
    console.log(
      `  · 页面缩放=${final.visualScale}  → ${final.visualScale === 1 ? "没有原生放大" : "**整个 WebView 被原生放大**"}\n` +
        `  · 页流预览 transform → 见上面各段「页流 transform」行（非空即应用内预览缩放在场）`,
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    try {
      if (server) process.kill(-server.pid, "SIGTERM");
    } catch {
      // 已经退出了
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("probe-pdf-overlay-scale failed:", error);
  process.exitCode = 1;
});
