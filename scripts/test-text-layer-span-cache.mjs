/**
 * 文本层 span 几何缓存：滚动**不得**打废缓存，平移必须等价于重新测量
 * ---------------------------------------------------------------------------
 * ## 这一组在断言什么
 *
 * 2026-10-10 用户报「取消缩放后滚动仍然卡」。定位到 `getBoundingClientRect`
 * 在 WebKit（= Tauri 的 WKWebView 内核）上 6 秒里被调 29,000 次、合计 924ms，
 * 与同期慢帧相对 17ms 基线的超额总量（≈900ms）正好对上 —— 一条路径吃干了全部顿挫。
 *
 * 根因不在「量得贵」，而在**缓存被判据自己打废了**：旧的
 * `hasPdfTextLayerGeometryChanged` 把 `left/top`（**视口坐标**）也算进失效判据，
 * 而滚动每帧都会改 `left/top`。于是「滚动」被误判成「重排」，每次取用都要把
 * 整层 span（实测每批 225 个）重量一遍。
 *
 * 修法把这件事实拆成两个纯函数：
 *   · `hasPdfTextLayerGeometryResized` —— 只有**尺寸**变才算重排（缩放/换文档/排版）；
 *   · `shiftPdfTextSpans` —— 整层平移直接搬运缓存里的矩形。
 *
 * 这两个函数都没有 DOM 依赖，所以可以在这里精确断言。而它们的失效模式是**静默**的：
 *   · 判据写宽了（又去看 left/top）→ 不报错，只是每帧多量 225 次矩形（回到卡顿）；
 *   · 搬运写错轴或写错符号 → 不报错，只是波浪线/命中区在滚动中**整体漂移**。
 * 后者更凶险：`verify-wavy-in-browser.mjs` 用自建 harness 只测 `textLayerMarker`
 * 与 CSS，**从不滚动**，所以它一条都拦不住。
 *
 * ## 为什么是「等价于重新测量」而不是「等于某个常数」
 *
 * 消费者（命中测试、按行分组、标注区段换算）全程在视口坐标系里一致地用这批矩形。
 * 对它们而言，搬运后的结果必须与「当场重新量一遍」**逐字段相同** —— 这条性质
 * 与具体坐标无关，所以下面用随机 (dx, dy) 做多轮验证，而不是钉死几个手算值。
 */
import assert from "node:assert/strict";

/**
 * Node 里没有 `DOMRect`，而 `shiftPdfTextSpans` 会 `new DOMRect(...)`。
 * 用一个字段与浏览器一致的替身：本文件比较的是**数值**，不依赖它的任何方法。
 */
class DomRectStub {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.left = x;
    this.top = y;
    this.right = x + width;
    this.bottom = y + height;
  }
}
globalThis.DOMRect = DomRectStub;

const { hasPdfTextLayerGeometryResized, shiftPdfTextSpans } = await import(
  "../src/components/pdfReader/readerCore.ts"
);

const near = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}：得到 ${actual}，期望 ${expected}`,
  );

/** US Letter 版面（本仓夹具用的就是这个），只是为了让数字是「真实形状」的。 */
const PAGE = { width: 595, height: 842 };

// ── 一、缓存失效判据：滚动（纯平移）不得判为「需要重量」 ──────────────────
//
// 这是整轮修复的核心事实。如果这条被改回「连 left/top 一起比」，
// 表现是滚动时每帧多量 225 个矩形 —— 四道门禁会全绿，只有用户会卡。

const atScrollTop = { left: 0, top: 120, ...PAGE };
const scrolledBy = (dy) => ({ left: 0, top: 120 + dy, ...PAGE });

assert.equal(
  hasPdfTextLayerGeometryResized(atScrollTop, scrolledBy(0)),
  false,
  "滚动位移为 0 时不应需要重量",
);
assert.equal(
  hasPdfTextLayerGeometryResized(atScrollTop, scrolledBy(-37)),
  false,
  "向上滚动只是平移，不该判为需要重量（否则缓存每帧被打废）",
);
assert.equal(
  hasPdfTextLayerGeometryResized(atScrollTop, scrolledBy(4000)),
  false,
  "滚到文档深处同样只是平移，位移大小不应影响判定",
);

// 反面：真的重排必须判为需要重量，否则会拿旧几何去命中新排版 —— 比卡顿更严重。
assert.equal(
  hasPdfTextLayerGeometryResized(atScrollTop, { left: 0, top: 120, width: PAGE.width * 1.25, height: PAGE.height * 1.25 }),
  true,
  "缩放改变了文本层尺寸，必须判为需要重量",
);
assert.equal(
  hasPdfTextLayerGeometryResized(atScrollTop, { left: 0, top: 120, width: PAGE.width - 158, height: PAGE.height }),
  true,
  "侧边栏展开挤压版心会改变文本层宽度，必须判为需要重量",
);
// 子像素抖动（dpr 换算、亚像素布局）不该被当成重排 —— 否则缓存又会在滚动中每帧失效。
assert.equal(
  hasPdfTextLayerGeometryResized(atScrollTop, { left: 0, top: 120, width: PAGE.width + 0.3, height: PAGE.height - 0.2 }),
  false,
  "0.5px 以内的尺寸抖动是 dpr 换算噪声，不是重排（容差见函数注释）",
);
// 首次取用（无历史几何）必须量。
assert.equal(hasPdfTextLayerGeometryResized(null, atScrollTop), true, "没有上一帧几何时必须重量");
assert.equal(hasPdfTextLayerGeometryResized(null, scrolledBy(0)), true, "没有上一帧几何时必须重量（与位移无关）");

// ── 二、平移搬运：结果必须与「当场重新量一遍」逐字段等价 ──────────────────

const makeSpans = (count, origin = { left: 72, top: 130 }) =>
  Array.from({ length: count }, (_, i) => {
    const left = origin.left + (i % 7) * 61.5;
    const top = origin.top + Math.floor(i / 7) * 17.4;
    const width = 40 + ((i * 13) % 55);
    const height = 11 + ((i * 7) % 6);
    return {
      node: { __span: i },
      text: `fragment-${i}`,
      rect: new DomRectStub(left, top, width, height),
      centerY: top + height / 2,
    };
  });

/** 「当场重新量一遍」的参照实现：滚动后每个矩形的视口坐标就是原坐标 + 位移。 */
const remeasured = (spans, dx, dy) =>
  spans.map((span) => ({
    node: span.node,
    text: span.text,
    rect: new DomRectStub(
      span.rect.left + dx,
      span.rect.top + dy,
      span.rect.width,
      span.rect.height,
    ),
    centerY: span.centerY + dy,
  }));

const SWEEPS = [
  [0, 0],
  [0, -1],
  [0, 1],
  [0, -0.5], // 子像素滚动：dpr=2 的设备上一半的帧长这样
  [0, 482.75],
  [3, -17.4], // 横向滑动（版心外的空白拖拽）
  [-120.5, 3600.25], // 深处 + 横向，两个方向同时非零
];
const COUNTS = [1, 9, 61, 225]; // 61 / 225 是本仓实测的每批 span 数

let checks = 0;
for (const [dx, dy] of SWEEPS) {
  for (const count of COUNTS) {
    const spans = makeSpans(count);
    const frozen = remeasured(spans, 0, 0); // 搬运前的快照，用于验证「不改写输入」
    const moved = shiftPdfTextSpans(spans, dx, dy);
    const reference = remeasured(spans, dx, dy);

    assert.equal(moved.length, spans.length, `平移不得增减 span 数（dx=${dx} dy=${dy} n=${count}）`);
    for (let i = 0; i < moved.length; i += 1) {
      const got = moved[i];
      const want = reference[i];
      const where = `dx=${dx} dy=${dy} n=${count} span#${i}`;
      near(got.rect.left, want.rect.left, `${where} 左边缘`);
      near(got.rect.top, want.rect.top, `${where} 上边缘`);
      near(got.rect.width, want.rect.width, `${where} 宽度（不应随平移改变）`);
      near(got.rect.height, want.rect.height, `${where} 高度（不应随平移改变）`);
      near(got.rect.right, want.rect.right, `${where} 右边缘`);
      near(got.rect.bottom, want.rect.bottom, `${where} 下边缘`);
      near(got.centerY, want.centerY, `${where} 垂直中心（命中测试按它找行）`);
      // node 身份必须原样带过来：消费者靠它在同一个 DOM 元素上加/撤 class。
      assert.equal(got.node, spans[i].node, `${where} 必须保留原 DOM 节点引用`);
      assert.equal(got.text, spans[i].text, `${where} 必须保留文本`);
      checks += 1;
    }

    // 纯函数：不得就地改写输入。输入数组会被 `textSpanGeometryRef`/上层的
    // 上一帧几何持有，就地改写等于把「上一帧」也平移了 —— 下一帧的位移
    // 就会被算错，误差随滚动**累积**（越滚越歪，而不是一帧的偏差）。
    for (let i = 0; i < spans.length; i += 1) {
      near(spans[i].rect.left, frozen[i].rect.left, `dx=${dx} dy=${dy} n=${count} span#${i} 输入被就地改写`);
      near(spans[i].rect.top, frozen[i].rect.top, `dx=${dx} dy=${dy} n=${count} span#${i} 输入被就地改写`);
      near(spans[i].centerY, frozen[i].centerY, `dx=${dx} dy=${dy} n=${count} span#${i} 输入被就地改写`);
    }
  }
}

// 位移为 0 时必须**原样返回**（同一数组身份）：滚动每帧都会走这条路径，
// 就地新建一批 DOMRect 是纯粹的白费，而缓存的意义正是「不该做的事一件都别做」。
const identity = makeSpans(9);
assert.equal(
  shiftPdfTextSpans(identity, 0, 0),
  identity,
  "位移为 0 时应原样返回同一个数组，而不是重新分配一批矩形",
);

console.log(`text-layer-span-cache: ok（${checks} 次逐字段比对；滚动平移不重量、且与重新测量等价）`);
