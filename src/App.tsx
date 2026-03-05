import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  BookOpen,
  Check,
  Clock3,
  Download,
  ExternalLink,
  FolderOpen,
  Globe2,
  House,
  Info,
  Library,
  Languages,
  LayoutPanelLeft,
  Link2,
  Monitor,
  Moon,
  Palette,
  Plus,
  Settings2,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import Sidebar from "./components/Sidebar";
import LibraryPanel, { type LibraryCollection } from "./components/LibraryPanel";
import PDFViewer from "./components/PDFViewer";
import WebViewPanel from "./components/WebViewPanel";
import * as api from "./services/pdfApi";
import { debugError, debugLog } from "./services/debugLogger";
import {
  loadUserSettings,
  sanitizeUserSettings,
  saveUserSettings,
  withDefaultDir,
  type DefaultExportFormat,
  type ThemeAccent,
  type ThemePalette,
  type QuickLinkItem,
  type ThemeMode,
  type UserSettings,
  type WebPanelMode,
} from "./services/userSettings";
import {
  canUseNativeWebview,
  closeNativeWebviewTab,
  hideNativeWebviewTab,
  showNativeWebviewTab,
} from "./services/nativeWebview";
import { downloadPdfViaProxy } from "./services/webProxy";
import packageMeta from "../package.json";
import "./App.css";

export type ViewType = "pdf" | "markdown";

export interface FileItem {
  id: string;
  name: string;
  type: "pdf" | "markdown";
  path: string;
  meta?: string;
}

export interface RecentFileItem {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  totalReadSeconds?: number;
  sessions?: Array<{
    openedAt: string;
    closedAt: string;
    durationSec: number;
    endPage?: number;
    endZoom?: number;
    endAutoFit?: boolean;
    endScrollTopRatio?: number;
  }>;
  snapshot?: {
    lastPage: number;
    totalPages: number;
    zoom: number;
    capturedAt: string;
    autoFit?: boolean;
    scrollTopRatio?: number;
  };
}

export interface WebTabItem {
  id: string;
  url: string;
  title: string;
  pinned: boolean;
  groupId: string;
  createdAt: string;
}

export interface WebTabGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface FavoriteItem {
  id: string;
  type: "web" | "pdf";
  title: string;
  target: string;
  createdAt: string;
}

export interface ImagePreviewItem {
  id: string;
  title: string;
  mimeType: "image/svg+xml" | "image/png" | "image/jpeg";
  dataUrl: string;
  sourceType: string;
  vectorRatio?: number;
  vectorGrade?: "A" | "B" | "C" | "D";
  imageCount?: number;
  vectorCount?: number;
  createdAt: string;
}

type TopMenu = "file" | "settings" | "view" | "about" | null;
export type MainPanel = "viewer" | "settings" | "web" | "library";
type ReturnTabTarget =
  | { panel: "viewer"; fileId?: string }
  | { panel: "web"; webTabId?: string }
  | { panel: "settings" }
  | { panel: "library" };

export const markdownCache = new Map<string, string>();
export type AppLanguage = "zh" | "en";

const RECENT_FILES_KEY = "pdf_reader_recent_files";
const LINK_META_KEY = "pdf_reader_links_meta_v1";
const LAST_FILE_KEY = "pdf_reader_last_file_path";
const SIDEBAR_VISIBLE_KEY = "pdf_reader_sidebar_visible";
const WEB_TABS_KEY = "pdf_reader_web_tabs";
const WEB_TAB_GROUPS_KEY = "pdf_reader_web_tab_groups";
const FAVORITES_KEY = "pdf_reader_favorites_v1";
const LIBRARY_COLLECTIONS_KEY = "pdf_reader_library_collections_v1";
const DEFAULT_WEB_GROUP_ID = "web-group-default";
const APP_VERSION = packageMeta.version;

function getInitialLanguage(): AppLanguage {
  if (typeof window === "undefined") return "zh";
  const saved = window.localStorage.getItem("pdf_reader_lang");
  return saved === "en" ? "en" : "zh";
}

function getInitialLinks(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("pdf_reader_links");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function getInitialLinkMeta(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LINK_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== "object") return {};
    const entries = Object.entries(parsed).filter(
      ([key, value]) => typeof key === "string" && typeof value === "string" && key.trim()
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function getInitialRecentFiles(): RecentFileItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentFileItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.path === "string" && typeof item.name === "string")
      .map((item) => {
        const snapshotRaw = item.snapshot;
        const snapshot =
          snapshotRaw &&
          typeof snapshotRaw.lastPage === "number" &&
          typeof snapshotRaw.totalPages === "number" &&
          typeof snapshotRaw.zoom === "number" &&
          typeof snapshotRaw.capturedAt === "string"
            ? {
                ...snapshotRaw,
                autoFit:
                  typeof snapshotRaw.autoFit === "boolean"
                    ? snapshotRaw.autoFit
                    : undefined,
                scrollTopRatio:
                  typeof snapshotRaw.scrollTopRatio === "number" &&
                  Number.isFinite(snapshotRaw.scrollTopRatio)
                    ? Math.max(0, Math.min(1, snapshotRaw.scrollTopRatio))
                    : undefined,
              }
            : undefined;
        const sessionsRaw = Array.isArray(item.sessions) ? item.sessions : [];
        const sessions = sessionsRaw
          .filter(
            (session): session is NonNullable<RecentFileItem["sessions"]>[number] =>
              Boolean(session) &&
              typeof session.openedAt === "string" &&
              typeof session.closedAt === "string" &&
              typeof session.durationSec === "number"
          )
          .map((session) => ({
            openedAt: session.openedAt,
            closedAt: session.closedAt,
            durationSec: Math.max(1, Math.round(session.durationSec)),
            endPage:
              typeof session.endPage === "number" && Number.isFinite(session.endPage)
                ? Math.max(1, Math.round(session.endPage))
                : undefined,
            endZoom:
              typeof session.endZoom === "number" && Number.isFinite(session.endZoom)
                ? Math.max(1, Math.round(session.endZoom))
                : undefined,
            endAutoFit:
              typeof session.endAutoFit === "boolean"
                ? session.endAutoFit
                : undefined,
            endScrollTopRatio:
              typeof session.endScrollTopRatio === "number" && Number.isFinite(session.endScrollTopRatio)
                ? Math.max(0, Math.min(1, session.endScrollTopRatio))
                : undefined,
          }))
          .slice(0, 10);
        return {
          ...item,
          lastOpenedAt:
            typeof item.lastOpenedAt === "string" && item.lastOpenedAt
              ? item.lastOpenedAt
              : new Date().toISOString(),
          missing: Boolean(item.missing),
          totalReadSeconds:
            typeof item.totalReadSeconds === "number" && Number.isFinite(item.totalReadSeconds)
              ? Math.max(0, Math.round(item.totalReadSeconds))
              : sessions.reduce((sum, session) => sum + session.durationSec, 0),
          sessions,
          snapshot,
        };
      });
  } catch {
    return [];
  }
}

function getInitialWebTabs(): WebTabItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WEB_TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WebTabItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.url === "string" &&
        typeof item.title === "string" &&
        (typeof item.pinned === "boolean" || item.pinned === undefined) &&
        (typeof item.groupId === "string" || item.groupId === undefined) &&
        typeof item.createdAt === "string"
    ).map((item) => ({
      ...item,
      pinned: Boolean(item.pinned),
      groupId: item.groupId || DEFAULT_WEB_GROUP_ID,
    }));
  } catch {
    return [];
  }
}

function getInitialWebTabGroups(): WebTabGroup[] {
  if (typeof window === "undefined") return [{ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false }];
  try {
    const raw = window.localStorage.getItem(WEB_TAB_GROUPS_KEY);
    if (!raw) return [{ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false }];
    const parsed = JSON.parse(raw) as WebTabGroup[];
    if (!Array.isArray(parsed)) return [{ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false }];
    const clean = parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.collapsed === "boolean"
    );
    if (clean.length === 0) return [{ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false }];
    if (!clean.some((group) => group.id === DEFAULT_WEB_GROUP_ID)) {
      clean.unshift({ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false });
    }
    return clean;
  } catch {
    return [{ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false }];
  }
}

function getInitialFavorites(): FavoriteItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FavoriteItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        (item.type === "web" || item.type === "pdf") &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        typeof item.target === "string" &&
        typeof item.createdAt === "string"
    );
  } catch {
    return [];
  }
}

function getInitialLibraryCollections(): LibraryCollection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LIBRARY_COLLECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LibraryCollection[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          Array.isArray(item.paths) &&
          typeof item.createdAt === "string"
      )
      .map((item) => ({
        id: item.id,
        name: item.name.trim() || "Collection",
        paths: item.paths
          .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
          .filter((path, index, source) => source.findIndex((value) => samePath(value, path)) === index),
        createdAt: item.createdAt,
      }));
  } catch {
    return [];
  }
}

function getInitialSidebarVisible() {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SIDEBAR_VISIBLE_KEY) !== "0";
}

function fileNameFromPath(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function samePath(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function normalizeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `https://${value}`;
}

function shouldPreferInsideWebTab(raw: string) {
  const normalized = normalizeUrl(raw);
  if (!normalized) return false;
  try {
    const host = new URL(normalized).host.toLowerCase();
    return (
      host === "limestart.cn" ||
      host === "www.limestart.cn" ||
      host === "google.com" ||
      host === "www.google.com" ||
      host.endsWith(".google.com")
    );
  } catch {
    return false;
  }
}

function canonicalizeUrl(raw: string) {
  const normalized = normalizeUrl(raw);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = pathname || "/";
    return parsed.toString();
  } catch {
    return normalized.replace(/\/+$/, "");
  }
}

function isSameUrl(a: string, b: string) {
  const left = canonicalizeUrl(a);
  const right = canonicalizeUrl(b);
  if (!left || !right) return left === right;
  return left === right;
}

function getImagePreviewId(url: string) {
  const match = /^r0nix-preview:\/\/image\/([a-zA-Z0-9_-]+)/i.exec(url.trim());
  return match?.[1] || "";
}

type ReorderPosition = "before" | "after";

function reorderById<T extends { id: string }>(
  list: T[],
  sourceId: string,
  targetId: string,
  position: ReorderPosition = "before"
) {
  if (sourceId === targetId) return list;
  const fromIndex = list.findIndex((item) => item.id === sourceId);
  const toIndex = list.findIndex((item) => item.id === targetId);
  if (fromIndex < 0 || toIndex < 0) return list;
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  const insertIndex =
    position === "after"
      ? (fromIndex < toIndex ? toIndex : toIndex + 1)
      : (fromIndex < toIndex ? toIndex - 1 : toIndex);
  next.splice(insertIndex, 0, moved);
  return next;
}

function guessPdfFileName(url: string, contentDisposition = "") {
  const cdMatch = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(contentDisposition);
  if (cdMatch?.[1]) {
    const cleaned = cdMatch[1].replace(/"/g, "").trim();
    try {
      const decoded = decodeURIComponent(cleaned);
      if (decoded.toLowerCase().endsWith(".pdf")) return decoded;
      return `${decoded}.pdf`;
    } catch {
      if (cleaned.toLowerCase().endsWith(".pdf")) return cleaned;
      return `${cleaned}.pdf`;
    }
  }
  try {
    const u = new URL(url);
    const base = (u.pathname.split("/").pop() || "document.pdf").trim();
    if (base.toLowerCase().endsWith(".pdf")) return base;
    return `${base || "document"}.pdf`;
  } catch {
    const fallback = fileNameFromPath(url).trim();
    if (!fallback) return "document.pdf";
    return fallback.toLowerCase().endsWith(".pdf") ? fallback : `${fallback}.pdf`;
  }
}

function downloadBlob(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activeFileId, setActiveFileId] = useState<string>("");
  const [language, setLanguage] = useState<AppLanguage>(getInitialLanguage);
  const [openedLinks, setOpenedLinks] = useState<string[]>(getInitialLinks);
  const [linkMeta, setLinkMeta] = useState<Record<string, string>>(getInitialLinkMeta);
  const [recentFiles, setRecentFiles] = useState<RecentFileItem[]>(getInitialRecentFiles);
  const [webTabs, setWebTabs] = useState<WebTabItem[]>(getInitialWebTabs);
  const [webTabGroups, setWebTabGroups] = useState<WebTabGroup[]>(getInitialWebTabGroups);
  const [activeWebTabId, setActiveWebTabId] = useState<string>("");
  const [newWebTabId, setNewWebTabId] = useState<string>("");
  const [webImagePreviews, setWebImagePreviews] = useState<Record<string, ImagePreviewItem>>({});
  const [favorites, setFavorites] = useState<FavoriteItem[]>(getInitialFavorites);
  const [libraryCollections, setLibraryCollections] = useState<LibraryCollection[]>(getInitialLibraryCollections);
  const [sidebarVisible, setSidebarVisible] = useState(getInitialSidebarVisible);
  const [menuOpen, setMenuOpen] = useState<TopMenu>(null);
  const [mainPanel, setMainPanel] = useState<MainPanel>("viewer");
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [libraryTabOpen, setLibraryTabOpen] = useState(true);
  const [settings, setSettings] = useState<UserSettings>(loadUserSettings);
  const [settingsDraft, setSettingsDraft] = useState<UserSettings>(loadUserSettings);
  const [webReturningToViewer, setWebReturningToViewer] = useState(false);
  const [dragQuickLinkId, setDragQuickLinkId] = useState("");
  const [dropQuickLinkId, setDropQuickLinkId] = useState("");
  const [newQuickLinkId, setNewQuickLinkId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nativeWebviewTabIdsRef = useRef<Set<string>>(new Set());
  const settingsReturnRef = useRef<ReturnTabTarget>({ panel: "viewer" });
  const libraryReturnRef = useRef<ReturnTabTarget>({ panel: "viewer" });
  const restoredLastFileRef = useRef(false);
  const readSessionRef = useRef<{
    path: string;
    name: string;
    startMs: number;
    openedAt: string;
  } | null>(null);
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
  const nativeWebviewEnabled = isTauri && canUseNativeWebview();
  const effectiveWebPanelMode: WebPanelMode =
    nativeWebviewEnabled && settings.webPanelMode === "native_webview"
      ? "native_webview"
      : "iframe";

  const text = useMemo(
    () =>
      language === "zh"
        ? {
            file: "文件",
            settings: "设置",
            view: "视图",
            about: "关于",
            openPdf: "打开 PDF",
            reopenLast: "重新打开上次文件",
            recentMenu: "最近文件",
            clearRecent: "清空最近文件",
            noRecent: "暂无最近文件",
            language: "语言",
            zh: "中文",
            en: "English",
            showSidebar: "显示侧边栏",
            hideSidebar: "隐藏侧边栏",
            aboutName: "r0nix",
            aboutVersion: `版本 ${APP_VERSION}`,
            aboutSite: "项目主页",
            openFailed: "打开失败",
            openSettings: "打开设置",
            settingsTitle: "阅读器设置",
            defaultFormat: "默认导出格式",
            defaultPath: "默认保存路径",
            chooseFolder: "选择文件夹",
            backToReader: "返回阅读器",
            save: "保存",
            reset: "重置",
            webTab: "网页",
            openLinksMode: "PDF 链接打开方式",
            openInside: "在应用内打开",
            openOutside: "在外部浏览器打开",
            proxyTitle: "网络代理",
            proxyEnabled: "启用代理",
            proxyDisabled: "直连",
            proxyUrl: "代理地址",
            proxyHint: "支持 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080",
            themeMode: "界面主题",
            themeSystem: "跟随系统",
            themeLight: "白天模式",
            themeDark: "夜间模式",
            themePalette: "主题色系",
            themePaletteHint: "色系名称在白天/夜间相同，会自动适配明暗。",
            paletteDefault: "默认浅蓝",
            paletteGraphite: "石墨灰",
            paletteSlate: "深空灰",
            paletteIndigo: "靛蓝夜",
            themeAccent: "前端主题色",
            accentBlue: "蔚蓝",
            accentGreen: "翠绿",
            accentOrange: "暖橙",
            accentRose: "玫瑰",
            accentViolet: "紫罗兰",
            resetAppearance: "重置外观",
            webPdfMode: "网页 PDF 处理",
            webPdfDirect: "直接在应用内打开",
            webPdfDownload: "先下载后打开",
            webPanelMode: "网页容器模式",
            webPanelIframe: "iframe（兼容模式）",
            webPanelNative: "原生 Webview（实验）",
            newTabDefaultUrl: "新建标签页默认网址",
            quickLinksTitle: "快捷标签",
            quickLinksHint: "用于新标签页快捷打开网页，可新增、删除和排序。",
            quickLinkName: "名称",
            quickLinkUrl: "网址",
            addQuickLink: "新增快捷标签",
            moveUp: "上移",
            moveDown: "下移",
            remove: "删除",
            dragToSort: "拖拽排序",
            newWebTab: "新建网页标签页",
            recentLinksMenu: "最近网页",
            noRecentLinks: "暂无最近网页",
            clearRecentLinks: "清空最近网页",
            focusViewer: "切换到阅读器",
            focusWeb: "切换到网页页",
            focusSettings: "切换到设置页",
            focusLibrary: "切换到资料库",
            themeQuick: "主题切换",
            linkOpenQuick: "链接打开方式",
            appearanceMenu: "外观与主题",
            webLinkMenu: "链接与网页",
            networkMenu: "网络与代理",
            workspaceMenu: "工作区与视图",
            proxyConfigure: "配置代理地址",
            desktopOnly: "仅桌面端",
            library: "资料库",
            newTabTitle: "新标签页",
            newQuickLinkTitle: "新标签",
            newGroupName: (index: number) => `分组 ${index}`,
            linkNotPdf: "链接内容不是 PDF",
            defaultCollection: "默认收藏夹",
            imagePreviewTitle: "图片预览",
            showStartPage: "显示起始页",
            dataExportTitle: "数据备份",
            exportDataBundle: "导出全部设置与使用数据",
            importDataBundle: "导入并恢复数据",
            exportDataHint: "包含设置、历史文件、阅读会话、资料库、收藏和网页标签配置。",
            importConfirm: "导入会覆盖当前设置与历史记录，是否继续？",
            importSuccess: "导入完成，已恢复数据。",
            importFailed: "导入失败，请确认选择的是有效的 r0nix 数据文件。",
          }
        : {
            file: "File",
            settings: "Settings",
            view: "View",
            about: "About",
            openPdf: "Open PDF",
            reopenLast: "Reopen Last File",
            recentMenu: "Recent Files",
            clearRecent: "Clear Recent Files",
            noRecent: "No recent files",
            language: "Language",
            zh: "Chinese",
            en: "English",
            showSidebar: "Show Sidebar",
            hideSidebar: "Hide Sidebar",
            aboutName: "r0nix",
            aboutVersion: `Version ${APP_VERSION}`,
            aboutSite: "Project Home",
            openFailed: "Open failed",
            openSettings: "Open Settings",
            settingsTitle: "Reader Settings",
            defaultFormat: "Default Export Format",
            defaultPath: "Default Save Path",
            chooseFolder: "Choose Folder",
            backToReader: "Back to Reader",
            save: "Save",
            reset: "Reset",
            webTab: "Web",
            openLinksMode: "Open PDF links",
            openInside: "Open inside app",
            openOutside: "Open in browser",
            proxyTitle: "Network Proxy",
            proxyEnabled: "Enable proxy",
            proxyDisabled: "Direct",
            proxyUrl: "Proxy URL",
            proxyHint: "Supports http://127.0.0.1:7890 or socks5://127.0.0.1:1080",
            themeMode: "Theme",
            themeSystem: "Follow system",
            themeLight: "Light",
            themeDark: "Dark",
            themePalette: "Color palette",
            themePaletteHint: "Palette names stay the same in light/dark and adapt automatically.",
            paletteDefault: "Default",
            paletteGraphite: "Graphite",
            paletteSlate: "Slate",
            paletteIndigo: "Indigo",
            themeAccent: "Accent color",
            accentBlue: "Blue",
            accentGreen: "Green",
            accentOrange: "Orange",
            accentRose: "Rose",
            accentViolet: "Violet",
            resetAppearance: "Reset appearance",
            webPdfMode: "Web PDF handling",
            webPdfDirect: "Open directly in app",
            webPdfDownload: "Download then open",
            webPanelMode: "Web panel mode",
            webPanelIframe: "iframe (compat)",
            webPanelNative: "Native Webview (experimental)",
            newTabDefaultUrl: "Default URL for new tabs",
            quickLinksTitle: "Quick links",
            quickLinksHint: "Shown on new tabs. Supports add, remove and reorder.",
            quickLinkName: "Name",
            quickLinkUrl: "URL",
            addQuickLink: "Add quick link",
            moveUp: "Up",
            moveDown: "Down",
            remove: "Remove",
            dragToSort: "Drag to sort",
            newWebTab: "New web tab",
            recentLinksMenu: "Recent links",
            noRecentLinks: "No recent links",
            clearRecentLinks: "Clear recent links",
            focusViewer: "Switch to reader",
            focusWeb: "Switch to web view",
            focusSettings: "Switch to settings",
            focusLibrary: "Switch to library",
            themeQuick: "Theme",
            linkOpenQuick: "Link open mode",
            appearanceMenu: "Appearance & Theme",
            webLinkMenu: "Links & Web",
            networkMenu: "Network & Proxy",
            workspaceMenu: "Workspace & View",
            proxyConfigure: "Configure proxy URL",
            desktopOnly: "Desktop only",
            library: "Library",
            newTabTitle: "New Tab",
            newQuickLinkTitle: "New link",
            newGroupName: (index: number) => `Group ${index}`,
            linkNotPdf: "URL does not point to a PDF",
            defaultCollection: "Default Collection",
            imagePreviewTitle: "Image Preview",
            showStartPage: "Show Start Page",
            dataExportTitle: "Data Backup",
            exportDataBundle: "Export all settings and usage data",
            importDataBundle: "Import and restore data",
            exportDataHint: "Includes settings, history, reading sessions, library, favorites, and web tabs.",
            importConfirm: "Import will overwrite current settings and history. Continue?",
            importSuccess: "Import complete. Data restored.",
            importFailed: "Import failed. Please choose a valid r0nix data file.",
          },
    [language]
  );

  const activeFile = files.find((file) => file.id === activeFileId);
  const activeRealFileId = activeFile?.id;
  const activeWebTab = webTabs.find((item) => item.id === activeWebTabId);
  const activeWebImagePreview = activeWebTab
    ? webImagePreviews[getImagePreviewId(activeWebTab.url)]
    : undefined;
  const activeFileSnapshot = activeFile?.path
    ? recentFiles.find((item) => item.path === activeFile.path)?.snapshot
    : undefined;

  useEffect(() => {
    void loadFileList();
  }, []);

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target as Node)) return;
      setMenuOpen(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_VISIBLE_KEY, sidebarVisible ? "1" : "0");
    }
  }, [sidebarVisible]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WEB_TABS_KEY, JSON.stringify(webTabs));
  }, [webTabs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WEB_TAB_GROUPS_KEY, JSON.stringify(webTabGroups));
  }, [webTabGroups]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LIBRARY_COLLECTIONS_KEY, JSON.stringify(libraryCollections));
  }, [libraryCollections]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LINK_META_KEY, JSON.stringify(linkMeta));
  }, [linkMeta]);

  useEffect(() => {
    setLinkMeta((prev) => {
      const allow = new Set(openedLinks.map((item) => canonicalizeUrl(item)));
      const nextEntries = Object.entries(prev).filter(([url]) => allow.has(canonicalizeUrl(url)));
      if (nextEntries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(nextEntries);
    });
  }, [openedLinks]);

  useEffect(() => {
    if (!newWebTabId) return;
    const timer = window.setTimeout(() => setNewWebTabId(""), 520);
    return () => window.clearTimeout(timer);
  }, [newWebTabId]);

  useEffect(() => {
    if (!newQuickLinkId) return;
    const timer = window.setTimeout(() => setNewQuickLinkId(""), 520);
    return () => window.clearTimeout(timer);
  }, [newQuickLinkId]);

  useEffect(() => {
    if (mainPanel !== "web") return;
    if (!activeWebTabId && webTabs.length > 0) {
      setActiveWebTabId(webTabs[0].id);
    }
    if (activeWebTabId && !webTabs.some((item) => item.id === activeWebTabId)) {
      setActiveWebTabId(webTabs[0]?.id ?? "");
      if (webTabs.length === 0) {
        setMainPanel("viewer");
      }
    }
  }, [activeWebTabId, mainPanel, webTabs]);

  useEffect(() => {
    const activePreviewIds = new Set<string>();
    for (const tab of webTabs) {
      const id = getImagePreviewId(tab.url);
      if (id) activePreviewIds.add(id);
    }
    setWebImagePreviews((prev) => {
      const nextEntries = Object.entries(prev).filter(([id]) => activePreviewIds.has(id));
      if (nextEntries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(nextEntries);
    });
  }, [webTabs]);

  useEffect(() => {
    if (!nativeWebviewEnabled) return;
    const nextIds = new Set(webTabs.map((item) => item.id));
    const prevIds = nativeWebviewTabIdsRef.current;
    for (const id of prevIds) {
      if (nextIds.has(id)) continue;
      void closeNativeWebviewTab(id).catch((error) => {
        debugError("native-webview", "close removed tab failed", { id, error });
      });
    }
    nativeWebviewTabIdsRef.current = nextIds;
  }, [nativeWebviewEnabled, webTabs]);

  useEffect(() => {
    if (!nativeWebviewEnabled) return;
    const tabIds = Array.from(nativeWebviewTabIdsRef.current);
    if (tabIds.length === 0) return;

    if (effectiveWebPanelMode !== "native_webview") {
      for (const id of tabIds) {
        void hideNativeWebviewTab(id).catch((error) => {
          debugError("native-webview", "hide on mode switch failed", { id, error });
        });
      }
      return;
    }

    const activeId = mainPanel === "web" ? activeWebTabId : "";
    for (const id of tabIds) {
      const task = id === activeId ? showNativeWebviewTab(id, false) : hideNativeWebviewTab(id);
      void task.catch((error) => {
        debugError("native-webview", "toggle visibility failed", { id, activeId, error });
      });
    }
  }, [activeWebTabId, effectiveWebPanelMode, mainPanel, nativeWebviewEnabled]);

  useEffect(() => {
    if (!nativeWebviewEnabled || effectiveWebPanelMode !== "native_webview") return;
    const hideAll = () => {
      for (const id of nativeWebviewTabIdsRef.current) {
        void hideNativeWebviewTab(id).catch((error) => {
          debugError("native-webview", "hide on visibility change failed", { id, error });
        });
      }
    };
    const restoreActive = () => {
      const activeId = mainPanel === "web" ? activeWebTabId : "";
      for (const id of nativeWebviewTabIdsRef.current) {
        const task = id === activeId ? showNativeWebviewTab(id, false) : hideNativeWebviewTab(id);
        void task.catch((error) => {
          debugError("native-webview", "restore on visibility change failed", { id, activeId, error });
        });
      }
    };
    const onVisibility = () => {
      if (document.hidden) hideAll();
      else restoreActive();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeWebTabId, effectiveWebPanelMode, mainPanel, nativeWebviewEnabled]);

  useEffect(() => {
    const groupIds = new Set(webTabGroups.map((group) => group.id));
    if (!groupIds.has(DEFAULT_WEB_GROUP_ID)) {
      setWebTabGroups((prev) => [{ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false }, ...prev]);
      return;
    }
    setWebTabs((prev) =>
      prev.map((tab) => (groupIds.has(tab.groupId) ? tab : { ...tab, groupId: DEFAULT_WEB_GROUP_ID }))
    );
  }, [webTabGroups]);

  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const resolveTheme = (mode: ThemeMode) => (mode === "system" ? (mq.matches ? "dark" : "light") : mode);
    const applyTheme = (mode: ThemeMode) => {
      root.setAttribute("data-theme", resolveTheme(mode));
    };
    const applyPalette = (palette: ThemePalette) => {
      root.setAttribute("data-theme-palette", palette);
    };
    const applyAccent = (accent: ThemeAccent) => {
      root.setAttribute("data-theme-accent", accent);
    };
    applyTheme(settings.themeMode);
    applyPalette(settings.themePalette);
    applyAccent(settings.themeAccent);
    if (settings.themeMode !== "system") return;
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings.themeMode, settings.themePalette, settings.themeAccent]);

  const persistRecentFiles = (items: RecentFileItem[]) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(items));
    if (items.length > 0) {
      window.localStorage.setItem(LAST_FILE_KEY, items[0].path);
    } else {
      window.localStorage.removeItem(LAST_FILE_KEY);
    }
  };

  const rememberRecentFile = (path: string, name?: string, snapshot?: RecentFileItem["snapshot"]) => {
    const fileName = name || fileNameFromPath(path);
    setRecentFiles((prev) => {
      const existing = prev.find((item) => item.path === path);
      const nextItem: RecentFileItem = {
        path,
        name: fileName,
        lastOpenedAt: new Date().toISOString(),
        missing: false,
        totalReadSeconds: existing?.totalReadSeconds || 0,
        sessions: existing?.sessions || [],
        snapshot: snapshot || existing?.snapshot,
      };
      const next = [nextItem, ...prev.filter((item) => item.path !== path)].slice(0, 20);
      persistRecentFiles(next);
      return next;
    });
  };

  const removeRecentFile = (path: string) => {
    setRecentFiles((prev) => {
      const next = prev.filter((item) => item.path !== path);
      persistRecentFiles(next);
      return next;
    });
  };

  const markRecentFileMissing = (path: string, missing: boolean) => {
    setRecentFiles((prev) => {
      const next = prev.map((item) => (item.path === path ? { ...item, missing } : item));
      persistRecentFiles(next);
      return next;
    });
  };

  const updateRecentFileSnapshot = (
    path: string,
    snapshot: {
      lastPage: number;
      totalPages: number;
      zoom: number;
      autoFit?: boolean;
      scrollTopRatio?: number;
    }
  ) => {
    setRecentFiles((prev) => {
      const idx = prev.findIndex((item) => item.path === path);
      if (idx < 0) return prev;
      const target = prev[idx];
      const nextSnapshot: NonNullable<RecentFileItem["snapshot"]> = {
        lastPage: snapshot.lastPage,
        totalPages: snapshot.totalPages,
        zoom: snapshot.zoom,
        capturedAt: new Date().toISOString(),
        autoFit: typeof snapshot.autoFit === "boolean" ? snapshot.autoFit : undefined,
        scrollTopRatio:
          typeof snapshot.scrollTopRatio === "number" && Number.isFinite(snapshot.scrollTopRatio)
            ? Math.max(0, Math.min(1, snapshot.scrollTopRatio))
            : undefined,
      };
      const prevRatio = target.snapshot?.scrollTopRatio ?? -1;
      const nextRatio = nextSnapshot.scrollTopRatio ?? -1;
      if (
        target.snapshot?.lastPage === nextSnapshot.lastPage &&
        target.snapshot?.totalPages === nextSnapshot.totalPages &&
        target.snapshot?.zoom === nextSnapshot.zoom &&
        target.snapshot?.autoFit === nextSnapshot.autoFit &&
        Math.abs(prevRatio - nextRatio) < 0.002
      ) {
        return prev;
      }
      const next = [...prev];
      next[idx] = { ...target, snapshot: nextSnapshot };
      persistRecentFiles(next);
      return next;
    });
  };

  const finalizeReadSession = useCallback((payload: {
    path: string;
    name: string;
    openedAt: string;
    durationSec: number;
  }) => {
    setRecentFiles((prev) => {
      const nowIso = new Date().toISOString();
      const idx = prev.findIndex((item) => item.path === payload.path);
      const existing = idx >= 0 ? prev[idx] : undefined;
      const nextSession: NonNullable<RecentFileItem["sessions"]>[number] = {
        openedAt: payload.openedAt,
        closedAt: nowIso,
        durationSec: payload.durationSec,
        endPage: existing?.snapshot?.lastPage,
        endZoom: existing?.snapshot?.zoom,
        endAutoFit: existing?.snapshot?.autoFit,
        endScrollTopRatio: existing?.snapshot?.scrollTopRatio,
      };
      const mergedSessions = [nextSession, ...(existing?.sessions || [])].slice(0, 10);
      const nextItem: RecentFileItem = {
        path: payload.path,
        name: existing?.name || payload.name || fileNameFromPath(payload.path),
        lastOpenedAt: existing?.lastOpenedAt || nowIso,
        missing: Boolean(existing?.missing),
        snapshot: existing?.snapshot,
        totalReadSeconds: (existing?.totalReadSeconds || 0) + payload.durationSec,
        sessions: mergedSessions,
      };
      let next: RecentFileItem[];
      if (idx >= 0) {
        next = [...prev];
        next[idx] = nextItem;
      } else {
        next = [nextItem, ...prev].slice(0, 20);
      }
      persistRecentFiles(next);
      return next;
    });
  }, []);

  const stopReadSession = useCallback(() => {
    const running = readSessionRef.current;
    if (!running) return;
    readSessionRef.current = null;
    const durationSec = Math.max(1, Math.round((Date.now() - running.startMs) / 1000));
    finalizeReadSession({
      path: running.path,
      name: running.name,
      openedAt: running.openedAt,
      durationSec,
    });
  }, [finalizeReadSession]);

  const startReadSession = useCallback((path: string, name: string) => {
    const running = readSessionRef.current;
    if (running?.path === path) return;
    stopReadSession();
    readSessionRef.current = {
      path,
      name: name || fileNameFromPath(path),
      startMs: Date.now(),
      openedAt: new Date().toISOString(),
    };
  }, [stopReadSession]);

  useEffect(() => {
    if (mainPanel !== "viewer" || !activeFile?.path) {
      stopReadSession();
      return;
    }
    startReadSession(activeFile.path, activeFile.name);
  }, [activeFile?.name, activeFile?.path, mainPanel, startReadSession, stopReadSession]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeUnload = () => {
      stopReadSession();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      stopReadSession();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [stopReadSession]);

  const isBackendOfflineError = (error: unknown) =>
    error instanceof Error && error.message.includes("backend is not reachable");

  const findOpenedFileByPath = (path: string) => {
    const pathName = fileNameFromPath(path).toLowerCase();
    return files.find((file) => {
      if (samePath(file.path || "", path)) return true;
      return file.name.toLowerCase() === pathName;
    });
  };

  const updateLanguage = (lang: AppLanguage) => {
    setLanguage(lang);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("pdf_reader_lang", lang);
    }
  };

  const applySettingsPatch = (patch: Partial<UserSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveUserSettings(next);
      return next;
    });
    setSettingsDraft((prev) => ({ ...prev, ...patch }));
  };

  const resetAppearanceSettings = () => {
    applySettingsPatch({
      themeMode: "system",
      themePalette: "default",
      themeAccent: "blue",
    });
  };

  useEffect(() => {
    const next = loadUserSettings();
    setSettings(next);
    setSettingsDraft(next);
  }, []);

  useEffect(() => {
    saveUserSettings(settingsDraft);
    setSettings(settingsDraft);
  }, [settingsDraft]);

  const captureReturnTarget = (): ReturnTabTarget => {
    if (mainPanel === "web") return { panel: "web", webTabId: activeWebTabId };
    if (mainPanel === "library") return { panel: "library" };
    if (mainPanel === "settings") return { panel: "settings" };
    return { panel: "viewer", fileId: activeFileId };
  };

  const openSettingsPanel = () => {
    settingsReturnRef.current = captureReturnTarget();
    setSettingsDraft(settings);
    setSettingsTabOpen(true);
    setMainPanel("settings");
    setMenuOpen(null);
  };

  const resetSettingsDraft = () => {
    setSettingsDraft(loadUserSettings());
  };

  const restoreTabOrHome = (target: ReturnTabTarget | undefined, closing: "settings" | "library") => {
    if (target?.panel === "web") {
      const fallbackWebId =
        target.webTabId && webTabs.some((tab) => tab.id === target.webTabId)
          ? target.webTabId
          : webTabs[0]?.id;
      if (fallbackWebId) {
        setActiveWebTabId(fallbackWebId);
        setMainPanel("web");
        return;
      }
    }
    if (target?.panel === "viewer") {
      const fallbackFileId =
        target.fileId && files.some((file) => file.id === target.fileId)
          ? target.fileId
          : files[0]?.id || "";
      setActiveFileId(fallbackFileId);
      setMainPanel("viewer");
      return;
    }
    if (target?.panel === "settings" && closing !== "settings" && settingsTabOpen) {
      setMainPanel("settings");
      return;
    }
    if (target?.panel === "library" && closing !== "library" && libraryTabOpen) {
      setMainPanel("library");
      return;
    }
    if (files.length > 0) {
      setActiveFileId((prev) => (prev && files.some((file) => file.id === prev) ? prev : files[0]?.id || ""));
      setMainPanel("viewer");
      return;
    }
    if (webTabs.length > 0) {
      setActiveWebTabId((prev) => (prev && webTabs.some((tab) => tab.id === prev) ? prev : webTabs[0]?.id || ""));
      setMainPanel("web");
      return;
    }
    setActiveFileId("");
    setMainPanel("viewer");
  };

  const closeSettingsTab = () => {
    const returnTarget = settingsReturnRef.current;
    setSettingsTabOpen(false);
    if (mainPanel === "settings") {
      restoreTabOrHome(returnTarget, "settings");
    }
  };

  const openHomeTab = () => {
    setMainPanel("viewer");
    setActiveFileId("");
    setMenuOpen(null);
  };

  const openLibraryPanel = () => {
    libraryReturnRef.current = captureReturnTarget();
    setLibraryTabOpen(true);
    setMainPanel("library");
    setMenuOpen(null);
  };

  const closeLibraryTab = () => {
    const returnTarget = libraryReturnRef.current;
    setLibraryTabOpen(false);
    if (mainPanel === "library") {
      restoreTabOrHome(returnTarget, "library");
    }
  };

  const backToViewerFromWeb = () => {
    const target = activeFileId || files[0]?.id;
    if (target) {
      setActiveFileId(target);
    }
    setWebReturningToViewer(true);
    window.setTimeout(() => {
      setMainPanel("viewer");
    }, 56);
    window.setTimeout(() => {
      setWebReturningToViewer(false);
    }, 220);
  };

  const pickDefaultFolder = async () => {
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setSettingsDraft((prev) => ({ ...prev, defaultSaveDir: selected }));
      }
    } catch (error) {
      debugError("settings", "pick folder failed", error);
    }
  };

  const rememberLink = (url: string) => {
    const canonical = canonicalizeUrl(url);
    if (!canonical) return;
    const nowIso = new Date().toISOString();
    setOpenedLinks((prev) => {
      const next = [canonical, ...prev.filter((item) => !isSameUrl(item, canonical))].slice(0, 80);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("pdf_reader_links", JSON.stringify(next));
      }
      return next;
    });
    setLinkMeta((prev) => ({ ...prev, [canonical]: nowIso }));
  };

  const removeRecentResource = (path: string) => {
    setRecentFiles((prev) => {
      const next = prev.filter((item) => !samePath(item.path, path));
      persistRecentFiles(next);
      return next;
    });
  };

  const clearRecentResources = () => {
    setRecentFiles(() => {
      persistRecentFiles([]);
      return [];
    });
  };

  const removeLinkResource = (url: string) => {
    const canonical = canonicalizeUrl(url);
    setOpenedLinks((prev) => {
      const next = prev.filter((item) => !isSameUrl(item, canonical));
      if (typeof window !== "undefined") {
        window.localStorage.setItem("pdf_reader_links", JSON.stringify(next));
      }
      return next;
    });
    setLinkMeta((prev) => {
      const next = { ...prev };
      delete next[canonical];
      return next;
    });
  };

  const clearLinkResources = () => {
    setOpenedLinks(() => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("pdf_reader_links", JSON.stringify([]));
      }
      return [];
    });
    setLinkMeta({});
  };

  const openWebTab = (url: string, titleOverride?: string) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    const canonical = canonicalizeUrl(normalized);
    const title = titleOverride?.trim() || normalized.replace(/^https?:\/\//i, "");
    const defaultGroupId = webTabGroups[0]?.id || DEFAULT_WEB_GROUP_ID;
    setWebTabs((prev) => {
      const existed = prev.find((item) => isSameUrl(item.url, canonical));
      if (existed) {
        setActiveWebTabId(existed.id);
        setMainPanel("web");
        return prev;
      }
      const nextTab: WebTabItem = {
        id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        url: canonical || normalized,
        title,
        pinned: false,
        groupId: defaultGroupId,
        createdAt: new Date().toISOString(),
      };
      setNewWebTabId(nextTab.id);
      setActiveWebTabId(nextTab.id);
      setMainPanel("web");
      return [nextTab, ...prev].slice(0, 30);
    });
  };

  const createEmptyWebTab = () => {
    const defaultGroupId = webTabGroups[0]?.id || DEFAULT_WEB_GROUP_ID;
    const preferredUrl = normalizeUrl(settings.newTabDefaultUrl);
    const title = preferredUrl
      ? preferredUrl.replace(/^https?:\/\//i, "")
      : text.newTabTitle;
    const nextTab: WebTabItem = {
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      url: preferredUrl,
      title,
      pinned: false,
      groupId: defaultGroupId,
      createdAt: new Date().toISOString(),
    };
    setNewWebTabId(nextTab.id);
    setWebTabs((prev) => [nextTab, ...prev].slice(0, 30));
    setActiveWebTabId(nextTab.id);
    setMainPanel("web");
  };

  const navigateWebTab = (tabId: string, url: string) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    const canonical = canonicalizeUrl(normalized) || normalized;
    const title = canonical.replace(/^https?:\/\//i, "");
    rememberLink(canonical);
    setActiveWebTabId(tabId);
    setMainPanel("web");
    setWebTabs((prev) => {
      const target = prev.find((item) => item.id === tabId);
      if (!target) return prev;
      if (isSameUrl(target.url, canonical) && target.title === title) return prev;
      return prev.map((item) => (item.id === tabId ? { ...item, url: canonical, title } : item));
    });
  };

  const updateQuickLink = (id: string, patch: Partial<QuickLinkItem>) => {
    setSettingsDraft((prev) => ({
      ...prev,
      quickLinks: prev.quickLinks.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  };

  const addQuickLink = () => {
    const next: QuickLinkItem = {
      id: `ql-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: text.newQuickLinkTitle,
      url: "",
    };
    setNewQuickLinkId(next.id);
    setSettingsDraft((prev) => ({ ...prev, quickLinks: [...prev.quickLinks, next].slice(0, 24) }));
  };

  const removeQuickLink = (id: string) => {
    setSettingsDraft((prev) => ({ ...prev, quickLinks: prev.quickLinks.filter((item) => item.id !== id) }));
  };

  const moveQuickLink = (id: string, direction: -1 | 1) => {
    setSettingsDraft((prev) => {
      const fromIndex = prev.quickLinks.findIndex((item) => item.id === id);
      if (fromIndex < 0) return prev;
      const toIndex = fromIndex + direction;
      if (toIndex < 0 || toIndex >= prev.quickLinks.length) return prev;
      const next = [...prev.quickLinks];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return { ...prev, quickLinks: next };
    });
  };

  const reorderQuickLinks = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setSettingsDraft((prev) => {
      const fromIndex = prev.quickLinks.findIndex((item) => item.id === sourceId);
      const toIndex = prev.quickLinks.findIndex((item) => item.id === targetId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev.quickLinks];
      const [moved] = next.splice(fromIndex, 1);
      const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
      next.splice(insertIndex, 0, moved);
      return { ...prev, quickLinks: next };
    });
  };

  const reorderFileTabs = (sourceId: string, targetId: string, position: ReorderPosition = "before") => {
    setFiles((prev) => reorderById(prev, sourceId, targetId, position));
  };

  const reorderWebTabs = (
    sourceId: string,
    targetId: string,
    groupId?: string,
    pinned?: boolean,
    position: ReorderPosition = "before"
  ) => {
    setWebTabs((prev) => {
      const source = prev.find((item) => item.id === sourceId);
      if (!source) return prev;
      const target = prev.find((item) => item.id === targetId);
      if (!target) return prev;
      const next = prev.map((item) =>
        item.id === sourceId
          ? {
              ...item,
              groupId: groupId ?? target.groupId,
              pinned: typeof pinned === "boolean" ? pinned : target.pinned,
            }
          : item
      );
      return reorderById(next, sourceId, targetId, position);
    });
  };

  const closeWebTab = (tabId: string) => {
    if (nativeWebviewEnabled) {
      void closeNativeWebviewTab(tabId).catch((error) => {
        debugError("native-webview", "close web tab failed", { tabId, error });
      });
    }
    setWebTabs((prev) => {
      const idx = prev.findIndex((item) => item.id === tabId);
      if (idx === -1) return prev;
      const next = prev.filter((item) => item.id !== tabId);
      if (activeWebTabId === tabId) {
        const fallback = next[idx - 1]?.id ?? next[idx]?.id ?? "";
        setActiveWebTabId(fallback);
        if (fallback) {
          setMainPanel("web");
        } else if (files.length > 0) {
          setActiveFileId((prevFile) => (prevFile && files.some((file) => file.id === prevFile) ? prevFile : files[0]?.id || ""));
          setMainPanel("viewer");
        } else {
          setActiveFileId("");
          setMainPanel("viewer");
        }
      }
      return next;
    });
  };

  const toggleWebTabPinned = (tabId: string) => {
    setWebTabs((prev) =>
      prev.map((item) => {
        if (item.id !== tabId) return item;
        return { ...item, pinned: !item.pinned };
      })
    );
  };

  const toggleWebTabGroupCollapsed = (groupId: string) => {
    setWebTabGroups((prev) =>
      prev.map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group))
    );
  };

  const createWebTabGroup = (name?: string, moveTabId?: string) => {
    const cleanName = (name || "").trim();
    const groupName =
      cleanName ||
      text.newGroupName(webTabGroups.length + 1);
    const newGroup: WebTabGroup = {
      id: `wg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: groupName,
      collapsed: false,
    };
    setWebTabGroups((prev) => [...prev, newGroup]);
    if (moveTabId) {
      setWebTabs((prev) =>
        prev.map((item) => (item.id === moveTabId ? { ...item, groupId: newGroup.id } : item))
      );
    }
    return newGroup.id;
  };

  const moveWebTabToGroup = (tabId: string, groupId: string) => {
    setWebTabs((prev) =>
      prev.map((item) => (item.id === tabId ? { ...item, groupId, pinned: false } : item))
    );
  };

  const handleOpenLink = async (url: string, options?: { forceExternal?: boolean }) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    rememberLink(normalized);
    const canOpenInside = /^https?:\/\//i.test(normalized);
    const isPdfLink = /\.pdf(?:$|\?|\#)/i.test(normalized);
    const preferInsideWebTab = shouldPreferInsideWebTab(normalized);
    if (!options?.forceExternal && settings.openLinksInsideApp && isPdfLink) {
      await handleOpenPdfFromWeb(normalized, settings.webPdfOpenMode);
      return;
    }
    if (!options?.forceExternal && canOpenInside && (settings.openLinksInsideApp || preferInsideWebTab)) {
      openWebTab(normalized);
      return;
    }

    try {
      if (isTauri) {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(normalized);
      } else {
        window.open(normalized, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      debugError("link", "open link failed", { url: normalized, error });
    }
  };

  const handleOpenPdfFromWeb = async (url: string, mode: "direct" | "download_then_open" = settings.webPdfOpenMode) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return false;
    try {
      let blob: Blob;
      let contentType = "";
      let contentDisposition = "";
      let finalUrl = normalized;

      if (isTauri && settings.proxyEnabled && settings.proxyUrl.trim()) {
        const proxied = await downloadPdfViaProxy(normalized, settings.proxyUrl);
        if (proxied) {
          if (proxied.status >= 400) {
            throw new Error(`HTTP ${proxied.status}`);
          }
          finalUrl = proxied.finalUrl || normalized;
          contentType = proxied.contentType || "";
          contentDisposition = proxied.contentDisposition || "";
          blob = new Blob([proxied.bytes], { type: contentType || "application/pdf" });
        } else {
          const response = await fetch(normalized);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          blob = await response.blob();
          finalUrl = response.url || normalized;
          contentType = response.headers.get("content-type") || blob.type || "";
          contentDisposition = response.headers.get("content-disposition") || "";
        }
      } else {
        const response = await fetch(normalized);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        blob = await response.blob();
        finalUrl = response.url || normalized;
        contentType = response.headers.get("content-type") || blob.type || "";
        contentDisposition = response.headers.get("content-disposition") || "";
      }

      const fileName = guessPdfFileName(finalUrl, contentDisposition || "");
      const isPdfLike = contentType.toLowerCase().includes("pdf") || fileName.toLowerCase().endsWith(".pdf");
      if (!isPdfLike) {
        throw new Error(text.linkNotPdf);
      }

      if (mode === "download_then_open") {
        if (isTauri) {
          const data = new Uint8Array(await blob.arrayBuffer());
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          const { save } = await import("@tauri-apps/plugin-dialog");
          const targetPath = await save({
            defaultPath: withDefaultDir(fileName, settings.defaultSaveDir),
            filters: [{ name: "PDF", extensions: ["pdf"] }],
          });
          if (!targetPath || Array.isArray(targetPath)) return false;
          await writeFile(targetPath, data);
          await openFileByPath(targetPath);
          return true;
        }
        downloadBlob(blob, fileName);
      }

      const file = new File([blob], fileName, { type: "application/pdf" });
      const opened = await api.uploadFile(file);
      upsertOpenedFile(opened);
      return true;
    } catch (error) {
      debugError("web-pdf", "import pdf from web failed", { url: normalized, error });
      return false;
    }
  };

  const upsertFavorite = (type: FavoriteItem["type"], title: string, target: string) => {
    setFavorites((prev) => {
      const existed = prev.find((item) => item.type === type && item.target === target);
      if (existed) return prev;
      const next: FavoriteItem = {
        id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        title,
        target,
        createdAt: new Date().toISOString(),
      };
      return [next, ...prev].slice(0, 60);
    });
  };

  const removeFavorite = (favoriteId: string) => {
    setFavorites((prev) => prev.filter((item) => item.id !== favoriteId));
  };

  const reorderFavorites = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setFavorites((prev) => {
      const fromIndex = prev.findIndex((item) => item.id === sourceId);
      const toIndex = prev.findIndex((item) => item.id === targetId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const openFavorite = (favorite: FavoriteItem) => {
    if (favorite.type === "pdf") {
      void handleOpenRecentFile(favorite.target);
      return;
    }
    void handleOpenLink(favorite.target);
  };

  const togglePdfFavorite = (path: string, name: string) => {
    const normalizedTarget = path.trim().toLowerCase();
    setFavorites((prev) => {
      const existed = prev.find((item) => item.type === "pdf" && item.target.trim().toLowerCase() === normalizedTarget);
      if (existed) {
        return prev.filter((item) => item.id !== existed.id);
      }
      const next: FavoriteItem = {
        id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: "pdf",
        title: name || fileNameFromPath(path),
        target: path,
        createdAt: new Date().toISOString(),
      };
      return [next, ...prev].slice(0, 60);
    });
  };

  const createLibraryCollection = (name: string) => {
    const cleanName = name.trim();
    if (!cleanName) return;
    setLibraryCollections((prev) => {
      if (prev.some((item) => item.name.trim().toLowerCase() === cleanName.toLowerCase())) {
        return prev;
      }
      const next: LibraryCollection = {
        id: `collection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: cleanName,
        paths: [],
        createdAt: new Date().toISOString(),
      };
      return [next, ...prev].slice(0, 20);
    });
  };

  const deleteLibraryCollection = (id: string) => {
    setLibraryCollections((prev) => prev.filter((item) => item.id !== id));
  };

  const renameLibraryCollection = (id: string, name: string) => {
    const cleanName = name.trim();
    if (!cleanName) return;
    setLibraryCollections((prev) =>
      prev.map((item) => (item.id === id ? { ...item, name: cleanName } : item))
    );
  };

  const toggleLibraryCollectionPath = (collectionId: string, path: string) => {
    setLibraryCollections((prev) =>
      prev.map((collection) => {
        if (collection.id !== collectionId) return collection;
        const existed = collection.paths.some((item) => samePath(item, path));
        return existed
          ? { ...collection, paths: collection.paths.filter((item) => !samePath(item, path)) }
          : { ...collection, paths: [...collection.paths, path] };
      })
    );
  };

  const addPathToLibraryCollection = (path: string, preferredName?: string) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    setLibraryCollections((prev) => {
      const collections = [...prev];
      if (collections.length === 0) {
        const fallbackName = preferredName?.trim() || text.defaultCollection;
        collections.push({
          id: `collection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: fallbackName,
          paths: [],
          createdAt: new Date().toISOString(),
        });
      }
      const first = collections[0];
      if (!first.paths.some((item) => samePath(item, cleanPath))) {
        first.paths = [...first.paths, cleanPath];
      }
      return collections.slice(0, 20);
    });
  };

  const addWebTabFavorite = (tabId: string) => {
    const tab = webTabs.find((item) => item.id === tabId);
    if (!tab || !tab.url) return;
    const hostTitle = (() => {
      try {
        return new URL(tab.url).host || tab.title || tab.url;
      } catch {
        return tab.title || tab.url;
      }
    })();
    const normalized = tab.url.trim().toLowerCase();
    setFavorites((prev) => {
      const existed = prev.find((item) => item.type === "web" && item.target.trim().toLowerCase() === normalized);
      if (existed) {
        return prev.filter((item) => item.id !== existed.id);
      }
      const next: FavoriteItem = {
        id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: "web",
        title: tab.title || hostTitle,
        target: tab.url,
        createdAt: new Date().toISOString(),
      };
      return [next, ...prev].slice(0, 60);
    });
  };

  const toggleWebFavoriteByUrl = (url: string, preferredTitle?: string) => {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) return;
    const normalized = normalizedUrl.trim().toLowerCase();
    const hostTitle = (() => {
      try {
        return new URL(normalizedUrl).host || preferredTitle || normalizedUrl;
      } catch {
        return preferredTitle || normalizedUrl;
      }
    })();
    setFavorites((prev) => {
      const existed = prev.find((item) => item.type === "web" && item.target.trim().toLowerCase() === normalized);
      if (existed) {
        return prev.filter((item) => item.id !== existed.id);
      }
      const next: FavoriteItem = {
        id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: "web",
        title: preferredTitle?.trim() || hostTitle,
        target: normalizedUrl,
        createdAt: new Date().toISOString(),
      };
      return [next, ...prev].slice(0, 60);
    });
  };

  const openExportImagePreview = (preview: Omit<ImagePreviewItem, "id" | "createdAt">) => {
    const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const next: ImagePreviewItem = {
      ...preview,
      id,
      createdAt: new Date().toISOString(),
    };
    setWebImagePreviews((prev) => ({ ...prev, [id]: next }));
    const title = text.imagePreviewTitle;
    openWebTab(`r0nix-preview://image/${id}`, title);
  };

  const pickJsonFileContent = async (): Promise<string | null> => {
    if (isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected || Array.isArray(selected) || typeof selected !== "string") return null;
      return await readTextFile(selected);
    }
    return await new Promise<string | null>((resolve) => {
      if (typeof document === "undefined") {
        resolve(null);
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";
      input.onchange = async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          resolve(await file.text());
        } catch {
          resolve(null);
        } finally {
          input.remove();
        }
      };
      document.body.appendChild(input);
      input.click();
    });
  };

  const askConfirmDialog = async (message: string) => {
    if (isTauri) {
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        return await confirm(message, { title: "r0nix" });
      } catch {
        return typeof window !== "undefined" ? window.confirm(message) : false;
      }
    }
    return typeof window !== "undefined" ? window.confirm(message) : false;
  };

  const showNoticeDialog = async (message: string, kind: "info" | "error" = "info") => {
    if (isTauri) {
      try {
        const { message: showMessage } = await import("@tauri-apps/plugin-dialog");
        await showMessage(message, { title: "r0nix", kind });
        return;
      } catch {
        // fallback below
      }
    }
    if (typeof window !== "undefined") {
      window.alert(message);
    }
  };

  const importAppDataBundle = async () => {
    const shouldImport = await askConfirmDialog(text.importConfirm);
    if (!shouldImport) return;
    try {
      const raw = await pickJsonFileContent();
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") throw new Error("invalid data bundle");

      if ("settings" in parsed) {
        const importedSettings = sanitizeUserSettings(parsed.settings);
        saveUserSettings(importedSettings);
        setSettings(importedSettings);
        setSettingsDraft(importedSettings);
      }

      if (Array.isArray(parsed.recentFiles)) {
        const nextRecentFiles: RecentFileItem[] = parsed.recentFiles
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof item.path === "string" &&
              typeof item.name === "string"
          )
          .map((item) => {
            const sessions = Array.isArray(item.sessions)
              ? item.sessions
                  .filter(
                    (session): session is Record<string, unknown> =>
                      Boolean(session) &&
                      typeof session === "object" &&
                      typeof session.openedAt === "string" &&
                      typeof session.closedAt === "string" &&
                      typeof session.durationSec === "number" &&
                      Number.isFinite(session.durationSec)
                  )
                  .map((session) => ({
                    openedAt: session.openedAt as string,
                    closedAt: session.closedAt as string,
                    durationSec: Math.max(1, Math.round(session.durationSec as number)),
                    endPage:
                      typeof session.endPage === "number" && Number.isFinite(session.endPage)
                        ? Math.max(1, Math.round(session.endPage))
                        : undefined,
                    endZoom:
                      typeof session.endZoom === "number" && Number.isFinite(session.endZoom)
                        ? Math.max(1, Math.round(session.endZoom))
                        : undefined,
                    endAutoFit:
                      typeof session.endAutoFit === "boolean"
                        ? session.endAutoFit
                        : undefined,
                    endScrollTopRatio:
                      typeof session.endScrollTopRatio === "number" && Number.isFinite(session.endScrollTopRatio)
                        ? Math.max(0, Math.min(1, session.endScrollTopRatio))
                        : undefined,
                  }))
                  .slice(0, 10)
              : [];

            const snapshotRaw = item.snapshot;
            const snapshot =
              snapshotRaw &&
              typeof snapshotRaw === "object" &&
              typeof (snapshotRaw as Record<string, unknown>).lastPage === "number" &&
              typeof (snapshotRaw as Record<string, unknown>).totalPages === "number" &&
              typeof (snapshotRaw as Record<string, unknown>).zoom === "number"
                ? {
                    lastPage: Math.max(1, Math.round((snapshotRaw as Record<string, unknown>).lastPage as number)),
                    totalPages: Math.max(1, Math.round((snapshotRaw as Record<string, unknown>).totalPages as number)),
                    zoom: Math.max(1, Math.round((snapshotRaw as Record<string, unknown>).zoom as number)),
                    capturedAt:
                      typeof (snapshotRaw as Record<string, unknown>).capturedAt === "string"
                        ? ((snapshotRaw as Record<string, unknown>).capturedAt as string)
                        : new Date().toISOString(),
                    autoFit:
                      typeof (snapshotRaw as Record<string, unknown>).autoFit === "boolean"
                        ? ((snapshotRaw as Record<string, unknown>).autoFit as boolean)
                        : undefined,
                    scrollTopRatio:
                      typeof (snapshotRaw as Record<string, unknown>).scrollTopRatio === "number" &&
                      Number.isFinite((snapshotRaw as Record<string, unknown>).scrollTopRatio)
                        ? Math.max(0, Math.min(1, (snapshotRaw as Record<string, unknown>).scrollTopRatio as number))
                        : undefined,
                  }
                : undefined;

            return {
              path: item.path as string,
              name: item.name as string,
              lastOpenedAt:
                typeof item.lastOpenedAt === "string" && item.lastOpenedAt
                  ? item.lastOpenedAt
                  : new Date().toISOString(),
              missing: Boolean(item.missing),
              totalReadSeconds:
                typeof item.totalReadSeconds === "number" && Number.isFinite(item.totalReadSeconds)
                  ? Math.max(0, Math.round(item.totalReadSeconds))
                  : sessions.reduce((sum, session) => sum + session.durationSec, 0),
              sessions,
              snapshot,
            };
          })
          .slice(0, 80);
        setRecentFiles(nextRecentFiles);
        persistRecentFiles(nextRecentFiles);
      }

      if (Array.isArray(parsed.openedLinks)) {
        const seen = new Set<string>();
        const nextLinks = parsed.openedLinks
          .filter((item): item is string => typeof item === "string")
          .map((item) => canonicalizeUrl(item))
          .filter((item) => {
            const key = item.toLowerCase();
            if (!item || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 80);
        setOpenedLinks(nextLinks);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("pdf_reader_links", JSON.stringify(nextLinks));
        }
      }

      if (parsed.linkMeta && typeof parsed.linkMeta === "object") {
        const nextMetaEntries = Object.entries(parsed.linkMeta as Record<string, unknown>).filter(
          ([url, value]) => typeof url === "string" && typeof value === "string" && canonicalizeUrl(url)
        );
        const nextMeta = Object.fromEntries(nextMetaEntries) as Record<string, string>;
        setLinkMeta(nextMeta);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(LINK_META_KEY, JSON.stringify(nextMeta));
        }
      }

      if (Array.isArray(parsed.favorites)) {
        const nextFavorites: FavoriteItem[] = parsed.favorites
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              typeof item.title === "string" &&
              typeof item.target === "string" &&
              (item.type === "pdf" || item.type === "web")
          )
          .map((item) => ({
            id: item.id as string,
            type: item.type as "pdf" | "web",
            title: item.title as string,
            target: item.target as string,
            createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
          }))
          .slice(0, 120);
        setFavorites(nextFavorites);
      }

      if (Array.isArray(parsed.libraryCollections)) {
        const nextCollections: LibraryCollection[] = parsed.libraryCollections
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              typeof item.name === "string"
          )
          .map((item) => ({
            id: item.id as string,
            name: item.name as string,
            paths: Array.isArray(item.paths)
              ? (item.paths.filter((path): path is string => typeof path === "string").slice(0, 200))
              : [],
            createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
          }))
          .slice(0, 30);
        setLibraryCollections(nextCollections);
      }

      const importedGroups: WebTabGroup[] = Array.isArray(parsed.webTabGroups)
        ? parsed.webTabGroups
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              typeof item.name === "string"
          )
          .map((item) => ({
            id: item.id as string,
            name: item.name as string,
            collapsed: Boolean(item.collapsed),
          }))
          .slice(0, 24)
        : [];
      const nextGroups = importedGroups.some((group) => group.id === DEFAULT_WEB_GROUP_ID)
        ? importedGroups
        : [{ id: DEFAULT_WEB_GROUP_ID, name: "Web", collapsed: false }, ...importedGroups];
      if (importedGroups.length > 0) {
        setWebTabGroups(nextGroups);
      }
      if (Array.isArray(parsed.webTabs)) {
        const groupIds = new Set(nextGroups.map((group) => group.id));
        const nextTabs: WebTabItem[] = parsed.webTabs
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              typeof item.url === "string" &&
              typeof item.title === "string"
          )
          .map((item) => ({
            id: item.id as string,
            url: normalizeUrl(item.url as string),
            title: item.title as string,
            pinned: Boolean(item.pinned),
            groupId:
              typeof item.groupId === "string" && groupIds.has(item.groupId)
                ? item.groupId
                : DEFAULT_WEB_GROUP_ID,
            createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
          }))
          .filter((item) => item.url)
          .slice(0, 80);
        setWebTabs(nextTabs);
        setActiveWebTabId((prev) => (prev && nextTabs.some((tab) => tab.id === prev) ? prev : nextTabs[0]?.id || ""));
      }

      setMainPanel("viewer");
      setActiveFileId((prev) => (prev && files.some((file) => file.id === prev) ? prev : ""));
      await showNoticeDialog(text.importSuccess, "info");
    } catch (error) {
      debugError("settings", "import app data failed", error);
      await showNoticeDialog(text.importFailed, "error");
    }
  };

  const exportAppDataBundle = async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const fileName = `r0nix-data-${stamp}.json`;
    const payload = {
      app: {
        name: "r0nix",
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
      },
      usage: {
        totalReadSeconds: recentFiles.reduce((sum, item) => sum + (item.totalReadSeconds || 0), 0),
        sessionCount: recentFiles.reduce((sum, item) => sum + (item.sessions?.length || 0), 0),
        recentFileCount: recentFiles.length,
      },
      settings,
      recentFiles,
      openedLinks,
      linkMeta,
      favorites,
      libraryCollections,
      webTabs,
      webTabGroups,
    };
    const content = JSON.stringify(payload, null, 2);

    if (isTauri) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const targetPath = await save({
          defaultPath: withDefaultDir(fileName, settings.defaultSaveDir),
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!targetPath || Array.isArray(targetPath)) return;
        await writeTextFile(targetPath, content);
        return;
      } catch (error) {
        debugError("settings", "export app data failed", error);
      }
    }

    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    downloadBlob(blob, fileName);
  };

  const exportLibraryList = async (format: "csv" | "md" | "json", items: RecentFileItem[]) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName =
      format === "csv"
        ? `r0nix-library-${stamp}.csv`
        : format === "md"
          ? `r0nix-library-${stamp}.md`
          : `r0nix-library-${stamp}.json`;
    const csvCell = (value: string) => `"${value.replace(/"/g, "\"\"")}"`;
    const lines = items.map((item) => {
      const lastPage = item.snapshot?.lastPage ?? 0;
      const totalPages = item.snapshot?.totalPages ?? 0;
      const zoom = item.snapshot?.zoom ?? 0;
      return {
        name: item.name,
        path: item.path,
        lastOpenedAt: item.lastOpenedAt || "",
        missing: item.missing ? "yes" : "no",
        progress: lastPage > 0 && totalPages > 0 ? `${lastPage}/${totalPages}` : "",
        zoom: zoom > 0 ? `${zoom}%` : "",
      };
    });
    const content =
      format === "csv"
        ? [
            "name,path,last_opened,missing,progress,zoom",
            ...lines.map((item) =>
              [
                csvCell(item.name),
                csvCell(item.path),
                csvCell(item.lastOpenedAt),
                csvCell(item.missing),
                csvCell(item.progress),
                csvCell(item.zoom),
              ].join(",")
            ),
          ].join("\n")
        : format === "md"
          ? [
              "# r0nix library export",
              "",
              `Generated at: ${new Date().toLocaleString()}`,
              "",
              "| Name | Path | Last opened | Missing | Progress | Zoom |",
              "| --- | --- | --- | --- | --- | --- |",
              ...lines.map(
                (item) =>
                  `| ${item.name.replace(/\|/g, "\\|")} | ${item.path.replace(/\|/g, "\\|")} | ${item.lastOpenedAt.replace(/\|/g, "\\|")} | ${item.missing} | ${item.progress} | ${item.zoom} |`
              ),
            ].join("\n")
          : JSON.stringify(
              {
                app: "r0nix",
                exportedAt: new Date().toISOString(),
                count: lines.length,
                items: lines,
              },
              null,
              2
            );

    if (isTauri) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const targetPath = await save({
          defaultPath: withDefaultDir(fileName, settings.defaultSaveDir),
          filters: [
            {
              name: format === "csv" ? "CSV" : format === "md" ? "Markdown" : "JSON",
              extensions: [format === "md" ? "md" : format],
            },
          ],
        });
        if (!targetPath || Array.isArray(targetPath)) return;
        await writeTextFile(targetPath, content);
        return;
      } catch (error) {
        debugError("library", "export in tauri failed", { format, error });
      }
    }

    const blob = new Blob([content], {
      type:
        format === "csv"
          ? "text/csv;charset=utf-8"
          : format === "md"
            ? "text/markdown;charset=utf-8"
            : "application/json;charset=utf-8",
    });
    downloadBlob(blob, fileName);
  };

  const upsertOpenedFile = (fileInfo: Awaited<ReturnType<typeof api.openFile>>) => {
    debugLog("app", "upsert opened file", fileInfo);
    const newFile: FileItem = {
      id: fileInfo.id,
      name: fileInfo.name,
      type: fileInfo.type as "pdf" | "markdown",
      path: fileInfo.path,
      meta: fileInfo.meta.pages ? `${fileInfo.meta.pages} pages` : undefined,
    };

    const existedByPath = findOpenedFileByPath(newFile.path);

    setFiles((prev) => {
      const idxById = prev.findIndex((file) => file.id === newFile.id);
      if (idxById >= 0) {
        const next = [...prev];
        next[idxById] = newFile;
        return next;
      }

      const idxByPath = prev.findIndex((file) => samePath(file.path || "", newFile.path || ""));
      if (idxByPath >= 0) {
        const next = [...prev];
        next[idxByPath] = { ...next[idxByPath], ...newFile, id: next[idxByPath].id };
        return next;
      }

      return [...prev, newFile];
    });
    setActiveFileId(existedByPath?.id || newFile.id);
    setMainPanel("viewer");
    const totalPages = fileInfo.meta?.pages || (newFile.meta ? Number.parseInt(newFile.meta, 10) || 1 : 1);
    const existingRecent = recentFiles.find((item) => item.path === newFile.path);
    rememberRecentFile(
      newFile.path,
      newFile.name,
      existingRecent?.snapshot
        ? undefined
        : {
            lastPage: 1,
            totalPages: Math.max(1, totalPages),
            zoom: 100,
            capturedAt: new Date().toISOString(),
            autoFit: true,
            scrollTopRatio: 0,
          }
    );
  };

  const closeFileTab = (fileId: string) => {
    setFiles((prev) => {
      const idx = prev.findIndex((file) => file.id === fileId);
      if (idx === -1) return prev;
      const next = prev.filter((file) => file.id !== fileId);
      if (activeFileId === fileId) {
        const fallback = next[idx - 1]?.id ?? next[idx]?.id ?? "";
        setActiveFileId(fallback);
        if (fallback) {
          setMainPanel("viewer");
        } else if (webTabs.length > 0) {
          setMainPanel("web");
          setActiveWebTabId((prevWeb) => (prevWeb && webTabs.some((tab) => tab.id === prevWeb) ? prevWeb : webTabs[0].id));
        } else {
          setActiveFileId("");
          setMainPanel("viewer");
        }
      }
      return next;
    });
    void api.closeFile(fileId).catch((error) => {
      debugError("app", "close tab file failed", { fileId, error });
    });
  };

  const openFileByPath = async (path: string, silent = false) => {
    const opened = findOpenedFileByPath(path);
    if (opened) {
      setActiveFileId(opened.id);
      setMainPanel("viewer");
      rememberRecentFile(path, opened.name);
      if (!silent) setMenuOpen(null);
      return;
    }
    const fileInfo = await api.openFile(path);
    upsertOpenedFile(fileInfo);
    if (!silent) setMenuOpen(null);
  };

  const loadFileList = async () => {
    try {
      debugLog("app", "loading file list");
      const result = await api.listFiles();
      const mappedFiles: FileItem[] = result.files.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type as "pdf" | "markdown",
        path: f.path,
        meta: f.meta.pages ? `${f.meta.pages} pages` : undefined,
      }));
      setFiles(mappedFiles);
      setActiveFileId((prev) => {
        if (mappedFiles.length === 0) return "";
        if (prev && mappedFiles.some((file) => file.id === prev)) return prev;
        return mappedFiles[0].id;
      });
      debugLog("app", "file list loaded", mappedFiles.map((f) => ({ id: f.id, name: f.name })));

      if (isTauri && mappedFiles.length === 0 && !restoredLastFileRef.current) {
        restoredLastFileRef.current = true;
        const lastPath = typeof window !== "undefined" ? window.localStorage.getItem(LAST_FILE_KEY) : "";
        if (lastPath) {
          try {
            await openFileByPath(lastPath, true);
          } catch (error) {
            debugError("app", "restore last file failed", { lastPath, error });
            removeRecentFile(lastPath);
          }
        }
      }
    } catch (error) {
      console.error("Failed to load files:", error);
      debugError("app", "file list load failed", error);
    }
  };

  const handleOpenRecentFile = async (path: string) => {
    const opened = findOpenedFileByPath(path);
    if (opened) {
      setActiveFileId(opened.id);
      setMainPanel("viewer");
      rememberRecentFile(path, opened.name);
      setMenuOpen(null);
      return;
    }

    try {
      await openFileByPath(path);
    } catch (error) {
      if (!isTauri && isBackendOfflineError(error)) {
        debugError("open", "browser reopen failed without backend", { path, error });
      }
      debugError("open", "open recent failed", { path, error });
      markRecentFileMissing(path, true);
      console.error(`${text.openFailed}:`, error);
    }
  };

  const handleContinueRecentSession = (
    path: string,
    session: {
      endPage: number;
      endZoom?: number;
      endAutoFit?: boolean;
      endScrollTopRatio?: number;
    }
  ) => {
    const target = recentFiles.find((item) => item.path === path);
    const safePage = Math.max(1, Math.round(session.endPage || 1));
    const safeZoom = Math.max(
      50,
      Math.min(
        400,
        Math.round(
          typeof session.endZoom === "number" && Number.isFinite(session.endZoom)
            ? session.endZoom
            : (target?.snapshot?.zoom || 100)
        )
      )
    );
    const totalPages = Math.max(safePage, target?.snapshot?.totalPages || safePage);
    updateRecentFileSnapshot(path, {
      lastPage: safePage,
      totalPages,
      zoom: safeZoom,
      autoFit:
        typeof session.endAutoFit === "boolean"
          ? session.endAutoFit
          : false,
      scrollTopRatio:
        typeof session.endScrollTopRatio === "number" && Number.isFinite(session.endScrollTopRatio)
          ? Math.max(0, Math.min(1, session.endScrollTopRatio))
          : 0,
    });
    markRecentFileMissing(path, false);
    void handleOpenRecentFile(path);
  };

  const handleRelocateRecentFile = async (missingPath: string) => {
    if (!isTauri) {
      await handleOpenFile();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const nextPath = String(selected);
      if (!nextPath) return;
      const previousRecent = recentFiles.find((item) => item.path === missingPath);
      const previousSnapshot = previousRecent?.snapshot;
      await openFileByPath(nextPath, true);
      if (previousSnapshot) {
        updateRecentFileSnapshot(nextPath, previousSnapshot);
      }
      if (nextPath !== missingPath) {
        if (previousRecent) {
          setRecentFiles((prev) => {
            const source = prev.find((item) => item.path === missingPath);
            if (!source) return prev;
            const target = prev.find((item) => item.path === nextPath);
            const merged: RecentFileItem = {
              ...(target || source),
              path: nextPath,
              name: fileNameFromPath(nextPath),
              lastOpenedAt: new Date().toISOString(),
              missing: false,
              snapshot: target?.snapshot || source.snapshot,
              totalReadSeconds: (target?.totalReadSeconds || 0) + (source.totalReadSeconds || 0),
              sessions: [...(source.sessions || []), ...(target?.sessions || [])]
                .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
                .slice(0, 10),
            };
            const filtered = prev.filter((item) => item.path !== missingPath && item.path !== nextPath);
            const next = [merged, ...filtered].slice(0, 20);
            persistRecentFiles(next);
            return next;
          });
        } else {
          removeRecentFile(missingPath);
        }
        setFavorites((prev) =>
          prev.map((item) =>
            item.type === "pdf" && item.target === missingPath
              ? { ...item, target: nextPath, title: fileNameFromPath(nextPath) }
              : item
          )
        );
      }
      markRecentFileMissing(nextPath, false);
      setMenuOpen(null);
    } catch (error) {
      debugError("open", "relocate recent file failed", { missingPath, error });
      console.error(`${text.openFailed}:`, error);
    }
  };

  const handleOpenFile = async () => {
    debugLog("open", "open button clicked", { isTauri });

    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (!selected || Array.isArray(selected)) {
          debugLog("open", "tauri dialog canceled");
          return;
        }
        debugLog("open", "tauri dialog selected", selected);
        await openFileByPath(selected);
        return;
      } catch (error) {
        debugError("open", "tauri dialog open failed, fallback html input", error);
      }
    }

    const input = fileInputRef.current;
    if (!input) {
      debugError("open", "file input ref is null");
      return;
    }

    try {
      if ("showPicker" in input && typeof input.showPicker === "function") {
        debugLog("open", "calling input.showPicker()");
        input.showPicker();
      } else {
        debugLog("open", "calling input.click()");
        input.click();
      }
    } catch (error) {
      debugError("open", "input picker failed, fallback click", error);
      input.click();
    }
  };

  const handleFileInputChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    debugLog("open", "html input changed", file?.name);
    if (!file) return;

    try {
      const fileInfo = await api.uploadFile(file);
      upsertOpenedFile(fileInfo);
    } catch (error) {
      console.error("Failed to open file:", error);
      debugError("open", "html input open failed", error);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  useEffect(() => {
    const shouldIgnoreTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    };

    const onShortcut = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (shouldIgnoreTarget(e.target)) return;
      const key = e.key.toLowerCase();

      if (e.shiftKey && key === "b") {
        e.preventDefault();
        setSidebarVisible((prev) => !prev);
        return;
      }
      if (key === "o") {
        e.preventDefault();
        setMenuOpen(null);
        void handleOpenFile();
        return;
      }
      if (key === "t") {
        e.preventDefault();
        setMenuOpen(null);
        createEmptyWebTab();
        return;
      }
      if (key === ",") {
        e.preventDefault();
        openSettingsPanel();
        return;
      }
      if (key === "1") {
        e.preventDefault();
        setMainPanel("viewer");
        return;
      }
      if (key === "2") {
        e.preventDefault();
        if (webTabs.length === 0) createEmptyWebTab();
        else {
          setMainPanel("web");
          setActiveWebTabId((prev) => prev || webTabs[0]?.id || "");
        }
        return;
      }
      if (key === "3") {
        e.preventDefault();
        openSettingsPanel();
        return;
      }
      if (key === "4") {
        e.preventDefault();
        openLibraryPanel();
      }
    };

    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, [webTabs, openSettingsPanel, openLibraryPanel, handleOpenFile, createEmptyWebTab]);

  const recentList = recentFiles.map((item) => ({
    name: item.name,
    path: item.path,
    lastOpenedAt: item.lastOpenedAt,
    totalReadSeconds: item.totalReadSeconds,
    sessions: item.sessions,
    missing: Boolean(item.missing),
    snapshot: item.snapshot,
  }));

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        style={{
          position: "fixed",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
        onChange={handleFileInputChange}
      />

      <header className="app-topbar" ref={menuRef}>
        <div className="topbar-menus">
          <div className="topbar-menu-slot">
            <button type="button" className={`topbar-menu-btn ${menuOpen === "file" ? "active" : ""}`} onClick={() => setMenuOpen((prev) => (prev === "file" ? null : "file"))}>
              <span>{text.file}</span>
            </button>
            {menuOpen === "file" && (
              <div className="topbar-dropdown">
                <button type="button" className="topbar-action" onClick={() => { setMenuOpen(null); void handleOpenFile(); }}>
                  <span className="topbar-action-main"><FolderOpen size={14} /><span>{text.openPdf}</span></span>
                  <span className="topbar-kbd">Ctrl+O</span>
                </button>
                <button type="button" className="topbar-action" onClick={() => { setMenuOpen(null); createEmptyWebTab(); }}>
                  <span className="topbar-action-main"><Plus size={14} /><span>{text.newWebTab}</span></span>
                  <span className="topbar-kbd">Ctrl+T</span>
                </button>
                <button type="button" className="topbar-action" onClick={() => { const last = recentFiles[0]?.path; setMenuOpen(null); if (last) void handleOpenRecentFile(last); }}>
                  <span className="topbar-action-main"><Clock3 size={14} /><span>{text.reopenLast}</span></span>
                  <span className="topbar-kbd">Ctrl+Shift+O</span>
                </button>
                <div className="topbar-menu-row">
                  <button type="button" className="topbar-menu-row-btn topbar-action">
                    <span className="topbar-action-main"><Clock3 size={14} /><span>{text.recentMenu}</span></span>
                    <span className="topbar-arrow">{">"}</span>
                  </button>
                  <div className="topbar-submenu">
                    {recentFiles.length === 0 ? (
                      <div className="topbar-empty">{text.noRecent}</div>
                    ) : (
                      recentFiles.slice(0, 10).map((item) => (
                        <button key={item.path} type="button" className="topbar-recent-btn" title={item.path} onClick={() => { setMenuOpen(null); void handleOpenRecentFile(item.path); }}>
                          <span className="topbar-recent-name">{item.name}</span>
                          <span className="topbar-recent-path">{item.path}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
                <div className="topbar-menu-row">
                  <button type="button" className="topbar-menu-row-btn topbar-action">
                    <span className="topbar-action-main"><Globe2 size={14} /><span>{text.recentLinksMenu}</span></span>
                    <span className="topbar-arrow">{">"}</span>
                  </button>
                  <div className="topbar-submenu">
                    {openedLinks.length === 0 ? (
                      <div className="topbar-empty">{text.noRecentLinks}</div>
                    ) : (
                      openedLinks.slice(0, 12).map((link) => (
                        <button key={link} type="button" className="topbar-recent-btn" title={link} onClick={() => { setMenuOpen(null); void handleOpenLink(link); }}>
                          <span className="topbar-recent-name">{link.replace(/^https?:\/\//i, "")}</span>
                          <span className="topbar-recent-path">{link}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
                <div className="topbar-divider" />
                <button type="button" className="topbar-action" onClick={() => { setRecentFiles(() => { persistRecentFiles([]); return []; }); setMenuOpen(null); }}>
                  <span className="topbar-action-main"><Trash2 size={14} /><span>{text.clearRecent}</span></span>
                </button>
                <button
                  type="button"
                  className="topbar-action"
                  onClick={() => {
                    clearLinkResources();
                    setMenuOpen(null);
                  }}
                >
                  <span className="topbar-action-main"><Trash2 size={14} /><span>{text.clearRecentLinks}</span></span>
                </button>
              </div>
            )}
          </div>

          <div className="topbar-menu-slot">
            <button type="button" className={`topbar-menu-btn ${menuOpen === "settings" ? "active" : ""}`} onClick={() => setMenuOpen((prev) => (prev === "settings" ? null : "settings"))}>
              <span>{text.settings}</span>
            </button>
            {menuOpen === "settings" && (
              <div className="topbar-dropdown topbar-dropdown-settings">
                <button type="button" className="topbar-action" onClick={openSettingsPanel}>
                  <span className="topbar-action-main"><Settings2 size={14} /><span>{text.openSettings}</span></span>
                  <span className="topbar-kbd">Ctrl+,</span>
                </button>
                <div className="topbar-divider" />
                <div className="topbar-menu-row">
                  <button type="button" className="topbar-menu-row-btn topbar-action">
                    <span className="topbar-action-main"><Languages size={14} /><span>{text.language}</span></span>
                    <span className="topbar-arrow">{">"}</span>
                  </button>
                  <div className="topbar-submenu">
                    <button type="button" className={`topbar-action ${language === "zh" ? "checked" : ""}`} onClick={() => { updateLanguage("zh"); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Languages size={14} /><span>{text.zh}</span></span>
                      {language === "zh" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${language === "en" ? "checked" : ""}`} onClick={() => { updateLanguage("en"); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Languages size={14} /><span>{text.en}</span></span>
                      {language === "en" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                  </div>
                </div>
                <div className="topbar-menu-row">
                  <button type="button" className="topbar-menu-row-btn topbar-action">
                    <span className="topbar-action-main"><Palette size={14} /><span>{text.appearanceMenu}</span></span>
                    <span className="topbar-arrow">{">"}</span>
                  </button>
                  <div className="topbar-submenu">
                    <div className="topbar-group-title">{text.themeMode}</div>
                    <button type="button" className={`topbar-action ${settings.themeMode === "system" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeMode: "system" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Monitor size={14} /><span>{text.themeSystem}</span></span>
                      {settings.themeMode === "system" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themeMode === "light" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeMode: "light" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Sun size={14} /><span>{text.themeLight}</span></span>
                      {settings.themeMode === "light" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themeMode === "dark" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeMode: "dark" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Moon size={14} /><span>{text.themeDark}</span></span>
                      {settings.themeMode === "dark" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <div className="topbar-divider" />
                    <div className="topbar-group-title">{text.themePalette}</div>
                    <button type="button" className={`topbar-action ${settings.themePalette === "default" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themePalette: "default" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.paletteDefault}</span></span>
                      {settings.themePalette === "default" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themePalette === "graphite" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themePalette: "graphite" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.paletteGraphite}</span></span>
                      {settings.themePalette === "graphite" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themePalette === "slate" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themePalette: "slate" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.paletteSlate}</span></span>
                      {settings.themePalette === "slate" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themePalette === "indigo" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themePalette: "indigo" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.paletteIndigo}</span></span>
                      {settings.themePalette === "indigo" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <div className="topbar-divider" />
                    <div className="topbar-group-title">{text.themeAccent}</div>
                    <button type="button" className={`topbar-action ${settings.themeAccent === "blue" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeAccent: "blue" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.accentBlue}<span className="topbar-color-dot accent-blue" /></span></span>
                      {settings.themeAccent === "blue" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themeAccent === "green" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeAccent: "green" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.accentGreen}<span className="topbar-color-dot accent-green" /></span></span>
                      {settings.themeAccent === "green" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themeAccent === "orange" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeAccent: "orange" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.accentOrange}<span className="topbar-color-dot accent-orange" /></span></span>
                      {settings.themeAccent === "orange" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themeAccent === "rose" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeAccent: "rose" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.accentRose}<span className="topbar-color-dot accent-rose" /></span></span>
                      {settings.themeAccent === "rose" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button type="button" className={`topbar-action ${settings.themeAccent === "violet" ? "checked" : ""}`} onClick={() => { applySettingsPatch({ themeAccent: "violet" }); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Palette size={14} /><span>{text.accentViolet}<span className="topbar-color-dot accent-violet" /></span></span>
                      {settings.themeAccent === "violet" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <div className="topbar-divider" />
                    <button type="button" className="topbar-action" onClick={() => { resetAppearanceSettings(); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Settings2 size={14} /><span>{text.resetAppearance}</span></span>
                    </button>
                  </div>
                </div>
                <div className="topbar-menu-row">
                  <button type="button" className="topbar-menu-row-btn topbar-action">
                    <span className="topbar-action-main"><Link2 size={14} /><span>{text.webLinkMenu}</span></span>
                    <span className="topbar-arrow">{">"}</span>
                  </button>
                  <div className="topbar-submenu">
                    <div className="topbar-group-title">{text.linkOpenQuick}</div>
                    <button
                      type="button"
                      className={`topbar-action ${settings.openLinksInsideApp ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ openLinksInsideApp: true });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><Link2 size={14} /><span>{text.openInside}</span></span>
                      {settings.openLinksInsideApp ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button
                      type="button"
                      className={`topbar-action ${!settings.openLinksInsideApp ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ openLinksInsideApp: false });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><ExternalLink size={14} /><span>{text.openOutside}</span></span>
                      {!settings.openLinksInsideApp ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <div className="topbar-divider" />
                    <div className="topbar-group-title">{text.webPdfMode}</div>
                    <button
                      type="button"
                      className={`topbar-action ${settings.webPdfOpenMode === "direct" ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ webPdfOpenMode: "direct" });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><BookOpen size={14} /><span>{text.webPdfDirect}</span></span>
                      {settings.webPdfOpenMode === "direct" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button
                      type="button"
                      className={`topbar-action ${settings.webPdfOpenMode === "download_then_open" ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ webPdfOpenMode: "download_then_open" });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><FolderOpen size={14} /><span>{text.webPdfDownload}</span></span>
                      {settings.webPdfOpenMode === "download_then_open" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <div className="topbar-divider" />
                    <div className="topbar-group-title">{text.webPanelMode}</div>
                    <button
                      type="button"
                      className={`topbar-action ${settings.webPanelMode === "iframe" ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ webPanelMode: "iframe" });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><Globe2 size={14} /><span>{text.webPanelIframe}</span></span>
                      {settings.webPanelMode === "iframe" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button
                      type="button"
                      disabled={!nativeWebviewEnabled}
                      className={`topbar-action ${settings.webPanelMode === "native_webview" ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ webPanelMode: "native_webview" });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main">
                        <Globe2 size={14} />
                        <span>{nativeWebviewEnabled ? text.webPanelNative : `${text.webPanelNative} · ${text.desktopOnly}`}</span>
                      </span>
                      {settings.webPanelMode === "native_webview" ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                  </div>
                </div>
                <div className="topbar-menu-row">
                  <button type="button" className="topbar-menu-row-btn topbar-action">
                    <span className="topbar-action-main"><Globe2 size={14} /><span>{text.networkMenu}</span></span>
                    <span className="topbar-arrow">{">"}</span>
                  </button>
                  <div className="topbar-submenu">
                    <div className="topbar-group-title">{text.proxyTitle}</div>
                    <button
                      type="button"
                      className={`topbar-action ${settings.proxyEnabled ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ proxyEnabled: true });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><Globe2 size={14} /><span>{text.proxyEnabled}</span></span>
                      {settings.proxyEnabled ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <button
                      type="button"
                      className={`topbar-action ${!settings.proxyEnabled ? "checked" : ""}`}
                      onClick={() => {
                        applySettingsPatch({ proxyEnabled: false });
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><Globe2 size={14} /><span>{text.proxyDisabled}</span></span>
                      {!settings.proxyEnabled ? <Check size={14} className="topbar-check" /> : null}
                    </button>
                    <div className="topbar-divider" />
                    <button type="button" className="topbar-action" onClick={openSettingsPanel}>
                      <span className="topbar-action-main"><Settings2 size={14} /><span>{text.proxyConfigure}</span></span>
                    </button>
                  </div>
                </div>
                <div className="topbar-menu-row">
                  <button type="button" className="topbar-menu-row-btn topbar-action">
                    <span className="topbar-action-main"><LayoutPanelLeft size={14} /><span>{text.workspaceMenu}</span></span>
                    <span className="topbar-arrow">{">"}</span>
                  </button>
                  <div className="topbar-submenu">
                    <button type="button" className="topbar-action" onClick={() => { setSidebarVisible((prev) => !prev); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><LayoutPanelLeft size={14} /><span>{sidebarVisible ? text.hideSidebar : text.showSidebar}</span></span>
                      <span className="topbar-kbd">Ctrl+Shift+B</span>
                    </button>
                    <button type="button" className="topbar-action" onClick={() => { openHomeTab(); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><House size={14} /><span>{text.showStartPage}</span></span>
                    </button>
                    <div className="topbar-divider" />
                    <button type="button" className="topbar-action" onClick={() => { setMainPanel("viewer"); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><BookOpen size={14} /><span>{text.focusViewer}</span></span>
                      <span className="topbar-kbd">Ctrl+1</span>
                    </button>
                    <button
                      type="button"
                      className="topbar-action"
                      onClick={() => {
                        if (webTabs.length === 0) createEmptyWebTab();
                        else {
                          setMainPanel("web");
                          setActiveWebTabId((prev) => prev || webTabs[0]?.id || "");
                        }
                        setMenuOpen(null);
                      }}
                    >
                      <span className="topbar-action-main"><Globe2 size={14} /><span>{text.focusWeb}</span></span>
                      <span className="topbar-kbd">Ctrl+2</span>
                    </button>
                    <button type="button" className="topbar-action" onClick={() => { openSettingsPanel(); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Settings2 size={14} /><span>{text.focusSettings}</span></span>
                      <span className="topbar-kbd">Ctrl+3</span>
                    </button>
                    <button type="button" className="topbar-action" onClick={() => { openLibraryPanel(); setMenuOpen(null); }}>
                      <span className="topbar-action-main"><Library size={14} /><span>{text.focusLibrary}</span></span>
                      <span className="topbar-kbd">Ctrl+4</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="topbar-menu-slot">
            <button type="button" className={`topbar-menu-btn ${menuOpen === "view" ? "active" : ""}`} onClick={() => setMenuOpen((prev) => (prev === "view" ? null : "view"))}>
              <span>{text.view}</span>
            </button>
            {menuOpen === "view" && (
              <div className="topbar-dropdown">
                <button type="button" className="topbar-action" onClick={() => { setSidebarVisible((prev) => !prev); setMenuOpen(null); }}>
                  <span className="topbar-action-main"><LayoutPanelLeft size={14} /><span>{sidebarVisible ? text.hideSidebar : text.showSidebar}</span></span>
                  <span className="topbar-kbd">Ctrl+Shift+B</span>
                </button>
                <button type="button" className="topbar-action" onClick={() => { openHomeTab(); setMenuOpen(null); }}>
                  <span className="topbar-action-main"><House size={14} /><span>{text.showStartPage}</span></span>
                </button>
                <div className="topbar-divider" />
                <button type="button" className="topbar-action" onClick={() => { setMainPanel("viewer"); setMenuOpen(null); }}>
                  <span className="topbar-action-main"><BookOpen size={14} /><span>{text.focusViewer}</span></span>
                  <span className="topbar-kbd">Ctrl+1</span>
                </button>
                <button
                  type="button"
                  className="topbar-action"
                  onClick={() => {
                    if (webTabs.length === 0) createEmptyWebTab();
                    else {
                      setMainPanel("web");
                      setActiveWebTabId((prev) => prev || webTabs[0]?.id || "");
                    }
                    setMenuOpen(null);
                  }}
                >
                  <span className="topbar-action-main"><Globe2 size={14} /><span>{text.focusWeb}</span></span>
                  <span className="topbar-kbd">Ctrl+2</span>
                </button>
                <button type="button" className="topbar-action" onClick={() => { openSettingsPanel(); setMenuOpen(null); }}>
                  <span className="topbar-action-main"><Settings2 size={14} /><span>{text.focusSettings}</span></span>
                  <span className="topbar-kbd">Ctrl+3</span>
                </button>
                <button type="button" className="topbar-action" onClick={() => { openLibraryPanel(); setMenuOpen(null); }}>
                  <span className="topbar-action-main"><Library size={14} /><span>{text.focusLibrary}</span></span>
                  <span className="topbar-kbd">Ctrl+4</span>
                </button>
              </div>
            )}
          </div>

          <div className="topbar-menu-slot">
            <button type="button" className={`topbar-menu-btn ${menuOpen === "about" ? "active" : ""}`} onClick={() => setMenuOpen((prev) => (prev === "about" ? null : "about"))}>
              <span>{text.about}</span>
            </button>
            {menuOpen === "about" && (
              <div className="topbar-dropdown topbar-dropdown-native">
                <div className="topbar-about"><Info size={14} />{text.aboutName}</div>
                <div className="topbar-empty">{text.aboutVersion}</div>
                <button type="button" className="topbar-action" onClick={() => { void handleOpenLink("https://github.com/tauri-apps/tauri"); setMenuOpen(null); }}>
                  <span className="topbar-action-main"><ExternalLink size={14} /><span>{text.aboutSite}</span></span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="app-body">
        {sidebarVisible && (
          <Sidebar
            files={files}
            activeFileId={activeFileId}
            webTabs={webTabs}
            webTabGroups={webTabGroups}
            newWebTabId={newWebTabId}
            activeWebTabId={activeWebTabId}
            language={language}
            links={openedLinks}
            linkMeta={linkMeta}
            recentFiles={recentFiles}
            favorites={favorites}
            libraryCollections={libraryCollections}
            mainPanel={mainPanel}
            settingsTabOpen={settingsTabOpen}
            libraryTabOpen={libraryTabOpen}
            onFileSelect={(id) => {
              setActiveFileId(id);
              setMainPanel("viewer");
            }}
            onWebTabSelect={(id) => {
              setActiveWebTabId(id);
              setMainPanel("web");
            }}
            onCreateWebTab={createEmptyWebTab}
            onOpenFile={handleOpenFile}
            onOpenHomeTab={openHomeTab}
            onOpenRecentFile={handleOpenRecentFile}
            onContinueRecentSession={handleContinueRecentSession}
            onRelocateRecentFile={handleRelocateRecentFile}
            onOpenLink={handleOpenLink}
            onOpenSettingsTab={openSettingsPanel}
            onOpenLibraryTab={openLibraryPanel}
            onCloseFileTab={closeFileTab}
            onReorderFileTab={reorderFileTabs}
            onCloseWebTab={closeWebTab}
            onToggleWebTabPinned={toggleWebTabPinned}
            onAddWebTabFavorite={addWebTabFavorite}
            onTogglePdfFavorite={togglePdfFavorite}
            onToggleWebFavorite={toggleWebFavoriteByUrl}
            onRemoveRecentResource={removeRecentResource}
            onClearRecentResources={clearRecentResources}
            onRemoveLinkResource={removeLinkResource}
            onClearLinkResources={clearLinkResources}
            onAddFileToLibrary={(path, name) => addPathToLibraryCollection(path, name)}
            onMoveWebTabToGroup={moveWebTabToGroup}
            onReorderWebTab={reorderWebTabs}
            onCreateWebTabGroup={createWebTabGroup}
            onToggleWebTabGroupCollapsed={toggleWebTabGroupCollapsed}
            onCloseSettingsTab={closeSettingsTab}
            onCloseLibraryTab={closeLibraryTab}
          />
        )}

        <main className={`main-content ${webReturningToViewer ? "web-returning" : ""}`}>
          {mainPanel === "settings" ? (
            <section className="settings-page">
              <header className="settings-page-header">
                <h2>{text.settingsTitle}</h2>
                <button type="button" className="settings-back-btn" onClick={() => setMainPanel("viewer")}>{text.backToReader}</button>
              </header>
              <div className="settings-page-body">
                <label className="settings-row">
                  <span>{text.defaultFormat}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.defaultFormat}>
                    {(["svg", "png", "jpg"] as DefaultExportFormat[]).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        className={`settings-choice-btn ${settingsDraft.defaultExportFormat === fmt ? "active" : ""}`}
                        onClick={() => setSettingsDraft((prev) => ({ ...prev, defaultExportFormat: fmt }))}
                      >
                        {fmt.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="settings-row">
                  <span>{text.defaultPath}</span>
                  <div className="settings-path-row">
                    <input
                      type="text"
                      value={settingsDraft.defaultSaveDir}
                      onChange={(e) => setSettingsDraft((prev) => ({ ...prev, defaultSaveDir: e.target.value }))}
                      placeholder={isTauri ? "C:\\Users\\...\\Downloads" : "optional"}
                    />
                    {isTauri && <button type="button" onClick={() => void pickDefaultFolder()}>{text.chooseFolder}</button>}
                  </div>
                </label>
                <label className="settings-row">
                  <span>{text.newTabDefaultUrl}</span>
                  <input
                    type="text"
                    value={settingsDraft.newTabDefaultUrl}
                    onChange={(e) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        newTabDefaultUrl: e.target.value,
                      }))
                    }
                    placeholder="https://limestart.cn"
                  />
                </label>
                <section className="settings-row">
                  <div className="settings-row-head">
                    <span>{text.quickLinksTitle}</span>
                    <button type="button" className="settings-mini-btn" onClick={addQuickLink}>
                      {text.addQuickLink}
                    </button>
                  </div>
                  <span className="settings-row-note">{text.quickLinksHint}</span>
                  <div className="settings-quick-links">
                    {settingsDraft.quickLinks.map((item, index, source) => (
                      <div
                        key={item.id}
                        className={`settings-quick-link-row ${dragQuickLinkId === item.id ? "dragging" : ""} ${dropQuickLinkId === item.id && dragQuickLinkId !== item.id ? "drop-target" : ""} ${newQuickLinkId === item.id ? "new" : ""}`}
                        onDragEnter={() => {
                          if (!dragQuickLinkId || dragQuickLinkId === item.id) return;
                          setDropQuickLinkId(item.id);
                        }}
                        onDragOver={(e) => {
                          if (!dragQuickLinkId || dragQuickLinkId === item.id) return;
                          e.preventDefault();
                          setDropQuickLinkId(item.id);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!dragQuickLinkId || dragQuickLinkId === item.id) return;
                          reorderQuickLinks(dragQuickLinkId, item.id);
                          setDropQuickLinkId("");
                          setDragQuickLinkId("");
                        }}
                      >
                        <span
                          className="settings-quick-link-grip"
                          draggable
                          title={text.dragToSort}
                          aria-label={text.dragToSort}
                          onDragStart={() => {
                            setDragQuickLinkId(item.id);
                            setDropQuickLinkId(item.id);
                          }}
                          onDragEnd={() => {
                            setDropQuickLinkId("");
                            setDragQuickLinkId("");
                          }}
                        >
                          ::
                        </span>
                        <input
                          type="text"
                          value={item.title}
                          placeholder={text.quickLinkName}
                          onChange={(e) => updateQuickLink(item.id, { title: e.target.value })}
                        />
                        <input
                          type="text"
                          value={item.url}
                          placeholder={text.quickLinkUrl}
                          onChange={(e) => updateQuickLink(item.id, { url: e.target.value })}
                        />
                        <div className="settings-quick-link-actions">
                          <button type="button" className="settings-icon-btn" onClick={() => moveQuickLink(item.id, -1)} disabled={index === 0}>
                            {text.moveUp}
                          </button>
                          <button
                            type="button"
                            className="settings-icon-btn"
                            onClick={() => moveQuickLink(item.id, 1)}
                            disabled={index === source.length - 1}
                          >
                            {text.moveDown}
                          </button>
                          <button type="button" className="settings-icon-btn danger" onClick={() => removeQuickLink(item.id)}>
                            {text.remove}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
                <label className="settings-row">
                  <span>{text.openLinksMode}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.openLinksMode}>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.openLinksInsideApp ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          openLinksInsideApp: true,
                        }))
                      }
                    >
                      {text.openInside}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${!settingsDraft.openLinksInsideApp ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          openLinksInsideApp: false,
                        }))
                      }
                    >
                      {text.openOutside}
                    </button>
                  </div>
                </label>
                <section className="settings-row">
                  <span>{text.proxyTitle}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.proxyTitle}>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.proxyEnabled ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          proxyEnabled: true,
                        }))
                      }
                    >
                      {text.proxyEnabled}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${!settingsDraft.proxyEnabled ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          proxyEnabled: false,
                        }))
                      }
                    >
                      {text.proxyDisabled}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={settingsDraft.proxyUrl}
                    disabled={!settingsDraft.proxyEnabled}
                    onChange={(e) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        proxyUrl: e.target.value,
                      }))
                    }
                    placeholder="http://127.0.0.1:7890"
                  />
                  <span className="settings-row-note">{text.proxyHint}</span>
                </section>
                <label className="settings-row">
                  <span>{text.themeMode}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.themeMode}>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeMode === "system" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeMode: "system",
                        }))
                      }
                    >
                      {text.themeSystem}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeMode === "light" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeMode: "light",
                        }))
                      }
                    >
                      {text.themeLight}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeMode === "dark" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeMode: "dark",
                        }))
                      }
                    >
                      {text.themeDark}
                    </button>
                  </div>
                </label>
                <label className="settings-row">
                  <span>{text.themePalette}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.themePalette}>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themePalette === "default" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themePalette: "default",
                        }))
                      }
                    >
                      {text.paletteDefault}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themePalette === "graphite" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themePalette: "graphite",
                        }))
                      }
                    >
                      {text.paletteGraphite}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themePalette === "slate" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themePalette: "slate",
                        }))
                      }
                    >
                      {text.paletteSlate}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themePalette === "indigo" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themePalette: "indigo",
                        }))
                      }
                    >
                      {text.paletteIndigo}
                    </button>
                  </div>
                  <span className="settings-row-note">{text.themePaletteHint}</span>
                </label>
                <label className="settings-row">
                  <span>{text.themeAccent}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.themeAccent}>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeAccent === "blue" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeAccent: "blue",
                        }))
                      }
                    >
                      <span className="settings-color-label">{text.accentBlue}<span className="settings-color-dot accent-blue" /></span>
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeAccent === "green" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeAccent: "green",
                        }))
                      }
                    >
                      <span className="settings-color-label">{text.accentGreen}<span className="settings-color-dot accent-green" /></span>
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeAccent === "orange" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeAccent: "orange",
                        }))
                      }
                    >
                      <span className="settings-color-label">{text.accentOrange}<span className="settings-color-dot accent-orange" /></span>
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeAccent === "rose" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeAccent: "rose",
                        }))
                      }
                    >
                      <span className="settings-color-label">{text.accentRose}<span className="settings-color-dot accent-rose" /></span>
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.themeAccent === "violet" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          themeAccent: "violet",
                        }))
                      }
                    >
                      <span className="settings-color-label">{text.accentViolet}<span className="settings-color-dot accent-violet" /></span>
                    </button>
                  </div>
                </label>
                <label className="settings-row">
                  <span>{text.webPdfMode}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.webPdfMode}>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.webPdfOpenMode === "direct" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          webPdfOpenMode: "direct",
                        }))
                      }
                    >
                      {text.webPdfDirect}
                    </button>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.webPdfOpenMode === "download_then_open" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          webPdfOpenMode: "download_then_open",
                        }))
                      }
                    >
                      {text.webPdfDownload}
                    </button>
                  </div>
                </label>
                <label className="settings-row">
                  <span>{text.webPanelMode}</span>
                  <div className="settings-choice-group" role="group" aria-label={text.webPanelMode}>
                    <button
                      type="button"
                      className={`settings-choice-btn ${settingsDraft.webPanelMode === "iframe" ? "active" : ""}`}
                      onClick={() =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          webPanelMode: "iframe",
                        }))
                      }
                    >
                      {text.webPanelIframe}
                    </button>
                  </div>
                </label>
                <section className="settings-row">
                  <div className="settings-row-head">
                    <span>{text.dataExportTitle}</span>
                    <div className="settings-row-actions">
                      <button type="button" className="settings-mini-btn" onClick={() => void exportAppDataBundle()}>
                        <Download size={13} />
                        <span>{text.exportDataBundle}</span>
                      </button>
                      <button type="button" className="settings-mini-btn" onClick={() => void importAppDataBundle()}>
                        <Upload size={13} />
                        <span>{text.importDataBundle}</span>
                      </button>
                    </div>
                  </div>
                  <span className="settings-row-note">{text.exportDataHint}</span>
                </section>
                <div className="settings-actions">
                  <button type="button" className="ghost" onClick={resetSettingsDraft}>{text.reset}</button>
                </div>
              </div>
            </section>
          ) : mainPanel === "web" ? (
            <WebViewPanel
              tabId={activeWebTab?.id}
              url={activeWebTab?.url}
              imagePreview={activeWebImagePreview}
              defaultNewTabUrl={settings.newTabDefaultUrl}
              quickLinks={settings.quickLinks}
              language={language}
              canBackToPdf={files.length > 0}
              onBackToPdf={backToViewerFromWeb}
              onOpenLink={handleOpenLink}
              onNavigateTab={navigateWebTab}
              onOpenPdfFromWeb={handleOpenPdfFromWeb}
              pdfOpenMode={settings.webPdfOpenMode}
              webPanelMode={effectiveWebPanelMode}
            />
          ) : mainPanel === "library" ? (
            <LibraryPanel
              language={language}
              recentFiles={recentFiles}
              favorites={favorites}
              collections={libraryCollections}
              onOpenRecentFile={(path) => {
                void handleOpenRecentFile(path);
              }}
              onTogglePdfFavorite={togglePdfFavorite}
              onCreateCollection={createLibraryCollection}
              onDeleteCollection={deleteLibraryCollection}
              onRenameCollection={renameLibraryCollection}
              onToggleCollectionPath={toggleLibraryCollectionPath}
              onExportList={exportLibraryList}
            />
          ) : (
            <PDFViewer
              fileId={activeRealFileId}
              fallbackFileName={activeFile?.name ?? "No PDF Opened"}
              fallbackPages={activeFile?.meta ? Number.parseInt(activeFile.meta, 10) || 1 : 1}
              initialViewSnapshot={activeFileSnapshot}
              recentFiles={recentList}
              favorites={favorites}
              language={language}
              onLanguageChange={updateLanguage}
              onOpenFile={handleOpenFile}
              onOpenRecentFile={handleOpenRecentFile}
              onContinueRecentSession={handleContinueRecentSession}
              onRelocateRecentFile={handleRelocateRecentFile}
              onOpenLink={handleOpenLink}
              onOpenFavorite={openFavorite}
              onAddWebFavorite={(url, title) => upsertFavorite("web", title, url)}
              onAddPdfFavorite={(path, name) => upsertFavorite("pdf", name, path)}
              onPreviewExportedImage={openExportImagePreview}
              onRemoveFavorite={removeFavorite}
              onReorderFavorites={reorderFavorites}
              onViewSnapshot={(snapshot) => {
                if (!activeFile?.path) return;
                updateRecentFileSnapshot(activeFile.path, snapshot);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;

