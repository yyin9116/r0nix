import { readVersionedLocalState, writeVersionedLocalState } from "./localStore.ts";
import type { ReaderAnnotation, ReaderAnnotationRect } from "../types";

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
// 自动标注：wavy 标记（§5 / design-system §11.8）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 找到某块上**已经存在**的伴读标记。
 *
 * 为什么必须先查：伴读标记是「模型给出提示」的副产物，而提示会对同一块产生多次
 * （重开文档、换页再回来）。不查就会在同一段上叠出一摞一模一样的波浪线 ——
 * 视觉上像渲染坏了，且删掉一条下面还有一条。
 *
 * 只认 `kind === "wavy" && origin === "ai"`：人工画的线不算，读者自己标的
 * underline / highlight 更不算 —— 那不是伴读的东西，不该参与去重。
 */
export function findCompanionMarker(
  annotations: readonly ReaderAnnotation[],
  blockId: string
): ReaderAnnotation | undefined {
  if (!blockId) return undefined;
  return annotations.find(
    (annotation) => annotation.kind === "wavy" && annotation.origin === "ai" && annotation.blockId === blockId
  );
}

/**
 * 造一条伴读标记。
 *
 * 返回 `undefined` 表示**不该标**：块没有矩形，或者矩形退化成一条线。
 * 没有几何的标记画不出来（会变成纸面上一个 0×0 的碎点），
 * 而「画不出来的标记」比「不标」更糟 —— 它会让读者以为界面坏了。
 *
 * `content` 放的是模型那句疑问：波浪线本身只说明「这里可能难懂」，
 * 「难懂在哪」要靠锚点旁边的气泡说；把疑问存进标注，点开笔记才有内容可看。
 */
export function buildCompanionMarker(input: {
  documentId?: string;
  block: { id: string; page: number; rect?: ReaderAnnotationRect };
  question: string;
  reason?: string;
}): Omit<ReaderAnnotation, "id" | "createdAt"> | undefined {
  const rect = input.block.rect;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return undefined;
  return {
    documentId: input.documentId,
    blockId: input.block.id,
    page: input.block.page,
    kind: "wavy",
    rect,
    content: input.question,
    reason: input.reason,
    origin: "ai",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 页侧批注卡摆放（2026-10-09：伴读从浮动气泡改为 margin note 形态）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 批注卡收起态的估算高度（px）。
 *
 * 摆放发生在渲染之前，拿不到实测高度 —— 只能按收起态估。展开态会更高，
 * 但「展开哪张」是读者的即时操作，此时轻微重叠可接受（Word 的 margin note
 * 同样如此）；为展开态预留高度反而会让收起态稀疏得莫名其妙。
 */
export const MARGIN_CARD_COLLAPSED_HEIGHT = 132;

/** 批注卡的固定宽度（px）。批注栏不够宽时卡片向页边内溢（与 Word 一致）。 */
export const MARGIN_CARD_WIDTH = 264;

export interface MarginCardInput {
  id: string;
  /** 卡片锚点在容器内的纵向位置（px），通常 = 标注 rect.y × 页面渲染高度。 */
  top: number;
}

export interface MarginCardPlacement {
  id: string;
  side: "left" | "right";
  top: number;
}

/**
 * 把一页的批注卡摆到两侧批注栏里，纵向不重叠。
 *
 * ## 规则
 *
 * 1. 按锚点 top 排序（自上而下扫，结果与输入顺序无关）。
 * 2. 每张卡优先放**右侧**，贴着自己的锚点；右侧纵向放不下（会与已放的卡
 *    重叠或超出页底）时换**左侧**；两侧都放不下时回右侧、钳到页底 ——
 *    宁可重叠也不把卡丢掉。
 * 3. 预算（COMPANION_MARKER_BUDGET，light=1 / medium=2）保证了每页卡数很少，
 *    第 3 条在实际数据里几乎不会走到；它存在是为了让函数**总**有解。
 */
export function placeCompanionMarginCards(
  items: readonly MarginCardInput[],
  containerHeight: number,
  gap = 12
): MarginCardPlacement[] {
  const sorted = [...items]
    .filter((item) => Number.isFinite(item.top))
    .sort((a, b) => a.top - b.top);
  const placements: MarginCardPlacement[] = [];
  let rightBottom = 0;
  let leftBottom = 0;
  for (const item of sorted) {
    const height = MARGIN_CARD_COLLAPSED_HEIGHT;
    const fit = (sideBottom: number) => {
      const top = Math.max(0, Math.max(item.top, sideBottom + gap));
      return top + height <= containerHeight ? top : null;
    };
    const rightTop = fit(rightBottom);
    if (rightTop !== null) {
      placements.push({ id: item.id, side: "right", top: rightTop });
      rightBottom = rightTop + height;
      continue;
    }
    const leftTop = fit(leftBottom);
    if (leftTop !== null) {
      placements.push({ id: item.id, side: "left", top: leftTop });
      leftBottom = leftTop + height;
      continue;
    }
    // 两侧都放不下：回右侧、钳进容器。clamp 目标取「锚点 top」与「页底留出
    // 卡高」的较小者 —— 卡尽量还贴着自己的段落，而不是飘到别处。
    const clampedTop = Math.max(0, Math.min(item.top, Math.max(0, containerHeight - height)));
    placements.push({ id: item.id, side: "right", top: clampedTop });
    rightBottom = clampedTop + height;
  }
  return placements;
}

// ─────────────────────────────────────────────────────────────────────────────
// 密度档位（§3.4 / §7）
// ─────────────────────────────────────────────────────────────────────────────

export type CompanionIntensity = "off" | "light" | "medium" | "heavy";

/** 档位的全序。用于单测里的单调性断言，也用于 UI 的档位选择器。 */
export const COMPANION_INTENSITIES: readonly CompanionIntensity[] = ["off", "light", "medium", "heavy"];

/**
 * 每页允许留下的伴读标记条数。
 *
 * 为什么要有预算：提示是**一次性**的，弹完就消失；标记是**累积**的，会一直
 * 留在纸上。一页攒四五条波浪线之后，纸面比没开伴读时更难读 —— 这正是这类
 * 主动功能最容易被整个关掉的原因。所以这一档管的是**痕迹的量**，与
 * `companionIntensity`（管提问的密度）是两件独立的事：有人愿意多被问、但不希望
 * 纸上留痕，也有人正好相反。
 *
 * `off` = 一条都不留（提示照常出现）；`heavy` = 不限。
 */
export const COMPANION_MARKER_BUDGET: Record<CompanionIntensity, number> = {
  off: 0,
  light: 1,
  medium: 2,
  heavy: Number.POSITIVE_INFINITY,
};

/** 数一页上已有的伴读标记。只数 AI 留的 —— 读者自己画的线不该占预算。 */
export function countCompanionMarkersOnPage(
  annotations: readonly ReaderAnnotation[],
  page: number
): number {
  return annotations.filter(
    (annotation) =>
      annotation.kind === "wavy" && annotation.origin === "ai" && annotation.page === page
  ).length;
}

/**
 * 这一页还放得下一条伴读标记吗。
 *
 * 未知档位按 `medium` 处理：设置可能来自旧版本或被手改过，
 * 而「认不出档位就一律不标」会让这个功能静默失效 —— 那正是最难排查的失败形态。
 */
export function canAddCompanionMarker(
  annotations: readonly ReaderAnnotation[],
  input: { page: number; intensity: CompanionIntensity }
): boolean {
  const budget = COMPANION_MARKER_BUDGET[input.intensity] ?? COMPANION_MARKER_BUDGET.medium;
  if (!(budget > 0)) return false;
  return countCompanionMarkersOnPage(annotations, input.page) < budget;
}

/** 把 `createdAt` 折成可比较的毫秒数。解析不了的值按 0（最旧）处理，不让 NaN 污染排序。 */
function createdAtMs(annotation: ReaderAnnotation): number {
  const parsed = Date.parse(annotation.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 这一页**渲染出来**的伴读波浪线 —— 按预算截断后的清单。
 *
 * ## 为什么 `canAddCompanionMarker` 不够
 *
 * 那道闸只在**新增那一刻**数一次，而标注是持久化在 localStorage 里、跨会话累积的。
 * 于是有一条路径能绕过预算的语义：`promptedPagesRef` 每次打开文档都重置，
 * 所以「每回打开都能再攒 1-2 条」；`canAddCompanionMarker` 拦得住当下这一条，
 * 拦不住上一轮已经落盘的。反复打开同一份 PDF，预算 `medium = 2` 的页面上
 * 照样能攒到 6+ 条 —— 2026-10-08 实测正是这个现象（满页波浪线）。
 *
 * 换句话说：**预算只在写入侧把关，纸面却在渲染侧累积**。这一层补的就是渲染侧，
 * 让「痕迹的量」这一档真的管住痕迹 —— 哪怕数据已经攒多了。
 *
 * ## 为什么只截断、不删除
 *
 * 删除是破坏性的：这些线可能已经被读者当重点、可能挂着笔记。藏起来是可逆的
 * （把档位调回「重」就都回来了），删掉不是。所以数据留着，只是不全画。
 *
 * ## `off` 为什么也要真的画成 0 条
 *
 * 设置里这一档的文案是「关 = 一条不留（提示照常）」—— 「一条不留」只有在
 * 渲染层也成立才不是空话。只在写入侧拦= 已经落盘的那些会永远留在纸上，
 * 而用户明明选了「关」。
 *
 * 注意调用方要传的是 `companionMarkerIntensity`（留痕档位）本身，
 * **不是** `companionAutoAnnotate ? companionMarkerIntensity : "off"`：
 * 总开关管的是「要不要再新增」，档位管的是「留多少」，两件事在渲染层不混 ——
 * 关掉总开关不应该顺手清空读者已经看到的线。
 *
 * ## 顺序
 *
 * 截断按 `createdAt` 取**最近**的 N 条（读者刚停留的那块最可能是他关心的），
 * 但返回时恢复成 `annotations` 的原序，理由同 `companionAnchorsOnPage`：
 * 数组顺序即添加顺序，读者删掉一条之后其余波浪线不该整体跳位。
 */
export function visibleCompanionMarkersOnPage(
  annotations: readonly ReaderAnnotation[],
  input: {
    page: number;
    intensity: CompanionIntensity;
    /**
     * 按 blockId 取该块的行级 bbox。
     *
     * 为什么由调用方提供：行级数据住在 `PdfReadingBlock.lines`，而
     * `ReaderAnnotation` 里只有几何、没有块结构 —— 纯函数不该反过来依赖块仓库。
     * 调用方（PDFViewer）手上正好有 `readingBlocksByPageRef`，接上是自然的。
     *
     * 拿不到时（无行级数据 / 块已卸载）退回单行，宁可少划也不划错。
     */
    linesForBlock?: (blockId: string) => { text?: string; rect?: ReaderAnnotationRect }[] | undefined;
    /**
     * 该块是否属于「不该被标注」的版面区域（页眉 / 页脚 / 页码 / 标题 / 水印）。
     *
     * ## 为什么渲染侧还要再过滤一次
     *
     * `isNonProseRegion` 只在**新增**那一刻生效（停留触发 / 手动打开 / 兜底选块），
     * 而标注是持久化在 localStorage 里、跨会话累积的 —— 于是有一条路径绕过它：
     * **过滤规则上线之前**留下的页眉/页脚波浪线会永远留在纸上。
     * 2026-10-08 实测正是这个现象：过滤已生效，但页眉上仍有波浪线。
     *
     * 与 ④ 预算截断是同一个道理：写入侧把关，渲染侧也要兜住存量。
     * 这层是**只读过滤**（不删数据），把档位调回来或数据迁移后立刻恢复。
     *
     * 拿不到块（`blockId` 缺失的老数据、或块已卸载）时**不拦**：
     * 判据缺失不等于该拦，而误杀一条正文标注比漏放一条页眉标注更难解释。
     */
    isNonProseBlock?: (blockId: string) => boolean;
  }
): ReaderAnnotation[] {
  // ⚠️ 几何归一化**必须**排在预算截断之前。
  //
  // 反过来的话，几何无效的标注（width/height 非正）会先占掉预算名额再被丢弃：
  // light 档只有一条名额时，一条画不出来的标注就把唯一能显示的那条挤掉了 ——
  // 屏幕上一条线都没有，而数据里明明有。这比「多画几条」更难排查。
  //
  // 归一化是纯函数且幂等，所以先做不会影响后续的截断结果。
  const drawable = annotations.flatMap((annotation) => {
    if (annotation.kind !== "wavy" || annotation.origin !== "ai") return [];
    if (annotation.page !== input.page) return [];
    // 存量非正文标注：块查得到且被判为非正文才拦，见 isNonProseBlock 的注释。
    if (annotation.blockId && input.isNonProseBlock?.(annotation.blockId)) return [];
    const rect = clampMarkerRectToSentence(
      annotation.rect,
      annotation.blockId ? input.linesForBlock?.(annotation.blockId) : undefined
    );
    return rect ? [{ ...annotation, rect }] : [];
  });
  const budget = COMPANION_MARKER_BUDGET[input.intensity] ?? COMPANION_MARKER_BUDGET.medium;
  // ⚠️ 这里**没有** `if (budget <= 0) return []` 短路，是实测后的结论：
  // 那样写与不写行为完全一致（`slice(0, 0)` 本身就返回空），等于多出一行
  // 「看起来在守 off 档、实际由下面两行兜住」的代码 —— 读者会以为删掉它会出事。
  // off 档画不出任何线这件事由 test-reading-companion.mjs 的行为断言守住。
  //
  // budget 为 Infinity 时 `drawable.length <= budget` 恒真，等于「全留」，不必单独判有限性。
  if (drawable.length <= budget) return drawable;
  return keepNewestWithinBudget(drawable, budget);
}

/** 按 `createdAt` 取最近的 N 条，但保持入参原序。 */
function keepNewestWithinBudget(
  onPage: readonly ReaderAnnotation[],
  budget: number
): ReaderAnnotation[] {
  const keep = new Set(
    [...onPage]
      .sort((left, right) => createdAtMs(right) - createdAtMs(left))
      .slice(0, budget)
      .map((annotation) => annotation.id)
  );
  return onPage.filter((annotation) => keep.has(annotation.id));
}

/**
 * 一行正文在**归一化页面坐标**里的典型高度。
 *
 * A4 高 297mm，单倍行距约 4.2mm ≈ 0.0141；US Letter 高 279mm ≈ 0.0150。
 * 取 0.014 是两者之间偏保守的一侧 —— 一行波浪线宁短勿长，长了会啃到下一行。
 */
const NORMALIZED_LINE_HEIGHT = 0.014;

/**
 * 一条波浪线最多覆盖多少行。
 *
 * ## 为什么需要上限
 *
 * 用户要的是「划的是完整一句话」（2026-10-08 反馈：「划线内容不是完整的一句话，
 * 而是仅一行，不完全」）。但句子的长度没有上限 —— 一句没有从句的长句、
 * 或者解析器把两行并成一行，都可能让「按句取」退化成「整段」。
 * 所以要有硬上限兜底：**宁可少划一行，不可画出满页**。
 *
 * 4 行足够覆盖绝大多数中文句子（通常 20–60 字，一行约 25 字）。
 */
const MAX_MARKER_LINES = 4;

/**
 * 把一条标注的几何对齐到**行边界**，并扩展到完整句子。
 *
 * ## 演进（这段注释是三次返工留下的，别再改回前两版）
 *
 * v1 只截断条数 → 存量标注一条划满整段（用户反馈「还是满页波浪线」）。
 * v2 截到单行 → 用户反馈「仅一行，不完全」，句子被腰斩。
 * v3（本版）按行边界取整句。
 *
 * ## 为什么要有行级数据
 *
 * 只有块级 `rect` 时无法区分「一行的高度」与「一段的高度」——
 * 二者都是「比 0.02 大、不到页高」。`lines[].rect` 是 PyMuPDF 的行级 bbox，
 * 才能判断「下一行的顶在哪」。拿不到行级数据时退回单行（v2 行为），
 * 宁可少划也不划错 —— 划错会让读者以为整段都难懂。
 */
export function clampMarkerRectToSentence(
  rect: ReaderAnnotationRect | undefined,
  lines?: readonly { text?: string; rect?: ReaderAnnotationRect }[]
): ReaderAnnotationRect | undefined {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return undefined;
  // ⚠️ x 必须**先**归一，再拿去参与裁剪运算。
  // 顺序反了的话，`1 - NaN` 得到 NaN，`Math.min(width, NaN)` 也是 NaN，
  // 后面 `width > 0` 判定失败 → 整条标注被静默丢弃。症状是「个别标注莫名不显示」，
  // 且没有任何日志线索。坐标脏数据（NaN/Infinity）会一路传染给 width/height。
  const x = clampUnit(rect.x);
  const width = Math.min(rect.width, 1 - x);
  if (!(width > 0)) return undefined;
  const y = clampUnit(rect.y);
  const singleLine = Math.min(rect.height, NORMALIZED_LINE_HEIGHT);
  if (!(singleLine > 0)) return undefined;

  const spanned = linesAtOrBelow(rect, lines);
  if (spanned.length <= 1) {
    // 恰好命中一行：用**真实行盒**。不能编「y=块顶、h=常数」的细带 ——
    // 常数带假设「块顶=首行顶、行高=NORMALIZED_LINE_HEIGHT」，对 DOM 块两者都不成立
    // （DOM 行高来自渲染字形，普遍大于排版常数；块 rect 还带合并时留出的 padding）。
    // 带子矮那么一两个像素，中心点命中就全灭 —— 波浪线一根都画不出来，
    // 而数据里明明有（2026-10-08 实测：带底 195.2px vs 行中心 196.3px）。
    if (spanned.length === 1) {
      const lineRect = spanned[0].rect;
      return { x, y: clampUnit(lineRect.y), width, height: Math.max(singleLine, lineRect.height) };
    }
    // 完全没有行级数据：**保持原矩形，不编造几何**。
    // 把块级 rect 压成常数细带曾经是「防满页」的手段，但它碰不到文字中心，
    // 后果是「数据在、线全灭」—— 比画整段严重得多。这里宁可诚实地保持原样
    // （通常是块级框，画出来是一段），也不产出一根必然 miss 的线。
    // 有行数据的路径（上面与下方的整句扩展）仍然会把范围收窄到句。
    return { x, y, width, height: Math.max(rect.height, singleLine) };
  }

  // 从首行往后续，直到句末标点或行数上限。
  const bottom = sentenceBottom(spanned, rect);
  const height = Math.min(bottom - y, NORMALIZED_LINE_HEIGHT * MAX_MARKER_LINES);
  if (!(height > 0)) return undefined;
  return { x, y, width, height };
}

/** 句末标点。中英文都收，句号/问号/叹号/分号/冒号都算一句话的尽头。 */
const SENTENCE_END = /[.!?。！？；;：:]["'"'）)\]]?\s*$/;

/**
 * 找出落在块内、且顶边不高于「视线所在行顶」的那些行（按顶边升序）。
 *
 * 起始行的定位方式：取所有「与块顶有重叠」的行里最靠上的那个。
 * 这样存量块级 rect 的首行与新写入的行级 rect 会得到同一结果 —— 两种数据
 * 混在一起时，不会出现「有的划一句、有的划一行」的不一致。
 */
function linesAtOrBelow(
  rect: ReaderAnnotationRect,
  lines: readonly { text?: string; rect?: ReaderAnnotationRect }[] | undefined
): { text: string; rect: ReaderAnnotationRect }[] {
  if (!lines?.length) return [];
  const usable = lines
    .filter((line): line is { text: string; rect: ReaderAnnotationRect } => {
      const r = line.rect;
      return !!r && r.width > 0 && r.height > 0;
    })
    .sort((a, b) => a.rect.y - b.rect.y);
  if (!usable.length) return [];

  const blockBottom = rect.y + rect.height;
  // 起始行：块顶落在它的高度区间内（含块顶正好贴行顶的常见情形）。
  const startIndex = usable.findIndex(
    (line) => line.rect.y + line.rect.height > rect.y + 1e-6 && line.rect.y <= blockBottom
  );
  if (startIndex < 0) return [];
  const from = usable.slice(startIndex).filter((line) => line.rect.y < blockBottom - 1e-6);
  return from.slice(0, MAX_MARKER_LINES + 1);
}

/**
 * 一句结束在哪个 y。
 *
 * 首行带句末标点就到此为止（`first.y + height`）；否则顺着往下找，
 * 找到第一行以句末标点收尾的，最多累积 `MAX_MARKER_LINES` 行。
 *
 * 找不到句末标点时返回**累积到上限的底部**：这时整块可能是一个长句，
 * 宁可划到上限也不该退回单行（否则又回到「腰斩」的旧问题）。
 */
function sentenceBottom(
  spanned: readonly { text: string; rect: ReaderAnnotationRect }[],
  rect: ReaderAnnotationRect
): number {
  const first = spanned[0];
  let bottom = first.rect.y + first.rect.height;
  if (SENTENCE_END.test(first.text.trim())) return bottom;
  for (let i = 1; i < Math.min(spanned.length, MAX_MARKER_LINES); i += 1) {
    const line = spanned[i];
    bottom = line.rect.y + line.rect.height;
    if (SENTENCE_END.test(line.text.trim())) break;
  }
  // 行级数据缺失或越界时，用行数推出的底部可能被块底超过 —— 夹回块内，
  // 否则波浪线会越过段落末尾画到下一段去。
  return Math.min(bottom, rect.y + rect.height);
}

/** 把归一化坐标夹进 [0, 1]。越界值会让波浪线画到页外或整个消失。 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 伴读锚点（design-system §11.8「只有波浪线附带锚点」）
//
// 为什么锚点不是装饰 —— `types.ts` 里那句「消歧只能靠『波浪线旁必有伴读锚点』」
// 是这套设计的支点。波浪线只说「这里可能难懂」，但「难懂」是个通用含义，
// 页面上任何一条波浪线（包括读者自己画的）都长��样。锚点是唯一的区分手段：
// **有锚点 = AI 在这里等着你问，没有锚点 = 这条线只是你自己的记录。**
//
// 由此推出三条硬约束，任何一条破了都会让消歧失效：
// 1. 锚点**只**出现在 `kind === "wavy" && origin === "ai"` 的标注旁；
// 2. 锚点**必须可点** —— 它是态 A 进入态 B 的唯一入口（点锚点才展开气泡）；
// 3. 锚点位置由标注矩形推导，不另存一份坐标 —— 两份坐标会漂移，
//    而漂移的结果是「点锚点弹出的是别处的解释」。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 锚点的**呈现尺寸**（px）：18×18 容器 + 9 实心点 + 描边环 + 外扩留白。
 *
 * ⚠️ 迁移前是 15.3px 的纯黑实心点（`var(--content-primary)`）。2026-10-08 实测
 * 「黑点特别大」：15.3px 的实心黑圆压在正文上不像标记，像污渍 —— 而它要标记的
 * 是 10pt 左右的正文行高，接近一整个字高。
 *
 * 命中区与视觉尺寸必须分开：命中区靠 COMPANION_ANCHOR_HIT_SLOP 外扩（34px，
 * 满足 Fitts 定律），视觉直径压到 9px。这样「点得准」和「看得轻」不再互相牵制。
 */
export const COMPANION_ANCHOR_SIZE = 18;

/** 锚点实心点的直径（px）。刻意小于容器：留白让点在密集正文里不糊成一片。 */
export const COMPANION_ANCHOR_DOT_SIZE = 9;

/** 锚点可点区域相对视觉尺寸的外扩量（px）。设计稿 15.3 的点太小，按 Fitts 定律补命中区。 */
export const COMPANION_ANCHOR_HIT_SLOP = 8;

/**
 * 锚点的 z-index。
 *
 * ⚠️ 必须**高于** `.page-text-overlay` 的 9。旧值是 3，于是：
 *   · 文本层（z-index 9，且在 assist 态下 `pointer-events: auto`）压在锚点之上；
 *   · 点锚点的落点其实在文本层的 span 上，被段落命中逻辑吃掉；
 *   · 表现就是「锚点看得见、点不动」（2026-10-08 实测）。
 * 这里取 20：高于文本层（9）与图片层（10），低于右键菜单（80）与 toast（50 之上无交互）。
 */
export const COMPANION_ANCHOR_Z_INDEX = 20;

/**
 * 这一条标注该不该挂锚点。
 *
 * 与 `findCompanionMarker` 同一条判据（`wavy` + `ai`），但语义相反：那个问
 * 「这块上有没有伴读标记」，这个问「这条标注本身是不是伴读留下的」。
 * 分成两个函数而不是加个参数，是为了让调用点的意图自解释 ——
 * `renderCompanionAnchor(annotation)` 读起来比 `renderCompanionAnchor(annotation, true)` 清楚。
 */
export function isCompanionAnchorTarget(annotation: ReaderAnnotation): boolean {
  return annotation.kind === "wavy" && annotation.origin === "ai";
}

/**
 * 算出锚点在页面元素内的定位（归一化坐标，0-1）。
 *
 * 落在标注矩形的**右上角外侧**，而不是左上角：左上角是行首，读者视线从
 * 上一行进入时先经过那里，锚点会被前一行遮住；右上角悬在句子末尾之后，
 * 与「读完这句、接着往下」的视线方向一致。
 *
 * 边界处理：锚点是固定像素尺寸，归一化坐标需要一个页宽/页高来换算，
 * 所以调用方必须传 `pageSize`；缺任一项都返回 `null`（宁可不画，
 *也不要画一个位置错乱的锚点 —— 那比没有锚点更误导）。
 */
export function companionAnchorPosition(input: {
  rect: ReaderAnnotationRect;
  pageSize: { width: number; height: number };
}): { x: number; y: number } | null {
  const { rect, pageSize } = input;
  if (!(pageSize.width > 0) || !(pageSize.height > 0)) return null;
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;

  // 锚点圆心对齐标注矩形的右上角，纵向略微上提，让它悬在句子末尾而非要贴住行尾。
  const x = rect.x + rect.width;
  const y = rect.y + rect.height * 0.08;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // 允许落在 [0,1] 之外一点点（贴边时锚点会有一半在页面外），
  // 但不允许跑到负得离谱或远超一整页 —— 那说明矩形本身就是坏的。
  if (x < -0.5 || y < -0.5 || x > 1.5 || y > 1.5) return null;
  return { x, y };
}

/**
 * 锚点是否应当出现在这一页的渲染层里。
 *
 * 存在的唯一理由是**被看见**：锚点是入口，藏起来等于取消入口。
 * 页面上波浪线有几十条时全挂锚点会变成一片散点，所以按数量设上限 ——
 * 取值 6 是「一屏内能一眼扫到、又不至于变成噪点」的经验值。
 */
export const COMPANION_ANCHOR_MAX_PER_PAGE = 6;

/**
 * 这一页该渲染哪些锚点。
 *
 * 返回的是**已经按标注顺序去重、且截断到上限**的标注列表 —— 调用方直接
 * map 即可，不需要再自己过滤或截断。
 *
 * 排序保持 `annotations` 的原序而不是重新排：标注数组的顺序就是它们被
 * 添加的顺序，对读者而言「先标的在上」是自然的；而按位置重排会让锚点
 * 在读者删除一条标注后整体跳位。
 */
export function companionAnchorsOnPage(
  annotations: readonly ReaderAnnotation[],
  page: number
): ReaderAnnotation[] {
  const result: ReaderAnnotation[] = [];
  const seen = new Set<string>();
  for (const annotation of annotations) {
    if (annotation.page !== page) continue;
    if (!isCompanionAnchorTarget(annotation)) continue;
    const key = annotation.blockId || annotation.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(annotation);
    if (result.length >= COMPANION_ANCHOR_MAX_PER_PAGE) break;
  }
  return result;
}
