import { useEffect, useRef, useState, type MouseEvent } from "react";
import { X, FileText, Globe, Library, Settings, PanelLeft, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Tab } from "../types";
import type { AppLanguage } from "../services/userSettings";

interface TabsProps {
  tabs: Tab[];
  activeTabId: string;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onToggleSidebar?: () => void;
  onNewTab?: () => void;
  isSidebarOpen?: boolean;
  onTabContextMenu?: (tab: Tab, event: MouseEvent<HTMLDivElement>) => void;
  language: AppLanguage;
}

export function Tabs({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onToggleSidebar,
  onNewTab,
  isSidebarOpen = true,
  onTabContextMenu,
  language,
}: TabsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef({ active: false, startX: 0, startScrollLeft: 0 });
  const dragMovedRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tabWidth, setTabWidth] = useState(184);

  useEffect(() => {
    const updateLayout = () => {
      const container = scrollRef.current;
      if (!container) return;
      const available = Math.max(container.clientWidth - 12, 480);
      const nextWidth = Math.max(116, Math.min(220, Math.floor(available / Math.max(tabs.length, 1))));
      setTabWidth(nextWidth);
    };

    updateLayout();
    const handleResize = () => updateLayout();
    const container = scrollRef.current;
    const resizeObserver =
      typeof ResizeObserver !== "undefined" && container ? new ResizeObserver(updateLayout) : null;

    if (resizeObserver && container) {
      resizeObserver.observe(container);
    }

    window.addEventListener("resize", handleResize);
    container?.addEventListener("scroll", handleResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      container?.removeEventListener("scroll", handleResize);
    };
  }, [tabs.length]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const activeNode = container.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`);
    activeNode?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeTabId, tabs]);

  useEffect(() => {
    const handlePointerUp = () => {
      dragStateRef.current.active = false;
      setIsDragging(false);
      window.setTimeout(() => {
        dragMovedRef.current = false;
      }, 0);
    };

    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-no-drag="true"]')) return;
    const container = scrollRef.current;
    if (!container) return;
    dragStateRef.current = {
      active: true,
      startX: event.clientX,
      startScrollLeft: container.scrollLeft,
    };
    dragMovedRef.current = false;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current.active) return;
    const container = scrollRef.current;
    if (!container) return;
    const delta = event.clientX - dragStateRef.current.startX;
    if (Math.abs(delta) > 3) {
      dragMovedRef.current = true;
      setIsDragging(true);
    }
    container.scrollLeft = dragStateRef.current.startScrollLeft - delta;
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) return;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      container.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  };

  const handleTabActivate = (id: string) => {
    if (dragMovedRef.current) return;
    onTabClick(id);
  };

  const closeTabLabel = language === "zh-CN" ? "关闭标签" : "Close tab";
  const toggleSidebarLabel = language === "zh-CN" ? "切换侧边栏" : "Toggle Sidebar";
  const newTabLabel = language === "zh-CN" ? "新建标签页" : "New tab";

  return (
    <div className="flex h-10 bg-surface-sunken border-b border-border-subtle shrink-0 font-sans min-w-0">
      <div className="h-full flex items-center px-2 shrink-0 border-r border-border-subtle/70">
        <button
          onClick={onToggleSidebar}
          data-no-drag="true"
          aria-label={toggleSidebarLabel}
          className={`p-1.5 rounded-md transition-colors ${
            isSidebarOpen
              ? "text-content-secondary hover:bg-surface-hover"
              : "text-content-muted hover:bg-surface-hover"
          }`}
          title={toggleSidebarLabel}
        >
          <PanelLeft size={16} />
        </button>
      </div>

      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-surface-sunken to-transparent z-20" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-sunken to-transparent z-20" />

        <div
          ref={scrollRef}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          className={`relative flex h-full overflow-x-auto no-scrollbar select-none ${
            isDragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          <AnimatePresence initial={false}>
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const Icon =
                tab.type === "pdf" || tab.type === "markdown"
                  ? FileText
                  : tab.type === "web"
                    ? Globe
                    : tab.type === "settings"
                      ? Settings
                      : Library;
              const closable = !tab.pinned;

              return (
                <motion.div
                  key={tab.id}
                  layout
                  data-tab-id={tab.id}
                  onClick={() => handleTabActivate(tab.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!onTabContextMenu) return;
                    onTabContextMenu(tab, event);
                  }}
                  className={`group relative box-border flex shrink-0 items-center gap-2 overflow-hidden px-4 h-full cursor-pointer motion-safe:transition-[background-color,color,border-color] motion-safe:duration-220 text-sm ${
                    isActive
                      ? "bg-surface-panel text-content-primary shadow-sm border-x border-border-subtle z-10"
                      : "text-content-muted hover:bg-surface-hover/50 hover:text-content-primary border-x border-transparent"
                  }`}
                  style={{ minWidth: tabWidth, maxWidth: tabWidth }}
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: tabWidth, opacity: 1 }}
                  exit={{ width: 0, minWidth: 0, maxWidth: 0, opacity: 0 }}
                  transition={{ type: "tween", duration: 0.16, ease: "easeOut" }}
                  title={tab.title}
                >
                  {isActive ? (
                    <motion.div
                      layoutId="activeTabIndicator"
                      className="absolute top-0 left-0 right-0 h-0.5"
                      style={{ backgroundColor: "var(--reader-accent)" }}
                      initial={false}
                      transition={{ type: "tween", duration: 0.12, ease: "easeOut" }}
                    />
                  ) : null}

                  <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                    <Icon
                      size={14}
                      className={isActive ? "text-content-primary" : "text-content-muted"}
                    />
                    {tab.type === "web" && tab.url && tab.url !== "about:blank" ? (
                      <img
                        src={(() => { try { return `${new URL(tab.url).protocol}//${new URL(tab.url).host}/favicon.ico`; } catch { return ""; } })()}
                        alt=""
                        className="absolute inset-0 h-4 w-4 rounded-sm bg-surface-panel object-contain"
                        onError={(event) => { event.currentTarget.style.display = "none"; }}
                      />
                    ) : null}
                  </span>
                  <span className="truncate flex-1 font-serif font-medium text-base">{tab.title}</span>

                  {closable ? (
                    <button
                      data-no-drag="true"
                      aria-label={closeTabLabel}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTabClose(tab.id);
                      }}
                      className={`p-1 rounded-md transition-all ${
                        isActive
                          ? "opacity-100 hover:bg-surface-hover"
                          : "opacity-0 group-hover:opacity-100 hover:bg-surface-active/50"
                      }`}
                      title={closeTabLabel}
                    >
                      <X size={12} />
                    </button>
                  ) : null}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
      <div className="flex h-full shrink-0 items-center border-l border-border-subtle/70 px-1.5">
        <button
          type="button"
          data-no-drag="true"
          aria-label={newTabLabel}
          title={newTabLabel}
          onClick={onNewTab}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-[var(--reader-accent-soft)] hover:text-[var(--reader-accent)]"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
