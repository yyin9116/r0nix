import {
  ChevronDown,
  ChevronRight,
  Compass,
  FileText,
  Files,
  FolderOpen,
  History,
  Library,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "../icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLanguage, FavoriteItem, FileItem, MainPanel, RecentFileItem, WebTabGroup, WebTabItem } from "../App";
import type { LibraryCollection } from "./LibraryPanel";
import "./Sidebar.css";

interface SidebarProps {
  files: FileItem[];
  activeFileId: string;
  webTabs: WebTabItem[];
  webTabGroups: WebTabGroup[];
  newWebTabId: string;
  activeWebTabId: string;
  language: AppLanguage;
  links: string[];
  linkMeta: Record<string, string>;
  recentFiles: RecentFileItem[];
  favorites: FavoriteItem[];
  libraryCollections: LibraryCollection[];
  mainPanel: MainPanel;
  settingsTabOpen: boolean;
  libraryTabOpen: boolean;
  onFileSelect: (fileId: string) => void;
  onWebTabSelect: (tabId: string) => void;
  onCreateWebTab: () => void;
  onOpenFile: () => void;
  onOpenHomeTab: () => void;
  onOpenRecentFile: (path: string) => void;
  onContinueRecentSession?: (
    path: string,
    session: {
      endPage: number;
      endZoom?: number;
      endAutoFit?: boolean;
      endScrollTopRatio?: number;
    }
  ) => void;
  onRelocateRecentFile: (path: string) => void;
  onOpenLink: (url: string, options?: { forceExternal?: boolean }) => void;
  onOpenSettingsTab: () => void;
  onOpenLibraryTab: () => void;
  onCloseFileTab: (fileId: string) => void;
  onReorderFileTab: (sourceId: string, targetId: string, position?: DropPosition) => void;
  onCloseWebTab: (tabId: string) => void;
  onToggleWebTabPinned: (tabId: string) => void;
  onAddWebTabFavorite: (tabId: string) => void;
  onTogglePdfFavorite: (path: string, name: string) => void;
  onToggleWebFavorite: (url: string, title?: string) => void;
  onRemoveRecentResource: (path: string) => void;
  onClearRecentResources: () => void;
  onRemoveLinkResource: (url: string) => void;
  onClearLinkResources: () => void;
  onAddFileToLibrary: (path: string, collectionName?: string) => void;
  onMoveWebTabToGroup: (tabId: string, groupId: string) => void;
  onReorderWebTab: (
    sourceId: string,
    targetId: string,
    groupId?: string,
    pinned?: boolean,
    position?: DropPosition
  ) => void;
  onCreateWebTabGroup: (name?: string, moveTabId?: string) => string;
  onToggleWebTabGroupCollapsed: (groupId: string) => void;
  onCloseSettingsTab: () => void;
  onCloseLibraryTab: () => void;
}

type MenuTarget =
  | { kind: "file"; id: string; x: number; y: number }
  | { kind: "web"; id: string; pinned: boolean; x: number; y: number }
  | {
      kind: "resource_pdf";
      path: string;
      name: string;
      missing: boolean;
      session?: {
        endPage: number;
        endZoom?: number;
        endAutoFit?: boolean;
        endScrollTopRatio?: number;
      };
      x: number;
      y: number;
    }
  | { kind: "resource_web"; url: string; x: number; y: number };
type DropPosition = "before" | "after";

const RAIL_WIDTH = 52;
const PANEL_WIDTH = 320;

function getInitialCollapsed() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("pdf_reader_sidebar_collapsed") === "1";
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}

function canonicalizeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function sameUrl(a: string, b: string) {
  return canonicalizeUrl(a).toLowerCase() === canonicalizeUrl(b).toLowerCase();
}

function compactPath(path: string, title = "") {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] || path;
  if (title && fileName.trim().toLowerCase() === title.trim().toLowerCase()) {
    if (parts.length <= 1) return "";
    const parent = parts[parts.length - 2];
    return `.../${parent}/${fileName}`;
  }
  if (normalized.length > 46) return `...${normalized.slice(-43)}`;
  return normalized;
}

function ageBucket(dateText?: string) {
  if (!dateText) return "recent";
  const time = Date.parse(dateText);
  if (!Number.isFinite(time)) return "recent";
  const diffDays = (Date.now() - time) / (1000 * 60 * 60 * 24);
  if (diffDays <= 7) return "recent";
  if (diffDays <= 30) return "monthly";
  return "archive";
}

function getResourceSectionDefaultState() {
  if (typeof window === "undefined") {
    return { pdf: false, web: false };
  }
  const raw = window.localStorage.getItem("pdf_reader_resource_section_state");
  if (!raw) return { pdf: false, web: false };
  try {
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return {
      pdf: Boolean(parsed.pdf),
      web: Boolean(parsed.web),
    };
  } catch {
    return { pdf: false, web: false };
  }
}

function getResourceRootCollapsedDefault() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("pdf_reader_resource_root_collapsed") === "1";
}

function getFaviconCandidates(url: string) {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    return [
      `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(origin)}&sz=64`,
      `${origin}/favicon.ico`,
    ];
  } catch {
    return [];
  }
}

function getDropPosition(clientY: number, rect: DOMRect): DropPosition {
  const middle = rect.top + rect.height / 2;
  return clientY > middle ? "after" : "before";
}

async function askConfirm(message: string) {
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
  if (isTauri) {
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      return await confirm(message, { title: "r0nix" });
    } catch {
      return window.confirm(message);
    }
  }
  return window.confirm(message);
}

function TabFavicon({ url, size = 14, className = "edge-favicon" }: { url: string; size?: number; className?: string }) {
  const candidates = useMemo(() => getFaviconCandidates(url), [url]);
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
  }, [url]);

  if (!url || candidates.length === 0 || candidateIndex >= candidates.length) {
    return <Search size={size} />;
  }

  return (
    <img
      src={candidates[candidateIndex]}
      alt=""
      width={size}
      height={size}
      className={className}
      referrerPolicy="no-referrer"
      onError={() => setCandidateIndex((prev) => prev + 1)}
    />
  );
}

function Sidebar({
  files,
  activeFileId,
  webTabs,
  webTabGroups,
  newWebTabId,
  activeWebTabId,
  language,
  links,
  linkMeta,
  recentFiles,
  favorites,
  libraryCollections,
  mainPanel,
  settingsTabOpen,
  libraryTabOpen,
  onFileSelect,
  onWebTabSelect,
  onCreateWebTab,
  onOpenFile,
  onOpenHomeTab,
  onOpenRecentFile,
  onContinueRecentSession,
  onRelocateRecentFile,
  onOpenLink,
  onOpenSettingsTab,
  onOpenLibraryTab,
  onCloseFileTab,
  onReorderFileTab,
  onCloseWebTab,
  onToggleWebTabPinned,
  onAddWebTabFavorite,
  onTogglePdfFavorite,
  onToggleWebFavorite,
  onRemoveRecentResource,
  onClearRecentResources,
  onRemoveLinkResource,
  onClearLinkResources,
  onAddFileToLibrary,
  onMoveWebTabToGroup,
  onReorderWebTab,
  onCreateWebTabGroup,
  onToggleWebTabGroupCollapsed,
  onCloseSettingsTab,
  onCloseLibraryTab,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [dragFileId, setDragFileId] = useState("");
  const [dropFileId, setDropFileId] = useState("");
  const [dropFilePosition, setDropFilePosition] = useState<DropPosition>("before");
  const [dragWebTabId, setDragWebTabId] = useState("");
  const [dropWebTabId, setDropWebTabId] = useState("");
  const [dropWebPosition, setDropWebPosition] = useState<DropPosition>("before");
  const [plusPulse, setPlusPulse] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [resourceSectionOpen, setResourceSectionOpen] = useState(getResourceSectionDefaultState);
  const [resourceRootCollapsed, setResourceRootCollapsed] = useState(getResourceRootCollapsedDefault);
  const [resourceView, setResourceView] = useState<"resources" | "closed" | "history">("resources");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeMenuTimerRef = useRef<number | null>(null);

  const text =
    language === "zh"
      ? {
          workspace: "工作区",
          openTabs: "打开的标签",
          closeAllTabs: "关闭全部",
          resources: "资源",
          collapseResources: "折叠资源区",
          expandResources: "展开资源区",
          pdfResources: "PDF",
          webResources: "网页",
          noPdfResources: "暂无 PDF 资源",
          noWebResources: "暂无网页资源",
          closedTabs: "最近关闭",
          historyTabs: "历史记录",
          currentResources: "当前资源",
          noClosedTabs: "暂无最近关闭的标签",
          noHistoryTabs: "暂无历史记录",
          confirmClearPdf: "确认清空所有 PDF 资源记录？",
          confirmClearWeb: "确认清空所有网页资源记录？",
          recentGroup: "最近 7 天",
          monthlyGroup: "近 30 天",
          archiveGroup: "归档",
          newTab: "新建网页标签页",
          openFile: "打开 PDF",
          startTab: "开始页",
          startHint: "主页与快捷操作",
          open: "打开",
          collapse: "收起侧栏",
          expand: "展开侧栏",
          empty: "暂无标签",
          settings: "设置",
          library: "资料库",
          file: "文件",
          link: "链接",
          webPinned: "已固定网页",
          moveToGroup: "移动到分组",
          createGroup: "新建分组",
          closeTab: "关闭标签页",
          closeSettings: "关闭设置页",
          closeLibrary: "关闭资料库页",
          closeFile: "关闭文件",
          closeWeb: "关闭网页",
          pinWeb: "固定网页",
          unpinWeb: "取消固定",
          addFavorite: "加入收藏",
          removeFavorite: "取消收藏",
          addLibrary: "加入资料库",
          libraryHint: "文献管理与导出",
          resume: "继续阅读",
          remove: "移除",
          clearAll: "全部关闭",
          openExternal: "在浏览器打开",
          pathMissing: "路径失效",
          locateFile: "重新定位文件",
          snapshot: (page: number, total: number, zoom: number) => `第 ${page}/${total} 页 · ${zoom}%`,
        }
      : {
          workspace: "Workspace",
          openTabs: "Open Tabs",
          closeAllTabs: "Close all",
          resources: "Resources",
          collapseResources: "Collapse resources",
          expandResources: "Expand resources",
          pdfResources: "PDF",
          webResources: "Web",
          noPdfResources: "No PDF resources yet",
          noWebResources: "No web resources yet",
          closedTabs: "Recently closed",
          historyTabs: "History",
          currentResources: "Current resources",
          noClosedTabs: "No recently closed tabs",
          noHistoryTabs: "No history yet",
          confirmClearPdf: "Clear all PDF resources?",
          confirmClearWeb: "Clear all web resources?",
          recentGroup: "Last 7 days",
          monthlyGroup: "Last 30 days",
          archiveGroup: "Archive",
          newTab: "New web tab",
          openFile: "Open PDF",
          startTab: "Start Page",
          startHint: "Home and quick actions",
          open: "Open",
          collapse: "Collapse sidebar",
          expand: "Expand sidebar",
          empty: "No tabs",
          settings: "Settings",
          library: "Library",
          file: "File",
          link: "Link",
          webPinned: "Pinned Web",
          moveToGroup: "Move to group",
          createGroup: "Create group",
          closeTab: "Close tab",
          closeSettings: "Close settings",
          closeLibrary: "Close library",
          closeFile: "Close file",
          closeWeb: "Close web tab",
          pinWeb: "Pin tab",
          unpinWeb: "Unpin tab",
          addFavorite: "Add to favorites",
          removeFavorite: "Remove favorite",
          addLibrary: "Add to library",
          libraryHint: "Manage docs and export",
          resume: "Resume",
          remove: "Remove",
          clearAll: "Close all",
          openExternal: "Open in browser",
          pathMissing: "Missing",
          locateFile: "Locate file",
          snapshot: (page: number, total: number, zoom: number) => `p${page}/${total} · ${zoom}%`,
        };

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("pdf_reader_sidebar_collapsed", collapsed ? "1" : "0");
    }
  }, [collapsed]);

  useEffect(() => {
    const closeByEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", closeByEsc, true);
    return () => {
      window.removeEventListener("keydown", closeByEsc, true);
    };
  }, []);

  useEffect(() => {
    if (!plusPulse) return;
    const timer = window.setTimeout(() => setPlusPulse(false), 280);
    return () => window.clearTimeout(timer);
  }, [plusPulse]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("pdf_reader_resource_section_state", JSON.stringify(resourceSectionOpen));
  }, [resourceSectionOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("pdf_reader_resource_root_collapsed", resourceRootCollapsed ? "1" : "0");
  }, [resourceRootCollapsed]);

  useEffect(() => {
    return () => {
      if (closeMenuTimerRef.current !== null) {
        window.clearTimeout(closeMenuTimerRef.current);
        closeMenuTimerRef.current = null;
      }
    };
  }, []);

  const openContextMenu = (payload: MenuTarget) => {
    if (closeMenuTimerRef.current !== null) {
      window.clearTimeout(closeMenuTimerRef.current);
      closeMenuTimerRef.current = null;
    }
    setMenuClosing(false);
    setMenu(payload);
  };

  const closeContextMenu = (immediate = false) => {
    if (closeMenuTimerRef.current !== null) {
      window.clearTimeout(closeMenuTimerRef.current);
      closeMenuTimerRef.current = null;
    }
    if (immediate || !menu) {
      setMenuClosing(false);
      setMenu(null);
      return;
    }
    setMenuClosing(true);
    closeMenuTimerRef.current = window.setTimeout(() => {
      setMenu(null);
      setMenuClosing(false);
      closeMenuTimerRef.current = null;
    }, 110);
  };

  useEffect(() => {
    if (!menu) return;
    const closeMenu = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      closeContextMenu();
    };
    const closeNow = () => closeContextMenu();
    window.addEventListener("pointerdown", closeMenu, true);
    window.addEventListener("wheel", closeNow, { passive: true, capture: true });
    window.addEventListener("resize", closeNow, true);
    window.addEventListener("blur", closeNow);
    return () => {
      window.removeEventListener("pointerdown", closeMenu, true);
      window.removeEventListener("wheel", closeNow, true);
      window.removeEventListener("resize", closeNow, true);
      window.removeEventListener("blur", closeNow);
    };
  }, [menu]);

  const pinnedTabs = useMemo(() => webTabs.filter((tab) => tab.pinned), [webTabs]);
  const groupedTabs = useMemo(() => {
    const grouped = new Map<string, WebTabItem[]>();
    for (const group of webTabGroups) grouped.set(group.id, []);
    for (const tab of webTabs) {
      if (tab.pinned) continue;
      const target = grouped.get(tab.groupId) || grouped.get(webTabGroups[0]?.id || "");
      if (target) target.push(tab);
    }
    return grouped;
  }, [webTabGroups, webTabs]);

  const historyPdfItems = useMemo(
    () =>
      recentFiles.filter((item) =>
        ageBucket(item.snapshot?.capturedAt || item.lastOpenedAt) === "archive"
      ),
    [recentFiles]
  );
  const historyWebItems = useMemo(
    () => links.filter((url) => ageBucket(linkMeta[url]) === "archive"),
    [linkMeta, links]
  );
  const openPdfPathSet = useMemo(
    () =>
      new Set(
        files
          .map((item) => item.path.trim().toLowerCase())
          .filter((item) => item.length > 0)
      ),
    [files]
  );
  const openWebUrls = useMemo(
    () => webTabs.map((tab) => tab.url),
    [webTabs]
  );
  const closedPdfItems = useMemo(
    () => recentFiles.filter((item) => !openPdfPathSet.has(item.path.trim().toLowerCase())),
    [openPdfPathSet, recentFiles]
  );
  const closedWebItems = useMemo(
    () => links.filter((url) => !openWebUrls.some((opened) => sameUrl(opened, url))),
    [links, openWebUrls]
  );
  const viewPdfItems = resourceView === "closed" ? closedPdfItems : resourceView === "history" ? historyPdfItems : recentFiles;
  const viewWebItems = resourceView === "closed" ? closedWebItems : resourceView === "history" ? historyWebItems : links;

  const canDropToGroup = Boolean(dragWebTabId);
  const canDropFileTabs = Boolean(dragFileId);
  const isPdfFavorite = (path: string) =>
    favorites.some((item) => item.type === "pdf" && item.target.trim().toLowerCase() === path.trim().toLowerCase());
  const isWebFavorite = (url: string) =>
    favorites.some((item) => item.type === "web" && item.target.trim().toLowerCase() === url.trim().toLowerCase());
  const createWebTab = () => {
    setPlusPulse(true);
    onCreateWebTab();
  };

  const menuStyle = useMemo(() => {
    if (!menu) return undefined;
    const width = 252;
    const height = 340;
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8));
    return { left, top };
  }, [menu]);

  const toggleHistoryView = () => {
    setResourceRootCollapsed(false);
    setResourceView((prev) => (prev === "history" ? "resources" : "history"));
  };

  const selectResourceView = (view: "resources" | "closed" | "history") => {
    setResourceRootCollapsed(false);
    setResourceView(view);
  };

  const toggleResourceSection = (section: "pdf" | "web") => {
    setResourceSectionOpen((prev) => {
      const nextOpen = !prev[section];
      return { ...prev, [section]: nextOpen };
    });
  };

  const renderRecentPdfItem = (item: RecentFileItem) => {
    const latestSession = item.sessions?.find(
      (session) => typeof session.endPage === "number" && Number.isFinite(session.endPage)
    );

    return (
      <button
        key={`recent-${item.path}`}
        type="button"
        className={`edge-item resource ${item.missing ? "missing" : ""}`}
        title={item.path}
        onClick={() => onOpenRecentFile(item.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu({
            kind: "resource_pdf",
            path: item.path,
            name: item.name,
            missing: Boolean(item.missing),
            session: latestSession
              ? {
                  endPage: latestSession.endPage!,
                  endZoom: latestSession.endZoom,
                  endAutoFit: latestSession.endAutoFit,
                  endScrollTopRatio: latestSession.endScrollTopRatio,
                }
              : undefined,
            x: e.clientX,
            y: e.clientY,
          });
        }}
      >
        <span className="edge-item-icon"><FileText size={14} /></span>
        <span className="edge-item-main">
          <span className="edge-item-title">{item.name}</span>
          <span className="edge-item-subtitle">{compactPath(item.path, item.name)}</span>
          {item.snapshot ? (
            <span className="edge-item-submeta">{text.snapshot(item.snapshot.lastPage, item.snapshot.totalPages, item.snapshot.zoom)}</span>
          ) : null}
        </span>
        <span className="edge-item-actions edge-item-resource-actions">
          {!item.missing && latestSession && onContinueRecentSession ? (
            <span
              className="edge-item-resume"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContinueRecentSession(item.path, {
                  endPage: latestSession.endPage!,
                  endZoom: latestSession.endZoom,
                  endAutoFit: latestSession.endAutoFit,
                  endScrollTopRatio: latestSession.endScrollTopRatio,
                });
              }}
              title={text.resume}
            >
              {text.resume}
            </span>
          ) : null}
          <span
            className="edge-item-resource-btn"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemoveRecentResource(item.path);
            }}
            title={text.remove}
          >
            <X size={12} />
          </span>
          {item.missing ? (
            <span className="edge-item-tag warning">{text.pathMissing}</span>
          ) : null}
          {item.missing ? (
            <span
              className="edge-item-resource-btn persistent"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRelocateRecentFile(item.path);
              }}
              title={text.locateFile}
            >
              <FolderOpen size={12} />
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  const renderRecentWebItem = (url: string) => {
    const subtitle = shortUrl(url);
    let title = subtitle;
    try {
      title = new URL(url).hostname || subtitle;
    } catch {
      title = subtitle;
    }
    return (
      <button
        key={`link-${url}`}
        type="button"
        className="edge-item resource"
        title={url}
        onClick={() => onOpenLink(url)}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu({ kind: "resource_web", url, x: e.clientX, y: e.clientY });
        }}
      >
        <span className="edge-item-icon web"><TabFavicon url={url} /></span>
        <span className="edge-item-main">
          <span className="edge-item-title">{title}</span>
          <span className="edge-item-subtitle">{subtitle}</span>
        </span>
        <span className="edge-item-actions edge-item-resource-actions">
          <span
            className="edge-item-resource-btn"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemoveLinkResource(url);
            }}
            title={text.remove}
          >
            <X size={12} />
          </span>
        </span>
      </button>
    );
  };

  return (
    <aside className={`edge-sidebar ${collapsed ? "collapsed" : ""}`} style={{ width: collapsed ? RAIL_WIDTH : RAIL_WIDTH + PANEL_WIDTH }}>
      <div className="edge-rail">
        <button type="button" className="rail-btn brand" title={collapsed ? text.expand : text.collapse} onClick={() => setCollapsed((v) => !v)}>
          <Compass size={16} />
        </button>
        <button type="button" className={`rail-btn rail-create-btn ${plusPulse ? "pulse" : ""}`} onClick={createWebTab} title={text.newTab}>
          <Plus size={16} />
        </button>
        <button type="button" className="rail-btn" onClick={onOpenFile} title={text.openFile}>
          <FolderOpen size={16} />
        </button>
        <button
          type="button"
          className={`rail-btn ${resourceView === "history" ? "active" : ""}`}
          onClick={toggleHistoryView}
          title={text.historyTabs}
        >
          <History size={16} />
        </button>
        <button type="button" className="rail-btn" onClick={onOpenLibraryTab} title={text.library}>
          <Library size={16} />
        </button>
        <div className="rail-spacer" />
        <button type="button" className="rail-btn" onClick={onOpenSettingsTab} title={text.settings}>
          <Settings size={16} />
        </button>
      </div>

      {!collapsed && (
        <div className="edge-panel">
          <div className="edge-layer-title">{text.workspace}</div>
          <div className="edge-list">
            <div className="edge-section-label">{text.openTabs}</div>
            <button type="button" className={`edge-item ${mainPanel === "viewer" && !activeFileId ? "active" : ""}`} onClick={onOpenHomeTab}>
              <span className="edge-item-icon"><Compass size={14} /></span>
              <span className="edge-item-main">
                <span className="edge-item-title">{text.startTab}</span>
                <span className="edge-item-subtitle">{text.startHint}</span>
              </span>
            </button>

            {settingsTabOpen && (
              <button
                type="button"
                className={`edge-item ${mainPanel === "settings" ? "active" : ""}`}
                onClick={onOpenSettingsTab}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openContextMenu({ kind: "file", id: "__settings__", x: e.clientX, y: e.clientY });
                }}
              >
                <span className="edge-item-icon"><Settings size={14} /></span>
                <span className="edge-item-main">
                  <span className="edge-item-title">{text.settings}</span>
                </span>
                <span className="edge-item-close" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCloseSettingsTab(); }}>
                  <X size={12} />
                </span>
              </button>
            )}

            {libraryTabOpen && (
              <button
                type="button"
                className={`edge-item ${mainPanel === "library" ? "active" : ""}`}
                onClick={onOpenLibraryTab}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openContextMenu({ kind: "file", id: "__library__", x: e.clientX, y: e.clientY });
                }}
              >
                <span className="edge-item-icon"><Library size={14} /></span>
                <span className="edge-item-main">
                  <span className="edge-item-title">{text.library}</span>
                  <span className="edge-item-subtitle">
                    {text.libraryHint}
                  </span>
                </span>
                <span className="edge-item-close" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCloseLibraryTab(); }}>
                  <X size={12} />
                </span>
              </button>
            )}

            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                className={`edge-item ${mainPanel === "viewer" && file.id === activeFileId ? "active" : ""}`}
                title={file.path}
                draggable
                onClick={() => onFileSelect(file.id)}
                onDoubleClick={() => onCloseFileTab(file.id)}
                onDragStart={() => {
                  setDragFileId(file.id);
                  setDropFileId(file.id);
                  setDropFilePosition("before");
                }}
                onDragEnd={() => {
                  setDragFileId("");
                  setDropFileId("");
                  setDropFilePosition("before");
                }}
                onDragOver={(e) => {
                  if (!canDropFileTabs || dragFileId === file.id) return;
                  e.preventDefault();
                  setDropFileId(file.id);
                  setDropFilePosition(getDropPosition(e.clientY, e.currentTarget.getBoundingClientRect()));
                }}
                onDrop={(e) => {
                  if (!canDropFileTabs || dragFileId === file.id) return;
                  e.preventDefault();
                  onReorderFileTab(dragFileId, file.id, dropFilePosition);
                  setDragFileId("");
                  setDropFileId("");
                  setDropFilePosition("before");
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openContextMenu({ kind: "file", id: file.id, x: e.clientX, y: e.clientY });
                }}
                data-dragging={dragFileId === file.id ? "1" : "0"}
                data-drop-target={dropFileId === file.id && dragFileId !== file.id ? "1" : "0"}
                data-drop-position={dropFileId === file.id && dragFileId !== file.id ? dropFilePosition : ""}
              >
                <span className="edge-item-icon"><FileText size={14} /></span>
                <span className="edge-item-main">
                  <span className="edge-item-title">{file.name}</span>
                  {compactPath(file.path, file.name) ? (
                    <span className="edge-item-subtitle">{compactPath(file.path, file.name)}</span>
                  ) : null}
                </span>
                <span className="edge-item-close" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCloseFileTab(file.id); }}>
                  <X size={12} />
                </span>
              </button>
            ))}

            {pinnedTabs.length > 0 && (
              <>
                <div
                  className={`edge-section-label ${canDropToGroup ? "drop-ready" : ""}`}
                  onDragOver={(e) => { if (canDropToGroup) e.preventDefault(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!dragWebTabId) return;
                    onMoveWebTabToGroup(dragWebTabId, webTabGroups[0]?.id || "");
                    onToggleWebTabPinned(dragWebTabId);
                    setDropWebTabId("");
                    setDropWebPosition("before");
                    setDragWebTabId("");
                  }}
                >
                  {text.webPinned}
                </div>
                {pinnedTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    draggable
                    className={`edge-item ${mainPanel === "web" && tab.id === activeWebTabId ? "active" : ""} ${tab.id === newWebTabId ? "new" : ""}`}
                    title={tab.url}
                    onClick={() => onWebTabSelect(tab.id)}
                    onDoubleClick={() => onCloseWebTab(tab.id)}
                    onDragStart={() => {
                      setDragWebTabId(tab.id);
                      setDropWebTabId(tab.id);
                      setDropWebPosition("before");
                    }}
                    onDragEnd={() => {
                      setDragWebTabId("");
                      setDropWebTabId("");
                      setDropWebPosition("before");
                    }}
                    onDragOver={(e) => {
                      if (!dragWebTabId || dragWebTabId === tab.id) return;
                      e.preventDefault();
                      setDropWebTabId(tab.id);
                      setDropWebPosition(getDropPosition(e.clientY, e.currentTarget.getBoundingClientRect()));
                    }}
                    onDrop={(e) => {
                      if (!dragWebTabId || dragWebTabId === tab.id) return;
                      e.preventDefault();
                      onReorderWebTab(dragWebTabId, tab.id, tab.groupId, true, dropWebPosition);
                      setDragWebTabId("");
                      setDropWebTabId("");
                      setDropWebPosition("before");
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openContextMenu({ kind: "web", id: tab.id, pinned: true, x: e.clientX, y: e.clientY });
                    }}
                    data-dragging={dragWebTabId === tab.id ? "1" : "0"}
                    data-drop-target={dropWebTabId === tab.id && dragWebTabId !== tab.id ? "1" : "0"}
                    data-drop-position={dropWebTabId === tab.id && dragWebTabId !== tab.id ? dropWebPosition : ""}
                  >
                    <span className="edge-item-icon web"><TabFavicon url={tab.url} /></span>
                    <span className="edge-item-main">
                      <span className="edge-item-title">{tab.title}</span>
                      <span className="edge-item-subtitle">{tab.url ? shortUrl(tab.url) : text.newTab}</span>
                    </span>
                    <span className="edge-item-actions">
                      <span className="edge-item-pin active" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleWebTabPinned(tab.id); }}>
                        <Pin size={12} />
                      </span>
                      <span className="edge-item-close" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCloseWebTab(tab.id); }}>
                        <X size={12} />
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}

            {webTabGroups.map((group) => {
              const tabs = groupedTabs.get(group.id) || [];
              return (
                <div key={group.id} className="edge-group-wrap">
                  <button
                    type="button"
                    className={`edge-group-head ${canDropToGroup ? "drop-ready" : ""}`}
                    onClick={() => onToggleWebTabGroupCollapsed(group.id)}
                    onDragOver={(e) => { if (canDropToGroup) e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!dragWebTabId) return;
                      onMoveWebTabToGroup(dragWebTabId, group.id);
                      setDropWebTabId("");
                      setDropWebPosition("before");
                      setDragWebTabId("");
                    }}
                  >
                    {group.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span>{group.name}</span>
                    <span className="edge-group-count">{tabs.length}</span>
                  </button>
                  <div className={`edge-group-body ${group.collapsed ? "collapsed" : ""}`}>
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        draggable
                        className={`edge-item ${mainPanel === "web" && tab.id === activeWebTabId ? "active" : ""} ${tab.id === newWebTabId ? "new" : ""}`}
                        title={tab.url}
                        onClick={() => onWebTabSelect(tab.id)}
                        onDoubleClick={() => onCloseWebTab(tab.id)}
                        onDragStart={() => {
                          setDragWebTabId(tab.id);
                          setDropWebTabId(tab.id);
                          setDropWebPosition("before");
                        }}
                        onDragEnd={() => {
                          setDragWebTabId("");
                          setDropWebTabId("");
                          setDropWebPosition("before");
                        }}
                        onDragOver={(e) => {
                          if (!dragWebTabId || dragWebTabId === tab.id) return;
                          e.preventDefault();
                          setDropWebTabId(tab.id);
                          setDropWebPosition(getDropPosition(e.clientY, e.currentTarget.getBoundingClientRect()));
                        }}
                        onDrop={(e) => {
                          if (!dragWebTabId || dragWebTabId === tab.id) return;
                          e.preventDefault();
                          onReorderWebTab(dragWebTabId, tab.id, tab.groupId, false, dropWebPosition);
                          setDragWebTabId("");
                          setDropWebTabId("");
                          setDropWebPosition("before");
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          openContextMenu({ kind: "web", id: tab.id, pinned: false, x: e.clientX, y: e.clientY });
                        }}
                        data-dragging={dragWebTabId === tab.id ? "1" : "0"}
                        data-drop-target={dropWebTabId === tab.id && dragWebTabId !== tab.id ? "1" : "0"}
                        data-drop-position={dropWebTabId === tab.id && dragWebTabId !== tab.id ? dropWebPosition : ""}
                      >
                        <span className="edge-item-icon web"><TabFavicon url={tab.url} /></span>
                        <span className="edge-item-main">
                          <span className="edge-item-title">{tab.title}</span>
                          <span className="edge-item-subtitle">{tab.url ? shortUrl(tab.url) : text.newTab}</span>
                        </span>
                        <span className="edge-item-actions">
                          <span className="edge-item-pin" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleWebTabPinned(tab.id); }}>
                            <PinOff size={12} />
                          </span>
                          <span className="edge-item-close" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCloseWebTab(tab.id); }}>
                            <X size={12} />
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            {files.length === 0 && webTabs.length === 0 && !settingsTabOpen && !libraryTabOpen && (
              <div className="edge-empty">
                <span>{text.empty}</span>
                <button type="button" onClick={onOpenFile}>{text.open}</button>
              </div>
            )}

            <div className={`edge-resource-root ${resourceRootCollapsed ? "collapsed" : ""}`}>
              <button
                type="button"
                className="edge-resource-root-toggle"
                onClick={() => setResourceRootCollapsed((prev) => !prev)}
                title={resourceRootCollapsed ? text.expandResources : text.collapseResources}
              >
                {resourceRootCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="edge-section-label edge-resource-title" aria-label={text.resources} title={text.resources}>
                  <Files size={14} />
                </span>
              </button>

              <div className={`edge-resource-root-body ${resourceRootCollapsed ? "collapsed" : "open"}`}>
                <div className="edge-resource-mode-row">
                  <button
                    type="button"
                    className={`edge-resource-mode-btn ${resourceView === "resources" ? "active" : ""}`}
                    onClick={() => selectResourceView("resources")}
                  >
                    {text.currentResources}
                  </button>
                  <button
                    type="button"
                    className={`edge-resource-mode-btn ${resourceView === "closed" ? "active" : ""}`}
                    onClick={() => selectResourceView("closed")}
                  >
                    {text.closedTabs}
                  </button>
                  <button
                    type="button"
                    className={`edge-resource-mode-btn ${resourceView === "history" ? "active" : ""}`}
                    onClick={() => selectResourceView("history")}
                  >
                    {text.historyTabs}
                  </button>
                </div>

                <section className={`edge-resource-panel ${resourceSectionOpen.pdf ? "open" : ""}`}>
                  <div className="edge-resource-panel-head">
                    <button
                      type="button"
                      className="edge-resource-panel-toggle"
                      onClick={() => toggleResourceSection("pdf")}
                    >
                      {resourceSectionOpen.pdf ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <span>{text.pdfResources}</span>
                      {!resourceSectionOpen.pdf && viewPdfItems.length > 0 ? (
                        <span className="edge-resource-group-count">{viewPdfItems.length}</span>
                      ) : null}
                    </button>
                    {resourceView === "resources" && recentFiles.length > 0 ? (
                      <button
                        type="button"
                        className="edge-section-clear icon"
                        title={text.clearAll}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void (async () => {
                            const confirmed = await askConfirm(text.confirmClearPdf);
                            if (!confirmed) return;
                            onClearRecentResources();
                            closeContextMenu(true);
                          })();
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    ) : null}
                  </div>
                  <div className={`edge-resource-panel-body ${resourceSectionOpen.pdf ? "open" : ""}`}>
                    {viewPdfItems.length === 0 ? (
                      <div className="edge-resource-empty-note">
                        {resourceView === "resources"
                          ? text.noPdfResources
                          : resourceView === "closed"
                            ? text.noClosedTabs
                            : text.noHistoryTabs}
                      </div>
                    ) : (
                      <div className="edge-resource-groups">
                        {viewPdfItems.slice(0, 40).map(renderRecentPdfItem)}
                      </div>
                    )}
                  </div>
                </section>

                <section className={`edge-resource-panel ${resourceSectionOpen.web ? "open" : ""}`}>
                  <div className="edge-resource-panel-head">
                    <button
                      type="button"
                      className="edge-resource-panel-toggle"
                      onClick={() => toggleResourceSection("web")}
                    >
                      {resourceSectionOpen.web ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <span>{text.webResources}</span>
                      {!resourceSectionOpen.web && viewWebItems.length > 0 ? (
                        <span className="edge-resource-group-count">{viewWebItems.length}</span>
                      ) : null}
                    </button>
                    {resourceView === "resources" && links.length > 0 ? (
                      <button
                        type="button"
                        className="edge-section-clear icon"
                        title={text.clearAll}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void (async () => {
                            const confirmed = await askConfirm(text.confirmClearWeb);
                            if (!confirmed) return;
                            onClearLinkResources();
                            closeContextMenu(true);
                          })();
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    ) : null}
                  </div>
                  <div className={`edge-resource-panel-body ${resourceSectionOpen.web ? "open" : ""}`}>
                    {viewWebItems.length === 0 ? (
                      <div className="edge-resource-empty-note">
                        {resourceView === "resources"
                          ? text.noWebResources
                          : resourceView === "closed"
                            ? text.noClosedTabs
                            : text.noHistoryTabs}
                      </div>
                    ) : (
                      <div className="edge-resource-groups">
                        {viewWebItems.slice(0, 40).map(renderRecentWebItem)}
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      )}

      {collapsed && (
        <div className="edge-collapsed-stack">
          <button type="button" className={`rail-btn mini rail-create-btn ${plusPulse ? "pulse" : ""}`} onClick={createWebTab} title={text.newTab}>
            <Plus size={14} />
          </button>
          <button type="button" className="rail-btn mini" onClick={onOpenHomeTab} title={text.startTab}>
            <Compass size={14} />
          </button>
          <button type="button" className={`rail-btn mini ${mainPanel === "library" ? "active" : ""}`} onClick={onOpenLibraryTab} title={text.library}>
            <Library size={14} />
          </button>
          {webTabs.slice(0, 6).map((item) => (
            <button key={item.id} type="button" className={`rail-btn mini ${item.id === activeWebTabId ? "active" : ""}`} title={item.title} onClick={() => onWebTabSelect(item.id)}>
              <TabFavicon url={item.url} size={14} className="edge-favicon mini" />
            </button>
          ))}
        </div>
      )}

      {menu && (
        <>
          <div className="edge-menu-backdrop" onMouseDown={() => closeContextMenu()} />
          <div
            ref={menuRef}
            className={`edge-menu ${menuClosing ? "closing" : "opening"}`}
            style={menuStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {menu.kind === "file" ? (
              <>
                {menu.id === "__settings__" ? (
                  <button type="button" onClick={() => { onCloseSettingsTab(); closeContextMenu(); }}>{text.closeSettings}</button>
                ) : menu.id === "__library__" ? (
                  <button type="button" onClick={() => { onCloseLibraryTab(); closeContextMenu(); }}>{text.closeTab}</button>
                ) : (
                  (() => {
                    const targetFile = files.find((item) => item.id === menu.id);
                    if (!targetFile) {
                      return <button type="button" onClick={() => { onCloseFileTab(menu.id); closeContextMenu(); }}>{text.closeFile}</button>;
                    }
                    const favorited = isPdfFavorite(targetFile.path);
                    return (
                      <>
                        <button type="button" onClick={() => { onTogglePdfFavorite(targetFile.path, targetFile.name); closeContextMenu(); }}>
                          {favorited ? text.removeFavorite : text.addFavorite}
                        </button>
                        <button type="button" onClick={() => { onAddFileToLibrary(targetFile.path, libraryCollections[0]?.name); closeContextMenu(); }}>
                          {text.addLibrary}
                        </button>
                        <div className="edge-menu-divider" />
                        <button type="button" onClick={() => { onCloseFileTab(menu.id); closeContextMenu(); }}>{text.closeFile}</button>
                      </>
                    );
                  })()
                )}
              </>
            ) : menu.kind === "web" ? (
              <>
                <button type="button" onClick={() => { onWebTabSelect(menu.id); closeContextMenu(); }}>{text.open}</button>
                <button type="button" onClick={() => { onCloseWebTab(menu.id); closeContextMenu(); }}>{text.closeWeb}</button>
                {(() => {
                  const targetTab = webTabs.find((item) => item.id === menu.id);
                  if (!targetTab) return null;
                  const favorited = isWebFavorite(targetTab.url);
                  return (
                    <button type="button" onClick={() => { onAddWebTabFavorite(menu.id); closeContextMenu(); }}>
                      {favorited ? text.removeFavorite : text.addFavorite}
                    </button>
                  );
                })()}
                <button type="button" onClick={() => { onToggleWebTabPinned(menu.id); closeContextMenu(); }}>
                  {menu.pinned ? text.unpinWeb : text.pinWeb}
                </button>
                <div className="edge-menu-divider" />
                <div className="edge-menu-label">{text.moveToGroup}</div>
                {webTabGroups.map((group) => (
                  <button key={group.id} type="button" onClick={() => { onMoveWebTabToGroup(menu.id, group.id); closeContextMenu(); }}>
                    {group.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    onCreateWebTabGroup(undefined, menu.id);
                    closeContextMenu();
                  }}
                >
                  + {text.createGroup}
                </button>
              </>
            ) : menu.kind === "resource_pdf" ? (
              <>
                <button type="button" onClick={() => { onOpenRecentFile(menu.path); closeContextMenu(); }}>{text.open}</button>
                {menu.session && onContinueRecentSession ? (
                  <button
                    type="button"
                    onClick={() => {
                      onContinueRecentSession(menu.path, menu.session!);
                      closeContextMenu();
                    }}
                  >
                    {text.resume}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    onTogglePdfFavorite(menu.path, menu.name);
                    closeContextMenu();
                  }}
                >
                  {isPdfFavorite(menu.path) ? text.removeFavorite : text.addFavorite}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onAddFileToLibrary(menu.path, libraryCollections[0]?.name);
                    closeContextMenu();
                  }}
                >
                  {text.addLibrary}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onRemoveRecentResource(menu.path);
                    closeContextMenu();
                  }}
                >
                  {text.remove}
                </button>
                {menu.missing ? (
                  <>
                    <div className="edge-menu-divider" />
                    <button
                      type="button"
                      onClick={() => {
                        onRelocateRecentFile(menu.path);
                        closeContextMenu();
                      }}
                    >
                      {text.locateFile}
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <button type="button" onClick={() => { onOpenLink(menu.url); closeContextMenu(); }}>{text.open}</button>
                <button
                  type="button"
                  onClick={() => {
                    onToggleWebFavorite(menu.url, shortUrl(menu.url));
                    closeContextMenu();
                  }}
                >
                  {isWebFavorite(menu.url) ? text.removeFavorite : text.addFavorite}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onOpenLink(menu.url, { forceExternal: true });
                    closeContextMenu();
                  }}
                >
                  {text.openExternal}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onRemoveLinkResource(menu.url);
                    closeContextMenu();
                  }}
                >
                  {text.remove}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

export default Sidebar;

