import { readFileSync } from "node:fs";
import { view } from "./lib/source-view.mjs";
import { readerView } from "./lib/reader-view.mjs";

const markdown = view(readFileSync("src/components/MarkdownViewer.tsx", "utf8"));
// 阅读器已拆成 1 + 4 个文件：源序比较器 compareReadingBlockOrder 落在 readerCore.ts，
// 其余并发/顺序断言仍在主体。readerView() 把模块当一个整体读。
const pdf = readerView();
const cache = view(readFileSync("src/services/translationCache.ts", "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(markdown.includes("retryAbortRef.current !== controller"), "Markdown retry results must be rejected when a newer retry owns the request slot.");
assert(markdown.includes("translationAbortRef.current !== controller"), "Markdown full-translation results must be rejected when the document request changed.");
assert(pdf.includes("translationRetryAbortRef.current !== controller"), "PDF single-block retry results must be rejected when a newer retry owns the request slot.");
const assistant = view(readFileSync("src/services/readingAssistant.ts", "utf8"));
assert(assistant.includes("const FULL_TRANSLATION_CONCURRENCY = 3"), "Full translation must use bounded concurrency.");
assert(assistant.includes("Promise.all("), "Full translation workers must run concurrently.");
assert(assistant.includes("results[index] = item"), "Concurrent translation results must preserve source block order.");
assert(pdf.includes("const blockOrder = new Map(blocks.map((block, index) => [block.id, index]))"), "Progressive PDF translation updates must know source block order.");
assert(pdf.includes("fullTranslationResultsRef.current.filter((item) => item.block.id !== latest.block.id)"), "Progressive PDF translation updates must replace completed blocks instead of duplicating them.");
assert(pdf.includes(".sort((a, b) => ("), "Progressive PDF translation updates must remain ordered while requests finish out of order.");
assert(pdf.includes("controller.signal.aborted || fullTranslationAbortRef.current !== controller"), "PDF translation progress must reject stale controllers before mutating state.");
assert(markdown.includes("belongsToCurrentBlocks"), "Markdown translation cache writes must validate results against the current block set.");
assert(cache.includes("block identity and source text below are"), "Translation cache must reuse unchanged blocks after a document edit.");
assert(!cache.includes("entry.fingerprint !== fingerprint(blocks)"), "Translation cache must not invalidate every block on any document edit.");
assert(pdf.includes("function compareReadingBlockOrder"), "PDF translation blocks must have a numeric source-order comparator.");
assert(pdf.includes(".sort(compareReadingBlockOrder)"), "PDF translation block extraction must preserve numeric source order.");
assert(markdown.includes("const order = new Map(translationBlocks.map((item, index) => [item.id, index]))"), "Markdown retries must preserve AST block order.");
const saveCache = pdf.indexOf("saveTranslationCache(\"pdf\", documentId || fileId");
const saveGuard = pdf.lastIndexOf("fullTranslationAbortRef.current !== controller", saveCache);
assert(saveCache >= 0 && saveGuard >= 0 && saveGuard < saveCache, "Full translation cache writes must be guarded by the current request.");
const fullTranslationCatch = pdf.indexOf(".catch((error) => {", saveCache);
const catchGuard = pdf.indexOf("if (fullTranslationAbortRef.current !== controller) return;", fullTranslationCatch);
assert(fullTranslationCatch >= 0 && catchGuard > fullTranslationCatch, "Stale full translation failures must not overwrite the current panel.");

console.log("translation-race-contract: ok");
