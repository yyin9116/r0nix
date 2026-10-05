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
  /** 停留达标且未被否定、本页尚未提示过时回调。 */
  onFire: (block: PdfReadingBlock) => void;
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
     */
    const sample = () => {
      const rootRect = root.getBoundingClientRect();
      const viewport = { top: 0, height: root.clientHeight };

      const pageFrames: CompanionPageFrame[] = [];
      for (const [page, element] of pageRefs.current) {
        const rect = element.getBoundingClientRect();
        pageFrames.push({ page, top: rect.top - rootRect.top, height: rect.height });
      }

      const blocks: CompanionBlockFrame[] = [];
      const byId = new Map<string, PdfReadingBlock>();
      for (const [page, pageBlocks] of blocksByPageRef.current) {
        for (const block of pageBlocks) {
          // 图片块不参与：伴读提示挂在图上意义不大，而且整页的大图会
          // 凭露出面积一直压过正在读的段落（详见 pickFocusBlock 的取舍说明）。
          if (block.kind === "image") continue;
          if (!block.rect) continue;
          blocks.push({ blockId: block.id, page, rect: block.rect });
          byId.set(block.id, block);
        }
      }

      focusBlocksRef.current = byId;
      const focus = pickFocusBlock(blocks, pageFrames, viewport);
      focusRef.current = focus?.blockId ?? null;
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
      fireRef.current(block);
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
