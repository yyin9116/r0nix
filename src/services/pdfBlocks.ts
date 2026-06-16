import type { PdfReadingBlock, PdfReadingBlockKind, ReaderAnnotationRect } from "../types";

type MinerUBlock = {
  type?: unknown;
  page_idx?: unknown;
  page?: unknown;
  bbox?: unknown;
  text?: unknown;
  content?: unknown;
  text_level?: unknown;
  table_body?: unknown;
  table_caption?: unknown;
  img_caption?: unknown;
  equation?: unknown;
  code_body?: unknown;
};

const AUXILIARY_TYPES = new Set(["header", "footer", "page_number", "aside_text", "page_footnote"]);

function normalizeMinerUKind(type: unknown, textLevel: unknown): PdfReadingBlockKind {
  const raw = typeof type === "string" ? type : "text";
  if (raw === "text" && typeof textLevel === "number" && textLevel > 0) return "title";
  if (raw === "table") return "table";
  if (raw === "image" || raw === "chart") return "image";
  if (raw === "equation") return "equation";
  if (raw === "code") return "code";
  if (raw === "list") return "list";
  if (AUXILIARY_TYPES.has(raw)) return "auxiliary";
  return "text";
}

function joinTextParts(parts: unknown[]) {
  return parts
    .flatMap((part) => (Array.isArray(part) ? part : [part]))
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function normalizeMinerUBbox(raw: unknown): ReaderAnnotationRect | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const values = raw.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  const [x0, y0, x1, y1] = values;
  const left = Math.max(0, Math.min(x0, x1) / 1000);
  const top = Math.max(0, Math.min(y0, y1) / 1000);
  const right = Math.min(1, Math.max(x0, x1) / 1000);
  const bottom = Math.min(1, Math.max(y0, y1) / 1000);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function parseMinerUContentList(raw: unknown): PdfReadingBlock[] {
  const blocks = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { content_list?: unknown }).content_list)
      ? (raw as { content_list: unknown[] }).content_list
      : [];

  return blocks
    .map((item, index): PdfReadingBlock | null => {
      if (!item || typeof item !== "object") return null;
      const block = item as MinerUBlock;
      const pageRaw = typeof block.page_idx === "number" ? block.page_idx + 1 : block.page;
      const page = Math.max(1, Math.round(Number(pageRaw) || 1));
      const kind = normalizeMinerUKind(block.type, block.text_level);
      const text = joinTextParts([
        block.text,
        block.content,
        block.table_caption,
        block.table_body,
        block.img_caption,
        block.equation,
        block.code_body,
      ]);
      if (!text && kind !== "image") return null;
      return {
        id: `mineru-${page}-${index}`,
        page,
        kind,
        text,
        rect: normalizeMinerUBbox(block.bbox),
        source: "mineru",
      };
    })
    .filter((item): item is PdfReadingBlock => Boolean(item));
}

type DomTextSpan = {
  text: string;
  rect: DOMRect;
};

function textFromSpan(span: HTMLElement) {
  return span.textContent?.replace(/\s+/g, " ").trim() || "";
}

function mergeRects(rects: DOMRect[], layerRect: DOMRect): ReaderAnnotationRect | undefined {
  if (rects.length === 0 || layerRect.width <= 0 || layerRect.height <= 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return {
    x: Math.max(0, (left - layerRect.left) / layerRect.width),
    y: Math.max(0, (top - layerRect.top) / layerRect.height),
    width: Math.min(1, (right - left) / layerRect.width),
    height: Math.min(1, (bottom - top) / layerRect.height),
  };
}

export function buildDomPdfReadingBlocks(layer: HTMLElement, pageNo: number): PdfReadingBlock[] {
  const spans: DomTextSpan[] = Array.from(layer.querySelectorAll("span"))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => ({ text: textFromSpan(node), rect: node.getBoundingClientRect() }))
    .filter((span) => span.text && span.rect.width > 0 && span.rect.height > 0)
    .sort((left, right) =>
      Math.abs(left.rect.top - right.rect.top) > 4 ? left.rect.top - right.rect.top : left.rect.left - right.rect.left
    );

  if (spans.length === 0) return [];

  const layerRect = layer.getBoundingClientRect();
  const lines: DomTextSpan[][] = [];
  for (const span of spans) {
    const last = lines[lines.length - 1];
    const lastTop = last?.[0]?.rect.top ?? Number.NEGATIVE_INFINITY;
    if (!last || Math.abs(span.rect.top - lastTop) > Math.max(5, span.rect.height * 0.65)) {
      lines.push([span]);
    } else {
      last.push(span);
    }
  }

  const blocks: DomTextSpan[][] = [];
  for (const line of lines) {
    const previous = blocks[blocks.length - 1];
    const previousLine = previous?.slice(-line.length) ?? [];
    const previousBottom = previous ? Math.max(...previous.map((span) => span.rect.bottom)) : 0;
    const lineTop = Math.min(...line.map((span) => span.rect.top));
    const gap = lineTop - previousBottom;
    const lineHeight = Math.max(...line.map((span) => span.rect.height));
    const startsNewParagraph = !previous || gap > lineHeight * 1.25 || Math.min(...line.map((span) => span.rect.left)) > Math.min(...previousLine.map((span) => span.rect.left)) + 80;
    if (startsNewParagraph) {
      blocks.push([...line]);
    } else {
      previous.push(...line);
    }
  }

  return blocks
    .map((block, index) => ({
      id: `pdfjs-dom-${pageNo}-${index}`,
      page: pageNo,
      kind: "text" as const,
      text: block.map((span) => span.text).join(" ").replace(/\s+([,.;:!?，。；：！？])/g, "$1").trim(),
      rect: mergeRects(block.map((span) => span.rect), layerRect),
      source: "pdfjs-dom" as const,
    }))
    .filter((block) => block.text.length > 0);
}
