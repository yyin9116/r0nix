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
  images: {},
  links: {},
  scannedPages: [1, 2, 3],
  textByPage: {
    1: "A paper with DOI 10.1234/example.",
    2: "",
  },
});

const restored = loadResourceIndex("cache-fixture");
assert.deepEqual(restored?.scannedPages, [1, 2, 3]);
assert.equal(restored?.textByPage[1], "A paper with DOI 10.1234/example.");
assert.equal(restored?.textByPage[2], "");
assert.equal(restored?.textByPage[3], undefined);

const cacheKey = "r0nix:resource-index:cache-fixture";
const oldEnvelope = JSON.parse(globalThis.window.localStorage.getItem(cacheKey));
oldEnvelope.version = 2;
globalThis.window.localStorage.setItem(cacheKey, JSON.stringify(oldEnvelope));
assert.equal(loadResourceIndex("cache-fixture"), null, "old cache schemas must be ignored");

console.log("resource-cache: ok");
