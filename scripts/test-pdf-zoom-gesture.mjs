/**
 * pdf-zoom-gesture 行为断言
 *
 * 这些断言存在的理由：捏合的参数是「实测标定」出来的（PINCH_ZOOM_K 的注释里
 * 记了依据），标定值最容易被后人随手改坏 —— 改大一点「更跟手」，改小一点
 * 「更稳」，两种改动都不会让类型报错、也不会让页面崩，只会让手感悄悄走样。
 * 所以这里把「跟手」量化成上下界钉住。
 */

import assert from "node:assert/strict";

const {
  PINCH_ZOOM_K,
  WHEEL_LINE_HEIGHT_PX,
  isPinchGesture,
  normalizeWheelDeltaY,
  pinchZoomFactor,
} = await import("../src/services/pdfZoomGesture.ts");

// ---------------------------------------------------------------- 捏合识别
assert.equal(isPinchGesture({ ctrlKey: true }), true);
assert.equal(isPinchGesture({ metaKey: true }), true);
assert.equal(isPinchGesture({}), false, "普通 wheel 不是捏合 —— 否则滚动会被当成缩放");
assert.equal(isPinchGesture({ ctrlKey: false, metaKey: false }), false);

// ------------------------------------------------------- deltaMode 归一化
assert.equal(normalizeWheelDeltaY(10, 0), 10);
assert.equal(normalizeWheelDeltaY(10, 1), 10 * WHEEL_LINE_HEIGHT_PX);
assert.equal(normalizeWheelDeltaY(NaN, 0), 0, "非有限值必须归零，不能把 NaN 传进 exp");
assert.equal(normalizeWheelDeltaY(Infinity, 0), 0);
// Firefox 走「行」，量级差 16 倍；不归一的话同一个手势会慢 16 倍
assert.ok(
  Math.abs(normalizeWheelDeltaY(10, 1)) > Math.abs(normalizeWheelDeltaY(10, 0)) * 8,
  "deltaMode=1 必须被放大，否则 Firefox 上捏合几乎不动",
);

// ------------------------------------------------------------- 方向与单调
assert.ok(pinchZoomFactor(-10) > 1, "捏开（deltaY<0）必须放大");
assert.ok(pinchZoomFactor(10) < 1, "捏合（deltaY>0）必须缩小");
assert.equal(pinchZoomFactor(0), 1, "零位移必须是恒等倍率");
assert.ok(
  pinchZoomFactor(-20) > pinchZoomFactor(-10),
  "位移越大倍率越大 —— 单调性是「跟手」的最低要求",
);
assert.ok(pinchZoomFactor(-20) > pinchZoomFactor(-10) && pinchZoomFactor(20) < pinchZoomFactor(10));

// 往返一致：捏开再捏回同样的量，必须回到原处（防累积漂移）
for (const delta of [1, 3.1, 7.6, 14.3, 60]) {
  const roundTrip = pinchZoomFactor(-delta) * pinchZoomFactor(delta);
  assert.ok(
    Math.abs(roundTrip - 1) < 1e-9,
    `往返必须回到 1（delta=${delta} 得到 ${roundTrip}）`,
  );
}

// ------------------------------------------------- ★ 量级：跟手但不爆
// 评价单位刻意用「累积位移」而不是「一个 500ms 窗口」：实测窗口里事件数从 1 到 15
// 不等、单次 |deltaY| 从 3.1 到 14.3 不等，窗口是一个采样单位，不是手势单位 ——
// 拿它当下界，等于把「用户还在捏的初期」当成「捏了没反应」。
// 位移才是本质：手指走过的总距离决定放大多少。
const per100 = pinchZoomFactor(-100);
assert.ok(per100 > 1.25, `每 100px 位移只放大到 ${per100.toFixed(3)} 倍 —— 太钝`);
assert.ok(per100 < 1.45, `每 100px 位移放大到 ${per100.toFixed(3)} 倍 —— 太猛`);
// 最小可感：实测单次事件最小 3.1，它必须产生肉眼可见但不过头的变化
const single = pinchZoomFactor(-3.1);
assert.ok(single > 1.005, `单次事件 ${single.toFixed(4)} 倍 —— 每帧几乎不动，会显得卡`);
assert.ok(single < 1.05, `单次事件 ${single.toFixed(4)} 倍 —— 每帧跳变太大`);
// 上限：一次很长的捏合（400px 累积）也不该超过一个数量级
assert.ok(pinchZoomFactor(-400) < 3.5, "长手势必须收敛在合理倍率内");

// -------------------------------- ★ 反证：滚轮公式绝不能套在捏合上
// 这是本模块存在的全部理由。拿滚轮那组参数（0.14 灵敏度 / 最小 7% 步长）
// 处理同一个窗口，每个事件都会被 MIN_STEP 兜底成 +7%，累积直接翻倍。
const wheelStep = (deltaY) => Math.max(7, Math.min(24, Math.abs(deltaY) * 0.14));
let wheelZoom = 100;
let pinchZoom = 100;
for (let index = 0; index < 15; index += 1) {
  wheelZoom += wheelStep(7.6);
  pinchZoom *= pinchZoomFactor(-7.6);
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
for (const delta of [-1000, 1000, 0.001, -0.001]) {
  const factor = pinchZoomFactor(delta);
  assert.ok(Number.isFinite(factor) && factor > 0, `极端输入必须给出有限正值（${delta}）`);
}
assert.ok(Number.isFinite(PINCH_ZOOM_K) && PINCH_ZOOM_K > 0);

console.log("pdf-zoom-gesture: ok（捏合识别 / deltaMode 归一 / 方向 / 往返 / 量级上下界）");
