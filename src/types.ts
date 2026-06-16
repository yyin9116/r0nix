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
  page: number;
  kind: ReaderNoteKind;
  content: string;
  createdAt: string;
}

export type ReaderAnnotationKind = "highlight" | "underline" | "strike" | "text";

export interface ReaderAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReaderAnnotation {
  id: string;
  page: number;
  kind: ReaderAnnotationKind;
  rect: ReaderAnnotationRect;
  content?: string;
  createdAt: string;
}

export type PdfReadingBlockKind =
  | "text"
  | "title"
  | "list"
  | "table"
  | "image"
  | "equation"
  | "code"
  | "auxiliary";

export interface PdfReadingBlock {
  id: string;
  page: number;
  kind: PdfReadingBlockKind;
  text: string;
  rect?: ReaderAnnotationRect;
  source: "mineru" | "pdfjs-dom";
}
