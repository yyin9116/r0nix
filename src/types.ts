export type TabType = "library" | "pdf" | "markdown" | "web" | "settings";

export type LibraryCollectionFilter = `collection:${string}`;
export type LibraryFilter =
  | "all"
  | "recent"
  | "favorites"
  | "quick-access"
  | "whiteboards"
  | "trash"
  | LibraryCollectionFilter;

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  url?: string;
  filePath?: string;
  fileId?: string;
  content?: string;
  /** Persisted Markdown draft state. */
  contentDirty?: boolean;
  contentBase?: string;
  filter?: LibraryFilter;
  pinned?: boolean;
  pdfViewState?: PdfViewState;
}

export interface PdfViewState {
  page: number;
  totalPages: number;
  zoom: number;
  scrollTop: number;
  scrollLeft: number;
  /** One-shot source focus used when opening a saved citation. */
  focusRect?: ReaderAnnotationRect;
  updatedAt: string;
}

export type ReaderDocumentKind = "pdf" | "markdown";

export interface ReaderDocument {
  id: string;
  title: string;
  path: string;
  kind?: ReaderDocumentKind;
  authors: string[];
  year: number;
  journal: string;
  tags: string[];
  isFavorite: boolean;
  progress: number;
  pageCount: number;
  /** Byte size of the source when available; used to invalidate derived caches. */
  fileSize?: number;
  /** Stable import timestamp; unlike lastOpenedAt this does not change while reading. */
  addedAt?: string;
  lastOpenedAt: string;
  trashedAt?: string;
  fileId?: string;
}

export interface ReaderCollection {
  id: string;
  name: string;
  paths: string[];
  createdAt: string;
}

export type ReaderNoteKind = "note" | "summary" | "highlight";

export interface ReaderNote {
  id: string;
  documentId?: string;
  blockId?: string;
  page: number;
  kind: ReaderNoteKind;
  content: string;
  reference?: string;
  sourceRect?: ReaderAnnotationRect;
  createdAt: string;
}

/**
 * `wavy` 是 **AI-only** 的标注：它表示「AI 判断这里可能难懂，可在此唤出伴读」。
 * 它刻意**不在 `ToolType` 里** —— 用户不能手动画波浪线，否则「形状承载语义」这条
 * 就退化成「比谁手快」。见 docs/design-system.md §11.8。
 *
 * ⚠️ 波浪线在 Word / 浏览器里的通用含义是「这里有问题」，不是「这里难懂」。
 * 消歧**只能靠「波浪线旁必有伴读锚点」**，所以锚点不是装饰，是语义的一部分。
 */
export type ReaderAnnotationKind = "highlight" | "underline" | "strike" | "text" | "wavy";

export interface ReaderAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReaderAnnotation {
  id: string;
  documentId?: string;
  blockId?: string;
  page: number;
  kind: ReaderAnnotationKind;
  rect: ReaderAnnotationRect;
  content?: string;
  createdAt: string;
  /**
   * `"ai"` = 由自动标注写入；缺省视为 `"manual"`。
   * 缺省即 manual 是有意的：老用户机器上已有的标注没有这个字段，
   * 把它们一律当成人工标注，才能让「被删掉的不重生」从第一天就成立。
   */
  origin?: "manual" | "ai";
}

export type PdfReadingBlockKind =
  | "text"
  | "title"
  | "list"
  | "table"
  | "image"
  | "equation"
  | "code"
  | "quote"
  | "auxiliary";

export interface PdfReadingBlock {
  id: string;
  documentId?: string;
  page: number;
  kind: PdfReadingBlockKind;
  text: string;
  rect?: ReaderAnnotationRect;
  source: "mineru" | "pdfjs-dom" | "pymupdf" | "markdown";
  sourcePath?: string;
  depth?: number;
  ordered?: boolean;
  language?: string;
  assetUrl?: string;
  altText?: string;
  tableAlign?: Array<"left" | "center" | "right">;
}
