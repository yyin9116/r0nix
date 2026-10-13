/**
 * PDF 缩放手势契约。
 *
 * ## 为什么需要这份契约
 *
 * 缩放原本是手写的 wheel 监听（2026-10-08 反馈：「按住右键滚动滚轮缩放的效果
 * 似乎是手写的」）。换成 @use-gesture 之后，代码变短了，但**出错方式变得更隐蔽**：
 * 手写版算错了，肉眼立刻能看出缩放不对；库版算错了依然能缩，只是手感变了 ——
 * 而「手感不对」在一个只断言「能缩放」的测试里永远不会红。
 *
 * 这份契约钉的就是那三件「错了不报错」的事（行为数值由
 * scripts/test-pdf-zoom-gesture.mjs 负责）：
 *
 *  ① 真的用了库。回退成 addEventListener 不会崩，只会悄悄退回手写的老问题。
 *  ② onPinch 取的是 offset / lastOffset 的**比值**，而不是 offset 本身。
 *  ③ onWheel 取的是 delta（单事件位移），而不是 movement（手势累积量）。
 *
 * ② ③ 单独拎出来说，因为它们是这次改造里真实踩到的两个坑：
 *  · PinchEngine 的 offset 跨手势累积（reset() 不重置它），直接用 offset
 *    会导致第二次捏合凭空放大 1.75 倍；
 *  · WheelEngine 的 movement 逐事件累加且要到 140ms 无新事件才结算，
 *    直接用 movement 会「越滚越快」。
 *
 * 两者都是「值算得出来、量纲用错」的类型 —— 只有把取值来源写进契约，
 * 下一个人复制粘贴时才不会把它们改回去。
 */
import { readFileSync } from "node:fs";

const viewer = readFileSync("src/components/PDFViewer.tsx", "utf8");
const service = readFileSync("src/services/pdfZoomGesture.ts", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── ① 必须走库，而不是手写监听 ─────────────────────────────────────────────
assert(
  viewer.includes('import { useGesture } from "@use-gesture/react";'),
  "PDF zoom gestures must go through @use-gesture, not hand-rolled wheel listeners."
);
assert(
  service.includes("isPinchGesture"),
  "the shared zoom service must expose the pinch/wheel discriminator."
);
// 手写监听一旦回来，这两条会先命中：它们是「退化回手写」最常见的入口。
assert(
  !/addEventListener\(\s*["']wheel["']/.test(viewer),
  "no raw wheel listener may be added in the viewer; it would bypass the pinch/wheel mutual exclusion."
);
assert(
  !/onWheel=\{\s*\(?e\)?\s*=>/.test(viewer),
  "a hand-written JSX onWheel handler would silently bypass @use-gesture; remove it instead of adding both."
);

// ── ②捏合：必须除掉手势起点 ────────────────────────────────────────────────
// 这条钉的是**取值来源**，不是结果数值（数值由 pdf-zoom-gesture 测试负责）。
//
// 用「定位 onPinch → 取窗口」而不是一条长正则：参数列表常被 prettier 折行、
// 对齐空格也不稳定，写死空白模式的断言会在一次纯格式化之后集体变红，
// 而变红的人只会去改断言 —— 这是契约自己被磨掉的典型路径。
const pinchAt = viewer.indexOf("onPinch:");
assert(pinchAt > 0, "useGesture must define an onPinch handler.");
const pinchBody = viewer.slice(pinchAt, pinchAt + 400);
assert(
  pinchBody.includes("offset: [scale]") && pinchBody.includes("lastOffset: [startScale]"),
  "onPinch must destructure both offset and lastOffset: PinchEngine's offset accumulates across gestures, so the raw offset is not this gesture's ratio."
);
assert(
  pinchBody.includes("pinchZoomFactor(scale, startScale)"),
  "onPinch must pass the gesture start offset into pinchZoomFactor; dropping it makes the second pinch ~1.75x larger."
);
assert(
  /export function pinchZoomFactor\(gestureOffset: number, gestureStartOffset: number\)/.test(service),
  "pinchZoomFactor must take the start offset as a second argument — a single-argument signature cannot express the ratio."
);
assert(
  /const ratio = gestureOffset \/ gestureStartOffset;/.test(service),
  "pinchZoomFactor must divide by the gesture start offset; that division IS the fix for cross-gesture accumulation."
);

// ── ③ 滚轮：必须取单事件位移 ───────────────────────────────────────────────
const wheelAt = viewer.indexOf("onWheel:");
assert(wheelAt > 0, "useGesture must define an onWheel handler.");
const wheelBody = viewer.slice(wheelAt, wheelAt + 500);
assert(
  wheelBody.includes("delta: [, deltaY]"),
  "onWheel must destructure delta (per-event), not movement: movement accumulates for the whole gesture, making zoom accelerate while scrolling."
);
assert(
  wheelBody.includes("wheelZoomStep(deltaY)"),
  "onWheel must feed the single-event deltaY into wheelZoomStep."
);
assert(
  wheelBody.includes("isPinchGesture(event as WheelEvent))"),
  "onWheel must bail out for pinch gestures: a single right-button wheel gesture fires both handlers, so without this the zoom is applied twice."
);

// ── 结构性前提：passive 与 modifierKey ─────────────────────────────────────
// eventOptions.passive 必须是 false，否则 preventDefault() 静默失效（控制台一条
// 警告而已），表现是「按住右键时页面跟着一起滚」。
assert(
  /eventOptions:\s*\{\s*passive:\s*false\s*\}/.test(viewer),
  "useGesture must receive eventOptions.passive = false, otherwise preventDefault() silently fails and the page scrolls while zooming."
);
// 两个引擎监听同一批 wheel 事件，靠 modifierKey 区分 —— 库里和我们的判据
// 必须指向**同一组键**，否则 isPinchGesture 会拦掉本该由 onWheel 处理的事件
// （表现为「触控板捏合完全没反应」或「右键滚轮缩放不生效」）。
//
// 这条断言跨两个文件比对：只在一边加 ctrlKey 的话，两边边界错开，且症状是
// 「某个设备上功能整个失灵」，极难定位。
const modifierKeys = /pinch:\s*\{[\s\S]{0,200}?modifierKey:\s*\[([^\]]*)\]/.exec(viewer);
assert(modifierKeys, "pinch.modifierKey must be declared so the library and our own discriminator agree on which keys mean pinch.");
const declaredKeys = [...modifierKeys[1].matchAll(/["'](\w+)["']/g)].map((m) => m[1]);
assert(declaredKeys.length > 0, "pinch.modifierKey must list at least one key.");
for (const key of declaredKeys) {
  assert(
    service.includes(`event.${key} === true`),
    `isPinchGesture must test "${key}" — it is declared as pinch.modifierKey, so the two paths must not disagree on which gesture means pinch.`
  );
}
assert(
  /event\.ctrlKey === true \|\| event\.metaKey === true/.test(service),
  "isPinchGesture must combine the modifier keys with OR; trackpad pinch is synthesised as either ctrl+wheel or meta+wheel."
);
assert(
  viewer.includes("pinchOnWheel: true"),
  "pinch.pinchOnWheel must be enabled, otherwise trackpad pinch (delivered as wheel+ctrl) is never recognised."
);
// 右键**不属于**库的 modifierKey 体系：它由我们自己判。分工是刻意的 ——
// isPinchGesture 答「这是捏合吗」，isGestureRightDown 答「右键按下了吗」，
// onWheel 需要同时满足两者。把右键塞进 isPinchGesture 会让它在
// 「右键按住 + 触控板捏合」时给出错误答案（库那边根本不 care 按了哪个键）。
assert(
  /isGestureRightDownRef\.current/.test(viewer),
  "onWheel must additionally require the right mouse button; without it every ordinary scroll zooms."
);
assert(
  /isGestureRightDown\s*=|const isGestureRightDown/.test(viewer),
  "the right-button state must be tracked from real pointer events, not inferred from the wheel event."
);
assert(
  !/button/.test(service.slice(service.indexOf("export function isPinchGesture"), service.indexOf("export function isPinchGesture") + 300)),
  "isPinchGesture must not test the mouse button: it answers 'is this a pinch', and mixing in the button makes it wrong when a pinch happens while the right button is held."
);

console.log("pdf-gesture-contract: ok");