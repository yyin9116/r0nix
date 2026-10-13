/**
 * PDF 缩放手势 → 缩放目标。
 *
 * ## 为什么这一层还存在（手写识别被库接管之后）
 *
 * 2026-10-08 之前这里是**全套手写识别**：自己判断 ctrlKey/metaKey 是不是捏合、
 * 自己算 deltaMode 换算、自己用 `exp(-k·deltaY)` 累积倍率、自己挂 non-passive
 * wheel 监听。这套东西的正确性依赖三件很容易悄悄坏掉的事：
 *
 * 1. **识别**：WebKit / Chromium 把触控板捏合合成为 `wheel + ctrlKey`，
 *    但 Cmd+滚轮、deltaMode=1（Firefox 的「行」）都要单独处理；
 * 2. **语义**：捏合是**连续位移**（一次手势几十个事件），滚轮是**离散步进**
 *    （一格一次）—— 两者共用一套参数就会出事；
 * 3. **生命周期**：React 17+ 把 wheel 注册为 passive，在合成事件里
 *    `preventDefault()` 会被浏览器忽略，WKWebView 于是顺手做一次原生页面放大。
 *
 * 这三件事现在由 `@use-gesture/react` 负责（见 PDFViewer 的 `useGesture` 调用）：
 * 它把 wheel/pinch 统一到一个引擎里，自己处理 modifierKey、deltaMode、
 * non-passive 绑定与捏合的累积。这些是**通用输入问题**，不该由一个 PDF
 * 阅读器自己重写一遍。
 *
 * 那么剩下的是什么？**产品决策**，也就是本模块的全部内容：
 * - 捏合该多灵敏（库的默认常数不是为屏幕阅读定的）；
 * - 滚轮一格该走多少（离散步进，且要夹住）；
 * - 库给的**累积量**该怎么换算成「本次手势的相对量」
 *   （这一条不是可选的润色，而是正确性的前提，见 `pinchZoomFactor`）。
 *
 * 这些与输入设备无关，因此**留在纯函数层、继续被行为断言覆盖** ——
 * 库换了、手写识别删了，但「捏合必须等比、滚轮必须离散步进、捏合不跨手势累积」
 * 这三条不变量仍被钉住。
 */

/**
 * 每像素 deltaY 对应的指数系数（滚轮步进用）。
 *
 * 保留手写实现里的实测标定值：手感是在 WKWebView 上量出来的
 * （|deltaY| 几十、一步 7%~24%），换库不等于换手感。
 */
export const WHEEL_ZOOM_SENSITIVITY = 0.14;

/** 滚轮一步的最小百分点。低于它读者会觉得「滚了没反应」。 */
export const WHEEL_ZOOM_MIN_STEP = 7;

/** 滚轮一步的最大百分点。单步跨太多会让精调变得不可能。 */
export const WHEEL_ZOOM_MAX_STEP = 24;

/**
 * 捏合的识别特征：**这里不再自己判断**。
 *
 * 旧实现在这里用 `ctrlKey || metaKey` 判捏合，现在那份判断在库里
 * （`useGesture` 的 `pinch.modifierKey`）。保留这个导出只有一个用途：
 * 让滚轮分支能问「这个事件是不是已经被库当成捏合处理了」——
 * 因为库的 pinch 引擎与 wheel 引擎是**两个独立引擎**，都监听同一批 wheel 事件，
 * 不挡掉的话一次捏合会同时走两条路径，缩放翻倍。
 *
 * 判据与库保持一致（ctrlKey / metaKey），改这里必须同步改 `useGesture` 的
 * `pinch.modifierKey`，否则两条路径的边界就错开了。
 */
export function isPinchGesture(event: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return event.ctrlKey === true || event.metaKey === true;
}

/**
 * 库的捏合累积常数（`PinchEngine` 内部的 `PINCH_WHEEL_RATIO`）。
 *
 * 库的捏合公式是 `_delta = -deltaY / 100 × offset`，也就是它把每个事件的
 * deltaY **除以 100** 再累乘。这个常量没有导出，只能在这里复刻一份。
 *
 * ⚠️ 它是**库内部实现细节**，不是公开契约 —— 运行时读不到，改了也不会有任何
 * 报错。本模块因此只把它用在**推导**上（见 `PINCH_ZOOM_SMALL_AMPLITUDE_GAIN`），
 * 而把真正决定手感的 `PINCH_ZOOM_GAIN` 写成绝对数字：库若改了常数，
 * 后果是手感变化（可接受、可回调），而不是行为错乱。
 *
 * 它必须留在代码里而不是只写在注释里：`scripts/test-pdf-zoom-gesture.mjs`
 * 断言它等于 100，复刻时打错一位（100 → 1000）会立刻被抓住。
 */
export const LIB_PINCH_WHEEL_RATIO = 100;

/**
 * 手写时代的捏合灵敏度：每像素 deltaY 的指数系数。
 *
 * ★ 按实测标定（2026-10-05，macOS 触控板 + Tauri/WKWebView）：
 *   单次 |deltaY| 3.1~14.3，一个 500ms 窗口内 13~15 个事件
 *   ⇒ 单窗口累积量约 75~114。
 *   手写实现取 0.003 ⇒ 单窗口倍率 exp(0.003 × 75~114) ≈ 1.25~1.41，
 *   也就是「捏一下」页面放大约三到四成 —— 跟手，且不至于一次翻倍。
 *
 * 这个值保留下来不是为了继续用它算倍率（那已经交给库了），
 * 而是为了在 `PINCH_ZOOM_GAIN` 里换算出等价手感。
 */
export const PINCH_ZOOM_K = 0.003;

/**
 * 小幅度下与手写版**完全等价**的增益。
 *
 * 小幅度时 `r ≈ 1 + Σ(0.01 × 捏合量)`，于是 `r^g ≈ exp(g × 0.01 × Σ)`；
 * 要等于手写版的 `exp(0.003 × Σ)`，取 `g = 0.003 × 100`。
 *
 * 它是推导的中间量，本身不参与计算 —— 但写出来是为了让
 * 「`PINCH_ZOOM_GAIN` 为什么是 0.4 而不是 0.3」这句话可被断言核对。
 */
export const PINCH_ZOOM_SMALL_AMPLITUDE_GAIN = PINCH_ZOOM_K * LIB_PINCH_WHEEL_RATIO;

/**
 * 捏合灵敏度 → 对库累积倍率的指数。
 *
 * ## 为什么从 0.3 抬到 0.4
 *
 * 库给的是**线性累积**：`offset = lastOffset × (1 + Σ(0.01 × 捏合量))`，
 * 记 `r = offset / lastOffset`，一次典型捏合（累积 75~114px）得到
 * `r ≈ 1.75~2.14`。而手写版要的是 `exp(0.003 × 75~114) ≈ 1.25~1.41`。
 *
 * 小幅度时 `PINCH_ZOOM_SMALL_AMPLITUDE_GAIN`（0.3）刚好等价；但幅度一大，
 * 线性累积会超过指数（`1 + x` 在 x>0 时大于 `e^{x/2}`量级上的直觉值），
 * 同样的捏合幅度会放大得更多。所以把增益抬到 **0.4** 把这段拉回来：
 *
 *   Σ=75  → r=1.75 → 1.75^0.4 = 1.251
 *   Σ=114 → r=2.14 → 2.14^0.4 = 1.356
 *
 * 正好落回标定区间 1.25~1.41，「捏一下放大三到四成」这个手感不变。
 * 两条端点都由 `scripts/test-pdf-zoom-gesture.mjs` 钉住。
 */
export const PINCH_ZOOM_GAIN = 0.4;

/**
 * 库累积倍率 → 本次手势的 zoom **倍率**（不是增量）。
 *
 * ## ⚠️ 为什么必须除掉 `gestureStart`
 *
 * `offset[0]` **不是**「本次手势捏了多少」。库的 `PinchEngine` 里
 * `offset` 由 `init()` 设成 `[1, 0]`，而 `reset()` **不重置 offset** ——
 * 于是一次手势结束时它是 1.75，下一次手势 `start()` 时
 * `lastOffset = state.offset = 1.75`，新的 `offset` 从 1.75 继续往上累。
 *
 * 直接把它乘到 zoom 上，第二次捏合会先凭空放大 1.75 倍 —— 表现为
 * 「捏一下就炸开」，而且第二次比第一次夸张得多。
 *
 * `offset / lastOffset` 才是本次手势的相对量：库正是用它
 * （经 `movement = offset - lastOffset`）来累积手势内位移的。
 *
 * ## 为什么用幂而不是指数
 *
 * `r^gain` 而非 `exp(gain × ln r)` —— 两者数学上完全等价（`a^b = e^{b·ln a}`），
 * 写幂是因为它对入参的量纲不敏感：无论将来库把 `PINCH_WHEEL_RATIO`
 * 调大还是调小，同一段代码读起来都是「把库的倍率压到我要的手感」，
 * 而 `exp(k × ΣdeltaY)` 那套写法会把库的内部常数泄漏进产品参数。
 *
 * 用指数（等比）而不是加法还有一个理由：缩放必须等比。
 * 从 100% 捏到 150% 与从 200% 捏到 300%，手指开合幅度理应一致；
 * 加法做不到（高倍率下会越捏越钝）。
 */
export function pinchZoomFactor(gestureOffset: number, gestureStartOffset: number): number {
  if (!Number.isFinite(gestureOffset) || !Number.isFinite(gestureStartOffset)) return 1;
  // 库可能给出 0 或负数（一次极大的反向 deltaY），此时不做任何缩放。
  if (gestureOffset <= 0 || gestureStartOffset <= 0) return 1;
  const ratio = gestureOffset / gestureStartOffset;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.pow(ratio, PINCH_ZOOM_GAIN);
}

/**
 * 一次滚轮事件 → zoom **增量**（百分点）。
 *
 * ## 入参必须是「单事件位移」，不是手势累积量
 *
 * 库的 `WheelEngine` 是坐标引擎：`offset = lastOffset + movement`，
 * 而 `movement` 来自 `_movement` 的**累加**。wheel 手势要到 140ms 没有新事件
 * 才结束 —— 也就是说连续滚动期间，`movement[1]` 是这一串滚动的**总位移**。
 *
 * 拿它当单事件步进会怎样？第一个事件 movement=3 → +7%（MIN_STEP 兜底），
 * 第二个 movement=6 → +7%，第三个 movement=9 → +9%……
 * 越滚越快，且停下后手感与刚起步时完全不同。单事件位移是 `delta[1]`
 * （本次 offset 与上次 offset 之差），PDFViewer 传的是它。
 *
 * ## 为什么与捏合彻底分开
 * 滚轮是离散的「滚了一格」，每次都是新的一步，用增量；
 * 捏合是连续位移，用倍率。共用一套参数的后果在
 * `scripts/test-pdf-zoom-gesture.mjs` 里有实证 —— 拿滚轮公式处理捏合，
 * 每个事件都被 MIN_STEP 兜底成 +7%，一次手势直接翻倍。
 */
export function wheelZoomStep(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const magnitude = Math.max(
    WHEEL_ZOOM_MIN_STEP,
    Math.min(WHEEL_ZOOM_MAX_STEP, Math.abs(deltaY) * WHEEL_ZOOM_SENSITIVITY)
  );
  return deltaY < 0 ? magnitude : -magnitude;
}