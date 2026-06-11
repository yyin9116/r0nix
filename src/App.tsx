import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { tempDir } from "@tauri-apps/api/path";
import { readDir, writeFile } from "@tauri-apps/plugin-fs";
import { AnimatePresence, motion } from "motion/react";
import { Sidebar } from "./components/Sidebar";
import { Tabs } from "./components/Tabs";
import { Library, LIBRARY_SEARCH_FOCUS_EVENT } from "./components/Library";
import { PDFViewer } from "./components/PDFViewer";
import { MarkdownViewer } from "./components/MarkdownViewer";
import { Whiteboards } from "./components/Whiteboards";
import { WebBrowser } from "./components/WebBrowser";
import { Settings } from "./components/Settings";
import type { LibraryFilter, ReaderAnnotation, ReaderCollection, ReaderDocument, ReaderNote, Tab } from "./types";
import * as api from "./services/pdfApi";
import {
  loadUserSettings,
  sanitizeUserSettings,
  saveUserSettings,
  withDefaultDir,
  type AppLanguage,
  type ThemeAccent,
  type UserSettings,
} from "./services/userSettings";
import { canUseNativeWebview, closeNativeWebviewTab } from "./services/nativeWebview";
import { START_PAGE_URL } from "./constants/startPage";
import { downloadPdfViaProxy } from "./services/webProxy";

const DOCUMENTS_KEY = "r0nix_reader_documents_v2";
const COLLECTIONS_KEY = "r0nix_reader_collections_v1";
const NOTES_KEY = "r0nix_reader_notes_v1";
const ANNOTATIONS_KEY = "r0nix_reader_annotations_v1";
const PINNED_TABS: Tab[] = [
  { id: "library-main", type: "library", title: "Library", filter: "all", pinned: true },
];
const DEFAULT_ACTIVE_TAB_ID = "library-main";

const ACCENT_TOKENS: Record<ThemeAccent, { solid: string; soft: string; contrast: string }> = {
  zinc: { solid: "#52525b", soft: "rgba(82, 82, 91, 0.16)", contrast: "#ffffff" },
  blue: { solid: "#2563eb", soft: "rgba(37, 99, 235, 0.14)", contrast: "#ffffff" },
  green: { solid: "#059669", soft: "rgba(5, 150, 105, 0.14)", contrast: "#ffffff" },
  orange: { solid: "#ea580c", soft: "rgba(234, 88, 12, 0.14)", contrast: "#ffffff" },
  rose: { solid: "#e11d48", soft: "rgba(225, 29, 72, 0.14)", contrast: "#ffffff" },
  violet: { solid: "#7c3aed", soft: "rgba(124, 58, 237, 0.14)", contrast: "#ffffff" },
};

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
  },
} as const;

function getUiText(language: AppLanguage) {
  return APP_I18N[language];
}

function samePath(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `https://${value}`;
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

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

function makeDocumentId(path: string) {
  return `doc-${path.trim().toLowerCase()}`;
}

function makeNoteStorageKey(path: string) {
  return path.trim().toLowerCase();
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
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DOCUMENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<ReaderDocument>>;
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
        lastOpenedAt:
          typeof item.lastOpenedAt === "string" && item.lastOpenedAt
            ? item.lastOpenedAt
            : new Date().toISOString(),
        trashedAt: typeof item.trashedAt === "string" && item.trashedAt ? item.trashedAt : undefined,
      }))
      .sort((left, right) => new Date(right.lastOpenedAt).getTime() - new Date(left.lastOpenedAt).getTime());
  } catch {
    return [];
  }
}

function loadStoredCollections(): ReaderCollection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(COLLECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<ReaderCollection>>;
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
  } catch {
    return [];
  }
}

function loadStoredNotes(): Record<string, ReaderNote[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Array<Partial<ReaderNote>>>;
    const next: Record<string, ReaderNote[]> = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (!Array.isArray(value)) continue;
      next[key] = value
        .filter((item) => typeof item?.id === "string" && typeof item?.content === "string")
        .map((item): ReaderNote => ({
          id: item.id as string,
          page: typeof item.page === "number" ? Math.max(1, Math.round(item.page)) : 1,
          kind: item.kind === "summary" || item.kind === "highlight" ? item.kind : "note",
          content: item.content as string,
          createdAt:
            typeof item.createdAt === "string" && item.createdAt ? item.createdAt : new Date().toISOString(),
        }))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    }
    return next;
  } catch {
    return {};
  }
}

function loadStoredAnnotations(): Record<string, ReaderAnnotation[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ANNOTATIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Array<Partial<ReaderAnnotation>>>;
    const next: Record<string, ReaderAnnotation[]> = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (!Array.isArray(value)) continue;
      next[key] = value
        .filter((item) => typeof item?.id === "string" && typeof item?.page === "number")
        .map((item): ReaderAnnotation | null => {
          const rect = item.rect;
          const validRect =
            rect &&
            typeof rect.x === "number" &&
            typeof rect.y === "number" &&
            typeof rect.width === "number" &&
            typeof rect.height === "number";
          const kind = item.kind;
          if (!validRect) return null;
          if (kind !== "highlight" && kind !== "underline" && kind !== "strike" && kind !== "text") return null;
          return {
            id: item.id as string,
            page: Math.max(1, Math.round(item.page as number)),
            kind,
            rect: {
              x: Math.max(0, Math.min(1, rect.x)),
              y: Math.max(0, Math.min(1, rect.y)),
              width: Math.max(0.002, Math.min(1, rect.width)),
              height: Math.max(0.002, Math.min(1, rect.height)),
            },
            content: typeof item.content === "string" ? item.content : undefined,
            createdAt:
              typeof item.createdAt === "string" && item.createdAt ? item.createdAt : new Date().toISOString(),
          };
        })
        .filter((item): item is ReaderAnnotation => Boolean(item))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    }
    return next;
  } catch {
    return {};
  }
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

function joinPath(dir: string, fileName: string) {
  if (!dir) return fileName;
  const normalized = dir.endsWith("/") || dir.endsWith("\\") ? dir.slice(0, -1) : dir;
  const separator = normalized.includes("\\") ? "\\" : "/";
  return `${normalized}${separator}${fileName}`;
}

function shortHostSafe(url: string) {
  try {
    return new URL(normalizeUrl(url)).host;
  } catch {
    return url;
  }
}

interface FsDirEntry {
  path?: string;
  name?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  children?: FsDirEntry[];
}

function isImportablePath(path: string) {
  const lowered = path.trim().toLowerCase();
  return lowered.endsWith(".pdf") || lowered.endsWith(".md") || lowered.endsWith(".markdown");
}

async function collectPdfPaths(root: string): Promise<string[]> {
  const results = new Set<string>();
  const normalizedRoot = root.trim();
  const isWindowsRootLike = /^[a-zA-Z]:[\\/]*$/.test(normalizedRoot);
  const prefersBackslash = normalizedRoot.includes("\\") || isWindowsRootLike;

  const resolveEntryPath = (parent: string, entry: FsDirEntry) => {
    if (typeof entry.path === "string" && entry.path.trim()) {
      return entry.path;
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      return "";
    }
    return joinPath(parent, entry.name.trim());
  };

  const toQueuePath = (raw: string) => {
    if (!raw) return "";
    return prefersBackslash ? raw.replace(/\//g, "\\") : raw.replace(/\\/g, "/");
  };

  const collectFromTree = (entries: FsDirEntry[], parent: string) => {
    const stack: Array<{ entry: FsDirEntry; parent: string }> = entries.map((entry) => ({ entry, parent }));
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const { entry, parent: currentParent } = current;
      const entryPath = resolveEntryPath(currentParent, entry);
      if (entryPath && isImportablePath(entryPath)) {
        results.add(toQueuePath(entryPath));
      }
      if (Array.isArray(entry.children) && entry.children.length > 0) {
        for (const child of entry.children) {
          stack.push({ entry: child, parent: entryPath || currentParent });
        }
      }
    }
  };

  try {
    const recursiveEntries = (await readDir(root)) as unknown as FsDirEntry[];
    collectFromTree(recursiveEntries, normalizedRoot);
    if (results.size > 0) {
      return Array.from(results);
    }
  } catch {
    // Fall through to conservative manual traversal.
  }

  const queue: string[] = [normalizedRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    let entries: FsDirEntry[] = [];
    try {
      entries = (await readDir(current)) as unknown as FsDirEntry[];
    } catch {
      // Tolerate inaccessible node and continue scanning others.
      continue;
    }

    for (const entry of entries) {
      const entryPath = resolveEntryPath(current, entry);
      if (!entryPath) continue;

      if (isImportablePath(entryPath)) {
        results.add(toQueuePath(entryPath));
        continue;
      }

      if (entry.isDirectory) {
        queue.push(toQueuePath(entryPath));
      } else if (Array.isArray(entry.children) && entry.children.length > 0) {
        collectFromTree(entry.children, entryPath);
      } else if (!entry.isFile) {
        try {
          const nested = (await readDir(entryPath)) as unknown as FsDirEntry[];
          if (nested.length > 0) {
            queue.push(toQueuePath(entryPath));
          }
        } catch {
          // not a directory or inaccessible node
        }
      }
    }
  }

  return Array.from(results);
}
export default function App() {
  const [settings, setSettings] = useState<UserSettings>(() => loadUserSettings());
  const [theme, setTheme] = useState<"light" | "dark">(() => resolveTheme(loadUserSettings().themeMode));
  const [documents, setDocuments] = useState<ReaderDocument[]>(loadStoredDocuments);
  const [collections, setCollections] = useState<ReaderCollection[]>(loadStoredCollections);
  const [notesByDocument, setNotesByDocument] = useState<Record<string, ReaderNote[]>>(loadStoredNotes);
  const [annotationsByDocument, setAnnotationsByDocument] = useState<Record<string, ReaderAnnotation[]>>(loadStoredAnnotations);
  const [tabs, setTabs] = useState<Tab[]>(PINNED_TABS);
  const [activeTabId, setActiveTabId] = useState(DEFAULT_ACTIVE_TAB_ID);
  const [busyMessage, setBusyMessage] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [settingsFocusSection, setSettingsFocusSection] = useState<"quick-links" | null>(null);
  const [settingsFocusToken, setSettingsFocusToken] = useState(0);

  const busyTimerRef = useRef<number | null>(null);
  const progressRef = useRef<Record<string, { page: number; totalPages: number }>>({});
  const webTabIdsRef = useRef<string[]>([]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [activeTabId, tabs]);
  const activeFilter: LibraryFilter = activeTab?.type === "library" ? activeTab.filter || "all" : "all";
  const activePanelKey = activeTab ? `${activeTab.type}-${activeTab.id}` : "empty";
  const accent = ACCENT_TOKENS[settings.themeAccent] || ACCENT_TOKENS.zinc;
  const resolvedAccent = useMemo(() => {
    if (settings.themeAccent !== "zinc") return accent;
    return theme === "dark"
      ? { solid: "#f4f4f5", soft: "rgba(244, 244, 245, 0.12)", contrast: "#18181b" }
      : { solid: "#18181b", soft: "rgba(24, 24, 27, 0.08)", contrast: "#ffffff" };
  }, [accent, settings.themeAccent, theme]);
  const uiText = useMemo(() => getUiText(settings.language), [settings.language]);

  const appStyle = useMemo(
    () =>
      ({
        "--reader-accent": resolvedAccent.solid,
        "--reader-accent-soft": resolvedAccent.soft,
        "--reader-accent-contrast": resolvedAccent.contrast,
      }) as CSSProperties,
    [resolvedAccent]
  );

  const activeNotes = useMemo(() => {
    if (!activeTab?.filePath || activeTab.type !== "pdf") return [];
    return notesByDocument[makeNoteStorageKey(activeTab.filePath)] || [];
  }, [activeTab?.filePath, activeTab?.type, notesByDocument]);
  const activeAnnotations = useMemo(() => {
    if (!activeTab?.filePath || activeTab.type !== "pdf") return [];
    return annotationsByDocument[makeNoteStorageKey(activeTab.filePath)] || [];
  }, [activeTab?.filePath, activeTab?.type, annotationsByDocument]);

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
    void closeNativeWebviewTab(tabId).catch(() => {
      // ignore transient close errors
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const serializable = documents.map(({ fileId, ...doc }) => doc);
    window.localStorage.setItem(DOCUMENTS_KEY, JSON.stringify(serializable));
  }, [documents]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(collections));
  }, [collections]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(NOTES_KEY, JSON.stringify(notesByDocument));
  }, [notesByDocument]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ANNOTATIONS_KEY, JSON.stringify(annotationsByDocument));
  }, [annotationsByDocument]);

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
          ? { ...tab, content: nextContent }
          : tab
      )
    );
  }, []);

  const saveMarkdownFile = useCallback(
    async (path: string, fileId: string | undefined, content: string) => {
      if (isTauriRuntime()) {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(path, content);
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
    (url?: string) => {
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
        if (existing) {
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
        id: existing?.id || makeDocumentId(path),
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
    (payload: { title: string; path: string; fileId?: string; pageCount: number; kind: "pdf" | "markdown"; content?: string }) => {
      const now = new Date().toISOString();
      const nextId = makeDocumentId(payload.path);

      setDocuments((prev) => {
        const existing = prev.find((item) => samePath(item.path, payload.path));
        const nextItem: ReaderDocument = {
          id: nextId,
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
          lastOpenedAt: now,
          trashedAt: existing?.trashedAt,
          fileId: payload.fileId,
        };
        const rest = prev.filter((item) => !samePath(item.path, payload.path));
        return [nextItem, ...rest];
      });

      setTabs((prev) => {
        const existing = prev.find(
          (item) =>
            (item.type === "pdf" || item.type === "markdown") &&
            item.filePath &&
            samePath(item.filePath, payload.path)
        );
        if (existing) {
          const updated: Tab[] = prev.map((item): Tab => {
            if (item.id !== existing.id) return item;
            return {
              ...item,
              type: (payload.kind === "markdown" ? "markdown" : "pdf") as Tab["type"],
              title: payload.title,
              filePath: payload.path,
              fileId: payload.fileId,
              content: payload.kind === "markdown" ? payload.content : undefined,
            };
          });
          setActiveTabId(existing.id);
          return updated;
        }

        const nextTab: Tab = {
          id: `${payload.kind}-${Date.now()}`,
          type: payload.kind === "markdown" ? "markdown" : "pdf",
          title: payload.title,
          filePath: payload.path,
          fileId: payload.fileId,
          content: payload.kind === "markdown" ? payload.content : undefined,
          pinned: false,
        };
        setActiveTabId(nextTab.id);
        return [...prev, nextTab];
      });
    },
    []
  );

  const openPdfByPath = useCallback(
    async (path: string, preferredTitle?: string, options?: { silentBusy?: boolean }) => {
      if (!path.trim()) return false;
      const markdown = isMarkdownPath(path);
      const existingDoc = documents.find((item) => samePath(item.path, path));
      try {
        if (!options?.silentBusy) {
          updateBusyMessage(markdown ? "Opening Markdown..." : "Opening PDF...");
        }

        if (markdown) {
          const fileInfo = await api.openMarkdownFile(path);
          const markdownText = await api.readMarkdownText(fileInfo.path);
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
        }

        const fileInfo = await api.openFile(path);
        upsertDocumentFromOpen({
          title: preferredTitle || fileInfo.name || fileNameFromPath(fileInfo.path),
          path: fileInfo.path,
          fileId: fileInfo.id,
          pageCount: fileInfo.meta.pages || 1,
          kind: "pdf",
        });

        if (existingDoc?.fileId && existingDoc.fileId !== fileInfo.id) {
          void api.closeFile(existingDoc.fileId).catch(() => {
            // ignore old handle close failures
          });
        }

        updateBusyMessage("", 120);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateBusyMessage(`Failed to open file: ${message}`, 3200);
        return false;
      }
    },
    [documents, updateBusyMessage, upsertDocumentFromOpen]
  );
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
          const response = await fetch(normalized);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          bytes = await response.arrayBuffer();
          finalUrl = response.url || normalized;
          contentDisposition = response.headers.get("content-disposition") || "";
        }

        const fileName = guessPdfFileName(finalUrl, contentDisposition);
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
        await writeFile(savePath, new Uint8Array(bytes));
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
    async (rawUrl: string) => {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) return false;
      try {
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
          const response = await fetch(normalized);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          bytes = await response.arrayBuffer();
          finalUrl = response.url || normalized;
          contentDisposition = response.headers.get("content-disposition") || "";
        }

        const fileName = guessPdfFileName(finalUrl, contentDisposition);
        const tempRoot = await tempDir();
        const tempPath = joinPath(tempRoot, `r0nix-web-${Date.now()}-${fileName}`);
        await writeFile(tempPath, new Uint8Array(bytes));
        return await openPdfByPath(tempPath, fileName.replace(/\.pdf$/i, ""), { silentBusy: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateBusyMessage(`Failed to open PDF URL: ${message}`, 3600);
        return false;
      }
    },
    [openPdfByPath, settings.proxyEnabled, settings.proxyUrl, updateBusyMessage]
  );

  const openPdfDialog = useCallback(async () => {
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
      // fall back to browser file input below
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
      let markdownText = "";
      if (markdown) {
        markdownText = await api.readMarkdownText(opened.path);
      }
      upsertDocumentFromOpen({
        title: opened.name.replace(/\.(pdf|md|markdown)$/i, ""),
        path: opened.path,
        fileId: opened.id,
        pageCount: markdown ? 1 : opened.meta.pages || 1,
        kind: markdown ? "markdown" : "pdf",
        content: markdown ? markdownText : undefined,
      });
      updateBusyMessage("", 120);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateBusyMessage(`Failed to open file: ${message}`, 3200);
    }
  }, [openPdfByPath, updateBusyMessage, upsertDocumentFromOpen]);

  const importFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Import Folder" });
    if (typeof selected !== "string" || !selected.trim()) return;
    try {
      updateBusyMessage("Scanning folder...");
      const pdfPaths = await collectPdfPaths(selected);
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
      setTabs((prev) => {
        const closing = prev.find((item) => item.id === id);
        if (!closing) return prev;
        if (closing.type === "web") {
          closeWebTabNative(closing.id);
        }

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
    [activeTabId, closeWebTabNative]
  );

  const handleOpenExternal = useCallback(async (url: string) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    if (canUseNativeWebview()) {
      const shell = await import("@tauri-apps/plugin-shell");
      await shell.open(normalized);
      return;
    }
    window.open(normalized, "_blank", "noopener,noreferrer");
  }, []);

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
    [activeTabId]
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
          delete next[makeNoteStorageKey(target.path)];
        }
        return next;
      });
      setAnnotationsByDocument((prev) => {
        const next = { ...prev };
        for (const target of targets) {
          delete next[makeNoteStorageKey(target.path)];
        }
        return next;
      });

      for (const target of targets) {
        delete progressRef.current[makeNoteStorageKey(target.path)];
        if (target.fileId) {
          void api.closeFile(target.fileId).catch(() => {
            // ignore handle close failures during deletion
          });
        }
      }

      updateBusyMessage(
        targets.length === 1 ? "Document permanently deleted" : `Permanently deleted ${targets.length} documents`,
        2200
      );
    },
    [documents, removeDocumentTabs, updateBusyMessage]
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

        await writeFile(finalPath, new TextEncoder().encode(content));
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

  const addNote = useCallback((path: string, page: number, content: string, kind: ReaderNote["kind"] = "note") => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const storageKey = makeNoteStorageKey(path);
    const nextNote: ReaderNote = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      page,
      kind,
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    setNotesByDocument((prev) => ({ ...prev, [storageKey]: [nextNote, ...(prev[storageKey] || [])] }));
  }, []);

  const removeNote = useCallback((path: string, noteId: string) => {
    const storageKey = makeNoteStorageKey(path);
    setNotesByDocument((prev) => ({
      ...prev,
      [storageKey]: (prev[storageKey] || []).filter((note) => note.id !== noteId),
    }));
  }, []);

  const addAnnotation = useCallback(
    (
      path: string,
      annotation: Omit<ReaderAnnotation, "id" | "createdAt">
    ) => {
      const storageKey = makeNoteStorageKey(path);
      const nextAnnotation: ReaderAnnotation = {
        ...annotation,
        id: `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      };
      setAnnotationsByDocument((prev) => ({
        ...prev,
        [storageKey]: [nextAnnotation, ...(prev[storageKey] || [])],
      }));
    },
    []
  );

  const removeAnnotation = useCallback((path: string, annotationId: string) => {
    const storageKey = makeNoteStorageKey(path);
    setAnnotationsByDocument((prev) => ({
      ...prev,
      [storageKey]: (prev[storageKey] || []).filter((annotation) => annotation.id !== annotationId),
    }));
  }, []);

  useEffect(() => {
    if (!canUseNativeWebview()) return;
    const disposes: UnlistenFn[] = [];

    void Promise.all([
      listen<{ tabId: string; url: string }>("r0nix://webview-pdf-link", (event) => {
        const url = event.payload?.url;
        if (!url) return;
        void openPdfFromUrl(url);
      }),
      listen<{ tabId: string; url: string }>("r0nix://webview-navigated", (event) => {
        const nextTabId = event.payload?.tabId;
        const nextUrl = event.payload?.url;
        if (!nextTabId || !nextUrl) return;
        updateTabUrl(nextTabId, nextUrl);
      }),
    ]).then((unlisteners) => {
      disposes.push(...unlisteners);
    });

    return () => {
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
      style={appStyle}
      className={`flex h-screen w-full overflow-hidden font-sans selection:bg-zinc-200 dark:selection:bg-zinc-700 ${
        theme === "dark" ? "dark bg-zinc-950 text-zinc-100" : "bg-zinc-100 text-zinc-900"
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

      <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-zinc-900">
        <Tabs
          tabs={tabs}
          activeTabId={activeTabId}
          onTabClick={(id) => {
            setActiveTabId(id);
            setTabContextMenu(null);
          }}
          onTabClose={handleCloseTab}
          onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
          isSidebarOpen={isSidebarOpen}
          language={settings.language}
          onTabContextMenu={(tab, event) => {
            setTabContextMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
          }}
        />

        <div className="flex-1 overflow-hidden relative bg-zinc-50 dark:bg-zinc-950">
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
                  className="fixed z-[80] w-52 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur shadow-2xl p-1.5"
                  style={{ left: x, top: y }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <button
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-45"
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

          <div key={activePanelKey} className="absolute inset-0">
            {activeTab?.type === "library" ? (
              activeTab.filter === "whiteboards" ? (
                <Whiteboards
                  documents={visibleDocuments}
                  language={settings.language}
                  onOpenPdf={(doc) => {
                    void openPdfByPath(doc.path, doc.title);
                  }}
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
                fileId={activeTab.fileId}
                language={settings.language}
                notes={activeNotes}
                annotations={activeAnnotations}
                onOpenFileDialog={() => {
                  void openPdfDialog();
                }}
                onAddNote={(pageNo, content, kind) => {
                  if (!activeTab.filePath) return;
                  addNote(activeTab.filePath, pageNo, content, kind);
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
                filePath={activeTab.filePath}
                content={activeTab.content || ""}
                language={settings.language}
                onOpenExternal={handleOpenExternal}
                onContentChange={(next) => {
                  updateMarkdownTabContent(activeTab.id, next);
                }}
                onSave={async (next) => {
                  if (!activeTab.filePath) return;
                  try {
                    await saveMarkdownFile(activeTab.filePath, activeTab.fileId, next);
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
                onOpenPdfInApp={(url) => {
                  void openPdfFromUrl(url);
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
        </div>
      </div>
    </div>
  );
}














