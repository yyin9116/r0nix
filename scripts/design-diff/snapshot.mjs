/**
 * 设计变更的「计算样式」快照器
 * ---------------------------------------------------------------------------
 * 用途：在改动 UI / 迁移令牌前后各采一次，逐元素比对计算样式。
 * **这是唯一能抓住「肉眼看不见的真回归」的手段。**
 * 实测战果：迁移期它抓出 `FIELD` 基类里的 `w-full` 盖掉了调用方的 `w-72`，
 * 输入框从 288px 被拉到 918px —— 截图上看只是「这个框宽了一点」。
 *
 * 三步管线（缺一不可）：
 *   1. node scripts/design-diff/snapshot.mjs <out.json>        # 采集
 *   2. node scripts/design-diff/normalize.mjs <in> <out.norm>  # 颜色归一化
 *   3. node scripts/design-diff/diff.mjs <before> <after>      # 归并差分
 *
 * 前两个参数为何要分开：Tailwind v4 工具类产出 `oklch(...)`、设计令牌产出 `rgb(...)`，
 * 同一个颜色有两种序列化。不先归一化，差分会被几百处「伪差异」淹没。
 *
 * 为什么用计算样式而不是截图比对：本应用的迁移要求是「深浅两色 + 6 种强调色下
 * 逐像素不变」，截图比对对亚像素、字体度量、滚动位置的噪声极敏感；计算样式是
 * 离散且确定的，噪声几乎为零，而且能直接指出「哪个节点、哪个属性、从什么变成什么」。
 *
 * 前置：需要先 `npx vite build`（脚本自带静态服务器，指向 dist/）。
 * 需要本机有 Chrome（`channel: "chrome"`）。
 *
 * 用法：node scripts/design-diff/snapshot.mjs [输出路径，默认 scripts/design-diff/out/snap.json]
 * 说明：脚本会自行注入三组种子（浅色 / 深色 / 浅色+green），无需手点设置面板。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const DIST = path.resolve("dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json",
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(DIST, p);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(4178, "127.0.0.1", r));

const outFile = path.resolve(process.argv[2] || "scripts/design-diff/out/snap.json");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const all = {};

for (const [mode, accent, name] of [
  ["light", "zinc", "settings-light"],
  ["dark", "zinc", "settings-dark"],
  ["light", "green", "settings-light-green"],
]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(
    ({ m, a }) => {
      localStorage.setItem(
        "pdf_reader_user_settings_v2",
        JSON.stringify({
          version: 3,
          updatedAt: new Date().toISOString(),
          data: { themeMode: m, themeAccent: a, language: "zh-CN" },
        }),
      );
      localStorage.setItem(
        "r0nix_reader_tabs_v1",
        JSON.stringify({
          version: 2,
          updatedAt: new Date().toISOString(),
          data: {
            tabs: [
              { id: "library-main", type: "library", title: "Library", filter: "all", pinned: true },
              { id: "settings-1", type: "settings", title: "设置", pinned: false },
            ],
            activeTabId: "settings-1",
          },
        }),
      );
    },
    { m: mode, a: accent },
  );
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4178/", { waitUntil: "load" });
  await page.waitForTimeout(2600);

  const snap = await page.evaluate(() => {
    const PROPS = [
      "backgroundColor",
      "color",
      "borderTopColor",
      "borderTopWidth",
      "borderTopStyle",
      "borderRadius",
      "boxShadow",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "marginTop",
      "marginBottom",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "display",
      "gap",
      "width",
      "height",
      "opacity",
      "outlineColor",
      "outlineWidth",
      "textAlign",
    ];
    const root = document.querySelector("#root > div");
    if (!root) return { error: "no shell" };
    const rec = (el, p) => {
      const cs = getComputedStyle(el);
      const o = {};
      for (const k of PROPS) o[k] = cs[k];
      o._sel = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "");
      o._text = (el.children.length === 0 ? (el.textContent || "").trim().slice(0, 24) : "") || "";
      return o;
    };
    const out = {};
    const walk = (el, p) => {
      out[p] = rec(el, p);
      let i = 0;
      for (const child of el.children) {
        walk(child, p + "." + i);
        i += 1;
      }
    };
    walk(root, "0");
    return { nodes: out, firstLine: root.innerText.slice(0, 40).replace(/\n/g, " | ") };
  });

  all[name] = snap;
  console.log("[" + name + "] 首行: " + (snap.firstLine || "(空)") + "  节点数: " + Object.keys(snap.nodes || {}).length);
  await context.close();
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
console.log("已写入 " + outFile);
await browser.close();
server.close();
