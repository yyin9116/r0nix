import {
  Moon,
  Sun,
  Monitor,
  Palette,
  BookOpen,
  Download,
  FileText,
  Globe,
  Network,
  FolderOpen,
  Link2,
  Plus,
  Trash2,
  Home,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppLanguage, QuickLinkItem, UserSettings } from "../services/userSettings";
import { useEffect, useMemo, useRef, useState } from "react";

interface SettingsProps {
  settings: UserSettings;
  onThemeChange: (theme: "light" | "dark") => void;
  onSettingsChange: (next: UserSettings) => void;
  focusSection?: "quick-links" | null;
  focusToken?: number;
}

function SelectRow<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ label: string; value: T }>;
  onChange: (value: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="w-full md:w-56 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const I18N = {
  "zh-CN": {
    settings: "\u8bbe\u7f6e",
    currentLanguage: "\u7b80\u4f53\u4e2d\u6587",
    appearance: "\u5916\u89c2",
    colorTheme: "\u989c\u8272\u4e3b\u9898",
    light: "\u6d45\u8272",
    dark: "\u6df1\u8272",
    system: "\u8ddf\u968f\u7cfb\u7edf",
    accentColor: "\u5f3a\u8c03\u8272",
    accentHint: "\u9ed8\u8ba4\u4f7f\u7528 Zinc Gray\uff0c\u4ee5\u4fdd\u6301\u6807\u7b7e\u3001\u56fe\u6807\u548c\u8fdb\u5ea6\u98ce\u683c\u4e00\u81f4\u3002",
    readerAndWeb: "\u9605\u8bfb\u5668\u4e0e\u7f51\u9875",
    webPanelMode: "\u7f51\u9875\u9762\u677f\u6a21\u5f0f",
    webPanelModeDesc: "\u539f\u751f WebView \u5728\u53d7\u4fdd\u62a4\u7ad9\u70b9\u4e0a\u66f4\u7a33\u5b9a\u3002",
    nativeWebview: "\u539f\u751f WebView",
    iframe: "Iframe",
    pdfOpenMode: "PDF \u6253\u5f00\u65b9\u5f0f",
    pdfOpenModeDesc: "\u9009\u62e9\u7f51\u9875 PDF \u662f\u76f4\u63a5\u6253\u5f00\u8fd8\u662f\u5148\u4e0b\u8f7d\u3002",
    downloadThenOpen: "\u4e0b\u8f7d\u540e\u6253\u5f00",
    direct: "\u76f4\u63a5\u6253\u5f00",
    proxy: "\u4ee3\u7406",
    proxyDesc: "\u5728\u53d7\u9650\u7f51\u7edc\u4e2d\u4e0b\u8f7d PDF \u65f6\u4f7f\u7528\u81ea\u5b9a\u4e49\u4ee3\u7406\u3002",
    enabled: "\u5df2\u542f\u7528",
    disabled: "\u5df2\u5173\u95ed",
    openLinksInsideApp: "\u5e94\u7528\u5185\u6253\u5f00\u94fe\u63a5",
    openLinksInsideAppDesc: "\u5173\u95ed\u540e\uff0c\u5feb\u6377\u94fe\u63a5\u548c\u7f51\u9875\u64cd\u4f5c\u4f1a\u5728\u7cfb\u7edf\u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\u3002",
    insideApp: "\u5e94\u7528\u5185",
    externalBrowser: "\u5916\u90e8\u6d4f\u89c8\u5668",
    language: "\u8bed\u8a00",
    languageDesc: "\u5728\u4e2d\u6587\u4e0e\u82f1\u6587\u4e4b\u95f4\u5207\u6362\u754c\u9762\u8bed\u8a00\u3002",
    newTabDefaultUrl: "\u65b0\u6807\u7b7e\u9ed8\u8ba4 URL",
    newTabDefaultUrlDesc: "\u65b0\u5efa\u7f51\u9875\u6807\u7b7e\u65f6\u4f1a\u4f7f\u7528\u8fd9\u4e2a\u5730\u5740\u3002",
    exportAndAi: "\u5bfc\u51fa\u4e0e AI",
    defaultExportFormat: "\u9ed8\u8ba4\u5bfc\u51fa\u683c\u5f0f",
    defaultExportFormatDesc: "\u7528\u4e8e PDF \u53f3\u952e\u5bfc\u51fa\u64cd\u4f5c\u3002",
    defaultSaveDirectory: "\u9ed8\u8ba4\u4fdd\u5b58\u76ee\u5f55",
    defaultSaveDirectoryDesc: "\u5bfc\u51fa\u65f6\u9884\u586b\u4f60\u7684\u4f18\u9009\u8f93\u51fa\u76ee\u5f55\u3002",
    localAiModelPath: "\u672c\u5730 AI \u6a21\u578b\u8def\u5f84",
    localAiModelPathDesc: "\u4f9b\u672a\u6765\u5e03\u5c40\u5206\u6790\u7b49\u672c\u5730 AI \u80fd\u529b\u4f7f\u7528\u3002",
    browse: "\u6d4f\u89c8",
    selectExportDirectory: "\u9009\u62e9\u9ed8\u8ba4\u5bfc\u51fa\u76ee\u5f55",
    selectAiModelsDirectory: "\u9009\u62e9 AI \u6a21\u578b\u76ee\u5f55",
    chooseExportDirectory: "\u9009\u62e9\u5bfc\u51fa\u76ee\u5f55",
    selectLocalModelFolder: "\u9009\u62e9\u672c\u5730\u6a21\u578b\u76ee\u5f55",
    quickLinks: "\u5feb\u6377\u94fe\u63a5",
    quickLinksDesc: "\u5feb\u6377\u94fe\u63a5\u53ef\u4ee5\u7f16\u8f91\uff0c\u4fdd\u5b58\u540e\u4fa7\u8fb9\u680f\u4f1a\u7acb\u5373\u66f4\u65b0\u3002",
    title: "\u6807\u9898",
    url: "URL",
    add: "\u6dfb\u52a0",
    removeQuickLink: "\u79fb\u9664\u5feb\u6377\u94fe\u63a5",
    quickLinkTitlePlaceholder: "Nature",
    quickLinkUrlPlaceholder: "https://www.nature.com",
    zhLabel: "\u7b80\u4f53\u4e2d\u6587",
    enLabel: "English",
  },
  "en-US": {
    settings: "Settings",
    currentLanguage: "English",
    appearance: "Appearance",
    colorTheme: "Color Theme",
    light: "Light",
    dark: "Dark",
    system: "System",
    accentColor: "Accent Color",
    accentHint: "The default redesign uses Zinc Gray so tabs, icons and progress accents stay in the same restrained palette.",
    readerAndWeb: "Reader & Web",
    webPanelMode: "Web panel mode",
    webPanelModeDesc: "Native webview avoids iframe restriction issues on protected sites.",
    nativeWebview: "Native webview",
    iframe: "Iframe",
    pdfOpenMode: "PDF open behavior",
    pdfOpenModeDesc: "Choose whether web PDF links should open directly or always download first.",
    downloadThenOpen: "Download then open",
    direct: "Direct",
    proxy: "Proxy",
    proxyDesc: "Use custom proxy when downloading PDFs from restricted networks.",
    enabled: "Enabled",
    disabled: "Disabled",
    openLinksInsideApp: "Open links inside app",
    openLinksInsideAppDesc: "If disabled, quick links and browser actions open in the system browser.",
    insideApp: "Inside App",
    externalBrowser: "External Browser",
    language: "Language",
    languageDesc: "Switch UI language between Chinese and English.",
    newTabDefaultUrl: "New tab default URL",
    newTabDefaultUrlDesc: "This address is used when creating a new browser tab.",
    exportAndAi: "Export & AI",
    defaultExportFormat: "Default export format",
    defaultExportFormatDesc: "Used by the PDF right-click export action.",
    defaultSaveDirectory: "Default save directory",
    defaultSaveDirectoryDesc: "Prefill exported file paths with your preferred output location.",
    localAiModelPath: "Local AI model path",
    localAiModelPathDesc: "Directory for future layout/formula models used by local AI capabilities.",
    browse: "Browse",
    selectExportDirectory: "Select Default Export Directory",
    selectAiModelsDirectory: "Select AI Models Directory",
    chooseExportDirectory: "Choose an export directory",
    selectLocalModelFolder: "Select a local model folder",
    quickLinks: "Quick Links",
    quickLinksDesc: "Quick Links are editable, not fixed. Add or remove them here and the sidebar updates immediately.",
    title: "Title",
    url: "URL",
    add: "Add",
    removeQuickLink: "Remove quick link",
    quickLinkTitlePlaceholder: "Nature",
    quickLinkUrlPlaceholder: "https://www.nature.com",
    zhLabel: "Chinese (Simplified)",
    enLabel: "English",
  },
} as const;

export function Settings({ settings, onThemeChange, onSettingsChange, focusSection = null, focusToken = 0 }: SettingsProps) {
  const [draftQuickLink, setDraftQuickLink] = useState({ title: "", url: "" });
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const quickLinksSectionRef = useRef<HTMLElement | null>(null);

  const t = I18N[settings.language];

  const updateSettings = (patch: Partial<UserSettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  const languageOptions = useMemo(
    () => [
      { value: "zh-CN" as AppLanguage, label: t.zhLabel },
      { value: "en-US" as AppLanguage, label: t.enLabel },
    ],
    [t.enLabel, t.zhLabel]
  );

  const accentOptions = useMemo(
    () => [
      { value: "zinc", label: "Zinc Gray" },
      { value: "blue", label: "Blue" },
      { value: "green", label: "Green" },
      { value: "orange", label: "Orange" },
      { value: "rose", label: "Rose" },
      { value: "violet", label: "Violet" },
    ] as const,
    []
  );

  const handlePickDirectory = async (field: "defaultSaveDir" | "aiModelPath") => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: field === "aiModelPath" ? t.selectAiModelsDirectory : t.selectExportDirectory,
    });
    if (typeof selected !== "string" || !selected.trim()) return;
    updateSettings({ [field]: selected } as Partial<UserSettings>);
  };

  const addQuickLink = () => {
    const title = draftQuickLink.title.trim();
    const url = draftQuickLink.url.trim();
    if (!title || !url) {
      titleInputRef.current?.focus();
      return;
    }
    const id = `ql-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nextItem: QuickLinkItem = { id, title, url };
    updateSettings({ quickLinks: [...settings.quickLinks, nextItem] });
    setDraftQuickLink({ title: "", url: "" });
  };

  useEffect(() => {
    if (focusSection !== "quick-links") return;
    quickLinksSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 220);
  }, [focusSection, focusToken]);

  const removeQuickLink = (id: string) => {
    updateSettings({ quickLinks: settings.quickLinks.filter((item) => item.id !== id) });
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 font-sans overflow-y-auto">
      <div className="flex items-center justify-between px-8 py-6 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <h1 className="text-2xl font-serif font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t.settings} | {t.currentLanguage}</h1>
      </div>

      <div className="max-w-5xl mx-auto w-full p-8 space-y-12">
        <section>
          <div className="flex items-center gap-2 mb-6">
            <Palette className="text-zinc-400 dark:text-zinc-500" size={20} />
            <h2 className="text-lg font-serif font-semibold text-zinc-900 dark:text-zinc-100">{t.appearance}</h2>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 xl:col-span-2">
              <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-4">{t.colorTheme}</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <ThemeCard
                  icon={<Sun size={22} />}
                  label={t.light}
                  active={settings.themeMode === "light"}
                  onClick={() => {
                    onThemeChange("light");
                    updateSettings({ themeMode: "light" });
                  }}
                />
                <ThemeCard
                  icon={<Moon size={22} />}
                  label={t.dark}
                  active={settings.themeMode === "dark"}
                  onClick={() => {
                    onThemeChange("dark");
                    updateSettings({ themeMode: "dark" });
                  }}
                />
                <ThemeCard
                  icon={<Monitor size={22} />}
                  label={t.system}
                  active={settings.themeMode === "system"}
                  onClick={() => updateSettings({ themeMode: "system" })}
                />
              </div>
            </div>

            <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-5">
              <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-4">{t.accentColor}</h3>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                {accentOptions.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => updateSettings({ themeAccent: item.value })}
                    className={`h-10 rounded-full transition-all ${settings.themeAccent === item.value ? "ring-2 ring-offset-2 ring-zinc-400 dark:ring-offset-zinc-950" : "opacity-60 hover:opacity-100"}`}
                    style={{
                      backgroundColor:
                        item.value === "zinc"
                          ? "#52525b"
                          : item.value === "blue"
                            ? "#2563eb"
                            : item.value === "green"
                              ? "#059669"
                              : item.value === "orange"
                                ? "#ea580c"
                                : item.value === "rose"
                                  ? "#e11d48"
                                  : "#7c3aed",
                    }}
                    title={item.label}
                  />
                ))}
              </div>
              <p className="text-xs text-zinc-500 mt-4">{t.accentHint}</p>
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-6">
            <BookOpen className="text-zinc-400 dark:text-zinc-500" size={20} />
            <h2 className="text-lg font-serif font-semibold text-zinc-900 dark:text-zinc-100">{t.readerAndWeb}</h2>
          </div>

          <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl divide-y divide-zinc-200 dark:divide-zinc-800">
            <SettingsRow icon={<Globe size={15} />} title={t.webPanelMode} description={t.webPanelModeDesc}>
              <SelectRow
                value={settings.webPanelMode}
                options={[
                  { value: "native_webview", label: t.nativeWebview },
                  { value: "iframe", label: t.iframe },
                ]}
                onChange={(value) => updateSettings({ webPanelMode: value })}
              />
            </SettingsRow>

            <SettingsRow icon={<FileText size={15} />} title={t.pdfOpenMode} description={t.pdfOpenModeDesc}>
              <SelectRow
                value={settings.webPdfOpenMode}
                options={[
                  { value: "download_then_open", label: t.downloadThenOpen },
                  { value: "direct", label: t.direct },
                ]}
                onChange={(value) => updateSettings({ webPdfOpenMode: value })}
              />
            </SettingsRow>

            <SettingsRow icon={<Network size={15} />} title={t.proxy} description={t.proxyDesc}>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button
                  className={`px-3 py-1.5 rounded-md text-xs font-medium ${settings.proxyEnabled ? "" : "bg-zinc-200 dark:bg-zinc-800"}`}
                  style={settings.proxyEnabled ? { backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" } : undefined}
                  onClick={() => updateSettings({ proxyEnabled: !settings.proxyEnabled })}
                >
                  {settings.proxyEnabled ? t.enabled : t.disabled}
                </button>
                <input
                  type="text"
                  value={settings.proxyUrl}
                  onChange={(event) => updateSettings({ proxyUrl: event.target.value })}
                  className="w-72 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm"
                  placeholder="http://127.0.0.1:7890"
                  disabled={!settings.proxyEnabled}
                />
              </div>
            </SettingsRow>

            <SettingsRow icon={<Link2 size={15} />} title={t.openLinksInsideApp} description={t.openLinksInsideAppDesc}>
              <button
                className={`px-3 py-1.5 rounded-md text-xs font-medium ${settings.openLinksInsideApp ? "" : "bg-zinc-200 dark:bg-zinc-800"}`}
                style={settings.openLinksInsideApp ? { backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" } : undefined}
                onClick={() => updateSettings({ openLinksInsideApp: !settings.openLinksInsideApp })}
              >
                {settings.openLinksInsideApp ? t.insideApp : t.externalBrowser}
              </button>
            </SettingsRow>

            <SettingsRow icon={<Globe size={15} />} title={t.language} description={t.languageDesc}>
              <SelectRow
                value={settings.language}
                options={languageOptions}
                onChange={(value) => updateSettings({ language: value })}
              />
            </SettingsRow>

            <SettingsRow icon={<Home size={15} />} title={t.newTabDefaultUrl} description={t.newTabDefaultUrlDesc}>
              <input
                type="text"
                value={settings.newTabDefaultUrl}
                onChange={(event) => updateSettings({ newTabDefaultUrl: event.target.value })}
                className="w-72 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm"
                placeholder="https://arxiv.org"
              />
            </SettingsRow>
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-6">
            <Download className="text-zinc-400 dark:text-zinc-500" size={20} />
            <h2 className="text-lg font-serif font-semibold text-zinc-900 dark:text-zinc-100">{t.exportAndAi}</h2>
          </div>

          <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl divide-y divide-zinc-200 dark:divide-zinc-800">
            <SettingsRow icon={<Download size={15} />} title={t.defaultExportFormat} description={t.defaultExportFormatDesc}>
              <SelectRow
                value={settings.defaultExportFormat}
                options={[
                  { value: "png", label: "PNG" },
                  { value: "jpg", label: "JPG" },
                ]}
                onChange={(value) => updateSettings({ defaultExportFormat: value })}
              />
            </SettingsRow>

            <SettingsRow icon={<FolderOpen size={15} />} title={t.defaultSaveDirectory} description={t.defaultSaveDirectoryDesc}>
              <div className="flex gap-2 flex-wrap justify-end">
                <input
                  type="text"
                  value={settings.defaultSaveDir}
                  onChange={(event) => updateSettings({ defaultSaveDir: event.target.value })}
                  className="w-72 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm"
                  placeholder={t.chooseExportDirectory}
                />
                <button
                  className="px-3 py-2 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded-md text-sm font-medium transition-colors"
                  onClick={() => void handlePickDirectory("defaultSaveDir")}
                >
                  {t.browse}
                </button>
              </div>
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.localAiModelPath} description={t.localAiModelPathDesc}>
              <div className="flex gap-2 flex-wrap justify-end">
                <input
                  type="text"
                  value={settings.aiModelPath}
                  onChange={(event) => updateSettings({ aiModelPath: event.target.value })}
                  className="w-72 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm font-mono"
                  placeholder={t.selectLocalModelFolder}
                />
                <button
                  className="px-3 py-2 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded-md text-sm font-medium transition-colors"
                  onClick={() => void handlePickDirectory("aiModelPath")}
                >
                  {t.browse}
                </button>
              </div>
            </SettingsRow>
          </div>
        </section>

        <section id="settings-quick-links" ref={quickLinksSectionRef}>
          <div className="flex items-center gap-2 mb-6">
            <Link2 className="text-zinc-400 dark:text-zinc-500" size={20} />
            <h2 className="text-lg font-serif font-semibold text-zinc-900 dark:text-zinc-100">{t.quickLinks}</h2>
          </div>

          <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 space-y-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t.quickLinksDesc}</p>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1.4fr_auto] gap-3 items-end">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{t.title}</label>
                <input
                  ref={titleInputRef}
                  type="text"
                  value={draftQuickLink.title}
                  onChange={(event) => setDraftQuickLink((prev) => ({ ...prev, title: event.target.value }))}
                  className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm"
                  placeholder={t.quickLinkTitlePlaceholder}
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{t.url}</label>
                <input
                  type="text"
                  value={draftQuickLink.url}
                  onChange={(event) => setDraftQuickLink((prev) => ({ ...prev, url: event.target.value }))}
                  className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm"
                  placeholder={t.quickLinkUrlPlaceholder}
                />
              </div>
              <button
                onClick={addQuickLink}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium"
                style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
              >
                <Plus size={14} />
                {t.add}
              </button>
            </div>

            <div className="space-y-2">
              {settings.quickLinks.map((item) => (
                <div key={item.id} className="flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{item.title}</div>
                    <div className="text-xs text-zinc-500 truncate">{item.url}</div>
                  </div>
                  <button
                    className="p-2 rounded-md text-zinc-400 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    onClick={() => removeQuickLink(item.id)}
                    title={t.removeQuickLink}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ThemeCard({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center gap-3 p-4 rounded-lg border-2 transition-all ${
        active
          ? "border-zinc-900 dark:border-zinc-100 bg-white dark:bg-zinc-900"
          : "border-transparent bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
      }`}
    >
      {icon}
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}

function SettingsRow({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between p-5 gap-6 flex-wrap">
      <div>
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">{icon}{title}</h3>
        <p className="text-xs text-zinc-500 mt-1">{description}</p>
      </div>
      {children}
    </div>
  );
}
