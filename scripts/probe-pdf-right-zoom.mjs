/**
 * 「按住右键 + 滚轮缩放」行为探针。
 *
 * 为什么需要它：这条链上有五层可能出错，症状却都是「缩放不对」：
 *   ① 右键状态 —— `isGestureRightDown` 是 React state，经 ref 喂给 onWheel；
 *      从 pointerdown 到 re-render 之间到达的 wheel 事件会读到陈旧值 → 丢首拍。
 *   ② 监听器选项 —— wheel 若被绑成 passive，onWheel 里的 preventDefault 静默失效，
 *      缩放的同时容器照常滚动。
 *   ③ 库侧 —— onWheel 的 delta 语义 / pinch 引擎抢事件 / 两引擎边界。
 *   ④ 换算 —— wheelZoomStep 的步进量与方向。
 *   ⑤ 锚点 —— 缩放是否锁在光标下那一点（content 不该从光标下滑走）。
 *
 * 记录方式：
 *  · wheel 录在 window **冒泡阶段** —— 冒泡到 window 时祖先（含应用挂在滚动容器上的
 *    监听）都已跑完，此时读 defaultPrevented 才是真实结果（捕获阶段读永远是 false）。
 *  · pointer/mouse/contextmenu 录在 window **捕获阶段** —— 应用在 pointerdown 里
 *    stopPropagation，冒泡到不了 window，只有捕获能看见它们。
 *  · addEventListener 被全局挂钩，记录 wheel 到底以什么 options 被绑（② 的决定性证据）。
 *
 * 用法：node scripts/probe-pdf-right-zoom.mjs [页码数]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const PAGE_COUNT = Number(process.argv[2] || 10);
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
    ...Array.from({ length: 30 }, (_, index) => `(Paragraph line ${index + 1} of a representative document page for gesture probing) Tj 0 -16 Td`),
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

/** 全局挂钩 addEventListener，记录 wheel / pointer 到底以什么 options 被绑定（② 的决定性证据）。 */
const HOOK_ADD_EVENT_LISTENER = () => {
  window.__rzBindings = [];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function addEventListenerPatched(type, listener, options) {
    if (type === "wheel" || type === "touchstart" || type === "gesturestart") {
      const node = this === window ? "window" : this === document ? "document" : (this.tagName ? this.tagName.toLowerCase() + (typeof this.className === "string" && this.className ? "." + this.className.split(/\s+/).slice(0, 2).join(".") : "") : String(this));
      window.__rzBindings.push({ type, node, options: options === undefined ? "(默认)" : JSON.stringify(options) });
    }
    return original.call(this, type, listener, options);
  };
};

/**
 * 挂钩 scrollTop / scrollLeft 的 setter，记下**是谁在什么时候把滚动位置改成了多少**。
 * 用于回答「补偿到底没跑、还是跑了又被谁改回去了」—— 只看最终值区分不了这两种。
 */
const HOOK_SCROLL_WRITES = () => {
  window.__rzScrollWrites = [];
  for (const prop of ["scrollTop", "scrollLeft"]) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get: descriptor.get,
      set(value) {
        const frames = String((new Error()).stack || "")
          .split("\n")
          .slice(2)
          .map((line) => (/(?:src|scripts)\/[^\s:)]+/.exec(line) || [""])[0])
          .filter(Boolean)
          .slice(0, 3);
        const el = this;
        window.__rzScrollWrites.push({
          t: Math.round(performance.now()),
          prop,
          from: Math.round(descriptor.get.call(el)),
          to: Math.round(Number(value)),
          node: el === window ? "window" : (el.className && typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 2).join(".") : String(el.tagName || "?")),
          frames,
        });
        return descriptor.set.call(el, value);
      },
    });
  }
};

/** 事件录像：wheel 冒泡 / pointer 捕获（见文件头）。 */
const INSTALL_RECORDERS = () => {
  const short = (node) => {
    if (!node) return "(none)";
    const tag = node.tagName ? node.tagName.toLowerCase() : "?";
    const cls = typeof node.className === "string" ? node.className.split(/\s+/).slice(0, 3).join(".") : "";
    return cls ? `${tag}.${cls}` : tag;
  };
  window.__rzWheel = [];
  window.__rzPointer = [];
  window.addEventListener(
    "wheel",
    (event) => {
      window.__rzWheel.push({
        t: Math.round(performance.now()),
        deltaY: Math.round(event.deltaY * 100) / 100,
        deltaMode: event.deltaMode,
        buttons: event.buttons,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        cancelable: event.cancelable,
        prevented: event.defaultPrevented,
        target: short(event.target),
      });
    },
    false,
  );
  for (const type of ["pointerdown", "pointerup", "pointercancel", "contextmenu"]) {
    window.addEventListener(
      type,
      (event) => {
        window.__rzPointer.push({
          t: Math.round(performance.now()),
          type,
          button: "button" in event ? event.button : null,
          buttons: "buttons" in event ? event.buttons : null,
          target: short(event.target),
        });
      },
      true,
    );
  }
};

/** 应用可读状态：缩放百分比、滚动位置、光标语义，以及页流上的实际 transform。 */
const READ_STATE = () => {
  const root = document.querySelector(".pdf-selection-scope");
  const zoomText = [...document.querySelectorAll("span")]
    .map((node) => node.textContent || "")
    .find((text) => /^\d+%$/.test(text.trim()));
  const page1 = document.querySelector('[data-pdf-page="1"]');
  const rectOf = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
  };
  // 页流：page block 的父级里带 transform 的那一层
  let flow = page1 ? page1.parentElement : null;
  while (flow && getComputedStyle(flow).transform === "none" && flow.parentElement) {
    if (flow.style && flow.style.transform) break;
    flow = flow.parentElement;
  }
  const rootRect = root ? root.getBoundingClientRect() : null;
  return {
    zoom: zoomText ? Number(zoomText.trim().replace("%", "")) : null,
    scrollTop: root ? Math.round(root.scrollTop) : null,
    scrollLeft: root ? Math.round(root.scrollLeft) : null,
    cursor: root ? getComputedStyle(root).cursor : null,
    rootRect: rootRect ? { left: Math.round(rootRect.left), top: Math.round(rootRect.top) } : null,
    page1: rectOf(page1),
    flow: flow
      ? {
          cls: String(flow.className).slice(0, 60),
          rect: rectOf(flow),
          inlineTransform: flow.style.transform || "(空)",
          inlineOrigin: flow.style.transformOrigin || "(空)",
          computedTransform: getComputedStyle(flow).transform,
          computedOrigin: getComputedStyle(flow).transformOrigin,
        }
      : null,
  };
};

async function state(page) {
  return page.evaluate(READ_STATE);
}

async function drain(page) {
  return page.evaluate(() => {
    const wheel = window.__rzWheel || [];
    const pointer = window.__rzPointer || [];
    const scroll = window.__rzScrollWrites || [];
    window.__rzWheel = [];
    window.__rzPointer = [];
    window.__rzScrollWrites = [];
    return { wheel, pointer, scroll };
  });
}

function printScrollWrites(rows, label) {
  console.log(`  ${label}期间写过的滚动位置:`);
  if (!rows.length) {
    console.log("   (无)");
    return;
  }
  for (const row of rows) {
    console.log(`   ${row.prop} ${row.from} → ${row.to} (${row.node}) ← ${row.frames.join(" ← ")}`);
  }
}

function printWheel(rows) {
  if (!rows.length) {
    console.log("   (无 wheel 事件到达 window)");
    return;
  }
  for (const row of rows) {
    const keys = `${row.ctrl ? "ctrl " : ""}${row.meta ? "meta " : ""}`.trim() || "-";
    console.log(
      `   ΔY=${String(row.deltaY).padStart(8)} mode=${row.deltaMode} buttons=${row.buttons} 键=${keys} ` +
        `可取消=${row.cancelable} 已阻止默认=${row.preventDefaulted ? "是" : "否"} 目标=${row.target}`,
    );
  }
}

function printPointer(rows) {
  if (!rows.length) {
    console.log("   (无 pointer/contextmenu 事件)");
    return;
  }
  for (const row of rows) {
    console.log(`   ${row.type.padEnd(13)} button=${row.button} buttons=${row.buttons} 目标=${row.target}`);
  }
}

/** 光标下的「内容锚点」：光标相对第 1 页左上角的归一化位置。锚点正确时它应当不变。 */
function anchorOf(snapshot, x, y) {
  if (!snapshot.page1) return null;
  return {
    nx: Number(((x - snapshot.page1.left) / snapshot.page1.w).toFixed(3)),
    ny: Number(((y - snapshot.page1.top) / snapshot.page1.h).toFixed(3)),
  };
}

function describe(label, snapshot, x, y) {
  const anchor = anchorOf(snapshot, x, y);
  console.log(
    `  ${label}: zoom=${snapshot.zoom}% 滚动=(${snapshot.scrollLeft},${snapshot.scrollTop}) cursor=${snapshot.cursor} ` +
      `锚点=${JSON.stringify(anchor)} 页1=${JSON.stringify(snapshot.page1)}`,
  );
  if (snapshot.flow) {
    console.log(
      `      页流: ${snapshot.flow.cls} rect=${JSON.stringify(snapshot.flow.rect)} ` +
        `transform="${snapshot.flow.inlineTransform}" origin="${snapshot.flow.inlineOrigin}"`,
    );
    console.log(
      `      计算态: transform=${snapshot.flow.computedTransform} origin=${snapshot.flow.computedOrigin}`,
    );
  }
}

async function main() {
  const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const server = spawn(serverCommand, ["run", "dev", "--", "--host", "127.0.0.1"], { stdio: "ignore", detached: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "r0nix-right-zoom-"));
  let context = null;
  try {
    await waitForServer(baseUrl);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: findBrowserExecutable(),
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: ["--no-first-run"],
    });
    await context.addInitScript(HOOK_ADD_EVENT_LISTENER);
    await context.addInitScript(HOOK_SCROLL_WRITES);
    const page = await context.newPage();
    page.on("console", (message) => {
      if (/\[rz\]/.test(message.text())) console.log(`   [应用] ${message.text().slice(0, 200)}`);
      else if (message.type() === "warning" && /preventDefault|passive/i.test(message.text())) {
        console.log(`   [页面警告·passive] ${message.text().slice(0, 220)}`);
      }
    });
    page.on("pageerror", (error) => console.log(`   [页面异常] ${String(error).slice(0, 300)}`));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTitle("切换侧边栏").waitFor({ state: "visible", timeout: 30_000 });

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await chooserPromise).setFiles({
      name: `right-zoom-fixture-${PAGE_COUNT}p.pdf`,
      mimeType: "application/pdf",
      buffer: createPdfFixture(PAGE_COUNT),
    });

    await page.locator("[data-pdf-page] canvas.pdf-page-canvas").first().waitFor({ state: "attached", timeout: 60_000 });
    await delay(2500);
    await page.evaluate(INSTALL_RECORDERS);

    // ── 0. 监听器绑定审计：wheel 是 passive 绑的吗？─────────────────────
    const bindings = await page.evaluate(() => window.__rzBindings || []);
    console.log("\n════ 0. wheel 监听器的绑定选项（passive 会让 preventDefault 静默失效）════");
    if (!bindings.length) console.log("   (addEventListener 挂钩未捕获任何 wheel 绑定)");
    for (const binding of bindings) console.log(`   ${binding.type.padEnd(12)} 绑在 ${binding.node}  options=${binding.options}`);

    const box = page.locator('[data-pdf-page="1"]').first();
    const rect = await box.boundingBox();
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);

    // ── A. 右键按住 + 滚轮向上：zoom 应逐拍上升，且锚在光标 ──────────────
    console.log("\n════ A. 右键按住 + 滚轮向上（ΔY=-120 ×3）════");
    await page.mouse.move(cx, cy);
    await delay(150);
    await drain(page);
    describe("按下前", await state(page), cx, cy);

    await page.mouse.down({ button: "right" });
    describe("按下右键后", await state(page), cx, cy);
    await delay(200);

    for (let index = 1; index <= 3; index += 1) {
      await page.mouse.wheel(0, -120);
      await delay(450);
      describe(`第 ${index} 拍后`, await state(page), cx, cy);
    }
    await page.mouse.up({ button: "right" });
    await delay(700);
    describe("松手后静置", await state(page), cx, cy);
    let log = await drain(page);
    printScrollWrites(log.scroll, "A 松手后");
    console.log("  录到的 wheel 事件:");
    printWheel(log.wheel);
    console.log("  录到的 pointer/contextmenu 事件:");
    printPointer(log.pointer);

    // ── A2. 右键按住 + 滚轮向下：检测 preventDefault 是否失效（容器是否偷滚）──
    console.log("\n════ A2. 右键按住 + 滚轮向下（ΔY=+120 ×2）—— 检测容器是否偷滚 ════");
    await page.mouse.move(cx, cy);
    await delay(150);
    const beforeA2 = await state(page);
    await drain(page);
    describe("按下前", beforeA2, cx, cy);
    await page.mouse.down({ button: "right" });
    await delay(200);
    for (let index = 1; index <= 2; index += 1) {
      await page.mouse.wheel(0, 120);
      await delay(450);
      describe(`第 ${index} 拍后`, await state(page), cx, cy);
    }
    await page.mouse.up({ button: "right" });
    await delay(500);
    const afterA2 = await state(page);
    console.log(
      `  ⇒ 缩放 ${beforeA2.zoom}% → ${afterA2.zoom}%；scrollTop ${beforeA2.scrollTop} → ${afterA2.scrollTop}` +
        `（右键缩放下容器不该滚；变了就是 preventDefault 失效）`,
    );
    log = await drain(page);
    printWheel(log.wheel);

    // ── B. 无按键滚轮：必须只滚动、不缩放 ────────────────────────────────
    console.log("\n════ B. 无按键滚轮（ΔY=+120 ×2）——应当只滚动、不缩放 ════");
    const beforeB = await state(page);
    await drain(page);
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 120);
    await delay(400);
    await page.mouse.wheel(0, 120);
    await delay(500);
    const afterB = await state(page);
    console.log(
      `  zoom ${beforeB.zoom}% → ${afterB.zoom}%（应不变）| scrollTop ${beforeB.scrollTop} → ${afterB.scrollTop}（应变大）`,
    );
    log = await drain(page);
    printWheel(log.wheel);

    // ── C. 右键拖拽 = 平移，且不弹上下文菜单 ─────────────────────────────
    console.log("\n════ C. 右键拖拽（平移）════");
    const beforeC = await state(page);
    await drain(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(cx, cy - step * 20);
      await delay(30);
    }
    await page.mouse.up({ button: "right" });
    await delay(700);
    const afterC = await state(page);
    log = await drain(page);
    console.log(
      `  scrollTop ${beforeC.scrollTop} → ${afterC.scrollTop}（向上拖 120px 应变大 120）| ` +
        `zoom ${beforeC.zoom}% → ${afterC.zoom}%（应不变）`,
    );
    console.log(`  拖拽期间 contextmenu 事件数=${log.pointer.filter((row) => row.type === "contextmenu").length}（应为 0）`);

    // ── D. 右键原地点击 = 上下文菜单 ─────────────────────────────────────
    console.log("\n════ D. 右键原地点击（不移动）——应弹上下文菜单 ════");
    await drain(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    await delay(60);
    await page.mouse.up({ button: "right" });
    await delay(900);
    log = await drain(page);
    const menuHit = await page.evaluate(() => /导出|复制|设为/.test(document.body.innerText));
    console.log(
      `  contextmenu 事件数=${log.pointer.filter((row) => row.type === "contextmenu").length}（应 ≥1）| 菜单文本命中=${menuHit}`,
    );

    // ── E. 首拍丢失检测：pointerdown 后立刻滚 ────────────────────────────
    console.log("\n════ E. pointerdown 后「立刻」滚（不等待）——检测首拍是否被丢 ════");
    await page.getByTitle("重置缩放").click().catch(() => console.log("   (重置缩放按钮未找到)"));
    await delay(900);
    const beforeE = await state(page);
    await drain(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    await page.mouse.wheel(0, -120);
    await delay(500);
    await page.mouse.up({ button: "right" });
    await delay(500);
    const afterE = await state(page);
    log = await drain(page);
    console.log(`  zoom ${beforeE.zoom}% → ${afterE.zoom}%（期望 +16~24；若不变则该拍被丢）`);
    printWheel(log.wheel);

    // ── F. 复位锚点复现：同一手势连滚，看锚点是否越跑越远 ────────────────
    console.log("\n════ F. 复位后再测一遍锚点漂移（连滚 5 拍）════");
    await page.getByTitle("重置缩放").click().catch(() => undefined);
    await delay(900);
    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (root) {
        root.scrollTop = 0;
        root.scrollLeft = 0;
      }
    });
    await delay(600);
    await drain(page);
    await page.mouse.move(cx, cy);
    await delay(150);
    describe("起点", await state(page), cx, cy);
    await page.mouse.down({ button: "right" });
    await delay(150);
    for (let index = 1; index <= 5; index += 1) {
      await page.mouse.wheel(0, -120);
      await delay(400);
      describe(`第 ${index} 拍`, await state(page), cx, cy);
    }
    await page.mouse.up({ button: "right" });
    await delay(800);
    describe("松手后", await state(page), cx, cy);
    printScrollWrites((await drain(page)).scroll, "F 松手后");

    // ── G. 缩放手势**不得**弹上下文菜单（2026-10-10 修的回归）────────────
    //
    // 为什么这条必须是行为断言、不能只靠结构守卫：判据本身在代码里长得「有道理」——
    // 「没有平移过 = 原地点击」。而右键按住 + 滚轮**根本不移动指针**，
    // 于是 `moved` 恒为假，每一次缩放松手都被判成原地点击。
    // 这个错误只有真的按住右键滚一下再松手才能证否。
    console.log("\n════ G. 右键按住 + 滚轮 → 松手**不得**弹菜单 ════");
    await page.evaluate(() => document.querySelector("[data-reader-context-menu]")?.remove());
    await page.getByTitle("重置缩放").click().catch(() => undefined);
    await delay(900);
    const beforeG = await state(page);
    await page.mouse.move(cx, cy);
    await delay(150);
    await page.mouse.down({ button: "right" });
    for (let index = 1; index <= 3; index += 1) {
      await page.mouse.wheel(0, -120);
      await delay(320);
    }
    await page.mouse.up({ button: "right" });
    await delay(900);
    const afterG = await state(page);
    const menuAfterZoom = await page.evaluate(() => Boolean(document.querySelector("[data-reader-context-menu]")));
    const zoomMoved = beforeG.zoom !== afterG.zoom;
    console.log(
      `  zoom ${beforeG.zoom}% → ${afterG.zoom}%（必须变了，否则这一段没测到东西）| 松手后菜单=${
        menuAfterZoom ? "**打开了** ✗ 缩放会把菜单弹出来" : "未打开 ✓"
      }`,
    );
    if (menuAfterZoom) process.exitCode = 1;
    if (!zoomMoved) {
      console.log("  ⚠️ 这一段没缩放成功，结论不成立 —— 请检查上面的 wheel 录像");
      process.exitCode = 1;
    }

    // ── H. 对照组：原地右键点击**仍应**弹菜单（别把功能一起修掉）────────
    console.log("\n════ H. 对照组：原地右键点击（不移动、不缩放）→ 应弹菜单 ════");
    await page.mouse.down({ button: "right" });
    await delay(60);
    await page.mouse.up({ button: "right" });
    await delay(900);
    const clickedMenu = await page.evaluate(() => Boolean(document.querySelector("[data-reader-context-menu]")));
    console.log(`  松手后菜单=${clickedMenu ? "打开了 ✓" : "**没打开** ✗ 原地右键点击不该被一起改掉"}`);
    if (!clickedMenu) process.exitCode = 1;
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
  console.error("probe-pdf-right-zoom failed:", error);
  process.exitCode = 1;
});
