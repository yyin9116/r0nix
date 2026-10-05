import assert from "node:assert/strict";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

globalThis.window = { localStorage: new MemoryStorage() };
const { loadResourceIndex, saveResourceIndex } = await import("../src/services/resourceIndexCache.ts");

saveResourceIndex("cache-fixture", {
  images: {
    2: [{
      xref: 17,
      pageNumber: 2,
      width: 1200,
      height: 800,
      pageWidth: 792,
      pageHeight: 612,
      extension: "png",
      bbox: [24, 36, 420, 300],
      source: "xref",
    }],
  },
  links: { 3: [] },
  pageSizes: { 1: { width: 612, height: 792 } },
  scannedPages: [1, 2, 3],
  textByPage: {
    1: "A paper with DOI 10.1234/example.",
    2: "",
  },
});

const restored = loadResourceIndex("cache-fixture");
assert.deepEqual(restored?.scannedPages, [1, 2, 3]);
assert.deepEqual(restored?.pageSizes, { 1: { width: 612, height: 792 } });
assert.equal(restored?.images[2]?.[0]?.xref, 17);
assert.equal(restored?.images[2]?.[0]?.pageWidth, 792);
assert.equal(restored?.images[2]?.[0]?.pageHeight, 612);
assert.deepEqual(restored?.images[2]?.[0]?.bbox, [24, 36, 420, 300]);
assert.deepEqual(restored?.links[3], []);
assert.equal(restored?.textByPage[1], "A paper with DOI 10.1234/example.");
assert.equal(restored?.textByPage[2], "");
assert.equal(restored?.textByPage[3], undefined);

const cacheKey = "r0nix:resource-index:cache-fixture";
const malformedEnvelope = JSON.parse(globalThis.window.localStorage.getItem(cacheKey));
malformedEnvelope.images[2] = [{
  xref: 0,
  pageNumber: 2,
  width: 0,
  height: 0,
  extension: "",
  bbox: [0, 1, Number.NaN, 3],
  source: "unknown",
}];
globalThis.window.localStorage.setItem(cacheKey, JSON.stringify(malformedEnvelope));
const sanitizedMalformed = loadResourceIndex("cache-fixture");
assert.deepEqual(sanitizedMalformed?.images[2], [], "malformed cached image records must be discarded");

const oldEnvelope = JSON.parse(globalThis.window.localStorage.getItem(cacheKey));
oldEnvelope.version = 2;
globalThis.window.localStorage.setItem(cacheKey, JSON.stringify(oldEnvelope));
assert.equal(loadResourceIndex("cache-fixture"), null, "old cache schemas must be ignored");

globalThis.window = {
  localStorage: {
    getItem() {
      throw new Error("storage access denied");
    },
  },
};
assert.equal(loadResourceIndex("unavailable-storage"), null, "unavailable storage must not break resource loading");

console.log("resource-cache: ok");
