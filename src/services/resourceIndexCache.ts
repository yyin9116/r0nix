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
  pageSizes: Record<number, { width: number; height: number }>;
  scannedPages: number[];
  textByPage: Record<number, string>;
};

type ResourceIndexEnvelope = ResourceIndexSnapshot & {
  version: 5;
  updatedAt: string;
};

const CACHE_PREFIX = "r0nix:resource-index:";
const CACHE_VERSION = 5 as const;
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
        const xref = Number(item.xref);
        const width = Number(item.width);
        const height = Number(item.height);
        const pageWidth = item.pageWidth === undefined ? undefined : Number(item.pageWidth);
        const pageHeight = item.pageHeight === undefined ? undefined : Number(item.pageHeight);
        const extension = typeof item.extension === "string" ? item.extension.trim() : "";
        const source = item.source;
        const bbox = Array.isArray(item.bbox) && item.bbox.length === 4
          ? item.bbox.map((part) => Number(part)) as [number, number, number, number]
          : undefined;

        if (
          !Number.isInteger(xref) || xref < 0 ||
          (source !== "xref" && source !== "block" && source !== "vector") ||
          (source === "xref" && xref < 1) ||
          !Number.isFinite(width) || width <= 0 ||
          !Number.isFinite(height) || height <= 0 ||
          extension.length === 0 ||
          !bbox || !bbox.every(Number.isFinite) ||
          (pageWidth !== undefined && (!Number.isFinite(pageWidth) || pageWidth <= 0)) ||
          (pageHeight !== undefined && (!Number.isFinite(pageHeight) || pageHeight <= 0))
        ) {
          return null;
        }

        return {
          xref,
          resourceId: typeof item.resourceId === "string" ? item.resourceId : undefined,
          documentId: typeof item.documentId === "string" ? item.documentId : undefined,
          pageNumber: page,
          width,
          height,
          pageWidth,
          pageHeight,
          extension,
          bbox,
          source,
        };
      })
      .filter((item): item is PDFImageInfo => item !== null);
    // Keep an empty array: it distinguishes a scanned page with no images
    // from a page that has not been indexed yet.
    result[page] = items;
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
    // Keep an empty array so a scanned page with no links is not rescanned.
    result[page] = items;
  }
  return result;
}

function trimPages(snapshot: ResourceIndexSnapshot): ResourceIndexSnapshot {
  const pages = Array.from(new Set([
    ...Object.keys(snapshot.images).map(Number),
    ...Object.keys(snapshot.links).map(Number),
    ...Object.keys(snapshot.pageSizes).map(Number),
    ...snapshot.scannedPages,
    ...Object.keys(snapshot.textByPage).map(Number),
  ])).filter((page) => Number.isInteger(page) && page > 0).sort((a, b) => a - b);
  const keep = new Set(pages.slice(-MAX_CACHED_PAGES));
  return {
    images: Object.fromEntries(Object.entries(snapshot.images).filter(([page]) => keep.has(Number(page)))),
    links: Object.fromEntries(Object.entries(snapshot.links).filter(([page]) => keep.has(Number(page)))),
    pageSizes: Object.fromEntries(Object.entries(snapshot.pageSizes).filter(([page]) => keep.has(Number(page)))),
    scannedPages: pages.filter((page) => keep.has(page)),
    textByPage: Object.fromEntries(Object.entries(snapshot.textByPage).filter(([page]) => keep.has(Number(page)))),
  };
}

function sanitizeScannedPages(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((page) => Number(page))
    .filter((page) => Number.isInteger(page) && page > 0)))
    .sort((left, right) => left - right);
}

function sanitizePageSizes(value: unknown): Record<number, { width: number; height: number }> {
  if (!value || typeof value !== "object") return {};
  const result: Record<number, { width: number; height: number }> = {};
  for (const [pageKey, rawSize] of Object.entries(value)) {
    const page = Number(pageKey);
    if (!Number.isInteger(page) || page < 1 || !rawSize || typeof rawSize !== "object") continue;
    const size = rawSize as Record<string, unknown>;
    const width = finiteNumber(size.width);
    const height = finiteNumber(size.height);
    if (width <= 0 || height <= 0) continue;
    result[page] = { width: Math.min(width, 20_000), height: Math.min(height, 20_000) };
  }
  return result;
}

function sanitizeTextByPage(value: unknown): Record<number, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<number, string> = {};
  for (const [pageKey, rawText] of Object.entries(value)) {
    const page = Number(pageKey);
    if (!Number.isInteger(page) || page < 1 || typeof rawText !== "string") continue;
    result[page] = rawText.slice(0, 200_000);
  }
  return result;
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
      pageSizes: sanitizePageSizes(parsed.pageSizes),
      scannedPages: sanitizeScannedPages(parsed.scannedPages),
      textByPage: sanitizeTextByPage(parsed.textByPage),
    });
  } catch {
    // Storage can be unavailable in restricted WebView/private contexts.
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
