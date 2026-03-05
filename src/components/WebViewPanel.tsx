import { ArrowLeft, Download, ExternalLink, FileText, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLanguage, ImagePreviewItem } from "../App";
import { createDefaultQuickLinks, type QuickLinkItem } from "../services/userSettings";
import {
  canUseNativeWebview,
  createOrShowNativeWebviewTab,
  hideNativeWebviewTab,
  navigateNativeWebviewTab,
  showNativeWebviewTab,
  syncNativeWebviewTabBounds,
} from "../services/nativeWebview";
import "./WebViewPanel.css";

interface WebViewPanelProps {
  tabId?: string;
  url?: string;
  imagePreview?: ImagePreviewItem;
  defaultNewTabUrl?: string;
  quickLinks?: QuickLinkItem[];
  language: AppLanguage;
  pdfOpenMode: "direct" | "download_then_open";
  webPanelMode: "iframe" | "native_webview";
  canBackToPdf?: boolean;
  onBackToPdf?: () => void;
  onOpenLink: (url: string, options?: { forceExternal?: boolean }) => void;
  onNavigateTab?: (tabId: string, url: string) => void;
  onOpenPdfFromWeb: (url: string, mode?: "direct" | "download_then_open") => Promise<boolean>;
}

function normalizeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `https://${value}`;
}

function shortHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isPdfUrl(url: string) {
  return /\.pdf(?:$|\?|\#)/i.test(url);
}

function faviconUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(`${parsed.protocol}//${parsed.host}`)}&sz=64`;
  } catch {
    return "";
  }
}

const EMBED_BLOCKED_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "limestart.cn",
  "www.limestart.cn",
]);

function shouldOpenExternalForHost(url: string) {
  if (!url) return false;
  try {
    const host = new URL(url).host.toLowerCase();
    if (EMBED_BLOCKED_HOSTS.has(host)) return true;
    return host.endsWith(".google.com");
  } catch {
    return false;
  }
}

function WebViewPanel({
  tabId,
  url,
  imagePreview,
  defaultNewTabUrl,
  quickLinks,
  language,
  pdfOpenMode,
  webPanelMode,
  canBackToPdf,
  onBackToPdf,
  onOpenLink,
  onNavigateTab,
  onOpenPdfFromWeb,
}: WebViewPanelProps) {
  const nativeAvailable = canUseNativeWebview();
  const [input, setInput] = useState(url || "");
  const [currentUrl, setCurrentUrl] = useState(url || "");
  const [reloadSeed, setReloadSeed] = useState(0);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [embedBlocked, setEmbedBlocked] = useState(false);
  const [forceNativeMode, setForceNativeMode] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [nativeTransitionTick, setNativeTransitionTick] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [addressFocused, setAddressFocused] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nativeAnchorRef = useRef<HTMLDivElement | null>(null);
  const lastAutoHandledPdfRef = useRef("");
  const nativeNavRef = useRef("");
  const nativeBoundsSigRef = useRef("");

  const text =
    language === "zh"
      ? {
          placeholder: "输入网址后回车打开",
          open: "打开",
          refresh: "刷新",
          external: "浏览器打开",
          backPdf: "返回 PDF",
          openPdf: "内部打开 PDF",
          downloadPdf: "下载并打开",
          emptyTitle: "暂无网页标签页",
          emptyHint: "在这里输入地址、打开快捷站点，或在设置里配置默认新标签页网址。",
          quickTitle: "快捷站点",
          quickHint: "支持网站收藏和常用入口，点击即可在当前标签打开。",
          openDefault: "打开默认页",
          setDefaultHint: "例如：https://limestart.cn（青柠起始页）",
          quickFallback: "暂未配置快捷站点，请到设置中添加",
          pdfHandled: "已在应用内处理 PDF",
          pdfHandleFail: "处理 PDF 失败，建议外部打开",
          nativeWindowHint: "当前网页在原生窗口中打开（兼容性更好）",
          embedBlockedTitle: "This website blocks embedded access",
          embedBlockedHint: "The site disallows iframe/WebView embedding. Open it in your browser instead.",
          openExternalNow: "Open in browser",
          tryEmbed: "Try embed anyway",
          preview: "导出预览",
          previewHint: "滚轮缩放，验证 SVG 是否为真矢量",
        }
      : {
          placeholder: "Enter URL and press Enter",
          open: "Open",
          refresh: "Refresh",
          external: "Open in browser",
          backPdf: "Back to PDF",
          openPdf: "Open PDF in app",
          downloadPdf: "Download and open",
          emptyTitle: "No web tabs yet",
          emptyHint: "Type a URL, open quick sites, or set a default new tab URL in Settings.",
          quickTitle: "Quick links",
          quickHint: "Open common sites in this tab with one click.",
          openDefault: "Open default page",
          setDefaultHint: "Example: https://limestart.cn",
          quickFallback: "No quick links configured yet. Add them in Settings.",
          pdfHandled: "PDF opened in app",
          pdfHandleFail: "Failed to handle PDF, try opening externally",
          nativeWindowHint: "This page is open in a native window for better compatibility",
          embedBlockedTitle: "This website blocks embedded access",
          embedBlockedHint: "The site disallows iframe/WebView embedding. Open it in your browser instead.",
          openExternalNow: "Open in browser",
          tryEmbed: "Try embed anyway",
          preview: "Export Preview",
          previewHint: "Use wheel zoom to validate real SVG vector quality",
        };

  const visibleQuickLinks = useMemo(
    () =>
      (quickLinks && quickLinks.length > 0 ? quickLinks : createDefaultQuickLinks())
        .map((item) => ({ ...item, url: normalizeUrl(item.url) }))
        .filter((item) => Boolean(item.url))
        .slice(0, 30),
    [quickLinks]
  );

  const normalizedUrl = useMemo(() => normalizeUrl(url || ""), [url]);
  const normalizedCurrentUrl = useMemo(() => normalizeUrl(currentUrl || normalizedUrl), [currentUrl, normalizedUrl]);
  const currentIsPdf = useMemo(() => isPdfUrl(normalizedCurrentUrl), [normalizedCurrentUrl]);
  const normalizedDefaultUrl = useMemo(() => normalizeUrl(defaultNewTabUrl || ""), [defaultNewTabUrl]);
  const nativeMode = nativeAvailable && (webPanelMode === "native_webview" || forceNativeMode);
  const previewMode = Boolean(
    imagePreview &&
      normalizedUrl &&
      /^r0nix-preview:\/\/image\//i.test(normalizedUrl)
  );

  useEffect(() => {
    const blocked = shouldOpenExternalForHost(url || "");
    const forceNative = nativeAvailable && blocked;
    const effectiveNative = nativeAvailable && (webPanelMode === "native_webview" || forceNative);
    setForceNativeMode(forceNative);
    setInput(url || defaultNewTabUrl || "");
    setCurrentUrl(url || "");
    setEmbedBlocked(!effectiveNative && !previewMode && blocked);
    setHint("");
    setIsLoading(Boolean(url));
    nativeNavRef.current = "";
    setPreviewZoom(1);
  }, [defaultNewTabUrl, nativeAvailable, previewMode, url, webPanelMode]);

  useEffect(() => {
    if (!nativeMode || !tabId || previewMode) return;
    if (!normalizedCurrentUrl) {
      void hideNativeWebviewTab(tabId).catch(() => {
        // ignore hide errors when no native window exists
      });
      setIsLoading(false);
      return;
    }
    const cacheKey = `${tabId}|${normalizedCurrentUrl}`;
    if (nativeNavRef.current === cacheKey) return;
    nativeNavRef.current = cacheKey;
    setNativeTransitionTick((prev) => prev + 1);
    setIsLoading(true);
    void createOrShowNativeWebviewTab(tabId, normalizedCurrentUrl, shortHost(normalizedCurrentUrl), true).catch(() => {
      void navigateNativeWebviewTab(tabId, normalizedCurrentUrl).catch(() => {
        // ignore transient native navigation errors
      });
    });
  }, [nativeMode, normalizedCurrentUrl, previewMode, tabId]);

  useEffect(() => {
    if (!nativeMode) return;
    if (!normalizedCurrentUrl) return;
    if (previewMode) return;
    const timer = window.setTimeout(() => setIsLoading(false), 620);
    return () => window.clearTimeout(timer);
  }, [nativeMode, normalizedCurrentUrl, previewMode, reloadSeed]);

  useEffect(() => {
    if (previewMode || !normalizedUrl) {
      setIsLoading(false);
    }
  }, [previewMode, normalizedUrl]);

  useEffect(() => {
    if (embedBlocked) {
      setIsLoading(false);
    }
  }, [embedBlocked]);

  useEffect(() => {
    if (!nativeMode || !tabId || !normalizedCurrentUrl || previewMode) return;
    let disposed = false;
    let resizeObs: ResizeObserver | null = null;
    let followRaf: number | null = null;
    let cleanupMoved: (() => void) | null = null;
    let cleanupResized: (() => void) | null = null;
    let scrollHandler: ((event: Event) => void) | null = null;

    const syncBounds = async () => {
      if (disposed) return;
      const anchor = nativeAnchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 120 || height < 120) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow();
      const [pos, scaleFactor] = await Promise.all([current.innerPosition(), current.scaleFactor()]);
      const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
      const x = Math.round(pos.x / safeScale + rect.left);
      const y = Math.round(pos.y / safeScale + rect.top);
      const sig = `${x}|${y}|${width}|${height}`;
      if (nativeBoundsSigRef.current === sig) return;
      nativeBoundsSigRef.current = sig;
      await syncNativeWebviewTabBounds(tabId, x, y, width, height);
    };

    const startFollowLoop = () => {
      if (disposed) return;
      if (followRaf !== null) return;
      const tick = () => {
        if (disposed) return;
        void syncBounds();
        followRaf = window.requestAnimationFrame(tick);
      };
      followRaf = window.requestAnimationFrame(tick);
    };

    const setup = async () => {
      const anchor = nativeAnchorRef.current;
      if (!anchor) return;
      resizeObs = new ResizeObserver(() => {
        void syncBounds();
      });
      resizeObs.observe(anchor);
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow();
      cleanupMoved = await current.onMoved(() => {
        void syncBounds();
      });
      cleanupResized = await current.onResized(() => {
        void syncBounds();
      });
      scrollHandler = () => {
        void syncBounds();
      };
      window.addEventListener("scroll", scrollHandler, true);
      void syncBounds();
      startFollowLoop();
    };

    void setup();

    return () => {
      disposed = true;
      if (followRaf !== null) {
        window.cancelAnimationFrame(followRaf);
        followRaf = null;
      }
      if (resizeObs) {
        resizeObs.disconnect();
      }
      cleanupMoved?.();
      cleanupResized?.();
      if (scrollHandler) {
        window.removeEventListener("scroll", scrollHandler, true);
        scrollHandler = null;
      }
      nativeBoundsSigRef.current = "";
    };
  }, [canBackToPdf, nativeMode, normalizedCurrentUrl, previewMode, tabId]);

  useEffect(() => {
    if (!nativeMode || !tabId) return;
    return () => {
      void hideNativeWebviewTab(tabId).catch(() => {
        // ignore hide errors on unmount
      });
    };
  }, [nativeMode, tabId]);

  useEffect(() => {
    if (!nativeMode || !tabId || previewMode) return;
    const onVisibility = () => {
      if (document.hidden) {
        void hideNativeWebviewTab(tabId);
        return;
      }
      void showNativeWebviewTab(tabId, false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [nativeMode, previewMode, tabId]);

  useEffect(() => {
    if (!nativeMode || !tabId || previewMode) return;
    let restoreTimer = 0;
    const scheduleRestore = () => {
      if (restoreTimer) window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => {
        void showNativeWebviewTab(tabId, false);
      }, 140);
    };
    const events: Array<keyof WindowEventMap> = ["pointerup", "mouseup", "touchend", "keyup"];
    for (const eventName of events) {
      window.addEventListener(eventName, scheduleRestore, true);
    }
    scheduleRestore();
    return () => {
      if (restoreTimer) window.clearTimeout(restoreTimer);
      for (const eventName of events) {
        window.removeEventListener(eventName, scheduleRestore, true);
      }
    };
  }, [nativeMode, previewMode, tabId]);

  useEffect(() => {
    if (!previewMode) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        event.preventDefault();
      }
      setPreviewZoom((prev) => {
        const factor = event.deltaY < 0 ? 1.08 : 0.92;
        return Math.max(0.2, Math.min(8, Number((prev * factor).toFixed(3))));
      });
    };
    const node = nativeAnchorRef.current;
    if (!node) return;
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel as EventListener);
    };
  }, [previewMode]);

  const openInputUrl = () => {
    const next = normalizeUrl(input);
    if (!next) return;
    setIsLoading(true);
    const blocked = shouldOpenExternalForHost(next);
    const forceNative = nativeAvailable && blocked;
    const effectiveNative = nativeAvailable && (webPanelMode === "native_webview" || forceNative);
    setForceNativeMode(forceNative);
    setEmbedBlocked(!effectiveNative && blocked);
    setCurrentUrl(next);
    setInput(next);
    if (tabId && onNavigateTab) {
      onNavigateTab(tabId, next);
      return;
    }
    onOpenLink(next);
  };

  const openInCurrentTab = (nextUrl: string) => {
    const next = normalizeUrl(nextUrl);
    if (!next) return;
    setIsLoading(true);
    const blocked = shouldOpenExternalForHost(next);
    const forceNative = nativeAvailable && blocked;
    const effectiveNative = nativeAvailable && (webPanelMode === "native_webview" || forceNative);
    setForceNativeMode(forceNative);
    setEmbedBlocked(!effectiveNative && blocked);
    setInput(next);
    setCurrentUrl(next);
    if (tabId && onNavigateTab) {
      onNavigateTab(tabId, next);
      return;
    }
    onOpenLink(next);
  };

  const handlePdf = async (mode: "direct" | "download_then_open") => {
    if (!normalizedCurrentUrl || !isPdfUrl(normalizedCurrentUrl)) return;
    setPdfBusy(true);
    const ok = await onOpenPdfFromWeb(normalizedCurrentUrl, mode);
    setHint(ok ? text.pdfHandled : text.pdfHandleFail);
    setPdfBusy(false);
  };

  return (
    <section className="web-panel">
      <header className="web-panel-toolbar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={text.placeholder}
          className={addressFocused ? "address-focused" : ""}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openInputUrl();
          }}
        />
        <button type="button" onClick={openInputUrl}>
          {text.open}
        </button>
        <button
          type="button"
          className="icon-btn"
          title={text.refresh}
          onClick={() => {
            setIsLoading(true);
            if (nativeMode) {
              if (normalizedCurrentUrl && tabId) {
                void navigateNativeWebviewTab(tabId, normalizedCurrentUrl);
              }
              return;
            }
            setReloadSeed((v) => v + 1);
          }}
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={text.openPdf}
          onClick={() => void handlePdf("direct")}
          disabled={!currentIsPdf || pdfBusy}
        >
          <FileText size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={text.downloadPdf}
          onClick={() => void handlePdf("download_then_open")}
          disabled={!currentIsPdf || pdfBusy}
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={text.external}
          onClick={() => {
            if (normalizedCurrentUrl) onOpenLink(normalizedCurrentUrl, { forceExternal: true });
          }}
          disabled={!normalizedCurrentUrl}
        >
          <ExternalLink size={14} />
        </button>
        {canBackToPdf ? (
          <button
            type="button"
            className="web-back-btn"
            title={text.backPdf}
            onClick={() => onBackToPdf?.()}
          >
            <ArrowLeft size={14} />
            <span>{text.backPdf}</span>
          </button>
        ) : null}
        <div className={`web-panel-loading ${isLoading ? "active" : ""}`} aria-hidden={!isLoading} />
      </header>

      {previewMode && imagePreview ? (
        <div className="web-panel-image-preview">
          <div className="web-panel-host">
            <span>{text.preview}</span>
            <span className="web-panel-hint">{text.previewHint}</span>
          </div>
          <div className="web-preview-toolbar">
            <span>{imagePreview.title}</span>
            <span>{imagePreview.mimeType}</span>
            <span>{Math.round(previewZoom * 100)}%</span>
            {imagePreview.vectorGrade ? (
              <span>{`SVG ${imagePreview.vectorGrade} · ${(imagePreview.vectorRatio || 0) * 100}%`}</span>
            ) : null}
            <button type="button" className="icon-btn" onClick={() => setPreviewZoom((z) => Math.max(0.2, Number((z / 1.15).toFixed(3))))}>
              <ZoomOut size={14} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setPreviewZoom((z) => Math.min(8, Number((z * 1.15).toFixed(3))))}>
              <ZoomIn size={14} />
            </button>
          </div>
          <div className="web-preview-stage">
            <div
              className="web-preview-canvas"
              style={{ transform: `scale(${previewZoom})` }}
            >
              <img src={imagePreview.dataUrl} alt={imagePreview.title} draggable={false} />
            </div>
          </div>
        </div>
      ) : normalizedUrl ? (
        <div
          className="web-panel-frame-wrap"
          ref={nativeAnchorRef}
          onMouseEnter={() => {
            if (!nativeMode || !tabId) return;
            void showNativeWebviewTab(tabId, false);
          }}
          onMouseDown={() => {
            if (!nativeMode || !tabId) return;
            void showNativeWebviewTab(tabId, true);
          }}
        >
          {hint ? (
            <div className="web-panel-host">
              <span className="web-panel-hint">{hint}</span>
            </div>
          ) : null}
          {isLoading ? (
            <div className="web-loading-overlay" aria-hidden={!isLoading}>
              <div className="loader" role="status" aria-label="loading">
                <div className="blackhole">
                  <div className="blackhole-circle" />
                  <div className="blackhole-disc" />
                </div>
              </div>
            </div>
          ) : null}
          {nativeMode ? (
            <div className="web-panel-native-placeholder">
              <div key={nativeTransitionTick} className="web-native-switch-fx" />
              <h4>{shortHost(normalizedCurrentUrl)}</h4>
              <p>{text.nativeWindowHint}</p>
              <div className="web-panel-blocked-actions">
                <button
                  type="button"
                  onClick={() => onOpenLink(normalizedCurrentUrl, { forceExternal: true })}
                >
                  {text.openExternalNow}
                </button>
              </div>
            </div>
          ) : embedBlocked ? (
            <div className="web-panel-blocked">
              <h4>{text.embedBlockedTitle}</h4>
              <p>{text.embedBlockedHint}</p>
              <div className="web-panel-blocked-actions">
                <button
                  type="button"
                  onClick={() => {
                    if (!normalizedCurrentUrl) return;
                    onOpenLink(normalizedCurrentUrl, { forceExternal: true });
                  }}
                >
                  {text.openExternalNow}
                </button>
                <button type="button" className="ghost" onClick={() => setEmbedBlocked(false)}>
                  {text.tryEmbed}
                </button>
              </div>
            </div>
          ) : (
            <iframe
              key={`${normalizedUrl}-${reloadSeed}`}
              ref={iframeRef}
              src={normalizedUrl}
              className="web-panel-frame"
              title={normalizedUrl}
              onLoad={() => {
                setIsLoading(false);
                const frame = iframeRef.current;
                if (!frame) return;
                let next = frame.src || normalizedUrl;
                try {
                  next = frame.contentWindow?.location?.href || next;
                } catch {
                  // keep frame.src for cross-origin pages
                }
                setCurrentUrl(next);
                if (tabId && onNavigateTab && next) {
                  onNavigateTab(tabId, next);
                }
                if (!isPdfUrl(next)) return;
                if (pdfOpenMode !== "direct") return;
                if (lastAutoHandledPdfRef.current === next) return;
                lastAutoHandledPdfRef.current = next;
                void handlePdf("direct");
              }}
              onError={() => setIsLoading(false)}
            />
          )}
        </div>
      ) : (
        <div className="web-panel-empty">
          <div className="web-newtab-card">
            <h3>{text.emptyTitle}</h3>
            <p>{text.emptyHint}</p>
            {normalizedDefaultUrl ? (
              <button type="button" className="web-newtab-default-btn" onClick={() => openInCurrentTab(normalizedDefaultUrl)}>
                {text.openDefault}
              </button>
            ) : (
              <div className="web-newtab-default-hint">{text.setDefaultHint}</div>
            )}
          </div>
          <section className="web-quick-section">
            <div className="web-quick-head">
              <h4>{text.quickTitle}</h4>
              <span>{text.quickHint}</span>
            </div>
            <div className="web-quick-grid">
              {visibleQuickLinks.map((item) => (
                <button key={item.id} type="button" className="web-quick-item" onClick={() => openInCurrentTab(item.url)}>
                  {faviconUrl(item.url) ? (
                    <img src={faviconUrl(item.url)} alt="" width={20} height={20} />
                  ) : (
                    <ExternalLink size={16} />
                  )}
                  <span className="web-quick-title">{item.title}</span>
                  <span className="web-quick-url">{item.url.replace(/^https?:\/\//i, "")}</span>
                </button>
              ))}
              {visibleQuickLinks.length === 0 && <div className="web-quick-empty">{text.quickFallback}</div>}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

export default WebViewPanel;
