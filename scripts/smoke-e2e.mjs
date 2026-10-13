import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:1420";
const pdfLinkOnly = process.argv.includes("--pdf-link-only");
const companionOnly = process.argv.includes("--companion-only");
const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const serverArgs = ["run", "dev", "--", "--host", "127.0.0.1"];

function findBrowserExecutable() {
  const candidates = process.platform === "darwin"
    ? [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : process.platform === "win32"
      ? [
          process.env.CHROME_PATH,
          `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

let server = null;

function createPdfFixture(pageCount = 1000) {
  const content = "BT /F1 18 Tf 72 720 Td (P-level PDF fixture paragraph) Tj 0 -28 Td (Stable text layer selection and hover) Tj ET";
  const pageObjects = Array.from({ length: pageCount }, (_, index) => {
    const pageId = index + 3;
    return `${pageId} 0 R`;
  }).join(" ");
  const fontId = pageCount + 3;
  const contentId = pageCount + 4;
  const linkId = pageCount + 5;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, (_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R${index === 0 ? ` /Annots [${linkId} 0 R]` : ""} >>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [72 600 300 624] /Border [0 0 0] /A << /Type /Action /S /URI /URI (https://example.com/from-pdf) >> >>",
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
      // Server is not ready yet.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function ensureServer() {
  try {
    const response = await fetch(baseUrl);
    if (response.ok) return;
  } catch {
    // Start a dev server below.
  }

  server = spawn(serverCommand, serverArgs, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
    // Windows has no `npm` executable — it is `npm.cmd`, and Node refuses to
    // spawn a `.cmd` without a shell there (EINVAL, from the CVE-2024-27980
    // hardening). The arguments above carry no shell metacharacters.
    shell: process.platform === "win32",
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer(baseUrl);
}

async function expectVisible(locator, label) {
  await locator.waitFor({ state: "visible", timeout: 8_000 }).catch((error) => {
    throw new Error(`Expected visible: ${label}. ${error.message}`);
  });
}

/**
 * 确保侧边栏处于展开态，再继续依赖它的导航断言。
 *
 * ⚠️ 不能无脑点一次「切换侧边栏」：侧边栏现在**默认展开**（2026-10-08 反馈
 * 「默认打开状态展开左侧边栏」），无脑点一下反而把它关上，后面所有
 * 「library nav」断言就会以「找不到按钮」的形式假红 —— 而且红的原因
 * 与被测功能毫无关系。先看目标按钮在不在，不在才点。
 */
async function ensureSidebarOpen(page, label) {
  const nav = page.getByRole("button", { name: "全部文档" });
  if (await nav.isVisible().catch(() => false)) return;
  await page.getByTitle("切换侧边栏").click();
  await expectVisible(nav, label);
}

/**
 * 等气泡位置稳定（连续两次采样一致）再测几何。
 *
 * ⚠️ 气泡挂载的第一帧 anchor 还是 null（位置退化为视口 margin），下一帧才
 * 落到锚点上 —— `waitFor({visible})` 恰好会在那第一帧通过。紧接着量几何
 * 就会量到 margin 位置，与锚点位置差出整个气泡高度，断言必然假红。
 * 轮询到连续两次读数一致，也顺带吸收了展开动画的位移。
 */
async function waitForBubbleSettled(page, locator, label) {
  let previous = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    const box = await locator.boundingBox();
    if (box && previous && Math.abs(box.y - previous.y) < 1 && Math.abs(box.x - previous.x) < 1) {
      return box;
    }
    previous = box;
    await delay(120);
  }
  throw new Error(`Bubble never settled: ${label}`);
}

async function waitForStablePageTextLayer(page) {
  await page.waitForFunction(() => {
    const span = [...document.querySelectorAll('[data-pdf-page="1"] .textLayer span:not(.markedContent)')]
      .find((node) => (node.textContent || "").trim().length > 0);
    if (!(span instanceof HTMLElement)) return false;
    const rect = span.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 4 || rect.bottom <= 0 || rect.top >= innerHeight) return false;
    const probe = window.__r0nixStableTextProbe;
    if (probe?.node === span) probe.frames += 1;
    else window.__r0nixStableTextProbe = { node: span, frames: 1 };
    return window.__r0nixStableTextProbe.frames >= 3;
  }, undefined, { timeout: 10_000 });
}

async function getVisiblePageTextBox(page) {
  return page.evaluate(() => {
    const span = [...document.querySelectorAll('[data-pdf-page="1"] .textLayer span')]
      .find((node) => {
        if (!(node instanceof HTMLElement) || !(node.textContent || "").trim()) return false;
        const rect = node.getBoundingClientRect();
        return rect.width >= 8 && rect.height >= 4 && rect.bottom > 0 && rect.top < innerHeight;
      });
    if (!(span instanceof HTMLElement)) return null;
    const rect = span.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: span.textContent || "" };
  });
}

/** 伴读模型桩给出的疑问。E2E 断言页面上真的出现了这句，而不是「气泡在但空的」。 */
const COMPANION_QUESTION = "这里的注意力机制为什么能替掉循环层？";
/** 中文 UI 下工具栏按钮的 title。改名时要同步这里，否则测试会以「找不到按钮」的形式失败。 */
const COMPANION_BUTTON_TITLE = "伴读：就当前这段问一句";

/**
 * 伴读全链路回归（2026-10-05 实测踩到的三个坑，逐条钉住）：
 *
 * 1. **信封解包** —— `requestChatCompletionText` 返回的是 HTTP body 原文，也就是
 *    整个 `{"choices":[{"message":{"content":"…"}}]}`。上游忘了取 `content` 时，
 *    解析结果恒为 `[]`：气泡弹出来但是没有内容、划线标记永远不出现，而且**不报错**。
 *    所以这里的桩**必须**返回完整信封 —— 用裸 JSON 数组做桩会把这个 bug 藏起来。
 * 2. **气泡被关掉后还能再叫出来** —— 读者关掉侧边栏把气泡挤走之后，必须有
 *    手动入口重新唤出，否则这个功能等于只生效一次。
 * 3. **气泡跟随滚动 + 划线标记不重复** —— 锚点是块的归一化矩形，滚动后要重算；
 *    同一块反复唤出不能叠出第二条线。
 */
async function runCompanionRegression(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try {
    await page.addInitScript((question) => {
      window.localStorage.clear();
      // 直接预置设置（默认 Base URL 本来就指向本地服务，这里只是让意图显式）。
      window.localStorage.setItem(
        "pdf_reader_user_settings_v2",
        JSON.stringify({
          version: 4,
          updatedAt: new Date().toISOString(),
          data: {
            aiModelPath: "http://127.0.0.1:4000/v1",
            aiModelName: "mock-companion",
            // 停留触发关掉：这条回归全部由**工具栏显式唤出**驱动，否则 dwell 可能
            // 抢先落一条 content=块原文的标记，让「卡上的疑问 = 模型的疑问」这条
            // 断言不确定。停留判定本身由 companionDwell 的单测覆盖。
            companionIntensity: "off",
            companionAutoAnnotate: true,
            companionAutoAnnotateIntensity: "medium",
            companionQuickAsk: true,
          },
        })
      );
      const realFetch = window.fetch.bind(window);
      window.__r0nixCompanionCalls = 0;
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (!url.includes("/chat/completions")) return realFetch(input, init);
        window.__r0nixCompanionCalls += 1;
        const raw = typeof init?.body === "string" ? init.body : "";
        // prompt 点名了停留块（buildCompanionSuggestionMessages），桩直接回它 ——
        // 这样「模型挑了别的块」的护栏不会误伤这条用例。
        const focused = /读者停留的块：\[([^\]]+)\]/.exec(raw);
        const blockId = focused ? focused[1] : "";
        window.__r0nixCompanionBlockIds = window.__r0nixCompanionBlockIds || [];
        window.__r0nixCompanionBlockIds.push({ blockId, sawFocusLine: raw.includes("读者停留的块") });
        const content = JSON.stringify([
          {
            blockId: focused ? focused[1] : "",
            question,
            preview: "作者在此处给出核心结论。",
            reason: "本段是整页的论点所在。",
          },
        ]);
        return new Response(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            model: "mock-companion",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };
    }, COMPANION_QUESTION);

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByTitle("切换侧边栏"), "sidebar toggle (companion)");
    await ensureSidebarOpen(page, "library nav (companion)");

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await chooserPromise).setFiles({
      name: "companion-fixture.pdf",
      mimeType: "application/pdf",
      buffer: createPdfFixture(3),
    });
    await expectVisible(page.locator('[data-pdf-page="1"] canvas.pdf-page-canvas'), "PDF canvas (companion)");
    await waitForStablePageTextLayer(page);

    // ── 1) 工具栏唤出 → 批注卡落纸并展开 ─────────────────────────────────────
    // 2026-10-09 起伴读是**页侧批注卡**（margin note）：唤出 = 该块的标记落纸 +
    // 卡片展开。预热没回来时唤出会记「待展开」，标记落纸那一刻自动补展开。
    const companionButton = page.getByTitle(COMPANION_BUTTON_TITLE);
    await expectVisible(companionButton, "companion toolbar button");
    await companionButton.click();
    // 采样时间线：失败时「请求完成但卡没出」和「请求根本没发」表现一样，
    // 只有时间线能区分（wavy 片段亮过 ⇒ 标注落了纸，卡却没渲染 = 渲染层断）。
    const timeline = [];
    for (let index = 0; index < 30; index += 1) {
      const sample = await page.evaluate(() => ({
        calls: window.__r0nixCompanionCalls || 0,
        cards: document.querySelectorAll("[data-companion-margin-card]").length,
        wavySpans: document.querySelectorAll('[data-pdf-page="1"] .textLayer [class*="r0nix-marker-wavy"]').length,
      }));
      const key = `${sample.calls}/${sample.wavySpans}/${sample.cards}`;
      if (timeline[timeline.length - 1] !== key) timeline.push(key);
      if (sample.cards > 0) break;
      await delay(400);
    }
    const card = page.locator("[data-companion-margin-card]");
    await card.waitFor({ state: "visible", timeout: 5_000 }).catch(async (error) => {
      // 诊断要能一次说清「请求发出去了吗 / 线落了吗 / 卡在不在」。
      const diagnostics = await page.evaluate(() => ({
        llmCalls: window.__r0nixCompanionCalls || 0,
        cards: document.querySelectorAll("[data-companion-margin-card]").length,
        wavySpans: document.querySelectorAll('[data-pdf-page="1"] .textLayer [class*="r0nix-marker-wavy"]').length,
        storedWavy: (() => {
          try {
            const parsed = JSON.parse(window.localStorage.getItem("r0nix_reader_annotations_v1") || "null");
            const all = parsed?.data ? Object.values(parsed.data).flat() : [];
            return all.filter((item) => item.kind === "wavy").length;
          } catch {
            return "parse-error";
          }
        })(),
        servedBlockIds: window.__r0nixCompanionBlockIds || [],
      }));
      throw new Error(
        `Companion margin card never rendered: ${JSON.stringify({ ...diagnostics, timeline })}. ${error.message}`
      );
    });
    const shownQuestion = await page.locator("[data-margin-card-question]").first().innerText();
    if (!shownQuestion.includes(COMPANION_QUESTION)) {
      throw new Error(`Companion card shows the wrong question: ${JSON.stringify(shownQuestion)}`);
    }
    // 「为什么在这里出现」必须带上模型给的理由 —— 无法自报理由的主动行为 = 干扰。
    const shownReason = await page.locator("[data-margin-card-why]").getAttribute("title");
    if (!shownReason || !shownReason.includes("本段是整页的论点所在。")) {
      throw new Error(`Companion card lost its self-reported reason: ${JSON.stringify(shownReason)}`);
    }

    // ── 2) 划线标记真的落在页面上，且是 AI 留的 ────────────────────────────────
    // ⚠️ 波浪线不在标注层画（标注层刻意排除 AI wavy，防止与 text layer 的
    // 行内波浪线叠出鬼影），所以不能再找 [data-annotation-kind="wavy"] ——
    // 那个选择器在波浪线下沉到 text layer 之后就成了永远等不到的幽灵，
    // 而且失败信息看起来完全像「伴读没留线」。真正的落点是 text layer 里
    // TextLayerMarker 插入的行内片段（类名 r0nix-marker-wavy-<id>）。
    const marker = page.locator('[data-pdf-page="1"] .textLayer [class*="r0nix-marker-wavy"]');
    await marker.first().waitFor({ state: "attached", timeout: 8_000 }).catch(async (error) => {
      const calls = await page.evaluate(() => window.__r0nixCompanionCalls || 0);
      // 诊断分两层：localStorage 里有没有（创建侧的闸没过）vs 有但没画
      // （渲染侧断了）。只看 llmCalls 区分不了这两者。
      const wavyProbe = await page.evaluate(() => window.__r0nixWavyProbe || null);
      const stored = await page.evaluate(() => {
        const raw = window.localStorage.getItem("r0nix_reader_annotations_v1");
        try {
          const parsed = JSON.parse(raw || "null");
          const all = parsed?.data ? Object.values(parsed.data).flat() : [];
          return {
            documents: parsed?.data ? Object.keys(parsed.data).length : 0,
            total: all.length,
            wavy: all.filter((item) => item.kind === "wavy").length,
            sample: all[0] || null,
          };
        } catch {
          return { parseError: true, raw: (raw || "").slice(0, 200) };
        }
      });
      // live 探针：直接在页面里复算 rangesFromSpans 的输入，看断在哪一层。
      const probe = await page.evaluate(() => {
        const page1 = document.querySelector('[data-pdf-page="1"]');
        const layer = page1?.querySelector(".textLayer");
        if (!(layer instanceof HTMLElement)) return { layer: null };
        const layerRect = layer.getBoundingClientRect();
        const spans = [...layer.querySelectorAll("span")]
          .map((node) => ({ node, rect: node.getBoundingClientRect(), text: node.textContent || "" }))
          .filter((item) => item.text.replace(/\s+/g, "").length > 0 && item.rect.width > 0);
        const raw = window.localStorage.getItem("r0nix_reader_annotations_v1");
        let rect = null;
        try {
          const parsed = JSON.parse(raw || "null");
          const all = parsed?.data ? Object.values(parsed.data).flat() : [];
          rect = all.find((item) => item.kind === "wavy")?.rect || null;
        } catch {}
        let hits = -1;
        if (rect) {
          const left = layerRect.left + rect.x * layerRect.width;
          const top = layerRect.top + rect.y * layerRect.height;
          const right = left + rect.width * layerRect.width;
          const bottom = top + rect.height * layerRect.height;
          hits = spans.filter(({ rect: spanRect }) => {
            const cx = spanRect.left + spanRect.width / 2;
            const cy = spanRect.top + spanRect.height / 2;
            return cx >= left && cx <= right && cy >= top && cy <= bottom;
          }).length;
        }
        return {
          layerRect: { w: layerRect.width, h: layerRect.height },
          spanCount: spans.length,
          firstSpan: spans[0] ? { cls: spans[0].node.className, text: spans[0].text.slice(0, 30), rect: spans[0].rect } : null,
          annotationRect: rect,
          spansHitByAnnotation: hits,
        };
      });
      throw new Error(`Companion did not leave a wavy marker on page 1: llmCalls=${calls}, wavyProbe=${JSON.stringify(wavyProbe)}, stored=${JSON.stringify(stored)}, probe=${JSON.stringify(probe)}. ${error.message}`);
    });
    // 2026-10-09 起划线范围是**整个段落**（块级 rect），一个标注会在每一行
    // 文字上各插一个波浪线片段 —— 所以断言的不是「元素恰好 1 个」，而是
    // 「所有片段都属于同一个标注 id」（类名后缀 -<id>）。多行覆盖本身由
    // spansHitByAnnotation 诊断与行吸附单测兜底。
    const wavyClasses = await marker.evaluateAll((nodes) =>
      [...new Set(nodes.flatMap((node) => [...node.classList].filter((cls) => cls.startsWith("r0nix-marker-wavy"))))]
    );
    if (wavyClasses.length !== 1) {
      throw new Error(`Expected fragments of exactly one AI wavy annotation, got ${wavyClasses.length}: ${wavyClasses.join(", ")}`);
    }

    // ── 2.5) 锚点（黑点）是可点的入口，点了必须激活自己的批注卡 ─────────────
    // 2026-10-08 反馈「点击黑点无反应」：锚点走 openCompanionForBlock（与工具栏
    // 同一条路）。批注卡形态下，点锚点 = 激活该块的卡（data-active 翻转）。
    const anchor = page.locator('[data-pdf-page="1"] [data-companion-anchor="true"]');
    await anchor.first().waitFor({ state: "visible", timeout: 8_000 }).catch(async (error) => {
      const diagnostics = await page.evaluate(() => ({
        wavySpans: document.querySelectorAll('[data-pdf-page="1"] .textLayer [class*="r0nix-marker-wavy"]').length,
        anchors: document.querySelectorAll('[data-companion-anchor="true"]').length,
      }));
      throw new Error(`Companion anchor never rendered: ${JSON.stringify(diagnostics)}. ${error.message}`);
    });
    await anchor.first().click();
    await card.waitFor({ state: "visible", timeout: 8_000 }).catch(async (error) => {
      const diagnostics = await page.evaluate(() => {
        const el = document.querySelector('[data-pdf-page="1"] [data-companion-anchor="true"]');
        const rect = el?.getBoundingClientRect();
        const topEl = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
        return {
          anchorRect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
          topElementAtAnchor: topEl ? `${topEl.tagName}.${topEl.className}`.slice(0, 120) : null,
          cards: document.querySelectorAll("[data-companion-margin-card]").length,
        };
      });
      throw new Error(`Clicking the anchor did not open the companion card: ${JSON.stringify(diagnostics)}. ${error.message}`);
    });
    const activeCard = page.locator('[data-companion-margin-card][data-active="true"]');
    if ((await activeCard.count()) !== 1) {
      throw new Error(`Clicking the anchor did not activate exactly one margin card: ${await activeCard.count()}`);
    }

    // ── 3) 批注卡随文档滚动（margin note 形态的核心性质） ────────────────────
    // 旧浮动气泡需要滚动跟随逻辑才能不与段落脱开（跟随链路每一环都是脱锚故障点，
    // 实测「侧栏开合后气泡钉在旧坐标」）。批注卡挂在批注栏里、随文档自然滚动
    // —— 不存在跟随问题，因为**不需要跟随**。双向验证：滚 260px 卡必须跟着
    // 上移 260px（它属于同一段落），滚回后回到原位。
    const scrollBox = page.locator(".pdf-selection-scope");
    // scrollIntoView(smooth)（激活卡时的滚进视口）可能还在跑并与这次赋值打架，
    // 赋值后轮询到真实 scrollTop 稳定在目标值再测量；卡片基线也等它静止。
    const setScrollTop = async (value) => {
      await scrollBox.evaluate((node, top) => {
        node.scrollTop = top;
      }, value);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const top = await scrollBox.evaluate((node) => node.scrollTop);
        if (Math.abs(top - value) < 1) break;
        await scrollBox.evaluate((node, top2) => {
          node.scrollTop = top2;
        }, value);
        await delay(100);
      }
      await page.waitForTimeout(200);
    };
    const waitForCardStill = async () => {
      let previous = (await card.first().boundingBox())?.y ?? 0;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await delay(120);
        const current = (await card.first().boundingBox())?.y ?? 0;
        if (Math.abs(current - previous) < 1) return current;
        previous = current;
      }
      return previous;
    };
    const cardBoxBefore = { y: await waitForCardStill() };
    await setScrollTop(260);
    const cardBoxScrolled = await card.first().boundingBox();
    if (!cardBoxScrolled || Math.abs(cardBoxScrolled.y - (cardBoxBefore.y - 260)) > 8) {
      throw new Error(
        `Companion margin card does not scroll with the document: before=${JSON.stringify(cardBoxBefore)}, after=${JSON.stringify(cardBoxScrolled)}`
      );
    }
    await setScrollTop(0);
    const cardBoxRestored = await card.first().boundingBox();
    if (!cardBoxRestored || Math.abs(cardBoxRestored.y - cardBoxBefore.y) > 6) {
      throw new Error(
        `Companion margin card did not return to its position: before=${JSON.stringify(cardBoxBefore)}, restored=${JSON.stringify(cardBoxRestored)}`
      );
    }

    // ── 4) 「暂不提示」收掉卡与线；被拒绝的块唤出只得到告知 ───────────────────
    // 语义（2026-10-09 修订）：dismiss 把块写进否定集合并删线删卡 —— 卡线同生灭。
    // 之后手动唤出不再有任何「显式请求绕过否定集合」的通道（那条通道属于旧浮动
    // 气泡）：被拒绝的块没有卡，唤出只给一句告知，而不是无声失败。
    await page.getByRole("button", { name: "暂不提示" }).click();
    await card.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {
      throw new Error("Dismissing the companion card did not remove it.");
    });
    await companionButton.click();
    await page
      .getByText("这一段当前没有伴读批注")
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch((error) => {
        throw new Error(`Re-opening a dismissed block must surface a hint, not silence: ${error.message}`);
      });
    const markerCountAfterDismiss = await marker.count();
    if (markerCountAfterDismiss !== 0) {
      throw new Error(
        `A dismissed block must not keep or regain its wavy marker: ${markerCountAfterDismiss}`
      );
    }

    // ── 5) 工具栏用户标注工具：拖拽创建下划线，落纸的是「整行」而不是细缝 ──────
    // 2026-10-08 反馈「工具实现有问题」+ 上一轮「只看到波浪线」：横着划一道时
    // 垂直位移趋近 0，旧实现把 0.002 页高的兜底矩形直接落库 —— 屏幕上 1.7px，
    // 下划线的渐变线画在其中只剩 0.3px（亚像素），肉眼等于不存在。
    // 修复后写入侧会把矩形吸附到真实行盒。这条用例在真浏览器里走完整链路：
    // 选工具 → 拖拽 → 落纸，并量落纸矩形的实际高度。
    //
    // ⚠️ 拖拽坐标必须在点工具**之前**采样：批注工具激活会按 Acrobat 约定撤掉
    // 文本层（activeTool !== "select" → enableTextLayer=false → textHost 清空），
    // 点完工具再找 span 永远是 0 个 —— 不是 bug，是「先量坐标、后切工具」的
    // 用例结构问题。2026-10-08 实测连续两次失败于 total:0 即此因。
    const textBox = await getVisiblePageTextBox(page);
    if (!textBox) {
      const spanProbe = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('[data-pdf-page="1"] .textLayer span')];
        return {
          total: spans.length,
          withText: spans.filter((node) => (node.textContent || "").trim()).length,
          sample: spans[0]
            ? {
                text: (spans[0].textContent || "").slice(0, 30),
                rect: spans[0].getBoundingClientRect(),
              }
            : null,
          scroll: document.querySelector(".pdf-selection-scope")?.scrollTop ?? null,
        };
      });
      throw new Error(`No visible text span to measure BEFORE the underline tool click: ${JSON.stringify(spanProbe)}`);
    }
    await page.getByTitle("下划线").click();
    const dragY = textBox.y + textBox.height / 2;
    await page.mouse.move(textBox.x + 4, dragY);
    await page.mouse.down();
    // 分几步移动，模拟真实拖拽的 pointermove 序列。
    for (let stepX = 8; stepX <= textBox.width - 4; stepX += 12) {
      await page.mouse.move(textBox.x + stepX, dragY);
    }
    await page.mouse.up();
    const underline = page.locator(
      '[data-pdf-page="1"] [data-annotation-kind="underline"][data-annotation-origin="manual"]'
    );
    await underline.first().waitFor({ state: "attached", timeout: 8_000 }).catch(() => {
      throw new Error("Dragging with the underline tool did not create an annotation.");
    });
    const underlineBox = await underline.first().boundingBox();
    if (!underlineBox || underlineBox.height < 8) {
      throw new Error(
        `Underline annotation rendered too thin to see (${underlineBox?.height}px) — line snapping must lift a horizontal drag to a full line box.`
      );
    }
  } finally {
    await page.close();
  }
}

async function run() {
  await ensureServer();
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error("No system Chrome/Edge executable found. Set CHROME_PATH before running the browser P-level E2E.");
  }
  const browser = await chromium.launch({ executablePath });
  if (companionOnly) {
    await runCompanionRegression(browser);
    await browser.close();
    console.log("companion-e2e: ok");
    return;
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try {
    await page.addInitScript(() => {
      window.localStorage.clear();
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    await expectVisible(page.getByTitle("切换侧边栏"), "sidebar toggle");
    await ensureSidebarOpen(page, "library nav");

    const quickLinksToggle = page.getByRole("button", { name: "快捷链接", exact: true });
    await expectVisible(quickLinksToggle, "quick links toggle");
    await quickLinksToggle.click();
    await quickLinksToggle.waitFor({ state: "visible" });
    if ((await quickLinksToggle.getAttribute("aria-expanded")) !== "false") {
      throw new Error("Quick links did not collapse.");
    }
    await quickLinksToggle.click();
    if ((await quickLinksToggle.getAttribute("aria-expanded")) !== "true") {
      throw new Error("Quick links did not expand.");
    }

    await page.getByRole("button", { name: "白板", exact: true }).click();
    await expectVisible(page.getByRole("button", { name: "添加第一条笔记" }), "whiteboard empty state");
    await page.getByRole("button", { name: "添加第一条笔记" }).click();
    await expectVisible(page.locator(".react-flow__node"), "React Flow whiteboard card");

    const pdfChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "打开文件..." }).click();
    await (await pdfChooserPromise).setFiles({
      name: "p-level-1000-page-fixture.pdf",
      mimeType: "application/pdf",
      buffer: createPdfFixture(),
    });
    await expectVisible(page.locator('[data-pdf-page="1"] canvas.pdf-page-canvas'), "PDF canvas");
    const pageShellCount = await page.locator("[data-pdf-page]").count();
    const renderedCanvasCount = await page.locator("[data-pdf-page] canvas.pdf-page-canvas").count();
    if (pageShellCount !== 1000 || renderedCanvasCount > 8) {
      throw new Error(`Long PDF virtualization regression: ${JSON.stringify({ pageShellCount, renderedCanvasCount })}`);
    }
    // 命中区现在由 pdf.js 官方 AnnotationLayer 产出（外链 + 内部 dest 跳转都归库），
    // 不再是手写的 .page-link-hit。选择器必须跟着库走，否则「链接点不到」这条回归
    // 会在 CI 里以「找不到元素」的形式误报。
    const pdfLink = page.locator('[data-pdf-page="1"] .annotationLayer .linkAnnotation a').first();
    await expectVisible(pdfLink, "PDF hyperlink hit target");
    const linkUrl = await pdfLink.getAttribute("title");
    await pdfLink.click();
    const inAppTab = page.locator('[data-tab-id]').filter({ hasText: "example.com" }).last();
    await inAppTab.waitFor({ state: "visible", timeout: 8_000 }).catch(async () => {
      const tabs = await page.locator("[data-tab-id]").evaluateAll((nodes) => nodes.map((node) => ({
        id: node.getAttribute("data-tab-id"),
        title: node.getAttribute("title"),
        text: node.textContent?.trim(),
      })));
      throw new Error(`PDF hyperlink did not open an in-app tab: ${JSON.stringify({ linkUrl, tabs })}`);
    });
    if (pdfLinkOnly) {
      console.log("pdf-link-navigation: ok");
      return;
    }
    await page.locator('[data-tab-id]').filter({ hasText: "p-level-1000-page-fixture" }).click();
    await expectVisible(page.locator('[data-pdf-page="1"] canvas.pdf-page-canvas'), "PDF canvas after returning from hyperlink");
    // PDF.js may prepend empty or zero-sized marked-content spans. Pick a
    // text span from its measured geometry so the drag uses the painted layer.
    await waitForStablePageTextLayer(page);
    // 文本层抖动回归：任何「父组件一渲染就重跑渲染 effect」的写法都会让文本层被
    // 反复重建，读者刚划出来的选中在下一次重建时被清掉 —— 症状是「看得见却选不中」，
    // 且不报任何错。静置时不允许有任何重建。
    const idleChurn = await page.evaluate(async () => {
      const block = document.querySelector('[data-pdf-page="1"]');
      let rebuilds = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof HTMLElement && node.classList.contains("textLayer")) rebuilds += 1;
          }
        }
      });
      observer.observe(block, { childList: true, subtree: true });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      observer.disconnect();
      return rebuilds;
    });
    if (idleChurn > 0) {
      throw new Error(`PDF text layer is rebuilt while idle (${idleChurn}x/2s); native selection cannot survive it`);
    }
    const pageTextSpanCount = await page.locator('[data-pdf-page="1"] .textLayer span:not(.markedContent)').count();
    const textBox = await getVisiblePageTextBox(page);
    if (!textBox || textBox.width < 8) {
      throw new Error(`PDF.js text span has no selectable geometry: ${JSON.stringify(textBox)}`);
    }
    await page.mouse.move(textBox.x + 1, textBox.y + textBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(textBox.x + textBox.width - 1, textBox.y + textBox.height / 2);
    await page.mouse.up();
    await page.waitForFunction(() => (window.getSelection()?.toString().trim().length || 0) >= 5);
    const selectedText = await page.evaluate(() => window.getSelection()?.toString() || "");
    if (selectedText.trim().length < 5) {
      throw new Error(`PDF.js native text selection is too short: ${JSON.stringify(selectedText)}`);
    }
    if (pageTextSpanCount > 1) {
      const crossSpanText = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('[data-pdf-page="1"] .textLayer span:not(.markedContent)')]
          .filter((node) => (node.textContent || "").trim().length > 0);
        if (spans.length < 2) return "";
        const first = spans[0].firstChild;
        const last = spans[spans.length - 1].firstChild;
        if (!first || !last) return "";
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, last.textContent?.length || 0);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const value = selection?.toString() || "";
        selection?.removeAllRanges();
        return value;
      });
      if (!crossSpanText.includes("P-level PDF fixture paragraph") || !crossSpanText.includes("Stable text layer selection")) {
        throw new Error(`PDF.js cross-span selection lost adjacent text: ${JSON.stringify(crossSpanText)}`);
      }
    }
    const pdfPage = page.locator('[data-pdf-page="1"]');
    const widthBeforeZoom = (await pdfPage.boundingBox())?.width || 0;
    await page.getByTitle("放大").click();
    await page.waitForFunction((before) => {
      const pageNode = document.querySelector('[data-pdf-page="1"]');
      return pageNode instanceof HTMLElement && pageNode.getBoundingClientRect().width > Number(before) + 2;
    }, widthBeforeZoom);
    const zoomedPage = await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      const rootRect = root?.getBoundingClientRect();
      if (!rootRect) return { page: 0, visiblePixels: 0 };
      const centerPage = document.elementsFromPoint(
        rootRect.left + rootRect.width / 2,
        rootRect.top + rootRect.height / 2,
      ).map((node) => node instanceof HTMLElement ? node.closest("[data-pdf-page]") : null)
        .find((node) => node instanceof HTMLElement);
      const pageNode = document.querySelector('[data-pdf-page="1"]');
      return {
        page: centerPage instanceof HTMLElement ? Number(centerPage.getAttribute("data-pdf-page")) : 0,
        visiblePixels: pageNode instanceof HTMLElement ? pageNode.getBoundingClientRect().width * pageNode.getBoundingClientRect().height : 0,
      };
    });
    if (zoomedPage.page !== 1 || zoomedPage.visiblePixels <= 0) {
      throw new Error(`PDF zoom changed page or produced a blank page: ${JSON.stringify(zoomedPage)}`);
    }
    const gesturePage = page.locator('[data-pdf-page="1"]');
    const gestureBox = await gesturePage.boundingBox();
    if (gestureBox) {
      const cursorX = gestureBox.x + Math.min(gestureBox.width / 2, 220);
      const cursorY = gestureBox.y + 160;
      /**
       * 光标在页内的归一化位置 —— 缩放锚点正确时它应当**不变**。
       *
       * 这是「右键滚轮缩放」唯一有牙的行为断言。2026-10-10 之前这里只断言
       * 「中心还是第 1 页 + 有像素」，而那一版恰好把 transform-origin 钉在
       * 页流左上角（0 0），于是整页内容从光标下滑走 —— 中心依然是第 1 页、
       * 像素也依然非空，断言全绿。同理，提交后不补滚动的那一跳（实测 285px）
       * 也完全逃得掉。比值断言同时管住这两件事。
       */
      const anchorAt = () => page.evaluate(([x, y]) => {
        const node = document.querySelector('[data-pdf-page="1"]');
        if (!(node instanceof HTMLElement)) return null;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          nx: Number(((x - rect.left) / rect.width).toFixed(4)),
          ny: Number(((y - rect.top) / rect.height).toFixed(4)),
        };
      }, [cursorX, cursorY]);
      await page.mouse.move(cursorX, cursorY);
      await page.waitForTimeout(80);
      const anchorBefore = await anchorAt();
      await page.mouse.down({ button: "right" });
      await page.mouse.wheel(0, -180);
      await page.waitForTimeout(120);
      const anchorDuring = await anchorAt();
      const duringRightZoom = await page.evaluate(() => {
        const root = document.querySelector(".pdf-selection-scope");
        const pageNode = document.querySelector('[data-pdf-page="1"]');
        const centerPage = root instanceof HTMLElement
          ? document.elementsFromPoint(root.getBoundingClientRect().left + root.clientWidth / 2, root.getBoundingClientRect().top + root.clientHeight / 2)
            .map((node) => node instanceof HTMLElement ? node.closest("[data-pdf-page]") : null)
            .find((node) => node instanceof HTMLElement)
          : null;
        return {
          centerPage: centerPage instanceof HTMLElement ? Number(centerPage.getAttribute("data-pdf-page")) : 0,
          visiblePixels: pageNode instanceof HTMLElement ? pageNode.getBoundingClientRect().width * pageNode.getBoundingClientRect().height : 0,
        };
      });
      await page.mouse.up({ button: "right" });
      // 提交发生在 pointerup 之后 160ms，补偿滚动紧随其后；留足时间再量。
      await page.waitForTimeout(600);
      const anchorAfter = await anchorAt();
      if (duringRightZoom.centerPage !== 1 || duringRightZoom.visiblePixels <= 0) {
        throw new Error(`Right-wheel zoom changed page or produced a blank frame: ${JSON.stringify(duringRightZoom)}`);
      }
      // 2% 页宽/页高约等于 12px（612×792 的 A4），远大于定点误差、
      // 又远小于本次两个缺陷的位移（0.143 / 0.072 的归一化位置漂移，以及松手后 285px 的跳变）。
      const ANCHOR_TOLERANCE = 0.02;
      for (const [label, observed] of [["during the gesture", anchorDuring], ["after the commit", anchorAfter]]) {
        if (
          !anchorBefore ||
          !observed ||
          Math.abs(observed.nx - anchorBefore.nx) > ANCHOR_TOLERANCE ||
          Math.abs(observed.ny - anchorBefore.ny) > ANCHOR_TOLERANCE
        ) {
          throw new Error(
            `Right-wheel zoom drifted the point under the cursor ${label}: ${JSON.stringify({ anchorBefore, anchorDuring, anchorAfter })}`,
          );
        }
      }
    }
    await page.getByTitle("翻译").click();
    const scrollBeforeReaderMode = await page.locator(".pdf-selection-scope").evaluate((node) => node.scrollTop);
    await page.getByTitle("阅读").click();
    await page.waitForTimeout(360);
    const scrollAfterReaderMode = await page.locator(".pdf-selection-scope").evaluate((node) => node.scrollTop);
    if (Math.abs(scrollAfterReaderMode - scrollBeforeReaderMode) > 8) {
      throw new Error(`Reader mode changed the viewport unexpectedly: ${JSON.stringify({ scrollBeforeReaderMode, scrollAfterReaderMode })}`);
    }
    await page.getByTitle("翻译").click();
    await waitForStablePageTextLayer(page);
    const translationTextBox = await getVisiblePageTextBox(page);
    if (!translationTextBox) throw new Error("Translation PDF text has no visible geometry.");
    // 翻译模式的 hover 交互已从「段落高亮覆盖 div（.pdf-assist-block-highlight）」
    // 改为 text layer 内部的激活底色（r0nix-marker-active）——段落成员由
    // PdfReadingBlock.lines 行级 bbox 认领，覆盖 div 的整套实现
    // （drawSpanGroupHighlightElements）已在伴读重构中移除。
    // 这里断言：悬停点命中的 span 被整段激活（命中 span 自身带激活类）。
    const hoverX = translationTextBox.x + translationTextBox.width / 2;
    const hoverY = translationTextBox.y + translationTextBox.height / 2;
    await page.mouse.move(hoverX, hoverY);
    await page
      .waitForFunction(
        ([x, y]) => {
          const spans = [
            ...document.querySelectorAll('[data-pdf-page="1"] .textLayer span.r0nix-marker-active'),
          ];
          return spans.some((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y;
          });
        },
        [hoverX, hoverY],
        { timeout: 5_000 },
      )
      .catch(() => {
        throw new Error(
          "Translation paragraph hover did not activate the hovered text span (r0nix-marker-active).",
        );
      });

    await page.getByRole("button", { name: "设置" }).click();
    await expectVisible(page.getByRole("heading", { name: "设置 | 简体中文" }), "settings heading");
    await expectVisible(page.getByText("原生 WebView", { exact: true }), "native WebView setting");
    await expectVisible(page.getByText("填写 LiteLLM 或 OpenAI-compatible Base URL", { exact: false }), "model service privacy copy");

    await page.getByRole("button", { name: "深色" }).click();
    const className = await page.locator("html").getAttribute("class");
    if (!className?.includes("dark")) {
      throw new Error("Dark theme did not apply.");
    }

    await page.getByLabel("标题").fill("Example");
    await page.getByLabel("URL").fill("https://example.com");
    await page.getByRole("button", { name: "添加" }).click();
    await expectVisible(page.getByText("https://example.com"), "added quick link");

    await page.getByRole("button", { name: "网页浏览" }).click();
    await expectVisible(page.getByPlaceholder("输入网址或搜索地址"), "browser address input");
    await expectVisible(page.getByRole("button", { name: "Example" }), "browser quick link");

    await page.getByPlaceholder("输入网址或搜索地址").fill("example.com");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const input = document.querySelector("input[placeholder='输入网址或搜索地址']");
      return input instanceof HTMLInputElement && input.value === "https://example.com";
    });
    await expectVisible(page.locator("iframe[title='https://example.com']"), "browser iframe fallback");

    await page.getByPlaceholder("输入网址或搜索地址").fill("example.org");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const input = document.querySelector("input[placeholder='输入网址或搜索地址']");
      return input instanceof HTMLInputElement && input.value === "https://example.org";
    });
    await page.getByRole("button", { name: "后退" }).click();
    await page.waitForFunction(() => {
      const input = document.querySelector("input[placeholder='输入网址或搜索地址']");
      return input instanceof HTMLInputElement && input.value === "https://example.com";
    });

    // ── 6) 深处滚动后，「视口中心的页」必须仍然挂着已绘制的画布 ──────────────
    //
    // 2026-10-10 反馈「打开后正文与缩略图空白，点一下缩略图立刻可见，再滚一下就又空白」。
    // 根因在滚动帧的「当前页」判定：它曾用一份自维护的页顶几何缓存 + 二分查找，
    // 而缓存里的坐标写成 `rect.top - rootRect.top - scrollTop`、比较基准却是
    // `scrollTop + clientHeight / 2` —— 两边不在同一坐标系，等价于把阈值写成了
    // `3 × scrollTop`。**scrollTop = 0 时两种写法结果完全相同**，所以首屏正常、
    // 上面那条虚拟化断言（只在 scrollTop = 0 处量）也正常，回归就这样静默通过。
    // 深处滚动时活跃窗口会整体超前 `2 × scrollTop ÷ 页高` 页，屏幕上正在看的页
    // 被移出活跃集合（PageCanvas 卸载）→ 正文整片空白。
    //
    // 所以这条守卫必须**按在深处滚动上量**：视口中心的页要有画布、画布要有内容、
    // 页码指示器要指向这一页、虚拟化仍要成立（不能靠「全渲染」蒙混过关）。
    await page.locator('[data-tab-id]').filter({ hasText: "p-level-1000-page-fixture" }).click();
    await expectVisible(page.locator('[data-pdf-page="1"] canvas.pdf-page-canvas'), "PDF canvas before deep scroll");
    await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (!root) throw new Error("reader scroll container missing");
      // 与「恢复上次阅读位置」同一条代码路径：赋 scrollTop → 触发滚动事件 → scheduleSync。
      root.scrollTop = root.scrollHeight * 0.3;
    });
    await delay(1500);
    const deepState = await page.evaluate(() => {
      const root = document.querySelector(".pdf-selection-scope");
      if (!root) return null;
      const rootRect = root.getBoundingClientRect();
      const centerY = rootRect.top + rootRect.height / 2;
      const blocks = [...document.querySelectorAll("[data-pdf-page]")];
      const centerBlock = blocks.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top <= centerY && rect.bottom >= centerY;
      });
      const canvas = centerBlock?.querySelector("canvas.pdf-page-canvas") ?? null;
      let painted = null;
      if (canvas instanceof HTMLCanvasElement && canvas.width > 1 && canvas.height > 1) {
        const context = canvas.getContext("2d", { alpha: false });
        const data = context ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
        if (data) {
          let nonWhite = 0;
          let sampled = 0;
          for (let index = 0; index < data.length; index += 64) {
            sampled += 1;
            if (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240) nonWhite += 1;
          }
          painted = sampled ? nonWhite / sampled : null;
        }
      }
      const indicator = document.querySelector("[data-pdf-page-indicator]");
      return {
        scrollTop: Math.round(root.scrollTop),
        centerPage: centerBlock ? Number(centerBlock.dataset.pdfPage) : null,
        canvasMounted: Boolean(canvas),
        canvasSize: canvas instanceof HTMLCanvasElement ? { w: canvas.width, h: canvas.height } : null,
        painted,
        indicatorPage: indicator ? Number(indicator.getAttribute("data-pdf-page-indicator")) : null,
        mountedPages: blocks
          .filter((node) => node.querySelector("canvas.pdf-page-canvas"))
          .map((node) => Number(node.dataset.pdfPage)),
      };
    });
    if (!deepState?.centerPage) {
      throw new Error(`Deep-scroll probe could not resolve the page at the viewport center: ${JSON.stringify(deepState)}`);
    }
    if (!deepState.canvasMounted) {
      throw new Error(
        `深处滚动后视口中心的页没有画布 —— 正文会整片空白（活跃集合与视口脱节）: ${JSON.stringify(deepState)}`
      );
    }
    if (!(deepState.painted > 0)) {
      throw new Error(`深处滚动后视口中心的页已挂载但没有内容: ${JSON.stringify(deepState)}`);
    }
    if (deepState.indicatorPage !== deepState.centerPage) {
      throw new Error(
        `深处滚动后页码指示器与实际视口中心页不一致（会连带缩略图列表乱跳）: ${JSON.stringify(deepState)}`
      );
    }
    if (deepState.mountedPages.length > 8) {
      throw new Error(`深处滚动后虚拟化失效（挂载页过多）: ${JSON.stringify(deepState.mountedPages)}`);
    }
    console.log(
      `deep-scroll-virtualization: ok（视口中心第 ${deepState.centerPage} 页，已绘制 ${(deepState.painted * 100).toFixed(1)}%，` +
        `挂载 [${deepState.mountedPages.join(", ")}]）`
    );

    // 伴读走独立页面：它要预置 AI 设置并给 fetch 打桩，不能污染上面这批断言。
    await runCompanionRegression(browser);
  } finally {
    await browser.close();
  }
}

run()
  .then(() => {
    // companion-only 分支在 run() 内部已打印自己的 ok 标签；
    // 这里只在跑完整套件时打 smoke-e2e: ok，避免误导成功范围。
    if (!companionOnly) console.log("smoke-e2e: ok");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) {
      server.kill("SIGTERM");
    }
  });
