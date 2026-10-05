import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SVGProps } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  navigateNativeWebviewTabHistory,
  showNativeWebviewTab,
  syncNativeWebviewTabBounds,
} from "../services/nativeWebview";
import { appendBrowserHistory } from "../services/browserHistory";
import { normalizeHttpUrl, normalizeWebUrl } from "../services/urlPolicy";
import { readVersionedLocalState, writeVersionedLocalState } from "../services/localStore";
import { START_PAGE_URL } from "../constants/startPage";
import { StartPage } from "./StartPage";
import "./WebViewPanel.css";

interface WebBrowserProps {
  tabId: string;
  mode: WebPanelMode;
  quickLinks: QuickLinkItem[];
  language?: AppLanguage;
  initialUrl?: string;
  onUrlChange?: (url: string) => void;
  onOpenPdfInApp?: (url: string) => Promise<void> | void;
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
const BOOKMARKS_STATE_VERSION = 1;
const NATIVE_WEBVIEW_TOP_ADJUST_PX = 32;

const I18N = {
  "zh-CN": {
    navBack: "后退",
    navForward: "前进",
    refresh: "刷新",
    home: "起始页",
    bookmarkAdd: "添加书签",
    bookmarkRemove: "移除书签",
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
    nativeNavigationFailed: "原生网页导航失败",
    iframeNotice: "当前是浏览器预览环境，原生 WebView 仅在桌面端启用；部分网站可能拒绝 iframe 嵌入。",
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
    addressPlaceholder: "输入网址或搜索地址",
  },
  "en-US": {
    navBack: "Back",
    navForward: "Forward",
    refresh: "Refresh",
    home: "Home",
    bookmarkAdd: "Add bookmark",
    bookmarkRemove: "Remove bookmark",
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
    nativeNavigationFailed: "Native page navigation failed",
    iframeNotice: "This is a browser preview. Native WebView only runs in the desktop app; some sites may reject iframe embedding.",
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
    addressPlaceholder: "Enter URL",
  },
} as const;

function normalizeUrl(raw: string) {
  return normalizeWebUrl(raw);
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
  return readVersionedLocalState(BOOKMARKS_KEY, BOOKMARKS_STATE_VERSION, [], (raw) => {
    const parsed = raw as Array<Partial<BrowserBookmark>>;
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
  });
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
  const nativeMode = supportsNative && mode === "native_webview";
  const showIframeCompatibilityNotice = (mode === "iframe" || mode === "native_webview") && !supportsNative;
  const [url, setUrl] = useState(initialUrl === START_PAGE_URL ? START_PAGE_URL : normalizeUrl(initialUrl));
  const [inputUrl, setInputUrl] = useState(initialUrl === START_PAGE_URL ? "" : normalizeUrl(initialUrl));
  const [reloadToken, setReloadToken] = useState(0);
  const [nativeReloadToken, setNativeReloadToken] = useState(0);
  const initialHistoryUrl = initialUrl === START_PAGE_URL ? START_PAGE_URL : normalizeUrl(initialUrl);
  const [historyEntries, setHistoryEntries] = useState<string[]>([initialHistoryUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>(loadStoredBookmarks);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const lastNavRef = useRef("");
  const nativeBoundsSigRef = useRef("");
  const syncOnlyRef = useRef(false);
  const loadingTimerRef = useRef<number | null>(null);
  const loadingWatchdogRef = useRef<number | null>(null);
  const lastInitialUrlRef = useRef(initialHistoryUrl);
  const selfNavigatedUrlRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (initialUrl === START_PAGE_URL) {
      setInputUrl("");
      setUrl((prev) => {
        if (prev === START_PAGE_URL) return prev;
        syncOnlyRef.current = true;
        return START_PAGE_URL;
      });
      if (selfNavigatedUrlRef.current === START_PAGE_URL) {
        lastInitialUrlRef.current = START_PAGE_URL;
        selfNavigatedUrlRef.current = null;
        return;
      }
      if (lastInitialUrlRef.current !== START_PAGE_URL) {
        lastInitialUrlRef.current = START_PAGE_URL;
        if (nativeMode) {
          setHistoryEntries((previous) => {
            const next = appendBrowserHistory(previous, historyIndex, START_PAGE_URL);
            setHistoryIndex(next.index);
            return next.entries;
          });
        } else {
          setHistoryEntries([START_PAGE_URL]);
          setHistoryIndex(0);
        }
      }
      return;
    }

    const normalized = normalizeUrl(initialUrl);
    if (!normalized) return;
    setInputUrl(normalized);
    setUrl((prev) => {
      if (prev === normalized) return prev;
      return normalized;
    });
    if (selfNavigatedUrlRef.current === normalized) {
      lastInitialUrlRef.current = normalized;
      selfNavigatedUrlRef.current = null;
      return;
    }
    if (lastInitialUrlRef.current !== normalized) {
      lastInitialUrlRef.current = normalized;
      if (nativeMode) {
        setHistoryEntries((previous) => {
          const next = appendBrowserHistory(previous, historyIndex, normalized);
          setHistoryIndex(next.index);
          return next.entries;
        });
      } else {
        setHistoryEntries([normalized]);
        setHistoryIndex(0);
      }
    }
  }, [historyIndex, initialUrl, nativeMode]);

  useEffect(() => {
    writeVersionedLocalState(BOOKMARKS_KEY, BOOKMARKS_STATE_VERSION, bookmarks);
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

  const endLoadingNow = useCallback(() => {
    clearLoadingTimers();
    setLoading(false);
    if (nativeMode && tabId && !isStartPage) {
      void showNativeWebviewTab(tabId, false).catch(() => undefined);
    }
  }, [clearLoadingTimers, isStartPage, nativeMode, tabId]);

  const beginLoading = useCallback(
    (watchdogMs = 7000) => {
      clearLoadingTimers();
      setLoading(true);
      // Native WebView is a child window and always paints above the DOM.
      // Hide it during navigation so the in-app loading surface remains visible.
      if (nativeMode && tabId) {
        void hideNativeWebviewTab(tabId).catch(() => undefined);
      }
      loadingWatchdogRef.current = window.setTimeout(() => {
        loadingWatchdogRef.current = null;
        endLoadingNow();
      }, watchdogMs);
    },
    [clearLoadingTimers, endLoadingNow, nativeMode, tabId]
  );

  const syncNativeBounds = useCallback(
    async (force = false) => {
      if (!nativeMode || !tabId) return;
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height) - NATIVE_WEBVIEW_TOP_ADJUST_PX;
      if (width < 10 || height < 10) return;

      let chromeLeft = 0;
      let chromeTop = 0;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const [innerPosition, outerPosition, scaleFactor] = await Promise.all([
          currentWindow.innerPosition(),
          currentWindow.outerPosition(),
          currentWindow.scaleFactor(),
        ]);
        const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
        chromeLeft = Math.max(0, Math.round((innerPosition.x - outerPosition.x) / safeScale));
        chromeTop = Math.max(0, Math.round((innerPosition.y - outerPosition.y) / safeScale));
      } catch {
        chromeLeft = 0;
        chromeTop = 0;
      }

      const x = Math.round(rect.left + chromeLeft);
      const y = Math.round(rect.top + chromeTop + NATIVE_WEBVIEW_TOP_ADJUST_PX);
      const signature = `${x}|${y}|${width}|${height}`;
      if (!force && nativeBoundsSigRef.current === signature) return;
      await syncNativeWebviewTabBounds(tabId, x, y, width, height);
      nativeBoundsSigRef.current = signature;
    },
    [nativeMode, tabId]
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

    beginLoading(9000);
    void createOrShowNativeWebviewTab(tabId, url, shortHost(url), true)
      .catch(() => navigateNativeWebviewTab(tabId, url))
      .then(() => hideNativeWebviewTab(tabId).catch(() => undefined))
      .then(() => syncNativeBounds(true))
      .finally(() => {
        window.setTimeout(() => endLoadingNow(), 260);
      });
  }, [beginLoading, endLoadingNow, isStartPage, nativeMode, nativeReloadToken, syncNativeBounds, tabId, url]);

  useEffect(() => {
    if (!nativeMode || !tabId) return;

    let disposed = false;
    let resizeObs: ResizeObserver | null = null;
    let cleanupMoved: (() => void) | null = null;
    let cleanupResized: (() => void) | null = null;
    let scrollHandler: ((event: Event) => void) | null = null;
    let rafHandle: number | null = null;

    const scheduleSync = () => {
      if (disposed || rafHandle !== null) return;
      rafHandle = window.requestAnimationFrame(() => {
        rafHandle = null;
        void syncNativeBounds();
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
  }, [nativeMode, syncNativeBounds, tabId]);

  useEffect(() => {
    if (!nativeMode || !tabId) return;
    if (isStartPage) {
      void hideNativeWebviewTab(tabId);
      return;
    }
    const handleVisibility = () => {
      if (!document.hidden && !loading) {
        void showNativeWebviewTab(tabId, false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [isStartPage, loading, nativeMode, tabId]);

  useEffect(() => {
    if (!nativeMode || !tabId) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<{ tabId: string }>("r0nix://webview-pdf-link", (event) => {
      if (event.payload?.tabId === tabId) beginLoading(30_000);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [beginLoading, nativeMode, tabId]);

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

  const navigateTo = (raw: string, options?: { recordHistory?: boolean }) => {
    const recordHistory = options?.recordHistory !== false;
    if (raw === START_PAGE_URL) {
      selfNavigatedUrlRef.current = START_PAGE_URL;
      setUrl(START_PAGE_URL);
      setInputUrl("");
      endLoadingNow();
      onUrlChange?.(START_PAGE_URL);
      if (recordHistory) {
        setHistoryEntries((previous) => {
          const next = [...previous.slice(0, historyIndex + 1), START_PAGE_URL];
          setHistoryIndex(next.length - 1);
          return next;
        });
      }
      if (nativeMode) {
        void hideNativeWebviewTab(tabId);
      }
      return;
    }

    const normalized = normalizeUrl(raw);
    if (!normalized) return;

    // A direct PDF address must never be handed to the native WebView first.
    // WKWebView can briefly create a blank document for PDF navigation before
    // the download callback arrives. Route explicit PDF navigations through
    // the same guarded download/open path used by the PDF menu instead.
    if (looksLikePdfUrl(normalized) && onOpenPdfInApp) {
      setInputUrl(normalized);
      // Hide the native surface before starting the guarded download path.
      // Otherwise the old page can briefly expose a blank PDF document while
      // the app downloads and opens the file.
      if (nativeMode) {
        void hideNativeWebviewTab(tabId);
      }
      beginLoading(30_000);
      void Promise.resolve(onOpenPdfInApp(normalized)).finally(endLoadingNow);
      return;
    }

    selfNavigatedUrlRef.current = normalized;
    setUrl(normalized);
    setInputUrl(normalized);
    if (recordHistory) {
      setHistoryEntries((previous) => {
        const current = previous[historyIndex];
        if (current === normalized) return previous;
        const next = [...previous.slice(0, historyIndex + 1), normalized];
        setHistoryIndex(next.length - 1);
        return next;
      });
    }
    beginLoading(9000);
    onUrlChange?.(normalized);
    if (nativeMode) {
      setNativeReloadToken((value) => value + 1);
      return;
    }
    setReloadToken((value) => value + 1);
  };

  const openExternal = () => {
    if (!currentUrl) return;
    const normalized = normalizeHttpUrl(currentUrl);
    if (!normalized) {
      showMessage(t.nativeNavigationFailed);
      return;
    }
    if (onOpenExternal) {
      onOpenExternal(normalized);
      return;
    }
    window.open(normalized, "_blank", "noopener,noreferrer");
  };

  const navigateBack = () => {
    if (historyIndex > 0) {
      const target = historyEntries[historyIndex - 1];
      setHistoryIndex((value) => Math.max(0, value - 1));
      navigateTo(target, { recordHistory: false });
      return;
    }
    if (nativeMode) {
      beginLoading(3000);
      void navigateNativeWebviewTabHistory(tabId, "back")
        .catch((error) => showMessage(`${t.nativeNavigationFailed}: ${String(error)}`))
        .finally(() => endLoadingNow());
      return;
    }
    try {
      iframeRef.current?.contentWindow?.history.back();
    } catch {
      // ignore cross-origin history errors
    }
  };

  const navigateForward = () => {
    if (historyIndex < historyEntries.length - 1) {
      const target = historyEntries[historyIndex + 1];
      setHistoryIndex((value) => Math.min(historyEntries.length - 1, value + 1));
      navigateTo(target, { recordHistory: false });
      return;
    }
    if (nativeMode) {
      beginLoading(3000);
      void navigateNativeWebviewTabHistory(tabId, "forward")
        .catch((error) => showMessage(`${t.nativeNavigationFailed}: ${String(error)}`))
        .finally(() => endLoadingNow());
      return;
    }
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

  const handleOpenPdfInApp = async () => {
    if (!pdfLink) {
      showMessage(t.noPdfDetected);
      return;
    }
    setMenuOpen(false);
    beginLoading(30_000);
    try {
      await onOpenPdfInApp?.(pdfLink);
    } finally {
      endLoadingNow();
    }
  };

  const keepNativeVisible = () => {
    if (!nativeMode || isStartPage || loading) return;
    void showNativeWebviewTab(tabId, false);
  };

  const handleFocusNative = () => {
    if (!nativeMode || isStartPage) return;
    void showNativeWebviewTab(tabId, true);
    showMessage(t.nativeFocused);
    setMenuOpen(false);
  };

  const navButtonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-[var(--reader-accent-soft)] hover:text-[var(--reader-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--reader-accent)]/30 disabled:opacity-40";

  return (
    <div
      className="flex h-full flex-col bg-surface-app text-content-primary"
      onMouseDownCapture={keepNativeVisible}
      onPointerDownCapture={keepNativeVisible}
    >
      <div className="z-10 shrink-0 border-b border-border-subtle bg-surface-panel/95 px-3 py-2 shadow-sm backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button className={navButtonClass} title={t.navBack} aria-label={t.navBack} onClick={navigateBack} disabled={historyIndex === 0 && !nativeMode}>
              <ArrowLeft size={16} />
            </button>
            <button className={navButtonClass} title={t.navForward} aria-label={t.navForward} onClick={navigateForward} disabled={historyIndex >= historyEntries.length - 1 && !nativeMode}>
              <ArrowRight size={16} />
            </button>
            <button
              className={navButtonClass}
              onClick={() => {
                if (isStartPage) {
                  endLoadingNow();
                  return;
                }
                if (nativeMode) {
                  beginLoading(6000);
                  lastNavRef.current = "";
                  setNativeReloadToken((value) => value + 1);
                  return;
                }
                beginLoading(9000);
                setReloadToken((value) => value + 1);
              }}
              title={t.refresh}
              aria-label={t.refresh}
            >
              <RotateCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
            <button className={navButtonClass} onClick={() => navigateTo(START_PAGE_URL)} title={t.home} aria-label={t.home}>
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
            <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-muted">
              <Lock size={14} />
            </div>
            <input
              type="text"
              value={inputUrl}
              onChange={(event) => setInputUrl(event.target.value)}
              placeholder={t.addressPlaceholder}
              className="w-full rounded-xl border border-border-subtle bg-surface-sunken py-2 pl-9 pr-10 text-sm text-content-primary transition-all placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-[var(--reader-accent)]"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-content-muted transition-colors"
              title={bookmarked ? t.bookmarkRemove : t.bookmarkAdd}
              aria-label={bookmarked ? t.bookmarkRemove : t.bookmarkAdd}
              onClick={toggleBookmark}
              style={{ color: bookmarked ? "var(--reader-accent)" : undefined }}
            >
              <Star size={16} fill={bookmarked ? "currentColor" : "none"} />
            </button>
          </form>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-panel px-2.5 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-hover"
              onClick={() => void handleOpenPdfInApp()}
              title={looksLikePdfUrl(pdfLink) ? t.openPdfInAppHintDetected : t.openPdfInAppHintFallback}
              aria-label={t.openPdfInApp}
            >
              <FileText size={14} />
              <span className="hidden xl:inline">{t.openPdfInApp}</span>
            </button>

            <button className={navButtonClass} onClick={openExternal} title={t.openExternal} aria-label={t.openExternal}>
              <ExternalLink size={16} />
            </button>

            <button
              className={navButtonClass}
              onClick={() => {
                void handleDownload(looksLikePdfUrl(pdfLink));
              }}
              title={t.download}
              aria-label={t.download}
              disabled={actionBusy}
            >
              {actionBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            </button>

            <div className="relative z-50" ref={menuRef}>
              <button className={navButtonClass} title={t.more} aria-label={t.more} onClick={() => setMenuOpen((value) => !value)}>
                <MoreVertical size={16} />
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-10 z-[90] w-64 rounded-2xl border border-border-subtle bg-surface-panel p-2 shadow-xl" onPointerDown={(event) => event.stopPropagation()}>
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
      </div>

      {showIframeCompatibilityNotice ? (
        <div className="mx-4 mt-3 rounded-2xl border border-border-subtle bg-surface-panel px-4 py-3 text-xs text-content-secondary shadow-sm">
          {t.iframeNotice}
        </div>
      ) : null}

      <div
        ref={anchorRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-panel"
        onMouseEnter={() => {
          if (!nativeMode || isStartPage || loading) return;
          void showNativeWebviewTab(tabId, false);
        }}
        onMouseDown={() => {
          if (!nativeMode || isStartPage || loading) return;
          void showNativeWebviewTab(tabId, true);
        }}
      >
        {loading ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-app/80 text-sm text-content-muted">
            <div className="web-loading-overlay" role="status" aria-label={`${t.loadingPage} ${url || "page"}`}>
              <div className="loader" aria-hidden="true">
              </div>
              <span className="sr-only">{t.loadingPage} {url || "page"}</span>
            </div>
          </div>
        ) : null}

        {isStartPage ? (
          <StartPage quickLinks={quickLinks} onNavigate={navigateTo} language={language} />
        ) : nativeMode ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center text-content-disabled">
            <GlobeIcon className="mb-4 h-16 w-16 opacity-20" />
            <p className="text-xl font-semibold tracking-tight text-content-secondary">{t.nativeActiveTitle}</p>
            <p className="mt-2 max-w-lg text-sm text-content-muted">{t.nativeActiveDesc}</p>
            <p className="mt-3 text-xs font-mono text-content-muted">{url}</p>
          </div>
        ) : url ? (
          <iframe
            key={`${url}-${reloadToken}`}
            ref={iframeRef}
            src={url}
            className="absolute inset-0 h-full w-full border-0"
            title={url}
            onLoad={() => endLoadingNow()}
            onError={() => endLoadingNow()}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-content-disabled">
            <GlobeIcon className="mb-4 h-16 w-16 opacity-20" />
            <p className="text-xl font-semibold tracking-tight text-content-secondary">{t.emptyTitle}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuButton({ icon, label, onClick, disabled = false }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
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
