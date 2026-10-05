import assert from "node:assert/strict";
import {
  OVERLAY_VIEWPORT_MARGIN,
  clampOverlayPoint,
  resolveOverlayPoint,
} from "../src/services/overlayPlacement.ts";

const WIDE = { width: 1440, height: 900 };

// 1) 居中且不出界：不做任何钳制，left = 锚点 - 半宽。
assert.deepEqual(
  resolveOverlayPoint({ x: 700, y: 300 }, { width: 292, height: 44 }, "centered", WIDE),
  { left: 554, top: 300 }
);

// 2) 贴左边缘：退到左边距，不产生负坐标。
assert.deepEqual(
  resolveOverlayPoint({ x: 40, y: 300 }, { width: 292, height: 44 }, "centered", WIDE),
  { left: OVERLAY_VIEWPORT_MARGIN, top: 300 }
);

// 3) 贴右边缘：按**实测**宽度退让。
assert.deepEqual(
  resolveOverlayPoint({ x: 1435, y: 300 }, { width: 390, height: 60 }, "centered", WIDE),
  { left: WIDE.width - 390 - OVERLAY_VIEWPORT_MARGIN, top: 300 }
);

// 4) 本次修复存在的理由：同一锚点、不同实测尺寸必须得到不同结果。
//    旧实现把「收起 / 展开」当成两个写死的尺寸，而真实宽度是
//    min(390px, calc(100vw - 24px)) —— 宽度的函数，常量不可能同时对。
const sharedAnchor = { x: 1400, y: 500 };
const collapsed = resolveOverlayPoint(sharedAnchor, { width: 292, height: 44 }, "centered", WIDE);
const expanded = resolveOverlayPoint(sharedAnchor, { width: 390, height: 300 }, "centered", WIDE);
assert.equal(collapsed.left, WIDE.width - 292 - OVERLAY_VIEWPORT_MARGIN);
assert.equal(expanded.left, WIDE.width - 390 - OVERLAY_VIEWPORT_MARGIN);
assert.notEqual(collapsed.left, expanded.left, "不同实测尺寸必须得到不同钳制结果");

// 5) 高度完全是内容撑开的：视口高度变化时，同一段内容得到不同上限。
const shortViewport = { width: 1440, height: 900 };
const tallViewport = { width: 1440, height: 400 };
const contentHeight = 300;
assert.equal(
  resolveOverlayPoint({ x: 700, y: 800 }, { width: 320, height: contentHeight }, "top-left", shortViewport).top,
  shortViewport.height - contentHeight - OVERLAY_VIEWPORT_MARGIN
);
assert.equal(
  resolveOverlayPoint({ x: 700, y: 800 }, { width: 320, height: contentHeight }, "top-left", tallViewport).top,
  tallViewport.height - contentHeight - OVERLAY_VIEWPORT_MARGIN
);

// 6) top-left 不做居中：锚点即左上角。
assert.deepEqual(
  resolveOverlayPoint({ x: 200, y: 120 }, { width: 360, height: 500 }, "top-left", WIDE),
  { left: 200, top: 120 }
);

// 7) 窄视口：实测宽度等于 calc(100vw - 24px) 时恰好占满可用宽度。
const NARROW = { width: 420, height: 700 };
const narrowSize = { width: NARROW.width - 24, height: 200 };
assert.deepEqual(
  resolveOverlayPoint({ x: 300, y: 200 }, narrowSize, "centered", NARROW),
  { left: OVERLAY_VIEWPORT_MARGIN, top: 200 }
);

// 8) 弹层比视口还大：退化为贴边，绝不产生负坐标。
const oversized = clampOverlayPoint({ left: 0, top: 0 }, { width: 400, height: 300 }, { width: 200, height: 120 });
assert.deepEqual(oversized, { left: OVERLAY_VIEWPORT_MARGIN, top: OVERLAY_VIEWPORT_MARGIN });

// 9) 视口小于两倍边距时同样不产生负值。
assert.deepEqual(
  clampOverlayPoint({ left: -999, top: -999 }, { width: 10, height: 10 }, { width: 20, height: 20 }),
  { left: OVERLAY_VIEWPORT_MARGIN, top: OVERLAY_VIEWPORT_MARGIN }
);

// 10) 无锚点：退化为左上边距，而不是 0 或 NaN。
assert.deepEqual(
  resolveOverlayPoint(null, { width: 100, height: 100 }, "centered", WIDE),
  { left: OVERLAY_VIEWPORT_MARGIN, top: OVERLAY_VIEWPORT_MARGIN }
);

// 11) 幂等：钳制结果再钳制不变。不满足它，拖拽时弹层会抖。
const once = resolveOverlayPoint({ x: 1435, y: 895 }, { width: 390, height: 300 }, "centered", WIDE);
assert.deepEqual(clampOverlayPoint(once, { width: 390, height: 300 }, WIDE), once);

// 12) 锚点路径与拖拽路径共用同一套几何（否则就是第二个真相来源）。
assert.deepEqual(
  resolveOverlayPoint({ x: -50, y: -50 }, { width: 100, height: 100 }, "top-left", WIDE),
  clampOverlayPoint({ left: -50, top: -50 }, { width: 100, height: 100 }, WIDE)
);

// 13) 间距可覆盖，默认值被钉住。
assert.equal(OVERLAY_VIEWPORT_MARGIN, 12);
assert.deepEqual(
  clampOverlayPoint({ left: 0, top: 0 }, { width: 100, height: 100 }, WIDE, 40),
  { left: 40, top: 40 }
);

console.log("overlay placement: ok");
