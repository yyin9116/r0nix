import { invoke } from "@tauri-apps/api/core";
import { readVersionedLocalState, writeVersionedLocalState } from "./localStore.ts";

/**
 * 阅读 assist 历史的持久化契约 —— 「翻译 / 问问 AI / 解释」结果的唯一落盘处。
 *
 * 存储形态（对应需求：「为对应 PDF 生成一个数据流 JSON，打开时自动读取恢复」）：
 * - Tauri 运行时：每份文档一个 JSON 文件，`<workspace>/assist-history/<documentId>.json`。
 *   文件由本模块全量重写（历史是追加型小数据，不值得做增量日志）。
 * - 非 Tauri 环境（单元测试 / 纯浏览器 e2e）：降级到 localStorage 版本化键，
 *   键名 `r0nix_assist_history_v1`，结构同样是 `Record<documentId, Entry[]>`。
 *
 * ⚠️ 这里的 key 是**多级**的（`assist-history/xxx.json`）。旧的后端校验拒绝任何含
 * 路径分隔符的 key，于是每次写入都被拒、历史静默只活在 localStorage 里，重启即丢。
 * Rust 侧已改为逐段校验（`workspace::resolve_in`），这里保持原样即可。
 *
 * ⚠️ 本文件 import localStore 必须带显式 `.ts` 扩展名，理由同 readerAnnotations.ts：
 * `node --experimental-strip-types` 直跑测试时相对 import 需要显式扩展名。
 */

export const ASSIST_HISTORY_STATE_VERSION = 1;
const LOCAL_KEY = "r0nix_assist_history_v1";
/** 单文档历史上限：无限增长会让每次写入都变重，也让回看失去意义。 */
export const ASSIST_HISTORY_MAX_ENTRIES = 200;

export type AssistHistoryKind = "translate" | "ask" | "explain" | "full-translation";

export interface AssistHistoryEntry {
  id: string;
  kind: AssistHistoryKind;
  /** 引用位置，如 "论文标题 / page 3"。 */
  reference: string;
  page?: number;
  /** 原文摘录（截断存储，完整原文在阅读器里随时可重选）。 */
  excerpt: string;
  /** 问问 AI / 解释的用户问题；翻译为空。 */
  question?: string;
  /** 模型结果（翻译为译文，问答为回答）。 */
  result: string;
  model?: string;
  createdAt: string;
}

const KIND_COVERAGE: Record<AssistHistoryKind, true> = {
  translate: true,
  ask: true,
  explain: true,
  "full-translation": true,
};

const KIND_SET: ReadonlySet<string> = new Set(Object.keys(KIND_COVERAGE));

export function newAssistHistoryId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `hist-${random}`;
}

/** 逐字段重建历史条目；未列出的字段一律不保留（同 sanitizeStoredAnnotations 的理由）。 */
export function sanitizeAssistHistoryEntry(raw: unknown): AssistHistoryEntry | null {
  const item = raw as Partial<AssistHistoryEntry> | null;
  if (!item || typeof item !== "object") return null;
  if (typeof item.id !== "string" || !item.id) return null;
  if (typeof item.kind !== "string" || !KIND_SET.has(item.kind)) return null;
  if (typeof item.result !== "string") return null;
  const page =
    typeof item.page === "number" && Number.isFinite(item.page) ? Math.max(1, Math.round(item.page)) : undefined;
  return {
    id: item.id,
    kind: item.kind as AssistHistoryKind,
    reference: typeof item.reference === "string" ? item.reference : "",
    page,
    excerpt: typeof item.excerpt === "string" ? item.excerpt.slice(0, 2000) : "",
    question: typeof item.question === "string" && item.question ? item.question.slice(0, 2000) : undefined,
    result: item.result.slice(0, 20000),
    model: typeof item.model === "string" && item.model ? item.model : undefined,
    createdAt:
      typeof item.createdAt === "string" && item.createdAt && !Number.isNaN(new Date(item.createdAt).getTime())
        ? item.createdAt
        : new Date().toISOString(),
  };
}

export function sanitizeAssistHistory(raw: unknown): Record<string, AssistHistoryEntry[]> {
  const parsed = raw as Record<string, unknown[]> | null;
  const next: Record<string, AssistHistoryEntry[]> = {};
  for (const [documentId, value] of Object.entries(parsed || {})) {
    if (!Array.isArray(value)) continue;
    const entries = value
      .map(sanitizeAssistHistoryEntry)
      .filter((item): item is AssistHistoryEntry => Boolean(item))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, ASSIST_HISTORY_MAX_ENTRIES);
    next[documentId] = entries;
  }
  return next;
}

export function appendAssistHistoryEntry(
  entries: AssistHistoryEntry[] | undefined,
  entry: AssistHistoryEntry,
): AssistHistoryEntry[] {
  const next = [entry, ...(entries ?? [])].slice(0, ASSIST_HISTORY_MAX_ENTRIES);
  return next;
}

// ---------------------------------------------------------------------------
// Tauri 文件通道
// ---------------------------------------------------------------------------

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function escapeDocumentId(documentId: string): string {
  // documentId 可能含路径分隔符等文件系统敏感字符；做保守的文件名化。
  return documentId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "document";
}

/**
 * 存储 key：只传文件名，路径拼接与越界校验由 Rust 侧的
 * read_app_data_json / write_app_data_json负责。
 *
 * 为什么不复用通用 read_text_file / write_text_file：
 * 前者只放行 md/markdown 扩展名，读 .json 会被直接拒绝；后者不会创建父目录，
 * 而 `assist-history/` 首次写入时并不存在。两者都会让本模块静默退化成「只有内存」。
 */
function historyStorageKey(documentId: string): string {
  return `assist-history/${escapeDocumentId(documentId)}.json`;
}

/** 从磁盘读单文档历史。文件不存在 / 解析失败 → 空数组（不抛错）。 */
async function readFileHistory(documentId: string): Promise<AssistHistoryEntry[]> {
  if (!isTauriRuntime()) return [];
  try {
    const raw = await invoke<string | null>("read_app_data_json", {
      key: historyStorageKey(documentId),
    });
    if (typeof raw !== "string" || !raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const envelope = parsed as { version?: unknown; data?: unknown };
    const data = envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : parsed;
    const entries = sanitizeAssistHistory({ [documentId]: data })[documentId];
    return entries ?? [];
  } catch {
    return [];
  }
}

async function writeFileHistory(documentId: string, entries: AssistHistoryEntry[]): Promise<void> {
  if (!isTauriRuntime()) return;
  const payload = JSON.stringify(
    { version: ASSIST_HISTORY_STATE_VERSION, updatedAt: new Date().toISOString(), data: entries },
    null,
    2,
  );
  try {
    await invoke("write_app_data_json", {
      key: historyStorageKey(documentId),
      content: payload,
    });
  } catch {
    // 落盘失败不阻塞交互：历史仍在内存与 localStorage 兜底里。
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

const localFallbackStore = (): Record<string, AssistHistoryEntry[]> =>
  readVersionedLocalState(LOCAL_KEY, ASSIST_HISTORY_STATE_VERSION, {}, sanitizeAssistHistory);

const saveLocalFallbackStore = (store: Record<string, AssistHistoryEntry[]>): void => {
  writeVersionedLocalState(LOCAL_KEY, ASSIST_HISTORY_STATE_VERSION, store);
};

/** 打开文档时调用：恢复该文档的 assist 历史。 */
export async function loadAssistHistory(documentId: string): Promise<AssistHistoryEntry[]> {
  if (!documentId) return [];
  const fromFile = await readFileHistory(documentId);
  if (fromFile.length > 0) return fromFile;
  // 文件通道没有数据时看 localStorage 兜底（例如文件被手动删除后的降级数据）。
  return localFallbackStore()[documentId] ?? [];
}

/** 追加一条记录：内存态由调用方持有，这里负责双通道落盘。 */
export async function persistAssistHistoryEntry(
  documentId: string,
  entries: AssistHistoryEntry[],
  entry: AssistHistoryEntry,
): Promise<AssistHistoryEntry[]> {
  const next = appendAssistHistoryEntry(entries, entry);
  if (!isTauriRuntime()) {
    const store = localFallbackStore();
    store[documentId] = next;
    saveLocalFallbackStore(store);
    return next;
  }
  await writeFileHistory(documentId, next);
  // localStorage 兜底同步一份：文件通道失效时仍有降级数据。
  try {
    const store = localFallbackStore();
    store[documentId] = next;
    saveLocalFallbackStore(store);
  } catch {
    // 忽略：兜底通道失败不影响主通道。
  }
  return next;
}

/** 清空单文档历史。 */
export async function clearAssistHistory(documentId: string): Promise<void> {
  if (isTauriRuntime()) {
    await writeFileHistory(documentId, []);
  }
  try {
    const store = localFallbackStore();
    delete store[documentId];
    saveLocalFallbackStore(store);
  } catch {
    // 忽略。
  }
}
