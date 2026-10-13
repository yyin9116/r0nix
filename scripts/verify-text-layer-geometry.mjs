/**
 * 真 PDF 上的段落切分验证。
 *
 * 为什么需要它：单测用的是手写矩形，而真实的 text layer 几何由 pdf.js 按
 * `transform` 矩阵算出，两者未必一致。这个脚本把**真实的 pdf.js 文本项**
 * 与**真实的 pymupdf 行级 bbox** 放在一起跑一遍
 * `splitSpansIntoParagraphsByLines` 的判定，验证：
 *
 * 1. 三段能被切成三组（不多不少）；
 * 2. 每组的文本内容与原段落一致（不串段、不丢字）；
 * 3. 段内行数正确（3 行/段）。
 *
 * 用法：
 *   /opt/anaconda3/bin/python3 scripts/make-geometry-fixture.py   # 生成 PDF + 行 bbox
 *   node --experimental-strip-types scripts/verify-text-layer-geometry.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { collectBlockSpansByLines } from "../src/components/pdfReader/textLayerMarker.ts";

const PDF_PATH = "/tmp/marker-check/three-paras.pdf";
const LINES_JSON = "/tmp/marker-check/lines.json";

// 标准字体数据：不给的话 pdf.js 会为每个字形打一条警告。几何不受影响，
// 但噪声会淹没真正的失败信息。
const require = createRequire(import.meta.url);
const standardFontDataUrl = `${require
  .resolve("pdfjs-dist/package.json")
  .replace(/package\.json$/, "")}standard_fonts/`;

const blocksByLines = JSON.parse(readFileSync(LINES_JSON, "utf8"));
const doc = await getDocument({
  url: PDF_PATH,
  useSystemFonts: false,
  standardFontDataUrl,
}).promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 1 });
const textContent = await page.getTextContent();

/**
 * 复刻 `TextLayer` 的定位：`transform` 给出基线原点，按 fontHeight 向上展开。
 * 高度取 `Math.abs(transform[3])`，与 pdf.js `#layout` 写入 `--font-height` 同源。
 *
 * 坐标系换算是这里最容易出错的地方：pdf.js 的 transform 是**自底向上**的，
 * 而 pymupdf 的 bbox 是**自顶向下**的，两者差一个页高。忘了换算，
 * 行 bbox 会整体上下颠倒 —— 判定仍然「看起来能跑」，但结果是错的。
 */
const spans = [];
for (const item of textContent.items) {
  if (!item.str || !item.str.trim()) continue;
  const [, , , fontHeight, x, y] = item.transform;
  const width = item.width || 0;
  const height = Math.abs(fontHeight) || item.height || 0;
  spans.push({
    text: item.str,
    // 客户端坐标系的 top = 页高 - 基线 -  ascent（近似用 height）。
    top: viewport.height - y - height,
    bottom: viewport.height - y,
    left: x,
    right: x + width,
  });
}

const layerRect = {
  left: 0,
  top: 0,
  width: viewport.width,
  height: viewport.height,
  right: viewport.width,
  bottom: viewport.height,
};

/**
 * `splitSpansIntoParagraphsByLines` 读的是 `rect.width` / `rect.height`，
 * 不是 `right` / `bottom` —— 这里补齐，避免拿到 `undefined` 而全部落空
 * （症状是「0 段」，且不报错）。
 */
const asSpanGeometry = (span) => ({
  node: span,
  rect: {
    left: span.left,
    top: span.top,
    right: span.right,
    bottom: span.bottom,
    width: span.right - span.left,
    height: span.bottom - span.top,
  },
});

/**
 * 逐 block 认领 span —— 这才是调用方（PageCanvas 的 `resolveParagraphGroup`）的用法：
 * 一个 block 的 `lines` 喂进去，拿回该 block 的全部 span。
 *
 * 核心要验的性质：**pymupdf 的 block 边界 = 自然段边界**。
 * 三个 block 合起来应当正好是三个互不重叠的段落。
 */
const allSpans = spans.map(asSpanGeometry);
const paragraphs = blocksByLines
  .map((lines) => collectBlockSpansByLines(allSpans, lines, layerRect))
  .filter((paragraph) => paragraph.length > 0);

// 段落之间不得共享 span —— 共享就意味着划词会重复选中同一段文字。
const allNodes = paragraphs.flat().map((item) => item.node);
assert.equal(
  allNodes.length,
  new Set(allNodes).size,
  "段落之间出现重复 span（同一段文字被两个段落各认领一次）",
);

// ── 断言：段落数 = block 数 ─────────────────────────────────────────────
assert.equal(
  blocksByLines.length,
  3,
  `pymupdf 应给出 3 个 block，实际 ${blocksByLines.length}`,
);
assert.equal(paragraphs.length, 3, `应切成 3 段，实际 ${paragraphs.length} 段`);

const joined = paragraphs.map((paragraph) =>
  paragraph.map((item) => item.node.text).join(" "),
);
const expectedPrefixes = ["Alpha", "Bravo", "Charlie"];
paragraphs.forEach((paragraph, index) => {
  assert.equal(paragraph.length, 3, `第 ${index + 1} 段应有 3 行 span，实际 ${paragraph.length}`);
  assert.ok(
    joined[index].startsWith(expectedPrefixes[index]),
    `第 ${index + 1} 段应以 "${expectedPrefixes[index]}" 开头，实际 "${joined[index].slice(0, 24)}"`,
  );
});

// 段间不得互串：每一段里只能出现它自己的关键词。
const keywords = { Alpha: 0, Bravo: 0, Charlie: 0 };
paragraphs.forEach((paragraph, index) => {
  const text = joined[index];
  for (const keyword of Object.keys(keywords)) {
    const count = (text.match(new RegExp(keyword, "g")) || []).length;
    if (keyword === expectedPrefixes[index]) {
      assert.ok(count >= 1, `第 ${index + 1} 段应含 "${keyword}"`);
    } else {
      assert.equal(count, 0, `第 ${index + 1} 段混入了第 ${keywords[keyword] + 1} 段的 "${keyword}"`);
    }
  }
});

console.log("真PDF 段落切分：3 段各自独立，无串段");
paragraphs.forEach((paragraph, index) => {
  const first = joined[index].slice(0, 34);
  console.log(`  段 ${index + 1}（${paragraph.length} 行）: ${first}…`);
});
