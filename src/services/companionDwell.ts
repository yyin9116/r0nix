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

/**
 * 块内某一行（归一化矩形 + 文本）。
 *
 * 与 `PdfReadingLine` 同构但独立声明：本模块零 value import（见文件头），
 * 声明一份最小形状才能让 `node --experimental-strip-types` 直跑它。
 */
export interface CompanionLine {
  text: string;
  rect: ReaderAnnotationRect;
}

function finiteRect(value: unknown): ReaderAnnotationRect | null {
  const rect = value as ReaderAnnotationRect | undefined;
  if (!rect) return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((component) => typeof component === "number" && Number.isFinite(component))) {
    return null;
  }
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/** 行中心落在块内（含一点容差，避免紧贴块边缘的行被判为块外）。 */
function lineCenterInsideBlock(line: ReaderAnnotationRect, block: ReaderAnnotationRect): boolean {
  const centerX = line.x + line.width / 2;
  const centerY = line.y + line.height / 2;
  return (
    centerX >= block.x &&
    centerX <= block.x + block.width &&
    centerY >= block.y &&
    centerY <= block.y + block.height
  );
}

/**
 * 从一个块里挑出「读者此刻正在读的那一行」。
 *
 * ## 为什么必须收窄到行
 *
 * 停留触发时标注用的是 `block.rect` —— 整块的并集框。而学术论文的版面里
 * 一个 block 常常横跨 5–10 个自然段，于是一条标注 = 整块每一行都被划上波浪线。
 * 2026-10-08 实测：打开一篇双栏论文，**满页全是波浪线**，与「这里可能难懂」
 * 的语义完全对不上 —— 满页都在标注等于没有标注。
 *
 * ## 判据
 *
 * 取块内**中心离视线中心最近**的那一行。视线中心用视口中线（与
 * `pickFocusBlock` 同一套「露出高度最大」的直觉一致）：读者读一行时，
 * 那一行最可能落在屏幕中段附近。
 *
 * ## 为什么不做「段落」级
 *
 * 段落边界需要靠标点缩进猜（`collectPdfParagraphSpansFromTarget` 里有那套启发式），
 * 但那是 DOM 启发式、不能测；而行级 bbox 是解析器给的，判定纯几何、可测。
 * 一行已经足够消歧 —— 「这一行有疑问」是可信的信号，「这一段有疑问」太宽。
 *
 * ## 退化路径
 *
 * 没有行级数据（老数据、markdown 来源）时返回 `null`，由调用方退回 `block.rect`。
 * 宁可用粗一点的整段，也不用猜出来的错误行。
 */
export function pickFocusLine(
  block: { rect?: ReaderAnnotationRect; lines?: CompanionLine[] },
  viewportCenterY: number
): CompanionLine | null {
  const blockRect = finiteRect(block.rect);
  if (!blockRect) return null;

  const candidates: Array<{ line: CompanionLine; rect: ReaderAnnotationRect; distance: number }> = [];
  for (const entry of block.lines || []) {
    const rect = finiteRect(entry?.rect);
    if (!rect) continue;
    // 兜住「并集框算错」的情况：中心不在块内的行不参与候选。
    if (!lineCenterInsideBlock(rect, blockRect)) continue;
    const centerY = rect.y + rect.height / 2;
    candidates.push({ line: { text: entry.text || "", rect }, rect, distance: Math.abs(centerY - viewportCenterY) });
  }
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    // 距离相同时取更靠上的（先读到的行），保证结果确定、不依赖入参顺序。
    if (
      candidate.distance < best.distance ||
      (candidate.distance === best.distance && candidate.rect.y < best.rect.y)
    ) {
      best = candidate;
    }
  }
  return best.line;
}

/**
 * 这块是否属于「不该被伴读」的版面区域：页眉、页脚、页码、标题、图表说明。
 *
 * ## 为什么必须做
 *
 * 伴读是**主动**功能：它自己决定「这里读者可能卡住了」。
 * 一旦把页眉（论文标题 + 作者 + arXiv 水印）或页码也当成正文候选，
 * 读者刚打开文档就看到首页页眉上挂着提示 —— 而那一行他百分之百没在读。
 * 这类误报比漏报伤害大得多：读者会直接认定「这个功能吵」，然后整体关掉。
 *
 * ## 为什么只能用启发式
 *
 * `PdfReadingBlock` 没有字号字段（types.ts 的定义里只有 `lines[].rect.height`
 * 可作高度代理），`kind` 里的 `auxiliary` 只有 MinerU 路径会产出，
 * 而 PyMuPDF 路径恒定写 `kind: "text"`（py_render.rs:830）。
 * 所以判据只能建立在**位置**与**文本形态**上。
 *
 * ## 各判据的依据
 *
 * 1. `kind` 白名单直接拒：`image` / `table` / `equation` / `code` / `auxiliary`
 *    本来就不该被「读不懂」这个理由标注 —— 图看的是图，公式卡住的是公式，
 *    而 `auxiliary` 正是 MinerU 对页眉页脚的显式标记。
 * 2. 页眉带：纵向位置落在顶部条带内。
 * 3. 页脚带：落在底部条带内。页码（纯数字/罗马数字）无论在哪都拒。
 * 4. 孤立短行：不在版心宽度内的单行，且长度很短 —— 典型的残留水印与版权行。
 * 5. 标题：`depth` 是标题层级（MinerU 的 `text_level`，**从 1 起**），非 0 即标题。
 *
 *    ⚠️ 这里原先写的是 `depth > 0 && depth < 1` —— 一个**恒假的死条件**，
 *    永远不成立，看着像在判断标题，实则一条都没拦住。是行为断言
 *    （`depth: 1` 必须被拒）把它抓出来的，不是代码审查。
 *
 * 阈值都取**保守值**：宁可漏判（少提示一次）也不误判（提示页眉）。
 * 这是主动功能的不对称代价 —— 见函数开头。
 */
export function isNonProseRegion(block: {
  kind?: string;
  rect?: ReaderAnnotationRect;
  text?: string;
  depth?: number;
}): boolean {
  // 1) 类型白名单。`code`/`equation` 排除的理由稍特殊：它们的「难懂」是真的，
  //    但伴读的提示形态（"这句为什么这么说"）对它们不成立 —— 那不是句子。
  if (NON_PROSE_KINDS.has(block.kind ?? "text")) return true;
  // 非 0 即标题（text_level 从 1 起）；undefined / 0 都是正文。
  if (typeof block.depth === "number" && block.depth !== 0) return true;

  const rect = finiteRect(block.rect);
  if (!rect) return true;
  const text = (block.text ?? "").trim();
  if (!text) return true;

  // 2) 纯页码：出现在任何位置都拒。它出现在页脚带内已被下一条覆盖，
  //    但页码偶尔被排在版心中央（模板问题），所以单列一条。
  if (PAGE_NUMBER_ONLY.test(text)) return true;

  // 3) 顶部/底部条带。A4 版心通常从 8% 起、到 92% 止；
  //    0.07 / 0.93 留了一点余量，避免把紧贴版心的首行误判成页眉。
  const centerY = rect.y + rect.height / 2;
  if (centerY <= PAGE_HEADER_BAND) return true;
  if (centerY >= PAGE_FOOTER_BAND) return true;

  // 4) 孤立短行：横跨不足版心六成、且长度短。论文页眉的 arXiv 水印行、
  //    版权声明、"Preprint" 之类都长这样 —— 它们窄且短。
  //    正文引用块也窄，但通常有 3 行以上；这里只看单行，靠 lines 辅助判断。
  if (rect.width < 0.6 && rect.height < 0.02 && text.length < 60) return true;

  return false;
}

/** 这些块型不参与「读不懂」判定。 */
const NON_PROSE_KINDS = new Set([
  "image",
  "table",
  "equation",
  "code",
  "auxiliary",
  "list",
]);

/** 顶部条带：中心 y 在此以内视为页眉。 */
const PAGE_HEADER_BAND = 0.07;
/** 底部条带：中心 y 在此以外视为页脚。 */
const PAGE_FOOTER_BAND = 0.93;
/** 纯页码：数字、罗马数字，或 "Page 12 of 30" 这类。 */
const PAGE_NUMBER_ONLY = /^(?:[\d\s.,-]{1,12}|[ivxlcdm\s]{1,12}|page\s+\d+(?:\s*(?:\/|of)\s*\d+)?)$/i;
