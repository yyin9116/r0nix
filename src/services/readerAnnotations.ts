import { readVersionedLocalState, writeVersionedLocalState } from "./localStore.ts";
import type { ReaderAnnotation, ReaderAnnotationKind } from "../types";

/**
 * 阅读批注的持久化契约 —— 「刷新之后还剩什么」的唯一定义处。
 *
 * ⚠️ 这里的 import 带了显式 `.ts` 扩展名，是本仓唯一的例外，删不得。
 * 原因：`npm run test:fixtures` 用 `node --experimental-strip-types` 直跑 TS，
 * 该运行时对相对 import 要求显式扩展名（无扩展名会 ERR_MODULE_NOT_FOUND）。
 * 带上扩展名，本模块才能被 `scripts/test-reader-annotations.mjs` 真实加载，
 * 从而用**行为断言**覆盖「谁能在刷新后存活」，而不是退化成
 * `readFileSync` + `includes` 的字符串断言 —— 对照 `services/userSettings.ts`，
 * 它因为 `import "./localStore"`（无扩展名）只能这样弱测。
 * 删掉扩展名会让 `npm run test:fixtures` 立刻变红（tsc 仍是绿的，别只看 tsc）。
 * tsconfig 已开 `allowImportingTsExtensions`，tsc 与 vite 都接受。
 */

export const ANNOTATIONS_KEY = "r0nix_reader_annotations_v1";
export const ANNOTATIONS_STATE_VERSION = 1;

/**
 * 允许被水合的标注 kind —— 唯一来源。
 *
 * ⚠️ 这里原本是本仓最贵的一个坑：加新 kind（例如计划中的 `wavy`）而漏改白名单时，
 * 标注会被正常写进 localStorage、却在**刷新后被静默丢弃**，症状与「保存失败」一模一样，
 * 而 `tsc` 全程是绿的。
 *
 * 修法不是「记得改」，而是让漏改变成编译错误：`Record<ReaderAnnotationKind, true>`
 * 要求**穷举联合的每个成员**，往 `ReaderAnnotationKind` 里加成员而没在这里补一条，
 * `tsc` 会直接报「缺少属性」。运行时的白名单由这份穷举表派生，因此
 * 「类型有、白名单没有」这个状态在类型层面就不存在。
 * 再往上一层，`scripts/test-reader-annotations.mjs` 钉住了这份白名单的具体内容，
 * 使它不可能被无意拓宽。背景见 `docs/companion-reading-plan.md`。
 */
const ANNOTATION_KIND_COVERAGE: Record<ReaderAnnotationKind, true> = {
  highlight: true,
  underline: true,
  strike: true,
  text: true,
};

export const KNOWN_ANNOTATION_KINDS: readonly ReaderAnnotationKind[] = Object.keys(
  ANNOTATION_KIND_COVERAGE
) as ReaderAnnotationKind[];

const KNOWN_ANNOTATION_KIND_SET: ReadonlySet<string> = new Set<string>(KNOWN_ANNOTATION_KINDS);

export function isKnownAnnotationKind(value: unknown): value is ReaderAnnotationKind {
  return typeof value === "string" && KNOWN_ANNOTATION_KIND_SET.has(value);
}

/**
 * 水合任意来源的批注表（localStorage 里的旧数据、被手改过的 JSON、更高版本的残留）。
 *
 * 逐条丢弃无法修复的记录，并**逐字段重建**返回对象 —— 未列出的字段一律不保留。
 * 这正是 `origin`（AI 标注来源）之类新字段加进来后会被静默吞掉的地方：
 * 它不会报错，只会「写进去了、读不回来」。第二个 `tsc` 抓不到的接触点。
 */
export function sanitizeStoredAnnotations(raw: unknown): Record<string, ReaderAnnotation[]> {
  const parsed = raw as Record<string, Array<Partial<ReaderAnnotation>>> | null;
  const next: Record<string, ReaderAnnotation[]> = {};
  for (const [key, value] of Object.entries(parsed || {})) {
    if (!Array.isArray(value)) continue;
    next[key] = value
      .filter((item) => typeof item?.id === "string" && typeof item?.page === "number")
      .map((item): ReaderAnnotation | null => {
        const rect = item.rect;
        const validRect =
          rect &&
          typeof rect.x === "number" &&
          typeof rect.y === "number" &&
          typeof rect.width === "number" &&
          typeof rect.height === "number";
        const kind = item.kind;
        if (!validRect) return null;
        if (!isKnownAnnotationKind(kind)) return null;
        return {
          id: item.id as string,
          documentId: typeof item.documentId === "string" && item.documentId ? item.documentId : undefined,
          blockId: typeof item.blockId === "string" && item.blockId ? item.blockId : undefined,
          page: Math.max(1, Math.round(item.page as number)),
          kind,
          rect: {
            x: Math.max(0, Math.min(1, rect.x)),
            y: Math.max(0, Math.min(1, rect.y)),
            width: Math.max(0.002, Math.min(1, rect.width)),
            height: Math.max(0.002, Math.min(1, rect.height)),
          },
          content: typeof item.content === "string" ? item.content : undefined,
          createdAt:
            typeof item.createdAt === "string" && item.createdAt ? item.createdAt : new Date().toISOString(),
        };
      })
      .filter((item): item is ReaderAnnotation => Boolean(item))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }
  return next;
}

export function loadStoredAnnotations(): Record<string, ReaderAnnotation[]> {
  return readVersionedLocalState(ANNOTATIONS_KEY, ANNOTATIONS_STATE_VERSION, {}, sanitizeStoredAnnotations);
}

export function saveStoredAnnotations(next: Record<string, ReaderAnnotation[]>): void {
  writeVersionedLocalState(ANNOTATIONS_KEY, ANNOTATIONS_STATE_VERSION, next);
}
