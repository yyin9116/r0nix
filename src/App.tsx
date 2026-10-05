import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AnimatePresence, motion } from "motion/react";
import { Sidebar } from "./components/Sidebar";
import { Tabs } from "./components/Tabs";
import { Library, LIBRARY_SEARCH_FOCUS_EVENT } from "./components/Library";
const PDFViewer = lazy(() => import("./components/PDFViewer").then((module) => ({ default: module.PDFViewer })));
const MarkdownViewer = lazy(() => import("./components/MarkdownViewer").then((module) => ({ default: module.MarkdownViewer })));
const Whiteboards = lazy(() => import("./components/Whiteboards").then((module) => ({ default: module.Whiteboards })));
const WebBrowser = lazy(() => import("./components/WebBrowser").then((module) => ({ default: module.WebBrowser })));
const Settings = lazy(() => import("./components/Settings").then((module) => ({ default: module.Settings })));
import type { LibraryFilter, PdfViewState, ReaderAnnotation, ReaderAnnotationRect, ReaderCollection, ReaderDocument, ReaderNote, Tab } from "./types";
import * as api from "./services/pdfApi";
import {
  loadUserSettings,
  sanitizeUserSettings,
  saveUserSettings,
  withDefaultDir,
  type AppLanguage,
  type UserSettings,
} from "./services/userSettings";
import { canUseNativeWebview, closeNativeWebviewTab, hideNativeWebviewTab, showNativeWebviewTab } from "./services/nativeWebview";
import {
  collectNativeImportablePaths,
  writeNativeBinaryFile,
  writeNativeTempFile,
  writeNativeTextFile,
} from "./services/nativeFiles";
import { normalizeHttpUrl, normalizeWebUrl } from "./services/urlPolicy";
import {
  PERSISTENCE_WARNING_EVENT,
  consumePersistenceWarnings,
  readVersionedLocalState,
  writeVersionedLocalState,
  type PersistenceWarning,
} from "./services/localStore";
import { loadStoredAnnotations, saveStoredAnnotations } from "./services/readerAnnotations";
import { dismissCompanionBlock, dismissalForRemovedAnnotation, loadDismissedBlocks } from "./services/readingCompanion";
import { debugWarn } from "./services/debugLogger";
import { resolveAccentToken } from "./theme/accent";
import type { LlmServiceConfig } from "./services/readingAssistant";
import { START_PAGE_URL } from "./constants/startPage";
import { downloadDirectHttpResource, downloadPdfToNativeTemp, downloadPdfViaProxy, removeManagedWebPdfTemp, DIRECT_PDF_MAX_BYTES } from "./services/webProxy";
import { documentIdForPath, documentPathKey, migrateDocumentArtifacts } from "./services/documentArtifacts";

const DOCUMENTS_KEY = "r0nix_reader_documents_v2";
const COLLECTIONS_KEY = "r0nix_reader_collections_v1";
const NOTES_KEY = "r0nix_reader_notes_v1";
const TABS_KEY = "r0nix_reader_tabs_v1";
const DOCUMENTS_STATE_VERSION = 2;
const COLLECTIONS_STATE_VERSION = 1;
const NOTES_STATE_VERSION = 1;
const TABS_STATE_VERSION = 2;
const PINNED_TABS: Tab[] = [
  { id: "library-main", type: "library", title: "Library", filter: "all", pinned: true },
];
const DEFAULT_ACTIVE_TAB_ID = "library-main";

function isEphemeralWebPdfPath(path?: string): boolean {
  if (!path) return false;
  const fileName = path.split(/[\\/]/).pop() || "";
  return /^(?:r0nix-web|r0nix-import)-[^\\/]+\.pdf$/i.test(fileName);
}

function cleanupManagedWebPdfTemp(path: string) {
  let attempts = 0;
  const attempt = () => {
    attempts += 1;
    void removeManagedWebPdfTemp(path).catch((error) => {
      if (attempts < 4) {
        window.setTimeout(attempt, 180);
        return;
      }
      debugWarn("webview.pdf", "failed to remove managed PDF temp after tab close", {
        path,
        error,
      });
    });
  };
  // Let the React tab removal and deferred PDF handle release commit first.
  window.setTimeout(attempt, 180);
}

const APP_I18N = {
  "zh-CN": {
    libraryTab: "\u8d44\u6599\u5e93",
    collectionTab: "\u96c6\u5408",
    settingsTab: "\u8bbe\u7f6e",
    webNewTab: "\u65b0\u5efa\u6807\u7b7e",
    collectionPrompt: "\u96c6\u5408\u540d\u79f0",
    collectionExists: "\u96c6\u5408\u5df2\u5b58\u5728",
    tabClose: "\u5173\u95ed\u6807\u7b7e",
    pinnedCannotClose: "\u5df2\u56fa\u5b9a\u6807\u7b7e\uff08\u65e0\u6cd5\u5173\u95ed\uff09",
    unsavedMarkdownClose: "\u6b64 Markdown \u5305\u542b\u672a\u4fdd\u5b58\u4fee\u6539\uff0c\u786e\u5b9a\u5173\u95ed\u6807\u7b7e\u5417\uff1f",
  },
  "en-US": {
    libraryTab: "Library",
    collectionTab: "Collection",
    settingsTab: "Settings",
    webNewTab: "New Tab",
    collectionPrompt: "Collection name",
    collectionExists: "Collection already exists",
    tabClose: "Close tab",
    pinnedCannotClose: "Pinned tab (cannot close)",
    unsavedMarkdownClose: "This Markdown tab has unsaved changes. Close it anyway?",
  },
} as const;

function getUiText(language: AppLanguage) {
  return APP_I18N[language];
}

function samePath(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeUrl(raw: string) {
  return normalizeWebUrl(raw);
}

function resolveTheme(mode: UserSettings["themeMode"]) {
  if (mode === "light") return "light" as const;
  if (mode === "dark") return "dark" as const;
  if (typeof window === "undefined") return "light" as const;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? ("dark" as const) : ("light" as const);
}

function fileNameFromPath(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function baseTitleFromPath(path: string) {
  return fileNameFromPath(path).replace(/\.(pdf|md|markdown)$/i, "");
}

function isMarkdownPath(path: string) {
  const lowered = path.trim().toLowerCase();
  return lowered.endsWith(".md") || lowered.endsWith(".markdown");
}

function isSupportedDropPath(path: string) {
  const lowered = path.trim().toLowerCase();
  return lowered.endsWith(".pdf") || lowered.endsWith(".md") || lowered.endsWith(".markdown");
}

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

function makeDocumentId(path: string) {
  return `doc-${path.trim().toLowerCase()}`;
}

function createDocumentId() {
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function documentTabKey(tab: Tab) {
  if ((tab.type !== "pdf" && tab.type !== "markdown") || !tab.filePath) return "";
  return `${tab.type}:${tab.filePath.trim().toLowerCase()}`;
}

function choosePdfViewState(left?: Tab["pdfViewState"], right?: Tab["pdfViewState"]) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left.updatedAt || "");
  const rightTime = Date.parse(right.updatedAt || "");
  return Number.isFinite(rightTime) && rightTime > (Number.isFinite(leftTime) ? leftTime : 0) ? right : left;
}

function sanitizePdfViewState(raw: unknown): PdfViewState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const finite = (input: unknown, fallback: number) => {
    const number = Number(input);
    return Number.isFinite(number) ? number : fallback;
  };
  const totalPages = Math.max(1, Math.round(finite(value.totalPages, 1)));
  const page = Math.max(1, Math.min(totalPages, Math.round(finite(value.page, 1))));
  const zoom = Math.max(50, Math.min(400, finite(value.zoom, 100)));
  const scrollTop = Math.max(0, finite(value.scrollTop, 0));
  const scrollLeft = Math.max(0, finite(value.scrollLeft, 0));
  const focusCandidate = value.focusRect;
  const focusRect = focusCandidate && typeof focusCandidate === "object"
    ? (() => {
        const rect = focusCandidate as Record<string, unknown>;
        const x = finite(rect.x, -1);
        const y = finite(rect.y, -1);
        const width = finite(rect.width, -1);
        const height = finite(rect.height, -1);
        const safeX = Math.max(0, Math.min(1, x));
        const safeY = Math.max(0, Math.min(1, y));
        return x >= 0 && y >= 0 && width > 0 && height > 0 && safeX < 1 && safeY < 1
          ? {
              x: safeX,
              y: safeY,
              width: Math.min(1 - safeX, width),
              height: Math.min(1 - safeY, height),
            }
          : undefined;
      })()
    : undefined;
  const updatedAt = typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    ? value.updatedAt
    : new Date(0).toISOString();
  return { page, totalPages, zoom, scrollTop, scrollLeft, focusRect, updatedAt };
}

function mergeDuplicateDocumentTabs(tabs: Tab[], activeTabId: string) {
  const documentIndexByKey = new Map<string, number>();
  const merged: Tab[] = [];
  let activeReplacementId = "";

  for (const tab of tabs) {
    const key = documentTabKey(tab);
    if (!key) {
      merged.push(tab);
      continue;
    }

    const existingIndex = documentIndexByKey.get(key);
    if (existingIndex === undefined) {
      documentIndexByKey.set(key, merged.length);
      merged.push(tab);
      continue;
    }

    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      title: existing.title || tab.title,
      fileId: existing.fileId || tab.fileId,
      content: existing.content || tab.content,
      contentDirty: Boolean(existing.contentDirty || tab.contentDirty),
      contentBase: existing.contentBase || tab.contentBase,
      pdfViewState: choosePdfViewState(existing.pdfViewState, tab.pdfViewState),
      pinned: Boolean(existing.pinned || tab.pinned),
    };
    if (tab.id === activeTabId) {
      activeReplacementId = existing.id;
    }
  }

  return {
    tabs: merged,
    activeTabId: merged.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : activeReplacementId && merged.some((tab) => tab.id === activeReplacementId)
        ? activeReplacementId
        : merged[0]?.id || DEFAULT_ACTIVE_TAB_ID,
    changed: merged.length !== tabs.length,
  };
}

function isDocumentTrashed(doc: Pick<ReaderDocument, "trashedAt">) {
  return typeof doc.trashedAt === "string" && doc.trashedAt.trim().length > 0;
}

function sanitizeExportTitle(value: string) {
  return (
    (value || "library-export")
      .replace(/[\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "library-export"
  );
}

function csvField(value: string | number | boolean | undefined) {
  const text = value == null ? "" : String(value);
  if (text.includes('"') || text.includes(',') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function documentsToCsv(docs: ReaderDocument[]) {
  const header = [
    "Title",
    "Path",
    "Authors",
    "Year",
    "Journal",
    "Tags",
    "Favorite",
    "Progress",
    "Page Count",
    "Last Opened At",
    "Trashed At",
  ];
  const rows = docs.map((doc) =>
    [
      csvField(doc.title),
      csvField(doc.path),
      csvField(doc.authors.join("; ")),
      csvField(doc.year || ""),
      csvField(doc.journal),
      csvField(doc.tags.join("; ")),
      csvField(doc.isFavorite),
      csvField(Math.round(doc.progress)),
      csvField(doc.pageCount),
      csvField(doc.lastOpenedAt),
      csvField(doc.trashedAt || ""),
    ].join(",")
  );
  return [header.join(","), ...rows].join("\n");
}
function loadStoredDocuments(): ReaderDocument[] {
  return readVersionedLocalState(DOCUMENTS_KEY, DOCUMENTS_STATE_VERSION, [], (raw) => {
    const parsed = raw as Array<Partial<ReaderDocument>>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => typeof item?.path === "string" && item.path.trim().length > 0)
      .map((item) => ({
        id: typeof item.id === "string" && item.id ? item.id : makeDocumentId(item.path as string),
        title: typeof item.title === "string" && item.title ? item.title : fileNameFromPath(item.path as string),
        path: item.path as string,
        authors: Array.isArray(item.authors) ? item.authors.filter((entry): entry is string => typeof entry === "string") : [],
        year: typeof item.year === "number" ? item.year : 0,
        journal: typeof item.journal === "string" ? item.journal : "",
        tags: Array.isArray(item.tags) ? item.tags.filter((entry): entry is string => typeof entry === "string") : [],
        isFavorite: Boolean(item.isFavorite),
        progress: typeof item.progress === "number" ? Math.max(0, Math.min(100, item.progress)) : 0,
        pageCount: typeof item.pageCount === "number" ? Math.max(1, Math.round(item.pageCount)) : 1,
        fileSize: typeof item.fileSize === "number" && item.fileSize > 0 ? Math.round(item.fileSize) : undefined,
        addedAt: typeof item.addedAt === "string" && item.addedAt ? item.addedAt : (typeof item.lastOpenedAt === "string" && item.lastOpenedAt ? item.lastOpenedAt : new Date().toISOString()),
        lastOpenedAt:
          typeof item.lastOpenedAt === "string" && item.lastOpenedAt
            ? item.lastOpenedAt
            : new Date().toISOString(),
        trashedAt: typeof item.trashedAt === "string" && item.trashedAt ? item.trashedAt : undefined,
      }))
      .sort((left, right) => new Date(right.lastOpenedAt).getTime() - new Date(left.lastOpenedAt).getTime());
  });
}

function loadStoredCollections(): ReaderCollection[] {
  return readVersionedLocalState(COLLECTIONS_KEY, COLLECTIONS_STATE_VERSION, [], (raw) => {
    const parsed = raw as Array<Partial<ReaderCollection>>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => typeof item?.id === "string" && typeof item?.name === "string")
      .map((item) => ({
        id: item.id as string,
        name: (item.name as string).trim() || "Collection",
        paths: Array.isArray(item.paths)
          ? item.paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
          : [],
        createdAt:
          typeof item.createdAt === "string" && item.createdAt
            ? item.createdAt
            : new Date().toISOString(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });
}

function loadStoredNotes(): Record<string, ReaderNote[]> {
  return readVersionedLocalState(NOTES_KEY, NOTES_STATE_VERSION, {}, (raw) => {
    const parsed = raw as Record<string, Array<Partial<ReaderNote>>>;
    const next: Record<string, ReaderNote[]> = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (!Array.isArray(value)) continue;
      next[key] = value
        .filter((item) => typeof item?.id === "string" && typeof item?.content === "string")
        .map((item): ReaderNote => ({
          id: item.id as string,
          documentId: typeof item.documentId === "string" && item.documentId ? item.documentId : undefined,
          blockId: typeof item.blockId === "string" && item.blockId ? item.blockId : undefined,
          page: typeof item.page === "number" ? Math.max(1, Math.round(item.page)) : 1,
          kind: item.kind === "summary" || item.kind === "highlight" ? item.kind : "note",
          content: item.content as string,
          reference: typeof item.reference === "string" && item.reference.trim() ? item.reference.trim() : undefined,
          sourceRect: item.sourceRect && typeof item.sourceRect === "object" ? item.sourceRect as ReaderNote["sourceRect"] : undefined,
          createdAt:
            typeof item.createdAt === "string" && item.createdAt ? item.createdAt : new Date().toISOString(),
        }))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    }
    return next;
  });
}

function sanitizeStoredTabs(raw: unknown): { tabs: Tab[]; activeTabId: string } {
  const parsed = raw && typeof raw === "object" ? (raw as { tabs?: unknown; activeTabId?: unknown }) : {};
  const rawTabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
  const restoredRaw = rawTabs
    .filter((item): item is Partial<Tab> => Boolean(item) && typeof item === "object")
    .map((item): Tab | null => {
      const type = item.type;
      const id = typeof item.id === "string" && item.id ? item.id : `${type || "tab"}-${Date.now()}`;
      const title = typeof item.title === "string" && item.title ? item.title : "Library";
      if (type === "library") {
        return {
          id,
          type,
          title,
          filter: typeof item.filter === "string" ? item.filter as LibraryFilter : "all",
          pinned: Boolean(item.pinned || id === DEFAULT_ACTIVE_TAB_ID),
        };
      }
      if (type === "web") {
        return { id, type, title, url: typeof item.url === "string" ? item.url : START_PAGE_URL, pinned: Boolean(item.pinned) };
      }
      if (type === "settings") {
        return { id, type, title, pinned: Boolean(item.pinned) };
      }
      if ((type === "pdf" || type === "markdown") && typeof item.filePath === "string" && item.filePath.trim()) {
        if (isEphemeralWebPdfPath(item.filePath)) return null;
        return {
          id,
          type,
          title,
          filePath: item.filePath,
          content: type === "markdown" && typeof item.content === "string" ? item.content : undefined,
          contentDirty: type === "markdown" ? Boolean(item.contentDirty) : undefined,
          contentBase: type === "markdown" && typeof item.contentBase === "string" ? item.contentBase : undefined,
          pdfViewState: type === "pdf" ? sanitizePdfViewState(item.pdfViewState) : undefined,
          pinned: Boolean(item.pinned),
        };
      }
      return null;
    })
    .filter((item): item is Tab => Boolean(item));

  const activeCandidate = typeof parsed.activeTabId === "string" ? parsed.activeTabId : DEFAULT_ACTIVE_TAB_ID;
  const merged = mergeDuplicateDocumentTabs(restoredRaw, activeCandidate);

  const hasMain = merged.tabs.some((tab) => tab.id === DEFAULT_ACTIVE_TAB_ID);
  const tabs = hasMain ? merged.tabs : [PINNED_TABS[0], ...merged.tabs];
  const activeTabId = tabs.some((tab) => tab.id === merged.activeTabId) ? merged.activeTabId : DEFAULT_ACTIVE_TAB_ID;
  return { tabs, activeTabId };
}

function loadStoredTabs(): { tabs: Tab[]; activeTabId: string } {
  return readVersionedLocalState(TABS_KEY, TABS_STATE_VERSION, { tabs: PINNED_TABS, activeTabId: DEFAULT_ACTIVE_TAB_ID }, sanitizeStoredTabs);
}

function guessPdfFileName(url: string, contentDisposition = "") {
  const cdMatch = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(contentDisposition);
  if (cdMatch?.[1]) {
    const cleaned = cdMatch[1].replace(/"/g, "").trim();
    try {
      const decoded = decodeURIComponent(cleaned);
      return decoded.toLowerCase().endsWith(".pdf") ? decoded : `${decoded}.pdf`;
    } catch {
      return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
    }
  }

  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").pop() || "document.pdf";
    return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
  } catch {
    const fallback = fileNameFromPath(url);
    return fallback.toLowerCase().endsWith(".pdf") ? fallback : `${fallback}.pdf`;
  }
}

function safePdfFileName(rawName: string) {
  const fallback = "document.pdf";
  const normalized = rawName
    .replace(/[\\/\0]/g, "-")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/\.\.+/g, ".")
    .trim();
  if (!normalized || normalized === "." || normalized === "..") return fallback;
  return normalized.toLowerCase().endsWith(".pdf") ? normalized : `${normalized}.pdf`;
}

function assertPdfPayload(bytes: ArrayBuffer, contentType = "") {
  const header = new TextDecoder().decode(new Uint8Array(bytes).subarray(0, 1024));
  const normalizedType = contentType.toLowerCase();
  if (!bytes.byteLength || !header.includes("%PDF-")) {
    if (normalizedType.includes("text/html") || /<!doctype html|<html[\s>]/i.test(header)) {
      throw new Error("服务器返回了网页而不是 PDF");
    }
    throw new Error("下载内容不是有效的 PDF");
  }
}

function shortHostSafe(url: string) {
  try {
    return new URL(normalizeUrl(url)).host;
  } catch {
    return url;
  }
}

export default function App() {
  const storedTabs = useMemo(loadStoredTabs, []);
  const [settings, setSettings] = useState<UserSettings>(() => loadUserSettings());
  const [theme, setTheme] = useState<"light" | "dark">(() => resolveTheme(loadUserSettings().themeMode));
  const [documents, setDocuments] = useState<ReaderDocument[]>(loadStoredDocuments);
  const [collections, setCollections] = useState<ReaderCollection[]>(loadStoredCollections);
  const [notesByDocument, setNotesByDocument] = useState<Record<string, ReaderNote[]>>(loadStoredNotes);
  const [annotationsByDocument, setAnnotationsByDocument] = useState<Record<string, ReaderAnnotation[]>>(loadStoredAnnotations);
  const [tabs, setTabs] = useState<Tab[]>(storedTabs.tabs);
  const [activeTabId, setActiveTabId] = useState(storedTabs.activeTabId);
  const [busyMessage, setBusyMessage] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [settingsFocusSection, setSettingsFocusSection] = useState<"quick-links" | null>(null);
  const [settingsFocusToken, setSettingsFocusToken] = useState(0);

  const busyTimerRef = useRef<number | null>(null);
  const tabsPersistTimerRef = useRef<number | null>(null);
  const latestTabsRef = useRef(tabs);
  const latestActiveTabIdRef = useRef(activeTabId);
  const pendingPdfReleasesRef = useRef<Map<string, string>>(new Map());
  const progressRef = useRef<Record<string, { page: number; totalPages: number }>>({});
  /**
   * 批注表的只读镜像，供 `removeAnnotation` 在**不把它列进依赖**的前提下查找被删的那条。
   * 不放进依赖是有意的：`removeAnnotation` 是传给子组件的回调，批注一变就重建会把它
   * 下游所有 memo 全部打穿。同步点设在下面那个保存 effect 里（批注变化时必然执行）。
   */
  const annotationsRef = useRef(annotationsByDocument);
  const webTabIdsRef = useRef<string[]>([]);
  const openingPdfUrlsRef = useRef(new Map<string, Promise<boolean>>());
  const openingPathsRef = useRef<Set<string>>(new Set());
  const cancelledOpeningPathsRef = useRef<Set<string>>(new Set());
  const pendingPdfNavigationRef = useRef<{ path: string; page: number; focusRect?: ReaderAnnotationRect } | null>(null);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [activeTabId, tabs]);
  const activeDocument = useMemo(
    () => activeTab?.filePath ? documents.find((document) => samePath(document.path, activeTab.filePath as string)) : undefined,
    [activeTab?.filePath, documents],
  );
  const activeFilter: LibraryFilter = activeTab?.type === "library" ? activeTab.filter || "all" : "all";
  const activePanelKey = activeTab ? `${activeTab.type}-${activeTab.id}` : "empty";
  const resolvedAccent = useMemo(() => resolveAccentToken(settings.themeAccent, theme), [settings.themeAccent, theme]);
  const uiText = useMemo(() => getUiText(settings.language), [settings.language]);
  const aiModelConfig = useMemo<LlmServiceConfig>(
    () => ({
      baseUrl: settings.aiModelPath,
      model: settings.aiModelName,
      apiKey: settings.aiApiKey,
      temperature: settings.aiTemperature,
      askSystemPrompt: settings.aiAskSystemPrompt,
      translationSystemPrompt: settings.aiTranslationSystemPrompt,
      translationTargetLanguage: settings.aiTranslationTargetLanguage,
    }),
    [
      settings.aiApiKey,
      settings.aiAskSystemPrompt,
      settings.aiModelName,
      settings.aiModelPath,
      settings.aiTemperature,
      settings.aiTranslationSystemPrompt,
      settings.aiTranslationTargetLanguage,
    ]
  );

  // 强调色注入点必须在 :root（documentElement），不能挂在应用外壳 div 上。
  // 原因：自定义属性在【声明它的那个元素】上就完成 var() 代入，而 tokens.css 里的
  // --accent / --accent-primary / --accent-light / --accent-hover / --accent-ring
  // 与 @theme 的 --color-accent* 全部声明在 :root。若 --reader-accent 只挂在外壳 div，
  // :root 看不到它，这些令牌会被烧成兜底值并原样继承给所有后代 —— 结果是全应用
  // 69 处「跟随强调色」的声明（PDFViewer.css 59 / WebViewPanel.css 7 /
  // ReadingAssistMenu.css 3）永远是灰色，用户选 green 还是 rose 都一样。
  // 已在 Chrome 实测（accent=green，浅色）：外壳 --reader-accent = #059669，
  // 而 :root --accent = --accent-primary = --color-accent = #52525b，bg-accent 渲染为灰。
  // useLayoutEffect 而非 useEffect：强调色会影响首帧配色，用它把写入提前到绘制前，
  // 避免「先闪一下兜底灰再换成用户强调色」。本应用无 SSR，不受其警告约束。
  useLayoutEffect(() => {
    const target = document.documentElement.style;
    target.setProperty("--reader-accent", resolvedAccent.solid);
    target.setProperty("--reader-accent-soft", resolvedAccent.soft);
    target.setProperty("--reader-accent-contrast", resolvedAccent.contrast);
  }, [resolvedAccent]);

  const activeNotes = useMemo(() => {
    if (!activeTab?.filePath || (activeTab.type !== "pdf" && activeTab.type !== "markdown")) return [];
    return notesByDocument[activeDocument?.id || documentPathKey(activeTab.filePath)] || notesByDocument[documentPathKey(activeTab.filePath)] || [];
  }, [activeDocument?.id, activeTab?.filePath, activeTab?.type, notesByDocument]);
  const activeAnnotations = useMemo(() => {
    if (!activeTab?.filePath || activeTab.type !== "pdf") return [];
    return annotationsByDocument[activeDocument?.id || documentPathKey(activeTab.filePath)] || annotationsByDocument[documentPathKey(activeTab.filePath)] || [];
  }, [activeDocument?.id, activeTab?.filePath, activeTab?.type, annotationsByDocument]);

  const updateBusyMessage = useCallback((message: string, clearAfterMs?: number) => {
    if (busyTimerRef.current !== null) {
      window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
    setBusyMessage(message);
    if (typeof clearAfterMs === "number") {
      busyTimerRef.current = window.setTimeout(() => {
        setBusyMessage("");
        busyTimerRef.current = null;
      }, clearAfterMs);
    }
  }, []);

  const closeWebTabNative = useCallback((tabId: string) => {
    void closeNativeWebviewTab(tabId).catch((error) => {
      debugWarn("webview.close", "failed to close native webview tab", { tabId, error });
    });
  }, []);

  const flushPendingPdfReleases = useCallback(() => {
    for (const [fileId, context] of pendingPdfReleasesRef.current) {
      const stillReferenced = latestTabsRef.current.some(
        (tab) => (tab.type === "pdf" || tab.type === "markdown") && tab.fileId === fileId,
      );
      if (stillReferenced) continue;
      pendingPdfReleasesRef.current.delete(fileId);
      void api.closeFile(fileId).catch((error) => {
        debugWarn("pdf.close", "failed to release deferred document handle", { fileId, context, error });
      });
    }
  }, []);

  const releasePdfFileAfterTabCommit = useCallback((fileId: string, context: string) => {
    // Queue the release until React has committed the tab change, then verify
    // that no remaining PDF/Markdown tab still references this handle. This
    // prevents a close/reopen race from destroying a newly reused file ID.
    pendingPdfReleasesRef.current.set(fileId, context);
    window.setTimeout(flushPendingPdfReleases, 0);
  }, [flushPendingPdfReleases]);

  useEffect(() => {
    flushPendingPdfReleases();
  }, [flushPendingPdfReleases, tabs]);

  useEffect(() => {
    const serializable = documents
      .filter((document) => !isEphemeralWebPdfPath(document.path))
      .map(({ fileId, ...doc }) => doc);
    writeVersionedLocalState(DOCUMENTS_KEY, DOCUMENTS_STATE_VERSION, serializable);
  }, [documents]);

  useEffect(() => {
    writeVersionedLocalState(COLLECTIONS_KEY, COLLECTIONS_STATE_VERSION, collections);
  }, [collections]);

  useEffect(() => {
    writeVersionedLocalState(NOTES_KEY, NOTES_STATE_VERSION, notesByDocument);
  }, [notesByDocument]);

  useEffect(() => {
    saveStoredAnnotations(annotationsByDocument);
    annotationsRef.current = annotationsByDocument;
  }, [annotationsByDocument]);

  useEffect(() => {
    if (documents.length === 0) return;
    const notes = migrateDocumentArtifacts(notesByDocument, documents);
    if (notes.changed) setNotesByDocument(notes.artifacts);
    const annotations = migrateDocumentArtifacts(annotationsByDocument, documents);
    if (annotations.changed) setAnnotationsByDocument(annotations.artifacts);
  }, [documents]);

  useEffect(() => {
    latestTabsRef.current = tabs;
    latestActiveTabIdRef.current = activeTabId;
    const serializableTabs = tabs
      .filter((tab) => !isEphemeralWebPdfPath(tab.filePath))
      .map(({ fileId, ...tab }) => tab);
    if (tabsPersistTimerRef.current !== null) {
      window.clearTimeout(tabsPersistTimerRef.current);
    }
    tabsPersistTimerRef.current = window.setTimeout(() => {
      tabsPersistTimerRef.current = null;
      writeVersionedLocalState(TABS_KEY, TABS_STATE_VERSION, { tabs: serializableTabs, activeTabId });
    }, 240);
    return () => {
      if (tabsPersistTimerRef.current !== null) {
        window.clearTimeout(tabsPersistTimerRef.current);
        tabsPersistTimerRef.current = null;
      }
    };
  }, [activeTabId, tabs]);

  useEffect(() => {
    const flushTabs = () => {
      const serializableTabs = latestTabsRef.current
        .filter((tab) => !isEphemeralWebPdfPath(tab.filePath))
        .map(({ fileId, ...tab }) => tab);
      writeVersionedLocalState(TABS_KEY, TABS_STATE_VERSION, {
        tabs: serializableTabs,
        activeTabId: latestActiveTabIdRef.current,
      });
    };
    window.addEventListener("pagehide", flushTabs);
    window.addEventListener("beforeunload", flushTabs);
    return () => {
      window.removeEventListener("pagehide", flushTabs);
      window.removeEventListener("beforeunload", flushTabs);
    };
  }, []);

  useEffect(() => {
    const merged = mergeDuplicateDocumentTabs(tabs, activeTabId);
    if (!merged.changed) return;
    setTabs(merged.tabs);
    if (merged.activeTabId !== activeTabId) {
      setActiveTabId(merged.activeTabId);
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    const showWarning = (warning: PersistenceWarning) => {
      updateBusyMessage(
        warning.kind === "read"
          ? settings.language === "zh-CN"
            ? `本地数据读取异常：${warning.key}，已保留原始数据。`
            : `Local data read issue: ${warning.key}; the original data was preserved.`
          : settings.language === "zh-CN"
            ? `本地数据写入失败：${warning.key}，已保留旧数据。`
            : `Local data write failed: ${warning.key}; the previous value was preserved.`,
        5200
      );
    };
    for (const warning of consumePersistenceWarnings()) {
      showWarning(warning);
    }
    const onWarning = (event: Event) => {
      const warning = (event as CustomEvent<PersistenceWarning>).detail;
      if (warning) showWarning(warning);
    };
    window.addEventListener(PERSISTENCE_WARNING_EVENT, onWarning);
    return () => window.removeEventListener(PERSISTENCE_WARNING_EVENT, onWarning);
  }, [settings.language, updateBusyMessage]);

  useEffect(() => {
    if (settings.themeMode !== "system") {
      setTheme(settings.themeMode === "dark" ? "dark" : "light");
      return;
    }

    if (typeof window === "undefined") {
      setTheme("light");
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setTheme(media.matches ? "dark" : "light");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.themeMode]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    // 让原生控件（滚动条、input、下拉）跟随主题。
    // index.html 的内联脚本已在首帧前设过一次，这里再设一次是为了让 React
    // 成为唯一权威：否则内联脚本与 React 对「主题」的判断一旦不同源
    // （例如 localStorage 在两者之间才被写入），就会出现 class 是 dark
    // 而 color-scheme 还是 light 的分叉。
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const persistSettings = useCallback((next: UserSettings) => {
    const clean = sanitizeUserSettings(next);
    setSettings(clean);
    saveUserSettings(clean);
  }, []);

  const openLibraryTab = useCallback((filter: LibraryFilter, title: string) => {
    setTabs((prev) => {
      const hasMain = prev.some((tab) => tab.id === DEFAULT_ACTIVE_TAB_ID);
      const nextTitle = filter.startsWith("collection:") ? title.trim() || uiText.collectionTab : uiText.libraryTab;
      const nextTabs: Tab[] = hasMain
        ? prev.map((tab) =>
            tab.id === DEFAULT_ACTIVE_TAB_ID
              ? {
                  ...tab,
                  type: "library" as const,
                  title: nextTitle,
                  filter,
                  pinned: true,
                }
              : tab
          )
        : [
            {
              id: DEFAULT_ACTIVE_TAB_ID,
              type: "library" as const,
              title: nextTitle,
              filter,
              pinned: true,
            },
            ...prev,
          ];
      setActiveTabId(DEFAULT_ACTIVE_TAB_ID);
      return nextTabs;
    });
  }, [uiText.collectionTab, uiText.libraryTab]);

  const pinLibraryTab = useCallback((filter: LibraryFilter, title: string) => {
    setTabs((prev) => {
      const existing = prev.find(
        (tab) => tab.id !== DEFAULT_ACTIVE_TAB_ID && tab.type === "library" && tab.filter === filter
      );
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }

      const nextTitle = title.trim() || (filter.startsWith("collection:") ? uiText.collectionTab : uiText.libraryTab);
      const nextTab: Tab = {
        id: `library-${Date.now()}`,
        type: "library",
        title: nextTitle,
        filter,
        pinned: false,
      };
      setActiveTabId(nextTab.id);
      return [...prev, nextTab];
    });
  }, [uiText.collectionTab, uiText.libraryTab]);

  const createCollection = useCallback(() => {
    if (typeof window === "undefined") return;
    const name = window.prompt(uiText.collectionPrompt);
    if (!name) return;
    const clean = name.trim();
    if (!clean) return;
    const id = `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setCollections((prev) => {
      if (prev.some((item) => item.name.toLowerCase() === clean.toLowerCase())) {
        updateBusyMessage(uiText.collectionExists, 1800);
        return prev;
      }
      return [...prev, { id, name: clean, paths: [], createdAt: new Date().toISOString() }];
    });
    pinLibraryTab(`collection:${id}`, clean);
  }, [pinLibraryTab, uiText.collectionExists, uiText.collectionPrompt, updateBusyMessage]);

  const openSettingsTab = useCallback((focusSection?: "quick-links") => {
    if (focusSection) {
      setSettingsFocusSection(focusSection);
      setSettingsFocusToken((value) => value + 1);
    } else {
      setSettingsFocusSection(null);
    }

    setTabs((prev) => {
      const existing = prev.find((tab) => tab.type === "settings");
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const nextTab: Tab = { id: `settings-${Date.now()}`, type: "settings", title: uiText.settingsTab, pinned: false };
      setActiveTabId(nextTab.id);
      return [...prev, nextTab];
    });
  }, [uiText.settingsTab]);

  const updateMarkdownTabContent = useCallback((tabId: string, nextContent: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && tab.type === "markdown"
          ? { ...tab, content: nextContent, contentDirty: true }
          : tab
      )
    );
  }, []);

  const markMarkdownTabSaved = useCallback((path: string, content: string) => {
    setTabs((prev) => prev.map((tab) =>
      tab.type === "markdown" && tab.filePath && samePath(tab.filePath, path) && tab.content === content
        ? { ...tab, contentDirty: false, contentBase: content }
        : tab
    ));
  }, []);

  const saveMarkdownFile = useCallback(
    async (path: string, fileId: string | undefined, content: string) => {
      if (isTauriRuntime()) {
        await writeNativeTextFile(path, content);
      } else if (fileId) {
        await api.saveMarkdown(fileId, content);
      } else {
        throw new Error("No markdown file context");
      }

      setDocuments((prev) =>
        prev.map((doc) =>
          samePath(doc.path, path)
            ? { ...doc, lastOpenedAt: new Date().toISOString() }
            : doc
        )
      );
    },
    []
  );

  const openWebTab = useCallback(
    (url?: string, options?: { forceNew?: boolean }) => {
      const normalized = url ? normalizeUrl(url) : START_PAGE_URL;
      const nextTab: Tab = {
        id: `web-${Date.now()}`,
        type: "web",
        title: normalized === START_PAGE_URL ? (settings.language === "zh-CN" ? "起始页" : "Start Page") : normalized ? shortHostSafe(normalized) : uiText.webNewTab,
        url: normalized,
        pinned: false,
      };
      setTabs((prev) => {
        const existing = prev.find(
          (tab) => tab.type === "web" && normalizeUrl(tab.url || START_PAGE_URL) === normalized
        );
        if (existing && !options?.forceNew) {
          setActiveTabId(existing.id);
          return prev;
        }
        setActiveTabId(nextTab.id);
        return [...prev, nextTab];
      });
    },
    [settings.language, uiText.webNewTab]
  );

  const upsertDocumentStub = useCallback((path: string) => {
    setDocuments((prev) => {
      const existing = prev.find((item) => samePath(item.path, path));
      const markdown = isMarkdownPath(path);
      const nextItem: ReaderDocument = {
        id: existing?.id || createDocumentId(),
        title: existing?.title || baseTitleFromPath(path),
        path,
        kind: markdown ? "markdown" : "pdf",
        authors: existing?.authors || [],
        year: existing?.year || 0,
        journal: existing?.journal || "",
        tags: existing?.tags || [],
        isFavorite: existing?.isFavorite || false,
        progress: existing?.progress || 0,
        pageCount: markdown ? 1 : existing?.pageCount || 1,
        fileSize: existing?.fileSize,
        addedAt: existing?.addedAt || new Date().toISOString(),
        lastOpenedAt: existing?.lastOpenedAt || new Date().toISOString(),
        trashedAt: existing?.trashedAt,
        fileId: existing?.fileId,
      };
      const rest = prev.filter((item) => !samePath(item.path, path));
      return [nextItem, ...rest].sort(
        (left, right) => new Date(right.lastOpenedAt).getTime() - new Date(left.lastOpenedAt).getTime()
      );
    });
  }, []);

  const upsertDocumentFromOpen = useCallback(
    (payload: { title: string; path: string; fileId?: string; pageCount: number; fileSize?: number; kind: "pdf" | "markdown"; content?: string }) => {
      const now = new Date().toISOString();
      setDocuments((prev) => {
        const existing = prev.find((item) => samePath(item.path, payload.path));
        const nextItem: ReaderDocument = {
          id: existing?.id || createDocumentId(),
          title: payload.title,
          path: payload.path,
          kind: payload.kind,
          authors: existing?.authors || [],
          year: existing?.year || 0,
          journal: existing?.journal || "",
          tags: existing?.tags || [],
          isFavorite: existing?.isFavorite || false,
          progress: existing?.progress || 0,
          pageCount: payload.kind === "markdown" ? 1 : payload.pageCount || existing?.pageCount || 1,
          fileSize: payload.fileSize || existing?.fileSize,
          addedAt: existing?.addedAt || now,
          lastOpenedAt: now,
          trashedAt: existing?.trashedAt,
          fileId: payload.fileId,
        };
        const rest = prev.filter((item) => !samePath(item.path, payload.path));
        return [nextItem, ...rest];
      });

      const existingDocumentTab = latestTabsRef.current.find(
        (item) =>
          (item.type === "pdf" || item.type === "markdown") &&
          item.filePath &&
          samePath(item.filePath, payload.path),
      );
      const nextDocumentTabId = existingDocumentTab?.id || `${payload.kind}-${Date.now()}`;

      setTabs((prev) => {
        const existing = prev.find(
          (item) =>
            (item.type === "pdf" || item.type === "markdown") &&
            item.filePath &&
            samePath(item.filePath, payload.path)
        );
        if (existing) {
          const updatedTab: Tab = {
            ...existing,
            type: (payload.kind === "markdown" ? "markdown" : "pdf") as Tab["type"],
            title: payload.title,
            filePath: payload.path,
            fileId: payload.fileId,
            content: payload.kind === "markdown"
              ? existing?.contentDirty && existing.contentBase === payload.content
                ? existing.content
                : payload.content
              : undefined,
            contentDirty: payload.kind === "markdown"
              ? Boolean(existing?.contentDirty && existing.contentBase === payload.content)
              : undefined,
            contentBase: payload.kind === "markdown"
              ? existing?.contentDirty && existing.contentBase === payload.content
                ? existing.contentBase
                : payload.content
              : undefined,
          };
          const updated: Tab[] = [];
          for (const item of prev) {
            if (
              (item.type === "pdf" || item.type === "markdown") &&
              item.filePath &&
              samePath(item.filePath, payload.path)
            ) {
              if (item.id === existing.id) {
                updated.push({
                  ...updatedTab,
                  pdfViewState: choosePdfViewState(updatedTab.pdfViewState, item.pdfViewState),
                });
              }
              continue;
            }
            updated.push(item);
          }
          return updated;
        }

        const nextTab: Tab = {
          id: nextDocumentTabId,
          type: payload.kind === "markdown" ? "markdown" : "pdf",
          title: payload.title,
          filePath: payload.path,
          fileId: payload.fileId,
          content: payload.kind === "markdown" ? payload.content : undefined,
          contentDirty: payload.kind === "markdown" ? false : undefined,
          contentBase: payload.kind === "markdown" ? payload.content : undefined,
          pinned: false,
        };
        return [...prev, nextTab];
      });
      setActiveTabId(nextDocumentTabId);
    },
    []
  );

  const openPdfByPath = useCallback(
    async (path: string, preferredTitle?: string, options?: { silentBusy?: boolean }) => {
      const cleanPath = path.trim();
      if (!cleanPath) return false;
      const openKey = cleanPath.toLowerCase();
      const markdown = isMarkdownPath(path);
      const existingLoadedTab = tabs.find(
        (tab) =>
          (tab.type === "pdf" || tab.type === "markdown") &&
          tab.filePath &&
          samePath(tab.filePath, cleanPath) &&
          tab.fileId
      );
      if (existingLoadedTab) {
        setActiveTabId(existingLoadedTab.id);
        return true;
      }
      if (openingPathsRef.current.has(openKey)) {
        return false;
      }
      cancelledOpeningPathsRef.current.delete(openKey);
      openingPathsRef.current.add(openKey);
      const existingDoc = documents.find((item) => samePath(item.path, path));
      try {
        if (!options?.silentBusy) {
          updateBusyMessage(markdown ? "Opening Markdown..." : "Opening PDF...");
        }

        if (markdown) {
          const fileInfo = await api.openMarkdownFile(cleanPath);
          try {
            const markdownText = await api.readMarkdownText(fileInfo.path);
            if (cancelledOpeningPathsRef.current.has(openKey)) {
              cancelledOpeningPathsRef.current.delete(openKey);
              await api.closeFile(fileInfo.id);
              return false;
            }
            upsertDocumentFromOpen({
              title: preferredTitle || fileInfo.name || fileNameFromPath(fileInfo.path),
              path: fileInfo.path,
              fileId: fileInfo.id,
              pageCount: 1,
              kind: "markdown",
              content: markdownText,
            });
            updateBusyMessage("", 120);
            return true;
          } catch (error) {
            await api.closeFile(fileInfo.id).catch((closeError) => {
              debugWarn("markdown.close", "failed to release Markdown handle after open failure", {
                fileId: fileInfo.id,
                error: closeError,
              });
            });
            throw error;
          }
        }

        const fileInfo = await api.openFile(cleanPath);
        if (cancelledOpeningPathsRef.current.has(openKey)) {
          cancelledOpeningPathsRef.current.delete(openKey);
          await api.closeFile(fileInfo.id);
          return false;
        }
        upsertDocumentFromOpen({
          title: preferredTitle || fileInfo.name || fileNameFromPath(fileInfo.path),
          path: fileInfo.path,
          fileId: fileInfo.id,
          pageCount: fileInfo.meta.pages || 1,
          fileSize: fileInfo.meta.fileSize,
          kind: "pdf",
        });

        if (existingDoc?.fileId && existingDoc.fileId !== fileInfo.id) {
          releasePdfFileAfterTabCommit(existingDoc.fileId, "replace-document");
        }

        updateBusyMessage("", 120);
        return true;
      } catch (error) {
        const failedTab = latestTabsRef.current.find(
          (tab) =>
            (tab.type === "pdf" || tab.type === "markdown") &&
            tab.filePath &&
            samePath(tab.filePath, cleanPath) &&
            !tab.fileId,
        );
        if (failedTab) {
          setTabs((prev) => prev.filter((tab) => tab.id !== failedTab.id));
          if (latestActiveTabIdRef.current === failedTab.id) {
            setActiveTabId(DEFAULT_ACTIVE_TAB_ID);
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        updateBusyMessage(`Failed to open file: ${message}`, 3200);
        return false;
      } finally {
        openingPathsRef.current.delete(openKey);
        cancelledOpeningPathsRef.current.delete(openKey);
      }
    },
    [documents, releasePdfFileAfterTabCommit, tabs, updateBusyMessage, upsertDocumentFromOpen]
  );

  useEffect(() => {
    if (
      !activeTab ||
      (activeTab.type !== "pdf" && activeTab.type !== "markdown") ||
      !activeTab.filePath ||
      activeTab.fileId ||
      openingPathsRef.current.has(activeTab.filePath.trim().toLowerCase())
    ) {
      return;
    }
    void openPdfByPath(activeTab.filePath, activeTab.title, { silentBusy: true });
  }, [activeTab, openPdfByPath]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const droppedPath = event.payload.paths.find(isSupportedDropPath);
        if (!droppedPath) {
          updateBusyMessage("只支持拖入 PDF 或 Markdown 文件。", 2400);
          return;
        }
        void openPdfByPath(droppedPath);
      })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        debugWarn("app.dragDrop", "failed to register file drop listener", { error });
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPdfByPath, updateBusyMessage]);

  const updatePdfTabViewState = useCallback((tabId: string, viewState: NonNullable<Tab["pdfViewState"]>) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && tab.type === "pdf"
          ? { ...tab, pdfViewState: viewState }
          : tab
      )
    );
  }, []);

  const openPdfReference = useCallback(
    (doc: ReaderDocument, targetPage: number, focusRect?: ReaderAnnotationRect) => {
      const page = Math.max(1, Math.round(targetPage || 1));
      const existing = latestTabsRef.current.find(
        (tab) => tab.type === "pdf" && tab.filePath && samePath(tab.filePath, doc.path),
      );
      if (existing) {
        setActiveTabId(existing.id);
        const current = existing.pdfViewState;
        updatePdfTabViewState(existing.id, {
          page,
          totalPages: Math.max(page, current?.totalPages || page),
          zoom: current?.zoom || 100,
          scrollTop: 0,
          scrollLeft: 0,
          focusRect,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      pendingPdfNavigationRef.current = { path: doc.path, page, focusRect };
      void openPdfByPath(doc.path, doc.title);
    },
    [openPdfByPath, updatePdfTabViewState],
  );

  useEffect(() => {
    const pending = pendingPdfNavigationRef.current;
    if (!pending) return;
    const target = tabs.find((tab) => tab.type === "pdf" && tab.filePath && samePath(tab.filePath, pending.path) && tab.fileId);
    if (!target) return;
    pendingPdfNavigationRef.current = null;
    setActiveTabId(target.id);
    const current = target.pdfViewState;
    updatePdfTabViewState(target.id, {
      page: Math.max(1, Math.round(pending.page)),
      totalPages: Math.max(pending.page, current?.totalPages || pending.page),
      zoom: current?.zoom || 100,
      scrollTop: 0,
      scrollLeft: 0,
      focusRect: pending.focusRect,
      updatedAt: new Date().toISOString(),
    });
  }, [tabs, updatePdfTabViewState]);

  const downloadResourceToFile = useCallback(
    async (rawUrl: string, options?: { preferPdf?: boolean }) => {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) {
        updateBusyMessage("No resource URL to download", 1800);
        return null;
      }
      try {
        updateBusyMessage(options?.preferPdf ? "Downloading PDF..." : "Downloading resource...");

        let bytes: ArrayBuffer | null = null;
        let finalUrl = normalized;
        let contentDisposition = "";

        if (settings.proxyEnabled && settings.proxyUrl.trim()) {
          const viaProxy = await downloadPdfViaProxy(normalized, settings.proxyUrl);
          if (viaProxy) {
            bytes = viaProxy.bytes;
            finalUrl = viaProxy.finalUrl || normalized;
            contentDisposition = viaProxy.contentDisposition || "";
          }
        }

        if (!bytes) {
          const direct = await downloadDirectHttpResource(normalized);
          bytes = direct.bytes;
          finalUrl = direct.finalUrl || normalized;
          contentDisposition = direct.contentDisposition || "";
        }

        const fileName = guessPdfFileName(finalUrl, contentDisposition);
        if (!isTauriRuntime()) {
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: options?.preferPdf ? "application/pdf" : "application/octet-stream" }));
          const anchor = document.createElement("a");
          anchor.href = objectUrl;
          anchor.download = fileName;
          anchor.rel = "noopener";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
          updateBusyMessage(`Downloaded ${fileName}`, 2200);
          return { savePath: "", fileName, finalUrl };
        }
        const savePath = await save({
          defaultPath: withDefaultDir(fileName, settings.defaultSaveDir),
          filters: [
            {
              name: options?.preferPdf ? "PDF" : "Downloaded file",
              extensions: options?.preferPdf ? ["pdf"] : [],
            },
          ],
        });
        if (!savePath || typeof savePath !== "string") {
          updateBusyMessage("Download cancelled", 1500);
          return null;
        }
        await writeNativeBinaryFile(savePath, new Uint8Array(bytes));
        updateBusyMessage(`Saved ${fileName}`, 2200);
        return { savePath, fileName, finalUrl };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateBusyMessage(`Download failed: ${message}`, 3600);
        return null;
      }
    },
    [settings.defaultSaveDir, settings.proxyEnabled, settings.proxyUrl, updateBusyMessage]
  );

  const openPdfFromUrl = useCallback(
    async (rawUrl: string, sourceTabId?: string) => {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) return false;
      const existingRequest = openingPdfUrlsRef.current.get(normalized);
      if (existingRequest) return existingRequest;

      const request = (async () => {
        try {
          if (sourceTabId && !latestTabsRef.current.some((tab) => tab.id === sourceTabId && tab.type === "web")) {
            return false;
          }
          // Hide the native surface before downloading. It must not keep receiving
          // navigation/resize work while the active tab changes to the PDF.
          if (sourceTabId && canUseNativeWebview()) {
            try {
              await hideNativeWebviewTab(sourceTabId);
            } catch (error) {
              // The PDF event may arrive while the web tab is being removed;
              // hiding is a safety measure, not a prerequisite for opening.
              debugWarn("webview.pdf", "failed to hide source webview", { sourceTabId, error });
            }
          }

          if (isTauriRuntime()) {
            updateBusyMessage("正在下载 PDF...");
            const downloaded = await downloadPdfToNativeTemp(
              normalized,
              settings.proxyEnabled && settings.proxyUrl.trim() ? settings.proxyUrl : undefined,
            );
            if (sourceTabId && !latestTabsRef.current.some((tab) => tab.id === sourceTabId && tab.type === "web")) {
              await removeManagedWebPdfTemp(downloaded.path);
              return false;
            }
            const opened = await openPdfByPath(
              downloaded.path,
              safePdfFileName(downloaded.fileName).replace(/\.pdf$/i, ""),
              { silentBusy: true },
            );
            if (!opened) {
              await removeManagedWebPdfTemp(downloaded.path);
              throw new Error("PDF 文件打开失败");
            }
            return true;
          }

        let bytes: ArrayBuffer | null = null;
        let finalUrl = normalized;
        let contentDisposition = "";
        let contentType = "";

        if (settings.proxyEnabled && settings.proxyUrl.trim()) {
          const viaProxy = await downloadPdfViaProxy(normalized, settings.proxyUrl);
          if (viaProxy) {
            if (viaProxy.status >= 400) {
              throw new Error(`PDF 请求失败 (${viaProxy.status})`);
            }
            bytes = viaProxy.bytes;
            finalUrl = viaProxy.finalUrl || normalized;
            contentDisposition = viaProxy.contentDisposition || "";
            contentType = viaProxy.contentType || "";
          }
        }

        if (!bytes) {
          const direct = await downloadDirectHttpResource(normalized, { maxBytes: DIRECT_PDF_MAX_BYTES });
          if (direct.status >= 400) {
            throw new Error(`PDF 请求失败 (${direct.status})`);
          }
          bytes = direct.bytes;
          finalUrl = direct.finalUrl || normalized;
          contentDisposition = direct.contentDisposition || "";
          contentType = direct.contentType || "";
        }

        if (!bytes) throw new Error("PDF 下载没有返回内容");
        assertPdfPayload(bytes, contentType);
        const fileName = safePdfFileName(guessPdfFileName(finalUrl, contentDisposition));
        if (!isTauriRuntime()) {
          const browserFile = new File([bytes], fileName, { type: "application/pdf" });
          const fileInfo = await api.uploadFile(browserFile);
          if (sourceTabId && !latestTabsRef.current.some((tab) => tab.id === sourceTabId && tab.type === "web")) {
            await api.closeFile(fileInfo.id).catch((closeError) => {
              debugWarn("webview.pdf", "failed to release late browser PDF upload", {
                fileId: fileInfo.id,
                error: closeError,
              });
            });
            return false;
          }
          upsertDocumentFromOpen({
            title: fileName.replace(/\.pdf$/i, ""),
            path: fileInfo.path,
            fileId: fileInfo.id,
            pageCount: fileInfo.meta.pages || 1,
            fileSize: fileInfo.meta.fileSize,
            kind: "pdf",
          });
          updateBusyMessage("", 120);
          return true;
        }
        const tempPath = await writeNativeTempFile(
          `r0nix-web-${Date.now()}-${fileName}`,
          new Uint8Array(bytes)
        );
        return await openPdfByPath(tempPath, fileName.replace(/\.pdf$/i, ""), { silentBusy: true });
        } catch (error) {
          // The native surface is hidden before the download starts so a PDF
          // tab can take over cleanly. Restore it when opening fails; otherwise
          // a rejected download leaves the web tab looking like a blank page.
          if (sourceTabId && canUseNativeWebview()) {
            try {
              if (latestTabsRef.current.some((tab) => tab.id === sourceTabId && tab.type === "web")) {
                await showNativeWebviewTab(sourceTabId, true);
              }
            } catch (restoreError) {
              debugWarn("webview.pdf", "failed to restore source webview after PDF open failure", {
                sourceTabId,
                error: restoreError,
              });
            }
          }
          const message = error instanceof Error ? error.message : String(error);
          updateBusyMessage(`打开 PDF 失败: ${message}`, 3600);
          return false;
        }
      })();
      openingPdfUrlsRef.current.set(normalized, request);
      try {
        return await request;
      } finally {
        if (openingPdfUrlsRef.current.get(normalized) === request) {
          openingPdfUrlsRef.current.delete(normalized);
        }
      }
    },
    [openPdfByPath, settings.proxyEnabled, settings.proxyUrl, updateBusyMessage, upsertDocumentFromOpen]
  );

  const openPdfDialog = useCallback(async () => {
    if (isTauriRuntime()) {
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: "Documents", extensions: ["pdf", "md", "markdown"] }],
          title: "Open Document",
        });
        if (typeof selected === "string") {
          await openPdfByPath(selected);
          return;
        }
      } catch {
        // Fall through to the browser-compatible file input when the native dialog is unavailable.
      }
    }

    if (typeof window === "undefined") return;

    try {
      const pickedFile = await new Promise<File | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".pdf,.md,.markdown,application/pdf,text/markdown,text/plain";
        input.style.display = "none";
        input.onchange = () => {
          const file = input.files && input.files.length > 0 ? input.files[0] : null;
          resolve(file);
          input.remove();
        };
        input.oncancel = () => {
          resolve(null);
          input.remove();
        };
        document.body.appendChild(input);
        input.click();
      });

      if (!pickedFile) return;

      const ext = pickedFile.name.split(".").pop()?.toLowerCase();
      const markdown = ext === "md" || ext === "markdown";
      updateBusyMessage(markdown ? "Opening Markdown..." : "Opening PDF...");
      const opened = await api.uploadFile(pickedFile);
      try {
        let markdownText = "";
        if (markdown) {
          markdownText = await api.readMarkdownText(opened.path);
        }
        upsertDocumentFromOpen({
          title: opened.name.replace(/\.(pdf|md|markdown)$/i, ""),
          path: opened.path,
          fileId: opened.id,
          pageCount: markdown ? 1 : opened.meta.pages || 1,
          fileSize: opened.meta.fileSize,
          kind: markdown ? "markdown" : "pdf",
          content: markdown ? markdownText : undefined,
        });
        updateBusyMessage("", 120);
      } catch (error) {
        await api.closeFile(opened.id).catch((closeError) => {
          debugWarn("upload.close", "failed to release uploaded file after import failure", {
            fileId: opened.id,
            error: closeError,
          });
        });
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateBusyMessage(`Failed to open file: ${message}`, 3200);
    }
  }, [openPdfByPath, updateBusyMessage, upsertDocumentFromOpen]);

  const importFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Import Folder" });
      if (typeof selected !== "string" || !selected.trim()) return;
      updateBusyMessage("Scanning folder...");
      const pdfPaths = await collectNativeImportablePaths(selected);
      if (pdfPaths.length === 0) {
        updateBusyMessage("No documents found in folder", 2200);
        return;
      }
      for (const path of pdfPaths) {
        upsertDocumentStub(path);
      }
      updateBusyMessage(`Imported ${pdfPaths.length} document${pdfPaths.length > 1 ? "s" : ""}`, 2400);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateBusyMessage(`Import failed: ${message}`, 3200);
    }
  }, [updateBusyMessage, upsertDocumentStub]);

  const handleCloseTab = useCallback(
    (id: string) => {
      const closing = tabs.find((item) => item.id === id);
      if (!closing) return;
      if (closing.type === "markdown" && closing.contentDirty && typeof window !== "undefined") {
        if (!window.confirm(uiText.unsavedMarkdownClose)) return;
      }
      if (closing.type === "web") {
        closeWebTabNative(closing.id);
      }
      if ((closing.type === "pdf" || closing.type === "markdown") && !closing.fileId && closing.filePath) {
        cancelledOpeningPathsRef.current.add(closing.filePath.trim().toLowerCase());
      }
      if ((closing.type === "pdf" || closing.type === "markdown") && closing.fileId) {
        releasePdfFileAfterTabCommit(closing.fileId, `close-tab:${closing.id}`);
      }
      if ((closing.type === "pdf" || closing.type === "markdown") && closing.filePath && isEphemeralWebPdfPath(closing.filePath)) {
        cleanupManagedWebPdfTemp(closing.filePath);
      }

      setTabs((prev) => {
        if (!prev.some((item) => item.id === id)) return prev;
        const nextTabs = prev.filter((item) => item.id !== id);
        if (nextTabs.length === 0) {
          setActiveTabId(DEFAULT_ACTIVE_TAB_ID);
          return PINNED_TABS;
        }

        if (activeTabId === id) {
          const closingIndex = prev.findIndex((item) => item.id === id);
          const nextActive = nextTabs[Math.min(closingIndex, nextTabs.length - 1)];
          setActiveTabId(nextActive.id);
        }

        return nextTabs;
      });
    },
    [activeTabId, closeWebTabNative, releasePdfFileAfterTabCommit, tabs, uiText.unsavedMarkdownClose]
  );

  const handleOpenExternal = useCallback(async (url: string) => {
    const normalized = normalizeHttpUrl(url);
    if (!normalized) {
      updateBusyMessage("Only HTTP(S) links can be opened externally", 2600);
      return;
    }
    try {
      if (canUseNativeWebview()) {
        const shell = await import("@tauri-apps/plugin-shell");
        await shell.open(normalized);
        return;
      }
      window.open(normalized, "_blank", "noopener,noreferrer");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateBusyMessage(`Failed to open external link: ${message}`, 3200);
    }
  }, [updateBusyMessage]);

  const focusLibrarySearch = useCallback(() => {
    setActiveTabId(DEFAULT_ACTIVE_TAB_ID);
    window.setTimeout(() => {
      const input = document.getElementById("library-search-input") as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
        return;
      }
      window.dispatchEvent(new Event(LIBRARY_SEARCH_FOCUS_EVENT));
    }, 0);
  }, []);

  const removeDocumentTabs = useCallback(
    (path: string) => {
      const removedTabs = latestTabsRef.current.filter(
        (tab) =>
          (tab.type === "pdf" || tab.type === "markdown") &&
          tab.filePath &&
          samePath(tab.filePath, path),
      );
      for (const tab of removedTabs) {
        if (tab.fileId) {
          releasePdfFileAfterTabCommit(tab.fileId, `remove-document:${tab.id}`);
        } else if (tab.filePath) {
          cancelledOpeningPathsRef.current.add(tab.filePath.trim().toLowerCase());
        }
      }
      setTabs((prev) => {
        const nextTabs = prev.filter(
          (tab) => !((tab.type === "pdf" || tab.type === "markdown") && tab.filePath && samePath(tab.filePath, path))
        );
        if (nextTabs.length === prev.length) return prev;
        const fallbackTabs = nextTabs.length > 0 ? nextTabs : PINNED_TABS;
        if (!fallbackTabs.some((tab) => tab.id === activeTabId)) {
          setActiveTabId(fallbackTabs[0]?.id || DEFAULT_ACTIVE_TAB_ID);
        }
        return fallbackTabs;
      });
    },
    [activeTabId, releasePdfFileAfterTabCommit]
  );

  const handleMoveToTrash = useCallback(
    (docId: string) => {
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId ? { ...doc, trashedAt: doc.trashedAt || new Date().toISOString() } : doc
        )
      );
      updateBusyMessage("Moved to Trash", 1800);
    },
    [updateBusyMessage]
  );

  const handleDeleteDocuments = useCallback(
    (docIds: string[]) => {
      const idSet = new Set(docIds);
      const targets = documents.filter((doc) => idSet.has(doc.id));
      if (targets.length === 0) return;

      for (const target of targets) {
        removeDocumentTabs(target.path);
      }

      const removedPathSet = new Set(targets.map((target) => target.path.trim().toLowerCase()));
      setDocuments((prev) => prev.filter((doc) => !idSet.has(doc.id)));
      setCollections((prev) =>
        prev.map((collection) => ({
          ...collection,
          paths: collection.paths.filter((path) => !removedPathSet.has(path.trim().toLowerCase())),
        }))
      );
      setNotesByDocument((prev) => {
        const next = { ...prev };
        for (const target of targets) {
          delete next[target.id];
          delete next[documentPathKey(target.path)];
        }
        return next;
      });
      setAnnotationsByDocument((prev) => {
        const next = { ...prev };
        for (const target of targets) {
          delete next[target.id];
          delete next[documentPathKey(target.path)];
        }
        return next;
      });

      for (const target of targets) {
        delete progressRef.current[documentPathKey(target.path)];
        if (target.fileId) {
          releasePdfFileAfterTabCommit(target.fileId, "delete-document");
        }
      }

      updateBusyMessage(
        targets.length === 1 ? "Document permanently deleted" : `Permanently deleted ${targets.length} documents`,
        2200
      );
    },
    [documents, releasePdfFileAfterTabCommit, removeDocumentTabs, updateBusyMessage]
  );

  const handleDeleteDocument = useCallback(
    (docId: string) => {
      handleDeleteDocuments([docId]);
    },
    [handleDeleteDocuments]
  );

  const handleBatchRestoreFromTrash = useCallback(
    (docIds: string[]) => {
      const idSet = new Set(docIds);
      if (idSet.size === 0) return;
      setDocuments((prev) => prev.map((doc) => (idSet.has(doc.id) ? { ...doc, trashedAt: undefined } : doc)));
      updateBusyMessage(
        idSet.size === 1 ? "Restored from Trash" : `Restored ${idSet.size} documents from Trash`,
        2000
      );
    },
    [updateBusyMessage]
  );

  const handleBatchDeleteDocuments = useCallback(
    (docIds: string[]) => {
      handleDeleteDocuments(docIds);
    },
    [handleDeleteDocuments]
  );

  const handleExportList = useCallback(
    async (docs: ReaderDocument[], title: string) => {
      if (docs.length === 0) {
        updateBusyMessage("Nothing to export", 1600);
        return;
      }

      try {
        const baseName = sanitizeExportTitle(title || "library-export");
        const selectedPath = await save({
          title: `Export ${title || "Library"}`,
          defaultPath: withDefaultDir(`${baseName}.csv`, settings.defaultSaveDir),
          filters: [
            { name: "CSV", extensions: ["csv"] },
            { name: "JSON", extensions: ["json"] },
          ],
        });
        if (typeof selectedPath !== "string" || !selectedPath.trim()) {
          updateBusyMessage("Export cancelled", 1500);
          return;
        }

        const finalPath = /\.(csv|json)$/i.test(selectedPath) ? selectedPath : `${selectedPath}.csv`;
        const content = finalPath.toLowerCase().endsWith(".json")
          ? JSON.stringify(docs.map(({ fileId, ...doc }) => doc), null, 2)
          : documentsToCsv(docs);

        await writeNativeTextFile(finalPath, content);
        updateBusyMessage(`Exported ${docs.length} item${docs.length === 1 ? "" : "s"}`, 2200);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateBusyMessage(`Export failed: ${message}`, 3200);
      }
    },
    [settings.defaultSaveDir, updateBusyMessage]
  );

  const handleOpenWebsite = useCallback(
    (url: string) => {
      const normalized = normalizeUrl(url);
      if (!normalized) return;
      if (settings.openLinksInsideApp) {
        openWebTab(normalized);
        return;
      }
      void handleOpenExternal(normalized);
    },
    [handleOpenExternal, openWebTab, settings.openLinksInsideApp]
  );

  const updateTabUrl = useCallback(
    (tabId: string, nextUrl: string) => {
      const normalized = normalizeUrl(nextUrl);
      const nextTitle =
        normalized === START_PAGE_URL
          ? settings.language === "zh-CN"
            ? "起始页"
            : "Start Page"
          : normalized
            ? shortHostSafe(normalized)
            : uiText.webNewTab;
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, url: normalized, title: nextTitle }
            : tab
        )
      );
    },
    [settings.language, uiText.webNewTab]
  );

  const addNote = useCallback((path: string, page: number, content: string, kind: ReaderNote["kind"] = "note", reference?: string, source?: Pick<ReaderNote, "blockId" | "sourceRect">) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const storageKey = documentIdForPath(documents, path) || documentPathKey(path);
    const nextNote: ReaderNote = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      documentId: storageKey,
      blockId: source?.blockId,
      page,
      kind,
      content: trimmed,
      reference: reference?.trim() || undefined,
      sourceRect: source?.sourceRect,
      createdAt: new Date().toISOString(),
    };
    setNotesByDocument((prev) => ({ ...prev, [storageKey]: [nextNote, ...(prev[storageKey] || [])] }));
  }, [documents]);

  const updateNote = useCallback((path: string, noteId: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const storageKey = documentIdForPath(documents, path) || documentPathKey(path);
    setNotesByDocument((prev) => ({
      ...prev,
      [storageKey]: (prev[storageKey] || []).map((note) => note.id === noteId ? { ...note, content: trimmed } : note),
    }));
  }, [documents]);

  const removeNote = useCallback((path: string, noteId: string) => {
    const storageKey = documentIdForPath(documents, path) || documentPathKey(path);
    setNotesByDocument((prev) => ({
      ...prev,
      [storageKey]: (prev[storageKey] || []).filter((note) => note.id !== noteId),
    }));
  }, [documents]);

  const addAnnotation = useCallback(
    (
      path: string,
      annotation: Omit<ReaderAnnotation, "id" | "createdAt">
    ) => {
      const storageKey = documentIdForPath(documents, path) || documentPathKey(path);
      const nextAnnotation: ReaderAnnotation = {
        ...annotation,
        documentId: storageKey,
        id: `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      };
      setAnnotationsByDocument((prev) => ({
        ...prev,
        [storageKey]: [nextAnnotation, ...(prev[storageKey] || [])],
      }));
    },
    [documents]
  );

  const removeAnnotation = useCallback((path: string, annotationId: string) => {
    const storageKey = documentIdForPath(documents, path) || documentPathKey(path);
    /**
     * ⚠️ 删掉一条 **AI** 标注时必须同时把它写进否定集合，否则下次翻回这一页
     * 它会重新长出来 —— 这是这套功能最容易被投诉的 bug（见施工单 §3.5）。
     * 「该不该记、记哪一个」这个判定不在这里写，而在 `dismissalForRemovedAnnotation`
     * 里，因为它必须能被行为断言覆盖（字符串守卫连 `if (false && …)` 都抓不到）。
     */
    const dismissedBlockId = dismissalForRemovedAnnotation(
      annotationsRef.current[storageKey] || [],
      annotationId
    );
    if (dismissedBlockId) {
      dismissCompanionBlock(loadDismissedBlocks(), storageKey, dismissedBlockId);
    }
    setAnnotationsByDocument((prev) => ({
      ...prev,
      [storageKey]: (prev[storageKey] || []).filter((annotation) => annotation.id !== annotationId),
    }));
  }, [documents]);

  useEffect(() => {
    if (!canUseNativeWebview()) return;
    const disposes: UnlistenFn[] = [];
    let disposed = false;

    void Promise.all([
      listen<{ tabId: string; url: string }>("r0nix://webview-pdf-link", (event) => {
        const sourceTabId = event.payload?.tabId;
        const url = event.payload?.url;
        if (!sourceTabId || !url) return;
        void openPdfFromUrl(url, sourceTabId);
      }),
      listen<{ tabId: string; url: string }>("r0nix://webview-navigated", (event) => {
        const nextTabId = event.payload?.tabId;
        const nextUrl = event.payload?.url;
        if (!nextTabId || !nextUrl) return;
        updateTabUrl(nextTabId, nextUrl);
      }),
    ]).then((unlisteners) => {
      if (disposed) {
        for (const dispose of unlisteners) dispose();
        return;
      }
      disposes.push(...unlisteners);
    }).catch((error) => {
      debugWarn("webview.events", "failed to register native webview listeners", { error });
    });

    return () => {
      disposed = true;
      for (const dispose of disposes) {
        dispose();
      }
    };
  }, [openPdfFromUrl, updateTabUrl]);

  const webTabIds = useMemo(() => tabs.filter((tab) => tab.type === "web").map((tab) => tab.id), [tabs]);

  useEffect(() => {
    const removed = webTabIdsRef.current.filter((id) => !webTabIds.includes(id));
    for (const id of removed) {
      closeWebTabNative(id);
    }
    webTabIdsRef.current = webTabIds;
  }, [closeWebTabNative, webTabIds]);

  useEffect(() => {
    return () => {
      for (const id of webTabIdsRef.current) {
        closeWebTabNative(id);
      }
      if (busyTimerRef.current !== null) {
        window.clearTimeout(busyTimerRef.current);
        busyTimerRef.current = null;
      }
    };
  }, [closeWebTabNative]);

  const visibleDocuments = useMemo(() => documents.filter((doc) => !isDocumentTrashed(doc)), [documents]);
  const favoriteCount = useMemo(() => visibleDocuments.filter((doc) => doc.isFavorite).length, [visibleDocuments]);
  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTabContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabContextMenu]);

  const activeCollection = useMemo(() => {
    if (!activeTab || activeTab.type !== "library") return null;
    const filter = activeTab.filter || "all";
    if (!filter.startsWith("collection:")) return null;
    const id = filter.slice("collection:".length);
    return collections.find((item) => item.id === id) || null;
  }, [activeTab, collections]);

  return (
    <div
      className={`flex h-screen w-full overflow-hidden font-sans bg-surface-app text-content-primary${
        theme === "dark" ? " dark" : ""
      }`}
    >
      <Sidebar
        activeFilter={activeFilter}
        documentCount={visibleDocuments.length}
        favoriteCount={favoriteCount}
        collections={collections}
        quickLinks={settings.quickLinks}
        language={settings.language}
        isOpen={isSidebarOpen}
        onCreateCollection={createCollection}
        onOpenLibrary={openLibraryTab}
        onPinLibrary={pinLibraryTab}
        onOpenFileDialog={() => {
          void openPdfDialog();
        }}
        onImportFolder={() => {
          void importFolder();
        }}
        onOpenQuickLink={handleOpenWebsite}
        onOpenWeb={() => openWebTab()}
        onOpenSettings={openSettingsTab}
        onSearchWorkspace={focusLibrarySearch}
        onManageQuickLinks={() => openSettingsTab("quick-links")}
      />

      <div className="flex-1 flex flex-col min-w-0 bg-surface-panel">
        <Tabs
          tabs={tabs}
          activeTabId={activeTabId}
          onTabClick={(id) => {
            setActiveTabId(id);
            setTabContextMenu(null);
          }}
          onTabClose={handleCloseTab}
          onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
          onNewTab={() => openWebTab(undefined, { forceNew: true })}
          isSidebarOpen={isSidebarOpen}
          language={settings.language}
          onTabContextMenu={(tab, event) => {
            setTabContextMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
          }}
        />

        <div className="flex-1 overflow-hidden relative bg-surface-app">
          <AnimatePresence>
            {busyMessage ? (
              <motion.div
                key="busy-message"
                className="absolute bottom-4 right-4 z-50 px-3 py-1.5 rounded-md text-xs shadow-lg pointer-events-none"
                style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ type: "tween", duration: 0.18, ease: "easeOut" }}
              >
                {busyMessage}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {tabContextMenu ? (
            (() => {
              const targetTab = tabs.find((tab) => tab.id === tabContextMenu.tabId) || null;
              const canClose = Boolean(targetTab && !targetTab.pinned);
              const x = Math.min(tabContextMenu.x, Math.max(12, window.innerWidth - 220));
              const y = Math.min(tabContextMenu.y, Math.max(12, window.innerHeight - 120));
              return (
                <div
                  className="fixed z-[80] w-52 rounded-xl border border-border-subtle bg-surface-panel/95 backdrop-blur shadow-2xl p-1.5"
                  style={{ left: x, top: y }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <button
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-content-secondary hover:bg-surface-hover disabled:opacity-45"
                    disabled={!canClose}
                    onClick={() => {
                      if (targetTab && !targetTab.pinned) {
                        handleCloseTab(targetTab.id);
                      }
                      setTabContextMenu(null);
                    }}
                  >
                    {canClose ? uiText.tabClose : uiText.pinnedCannotClose}
                  </button>
                </div>
              );
            })()
          ) : null}

          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-xs text-content-muted">
                {settings.language === "zh-CN" ? "正在加载视图..." : "Loading view..."}
              </div>
            }
          >
          <div key={activePanelKey} className="absolute inset-0">
            {activeTab?.type === "library" ? (
              activeTab.filter === "whiteboards" ? (
                <Whiteboards
                  documents={visibleDocuments}
                  notesByDocument={notesByDocument}
                  language={settings.language}
                  onOpenPdf={(doc) => {
                    void openPdfByPath(doc.path, doc.title);
                  }}
                  onOpenPdfAt={openPdfReference}
                />
              ) : (
                <Library
                  filter={activeTab.filter || "all"}
                  filterTitle={activeCollection?.name}
                  documents={documents}
                  collectionPaths={activeCollection?.paths}
                  quickLinks={settings.quickLinks}
                  onOpenPdf={(doc) => {
                    void openPdfByPath(doc.path, doc.title);
                  }}
                  onOpenFileDialog={() => {
                    void openPdfDialog();
                  }}
                  onImportFolder={() => {
                    void importFolder();
                  }}
                  onOpenQuickLink={handleOpenWebsite}
                  onToggleFavorite={(docId) => {
                    setDocuments((prev) =>
                      prev.map((doc) => (doc.id === docId ? { ...doc, isFavorite: !doc.isFavorite } : doc))
                    );
                  }}
                  onMoveToTrash={handleMoveToTrash}
                  onDeleteDocument={handleDeleteDocument}
                  onBatchRestoreFromTrash={handleBatchRestoreFromTrash}
                  onBatchDeleteDocuments={handleBatchDeleteDocuments}
                  onExportList={handleExportList}
                  language={settings.language}
                  onToggleDocumentInCollection={(docPath) => {
                    if (!activeCollection) return;
                    setCollections((prev) =>
                      prev.map((collection) => {
                        if (collection.id !== activeCollection.id) return collection;
                        const exists = collection.paths.some((path) => samePath(path, docPath));
                        if (exists) {
                          return { ...collection, paths: collection.paths.filter((path) => !samePath(path, docPath)) };
                        }
                        return { ...collection, paths: [...collection.paths, docPath] };
                      })
                    );
                  }}
                />
              )
            ) : null}

            {activeTab?.type === "pdf" ? (
              <PDFViewer
                title={activeTab.title}
                documentId={activeDocument?.id}
                documentFileSize={activeDocument?.fileSize}
                fileId={activeTab.fileId}
                language={settings.language}
                companionEnabled={settings.companionEnabled}
                notes={activeNotes}
                annotations={activeAnnotations}
                onOpenFileDialog={() => {
                  void openPdfDialog();
                }}
                onAddNote={(pageNo, content, kind, reference, source) => {
                  if (!activeTab.filePath) return;
                  addNote(activeTab.filePath, pageNo, content, kind, reference, source);
                }}
                onUpdateNote={(noteId, content) => {
                  if (!activeTab.filePath) return;
                  updateNote(activeTab.filePath, noteId, content);
                }}
                onRemoveNote={(noteId) => {
                  if (!activeTab.filePath) return;
                  removeNote(activeTab.filePath, noteId);
                }}
                onAddAnnotation={(annotation) => {
                  if (!activeTab.filePath) return;
                  addAnnotation(activeTab.filePath, annotation);
                }}
                onRemoveAnnotation={(annotationId) => {
                  if (!activeTab.filePath) return;
                  removeAnnotation(activeTab.filePath, annotationId);
                }}
                onResolveDefaultPath={(fileName) => withDefaultDir(fileName, settings.defaultSaveDir)}
                onOpenExternal={handleOpenExternal}
                onOpenLinkInApp={(url) => {
                  const normalized = normalizeUrl(url);
                  if (!normalized) return;
                  if (/\.pdf(?:$|[?#])/i.test(normalized)) {
                    void openPdfFromUrl(normalized);
                  } else {
                    openWebTab(normalized);
                  }
                }}
                aiModelConfig={aiModelConfig}
                initialViewState={activeTab.pdfViewState}
                onViewStateChange={(viewState) => updatePdfTabViewState(activeTab.id, viewState)}
                onProgress={(pageNo, totalPages) => {
                  if (!activeTab.filePath) return;
                  const progressKey = activeTab.filePath.trim().toLowerCase();
                  const last = progressRef.current[progressKey];
                  if (last && last.page === pageNo && last.totalPages === totalPages) {
                    return;
                  }
                  progressRef.current[progressKey] = { page: pageNo, totalPages };

                  setDocuments((prev) =>
                    prev.map((doc) =>
                      samePath(doc.path, activeTab.filePath as string)
                        ? {
                            ...doc,
                            progress: totalPages > 0 ? Math.round((pageNo / totalPages) * 100) : doc.progress,
                            pageCount: Math.max(doc.pageCount, totalPages),
                            fileId: activeTab.fileId,
                            lastOpenedAt: new Date().toISOString(),
                          }
                        : doc
                    )
                  );
                }}
              />
            ) : null}

            {activeTab?.type === "markdown" ? (
              <MarkdownViewer
                title={activeTab.title}
                documentId={activeDocument?.id}
                filePath={activeTab.filePath}
                content={activeTab.content || ""}
                language={settings.language}
                notes={activeNotes}
                onAddNote={(pageNo, content, kind, reference, source) => {
                  if (!activeTab.filePath) return;
                  addNote(activeTab.filePath, pageNo, content, kind, reference, source);
                }}
                onUpdateNote={(noteId, content) => {
                  if (!activeTab.filePath) return;
                  updateNote(activeTab.filePath, noteId, content);
                }}
                onRemoveNote={(noteId) => {
                  if (!activeTab.filePath) return;
                  removeNote(activeTab.filePath, noteId);
                }}
                aiModelConfig={aiModelConfig}
                onOpenExternal={handleOpenExternal}
                onContentChange={(next) => {
                  updateMarkdownTabContent(activeTab.id, next);
                }}
                onSave={async (next) => {
                  if (!activeTab.filePath) return;
                  try {
                    await saveMarkdownFile(activeTab.filePath, activeTab.fileId, next);
                    markMarkdownTabSaved(activeTab.filePath, next);
                    updateBusyMessage(
                      settings.language === "zh-CN" ? "Markdown 已保存" : "Markdown saved",
                      1800
                    );
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    updateBusyMessage(
                      settings.language === "zh-CN"
                        ? `Markdown 保存失败: ${message}`
                        : `Markdown save failed: ${message}`,
                      3200
                    );
                    throw error;
                  }
                }}
              />
            ) : null}

            {activeTab?.type === "web" ? (
              <WebBrowser
                tabId={activeTab.id}
                mode={settings.webPanelMode}
                quickLinks={settings.quickLinks}
                language={settings.language}
                initialUrl={activeTab.url || START_PAGE_URL}
                onUrlChange={(nextUrl) => updateTabUrl(activeTab.id, nextUrl)}
                onOpenPdfInApp={async (url) => {
                  await openPdfFromUrl(url, activeTab.id);
                }}
                onOpenExternal={(url) => {
                  void handleOpenExternal(url);
                }}
                onDownloadCurrent={async (url, options) => {
                  await downloadResourceToFile(url, options);
                }}
                onShowMessage={(message) => updateBusyMessage(message, 1800)}
              />
            ) : null}

            {activeTab?.type === "settings" ? (
              <Settings
                settings={settings}
                onThemeChange={setTheme}
                onSettingsChange={persistSettings}
                focusSection={settingsFocusSection}
                focusToken={settingsFocusToken}
              />
            ) : null}
          </div>
          </Suspense>
        </div>
      </div>
    </div>
  );
}
