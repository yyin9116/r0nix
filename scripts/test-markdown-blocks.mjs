import assert from "node:assert/strict";
import { parseMarkdownBlocks } from "../src/services/markdownBlocks.ts";

const blocks = parseMarkdownBlocks(`Setext title
=============

# Title

1. first
2. second
   - nested

\`\`\`ts
const value = 1;
\`\`\`

| A | B |
| :- | -: |
| x | y |`, "doc-markdown");

const title = blocks.find((block) => block.kind === "title");
assert.equal(title?.depth, 1);
const lists = blocks.filter((block) => block.kind === "list");
assert.deepEqual(lists.map((block) => [block.text, block.ordered, block.depth]), [
  ["first", true, 0],
  ["second", true, 0],
  ["nested", false, 1],
]);
const code = blocks.find((block) => block.kind === "code");
assert.equal(code?.language, "ts");
const table = blocks.find((block) => block.kind === "table");
assert.deepEqual(table?.tableAlign, ["left", "right"]);
const image = parseMarkdownBlocks("![figure](https://example.com/figure.png)", "doc-markdown")[0];
assert.equal(image?.kind, "image");
assert.equal(image?.assetUrl, "https://example.com/figure.png");
assert.equal(image?.altText, "figure");
console.log("markdown-blocks: ok");
