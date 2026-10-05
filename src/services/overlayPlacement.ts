/**
 * 弹层定位与视口钳制 —— 纯几何，不碰 DOM，也**不含任何默认尺寸**。
 *
 * 为什么尺寸必须由调用方实测后传入，而不是在这里留一组「默认宽高」：
 * 被它接管的旧实现把尺寸写成常量，但那些常量没有一个能和样式对得上 ——
 *
 *   `.reading-assist-toolbar`           实际 min-width: 292px       常量写 300
 *   `.reading-assist-menu`              实际 width: min(360px, …)   常量写 372
 *   `.reading-assist-toolbar.expanded`  实际 width: min(390px, calc(100vw - 24px))
 *   `.reading-assist-*` 的高度          没有任何 CSS 来源，完全由内容撑开
 *
 * 前两条是「差了几像素」，第三条是「宽度本身就是视口的函数」，
 * 第四条是「无处可同步」。也就是说「把常量改对」在数学上做不到：
 * 不存在一个能同时匹配宽窗口与窄窗口的常数，而高度连可同步的目标都没有。
 * 因此唯一正确的尺寸来源是 DOM 实测（见 ReadingAssistMenu 的 ResizeObserver）。
 */

export interface OverlayPoint {
  left: number;
  top: number;
}

export interface OverlaySize {
  width: number;
  height: number;
}

export interface OverlayViewport {
  width: number;
  height: number;
}

/** 弹层与视口边缘至少保留的间距（px）。 */
export const OVERLAY_VIEWPORT_MARGIN = 12;

/** `centered`：贴合选区居中（内联工具条）；`top-left`：锚点即左上角（面板式弹层）。 */
export type OverlayPlacement = "centered" | "top-left";

/**
 * 把「期望位置 + 实测尺寸」钳制进视口。
 * 弹层比视口还大时退化为贴住左上边距，不产生负坐标。
 */
export function clampOverlayPoint(
  desired: OverlayPoint,
  size: OverlaySize,
  viewport: OverlayViewport,
  margin: number = OVERLAY_VIEWPORT_MARGIN
): OverlayPoint {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  return {
    left: Math.max(margin, Math.min(maxLeft, desired.left)),
    top: Math.max(margin, Math.min(maxTop, desired.top)),
  };
}

/**
 * 由选区锚点解析弹层位置。锚点为 null（尚无选区）时退化为左上边距。
 * 拖拽路径与锚点路径都必须走这里，否则会出现第二套几何。
 */
export function resolveOverlayPoint(
  anchor: { x: number; y: number } | null,
  size: OverlaySize,
  placement: OverlayPlacement,
  viewport: OverlayViewport,
  margin: number = OVERLAY_VIEWPORT_MARGIN
): OverlayPoint {
  const desired: OverlayPoint = anchor
    ? {
        left: placement === "centered" ? anchor.x - size.width / 2 : anchor.x,
        top: anchor.y,
      }
    : { left: margin, top: margin };
  return clampOverlayPoint(desired, size, viewport, margin);
}
