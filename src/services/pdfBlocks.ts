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

export interface PdfTextHighlightRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Converts PDF.js word rectangles into compact hover rectangles. Keeping the
 * geometry independent from the DOM makes the two-column and line-gap rules
 * testable without a browser runtime.
 */
export function groupPdfTextHighlightRects(rects: PdfTextHighlightRect[]): PdfTextHighlightRect[] {
  const spans = rects
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
    .sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: PdfTextHighlightRect[][] = [];
  for (const span of spans) {
    const previous = lines[lines.length - 1]?.[0];
    const tolerance = Math.max(3, (span.bottom - span.top) * 0.65);
    if (!previous || Math.abs(span.top - previous.top) > tolerance) lines.push([span]);
    else lines[lines.length - 1].push(span);
  }

  return lines.flatMap((line) => {
    const ordered = [...line].sort((left, right) => left.left - right.left);
    const segments: PdfTextHighlightRect[][] = [];
    for (const span of ordered) {
      const previous = segments[segments.length - 1]?.[segments[segments.length - 1].length - 1];
      const gap = previous ? span.left - previous.right : 0;
      const joinGap = Math.max(8, (span.bottom - span.top) * 1.5);
      if (!previous || gap > joinGap) segments.push([span]);
      else segments[segments.length - 1].push(span);
    }
    return segments.map((segment) => ({
      left: Math.min(...segment.map((item) => item.left)),
      top: Math.min(...segment.map((item) => item.top)),
      right: Math.max(...segment.map((item) => item.right)),
      bottom: Math.max(...segment.map((item) => item.bottom)),
    }));
  });
}

function textFromSpan(span: HTMLElement) {
  return span.textContent?.replace(/\s+/g, " ").trim() || "";
}

function mergeRects(rects: DOMRect[], layerRect: DOMRect): ReaderAnnotationRect | undefined {
  if (rects.length === 0 || layerRect.width <= 0 || layerRect.height <= 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const padX = Math.min(6, layerRect.width * 0.006);
  const padY = Math.min(4, layerRect.height * 0.004);
  const paddedLeft = Math.max(layerRect.left, left - padX);
  const paddedTop = Math.max(layerRect.top, top - padY);
  const paddedRight = Math.min(layerRect.right, right + padX);
  const paddedBottom = Math.min(layerRect.bottom, bottom + padY);
  return {
    x: Math.max(0, (paddedLeft - layerRect.left) / layerRect.width),
    y: Math.max(0, (paddedTop - layerRect.top) / layerRect.height),
    width: Math.min(1, (paddedRight - paddedLeft) / layerRect.width),
    height: Math.min(1, (paddedBottom - paddedTop) / layerRect.height),
  };
}

function splitLineIntoColumns(line: DomTextSpan[]): DomTextSpan[][] {
  if (line.length <= 1) return [line];
  const sorted = [...line].sort((left, right) => left.rect.left - right.rect.left);
  const medianHeight = [...sorted].sort((left, right) => left.rect.height - right.rect.height)[Math.floor(sorted.length / 2)]?.rect.height ?? 12;
  const segments: DomTextSpan[][] = [];
  let current: DomTextSpan[] = [];
  for (const span of sorted) {
    const previous = current[current.length - 1];
    const gap = previous ? span.rect.left - previous.rect.right : 0;
    // Text-layer coordinates scale with the rendered page. A fixed 36px
    // threshold merges narrow double columns at small zoom levels.
    const splitGap = Math.max(18, medianHeight * 2.4);
    if (previous && gap > splitGap) {
      segments.push(current);
      current = [span];
    } else {
      current.push(span);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
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

  const lineSegments = lines.flatMap(splitLineIntoColumns).sort((left, right) => {
    const leftColumn = Math.floor(Math.min(...left.map((span) => span.rect.left)) / Math.max(1, layerRect.width * 0.28));
    const rightColumn = Math.floor(Math.min(...right.map((span) => span.rect.left)) / Math.max(1, layerRect.width * 0.28));
    if (leftColumn !== rightColumn) return leftColumn - rightColumn;
    const leftTop = Math.min(...left.map((span) => span.rect.top));
    const rightTop = Math.min(...right.map((span) => span.rect.top));
    if (Math.abs(leftTop - rightTop) > 4) return leftTop - rightTop;
    return Math.min(...left.map((span) => span.rect.left)) - Math.min(...right.map((span) => span.rect.left));
  });

  const blocks: DomTextSpan[][] = [];
  for (const line of lineSegments) {
    const previous = blocks[blocks.length - 1];
    const previousBottom = previous ? Math.max(...previous.map((span) => span.rect.bottom)) : 0;
    const lineTop = Math.min(...line.map((span) => span.rect.top));
    const lineLeft = Math.min(...line.map((span) => span.rect.left));
    const lineRight = Math.max(...line.map((span) => span.rect.right));
    const gap = lineTop - previousBottom;
    const lineHeight = Math.max(...line.map((span) => span.rect.height));
    const previousLeft = previous ? Math.min(...previous.map((span) => span.rect.left)) : 0;
    const previousRight = previous ? Math.max(...previous.map((span) => span.rect.right)) : 0;
    const overlapsPreviousColumn = !previous || Math.min(lineRight, previousRight) - Math.max(lineLeft, previousLeft) > Math.min(lineRight - lineLeft, previousRight - previousLeft) * 0.36;
    const indentationDelta = lineLeft - previousLeft;
    // A fixed pixel indentation threshold breaks at different zoom levels
    // and mistakes wrapped lines for new paragraphs. Treat indentation as a
    // paragraph break only when the vertical gap also indicates separation.
    const startsIndentedParagraph = indentationDelta > lineHeight * 2.5 && gap > lineHeight * 0.75;
    const startsNewParagraph =
      !previous ||
      !overlapsPreviousColumn ||
      gap > lineHeight * 1.45 ||
      startsIndentedParagraph;
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
