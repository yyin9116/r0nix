/**
 * 伴读的「停留采集」纯逻辑层。
 *
 * 为什么单独成文件、且必须是纯的：
 * - 采集端要接在 `PDFViewer` 里，那文件 import 了一堆 Tauri / PDF.js 的东西，
 *   node 加载不了；写在里面就只能靠字符串断言，而「焦点块切换要不要重新计时」
 *   恰恰是需要行为断言的判定。
 * - 本模块零本地 value import（只 import type），可被
 *   `node --experimental-strip-types` 直跑，所以能真的被测。
 *
 * 与 `readingCompanion.ts` 的分工：那边管「否定集合 + 密度档位」，
 * 这边管「此刻读者在看哪一块、看了多久」。
 */

import type { ReaderAnnotationRect } from "../types.ts";

/** 停留多久算「在看这一块」。施工单 §5 定为 2.5s。 */
export const COMPANION_DWELL_THRESHOLD_MS = 2500;

/** 块至少露出多少比例才算「可见」。低于此值视为还没读到。 */
export const COMPANION_MIN_VISIBLE_FRACTION = 0.6;

export interface CompanionBlockFrame {
  blockId: string;
  page: number;
  /** 归一化矩形（0..1，相对页面），缺失则视为不可见。 */
  rect?: ReaderAnnotationRect;
}

export interface CompanionPageFrame {
  page: number;
  /** 页面元素相对「容器视口」的上边缘，px。滚动时变负。 */
  top: number;
  height: number;
}

export interface CompanionViewport {
  /** 容器视口上边缘，通常为 0。 */
  top: number;
  height: number;
}

export interface CompanionVisibleBlock {
  blockId: string;
  page: number;
  /** 块相对容器视口的上边缘，px。 */
  top: number;
  height: number;
  /** 可见高度占块自身高度的比例，0..1。 */
  visibleFraction: number;
  /** 实际露出的高度，px = visibleFraction * height。焦点排序以此为据。 */
  visibleHeight: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 算单个块在容器视口里的可见情况。
 *
 * 输入全部当作不可信：块 rect 可能缺失、可能是 NaN、可能越界（早期 mineru
 * 结果就出过负数）。这里一律归一成「不可见」，绝不抛错 —— 采集端跑在滚动回调上，
 * 抛一个错会打断整个阅读器的滚动链。
 */
export function measureBlockVisibility(
  block: CompanionBlockFrame,
  pageFrame: CompanionPageFrame | undefined,
  viewport: CompanionViewport
): CompanionVisibleBlock {
  const viewportTop = finiteOr(viewport.top, 0);
  const viewportHeight = finiteOr(viewport.height, 0);
  const pageTop = finiteOr(pageFrame?.top, Number.NaN);
  const pageHeight = finiteOr(pageFrame?.height, Number.NaN);

  const rect = block.rect;
  const blockTop = pageTop + finiteOr(rect?.y, Number.NaN) * pageHeight;
  const blockHeight = finiteOr(rect?.height, Number.NaN) * pageHeight;

  // 任一环节非有限 ⇒ 不可见。乘 NaN 会污染，所以先判再算。
  if (!Number.isFinite(blockTop) || !Number.isFinite(blockHeight) || blockHeight <= 0) {
    return {
      blockId: block.blockId,
      page: block.page,
      top: Number.NaN,
      height: 0,
      visibleFraction: 0,
      visibleHeight: 0,
    };
  }

  const visibleTop = Math.max(blockTop, viewportTop);
  const visibleBottom = Math.min(blockTop + blockHeight, viewportTop + viewportHeight);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);

  return {
    blockId: block.blockId,
    page: block.page,
    top: blockTop,
    height: blockHeight,
    visibleFraction: visibleHeight / blockHeight,
    visibleHeight,
  };
}

/**
 * 取当前「焦点块」：可见比例达标者里，露出高度（px）最大的那个。
 *
 * 为什么用「露出高度」而不是「露出比例」或「最靠上」：
 * - 用比例会让一个只露出 3 行的小段落压过露出半页的大段落；
 * - 用最靠上会让刚滚过去、只剩一角的块一直占着焦点，触发永远轮不到正文。
 * 露出高度是「占屏面积」的稳定代理，且随滚动单调变化，抖动最小。
 *
 * 已知取舍：整页的大图块会赢过正在读的段落。调用方应按 kind 过滤掉
 * image 块（伴读提示挂在图片上意义不大），本模块保持通用不做这个判断。
 */
export function pickFocusBlock(
  blocks: CompanionBlockFrame[],
  pageFrames: CompanionPageFrame[],
  viewport: CompanionViewport,
  minVisibleFraction: number = COMPANION_MIN_VISIBLE_FRACTION
): CompanionVisibleBlock | undefined {
  const framesByPage = new Map<number, CompanionPageFrame>();
  for (const frame of pageFrames) framesByPage.set(frame.page, frame);

  let best: CompanionVisibleBlock | undefined;
  for (const block of blocks) {
    const measured = measureBlockVisibility(block, framesByPage.get(block.page), viewport);
    if (measured.visibleFraction < minVisibleFraction) continue;
    if (measured.height <= 0) continue;
    if (!best) {
      best = measured;
      continue;
    }
    // ⚠️ 比较的是 **露出高度**（visibleHeight），不是块自身高度（height）。
    // 用后者会让一个很高但只露出一角的大图块，压过正在读的小段落。
    // 露出高度相同时取更靠上的（页号小、再 y 小），让结果完全确定而非依赖入参顺序。
    if (measured.visibleHeight > best.visibleHeight) best = measured;
    else if (measured.visibleHeight === best.visibleHeight) {
      if (measured.page < best.page || (measured.page === best.page && measured.top < best.top)) {
        best = measured;
      }
    }
  }
  return best;
}

export interface CompanionDwellState {
  /** 当前焦点块；null 表示没有。 */
  blockId: string | null;
  /** 该块已连续停留的时长，ms。 */
  elapsedMs: number;
  /** 该块是否已经触发过。每块只触发一次，避免滚动抖动导致重复弹。 */
  fired: boolean;
}

export const COMPANION_DWELL_INITIAL: CompanionDwellState = {
  blockId: null,
  elapsedMs: 0,
  fired: false,
};

export interface CompanionDwellStep {
  state: CompanionDwellState;
  /** 本次推进是否应当触发提示。 */
  shouldFire: boolean;
}

/**
 * 推进停留状态机。
 *
 * 三条规则，每条都有对应的回归风险：
 * 1. 没有焦点块 ⇒ 归零。否则移出正文后残留的 elapsed 会让下次进来立刻触发。
 * 2. 焦点块换了 ⇒ 重新计时。**不继承**上一个块的时长，也不把本次 delta 算给新块
 *    （新块是刚被观测到的，时长应从 0 起算；继承会造成「滚一下就弹」）。
 * 3. 同一块累计到阈值且未触发过 ⇒ 触发一次，之后不再重复。
 */
export function advanceDwell(
  state: CompanionDwellState,
  focusBlockId: string | null,
  deltaMs: number,
  thresholdMs: number = COMPANION_DWELL_THRESHOLD_MS
): CompanionDwellStep {
  const safeDelta = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;

  if (!focusBlockId) {
    return { state: COMPANION_DWELL_INITIAL, shouldFire: false };
  }
  if (focusBlockId !== state.blockId) {
    return { state: { blockId: focusBlockId, elapsedMs: 0, fired: false }, shouldFire: false };
  }
  if (state.fired) {
    return { state, shouldFire: false };
  }

  const elapsedMs = state.elapsedMs + safeDelta;
  const shouldFire = elapsedMs >= thresholdMs;
  return {
    state: { blockId: focusBlockId, elapsedMs, fired: shouldFire },
    shouldFire,
  };
}

/**
 * 把提示限制在「每页最多 1 条」：同页已有提示时不再为另一块触发。
 *
 * 施工单 §5 的约束。放在这里是因为它是纯判定（给定已提示页集合 + 候选块），
 * 而不是 UI 状态；放在组件里就只能靠肉眼看。
 */
export function shouldHintForBlock(promptedPages: number[], block: { page: number }): boolean {
  return !promptedPages.includes(block.page);
}
