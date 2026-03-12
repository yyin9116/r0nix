import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SVGProps } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Home,
  FileText,
  Lock,
  Star,
  MoreVertical,
  Download,
  ExternalLink,
  Link2,
  Copy,
  Focus,
  Loader2,
} from "lucide-react";
import type { AppLanguage, QuickLinkItem, WebPanelMode } from "../services/userSettings";
import {
  canUseNativeWebview,
  createOrShowNativeWebviewTab,
  hideNativeWebviewTab,
  navigateNativeWebviewTab,
  showNativeWebviewTab,
  syncNativeWebviewTabBounds,
} from "../services/nativeWebview";
import { START_PAGE_URL } from "../constants/startPage";
import { StartPage } from "./StartPage";

interface WebBrowserProps {
  tabId: string;
  mode: WebPanelMode;
  quickLinks: QuickLinkItem[];
  language?: AppLanguage;
  initialUrl?: string;
  onUrlChange?: (url: string) => void;
  onOpenPdfInApp?: (url: string) => void;
  onOpenExternal?: (url: string) => void;
  onDownloadCurrent?: (url: string, options?: { preferPdf?: boolean }) => Promise<void> | void;
  onShowMessage?: (message: string) => void;
}

type BrowserBookmark = {
  url: string;
  title: string;
  createdAt: string;
};

const BOOKMARKS_KEY = "r0nix_reader_web_bookmarks_v1";

const I18N = {
  "zh-CN": {
    navBack: "后退",
    navForward: "前进",
    refresh: "刷新",
    home: "起始页",
    bookmarkAdd: "添加书签",
    bookmarkRemove: "移除书签",
    statusNative: "原生 WebView",
    statusIframe: "网页框架",
    openPdfInApp: "在应用中打开 PDF",
    openPdfInAppHintDetected: "检测到 PDF 资源，尝试直接在应用中打开",
    openPdfInAppHintFallback: "尝试将当前地址作为 PDF 在应用中打开",
    openExternal: "系统浏览器打开",
    download: "下载",
    more: "更多操作",
    menuDownloadPdf: "下载 PDF",
    menuDownloadCurrent: "下载当前资源",
    menuCopyUrl: "复制当前地址",
    menuOpenExternal: "系统浏览器打开",
    menuOpenPdf: "在应用中打开 PDF",
    menuFocusNative: "聚焦原生 WebView",
    quickLinksLabel: "快捷站点",
    iframeNotice: "部分学术站点会拒绝 iframe 嵌入。可在设置中切换到原生 WebView 获得更完整兼容性。",
    loadingPage: "正在加载",
    nativeActiveTitle: "原生 WebView 已启用",
    nativeActiveDesc: "当前页面由 Tauri 原生 WebView 承载，可绕过部分 iframe 限制并支持 PDF 链接拦截。",
    emptyTitle: "输入网址开始浏览",
    noPageToBookmark: "当前没有可收藏页面",
    bookmarkRemoved: "已移除书签",
    bookmarkAdded: "已添加书签",
    urlCopied: "已复制地址",
    clipboardUnavailable: "剪贴板不可用",
    nothingToDownload: "当前没有可下载资源",
    noPdfDetected: "未检测到可识别的 PDF 链接",
    nativeFocused: "已聚焦原生 WebView",
    debugLoading: "加载中",
    debugIdle: "空闲",
    debugNative: "原生",
    debugIframe: "框架",
    addressPlaceholder: "输入网址或搜索地址",
  },
  "en-US": {
    navBack: "Back",
    navForward: "Forward",
    refresh: "Refresh",
    home: "Home",
    bookmarkAdd: "Add bookmark",
    bookmarkRemove: "Remove bookmark",
    statusNative: "Native WebView",
    statusIframe: "Iframe",
    openPdfInApp: "Open PDF in App",
    openPdfInAppHintDetected: "Detected a PDF resource and open it in app",
    openPdfInAppHintFallback: "Try opening current URL as PDF in app",
    openExternal: "Open externally",
    download: "Download",
    more: "More actions",
    menuDownloadPdf: "Download PDF",
    menuDownloadCurrent: "Download current resource",
    menuCopyUrl: "Copy current URL",
    menuOpenExternal: "Open externally",
    menuOpenPdf: "Open PDF in app",
    menuFocusNative: "Focus native webview",
    iframeNotice: "Some academic sites may block iframe embedding. Switch Web panel mode to native webview in Settings for full compatibility.",
    loadingPage: "Loading",
    nativeActiveTitle: "Native WebView Active",
    nativeActiveDesc: "This area is powered by a Tauri native webview, allowing protected sites and in-app PDF interception.",
    emptyTitle: "Open a website to start",
    noPageToBookmark: "No page to bookmark",
    bookmarkRemoved: "Bookmark removed",
    bookmarkAdded: "Bookmark added",
    urlCopied: "URL copied",
    clipboardUnavailable: "Clipboard unavailable",
    nothingToDownload: "Nothing to download",
    noPdfDetected: "No PDF-like resource detected",
    nativeFocused: "Native webview focused",
    debugLoading: "loading",
    debugIdle: "idle",
    debugNative: "native",
    debugIframe: "iframe",
    addressPlaceholder: "Enter URL",
  },
} as const;

function normalizeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `https://${value}`;
}

function normalizeBookmarkUrl(raw: string) {
  const normalized = normalizeUrl(raw);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function loadStoredBookmarks(): BrowserBookmark[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<BrowserBookmark>>;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const bookmarks: BrowserBookmark[] = [];
    for (const item of parsed) {
      const url = typeof item?.url === "string" ? normalizeBookmarkUrl(item.url) : "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      bookmarks.push({
        url,
        title: typeof item?.title === "string" && item.title.trim() ? item.title.trim() : shortHost(url),
        createdAt:
          typeof item?.createdAt === "string" && item.createdAt ? item.createdAt : new Date().toISOString(),
      });
    }
    return bookmarks;
  } catch {
    return [];
  }
}

function guessHomeUrl() {
  return START_PAGE_URL;
}

function looksLikePdfUrl(url: string) {
  const value = url.trim();
  if (!value) return false;
  const lowered = value.toLowerCase();
  if (/\.pdf(?:$|[?#])/i.test(lowered)) return true;
  if (/(?:[?&](file|filename|format|type|mime)=)[^&]*pdf/i.test(lowered)) return true;
  if (/\/pdf(?:\/|$)/i.test(lowered)) return true;
  return /\bpdf\b/i.test(lowered) && /(download|export|article|paper|doc)/i.test(lowered);
}

function shortHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function WebBrowser({
  tabId,
  mode,
  quickLinks,
  language = "zh-CN",
  initialUrl = guessHomeUrl(),
  onUrlChange,
  onOpenPdfInApp,
  onOpenExternal,
  onDownloadCurrent,
  onShowMessage,
}: WebBrowserProps) {
  const t = I18N[language];
  const supportsNative = canUseNativeWebview();
  const nativeMode = mode === "native_webview" && supportsNative;
  const showIframeCompatibilityNotice = mode === "iframe" && supportsNative;
  const [url, setUrl] = useState(initialUrl === START_PAGE_URL ? START_PAGE_URL : normalizeUrl(initialUrl));
  const [inputUrl, setInputUrl] = useState(initialUrl === START_PAGE_URL ? "" : normalizeUrl(initialUrl));
  const [reloadToken, setReloadToken] = useState(0);
  const [nativeReloadToken, setNativeReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>(loadStoredBookmarks);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [debugHint, setDebugHint] = useState("idle");

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const lastNavRef = useRef("");
  const nativeBoundsSigRef = useRef("");
  const syncOnlyRef = useRef(false);
  const loadingTimerRef = useRef<number | null>(null);
  const loadingWatchdogRef = useRef<number | null>(null);

  const isStartPage = url === START_PAGE_URL;
  const currentUrl = useMemo(() => (isStartPage ? "" : normalizeUrl(url || inputUrl)), [inputUrl, isStartPage, url]);
  const currentBookmarkUrl = useMemo(() => normalizeBookmarkUrl(currentUrl), [currentUrl]);
  const bookmarked = useMemo(
    () => Boolean(currentBookmarkUrl) && bookmarks.some((item) => item.url === currentBookmarkUrl),
    [bookmarks, currentBookmarkUrl]
  );
  const pdfLink = useMemo(() => {
    const normalizedInput = normalizeUrl(inputUrl);
    if (looksLikePdfUrl(normalizedInput)) return normalizedInput;
    if (looksLikePdfUrl(url)) return url;
    return normalizedInput || url;
  }, [inputUrl, url]);

  const setDebug = useCallback((hint: string) => {
    setDebugHint(hint);
  }, []);

  useEffect(() => {
    if (initialUrl === START_PAGE_URL) {
      setInputUrl("");
      setUrl((prev) => {
        if (prev === START_PAGE_URL) return prev;
        syncOnlyRef.current = true;
        return START_PAGE_URL;
      });
      return;
    }

    const normalized = normalizeUrl(initialUrl);
    if (!normalized) return;
    setInputUrl(normalized);
    setUrl((prev) => {
      if (prev === normalized) return prev;
      syncOnlyRef.current = true;
      return normalized;
    });
  }, [initialUrl]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
  }, [bookmarks]);

  const clearLoadingTimers = useCallback(() => {
    if (loadingTimerRef.current !== null) {
      window.clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    if (loadingWatchdogRef.current !== null) {
      window.clearTimeout(loadingWatchdogRef.current);
      loadingWatchdogRef.current = null;
    }
  }, []);

  const beginLoading = useCallback(
    (watchdogMs = 7000, reason = "loading") => {
      clearLoadingTimers();
      setLoading(true);
      setDebug(`loading: ${reason} (watchdog ${watchdogMs}ms)`);
      loadingWatchdogRef.current = window.setTimeout(() => {
        loadingWatchdogRef.current = null;
        setLoading(false);
        setDebug("watchdog timeout: loading dismissed");
      }, watchdogMs);
    },
    [clearLoadingTimers, setDebug]
  );

  const finishLoadingSoon = useCallback(
    (delay = 320, reason = "done") => {
      if (loadingTimerRef.current !== null) {
        window.clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      loadingTimerRef.current = window.setTimeout(() => {
        loadingTimerRef.current = null;
        if (loadingWatchdogRef.current !== null) {
          window.clearTimeout(loadingWatchdogRef.current);
          loadingWatchdogRef.current = null;
        }
        setLoading(false);
        setDebug(`loading finished: ${reason}`);
      }, delay);
    },
    [setDebug]
  );

  const endLoadingNow = useCallback(
    (reason = "loaded") => {
      clearLoadingTimers();
      setLoading(false);
      setDebug(`loading end: ${reason}`);
    },
    [clearLoadingTimers, setDebug]
  );

  useEffect(() => {
    return () => {
      clearLoadingTimers();
    };
  }, [clearLoadingTimers]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!nativeMode || !url || isStartPage) return;
    const navKey = `${tabId}|${url}|${nativeReloadToken}`;
    if (syncOnlyRef.current) {
      syncOnlyRef.current = false;
      lastNavRef.current = navKey;
      return;
    }
    if (lastNavRef.current === navKey) return;
    lastNavRef.current = navKey;

    beginLoading(9000, "native navigate");
    void createOrShowNativeWebviewTab(tabId, url, shortHost(url), true)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setDebug(`native create failed, fallback navigate: ${message}`);
        return navigateNativeWebviewTab(tabId, url);
      })
      .finally(() => {
        finishLoadingSoon(260, "native bridge ack");
      });
  }, [beginLoading, finishLoadingSoon, isStartPage, nativeMode, nativeReloadToken, tabId, url]);

  useEffect(() => {
    if (!nativeMode || !tabId) return;

    let disposed = false;
    let resizeObs: ResizeObserver | null = null;
    let cleanupMoved: (() => void) | null = null;
    let cleanupResized: (() => void) | null = null;
    let scrollHandler: ((event: Event) => void) | null = null;
    let rafHandle: number | null = null;

    const syncBounds = async () => {
      if (disposed) return;
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 10 || height < 10) return;

      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const currentWindow = getCurrentWindow();
      const [position, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
      const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
      const x = Math.round(position.x / safeScale + rect.left);
      const y = Math.round(position.y / safeScale + rect.top);
      const signature = `${x}|${y}|${width}|${height}`;
      if (nativeBoundsSigRef.current === signature) return;
      nativeBoundsSigRef.current = signature;
      await syncNativeWebviewTabBounds(tabId, x, y, width, height);
    };

    const scheduleSync = () => {
      if (disposed || rafHandle !== null) return;
      rafHandle = window.requestAnimationFrame(() => {
        rafHandle = null;
        void syncBounds();
      });
    };

    const setup = async () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      resizeObs = new ResizeObserver(() => {
        scheduleSync();
      });
      resizeObs.observe(anchor);

      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const currentWindow = getCurrentWindow();
      cleanupMoved = await currentWindow.onMoved(() => {
        scheduleSync();
      });
      cleanupResized = await currentWindow.onResized(() => {
        scheduleSync();
      });

      scrollHandler = () => {
        scheduleSync();
      };
      window.addEventListener("scroll", scrollHandler, true);
      scheduleSync();
    };

    void setup();
    return () => {
      disposed = true;
      if (rafHandle !== null) {
        window.cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      resizeObs?.disconnect();
      cleanupMoved?.();
      cleanupResized?.();
      if (scrollHandler) window.removeEventListener("scroll", scrollHandler, true);
      nativeBoundsSigRef.current = "";
    };
  }, [nativeMode, tabId]);

  useEffect(() => {
    if (!nativeMode || !tabId) return;
    if (isStartPage) {
      void hideNativeWebviewTab(tabId);
      return;
    }
    const handleVisibility = () => {
      if (!document.hidden) {
        void showNativeWebviewTab(tabId, false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [isStartPage, nativeMode, tabId]);

  useEffect(() => {
    if (!nativeMode || !tabId) return;
    return () => {
      void hideNativeWebviewTab(tabId);
    };
  }, [isStartPage, nativeMode, tabId]);

  const showMessage = (message: string) => {
    onShowMessage?.(message);
  };

  const toggleBookmark = useCallback(() => {
    if (!currentBookmarkUrl) {
      showMessage(t.noPageToBookmark);
      return;
    }

    setBookmarks((prev) => {
      const exists = prev.some((item) => item.url === currentBookmarkUrl);
      if (exists) {
        showMessage(t.bookmarkRemoved);
        return prev.filter((item) => item.url !== currentBookmarkUrl);
      }

      showMessage(t.bookmarkAdded);
      return [
        {
          url: currentBookmarkUrl,
          title: shortHost(currentBookmarkUrl),
          createdAt: new Date().toISOString(),
        },
        ...prev.filter((item) => item.url !== currentBookmarkUrl),
      ];
    });
    setMenuOpen(false);
  }, [currentBookmarkUrl, t.bookmarkAdded, t.bookmarkRemoved, t.noPageToBookmark]);

  const navigateTo = (raw: string) => {
    if (raw === START_PAGE_URL) {
      setUrl(START_PAGE_URL);
      setInputUrl("");
      endLoadingNow("start page");
      onUrlChange?.(START_PAGE_URL);
      if (nativeMode) {
        void hideNativeWebviewTab(tabId);
      }
      return;
    }

    const normalized = normalizeUrl(raw);
    if (!normalized) return;
    setUrl(normalized);
    setInputUrl(normalized);
    beginLoading(9000, "navigateTo");
    onUrlChange?.(normalized);
    if (nativeMode) {
      setNativeReloadToken((value) => value + 1);
      return;
    }
    setReloadToken((value) => value + 1);
  };

  const openExternal = () => {
    if (!currentUrl) return;
    if (onOpenExternal) {
      onOpenExternal(currentUrl);
      return;
    }
    window.open(currentUrl, "_blank", "noopener,noreferrer");
  };

  const navigateBack = () => {
    if (nativeMode) return;
    try {
      iframeRef.current?.contentWindow?.history.back();
    } catch {
      // ignore cross-origin history errors
    }
  };

  const navigateForward = () => {
    if (nativeMode) return;
    try {
      iframeRef.current?.contentWindow?.history.forward();
    } catch {
      // ignore cross-origin history errors
    }
  };

  const handleCopyCurrentUrl = async () => {
    if (!currentUrl) return;
    try {
      await navigator.clipboard.writeText(currentUrl);
      showMessage(t.urlCopied);
    } catch {
      showMessage(t.clipboardUnavailable);
    }
  };

  const handleDownload = async (preferPdf = false) => {
    if (!currentUrl || !onDownloadCurrent) {
      showMessage(t.nothingToDownload);
      return;
    }
    try {
      setActionBusy(true);
      await onDownloadCurrent(preferPdf ? pdfLink || currentUrl : currentUrl, { preferPdf });
    } finally {
      setActionBusy(false);
      setMenuOpen(false);
    }
  };

  const handleOpenPdfInApp = () => {
    if (!pdfLink) {
      showMessage(t.noPdfDetected);
      return;
    }
    onOpenPdfInApp?.(pdfLink);
    setMenuOpen(false);
  };

  const keepNativeVisible = () => {
    if (!nativeMode || isStartPage) return;
    void showNativeWebviewTab(tabId, false);
  };

  const handleFocusNative = () => {
    if (!nativeMode || isStartPage) return;
    void showNativeWebviewTab(tabId, true);
    showMessage(t.nativeFocused);
    setMenuOpen(false);
  };

  const navButtonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100";

  return (
    <div
      className="flex h-full flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100"
      onMouseDownCapture={keepNativeVisible}
      onPointerDownCapture={keepNativeVisible}
    >
      <div className="z-10 shrink-0 border-b border-gray-100 bg-white/95 px-3 py-2 shadow-sm backdrop-blur dark:border-gray-800 dark:bg-gray-900/95">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button className={navButtonClass} title={t.navBack} onClick={navigateBack} disabled={nativeMode}>
              <ArrowLeft size={16} />
            </button>
            <button className={navButtonClass} title={t.navForward} onClick={navigateForward} disabled={nativeMode}>
              <ArrowRight size={16} />
            </button>
            <button
              className={navButtonClass}
              onClick={() => {
                if (isStartPage) {
                  endLoadingNow("start page");
                  return;
                }
                if (nativeMode) {
                  beginLoading(6000, "refresh-native");
                  lastNavRef.current = "";
                  setNativeReloadToken((value) => value + 1);
                  return;
                }
                beginLoading(9000, "refresh-iframe");
                setReloadToken((value) => value + 1);
              }}
              title={t.refresh}
            >
              <RotateCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
            <button className={navButtonClass} onClick={() => navigateTo(START_PAGE_URL)} title={t.home}>
              <Home size={16} />
            </button>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              navigateTo(inputUrl);
            }}
            className="relative mx-auto flex-1"
          >
            <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
              <Lock size={14} />
            </div>
            <input
              type="text"
              value={inputUrl}
              onChange={(event) => setInputUrl(event.target.value)}
              placeholder={t.addressPlaceholder}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-9 pr-10 text-sm text-gray-900 transition-all placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition-colors dark:text-gray-500"
              title={bookmarked ? t.bookmarkRemove : t.bookmarkAdd}
              onClick={toggleBookmark}
              style={{ color: bookmarked ? "var(--reader-accent)" : undefined }}
            >
              <Star size={16} fill={bookmarked ? "currentColor" : "none"} />
            </button>
          </form>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="hidden items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 lg:inline-flex">
              {nativeMode ? t.statusNative : t.statusIframe}
            </span>

            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
              onClick={handleOpenPdfInApp}
              title={looksLikePdfUrl(pdfLink) ? t.openPdfInAppHintDetected : t.openPdfInAppHintFallback}
            >
              <FileText size={14} />
              <span className="hidden xl:inline">{t.openPdfInApp}</span>
            </button>

            <button className={navButtonClass} onClick={openExternal} title={t.openExternal}>
              <ExternalLink size={16} />
            </button>

            <button
              className={navButtonClass}
              onClick={() => {
                void handleDownload(looksLikePdfUrl(pdfLink));
              }}
              title={t.download}
              disabled={actionBusy}
            >
              {actionBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            </button>

            <div className="relative" ref={menuRef}>
              <button className={navButtonClass} title={t.more} onClick={() => setMenuOpen((value) => !value)}>
                <MoreVertical size={16} />
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-10 z-30 w-64 rounded-2xl border border-gray-100 bg-white p-2 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                  <MenuButton
                    icon={<Star size={14} />}
                    label={bookmarked ? t.bookmarkRemove : t.bookmarkAdd}
                    onClick={toggleBookmark}
                  />
                  <MenuButton
                    icon={<Download size={14} />}
                    label={looksLikePdfUrl(pdfLink) ? t.menuDownloadPdf : t.menuDownloadCurrent}
                    onClick={() => {
                      void handleDownload(looksLikePdfUrl(pdfLink));
                    }}
                    disabled={actionBusy}
                  />
                  <MenuButton
                    icon={<Copy size={14} />}
                    label={t.menuCopyUrl}
                    onClick={() => {
                      void handleCopyCurrentUrl();
                      setMenuOpen(false);
                    }}
                  />
                  <MenuButton
                    icon={<ExternalLink size={14} />}
                    label={t.menuOpenExternal}
                    onClick={() => {
                      openExternal();
                      setMenuOpen(false);
                    }}
                  />
                  <MenuButton icon={<FileText size={14} />} label={t.menuOpenPdf} onClick={handleOpenPdfInApp} />
                  {nativeMode ? (
                    <MenuButton icon={<Focus size={14} />} label={t.menuFocusNative} onClick={handleFocusNative} />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2 overflow-x-auto pb-0.5 no-scrollbar">
          <span className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-mono text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            {nativeMode ? t.debugNative : t.debugIframe} | {loading ? t.debugLoading : t.debugIdle}
          </span>
          <span className="inline-flex max-w-[38rem] truncate rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-mono text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400" title={debugHint}>
            {debugHint}
          </span>
          {quickLinks.map((item) => (
            <button
              key={item.id}
              onClick={() => navigateTo(item.url)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Link2 size={12} />
              {item.title}
            </button>
          ))}
        </div>
      </div>

      {showIframeCompatibilityNotice ? (
        <div className="mx-4 mt-3 rounded-2xl border border-gray-100 bg-white px-4 py-3 text-xs text-gray-600 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
          {t.iframeNotice}
        </div>
      ) : null}

      <div
        ref={anchorRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white dark:bg-gray-950"
        onMouseEnter={() => {
          if (!nativeMode || isStartPage) return;
          void showNativeWebviewTab(tabId, false);
        }}
        onMouseDown={() => {
          if (!nativeMode || isStartPage) return;
          void showNativeWebviewTab(tabId, true);
        }}
      >
        {loading ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/80 text-sm text-gray-500 dark:bg-gray-950/70 dark:text-gray-300">
            <div className="inline-flex items-center gap-2 rounded-xl border border-gray-100 bg-white px-3 py-2 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.loadingPage} {url || "page"}...
            </div>
          </div>
        ) : null}

        {isStartPage ? (
          <StartPage quickLinks={quickLinks} onNavigate={navigateTo} language={language} />
        ) : nativeMode ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center text-gray-400 dark:text-gray-600">
            <GlobeIcon className="mb-4 h-16 w-16 opacity-20" />
            <p className="text-xl font-semibold tracking-tight text-gray-700 dark:text-gray-300">{t.nativeActiveTitle}</p>
            <p className="mt-2 max-w-lg text-sm text-gray-500 dark:text-gray-400">{t.nativeActiveDesc}</p>
            <p className="mt-3 text-xs font-mono text-gray-400 dark:text-gray-500">{url}</p>
          </div>
        ) : url ? (
          <iframe
            key={`${url}-${reloadToken}`}
            ref={iframeRef}
            src={url}
            className="absolute inset-0 h-full w-full border-0"
            title={url}
            onLoad={() => endLoadingNow("iframe onLoad")}
            onError={() => endLoadingNow("iframe onError")}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 dark:text-gray-600">
            <GlobeIcon className="mb-4 h-16 w-16 opacity-20" />
            <p className="text-xl font-semibold tracking-tight text-gray-700 dark:text-gray-300">{t.emptyTitle}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuButton({ icon, label, onClick, disabled = false }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function GlobeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      <path d="M2 12h20" />
    </svg>
  );
}
