import type { PdfReadingBlock } from "../types";
import type { TranslationBlockResult, LlmServiceConfig } from "./readingAssistant";
import { readVersionedLocalState, writeVersionedLocalState } from "./localStore";

const STORAGE_KEY = "r0nix_reader_translation_cache_v1";
const STORAGE_VERSION = 1;

export interface TranslationCacheEntry {
  fingerprint: string;
  results: TranslationBlockResult[];
  updatedAt: string;
}

function hashConfigPart(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function cacheKey(kind: "pdf" | "markdown", documentId: string, config: LlmServiceConfig) {
  const configFingerprint = [
    config.baseUrl.trim().replace(/\/$/, ""),
    config.model.trim(),
    config.temperature ?? 0.2,
    config.translationTargetLanguage?.trim() || "Simplified Chinese",
    config.translationSystemPrompt?.trim() || "",
  ].join("\u001f");
  return `${kind}:${documentId}:${hashConfigPart(configFingerprint)}`.toLowerCase();
}

function fingerprint(blocks: PdfReadingBlock[]) {
  const source = blocks.map((block) => `${block.id}|${block.page}|${block.kind}|${block.depth || 0}|${(block.tableAlign || []).join(",")}|${block.text}`).join("\n");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length}:${(hash >>> 0).toString(16)}`;
}

function sanitizeResult(value: unknown): TranslationBlockResult | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<TranslationBlockResult>;
  const block = item.block;
  if (!block || typeof block !== "object" || typeof block.id !== "string" || typeof block.text !== "string") return null;
  if (typeof item.translation !== "string") return null;
  return { block: block as PdfReadingBlock, translation: item.translation, error: typeof item.error === "string" ? item.error : undefined };
}

export function loadTranslationCache(kind: "pdf" | "markdown", documentId: string, config: LlmServiceConfig, blocks: PdfReadingBlock[]): TranslationCacheEntry | null {
  if (!documentId.trim() || blocks.length === 0) return null;
  const all = readVersionedLocalState<Record<string, TranslationCacheEntry>>(STORAGE_KEY, STORAGE_VERSION, {}, (raw) => raw && typeof raw === "object" ? raw as Record<string, TranslationCacheEntry> : {});
  const entry = all[cacheKey(kind, documentId, config)];
  // A document edit must invalidate only changed blocks. The document
  // fingerprint remains diagnostic; block identity and source text below are
  // the authoritative reuse boundary.
  if (!entry || !Array.isArray(entry.results)) return null;
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const results = entry.results
    .map(sanitizeResult)
    .filter((item): item is TranslationBlockResult => Boolean(item))
    .filter((item) => {
      const current = blockById.get(item.block.id);
      return Boolean(current && current.kind === item.block.kind && current.text === item.block.text);
    })
    .map((item) => ({ ...item, block: blockById.get(item.block.id) as PdfReadingBlock }));
  return results.length > 0 ? { ...entry, results } : null;
}

export function saveTranslationCache(kind: "pdf" | "markdown", documentId: string, config: LlmServiceConfig, blocks: PdfReadingBlock[], results: TranslationBlockResult[]) {
  if (!documentId.trim() || blocks.length === 0 || results.length === 0) return;
  const all = readVersionedLocalState<Record<string, TranslationCacheEntry>>(STORAGE_KEY, STORAGE_VERSION, {}, (raw) => raw && typeof raw === "object" ? raw as Record<string, TranslationCacheEntry> : {});
  const entries = Object.entries(all);
  if (entries.length > 24) entries.sort((left, right) => Date.parse(left[1].updatedAt) - Date.parse(right[1].updatedAt));
  const next = Object.fromEntries(entries.slice(Math.max(0, entries.length - 23)));
  next[cacheKey(kind, documentId, config)] = { fingerprint: fingerprint(blocks), results, updatedAt: new Date().toISOString() };
  writeVersionedLocalState(STORAGE_KEY, STORAGE_VERSION, next);
}
