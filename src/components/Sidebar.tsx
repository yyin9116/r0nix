import React from "react";
import {
  Library,
  Star,
  Clock,
  Folder,
  Settings,
  Plus,
  Search,
  Globe,
  FileText,
  FolderOpen,
  Link2,
  Trash2,
  ChevronDown,
} from "lucide-react";
import type { LibraryFilter, ReaderCollection } from "../types";
import type { AppLanguage, QuickLinkItem } from "../services/userSettings";

interface SidebarProps {
  activeFilter: LibraryFilter;
  documentCount: number;
  favoriteCount: number;
  collections: ReaderCollection[];
  quickLinks: QuickLinkItem[];
  language: AppLanguage;
  isOpen?: boolean;
  onCreateCollection: () => void;
  onOpenLibrary: (filter: LibraryFilter, title: string) => void;
  onPinLibrary: (filter: LibraryFilter, title: string) => void;
  onOpenFileDialog: () => void;
  onImportFolder: () => void;
  onOpenQuickLink: (url: string) => void;
  onOpenWeb: () => void;
  onOpenSettings: () => void;
  onSearchWorkspace: () => void;
  onManageQuickLinks: () => void;
}

const UI_TEXT = {
  "zh-CN": {
    searchWorkspace: "\u641c\u7d22\u5de5\u4f5c\u533a",
    library: "\u8d44\u6599\u5e93",
    allDocuments: "\u5168\u90e8\u6587\u6863",
    recent: "\u6700\u8fd1",
    quickAccess: "\u5feb\u6377\u8bbf\u95ee",
    whiteboards: "\u767d\u677f",
    trash: "\u56de\u6536\u7ad9",
    favorites: "\u6536\u85cf",
    collections: "\u96c6\u5408",
    createCollection: "\u65b0\u5efa\u96c6\u5408",
    noCollections: "\u6682\u65e0\u96c6\u5408",
    quickLinks: "\u5feb\u6377\u94fe\u63a5",
    manage: "\u7ba1\u7406",
    manageQuickLinks: "\u7ba1\u7406\u5feb\u6377\u94fe\u63a5",
    quickLinksHint: "\u5728\u8bbe\u7f6e\u4e2d\u7ba1\u7406\u5feb\u6377\u94fe\u63a5\u3002",
    tools: "\u5de5\u5177",
    webBrowser: "\u7f51\u9875\u6d4f\u89c8",
    openFile: "\u6253\u5f00\u6587\u4ef6...",
    importFolder: "\u5bfc\u5165\u6587\u4ef6\u5939",
    settings: "\u8bbe\u7f6e",
    pinHint: "\u53cc\u51fb\u56fa\u5b9a\u4e3a\u6807\u7b7e\u9875",
  },
  "en-US": {
    searchWorkspace: "Search workspace",
    library: "Library",
    allDocuments: "All Documents",
    recent: "Recent",
    quickAccess: "Quick Access",
    whiteboards: "Whiteboards",
    trash: "Trash",
    favorites: "Favorites",
    collections: "Collections",
    createCollection: "Create collection",
    noCollections: "No collections yet",
    quickLinks: "Quick Links",
    manage: "Manage",
    manageQuickLinks: "Manage quick links",
    quickLinksHint: "Manage quick links in Settings.",
    tools: "Tools",
    webBrowser: "Web Browser",
    openFile: "Open File...",
    importFolder: "Import Folder",
    settings: "Settings",
    pinHint: "Double-click to pin as a tab",
  },
} as const;

export function Sidebar({
  activeFilter,
  documentCount,
  favoriteCount,
  collections,
  quickLinks,
  language,
  isOpen = true,
  onCreateCollection,
  onOpenLibrary,
  onPinLibrary,
  onOpenFileDialog,
  onImportFolder,
  onOpenQuickLink,
  onOpenWeb,
  onOpenSettings,
  onSearchWorkspace,
  onManageQuickLinks,
}: SidebarProps) {
  const text = UI_TEXT[language];
  const [quickLinksOpen, setQuickLinksOpen] = React.useState(true);

  return (
    <div
      aria-hidden={!isOpen}
      className={`${isOpen ? "w-72 visible pointer-events-auto" : "w-0 invisible pointer-events-none"} transition-[width] duration-slow ease-standard overflow-hidden bg-surface-app border-r border-border-subtle flex flex-col h-full text-sm font-sans text-content-primary shrink-0`}
    >
      <div className="w-72 flex flex-col h-full">
        <div className="p-4 flex items-center justify-between border-b border-border-subtle">
          <div className="flex items-center gap-2 font-serif font-bold text-xl text-content-primary">
            <div className="w-7 h-7 bg-content-primary rounded-md flex items-center justify-center text-content-inverse text-sm font-bold font-sans">
              r0
            </div>
            r0nix
          </div>
          <button
            className="p-1 hover:bg-surface-hover rounded-md text-content-muted transition-colors"
            title={text.searchWorkspace}
            aria-label={text.searchWorkspace}
            onClick={onSearchWorkspace}
          >
            <Search size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-4">
          <div className="px-3 mb-2">
            <SectionTitle label={text.library} />
            <NavItem
              icon={<Library size={16} />}
              label={text.allDocuments}
              active={activeFilter === "all"}
              suffix={documentCount.toString()}
              onClick={() => onOpenLibrary("all", text.allDocuments)}
              onDoubleClick={() => onPinLibrary("all", text.allDocuments)}
              pinHint={text.pinHint}
            />
            <NavItem
              icon={<Clock size={16} />}
              label={text.recent}
              active={activeFilter === "recent"}
              onClick={() => onOpenLibrary("recent", text.recent)}
              onDoubleClick={() => onPinLibrary("recent", text.recent)}
              pinHint={text.pinHint}
            />
            <NavItem
              icon={<Star size={16} />}
              label={text.quickAccess}
              active={activeFilter === "quick-access"}
              suffix={favoriteCount.toString()}
              onClick={() => onOpenLibrary("quick-access", text.quickAccess)}
              onDoubleClick={() => onPinLibrary("quick-access", text.quickAccess)}
              pinHint={text.pinHint}
            />
            <NavItem
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                </svg>
              }
              label={text.whiteboards}
              active={activeFilter === "whiteboards"}
              onClick={() => onOpenLibrary("whiteboards", text.whiteboards)}
              onDoubleClick={() => onPinLibrary("whiteboards", text.whiteboards)}
              pinHint={text.pinHint}
            />
            <NavItem
              icon={<Trash2 size={16} />}
              label={text.trash}
              active={activeFilter === "trash"}
              onClick={() => onOpenLibrary("trash", text.trash)}
              onDoubleClick={() => onPinLibrary("trash", text.trash)}
              pinHint={text.pinHint}
            />
            <NavItem
              icon={<Star size={16} />}
              label={text.favorites}
              active={activeFilter === "favorites"}
              suffix={favoriteCount.toString()}
              onClick={() => onOpenLibrary("favorites", text.favorites)}
              onDoubleClick={() => onPinLibrary("favorites", text.favorites)}
              pinHint={text.pinHint}
            />
          </div>

          <div className="px-3 mb-2 mt-6">
            <div className="flex items-center justify-between text-xs font-serif font-semibold text-content-muted uppercase tracking-widest mb-2 px-2">
              <span>{text.collections}</span>
              <button
                className="hover:text-content-secondary transition-colors"
                title={text.createCollection}
                aria-label={text.createCollection}
                onClick={onCreateCollection}
              >
                <Plus size={14} />
              </button>
            </div>

            {collections.length > 0 ? (
              collections.map((collection) => {
                const filter = `collection:${collection.id}` as LibraryFilter;
                return (
                  <NavItem
                    key={collection.id}
                    icon={<Folder size={16} />}
                    label={collection.name}
                    active={activeFilter === filter}
                    suffix={collection.paths.length.toString()}
                    onClick={() => onOpenLibrary(filter, collection.name)}
                    onDoubleClick={() => onPinLibrary(filter, collection.name)}
                    pinHint={text.pinHint}
                  />
                );
              })
            ) : (
              <div className="px-2 py-1.5 text-[12px] text-content-muted italic">{text.noCollections}</div>
            )}
          </div>

          <div className="px-3 mb-2 mt-6">
            <div className="mb-2 flex items-center justify-between gap-2 px-2 text-xs font-serif font-semibold uppercase tracking-widest text-content-muted">
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left transition-colors hover:text-content-secondary"
                type="button"
                aria-expanded={quickLinksOpen}
                aria-label={text.quickLinks}
                onClick={() => setQuickLinksOpen((value) => !value)}
              >
                <ChevronDown
                  size={13}
                  className={`shrink-0 transition-transform duration-fast ${quickLinksOpen ? "rotate-0" : "-rotate-90"}`}
                />
                <span className="truncate">{text.quickLinks}</span>
              </button>
              <button
                className="shrink-0 rounded-md px-1 py-1 normal-case tracking-normal text-[11px] transition-colors hover:text-content-secondary"
                title={text.manageQuickLinks}
                aria-label={text.manageQuickLinks}
                onClick={onManageQuickLinks}
                type="button"
              >
                {text.manage}
              </button>
            </div>
            <div
              className={`overflow-hidden transition-[max-height,opacity,transform] duration-base ease-out ${
                quickLinksOpen ? "max-h-52 translate-y-0 opacity-100" : "max-h-0 -translate-y-1 opacity-0"
              }`}
            >
              {quickLinks.length > 0 ? (
                quickLinks.slice(0, 4).map((item) => (
                  <NavItem key={item.id} icon={<Link2 size={16} />} label={item.title} onClick={() => onOpenQuickLink(item.url)} />
                ))
              ) : (
                <div className="px-2 py-1.5 text-[12px] text-content-muted italic">{text.quickLinksHint}</div>
              )}
            </div>
          </div>

          <div className="px-3 mb-2 mt-6">
            <SectionTitle label={text.tools} />
            <NavItem icon={<Globe size={16} />} label={text.webBrowser} onClick={onOpenWeb} />
            <NavItem icon={<FileText size={16} />} label={text.openFile} onClick={onOpenFileDialog} />
            <NavItem icon={<FolderOpen size={16} />} label={text.importFolder} onClick={onImportFolder} />
          </div>
        </div>

        <div className="p-3 border-t border-border-subtle">
          <NavItem icon={<Settings size={16} />} label={text.settings} onClick={onOpenSettings} />
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ label }: { label: string }) {
  return <div className="text-xs font-serif font-semibold text-content-muted uppercase tracking-widest mb-2 px-2">{label}</div>;
}

function NavItem({
  icon,
  label,
  active,
  suffix,
  onClick,
  onDoubleClick,
  pinHint,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  suffix?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
  pinHint?: string;
}) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-md transition-colors text-left text-[13px] ${
        active
          ? "text-content-primary font-medium"
          : "text-content-secondary hover:bg-surface-hover/50 hover:text-content-primary font-medium"
      }`}
      style={active ? { backgroundColor: "var(--reader-accent-soft)" } : undefined}
      title={onDoubleClick ? pinHint : undefined}
      aria-label={label}
    >
      {icon}
      <span className="truncate flex-1">{label}</span>
      {suffix ? <span className="text-[11px] text-content-muted">{suffix}</span> : null}
    </button>
  );
}

