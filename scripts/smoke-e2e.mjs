import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:1420";
const pdfLinkOnly = process.argv.includes("--pdf-link-only");
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

async function run() {
  await ensureServer();
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error("No system Chrome/Edge executable found. Set CHROME_PATH before running the browser P-level E2E.");
  }
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try {
    await page.addInitScript(() => {
      window.localStorage.clear();
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    await expectVisible(page.getByTitle("切换侧边栏"), "sidebar toggle");
    await page.getByTitle("切换侧边栏").click();
    await expectVisible(page.getByRole("button", { name: "全部文档" }), "library nav");

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
    const pdfLink = page.locator('[data-pdf-page="1"] .page-link-hit').first();
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
      await page.mouse.move(gestureBox.x + Math.min(gestureBox.width / 2, 220), gestureBox.y + 160);
      await page.mouse.down({ button: "right" });
      await page.mouse.wheel(0, -180);
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
      if (duringRightZoom.centerPage !== 1 || duringRightZoom.visiblePixels <= 0) {
        throw new Error(`Right-wheel zoom changed page or produced a blank frame: ${JSON.stringify(duringRightZoom)}`);
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
    await page.mouse.move(translationTextBox.x + translationTextBox.width / 2, translationTextBox.y + translationTextBox.height / 2);
    const highlightBlocks = page.locator('[data-pdf-page="1"] .pdf-assist-block-highlight');
    if (await highlightBlocks.count() < 1) {
      throw new Error("Translation paragraph hover did not create a highlight block.");
    }
    await expectVisible(highlightBlocks.first(), "translation paragraph highlight");
    const hoverCoverage = await page.evaluate(() => {
      const page = document.querySelector('[data-pdf-page="1"]');
      if (!(page instanceof HTMLElement)) return { spans: 0, covered: 0 };
      const rects = [...page.querySelectorAll(".textLayer span:not(.markedContent)")]
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 1 && rect.height > 1);
      const highlights = [...page.querySelectorAll(".pdf-assist-block-highlight")]
        .map((node) => node.getBoundingClientRect());
      const covered = rects.filter((span) => highlights.some((highlight) =>
        highlight.left <= span.right && highlight.right >= span.left &&
        highlight.top <= span.bottom && highlight.bottom >= span.top,
      )).length;
      return { spans: rects.length, covered };
    });
    if (hoverCoverage.spans === 0 || hoverCoverage.covered !== hoverCoverage.spans) {
      throw new Error(`Translation hover does not cover all text spans: ${JSON.stringify(hoverCoverage)}`);
    }

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
  } finally {
    await browser.close();
  }
}

run()
  .then(() => {
    console.log("smoke-e2e: ok");
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
