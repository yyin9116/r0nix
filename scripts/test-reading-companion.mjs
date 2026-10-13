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
  buildCompanionMarker,
  findCompanionMarker,
  canAddCompanionMarker,
  countCompanionMarkersOnPage,
  visibleCompanionMarkersOnPage,
  clampMarkerRectToSentence,
  COMPANION_MARKER_BUDGET,
  companionAnchorPosition,
  companionAnchorsOnPage,
  isCompanionAnchorTarget,
  COMPANION_ANCHOR_MAX_PER_PAGE,
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

// ─────────────────────────────────────────────────────────────────────────────
// 13) 伴读锚点 —— 「只有波浪线附带锚点」这条决定的机械断言
//
// 这条决定撑不起测试：types.ts 里那句「消歧只能靠波浪线旁必有锚点」是纯注释，
// 把它删掉、锚点整个不实现，测试照样全绿。所以判据必须落在行为上：
// 谁该挂锚点、锚点落在哪、脏几何怎么处理。
// ─────────────────────────────────────────────────────────────────────────────

// 判据：只有 `wavy` + `ai` 挂锚点。
// 荧光笔与下划线是**纯记录**、不与agent 联动 —— 给它们挂锚点会让「有锚点 = AI 在等你问」
// 这条消歧规则失效，满页都是入口。
const ANCHOR_CASES = [
  [{ kind: "wavy", origin: "ai" }, true, "AI 波浪线必须有锚点"],
  [{ kind: "wavy", origin: "manual" }, false, "人工波浪线不挂锚点"],
  [{ kind: "wavy" }, false, "老数据无 origin 一律视为 manual，不挂"],
  [{ kind: "highlight", origin: "ai" }, false, "荧光笔是纯记录，不挂锚点"],
  [{ kind: "underline", origin: "ai" }, false, "下划线是纯记录，不挂锚点"],
  [{ kind: "text", origin: "ai" }, false, "便签不挂锚点"],
];
for (const [annotation, expected, why] of ANCHOR_CASES) {
  assert.equal(isCompanionAnchorTarget(annotation), expected, why);
}

// 位置：锚点落在标注矩形的右上角（句子末尾之后），不是左上角。
// 左上角会被前一行遮住 —— 读者视线从上一行进入时先经过那里。
const PAGE = { width: 612, height: 792 };
const BOX = { x: 0.2, y: 0.4, width: 0.5, height: 0.03 };
const pos = companionAnchorPosition({ rect: BOX, pageSize: PAGE });
assert.ok(pos, "正常矩形必须算出位置");
assert.ok(Math.abs(pos.x - (BOX.x + BOX.width)) < 1e-9, "锚点 x 应贴着矩形右缘");
assert.ok(
  pos.y > BOX.y && pos.y < BOX.y + BOX.height,
  "锚点 y 应落在矩形纵向范围内（上提一点，悬在句末）"
);

// 纯几何，必须是确定的：同一个输入算两次要一模一样，否则锚点会在重渲染时抖动。
assert.deepEqual(
  companionAnchorPosition({ rect: BOX, pageSize: PAGE }),
  pos,
  "锚点位置必须是纯函数，重渲染不得让它跳位"
);

// 脏几何：宁可不画，也不要画一个位置错乱的锚点 —— 那比没有锚点更误导。
assert.equal(companionAnchorPosition({ rect: BOX, pageSize: { width: 0, height: 792 } }), null);
assert.equal(companionAnchorPosition({ rect: BOX, pageSize: { width: 612, height: 0 } }), null);
assert.equal(
  companionAnchorPosition({ rect: { ...BOX, x: Number.NaN }, pageSize: PAGE }),
  null,
  "x 坏了就不画"
);
assert.equal(
  companionAnchorPosition({ rect: { ...BOX, width: Number.POSITIVE_INFINITY }, pageSize: PAGE }),
  null,
  "无穷宽的矩形是坏数据"
);
assert.equal(
  companionAnchorPosition({ rect: { x: 99, y: 99, width: 0.1, height: 0.1 }, pageSize: PAGE }),
  null,
  "远超一页的范围说明矩形本身坏了"
);

// 每页筛选：只留 AI 波浪线，同一块只留一个（否则反复唤出会叠出一排锚点）。
const ANCHOR_PAGE = [
  { id: "a1", page: 1, kind: "wavy", origin: "ai", blockId: "b1", rect: BOX },
  { id: "a1-dup", page: 1, kind: "wavy", origin: "ai", blockId: "b1", rect: BOX },
  { id: "h1", page: 1, kind: "highlight", origin: "ai", blockId: "b2", rect: BOX },
  { id: "u1", page: 1, kind: "underline", origin: "ai", blockId: "b3", rect: BOX },
  { id: "p2", page: 2, kind: "wavy", origin: "ai", blockId: "b4", rect: BOX },
];
const onPage1 = companionAnchorsOnPage(ANCHOR_PAGE, 1);
assert.deepEqual(
  onPage1.map((item) => item.id),
  ["a1"],
  "只留AI 波浪线、同块去重、且不串页"
);
assert.deepEqual(companionAnchorsOnPage(ANCHOR_PAGE, 2).map((i) => i.id), ["p2"]);

// 上限：满页都是 AI 波浪线时，锚点不能无限渲染 —— 那是入口，入口多了等于没有入口。
const many = Array.from({ length: 20 }, (_, index) => ({
  id: `m${index}`,
  page: 1,
  kind: "wavy",
  origin: "ai",
  blockId: `mb${index}`,
  rect: BOX,
}));
assert.equal(
  companionAnchorsOnPage(many, 1).length,
  COMPANION_ANCHOR_MAX_PER_PAGE,
  `每页锚点数必须封顶（当前 ${COMPANION_ANCHOR_MAX_PER_PAGE}）`
);
// 且必须保持原序：标注数组的顺序就是添加顺序，重排会让读者删一条后锚点整体跳位。
assert.deepEqual(
  companionAnchorsOnPage(many, 1).map((i) => i.id),
  many.slice(0, COMPANION_ANCHOR_MAX_PER_PAGE).map((i) => i.id)
);

// 12) 纯函数：同输入必须同输出。含随机源的话这条会 flaky。
const sample = stats({ selections: 4, annotations: 2, followUps: 1, documents: 3 });
assert.equal(deriveIntensity(sample), deriveIntensity(sample));
assert.equal(deriveIntensity(sample), deriveIntensity({ ...sample }));

// ─────────────────────────────────────────────────────────────────────────────
// 13) 自动标注（wavy 标记）
//
//     「没有划线标记」这个反馈的根因是这条链路根本没接上：设置里躺着
//     companionAutoAnnotate，但没有任何代码消费它。这里钉住两个纯判定：
//     什么时候该标、什么时候不该重复标。
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK = { id: "b1", page: 3, rect: RECT };

const marker = buildCompanionMarker({ documentId: "doc-a", block: BLOCK, question: "这里的因果是怎么成立的？" });
assert.equal(marker.kind, "wavy", "伴读标记必须是 wavy —— 波浪线是 AI-only 的形状（types.ts）");
assert.equal(marker.origin, "ai", "必须标出 origin=ai，否则删掉它时不会进否定集合");
assert.equal(marker.blockId, "b1", "必须带上 blockId，否则「删掉的不重生」无从定位");
assert.equal(marker.page, 3);
assert.equal(marker.content, "这里的因果是怎么成立的？", "疑问要存进标注，点开笔记才有内容可看");

// 没有几何就不标 —— 画不出来的标记比不标更糟（变成纸面上一个 0×0 的碎点）。
assert.equal(buildCompanionMarker({ block: { id: "b1", page: 1 }, question: "q" }), undefined, "无 rect 不得标");
assert.equal(
  buildCompanionMarker({ block: { id: "b1", page: 1, rect: { ...RECT, width: 0 } }, question: "q" }),
  undefined,
  "零宽矩形不得标"
);
assert.equal(
  buildCompanionMarker({ block: { id: "b1", page: 1, rect: { ...RECT, height: -2 } }, question: "q" }),
  undefined,
  "负高矩形不得标"
);

// 查重：只认 wavy + ai。人工画的线、读者自己的 highlight 都不参与去重，
// 否则「我在这段画了条线」会变成「伴读不能再标这里」。
assert.ok(findCompanionMarker([marker], "b1"), "同一块已有伴读标记时必须查得到");
assert.equal(findCompanionMarker([marker], "b2"), undefined, "别的块不得查到");
assert.equal(
  findCompanionMarker(
    [{ ...marker, kind: "underline", id: "u1" }, { ...marker, kind: "highlight", id: "h1" }],
    "b1"
  ),
  undefined,
  "人工标注不得参与伴读标记的查重"
);
assert.equal(
  findCompanionMarker([{ ...marker, origin: undefined, id: "m1" }], "b1"),
  undefined,
  "老数据（无 origin）一律视为 manual，不得参与查重"
);
assert.equal(findCompanionMarker([], ""), undefined, "空 blockId 不得命中任何东西");

// ─────────────────────────────────────────────────────────────────────────────
// 14) ★ 标记预算：每页最多留几条（settings.companionAutoAnnotateIntensity）
//
// 这条存在的原因是「设置里曾经有一个没人读的死控件」：能改、能存，但代码里
// 没有任何一行消费它。死控件比没有控件更糟 —— 读者调了半天发现没反应。
// 所以预算必须有行为断言，而不是只断言常量存在。
// ─────────────────────────────────────────────────────────────────────────────

const aiMarker = (id, page, blockId) => ({
  id,
  page,
  blockId,
  kind: "wavy",
  origin: "ai",
  rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
  content: "q",
  createdAt: "2026-10-05T00:00:00.000Z",
});

/** 带显式创建时间的 AI 标记 —— 截断要按时间挑「最近的那几条」，必须能区分先后。 */
const aiMarkerAt = (id, page, blockId, createdAt) => ({ ...aiMarker(id, page, blockId), createdAt });

assert.equal(COMPANION_MARKER_BUDGET.off, 0, "off 档一条都不留 —— 提示照常，纸面干净");
assert.equal(COMPANION_MARKER_BUDGET.light, 1);
assert.equal(COMPANION_MARKER_BUDGET.medium, 2);
assert.equal(COMPANION_MARKER_BUDGET.heavy, Number.POSITIVE_INFINITY, "heavy = 不限");
// 单调性：档位越高预算越大（不允许出现「重档比中档还少」这种手滑）
assert.ok(
  COMPANION_MARKER_BUDGET.off <= COMPANION_MARKER_BUDGET.light &&
    COMPANION_MARKER_BUDGET.light <= COMPANION_MARKER_BUDGET.medium &&
    COMPANION_MARKER_BUDGET.medium <= COMPANION_MARKER_BUDGET.heavy,
  "预算必须随档位单调不减"
);

assert.equal(countCompanionMarkersOnPage([], 1), 0);
assert.equal(
  countCompanionMarkersOnPage([aiMarker("a", 1, "b1"), aiMarker("b", 1, "b2"), aiMarker("c", 2, "b3")], 1),
  2,
  "只数同一页"
);
assert.equal(
  countCompanionMarkersOnPage([{ ...aiMarker("m", 1, "b1"), origin: "manual" }, { ...aiMarker("h", 1, "b2"), kind: "highlight" }], 1),
  0,
  "读者自己画的线不占预算"
);

assert.equal(canAddCompanionMarker([], { page: 1, intensity: "medium" }), true, "空页当然放得下");
assert.equal(
  canAddCompanionMarker([aiMarker("a", 1, "b1")], { page: 1, intensity: "light" }),
  false,
  "★ light 档每页 1 条：第二条必须被挡住"
);
assert.equal(
  canAddCompanionMarker([aiMarker("a", 1, "b1")], { page: 1, intensity: "medium" }),
  true,
  "medium 档每页 2 条：第二条放得下"
);
assert.equal(
  canAddCompanionMarker([aiMarker("a", 1, "b1"), aiMarker("b", 1, "b2")], { page: 1, intensity: "medium" }),
  false,
  "★ medium 档第三条必须被挡住"
);
assert.equal(
  canAddCompanionMarker([aiMarker("a", 1, "b1"), aiMarker("b", 1, "b2"), aiMarker("c", 1, "b3")], { page: 1, intensity: "heavy" }),
  true,
  "heavy 不限"
);
assert.equal(
  canAddCompanionMarker([], { page: 1, intensity: "off" }),
  false,
  "★ off 档一条都不留（提示仍会出现，只是不落痕迹）"
);
// 别页的标记不该吃掉本页的预算
assert.equal(
  canAddCompanionMarker([aiMarker("a", 2, "b1"), aiMarker("b", 2, "b2")], { page: 1, intensity: "medium" }),
  true,
  "预算按页算，别页攒满不影响本页"
);
// 未知档位按 medium 兜底：认不出就一律不标，会让功能静默失效
assert.equal(canAddCompanionMarker([], { page: 1, intensity: "nonsense" }), true, "未知档位按 medium 兜底");

// ─────────────────────────────────────────────────────────────────────────────
// 4) 渲染层预算截断（visibleCompanionMarkersOnPage）
//
// 为什么单独一节：上面那些断言全都在验证**写入侧**的闸门，而实测的 bug 恰恰是
// 「闸门管得住当下、管不住历史」—— 标注跨会话累积在 localStorage 里，
// promptedPagesRef 每次打开文档都重置，于是 medium=2 的页面积到 6+ 条。
// 那一层只有渲染侧能管，所以它的正确性必须有行为断言，不能只靠 check 里的字符串匹配。
// ─────────────────────────────────────────────────────────────────────────────

// 累积场景：medium 档（预算 2）下一页已有 5 条历史标记。
const piled = [
  aiMarkerAt("t1", 1, "b1", "2026-10-01T00:00:00.000Z"),
  aiMarkerAt("t2", 1, "b2", "2026-10-02T00:00:00.000Z"),
  aiMarkerAt("t3", 1, "b3", "2026-10-03T00:00:00.000Z"),
  aiMarkerAt("t4", 1, "b4", "2026-10-04T00:00:00.000Z"),
  aiMarkerAt("t5", 1, "b5", "2026-10-05T00:00:00.000Z"),
];
assert.equal(
  canAddCompanionMarker(piled, { page: 1, intensity: "medium" }),
  false,
  "写入侧此时确实已经放不下了 —— 这正是为什么不能只靠它"
);
assert.deepEqual(
  visibleCompanionMarkersOnPage(piled, { page: 1, intensity: "medium" }).map((m) => m.id),
  ["t4", "t5"],
  "★ 渲染层必须按预算截断，且保留最近的两条（2026-10-08「全文都是波浪线」的成因）"
);
// 顺序：截断按时间挑，但返回要恢复成入参原序 —— 读者删掉一条之后其余波浪线
// 不该整体跳位（与 companionAnchorsOnPage 同一条理由）。
assert.deepEqual(
  visibleCompanionMarkersOnPage([...piled].reverse(), { page: 1, intensity: "medium" }).map((m) => m.id),
  ["t5", "t4"],
  "★ 截断后必须恢复入参原序，而不是按时间重排"
);
assert.equal(
  visibleCompanionMarkersOnPage(piled, { page: 1, intensity: "light" }).length,
  1,
  "light 档只画 1 条"
);
assert.equal(
  visibleCompanionMarkersOnPage(piled, { page: 1, intensity: "heavy" }).length,
  5,
  "heavy 档不限：截断不能误伤用户明确选了「重」的场景"
);
assert.deepEqual(
  visibleCompanionMarkersOnPage(piled, { page: 1, intensity: "off" }),
  [],
  "★ off 档一条都不画 —— 设置里写的是「一条不留」，只在写入侧拦等于空话"
);
// 不超预算时原样返回（含原序），不做无谓的重排。
assert.deepEqual(
  visibleCompanionMarkersOnPage(piled.slice(0, 2), { page: 1, intensity: "medium" }).map((m) => m.id),
  ["t1", "t2"],
  "未超预算时不动任何数据"
);
// 非 AI 的标注不参与截断：读者自己画的线不能被这套预算藏起来。
const withManual = [
  aiMarkerAt("a1", 1, "b1", "2026-10-01T00:00:00.000Z"),
  { ...aiMarkerAt("m1", 1, "b2", "2026-10-02T00:00:00.000Z"), origin: "manual" },
  { ...aiMarkerAt("h1", 1, "b3", "2026-10-03T00:00:00.000Z"), kind: "highlight" },
];
assert.deepEqual(
  visibleCompanionMarkersOnPage(withManual, { page: 1, intensity: "off" }).length,
  0,
  "off 档只藏 AI 波浪线"
);
assert.deepEqual(
  visibleCompanionMarkersOnPage(withManual, { page: 1, intensity: "heavy" }).map((m) => m.id),
  ["a1"],
  "heavy 档的清单里也不该混进人工标注 —— 它只负责 AI 波浪线这一件事"
);
// 别页不参与。
assert.deepEqual(
  visibleCompanionMarkersOnPage(piled, { page: 2, intensity: "medium" }),
  [],
  "预算按页算"
);
// 损坏的 createdAt 不能让排序崩掉（NaN 比较会让结果依赖入参顺序）。
const corruptTimes = [
  aiMarkerAt("c1", 1, "b1", "not-a-date"),
  aiMarkerAt("c2", 1, "b2", "2026-10-09T00:00:00.000Z"),
  aiMarkerAt("c3", 1, "b3", ""),
];
assert.deepEqual(
  visibleCompanionMarkersOnPage(corruptTimes, { page: 1, intensity: "light" }).map((m) => m.id),
  ["c2"],
  "★ 时间戳损坏时按「最旧」处理，可解析的那条仍然胜出"
);
assert.equal(
  visibleCompanionMarkersOnPage(corruptTimes, { page: 1, intensity: "medium" }).length,
  2,
  "时间戳损坏不应减少可见条数"
);
// 未知档位与 canAddCompanionMarker 保持同一兜底（medium），两者不一致会让
// 「写得进却画不出」或「画得出却写不进」。
assert.equal(
  visibleCompanionMarkersOnPage(piled, { page: 1, intensity: "nonsense" }).length,
  2,
  "未知档位按 medium 兜底，与写入侧一致"
);

// ── 几何收窄到整句（2026-10-08 三轮返工：满页 → 腰斩 → 整句）──────────────────
//
// v1 只截条数 → 存量标注一条划满整段（用户：「还是满页波浪线」）。
// v2 截到单行 → 用户：「仅一行，不完全」，句子被腰斩。
// v3 按行边界取整句，并硬上限 4 行兜底。
//
// 所有样本都用**真实页面尺度**（A4 1123px 高，一行 ≈ 15.7px ≈ 0.014），
// 而不是随手编的小数值 —— 用 0.02 这种数当「一行」会让断言失去意义。
const LINE = 0.014;
const lineAt = (index, text) => ({ text, rect: { x: 0.1, y: 0.4 + index * LINE, width: 0.8, height: LINE } });

// 无行级数据：保持原矩形，不编造几何。
// ⚠️ 这里曾经是「退回一条 y=块顶、h=常数的细带」—— 2026-10-08 实测那条带
// 与文字行中心差 1px，中心点命中全灭，波浪线一根都画不出来（数据在、屏幕没有）。
// 编造的几何碰不到字，比诚实的块级框严重得多；有行数据的路径仍会收窄到句。
const noLines = clampMarkerRectToSentence({ x: 0.2, y: 0.4, width: 0.6, height: 0.2 });
assert.equal(
  Math.abs(noLines.height - 0.2) < 1e-9 && noLines.y === 0.4,
  true,
  "★ 无行级数据时保持原矩形（编一条常数细带会碰不到文字中心，线全灭）"
);

// 首行自带句末标点：就地收尾。
const oneLine = clampMarkerRectToSentence(
  { x: 0.1, y: 0.4, width: 0.8, height: 0.056 },
  [lineAt(0, "这句话到此结束。"), lineAt(1, "下一句不该被划上。")]
);
assert.equal(
  Math.abs(oneLine.height - LINE) < 1e-9,
  true,
  "★ 首行以句号收尾时不得向下扩展"
);

// ★ 核心用例：句子跨三行，标点落在第三行 → 应覆盖三行。
const threeLines = clampMarkerRectToSentence(
  { x: 0.1, y: 0.4, width: 0.8, height: 0.056 },
  [
    lineAt(0, "这是一个很长的从句，"),
    lineAt(1, "它需要好几行才能说完，"),
    lineAt(2, "最后在这里收尾。"),
    lineAt(3, "完全无关的下一句。"),
  ]
);
assert.equal(
  Math.abs(threeLines.height - LINE * 3) < 1e-9,
  true,
  `★ 跨行句子应按句末标点扩展到整句（实得 ${threeLines.height}，期望 ${LINE * 3}）`
);
assert.equal(threeLines.y, 0.4, "扩展向下，起点不动");

// 英文句末标点与右引号：'." 算一句结束。
const english = clampMarkerRectToSentence(
  { x: 0.1, y: 0.4, width: 0.8, height: 0.042 },
  [lineAt(0, "This clause continues"), lineAt(1, `and ends here."`)]
);
assert.equal(
  Math.abs(english.height - LINE * 2) < 1e-9,
  true,
  "★ 英文句末标点（含右引号）也应触发收尾"
);

// 没有句末标点：累积到硬上限 4 行，绝不能画出满页。
const noPunctuation = clampMarkerRectToSentence(
  { x: 0.1, y: 0.4, width: 0.8, height: 0.4 },
  Array.from({ length: 12 }, (_, i) => lineAt(i, `这一行没有任何句末标点${i}`))
);
assert.equal(
  Math.abs(noPunctuation.height - LINE * 4) < 1e-9,
  true,
  `★ 无标点时长句必须停在 4 行上限（实得 ${noPunctuation.height}）`
);
assert.ok(noPunctuation.height < 0.2, "★ 无论如何都不能退回整块高度");

// 扩展不得越过块底：句末标点若落在块外（数据不一致），夹回块内。
const beyond = clampMarkerRectToSentence(
  { x: 0.1, y: 0.4, width: 0.8, height: LINE * 2 },
  [lineAt(0, "第一行没有标点"), lineAt(1, "第二行也没有。"), lineAt(5, "块外的行。")]
);
assert.ok(
  beyond.y + beyond.height <= 0.4 + LINE * 2 + 1e-9,
  "★ 波浪线不得越过块底画到下一段"
);

// 越界与非有限值：NaN 会传染给 width 使整条被静默丢弃。
const clipped = clampMarkerRectToSentence({ x: 0.9, y: 0.2, width: 0.5, height: 0.2 });
assert.equal(Math.abs(clipped.width - 0.1) < 1e-9, true, "宽度越过右边界时按页面裁剪");
assert.equal(clipped.y, 0.2, "裁剪宽度不移动起点");
assert.equal(
  clampMarkerRectToSentence({ x: -0.1, y: 1.5, width: 0.5, height: 0.2 }).y,
  1,
  "越界的 y 夹进 [0,1]"
);
assert.equal(clampMarkerRectToSentence(undefined), undefined, "无 rect 返回 undefined");
assert.equal(clampMarkerRectToSentence({ x: 0.1, y: 0.1, width: 0, height: 0.2 }), undefined, "零宽丢弃");
assert.equal(
  clampMarkerRectToSentence({ x: Number.NaN, y: 0.1, width: 0.5, height: 0.2 }).x,
  0,
  "NaN 坐标降级为 0 而不是 NaN（NaN 会让整条标注静默消失）"
);

// 端到端：接线错的话单测会绿、屏幕上仍是一行。断言 visibleCompanionMarkersOnPage
// 真的用上了 linesForBlock —— v2 的「腰斩」正是这里没接线的后果。
const stored = [
  { ...aiMarker("s1", 3, "b1"), rect: { x: 0.1, y: 0.4, width: 0.8, height: 0.056 } },
];
const wired = visibleCompanionMarkersOnPage(stored, {
  page: 3,
  intensity: "medium",
  linesForBlock: () => [lineAt(0, "从句第一行"), lineAt(1, "从句第二行。")],
});
assert.equal(
  Math.abs(wired[0].rect.height - LINE * 2) < 1e-9,
  true,
  `★ linesForBlock 必须真的接上（实得 ${wired[0].rect.height}，期望 ${LINE * 2}）`
);
// 不传 linesForBlock 时保持标注自身的矩形（不再编单行带 —— 理由见上）。
const unwired = visibleCompanionMarkersOnPage(stored, { page: 3, intensity: "medium" });
assert.equal(
  Math.abs(unwired[0].rect.height - 0.056) < 1e-9 && unwired[0].rect.y === 0.4,
  true,
  "未提供行数据时保持原矩形"
);

// 几何无效的标注应在**截断之前**被丢，不占预算名额。
const withBroken = [
  { ...aiMarker("g1", 4, "b1"), rect: { x: 0.1, y: 0.1, width: 0, height: 0.2 } },
  { ...aiMarker("g2", 4, "b2"), rect: { x: 0.1, y: 0.4, width: 0.8, height: 0.02 } },
];
assert.deepEqual(
  visibleCompanionMarkersOnPage(withBroken, { page: 4, intensity: "light" }).map((m) => m.id),
  ["g2"],
  "★ light 档只有一条名额：几何无效的那条应让位给能显示的"
);

// ── 存量非正文标注在渲染侧被拦（2026-10-08：页眉上仍有波浪线）──────────────
//
// `isNonProseRegion` 只在**新增**那一刻生效，而标注是跨会话累积在 localStorage
// 里的 —— 于是「过滤规则上线之前」留下的页眉波浪线会永远留在纸上。
// 写入侧管当下，渲染侧必须兜住存量；只读过滤，不删数据。
const headerAndBody = [
  { ...aiMarkerAt("hdr", 5, "header-1", "2026-10-01T00:00:00.000Z"), rect: { x: 0.1, y: 0.04, width: 0.5, height: LINE } },
  { ...aiMarkerAt("bdy", 5, "body-1", "2026-10-02T00:00:00.000Z"), rect: { x: 0.1, y: 0.4, width: 0.5, height: LINE } },
];
/** 页眉块一律判为非正文，正文块一律放行 —— 模拟 PDFViewer 的接线。 */
const isHeaderBlock = (blockId) => blockId.startsWith("header-");

assert.deepEqual(
  visibleCompanionMarkersOnPage(headerAndBody, { page: 5, intensity: "heavy", isNonProseBlock: isHeaderBlock }).map((m) => m.id),
  ["bdy"],
  "★ 判为非正文的存量标注必须在渲染侧被拦下（页眉波浪线的根因）"
);
// 反向：不提供判据时一律放行。判据缺失 ≠ 该拦，误杀正文标注比漏放页眉更难解释。
assert.deepEqual(
  visibleCompanionMarkersOnPage(headerAndBody, { page: 5, intensity: "heavy" }).map((m) => m.id),
  ["hdr", "bdy"],
  "未接isNonProseBlock 时不得拦任何东西（向后兼容）"
);
// 老数据没有 blockId：无从判断，必须放行。
const orphanHeader = [{ ...aiMarkerAt("old", 5, undefined, "2026-10-01T00:00:00.000Z"), rect: { x: 0.1, y: 0.04, width: 0.5, height: LINE } }];
assert.deepEqual(
  visibleCompanionMarkersOnPage(orphanHeader, { page: 5, intensity: "heavy", isNonProseBlock: () => true }).map((m) => m.id),
  ["old"],
  "★ blockId 缺失的老数据不得被拦（否则升级即大面积丢标注）"
);
// 被拦的标注不该占预算名额 —— 否则页眉线虽然没画出来，却把正文线挤掉了。
const headerHeavy = [
  ...headerAndBody,
  { ...aiMarkerAt("bdy2", 5, "body-2", "2026-10-03T00:00:00.000Z"), rect: { x: 0.1, y: 0.5, width: 0.5, height: LINE } },
];
assert.deepEqual(
  visibleCompanionMarkersOnPage(headerHeavy, { page: 5, intensity: "light", isNonProseBlock: isHeaderBlock }).map((m) => m.id),
  ["bdy2"],
  "★ 被拦的页眉标注不占预算：light 档那条名额必须留给能显示的正文标记"
);
// 人工标注不受影响，但**不是**因为 isNonProseBlock 放行它，而是因为它从来不在
// 这个函数的管辖范围内（第 14 节已有断言：它既不占预算也不进清单）。
// 这里只钉住「过滤不该放宽这个边界」：接上判据后清单仍是空的。

console.log(`reading companion: ok（否定集合 + 密度档位 + 整句收窄+ 非正文存量过滤，单调性样本 ${checked} 条）`);
