import { readVersionedLocalState, writeVersionedLocalState } from "./localStore.ts";
import type { ReaderAnnotation } from "../types";

/**
 * 伴读 Agent 的本地状态：否定集合 + 密度推导。
 *
 * ⚠️ 本模块是「永不上传」这条决定在代码里唯一可机械验证的落点，三条硬约束：
 *
 * 1. **不得出现任何网络调用**（Tauri invoke、fetch、XHR 一律禁止）。
 *    `scripts/check-reading-assist-contract.mjs` 用源码文本匹配守住这条 —— 这是
 *    「行为信号只在本机」唯一能被自动化验证的代理。连注释里都不要写带括号的调用形式，
 *    否则会把守卫自己误伤成红灯。
 * 2. **`deriveIntensity` 必须是纯函数**：无 Date.now、无 Math.random、无 IO。
 *    这不是洁癖 —— 含随机源的函数无法写单测，而它决定了用户看到多少主动提示。
 * 3. **`CompanionDwellSample` 不落盘**。停留时长可反推「用户在哪一页卡住」，
 *    是这套功能里最敏感的数据；落盘的只有（a）原子计数、（b）否定集合。
 *
 * 另外一个实现细节：这里的相对 import 带了显式 `.ts` 扩展名（本仓第二个例外，
 * 与 `services/readerAnnotations.ts` 同源）。原因同样是 `node --experimental-strip-types`
 * 对相对 import 要求显式扩展名，不带就 ERR_MODULE_NOT_FOUND，
 * `npm run test:fixtures` 会红而 `tsc` 全绿。删掉扩展名 = 让本模块退化成弱证据。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 否定集合（§3.5）
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANION_DISMISSED_KEY = "r0nix_reading_companion_dismissed";
export const COMPANION_DISMISSED_STATE_VERSION = 1;

/** 形状：`Record<documentId, blockId[]>`。值为被 dismiss 过的块 id。 */
export type CompanionDismissedBlocks = Record<string, string[]>;

/**
 * 消毒任意来源的否定集合：只保留「字符串 → 非空字符串数组」这种形状，
 * 并对每个文档去重。去重要紧 —— 否定集合只增不减，不去重会随 dismiss 次数线性膨胀。
 */
export function sanitizeDismissedBlocks(raw: unknown): CompanionDismissedBlocks {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const next: CompanionDismissedBlocks = {};
  for (const [documentId, value] of Object.entries(parsed)) {
    if (typeof documentId !== "string" || !documentId) continue;
    if (!Array.isArray(value)) continue;
    const blockIds = value.filter((item): item is string => typeof item === "string" && Boolean(item));
    if (blockIds.length === 0) continue;
    next[documentId] = [...new Set(blockIds)];
  }
  return next;
}

export function loadDismissedBlocks(): CompanionDismissedBlocks {
  return readVersionedLocalState(
    COMPANION_DISMISSED_KEY,
    COMPANION_DISMISSED_STATE_VERSION,
    {},
    sanitizeDismissedBlocks
  );
}

export function saveDismissedBlocks(next: CompanionDismissedBlocks): void {
  writeVersionedLocalState(COMPANION_DISMISSED_KEY, COMPANION_DISMISSED_STATE_VERSION, next);
}

export function isBlockDismissed(
  dismissed: CompanionDismissedBlocks,
  documentId: string,
  blockId: string
): boolean {
  if (!documentId || !blockId) return false;
  return Boolean(dismissed[documentId]?.includes(blockId));
}

/**
 * 把一个块加入否定集合，返回**新表**（不改入参）并落盘。
 *
 * 幂等：重复 dismiss 同一个块不会产生重复条目。这点是刻意的 ——
 * React 严格模式下 setState 的 updater 会被调用两次，非幂等的写入会把副作用放大。
 *
 * 进入集合的块**永不再生成候选提示**，即使模型认为它很重要。
 */
export function dismissCompanionBlock(
  dismissed: CompanionDismissedBlocks,
  documentId: string,
  blockId: string
): CompanionDismissedBlocks {
  if (!documentId || !blockId) return dismissed;
  const existing = dismissed[documentId] || [];
  if (existing.includes(blockId)) return dismissed;
  const next: CompanionDismissedBlocks = { ...dismissed, [documentId]: [...existing, blockId] };
  saveDismissedBlocks(next);
  return next;
}

/**
 * 「删掉一条批注」时，该不该把它的块写进否定集合、写哪一个 —— 这个判定单独抽出来，
 * 就是为了让它能被**行为断言**覆盖。
 *
 * 为什么不直接在组件里写：组件里的判定只能靠「源码里出现了某个函数名」这种字符串
 * 守卫兜住，而那种守卫连 `if (false && …)` 都抓不到（实测过：把调用包进永假条件后
 * 守卫照样绿）。决策放这里，行为由 `scripts/test-reading-companion.mjs` 钉死。
 *
 * 返回 `undefined` 表示不该进否定集合，原因有三：
 * - 删的是人工标注 —— 「我删了自己画的一条线」不等于「我不想看到这里的提示」；
 * - 老数据没有 `origin` —— 一律视为 manual（见 types.ts 的字段注释）；
 * - 标注没有 `blockId` —— 无从定位，此时不能把整页都否定掉。
 */
export function dismissalForRemovedAnnotation(
  annotations: readonly ReaderAnnotation[],
  annotationId: string
): string | undefined {
  const target = annotations.find((annotation) => annotation.id === annotationId);
  if (!target || target.origin !== "ai") return undefined;
  return target.blockId || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 密度档位（§3.4 / §7）
// ─────────────────────────────────────────────────────────────────────────────

export type CompanionIntensity = "off" | "light" | "medium" | "heavy";

/** 档位的全序。用于单测里的单调性断言，也用于 UI 的档位选择器。 */
export const COMPANION_INTENSITIES: readonly CompanionIntensity[] = ["off", "light", "medium", "heavy"];

/** 原子计数。只累计，不上传。 */
export interface CompanionLearningStats {
  /** 划词次数。 */
  selections: number;
  /** 批注条数。 */
  annotations: number;
  /** 气泡内追问次数。 */
  followUps: number;
  /** 读过的文档数。 */
  documents: number;
}

/**
 * 一次「读者在某块上停留」的观测。**易失，只进内存，绝不落盘**（见文件头第 3 条）。
 */
export interface CompanionDwellSample {
  documentId: string;
  page: number;
  blockId: string;
  /** 该块连续可见的毫秒数。 */
  visibleMs: number;
  /** 同一次阅读会话内该块被回看的次数。 */
  revisits: number;
}

export const DEFAULT_COMPANION_STATS: CompanionLearningStats = {
  selections: 0,
  annotations: 0,
  followUps: 0,
  documents: 0,
};

/**
 * 各信号对「读者想要多少主动提示」的贡献权重。
 *
 * 取值理由（不是实验结论，是设计判断，见 `design-system.md` §11.7）：
 * - `followUps` 最重 —— 愿意在气泡里追问，是最强的「我想要这个」信号；
 * - `selections` 次之 —— 划词是主动求助，但也可能只是想复制；
 * - `annotations` 与 `documents` 最轻 —— 它们说明参与度和熟练度，不直接表达想要提示。
 *
 * 权重全为正，这是 `deriveIntensity` 单调性的来源。
 */
const INTENSITY_WEIGHTS: Record<keyof CompanionLearningStats, number> = {
  selections: 2,
  annotations: 1,
  followUps: 3,
  documents: 1,
};

/** 进入各档位所需的分数下界。`off` 恒为 0，不在此表中。 */
const INTENSITY_THRESHOLDS = { light: 1, medium: 8, heavy: 24 } as const;

/** 把一组计数折算成一个可比较的标量。负数与非有限值按 0 处理。 */
export function companionSignalScore(stats: CompanionLearningStats): number {
  let score = 0;
  for (const key of Object.keys(INTENSITY_WEIGHTS) as Array<keyof CompanionLearningStats>) {
    const value = Number.isFinite(stats[key]) ? Math.max(0, stats[key]) : 0;
    score += value * INTENSITY_WEIGHTS[key];
  }
  return score;
}

/**
 * 纯函数：统计 → 档位。
 *
 * 两条不变量，都由 `scripts/test-reading-companion.mjs` 用断言守住：
 * - **单调不减**：任一计数增加，档位不会降低；
 * - **有上界**：分到 `heavy` 之后不再往上走。
 *
 * 这套功能**明确不做**服务端 / ML 推理（见 `docs/companion-reading-plan.md` §7）：
 * 它的失败模式是「太吵」而不是「不够准」，第一版只用可解释的本地信号。
 */
export function deriveIntensity(stats: CompanionLearningStats): CompanionIntensity {
  const score = companionSignalScore(stats);
  if (score >= INTENSITY_THRESHOLDS.heavy) return "heavy";
  if (score >= INTENSITY_THRESHOLDS.medium) return "medium";
  if (score >= INTENSITY_THRESHOLDS.light) return "light";
  return "off";
}
