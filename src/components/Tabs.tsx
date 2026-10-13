import { useEffect, useRef, useState, type MouseEvent } from "react";
import { X, FileText, Globe, Library, Settings, PanelLeft, Plus } from "lucide-react";
import { AnimatePresence, motion, Reorder } from "motion/react";
import type { Tab } from "../types";
import type { AppLanguage } from "../services/userSettings";

interface TabsProps {
  tabs: Tab[];
  activeTabId: string;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  /**
   * 拖拽排序完成后的新顺序。
   *
   * ⚠️ **必填，且不能给它一个 no-op 兜底**：`Reorder.Group` 在缺 `onReorder`
   * 时会照常跑完手势却不通知外部，表现为「能拖、拖完顺序不变」——
   * 与「不能拖动排序」是同一个症状，很难区分。所以让类型在这里强制接线。
   */
  onTabsReorder: (tabs: Tab[]) => void;
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
  onTabsReorder,
  onToggleSidebar,
  onNewTab,
  isSidebarOpen = true,
  onTabContextMenu,
  language,
}: TabsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 「刚刚拖过」标记。
   *
   * 为什么需要它：`Reorder.Item` 用 motion 的 drag 手势，浏览器在指针移动过之后
   * 仍可能补发一次 `click`（目标退化成最近的共同祖先）。不做区分的话，读者
   * 「把标签 A 拖到 B 旁边」会顺带把 A 激活 —— 排序与切换同时发生，
   * 读者拿到的是一个既换了顺序又换了内容的标签栏。
   *
   * 判据用「发生过 drag」而不是「位移超过 N 像素」：后者会被库自己的
   * 投影阈值拒掉（低于阈值不算拖动），与实际行为对不齐。
   */
  const draggedRecentlyRef = useRef(false);
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

  const closeTabLabel = language === "zh-CN" ? "关闭标签" : "Close tab";
  const toggleSidebarLabel = language === "zh-CN" ? "切换侧边栏" : "Toggle Sidebar";
  const newTabLabel = language === "zh-CN" ? "新建标签页" : "New tab";
  const dragTabLabel = language === "zh-CN" ? "拖动排序" : "Drag to reorder";

  /**
   * 空白处按下 = 准备横向滚动；标签上按下 = 交给 Reorder 排序。
   *
   * 分工靠 `data-tab-id`：标签本体一律带这个属性，横向滚动只在标签之间的
   * 空隙才生效。两者共用一个 pointerdown 监听，不区分的话，在标签上按下想排序
   * 会同时把标签栏滚走 —— 表现为「拖了一下，标签全跑了，但顺序没变」。
   */
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-tab-id]")) return;
    const container = scrollRef.current;
    if (!container) return;
    const startX = event.clientX;
    const startScrollLeft = container.scrollLeft;
    let moved = false;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (!moved && Math.abs(delta) > 4) moved = true;
      if (moved) container.scrollLeft = startScrollLeft - delta;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) return;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      container.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  };

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

        {/*
          Reorder.Group 取代原来的裸 flex 容器：拖动排序由库的 drag 手势接管，
          横向滚动保留（滚轮 + 空白处拖动）。

          ⚠️ `axis="x"` 必填：Reorder 靠它决定投影方向，缺省会按 `y` 算，
          拖动会表现为「标签跟着鼠标上下跑」。

          ⚠️ `values` 必须是当前 tabs 的引用，而不是副本：`onReorder` 回传的是
          库按投影顺序重排后的**新数组**，直接交给 setTabs 即可；
          传副本会让库的 indexOf 全部失配（见 Group.mjs 的 updateOrder）。
        */}
        <Reorder.Group
          as="div"
          axis="x"
          values={tabs}
          onReorder={onTabsReorder}
          ref={scrollRef}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          className="relative flex h-full w-full overflow-x-auto no-scrollbar select-none cursor-grab"
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
                <Reorder.Item
                  key={tab.id}
                  as="div"
                  value={tab}
                  layout
                  data-tab-id={tab.id}
                  onClick={() => {
                    // 拖过就不算点击 —— 排序与激活必须是两个独立动作。
                    if (draggedRecentlyRef.current) return;
                    onTabClick(tab.id);
                  }}
                  onDrag={() => {
                    draggedRecentlyRef.current = true;
                  }}
                  onDragEnd={() => {
                    // 延到下一帧再清：本帧的 click 还没派发。
                    window.requestAnimationFrame(() => {
                      draggedRecentlyRef.current = false;
                    });
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!onTabContextMenu) return;
                    onTabContextMenu(tab, event);
                  }}
                  className={`group relative box-border flex shrink-0 items-center gap-2 overflow-hidden px-4 h-full cursor-grab active:cursor-grabbing motion-safe:transition-[background-color,color,border-color] motion-safe:duration-fast text-sm ${
                    isActive
                      ? "bg-surface-panel text-content-primary shadow-sm border-x border-border-subtle z-10"
                      : "text-content-muted hover:bg-surface-hover/50 hover:text-content-primary border-x border-transparent"
                  }`}
                  style={{ minWidth: tabWidth, maxWidth: tabWidth, touchAction: "pan-y" }}
                  title={`${tab.title} — ${dragTabLabel}`}
                  whileDrag={{ scale: 1.02, zIndex: 30 }}
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
                      onPointerDown={(event) => {
                        // 必须在 pointerdown 阶段就停掉冒泡：库的 drag 监听挂在
                        // Reorder.Item 上，事件到不了那里，拖拽才不会启动。
                        // 只在 click 里 stopPropagation 已经太晚 —— 那时 drag 早跑起来了。
                        event.stopPropagation();
                      }}
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
                </Reorder.Item>
              );
            })}
          </AnimatePresence>
        </Reorder.Group>
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
