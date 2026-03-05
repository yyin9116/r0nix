export type DefaultExportFormat = "png" | "jpg" | "svg";
export type ThemeMode = "system" | "light" | "dark";
export type ThemePalette = "default" | "graphite" | "slate" | "indigo";
export type ThemeAccent = "blue" | "green" | "orange" | "rose" | "violet";
export type WebPdfOpenMode = "direct" | "download_then_open";
export type WebPanelMode = "iframe" | "native_webview";

export interface QuickLinkItem {
  id: string;
  title: string;
  url: string;
}

export function createDefaultQuickLinks(): QuickLinkItem[] {
  return [
    { id: "ql-lime", title: "Lime Start", url: "https://limestart.cn" },
    { id: "ql-google", title: "Google", url: "https://www.google.com" },
    { id: "ql-github", title: "GitHub", url: "https://github.com" },
    { id: "ql-wiki", title: "Wikipedia", url: "https://www.wikipedia.org" },
  ];
}

export interface UserSettings {
  defaultExportFormat: DefaultExportFormat;
  defaultSaveDir: string;
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
}

export const USER_SETTINGS_KEY = "pdf_reader_user_settings_v2";
export const USER_SETTINGS_EVENT = "pdf-reader-settings-updated";

const DEFAULT_SETTINGS: UserSettings = {
  defaultExportFormat: "svg",
  defaultSaveDir: "",
  openLinksInsideApp: true,
  proxyEnabled: false,
  proxyUrl: "",
  themeMode: "system",
  themePalette: "default",
  themeAccent: "blue",
  webPdfOpenMode: "direct",
  webPanelMode: "iframe",
  newTabDefaultUrl: "",
  quickLinks: createDefaultQuickLinks(),
};

export function sanitizeUserSettings(raw: unknown): UserSettings {
  const parsed = raw && typeof raw === "object" ? (raw as Partial<UserSettings>) : {};
  const fmt = parsed.defaultExportFormat;
  const defaultExportFormat: DefaultExportFormat =
    fmt === "png" || fmt === "jpg" || fmt === "svg" ? fmt : DEFAULT_SETTINGS.defaultExportFormat;
  const defaultSaveDir = typeof parsed.defaultSaveDir === "string" ? parsed.defaultSaveDir : "";
  const openLinksInsideApp =
    typeof parsed.openLinksInsideApp === "boolean"
      ? parsed.openLinksInsideApp
      : DEFAULT_SETTINGS.openLinksInsideApp;
  const proxyEnabled =
    typeof parsed.proxyEnabled === "boolean" ? parsed.proxyEnabled : DEFAULT_SETTINGS.proxyEnabled;
  const proxyUrl = typeof parsed.proxyUrl === "string" ? parsed.proxyUrl : DEFAULT_SETTINGS.proxyUrl;
  const themeMode: ThemeMode =
    parsed.themeMode === "light" || parsed.themeMode === "dark" || parsed.themeMode === "system"
      ? parsed.themeMode
      : DEFAULT_SETTINGS.themeMode;
  const themePalette: ThemePalette =
    parsed.themePalette === "default" ||
    parsed.themePalette === "slate" ||
    parsed.themePalette === "indigo" ||
    parsed.themePalette === "graphite"
      ? parsed.themePalette
      : DEFAULT_SETTINGS.themePalette;
  const themeAccent: ThemeAccent =
    parsed.themeAccent === "green" ||
    parsed.themeAccent === "orange" ||
    parsed.themeAccent === "rose" ||
    parsed.themeAccent === "violet" ||
    parsed.themeAccent === "blue"
      ? parsed.themeAccent
      : DEFAULT_SETTINGS.themeAccent;
  const webPdfOpenMode: WebPdfOpenMode =
    parsed.webPdfOpenMode === "download_then_open" || parsed.webPdfOpenMode === "direct"
      ? parsed.webPdfOpenMode
      : DEFAULT_SETTINGS.webPdfOpenMode;
  const webPanelMode: WebPanelMode =
    parsed.webPanelMode === "iframe"
      ? "iframe"
      : DEFAULT_SETTINGS.webPanelMode;
  const newTabDefaultUrl =
    typeof parsed.newTabDefaultUrl === "string" ? parsed.newTabDefaultUrl : DEFAULT_SETTINGS.newTabDefaultUrl;
  const parsedQuickLinks = Array.isArray(parsed.quickLinks) ? parsed.quickLinks : [];
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
  };
}

export function loadUserSettings(): UserSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(USER_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return sanitizeUserSettings(JSON.parse(raw));
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
