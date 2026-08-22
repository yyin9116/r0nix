import assert from "node:assert/strict";
import { buildDomPdfReadingBlocks, parseMinerUContentList } from "../src/services/pdfBlocks.ts";

class TestElement {}
globalThis.HTMLElement = TestElement;

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

class TestSpan extends TestElement {
  constructor(text, bounds) {
    super();
    this.textContent = text;
    this.bounds = bounds;
  }

  getBoundingClientRect() {
    return this.bounds;
  }
}

class TestLayer extends TestElement {
  constructor(spans, bounds) {
    super();
    this.spans = spans;
    this.bounds = bounds;
  }

  querySelectorAll(selector) {
    assert.equal(selector, "span");
    return this.spans;
  }

  getBoundingClientRect() {
    return this.bounds;
  }
}

function makeTwoColumnLayer() {
  const spans = [];
  const lines = [
    ["Left column first line", "Right column first line"],
    ["Left column second line", "Right column second line"],
    ["Left column third line", "Right column third line"],
  ];
  for (const [index, [leftText, rightText]] of lines.entries()) {
    const top = 30 + index * 18;
    spans.push(new TestSpan(leftText, rect(24, top, 180, 12)));
    spans.push(new TestSpan(rightText, rect(330, top, 180, 12)));
  }
  return new TestLayer(spans, rect(0, 0, 540, 700));
}

const twoColumnBlocks = buildDomPdfReadingBlocks(makeTwoColumnLayer(), 7);
assert.equal(twoColumnBlocks.length, 2, "double-column text must produce two paragraph groups");
assert.ok(twoColumnBlocks.every((block) => !block.text.includes("Right column") || !block.text.includes("Left column")));
assert.ok(twoColumnBlocks.every((block) => block.rect && block.rect.width < 0.55), "block rect must stay within one column");

const mineruBlocks = parseMinerUContentList({
  content_list: [
    { type: "text", page_idx: 1, bbox: [100, 200, 900, 400], text: "A paragraph" },
    { type: "table", page_idx: 1, bbox: [0, 500, 1000, 900], table_body: ["A", "B"] },
    { type: "page_footnote", page_idx: 1, bbox: [0, 920, 1000, 990], text: "Footnote" },
  ],
});
assert.deepEqual(mineruBlocks.map((block) => block.kind), ["text", "table", "auxiliary"]);
assert.deepEqual(mineruBlocks[0].rect, { x: 0.1, y: 0.2, width: 0.8, height: 0.2 });
assert.equal(mineruBlocks[1].text, "A B");

console.log("pdf-blocks: ok");
