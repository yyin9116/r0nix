import assert from "node:assert/strict";
import { buildDomPdfReadingBlocks, groupPdfTextHighlightRects, parseMinerUContentList } from "../src/services/pdfBlocks.ts";

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

const singleColumnSpans = [
  new TestSpan("Single column left edge", rect(24, 30, 220, 12)),
  new TestSpan("Single column right edge", rect(270, 30, 246, 12)),
  new TestSpan("Single column continuation", rect(24, 48, 492, 12)),
];
const singleColumnBlocks = buildDomPdfReadingBlocks(new TestLayer(singleColumnSpans, rect(0, 0, 540, 700)), 8);
assert.equal(singleColumnBlocks.length, 1, "wide single-column text must remain one reading block");
assert.ok(singleColumnBlocks[0].text.includes("right edge"), "wide single-column block must retain its right edge");
assert.ok(singleColumnBlocks[0].rect && singleColumnBlocks[0].rect.width > 0.8, "wide single-column bbox must retain its full width");

const indentedContinuation = [
  new TestSpan("A paragraph starts here", rect(24, 30, 220, 12)),
  new TestSpan("and continues on the next line", rect(104, 47, 260, 12)),
  new TestSpan("with the final sentence.", rect(24, 64, 220, 12)),
];
const indentedBlocks = buildDomPdfReadingBlocks(new TestLayer(indentedContinuation, rect(0, 0, 540, 700)), 9);
assert.equal(indentedBlocks.length, 1, "wrapped lines with a modest indent must stay in one paragraph");

const separatedParagraphs = [
  new TestSpan("First paragraph.", rect(24, 30, 180, 12)),
  new TestSpan("Second paragraph.", rect(24, 72, 180, 12)),
];
const separatedBlocks = buildDomPdfReadingBlocks(new TestLayer(separatedParagraphs, rect(0, 0, 540, 700)), 10);
assert.equal(separatedBlocks.length, 2, "a real vertical paragraph gap must create a new block");

const highlightRects = groupPdfTextHighlightRects([
  { left: 20, top: 20, right: 100, bottom: 32 },
  { left: 104, top: 20, right: 180, bottom: 32 },
  { left: 20, top: 52, right: 92, bottom: 64 },
  { left: 320, top: 20, right: 400, bottom: 32 },
]);
assert.equal(highlightRects.length, 3, "hover geometry must split columns and separate distant lines");
assert.deepEqual(highlightRects[0], { left: 20, top: 20, right: 180, bottom: 32 });
assert.deepEqual(highlightRects[1], { left: 320, top: 20, right: 400, bottom: 32 });
assert.deepEqual(highlightRects[2], { left: 20, top: 52, right: 92, bottom: 64 });

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
