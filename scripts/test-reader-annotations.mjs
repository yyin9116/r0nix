import assert from "node:assert/strict";

// localStore 通过 `window.localStorage` 读写。这里给一个内存实现，
// 让测试走**真实的 load/save 路径**（含版本信封），而不是只测内存对象。
const storage = new Map();
globalThis.window = {
  dispatchEvent() {
    return true;
  },
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  },
};

const {
  ANNOTATIONS_KEY,
  ANNOTATIONS_STATE_VERSION,
  KNOWN_ANNOTATION_KINDS,
  isKnownAnnotationKind,
  sanitizeStoredAnnotations,
  loadStoredAnnotations,
  saveStoredAnnotations,
} = await import("../src/services/readerAnnotations.ts");

const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.02 };

function annotation(overrides = {}) {
  return {
    id: "a1",
    page: 3,
    kind: "highlight",
    rect: { ...RECT },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// 1) 白名单的四个 kind 全部必须存活。
assert.deepEqual([...KNOWN_ANNOTATION_KINDS].sort(), ["highlight", "strike", "text", "underline"]);
for (const kind of KNOWN_ANNOTATION_KINDS) {
  assert.ok(isKnownAnnotationKind(kind), `${kind} 必须被认作已知 kind`);
  const out = sanitizeStoredAnnotations({ doc: [annotation({ kind })] });
  assert.equal(out.doc.length, 1, `${kind} 必须能通过水合`);
  assert.equal(out.doc[0].kind, kind);
}

// 2) 未知 kind 被**静默丢弃** —— 这是加新 kind 时最贵的坑：
//    标注写进去了、刷新后没了，症状与「保存失败」无法区分。
//    加 `wavy` 而忘了同步白名单时，这条断言会红。
assert.ok(!isKnownAnnotationKind("wavy"));
assert.equal(isKnownAnnotationKind(undefined), false);
assert.equal(isKnownAnnotationKind(7), false);
assert.deepEqual(sanitizeStoredAnnotations({ doc: [annotation({ kind: "wavy" })] }), { doc: [] });

// 3) 逐字段重建会吞掉任何未列出的字段。这是「origin 存活」那条需求的机械依据：
//    不改这里，AI 标注的来源标记永远读不回来。
const withOrigin = sanitizeStoredAnnotations({ doc: [annotation({ origin: "ai", strength: "medium" })] }).doc[0];
assert.equal("origin" in withOrigin, false);
assert.equal("strength" in withOrigin, false);
assert.deepEqual(
  Object.keys(withOrigin).sort(),
  ["blockId", "content", "createdAt", "documentId", "id", "kind", "page", "rect"]
);

// 4) localStorage 里存的是 JSON —— 断言必须走一遍真实的序列化往返。
const stored = {
  doc: [
    annotation(),
    annotation({ id: "a2", kind: "underline", createdAt: "2026-01-02T00:00:00.000Z" }),
  ],
};
const roundTripped = sanitizeStoredAnnotations(JSON.parse(JSON.stringify(stored)));
assert.equal(roundTripped.doc.length, 2);
assert.deepEqual(roundTripped.doc.map((item) => item.id), ["a2", "a1"], "必须按 createdAt 倒序");
assert.deepEqual(roundTripped.doc[1].rect, RECT, "rect 必须原样存活");

// 5) 走真实 save/load，证明键、版本、消毒器三者真的接上了。
saveStoredAnnotations({ doc: [annotation()] });
const loaded = loadStoredAnnotations();
assert.equal(loaded.doc.length, 1);
assert.equal(loaded.doc[0].id, "a1");

const envelope = JSON.parse(storage.get(ANNOTATIONS_KEY));
assert.equal(envelope.version, ANNOTATIONS_STATE_VERSION);
assert.equal(typeof envelope.updatedAt, "string");
assert.equal("doc" in envelope, false, "批注表必须包在 data 信封里，不能与版本字段平铺");
assert.ok(Array.isArray(envelope.data.doc), "批注表必须位于 envelope.data");

// 6) 损坏输入一律退化为空表，绝不抛异常（刷新时不能把 App 打挂）。
for (const raw of [null, undefined, 0, false, "not-an-object", [1, 2, 3]]) {
  assert.deepEqual(sanitizeStoredAnnotations(raw), {}, `raw=${JSON.stringify(raw) ?? "undefined"} 必须退化为空表`);
}
assert.deepEqual(sanitizeStoredAnnotations({}), {});
assert.deepEqual(sanitizeStoredAnnotations({ doc: "not-an-array", other: null }), {}, "非数组的值必须整个跳过");

// 7) 坏记录逐条丢弃，好记录保留（不能用一条坏数据清空整个文档）。
const mixed = sanitizeStoredAnnotations({
  doc: [
    annotation({ id: "good" }),
    annotation({ id: "no-rect", rect: undefined }),
    annotation({ id: "partial-rect", rect: { x: 0, y: 0, width: 0.1 } }),
    annotation({ id: 7 }),
    annotation({ page: "3" }),
    annotation({ page: undefined }),
    { id: "not-a-page" },
    null,
  ],
});
assert.deepEqual(mixed.doc.map((item) => item.id), ["good"]);

// 8) 数值钳制：页码取整且不小于 1，rect 各分量进合法区间。
const clamped = sanitizeStoredAnnotations({
  doc: [annotation({ page: 0, rect: { x: -1, y: 2, width: 0, height: 5 } })],
}).doc[0];
assert.equal(clamped.page, 1);
assert.deepEqual(clamped.rect, { x: 0, y: 1, width: 0.002, height: 1 });
assert.equal(sanitizeStoredAnnotations({ doc: [annotation({ page: 3.6 })] }).doc[0].page, 4);

// 9) 可选字段的空字符串归一为 undefined，避免 `blockId: ""` 被当成真锚点。
const normalized = sanitizeStoredAnnotations({
  doc: [annotation({ documentId: "", blockId: "", content: 42 })],
}).doc[0];
assert.equal(normalized.documentId, undefined);
assert.equal(normalized.blockId, undefined);
assert.equal(normalized.content, undefined);

// 10) createdAt 必须总是可解析的时间戳，垃圾值不得原样带出。
const repaired = sanitizeStoredAnnotations({ doc: [annotation({ createdAt: 12345 })] }).doc[0];
assert.ok(!Number.isNaN(Date.parse(repaired.createdAt)));

// 11) 排序完整：不是只把最大的排到最前。
const sorted = sanitizeStoredAnnotations({
  doc: [
    annotation({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
    annotation({ id: "new", createdAt: "2026-03-01T00:00:00.000Z" }),
    annotation({ id: "mid", createdAt: "2026-02-01T00:00:00.000Z" }),
  ],
}).doc;
assert.deepEqual(sorted.map((item) => item.id), ["new", "mid", "old"]);

// 12) 幂等：消毒结果再消毒不变 —— 否则「刷新两次」会持续漂移。
const once = sanitizeStoredAnnotations({
  doc: [
    annotation({ createdAt: "2026-01-01T00:00:00.000Z" }),
    annotation({ id: "b", kind: "text", content: "note", createdAt: "2026-02-01T00:00:00.000Z" }),
  ],
});
assert.deepEqual(sanitizeStoredAnnotations(JSON.parse(JSON.stringify(once))), once);

// 13) 多文档分组：按 documentId 分键是这份数据的形状，不能被压平。
const grouped = sanitizeStoredAnnotations({
  "doc-a": [annotation({ documentId: "doc-a" })],
  "doc-b": [annotation({ id: "b1", documentId: "doc-b" })],
});
assert.deepEqual(Object.keys(grouped).sort(), ["doc-a", "doc-b"]);
assert.equal(grouped["doc-a"][0].documentId, "doc-a");

// 14) 更高 schema 版本的数据不得被旧版本水合 —— 确认批注确实接上了
//     localStore 的跨版本保护，而不是绕过它自己读 JSON。
//     这条会写入 forwardIncompatibleKeys，因此必须放在最后。
storage.set(
  ANNOTATIONS_KEY,
  JSON.stringify({ version: ANNOTATIONS_STATE_VERSION + 1, updatedAt: "2099-01-01T00:00:00.000Z", data: { doc: [annotation()] } })
);
assert.deepEqual(loadStoredAnnotations(), {});

console.log("reader annotations: ok");
