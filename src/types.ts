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
  /**
   * 模型自报的「为什么在这里出现」。伴读批注卡的右上角 chip 用它 ——
   * 主动行为不自报理由就会被读成噪音。旧数据没有这个字段：卡片的
   * title 直接缺省即可，不为它写兜底文案。
   */
  reason?: string;
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
  /**
   * 行级矩形，按阅读顺序排列。
   *
   * **为什么需要它**：`rect` 是整块的并集框。学术论文常见「整栏一块」的版面，
   * 一个 block 横跨 5–10 个自然段；此时 `rect` 既不能用来切段落，
   * 也不能用来定位标注——波浪线贴在并集框底部，看起来就「跑到整段下面去了」
   * （2026-10-07 实测）。行级 bbox 来自 pymupdf `get_text("dict")` 的 `lines[].bbox`，
   * 是解析器给出的几何，不是我们猜的。
   *
   * 缺省时消费方必须退回 `rect`，不能当成空数组——老数据与 markdown 来源没有它。
   */
  lines?: PdfReadingLine[];
  source: "mineru" | "pdfjs-dom" | "pymupdf" | "markdown";
  sourcePath?: string;
  depth?: number;
  ordered?: boolean;
  language?: string;
  assetUrl?: string;
  altText?: string;
  tableAlign?: Array<"left" | "center" | "right">;
}

/** 单行文本的几何。坐标与所属块的 `rect` 同一套归一化坐标系。 */
export interface PdfReadingLine {
  /** 行内文本，段内换行以 `\n` 分隔（不再压平成空格）。 */
  text: string;
  rect: ReaderAnnotationRect;
}
