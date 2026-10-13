import { useEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";

import {
  COMPANION_DWELL_INITIAL,
  type CompanionBlockFrame,
  type CompanionDwellState,
  type CompanionPageFrame,
  advanceDwell,
  pickFocusBlock,
  shouldHintForBlock,
} from "../../services/companionDwell";
import type { PdfReadingBlock } from "../../types";

/** 滚动停止多久后采样一次。太短会在滚动过程中反复改焦点，停留永远攒不满。 */
const SCROLL_SETTLE_MS = 120;
/** 停留计时的推进步长。250ms 足够细，又不至于每帧都跑。 */
const TICK_MS = 250;

export interface UseCompanionDwellOptions<TPageElement extends HTMLElement = HTMLElement> {
  /** 伴读总开关（settings.companionEnabled）。关闭时不注册任何监听。 */
  enabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  // 泛型：调用方的 Map 值类型是具体的 HTMLDivElement。Map 因 set() 而不变，
  // 写成 Map<number, HTMLElement> 会拒收 Map<number, HTMLDivElement>。
  pageRefs: MutableRefObject<Map<number, TPageElement>>;
  blocksByPageRef: MutableRefObject<Map<number, PdfReadingBlock[]>>;
  /** 该块是否已被用户 dismiss 过。否定集合由 App 持有，这里只查询。 */
  isDismissed: (blockId: string) => boolean;
  /** 停留达标且未被否定、本页尚未提示过时回调。
   *
   * `viewportCenterY` 是滚动容器视口中线在**页面内的归一化纵坐标**（0..1）。
   * 调用方用它把标注从整块收窄到「读者正在读的那一行」—— 传 0 会让
   * `pickFocusLine` 落到块内第一行，那不是「正在读」的那行。
   */
  onFire: (block: PdfReadingBlock, viewportCenterY: number) => void;
}

/**
 * 把「读者此刻在看哪一块、看了多久」接到真实 DOM 上。
 *
 * 判定逻辑**不在这里** —— 全在 `services/companionDwell.ts`（纯函数、有单测）。
 * 本 hook 只负责三件脏活：量 DOM、防抖、推动计时。
 *
 * 几何来源：每个页面元素都带 `data-pdf-page`，引用存在 `pageRefs` 里。
 * 所以页面在滚动容器里的偏移是**量出来的**，不是按页高累加推出来的 ——
 * 后者会被间距、缩放 transform、`content-visibility` 的占位尺寸全部带偏。
 */
/**
 * 量一次「读者此刻在看哪一块」。
 *
 * 抽成独立函数是因为它有两个调用方：
 * - 本 hook 的滚动采样；
 * - 工具栏的「伴读」按钮 —— 手动唤出气泡时也要落在读者正在看的那块上。
 * 两处各写一份几何，迟早会飘成两套「当前块」的判定。
 *
 * `viewportCenterY` 是视口中线换算到**该块所在页面**内的归一化纵坐标：
 * 采样时一起量出来，供 `onFire` 把标注收窄到读者正在读的那一行。
 */
export function sampleCompanionFocus<TPageElement extends HTMLElement = HTMLElement>(options: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pageRefs: MutableRefObject<Map<number, TPageElement>>;
  blocksByPageRef: MutableRefObject<Map<number, PdfReadingBlock[]>>;
}): { block: PdfReadingBlock; viewportCenterY: number } | null {
  const { scrollRef, pageRefs, blocksByPageRef } = options;
  const root = scrollRef.current;
  if (!root) return null;

  const rootRect = root.getBoundingClientRect();
  const viewport = { top: 0, height: root.clientHeight };
  // 视口中线在**容器**坐标系里的位置。
  const containerCenterY = viewport.top + viewport.height / 2;

  const pageFrames: CompanionPageFrame[] = [];
  for (const [page, element] of pageRefs.current) {
    const rect = element.getBoundingClientRect();
    pageFrames.push({ page, top: rect.top - rootRect.top, height: rect.height });
  }

  const blocks: CompanionBlockFrame[] = [];
  const byId = new Map<string, PdfReadingBlock>();
  for (const [page, pageBlocks] of blocksByPageRef.current) {
    for (const block of pageBlocks) {
      if (block.kind === "image") continue;
      if (!block.rect) continue;
      blocks.push({ blockId: block.id, page, rect: block.rect });
      byId.set(block.id, block);
    }
  }

  const focus = pickFocusBlock(blocks, pageFrames, viewport);
  if (!focus) return null;
  const block = byId.get(focus.blockId);
  if (!block) return null;

  // 把容器坐标换成该页的归一化纵坐标。页面高度为 0（未测量）时退回 0.5 ——
  // 视口中线对一个零高的页面没有意义，交给调用方退回整块。
  const pageFrame = pageFrames.find((frame) => frame.page === focus.page);
  const pageHeight = pageFrame?.height ?? 0;
  const pageTop = pageFrame?.top ?? 0;
  const viewportCenterY =
    pageHeight > 0 ? clampUnit((containerCenterY - pageTop) / pageHeight) : 0.5;
  return { block, viewportCenterY };
}

/** 归一化到 [0,1]；非有限值退回 0.5。 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function useCompanionDwell<TPageElement extends HTMLElement = HTMLElement>({
  enabled,
  scrollRef,
  pageRefs,
  blocksByPageRef,
  isDismissed,
  onFire,
}: UseCompanionDwellOptions<TPageElement>): void {
  const dwellRef = useRef<CompanionDwellState>(COMPANION_DWELL_INITIAL);
  const focusRef = useRef<string | null>(null);
  const focusBlocksRef = useRef<Map<string, PdfReadingBlock>>(new Map());
  /**
   * 采样时的视口中线（页面内归一化纵坐标）。
   *
   * 为什么要单独存：滚动停止后采样一次，但触发可能发生在好几拍之后
   * （读者继续读，焦点块没变）。用**触发那一刻**的采样值，
   * 标注才不会落在「刚停下来时正在读的那行」上。
   */
  const viewportCenterRef = useRef(0.5);
  const promptedPagesRef = useRef<number[]>([]);

  // 回调每次渲染都会换身份，用 ref 持有最新的，避免监听器反复解绑重绑。
  const fireRef = useRef(onFire);
  fireRef.current = onFire;
  const dismissedRef = useRef(isDismissed);
  dismissedRef.current = isDismissed;

  useEffect(() => {
    if (!enabled) {
      dwellRef.current = COMPANION_DWELL_INITIAL;
      focusRef.current = null;
      return;
    }
    const root = scrollRef.current;
    if (!root) return;

    /**
     * 采样一次：量所有页面元素的位置，算出当前焦点块。
     * 只在滚动停止后调用，所以不会在滚动过程中抖动。
     * 几何本身在 `sampleCompanionFocus`（工具栏手动唤出时复用同一份判定）。
     */
    const sample = () => {
      const focus = sampleCompanionFocus({ scrollRef, pageRefs, blocksByPageRef });
      focusRef.current = focus?.block.id ?? null;
      focusBlocksRef.current = focus ? new Map([[focus.block.id, focus.block]]) : new Map();
      if (focus) viewportCenterRef.current = focus.viewportCenterY;
    };

    const timer = window.setInterval(() => {
      const step = advanceDwell(dwellRef.current, focusRef.current, TICK_MS);
      dwellRef.current = step.state;
      if (!step.shouldFire || !focusRef.current) return;

      const block = focusBlocksRef.current.get(focusRef.current);
      if (!block) return;
      if (dismissedRef.current(block.id)) return;
      if (!shouldHintForBlock(promptedPagesRef.current, block)) return;

      promptedPagesRef.current = [...promptedPagesRef.current, block.page];
      fireRef.current(block, viewportCenterRef.current);
    }, TICK_MS);

    let settleHandle = 0;
    const onScroll = () => {
      window.clearTimeout(settleHandle);
      settleHandle = window.setTimeout(sample, SCROLL_SETTLE_MS);
    };

    root.addEventListener("scroll", onScroll, { passive: true });
    // 首次进入也要采一次：否则用户打开文档后不滚动就永远没有焦点。
    sample();

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(settleHandle);
      root.removeEventListener("scroll", onScroll);
    };
  }, [enabled, scrollRef, pageRefs, blocksByPageRef]);
}
