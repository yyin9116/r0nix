/**
 * 划线矩形行吸附的行为断言
 *
 * ## 这一组在断言什么
 *
 * 2026-10-08 实测「只能看到波浪线，看不到其他类型的划线」。
 * z-index 确实错过一次（已修），但**那不是全部** —— 层序完全正确时
 * 划线照样看不见，真因是矩形本身退化成了一条线：
 *
 * `normalizeRect` 的兜底是 `height: Math.max(0.002, bottom - top)`，
 * 而划线这个手势天然是**横着划一道**（手沿着一行文字从左拖到右，
 * 垂直位移接近 0），于是高度落到 0.002 —— 页面高度的 0.2%，
 * A4（842pt）上约 **1.7px**。
 *
 * 1.7px 高的盒子里：
 * - `highlight` 的半透明黄底（alpha 0.28）画上去等于一条若有若无的细缝；
 * - `underline` / `strike` 的渐变线分别定位在盒子的 82%~100% 与 45%~57%，
 *   在 1.7px 里就是**亚像素**，浏览器直接不画。
 *
 * 而波浪线看得见，是因为它由 PageCanvas 画在**文本层内部**，
 * 跟着每个文字片段自己的行盒走，从来不经过这个矩形。
 *
 * 所以修复是：写入前把矩形吸附到 `PdfReadingBlock.lines` 给出的真实行盒上。
 * 纯函数、无 DOM，因此可以在这里精确断言。
 */

import assert from "node:assert/strict";

const { normalizeRect, snapAnnotationRectToLines } = await import(
  "../src/components/pdfReader/readerCore.ts"
);

/**
 * 一行正文在归一化页面坐标里的典型高度。
 * A4 297mm、单倍行距约 4.2mm ≈ 0.0141；US Letter ≈ 0.0150。
 * 与 readerCore 的 LINE_HEIGHT_FALLBACK 同值 —— 这条断言守着两处不漂移。
 */
const LINE_H = 0.014;

/**
 * 浮点比较：归一化坐标是小数（0.2 + 0.014×1.6 这种），累加后必然带尾差。
 * 容差取 1e-9 —— 远小于任何有意义的坐标差（最小的一行是 0.014），
 * 又足以吸收 IEEE754 的表示误差。
 */
const near = (actual, expected, what) => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}：期望 ${expected}，实际 ${actual}（差 ${(actual - expected).toExponential(2)}）`,
  );
};

/** 构造一行：top 为行顶，height 为行高。 */
const line = (top, height = LINE_H, x = 0.1, width = 0.8) => ({
  rect: { x, y: top, width, height },
});

// ===========================================================================
// 1) ★ 核心回归：横着划一道必须被撑成一行高
//    这是「只看到波浪线」那条反馈的直接对应物。
// ===========================================================================
const horizontalDrag = normalizeRect(0.2, 0.3, 0.6, 0.3005);
assert.ok(
  horizontalDrag.height < 0.003,
  `前置条件：横划的原始高度应当极小（实际 ${horizontalDrag.height}）`,
);

const snapped = snapAnnotationRectToLines(horizontalDrag, [line(0.295)]);
assert.ok(
  snapped.height >= LINE_H * 0.9,
  `横划必须被撑成整行高，实际 ${snapped.height} —— 1.7px 的盒子画不出高亮/下划线/删除线`,
);
assert.ok(
  Math.abs(snapped.height - LINE_H) < 1e-9,
  `吸附后高度应恰好等于行盒 ${LINE_H}，实际 ${snapped.height}`,
);

// 纵向位置必须落到行顶，而不是停在用户那 0.5‰ 的偏移上。
near(snapped.y, 0.295, "纵向必须对齐行顶");
// 横向保留用户意图：他自己拖的范围就是「划哪一段」。
near(snapped.x, 0.2, "横向左缘应保留用户起点");
near(snapped.width, 0.4, "横向宽度应保留用户范围");

// ===========================================================================
// 2) 一行的渐变线必须落在**可见厚度**内
//    underline 的线在盒子 82%~100%，strike 在 45%~57%。
//    1.7px 盒子里这两个区间都是亚像素；撑到一行高后才谈得上「可见」。
// ===========================================================================
for (const [name, from, to] of [
  ["underline", 0.82, 1],
  ["strike", 0.45, 0.57],
]) {
  const px = snapped.height * 842; // 归一化高度 → A4 上的像素
  const bandPx = px * (to - from);
  assert.ok(
    bandPx >= 1,
    `${name} 的实际线厚 ${bandPx.toFixed(2)}px 不足 1px —— 浏览器不会绘制（吸附前是 ${(horizontalDrag.height * 842 * (to - from)).toFixed(2)}px）`,
  );
  void from;
}

// ===========================================================================
// 3) 跨行：纵向取命中行的并集
// ===========================================================================
const twoLines = [
  line(0.2),
  line(0.2 + LINE_H * 1.6), // 行距略大于行高，模拟真实排版
];
const acrossTwo = snapAnnotationRectToLines(normalizeRect(0.3, 0.205, 0.5, 0.225), twoLines);
near(acrossTwo.y, 0.2, "并集顶边应对齐首行行顶");
// 并集 = 首行顶 → 次行底 = 0.2 + (1.6+1) × 0.014。
// ⚠️ 不要写成区间 —— 上一个版本写的是「>1.4 行且 <2.2 行」，而实际是 2.6 行，
// 于是这条断言红了。区间在这里没有表达力：精确值才说明「取的是并集」。
near(acrossTwo.height, (1.6 + 1) * LINE_H, "跨两行的高度应等于两行的并集");

// 三行也不能塌成一行（此前「块级rect 过大导致满页波浪线」是反向的坑）。
const threeLines = [line(0.2), line(0.23), line(0.26)];
const acrossThree = snapAnnotationRectToLines(normalizeRect(0.3, 0.205, 0.5, 0.27), threeLines);
near(acrossThree.height, 0.074, "跨三行的高度应等于三行并集");

// ===========================================================================
// 4) 横向**只收窄不外扩**
//    外扩会把高亮涂到相邻行的字上 —— 那比涂窄一点更难解释。
// ===========================================================================
const narrowLines = [line(0.295, LINE_H, 0.3, 0.2)]; // 该行只占 x∈[0.3, 0.5]
const overreaching = snapAnnotationRectToLines(normalizeRect(0.1, 0.3, 0.9, 0.3), narrowLines);
near(overreaching.x, 0.3, "左缘应收窄到行左");
near(overreaching.width, 0.2, "宽度应收窄到行宽");

// 反过来：用户只拖了行内一小段，必须原样保留，不能被撑到整行。
const withinLine = snapAnnotationRectToLines(normalizeRect(0.35, 0.3, 0.42, 0.3), narrowLines);
near(withinLine.x, 0.35, "行内小段不能被外扩");
near(withinLine.width, 0.07, "行内小段的宽度不能被撑开");

// ===========================================================================
// 5) 拿不到行数据时退回一行高，而不是留一条 1.7px 的缝
//    老数据（markdown 来源）与表格/图注没有 `lines`，但「至少有一行高」
//    是产品底线 —— 读者不该因为解析器没给行框就什么都看不到。
// ===========================================================================
for (const [name, lines] of [
  ["undefined", undefined],
  ["空数组", []],
  ["全无 rect", [{ text: "x" }, { rect: undefined }]],
  ["零面积行", [{ rect: { x: 0.2, y: 0.3, width: 0, height: 0 } }]],
]) {
  const fallback = snapAnnotationRectToLines(horizontalDrag, lines);
  assert.ok(
    fallback.height >= LINE_H * 0.9,
    `${name} 的情形必须退回一行高，实际 ${fallback.height}`,
  );
  near(fallback.x, horizontalDrag.x, `${name} 时横向不应被动`);
}

// ===========================================================================
// 6) 纵向不重叠时也要有可见高度
//    拖到两段文字之间的空白处，命不中任何行 —— 但那仍然是「读者划了一笔」。
// ===========================================================================
const inGap = snapAnnotationRectToLines(normalizeRect(0.3, 0.22, 0.5, 0.22), [line(0.1), line(0.5)]);
assert.ok(inGap.height >= LINE_H * 0.9, `空白处也要有一行高，实际 ${inGap.height}`);
near(inGap.y, 0.22, "空白处不应被挪到别的行的位置");

// ===========================================================================
// 7) 脏数据不产生 NaN —— NaN 会一路传染到 style，静默变成「不显示」
// ===========================================================================
const dirtyInputs = [
  { x: NaN, y: 0.3, width: 0.3, height: 0.01 },
  { x: 0.2, y: NaN, width: 0.3, height: 0.01 },
  { x: 0.2, y: 0.3, width: NaN, height: 0.01 },
  { x: 0.2, y: 0.3, width: 0.3, height: NaN },
  { x: Infinity, y: 0.3, width: 0.3, height: 0.01 },
];
for (const rect of dirtyInputs) {
  const out = snapAnnotationRectToLines(rect, [line(0.295)]);
  for (const [key, value] of Object.entries(out)) {
    assert.ok(
      Number.isFinite(value),
      `${key}=${value} 不是有限数 —— NaN/Infinity 会让这一条标注静默不显示（输入 ${JSON.stringify(rect)}）`,
    );
  }
}
// 退化矩形（零宽/零高）原样返回，交给上层判定，不在这里"修好"。
for (const rect of [
  { x: 0.2, y: 0.3, width: 0, height: 0 },
  { x: 0.2, y: 0.3, width: 0.3, height: 0 },
]) {
  assert.deepEqual(snapAnnotationRectToLines(rect, [line(0.295)]), rect);
}

// ===========================================================================
// 8) 幂等：吸附结果再吸附不变
//    不满足它，重复保存同一条标注会让它逐次长高（一行 → 两行 → 三行）。
// ===========================================================================
const once = snapAnnotationRectToLines(horizontalDrag, [line(0.295), line(0.295 + LINE_H * 1.6)]);
const twice = snapAnnotationRectToLines(once, [line(0.295), line(0.295 + LINE_H * 1.6)]);
assert.deepEqual(twice, once, `吸附不幂等：${JSON.stringify(once)} → ${JSON.stringify(twice)}`);

// ===========================================================================
// 9) normalizeRect 自身的兜底值被钉住
//    上面所有断言都建立在「横划高度确实是 0.002」这个前提上。
// ===========================================================================
assert.equal(horizontalDrag.height, 0.002);
assert.equal(normalizeRect(0.2, 0.3, 0.2, 0.3).width, 0.002);
assert.ok(normalizeRect(0.2, 0.3, 0.6, 0.5).height > 0.19, "斜向拖拽的高度应保持原值");

console.log("annotation line snapping: ok");
console.log(`  横划原始高度 ${horizontalDrag.height}（${(horizontalDrag.height * 842).toFixed(1)}px）→ 吸附后 ${snapped.height}（${(snapped.height * 842).toFixed(1)}px）`);
console.log(`  下划线线厚：${(horizontalDrag.height * 842 * 0.18).toFixed(2)}px → ${(snapped.height * 842 * 0.18).toFixed(2)}px`);
console.log(`  跨行并集 ${acrossThree.height}；无行数据时退回 ${snapAnnotationRectToLines(horizontalDrag, undefined).height}`);