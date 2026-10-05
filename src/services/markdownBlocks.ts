import { marked } from "marked";
import type { PdfReadingBlock, PdfReadingBlockKind } from "../types";

type LexedToken = Record<string, unknown>;
type LexedDocument = LexedToken[] & {
  links?: Record<string, { href?: unknown; title?: unknown }>;
};

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function tokenText(token: LexedToken) {
  return typeof token.text === "string" ? token.text : typeof token.raw === "string" ? token.raw : "";
}

function asTokens(value: unknown): LexedToken[] {
  return Array.isArray(value)
    ? value.filter((item): item is LexedToken => Boolean(item) && typeof item === "object")
    : [];
}

function tableRowsText(token: LexedToken) {
  const header = asTokens(token.header).map(tokenText);
  const rows = asTokens(token.rows).map((row) => asTokens(row).map(tokenText));
  return [header, ...rows].map((row) => row.join(" | ")).join("\n");
}

function normalizeTableAlign(value: unknown): Array<"left" | "center" | "right"> {
  return Array.isArray(value)
    ? value.map((item) => item === "center" ? "center" : item === "right" ? "right" : "left")
    : [];
}

export function parseMarkdownBlocks(markdown: string, documentId: string): PdfReadingBlock[] {
  const blocks: PdfReadingBlock[] = [];
  const occurrences = new Map<string, number>();
  const add = (kind: PdfReadingBlockKind, text: string, sourcePath: string, options?: Pick<PdfReadingBlock, "depth" | "ordered" | "language" | "assetUrl" | "altText" | "tableAlign">) => {
    const normalized = kind === "code" ? text.replace(/\s+$/, "") : normalizeText(text);
    if (!normalized) return;
    const identity = `${kind}:${normalized}`;
    const occurrence = (occurrences.get(identity) || 0) + 1;
    occurrences.set(identity, occurrence);
    blocks.push({
      id: `md-${hashText(`${identity}:${occurrence}`)}`,
      documentId,
      page: 1,
      kind,
      text: normalized,
      source: "markdown",
      sourcePath,
      ...options,
    });
  };

  const visitList = (token: LexedToken, sourcePath: string, depth: number, ordered: boolean) => {
    for (const [index, item] of asTokens(token.items).entries()) {
      const itemText = asTokens(item.tokens)
        .filter((child) => child.type !== "list")
        .map(tokenText)
        .join(" ") || (typeof item.text === "string" ? item.text : "");
      add("list", itemText, `${sourcePath}/item:${index}`, { depth, ordered });
      for (const child of asTokens(item.tokens)) {
        if (child.type === "list") visitList(child, `${sourcePath}/item:${index}`, depth + 1, child.ordered === true);
      }
    }
  };

  let tokens: LexedDocument;
  try {
    tokens = marked.lexer(markdown) as unknown as LexedDocument;
  } catch (error) {
    throw new Error(`Markdown parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  tokens.forEach((token, index) => {
    const sourcePath = `token:${index}`;
    switch (token.type) {
      case "heading":
        add("title", tokenText(token), sourcePath, { depth: typeof token.depth === "number" ? token.depth : 1 });
        break;
      case "code":
        add("code", typeof token.text === "string" ? token.text : "", sourcePath, {
          language: typeof token.lang === "string" && token.lang.trim() ? token.lang.trim() : undefined,
        });
        break;
      case "blockquote":
        add("quote", tokenText(token), sourcePath);
        break;
      case "table":
        add("table", tableRowsText(token), sourcePath, { tableAlign: normalizeTableAlign(token.align) });
        break;
      case "list":
        for (const [index, item] of asTokens(token.items).entries()) {
          const itemText = asTokens(item.tokens)
            .filter((child) => child.type !== "list")
            .map(tokenText)
            .join(" ") || (typeof item.text === "string" ? item.text : "");
          add("list", itemText, `${sourcePath}/item:${index}`, {
            depth: 0,
            ordered: token.ordered === true,
          });
          for (const child of asTokens(item.tokens)) {
            if (child.type === "list") visitList(child, `${sourcePath}/item:${index}`, 1, child.ordered === true);
          }
        }
        break;
      case "paragraph":
      case "text":
        {
          const inline = asTokens(token.tokens);
          const image = inline.length === 1 && inline[0]?.type === "image" && typeof inline[0].href === "string"
            ? inline[0]
            : null;
          if (image) {
            add("image", typeof token.raw === "string" ? token.raw : tokenText(token), sourcePath, {
              assetUrl: image.href as string,
              altText: typeof image.text === "string" ? image.text : "",
            });
            break;
          }
          const value = tokenText(token);
          const equation = /^\${2,3}\s*\n([\s\S]*?)\n\${2,3}\s*$/.exec(value);
          add(equation ? "equation" : "text", equation ? equation[1] : value, sourcePath);
        }
        break;
      case "html":
        // Keep raw HTML as non-executable text; document content must not become arbitrary DOM.
        add("text", tokenText(token), sourcePath);
        break;
      case "hr":
      case "space":
      case "def":
        break;
      default:
        if (typeof token.text === "string") add("text", token.text, sourcePath);
        break;
    }
  });

  // marked stores reference definitions outside the token list. Recover footnotes
  // as auxiliary blocks so translation and reading assist do not silently lose them.
  for (const [label, definition] of Object.entries(tokens.links || {})) {
    if (!label.startsWith("^")) continue;
    const value = typeof definition?.href === "string" ? definition.href.trim() : "";
    if (!value) continue;
    add("auxiliary", `[${label.slice(1)}] ${value}`, `definition:${label}`);
  }
  return blocks;
}
