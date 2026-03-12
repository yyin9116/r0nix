import { useEffect, useRef, useState, type MouseEvent } from "react";
import { X, FileText, Globe, Library, Settings, PanelLeft } from "lucide-react";
import type { Tab } from "../types";
import type { AppLanguage } from "../services/userSettings";

interface TabsProps {
  tabs: Tab[];
  activeTabId: string;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
  onTabContextMenu?: (tab: Tab, event: MouseEvent<HTMLDivElement>) => void;
  language: AppLanguage;
}

export function Tabs({ tabs, activeTabId, onTabClick, onTabClose, onToggleSidebar, isSidebarOpen = true, onTabContextMenu, language }: TabsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragStateRef = useRef({ active: false, startX: 0, startScrollLeft: 0 });
  const dragMovedRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tabWidth, setTabWidth] = useState(184);
  const [indicator, setIndicator] = useState<{ left: number; width: number; visible: boolean }>({
    left: 0,
    width: 0,
    visible: false,
  });

  useEffect(() => {
    const updateLayout = () => {
      const container = scrollRef.current;
      const activeNode = tabRefs.current[activeTabId];
      if (container) {
        const available = Math.max(container.clientWidth - 12, 480);
        const nextWidth = Math.max(116, Math.min(220, Math.floor(available / Math.max(tabs.length, 1))));
        setTabWidth(nextWidth);
      }
      if (!container || !activeNode) {
        setIndicator((prev) => ({ ...prev, visible: false }));
        return;
      }
      setIndicator({ left: activeNode.offsetLeft, width: activeNode.offsetWidth, visible: true });
    };

    updateLayout();
    const handleResize = () => updateLayout();
    const container = scrollRef.current;
    const resizeObserver = typeof ResizeObserver !== "undefined" && container ? new ResizeObserver(updateLayout) : null;
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
  }, [activeTabId, tabs]);

  useEffect(() => {
    const activeNode = tabRefs.current[activeTabId];
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

  const closeTabLabel = language === "zh-CN" ? "\u5173\u95ed\u6807\u7b7e" : "Close tab";
  const toggleSidebarLabel = language === "zh-CN" ? "\u5207\u6362\u4fa7\u8fb9\u680f" : "Toggle Sidebar";
  return (
    <div className="flex h-10 bg-zinc-100 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 shrink-0 font-sans min-w-0">
      <div className="h-full flex items-center px-2 shrink-0 border-r border-zinc-200/70 dark:border-zinc-800/70">
        <button
          onClick={onToggleSidebar}
          data-no-drag="true"
          className={`p-1.5 rounded-md transition-colors ${isSidebarOpen ? "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800" : "text-zinc-400 dark:text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"}`}
          title={toggleSidebarLabel}
        >
          <PanelLeft size={16} />
        </button>
      </div>

      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-zinc-100 to-transparent dark:from-zinc-950 z-20" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-zinc-100 to-transparent dark:from-zinc-950 z-20" />
        <div
          ref={scrollRef}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          className={`relative flex h-full overflow-x-auto no-scrollbar select-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
        >
          <div
            className={`absolute top-0 h-0.5 transition-[left,width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${indicator.visible ? "opacity-100" : "opacity-0"}`}
            style={{ left: `${indicator.left}px`, width: `${indicator.width}px`, backgroundColor: "var(--reader-accent)" }}
          />

          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const Icon = tab.type === "pdf" || tab.type === "markdown" ? FileText : tab.type === "web" ? Globe : tab.type === "settings" ? Settings : Library;
            const closable = !tab.pinned;

            return (
              <div
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                onClick={() => handleTabActivate(tab.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!onTabContextMenu) return;
                  onTabContextMenu(tab, event);
                }}
                className={`group relative flex shrink-0 items-center gap-2 px-4 h-full cursor-pointer motion-safe:transition-[background-color,color,border-color] motion-safe:duration-220 text-sm ${
                  isActive
                    ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm border-x border-zinc-200 dark:border-zinc-800 z-10"
                    : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-800 dark:hover:text-zinc-200 border-x border-transparent"
                }`}
                style={{ width: tabWidth, minWidth: tabWidth, maxWidth: tabWidth }}
                title={tab.title}
              >
                <Icon size={14} className={isActive ? "shrink-0 text-zinc-900 dark:text-zinc-100" : "shrink-0 text-zinc-400 dark:text-zinc-500"} />
                <span className="truncate flex-1 font-serif font-medium text-base">{tab.title}</span>
                {closable ? (
                  <button
                    data-no-drag="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      onTabClose(tab.id);
                    }}
                    className={`p-1 rounded-md transition-all ${isActive ? "opacity-100 hover:bg-zinc-100 dark:hover:bg-zinc-800" : "opacity-0 group-hover:opacity-100 hover:bg-zinc-300/50 dark:hover:bg-zinc-700/50"}`}
                    title={closeTabLabel}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
