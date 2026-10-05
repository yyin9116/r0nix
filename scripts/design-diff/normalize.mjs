/**
 * 把计算样式快照里的颜色字符串归一化成真实像素 RGBA。
 *
 * 为什么需要：Tailwind v4 的工具类产出 `oklch(0.552 0.016 285.938)`，
 * 而设计令牌产出 `rgb(113, 113, 122)` —— **同一个颜色，两种序列化**。
 * 直接比字符串会把「同一颜色的两种写法」报成差异，噪声可以盖过真回归。
 *
 * 做法：把所有出现过的颜色字符串丢进 1x1 canvas 填一次、读回 getImageData，
 * 得到该颜色在 sRGB 下的真实字节值。这是唯一不依赖我手写色域转换的可靠办法
 * （oklch → sRGB 的转换交给浏览器自己）。
 *
 * 用法：node scripts/design-diff/normalize.mjs <in.json> <out.json>
 *
 * 残留噪声（已知、可忽略）：归一化后仍会剩 ±1~2/255 的差异，例如
 * `oklch(0.705 0.015 286.067)` 实测为 `#9f9fa9`，而 tokens.css 里 zinc-400 的
 * v3 hex 写作 `#a1a1aa`。这是「Tailwind v4 的 oklch 端点」与「v3 hex 端点」
 * 的舍入差，属于同一颜色的两种写法，**不是回归**。判定时看差异幅度：
 * ≤2/255 一律忽略，≥3 才当回事。
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const COLORISH = /(color|shadow)$/i;
const inFile = path.resolve(process.argv[2]);
const outFile = path.resolve(process.argv[3]);
const snap = JSON.parse(fs.readFileSync(inFile, "utf8"));

// 1) 收集所有需要归一化的字符串
const pool = new Set();
for (const state of Object.values(snap)) {
  for (const node of Object.values(state.nodes || {})) {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== "string" || !v) continue;
      // boxShadow 里嵌着颜色，整体丢进去做一次「取色」意义不大，先按原样保留
      if (k === "boxShadow") continue;
      if (COLORISH.test(k)) pool.add(v);
    }
  }
}
console.log("待归一化颜色字符串 " + pool.size + " 个");

// 2) 交给浏览器转成真实像素
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const map = await page.evaluate((values) => {
  const cv = document.createElement("canvas");
  cv.width = 1;
  cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const out = {};
  for (const v of values) {
    ctx.clearRect(0, 0, 1, 1);
    // 非法/不理解的写法会让 fillStyle 保持上一次的值 —— 先设成魔数色做哨兵，
    // 若读回来还是哨兵色，说明这个字符串根本没被解析，原样保留不误判。
    ctx.fillStyle = "#010203";
    ctx.fillStyle = v;
    const accepted = ctx.fillStyle;
    if (accepted === "#010203") {
      out[v] = v;
      continue;
    }
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    out[v] = "rgba(" + d[0] + "," + d[1] + "," + d[2] + "," + (d[3] / 255).toFixed(3) + ")";
  }
  return out;
}, [...pool]);
await browser.close();

// 3) 回写
let replaced = 0;
for (const state of Object.values(snap)) {
  for (const node of Object.values(state.nodes || {})) {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== "string" || k === "boxShadow") continue;
      if (COLORISH.test(k) && map[v]) {
        if (map[v] !== v) replaced += 1;
        node[k] = map[v];
      }
    }
  }
}
fs.writeFileSync(outFile, JSON.stringify(snap));
console.log("已替换 " + replaced + " 处颜色为 sRGB 像素值 → " + outFile);
