import { useEffect, useMemo, useRef, useState } from"react";
import {
  CheckSquare,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
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
} from"lucide-react";
import type { AppLanguage, QuickLinkItem } from"../services/userSettings";
import type { LibraryFilter, ReaderDocument } from"../types";

export const LIBRARY_SEARCH_FOCUS_EVENT ="pdf-reader-focus-library-search";

type LocalFilterMode ="all" |"favorites" |"with-progress" |"tagged";

const LOCAL_FILTERS: LocalFilterMode[] = ["all","favorites","with-progress","tagged"];

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

function isDocumentTrashed(doc: Pick<ReaderDocument,"trashedAt">) {
  return typeof doc.trashedAt ==="string" && doc.trashedAt.trim().length > 0;
}

function normalizePath(path: string) {
  return path.trim().toLowerCase();
}

const I18N = {
"zh-CN": {
    all:"全部",
    favorites:"收藏",
    withProgress:"有进度",
    tagged:"有标签",
    titleMap: {
      all:"全部文档",
      recent:"最近文档",
      favorites:"收藏",
"quick-access":"快捷访问",
      whiteboards:"白板",
      trash:"回收站",
      collection:"集合",
    },
    docsAvailable:"可用文档",
    searchPlaceholder:"搜索标题、作者、标签...",
    cycleFilter:"切换本地筛选",
    importFolder:"导入文件夹",
    openFile:"打开文件",
    export:"导出",
    emptyTrash:"回收站为空。删除的文档会在这里显示。",
    emptyFiltered:"当前搜索或筛选条件下无匹配文档。",
    emptyDefault:"当前视图无匹配文档。",
    title:"标题",
    addedDate:"添加日期",
    fileSize:"文件大小",
    tags:"标签",
    progress:"进度",
    actions:"操作",
    open:"打开",
    moveToTrash:"移入回收站",
    restore:"恢复",
    deletePermanently:"永久删除",
    removeFromCollection:"移出集合",
    addToCollection:"加入集合",
    selected:"已选",
    selectAll:"全选",
    restoreSelected:"恢复所选",
    deleteSelected:"永久删除所选",
    noDocuments:"无文档",
    exportTitle:"导出列表",
    quickLinks:"快捷链接",
    confirmDeleteOne:"永久删除该文档？这将一并删除注释与笔记。",
    confirmDeleteManyPrefix:"永久删除",
    confirmDeleteManySuffix:"个文档？这将一并删除注释与笔记。",
  },
"en-US": {
    all:"All",
    favorites:"Favorites",
    withProgress:"With Progress",
    tagged:"Tagged",
    titleMap: {
      all:"All Documents",
      recent:"Recent Documents",
      favorites:"Favorites",
"quick-access":"Quick Access",
      whiteboards:"Whiteboards",
      trash:"Trash",
      collection:"Collection",
    },
    docsAvailable:"documents available",
    searchPlaceholder:"Search title, author, tags...",
    cycleFilter:"Cycle local filter",
    importFolder:"Import Folder",
    openFile:"Open File",
    export:"Export",
    emptyTrash:"Trash is empty. Deleted documents will appear here.",
    emptyFiltered:"No documents matched the current search or local filter.",
    emptyDefault:"No documents matched this view.",
    title:"Title",
    addedDate:"Added",
    fileSize:"Size",
    tags:"Tags",
    progress:"Progress",
    actions:"Actions",
    open:"Open",
    moveToTrash:"Move to Trash",
    restore:"Restore",
    deletePermanently:"Delete Permanently",
    removeFromCollection:"Remove from collection",
    addToCollection:"Add to collection",
    selected:"Selected",
    selectAll:"Select all",
    restoreSelected:"Restore selected",
    deleteSelected:"Delete selected permanently",
    noDocuments:"No documents",
    exportTitle:"Export list",
    quickLinks:"Quick links",
    confirmDeleteOne:"Permanently delete this document? This will also remove its notes and annotations.",
    confirmDeleteManyPrefix:"Permanently delete",
    confirmDeleteManySuffix:"documents? This will also remove their notes and annotations.",
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
  const [sort, setSort] = useState<{ key:"title" |"addedDate" |"fileSize" |"progress"; direction:"asc" |"desc" }>(
    { key:"addedDate", direction:"desc" },
  );
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const collectionPathSet = useMemo(
    () => new Set((collectionPaths || []).map((path) => normalizePath(path))),
    [collectionPaths],
  );

  const isCollectionView = filter.startsWith("collection:");
  const isTrashView = filter ==="trash";

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
        if (filter ==="whiteboards") return false;
        if (filter ==="trash") return trashed;
        if (trashed) return false;

        if (filter ==="favorites") return doc.isFavorite;
        if (filter ==="recent") return doc.progress > 0;
        if (filter ==="quick-access") return doc.isFavorite || doc.progress > 0;
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
        if (localFilter ==="favorites" && !doc.isFavorite) return false;
        if (localFilter ==="with-progress" && doc.progress <= 0) return false;
        if (localFilter ==="tagged" && doc.tags.length === 0) return false;
        return true;
      })
      .filter((doc) => {
        if (!lowered) return true;
        const fullText =
`${doc.title} ${doc.authors.join("")} ${doc.journal} ${doc.path} ${doc.tags.join("")}`.toLowerCase();
        return fullText.includes(lowered);
      })
      .sort((a, b) => {
        if (isTrashView) {
          return new Date(b.trashedAt || b.lastOpenedAt).getTime() - new Date(a.trashedAt || a.lastOpenedAt).getTime();
        }
        const direction = sort.direction ==="asc" ? 1 : -1;
        if (sort.key ==="title") return direction * a.title.localeCompare(b.title, language);
        if (sort.key ==="fileSize") return direction * ((a.fileSize || 0) - (b.fileSize || 0));
        if (sort.key ==="progress") return direction * (a.progress - b.progress);
        return (
          direction *
          (new Date(a.addedAt || a.lastOpenedAt).getTime() - new Date(b.addedAt || b.lastOpenedAt).getTime())
        );
      });
  }, [collectionPathSet, documents, filter, isCollectionView, isTrashView, keyword, language, localFilter, sort]);

  const toggleSort = (key:"title" |"addedDate" |"fileSize" |"progress") => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction ==="asc" ?"desc" :"asc" }
        : { key, direction: key ==="title" ?"asc" :"desc" },
    );
  };

  const sortIcon = (key:"title" |"addedDate" |"fileSize" |"progress") =>
    sort.key !== key ? (
      <ArrowUpDown size={13} />
    ) : sort.direction ==="asc" ? (
      <ArrowUp size={13} />
    ) : (
      <ArrowDown size={13} />
    );

  const formatFileSize = (bytes?: number) => {
    if (!bytes || bytes <= 0) return"-";
    if (bytes < 1024) return`${bytes} B`;
    if (bytes < 1024 * 1024) return`${(bytes / 1024).toFixed(1)} KB`;
    return`${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

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
      : t.titleMap[filter as Exclude<LibraryFilter,`collection:${string}`>]);

  const emptyMessage = isTrashView
    ? t.emptyTrash
    : keyword.trim() || localFilter !=="all"
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
    localFilter ==="all"
      ? t.all
      : localFilter ==="favorites"
        ? t.favorites
        : localFilter ==="with-progress"
          ? t.withProgress
          : t.tagged;

  const toggleTrashSelection = (docId: string) => {
    setSelectedTrashIds((current) =>
      current.includes(docId) ? current.filter((item) => item !== docId) : [...current, docId],
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
      count === 1 ? t.confirmDeleteOne :`${t.confirmDeleteManyPrefix} ${count} ${t.confirmDeleteManySuffix}`,
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
    <div className="flex flex-col h-full bg-surface-panel text-content-primary font-sans">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle gap-4">
        <div>
          <h1 className="text-2xl font-serif font-bold tracking-tight text-content-primary">{pageTitle}</h1>
          <p className="text-xs text-content-muted mt-1">
            {filteredDocs.length} {t.docsAvailable}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-muted" />
            <input
              ref={searchInputRef}
              id="library-search-input"
              type="text"
              placeholder={t.searchPlaceholder}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              className="pl-9 pr-4 py-1.5 bg-surface-sunken border-none rounded-md text-sm focus:ring-2 focus:outline-none w-64 transition-all text-content-primary placeholder:text-content-muted"
            />
          </div>

          <button
            className="p-1.5 text-content-muted hover:bg-[var(--reader-accent-soft)] hover:text-[var(--reader-accent)] rounded-md transition-colors"
            title={`${t.cycleFilter} (${localFilterLabel})`}
            onClick={cycleLocalFilter}
          >
            <Filter size={18} />
          </button>

          <button
            className="p-1.5 text-content-muted hover:bg-[var(--reader-accent-soft)] hover:text-[var(--reader-accent)] rounded-md transition-colors"
            title={t.export}
            onClick={() => onExportList?.(filteredDocs, pageTitle || t.exportTitle)}
          >
            <Download size={18} />
          </button>

          <button
            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-content-muted bg-surface-sunken hover:bg-surface-hover transition-colors"
            onClick={onImportFolder}
            title={t.importFolder}
            aria-label={t.importFolder}
          >
            <FolderOpen size={14} />
          </button>

          <button
            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-xs font-medium"
            style={{ backgroundColor:"var(--reader-accent)", color:"var(--reader-accent-contrast)" }}
            onClick={onOpenFileDialog}
            title={t.openFile}
            aria-label={t.openFile}
          >
            <FileText size={14} />
          </button>
        </div>
      </div>

      {isTrashView ? (
        <div className="px-6 py-3 border-b border-border-subtle bg-surface-app/70 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-content-secondary">
            <button
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-surface-hover transition-colors"
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
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-surface-hover hover:bg-surface-active disabled:opacity-40"
              disabled={selectedTrashIds.length === 0}
              onClick={handleBatchRestore}
              title={t.restoreSelected}
              aria-label={t.restoreSelected}
            >
              <Undo2 size={13} />
            </button>
            <button
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-state-danger-tint/15 text-state-danger hover:bg-state-danger-tint/25 disabled:opacity-40"
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
          <div className="h-full flex items-center justify-center text-sm text-content-muted px-6 text-center">
            {emptyMessage}
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-surface-app/90 backdrop-blur-sm z-10 text-xs font-semibold text-content-muted uppercase tracking-wider border-b border-border-subtle">
              <tr>
                {isTrashView ? <th className="px-4 py-3 w-10" /> : null}
                <th className="px-4 py-3 w-10" />
                <th className="px-4 py-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 hover:text-[var(--reader-accent)]"
                    onClick={() => toggleSort("title")}
                  >
                    {t.title} {sortIcon("title")}
                  </button>
                </th>
                <th className="px-4 py-3 w-36">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 hover:text-[var(--reader-accent)]"
                    onClick={() => toggleSort("addedDate")}
                  >
                    {t.addedDate} {sortIcon("addedDate")}
                  </button>
                </th>
                <th className="px-4 py-3 w-28">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 hover:text-[var(--reader-accent)]"
                    onClick={() => toggleSort("fileSize")}
                  >
                    {t.fileSize} {sortIcon("fileSize")}
                  </button>
                </th>
                <th className="px-4 py-3 w-44">{t.tags}</th>
                <th className="px-4 py-3 w-32">{t.progress}</th>
                <th className="px-4 py-3 w-16" />
              </tr>
            </thead>

            <tbody className="text-sm divide-y divide-border-subtle">
              {filteredDocs.map((doc) => {
                const selected = selectedSet.has(doc.id);
                const inCollection = collectionPathSet.has(normalizePath(doc.path));

                return (
                  <tr key={doc.id} className="hover:bg-surface-hover/40 transition-colors group">
                    {isTrashView ? (
                      <td className="px-4 py-3">
                        <button
                          className="text-content-muted hover:text-content-primary"
                          onClick={() => toggleTrashSelection(doc.id)}
                          title={selected ? t.selected : t.selectAll}
                        >
                          {selected ? <CheckSquare size={15} /> : <Square size={15} />}
                        </button>
                      </td>
                    ) : null}

                    <td className="px-4 py-3">
                      <button
                        className={`text-content-disabled hover:text-state-warn transition-colors ${doc.isFavorite ?"text-state-warn" :""}`}
                        onClick={() => onToggleFavorite(doc.id)}
                        title={t.favorites}
                      >
                        <Star size={16} fill={doc.isFavorite ?"currentColor" :"none"} />
                      </button>
                    </td>

                    <td className="px-4 py-3">
                      <button
                        className="font-medium text-content-primary hover:underline text-left"
                        onClick={() => onOpenPdf(doc)}
                        title={doc.path}
                      >
                        {doc.title}
                      </button>
                    </td>

                    <td className="px-4 py-3 text-content-secondary">
                      {new Date(doc.addedAt || doc.lastOpenedAt).toLocaleDateString(
                        language ==="zh-CN" ?"zh-CN" :"en-US",
                      )}
                    </td>
                    <td className="px-4 py-3 text-content-secondary">{formatFileSize(doc.fileSize)}</td>

                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {doc.tags.length > 0 ? (
                          doc.tags.slice(0, 4).map((tag) => (
                            <span
                              key={`${doc.id}-${tag}`}
                              className="px-2 py-0.5 bg-surface-sunken text-content-secondary rounded text-xs font-medium"
                            >
                              {tag}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-content-disabled">-</span>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-surface-sunken rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width:`${doc.progress}%`, backgroundColor:"var(--reader-accent)" }}
                          />
                        </div>
                        <span className="text-xs font-mono text-content-muted">{doc.progress}%</span>
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        {isTrashView ? (
                          <button
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-state-danger hover:bg-state-danger-tint/15 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity"
                            onClick={() => handleSingleDelete(doc.id)}
                            title={t.deletePermanently}
                            aria-label={t.deletePermanently}
                          >
                            <X size={13} />
                          </button>
                        ) : isCollectionView ? (
                          <button
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-content-muted hover:bg-surface-hover opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity"
                            onClick={() => onToggleDocumentInCollection?.(doc.path)}
                            title={inCollection ? t.removeFromCollection : t.addToCollection}
                            aria-label={inCollection ? t.removeFromCollection : t.addToCollection}
                          >
                            <X size={13} />
                          </button>
                        ) : (
                          <button
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-content-muted hover:bg-surface-hover opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity"
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
        <div className="px-6 py-2 border-t border-border-subtle text-xs text-content-muted flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="shrink-0">{t.quickLinks}:</span>
          {quickLinks.slice(0, 8).map((item) => (
            <button
              key={item.id}
              className="px-2 py-1 rounded-md bg-surface-sunken hover:bg-surface-hover whitespace-nowrap"
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
