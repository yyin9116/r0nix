import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  Download,
  FileText,
  Filter,
  FolderOpen,
  Search,
  Square,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { AppLanguage, QuickLinkItem } from "../services/userSettings";
import type { LibraryFilter, ReaderDocument } from "../types";

export const LIBRARY_SEARCH_FOCUS_EVENT = "pdf-reader-focus-library-search";

type LocalFilterMode = "all" | "favorites" | "with-progress" | "tagged";

const LOCAL_FILTERS: LocalFilterMode[] = ["all", "favorites", "with-progress", "tagged"];

interface LibraryProps {
  filter: LibraryFilter;
  filterTitle?: string;
  documents: ReaderDocument[];
  collectionPaths?: string[];
  quickLinks: QuickLinkItem[];
  onOpenPdf: (doc: ReaderDocument) => void;
  onOpenFileDialog: () => void;
  onImportFolder: () => void;
  onOpenQuickLink: (url: string) => void;
  onToggleFavorite: (docId: string) => void;
  onToggleDocumentInCollection?: (docPath: string) => void;
  onMoveToTrash?: (docId: string) => void;
  onDeleteDocument?: (docId: string) => void;
  onBatchRestoreFromTrash?: (docIds: string[]) => void;
  onBatchDeleteDocuments?: (docIds: string[]) => void;
  onExportList?: (docs: ReaderDocument[], title: string) => void;
  language: AppLanguage;
}

function isDocumentTrashed(doc: Pick<ReaderDocument, "trashedAt">) {
  return typeof doc.trashedAt === "string" && doc.trashedAt.trim().length > 0;
}

function normalizePath(path: string) {
  return path.trim().toLowerCase();
}

const I18N = {
  "zh-CN": {
    all: "全部",
    favorites: "收藏",
    withProgress: "有进度",
    tagged: "有标签",
    titleMap: {
      all: "全部文档",
      recent: "最近文档",
      favorites: "收藏",
      "quick-access": "快捷访问",
      whiteboards: "白板",
      trash: "回收站",
      collection: "集合",
    },
    docsAvailable: "可用文档",
    searchPlaceholder: "搜索标题、作者、标签...",
    cycleFilter: "切换本地筛选",
    importFolder: "导入文件夹",
    openFile: "打开文件",
    export: "导出",
    emptyTrash: "回收站为空。删除的文档会在这里显示。",
    emptyFiltered: "当前搜索或筛选条件下无匹配文档。",
    emptyDefault: "当前视图无匹配文档。",
    title: "标题",
    authors: "作者",
    year: "年份",
    journal: "期刊",
    tags: "标签",
    progress: "进度",
    actions: "操作",
    open: "打开",
    moveToTrash: "移入回收站",
    restore: "恢复",
    deletePermanently: "永久删除",
    removeFromCollection: "移出集合",
    addToCollection: "加入集合",
    selected: "已选",
    selectAll: "全选",
    restoreSelected: "恢复所选",
    deleteSelected: "永久删除所选",
    noDocuments: "无文档",
    exportTitle: "导出列表",
    quickLinks: "快捷链接",
    confirmDeleteOne: "永久删除该文档？这将一并删除注释与笔记。",
    confirmDeleteManyPrefix: "永久删除",
    confirmDeleteManySuffix: "个文档？这将一并删除注释与笔记。",
  },
  "en-US": {
    all: "All",
    favorites: "Favorites",
    withProgress: "With Progress",
    tagged: "Tagged",
    titleMap: {
      all: "All Documents",
      recent: "Recent Documents",
      favorites: "Favorites",
      "quick-access": "Quick Access",
      whiteboards: "Whiteboards",
      trash: "Trash",
      collection: "Collection",
    },
    docsAvailable: "documents available",
    searchPlaceholder: "Search title, author, tags...",
    cycleFilter: "Cycle local filter",
    importFolder: "Import Folder",
    openFile: "Open File",
    export: "Export",
    emptyTrash: "Trash is empty. Deleted documents will appear here.",
    emptyFiltered: "No documents matched the current search or local filter.",
    emptyDefault: "No documents matched this view.",
    title: "Title",
    authors: "Authors",
    year: "Year",
    journal: "Journal",
    tags: "Tags",
    progress: "Progress",
    actions: "Actions",
    open: "Open",
    moveToTrash: "Move to Trash",
    restore: "Restore",
    deletePermanently: "Delete Permanently",
    removeFromCollection: "Remove from collection",
    addToCollection: "Add to collection",
    selected: "Selected",
    selectAll: "Select all",
    restoreSelected: "Restore selected",
    deleteSelected: "Delete selected permanently",
    noDocuments: "No documents",
    exportTitle: "Export list",
    quickLinks: "Quick links",
    confirmDeleteOne: "Permanently delete this document? This will also remove its notes and annotations.",
    confirmDeleteManyPrefix: "Permanently delete",
    confirmDeleteManySuffix: "documents? This will also remove their notes and annotations.",
  },
} as const;

export function Library({
  filter,
  filterTitle,
  documents,
  collectionPaths,
  quickLinks,
  onOpenPdf,
  onOpenFileDialog,
  onImportFolder,
  onOpenQuickLink,
  onToggleFavorite,
  onToggleDocumentInCollection,
  onMoveToTrash,
  onDeleteDocument,
  onBatchRestoreFromTrash,
  onBatchDeleteDocuments,
  onExportList,
  language,
}: LibraryProps) {
  const t = I18N[language];
  const [keyword, setKeyword] = useState("");
  const [localFilter, setLocalFilter] = useState<LocalFilterMode>("all");
  const [selectedTrashIds, setSelectedTrashIds] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const collectionPathSet = useMemo(
    () => new Set((collectionPaths || []).map((path) => normalizePath(path))),
    [collectionPaths]
  );

  const isCollectionView = filter.startsWith("collection:");
  const isTrashView = filter === "trash";

  useEffect(() => {
    const handleFocusSearch = () => {
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };

    window.addEventListener(LIBRARY_SEARCH_FOCUS_EVENT, handleFocusSearch);
    return () => window.removeEventListener(LIBRARY_SEARCH_FOCUS_EVENT, handleFocusSearch);
  }, []);

  useEffect(() => {
    setLocalFilter("all");
    setKeyword("");
    setSelectedTrashIds([]);
  }, [filter]);

  const filteredDocs = useMemo(() => {
    const lowered = keyword.trim().toLowerCase();

    return documents
      .filter((doc) => {
        const trashed = isDocumentTrashed(doc);
        if (filter === "whiteboards") return false;
        if (filter === "trash") return trashed;
        if (trashed) return false;

        if (filter === "favorites") return doc.isFavorite;
        if (filter === "recent") return doc.progress > 0;
        if (filter === "quick-access") return doc.isFavorite || doc.progress > 0;
        if (filter.startsWith("collection:")) return true;
        return true;
      })
      .filter((doc) => {
        if (isCollectionView) {
          const inCollection = collectionPathSet.has(normalizePath(doc.path));
          if (!inCollection) return false;
        }
        return true;
      })
      .filter((doc) => {
        if (localFilter === "favorites" && !doc.isFavorite) return false;
        if (localFilter === "with-progress" && doc.progress <= 0) return false;
        if (localFilter === "tagged" && doc.tags.length === 0) return false;
        return true;
      })
      .filter((doc) => {
        if (!lowered) return true;
        const fullText = `${doc.title} ${doc.authors.join(" ")} ${doc.journal} ${doc.path} ${doc.tags.join(" ")}`.toLowerCase();
        return fullText.includes(lowered);
      })
      .sort((a, b) => {
        if (isTrashView) {
          return new Date(b.trashedAt || b.lastOpenedAt).getTime() - new Date(a.trashedAt || a.lastOpenedAt).getTime();
        }
        return new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime();
      });
  }, [collectionPathSet, documents, filter, isCollectionView, isTrashView, keyword, localFilter]);

  useEffect(() => {
    if (!isTrashView) {
      if (selectedTrashIds.length > 0) setSelectedTrashIds([]);
      return;
    }
    const available = new Set(filteredDocs.map((doc) => doc.id));
    setSelectedTrashIds((prev) => prev.filter((id) => available.has(id)));
  }, [filteredDocs, isTrashView, selectedTrashIds.length]);

  const pageTitle =
    filterTitle ||
    (filter.startsWith("collection:")
      ? t.titleMap.collection
      : t.titleMap[filter as Exclude<LibraryFilter, `collection:${string}`>]);

  const emptyMessage = isTrashView
    ? t.emptyTrash
    : keyword.trim() || localFilter !== "all"
      ? t.emptyFiltered
      : t.emptyDefault;

  const selectedSet = useMemo(() => new Set(selectedTrashIds), [selectedTrashIds]);
  const allTrashSelected = isTrashView && filteredDocs.length > 0 && selectedTrashIds.length === filteredDocs.length;

  const cycleLocalFilter = () => {
    setLocalFilter((current) => {
      const index = LOCAL_FILTERS.indexOf(current);
      return LOCAL_FILTERS[(index + 1) % LOCAL_FILTERS.length];
    });
  };

  const localFilterLabel =
    localFilter === "all"
      ? t.all
      : localFilter === "favorites"
        ? t.favorites
        : localFilter === "with-progress"
          ? t.withProgress
          : t.tagged;

  const toggleTrashSelection = (docId: string) => {
    setSelectedTrashIds((current) =>
      current.includes(docId) ? current.filter((item) => item !== docId) : [...current, docId]
    );
  };

  const toggleSelectAllTrash = () => {
    if (allTrashSelected) {
      setSelectedTrashIds([]);
      return;
    }
    setSelectedTrashIds(filteredDocs.map((doc) => doc.id));
  };

  const confirmPermanentDelete = (count: number) =>
    window.confirm(
      count === 1
        ? t.confirmDeleteOne
        : `${t.confirmDeleteManyPrefix} ${count} ${t.confirmDeleteManySuffix}`
    );

  const handleSingleDelete = (docId: string) => {
    if (!confirmPermanentDelete(1)) return;
    onDeleteDocument?.(docId);
  };

  const handleBatchRestore = () => {
    if (selectedTrashIds.length === 0) return;
    onBatchRestoreFromTrash?.(selectedTrashIds);
    setSelectedTrashIds([]);
  };

  const handleBatchDelete = () => {
    if (selectedTrashIds.length === 0) return;
    if (!confirmPermanentDelete(selectedTrashIds.length)) return;
    onBatchDeleteDocuments?.(selectedTrashIds);
    setSelectedTrashIds([]);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 font-sans">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 gap-4">
        <div>
          <h1 className="text-2xl font-serif font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{pageTitle}</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {filteredDocs.length} {t.docsAvailable}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
            <input
              ref={searchInputRef}
              id="library-search-input"
              type="text"
              placeholder={t.searchPlaceholder}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              className="pl-9 pr-4 py-1.5 bg-zinc-100 dark:bg-zinc-800 border-none rounded-md text-sm focus:ring-2 focus:outline-none w-64 transition-all text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
            />
          </div>

          <button
            className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors"
            title={`${t.cycleFilter} (${localFilterLabel})`}
            onClick={cycleLocalFilter}
          >
            <Filter size={18} />
          </button>

          <button
            className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors"
            title={t.export}
            onClick={() => onExportList?.(filteredDocs, pageTitle || t.exportTitle)}
          >
            <Download size={18} />
          </button>

          <button
            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            onClick={onImportFolder}
            title={t.importFolder}
            aria-label={t.importFolder}
          >
            <FolderOpen size={14} />
          </button>

          <button
            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-xs font-medium"
            style={{ backgroundColor: "var(--reader-accent)", color: "var(--reader-accent-contrast)" }}
            onClick={onOpenFileDialog}
            title={t.openFile}
            aria-label={t.openFile}
          >
            <FileText size={14} />
          </button>
        </div>
      </div>

      {isTrashView ? (
        <div className="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-950/50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <button
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              onClick={toggleSelectAllTrash}
            >
              {allTrashSelected ? <CheckSquare size={14} /> : <Square size={14} />}
              {t.selectAll}
            </button>
            <span>
              {t.selected}: {selectedTrashIds.length}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-40"
              disabled={selectedTrashIds.length === 0}
              onClick={handleBatchRestore}
              title={t.restoreSelected}
              aria-label={t.restoreSelected}
            >
              <Undo2 size={13} />
            </button>
            <button
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 disabled:opacity-40"
              disabled={selectedTrashIds.length === 0}
              onClick={handleBatchDelete}
              title={t.deleteSelected}
              aria-label={t.deleteSelected}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        {filteredDocs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-zinc-500 dark:text-zinc-400 px-6 text-center">
            {emptyMessage}
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-zinc-50/90 dark:bg-zinc-950/90 backdrop-blur-sm z-10 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                {isTrashView ? <th className="px-4 py-3 w-10" /> : null}
                <th className="px-4 py-3 w-10" />
                <th className="px-4 py-3">{t.title}</th>
                <th className="px-4 py-3">{t.authors}</th>
                <th className="px-4 py-3 w-24">{t.year}</th>
                <th className="px-4 py-3 w-32">{t.journal}</th>
                <th className="px-4 py-3 w-44">{t.tags}</th>
                <th className="px-4 py-3 w-32">{t.progress}</th>
                <th className="px-4 py-3 w-16" />
              </tr>
            </thead>

            <tbody className="text-sm divide-y divide-zinc-100 dark:divide-zinc-800">
              {filteredDocs.map((doc) => {
                const selected = selectedSet.has(doc.id);
                const inCollection = collectionPathSet.has(normalizePath(doc.path));

                return (
                  <tr key={doc.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group">
                    {isTrashView ? (
                      <td className="px-4 py-3">
                        <button
                          className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                          onClick={() => toggleTrashSelection(doc.id)}
                          title={selected ? t.selected : t.selectAll}
                        >
                          {selected ? <CheckSquare size={15} /> : <Square size={15} />}
                        </button>
                      </td>
                    ) : null}

                    <td className="px-4 py-3">
                      <button
                        className={`text-zinc-300 dark:text-zinc-600 hover:text-yellow-400 dark:hover:text-yellow-500 transition-colors ${doc.isFavorite ? "text-yellow-400 dark:text-yellow-500" : ""}`}
                        onClick={() => onToggleFavorite(doc.id)}
                        title={t.favorites}
                      >
                        <Star size={16} fill={doc.isFavorite ? "currentColor" : "none"} />
                      </button>
                    </td>

                    <td className="px-4 py-3">
                      <button
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline text-left"
                        onClick={() => onOpenPdf(doc)}
                        title={doc.path}
                      >
                        {doc.title}
                      </button>
                    </td>

                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{doc.authors.join(", ")}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{doc.year || "-"}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{doc.journal || "-"}</td>

                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {doc.tags.length > 0
                          ? doc.tags.slice(0, 4).map((tag) => (
                              <span
                                key={`${doc.id}-${tag}`}
                                className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 rounded text-xs font-medium"
                              >
                                {tag}
                              </span>
                            ))
                          : <span className="text-xs text-zinc-400">-</span>}
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                          <div className="h-full bg-zinc-900 dark:bg-zinc-100 rounded-full" style={{ width: `${doc.progress}%` }} />
                        </div>
                        <span className="text-xs font-mono text-zinc-500 dark:text-zinc-500">{doc.progress}%</span>
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        {isTrashView ? (
                          <button
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/15 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity"
                            onClick={() => handleSingleDelete(doc.id)}
                            title={t.deletePermanently}
                            aria-label={t.deletePermanently}
                          >
                            <X size={13} />
                          </button>
                        ) : isCollectionView ? (
                          <button
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity"
                            onClick={() => onToggleDocumentInCollection?.(doc.path)}
                            title={inCollection ? t.removeFromCollection : t.addToCollection}
                            aria-label={inCollection ? t.removeFromCollection : t.addToCollection}
                          >
                            <X size={13} />
                          </button>
                        ) : (
                          <button
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity"
                            onClick={() => onMoveToTrash?.(doc.id)}
                            title={t.moveToTrash}
                            aria-label={t.moveToTrash}
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {quickLinks.length > 0 ? (
        <div className="px-6 py-2 border-t border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="shrink-0">{t.quickLinks}:</span>
          {quickLinks.slice(0, 8).map((item) => (
            <button
              key={item.id}
              className="px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 whitespace-nowrap"
              onClick={() => onOpenQuickLink(item.url)}
            >
              {item.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
