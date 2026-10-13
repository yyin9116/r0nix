import assert from "node:assert/strict";

import {
  COMPANION_DWELL_INITIAL,
  COMPANION_DWELL_THRESHOLD_MS,
  COMPANION_MIN_VISIBLE_FRACTION,
  advanceDwell,
  measureBlockVisibility,
  pickFocusBlock,
  shouldHintForBlock,
  isNonProseRegion,
} from "../src/services/companionDwell.ts";

// ── 几何夹具 ────────────────────────────────────────────────────────────────
// 页面高 1000px，容器视口高 800px，页面顶边对齐视口顶边。
const PAGE = { page: 1, top: 0, height: 1000 };
const VIEWPORT = { top: 0, height: 800 };

const block = (id, y, height, page = 1) => ({
  blockId: id,
  page,
  rect: { x: 0, y, width: 1, height },
});

const measure = (b, pageFrame = PAGE, viewport = VIEWPORT) =>
  measureBlockVisibility(b, pageFrame, viewport);

// ─────────────────────────────────────────────────────────────────────────────
// 1) 基本可见性
// ─────────────────────────────────────────────────────────────────────────────
assert.equal(measure(block("a", 0.1, 0.1)).visibleFraction, 1, "完全在视口内的块应为 1");
assert.equal(measure(block("a", 0.1, 0.1)).visibleHeight, 100);

// 露出一半：750..800，块高 100 ⇒ 50px ⇒ 0.5
assert.equal(measure(block("b", 0.75, 0.1)).visibleFraction, 0.5, "跨越视口下缘应算出 0.5");
// 露出 70%：730..830 ⇒ 70px ⇒ 0.7，刚好过 0.6 阈值
assert.equal(measure(block("c", 0.73, 0.1)).visibleFraction, 0.7);
// 完全在视口下方
assert.equal(measure(block("d", 0.9, 0.1)).visibleFraction, 0, "视口外的块应为 0");

// 滚动：页面上移 500px 后，原本在 100..200 的块滚到 -400..-300
assert.equal(measure(block("a", 0.1, 0.1), { page: 1, top: -500, height: 1000 }).visibleFraction, 0);

// ─────────────────────────────────────────────────────────────────────────────
// 2) 脏输入一律归一成「不可见」，绝不抛错。
//    采集端跑在滚动回调里，抛错会打断整个阅读器的滚动链。
// ─────────────────────────────────────────────────────────────────────────────
assert.equal(measure({ blockId: "no-rect", page: 1 }).visibleFraction, 0, "缺 rect 应算不可见");
assert.equal(measure(block("nan-y", Number.NaN, 0.1)).visibleFraction, 0);
assert.equal(measure(block("nan-h", 0.1, Number.NaN)).visibleFraction, 0);
assert.equal(measure(block("zero-h", 0.1, 0)).visibleFraction, 0, "零高度不得除零");
assert.equal(measure(block("neg-h", 0.1, -0.1)).visibleFraction, 0);
// ⚠️ 这里必须直接调 measureBlockVisibility：上面的 measure() 助手带默认参数，
// 传 undefined 会被默认值吃掉，等于没测到「缺页面框架」这条路径（这个坑刚踩过）。
assert.equal(
  measureBlockVisibility(block("no-page", 0.1, 0.1), undefined, VIEWPORT).visibleFraction,
  0,
  "缺页面框架应算不可见"
);
// 真实路径：pickFocusBlock 里页面不在框架表中时，该块必须被排除。
assert.equal(
  pickFocusBlock([block("ghost", 0.1, 0.1, 99)], [PAGE], VIEWPORT),
  undefined,
  "页面没有几何框架的块不得成为焦点"
);
assert.equal(measure(block("other-page", 0.1, 0.1), PAGE).visibleFraction, 1);
assert.equal(
  measure(block("a", 0.1, 0.1), PAGE, { top: 0, height: 0 }).visibleFraction,
  0,
  "视口高度为 0 时不应有可见块"
);

// ─────────────────────────────────────────────────────────────────────────────
// 3) 全网格性质检查：visibleFraction 必须恒在 [0,1] 且有限。
//    这条能一次性抓住 NaN 污染、除零、负数等所有脏输入路径。
// ─────────────────────────────────────────────────────────────────────────────
let swept = 0;
for (let pageTop = -2000; pageTop <= 2000; pageTop += 137) {
  for (let y = 0; y <= 1.0001; y += 0.13) {
    for (let h = 0.05; h <= 0.35; h += 0.1) {
      const m = measure(block("s", y, h), { page: 1, top: pageTop, height: 1000 });
      assert.ok(Number.isFinite(m.visibleFraction), "visibleFraction 必须有限");
      assert.ok(m.visibleFraction >= 0 && m.visibleFraction <= 1, `越界: ${m.visibleFraction}`);
      assert.ok(Number.isFinite(m.visibleHeight) && m.visibleHeight >= 0);
      swept++;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 焦点块选取
// ─────────────────────────────────────────────────────────────────────────────
// 露出 50% 的块不该当选（低于 0.6 阈值）。
{
  const focus = pickFocusBlock([block("half", 0.75, 0.1), block("full", 0.1, 0.1)], [PAGE], VIEWPORT);
  assert.equal(focus?.blockId, "full", "未达可见阈值的块不得成为焦点");
}

// ★ 关键回归：焦点必须按「露出高度」比，而不是块自身高度。
// 一个高 400px、露出 300px 的块（75%），要赢过一个高 100px、完全露出的块。
// 若按块自身高度比，会选错成 small —— 那会让大段落永远抢不到提示。
// 大块：500..900，自身高 400，露出 300（比例 0.75，过阈值）
// 小块：100..420，自身高 320，露出 320（完全可见）
// 露出高度：小块 320 > 大块 300 ⇒ 应选小块；若按块自身高度比，会错选大块。
{
  const big = block("big", 0.5, 0.4);
  const small = block("small", 0.1, 0.32);
  const bigM = measure(big);
  const smallM = measure(small);
  assert.equal(bigM.visibleHeight, 300);
  assert.equal(smallM.visibleHeight, 320);
  const focus = pickFocusBlock([small, big], [PAGE], VIEWPORT);
  assert.equal(focus?.blockId, "small", "焦点应按露出高度比较：露出 320 的小块要赢过露出 300 的大块");
  assert.equal(focus?.visibleHeight, 320);
}

// 反过来：大块露出更多时应当选大块（证明上面那条不是写死了「永远选 small」）。
{
  const fullyVisibleBig = block("big", 0.1, 0.4); // 100..500 ⇒ 露出 400
  const small = block("small", 0.6, 0.1); // 600..700 ⇒ 露出 100
  assert.equal(pickFocusBlock([small, fullyVisibleBig], [PAGE], VIEWPORT)?.blockId, "big");
}

// 露出高度相同时，取更靠上的（页号小优先，其次 y 小），保证结果与入参顺序无关。
{
  const later = block("later", 0.5, 0.1, 2);
  const earlier = block("earlier", 0.5, 0.1, 1);
  assert.equal(pickFocusBlock([later, earlier], [PAGE, { page: 2, top: 0, height: 1000 }], VIEWPORT)?.blockId, "earlier");
  assert.equal(pickFocusBlock([earlier, later], [PAGE, { page: 2, top: 0, height: 1000 }], VIEWPORT)?.blockId, "earlier");
}

assert.equal(pickFocusBlock([], [PAGE], VIEWPORT), undefined, "无块时应返回 undefined");
assert.equal(pickFocusBlock([block("all-off", 0.95, 0.1)], [PAGE], VIEWPORT), undefined);
assert.ok(COMPANION_MIN_VISIBLE_FRACTION > 0 && COMPANION_MIN_VISIBLE_FRACTION < 1);

// ─────────────────────────────────────────────────────────────────────────────
// 5) 停留状态机
// ─────────────────────────────────────────────────────────────────────────────
{
  // 没有焦点块 ⇒ 归零。否则移出正文后残留的 elapsed 会让下次进来立刻触发。
  const step = advanceDwell({ blockId: "x", elapsedMs: 2400, fired: false }, null, 500);
  assert.deepEqual(step.state, COMPANION_DWELL_INITIAL, "失去焦点必须归零");
  assert.equal(step.shouldFire, false);
}

{
  // 焦点块换了 ⇒ 重新计时，且不继承上一块的时长、不把本次 delta 算给新块。
  const step = advanceDwell({ blockId: "a", elapsedMs: 2400, fired: false }, "b", 500);
  assert.equal(step.state.blockId, "b");
  assert.equal(step.state.elapsedMs, 0, "换块必须重新计时，不得继承");
  assert.equal(step.shouldFire, false, "换块后不得立刻触发（否则滚一下就弹）");
}

{
  // 累计到阈值才触发。
  // 首次观测焦点块时 delta 被有意丢弃（新块从 0 起算），所以要多花一个 tick 预热。
  let state = COMPANION_DWELL_INITIAL;
  let firedElapsed = -1;
  let firedTicks = -1;
  let ticks = 0;
  for (let i = 0; i < 10; i++) {
    const step = advanceDwell(state, "a", 500);
    state = step.state;
    ticks++;
    if (step.shouldFire && firedElapsed < 0) {
      firedElapsed = step.state.elapsedMs;
      firedTicks = ticks;
    }
  }
  assert.equal(firedElapsed, COMPANION_DWELL_THRESHOLD_MS, `应在累计 ${COMPANION_DWELL_THRESHOLD_MS}ms 触发，实际 ${firedElapsed}`);
  assert.equal(firedTicks, 6, "首个 tick 用于建立焦点、不计入时长，故应为第 6 个 tick 触发");
  assert.equal(state.fired, true);

  // 触发过之后不得重复触发（滚动抖动不应导致反复弹窗）。
  const after = advanceDwell(state, "a", 5000);
  assert.equal(after.shouldFire, false, "同一块只能触发一次");
  assert.equal(after.state.fired, true);
}

{
  // 负数 / NaN 的 delta 不得让计时倒退或变成 NaN。
  const step = advanceDwell({ blockId: "a", elapsedMs: 1000, fired: false }, "a", -5000);
  assert.equal(step.state.elapsedMs, 1000, "负 delta 必须被忽略，不得倒退");
  const nanStep = advanceDwell({ blockId: "a", elapsedMs: 1000, fired: false }, "a", Number.NaN);
  assert.equal(nanStep.state.elapsedMs, 1000, "NaN delta 必须被忽略");
}

// 阈值边界：恰好等于阈值应触发。
{
  const step = advanceDwell({ blockId: "a", elapsedMs: 2000, fired: false }, "a", 500, 2500);
  assert.equal(step.shouldFire, true, "恰好达到阈值应触发");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) 每页最多 1 条
// ─────────────────────────────────────────────────────────────────────────────
assert.equal(shouldHintForBlock([], { page: 3 }), true);
assert.equal(shouldHintForBlock([3], { page: 3 }), false, "同页已提示过不得再提示");
assert.equal(shouldHintForBlock([3], { page: 4 }), true);

// ── 版面区域过滤（isNonProseRegion）─────────────────────────────────────────
//
// 伴读是主动功能，误报比漏报贵得多：页眉挂上提示会让读者直接关掉整个功能。
// 这里刻意把「页眉页脚页码」三类钉住 —— 它们是实测中最容易被盯上的目标。

// 版心正中的普通正文段：必须放行，否则功能形同虚设。
const BODY = { kind: "text", text: "这是一个正常的正文段落，".repeat(8), rect: { x: 0.15, y: 0.4, width: 0.7, height: 0.08 } };
assert.equal(isNonProseRegion(BODY), false, "★ 版心正文必须放行");

// 顶部条带 = 页眉（论文标题 + 作者 + arXiv 水印常在这里）。
assert.equal(
  isNonProseRegion({ ...BODY, rect: { x: 0.15, y: 0.02, width: 0.7, height: 0.02 } }),
  true,
  "★ 顶部条带视为页眉"
);
// 底部条带 = 页脚 / 页码。
assert.equal(
  isNonProseRegion({ ...BODY, rect: { x: 0.15, y: 0.96, width: 0.7, height: 0.02 } }),
  true,
  "★ 底部条带视为页脚"
);
// 纯页码出现在版心中央也要拒 —— 有些模板把页码排在正文之间。
assert.equal(isNonProseRegion({ ...BODY, text: "12" }), true, "★ 纯数字页码即使在版心也拒");
assert.equal(isNonProseRegion({ ...BODY, text: "Page 3 of 18" }), true, "★ Page N of M 形式也拒");
// 非正文块型：图、表、公式、代码、辅助区（页眉页脚的显式标记）。
for (const kind of ["image", "table", "equation", "code", "auxiliary"]) {
  assert.equal(isNonProseRegion({ ...BODY, kind }), true, `★ ${kind} 不该参与伴读`);
}
// 孤立短窄行：arXiv 水印、版权声明。
assert.equal(
  isNonProseRegion({ ...BODY, text: "Preprint. Do not distribute.", rect: { x: 0.2, y: 0.5, width: 0.3, height: 0.015 } }),
  true,
  "★ 孤立短窄行视为水印"
);
// 标题层级：depth > 0 即标题（MinerU 的 text_level）。
assert.equal(isNonProseRegion({ ...BODY, depth: 1 }), true, "★ 标题不参与伴读");
assert.equal(isNonProseRegion({ ...BODY, depth: 0 }), false, "depth 0 是正文，不是标题");

// 退化输入：没有 rect / 没有文本时无法判断，返回 true 更安全（宁可不提示）。
assert.equal(isNonProseRegion({ kind: "text", text: "有文本" }), true, "无 rect 时保守拒绝");
assert.equal(isNonProseRegion({ kind: "text", text: "   ", rect: BODY.rect }), true, "空白文本拒");
assert.equal(isNonProseRegion({ kind: "text", text: "正文", rect: { x: 0, y: 0.4, width: 0, height: 0.1 } }), true, "零宽拒");

// 反向：宽正文即便靠近版心顶部也不该被条带误杀 —— 阈值留了余量。
assert.equal(
  isNonProseRegion({ ...BODY, rect: { x: 0.15, y: 0.075, width: 0.7, height: 0.05 } }),
  false,
  "★ 条带阈值不得吃进紧贴版心的正文首行"
);

console.log(`companion dwell: ok（${swept} 条网格性质样本 + 版面过滤）`);
