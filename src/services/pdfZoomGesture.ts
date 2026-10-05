/**
 * 触控板捏合 → PDF 缩放倍率。
 *
 * 纯函数：不碰 DOM、不读时钟、不 import 任何本地 value，
 * 可被 `node --experimental-strip-types` 直接加载做行为断言。
 *
 * 为什么捏合不能复用滚轮那组参数（WHEEL_ZOOM_SENSITIVITY / WHEEL_ZOOM_MIN_STEP）：
 * 实测 macOS + WKWebView 下捏合的 |deltaY| 只有 3~14，而滚轮是几十上百。
 * 拿滚轮公式套捏合，每个事件都会被 MIN_STEP 兜底成 +7%，
 * 而一个 500ms 窗口里有 13~15 个事件 ⇒ 一次捏合缩放翻倍。
 * 这不是调参没调好，是两种输入的语义不同：
 *   滚轮 = 离散的「滚了一格」，每次都是新的一步，用增量；
 *   捏合 = 连续的位移，一次手势派发几十个事件，必须按累积量理解，用倍率。
 */

/**
 * 捏合的识别特征：WebKit 与 Chromium 都把触控板捏合合成为 wheel + ctrlKey。
 * metaKey 一并接受 —— 部分环境下 Cmd+滚轮也走这条路径，语义同样是缩放而非滚动。
 */
export function isPinchGesture(event: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return event.ctrlKey === true || event.metaKey === true;
}

/** deltaMode=1（行）与 2（页）折算成像素的近似值。 */
export const WHEEL_LINE_HEIGHT_PX = 16;
export const WHEEL_PAGE_HEIGHT_PX = 800;

/**
 * 把 deltaY 归一到像素。
 * 三种单位：0=像素、1=行、2=页。Firefox 常用「行」，量级差约 16 倍，
 * 不归一的话同一个手势在 Firefox 上会慢 16 倍。
 * 「页」依赖视口高度，这里只能取一个近似常数 —— 它至今没有被触发过
 * （实测 deltaMode 恒为 0），取 800 只为不静默退化成 1。
 */
export function normalizeWheelDeltaY(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === 2) return deltaY * WHEEL_PAGE_HEIGHT_PX;
  return deltaY;
}

/**
 * 每像素 deltaY 对应的指数系数。
 *
 * ★ 按实测标定（2026-10-05，macOS 触控板 + Tauri/WKWebView）：
 *   单次 |deltaY| 3.1~14.3，deltaMode 恒为 0，一个 500ms 窗口内 13~15 个事件
 *   ⇒ 单窗口累积量约 75~114。
 *   取 0.003 ⇒ 单窗口倍率 exp(0.003 × 75~114) ≈ 1.25~1.41，
 *   也就是「捏一下」页面放大约三到四成 —— 跟手，且不至于一次翻倍。
 *   换平台（Firefox 的 deltaMode=1）必须用新的实测重标，不要照抄。
 */
export const PINCH_ZOOM_K = 0.003;

/**
 * 一次捏合事件 → zoom **倍率**（不是增量）。
 *
 * 用指数而不是加法：缩放是等比的。从 100% 捏到 150% 与从 200% 捏到 300%，
 * 手指的开合幅度理应一致；加法做不到这点（高倍率下会越捏越钝）。
 *
 * 方向约定：捏开（手指分开，要放大）在 WebKit/Chromium 上产生 **deltaY < 0**，
 * 与「滚轮上滚 = 放大」一致，所以这里取负号。
 * ★ 这一条是实测要验的第一件事：如果捏开反而缩小，把符号反过来即可，
 *   不要去动 PINCH_ZOOM_K —— 那是量级，方向错了改量级只会更糊涂。
 */
export function pinchZoomFactor(deltaY: number, deltaMode = 0): number {
  return Math.exp(-PINCH_ZOOM_K * normalizeWheelDeltaY(deltaY, deltaMode));
}
