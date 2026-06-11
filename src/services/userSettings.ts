import { START_PAGE_URL } from "../constants/startPage";

export type DefaultExportFormat = "png" | "jpg" | "svg";
export type ThemeMode = "system" | "light" | "dark";
export type ThemePalette = "default" | "graphite" | "slate" | "indigo";
export type ThemeAccent = "zinc" | "blue" | "green" | "orange" | "rose" | "violet";
export type WebPdfOpenMode = "direct" | "download_then_open";
export type WebPanelMode = "iframe" | "native_webview";
export type AppLanguage = "zh-CN" | "en-US";

export interface QuickLinkItem {
  id: string;
  title: string;
  url: string;
}

export function createDefaultQuickLinks(): QuickLinkItem[] {
  return [
    { id: "ql-arxiv", title: "arXiv", url: "https://arxiv.org" },
    { id: "ql-scholar", title: "Google Scholar", url: "https://scholar.google.com" },
    { id: "ql-semantic", title: "Semantic Scholar", url: "https://www.semanticscholar.org" },
    { id: "ql-pubmed", title: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov" },
  ];
}

export interface UserSettings {
  defaultExportFormat: DefaultExportFormat;
  defaultSaveDir: string;
  aiModelPath: string;
  openLinksInsideApp: boolean;
  proxyEnabled: boolean;
  proxyUrl: string;
  themeMode: ThemeMode;
  themePalette: ThemePalette;
  themeAccent: ThemeAccent;
  webPdfOpenMode: WebPdfOpenMode;
  webPanelMode: WebPanelMode;
  newTabDefaultUrl: string;
  quickLinks: QuickLinkItem[];
  language: AppLanguage;
}

export const USER_SETTINGS_KEY = "pdf_reader_user_settings_v2";
export const USER_SETTINGS_EVENT = "pdf-reader-settings-updated";

const DEFAULT_SETTINGS: UserSettings = {
  defaultExportFormat: "png",
  defaultSaveDir: "",
  aiModelPath: "",
  openLinksInsideApp: true,
  proxyEnabled: false,
  proxyUrl: "",
  themeMode: "system",
  themePalette: "graphite",
  themeAccent: "zinc",
  webPdfOpenMode: "download_then_open",
  webPanelMode: "native_webview",
  newTabDefaultUrl: START_PAGE_URL,
  quickLinks: createDefaultQuickLinks(),
  language: "zh-CN",
};

export function sanitizeUserSettings(raw: unknown): UserSettings {
  const parsed = raw && typeof raw === "object" ? (raw as Partial<UserSettings>) : {};
  const fmt = parsed.defaultExportFormat;
  const defaultExportFormat: DefaultExportFormat =
    fmt === "png" || fmt === "jpg" || fmt === "svg" ? fmt : DEFAULT_SETTINGS.defaultExportFormat;
  const defaultSaveDir = typeof parsed.defaultSaveDir === "string" ? parsed.defaultSaveDir : "";
  const aiModelPath = typeof parsed.aiModelPath === "string" ? parsed.aiModelPath : "";
  const openLinksInsideApp =
    typeof parsed.openLinksInsideApp === "boolean"
      ? parsed.openLinksInsideApp
      : DEFAULT_SETTINGS.openLinksInsideApp;
  const proxyEnabled =
    typeof parsed.proxyEnabled === "boolean" ? parsed.proxyEnabled : DEFAULT_SETTINGS.proxyEnabled;
  const proxyUrl = typeof parsed.proxyUrl === "string" ? parsed.proxyUrl : DEFAULT_SETTINGS.proxyUrl;
  const legacyAccentMigration = parsed.themeAccent === "blue" && (parsed.themePalette === undefined || parsed.themePalette === "default");
  const themeMode: ThemeMode =
    parsed.themeMode === "light" || parsed.themeMode === "dark" || parsed.themeMode === "system"
      ? parsed.themeMode
      : DEFAULT_SETTINGS.themeMode;
  const themePalette: ThemePalette =
    parsed.themePalette === "default" ||
    parsed.themePalette === "slate" ||
    parsed.themePalette === "indigo" ||
    parsed.themePalette === "graphite"
      ? legacyAccentMigration && parsed.themePalette === "default"
        ? "graphite"
        : parsed.themePalette
      : DEFAULT_SETTINGS.themePalette;
  const themeAccent: ThemeAccent =
    parsed.themeAccent === "zinc" ||
    parsed.themeAccent === "green" ||
    parsed.themeAccent === "orange" ||
    parsed.themeAccent === "rose" ||
    parsed.themeAccent === "violet" ||
    parsed.themeAccent === "blue"
      ? legacyAccentMigration
        ? "zinc"
        : parsed.themeAccent
      : DEFAULT_SETTINGS.themeAccent;
  const webPdfOpenMode: WebPdfOpenMode =
    parsed.webPdfOpenMode === "download_then_open" || parsed.webPdfOpenMode === "direct"
      ? parsed.webPdfOpenMode
      : DEFAULT_SETTINGS.webPdfOpenMode;
  const webPanelMode: WebPanelMode =
    parsed.webPanelMode === "native_webview" || parsed.webPanelMode === "iframe"
      ? parsed.webPanelMode
      : DEFAULT_SETTINGS.webPanelMode;
  const newTabDefaultUrl =
    typeof parsed.newTabDefaultUrl === "string" ? parsed.newTabDefaultUrl : DEFAULT_SETTINGS.newTabDefaultUrl;
  const parsedQuickLinks = Array.isArray(parsed.quickLinks) ? parsed.quickLinks : [];
  const language: AppLanguage = parsed.language === "en-US" || parsed.language === "zh-CN" ? parsed.language : DEFAULT_SETTINGS.language;
  const quickLinks = parsedQuickLinks
    .filter(
      (item): item is QuickLinkItem =>
        Boolean(item) &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        typeof item.url === "string"
    )
    .slice(0, 24);

  return {
    defaultExportFormat,
    defaultSaveDir,
    aiModelPath,
    openLinksInsideApp,
    proxyEnabled,
    proxyUrl,
    themeMode,
    themePalette,
    themeAccent,
    webPdfOpenMode,
    webPanelMode,
    newTabDefaultUrl,
    quickLinks: quickLinks.length > 0 ? quickLinks : DEFAULT_SETTINGS.quickLinks,
    language,
  };
}

export function loadUserSettings(): UserSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(USER_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    const settings = sanitizeUserSettings(parsed);
    if (parsed.webPanelMode === "iframe") {
      settings.webPanelMode = "native_webview";
      saveUserSettings(settings);
    }
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveUserSettings(next: UserSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(USER_SETTINGS_EVENT, { detail: next }));
}

export function withDefaultDir(fileName: string, dir: string): string {
  const cleanDir = dir.trim();
  if (!cleanDir) return fileName;
  const sep = cleanDir.includes("\\") ? "\\" : "/";
  const normalized = cleanDir.endsWith("/") || cleanDir.endsWith("\\") ? cleanDir.slice(0, -1) : cleanDir;
  return `${normalized}${sep}${fileName}`;
}
