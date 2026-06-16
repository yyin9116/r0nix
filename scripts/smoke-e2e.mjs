import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:1420";
const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const serverArgs = ["run", "dev", "--", "--host", "127.0.0.1"];
const macChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let server = null;

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

async function run() {
  await ensureServer();
  const browser = await chromium.launch(
    process.platform === "darwin" && existsSync(macChromePath) ? { executablePath: macChromePath } : undefined
  );
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

    await page.getByRole("button", { name: "设置" }).click();
    await expectVisible(page.getByRole("heading", { name: "设置 | 简体中文" }), "settings heading");
    await expectVisible(page.getByText("原生 WebView", { exact: true }), "native WebView setting");
    const exportFormatValues = await page
      .locator("select")
      .evaluateAll((selects) =>
        selects.flatMap((select) =>
          Array.from(select.options).map((option) => option.value)
        )
      );
    if (!exportFormatValues.includes("svg")) {
      throw new Error("Default export format select does not include SVG.");
    }
    await expectVisible(page.getByText("提问会发送选中段落、引用位置和问题到该服务"), "privacy setting copy");

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
