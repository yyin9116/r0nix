/**
 * pdf-zoom-gesture 行为断言
 *
 * ## 这一组在断言什么（识别交给库之后）
 *
 * 2026-10-08 起，wheel/pinch 的**识别**（modifierKey、deltaMode 归一、
 * non-passive 绑定、捏合倍率累积）由 `@use-gesture/react` 负责，
 * 本模块只剩「库给的量 → 缩放目标」这段产品决策。
 *
 * 所以断言的重心也跟着换。不再验「有没有正确识别出捏合」，而是钉住
 * 三个**库不会替我们决定、且错了不报错**的地方：
 *
 * 1. 捏合与滚轮必须是**两套语义**（等比倍率 vs 离散步进）；
 * 2. 步进必须夹在上下界之间（跟手，但单步不炸）；
 * 3. ★ 库给的量必须先**换算**再喂给 zoom —— 捏合要除掉手势起点，
 *    滚轮要取单事件位移。这两条都是本轮实测踩到的真 bug（见下面两节），
 *    它们不会让页面报错，只会让手感变得莫名其妙。
 *
 * 标定值来自 WKWebView 实测，改动前请先读 `PINCH_ZOOM_K` 的注释。
 */

import assert from "node:assert/strict";

const {
  LIB_PINCH_WHEEL_RATIO,
  PINCH_ZOOM_GAIN,
  PINCH_ZOOM_K,
  PINCH_ZOOM_SMALL_AMPLITUDE_GAIN,
  WHEEL_ZOOM_MAX_STEP,
  WHEEL_ZOOM_MIN_STEP,
  WHEEL_ZOOM_SENSITIVITY,
  isPinchGesture,
  pinchZoomFactor,
  wheelZoomStep,
} = await import("../src/services/pdfZoomGesture.ts");

// ----------------------------------------------------------------捏合识别
// 这一条现在的用途是「与 useGesture 的 pinch.modifierKey 保持一致」，
// 而不是自己识别手势 —— 库判捏合、这里判「这个事件已被库判为捏合」。
assert.equal(isPinchGesture({ ctrlKey: true }), true);
assert.equal(isPinchGesture({ metaKey: true }), true);
assert.equal(isPinchGesture({}), false, "普通 wheel 不是捏合 —— 否则滚动会被当成缩放");
assert.equal(isPinchGesture({ ctrlKey: false, metaKey: false }), false);

// =========================================================================
// ★ 捏合：必须除掉手势起点
//
// 库的 PinchEngine 里 `offset` 由 `init()` 设成 [1,0]，而 `reset()`
// **不重置 offset** —— 一次手势结束时它是 1.75，下一次手势 start() 时
// `lastOffset = state.offset = 1.75`，新的 offset 从 1.75 继续累。
//
// 直接把 offset 当倍率用，第二次捏合会先凭空放大 1.75 倍。
// 所以下面所有断言都用 (offset, lastOffset) 二元组，
// 并且专门有一条断言模拟「第二次手势」。
// =========================================================================

// 手势起点必须真的被除掉：同样的 offset，起点不同 → 结果不同。
assert.notEqual(
  pinchZoomFactor(1.75, 1),
  pinchZoomFactor(1.75, 1.75),
  "手势起点必须参与换算 —— 否则第二次捏合会重复计入上一次的量",
);
assert.equal(
  pinchZoomFactor(1.75, 1.75),
  1,
  "offset 等于起点时必须是恒等倍率（手势刚开始的第一个事件）",
);
assert.ok(pinchZoomFactor(1.75, 1) > 1, "捏开必须放大");

// ---- ★ 反证：第二次手势不能比第一次夸张
// 这是本轮修掉的真 bug 的最小复现。库里两次手势的 offset 是连着的
// （第二次从 1.75 起累），若不除掉起点，第二次的实际倍率会是 1.75×1.75 的量级。
const firstGesture = { start: 1, end: 1.75 };
const secondGesture = { start: 1.75, end: 1.75 * 1.75 };
const firstFactor = pinchZoomFactor(firstGesture.end, firstGesture.start);
const secondFactor = pinchZoomFactor(secondGesture.end, secondGesture.start);
assert.ok(
  Math.abs(firstFactor - secondFactor) < 1e-9,
  `同样幅度的两次捏合必须给出同样的倍率（${firstFactor.toFixed(4)} vs ${secondFactor.toFixed(4)}）—— ` +
    "起点没被除掉时第二次会凭空大一倍",
);

// 三次、四次…：无论在第几次，幅度相同就得倍率相同（幂等性）。
let running = 1;
for (let index = 0; index < 6; index += 1) {
  const next = running * 1.75;
  const factor = pinchZoomFactor(next, running);
  assert.ok(
    Math.abs(factor - firstFactor) < 1e-9,
    `第 ${index + 1} 次捏合的倍率必须是 ${firstFactor.toFixed(4)}，实际 ${factor.toFixed(4)}`,
  );
  running = next;
}

// 方向与单调（相对量 r = offset/start，>1 放大、<1 缩小）
assert.ok(pinchZoomFactor(1.1, 1) > 1, "相对量 >1 必须放大");
assert.ok(pinchZoomFactor(0.9, 1) < 1, "相对量 <1 必须缩小");
assert.ok(
  pinchZoomFactor(1.2, 1) > pinchZoomFactor(1.1, 1),
  "相对量越大倍率越大 —— 单调性是「跟手」的最低要求",
);
assert.ok(
  pinchZoomFactor(0.8, 1) < pinchZoomFactor(0.9, 1),
  "反向也要单调，否则捏回去会先放大再缩小",
);

// 往返一致：捏开再捏回同样的量，必须回到原处（防累积漂移）
for (const ratio of [1.01, 1.031, 1.076, 1.143, 1.6]) {
  const roundTrip = pinchZoomFactor(ratio, 1) * pinchZoomFactor(1 / ratio, 1);
  assert.ok(
    Math.abs(roundTrip - 1) < 1e-9,
    `往返必须回到 1（r=${ratio} 得到 ${roundTrip}）`,
  );
}

// ------------------------------------------------- ★ 量级：跟手但不爆
// 评价单位用「累积捏合像素」而不是「一个 500ms 窗口」：实测窗口里事件数
// 从 1 到 15 不等、单次 |deltaY| 从 3.1 到 14.3 不等，窗口是一个采样单位，
// 不是手势单位 —— 拿它当下界，等于把「用户还在捏的初期」当成「捏了没反应」。
// 位移才是本质：手指走过的总距离决定放大多少。
//
// 从像素换算到库的相对量：库按 `-deltaY / LIB_PINCH_WHEEL_RATIO` 线性累积，
// 放大方向捏开时 deltaY 为负，于是 r ≈ 1 + pixels / RATIO。
const libraryRatioFor = (pixels) => 1 + pixels / LIB_PINCH_WHEEL_RATIO;
const factorForPixels = (pixels) => pinchZoomFactor(libraryRatioFor(pixels), 1);

const per100 = factorForPixels(100);
assert.ok(per100 > 1.25, `每 100px 位移只放大到 ${per100.toFixed(3)} 倍 —— 太钝`);
assert.ok(per100 < 1.45, `每 100px 位移放大到 ${per100.toFixed(3)} 倍 —— 太猛`);
// 实测端点：一次典型捏合 75~114px，两端都要落回标定区间。
assert.ok(
  factorForPixels(75) > 1.2 && factorForPixels(75) < 1.45,
  `实测下端 75px 得到 ${factorForPixels(75).toFixed(3)} 倍 —— 跑出标定区间`,
);
assert.ok(
  factorForPixels(114) > 1.2 && factorForPixels(114) < 1.45,
  `实测上端 114px 得到 ${factorForPixels(114).toFixed(3)} 倍 —— 跑出标定区间`,
);
// 最小可感：实测单次事件最小 3.1px，它必须产生肉眼可见但不过头的变化
const single = factorForPixels(3.1);
assert.ok(single > 1.002, `单次事件 ${single.toFixed(4)} 倍 —— 每帧几乎不动，会显得卡`);
assert.ok(single < 1.05, `单次事件 ${single.toFixed(4)} 倍 —— 每帧跳变太大`);
// 上限：一次很长的捏合（400px 累积）也不该超过一个数量级
assert.ok(factorForPixels(400) < 3.5, "长手势必须收敛在合理倍率内");

// ------------------------------------------------------------ 滚轮步进
// 滚轮是离散步进：每格一次，用增量，且必须夹在上下界内。
assert.equal(wheelZoomStep(0), 0, "零位移没有步进");
assert.equal(wheelZoomStep(NaN), 0, "非有限值不能变成 NaN 步进");
assert.equal(wheelZoomStep(Infinity), 0);
assert.ok(wheelZoomStep(-10) > 0, "向上滚（deltaY<0）必须放大");
assert.ok(wheelZoomStep(10) < 0, "向下滚必须缩小");
// 夹住下界：极小位移也要有可感变化，否则「滚了没反应」
assert.equal(wheelZoomStep(-0.5), WHEEL_ZOOM_MIN_STEP, "微小位移必须被抬到最小步进");
// 夹住上界：单次大位移不能跨太多，否则精调不可能
assert.equal(wheelZoomStep(-100000), WHEEL_ZOOM_MAX_STEP, "大步进必须被夹到上限");
assert.equal(wheelZoomStep(100000), -WHEEL_ZOOM_MAX_STEP);
// 落在区间内
for (const delta of [-1, -7.6, -14.3, -100]) {
  const step = Math.abs(wheelZoomStep(delta));
  assert.ok(
    step >= WHEEL_ZOOM_MIN_STEP && step <= WHEEL_ZOOM_MAX_STEP,
    `步进 ${step} 跑出了 [${WHEEL_ZOOM_MIN_STEP}, ${WHEEL_ZOOM_MAX_STEP}]（delta=${delta}）`,
  );
}

// =========================================================================
// ★ 滚轮：入参必须是「单事件位移」，不能是手势累积量
//
// 库的 WheelEngine 是坐标引擎，movement 来自 _movement 的累加，
// 而一次 wheel 手势要到 140ms 无新事件才结束。连续滚动时movement
// 是这一串滚动的总位移，拿它当单事件步进就会「越滚越快」。
//
// 纯函数层无法区分两者（它们都是数字），但可以钉住**这条不变量的后果**：
// 单事件步进下，一串同增量的滚轮必须每格步进一致 —— 这正是
// PDFViewer 传delta[1] 时读者实际感受到的东西。
// =========================================================================
const NOTCH = -7.6;
let singleEventZoom = 100;
const perNotch = [];
for (let index = 0; index < 15; index += 1) {
  const step = wheelZoomStep(NOTCH); // 每次都是同一个单事件位移
  perNotch.push(step);
  singleEventZoom += step;
}
assert.equal(
  new Set(perNotch).size,
  1,
  `同样一格滚轮的步进必须恒定，实际得到 ${[...new Set(perNotch)]} —— ` +
    "累积量入参会让步进逐格变大（越滚越快）",
);

// 反证：若误传累积量（1×、2×、3×…的 NOTCH），步进会逐格膨胀。
// ⚠️ 断言对准的是「步进逐格变大」这个性质本身，而不是「总倍率差很多」——
// MAX_STEP=24 的夹取会把累积量的后期步进削平，总量差被压到 1.2 倍左右。
// 读者真正感受到的是「越滚越快」（每格的落差从 7% 一路涨到 15%），
// 那个才是要守的东西。
let accumulatedZoom = 100;
let accumulated = 0;
const growingSteps = [];
for (let index = 1; index <= 15; index += 1) {
  accumulated += NOTCH;
  const step = wheelZoomStep(accumulated);
  growingSteps.push(step);
  accumulatedZoom += step;
}
assert.ok(
  new Set(growingSteps).size > 1,
  "累积量入参必须产生逐格变大的步进（否则这条反证本身失效）",
);
assert.ok(
  growingSteps.at(-1) > growingSteps[0] * 1.5,
  `累积量入参的末格步进 ${growingSteps.at(-1)} 相对首格 ${growingSteps[0]} 必须明显更大 —— ` +
    "这正是读者抱怨的「越滚越快」",
);
// 末格步进应已越过线性外推值（7.6 × 0.14 ≈ 1.06%，被MIN_STEP 兜到 7%）：
// 累积 15 格后真实 deltaY 是 114px，线性外推才 1.2%，却给到了 15.96%。
assert.ok(
  growingSteps.at(-1) > WHEEL_ZOOM_MIN_STEP * 2,
  `累积 15 格（114px）的步进 ${growingSteps.at(-1)} 必须远超 MIN_STEP=${WHEEL_ZOOM_MIN_STEP} —— ` +
    "单事件步进下它恒为 7%",
);
assert.ok(
  accumulatedZoom > singleEventZoom,
  `误传累积量放得更多（${(accumulatedZoom / 100).toFixed(2)}× vs ${(singleEventZoom / 100).toFixed(2)}×）`,
);

// -------------------------------- ★ 反证：滚轮公式绝不能套在捏合上
// 这是本模块存在的全部理由。捏合一次手势派发十几个事件，
// 若按滚轮那套「每事件至少 +7%」的步进处理，直接翻倍。
let wheelZoom = 100;
let pinchZoom = 100;
for (let index = 0; index < 15; index += 1) {
  wheelZoom += wheelZoomStep(NOTCH);
  pinchZoom *= factorForPixels(-NOTCH);
}
assert.ok(
  wheelZoom / 100 > 1.9,
  `滚轮公式套捏合会得到 ${(wheelZoom / 100).toFixed(2)} 倍 —— 正是要避免的结果`,
);
assert.ok(pinchZoom / 100 < 1.6, "捏合路径必须显著小于滚轮路径");
assert.ok(
  wheelZoom / 100 - pinchZoom / 100 > 0.4,
  "两条路径必须差得足够远，否则说明参数没有真正分开",
);

// ------------------------------------------------------------ 健壮性
// 捏合：非有限值、零起点、负偏移都必须退化成「不缩放」，而不是 NaN 传给 zoom。
for (const [offset, start] of [
  [NaN, 1],
  [Infinity, 1],
  [1.5, NaN],
  [1.5, 0],
  [1.5, -1],
  [0, 1],
  [-1.5, 1],
]) {
  const factor = pinchZoomFactor(offset, start);
  assert.ok(
    Number.isFinite(factor) && factor > 0,
    `极端输入必须给出有限正值（offset=${offset}, start=${start} 得到 ${factor}）`,
  );
}
for (const delta of [-1000, 1000, 0.001, -0.001]) {
  const factor = wheelZoomStep(delta);
  assert.ok(Number.isFinite(factor), `极端输入必须给出有限步进（${delta}）`);
}

// ------------------------------------------------------- 常量自身的约束
assert.ok(Number.isFinite(PINCH_ZOOM_K) && PINCH_ZOOM_K > 0);
assert.ok(Number.isFinite(WHEEL_ZOOM_SENSITIVITY) && WHEEL_ZOOM_SENSITIVITY > 0);
assert.ok(WHEEL_ZOOM_MIN_STEP < WHEEL_ZOOM_MAX_STEP, "步进上下界必须有序，否则夹取结果反号");

// 库内部常量的复刻值：打错一位会立刻改变手感，必须钉住。
assert.equal(
  LIB_PINCH_WHEEL_RATIO,
  100,
  "库内部 PINCH_WHEEL_RATIO 的复刻值必须是 100（复刻错了会静默改变捏合手感）",
);
// 增益推导链：小幅度等价值 = K × RATIO，最终增益不低于它
//（抬高是为了补偿库那份线性累积在大幅度下的偏高）。
assert.equal(
  PINCH_ZOOM_SMALL_AMPLITUDE_GAIN,
  PINCH_ZOOM_K * LIB_PINCH_WHEEL_RATIO,
  "小幅度等价增益必须由 K × RATIO 推出，否则推导链断了",
);
assert.ok(
  Math.abs(PINCH_ZOOM_SMALL_AMPLITUDE_GAIN - 0.3) < 1e-9,
  `小幅度等价增益应是 0.3，实际 ${PINCH_ZOOM_SMALL_AMPLITUDE_GAIN}`,
);
assert.ok(
  PINCH_ZOOM_GAIN > PINCH_ZOOM_SMALL_AMPLITUDE_GAIN,
  "最终增益必须高于小幅度等价值 —— 库的线性累积在大幅度下偏高，需要压回来",
);
assert.ok(
  PINCH_ZOOM_GAIN <= 0.5,
  `增益 ${PINCH_ZOOM_GAIN} 过大：等于放弃手感标定，退回库的默认手感`,
);

console.log(
  "pdf-zoom-gesture: ok（捏合换算掉手势起点 / 滚轮单事件步进恒定 / 双路径分离 / 往返一致）",
);
console.log(`  捏合 100px → ${per100.toFixed(3)}×，75px → ${factorForPixels(75).toFixed(3)}×，114px → ${factorForPixels(114).toFixed(3)}×`);
console.log(`  同幅度第二次捏合 ${secondFactor.toFixed(4)}× = 第一次 ${firstFactor.toFixed(4)}×（幂等）`);
console.log(`  15 格滚轮：单事件 ${(singleEventZoom / 100).toFixed(3)}× vs 误传累积 ${(accumulatedZoom / 100).toFixed(3)}×`);