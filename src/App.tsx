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
import { readDevAutoOpenPath, readDevAutoCloseAfterMs, readDevAutoCloseActions, readDevAutoCycle } from "./services/rustPdf";
// dev-only：worker 台账与画布统考。生产构建里该模块整段不执行（内部有 DEV 守卫）。
import { runtimeCensus, terminateWorkers } from "./services/devRuntimeCensus";
import {
  loadUserSettings,
  loadUserSettingsFromWorkspace,
  sanitizeUserSettings,
  saveUserSettings,
  saveUserSettingsToWorkspace,
  withDefaultDir,
  USER_SETTINGS_EVENT,
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
import { loadStoredApiKey, storeApiKey } from "./services/secretStore";
import { describeFileOpenError } from "./services/fileOpenError";
import { dismissCompanionBlock, dismissalForRemovedAnnotation, loadDismissedBlocks } from "./services/readingCompanion";
import { debugError, debugLog, debugWarn } from "./services/debugLogger";
import { resolveAccentToken } from "./theme/accent";
import type { LlmServiceConfig } from "./services/readingAssistant";
import { START_PAGE_URL } from "./constants/startPage";
import { downloadDirectHttpResource, downloadPdfToNativeTemp, downloadPdfViaProxy, removeManagedWebPdfTemp, DIRECT_PDF_MAX_BYTES } from "./services/webProxy";
import { importDocumentIntoWorkspace } from "./services/workspace";
import { documentIdForPath, documentPathKey, migrateDocumentArtifacts } from "./services/documentArtifacts";
import { getAppToasts } from "./services/appToasts";

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
    libraryTab: "资料库",
    collectionTab: "集合",
    settingsTab: "设置",
    webNewTab: "新建标签",
    startPageTab: "起始页",
    collectionPrompt: "集合名称",
    tabClose: "关闭标签",
    pinnedCannotClose: "已固定标签（无法关闭）",
    unsavedMarkdownClose: "此 Markdown 包含未保存修改，确定关闭标签吗？",
    openDocumentDialog: "打开文档",
    importFolderDialog: "导入文件夹",
    downloadFilterName: "下载文件",
  },
  "en-US": {
    libraryTab: "Library",
    collectionTab: "Collection",
    settingsTab: "Settings",
    webNewTab: "New Tab",
    startPageTab: "Start Page",
    collectionPrompt: "Collection name",
    tabClose: "Close tab",
    pinnedCannotClose: "Pinned tab (cannot close)",
    unsavedMarkdownClose: "This Markdown tab has unsaved changes. Close it anyway?",
    openDocumentDialog: "Open Document",
    importFolderDialog: "Import Folder",
    downloadFilterName: "Downloaded file",
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
  // 资料库侧栏默认展开：它是这个应用的起点（打开文件、集合、快捷链接都在这里），
  // 收起状态下首屏是一整块空白，用户第一眼看不到任何入口。
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
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
  /**
   * 右下角状态提示文案。与 uiText 分开是因为它有参数（文件名、数量、错误信息），
   * 形状是函数而不是字符串 —— 混在一张表里会让 `Record<Lang, …>` 变成联合类型，
   * 取值时处处要判别。判别成本只在一个地方付一次。
   */
  const toasts = useMemo(() => getAppToasts(settings.language), [settings.language]);
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
          ? toasts.localDataReadIssue({ key: warning.key })
          : toasts.localDataWriteIssue({ key: warning.key }),
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
  }, [toasts, updateBusyMessage]);

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
    // 必须显式 `dropApiKey: false`：`sanitizeUserSettings` 默认按「从磁盘 hydrate」处理，
    // 会把刚输入的 API Key 清成空串（表现为输入框打不进字）。落盘剥离由 saveUserSettings 负责。
    const clean = sanitizeUserSettings(next, { dropApiKey: false });
    setSettings(clean);
    saveUserSettings(clean);
    // 设置正文写进工作区文件（localStorage 只是降级缓存）。
    // fire-and-forget：磁盘写失败不该打断交互，内存态已经是新值。
    void saveUserSettingsToWorkspace(clean);
    // 密钥走工作区内的 0600 文件（localStorage 契约：永不落密钥）。
    // fire-and-forget，失败静默。
    void storeApiKey(clean.aiApiKey);
  }, []);

  /**
   * 启动时从工作区 hydrate 设置。
   *
   * 第一帧用 localStorage 同步渲染（避免设置面板先空白再闪），随后异步读工作区
   * 文件覆盖。localStorage 里可能有更旧的版本，所以这里**无条件**以文件为准 ——
   * 文件才是权威来源。
   *
   * 只在用户没动过设置时覆盖：hydrate 回来之前用户已经改了，文件就会把他刚敲的
   * 值倒回去，那比读到旧值更糟。
   */
  useEffect(() => {
    let canceled = false;
    let userTouchedSettings = false;
    const markTouched = () => {
      userTouchedSettings = true;
    };
    window.addEventListener(USER_SETTINGS_EVENT, markTouched);
    void loadUserSettingsFromWorkspace().then((fromWorkspace) => {
      if (canceled || !fromWorkspace) return;
      setSettings((prev) => (userTouchedSettings ? prev : { ...fromWorkspace, aiApiKey: prev.aiApiKey }));
      // 同步回 localStorage 降级缓存：下次启动第一帧就能直接读到，不必等异步 hydrate。
      saveUserSettings(fromWorkspace);
    });
    return () => {
      canceled = true;
      window.removeEventListener(USER_SETTINGS_EVENT, markTouched);
    };
  }, []);

  // 启动时从本地密钥文件恢复 API Key（会话内存 + 本地文件持久化的组合）。
  // 只回填内存态，不经过 saveUserSettings —— localStorage 与设置文件依旧零密钥。
  useEffect(() => {
    let canceled = false;
    void loadStoredApiKey().then((key) => {
      if (canceled || !key) return;
      setSettings((prev) => (prev.aiApiKey === key ? prev : { ...prev, aiApiKey: key }));
    });
    return () => {
      canceled = true;
    };
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
        updateBusyMessage(toasts.collectionExists, 1800);
        return prev;
      }
      return [...prev, { id, name: clean, paths: [], createdAt: new Date().toISOString() }];
    });
    pinLibraryTab(`collection:${id}`, clean);
  }, [pinLibraryTab, toasts, uiText.collectionPrompt, updateBusyMessage]);

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
        title: normalized === START_PAGE_URL ? uiText.startPageTab : normalized ? shortHostSafe(normalized) : uiText.webNewTab,
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
    [uiText.startPageTab, uiText.webNewTab]
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
          updateBusyMessage(markdown ? toasts.openingMarkdown : toasts.openingPdf);
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
        // ★ 不再直接甩原始串：那是「哪一层失败了」，而用户需要的是「下一步做什么」。
        // macOS TCC 拦受保护目录时有明确解法（改走「打开文件」对话框拿 powerbox 授权），
        // 分类与文案都在 services/fileOpenError.ts（纯函数、有单测）。
        updateBusyMessage(describeFileOpenError(error, settings.language), 3600);
        return false;
      } finally {
        openingPathsRef.current.delete(openKey);
        cancelledOpeningPathsRef.current.delete(openKey);
      }
    },
    [documents, releasePdfFileAfterTabCommit, settings.language, tabs, toasts, updateBusyMessage, upsertDocumentFromOpen]
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

  /**
   * dev-only：内存/性能量测的自动化入口 —— 环境变量 `R0NIX_AUTO_OPEN` 指定路径时，
   * 启动即打开它（**支持 `;` 分隔的多个路径，顺序打开**）。
   *
   * 为什么需要：真实 Tauri 的 IPC 路径（base64 编码 → 传输 → JS 解码）只能在真实
   * 应用进程里量，浏览器探针走 `file.arrayBuffer()` 会完全绕开它；而 macOS 上驱动
   * 真实应用的 UI 需要辅助功能权限（本机未授权）。
   *
   * 为什么支持多个：单个文档只能量到「瞬时峰值 → 回落」，量不到**驻留**。
   * pdf.js 的 `documentCache` 按 fileId 持有文档、worker 持有那份 `Uint8Array`，
   * 只要标签还开着，**每个已打开文档就固定占住一份原始字节 + 解码缓存** ——
   * 顺序打开 N 份大文档，才能看出「每多一份，驻留增加多少」，也才是
   * 「用了一段时间不下降」的真正形状。
   *
   * 双重守卫：`import.meta.env.DEV` 是编译期常量（生产构建里整段被 tree-shake），
   * 且 Rust 侧命令在 release 恒返回 null。
   *
   * ⚠️ 要让它生效，必须用 `cargo run --no-default-features` 启动。`src-tauri/Cargo.toml`
   * 里 `custom-protocol` 在 default features 中，而 tauri 的构建脚本是
   * `dev = !has_feature("custom-protocol")` —— 一旦 `custom-protocol` 生效（即默认
   * 的 `cargo run`），Tauri 就**忽略 devUrl、直接服务编译期嵌进二进制的 `dist/`**，
   * 于是跑的是上一次 `npm run build` 的产物：本段代码作为 DEV 分支已被 tree-shake，
   * 静默失效，症状是「什么都没发生」。
   *
   * 只执行一次：`openPdfByPath` 是 useCallback，其依赖随渲染变化会让本 effect 重跑，
   * 而每次重跑都会**把同一份文件重新打开一遍** —— 探针读数会被这种重复打开严重污染。
   */
  const autoOpenAttemptedRef = useRef(false);
  /**
   * `handleCloseTab` 的镜像，专供自动化钩子调用「**真实的**关标签」。
   *
   * 为什么必须是 ref：`handleCloseTab` 定义在本 effect **之后**（App 组件体里靠后），
   * 把它写进本 effect 的依赖数组会在渲染到本行时就命中 TDZ 而抛错。ref 在提交后由
   * 一个专门的 effect 赋值，异步回调里读到的永远是最新实现。
   *
   * 为什么不能用 `api.closeFile` 代替：那是**两件不同的事**。`closeFile` 只销毁
   * pdf.js 文档与 Rust 句柄，标签仍留在界面上、viewer 与它的画布都没卸载；
   * `handleCloseTab` 才移除标签、卸载 viewer，再排队释放文件 —— 也就是**用户按了
   * 关闭按钮**的那条路径。上一轮把前者当成「关标签」，读数因而无法指向真正的持有者。
   */
  const closeTabRef = useRef<((id: string) => void) | null>(null);
  useEffect(() => {
    // 与 PDFViewer / PageCanvas 里的 DEV_PROBE 同一写法：本项目没有引入 vite/client 类型，
    // `import.meta.env` 无类型声明，故用断言取编译期常量（生产构建里此分支被 tree-shake）。
    if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return;
    if (autoOpenAttemptedRef.current) return;
    autoOpenAttemptedRef.current = true;
    void (async () => {
      try {
        const raw = await readDevAutoOpenPath();
        if (!raw) return;
        const paths = raw
          .split(";")
          .map((value) => value.trim())
          .filter(Boolean);
        if (paths.length === 0) return;
        debugLog("api.autoOpen", "effect mounted", { count: paths.length });
        // 关闭**动作**清单（`R0NIX_AUTO_CLOSE_ACTIONS`）。不设时默认 `["file"]`，
        // 与历史行为一致：只销毁文档，**不**移除标签。
        const closeActions = (await readDevAutoCloseActions()) ?? ["file"];
        const closeAfterMs = await readDevAutoCloseAfterMs();
        // 循环模式（`R0NIX_AUTO_CYCLE=1`）：每打开一份就立刻关掉它 —— 于是「文档数」
        // 等于「轮数」，在**同一个进程**里重复「打开 → 关闭」。
        const cycleMode = await readDevAutoCycle();
        debugLog("api.autoOpen", "plan", {
          paths: paths.length,
          cycleMode,
          closeAfterMs,
          closeActions,
        });

        /**
         * 关闭一份「自动打开」的文档：定位它的标签 → 按清单执行动作 → 前后各留一次普查。
         *
         * 抽成闭包是有意的：它有两个调用方 —— 常规的「全部打开后再关」，以及循环模式
         * 的「每打开一份就关掉它」。两处各写一遍迟早会漂移成两套语义，而这一段的
         * 每个细节都是踩出来的（见下面两处 ⚠️）。
         */
        const closeAutoOpenedPath = async (autoOpenPath: string) => {
          // 复用项目既有的 `latestTabsRef`（`openPdfByPath` 的失败分支用的是同一招）：
          // 闭包里的 `tabs` 是 effect 建立那一刻的快照，异步回调里必然过期。
          //
          // ⚠️ 必须**轮询等标签登记出来**，不能只看一眼。clean store 下实测
          // `candidateCount: 0`（那一刻 `latestTabsRef` 里只有 1 条），根因是打开一份
          // 大扫描件后主线程被 canvas 渲染占满，把 `tabs` 镜像进 ref 的那个 passive
          // effect 被推迟到几百毫秒之后 —— 固定 300ms 会**静默跳过关闭**，读数于是与
          // 「不关」组几乎一致，最容易被误读成「关闭不释放内存」。
          //
          // ⚠️ 还要遍历**全部**同路径标签再挑带 `fileId` 的那条：同一路径可能存在多条
          // 标签（历史遗留的无 `fileId` 标签会排在前面，`find` 恰好取到它）。
          const closeDeadline = Date.now() + 8000;
          let candidates: Tab[] = [];
          let tab: Tab | null = null;
          while (!tab) {
            candidates = latestTabsRef.current.filter(
              (item) => item.filePath && samePath(item.filePath, autoOpenPath),
            );
            tab = [...candidates].reverse().find((item) => item.fileId) ?? null;
            if (tab || Date.now() >= closeDeadline) break;
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          // 找不到也要留痕：静默跳过会把「钩子失效」伪装成「什么都没发生」，
          // 这正是本 session 反复踩到的同一类坑。
          debugLog("api.autoOpen", "closing", {
            autoOpenPath,
            candidateCount: candidates.length,
            tabId: tab?.id ?? null,
            hasFileId: Boolean(tab?.fileId),
            tabCount: latestTabsRef.current.length,
          });
          if (!tab || !tab.fileId) return;
          // 「关闭前」的人口普查：此刻文档已开、标签仍在 —— 这就是「不关」那一档的形态。
          // worker 的 `pending` 数与画布/DOM 的普查是**唯一**能把「残留归谁」分开的证据：
          // 它们都落在 WebContent 的 footprint 里，进程读数完全是同一个数。
          debugLog("api.autoOpen", "census · 关闭前", runtimeCensus());
          for (const action of closeActions) {
            if (action === "file") {
              // 只销毁 pdf.js 文档与 Rust 句柄；**标签仍在界面上**，viewer 与画布都没卸载。
              await api.closeFile(tab.fileId);
            } else if (action === "tab") {
              // 真实关标签：移除标签 → 卸载 viewer → 排队释放文件句柄。
              closeTabRef.current?.(tab.id);
              // 等 React 提交：标签要先从 state 里消失，viewer 才会卸载。500ms 够 ——
              // `releasePdfFileAfterTabCommit` 的 `setTimeout(…, 0)` 与 passive effect
              // 都在这个量级（这个钩子此处的 300ms 让位实测已够）。
              await new Promise((resolve) => setTimeout(resolve, 500));
            } else if (action === "workers") {
              // 强制终结全部仍在世的 worker，并回读台账 —— `pending` 归零才算数。
              debugLog("api.autoOpen", "terminateWorkers", terminateWorkers());
            } else {
              // 拼错的动作名必须留痕：静默忽略会让整组对照失去意义，
              // 症状是「跑了两组、读数一样」，最容易被读成结论。
              debugLog("api.autoOpen", "unknown close action", { action, closeActions });
            }
          }
          debugLog("api.autoOpen", "census · 关闭后", { actions: closeActions, ...runtimeCensus() });
        };
        // 顺序打开（不是并发）：并发会让两份文档的瞬时峰值叠在一起，
        // 分不清「单份峰值」与「累积驻留」。
        // ⚠️ 实测（探针复核）：多路径时**第二份之后 `openPdfByPath` 不再 resolve**
        // —— `rust open_pdf success` 已打出，但循环里的 `opened` 不打印，于是循环卡在
        // 第二份，**后面的关闭阶段永远到不了**。探针的「打开后立即关闭」组就是这样
        // 静默失效的：读数与「不关」组几乎一致才暴露出来。
        // 结论：**关闭组必须用单路径**（`PROBE_TAURI_DOCS=1`）；要量「多份驻留」就
        // 用多路径、但别同时配 `R0NIX_AUTO_CLOSE_MS`。内因未查明（PDF 分支本身很短：
        // `api.openFile` → `upsertDocumentFromOpen` → `return true`）。
        for (const autoOpenPath of paths) {
          await openPdfByPath(autoOpenPath, undefined, { silentBusy: true });
          debugLog("api.autoOpen", "opened", { autoOpenPath });
          // 循环模式：每打开一份立刻关掉，重复 N 轮（N = 文档数）。这是区分
          // **泄漏**（每轮线性累加）与**水位**（首次冲高后复用、不再增长）的唯一
          // 可靠对照 —— 跨会话比较受系统内存压力影响，能差出几百 MB。
          if (cycleMode) await closeAutoOpenedPath(autoOpenPath);
        }
        // 常规第二阶段：把刚打开的文档再关掉。
        // 打开只能量出「驻留多少」，关闭才能分开「按设计驻留（关掉就还）」与「泄漏」。
        // ⚠️ 延迟用的是页面定时器，而 WKWebView 对**不可见窗口**会节流 `setTimeout`：
        // 窗口被遮挡时长定时器实测根本不触发（钩子静默失效）。所以 `0` 是有用的取值 ——
        // 「打开后立即关闭」，不走定时器，适合用 A/B 两次运行比较释放量。
        //
        // 循环模式下这一阶段**必须跳过**：那时每份文档在打开的当下就被关掉了，标签
        // 早已不在，再来一轮只会打出 `hasFileId: false` 的「找不到」日志，把
        // 「已经关完了」伪装成「关不掉」。
        if (cycleMode) {
          debugLog("api.autoOpen", "cycles done", { cycles: paths.length, closeActions });
        } else if (closeAfterMs !== null) {
          // 让出一拍再开始找标签（`closeAfterMs` 为 0 时也要让）。
          await new Promise((resolve) => setTimeout(resolve, Math.max(closeAfterMs, 300)));
          debugLog("api.autoOpen", "closing start", { count: paths.length });
          for (const autoOpenPath of paths) {
            await closeAutoOpenedPath(autoOpenPath);
          }
        }
      } catch (error) {
        // 自动化钩子不该影响正常启动（不向 UI 抛错），但**必须留下诊断**：
        // 这条链路一旦失败，症状就是「什么都没发生」，静默等于把失败伪装成正常。
        debugError("api.autoOpen", "failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    // 故意不返回 cleanup：`openPdfByPath` 是 useCallback，identity 随渲染变化 →
    // 本 effect 的 cleanup 会在**第一份文档刚打开后**就执行。若把 cleanup 里的
    // `cancelled` 当早退条件，多文档循环会在第一份之后被判定为「已取消」，第二份
    // 永远不开始 —— 症状是日志停在第一份 `opened`，且没有任何报错。单文档场景下
    // 这个坑不可见，只有多文档才暴露。一次性钩子用 ref 守卫足够。
  }, [openPdfByPath]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const droppedPath = event.payload.paths.find(isSupportedDropPath);
        if (!droppedPath) {
          updateBusyMessage(toasts.dropUnsupportedFile, 2400);
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
  }, [openPdfByPath, toasts, updateBusyMessage]);

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
        updateBusyMessage(toasts.noDownloadUrl, 1800);
        return null;
      }
      try {
        updateBusyMessage(options?.preferPdf ? toasts.downloadingPdf : toasts.downloadingResource);

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
          updateBusyMessage(toasts.downloaded({ fileName }), 2200);
          return { savePath: "", fileName, finalUrl };
        }
        const savePath = await save({
          defaultPath: withDefaultDir(fileName, settings.defaultSaveDir),
          filters: [
            {
              name: options?.preferPdf ? "PDF" : uiText.downloadFilterName,
              extensions: options?.preferPdf ? ["pdf"] : [],
            },
          ],
        });
        if (!savePath || typeof savePath !== "string") {
          updateBusyMessage(toasts.downloadCancelled, 1500);
          return null;
        }
        await writeNativeBinaryFile(savePath, new Uint8Array(bytes));
        updateBusyMessage(toasts.saved({ fileName }), 2200);
        return { savePath, fileName, finalUrl };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateBusyMessage(toasts.downloadFailed({ message }), 3600);
        return null;
      }
    },
    [settings.defaultSaveDir, settings.proxyEnabled, settings.proxyUrl, toasts, uiText.downloadFilterName, updateBusyMessage]
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
            updateBusyMessage(toasts.downloadingPdfFromUrl);
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
          // openPdfByPath 已经提示过一次，这里用同一份文案覆盖而不是再甩一条原始串 ——
          // 否则用户先看到可行动的提示、随即被一条 errno 盖掉。
          updateBusyMessage(describeFileOpenError(error, settings.language), 3600);
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
    [openPdfByPath, settings.language, settings.proxyEnabled, settings.proxyUrl, toasts, updateBusyMessage, upsertDocumentFromOpen]
  );

  /**
   * 把文件复制进工作区，返回工作区内的稳定路径；失败则退回原路径。
   *
   * 「资料库」和「最近打开」的区别就在这一步：只存原路径的话，原件被移动、
   * 改名或从下载目录清掉之后，列表里的条目就全成了死链。复制一份进来，
   * 用户换机器、备份工作区就能带走整个库。
   *
   * 复制失败**不阻断导入** —— 用户此刻真正想看到的是这份文档能打开，
   * 而不是一条「存储空间不足」。原路径仍然可用，只是它不属于资料库。
   */
  const localizeDocumentPath = useCallback(async (path: string) => {
    if (!isTauriRuntime()) return path;
    const managed = await importDocumentIntoWorkspace(path).catch((error) => {
      debugWarn("workspace.import", "failed to copy the document into the workspace", {
        path,
        error,
      });
      return null;
    });
    return managed || path;
  }, []);

  const openPdfDialog = useCallback(async () => {
    if (isTauriRuntime()) {
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: "Documents", extensions: ["pdf", "md", "markdown"] }],
          title: uiText.openDocumentDialog,
        });
        if (typeof selected === "string") {
          // 先复制进工作区再打开：打开原路径会让资料库里留下一个指向
          // 下载目录 / 外接硬盘的死链，文件一被清理就打不开了。
          const managed = await localizeDocumentPath(selected);
          await openPdfByPath(managed);
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
      updateBusyMessage(markdown ? toasts.openingMarkdown : toasts.openingPdf);
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
      updateBusyMessage(describeFileOpenError(error, settings.language), 3600);
    }
  }, [localizeDocumentPath, openPdfByPath, settings.language, toasts, updateBusyMessage, upsertDocumentFromOpen]);

  const importFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: uiText.importFolderDialog });
      if (typeof selected !== "string" || !selected.trim()) return;
      updateBusyMessage(toasts.scanningFolder);
      const pdfPaths = await collectNativeImportablePaths(selected);
      if (pdfPaths.length === 0) {
        updateBusyMessage(toasts.noDocumentsInFolder, 2200);
        return;
      }
      // 逐份复制而非一次性全量：几百份 PDF 同时复制会长时间占住主线程等待，
      // 而且中途失败时无法告诉用户「哪几份进来了」。串行 + 单份失败可跳过。
      let imported = 0;
      for (const path of pdfPaths) {
        const managedPath = await localizeDocumentPath(path);
        upsertDocumentStub(managedPath);
        if (managedPath !== path) imported += 1;
      }
      const total = pdfPaths.length;
      const copied = imported === total ? "" : ` (${imported}/${total} copied locally)`;
      updateBusyMessage(toasts.importedDocuments({ count: total, copied }), 2800);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateBusyMessage(toasts.importFailed({ message }), 3200);
    }
  }, [localizeDocumentPath, toasts, uiText.importFolderDialog, updateBusyMessage, upsertDocumentStub]);

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

  // dev-only：把真实的关标签实现镜像进 ref，供 `R0NIX_AUTO_CLOSE_ACTIONS=tab` 使用。
  // 放在定义之后，避开 TDZ；identity 变化时同步刷新。
  useEffect(() => {
    closeTabRef.current = handleCloseTab;
  }, [handleCloseTab]);

  const handleOpenExternal = useCallback(async (url: string) => {
    const normalized = normalizeHttpUrl(url);
    if (!normalized) {
      updateBusyMessage(toasts.externalLinkHttpOnly, 2600);
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
      updateBusyMessage(toasts.externalLinkFailed({ message }), 3200);
    }
  }, [toasts, updateBusyMessage]);

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
      updateBusyMessage(toasts.movedToTrash, 1800);
    },
    [toasts, updateBusyMessage]
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

      updateBusyMessage(toasts.permanentlyDeleted({ count: targets.length }), 2200);
    },
    [documents, releasePdfFileAfterTabCommit, removeDocumentTabs, toasts, updateBusyMessage]
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
      updateBusyMessage(toasts.restoredFromTrash({ count: idSet.size }), 2000);
    },
    [toasts, updateBusyMessage]
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
        updateBusyMessage(toasts.nothingToExport, 1600);
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
          updateBusyMessage(toasts.exportCancelled, 1500);
          return;
        }

        const finalPath = /\.(csv|json)$/i.test(selectedPath) ? selectedPath : `${selectedPath}.csv`;
        const content = finalPath.toLowerCase().endsWith(".json")
          ? JSON.stringify(docs.map(({ fileId, ...doc }) => doc), null, 2)
          : documentsToCsv(docs);

        await writeNativeTextFile(finalPath, content);
        updateBusyMessage(toasts.exported({ count: docs.length }), 2200);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateBusyMessage(toasts.exportFailed({ message }), 3200);
      }
    },
    [settings.defaultSaveDir, toasts, updateBusyMessage]
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
          ? uiText.startPageTab
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
    [uiText.startPageTab, uiText.webNewTab]
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
          onTabsReorder={(nextTabs) => {
            // 排序只改顺序，不改内容。用函数式更新而不是闭包里的 `tabs`：
            // 拖拽过程中 onReorder 会连续触发，闭包值可能是上一帧的。
            //
            // ⚠️ 不用 latestTabsRef 兜底：Reorder 的 onReorder 回传的是**完整新数组**
            //（库的 Group.mjs 里 `newOrder.map(getValue).filter(...)`），不是局部增量。
            // 局部增量会让 tabs 丢掉未出现在增量里的标签。
            setTabs(nextTabs);
          }}
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
                {toasts.loadingView}
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
                companionIntensity={settings.companionIntensity}
                companionAutoAnnotate={settings.companionAutoAnnotate}
                companionMarkerIntensity={settings.companionAutoAnnotateIntensity}
                companionQuickAsk={settings.companionQuickAsk}
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
                    updateBusyMessage(toasts.markdownSaved, 1800);
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    updateBusyMessage(toasts.markdownSaveFailed({ message }), 3200);
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
