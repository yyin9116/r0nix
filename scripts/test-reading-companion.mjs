import assert from "node:assert/strict";

/**
 * 伴读本地状态的行为断言：否定集合（§3.5）+ 密度档位（§3.4 / §7）。
 *
 * 与 test-reader-annotations.mjs 同样走**真实的 localStorage 往返**（含版本信封），
 * 而不是只测内存对象 —— 落盘是这个模块的全部意义，绕开它就等于没测。
 */

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
  COMPANION_DISMISSED_KEY,
  COMPANION_DISMISSED_STATE_VERSION,
  COMPANION_INTENSITIES,
  DEFAULT_COMPANION_STATS,
  companionSignalScore,
  deriveIntensity,
  dismissCompanionBlock,
  dismissalForRemovedAnnotation,
  isBlockDismissed,
  loadDismissedBlocks,
  sanitizeDismissedBlocks,
} = await import("../src/services/readingCompanion.ts");

// ─────────────────────────────────────────────────────────────────────────────
// 1) 否定集合：写进去的必须能读回来（真实往返，含版本信封）
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY = {};
assert.deepEqual(loadDismissedBlocks(), EMPTY, "首次读取应为空表");

const afterFirst = dismissCompanionBlock(EMPTY, "doc-a", "block-1");
assert.deepEqual(afterFirst, { "doc-a": ["block-1"] });
assert.ok(isBlockDismissed(afterFirst, "doc-a", "block-1"));

// 关键：落的是磁盘，不是只有内存对象变了。
const reloaded = loadDismissedBlocks();
assert.deepEqual(reloaded, { "doc-a": ["block-1"] }, "dismiss 必须真的落到 localStorage");
const envelope = JSON.parse(storage.get(COMPANION_DISMISSED_KEY));
assert.equal(envelope.version, COMPANION_DISMISSED_STATE_VERSION, "必须走版本化信封");
assert.deepEqual(envelope.data, { "doc-a": ["block-1"] });

// 2) 幂等 —— React 严格模式下 setState 的 updater 会被调用两次，
//    非幂等的写入会把副作用放大成重复条目。
const twice = dismissCompanionBlock(afterFirst, "doc-a", "block-1");
assert.deepEqual(twice, { "doc-a": ["block-1"] }, "重复 dismiss 同一块不得产生重复条目");
assert.equal(dismissCompanionBlock(afterFirst, "doc-a", "block-1"), afterFirst, "无变化时不得产生新对象");

// 3) 多文档互不干扰，且同一文档可累积多个块。
const multi = dismissCompanionBlock(dismissCompanionBlock(EMPTY, "doc-a", "b1"), "doc-b", "b2");
assert.deepEqual(multi, { "doc-a": ["b1"], "doc-b": ["b2"] });
assert.equal(isBlockDismissed(multi, "doc-a", "b2"), false, "跨文档的块不得误判为已 dismiss");

// 4) 空 key / 空 blockId 一律忽略（AI 标注可能没有 blockId，那时无从否定）。
assert.equal(dismissCompanionBlock(EMPTY, "", "b1"), EMPTY);
assert.equal(dismissCompanionBlock(EMPTY, "doc-a", ""), EMPTY);
assert.equal(isBlockDismissed(multi, "", "b1"), false);
assert.equal(isBlockDismissed(multi, "doc-a", ""), false);

// 5) 消毒：形状不对的一律丢弃，且**去重** —— 否定集合只增不减，
//    不去重会随 dismiss 次数线性膨胀。
assert.deepEqual(
  sanitizeDismissedBlocks({
    "doc-a": ["b1", "b1", "b2"],
    "doc-b": "not-an-array",
    "doc-c": [1, null, "b3", ""],
    "doc-d": [],
  }),
  { "doc-a": ["b1", "b2"], "doc-c": ["b3"] }
);
assert.deepEqual(sanitizeDismissedBlocks(null), EMPTY);
assert.deepEqual(sanitizeDismissedBlocks("nonsense"), EMPTY);

// ─────────────────────────────────────────────────────────────────────────────
// 6) 「删掉 AI 标注 → 写否定集合」这条判定（§3.5 那个投诉级 bug）
//
//    判定放在纯函数里而不是组件里，正因为这条必须能被**行为**断言覆盖：
//    组件里的判定只能靠字符串守卫兜住，而那种守卫连 `if (false && …)` 都抓不到
//    （实测：把调用包进永假条件后守卫照样是绿的）。
// ─────────────────────────────────────────────────────────────────────────────

storage.clear();

const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.02 };
const STORED = [
  { id: "ai-1", page: 1, kind: "wavy", rect: RECT, origin: "ai", blockId: "b1", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "manual-1", page: 1, kind: "highlight", rect: RECT, origin: "manual", blockId: "b2", createdAt: "2026-01-02T00:00:00.000Z" },
  // 老数据：没有 origin 字段（本功能上线前就存在的标注）
  { id: "legacy-1", page: 1, kind: "underline", rect: RECT, blockId: "b3", createdAt: "2026-01-03T00:00:00.000Z" },
  // AI 标注但没有块可锚定
  { id: "ai-noblock", page: 1, kind: "wavy", rect: RECT, origin: "ai", createdAt: "2026-01-04T00:00:00.000Z" },
];

assert.equal(dismissalForRemovedAnnotation(STORED, "ai-1"), "b1", "删 AI 标注必须交出它的 blockId");
assert.equal(
  dismissalForRemovedAnnotation(STORED, "manual-1"),
  undefined,
  "删自己画的标注不得污染否定集合 —— 那是「我删了这条线」，不是「别再提示这里」"
);
assert.equal(dismissalForRemovedAnnotation(STORED, "legacy-1"), undefined, "老数据一律视为 manual");
assert.equal(dismissalForRemovedAnnotation(STORED, "ai-noblock"), undefined, "没有 blockId 时无从否定，不能否定整页");
assert.equal(dismissalForRemovedAnnotation(STORED, "不存在"), undefined);

// 端到端：判定 + 落盘。翻回这一页时 `isBlockDismissed` 必须为 true，
// 这才是「删掉的不重生」真正的判据。
const blockId = dismissalForRemovedAnnotation(STORED, "ai-1");
const persisted = dismissCompanionBlock(loadDismissedBlocks(), "doc-a", blockId);
assert.equal(isBlockDismissed(persisted, "doc-a", "b1"), true);
assert.equal(isBlockDismissed(loadDismissedBlocks(), "doc-a", "b1"), true, "必须真的落盘，而不只是内存对象变了");
assert.equal(isBlockDismissed(loadDismissedBlocks(), "doc-a", "b2"), false, "人工标注的块不得被牵连");

// ─────────────────────────────────────────────────────────────────────────────
// 7) 密度档位
// ─────────────────────────────────────────────────────────────────────────────

assert.deepEqual([...COMPANION_INTENSITIES], ["off", "light", "medium", "heavy"]);

const stats = (overrides = {}) => ({ ...DEFAULT_COMPANION_STATS, ...overrides });

// 边界点。权重：selections 2 / annotations 1 / followUps 3 / documents 1。
// 阈值：light ≥ 1，medium ≥ 8，heavy ≥ 24。
assert.equal(deriveIntensity(stats()), "off", "零互动应为 off");
assert.equal(deriveIntensity(stats({ annotations: 1 })), "light", "score 1 刚进 light");
assert.equal(deriveIntensity(stats({ documents: 7 })), "light", "score 7 仍是 light");
assert.equal(deriveIntensity(stats({ documents: 8 })), "medium", "score 8 刚进 medium");
assert.equal(deriveIntensity(stats({ followUps: 7, annotations: 2 })), "medium", "score 23 仍是 medium");
assert.equal(deriveIntensity(stats({ followUps: 8 })), "heavy", "score 24 刚进 heavy");

// 8) 上界是硬的：heavy 之上不再往上走。
assert.equal(deriveIntensity(stats({ selections: 9999, followUps: 9999 })), "heavy");
assert.equal(COMPANION_INTENSITIES.at(-1), "heavy", "heavy 必须是最后一档");

// 9) 单调不减 —— 施工单 §3.4 的硬约束。
//    在 0..8 的四维网格上穷举：任一计数 +1，档位都不得下降。
//    （权重全为正 ⇒ score 单调 ⇒ 分档单调；这里直接测端到端，不靠推理。）
const RANK = { off: 0, light: 1, medium: 2, heavy: 3 };
const FIELDS = ["selections", "annotations", "followUps", "documents"];
let checked = 0;
for (let s = 0; s <= 8; s += 1) {
  for (let a = 0; a <= 8; a += 1) {
    for (let f = 0; f <= 8; f += 1) {
      for (let d = 0; d <= 8; d += 1) {
        const base = stats({ selections: s, annotations: a, followUps: f, documents: d });
        const rank = RANK[deriveIntensity(base)];
        for (const field of FIELDS) {
          const bumped = { ...base, [field]: base[field] + 1 };
          assert.ok(
            RANK[deriveIntensity(bumped)] >= rank,
            `${field} 从 ${base[field]} 加到 ${base[field] + 1} 后档位下降了：` +
              `${JSON.stringify(base)} → ${JSON.stringify(bumped)}`
          );
          checked += 1;
        }
      }
    }
  }
}
assert.ok(checked > 20000, `单调性样本量应当足够大，实际 ${checked}`);

// 10) score 本身也必须单调（它是 deriveIntensity 单调性的来源）。
for (const field of FIELDS) {
  const base = stats({ selections: 3, annotations: 3, followUps: 3, documents: 3 });
  assert.ok(companionSignalScore({ ...base, [field]: base[field] + 1 }) > companionSignalScore(base));
}

// 11) 脏输入按 0 处理，而不是让档位变成 NaN 相关的怪值。
//     Infinity 也按 0：计数坏掉了说明数据不可信，此时**不该**把用户推到最吵的一档 ——
//     「有疑问时少打扰」是这套功能的默认方向（失败模式是太吵，不是不够准）。
assert.equal(deriveIntensity(stats({ selections: -5, annotations: -1 })), "off");
assert.equal(deriveIntensity(stats({ selections: Number.NaN })), "off");
assert.equal(deriveIntensity(stats({ followUps: Number.POSITIVE_INFINITY })), "off");

// 12) 纯函数：同输入必须同输出。含随机源的话这条会 flaky。
const sample = stats({ selections: 4, annotations: 2, followUps: 1, documents: 3 });
assert.equal(deriveIntensity(sample), deriveIntensity(sample));
assert.equal(deriveIntensity(sample), deriveIntensity({ ...sample }));

console.log(`reading companion: ok（否定集合 + 密度档位，单调性样本 ${checked} 条）`);
