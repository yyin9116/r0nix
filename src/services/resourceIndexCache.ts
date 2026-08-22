import type { PDFImageInfo } from "./pdfApi";

export type CachedResourceLink = {
  url: string;
  page: number;
  resourceId?: string;
  documentId?: string;
};

export type ResourceIndexSnapshot = {
  images: Record<number, PDFImageInfo[]>;
  links: Record<number, CachedResourceLink[]>;
  scannedPages: number[];
};

type ResourceIndexEnvelope = ResourceIndexSnapshot & {
  version: 2;
  updatedAt: string;
};

const CACHE_PREFIX = "r0nix:resource-index:";
const CACHE_VERSION = 2 as const;
const MAX_CACHED_PAGES = 2000;
const MAX_CACHE_BYTES = 2_000_000;

function cacheKey(key: string) {
  return `${CACHE_PREFIX}${key}`;
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeImages(value: unknown): Record<number, PDFImageInfo[]> {
  if (!value || typeof value !== "object") return {};
  const result: Record<number, PDFImageInfo[]> = {};
  for (const [pageKey, rawItems] of Object.entries(value)) {
    const page = Number(pageKey);
    if (!Number.isInteger(page) || page < 1 || !Array.isArray(rawItems)) continue;
    const items = rawItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item): PDFImageInfo | null => {
        const bbox = Array.isArray(item.bbox) && item.bbox.length === 4
          ? item.bbox.map((part) => finiteNumber(part)) as [number, number, number, number]
          : undefined;
        const source = item.source === "vector" || item.source === "block" ? item.source : "xref";
        return {
          xref: Math.max(0, Math.round(finiteNumber(item.xref))),
          resourceId: typeof item.resourceId === "string" ? item.resourceId : undefined,
          documentId: typeof item.documentId === "string" ? item.documentId : undefined,
          pageNumber: page,
          width: Math.max(0, Math.round(finiteNumber(item.width))),
          height: Math.max(0, Math.round(finiteNumber(item.height))),
          extension: typeof item.extension === "string" ? item.extension : "",
          bbox,
          source,
        };
      })
      .filter((item): item is PDFImageInfo => Boolean(item));
    if (items.length > 0) result[page] = items;
  }
  return result;
}

function sanitizeLinks(value: unknown): Record<number, CachedResourceLink[]> {
  if (!value || typeof value !== "object") return {};
  const result: Record<number, CachedResourceLink[]> = {};
  for (const [pageKey, rawItems] of Object.entries(value)) {
    const page = Number(pageKey);
    if (!Number.isInteger(page) || page < 1 || !Array.isArray(rawItems)) continue;
    const items = rawItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item): CachedResourceLink | null => {
        const url = typeof item.url === "string" ? item.url.trim() : "";
        if (!url) return null;
        return {
          url,
          page,
          resourceId: typeof item.resourceId === "string" ? item.resourceId : undefined,
          documentId: typeof item.documentId === "string" ? item.documentId : undefined,
        };
      })
      .filter((item): item is CachedResourceLink => Boolean(item));
    if (items.length > 0) result[page] = items;
  }
  return result;
}

function trimPages(snapshot: ResourceIndexSnapshot): ResourceIndexSnapshot {
  const pages = Array.from(new Set([
    ...Object.keys(snapshot.images).map(Number),
    ...Object.keys(snapshot.links).map(Number),
    ...snapshot.scannedPages,
  ])).filter((page) => Number.isInteger(page) && page > 0).sort((a, b) => a - b);
  const keep = new Set(pages.slice(-MAX_CACHED_PAGES));
  return {
    images: Object.fromEntries(Object.entries(snapshot.images).filter(([page]) => keep.has(Number(page)))),
    links: Object.fromEntries(Object.entries(snapshot.links).filter(([page]) => keep.has(Number(page)))),
    scannedPages: pages.filter((page) => keep.has(page)),
  };
}

function sanitizeScannedPages(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((page) => Number(page))
    .filter((page) => Number.isInteger(page) && page > 0)))
    .sort((left, right) => left - right);
}

export function loadResourceIndex(key: string): ResourceIndexSnapshot | null {
  if (!key.trim() || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ResourceIndexEnvelope>;
    if (parsed.version !== CACHE_VERSION) return null;
    return trimPages({
      images: sanitizeImages(parsed.images),
      links: sanitizeLinks(parsed.links),
      scannedPages: sanitizeScannedPages(parsed.scannedPages),
    });
  } catch {
    return null;
  }
}

export function saveResourceIndex(key: string, snapshot: ResourceIndexSnapshot): void {
  if (!key.trim() || typeof window === "undefined") return;
  const value: ResourceIndexEnvelope = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    ...trimPages(snapshot),
  };
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_CACHE_BYTES) return;
    window.localStorage.setItem(cacheKey(key), serialized);
  } catch {
    // The current session remains usable when localStorage is unavailable or full.
  }
}
