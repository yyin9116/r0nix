import { useEffect, useMemo, useState } from "react";
import { Download, FolderPlus, Library, Star, StarOff, Trash2 } from "../icons";
import type { AppLanguage, FavoriteItem, RecentFileItem } from "../App";
import "./LibraryPanel.css";

export interface LibraryCollection {
  id: string;
  name: string;
  paths: string[];
  createdAt: string;
}

interface LibraryPanelProps {
  language: AppLanguage;
  recentFiles: RecentFileItem[];
  favorites: FavoriteItem[];
  collections: LibraryCollection[];
  onOpenRecentFile: (path: string) => void;
  onTogglePdfFavorite: (path: string, name: string) => void;
  onCreateCollection: (name: string) => void;
  onDeleteCollection: (id: string) => void;
  onRenameCollection: (id: string, name: string) => void;
  onToggleCollectionPath: (collectionId: string, path: string) => void;
  onExportList: (format: "csv" | "md" | "json", items: RecentFileItem[]) => Promise<void> | void;
}

type CollectionFilter = "all" | "favorites" | string;

const TXT = {
  zh: {
    title: "资料库",
    allPapers: "全部文献",
    favorites: "收藏",
    collections: "收藏夹",
    noCollections: "还没有收藏夹",
    newCollectionPlaceholder: "新收藏夹名称",
    save: "保存",
    rename: "重命名",
    delete: "删除",
    searchPlaceholder: "按标题或路径搜索",
    hideMissing: "隐藏失效文件",
    exportCsv: "导出 CSV",
    exportMarkdown: "导出 Markdown",
    exportJson: "导出 JSON",
    totalDocs: "文献总数",
    totalFavorites: "收藏数量",
    readHours: "累计阅读小时",
    docHeader: "文献",
    lastReadHeader: "最近阅读",
    actionsHeader: "操作",
    open: "打开",
    favorite: "收藏",
    unfavorite: "取消收藏",
    add: "加入",
    remove: "移除",
    noMatchedDocs: "没有匹配的文献",
  },
  en: {
    title: "Library",
    allPapers: "All papers",
    favorites: "Favorites",
    collections: "Collections",
    noCollections: "No collections yet",
    newCollectionPlaceholder: "New collection name",
    save: "Save",
    rename: "Rename",
    delete: "Delete",
    searchPlaceholder: "Search by title or path",
    hideMissing: "Hide missing files",
    exportCsv: "Export CSV",
    exportMarkdown: "Export Markdown",
    exportJson: "Export JSON",
    totalDocs: "Total docs",
    totalFavorites: "Favorites",
    readHours: "Read hours",
    docHeader: "Document",
    lastReadHeader: "Last read",
    actionsHeader: "Actions",
    open: "Open",
    favorite: "Favorite",
    unfavorite: "Unfavorite",
    add: "Add",
    remove: "Remove",
    noMatchedDocs: "No documents matched",
  },
} as const;

function samePath(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function fmtTime(value: string | undefined, language: AppLanguage) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(language === "zh" ? "zh-CN" : "en-US");
}

function toDayStart(input: Date) {
  const next = new Date(input);
  next.setHours(0, 0, 0, 0);
  return next;
}

function toDayKey(input: Date) {
  const y = input.getFullYear();
  const m = String(input.getMonth() + 1).padStart(2, "0");
  const d = String(input.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatHours(seconds: number, language: AppLanguage) {
  const hours = seconds / 3600;
  return language === "zh" ? `${hours.toFixed(1)} 小时` : `${hours.toFixed(1)} h`;
}

export default function LibraryPanel({
  language,
  recentFiles,
  favorites,
  collections,
  onOpenRecentFile,
  onTogglePdfFavorite,
  onCreateCollection,
  onDeleteCollection,
  onRenameCollection,
  onToggleCollectionPath,
  onExportList,
}: LibraryPanelProps) {
  const t = TXT[language];
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const [hideMissing, setHideMissing] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [editingCollectionId, setEditingCollectionId] = useState("");
  const [editingCollectionName, setEditingCollectionName] = useState("");

  useEffect(() => {
    if (filter === "all" || filter === "favorites") return;
    if (collections.some((item) => item.id === filter)) return;
    setFilter("all");
  }, [collections, filter]);

  useEffect(() => {
    if (!editingCollectionId) return;
    if (collections.some((item) => item.id === editingCollectionId)) return;
    setEditingCollectionId("");
    setEditingCollectionName("");
  }, [collections, editingCollectionId]);

  const pdfFavoriteSet = useMemo(() => {
    const set = new Set<string>();
    for (const item of favorites) {
      if (item.type === "pdf") set.add(item.target.trim().toLowerCase());
    }
    return set;
  }, [favorites]);

  const selectedCollection =
    filter !== "all" && filter !== "favorites"
      ? collections.find((item) => item.id === filter) || null
      : null;

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return recentFiles
      .filter((item) => {
        if (hideMissing && item.missing) return false;
        if (filter === "favorites" && !pdfFavoriteSet.has(item.path.trim().toLowerCase())) return false;
        if (selectedCollection) {
          const hit = selectedCollection.paths.some((path) => samePath(path, item.path));
          if (!hit) return false;
        }
        if (!keyword) return true;
        return `${item.name} ${item.path}`.toLowerCase().includes(keyword);
      })
      .sort((a, b) => {
        const t1 = new Date(a.lastOpenedAt || 0).getTime();
        const t2 = new Date(b.lastOpenedAt || 0).getTime();
        return t2 - t1;
      });
  }, [hideMissing, filter, pdfFavoriteSet, recentFiles, search, selectedCollection]);

  const totalReadHours = useMemo(() => {
    const sec = recentFiles.reduce((sum, item) => sum + (item.totalReadSeconds || 0), 0);
    return (sec / 3600).toFixed(1);
  }, [recentFiles]);

  const activity = useMemo(() => {
    const daySeconds = new Map<string, number>();
    const now = toDayStart(new Date());
    const rangeStart = toDayStart(new Date(now));
    rangeStart.setDate(rangeStart.getDate() - 364);
    const gridStart = toDayStart(new Date(rangeStart));
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const gridEnd = toDayStart(new Date(now));
    gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

    for (const item of recentFiles) {
      if (item.sessions && item.sessions.length > 0) {
        for (const session of item.sessions) {
          const when = Date.parse(session.closedAt || session.openedAt);
          if (!Number.isFinite(when)) continue;
          const day = toDayStart(new Date(when));
          const key = toDayKey(day);
          const prev = daySeconds.get(key) || 0;
          daySeconds.set(key, prev + Math.max(0, session.durationSec || 0));
        }
      } else if (item.lastOpenedAt) {
        const when = Date.parse(item.lastOpenedAt);
        if (Number.isFinite(when)) {
          const day = toDayStart(new Date(when));
          const key = toDayKey(day);
          const prev = daySeconds.get(key) || 0;
          daySeconds.set(key, prev + Math.max(0, Math.min(item.totalReadSeconds || 0, 1800)));
        }
      }
    }

    const dayList: Array<{ date: Date; key: string; seconds: number; inRange: boolean; level: number }> = [];
    let maxSeconds = 0;
    let totalSeconds = 0;
    for (let cursor = new Date(gridStart); cursor <= gridEnd; cursor.setDate(cursor.getDate() + 1)) {
      const day = toDayStart(new Date(cursor));
      const key = toDayKey(day);
      const inRange = day >= rangeStart && day <= now;
      const seconds = inRange ? daySeconds.get(key) || 0 : 0;
      if (inRange) {
        maxSeconds = Math.max(maxSeconds, seconds);
        totalSeconds += seconds;
      }
      dayList.push({ date: day, key, seconds, inRange, level: 0 });
    }

    const resolved = dayList.map((item) => {
      if (!item.inRange || item.seconds <= 0) return { ...item, level: 0 };
      if (maxSeconds <= 0) return { ...item, level: 1 };
      const ratio = item.seconds / maxSeconds;
      if (ratio <= 0.25) return { ...item, level: 1 };
      if (ratio <= 0.5) return { ...item, level: 2 };
      if (ratio <= 0.75) return { ...item, level: 3 };
      return { ...item, level: 4 };
    });

    const weeks: Array<typeof resolved> = [];
    for (let i = 0; i < resolved.length; i += 7) {
      weeks.push(resolved.slice(i, i + 7));
    }

    const monthLabels = weeks.map((week, idx) => {
      if (!week[0]) return "";
      const day = week[0].date;
      if (idx === 0 || day.getDate() <= 7) {
        return day.toLocaleString(language === "zh" ? "zh-CN" : "en-US", { month: "short" });
      }
      return "";
    });

    return { weeks, monthLabels, totalSeconds, maxSeconds };
  }, [language, recentFiles]);

  const tActivity = language === "zh"
    ? {
        title: "全年阅读热力图",
        hint: "最近 365 天阅读活跃度（类似 Git 贡献图）",
        less: "少",
        more: "多",
        legendHint: "颜色分级说明",
        legendDetail: "L0 无记录 · L1 低 · L2 中 · L3 高 · L4 峰值（相对过去 365 天单日最高值）",
        peak: "单日峰值",
      }
    : {
        title: "Yearly Reading Heatmap",
        hint: "Last 365 days reading activity (Git-like)",
        less: "Less",
        more: "More",
        legendHint: "Color meaning",
        legendDetail: "L0 none · L1 low · L2 medium · L3 high · L4 peak (relative to max day in last 365 days)",
        peak: "Peak day",
      };

  return (
    <section className="library-page">
      <aside className="library-sidebar">
        <div className="library-side-title">
          <Library size={14} />
          <span>{t.title}</span>
        </div>
        <button
          type="button"
          className={`library-filter-btn ${filter === "all" ? "active" : ""}`}
          onClick={() => setFilter("all")}
        >
          {t.allPapers}
          <span>{recentFiles.length}</span>
        </button>
        <button
          type="button"
          className={`library-filter-btn ${filter === "favorites" ? "active" : ""}`}
          onClick={() => setFilter("favorites")}
        >
          {t.favorites}
          <span>{pdfFavoriteSet.size}</span>
        </button>
        <div className="library-side-subtitle">{t.collections}</div>
        <div className="library-collection-list">
          {collections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              className={`library-filter-btn ${filter === collection.id ? "active" : ""}`}
              onClick={() => setFilter(collection.id)}
            >
              <span className="library-filter-name">{collection.name}</span>
              <span>{collection.paths.length}</span>
            </button>
          ))}
          {collections.length === 0 ? (
            <div className="library-empty-note">{t.noCollections}</div>
          ) : null}
        </div>
        <div className="library-create-row">
          <input
            type="text"
            value={newCollectionName}
            placeholder={t.newCollectionPlaceholder}
            onChange={(e) => setNewCollectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const value = newCollectionName.trim();
                if (!value) return;
                onCreateCollection(value);
                setNewCollectionName("");
              }
            }}
          />
          <button
            type="button"
            onClick={() => {
              const value = newCollectionName.trim();
              if (!value) return;
              onCreateCollection(value);
              setNewCollectionName("");
            }}
            title={t.add}
          >
            <FolderPlus size={13} />
          </button>
        </div>
        {selectedCollection ? (
          <div className="library-selected-actions">
            {editingCollectionId === selectedCollection.id ? (
              <>
                <input
                  type="text"
                  className="library-inline-input"
                  value={editingCollectionName}
                  onChange={(e) => setEditingCollectionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const next = editingCollectionName.trim();
                      if (!next) return;
                      onRenameCollection(selectedCollection.id, next);
                      setEditingCollectionId("");
                      setEditingCollectionName("");
                    }
                    if (e.key === "Escape") {
                      setEditingCollectionId("");
                      setEditingCollectionName("");
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = editingCollectionName.trim();
                    if (!next) return;
                    onRenameCollection(selectedCollection.id, next);
                    setEditingCollectionId("");
                    setEditingCollectionName("");
                  }}
                >
                  {t.save}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditingCollectionId(selectedCollection.id);
                  setEditingCollectionName(selectedCollection.name);
                }}
              >
                {t.rename}
              </button>
            )}
            <button type="button" className="danger" onClick={() => onDeleteCollection(selectedCollection.id)}>
              <Trash2 size={13} />
              <span>{t.delete}</span>
            </button>
          </div>
        ) : null}
      </aside>

      <div className="library-main">
        <header className="library-header">
          <div className="library-search-wrap">
            <input
              type="text"
              value={search}
              placeholder={t.searchPlaceholder}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label className="library-checkbox">
              <input
                type="checkbox"
                checked={hideMissing}
                onChange={(e) => setHideMissing(e.target.checked)}
              />
              <span>{t.hideMissing}</span>
            </label>
          </div>
          <div className="library-export-actions">
            <span className="library-export-count">{filteredItems.length}</span>
            <button type="button" onClick={() => void onExportList("csv", filteredItems)} title={t.exportCsv}>
              <Download size={13} />
              <span>CSV</span>
            </button>
            <button type="button" onClick={() => void onExportList("md", filteredItems)} title={t.exportMarkdown}>
              <Download size={13} />
              <span>Markdown</span>
            </button>
            <button type="button" onClick={() => void onExportList("json", filteredItems)} title={t.exportJson}>
              <Download size={13} />
              <span>JSON</span>
            </button>
          </div>
        </header>

        <section className="library-metrics">
          <article className="library-metric-card">
            <span>{t.totalDocs}</span>
            <strong>{recentFiles.length}</strong>
          </article>
          <article className="library-metric-card">
            <span>{t.totalFavorites}</span>
            <strong>{pdfFavoriteSet.size}</strong>
          </article>
          <article className="library-metric-card">
            <span>{t.readHours}</span>
            <strong>{totalReadHours}</strong>
          </article>
        </section>

        <section className="library-activity">
          <div className="library-activity-head">
            <div>
              <h3>{tActivity.title}</h3>
              <p>{tActivity.hint}</p>
            </div>
            <strong>{formatHours(activity.totalSeconds, language)}</strong>
          </div>
          <div className="library-heatmap">
            <div className="library-heatmap-months">
              {activity.monthLabels.map((label, idx) => (
                <span key={`m-${idx}`}>{label}</span>
              ))}
            </div>
            <div className="library-heatmap-grid">
              {activity.weeks.map((week, weekIdx) => (
                <div key={`w-${weekIdx}`} className="library-heatmap-week">
                  {week.map((day) => (
                    <span
                      key={day.key}
                      className={`library-heatmap-cell l${day.level} ${day.inRange ? "" : "out"}`}
                      title={`${day.key} · ${formatHours(day.seconds, language)}`}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div className="library-heatmap-legend">
              <span>{tActivity.less}</span>
              <span className="library-heatmap-cell l0" />
              <span className="library-heatmap-cell l1" />
              <span className="library-heatmap-cell l2" />
              <span className="library-heatmap-cell l3" />
              <span className="library-heatmap-cell l4" />
              <span>{tActivity.more}</span>
            </div>
            <div className="library-heatmap-note">
              <strong>{tActivity.legendHint}</strong>
              <span>{tActivity.legendDetail}</span>
              <span>{tActivity.peak}: {formatHours(activity.maxSeconds, language)}</span>
            </div>
          </div>
        </section>

        <div className="library-list-head">
          <span>{t.docHeader}</span>
          <span>{t.lastReadHeader}</span>
          <span>{t.actionsHeader}</span>
        </div>

        <div className="library-list">
          {filteredItems.map((item) => {
            const isFav = pdfFavoriteSet.has(item.path.trim().toLowerCase());
            const inCollection = selectedCollection
              ? selectedCollection.paths.some((path) => samePath(path, item.path))
              : false;
            return (
              <article key={item.path} className={`library-row ${item.missing ? "missing" : ""}`}>
                <div className="library-row-main">
                  <div className="library-doc-name">{item.name}</div>
                  <div className="library-doc-path">{item.path}</div>
                </div>
                <div className="library-row-time">{fmtTime(item.lastOpenedAt, language)}</div>
                <div className="library-row-actions">
                  <button type="button" onClick={() => onOpenRecentFile(item.path)}>
                    {t.open}
                  </button>
                  <button type="button" onClick={() => onTogglePdfFavorite(item.path, item.name)}>
                    {isFav ? <StarOff size={13} /> : <Star size={13} />}
                    <span>{isFav ? t.unfavorite : t.favorite}</span>
                  </button>
                  {selectedCollection ? (
                    <button type="button" onClick={() => onToggleCollectionPath(selectedCollection.id, item.path)}>
                      <span>{inCollection ? t.remove : t.add}</span>
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
          {filteredItems.length === 0 ? (
            <div className="library-empty">{t.noMatchedDocs}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
