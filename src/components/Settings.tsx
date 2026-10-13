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
  PlugZap,
  Sparkles,
  MessageSquare,
  Underline as UnderlineIcon,
  HardDrive,
  KeyRound,
} from"lucide-react";
import { open } from"@tauri-apps/plugin-dialog";
import type { AppLanguage, QuickLinkItem, UserSettings } from"../services/userSettings";
import { COMPANION_INTENSITIES } from"../services/readingCompanion";
import { useCallback, useEffect, useMemo, useRef, useState } from"react";
import { testLlmServiceConnection } from"../services/readingAssistant";
import { ACCENT_TOKENS } from"../theme/accent";
import {
  changeWorkspaceRoot,
  clearWorkspaceCache,
  fetchWorkspaceInfo,
  migrateKeychainSecret,
  revealWorkspace,
  type WorkspaceInfo,
} from"../services/workspace";
import { Button, Card, IconButton, Select, Textarea, TextInput } from"../ui";

interface SettingsProps {
  settings: UserSettings;
  onThemeChange: (theme:"light" |"dark") => void;
  onSettingsChange: (next: UserSettings) => void;
  focusSection?:"quick-links" | null;
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
    <Select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="w-full md:w-56"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

function StaticValueRow({ label }: { label: string }) {
  return (
    <div
      className="inline-flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-panel px-3.5 text-sm font-medium text-content-primary shadow-[var(--elev-sm)] md:w-56"
      aria-readonly="true"
    >
      <span className="truncate">{label}</span>
      <span className="h-2 w-2 rounded-full bg-state-ok-tint shadow-[0_0_0_3px_color-mix(in_srgb,var(--state-ok-fg)_16%,transparent)]" />
    </div>
  );
}

const I18N = {
"zh-CN": {
    settings:"\u8bbe\u7f6e",
    currentLanguage:"\u7b80\u4f53\u4e2d\u6587",
    appearance:"\u5916\u89c2",
    colorTheme:"\u989c\u8272\u4e3b\u9898",
    light:"\u6d45\u8272",
    dark:"\u6df1\u8272",
    system:"\u8ddf\u968f\u7cfb\u7edf",
    accentColor:"\u5f3a\u8c03\u8272",
    accentHint:
"\u9ed8\u8ba4\u4f7f\u7528 Zinc Gray\uff0c\u4ee5\u4fdd\u6301\u6807\u7b7e\u3001\u56fe\u6807\u548c\u8fdb\u5ea6\u98ce\u683c\u4e00\u81f4\u3002",
    readerAndWeb:"\u9605\u8bfb\u5668\u4e0e\u7f51\u9875",
    webPanelMode:"\u7f51\u9875\u9762\u677f\u6a21\u5f0f",
    webPanelModeDesc:"桌面端固定使用嵌入式原生 WebView，避免网站拒绝 iframe。",
    nativeWebview:"\u539f\u751f WebView",
    iframe:"Iframe",
    pdfOpenMode:"PDF \u6253\u5f00\u65b9\u5f0f",
    pdfOpenModeDesc:"\u9009\u62e9\u7f51\u9875 PDF \u662f\u76f4\u63a5\u6253\u5f00\u8fd8\u662f\u5148\u4e0b\u8f7d\u3002",
    downloadThenOpen:"\u4e0b\u8f7d\u540e\u6253\u5f00",
    direct:"\u76f4\u63a5\u6253\u5f00",
    proxy:"\u4ee3\u7406",
    proxyDesc:
"\u5728\u53d7\u9650\u7f51\u7edc\u4e2d\u4e0b\u8f7d PDF \u65f6\u4f7f\u7528\u81ea\u5b9a\u4e49\u4ee3\u7406\u3002",
    enabled:"\u5df2\u542f\u7528",
    disabled:"\u5df2\u5173\u95ed",
    openLinksInsideApp:"\u5e94\u7528\u5185\u6253\u5f00\u94fe\u63a5",
    openLinksInsideAppDesc:
"\u5173\u95ed\u540e\uff0c\u5feb\u6377\u94fe\u63a5\u548c\u7f51\u9875\u64cd\u4f5c\u4f1a\u5728\u7cfb\u7edf\u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\u3002",
    insideApp:"\u5e94\u7528\u5185",
    externalBrowser:"\u5916\u90e8\u6d4f\u89c8\u5668",
    companion:"\u4f34\u8bfb",
    companionDesc:
"\u505c\u7559\u7ea6 2.5 \u79d2\u540e\u81ea\u52a8\u5c55\u5f00\u9605\u8bfb\u8f85\u52a9\u3002\u884c\u4e3a\u4fe1\u53f7\u4e0d\u4f1a\u79bb\u5f00\u672c\u673a\u3002",
    companionIntensity:"\u4e3b\u52a8\u63d0\u793a\u5bc6\u5ea6",
    companionIntensityDesc:
"\u63a7\u5236\u81ea\u52a8\u5f39\u6c14\u6ce1\u7684\u9891\u7387\uff1a\u5173 = \u4e0d\u91c7\u96c6\u505c\u7559\uff1b\u8f7b = \u53ea\u6311\u6838\u5fc3\u7ed3\u8bba\uff1b\u4e2d = \u7ed3\u8bba\u4e0e\u8bba\u70b9\uff1b\u91cd = \u518d\u52a0\u7591\u96be\u53e5\u4e0e\u94fa\u57ab\u3002",
    companionAutoAnnotate:"\u81ea\u52a8\u5212\u7ebf\u6807\u8bb0",
    companionAutoAnnotateDesc:
"\u6a21\u578b\u5224\u5b9a\u67d0\u6bb5\u96be\u61c2\u65f6\uff0c\u5728\u8be5\u6bb5\u7559\u4e00\u6761\u6ce2\u6d6a\u7ebf\u3002\u5b83\u662f\u9759\u6001\u7684\u3001\u53ef\u9884\u671f\u7684\uff0c\u4e0d\u4f1a\u5f39\u7a97\u6253\u6270\u4f60\u3002",
    companionAnnotateIntensity:"\u6807\u8bb0\u5bc6\u5ea6",
    companionAnnotateIntensityDesc:
"\u63a7\u5236\u6bcf\u9875\u6700\u591a\u7559\u51e0\u6761\u6807\u8bb0\uff1a\u5173 = \u4e00\u6761\u4e0d\u7559\uff08\u63d0\u793a\u7167\u5e38\uff09\uff1b\u8f7b = 1 \u6761\uff1b\u4e2d = 2 \u6761\uff1b\u91cd = \u4e0d\u9650\u3002\u4e0e\u4e3b\u52a8\u63d0\u793a\u7684\u5bc6\u5ea6\u76f8\u4e92\u72ec\u7acb\u3002",
    companionQuickAsk:"\u6c14\u6ce1\u5185\u5feb\u6377\u63d0\u95ee",
    companionQuickAskDesc:
"\u5173\u6389\u540e\u6c14\u6ce1\u4ecd\u7136\u4f1a\u51fa\u73b0\uff0c\u4f46\u4e0d\u518d\u63d0\u4f9b\u6982\u62ec / \u672f\u8bed / \u5ef6\u4f38\u95ee\u9898\u4e0e\u8ffd\u95ee\u8f93\u5165\u6846\u3002",
    intensityOff:"\u5173",
    intensityLight:"\u8f7b",
    intensityMedium:"\u4e2d",
    intensityHeavy:"\u91cd",
    language:"\u8bed\u8a00",
    languageDesc:"\u5728\u4e2d\u6587\u4e0e\u82f1\u6587\u4e4b\u95f4\u5207\u6362\u754c\u9762\u8bed\u8a00\u3002",
    newTabDefaultUrl:"\u65b0\u6807\u7b7e\u9ed8\u8ba4 URL",
    newTabDefaultUrlDesc:"\u65b0\u5efa\u7f51\u9875\u6807\u7b7e\u65f6\u4f1a\u4f7f\u7528\u8fd9\u4e2a\u5730\u5740\u3002",
    exportAndAi:"\u5bfc\u51fa\u4e0e AI",
    defaultSaveDirectory:"\u9ed8\u8ba4\u4fdd\u5b58\u76ee\u5f55",
    defaultSaveDirectoryDesc:"\u5bfc\u51fa\u65f6\u9884\u586b\u4f60\u7684\u4f18\u9009\u8f93\u51fa\u76ee\u5f55\u3002",
    localAiModelPath:"阅读辅助模型服务",
    localAiModelPathDesc:
"填写 LiteLLM 或 OpenAI-compatible Base URL。提问和翻译会发送选中段落、引用位置和问题到该服务。",
    aiModelName:"模型名称",
    aiModelNameDesc:"例如 gpt-4o-mini、claude-3-5-sonnet、ollama/qwen2.5 或 LiteLLM 中配置的模型别名。",
    aiApiKey:"API Key",
    aiApiKeyDesc:"保存在本地存储目录的 secrets.json 中（仅当前账户可读，不进浏览器存储、不再每次启动要求输密码）。",
    localStorage:"本地存储",
    localStorageDesc:
"所有数据 —— 设置、API Key、导入的 PDF、伴读历史 —— 都在这一个目录里。可以整个复制到别处备份，或在访达中直接查看。",
    workspaceLocation:"存储位置",
    workspaceUsage:"已用空间",
    workspaceCustom:"自定义位置",
    workspaceDefault:"默认位置",
    revealWorkspace:"在访达中显示",
    changeWorkspace:"更换位置",
    changeWorkspaceHint:"选择一个新的空文件夹；现有文件会先复制过去再切换，中途失败不会丢数据。",
    clearCache:"清理缓存",
    clearCacheHint:"只删派生缓存（缩略图、渲染中间产物）。文档、设置、密钥和伴读历史都不受影响。",
    workspaceFiles:"个文件",
    workspaceTruncated:"（扫描触顶，实际更多）",
    workspaceUnavailable:"当前环境无法访问本地存储目录。",
    importKeychain:"从钥匙串导入",
    importKeychainHint:
"如果旧版本把 API Key 存进了 macOS 钥匙串，可以搬一次过来。搬完钥匙串里的旧条目会被删除，之后不会再要求你输密码。",
    keychainImported:"已从钥匙串导入密钥。",
    keychainNotFound:"钥匙串里没有可导入的密钥。",
    localStorageActionFailed:"操作失败",
    aiTemperature:"温度",
    aiTemperatureDesc:"翻译建议 0.0-0.3，问答可适当提高。",
    askPrompt:"提问系统提示词",
    askPromptDesc:"约束 Ask AI 的角色、边界和回答风格。",
    translationPrompt:"翻译系统提示词",
    translationPromptDesc:"约束全文分块翻译和单段翻译的术语、格式与输出方式。",
    translationTarget:"翻译目标语言",
    translationTargetDesc:"例如 Simplified Chinese、English、Japanese。",
    testModelConnection:"测试连接",
    testingModelConnection:"测试中...",
    modelConnectionReady:"模型连接可用",
    modelConnectionFailed:"模型连接失败",
    browse:"\u6d4f\u89c8",
    selectExportDirectory:"\u9009\u62e9\u9ed8\u8ba4\u5bfc\u51fa\u76ee\u5f55",
    directorySelectionFailed:"\u65e0\u6cd5\u9009\u62e9\u76ee\u5f55",
    chooseExportDirectory:"\u9009\u62e9\u5bfc\u51fa\u76ee\u5f55",
    selectLocalModelFolder:"http://127.0.0.1:4000/v1",
    quickLinks:"\u5feb\u6377\u94fe\u63a5",
    quickLinksDesc:
"\u5feb\u6377\u94fe\u63a5\u53ef\u4ee5\u7f16\u8f91\uff0c\u4fdd\u5b58\u540e\u4fa7\u8fb9\u680f\u4f1a\u7acb\u5373\u66f4\u65b0\u3002",
    title:"\u6807\u9898",
    url:"URL",
    add:"\u6dfb\u52a0",
    removeQuickLink:"\u79fb\u9664\u5feb\u6377\u94fe\u63a5",
    quickLinkTitlePlaceholder:"Nature",
    quickLinkUrlPlaceholder:"https://www.nature.com",
    zhLabel:"\u7b80\u4f53\u4e2d\u6587",
    enLabel:"English",
  },
"en-US": {
    settings:"Settings",
    currentLanguage:"English",
    appearance:"Appearance",
    colorTheme:"Color Theme",
    light:"Light",
    dark:"Dark",
    system:"System",
    accentColor:"Accent Color",
    accentHint:
"The default redesign uses Zinc Gray so tabs, icons and progress accents stay in the same restrained palette.",
    readerAndWeb:"Reader & Web",
    webPanelMode:"Web panel mode",
    webPanelModeDesc:"Desktop uses the embedded native WebView to avoid iframe blocking.",
    nativeWebview:"Native webview",
    iframe:"Iframe",
    pdfOpenMode:"PDF open behavior",
    pdfOpenModeDesc:"Choose whether web PDF links should open directly or always download first.",
    downloadThenOpen:"Download then open",
    direct:"Direct",
    proxy:"Proxy",
    proxyDesc:"Use custom proxy when downloading PDFs from restricted networks.",
    enabled:"Enabled",
    disabled:"Disabled",
    openLinksInsideApp:"Open links inside app",
    openLinksInsideAppDesc:"If disabled, quick links and browser actions open in the system browser.",
    insideApp:"Inside App",
    externalBrowser:"External Browser",
    companion:"Companion",
    companionDesc:"Open reading assist automatically after dwelling on a paragraph for about 2.5s. Behaviour signals never leave this machine.",
    companionIntensity:"Prompt density",
    companionIntensityDesc:
"How often bubbles appear on their own: Off = never sample dwell time; Light = the key takeaway only; Medium = claims and the arguments behind them; Heavy = plus hard sentences and setup.",
    companionAutoAnnotate:"Automatic markers",
    companionAutoAnnotateDesc:
"Leave a wavy marker on passages the model judges hard. Markers are static and predictable — they never pop up at you.",
    companionAnnotateIntensity:"Marker density",
    companionAnnotateIntensityDesc:"Markers per page, independent of prompt density: off = none (prompts still show); light = 1; medium = 2; heavy = unlimited.",
    companionQuickAsk:"Quick questions in the bubble",
    companionQuickAskDesc:
"Turning this off keeps the prompts themselves, but drops the summarize / terms / follow-ups buttons and the question box.",
    intensityOff:"Off",
    intensityLight:"Light",
    intensityMedium:"Medium",
    intensityHeavy:"Heavy",
    language:"Language",
    languageDesc:"Switch UI language between Chinese and English.",
    newTabDefaultUrl:"New tab default URL",
    newTabDefaultUrlDesc:"This address is used when creating a new browser tab.",
    exportAndAi:"Export & AI",
    defaultSaveDirectory:"Default save directory",
    defaultSaveDirectoryDesc:"Prefill exported file paths with your preferred output location.",
    localAiModelPath:"Reading assistant model service",
    localAiModelPathDesc:
"Set a LiteLLM or OpenAI-compatible Base URL. Asking and translation send selected text, references, and questions to this service.",
    aiModelName:"Model name",
    aiModelNameDesc:"For example gpt-4o-mini, claude-3-5-sonnet, ollama/qwen2.5, or a LiteLLM model alias.",
    aiApiKey:"API Key",
    aiApiKeyDesc:"Stored in secrets.json inside the local storage folder (readable only by your account; never in browser storage, and no password prompt at launch).",
    localStorage:"Local Storage",
    localStorageDesc:
"Everything lives in one folder: settings, API key, imported PDFs, and reading history. Copy that folder to back it up, or open it in the file manager.",
    workspaceLocation:"Storage location",
    workspaceUsage:"Disk usage",
    workspaceCustom:"Custom location",
    workspaceDefault:"Default location",
    revealWorkspace:"Show in Finder",
    changeWorkspace:"Change location",
    changeWorkspaceHint:"Pick a new empty folder; existing files are copied over before the switch, so a failure never loses data.",
    clearCache:"Clear cache",
    clearCacheHint:"Removes derived caches only (thumbnails, render intermediates). Documents, settings, the key, and history are untouched.",
    workspaceFiles:"files",
    workspaceTruncated:"(scan limit reached, more exist)",
    workspaceUnavailable:"The local storage folder is not reachable in this environment.",
    importKeychain:"Import from Keychain",
    importKeychainHint:
"If an older version stored your API key in the macOS Keychain, import it once. The old keychain entry is deleted afterwards, so you will not be asked for a password again.",
    keychainImported:"API key imported from the Keychain.",
    keychainNotFound:"No key found in the Keychain to import.",
    localStorageActionFailed:"Action failed",
    aiTemperature:"Temperature",
    aiTemperatureDesc:"Use 0.0-0.3 for translation; higher values may be useful for Q&A.",
    askPrompt:"Ask system prompt",
    askPromptDesc:"Controls Ask AI's role, boundaries, and answer style.",
    translationPrompt:"Translation system prompt",
    translationPromptDesc:"Controls terminology, format, and output style for block translation.",
    translationTarget:"Translation target language",
    translationTargetDesc:"For example Simplified Chinese, English, or Japanese.",
    testModelConnection:"Test connection",
    testingModelConnection:"Testing...",
    modelConnectionReady:"Model connection ready",
    modelConnectionFailed:"Model connection failed",
    browse:"Browse",
    selectExportDirectory:"Select Default Export Directory",
    directorySelectionFailed:"Unable to select a directory",
    chooseExportDirectory:"Choose an export directory",
    selectLocalModelFolder:"http://127.0.0.1:4000/v1",
    quickLinks:"Quick Links",
    quickLinksDesc:"Quick Links are editable, not fixed. Add or remove them here and the sidebar updates immediately.",
    title:"Title",
    url:"URL",
    add:"Add",
    removeQuickLink:"Remove quick link",
    quickLinkTitlePlaceholder:"Nature",
    quickLinkUrlPlaceholder:"https://www.nature.com",
    zhLabel:"Chinese (Simplified)",
    enLabel:"English",
  },
} as const;

/** 字节数的人类可读格式。刻意不引依赖：一个除法循环不值得一个包。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function Settings({
  settings,
  onThemeChange,
  onSettingsChange,
  focusSection = null,
  focusToken = 0,
}: SettingsProps) {
  const [draftQuickLink, setDraftQuickLink] = useState({ title:"", url:"" });
  const [modelTest, setModelTest] = useState<{ status:"idle" |"testing" |"success" |"error"; message: string }>({
    status:"idle",
    message:"",
  });
  const [directoryError, setDirectoryError] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const quickLinksSectionRef = useRef<HTMLElement | null>(null);
  /**
   * 本地存储面板状态。
   *
   * `workspace` 为 null 有两种含义：非 Tauri 环境，或后端不可用。
   * 前端不该为「没有工作区」写分支，所以统一降级为不显示操作按钮。
   */
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");

  const t = I18N[settings.language];

  const refreshWorkspace = useCallback(async () => {
    const info = await fetchWorkspaceInfo();
    setWorkspace(info);
  }, []);

  // 进设置页就拉一次工作区信息：用户是带着「我的东西到底存在哪」的问题来的，
  // 这个面板必须自己把答案显示出来，而不是让用户去猜。
  useEffect(() => {
    let canceled = false;
    void fetchWorkspaceInfo().then((info) => {
      if (!canceled) setWorkspace(info);
    });
    return () => {
      canceled = true;
    };
  }, []);

  const runWorkspaceAction = useCallback(
    async (action: () => Promise<string | null | undefined>) => {
      setWorkspaceBusy(true);
      setWorkspaceNotice("");
      setWorkspaceError("");
      try {
        const message = await action();
        await refreshWorkspace();
        if (message) setWorkspaceNotice(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setWorkspaceError(`${t.localStorageActionFailed}: ${detail}`);
      } finally {
        setWorkspaceBusy(false);
      }
    },
    [refreshWorkspace, t.localStorageActionFailed]
  );

  const handleRevealWorkspace = useCallback(() => {
    void runWorkspaceAction(async () => {
      await revealWorkspace();
      return undefined;
    });
  }, [runWorkspaceAction]);

  const handleChangeWorkspace = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t.changeWorkspace });
      if (typeof selected !== "string" || !selected.trim()) return;
      await runWorkspaceAction(async () => {
        const next = await changeWorkspaceRoot(selected);
        if (!next) throw new Error(t.workspaceUnavailable);
        return t.workspaceLocation;
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setWorkspaceError(`${t.localStorageActionFailed}: ${detail}`);
    }
  }, [runWorkspaceAction, t.changeWorkspace, t.localStorageActionFailed, t.workspaceLocation, t.workspaceUnavailable]);

  const handleClearCache = useCallback(() => {
    void runWorkspaceAction(async () => {
      const removed = await clearWorkspaceCache();
      return removed > 0 ? `${removed}` : undefined;
    });
  }, [runWorkspaceAction]);

  const handleImportKeychain = useCallback(() => {
    void runWorkspaceAction(async () => {
      const key = await migrateKeychainSecret();
      return key ? t.keychainImported : t.keychainNotFound;
    });
  }, [runWorkspaceAction, t.keychainImported, t.keychainNotFound]);

  // 档位清单从 readingCompanion 来，不在这里另写一份 —— 两处各写一份就是第二处真相。
  const intensityOptions = COMPANION_INTENSITIES.map((value) => ({
    value,
    label:
      value === "off"
        ? t.intensityOff
        : value === "light"
          ? t.intensityLight
          : value === "medium"
            ? t.intensityMedium
            : t.intensityHeavy,
  }));

  const updateSettings = (patch: Partial<UserSettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  const languageOptions = useMemo(
    () => [
      { value:"zh-CN" as AppLanguage, label: t.zhLabel },
      { value:"en-US" as AppLanguage, label: t.enLabel },
    ],
    [t.enLabel, t.zhLabel],
  );

  const accentOptions = useMemo(
    () =>
      [
        { value:"zinc", label:"Zinc Gray" },
        { value:"blue", label:"Blue" },
        { value:"green", label:"Green" },
        { value:"orange", label:"Orange" },
        { value:"rose", label:"Rose" },
        { value:"violet", label:"Violet" },
      ] as const,
    [],
  );

  const handlePickDirectory = async (field:"defaultSaveDir") => {
    setDirectoryError("");
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t.selectExportDirectory,
      });
      if (typeof selected !=="string" || !selected.trim()) return;
      updateSettings({ [field]: selected } as Partial<UserSettings>);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setDirectoryError(`${t.directorySelectionFailed}: ${detail}`);
    }
  };

  const addQuickLink = () => {
    const title = draftQuickLink.title.trim();
    const url = draftQuickLink.url.trim();
    if (!title || !url) {
      titleInputRef.current?.focus();
      return;
    }
    const id =`ql-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nextItem: QuickLinkItem = { id, title, url };
    updateSettings({ quickLinks: [...settings.quickLinks, nextItem] });
    setDraftQuickLink({ title:"", url:"" });
  };

  useEffect(() => {
    if (focusSection !=="quick-links") return;
    quickLinksSectionRef.current?.scrollIntoView({ behavior:"smooth", block:"start" });
    window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 220);
  }, [focusSection, focusToken]);

  const removeQuickLink = (id: string) => {
    updateSettings({ quickLinks: settings.quickLinks.filter((item) => item.id !== id) });
  };

  const handleTestModelConnection = async () => {
    setModelTest({ status:"testing", message: t.testingModelConnection });
    try {
      const result = await testLlmServiceConnection({
        baseUrl: settings.aiModelPath,
        model: settings.aiModelName,
        apiKey: settings.aiApiKey,
        temperature: settings.aiTemperature,
        askSystemPrompt: settings.aiAskSystemPrompt,
        translationSystemPrompt: settings.aiTranslationSystemPrompt,
        translationTargetLanguage: settings.aiTranslationTargetLanguage,
      });
      setModelTest({
        status: result.ok ?"success" :"error",
        message: result.ok ? result.message || t.modelConnectionReady :`${t.modelConnectionFailed}: ${result.message}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelTest({ status:"error", message:`${t.modelConnectionFailed}: ${message}` });
    }
  };

  return (
    <div className="flex flex-col h-full bg-surface-panel text-content-secondary font-sans overflow-y-auto">
      <div className="flex items-center justify-between px-8 py-6 border-b border-border-subtle shrink-0">
        <h1 className="text-2xl font-serif font-bold tracking-tight text-content-primary">
          {t.settings} | {t.currentLanguage}
        </h1>
      </div>

      <div className="max-w-5xl mx-auto w-full p-8 space-y-12">
        <section>
          <div className="flex items-center gap-2 mb-6">
            <Palette className="text-content-disabled" size={20} />
            <h2 className="text-lg font-serif font-semibold text-content-primary">{t.appearance}</h2>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <Card className="p-5 xl:col-span-2">
              <h3 className="text-sm font-medium text-content-primary mb-4">{t.colorTheme}</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <ThemeCard
                  icon={<Sun size={22} />}
                  label={t.light}
                  active={settings.themeMode ==="light"}
                  onClick={() => {
                    onThemeChange("light");
                    updateSettings({ themeMode:"light" });
                  }}
                />
                <ThemeCard
                  icon={<Moon size={22} />}
                  label={t.dark}
                  active={settings.themeMode ==="dark"}
                  onClick={() => {
                    onThemeChange("dark");
                    updateSettings({ themeMode:"dark" });
                  }}
                />
                <ThemeCard
                  icon={<Monitor size={22} />}
                  label={t.system}
                  active={settings.themeMode ==="system"}
                  onClick={() => updateSettings({ themeMode:"system" })}
                />
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="text-sm font-medium text-content-primary mb-4">{t.accentColor}</h3>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                {accentOptions.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => updateSettings({ themeAccent: item.value })}
                    aria-label={item.label}
                    className={`h-10 rounded-full transition-all ${settings.themeAccent === item.value ?"ring-2 ring-offset-2 ring-content-disabled ring-offset-surface-app" :"opacity-60 hover:opacity-100"}`}
                    style={{ backgroundColor: ACCENT_TOKENS[item.value].solid }}
                    title={item.label}
                  />
                ))}
              </div>
              <p className="text-xs text-content-muted mt-4">{t.accentHint}</p>
            </Card>
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-6">
            <BookOpen className="text-content-disabled" size={20} />
            <h2 className="text-lg font-serif font-semibold text-content-primary">{t.readerAndWeb}</h2>
          </div>

          <Card className="divide-y divide-border-subtle">
            <SettingsRow icon={<Globe size={15} />} title={t.webPanelMode} description={t.webPanelModeDesc}>
              <StaticValueRow label={t.nativeWebview} />
            </SettingsRow>

            <SettingsRow icon={<FileText size={15} />} title={t.pdfOpenMode} description={t.pdfOpenModeDesc}>
              <SelectRow
                value={settings.webPdfOpenMode}
                options={[
                  { value:"download_then_open", label: t.downloadThenOpen },
                  { value:"direct", label: t.direct },
                ]}
                onChange={(value) => updateSettings({ webPdfOpenMode: value })}
              />
            </SettingsRow>

            <SettingsRow icon={<Network size={15} />} title={t.proxy} description={t.proxyDesc}>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <Button
                  size="sm"
                  variant={settings.proxyEnabled ? "accent" : "neutral"}
                  onClick={() => updateSettings({ proxyEnabled: !settings.proxyEnabled })}
                >
                  {settings.proxyEnabled ? t.enabled : t.disabled}
                </Button>
                <TextInput
                  value={settings.proxyUrl}
                  onChange={(event) => updateSettings({ proxyUrl: event.target.value })}
                  className="w-72"
                  placeholder="http://127.0.0.1:7890"
                  disabled={!settings.proxyEnabled}
                />
              </div>
            </SettingsRow>

            <SettingsRow icon={<Link2 size={15} />} title={t.openLinksInsideApp} description={t.openLinksInsideAppDesc}>
              <Button
                size="sm"
                variant={settings.openLinksInsideApp ? "accent" : "neutral"}
                onClick={() => updateSettings({ openLinksInsideApp: !settings.openLinksInsideApp })}
              >
                {settings.openLinksInsideApp ? t.insideApp : t.externalBrowser}
              </Button>
            </SettingsRow>

            <SettingsRow icon={<BookOpen size={15} />} title={t.companion} description={t.companionDesc}>
              <Button
                size="sm"
                variant={settings.companionEnabled ? "accent" : "neutral"}
                onClick={() => updateSettings({ companionEnabled: !settings.companionEnabled })}
              >
                {settings.companionEnabled ? t.enabled : t.disabled}
              </Button>
            </SettingsRow>

            {/*
             * 伴读的具体配置**必须**在这里展开，不能只留一个总开关。
             *
             * 总开关只能表达「要不要这个功能」，而读者真正想调节的是「它有多吵」：
             * 密度、要不要留下痕迹、要不要给我提问入口 —— 这三件事的打扰程度完全不同。
             * 只有一个开关时，觉得吵的人唯一的选择是整个关掉，于是功能等于没做。
             */}
            <SettingsRow
              icon={<Sparkles size={15} />}
              title={t.companionIntensity}
              description={t.companionIntensityDesc}
            >
              <SelectRow
                value={settings.companionIntensity}
                options={intensityOptions}
                onChange={(value) => updateSettings({ companionIntensity: value })}
              />
            </SettingsRow>

            <SettingsRow
              icon={<UnderlineIcon size={15} />}
              title={t.companionAutoAnnotate}
              description={t.companionAutoAnnotateDesc}
            >
              <Button
                size="sm"
                variant={settings.companionAutoAnnotate ? "accent" : "neutral"}
                onClick={() => updateSettings({ companionAutoAnnotate: !settings.companionAutoAnnotate })}
              >
                {settings.companionAutoAnnotate ? t.enabled : t.disabled}
              </Button>
            </SettingsRow>

            {settings.companionAutoAnnotate ? (
              <SettingsRow
                icon={<UnderlineIcon size={15} />}
                title={t.companionAnnotateIntensity}
                description={t.companionAnnotateIntensityDesc}
              >
                <SelectRow
                  value={settings.companionAutoAnnotateIntensity}
                  options={intensityOptions}
                  onChange={(value) => updateSettings({ companionAutoAnnotateIntensity: value })}
                />
              </SettingsRow>
            ) : null}

            <SettingsRow
              icon={<MessageSquare size={15} />}
              title={t.companionQuickAsk}
              description={t.companionQuickAskDesc}
            >
              <Button
                size="sm"
                variant={settings.companionQuickAsk ? "accent" : "neutral"}
                onClick={() => updateSettings({ companionQuickAsk: !settings.companionQuickAsk })}
              >
                {settings.companionQuickAsk ? t.enabled : t.disabled}
              </Button>
            </SettingsRow>

            <SettingsRow icon={<Globe size={15} />} title={t.language} description={t.languageDesc}>
              <SelectRow
                value={settings.language}
                options={languageOptions}
                onChange={(value) => updateSettings({ language: value })}
              />
            </SettingsRow>

            <SettingsRow icon={<Home size={15} />} title={t.newTabDefaultUrl} description={t.newTabDefaultUrlDesc}>
              <TextInput
                value={settings.newTabDefaultUrl}
                onChange={(event) => updateSettings({ newTabDefaultUrl: event.target.value })}
                className="w-72"
                placeholder="https://arxiv.org"
              />
            </SettingsRow>
          </Card>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-6">
            <HardDrive className="text-content-disabled" size={20} />
            <h2 className="text-lg font-serif font-semibold text-content-primary">{t.localStorage}</h2>
          </div>

          <Card className="divide-y divide-border-subtle">
            <SettingsRow icon={<FolderOpen size={15} />} title={t.workspaceLocation} description={t.localStorageDesc}>
              {workspace ? (
                <div className="flex flex-col items-end gap-2">
                  <code className="max-w-xl break-all rounded-lg bg-surface-panel px-3 py-2 text-right font-mono text-xs text-content-secondary">
                    {workspace.root}
                  </code>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" onClick={handleRevealWorkspace} disabled={workspaceBusy}>
                      {t.revealWorkspace}
                    </Button>
                    <Button size="sm" onClick={() => void handleChangeWorkspace()} disabled={workspaceBusy}>
                      {t.changeWorkspace}
                    </Button>
                  </div>
                  <p className="max-w-xl text-right text-xs leading-5 text-content-muted">{t.changeWorkspaceHint}</p>
                </div>
              ) : (
                <p className="text-xs text-content-muted">{t.workspaceUnavailable}</p>
              )}
            </SettingsRow>

            {workspace ? (
              <SettingsRow icon={<HardDrive size={15} />} title={t.workspaceUsage} description={t.clearCacheHint}>
                <div className="flex flex-col items-end gap-2">
                  <span className="font-mono text-sm text-content-primary">
                    {formatBytes(workspace.usage.totalBytes)}
                    <span className="ml-2 text-xs text-content-muted">
                      {workspace.usage.fileCount} {t.workspaceFiles}
                      {workspace.usage.truncated ? ` ${t.workspaceTruncated}` : ""}
                    </span>
                  </span>
                  <div className="flex flex-wrap justify-end gap-2">
                    <span className="self-center text-xs text-content-muted">
                      {workspace.isCustom ? t.workspaceCustom : t.workspaceDefault}
                    </span>
                    <Button size="sm" onClick={handleClearCache} disabled={workspaceBusy}>
                      {t.clearCache}
                    </Button>
                  </div>
                </div>
              </SettingsRow>
            ) : null}

            {/*
             * 钥匙串迁移只在**用户主动点击**时触发。
             * 启动流程绝不碰钥匙串 —— 那正是「每次开软件都要输一次密码」的来源，
             * 自动跑一次就等于把问题又请回来了。
             */}
            <SettingsRow icon={<KeyRound size={15} />} title={t.importKeychain} description={t.importKeychainHint}>
              <Button size="sm" onClick={handleImportKeychain} disabled={workspaceBusy}>
                {t.importKeychain}
              </Button>
            </SettingsRow>
          </Card>

          {workspaceNotice || workspaceError ? (
            <p
              className={`mt-3 text-right text-xs leading-5 ${
                workspaceError ? "text-state-danger" : "text-state-ok"
              }`}
              role="status"
            >
              {workspaceError || workspaceNotice}
            </p>
          ) : null}
        </section>

        <section>
          <div className="flex items-center gap-2 mb-6">
            <Download className="text-content-disabled" size={20} />
            <h2 className="text-lg font-serif font-semibold text-content-primary">{t.exportAndAi}</h2>
          </div>

          <Card className="divide-y divide-border-subtle">
            <SettingsRow
              icon={<FolderOpen size={15} />}
              title={t.defaultSaveDirectory}
              description={t.defaultSaveDirectoryDesc}
            >
              <div className="flex gap-2 flex-wrap justify-end">
                <TextInput
                  value={settings.defaultSaveDir}
                  onChange={(event) => updateSettings({ defaultSaveDir: event.target.value })}
                  className="w-72"
                  placeholder={t.chooseExportDirectory}
                />
                <Button onClick={() => void handlePickDirectory("defaultSaveDir")}>{t.browse}</Button>
                {directoryError ? (
                  <div className="basis-full text-right text-xs leading-5 text-state-danger" role="alert">
                    {directoryError}
                  </div>
                ) : null}
              </div>
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.localAiModelPath} description={t.localAiModelPathDesc}>
              <div className="flex gap-2 flex-wrap justify-end">
                <TextInput
                  value={settings.aiModelPath}
                  onChange={(event) => updateSettings({ aiModelPath: event.target.value })}
                  className="w-72 font-mono"
                  placeholder={t.selectLocalModelFolder}
                />
              </div>
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.aiModelName} description={t.aiModelNameDesc}>
              <div className="flex w-full max-w-xl flex-col items-end gap-2">
                <div className="flex gap-2 flex-wrap justify-end">
                  <TextInput
                    value={settings.aiModelName}
                    onChange={(event) => updateSettings({ aiModelName: event.target.value })}
                    className="w-72 font-mono"
                    placeholder="gpt-4o-mini"
                  />
                  <Button
                    variant="accent"
                    className="font-semibold"
                    onClick={() => void handleTestModelConnection()}
                    disabled={modelTest.status ==="testing"}
                  >
                    <PlugZap size={15} />
                    {modelTest.status ==="testing" ? t.testingModelConnection : t.testModelConnection}
                  </Button>
                </div>
                {modelTest.message ? (
                  <div
                    className={`max-w-xl text-right text-xs leading-5 ${
                      modelTest.status ==="success"
                        ?"text-state-ok"
                        : modelTest.status ==="error"
                          ?"text-state-danger"
                          :"text-content-muted"
                    }`}
                    role="status"
                  >
                    {modelTest.message}
                  </div>
                ) : null}
              </div>
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.aiApiKey} description={t.aiApiKeyDesc}>
              <TextInput
                type="password"
                value={settings.aiApiKey}
                onChange={(event) => updateSettings({ aiApiKey: event.target.value })}
                className="w-72 font-mono"
                placeholder="sk-..."
                autoComplete="off"
              />
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.aiTemperature} description={t.aiTemperatureDesc}>
              <div className="flex w-72 items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={settings.aiTemperature}
                  onChange={(event) => updateSettings({ aiTemperature: Number(event.target.value) })}
                  className="flex-1"
                />
                <TextInput
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={settings.aiTemperature}
                  onChange={(event) => updateSettings({ aiTemperature: Number(event.target.value) })}
                  className="w-20 font-mono"
                />
              </div>
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.translationTarget} description={t.translationTargetDesc}>
              <TextInput
                value={settings.aiTranslationTargetLanguage}
                onChange={(event) => updateSettings({ aiTranslationTargetLanguage: event.target.value })}
                className="w-72"
                placeholder="Simplified Chinese"
              />
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.askPrompt} description={t.askPromptDesc}>
              <Textarea
                value={settings.aiAskSystemPrompt}
                onChange={(event) => updateSettings({ aiAskSystemPrompt: event.target.value })}
                className="min-h-24 w-full max-w-xl"
              />
            </SettingsRow>

            <SettingsRow icon={<Palette size={15} />} title={t.translationPrompt} description={t.translationPromptDesc}>
              <Textarea
                value={settings.aiTranslationSystemPrompt}
                onChange={(event) => updateSettings({ aiTranslationSystemPrompt: event.target.value })}
                className="min-h-24 w-full max-w-xl"
              />
            </SettingsRow>
          </Card>
        </section>

        <section id="settings-quick-links" ref={quickLinksSectionRef}>
          <div className="flex items-center gap-2 mb-6">
            <Link2 className="text-content-disabled" size={20} />
            <h2 className="text-lg font-serif font-semibold text-content-primary">{t.quickLinks}</h2>
          </div>

          <Card className="p-5 space-y-4">
            <p className="text-xs text-content-muted">{t.quickLinksDesc}</p>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1.4fr_auto] gap-3 items-end">
              <div>
                <label className="block text-xs text-content-muted mb-1">{t.title}</label>
                <TextInput
                  ref={titleInputRef}
                  aria-label={t.title}
                  value={draftQuickLink.title}
                  onChange={(event) => setDraftQuickLink((prev) => ({ ...prev, title: event.target.value }))}
                  className="w-full"
                  placeholder={t.quickLinkTitlePlaceholder}
                />
              </div>
              <div>
                <label className="block text-xs text-content-muted mb-1">{t.url}</label>
                <TextInput
                  aria-label={t.url}
                  value={draftQuickLink.url}
                  onChange={(event) => setDraftQuickLink((prev) => ({ ...prev, url: event.target.value }))}
                  className="w-full"
                  placeholder={t.quickLinkUrlPlaceholder}
                />
              </div>
              <Button variant="accent" onClick={addQuickLink}>
                <Plus size={14} />
                {t.add}
              </Button>
            </div>

            <div className="space-y-2">
              {settings.quickLinks.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-xl border border-border-subtle bg-surface-panel px-3 py-2 gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-content-primary truncate">{item.title}</div>
                    <div className="text-xs text-content-muted truncate">{item.url}</div>
                  </div>
                  <IconButton
                    tone="danger"
                    label={t.removeQuickLink}
                    onClick={() => removeQuickLink(item.id)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          </Card>
        </section>
      </div>
    </div>
  );
}

function ThemeCard({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      type="button"
      aria-pressed={active}
      className={`flex-1 flex flex-col items-center gap-3 p-4 rounded-lg border-2 transition-all ${
        active
          ?"border-content-primary bg-surface-panel"
          :"border-transparent bg-surface-hover hover:bg-surface-active"
      }`}
    >
      {icon}
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}

function SettingsRow({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between p-5 gap-6 flex-wrap">
      <div>
        <h3 className="text-sm font-medium text-content-primary flex items-center gap-2">
          {icon}
          {title}
        </h3>
        <p className="text-xs text-content-muted mt-1">{description}</p>
      </div>
      {children}
    </div>
  );
}
