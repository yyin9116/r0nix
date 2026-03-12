import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  BookOpen,
  ChevronDown,
  Code,
  Globe,
  GraduationCap,
  Image,
  Mail,
  Map,
  Music,
  Search,
  Youtube,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AppLanguage, QuickLinkItem } from "../services/userSettings";

type EngineId = "google" | "bing" | "baidu";

type Engine = {
  id: EngineId;
  name: string;
  urlPrefix: string;
};

const ENGINES: Engine[] = [
  { id: "google", name: "Google", urlPrefix: "https://www.google.com/search?q=" },
  { id: "bing", name: "Bing", urlPrefix: "https://www.bing.com/search?q=" },
  { id: "baidu", name: "Baidu", urlPrefix: "https://www.baidu.com/s?wd=" },
];

const I18N = {
  "zh-CN": {
    greeting: "欢迎回来",
    subtitle: "聚焦检索、快速跳转，开始你的下一段阅读。",
    searchPlaceholder: (engineName: string) => `使用 ${engineName} 搜索或输入网址`,
    quickLinks: "快捷链接",
    quickLinksHint: "点击即可在当前浏览标签页打开",
    emptyLinks: "暂无快捷链接，可在设置中添加。",
    engineLabel: "搜索引擎",
    startBadge: "起始页",
    submitLabel: "搜索",
    searchCardTitle: "统一搜索入口",
    searchCardDesc: "支持直接输入 URL，或使用搜索引擎检索关键词。",
  },
  "en-US": {
    greeting: "Good day.",
    subtitle: "Focus, search fast, and jump back into reading.",
    searchPlaceholder: (engineName: string) => `Search with ${engineName} or enter URL`,
    quickLinks: "Favorites",
    quickLinksHint: "Click to open in current web tab",
    emptyLinks: "No quick links yet. Add them in Settings.",
    engineLabel: "Search engine",
    startBadge: "Start Page",
    submitLabel: "Search",
    searchCardTitle: "Unified search bar",
    searchCardDesc: "Type a URL directly, or run a quick search with your engine.",
  },
} as const;

function normalizeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `https://${value}`;
}

function looksLikeUrl(raw: string) {
  const value = raw.trim();
  if (!value) return false;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return true;
  if (value.includes(" ")) return false;
  return value.includes(".");
}

function formatClock(language: AppLanguage, now: Date) {
  const locale = language === "zh-CN" ? "zh-CN" : "en-US";
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const date = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  return { time, date };
}

function linkIconForItem(item: QuickLinkItem): LucideIcon {
  const source = `${item.title} ${item.url}`.toLowerCase();
  if (source.includes("youtube")) return Youtube;
  if (source.includes("mail") || source.includes("gmail") || source.includes("outlook")) return Mail;
  if (source.includes("github") || source.includes("gitlab") || source.includes("vscode") || source.includes("code")) {
    return Code;
  }
  if (source.includes("scholar") || source.includes("arxiv") || source.includes("pubmed") || source.includes("semantic")) {
    return GraduationCap;
  }
  if (source.includes("nature") || source.includes("science") || source.includes("paper") || source.includes("journal")) {
    return BookOpen;
  }
  if (source.includes("bilibili") || source.includes("spotify") || source.includes("music")) return Music;
  if (source.includes("map")) return Map;
  if (source.includes("image") || source.includes("photo") || source.includes("unsplash")) return Image;
  return Globe;
}

export function StartPage({
  quickLinks,
  onNavigate,
  language,
}: {
  quickLinks: QuickLinkItem[];
  onNavigate: (url: string) => void;
  language: AppLanguage;
}) {
  const t = I18N[language];
  const [now, setNow] = useState<Date>(() => new Date());
  const [query, setQuery] = useState("");
  const [engine, setEngine] = useState<EngineId>("google");
  const [engineOpen, setEngineOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const clock = useMemo(() => formatClock(language, now), [language, now]);
  const currentEngine = useMemo(() => ENGINES.find((item) => item.id === engine) || ENGINES[0], [engine]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!engineOpen) return;
      const node = dropdownRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) {
        setEngineOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [engineOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    if (looksLikeUrl(trimmed)) {
      onNavigate(normalizeUrl(trimmed));
      return;
    }
    onNavigate(`${currentEngine.urlPrefix}${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="absolute inset-0 overflow-auto bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          className="rounded-3xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-gray-100 bg-gray-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 dark:border-gray-800 dark:bg-gray-800 dark:text-gray-400">
                <span className="h-2 w-2 rounded-full bg-teal-500 animate-pulse" />
                {t.startBadge}
              </div>
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">{t.greeting}</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t.subtitle}</p>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 text-right dark:border-gray-800 dark:bg-gray-800/70">
              <div className="text-3xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">{clock.time}</div>
              <div className="mt-1 text-xs uppercase tracking-[0.15em] text-gray-500 dark:text-gray-400">{clock.date}</div>
            </div>
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.04, ease: "easeOut" }}
          className="relative z-30 rounded-3xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:p-5"
        >
          <div className="mb-3">
            <div className="text-sm font-semibold tracking-tight text-gray-900 dark:text-gray-100">{t.searchCardTitle}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{t.searchCardDesc}</div>
          </div>

          <form onSubmit={submit} className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div ref={dropdownRef} className="relative">
                <button
                  type="button"
                  onClick={() => setEngineOpen((value) => !value)}
                  className="inline-flex min-w-40 items-center justify-between gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  aria-label={t.engineLabel}
                >
                  <span className="flex items-center gap-2">
                    <Search className="h-4 w-4 text-gray-400 dark:text-gray-500" />
                    <span className="font-medium">{currentEngine.name}</span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-gray-400 transition-transform dark:text-gray-500 ${engineOpen ? "rotate-180" : "rotate-0"}`}
                  />
                </button>

                <AnimatePresence>
                  {engineOpen ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96, y: 8 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96, y: 8 }}
                      transition={{ duration: 0.16, ease: "easeOut" }}
                      className="absolute left-0 top-[calc(100%+8px)] z-20 w-44 rounded-2xl border border-gray-100 bg-white p-2 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                    >
                      {ENGINES.map((item) => {
                        const active = item.id === engine;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setEngine(item.id);
                              setEngineOpen(false);
                              window.setTimeout(() => inputRef.current?.focus(), 0);
                            }}
                            className={`w-full rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
                              active
                                ? "bg-teal-500/10 text-gray-900 dark:text-gray-100"
                                : "text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60"
                            }`}
                          >
                            {item.name}
                          </button>
                        );
                      })}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.searchPlaceholder(currentEngine.name)}
                className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 transition-all placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
              />

              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-950"
              >
                <Search className="h-4 w-4" />
                {t.submitLabel}
              </button>
            </div>

            <div className="truncate rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs font-mono text-gray-500 dark:border-gray-800 dark:bg-gray-800/70 dark:text-gray-400">
              {looksLikeUrl(query) ? normalizeUrl(query) : `${currentEngine.urlPrefix}...`}
            </div>
          </form>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.08, ease: "easeOut" }}
          className="rounded-3xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold tracking-tight text-gray-900 dark:text-gray-100">{t.quickLinks}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{t.quickLinksHint}</div>
          </div>

          {quickLinks.length === 0 ? (
            <div className="mt-4 text-sm text-gray-500 dark:text-gray-400">{t.emptyLinks}</div>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {quickLinks.map((item) => {
                const Icon = linkIconForItem(item);
                return (
                  <motion.button
                    key={item.id}
                    onClick={() => onNavigate(item.url)}
                    title={item.url}
                    whileHover={{ y: -2 }}
                    whileTap={{ y: 0 }}
                    transition={{ type: "spring", stiffness: 360, damping: 24 }}
                    className="group flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-left transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-800/70"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-teal-500/20 bg-teal-500/10 text-teal-700 dark:text-teal-300">
                      <Icon className="h-4 w-4" strokeWidth={1.7} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{item.title}</span>
                      <span className="block truncate text-[11px] font-mono text-gray-500 dark:text-gray-400">{item.url}</span>
                    </span>
                  </motion.button>
                );
              })}
            </div>
          )}
        </motion.section>
      </main>
    </div>
  );
}
